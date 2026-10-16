// Opt-in private compiler input only; never included by the normal vcxproj.
// Production Shell controls/events and Service async scheduling remain intact.
// The runner replaces only startup, service creation and blocking transport in
// copied source. No Rust service, real workspace, provider, model or HTML loads.
#include "pch.h"
#include "Ui.h"
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Provider.h>
#include <UIAutomation.h>
#include <atomic>
#include <array>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <mutex>
#include <optional>
#include <set>
#include <thread>
#include <cstdlib>

// This file is copied into the private fixture project only.
#pragma comment(lib, "UIAutomationCore.lib")
#pragma comment(lib, "OleAut32.lib")

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
namespace peers = xaml::Automation::Peers;
namespace provider = xaml::Automation::Provider;
// Registered synchronously in the copied Service async entry points, before
// they queue work. A drain therefore also observes not-yet-dispatched requests.
std::atomic_uint mailboxLatencyPendingRequests = 0;
namespace {
constexpr wchar_t const* owners[] = {L"alpha@latency.invalid", L"beta@latency.invalid"};
std::filesystem::path workspace;
std::mutex fixtureMutex;
std::vector<std::wstring> records;
unsigned requestCount = 0, unexpected = 0;
std::atomic_uint activeRequests = 0;
std::atomic_uint datasetSize = 0;
char const* phase = "startup";
unsigned iteration = 0;

// BEGIN portable mailbox latency diagnostics
// No exception, mail, control text, path or arbitrary string enters this output.
namespace latency_diagnostic {
enum class Check { other, valueProvider, valueIdentity, valueEvent, buttonReady, invokeProvider, searchResults, contentsChanged, visibleRows, searchClick };
enum class Step { none, valuePeer, valueSet, findButton, invoke, waitResults, sample, clickReceipt };
char const* checkName(Check value) {
    switch (value) {
    case Check::other: return "other-requirement";
    case Check::valueProvider: return "search-value-provider";
    case Check::valueIdentity: return "search-control-identity";
    case Check::valueEvent: return "search-text-event";
    case Check::buttonReady: return "button-mounted-enabled";
    case Check::invokeProvider: return "button-invoke-provider";
    case Check::searchResults: return "search-owned-results";
    case Check::contentsChanged: return "displayed-contents-stable";
    case Check::visibleRows: return "bounded-visible-rows";
    case Check::searchClick: return "search-click-receipt";
    }
    return "unknown-requirement";
}
char const* stepName(Step value) {
    switch (value) {
    case Step::none: return "none";
    case Step::valuePeer: return "value-peer";
    case Step::valueSet: return "value-set";
    case Step::findButton: return "find-button";
    case Step::invoke: return "invoke";
    case Step::waitResults: return "wait-results";
    case Step::sample: return "sample";
    case Step::clickReceipt: return "click-receipt";
    }
    return "unknown-step";
}
struct Snapshot {
    Step step = Step::none;
    std::optional<bool> searchPresent, searchLoaded, searchEnabled, queryMatches, currentSearch;
    std::optional<bool> buttonPresent, buttonLoaded, buttonEnabled, buttonAttached, currentButton;
    std::optional<bool> mailQueryMatches, pageLabelMatches, loading, firstVisible, firstIdentity, secondVisible, secondIdentity, writing;
    std::optional<uint64_t> clicksBefore, clicksAfter, rows, cursors, active, pending, requests, unexpected;
    unsigned unavailable = 0;
};
std::string value(std::optional<bool> entry) { return !entry ? "null" : *entry ? "true" : "false"; }
std::string value(std::optional<uint64_t> entry) { return entry ? std::to_string(*entry) : "null"; }
std::array<std::string, 3> render(Snapshot const& s) {
    return {
        std::string("{\"kind\":\"mailbox-latency-failure-controls\",\"observedAt\":\"after-failure\",\"step\":\"") + stepName(s.step)
            + "\",\"searchPresent\":" + value(s.searchPresent) + ",\"searchLoaded\":" + value(s.searchLoaded)
            + ",\"searchEnabled\":" + value(s.searchEnabled) + ",\"queryMatches\":" + value(s.queryMatches)
            + ",\"currentSearch\":" + value(s.currentSearch) + ",\"buttonPresent\":" + value(s.buttonPresent)
            + ",\"buttonLoaded\":" + value(s.buttonLoaded) + ",\"buttonEnabled\":" + value(s.buttonEnabled)
            + ",\"buttonAttached\":" + value(s.buttonAttached) + ",\"currentButton\":" + value(s.currentButton)
            + ",\"clicksBefore\":" + value(s.clicksBefore) + ",\"clicksAfter\":" + value(s.clicksAfter) + "}",
        std::string("{\"kind\":\"mailbox-latency-failure-results\",\"observedAt\":\"after-failure\",\"mailQueryMatches\":") + value(s.mailQueryMatches)
            + ",\"rows\":" + value(s.rows) + ",\"cursors\":" + value(s.cursors) + ",\"pageLabelMatches\":" + value(s.pageLabelMatches)
            + ",\"loading\":" + value(s.loading) + ",\"firstVisible\":" + value(s.firstVisible) + ",\"firstIdentity\":" + value(s.firstIdentity)
            + ",\"secondVisible\":" + value(s.secondVisible) + ",\"secondIdentity\":" + value(s.secondIdentity) + "}",
        std::string("{\"kind\":\"mailbox-latency-failure-requests\",\"observedAt\":\"after-failure\",\"active\":") + value(s.active)
            + ",\"pending\":" + value(s.pending) + ",\"requests\":" + value(s.requests) + ",\"unexpected\":" + value(s.unexpected)
            + ",\"writing\":" + value(s.writing) + ",\"unavailableGroups\":" + std::to_string(s.unavailable) + "}"
    };
}
bool controls() {
    Snapshot missing; missing.step = static_cast<Step>(999); missing.unavailable = 31;
    auto absent = render(missing);
    if (absent[0].find("\"step\":\"unknown-step\"") == std::string::npos
        || absent[0].find("\"searchLoaded\":null") == std::string::npos
        || absent[1].find("\"rows\":null") == std::string::npos
        || std::string(checkName(static_cast<Check>(999))) != "unknown-requirement") return false;
    Snapshot present; present.step = Step::waitResults;
    present.searchLoaded = false; present.queryMatches = true;
    present.rows = 18446744073709551615ull; present.clicksBefore = 18446744073709551615ull;
    present.clicksAfter = 18446744073709551615ull; present.requests = 18446744073709551615ull;
    for (auto const& lines : {render(present), absent}) for (auto const& line : lines)
        if (line.size() >= 1024 || line.find('\n') != std::string::npos) return false;
    auto known = render(present);
    return known[0].find("\"searchLoaded\":false") != std::string::npos
        && known[0].find("\"queryMatches\":true") != std::string::npos
        && known[1].find("18446744073709551615") != std::string::npos;
}
}
// END portable mailbox latency diagnostics

// BEGIN portable native value policy
// The actual MTA client uses this decision path. Synthetic controls can exercise
// rejection and no-write behavior without pretending to execute COM or WinUI.
namespace native_value {
enum class Failure { none, windowOwner, rootOwner, missing, duplicate, targetOwner, editType, disabled, offscreen, pattern, readOnly, replaced, api };
enum class Stage { startup, window, root, find, target, pattern, recheck, write, complete };
char const* name(Failure value) {
    switch (value) {
    case Failure::none: return "complete";
    case Failure::windowOwner: return "window-owner";
    case Failure::rootOwner: return "root-owner";
    case Failure::missing: return "missing-target";
    case Failure::duplicate: return "duplicate-target";
    case Failure::targetOwner: return "target-owner";
    case Failure::editType: return "target-not-edit";
    case Failure::disabled: return "target-disabled";
    case Failure::offscreen: return "target-offscreen";
    case Failure::pattern: return "missing-native-value";
    case Failure::readOnly: return "target-read-only";
    case Failure::replaced: return "target-changed";
    case Failure::api: return "native-api-failure";
    }
    return "unknown-failure";
}
char const* name(Stage value) {
    switch (value) {
    case Stage::startup: return "startup";
    case Stage::window: return "window";
    case Stage::root: return "window-root";
    case Stage::find: return "find-exact-id";
    case Stage::target: return "check-target";
    case Stage::pattern: return "native-value-pattern";
    case Stage::recheck: return "recheck-owner";
    case Stage::write: return "set-native-value";
    case Stage::complete: return "complete";
    }
    return "unknown-stage";
}
template<class Backend> Failure enter(Backend& api) {
    api.stage(Stage::window);
    if (!api.ownedWindow()) return Failure::windowOwner;
    api.stage(Stage::root);
    if (!api.ownedRoot()) return Failure::rootOwner;
    api.stage(Stage::find);
    auto matches = api.findExact();
    if (matches == 0) return Failure::missing;
    if (matches != 1) return Failure::duplicate;
    api.stage(Stage::target);
    if (!api.ownedTarget()) return Failure::targetOwner;
    if (!api.editType()) return Failure::editType;
    if (!api.enabled()) return Failure::disabled;
    if (api.offscreen()) return Failure::offscreen;
    api.stage(Stage::pattern);
    if (!api.valuePattern()) return Failure::pattern;
    if (api.readOnly()) return Failure::readOnly;
    api.stage(Stage::recheck);
    if (!api.ownedWindow() || !api.ownedTarget() || !api.editType()
        || !api.enabled() || api.offscreen() || api.readOnly()) return Failure::replaced;
    api.stage(Stage::write); api.setValue();
    api.stage(Stage::complete); return Failure::none;
}
struct Control {
    bool window = true, root = true, target = true, edit = true, enabledValue = true;
    bool offscreenValue = false, hasPattern = true, readOnlyValue = false;
    bool windowAfter = true, targetAfter = true;
    unsigned count = 1, writes = 0, windowReads = 0, targetReads = 0;
    Stage observed = Stage::startup;
    void stage(Stage value) { observed = value; }
    bool ownedWindow() { return ++windowReads == 1 ? window : windowAfter; }
    bool ownedRoot() { return root; }
    unsigned findExact() { return count; }
    bool ownedTarget() { return ++targetReads == 1 ? target : targetAfter; }
    bool editType() { return edit; }
    bool enabled() { return enabledValue; }
    bool offscreen() { return offscreenValue; }
    bool valuePattern() { return hasPattern; }
    bool readOnly() { return readOnlyValue; }
    void setValue() { ++writes; }
};
bool controls() {
    Control valid;
    if (enter(valid) != Failure::none || valid.writes != 1 || valid.observed != Stage::complete) return false;
    for (unsigned kind = 0; kind < 12; ++kind) {
        Control value; Failure expected = Failure::api;
        switch (kind) {
        case 0: value.window = false; expected = Failure::windowOwner; break;
        case 1: value.root = false; expected = Failure::rootOwner; break;
        case 2: value.count = 0; expected = Failure::missing; break;
        case 3: value.count = 2; expected = Failure::duplicate; break;
        case 4: value.target = false; expected = Failure::targetOwner; break;
        case 5: value.edit = false; expected = Failure::editType; break;
        case 6: value.enabledValue = false; expected = Failure::disabled; break;
        case 7: value.offscreenValue = true; expected = Failure::offscreen; break;
        case 8: value.hasPattern = false; expected = Failure::pattern; break;
        case 9: value.readOnlyValue = true; expected = Failure::readOnly; break;
        case 10: value.windowAfter = false; expected = Failure::replaced; break;
        case 11: value.targetAfter = false; expected = Failure::replaced; break;
        }
        if (enter(value) != expected || value.writes != 0 || value.observed == Stage::complete) return false;
    }
    return std::string(name(static_cast<Failure>(999))) == "unknown-failure"
        && std::string(name(static_cast<Stage>(999))) == "unknown-stage";
}
}
// END portable native value policy

void require(bool condition, wchar_t const* message, latency_diagnostic::Check check = latency_diagnostic::Check::other) {
    if (!condition && check != latency_diagnostic::Check::other)
        std::fprintf(stderr, "Mailbox latency assertion failed: id=%s\n", latency_diagnostic::checkName(check));
    if (!condition) throw hresult_error(E_FAIL, message);
}
void number(Json const& value, wchar_t const* key, double entry) { value.Insert(key, Value::CreateNumberValue(entry)); }
void boolean(Json const& value, wchar_t const* key, bool entry) { value.Insert(key, Value::CreateBooleanValue(entry)); }
hstring subject(unsigned index) { return L"Fictional mailbox row " + to_hstring(index) + L" 中文"; }
hstring bodyText(unsigned index) { return L"Fictional reader body " + to_hstring(index) + L". " + hstring(std::wstring(1024, L'x')); }
hstring identity(unsigned index) { return L"imap:55:" + to_hstring(index / 2 + 1); }
hstring viewIdentity(unsigned index) { return hstring(owners[index % 2]) + L":" + identity(index); }
uint64_t counter() { LARGE_INTEGER result{}; require(QueryPerformanceCounter(&result) != FALSE, L"Native monotonic clock is unavailable."); return static_cast<uint64_t>(result.QuadPart); }
double milliseconds(uint64_t begin) {
    LARGE_INTEGER frequency{}; require(QueryPerformanceFrequency(&frequency) != FALSE && frequency.QuadPart > 0, L"Native clock frequency is unavailable.");
    return static_cast<double>(counter() - begin) * 1000.0 / static_cast<double>(frequency.QuadPart);
}
hstring environment(wchar_t const* name) {
    wchar_t value[32768]{}; auto size = GetEnvironmentVariableW(name, value, 32768);
    require(size && size < 32768, L"Missing isolated fixture argument."); return hstring(value, size);
}
std::string contents(std::filesystem::path const& path) {
    std::ifstream file(path, std::ios::binary); return {std::istreambuf_iterator<char>(file), {}};
}
hstring timestamp() {
    SYSTEMTIME time{}; GetSystemTime(&time); wchar_t buffer[40]{};
    swprintf_s(buffer, L"%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", time.wYear, time.wMonth, time.wDay,
        time.wHour, time.wMinute, time.wSecond, time.wMilliseconds); return buffer;
}
void prepare(unsigned size) {
    std::lock_guard lock(fixtureMutex);
    require(activeRequests.load() == 0 && mailboxLatencyPendingRequests.load() == 0, L"Previous dataset still has an active fixture request.");
    records.clear(); records.reserve(size); requestCount = 0; unexpected = 0;
    for (unsigned i = 0; i < size; ++i) {
        Json row; put(row, L"id", identity(i)); put(row, L"viewId", viewIdentity(i)); put(row, L"accountId", owners[i % 2]);
        put(row, L"folder", L"inbox"); put(row, L"providerFolderId", L"INBOX"); boolean(row, L"read", true);
        put(row, L"subject", subject(i)); put(row, L"fromName", L"Fictional sender " + to_hstring(i % 37));
        put(row, L"fromEmail", L"sender@example.invalid"); put(row, L"to", owners[i % 2]);
        put(row, L"date", L"2026-01-01T12:00:00Z"); put(row, L"preview", L"Controlled native layout fixture " + to_hstring(i));
        records.emplace_back(row.Stringify());
    }
    datasetSize = size;
}
Json state() {
    return Json::Parse(LR"({"account":{"id":"all"},"revision":"fixture-1","accounts":[{"id":"alpha@latency.invalid","email":"alpha@latency.invalid","provider":"imap","settings":{"configured":true}},{"id":"beta@latency.invalid","email":"beta@latency.invalid","provider":"imap","settings":{"configured":true}}],"settings":{"preferences":{"markReadOnOpen":false,"density":"comfortable"},"policy":{"enabled":false}}})");
}
bool attached(xaml::FrameworkElement const& element, xaml::FrameworkElement const& root) {
    if (!element || !element.IsLoaded() || !element.XamlRoot() || element.XamlRoot() != root.XamlRoot()
        || element.ActualWidth() <= 0 || element.ActualHeight() <= 0) return false;
    auto node = element.as<xaml::DependencyObject>();
    for (unsigned i = 0; node && i < 128; ++i) {
        if (auto ui = node.try_as<xaml::UIElement>(); ui && (ui.Visibility() != xaml::Visibility::Visible || ui.Opacity() <= 0)) return false;
        if (node == root) return true;
        node = xaml::Media::VisualTreeHelper::GetParent(node);
    }
    return false;
}
bool visible(xaml::FrameworkElement const& element, xaml::FrameworkElement const& viewport, xaml::FrameworkElement const& root) {
    if (!attached(element, root) || !attached(viewport, root)) return false;
    auto bounds = element.TransformToVisual(viewport).TransformBounds(Rect{0, 0,
        static_cast<float>(element.ActualWidth()), static_cast<float>(element.ActualHeight())});
    return bounds.X < viewport.ActualWidth() && bounds.Y < viewport.ActualHeight()
        && bounds.X + bounds.Width > 0 && bounds.Y + bounds.Height > 0;
}
bool mountedText(xaml::DependencyObject const& node, hstring const& wanted,
    xaml::FrameworkElement const& viewport, xaml::FrameworkElement const& root, unsigned& remaining) {
    if (!remaining) return false;
    --remaining;
    if (auto text = node.try_as<controls::TextBlock>(); text && text.Text() == wanted && visible(text, viewport, root)) return true;
    for (int i = 0; i < xaml::Media::VisualTreeHelper::GetChildrenCount(node) && remaining; ++i)
        if (mountedText(xaml::Media::VisualTreeHelper::GetChild(node, i), wanted, viewport, root, remaining)) return true;
    return false;
}
bool contains(xaml::DependencyObject const& node, hstring const& wanted, xaml::FrameworkElement const& viewport, xaml::FrameworkElement const& root) {
    unsigned remaining = 4096; return mountedText(node, wanted, viewport, root, remaining);
}
bool displayed(std::shared_ptr<Shell> const& shell, unsigned page, unsigned pageSize, unsigned firstIndex, bool selecting = false, unsigned selectedIndex = 0) {
    shell->root.UpdateLayout();
    if (shell->loading || shell->rows.Items().Size() != pageSize || shell->cursors.size() != page + 1
        || !attached(shell->pageLabel, shell->root)) return false;
    auto total = pageSize == 30 ? datasetSize.load() / 2 : datasetSize.load();
    if (shell->pageLabel.Text() != L"Page " + to_hstring(page + 1) + L" · " + to_hstring(total) + L" messages") return false;
    auto first = shell->rows.Items().GetAt(0).as<controls::ListViewItem>();
    if (!visible(first, shell->rows, shell->root)
        || !contains(first, subject(firstIndex), shell->rows, shell->root)
        || !contains(first, owners[firstIndex % 2], shell->rows, shell->root)) return false;
    auto second = shell->rows.Items().GetAt(1).as<controls::ListViewItem>();
    auto secondIndex = firstIndex + (pageSize == 30 ? 2u : 1u);
    if (!visible(second, shell->rows, shell->root) || !contains(second, subject(secondIndex), shell->rows, shell->root)
        || !contains(second, owners[secondIndex % 2], shell->rows, shell->root)) return false;
    if (!selecting) return true;
    auto selected = shell->selectedMessages();
    return selected.size() == 1 && text(selected[0], L"viewId") == viewIdentity(selectedIndex)
        && text(selected[0], L"accountId") == owners[selectedIndex % 2]
        && text(shell->selected, L"viewId") == viewIdentity(selectedIndex)
        && text(shell->selected, L"accountId") == owners[selectedIndex % 2]
        && !shell->pendingRead.Size() && shell->reader.IsEnabled()
        && contains(shell->reader, bodyText(selectedIndex), shell->reader, shell->root)
        && contains(shell->reader, L"To: " + hstring(owners[selectedIndex % 2]), shell->reader, shell->root);
}
IAsyncAction waitFor(std::function<bool()> ready, wchar_t const* message, latency_diagnostic::Check check = latency_diagnostic::Check::other) {
    apartment_context ui; auto end = GetTickCount64() + 10000;
    while (!ready() && GetTickCount64() < end) { co_await resume_after(std::chrono::milliseconds(1)); co_await ui; }
    require(ready(), message, check);
}
provider::IInvokeProvider invokeAction(controls::Button const& button, xaml::FrameworkElement const& root) {
    require(button.IsEnabled() && attached(button, root), L"Native button is not mounted and enabled.", latency_diagnostic::Check::buttonReady);
    auto peer = peers::FrameworkElementAutomationPeer::CreatePeerForElement(button);
    auto action = peer.GetPattern(peers::PatternInterface::Invoke).try_as<provider::IInvokeProvider>();
    require(bool(action), L"Native button does not expose Invoke.", latency_diagnostic::Check::invokeProvider); return action;
}
provider::ISelectionItemProvider selectionAction(std::shared_ptr<Shell> const& shell, unsigned index) {
    auto item = shell->rows.Items().GetAt(index).as<controls::ListViewItem>();
    require(visible(item, shell->rows, shell->root), L"Native row is not mounted in the viewport.");
    auto peer = peers::FrameworkElementAutomationPeer::CreatePeerForElement(shell->rows)
        .as<peers::ListViewAutomationPeer>().CreateItemAutomationPeer(item);
    auto action = peer.GetPattern(peers::PatternInterface::SelectionItem).try_as<provider::ISelectionItemProvider>();
    require(bool(action), L"Native row does not expose SelectionItem."); return action;
}
controls::Button findButton(xaml::DependencyObject const& node, hstring const& name, unsigned& remaining) {
    if (!remaining) return nullptr;
    --remaining;
    if (auto button = node.try_as<controls::Button>(); button && xaml::Automation::AutomationProperties::GetName(button) == name) return button;
    for (int i = 0; i < xaml::Media::VisualTreeHelper::GetChildrenCount(node) && remaining; ++i)
        if (auto found = findButton(xaml::Media::VisualTreeHelper::GetChild(node, i), name, remaining)) return found;
    return nullptr;
}
Json sample(std::shared_ptr<Shell> const& shell, hstring const& action, uint64_t begin,
    unsigned page, unsigned pageSize, unsigned firstIndex, bool selecting = false, unsigned selectedIndex = 0) {
    require(displayed(shell, page, pageSize, firstIndex, selecting, selectedIndex), L"Observed native contents changed before recording.", latency_diagnostic::Check::contentsChanged);
    unsigned visibleRows = 0;
    for (auto const& value : shell->rows.Items()) if (visible(value.as<controls::ListViewItem>(), shell->rows, shell->root)) ++visibleRows;
    require(visibleRows > 0 && visibleRows <= pageSize, L"No bounded visible rows were measured.", latency_diagnostic::Check::visibleRows);
    Json result; put(result, L"action", action); put(result, L"completion", L"layout-and-display"); number(result, L"elapsedMs", milliseconds(begin));
    number(result, L"page", page); number(result, L"tableRows", pageSize); number(result, L"visibleRows", visibleRows);
    boolean(result, L"ownerMatched", true); boolean(result, L"renderedRowIdentityMatched", true); boolean(result, L"renderedReaderMatched", selecting);
    boolean(result, L"selectedOwnedRow", selecting); put(result, L"firstOwnedRow", viewIdentity(firstIndex));
    if (selecting) { put(result, L"selectedOwner", owners[selectedIndex % 2]); put(result, L"selectedViewId", viewIdentity(selectedIndex)); }
    put(result, L"observedPageLabel", shell->pageLabel.Text()); return result;
}
IAsyncAction offlineControls(std::shared_ptr<Shell> shell) {
    phase = "offline-negative-controls"; prepare(1000);
    unsigned rejected = 0;
    for (auto kind : {0u, 1u, 2u, 3u, 4u}) {
        bool failed = false;
        try {
            Json body; put(body, L"folder", L"inbox"); number(body, L"offset", 0);
            if (kind == 0) co_await shell->service->start();
            else if (kind == 1) co_await shell->service->request(L"/send", owners[0], L"POST", body);
            else if (kind == 2) co_await shell->service->request(L"/messages/" + escaped(identity(0)), L"wrong-owner@latency.invalid");
            else if (kind == 3) co_await shell->service->request(L"/mail/page", L"all", L"POST", body, true);
            else co_await shell->service->requestWithStatus(L"/mail/page", L"all", L"PATCH", body);
        } catch (hresult_error const&) { failed = true; }
        require(failed && !shell->service->alive(), L"An offline negative control bypassed the fixture boundary.");
        ++rejected;
        std::lock_guard lock(fixtureMutex);
        require(unexpected == rejected, L"Rejected fixture operations were not observed.");
    }
    require(activeRequests.load() == 0 && mailboxLatencyPendingRequests.load() == 0 && !shell->service->writing(), L"Rejected fixture operations did not drain.");
}
struct DiagnosticControls {
    latency_diagnostic::Step step = latency_diagnostic::Step::none;
    controls::TextBox search{nullptr};
    controls::Button initialButton{nullptr}, currentButton{nullptr};
    std::shared_ptr<std::array<unsigned, 4>> events;
    unsigned clicksBefore = 0;
};
struct NativeValueResult {
    std::atomic<native_value::Stage> stage = native_value::Stage::startup;
    std::atomic_uint matches = 0;
    native_value::Failure failure = native_value::Failure::api;
    HRESULT error = S_OK;
};
struct AutomationString {
    BSTR value = nullptr;
    ~AutomationString() { SysFreeString(value); }
};
struct NativeValueClient {
    HWND window;
    DWORD process;
    std::wstring id;
    NativeValueResult& result;
    com_ptr<IUIAutomation2> automation;
    com_ptr<IUIAutomationElement> root, target;
    com_ptr<IUIAutomationValuePattern> value;
    NativeValueClient(HWND captured, DWORD owner, std::wstring identifier, NativeValueResult& output)
        : window(captured), process(owner), id(std::move(identifier)), result(output) {
        check_hresult(CoCreateInstance(__uuidof(CUIAutomation8), nullptr, CLSCTX_INPROC_SERVER,
            __uuidof(IUIAutomation2), automation.put_void()));
        check_hresult(automation->put_ConnectionTimeout(2000));
        check_hresult(automation->put_TransactionTimeout(2000));
    }
    void stage(native_value::Stage current) { result.stage.store(current); }
    bool ownedWindow() const {
        DWORD actual = 0;
        return process == GetCurrentProcessId() && IsWindow(window)
            && GetWindowThreadProcessId(window, &actual) != 0 && actual == process;
    }
    bool ownedRoot() {
        check_hresult(automation->ElementFromHandle(window, root.put()));
        if (!root) return false;
        int actual = 0; UIA_HWND actualWindow = nullptr;
        check_hresult(root->get_CurrentProcessId(&actual));
        check_hresult(root->get_CurrentNativeWindowHandle(&actualWindow));
        return actual == static_cast<int>(process) && actualWindow == window;
    }
    unsigned findExact() {
        AutomationString identifier; identifier.value = SysAllocStringLen(id.data(), static_cast<UINT>(id.size()));
        if (!identifier.value) throw hresult_error(E_OUTOFMEMORY);
        VARIANT property{}; property.vt = VT_BSTR; property.bstrVal = identifier.value;
        com_ptr<IUIAutomationCondition> condition;
        check_hresult(automation->CreatePropertyCondition(UIA_AutomationIdPropertyId, property, condition.put()));
        com_ptr<IUIAutomationElementArray> matches;
        // Only this owned HWND, never the desktop. Do not enumerate or log any
        // returned element unless the exact fixture ID has one unique match.
        check_hresult(root->FindAll(TreeScope_Descendants, condition.get(), matches.put()));
        int count = 0;
        if (matches) check_hresult(matches->get_Length(&count));
        if (count < 0) throw hresult_error(E_FAIL);
        result.matches.store(static_cast<unsigned>(count));
        if (count == 1) check_hresult(matches->GetElement(0, target.put()));
        return static_cast<unsigned>(count);
    }
    bool ownedTarget() const {
        if (!target) return false;
        int actual = 0; AutomationString identifier;
        check_hresult(target->get_CurrentProcessId(&actual));
        check_hresult(target->get_CurrentAutomationId(&identifier.value));
        return actual == static_cast<int>(process) && identifier.value
            && std::wstring_view(identifier.value, SysStringLen(identifier.value)) == id;
    }
    bool editType() const {
        CONTROLTYPEID type = 0; check_hresult(target->get_CurrentControlType(&type)); return type == UIA_EditControlTypeId;
    }
    bool enabled() const { BOOL entry = FALSE; check_hresult(target->get_CurrentIsEnabled(&entry)); return entry != FALSE; }
    bool offscreen() const { BOOL entry = TRUE; check_hresult(target->get_CurrentIsOffscreen(&entry)); return entry != FALSE; }
    bool valuePattern() {
        auto status = target->GetCurrentPatternAs(UIA_ValuePatternId, __uuidof(IUIAutomationValuePattern), value.put_void());
        if (status == UIA_E_NOTSUPPORTED || status == E_NOINTERFACE) return false;
        check_hresult(status); return bool(value);
    }
    bool readOnly() const { BOOL entry = TRUE; check_hresult(value->get_CurrentIsReadOnly(&entry)); return entry != FALSE; }
    void setValue() const {
        AutomationString query; query.value = SysAllocString(L"fictional-even");
        if (!query.value) throw hresult_error(E_OUTOFMEMORY);
        check_hresult(value->SetValue(query.value));
    }
};
void runNativeValue(HWND window, DWORD process, std::wstring id, std::shared_ptr<NativeValueResult> const& result) noexcept {
    try {
        check_hresult(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
        struct Apartment { ~Apartment() { CoUninitialize(); } } apartment;
        NativeValueClient client(window, process, std::move(id), *result);
        result->failure = native_value::enter(client);
        // Client and every UIA object are released in this MTA before it exits.
    } catch (...) { result->error = to_hresult(); result->failure = native_value::Failure::api; }
}
[[noreturn]] void nativeValueDeadline(char const* reason, NativeValueResult const& result) noexcept {
    // Only fixed call-site strings, enums and numbers. A stuck COM call is not
    // cancellable: fail the entire isolated process instead of detaching it or
    // freeing its workspace while a worker might still act on the window.
    std::fprintf(stderr, "Mailbox latency UIA failure: id=%s stage=%s matches=%u exit=124\n",
        reason, native_value::name(result.stage.load()), result.matches.load());
    std::fflush(stderr);
    TerminateProcess(GetCurrentProcess(), 124);
    std::abort(); // TerminateProcess on self normally never returns.
}
struct NativeValueWorker {
    std::shared_ptr<NativeValueResult> result = std::make_shared<NativeValueResult>();
    std::thread thread;
    NativeValueWorker(HWND window, DWORD process, std::wstring id)
        : thread(runNativeValue, window, process, std::move(id), result) {}
    bool exited() noexcept {
        auto status = WaitForSingleObject(thread.native_handle(), 0);
        if (status == WAIT_FAILED) nativeValueDeadline("worker-status-unavailable", *result);
        return status == WAIT_OBJECT_0;
    }
    void joinCompleted() noexcept {
        if (!thread.joinable()) return;
        if (!exited()) nativeValueDeadline("worker-unfinished", *result);
        // This join follows observed OS thread termination; it never waits for
        // a live COM call. No UIA/XAML object crosses the thread boundary.
        try { thread.join(); } catch (...) { nativeValueDeadline("worker-join-failed", *result); }
    }
    ~NativeValueWorker() noexcept { joinCompleted(); }
};
IAsyncAction nativeSearchValue(std::shared_ptr<Shell> shell, DiagnosticControls& diagnostic) {
    apartment_context ui;
    auto input = shell->search; auto page = shell->page; auto contents = page.Content(); auto rows = shell->rows;
    auto window = shell->window; auto owner = shell->owner; auto generation = shell->generation;
    HWND handle = nullptr; check_hresult(window.as<IWindowNative>()->get_WindowHandle(&handle));
    auto process = GetCurrentProcessId();
    auto current = [&] {
        return shell->window == window && shell->owner == owner && owner == L"all"
            && shell->generation == generation && shell->section == L"mail" && shell->folder == L"inbox"
            && shell->page == page && page.Content() == contents && shell->rows == rows
            && shell->search == input && input == diagnostic.search && input.IsEnabled() && !input.IsReadOnly()
            && attached(input, shell->root) && !shell->loading && !shell->service->writing();
    };
    require(current(), L"Search input no longer belongs to the captured fixture page.", latency_diagnostic::Check::valueIdentity);
    auto identifier = L"morrow-mailbox-latency-search-" + to_hstring(datasetSize.load()) + L"-" + to_hstring(iteration);
    xaml::Automation::AutomationProperties::SetAutomationId(input, identifier);
    auto taggedCurrent = [&] { return current() && xaml::Automation::AutomationProperties::GetAutomationId(input) == identifier; };
    auto changes = std::make_shared<unsigned>(0);
    auto changed = input.TextChanged(auto_revoke, [changes, input](auto const& sender, auto const&) { if (sender == input) ++*changes; });
    // Setup is separate from the unchanged 10-second Search-result deadline.
    // This UI coroutine keeps pumping. The outer runner's 600-second owned-
    // process watchdog still covers a blocked UI thread or dispatcher.
    auto end = GetTickCount64() + 10000;
    diagnostic.step = latency_diagnostic::Step::valuePeer;
    NativeValueWorker worker(handle, process, std::wstring(identifier));
    while (!worker.exited()) {
        if (GetTickCount64() >= end) nativeValueDeadline("worker-deadline", *worker.result);
        co_await resume_after(std::chrono::milliseconds(1)); co_await ui;
    }
    worker.joinCompleted();
    // No WinRT control was captured by the MTA worker. All these checks occur
    // back on the original UI thread, before any Search invocation can happen.
    auto const& result = *worker.result;
    std::fprintf(stderr, "Mailbox latency native value %s: status=%s stage=%s matches=%u HRESULT=0x%08X\n",
        result.failure == native_value::Failure::none && SUCCEEDED(result.error) ? "complete" : "failure",
        native_value::name(result.failure), native_value::name(result.stage.load()), result.matches.load(), static_cast<unsigned>(result.error));
    require(result.failure == native_value::Failure::none && SUCCEEDED(result.error),
        L"Search input lacks an eligible native Value pattern.", latency_diagnostic::Check::valueProvider);
    diagnostic.step = latency_diagnostic::Step::valueSet;
    while (taggedCurrent() && (!*changes || input.Text() != L"fictional-even") && GetTickCount64() < end) {
        co_await resume_after(std::chrono::milliseconds(1)); co_await ui;
    }
    require(taggedCurrent(), L"Search input changed during native automation.", latency_diagnostic::Check::valueIdentity);
    require(GetTickCount64() < end && *changes > 0 && input.Text() == L"fictional-even",
        L"Native search value did not raise TextChanged with the expected query.", latency_diagnostic::Check::valueEvent);
}
void diagnoseFailure(std::shared_ptr<Shell> const& shell, DiagnosticControls const& d) noexcept {
    try {
        latency_diagnostic::Snapshot s; s.step = d.step;
        if (d.events) { s.clicksBefore = d.clicksBefore; s.clicksAfter = (*d.events)[3]; }
        try {
            s.searchPresent = bool(shell->search); s.currentSearch = d.search && d.search == shell->search;
            if (shell->search) { s.searchLoaded = shell->search.IsLoaded(); s.searchEnabled = shell->search.IsEnabled(); s.queryMatches = shell->search.Text() == L"fictional-even"; }
        } catch (...) { s.unavailable |= 1; }
        try {
            unsigned remaining = 4096; auto current = findButton(shell->page, L"Search", remaining);
            s.buttonPresent = bool(d.currentButton);
            s.currentButton = d.currentButton && d.currentButton == d.initialButton && d.currentButton == current;
            if (d.currentButton) { s.buttonLoaded = d.currentButton.IsLoaded(); s.buttonEnabled = d.currentButton.IsEnabled(); s.buttonAttached = attached(d.currentButton, shell->root); }
        } catch (...) { s.unavailable |= 2; }
        try {
            s.mailQueryMatches = shell->mailSearchQuery == L"fictional-even"; s.loading = shell->loading;
            s.cursors = shell->cursors.size();
            if (shell->pageLabel) s.pageLabelMatches = shell->pageLabel.Text() == L"Page 1 · " + to_hstring(datasetSize.load() / 2) + L" messages";
            if (shell->rows) s.rows = shell->rows.Items().Size();
        } catch (...) { s.unavailable |= 4; }
        try {
            if (shell->rows && shell->rows.Items().Size() >= 2) {
                auto first = shell->rows.Items().GetAt(0).as<controls::ListViewItem>();
                auto second = shell->rows.Items().GetAt(1).as<controls::ListViewItem>();
                s.firstVisible = visible(first, shell->rows, shell->root); s.secondVisible = visible(second, shell->rows, shell->root);
                s.firstIdentity = contains(first, subject(0), shell->rows, shell->root) && contains(first, owners[0], shell->rows, shell->root);
                s.secondIdentity = contains(second, subject(2), shell->rows, shell->root) && contains(second, owners[0], shell->rows, shell->root);
            }
        } catch (...) { s.unavailable |= 8; }
        try {
            s.active = activeRequests.load(); s.pending = mailboxLatencyPendingRequests.load();
            { std::lock_guard lock(fixtureMutex); s.requests = requestCount; s.unexpected = unexpected; }
            if (shell->service) s.writing = shell->service->writing();
        } catch (...) { s.unavailable |= 16; }
        for (auto const& line : latency_diagnostic::render(s)) std::fprintf(stderr, "%s\n", line.c_str());
    } catch (...) { std::fprintf(stderr, "Mailbox latency failure observations unavailable\n"); }
}
IAsyncOperation<Json> dataset(std::shared_ptr<Shell> shell, unsigned size, DiagnosticControls& diagnostic) {
    phase = "initial-page"; iteration = 0;
    diagnostic = DiagnosticControls{};
    prepare(size); shell->state = state(); shell->owner = L"all"; shell->folder = L"inbox"; shell->section = L"mail";
    ++shell->generation; shell->selected = Json(); shell->pendingRead = Json(); shell->retainedUnread = Json();
    shell->cursors = {L""}; shell->nextCursor = {}; shell->mailLayout = L"right"; shell->listWidth = 440;
    shell->mailPage(); co_await shell->loadPage(0, false, true);
    co_await waitFor([shell] { return displayed(shell, 0, 50, 0); }, L"Initial native page did not display.");
    auto events = std::make_shared<std::array<unsigned, 4>>();
    shell->next.Click([events](auto const&, auto const&) { ++(*events)[0]; });
    shell->previous.Click([events](auto const&, auto const&) { ++(*events)[1]; });
    shell->rows.SelectionChanged([events](auto const&, auto const&) { ++(*events)[2]; });
    unsigned searchRemaining = 4096; auto searchButton = findButton(shell->page, L"Search", searchRemaining);
    require(bool(searchButton), L"Production Search button is missing.");
    searchButton.Click([events](auto const&, auto const&) { ++(*events)[3]; });
    diagnostic.search = shell->search; diagnostic.initialButton = searchButton; diagnostic.currentButton = searchButton; diagnostic.events = events;
    Array samples, searches;
    for (unsigned repeat = 0; repeat < 6; ++repeat) {
        iteration = repeat; phase = "next";
        auto before = (*events)[0]; auto next = invokeAction(shell->next, shell->root); auto start = counter(); next.Invoke();
        co_await waitFor([shell] { return displayed(shell, 1, 50, 50); }, L"Next did not display its new owned rows.");
        require((*events)[0] > before, L"Next did not raise its actual Click event.");
        auto result = sample(shell, L"next", start, 1, 50, 50); boolean(result, L"nativeEventObserved", true); samples.Append(result);
        phase = "previous";
        before = (*events)[1]; auto previous = invokeAction(shell->previous, shell->root); start = counter(); previous.Invoke();
        co_await waitFor([shell] { return displayed(shell, 0, 50, 0); }, L"Previous did not restore page one.");
        require((*events)[1] > before, L"Previous did not raise its actual Click event.");
        result = sample(shell, L"previous", start, 0, 50, 0); boolean(result, L"nativeEventObserved", true); samples.Append(result);
        phase = "select";
        before = (*events)[2]; auto index = repeat % 2; auto select = selectionAction(shell, index); start = counter(); select.Select();
        co_await waitFor([shell, index] { return displayed(shell, 0, 50, 0, true, index); }, L"Actual native selection did not display its owned reader.");
        require((*events)[2] > before, L"Select did not raise its actual SelectionChanged event.");
        result = sample(shell, L"select", start, 0, 50, 0, true, index); boolean(result, L"nativeEventObserved", true); samples.Append(result);
    }
    // Search stays separate from the cross-platform Next/Previous/Select metric.
    // Native Windows UIA Value and Search/Clear Invoke raise production events.
    for (unsigned repeat = 0; repeat < 6; ++repeat) {
        iteration = repeat; phase = "search";
        diagnostic.clicksBefore = (*events)[3];
        auto capturedOwner = shell->owner; auto capturedGeneration = shell->generation;
        auto capturedPage = shell->page; auto capturedContents = capturedPage.Content(); auto capturedRows = shell->rows;
        auto capturedWindow = shell->window; auto capturedInput = shell->search;
        co_await nativeSearchValue(shell, diagnostic);
        require(shell->owner == capturedOwner && capturedOwner == L"all" && shell->generation == capturedGeneration
            && shell->section == L"mail" && shell->folder == L"inbox" && shell->window == capturedWindow
            && shell->page == capturedPage && capturedPage.Content() == capturedContents && shell->rows == capturedRows
            && shell->search == capturedInput && capturedInput == diagnostic.search
            && attached(capturedInput, shell->root) && capturedInput.IsEnabled() && !capturedInput.IsReadOnly()
            && capturedInput.Text() == L"fictional-even" && !shell->loading && !shell->service->writing(),
            L"Search page changed before invoking its control.", latency_diagnostic::Check::valueIdentity);
        diagnostic.step = latency_diagnostic::Step::findButton;
        unsigned remaining = 4096; auto search = findButton(shell->page, L"Search", remaining);
        require(search && search == diagnostic.initialButton, L"Search button no longer belongs to the captured page.", latency_diagnostic::Check::valueIdentity);
        diagnostic.currentButton = search; diagnostic.clicksBefore = (*events)[3]; diagnostic.step = latency_diagnostic::Step::invoke;
        auto before = (*events)[3]; auto action = invokeAction(search, shell->root); auto start = counter(); action.Invoke();
        diagnostic.step = latency_diagnostic::Step::waitResults;
        co_await waitFor([shell] { return shell->mailSearchQuery == L"fictional-even" && displayed(shell, 0, 30, 0); }, L"Search did not display its bounded owned results.", latency_diagnostic::Check::searchResults);
        diagnostic.step = latency_diagnostic::Step::sample;
        auto searchSample = sample(shell, L"search", start, 0, 30, 0);
        diagnostic.step = latency_diagnostic::Step::clickReceipt;
        require((*events)[3] > before, L"Search did not raise its actual Click event.", latency_diagnostic::Check::searchClick);
        boolean(searchSample, L"nativeValueObserved", true); boolean(searchSample, L"textChangedObserved", true);
        boolean(searchSample, L"queryMatched", shell->search.Text() == L"fictional-even"); boolean(searchSample, L"nativeEventObserved", true); searches.Append(searchSample);
        phase = "clear-search";
        remaining = 4096; auto clear = findButton(shell->page, L"Clear", remaining); invokeAction(clear, shell->root).Invoke();
        co_await waitFor([shell] { return shell->mailSearchQuery.empty() && displayed(shell, 0, 50, 0); }, L"Clear did not restore the native inbox.");
    }
    phase = "drain"; co_await shell->publishSyncPriority();
    co_await waitFor([shell] { return !shell->service->writing() && activeRequests.load() == 0 && mailboxLatencyPendingRequests.load() == 0; }, L"Fixture requests did not drain.");
    Json result;
    { std::lock_guard lock(fixtureMutex); require(records.size() == size && unexpected == 0, L"Dataset or offline transport failed.");
      number(result, L"generatedRows", static_cast<double>(records.size())); number(result, L"unexpectedRequests", unexpected); number(result, L"interceptedRequests", requestCount); }
    number(result, L"size", size); number(result, L"pageSize", 50); boolean(result, L"ownerSelectionVerified", true);
    result.Insert(L"samples", samples); result.Insert(L"searchSamples", searches); number(result, L"searchPageSize", 30);
    co_return result;
}
}

// Replaces the entire blocking transport only in the private compiler copy.
// Request and requestWithStatus still use their production async/lifetime code.
Json mailboxLatencyRequest(hstring const& path, hstring const& owner, hstring const& method, Json const& body, bool hostOperation) {
    ++activeRequests;
    struct Active { ~Active() { --activeRequests; } } active;
    std::lock_guard lock(fixtureMutex); ++requestCount;
    try {
        require(!hostOperation, L"Host operations are forbidden in this fixture.");
        require(!records.empty(), L"Fixture dataset is unavailable.");
        if ((path == L"/mail/page" || path == L"/search") && method == L"POST") {
            require(owner == L"all" && text(body, L"folder") == L"inbox", L"Wrong page owner or folder.");
            bool searching = path == L"/search";
            auto pageSize = searching ? 30u : 50u; unsigned offset = 0;
            if (searching) {
                require(text(body, L"query") == L"fictional-even" && text(body, L"scope") == L"folder", L"Unexpected synthetic search.");
                auto page = body.GetNamedNumber(L"page", 0); require(page == 0, L"Unexpected synthetic search page.");
            } else {
                auto cursor = text(body, L"cursor"); auto value = body.GetNamedNumber(L"offset", 0);
                if (!cursor.empty()) { require(cursor == L"fixture-50", L"Unexpected synthetic cursor."); value = 50; }
                require(value == 0 || value == 50, L"Unexpected native page offset."); offset = static_cast<unsigned>(value);
                require(!flag(body, L"unreadOnly"), L"Unexpected unread filter.");
            }
            Array messages;
            for (unsigned i = 0; i < pageSize; ++i) messages.Append(Json::Parse(records.at(searching ? i * 2 : offset + i)));
            Json result; result.Insert(L"messages", messages); number(result, L"total", static_cast<double>(searching ? records.size() / 2 : records.size()));
            put(result, L"nextCursor", searching ? L"fixture-search-next" : offset == 0 ? L"fixture-50" : L"fixture-100"); put(result, L"revision", L"fixture-1"); return result;
        }
        if (path == L"/sync/priority" && method == L"POST") {
            require(owner == L"all" && array(body, L"messages").Size() <= 51 && body.GetNamedNumber(L"generation", 0) > 0, L"Invalid view hint.");
            std::set<std::pair<std::wstring, std::wstring>> unique;
            for (auto const& value : array(body, L"messages")) {
                auto row = value.GetObject(); auto account = text(row, L"accountId"), id = text(row, L"id");
                require((account == owners[0] || account == owners[1]) && !id.empty()
                    && unique.emplace(std::wstring(account), std::wstring(id)).second, L"Wrong owned priority identity.");
            }
            Json result; boolean(result, L"accepted", true); return result;
        }
        if (std::wstring_view(path).starts_with(L"/messages/") && method == L"GET" && body.Size() == 0) {
            require(owner == owners[0] || owner == owners[1], L"Wrong detail owner.");
            for (unsigned i = 0; i < 2; ++i) if (owner == owners[i] && path == L"/messages/" + escaped(identity(i))) {
                auto row = Json::Parse(records.at(i)); put(row, L"body", bodyText(i)); put(row, L"bodyHtml", L"");
                boolean(row, L"attachmentsLoaded", true); Json result; result.Insert(L"message", row); return result;
            }
        }
        throw hresult_error(E_ACCESSDENIED, L"Non-allowlisted fixture request.");
    } catch (...) { ++unexpected; throw; }
}
void mailboxLatencyRejectStart() {
    std::lock_guard lock(fixtureMutex); ++unexpected;
    throw hresult_error(E_ACCESSDENIED, L"The latency fixture cannot start a service.");
}

fire_and_forget startMailboxLatency(std::shared_ptr<Shell> shell) {
    bool passed = false; Json report; put(report, L"status", L"failed");
    DiagnosticControls diagnostic;
    try {
        require(latency_diagnostic::controls(), L"Fixed diagnostic controls failed.");
        require(native_value::controls(), L"Native Value no-write controls failed.");
        workspace = std::filesystem::path(environment(L"MORROW_DATA_DIR").c_str());
        require(workspace.is_absolute() && workspace.filename() == L"fictional-workspace"
            && contents(workspace / L"mailbox-latency-fixture") == "Morrow synthetic mailbox latency v1", L"A new marked fixture workspace is required.");
        require(!std::filesystem::exists(workspace / L"native.json"), L"Native reports must not be overwritten.");
        shell->service = std::make_shared<Service>(workspace); // Never start: the private adapter rejects it.
        shell->window = xaml::Window(); shell->window.Title(L"Morrow fictional mailbox latency");
        shell->root = controls::Grid(); shell->navigation = controls::NavigationView(); shell->page = controls::ContentControl();
        shell->status = controls::TextBlock(); shell->composeButton = controls::Button(); shell->syncButton = controls::Button();
        shell->navigation.Content(shell->page); shell->navigation.IsPaneVisible(false); shell->navigation.IsSettingsVisible(false);
        shell->root.Children().Append(shell->navigation); shell->window.Content(shell->root);
        shell->window.AppWindow().Resize({1220, 820}); shell->window.Activate();
        co_await waitFor([shell] { return shell->root.IsLoaded() && shell->root.ActualWidth() > 800; }, L"Fixture window did not mount.");
        co_await offlineControls(shell);
        Array results;
        for (unsigned size : {1000u, 10000u, 50000u}) results.Append(co_await dataset(shell, size, diagnostic));
        number(report, L"schema", 1); put(report, L"kind", L"morrow-native-mailbox-latency"); put(report, L"platform", L"windows");
        put(report, L"status", L"complete"); put(report, L"version", environment(L"MORROW_FIXTURE_VERSION")); put(report, L"measuredAt", timestamp());
        put(report, L"measurement", L"native-event-to-layout-display"); put(report, L"transport", L"intercepted-fictional-only");
        put(report, L"input", L"WinUI Invoke/SelectionItem providers and native Windows UIA Value pattern raising production control events");
        number(report, L"pollResolutionMs", 1); number(report, L"windowWidth", shell->root.ActualWidth()); number(report, L"windowHeight", shell->root.ActualHeight());
        number(report, L"windowScale", windowScale(shell->window)); report.Insert(L"results", results);
        auto controls = Json::Parse(LR"({"serviceStartRejected":true,"sendRejected":true,"unknownOwnerRejected":true,"hostOperationRejected":true,"unsafeStatusMethodRejected":true})");
        report.Insert(L"offlineControls", controls);
        put(report, L"limitations", L"Observed mounted WinUI TextBlocks, selection and UpdateLayout; not compositor presentation or physical pointer latency. Fixture transport, thread-pool and observer overhead are included. No real service/SQLite/WAN/HTML/provider/model, whole-app resource or live-account measurement. One first plus five warm samples. Search is separately reported and has no implicit cross-platform performance limit.");
        passed = true;
    } catch (...) { put(report, L"error", L"Native mailbox latency assertions failed; inspect the bounded fixture log.");
        put(report, L"failedPhase", to_hstring(phase)); number(report, L"failedSize", datasetSize.load()); number(report, L"failedIteration", iteration);
        std::fprintf(stderr, "Mailbox latency fixture failed: phase=%s size=%u iteration=%u HRESULT=0x%08X\n",
            phase, datasetSize.load(), iteration, static_cast<unsigned>(to_hresult()));
        if (std::string_view(phase) == "search") diagnoseFailure(shell, diagnostic); }
    if (!workspace.empty() && !std::filesystem::exists(workspace / L"native.json")) {
        std::ofstream output(workspace / L"native.json", std::ios::binary); output << to_string(report.Stringify());
        if (!output.good()) passed = false;
    }
    std::fprintf(stderr, "Mailbox latency fixture: %s\n", passed ? "complete" : "failed"); std::fflush(stderr);
    shell->closing = true;
    if (shell->window) shell->window.Close();
    xaml::Application::Current().Exit();
}
}
