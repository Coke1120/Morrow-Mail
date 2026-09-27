#include "pch.h"
#include "Ui.h"
#include <winrt/Microsoft.Web.WebView2.Core.h>
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Windows.Storage.Streams.h>
#include <winrt/Windows.System.h>
#include <winhttp.h>
#include <atomic>
#include <cwctype>

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
    uint64_t generation{}, selection{}, documentId{}, epoch = 0;
    hstring viewOwner, account, messageId, html, serviceOrigin;
    std::filesystem::path profilePath;
    bool active = true, ready = false, initializing = false, plain = false, images = false, hasImages = false;
    bool expectingDocument = false, imageReview = false;
    std::shared_ptr<ImageBudget> budget = std::make_shared<ImageBudget>();
    std::shared_ptr<std::atomic_bool> cancelled = std::make_shared<std::atomic_bool>(false);
    weak_ref<WebView2> view;
    weak_ref<TextBlock> fallback, notice;
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
    void say(hstring const& value) { if (auto target = notice.get()) target.Text(value); }
    void close() {
        cancelled->store(true);
        active = false; images = false; ready = false; ++epoch;
        if (auto target = view.get()) { try { target.Close(); } catch (hresult_error const&) {} }
        core = nullptr; environment = nullptr;
    }
    void fail() {
        if (auto target = fallback.get()) target.Visibility(xaml::Visibility::Visible);
        if (auto target = view.get()) target.Visibility(xaml::Visibility::Collapsed);
        if (auto target = imageButton.get()) target.IsEnabled(false);
        if (auto target = plainButton.get()) target.IsEnabled(false);
        say(L"Formatted mail is unavailable. Plain text remains available; external image loading has stopped.");
        close();
    }
    void render() {
        if (!live() || !ready) return;
        cancelled->store(true); cancelled = std::make_shared<std::atomic_bool>(false);
        ++epoch; expectingDocument = true;
        if (auto target = view.get()) {
            target.Visibility(plain ? xaml::Visibility::Collapsed : xaml::Visibility::Visible);
            if (auto text = fallback.get()) text.Visibility(plain ? xaml::Visibility::Visible : xaml::Visibility::Collapsed);
            if (auto image = imageButton.get()) {
                image.Visibility(plain || !hasImages ? xaml::Visibility::Collapsed : xaml::Visibility::Visible);
                image.Content(box_value(images ? L"Hide External Images" : L"Load External Images…"));
            }
            say(plain ? L"Plain text. External images are blocked." : images
                ? L"External images enabled for this message. Some images may be omitted by the size, format, or request limits."
                : L"External images blocked. Scripts, forms, and embedded content are disabled.");
            // Switching to plain text cancels the HTML document and its pending
            // requests rather than merely hiding a still-networked surface.
            target.NavigateToString(document(plain ? hstring{} : html, images && !plain));
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
        state->environment = co_await CoreWebView2Environment::CreateWithOptionsAsync(L"", hstring(state->profilePath.wstring()), options);
        if (!state->live()) co_return;
        auto controller = state->environment.CreateCoreWebView2ControllerOptions();
        controller.ProfileName(L"MorrowMailReader"); controller.IsInPrivateModeEnabled(true);
        co_await view.EnsureCoreWebView2Async(state->environment, controller);
        if (!state->live()) { view.Close(); co_return; }
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
            if (!page || !page->live()) return;
            if (page->expectingDocument && args.Uri() == L"about:blank" && !args.IsRedirected() && !args.IsUserInitiated()) {
                page->expectingDocument = false; page->documentId = args.NavigationId(); args.Cancel(false);
            } else if (args.IsUserInitiated()) openLink(page, args.Uri());
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
            if (auto page = weak.lock(); page && page->live() && page->documentId == args.NavigationId() && !args.IsSuccess()) page->fail();
        });
        state->core.ProcessFailed([weak](auto const&, auto const&) { if (auto page = weak.lock()) page->fail(); });
        state->ready = true;
        if (auto images = state->imageButton.get()) images.IsEnabled(true);
        state->render();
    } catch (...) {
        if (state->live()) state->fail();
        else { try { view.Close(); } catch (hresult_error const&) {} }
    }
}
}

void appendReader(std::shared_ptr<Shell> shell, StackPanel const& panel, Json message) {
    auto plain = label(text(message, L"body"), 15);
    auto html = text(message, L"bodyHtml");
    if (html.empty() || html.size() > 512 * 1024) { panel.Children().Append(plain); return; }
    try {
        auto state = std::make_shared<Reader>();
        state->shell = shell; state->generation = shell->generation; state->selection = shell->selectionGeneration;
        state->viewOwner = shell->owner; state->account = text(message, L"accountId"); state->messageId = text(message, L"id");
        state->html = html; state->serviceOrigin = shell->service->origin();
        state->hasImages = std::wstring_view(html).find(L"<img") != std::wstring_view::npos;
        state->profilePath = shell->service->directory() / L"reader-webview2";
        state->fallback = make_weak(plain);
        auto reader = stack(8);
        auto toolbar = stack(); toolbar.Orientation(Orientation::Horizontal);
        CheckBox plainToggle; plainToggle.Content(box_value(L"Plain text")); state->plainButton = make_weak(plainToggle);
        toolbar.Children().Append(plainToggle);
        auto images = button(L"Load External Images…", [state] { consentImages(state); });
        images.IsEnabled(false); state->imageButton = make_weak(images);
        if (!state->hasImages) images.Visibility(xaml::Visibility::Collapsed);
        toolbar.Children().Append(images); reader.Children().Append(toolbar);
        auto notice = label(L"Loading formatted mail. External images are blocked.", 12); state->notice = make_weak(notice);
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
        reader.Unloaded([state](auto const&, auto const&) { state->close(); });
        panel.Children().Append(reader);
    } catch (hresult_error const&) {
        panel.Children().Append(label(L"Formatted mail is unavailable. Plain text remains available.", 12));
        panel.Children().Append(label(text(message, L"body"), 15));
    }
}

// Hook for the native smoke harness; no provider, browser, or network calls.
// Runtime interception/scrolling still needs the WebView2 acceptance fixture.
void readerSecurityChecks() {
    auto origin = hstring(L"http://127.0.0.1:38123");
    auto check = [](bool value) { if (!value) throw hresult_error(E_FAIL, L"Reader security contract failed."); };
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
