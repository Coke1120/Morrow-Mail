#pragma once
#include <windows.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.h>
#include <atomic>
#include <filesystem>
#include <memory>
#include <mutex>
#include <string>

namespace morrow {
using Json = winrt::Windows::Data::Json::JsonObject;
using Array = winrt::Windows::Data::Json::JsonArray;
using Value = winrt::Windows::Data::Json::JsonValue;
winrt::hstring text(Json const& object, wchar_t const* key, winrt::hstring const& fallback = {});
bool flag(Json const& object, wchar_t const* key);
Json object(Json const& value, wchar_t const* key);
Array array(Json const& value, wchar_t const* key);
void put(Json const& value, wchar_t const* key, winrt::hstring const& entry);
winrt::hstring escaped(winrt::hstring const& value);

struct ApiError : winrt::hresult_error {
    unsigned status;
    Json body;
    ApiError(unsigned code, Json const& result);
};

// Owns the one private Rust process. No provider credentials or message WebView
// are allowed access to its bearer/update tokens.
class Service : public std::enable_shared_from_this<Service> {
public:
    explicit Service(std::filesystem::path directory);
    ~Service();
    Service(Service const&) = delete;
    Service& operator=(Service const&) = delete;
    winrt::Windows::Foundation::IAsyncAction start();
    winrt::Windows::Foundation::IAsyncAction stop();
    winrt::Windows::Foundation::IAsyncOperation<Json> request(
        winrt::hstring path, winrt::hstring owner = {}, winrt::hstring method = L"GET",
        Json body = Json(), bool hostOperation = false);
    bool alive() const;
    bool writing() const { return writes_.load() != 0; }
    std::filesystem::path const& directory() const { return directory_; }
    winrt::hstring origin() const;
    Json clientState() const;
    void saveClientState(winrt::hstring const& key, winrt::hstring const& value);
    static std::filesystem::path workspace();
    static std::filesystem::path executable();
    static winrt::hstring uuid();
private:
    std::filesystem::path directory_;
    HANDLE process_ = nullptr;
    HANDLE input_ = nullptr;
    unsigned short port_ = 0;
    std::wstring token_, updateToken_;
    std::atomic_uint writes_ = 0;
    std::atomic_bool closing_ = false;
    mutable std::mutex stateMutex_;
    void close();
    Json requestBlocking(winrt::hstring const& path, winrt::hstring const& owner,
        winrt::hstring const& method, Json const& body, bool hostOperation);
};
}
