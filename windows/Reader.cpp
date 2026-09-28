#include "pch.h"
#include "Ui.h"
#include <winrt/Microsoft.Web.WebView2.Core.h>
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Windows.Security.Cryptography.h>
#include <winrt/Windows.Storage.Streams.h>
#include <winrt/Windows.System.h>
#include <winhttp.h>
#include <atomic>
#include <cstdio>
#include <cwctype>
#include <fstream>
#include <regex>

#pragma comment(lib, "winhttp.lib")

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
using namespace Windows::Storage::Streams;
using namespace Microsoft::Web::WebView2::Core;
using namespace controls;
namespace {
constexpr size_t maxImageBytes = 8 * 1024 * 1024;
constexpr size_t maxMessageImageBytes = 16 * 1024 * 1024;
constexpr unsigned maxImages = 16;
constexpr size_t maxDocumentBytes = 2 * 1024 * 1024;
constexpr size_t maxDocumentBase64 = ((maxDocumentBytes + 2) / 3) * 4;
constexpr std::wstring_view htmlBase64Prefix = L"data:text/html;base64,";
constexpr std::wstring_view htmlUtf8Base64Prefix = L"data:text/html;charset=utf-8;base64,";

hstring documentBase64(hstring const& content) {
    if (content.empty() || content.size() > maxDocumentBytes) return {};
    try {
        using namespace Windows::Security::Cryptography;
        auto bytes = CryptographicBuffer::ConvertStringToBinary(content, BinaryStringEncoding::Utf8);
        if (bytes.Length() > maxDocumentBytes) return {};
        return CryptographicBuffer::EncodeToBase64String(bytes);
    } catch (hresult_error const&) { return {}; }
}
bool matchesDocument(hstring const& uri, hstring const& expectedBase64) {
    if (expectedBase64.empty() || expectedBase64.size() > maxDocumentBase64
        || uri.size() > maxDocumentBase64 + htmlUtf8Base64Prefix.size()) return false;
    if (uri == L"about:blank") return true;
    auto value = std::wstring_view(uri);
    // Compare the host's canonical UTF-8 Base64 directly. No arbitrary data URI,
    // alternate encoding, whitespace, fragment, or malformed Base64 is accepted.
    // Only the fixed header is ASCII case-insensitive; the payload is exact.
    for (auto prefix : {htmlBase64Prefix, htmlUtf8Base64Prefix}) {
        if (value.size() != prefix.size() + expectedBase64.size()) continue;
        bool headerMatches = std::equal(prefix.begin(), prefix.end(), value.begin(), [](wchar_t expected, wchar_t actual) {
            if (actual >= L'A' && actual <= L'Z') actual = static_cast<wchar_t>(actual + (L'a' - L'A'));
            return actual == expected;
        });
        if (headerMatches && value.substr(prefix.size()) == std::wstring_view(expectedBase64)) return true;
    }
    return false;
}

std::wstring lower(hstring const& value) {
    std::wstring result(value);
    for (auto& character : result) character = static_cast<wchar_t>(std::towlower(character));
    return result;
}
bool controlsIn(std::wstring_view value, bool space = true) {
    for (auto c : value) if (c < 0x20 || (space && c == 0x20) || (c >= 0x7f && c <= 0x9f) || c == L'\\'
        || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e)
        || (c >= 0x2060 && c <= 0x206f) || c == 0xfeff || c == 0xfffd) return true;
    return false;
}
bool allowedUrl(hstring const& value, hstring const& serviceOrigin, bool image) {
    if (value.empty() || value.size() > 8192 || controlsIn(std::wstring_view(value))) return false;
    auto raw = std::wstring_view(value);
    for (size_t i = 0; i < raw.size(); ++i) if (raw[i] == L'%'
        && (i + 2 >= raw.size() || !std::iswxdigit(raw[i + 1]) || !std::iswxdigit(raw[i + 2]))) return false;
    try {
        if (controlsIn(std::wstring_view(Uri::UnescapeComponent(value)), false)) return false;
        Uri uri(value);
        auto scheme = lower(uri.SchemeName());
        auto input = lower(value);
        if (!uri.UserName().empty() || !uri.Password().empty()) return false;
        if (scheme == L"https" || (!image && scheme == L"http")) {
            if (!input.starts_with(scheme + L"://") || uri.Host().empty()) return false;
            auto authorityEnd = input.find_first_of(L"/?#", scheme.size() + 3);
            if (input.substr(scheme.size() + 3, authorityEnd - scheme.size() - 3).find(L'@') != std::wstring::npos) return false;
            auto host = lower(uri.Host());
            while (!host.empty() && host.back() == L'.') host.pop_back();
            if (host == L"localhost" || host.ends_with(L".localhost") || host == L"::1" || host == L"[::1]"
                || host == L"0.0.0.0" || host.starts_with(L"127.") || host.find(L"::ffff:127.") != std::wstring::npos) return false;
            if (!serviceOrigin.empty() && host == lower(Uri(serviceOrigin).Host())) return false;
            if (image) {
                auto path = lower(Uri::UnescapeComponent(uri.Path()));
                if (path.find(L".svg") != std::wstring::npos) return false;
            }
            return true;
        }
        return !image && (scheme == L"mailto" || scheme == L"tel") && input.starts_with(scheme + L":")
            && value.size() > scheme.size() + 1 && value[static_cast<uint32_t>(scheme.size() + 1)] != L'/';
    } catch (hresult_error const&) { return false; }
}
hstring document(hstring const& html, bool images) {
    auto imagePolicy = images ? L"https:" : L"'none'";
    return L"<!doctype html><html><head><meta charset=\"utf-8\">"
        L"<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'none'; "
        L"style-src 'unsafe-inline'; img-src " + hstring(imagePolicy)
        + L"; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; media-src 'none'; "
        L"object-src 'none'; base-uri 'none'; form-action 'none'; font-src 'none'; manifest-src 'none'\">"
        L"<meta name=\"referrer\" content=\"no-referrer\"><style>"
        L"html{color-scheme:light;overflow:auto}body{font:15px 'Segoe UI',sans-serif;color:#202720;"
        L"background:white;margin:12px;overflow-wrap:anywhere}img{max-width:100%;max-height:2048px;"
        L"object-fit:contain;height:auto}table{max-width:100%}pre{white-space:pre-wrap}"
        L"blockquote{margin-left:12px;padding-left:12px;border-left:2px solid #ddd}a{color:#236042}"
        L"</style></head><body>" + html + L"</body></html>";
}
struct Internet {
    HINTERNET value{};
    explicit Internet(HINTERNET input) : value(input) { if (!value) throw hresult_error(E_FAIL, L"Image request failed."); }
    ~Internet() { WinHttpCloseHandle(value); }
    Internet(Internet const&) = delete;
    Internet& operator=(Internet const&) = delete;
};
void require(bool condition) { if (!condition) throw hresult_error(E_FAIL, L"External image unavailable."); }
struct ImageBudget { std::atomic_size_t bytes = 0; unsigned requests = 0; };
struct Image { std::vector<uint8_t> bytes; hstring type; };

// Only consented images enter this separate, credential-free HTTP client. The
// WebView never sends its own request, cookies, referrer, or workspace tokens.
Image fetchImage(hstring const& value, std::shared_ptr<ImageBudget> const& budget, std::shared_ptr<std::atomic_bool> const& cancelled) {
    require(!cancelled->load());
    Uri uri(value);
    auto deadline = GetTickCount64() + 15000;
    Internet session(WinHttpOpen(L"Morrow-Mail-Reader", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
    require(WinHttpSetTimeouts(session.value, 5000, 5000, 5000, 5000));
    auto port = uri.Port();
    if (port < 0) port = INTERNET_DEFAULT_HTTPS_PORT;
    require(port > 0 && port <= 65535);
    Internet connection(WinHttpConnect(session.value, uri.Host().c_str(), static_cast<INTERNET_PORT>(port), 0));
    auto path = uri.Path() + uri.Query();
    Internet request(WinHttpOpenRequest(connection.value, L"GET", path.c_str(), nullptr,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE));
    DWORD disabled = WINHTTP_DISABLE_REDIRECTS | WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_AUTHENTICATION;
    require(WinHttpSetOption(request.value, WINHTTP_OPTION_DISABLE_FEATURE, &disabled, sizeof disabled));
    require(!cancelled->load() && WinHttpSendRequest(request.value, L"Accept: image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp\r\nAccept-Encoding: identity\r\n", -1L,
        WINHTTP_NO_REQUEST_DATA, 0, 0, 0));
    require(!cancelled->load() && GetTickCount64() < deadline && WinHttpReceiveResponse(request.value, nullptr));
    DWORD status = 0, length = sizeof status;
    require(WinHttpQueryHeaders(request.value, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &status, &length, WINHTTP_NO_HEADER_INDEX) && status == 200);
    wchar_t mime[256]{}; length = sizeof mime;
    require(WinHttpQueryHeaders(request.value, WINHTTP_QUERY_CONTENT_TYPE, WINHTTP_HEADER_NAME_BY_INDEX,
        mime, &length, WINHTTP_NO_HEADER_INDEX));
    auto type = lower(hstring(mime));
    type = type.substr(0, type.find(L';'));
    require(type == L"image/png" || type == L"image/jpeg" || type == L"image/gif"
        || type == L"image/webp" || type == L"image/avif" || type == L"image/bmp");
    Image result; result.type = hstring(type);
    uint8_t buffer[8192];
    while (true) {
        require(!cancelled->load() && GetTickCount64() < deadline);
        DWORD received = 0;
        require(WinHttpReadData(request.value, buffer, sizeof buffer, &received));
        if (!received) break;
        require(result.bytes.size() + received <= maxImageBytes
            && budget->bytes.fetch_add(received) + received <= maxMessageImageBytes);
        result.bytes.insert(result.bytes.end(), buffer, buffer + received);
    }
    require(!result.bytes.empty());
    return result;
}

struct Reader {
    std::weak_ptr<Shell> shell;
    uint64_t generation{}, selection{}, documentId{}, completedDocumentId{}, epoch = 0;
    unsigned fixtureTraceBudget = 0; // Enabled only after the temporary fixture marker is validated.
    // Observed initialization outcome only; these never relax reader policy.
    hresult initializationError{S_OK};
    bool runtimeUnavailable = false;
    hstring viewOwner, account, messageId, html, serviceOrigin, expectedDocumentBase64;
    std::filesystem::path profilePath;
    bool active = true, ready = false, initializing = false, plain = false, images = false, hasImages = false;
    bool expectingDocument = false, imageReview = false;
    std::shared_ptr<ImageBudget> budget = std::make_shared<ImageBudget>();
    std::shared_ptr<std::atomic_bool> cancelled = std::make_shared<std::atomic_bool>(false);
    weak_ref<WebView2> view;
    // Keep the label peers alive while mounted; the native visual tree alone
    // does not preserve weak WinRT peers. These labels have no Reader callbacks.
    TextBlock fallback{nullptr}, notice{nullptr};
    weak_ref<Button> imageButton;
    weak_ref<CheckBox> plainButton;
    CoreWebView2 core{nullptr};
    CoreWebView2Environment environment{nullptr};
    bool live() const {
        auto host = shell.lock();
        return active && host && host->current(generation, viewOwner) && host->selectionGeneration == selection
            && host->section == L"mail" && text(host->selected, L"accountId") == account
            && text(host->selected, L"id") == messageId;
    }
    void fixtureState(char const* phase) noexcept {
        if (!fixtureTraceBudget) return;
        --fixtureTraceBudget;
        try {
            auto target = view.get();
            std::fprintf(stderr, "Native reader: %s active=%u ready=%u live=%u expected=%u core=%u view=%u loaded=%u visible=%u id=%llu completed=%llu epoch=%llu\n",
                phase, unsigned(active), unsigned(ready), unsigned(live()), unsigned(expectingDocument), unsigned(bool(core)),
                unsigned(bool(target)), unsigned(target && target.IsLoaded()),
                unsigned(target && target.Visibility() == xaml::Visibility::Visible),
                static_cast<unsigned long long>(documentId), static_cast<unsigned long long>(completedDocumentId),
                static_cast<unsigned long long>(epoch));
            std::fflush(stderr);
        } catch (...) { /* Diagnostics must not replace the original runtime failure. */ }
    }
    void say(hstring const& value) { if (notice) notice.Text(value); }
    void close() {
        cancelled->store(true);
        active = false; images = false; ready = false; ++epoch;
        expectingDocument = false; expectedDocumentBase64 = {};
        if (auto target = view.get()) { try { target.Close(); } catch (hresult_error const&) {} }
        core = nullptr; environment = nullptr;
    }
    void unload() {
        close();
        fallback = nullptr; notice = nullptr;
    }
    void fail() {
        if (fallback) fallback.Visibility(xaml::Visibility::Visible);
        if (auto target = view.get()) target.Visibility(xaml::Visibility::Collapsed);
        if (auto target = imageButton.get()) target.IsEnabled(false);
        if (auto target = plainButton.get()) target.IsEnabled(false);
        say(L"Formatted mail is unavailable. Plain text remains available; external image loading has stopped.");
        close();
    }
    void render() {
        fixtureState("render-request");
        if (!live() || !ready) return;
        cancelled->store(true); cancelled = std::make_shared<std::atomic_bool>(false);
        ++epoch; expectingDocument = false; expectedDocumentBase64 = {};
        if (auto target = view.get()) {
            target.Visibility(plain ? xaml::Visibility::Collapsed : xaml::Visibility::Visible);
            if (fallback) fallback.Visibility(plain ? xaml::Visibility::Visible : xaml::Visibility::Collapsed);
            if (auto image = imageButton.get()) {
                image.Visibility(plain || !hasImages ? xaml::Visibility::Collapsed : xaml::Visibility::Visible);
                image.Content(box_value(images ? L"Hide External Images" : L"Load External Images…"));
            }
            say(plain ? L"Plain text. External images are blocked." : images
                ? L"External images enabled for this message. Some images may be omitted by the size, format, or request limits."
                : L"External images blocked. Scripts, forms, and embedded content are disabled.");
            // Switching to plain text cancels the HTML document and its pending
            // requests rather than merely hiding a still-networked surface.
            auto content = document(plain ? hstring{} : html, images && !plain);
            expectedDocumentBase64 = documentBase64(content);
            if (expectedDocumentBase64.empty()) { fail(); return; }
            expectingDocument = true;
            try { target.NavigateToString(content); }
            catch (hresult_error const&) { fail(); return; }
            fixtureState("render-returned");
        }
    }
};

IAsyncAction openLink(std::shared_ptr<Reader> state, hstring destination) {
    if (!state->live() || !allowedUrl(destination, state->serviceOrigin, false)) co_return;
    auto shell = state->shell.lock();
    try {
        bool approved = co_await shell->confirm(L"Open this email link?", destination, L"Open Link");
        if (!approved || !state->live() || !allowedUrl(destination, state->serviceOrigin, false)) co_return;
        auto launched = co_await Windows::System::Launcher::LaunchUriAsync(Uri(destination));
        if (!launched && state->live()) state->say(L"Windows could not open that destination.");
    } catch (hresult_error const&) { if (state->live()) state->say(L"The link could not be opened."); }
}
IAsyncAction consentImages(std::shared_ptr<Reader> state) {
    if (!state->live() || !state->ready || state->plain || state->imageReview) co_return;
    if (state->images) { state->images = false; state->render(); co_return; }
    auto shell = state->shell.lock();
    state->imageReview = true;
    try {
        bool approved = co_await shell->confirm(L"Load external images for this message?",
            L"The sender’s HTTPS image servers may learn your IP address and that you opened this email. This permission applies only to this message. Cookies and sign-in credentials are not sent; redirects and non-image content are blocked.", L"Load Images");
        if (approved && state->live() && state->ready && !state->plain) { state->images = true; state->render(); }
    } catch (hresult_error const&) { if (state->live()) state->say(L"External images remain blocked."); }
    state->imageReview = false;
}
IAsyncAction imageResponse(std::shared_ptr<Reader> state, CoreWebView2WebResourceRequestedEventArgs args) {
    auto deferral = args.GetDeferral();
    auto epoch = state->epoch;
    auto url = args.Request().Uri();
    auto budget = state->budget;
    auto cancelled = state->cancelled;
    apartment_context ui;
    Image result;
    bool fetched = false;
    co_await resume_background();
    try { result = fetchImage(url, budget, cancelled); fetched = true; } catch (...) { /* The default response stays denied. */ }
    co_await ui;
    try {
        if (fetched && state->live() && state->ready && !state->plain && state->images && state->epoch == epoch) {
            InMemoryRandomAccessStream stream;
            DataWriter writer(stream);
            writer.WriteBytes(array_view<uint8_t const>(result.bytes));
            co_await writer.StoreAsync(); writer.DetachStream(); stream.Seek(0);
            if (state->live() && state->images && !state->plain && state->epoch == epoch) {
                args.Response(state->environment.CreateWebResourceResponse(stream, 200, L"OK",
                    L"Content-Type: " + result.type + L"\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"));
            }
        }
    } catch (hresult_error const&) { if (state->live()) state->say(L"An external image could not be displayed."); }
    try { deferral.Complete(); } catch (hresult_error const&) { /* A closed reader has no remaining request. */ }
}

IAsyncAction initialize(std::shared_ptr<Reader> state) {
    if (!state->live() || state->ready || state->initializing) co_return;
    auto view = state->view.get();
    if (!view) co_return;
    state->initializing = true;
    try {
        CoreWebView2EnvironmentOptions options;
        options.AllowSingleSignOnUsingOSPrimaryAccount(false);
        options.AreBrowserExtensionsEnabled(false);
        auto environment = co_await CoreWebView2Environment::CreateWithOptionsAsync(L"", hstring(state->profilePath.wstring()), options);
        if (!state->live()) { state->initializing = false; state->close(); co_return; }
        state->environment = environment;
        auto controller = state->environment.CreateCoreWebView2ControllerOptions();
        controller.ProfileName(L"MorrowMailReader"); controller.IsInPrivateModeEnabled(true);
        co_await view.EnsureCoreWebView2Async(state->environment, controller);
        if (!state->live()) { state->initializing = false; state->close(); co_return; }
        state->core = view.CoreWebView2();
        require(state->core && state->core.Profile().IsInPrivateModeEnabled());
        auto settings = state->core.Settings();
        settings.IsScriptEnabled(false); settings.IsWebMessageEnabled(false); settings.AreHostObjectsAllowed(false);
        settings.AreDefaultScriptDialogsEnabled(false); settings.AreDevToolsEnabled(false);
        settings.AreDefaultContextMenusEnabled(false); settings.AreBrowserAcceleratorKeysEnabled(false);
        settings.IsStatusBarEnabled(false); settings.IsBuiltInErrorPageEnabled(false);
        settings.IsGeneralAutofillEnabled(false); settings.IsPasswordAutosaveEnabled(false);
        settings.IsSwipeNavigationEnabled(false);
        auto weak = std::weak_ptr<Reader>(state);
        state->core.NavigationStarting([weak](auto const&, CoreWebView2NavigationStartingEventArgs const& args) {
            auto page = weak.lock();
            args.Cancel(true);
            if (page && page->fixtureTraceBudget) {
                --page->fixtureTraceBudget;
                std::fprintf(stderr, "Native reader: nav-start id=%llu blank=%u redirected=%u user=%u expected=%u live=%u\n",
                    static_cast<unsigned long long>(args.NavigationId()), unsigned(args.Uri() == L"about:blank"),
                    unsigned(args.IsRedirected()), unsigned(args.IsUserInitiated()), unsigned(page->expectingDocument), unsigned(page->live()));
                std::fflush(stderr);
                if (page->fixtureTraceBudget) {
                    --page->fixtureTraceBudget;
                    auto uri = args.Uri();
                    auto prefix = lower(hstring(std::wstring_view(uri).substr(0, 96)));
                    bool dataHtml = prefix.starts_with(L"data:text/html,") || prefix.starts_with(L"data:text/html;");
                    bool base64 = dataHtml && prefix.find(L";base64,") != std::wstring::npos;
                    bool aboutBlank = prefix.starts_with(L"about:blank");
                    std::fprintf(stderr, "Native reader: nav-uri empty=%u dataHtml=%u dataHtmlBase64=%u aboutBlankPrefix=%u other=%u length=%u\n",
                        unsigned(uri.empty()), unsigned(dataHtml), unsigned(base64), unsigned(aboutBlank),
                        unsigned(!uri.empty() && !dataHtml && !aboutBlank), unsigned(uri.size()));
                    std::fflush(stderr);
                }
            }
            if (!page || !page->live()) return;
            // NavigateToString may expose the HTML data URI in this event even
            // though the resulting document has about:blank origin.
            if (page->expectingDocument && !args.IsRedirected() && matchesDocument(args.Uri(), page->expectedDocumentBase64)) {
                page->expectingDocument = false; page->expectedDocumentBase64 = {};
                page->documentId = args.NavigationId(); args.Cancel(false);
            } else if (args.IsUserInitiated()) openLink(page, args.Uri());
            if (page->fixtureTraceBudget) {
                --page->fixtureTraceBudget;
                std::fprintf(stderr, "Native reader: nav-decision id=%llu cancelled=%u expected=%u tracked=%llu\n",
                    static_cast<unsigned long long>(args.NavigationId()), unsigned(args.Cancel()), unsigned(page->expectingDocument),
                    static_cast<unsigned long long>(page->documentId));
                std::fflush(stderr);
            }
        });
        state->core.NewWindowRequested([weak](auto const&, CoreWebView2NewWindowRequestedEventArgs const& args) {
            args.Handled(true);
            if (auto page = weak.lock(); page && page->live() && args.IsUserInitiated()) openLink(page, args.Uri());
        });
        state->core.PermissionRequested([](auto const&, CoreWebView2PermissionRequestedEventArgs const& args) { args.State(CoreWebView2PermissionState::Deny); });
        state->core.DownloadStarting([](auto const&, CoreWebView2DownloadStartingEventArgs const& args) { args.Cancel(true); args.Handled(true); });
        state->core.BasicAuthenticationRequested([](auto const&, CoreWebView2BasicAuthenticationRequestedEventArgs const& args) { args.Cancel(true); });
        state->core.LaunchingExternalUriScheme([weak](auto const&, CoreWebView2LaunchingExternalUriSchemeEventArgs const& args) {
            args.Cancel(true);
            if (auto page = weak.lock(); page && page->live() && args.IsUserInitiated()) openLink(page, args.Uri());
        });
        state->core.AddWebResourceRequestedFilter(L"*", CoreWebView2WebResourceContext::All);
        state->core.WebResourceRequested([weak](auto const& sender, CoreWebView2WebResourceRequestedEventArgs const& args) {
            // Deny first, including stale readers and all document/frame/service
            // URLs. A bounded native fetch may replace only this image response.
            try {
                auto core = sender.template as<CoreWebView2>();
                args.Response(core.Environment().CreateWebResourceResponse(nullptr, 403, L"Blocked", L"Cache-Control: no-store\r\n"));
                auto page = weak.lock();
                if (!page || !page->live() || !page->ready || page->plain || !page->images
                    || args.ResourceContext() != CoreWebView2WebResourceContext::Image
                    || args.Request().Method() != L"GET" || !allowedUrl(args.Request().Uri(), page->serviceOrigin, true)) return;
                if (page->budget->requests >= maxImages || page->budget->bytes.load() >= maxMessageImageBytes) return;
                ++page->budget->requests; imageResponse(page, args);
            } catch (...) { if (auto page = weak.lock()) page->fail(); }
        });
        state->core.NavigationCompleted([weak](auto const&, CoreWebView2NavigationCompletedEventArgs const& args) {
            if (auto page = weak.lock(); page && page->fixtureTraceBudget) {
                --page->fixtureTraceBudget;
                std::fprintf(stderr, "Native reader: nav-completed id=%llu success=%u error=%d live=%u tracked=%llu\n",
                    static_cast<unsigned long long>(args.NavigationId()), unsigned(args.IsSuccess()), int(args.WebErrorStatus()),
                    unsigned(page->live()), static_cast<unsigned long long>(page->documentId));
                std::fflush(stderr);
            }
            if (auto page = weak.lock(); page && page->live() && page->documentId == args.NavigationId()) {
                if (args.IsSuccess()) page->completedDocumentId = args.NavigationId();
                else page->fail();
            }
        });
        state->core.ProcessFailed([weak](auto const&, auto const&) { if (auto page = weak.lock()) page->fail(); });
        state->ready = true;
        if (auto images = state->imageButton.get()) images.IsEnabled(true);
        state->render();
    } catch (hresult_error const& error) {
        state->initializationError = error.code();
        state->runtimeUnavailable = !state->environment && error.code() == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
        if (state->live()) state->fail();
        else { try { view.Close(); } catch (hresult_error const&) {} }
    } catch (...) {
        state->initializationError = E_FAIL;
        if (state->live()) state->fail();
        else { try { view.Close(); } catch (hresult_error const&) {} }
    }
    state->initializing = false;
}

std::shared_ptr<Reader> mountReader(std::shared_ptr<Shell> shell, StackPanel const& panel, Json const& message) {
    auto plain = label(text(message, L"body"), 15);
    auto html = text(message, L"bodyHtml");
    if (html.empty() || html.size() > 512 * 1024) { panel.Children().Append(plain); return {}; }
    try {
        auto state = std::make_shared<Reader>();
        state->shell = shell; state->generation = shell->generation; state->selection = shell->selectionGeneration;
        state->viewOwner = shell->owner; state->account = text(message, L"accountId"); state->messageId = text(message, L"id");
        state->html = html; state->serviceOrigin = shell->service->origin();
        state->hasImages = std::wstring_view(html).find(L"<img") != std::wstring_view::npos;
        state->profilePath = shell->service->directory() / L"reader-webview2";
        state->fallback = plain;
        auto reader = stack(8);
        auto toolbar = stack(); toolbar.Orientation(Orientation::Horizontal);
        CheckBox plainToggle; plainToggle.Content(box_value(L"Plain text")); state->plainButton = make_weak(plainToggle);
        toolbar.Children().Append(plainToggle);
        auto images = button(L"Load External Images…", [state] { consentImages(state); });
        images.IsEnabled(false); state->imageButton = make_weak(images);
        if (!state->hasImages) images.Visibility(xaml::Visibility::Collapsed);
        toolbar.Children().Append(images); reader.Children().Append(toolbar);
        auto notice = label(L"Loading formatted mail. External images are blocked.", 12); state->notice = notice;
        reader.Children().Append(notice);
        // A bounded viewport lets the HTML surface itself scroll under the cursor.
        // No script bridge or injected measurement script is needed.
        WebView2 web; web.Height(480); web.HorizontalAlignment(xaml::HorizontalAlignment::Stretch);
        web.Visibility(xaml::Visibility::Collapsed);
        web.DefaultBackgroundColor(Windows::UI::Color{255, 255, 255, 255});
        xaml::Automation::AutomationProperties::SetName(web, L"Formatted email content");
        state->view = make_weak(web); reader.Children().Append(web); reader.Children().Append(plain);
        plainToggle.Checked([state](auto const&, auto const&) { state->plain = true; state->images = false; state->render(); });
        plainToggle.Unchecked([state](auto const&, auto const&) { state->plain = false; state->render(); });
        reader.Loaded([state](auto const&, auto const&) { initialize(state); });
        reader.Unloaded([state](auto const&, auto const&) { state->unload(); });
        panel.Children().Append(reader);
        return state;
    } catch (hresult_error const&) {
        panel.Children().Append(label(L"Formatted mail is unavailable. Plain text remains available.", 12));
        panel.Children().Append(label(text(message, L"body"), 15));
    }
    return {};
}
}

void appendReader(std::shared_ptr<Shell> shell, StackPanel const& panel, Json message) {
    mountReader(std::move(shell), panel, message);
}

namespace {
void runtimeCheck(bool condition, wchar_t const* message) {
    if (!condition) throw hresult_error(E_FAIL, message);
}
IAsyncAction runtimeWait(std::function<bool()> done, uint64_t deadline, wchar_t const* phase) {
    apartment_context ui;
    auto cancellation = co_await get_cancellation_token();
    for (;;) {
        if (cancellation()) throw hresult_canceled();
        if (GetTickCount64() >= deadline) throw hresult_error(HRESULT_FROM_WIN32(ERROR_TIMEOUT),
            L"Reader runtime acceptance timed out at " + hstring(phase) + L" (25-second total deadline).");
        if (done()) co_return;
        co_await resume_after(std::chrono::milliseconds(20));
        co_await ui;
    }
}
IAsyncOperation<Json> runtimeProtocol(CoreWebView2 core, hstring method, hstring parameters, uint64_t deadline, wchar_t const* phase) {
    // Fixture-only native DOM/CSP inspection; never inject executable script.
    auto operation = core.CallDevToolsProtocolMethodAsync(method, parameters);
    struct Cancel {
        IAsyncOperation<hstring> operation;
        ~Cancel() { try { if (operation.Status() == AsyncStatus::Started) operation.Cancel(); } catch (...) {} }
    } cancel{operation};
    co_await runtimeWait([operation] { return operation.Status() != AsyncStatus::Started; }, deadline, phase);
    auto result = operation.GetResults();
    runtimeCheck(result.size() <= 32768, L"Reader runtime assertion returned oversized data.");
    auto response = Json::Parse(result);
    runtimeCheck(!response.HasKey(L"error"), L"The native reader inspection failed.");
    co_return response;
}
IAsyncOperation<int32_t> runtimeNode(CoreWebView2 core, hstring selector, uint64_t deadline) {
    auto document = co_await runtimeProtocol(core, L"DOM.getDocument", L"{\"depth\":1}", deadline, L"dom-document");
    Json query; query.Insert(L"nodeId", document.GetNamedObject(L"root").GetNamedValue(L"nodeId")); put(query, L"selector", selector);
    auto response = co_await runtimeProtocol(core, L"DOM.querySelector", query.Stringify(), deadline, L"dom-query");
    auto id = response.GetNamedNumber(L"nodeId");
    runtimeCheck(id > 0 && id <= INT32_MAX, L"Native reader fixture node was not found.");
    co_return static_cast<int32_t>(id);
}
IAsyncOperation<Json> runtimeAttributes(CoreWebView2 core, hstring selector, uint64_t deadline) {
    auto id = co_await runtimeNode(core, selector, deadline);
    Json query; query.Insert(L"nodeId", Value::CreateNumberValue(id));
    auto response = co_await runtimeProtocol(core, L"DOM.getAttributes", query.Stringify(), deadline, L"dom-attributes");
    auto values = response.GetNamedArray(L"attributes");
    runtimeCheck(values.Size() <= 128 && values.Size() % 2 == 0, L"Native reader attributes exceeded their fixture bound.");
    Json attributes;
    for (uint32_t i = 0; i < values.Size(); i += 2) attributes.Insert(values.GetStringAt(i), Value::CreateStringValue(values.GetStringAt(i + 1)));
    co_return attributes;
}
bool documentReady(std::shared_ptr<Reader> const& state) {
    return state->ready && !state->expectingDocument && state->documentId
        && state->completedDocumentId == state->documentId;
}
void checkFallback(std::shared_ptr<Reader> const& state, hstring const& body) {
    auto plain = state->fallback; auto view = state->view.get();
    runtimeCheck(bool(plain), L"Reader fallback: textBlockMissing.");
    runtimeCheck(plain.Text() == body, L"Reader fallback: bodyMismatch.");
    runtimeCheck(plain.IsLoaded(), L"Reader fallback: plainNotLoaded.");
    runtimeCheck(plain.Visibility() == xaml::Visibility::Visible, L"Reader fallback: plainNotVisible.");
    runtimeCheck(bool(view), L"Reader fallback: webViewMissing.");
    runtimeCheck(view.Visibility() == xaml::Visibility::Collapsed, L"Reader fallback: webViewNotCollapsed.");
    runtimeCheck(!state->images, L"Reader fallback: imagesEnabled.");
}
struct RuntimeProbe {
    unsigned requests = 0, messages = 0, auditEvents = 0, cspFlags = 0;
    bool resourceLeak = false, navigationLeak = false, callbackFailure = false, staleNavigation = false;
    bool collectCsp = false;
    hstring expectedDocumentBase64;
};
struct RuntimeCleanup {
    std::shared_ptr<Shell> shell;
    uint64_t generation;
    Json selection;
    hstring section;
    winrt::Windows::Foundation::IInspectable content;
    bool loading;
    std::vector<std::shared_ptr<Reader>> readers;
    CoreWebView2 core{nullptr};
    event_token resource{}, navigation{}, message{};
    CoreWebView2DevToolsProtocolEventReceiver audits{nullptr};
    event_token audit{};
    bool observing = false;
    ~RuntimeCleanup() {
        // Keep the final deny installed until the browser has closed.
        for (auto const& state : readers) state->unload();
        if (audits) { try { audits.DevToolsProtocolEventReceived(audit); } catch (...) {} }
        if (observing && core) {
            try { core.WebResourceRequested(resource); } catch (...) {}
            try { core.NavigationStarting(navigation); } catch (...) {}
            try { core.WebMessageReceived(message); } catch (...) {}
        }
        try {
            if (!shell->closing && shell->generation == generation) {
                shell->selected = selection; shell->section = section; shell->loading = loading;
                ++shell->selectionGeneration; // Never resurrect an older asynchronous read.
                shell->page.Content(content);
            }
        } catch (...) {}
    }
};
}

// Native smoke hook only. The caller must navigate again after this temporary
// mounted reader: selection metadata is restored, but old reader work stays stale.
IAsyncOperation<Json> readerRuntimeChecks(std::shared_ptr<Shell> shell) {
    namespace fs = std::filesystem;
    runtimeCheck(shell && shell->service && !shell->closing && !shell->loading && !shell->dialogOpen
        && shell->dirty.empty(), L"Reader runtime acceptance requires an idle fixture shell.");
    auto directory = fs::canonical(shell->service->directory());
    runtimeCheck(directory.parent_path() == fs::canonical(fs::temp_directory_path())
        && directory.filename().wstring().starts_with(L"morrow-native-check-"),
        L"Reader runtime acceptance requires an isolated temporary workspace.");
    auto markerPath = directory / L"disposable-native-fixture";
    runtimeCheck(fs::is_regular_file(fs::symlink_status(markerPath)) && fs::file_size(markerPath) <= 64,
        L"Reader runtime fixture marker is missing or invalid.");
    std::ifstream marker(markerPath, std::ios::binary);
    std::string markerText((std::istreambuf_iterator<char>(marker)), {});
    runtimeCheck(markerText == "Morrow native acceptance fixture", L"Reader runtime fixture marker does not match.");
    auto cancellation = co_await get_cancellation_token(); cancellation.enable_propagation();
    auto startedAt = GetTickCount64();
    auto deadline = startedAt + 25000;
    // Fixed fixture phases and booleans only: no content, URLs or workspace paths.
    auto phase = [startedAt](char const* name) {
        std::fprintf(stderr, "Native reader: %s +%llu ms\n", name,
            static_cast<unsigned long long>(GetTickCount64() - startedAt));
        std::fflush(stderr);
    };
    RuntimeCleanup cleanup{shell, shell->generation, shell->selected, shell->section, shell->page.Content(), shell->loading};
    shell->loading = true; shell->section = L"mail"; ++shell->selectionGeneration;
    Json fixture;
    put(fixture, L"accountId", L"reader@fixture.invalid"); put(fixture, L"id", L"reader-runtime-fixture");
    put(fixture, L"body", L"Fictional reader acceptance text. No mailbox content.");
    // The initial production navigation is inert. Adversarial markup is supplied
    // only after all production handlers AND the fixture last-deny are installed.
    put(fixture, L"bodyHtml", L"<p id='reader-fixture-ready'>Fictional formatted mail.</p><img id='reader-empty-image'>");
    shell->selected = fixture;
    auto panel = stack(8);
    auto state = mountReader(shell, panel, fixture);
    runtimeCheck(state != nullptr, L"The production reader could not mount its fixture.");
    state->fixtureTraceBudget = 24;
    cleanup.readers.push_back(state);
    shell->show(scroll(panel));
    phase("mount-loaded");
    co_await runtimeWait([state] { return state->initializing || state->ready || !state->active; }, deadline, L"mount-loaded");
    if (state->active) {
        phase("environment");
        co_await runtimeWait([state] { return state->environment || !state->active; }, deadline, L"environment");
    }
    if (state->active) {
        phase("controller-ready");
        co_await runtimeWait([state] { return state->ready || !state->active; }, deadline, L"controller-ready");
    }
    if (state->active) {
        phase("initial-document");
        state->fixtureState("initial-document-state");
        try {
            co_await runtimeWait([state] { return documentReady(state) || !state->active; }, deadline, L"initial-document");
        } catch (hresult_error const&) {
            state->fixtureState("initial-document-failed");
            throw;
        }
    }
    Json result;
    if (!state->ready) {
        checkFallback(state, text(fixture, L"body"));
        runtimeCheck(!state->active && state->cancelled->load() && !state->core
            && !state->imageButton.get().IsEnabled() && !state->plainButton.get().IsEnabled(),
            L"Unavailable reader did not close and disable its HTML controls.");
        if (!state->runtimeUnavailable)
            throw hresult_error(state->initializationError != S_OK ? state->initializationError : hresult(E_FAIL),
                L"Reader runtime initialization failed; this is not a missing-runtime acceptance pass.");
        put(result, L"htmlRuntime", L"unavailable"); put(result, L"fallback", L"passed");
        put(result, L"staleClose", L"not_run");
        put(result, L"reason", L"WebView2 environment was not found. HTML runtime checks did not run.");
        phase("runtime-unavailable-fallback");
        co_return result;
    }
    runtimeCheck(state->live() && documentReady(state), L"The initial fixture HTML document is not ready.");
    std::fprintf(stderr, "Native milestone: html-ready\n"); std::fflush(stderr);
    auto browserVersion = state->environment.BrowserVersionString();
    runtimeCheck(browserVersion.size() <= 64 && std::regex_match(browserVersion.begin(), browserVersion.end(),
        std::wregex(LR"([0-9]{1,10}(\.[0-9]{1,10}){3}( (beta|dev|canary))?)")),
        L"The fixture WebView2 runtime returned an unsupported version format.");
    put(result, L"browserVersionString", browserVersion);
    phase("isolation-settings");
    runtimeCheck(!state->expectingDocument && state->expectedDocumentBase64.empty(), L"The reader retained a consumed HTML navigation expectation.");
    auto core = state->core; cleanup.core = core;
    auto settings = core.Settings();
    runtimeCheck(core.Profile().IsInPrivateModeEnabled() && !settings.IsScriptEnabled()
        && !settings.IsWebMessageEnabled() && !settings.AreHostObjectsAllowed()
        && !settings.AreDevToolsEnabled() && !settings.IsGeneralAutofillEnabled() && !settings.IsPasswordAutosaveEnabled(),
        L"The live WebView2 reader did not retain production isolation settings.");
    state->imageButton.get().IsEnabled(false); // This fixture never grants image consent.
    auto probe = std::make_shared<RuntimeProbe>();
    auto weak = std::weak_ptr<Reader>(state);
    cleanup.resource = core.WebResourceRequested([probe, weak](auto const& sender, CoreWebView2WebResourceRequestedEventArgs const& args) {
        ++probe->requests;
        bool denied = false;
        try { auto response = args.Response(); denied = response && response.StatusCode() == 403; } catch (...) {}
        if (!denied) probe->resourceLeak = true;
        try {
            // Observe production's decision first, then deny regardless. Never
            // let an assertion failure generate DNS/TLS/provider traffic.
            args.Response(sender.template as<CoreWebView2>().Environment().CreateWebResourceResponse(nullptr, 403, L"Fixture blocked", L"Cache-Control: no-store\r\n"));
        } catch (...) { probe->callbackFailure = true; if (auto page = weak.lock()) page->close(); }
    });
    cleanup.navigation = core.NavigationStarting([probe](auto const&, CoreWebView2NavigationStartingEventArgs const& args) {
        if (!args.IsRedirected() && matchesDocument(args.Uri(), probe->expectedDocumentBase64)) {
            probe->expectedDocumentBase64 = {};
            return; // Independently match the fixture's exact next HTML load.
        }
        if (!args.Cancel()) probe->navigationLeak = true;
        if (args.Uri() == L"https://127.0.0.1:65534/morrow-reader-fixture/stale") probe->staleNavigation = true;
        args.Cancel(true);
    });
    cleanup.message = core.WebMessageReceived([probe](auto const&, auto const&) { ++probe->messages; });
    cleanup.observing = true;
    // Literal loopback URLs cannot cause external DNS/preconnect traffic either;
    // no server is started, and both production and fixture must block requests.
    state->html = L"<p id='reader-fixture-body'>Fictional formatted mail.</p>"
        L"<script>document.documentElement.dataset.readerInline='ran';window.chrome.webview.postMessage('forbidden-inline');</script>"
        L"<img id='reader-initial-image' src='https://127.0.0.1:65534/morrow-reader-fixture/initial.png' onerror=\"document.documentElement.dataset.readerHandler='ran'\">"
        L"<iframe src='https://127.0.0.1:65534/morrow-reader-fixture/initial-frame'></iframe>"
        L"<img id='reader-probe-image' onerror=\"document.documentElement.dataset.readerHandler='ran'\"><iframe id='reader-probe-frame'></iframe>";
    phase("html-document");
    probe->expectedDocumentBase64 = documentBase64(document(state->html, false));
    state->render();
    co_await runtimeWait([state] { return documentReady(state) || !state->active; }, deadline, L"html-document");
    runtimeCheck(state->live() && documentReady(state), L"The actual HTML reader failed to load its fixture document.");
    runtimeCheck(state->expectedDocumentBase64.empty() && probe->expectedDocumentBase64.empty(), L"The HTML navigation expectation was not consumed exactly once.");
    phase("script-sentinel");
    co_await runtimeNode(core, L"#reader-fixture-body", deadline);
    auto initial = co_await runtimeAttributes(core, L"html", deadline);
    runtimeCheck(!initial.HasKey(L"data-reader-inline") && !initial.HasKey(L"data-reader-handler"),
        L"Email script or an inline event handler executed in the live reader.");
    auto policy = co_await runtimeAttributes(core, L"meta[http-equiv='Content-Security-Policy']", deadline);
    auto policyText = std::wstring(text(policy, L"content"));
    runtimeCheck(policyText.find(L"script-src 'none';") != std::wstring::npos
        && policyText.find(L"connect-src 'none';") != std::wstring::npos,
        L"The mounted reader does not deny scripts and connections.");
    // Trigger image/frame policy checks through native DOM attributes. No host
    // fetch probe remains: the script execution path itself has been removed.
    phase("csp-observer");
    cleanup.audits = core.GetDevToolsProtocolEventReceiver(L"Audits.issueAdded");
    cleanup.audit = cleanup.audits.DevToolsProtocolEventReceived([probe, weak](auto const&, CoreWebView2DevToolsProtocolEventReceivedEventArgs const& args) {
        if (!probe->collectCsp) return;
        try {
            auto page = weak.lock();
            if (!page || !page->live() || ++probe->auditEvents > 64) { probe->callbackFailure = true; return; }
            if (!args.SessionId().empty()) return; // Only this fixture's top-level document.
            auto data = args.ParameterObjectAsJson();
            if (data.size() > 32768) { probe->callbackFailure = true; return; }
            auto issue = Json::Parse(data).GetNamedObject(L"issue");
            if (text(issue, L"code") != L"ContentSecurityPolicyIssue") return;
            auto details = issue.GetNamedObject(L"details").GetNamedObject(L"contentSecurityPolicyIssueDetails");
            if (details.GetNamedBoolean(L"isReportOnly", true)
                || text(details, L"contentSecurityPolicyViolationType") != L"kURLViolation") return;
            auto directive = text(details, L"violatedDirective"), url = text(details, L"blockedURL");
            if (directive == L"img-src" && url == L"https://127.0.0.1:65534/morrow-reader-fixture/probe.png") probe->cspFlags |= 2u;
            // Blink strips cross-origin frame-src report URLs to their origin.
            // This distinct probe origin cannot match a replayed initial-frame issue.
            if (directive == L"frame-src" && url == L"https://127.0.0.1:65533") probe->cspFlags |= 4u;
        } catch (...) { probe->callbackFailure = true; }
    });
    co_await runtimeProtocol(core, L"Audits.enable", L"{}", deadline, L"csp-observer");
    runtimeCheck(!settings.IsScriptEnabled() && !settings.AreDevToolsEnabled(), L"The CSP observer changed reader script or DevTools settings.");
    probe->collectCsp = true;
    phase("csp-probe-start");
    for (auto const& target : {std::pair{L"#reader-probe-image", L"https://127.0.0.1:65534/morrow-reader-fixture/probe.png"},
            {L"#reader-probe-frame", L"https://127.0.0.1:65533/morrow-reader-fixture/probe-frame"}}) {
        auto id = co_await runtimeNode(core, target.first, deadline);
        Json attributes; attributes.Insert(L"nodeId", Value::CreateNumberValue(id));
        put(attributes, L"name", L"src"); put(attributes, L"value", target.second);
        co_await runtimeProtocol(core, L"DOM.setAttributeValue", attributes.Stringify(), deadline, L"csp-probe-start");
    }
    phase("csp-settle");
    co_await runtimeWait([probe] { return probe->callbackFailure || probe->cspFlags == 6u; }, deadline, L"csp-settle");
    runtimeCheck(!probe->callbackFailure && probe->cspFlags == 6u, L"The native CSP observer did not establish both enforced resource blocks.");
    auto finalAttributes = co_await runtimeAttributes(core, L"html", deadline);
    runtimeCheck(!finalAttributes.HasKey(L"data-reader-inline") && !finalAttributes.HasKey(L"data-reader-handler"),
        L"The live reader executed mail script or an image handler.");
    probe->collectCsp = false;
    runtimeCheck(!probe->resourceLeak && !probe->navigationLeak && !probe->callbackFailure && !probe->messages
        && !state->images && state->budget->requests == 0 && state->budget->bytes.load() == 0,
        L"Reader isolation leaked a request/message or invoked native image fetching without consent.");
    auto previousCancellation = state->cancelled;
    phase("plain-document");
    probe->expectedDocumentBase64 = documentBase64(document({}, false));
    state->plainButton.get().IsChecked(true); // Execute the production toggle handler.
    co_await runtimeWait([state] { return documentReady(state) || !state->active; }, deadline, L"plain-document");
    runtimeCheck(state->live() && state->plain && previousCancellation->load(), L"Plain text did not cancel the previous HTML document.");
    runtimeCheck(state->expectedDocumentBase64.empty() && probe->expectedDocumentBase64.empty(), L"Plain text retained an HTML navigation expectation.");
    checkFallback(state, text(fixture, L"body"));
    phase("plain-empty-assertion");
    auto body = co_await runtimeNode(core, L"body", deadline);
    Json bodyQuery; bodyQuery.Insert(L"nodeId", Value::CreateNumberValue(body));
    auto empty = co_await runtimeProtocol(core, L"DOM.getOuterHTML", bodyQuery.Stringify(), deadline, L"plain-empty-assertion");
    runtimeCheck(text(empty, L"outerHTML") == L"<body></body>", L"Switching to plain text left email HTML active in WebView2.");
    ++shell->selectionGeneration;
    auto epoch = state->epoch;
    state->render();
    runtimeCheck(!state->live() && state->epoch == epoch, L"A stale reader rendered after selection changed.");
    phase("stale-navigation");
    core.Navigate(L"https://127.0.0.1:65534/morrow-reader-fixture/stale");
    co_await runtimeWait([probe] { return probe->staleNavigation; }, deadline, L"stale-navigation");
    runtimeCheck(!probe->navigationLeak, L"A stale reader permitted navigation.");
    phase("unload-close");
    panel.Children().Clear(); // Actual mounted Unloaded -> production close().
    co_await runtimeWait([state] { return !state->active; }, deadline, L"unload-close");
    runtimeCheck(!state->ready && !state->core && !state->environment && state->cancelled->load()
        && !state->expectingDocument && state->expectedDocumentBase64.empty(), L"Unloading the reader did not close its browser and cancel work.");
    runtimeCheck(!state->fallback && !state->notice, L"Unloading the reader retained its label peers.");
    bool closed = false;
    phase("closed-protocol");
    try { co_await runtimeProtocol(core, L"DOM.getDocument", L"{}", deadline, L"closed-protocol"); }
    catch (hresult_error const& error) {
        if (error.code() == HRESULT_FROM_WIN32(ERROR_TIMEOUT) || error.code() == E_ABORT) throw;
        closed = true;
    }
    runtimeCheck(closed, L"The closed WebView2 still accepted native DOM operations.");
    // Exercise the same explicit failure path while mounted, without changing
    // runtime configuration or starting another document/network operation.
    phase("failure-fallback");
    auto fallback = mountReader(shell, panel, fixture);
    runtimeCheck(fallback != nullptr, L"The fallback reader could not mount.");
    cleanup.readers.push_back(fallback); fallback->fail();
    co_await runtimeWait([fallback] { return fallback->fallback && fallback->fallback.IsLoaded(); }, deadline, L"failure-fallback");
    checkFallback(fallback, text(fixture, L"body"));
    runtimeCheck(!fallback->active && !fallback->core && fallback->cancelled->load()
        && !fallback->imageButton.get().IsEnabled() && !fallback->plainButton.get().IsEnabled(),
        L"The production failure path did not disable HTML and preserve plain text.");
    co_await runtimeWait([fallback] { return !fallback->initializing; }, deadline, L"failure-fallback");
    runtimeCheck(!probe->resourceLeak && !probe->navigationLeak && !probe->callbackFailure && !probe->messages
        && !state->images && state->budget->requests == 0, L"Reader isolation failed during cleanup.");
    put(result, L"htmlRuntime", L"passed"); put(result, L"fallback", L"passed");
    put(result, L"staleClose", L"passed"); put(result, L"script", L"blocked");
    put(result, L"webMessages", L"blocked"); put(result, L"hostObjects", L"disabled");
    put(result, L"images", L"blocked"); put(result, L"frames", L"blocked"); put(result, L"connect", L"policy-deny-script-disabled");
    put(result, L"cspEvidence", L"native-audits-image-frame");
    put(result, L"inspection", L"native-dom-no-script");
    result.Insert(L"interceptedRequests", Value::CreateNumberValue(probe->requests));
    result.Insert(L"nativeImageRequests", Value::CreateNumberValue(state->budget->requests));
    phase("passed");
    co_return result;
}

// Hook for the native smoke harness; no provider, browser, or network calls.
// Actual WebView2 isolation is checked separately by readerRuntimeChecks().
void readerSecurityChecks() {
    auto origin = hstring(L"http://127.0.0.1:38123");
    auto check = [](bool value) { if (!value) throw hresult_error(E_FAIL, L"Reader security contract failed."); };
    check(documentBase64(L"Fixture \u4fe1\U0001F4E7") == L"Rml4dHVyZSDkv6Hwn5On");
    auto expected = documentBase64(document(L"<p>Fixture \u4fe1\U0001F4E7</p>", false));
    check(!expected.empty());
    auto encodedUri = hstring(htmlBase64Prefix) + expected;
    check(matchesDocument(encodedUri, expected));
    check(matchesDocument(hstring(htmlUtf8Base64Prefix) + expected, expected));
    check(matchesDocument(L"DATA:TEXT/HTML;BASE64," + expected, expected));
    check(matchesDocument(L"data:text/html;charset=UTF-8;base64," + expected, expected));
    check(matchesDocument(L"DaTa:TeXt/HtMl;ChArSeT=UtF-8;BaSe64," + expected, expected));
    auto changedCase = std::wstring(expected);
    auto letter = std::find_if(changedCase.begin(), changedCase.end(), [](wchar_t c) { return (c >= L'A' && c <= L'Z') || (c >= L'a' && c <= L'z'); });
    check(letter != changedCase.end());
    *letter = static_cast<wchar_t>(*letter >= L'a' ? *letter - (L'a' - L'A') : *letter + (L'a' - L'A'));
    check(!matchesDocument(hstring(htmlUtf8Base64Prefix) + hstring(changedCase), expected));
    check(matchesDocument(L"about:blank", expected));
    check(!matchesDocument(encodedUri, {}));
    check(!matchesDocument(L"about:blank", {}));
    check(!matchesDocument(hstring(htmlBase64Prefix) + documentBase64(document(L"<p>Different mail</p>", false)), expected));
    for (auto prefix : {L"https://example.invalid/", L"data:application/xhtml+xml;base64,", L"data:text/plain;base64,",
        L"data:text/html;charset=utf-16;base64,", L"data:text/html,"}) check(!matchesDocument(hstring(prefix) + expected, expected));
    for (auto invalid : {L"", L"about:blank/", L"about:blank#unexpected", L"data:text/html;base64,%%%", L"data:text/html;base64,AA=A"})
        check(!matchesDocument(invalid, expected));
    for (auto suffix : {L"=", L"\n", L"#unexpected", L"%00"}) check(!matchesDocument(encodedUri + suffix, expected));
    check(!matchesDocument(hstring(htmlBase64Prefix) + hstring(std::wstring_view(expected).substr(0, expected.size() - 1)), expected));
    check(!matchesDocument(hstring(std::wstring(maxDocumentBase64 + htmlUtf8Base64Prefix.size() + 1, L'A')), expected));
    check(!matchesDocument(L"about:blank", hstring(std::wstring(maxDocumentBase64 + 1, L'A'))));
    check(documentBase64(hstring(std::wstring(maxDocumentBytes + 1, L'A'))).empty());
    check(documentBase64(hstring(std::wstring(maxDocumentBytes / 3 + 1, L'\u4fe1'))).empty());
    for (auto url : { L"https://example.invalid/mail", L"http://example.invalid/", L"mailto:person@example.invalid", L"tel:+85212345678" })
        check(allowedUrl(url, origin, false));
    for (auto url : { L"javascript:alert(1)", L"data:text/html,test", L"file:///C:/secret", L"ms-settings:privacy",
        L"https://user:secret@example.invalid/", L"https://example.invalid/%0a", L"https://example.invalid/\\a",
        L"https://example.invalid/%q0", L"https://example.invalid/\u202eexe", L"http://127.0.0.1:38123/api/state",
        L"https://localhost/", L"https://[::1]/", L"https://127.2.3.4/" }) check(!allowedUrl(url, origin, false));
    check(allowedUrl(L"https://example.invalid/a%20b.png", origin, true));
    for (auto url : { L"http://example.invalid/a.png", L"https://example.invalid/a.SVG", L"mailto:person@example.invalid", L"data:image/png,test" })
        check(!allowedUrl(url, origin, true));
    auto blocked = std::wstring(document(L"<p>hello</p>", false));
    auto consented = std::wstring(document(L"<p>hello</p>", true));
    check(blocked.find(L"img-src 'none'") != std::wstring::npos && consented.find(L"img-src https:") != std::wstring::npos);
    for (auto rule : { L"default-src 'none'", L"script-src 'none'", L"connect-src 'none'", L"frame-src 'none'", L"form-action 'none'", L"no-referrer" })
        check(blocked.find(rule) != std::wstring::npos && consented.find(rule) != std::wstring::npos);
}
}
