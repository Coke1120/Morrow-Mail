#include "pch.h"
#include "Ui.h"
#include <winrt/Windows.Globalization.h>
#include <winrt/Windows.Globalization.DateTimeFormatting.h>
#include <winrt/Windows.System.h>
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <cwchar>
#include <cwctype>

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
using namespace Windows::Data::Json;
using namespace controls;
namespace {
struct OfficePage;
using Page = std::shared_ptr<OfficePage>;
enum class Operation { Refresh, Save, Disable, Consent, Webmail };
IAsyncAction operate(Page p, Operation operation);

void require(bool condition, wchar_t const* message) {
    if (!condition) throw hresult_error(E_INVALIDARG, message);
}
Json copy(Json const& value) { return Json::Parse(value.Stringify()); }
bool checked(CheckBox const& control) { auto value = control.IsChecked(); return value && value.Value(); }
uint64_t ticks(FILETIME const& value) { return (uint64_t(value.dwHighDateTime) << 32) | value.dwLowDateTime; }
hstring isoTime(SYSTEMTIME const& value) {
    wchar_t result[32]{};
    swprintf_s(result, L"%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", unsigned(value.wYear),
        unsigned(value.wMonth), unsigned(value.wDay), unsigned(value.wHour), unsigned(value.wMinute),
        unsigned(value.wSecond), unsigned(value.wMilliseconds));
    return hstring(result);
}
bool utcTime(hstring const& value, FILETIME& file) {
    unsigned y{}, m{}, d{}, h{}, minute{}, second{}, ms{};
    if (value.size() != 24 || swscanf_s(value.c_str(), L"%4u-%2u-%2uT%2u:%2u:%2u.%3uZ",
        &y, &m, &d, &h, &minute, &second, &ms) != 7) return false;
    SYSTEMTIME utc{}, roundTrip{};
    utc.wYear = static_cast<WORD>(y); utc.wMonth = static_cast<WORD>(m); utc.wDay = static_cast<WORD>(d);
    utc.wHour = static_cast<WORD>(h); utc.wMinute = static_cast<WORD>(minute);
    utc.wSecond = static_cast<WORD>(second); utc.wMilliseconds = static_cast<WORD>(ms);
    return isoTime(utc) == value && SystemTimeToFileTime(&utc, &file)
        && FileTimeToSystemTime(&file, &roundTrip) && isoTime(roundTrip) == value;
}
hstring localSchedule(DatePicker const& date, TimePicker const& time) {
    Windows::Globalization::Calendar calendar;
    calendar.ChangeCalendarSystem(L"GregorianCalendar");
    calendar.SetDateTime(date.Date());
    auto minutes = std::chrono::duration_cast<std::chrono::minutes>(time.Time()).count();
    require(minutes >= 0 && minutes < 1440, L"Choose a valid local time.");
    SYSTEMTIME local{}, utc{}, roundTrip{};
    local.wYear = static_cast<WORD>(calendar.Year());
    local.wMonth = static_cast<WORD>(calendar.Month()); local.wDay = static_cast<WORD>(calendar.Day());
    local.wHour = static_cast<WORD>(minutes / 60); local.wMinute = static_cast<WORD>(minutes % 60);
    require(TzSpecificLocalTimeToSystemTimeEx(nullptr, &local, &utc)
        && SystemTimeToTzSpecificLocalTimeEx(nullptr, &utc, &roundTrip)
        && local.wYear == roundTrip.wYear && local.wMonth == roundTrip.wMonth
        && local.wDay == roundTrip.wDay && local.wHour == roundTrip.wHour
        && local.wMinute == roundTrip.wMinute,
        L"This local time does not exist because the clocks change. Choose another time.");
    require(utc.wYear >= 2000 && utc.wYear <= 2099, L"Choose a date between 2000 and 2099.");
    return isoTime(utc);
}
hstring dateDescription(hstring const& value) {
    if (value.empty()) return L"Not set";
    FILETIME file{};
    require(utcTime(value, file), L"Re-enter the schedule dates before saving.");
    DateTime date{TimeSpan{static_cast<int64_t>(ticks(file))}};
    Windows::Globalization::DateTimeFormatting::DateTimeFormatter formatter(L"shortdate shorttime");
    return formatter.Format(date) + L" (local time; " + value + L")";
}
bool nonblank(hstring const& value) {
    return std::any_of(value.begin(), value.end(), [](wchar_t c) { return !iswspace(c); });
}
bool validRevision(hstring const& value) {
    return value.size() == 64 && std::all_of(value.begin(), value.end(), [](wchar_t c) {
        return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f') || (c >= L'A' && c <= L'F');
    });
}
hstring expectedScope(hstring const& provider) {
    if (provider == L"google") return L"https://www.googleapis.com/auth/gmail.settings.basic";
    if (provider == L"microsoft") return L"MailboxSettings.ReadWrite";
    return {};
}
// Never launch a URL supplied by a reply template or an arbitrary provider URL.
hstring webmail(hstring const& provider, hstring const& owner) {
    if (provider == L"google") return L"https://mail.google.com/mail/u/0/#settings/general";
    if (provider == L"microsoft") return L"https://outlook.live.com/mail/0/options/mail/automaticReplies";
    std::wstring address(owner);
    std::transform(address.begin(), address.end(), address.begin(), [](wchar_t c) {
        return c >= L'A' && c <= L'Z' ? static_cast<wchar_t>(c + L'a' - L'A') : c;
    });
    auto at = address.rfind(L'@');
    auto domain = at == std::wstring::npos ? std::wstring() : address.substr(at + 1);
    if (domain == L"yahoo.com.hk" || domain == L"yahoo.com" || domain == L"ymail.com" || domain == L"rocketmail.com")
        return L"https://mail.yahoo.com/";
    return {};
}

struct ScheduleInput {
    CheckBox enabled{nullptr};
    DatePicker date{nullptr};
    TimePicker time{nullptr};
    TextBlock errorLabel{nullptr};
    hstring error;
    bool touched = false;
};
struct OfficePage {
    std::shared_ptr<Shell> shell;
    hstring owner;
    uint64_t generation{};
    bool live = true, busy = false, restoring = false, needsRefresh = false;
    Json value, options, saved;
    std::wstring dirtyKey, busyKey;
    StackPanel body{nullptr}, form{nullptr}, schedule{nullptr};
    ContentControl formContainer{nullptr};
    TextBlock notice{nullptr};
    Button refresh{nullptr}, save{nullptr}, disable{nullptr}, consent{nullptr}, providerLink{nullptr};
    ScheduleInput start, end;
    bool current() const { return live && shell->current(generation, owner); }
    bool connected() const {
        return current() && !owner.empty() && owner != L"all" && owner != L"demo" && shell->connected(owner);
    }
    bool changed() const {
        return options.Stringify() != saved.Stringify()
            || (start.touched && !start.error.empty()) || (end.touched && !end.error.empty());
    }
    void tell(hstring const& message) { if (current() && notice) notice.Text(message); }
    void edit() {
        if (!current() || restoring) return;
        if (changed()) shell->dirty.insert(dirtyKey); else shell->dirty.erase(dirtyKey);
        update();
    }
    void update() {
        if (!current()) return;
        bool writable = connected() && !busy && !needsRefresh && flag(value, L"canWrite");
        if (formContainer) formContainer.IsEnabled(writable);
        if (refresh) refresh.IsEnabled(connected() && !busy);
        if (save) {
            save.IsEnabled(writable);
            save.Content(box_value(text(options, L"mode") == L"disabled" ? L"Save disabled settings…" : L"Save and enable…"));
        }
        if (disable) disable.IsEnabled(writable && text(saved, L"mode") != L"disabled");
        if (consent) consent.IsEnabled(connected() && !busy);
        if (providerLink) providerLink.IsEnabled(connected() && !busy);
        if (schedule) schedule.Visibility(text(options, L"mode") == L"scheduled" ? xaml::Visibility::Visible : xaml::Visibility::Collapsed);
        for (auto input : { &start, &end }) if (input->enabled) {
            input->date.IsEnabled(checked(input->enabled)); input->time.IsEnabled(checked(input->enabled));
            input->errorLabel.Text(input->error);
        }
    }
    void clearForm() {
        restoring = true;
        if (body) body.Children().Clear();
        value = Json(); options = Json(); saved = Json();
        if (formContainer) formContainer.Content(nullptr);
        start = {}; end = {}; form = nullptr; formContainer = nullptr; schedule = nullptr;
        save = nullptr; disable = nullptr; consent = nullptr; providerLink = nullptr;
        restoring = false;
    }
    void dispose() {
        if (!live) return;
        live = false; shell->dirty.erase(dirtyKey);
        // No templates, revisions, or form values are saved in client-state.
        // A pending request owns its busy marker until it settles.
        clearForm(); body = nullptr; notice = nullptr; refresh = nullptr;
    }
};

void appendAction(Page const& p, StackPanel const& into, hstring const& caption, Operation operation, Button& target) {
    std::weak_ptr<OfficePage> weak = p;
    target = button(caption, [weak, operation] { if (auto page = weak.lock()) operate(page, operation); });
    into.Children().Append(target);
}
void input(Page const& p, wchar_t const* key, hstring const& caption, int limit, bool multiline = false) {
    auto control = field(caption, text(p->options, key), multiline);
    control.MaxLength(limit);
    std::weak_ptr<OfficePage> weak = p;
    control.TextChanged([weak, key = std::wstring(key)](auto const& sender, auto const&) {
        if (auto page = weak.lock(); page && page->connected() && !page->busy && !page->restoring) {
            put(page->options, key.c_str(), sender.template as<TextBox>().Text()); page->edit();
        }
    });
    p->form.Children().Append(control);
}
void choice(Page const& p, wchar_t const* key, hstring const& caption,
    std::initializer_list<std::pair<wchar_t const*, wchar_t const*>> entries) {
    ComboBox control; control.Header(box_value(caption)); control.HorizontalAlignment(xaml::HorizontalAlignment::Stretch);
    for (auto const& [id, name] : entries) {
        ComboBoxItem item; item.Content(box_value(hstring(name))); item.Tag(box_value(hstring(id)));
        control.Items().Append(item);
        if (text(p->options, key) == id) control.SelectedItem(item);
    }
    std::weak_ptr<OfficePage> weak = p;
    control.SelectionChanged([weak, key = std::wstring(key)](auto const& sender, auto const&) {
        if (auto page = weak.lock(); page && page->connected() && !page->busy && !page->restoring) {
            auto selected = sender.template as<ComboBox>().SelectedItem().template try_as<ComboBoxItem>();
            if (selected) { put(page->options, key.c_str(), unbox_value<hstring>(selected.Tag())); page->edit(); }
        }
    });
    p->form.Children().Append(control);
}
void editDate(Page const& p, bool isStart) {
    if (!p->connected() || p->busy || p->restoring) return;
    auto& input = isStart ? p->start : p->end;
    auto key = isStart ? L"start" : L"end";
    input.touched = true; input.error = L"";
    try { put(p->options, key, checked(input.enabled) ? localSchedule(input.date, input.time) : L""); }
    catch (hresult_error const& error) { input.error = error.message(); }
    catch (...) { input.error = L"Choose a valid local date and time."; }
    p->edit();
}
void dateInput(Page const& p, bool isStart) {
    auto& input = isStart ? p->start : p->end;
    auto key = isStart ? L"start" : L"end";
    auto caption = isStart ? L"Start" : L"End";
    input.enabled = CheckBox(); input.enabled.Content(box_value(isStart ? L"Set a start date" : L"Set an end date"));
    input.enabled.IsChecked(!text(p->options, key).empty());
    input.date = DatePicker(); input.date.Header(box_value(hstring(caption) + L" date (local)"));
    input.date.CalendarIdentifier(L"GregorianCalendar");
    input.time = TimePicker(); input.time.Header(box_value(hstring(caption) + L" time (local)"));
    input.time.MinuteIncrement(1); input.time.Time(std::chrono::hours(9));
    input.errorLabel = label(L"");
    Windows::Globalization::Calendar calendar;
    calendar.ChangeCalendarSystem(L"GregorianCalendar");
    input.date.Date(calendar.GetDateTime());
    auto original = text(p->options, key);
    if (!original.empty()) {
        FILETIME file{};
        if (utcTime(original, file)) {
            DateTime date{TimeSpan{static_cast<int64_t>(ticks(file))}};
            SYSTEMTIME utc{}, local{};
            // Use this instant's historical DST rule, not today's UTC offset.
            if (FileTimeToSystemTime(&file, &utc) && utc.wYear >= 2000 && utc.wYear <= 2099
                && SystemTimeToTzSpecificLocalTimeEx(nullptr, &utc, &local)) {
                input.date.Date(date);
                input.time.Time(std::chrono::minutes(int64_t(local.wHour) * 60 + local.wMinute));
            } else input.error = L"Re-enter this date in your device’s local timezone before saving.";
        } else input.error = L"Re-enter this date in your device’s local timezone before saving.";
    }
    std::weak_ptr<OfficePage> weak = p;
    input.enabled.Click([weak, isStart](auto const&, auto const&) { if (auto page = weak.lock()) editDate(page, isStart); });
    input.date.DateChanged([weak, isStart](auto const&, auto const&) { if (auto page = weak.lock()) editDate(page, isStart); });
    input.time.TimeChanged([weak, isStart](auto const&, auto const&) { if (auto page = weak.lock()) editDate(page, isStart); });
    auto panel = stack();
    panel.Children().Append(input.enabled); panel.Children().Append(input.date);
    panel.Children().Append(input.time); panel.Children().Append(input.errorLabel);
    p->schedule.Children().Append(panel);
}

void accept(Page const& p, Json const& result) {
    require(text(result, L"accountId") == p->owner, L"The provider settings belong to a different mailbox. Refresh settings.");
    auto provider = text(result, L"provider");
    if (flag(result, L"supported")) require(!expectedScope(provider).empty()
        && text(result, L"requiredScope") == expectedScope(provider), L"This provider is not supported for automatic replies.");
    auto settings = result.TryLookup(L"settings");
    bool hasSettings = settings && settings.ValueType() == JsonValueType::Object;
    // Capability-only responses omit settings; JSON null is also absence, not a form.
    require(!settings || settings.ValueType() == JsonValueType::Null || hasSettings,
        L"The service returned invalid automatic reply settings. Refresh settings.");
    if (hasSettings) {
        require(flag(result, L"supported") && flag(result, L"canRead")
            && validRevision(text(result, L"revision")),
            L"The service returned incomplete automatic reply settings. Refresh settings.");
        auto value = settings.GetObject();
        for (auto key : { L"mode", L"start", L"end", L"subject", L"message", L"externalMessage", L"audience" }) {
            auto item = value.TryLookup(key);
            require(item && item.ValueType() == JsonValueType::String, L"The service returned incomplete automatic reply settings.");
        }
        auto domain = value.TryLookup(L"restrictToDomain");
        require(domain && domain.ValueType() == JsonValueType::Boolean, L"The service returned incomplete automatic reply settings.");
    }
    p->clearForm(); p->restoring = true;
    p->value = copy(result); p->options = hasSettings ? copy(settings.GetObject()) : Json(); p->saved = copy(p->options);
    p->needsRefresh = false; p->shell->dirty.erase(p->dirtyKey);
    if (!flag(result, L"supported")) p->body.Children().Append(label(
        L"IMAP does not provide automatic reply settings. Use your provider’s webmail settings. Morrow will not send local automatic replies."));
    if (flag(result, L"requiresReconnect")) {
        p->body.Children().Append(label(L"Allow the separate Out of Office permission to read and change automatic replies. Your existing mail connection is retained. After browser sign-in, return here and refresh provider settings."));
        p->body.Children().Append(label(L"Requested permission: " + expectedScope(provider)));
        appendAction(p, p->body, L"Allow Out of Office settings…", Operation::Consent, p->consent);
    }
    if (!webmail(provider, p->owner).empty()) appendAction(p, p->body, L"Open provider webmail settings", Operation::Webmail, p->providerLink);
    if (hasSettings) {
        p->form = stack(12); p->formContainer = ContentControl();
        p->formContainer.HorizontalContentAlignment(xaml::HorizontalAlignment::Stretch);
        p->formContainer.IsTabStop(false); p->formContainer.Content(p->form);
        p->body.Children().Append(p->formContainer);
        choice(p, L"mode", L"Automatic replies", {{L"disabled", L"Disabled"}, {L"always", L"Always enabled"}, {L"scheduled", L"Scheduled"}});
        p->schedule = stack(12); p->form.Children().Append(p->schedule);
        p->schedule.Children().Append(label(L"Dates use your device’s local timezone. " + hstring(provider == L"google"
            ? L"Set at least one date; either end can be left open." : L"Both start and end are required.")));
        p->schedule.Children().Append(label(L"Review includes the exact UTC times. If clocks move back, an edited repeated time uses the Windows-selected occurrence; unchanged provider dates retain their original instant."));
        dateInput(p, true); dateInput(p, false);
        if (!text(result, L"scheduleWarning").empty()) p->form.Children().Append(label(text(result, L"scheduleWarning")));
        bool google = provider == L"google";
        if (google) input(p, L"subject", L"Subject prefix", 200);
        input(p, L"message", google ? L"Reply message" : L"Reply within your organization", 10000, true);
        if (google) choice(p, L"audience", L"Reply audience", {{L"contacts", L"Contacts only"}, {L"all", L"All senders"}});
        else {
            choice(p, L"audience", L"Outside your organization", {{L"none", L"No external replies"}, {L"contacts", L"Contacts only"}, {L"all", L"All senders"}});
            input(p, L"externalMessage", L"External reply message", 10000, true);
        }
        if (google) {
            CheckBox domain; domain.Content(box_value(L"Only my Google Workspace domain (Workspace accounts only)"));
            domain.IsChecked(flag(p->options, L"restrictToDomain"));
            std::weak_ptr<OfficePage> weak = p;
            domain.Click([weak](auto const& sender, auto const&) {
                if (auto page = weak.lock(); page && page->connected() && !page->busy && !page->restoring) {
                    page->options.Insert(L"restrictToDomain", Value::CreateBooleanValue(checked(sender.template as<CheckBox>()))); page->edit();
                }
            });
            p->form.Children().Append(domain);
        }
        p->form.Children().Append(label(L"Plain text only. Save replaces existing rich formatting. Disable retains the provider’s existing templates. No changes take effect until you review and confirm."));
        // Disable stays separate from schedule validation and retains the saved templates.
        appendAction(p, p->body, L"Save and enable…", Operation::Save, p->save);
        appendAction(p, p->body, L"Disable automatic replies…", Operation::Disable, p->disable);
    }
    p->restoring = false; p->update();
}

Json savePayload(Page const& p) {
    Json payload;
    for (auto key : { L"mode", L"start", L"end", L"subject", L"message", L"externalMessage", L"audience" })
        put(payload, key, text(p->options, key));
    payload.Insert(L"restrictToDomain", Value::CreateBooleanValue(flag(p->options, L"restrictToDomain")));
    auto mode = text(payload, L"mode"), audience = text(payload, L"audience");
    bool google = text(p->value, L"provider") == L"google";
    require(mode == L"disabled" || mode == L"always" || mode == L"scheduled", L"Choose an automatic reply mode.");
    require(audience == L"all" || audience == L"contacts" || (!google && audience == L"none"), L"Choose a reply audience.");
    require(text(payload, L"subject").size() <= 200 && text(payload, L"message").size() <= 10000
        && text(payload, L"externalMessage").size() <= 10000, L"The subject or reply text is too long.");
    auto subject = text(payload, L"subject");
    require(std::find(subject.begin(), subject.end(), L'\n') == subject.end()
        && std::find(subject.begin(), subject.end(), L'\r') == subject.end(), L"Enter a single-line subject.");
    if (mode == L"scheduled") {
        require(p->start.error.empty() && p->end.error.empty(), L"Correct the schedule dates before saving.");
        auto start = text(payload, L"start"), end = text(payload, L"end");
        require((google && (!start.empty() || !end.empty())) || (!google && !start.empty() && !end.empty()),
            L"Enter the automatic reply schedule. Outlook requires both start and end.");
        FILETIME first{}, last{}, now{};
        if (!start.empty()) require(utcTime(start, first) && start[0] == L'2' && start[1] == L'0', L"Re-enter a valid start date between 2000 and 2099.");
        if (!end.empty()) {
            require(utcTime(end, last) && end[0] == L'2' && end[1] == L'0', L"Re-enter a valid end date between 2000 and 2099.");
            GetSystemTimeAsFileTime(&now);
            require(ticks(last) > ticks(now), L"Choose an end date in the future.");
        }
        if (!start.empty() && !end.empty()) require(ticks(first) < ticks(last), L"The end must be after the start.");
    }
    if (mode != L"disabled") require(nonblank(text(payload, L"message"))
        && (google || audience == L"none" || nonblank(text(payload, L"externalMessage"))), L"Enter a reply message for each enabled audience.");
    return payload;
}
hstring review(Page const& p, Json const& payload, bool disable) {
    hstring detail = L"Mailbox: " + p->owner + L"\nProvider: " + text(p->value, L"provider");
    if (disable) return detail + L"\n\nThe provider will stop automatic replies and retain its existing templates."
        + hstring(p->changed() ? L" Unsaved edits in this form will be discarded." : L"") + L"\n\nNo mail is sent by this button.";
    auto mode = text(payload, L"mode");
    detail = detail + L"\nMode: " + mode + L"\nAudience: " + text(payload, L"audience");
    if (mode == L"scheduled") detail = detail + L"\nStart: " + dateDescription(text(payload, L"start")) + L"\nEnd: " + dateDescription(text(payload, L"end"));
    if (text(p->value, L"provider") == L"google") detail = detail + L"\nWorkspace domain only: "
        + hstring(flag(payload, L"restrictToDomain") ? L"Yes" : L"No") + L"\nSubject prefix: " + text(payload, L"subject")
        + L"\n\nReply message:\n" + text(payload, L"message");
    else detail = detail + L"\n\nReply within your organization:\n" + text(payload, L"message")
        + L"\n\nExternal reply message" + hstring(text(payload, L"audience") == L"none" ? L" (stored, not sent)" : L"") + L":\n" + text(payload, L"externalMessage");
    return detail + L"\n\nThe provider will store these plain-text replies, replacing rich formatting. Enabled replies continue while Morrow is closed. No mail is sent by this button.";
}
IAsyncAction authorize(Page p) {
    auto provider = text(p->value, L"provider");
    auto scope = expectedScope(provider);
    require(!scope.empty() && flag(p->value, L"supported") && flag(p->value, L"requiresReconnect"), L"This mailbox cannot request this permission.");
    if (!(co_await p->shell->confirm(L"Allow Out of Office settings?", L"Mailbox: " + p->owner + L"\n\nThe browser will request " + scope
        + L". This permission lets Morrow read and change provider automatic reply settings. Enabling replies still requires a separate Save confirmation."
        + L"\n\nReturn here after sign-in and refresh provider settings.", L"Open sign-in"))) co_return;
    if (!p->connected()) co_return;
    Json body; body.Insert(L"outOfOffice", Value::CreateBooleanValue(true)); put(body, L"forAccount", p->owner);
    auto result = co_await p->shell->service->request(L"/oauth/" + provider + L"/start", p->owner, L"POST", body);
    if (!p->connected()) co_return;
    Uri url(text(result, L"url")), local(p->shell->service->origin());
    auto query = url.QueryParsed();
    require(url.SchemeName() == L"http" && url.Host() == L"localhost" && url.Port() == local.Port()
        && url.Path() == L"/api/oauth/" + provider + L"/authorize"
        && url.UserName().empty() && url.Password().empty() && url.Fragment().empty()
        && query.Size() == 1 && query.GetAt(0).Name() == L"state"
        && !query.GetAt(0).Value().empty() && query.GetAt(0).Value().size() <= 200,
        L"The sign-in URL is invalid. Start sign-in again.");
    require(co_await Windows::System::Launcher::LaunchUriAsync(url), L"Windows could not open your browser.");
    p->tell(L"Complete sign-in in your browser, then return here and refresh provider settings. No automatic replies have been changed.");
}
IAsyncAction perform(Page p, Operation operation) {
    if (operation == Operation::Refresh) {
        if (p->changed() && !(co_await p->shell->confirm(L"Discard unsaved automatic reply edits?",
            L"Refresh reads this mailbox’s provider settings and replaces the unsaved form. No provider settings will be changed.", L"Discard and refresh"))) co_return;
        if (!p->connected()) co_return;
        auto result = co_await p->shell->service->request(L"/out-of-office", p->owner);
        if (p->connected()) { accept(p, result); p->tell(L"Provider settings refreshed."); }
        co_return;
    }
    if (operation == Operation::Consent) { co_await authorize(p); co_return; }
    if (operation == Operation::Webmail) {
        auto url = webmail(text(p->value, L"provider"), p->owner);
        require(!url.empty(), L"Open your provider’s webmail and find its automatic reply settings.");
        if (!(co_await p->shell->confirm(L"Open provider settings?", L"Open " + url + L" in your browser. Check that you are signed in as "
            + p->owner + L" before changing settings. Unsaved Morrow edits stay here.", L"Open browser"))) co_return;
        if (p->connected()) require(co_await Windows::System::Launcher::LaunchUriAsync(Uri(url)), L"Windows could not open your browser.");
        co_return;
    }
    require(flag(p->value, L"canWrite") && !p->needsRefresh && validRevision(text(p->value, L"revision")), L"Refresh provider settings and confirm permission before saving.");
    bool disable = operation == Operation::Disable;
    Json payload = disable ? Json() : savePayload(p);
    put(payload, L"action", disable ? L"disable" : L"save");
    put(payload, L"revision", text(p->value, L"revision"));
    payload.Insert(L"confirmed", Value::CreateBooleanValue(true));
    auto title = disable ? L"Disable automatic replies?" : text(payload, L"mode") == L"disabled" ? L"Save disabled settings?" : L"Save and enable automatic replies?";
    if (!(co_await p->shell->confirm(title, review(p, payload, disable), disable ? L"Disable" : L"Save"))) co_return;
    if (!p->connected()) co_return;
    // A failed/uncertain write must be followed by GET and fresh review, never replay.
    p->needsRefresh = true;
    p->tell(L"Saving provider settings…");
    auto result = co_await p->shell->service->request(L"/out-of-office", p->owner, L"PUT", payload);
    if (p->connected()) {
        accept(p, result);
        p->tell(disable ? L"Automatic replies disabled. Provider templates were retained." : L"Automatic reply settings saved by the provider.");
    }
}
IAsyncAction operate(Page p, Operation operation) {
    if (!p->connected() || p->busy || p->shell->dialogOpen) co_return;
    p->busy = true; p->shell->dirty.insert(p->busyKey); p->shell->navigation.IsEnabled(false); p->update();
    p->tell(operation == Operation::Refresh ? L"Reading provider settings…" : L"");
    try { co_await perform(p, operation); }
    catch (hresult_error const& error) {
        p->tell(error.message() + hstring(p->needsRefresh ? L" Refresh provider settings before another change; Morrow will not retry automatically." : L""));
    }
    catch (...) { p->tell(L"The operation could not be confirmed. Refresh provider settings before trying again. No request is retried automatically."); }
    p->busy = false; p->shell->dirty.erase(p->busyKey);
    if (!p->shell->closing) p->shell->navigation.IsEnabled(true);
    p->update();
}
}

IAsyncAction outOfOfficePage(std::shared_ptr<Shell> shell) {
    auto p = std::make_shared<OfficePage>();
    p->shell = shell; p->owner = shell->owner; p->generation = ++shell->generation;
    p->dirtyKey = L"out-of-office:" + std::to_wstring(p->generation);
    p->busyKey = L"out-of-office-request:" + std::to_wstring(p->generation);
    auto root = stack(16); root.Padding(xaml::Thickness{24, 20, 24, 32}); root.MaxWidth(900);
    root.HorizontalAlignment(xaml::HorizontalAlignment::Left);
    root.Children().Append(label(L"Out of Office", 26));
    root.Children().Append(label(L"Server-managed automatic replies continue while Morrow is closed. Your provider controls delivery and how often each sender receives a reply."));
    p->notice = label(L"");
    xaml::Automation::AutomationProperties::SetLiveSetting(p->notice, xaml::Automation::Peers::AutomationLiveSetting::Polite);
    p->body = stack(16);
    if (p->connected()) {
        root.Children().Append(label(p->owner, 18));
        appendAction(p, root, L"Refresh provider settings", Operation::Refresh, p->refresh);
    } else root.Children().Append(label(L"Choose an individual connected mailbox. Automatic replies are not available in All accounts or for disconnected accounts."));
    root.Children().Append(p->notice); root.Children().Append(p->body);
    root.Unloaded([p](auto const&, auto const&) { p->dispose(); });
    shell->show(scroll(root));
    if (p->connected()) co_await operate(p, Operation::Refresh);
    co_return;
}
}
