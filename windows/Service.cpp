#include "pch.h"
#include "Service.h"
#include <bcrypt.h>
#include <shlobj.h>
#include <winhttp.h>
#include <fstream>
#include <vector>
#include <stdexcept>

#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
using namespace Windows::Data::Json;
namespace fs = std::filesystem;
namespace {
struct Handle {
    HANDLE value = nullptr;
    ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    HANDLE release() { return std::exchange(value, nullptr); }
};
struct Internet {
    HINTERNET value;
    ~Internet() { if (value) WinHttpCloseHandle(value); }
};
void require(bool value, wchar_t const* message) {
    if (!value) throw hresult_error(E_FAIL, message);
}
std::wstring randomToken() {
    unsigned char bytes[32];
    require(BCryptGenRandom(nullptr, bytes, sizeof bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0,
        L"Could not initialize private service authentication.");
    std::wstring result;
    for (auto byte : bytes) {
        result += L"0123456789abcdef"[byte >> 4]; result += L"0123456789abcdef"[byte & 15];
    }
    SecureZeroMemory(bytes, sizeof bytes);
    return result;
}
std::wstring environment(std::wstring const& name) {
    auto size = GetEnvironmentVariableW(name.c_str(), nullptr, 0);
    if (!size) return {};
    std::wstring value(size, L'\0');
    auto copied = GetEnvironmentVariableW(name.c_str(), value.data(), size);
    require(copied > 0 && copied < size, L"The environment changed during startup.");
    value.resize(copied); return value;
}
std::vector<wchar_t> childEnvironment() {
    auto source = GetEnvironmentStringsW();
    require(source != nullptr, L"Could not prepare the private service environment.");
    std::vector<wchar_t> result;
    for (auto line = source; *line; line += wcslen(line) + 1) {
        std::wstring entry(line);
        auto equals = entry.find(L'=', entry[0] == L'=' ? 1 : 0);
        auto key = entry.substr(0, equals);
        bool omit = false;
        for (auto unsafe : { L"NODE_OPTIONS", L"NODE_PATH", L"ELECTRON_RUN_AS_NODE", L"LD_PRELOAD", L"DYLD_INSERT_LIBRARIES" })
            if (_wcsicmp(key.c_str(), unsafe) == 0) omit = true;
        if (!omit) { result.insert(result.end(), entry.begin(), entry.end()); result.push_back(0); }
    }
    FreeEnvironmentStringsW(source); result.push_back(0); return result;
}
Json readJson(fs::path const& path, uintmax_t limit) {
    if (!fs::exists(path)) return Json();
    require(fs::is_regular_file(path) && fs::file_size(path) <= limit,
        L"Saved desktop state cannot be read. The original file has been retained.");
    std::ifstream file(path, std::ios::binary);
    require(file.good(), L"Could not read saved desktop state.");
    std::string data((std::istreambuf_iterator<char>(file)), {});
    return Json::Parse(to_hstring(data));
}
}
hstring text(Json const& value, wchar_t const* key, hstring const& fallback) {
    auto entry = value.TryLookup(key);
    return entry && entry.ValueType() == JsonValueType::String ? entry.GetString() : fallback;
}
bool flag(Json const& value, wchar_t const* key) {
    auto entry = value.TryLookup(key);
    return entry && entry.ValueType() == JsonValueType::Boolean && entry.GetBoolean();
}
Json object(Json const& value, wchar_t const* key) {
    auto entry = value.TryLookup(key);
    return entry && entry.ValueType() == JsonValueType::Object ? entry.GetObject() : Json();
}
Array array(Json const& value, wchar_t const* key) {
    auto entry = value.TryLookup(key);
    return entry && entry.ValueType() == JsonValueType::Array ? entry.GetArray() : Array();
}
void put(Json const& value, wchar_t const* key, hstring const& entry) { value.Insert(key, Value::CreateStringValue(entry)); }
hstring escaped(hstring const& value) { return Uri::EscapeComponent(value); }
ApiError::ApiError(unsigned code, Json const& result)
    : hresult_error(E_FAIL, text(result, L"error", L"The request could not be completed. Try again.")), status(code), body(result) {}

fs::path Service::workspace() {
    auto custom = environment(L"MORROW_DATA_DIR");
    if (!custom.empty()) {
        fs::path result(custom);
        require(result.is_absolute(), L"MORROW_DATA_DIR must be an absolute directory.");
        return result;
    }
    PWSTR path = nullptr;
    check_hresult(SHGetKnownFolderPath(FOLDERID_RoamingAppData, KF_FLAG_DEFAULT, nullptr, &path));
    fs::path result(path); CoTaskMemFree(path);
    return result / L"Morrow Mail"; // Electron app.getPath('userData'), retained verbatim.
}
fs::path Service::executable() {
    std::wstring path(32768, 0);
    auto size = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
    require(size && size < path.size(), L"Could not locate Morrow Mail.");
    path.resize(size); return fs::path(path);
}
hstring Service::uuid() {
    GUID value; check_hresult(CoCreateGuid(&value));
    wchar_t buffer[40]; StringFromGUID2(value, buffer, 40);
    return hstring(buffer + 1, 36);
}
Service::Service(fs::path directory) : directory_(std::move(directory)) {}
Service::~Service() { close(); SecureZeroMemory(token_.data(), token_.size() * sizeof(wchar_t)); SecureZeroMemory(updateToken_.data(), updateToken_.size() * sizeof(wchar_t)); }
IAsyncAction Service::start() {
    auto lifetime = shared_from_this();
    co_await resume_background();
    std::unique_lock processLock(processMutex_);
    require(process_ == nullptr && !closing_, L"The private service is already started or closing.");
    auto root = executable().parent_path();
    auto service = root / L"resources/app/runtime/morrow-service.exe";
    require(fs::is_regular_file(service), L"The bundled Rust service is missing. Reinstall Morrow Mail.");
    fs::create_directories(directory_);
    token_ = randomToken(); updateToken_ = randomToken();
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    Handle childInput, parentInput, childOutput, parentOutput, nullError;
    require(CreatePipe(&childInput.value, &parentInput.value, &security, 0) &&
        CreatePipe(&parentOutput.value, &childOutput.value, &security, 0), L"Could not open private service pipes.");
    require(SetHandleInformation(parentInput.value, HANDLE_FLAG_INHERIT, 0) &&
        SetHandleInformation(parentOutput.value, HANDLE_FLAG_INHERIT, 0), L"Could not protect private service pipes.");
    nullError.value = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
        &security, OPEN_EXISTING, 0, nullptr);
    require(nullError.value != INVALID_HANDLE_VALUE, L"Could not prepare the private service.");
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = childInput.value;
    startup.StartupInfo.hStdOutput = childOutput.value;
    startup.StartupInfo.hStdError = nullError.value;
    SIZE_T attributesSize = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attributesSize);
    std::vector<unsigned char> storage(attributesSize);
    startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    require(InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attributesSize), L"Could not protect child handles.");
    struct Attributes { LPPROC_THREAD_ATTRIBUTE_LIST value; ~Attributes() { DeleteProcThreadAttributeList(value); } } attributes{startup.lpAttributeList};
    HANDLE inherited[] = {childInput.value, childOutput.value, nullError.value};
    require(UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        inherited, sizeof inherited, nullptr, nullptr), L"Could not restrict child handles.");
    PROCESS_INFORMATION child{};
    std::wstring command = L"\"" + service.wstring() + L"\"";
    auto env = childEnvironment();
    require(CreateProcessW(service.c_str(), command.data(), nullptr, nullptr, TRUE,
        CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
        env.data(), root.c_str(), &startup.StartupInfo, &child), L"Could not start the bundled Rust service.");
    CloseHandle(child.hThread); process_ = child.hProcess; input_ = parentInput.release();
    CloseHandle(childOutput.release()); CloseHandle(childInput.release());
    Json config;
    put(config, L"token", hstring(token_)); put(config, L"updateToken", hstring(updateToken_));
    put(config, L"dataDirectory", hstring(directory_.wstring()));
    config.Insert(L"parentPID", Value::CreateNumberValue(GetCurrentProcessId()));
    auto data = to_string(config.Stringify()) + "\n";
    DWORD written = 0;
    require(data.size() <= 8193 && WriteFile(input_, data.data(), static_cast<DWORD>(data.size()), &written, nullptr) && written == data.size(), L"Could not configure the private service.");
    std::string response;
    auto deadline = GetTickCount64() + 20000;
    while (GetTickCount64() < deadline) {
        require(WaitForSingleObject(process_, 0) == WAIT_TIMEOUT, L"The workspace could not open. Close any other Morrow Mail window and try again. Your saved data is retained.");
        DWORD available = 0;
        require(PeekNamedPipe(parentOutput.value, nullptr, 0, nullptr, &available, nullptr), L"The private service closed before startup.");
        if (!available) { Sleep(20); continue; }
        char bytes[256]; DWORD count = 0;
        require(ReadFile(parentOutput.value, bytes, std::min<DWORD>(available, sizeof bytes), &count, nullptr) && count, L"Could not read service startup.");
        response.append(bytes, count);
        require(response.size() <= 1024, L"Invalid private service startup response.");
        if (response.find('\n') == std::string::npos) continue;
        auto ready = Json::Parse(to_hstring(response));
        auto port = ready.GetNamedNumber(L"port", 0);
        require(port >= 1 && port <= 65535 && port == static_cast<unsigned short>(port), L"Invalid private service port.");
        port_ = static_cast<unsigned short>(port);
        processLock.unlock();
        requestBlocking(L"/health", {}, L"GET", Json(), false);
        co_return;
    }
    throw hresult_error(E_FAIL, L"Private service startup timed out. Your workspace has been retained.");
}
bool Service::alive() const { std::lock_guard lock(processMutex_); return process_ && WaitForSingleObject(process_, 0) == WAIT_TIMEOUT; }
hstring Service::origin() const { return L"http://127.0.0.1:" + to_hstring(port_); }
void Service::close() {
    std::lock_guard lock(processMutex_);
    closing_ = true;
    if (input_) { CloseHandle(input_); input_ = nullptr; }
    if (process_) {
        if (WaitForSingleObject(process_, 70000) == WAIT_TIMEOUT) {
            TerminateProcess(process_, 1); WaitForSingleObject(process_, 5000);
        }
        CloseHandle(process_); process_ = nullptr;
    }
}
IAsyncAction Service::stop() {
    auto lifetime = shared_from_this();
    closing_ = true;
    co_await resume_background();
    close();
}
IAsyncOperation<Json> Service::request(hstring path, hstring owner, hstring method, Json body, bool hostOperation) {
    auto lifetime = shared_from_this();
    // Increment before yielding, so close/update cannot race an accepted write.
    bool mutation = method != L"GET";
    struct Write { std::atomic_uint& value; bool active; ~Write() { if (active) --value; } } writing{writes_, mutation};
    if (mutation) ++writes_;
    require(!closing_, L"Morrow Mail is closing.");
    co_await resume_background();
    co_return requestBlocking(path, owner, method, body, hostOperation);
}
Json Service::requestBlocking(hstring const& path, hstring const& owner, hstring const& method, Json const& body, bool hostOperation) {
    require(alive(), L"The private service stopped. Close and reopen Morrow Mail.");
    require(port_ && path.size() && path[0] == L'/' && path.size() <= 32768 && std::wstring_view(path).find_first_of(L"\r\n#") == std::wstring_view::npos,
        L"Invalid private API request.");
    require(owner.size() <= 254 && std::wstring_view(owner).find_first_of(L"\r\n") == std::wstring_view::npos, L"Invalid mailbox identity.");
    require(method == L"GET" || method == L"POST" || method == L"PATCH" || method == L"PUT" || method == L"DELETE", L"Invalid request method.");
    Internet session{WinHttpOpen(L"MorrowMail/Native", WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0)};
    require(session.value != nullptr, L"Could not initialize private service access.");
    require(WinHttpSetTimeouts(session.value, 10000, 10000, 120000, 120000), L"Could not bound private service requests.");
    Internet connection{WinHttpConnect(session.value, L"127.0.0.1", port_, 0)};
    require(connection.value != nullptr, L"The private service is unavailable.");
    std::wstring endpoint = L"/api" + std::wstring(path);
    Internet request{WinHttpOpenRequest(connection.value, method.c_str(), endpoint.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0)};
    require(request.value != nullptr, L"Could not create a private service request.");
    DWORD redirect = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
    require(WinHttpSetOption(request.value, WINHTTP_OPTION_REDIRECT_POLICY, &redirect, sizeof redirect), L"Could not protect private service redirects.");
    std::wstring headers = L"Authorization: Bearer " + token_ + L"\r\nContent-Type: application/json\r\nX-Morrow-View: paged\r\n";
    if (!owner.empty()) headers += L"X-Genmail-Account: " + std::wstring(owner) + L"\r\n";
    if (hostOperation) headers += L"X-Morrow-Update: " + updateToken_ + L"\r\n";
    std::string payload = method == L"GET" ? "" : to_string(body.Stringify());
    require(payload.size() <= 256 * 1024, L"The request exceeds the supported size.");
    require(WinHttpSendRequest(request.value, headers.c_str(), static_cast<DWORD>(headers.size()),
        payload.empty() ? WINHTTP_NO_REQUEST_DATA : payload.data(), static_cast<DWORD>(payload.size()), static_cast<DWORD>(payload.size()), 0)
        && WinHttpReceiveResponse(request.value, nullptr), L"The private service did not respond. Retry after checking its status.");
    DWORD status = 0, length = sizeof status;
    require(WinHttpQueryHeaders(request.value, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status, &length, WINHTTP_NO_HEADER_INDEX), L"Invalid private service response.");
    std::string response;
    for (;;) {
        char buffer[16384]; DWORD read = 0;
        require(WinHttpReadData(request.value, buffer, sizeof buffer, &read), L"The private service response was interrupted.");
        if (!read) break;
        require(response.size() + read <= 16 * 1024 * 1024, L"The private service response exceeds its limit.");
        response.append(buffer, read);
    }
    Json result;
    require(Json::TryParse(to_hstring(response), result), L"The private service returned an invalid response.");
    if (status < 200 || status >= 300) throw ApiError(status, result);
    return result;
}
Json Service::clientState() const {
    std::lock_guard lock(stateMutex_);
    return readJson(directory_ / L"client-state.json", 262144);
}
void Service::saveClientState(hstring const& key, hstring const& value) {
    require(key == L"morrow.mail.layout" || key == L"morrow.pendingCalendar" || key == L"morrow.calendar.checked" ||
        (std::wstring_view(key).starts_with(L"morrow.account.collapsed.") && key.size() <= 300), L"Unsupported desktop state key.");
    require(value.size() <= 32768, L"Saved desktop state exceeds its limit.");
    require(key != L"morrow.mail.layout" || value == L"right" || value == L"bottom" || value == L"focus", L"Invalid reading layout.");
    std::lock_guard lock(stateMutex_);
    auto destination = directory_ / L"client-state.json";
    auto state = readJson(destination, 262144);
    put(state, key.c_str(), value); // Preserve every existing key/string, including frozen calendar review.
    auto bytes = to_string(state.Stringify());
    require(bytes.size() <= 262144, L"Saved desktop state exceeds its limit.");
    auto temporary = directory_ / (L"client-state-" + std::wstring(uuid()) + L".tmp");
    Handle file{CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)};
    require(file.value != INVALID_HANDLE_VALUE, L"Could not save desktop state.");
    DWORD written = 0;
    bool success = WriteFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) && written == bytes.size() && FlushFileBuffers(file.value);
    CloseHandle(file.release());
    if (success) success = MoveFileExW(temporary.c_str(), destination.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
    if (!success) { DeleteFileW(temporary.c_str()); throw hresult_error(E_FAIL, L"Desktop state was not saved. The previous state is retained."); }
}
}
