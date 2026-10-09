#include "pch.h"
#include "Ui.h"
#include <shobjidl.h>
#include <winrt/Windows.Security.Cryptography.h>
#include <winrt/Windows.Storage.Streams.h>
#include <fstream>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "uuid.lib")

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
using namespace Windows::Security::Cryptography;
namespace {
constexpr size_t maxBytes = 20 * 1024 * 1024;
std::filesystem::path chooseFile(std::shared_ptr<Shell> const& shell, bool save, hstring const& name = {}) {
    if (shell->dialogOpen || shell->closing) return {};
    shell->dialogOpen = true;
    struct Guard { bool& flag; ~Guard() { flag = false; } } guard{shell->dialogOpen};
    com_ptr<IFileDialog> dialog;
    check_hresult(CoCreateInstance(save ? CLSID_FileSaveDialog : CLSID_FileOpenDialog, nullptr,
        CLSCTX_INPROC_SERVER, IID_PPV_ARGS(dialog.put())));
    DWORD options{}; check_hresult(dialog->GetOptions(&options));
    check_hresult(dialog->SetOptions(options | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR
        | (save ? FOS_OVERWRITEPROMPT : FOS_FILEMUSTEXIST)));
    if (save) check_hresult(dialog->SetFileName(name.c_str()));
    HWND hwnd{}; check_hresult(shell->window.as<::IWindowNative>()->get_WindowHandle(&hwnd));
    auto result = dialog->Show(hwnd);
    if (result == HRESULT_FROM_WIN32(ERROR_CANCELLED)) return {};
    check_hresult(result);
    com_ptr<IShellItem> item; check_hresult(dialog->GetResult(item.put()));
    PWSTR path{}; check_hresult(item->GetDisplayName(SIGDN_FILESYSPATH, &path));
    std::filesystem::path value(path); CoTaskMemFree(path); return value;
}
}
IAsyncOperation<Json> uploadAttachment(std::shared_ptr<Shell> shell, hstring owner) {
    auto path = chooseFile(shell, false);
    if (path.empty()) co_return Json();
    auto generation = shell->generation;
    apartment_context ui;
    co_await resume_background();
    std::exception_ptr failure; hstring encoded;
    try {
    auto size = std::filesystem::file_size(path);
    if (!std::filesystem::is_regular_file(path) || size > maxBytes)
        throw hresult_error(E_INVALIDARG, L"Choose a regular file up to 20 MiB.");
    std::vector<uint8_t> bytes(static_cast<size_t>(size));
    std::ifstream stream(path, std::ios::binary);
    stream.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    if (!stream || stream.peek() != std::char_traits<char>::eof())
        throw hresult_error(E_FAIL, L"The attachment changed or could not be read. Select it again.");
    encoded = CryptographicBuffer::EncodeToBase64String(CryptographicBuffer::CreateFromByteArray(bytes));
    } catch (...) { failure = std::current_exception(); }
    co_await ui;
    if (failure) std::rethrow_exception(failure);
    if (shell->closing || shell->generation != generation || !shell->connected(owner)) co_return Json();
    Json body; put(body, L"name", hstring(path.filename().wstring())); put(body, L"data", encoded);
    put(body, L"contentType", L"application/octet-stream");
    auto response = co_await shell->service->request(L"/attachments", owner, L"POST", body);
    co_return object(response, L"attachment");
}
IAsyncAction saveAttachment(std::shared_ptr<Shell> shell, hstring owner, Json item) {
    apartment_context ui; hstring error;
    try {
        auto path = chooseFile(shell, true, text(item, L"name"));
        if (path.empty()) co_return;
        auto response = co_await shell->service->request(L"/attachments/" + escaped(text(item, L"id")), owner);
        auto value = object(response, L"attachment");
        auto buffer = CryptographicBuffer::DecodeFromBase64String(text(value, L"data"));
        if (text(value, L"id") != text(item, L"id") || buffer.Length() > maxBytes
            || buffer.Length() != value.GetNamedNumber(L"size", -1))
            throw hresult_error(E_FAIL, L"Attachment download could not be verified.");
        com_array<uint8_t> bytes; CryptographicBuffer::CopyToByteArray(buffer, bytes);
        co_await resume_background();
        auto temporary = path.parent_path() / (L".morrow-" + std::wstring(Service::uuid()) + L".download");
        HANDLE file = CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file == INVALID_HANDLE_VALUE) throw hresult_error(HRESULT_FROM_WIN32(GetLastError()), L"Cannot create the attachment file.");
        DWORD written{};
        auto writtenOK = WriteFile(file, bytes.data(), bytes.size(), &written, nullptr) && written == bytes.size() && FlushFileBuffers(file);
        CloseHandle(file);
        try {
            if (!writtenOK) throw hresult_error(E_FAIL, L"The attachment could not be saved completely.");
            // Mark the temporary file before it becomes visible at the chosen destination.
            std::ofstream zone(std::filesystem::path(temporary.wstring() + L":Zone.Identifier"), std::ios::binary);
            zone << "[ZoneTransfer]\r\nZoneId=3\r\n"; zone.close();
            if (!zone) throw hresult_error(E_FAIL, L"This destination cannot preserve the downloaded-file security marker. Choose an NTFS folder.");
            check_bool(MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH));
        } catch (...) { DeleteFileW(temporary.c_str()); throw; }
        co_await ui;
    } catch (...) { error = errorText(); }
    co_await ui;
    if (!error.empty() && !shell->closing) shell->error(error);
}
IAsyncAction loadAttachments(std::shared_ptr<Shell> shell, Json message, controls::Button button) {
    auto generation = shell->generation, selection = shell->selectionGeneration;
    auto owner = text(message, L"accountId");
    button.IsEnabled(false);
    try {
        auto response = co_await shell->service->request(L"/messages/" + escaped(text(message, L"id")) + L"/attachments", owner, L"POST", Json());
        auto loaded = object(response, L"message");
        if (text(loaded, L"accountId") != owner || text(loaded, L"id") != text(message, L"id"))
            throw hresult_error(E_FAIL, L"Attachment ownership could not be confirmed.");
        if (!shell->closing && shell->generation == generation && shell->selectionGeneration == selection) shell->renderReader(loaded);
    } catch (...) { if (!shell->closing) shell->error(errorText()); }
    button.IsEnabled(true);
}
void appendAttachmentControls(std::shared_ptr<Shell> shell, controls::StackPanel const& panel, Json const& message) {
    if (flag(message, L"hasAttachments") || array(message, L"attachments").Size()
        || (!message.HasKey(L"hasAttachments") && !std::wstring_view(text(message, L"id")).starts_with(L"draft:"))) {
        controls::Button load; load.Content(box_value(L"Load attachments and inline images…"));
        load.Click([shell, message](auto const& sender, auto const&) { loadAttachments(shell, message, sender.template as<controls::Button>()); });
        panel.Children().Append(load);
        for (auto const& value : array(message, L"attachments")) {
            auto item = value.GetObject();
            auto row = stack(4); row.Children().Append(label(text(item, L"name") + L" (" + to_hstring(static_cast<uint64_t>(item.GetNamedNumber(L"size", 0))) + L" bytes)"));
            row.Children().Append(button(L"Save attachment…", [shell, message, item] { saveAttachment(shell, text(message, L"accountId"), item); }));
            panel.Children().Append(row);
        }
    }
}
}
