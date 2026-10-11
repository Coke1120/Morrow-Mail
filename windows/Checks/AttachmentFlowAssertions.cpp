// Compiled only by test-windows-attachment-flow.ps1 in its private source copy.
#include "pch.h"
#include "Ui.h"
#include <fstream>
#include <cstdio>

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
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
}

// Scripted acceptance stays after chooseFile's real duplicate/closing guard.
// Native modal cancellation is intentionally outside this bounded state check.
std::filesystem::path attachmentFixtureSelection(bool save) {
    require(save && !selectedPath.empty(), L"Unexpected fixture file selection.");
    ++selections;
    return selectedPath;
}
IAsyncOperation<Json> attachmentFixtureRequest(hstring path, hstring owner, hstring method, Json body) {
    if (path == L"/sync/priority") {
        require(method == L"POST" && owner == L"all" && array(body, L"messages").Size() == 0
            && body.GetNamedNumber(L"generation", 0) > 0, L"Unexpected fixture view hint.");
        co_return Json::Parse(LR"({"accepted":true})");
    }
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
        shell->window.Content(shell->root); shell->window.Activate();
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
        auto other = Json::Parse(LR"({"accountId":"second@attachment.invalid","id":"same-id","viewId":"second:same-id"})");
        co_await shell->read(other, false);
        require(unchanged() && requests == 1, L"Reading another owner's duplicate ID bypassed the active download guard.");
        // This is the same entry point as sidebar page/account activation.
        // A disconnected destination renders onboarding and makes no request.
        co_await shell->navigate(L"mail", L"second@attachment.invalid", L"inbox");
        bool retained = unchanged();
        holdDownload = false; co_await download;
        require(!shell->dialogOpen && requestedOwner == L"first@attachment.invalid"
            && contents(selectedPath) == "fictional"
            && contents(std::filesystem::path(selectedPath.wstring() + L":Zone.Identifier")).find("ZoneId=3") != std::string::npos,
            L"Download lost its owner, bytes, security marker or completion guard release.");
        bool baseline = std::wstring_view(GetCommandLineW()).find(L"--expect-navigation-defect") != std::wstring_view::npos;
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
#ifdef MORROW_SYNC_PRIORITY_CHECKS
        auto combined = std::make_shared<Shell>();
        combined->owner = L"all"; combined->rows = controls::ListView();
        combined->state = Json::Parse(LR"({"accounts":[{"id":"first@attachment.invalid"},{"id":"second@attachment.invalid"}]})");
        combined->cursors = {L"", L"second-page"};
        for (unsigned index = 0; index < 55; ++index) {
            Json message; put(message, L"accountId", L"first@attachment.invalid"); put(message, L"id", L"row-" + to_hstring(index));
            controls::ListViewItem row; row.Tag(message); combined->rows.Items().Append(row);
        }
        combined->selected = Json::Parse(LR"({"accountId":"second@attachment.invalid","id":"row-0"})");
        auto priority = combined->syncPriorityMessages();
        require(priority.Size() == 51 && text(priority.GetAt(0).GetObject(), L"accountId") == L"second@attachment.invalid"
            && text(priority.GetAt(1).GetObject(), L"accountId") == L"first@attachment.invalid"
            && text(priority.GetAt(0).GetObject(), L"id") == text(priority.GetAt(1).GetObject(), L"id")
            && combined->cursors.size() == 2 && text(combined->selected, L"accountId") == L"second@attachment.invalid",
            L"Current-view hints lost owner identity, selected-first order, bounds or page state.");
        combined->owner = L"second@attachment.invalid";
        require(combined->syncPriorityMessages().Size() == 1, L"An account-specific hint included another mailbox's rows.");
#endif
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
