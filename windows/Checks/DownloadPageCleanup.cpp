// Exact loadPage/scope control with native row rendering replaced by an adoption
// recorder. The transport separates POST completion/Write release from UI resume.
// No Windows SDK, native scheduler, provider, message mark or AI is exercised.
#include <algorithm>
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
#include <utility>
#include <vector>

using hstring = std::wstring;
constexpr long E_FAIL = 1;
struct hresult_error : std::runtime_error {
    hresult_error(long, hstring const&) : std::runtime_error("fixture failure") {}
};
hstring errorText() { return L"fixture failure"; }
struct Json {
    std::map<hstring, Json> fields;
    std::vector<Json> items;
    hstring value;
    double number = 0;
    bool boolean = false;
    size_t Size() const { return fields.size(); }
    bool HasKey(wchar_t const* key) const { return fields.contains(key); }
    void Insert(wchar_t const* key, Json entry) { fields[key] = std::move(entry); }
    void Remove(wchar_t const* key) { fields.erase(key); }
    double GetNamedNumber(wchar_t const* key, double fallback) const {
        auto found = fields.find(key); return found == fields.end() ? fallback : found->second.number;
    }
    Json GetObject() const { return *this; }
};
struct Array {
    std::vector<Json> items;
    auto begin() const { return items.begin(); } auto end() const { return items.end(); }
    size_t Size() const { return items.size(); }
};
Json object(Json const& value, wchar_t const* key) { auto found = value.fields.find(key); return found == value.fields.end() ? Json{} : found->second; }
Array array(Json const& value, wchar_t const* key) { return {object(value, key).items}; }
hstring text(Json const& value, wchar_t const* key) { return object(value, key).value; }
void put(Json& value, wchar_t const* key, hstring const& entry) { value.fields[key].value = entry; }
struct Value {
    static Json CreateNumberValue(double number) { Json value; value.number = number; return value; }
    static Json CreateBooleanValue(bool boolean) { Json value; value.boolean = boolean; return value; }
};
struct ApiError : std::runtime_error { ApiError(unsigned, Json const&) : std::runtime_error("fixture HTTP failure") {} };
template<typename T> hstring to_hstring(T value) { return std::to_wstring(value); }

template<typename T> struct Task;
struct FinalAwaiter {
    bool await_ready() const noexcept { return false; }
    template<typename P> std::coroutine_handle<> await_suspend(std::coroutine_handle<P> frame) const noexcept {
        return frame.promise().continuation ? frame.promise().continuation : std::noop_coroutine();
    }
    void await_resume() const noexcept {}
};
template<typename T> struct Promise {
    std::optional<T> value; std::exception_ptr failure; std::coroutine_handle<> continuation;
    Task<T> get_return_object();
    std::suspend_never initial_suspend() const noexcept { return {}; }
    FinalAwaiter final_suspend() const noexcept { return {}; }
    void return_value(T next) { value = std::move(next); }
    void unhandled_exception() { failure = std::current_exception(); }
};
template<typename T> struct Task {
    using promise_type = Promise<T>; using Handle = std::coroutine_handle<promise_type>;
    Handle frame;
    explicit Task(Handle value) : frame(value) {}
    Task(Task const&) = delete; Task(Task&& other) noexcept : frame(std::exchange(other.frame, {})) {}
    ~Task() { if (frame) { assert(frame.done()); frame.destroy(); } }
    bool done() const { return frame.done(); }
    T get() { assert(done()); if (frame.promise().failure) std::rethrow_exception(frame.promise().failure); return *frame.promise().value; }
    bool await_ready() const { return done(); }
    void await_suspend(std::coroutine_handle<> parent) { frame.promise().continuation = parent; }
    T await_resume() { return get(); }
};
template<typename T> Task<T> Promise<T>::get_return_object() { return Task<T>{std::coroutine_handle<Promise<T>>::from_promise(*this)}; }
template<typename T> using IAsyncOperation = Task<T>;

struct ControlNode;
struct Checked { bool value; operator bool() const { return true; } bool Value() const { return value; } };
struct Control {
    std::shared_ptr<ControlNode> node;
    Control() = default; Control(std::nullptr_t) {}
    explicit Control(std::shared_ptr<ControlNode> value) : node(std::move(value)) {}
    operator bool() const { return bool(node); }
    bool operator==(Control const&) const = default;
    hstring Text() const; void Text(hstring value) const;
    bool IsEnabled() const; void IsEnabled(bool enabled) const;
    int SelectedIndex() const; Checked IsChecked() const; Control Content() const;
};
struct ControlNode { hstring text; bool enabled = true, checked = false; int index = 0; Control content; };
hstring Control::Text() const { return node->text; } void Control::Text(hstring value) const { node->text = std::move(value); }
bool Control::IsEnabled() const { return node->enabled; } void Control::IsEnabled(bool value) const { node->enabled = value; }
int Control::SelectedIndex() const { return node->index; } Checked Control::IsChecked() const { return {node->checked}; }
Control Control::Content() const { return node->content; }
Control control() { return Control{std::make_shared<ControlNode>()}; }
using IInspectable = Control;
namespace controls { using ListView = Control; using ContentControl = Control; using TextBox = Control; using ComboBox = Control; using CheckBox = Control; }
namespace Automation { struct AutomationProperties { static void SetName(Control const&, hstring const&) {} }; }
using WorkspaceReadGuard = std::function<bool(Json const&)>;

struct Request {
    hstring path, owner, method; Json body, result; std::coroutine_handle<> suspended;
    bool completed = false, resumed = false, fail = false;
};
struct Service {
    std::vector<std::shared_ptr<Request>> calls;
    unsigned writes = 0;
    bool writing() const { return writes != 0; }
    struct Pending {
        std::shared_ptr<Request> request;
        bool await_ready() const { return false; }
        void await_suspend(std::coroutine_handle<> frame) { request->suspended = frame; }
        Json await_resume() { assert(request->completed); if (request->fail) throw hresult_error(E_FAIL, L"fixture transport"); return request->result; }
    };
    Pending request(hstring path, hstring owner, hstring method, Json body) {
        auto next = std::make_shared<Request>(); next->path = std::move(path); next->owner = std::move(owner); next->method = std::move(method); next->body = std::move(body);
        assert(next->method == L"POST"); ++writes; calls.push_back(next); return {next};
    }
    Pending requestWithStatus(hstring path, hstring owner, hstring method, Json body) { return request(std::move(path), std::move(owner), std::move(method), std::move(body)); }
    void complete(size_t index, Json result = {}, bool fail = false) {
        auto request = calls.at(index); assert(!request->completed && request->suspended && writes);
        request->result = std::move(result); request->fail = fail; request->completed = true; --writes;
    }
    void resume(size_t index) { auto request = calls.at(index); assert(request->completed && !request->resumed); request->resumed = true; auto frame = std::exchange(request->suspended, {}); frame.resume(); }
};
struct Shell : std::enable_shared_from_this<Shell> {
    std::shared_ptr<Service> service = std::make_shared<Service>();
    Json state, selected, pendingRead, retainedUnread;
    hstring owner = L"a@fixture.invalid", section = L"mail", folder = L"inbox";
    hstring mailSearchQuery, mailRevision = L"old-revision", nextCursor = L"signed-third", lastError = L"existing notice";
    std::vector<hstring> cursors{L"", L"signed-second"};
    uint64_t generation = 10, selectionGeneration = 20, mailLoadTicket = 0;
    bool closing = false, loading = false, syncing = false, dialogOpen = false, navigationLocked = false;
    Control navigation = control(), rows = control(), page = control(), reader = control();
    Control previous = control(), next = control(), search = control(), sorting = control(), unreadFilter = control(), pageLabel = control();
    std::set<std::wstring> dirty;
    unsigned adoptions = 0, priorityCalls = 0;
    std::vector<std::pair<uint64_t, bool>> selectionActionUpdates;
    bool current(uint64_t version, hstring const& account) const { return !closing && version == generation && owner == account; }
    bool connected(hstring const& account) const { for (auto const& entry : array(state, L"accounts")) if (text(entry, L"id") == account) return true; return false; }
    void recordPage(Json const&) { ++adoptions; }
    void error(hstring value) { lastError = std::move(value); }
    IAsyncOperation<bool> refreshMailReader(WorkspaceReadGuard) { co_return true; }
    void publishSyncPriority() { ++priorityCalls; }
    // Observe call ownership/order only; native selection-action semantics and
    // WinUI visibility/enabled projections are not implemented by this stub.
    void updateMailSelectionActions() { selectionActionUpdates.emplace_back(mailLoadTicket, loading); }
    IAsyncOperation<bool> loadPage(int pageDelta = 0, bool refreshReader = false, bool reset = false, WorkspaceReadGuard validity = {});
};

// PRODUCTION_CONNECTION_REF
// PRODUCTION_DOWNLOAD_SCOPE
// PRODUCTION_PAGE

Json pageResult(double total = 100, hstring revision = L"fresh-revision") {
    Json value; value.Insert(L"total", Value::CreateNumberValue(total)); put(value, L"revision", revision); put(value, L"nextCursor", L"fresh-third"); return value;
}
Json response(Json body = pageResult(), unsigned status = 200) {
    Json value; value.Insert(L"status", Value::CreateNumberValue(status)); value.Insert(L"body", std::move(body)); return value;
}
struct Fixture {
    std::shared_ptr<Shell> shell = std::make_shared<Shell>();
    Fixture() {
        put(shell->state.fields[L"account"], L"id", shell->owner);
        Json account; put(account, L"id", shell->owner); put(account.fields[L"settings"], L"connectionRef", L"fixture-connection");
        shell->state.fields[L"accounts"].items.push_back(account); shell->page.node->content = control(); shell->pageLabel.Text(L"old-page-label");
    }
    WorkspaceReadGuard validity() {
        auto scope = DownloadRefreshScope(*shell, shell->owner, L"fixture-connection");
        return [shell = shell, scope](Json const& candidate) { return scope.current(*shell, candidate); };
    }
    void disabled() const { assert(shell->loading && !shell->previous.IsEnabled() && !shell->next.IsEnabled() && !shell->search.IsEnabled() && !shell->sorting.IsEnabled() && !shell->unreadFilter.IsEnabled()); }
    void restored() const { assert(!shell->loading && shell->previous.IsEnabled() && shell->next.IsEnabled() && shell->search.IsEnabled() && shell->sorting.IsEnabled() == shell->search.Text().empty() && shell->unreadFilter.IsEnabled() == shell->search.Text().empty()); }
    void rejected() const { assert(shell->adoptions == 0 && shell->mailRevision == L"old-revision" && shell->pageLabel.Text() == L"old-page-label" && shell->cursors == std::vector<hstring>({L"", L"signed-second"}) && shell->nextCursor == L"signed-third" && shell->lastError == L"existing notice" && shell->priorityCalls == 0); }
    void selectionUpdates(std::vector<std::pair<uint64_t, bool>> const& expected) const { assert(shell->selectionActionUpdates == expected); }
};

int main() {
    unsigned checks = 0;
    // First control is the original source-permitted window: the local POST has
    // released Write, then queued Sync invalidates the page before UI adoption.
    {
        Fixture f; f.shell->mailSearchQuery = L"submitted search"; f.shell->search.Text(L"unsubmitted edit");
        auto operation = f.shell->loadPage(0, false, false, f.validity()); f.disabled();
        f.selectionUpdates({{1, true}});
        auto const& call = f.shell->service->calls.at(0);
        assert(call->path == L"/search" && text(call->body, L"query") == L"submitted search" && f.shell->service->writing());
        f.shell->service->complete(0, response()); assert(!f.shell->service->writing() && !operation.done());
        f.shell->syncing = true; f.shell->service->resume(0); assert(!operation.get());
        f.restored(); f.rejected(); assert(f.shell->mailSearchQuery == L"submitted search" && f.shell->search.Text() == L"unsubmitted edit" && f.shell->service->calls.size() == 1); ++checks;
        f.selectionUpdates({{1, true}, {1, false}});
    }
    std::vector<std::function<void(Shell&)>> revokeSamePage = {
        [](Shell& s) { s.syncing = true; }, [](Shell& s) { ++s.selectionGeneration; },
        [](Shell& s) { put(s.selected, L"id", L"new selection"); }, [](Shell& s) { s.folder = L"archive"; },
        [](Shell& s) { s.search.Text(L"new edit"); }, [](Shell& s) { s.mailSearchQuery = L"different submitted query"; },
        [](Shell& s) { s.sorting.node->index = 1; }, [](Shell& s) { s.unreadFilter.node->checked = true; },
        [](Shell& s) { put(s.pendingRead, L"id", L"pending"); }, [](Shell& s) { s.dirty.insert(L"draft"); },
        [](Shell& s) { s.dialogOpen = true; }, [](Shell& s) { s.navigationLocked = true; },
        [](Shell& s) { s.navigation.IsEnabled(false); }, [](Shell& s) { ++s.service->writes; },
        [](Shell& s) { put(s.state.fields[L"accounts"].items[0].fields[L"settings"], L"connectionRef", L"reconnected"); }
    };
    for (bool fail : {false, true}) for (auto const& change : revokeSamePage) {
        Fixture f; auto operation = f.shell->loadPage(0, false, false, f.validity()); f.disabled();
        f.selectionUpdates({{1, true}});
        f.shell->service->complete(0, response(), fail); change(*f.shell); f.shell->service->resume(0);
        assert(!operation.get()); f.restored(); f.rejected(); assert(f.shell->service->calls.size() == 1); ++checks;
        f.selectionUpdates({{1, true}, {1, false}});
    }
    std::vector<std::function<void(Shell&)>> replaceOwner = {
        [](Shell& s) { ++s.generation; }, [](Shell& s) { s.owner = L"b@fixture.invalid"; },
        [](Shell& s) { s.section = L"today"; }, [](Shell& s) { s.closing = true; },
        [](Shell& s) { s.rows = control(); }, [](Shell& s) { s.page = control(); },
        [](Shell& s) { s.page.node->content = control(); }, [](Shell& s) { ++s.mailLoadTicket; },
        [](Shell& s) { s.previous = control(); s.previous.IsEnabled(false); },
        [](Shell& s) { s.next = control(); s.next.IsEnabled(false); },
        [](Shell& s) { s.search = control(); s.search.IsEnabled(false); },
        [](Shell& s) { s.sorting = control(); s.sorting.IsEnabled(false); },
        [](Shell& s) { s.unreadFilter = control(); s.unreadFilter.IsEnabled(false); }
    };
    for (bool fail : {false, true}) for (auto const& change : replaceOwner) {
        Fixture f; auto operation = f.shell->loadPage(0, false, false, f.validity()); f.disabled();
        f.selectionUpdates({{1, true}});
        auto original = std::vector<Control>{f.shell->previous, f.shell->next, f.shell->search, f.shell->sorting, f.shell->unreadFilter};
        f.shell->service->complete(0, response(), fail); change(*f.shell); f.shell->service->resume(0);
        assert(!operation.get()); f.disabled(); f.rejected(); for (auto const& item : original) assert(!item.IsEnabled()); ++checks;
        // Replacing even one control revokes the old request's callback too.
        f.selectionUpdates({{1, true}});
    }
    {
        Fixture f; auto older = f.shell->loadPage(0, false, false, f.validity());
        f.selectionUpdates({{1, true}});
        f.shell->service->complete(0, response());
        auto newer = f.shell->loadPage(0, false, false, f.validity()); f.disabled();
        f.selectionUpdates({{1, true}, {2, true}});
        f.shell->service->resume(0);
        assert(!older.get() && !newer.done()); f.disabled(); f.rejected();
        f.selectionUpdates({{1, true}, {2, true}});
        f.shell->service->complete(1, response()); f.shell->service->resume(1); assert(newer.get()); f.restored();
        assert(f.shell->adoptions == 1 && f.shell->mailRevision == L"fresh-revision"); ++checks;
        f.selectionUpdates({{1, true}, {2, true}, {2, false}});
    }
    // Cursor expiry and empty-page fallback both await a second POST. Rejecting
    // that response must restore the committed pager rather than the retry.
    for (bool expired : {false, true}) for (bool fail : {false, true}) {
        Fixture f; auto operation = f.shell->loadPage(0, false, false, f.validity());
        f.selectionUpdates({{1, true}});
        Json body = pageResult(1);
        if (expired) put(body, L"error", L"Mail changed or the cursor expired. Refresh the list.");
        f.shell->service->complete(0, response(body, expired ? 409 : 200)); f.shell->service->resume(0);
        assert(!operation.done() && f.shell->service->calls.size() == 2); f.disabled();
        f.selectionUpdates({{1, true}});
        f.shell->service->complete(1, pageResult(), fail); f.shell->syncing = true; f.shell->service->resume(1);
        assert(!operation.get()); f.restored(); f.rejected(); ++checks;
        f.selectionUpdates({{1, true}, {1, false}});
    }
    // Exercise the final invalidation check after catch, separately from the
    // first/second transport guards. This is a synthetic validity transition.
    {
        Fixture f; auto scope = f.validity(); unsigned calls = 0;
        auto validity = [scope, &calls](Json const& value) { return ++calls < 3 && scope(value); };
        auto operation = f.shell->loadPage(0, false, false, validity);
        f.selectionUpdates({{1, true}});
        f.shell->service->complete(0, {}, true); f.shell->service->resume(0);
        assert(!operation.get() && calls == 3); f.restored(); f.rejected(); ++checks;
        f.selectionUpdates({{1, true}, {1, false}});
    }
    for (bool guarded : {false, true}) for (bool fail : {false, true}) {
        Fixture f; auto operation = f.shell->loadPage(0, false, false, guarded ? f.validity() : WorkspaceReadGuard{});
        f.selectionUpdates({{1, true}});
        f.shell->service->complete(0, response(), fail); f.shell->service->resume(0);
        bool threw = false; bool completed = false;
        try { completed = operation.get(); } catch (hresult_error const&) { threw = true; }
        assert(threw == (guarded && fail)); if (!threw) assert(completed); f.restored();
        assert(f.shell->adoptions == (fail ? 0u : 1u) && f.shell->priorityCalls == (guarded ? 0u : 1u)); ++checks;
        f.selectionUpdates({{1, true}, {1, false}});
    }
    std::cout << "Page abandonment: " << checks << " actual loadPage/scope controls passed; row renderer/WinRT are fakes, native SDK regression remains pending.\n";
}
