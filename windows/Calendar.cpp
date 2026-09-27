#include "pch.h"
#include "Ui.h"
#include <winrt/Windows.Globalization.h>
#include <winrt/Windows.Globalization.DateTimeFormatting.h>
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <cmath>
#include <cwchar>
#include <map>
#include <optional>
#include <regex>

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
using namespace Windows::Data::Json;
using namespace controls;
namespace {
using Day = std::chrono::sys_days;
constexpr wchar_t pendingKey[] = L"morrow.pendingCalendar";
constexpr wchar_t choicesKey[] = L"morrow.calendar.checked";
constexpr int64_t ticksPerDay = 864000000000LL;
void require(bool condition, wchar_t const* message) { if (!condition) throw hresult_error(E_INVALIDARG, message); }
bool provider(hstring const& value) { return value == L"google" || value == L"microsoft"; }
hstring providerName(hstring const& value) { return value == L"google" ? L"Google Calendar" : L"Outlook Calendar"; }
Json copy(Json const& value) { return Json::Parse(value.Stringify()); }
Array requiredArray(Json const& value, wchar_t const* key, uint32_t maximum = 1000) {
    auto item = value.TryLookup(key);
    require(item && item.ValueType() == JsonValueType::Array && item.GetArray().Size() <= maximum, L"The calendar service returned an invalid or oversized list.");
    return item.GetArray();
}
hstring trim(hstring const& value) {
    std::wstring result(value); auto first = result.find_first_not_of(L" \r\n\t");
    return first == std::wstring::npos ? hstring{} : hstring(result.substr(first, result.find_last_not_of(L" \r\n\t") - first + 1));
}
void validText(hstring const& value, size_t maximum, bool optional = false, bool multiline = false) {
    require(value.size() <= maximum && (optional || !trim(value).empty()), L"An event field is empty or exceeds its supported length.");
    for (auto c : value) require(c >= 32 || (multiline && (c == L'\n' || c == L'\r' || c == L'\t')), L"Event details contain unsupported control characters.");
    require(std::wstring_view(value).find(wchar_t(127)) == std::wstring_view::npos, L"Event details contain unsupported control characters.");
}
// Match JSON.stringify([provider, id]) keys, including JSON.stringify's string escaping.
hstring calendarKey(hstring const& p, hstring const& id) {
    std::wstring quoted = L"[\"" + std::wstring(p) + L"\",\"";
    for (size_t i = 0; i < id.size(); ++i) {
        wchar_t c = id[i];
        if (c == L'"' || c == L'\\') { quoted += L'\\'; quoted += c; }
        else if (c == L'\b') quoted += L"\\b";
        else if (c == L'\f') quoted += L"\\f";
        else if (c == L'\n') quoted += L"\\n";
        else if (c == L'\r') quoted += L"\\r";
        else if (c == L'\t') quoted += L"\\t";
        else if (c < 32 || (c >= 0xd800 && c <= 0xdfff && !((c <= 0xdbff && i + 1 < id.size() && id[i + 1] >= 0xdc00 && id[i + 1] <= 0xdfff) || (c >= 0xdc00 && i > 0 && id[i - 1] >= 0xd800 && id[i - 1] <= 0xdbff)))) {
            wchar_t escaped[7]{}; swprintf_s(escaped, L"\\u%04x", unsigned(c)); quoted += escaped;
        } else quoted += c;
    }
    return hstring(quoted + L"\"]");
}
Day civil(int year, unsigned month, unsigned day) {
    std::chrono::year_month_day value{std::chrono::year{year}, std::chrono::month{month}, std::chrono::day{day}};
    require(year >= 1900 && year <= 9999 && value.ok(), L"Choose a valid calendar date from 1900 to 9999.");
    return Day{value};
}
Day civil(hstring const& value) {
    require(value.size() == 10 && value[4] == L'-' && value[7] == L'-', L"The calendar returned an invalid civil date.");
    unsigned parts[3]{}; size_t part = 0;
    for (size_t i = 0; i < value.size(); ++i) {
        if (i == 4 || i == 7) { ++part; continue; }
        require(value[i] >= L'0' && value[i] <= L'9', L"The calendar returned an invalid date.");
        parts[part] = parts[part] * 10 + value[i] - L'0';
    }
    return civil(static_cast<int>(parts[0]), parts[1], parts[2]);
}
SYSTEMTIME systemDay(Day day, unsigned hour = 0, unsigned minute = 0) {
    std::chrono::year_month_day ymd{day}; SYSTEMTIME result{};
    result.wYear = static_cast<WORD>(int(ymd.year())); result.wMonth = static_cast<WORD>(unsigned(ymd.month()));
    result.wDay = static_cast<WORD>(unsigned(ymd.day())); result.wHour = static_cast<WORD>(hour); result.wMinute = static_cast<WORD>(minute);
    return result;
}
int64_t instant(SYSTEMTIME const& utc) {
    FILETIME value{}; require(SystemTimeToFileTime(&utc, &value), L"The calendar date could not be converted.");
    return static_cast<int64_t>((uint64_t(value.dwHighDateTime) << 32) | value.dwLowDateTime);
}
SYSTEMTIME systemInstant(int64_t ticks) {
    FILETIME value{static_cast<DWORD>(ticks), static_cast<DWORD>(uint64_t(ticks) >> 32)}; SYSTEMTIME result{};
    require(FileTimeToSystemTime(&value, &result), L"The calendar timestamp is invalid."); return result;
}
hstring utcText(int64_t ticks) {
    auto utc = systemInstant(ticks); wchar_t value[32]{};
    swprintf_s(value, L"%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", unsigned(utc.wYear), unsigned(utc.wMonth), unsigned(utc.wDay), unsigned(utc.wHour), unsigned(utc.wMinute), unsigned(utc.wSecond), unsigned(utc.wMilliseconds));
    return value;
}
int64_t parseInstant(hstring const& value) {
    static std::wregex const pattern(LR"(^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?(Z|[+-]\d{2}:\d{2})$)");
    std::wstring input(value); std::wsmatch parts;
    require(input.size() <= 40 && std::regex_match(input, parts, pattern), L"The calendar returned an invalid timestamp or time zone.");
    auto day = civil(hstring(parts[1].str()));
    auto hour = std::stoi(parts[2]), minute = std::stoi(parts[3]), second = parts[4].matched ? std::stoi(parts[4]) : 0;
    require(hour < 24 && minute < 60 && second < 60, L"The calendar returned an invalid time.");
    auto stamp = systemDay(day, hour, minute); stamp.wSecond = static_cast<WORD>(second);
    int64_t result = instant(stamp);
    if (parts[5].matched) { auto fraction = parts[5].str(); fraction.append(7 - fraction.size(), L'0'); result += std::stoll(fraction); }
    auto zone = parts[6].str();
    if (zone != L"Z") {
        int hours = std::stoi(zone.substr(1, 2)), minutes = std::stoi(zone.substr(4, 2));
        require(hours <= 14 && minutes < 60 && (hours != 14 || minutes == 0), L"The calendar returned an invalid UTC offset.");
        result -= (zone[0] == L'+' ? 1LL : -1LL) * (hours * 60LL + minutes) * 600000000LL;
    }
    systemInstant(result); return result;
}
int64_t localInstant(SYSTEMTIME const& local) {
    SYSTEMTIME utc{}, roundTrip{};
    require(TzSpecificLocalTimeToSystemTimeEx(nullptr, &local, &utc) && SystemTimeToTzSpecificLocalTimeEx(nullptr, &utc, &roundTrip)
        && local.wYear == roundTrip.wYear && local.wMonth == roundTrip.wMonth && local.wDay == roundTrip.wDay
        && local.wHour == roundTrip.wHour && local.wMinute == roundTrip.wMinute && local.wSecond == roundTrip.wSecond,
        L"This local time does not exist because the clocks change. Choose another time.");
    return instant(utc);
}
SYSTEMTIME localSystem(int64_t ticks) {
    auto utc = systemInstant(ticks); SYSTEMTIME local{};
    require(SystemTimeToTzSpecificLocalTimeEx(nullptr, &utc, &local), L"The local calendar time could not be read."); return local;
}
hstring dayText(Day day) {
    auto value = systemDay(day); wchar_t result[16]{};
    swprintf_s(result, L"%04u-%02u-%02u", unsigned(value.wYear), unsigned(value.wMonth), unsigned(value.wDay)); return result;
}
Day today() { SYSTEMTIME value{}; GetLocalTime(&value); return civil(value.wYear, value.wMonth, value.wDay); }
Day firstOfMonth(Day day) { auto value = systemDay(day); return civil(value.wYear, value.wMonth, 1); }
Day gridStart(Day month) { return month - std::chrono::days{std::chrono::weekday{month}.c_encoding()}; }
hstring localLabel(hstring const& value) {
    Windows::Globalization::DateTimeFormatting::DateTimeFormatter formatter(L"shortdate shorttime");
    return formatter.Format(DateTime{TimeSpan{parseInstant(value)}}) + L" (" + value + L")";
}
hstring zoneLabel() { Windows::Globalization::Calendar value; return value.GetTimeZone(); }
int64_t pickerInstant(DatePicker const& date, TimePicker const& time) {
    Windows::Globalization::Calendar value; value.ChangeCalendarSystem(L"GregorianCalendar"); value.SetDateTime(date.Date());
    auto minutes = std::chrono::duration_cast<std::chrono::minutes>(time.Time()).count();
    require(minutes >= 0 && minutes < 1440, L"Choose a local event time.");
    return localInstant(systemDay(civil(value.Year(), value.Month(), value.Day()), static_cast<unsigned>(minutes / 60), static_cast<unsigned>(minutes % 60)));
}
hstring storedString(std::shared_ptr<Service> const& service, wchar_t const* key) {
    auto entry = service->clientState().TryLookup(key);
    require(!entry || entry.ValueType() == JsonValueType::String, L"Saved calendar state could not be read. The original data is retained.");
    return entry ? entry.GetString() : hstring{};
}

struct Source {
    hstring provider, id, key, name, email;
    bool writable = false, primary = false;
    Windows::UI::Color color{};
};
Windows::UI::Color sourceColor(Json const& value, hstring const& key) {
    auto textColor = text(value, L"color"); uint32_t rgb = 0; bool valid = textColor.size() == 7 && textColor[0] == L'#';
    for (size_t i = 1; valid && i < textColor.size(); ++i) {
        auto c = textColor[i]; int digit = c >= L'0' && c <= L'9' ? c - L'0' : c >= L'a' && c <= L'f' ? c - L'a' + 10 : c >= L'A' && c <= L'F' ? c - L'A' + 10 : -1;
        valid = digit >= 0; rgb = (rgb << 4) | (digit >= 0 ? digit : 0);
    }
    if (!valid) { constexpr uint32_t colors[] = {0x487845, 0x467bbb, 0xa25d9c, 0xb47826, 0x34848b, 0xb76459}; uint32_t hash = 0; for (auto c : key) hash = hash * 31 + c; rgb = colors[hash % 6]; }
    return Windows::UI::Color{255, static_cast<uint8_t>(rgb >> 16), static_cast<uint8_t>(rgb >> 8), static_cast<uint8_t>(rgb)};
}
std::vector<Source> sources(Json const& catalog) {
    auto connections = requiredArray(catalog, L"connections", 2); auto calendars = requiredArray(catalog, L"calendars");
    std::set<std::wstring> providers, keys; std::map<std::wstring, hstring> emails;
    for (auto const& item : connections) {
        require(item.ValueType() == JsonValueType::Object, L"Invalid calendar connection."); auto entry = item.GetObject(); auto p = text(entry, L"provider");
        require(provider(p) && providers.insert(std::wstring(p)).second, L"Invalid or duplicate calendar connection.");
        if (flag(entry, L"connected")) { auto email = text(entry, L"email"); validText(email, 254); emails.emplace(std::wstring(p), email); }
    }
    std::vector<Source> result;
    for (auto const& item : calendars) {
        require(item.ValueType() == JsonValueType::Object, L"Invalid calendar entry."); auto entry = item.GetObject();
        Source source; source.provider = text(entry, L"provider"); source.id = text(entry, L"id");
        require(provider(source.provider), L"Unsupported calendar provider."); validText(source.id, 2048);
        source.key = calendarKey(source.provider, source.id); require(keys.insert(std::wstring(source.key)).second, L"The provider returned duplicate calendars.");
        source.name = text(entry, L"name", L"Untitled calendar"); source.writable = flag(entry, L"canWrite"); source.primary = flag(entry, L"primary"); source.color = sourceColor(entry, source.key);
        auto email = emails.find(std::wstring(source.provider)); if (email != emails.end()) source.email = email->second;
        result.push_back(std::move(source));
    }
    return result;
}
struct Entry {
    Source source;
    Json value;
    Day first, end;
    int64_t order = 0;
    bool allDay = false;
    bool on(Day day) const { return day >= first && day < end; }
};
std::vector<Entry> entries(Json const& result, Source const& source) {
    std::vector<Entry> output; std::set<std::wstring> ids;
    for (auto const& item : requiredArray(result, L"events")) {
        require(item.ValueType() == JsonValueType::Object, L"The calendar returned an invalid event."); auto value = item.GetObject();
        auto id = text(value, L"id"); require(!id.empty() && ids.insert(std::wstring(id)).second, L"The calendar returned missing or duplicate event IDs.");
        if (text(value, L"status") == L"cancelled") continue;
        Entry event; event.source = source; event.value = value; event.allDay = flag(value, L"allDay");
        if (event.allDay) {
            event.first = civil(text(value, L"start")); event.end = civil(text(value, L"end"));
            require(event.end > event.first, L"The calendar returned invalid all-day dates.");
            event.order = instant(systemDay(event.first));
        } else {
            auto start = parseInstant(text(value, L"start")), end = parseInstant(text(value, L"end"));
            require(end > start, L"The calendar returned an invalid event interval.");
            auto a = localSystem(start), b = localSystem(end); event.order = start;
            event.first = civil(a.wYear, a.wMonth, a.wDay); event.end = civil(b.wYear, b.wMonth, b.wDay);
            // Local civil days, with an exclusive end even at midnight or a DST transition.
            if (b.wHour || b.wMinute || b.wSecond || b.wMilliseconds || end % 10000) event.end += std::chrono::days{1};
        }
        output.push_back(std::move(event));
    }
    return output;
}
void validateReminder(Json const& payload, hstring const& p) {
    if (!payload.HasKey(L"reminder")) return;
    auto item = payload.Lookup(L"reminder"); require(item.ValueType() == JsonValueType::Object, L"Invalid saved reminder."); auto reminder = item.GetObject();
    for (auto const& pair : reminder) require(pair.Key() == L"method" || pair.Key() == L"minutes", L"Unsupported reminder field.");
    auto method = text(reminder, L"method");
    require(method == L"none" || method == L"popup" || (method == L"email" && p == L"google"), L"Outlook supports notification reminders only. Choose provider default, none or notification.");
    if (method != L"none") { auto minutes = reminder.TryLookup(L"minutes"); require(minutes && minutes.ValueType() == JsonValueType::Number, L"Choose whole reminder minutes from 0 to 40320."); auto number = minutes.GetNumber(); require(std::isfinite(number) && std::floor(number) == number && number >= 0 && number <= 40320, L"Choose whole reminder minutes from 0 to 40320."); }
}
struct Pending { hstring raw, provider, payload; Json review; };
Pending decodePending(hstring const& raw) {
    require(!raw.empty() && raw.size() <= 32768, L"The saved calendar request is invalid.");
    auto envelope = Json::Parse(raw); auto review = envelope.GetNamedObject(L"review"); auto p = text(review, L"provider"), id = text(envelope, L"requestId");
    static std::wregex const uuid(L"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$");
    require(provider(p) && std::regex_match(std::wstring(id), uuid), L"The saved request has an invalid provider or request ID.");
    for (auto const& pair : review) require(pair.Key() == L"provider" || pair.Key() == L"calendarName" || pair.Key() == L"calendarId" || pair.Key() == L"connectionEmail" || pair.Key() == L"title" || pair.Key() == L"description" || pair.Key() == L"location" || pair.Key() == L"start" || pair.Key() == L"end" || pair.Key() == L"reminder", L"The saved request contains unreviewed fields.");
    Json payload;
    for (auto key : {L"calendarId", L"connectionEmail", L"title", L"description", L"location", L"start", L"end"}) {
        auto item = review.TryLookup(key); require(item && item.ValueType() == JsonValueType::String, L"The saved event details are incomplete."); payload.Insert(key, item);
    }
    put(payload, L"requestId", id); if (review.HasKey(L"reminder")) payload.Insert(L"reminder", review.Lookup(L"reminder"));
    validText(text(payload, L"calendarId"), 2048); validText(text(payload, L"connectionEmail"), 254); validText(text(payload, L"title"), 300);
    validText(text(payload, L"description"), 10000, true, true); validText(text(payload, L"location"), 1000, true);
    auto start = parseInstant(text(payload, L"start")), end = parseInstant(text(payload, L"end"));
    require(end > start && end - start <= 90 * ticksPerDay, L"The end must be after the start, within 90 days."); validateReminder(payload, p);
    // The immutable review + requestId determine the payload. Never rewrite saved records or add a reminder.
    hstring serialized = payload.Stringify();
    if (envelope.HasKey(L"payload")) {
        serialized = envelope.GetNamedString(L"payload"); auto frozen = Json::Parse(serialized);
        require(frozen.Size() == payload.Size(), L"The saved payload does not match its review.");
        for (auto const& pair : payload) { auto saved = frozen.TryLookup(pair.Key()); require(saved && saved.Stringify() == pair.Value().Stringify(), L"The saved payload does not match its review."); }
    }
    return Pending{raw, p, serialized, review};
}
hstring reviewText(Pending const& pending) {
    auto review = pending.review, reminder = object(review, L"reminder"); hstring reminderText = L"Provider default";
    if (review.HasKey(L"reminder")) { auto method = text(reminder, L"method"); reminderText = method == L"none" ? L"None" : (method == L"email" ? hstring(L"Google email") : hstring(L"Notification")) + L" · " + to_hstring(static_cast<int>(reminder.GetNamedNumber(L"minutes", 0))) + L" minutes before (0 = at start)"; }
    return providerName(pending.provider) + L" · " + text(review, L"calendarName") + L"\nConnection: " + text(review, L"connectionEmail")
        + L"\nCalendar ID: " + text(review, L"calendarId") + L"\n\n" + text(review, L"title")
        + L"\nStarts: " + localLabel(text(review, L"start")) + L"\nEnds: " + localLabel(text(review, L"end")) + L"\nLocal time zone: " + zoneLabel()
        + L"\nReminder: " + reminderText + L"\nLocation: " + text(review, L"location") + L"\n\n" + text(review, L"description")
        + L"\n\nThis creates a real provider event. No attendees or invitations are added. Morrow sends no automatic mail. Reminders are handled by the provider, including while Morrow is closed.";
}

struct CalendarPage {
    std::weak_ptr<Shell> shell;
    hstring owner, pendingRaw;
    uint64_t generation = 0, revision = 0;
    bool active = true, reading = false, queued = false, catalogNeeded = true, catalogReady = false, creating = false, formOpen = false, pendingUnreadable = false;
    Day month = firstOfMonth(today()), day = today();
    Json choices;
    std::vector<Source> calendars, writable;
    std::vector<Entry> events;
    std::vector<hstring> catalogErrors, eventErrors;
    std::optional<Pending> pending;
    IAsyncOperation<Json> readRequest{nullptr};
    weak_ref<StackPanel> filters, agenda, form, recovery, errors, monthControls;
    weak_ref<Grid> grid;
    weak_ref<ContentControl> filtersContainer, monthControlsContainer, gridContainer, formContainer, recoveryContainer;
    weak_ref<TextBlock> notice, progress, monthLabel;
    weak_ref<Button> refresh, newEvent, connections, reviewButton;
    weak_ref<ComboBox> destination, reminder;
    weak_ref<DatePicker> startDate, endDate;
    weak_ref<TimePicker> startTime, endTime;
    weak_ref<TextBox> title, description, location;
    weak_ref<NumberBox> minutes;
    bool live(std::shared_ptr<Shell> const& host) const { return active && host && host->current(generation, owner) && host->section == L"calendar"; }
    bool current(uint64_t value) const { return value == revision && live(shell.lock()); }
    void say(hstring const& message) { if (live(shell.lock())) if (auto view = notice.get()) view.Text(message); }
    std::vector<Source> checked() const {
        std::set<std::wstring> defaults;
        for (auto p : {L"google", L"microsoft"}) {
            auto initial = std::find_if(calendars.begin(), calendars.end(), [p](auto const& c) { return c.provider == p && !c.email.empty() && c.primary; });
            if (initial == calendars.end()) initial = std::find_if(calendars.begin(), calendars.end(), [p](auto const& c) { return c.provider == p && !c.email.empty(); });
            if (initial != calendars.end()) defaults.insert(std::wstring(initial->key));
        }
        std::vector<Source> result;
        for (auto const& source : calendars) if (!source.email.empty() && (choices.HasKey(source.key) ? choices.GetNamedBoolean(source.key) : defaults.contains(std::wstring(source.key))) && result.size() < 12) result.push_back(source);
        return result;
    }
};
using Page = std::shared_ptr<CalendarPage>;
void renderMonth(Page const& state);
void renderAgenda(Page const& state);
void renderFilters(Page const& state);
void renderRecovery(Page const& state);
void updateControls(Page const& state);
void queueRead(Page const& state, bool catalog = false);
IAsyncAction loadMonth(Page state);
IAsyncAction openEvent(Page state, Day date);
IAsyncAction submit(Page state, std::optional<Pending> saved = std::nullopt);

void restorePending(Page const& state) {
    state->pending.reset(); state->pendingUnreadable = false;
    try { state->pendingRaw = storedString(state->shell.lock()->service, pendingKey); if (!state->pendingRaw.empty()) state->pending = decodePending(state->pendingRaw); }
    catch (...) { state->pendingUnreadable = true; }
}
void restoreChoices(Page const& state) {
    try {
        auto raw = storedString(state->shell.lock()->service, choicesKey); if (raw.empty()) return; auto saved = Json::Parse(raw); Json next;
        for (auto const& pair : saved) {
            auto key = Array::Parse(pair.Key()); require(key.Size() == 2 && key.GetAt(0).ValueType() == JsonValueType::String && key.GetAt(1).ValueType() == JsonValueType::String && provider(key.GetStringAt(0)) && pair.Value().ValueType() == JsonValueType::Boolean, L"Invalid calendar choices.");
            next.Insert(calendarKey(key.GetStringAt(0), key.GetStringAt(1)), pair.Value());
        }
        state->choices = next;
    } catch (...) { state->say(L"Saved calendar choices could not be read. Default calendars are shown for this session."); }
}
void renderErrors(Page const& state) {
    if (auto panel = state->errors.get()) {
        panel.Children().Clear();
        for (auto const& error : state->catalogErrors) panel.Children().Append(label(error));
        for (auto const& error : state->eventErrors) panel.Children().Append(label(error));
        if (!state->catalogErrors.empty() || !state->eventErrors.empty()) panel.Children().Append(label(L"Some calendars could not be loaded. The month and agenda may be incomplete. Refresh to retry."));
    }
}
void updateControls(Page const& state) {
    auto checked = state->checked(); bool writable = std::any_of(checked.begin(), checked.end(), [](auto const& source) { return source.writable; });
    if (auto view = state->refresh.get()) view.IsEnabled(!state->creating && !state->formOpen && !state->reading);
    if (auto view = state->connections.get()) view.IsEnabled(!state->creating && !state->formOpen);
    if (auto view = state->newEvent.get()) view.IsEnabled(writable && state->catalogReady && !state->creating && !state->formOpen && !state->pendingUnreadable && state->pendingRaw.empty());
    if (auto view = state->filtersContainer.get()) view.IsEnabled(!state->creating && !state->formOpen);
    if (auto view = state->monthControlsContainer.get()) view.IsEnabled(!state->creating && !state->formOpen);
    if (auto view = state->gridContainer.get()) view.IsEnabled(!state->creating && !state->formOpen);
    if (auto view = state->formContainer.get()) view.IsEnabled(!state->creating);
    if (auto view = state->reviewButton.get()) view.IsEnabled(!state->creating && !state->reading);
    if (auto view = state->recoveryContainer.get()) view.IsEnabled(!state->creating);
}
IAsyncAction abandon(Page state) {
    auto host = state->shell.lock(); if (!state->live(host) || state->creating || state->pendingRaw.empty()) co_return;
    auto raw = state->pendingRaw;
    try {
        if (!co_await host->confirm(L"Resolve the saved calendar request?", L"Confirm you checked the provider calendar for this event. This only forgets the local retry; it does not delete any provider event.", L"I checked · Forget request")) co_return;
        if (!state->live(host) || state->creating) co_return;
        require(storedString(host->service, pendingKey) == raw, L"The saved request changed. Refresh before resolving it.");
        host->service->saveClientState(pendingKey, L""); state->pendingRaw = {}; state->pending.reset(); state->pendingUnreadable = false;
        renderRecovery(state); updateControls(state); state->say(L"Local calendar request cleared. Provider events were not changed.");
    } catch (hresult_error const& error) { state->say(error.message()); }
}
void renderRecovery(Page const& state) {
    if (auto panel = state->recovery.get()) {
        panel.Children().Clear();
        if (!state->pendingRaw.empty() || state->pendingUnreadable) {
            panel.Children().Append(label(L"Unconfirmed calendar request", 20));
            panel.Children().Append(label(state->pendingUnreadable ? L"The saved request could not be read. Its exact contents are retained. Resolve it before creating another event." : L"Check the provider calendar before retrying. The original request ID and reviewed details are retained across restarts."));
            if (state->pending) {
                Expander details; details.Header(box_value(L"Original event details")); details.Content(label(reviewText(*state->pending))); panel.Children().Append(details);
                panel.Children().Append(button(L"Review original request", [state] { if (state->pending) submit(state, *state->pending); }));
            }
            if (!state->pendingRaw.empty()) panel.Children().Append(button(L"I checked the calendar · Clear local request", [state] { abandon(state); }));
        }
    }
}
void renderFilters(Page const& state) {
    auto panel = state->filters.get(); if (!panel) return; panel.Children().Clear();
    panel.Children().Append(label(L"Calendars to show · up to 12", 18)); auto selected = state->checked(); std::set<std::wstring> keys;
    for (auto const& source : selected) keys.insert(std::wstring(source.key));
    for (auto const& source : state->calendars) {
        CheckBox box; auto row = stack(3); auto heading = stack(); heading.Orientation(Orientation::Horizontal);
        auto dot = label(L"●"); dot.Foreground(xaml::Media::SolidColorBrush(source.color)); heading.Children().Append(dot); heading.Children().Append(label(source.name)); row.Children().Append(heading);
        auto name = providerName(source.provider) + L" · " + source.email + (source.writable ? L"" : L" · Read only"); row.Children().Append(label(name, 12));
        box.Content(row); bool on = keys.contains(std::wstring(source.key)); box.IsChecked(on); box.IsEnabled(!source.email.empty() && (on || selected.size() < 12));
        xaml::Automation::AutomationProperties::SetName(box, source.name + L" · " + name);
        auto change = [state, key = source.key](auto const& sender, auto const&) {
            auto host = state->shell.lock(); if (!state->live(host) || state->creating || state->formOpen) return;
            auto control = sender.template as<CheckBox>(); auto value = control.IsChecked(); bool on = value && value.Value(); auto selected = state->checked();
            if (on && selected.size() >= 12) { state->say(L"Uncheck a calendar first. Up to 12 calendars may be selected."); renderFilters(state); return; }
            std::set<std::wstring> keys; for (auto const& c : selected) keys.insert(std::wstring(c.key));
            auto next = copy(state->choices); for (auto const& c : state->calendars) next.Insert(c.key, Value::CreateBooleanValue(keys.contains(std::wstring(c.key)))); next.Insert(key, Value::CreateBooleanValue(on)); state->choices = next;
            try { host->service->saveClientState(choicesKey, next.Stringify()); state->say(L""); } catch (...) { state->say(L"Calendar choices could not be saved. They apply only to this session."); }
            renderFilters(state); queueRead(state);
        };
        box.Checked(change); box.Unchecked(change); panel.Children().Append(box);
    }
    if (state->calendars.empty()) panel.Children().Append(label(L"Connect Google Calendar or Outlook Calendar in Connections. Calendar connections are independent of mailboxes."));
    updateControls(state);
}
void renderAgenda(Page const& state) {
    auto panel = state->agenda.get(); if (!panel) return; panel.Children().Clear(); panel.Children().Append(label(dayText(state->day), 22));
    size_t count = 0;
    for (auto const& event : state->events) if (event.on(state->day)) {
        ++count; auto row = stack(5); auto heading = stack(); heading.Orientation(Orientation::Horizontal);
        auto dot = label(L"●"); dot.Foreground(xaml::Media::SolidColorBrush(event.source.color)); heading.Children().Append(dot); heading.Children().Append(label(text(event.value, L"title", L"(Untitled event)"), 18)); row.Children().Append(heading);
        row.Children().Append(label(providerName(event.source.provider) + L" · " + event.source.name + L" · " + event.source.email, 12));
        row.Children().Append(label(event.allDay ? L"All day · " + dayText(event.first) + (event.end == event.first + std::chrono::days{1} ? hstring{} : L" through " + dayText(event.end - std::chrono::days{1})) : localLabel(text(event.value, L"start")) + L" — " + localLabel(text(event.value, L"end"))));
        if (!text(event.value, L"location").empty()) row.Children().Append(label(L"Location: " + text(event.value, L"location")));
        if (!text(event.value, L"description").empty()) { Expander details; details.Header(box_value(L"Description")); details.Content(label(text(event.value, L"description"))); row.Children().Append(details); }
        panel.Children().Append(row);
    }
    if (!count) panel.Children().Append(label(state->reading ? L"Events are still loading for this day." : !state->catalogErrors.empty() || !state->eventErrors.empty() ? L"Some calendars could not be loaded. Events may be missing from this day." : state->checked().empty() ? L"Check a calendar to view its events." : L"No events on this day in the checked calendars."));
}
void renderMonth(Page const& state) {
    auto grid = state->grid.get(); if (!grid) return; grid.Children().Clear();
    Windows::Globalization::DateTimeFormatting::DateTimeFormatter formatter(L"month.full year");
    if (auto heading = state->monthLabel.get()) heading.Text(formatter.Format(DateTime{TimeSpan{localInstant(systemDay(state->month, 12))}}));
    wchar_t const* weekdays[] = {L"Sun", L"Mon", L"Tue", L"Wed", L"Thu", L"Fri", L"Sat"};
    for (int i = 0; i < 7; ++i) { auto title = label(weekdays[i]); xaml::Controls::Grid::SetColumn(title, i); grid.Children().Append(title); }
    auto first = gridStart(state->month);
    for (int i = 0; i < 42; ++i) {
        auto day = first + std::chrono::days{i}; auto content = stack(3); auto number = systemDay(day).wDay;
        auto title = label(to_hstring(number) + (day == today() ? L" · Today" : L"")); title.IsTextSelectionEnabled(false); content.Children().Append(title); size_t count = 0;
        for (auto const& event : state->events) if (event.on(day)) {
            if (count++ >= 2) continue;
            auto line = label(L"● " + text(event.value, L"title", L"(Untitled event)"), 11); line.Foreground(xaml::Media::SolidColorBrush(event.source.color)); line.IsTextSelectionEnabled(false); line.MaxLines(1); content.Children().Append(line);
        }
        if (count > 2) { auto more = label(L"+" + to_hstring(count - 2) + L" more", 11); more.IsTextSelectionEnabled(false); content.Children().Append(more); }
        auto cell = button(dayText(day), [state, day] { openEvent(state, day); }); cell.Content(content); cell.MinHeight(88); cell.HorizontalAlignment(xaml::HorizontalAlignment::Stretch); cell.HorizontalContentAlignment(xaml::HorizontalAlignment::Left); cell.VerticalContentAlignment(xaml::VerticalAlignment::Top);
        cell.Margin(xaml::ThicknessHelper::FromUniformLength(2)); cell.Opacity(firstOfMonth(day) == state->month ? 1.0 : 0.65);
        if (day == state->day) { cell.BorderThickness(xaml::ThicknessHelper::FromUniformLength(2)); cell.BorderBrush(xaml::Media::SolidColorBrush(Windows::UI::Color{255, 72, 120, 69})); }
        xaml::Automation::AutomationProperties::SetName(cell, dayText(day) + L" · " + to_hstring(count) + L" loaded events" + (day == state->day ? L" · Selected" : L"") + (state->reading ? L" · Loading" : L""));
        xaml::Controls::Grid::SetColumn(cell, i % 7); xaml::Controls::Grid::SetRow(cell, i / 7 + 1); grid.Children().Append(cell);
    }
    updateControls(state);
}
void queueRead(Page const& state, bool catalog) {
    if (!state->live(state->shell.lock()) || state->creating) return;
    ++state->revision; state->queued = true; state->catalogNeeded = state->catalogNeeded || catalog; state->events.clear(); state->eventErrors.clear();
    renderErrors(state); renderMonth(state); renderAgenda(state);
    if (!state->reading) loadMonth(state);
}
IAsyncAction loadMonth(Page state) {
    auto host = state->shell.lock(); if (!state->live(host) || state->reading) co_return; state->reading = true; updateControls(state);
    auto cancellation = co_await get_cancellation_token(); cancellation.enable_propagation();
    // One request pump: rapid month/checkbox changes invalidate results but never start parallel reads.
    while (state->live(host) && state->queued && !cancellation()) {
        state->queued = false; auto revision = state->revision; auto month = state->month;
        try {
            if (state->catalogNeeded || !state->catalogReady) {
                if (auto view = state->progress.get()) view.Text(L"Loading calendars…");
                restorePending(state); renderRecovery(state);
                state->readRequest = host->service->request(L"/calendars"); auto catalog = co_await state->readRequest; state->readRequest = nullptr;
                if (!state->current(revision) || cancellation()) continue;
                auto next = sources(catalog); std::vector<hstring> errors;
                for (auto const& item : requiredArray(catalog, L"errors", 2)) { require(item.ValueType() == JsonValueType::Object, L"Invalid calendar error list."); auto error = item.GetObject(); auto p = text(error, L"provider"); require(provider(p), L"Invalid calendar provider error."); errors.push_back(providerName(p) + L": " + text(error, L"message", L"Could not load calendars.")); }
                state->calendars = std::move(next); state->catalogErrors = std::move(errors); state->catalogReady = true; state->catalogNeeded = false; renderFilters(state); renderErrors(state);
            }
            auto selected = state->checked(); auto first = gridStart(month);
            // Two civil days of padding cover remote all-day dates; this is a bounded 46-day read.
            auto beginning = instant(systemDay(first - std::chrono::days{2})), ending = instant(systemDay(first + std::chrono::days{44}));
            require(ending > beginning && ending - beginning <= 90 * ticksPerDay, L"Choose a calendar range of no more than 90 days.");
            size_t complete = 0;
            for (auto const& source : selected) {
                if (!state->current(revision) || cancellation()) break;
                if (auto view = state->progress.get()) view.Text(L"Loading calendars · " + to_hstring(complete) + L" / " + to_hstring(selected.size()));
                try {
                    auto path = L"/calendars/" + source.provider + L"/events?calendarId=" + escaped(source.id) + L"&start=" + escaped(utcText(beginning)) + L"&end=" + escaped(utcText(ending));
                    state->readRequest = host->service->request(path); auto result = co_await state->readRequest; state->readRequest = nullptr;
                    if (!state->current(revision) || cancellation()) break;
                    auto parsed = entries(result, source);
                    for (auto& event : parsed) if (event.first < first + std::chrono::days{42} && event.end > first) state->events.push_back(std::move(event));
                } catch (hresult_error const& error) { if (state->current(revision) && !cancellation()) state->eventErrors.push_back(providerName(source.provider) + L" · " + source.name + L": " + error.message()); }
                catch (...) { if (state->current(revision) && !cancellation()) state->eventErrors.push_back(providerName(source.provider) + L" · " + source.name + L": Invalid event data. This calendar could not be displayed completely."); }
                ++complete;
            }
            if (state->current(revision) && !cancellation()) {
                std::sort(state->events.begin(), state->events.end(), [](auto const& a, auto const& b) { return a.order != b.order ? a.order < b.order : a.source.key != b.source.key ? a.source.key < b.source.key : text(a.value, L"id") < text(b.value, L"id"); });
                renderErrors(state); renderMonth(state); renderAgenda(state);
            }
        } catch (hresult_error const& error) {
            if (state->current(revision) && !cancellation()) { state->catalogReady = false; state->calendars.clear(); state->catalogErrors = {error.message()}; renderFilters(state); renderErrors(state); }
        } catch (...) {
            if (state->current(revision) && !cancellation()) { state->catalogReady = false; state->calendars.clear(); state->catalogErrors = {L"The calendar catalog could not be read. Refresh or check Connections."}; renderFilters(state); renderErrors(state); }
        }
    }
    state->readRequest = nullptr; state->reading = false;
    if (state->live(host)) { if (auto view = state->progress.get()) view.Text(L""); renderAgenda(state); updateControls(state); }
}

IAsyncAction closeEvent(Page state) {
    auto host = state->shell.lock(); if (!state->live(host) || state->creating) co_return;
    if (host->dirty.contains(L"calendar") && !co_await host->confirm(L"Discard this event draft?", L"No event will be created.", L"Discard")) co_return;
    if (!state->live(host) || state->creating) co_return;
    state->formOpen = false; host->dirty.erase(L"calendar"); if (auto panel = state->form.get()) panel.Children().Clear(); updateControls(state);
}
IAsyncAction openEvent(Page state, Day date) {
    auto host = state->shell.lock(); if (!state->live(host) || state->creating || state->formOpen) co_return;
    try {
        state->day = date; renderMonth(state); renderAgenda(state);
        if (!state->pendingRaw.empty() || state->pendingUnreadable) { state->say(L"Resolve the saved calendar request before creating another event."); co_return; }
        state->writable.clear(); for (auto const& source : state->checked()) if (source.writable) state->writable.push_back(source);
        if (!state->catalogReady || state->writable.empty()) { state->say(L"Check a connected writable calendar to create an event. Read-only calendars remain viewable."); co_return; }
        auto panel = state->form.get(); if (!panel) co_return; panel.Children().Clear(); panel.Children().Append(label(L"New event", 22));
        ComboBox destination; destination.Header(box_value(L"Create in checked writable calendar"));
        int selected = 0; for (size_t i = 0; i < state->writable.size(); ++i) { auto const& source = state->writable[i]; destination.Items().Append(box_value(providerName(source.provider) + L" · " + source.name + L" · " + source.email)); if (source.primary) selected = static_cast<int>(i); }
        destination.SelectedIndex(selected); state->destination = make_weak(destination); panel.Children().Append(destination);
        auto title = field(L"Event title"); title.MaxLength(300); state->title = make_weak(title); panel.Children().Append(title);
        auto dates = stack(10);
        DatePicker startDate, endDate; startDate.Header(box_value(L"Starts · local date")); endDate.Header(box_value(L"Ends · local date")); startDate.CalendarIdentifier(L"GregorianCalendar"); endDate.CalendarIdentifier(L"GregorianCalendar");
        auto minimum = DateTime{TimeSpan{localInstant(systemDay(civil(1900, 1, 1), 12))}}, maximum = DateTime{TimeSpan{localInstant(systemDay(civil(9999, 12, 30), 12))}};
        startDate.MinYear(minimum); startDate.MaxYear(maximum); endDate.MinYear(minimum); endDate.MaxYear(maximum);
        auto day = DateTime{TimeSpan{localInstant(systemDay(date, 12))}}; startDate.Date(day); endDate.Date(day);
        TimePicker startTime, endTime; startTime.Header(box_value(L"Start time")); endTime.Header(box_value(L"End time")); startTime.MinuteIncrement(1); endTime.MinuteIncrement(1); startTime.Time(std::chrono::hours(9)); endTime.Time(std::chrono::hours(10));
        dates.Children().Append(startDate); dates.Children().Append(startTime); dates.Children().Append(endDate); dates.Children().Append(endTime); panel.Children().Append(dates);
        state->startDate = make_weak(startDate); state->endDate = make_weak(endDate); state->startTime = make_weak(startTime); state->endTime = make_weak(endTime);
        panel.Children().Append(label(L"Times use " + zoneLabel() + L". Review the exact local and UTC times before creating, including when clocks change."));
        ComboBox reminder; reminder.Header(box_value(L"Provider reminder")); for (auto name : {L"Provider default", L"None", L"Notification"}) reminder.Items().Append(box_value(name)); if (state->writable[selected].provider == L"google") reminder.Items().Append(box_value(L"Email from Google Calendar")); reminder.SelectedIndex(0); state->reminder = make_weak(reminder); panel.Children().Append(reminder);
        NumberBox minutes; minutes.Header(box_value(L"Minutes before · 0 = at start, up to 28 days")); minutes.Minimum(0); minutes.Maximum(40320); minutes.SmallChange(1); minutes.Value(15); minutes.IsEnabled(false); state->minutes = make_weak(minutes); panel.Children().Append(minutes);
        reminder.SelectionChanged([state](auto const&, auto const&) { if (auto view = state->minutes.get()) if (auto method = state->reminder.get()) view.IsEnabled(method.SelectedIndex() >= 2); });
        destination.SelectionChanged([state](auto const& sender, auto const&) {
            auto i = sender.template as<ComboBox>().SelectedIndex(); auto reminder = state->reminder.get(); if (!reminder || i < 0 || static_cast<size_t>(i) >= state->writable.size()) return;
            bool google = state->writable[i].provider == L"google";
            if (google && reminder.Items().Size() == 3) reminder.Items().Append(box_value(L"Email from Google Calendar"));
            if (!google && reminder.Items().Size() > 3) { if (reminder.SelectedIndex() == 3) { reminder.SelectedIndex(0); state->say(L"Outlook has no email reminders. Provider default selected; review it before creating."); } reminder.Items().RemoveAt(3); }
        });
        panel.Children().Append(label(L"Reminders are delivered by your calendar provider and can work while Morrow is closed. Outlook supports notifications only. No hidden scheduled mail is created."));
        auto location = field(L"Location (optional)"); location.MaxLength(1000); state->location = make_weak(location); panel.Children().Append(location);
        auto description = field(L"Description (optional)", {}, true); description.MaxLength(10000); description.MinHeight(90); state->description = make_weak(description); panel.Children().Append(description);
        auto actions = stack(); actions.Orientation(Orientation::Horizontal); actions.Children().Append(button(L"Cancel", [state] { closeEvent(state); }));
        auto review = button(L"Review event", [state] { submit(state); }); state->reviewButton = make_weak(review); actions.Children().Append(review); panel.Children().Append(actions);
        state->formOpen = true; host->dirty.insert(L"calendar"); updateControls(state); title.Focus(xaml::FocusState::Programmatic);
    } catch (hresult_error const& error) { state->say(error.message()); }
}
Pending formRequest(Page const& state) {
    auto picker = state->destination.get(); require(picker && picker.SelectedIndex() >= 0 && static_cast<size_t>(picker.SelectedIndex()) < state->writable.size(), L"Choose a writable calendar."); auto const& source = state->writable[picker.SelectedIndex()];
    require(source.writable && !source.email.empty(), L"Choose a connected writable calendar.");
    Json review; put(review, L"provider", source.provider); put(review, L"calendarName", source.name); put(review, L"calendarId", source.id); put(review, L"connectionEmail", source.email);
    auto title = state->title.get(), description = state->description.get(), location = state->location.get(); require(title && description && location, L"Reopen the calendar event form.");
    put(review, L"title", trim(title.Text())); put(review, L"description", trim(description.Text())); put(review, L"location", trim(location.Text()));
    auto startDate = state->startDate.get(), endDate = state->endDate.get(); auto startTime = state->startTime.get(), endTime = state->endTime.get(); require(startDate && endDate && startTime && endTime, L"Choose an event date and time.");
    put(review, L"start", utcText(pickerInstant(startDate, startTime))); put(review, L"end", utcText(pickerInstant(endDate, endTime)));
    auto methods = state->reminder.get(); require(methods && methods.SelectedIndex() >= 0 && methods.SelectedIndex() <= 3, L"Choose a provider reminder.");
    auto selected = methods.SelectedIndex();
    if (selected) { Json reminder; put(reminder, L"method", selected == 1 ? L"none" : selected == 2 ? L"popup" : L"email"); if (selected != 1) { auto minutes = state->minutes.get(); require(minutes && std::isfinite(minutes.Value()), L"Enter reminder minutes."); reminder.Insert(L"minutes", Value::CreateNumberValue(minutes.Value())); } review.Insert(L"reminder", reminder); }
    // Store one snapshot: duplicating an escaped payload can exceed the 32768-character desktop-state limit.
    Json saved; saved.Insert(L"review", review); put(saved, L"requestId", Service::uuid()); return decodePending(saved.Stringify());
}
IAsyncAction submit(Page state, std::optional<Pending> saved) {
    auto host = state->shell.lock(); if (!state->live(host) || state->creating || state->reading || state->pendingUnreadable || host->dialogOpen || host->loading) { if (state->reading) state->say(L"Wait for calendar reads to finish before reviewing an event."); co_return; }
    if (!saved && (!state->pendingRaw.empty() || !state->formOpen)) co_return;
    state->creating = true; host->loading = true; updateControls(state); bool success = false;
    try {
        auto pending = saved ? *saved : formRequest(state);
        auto detail = reviewText(pending) + (saved ? L"\n\nThe previous result was not confirmed. Check the provider calendar first. Retrying submits the original UUID and exact reviewed payload; it does not create a new request." : L"");
        bool confirmed = co_await host->confirm(saved ? L"Retry the original calendar request?" : L"Create this calendar event?", detail, saved ? L"Retry same request" : L"Create event");
        if (confirmed && state->live(host)) {
            auto existing = storedString(host->service, pendingKey);
            require(saved ? existing == pending.raw : existing.empty(), L"A saved calendar request changed. Refresh and review that original request first.");
            if (!saved) host->service->saveClientState(pendingKey, pending.raw);
            // Never rewrite an existing pending string, even to add a default reminder or a native payload snapshot.
            require(storedString(host->service, pendingKey) == pending.raw, L"Could not verify saved recovery details. No event has been submitted.");
            state->pendingRaw = pending.raw; state->pending = pending; state->formOpen = false; host->dirty.erase(L"calendar"); if (auto panel = state->form.get()) panel.Children().Clear(); renderRecovery(state); updateControls(state);
            auto catalog = co_await host->service->request(L"/calendars");
            if (state->live(host)) {
                auto current = sources(catalog); auto payload = Json::Parse(pending.payload);
                require(std::any_of(current.begin(), current.end(), [&](auto const& source) { return source.provider == pending.provider && source.id == text(payload, L"calendarId") && source.email == text(payload, L"connectionEmail") && source.writable; }), L"Reconnect the original writable calendar before retrying. The original request has been retained.");
                require(storedString(host->service, pendingKey) == pending.raw, L"The saved request changed. No event has been submitted.");
                auto result = co_await host->service->request(L"/calendars/" + pending.provider + L"/events", L"", L"POST", payload);
                if (state->live(host)) {
                    require(!text(object(result, L"event"), L"id").empty(), L"The provider did not confirm an event ID. Check your calendar before retrying.");
                    require(storedString(host->service, pendingKey) == pending.raw, L"The event was created, but the saved request changed. Check your calendar before resolving it.");
                    host->service->saveClientState(pendingKey, L""); state->pending.reset(); state->pendingRaw = {}; success = true;
                    state->say(L"Event created in " + providerName(pending.provider) + L". Provider reminders use the reviewed settings.");
                }
            }
        }
    } catch (hresult_error const& error) { state->say(error.message() + (state->pendingRaw.empty() ? hstring{} : L" Your original reviewed request is retained. Check the provider calendar before retrying.")); }
    catch (...) { state->say(L"The event could not be confirmed. Any saved request is retained unchanged; check the provider calendar before retrying."); }
    state->creating = false; host->loading = false;
    if (state->live(host)) { restorePending(state); renderRecovery(state); updateControls(state); if (success) queueRead(state, true); }
}
IAsyncAction connections(Page state) {
    auto host = state->shell.lock(); if (!state->live(host) || state->creating || state->formOpen || host->loading) co_return;
    if (!host->dirty.empty()) { state->say(L"Save or close the current edits before opening Connections."); co_return; }
    auto navigating = host->navigate(L"settings"); auto version = host->generation; auto owner = host->owner;
    co_await navigating;
    if (host->current(version, owner) && host->section == L"settings") co_await settingsPage(host, L"calendar");
}
}

IAsyncAction calendarPage(std::shared_ptr<Shell> shell) {
    auto state = std::make_shared<CalendarPage>(); state->shell = shell; state->owner = shell->owner; state->generation = shell->generation;
    try {
        auto panel = stack(16); panel.Padding(xaml::ThicknessHelper::FromUniformLength(24)); panel.Children().Append(label(L"Calendar", 28));
        auto appendContainer = [&panel](xaml::UIElement const& content, weak_ref<ContentControl>& reference) {
            ContentControl container; container.HorizontalContentAlignment(xaml::HorizontalAlignment::Stretch);
            container.IsTabStop(false); container.Content(content); reference = make_weak(container);
            panel.Children().Append(container);
        };
        panel.Children().Append(label(L"Google and Outlook calendars · " + zoneLabel() + L". Select a day for its agenda and a new event at 09:00."));
        auto actions = stack(); actions.Orientation(Orientation::Horizontal);
        auto configure = button(L"Connections", [state] { connections(state); }); state->connections = make_weak(configure); actions.Children().Append(configure);
        auto refresh = button(L"Refresh calendars", [state] { queueRead(state, true); }); state->refresh = make_weak(refresh); actions.Children().Append(refresh); panel.Children().Append(actions);
        auto recovery = stack(); state->recovery = make_weak(recovery); appendContainer(recovery, state->recoveryContainer);
        auto notice = label(L""); state->notice = make_weak(notice); panel.Children().Append(notice);
        auto filters = stack(); state->filters = make_weak(filters); appendContainer(filters, state->filtersContainer);
        auto navigation = stack(); navigation.Orientation(Orientation::Horizontal); state->monthControls = make_weak(navigation);
        auto move = [state](int offset) { if (state->creating || state->formOpen) return; try { auto date = std::chrono::year_month_day{state->month} + std::chrono::months{offset}; require(int(date.year()) >= 1901 && int(date.year()) < 9999, L"Choose a displayed month from 1901 to 9998 so its padded range stays valid."); state->month = civil(int(date.year()), unsigned(date.month()), 1); state->day = state->month; queueRead(state); } catch (hresult_error const& error) { state->say(error.message()); } };
        navigation.Children().Append(button(L"Previous month", [move] { move(-1); })); navigation.Children().Append(button(L"Today", [state] { if (state->creating || state->formOpen) return; state->day = today(); state->month = firstOfMonth(state->day); queueRead(state); })); navigation.Children().Append(button(L"Next month", [move] { move(1); }));
        auto month = label(L"", 22); state->monthLabel = make_weak(month); navigation.Children().Append(month); appendContainer(navigation, state->monthControlsContainer);
        auto progress = label(L"Loading calendars…"); state->progress = make_weak(progress); panel.Children().Append(progress);
        auto errors = stack(); state->errors = make_weak(errors); panel.Children().Append(errors);
        Grid grid; for (int i = 0; i < 7; ++i) { ColumnDefinition column; column.Width(xaml::GridLengthHelper::FromValueAndType(1, xaml::GridUnitType::Star)); grid.ColumnDefinitions().Append(column); RowDefinition row; row.Height(xaml::GridLengthHelper::Auto()); grid.RowDefinitions().Append(row); } state->grid = make_weak(grid); appendContainer(grid, state->gridContainer);
        auto create = button(L"New event", [state] { openEvent(state, state->day); }); state->newEvent = make_weak(create); panel.Children().Append(create);
        panel.Children().Append(label(L"Check a writable calendar to create events. Read-only calendars can be selected and viewed."));
        auto form = stack(); state->form = make_weak(form); appendContainer(form, state->formContainer);
        auto agenda = stack(16); state->agenda = make_weak(agenda); panel.Children().Append(agenda);
        panel.Unloaded([state](auto const&, auto const&) { state->active = false; ++state->revision; state->queued = false; if (state->readRequest) state->readRequest.Cancel(); });
        shell->show(scroll(panel)); restoreChoices(state); restorePending(state); renderRecovery(state); renderMonth(state); renderAgenda(state); updateControls(state);
        state->queued = true; ++state->revision; co_await loadMonth(state);
    } catch (hresult_error const& error) { if (state->live(shell)) shell->error(error.message()); }
}
}
