#include "pch.h"
#include "Ui.h"
#include "FolderSyncState.h"
#include <cmath>
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Provider.h>

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
using namespace Windows::Data::Json;
using namespace xaml;
using namespace controls;
namespace {
FolderSyncVersions syncVersions(Json const& value) { return {std::wstring(text(value,L"connectionVersion")),std::wstring(text(value,L"selectionVersion"))}; }
FolderSyncSnapshot syncSnapshot(Json const& value) {
    auto require = [](bool ok) { if (!ok) throw hresult_error(E_FAIL, L"The saved folder selection could not be verified. Reload and review it before continuing."); };
    require(value.HasKey(L"selectionVersion") && value.GetNamedValue(L"selectionVersion").ValueType() == JsonValueType::String
        && value.HasKey(L"folders") && value.GetNamedValue(L"folders").ValueType() == JsonValueType::Array);
    FolderSyncSnapshot result;
    result.owner = text(value,L"accountId"); result.connection = text(value,L"connectionVersion"); result.version = text(value,L"selectionVersion");
    result.supported = flag(value,L"supported"); result.fresh = flag(value,L"catalogFresh"); result.automatic = flag(value,L"automaticSyncEnabled");
    auto interval = value.GetNamedNumber(L"intervalMinutes",0);
    result.interval = std::isfinite(interval) && interval > 0 && interval <= 1440 ? static_cast<unsigned>(interval) : 0;
    for (auto const& item : array(value,L"folders")) {
        require(item.ValueType() == JsonValueType::Object); auto row = item.GetObject(); FolderSyncRow entry;
        entry.id = text(row,L"folderId"); entry.name = text(row,L"name"); entry.selectionId = text(row,L"selectionId");
        entry.selected = flag(row,L"selected"); entry.available = flag(row,L"available"); entry.status = text(row,L"status");
        entry.recovery = text(row,L"recoveryAction"); entry.error = text(row,L"error"); entry.warning = text(row,L"coverageWarning");
        entry.attempted = text(row,L"lastAttemptAt"); entry.successful = text(row,L"lastSuccessfulSyncAt");
        entry.caughtUp = text(row,L"lastCaughtUpAt"); entry.nextRetry = text(row,L"nextRetryAt");
        require(!entry.id.empty() && result.rows.emplace(entry.id,entry).second);
    }
    return result;
}
Json selectionPayload(FolderSyncSelection const& selection) {
    Json result; Array folders;
    for (auto const& id : selection.selected) folders.Append(Value::CreateStringValue(id));
    result.Insert(L"folderIds",folders); put(result,L"selectionVersion",hstring(selection.snapshot.version)); put(result,L"connectionVersion",hstring(selection.snapshot.connection));
    return result;
}
Json syncPayload(FolderSyncSelection const& selection) {
    Json result; put(result,L"folderSyncSelectionVersion",hstring(selection.snapshot.version)); put(result,L"folderSyncConnectionVersion",hstring(selection.snapshot.connection)); return result;
}
Json retryPayload(FolderSyncSelection const& selection, std::wstring const& id) {
    if (!selection.canRetry(id)) throw hresult_error(E_FAIL,L"Reload and review this folder before allowing a retry.");
    Json result; put(result,L"selectionId",hstring(selection.snapshot.rows.at(id).selectionId));
    put(result,L"selectionVersion",hstring(selection.snapshot.version)); put(result,L"connectionVersion",hstring(selection.snapshot.connection)); return result;
}
hstring syncTime(std::wstring const& value) { return value.empty() ? hstring(L"Not recorded") : mailDateLabel(hstring(value)); }
hstring syncTimes(FolderSyncRow const& row) {
    return L"Last attempt: " + syncTime(row.attempted) + L"\nLast successful check: " + syncTime(row.successful) + L"\nLast caught up: " + syncTime(row.caughtUp);
}
enum class SyncAction { reload, catalog, save, retry, sync };
struct FolderSyncPane;
IAsyncAction runFolderSync(std::shared_ptr<FolderSyncPane> pane, SyncAction action, std::wstring row = {});
struct FolderSyncPane : std::enable_shared_from_this<FolderSyncPane> {
    std::shared_ptr<Shell> shell;
    FolderSyncSelection selection;
    hstring viewOwner, connectionSettings;
    uint64_t generation = 0, operation = 0, rowGeneration = 0;
    bool busy = false, stale = false, closed = false, configuring = false;
    ContentDialog dialog;
    StackPanel content = stack(10), rows = stack(14);
    TextBox filter;
    TextBlock status, cadence, warning, count, error, notice;
    CheckBox reviewBaseline;
    Button reload, catalog, deselect, discard, sync;
    std::vector<std::pair<std::wstring,CheckBox>> checks;
    std::vector<std::pair<std::wstring,Button>> retries;
    explicit FolderSyncPane(std::shared_ptr<Shell> value, hstring const& account)
        : shell(std::move(value)), selection(std::wstring(account)), viewOwner(shell->owner), generation(shell->generation) {
        for (auto const& item : array(shell->state,L"accounts")) if (text(item.GetObject(),L"id") == account) connectionSettings = object(item.GetObject(),L"settings").Stringify();
    }
    std::wstring dirtyKey() const { return L"folder-sync:" + selection.owner; }
    bool current() const {
        if (closed || !shell->current(generation,viewOwner) || !shell->connected(hstring(selection.owner))) return false;
        for (auto const& item : array(shell->state,L"accounts")) if (text(item.GetObject(),L"id") == selection.owner)
            return object(item.GetObject(),L"settings").Stringify() == connectionSettings;
        return false;
    }
    bool freshSnapshot() const {
        auto latest = object(object(shell->state,L"serverFolderSync"),selection.owner.c_str());
        return !selection.loaded || text(latest,L"connectionVersion").empty()
            || syncVersions(latest) == FolderSyncVersions{selection.snapshot.connection,selection.snapshot.version};
    }
    void enabled() {
        auto previous = configuring; configuring = true;
        auto dirty = selection.dirty(); auto editable = current() && !busy && !stale && selection.snapshot.supported;
        if (dirty) shell->dirty.insert(dirtyKey()); else shell->dirty.erase(dirtyKey());
        dialog.IsPrimaryButtonEnabled(editable && selection.canSave()); dialog.IsSecondaryButtonEnabled(!busy && dirty);
        reload.IsEnabled(current() && !busy && !dirty); catalog.IsEnabled(current() && !busy && !dirty);
        deselect.IsEnabled(editable && !selection.selected.empty()); discard.IsEnabled(!busy && dirty);
        sync.IsEnabled(editable && selection.canSync() && !shell->syncing);
        filter.IsEnabled(!busy); reviewBaseline.IsEnabled(editable);
        reviewBaseline.Visibility(selection.needsBaseline() ? Visibility::Visible : Visibility::Collapsed);
        reviewBaseline.IsChecked(selection.reviewedBaseline);
        for (auto const& [id,check] : checks) {
            bool selected = selection.selected.contains(id); check.IsChecked(selected);
            check.IsEnabled(editable && (selected || selection.snapshot.rows.at(id).available && selection.selected.size() < 20));
        }
        for (auto const& [id,retry] : retries) retry.IsEnabled(editable && selection.canRetry(id));
        count.Text(to_hstring(selection.selected.size()) + L" / 20 selected" + (dirty ? L" · Unsaved changes" : L""));
        status.Text(busy ? L"Working…" : L"");
        configuring = previous;
    }
    void renderRows() {
        configuring = true;
        // Invalidate callbacks before detaching controls: an old row can remain
        // alive and deliver Checked/Unchecked after configuring is restored.
        auto rowsVersion = ++rowGeneration;
        rows.Children().Clear(); checks.clear(); retries.clear(); auto weak = weak_from_this();
        for (auto const& [id,row] : selection.snapshot.rows) {
            if (!filter.Text().empty() && FindStringOrdinal(FIND_FROMSTART,row.name.c_str(),static_cast<int>(row.name.size()),filter.Text().c_str(),static_cast<int>(filter.Text().size()),TRUE) < 0) continue;
            auto card = stack(4); CheckBox check; check.Content(label(hstring(row.name),15,false)); check.IsChecked(selection.selected.contains(id));
            Automation::AutomationProperties::SetName(check,row.name);
            Automation::AutomationProperties::SetAutomationId(check,L"folderSync.folder." + hstring(id));
            auto changed = [weak,id,rowsVersion,control=make_weak(check)](auto const&,auto const&) {
                auto pane=weak.lock(); auto checkbox=control.get();
                if (!pane || !checkbox || pane->rowGeneration!=rowsVersion || !pane->current()
                    || pane->configuring || pane->busy || pane->stale) return;
                if (std::none_of(pane->checks.begin(),pane->checks.end(),[&](auto const& current) {
                    return current.first==id && current.second==checkbox;
                })) return;
                pane->selection.select(id,checkbox.IsChecked().Value()); pane->notice.Text(L""); pane->enabled();
            };
            check.Checked(changed); check.Unchecked(changed); checks.emplace_back(id,check); card.Children().Append(check);
            card.Children().Append(label(hstring(folderSyncStatus(row) + (row.available ? L"" : L" · Folder unavailable in the current saved list")),12));
            if (row.selected) {
                card.Children().Append(label(syncTimes(row),12));
                if (!row.warning.empty()) card.Children().Append(label(hstring(row.warning),12));
                if (!row.error.empty()) card.Children().Append(label(hstring(row.error),12));
                if (!row.nextRetry.empty()) card.Children().Append(label(L"Next eligible retry: " + syncTime(row.nextRetry),12));
                if (row.recovery == L"reconnect") card.Children().Append(label(L"Reconnect this mailbox in Settings → Mail accounts, then reload its folder selection.",12));
                if (row.recovery == L"retry") {
                    auto retry = button(L"Allow retry on the next sync",[weak,id,selectionId=row.selectionId,version=selection.snapshot.version,connection=selection.snapshot.connection] {
                        if (auto pane=weak.lock(); pane && pane->selection.snapshot.version==version && pane->selection.snapshot.connection==connection
                            && pane->selection.snapshot.rows.contains(id) && pane->selection.snapshot.rows.at(id).selectionId==selectionId) runFolderSync(pane,SyncAction::retry,id);
                    });
                    retries.emplace_back(id,retry); card.Children().Append(retry);
                }
            }
            rows.Children().Append(card);
        }
        if (selection.loaded && selection.snapshot.rows.empty()) rows.Children().Append(label(L"No eligible custom folders are in the saved folder list. Use Refresh server folder list to check the server.",12));
        cadence.Text(!selection.loaded ? L"" : selection.snapshot.automatic ? L"Periodic sync: every " + to_hstring(selection.snapshot.interval) + L" minutes while Morrow is running."
            : L"Periodic sync is off. Previously requested reads may still continue after provider waits or update restarts. Use Sync this mailbox now for an explicit sync.");
        warning.Text(!selection.loaded ? L"" : !selection.snapshot.supported ? L"Selected-folder sync is available for connected IMAP mailboxes."
            : !selection.snapshot.fresh ? L"The saved folder list needs refreshing. Refresh the server folder list to select folders, or deselect all to stop syncing them." : L"");
        configuring = false; enabled();
    }
    void build() {
        auto weak = weak_from_this(); dialog.XamlRoot(shell->root.XamlRoot()); dialog.Title(box_value(L"Folders to sync"));
        dialog.Resources().Insert(box_value(L"ContentDialogMaxWidth"),box_value(760.0));
        dialog.PrimaryButtonText(L"Save selection"); dialog.SecondaryButtonText(L"Discard changes"); dialog.CloseButtonText(L"Close"); dialog.DefaultButton(ContentDialogButton::Close);
        content.Children().Append(label(hstring(selection.owner),17));
        content.Children().Append(label(L"Choose custom IMAP folders to download during mailbox sync. Saving changes only the local selection; a later mailbox sync can download selected folders.",13));
        content.Children().Append(label(L"Recent page and new mail only; older mail requires history import. Flags refresh in bounded batches.",13));
        cadence=label(L"",12); content.Children().Append(cadence);
        content.Children().Append(label(L"Up to 20 selected folders; at most 4 folder pages per sync round.",12));
        warning=label(L"",12); content.Children().Append(warning);
        reload=button(L"Reload saved status",[weak] { if (auto pane=weak.lock()) runFolderSync(pane,SyncAction::reload); });
        catalog=button(L"Refresh server folder list",[weak] { if (auto pane=weak.lock()) runFolderSync(pane,SyncAction::catalog); });
        auto readActions=stack(6); readActions.Orientation(Orientation::Horizontal); readActions.Children().Append(reload); readActions.Children().Append(catalog); content.Children().Append(readActions);
        content.Children().Append(label(L"Reload reads local status. Refresh contacts this mailbox’s server for folder names; it does not download messages.",12));
        filter.PlaceholderText(L"Filter folder names"); Automation::AutomationProperties::SetName(filter,L"Filter folder names"); content.Children().Append(filter);
        filter.TextChanged([weak](auto const&,auto const&) { if (auto pane=weak.lock(); pane && !pane->configuring) pane->renderRows(); });
        content.Children().Append(rows);
        reviewBaseline.Content(label(L"Start a new recent-mail baseline for the affected selected folders. Cached mail is retained; older mail still requires history import.",13,false));
        auto reviewed=[weak](auto const&,auto const&) { if (auto pane=weak.lock(); pane && !pane->configuring) { pane->selection.reviewedBaseline=pane->reviewBaseline.IsChecked().Value(); pane->enabled(); } };
        reviewBaseline.Checked(reviewed); reviewBaseline.Unchecked(reviewed);
        content.Children().Append(reviewBaseline);
        count=label(L"",12); content.Children().Append(count);
        deselect=button(L"Deselect all",[weak] { if (auto pane=weak.lock()) { pane->selection.deselectAll(); pane->enabled(); } });
        discard=button(L"Discard unsaved selection",[weak] { if (auto pane=weak.lock()) { pane->selection.discard(); pane->enabled(); } });
        auto edits=stack(6); edits.Orientation(Orientation::Horizontal); edits.Children().Append(deselect); edits.Children().Append(discard); content.Children().Append(edits);
        sync=button(L"Sync this mailbox now",[weak] { if (auto pane=weak.lock()) runFolderSync(pane,SyncAction::sync); }); content.Children().Append(sync);
        status=label(L"",12); error=label(L"",13); notice=label(L"",12); content.Children().Append(status); content.Children().Append(error); content.Children().Append(notice);
        auto scroller=scroll(content); scroller.MaxHeight(560); dialog.Content(scroller);
        dialog.PrimaryButtonClick([weak](auto const&,ContentDialogButtonClickEventArgs const& args) { args.Cancel(true); if (auto pane=weak.lock()) runFolderSync(pane,SyncAction::save); });
        dialog.SecondaryButtonClick([weak](auto const&,ContentDialogButtonClickEventArgs const& args) { args.Cancel(true); if (auto pane=weak.lock()) { pane->selection.discard(); pane->enabled(); } });
        dialog.Closing([weak](auto const&,ContentDialogClosingEventArgs const& args) {
            if (auto pane=weak.lock(); pane && !pane->closed && (pane->busy || pane->selection.dirty())) {
                args.Cancel(true); pane->error.Text(pane->busy ? L"Wait for this operation to finish before closing." : L"Save or discard the unsaved selection before closing.");
            }
        });
        renderRows();
    }
};
// State is a by-value coroutine parameter: button handler closure lifetimes never
// own a suspended network operation, including a dialog closed by invalidation.
IAsyncAction runFolderSync(std::shared_ptr<FolderSyncPane> pane, SyncAction action, std::wstring row) {
    if (!pane->current() || pane->busy || (action != SyncAction::save && pane->selection.dirty())) co_return;
    if (!pane->freshSnapshot()) { pane->stale=true; pane->error.Text(L"This mailbox connection or saved selection changed. Discard unsaved changes, then reload and review the folder selection."); pane->enabled(); }
    if ((action == SyncAction::save && (!pane->selection.canSave() || pane->stale))
        || (action == SyncAction::retry && (!pane->selection.canRetry(row) || pane->stale))
        || (action == SyncAction::sync && (!pane->selection.canSync() || pane->stale || pane->shell->syncing))) co_return;
    auto owner=hstring(pane->selection.owner); auto ticket=++pane->operation;
    auto observed=syncVersions(object(object(pane->shell->state,L"serverFolderSync"),owner.c_str()));
    pane->busy=true; pane->error.Text(L""); pane->notice.Text(L""); pane->enabled();
    auto current=[pane,ticket] { return pane->current() && pane->operation==ticket; };
    auto verifyVersions=[pane,owner,observed](FolderSyncVersions const* response=nullptr) {
        auto latest=syncVersions(object(object(pane->shell->state,L"serverFolderSync"),owner.c_str()));
        if (!folderSyncVersionsCurrent(observed,latest,response)) {
            pane->stale=true;
            throw hresult_error(E_FAIL,L"This mailbox connection or saved selection changed. Discard unsaved changes, then reload and review the folder selection.");
        }
    };
    try {
        verifyVersions();
        Json next;
        if (action == SyncAction::catalog) {
            co_await pane->shell->service->request(L"/mail/folders/manage",owner);
            if (!current()) co_return;
            verifyVersions();
            next=co_await pane->shell->service->request(L"/mail/folders/sync",owner);
        } else if (action == SyncAction::save) next=co_await pane->shell->service->request(L"/mail/folders/sync",owner,L"PUT",selectionPayload(pane->selection));
        else if (action == SyncAction::retry) next=co_await pane->shell->service->request(L"/mail/folders/sync/retry",owner,L"POST",retryPayload(pane->selection,row));
        else if (action == SyncAction::sync) {
            co_await pane->shell->service->request(L"/sync",owner,L"POST",syncPayload(pane->selection));
            if (!current()) co_return;
            verifyVersions();
            next=co_await pane->shell->service->request(L"/mail/folders/sync",owner);
        } else next=co_await pane->shell->service->request(L"/mail/folders/sync",owner);
        if (!current()) co_return;
        auto returned=syncVersions(next); verifyVersions(&returned);
        auto snapshot=syncSnapshot(next);
        if (!(action == SyncAction::save ? pane->selection.saved(snapshot) : pane->selection.adopt(snapshot))) throw hresult_error(E_FAIL,L"The saved folder selection owner changed. Reload and review it before continuing.");
        auto statuses=object(pane->shell->state,L"serverFolderSync"); statuses.Insert(owner,next); pane->shell->state.Insert(L"serverFolderSync",statuses);
        pane->stale=false;
        if (action==SyncAction::save) pane->notice.Text(L"Selection saved locally. A later mailbox sync can download these folders; use Sync this mailbox now to request a sync.");
        if (action==SyncAction::retry) pane->notice.Text(L"Retry is allowed on a later mailbox sync. No messages were downloaded by this action.");
        if (action==SyncAction::sync) pane->notice.Text(L"Mailbox sync finished. The folder status reports each bounded check; errors and older history may remain.");
    } catch (...) {
        if (!current()) co_return;
        auto message=errorText();
        if (action==SyncAction::save || action==SyncAction::retry || action==SyncAction::sync) { pane->stale=true; message=message+L" Discard unsaved changes if needed, then reload saved status before another action."; }
        pane->error.Text(message);
    }
    if (current()) { pane->busy=false; pane->renderRows(); }
}
DispatcherTimer folderSyncMonitor(std::shared_ptr<FolderSyncPane> const& pane) {
    DispatcherTimer monitor; monitor.Interval(std::chrono::milliseconds(250));
    monitor.Tick([weak=std::weak_ptr<FolderSyncPane>(pane)](auto const&,auto const&) {
        if (auto value=weak.lock(); value && !value->current()) { value->closed=true; ++value->operation; value->dialog.Hide(); }
    });
    return monitor;
}
IAsyncAction waitFolderSyncControl(std::function<bool()> ready) {
    apartment_context ui; auto deadline=GetTickCount64()+5000;
    while (!ready() && GetTickCount64()<deadline) { co_await resume_after(std::chrono::milliseconds(10)); co_await ui; }
}
IAsyncAction displayFolderSync(std::shared_ptr<FolderSyncPane> pane) {
    pane->shell->dialogOpen=true;
    auto monitor=folderSyncMonitor(pane);
    try {
        pane->build(); monitor.Start();
        auto showing=pane->dialog.ShowAsync(); runFolderSync(pane,SyncAction::reload); co_await showing;
    } catch (...) { if (pane->current()) pane->shell->error(errorText()); }
    monitor.Stop(); pane->closed=true; ++pane->operation; pane->shell->dirty.erase(pane->dirtyKey()); pane->shell->dialogOpen=false;
}
}
IAsyncAction Shell::manageFolderSync(hstring account) {
    auto self=shared_from_this();
    if (closing || dialogOpen || loading || navigationLocked || !dirty.empty() || !service || service->writing() || !connected(account)) co_return;
    for (auto const& item : array(state,L"accounts")) if (text(item.GetObject(),L"id")==account) {
        auto provider=text(item.GetObject(),L"provider"); if (!provider.empty() && provider!=L"imap") co_return;
    }
    auto pane=std::make_shared<FolderSyncPane>(self,account);
    try { auto cached=object(object(state,L"serverFolderSync"),account.c_str()); if (cached.Size()) pane->selection.adopt(syncSnapshot(cached)); } catch (...) { /* The local GET reports invalid/missing cached state. */ }
    co_await displayFolderSync(pane);
}

IAsyncAction folderSyncChecks(Grid root) {
    apartment_context ui;
    auto check=[](bool value,wchar_t const* message) { if (!value) throw hresult_error(E_FAIL,message); };
    FolderSyncVersions oldVersions{L"connection-1",L"selection-1"}, nextSelection{L"connection-1",L"selection-2"}, nextConnection{L"connection-2",L"selection-1"};
    check(folderSyncVersionsCurrent(oldVersions,oldVersions),L"An unchanged folder context was rejected.");
    check(!folderSyncVersionsCurrent(oldVersions,nextSelection) && !folderSyncVersionsCurrent(oldVersions,nextConnection),L"A changed saved version reached a new request.");
    check(!folderSyncVersionsCurrent(oldVersions,nextSelection,&oldVersions) && !folderSyncVersionsCurrent(oldVersions,nextConnection,&oldVersions),L"A late folder response could overwrite newer saved versions.");
    check(folderSyncVersionsCurrent(oldVersions,oldVersions,&nextSelection) && folderSyncVersionsCurrent(oldVersions,nextSelection,&nextSelection),L"The same saved response already seen by a state refresh was rejected.");
    auto value=Json::Parse(LR"({"accountId":"folder-fixture@example.invalid","supported":true,"connectionVersion":"connection-one","selectionVersion":"selection-one","catalogFresh":true,"automaticSyncEnabled":false,"intervalMinutes":0,"folders":[{"folderId":"Projects","name":"Projects","selectionId":"saved-projects","selected":true,"available":true,"status":"retry","recoveryAction":"retry","error":"The mail server could not be reached. Try again later.","lastAttemptAt":"2026-10-15T09:00:00Z","coverageWarning":"The initial recent-page scan reached its limit. Use history import to download the remaining older mail."},{"folderId":"Projects / 中文","name":"Projects / 中文","selected":false,"available":true,"status":"unselected"}]})");
    auto snapshot=syncSnapshot(value); FolderSyncSelection editor(snapshot.owner);
    check(editor.adopt(snapshot) && editor.canSync() && !editor.canSave(),L"Saved folder selection was not adopted.");
    editor.select(L"Projects / 中文",true);
    check(editor.dirty() && editor.canSave() && !editor.canSync() && !editor.canRetry(L"Projects"),L"Unsaved folder edits did not block sync/retry.");
    auto body=selectionPayload(editor);
    check(array(body,L"folderIds").Size()==2 && text(body,L"connectionVersion")==snapshot.connection && text(body,L"selectionVersion")==snapshot.version,L"Folder save payload lost reviewed versions or selections.");
    auto replacement=snapshot; replacement.version=L"selection-two";
    check(!editor.adopt(replacement) && editor.snapshot.version==L"selection-one",L"A stale reload overwrote unsaved folder edits.");
    editor.discard(); check(editor.adopt(replacement),L"Explicitly discarded changes could not reload.");
    replacement.owner=L"other@example.invalid";
    check(!editor.saved(replacement),L"Duplicate folder paths crossed mailbox ownership.");
    auto stale=snapshot; stale.fresh=false; stale.rows.at(L"Projects").available=false;
    check(editor.saved(stale),L"Unavailable selected folder was not retained."); editor.deselectAll();
    check(editor.canSave() && array(selectionPayload(editor),L"folderIds").Size()==0,L"Stale catalogs prevented cancelling all folder selections.");
    auto crowded=snapshot; crowded.rows.clear();
    for (unsigned i=0;i<21;++i) { FolderSyncRow row; row.id=L"Folder "+std::to_wstring(i); row.name=row.id; row.available=true; crowded.rows.emplace(row.id,row); }
    check(editor.saved(crowded),L"Folder limit fixture was invalid."); for (auto const& [id,_]:crowded.rows) editor.select(id,true);
    check(editor.selected.size()==20 && editor.canSave(),L"More than twenty selected folders were admitted.");
    auto reset=snapshot; reset.rows.at(L"Projects").recovery=L"reselect"; check(editor.saved(reset),L"Rebaseline fixture was invalid.");
    check(!editor.dirty() && editor.needsBaseline() && !editor.canSave() && !editor.canSync(),L"A new baseline was not explicitly reviewed.");
    editor.reviewedBaseline=true; check(editor.canSave(),L"Unchanged paths could not be explicitly rebound.");
    editor.select(L"Projects / 中文",true); check(!editor.reviewedBaseline && !editor.canSave(),L"Selection changes retained a stale baseline confirmation.");
    check(editor.saved(snapshot),L"Retry fixture was invalid.");
    auto retry=retryPayload(editor,L"Projects"), syncBody=syncPayload(editor);
    check(text(retry,L"selectionId")==L"saved-projects" && text(retry,L"connectionVersion")==snapshot.connection
        && text(syncBody,L"folderSyncSelectionVersion")==snapshot.version && text(syncBody,L"folderSyncConnectionVersion")==snapshot.connection,L"Retry/sync did not retain exact saved identities.");
    auto times=syncTimes(snapshot.rows.at(L"Projects"));
    check(std::wstring_view(times).find(L"Last successful check: Not recorded")!=std::wstring_view::npos
        && std::wstring_view(times).find(L"Last caught up: Not recorded")!=std::wstring_view::npos,L"A catalog or attempt timestamp became a successful sync timestamp.");
    auto unknown=snapshot.rows.at(L"Projects"); unknown.status=L"unexpected"; check(folderSyncStatus(unknown)==L"Status not recorded",L"Unknown status was reported as complete.");
    bool rejected=false; auto duplicate=Json::Parse(value.Stringify()); auto duplicateRows=array(duplicate,L"folders"); duplicateRows.Append(duplicateRows.GetAt(0)); duplicate.Insert(L"folders",duplicateRows);
    try { (void)syncSnapshot(duplicate); } catch (...) { rejected=true; } check(rejected,L"Duplicate folder rows were accepted.");

    // A synthetic shell has no Service: these native controls cannot perform
    // provider work. Only checkbox/filter/close events are exercised below.
    auto shell=std::make_shared<Shell>(); shell->root=root; shell->owner=L"other@example.invalid"; shell->generation=8;
    shell->state=Json::Parse(LR"({"accounts":[{"id":"folder-fixture@example.invalid","provider":"imap","settings":{"configured":true}},{"id":"other@example.invalid","provider":"imap","settings":{"configured":true}}]})");
    auto pane=std::make_shared<FolderSyncPane>(shell,hstring(snapshot.owner)); check(pane->selection.adopt(snapshot),L"Native folder fixture did not adopt snapshot."); pane->build();
    check(pane->current(),L"The displayed mailbox's folder settings were rejected from a different selected view.");
    auto accounts=array(shell->state,L"accounts"); auto changed=Json::Parse(accounts.GetAt(0).Stringify()); put(changed,L"settings",L"invalid");
    accounts.SetAt(0,changed); shell->state.Insert(L"accounts",accounts); check(!pane->current(),L"A reconnected mailbox retained an old editor context.");
    accounts.SetAt(0,Json::Parse(LR"({"id":"folder-fixture@example.invalid","provider":"imap","settings":{"configured":true}})")); shell->state.Insert(L"accounts",accounts);
    shell->owner=L"folder-fixture@example.invalid"; check(!pane->current(),L"A changed page owner retained a stale folder context."); shell->owner=L"other@example.invalid";
    Array disconnected; disconnected.Append(accounts.GetAt(1)); shell->state.Insert(L"accounts",disconnected); check(!pane->current(),L"A disconnected mailbox retained an editor context."); shell->state.Insert(L"accounts",accounts);
    bool opened=false; auto openedToken=pane->dialog.Opened([&opened](auto const&,auto const&) { opened=true; });
    auto showing=pane->dialog.ShowAsync(); auto monitor=folderSyncMonitor(pane); monitor.Start();
    try {
        // Opened can precede loading the TextBox. Input must reach the mounted
        // control within the same initial deadline before observing its event.
        auto filterReady=[pane,&opened] { return opened && pane->filter.IsLoaded() && pane->filter.ActualWidth()>0 && pane->filter.ActualHeight()>0 && pane->filter.IsEnabled(); };
        auto deadline=GetTickCount64()+5000;
        while(!filterReady() && GetTickCount64()<deadline) { co_await resume_after(std::chrono::milliseconds(10)); co_await ui; }
        check(filterReady(),L"The native selected-folder filter did not mount and become editable.");
        auto checkbox=pane->checks.at(1).second;
        auto peer=Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(checkbox);
        peer.GetPattern(Automation::Peers::PatternInterface::Toggle).as<Automation::Provider::IToggleProvider>().Toggle();
        co_await waitFolderSyncControl([pane] { return pane->selection.selected.contains(L"Projects / 中文"); });
        check(pane->selection.selected.contains(L"Projects / 中文") && pane->selection.dirty() && pane->dialog.IsPrimaryButtonEnabled() && !pane->sync.IsEnabled() && !pane->catalog.IsEnabled(),L"Native checkbox events lost edits or allowed work before saving.");
        auto controlsBefore=pane->checks.size(), selectedBefore=pane->selection.selected.size();
        // Observe this fixture's real event without changing production handlers,
        // rendering, input delivery or the existing filter deadline. Configuring
        // is sampled at this observer, not proof of the earlier handler's branch.
        struct FilterEvents { unsigned delivered=0, configuring=0, expired=0, otherSender=0; bool overflow=false, failed=false; };
        auto events=std::make_shared<FilterEvents>(); auto rowGenerationBefore=pane->rowGeneration;
        auto loadedBefore=pane->filter.IsLoaded(), widthBefore=pane->filter.ActualWidth()>0, heightBefore=pane->filter.ActualHeight()>0;
        auto filterChanged=pane->filter.TextChanged(auto_revoke,[weak=std::weak_ptr<FolderSyncPane>(pane),events](auto const& sender,auto const&) {
            auto increment=[events](unsigned& count) { if(count<16)++count; else events->overflow=true; };
            increment(events->delivered);
            try {
                auto current=weak.lock(); if(!current){increment(events->expired);return;}
                if(sender.template try_as<TextBox>()!=current->filter)increment(events->otherSender);
                if(current->configuring)increment(events->configuring);
            } catch (...) { events->failed=true; }
        });
        auto counts=[pane,controlsBefore,selectedBefore,events,rowGenerationBefore,loadedBefore,widthBefore,heightBefore](wchar_t const* message) {
            auto diagnostic=hstring(L" [filter receipt unavailable]");
            try {
                auto query=pane->filter.Text(); unsigned matches=0;
                for(auto const& [_,row]:pane->selection.snapshot.rows) {
                    if(query.empty() || FindStringOrdinal(FIND_FROMSTART,row.name.c_str(),static_cast<int>(row.name.size()),query.c_str(),static_cast<int>(query.size()),TRUE)>=0)++matches;
                }
                diagnostic=L" [filter delivered="+to_hstring(events->delivered)+L", configuringAtObserver="+to_hstring(events->configuring)
                    +L", expired="+to_hstring(events->expired)+L", otherSender="+to_hstring(events->otherSender)
                    +L", overflow="+to_hstring(events->overflow)+L", observerFailed="+to_hstring(events->failed)
                    +L", rowGeneration="+to_hstring(rowGenerationBefore)+L"->"+to_hstring(pane->rowGeneration)
                    +L", configuring="+to_hstring(pane->configuring)+L", current="+to_hstring(pane->current())+L", enabled="+to_hstring(pane->filter.IsEnabled())
                    +L", loaded="+to_hstring(loadedBefore)+L"->"+to_hstring(pane->filter.IsLoaded())
                    +L", widthPositive="+to_hstring(widthBefore)+L"->"+to_hstring(pane->filter.ActualWidth()>0)
                    +L", heightPositive="+to_hstring(heightBefore)+L"->"+to_hstring(pane->filter.ActualHeight()>0)
                    +L", queryLength="+to_hstring(std::min<uint32_t>(query.size(),512))+L", queryLengthCapped="+to_hstring(query.size()>512)
                    +L", exactFixtureQuery="+to_hstring(query==L"no match")+L", matchingRows="+to_hstring(std::min(matches,2u))+L", matchesCapped="+to_hstring(matches>2)+L"]";
            } catch (...) { /* Diagnostic reads must not replace the original assertion. */ }
            return hstring(message) + L" [before controls=" + to_hstring(controlsBefore) + L", selected=" + to_hstring(selectedBefore)
                + L"; after controls=" + to_hstring(pane->checks.size()) + L", selected=" + to_hstring(pane->selection.selected.size()) + L"]" + diagnostic;
        };
        check(controlsBefore==2 && selectedBefore==2,counts(L"The native folder selection was incomplete before filtering.").c_str());
        auto reviewedSelection=pane->selection.selected;
        pane->filter.Text(L"no match"); co_await waitFolderSyncControl([pane] { return pane->checks.empty(); });
        check(pane->checks.empty() && pane->selection.selected.size()==2,counts(L"Filtering discarded the native folder selection.").c_str());
        check(events->delivered>0,counts(L"The mounted folder filter did not deliver TextChanged.").c_str());
        // Exercise the actual event on a retained old control, first with no
        // visible rows and then with a replacement control for the same folder.
        auto uncheckedEvents=std::make_shared<unsigned>(0);
        auto unchecked=checkbox.Unchecked(auto_revoke,[uncheckedEvents](auto const&,auto const&) { if (*uncheckedEvents<4) ++*uncheckedEvents; });
        checkbox.IsChecked(true); checkbox.IsChecked(false);
        co_await waitFolderSyncControl([uncheckedEvents] { return *uncheckedEvents>0; });
        check(*uncheckedEvents>0 && !checkbox.IsChecked().Value() && pane->checks.empty() && pane->selection.selected==reviewedSelection,
            counts(L"A detached folder checkbox changed the filtered selection.").c_str());
        pane->filter.Text(L""); co_await waitFolderSyncControl([pane] { return pane->checks.size()==2; });
        check(pane->checks.size()==2,L"Clearing the filter did not restore folder controls.");
        check(pane->checks.at(1).second!=checkbox && pane->selection.selected==reviewedSelection,
            counts(L"Clearing the filter reused a detached checkbox or lost the selection.").c_str());
        auto eventsBefore=*uncheckedEvents;
        checkbox.IsChecked(true); checkbox.IsChecked(false);
        co_await waitFolderSyncControl([uncheckedEvents,eventsBefore] { return *uncheckedEvents>eventsBefore; });
        check(*uncheckedEvents>eventsBefore && !checkbox.IsChecked().Value() && pane->checks.size()==2
            && pane->checks.at(1).second.IsChecked().Value() && pane->selection.selected==reviewedSelection,
            counts(L"A detached folder checkbox changed its replacement row.").c_str());
        pane->dialog.Hide(); co_await resume_after(std::chrono::milliseconds(50)); co_await ui;
        check(showing.Status()==AsyncStatus::Started,L"Closing discarded unsaved folder selection without a decision.");
        pane->busy=true; pane->enabled(); check(!pane->dialog.IsPrimaryButtonEnabled() && !pane->reload.IsEnabled() && !pane->deselect.IsEnabled(),L"Busy folder actions remained interactive.");
        pane->busy=false; pane->selection.discard(); pane->enabled();
        ++shell->generation; deadline=GetTickCount64()+5000;
        while(showing.Status()==AsyncStatus::Started && GetTickCount64()<deadline) { co_await resume_after(std::chrono::milliseconds(10)); co_await ui; }
        check(pane->closed && showing.Status()==AsyncStatus::Completed,L"A stale page retained a visible folder dialog."); co_await showing;
    } catch (...) { monitor.Stop(); pane->closed=true; pane->dialog.Hide(); pane->dialog.Opened(openedToken); shell->dirty.erase(pane->dirtyKey()); throw; }
    monitor.Stop(); pane->dialog.Opened(openedToken); shell->dirty.erase(pane->dirtyKey());
}
}
