#include "pch.h"
#include "Ui.h"
#include <fstream>
#include <cstdio>
#include <set>

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
using namespace Windows::Data::Json;
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
            apartment_context ui;
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
            enter("mail-patches");
            Json pending; pending.Insert(L"pending",Value::CreateBooleanValue(true)); co_await patch(source,pending);
            check(flag(selected,L"pending"), L"Pending did not update the reader.");
            auto cursorCount = cursors.size();
            Json unread; unread.Insert(L"read",Value::CreateBooleanValue(false)); co_await patch(selected,unread);
            check(!flag(selected,L"read") && cursors.size()==cursorCount, L"Manual unread reset selection or pagination.");
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
            for (auto const* tab : {L"general", L"mail", L"calendar", L"model", L"search", L"policy", L"about"}) {
                enter("settings-" + to_string(tab));
                auto previousPage = page.Content();
                co_await settingsPage(lifetime, tab);
                check(page.Content() && page.Content() != previousPage, L"A native Settings tab failed to open.");
                check(dirty.empty(), L"Opening a Settings tab incorrectly created unsaved edits.");
            }
            check(text(service->clientState(),L"morrow.pendingCalendar")==pendingCalendar,L"Opening Calendar changed its immutable recovery record.");
            enter("reader-isolation");
            readerEvidence = co_await readerRuntimeChecks(lifetime);
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
