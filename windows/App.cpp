#include "pch.h"
#include "Ui.h"
#include <microsoft.ui.xaml.window.h>
#include <shobjidl.h>
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <winrt/Microsoft.UI.Xaml.Controls.Primitives.h>
#include <winrt/Microsoft.UI.Xaml.Input.h>
#include <winrt/Microsoft.UI.Windowing.h>
#include <winrt/Windows.System.h>
#include <winrt/Windows.UI.Text.h>
#include <winrt/Windows.Globalization.h>
#include <winrt/Windows.UI.Xaml.Interop.h>
#include <winrt/Microsoft.UI.Xaml.XamlTypeInfo.h>
#include <fstream>
#include <cmath>
#include <cstdio>
#include <cwctype>

#pragma comment(lib, "user32.lib")

namespace {
// Fixture-only startup diagnostics; never log mailbox data or service responses.
void startupTrace(char const* phase) {
    if (std::wstring_view(GetCommandLineW()).find(L"--native-smoke") == std::wstring_view::npos) return;
    std::fprintf(stderr, "Native startup: %s\n", phase); std::fflush(stderr);
}
}

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
using namespace controls;
using namespace xaml;
using namespace Windows::Data::Json;
double windowScale(Window const& window) {
    HWND handle{}; check_hresult(window.as<::IWindowNative>()->get_WindowHandle(&handle));
    return static_cast<double>(GetDpiForWindow(handle)) / 96.0;
}
Windows::Graphics::RectInt32 mailWindowBounds(Window const& window, double width, double height) {
    auto scale = windowScale(window);
    auto work = Microsoft::UI::Windowing::DisplayArea::GetFromWindowId(window.AppWindow().Id(), Microsoft::UI::Windowing::DisplayAreaFallback::Nearest).WorkArea();
    auto w = std::min(work.Width, static_cast<int>(std::lround(std::clamp(width, 1040.0, 2400.0) * scale)));
    auto h = std::min(work.Height, static_cast<int>(std::lround(std::clamp(height, 700.0, 1600.0) * scale)));
    return {work.X + (work.Width - w) / 2, work.Y + (work.Height - h) / 2, w, h};
}
void applyBrandResources(ResourceDictionary const& resources) {
    // Same light/dark accent as morrowGreen in the SwiftUI app. Leave the
    // HighContrast dictionary to WinUI's system-colour resources.
    for (bool dark : {false, true}) {
        ResourceDictionary palette;
        auto green = dark ? Windows::UI::Color{255, 166, 212, 176} : Windows::UI::Color{255, 26, 74, 61};
        for (auto key : {L"SystemAccentColor", L"SystemAccentColorDark1", L"SystemAccentColorDark2", L"SystemAccentColorDark3",
            L"SystemAccentColorLight1", L"SystemAccentColorLight2", L"SystemAccentColorLight3"}) palette.Insert(box_value(key), box_value(green));
        for (auto key : {L"AccentFillColorDefaultBrush", L"AccentFillColorSecondaryBrush", L"AccentFillColorTertiaryBrush",
            L"AccentTextFillColorPrimaryBrush", L"AccentTextFillColorSecondaryBrush", L"AccentTextFillColorTertiaryBrush",
            L"NavigationViewSelectionIndicatorForeground"}) {
            Media::SolidColorBrush brush(green);
            if (std::wstring_view(key).find(L"Secondary") != std::wstring_view::npos) brush.Opacity(0.9);
            if (std::wstring_view(key).find(L"Tertiary") != std::wstring_view::npos) brush.Opacity(0.8);
            palette.Insert(box_value(key), brush);
        }
        resources.ThemeDictionaries().Insert(box_value(dark ? L"Default" : L"Light"), palette);
    }
    resources.ThemeDictionaries().Insert(box_value(L"HighContrast"), ResourceDictionary());
}
TextBlock label(hstring const& value, double size, bool selectable) {
    TextBlock result; result.Text(value); result.FontSize(size);
    if (size >= 20) result.FontWeight(Windows::UI::Text::FontWeight{600});
    result.TextWrapping(TextWrapping::Wrap); result.IsTextSelectionEnabled(selectable);
    return result;
}
Button button(hstring const& value, std::function<void()> action) {
    Button result; result.Content(box_value(value));
    Automation::AutomationProperties::SetName(result, value);
    result.Click([action = std::move(action)](auto const&, auto const&) { action(); });
    return result;
}
StackPanel stack(double gap) { StackPanel result; result.Spacing(gap); return result; }
ListViewItem clickedListItem(ListView const& list, IInspectable const& clicked) {
    // WinUI returns Content when an item is its own container.
    // ponytail: native lists are bounded to 50 items; index content if they become unbounded.
    for (auto const& value : list.Items()) {
        auto item = value.try_as<ListViewItem>();
        if (item && (item == clicked || item.Content() == clicked)) return item;
    }
    return nullptr;
}
TextBox field(hstring const& title, hstring const& value, bool multiline) {
    TextBox result; result.Header(box_value(title)); result.Text(value);
    result.AcceptsReturn(multiline); result.TextWrapping(multiline ? TextWrapping::Wrap : TextWrapping::NoWrap);
    result.MaxLength(multiline ? 100000 : 4096);
    if (multiline) { result.MinHeight(180); result.MaxHeight(600); }
    Automation::AutomationProperties::SetName(result, title);
    return result;
}
ScrollViewer scroll(UIElement const& child) {
    ScrollViewer result; result.Content(child);
    result.HorizontalScrollBarVisibility(ScrollBarVisibility::Disabled);
    result.VerticalScrollBarVisibility(ScrollBarVisibility::Auto);
    return result;
}
namespace {
StackPanel actions() { auto result = stack(); result.Orientation(Orientation::Horizontal); return result; }
Button iconButton(hstring const& glyph, hstring const& name, std::function<void()> action) {
    auto result = button(name, std::move(action));
    FontIcon icon; icon.Glyph(glyph); icon.FontSize(14); result.Content(icon);
    result.Width(30); result.Height(28); result.Padding(ThicknessHelper::FromUniformLength(0));
    ToolTipService::SetToolTip(result, box_value(name));
    return result;
}
StackPanel emptyMailReader() {
    auto emptyReader = stack(14); emptyReader.HorizontalAlignment(HorizontalAlignment::Center); emptyReader.VerticalAlignment(VerticalAlignment::Center);
    emptyReader.Margin(ThicknessHelper::FromUniformLength(36));
    auto emptyIcon = Markup::XamlReader::Load(L"<FontIcon xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' Glyph='&#xE8C3;' FontSize='42' Foreground='{ThemeResource AccentTextFillColorPrimaryBrush}'/>").as<FontIcon>();
    emptyIcon.HorizontalAlignment(HorizontalAlignment::Center);
    Automation::AutomationProperties::SetAccessibilityView(emptyIcon, Automation::Peers::AccessibilityView::Raw);
    emptyReader.Children().Append(emptyIcon);
    auto emptyTitle = label(L"A little room to think", 22); emptyTitle.TextAlignment(TextAlignment::Center); emptyReader.Children().Append(emptyTitle);
    auto emptyDetail = label(L"Choose a message to read, or compose something new."); emptyDetail.MaxWidth(380); emptyDetail.Opacity(0.7); emptyDetail.TextAlignment(TextAlignment::Center); emptyReader.Children().Append(emptyDetail);
    return emptyReader;
}
void showRowActions(ListViewItem const& entry, bool visible) {
    auto row = entry.Content().try_as<StackPanel>();
    if (!row) return;
    if (auto quick = row.Tag().try_as<StackPanel>()) quick.Visibility(visible ? Visibility::Visible : Visibility::Collapsed);
}
double minimumMailListHeight(Grid const& list) {
    return std::max(200.0, list.RowDefinitions().GetAt(0).ActualHeight() + list.RowDefinitions().GetAt(2).ActualHeight() + 80.0);
}
void bold(TextBlock const& text, bool active) {
    Windows::UI::Text::FontWeight weight{}; weight.Weight = active ? 600 : 400; text.FontWeight(weight);
}
NavigationViewItem navItem(hstring const& title, hstring const& section, hstring const& owner = {}, hstring const& folder = L"inbox", hstring const& glyph = L"\uE8A5") {
    NavigationViewItem item; item.Content(box_value(title));
    ToolTipService::SetToolTip(item, box_value(title));
    FontIcon icon; icon.Glyph(glyph); item.Icon(icon);
    Json tag; put(tag, L"section", section); put(tag, L"owner", owner); put(tag, L"folder", folder);
    item.Tag(tag); return item;
}
hstring errorText() {
    try { throw; } catch (hresult_error const& error) { return error.message(); }
    catch (...) { return L"The operation could not be completed. Your saved workspace has been retained."; }
}
IAsyncOperation<ContentDialogResult> showReaderPopup(std::shared_ptr<Shell> const& shell,
    ContentDialog const& dialog, std::function<void()>& release) {
    auto held = std::make_shared<bool>(true);
    release = [shell, held] { if (std::exchange(*held, false)) shell->dialogOpen = false; };
    dialog.Closed([release](auto const&, auto const&) { release(); });
    shell->dialogOpen = true;
    try { return dialog.ShowAsync(); }
    catch (...) { release(); throw; }
}
bool sameDay(hstring const& iso) {
    SYSTEMTIME utc{};
    auto input = std::wstring(iso);
    unsigned year, month, day, hour, minute, second;
    if (swscanf_s(input.c_str(), L"%u-%u-%uT%u:%u:%u", &year, &month, &day, &hour, &minute, &second) != 6) return false;
    utc.wYear = static_cast<WORD>(year); utc.wMonth = static_cast<WORD>(month); utc.wDay = static_cast<WORD>(day);
    utc.wHour = static_cast<WORD>(hour); utc.wMinute = static_cast<WORD>(minute); utc.wSecond = static_cast<WORD>(second);
    SYSTEMTIME local{}, now{};
    if (!SystemTimeToTzSpecificLocalTime(nullptr, &utc, &local)) return false;
    GetLocalTime(&now);
    return local.wYear == now.wYear && local.wMonth == now.wMonth && local.wDay == now.wDay;
}
void setupKeyboardAccelerators(std::shared_ptr<Shell> const& shell) {
    using Key = Windows::System::VirtualKey;
    using Modifiers = Windows::System::VirtualKeyModifiers;
    auto invoked = [weak = std::weak_ptr<Shell>(shell)](Input::KeyboardAccelerator const& shortcut, Input::KeyboardAcceleratorInvokedEventArgs const& event) -> fire_and_forget {
        event.Handled(true);
        auto self = weak.lock();
        if (!self || self->closing || self->dialogOpen || self->loading || !self->service
            || self->service->writing() || !self->navigation.IsEnabled()) co_return;
        auto key = shortcut.Key(); auto modifiers = shortcut.Modifiers();
        auto captured = self->owner; auto version = self->generation;
        try {
            if (key == Key::N) co_await compose(self);
            else if (key == Key::F) {
                if (self->section != L"mail") {
                    co_await self->navigate(L"mail", captured, self->folder);
                    ++version;
                }
                if (self->current(version, captured) && self->section == L"mail"
                    && !self->dialogOpen && !self->loading && !self->service->writing() && self->navigation.IsEnabled()
                    && self->search && self->search.IsLoaded() && self->search.IsEnabled()) self->search.Focus(FocusState::Keyboard);
            } else if (key == Key::R && modifiers == (Modifiers::Control | Modifiers::Shift)) {
                auto message = self->selected; auto account = text(message, L"accountId");
                if (self->section == L"mail" && !text(message, L"id").empty() && self->connected(account)
                    && (captured == L"all" || captured == account) && !flag(message, L"providerDraft") && text(message, L"folder") != L"drafts")
                    co_await self->prepare(message, L"reply");
            } else if (key == Key::R) co_await self->sync();
            else if (key == Key::Number1) co_await self->navigate(L"mail", captured, L"inbox");
            else if (key == Key::Number2) co_await self->navigate(L"studio", captured);
            else if (key == Key::Number3) co_await self->navigate(L"calendar", captured);
            else if (key == Key::Number4) co_await self->navigate(L"today", captured);
            else if (key == static_cast<Key>(VK_OEM_COMMA)) co_await self->navigate(L"preferences", captured);
        } catch (...) { if (!self->closing) self->error(errorText()); }
    };
    // Native matching handles modifiers and IME; do not intercept ordinary typing with KeyDown.
    for (auto key : {Key::N, Key::F, Key::R, static_cast<Key>(VK_OEM_COMMA), Key::Number1, Key::Number2, Key::Number3, Key::Number4}) {
        Input::KeyboardAccelerator shortcut; shortcut.Key(key); shortcut.Modifiers(Modifiers::Control);
        shortcut.Invoked(invoked); shell->root.KeyboardAccelerators().Append(shortcut);
    }
    Input::KeyboardAccelerator reply; reply.Key(Key::R); reply.Modifiers(Modifiers::Control | Modifiers::Shift);
    reply.Invoked(invoked); shell->root.KeyboardAccelerators().Append(reply);
    Input::KeyboardAccelerator undo; undo.Key(Key::Z); undo.Modifiers(Modifiers::Control);
    undo.Invoked([weak = std::weak_ptr<Shell>(shell)](auto const&, auto const& event) {
        auto self = weak.lock();
        if (!self || self->section != L"mail" || self->dialogOpen || self->loading || !self->dirty.empty() || self->closing || self->service->writing()) return;
        auto focus = Input::FocusManager::GetFocusedElement(self->root.XamlRoot());
        if (focus && (focus.try_as<TextBox>() || focus.try_as<RichEditBox>() || focus.try_as<PasswordBox>())) return;
        self->updateTrashUndo();
        if (!self->trashUndos.empty()) { event.Handled(true); self->undoTrash(); }
    });
    shell->root.KeyboardAccelerators().Append(undo);
}
}
void Shell::error(hstring const& message) { if (status) status.Text(message); }
bool Shell::connected(hstring const& account) const {
    for (auto const& entry : array(state, L"accounts")) if (text(entry.GetObject(), L"id") == account && account != L"demo") return true;
    return false;
}
bool Shell::current(uint64_t value, hstring const& account) const { return !closing && value == generation && owner == account; }
void Shell::show(UIElement const& content) { page.Content(content); }
IAsyncOperation<bool> Shell::confirm(hstring title, hstring detail, hstring accept) {
    auto lifetime = shared_from_this();
    if (dialogOpen || closing) co_return false;
    dialogOpen = true;
    ContentDialog dialog; dialog.XamlRoot(root.XamlRoot()); dialog.Title(box_value(title));
    dialog.Content(scroll(label(detail))); dialog.PrimaryButtonText(accept); dialog.CloseButtonText(L"Cancel");
    dialog.DefaultButton(ContentDialogButton::Close);
    try { auto result = co_await dialog.ShowAsync(); dialogOpen = false; co_return result == ContentDialogResult::Primary; }
    catch (...) { dialogOpen = false; throw; }
}
IAsyncAction Shell::alert(hstring title, hstring detail) {
    auto lifetime = shared_from_this();
    if (dialogOpen || closing) co_return;
    dialogOpen = true;
    ContentDialog dialog; dialog.XamlRoot(root.XamlRoot()); dialog.Title(box_value(title));
    dialog.Content(scroll(label(detail))); dialog.CloseButtonText(L"Close");
    try { co_await dialog.ShowAsync(); } catch (...) { error(errorText()); }
    dialogOpen = false;
}
IAsyncAction Shell::start() {
    auto lifetime = shared_from_this();
    startupTrace("creating window");
    window = Window(); window.Title(L"Morrow Mail");
    startupTrace("creating navigation");
    // NavigationView uses translucent/transparent surfaces; paint an opaque,
    // live theme resource underneath them, including system high contrast.
    root = Markup::XamlReader::Load(L"<Grid xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' Background='{ThemeResource SolidBackgroundFillColorBaseBrush}'/>").as<Grid>();
    root.RowDefinitions().Append(RowDefinition());
    RowDefinition statusRow; statusRow.Height(GridLengthHelper::Auto()); root.RowDefinitions().Append(statusRow);
    navigation = NavigationView(); navigation.IsSettingsVisible(true);
    navigation.IsBackButtonVisible(NavigationViewBackButtonVisible::Collapsed);
    navigation.OpenPaneLength(230); navigation.PaneDisplayMode(NavigationViewPaneDisplayMode::Left);
    auto brand = stack(10); brand.Margin(ThicknessHelper::FromLengths(12, 4, 12, 12));
    brand.Children().Append(label(L"Morrow", 22));
    brand.Children().Append(label(L"A calmer kind of inbox", 12));
    composeButton = button(L"Compose", [weak = weak_from_this()] {
        if (auto self = weak.lock(); self && self->service && !self->loading && !self->dialogOpen
            && self->navigation.IsEnabled() && !self->closing) compose(self);
    });
    composeButton.HorizontalAlignment(HorizontalAlignment::Stretch); composeButton.IsEnabled(false);
    composeButton.Style(Application::Current().Resources().Lookup(box_value(L"AccentButtonStyle")).as<Style>());
    brand.Children().Append(composeButton); navigation.PaneHeader(brand);
    folderFilter = field(L"Filter labels / folders"); folderFilter.Header(nullptr); folderFilter.PlaceholderText(L"Filter labels / folders");
    folderFilter.HorizontalAlignment(HorizontalAlignment::Stretch); brand.Children().Append(folderFilter);
    folderFilter.TextChanged([weak = weak_from_this()](auto const&, auto const&) {
        if (auto self = weak.lock()) self->root.DispatcherQueue().TryEnqueue([weak] {
            if (auto self = weak.lock(); self && self->service && !self->closing) self->rebuildNavigation();
        });
    });
    page = ContentControl(); page.HorizontalContentAlignment(HorizontalAlignment::Stretch); page.VerticalContentAlignment(VerticalAlignment::Stretch);
    navigation.Content(page); root.Children().Append(navigation);
    Primitives::Thumb sidebarResize; sidebarDivider = sidebarResize;
    sidebarResize.Width(6); sidebarResize.HorizontalAlignment(HorizontalAlignment::Left); sidebarResize.VerticalAlignment(VerticalAlignment::Stretch); sidebarResize.IsTabStop(true);
    sidebarResize.Template(Markup::XamlReader::Load(L"<ControlTemplate xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' TargetType='Thumb'><Border Background='{ThemeResource DividerStrokeColorDefaultBrush}'/></ControlTemplate>").as<ControlTemplate>());
    Automation::AutomationProperties::SetName(sidebarResize, L"Resize sidebar"); ToolTipService::SetToolTip(sidebarResize, box_value(L"Drag to resize sidebar; arrow keys adjust width"));
    sidebarResize.DragDelta([weak = weak_from_this()](auto const&, Primitives::DragDeltaEventArgs const& event) { if (auto self = weak.lock()) self->resizeSidebar(self->navigation.OpenPaneLength() + event.HorizontalChange(), false); });
    sidebarResize.DragCompleted([weak = weak_from_this()](auto const&, auto const&) { if (auto self = weak.lock()) self->resizeSidebar(self->navigation.OpenPaneLength()); });
    sidebarResize.KeyDown([weak = weak_from_this()](auto const&, Input::KeyRoutedEventArgs const& event) {
        using Key = Windows::System::VirtualKey;
        if (event.Key() == Key::Left || event.Key() == Key::Right) if (auto self = weak.lock()) {
            self->resizeSidebar(self->navigation.OpenPaneLength() + (event.Key() == Key::Left ? -20 : 20)); event.Handled(true);
        }
    });
    root.Children().Append(sidebarResize);
    auto updateSidebar = [weak = weak_from_this()](auto const&, auto const&) { if (auto self = weak.lock()) self->resizeSidebar(self->navigation.OpenPaneLength(), false); };
    root.SizeChanged(updateSidebar); navigation.PaneOpened(updateSidebar); navigation.PaneClosed(updateSidebar); navigation.DisplayModeChanged(updateSidebar);
    resizeSidebar(230, false);
    status = label(L"Opening your private workspace…"); status.Margin(ThicknessHelper::FromLengths(16, 6, 16, 8));
    Automation::AutomationProperties::SetLiveSetting(status, Automation::Peers::AutomationLiveSetting::Polite);
    Grid footer; footer.ColumnDefinitions().Append(ColumnDefinition());
    ColumnDefinition undoColumn; undoColumn.Width(GridLengthHelper::Auto()); footer.ColumnDefinitions().Append(undoColumn);
    footer.Children().Append(status);
    trashUndoButton = button(L"Undo Trash (Ctrl+Z) · 1 minute", [weak = weak_from_this()] { if (auto self = weak.lock()) self->undoTrash(); });
    trashUndoButton.Margin(ThicknessHelper::FromLengths(8, 4, 16, 4)); trashUndoButton.Visibility(Visibility::Collapsed);
    Grid::SetColumn(trashUndoButton, 1); footer.Children().Append(trashUndoButton);
    Grid::SetRow(footer, 1); root.Children().Append(footer);
    window.Content(root);
    startupTrace("window content assigned");
    window.AppWindow().MoveAndResize(mailWindowBounds(window, 1220, 800));
    auto weak = weak_from_this();
    window.AppWindow().Closing([weak](auto const&, Microsoft::UI::Windowing::AppWindowClosingEventArgs const& event) {
        if (auto self = weak.lock(); self && !self->closeReady) { event.Cancel(true); if (!self->closing) self->shutdown(); }
    });
    navigation.ItemInvoked([weak](auto const&, NavigationViewItemInvokedEventArgs const& event) {
        auto self = weak.lock(); if (!self || self->selectingNavigation || self->loading) return;
        hstring target, account, folder = L"inbox";
        if (event.IsSettingsInvoked()) target = flag(self->updateResult, L"updateAvailable") ? L"about" : L"preferences";
        else {
            auto item = event.InvokedItemContainer().try_as<NavigationViewItem>();
            if (!item || !item.Tag() || item.MenuItems().Size()) return;
            auto tag = item.Tag().as<Json>();
            target = text(tag, L"section"); account = text(tag, L"owner"); folder = text(tag, L"folder");
        }
        // Rebuilding MenuItems during ItemInvoked invalidates WinUI's active item.
        auto version = self->generation; auto captured = self->owner;
        self->root.DispatcherQueue().TryEnqueue([weak, version, captured, target, account, folder] {
            if (auto self = weak.lock(); self && self->current(version, captured)) {
                if (target == L"manage-folders") self->manageFolders(account);
                else self->navigate(target, account, folder);
            }
        });
    });
    window.Activate();
    startupTrace("window activated");
    try {
        service = std::make_shared<Service>(Service::workspace());
        if (std::wstring_view(GetCommandLineW()).find(L"--native-smoke") != std::wstring_view::npos) {
            auto directory = service->directory();
            std::ifstream marker(directory / L"disposable-native-fixture");
            std::string value((std::istreambuf_iterator<char>(marker)), {});
            if (!directory.is_absolute() || std::filesystem::canonical(directory.parent_path()) != std::filesystem::canonical(std::filesystem::temp_directory_path()) || !directory.filename().wstring().starts_with(L"morrow-native-check-") || value != "Morrow native acceptance fixture")
                throw hresult_error(E_ACCESSDENIED, L"Native acceptance requires a marked temporary workspace before starting the service.");
        }
        co_await service->start();
        if (closing) co_return;
        try {
            auto size = service->windowState();
            auto width = size.GetNamedNumber(L"width", 1220), height = size.GetNamedNumber(L"height", 800);
            if (std::isfinite(width) && std::isfinite(height)) window.AppWindow().MoveAndResize(mailWindowBounds(window, width, height));
        } catch (...) { error(L"The previous window size could not be restored."); }
        auto savedLayout = text(service->clientState(), L"morrow.mail.layout");
        if (savedLayout == L"right" || savedLayout == L"bottom" || savedLayout == L"focus") mailLayout = savedLayout;
        auto savedSidebar = text(service->clientState(), L"morrow.sidebar.width");
        if (!savedSidebar.empty()) try { size_t used; auto width = std::stod(std::wstring(savedSidebar), &used); if (used == savedSidebar.size()) resizeSidebar(width, false); } catch (...) { error(L"The previous sidebar width could not be restored."); }
        co_await refresh(true);
        setupKeyboardAccelerators(lifetime);
        co_await navigate(L"mail");
        if (GetCommandLineW() && std::wstring_view(GetCommandLineW()).find(L"--native-smoke") != std::wstring_view::npos) { co_await smoke(); co_return; }
        checkUpdates();
        timer = DispatcherTimer(); timer.Interval(std::chrono::seconds(5));
        timer.Tick([weak](auto const&, auto const&) {
            if (auto self = weak.lock(); self && !self->closing) {
                self->updateTrashUndo();
                if (!self->service->alive()) { self->error(L"The private service stopped. Close and reopen Morrow Mail; saved data is retained."); return; }
                if (!self->loading && self->dirty.empty() && !self->dialogOpen) self->refresh(false);
                self->checkUpdates();
            }
        });
        timer.Start();
    } catch (...) { error(errorText()); }
}
IAsyncAction Shell::refresh(bool rebuild) {
    auto lifetime = shared_from_this(); auto version = generation; auto captured = owner;
    try {
        auto result = co_await service->request(L"/state", captured);
        if (!current(version, captured)) co_return;
        bool changedAccounts = array(result, L"accounts").Stringify() != array(state, L"accounts").Stringify();
        state = result;
        auto theme = text(object(object(state, L"settings"), L"preferences"), L"theme");
        root.RequestedTheme(theme == L"dark" ? ElementTheme::Dark : theme == L"light" ? ElementTheme::Light : ElementTheme::Default);
        if (owner.empty() || (!connected(owner) && owner != L"all")) {
            auto active = text(object(state, L"account"), L"id");
            owner = connected(active) || active == L"all" ? active : L"";
            if (owner.empty() && array(state, L"accounts").Size()) owner = text(array(state, L"accounts").GetAt(0).GetObject(), L"id");
        }
        if (rebuild || changedAccounts) rebuildNavigation();
        if (!connected(owner) && owner != L"all") selected = Json();
        if (section == L"activity" || section == L"today") co_await workspacePage(lifetime, section);
        error(L"");
    } catch (...) { error(errorText()); }
}
void Shell::rebuildNavigation() {
    selectingNavigation = true;
    Json desktopState;
    try { desktopState = service->clientState(); } catch (...) { error(errorText()); }
    navigation.MenuItems().Clear();
    auto matches = [&](hstring const& name) {
        auto query = folderFilter ? folderFilter.Text() : hstring{};
        return query.empty() || FindStringOrdinal(FIND_FROMSTART, name.c_str(), static_cast<int>(name.size()), query.c_str(), static_cast<int>(query.size()), TRUE) >= 0;
    };
    auto folderActions = [&](NavigationViewItem const& item, hstring account, hstring id = {}) {
        MenuFlyout menu; MenuFlyoutItem manage; manage.Text(L"Manage labels / folders…");
        manage.Click([weak = weak_from_this(), account, id](auto const&, auto const&) { if (auto self = weak.lock()) self->manageFolders(account, id); }); menu.Items().Append(manage);
        if (!id.empty()) {
            MenuFlyoutItem move; move.Text(L"Move selected message here…");
            menu.Opening([weak = weak_from_this(), move, account](auto const&, auto const&) { if (auto self = weak.lock()) move.IsEnabled(!self->loading && !self->dialogOpen && self->dirty.empty() && text(self->selected,L"accountId") == account && !text(self->selected,L"id").empty() && !flag(self->selected,L"providerFolderMissing")); });
            move.Click([weak = weak_from_this(), account, id](auto const&, auto const&) { if (auto self = weak.lock(); self && text(self->selected,L"accountId") == account) self->organize(self->selected, {}, id); }); menu.Items().Append(move);
        }
        item.ContextFlyout(menu);
    };
    NavigationViewItemHeader header; header.Content(box_value(L"Workspace")); navigation.MenuItems().Append(header);
    struct Destination { wchar_t const* title; wchar_t const* id; wchar_t const* glyph; };
    for (auto const& entry : {Destination{L"Today", L"today", L"\uE706"}, {L"Reply Suggestions", L"reply-suggestions", L"\uE8F2"},
        {L"Out of Office", L"out-of-office", L"\uE708"}, {L"AI Studio", L"studio", L"\uE734"},
        {L"Calendar", L"calendar", L"\uE787"}, {L"Outbox", L"scheduled", L"\uE823"}}) {
        auto item = navItem(entry.title, entry.id, {}, L"inbox", entry.glyph);
        item.IsSelected(section == entry.id); navigation.MenuItems().Append(item);
    }
    std::vector<Json> accounts;
    for (auto const& value : array(state, L"accounts")) {
        auto account = value.GetObject(); auto id = text(account, L"id");
        if (!id.empty() && id != L"demo" && id != L"all") accounts.push_back(account);
    }
    composeButton.IsEnabled(!accounts.empty());
    auto accountGroup = [&](hstring const& id, hstring const& title, hstring const& subtitle) {
        auto item = navItem(title, L"mail", id, L"inbox", id == L"all" ? L"\uE8F1" : L"\uE715");
        item.SelectsOnInvoked(false);
        auto caption = stack(2); auto name = label(title, 12); bold(name, true); name.IsTextSelectionEnabled(false);
        name.MaxLines(2); name.TextTrimming(TextTrimming::CharacterEllipsis);
        auto detail = label(subtitle, 11); detail.IsTextSelectionEnabled(false);
        caption.Children().Append(name); caption.Children().Append(detail); item.Content(caption);
        Automation::AutomationProperties::SetName(item, title + L", " + subtitle);
        auto collapseKey = L"morrow.account.collapsed." + id;
        item.IsExpanded((folderFilter && !folderFilter.Text().empty()) || text(desktopState, collapseKey.c_str()) != L"true");
        item.RegisterPropertyChangedCallback(NavigationViewItem::IsExpandedProperty(), [weak = weak_from_this(), collapseKey](DependencyObject const& sender, DependencyProperty const&) {
            if (auto self = weak.lock(); self && !self->selectingNavigation && !self->closing && (!self->folderFilter || self->folderFilter.Text().empty())) {
                try { self->service->saveClientState(collapseKey, sender.as<NavigationViewItem>().IsExpanded() ? L"false" : L"true"); }
                catch (...) { self->error(errorText()); }
            }
        });
        for (auto const& mailbox : {Destination{L"Inbox",L"inbox",L"\uE715"}, {L"Starred",L"starred",L"\uE734"},
            {L"Pending",L"pending",L"\uE823"}, {L"Sent",L"sent",L"\uE724"}, {L"Drafts",L"drafts",L"\uE70F"},
            {L"Archive",L"archive",L"\uE7B8"}, {L"Spam / Junk",L"spam",L"\uE7BA"}, {L"Trash",L"trash",L"\uE74D"}}) {
            if (!matches(mailbox.title)) continue;
            auto child = navItem(mailbox.title, L"mail", id, mailbox.id, mailbox.glyph);
            uint64_t count = 0;
            for (auto const& account : accounts) if (id == L"all" || text(account, L"id") == id)
                count += static_cast<uint64_t>(mailbox.id == std::wstring_view(L"inbox") ? account.GetNamedNumber(L"unread", 0) : object(account, L"counts").GetNamedNumber(mailbox.id, 0));
            if (count && (mailbox.id == std::wstring_view(L"inbox") || mailbox.id == std::wstring_view(L"pending") || mailbox.id == std::wstring_view(L"drafts"))) {
                InfoBadge badge; badge.Value(static_cast<int32_t>(std::min<uint64_t>(count, INT32_MAX))); child.InfoBadge(badge);
            }
            child.IsSelected(section == L"mail" && owner == id && folder == mailbox.id);
            item.MenuItems().Append(child);
        }
        if (id != L"all") {
            auto outbox = navItem(L"Outbox", L"scheduled", id, L"inbox", L"\uE823");
            outbox.IsSelected(section == L"scheduled" && owner == id); item.MenuItems().Append(outbox);
            auto provider = text(object(serverFolders, id.c_str()), L"provider");
            if (provider.empty()) for (auto const& account : accounts) if (text(account, L"id") == id) provider = text(account, L"provider");
            auto remote = navItem(provider == L"google" ? L"Gmail labels" : L"Server folders", L"server-folders", id, L"inbox", L"\uE8B7");
            folderActions(remote, id);
            auto catalog = object(serverFolders, id.c_str());
            remote.SelectsOnInvoked(false);
            remote.MenuItems().Append(navItem(L"Browse / refresh server list", L"server-folders", id, L"inbox", L"\uE72C"));
            remote.MenuItems().Append(navItem(L"Manage labels / folders…", L"manage-folders", id, L"inbox", L"\uE70F"));
            if (catalog.Size()) {
                for (auto const& value : array(catalog, L"folders")) {
                    auto entry = value.GetObject(); auto key = L"provider:" + text(entry, L"id");
                    if (!matches(text(entry, L"name"))) continue;
                    auto child = navItem(text(entry, L"name"), L"mail", id, key, L"\uE8B7");
                    folderActions(child, id, text(entry,L"id"));
                    child.IsSelected(section == L"mail" && owner == id && folder == key); remote.MenuItems().Append(child);
                }
                remote.IsExpanded((folderFilter && !folderFilter.Text().empty()) || section == L"mail" && owner == id && std::wstring_view(folder).starts_with(L"provider:"));
            }
            item.MenuItems().Append(remote);
        }
        navigation.MenuItems().Append(item);
    };
    if (!accounts.empty()) accountGroup(L"all", L"All accounts", L"Combined mail");
    for (auto const& account : accounts) {
        auto provider = text(account, L"provider");
        accountGroup(text(account, L"id"), text(account, L"email", text(account, L"id")), provider == L"google" ? L"Gmail" : provider == L"microsoft" ? L"Outlook" : L"IMAP");
    }
    navigation.FooterMenuItems().Clear();
    auto activity = navItem(L"Activity", L"activity", {}, L"inbox", L"\uE9D9"); activity.IsSelected(section == L"activity");
    navigation.FooterMenuItems().Append(activity);
    navigation.FooterMenuItems().Append(navItem(L"Add account", L"settings", {}, L"inbox", L"\uE710"));
    if (auto settings = navigation.SettingsItem().try_as<NavigationViewItem>()) {
        settings.Content(box_value(L"Settings & connections"));
        settings.IsSelected(section == L"settings" || section == L"preferences" || section == L"policy" || section == L"about");
    }
    updateBadge();
    selectingNavigation = false;
}
IAsyncAction Shell::navigate(hstring target, hstring account, hstring mailFolder) {
    auto lifetime = shared_from_this();
    if (closing || loading) co_return;
    if (section == L"compose" && !navigation.IsEnabled()) co_return;
    if (!dirty.empty() && !(co_await confirm(L"Discard unsaved changes?", L"Your current edits have not been saved.", L"Discard"))) co_return;
    dirty.clear();
    ++generation; ++selectionGeneration; selected = Json(); readerFocused = false;
    auto version = generation;
    if (!account.empty()) owner = account;
    auto captured = owner;
    section = target; folder = mailFolder; cursors = {L""}; nextCursor = L"";
    rebuildNavigation();
    error(L"");
    if (target == L"mail") {
        if (!connected(owner) && owner != L"all") {
            auto onboarding = stack(16); onboarding.HorizontalAlignment(HorizontalAlignment::Center); onboarding.VerticalAlignment(VerticalAlignment::Center);
            onboarding.MaxWidth(560); onboarding.Margin(ThicknessHelper::FromUniformLength(30));
            onboarding.Children().Append(label(L"Add your first account", 24));
            onboarding.Children().Append(label(L"Connect Gmail, Outlook, or an IMAP account to start reading your mail."));
            auto add = button(L"Add account", [weak = weak_from_this()] { if (auto self = weak.lock()) self->navigate(L"settings"); });
            add.Style(Application::Current().Resources().Lookup(box_value(L"AccentButtonStyle")).as<Style>());
            onboarding.Children().Append(add); show(onboarding); co_return;
        }
        loading = true;
        try {
            Json body; put(body, L"accountId", owner);
            auto result = co_await service->request(L"/account/select", owner, L"POST", body);
            if (!current(version, captured)) { loading = false; co_return; }
            state = result;
        } catch (...) { loading = false; error(errorText()); co_return; }
        loading = false; mailPage(); co_await loadPage();
    } else if (target == L"server-folders") {
        auto panel = stack(12); panel.Children().Append(label(L"Server labels / folders", 26));
        panel.Children().Append(label(L"Choose a server label or folder to browse downloaded mail. Sync or import history to add more messages; refreshing this list only reads folder names."));
        show(scroll(panel)); loading = true;
        try {
            auto result = co_await service->request(L"/mail/folders", captured);
            if (!current(version, captured) || !connected(captured)) { loading = false; co_return; }
            if (text(result, L"accountId") != captured) throw hresult_error(E_FAIL, L"The server folder list could not be confirmed.");
            Json catalog; JsonArray entries;
            for (auto const& value : array(result, L"folders")) {
                auto entry = value.GetObject(); auto key = text(entry, L"id");
                if (key.empty() || key == L"__archive") continue;
                entries.Append(value);
                auto destination = L"provider:" + key;
                panel.Children().Append(button(text(entry, L"name"), [weak = weak_from_this(), captured, destination] { if (auto self = weak.lock()) self->navigate(L"mail", captured, destination); }));
            }
            catalog.Insert(L"folders", entries); put(catalog, L"provider", text(result, L"provider"));
            serverFolders.Insert(captured, catalog); rebuildNavigation();
        } catch (...) { error(errorText()); }
        loading = false;
    } else if (target == L"settings") co_await settingsPage(lifetime, L"mail");
    else if (target == L"preferences") co_await settingsPage(lifetime, L"general");
    else if (target == L"policy") co_await settingsPage(lifetime, L"policy");
    else if (target == L"about") co_await settingsPage(lifetime, L"about");
    else if (target == L"scheduled") co_await scheduledPage(lifetime);
    else if (target == L"out-of-office") co_await outOfOfficePage(lifetime);
    else if (target == L"calendar") co_await calendarPage(lifetime);
    else co_await workspacePage(lifetime, target);
}
void Shell::mailPage() {
    Grid layout; layout.Margin(ThicknessHelper::FromUniformLength(16));
    RowDefinition top; top.Height(GridLengthHelper::Auto()); layout.RowDefinitions().Append(top);
    layout.RowDefinitions().Append(RowDefinition());
    auto weak = weak_from_this();
    search = field(L"Search mail"); search.Header(nullptr); search.PlaceholderText(L"Search mail · from:, after:, or an exact phrase");
    Grid searchBar; searchBar.ColumnSpacing(8); searchBar.ColumnDefinitions().Append(ColumnDefinition());
    ColumnDefinition searchActions; searchActions.Width(GridLengthHelper::Auto()); searchBar.ColumnDefinitions().Append(searchActions);
    searchBar.Children().Append(search);
    auto submitSearch = [weak] { if (auto self = weak.lock(); self && !self->loading) { self->cursors = {L""}; self->loadPage(); } };
    search.KeyDown([weak](auto const&, Input::KeyRoutedEventArgs const& event) {
        if (event.Key() == Windows::System::VirtualKey::Enter) if (auto self = weak.lock(); self && !self->loading) { self->cursors = {L""}; self->loadPage(); event.Handled(true); }
    });
    auto searchButtons = actions(); searchButtons.Spacing(8);
    searchButtons.Children().Append(button(L"Clear", [weak] { if (auto self = weak.lock(); self && !self->loading) { self->search.Text(L""); self->cursors = {L""}; self->loadPage(); } }));
    searchButtons.Children().Append(button(L"Search", submitSearch));
    Grid::SetColumn(searchButtons, 1); searchBar.Children().Append(searchButtons); layout.Children().Append(searchBar);
    Grid body; mailBody = body; body.Margin(ThicknessHelper::FromLengths(0, 12, 0, 0));
    Grid list; mailList = list;
    RowDefinition headerRow; headerRow.Height(GridLengthHelper::Auto()); list.RowDefinitions().Append(headerRow);
    list.RowDefinitions().Append(RowDefinition());
    RowDefinition footerRow; footerRow.Height(GridLengthHelper::Auto()); list.RowDefinitions().Append(footerRow);
    auto heading = stack(8); heading.Margin(ThicknessHelper::FromLengths(8, 8, 8, 8));
    auto folderTitle = std::wstring(folder); if (!folderTitle.empty()) folderTitle[0] = towupper(folderTitle[0]);
    if (std::wstring_view(folder).starts_with(L"provider:")) for (auto const& value : array(object(serverFolders, owner.c_str()), L"folders")) {
        auto entry = value.GetObject(); if (folder == L"provider:" + text(entry, L"id")) folderTitle = text(entry, L"name");
    }
    Grid listTitle; listTitle.ColumnDefinitions().Append(ColumnDefinition());
    ColumnDefinition unreadColumn; unreadColumn.Width(GridLengthHelper::Auto()); listTitle.ColumnDefinitions().Append(unreadColumn);
    auto titleText = stack(3); titleText.Children().Append(label(hstring(folderTitle), 20));
    auto accountCaption = label(owner == L"all" ? L"All accounts" : owner, 12); accountCaption.Opacity(0.7);
    titleText.Children().Append(accountCaption);
    listTitle.Children().Append(titleText);
    if (std::wstring_view(folder).starts_with(L"provider:")) {
        auto coverage = label(L"Downloaded mail only. Sync or import history to add more messages.", 11); coverage.MaxLines(2); heading.Children().Append(coverage);
    }
    unreadFilter = CheckBox(); unreadFilter.Content(box_value(L"Unread"));
    Automation::AutomationProperties::SetName(unreadFilter, L"Show unread only");
    unreadFilter.Click([submitSearch](auto const&, auto const&) { submitSearch(); });
    Grid::SetColumn(unreadFilter, 1); listTitle.Children().Append(unreadFilter); heading.Children().Append(listTitle);
    auto toolbar = actions(); toolbar.Spacing(8);
    DropDownButton view; view.Content(box_value(L"View")); MenuFlyout viewMenu;
    for (auto const& option : {std::pair{L"Reader on right",L"right"}, {L"Reader below",L"bottom"}, {L"Focused reading",L"focus"}}) {
        MenuFlyoutItem choice; choice.Text(option.first);
        choice.Click([weak, value = hstring(option.second)](auto const&, auto const&) {
            if (auto self = weak.lock()) {
                self->mailLayout = value; self->applyMailLayout();
                try { self->service->saveClientState(L"morrow.mail.layout", value); } catch (...) { self->error(errorText()); }
            }
        }); viewMenu.Items().Append(choice);
    }
    for (auto const& option : {std::pair{L"Wider sidebar",60.0}, {L"Narrower sidebar",-60.0}}) {
        MenuFlyoutItem choice; choice.Text(option.first);
        choice.Click([weak, delta = option.second](auto const&, auto const&) { if (auto self = weak.lock()) self->resizeSidebar(self->navigation.OpenPaneLength() + delta); });
        viewMenu.Items().Append(choice);
    }
    view.Flyout(viewMenu); toolbar.Children().Append(view);
    sorting = ComboBox(); Automation::AutomationProperties::SetName(sorting, L"Sort mail");
    sorting.Width(100);
    for (auto sort : {L"Newest",L"Oldest",L"Sender",L"Subject",L"Unread first",L"Starred first"}) sorting.Items().Append(box_value(sort));
    sorting.SelectedIndex(0);
    sorting.SelectionChanged([weak](auto const&, auto const&) { if (auto self = weak.lock(); self && !self->loading) { self->cursors = {L""}; self->loadPage(); } });
    toolbar.Children().Append(sorting);
    Grid toolbarRow; toolbarRow.ColumnDefinitions().Append(ColumnDefinition());
    ColumnDefinition syncColumn; syncColumn.Width(GridLengthHelper::Auto()); toolbarRow.ColumnDefinitions().Append(syncColumn);
    toolbarRow.Children().Append(toolbar);
    auto syncButton = iconButton(L"\uE72C", L"Sync Mail", [weak] { if (auto self = weak.lock()) self->sync(); });
    Grid::SetColumn(syncButton, 1); toolbarRow.Children().Append(syncButton);
    heading.Children().Append(toolbarRow); list.Children().Append(heading);
    rows = ListView(); rows.SelectionMode(ListViewSelectionMode::Single); rows.IsItemClickEnabled(true);
    Automation::AutomationProperties::SetName(rows, L"Mail list");
    rows.ItemClick([weak](auto const&, ItemClickEventArgs const& event) {
        if (auto self = weak.lock()) {
            auto item = clickedListItem(self->rows, event.ClickedItem());
            if (item) self->read(item.Tag().as<Json>());
        }
    });
    Grid::SetRow(rows, 1); list.Children().Append(rows);
    Grid footer; footer.ColumnSpacing(8); footer.Margin(ThicknessHelper::FromLengths(8, 8, 8, 0));
    ColumnDefinition previousColumn; previousColumn.Width(GridLengthHelper::Auto()); footer.ColumnDefinitions().Append(previousColumn);
    footer.ColumnDefinitions().Append(ColumnDefinition());
    ColumnDefinition nextColumn; nextColumn.Width(GridLengthHelper::Auto()); footer.ColumnDefinitions().Append(nextColumn);
    previous = button(L"Previous", [weak] { if (auto self = weak.lock(); self && !self->loading && self->cursors.size() > 1) { self->cursors.pop_back(); self->loadPage(); } });
    next = button(L"Next", [weak] { if (auto self = weak.lock(); self && !self->loading && !self->nextCursor.empty()) { self->cursors.push_back(self->nextCursor); self->loadPage(); } });
    pageLabel = label(L"", 11); pageLabel.HorizontalAlignment(HorizontalAlignment::Center); pageLabel.VerticalAlignment(VerticalAlignment::Center);
    Grid::SetColumn(pageLabel, 1); Grid::SetColumn(next, 2);
    footer.Children().Append(previous); footer.Children().Append(pageLabel); footer.Children().Append(next);
    Grid::SetRow(footer, 2); list.Children().Append(footer); body.Children().Append(list);
    Primitives::Thumb resize; mailDivider = resize; resize.IsTabStop(true);
    Automation::AutomationProperties::SetName(resize, L"Resize mail list");
    auto adjust = [weak, body](double horizontal, double vertical) {
        if (auto self = weak.lock()) {
            if (self->mailLayout == L"bottom") {
                auto minimum = minimumMailListHeight(self->mailList);
                self->listHeight = std::clamp(self->listHeight + vertical, minimum, std::max(minimum, body.ActualHeight() - 208.0));
            }
            else self->listWidth = std::clamp(self->listWidth + horizontal, 260.0, std::max(260.0, body.ActualWidth() - 328.0));
            self->applyMailLayout();
        }
    };
    resize.DragDelta([adjust](auto const&, Primitives::DragDeltaEventArgs const& e) { adjust(e.HorizontalChange(), e.VerticalChange()); });
    resize.KeyDown([adjust](auto const&, Input::KeyRoutedEventArgs const& e) {
        using Key = Windows::System::VirtualKey;
        if (e.Key() == Key::Left || e.Key() == Key::Up) { adjust(-20, -20); e.Handled(true); }
        if (e.Key() == Key::Right || e.Key() == Key::Down) { adjust(20, 20); e.Handled(true); }
    });
    Grid::SetColumn(resize, 1); body.Children().Append(resize);
    reader = ContentControl(); reader.HorizontalContentAlignment(HorizontalAlignment::Stretch); reader.VerticalContentAlignment(VerticalAlignment::Stretch);
    reader.Content(emptyMailReader()); Grid::SetColumn(reader, 2); body.Children().Append(reader);
    applyMailLayout(); Grid::SetRow(body, 1); layout.Children().Append(body); show(layout);
}
void Shell::applyMailLayout() {
    if (!mailBody || !mailList || !reader || !mailDivider) return;
    mailBody.RowDefinitions().Clear(); mailBody.ColumnDefinitions().Clear();
    Grid::SetRow(mailList, 0); Grid::SetColumn(mailList, 0); Grid::SetRow(reader, 0); Grid::SetColumn(reader, 0);
    Grid::SetRow(mailDivider, 0); Grid::SetColumn(mailDivider, 0);
    bool focus = mailLayout == L"focus", bottom = mailLayout == L"bottom";
    mailList.Visibility(focus && readerFocused ? Visibility::Collapsed : Visibility::Visible);
    reader.Visibility(focus && !readerFocused ? Visibility::Collapsed : Visibility::Visible);
    mailDivider.Visibility(focus ? Visibility::Collapsed : Visibility::Visible);
    if (focus) return;
    if (bottom) {
        auto minimum = minimumMailListHeight(mailList);
        listHeight = std::max(listHeight, minimum);
        RowDefinition list; list.Height(GridLengthHelper::FromPixels(listHeight)); list.MinHeight(minimum);
        RowDefinition divider; divider.Height(GridLengthHelper::FromPixels(8));
        RowDefinition detail; detail.Height(GridLengthHelper::FromValueAndType(1, GridUnitType::Star)); detail.MinHeight(200);
        mailBody.RowDefinitions().Append(list); mailBody.RowDefinitions().Append(divider); mailBody.RowDefinitions().Append(detail);
        Grid::SetRow(mailDivider, 1); Grid::SetRow(reader, 2);
    } else {
        ColumnDefinition list; list.Width(GridLengthHelper::FromPixels(listWidth)); list.MinWidth(260);
        ColumnDefinition divider; divider.Width(GridLengthHelper::FromPixels(8));
        ColumnDefinition detail; detail.Width(GridLengthHelper::FromValueAndType(1, GridUnitType::Star)); detail.MinWidth(320);
        mailBody.ColumnDefinitions().Append(list); mailBody.ColumnDefinitions().Append(divider); mailBody.ColumnDefinitions().Append(detail);
        Grid::SetColumn(mailDivider, 1); Grid::SetColumn(reader, 2);
    }
}
IAsyncAction Shell::loadPage() {
    auto lifetime = shared_from_this();
    auto weak = weak_from_this();
    if (loading || section != L"mail" || !rows) co_return;
    loading = true; auto version = generation; auto captured = owner;
    previous.IsEnabled(false); next.IsEnabled(false);
    search.IsEnabled(false); sorting.IsEnabled(false); unreadFilter.IsEnabled(false);
    try {
        Json options; put(options, L"folder", folder); put(options, L"cursor", cursors.back());
        if (cursors.back().empty()) options.Insert(L"offset", Value::CreateNumberValue(static_cast<double>((cursors.size() - 1) * 50)));
        wchar_t const* sorts[] = {L"newest",L"oldest",L"sender",L"subject",L"unread",L"starred"};
        put(options, L"sort", sorts[std::clamp(sorting.SelectedIndex(), 0, 5)]);
        auto unread = unreadFilter.IsChecked(); options.Insert(L"unreadOnly", Value::CreateBooleanValue(unread && unread.Value()));
        put(options, L"locale", L"en");
        hstring path = L"/mail/page";
        if (!search.Text().empty()) { path = L"/search"; options.Remove(L"unreadOnly"); put(options, L"query", search.Text()); put(options, L"scope", L"folder"); put(options, L"sort", L"relevance"); options.Insert(L"page",Value::CreateNumberValue(static_cast<double>(cursors.size()-1))); }
        auto result = co_await service->request(path, captured, L"POST", options);
        if (!current(version, captured)) { loading = false; co_return; }
        auto selectedId = text(selected, L"viewId");
        auto messages = array(result, L"messages");
        bool preserve = rows.Items().Size() == messages.Size();
        for (uint32_t i = 0; preserve && i < messages.Size(); ++i)
            preserve = text(rows.Items().GetAt(i).as<ListViewItem>().Tag().as<Json>(), L"viewId") == text(messages.GetAt(i).GetObject(), L"viewId");
        if (!preserve) rows.Items().Clear();
        uint32_t index = 0;
        for (auto const& item : messages) {
            auto message = item.GetObject();
            if (text(message, L"accountId").empty() || text(message, L"viewId").empty()) throw hresult_error(E_FAIL, L"The service returned an unowned mail row.");
            auto density = text(object(object(state, L"settings"), L"preferences"), L"density");
            auto row = stack(density == L"compact" ? 1 : density == L"spacious" ? 6 : 3);
            row.Padding(ThicknessHelper::FromUniformLength(density == L"compact" ? 4 : density == L"spacious" ? 12 : 8));
            Grid heading; ColumnDefinition nameColumn; nameColumn.Width(GridLengthHelper::FromValueAndType(1, GridUnitType::Star)); heading.ColumnDefinitions().Append(nameColumn);
            ColumnDefinition dotColumn; dotColumn.Width(GridLengthHelper::Auto()); heading.ColumnDefinitions().Append(dotColumn);
            ColumnDefinition actionsColumn; actionsColumn.Width(GridLengthHelper::Auto()); heading.ColumnDefinitions().Append(actionsColumn);
            bool unread = !flag(message, L"read");
            auto from = text(message, L"folder") == L"sent" || text(message, L"folder") == L"drafts" ? L"To: " + text(message, L"to") : text(message, L"fromName", text(message, L"fromEmail"));
            auto sender = label(from, 14, false); sender.MaxLines(1); sender.TextTrimming(TextTrimming::CharacterEllipsis); bold(sender, unread); heading.Children().Append(sender);
            auto markers = label((flag(message, L"starred") ? hstring(L"★  ") : hstring{}) + (unread ? L"●" : L""), 14, false); Grid::SetColumn(markers, 1); heading.Children().Append(markers);
            auto quick = actions(); quick.Spacing(2); quick.Visibility(Visibility::Collapsed);
            quick.Children().Append(iconButton(unread ? L"\uE8C3" : L"\uE715", unread ? L"Mark read locally" : L"Mark unread locally", [weak, message, unread] {
                if (auto self = weak.lock()) { Json changes; changes.Insert(L"read", Value::CreateBooleanValue(unread)); self->patch(message, changes); }
            }));
            auto replyAll = iconButton(L"\uE8A6", L"Reply all", [weak, message] { if (auto self = weak.lock()) self->prepare(message, L"replyAll"); });
            replyAll.IsEnabled(text(message, L"folder") != L"drafts"); quick.Children().Append(replyAll);
            auto remote = text(message, L"remoteId", text(message, L"id"));
            auto trash = iconButton(L"\uE74D", L"Move to provider Trash", [weak, message] { if (auto self = weak.lock()) self->organize(message, L"trash"); });
            trash.IsEnabled(text(message, L"folder") != L"trash" && (std::wstring_view(remote).starts_with(L"google:") || std::wstring_view(remote).starts_with(L"microsoft:") || std::wstring_view(remote).starts_with(L"imap:")));
            quick.Children().Append(trash); Grid::SetColumn(quick, 2); heading.Children().Append(quick); row.Children().Append(heading);
            row.Tag(quick);
            for (auto key : {L"subject",L"preview",L"date"}) {
                if (key == std::wstring_view(L"preview") && density == L"compact") continue;
                auto value = text(message, key, key == std::wstring_view(L"subject") ? L"(No subject)" : L"");
                auto content = label(key == std::wstring_view(L"date") ? mailDateLabel(value) : value, key == std::wstring_view(L"date") ? 11 : 13, false);
                content.MaxLines(key == std::wstring_view(L"preview") && density == L"spacious" ? 3 : 1); content.TextTrimming(TextTrimming::CharacterEllipsis);
                bold(content, unread && key != std::wstring_view(L"date")); row.Children().Append(content);
            }
            if (captured == L"all") row.Children().Append(label(text(message, L"accountId"), 11, false));
            if (flag(message, L"pending")) row.Children().Append(label(L"Pending", 11, false));
            auto entry = preserve ? rows.Items().GetAt(index).as<ListViewItem>() : ListViewItem();
            entry.Content(row); entry.Tag(message); entry.HorizontalContentAlignment(HorizontalAlignment::Stretch);
            if (!preserve) {
                auto weakEntry = make_weak(entry);
                auto hovered = std::make_shared<bool>(false), focused = std::make_shared<bool>(false);
                auto update = [weakEntry, hovered, focused] { if (auto item = weakEntry.get()) showRowActions(item, *hovered || *focused); };
                entry.PointerEntered([hovered, update](auto const&, auto const&) { *hovered = true; update(); });
                entry.PointerExited([hovered, update](auto const&, auto const&) { *hovered = false; update(); });
                entry.GotFocus([focused, update](auto const&, auto const&) { *focused = true; update(); });
                entry.LostFocus([weakEntry, focused, update](auto const&, auto const&) {
                    *focused = false;
                    if (auto item = weakEntry.get()) item.DispatcherQueue().TryEnqueue([update] { update(); });
                });
            }
            quick.Visibility(entry.FocusState() == FocusState::Unfocused ? Visibility::Collapsed : Visibility::Visible);
            Automation::AutomationProperties::SetName(entry, text(message, L"fromName") + L", " + text(message, L"subject") + (unread ? L", unread" : L", read"));
            if (!preserve) rows.Items().Append(entry);
            if (text(message, L"viewId") == selectedId) rows.SelectedItem(entry);
            ++index;
        }
        nextCursor = text(result, L"nextCursor");
        previous.IsEnabled(cursors.size() > 1); next.IsEnabled(!nextCursor.empty());
        auto pageNumber = to_hstring(cursors.size());
        auto messageCount = to_hstring(static_cast<uint64_t>(result.GetNamedNumber(L"total", 0)));
        pageLabel.Text(L"Page " + pageNumber + L" · " + messageCount + L" messages");
        Automation::AutomationProperties::SetName(pageLabel, L"Page " + pageNumber + L", " + messageCount + L" messages");
        error(text(result, L"warning"));
    } catch (...) { error(errorText()); }
    search.IsEnabled(true); sorting.IsEnabled(search.Text().empty()); unreadFilter.IsEnabled(search.Text().empty());
    loading = false;
}
IAsyncAction Shell::read(Json metadata) {
    auto lifetime = shared_from_this(); auto version = generation; auto sequence = ++selectionGeneration;
    auto captured = owner; auto account = text(metadata, L"accountId"); auto id = text(metadata, L"id");
    if (!connected(account) || (captured != L"all" && captured != account)) co_return;
    try {
        auto result = co_await service->request(L"/messages/" + escaped(id), account);
        if (!current(version, captured) || sequence != selectionGeneration) co_return;
        auto message = object(result, L"message");
        if (text(message, L"accountId") != account || text(message, L"id") != id) throw hresult_error(E_FAIL, L"The message owner changed. Open it again.");
        selected = message;
        if (text(message, L"folder") == L"drafts" && !flag(message, L"providerDraft")) { co_await compose(lifetime, message); co_return; }
        readerFocused = true; applyMailLayout(); renderReader(message);
        if (!flag(message, L"read") && flag(object(object(state, L"settings"), L"preferences"), L"markReadOnOpen")) {
            Json changes; changes.Insert(L"read", Value::CreateBooleanValue(true));
            auto updated = co_await service->request(L"/messages/" + escaped(id), account, L"PATCH", changes);
            if (!current(version, captured) || sequence != selectionGeneration) co_return;
            selected = object(updated, L"message"); renderReader(selected);
            for (auto& cursor : cursors) cursor = L"";
            co_await loadPage(); // Refresh at the same bounded offset; old signed cursors have a different revision.
        }
    } catch (...) { error(errorText()); }
}
void Shell::renderReader(Json const& message) {
    if (text(message, L"id").empty()) {
        readerFocused = false; applyMailLayout(); reader.Content(emptyMailReader()); return;
    }
    Grid readerLayout;
    RowDefinition actionRow; actionRow.Height(GridLengthHelper::Auto()); readerLayout.RowDefinitions().Append(actionRow);
    readerLayout.RowDefinitions().Append(RowDefinition());
    auto content = stack(8); content.Padding(ThicknessHelper::FromLengths(20, 4, 8, 16));
    auto title = label(text(message, L"subject", L"(No subject)"), 22); content.Children().Append(title);
    content.Children().Append(label(text(message, L"fromName") + L" <" + text(message, L"fromEmail") + L"> · " + mailDateLabel(text(message, L"date")), 12));
    content.Children().Append(label(L"To: " + text(message, L"to") + (text(message, L"cc").empty() ? L"" : L" · Cc: " + text(message, L"cc")), 12));
    auto weak = weak_from_this(); auto replies = actions(); replies.Spacing(8);
    replies.Children().Append(button(L"Back to list", [weak] { if (auto self = weak.lock()) { self->readerFocused = false; self->applyMailLayout(); self->rows.Focus(FocusState::Programmatic); } }));
    if (flag(message, L"providerDraft")) replies.Children().Append(button(L"Copy to local draft", [weak, message] { if (auto self = weak.lock()) self->prepare(message, L"copy"); }));
    else for (auto const& option : {std::pair{L"Reply", L"reply"}, {L"Reply all",L"replyAll"}, {L"Forward",L"forward"}})
        replies.Children().Append(button(option.first, [weak, message, mode = hstring(option.second)] { if (auto self = weak.lock()) self->prepare(message, mode); }));
    auto markers = actions();
    for (auto const& option : {std::pair{L"Read",L"read"}, {L"Starred",L"starred"}, {L"Pending",L"pending"}}) {
        Primitives::ToggleButton toggle; toggle.Content(box_value(option.first)); toggle.IsChecked(flag(message, option.second));
        toggle.Click([weak, message, key = std::wstring(option.second)](auto const&, auto const&) { if (auto self = weak.lock()) { Json change; change.Insert(key, Value::CreateBooleanValue(!flag(message, key.c_str()))); self->patch(message, change); } });
        markers.Children().Append(toggle);
    }
    content.Children().Append(markers);
    auto remote = text(message, L"remoteId", text(message, L"id"));
    if (std::wstring_view(remote).starts_with(L"google:") || std::wstring_view(remote).starts_with(L"microsoft:") || std::wstring_view(remote).starts_with(L"imap:"))
        replies.Children().Append(button(L"Move / Labels / Spam on provider…", [weak, message] { if (auto self = weak.lock()) self->organize(message); }));
    auto local = actions();
    if (text(message, L"folder") != L"drafts" && text(message, L"folder") != L"sent") {
        auto destination = text(message, L"folder") == L"archive" || text(message, L"folder") == L"trash" ? hstring(L"inbox") : hstring(L"archive");
        local.Children().Append(button(destination == L"inbox" ? L"Move to Inbox locally" : L"Archive locally", [weak, message, destination] { if (auto self = weak.lock()) { Json changes; put(changes, L"folder", destination); self->patch(message, changes); } }));
    }
    if (text(message, L"folder") != L"trash") local.Children().Append(button(L"Trash locally", [weak, message] { if (auto self = weak.lock()) { Json changes; put(changes, L"folder", L"trash"); self->patch(message, changes); } }));
    content.Children().Append(local);
    auto assistance = actions();
    for (auto const& option : {std::pair{L"Summarize",L"summary"}, {L"Suggest reply",L"reply"}, {L"Translate",L"translate"}})
        assistance.Children().Append(button(option.first, [weak, message, mode = hstring(option.second)] { if (auto self = weak.lock()) self->messageAI(message, mode); }));
    assistance.Children().Append(button(L"Suggest with History", [weak, message] { if (auto self = weak.lock()) self->messageAI(message, L"reply", true); }));
    content.Children().Append(assistance);
    auto summary = object(message, L"aiSummary");
    if (!text(summary, L"text").empty()) { Expander expanded; expanded.Header(box_value(L"Saved AI summary")); expanded.Content(label(text(summary, L"text"))); content.Children().Append(expanded); }
    appendReader(shared_from_this(), content, message);
    ScrollViewer actionScroll; actionScroll.Content(replies);
    actionScroll.HorizontalScrollBarVisibility(ScrollBarVisibility::Auto);
    actionScroll.VerticalScrollBarVisibility(ScrollBarVisibility::Disabled);
    actionScroll.Margin(ThicknessHelper::FromLengths(12, 8, 12, 8));
    Automation::AutomationProperties::SetName(actionScroll, L"Message actions");
    readerLayout.Children().Append(actionScroll);
    auto body = scroll(content); Grid::SetRow(body, 1); readerLayout.Children().Append(body);
    reader.Content(readerLayout);
}
IAsyncAction Shell::patch(Json message, Json changes) {
    auto lifetime = shared_from_this(); auto version = generation; auto captured = owner; auto sequence = ++selectionGeneration;
    auto account = text(message, L"accountId"); auto id = text(message, L"id");
    if (!connected(account)) co_return;
    try {
        auto result = co_await service->request(L"/messages/" + escaped(id), account, L"PATCH", changes);
        if (!current(version, captured) || sequence != selectionGeneration) co_return;
        auto updated = object(result, L"message");
        if (text(updated, L"accountId") != account || text(updated, L"id") != id) throw hresult_error(E_FAIL, L"The message owner changed. Open it again.");
        if (text(selected, L"accountId") == account && text(selected, L"id") == id) { selected = updated; renderReader(selected); }
        for (auto& cursor : cursors) cursor = L"";
        co_await loadPage();
    } catch (...) { error(errorText()); }
}
void Shell::resizeSidebar(double width, bool save) {
    if (!navigation || !std::isfinite(width)) return;
    auto maximum = root && root.ActualWidth() > 0 ? std::clamp(root.ActualWidth() - 640.0, 180.0, 600.0) : 600.0;
    width = std::clamp(width, 180.0, maximum);
    navigation.OpenPaneLength(width);
    if (sidebarDivider) {
        sidebarDivider.Margin(ThicknessHelper::FromLengths(width - 3, 0, 0, 0));
        sidebarDivider.Visibility(navigation.IsPaneOpen() && navigation.DisplayMode() == NavigationViewDisplayMode::Expanded ? Visibility::Visible : Visibility::Collapsed);
    }
    if (save && service && !closing) try { service->saveClientState(L"morrow.sidebar.width", to_hstring(width)); } catch (...) { error(errorText()); }
}
IAsyncAction Shell::manageFolders(hstring account, hstring initialFolder) {
    auto lifetime = shared_from_this(); auto version = generation; auto captured = owner;
    if (closing || dialogOpen || loading || !service || service->writing() || !connected(account) || !dirty.empty()) co_return;
    try {
        loading = true;
        auto result = co_await service->request(L"/mail/folders/manage", account);
        loading = false;
        if (!current(version, captured) || !connected(account)) co_return;
        if (text(result, L"accountId") != account) throw hresult_error(E_FAIL, L"The folder owner could not be confirmed.");
        if (!flag(result, L"canManage")) throw hresult_error(E_ACCESSDENIED, L"Reconnect in Settings → Mail accounts and approve mail write permission to manage labels/folders.");
        auto provider = text(result, L"provider");
        auto content = stack(12); content.Children().Append(label(account));
        content.Children().Append(label(L"Changes apply to this mailbox on its provider. System folders are protected; review every change before applying."));
        ComboBox operation; operation.Header(box_value(L"Action"));
        for (auto title : {L"Create", L"Rename", L"Move to another parent", L"Delete"}) operation.Items().Append(box_value(title));
        operation.SelectedIndex(initialFolder.empty() ? 0 : 1); content.Children().Append(operation);
        ComboBox source; source.Header(box_value(provider == L"google" ? L"Label" : L"Folder")); source.HorizontalAlignment(HorizontalAlignment::Stretch);
        for (auto const& value : array(result, L"folders")) {
            auto folder = value.GetObject(); if (!flag(folder, L"editable")) continue;
            ComboBoxItem item; item.Content(box_value(text(folder, L"name"))); item.Tag(folder); source.Items().Append(item);
            if (text(folder, L"id") == initialFolder) source.SelectedItem(item);
        }
        content.Children().Append(source);
        auto name = field(L"Name"); name.MaxLength(255); content.Children().Append(name);
        ComboBox parent; parent.Header(box_value(L"Parent")); parent.HorizontalAlignment(HorizontalAlignment::Stretch); content.Children().Append(parent);
        ContentDialog editor; editor.XamlRoot(root.XamlRoot()); editor.Title(box_value(provider == L"google" ? L"Manage Gmail labels" : L"Manage server folders"));
        editor.Content(scroll(content)); editor.PrimaryButtonText(L"Review change"); editor.CloseButtonText(L"Cancel"); editor.DefaultButton(ContentDialogButton::Close);
        auto configure = [operation, source, name, parent, result, provider, editor] {
            auto action = operation.SelectedIndex();
            auto item = source.SelectedItem().try_as<ComboBoxItem>(); auto selected = item ? item.Tag().as<Json>() : Json();
            source.Visibility(action == 0 ? Visibility::Collapsed : Visibility::Visible);
            name.Visibility(action <= 1 ? Visibility::Visible : Visibility::Collapsed);
            name.Text(action == 0 ? L"" : text(selected, L"leafName"));
            parent.Visibility(action == 0 || action == 2 ? Visibility::Visible : Visibility::Collapsed);
            parent.Items().Clear(); ComboBoxItem rootItem; rootItem.Content(box_value(L"Mailbox root")); rootItem.Tag(Json()); parent.Items().Append(rootItem); parent.SelectedIndex(0);
            for (auto const& value : array(result, L"folders")) {
                auto folder = value.GetObject(); auto kind = text(folder, L"kind");
                if (action != 0 && text(folder, L"id") == text(selected, L"id") || flag(folder, L"hidden") || kind == L"spam" || kind == L"trash" || kind == L"virtual" || provider == L"google" && !flag(folder, L"editable")) continue;
                ComboBoxItem parentItem; parentItem.Content(box_value(text(folder, L"name"))); parentItem.Tag(folder); parent.Items().Append(parentItem);
                if (action != 0 && text(folder, L"id") == text(selected, L"parentId")) parent.SelectedItem(parentItem);
            }
            editor.IsPrimaryButtonEnabled(action == 0 ? !name.Text().empty() : source.SelectedIndex() >= 0 && (action != 1 || !name.Text().empty()));
        };
        operation.SelectionChanged([configure](auto const&, auto const&) { configure(); });
        source.SelectionChanged([configure](auto const&, auto const&) { configure(); });
        name.TextChanged([operation, source, name, editor](auto const&, auto const&) { auto action = operation.SelectedIndex(); editor.IsPrimaryButtonEnabled(action == 0 ? !name.Text().empty() : source.SelectedIndex() >= 0 && (action != 1 || !name.Text().empty())); });
        configure();
        dialogOpen = true; ContentDialogResult decision;
        try { decision = co_await editor.ShowAsync(); } catch (...) { dialogOpen = false; throw; }
        dialogOpen = false;
        if (decision != ContentDialogResult::Primary || !current(version, captured) || !connected(account)) co_return;
        wchar_t const* actions[] = {L"create", L"rename", L"move", L"delete"};
        auto action = hstring(actions[std::clamp(operation.SelectedIndex(), 0, 3)]);
        auto item = source.SelectedItem().try_as<ComboBoxItem>(); auto selectedFolder = item ? item.Tag().as<Json>() : Json();
        auto parentFolder = parent.SelectedItem().as<ComboBoxItem>().Tag().as<Json>();
        Json body; put(body, L"operation", action); put(body, L"id", text(selectedFolder, L"id")); put(body, L"name", name.Text()); put(body, L"parentId", text(parentFolder, L"id"));
        loading = true; auto preview = co_await service->request(L"/mail/folders/preview", account, L"POST", body); loading = false;
        if (!current(version, captured)) co_return;
        if (text(preview, L"accountId") != account || text(preview, L"previewId").empty()) throw hresult_error(E_FAIL, L"The folder review could not be confirmed.");
        auto plan = object(preview, L"plan");
        auto detail = account + L"\n" + text(plan, L"sourceName") + L" → " + text(plan, L"name") + L"\nAffected labels/folders: " + to_hstring(plan.GetNamedNumber(L"affectedCount", 1)) + L"\n" + text(plan, L"impact");
        if (plan.HasKey(L"messageCount") && plan.GetNamedValue(L"messageCount").ValueType() == JsonValueType::Number) detail += L"\nMessages in selected folder: " + to_hstring(plan.GetNamedNumber(L"messageCount"));
        if (!(co_await confirm(L"Apply this provider change?", detail, action == L"delete" ? L"Delete on provider" : L"Apply change")) || !current(version, captured)) co_return;
        Json apply; put(apply, L"previewId", text(preview, L"previewId")); apply.Insert(L"confirmed", Value::CreateBooleanValue(true));
        loading = true; auto changed = co_await service->request(L"/mail/folders/apply", account, L"POST", apply); loading = false;
        if (text(changed, L"accountId") != account) throw hresult_error(E_FAIL, L"The changed folder owner could not be confirmed. Refresh before another review.");
        JsonArray folders;
        for (auto const& value : array(changed, L"folders")) { auto folder = value.GetObject(); if (!flag(folder, L"hidden") && (!folder.HasKey(L"selectable") || flag(folder, L"selectable"))) folders.Append(value); }
        changed.Insert(L"folders", folders); serverFolders.Insert(account, changed);
        if (!current(version, captured)) co_return;
        if (owner == account) for (auto const& value : array(changed, L"changes")) { auto change=value.GetObject(); if (folder == L"provider:" + text(change,L"oldId")) { folder = text(change,L"newId").empty() ? L"inbox" : L"provider:" + text(change,L"newId"); break; } }
        rebuildNavigation(); for (auto& cursor : cursors) cursor = L"";
        if (section == L"mail") co_await loadPage();
        error(L"Provider label/folder change confirmed.");
    } catch (...) { loading = false; error(errorText()); }
}
IAsyncAction Shell::organize(Json message, hstring preferredKind, hstring preferredDestination) {
    if (preferredKind == L"trash") { co_await trash(message); co_return; }
    auto lifetime = shared_from_this(); auto version = generation; auto captured = owner;
    auto sequence = selectionGeneration; auto account = text(message, L"accountId");
    if (dialogOpen || loading || !connected(account) || !dirty.empty() || flag(message, L"providerFolderMissing")) co_return;
    try {
        loading = true;
        auto result = co_await service->request(L"/mail/folders", account);
        loading = false;
        if (!current(version, captured) || sequence != selectionGeneration || dialogOpen) co_return;
        auto content = stack(12); content.Children().Append(label(account + L"\n" + text(message, L"subject")));
        ComboBox mode; mode.Header(box_value(L"Action"));
        mode.Items().Append(box_value(L"Move"));
        if (text(result, L"provider") == L"google") { mode.Items().Append(box_value(L"Add label")); mode.Items().Append(box_value(L"Remove label")); }
        mode.SelectedIndex(0); if (preferredKind != L"trash") content.Children().Append(mode);
        ComboBox destination; destination.Header(box_value(L"Folder / label")); destination.HorizontalAlignment(HorizontalAlignment::Stretch);
        auto populate = [destination, mode, result, preferredKind, preferredDestination] {
            destination.Items().Clear();
            int32_t preferred = -1;
            for (auto const& value : array(result, L"folders")) {
                auto folder = value.GetObject();
                if (mode.SelectedIndex() != 0 && text(folder, L"kind") != L"label") continue;
                if (text(folder,L"id") == preferredDestination || mode.SelectedIndex() == 0 && text(folder, L"kind") == preferredKind) preferred = static_cast<int32_t>(destination.Items().Size());
                ComboBoxItem item; item.Content(box_value(text(folder, L"name"))); item.Tag(folder); destination.Items().Append(item);
            }
            destination.SelectedIndex(preferred);
        };
        populate(); mode.SelectionChanged([populate](auto const&, auto const&) { populate(); });
        if (preferredKind == L"trash" && destination.SelectedIndex() < 0) throw hresult_error(E_FAIL, L"This mailbox did not expose a provider Trash folder. Check its permissions or use your provider.");
        if (preferredKind == L"trash") content.Children().Append(label(L"Destination: " + text(destination.SelectedItem().as<ComboBoxItem>().Tag().as<Json>(), L"name")));
        else content.Children().Append(destination);
        content.Children().Append(label(preferredKind == L"trash" ? L"This moves the message to Trash on the account shown above. It does not permanently delete the message." : L"Provider changes affect this mailbox on the remote server. Gmail Move removes Inbox while retaining other labels. Spam / Junk is a provider move. Phishing reports and sender blocking remain provider-site actions."));
        auto provider = text(result, L"provider");
        if (preferredKind != L"trash" && (provider == L"google" || provider == L"microsoft")) content.Children().Append(button(L"Open provider for reporting / blocking", [provider] { Windows::System::Launcher::LaunchUriAsync(Uri(provider == L"google" ? L"https://mail.google.com/" : L"https://outlook.live.com/mail/")); }));
        ContentDialog dialog; dialog.XamlRoot(root.XamlRoot()); dialog.Title(box_value(preferredKind == L"trash" ? L"Move to provider Trash" : L"Organize on provider")); dialog.Content(scroll(content));
        dialog.PrimaryButtonText(preferredKind == L"trash" ? L"Review Trash Move" : L"Review change"); dialog.CloseButtonText(L"Cancel"); dialog.IsPrimaryButtonEnabled(destination.SelectedIndex() >= 0);
        destination.SelectionChanged([dialog, destination](auto const&, auto const&) { dialog.IsPrimaryButtonEnabled(destination.SelectedIndex() >= 0); });
        dialogOpen = true;
        ContentDialogResult decision;
        try { decision = co_await dialog.ShowAsync(); } catch (...) { dialogOpen = false; throw; }
        dialogOpen = false;
        if (decision != ContentDialogResult::Primary || !current(version, captured) || sequence != selectionGeneration || destination.SelectedIndex() < 0) co_return;
        auto target = destination.SelectedItem().as<ComboBoxItem>().Tag().as<Json>();
        wchar_t const* modes[] = {L"move", L"addLabel", L"removeLabel"};
        auto action = hstring(modes[std::clamp(mode.SelectedIndex(), 0, 2)]);
        if (!(co_await confirm(preferredKind == L"trash" ? L"Move to provider Trash?" : L"Apply this provider change?", account + L"\n" + text(message, L"subject") + L"\n" + action + L" → " + text(target, L"name"), preferredKind == L"trash" ? L"Move to Trash" : L"Apply provider change")) || !current(version, captured) || sequence != selectionGeneration) co_return;
        Json body; put(body, L"destinationId", text(target, L"id")); put(body, L"mode", action); body.Insert(L"confirmed", Value::CreateBooleanValue(true));
        auto updated = co_await service->request(L"/messages/" + escaped(text(message, L"id")) + L"/organize", account, L"POST", body);
        if (!current(version, captured) || sequence != selectionGeneration) co_return;
        auto moved = object(updated, L"message");
        if (text(moved, L"accountId") != account || text(moved, L"id") != text(message, L"id")) throw hresult_error(E_FAIL, L"The message owner changed. Refresh your mailbox.");
        if (text(selected, L"accountId") == account && text(selected, L"id") == text(message, L"id")) { selected = moved; renderReader(selected); }
        for (auto& cursor : cursors) cursor = L"";
        co_await loadPage();
    } catch (...) { loading = false; error(errorText()); }
}
void Shell::updateTrashUndo() {
    std::erase_if(trashUndos, [](auto const& entry) { return entry.expires <= GetTickCount64(); });
    trashUndoButton.Visibility(trashUndos.empty() ? Visibility::Collapsed : Visibility::Visible);
    trashUndoButton.IsEnabled(!loading && !dialogOpen && dirty.empty() && !closing && service && !service->writing());
}
IAsyncAction Shell::trash(Json message) {
    auto lifetime = shared_from_this(); auto version = generation; auto captured = owner;
    auto account = text(message, L"accountId");
    if (dialogOpen || loading || closing || !connected(account) || !dirty.empty() || service->writing() || text(message, L"folder") == L"trash") co_return;
    loading = true;
    try {
        auto result = co_await service->request(L"/messages/" + escaped(text(message, L"id")) + L"/trash", account, L"POST", Json());
        auto moved = object(result, L"message");
        if (text(moved, L"accountId") != account || text(moved, L"id") != text(message, L"id") || text(result, L"undoToken").empty()) throw hresult_error(E_FAIL, L"The Trash move could not be verified. Refresh your mailbox.");
        trashUndos.push_back({message, text(result, L"undoToken"), GetTickCount64() + 60000});
        loading = false; updateTrashUndo();
        if (!current(version, captured)) co_return;
        if (text(selected, L"accountId") == account && text(selected, L"id") == text(message, L"id")) { selected = Json(); renderReader(selected); }
        cursors = {L""}; co_await loadPage();
        status.Text(L"Moved to provider Trash. Undo is available for one minute.");
    } catch (...) { loading = false; error(errorText()); }
}
IAsyncAction Shell::undoTrash() {
    auto lifetime = shared_from_this();
    if (dialogOpen || loading || closing || !dirty.empty() || service->writing()) co_return;
    updateTrashUndo(); if (trashUndos.empty()) co_return;
    auto entry = trashUndos.back(); trashUndos.pop_back(); loading = true; updateTrashUndo();
    auto version = generation; auto captured = owner;
    try {
        Json body; put(body, L"undoToken", entry.token);
        co_await service->request(L"/messages/" + escaped(text(entry.message, L"id")) + L"/undo-trash", text(entry.message, L"accountId"), L"POST", body);
        loading = false; updateTrashUndo();
        if (!current(version, captured)) co_return;
        if (section == L"mail") { cursors = {L""}; co_await loadPage(); }
        status.Text(L"Trash move undone. The message was restored.");
    } catch (...) { loading = false; updateTrashUndo(); error(errorText()); }
}
IAsyncAction Shell::prepare(Json message, hstring mode, hstring body) {
    auto lifetime = shared_from_this(); auto version = generation; auto captured = owner; auto sequence = selectionGeneration;
    auto account = text(message, L"accountId");
    if (!connected(account) || !dirty.empty()) co_return;
    try {
        Json input; put(input, L"mode", mode); put(input, L"messageId", text(message, L"id"));
        if (!body.empty()) put(input, L"body", body);
        auto result = co_await service->request(L"/drafts/prepare", account, L"POST", input);
        if (!current(version, captured) || sequence != selectionGeneration || !dirty.empty()) co_return;
        auto draft = object(result, L"draft");
        if (text(draft, L"accountId") != account) throw hresult_error(E_FAIL, L"The prepared draft owner changed.");
        co_await compose(lifetime, draft);
    } catch (...) { error(errorText()); }
}
IAsyncAction Shell::messageAI(Json message, hstring action, bool history) {
    auto lifetime = shared_from_this(); auto version = generation; auto captured = owner; auto sequence = selectionGeneration;
    if (dialogOpen || !connected(text(message, L"accountId"))) co_return;
    auto model = object(object(state, L"settings"), L"ai");
    if (!co_await confirm(history ? L"Suggest with History" : L"Run email AI?",
        text(model, L"model") + L" · " + text(model, L"baseUrl") + L"\n\n" +
        (history ? L"Uses this message and permitted downloaded correspondence from the same sender, within your saved limits. " : L"Uses permitted content from this message. ") +
        L"Your configured model provider may charge. Nothing is sent or saved automatically.", L"Generate")) co_return;
    if (!current(version, captured) || sequence != selectionGeneration) co_return;
    ContentDialog dialog; dialog.XamlRoot(root.XamlRoot()); dialog.Title(box_value(history ? L"Suggest with History" : action));
    auto content = stack(); auto progress = label(L"Waiting for the configured model…"); content.Children().Append(progress);
    dialog.Content(scroll(content)); dialog.CloseButtonText(L"Close");
    std::function<void()> release;
    IAsyncOperation<ContentDialogResult> display{nullptr};
    try { display = showReaderPopup(lifetime, dialog, release); }
    catch (...) { error(errorText()); co_return; }
    Json result; bool failed = false;
    try {
        Json input; put(input, L"action", action); put(input, L"messageId", text(message, L"id")); input.Insert(L"includeHistory", Value::CreateBooleanValue(history));
        result = co_await service->request(L"/ai", text(message, L"accountId"), L"POST", input);
        if (current(version, captured) && sequence == selectionGeneration && display.Status() == AsyncStatus::Started) {
            progress.Text(text(result, L"text"));
            if (action == L"reply") dialog.PrimaryButtonText(L"Use in draft");
        }
    } catch (...) {
        failed = true;
        if (display.Status() == AsyncStatus::Started) progress.Text(errorText());
    }
    ContentDialogResult choice = ContentDialogResult::None;
    try { choice = co_await display; } catch (...) {}
    release(); // Closed may already have released this popup; never clear a newer dialog's guard.
    if (!failed && !dialogOpen && choice == ContentDialogResult::Primary && current(version, captured) && sequence == selectionGeneration)
        co_await prepare(message, L"reply", text(result, L"text"));
}
IAsyncAction Shell::sync() {
    auto lifetime = shared_from_this(); auto version = generation; auto captured = owner;
    if ((!connected(captured) && captured != L"all") || service->writing()) co_return;
    error(L"Fetching mail… See Activity for progress.");
    try {
        co_await service->request(L"/sync", captured, L"POST");
        if (!current(version, captured)) co_return;
        co_await refresh(true); if (section == L"mail") co_await loadPage();
    } catch (...) { error(errorText()); }
}
void Shell::updateBadge() {
    auto item = navigation.SettingsItem().try_as<NavigationViewItem>();
    if (!item) return;
    if (flag(updateResult, L"updateAvailable")) {
        InfoBadge badge; badge.Value(-1);
        badge.IconSource(FontIconSource());
        auto source = badge.IconSource().as<FontIconSource>(); source.Glyph(L"!");
        badge.Background(Media::SolidColorBrush(Windows::UI::Color{255, 180, 25, 30}));
        Automation::AutomationProperties::SetName(badge, L"Update available"); item.InfoBadge(badge);
    } else item.InfoBadge(nullptr);
}
IAsyncAction Shell::checkUpdates(bool force) {
    auto lifetime = shared_from_this();
    if (closing || checkingUpdates || !service || !service->alive()) co_return;
    auto now = GetTickCount64();
    if (!force && lastUpdateCheck && now - lastUpdateCheck < 3600000) co_return;
    checkingUpdates = true; lastUpdateCheck = now;
    auto channel = includePrereleases;
    try {
        auto result = co_await service->request(channel ? L"/updates?includePrereleases=true" : L"/updates?includePrereleases=false");
        if (!closing && channel == includePrereleases) { updateResult = result; updateBadge(); }
    } catch (...) { if (force && !closing && channel == includePrereleases) error(errorText()); }
    checkingUpdates = false;
}
IAsyncAction Shell::shutdown() {
    auto lifetime = shared_from_this();
    if (closing || dialogOpen) co_return;
    if (service && service->writing()) { error(L"Wait for the current save or provider operation before closing."); co_return; }
    if (!dirty.empty() && !co_await confirm(L"Discard unsaved changes and close?", L"Saved drafts and account data will stay on this device.", L"Discard and close")) co_return;
    try {
        auto presenter = window.AppWindow().Presenter().try_as<Microsoft::UI::Windowing::OverlappedPresenter>();
        if (service && presenter && presenter.State() == Microsoft::UI::Windowing::OverlappedPresenterState::Restored) {
            auto size = window.AppWindow().Size(); auto scale = windowScale(window);
            auto saved = service->windowState();
            auto fitted = mailWindowBounds(window, saved.GetNamedNumber(L"width", 1220), saved.GetNamedNumber(L"height", 800));
            if (size.Width != fitted.Width || size.Height != fitted.Height)
                service->saveWindowSize(std::clamp(static_cast<int>(std::lround(size.Width / scale)), 1040, 2400), std::clamp(static_cast<int>(std::lround(size.Height / scale)), 700, 1600));
        }
    } catch (...) { error(L"The window size could not be saved. Mail and settings are retained."); }
    closing = true; ++generation; if (timer) timer.Stop(); navigation.IsEnabled(false); error(L"Closing the private service…");
    try { if (service) co_await service->stop(); } catch (...) {}
    closeReady = true;
    window.Close(); Application::Current().Exit();
}
IAsyncAction composerWriteGuardChecks(std::shared_ptr<Shell> shell);

// Called by native smoke after its disposable-workspace check, before page walkthroughs.
// Real dialogs and foreground guards only: no model/provider/service requests.
IAsyncAction nativeInteractionChecks(std::shared_ptr<Shell> shell) {
    auto check = [](bool value, wchar_t const* message) { if (!value) throw hresult_error(E_FAIL, message); };
    check(std::wstring_view(GetCommandLineW()).find(L"--native-smoke") != std::wstring_view::npos
        && !shell->closing && !shell->dialogOpen && shell->dirty.empty(), L"Interaction checks require an idle native fixture.");
    apartment_context ui;
    std::function<void()> lateRelease;
    for (int i = 0; i < 2; ++i) {
        ContentDialog dialog; dialog.XamlRoot(shell->root.XamlRoot());
        dialog.Title(box_value(L"Fictional reader popup")); dialog.CloseButtonText(L"Close");
        auto opened = std::make_shared<bool>(false);
        dialog.Opened([opened](auto const&, auto const&) { *opened = true; });
        std::function<void()> release;
        auto display = showReaderPopup(shell, dialog, release);
        struct Cleanup {
            ContentDialog dialog; std::function<void()> release;
            ~Cleanup() { try { dialog.Hide(); } catch (...) {} release(); }
        } cleanup{dialog, release};
        auto deadline = GetTickCount64() + 5000;
        while (!*opened && display.Status() == AsyncStatus::Started && GetTickCount64() < deadline) {
            co_await resume_after(std::chrono::milliseconds(20)); co_await ui;
        }
        check(*opened && shell->dialogOpen, L"Reader popup did not acquire its visible-dialog guard.");
        if (lateRelease) {
            lateRelease(); // An older model completion arrives while the next popup is visible.
            check(shell->dialogOpen, L"An older reader popup cleared the new dialog guard.");
        }
        dialog.Hide();
        while (display.Status() == AsyncStatus::Started && GetTickCount64() < deadline) {
            co_await resume_after(std::chrono::milliseconds(20)); co_await ui;
        }
        check(display.Status() == AsyncStatus::Completed && !shell->dialogOpen,
            L"Closing a reader popup retained its dialog guard.");
        display.GetResults();
        lateRelease = release;
    }
    bool rejected = false;
    std::function<void()> release;
    try {
        ContentDialog unrooted; unrooted.CloseButtonText(L"Close");
        (void)showReaderPopup(shell, unrooted, release);
        unrooted.Hide();
    } catch (hresult_error const&) { rejected = true; }
    auto guardAfterFailure = shell->dialogOpen;
    if (release) release();
    check(rejected && !guardAfterFailure, L"A synchronous popup failure retained its dialog guard.");
    co_await composerWriteGuardChecks(shell);
}
IAsyncAction openTodayMailbox(std::shared_ptr<Shell> self, hstring folder, bool unreadOnly) {
    if (self->loading || self->dialogOpen || self->closing || !self->dirty.empty()) co_return;
    co_await self->navigate(L"mail", L"all", folder);
    if (unreadOnly && self->section == L"mail" && self->owner == L"all" && self->folder == folder && self->unreadFilter) {
        self->unreadFilter.IsChecked(true); co_await self->loadPage();
    }
}
IAsyncAction summarizeNow(std::shared_ptr<Shell> self, hstring mailbox) {
    if (self->loading || self->dialogOpen || self->closing || !self->dirty.empty() || !self->connected(mailbox)) co_return;
    auto version = self->generation; auto viewOwner = self->owner;
    self->loading = true;
    struct Done { std::shared_ptr<Shell> shell; ~Done() { shell->loading = false; } } done{self};
    try {
        self->error(L"Reviewing downloaded mail…");
        auto preview = co_await self->service->request(L"/summaries/preview", mailbox, L"POST", Json());
        if (!self->current(version, viewOwner)) co_return;
        if (text(preview, L"accountId") != mailbox) throw hresult_error(E_FAIL, L"The preview belongs to a different mailbox.");
        auto model = object(preview, L"model");
        auto detail = mailbox + L"\n" + text(model, L"model") + L" · " + text(model, L"baseUrl") + L"\n\n";
        for (auto const& value : array(preview, L"messages")) {
            auto message = value.GetObject();
            auto subject = text(message, L"subject");
            detail = detail + (subject.empty() ? L"(Subject withheld)" : subject) + L"\n" + text(message, L"fromEmail") + L" · " + text(message, L"folder") + L" · " + mailDateLabel(text(message, L"date")) + L"\n\n";
        }
        detail = detail + to_hstring(array(preview, L"messages").Size()) + L" downloaded messages. Uses saved folder, Inbox-only and starred-only filters across all dates, up to your context limit. Only permitted fields reach the model. Provider charges may apply.";
        self->error(L"");
        if (!co_await self->confirm(L"Generate a saved P0–P4 summary?", detail, L"Generate summary") || !self->current(version, viewOwner)) co_return;
        Json body; put(body, L"previewId", text(preview, L"previewId"));
        self->error(L"Generating summary…");
        auto result = co_await self->service->request(L"/summaries/generate", mailbox, L"POST", body);
        if (self->current(version, viewOwner)) {
            co_await self->refresh();
            if (text(result, L"status") != L"completed") self->error(text(result, L"error", L"Summary was interrupted. Review before generating again."));
        }
    } catch (...) { self->error(errorText()); }
}
IAsyncAction workspacePage(std::shared_ptr<Shell> self, hstring kind) {
    if (kind == L"studio" || kind == L"learning" || kind == L"brain" || kind == L"reply-suggestions" || kind == L"skills" || kind == L"summaries" || kind == L"records") {
        co_await intelligencePage(self, kind); co_return;
    }
    auto version = self->generation; auto account = self->owner;
    auto content = stack(16); content.Padding(ThicknessHelper::FromUniformLength(24));
    content.Children().Append(label(kind == L"activity" ? L"Activity" : L"Today", 28));
    content.Children().Append(label(kind == L"today" ? L"All connected accounts" : account.empty() ? L"Your workspace" : account));
    try {
        if (kind == L"activity") {
            auto result = co_await self->service->request(L"/activity", account);
            if (!self->current(version, account)) co_return;
            content.Children().Append(label(L"Observational progress only. Opening this page does not start provider or AI work."));
            for (auto const& value : array(result, L"tasks")) {
                auto task = value.GetObject(); auto item = stack(4);
                item.Children().Append(label(text(task, L"label") + L" · " + text(task, L"status"), 18));
                item.Children().Append(label(text(task, L"accountId") + L"\n" + text(task, L"detail")));
                if (!text(task, L"error").empty()) item.Children().Append(label(text(task, L"error")));
                content.Children().Append(item);
            }
            if (!array(result, L"tasks").Size()) content.Children().Append(label(L"No recent activity."));
        } else {
            auto totals = Grid();
            uint64_t unread = 0, inbox = 0, drafts = 0;
            for (auto const& value : array(self->state, L"accounts")) {
                auto mailbox = value.GetObject();
                auto counts = object(mailbox, L"counts");
                unread += static_cast<uint64_t>(mailbox.GetNamedNumber(L"unread", 0));
                inbox += static_cast<uint64_t>(counts.GetNamedNumber(L"inbox", 0));
                drafts += static_cast<uint64_t>(counts.GetNamedNumber(L"drafts", 0));
            }
            auto overview = [&](hstring title, uint64_t count, hstring folder, bool unreadOnly) {
                auto column = static_cast<int>(totals.ColumnDefinitions().Size());
                ColumnDefinition definition; definition.Width(GridLengthHelper::FromValueAndType(1, GridUnitType::Star)); totals.ColumnDefinitions().Append(definition);
                auto card = button(title, [weak = self->weak_from_this(), folder, unreadOnly] { if (auto shell = weak.lock()) openTodayMailbox(shell, folder, unreadOnly); });
                auto body = stack(10); auto caption = label(title); caption.Opacity(0.7); body.Children().Append(caption); body.Children().Append(label(to_hstring(count), 28));
                card.Content(body); card.HorizontalAlignment(HorizontalAlignment::Stretch); card.HorizontalContentAlignment(HorizontalAlignment::Stretch);
                card.Padding(ThicknessHelper::FromUniformLength(18)); card.Margin({0, 0, column < 2 ? 14.0 : 0.0, 0});
                Automation::AutomationProperties::SetName(card, title + L", " + to_hstring(count) + L" downloaded messages");
                Grid::SetColumn(card, column); totals.Children().Append(card);
            };
            overview(L"Unread Inbox", unread, L"inbox", true); overview(L"Inbox", inbox, L"inbox", false); overview(L"Drafts", drafts, L"drafts", false);
            content.Children().Append(totals);
            auto scope = label(L"Downloaded mail, across all dates. Sync and AI progress appear in Activity.", 12); scope.Opacity(0.7); content.Children().Append(scope);
            content.Children().Append(label(L"Today's summaries", 22));
            auto subtitle = label(L"A clearer view of what needs your attention."); subtitle.Opacity(0.7); content.Children().Append(subtitle);
            auto summaryActions = actions();
            ComboBox mailboxPicker; mailboxPicker.PlaceholderText(L"Summary mailbox"); mailboxPicker.MinWidth(220);
            Automation::AutomationProperties::SetName(mailboxPicker, L"Summary mailbox");
            for (auto const& value : array(self->state, L"accounts")) {
                auto mailbox = value.GetObject(); ComboBoxItem item; item.Content(box_value(text(mailbox, L"email"))); item.Tag(box_value(text(mailbox, L"id"))); mailboxPicker.Items().Append(item);
                if (text(mailbox, L"id") == (self->todaySummaryOwner.empty() ? self->owner : self->todaySummaryOwner)) mailboxPicker.SelectedItem(item);
            }
            if (!mailboxPicker.SelectedItem() && mailboxPicker.Items().Size()) mailboxPicker.SelectedIndex(0);
            if (auto selected = mailboxPicker.SelectedItem()) self->todaySummaryOwner = unbox_value<hstring>(selected.as<ComboBoxItem>().Tag());
            mailboxPicker.SelectionChanged([weak = self->weak_from_this()](auto const& sender, auto const&) { auto picker = sender.template as<ComboBox>(); if (auto shell = weak.lock(); shell && picker.SelectedItem()) shell->todaySummaryOwner = unbox_value<hstring>(picker.SelectedItem().as<ComboBoxItem>().Tag()); });
            summaryActions.Children().Append(mailboxPicker);
            auto generate = button(L"Summarize now", [weak = self->weak_from_this()] { if (auto shell = weak.lock()) summarizeNow(shell, shell->todaySummaryOwner); });
            generate.Style(Application::Current().Resources().Lookup(box_value(L"AccentButtonStyle")).as<Style>());
            generate.IsEnabled(mailboxPicker.Items().Size() > 0); summaryActions.Children().Append(generate);
            summaryActions.Children().Append(button(L"Summary History", [weak = self->weak_from_this()] { if (auto shell = weak.lock()) shell->navigate(L"summaries", L"all"); }));
            content.Children().Append(summaryActions);
            auto policy = object(object(self->state,L"settings"),L"policy"), triggers = object(policy,L"triggers"), schedule = object(policy,L"summarySchedule");
            if (flag(triggers,L"scheduledSummary")) content.Children().Append(label(text(schedule,L"cadence") == L"daily" ? L"Scheduled daily at " + text(schedule,L"time") + L" (" + text(schedule,L"timeZone") + L"), while Morrow is open." : L"Scheduled every " + to_hstring(static_cast<unsigned>(schedule.GetNamedNumber(L"everyHours",4))) + L" hours, while Morrow is open."));
            if (flag(triggers,L"onArrival")) content.Children().Append(label(L"New-mail summaries appear after newly synced mail is analyzed. Historical imports do not trigger them."));
            bool found = false;
            for (auto const& value : array(object(self->state, L"today"), L"summaries")) {
                auto report = value.GetObject();
                auto date = text(report, L"status") == L"completed" ? text(report, L"completedAt", text(report, L"createdAt")) : text(report, L"createdAt");
                if (!sameDay(date)) continue;
                found = true;
                auto item = stack(10); item.Padding(ThicknessHelper::FromUniformLength(18));
                auto title = text(report, L"kind") == L"arrival" ? L"New mail" : text(report, L"kind") == L"manual" ? L"On-demand summary" : L"Scheduled summary";
                item.Children().Append(label(text(report, L"accountId"), 12)); item.Children().Append(label(title, 20));
                item.Children().Append(label(text(report, L"status") + L" · " + mailDateLabel(date) + L" · " + to_hstring(array(report, L"messageIds").Size()) + L" messages", 12));
                if (!text(report, L"text").empty()) item.Children().Append(label(text(report, L"text")));
                if (!text(report, L"error").empty()) item.Children().Append(label(text(report, L"error")));
                auto card = Markup::XamlReader::Load(L"<Border xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' Background='{ThemeResource CardBackgroundFillColorDefaultBrush}' BorderBrush='{ThemeResource CardStrokeColorDefaultBrush}' BorderThickness='1' CornerRadius='12'/>").as<Border>();
                card.Child(item); content.Children().Append(card);
            }
            if (!found) {
                content.Children().Append(label(L"A fresh start for today", 20));
                content.Children().Append(label(mailboxPicker.Items().Size() ? L"Choose Summarize now to review downloaded mail from one mailbox. You can also enable scheduled or new-mail summaries in AI & privacy." : L"Connect a mailbox to see your mail and summaries here."));
            }
            if (!flag(policy, L"enabled")) content.Children().Append(label(L"AI is paused in your saved permissions."));
            content.Children().Append(button(mailboxPicker.Items().Size() ? L"AI & Privacy" : L"Add account", [weak = self->weak_from_this(), hasAccounts = mailboxPicker.Items().Size() > 0] { if (auto shell = weak.lock()) shell->navigate(hasAccounts ? L"policy" : L"settings"); }));
            content.Children().Append(label(L"Latest 20 jobs per mailbox, dated in your local time. Each summary uses only its own mailbox.", 12));
        }
        if (self->current(version, account)) self->show(scroll(content));
    } catch (...) { self->error(errorText()); }
}
}

struct MorrowApplication : winrt::Microsoft::UI::Xaml::ApplicationT<MorrowApplication, winrt::Microsoft::UI::Xaml::Markup::IXamlMetadataProvider> {
    std::shared_ptr<morrow::Shell> shell;
    winrt::Microsoft::UI::Xaml::XamlTypeInfo::XamlControlsXamlMetaDataProvider metadata;
    // A programmatic Application has no generated App.xaml metadata provider.
    winrt::Microsoft::UI::Xaml::Markup::IXamlType GetXamlType(winrt::hstring const& name) { return metadata.GetXamlType(name); }
    winrt::Microsoft::UI::Xaml::Markup::IXamlType GetXamlType(winrt::Windows::UI::Xaml::Interop::TypeName const& type) { return metadata.GetXamlType(type); }
    winrt::com_array<winrt::Microsoft::UI::Xaml::Markup::XmlnsDefinition> GetXmlnsDefinitions() { return metadata.GetXmlnsDefinitions(); }
    MorrowApplication() {
        startupTrace("application constructed");
        char const* phase = "installing unhandled exception handler";
        try {
            startupTrace(phase);
            UnhandledException([](auto const&, auto const& event) {
                if (std::wstring_view(GetCommandLineW()).find(L"--native-smoke") != std::wstring_view::npos) {
                    std::fprintf(stderr, "Native XAML HRESULT: 0x%08X\n", static_cast<unsigned>(event.Exception())); std::fflush(stderr);
                }
                // Do not mark handled: a failed XAML initialization must still fail acceptance.
            });
            startupTrace("event installed");
        } catch (...) {
            if (std::wstring_view(GetCommandLineW()).find(L"--native-smoke") != std::wstring_view::npos) {
                std::fprintf(stderr, "Native startup constructor (%s) HRESULT: 0x%08X\n", phase, static_cast<unsigned>(winrt::to_hresult())); std::fflush(stderr);
            }
            throw;
        }
    }
    void OnLaunched(winrt::Microsoft::UI::Xaml::LaunchActivatedEventArgs const&) {
        startupTrace("OnLaunched entered");
        // Application::Start initializes the core Application after the constructor, before OnLaunched.
        char const* phase = "reading application resources";
        try {
            startupTrace(phase);
            auto resources = Resources(); startupTrace("resources read");
            phase = "reading merged dictionaries"; startupTrace(phase);
            auto dictionaries = resources.MergedDictionaries(); startupTrace("merged dictionaries read");
            phase = "constructing control resources"; startupTrace(phase);
            auto controls = winrt::Microsoft::UI::Xaml::Controls::XamlControlsResources(); startupTrace("controls constructed");
            phase = "appending control resources"; startupTrace(phase);
            dictionaries.Append(controls); startupTrace("control resources loaded");
            morrow::applyBrandResources(resources);
        } catch (...) {
            if (std::wstring_view(GetCommandLineW()).find(L"--native-smoke") != std::wstring_view::npos) {
                std::fprintf(stderr, "Native startup OnLaunched (%s) HRESULT: 0x%08X\n", phase, static_cast<unsigned>(winrt::to_hresult())); std::fflush(stderr);
            }
            throw;
        }
        shell = std::make_shared<morrow::Shell>(); shell->start();
    }
};
int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    HANDLE instance = CreateMutexW(nullptr, FALSE, L"Local\\org.morrowmail.desktop.WinUI");
    if (!instance) return 1;
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        if (auto existing = FindWindowW(nullptr, L"Morrow Mail")) { ShowWindow(existing, SW_RESTORE); SetForegroundWindow(existing); }
        CloseHandle(instance); return 0;
    }
    int result = 0;
    try {
        startupTrace("initializing apartment");
        winrt::init_apartment(winrt::apartment_type::single_threaded);
        SetCurrentProcessExplicitAppUserModelID(L"org.morrowmail.desktop");
        startupTrace("starting XAML application");
        winrt::Microsoft::UI::Xaml::Application::Start([](auto const&) { winrt::make<MorrowApplication>(); });
    } catch (...) {
        if (std::wstring_view(GetCommandLineW()).find(L"--native-smoke") != std::wstring_view::npos) {
            std::fprintf(stderr, "Native startup HRESULT: 0x%08X\n", static_cast<unsigned>(winrt::to_hresult())); std::fflush(stderr);
        } else MessageBoxW(nullptr, L"Morrow Mail could not initialize. Your saved workspace is retained.", L"Morrow Mail", MB_OK | MB_ICONERROR);
        result = 1;
    }
    CloseHandle(instance); return result;
}
