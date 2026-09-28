#include "pch.h"
#include "Ui.h"
#include <winrt/Windows.Globalization.h>
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <cmath>
#include <cwchar>
#include <cwctype>
#include <map>
#include <set>
#include <string_view>

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
using namespace Windows::Data::Json;
using namespace controls;
IAsyncAction intelligencePage(std::shared_ptr<Shell> shell, hstring kind);
namespace {
Json clone(Json const& value) { return Json::Parse(value.Stringify()); }
Json subset(Json const& source, std::initializer_list<wchar_t const*> keys) {
    Json result;
    for (auto key : keys) if (auto item = source.TryLookup(key)) result.Insert(key, item);
    return clone(result);
}
void truth(Json const& target, wchar_t const* key, bool value) { target.Insert(key, Value::CreateBooleanValue(value)); }
bool checked(CheckBox const& control) { auto value = control.IsChecked(); return value && value.Value(); }
hstring count(Json const& value, wchar_t const* key) {
    auto item = value.TryLookup(key);
    return item && item.ValueType() == JsonValueType::Number ? item.Stringify() : L"0";
}
void require(bool value, wchar_t const* message) { if (!value) throw hresult_error(E_INVALIDARG, message); }
hstring trim(hstring const& text) {
    std::wstring value(text); auto first = value.find_first_not_of(L" \t\r\n");
    if (first == std::wstring::npos) return {};
    return hstring(value.substr(first, value.find_last_not_of(L" \t\r\n") - first + 1));
}
hstring bounded(hstring const& value, size_t maximum = 64000) {
    if (value.size() <= maximum) return value;
    auto end = maximum;
    if (end && value.c_str()[end - 1] >= 0xd800 && value.c_str()[end - 1] <= 0xdbff) --end;
    return hstring(value.c_str(), static_cast<uint32_t>(end)) + L"\n[Display limit reached]";
}
void words(StackPanel const& panel, hstring const& value, double size = 14) {
    auto control = label(bounded(value), size); control.IsTextSelectionEnabled(true); panel.Children().Append(control);
}
StackPanel group(StackPanel const& parent, hstring const& heading) {
    auto panel = stack(10); words(panel, heading, 20); parent.Children().Append(panel); return panel;
}
hstring aliasesText(Json const& identity) {
    hstring result;
    for (auto const& name : array(identity, L"aliases")) result = result + (result.empty() ? L"" : L"\n") + name.GetString();
    return result;
}
Array aliases(hstring const& text) {
    Array result; std::wstring value(text); size_t start = 0;
    while (start <= value.size()) {
        auto end = value.find(L'\n', start);
        auto name = trim(hstring(value.substr(start, end == std::wstring::npos ? value.size() - start : end - start)));
        if (!name.empty()) {
            require(name.size() <= 100 && result.Size() < 10, L"Use at most 10 aliases, each at most 100 characters.");
            result.Append(Value::CreateStringValue(name));
        }
        if (end == std::wstring::npos) break;
        start = end + 1;
    }
    return result;
}
Json identityFields(Json const& identity) {
    Json value; put(value, L"displayName", text(identity, L"displayName")); put(value, L"aliasesText", aliasesText(identity));
    truth(value, L"confirmed", flag(identity, L"confirmed")); return value;
}

struct Editor {
    Json value, saved;
    bool initializing = false;
    std::map<std::wstring, weak_ref<TextBox>> fields;
    std::map<std::wstring, weak_ref<CheckBox>> toggles;
    std::map<std::wstring, weak_ref<NumberBox>> numbers;
    std::map<std::wstring, weak_ref<ComboBox>> choices;
    bool dirty() const { return value.Stringify() != saved.Stringify(); }
    void show() {
        initializing = true;
        for (auto const& [key, weak] : fields) if (auto control = weak.get()) control.Text(text(value, key.c_str()));
        for (auto const& [key, weak] : toggles) if (auto control = weak.get()) control.IsChecked(flag(value, key.c_str()));
        for (auto const& [key, weak] : numbers) if (auto control = weak.get()) control.Value(value.GetNamedNumber(key, 0));
        for (auto const& [key, weak] : choices) if (auto control = weak.get()) {
            auto selected = value.TryLookup(key); if (!selected) continue;
            for (uint32_t i = 0; i < control.Items().Size(); ++i) {
                auto item = control.Items().GetAt(i).as<ComboBoxItem>();
                if (unbox_value<hstring>(item.Tag()) == selected.Stringify()) control.SelectedIndex(static_cast<int32_t>(i));
            }
        }
        initializing = false;
    }
    void accept(Json const& next) { value = clone(next); saved = clone(next); show(); }
};
struct Intelligence : std::enable_shared_from_this<Intelligence> {
    std::shared_ptr<Shell> shell;
    hstring owner, kind, previewVoiceId, learningPaint, suggestionPaint, connection, context;
    uint64_t generation = 0, revision = 0, learningRevision = 0;
    bool live = true, busy = false, polling = false, cancelling = false, generatingStyle = false, selecting = false;
    Json state, suggestions, workflow, output, outputMessage, outputSource, memoryPreview;
    std::set<std::wstring> selectedMemories;
    weak_ref<StackPanel> memoryPanel;
    hstring outputAction, outputContext, workflowContext;
    std::map<std::wstring, Editor> forms;
    std::set<std::wstring> selectedCandidates;
    weak_ref<StackPanel> body, previewPanel, proposalPanel, candidatePanel, jobPanel, resultPanel, skillList, recordList;
    weak_ref<StackPanel> toolPanel;
    weak_ref<ContentControl> editorHost, suggestionOptions;
    TextBlock notice{nullptr};
    weak_ref<ComboBox> messagePicker, featurePicker, skillPicker;
    weak_ref<DatePicker> date;
    weak_ref<TimePicker> time;
    weak_ref<Button> cancelStyle;
    std::vector<Json> messages, features;
    std::vector<hstring> cursors{L""};
    hstring nextCursor;
    xaml::DispatcherTimer timer{nullptr};
    std::wstring key() const { return L"intelligence:" + std::to_wstring(generation); }
    bool current() const { return live && shell->current(generation, owner) && shell->connected(owner); }
    void tell(hstring const& value) { if (current()) if (auto control = notice) control.Text(value); }
    bool edited() const { for (auto const& [_, form] : forms) if (form.dirty()) return true; return false; }
    void dirty() {
        if (!live) return;
        if (busy || cancelling || edited()) shell->dirty.insert(key()); else shell->dirty.erase(key());
    }
    void clearResult() {
        workflow = Json(); output = Json(); outputMessage = Json(); outputSource = Json(); memoryPreview = Json(); selectedMemories.clear();
        if (auto panel = memoryPanel.get()) panel.Children().Clear();
        if (auto panel = resultPanel.get()) panel.Children().Clear();
    }
    void changed(std::wstring const& formName) {
        if (!current()) return;
        if (formName == L"tool") clearResult();
        ++revision; dirty();
    }
    void stop() {
        if (!live) return; live = false; ++revision; ++learningRevision;
        if (timer) { timer.Stop(); timer = nullptr; }
        if (!busy && !cancelling) shell->dirty.erase(key());
        // TextBlock peers stay retained until root.Unloaded; other control references are weak.
        // Service-owned reviewed background jobs continue normally.
    }
};
using Page = std::shared_ptr<Intelligence>;

hstring connectionOf(Json const& state, hstring const& owner) {
    for (auto const& entry : array(state, L"accounts")) {
        auto account = entry.GetObject();
        if (text(account, L"id") == owner) return object(account, L"settings").Stringify();
    }
    return {};
}
hstring contextOf(Json const& state, hstring const& owner) {
    Json context;
    context.Insert(L"settings", subset(object(state, L"settings"), {L"policy", L"ai", L"preferences"}));
    auto workspace = object(state, L"workspace"), learning = object(workspace, L"styleLearning");
    context.Insert(L"brain", object(workspace, L"brain")); context.Insert(L"skills", array(workspace, L"skills"));
    context.Insert(L"style", object(learning, L"profile")); context.Insert(L"identity", object(object(learning, L"settings"), L"identity"));
    put(context, L"connection", connectionOf(state, owner)); return context.Stringify();
}
bool ownedState(Page const& p, Json const& next) {
    return text(object(next, L"account"), L"id") == p->owner && !connectionOf(next, p->owner).empty();
}
void acceptState(Page const& p, Json const& next) {
    require(ownedState(p, next), L"The mailbox connection changed. Reopen this page from the original account.");
    auto context = contextOf(next, p->owner);
    if (!p->context.empty() && p->context != context) p->clearResult();
    p->state = clone(next); p->context = context; p->connection = connectionOf(next, p->owner);
    p->shell->state = clone(next);
}
void validateContext(Page const& p, hstring const& captured) {
    require(p->current() && p->context == captured && contextOf(p->shell->state, p->owner) == captured,
        L"The account, model, identity or permissions changed. Review fresh context before continuing.");
}
Editor& editor(Page const& p, wchar_t const* name, Json const& value) {
    auto& form = p->forms[name]; form.accept(value); return form;
}
TextBox editText(Page const& p, StackPanel const& panel, wchar_t const* formName, wchar_t const* key, wchar_t const* caption, int limit, bool multiline = false) {
    auto control = field(caption, text(p->forms[formName].value, key), multiline); control.MaxLength(limit);
    p->forms[formName].fields[key] = make_weak(control); std::weak_ptr<Intelligence> weak = p;
    control.TextChanged([weak, form = std::wstring(formName), key = std::wstring(key)](auto const& sender, auto const&) {
        if (auto p = weak.lock(); p && p->current() && !p->forms[form].initializing) {
            auto& edit = p->forms[form]; put(edit.value, key.c_str(), sender.template as<TextBox>().Text());
            if (form == L"identity" && key != L"confirmed") {
                truth(edit.value, L"confirmed", false);
                if (auto box = edit.toggles[L"confirmed"].get()) box.IsChecked(false);
            }
            p->changed(form);
        }
    }); panel.Children().Append(control); return control;
}
CheckBox editCheck(Page const& p, StackPanel const& panel, wchar_t const* formName, wchar_t const* key, hstring caption) {
    CheckBox control; control.Content(box_value(caption)); control.IsChecked(flag(p->forms[formName].value, key));
    p->forms[formName].toggles[key] = make_weak(control); std::weak_ptr<Intelligence> weak = p;
    control.Click([weak, form = std::wstring(formName), key = std::wstring(key)](auto const& sender, auto const&) {
        if (auto p = weak.lock(); p && p->current() && !p->forms[form].initializing) {
            truth(p->forms[form].value, key.c_str(), checked(sender.template as<CheckBox>()));
            if (form == L"learning" && key == L"enabled" && !flag(p->forms[form].value, L"enabled")) {
                truth(p->forms[form].value, L"weekly", false);
                if (auto box = p->forms[form].toggles[L"weekly"].get()) box.IsChecked(false);
            }
            p->changed(form);
        }
    }); panel.Children().Append(control); return control;
}
void editNumber(Page const& p, StackPanel const& panel, wchar_t const* formName, wchar_t const* key, wchar_t const* caption, double minimum, double maximum, double step = 1) {
    NumberBox control; control.Header(box_value(caption)); control.Minimum(minimum); control.Maximum(maximum); control.SmallChange(step);
    control.SpinButtonPlacementMode(NumberBoxSpinButtonPlacementMode::Compact); control.Value(p->forms[formName].value.GetNamedNumber(key, minimum));
    p->forms[formName].numbers[key] = make_weak(control); std::weak_ptr<Intelligence> weak = p;
    control.ValueChanged([weak, form = std::wstring(formName), key = std::wstring(key)](NumberBox const& sender, auto const&) {
        if (auto p = weak.lock(); p && p->current() && !p->forms[form].initializing) {
            p->forms[form].value.Insert(key, std::isfinite(sender.Value()) ? Value::CreateNumberValue(sender.Value()) : Value::CreateNullValue()); p->changed(form);
        }
    }); panel.Children().Append(control);
}
ComboBox editChoice(Page const& p, StackPanel const& panel, wchar_t const* formName, wchar_t const* key, wchar_t const* caption,
    std::initializer_list<std::pair<wchar_t const*, wchar_t const*>> choices, bool numeric = false) {
    ComboBox control; control.Header(box_value(caption)); control.HorizontalAlignment(xaml::HorizontalAlignment::Stretch);
    auto value = p->forms[formName].value.TryLookup(key);
    for (auto const& [id, title] : choices) {
        auto stored = numeric ? Value::CreateNumberValue(std::stod(id)) : Value::CreateStringValue(id);
        ComboBoxItem item; item.Content(box_value(title)); item.Tag(box_value(stored.Stringify())); control.Items().Append(item);
        if (value && value.Stringify() == stored.Stringify()) control.SelectedItem(item);
    }
    p->forms[formName].choices[key] = make_weak(control); std::weak_ptr<Intelligence> weak = p;
    control.SelectionChanged([weak, form = std::wstring(formName), key = std::wstring(key)](auto const& sender, auto const&) {
        if (auto p = weak.lock(); p && p->current() && !p->forms[form].initializing) {
            auto item = sender.template as<ComboBox>().SelectedItem().template try_as<ComboBoxItem>();
            if (item) { p->forms[form].value.Insert(key, Value::Parse(unbox_value<hstring>(item.Tag()))); p->changed(form); }
        }
    }); panel.Children().Append(control); return control;
}

// Keeping the callable in this coroutine frame also keeps coroutine-lambda
// captures alive across awaits. Buttons themselves capture only a weak page.
fire_and_forget perform(Page p, std::function<IAsyncAction(Page)> task) {
    if (!p->current() || p->busy || p->cancelling || p->shell->loading) co_return;
    p->busy = true; ++p->revision; p->dirty(); p->tell(L"Working…");
    // NavigationView contains the page itself. Disabling it also disables the
    // independent cancel-analysis button. Shell's loading guard blocks sidebar
    // navigation; the content control below blocks field and keyboard edits.
    p->shell->loading = true;
    if (auto host = p->editorHost.get()) host.IsEnabled(false);
    try { co_await task(p); }
    catch (ApiError const& error) {
        if (error.status == 403 || error.status == 409 || error.status == 404) p->clearResult();
        p->tell(error.message());
    }
    catch (hresult_error const& error) { p->tell(error.message()); }
    catch (...) { p->tell(L"The request could not finish. Your saved data is retained. Retry only after reviewing its status."); }
    p->busy = false; p->generatingStyle = false;
    if (auto cancel = p->cancelStyle.get()) cancel.IsEnabled(false);
    if (p->current()) { if (auto host = p->editorHost.get()) host.IsEnabled(true); p->dirty(); }
    else p->shell->dirty.erase(p->key());
    p->shell->loading = false;
}
Button action(Page const& p, StackPanel const& panel, hstring const& caption, std::function<IAsyncAction(Page)> task) {
    std::weak_ptr<Intelligence> weak = p;
    auto control = button(caption, [weak, task = std::move(task)] { if (auto p = weak.lock()) perform(p, task); });
    panel.Children().Append(control); return control;
}
IAsyncAction changePage(Page p, hstring target) {
    if (!p->current() || p->busy || p->cancelling) co_return;
    if (p->edited() && !(co_await p->shell->confirm(L"Discard unsaved edits?", L"Only explicitly saved settings, styles and workspace notes take effect.", L"Discard"))) co_return;
    if (!p->current()) co_return;
    auto shell = p->shell; p->stop();
    co_await intelligencePage(shell, target);
}
void renderLearning(Page const& p);
void renderSuggestions(Page const& p);
void renderSkills(Page const& p);
void renderRecords(Page const& p);
IAsyncAction loadMessages(Page p);
void renderTool(Page const& p);

Json learning(Page const& p) { return object(object(p->state, L"workspace"), L"styleLearning"); }
Json learningFields(Json const& value) { return subset(object(value, L"settings"), {L"enabled", L"weekly", L"months", L"maxSamples", L"tokenBudget"}); }
void updateLearningForms(Page const& p, bool settings = false, bool identity = false) {
    auto value = learning(p);
    if (settings || !p->forms[L"learning"].dirty()) p->forms[L"learning"].accept(learningFields(value));
    if (identity || !p->forms[L"identity"].dirty()) p->forms[L"identity"].accept(identityFields(object(object(value, L"settings"), L"identity")));
    renderLearning(p); p->dirty();
}
hstring learningReview(Page const& p, Json const& preview) {
    auto model = object(object(p->state, L"settings"), L"ai");
    auto result = L"Account: " + p->owner + L" · your downloaded Sent bodies only\nModel: " + text(model, L"model") + L"\nEndpoint: " + text(model, L"baseUrl") +
        L"\n" + count(preview, L"sampleCount") + L" / " + count(preview, L"eligible") + L" useful samples · cap " + count(preview, L"effectiveCap") +
        L"\nEstimated tokens ≤ " + count(preview, L"estimatedTokens") + L" · budget " + count(preview, L"tokenBudget") +
        L"\nQuote/signature removal is heuristic. Review all samples on the page. This generates a proposal only; your approved style remains until Save approved style.";
    uint32_t i = 0;
    for (auto const& sample : array(preview, L"samples")) { if (i++ == 2) break; result = result + L"\n\nSample excerpt:\n" + bounded(text(sample.GetObject(), L"body"), 200); }
    return result;
}
IAsyncAction generateStyle(Page p) {
    require(!p->edited(), L"Save or discard settings, identity and proposal edits before analysis.");
    auto value = learning(p), preview = object(value, L"preview");
    require(flag(value, L"permitted") && flag(object(value, L"settings"), L"enabled") && text(preview, L"status") == L"prepared", L"Prepare valid samples using saved opt-in and permitted Sent body access first.");
    auto id = text(preview, L"id"), context = p->context;
    if (!(co_await p->shell->confirm(L"Analyze these samples — uses AI?", learningReview(p, preview), L"Generate style proposal")) || !p->current()) co_return;
    validateContext(p, context);
    auto epoch = ++p->learningRevision; p->generatingStyle = true;
    if (auto cancel = p->cancelStyle.get()) cancel.IsEnabled(true);
    p->tell(L"Analyzing reviewed Sent samples. Cancel revokes the result; provider tokens may already be used.");
    Json body; put(body, L"previewId", id);
    auto result = co_await p->shell->service->request(L"/style/generate", p->owner, L"POST", body);
    if (!p->current() || epoch != p->learningRevision) co_return;
    acceptState(p, result); renderLearning(p); p->tell(L"Analysis finished. Review the proposal before Save approved style.");
}
IAsyncAction previewStyle(Page p, bool analyze) {
    require(!p->edited(), L"Save or discard settings, identity and proposal edits before preparing samples.");
    auto preview = object(learning(p), L"preview");
    if (text(preview, L"status") == L"ready" && !(co_await p->shell->confirm(L"Replace the current style proposal?", L"Your approved style is retained. The unsaved proposal will be replaced by a new reviewed selection.", L"Replace proposal"))) co_return;
    if (!p->current()) co_return;
    auto result = co_await p->shell->service->request(L"/style/preview", p->owner, L"POST");
    if (!p->current()) co_return;
    acceptState(p, result); renderLearning(p);
    p->tell(L"Samples prepared locally. No AI call has been made.");
    if (analyze) co_await generateStyle(p);
}
fire_and_forget revokeStyle(Page p) {
    if (!p->current() || p->cancelling) co_return;
    p->cancelling = true; p->dirty();
    auto settings = learningFields(learning(p));
    try {
        if (co_await p->shell->confirm(L"Cancel analysis / discard preview?", L"The preview and any pending result are revoked. The approved style and confirmed identity remain. An in-flight model request may still finish and use tokens.", L"Revoke preview")) {
            if (p->current()) {
                ++p->learningRevision; ++p->revision;
                auto result = co_await p->shell->service->request(L"/style/settings", p->owner, L"POST", settings);
                if (p->current()) { acceptState(p, result); renderLearning(p); p->tell(L"Preview revoked. Approved style retained; any provider request already underway may still consume tokens."); }
            }
        }
    } catch (hresult_error const& error) { p->tell(error.message()); }
    catch (...) { p->tell(L"Preview revocation was not confirmed. Refresh before retrying."); }
    p->cancelling = false;
    if (p->live) p->dirty(); else if (!p->busy) p->shell->dirty.erase(p->key());
}
void renderLearning(Page const& p) {
    auto panel = p->previewPanel.get(); if (!panel) return;
    auto value = learning(p), preview = object(value, L"preview"), profile = object(value, L"profile");
    auto signature = value.Stringify();
    if (signature == p->learningPaint) return;
    auto id = text(preview, L"id");
    auto readyId = text(preview, L"status") == L"ready" ? id : hstring();
    if (readyId != p->previewVoiceId) {
        if (!p->previewVoiceId.empty() && p->forms[L"voice"].dirty()) p->tell(L"The proposal changed or was revoked; its stale editor has been cleared.");
        Json voice; put(voice, L"voice", readyId.empty() ? hstring() : text(preview, L"voice")); p->forms[L"voice"].accept(voice); p->previewVoiceId = readyId;
    }
    p->learningPaint = signature; panel.Children().Clear();
    words(panel, flag(value, L"permitted") ? L"Saved opt-in and source permissions are ready." : L"Requires saved Learning opt-in, AI enabled, Email Brain, Sent and body access. Import Sent mail in Mail settings if needed.");
    if (profile.Size()) { words(panel, flag(profile, L"active") ? L"Approved style — active for writing / replies" : L"Approved style — inactive under current permissions or changed source scope", 18); words(panel, text(profile, L"voice")); }
    else words(panel, L"No approved learned style.");
    if (!preview.Size()) { words(panel, L"No valid preview. Prepare samples to review them without making an AI call."); p->dirty(); return; }
    words(panel, text(preview, L"status") + L" · " + count(preview, L"sampleCount") + L" / " + count(preview, L"eligible") + L" useful samples", 18);
    words(panel, L"Estimated tokens ≤ " + count(preview, L"estimatedTokens") + L" · budget " + count(preview, L"tokenBudget") + L" · effective cap " + count(preview, L"effectiveCap"));
    if (!text(preview, L"error").empty()) words(panel, text(preview, L"error"));
    Expander samples; samples.Header(box_value(L"Review exact selected Sent text")); auto list = stack(10);
    uint32_t i = 0; for (auto const& sample : array(preview, L"samples")) {
        require(++i <= 50 && text(sample.GetObject(), L"body").size() <= 12000, L"The learning review exceeds its supported bounds. Prepare a smaller selection.");
        words(list, L"Sample " + to_hstring(i), 16); words(list, text(sample.GetObject(), L"body"));
    }
    samples.Content(scroll(list)); panel.Children().Append(samples);
    if (text(preview, L"status") == L"prepared") action(p, panel, L"Analyze reviewed samples — uses AI…", generateStyle);
    if (text(preview, L"status") == L"ready") {
        editText(p, panel, L"voice", L"voice", L"Review and edit proposed writing style", 2000, true);
        words(panel, L"Provider-reported tokens: " + count(object(preview, L"usage"), L"total_tokens"));
        action(p, panel, L"Save approved style…", [id](Page page) -> IAsyncAction {
            require(!page->forms[L"learning"].dirty() && !page->forms[L"identity"].dirty(), L"Save or discard Learning settings and identity edits first.");
            auto voice = trim(text(page->forms[L"voice"].value, L"voice")); require(!voice.empty() && voice.size() <= 2000, L"Approved style must contain 1–2,000 characters.");
            if (!(co_await page->shell->confirm(L"Activate this approved writing style?", page->owner + L"\n\n" + voice + L"\n\nThis informs writing/replies under Email Brain permissions. Brain contacts, notes and voice remain unchanged.", L"Save approved style")) || !page->current()) co_return;
            Json body; put(body, L"previewId", id); put(body, L"voice", voice);
            auto result = co_await page->shell->service->request(L"/style/apply", page->owner, L"POST", body);
            if (page->current()) { acceptState(page, result); renderLearning(page); page->tell(L"Approved writing style saved."); }
        });
    }
    p->dirty();
}

void buildLearning(Page const& p, StackPanel const& body) {
    words(body, L"Learn my writing style", 24);
    words(body, L"Learning generates a proposal from this account’s Sent bodies. It never verifies your name from signatures or automatically applies a style.");
    editor(p, L"learning", learningFields(learning(p)));
    editor(p, L"identity", identityFields(object(object(learning(p), L"settings"), L"identity")));
    Json voice; put(voice, L"voice", L""); editor(p, L"voice", voice);
    auto preview = stack(10); body.Children().Append(preview); p->previewPanel = make_weak(preview);
    action(p, body, L"Learn Now — review before AI…", [](Page page) { return previewStyle(page, true); });
    Expander more; more.Header(box_value(L"More learning options")); auto extra=stack(10); more.Content(extra); body.Children().Append(more);
    action(p, extra, L"Preview Sent samples — no AI call", [](Page page) { return previewStyle(page, false); });
    action(p, extra, L"Discard preview (retain approved style)…", [](Page page) -> IAsyncAction {
        if (!(co_await page->shell->confirm(L"Discard the style preview?", L"The approved style and confirmed identity are retained. Pending results will be revoked.", L"Discard preview")) || !page->current()) co_return;
        auto result = co_await page->shell->service->request(L"/style/settings", page->owner, L"POST", learningFields(learning(page)));
        if (page->current()) { ++page->learningRevision; acceptState(page, result); renderLearning(page); page->tell(L"Preview discarded. Approved style retained."); }
    });
    Expander configuration; configuration.Header(box_value(L"Learning configuration")); auto options=stack(12); configuration.Content(options); body.Children().Append(configuration);
    editCheck(p, options, L"learning", L"enabled", L"Enable writing-style learning for this account");
    editCheck(p, options, L"learning", L"weekly", L"Analyze newly sent mail weekly within the saved budget");
    words(options, L"The first eligible analysis starts after enabling, then updates use new cached Sent mail at most weekly while Morrow is open. Every proposal still needs review and Save. It pauses while a preview awaits review; no automatic retry of failed paid jobs.");
    editChoice(p, options, L"learning", L"months", L"Sent history", {{L"1", L"Last month"}, {L"3", L"Last 3 months"}, {L"6", L"Last 6 months"}, {L"12", L"Last 12 months"}}, true);
    editNumber(p, options, L"learning", L"maxSamples", L"Maximum samples (also limited by AI Permissions)", 1, 50);
    editNumber(p, options, L"learning", L"tokenBudget", L"Estimated token budget per analysis", 4000, 64000, 1000);
    action(p, options, L"Save Learning settings…", [](Page page) -> IAsyncAction {
        auto body = clone(page->forms[L"learning"].value);
        auto review = L"Account: " + page->owner + L"\nLearning: " + (flag(body, L"enabled") ? hstring(L"enabled") : hstring(L"disabled")) + L"\nWeekly paid analysis: " + (flag(body, L"weekly") ? hstring(L"enabled") : hstring(L"off")) + L"\nSample cap " + count(body, L"maxSamples") + L" · last " + count(body, L"months") + L" months · budget " + count(body, L"tokenBudget") + L"\nExisting preview is discarded; approved style retained.";
        if (!(co_await page->shell->confirm(L"Save Learning settings?", review, L"Save settings")) || !page->current()) co_return;
        auto result = co_await page->shell->service->request(L"/style/settings", page->owner, L"POST", body);
        if (page->current()) { acceptState(page, result); updateLearningForms(page, true); page->tell(L"Learning settings saved. No immediate analysis was started."); }
    });
    auto identity = group(body, L"Your confirmed identity for this account");
    words(identity, L"Include only names that refer to you, including names used in group mail. Editing either field resets confirmation. Saving identity does not enable Learning or require Sent access.");
    editText(p, identity, L"identity", L"displayName", L"Your display name", 100);
    editText(p, identity, L"identity", L"aliasesText", L"Other names / nicknames — one per line, at most 10", 1100, true);
    editCheck(p, identity, L"identity", L"confirmed", L"I confirm that this name and these aliases identify me for this account");
    action(p, identity, L"Save identity — no AI call…", [](Page page) -> IAsyncAction {
        auto form = page->forms[L"identity"].value; Json identity;
        put(identity, L"displayName", trim(text(form, L"displayName"))); identity.Insert(L"aliases", aliases(text(form, L"aliasesText"))); truth(identity, L"confirmed", flag(form, L"confirmed"));
        if (!(co_await page->shell->confirm(L"Save this identity?", page->owner + L"\n" + text(identity, L"displayName") + L"\n" + aliasesText(identity) + (flag(identity, L"confirmed") ? L"\nConfirmed for AI identity context." : L"\nUnconfirmed — identity will not be used by AI.") + L"\nThis revokes pending style previews/results; the approved style remains.", L"Save identity")) || !page->current()) co_return;
        Json body; body.Insert(L"identity", identity);
        auto result = co_await page->shell->service->request(L"/style/settings", page->owner, L"POST", body);
        if (page->current()) { acceptState(page, result); updateLearningForms(page, false, true); page->tell(L"Identity saved for this account only."); }
    });
    action(p, body, L"Delete learned style & stop learning…", [](Page page) -> IAsyncAction {
        if (!(co_await page->shell->confirm(L"Delete learned style and stop learning?", L"This account’s approved style and preview are removed, and Learning is disabled. Confirmed identity and separate Email Brain notes/contacts remain.", L"Delete learned style")) || !page->current()) co_return;
        auto result = co_await page->shell->service->request(L"/style/profile", page->owner, L"DELETE");
        if (page->current()) { acceptState(page, result); updateLearningForms(page, true); page->tell(L"Learned style removed; Learning stopped."); }
    });
    action(p, body, L"Discard unsaved Learning edits", [](Page page) -> IAsyncAction {
        for (auto name : {L"learning", L"identity", L"voice"}) page->forms[name].accept(page->forms[name].saved);
        page->dirty(); page->tell(L"Saved values restored."); co_return;
    });
    renderLearning(p);
}

Json brainFields(Json const& state) {
    auto brain = object(object(state, L"workspace"), L"brain"); Json value;
    put(value, L"voice", text(brain, L"voice")); put(value, L"notes", text(brain, L"notes")); return value;
}
void memorySources(StackPanel const& panel, Json const& item) {
    for (auto const& entry : array(item, L"sourceLabels")) {
        auto source = entry.GetObject(); words(panel, L"Source: " + text(source, L"subject") + L" · " + text(source, L"date"), 12);
    }
}
void renderMemoryPreview(Page const& p) {
    auto panel = p->memoryPanel.get(); if (!panel) return; panel.Children().Clear();
    auto preview = p->memoryPreview;
    if (!preview.Size()) return;
    auto items = array(preview, L"items");
    if (!items.Size()) words(panel, L"No durable memories found in this selection.");
    for (auto const& entry : items) {
        auto item = entry.GetObject(); CheckBox check;
        auto content = stack(4); words(content, text(item, L"text")); memorySources(content, item); check.Content(content);
        auto id = text(item, L"id"); std::weak_ptr<Intelligence> weak = p;
        check.Checked([weak, id](auto const&, auto const&) { if (auto page = weak.lock()) page->selectedMemories.insert(std::wstring(id)); });
        check.Unchecked([weak, id](auto const&, auto const&) { if (auto page = weak.lock()) page->selectedMemories.erase(std::wstring(id)); });
        panel.Children().Append(check);
    }
    action(p, panel, L"Save selected memories", [](Page page) -> IAsyncAction {
        require(!page->forms[L"brain"].dirty(), L"Save or discard your notes first.");
        require(!page->selectedMemories.empty(), L"Select the memories you want to keep.");
        Json input; put(input, L"previewId", text(page->memoryPreview, L"id")); Array ids;
        for (auto const& id : page->selectedMemories) ids.Append(Value::CreateStringValue(hstring(id)));
        input.Insert(L"itemIds", ids);
        auto state = co_await page->shell->service->request(L"/workspace/brain/apply", page->owner, L"POST", input);
        if (!page->current()) co_return; acceptState(page, state);
        auto shell = page->shell; page->stop(); co_await intelligencePage(shell, L"brain");
    });
    action(p, panel, L"Dismiss suggestions", [](Page page) -> IAsyncAction {
        auto saved=object(object(object(page->state,L"workspace"),L"brainLearning"),L"preview");
        if (text(saved,L"id") == text(page->memoryPreview,L"id")) {
            Json input; put(input,L"previewId",text(saved,L"id"));
            auto state=co_await page->shell->service->request(L"/workspace/brain/dismiss",page->owner,L"POST",input);
            if (!page->current()) co_return; acceptState(page,state);
        }
        page->clearResult();
    });
}
void buildBrain(Page const& p, StackPanel const& body) {
    words(body, L"Email Brain", 24);
    auto policy = object(object(p->state, L"settings"), L"policy");
    words(body, flag(policy, L"enabled") && flag(object(policy, L"behaviors"), L"memory")
        ? L"Explicitly saved voice and notes may inform permitted AI requests. They remain local until included in an authorized model request."
        : L"Email Brain is disabled by your saved permissions. Saved notes will not inform AI requests.");
    words(body, L"Keep useful context for this mailbox. You choose what is remembered.");
    auto automatic = object(object(p->state,L"workspace"),L"brainLearning");
    editor(p,L"memoryOptions",subset(automatic,{L"enabled",L"tokenBudget"}));
    auto automaticPanel = group(body,L"Automatic learning");
    editCheck(p,automaticPanel,L"memoryOptions",L"enabled",L"Suggest new memories weekly");
    editNumber(p,automaticPanel,L"memoryOptions",L"tokenBudget",L"Estimated tokens per analysis",4000,64000,1000);
    words(automaticPanel,L"First analysis starts after enabling; later analyses run weekly when mail changes. Proposals survive restart and wait for your review. Status: " + text(automatic,L"status"),12);
    if (!text(automatic,L"error").empty()) words(automaticPanel,text(automatic,L"error"));
    action(p,automaticPanel,L"Save automatic learning",[](Page page) -> IAsyncAction {
        auto options=clone(page->forms[L"memoryOptions"].value);
        if (flag(options,L"enabled") && !(co_await page->shell->confirm(L"Enable automatic memory suggestions?",page->owner + L"\nWeekly budget: " + count(options,L"tokenBudget") + L" estimated tokens. Uses your configured model and permitted downloaded mail while Morrow is open. Provider charges may apply. Proposals require review before saving.",L"Enable"))) co_return;
        auto state=co_await page->shell->service->request(L"/workspace/brain/settings",page->owner,L"POST",options);
        if (!page->current()) co_return; acceptState(page,state); page->forms[L"memoryOptions"].accept(options); page->dirty();
    });
    auto suggestions = group(body, L"Find memories in your mail");
    words(suggestions, L"Suggest up to 8 memories from your latest permitted mail. Review the sources and select what to keep. Your saved notes are retained.");
    action(p, suggestions, L"Suggest memories — uses AI…", [](Page page) -> IAsyncAction {
        require(!page->forms[L"brain"].dirty(), L"Save or discard your notes first.");
        auto settings = object(page->state, L"settings"), model = object(settings, L"ai"), policy = object(settings, L"policy");
        auto captured = page->context;
        if (!(co_await page->shell->confirm(L"Suggest memories from mail?", page->owner + L"\nModel: " + text(model, L"model") + L"\nUp to " + count(policy, L"maxMessages") + L" permitted downloaded messages. Provider charges may apply. Suggestions are saved only after your review.", L"Suggest memories")) || !page->current()) co_return;
        validateContext(page, captured); page->clearResult();
        auto result = co_await page->shell->service->request(L"/workspace/brain/preview", page->owner, L"POST", Json());
        if (!page->current()) co_return; validateContext(page, captured);
        page->memoryPreview = object(result, L"preview"); renderMemoryPreview(page);
    });
    auto memoryPanel = stack(12); suggestions.Children().Append(memoryPanel); p->memoryPanel = make_weak(memoryPanel);
    p->memoryPreview = object(automatic,L"preview"); renderMemoryPreview(p);
    words(body, L"Your instructions", 20);
    editor(p, L"brain", brainFields(p->state));
    editText(p, body, L"brain", L"voice", L"Writing voice", 2000, true);
    editText(p, body, L"brain", L"notes", L"Notes to remember", 4000, true);
    action(p, body, L"Save Brain notes", [](Page page) -> IAsyncAction {
        auto input = clone(page->forms[L"brain"].value);
        auto result = co_await page->shell->service->request(L"/workspace/brain", page->owner, L"POST", input);
        if (!page->current()) co_return;
        acceptState(page, result); page->forms[L"brain"].accept(brainFields(result)); page->dirty(); page->tell(L"Brain notes saved for this account. Contacts and learned style were retained.");
    });
    action(p, body, L"Discard unsaved Brain edits", [](Page page) -> IAsyncAction {
        page->forms[L"brain"].accept(brainFields(page->state)); page->dirty(); page->tell(L"Saved notes restored."); co_return;
    });
    action(p, body, L"Clear Brain…", [](Page page) -> IAsyncAction {
        if (!(co_await page->shell->confirm(L"Clear Email Brain?", page->owner + L"\nSaved Brain voice, notes and contacts will be removed. Confirmed identity and the separate learned style remain.", L"Clear Brain")) || !page->current()) co_return;
        auto result = co_await page->shell->service->request(L"/workspace/brain", page->owner, L"DELETE");
        if (!page->current()) co_return;
        acceptState(page, result); page->forms[L"brain"].accept(brainFields(result)); page->dirty();
        auto shell = page->shell; page->stop(); co_await intelligencePage(shell, L"brain");
    });
    auto memories = group(body, L"Reviewed memories");
    auto facts = array(object(object(p->state, L"workspace"), L"brain"), L"facts");
    if (!facts.Size()) words(memories, L"No reviewed memories yet. Start with Suggest memories above.");
    for (auto const& entry : facts) {
        auto fact = entry.GetObject(); auto row = stack(6); words(row, text(fact, L"text")); memorySources(row, fact);
        action(p, row, L"Remove memory", [id = text(fact, L"id")](Page page) -> IAsyncAction {
            require(!page->forms[L"brain"].dirty(), L"Save or discard your notes first.");
            auto state = co_await page->shell->service->request(L"/workspace/brain/facts/" + escaped(id), page->owner, L"DELETE", Json());
            if (!page->current()) co_return; acceptState(page, state);
            auto shell = page->shell; page->stop(); co_await intelligencePage(shell, L"brain");
        }); memories.Children().Append(row);
    }
    words(memories, L"Memories are used only while their source mail and permissions still match.", 12);
    std::weak_ptr<Intelligence> weak = p;
    body.Children().Append(button(L"Writing style & identity…", [weak] { if (auto page = weak.lock()) changePage(page, L"learning"); }));
    Expander savedContacts; savedContacts.Header(box_value(L"Saved contacts")); auto contacts = stack(8); savedContacts.Content(contacts); body.Children().Append(savedContacts);
    auto values = array(object(object(p->state, L"workspace"), L"brain"), L"contacts");
    if (!values.Size()) words(contacts, L"No saved contacts.");
    uint32_t displayed = 0;
    for (auto const& value : values) {
        if (displayed++ == 100) { words(contacts, L"Additional contacts are retained in the workspace."); break; }
        auto contact = value.GetObject(); words(contacts, text(contact, L"name", L"Contact") + L" · " + text(contact, L"email"));
    }
}

bool suggestionsRunning(Page const& p) {
    auto status = text(object(p->suggestions, L"job"), L"status"); return status == L"queued" || status == L"running";
}
void acceptSuggestions(Page const& p, Json const& next, bool saved = false) {
    require(text(next, L"owner") == p->owner, L"Suggestions belong to another mailbox. Reopen this account.");
    p->suggestions = clone(next);
    if (saved || !p->forms[L"suggestions"].dirty()) p->forms[L"suggestions"].accept(object(next, L"settings"));
    std::set<std::wstring> eligible;
    for (auto const& item : array(next, L"candidates")) eligible.insert(std::wstring(text(item.GetObject(), L"id")));
    std::erase_if(p->selectedCandidates, [&](auto const& id) { return !eligible.contains(id); });
    renderSuggestions(p); p->dirty();
}
hstring messageCaption(Json const& value) {
    return text(value, L"fromName", text(value, L"fromEmail", L"Sender withheld")) + L" — " + text(value, L"subject", L"Subject withheld") + L"\n" + text(value, L"date");
}
hstring coverage(Json const& value) {
    return count(value, L"usedMessages") + L" / " + count(value, L"matchedMessages") + L" matching downloaded messages used";
}
IAsyncAction useSuggestion(Page p, hstring id) {
    require(!p->edited(), L"Save or discard suggestion settings before opening a draft.");
    auto context = p->context; Json input; put(input, L"id", id);
    auto result = co_await p->shell->service->request(L"/reply-suggestions/use", p->owner, L"POST", input);
    if (!p->current()) co_return; validateContext(p, context);
    auto message = object(result, L"message"); auto messageId = text(message, L"id"), reply = text(result, L"text");
    require(text(message, L"accountId") == p->owner && !messageId.empty() && !reply.empty(), L"The suggestion owner or source changed.");
    Json request; put(request, L"messageId", messageId); put(request, L"mode", L"reply"); put(request, L"body", reply);
    auto prepared = co_await p->shell->service->request(L"/drafts/prepare", p->owner, L"POST", request);
    if (!p->current()) co_return; validateContext(p, context);
    auto draft = object(prepared, L"draft");
    require(text(draft, L"accountId") == p->owner && text(draft, L"replyToId") == messageId && text(draft, L"body") == reply && text(draft, L"bcc").empty(), L"The prepared reply could not be confirmed for this suggestion.");
    // The server's fresh projection checks connection/permission generations,
    // source hashes and approved style, including changes during draft prepare.
    auto latest = co_await p->shell->service->request(L"/reply-suggestions", p->owner);
    if (!p->current()) co_return; validateContext(p, context);
    bool valid = false;
    if (text(latest, L"owner") == p->owner) for (auto const& entry : array(latest, L"proposals")) {
        auto proposal = entry.GetObject();
        if (text(proposal, L"id") == id && text(proposal, L"messageId") == messageId && text(proposal, L"text") == reply && text(object(proposal, L"message"), L"accountId") == p->owner) valid = true;
    }
    require(valid, L"This suggestion was revoked or its sources changed. Review a fresh batch.");
    p->shell->dirty.erase(p->key()); auto shell = p->shell; p->stop(); co_await compose(shell, draft);
}
IAsyncAction saveAutomaticReplies(Page page, Json input) {
    if (flag(input,L"automatic") && !(co_await page->shell->confirm(L"Automatically find mail that needs a reply?",page->owner + L"\nModel: " + text(object(page->suggestions,L"model"),L"model") + L"\nEndpoint: " + text(object(page->suggestions,L"model"),L"baseUrl") + L"\nDaily budget: " + count(input,L"dailyTokenBudget") + L" estimated tokens per UTC day. Uses permitted Inbox and correspondence while Morrow is open. Provider charges may apply. No mail is sent automatically.",L"Enable automatic checks"))) co_return;
    if (!page->current()) co_return;
    auto result=co_await page->shell->service->request(L"/reply-suggestions/settings",page->owner,L"POST",input);
    if (page->current()) { acceptSuggestions(page,result,true); page->tell(L"Automatic reply settings saved."); }
}
void renderSuggestions(Page const& p) {
    auto jobs=p->jobPanel.get(), proposals=p->proposalPanel.get();
    if (!jobs || !proposals) return;
    auto value=p->suggestions, job=object(value,L"job"); auto signature=value.Stringify();
    if (p->suggestionPaint==signature) return;
    p->suggestionPaint=signature; jobs.Children().Clear(); proposals.Children().Clear();
    if (!flag(value,L"identityReady")) {
        words(jobs,L"Confirm the name to use in your replies first.");
        std::weak_ptr<Intelligence> weak=p;
        jobs.Children().Append(button(L"Confirm my identity",[weak] { if (auto page=weak.lock()) changePage(page,L"learning"); }));
    } else if (!flag(value,L"modelReady") || (!flag(value,L"permitted") && flag(object(value,L"settings"),L"enabled"))) {
        for (auto const& requirement:array(value,L"requirements")) words(jobs,requirement.GetString());
        words(jobs,L"Review Model and AI Permissions in Settings.");
    } else if (!flag(value,L"automaticReady")) {
        action(p,jobs,L"Enable automatic reply suggestions",[](Page page) -> IAsyncAction {
            auto options=clone(page->forms[L"suggestions"].value); truth(options,L"enabled",true); truth(options,L"automatic",true); options.Insert(L"tokenBudget",Value::CreateNumberValue(64000));
            co_await saveAutomaticReplies(page,options);
        });
    } else words(jobs,suggestionsRunning(p) ? L"Checking mail in the background…" : L"Automatic checks are on.");
    if (flag(value,L"automaticReady")) words(jobs,text(value,L"automaticStatus"),12);
    if (!text(job,L"error").empty()) words(jobs,text(job,L"error"));
    if (text(job,L"status")==L"failed" || text(job,L"status")==L"interrupted" || text(job,L"status")==L"cancelled") {
        action(p,jobs,L"Review & restart checks",[](Page page) { return saveAutomaticReplies(page,clone(page->forms[L"suggestions"].value)); });
    }
    if (!array(value,L"proposals").Size()) words(proposals,suggestionsRunning(p) ? L"Suggestions appear as messages are checked." : L"No replies waiting for review. Unnecessary replies are filtered out; AI can still miss a request.");
    for (auto const& entry:array(value,L"proposals")) {
        auto proposal=entry.GetObject(), message=object(proposal,L"message");
        require(text(message,L"accountId")==p->owner,L"Suggestion belongs to another mailbox.");
        auto row=group(proposals,messageCaption(message)); words(row,text(proposal,L"reason")); auto id=text(proposal,L"id");
        action(p,row,L"Review suggested reply…",[id](Page page) { return useSuggestion(page,id); });
        action(p,row,L"Ignore",[id](Page page) -> IAsyncAction {
            Json input; put(input,L"id",id);
            auto result=co_await page->shell->service->request(L"/reply-suggestions/dismiss",page->owner,L"POST",input);
            if (page->current()) acceptSuggestions(page,result);
        });
    }
}
void buildSuggestions(Page const& p, StackPanel const& body) {
    words(body,L"Needs a reply",24);
    words(body,L"AI checks downloaded Inbox mail and leaves out messages that do not need a reply. Open a suggestion to edit or send it, or ignore the email.");
    editor(p,L"suggestions",object(p->suggestions,L"settings"));
    auto jobs=stack(10), proposals=stack(14); body.Children().Append(jobs); body.Children().Append(proposals);
    p->jobPanel=make_weak(jobs); p->proposalPanel=make_weak(proposals);
    Expander details; details.Header(box_value(L"Automatic checks & budget")); auto options=stack(12); details.Content(options); body.Children().Append(details);
    editCheck(p,options,L"suggestions",L"automatic",L"Check new Inbox mail automatically");
    editNumber(p,options,L"suggestions",L"dailyTokenBudget",L"Daily token budget (UTC day)",4000,2000000,1000);
    words(options,L"Used today: " + count(p->suggestions,L"spentToday") + L" estimated tokens. Checks cover the newest 200 downloaded Inbox messages and permitted correspondence. Provider billing may differ. Mail is never sent automatically.",12);
    action(p,options,L"Save",[](Page page) -> IAsyncAction {
        auto options=clone(page->forms[L"suggestions"].value); if (flag(options,L"automatic")) truth(options,L"enabled",true);
        co_await saveAutomaticReplies(page,options);
    });
    renderSuggestions(p);
}

Json skillFields(Json const& value = Json()) {
    Json result; put(result, L"id", text(value, L"id")); put(result, L"name", text(value, L"name"));
    put(result, L"instructions", text(value, L"instructions"));
    truth(result, L"enabled", !value.HasKey(L"enabled") || flag(value, L"enabled"));
    auto folders = object(value, L"folders");
    for (auto folder : {L"inbox", L"sent", L"drafts", L"archive", L"trash"}) truth(result, folder, folders.Size() ? flag(folders, folder) : std::wstring_view(folder) == L"inbox");
    return result;
}
void renderSkills(Page const& p) {
    auto list = p->skillList.get(); if (!list) return; list.Children().Clear();
    auto skills = array(object(p->state, L"workspace"), L"skills");
    if (!skills.Size()) words(list, L"No saved skills. Create instructions and a folder scope below.");
    for (auto const& entry : skills) {
        auto skill = entry.GetObject(); auto id = text(skill, L"id");
        auto item = group(list, text(skill, L"name") + (flag(skill, L"enabled") ? L"" : L" — disabled"));
        words(item, text(skill, L"instructions")); hstring folders;
        for (auto const& folder : object(skill, L"folders")) if (folder.Value().ValueType() == JsonValueType::Boolean && folder.Value().GetBoolean()) folders = folders + (folders.empty() ? L"" : L", ") + folder.Key();
        words(item, L"Allowed folders: " + (folders.empty() ? hstring(L"none") : folders) + L". Global AI permissions still apply.");
        action(p, item, L"Edit skill", [skill](Page page) -> IAsyncAction {
            if (page->forms[L"skill"].dirty() && !(co_await page->shell->confirm(L"Discard current skill edits?", L"Load this saved skill into the editor below.", L"Edit saved skill"))) co_return;
            if (!page->current()) co_return;
            page->forms[L"skill"].accept(skillFields(skill)); page->dirty(); page->tell(L"Saved skill loaded in the editor below.");
        });
        action(p, item, L"Delete skill…", [id, name = text(skill, L"name")](Page page) -> IAsyncAction {
            if (!(co_await page->shell->confirm(L"Delete this skill?", page->owner + L"\n" + name + L"\nMessages are retained. Pending AI results using the old skill will be rejected.", L"Delete skill")) || !page->current()) co_return;
            auto result = co_await page->shell->service->request(L"/skills/" + escaped(id), page->owner, L"DELETE");
            if (!page->current()) co_return; acceptState(page, result);
            if (text(page->forms[L"skill"].value, L"id") == id) page->forms[L"skill"].accept(skillFields());
            renderSkills(page); page->dirty(); page->tell(L"Skill deleted.");
        });
    }
}
void buildSkills(Page const& p, StackPanel const& body) {
    words(body, L"My email skills", 24);
    words(body, L"Save reusable instructions, then choose Custom email skills in AI Studio to run one. Saving never calls AI; skills cannot send mail or execute external actions. Keep at most 20 skills.");
    editor(p, L"skill", skillFields()); auto list = stack(16); body.Children().Append(list); p->skillList = make_weak(list);
    auto fields = group(body, L"Create / edit skill");
    editText(p, fields, L"skill", L"name", L"Name", 80);
    editText(p, fields, L"skill", L"instructions", L"Instructions", 4000, true);
    editCheck(p, fields, L"skill", L"enabled", L"Enable this skill");
    for (auto folder : {L"inbox", L"sent", L"drafts", L"archive", L"trash"}) editCheck(p, fields, L"skill", folder, folder);
    action(p, fields, L"Save skill", [](Page page) -> IAsyncAction {
        auto value = page->forms[L"skill"].value;
        require(!trim(text(value, L"name")).empty() && !trim(text(value, L"instructions")).empty(), L"Enter a skill name and instructions.");
        Json input, folders; for (auto key : {L"name", L"instructions"}) put(input, key, text(value, key));
        if (!text(value, L"id").empty()) put(input, L"id", text(value, L"id"));
        truth(input, L"enabled", flag(value, L"enabled"));
        for (auto key : {L"inbox", L"sent", L"drafts", L"archive", L"trash"}) truth(folders, key, flag(value, key));
        input.Insert(L"folders", folders);
        auto result = co_await page->shell->service->request(L"/skills", page->owner, L"POST", input);
        if (!page->current()) co_return; acceptState(page, result); page->forms[L"skill"].accept(skillFields());
        renderSkills(page); page->dirty(); page->tell(L"Skill saved. Select it in AI Studio to review a model request.");
    });
    action(p, fields, L"New skill / discard edits…", [](Page page) -> IAsyncAction {
        if (page->forms[L"skill"].dirty() && !(co_await page->shell->confirm(L"Discard skill edits?", L"The saved skill is retained. Start a blank new skill.", L"Discard edits"))) co_return;
        if (page->current()) { page->forms[L"skill"].accept(skillFields()); page->dirty(); page->tell(L"New skill editor ready."); }
    });
    renderSkills(p);
}

void renderRecords(Page const& p) {
    auto panel = p->recordList.get(); if (!panel) return; panel.Children().Clear(); auto workspace = object(p->state, L"workspace");
    if (p->kind == L"summaries") {
        words(panel, L"Saved priority summaries", 24);
        words(panel, L"Completed arrival and scheduled briefings from this account. Opening or refreshing does not trigger AI. Configure opt-in, schedules and permissions in Settings.");
        words(panel, L"Arrival queue overflow: " + count(workspace, L"summaryOverflow") + L". Saved summaries are retained within the service history limit.");
        auto values = array(workspace, L"summaries");
        if (!values.Size()) words(panel, L"No saved reports. AI Studio → Inbox briefing can generate one response on explicit review.");
        for (auto const& entry : values) {
            auto report = entry.GetObject(); auto item = group(panel, text(report, L"kind") + L" · " + text(report, L"status"));
            words(item, text(report, L"completedAt", text(report, L"createdAt")) + L" · " + to_hstring(array(report, L"messageIds").Size()) + L" source messages");
            if (text(report, L"source") == L"demo") words(item, L"Illustrative demo output — not a model analysis.");
            if (!text(report, L"error").empty()) words(item, text(report, L"error"));
            words(item, text(report, L"text"));
        }
        return;
    }
    words(panel, L"Local simulation records", 24);
    words(panel, L"These are local records of reviewed simulations. They have not sent notifications, created provider calendar events or unsubscribed you. Use Calendar for real provider events and Pending for your own follow-up markers.");
    for (auto collection : {L"reminders", L"events", L"unsubscribed", L"activity"}) {
        auto list = group(panel, collection); auto values = array(workspace, collection);
        if (!values.Size()) words(list, L"No records.");
        for (auto const& entry : values) {
            auto record = entry.GetObject(); auto item = group(list, text(record, L"title", L"Local workspace update"));
            words(item, flag(record, L"cancelled") ? L"Cancelled local record" : flag(record, L"done") ? L"Completed local record" : L"Local simulation");
            words(item, text(record, L"detail", text(record, L"summary")));
            if (!text(record, L"when").empty()) words(item, L"Recorded time (with offset): " + text(record, L"when"));
            words(item, text(record, L"createdAt"));
            auto id = text(record, L"id"), name = hstring(collection);
            if ((name == L"reminders" || name == L"events") && !flag(record, L"cancelled")) {
                action(p, item, flag(record, L"done") ? L"Mark incomplete" : L"Mark complete", [id, name, done = flag(record, L"done")](Page page) -> IAsyncAction {
                    Json input; truth(input, L"done", !done);
                    auto result = co_await page->shell->service->request(L"/workspace/" + name + L"/" + escaped(id), page->owner, L"PATCH", input);
                    if (page->current()) { acceptState(page, result); renderRecords(page); page->tell(L"Local record updated."); }
                });
                if (name == L"events") action(p, item, L"Cancel local event record…", [id](Page page) -> IAsyncAction {
                    if (!(co_await page->shell->confirm(L"Cancel this local record?", L"This does not cancel a real provider event; this record is a local simulation only.", L"Cancel local record")) || !page->current()) co_return;
                    Json input; truth(input, L"cancelled", true);
                    auto result = co_await page->shell->service->request(L"/workspace/events/" + escaped(id), page->owner, L"PATCH", input);
                    if (page->current()) { acceptState(page, result); renderRecords(page); page->tell(L"Local event record cancelled."); }
                });
            }
        }
    }
}

Json selectedFeature(Page const& p) {
    auto id = text(p->forms[L"tool"].value, L"action");
    for (auto const& feature : p->features) if (text(feature, L"id") == id) return feature;
    return Json();
}
Json selectedMessage(Page const& p) {
    auto id = text(p->forms[L"tool"].value, L"messageId");
    for (auto const& message : p->messages) if (text(message, L"id") == id && text(message, L"accountId") == p->owner) return message;
    return Json();
}
bool usesDraft(Page const& p) {
    auto value = p->forms[L"tool"].value; auto name = text(value, L"action");
    return name == L"rewrite" || (name == L"translate" && text(value, L"translateSource") == L"draft");
}
bool usesSelected(Page const& p) { return text(selectedFeature(p), L"context") == L"selected" && !usesDraft(p); }
hstring selectedFlags(Json const& flags) {
    hstring result; for (auto const& value : flags) if (value.Value().ValueType() == JsonValueType::Boolean && value.Value().GetBoolean()) result = result + (result.empty() ? L"" : L", ") + value.Key();
    return result.empty() ? hstring(L"none") : result;
}
hstring simulationNote(hstring const& name) {
    if (name == L"triage") return L"Local simulation: stars matching mail only inside Morrow. No provider changes.";
    if (name == L"labels") return L"Local simulation: saves labels only inside Morrow.";
    if (name == L"memory") return L"Local simulation: review before replacing Brain voice, notes and contacts. This is not learned style or verified identity.";
    if (name == L"research") return L"Sample brief from permitted mail; no web lookup or verified company research.";
    if (name == L"meeting") return L"Mock agenda and local preparation record. No provider calendar is accessed.";
    if (name == L"followup") return L"Local reminder record only. No email or background notification will be scheduled.";
    if (name == L"schedule") return L"Local calendar simulation. No real event, invitation or availability check. Use Calendar for provider events.";
    if (name == L"cleanup") return L"Local simulation: archives matching messages inside Morrow only.";
    if (name == L"unsubscribe") return L"Records intent only. You remain subscribed; no link is opened or unsubscribe request sent.";
    if (name == L"attachments") return L"Fictional attachment examples only. No actual attachments are fetched, read or compared.";
    if (name == L"batchReplies") return L"Local simulation: creates separate editable drafts. Each send still requires review.";
    return L"Local simulation only. Review the proposed local changes before applying.";
}
hstring blockedTool(Page const& p) {
    auto feature = selectedFeature(p), value = p->forms[L"tool"].value; auto name = text(feature, L"id");
    auto settings = object(p->state, L"settings"), policy = object(settings, L"policy"), content = object(policy, L"content");
    if (!feature.Size()) return L"Select a supported tool.";
    if (!flag(policy, L"enabled")) return L"AI is off in saved permissions.";
    if (!flag(object(policy, L"behaviors"), name.c_str())) return L"This behavior is disabled in saved AI permissions.";
    if (!flag(feature, L"mock") && !flag(object(settings, L"ai"), L"configured")) return L"Configure a chat model in Settings → Model first.";
    if ((name == L"memory" || name == L"research") && !flag(content, L"contacts")) return L"This tool requires contact-context permission.";
    if ((name == L"meeting" || name == L"schedule") && !flag(content, L"calendar")) return L"This tool requires local calendar-context permission.";
    if (name == L"attachments" && !flag(content, L"attachments")) return L"Sample attachment-context permission is disabled.";
    if (name == L"batchReplies" && (!flag(content, L"sender") || !flag(content, L"body"))) return L"Batch drafts require sender and body permissions.";
    if (usesDraft(p) && (!flag(object(policy, L"folders"), L"drafts") || !flag(content, L"body"))) return L"Enable Drafts and body access for draft actions.";
    if (usesDraft(p) && trim(text(value, L"draftText")).empty()) return L"Enter draft text to process.";
    if ((name == L"ask" || name == L"write") && trim(text(value, L"prompt")).empty()) return L"Enter your question or writing instructions.";
    if (usesSelected(p) && !selectedMessage(p).Size()) return L"Choose a message in a permitted folder from the page below.";
    if (!usesDraft(p) && text(feature, L"context") != L"none" && !flag(content, L"sender") && !flag(content, L"subject") && !flag(content, L"body")) return L"Allow sender, subject or body context first.";
    if (name == L"reply" && flag(value, L"includeHistory") && !flag(content, L"sender")) return L"Suggest with History requires sender permission.";
    if (name == L"skill") {
        bool found = false;
        for (auto const& entry : array(object(p->state, L"workspace"), L"skills")) { auto skill = entry.GetObject(); if (text(skill, L"id") == text(value, L"skillId") && flag(skill, L"enabled")) found = true; }
        if (!found) return L"Choose an enabled saved skill. Create one in My skills first.";
    }
    return {};
}
Json sourceProof(Json const& message, Json const& policy) {
    auto result = subset(message, {L"id", L"accountId", L"date", L"folder", L"read", L"starred", L"category"});
    auto content = object(policy, L"content");
    for (auto key : {L"fromName", L"fromEmail", L"to", L"cc"}) if (flag(content, L"sender")) put(result, key, text(message, key));
    if (flag(content, L"subject")) { put(result, L"subject", text(message, L"subject")); result.Insert(L"labels", array(message, L"labels")); }
    if (flag(content, L"body")) { put(result, L"body", text(message, L"body")); put(result, L"preview", text(message, L"preview")); }
    return result;
}
hstring recordedTime(DatePicker const& date, TimePicker const& time) {
    Windows::Globalization::Calendar calendar; calendar.ChangeCalendarSystem(L"GregorianCalendar"); calendar.SetDateTime(date.Date());
    auto minutes = std::chrono::duration_cast<std::chrono::minutes>(time.Time()).count();
    require(minutes >= 0 && minutes < 1440, L"Choose a local time.");
    SYSTEMTIME local{}, utc{}, roundTrip{};
    local.wYear = static_cast<WORD>(calendar.Year()); local.wMonth = static_cast<WORD>(calendar.Month()); local.wDay = static_cast<WORD>(calendar.Day());
    local.wHour = static_cast<WORD>(minutes / 60); local.wMinute = static_cast<WORD>(minutes % 60);
    require(TzSpecificLocalTimeToSystemTimeEx(nullptr, &local, &utc) && SystemTimeToTzSpecificLocalTimeEx(nullptr, &utc, &roundTrip)
        && local.wYear == roundTrip.wYear && local.wMonth == roundTrip.wMonth && local.wDay == roundTrip.wDay && local.wHour == roundTrip.wHour && local.wMinute == roundTrip.wMinute,
        L"This local time is invalid during a clock change. Choose another time.");
    FILETIME at{}, now{}; GetSystemTimeAsFileTime(&now);
    require(SystemTimeToFileTime(&utc, &at) && CompareFileTime(&at, &now) > 0, L"Choose a future date and time.");
    wchar_t result[32]{};
    swprintf_s(result, L"%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", unsigned(utc.wYear), unsigned(utc.wMonth), unsigned(utc.wDay), unsigned(utc.wHour), unsigned(utc.wMinute), unsigned(utc.wSecond), unsigned(utc.wMilliseconds));
    return hstring(result);
}
void renderToolResult(Page const& p);
IAsyncAction runTool(Page p) {
    auto reason = blockedTool(p); if (!reason.empty()) throw hresult_error(E_INVALIDARG, reason);
    auto feature = selectedFeature(p), value = clone(p->forms[L"tool"].value), message = selectedMessage(p);
    auto name = text(feature, L"id"), context = p->context; bool mock = flag(feature, L"mock"), selected = usesSelected(p);
    Json input; put(input, L"action", name);
    if (selected) put(input, L"messageId", text(message, L"id"));
    if (mock) {
        if (name == L"followup" || name == L"schedule") {
            auto date = p->date.get(); auto time = p->time.get(); require(date && time, L"Choose a future local time."); put(input, L"when", recordedTime(date, time));
        }
    } else {
        put(input, L"prompt", trim(text(value, L"prompt")));
        if (usesDraft(p)) put(input, L"draftText", text(value, L"draftText"));
        if (name == L"skill") put(input, L"skillId", text(value, L"skillId"));
        if (name == L"reply") truth(input, L"includeHistory", flag(value, L"includeHistory"));
        auto policy = object(object(p->state, L"settings"), L"policy"), model = object(object(p->state, L"settings"), L"ai");
        auto detail = p->owner + L"\n" + text(feature, L"label") + L"\nModel: " + text(model, L"model") + L"\nEndpoint: " + text(model, L"baseUrl") +
            L"\nAllowed folders: " + selectedFlags(object(policy, L"folders")) + L"\nAllowed fields: " + selectedFlags(object(policy, L"content")) + L"\nContext cap: " + count(policy, L"maxMessages") + L" downloaded messages." +
            (name == L"reply" && flag(value, L"includeHistory") ? L"\nIncludes permitted same-correspondent downloaded history within that cap, not all mail." : L"") +
            (usesDraft(p) ? L"\nUses the draft text entered here." : selected ? L"\nUses the selected message shown below." : L"") +
            L"\nProvider charges may apply. Email contents are untrusted; review facts and commitments. This generates text only, never sends mail.";
        if (!(co_await p->shell->confirm(L"Generate response — uses AI?", detail, L"Generate")) || !p->current()) co_return;
        validateContext(p, context);
    }
    p->clearResult(); Json proof;
    if (selected && !mock) {
        auto full = co_await p->shell->service->request(L"/messages/" + escaped(text(message, L"id")), p->owner);
        if (!p->current()) co_return; validateContext(p, context); auto source = object(full, L"message");
        require(text(source, L"accountId") == p->owner && text(source, L"id") == text(message, L"id"), L"The selected message owner changed.");
        proof = sourceProof(source, object(object(p->state, L"settings"), L"policy"));
    }
    auto result = co_await p->shell->service->request(mock ? L"/workflows/preview" : L"/ai", p->owner, L"POST", input);
    if (!p->current()) co_return; validateContext(p, context);
    if (mock) {
        require(flag(result, L"simulated"), L"The service did not identify this preview as a local simulation.");
        p->workflow = object(result, L"preview"); p->workflowContext = context;
        require(!text(p->workflow, L"id").empty() && text(p->workflow, L"action") == name, L"The workflow preview does not match this request.");
    } else { p->output = clone(result); p->outputAction = name; p->outputMessage = clone(message); p->outputSource = proof; p->outputContext = context; }
    renderToolResult(p); p->tell(mock ? L"Local preview ready. No provider or AI call was made. Review every proposed change before applying." : L"Response ready. Review it before using it in a draft.");
}
IAsyncAction useToolDraft(Page p) {
    auto context = p->outputContext, name = p->outputAction;
    auto output = clone(p->output), message = clone(p->outputMessage), proof = clone(p->outputSource);
    require(!text(output, L"text").empty() && (name == L"reply" || name == L"write" || name == L"rewrite" || name == L"translate"), L"No draftable result is available.");
    validateContext(p, context);
    auto state = co_await p->shell->service->request(L"/state", p->owner);
    if (!p->current()) co_return; acceptState(p, state); validateContext(p, context);
    if (proof.Size()) {
        auto latest = co_await p->shell->service->request(L"/messages/" + escaped(text(message, L"id")), p->owner);
        if (!p->current()) co_return; validateContext(p, context);
        require(sourceProof(object(latest, L"message"), object(object(p->state, L"settings"), L"policy")).Stringify() == proof.Stringify(), L"The source message changed. Generate a fresh response before drafting.");
    }
    Json draft;
    if (name == L"reply") {
        Json input; put(input, L"mode", L"reply"); put(input, L"messageId", text(message, L"id")); put(input, L"body", text(output, L"text"));
        auto prepared = co_await p->shell->service->request(L"/drafts/prepare", p->owner, L"POST", input);
        if (!p->current()) co_return; validateContext(p, context); draft = object(prepared, L"draft");
        require(text(draft, L"accountId") == p->owner && text(draft, L"replyToId") == text(message, L"id") && text(draft, L"body") == text(output, L"text") && text(draft, L"bcc").empty(), L"Prepared reply did not match the reviewed output.");
    } else {
        put(draft, L"accountId", p->owner); for (auto key : {L"to", L"cc", L"bcc", L"subject"}) put(draft, key, L""); put(draft, L"body", text(output, L"text"));
    }
    p->forms[L"tool"].accept(p->forms[L"tool"].value); p->shell->dirty.erase(p->key()); auto shell = p->shell; p->stop(); co_await compose(shell, draft);
}
void renderToolResult(Page const& p) {
    auto panel = p->resultPanel.get(); if (!panel) return; panel.Children().Clear();
    if (p->workflow.Size()) {
        auto preview = clone(p->workflow); words(panel, text(preview, L"title"), 22); words(panel, L"Local simulation — review before applying");
        words(panel, text(preview, L"summary"));
        for (auto const& entry : array(preview, L"items")) { auto item = entry.GetObject(); words(panel, text(item, L"title"), 16); words(panel, text(item, L"detail")); }
        words(panel, L"This one-use preview expires after 10 minutes and on relevant source or permission changes. Only the local changes shown above will be applied.");
        action(p, panel, L"Apply reviewed local simulation…", [id = text(preview, L"id")](Page page) -> IAsyncAction {
            auto context = page->workflowContext; validateContext(page, context);
            require(text(page->workflow, L"id") == id, L"This preview was replaced. Review the current one.");
            if (!(co_await page->shell->confirm(L"Apply this local simulation?", page->owner + L"\n" + text(page->workflow, L"title") + L"\n" + text(page->workflow, L"summary") + L"\nApply only the changes reviewed on the page. Nothing is sent to a provider.", L"Apply local changes")) || !page->current()) co_return;
            validateContext(page, context); Json input; put(input, L"previewId", id);
            auto result = co_await page->shell->service->request(L"/workflows/apply", page->owner, L"POST", input);
            if (!page->current()) co_return; require(flag(result, L"simulated"), L"The applied result was not identified as a simulation.");
            acceptState(page, result); page->clearResult(); page->forms[L"tool"].accept(page->forms[L"tool"].value); page->dirty();
            co_await loadMessages(page); if (page->current()) page->tell(L"Reviewed simulation applied locally. See local records, Brain or Drafts for its results. No mail was sent.");
        });
    } else if (p->output.Size()) {
        words(panel, text(p->output, L"source") == L"demo" ? L"Illustrative demo — not a model analysis" : L"AI response — review required", 22);
        words(panel, text(p->output, L"text"));
        auto history = object(p->output, L"history"); if (history.Size()) words(panel, coverage(history));
        if (p->outputAction == L"reply" || p->outputAction == L"write" || p->outputAction == L"rewrite" || p->outputAction == L"translate") action(p, panel, L"Review in a draft", useToolDraft);
    }
    if (p->workflow.Size() || p->output.Size()) action(p, panel, L"Dismiss result", [](Page page) -> IAsyncAction { page->clearResult(); page->tell(L"Result dismissed. No automatic apply or send occurred."); co_return; });
}
IAsyncAction loadMessages(Page p) {
    auto cursor = p->cursors.back(); Json input;
    put(input, L"folder", L""); put(input, L"category", L"all"); truth(input, L"unreadOnly", false);
    put(input, L"sort", L"newest"); put(input, L"cursor", cursor); input.Insert(L"pageSize", Value::CreateNumberValue(50)); put(input, L"locale", L"en");
    auto result = co_await p->shell->service->request(L"/mail/page", p->owner, L"POST", input);
    if (!p->current()) co_return;
    auto policy = object(object(p->state, L"settings"), L"policy"), folders = object(policy, L"folders"); std::vector<Json> messages;
    require(array(result, L"messages").Size() <= 50, L"The mail page exceeded its limit.");
    for (auto const& entry : array(result, L"messages")) {
        auto message = entry.GetObject(); require(text(message, L"accountId") == p->owner, L"The mail page contains a different owner.");
        if (flag(folders, text(message, L"folder").c_str())) messages.push_back(message);
    }
    p->messages = std::move(messages); p->nextCursor = text(result, L"nextCursor");
    auto id = text(p->forms[L"tool"].value, L"messageId"); bool retained = false;
    for (auto const& message : p->messages) if (text(message, L"id") == id) retained = true;
    if (!retained) { put(p->forms[L"tool"].value, L"messageId", p->messages.empty() ? hstring() : text(p->messages.front(), L"id")); p->clearResult(); }
    renderTool(p);
}
void renderTool(Page const& p) {
    auto panel = p->toolPanel.get(); if (!panel) return; panel.Children().Clear();
    auto feature = selectedFeature(p), value = p->forms[L"tool"].value; auto name = text(feature, L"id");
    words(panel, text(feature, L"description"));
    words(panel, flag(feature, L"mock") ? simulationNote(name) : hstring(L"Calls your configured chat model only after confirmation. Every response needs human review."));
    auto policy = object(object(p->state, L"settings"), L"policy"), content = object(policy, L"content");
    Expander scope; scope.Header(box_value(L"Mail and permissions used")); auto scopeDetails = stack(6); scope.Content(scopeDetails); panel.Children().Append(scope);
    words(scopeDetails, L"Saved scope: " + selectedFlags(object(policy, L"folders")) + L"\nSaved fields: " + selectedFlags(content) + L"\nContext cap: " + count(policy, L"maxMessages") + L" downloaded messages. The server rechecks permissions and ownership.");
    if (text(feature, L"context") == L"selected") {
        if (name == L"translate") editChoice(p, panel, L"tool", L"translateSource", L"Translate source", {{L"message", L"Selected message"}, {L"draft", L"Draft text entered below"}});
        ComboBox picker; picker.Header(box_value(L"Message from permitted folders")); picker.HorizontalAlignment(xaml::HorizontalAlignment::Stretch);
        auto selectedId = text(value, L"messageId");
        for (auto const& message : p->messages) {
            auto title = (flag(content, L"subject") ? text(message, L"subject", L"No subject") : hstring(L"Subject withheld")) +
                (flag(content, L"sender") ? L" · " + text(message, L"fromName", text(message, L"fromEmail")) : hstring()) + L" · " + text(message, L"date");
            ComboBoxItem item; item.Content(box_value(title)); item.Tag(box_value(text(message, L"id"))); picker.Items().Append(item);
            if (text(message, L"id") == selectedId) picker.SelectedItem(item);
        }
        std::weak_ptr<Intelligence> weak = p;
        picker.SelectionChanged([weak](auto const& sender, auto const&) { if (auto page = weak.lock(); page && page->current() && !page->busy) {
            auto item = sender.template as<ComboBox>().SelectedItem().template try_as<ComboBoxItem>();
            if (item) { put(page->forms[L"tool"].value, L"messageId", unbox_value<hstring>(item.Tag())); page->changed(L"tool"); }
        } }); panel.Children().Append(picker); p->messagePicker = make_weak(picker);
        words(panel, L"Page " + to_hstring(p->cursors.size()) + L" · " + to_hstring(p->messages.size()) + L" permitted rows on this bounded page. Pages with no permitted rows can still have a next page.");
        auto previous = action(p, panel, L"Previous mail page", [](Page page) -> IAsyncAction {
            if (page->cursors.size() <= 1) co_return; auto old = page->cursors; page->cursors.pop_back();
            try { co_await loadMessages(page); } catch (...) { page->cursors = std::move(old); throw; }
        }); previous.IsEnabled(p->cursors.size() > 1);
        auto next = action(p, panel, L"Next mail page", [](Page page) -> IAsyncAction {
            if (page->nextCursor.empty()) co_return; auto old = page->cursors; page->cursors.push_back(page->nextCursor);
            try { co_await loadMessages(page); } catch (...) { page->cursors = std::move(old); throw; }
        }); next.IsEnabled(!p->nextCursor.empty());
    }
    if (name == L"rewrite" || name == L"translate") editText(p, panel, L"tool", L"draftText", L"Draft text (translation uses this only when Draft text is selected)", 100000, true);
    if (name == L"reply") editCheck(p, panel, L"tool", L"includeHistory", L"Suggest with History — include bounded permitted downloaded correspondence with this sender");
    if (name == L"skill") {
        ComboBox picker; picker.Header(box_value(L"Saved skill")); picker.HorizontalAlignment(xaml::HorizontalAlignment::Stretch);
        auto chosen = text(value, L"skillId");
        for (auto const& entry : array(object(p->state, L"workspace"), L"skills")) {
            auto skill = entry.GetObject(); ComboBoxItem item; item.Content(box_value(text(skill, L"name") + (flag(skill, L"enabled") ? L"" : L" — disabled"))); item.Tag(box_value(text(skill, L"id"))); item.IsEnabled(flag(skill, L"enabled")); picker.Items().Append(item);
            if (text(skill, L"id") == chosen) picker.SelectedItem(item);
        }
        std::weak_ptr<Intelligence> weak = p;
        picker.SelectionChanged([weak](auto const& sender, auto const&) { if (auto page = weak.lock(); page && page->current() && !page->busy) {
            auto item = sender.template as<ComboBox>().SelectedItem().template try_as<ComboBoxItem>();
            if (item) { put(page->forms[L"tool"].value, L"skillId", unbox_value<hstring>(item.Tag())); page->changed(L"tool"); }
        } }); panel.Children().Append(picker); p->skillPicker = make_weak(picker);
    }
    if (!flag(feature, L"mock")) {
        if (name == L"ask" || name == L"write") {
            editText(p, panel, L"tool", L"prompt", name == L"ask" ? L"What would you like to know about your mail?" : L"What would you like to say?", 2000, true);
            if (name == L"ask") words(panel, L"Include a person, project or topic to find relevant downloaded mail.", 12);
        } else {
            Expander extra; extra.Header(box_value(L"Additional instructions (optional)")); auto fields = stack(8);
            editText(p, fields, L"tool", L"prompt", L"Instructions", 2000, true); extra.Content(fields); panel.Children().Append(extra);
        }
    }
    if (name == L"followup" || name == L"schedule") {
        DatePicker date; date.Header(box_value(L"Date for local record")); date.Date(winrt::clock::now() + std::chrono::hours(24));
        TimePicker time; time.Header(box_value(L"Time on this device")); time.Time(std::chrono::hours(9));
        std::weak_ptr<Intelligence> weak = p;
        date.DateChanged([weak](auto const&, auto const&) { if (auto page = weak.lock(); page && page->current()) { page->clearResult(); ++page->revision; } });
        time.TimeChanged([weak](auto const&, auto const&) { if (auto page = weak.lock(); page && page->current()) { page->clearResult(); ++page->revision; } });
        panel.Children().Append(date); panel.Children().Append(time); p->date = make_weak(date); p->time = make_weak(time);
        words(panel, L"Uses this device’s local time zone and verifies daylight-saving gaps. This is a local record, not a scheduled notification or real event.");
    }
    action(p, panel, flag(feature, L"mock") ? L"Create local preview — no AI call" : L"Generate response — review model request…", runTool);
    action(p, panel, L"Discard tool inputs and result…", [](Page page) -> IAsyncAction {
        if (!(co_await page->shell->confirm(L"Discard tool inputs?", L"Clear entered instructions, draft text and the unsaved result. Saved messages remain.", L"Discard inputs")) || !page->current()) co_return;
        auto& form = page->forms[L"tool"]; put(form.value, L"prompt", L""); put(form.value, L"draftText", L""); form.accept(form.value); page->clearResult(); page->dirty(); renderTool(page);
    });
}
void buildTools(Page const& p, StackPanel const& body) {
    words(body, p->kind == L"simulations" ? L"Local simulations" : L"Assistant", 24); words(body, L"Choose a task, then review the result.");
    Json value; put(value, L"action", p->kind == L"simulations" ? L"triage" : L"ask"); put(value, L"prompt", L""); put(value, L"draftText", L""); put(value, L"messageId", L""); put(value, L"skillId", L""); put(value, L"translateSource", L"message"); truth(value, L"includeHistory", false);
    if (text(p->shell->selected, L"accountId") == p->owner) put(value, L"messageId", text(p->shell->selected, L"id"));
    for (auto const& entry : array(object(p->state, L"workspace"), L"skills")) if (flag(entry.GetObject(), L"enabled")) { put(value, L"skillId", text(entry.GetObject(), L"id")); break; }
    editor(p, L"tool", value);
    ComboBox picker; picker.Header(box_value(L"What would you like to do?")); picker.HorizontalAlignment(xaml::HorizontalAlignment::Stretch);
    for (auto const& entry : array(p->state, L"features")) {
        auto feature = entry.GetObject();
        if (text(feature, L"id") == L"memory" || flag(feature, L"mock") != (p->kind == L"simulations")) continue;
        p->features.push_back(feature); ComboBoxItem item;
        item.Content(box_value(text(feature, L"label"))); item.Tag(box_value(text(feature, L"id"))); picker.Items().Append(item);
        if (text(feature, L"id") == text(value, L"action")) picker.SelectedItem(item);
    }
    std::weak_ptr<Intelligence> weak = p;
    picker.SelectionChanged([weak](auto const& sender, auto const&) { if (auto page = weak.lock(); page && page->current() && !page->busy) {
        auto item = sender.template as<ComboBox>().SelectedItem().template try_as<ComboBoxItem>();
        if (item) { put(page->forms[L"tool"].value, L"action", unbox_value<hstring>(item.Tag())); page->changed(L"tool"); renderTool(page); }
    } }); body.Children().Append(picker); p->featurePicker = make_weak(picker);
    auto tool = stack(12), result = stack(12); body.Children().Append(tool); body.Children().Append(result); p->toolPanel = make_weak(tool); p->resultPanel = make_weak(result);
    renderTool(p);
}

fire_and_forget refreshIntelligence(Page p) {
    if (!p->current() || p->busy || p->cancelling || p->polling) co_return;
    p->polling = true; auto revision = p->revision;
    try {
        auto next = co_await p->shell->service->request(L"/state", p->owner);
        if (p->current() && !p->busy && !p->cancelling && p->revision == revision) {
            auto oldContext = p->context;
            acceptState(p, next);
            if (p->kind == L"learning") updateLearningForms(p);
            else if (p->kind == L"reply-suggestions") {
                auto suggestions = co_await p->shell->service->request(L"/reply-suggestions", p->owner);
                if (p->current() && !p->busy && !p->cancelling && p->revision == revision) acceptSuggestions(p, suggestions);
            } else if (p->kind == L"brain") {
                auto proposal = object(object(object(p->state,L"workspace"),L"brainLearning"),L"preview");
                if (text(proposal,L"id") != text(p->memoryPreview,L"id") && proposal.Size()) { p->selectedMemories.clear(); p->memoryPreview=proposal; renderMemoryPreview(p); }
            } else if ((p->kind == L"studio" || p->kind == L"simulations") && oldContext != p->context) {
                auto folders = object(object(object(p->state, L"settings"), L"policy"), L"folders");
                std::erase_if(p->messages, [&](Json const& message) { return !flag(folders, text(message, L"folder").c_str()); });
                renderTool(p); p->tell(L"Saved context changed. Previous results were cleared; review permissions and inputs before running again.");
            }
        }
    } catch (hresult_error const& error) {
        if (p->revision == revision && !p->busy) { p->clearResult(); p->tell(error.message()); }
    } catch (...) { if (p->revision == revision && !p->busy) { p->clearResult(); p->tell(L"Status could not refresh. Review current account status before continuing."); } }
    p->polling = false;
}
} // namespace

IAsyncAction intelligencePage(std::shared_ptr<Shell> shell, hstring kind) {
    if (kind == L"tools" || kind == L"ai") kind = L"studio";
    if (kind == L"replies") kind = L"reply-suggestions";
    if (kind == L"local-activity") kind = L"records";
    auto p = std::make_shared<Intelligence>(); p->shell = shell; p->owner = shell->owner; p->kind = kind; p->generation = ++shell->generation;
    shell->section = kind;
    auto root = stack(16); root.MaxWidth(1080); root.HorizontalAlignment(xaml::HorizontalAlignment::Left); root.Margin(xaml::Thickness{24, 20, 24, 32});
    words(root, L"AI Studio", 28); words(root, p->owner);
    if (!shell->connected(p->owner) || p->owner.empty() || p->owner == L"all" || p->owner == L"demo") {
        words(root, L"Choose an individual connected mailbox from the sidebar. AI context, identity, notes and suggestions are kept separate for each account.");
        shell->show(scroll(root)); co_return;
    }
    auto tabs = stack(6); tabs.Orientation(Orientation::Horizontal); std::weak_ptr<Intelligence> weak = p; bool known = false;
    for (auto const& [id, caption] : std::initializer_list<std::pair<wchar_t const*, wchar_t const*>>{
        {L"studio", L"Assistant"}, {L"summaries", L"Summaries"}, {L"brain", L"Email Brain"}}) {
        auto control = button(caption, [weak, target = hstring(id)] { if (auto page = weak.lock()) changePage(page, target); });
        if (kind == id) { known = true; control.IsEnabled(false); } tabs.Children().Append(control);
    }
    ComboBox more; more.PlaceholderText(L"More");
    xaml::Automation::AutomationProperties::SetName(more, L"More AI Studio pages");
    for (auto const& [id, caption] : std::initializer_list<std::pair<wchar_t const*, wchar_t const*>>{
        {L"learning", L"Writing style & identity"}, {L"reply-suggestions", L"Reply suggestions"}, {L"skills", L"Reusable skills"}, {L"simulations", L"Local simulations"}, {L"records", L"Simulation history"}}) {
        ComboBoxItem item; item.Content(box_value(caption)); item.Tag(box_value(hstring(id))); more.Items().Append(item);
        if (kind == id) { known = true; more.SelectedItem(item); }
    }
    more.SelectionChanged([weak](auto const& sender, auto const&) { if (auto page = weak.lock(); page && page->current()) {
        auto item = sender.template as<ComboBox>().SelectedItem().template try_as<ComboBoxItem>();
        if (item) changePage(page, unbox_value<hstring>(item.Tag()));
    } }); tabs.Children().Append(more);
    ScrollViewer tabScroll; tabScroll.HorizontalScrollBarVisibility(ScrollBarVisibility::Auto); tabScroll.VerticalScrollBarVisibility(ScrollBarVisibility::Disabled); tabScroll.Content(tabs); root.Children().Append(tabScroll);
    auto notice = label(L"Loading this account’s saved context…"); root.Children().Append(notice); p->notice = notice;
    xaml::Automation::AutomationProperties::SetLiveSetting(notice, xaml::Automation::Peers::AutomationLiveSetting::Polite);
    if (kind == L"learning") {
        auto cancel = button(L"Cancel current style analysis…", [weak] { if (auto page = weak.lock(); page && page->generatingStyle) revokeStyle(page); });
        cancel.IsEnabled(false); root.Children().Append(cancel); p->cancelStyle = make_weak(cancel);
    }
    ContentControl host; host.HorizontalContentAlignment(xaml::HorizontalAlignment::Stretch);
    auto body = stack(16); host.Content(body); root.Children().Append(host); p->body = make_weak(body); p->editorHost = make_weak(host);
    root.Unloaded([p](auto const&, auto const&) { p->stop(); p->notice = nullptr; }); shell->show(scroll(root));
    bool loaded = false;
    try {
        require(known, L"Unknown Intelligence page.");
        auto state = co_await shell->service->request(L"/state", p->owner);
        if (!p->current()) co_return; acceptState(p, state);
        if (kind == L"learning") buildLearning(p, body);
        else if (kind == L"brain") buildBrain(p, body);
        else if (kind == L"skills") buildSkills(p, body);
        else if (kind == L"reply-suggestions") {
            auto result = co_await shell->service->request(L"/reply-suggestions", p->owner);
            if (!p->current()) co_return; require(text(result, L"owner") == p->owner, L"Suggestion mailbox changed.");
            p->suggestions = result; buildSuggestions(p, body);
        } else if (kind == L"studio" || kind == L"simulations") {
            buildTools(p, body); co_await loadMessages(p); if (!p->current()) co_return;
            p->forms[L"tool"].accept(p->forms[L"tool"].value);
        } else {
            auto list = stack(12); body.Children().Append(list); p->recordList = make_weak(list); renderRecords(p);
        }
        loaded = true; p->tell(L"Ready. Opening this page has not started an AI or provider request."); p->dirty();
    } catch (hresult_error const& error) { p->tell(error.message()); }
    catch (...) { p->tell(L"This page could not load. Refresh to retry without starting AI."); }
    if (!p->current()) co_return;
    action(p, body, loaded ? L"Refresh saved context…" : L"Retry loading this page", [](Page page) -> IAsyncAction {
        if (page->edited() && !(co_await page->shell->confirm(L"Discard edits and refresh?", L"Saved data and background jobs remain. Unsaved fields, previews displayed here and output will be cleared.", L"Refresh"))) co_return;
        if (!page->current()) co_return;
        page->shell->dirty.erase(page->key()); auto shell = page->shell; auto kind = page->kind; page->stop(); co_await intelligencePage(shell, kind);
    });
    if (loaded && (kind == L"learning" || kind == L"reply-suggestions" || kind == L"studio" || kind == L"simulations" || kind == L"brain")) {
        p->timer = xaml::DispatcherTimer(); p->timer.Interval(std::chrono::seconds(3));
        p->timer.Tick([weak](auto const&, auto const&) { if (auto page = weak.lock()) refreshIntelligence(page); }); p->timer.Start();
    }
}
} // namespace morrow
