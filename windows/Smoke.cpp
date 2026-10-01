#include "pch.h"
#include "Ui.h"
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Provider.h>
#include <fstream>
#include <cstdio>
#include <set>

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
using namespace Windows::Data::Json;
IAsyncAction nativeInteractionChecks(std::shared_ptr<Shell> shell);
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
                    for(auto const& entry:remote.MenuItems()) {auto item=entry.as<controls::NavigationViewItem>();auto tag=item.Tag().as<Json>();if(text(tag,L"section")==L"manage-folders")++managers;else if(text(tag,L"section")==L"mail"){++matches;check(text(tag,L"folder")==L"provider:Projects / A very long folder name 中文"&&item.ContextFlyout(),L"The case-insensitive folder filter or folder context actions failed.");}}
                }
            }
            check(matches==1&&managers==1&&owner==savedOwner&&folder==savedFolder&&generation==savedGeneration&&selected.Stringify()==savedSelected,L"Filtering folders changed the current mailbox or selection.");
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
            check(combined.MenuItems().Size() == 8, L"Combined mail does not expose every mailbox folder.");
            std::set<std::wstring> folders;
            for (auto const& value : combined.MenuItems()) {
                auto tag = value.as<controls::NavigationViewItem>().Tag().as<Json>();
                check(text(tag, L"owner") == L"all" && text(tag, L"section") == L"mail", L"A combined folder is routed to an individual owner.");
                folders.insert(std::wstring(text(tag, L"folder")));
            }
            check(folders == std::set<std::wstring>{L"inbox", L"starred", L"pending", L"sent", L"drafts", L"archive", L"spam", L"trash"}, L"Combined mail folder destinations are duplicated or missing.");
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
            auto peer = xaml::Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(row);
            auto invoke = peer.GetPattern(xaml::Automation::Peers::PatternInterface::Invoke).try_as<xaml::Automation::Provider::IInvokeProvider>();
            check(bool(invoke), L"The native mail row does not expose its click action.");
            invoke.Invoke();
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
            Json pending; pending.Insert(L"pending",Value::CreateBooleanValue(true)); co_await patch(source,pending);
            check(flag(selected,L"pending"), L"Pending did not update the reader.");
            auto cursorCount = cursors.size();
            Json unread; unread.Insert(L"read",Value::CreateBooleanValue(false)); co_await patch(selected,unread);
            check(!flag(selected,L"read") && cursors.size()==cursorCount, L"Manual unread reset selection or pagination.");
            auto otherRow = rows.Items().GetAt(1).as<controls::ListViewItem>().Tag().as<Json>();
            auto selectedID = text(selected,L"viewId");
            check(text(otherRow,L"viewId") != selectedID, L"Fixture rows did not have separate identities.");
            Json otherRead; otherRead.Insert(L"read",Value::CreateBooleanValue(!flag(otherRow,L"read"))); co_await patch(otherRow,otherRead);
            check(text(selected,L"viewId") == selectedID, L"A quick action on another row replaced the open reader.");
            enter("mail-unread-filter");
            unreadFilter.IsChecked(true); cursors = {L""}; co_await loadPage();
            check(rows.Items().Size() > 0, L"Unread filter lost the unread fixture message.");
            for (auto const& item : rows.Items()) check(!flag(item.as<controls::ListViewItem>().Tag().as<Json>(), L"read"), L"Unread-only view includes a read message.");
            unreadFilter.IsChecked(false); cursors = {L""}; co_await loadPage();
            enter("mail-combined");
            co_await navigate(L"mail",L"all");
            check(pageLabel.Text().size() && rows.Items().Size()==50, L"Combined mail did not load.");
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
            co_await navigate(L"mail", L"one@fixture.invalid");
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
