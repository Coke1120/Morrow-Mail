#include "pch.h"
#include "Ui.h"
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Provider.h>
#include <winrt/Windows.ApplicationModel.DataTransfer.h>
#include <winrt/Microsoft.UI.Xaml.Media.Imaging.h>
#include <winrt/Windows.Graphics.Imaging.h>
#include <winrt/Windows.Storage.h>
#include <winrt/Windows.Storage.Streams.h>
#include <fstream>
#include <cstdio>
#include <cmath>
#include <set>

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
using namespace Windows::Data::Json;
IAsyncAction nativeInteractionChecks(std::shared_ptr<Shell> shell);
IAsyncAction captureMailList(std::shared_ptr<Shell> shell, hstring name) {
    xaml::Media::Imaging::RenderTargetBitmap bitmap;
    co_await bitmap.RenderAsync(shell->root);
    if (bitmap.PixelWidth() <= 0 || bitmap.PixelHeight() <= 0) throw hresult_error(E_FAIL, L"Mail list capture is empty.");
    auto pixels = co_await bitmap.GetPixelsAsync();
    std::vector<uint8_t> bytes(pixels.Length());
    Windows::Storage::Streams::DataReader::FromBuffer(pixels).ReadBytes(bytes);
    auto folder = co_await Windows::Storage::StorageFolder::GetFolderFromPathAsync(shell->service->directory().wstring());
    auto file = co_await folder.CreateFileAsync(name, Windows::Storage::CreationCollisionOption::ReplaceExisting);
    auto stream = co_await file.OpenAsync(Windows::Storage::FileAccessMode::ReadWrite);
    using namespace Windows::Graphics::Imaging;
    auto encoder = co_await BitmapEncoder::CreateAsync(BitmapEncoder::PngEncoderId(), stream);
    encoder.SetPixelData(BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied, bitmap.PixelWidth(), bitmap.PixelHeight(), 96, 96, bytes);
    co_await encoder.FlushAsync();
}
void syncStatusChecks() {
    auto check = [](bool condition, wchar_t const* message) { if (!condition) throw hresult_error(E_FAIL, message); };
    Shell shell; shell.status = controls::TextBlock(); shell.owner = L"all";
    shell.state = Json::Parse(LR"({"accounts":[{"id":"one@example.invalid"},{"id":"two@example.invalid"}],"syncErrors":[{"accountId":"one@example.invalid","error":"Reconnect this account."},{"accountId":"two@example.invalid","error":"Provider request limit.","nextRetryAt":"2030-01-01T00:00:00.000Z"},{"accountId":"off@example.invalid","error":"Disconnected account."}]})");
    auto contains = [&](wchar_t const* value) { return std::wstring_view(shell.status.Text()).find(value) != std::wstring_view::npos; };
    shell.error(L"");
    check(contains(L"one@example.invalid") && contains(L"two@example.invalid") && contains(L"Next retry:") && !contains(L"off@example.invalid"), L"Combined sync failures, retry timing or disconnected-account filtering are missing.");
    shell.error(L""); // The same status reset is used by periodic workspace refresh.
    check(contains(L"Reconnect") && contains(L"Provider request limit"), L"Workspace refresh cleared unresolved sync failures.");
    shell.owner = L"one@example.invalid"; shell.error(L"");
    check(contains(L"one@example.invalid") && !contains(L"two@example.invalid"), L"Sync status crossed the selected mailbox.");
    shell.error(L"Draft save failed.");
    check(shell.status.Text() == L"Draft save failed.", L"Sync status hid the current operation's error.");
    shell.state.Insert(L"syncErrors", JsonArray()); shell.error(L"");
    check(shell.status.Text().empty(), L"Resolved sync failures remained visible.");
}
void mailDragChecks(std::shared_ptr<Service> const& service) {
    auto check = [](bool condition, wchar_t const* message) { if (!condition) throw hresult_error(E_FAIL, message); };
    auto shell = std::make_shared<Shell>(); shell->service = service; shell->owner = L"all"; shell->rows = controls::ListView();
    JsonArray accounts;
    for (auto owner : {L"drag@example.invalid", L"other@example.invalid"}) {
        Json account, connection; put(account, L"id", owner); put(account, L"provider", L"google"); put(connection, L"connection", L"original"); account.Insert(L"settings", connection); accounts.Append(account);
        Json folder, catalog; JsonArray folders; put(folder, L"id", L"label"); put(folder, L"name", L"Work / 中文"); put(folder, L"kind", L"label"); folders.Append(folder); catalog.Insert(L"folders", folders); shell->serverFolders.Insert(owner, catalog);
        Json message; put(message, L"id", L"google:duplicate"); put(message, L"viewId", hstring(owner) + L":duplicate"); put(message, L"accountId", owner);
        controls::ListViewItem row; row.Tag(message); shell->rows.Items().Append(row);
    }
    shell->state.Insert(L"accounts", accounts);
    auto source = shell->rows.Items().GetAt(0).as<controls::ListViewItem>().Tag().as<Json>();
    auto token = shell->startMailDrag(source);
    auto valid = [&] { return shell->mailDropMessage(token, L"drag@example.invalid", L"label").Size() != 0; };
    check(!token.empty() && valid(), L"An owned message in All accounts cannot be dragged to its label.");
    check(!shell->mailDropMessage(token, L"other@example.invalid", L"label").Size() && !shell->mailDropMessage(L"external", L"drag@example.invalid", L"label").Size()
        && !shell->mailDropMessage(token, L"drag@example.invalid", L"missing").Size(), L"External, cross-owner duplicate ID or missing destination accepted.");
    check(shell->mailDropDestination(L"all", L"archive").empty() && shell->mailDropDestination(L"drag@example.invalid", L"archive") == L"__archive", L"Combined or Gmail Archive drop destination is incorrect.");
    Windows::ApplicationModel::DataTransfer::DataPackage data;
    data.SetData(L"com.morrowmail.mail-row", box_value(token)); data.Properties().Insert(L"com.morrowmail.mail-row", box_value(token));
    check(data.GetView().Contains(L"com.morrowmail.mail-row") && unbox_value<hstring>(data.GetView().Properties().Lookup(L"com.morrowmail.mail-row")) == token,
        L"The native drag DataPackage lost its opaque token.");
    for (auto field : {L"loading", L"dialog", L"dirty", L"generation", L"owner", L"connection", L"disconnected", L"hidden", L"selectable", L"row"}) {
        auto savedState = Json::Parse(shell->state.Stringify()), savedFolders = Json::Parse(shell->serverFolders.Stringify());
        if (field == std::wstring_view(L"loading")) shell->loading = true;
        if (field == std::wstring_view(L"dialog")) shell->dialogOpen = true;
        if (field == std::wstring_view(L"dirty")) shell->dirty.insert(L"fixture");
        if (field == std::wstring_view(L"generation")) ++shell->generation;
        if (field == std::wstring_view(L"owner")) shell->owner = L"other@example.invalid";
        if (field == std::wstring_view(L"connection")) put(object(accounts.GetAt(0).GetObject(), L"settings"), L"connection", L"replacement");
        if (field == std::wstring_view(L"disconnected")) shell->state.Insert(L"accounts", JsonArray());
        if (field == std::wstring_view(L"hidden") || field == std::wstring_view(L"selectable")) {
            auto folder = array(object(shell->serverFolders, L"drag@example.invalid"), L"folders").GetAt(0).GetObject();
            folder.Insert(field, Value::CreateBooleanValue(field == std::wstring_view(L"hidden")));
        }
        if (field == std::wstring_view(L"row")) shell->rows.Items().RemoveAt(0);
        check(!valid(), L"A stale or unavailable mail drop passed validation.");
        shell->loading = false; shell->dialogOpen = false; shell->dirty.clear(); shell->generation = 0; shell->owner = L"all";
        shell->state = savedState; accounts = array(shell->state, L"accounts"); shell->serverFolders = savedFolders;
        if (field == std::wstring_view(L"row")) { controls::ListViewItem row; row.Tag(source); shell->rows.Items().InsertAt(0, row); }
    }
    shell->mailDragToken = {}; check(!valid(), L"A completed drag token can be replayed.");
    Json local; put(local, L"id", L"local"); put(local, L"accountId", L"drag@example.invalid"); put(local, L"viewId", L"local");
    check(shell->startMailDrag(local).empty(), L"A local-only message can start a provider drag.");
    for (auto provider : {L"microsoft", L"imap"}) {
        auto account = array(shell->state, L"accounts").GetAt(0).GetObject(); put(account, L"provider", provider);
        auto message = Json::Parse(source.Stringify()); put(message, L"id", hstring(provider) + L":duplicate");
        shell->rows.Items().GetAt(0).as<controls::ListViewItem>().Tag(message);
        auto token = shell->startMailDrag(message);
        check(!token.empty() && shell->mailDropMessage(token, L"drag@example.invalid", L"label").Size()
            && shell->mailDropDestination(L"drag@example.invalid", L"archive").empty(), L"Outlook/IMAP drop routing or unavailable Archive failed.");
    }
}
IAsyncAction Shell::smoke() {
    auto lifetime = shared_from_this();
    auto check = [](bool condition, wchar_t const* message) { if (!condition) throw hresult_error(E_FAIL, message); };
    std::string failure, phase = "begin";
    bool fixtureVerified = false;
    auto enter = [&](std::string next) {
        phase = std::move(next);
        std::fprintf(stderr, "Native smoke: %s\n", phase.c_str()); std::fflush(stderr);
    };
    Json readerEvidence;
    try {
        readerSecurityChecks();
        check(mailDateLabel(L"2026-09-28T12:00:00.000Z") == mailDateLabel(L"2026-09-28T20:00:00+08:00")
            && std::wstring_view(mailDateLabel(L"2026-09-28T12:00:00.000Z")).find(L"T12:") == std::wstring_view::npos
            && mailDateLabel(L"invalid") == L"invalid", L"Mail dates did not preserve the instant while formatting local time.");
        auto directory = service->directory();
        check(std::filesystem::canonical(directory.parent_path()) == std::filesystem::canonical(std::filesystem::temp_directory_path()) && directory.filename().wstring().starts_with(L"morrow-native-check-"), L"Native acceptance requires an isolated temporary workspace.");
        std::ifstream marker(directory / L"disposable-native-fixture");
        std::string value((std::istreambuf_iterator<char>(marker)), {});
        check(value == "Morrow native acceptance fixture", L"Native acceptance fixture marker is missing.");
        fixtureVerified = true;
        enter("sync-status"); syncStatusChecks();
        enter("mail-drag-drop-guards"); mailDragChecks(service);
        bool seeded = array(state,L"accounts").Size() > 0;
        enter("sidebar-resize-and-filter");
        check(folderFilter && sidebarDivider, L"The sidebar has no native folder filter or resize handle.");
        auto sidebarWidth = navigation.OpenPaneLength();
        resizeSidebar(sidebarWidth + 40);
        check(navigation.OpenPaneLength() > sidebarWidth && !text(service->clientState(), L"morrow.sidebar.width").empty(), L"Sidebar enlargement was not persisted.");
        resizeSidebar(0, false); check(navigation.OpenPaneLength() == 180, L"The sidebar can shrink below its accessible minimum.");
        resizeSidebar(sidebarWidth, false);
        if (seeded) {
            check(array(object(serverFolders, owner.c_str()), L"folders").Size() > 0,
                L"Startup did not restore the owning folder catalog without Browse/Refresh.");
            auto savedFolders = Json::Parse(serverFolders.Stringify()); auto savedOwner = owner; auto savedFolder = folder; auto savedGeneration = generation; auto savedSelected = selected.Stringify();
            Json catalog; JsonArray entries;
            for (auto name : {L"Projects / A very long folder name 中文", L"Other"}) { Json entry; put(entry, L"id", name); put(entry, L"name", name); entries.Append(entry); }
            catalog.Insert(L"folders", entries); serverFolders.Insert(owner, catalog);
            folderFilter.Text(L"PROJECTS"); rebuildNavigation();
            int matches = 0, managers = 0;
            for (auto const& value : navigation.MenuItems()) if (auto group=value.try_as<controls::NavigationViewItem>();group&&group.Tag()&&text(group.Tag().as<Json>(),L"owner")==owner) {
                for (auto const& child:group.MenuItems()) if(auto remote=child.try_as<controls::NavigationViewItem>();remote&&remote.MenuItems().Size()) {
                    for(auto const& entry:remote.MenuItems()) {auto item=entry.as<controls::NavigationViewItem>();auto tag=item.Tag().as<Json>();if(text(tag,L"section")==L"manage-folders")++managers;else if(text(tag,L"section")==L"mail"){++matches;check(text(tag,L"folder")==L"provider:Projects / A very long folder name 中文"&&item.ContextFlyout()&&item.AllowDrop(),L"The folder filter, context actions or native drop target failed.");}}
                }
            }
            check(matches==1&&managers==1&&owner==savedOwner&&folder==savedFolder&&generation==savedGeneration&&selected.Stringify()==savedSelected,L"Filtering folders changed the current mailbox or selection.");
            for (auto const& row : rows.Items()) check(row.as<controls::ListViewItem>().CanDrag(), L"A mail list row has no native drag gesture.");
            folderFilter.Text(L""); serverFolders=savedFolders; rebuildNavigation();
        }
        enter("macos-layout-parity");
        auto themes = xaml::Application::Current().Resources().ThemeDictionaries();
        for (auto name : {L"Light", L"Default"}) {
            auto palette = themes.Lookup(box_value(name)).as<xaml::ResourceDictionary>();
            auto color = unbox_value<Windows::UI::Color>(palette.Lookup(box_value(L"SystemAccentColor")));
            check(name == std::wstring_view(L"Light") ? color == Windows::UI::Color{255, 26, 74, 61} : color == Windows::UI::Color{255, 166, 212, 176}, L"Windows lost the shared Morrow light/dark accent.");
        }
        check(themes.Lookup(box_value(L"HighContrast")).as<xaml::ResourceDictionary>().Size() == 0, L"Brand colours override the system high-contrast palette.");
        enter("theme-background");
        auto requestedTheme = root.RequestedTheme();
        apartment_context themeUi;
        for (bool dark : {false, true}) {
            root.RequestedTheme(dark ? xaml::ElementTheme::Dark : xaml::ElementTheme::Light);
            co_await resume_after(std::chrono::milliseconds(50)); co_await themeUi;
            root.UpdateLayout();
            auto background = root.Background().try_as<xaml::Media::SolidColorBrush>();
            check(bool(background), L"The native shell has no opaque theme background.");
            auto color = background.Color();
            check(color.A == 255 && (dark ? std::max({color.R, color.G, color.B}) < 80
                : std::min({color.R, color.G, color.B}) > 220), L"Switching Light/Dark did not repaint the native shell background.");
        }
        root.RequestedTheme(requestedTheme);
        check(composeButton.IsEnabled() == seeded, L"Compose does not reflect connected-account onboarding.");
        controls::NavigationViewItem combined{nullptr};
        for (auto const& value : navigation.MenuItems()) if (auto item = value.try_as<controls::NavigationViewItem>(); item && item.Tag()) {
            auto tag = item.Tag().as<Json>();
            check(text(tag, L"owner") != L"demo", L"The internal Demo account is visible.");
            if (text(tag, L"owner") == L"all") combined = item;
        }
        check(bool(combined) == seeded, L"Combined folders do not reflect the connected accounts.");
        if (combined) {
            check(combined.MenuItems().Size() == 9, L"Combined mail does not expose every mailbox folder.");
            std::set<std::wstring> folders;
            for (auto const& value : combined.MenuItems()) {
                auto tag = value.as<controls::NavigationViewItem>().Tag().as<Json>();
                check(text(tag, L"owner") == L"all" && text(tag, L"section") == L"mail", L"A combined folder is routed to an individual owner.");
                folders.insert(std::wstring(text(tag, L"folder")));
            }
            check(folders == std::set<std::wstring>{L"inbox", L"starred", L"pending", L"later", L"sent", L"drafts", L"archive", L"spam", L"trash"}, L"Combined mail folder destinations are duplicated or missing.");
        }
        enter("initial-page");
        check(page.Content() && !loading && !closing && !dialogOpen && dirty.empty(), L"The normal initial page is not ready.");
        if (seeded) {
            check(section == L"mail" && connected(owner) && rows && rows.Items().Size() >= 1,
                L"The initial owned mailbox has no ready mail rows.");
            auto firstRow = rows.Items().GetAt(0).as<controls::ListViewItem>().Content().try_as<controls::StackPanel>();
            auto quick = firstRow ? firstRow.Tag().try_as<controls::StackPanel>() : controls::StackPanel{nullptr};
            check(quick && quick.Children().Size() == 3, L"Mail rows lost read, Reply all, or provider Trash actions.");
            check(mailList && mailList.RowDefinitions().Size() == 3 && mailBody.Children().Size() == 3 &&
                controls::Grid::GetRow(rows) == 1, L"Mail controls and paging are not grouped with the message list.");
            auto savedLayout = mailLayout;
            mailLayout = L"focus"; readerFocused = true; applyMailLayout();
            check(mailList.Visibility() == xaml::Visibility::Collapsed && reader.Visibility() == xaml::Visibility::Visible,
                L"Focused reading did not hide the complete mail list pane.");
            readerFocused = false; mailLayout = savedLayout; applyMailLayout();
            for (auto const& item : rows.Items())
                check(text(item.as<controls::ListViewItem>().Tag().as<Json>(), L"accountId") == owner,
                    L"The initial mail page contains another owner's rows.");
        } else {
            check(owner.empty() && section == L"mail" && page.Content() != nullptr, L"Fresh startup did not open Add account onboarding.");
        }
        // Application readiness only, not a compositor/presentation timestamp.
        std::fprintf(stderr, "Native milestone: first-page-ready\n"); std::fflush(stderr);
        apartment_context ui;
        co_await resume_after(std::chrono::seconds(2)); co_await ui;
        if (seeded) {
            enter("mail-resize");
            auto savedLayout = mailLayout;
            auto savedHeight = listHeight;
            mailLayout = L"bottom"; listHeight = 120; applyMailLayout(); mailBody.UpdateLayout();
            check(rows.ActualHeight() >= 80, L"Resizing Reader below hid the message rows behind fixed mailbox controls.");
            listHeight = savedHeight; mailLayout = savedLayout; applyMailLayout();
            // Measure the first HTML document before dialogs or the mailbox walkthrough.
            enter("reader-isolation");
            readerEvidence = co_await readerRuntimeChecks(lifetime);
        }
        enter("folder-manager-and-pickers");
        co_await folderPickerChecks(root);
        enter("interaction-guards");
        co_await nativeInteractionChecks(lifetime);
        enter("sidebar-settings-click");
        root.UpdateLayout();
        auto settingsItem = navigation.SettingsItem().as<controls::NavigationViewItem>();
        auto settingsPeer = xaml::Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(settingsItem);
        auto settingsSelect = settingsPeer.GetPattern(xaml::Automation::Peers::PatternInterface::SelectionItem).try_as<xaml::Automation::Provider::ISelectionItemProvider>();
        check(bool(settingsSelect), L"The native Settings navigation item does not expose its selection action.");
        settingsSelect.Select();
        auto navigationDeadline = GetTickCount64() + 5000;
        while (section != L"preferences" && GetTickCount64() < navigationDeadline) {
            co_await resume_after(std::chrono::milliseconds(10)); co_await ui;
        }
        check(section == L"preferences" && page.Content() && !closing, L"Clicking the native Settings item did not safely open preferences.");
        if (!seeded) {
            enter("fresh-settings");
            check(owner.empty(), L"Fresh onboarding selected the internal Demo mailbox.");
            co_await navigate(L"settings");
            check(page.Content() != nullptr, L"Add account UI did not load.");
        } else {
            enter("window-size");
            check(array(state,L"accounts").Size() == 2, L"Expected two isolated fixture owners.");
            auto restoredSize = window.AppWindow().Size();
            auto expectedSize = mailWindowBounds(window, 1040, 760);
            auto resizeDeadline = GetTickCount64() + 1000;
            while ((restoredSize.Width != expectedSize.Width || restoredSize.Height != expectedSize.Height) && GetTickCount64() < resizeDeadline) {
                co_await resume_after(std::chrono::milliseconds(10));
                co_await ui;
                restoredSize = window.AppWindow().Size();
            }
            if (restoredSize.Width != expectedSize.Width || restoredSize.Height != expectedSize.Height) {
                auto detail = L"The previous host window size was not restored: expected " + to_hstring(expectedSize.Width) + L"x" + to_hstring(expectedSize.Height) + L", got " + to_hstring(restoredSize.Width) + L"x" + to_hstring(restoredSize.Height)
                    + L"; maximum track size " + to_hstring(GetSystemMetrics(SM_CXMAXTRACK)) + L"x" + to_hstring(GetSystemMetrics(SM_CYMAXTRACK)) + L".";
                throw hresult_error(E_FAIL, detail);
            }
            enter("mail-first-page");
            co_await navigate(L"mail", L"one@fixture.invalid");
            check(rows.Items().Size() == 50 && !nextCursor.empty(), L"First mail page is incomplete.");
            std::set<std::wstring> identities;
            for (auto const& item : rows.Items()) {
                auto row = item.as<controls::ListViewItem>().Tag().as<Json>();
                check(text(row,L"accountId") == owner && !row.HasKey(L"body"), L"Metadata exposed bodies or another owner.");
                identities.insert(std::wstring(text(row,L"viewId")));
            }
            check(identities.size() == 50, L"Mail rows have duplicate UI identities.");
            enter("mail-next-page");
            cursors.push_back(nextCursor);
            auto pendingPage = loadPage();
            check(loading && !search.IsEnabled() && !sorting.IsEnabled(), L"Query and sort remained editable during pagination.");
            co_await pendingPage;
            check(!loading && search.IsEnabled() && sorting.IsEnabled(), L"Pagination did not restore query and sort controls.");
            check(rows.Items().Size() == 15 && nextCursor.empty(), L"Second page did not finish the mailbox.");
            cursors.pop_back(); co_await loadPage();
            enter("mail-sorts");
            for (int sort = 0; sort < 6; ++sort) {
                loading = true; sorting.SelectedIndex(sort); loading = false;
                cursors = {L""}; co_await loadPage();
                check(rows.Items().Size() == 50, L"A supported sort could not load.");
            }
            enter("mail-reader");
            auto response = co_await service->request(L"/messages/mail-000", owner);
            auto source = object(response,L"message");
            auto row = rows.Items().GetAt(0).as<controls::ListViewItem>();
            auto clicked = row.Tag().as<Json>();
            rows.ScrollIntoView(row);
            root.UpdateLayout();
            auto layoutDeadline = GetTickCount64() + 5000;
            while ((!row.ActualWidth() || !row.ActualHeight()) && GetTickCount64() < layoutDeadline) {
                co_await resume_after(std::chrono::milliseconds(10)); co_await ui; root.UpdateLayout();
            }
            auto peer = xaml::Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(rows)
                .as<xaml::Automation::Peers::ListViewAutomationPeer>().CreateItemAutomationPeer(row);
            auto select = peer.GetPattern(xaml::Automation::Peers::PatternInterface::SelectionItem).try_as<xaml::Automation::Provider::ISelectionItemProvider>();
            check(bool(select), L"The native mail row does not expose its selection action.");
            select.Select();
            auto clickDeadline = GetTickCount64() + 5000;
            while ((text(selected,L"viewId") != text(clicked,L"viewId") || text(selected,L"body").size() <= 20 || loading) && GetTickCount64() < clickDeadline) {
                co_await resume_after(std::chrono::milliseconds(10)); co_await ui;
            }
            check(text(selected,L"viewId") == text(clicked,L"viewId"), L"Clicking a native mail row did not open its owned message.");
            co_await read(source);
            check(text(selected,L"accountId") == owner && text(selected,L"body").size() > 20, L"The native reader did not load full owned text.");
            auto readerLayout = reader.Content().try_as<controls::Grid>();
            check(readerLayout && readerLayout.RowDefinitions().Size() == 2,
                L"The message actions are not kept above the scrolling reader.");
            enter("mail-patches");
            auto markerSelection = selectionGeneration;
            auto markerReadGeneration = readGeneration;
            Json pending; pending.Insert(L"pending",Value::CreateBooleanValue(true)); co_await patch(source,pending);
            check(flag(selected,L"pending") && selectionGeneration == markerSelection && readGeneration != markerReadGeneration,
                L"Pending did not update metadata while retaining selection and invalidating older reads.");
            Json later; later.Insert(L"lowPriority",Value::CreateBooleanValue(true)); co_await patch(selected,later);
            check(flag(selected,L"lowPriority") && flag(selected,L"pending"),L"Later should be independent from Pending in the native reader.");
            later.Insert(L"lowPriority",Value::CreateBooleanValue(false)); co_await patch(selected,later);
            check(!flag(selected,L"lowPriority") && flag(selected,L"pending"),L"Returning from Later cleared the Pending marker.");
            auto cursorCount = cursors.size();
            Json unread; unread.Insert(L"read",Value::CreateBooleanValue(false)); co_await patch(selected,unread);
            check(!flag(selected,L"read") && cursors.size()==cursorCount && selectionGeneration == markerSelection,
                L"Manual unread reset selection or pagination.");
            auto otherRow = rows.Items().GetAt(1).as<controls::ListViewItem>().Tag().as<Json>();
            auto selectedID = text(selected,L"viewId");
            check(text(otherRow,L"viewId") != selectedID, L"Fixture rows did not have separate identities.");
            Json otherRead; otherRead.Insert(L"read",Value::CreateBooleanValue(!flag(otherRow,L"read")));
            auto otherPatch = patch(otherRow,otherRead);
            check(loading, L"The local marker patch did not guard its in-flight update.");
            co_await read(otherRow); // A read started during the mutation must not replace the selection.
            co_await otherPatch;
            check(text(selected,L"viewId") == selectedID && selectionGeneration == markerSelection,
                L"A quick action or overlapping read on another row replaced or invalidated the open reader.");
            enter("mail-interrupted-read");
            for (auto key : {L"read", L"starred", L"pending", L"other-row"}) {
                co_await read(source);
                loading = true; rows.SelectedItems().Clear();
                for (auto const& item : rows.Items())
                    if (text(item.as<controls::ListViewItem>().Tag().as<Json>(),L"viewId") == text(otherRow,L"viewId")) rows.SelectedItems().Append(item);
                loading = false;
                auto opening = read(otherRow); // The background GET cannot complete on this UI thread before the next PATCH starts.
                check(text(pendingRead,L"viewId") == text(otherRow,L"viewId") && text(selected,L"viewId") == selectedID,
                    L"The interrupted-read fixture did not hold the new selection's detail request.");
                Json marker; marker.Insert(key == std::wstring_view(L"other-row") ? L"pending" : key,Value::CreateBooleanValue(true));
                auto mutation = patch(key == std::wstring_view(L"other-row") ? source : otherRow,marker);
                co_await opening; co_await mutation;
                auto chosen = selectedMessages();
                check(!pendingRead.Size() && chosen.size() == 1 && text(chosen[0],L"viewId") == text(otherRow,L"viewId")
                    && text(selected,L"viewId") == text(otherRow,L"viewId") && text(selected,L"accountId") == text(otherRow,L"accountId")
                    && text(selected,L"body").size() > 20,
                    L"A local patch stranded the selected row's interrupted detail read or crossed its owner.");
                if (key != std::wstring_view(L"other-row")) check(flag(selected,key), L"The resumed reader applied metadata from before the patch.");
            }
            {
                enter("mail-reader-reselection");
                auto previousSort = sorting.SelectedIndex();
                loading = true; sorting.SelectedIndex(1); loading = false; // Oldest keeps A and its peer on this page after Unstar.
                for (auto& cursor : cursors) cursor = L"";
                co_await loadPage();
                check(rows.Items().Size() >= 2, L"Reselection requires two stable owned rows.");
                auto stablePeer = rows.Items().GetAt(1).as<controls::ListViewItem>().Tag().as<Json>();
                auto originalA = object(co_await service->request(L"/messages/" + escaped(text(source,L"id")),text(source,L"accountId")),L"message");
                auto originalB = object(co_await service->request(L"/messages/" + escaped(text(stablePeer,L"id")),text(stablePeer,L"accountId")),L"message");
                check(connected(text(originalA,L"accountId")) && text(originalA,L"accountId") == owner
                    && text(originalB,L"accountId") == owner && text(originalA,L"viewId") == selectedID
                    && text(originalB,L"viewId") == text(stablePeer,L"viewId") && text(originalA,L"viewId") != text(originalB,L"viewId"),
                    L"Reselection requires two distinct owned fixture messages.");
                auto previousMarkRead = flag(object(object(state,L"settings"),L"preferences"),L"markReadOnOpen");
                Json readingPreference; readingPreference.Insert(L"markReadOnOpen",Value::CreateBooleanValue(true));
                state = co_await service->request(L"/settings/preferences",L"",L"POST",readingPreference);
                check(flag(object(object(state,L"settings"),L"preferences"),L"markReadOnOpen"),
                    L"Reselection did not enable the fixture automatic read preference.");
                for (auto key : {L"read", L"unread", L"starred", L"pending", L"no-patch", L"busy-reselect"}) {
                    enter("mail-reselect-" + to_string(key));
                    Json unreadB; unreadB.Insert(L"read",Value::CreateBooleanValue(false));
                    auto preparedB = object(co_await service->request(L"/messages/" + escaped(text(originalB,L"id")),text(originalB,L"accountId"),L"PATCH",unreadB),L"message");
                    check(!flag(preparedB,L"read") && text(preparedB,L"viewId") == text(originalB,L"viewId"),
                        L"Reselection did not prepare the owned unread B fixture.");
                    co_await read(source);
                    auto mountedA = Json::Parse(selected.Stringify());
                    auto mountedReader = reader.Content();
                    check(text(mountedA,L"viewId") == selectedID && text(mountedA,L"accountId") == owner && text(mountedA,L"body").size() > 20,
                        L"Reselection did not mount A's full owned body.");
                    for (auto& cursor : cursors) cursor = L"";
                    co_await loadPage();
                    controls::ListViewItem itemA{nullptr}, itemB{nullptr};
                    for (auto const& item : rows.Items()) {
                        auto entry = item.as<controls::ListViewItem>(); auto metadata = entry.Tag().as<Json>();
                        if (text(metadata,L"viewId") == selectedID) itemA = entry;
                        if (text(metadata,L"viewId") == text(originalB,L"viewId")) itemB = entry;
                    }
                    check(itemA && itemB, L"Reselection fixture rows disappeared from the current page.");
                    auto reselectPeer = xaml::Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(rows)
                        .as<xaml::Automation::Peers::ListViewAutomationPeer>().CreateItemAutomationPeer(itemA);
                    auto reselectA = reselectPeer.GetPattern(xaml::Automation::Peers::PatternInterface::SelectionItem)
                        .try_as<xaml::Automation::Provider::ISelectionItemProvider>();
                    check(bool(reselectA), L"A's native row does not expose its reselection action.");
                    loading = true; rows.SelectedItems().Clear(); rows.SelectedItems().Append(itemB); loading = false;
                    auto opening = read(itemB.Tag().as<Json>());
                    auto pendingGeneration = readGeneration;
                    check(text(pendingRead,L"viewId") == text(originalB,L"viewId") && text(selected,L"viewId") == selectedID,
                        L"Reselection did not hold B's detail GET while A remained mounted.");
                    bool busyReselect = key == std::wstring_view(L"busy-reselect");
                    bool patchA = key != std::wstring_view(L"no-patch");
                    auto markerKey = busyReselect ? L"pending" : key == std::wstring_view(L"unread") ? L"read" : key;
                    // The resumed GET must respect an explicit unread change, even under mark-on-open.
                    bool markerValue = key == std::wstring_view(L"read") || (markerKey != std::wstring_view(L"read") && patchA && !flag(mountedA,markerKey));
                    Json marker; if (patchA) marker.Insert(markerKey,Value::CreateBooleanValue(markerValue));
                    IAsyncAction mutation{nullptr};
                    if (busyReselect) {
                        mutation = patch(mountedA,marker);
                        check(loading && !pendingRead.Size(), L"The busy reselection fixture did not interrupt B's detail GET.");
                    }
                    // No await between B's GET, the actual SelectionChanged and the optional PATCH.
                    reselectA.Select();
                    auto reselected = selectedMessages();
                    check(reselected.size() == 1 && text(reselected[0],L"viewId") == selectedID && text(reselected[0],L"accountId") == owner
                        && readGeneration != pendingGeneration
                        && (busyReselect ? !pendingRead.Size() && loading
                            : text(pendingRead,L"viewId") == selectedID && text(pendingRead,L"accountId") == owner),
                        L"Actually reselecting A did not replace B's pending GET with A's owned detail request.");
                    if (patchA) {
                        if (!busyReselect) mutation = patch(mountedA,marker);
                        co_await opening; co_await mutation;
                    } else {
                        co_await opening;
                        // SelectionChanged owns A's new operation. Wait only for completion;
                        // B's pending state and A's reselection above never depend on a delay.
                        auto completionDeadline = GetTickCount64() + 5000;
                        while ((pendingRead.Size() || loading || reader.Content() == mountedReader) && GetTickCount64() < completionDeadline) {
                            co_await resume_after(std::chrono::milliseconds(10)); co_await ui;
                        }
                    }
                    auto chosen = selectedMessages();
                    check(!pendingRead.Size() && chosen.size() == 1 && text(chosen[0],L"viewId") == selectedID
                        && text(chosen[0],L"accountId") == owner && text(selected,L"viewId") == selectedID
                        && text(selected,L"accountId") == owner && text(selected,L"body") == text(mountedA,L"body")
                        && reader.Content() != mountedReader && !loading,
                        L"B's completed detail GET replaced the reselected A row, reader owner or full body.");
                    if (patchA) check(flag(selected,markerKey) == markerValue && flag(chosen[0],markerKey) == markerValue,
                        L"Reselection lost A's local marker update in the reader or list.");
                    auto finishedB = object(co_await service->request(L"/messages/" + escaped(text(originalB,L"id")),text(originalB,L"accountId")),L"message");
                    check(text(finishedB,L"viewId") == text(originalB,L"viewId") && text(finishedB,L"accountId") == owner && !flag(finishedB,L"read"),
                        L"Completing the revoked B GET marked the unselected fixture message read.");
                }
                Json restoreA; for (auto key : {L"read", L"starred", L"pending"}) restoreA.Insert(key,Value::CreateBooleanValue(flag(originalA,key)));
                co_await service->request(L"/messages/" + escaped(text(originalA,L"id")),text(originalA,L"accountId"),L"PATCH",restoreA);
                Json restoreB; restoreB.Insert(L"read",Value::CreateBooleanValue(flag(originalB,L"read")));
                co_await service->request(L"/messages/" + escaped(text(originalB,L"id")),text(originalB,L"accountId"),L"PATCH",restoreB);
                readingPreference.Insert(L"markReadOnOpen",Value::CreateBooleanValue(previousMarkRead));
                state = co_await service->request(L"/settings/preferences",L"",L"POST",readingPreference);
                check(flag(object(object(state,L"settings"),L"preferences"),L"markReadOnOpen") == previousMarkRead,
                    L"Reselection did not restore the fixture reading preference.");
                loading = true; sorting.SelectedIndex(previousSort); loading = false;
                for (auto& cursor : cursors) cursor = L"";
                co_await loadPage();
            }
            co_await read(source);
            enter("mail-multi-selection");
            check(rows.SelectionMode() == controls::ListViewSelectionMode::Extended, L"Mail list does not support range/multiple selection.");
            loading = true; rows.SelectedItems().Clear();
            rows.SelectedItems().Append(rows.Items().GetAt(0)); rows.SelectedItems().Append(rows.Items().GetAt(1)); loading = false;
            auto batch = selectedMessages();
            check(batch.size() == 2 && text(batch[0],L"viewId") != text(batch[1],L"viewId"), L"Multiple selection lost owned row identities.");
            auto outside = rows.Items().GetAt(2).as<controls::ListViewItem>().Tag().as<Json>();
            check(selectedMessages(outside).size() == 1, L"Right-click outside selection acts on unrelated mail.");
            auto menu = rows.Items().GetAt(0).as<controls::ListViewItem>().ContextFlyout().as<controls::MenuFlyout>();
            menu.ShowAt(rows.Items().GetAt(0).as<controls::ListViewItem>());
            co_await resume_after(std::chrono::milliseconds(50)); co_await ui;
            check(menu.Items().Size() >= 9, L"The selection context menu has no batch actions."); menu.Hide();
            Json stars; stars.Insert(L"starred",Value::CreateBooleanValue(true)); co_await patchMessages(batch,stars);
            for (auto const& message : batch) check(flag(object(co_await service->request(L"/messages/"+escaped(text(message,L"id")),text(message,L"accountId")),L"message"),L"starred"), L"Batch patch lost an owning mailbox.");
            check(selectedMessages().size() == 2, L"Refreshing a batch discarded multi-selection.");
            enter("mail-unread-filter");
            auto markOnOpen = flag(object(object(state,L"settings"),L"preferences"),L"markReadOnOpen");
            Json readingPreference; readingPreference.Insert(L"markReadOnOpen",Value::CreateBooleanValue(true));
            state = co_await service->request(L"/settings/preferences",L"",L"POST",readingPreference);
            unreadFilter.IsChecked(true); cursors = {L""}; co_await loadPage();
            check(rows.Items().Size() > 0, L"Unread filter lost the unread fixture message.");
            for (auto const& item : rows.Items()) check(!flag(item.as<controls::ListViewItem>().Tag().as<Json>(), L"read"), L"Unread-only view includes a read message.");
            auto firstUnread = rows.Items().GetAt(0).as<controls::ListViewItem>().Tag().as<Json>();
            co_await read(firstUnread);
            check(flag(selected,L"read") && retainedUnread.Size() && rows.Items().Size() > 0, L"Unread filtering removed the active read row.");
            auto following = rows.Items().GetAt(1).as<controls::ListViewItem>().Tag().as<Json>();
            co_await read(following);
            for (auto const& item : rows.Items()) check(text(item.as<controls::ListViewItem>().Tag().as<Json>(),L"viewId") != text(firstUnread,L"viewId"), L"Switching messages retained the previous read row.");
            co_await patch(selected,pending);
            check(flag(retainedUnread,L"pending"), L"The retained row did not update its Pending marker.");
            co_await patch(selected,unread);
            check(!flag(selected,L"read") && !retainedUnread.Size(), L"Marking retained mail unread kept a stale read marker.");
            unreadFilter.IsChecked(false);
            readingPreference.Insert(L"markReadOnOpen",Value::CreateBooleanValue(markOnOpen));
            state = co_await service->request(L"/settings/preferences",L"",L"POST",readingPreference);
            check(flag(object(object(state,L"settings"),L"preferences"),L"markReadOnOpen") == markOnOpen, L"Unread checks did not restore the fixture reading preference.");
            cursors = {L""}; co_await loadPage();
            enter("mail-combined");
            co_await navigate(L"mail",L"all");
            check(pageLabel.Text().size() && rows.Items().Size()==50, L"Combined mail did not load.");
            for (auto const& value : rows.Items()) {
                auto item = value.as<controls::ListViewItem>();
                auto row = item.Content().as<controls::StackPanel>();
                auto heading = row.Children().GetAt(0).as<controls::Grid>();
                auto identity = heading.Children().GetAt(0).as<controls::Grid>();
                auto account = identity.Children().GetAt(1).as<controls::TextBlock>();
                auto date = heading.Children().GetAt(1).as<controls::TextBlock>();
                auto message = item.Tag().as<Json>();
                check(account.Text() == text(message, L"accountId") && controls::Grid::GetColumn(account) == 1,
                    L"Combined row did not show its own mailbox beside the sender.");
                check(date.Text() == mailDateLabel(text(message, L"date")) && controls::Grid::GetColumn(date) == 1 && date.TextAlignment() == xaml::TextAlignment::Right,
                    L"Mail date is missing from the right side of the header.");
                auto subjectLine = row.Children().GetAt(1).as<controls::Grid>();
                check(subjectLine.Children().GetAt(2) == row.Tag(), L"Quick actions must not displace the sender header.");
                auto name = xaml::Automation::AutomationProperties::GetName(item);
                check(std::wstring_view(name).find(account.Text()) != std::wstring_view::npos, L"Accessible mail row lost its complete owning mailbox.");
            }
            enter("mail-list-layout");
            auto originalLayout = mailLayout; auto originalWidth = listWidth; auto originalTheme = root.RequestedTheme();
            auto originalDensity = text(object(object(state, L"settings"), L"preferences"), L"density");
            mailLayout = L"right";
            for (auto density : {L"compact", L"comfortable", L"spacious"}) {
                Json preference; put(preference, L"density", density);
                state = co_await service->request(L"/settings/preferences", L"", L"POST", preference);
                co_await loadPage();
                for (bool dark : {false, true}) for (double width : {260., 320., 500.}) {
                    root.RequestedTheme(dark ? xaml::ElementTheme::Dark : xaml::ElementTheme::Light);
                    listWidth = width; applyMailLayout(); root.UpdateLayout();
                    auto item = rows.Items().GetAt(0).as<controls::ListViewItem>(); rows.ScrollIntoView(item);
                    auto deadline = GetTickCount64() + 2000;
                    do { co_await resume_after(std::chrono::milliseconds(20)); co_await ui; root.UpdateLayout(); }
                    while ((!item.ActualHeight() || std::abs(mailList.ActualWidth() - width) > 1) && GetTickCount64() < deadline);
                    auto listHeading = mailList.Children().GetAt(0).as<controls::StackPanel>();
                    auto toolbar = listHeading.Children().GetAt(listHeading.Children().Size() - 1).as<controls::Grid>();
                    auto deleteButton = toolbar.Children().GetAt(0).as<controls::StackPanel>().Children().GetAt(2).as<controls::Button>();
                    auto refreshButton = toolbar.Children().GetAt(1).as<controls::Button>();
                    auto deleteOrigin = deleteButton.TransformToVisual(toolbar).TransformPoint(Point{});
                    auto refreshOrigin = refreshButton.TransformToVisual(toolbar).TransformPoint(Point{});
                    check(deleteButton.ActualWidth() >= 28 && deleteOrigin.X + deleteButton.ActualWidth() <= refreshOrigin.X + 1
                        && refreshOrigin.X + refreshButton.ActualWidth() <= toolbar.ActualWidth() + 1,
                        L"The narrow mail toolbar overlaps Delete and Refresh or clips an action.");
                    check(xaml::Automation::AutomationProperties::GetName(deleteButton) == L"Delete selected messages",
                        L"The toolbar Delete icon lost its accessible action name.");
                    auto row = item.Content().as<controls::StackPanel>();
                    auto heading = row.Children().GetAt(0).as<controls::Grid>();
                    auto identity = heading.Children().GetAt(0).as<controls::Grid>();
                    auto sender = identity.Children().GetAt(0).as<controls::TextBlock>();
                    auto account = identity.Children().GetAt(1).as<controls::TextBlock>();
                    auto date = heading.Children().GetAt(1).as<controls::TextBlock>();
                    auto origin = [&](xaml::UIElement const& element) { return element.TransformToVisual(heading).TransformPoint(Point{}); };
                    check(std::abs(mailList.ActualWidth() - width) < 1 && sender.ActualWidth() > 20 && account.ActualWidth() > 20 && date.ActualWidth() > 20,
                        L"A narrow mail header lost its sender, mailbox or date.");
                    check(origin(account).X >= origin(sender).X + sender.ActualWidth() - 1 && origin(date).X >= origin(account).X + account.ActualWidth() - 1
                        && origin(date).X + date.ActualWidth() <= heading.ActualWidth() + 1, L"Mail header fields overlap or overflow.");
                    auto before = origin(date); auto quick = row.Tag().as<controls::StackPanel>(); quick.Visibility(xaml::Visibility::Visible); root.UpdateLayout();
                    check(origin(date) == before, L"Quick actions displaced the mail date.");
                    quick.Visibility(xaml::Visibility::Collapsed);
                    if (width == 320 || density == std::wstring_view(L"comfortable"))
                        co_await captureMailList(lifetime, L"mail-list-" + hstring(density) + (dark ? L"-dark-" : L"-light-") + to_hstring(static_cast<int>(width)) + L".png");
                }
            }
            Json preference; put(preference, L"density", originalDensity);
            state = co_await service->request(L"/settings/preferences", L"", L"POST", preference);
            mailLayout = originalLayout; listWidth = originalWidth; root.RequestedTheme(originalTheme); applyMailLayout(); co_await loadPage();
            enter("studio-combined");
            co_await navigate(L"studio",L"all");
            check(section==L"summaries" && owner==L"all" && page.Content(), L"Combined AI Studio did not show saved summaries.");
            co_await navigate(L"mail",L"all");
            auto other = object(co_await service->request(L"/messages/mail-000",L"two@fixture.invalid"),L"message");
            check(text(other,L"viewId") != text(source,L"viewId") && !flag(other,L"pending"),L"Same provider ID crossed owners.");
            enter("draft-prepare");
            Json prepare; put(prepare,L"messageId",L"provider-draft"); put(prepare,L"mode",L"copy");
            auto copy=object(co_await service->request(L"/drafts/prepare",L"one@fixture.invalid",L"POST",prepare),L"draft");
            check(text(copy,L"bcc")==L"bcc@fixture.invalid" && !copy.HasKey(L"id"),L"Provider copy lost Bcc or reused source identity.");
            enter("draft-save");
            Json draft; put(draft,L"to",L"to@fixture.invalid"); put(draft,L"bcc",L"bcc@fixture.invalid"); put(draft,L"subject",L"Native saved draft"); put(draft,L"body",L"Native saved body.");
            co_await service->request(L"/drafts",L"one@fixture.invalid",L"POST",draft);
            enter("client-state");
            auto savedState=service->clientState(); auto pendingCalendar=text(savedState,L"morrow.pendingCalendar");
            service->saveClientState(L"morrow.account.collapsed.one@fixture.invalid",L"true");
            check(text(service->clientState(),L"morrow.pendingCalendar")==pendingCalendar,L"Desktop state changed a frozen calendar retry.");
            co_await navigate(L"mail",L"one@fixture.invalid");
            for (auto const* target : {L"today", L"activity", L"scheduled", L"calendar", L"out-of-office", L"studio", L"learning", L"brain", L"reply-suggestions", L"skills", L"summaries", L"records"}) {
                enter("workspace-" + to_string(target));
                auto previousPage = page.Content();
                co_await navigate(target);
                check(page.Content() && page.Content() != previousPage, L"A native workspace page failed to open.");
                check(dirty.empty(), L"Opening a saved page incorrectly created unsaved edits.");
                if (std::wstring_view(target) == L"today") {
                    auto today = page.Content().as<controls::ScrollViewer>().Content().as<controls::StackPanel>();
                    controls::Button generate{nullptr}; controls::ComboBox mailbox{nullptr};
                    for (auto const& child : today.Children()) if (auto actions = child.try_as<controls::StackPanel>()) {
                        for (auto const& control : actions.Children()) {
                            if (auto choice = control.try_as<controls::ComboBox>()) mailbox = choice;
                            if (auto action = control.try_as<controls::Button>(); action && unbox_value<hstring>(action.Content()) == L"Summarize now") generate = action;
                        }
                    }
                    check(generate && generate.IsEnabled() && mailbox && mailbox.Items().Size() == array(state, L"accounts").Size(), L"Today lost its explicit summary action or mailbox scope.");
                    for (auto const& value : mailbox.Items()) check(connected(unbox_value<hstring>(value.as<controls::ComboBoxItem>().Tag())), L"Today offers a combined or internal Demo AI identity.");
                    check(connected(todaySummaryOwner), L"Today did not retain an individual summary mailbox.");
                }
                if (std::wstring_view(target) == L"studio") {
                    auto studio = page.Content().as<controls::ScrollViewer>().Content().as<controls::StackPanel>();
                    auto tabs = studio.Children().GetAt(3).as<controls::ScrollViewer>().Content().as<controls::StackPanel>();
                    check(tabs.Children().Size() == 3, L"AI Studio must show Assistant, Summaries and More.");
                    auto more = tabs.Children().GetAt(2).as<controls::ComboBox>();
                    check(unbox_value<hstring>(more.Items().GetAt(0).as<controls::ComboBoxItem>().Tag()) == L"brain",
                        L"Writing style and notes is no longer reachable through More.");
                }
            }
            for (auto const* tab : {L"start", L"general", L"mail", L"calendar", L"model", L"search", L"policy", L"about"}) {
                enter("settings-" + to_string(tab));
                auto previousPage = page.Content();
                if (std::wstring_view(tab) == L"mail") {
                    state.Insert(L"accounts", Windows::Data::Json::JsonArray());
                    state.Insert(L"serverFolders", Json()); serverFolders = Json();
                }
                co_await settingsPage(lifetime, tab);
                check(page.Content() && page.Content() != previousPage, L"A native Settings tab failed to open.");
                auto layout = page.Content().try_as<controls::Grid>();
                check(layout && layout.ColumnDefinitions().Size() == 2 && layout.RowDefinitions().Size() == 3, L"Settings lost its fixed category sidebar and independently scrolling content.");
                auto categories = layout.Children().GetAt(1).as<controls::ScrollViewer>().Content().as<controls::StackPanel>();
                check(categories.Children().GetAt(0).as<controls::ListView>().Items().Size() == 6, L"Everyday Settings must keep six primary categories.");
                auto advanced = categories.Children().GetAt(1).as<controls::Expander>();
                check(advanced.Content().as<controls::ListView>().Items().Size() == 3 &&
                    advanced.IsExpanded() == (std::wstring_view(tab) == L"model" || std::wstring_view(tab) == L"search"),
                    L"Advanced settings must open for direct setup links and stay collapsed on everyday pages.");
                if (std::wstring_view(tab) == L"model") {
                    auto body = layout.Children().GetAt(3).as<controls::ScrollViewer>().Content().as<controls::StackPanel>();
                    auto panel = body.Children().GetAt(2).as<controls::ContentControl>().Content().as<controls::StackPanel>();
                    auto keys = panel.Children().GetAt(3).as<controls::Expander>();
                    check(keys.IsExpanded() != flag(object(object(state, L"settings"), L"ai"), L"hasApiKey"), L"Saved model keys must keep the replacement field collapsed.");
                    auto input = panel.Children().GetAt(1).as<controls::TextBox>();
                    auto secret = keys.Content().as<controls::StackPanel>().Children().GetAt(0).as<controls::PasswordBox>();
                    root.UpdateLayout();
                    auto readyDeadline = GetTickCount64() + 5000;
                    while ((!input.IsLoaded() || !input.ActualWidth()) && GetTickCount64() < readyDeadline) {
                        co_await resume_after(std::chrono::milliseconds(10)); co_await ui; root.UpdateLayout();
                    }
                    check(input.IsLoaded() && input.ActualWidth(), L"The model endpoint control did not load for native input.");
                    input.ApplyTemplate(); secret.ApplyTemplate();
                    auto changed = std::make_shared<bool>(false);
                    auto textChanged = input.TextChanged(auto_revoke, [changed](auto const&, auto const&) { *changed = true; });
                    auto original = input.Text(); input.Text(L"http://remote.invalid/v1"); secret.Password(L"fictional-unsaved-model-key");
                    auto editDeadline = GetTickCount64() + 5000;
                    while (!*changed && GetTickCount64() < editDeadline) {
                        co_await resume_after(std::chrono::milliseconds(10)); co_await ui;
                    }
                    check(*changed, L"The model endpoint edit did not reach its native TextChanged handler.");
                    auto test = panel.Children().GetAt(7).as<controls::Button>();
                    root.UpdateLayout();
                    auto peer = xaml::Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(test);
                    auto invoke = peer.GetPattern(xaml::Automation::Peers::PatternInterface::Invoke).try_as<xaml::Automation::Provider::IInvokeProvider>();
                    check(bool(invoke), L"The model connection test must expose its native action.");
                    invoke.Invoke();
                    auto notice = layout.Children().GetAt(2).as<controls::TextBlock>();
                    auto deadline = GetTickCount64() + 5000;
                    while ((!navigation.IsEnabled() || std::wstring_view(notice.Text()).find(L"Remote AI providers") == std::wstring_view::npos) && GetTickCount64() < deadline) {
                        co_await resume_after(std::chrono::milliseconds(10)); co_await ui;
                    }
                    check(navigation.IsEnabled() && std::wstring_view(notice.Text()).find(L"Remote AI providers") != std::wstring_view::npos, L"The invalid endpoint probe did not finish without model work.");
                    check(secret.Password() == L"fictional-unsaved-model-key", L"Testing a model discarded the entered key before it could be saved or retried.");
                    *changed = false; input.Text(original); secret.Password(L"");
                    editDeadline = GetTickCount64() + 5000;
                    while (!*changed && GetTickCount64() < editDeadline) {
                        co_await resume_after(std::chrono::milliseconds(10)); co_await ui;
                    }
                    check(*changed && dirty.empty(), L"Restoring the model fixture left unsaved edits.");
                }
                if (std::wstring_view(tab) == L"search") {
                    auto body = layout.Children().GetAt(3).as<controls::ScrollViewer>().Content().as<controls::StackPanel>();
                    controls::ComboBox history{nullptr}; controls::Expander limits{nullptr}; bool primary = false;
                    for (auto const& child : body.Children()) if (auto container = child.try_as<controls::ContentControl>()) {
                        if (auto panel = container.Content().try_as<controls::StackPanel>()) for (auto const& control : panel.Children()) {
                            if (auto choice = control.try_as<controls::ComboBox>(); choice && unbox_value<hstring>(choice.Header()) == L"Index history") history = choice;
                            if (auto disclosure = control.try_as<controls::Expander>(); disclosure && unbox_value<hstring>(disclosure.Header()) == L"Advanced indexing options") limits = disclosure;
                            if (auto entry = control.try_as<controls::Button>(); entry && unbox_value<hstring>(entry.Content()) == L"Index downloaded mail & keep updated…") primary = true;
                            check(!control.try_as<controls::NumberBox>(), L"Technical batch limits remain in the primary indexing form.");
                        }
                    }
                    check(history && limits && !limits.IsExpanded() && primary && history.Items().Size() == 5,
                        L"Search needs an all-downloaded option, primary automatic action and collapsed advanced limits.");
                    check(unbox_value<hstring>(history.Items().GetAt(0).as<controls::ComboBoxItem>().Tag()) == L"0", L"All downloaded history has the wrong service value.");
                    auto previous = history.SelectedIndex(); history.SelectedIndex(4);
                    co_await resume_after(std::chrono::milliseconds(2300)); co_await ui;
                    check(history.SelectedIndex() == 4, L"Search status polling discarded an unsaved history-range edit.");
                    history.SelectedIndex(previous);
                }
                if (std::wstring_view(tab) == L"mail" || std::wstring_view(tab) == L"calendar") {
                    auto body = layout.Children().GetAt(3).as<controls::ScrollViewer>().Content().as<controls::StackPanel>();
                    bool mail = std::wstring_view(tab) == L"mail";
                    auto panel = mail ? body.Children().GetAt(2).as<controls::Expander>().Content().as<controls::StackPanel>()
                        .Children().GetAt(2).as<controls::Expander>().Content().as<controls::StackPanel>()
                        .Children().GetAt(0).as<controls::ContentControl>().Content().as<controls::StackPanel>()
                        : body.Children().GetAt(4).as<controls::ContentControl>().Content().as<controls::StackPanel>();
                    auto input = panel.Children().GetAt(mail ? 0 : 1).as<controls::TextBox>();
                    auto secret = panel.Children().GetAt(mail ? 1 : 2).as<controls::PasswordBox>();
                    auto original = input.Text(); input.Text(L"unsaved@fixture.invalid"); secret.Password(L"fictional-unsaved-secret");
                    auto edits = dirty; auto capturedOwner = owner; auto version = generation;
                    owner = L""; // Background/OAuth selection changes must keep the form current.
                    auto status = body.Children().GetAt(mail ? 5 : 3).as<controls::StackPanel>();
                    if (!mail) status.Children().GetAt(0).as<controls::TextBlock>().Text(L"Stale connection status");
                    auto deadline = GetTickCount64() + 8000;
                    while ((mail ? status.Children().Size() == 0 : status.Children().GetAt(0).as<controls::TextBlock>().Text() != L"Not connected") && GetTickCount64() < deadline) {
                        co_await resume_after(std::chrono::milliseconds(20)); co_await ui;
                    }
                    check(mail ? status.Children().Size() > 0 && array(state, L"accounts").Size() == 2
                        : status.Children().GetAt(0).as<controls::TextBlock>().Text() == L"Not connected", L"Settings did not automatically refresh local connection metadata.");
                    check(page.Content() == layout && generation == version && input.Text() == L"unsaved@fixture.invalid" && secret.Password() == L"fictional-unsaved-secret" && dirty == edits,
                        L"Automatic connection refresh replaced the page or unsaved credentials.");
                    if (mail) check(serverFolders.Size() == 2 && object(state, L"serverFolders").Size() == 2,
                        L"Settings polling omitted the saved folder catalogs.");
                    owner = capturedOwner; input.Text(original); secret.Password(L"");
                }
                if (std::wstring_view(tab) == L"policy") {
                    auto saved = object(object(state, L"settings"), L"policy").Stringify();
                    auto body = layout.Children().GetAt(3).as<controls::ScrollViewer>().Content().as<controls::StackPanel>();
                    auto form = body.Children().GetAt(2).as<controls::ContentControl>().Content().as<controls::StackPanel>();
                    uint32_t optionalSections = 0;
                    for (auto const& child : form.Children()) if (auto section = child.try_as<controls::Expander>()) {
                        check(!section.IsExpanded(), L"Optional AI permission controls must start collapsed.");
                        section.IsExpanded(true); section.IsExpanded(false); ++optionalSections;
                    }
                    check(optionalSections == 3 && object(object(state, L"settings"), L"policy").Stringify() == saved,
                        L"Showing optional permission controls changed saved permissions.");
                }
                check(dirty.empty(), L"Opening a Settings tab incorrectly created unsaved edits.");
            }
            enter("composer-layout");
            co_await compose(lifetime);
            auto editor = page.Content().try_as<controls::Grid>();
            check(section == L"compose" && editor && editor.RowDefinitions().Size() == 2 && dirty.empty(),
                L"The composer did not keep its actions outside the scrolling form.");
            auto reviewControls = [&](controls::Grid const& layout, bool visible) {
                auto panes = layout.Children().GetAt(layout.Children().Size() - 1).as<controls::Grid>();
                auto form = panes.Children().GetAt(0).as<controls::ScrollViewer>().Content().as<controls::StackPanel>();
                int choices = 0;
                for (auto const& child : form.Children()) if (auto button = child.try_as<controls::Button>()) {
                    auto title = unbox_value_or<hstring>(button.Content(), L"");
                    if (title == L"I found it in Sent…" || title == L"Close without retrying…") {
                        ++choices;
                        check((button.Visibility() == xaml::Visibility::Visible) == visible && button.IsEnabled() == visible,
                            L"Delivery resolution controls do not reflect the owned uncertain draft.");
                    }
                }
                check(choices == 2, L"Both delivery resolution decisions must be available.");
            };
            reviewControls(editor, false);
            Json unresolved; put(unresolved, L"id", L"fictional-uncertain-draft"); put(unresolved, L"accountId", L"one@fixture.invalid");
            put(unresolved, L"deliveryStatus", L"unconfirmed"); put(unresolved, L"deliveryRequestId", L"fictional-resolution-request");
            put(unresolved, L"to", L"recipient@fixture.invalid"); put(unresolved, L"body", L"Fictional retained delivery text.");
            co_await compose(lifetime, unresolved);
            reviewControls(page.Content().as<controls::Grid>(), true);
            controls::StackPanel limitedReader; Json limited;
            put(limited, L"body", L"Fictional partial text"); limited.Insert(L"bodyTruncated", Value::CreateBooleanValue(true));
            appendReader(lifetime, limitedReader, limited);
            check(limitedReader.Children().Size() == 2 && std::wstring_view(limitedReader.Children().GetAt(0).as<controls::TextBlock>().Text()).find(L"truncated") != std::wstring_view::npos,
                L"Partial downloaded text must show a truncation warning.");
            co_await navigate(L"mail", L"one@fixture.invalid");
            for (auto mode : {L"reply", L"replyAll", L"savedReply"}) {
                enter(std::wstring_view(mode) == L"replyAll" ? "reply-history-reply-all" : std::wstring_view(mode) == L"savedReply" ? "reply-history-saved-reply" : "reply-history-reply");
                Json input; put(input, L"messageId", text(source, L"id")); put(input, L"mode", std::wstring_view(mode) == L"reply" ? L"reply" : L"replyAll");
                auto reply = object(co_await service->request(L"/drafts/prepare", L"one@fixture.invalid", L"POST", input), L"draft");
                if (std::wstring_view(mode) == L"savedReply") reply = object(co_await service->request(L"/drafts", L"one@fixture.invalid", L"POST", reply), L"message");
                co_await compose(lifetime, reply);
                auto layout = page.Content().as<controls::Grid>();
                auto panes = layout.Children().GetAt(layout.Children().Size() - 1).as<controls::Grid>();
                check(layout.MaxWidth() == 1180 && panes.Children().Size() == 2
                    && panes.Children().GetAt(0).try_as<controls::ScrollViewer>() && panes.Children().GetAt(1).try_as<controls::ScrollViewer>(),
                    L"Reply and saved-reply panes must scroll independently.");
                auto context = panes.Children().GetAt(1).as<controls::ScrollViewer>().Content().as<controls::StackPanel>();
                auto messages = context.Children().GetAt(2).as<controls::StackPanel>();
                check(messages.Children().Size() > 0 && messages.Children().GetAt(0).try_as<controls::StackPanel>(), L"Owned original reply history did not load.");
                auto original = messages.Children().GetAt(0).as<controls::StackPanel>();
                check(original.Children().GetAt(3).as<controls::TextBlock>().Text() == text(source, L"body"), L"Reply history displayed another mailbox's duplicate-ID body.");
                panes.Width(1100); panes.UpdateLayout();
                co_await resume_after(std::chrono::milliseconds(50)); co_await ui; panes.UpdateLayout();
                check(panes.RowDefinitions().Size() == 1 && controls::Grid::GetColumn(panes.Children().GetAt(1).as<xaml::FrameworkElement>()) == 1, L"Wide reply history must be on the right.");
                panes.Width(780); panes.UpdateLayout();
                co_await resume_after(std::chrono::milliseconds(50)); co_await ui; panes.UpdateLayout();
                check(panes.RowDefinitions().Size() == 2 && controls::Grid::GetRow(panes.Children().GetAt(1).as<xaml::FrameworkElement>()) == 1, L"Narrow reply panes must remain readable.");
                dirty.clear(); // Discard this known fictional, never-saved reply without a dialog.
                co_await navigate(L"mail", L"one@fixture.invalid");
            }
            check(text(service->clientState(),L"morrow.pendingCalendar")==pendingCalendar,L"Opening Calendar changed its immutable recovery record.");
        }
        enter("shutdown");
        auto draining = shutdown();
        check(closing && !closeReady, L"Shutdown did not wait for the private service.");
        HWND handle{}; check_hresult(window.as<::IWindowNative>()->get_WindowHandle(&handle));
        // Window.Close destroys directly; SC_CLOSE exercises the user's title-bar close request.
        SendMessageW(handle, WM_SYSCOMMAND, SC_CLOSE, 0);
        check(!closeReady && IsWindow(handle), L"A second close destroyed the window before the service drained.");
        Json result; result.Insert(L"ok", Value::CreateBooleanValue(true)); put(result, L"mode", seeded ? L"owned" : L"fresh");
        if (seeded) result.Insert(L"reader", readerEvidence);
        std::ofstream(service->directory()/L"native-smoke-result.json",std::ios::binary) << to_string(result.Stringify());
        co_await draining;
        co_return;
    } catch (hresult_error const& error) { failure=to_string(error.message()); }
    catch (...) { failure="Native acceptance failed."; }
    if (!failure.empty()) {
        Json result; result.Insert(L"ok",Value::CreateBooleanValue(false)); put(result,L"error",to_hstring(failure)); put(result,L"phase",to_hstring(phase));
        std::ofstream(service->directory()/L"native-smoke-result.json",std::ios::binary) << to_string(result.Stringify());
    }
    // Failed fixture assertions must not wait for an unsaved-edit confirmation.
    if (fixtureVerified) dirty.clear();
    co_await shutdown();
}
}
