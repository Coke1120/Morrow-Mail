// Compiled only by test-windows-attachment-flow.ps1 in its private source copy.
#include "pch.h"
#include "Ui.h"
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Provider.h>
#include <fstream>
#include <cstdio>

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
void attachmentFixtureNavigationHandler(std::shared_ptr<Shell>);
namespace {
std::filesystem::path fixture, selectedPath;
unsigned requests = 0, selections = 0;
bool holdDownload = false, invalidDownload = false;
hstring requestedOwner;
void require(bool value, wchar_t const* message) {
    if (!value) throw hresult_error(E_FAIL, message);
}
std::string contents(std::filesystem::path const& path) {
    std::ifstream file(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}
controls::NavigationViewItem mailboxItem(std::shared_ptr<Shell> const& shell, hstring owner, hstring folder) {
    for (auto const& entry : shell->navigation.MenuItems()) if (auto group = entry.try_as<controls::NavigationViewItem>())
        for (auto const& child : group.MenuItems()) if (auto item = child.try_as<controls::NavigationViewItem>(); item && item.Tag()) {
            auto tag = item.Tag().as<Json>();
            if (text(tag, L"section") == L"mail" && text(tag, L"owner") == owner && text(tag, L"folder") == folder) return item;
        }
    throw hresult_error(E_FAIL, L"Missing mounted fixture mailbox item.");
}
Json sidebarSelection(std::shared_ptr<Shell> const& shell) {
    auto item = shell->navigation.SelectedItem().try_as<controls::NavigationViewItem>();
    require(item && item.Tag(), L"The native sidebar lost its selected item.");
    return item.Tag().as<Json>();
}
IAsyncAction invokeSidebar(std::shared_ptr<Shell> shell, controls::NavigationViewItem item, std::shared_ptr<unsigned> invocations) {
    namespace peers = xaml::Automation::Peers;
    apartment_context ui;
    auto deadline = GetTickCount64() + 1000;
    while (!item.IsLoaded() && GetTickCount64() < deadline) { co_await resume_after(std::chrono::milliseconds(10)); co_await ui; }
    require(item.IsLoaded(), L"The native invocation target was not realized in the mounted sidebar.");
    auto peer = peers::FrameworkElementAutomationPeer::CreatePeerForElement(item);
    auto action = peer.GetPattern(peers::PatternInterface::SelectionItem).try_as<xaml::Automation::Provider::ISelectionItemProvider>();
    require(bool(action), L"The native sidebar item did not expose its selection action.");
    auto expected = *invocations + 1;
    action.Select();
    deadline = GetTickCount64() + 1000;
    while (*invocations < expected && GetTickCount64() < deadline) { co_await resume_after(std::chrono::milliseconds(10)); co_await ui; }
    require(*invocations == expected, L"The native sidebar action did not raise its actual ItemInvoked event.");
    auto drained = std::make_shared<bool>(false);
    require(shell->root.DispatcherQueue().TryEnqueue([drained] { *drained = true; }), L"Could not drain the native invocation queue.");
    deadline = GetTickCount64() + 1000;
    while (!*drained && GetTickCount64() < deadline) { co_await resume_after(std::chrono::milliseconds(10)); co_await ui; }
    require(*drained, L"The native invocation queue exceeded its bound.");
}
}

// Scripted acceptance stays after chooseFile's real duplicate/closing guard.
// Native modal cancellation is intentionally outside this bounded state check.
std::filesystem::path attachmentFixtureSelection(bool save) {
    require(save && !selectedPath.empty(), L"Unexpected fixture file selection.");
    ++selections;
    return selectedPath;
}
IAsyncOperation<Json> attachmentFixtureRequest(hstring path, hstring owner, hstring method, Json body) {
    require(path == L"/attachments/fictional" && owner == L"first@attachment.invalid"
        && method == L"GET" && body.Size() == 0, L"Unexpected request or attachment owner.");
    ++requests; requestedOwner = owner;
    apartment_context ui;
    auto deadline = GetTickCount64() + 5000;
    while (holdDownload && GetTickCount64() < deadline) {
        co_await resume_after(std::chrono::milliseconds(10)); co_await ui;
    }
    require(!holdDownload, L"The synthetic download was never released.");
    auto result = Json::Parse(LR"({"attachment":{"id":"fictional","name":"fixture.txt","data":"ZmljdGlvbmFs","size":9}})");
    if (invalidDownload) put(object(result, L"attachment"), L"id", L"wrong-id");
    co_return result;
}

fire_and_forget startAttachmentFlowChecks(std::shared_ptr<Shell> shell) {
    bool passed = false;
    try {
        wchar_t directory[32768]{};
        auto length = GetEnvironmentVariableW(L"MORROW_DATA_DIR", directory, 32768);
        require(length > 0 && length < 32768, L"Missing isolated workspace.");
        fixture = directory;
        require(fixture.is_absolute() && std::filesystem::is_regular_file(fixture / L"attachment-fixture"),
            L"Attachment checks require a marked absolute temporary workspace.");
        shell->service = std::make_shared<Service>(fixture); // Never started.
        shell->window = xaml::Window(); shell->window.Title(L"Fictional attachment checks");
        shell->root = controls::Grid(); shell->navigation = controls::NavigationView();
        shell->page = controls::ContentControl(); shell->status = controls::TextBlock();
        shell->composeButton = controls::Button(); shell->syncButton = controls::Button();
        shell->navigation.Content(shell->page); shell->root.Children().Append(shell->navigation);
        shell->navigation.PaneDisplayMode(controls::NavigationViewPaneDisplayMode::Left);
        shell->window.Content(shell->root); shell->window.Activate();
        shell->window.AppWindow().Resize({1220, 800});
        // Return from OnLaunched before exercising the mounted native controls.
        apartment_context ui;
        co_await resume_after(std::chrono::milliseconds(50)); co_await ui;
        std::fprintf(stderr, "Attachment fixture: native window ready\n"); std::fflush(stderr);
        shell->owner = L"first@attachment.invalid"; shell->folder = L"drafts";
        shell->cursors = {L"", L"second-page"}; shell->nextCursor = L"third-page";
        shell->selected = Json::Parse(LR"({"accountId":"first@attachment.invalid","id":"same-id","viewId":"first:same-id","body":"Unsaved fictional text","attachments":[{"id":"fictional","name":"fixture.txt"}]})");
        shell->page.Content(controls::TextBox());
        auto page = shell->page.Content(); auto draft = shell->selected.Stringify();
        auto item = array(shell->selected, L"attachments").GetAt(0).GetObject();
        auto unchanged = [&] {
            return shell->owner == L"first@attachment.invalid" && shell->section == L"mail"
                && shell->folder == L"drafts" && shell->cursors == std::vector<hstring>{L"", L"second-page"}
                && shell->nextCursor == L"third-page" && shell->selected.Stringify() == draft
                && shell->page.Content() == page && shell->generation == 0 && shell->selectionGeneration == 0;
        };
        bool oldNavigation = std::wstring_view(GetCommandLineW()).find(L"--expect-navigation-defect") != std::wstring_view::npos;
        bool oldSidebar = std::wstring_view(GetCommandLineW()).find(L"--expect-sidebar-defect") != std::wstring_view::npos;
        auto invocations = std::make_shared<unsigned>(0);
        if (!oldNavigation) {
            shell->state = Json::Parse(LR"({"accounts":[{"id":"first@attachment.invalid","email":"first@attachment.invalid"},{"id":"sidebar@attachment.invalid","email":"sidebar@attachment.invalid"}]})");
            attachmentFixtureNavigationHandler(shell);
            shell->navigation.ItemInvoked([invocations](auto const&, auto const&) { ++*invocations; });
            shell->rebuildNavigation(); shell->root.UpdateLayout();
            // Seed the mounted control's initial selection without invocation;
            // the regression below must originate from its automation action.
            shell->navigation.SelectedItem(mailboxItem(shell, shell->owner, shell->folder));
            require(text(sidebarSelection(shell), L"owner") == shell->owner && text(sidebarSelection(shell), L"folder") == L"drafts",
                L"The mounted sidebar did not start on the actual mailbox.");
        }
        selectedPath = fixture / L"download.txt";
        { std::ofstream(selectedPath, std::ios::binary) << "original"; }
        holdDownload = true;
        auto download = saveAttachment(shell, shell->owner, item);
        require(shell->dialogOpen && requests == 1 && selections == 1 && contents(selectedPath) == "original",
            L"Download did not acquire its foreground guard before awaiting data.");
        co_await saveAttachment(shell, shell->owner, item);
        auto duplicateUpload = co_await uploadAttachment(shell, shell->owner);
        require(requests == 1 && selections == 1 && duplicateUpload.Size() == 0 && shell->dialogOpen,
            L"Repeated attachment activation bypassed the active download guard.");
        if (!oldNavigation) {
            auto beforeState = shell->state.Stringify();
            // Keep the target account's native children visible. Expanding an
            // unrelated group is fixture layout, not a mailbox navigation.
            shell->selectingNavigation = true;
            for (auto const& entry : shell->navigation.MenuItems())
                if (auto group = entry.try_as<controls::NavigationViewItem>(); group && group.Tag()) {
                    auto owner = text(group.Tag().as<Json>(), L"owner");
                    if (!owner.empty()) group.IsExpanded(owner == L"sidebar@attachment.invalid");
                }
            shell->selectingNavigation = false; shell->root.UpdateLayout();
            co_await invokeSidebar(shell, mailboxItem(shell, L"sidebar@attachment.invalid", L"inbox"), invocations);
            require(*invocations == 1 && unchanged() && shell->state.Stringify() == beforeState && requests == 1,
                L"The real sidebar invocation changed mailbox data, failed to fire, or escaped the download guard.");
            auto selection = sidebarSelection(shell);
            if (oldSidebar) {
                require(text(selection, L"owner") == L"sidebar@attachment.invalid" && text(selection, L"folder") == L"inbox",
                    L"Pinned merged main did not reproduce the expected sidebar/content mismatch.");
                std::fprintf(stderr, "Attachment check: pinned merged main reproduced sidebar/account selection mismatch through real ItemInvoked\n");
            } else {
                require(text(selection, L"owner") == shell->owner && text(selection, L"folder") == shell->folder,
                    L"Blocked native invocation left the sidebar on another mailbox.");
                auto activity = shell->navigation.FooterMenuItems().GetAt(0).as<controls::NavigationViewItem>();
                co_await invokeSidebar(shell, activity, invocations);
                require(*invocations == 2 && text(sidebarSelection(shell), L"owner") == shell->owner
                    && text(sidebarSelection(shell), L"folder") == shell->folder && unchanged() && requests == 1,
                    L"Blocked native page invocation left the sidebar inconsistent with the retained mailbox.");
                std::fprintf(stderr, "Attachment check: real account/page invocation restored sidebar and retained owner/page/selection\n");
            }
        }
        auto other = Json::Parse(LR"({"accountId":"second@attachment.invalid","id":"same-id","viewId":"second:same-id"})");
        co_await shell->read(other, false);
        require(unchanged() && requests == 1, L"Reading another owner's duplicate ID bypassed the active download guard.");
        // Also retain the original direct navigation guard regression.
        // A disconnected destination renders onboarding and makes no request.
        co_await shell->navigate(L"mail", L"second@attachment.invalid", L"inbox");
        bool retained = unchanged();
        holdDownload = false; co_await download;
        require(!shell->dialogOpen && requestedOwner == L"first@attachment.invalid"
            && contents(selectedPath) == "fictional"
            && contents(std::filesystem::path(selectedPath.wstring() + L":Zone.Identifier")).find("ZoneId=3") != std::string::npos,
            L"Download lost its owner, bytes, security marker or completion guard release.");
        bool baseline = oldNavigation;
        if (baseline) {
            require(!retained && shell->owner == L"second@attachment.invalid" && shell->cursors.size() == 1
                && shell->selected.Size() == 0 && shell->page.Content() != page && shell->generation == 1,
                L"Pinned main did not reproduce the expected active-download navigation defect.");
            std::fprintf(stderr, "Attachment check: pinned main reproduced account/page/selection loss during download\n");
        } else {
            require(retained, L"Active attachment download allowed account/page/selection replacement.");
            std::fprintf(stderr, "Attachment check: active download retained owner/page/selection and rejected duplicates\n");
            invalidDownload = true;
            co_await saveAttachment(shell, shell->owner, item);
            require(!shell->dialogOpen && unchanged() && !shell->status.Text().empty()
                && contents(selectedPath) == "fictional", L"Rejected attachment data changed the existing file/state or retained its guard.");
            co_await shell->navigate(L"mail", L"second@attachment.invalid", L"inbox");
            require(shell->owner == L"second@attachment.invalid" && shell->generation == 1
                && shell->page.Content() != page, L"Download completion/failure left navigation locked.");
            std::fprintf(stderr, "Attachment check: verified data failure retained destination; navigation released\n");
        }
        for (auto const& entry : std::filesystem::directory_iterator(fixture))
            require(!entry.path().filename().wstring().starts_with(L".morrow-"), L"Attachment temporary file survived completion.");
        passed = true;
    } catch (...) {
        std::fprintf(stderr, "Attachment check failure: %s\n", to_string(errorText()).c_str());
    }
    holdDownload = false;
    if (!fixture.empty()) std::ofstream(fixture / L"attachment-result.txt") << (passed ? "passed" : "failed");
    std::fflush(stderr);
    if (shell->window) shell->window.Close();
    xaml::Application::Current().Exit();
}
}
