#include "pch.h"
#include "Ui.h"
#include "MoveRecoveryState.h"
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Provider.h>

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
using namespace Windows::Data::Json;
using namespace Microsoft::UI::Xaml;
using namespace Microsoft::UI::Xaml::Controls;
namespace {
Json copy(Json const& value) { return Json::Parse(value.Stringify()); }
bool stringField(Json const& value, wchar_t const* key, size_t limit = 8192) {
    auto entry = value.TryLookup(key);
    return entry && entry.ValueType() == JsonValueType::String && entry.GetString().size() <= limit;
}
bool booleanField(Json const& value, wchar_t const* key) {
    auto entry = value.TryLookup(key);
    return entry && entry.ValueType() == JsonValueType::Boolean;
}
bool validOperation(Json const& value, hstring const& owner) {
    if (owner.empty() || owner == L"all" || text(value,L"accountId") != owner || !moveRecoveryStatusValid(text(value,L"status"))) return false;
    for (auto field : {L"id",L"accountId",L"connectionRef",L"operationRef",L"messageId",L"subject",L"sourceName",L"targetName",L"stage",L"status",L"diagnosticCode",L"diagnostic"})
        if (!stringField(value,field)) return false;
    for (auto field : {L"id",L"connectionRef",L"operationRef",L"messageId"})
        if (text(value,field).empty() || !stringField(value,field,1024)) return false;
    return booleanField(value,L"canPreview") && booleanField(value,L"canResolve");
}
bool validSnapshot(Json const& value, hstring const& owner) {
    auto entries = value.TryLookup(L"operations");
    if (text(value,L"accountId") != owner || text(value,L"connectionRef").empty() || !stringField(value,L"connectionRef",1024)
        || !entries || entries.ValueType() != JsonValueType::Array || entries.GetArray().Size() > 120) return false;
    std::set<std::wstring> ids;
    for (auto const& entry : entries.GetArray()) {
        if (entry.ValueType() != JsonValueType::Object || !validOperation(entry.GetObject(),owner)
            || !ids.insert(std::wstring(text(entry.GetObject(),L"id"))).second) return false;
    }
    return true;
}
hstring connectionRef(Json const& settings) {
    return stringField(settings,L"moveConnectionRef",1024) ? text(settings,L"moveConnectionRef") : hstring{};
}
hstring connection(Shell const& shell, hstring const& account) {
    for (auto const& entry : array(shell.state,L"accounts")) if (text(entry.GetObject(),L"id") == account)
        return connectionRef(object(entry.GetObject(),L"settings"));
    return {};
}
hstring statusName(Json const& value) {
    auto status = text(value,L"status");
    if (status == L"uncertain") return L"Result uncertain";
    if (status == L"partial") return L"Partially completed";
    if (status == L"providerComplete") return L"Provider move confirmed; local update pending";
    if (status == L"completed") return L"Move completed";
    if (status == L"resolved") return L"Marked resolved by you";
    return L"Status unavailable";
}
hstring recorded(Json const& value, wchar_t const* field) {
    return text(value,field).empty() ? hstring(L"Not recorded") : mailDateLabel(text(value,field));
}
Json findOperation(Json const& value, hstring const& id) {
    for (auto const& entry : array(value,L"operations")) if (text(entry.GetObject(),L"id") == id) return copy(entry.GetObject());
    return Json();
}
MoveRecoveryReviewKey reviewKey(Json const& value) {
    return {std::wstring(text(value,L"accountId")),std::wstring(text(value,L"id")),std::wstring(text(value,L"operationRef")),std::wstring(text(value,L"connectionRef"))};
}
bool finishAllowed(Json const& value, hstring const& owner, hstring const& currentConnection) {
    return validOperation(value,owner) && moveRecoveryFinishAllowed(owner,text(value,L"accountId"),currentConnection,
        text(value,L"connectionRef"),text(value,L"status"),text(value,L"operationRef"),text(value,L"reviewRef"),text(value,L"finishAction"),flag(value,L"canFinish"));
}
hstring confirmation(Json const& value, hstring const& owner, hstring const& action) {
    auto facts = L"Mailbox: " + owner + L"\nSubject: " + text(value,L"subject") + L"\nFrom folder: " + text(value,L"sourceName")
        + L"\nTo folder: " + text(value,L"targetName") + L"\n\n" + text(value,L"diagnostic");
    if (action == L"resolve") return facts + L"\n\nConfirm only after reviewing and resolving this move in your mail provider. This records your decision locally. It does not move, delete, copy or verify mail at the provider.";
    if (action == L"completeMove") return facts + L"\n\nThe checked destination copy is present. Morrow will recheck both folders, then remove only this original message from the source folder and update its local location. It will not copy the message again.";
    return facts + L"\n\nThe provider move was checked. Morrow will recheck the saved source and destination identities, then apply the confirmed location locally. It will not copy or delete mail.";
}
struct RecoveryDialog {
    ContentDialog dialog;
    hstring action, selected;
    bool configuring = true;
    Button preview{nullptr}, finish{nullptr}, resolve{nullptr};
    void choose(hstring value) { action = value; dialog.Hide(); }
};
std::shared_ptr<RecoveryDialog> recoveryDialog(XamlRoot root, Json const& snapshot, Json const& operation, hstring const& account, hstring const& selectedID, bool checked, hstring const& notice) {
    auto panel = std::make_shared<RecoveryDialog>(); std::weak_ptr<RecoveryDialog> weak = panel;
    panel->selected = selectedID;
    auto content = stack(12); content.Children().Append(label(account));
    content.Children().Append(label(L"Saved move records. Opening or refreshing this view reads only local records. No move is retried automatically.",12));
    ComboBox choices; choices.Header(box_value(L"Saved moves")); choices.HorizontalAlignment(HorizontalAlignment::Stretch);
    int selectedIndex = -1;
    for (auto const& entry : array(snapshot,L"operations")) {
        auto item = entry.GetObject(); ComboBoxItem row; row.Content(label(text(item,L"subject",L"(No subject)") + L" · " + statusName(item),13,false)); row.Tag(box_value(text(item,L"id"))); choices.Items().Append(row);
        if (text(item,L"id") == selectedID) selectedIndex = static_cast<int>(choices.Items().Size()) - 1;
    }
    choices.SelectedIndex(selectedIndex); content.Children().Append(choices);
    choices.SelectionChanged([weak,weakChoices=make_weak(choices)](auto const&,auto const&) {
        if (auto panel = weak.lock(); panel && !panel->configuring) if (auto control = weakChoices.get(); control && control.SelectedItem()) {
            auto next = unbox_value<hstring>(control.SelectedItem().as<ComboBoxItem>().Tag());
            if (next != panel->selected) { panel->selected = next; panel->choose(L"select"); }
        }
    });
    if (operation.Size()) {
        content.Children().Append(label(text(operation,L"subject",L"(No subject)"),18));
        content.Children().Append(label(statusName(operation)));
        if (moveRecoveryIsOpen(text(operation,L"status")))
            content.Children().Append(label(L"This multi-step move is not atomic. An interruption can leave two copies or an unconfirmed source removal.",13));
        content.Children().Append(label(L"From folder: " + text(operation,L"sourceName") + L"\nTo folder: " + text(operation,L"targetName")));
        content.Children().Append(label(L"Created: " + recorded(operation,L"createdAt") + L"\nUpdated: " + recorded(operation,L"updatedAt"),12));
        content.Children().Append(label(text(operation,L"diagnostic")));
        bool sameConnection = text(operation,L"connectionRef") == text(snapshot,L"connectionRef");
        if (!sameConnection) content.Children().Append(label(L"The saved move belongs to a previous connection. Automatic completion is unavailable. Review the original mailbox at your provider.",12));
        if (moveRecoveryIsOpen(text(operation,L"status")) && flag(operation,L"canPreview") && sameConnection) {
            auto preview = button(L"Check provider — read only",[weak] { if (auto panel = weak.lock()) panel->choose(L"preview"); });
            Automation::AutomationProperties::SetAutomationId(preview,L"moveRecovery.preview"); panel->preview = preview; content.Children().Append(preview);
            content.Children().Append(label(L"Connects to the provider to check this saved source and destination. It does not copy or delete mail.",12));
        }
        if (checked && finishAllowed(operation,account,text(snapshot,L"connectionRef"))) {
            auto finish = button(text(operation,L"finishAction") == L"completeMove" ? L"Finish checked move…" : L"Apply checked location…",[weak] { if (auto panel = weak.lock()) panel->choose(L"finish"); });
            Automation::AutomationProperties::SetAutomationId(finish,L"moveRecovery.finish"); panel->finish = finish; content.Children().Append(finish);
            content.Children().Append(label(L"This check expires after five minutes. Finishing rechecks the exact source and destination.",12));
        }
        if (moveRecoveryIsOpen(text(operation,L"status")) && flag(operation,L"canResolve")) {
            auto resolve = button(L"I resolved this in my provider…",[weak] { if (auto panel = weak.lock()) panel->choose(L"resolve"); });
            Automation::AutomationProperties::SetAutomationId(resolve,L"moveRecovery.resolve"); panel->resolve = resolve; content.Children().Append(resolve);
        }
        if (text(operation,L"status") == L"resolved") content.Children().Append(label(L"This is your local resolution record, not a new provider confirmation.",12));
    } else content.Children().Append(label(selectedID.empty() ? L"No saved IMAP moves to review." : L"This saved move is no longer available. Refresh local records or review the original mailbox at your provider."));
    if (!notice.empty()) content.Children().Append(label(notice,12));
    content.Children().Append(button(L"Refresh local records",[weak] { if (auto panel = weak.lock()) panel->choose(L"refresh"); }));
    auto body = scroll(content); body.MaxHeight(520);
    panel->dialog.XamlRoot(root); panel->dialog.Title(box_value(L"Review IMAP moves")); panel->dialog.Content(body); panel->dialog.CloseButtonText(L"Done");
    panel->dialog.Resources().Insert(box_value(L"ContentDialogMaxWidth"),box_value(680.0)); panel->configuring = false;
    return panel;
}
// A recovery view owns navigation across its local read, review and provider
// request. No callback captures a coroutine closure or mutates a replacement page.
struct RecoveryNavigation {
    Shell& shell;
    bool held = true;
    explicit RecoveryNavigation(Shell& value) : shell(value) { shell.navigationLocked = true; }
    RecoveryNavigation(RecoveryNavigation const&) = delete;
    RecoveryNavigation& operator=(RecoveryNavigation const&) = delete;
    void release() { if (held) { shell.navigationLocked = false; held = false; } }
    ~RecoveryNavigation() { release(); }
};
struct RecoveryLoading {
    Shell& shell;
    uint64_t ticket;
    explicit RecoveryLoading(Shell& value) : shell(value), ticket(++value.mailLoadTicket) { shell.loading = true; shell.dialogOpen = true; }
    RecoveryLoading(RecoveryLoading const&) = delete;
    RecoveryLoading& operator=(RecoveryLoading const&) = delete;
    ~RecoveryLoading() { if (shell.mailLoadTicket == ticket) { shell.loading = false; shell.dialogOpen = false; } }
};
}

bool Shell::canReviewMoves(hstring const& account) const {
    if (account.empty() || account == L"all") return false;
    for (auto const& entry : array(state,L"accounts")) if (text(entry.GetObject(),L"id") == account) {
        auto provider = text(entry.GetObject(),L"provider"); return (provider.empty() || provider == L"imap") && !connection(*this,account).empty();
    }
    return false;
}
hstring unresolvedMoveOperation(Json const& payload, hstring const& owner) {
    auto id = text(payload,L"operationId");
    return !owner.empty() && owner != L"all" && text(payload,L"accountId") == owner
        && text(payload,L"code") == L"imap_move_unresolved" && !id.empty() && id.size() <= 1024 ? id : hstring{};
}

IAsyncAction Shell::reviewMoves(hstring account, hstring initialOperation) {
    auto lifetime = shared_from_this();
    if (closing || dialogOpen || navigationLocked || loading || !service || service->writing() || !dirty.empty() || !canReviewMoves(account)) co_return;
    auto captured = MoveRecoveryScope{std::wstring(account),std::wstring(owner),std::wstring(connection(*this,account)),generation};
    auto valid = [&] { return !closing && connected(account) && captured.accepts(MoveRecoveryScope{std::wstring(account),std::wstring(owner),std::wstring(connection(*this,account)),generation}); };
    RecoveryNavigation navigation(*this);
    Json snapshot, reviewed;
    hstring selectedID = initialOperation, notice;
    bool refresh = true, changed = false;
    try {
        while (valid()) {
            if (refresh) {
                reviewed = Json(); refresh = false;
                RecoveryLoading pending(*this);
                try {
                    auto next = co_await service->request(L"/mail/moves",account);
                    if (!valid()) co_return;
                    if (!validSnapshot(next,account) || std::wstring(text(next,L"connectionRef")) != captured.connection) throw hresult_error(E_FAIL,L"The saved move records could not be verified for this mailbox connection. Close this review and reopen it after refreshing the account.");
                    snapshot = copy(next);
                    if (selectedID.empty() && array(snapshot,L"operations").Size()) selectedID = text(array(snapshot,L"operations").GetAt(0).GetObject(),L"id");
                } catch (...) { if (!valid()) co_return; snapshot = Json(); notice = errorText(); }
            }
            auto saved = findOperation(snapshot,selectedID);
            bool checked = validOperation(reviewed,account) && text(reviewed,L"id") == selectedID && reviewKey(reviewed).matches(reviewKey(saved));
            auto operation = checked ? copy(reviewed) : saved;
            auto panel = recoveryDialog(root.XamlRoot(),snapshot,operation,account,selectedID,checked,notice);
            dialogOpen = true;
            try { co_await panel->dialog.ShowAsync(); } catch (...) { dialogOpen = false; throw; }
            dialogOpen = false;
            if (!valid()) co_return;
            auto action = panel->action;
            if (action.empty()) break;
            if (action == L"select") { selectedID = panel->selected; reviewed = Json(); notice = {}; continue; }
            if (action == L"refresh") { refresh = true; notice = {}; continue; }
            if (!validOperation(operation,account) || !moveRecoveryIsOpen(text(operation,L"status")) || std::wstring(text(snapshot,L"connectionRef")) != captured.connection) co_return;
            Json input; put(input,L"operationRef",text(operation,L"operationRef"));
            if (action == L"preview") {
                if (!flag(operation,L"canPreview") || text(operation,L"connectionRef") != text(snapshot,L"connectionRef")) co_return;
            } else if (action == L"finish") {
                if (!checked || !finishAllowed(operation,account,text(snapshot,L"connectionRef"))) co_return;
                auto kind = text(operation,L"finishAction");
                if (!(co_await confirm(kind == L"completeMove" ? L"Finish this checked move?" : L"Apply this checked location?",confirmation(operation,account,kind),kind == L"completeMove" ? L"Finish checked move" : L"Apply checked location"))) continue;
                input.Insert(L"confirmed",Value::CreateBooleanValue(true)); put(input,L"reviewRef",text(operation,L"reviewRef"));
            } else if (action == L"resolve") {
                if (!flag(operation,L"canResolve")) co_return;
                if (!(co_await confirm(L"Mark this move resolved by you?",confirmation(operation,account,L"resolve"),L"Mark resolved locally"))) continue;
                input.Insert(L"confirmed",Value::CreateBooleanValue(true)); put(input,L"resolution",L"reviewedExternally");
            } else co_return;
            if (!valid()) co_return;
            RecoveryLoading pending(*this);
            try {
                auto response = co_await service->request(L"/mail/moves/" + escaped(selectedID) + L"/" + action,account,L"POST",input);
                if (!valid()) co_return;
                auto next = object(response,L"operation");
                if (text(response,L"accountId") != account || std::wstring(text(response,L"connectionRef")) != captured.connection
                    || text(next,L"id") != selectedID || !validOperation(next,account)) throw hresult_error(E_FAIL,L"The move result could not be verified. Refresh local records before continuing.");
                if (action == L"finish" && text(next,L"status") != L"completed") throw hresult_error(E_FAIL,L"Completion was not confirmed. Refresh local records before another check.");
                if (action == L"resolve" && text(next,L"status") != L"resolved") throw hresult_error(E_FAIL,L"Your resolution was not recorded. Refresh local records before continuing.");
                JsonArray entries; for (auto const& entry : array(snapshot,L"operations")) entries.Append(text(entry.GetObject(),L"id") == selectedID ? copy(next) : copy(entry.GetObject()));
                snapshot.Insert(L"operations",entries); reviewed = action == L"preview" ? copy(next) : Json();
                notice = action == L"preview" ? L"Provider check recorded. Review the result before choosing an action." : action == L"finish" ? L"The checked move and local location are confirmed." : L"Your resolution was recorded locally. No provider change was made.";
                changed = changed || action == L"finish";
            } catch (...) { if (!valid()) co_return; reviewed = Json(); notice = errorText() + L" No action was retried. Refresh local records before continuing."; }
        }
    } catch (...) { if (valid()) error(errorText()); }
    navigation.release();
    if (changed && valid()) {
        for (auto& cursor : cursors) cursor = L"";
        if (section == L"mail") co_await loadPage();
    }
}

IAsyncAction moveRecoveryChecks(Grid host) {
    apartment_context ui;
    auto check = [](bool value) { if (!value) throw hresult_error(E_FAIL,L"IMAP move recovery ownership/review control failed."); };
    auto owner = hstring(L"move@example.invalid");
    auto operation = Json::Parse(LR"({"id":"same-operation","accountId":"move@example.invalid","connectionRef":"connection-a","operationRef":"revision-a","messageId":"same-message","subject":"Fictional partial move 中文","sourceName":"Inbox","targetName":"Work / Customer","stage":"copied","status":"partial","createdAt":"2026-10-15T01:00:00Z","updatedAt":"2026-10-15T02:00:00Z","diagnosticCode":"fixture","diagnostic":"The checked copy exists; the original remains.","canPreview":true,"canResolve":true,"canFinish":true,"reviewRef":"checked-a","finishAction":"completeMove"})");
    Json snapshot; put(snapshot,L"accountId",owner); put(snapshot,L"connectionRef",L"connection-a"); JsonArray entries; entries.Append(copy(operation)); snapshot.Insert(L"operations",entries);
    check(validSnapshot(snapshot,owner)); check(finishAllowed(operation,owner,L"connection-a"));
    for (auto key : {L"accountId",L"connectionRef",L"operationRef",L"messageId",L"id"}) {
        auto invalid = copy(operation); put(invalid,key,L""); check(!validOperation(invalid,owner));
    }
    auto foreign = copy(operation); put(foreign,L"accountId",L"other@example.invalid"); check(!validOperation(foreign,owner)); check(!finishAllowed(foreign,owner,L"connection-a"));
    auto missing = copy(operation); missing.Remove(L"reviewRef"); check(!finishAllowed(missing,owner,L"connection-a"));
    auto replaced = copy(operation); put(replaced,L"operationRef",L"revision-b"); check(!reviewKey(operation).matches(reviewKey(replaced)));
    put(replaced,L"operationRef",L"revision-a"); put(replaced,L"id",L"another-operation"); check(!reviewKey(operation).matches(reviewKey(replaced)));
    auto unknown = copy(operation); put(unknown,L"finishAction",L"copyAgain"); check(!finishAllowed(unknown,owner,L"connection-a"));
    check(!finishAllowed(operation,owner,L"connection-b")); check(!validSnapshot(snapshot,L"other@example.invalid"));
    auto duplicate = copy(snapshot); auto twice = array(duplicate,L"operations"); twice.Append(copy(operation)); check(!validSnapshot(duplicate,owner));
    auto wrongType = copy(operation); put(wrongType,L"canResolve",L"true"); check(!validOperation(wrongType,owner));
    auto removed = findOperation(snapshot,L"removed-operation"); check(!removed.Size());
    MoveRecoveryScope scope{std::wstring(owner),L"all",L"connection-a",12}; check(scope.accepts(scope));
    for (int kind = 0; kind < 4; ++kind) {
        auto next = scope; if (kind == 0) next.owner = L"other@example.invalid"; if (kind == 1) next.viewOwner = std::wstring(owner);
        if (kind == 2) next.connection = L"connection-b"; if (kind == 3) ++next.generation; check(!scope.accepts(next));
    }
    auto invalidOwner = scope; invalidOwner.owner = L"all"; check(!invalidOwner.accepts(invalidOwner));
    auto settings = Json::Parse(LR"({"imapHost":"imap.example.invalid","moveConnectionRef":"connection-a"})");
    auto reconnected = copy(settings); put(reconnected,L"moveConnectionRef",L"connection-b");
    check(text(settings,L"imapHost") == text(reconnected,L"imapHost") && connectionRef(settings) != connectionRef(reconnected));
    auto oldScope = scope; oldScope.connection = std::wstring(connectionRef(settings));
    auto newScope = oldScope; newScope.connection = std::wstring(connectionRef(reconnected)); check(!oldScope.accepts(newScope));
    auto noRef = copy(settings); noRef.Remove(L"moveConnectionRef"); check(connectionRef(noRef).empty());
    noRef.Insert(L"moveConnectionRef",Value::CreateBooleanValue(true)); check(connectionRef(noRef).empty());
    put(noRef,L"moveConnectionRef",hstring(std::wstring(1025,L'x'))); check(connectionRef(noRef).empty());
    auto failure = Json::Parse(LR"({"code":"imap_move_unresolved","accountId":"move@example.invalid","operationId":"same-operation"})");
    check(unresolvedMoveOperation(failure,owner) == L"same-operation"); check(unresolvedMoveOperation(failure,L"other@example.invalid").empty());
    auto partial = recoveryDialog(host.XamlRoot(),snapshot,operation,owner,L"same-operation",true,{});
    check(bool(partial->preview) && bool(partial->finish) && bool(partial->resolve));
    auto unchecked = recoveryDialog(host.XamlRoot(),snapshot,operation,owner,L"same-operation",false,{});
    check(!unchecked->finish && bool(unchecked->preview));
    for (auto status : {L"uncertain",L"providerComplete",L"completed",L"resolved"}) {
        auto changed = copy(operation); put(changed,L"status",status);
        if (std::wstring_view(status) == L"uncertain") { changed.Insert(L"canFinish",Value::CreateBooleanValue(false)); changed.Remove(L"reviewRef"); }
        if (std::wstring_view(status) == L"providerComplete") put(changed,L"finishAction",L"applyConfirmedResult");
        auto panel = recoveryDialog(host.XamlRoot(),snapshot,changed,owner,L"same-operation",true,{});
        check(bool(panel->finish) == (std::wstring_view(status) == L"providerComplete"));
        if (std::wstring_view(status) == L"completed" || std::wstring_view(status) == L"resolved") check(!panel->preview && !panel->resolve);
        if (std::wstring_view(status) == L"resolved") check(statusName(changed) == L"Marked resolved by you");
    }
    auto oldConnection = copy(operation); put(oldConnection,L"connectionRef",L"old-connection");
    auto oldPanel = recoveryDialog(host.XamlRoot(),snapshot,oldConnection,owner,L"same-operation",true,{});
    check(!oldPanel->preview && !oldPanel->finish && bool(oldPanel->resolve));
    check(std::wstring_view(confirmation(operation,owner,L"completeMove")).find(L"not copy the message again") != std::wstring_view::npos);
    check(std::wstring_view(confirmation(operation,owner,L"resolve")).find(L"does not move, delete, copy or verify") != std::wstring_view::npos);
    auto opened = std::make_shared<bool>(false);
    auto openedEvent = partial->dialog.Opened(auto_revoke,[opened](auto const&,auto const&) { *opened = true; });
    auto shown = partial->dialog.ShowAsync();
    struct Dismiss { ContentDialog dialog; ~Dismiss() { try { dialog.Hide(); } catch (...) {} } } dismiss{partial->dialog};
    auto deadline = GetTickCount64() + 5000;
    while (!*opened && GetTickCount64() < deadline) { co_await resume_after(std::chrono::milliseconds(10)); co_await ui; }
    check(*opened && partial->resolve.IsLoaded());
    auto peer = Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(partial->resolve);
    auto invoke = peer.GetPattern(Automation::Peers::PatternInterface::Invoke).as<Automation::Provider::IInvokeProvider>(); invoke.Invoke();
    deadline = GetTickCount64() + 5000;
    while (shown.Status() == AsyncStatus::Started && GetTickCount64() < deadline) { co_await resume_after(std::chrono::milliseconds(10)); co_await ui; }
    check(shown.Status() == AsyncStatus::Completed && partial->action == L"resolve");
    co_await shown;
    // This fixture invokes only the production dialog's selection callback.
    // No Shell/service request is supplied, so it cannot resolve or move mail.
}
}
