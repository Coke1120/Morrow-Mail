// Portable control for exact Downloads repair, workspace refresh and reader
// coroutines. WinRT transport/controls and page rendering are fakes; the native
// smoke control separately exercises the real shared page/reader implementation.
#include <cassert>
#include <coroutine>
#include <exception>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

using hstring=std::wstring;
constexpr long E_FAIL=1, E_ABORT=2;
struct hresult_error:std::runtime_error {
    hstring detail;
    hresult_error(long,hstring value):std::runtime_error("fixture error"),detail(std::move(value)){}
};
hstring errorText(){return L"fixture request failed";}
struct Json {
    std::map<hstring,Json> fields;
    std::vector<Json> items;
    hstring value;
    bool boolean=false;
    hstring Stringify()const {
        hstring out=L"("+value+(boolean?L"+":L"-");
        for(auto const& [key,item]:fields)out+=key+L":"+item.Stringify();
        for(auto const& item:items)out+=item.Stringify();
        return out+L")";
    }
    bool HasKey(wchar_t const* key)const{return fields.contains(key);}
    size_t Size()const{return fields.size();}
    Json GetObject()const{return *this;}
};
struct Array {
    std::vector<Json> items;
    auto begin()const{return items.begin();} auto end()const{return items.end();}
    size_t Size()const{return items.size();}
    Json GetAt(size_t index)const{return items.at(index);}
    hstring Stringify()const{Json value;value.items=items;return value.Stringify();}
};
Json object(Json const& value,wchar_t const* key){auto found=value.fields.find(key);return found==value.fields.end()?Json{}:found->second;}
Array array(Json const& value,wchar_t const* key){return {object(value,key).items};}
hstring text(Json const& value,wchar_t const* key){return object(value,key).value;}
bool flag(Json const& value,wchar_t const* key){return object(value,key).boolean;}
void put(Json& value,wchar_t const* key,hstring const& entry){value.fields[key].value=entry;}
void boolean(Json& value,wchar_t const* key,bool entry){value.fields[key].boolean=entry;}
hstring escaped(hstring const& value){return value;}

template<typename T> struct Task;
struct FinalAwaiter {
    bool await_ready()const noexcept{return false;}
    template<typename P> std::coroutine_handle<> await_suspend(std::coroutine_handle<P> frame)const noexcept {
        return frame.promise().continuation?frame.promise().continuation:std::noop_coroutine();
    }
    void await_resume()const noexcept{}
};
template<typename T> struct Promise {
    std::optional<T> value;std::exception_ptr failure;std::coroutine_handle<> continuation;
    Task<T> get_return_object();
    std::suspend_never initial_suspend()const noexcept{return {};}
    FinalAwaiter final_suspend()const noexcept{return {};}
    void return_value(T next){value=std::move(next);}
    void unhandled_exception(){failure=std::current_exception();}
};
template<> struct Promise<void> {
    std::exception_ptr failure;std::coroutine_handle<> continuation;
    Task<void> get_return_object();
    std::suspend_never initial_suspend()const noexcept{return {};}
    FinalAwaiter final_suspend()const noexcept{return {};}
    void return_void(){}
    void unhandled_exception(){failure=std::current_exception();}
};
template<typename T> struct Task {
    using promise_type=Promise<T>;using Handle=std::coroutine_handle<promise_type>;
    Handle frame;
    explicit Task(Handle value):frame(value){}
    Task(Task const&)=delete;Task(Task&& other)noexcept:frame(std::exchange(other.frame,{})){}
    ~Task(){if(frame){assert(frame.done());frame.destroy();}}
    bool done()const{return frame.done();}
    auto get(){assert(done());if(frame.promise().failure)std::rethrow_exception(frame.promise().failure);if constexpr(!std::is_void_v<T>)return *frame.promise().value;}
    bool await_ready()const{return done();}
    void await_suspend(std::coroutine_handle<> parent){frame.promise().continuation=parent;}
    auto await_resume(){return get();}
};
template<typename T> Task<T> Promise<T>::get_return_object(){return Task<T>{std::coroutine_handle<Promise<T>>::from_promise(*this)};}
Task<void> Promise<void>::get_return_object(){return Task<void>{std::coroutine_handle<Promise<void>>::from_promise(*this)};}
using IAsyncAction=Task<void>;template<typename T>using IAsyncOperation=Task<T>;

enum class ElementTheme{Dark,Light,Default};
struct ControlNode;
struct Checked {bool value=false;operator bool()const{return true;}bool Value()const{return value;}};
struct Control {
    std::shared_ptr<ControlNode> node;
    Control()=default;Control(std::nullptr_t){}
    explicit Control(std::shared_ptr<ControlNode> value):node(std::move(value)){}
    operator bool()const{return bool(node);}
    bool operator==(Control const&)const=default;
    hstring Text()const;int SelectedIndex()const;Checked IsChecked()const;
    bool IsEnabled()const;Control Content()const;
    void RequestedTheme(ElementTheme)const{}
};
struct ControlNode {hstring text;int index=0;bool enabled=true,checked=false;Control content;};
hstring Control::Text()const{return node->text;}int Control::SelectedIndex()const{return node->index;}
Checked Control::IsChecked()const{return {node->checked};}bool Control::IsEnabled()const{return node->enabled;}
Control Control::Content()const{return node->content;}
Control control(){return Control{std::make_shared<ControlNode>()};}
namespace controls {using ListView=Control;using ContentControl=Control;using TextBox=Control;using ComboBox=Control;using CheckBox=Control;}
using IInspectable=Control;
using WorkspaceReadGuard=std::function<bool(Json const&)>;

struct Request {
    hstring path,owner,method;Json body,result;std::coroutine_handle<> suspended;
    bool finished=false,fail=false;
};
struct Service {
    std::vector<std::shared_ptr<Request>> calls;
    unsigned writes=0;
    bool writing()const{return writes!=0;}
    struct Pending {
        Service& service;std::shared_ptr<Request> request;
        bool await_ready()const{return false;}
        void await_suspend(std::coroutine_handle<> frame){request->suspended=frame;}
        Json await_resume(){if(request->method!=L"GET")--service.writes;if(request->fail)throw hresult_error(E_FAIL,L"fixture failure");return request->result;}
    };
    Pending request(hstring path,hstring owner={},hstring method=L"GET",Json body={}) {
        auto next=std::make_shared<Request>();next->path=std::move(path);next->owner=std::move(owner);next->method=std::move(method);next->body=std::move(body);
        if(next->method!=L"GET")++writes;
        calls.push_back(next);return {*this,next};
    }
    void finish(size_t index,Json result={},bool fail=false){auto request=calls.at(index);assert(!request->finished&&request->suspended);request->result=std::move(result);request->fail=fail;request->finished=true;auto frame=std::exchange(request->suspended,{});frame.resume();}
};
struct Shell:std::enable_shared_from_this<Shell> {
    std::shared_ptr<Service> service=std::make_shared<Service>();
    Json state,selected,serverFolders,pendingRead,retainedUnread;
    hstring owner=L"a@fixture.invalid",section=L"mail",folder=L"inbox",mailSearchQuery,mailRevision=L"old",lastError;
    uint64_t generation=10,selectionGeneration=20,readGeneration=30,workspaceRefreshTicket=0,mailLoadTicket=0;
    bool closing=false,refreshing=false,loading=false,syncing=false,dialogOpen=false,navigationLocked=false;
    Control root=control(),navigation=control(),rows=control(),page=control(),reader=control(),search=control(),sorting=control(),unreadFilter=control();
    std::set<std::wstring> dirty;
    std::function<IAsyncAction()> refreshReview;
    unsigned priorityCalls=0,pageCalls=0,renderCalls=0,retainedCalls=0,navigationCalls=0,otherPageCalls=0;
    bool current(uint64_t version,hstring const& captured)const{return !closing&&generation==version&&owner==captured;}
    bool connected(hstring const& account)const{for(auto const& row:array(state,L"accounts"))if(text(row,L"id")==account)return true;return false;}
    void error(hstring value){lastError=std::move(value);}
    void rebuildNavigation(){++navigationCalls;}
    void renderReader(Json const&){++renderCalls;}
    void retainReadRow(Json const&,bool=false){++retainedCalls;}
    IAsyncAction publishSyncPriority(){++priorityCalls;co_return;}
    IAsyncOperation<bool> refresh(bool rebuild=false,WorkspaceReadGuard validity={});
    IAsyncOperation<bool> loadPage(int delta=0,bool reader=false,bool reset=false,WorkspaceReadGuard validity={});
    IAsyncOperation<bool> refreshMailReader(WorkspaceReadGuard validity={});
    IAsyncOperation<bool> repairDownloadedMessage(Json message,hstring account,hstring connectionRef);
};
IAsyncAction workspacePage(std::shared_ptr<Shell> shell,hstring){++shell->otherPageCalls;co_return;}
Json refreshedReaderMessage(Json const&,Json next){return next;}

// PRODUCTION_CONNECTION_REF
// PRODUCTION_DOWNLOAD_LOADING
// PRODUCTION_DOWNLOAD_SCOPE
// PRODUCTION_DOWNLOAD_VIEWS
// PRODUCTION_REPAIR
// PRODUCTION_REFRESH
// PRODUCTION_READER

// This boundary fake only records that the actual shared refresh delegates to
// the shared page path, and runs the actual reader coroutine. It is not a copy
// of loadPage's native list rendering or an assertion that WinUI has executed.
IAsyncOperation<bool> Shell::loadPage(int,bool refreshReader,bool,WorkspaceReadGuard validity) {
    ++pageCalls;
    if(refreshReader && !(co_await refreshMailReader(validity))) co_return false;
    co_return true;
}
Json message(hstring owner,hstring body=L"old body",bool read=false){Json value;put(value,L"accountId",owner);put(value,L"id",L"same");put(value,L"viewId",owner+L":same");put(value,L"body",body);put(value,L"folder",L"inbox");boolean(value,L"read",read);boolean(value,L"canRepair",true);return value;}
Json result(Json value){Json out;out.fields[L"message"]=std::move(value);return out;}
Json state(hstring owner=L"a@fixture.invalid",hstring revision=L"old") {
    Json value;put(value.fields[L"account"],L"id",owner);put(value,L"revision",revision);
    for(auto account:{L"a@fixture.invalid",L"b@fixture.invalid"}){Json row;put(row,L"id",account);put(row.fields[L"settings"],L"connectionRef",hstring(account)+L":connection");value.fields[L"accounts"].items.push_back(row);}
    return value;
}
void setReference(Json& value,hstring const& owner,hstring reference){for(auto& row:value.fields[L"accounts"].items)if(text(row,L"id")==owner)put(row.fields[L"settings"],L"connectionRef",reference);}
struct Fixture {
    std::shared_ptr<Shell> shell=std::make_shared<Shell>();
    Fixture(){shell->state=state();shell->selected=message(shell->owner);shell->page.node->content=control();}
    auto repair(){return shell->repairDownloadedMessage(message(L"a@fixture.invalid"),L"a@fixture.invalid",L"a@fixture.invalid:connection");}
    void finishPost(size_t index=0){shell->service->finish(index,result(message(L"a@fixture.invalid",L"stale POST body",false)));}
    void finishState(size_t index=1){shell->service->finish(index,state(shell->owner,L"new"));}
    void finishReader(size_t index=2){shell->service->finish(index,result(message(text(shell->selected,L"accountId"),L"fresh local body",true)));}
};

int main(){
    unsigned checks=0;
    {
        Fixture f;auto operation=f.repair();assert(f.shell->loading&&f.shell->service->calls.size()==1);
        f.finishPost();assert(!f.shell->loading&&f.shell->refreshing&&f.shell->service->calls.size()==2);
        f.finishState();assert(f.shell->pageCalls==1&&f.shell->service->calls.size()==3);f.finishReader();
        assert(operation.get()&&!f.shell->refreshing&&text(f.shell->state,L"revision")==L"new");
        assert(text(f.shell->selected,L"body")==L"fresh local body"&&flag(f.shell->selected,L"read")&&f.shell->renderCalls==1);
        assert(f.shell->selectionGeneration==20&&f.shell->priorityCalls==0);
        auto const& calls=f.shell->service->calls;
        assert(calls[0]->method==L"POST"&&calls[0]->path==L"/messages/same/attachments"&&text(calls[0]->body,L"connectionRef")==L"a@fixture.invalid:connection");
        assert(calls[1]->method==L"GET"&&calls[1]->path==L"/state"&&calls[2]->method==L"GET"&&calls[2]->path==L"/messages/same");++checks;
    }
    {
        Fixture f;f.shell->owner=L"all";f.shell->state=state(L"all");f.shell->selected=message(L"b@fixture.invalid",L"B body");
        auto operation=f.repair();f.finishPost();f.finishState();
        assert(f.shell->service->calls[0]->owner==L"a@fixture.invalid"&&f.shell->service->calls[1]->owner==L"all"&&f.shell->service->calls[2]->owner==L"b@fixture.invalid");
        f.finishReader();assert(operation.get()&&text(f.shell->selected,L"accountId")==L"b@fixture.invalid");++checks;
    }
    std::vector<std::function<void(Shell&)>> revoke={
        [](Shell&s){++s.generation;},[](Shell&s){++s.selectionGeneration;}, // includes A→B→A
        [](Shell&s){s.owner=L"b@fixture.invalid";},[](Shell&s){s.section=L"today";},
        [](Shell&s){s.folder=L"archive";},[](Shell&s){s.selected=message(L"b@fixture.invalid");},
        [](Shell&s){setReference(s.state,L"a@fixture.invalid",L"reconnected");},
        [](Shell&s){s.rows=control();},[](Shell&s){s.page.node->content=control();},
        [](Shell&s){s.search.node->text=L"pending input";},[](Shell&s){s.sorting.node->index=1;},
        [](Shell&s){s.unreadFilter.node->checked=true;},[](Shell&s){s.pendingRead=message(s.owner);},
        [](Shell&s){s.dirty.insert(L"draft");},[](Shell&s){s.dialogOpen=true;},
        [](Shell&s){s.navigationLocked=true;},[](Shell&s){s.navigation.node->enabled=false;},
        [](Shell&s){s.closing=true;},[](Shell&s){s.syncing=true;},[](Shell&s){++s.service->writes;}
    };
    for(auto const& change:revoke){Fixture f;auto operation=f.repair();change(*f.shell);auto preserved=f.shell->selected.Stringify();f.finishPost();assert(!operation.get()&&f.shell->service->calls.size()==1&&!f.shell->loading&&f.shell->selected.Stringify()==preserved);++checks;}
    for(auto const& change:revoke){Fixture f;auto operation=f.repair();f.finishPost();change(*f.shell);auto preserved=f.shell->selected.Stringify();f.finishState();assert(!operation.get()&&f.shell->service->calls.size()==2&&f.shell->selected.Stringify()==preserved&&!f.shell->refreshing);++checks;}
    {
        Fixture f;auto operation=f.repair();f.finishPost();auto changed=state(f.shell->owner,L"new");setReference(changed,f.shell->owner,L"new origin");f.shell->service->finish(1,changed);
        assert(!operation.get()&&text(f.shell->state,L"revision")==L"old"&&f.shell->service->calls.size()==2);++checks;
    }
    {
        Fixture f;auto operation=f.repair();f.finishPost();f.shell->service->finish(1,state(L"b@fixture.invalid",L"wrong view"));
        assert(!operation.get()&&text(f.shell->state,L"revision")==L"old");++checks;
    }
    {
        Fixture f;auto operation=f.repair();f.finishPost();f.finishState();++f.shell->selectionGeneration;
        auto newer=message(f.shell->owner,L"newer selection");f.shell->selected=newer;f.finishReader();
        assert(!operation.get()&&f.shell->selected.Stringify()==newer.Stringify()&&f.shell->renderCalls==0);++checks;
    }
    for(auto key:{L"accountId",L"id",L"viewId"}){Fixture f;auto operation=f.repair();auto wrong=message(f.shell->owner);put(wrong,key,L"wrong");f.shell->service->finish(0,result(wrong));bool failed=false;try{operation.get();}catch(hresult_error const&){failed=true;}assert(failed&&f.shell->service->calls.size()==1&&!f.shell->loading);++checks;}
    {
        Fixture f;auto operation=f.repair();f.shell->service->finish(0,{},true);bool failed=false;try{operation.get();}catch(hresult_error const&){failed=true;}assert(failed&&f.shell->service->calls.size()==1&&!f.shell->loading);++checks;
    }
    {
        Fixture f;auto operation=f.repair();f.finishPost();f.shell->service->finish(1,{},true);bool failed=false;try{operation.get();}catch(hresult_error const&e){failed=e.detail.starts_with(L"Download saved, but");}assert(failed&&f.shell->service->calls.size()==2&&!f.shell->refreshing);++checks;
    }
    {
        Fixture f;auto operation=f.repair();++f.shell->mailLoadTicket;f.shell->loading=true;f.finishPost();assert(!operation.get()&&f.shell->loading&&f.shell->service->calls.size()==1);f.shell->loading=false;++checks;
    }
    {
        Fixture f;auto old=f.shell->refresh(true);assert(f.shell->refreshing&&f.shell->service->calls.size()==1);
        auto operation=f.repair();f.finishPost(1);assert(f.shell->refreshing&&f.shell->service->calls.size()==3);
        f.shell->service->finish(0,state(f.shell->owner,L"obsolete"));old.get();assert(f.shell->refreshing&&text(f.shell->state,L"revision")==L"old");
        f.finishState(2);f.finishReader(3);assert(operation.get()&&!f.shell->refreshing&&text(f.shell->state,L"revision")==L"new"&&f.shell->priorityCalls==1);++checks;
    }
    {
        Fixture f;auto operation=f.repair();f.finishPost();auto coalesced=f.shell->refresh();coalesced.get();assert(f.shell->service->calls.size()==2);f.finishState();f.finishReader();assert(operation.get());++checks;
    }
    {
        Fixture f;auto operation=f.repair();f.finishPost();put(f.shell->state,L"revision",L"newer external state");f.finishState();bool failed=false;try{operation.get();}catch(hresult_error const&e){failed=e.detail.starts_with(L"Download saved, but");}assert(failed&&text(f.shell->state,L"revision")==L"newer external state"&&f.shell->service->calls.size()==2);++checks;
    }
    {
        Fixture f;auto older=f.repair();f.finishPost();auto newer=f.repair();f.finishPost(2);assert(f.shell->refreshing&&f.shell->service->calls.size()==4);
        f.finishState(1);assert(!older.get()&&f.shell->refreshing);f.finishState(3);f.finishReader(4);assert(newer.get()&&!f.shell->refreshing);++checks;
    }
    {
        Fixture f;f.shell->search.node->text=L"unsubmitted query";f.shell->mailSearchQuery=L"displayed query";
        auto operation=f.repair();f.finishPost();f.finishState();f.finishReader();assert(operation.get()&&f.shell->search.Text()==L"unsubmitted query"&&f.shell->mailSearchQuery==L"displayed query");++checks;
    }
    {
        Fixture f;f.shell->selected=Json();auto operation=f.repair();f.finishPost();f.finishState();
        assert(operation.get()&&f.shell->service->calls.size()==2&&f.shell->pageCalls==1&&f.shell->selected.Size()==0);++checks;
    }
    {
        Fixture f;f.shell->owner=L"all";f.shell->state=state(L"all");f.shell->selected=message(L"b@fixture.invalid");
        auto operation=f.repair();f.finishPost();auto changed=state(L"all",L"new");setReference(changed,L"b@fixture.invalid",L"new selected connection");
        f.shell->service->finish(1,changed);assert(!operation.get()&&f.shell->service->calls.size()==2);++checks;
    }
    for(auto key:{L"accountId",L"id",L"viewId"}) {
        Fixture f;auto operation=f.repair();f.finishPost();f.finishState();auto wrong=message(f.shell->owner);put(wrong,key,L"wrong");
        f.shell->service->finish(2,result(wrong));bool failed=false;try{operation.get();}catch(hresult_error const&e){failed=e.detail.starts_with(L"Download saved, but");}
        assert(failed&&f.shell->service->calls.size()==3&&text(f.shell->selected,L"body")==L"old body"&&!f.shell->refreshing);++checks;
    }
    {
        Fixture f;auto operation=f.repair();f.finishPost();f.finishState();f.shell->service->finish(2,{},true);
        bool failed=false;try{operation.get();}catch(hresult_error const&e){failed=e.detail.starts_with(L"Download saved, but");}assert(failed&&f.shell->service->calls.size()==3);++checks;
    }
    {
        Fixture f;auto operation=f.repair();f.finishPost();f.finishState();++f.shell->readGeneration;f.finishReader();
        assert(!operation.get()&&text(f.shell->selected,L"body")==L"old body"&&f.shell->service->calls.size()==3);++checks;
    }
    std::cout<<"Download shared refresh: "<<checks<<" actual coroutine/guard controls passed; native page rendering is a separate pending SDK control.\n";
}
