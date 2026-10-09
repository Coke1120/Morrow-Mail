#include "pch.h"
#include "Ui.h"
#include <winrt/Windows.System.h>
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <map>
#include <cmath>

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
using namespace Windows::Data::Json;
using namespace controls;
namespace {
struct SettingsPage;
struct Editor;
using Page = std::shared_ptr<SettingsPage>;
using Form = std::shared_ptr<Editor>;

Json copy(Json const& value) { return Json::Parse(value.Stringify()); }
void boolean(Json const& value, wchar_t const* key, bool enabled) {
    value.Insert(key, Value::CreateBooleanValue(enabled));
}
hstring number(Json const& value, wchar_t const* key) {
    auto item = value.TryLookup(key);
    return item && item.ValueType() == JsonValueType::Number ? item.Stringify() : L"0";
}
bool checked(CheckBox const& input) { auto value = input.IsChecked(); return value && value.Value(); }
void remove(Json const& value, wchar_t const* key) { if (value.HasKey(key)) value.Remove(key); }
IJsonValue get(Json const& source, std::wstring const& path) {
    auto dot = path.find(L'.');
    return dot == std::wstring::npos ? source.TryLookup(path) : object(source, path.substr(0, dot).c_str()).TryLookup(path.substr(dot + 1));
}
void set(Json const& source, std::wstring const& path, IJsonValue const& value) {
    auto dot = path.find(L'.');
    if (dot == std::wstring::npos) source.Insert(path, value);
    else {
        auto key = path.substr(0, dot);
        auto group = object(source, key.c_str());
        group.Insert(path.substr(dot + 1), value);
        source.Insert(key, group);
    }
}
Json pick(Json const& source, std::initializer_list<wchar_t const*> keys) {
    Json result;
    for (auto key : keys) if (auto value = source.TryLookup(key)) result.Insert(key, value);
    return copy(result);
}

struct Editor {
    std::weak_ptr<SettingsPage> page;
    Json value, saved;
    std::wstring key;
    StackPanel panel{nullptr};
    ContentControl container{nullptr};
    PasswordBox secret{nullptr};
    bool loading = false, automatic = false, locked = false;
    std::map<std::wstring, TextBox> fields;
    std::map<std::wstring, CheckBox> checks;
    std::map<std::wstring, ComboBox> choices;
    std::map<std::wstring, NumberBox> numbers;
    Expander disclosure{nullptr};
    bool changed() const { return value.Stringify() != saved.Stringify() || (secret && !secret.Password().empty()); }
    void edit();
    void update();
    void accept(Json const& next);
};
struct SettingsPage : std::enable_shared_from_this<SettingsPage> {
    std::shared_ptr<Shell> shell;
    hstring owner, tab;
    uint64_t generation, revision = 0;
    bool live = true, busy = false, saving = false, polling = false, saveFailed = false;
    StackPanel body{nullptr};
    StackPanel connectionsPanel{nullptr};
    Form importOptions;
    Json connections;
    std::map<std::wstring, StackPanel> calendarStatus;
    Expander mailDisclosure{nullptr};
    TextBlock notice{nullptr};
    xaml::DispatcherTimer timer{nullptr}, autosave{nullptr};
    std::vector<Form> forms;
    Json searchState, updateState, release;
    bool prereleases = true;
    std::wstring busyKey;
    // Navigation changes generation. OAuth/background owner changes must keep
    // this page and its edits alive; requests retain the captured owner.
    bool current() const { return live && !shell->closing && shell->generation == generation; }
    void tell(hstring const& value) { if (current() && notice) notice.Text(value); }
    void dispose() {
        if (!live) return;
        live = false;
        if (timer) timer.Stop();
        if (autosave) autosave.Stop();
        for (auto const& form : forms) {
            if (form->secret) form->secret.Password(L"");
            shell->dirty.erase(form->key);
            // Release button closures that refer to their form and any entered
            // credential controls when this page leaves the visual tree.
            if (form->panel) form->panel.Children().Clear();
        }
        // An in-flight request retains its own busy marker until it finishes.
        forms.clear(); importOptions.reset(); calendarStatus.clear(); connectionsPanel = nullptr;
        body = nullptr; mailDisclosure = nullptr; notice = nullptr; timer = nullptr; autosave = nullptr;
    }
};
IAsyncAction refreshConnections(Page p, bool automatic = false);

void Editor::edit() {
    auto p = page.lock();
    if (!p || !p->current() || loading) return;
    if (changed()) p->shell->dirty.insert(key); else p->shell->dirty.erase(key);
    if (automatic && p->autosave) {
        p->saveFailed = false;
        p->autosave.Stop(); p->autosave.Start();
        p->tell(L"Waiting to save preferences…");
    }
}
void Editor::update() {
    loading = true;
    for (auto const& [path, control] : fields) {
        auto item = get(value, path);
        control.Text(item && item.ValueType() == JsonValueType::String ? item.GetString() : L"");
    }
    for (auto const& [path, control] : checks) {
        auto item = get(value, path);
        control.IsChecked(item && item.ValueType() == JsonValueType::Boolean && item.GetBoolean());
    }
    for (auto const& [path, control] : numbers) {
        auto item = get(value, path);
        if (item && item.ValueType() == JsonValueType::Number) control.Value(item.GetNumber());
    }
    for (auto const& [path, control] : choices) {
        auto item = get(value, path);
        if (!item) continue;
        for (uint32_t i = 0; i < control.Items().Size(); ++i) {
            auto entry = control.Items().GetAt(i).as<ComboBoxItem>();
            if (unbox_value<hstring>(entry.Tag()) == item.Stringify()) control.SelectedIndex(static_cast<int32_t>(i));
        }
    }
    loading = false;
}
void Editor::accept(Json const& next) {
    value = copy(next); saved = copy(next);
    if (secret) secret.Password(L"");
    if (secret) secret.IsEnabled(!flag(value, L"clearApiKey"));
    update();
    if (auto p = page.lock()) p->shell->dirty.erase(key);
}

Form form(Page const& p, StackPanel const& into, Json const& values, wchar_t const* id, bool automatic = false) {
    auto result = std::make_shared<Editor>();
    result->page = p; result->value = copy(values); result->saved = copy(values);
    result->key = L"settings:" + std::to_wstring(p->generation) + L":" + id;
    result->panel = stack(12); result->automatic = automatic;
    result->container = ContentControl();
    result->container.HorizontalContentAlignment(xaml::HorizontalAlignment::Stretch);
    result->container.Content(result->panel);
    into.Children().Append(result->container); p->forms.push_back(result);
    return result;
}
void help(StackPanel const& panel, hstring const& detail) { panel.Children().Append(label(detail)); }
void title(StackPanel const& panel, hstring const& value) { panel.Children().Append(label(value, 20)); }
TextBox input(Form const& f, wchar_t const* path, wchar_t const* caption, int limit = 200, bool multiline = false) {
    auto value = get(f->value, path);
    auto control = field(caption, value && value.ValueType() == JsonValueType::String ? value.GetString() : L"", multiline);
    control.MaxLength(limit);
    std::weak_ptr<Editor> weak = f;
    control.TextChanged([weak, key = std::wstring(path)](auto const& sender, auto const&) {
        if (auto item = weak.lock(); item && !item->loading) {
            set(item->value, key, Value::CreateStringValue(sender.template as<TextBox>().Text())); item->edit();
        }
    });
    f->fields[path] = control; f->panel.Children().Append(control); return control;
}
CheckBox toggle(Form const& f, wchar_t const* path, hstring const& caption) {
    CheckBox control; control.Content(box_value(caption));
    auto value = get(f->value, path);
    control.IsChecked(value && value.ValueType() == JsonValueType::Boolean && value.GetBoolean());
    std::weak_ptr<Editor> weak = f;
    control.Click([weak, key = std::wstring(path)](auto const& sender, auto const&) {
        if (auto item = weak.lock(); item && !item->loading) {
            set(item->value, key, Value::CreateBooleanValue(checked(sender.template as<CheckBox>()))); item->edit();
        }
    });
    f->checks[path] = control; f->panel.Children().Append(control); return control;
}
NumberBox numeric(Form const& f, wchar_t const* path, wchar_t const* caption, double minimum, double maximum, double step = 1) {
    NumberBox control; control.Header(box_value(caption)); control.Minimum(minimum); control.Maximum(maximum);
    control.SmallChange(step); control.SpinButtonPlacementMode(NumberBoxSpinButtonPlacementMode::Compact);
    auto value = get(f->value, path); if (value && value.ValueType() == JsonValueType::Number) control.Value(value.GetNumber());
    std::weak_ptr<Editor> weak = f;
    control.ValueChanged([weak, key = std::wstring(path)](NumberBox const& sender, auto const&) {
        if (auto item = weak.lock(); item && !item->loading) {
            set(item->value, key, std::isfinite(sender.Value()) ? Value::CreateNumberValue(sender.Value()) : Value::CreateNullValue()); item->edit();
        }
    });
    f->numbers[path] = control; f->panel.Children().Append(control); return control;
}
ComboBox choice(Form const& f, wchar_t const* path, wchar_t const* caption,
    std::initializer_list<std::pair<wchar_t const*, wchar_t const*>> options, bool numericValue = false) {
    ComboBox control; control.Header(box_value(caption)); control.HorizontalAlignment(xaml::HorizontalAlignment::Stretch);
    auto value = get(f->value, path);
    for (auto const& [key, name] : options) {
        auto stored = numericValue ? Value::CreateNumberValue(std::stod(key)) : Value::CreateStringValue(key);
        ComboBoxItem item; item.Content(box_value(name)); item.Tag(box_value(stored.Stringify()));
        control.Items().Append(item);
        if (value && value.Stringify() == stored.Stringify()) control.SelectedItem(item);
    }
    std::weak_ptr<Editor> weak = f;
    control.SelectionChanged([weak, key = std::wstring(path)](auto const& sender, auto const&) {
        if (auto item = weak.lock(); item && !item->loading) {
            auto selected = sender.template as<ComboBox>().SelectedItem().template try_as<ComboBoxItem>();
            if (selected) { set(item->value, key, Value::Parse(unbox_value<hstring>(selected.Tag()))); item->edit(); }
        }
    });
    f->choices[path] = control; f->panel.Children().Append(control); return control;
}
PasswordBox password(Form const& f, wchar_t const* caption) {
    PasswordBox control; control.Header(box_value(caption)); control.MaxLength(4096);
    control.PasswordRevealMode(PasswordRevealMode::Hidden);
    std::weak_ptr<Editor> weak = f;
    control.PasswordChanged([weak](auto const&, auto const&) { if (auto item = weak.lock()) item->edit(); });
    f->secret = control; f->panel.Children().Append(control); return control;
}

// The owning std::function stays in this coroutine frame while a coroutine
// callback awaits; no suspended callback borrows a destroyed button closure.
fire_and_forget run(Page p, std::function<IAsyncAction()> action) {
    if (!p->current() || p->busy || p->saving) co_return;
    p->busy = true; ++p->revision; p->shell->dirty.insert(p->busyKey);
    p->shell->navigation.IsEnabled(false);
    for (auto const& f : p->forms) f->container.IsEnabled(false);
    p->tell(L"Working…");
    try { co_await action(); }
    catch (hresult_error const& error) { p->tell(error.message()); }
    catch (...) { p->tell(L"The operation could not finish. Your saved data is retained. Try again."); }
    p->shell->dirty.erase(p->busyKey); p->busy = false;
    if (!p->shell->closing) p->shell->navigation.IsEnabled(true);
    if (p->current()) for (auto const& f : p->forms) f->container.IsEnabled(!f->locked);
}
void action(Page const& p, StackPanel const& into, hstring const& caption,
    std::function<IAsyncAction(Page)> task) {
    std::weak_ptr<SettingsPage> weak = p;
    into.Children().Append(button(caption, [weak, task = std::move(task)] {
        if (auto page = weak.lock()) run(page, [page, task] { return task(page); });
    }));
}
Json patch(Form const& f) {
    Json result;
    for (auto const& item : f->value) {
        auto old = f->saved.TryLookup(item.Key());
        if (!old || old.Stringify() != item.Value().Stringify()) result.Insert(item.Key(), item.Value());
    }
    if (result.HasKey(L"signature") || result.HasKey(L"signatureFormat")) {
        result.Insert(L"signature", f->value.Lookup(L"signature"));
        result.Insert(L"signatureFormat", f->value.Lookup(L"signatureFormat"));
    }
    return copy(result);
}
IAsyncAction savePreferences(Page p, Form f) {
    if (!p->current() || p->saving || p->busy) co_return;
    p->autosave.Stop();
    auto sent = patch(f);
    if (!sent.Size()) co_return;
    p->saving = true; p->shell->navigation.IsEnabled(false); p->shell->dirty.insert(p->busyKey); p->tell(L"Saving preferences…");
    try {
        auto result = co_await p->shell->service->request(L"/settings/preferences", p->owner, L"POST", sent);
        if (p->current()) {
            auto received = object(object(result, L"settings"), L"preferences");
            bool sameFooter = text(f->value, L"signature") == text(sent, L"signature") && text(f->value, L"signatureFormat") == text(sent, L"signatureFormat");
            for (auto const& item : sent) {
                auto next = received.TryLookup(item.Key());
                if (!next) throw hresult_error(E_FAIL, L"The service did not acknowledge preferences. Retry saving.");
                auto now = f->value.TryLookup(item.Key());
                if (now && now.Stringify() == item.Value().Stringify() &&
                    ((item.Key() != L"signature" && item.Key() != L"signatureFormat") || sameFooter)) f->value.Insert(item.Key(), next);
                f->saved.Insert(item.Key(), next);
            }
            auto settings = object(p->shell->state, L"settings");
            settings.Insert(L"preferences", received);
            settings.Insert(L"footer", object(object(result, L"settings"), L"footer"));
            p->shell->state.Insert(L"settings", settings);
            f->update();
            if (!f->changed()) p->shell->dirty.erase(f->key);
            p->saveFailed = false; p->tell(f->changed() ? L"Saving your newer changes next…" : L"Preferences saved automatically.");
        }
    } catch (hresult_error const& error) { p->saveFailed = true; p->tell(error.message() + L" Your edits are retained. Retry saving."); }
    catch (...) { p->saveFailed = true; p->tell(L"Preferences were not saved. Your edits are retained. Retry saving."); }
    p->saving = false; p->shell->dirty.erase(p->busyKey);
    if (!p->shell->closing) p->shell->navigation.IsEnabled(true);
    if (p->current() && f->changed() && !p->saveFailed) p->autosave.Start();
}

IAsyncAction changeTab(Page p, hstring next) {
    if (!p->current() || p->busy || p->saving) co_return;
    if (p->tab == L"general" && !p->forms.empty()) {
        co_await savePreferences(p, p->forms.front());
        if (!p->current() || p->forms.front()->changed()) co_return;
    }
    bool dirty = std::any_of(p->forms.begin(), p->forms.end(), [](auto const& f) { return f->changed(); });
    if (dirty && !(co_await p->shell->confirm(L"Discard unsaved settings?", L"Only saved settings take effect. Entered keys and unsaved edits will be discarded.", L"Discard"))) co_return;
    if (!p->current()) co_return;
    auto shell = p->shell;
    p->dispose();
    co_await settingsPage(shell, next);
}
void start(Page const& p) {
    title(p->body, L"Start here");
    help(p->body, L"Connect your mailbox, see what needs attention in Today, then review your first suggested reply. AI setup is optional.");
    std::weak_ptr<SettingsPage> weak = p;
    auto step = [&](hstring heading, hstring detail, hstring actionText, hstring tab) {
        auto panel = stack(8); panel.Padding(xaml::ThicknessHelper::FromUniformLength(8));
        title(panel, heading); help(panel, detail);
        panel.Children().Append(button(actionText, [weak, tab] { if (auto page = weak.lock()) changeTab(page, tab); }));
        p->body.Children().Append(panel);
    };
    uint32_t accounts = 0;
    for (auto const& value : array(p->shell->state, L"accounts")) {
        auto id = text(value.GetObject(), L"id");
        if (!id.empty() && id != L"demo" && id != L"all") ++accounts;
    }
    hstring accountDetail = accounts ? to_hstring(accounts) + L" mail account(s) connected." :
        hstring(L"Add a Gmail, Outlook or IMAP account to see your inbox.");
    step(L"1 · Connect your mail", accountDetail, accounts ? L"Manage Accounts" : L"Add an Account", L"mail");
    p->body.Children().Append(button(L"Open Today",[weak]{ if (auto page=weak.lock()) page->shell->navigate(L"today"); }));
    step(L"2 · Set up AI help (optional)", flag(object(object(p->shell->state, L"settings"), L"ai"), L"configured") ?
        L"AI connection saved. Online AI receives only the mail you permit and may charge for requests." :
        L"AI can help write replies and summarize mail. Ask your IT support or AI provider for the connection details. You can still use mail without AI.",
        L"Set Up AI", L"model");
    step(L"3 · Decide what AI can use", L"Choose which downloaded mail folders and fields AI may read. Automatic summaries start only when you enable a trigger.",
        L"Review AI & Privacy", L"policy");
}
void general(Page const& p) {
    title(p->body, L"Make yourself at home"); help(p->body, L"Choose how Morrow looks, writes, and keeps your inbox up to date. Preferences save automatically.");
    auto f = form(p, p->body, object(object(p->shell->state, L"settings"), L"preferences"), L"general", true);
    title(f->panel, L"Appearance & reading");
    choice(f, L"theme", L"Theme", {{L"system", L"Match device"}, {L"light", L"Light"}, {L"dark", L"Dark"}});
    choice(f, L"density", L"Mail list density", {{L"comfortable", L"Comfortable"}, {L"compact", L"Compact"}, {L"spacious", L"Spacious"}});
    toggle(f, L"markReadOnOpen", L"Mark mail as read when opened");
    help(f->panel, L"Gmail, Outlook and IMAP read/star changes sync to the server. Gmail/Outlook require mail organization permission. Pending/Read Later stay local. Cached-mail checks resume at the configured sync interval.");
    toggle(f, L"autoLoadExternalImages", L"Automatically load external images (HTTPS)");
    help(f->panel, L"Applies to all mailboxes. Image servers may learn your IP address and that you opened an email. You can still hide images for individual messages.");
    title(f->panel, L"Mail sync");
    choice(f, L"syncInterval", L"Sync all accounts while Morrow is open", {{L"0", L"Manually"}, {L"1", L"Every minute"}, {L"5", L"Every 5 minutes"}, {L"15", L"Every 15 minutes"}, {L"30", L"Every 30 minutes"}}, true);
    help(f->panel, L"Fetches recent messages first, then reconciles a bounded batch of older downloaded mail at each sync. Large caches take multiple cycles. Failed provider writes are not retried automatically.");
    title(f->panel, L"Sending");
    choice(f, L"sendDelayHours", L"Default send delay · all accounts", {{L"0", L"Immediately"}, {L"1", L"1 hour"}, {L"2", L"2 hours"}, {L"3", L"3 hours"}, {L"4", L"4 hours"}, {L"5", L"5 hours"}, {L"6", L"6 hours"}}, true);
    help(f->panel, L"Delayed messages appear in Outbox. Keep Morrow open at the send time. A custom schedule overrides this default; changing it does not alter mail already queued.");
    title(f->panel, L"Writing & language");
    help(f->panel, L"Display name and footer apply across accounts. Confirmed Learning identity remains account-specific.");
    input(f, L"displayName", L"Display name", 100);
    choice(f, L"signatureFormat", L"Footer format", {{L"plain", L"Plain text"}, {L"html", L"HTML"}});
    input(f, L"signature", L"Signature / HTML source", 12000, true);
    help(f->panel, L"Saved drafts retain their reviewed footer. HTML supports text, tables and links; images and active content are removed.");
    action(p, f->panel, L"Preview footer text", [f](Page page) -> IAsyncAction {
        auto result = co_await page->shell->service->request(L"/signature/preview", page->owner, L"POST", pick(f->value, {L"signature", L"signatureFormat"}));
        if (page->current()) co_await page->shell->alert(L"Sanitized footer — text fallback", text(object(result, L"footer"), L"text", L"(Empty footer)"));
    });
    choice(f, L"replyTone", L"Default reply tone", {{L"friendly", L"Friendly"}, {L"professional", L"Professional"}, {L"concise", L"Concise"}, {L"warm", L"Warm"}});
    input(f, L"language", L"Preferred AI response language", 60);
    input(f, L"translationLanguage", L"Translation language (blank uses preferred language)", 60);
    std::weak_ptr<SettingsPage> weak = p;
    p->autosave = xaml::DispatcherTimer(); p->autosave.Interval(std::chrono::milliseconds(500));
    p->autosave.Tick([weak, f](auto const&, auto const&) { if (auto page = weak.lock()) savePreferences(page, f); });
    p->body.Children().Append(button(L"Retry saving preferences", [weak, f] { if (auto page = weak.lock()) savePreferences(page, f); }));
    p->tell(L"Preferences saved automatically.");
}

IAsyncAction launchOAuth(Page p, Json result, hstring provider, bool calendar) {
    if (!p->current()) co_return;
    Uri url(text(result, L"url")); Uri local(p->shell->service->origin());
    auto expected = L"/api/" + hstring(calendar ? L"calendar-oauth/" : L"oauth/") + provider + L"/authorize";
    auto query = url.QueryParsed();
    if (url.SchemeName() != L"http" || url.Host() != L"localhost" || url.Port() != local.Port() ||
        url.Path() != expected || !url.UserName().empty() || !url.Password().empty() || !url.Fragment().empty() ||
        query.Size() != 1 || query.GetAt(0).Name() != L"state" || query.GetAt(0).Value().empty() || query.GetAt(0).Value().size() > 200)
        throw hresult_error(E_INVALIDARG, L"The sign-in URL is invalid. Start sign-in again.");
    if (!(co_await Windows::System::Launcher::LaunchUriAsync(url))) throw hresult_error(E_FAIL, L"Windows could not open your browser.");
    p->tell(L"Complete sign-in in your browser and keep Morrow open. Connections refresh automatically.");
}

Form historyOptions(Page const& p, StackPanel const& into) {
    Json options; options.Insert(L"months", Value::CreateNumberValue(3));
    boolean(options, L"allMail", true); boolean(options, L"inbox", true); boolean(options, L"sent", true);
    auto f = form(p, into, options, L"import-options");
    choice(f, L"months", L"History range", {{L"0", L"All available history"}, {L"1", L"Last month"}, {L"3", L"Last 3 months"}, {L"6", L"Last 6 months"}, {L"12", L"Last 12 months"}}, true);
    toggle(f, L"allMail", L"All normal folders"); toggle(f, L"inbox", L"Inbox (when All normal folders is off)"); toggle(f, L"sent", L"Sent (when All normal folders is off)");
    help(f->panel, L"New imports fetch the latest seven days first, then older history. Gmail / Outlook exclude Spam/Junk and Trash. IMAP relies on special-use flags and skips virtual/non-selectable folders. Imported mail stays local; this does not call AI.");
    return f;
}

void mailEditor(Page const& p, StackPanel const& into, Form const& history, Json const& existing = Json()) {
    auto clients = object(object(p->shell->state, L"settings"), L"oauthClients");
    for (auto provider : {L"google", L"microsoft"}) {
        Expander expander; expander.Header(box_value(provider == std::wstring_view(L"google") ? L"Gmail — browser sign-in" : L"Outlook / Microsoft 365 — browser sign-in"));
        auto content = stack(12); expander.Content(content); expander.HorizontalAlignment(xaml::HorizontalAlignment::Stretch); into.Children().Append(expander);
        Json initial; boolean(initial, L"useDefaultClient", flag(object(clients, provider), L"configured")); put(initial, L"clientId", L"");
        auto f = form(p, content, initial, provider);
        toggle(f, L"useDefaultClient", L"Use Morrow’s bundled OAuth client");
        input(f, L"clientId", L"Own desktop application client ID (only when bundled client is off)", 1000);
        if (provider == std::wstring_view(L"google")) password(f, L"Own Google desktop client secret");
        help(content, L"Sign-in includes reading, sending and organizing mail, including moving to Trash. Sign in again to update access for older connections.");
        help(content, L"Microsoft desktop clients need no secret. For Google custom clients, use Desktop app credentials. Keep Morrow open for the browser callback; reconnecting preserves other accounts.");
        action(p, content, L"Sign in through browser", [f, history, provider = hstring(provider)](Page page) -> IAsyncAction {
            auto body = pick(f->value, {L"useDefaultClient"});
            if (!flag(body, L"useDefaultClient")) { put(body, L"clientId", text(f->value, L"clientId")); if (f->secret) put(body, L"clientSecret", f->secret.Password()); }
            body.Insert(L"importOptions", copy(history->value));
            struct Clear { Form f; Json body; ~Clear() { if (f->secret) f->secret.Password(L""); remove(body, L"clientSecret"); } } clear{f, body};
            auto result = co_await page->shell->service->request(L"/oauth/" + provider + L"/start", page->owner, L"POST", body);
            if (!page->current()) co_return;
            f->accept(f->value); history->accept(history->value);
            co_await launchOAuth(page, result, provider, false);
        });
    }
    Expander expander; expander.Header(box_value(L"Yahoo Mail / HK and other IMAP accounts")); expander.IsExpanded(existing.Size() != 0);
    auto content = stack(12); expander.Content(content); expander.HorizontalAlignment(xaml::HorizontalAlignment::Stretch); into.Children().Append(expander);
    Json initial; put(initial, L"email", text(existing, L"email")); put(initial, L"imapHost", text(existing, L"imapHost", L"imap.gmail.com")); put(initial, L"smtpHost", text(existing, L"smtpHost", L"smtp.gmail.com"));
    initial.Insert(L"imapPort", Value::CreateNumberValue(existing.GetNamedNumber(L"imapPort", 993)));
    initial.Insert(L"smtpPort", Value::CreateNumberValue(existing.GetNamedNumber(L"smtpPort", 465)));
    auto f = form(p, content, initial, L"imap");
    f->disclosure = expander;
    input(f, L"email", L"Full email address", 254); password(f, L"App password");
    input(f, L"imapHost", L"IMAP server", 253); numeric(f, L"imapPort", L"IMAP TLS port", 1, 65535);
    input(f, L"smtpHost", L"SMTP server", 253); choice(f, L"smtpPort", L"SMTP port", {{L"465", L"465 — TLS"}, {L"587", L"587 — STARTTLS"}}, true);
    std::weak_ptr<SettingsPage> weak = p;
    content.Children().Append(button(L"Use Yahoo Mail / HK settings", [weak, f] {
        if (auto page = weak.lock(); page && page->current() && !page->busy) {
            put(f->value, L"imapHost", L"imap.mail.yahoo.com"); put(f->value, L"smtpHost", L"smtp.mail.yahoo.com");
            f->value.Insert(L"imapPort", Value::CreateNumberValue(993)); f->value.Insert(L"smtpPort", Value::CreateNumberValue(465));
            f->secret.Password(L""); f->update(); f->edit();
        }
    }));
    help(content, L"Yahoo HK works with your full @yahoo.com.hk address and a Yahoo app password. A blank password is kept only for the same existing address and unchanged servers. Passwords are never read back here.");
    action(p, content, L"Connect / update and import", [f, history](Page page) -> IAsyncAction {
        auto body = copy(f->value); if (!f->secret.Password().empty()) put(body, L"password", f->secret.Password());
        body.Insert(L"importOptions", copy(history->value));
        struct Clear { Form f; Json body; ~Clear() { f->secret.Password(L""); remove(body, L"password"); } } clear{f, body};
        auto result = co_await page->shell->service->request(L"/settings/mail", page->owner, L"POST", body);
        if (!page->current()) co_return;
        f->accept(f->value); history->accept(history->value);
        // Do not replace the selected owner with the newly connected account.
        page->shell->state.Insert(L"accounts", array(result, L"accounts")); page->shell->rebuildNavigation();
        co_await refreshConnections(page);
        page->tell(L"Connected. History imports while Morrow is open; progress refreshes automatically.");
    });
}

void accounts(Page const& p, StackPanel const& panel, Json const& state, Form const& history) {
    panel.Children().Clear();
    for (auto const& value : array(state, L"accounts")) {
        auto account = value.GetObject(); auto owner = text(account, L"id");
        if (owner == L"demo" || owner == L"all" || owner.empty()) continue;
        auto job = object(account, L"import"); auto status = text(job, L"status");
        title(panel, text(account, L"email") + L" · " + text(account, L"provider"));
        help(panel, status.empty() ? L"History import has not started." : L"History: " + status + L" · " + (text(job, L"downloadStage") == L"recent" ? L"Latest seven days first" : L"Older history") + L" · " + text(job, L"phase") + L" · " + number(job, L"imported") + L" imported · " + number(job, L"processed") + L" checked · " + number(job, L"pages") + L" pages");
        if (!text(job, L"error").empty()) help(panel, text(job, L"error"));
        if (!text(job, L"nextRetryAt").empty()) help(panel, L"Next retry: " + text(job, L"nextRetryAt") + L" · retry " + number(job, L"retryCount"));
        auto recovery = text(job, L"recoveryAction");
        if (recovery == L"reconnect") help(panel, L"Reconnect this mailbox above, then start a new import. Existing cached mail is retained.");
        if (recovery == L"restart") help(panel, L"Start a new import to replace the unusable checkpoint. Downloaded mail is retained.");
        if (status != L"running") action(p, panel, L"Start new history import…", [history, owner](Page page) -> IAsyncAction {
            auto options = copy(history->value);
            if (!(co_await page->shell->confirm(L"Start history import?", owner + L"\n" + (options.GetNamedNumber(L"months", 3) == 0 ? hstring(L"All available history") : number(options, L"months") + L" months") + L"\n" + (flag(options, L"allMail") ? hstring(L"All normal folders") : hstring(L"Selected Inbox / Sent folders")) + L"\nCached mail is retained. No AI call is made.", L"Start import")) || !page->current()) co_return;
            co_await page->shell->service->request(L"/imports/start", owner, L"POST", options);
            if (page->current()) { history->accept(history->value); page->tell(L"History import started. Refresh progress for its current status."); }
        });
        bool resume = (status == L"paused" || status == L"failed" || status == L"interrupted" || status == L"stopped") && recovery != L"reconnect" && recovery != L"restart";
        if (status == L"running" || resume) action(p, panel, resume ? L"Resume from checkpoint" : L"Pause import", [owner, resume](Page page) -> IAsyncAction {
            co_await page->shell->service->request(resume ? L"/imports/resume" : L"/imports/pause", owner, L"POST");
            page->tell(L"Import updated. Refresh progress to see the current checkpoint.");
        });
        if (text(account, L"provider") == L"imap") action(p, panel, L"Load IMAP connection for editing", [account](Page page) -> IAsyncAction {
            for (auto const& f : page->forms) if (f->key.ends_with(L":imap")) {
                if (f->changed() && !(co_await page->shell->confirm(L"Discard IMAP edits?", L"Load this account’s saved server addresses. Saved passwords remain private.", L"Load connection"))) co_return;
                if (!page->current()) co_return;
                auto config = object(account, L"settings");
                if (text(config, L"email").empty()) put(config, L"email", text(account, L"email"));
                f->accept(pick(config, {L"email", L"imapHost", L"imapPort", L"smtpHost", L"smtpPort"}));
                page->mailDisclosure.IsExpanded(true); f->disclosure.IsExpanded(true);
                page->tell(L"IMAP server addresses loaded above. Blank password preserves it only if the address and servers remain unchanged.");
                break;
            }
        });
        action(p, panel, L"Disconnect this account…", [owner](Page page) -> IAsyncAction {
            if (!(co_await page->shell->confirm(L"Disconnect mailbox?", owner + L"\nOnly its credentials are removed. Cached mail, drafts and other connections remain.", L"Disconnect")) || !page->current()) co_return;
            co_await page->shell->service->request(L"/account/disconnect", owner, L"POST");
            if (page->current()) { co_await refreshConnections(page); page->tell(L"Disconnected. Cached mail and drafts remain."); }
        });
    }
}
void mail(Page const& p) {
    title(p->body, L"Mail accounts"); help(p->body, L"Connect multiple Gmail, Outlook and Yahoo / IMAP accounts. Reconnecting changes only that address.");
    Expander add; add.Header(box_value(L"Add or reconnect account")); add.IsExpanded(array(p->shell->state, L"accounts").Size() == 0);
    p->mailDisclosure = add;
    add.HorizontalAlignment(xaml::HorizontalAlignment::Stretch);
    auto editor = stack(12); add.Content(editor); p->body.Children().Append(add);
    Expander range; range.Header(box_value(L"New import range")); range.HorizontalAlignment(xaml::HorizontalAlignment::Stretch);
    auto historyPanel = stack(12); range.Content(historyPanel); p->body.Children().Append(range);
    auto history = historyOptions(p, historyPanel); p->importOptions = history; mailEditor(p, editor, history);
    title(p->body, L"Connected accounts");
    auto list = stack(12); p->connectionsPanel = list; p->body.Children().Append(list);
    p->connections = copy(p->shell->state);
    accounts(p, list, p->shell->state, history);
    action(p, p->body, L"Refresh connections / progress", [](Page page) { return refreshConnections(page); });
}

void calendarConnection(Page const& p, StackPanel const& status, Json const& connection) {
    status.Children().Clear();
    auto provider = text(connection, L"provider");
    help(status, flag(connection, L"connected") ? text(connection, L"email") : L"Not connected");
    if (flag(connection, L"connected")) action(p, status, L"Disconnect calendar…", [provider, email = text(connection, L"email")](Page page) -> IAsyncAction {
        if (!(co_await page->shell->confirm(L"Disconnect calendar?", email + L"\nProvider events and the independent mailbox connection remain unchanged.", L"Disconnect")) || !page->current()) co_return;
        Json body; put(body, L"connectionEmail", email);
        co_await page->shell->service->request(L"/calendars/" + provider + L"/disconnect", {}, L"POST", body);
        co_await refreshConnections(page); page->tell(L"Calendar disconnected.");
    });
}
void calendar(Page const& p, Json const& response) {
    title(p->body, L"Calendar connections");
    help(p->body, L"One Google and one Outlook calendar account can be connected independently of mail. Multiple calendars can be selected in Calendar. Calendar data is never shared with AI.");
    for (auto const& item : array(response, L"connections")) {
        auto connection = item.GetObject(); auto provider = text(connection, L"provider");
        if (provider != L"google" && provider != L"microsoft") continue;
        title(p->body, provider == L"google" ? L"Google Calendar" : L"Outlook Calendar");
        auto status = stack(8); p->body.Children().Append(status);
        p->calendarStatus[std::wstring(provider)] = status; calendarConnection(p, status, connection);
        Json initial; boolean(initial, L"useDefaultClient", flag(connection, L"hasDefaultClient")); put(initial, L"clientId", text(connection, L"clientId"));
        auto f = form(p, p->body, initial, (L"calendar-" + std::wstring(provider)).c_str());
        toggle(f, L"useDefaultClient", L"Use Morrow’s bundled OAuth client");
        input(f, L"clientId", L"Own desktop application client ID", 1000); password(f, L"Own client secret (not needed for Microsoft public clients)");
        help(f->panel, flag(connection, L"hasClientSecret") ? L"A blank secret keeps the saved secret only for the same client ID." : L"Google custom clients require their desktop app secret. Microsoft public clients do not.");
        help(f->panel, L"Register the callback below for your custom desktop app. Do not open it to sign in:\n" + text(connection, L"redirectUri"));
        action(p, f->panel, L"Sign in / reconnect through browser", [f, provider](Page page) -> IAsyncAction {
            Json body; boolean(body, L"useDefaultClient", flag(f->value, L"useDefaultClient"));
            if (!flag(body, L"useDefaultClient")) { put(body, L"clientId", text(f->value, L"clientId")); put(body, L"clientSecret", f->secret.Password()); }
            struct Clear { Form f; Json body; ~Clear() { f->secret.Password(L""); remove(body, L"clientSecret"); } } clear{f, body};
            auto result = co_await page->shell->service->request(L"/calendars/" + provider + L"/connect", {}, L"POST", body);
            if (!page->current()) co_return;
            f->accept(f->value); co_await launchOAuth(page, result, provider, true);
        });
    }
}

IAsyncAction refreshConnections(Page p, bool automatic) {
    if (!p->current() || p->polling || (automatic && (p->busy || p->saving || p->shell->dialogOpen))) co_return;
    p->polling = true; auto revision = p->revision;
    hstring refreshError = L"Connection status could not refresh. Last known status is shown; retrying automatically.";
    try {
        // /calendars fetches provider events; status polling reads only local state.
        auto next = co_await p->shell->service->request(L"/state", p->owner);
        if (p->current() && revision == p->revision && (!automatic || !p->busy)) {
            auto accountsNow = next.GetNamedArray(L"accounts");
            auto calendarsNow = object(next, L"settings").GetNamedArray(L"calendars");
            bool changedAccounts = accountsNow.Stringify() != array(p->shell->state, L"accounts").Stringify();
            bool changedFolders = object(next, L"serverFolders").Stringify() != object(p->shell->state, L"serverFolders").Stringify();
            p->shell->state.Insert(L"accounts", accountsNow);
            if (next.HasKey(L"serverFolders")) {
                p->shell->state.Insert(L"serverFolders", object(next, L"serverFolders"));
                p->shell->serverFolders = object(next, L"serverFolders");
            }
            object(p->shell->state, L"settings").Insert(L"calendars", calendarsNow);
            if (p->tab == L"mail" && accountsNow.Stringify() != array(p->connections, L"accounts").Stringify())
                accounts(p, p->connectionsPanel, next, p->importOptions);
            if (p->tab == L"calendar" && calendarsNow.Stringify() != array(object(p->connections, L"settings"), L"calendars").Stringify()) {
                for (auto const& value : calendarsNow) {
                    auto connection = value.GetObject(); auto found = p->calendarStatus.find(std::wstring(text(connection, L"provider")));
                    if (found != p->calendarStatus.end()) calendarConnection(p, found->second, connection);
                }
            }
            p->connections = next;
            if (changedAccounts || changedFolders) p->shell->rebuildNavigation();
            if (!automatic) p->tell(L"Connection and history status refreshed.");
            else if (p->notice.Text() == refreshError) p->tell(L"");
        }
    } catch (...) {
        if (p->current() && revision == p->revision) p->tell(refreshError);
    }
    p->polling = false;
}

void permissions(Page const& p) {
    title(p->body, L"AI & privacy"); help(p->body, L"Choose what AI may read. These permissions apply across your accounts; each account’s mail stays separate. Changes take effect after Save permissions.");
    auto f = form(p, p->body, object(object(p->shell->state, L"settings"), L"policy"), L"policy");
    auto main = f->panel;
    auto section = [&](StackPanel const& parent, hstring caption) {
        Expander disclosure; disclosure.Header(box_value(caption)); disclosure.HorizontalAlignment(xaml::HorizontalAlignment::Stretch);
        auto panel = stack(12); disclosure.Content(panel); parent.Children().Append(disclosure); f->panel = panel;
        return disclosure;
    };
    toggle(f, L"enabled", L"Enable AI assistance");
    title(f->panel, L"What AI may read");
    title(f->panel, L"Mail folders");
    for (auto const& [key, caption] : std::initializer_list<std::pair<wchar_t const*, wchar_t const*>>{
        {L"inbox", L"Inbox"}, {L"sent", L"Sent"}, {L"drafts", L"Drafts"}, {L"archive", L"Archive"}, {L"trash", L"Trash"}})
        toggle(f, (L"folders." + std::wstring(key)).c_str(), caption);
    title(f->panel, L"Information in your mail");
    for (auto const& [key, caption] : std::initializer_list<std::pair<wchar_t const*, wchar_t const*>>{
        {L"subject", L"Subject lines"}, {L"body", L"Message bodies"}, {L"sender", L"Senders and recipients"}, {L"contacts", L"Saved contact notes"}})
        toggle(f, (L"content." + std::wstring(key)).c_str(), caption);
    auto triggers = object(f->saved, L"triggers");
    bool automatic = flag(triggers, L"onOpen") || flag(triggers, L"onReply") || flag(triggers, L"onArrival") || flag(triggers, L"scheduledSummary");
    hstring status = !flag(f->saved, L"enabled") ? L"Paused in saved settings" : automatic ? L"On in saved settings" : L"Off in saved settings";
    auto automaticSection = section(main, L"Automatic assistance · " + status);
    help(f->panel, L"Off by default. Automatic requests may cost money. Checked filters must all match. Drafts and Trash are excluded; each account is handled separately. Suggestions never send mail, create events or replace drafts automatically.");
    for (auto const& [key, caption] : std::initializer_list<std::pair<wchar_t const*, wchar_t const*>>{{L"onOpen", L"Summarize when opening a message"}, {L"onReply", L"Suggest text when starting a reply"}, {L"onArrival", L"Summarize newly synced messages"}, {L"scheduledSummary", L"Generate scheduled inbox summaries"}, {L"inboxOnly", L"Only messages in Inbox"}, {L"starredOnly", L"Only starred messages"}})
        toggle(f, (L"triggers." + std::wstring(key)).c_str(), caption);
    help(f->panel, L"New-mail summaries run after sync finds a new message, excluding initial imports. Set automatic mail sync in General for regular checks.");
    section(f->panel, L"Summary schedule (optional)");
    choice(f, L"summarySchedule.cadence", L"Repeat", {{L"daily", L"Daily at a set time"}, {L"interval", L"Every few hours"}});
    input(f, L"summarySchedule.time", L"Daily time (24-hour HH:mm)", 5);
    input(f, L"summarySchedule.timeZone", L"Time zone, e.g. Asia/Hong_Kong", 100);
    numeric(f, L"summarySchedule.everyHours", L"Interval in hours", 1, 168);
    help(f->panel, L"Used only when scheduled inbox summaries are enabled. Runs while Morrow is open. Daily schedules catch up once; interval timing starts when enabled. Failed model jobs never replay automatically. Results appear in AI Studio → Summaries.");
    section(main, L"Choose available AI tasks");
    for (auto const& entry : array(p->shell->state, L"features")) {
        auto feature = entry.GetObject(); auto id = text(feature, L"id");
        if (!object(f->value, L"behaviors").HasKey(id) || (flag(feature, L"mock") && id != L"memory")) continue;
        toggle(f, (L"behaviors." + std::wstring(id)).c_str(), id == L"memory" ? hstring(L"Writing style & notes") : text(feature, L"label"));
        help(f->panel, id == L"memory" ? hstring(L"Suggest memories with source references, review what to save, and use permitted saved context.") : text(feature, L"description"));
    }
    section(main, L"Advanced limits & local simulations");
    numeric(f, L"maxMessages", L"Maximum messages per request", 1, 50);
    help(f->panel, L"Simulations use sample data. Calendar and attachment permissions below do not grant access to your live calendar or attachment files.");
    toggle(f, L"content.calendar", L"Simulated calendar context"); toggle(f, L"content.attachments", L"Sample attachment fixtures");
    for (auto const& entry : array(p->shell->state, L"features")) {
        auto feature = entry.GetObject(); auto id = text(feature, L"id");
        if (!object(f->value, L"behaviors").HasKey(id) || !flag(feature, L"mock") || id == L"memory") continue;
        toggle(f, (L"behaviors." + std::wstring(id)).c_str(), text(feature, L"label") + L" · Simulation");
        help(f->panel, text(feature, L"description"));
    }
    f->panel = main;
    action(p, f->panel, L"Save permissions", [f, automaticSection](Page page) -> IAsyncAction {
        auto result = co_await page->shell->service->request(L"/settings/policy", page->owner, L"POST", copy(f->value));
        if (!page->current()) co_return;
        auto policy = object(object(result, L"settings"), L"policy"); f->accept(policy);
        auto triggers = object(policy, L"triggers");
        bool automatic = flag(triggers, L"onOpen") || flag(triggers, L"onReply") || flag(triggers, L"onArrival") || flag(triggers, L"scheduledSummary");
        hstring status = !flag(policy, L"enabled") ? L"Paused in saved settings" : automatic ? L"On in saved settings" : L"Off in saved settings";
        automaticSection.Header(box_value(L"Automatic assistance · " + status));
        object(page->shell->state, L"settings").Insert(L"policy", policy); page->tell(L"AI permissions saved.");
    });
    action(p, f->panel, L"Discard permission changes", [f](Page page) -> IAsyncAction { f->accept(f->saved); page->tell(L"Saved permissions restored."); co_return; });
}

Json modelFields(Json const& source, bool embedding) {
    auto value = embedding ? pick(source, {L"protocol", L"baseUrl", L"model"}) : pick(source, {L"baseUrl", L"model", L"temperature", L"maxTokens"});
    boolean(value, L"clearApiKey", false); return value;
}
IAsyncAction modelAction(Page p, Form f, bool embedding, bool testing) {
    auto body = copy(f->value);
    if (!f->secret.Password().empty()) put(body, L"apiKey", f->secret.Password());
    struct Clear { Json body; ~Clear() { remove(body, L"apiKey"); } } clear{body};
    auto path = embedding ? (testing ? L"/search/test" : L"/search/settings") : (testing ? L"/settings/ai/test" : L"/settings/ai");
    auto result = co_await p->shell->service->request(path, p->owner, L"POST", body);
    if (!p->current()) co_return;
    if (testing) p->tell(embedding ? L"Connection succeeded · " + number(result, L"dimensions") + L" dimensions. Settings unchanged; no mail shared." : text(result, L"text"));
    else {
        auto config = embedding ? object(result, L"settings") : object(object(result, L"settings"), L"ai");
        f->accept(modelFields(config, embedding));
        f->disclosure.Header(box_value(flag(config, L"hasApiKey") ? L"API key saved — replace…" : L"API key"));
        f->disclosure.IsExpanded(!flag(config, L"hasApiKey"));
        if (embedding) p->searchState = result; else object(p->shell->state, L"settings").Insert(L"ai", config);
        p->tell(embedding ? L"Embedding connection saved. Review scope and batches in Search." : L"Chat model saved.");
    }
}
void models(Page const& p) {
    ComboBox purpose; purpose.Header(box_value(L"Model purpose")); purpose.HorizontalAlignment(xaml::HorizontalAlignment::Stretch);
    purpose.Items().Append(box_value(L"Chat & replies")); purpose.Items().Append(box_value(L"Search embedding")); purpose.SelectedIndex(0); p->body.Children().Append(purpose);
    help(p->body, L"Chat and embedding use separate connections and explicit Save controls. Tests use a fixed sentence, never mail, and may charge provider tokens.");
    std::vector<ContentControl> editors;
    for (bool embedding : {false, true}) {
        auto config = embedding ? object(p->searchState, L"settings") : object(object(p->shell->state, L"settings"), L"ai");
        auto f = form(p, p->body, modelFields(config, embedding), embedding ? L"embedding" : L"chat");
        title(f->panel, embedding ? L"Search embedding" : L"Chat & reply model");
        f->container.Visibility(embedding ? xaml::Visibility::Collapsed : xaml::Visibility::Visible); editors.push_back(f->container);
        if (embedding) choice(f, L"protocol", L"Embedding protocol", {{L"openai", L"OpenAI-compatible /embeddings"}, {L"ollama", L"Ollama native /api/embed"}});
        input(f, L"baseUrl", L"Server address (API base URL)", 2000); input(f, L"model", L"Model name", 200);
        auto main = f->panel;
        f->disclosure = Expander(); f->disclosure.Header(box_value(flag(config, L"hasApiKey") ? L"API key saved — replace…" : L"API key"));
        f->disclosure.IsExpanded(!flag(config, L"hasApiKey"));
        f->panel = stack(12); f->disclosure.Content(f->panel); main.Children().Append(f->disclosure);
        password(f, L"Access key (API key, optional for local models)"); f->panel = main;
        auto clear = toggle(f, L"clearApiKey", L"Remove saved API key");
        std::weak_ptr<Editor> weak = f;
        clear.Click([weak](auto const& sender, auto const&) { if (auto item = weak.lock()) { bool remove = checked(sender.template as<CheckBox>()); if (remove) item->secret.Password(L""); item->secret.IsEnabled(!remove); } });
        help(f->panel, L"Changing models on the same endpoint reuses your saved API key. Enter a key only to replace it or use a different base URL. Saved keys are never displayed; local endpoints may not require a key.");
        if (!embedding) {
            Expander advanced; advanced.Header(box_value(L"Advanced response settings")); auto fields = stack(12); auto main = f->panel;
            advanced.Content(fields); main.Children().Append(advanced); f->panel = fields;
            numeric(f, L"temperature", L"Temperature", 0, 2, 0.1); numeric(f, L"maxTokens", L"Maximum response tokens", 128, 4096);
            f->panel = main;
        }
        action(p, f->panel, embedding ? L"Test embedding connection" : L"Test chat connection", [f, embedding](Page page) { return modelAction(page, f, embedding, true); });
        action(p, f->panel, embedding ? L"Save embedding model" : L"Save chat model", [f, embedding](Page page) { return modelAction(page, f, embedding, false); });
        action(p, f->panel, L"Discard connection edits", [f](Page page) -> IAsyncAction { f->accept(f->saved); f->secret.IsEnabled(true); page->tell(L"Saved connection fields restored. Entered key discarded."); co_return; });
        if (embedding && text(object(p->searchState, L"job"), L"status") == L"running") { f->locked = true; f->container.IsEnabled(false); help(p->body, L"An indexing batch is running. Manage it in Search before editing its connection."); }
    }
    purpose.SelectionChanged([editors](auto const& sender, auto const&) {
        auto selected = sender.template as<ComboBox>().SelectedIndex();
        for (size_t i = 0; i < editors.size(); ++i) editors[i].Visibility(static_cast<int32_t>(i) == selected ? xaml::Visibility::Visible : xaml::Visibility::Collapsed);
    });
}

hstring selectedFields(Json const& value) {
    hstring result;
    for (auto const& entry : value) if (entry.Value().ValueType() == JsonValueType::Boolean && entry.Value().GetBoolean()) result = result + (result.empty() ? L"" : L", ") + entry.Key();
    return result;
}
hstring indexHistoryLabel(Json const& settings) {
    return settings.GetNamedNumber(L"months", 3) == 0 ? hstring(L"All downloaded mail") : L"Last " + number(settings, L"months") + L" months";
}
hstring indexReview(Json const& value) {
    auto settings = object(value, L"settings"), job = object(value, L"job");
    hstring owners;
    for (auto const& owner : array(settings, L"accounts")) owners = owners + (owners.empty() ? L"" : L", ") + owner.GetString();
    auto result = L"Model: " + text(settings, L"model") + L"\nEndpoint: " + text(settings, L"baseUrl") + L"\nAccounts: " + owners +
        L"\nFolders: " + selectedFields(object(settings, L"folders")) + L"\nFields: " + selectedFields(object(settings, L"content")) +
        L"\n" + indexHistoryLabel(settings) + L" · " + number(job, L"sampleCount") + L" messages / " + number(job, L"chunks") + L" chunks" +
        L"\nEstimated tokens ≤ " + number(job, L"estimatedTokens") + L" · budget " + number(settings, L"tokenBudget") +
        L"\nOnly permitted downloaded text is sent. Remote models may charge. In-flight requests may already have used tokens.";
    uint32_t count = 0;
    for (auto const& item : array(value, L"samples")) {
        if (count++ == 3) break;
        auto sample = item.GetObject(); auto excerpt = std::wstring(text(sample, L"text"));
        // Avoid cutting a UTF-16 surrogate pair in the bounded review excerpt.
        if (excerpt.size() > 200) { excerpt.resize(200); if (excerpt.back() >= 0xd800 && excerpt.back() <= 0xdbff) excerpt.pop_back(); }
        result = result + L"\n\n" + text(sample, L"account") + L": " + hstring(excerpt);
    }
    return result;
}
IAsyncAction saveSearchScope(Page p, Form f, StackPanel status, Json input);
void searchStatus(Page const& p, StackPanel const& status) {
    status.Children().Clear();
    auto value = p->searchState, job = object(value, L"job"), settings = object(value, L"settings");
    help(status, text(settings, L"model", L"No embedding model saved") + L" · " + text(settings, L"baseUrl"));
    auto skipped = object(value, L"skipped");
    auto skippedCount = static_cast<uint64_t>(skipped.GetNamedNumber(L"oversized", 0) + skipped.GetNamedNumber(L"batchBudget", 0) + skipped.GetNamedNumber(L"dailyLimit",0));
    auto pending = static_cast<uint64_t>(value.GetNamedNumber(L"pending",0));
    help(status, number(value, L"indexed") + L" / " + number(value, L"eligible") + L" eligible messages indexed · " + hstring(std::to_wstring(pending - skippedCount)) + L" pending");
    if (skippedCount) help(status, hstring(std::to_wstring(skippedCount)) + L" messages skipped by size limits. Keyword search still covers them; see Advanced indexing options.");
    if (flag(settings,L"autoIndex")) {
        auto automatic=object(value,L"automatic");
        if (!flag(automatic,L"approved")) help(status,L"Model, permissions or scope changed. Review before continuing.");
        else if (text(job,L"status") == L"failed" || text(job,L"status") == L"interrupted") help(status,L"Indexing stopped. Review before retrying; the last request may already have used tokens.");
        else if (flag(automatic,L"waitingForBudget")) help(status,L"Daily limit reached — resumes automatically at midnight UTC while Morrow is open.");
        else if (text(job,L"status") == L"paused" || text(job,L"status") == L"cancelled") help(status,L"Indexing is paused. Review before continuing.");
        else help(status, pending == 0 ? L"Up to date — new and changed mail will be indexed automatically." : pending == skippedCount ? L"Supported messages are indexed. Remaining messages are skipped by size limits." : L"Automatic indexing enabled; downloaded mail is processed while Morrow is open.");
        help(status,L"Today: " + number(automatic,L"spentToday") + L" / " + number(settings,L"dailyTokenBudget") + L" estimated tokens; resets at midnight UTC.");
    } else if (flag(settings,L"enabled")) help(status,L"Automatic indexing is paused. Completed indexes remain searchable.");
    if (job.Size()) {
        if (!flag(job,L"automatic")) help(status, L"Manual batch: " + text(job, L"status") + L" · " + number(job, L"completed") + L" / " + number(job, L"sampleCount") + L" messages");
        if (!text(job, L"error").empty()) help(status, text(job, L"error"));
    }
    if (text(job, L"status") == L"running") help(status, L"Indexing continues in the background while Morrow is open. You may leave this page. Return here or open Activity for progress.");
    if (!flag(value, L"permitted")) help(status, L"Enable the required saved AI permissions before reviewing a batch.");
    for (auto const& f : p->forms) if (f->key.ends_with(L":search")) {
        f->locked = false; // Search scope can be saved to stop automatic work; model editing remains separate.
        f->container.IsEnabled(!p->busy && !f->locked);
        if (flag(settings,L"autoIndex")) {
            auto weakStatus = make_weak(status);
            action(p,status,L"Pause automatic indexing",[f,weakStatus](Page page) -> IAsyncAction {
                if (auto panel = weakStatus.get()) { Json input; boolean(input,L"autoIndex",false); co_await saveSearchScope(page,f,panel,input); }
            });
        }
    }
}
IAsyncAction saveSearchScope(Page p, Form f, StackPanel status, Json input) {
    if (flag(input,L"autoIndex")) {
        auto settings = object(p->searchState,L"settings");
        hstring owners;
        for (auto const& owner : array(input,L"accounts")) owners = owners + (owners.empty() ? L"" : L", ") + owner.GetString();
        if (!(co_await p->shell->confirm(L"Index this scope and keep it updated?", L"Model: " + text(settings,L"model") + L"\nEndpoint: " + text(settings,L"baseUrl") + L"\nAccounts: " + owners + L"\nFolders: " + selectedFields(object(input,L"folders")) + L"\nContent: " + selectedFields(object(input,L"content")) + L"\nHistory: " + indexHistoryLabel(input) + L"\nDaily limit: " + number(input,L"dailyTokenBudget") + L" estimated tokens, resets at midnight UTC. Downloaded, new and changed mail in this scope will be sent automatically while Morrow is open. Provider charges may apply. Retrying after an interrupted request may charge again.",L"Start automatic indexing")) || !p->current()) co_return;
    }
    auto result = co_await p->shell->service->request(L"/search/settings",p->owner,L"POST",input);
    if (!p->current()) co_return;
    if (input.Size() == 1 && !flag(input,L"autoIndex")) {
        boolean(f->value,L"autoIndex",false); boolean(f->saved,L"autoIndex",false); f->edit();
    } else f->accept(pick(object(result,L"settings"),{L"enabled",L"autoIndex",L"dailyTokenBudget",L"accounts",L"months",L"tokenBudget",L"folders",L"content"}));
    p->searchState=result; searchStatus(p,status); p->tell(flag(input,L"autoIndex") ? L"Automatic indexing approved. You can leave Settings while it runs." : L"Search settings saved. Completed indexes remain available.");
}
IAsyncAction indexAction(Page p, Form f, StackPanel status, hstring operation) {
    if ((operation == L"preview" || operation == L"resume") && f->changed()) throw hresult_error(E_FAIL, L"Save search scope before reviewing or resuming a batch.");
    Json body;
    auto previousId = text(object(p->searchState, L"job"), L"id");
    if (operation == L"cancel" || operation == L"clear") {
        if (!(co_await p->shell->confirm(operation == L"clear" ? L"Clear semantic index?" : L"Cancel indexing batch?", operation == L"clear" ? L"All semantic vectors will be removed. Your mail and keyword index remain. Rebuilding requires a new review and may charge model tokens." : L"Unfinished work is discarded. Completed valid vectors and mail remain. In-flight requests may already have used provider tokens.", operation == L"clear" ? L"Clear index" : L"Cancel batch")) || !p->current()) co_return;
    }
    if (operation != L"preview" && operation != L"clear") {
        if (previousId.empty()) throw hresult_error(E_FAIL, L"There is no batch to control. Refresh search status.");
        put(body, L"previewId", previousId);
    }
    if (operation == L"resume") {
        if (!(co_await p->shell->confirm(L"Resume reviewed batch?", indexReview(p->searchState) + L"\nOnly the remaining approved batch will run. An interrupted request may be charged again.", L"Resume")) || !p->current()) co_return;
    }
    auto result = co_await p->shell->service->request(L"/search/index/" + operation, p->owner, L"POST", body);
    if (!p->current()) co_return;
    p->searchState = result; searchStatus(p, status);
    if (operation == L"preview") {
        auto id = text(object(result, L"job"), L"id");
        if (id.empty()) throw hresult_error(E_FAIL, L"The service did not return an indexing review.");
        if (!(co_await p->shell->confirm(L"Review and start indexing?", indexReview(result), L"Start reviewed batch")) || !p->current()) { p->tell(L"Preview retained. No embedding request was started."); co_return; }
        Json approved; put(approved, L"previewId", id);
        result = co_await p->shell->service->request(L"/search/index/run", p->owner, L"POST", approved);
        if (!p->current()) co_return;
        p->searchState = result; searchStatus(p, status);
    }
    p->tell(L"Indexing state updated. Background work does not lock navigation.");
}
fire_and_forget pollSearch(Page p, StackPanel status) {
    if (!p->current() || p->busy || p->polling) co_return;
    p->polling = true; auto revision = p->revision;
    try {
        auto result = co_await p->shell->service->request(L"/search/settings", p->owner);
        if (p->current() && !p->busy && revision == p->revision) { p->searchState = result; searchStatus(p, status); }
    } catch (...) { p->tell(L"Index status could not refresh. Last known status is shown; running work is not cancelled."); }
    p->polling = false;
}
void search(Page const& p) {
    title(p->body, L"Search and semantic indexing"); help(p->body, L"Index downloaded mail once and keep it updated while Morrow is open. Keyword search stays local and remains available during indexing. Configure the embedding connection in Advanced setup → AI connection.");
    auto status = stack(8); p->body.Children().Append(status); searchStatus(p, status);
    action(p, p->body, L"Test saved embedding connection", [](Page page) -> IAsyncAction {
        auto result = co_await page->shell->service->request(L"/search/test", page->owner, L"POST");
        page->tell(L"Connection succeeded · " + number(result, L"dimensions") + L" dimensions. No mail shared and no settings changed.");
    });
    auto f = form(p, p->body, pick(object(p->searchState, L"settings"), {L"enabled", L"autoIndex", L"dailyTokenBudget", L"accounts", L"months", L"tokenBudget", L"folders", L"content"}), L"search");
    title(f->panel, L"Accounts to index");
    for (auto const& item : array(p->shell->state, L"accounts")) {
        auto account = item.GetObject(); auto id = text(account, L"id"); if (id.empty() || id == L"demo" || id == L"all") continue;
        CheckBox check; check.Content(box_value(text(account, L"email"))); bool included = false;
        for (auto const& selected : array(f->value, L"accounts")) if (selected.GetString() == id) included = true;
        check.IsChecked(included); std::weak_ptr<Editor> weak = f;
        check.Click([weak, id](auto const& sender, auto const&) {
            if (auto editor = weak.lock()) {
                Array next; for (auto const& selected : array(editor->value, L"accounts")) if (selected.GetString() != id) next.Append(selected);
                if (checked(sender.template as<CheckBox>())) next.Append(Value::CreateStringValue(id));
                editor->value.Insert(L"accounts", next); editor->edit();
            }
        }); f->panel.Children().Append(check);
    }
    for (auto group : {L"folders", L"content"}) {
        title(f->panel, group);
        for (auto const& entry : object(f->value, group)) toggle(f, (std::wstring(group) + L"." + std::wstring(entry.Key())).c_str(), entry.Key() == L"sender" ? L"Sender / recipients, including Cc and Bcc" : entry.Key());
    }
    choice(f, L"months", L"Index history", {{L"0", L"All downloaded mail"}, {L"1", L"Last month"}, {L"3", L"Last 3 months"}, {L"6", L"Last 6 months"}, {L"12", L"Last 12 months"}}, true);
    action(p,f->panel,L"Index downloaded mail & keep updated…",[f,status](Page page) -> IAsyncAction {
        auto input=copy(f->value); boolean(input,L"enabled",true); boolean(input,L"autoIndex",true); co_await saveSearchScope(page,f,status,input);
    });
    help(f->panel,L"Only downloaded mail in approved accounts, folders and content fields is indexed. Remote indexing and semantic queries may incur charges; the daily limit covers indexing, not queries.");
    Expander advanced; advanced.Header(box_value(L"Advanced indexing options")); auto limits=stack(10); advanced.Content(limits); f->panel.Children().Append(advanced); auto main=f->panel; f->panel=limits;
    toggle(f, L"enabled", L"Enable Smart Search");
    numeric(f, L"dailyTokenBudget", L"Daily indexing limit (estimated tokens, UTC day)", 4000, 2000000, 1000);
    numeric(f, L"tokenBudget", L"Estimated token budget per reviewed batch", 4000, 64000, 1000);
    help(f->panel, L"Global AI permissions still apply. Conservative UTF-8 estimates are not billing guarantees. Automatic mode processes successive bounded batches and picks up new mail. It pauses at the daily budget; failed or interrupted requests require review.");
    help(f->panel,L"Messages above 50 chunks or the per-message batch budget are skipped. A chunk larger than the entire daily allowance needs a higher daily limit. Semantic searches require narrower filters above 12,000 chunks or 4 million vector values.");
    action(p,f->panel,L"Save search settings",[f,status](Page page) { return saveSearchScope(page,f,status,copy(f->value)); });
    f->panel=main;
    Expander maintenance; maintenance.Header(box_value(L"Manual indexing & maintenance")); auto maintenancePanel=stack(10); maintenance.Content(maintenancePanel); p->body.Children().Append(maintenance);
    for (auto const& [operation, caption] : std::initializer_list<std::pair<wchar_t const*, wchar_t const*>>{{L"preview", L"Review & Index…"}, {L"pause", L"Pause batch"}, {L"resume", L"Resume batch…"}, {L"cancel", L"Cancel batch…"}, {L"clear", L"Clear semantic index…"}})
        action(p, maintenancePanel, caption, [f, status, operation = hstring(operation)](Page page) { return indexAction(page, f, status, operation); });
    searchStatus(p, status);
    p->timer = xaml::DispatcherTimer(); p->timer.Interval(std::chrono::seconds(2)); std::weak_ptr<SettingsPage> weak = p;
    p->timer.Tick([weak, status](auto const&, auto const&) { if (auto page = weak.lock()) pollSearch(page, status); }); p->timer.Start();
}

void updateStatus(Page const& p, StackPanel const& content) {
    p->release = copy(p->shell->updateResult);
    content.Children().Clear();
    if (p->shell->checkingUpdates) help(content, L"Checking GitHub for updates…");
    if (p->release.Size()) help(content, (flag(p->release, L"updateAvailable") ? hstring(L"Update available: ") : hstring(L"Up to date for this channel: ")) + text(p->release, L"latestVersion") + L"\nInstalled: " + text(p->release, L"currentVersion") + L" · Checked: " + text(p->release, L"checkedAt"));
    auto state = p->updateState;
    help(content, L"Installer: " + text(state, L"phase", L"idle") + L" · " + number(state, L"received") + L" / " + number(state, L"total") + L" bytes");
    if (!flag(state, L"supported")) help(content, L"In-app installation is unavailable outside a supported signed package layout.");
    for (auto key : {L"error", L"previous"}) if (!text(state, key).empty()) help(content, text(state, key));
}
fire_and_forget pollUpdate(Page p, StackPanel status) {
    if (!p->current() || p->busy || p->polling) co_return;
    updateStatus(p, status);
    p->polling = true; auto revision = p->revision;
    try {
        auto next = co_await p->shell->service->request(L"/updates/status");
        if (p->current() && !p->busy && revision == p->revision) { p->updateState = next; updateStatus(p, status); }
    } catch (...) { p->tell(L"Update status could not refresh. Your installed app has not changed."); }
    p->polling = false;
}
void about(Page const& p) {
    p->prereleases = p->shell->includePrereleases;
    p->release = copy(p->shell->updateResult);
    title(p->body, L"Morrow Mail"); help(p->body, L"Independent open-source mail workspace · MIT. Mail and encrypted credentials stay in the separate workspace. Only explicitly permitted AI context goes to your chosen model.");
    help(p->body, L"The host checks for public GitHub updates at launch and hourly while open. Installation always requires review, no pending writes and a verified signed package.");
    auto status = stack(8); p->body.Children().Append(status); updateStatus(p, status);
    CheckBox prereleases; prereleases.Content(box_value(L"Include alpha and beta releases")); prereleases.IsChecked(p->prereleases);
    std::weak_ptr<SettingsPage> weak = p;
    prereleases.Click([weak, status](auto const& sender, auto const&) {
        if (auto page = weak.lock(); page && page->current()) {
            auto control = sender.template as<CheckBox>();
            if (page->busy || page->shell->checkingUpdates) {
                control.IsChecked(page->shell->includePrereleases);
                page->tell(L"Wait for the current update operation before changing channels.");
                return;
            }
            page->prereleases = checked(control);
            page->shell->includePrereleases = page->prereleases;
            page->shell->lastUpdateCheck = 0;
            page->shell->updateResult = Json();
            page->shell->updateBadge();
            updateStatus(page, status);
            page->tell(L"Release channel changed. The host will check this channel shortly.");
        }
    });
    p->body.Children().Append(prereleases);
    action(p, p->body, L"Check for updates", [status](Page page) -> IAsyncAction {
        auto channel = page->shell->includePrereleases;
        co_await page->shell->checkUpdates(true);
        if (page->current() && page->shell->includePrereleases == channel) {
            updateStatus(page, status);
            // Shell owns error reporting; do not label a retained result as a
            // successful fresh check when that request failed or is coalesced.
            page->tell(page->shell->checkingUpdates ? L"An update check is already running." : L"");
        }
    });
    action(p, p->body, L"Download verified update", [status](Page page) -> IAsyncAction {
        page->release = copy(page->shell->updateResult);
        if (!flag(page->release, L"updateAvailable")) throw hresult_error(E_FAIL, L"Check for an available update first.");
        Json body; boolean(body, L"includePrereleases", page->shell->includePrereleases);
        auto result = co_await page->shell->service->request(L"/updates/download", {}, L"POST", body);
        if (page->current()) { page->updateState = result; updateStatus(page, status); page->tell(L"Downloading. You may leave Settings."); }
    });
    action(p, p->body, L"Cancel download", [status](Page page) -> IAsyncAction {
        auto result = co_await page->shell->service->request(L"/updates/cancel", {}, L"POST");
        if (page->current()) { page->updateState = result; updateStatus(page, status); page->tell(L"Download cancelled."); }
    });
    action(p, p->body, L"Install & Restart…", [](Page page) -> IAsyncAction {
        if (text(page->updateState, L"phase") != L"ready" && text(page->updateState, L"phase") != L"installing") throw hresult_error(E_FAIL, L"Download and verify an update first.");
        auto dirty = page->shell->dirty; dirty.erase(page->busyKey);
        if (!dirty.empty()) throw hresult_error(E_FAIL, L"Save or discard unsaved edits before restarting.");
        if (!(co_await page->shell->confirm(L"Install verified update and restart?", L"Morrow will restart now. Active requests finish saving before replacement; downloads and checkpointed indexing continue after restart. Uncertain sends are never replayed. The previous app and your workspace are retained.", L"Install & Restart")) || !page->current()) co_return;
        std::exception_ptr failed;
        try { co_await page->shell->service->request(L"/updates/install", {}, L"POST", Json(), true); }
        catch (...) { failed = std::current_exception(); }
        if (failed) {
            auto status = co_await page->shell->service->request(L"/updates/status");
            if (text(status,L"phase") != L"installing") std::rethrow_exception(failed);
        }
        if (!page->current()) co_return;
        page->shell->restartingForUpdate = true;
        page->shell->dirty.erase(page->busyKey); page->busy = false;
        co_await page->shell->shutdown();
    });
    title(p->body, L"Workspace backup");
    help(p->body, L"Choose a new absolute directory. Backup includes mail, encrypted settings and its key. Existing destinations are refused; protect the resulting folder.");
    auto destination = field(L"New backup directory (absolute path)"); destination.MaxLength(4096); p->body.Children().Append(destination);
    action(p, p->body, L"Back up workspace…", [destination](Page page) -> IAsyncAction {
        std::filesystem::path path{std::wstring(destination.Text())};
        if (!path.is_absolute()) throw hresult_error(E_INVALIDARG, L"Choose an absolute backup destination.");
        hstring destinationPath(path.wstring());
        if (!(co_await page->shell->confirm(L"Create workspace backup?", destinationPath + L"\nThe destination must not already exist. The backup contains private mail and its encryption key.", L"Create backup")) || !page->current()) co_return;
        Json body; put(body, L"destination", destinationPath);
        auto result = co_await page->shell->service->request(L"/backup", page->owner, L"POST", body, true);
        if (!flag(result, L"saved")) throw hresult_error(E_FAIL, L"The backup was not confirmed.");
        page->tell(L"Workspace backup created. Your running service remains available.");
    });
    p->timer = xaml::DispatcherTimer(); p->timer.Interval(std::chrono::seconds(2));
    p->timer.Tick([weak, status](auto const&, auto const&) { if (auto page = weak.lock()) pollUpdate(page, status); }); p->timer.Start();
}
} // namespace

IAsyncAction settingsPage(std::shared_ptr<Shell> shell, hstring tab) {
    if (tab == L"learning") { co_await workspacePage(shell, L"learning"); co_return; }
    auto p = std::make_shared<SettingsPage>(); p->shell = shell; p->owner = shell->owner; p->tab = tab;
    p->generation = ++shell->generation; p->busyKey = L"settings-request:" + std::to_wstring(p->generation);
    Grid root; root.Margin(xaml::Thickness{24, 20, 24, 20}); root.ColumnSpacing(24); root.RowSpacing(16);
    RowDefinition heading; heading.Height(xaml::GridLengthHelper::Auto()); root.RowDefinitions().Append(heading);
    root.RowDefinitions().Append(RowDefinition());
    RowDefinition footer; footer.Height(xaml::GridLengthHelper::Auto()); root.RowDefinitions().Append(footer);
    ColumnDefinition sidebar; sidebar.Width(xaml::GridLengthHelper::FromPixels(195)); root.ColumnDefinitions().Append(sidebar);
    root.ColumnDefinitions().Append(ColumnDefinition());
    auto headingLabel = label(L"Settings", 26); Grid::SetColumnSpan(headingLabel, 2); root.Children().Append(headingLabel);
    ListView tabs, advancedTabs;
    for (auto const& list : {tabs, advancedTabs}) { list.SelectionMode(ListViewSelectionMode::Single); list.IsItemClickEnabled(true); }
    xaml::Automation::AutomationProperties::SetName(tabs, L"Settings categories");
    xaml::Automation::AutomationProperties::SetName(advancedTabs, L"Advanced settings categories");
    struct Category { wchar_t const* id; wchar_t const* caption; wchar_t const* glyph; };
    for (auto const& entry : {Category{L"start", L"Start here", L"\uE734"}, {L"general", L"General", L"\uE713"},
        {L"mail", L"Mail accounts", L"\uE715"}, {L"calendar", L"Calendar", L"\uE787"},
        {L"policy", L"AI & privacy", L"\uE72E"}, {L"about", L"About", L"\uE946"},
        {L"model", L"AI connection", L"\uE8F2"}, {L"search", L"Search index", L"\uE721"}, {L"learning", L"Writing style", L"\uE734"}}) {
        auto row = stack(8); row.Orientation(Orientation::Horizontal);
        FontIcon icon; icon.Glyph(entry.glyph); icon.FontSize(16); row.Children().Append(icon);
        auto caption = label(entry.caption); caption.IsTextSelectionEnabled(false); row.Children().Append(caption);
        ListViewItem item; item.Content(row); item.Tag(box_value(entry.id));
        auto list = std::wstring_view(entry.id) == L"model" || std::wstring_view(entry.id) == L"search" || std::wstring_view(entry.id) == L"learning" ? advancedTabs : tabs;
        xaml::Automation::AutomationProperties::SetName(item, entry.caption); list.Items().Append(item);
        if (tab == entry.id) list.SelectedItem(item);
    }
    for (auto const& list : {tabs, advancedTabs}) list.ItemClick([weak = std::weak_ptr<SettingsPage>(p), primary = make_weak(tabs), optional = make_weak(advancedTabs)](auto const& sender, ItemClickEventArgs const& event) -> fire_and_forget {
        auto page = weak.lock(); auto item = clickedListItem(sender.template as<ListView>(), event.ClickedItem());
        if (!page || !page->current() || !item) co_return;
        auto previous = page->tab; auto next = unbox_value<hstring>(item.Tag());
        if (previous != next) co_await changeTab(page, next);
        // A cancelled discard or pending save keeps the current category selected.
        if (page->current()) {
            auto tabs = primary.get(), advancedTabs = optional.get();
            if (!tabs || !advancedTabs) co_return;
            for (auto const& list : {tabs, advancedTabs}) {
                list.SelectedItem(nullptr);
                for (auto const& value : list.Items()) {
                    auto entry = value.as<ListViewItem>(); if (unbox_value<hstring>(entry.Tag()) == previous) list.SelectedItem(entry);
                }
            }
        }
    });
    auto categories = stack(8); categories.Children().Append(tabs);
    Expander advanced; advanced.Header(box_value(L"Advanced setup")); advanced.Content(advancedTabs);
    advanced.IsExpanded(tab == L"model" || tab == L"search"); categories.Children().Append(advanced);
    auto categoryScroll = scroll(categories); Grid::SetRow(categoryScroll, 1); root.Children().Append(categoryScroll);
    p->notice = label(L"Loading settings…");
    xaml::Automation::AutomationProperties::SetLiveSetting(p->notice, xaml::Automation::Peers::AutomationLiveSetting::Polite);
    Grid::SetRow(p->notice, 2); Grid::SetColumnSpan(p->notice, 2); root.Children().Append(p->notice);
    p->body = stack(20); p->body.MaxWidth(760); p->body.HorizontalAlignment(xaml::HorizontalAlignment::Stretch);
    auto content = scroll(p->body); content.HorizontalContentAlignment(xaml::HorizontalAlignment::Stretch);
    Grid::SetRow(content, 1); Grid::SetColumn(content, 1); root.Children().Append(content);
    root.Unloaded([p](auto const&, auto const&) { p->dispose(); });
    shell->show(root);
    try {
        if (tab == L"model" || tab == L"search") {
            auto response = co_await shell->service->request(L"/search/settings", p->owner);
            if (!p->current()) co_return; p->searchState = response;
        }
        if (tab == L"start") start(p);
        else if (tab == L"general") general(p);
        else if (tab == L"mail") mail(p);
        else if (tab == L"policy") permissions(p);
        else if (tab == L"model") models(p);
        else if (tab == L"search") search(p);
        else if (tab == L"about") {
            auto result = co_await shell->service->request(L"/updates/status");
            if (!p->current()) co_return; p->updateState = result; about(p);
        } else if (tab == L"calendar") {
            auto response = co_await shell->service->request(L"/calendars");
            if (!p->current()) co_return; calendar(p, response);
            action(p, p->body, L"Refresh calendar connections", [](Page page) { return refreshConnections(page); });
        } else throw hresult_error(E_INVALIDARG, L"Unknown Settings page.");
        if (p->current() && tab != L"general") p->tell(L"");
        if (p->current() && (tab == L"mail" || tab == L"calendar")) {
            p->timer = xaml::DispatcherTimer(); p->timer.Interval(std::chrono::seconds(3));
            p->timer.Tick([weak = std::weak_ptr<SettingsPage>(p)](auto const&, auto const&) {
                if (auto page = weak.lock()) refreshConnections(page, true);
            });
            p->timer.Start();
        }
    } catch (hresult_error const& error) {
        p->tell(error.message());
        if (p->current()) action(p, p->body, L"Retry loading settings", [tab](Page page) -> IAsyncAction { auto owner = page->shell; page->dispose(); co_await settingsPage(owner, tab); });
    } catch (...) { p->tell(L"Settings could not load. Return to Settings to retry."); }
}
} // namespace morrow
