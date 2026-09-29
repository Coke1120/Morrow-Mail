#include "pch.h"
#include "Ui.h"
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
        auto directory = service->directory();
        check(std::filesystem::canonical(directory.parent_path()) == std::filesystem::canonical(std::filesystem::temp_directory_path()) && directory.filename().wstring().starts_with(L"morrow-native-check-"), L"Native acceptance requires an isolated temporary workspace.");
        std::ifstream marker(directory / L"disposable-native-fixture");
        std::string value((std::istreambuf_iterator<char>(marker)), {});
        check(value == "Morrow native acceptance fixture", L"Native acceptance fixture marker is missing.");
        fixtureVerified = true;
        bool seeded = array(state,L"accounts").Size() > 0;
        enter("macos-layout-parity");
        auto themes = xaml::Application::Current().Resources().ThemeDictionaries();
        for (auto name : {L"Light", L"Default"}) {
            auto palette = themes.Lookup(box_value(name)).as<xaml::ResourceDictionary>();
            auto color = unbox_value<Windows::UI::Color>(palette.Lookup(box_value(L"SystemAccentColor")));
            check(name == std::wstring_view(L"Light") ? color == Windows::UI::Color{255, 26, 74, 61} : color == Windows::UI::Color{255, 166, 212, 176}, L"Windows lost the shared Morrow light/dark accent.");
        }
        check(themes.Lookup(box_value(L"HighContrast")).as<xaml::ResourceDictionary>().Size() == 0, L"Brand colours override the system high-contrast palette.");
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
            check(owner.empty() && section == L"settings", L"Fresh startup did not open Add account Settings.");
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
        enter("interaction-guards");
        co_await nativeInteractionChecks(lifetime);
        if (!seeded) {
            enter("fresh-settings");
            check(owner.empty(), L"Fresh onboarding selected the internal Demo mailbox.");
            co_await navigate(L"settings");
            check(page.Content() != nullptr, L"Add account UI did not load.");
        } else {
            enter("window-size");
            check(array(state,L"accounts").Size() == 2, L"Expected two isolated fixture owners.");
            auto restoredSize = window.AppWindow().Size();
            auto resizeDeadline = GetTickCount64() + 1000;
            while ((restoredSize.Width != 1040 || restoredSize.Height != 760) && GetTickCount64() < resizeDeadline) {
                co_await resume_after(std::chrono::milliseconds(10));
                co_await ui;
                restoredSize = window.AppWindow().Size();
            }
            if (restoredSize.Width != 1040 || restoredSize.Height != 760) {
                auto detail = L"The previous host window size was not restored: expected 1040x760, got " + to_hstring(restoredSize.Width) + L"x" + to_hstring(restoredSize.Height)
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
            enter("mail-unread-filter");
            unreadFilter.IsChecked(true); cursors = {L""}; co_await loadPage();
            check(rows.Items().Size() > 0, L"Unread filter lost the unread fixture message.");
            for (auto const& item : rows.Items()) check(!flag(item.as<controls::ListViewItem>().Tag().as<Json>(), L"read"), L"Unread-only view includes a read message.");
            unreadFilter.IsChecked(false); cursors = {L""}; co_await loadPage();
            enter("mail-combined");
            co_await navigate(L"mail",L"all");
            check(pageLabel.Text().size() && rows.Items().Size()==50, L"Combined mail did not load.");
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
            }
            for (auto const* tab : {L"start", L"general", L"mail", L"calendar", L"model", L"search", L"policy", L"about"}) {
                enter("settings-" + to_string(tab));
                auto previousPage = page.Content();
                co_await settingsPage(lifetime, tab);
                check(page.Content() && page.Content() != previousPage, L"A native Settings tab failed to open.");
                auto layout = page.Content().try_as<controls::Grid>();
                check(layout && layout.ColumnDefinitions().Size() == 2 && layout.RowDefinitions().Size() == 3, L"Settings lost its fixed category sidebar and independently scrolling content.");
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
