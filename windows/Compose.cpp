#include "pch.h"
#include "Ui.h"
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Windows.Globalization.h>
#include <winrt/Windows.Globalization.DateTimeFormatting.h>
#include <winrt/Windows.System.h>
#include <chrono>
#include <cwchar>
#include <vector>

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
using namespace Windows::Data::Json;
using namespace controls;
namespace {
Json copy(Json const& value) { return Json::Parse(value.Stringify()); }
void require(bool value, wchar_t const* message) {
    if (!value) throw hresult_error(E_INVALIDARG, message);
}
bool checked(CheckBox const& value) { return value.IsChecked() && value.IsChecked().Value(); }
bool locked(Json const& message) {
    auto status = text(object(message, L"scheduledSend"), L"status");
    return status == L"scheduled" || status == L"sending";
}
bool cancellable(Json const& job) {
    auto status = text(job, L"status");
    return status == L"scheduled" || status == L"missed" || status == L"blocked";
}
void ownedMessage(Json const& message, hstring const& owner, hstring const& id = {}) {
    require(text(message, L"accountId") == owner && !text(message, L"id").empty()
        && (id.empty() || text(message, L"id") == id), L"The saved message could not be confirmed for this mailbox.");
}
uint64_t ticks(FILETIME const& value) {
    return (uint64_t(value.dwHighDateTime) << 32) | value.dwLowDateTime;
}
hstring scheduledTime(DatePicker const& date, TimePicker const& time) {
    Windows::Globalization::Calendar calendar;
    calendar.ChangeCalendarSystem(L"GregorianCalendar");
    calendar.SetDateTime(date.Date());
    auto minutes = std::chrono::duration_cast<std::chrono::minutes>(time.Time()).count();
    require(minutes >= 0 && minutes < 24 * 60, L"Choose a send time.");
    SYSTEMTIME local{}, utc{}, roundTrip{};
    local.wYear = static_cast<WORD>(calendar.Year());
    local.wMonth = static_cast<WORD>(calendar.Month());
    local.wDay = static_cast<WORD>(calendar.Day());
    local.wHour = static_cast<WORD>(minutes / 60);
    local.wMinute = static_cast<WORD>(minutes % 60);
    require(TzSpecificLocalTimeToSystemTimeEx(nullptr, &local, &utc)
        && SystemTimeToTzSpecificLocalTimeEx(nullptr, &utc, &roundTrip)
        && local.wYear == roundTrip.wYear && local.wMonth == roundTrip.wMonth
        && local.wDay == roundTrip.wDay && local.wHour == roundTrip.wHour
        && local.wMinute == roundTrip.wMinute,
        L"This local time does not exist because the clocks change. Choose another time.");
    FILETIME at{}, now{};
    require(SystemTimeToFileTime(&utc, &at), L"Choose a valid send date.");
    GetSystemTimeAsFileTime(&now);
    require(ticks(at) > ticks(now), L"Choose a future send date and time.");
    wchar_t result[32]{};
    swprintf_s(result, L"%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", unsigned(utc.wYear),
        unsigned(utc.wMonth), unsigned(utc.wDay), unsigned(utc.wHour), unsigned(utc.wMinute),
        unsigned(utc.wSecond), unsigned(utc.wMilliseconds));
    return hstring(result);
}
hstring localTime(hstring const& value) {
    unsigned y, m, d, h, min, sec, ms;
    if (value.size() != 24 || value[23] != L'Z'
        || swscanf_s(value.c_str(), L"%4u-%2u-%2uT%2u:%2u:%2u.%3uZ", &y, &m, &d, &h, &min, &sec, &ms) != 7)
        return value;
    SYSTEMTIME utc{};
    utc.wYear = static_cast<WORD>(y); utc.wMonth = static_cast<WORD>(m); utc.wDay = static_cast<WORD>(d);
    utc.wHour = static_cast<WORD>(h); utc.wMinute = static_cast<WORD>(min);
    utc.wSecond = static_cast<WORD>(sec); utc.wMilliseconds = static_cast<WORD>(ms);
    FILETIME file{};
    if (!SystemTimeToFileTime(&utc, &file)) return value;
    DateTime date{TimeSpan{static_cast<int64_t>(ticks(file))}};
    Windows::Globalization::DateTimeFormatting::DateTimeFormatter formatter(L"shortdate shorttime");
    return formatter.Format(date) + L" (local time; " + value + L")";
}
hstring delayedTime(int hours) {
    require(hours >= 1 && hours <= 6, L"Choose a send delay from 1 to 6 hours.");
    FILETIME file{}; GetSystemTimeAsFileTime(&file);
    auto at = ticks(file) + uint64_t(hours) * 60 * 60 * 10000000;
    file.dwLowDateTime = DWORD(at); file.dwHighDateTime = DWORD(at >> 32);
    SYSTEMTIME utc{};
    require(FileTimeToSystemTime(&file, &utc), L"The delayed send time could not be calculated.");
    wchar_t result[32]{};
    swprintf_s(result, L"%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", unsigned(utc.wYear), unsigned(utc.wMonth), unsigned(utc.wDay), unsigned(utc.wHour), unsigned(utc.wMinute), unsigned(utc.wSecond), unsigned(utc.wMilliseconds));
    return hstring(result);
}
Json content(Json const& message) {
    Json value;
    for (auto name : { L"to", L"cc", L"bcc", L"subject", L"body" }) put(value, name, text(message, name));
    auto footer = message.TryLookup(L"footer");
    if (footer && footer.ValueType() == JsonValueType::Object) value.Insert(L"footer", footer);
    if (!text(message, L"replyToId").empty()) put(value, L"replyToId", text(message, L"replyToId"));
    return value;
}
hstring reviewText(hstring const& owner, Json const& value) {
    auto footer = object(value, L"footer");
    return L"From: " + owner + L"\nTo: " + text(value, L"to") + L"\nCc: " + text(value, L"cc")
        + L"\nBcc: " + text(value, L"bcc") + L"\nSubject: " + text(value, L"subject", L"(No subject)")
        + L"\n\n" + text(value, L"body") + L"\n\nFooter:\n"
        + text(footer, L"text", text(footer, L"html"));
}
std::vector<hstring> mailboxChoices(std::shared_ptr<Shell> const& shell, ComboBox const& picker) {
    std::vector<hstring> result;
    for (auto const& value : array(shell->state, L"accounts")) {
        if (value.ValueType() != JsonValueType::Object) continue;
        auto account = value.GetObject();
        auto id = text(account, L"id");
        if (id.empty() || id == L"all" || id == L"demo" || !shell->connected(id)) continue;
        result.push_back(id);
        picker.Items().Append(box_value(text(account, L"email", id)));
    }
    return result;
}

struct Composer {
    std::weak_ptr<Shell> shell;
    uint64_t generation{};
    hstring screenOwner, owner, requestId, baseline, baselineOwner;
    Json message, scheduleAttempt;
    bool busy = false, uncertain = false, bound = false, initializing = false;
    bool historyLoading = false;
    weak_ref<StackPanel> history;
    std::vector<hstring> accounts;
    std::vector<weak_ref<TextBox>> fields;
    weak_ref<ComboBox> from, aiAction;
    weak_ref<TextBox> aiPrompt;
    TextBlock notice{nullptr}, footer{nullptr}, aiResult{nullptr};
    weak_ref<CheckBox> schedule, reviewed;
    weak_ref<StackPanel> scheduleDetails;
    weak_ref<DatePicker> date;
    weak_ref<TimePicker> time;
    weak_ref<Button> save, send, removeFooter, generate, useAI, close;
    hstring suggestion;
    bool live(std::shared_ptr<Shell> const& host) const {
        return host && !host->closing && host->generation == generation
            && host->owner == screenOwner && host->section == L"compose";
    }
    bool frozen() const { return busy || uncertain || locked(message) || scheduleAttempt.Size() != 0; }
    Json payload() const { return content(message); }
    bool scheduleOn() const { auto view = schedule.get(); return view && checked(view); }
    int delayHours() const { auto host = shell.lock(); return host ? static_cast<int>(object(object(host->state, L"settings"), L"preferences").GetNamedNumber(L"sendDelayHours", 0)) : 0; }
    bool scheduleNeeded() const { return !uncertain && (scheduleOn() || delayHours() > 0 || scheduleAttempt.Size()); }
    void dirty() {
        auto host = shell.lock();
        if (!live(host)) return;
        bool unsaved = false;
        for (auto name : { L"to", L"cc", L"bcc", L"subject", L"body" })
            unsaved = unsaved || !text(message, name).empty();
        if (busy || scheduleOn() || scheduleAttempt.Size() || payload().Stringify() != baseline
            || owner != baselineOwner || (text(message, L"id").empty() && unsaved)) host->dirty.insert(L"compose");
        else host->dirty.erase(L"compose");
    }
    void update() {
        auto host = shell.lock();
        if (!live(host)) return;
        auto isFrozen = frozen();
        for (auto const& reference : fields) if (auto view = reference.get()) view.IsReadOnly(isFrozen);
        if (auto view = from.get()) view.IsEnabled(!isFrozen && !bound && text(message, L"id").empty());
        if (auto view = schedule.get()) view.IsEnabled(!isFrozen);
        if (auto view = scheduleDetails.get()) view.Visibility(scheduleOn() ? xaml::Visibility::Visible : xaml::Visibility::Collapsed);
        if (auto view = date.get()) view.IsEnabled(!isFrozen && scheduleOn());
        if (auto view = time.get()) view.IsEnabled(!isFrozen && scheduleOn());
        if (auto view = reviewed.get()) {
            view.Visibility(uncertain ? xaml::Visibility::Visible : xaml::Visibility::Collapsed);
            view.IsEnabled(!busy);
        }
        bool connected = host->connected(owner);
        if (auto view = save.get()) view.IsEnabled(!isFrozen && !scheduleOn() && connected);
        if (auto view = send.get()) {
            auto review = reviewed.get();
            view.Content(box_value(scheduleNeeded() ? (scheduleAttempt.Size() ? L"Retry Same Schedule" : L"Review & Send Later")
                : uncertain ? L"Review Retry" : L"Review & Send"));
            view.IsEnabled(!busy && !locked(message) && connected && (!uncertain || (review && checked(review))));
        }
        if (auto view = removeFooter.get()) view.IsEnabled(!isFrozen);
        if (auto view = generate.get()) view.IsEnabled(!isFrozen && connected);
        if (auto view = useAI.get()) view.IsEnabled(!isFrozen && !suggestion.empty());
        if (auto view = aiAction.get()) view.IsEnabled(!isFrozen);
        if (auto view = aiPrompt.get()) view.IsReadOnly(isFrozen);
        if (auto view = close.get()) {
            view.IsEnabled(!busy);
            view.Content(box_value(locked(message) || scheduleAttempt.Size() ? L"View Outbox" : L"Close"));
        }
        dirty();
    }
    void say(hstring const& value) { if (auto view = notice) view.Text(value); }
    void clearAI() { suggestion = {}; if (auto view = aiResult) view.Text(L""); }
    void edit(wchar_t const* name, hstring const& value) {
        if (initializing || frozen()) return;
        put(message, name, value); requestId = Service::uuid(); clearAI(); update();
    }
    void restore(Json const& value) {
        initializing = true;
        message = copy(value);
        size_t i = 0;
        for (auto name : { L"to", L"cc", L"bcc", L"subject", L"body" })
            if (auto view = fields[i++].get()) view.Text(text(message, name));
        if (auto view = footer) view.Text(text(object(message, L"footer"), L"text", text(object(message, L"footer"), L"html")));
        initializing = false;
    }
    void markUncertain(Json const& error = Json()) {
        auto record = object(error, L"message");
        if (record.Size() && text(record, L"accountId") == owner && !text(record, L"id").empty()) restore(record);
        if (!text(error, L"draftId").empty()) put(message, L"id", text(error, L"draftId"));
        if (!text(error, L"deliveryRequestId").empty()) requestId = text(error, L"deliveryRequestId");
        put(message, L"deliveryStatus", L"unconfirmed"); put(message, L"deliveryRequestId", requestId);
        uncertain = true; bound = true;
        if (auto view = reviewed.get()) view.IsChecked(false);
        baseline = payload().Stringify(); baselineOwner = owner;
        clearAI();
        say(L"Delivery could not be confirmed. The draft is retained. Check your provider’s Sent folder before retrying this exact message; a retry may send a duplicate.");
    }
};

IAsyncAction replyHistory(std::shared_ptr<Composer> state) {
    auto shell = state->shell.lock(); auto panel = state->history.get();
    if (!state->live(shell) || !panel || state->historyLoading) co_return;
    auto owner = state->owner, id = text(state->message, L"replyToId");
    state->historyLoading = true;
    panel.Children().Clear(); panel.Children().Append(label(L"Loading downloaded messages…"));
    try {
        auto result = co_await shell->service->request(L"/messages/" + escaped(id) + L"/history", owner);
        if (!state->live(shell) || !shell->connected(owner)) { state->historyLoading = false; co_return; }
        require(text(result, L"accountId") == owner && text(result, L"messageId") == id
            && array(result, L"messages").Size() > 0 && array(result, L"messages").Size() <= 20
            && text(array(result, L"messages").GetAt(0).GetObject(), L"id") == id,
            L"Reply history could not be verified for this mailbox.");
        for (auto const& value : array(result, L"messages")) ownedMessage(value.GetObject(), owner);
        panel.Children().Clear();
        for (auto const& value : array(result, L"messages")) {
            auto message = value.GetObject(); auto entry = stack(8);
            entry.Children().Append(label(text(message, L"subject"), 18));
            entry.Children().Append(label(text(message, L"fromName") + L" <" + text(message, L"fromEmail") + L"> · " + mailDateLabel(text(message, L"date")), 12));
            entry.Children().Append(label(L"To: " + text(message, L"to") + (text(message, L"cc").empty() ? L"" : L" · Cc: " + text(message, L"cc")), 12));
            entry.Children().Append(label(text(message, L"body")));
            panel.Children().Append(entry);
        }
        if (flag(result, L"limited")) panel.Children().Append(label(L"Some earlier messages are unavailable, or the 20-message limit was reached.", 12));
    } catch (...) {
        if (state->live(shell)) {
            panel.Children().Clear();
            panel.Children().Append(label(L"Previous messages could not be loaded. Your draft is retained. " + errorText()));
            panel.Children().Append(button(L"Retry", [state] { replyHistory(state); }));
        }
    }
    state->historyLoading = false;
}

// Only the foreground composer write holds this lock; background jobs do not.
struct ComposerWrite {
    std::shared_ptr<Composer> state;
    std::shared_ptr<Shell> shell;
    bool held = true;
    explicit ComposerWrite(std::shared_ptr<Composer> value) : state(std::move(value)), shell(state->shell.lock()) {
        shell->navigation.IsEnabled(false);
        state->busy = true;
    }
    void release() {
        if (!std::exchange(held, false)) return;
        state->busy = false;
        if (!shell->closing && shell->generation == state->generation && shell->section == L"compose") {
            shell->navigation.IsEnabled(true);
            state->update();
        }
    }
    ~ComposerWrite() { try { release(); } catch (...) {} }
};

IAsyncAction submit(std::shared_ptr<Composer> state, bool send) {
    auto shell = state->shell.lock();
    if (!state->live(shell) || state->busy || !shell->navigation.IsEnabled() || locked(state->message) || state->scheduleAttempt.Size()) co_return;
    if (state->uncertain && (!send || !checked(state->reviewed.get()))) co_return;
    auto owner = state->owner;
    if (!shell->connected(owner)) { state->say(L"Reconnect this draft’s mailbox before saving or sending."); co_return; }
    ComposerWrite write(state); state->update(); state->say(L"");
    bool submitted = false;
    try {
        auto payload = copy(state->payload());
        if (send) {
            auto detail = reviewText(owner, payload) + (state->uncertain
                ? L"\n\nYou checked Sent. This explicit retry may send a duplicate." : L"\n\nThe message and displayed footer will be sent together.");
            bool approved = co_await shell->confirm(state->uncertain ? L"Retry this delivery?" : L"Send this message?", detail, L"Send Message");
            if (!approved || !state->live(shell) || state->owner != owner || !shell->connected(owner)) {
                co_return;
            }
        }
        if (!state->uncertain) {
            auto saved = copy(payload);
            if (!text(state->message, L"id").empty()) put(saved, L"id", text(state->message, L"id"));
            auto result = co_await shell->service->request(L"/drafts", owner, L"POST", saved);
            auto message = object(result, L"message"); ownedMessage(message, owner, text(state->message, L"id"));
            if (!state->live(shell) || state->owner != owner) co_return;
            put(state->message, L"id", text(message, L"id")); state->bound = true;
            state->baseline = state->payload().Stringify(); state->baselineOwner = owner;
            state->say(L"Draft saved on this device.");
        }
        if (send && state->live(shell) && shell->connected(owner)) {
            put(payload, L"draftId", text(state->message, L"id")); put(payload, L"requestId", state->requestId);
            payload.Insert(L"retryUnconfirmed", Value::CreateBooleanValue(state->uncertain));
            submitted = true;
            auto result = co_await shell->service->request(L"/send", owner, L"POST", payload);
            ownedMessage(object(result, L"message"), owner, L"sent:" + state->requestId);
            if (!state->live(shell) || state->owner != owner) co_return;
            write.release(); shell->dirty.erase(L"compose");
            co_await shell->navigate(L"mail", owner, L"sent"); co_return;
        }
    } catch (ApiError const& error) {
        if (state->live(shell)) {
            if (flag(error.body, L"requiresSendReview") || (submitted && error.status >= 500)) state->markUncertain(error.body);
            else state->say(error.message());
        }
    } catch (hresult_error const& error) {
        if (state->live(shell)) {
            if (submitted) state->markUncertain();
            else state->say(L"The draft could not be confirmed; sending was not attempted. " + error.message());
        }
    }
}

IAsyncAction scheduleSend(std::shared_ptr<Composer> state) {
    auto shell = state->shell.lock();
    if (!state->live(shell) || state->busy || !shell->navigation.IsEnabled() || state->uncertain || locked(state->message)) co_return;
    auto owner = state->owner;
    if (!shell->connected(owner)) { state->say(L"Reconnect this draft’s mailbox before scheduling."); co_return; }
    ComposerWrite write(state); state->update(); state->say(L"");
    bool previousAttempt = state->scheduleAttempt.Size() != 0;
    try {
        auto value = previousAttempt ? copy(state->scheduleAttempt) : copy(state->payload());
        if (!previousAttempt) {
            put(value, L"requestId", Service::uuid());
            put(value, L"sendAt", state->scheduleOn() ? scheduledTime(state->date.get(), state->time.get()) : delayedTime(state->delayHours()));
            if (!text(state->message, L"id").empty()) put(value, L"draftId", text(state->message, L"id"));
        }
        bool approved = co_await shell->confirm(L"Schedule this message?", reviewText(owner, value)
            + L"\n\nSend at: " + localTime(text(value, L"sendAt"))
            + L"\nMorrow must be open to send. Catch-up is limited to 15 minutes; later messages are marked missed and require a new review. Cancel the schedule before editing its frozen content or time.",
            previousAttempt ? L"Retry Same Schedule" : L"Schedule Message");
        if (!approved || !state->live(shell) || state->owner != owner || !shell->connected(owner)) {
            co_return;
        }
        state->scheduleAttempt = copy(value); state->update();
        auto result = co_await shell->service->request(L"/scheduled", owner, L"POST", value);
        auto job = object(result, L"job");
        require(text(job, L"accountId") == owner && text(job, L"id") == text(value, L"requestId")
            && text(job, L"sendAt") == text(value, L"sendAt"), L"The schedule could not be confirmed.");
        if (!state->live(shell) || state->owner != owner) co_return;
        write.release(); shell->dirty.erase(L"compose");
        co_await shell->navigate(L"scheduled", owner); co_return;
    } catch (ApiError const& error) {
        if (!previousAttempt && error.status < 500) state->scheduleAttempt = Json();
        if (state->live(shell)) state->say(state->scheduleAttempt.Size()
            ? L"Scheduling could not be confirmed. Retry the same request or view Outbox before creating another schedule or sending. " + error.message() : error.message());
    } catch (hresult_error const& error) {
        if (state->live(shell)) state->say(state->scheduleAttempt.Size()
            ? L"Scheduling could not be confirmed. Retry the same request or view Outbox before sending another copy. " + error.message() : error.message());
    }
}

IAsyncAction closeComposer(std::shared_ptr<Composer> state) {
    auto shell = state->shell.lock();
    if (!state->live(shell) || state->busy) co_return;
    try {
        bool scheduled = state->scheduleAttempt.Size() || locked(state->message);
        if (shell->dirty.contains(L"compose")) {
            bool approved = co_await shell->confirm(scheduled ? L"Check Outbox?" : L"Close this draft?",
                scheduled ? L"Check Outbox before sending or scheduling another copy. A submitted schedule may already exist."
                    : L"Unsaved changes will be discarded. Save Draft first to keep them.", L"Close");
            if (!approved || !state->live(shell)) co_return;
        }
        shell->dirty.erase(L"compose");
        co_await shell->navigate(scheduled ? L"scheduled" : L"mail", state->owner, L"drafts");
    } catch (hresult_error const& error) { if (state->live(shell)) state->say(error.message()); }
}

IAsyncAction writingAssistant(std::shared_ptr<Composer> state, bool use) {
    auto shell = state->shell.lock();
    if (!state->live(shell) || state->frozen()) co_return;
    auto owner = state->owner;
    state->busy = true; state->update();
    try {
        if (use) {
            auto suggestion = state->suggestion;
            if (!suggestion.empty() && (text(state->message, L"body").empty()
                || co_await shell->confirm(L"Replace draft text?", L"Recipients and footer stay unchanged. Review the suggestion before sending.", L"Replace"))) {
                if (state->live(shell) && state->owner == owner && shell->connected(owner)) {
                    state->busy = false;
                    state->fields.back().get().Text(suggestion);
                }
            }
        } else {
            auto index = state->aiAction.get().SelectedIndex();
            require(index >= 0 && index < 3, L"Choose a writing action.");
            Json input;
            put(input, L"action", index == 0 ? L"write" : index == 1 ? L"rewrite" : L"translate");
            put(input, L"prompt", state->aiPrompt.get().Text());
            if (index != 0) put(input, L"draftText", text(state->message, L"body"));
            state->clearAI();
            auto result = co_await shell->service->request(L"/ai", owner, L"POST", input);
            if (!state->live(shell) || state->owner != owner || !shell->connected(owner)) co_return;
            state->suggestion = text(result, L"text");
            if (auto view = state->aiResult) view.Text(state->suggestion);
            state->say(text(result, L"source") == L"demo" ? L"Illustrative result — review before using." : L"AI suggestion — review before using.");
        }
    } catch (hresult_error const& error) { if (state->live(shell)) state->say(error.message()); }
    state->busy = false; state->update();
}
}

IAsyncAction compose(std::shared_ptr<Shell> shell, Json draft) {
    if (shell->closing || shell->dialogOpen || !shell->navigation.IsEnabled()) co_return;
    auto generation = shell->generation;
    auto screenOwner = shell->owner;
    try {
        require(!flag(draft, L"providerDraft"), L"Prepare a local copy before opening a provider draft.");
        if (!shell->dirty.empty()) {
            bool approved = co_await shell->confirm(L"Open another draft?", L"Discard the current page’s unsaved changes? Save them first to keep them.", L"Discard Changes");
            if (!approved || shell->generation != generation || shell->owner != screenOwner || shell->closing) co_return;
        }
        auto state = std::make_shared<Composer>(); state->shell = shell;
        state->message = copy(draft); state->screenOwner = screenOwner;
        state->owner = text(draft, L"accountId");
        state->bound = !text(draft, L"id").empty() || !text(draft, L"replyToId").empty()
            || flag(draft, L"forwarding") || flag(draft, L"sourceDraft") || text(draft, L"deliveryStatus") == L"unconfirmed";
        require(!state->bound || !state->owner.empty(), L"This draft has no mailbox owner. Reopen it from its original mailbox.");
        bool replying = !text(draft, L"replyToId").empty();
        Grid editor; editor.MaxWidth(replying ? 1180 : 740); editor.HorizontalAlignment(xaml::HorizontalAlignment::Stretch);
        editor.RowDefinitions().Append(RowDefinition());
        RowDefinition footerRow; footerRow.Height(xaml::GridLengthHelper::Auto()); editor.RowDefinitions().Append(footerRow);
        auto panel = stack(12); panel.Padding(xaml::ThicknessHelper::FromUniformLength(24));
        panel.Children().Append(label(!text(draft, L"id").empty() ? L"Your draft" : flag(draft, L"forwarding") ? L"Forward message"
            : !text(draft, L"replyToId").empty() ? L"Reply" : L"New message", 26));
        ComboBox from; from.Header(box_value(L"From")); from.HorizontalAlignment(xaml::HorizontalAlignment::Stretch);
        state->accounts = mailboxChoices(shell, from); state->from = make_weak(from);
        if (!state->bound && state->owner.empty()) {
            state->owner = screenOwner != L"all" && screenOwner != L"demo" && shell->connected(screenOwner) ? screenOwner
                : state->accounts.empty() ? hstring{} : state->accounts.front();
        }
        require(!state->owner.empty() && shell->connected(state->owner), L"Reconnect the original mailbox before opening this draft.");
        for (size_t i = 0; i < state->accounts.size(); ++i) if (state->accounts[i] == state->owner) from.SelectedIndex(static_cast<int32_t>(i));
        panel.Children().Append(from);
        if (state->bound) panel.Children().Append(label(L"The sending mailbox is locked to this conversation or saved draft."));
        if (flag(draft, L"sourceDraft")) panel.Children().Append(label(L"This is a local copy without attachments. The original Gmail draft stays unchanged in Gmail."));
        if (flag(draft, L"forwarding")) panel.Children().Append(label(L"Forwarding message text only. Attachments are not included."));
        if (text(draft, L"id").empty() && !draft.HasKey(L"footer"))
            state->message.Insert(L"footer", object(object(shell->state, L"settings"), L"footer"));
        for (auto name : { L"to", L"cc", L"bcc", L"subject", L"body" }) {
            auto title = wcscmp(name, L"to") == 0 ? L"To" : wcscmp(name, L"cc") == 0 ? L"Cc"
                : wcscmp(name, L"bcc") == 0 ? L"Bcc" : wcscmp(name, L"subject") == 0 ? L"Subject" : L"Message";
            auto input = field(title, {}, wcscmp(name, L"body") == 0);
            input.MaxLength(26000);
            if (wcscmp(name, L"body") == 0) { input.MinHeight(240); input.MaxLength(100000); }
            if (wcscmp(name, L"subject") == 0) input.MaxLength(500);
            input.Text(text(draft, name));
            state->fields.push_back(make_weak(input));
            input.TextChanged([state, name](auto const& sender, auto const&) { state->edit(name, sender.template as<TextBox>().Text()); });
            panel.Children().Append(input);
        }
        panel.Children().Append(label(L"Use plain addresses separated by commas or semicolons (100 recipients total). Bcc remains hidden from other recipients."));
        auto footerText = label(text(object(state->message, L"footer"), L"text", text(object(state->message, L"footer"), L"html")));
        state->footer = footerText;
        panel.Children().Append(label(L"Email footer")); panel.Children().Append(footerText);
        auto remove = button(L"Remove Footer", [state] {
            if (state->frozen()) return;
            Json empty; put(empty, L"text", L""); put(empty, L"html", L""); state->message.Insert(L"footer", empty);
            if (auto view = state->footer) view.Text(L"");
            state->requestId = Service::uuid(); state->update();
        }); state->removeFooter = make_weak(remove); panel.Children().Append(remove);
        auto ai = stack();
        ComboBox actions; actions.Header(box_value(L"Writing action"));
        for (auto name : { L"Write from instructions", L"Rewrite this draft", L"Translate this draft" }) actions.Items().Append(box_value(name));
        actions.SelectedIndex(0); state->aiAction = make_weak(actions); ai.Children().Append(actions);
        auto prompt = field(L"Instructions / target language"); prompt.MaxLength(2000); state->aiPrompt = make_weak(prompt); ai.Children().Append(prompt);
        auto generate = button(L"Preview Suggestion", [state] { writingAssistant(state, false); }); state->generate = make_weak(generate); ai.Children().Append(generate);
        auto suggestion = label(L""); suggestion.IsTextSelectionEnabled(true); state->aiResult = suggestion; ai.Children().Append(suggestion);
        auto use = button(L"Use in Draft", [state] { writingAssistant(state, true); }); state->useAI = make_weak(use); ai.Children().Append(use);
        Expander assistant; assistant.Header(box_value(L"Writing assistance")); assistant.Content(ai); panel.Children().Append(assistant);
        CheckBox scheduling; scheduling.Content(box_value(L"Schedule for later")); state->schedule = make_weak(scheduling);
        if (state->delayHours() > 0 && !state->uncertain) panel.Children().Append(label(L"Default send delay: " + to_hstring(state->delayHours()) + L" hours. Review the send time before adding this message to Outbox. A custom schedule overrides the default."));
        scheduling.IsChecked(flag(draft, L"scheduleForLater") && text(draft, L"deliveryStatus") != L"unconfirmed"); panel.Children().Append(scheduling);
        DatePicker date; date.Header(box_value(L"Send date (local time)")); date.CalendarIdentifier(L"GregorianCalendar");
        TimePicker time; time.Header(box_value(L"Send time (local time)")); time.MinuteIncrement(1);
        Windows::Globalization::Calendar calendar; calendar.SetToNow(); calendar.AddHours(1);
        date.Date(calendar.GetDateTime());
        SYSTEMTIME local{}; GetLocalTime(&local);
        time.Time(std::chrono::minutes(((local.wHour + 1) % 24) * 60 + local.wMinute));
        auto scheduleDetails = stack(8); state->scheduleDetails = make_weak(scheduleDetails);
        state->date = make_weak(date); state->time = make_weak(time);
        scheduleDetails.Children().Append(date); scheduleDetails.Children().Append(time);
        scheduleDetails.Children().Append(label(L"Morrow must be open to send. Catch-up is limited to 15 minutes; later messages are marked missed. The confirmation also shows the exact UTC time, including at a daylight-saving clock change."));
        panel.Children().Append(scheduleDetails);
        CheckBox review; review.Content(box_value(L"I checked Sent and want to retry this exact delivery, even if it creates a duplicate.")); state->reviewed = make_weak(review); panel.Children().Append(review);
        auto notice = label(L""); notice.IsTextSelectionEnabled(true); state->notice = notice; panel.Children().Append(notice);
        Grid buttons; buttons.ColumnSpacing(12); buttons.Margin(xaml::Thickness{24, 12, 24, 20});
        ColumnDefinition left; left.Width(xaml::GridLengthHelper::Auto()); buttons.ColumnDefinitions().Append(left);
        buttons.ColumnDefinitions().Append(ColumnDefinition());
        ColumnDefinition right; right.Width(xaml::GridLengthHelper::Auto()); buttons.ColumnDefinitions().Append(right);
        ColumnDefinition last; last.Width(xaml::GridLengthHelper::Auto()); buttons.ColumnDefinitions().Append(last);
        auto close = button(L"Close", [state] { closeComposer(state); }); state->close = make_weak(close); buttons.Children().Append(close);
        auto save = button(L"Save Draft", [state] { submit(state, false); }); state->save = make_weak(save); Grid::SetColumn(save, 2); buttons.Children().Append(save);
        auto send = button(L"Review & Send", [state] { if (state->scheduleNeeded()) scheduleSend(state); else submit(state, true); }); state->send = make_weak(send); Grid::SetColumn(send, 3); buttons.Children().Append(send);
        // Scope shortcuts to this composer and preserve each button's enabled/review guards.
        xaml::Input::KeyboardAccelerator saveShortcut;
        saveShortcut.Key(Windows::System::VirtualKey::S);
        saveShortcut.Modifiers(Windows::System::VirtualKeyModifiers::Control);
        saveShortcut.ScopeOwner(editor);
        saveShortcut.Invoked([state](auto const&, auto const& args) {
            auto host = state->shell.lock(); auto view = state->save.get();
            if (!state->live(host) || host->dialogOpen) return;
            args.Handled(true);
            if (view && view.IsEnabled()) submit(state, false);
        });
        save.KeyboardAccelerators().Append(saveShortcut);
        xaml::Input::KeyboardAccelerator sendShortcut;
        sendShortcut.Key(Windows::System::VirtualKey::D);
        sendShortcut.Modifiers(Windows::System::VirtualKeyModifiers::Control | Windows::System::VirtualKeyModifiers::Shift);
        sendShortcut.ScopeOwner(editor);
        sendShortcut.Invoked([state](auto const&, auto const& args) {
            auto host = state->shell.lock(); auto view = state->send.get();
            if (!state->live(host) || host->dialogOpen) return;
            args.Handled(true);
            if (view && view.IsEnabled()) { if (state->scheduleNeeded()) scheduleSend(state); else submit(state, true); }
        });
        send.KeyboardAccelerators().Append(sendShortcut);
        xaml::Input::KeyboardAccelerator closeShortcut;
        closeShortcut.Key(Windows::System::VirtualKey::Escape);
        closeShortcut.ScopeOwner(editor);
        closeShortcut.Invoked([state](auto const&, auto const& args) {
            auto host = state->shell.lock(); auto view = state->close.get();
            if (!state->live(host) || host->dialogOpen) return;
            args.Handled(true);
            if (view && view.IsEnabled()) closeComposer(state);
        });
        close.KeyboardAccelerators().Append(closeShortcut);
        Grid::SetRow(buttons, 1); editor.Children().Append(buttons);
        from.SelectionChanged([state](auto const& sender, auto const&) {
            if (state->frozen() || state->bound) return;
            auto index = sender.template as<ComboBox>().SelectedIndex();
            if (index >= 0 && static_cast<size_t>(index) < state->accounts.size()) {
                state->owner = state->accounts[index]; state->requestId = Service::uuid(); state->clearAI(); state->update();
            }
        });
        scheduling.Checked([state](auto const&, auto const&) { state->update(); });
        scheduling.Unchecked([state](auto const&, auto const&) { state->update(); });
        review.Checked([state](auto const&, auto const&) { state->update(); });
        review.Unchecked([state](auto const&, auto const&) { state->update(); });
        prompt.TextChanged([state](auto const&, auto const&) { state->clearAI(); state->update(); });
        actions.SelectionChanged([state](auto const&, auto const&) { state->clearAI(); state->update(); });
        state->requestId = text(draft, L"deliveryRequestId", Service::uuid());
        state->uncertain = text(draft, L"deliveryStatus") == L"unconfirmed";
        require(!state->uncertain || !text(draft, L"deliveryRequestId").empty(), L"This unconfirmed delivery has no request ID. Reopen its saved draft; do not start a replacement send.");
        state->baseline = state->payload().Stringify(); state->baselineOwner = state->owner;
        shell->dirty.clear();
        shell->section = L"compose"; state->generation = ++shell->generation; ++shell->selectionGeneration;
        // Retain TextBlock peers for this page, including while the AI expander is collapsed.
        panel.Unloaded([state](auto const&, auto const&) { state->notice = nullptr; state->footer = nullptr; state->aiResult = nullptr; });
        Grid columns; columns.ColumnDefinitions().Append(ColumnDefinition());
        columns.Children().Append(scroll(panel));
        if (replying) {
            columns.ColumnSpacing(1);
            columns.ColumnDefinitions().Append(ColumnDefinition());
            auto context = stack(12); context.Padding(xaml::ThicknessHelper::FromUniformLength(24));
            context.Children().Append(label(L"Previous messages", 26));
            context.Children().Append(label(L"Original message and linked local replies. Quoted history stays in the message text.", 12));
            auto history = stack(24); state->history = make_weak(history);
            context.Children().Append(history);
            auto historyScroll = scroll(context); Grid::SetColumn(historyScroll, 1); columns.Children().Append(historyScroll);
        }
        // Keep both panes readable when the main window becomes narrow.
        auto arrange = [replying](auto const& sender, auto const&) {
            if (!replying) return;
            auto grid = sender.template as<Grid>(); bool narrow = grid.ActualWidth() < 900;
            if (grid.RowDefinitions().Size() == (narrow ? 2u : 1u)) return;
            grid.RowDefinitions().Clear(); grid.RowDefinitions().Append(RowDefinition());
            if (narrow) grid.RowDefinitions().Append(RowDefinition());
            grid.ColumnDefinitions().GetAt(1).Width(xaml::GridLengthHelper::FromValueAndType(narrow ? 0 : 1, GridUnitType::Star));
            auto context = grid.Children().GetAt(1).as<xaml::FrameworkElement>();
            Grid::SetColumn(context, narrow ? 0 : 1); Grid::SetRow(context, narrow ? 1 : 0);
        };
        columns.SizeChanged(arrange);
        editor.Children().Append(columns); shell->show(editor);
        if (locked(draft)) state->say(L"This draft is scheduled or sending. Open Outbox and cancel an awaiting schedule before editing or sending it. A delivery already sending cannot be cancelled.");
        else if (state->uncertain) state->say(L"Delivery was not confirmed. Check your provider’s Sent folder before retrying this exact message. Retrying may send a duplicate.");
        state->update();
        if (replying) co_await replyHistory(state);
    } catch (hresult_error const& error) { shell->error(error.message()); }
}

// Native smoke invokes this before opening its first page. No send/save/model call is made.
IAsyncAction composerWriteGuardChecks(std::shared_ptr<Shell> shell) {
    require(std::wstring_view(GetCommandLineW()).find(L"--native-smoke") != std::wstring_view::npos
        && !shell->closing && !shell->dialogOpen && shell->dirty.empty() && shell->navigation.IsEnabled(),
        L"Composer guard checks require an idle native fixture.");
    auto state = std::make_shared<Composer>(); state->shell = shell;
    state->owner = state->screenOwner = shell->owner; state->generation = ++shell->generation;
    state->baselineOwner = state->owner; state->baseline = state->payload().Stringify();
    shell->section = L"compose";
    auto previousPage = shell->page.Content();
    apartment_context ui;
    auto originalState = copy(shell->state);
    auto settings = object(shell->state, L"settings"), preferences = object(settings, L"preferences");
    preferences.Insert(L"sendDelayHours", Value::CreateNumberValue(6)); settings.Insert(L"preferences", preferences); shell->state.Insert(L"settings", settings);
    Button sendReview; state->send = make_weak(sendReview); state->update();
    require(state->scheduleNeeded() && unbox_value<hstring>(sendReview.Content()) == L"Review & Send Later"
        && localTime(delayedTime(6)) != delayedTime(6), L"The global delay did not route ordinary mail to reviewed scheduling.");
    state->uncertain = true; state->update();
    require(!state->scheduleNeeded() && unbox_value<hstring>(sendReview.Content()) == L"Review Retry", L"Global delay bypassed uncertain-delivery review.");
    state->uncertain = false; state->send = {}; shell->state = originalState;
    {
        ComposerWrite write(state);
        co_await resume_after(std::chrono::milliseconds(20)); co_await ui;
        require(state->busy && !shell->navigation.IsEnabled(), L"Composer write did not lock foreground navigation.");
        co_await shell->navigate(L"today", L"blocked-switch@fixture.invalid");
        co_await compose(shell);
        require(shell->generation == state->generation && shell->owner == state->owner
            && shell->section == L"compose" && shell->page.Content() == previousPage && !shell->dialogOpen,
            L"A foreground composer write allowed navigation or a replacement composer.");
        write.release();
        require(!state->busy && shell->navigation.IsEnabled(), L"A completed composer write retained its navigation lock.");
    }
    try { ComposerWrite write(state); throw hresult_error(E_ABORT); }
    catch (hresult_error const&) {}
    require(!state->busy && shell->navigation.IsEnabled() && shell->dirty.empty(),
        L"A failed composer write retained its busy or navigation guard.");
    co_await shell->navigate(L"today", state->owner);
    require(shell->section == L"today" && shell->owner == state->owner && shell->navigation.IsEnabled(),
        L"Composer completion could not navigate after releasing its write guard.");
}

namespace {
struct Schedules {
    std::weak_ptr<Shell> shell;
    uint64_t generation{};
    hstring screenOwner, owner;
    bool busy = false;
    uint64_t loadGeneration = 0;
    std::vector<hstring> accounts;
    weak_ref<ComboBox> mailbox;
    TextBlock notice{nullptr};
    weak_ref<StackPanel> list;
    weak_ref<Button> refresh;
    bool live(std::shared_ptr<Shell> const& host) const {
        return host && !host->closing && host->generation == generation
            && host->owner == screenOwner && host->section == L"scheduled";
    }
    void say(hstring const& value) { if (auto view = notice) view.Text(value); }
    void enable(bool enabled) {
        if (auto view = mailbox.get()) view.IsEnabled(enabled);
        if (auto view = refresh.get()) view.IsEnabled(enabled);
        if (auto view = list.get()) view.IsHitTestVisible(enabled);
    }
};
IAsyncAction loadSchedules(std::shared_ptr<Schedules> state);
IAsyncAction scheduleAction(std::shared_ptr<Schedules> state, Json job, bool cancel, bool reschedule) {
    auto shell = state->shell.lock();
    auto owner = state->owner;
    if (!state->live(shell) || state->busy || text(job, L"accountId") != owner || !shell->connected(owner)) co_return;
    state->busy = true; state->enable(false); state->say(L"");
    try {
        Json message;
        if (cancel) {
            require(cancellable(job), L"This schedule cannot be cancelled. Refresh the list and check Sent.");
            auto approved = co_await shell->confirm(reschedule ? L"Cancel and review a new schedule?" : L"Cancel this schedule?",
                L"Mailbox: " + owner + L"\nSubject: " + text(object(job, L"payload"), L"subject")
                + L"\nThe saved draft will be kept. No replacement will be scheduled until you review and confirm it.", L"Cancel Schedule");
            if (!approved || !state->live(shell) || state->owner != owner || !shell->connected(owner)) {
                state->busy = false; state->enable(true); co_return;
            }
            auto result = co_await shell->service->request(L"/scheduled/" + escaped(text(job, L"id")) + L"/cancel", owner, L"POST");
            auto cancelled = object(result, L"job");
            require(text(cancelled, L"id") == text(job, L"id") && text(cancelled, L"accountId") == owner
                && text(cancelled, L"status") == L"cancelled", L"Cancellation could not be confirmed. Refresh Scheduled before retrying.");
            message = object(result, L"message");
            if (reschedule) {
                ownedMessage(message, owner, text(job, L"draftId"));
                require(!locked(message) && text(message, L"deliveryStatus") != L"unconfirmed", L"Refresh Scheduled and review the saved draft before rescheduling.");
                message = copy(message); message.Insert(L"scheduleForLater", Value::CreateBooleanValue(true));
            }
        } else {
            require(text(job, L"status") == L"uncertain" || flag(job, L"requiresSendReview"), L"Refresh Scheduled before reviewing this delivery.");
            auto result = co_await shell->service->request(L"/messages/" + escaped(text(job, L"draftId")), owner);
            message = object(result, L"message"); ownedMessage(message, owner, text(job, L"draftId"));
            require(text(message, L"deliveryStatus") == L"unconfirmed"
                && text(message, L"deliveryRequestId") == text(job, L"id"), L"Refresh Scheduled and check Sent before retrying this delivery.");
        }
        if (!state->live(shell) || state->owner != owner || !shell->connected(owner)) co_return;
        state->busy = false;
        if (!cancel || reschedule) { co_await compose(shell, message); co_return; }
        co_await loadSchedules(state);
        if (state->live(shell)) state->say(L"Schedule cancelled. The draft is retained and can be edited.");
    } catch (hresult_error const& error) { if (state->live(shell)) state->say(error.message()); }
    state->busy = false; if (state->live(shell)) state->enable(true);
}
IAsyncAction loadSchedules(std::shared_ptr<Schedules> state) {
    auto shell = state->shell.lock();
    if (!state->live(shell) || state->busy) co_return;
    auto owner = state->owner;
    auto generation = ++state->loadGeneration;
    if (!shell->connected(owner)) { state->say(L"Choose a connected mailbox to view its scheduled messages."); co_return; }
    state->busy = true; state->enable(false); state->say(L"Loading scheduled mail…");
    try {
        auto result = co_await shell->service->request(L"/scheduled", owner);
        if (!state->live(shell) || state->owner != owner || generation != state->loadGeneration || !shell->connected(owner)) co_return;
        auto entry = result.TryLookup(L"scheduled");
        require(entry && entry.ValueType() == JsonValueType::Array, L"Scheduled messages could not be loaded.");
        auto jobs = entry.GetArray();
        for (auto const& value : jobs) require(value.ValueType() == JsonValueType::Object
            && text(value.GetObject(), L"accountId") == owner && !text(value.GetObject(), L"id").empty(),
            L"Scheduled messages could not be confirmed for this mailbox.");
        auto list = state->list.get();
        if (!list) co_return;
        list.Children().Clear();
        uint32_t awaiting = 0;
        for (auto const& value : jobs) {
            auto job = value.GetObject(); auto payload = object(job, L"payload");
            if (text(job, L"status") == L"sent" || text(job, L"status") == L"cancelled") continue;
            ++awaiting;
            auto row = stack();
            row.Children().Append(label(text(payload, L"subject", L"(No subject)"), 20));
            auto status = text(job, L"status");
            row.Children().Append(label(owner + L" · " + status));
            row.Children().Append(label(L"Send at: " + localTime(text(job, L"sendAt"))));
            row.Children().Append(label(L"To: " + text(payload, L"to") + L"\nCc: " + text(payload, L"cc") + L"\nBcc: " + text(payload, L"bcc")));
            if (!text(job, L"error").empty()) row.Children().Append(label(text(job, L"error")));
            auto actions = stack(); actions.Orientation(Orientation::Horizontal);
            if (cancellable(job)) {
                actions.Children().Append(button(L"Cancel Schedule", [state, job] { scheduleAction(state, job, true, false); }));
                actions.Children().Append(button(L"Review New Schedule", [state, job] { scheduleAction(state, job, true, true); }));
            }
            if (status == L"uncertain" || flag(job, L"requiresSendReview")) {
                row.Children().Append(label(L"Delivery may already have happened. Check Sent before explicitly retrying. This schedule cannot be cancelled."));
                if (!text(job, L"draftId").empty()) actions.Children().Append(button(L"Review Delivery", [state, job] { scheduleAction(state, job, false, false); }));
            }
            row.Children().Append(actions);
            list.Children().Append(row);
        }
        state->say(awaiting ? L"" : L"No scheduled messages in this mailbox.");
    } catch (hresult_error const& error) {
        if (state->live(shell) && state->owner == owner && generation == state->loadGeneration) state->say(error.message());
    }
    state->busy = false; if (state->live(shell)) state->enable(true);
}
}

IAsyncAction scheduledPage(std::shared_ptr<Shell> shell) {
    auto state = std::make_shared<Schedules>(); state->shell = shell;
    state->screenOwner = shell->owner; state->generation = shell->generation;
    auto panel = stack(16); panel.Margin(xaml::ThicknessHelper::FromUniformLength(28));
    auto heading = stack(7); heading.Margin(xaml::ThicknessHelper::FromLengths(0, 0, 0, 12));
    heading.Children().Append(label(L"Outbox", 30));
    auto detail = label(L"Delayed and scheduled mail waiting to be sent. Morrow must be open to send; catch-up is limited to 15 minutes."); detail.Opacity(0.7); heading.Children().Append(detail);
    panel.Children().Append(heading);
    Grid controls; controls.ColumnSpacing(12);
    ColumnDefinition captionColumn; captionColumn.Width(xaml::GridLengthHelper::Auto()); controls.ColumnDefinitions().Append(captionColumn);
    controls.ColumnDefinitions().Append(ColumnDefinition());
    ColumnDefinition refreshColumn; refreshColumn.Width(xaml::GridLengthHelper::Auto()); controls.ColumnDefinitions().Append(refreshColumn);
    auto caption = label(L"Mailbox"); caption.VerticalAlignment(xaml::VerticalAlignment::Center); controls.Children().Append(caption);
    ComboBox mailbox; mailbox.HorizontalAlignment(xaml::HorizontalAlignment::Stretch);
    xaml::Automation::AutomationProperties::SetName(mailbox, L"Mailbox"); state->mailbox = make_weak(mailbox);
    state->accounts = mailboxChoices(shell, mailbox);
    state->owner = shell->connected(shell->owner) ? shell->owner : state->accounts.empty() ? hstring{} : state->accounts.front();
    for (size_t i = 0; i < state->accounts.size(); ++i) if (state->accounts[i] == state->owner) mailbox.SelectedIndex(static_cast<int32_t>(i));
    Grid::SetColumn(mailbox, 1); controls.Children().Append(mailbox);
    auto refresh = button(L"Refresh", [state] { loadSchedules(state); }); state->refresh = make_weak(refresh);
    Grid::SetColumn(refresh, 2); controls.Children().Append(refresh); panel.Children().Append(controls);
    auto notice = label(L""); notice.IsTextSelectionEnabled(true); state->notice = notice; panel.Children().Append(notice);
    auto list = stack(24); state->list = make_weak(list); panel.Children().Append(list);
    auto guidance = label(L"Scheduled and sending drafts are locked. Cancel an awaiting schedule before editing; sending and uncertain deliveries cannot be cancelled. Missed messages need a new review.", 12); guidance.Opacity(0.7); panel.Children().Append(guidance);
    mailbox.SelectionChanged([state](auto const& sender, auto const&) {
        if (state->busy) return;
        auto index = sender.template as<ComboBox>().SelectedIndex();
        if (index >= 0 && static_cast<size_t>(index) < state->accounts.size()) {
            state->owner = state->accounts[index]; state->list.get().Children().Clear(); loadSchedules(state);
        }
    });
    xaml::DispatcherTimer timer;
    timer.Interval(std::chrono::seconds(5));
    timer.Tick([weak = std::weak_ptr<Schedules>(state)](auto const&, auto const&) {
        if (auto page = weak.lock()) if (auto host = page->shell.lock(); page->live(host) && !page->busy) loadSchedules(page);
    });
    panel.Loaded([timer](auto const&, auto const&) { timer.Start(); });
    panel.Unloaded([timer, state](auto const&, auto const&) { timer.Stop(); state->notice = nullptr; });
    shell->show(scroll(panel));
    co_await loadSchedules(state);
}
}
