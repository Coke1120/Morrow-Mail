#include "pch.h"
#include "Ui.h"
#include <cmath>

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
using namespace Windows::Data::Json;
using namespace controls;
namespace {
hstring count(Json const& value, wchar_t const* key) {
    auto number = value.GetNamedNumber(key, 0);
    return to_hstring(static_cast<uint64_t>(std::max(0.0, std::min(number, 9007199254740991.0))));
}
hstring coverageText(Json const& value) {
    return count(value,L"cachedCount") + L" stored · " + count(value,L"count") + L" indexed · " + count(value,L"incompleteCount") + L" incomplete · " + count(value,L"truncatedCount") + L" shortened bodies";
}
hstring downloadConnectionRef(Json const& state, hstring const& owner) {
    for (auto const& entry:array(state,L"accounts")) {
        auto account=entry.GetObject();
        if(text(account,L"id")==owner) return text(object(account,L"settings"),L"connectionRef");
    }
    return L"";
}
bool validPage(Json const& value, hstring const& owner, hstring const& connectionRef) {
    auto rows = value.TryLookup(L"items"); auto page = value.GetNamedNumber(L"page", -1);
    if (connectionRef.empty() || text(value,L"connectionRef")!=connectionRef || text(value,L"accountId") != owner || value.GetNamedNumber(L"pageSize",0) != 30 || !rows || rows.ValueType()!=JsonValueType::Array || !std::isfinite(page) || page<0 || std::floor(page)!=page || page>9007199254740991.0) return false;
    if (rows.GetArray().Size()>30) return false;
    for (auto const& item : rows.GetArray()) {
        if (item.ValueType()!=JsonValueType::Object) return false;
        auto row=item.GetObject();
        if (text(row,L"accountId")!=owner || text(row,L"id").empty() || text(row,L"viewId").empty()) return false;
    }
    return true;
}
struct DownloadDialog {
    ContentDialog dialog;
    hstring action, account;
    Json message;
    uint64_t page = 0;
    void choose(hstring next) { action=next; dialog.Hide(); }
};

// A navigation/new page may replace an in-flight Downloads read. Only its owner
// may release the shared loading flag, including cancellation and late failures.
struct DownloadLoading {
    Shell& shell;
    uint64_t ticket;
    explicit DownloadLoading(Shell& value) : shell(value), ticket(++value.mailLoadTicket) { shell.loading = true; }
    DownloadLoading(DownloadLoading const&) = delete;
    DownloadLoading& operator=(DownloadLoading const&) = delete;
    bool current() const { return shell.mailLoadTicket == ticket; }
    ~DownloadLoading() { if (current()) shell.loading = false; }
};

struct DownloadRefreshScope {
    hstring account, connectionRef, viewOwner, section, folder, query, submittedQuery;
    hstring selectedOwner, selectedID, selectedViewID, selectedConnection;
    uint64_t generation, selection;
    controls::ListView rows;
    controls::ContentControl page, reader;
    IInspectable content;
    controls::TextBox search;
    controls::ComboBox sorting;
    controls::CheckBox unreadFilter;
    int sortIndex;
    bool unreadOnly;

    DownloadRefreshScope(Shell const& shell, hstring owner, hstring reference)
        : account(std::move(owner)), connectionRef(std::move(reference)), viewOwner(shell.owner),
          section(shell.section), folder(shell.folder), query(shell.search ? shell.search.Text() : hstring{}),
          submittedQuery(shell.mailSearchQuery), selectedOwner(text(shell.selected,L"accountId")),
          selectedID(text(shell.selected,L"id")), selectedViewID(text(shell.selected,L"viewId")),
          selectedConnection(downloadConnectionRef(shell.state,selectedOwner)),
          generation(shell.generation), selection(shell.selectionGeneration), rows(shell.rows), page(shell.page),
          reader(shell.reader), content(shell.page ? shell.page.Content() : IInspectable{nullptr}),
          search(shell.search), sorting(shell.sorting), unreadFilter(shell.unreadFilter),
          sortIndex(shell.sorting ? shell.sorting.SelectedIndex() : -1),
          unreadOnly(shell.unreadFilter && shell.unreadFilter.IsChecked() && shell.unreadFilter.IsChecked().Value()) {}

    bool current(Shell const& shell, Json const& candidate) const {
        if (!shell.current(generation,viewOwner) || shell.section!=section || shell.folder!=folder
            || shell.selectionGeneration!=selection || shell.rows!=rows || shell.page!=page || shell.reader!=reader
            || (page && page.Content()!=content)
            || shell.search!=search || shell.sorting!=sorting || shell.unreadFilter!=unreadFilter
            || (search && (search.Text()!=query || shell.mailSearchQuery!=submittedQuery))
            || (sorting && sorting.SelectedIndex()!=sortIndex)
            || (unreadFilter && bool(unreadFilter.IsChecked() && unreadFilter.IsChecked().Value())!=unreadOnly)
            || shell.dialogOpen || shell.navigationLocked || shell.syncing || shell.pendingRead.Size() || !shell.dirty.empty()
            || !shell.service || shell.service->writing() || !shell.navigation || !shell.navigation.IsEnabled()
            || !shell.connected(account) || connectionRef.empty()
            || downloadConnectionRef(shell.state,account)!=connectionRef
            || downloadConnectionRef(candidate,account)!=connectionRef
            || text(object(candidate,L"account"),L"id")!=viewOwner
            || text(shell.selected,L"accountId")!=selectedOwner || text(shell.selected,L"id")!=selectedID
            || text(shell.selected,L"viewId")!=selectedViewID) return false;
        return selectedOwner.empty() || (!selectedConnection.empty()
            && downloadConnectionRef(shell.state,selectedOwner)==selectedConnection
            && downloadConnectionRef(candidate,selectedOwner)==selectedConnection);
    }
};

IAsyncOperation<bool> refreshDownloadedViews(std::shared_ptr<Shell> shell, DownloadRefreshScope scope) {
    if (!scope.current(*shell,shell->state)) co_return false;
    auto validity=[shell,scope](Json const& candidate) { return scope.current(*shell,candidate); };
    auto ticket=shell->workspaceRefreshTicket+1;
    bool completed=false;
    try { completed=co_await shell->refresh(true,validity); }
    catch (...) {
        if (!validity(shell->state) || shell->workspaceRefreshTicket!=ticket) co_return false;
        throw hresult_error(E_FAIL,L"Download saved, but the mailbox view could not refresh. Close Downloads and refresh the mailbox. "+errorText());
    }
    co_return completed && shell->workspaceRefreshTicket==ticket && validity(shell->state);
}

template<typename Check> void downloadLoadingChecks(Check check) {
    Shell shell;
    {
        DownloadLoading active(shell);
        check(shell.loading && active.current());
    }
    check(!shell.loading);
    for (bool fail : {false, true}) {
        try {
            DownloadLoading old(shell);
            // Navigation starts a replacement page while the old GET is pending.
            ++shell.mailLoadTicket; shell.loading = true;
            check(!old.current());
            if (fail) throw 1;
            // Success/early-return and exception paths both unwind the old request.
        } catch (int) { }
        check(shell.loading);
        { DownloadLoading replacement(shell); check(replacement.current()); }
        check(!shell.loading);
    }
    try { DownloadLoading active(shell); throw 1; } catch (int) { }
    check(!shell.loading);
}
}

IAsyncOperation<bool> Shell::repairDownloadedMessage(Json message, hstring account, hstring connectionRef) {
    auto lifetime=shared_from_this();
    DownloadRefreshScope scope(*this,account,connectionRef);
    if (loading || syncing || !scope.current(*this,state) || !flag(message,L"canRepair")
        || text(message,L"accountId")!=account || text(message,L"id").empty() || text(message,L"viewId").empty()) co_return false;
    // An older workspace/detail read cannot restore the pre-download snapshot.
    ++workspaceRefreshTicket; refreshing=false; ++readGeneration;
    {
        DownloadLoading request(*this);
        Json body; put(body,L"connectionRef",connectionRef);
        auto result=co_await service->request(L"/messages/"+escaped(text(message,L"id"))+L"/attachments",account,L"POST",body);
        if (!request.current() || !scope.current(*this,state)) co_return false;
        auto downloaded=object(result,L"message");
        if (text(downloaded,L"accountId")!=account || text(downloaded,L"id")!=text(message,L"id")
            || text(downloaded,L"viewId")!=text(message,L"viewId")) throw hresult_error(E_FAIL,L"Downloaded message ownership could not be confirmed.");
        // The POST may precede a flag change. Shared refresh reads the latest
        // local projections and reader; never copy the full POST body into rows.
    }
    co_return co_await refreshDownloadedViews(lifetime,scope);
}

IAsyncAction Shell::downloadControls(hstring account) {
    auto lifetime=shared_from_this(); auto version=generation; auto captured=owner;
    if (closing||dialogOpen||loading||navigationLocked||pendingRead.Size()||!service||service->writing()) co_return;
    if (!dirty.empty()) {error(L"Save or discard your current edits before opening download controls."); co_return;}
    if (!connected(account)) for (auto const& entry : array(state,L"accounts")) {
        auto candidate=text(entry.GetObject(),L"id"); if (connected(candidate)) { account=candidate; break; }
    }
    if (!connected(account)) co_return;
    auto connectionRef=downloadConnectionRef(state,account);
    if(connectionRef.empty()) {error(L"Refresh the mailbox before opening download controls."); co_return;}
    uint64_t requested=0; Json snapshot, records; hstring notice;
    try {
        while (current(version,captured)&&connected(account)&&downloadConnectionRef(state,account)==connectionRef) {
            {
            DownloadLoading request(*this);
            try {
                auto next=co_await service->request(L"/downloads",account);
                if (!request.current()||!current(version,captured)||!connected(account)||downloadConnectionRef(state,account)!=connectionRef) co_return;
                auto rows=co_await service->request(L"/downloads/incomplete?page="+to_hstring(requested),account);
                if (!request.current()||!current(version,captured)||!connected(account)||downloadConnectionRef(state,account)!=connectionRef) co_return;
                if (text(next,L"accountId")!=account || text(next,L"connectionRef")!=connectionRef || !validPage(rows,account,connectionRef)) {
                    snapshot=Json(); records=Json();
                    throw hresult_error(E_FAIL,L"The mailbox connection or download page changed. Close this panel and refresh the mailbox.");
                }
                snapshot=next; records=rows; requested=static_cast<uint64_t>(records.GetNamedNumber(L"page",0));
            } catch (...) { if(!request.current()||!current(version,captured)) co_return; notice=errorText(); }
            }
            if (!current(version,captured)||!connected(account)||downloadConnectionRef(state,account)!=connectionRef) co_return;
            auto panel=std::make_shared<DownloadDialog>(); std::weak_ptr<DownloadDialog> weak=panel;
            panel->account=account; panel->page=requested;
            auto content=stack(12); content.Width(600);
            ComboBox accounts; accounts.Header(box_value(L"Mailbox"));
            for (auto const& entry:array(state,L"accounts")) {
                auto id=text(entry.GetObject(),L"id"); if (!connected(id)) continue;
                ComboBoxItem item; item.Content(box_value(id)); item.Tag(box_value(id)); accounts.Items().Append(item); if(id==account) accounts.SelectedItem(item);
            }
            accounts.SelectionChanged([weak](auto const& sender,auto const&) { if(auto panel=weak.lock()) {
                auto item=sender.template as<ComboBox>().SelectedItem().template try_as<ComboBoxItem>();
                if(item) { auto owner=unbox_value<hstring>(item.Tag()); if(owner!=panel->account) {panel->account=owner; panel->page=0; panel->choose(L"account");} }
            }});
            content.Children().Append(accounts);
            content.Children().Append(label(L"Opening this panel reads local records only. Downloads need an explicit action; no AI is called.",12));
            if (snapshot.Size()) {
                content.Children().Append(label(L"Available offline and in keyword search",18));
                content.Children().Append(label(coverageText(snapshot)));
                if(snapshot.GetNamedNumber(L"indexPendingCount",0)>0) content.Children().Append(label(count(snapshot,L"indexPendingCount")+L" stored records are waiting for the keyword index.",12));
                content.Children().Append(label(L"Indexed dates: "+text(snapshot,L"oldest",L"Not recorded")+L" — "+text(snapshot,L"newest",L"Not recorded"),12));
                content.Children().Append(label(text(snapshot,L"coverageDescription"),12));
                content.Children().Append(label(L"Stored data for this mailbox",18));
                content.Children().Append(label(L"Message records: "+count(snapshot,L"messageBytes")+L" bytes · Attachment data: "+count(snapshot,L"attachmentBytes")+L" bytes ("+count(snapshot,L"attachmentCount")+L" copies)"));
                content.Children().Append(label(text(snapshot,L"storageDescription"),12));
                content.Children().Append(label(L"Cached mail is retained when you shorten history or disconnect. There is no automatic cache deletion or storage quota.",12));
                content.Children().Append(label(L"Download controls",18));
                auto job=object(snapshot,L"import"); auto status=text(job,L"status"), recovery=text(job,L"recoveryAction");
                auto options=object(job,L"options");
                content.Children().Append(label(job.Size()?L"History: "+status+L" · "+(!options.Size()?hstring(L"Previous connection's range is unavailable."):options.GetNamedNumber(L"months",0)==0?hstring(L"All history"):L"Last "+count(options,L"months")+L" months"):L"History import has not started."));
                if(!text(job,L"error").empty()) content.Children().Append(label(text(job,L"error"),12));
                if(!text(snapshot,L"jobRef").empty()&&status==L"running") content.Children().Append(button(L"Pause history import",[weak] {if(auto panel=weak.lock()) panel->choose(L"pause");}));
                else if(!text(snapshot,L"jobRef").empty()&&(status==L"paused"||status==L"failed")&&recovery!=L"reconnect"&&recovery!=L"restart") content.Children().Append(button(L"Resume from checkpoint",[weak] {if(auto panel=weak.lock()) panel->choose(L"resume");}));
                content.Children().Append(button(L"Choose history range…",[weak] {if(auto panel=weak.lock()) panel->choose(L"settings");}));
                content.Children().Append(button(L"Automatic sync settings…",[weak] {if(auto panel=weak.lock()) panel->choose(L"preferences");}));
                content.Children().Append(label(snapshot.GetNamedNumber(L"syncIntervalMinutes",0)==0?L"Automatic recent-mail sync is set to Manually.":L"Automatic recent-mail sync: every "+count(snapshot,L"syncIntervalMinutes")+L" minutes for all accounts.",12));
                content.Children().Append(label(L"Pausing history stops subsequent history pages and retains the checkpoint/cache. It does not stop recent-mail sync or an in-flight request. Manual sync settings do not pause history. Attachments download only on request.",12));
                content.Children().Append(label(L"These are download controls, not a global offline mode. Explicit sync, read-state changes and other online actions can still connect.",12));
            }
            content.Children().Append(label(L"Local and provider recovery",18));
            content.Children().Append(label(L"Archive locally and Move to Local Trash change only this app. Open that local folder and use Undo local move while its location and connection still match. Provider Trash has a separate one-minute Undo; after expiry/restart, use a reviewed provider move or your original mailbox. Check an uncertain provider change before another attempt.",12));
            content.Children().Append(label(L"Content to review",18));
            content.Children().Append(label(L"Incomplete or shortened provider messages, including unavailable originals. A download retries one message; message-size limits can still apply.",12));
            for(auto const& entry:array(records,L"items")) {
                auto message=Json::Parse(entry.GetObject().Stringify());
                content.Children().Append(label(text(message,L"subject",L"(No subject)")));
                content.Children().Append(label(text(message,L"folder")+L" · "+mailDateLabel(text(message,L"date")),12));
                content.Children().Append(label(text(message,L"reason"),12));
                auto repair=button(L"Download full content…",[weak,message] {if(auto panel=weak.lock()) {panel->message=message;panel->choose(L"repair");}});
                repair.IsEnabled(flag(message,L"canRepair")); content.Children().Append(repair);
            }
            if(records.Size()&&!array(records,L"items").Size()) content.Children().Append(label(L"No incomplete provider records in this cache.",12));
            auto previous=button(L"Previous",[weak] {if(auto panel=weak.lock()) {if(panel->page) --panel->page;panel->choose(L"page");}});
            previous.IsEnabled(requested>0); content.Children().Append(previous);
            content.Children().Append(label(L"Page "+to_hstring(requested+1)+L" · "+count(records,L"total")+L" records · 30 per page",12));
            auto next=button(L"Next",[weak] {if(auto panel=weak.lock()) {++panel->page;panel->choose(L"page");}});
            next.IsEnabled(flag(records,L"hasNext")); content.Children().Append(next);
            content.Children().Append(button(L"Refresh local status",[weak] {if(auto panel=weak.lock()) panel->choose(L"refresh");}));
            if(!notice.empty()) content.Children().Append(label(notice,12));
            panel->dialog.XamlRoot(root.XamlRoot()); panel->dialog.Title(box_value(L"Downloads & storage")); panel->dialog.CloseButtonText(L"Done");
            panel->dialog.Resources().Insert(box_value(L"ContentDialogMaxWidth"),box_value(680.0)); auto body=scroll(content); body.MaxHeight(520); panel->dialog.Content(body);
            dialogOpen=true; try {co_await panel->dialog.ShowAsync();} catch(...) {dialogOpen=false;throw;} dialogOpen=false;
            if(!current(version,captured)||!connected(account)||downloadConnectionRef(state,account)!=connectionRef||panel->action.empty()) co_return;
            if(panel->action==L"settings"||panel->action==L"preferences") {co_await navigate(panel->action); co_return;}
            if(panel->action==L"account") {account=panel->account; connectionRef=downloadConnectionRef(state,account); if(connectionRef.empty()) co_return; snapshot=Json(); records=Json(); notice=L"";}
            requested=panel->page;
            if(panel->action==L"pause"||panel->action==L"resume"||panel->action==L"repair") {
                if(text(snapshot,L"connectionRef")!=connectionRef || text(records,L"connectionRef")!=connectionRef) throw hresult_error(E_FAIL,L"Refresh Downloads before trying again.");
                bool repairing=panel->action==L"repair";
                Json body; put(body,L"connectionRef",connectionRef);
                if(!repairing) {auto jobRef=text(snapshot,L"jobRef"); if(jobRef.empty()) throw hresult_error(E_FAIL,L"Refresh the history import before trying again."); put(body,L"jobRef",jobRef);}
                if(repairing) {
                    if(text(panel->message,L"accountId")!=account||!flag(panel->message,L"canRepair")) throw hresult_error(E_FAIL,L"The owning message changed.");
                    if(!(co_await confirm(L"Download this message's full content?",account+L"\n"+text(panel->message,L"subject")+L"\nThis explicitly downloads one message, including attachments (up to 50 MiB) and raw message data (up to 80 MiB). Nothing is moved, deleted or sent; no AI is called.",L"Download"))) continue;
                }
                if(!current(version,captured)||!connected(account)||downloadConnectionRef(state,account)!=connectionRef) co_return;
                try {
                    if(repairing) {
                        if (!(co_await repairDownloadedMessage(panel->message,account,connectionRef))) co_return;
                        notice=L"Download saved. Review remaining content limits above.";
                    } else {
                        DownloadLoading request(*this);
                        try {
                            co_await service->request(L"/imports/"+panel->action,account,L"POST",body);
                            if(!request.current()||!current(version,captured)||!connected(account)||downloadConnectionRef(state,account)!=connectionRef) co_return;
                            notice=L"History checkpoint updated.";
                        } catch (...) { if (!request.current()) co_return; throw; }
                    }
                } catch(...) {if(!current(version,captured)||!connected(account)||downloadConnectionRef(state,account)!=connectionRef) co_return; notice=errorText();}
            }
        }
    } catch(...) {if(current(version,captured)) error(errorText());}
}

IAsyncAction downloadRefreshChecks(std::shared_ptr<Shell> shell) {
    auto check=[](bool value,hstring const& detail) { if(!value) throw hresult_error(E_FAIL,detail); };
    auto visible=[shell](hstring const& viewID) {
        for(auto const& value:shell->rows.Items()) {
            auto row=value.as<ListViewItem>().Tag().as<Json>();
            if(text(row,L"viewId")==viewID) return row;
        }
        return Json();
    };
    auto stale=[shell](Json const& original) {
        shell->selected=Json::Parse(original.Stringify());
        put(shell->selected,L"body",L"Incomplete local copy before download");
        put(shell->selected,L"bodyHtml",L"");
        shell->selected.Insert(L"contentIncomplete",Value::CreateBooleanValue(true));
        shell->selected.Insert(L"attachmentsLoaded",Value::CreateBooleanValue(false));
        shell->renderReader(shell->selected);
        shell->state=Json::Parse(shell->state.Stringify());
        put(shell->state,L"revision",L"download-fixture-stale");
        shell->mailRevision=L"download-fixture-stale";
        for(auto const& value:shell->rows.Items()) {
            auto item=value.as<ListViewItem>(); auto row=Json::Parse(item.Tag().as<Json>().Stringify());
            if(text(row,L"viewId")==text(original,L"viewId")) {
                put(row,L"preview",L"Incomplete local preview before download"); item.Tag(row);
            }
        }
    };
    // This exercises the actual completion path against the fictional local
    // service. Provider download/POST is covered by the held-transport control;
    // it must not contact the fixture accounts' fake Google credentials.
    co_await shell->navigate(L"mail",L"one@fixture.invalid");
    co_await shell->loadPage(1);
    check(shell->cursors.size()==2 && shell->rows.Items().Size()==15,L"Download refresh fixture requires mail page two.");
    auto row=shell->rows.Items().GetAt(0).as<ListViewItem>(); auto metadata=row.Tag().as<Json>();
    shell->loading=true; shell->rows.SelectedItem(row); shell->loading=false;
    co_await shell->read(metadata,false);
    auto original=Json::Parse(shell->selected.Stringify()); auto sequence=shell->selectionGeneration;
    auto viewID=text(original,L"viewId"), account=text(original,L"accountId"), id=text(original,L"id");
    auto reference=downloadConnectionRef(shell->state,account);
    stale(original);
    check(text(shell->selected,L"body")!=text(original,L"body")
        && text(visible(viewID),L"preview")==L"Incomplete local preview before download",L"Download refresh fixture did not expose stale reader/list copies.");
    check(co_await refreshDownloadedViews(shell,DownloadRefreshScope(*shell,account,reference)),L"Downloaded mail did not finish its shared refresh.");
    check(shell->cursors.size()==2 && shell->rows.Items().Size()==15 && shell->selectionGeneration==sequence
        && text(shell->selected,L"viewId")==viewID && text(shell->selected,L"body")==text(original,L"body")
        && flag(shell->selected,L"read")==flag(original,L"read")
        && text(visible(viewID),L"preview")!=L"Incomplete local preview before download"
        && shell->mailRevision!=L"download-fixture-stale" && text(shell->state,L"revision")!=L"download-fixture-stale",
        L"Download refresh left stale shared state/list/reader or changed the current page/selection/read flag.");
    for(auto const& value:shell->rows.Items()) {
        auto item=value.as<ListViewItem>().Tag().as<Json>();
        check(!item.HasKey(L"body") && !item.HasKey(L"bodyHtml") && !item.HasKey(L"attachments"),L"Download refresh copied reader content into list metadata.");
    }
    auto persisted=object(co_await shell->service->request(L"/messages/"+escaped(id),account),L"message");
    check(flag(persisted,L"read")==flag(original,L"read"),L"Download completion performed mark-on-open.");

    shell->search.Text(L"Native fixture"); co_await shell->loadPage(0,false,true); co_await shell->loadPage(1);
    check(shell->rows.Items().Size()==30 && shell->cursors.size()==2,L"Download refresh fixture requires search page two.");
    auto searchRow=shell->rows.Items().GetAt(0).as<ListViewItem>().Tag().as<Json>();
    co_await shell->read(searchRow,false); original=Json::Parse(shell->selected.Stringify());
    shell->search.Text(L"Unsubmitted download fixture edit"); stale(original);
    check(co_await refreshDownloadedViews(shell,DownloadRefreshScope(*shell,account,reference)),L"Download refresh did not reload the submitted search.");
    check(shell->search.Text()==L"Unsubmitted download fixture edit" && shell->mailSearchQuery==L"Native fixture"
        && shell->cursors.size()==2 && shell->rows.Items().Size()==30
        && text(shell->selected,L"body")==text(original,L"body"),L"Download refresh submitted an unfinished search edit or reset its page.");

    // Synthetic scope invalidation at the actual native page continuation,
    // after the local POST releases Write. This checks cleanup without running
    // Sync/provider work; it does not reproduce native event scheduling.
    {
        auto scope=DownloadRefreshScope(*shell,account,reference);
        auto invalidated=std::make_shared<bool>(false);
        auto validity=[shell,scope,invalidated](Json const& candidate) {
            if(!*invalidated && shell->loading && !shell->search.IsEnabled() && !shell->service->writing()) {
                *invalidated=true; shell->syncing=true;
            }
            return scope.current(*shell,candidate);
        };
        auto cursors=shell->cursors; auto nextCursor=shell->nextCursor;
        auto revision=shell->mailRevision, selected=shell->selected.Stringify();
        auto pageLabel=shell->pageLabel.Text(); auto first=shell->rows.Items().GetAt(0);
        bool adopted=false; std::exception_ptr failure;
        try {
            auto pending=shell->loadPage(0,false,false,validity);
            check(shell->loading && !shell->previous.IsEnabled() && !shell->next.IsEnabled()
                && !shell->search.IsEnabled() && !shell->sorting.IsEnabled() && !shell->unreadFilter.IsEnabled(),
                L"Guarded native page did not disable its controls before its local read.");
            adopted=co_await pending;
        } catch(...) { failure=std::current_exception(); }
        shell->syncing=false;
        if(failure) std::rethrow_exception(failure);
        check(*invalidated && !adopted && !shell->loading && shell->previous.IsEnabled() && shell->next.IsEnabled()
            && shell->search.IsEnabled() && !shell->sorting.IsEnabled() && !shell->unreadFilter.IsEnabled()
            && shell->cursors==cursors && shell->nextCursor==nextCursor && shell->mailRevision==revision
            && shell->pageLabel.Text()==pageLabel && shell->rows.Items().GetAt(0)==first && shell->selected.Stringify()==selected
            && shell->search.Text()==L"Unsubmitted download fixture edit" && shell->mailSearchQuery==L"Native fixture",
            L"Abandoned native page adopted a stale response, lost the draft query or left its controls disabled.");
    }

    co_await shell->navigate(L"mail",L"one@fixture.invalid");
    shell->unreadFilter.IsChecked(true); co_await shell->loadPage(0,false,true);
    check(shell->rows.Items().Size()>0,L"Download refresh fixture requires an unread local message.");
    auto unreadRow=shell->rows.Items().GetAt(0).as<ListViewItem>(); auto unreadMessage=unreadRow.Tag().as<Json>();
    auto unreadID=text(unreadMessage,L"id");
    check(!flag(unreadMessage,L"read"),L"Download unread fixture chose an already-read message.");
    // Establish retainedUnread through the actual read handler. This intentional
    // fixture-only local flag change is restored below; completion must add none.
    object(object(shell->state,L"settings"),L"preferences").Insert(L"markReadOnOpen",Value::CreateBooleanValue(true));
    shell->loading=true; shell->rows.SelectedItem(unreadRow); shell->loading=false;
    std::exception_ptr retainedFailure;
    try {
        co_await shell->read(unreadMessage);
        check(shell->retainedUnread.Size() && flag(shell->selected,L"read"),L"Actual reader did not establish its retained unread-filter row.");
        original=Json::Parse(shell->selected.Stringify()); stale(original);
        put(shell->retainedUnread,L"preview",L"Incomplete local preview before download");
        reference=downloadConnectionRef(shell->state,account);
        check(co_await refreshDownloadedViews(shell,DownloadRefreshScope(*shell,account,reference)),L"Download refresh did not finish for a retained read row.");
        check(shell->retainedUnread.Size() && text(shell->retainedUnread,L"preview")!=L"Incomplete local preview before download"
            && text(visible(text(original,L"viewId")),L"preview")!=L"Incomplete local preview before download"
            && flag(shell->selected,L"read") && text(shell->selected,L"body")==text(original,L"body")
            && !shell->retainedUnread.HasKey(L"body") && !shell->retainedUnread.HasKey(L"bodyHtml") && !shell->retainedUnread.HasKey(L"attachments"),
            L"Download refresh retained stale preview metadata or exposed full reader content.");
        persisted=object(co_await shell->service->request(L"/messages/"+escaped(unreadID),account),L"message");
        check(flag(persisted,L"read"),L"Download refresh changed the retained message's read flag.");
    } catch (...) { retainedFailure=std::current_exception(); }
    Json unreadRestore; unreadRestore.Insert(L"read",Value::CreateBooleanValue(false));
    co_await shell->service->request(L"/messages/"+escaped(unreadID),account,L"PATCH",unreadRestore);
    shell->state=co_await shell->service->request(L"/state",account);
    if(retainedFailure) std::rethrow_exception(retainedFailure);

    co_await shell->navigate(L"mail",L"all");
    auto other=object(co_await shell->service->request(L"/messages/mail-000",L"two@fixture.invalid"),L"message");
    co_await shell->read(other,false); original=Json::Parse(shell->selected.Stringify());
    sequence=shell->selectionGeneration; stale(original);
    reference=downloadConnectionRef(shell->state,L"one@fixture.invalid");
    check(co_await refreshDownloadedViews(shell,DownloadRefreshScope(*shell,L"one@fixture.invalid",reference)),L"Combined download completion did not refresh local views.");
    check(shell->owner==L"all" && text(shell->selected,L"accountId")==L"two@fixture.invalid"
        && text(shell->selected,L"viewId")==text(original,L"viewId") && shell->selectionGeneration==sequence
        && text(shell->selected,L"body")==text(original,L"body") && flag(shell->selected,L"read")==flag(original,L"read"),
        L"Repairing another owner's duplicate ID replaced the selected reader.");
    DownloadRefreshScope obsolete(*shell,L"one@fixture.invalid",reference);
    ++shell->selectionGeneration; auto ticket=shell->workspaceRefreshTicket;
    check(!(co_await refreshDownloadedViews(shell,obsolete)) && shell->workspaceRefreshTicket==ticket,
        L"An obsolete download completion started a new workspace read.");
    co_await shell->navigate(L"mail",L"one@fixture.invalid");
}

void downloadControlsChecks() {
    auto check=[](bool value) {if(!value) throw hresult_error(E_FAIL,L"Download page ownership/bounds check failed.");};
    downloadLoadingChecks(check);
    auto page=Json::Parse(LR"({"accountId":"a@example.invalid","connectionRef":"fixture-reference","page":0,"pageSize":30,"items":[{"id":"same","viewId":"a:same","accountId":"a@example.invalid"}]})");
    check(validPage(page,L"a@example.invalid",L"fixture-reference")); check(!validPage(page,L"b@example.invalid",L"fixture-reference"));
    check(!validPage(page,L"a@example.invalid",L"reconnected")); check(!validPage(page,L"a@example.invalid",L""));
    put(page,L"connectionRef",L""); check(!validPage(page,L"a@example.invalid",L"fixture-reference")); put(page,L"connectionRef",L"fixture-reference");
    auto state=Json::Parse(LR"({"accounts":[{"id":"a@example.invalid","settings":{"connectionRef":"fixture-reference"}},{"id":"b@example.invalid","settings":{"connectionRef":"other-reference"}}]})");
    check(downloadConnectionRef(state,L"a@example.invalid")==L"fixture-reference");
    check(downloadConnectionRef(state,L"disconnected@example.invalid").empty());
    auto settings=object(array(state,L"accounts").GetAt(0).GetObject(),L"settings"); put(settings,L"connectionRef",L"reconnected");
    check(downloadConnectionRef(state,L"a@example.invalid")==L"reconnected");
    check(!validPage(page,L"a@example.invalid",downloadConnectionRef(state,L"a@example.invalid")));
    Shell shell; shell.owner=L"a@example.invalid"; shell.generation=11;
    check(shell.current(11,L"a@example.invalid"));
    shell.owner=L"b@example.invalid"; ++shell.generation; check(!shell.current(11,L"a@example.invalid"));
    shell.owner=L"a@example.invalid"; ++shell.generation; check(!shell.current(11,L"a@example.invalid"));
    check(shell.current(13,L"a@example.invalid")); shell.closing=true; check(!shell.current(13,L"a@example.invalid"));
    auto row=array(page,L"items").GetAt(0).GetObject(); put(row,L"accountId",L"b@example.invalid"); check(!validPage(page,L"a@example.invalid",L"fixture-reference"));
    put(row,L"accountId",L"a@example.invalid"); auto rows=array(page,L"items"); for(int i=0;i<30;++i) rows.Append(row); check(!validPage(page,L"a@example.invalid",L"fixture-reference"));
    rows.Clear(); page.Insert(L"page",Value::CreateNumberValue(-1)); check(!validPage(page,L"a@example.invalid",L"fixture-reference"));
}
}
