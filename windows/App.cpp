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
#include <fstream>
#include <cmath>

#pragma comment(lib, "user32.lib")

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
using namespace controls;
using namespace xaml;
using namespace Windows::Data::Json;
TextBlock label(hstring const& value, double size) {
    TextBlock result; result.Text(value); result.FontSize(size);
    result.TextWrapping(TextWrapping::Wrap); result.IsTextSelectionEnabled(true);
    return result;
}
Button button(hstring const& value, std::function<void()> action) {
    Button result; result.Content(box_value(value));
    Automation::AutomationProperties::SetName(result, value);
    result.Click([action = std::move(action)](auto const&, auto const&) { action(); });
    return result;
}
StackPanel stack(double gap) { StackPanel result; result.Spacing(gap); return result; }
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
void bold(TextBlock const& text, bool active) {
    Windows::UI::Text::FontWeight weight{}; weight.Weight = active ? 600 : 400; text.FontWeight(weight);
}
NavigationViewItem navItem(hstring const& title, hstring const& section, hstring const& owner = {}, hstring const& folder = L"inbox") {
    NavigationViewItem item; item.Content(box_value(title));
    Json tag; put(tag, L"section", section); put(tag, L"owner", owner); put(tag, L"folder", folder);
    item.Tag(tag); return item;
}
hstring errorText() {
    try { throw; } catch (hresult_error const& error) { return error.message(); }
    catch (...) { return L"The operation could not be completed. Your saved workspace has been retained."; }
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
    window = Window(); window.Title(L"Morrow Mail");
    root = Grid(); root.RowDefinitions().Append(RowDefinition());
    RowDefinition statusRow; statusRow.Height(GridLengthHelper::Auto()); root.RowDefinitions().Append(statusRow);
    navigation = NavigationView(); navigation.PaneTitle(L"Morrow"); navigation.IsSettingsVisible(true);
    navigation.IsBackButtonVisible(NavigationViewBackButtonVisible::Collapsed);
    navigation.OpenPaneLength(280); navigation.PaneDisplayMode(NavigationViewPaneDisplayMode::Left);
    page = ContentControl(); page.HorizontalContentAlignment(HorizontalAlignment::Stretch); page.VerticalContentAlignment(VerticalAlignment::Stretch);
    navigation.Content(page); root.Children().Append(navigation);
    status = label(L"Opening your private workspace…"); status.Margin(ThicknessHelper::FromLengths(16, 6, 16, 8));
    Automation::AutomationProperties::SetLiveSetting(status, Automation::Peers::AutomationLiveSetting::Polite);
    Grid::SetRow(status, 1); root.Children().Append(status);
    window.Content(root);
    window.AppWindow().Resize({1280, 840});
    auto weak = weak_from_this();
    window.AppWindow().Closing([weak](auto const&, Microsoft::UI::Windowing::AppWindowClosingEventArgs const& event) {
        if (auto self = weak.lock(); self && !self->closeReady) { event.Cancel(true); if (!self->closing) self->shutdown(); }
    });
    navigation.ItemInvoked([weak](auto const&, NavigationViewItemInvokedEventArgs const& event) {
        auto self = weak.lock(); if (!self || self->selectingNavigation || self->loading) return;
        if (event.IsSettingsInvoked()) { self->navigate(flag(self->updateResult, L"updateAvailable") ? L"about" : L"settings"); return; }
        auto item = event.InvokedItemContainer().try_as<NavigationViewItem>();
        if (!item || !item.Tag()) return;
        auto tag = item.Tag().as<Json>();
        self->navigate(text(tag, L"section"), text(tag, L"owner"), text(tag, L"folder"));
    });
    window.Activate();
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
            auto width = size.GetNamedNumber(L"width", 1280), height = size.GetNamedNumber(L"height", 840);
            if (std::isfinite(width) && std::isfinite(height)) window.AppWindow().Resize({static_cast<int>(std::clamp(width, 1040.0, 2400.0)), static_cast<int>(std::clamp(height, 700.0, 1600.0))});
        } catch (...) { error(L"The previous window size could not be restored."); }
        auto savedLayout = text(service->clientState(), L"morrow.mail.layout");
        if (savedLayout == L"right" || savedLayout == L"bottom" || savedLayout == L"focus") mailLayout = savedLayout;
        co_await refresh(true);
        if (GetCommandLineW() && std::wstring_view(GetCommandLineW()).find(L"--native-smoke") != std::wstring_view::npos) { co_await smoke(); co_return; }
        co_await navigate(connected(owner) || owner == L"all" ? L"mail" : L"settings");
        checkUpdates();
        timer = DispatcherTimer(); timer.Interval(std::chrono::seconds(5));
        timer.Tick([weak](auto const&, auto const&) {
            if (auto self = weak.lock(); self && !self->closing) {
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
    NavigationViewItemHeader header; header.Content(box_value(L"Workspace")); navigation.MenuItems().Append(header);
    for (auto const& item : {std::pair{L"Today",L"today"}, {L"Activity",L"activity"}, {L"Scheduled",L"scheduled"}, {L"Out of Office",L"out-of-office"}})
        navigation.MenuItems().Append(navItem(item.first, item.second));
    if (array(state, L"accounts").Size()) navigation.MenuItems().Append(navItem(L"All accounts", L"mail", L"all"));
    for (auto const& value : array(state, L"accounts")) {
        auto account = value.GetObject(); auto id = text(account, L"id"); if (id == L"demo") continue;
        auto item = navItem(id, L"mail", id);
        auto collapseKey = L"morrow.account.collapsed." + id;
        item.IsExpanded(text(desktopState, collapseKey.c_str()) != L"true");
        item.RegisterPropertyChangedCallback(NavigationViewItem::IsExpandedProperty(), [weak = weak_from_this(), collapseKey](DependencyObject const& sender, DependencyProperty const&) {
            if (auto self = weak.lock(); self && !self->selectingNavigation && !self->closing) {
                try { self->service->saveClientState(collapseKey, sender.as<NavigationViewItem>().IsExpanded() ? L"false" : L"true"); }
                catch (...) { self->error(errorText()); }
            }
        });
        auto counts = object(account, L"counts");
        for (auto const& mailbox : {std::pair{L"Inbox",L"inbox"}, {L"Starred",L"starred"}, {L"Pending",L"pending"}, {L"Sent",L"sent"}, {L"Drafts",L"drafts"}, {L"Archive",L"archive"}, {L"Spam / Junk",L"spam"}, {L"Trash",L"trash"}}) {
            auto title = hstring(mailbox.first) + L"  " + to_hstring(static_cast<uint64_t>(counts.GetNamedNumber(mailbox.second, 0)));
            auto child = navItem(title, L"mail", id, mailbox.second);
            child.IsSelected(section == L"mail" && owner == id && folder == mailbox.second);
            item.MenuItems().Append(child);
        }
        navigation.MenuItems().Append(item);
    }
    navigation.MenuItems().Append(navItem(L"Add account", L"settings"));
    updateBadge();
    selectingNavigation = false;
}
IAsyncAction Shell::navigate(hstring target, hstring account, hstring mailFolder) {
    auto lifetime = shared_from_this();
    if (closing || loading) co_return;
    if (!dirty.empty() && !(co_await confirm(L"Discard unsaved changes?", L"Your current edits have not been saved.", L"Discard"))) co_return;
    dirty.clear();
    ++generation; ++selectionGeneration; selected = Json(); readerFocused = false;
    auto version = generation;
    if (!account.empty()) owner = account;
    auto captured = owner;
    section = target; folder = mailFolder; cursors = {L""}; nextCursor = L"";
    error(L"");
    if (target == L"mail") {
        if (!connected(owner) && owner != L"all") { co_await settingsPage(lifetime, L"mail"); co_return; }
        loading = true;
        try {
            Json body; put(body, L"accountId", owner);
            auto result = co_await service->request(L"/account/select", owner, L"POST", body);
            if (!current(version, captured)) { loading = false; co_return; }
            state = result;
        } catch (...) { loading = false; error(errorText()); co_return; }
        loading = false; mailPage(); co_await loadPage();
    } else if (target == L"settings") co_await settingsPage(lifetime, L"mail");
    else if (target == L"about") co_await settingsPage(lifetime, L"about");
    else if (target == L"scheduled") co_await scheduledPage(lifetime);
    else if (target == L"out-of-office") co_await outOfOfficePage(lifetime);
    else co_await workspacePage(lifetime, target);
}
void Shell::mailPage() {
    Grid layout; layout.Margin(ThicknessHelper::FromUniformLength(16));
    RowDefinition top; top.Height(GridLengthHelper::Auto()); layout.RowDefinitions().Append(top);
    layout.RowDefinitions().Append(RowDefinition());
    RowDefinition bottom; bottom.Height(GridLengthHelper::Auto()); layout.RowDefinitions().Append(bottom);
    auto toolbar = actions();
    auto weak = weak_from_this();
    toolbar.Children().Append(button(L"New message", [weak] { if (auto self = weak.lock()) compose(self); }));
    toolbar.Children().Append(button(L"Sync", [weak] { if (auto self = weak.lock()) self->sync(); }));
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
        choice.Click([weak, delta = option.second](auto const&, auto const&) { if (auto self = weak.lock()) self->navigation.OpenPaneLength(std::clamp(self->navigation.OpenPaneLength() + delta, 180.0, 600.0)); });
        viewMenu.Items().Append(choice);
    }
    view.Flyout(viewMenu); toolbar.Children().Append(view);
    search = field(L"Search mail"); search.PlaceholderText(L"from:, after:, or a phrase"); search.MinWidth(260);
    search.KeyDown([weak](auto const&, Input::KeyRoutedEventArgs const& event) {
        if (event.Key() == Windows::System::VirtualKey::Enter) if (auto self = weak.lock()) { self->cursors = {L""}; self->loadPage(); event.Handled(true); }
    });
    toolbar.Children().Append(search);
    sorting = ComboBox(); sorting.Header(box_value(L"Sort"));
    for (auto sort : {L"Newest",L"Oldest",L"Sender",L"Subject",L"Unread first",L"Starred first"}) sorting.Items().Append(box_value(sort));
    sorting.SelectedIndex(0);
    sorting.SelectionChanged([weak](auto const&, auto const&) { if (auto self = weak.lock(); self && !self->loading) { self->cursors = {L""}; self->loadPage(); } });
    toolbar.Children().Append(sorting); layout.Children().Append(toolbar);
    Grid body; mailBody = body; body.Margin(ThicknessHelper::FromLengths(0, 12, 0, 12));
    ColumnDefinition listColumn; listColumn.Width(GridLengthHelper::FromPixels(400)); listColumn.MinWidth(220); body.ColumnDefinitions().Append(listColumn);
    ColumnDefinition divider; divider.Width(GridLengthHelper::FromPixels(8)); body.ColumnDefinitions().Append(divider);
    ColumnDefinition detailColumn; detailColumn.Width(GridLengthHelper::FromValueAndType(1, GridUnitType::Star)); detailColumn.MinWidth(280); body.ColumnDefinitions().Append(detailColumn);
    rows = ListView(); rows.SelectionMode(ListViewSelectionMode::Single); rows.IsItemClickEnabled(true);
    Automation::AutomationProperties::SetName(rows, L"Mail list");
    rows.ItemClick([weak](auto const&, ItemClickEventArgs const& event) {
        if (auto self = weak.lock()) {
            auto item = event.ClickedItem().try_as<ListViewItem>();
            if (item) self->read(item.Tag().as<Json>());
        }
    });
    body.Children().Append(rows);
    Primitives::Thumb resize; mailDivider = resize; resize.IsTabStop(true);
    Automation::AutomationProperties::SetName(resize, L"Resize mail list");
    auto adjust = [weak, body](double horizontal, double vertical) {
        if (auto self = weak.lock()) {
            if (self->mailLayout == L"bottom") self->listHeight = std::clamp(self->listHeight + vertical, 120.0, std::max(120.0, body.ActualHeight() - 208.0));
            else self->listWidth = std::clamp(self->listWidth + horizontal, 220.0, std::max(220.0, body.ActualWidth() - 288.0));
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
    reader.Content(label(L"Choose a message to read.")); Grid::SetColumn(reader, 2); body.Children().Append(reader);
    applyMailLayout(); Grid::SetRow(body, 1); layout.Children().Append(body);
    auto footer = actions();
    previous = button(L"Previous", [weak] { if (auto self = weak.lock(); self && !self->loading && self->cursors.size() > 1) { self->cursors.pop_back(); self->loadPage(); } });
    next = button(L"Next", [weak] { if (auto self = weak.lock(); self && !self->loading && !self->nextCursor.empty()) { self->cursors.push_back(self->nextCursor); self->loadPage(); } });
    pageLabel = label(L""); footer.Children().Append(previous); footer.Children().Append(pageLabel); footer.Children().Append(next);
    Grid::SetRow(footer, 2); layout.Children().Append(footer); show(layout);
}
void Shell::applyMailLayout() {
    if (!mailBody || !rows || !reader || !mailDivider) return;
    mailBody.RowDefinitions().Clear(); mailBody.ColumnDefinitions().Clear();
    Grid::SetRow(rows, 0); Grid::SetColumn(rows, 0); Grid::SetRow(reader, 0); Grid::SetColumn(reader, 0);
    Grid::SetRow(mailDivider, 0); Grid::SetColumn(mailDivider, 0);
    bool focus = mailLayout == L"focus", bottom = mailLayout == L"bottom";
    rows.Visibility(focus && readerFocused ? Visibility::Collapsed : Visibility::Visible);
    reader.Visibility(focus && !readerFocused ? Visibility::Collapsed : Visibility::Visible);
    mailDivider.Visibility(focus ? Visibility::Collapsed : Visibility::Visible);
    if (focus) return;
    if (bottom) {
        RowDefinition list; list.Height(GridLengthHelper::FromPixels(listHeight)); list.MinHeight(120);
        RowDefinition divider; divider.Height(GridLengthHelper::FromPixels(8));
        RowDefinition detail; detail.Height(GridLengthHelper::FromValueAndType(1, GridUnitType::Star)); detail.MinHeight(200);
        mailBody.RowDefinitions().Append(list); mailBody.RowDefinitions().Append(divider); mailBody.RowDefinitions().Append(detail);
        Grid::SetRow(mailDivider, 1); Grid::SetRow(reader, 2);
    } else {
        ColumnDefinition list; list.Width(GridLengthHelper::FromPixels(listWidth)); list.MinWidth(220);
        ColumnDefinition divider; divider.Width(GridLengthHelper::FromPixels(8));
        ColumnDefinition detail; detail.Width(GridLengthHelper::FromValueAndType(1, GridUnitType::Star)); detail.MinWidth(280);
        mailBody.ColumnDefinitions().Append(list); mailBody.ColumnDefinitions().Append(divider); mailBody.ColumnDefinitions().Append(detail);
        Grid::SetColumn(mailDivider, 1); Grid::SetColumn(reader, 2);
    }
}
IAsyncAction Shell::loadPage() {
    auto lifetime = shared_from_this();
    if (loading || section != L"mail" || !rows) co_return;
    loading = true; auto version = generation; auto captured = owner;
    previous.IsEnabled(false); next.IsEnabled(false);
    search.IsEnabled(false); sorting.IsEnabled(false);
    try {
        Json options; put(options, L"folder", folder); put(options, L"cursor", cursors.back());
        if (cursors.back().empty()) options.Insert(L"offset", Value::CreateNumberValue(static_cast<double>((cursors.size() - 1) * 50)));
        wchar_t const* sorts[] = {L"newest",L"oldest",L"sender",L"subject",L"unread",L"starred"};
        put(options, L"sort", sorts[std::clamp(sorting.SelectedIndex(), 0, 5)]);
        put(options, L"locale", L"en");
        hstring path = L"/mail/page";
        if (!search.Text().empty()) { path = L"/search"; put(options, L"query", search.Text()); put(options, L"scope", L"folder"); put(options, L"sort", L"relevance"); options.Insert(L"page",Value::CreateNumberValue(static_cast<double>(cursors.size()-1))); }
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
            bool unread = !flag(message, L"read");
            auto sender = label(text(message, L"fromName", text(message, L"fromEmail"))); bold(sender, unread); heading.Children().Append(sender);
            auto dot = label(unread ? L"●" : L""); Grid::SetColumn(dot, 1); heading.Children().Append(dot); row.Children().Append(heading);
            for (auto key : {L"subject",L"preview",L"date"}) { auto content = label(text(message, key), key == std::wstring_view(L"date") ? 11 : 14); content.MaxLines(key == std::wstring_view(L"preview") && density == L"spacious" ? 3 : 1); content.TextTrimming(TextTrimming::CharacterEllipsis); bold(content, unread); row.Children().Append(content); }
            if (captured == L"all") row.Children().Append(label(text(message, L"accountId"), 11));
            if (flag(message, L"pending")) row.Children().Append(label(L"Pending", 11));
            auto entry = preserve ? rows.Items().GetAt(index).as<ListViewItem>() : ListViewItem();
            entry.Content(row); entry.Tag(message); entry.HorizontalContentAlignment(HorizontalAlignment::Stretch);
            Automation::AutomationProperties::SetName(entry, text(message, L"fromName") + L", " + text(message, L"subject") + (unread ? L", unread" : L", read"));
            if (!preserve) rows.Items().Append(entry);
            if (text(message, L"viewId") == selectedId) rows.SelectedItem(entry);
            ++index;
        }
        nextCursor = text(result, L"nextCursor");
        previous.IsEnabled(cursors.size() > 1); next.IsEnabled(!nextCursor.empty());
        pageLabel.Text(L"Page " + to_hstring(cursors.size()) + L" · " + to_hstring(static_cast<uint64_t>(result.GetNamedNumber(L"total", 0))) + L" messages");
        error(text(result, L"warning"));
    } catch (...) { error(errorText()); }
    search.IsEnabled(true); sorting.IsEnabled(true);
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
    auto content = stack(8); content.Padding(ThicknessHelper::FromLengths(20, 4, 8, 16));
    auto title = label(text(message, L"subject", L"(No subject)"), 22); content.Children().Append(title);
    content.Children().Append(label(text(message, L"fromName") + L" <" + text(message, L"fromEmail") + L"> · " + text(message, L"date"), 12));
    content.Children().Append(label(L"To: " + text(message, L"to") + (text(message, L"cc").empty() ? L"" : L" · Cc: " + text(message, L"cc")), 12));
    auto weak = weak_from_this(); auto replies = actions();
    replies.Children().Append(button(L"Back to list", [weak] { if (auto self = weak.lock()) { self->readerFocused = false; self->applyMailLayout(); self->rows.Focus(FocusState::Programmatic); } }));
    if (flag(message, L"providerDraft")) replies.Children().Append(button(L"Copy to local draft", [weak, message] { if (auto self = weak.lock()) self->prepare(message, L"copy"); }));
    else for (auto const& option : {std::pair{L"Reply", L"reply"}, {L"Reply all",L"replyAll"}, {L"Forward",L"forward"}})
        replies.Children().Append(button(option.first, [weak, message, mode = hstring(option.second)] { if (auto self = weak.lock()) self->prepare(message, mode); }));
    content.Children().Append(replies);
    auto markers = actions();
    for (auto const& option : {std::pair{L"Read",L"read"}, {L"Starred",L"starred"}, {L"Pending",L"pending"}}) {
        Primitives::ToggleButton toggle; toggle.Content(box_value(option.first)); toggle.IsChecked(flag(message, option.second));
        toggle.Click([weak, message, key = std::wstring(option.second)](auto const&, auto const&) { if (auto self = weak.lock()) { Json change; change.Insert(key, Value::CreateBooleanValue(!flag(message, key.c_str()))); self->patch(message, change); } });
        markers.Children().Append(toggle);
    }
    content.Children().Append(markers);
    auto remote = text(message, L"remoteId", text(message, L"id"));
    if (std::wstring_view(remote).starts_with(L"google:") || std::wstring_view(remote).starts_with(L"microsoft:") || std::wstring_view(remote).starts_with(L"imap:"))
        content.Children().Append(button(L"Move / Labels / Spam on provider…", [weak, message] { if (auto self = weak.lock()) self->organize(message); }));
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
    auto body = label(text(message, L"body"), 15); body.Margin(ThicknessHelper::FromLengths(0, 12, 0, 0)); content.Children().Append(body);
    if (!text(message, L"bodyHtml").empty()) content.Children().Append(label(L"Plain-text view. External images are not loaded.", 11));
    reader.Content(scroll(content));
}
IAsyncAction Shell::patch(Json message, Json changes) {
    auto lifetime = shared_from_this(); auto version = generation; auto captured = owner; auto sequence = ++selectionGeneration;
    auto account = text(message, L"accountId"); auto id = text(message, L"id");
    if (!connected(account)) co_return;
    try {
        auto result = co_await service->request(L"/messages/" + escaped(id), account, L"PATCH", changes);
        if (!current(version, captured) || sequence != selectionGeneration) co_return;
        selected = object(result, L"message"); renderReader(selected);
        for (auto& cursor : cursors) cursor = L"";
        co_await loadPage();
    } catch (...) { error(errorText()); }
}
IAsyncAction Shell::organize(Json message) {
    auto lifetime = shared_from_this(); auto version = generation; auto captured = owner;
    auto sequence = selectionGeneration; auto account = text(message, L"accountId");
    if (dialogOpen || loading || !connected(account) || !dirty.empty()) co_return;
    try {
        loading = true;
        auto result = co_await service->request(L"/mail/folders", account);
        loading = false;
        if (!current(version, captured) || sequence != selectionGeneration || dialogOpen) co_return;
        auto content = stack(12); content.Children().Append(label(account + L"\n" + text(message, L"subject")));
        ComboBox mode; mode.Header(box_value(L"Action"));
        mode.Items().Append(box_value(L"Move"));
        if (text(result, L"provider") == L"google") { mode.Items().Append(box_value(L"Add label")); mode.Items().Append(box_value(L"Remove label")); }
        mode.SelectedIndex(0); content.Children().Append(mode);
        ComboBox destination; destination.Header(box_value(L"Folder / label")); destination.HorizontalAlignment(HorizontalAlignment::Stretch);
        auto populate = [destination, mode, result] {
            destination.Items().Clear();
            for (auto const& value : array(result, L"folders")) {
                auto folder = value.GetObject();
                if (mode.SelectedIndex() != 0 && text(folder, L"kind") != L"label") continue;
                ComboBoxItem item; item.Content(box_value(text(folder, L"name"))); item.Tag(folder); destination.Items().Append(item);
            }
            destination.SelectedIndex(-1);
        };
        populate(); mode.SelectionChanged([populate](auto const&, auto const&) { populate(); });
        content.Children().Append(destination);
        content.Children().Append(label(L"Provider changes affect this mailbox on the remote server. Gmail Move removes Inbox while retaining other labels. Spam / Junk is a provider move. Phishing reports and sender blocking remain provider-site actions."));
        auto provider = text(result, L"provider");
        if (provider == L"google" || provider == L"microsoft") content.Children().Append(button(L"Open provider for reporting / blocking", [provider] { Windows::System::Launcher::LaunchUriAsync(Uri(provider == L"google" ? L"https://mail.google.com/" : L"https://outlook.live.com/mail/")); }));
        ContentDialog dialog; dialog.XamlRoot(root.XamlRoot()); dialog.Title(box_value(L"Organize on provider")); dialog.Content(scroll(content));
        dialog.PrimaryButtonText(L"Review change"); dialog.CloseButtonText(L"Cancel"); dialog.IsPrimaryButtonEnabled(false);
        destination.SelectionChanged([dialog, destination](auto const&, auto const&) { dialog.IsPrimaryButtonEnabled(destination.SelectedIndex() >= 0); });
        dialogOpen = true;
        ContentDialogResult decision;
        try { decision = co_await dialog.ShowAsync(); } catch (...) { dialogOpen = false; throw; }
        dialogOpen = false;
        if (decision != ContentDialogResult::Primary || !current(version, captured) || sequence != selectionGeneration || destination.SelectedIndex() < 0) co_return;
        auto target = destination.SelectedItem().as<ComboBoxItem>().Tag().as<Json>();
        wchar_t const* modes[] = {L"move", L"addLabel", L"removeLabel"};
        auto action = hstring(modes[std::clamp(mode.SelectedIndex(), 0, 2)]);
        if (!(co_await confirm(L"Apply this provider change?", account + L"\n" + text(message, L"subject") + L"\n" + action + L" → " + text(target, L"name"), L"Apply provider change")) || !current(version, captured) || sequence != selectionGeneration) co_return;
        Json body; put(body, L"destinationId", text(target, L"id")); put(body, L"mode", action); body.Insert(L"confirmed", Value::CreateBooleanValue(true));
        auto updated = co_await service->request(L"/messages/" + escaped(text(message, L"id")) + L"/organize", account, L"POST", body);
        if (!current(version, captured) || sequence != selectionGeneration) co_return;
        selected = object(updated, L"message"); renderReader(selected);
        for (auto& cursor : cursors) cursor = L"";
        co_await loadPage();
    } catch (...) { loading = false; error(errorText()); }
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
    dialogOpen = true;
    ContentDialog dialog; dialog.XamlRoot(root.XamlRoot()); dialog.Title(box_value(history ? L"Suggest with History" : action));
    auto content = stack(); auto progress = label(L"Waiting for the configured model…"); content.Children().Append(progress);
    dialog.Content(scroll(content)); dialog.CloseButtonText(L"Close");
    auto display = dialog.ShowAsync();
    Json result; bool failed = false;
    try {
        Json input; put(input, L"action", action); put(input, L"messageId", text(message, L"id")); input.Insert(L"includeHistory", Value::CreateBooleanValue(history));
        result = co_await service->request(L"/ai", text(message, L"accountId"), L"POST", input);
        if (current(version, captured) && sequence == selectionGeneration && display.Status() == AsyncStatus::Started) {
            progress.Text(text(result, L"text"));
            if (action == L"reply") dialog.PrimaryButtonText(L"Use in draft");
        }
    } catch (...) { failed = true; progress.Text(errorText()); }
    ContentDialogResult choice = ContentDialogResult::None;
    try { choice = co_await display; } catch (...) {}
    dialogOpen = false;
    if (!failed && choice == ContentDialogResult::Primary && current(version, captured) && sequence == selectionGeneration)
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
            auto size = window.AppWindow().Size(); service->saveWindowSize(std::clamp(size.Width, 1040, 2400), std::clamp(size.Height, 700, 1600));
        }
    } catch (...) { error(L"The window size could not be saved. Mail and settings are retained."); }
    closing = true; ++generation; if (timer) timer.Stop(); navigation.IsEnabled(false); error(L"Closing the private service…");
    try { if (service) co_await service->stop(); } catch (...) {}
    closeReady = true;
    window.Close(); Application::Current().Exit();
}
IAsyncAction workspacePage(std::shared_ptr<Shell> self, hstring kind) {
    auto version = self->generation; auto account = self->owner;
    auto content = stack(16); content.Padding(ThicknessHelper::FromUniformLength(24));
    content.Children().Append(label(kind == L"activity" ? L"Activity" : L"Today", 28));
    content.Children().Append(label(account.empty() ? L"Your workspace" : account));
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
            content.Children().Append(label(L"Downloaded mailbox totals; these are not today's arrivals or complete provider coverage."));
            for (auto const& value : array(self->state, L"accounts")) {
                auto mailbox = value.GetObject(); if (account != L"all" && text(mailbox, L"id") != account) continue;
                auto counts = object(mailbox, L"counts");
                content.Children().Append(label(text(mailbox, L"email") + L" · Unread Inbox " + to_hstring(static_cast<unsigned>(mailbox.GetNamedNumber(L"unread", 0))) + L" · Drafts " + to_hstring(static_cast<unsigned>(counts.GetNamedNumber(L"drafts", 0))), 18));
            }
            content.Children().Append(label(L"Today's saved summaries", 20));
            bool found = false;
            for (auto const& value : array(object(self->state, L"workspace"), L"summaries")) {
                auto report = value.GetObject();
                auto date = text(report, L"status") == L"completed" ? text(report, L"completedAt", text(report, L"createdAt")) : text(report, L"createdAt");
                if (!sameDay(date)) continue;
                found = true; content.Children().Append(label(text(report, L"kind") + L" · " + text(report, L"status") + L" · " + date));
                content.Children().Append(label(text(report, L"text")));
            }
            if (!found) content.Children().Append(label(account == L"all" ? L"Choose one mailbox to see its saved summaries." : L"No saved summaries for today. Viewing this page does not generate AI work."));
        }
        if (self->current(version, account)) self->show(scroll(content));
    } catch (...) { self->error(errorText()); }
}
}

struct MorrowApplication : winrt::Microsoft::UI::Xaml::ApplicationT<MorrowApplication> {
    std::shared_ptr<morrow::Shell> shell;
    MorrowApplication() { Resources().MergedDictionaries().Append(winrt::Microsoft::UI::Xaml::Controls::XamlControlsResources()); }
    void OnLaunched(winrt::Microsoft::UI::Xaml::LaunchActivatedEventArgs const&) {
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
        winrt::init_apartment(winrt::apartment_type::single_threaded);
        SetCurrentProcessExplicitAppUserModelID(L"org.morrowmail.desktop");
        winrt::Microsoft::UI::Xaml::Application::Start([](auto const&) { winrt::make<MorrowApplication>(); });
    } catch (...) { MessageBoxW(nullptr, L"Morrow Mail could not initialize. Your saved workspace is retained.", L"Morrow Mail", MB_OK | MB_ICONERROR); result = 1; }
    CloseHandle(instance); return result;
}
