// Compiled only by test-windows-attachment-flow.ps1 in its private source copy.
#include "pch.h"
#include "Ui.h"
#include <shobjidl.h>
#include <fstream>
#include <cstdio>

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
namespace {
std::filesystem::path fixture, selectedPath;
com_ptr<IFileDialog> activeDialog;
UINT_PTR cancelTimer = 0;
unsigned dialogs = 0, cancelledDialogs = 0, requests = 0, selections = 0;
unsigned pickerTicks = 0;
bool holdDownload = false, invalidDownload = false;
hstring requestedOwner;
void require(bool value, wchar_t const* message) {
    if (!value) throw hresult_error(E_FAIL, message);
}
std::string contents(std::filesystem::path const& path) {
    std::ifstream file(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}
void CALLBACK cancelPicker(HWND, UINT, UINT_PTR timer, DWORD) noexcept {
    com_ptr<IOleWindow> window;
    HWND handle{};
    auto query = activeDialog ? activeDialog->QueryInterface(IID_PPV_ARGS(window.put())) : E_POINTER;
    auto getWindow = window ? window->GetWindow(&handle) : E_POINTER;
    if (++pickerTicks == 1) {
        std::fprintf(stderr, "Attachment fixture: picker timer query=0x%08X window=0x%08X visible=%d\n",
            static_cast<unsigned>(query), static_cast<unsigned>(getWindow), int(IsWindowVisible(handle)));
        std::fflush(stderr);
    }
    if (SUCCEEDED(query) && SUCCEEDED(getWindow) && IsWindowVisible(handle)) {
        auto closed = activeDialog->Close(HRESULT_FROM_WIN32(ERROR_CANCELLED));
        if (pickerTicks <= 3 || SUCCEEDED(closed)) {
            std::fprintf(stderr, "Attachment fixture: picker Close=0x%08X\n", static_cast<unsigned>(closed)); std::fflush(stderr);
        }
        if (SUCCEEDED(closed)) {
            KillTimer(nullptr, timer); cancelTimer = 0; ++cancelledDialogs;
        }
    }
}
}

// Scripted acceptance stays after chooseFile's real duplicate/closing guard.
// Cancellation below uses the real modal picker and its documented Close API.
std::filesystem::path attachmentFixtureSelection(bool save) {
    if (!selectedPath.empty()) { require(save, L"Unexpected upload selection."); ++selections; }
    return selectedPath;
}
void attachmentFixturePicker(IFileDialog* dialog) {
    require(!cancelTimer, L"A previous picker cancellation timer survived.");
    activeDialog.copy_from(dialog); ++dialogs; pickerTicks = 0;
    com_ptr<IShellItem> folder;
    check_hresult(SHCreateItemFromParsingName(fixture.c_str(), nullptr, IID_PPV_ARGS(folder.put())));
    check_hresult(dialog->SetFolder(folder.get()));
    cancelTimer = SetTimer(nullptr, 0, 100, cancelPicker);
    require(cancelTimer != 0, L"Could not schedule the owned picker cancellation.");
    std::fprintf(stderr, "Attachment fixture: picker %u entering Show\n", dialogs); std::fflush(stderr);
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
        shell->window.Content(shell->root); shell->window.Activate();
        // Return from OnLaunched before entering the common dialog's modal loop.
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
        co_await saveAttachment(shell, shell->owner, item);
        auto upload = co_await uploadAttachment(shell, shell->owner);
        activeDialog = nullptr;
        require(dialogs == 2 && cancelledDialogs == 2 && !cancelTimer && requests == 0
            && upload.Size() == 0 && !shell->dialogOpen && unchanged(),
            L"Cancelling a native picker changed message/page state or started a request.");
        std::fprintf(stderr, "Attachment check: native save/open cancellation preserved state; zero requests\n");

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
        passed = true;
    } catch (...) {
        std::fprintf(stderr, "Attachment check failure: %s\n", to_string(errorText()).c_str());
    }
    holdDownload = false;
    if (cancelTimer) { KillTimer(nullptr, cancelTimer); cancelTimer = 0; }
    activeDialog = nullptr;
    if (!fixture.empty()) std::ofstream(fixture / L"attachment-result.txt") << (passed ? "passed" : "failed");
    std::fflush(stderr);
    if (shell->window) shell->window.Close();
    xaml::Application::Current().Exit();
}
}
