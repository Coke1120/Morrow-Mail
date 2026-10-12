#include "pch.h"
#include "Ui.h"
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Microsoft.UI.Xaml.Controls.Primitives.h>
#include <winrt/Microsoft.UI.Xaml.Input.h>
#include <winrt/Windows.System.h>
#include <algorithm>
#include <cmath>
#include <cwctype>
#include <map>

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
using namespace Windows::Data::Json;
using namespace Windows::System;
using namespace controls;
namespace {
Json copy(Json const& value) { return Json::Parse(value.Stringify()); }
void require(bool value, wchar_t const* message) { if (!value) throw hresult_error(E_FAIL,message); }
hstring ownerOf(Json const& proposal) { return text(proposal,L"accountId",text(object(proposal,L"message"),L"accountId")); }
hstring keyOf(Json const& proposal) { return ownerOf(proposal)+L"\n"+text(proposal,L"messageId"); }
hstring proposalId(Json const& proposal) { return text(proposal,L"proposalId",text(proposal,L"id")); }
bool checked(CheckBox const& value) { return value.IsChecked() && value.IsChecked().Value(); }
bool needsDecision(Json const& draft) { auto body=std::wstring(text(draft,L"body")); std::transform(body.begin(),body.end(),body.begin(),[](wchar_t c){return static_cast<wchar_t>(std::towlower(c));}); return body.find(L"[decision needed")!=std::wstring::npos; }
void words(StackPanel const& panel,hstring const& value,double size=14) { panel.Children().Append(label(value,size)); }
struct Page : std::enable_shared_from_this<Page> {
    std::shared_ptr<Shell> shell;
    hstring kind,scope,selectedKey,queuePaint,originalOwner,originalId;
    uint64_t generation=0, selection=0;
    bool live=true,busy=false,polling=false,compact=false;
    Grid columns{nullptr}; StackPanel queue{nullptr},editor{nullptr},actions{nullptr};
    ScrollViewer listScroll{nullptr}; Grid detail{nullptr}; ContentControl detailHost{nullptr};
    ContentControl optionsHost{nullptr}; hstring optionsPaint;
    TextBlock notice{nullptr},detailNotice{nullptr}; TextBox body{nullptr}; CheckBox facts{nullptr}; Button send{nullptr},replace{nullptr};
    std::vector<Json> rows;
    bool current() const { return live && !shell->closing && shell->generation==generation && shell->section==kind && shell->review->scope==scope; }
    void say(hstring const& value) { if (current()) notice.Text(value); }
};
using P=std::shared_ptr<Page>;
IAsyncAction refresh(P page);
IAsyncAction selectReply(P page,Json proposal);
IAsyncAction selectOriginal(P page,Json metadata);
IAsyncAction replaceReply(P page);
IAsyncAction saveDraft(P page);
IAsyncAction reviewSend(P page);
IAsyncAction saveOptions(P page,Json model);
void paintQueue(P const& page);
void reflow(P const& page);
void owned(Json const& message,hstring const& owner,hstring const& id) { require(text(message,L"accountId")==owner && text(message,L"id")==id,L"The original message owner could not be verified."); }
bool validProposal(Json const& response,Json const& proposal) {
    if (text(response,L"owner")!=ownerOf(proposal)) return false;
    for (auto const& value:array(response,L"proposals")) {
        auto item=value.GetObject();
        if (proposalId(item)==proposalId(proposal) && text(item,L"messageId")==text(proposal,L"messageId") && text(item,L"text")==text(proposal,L"text") && text(object(item,L"message"),L"accountId")==ownerOf(proposal)) return true;
    }
    return false;
}
void reflow(P const& p) {
    if (!p->current()) return;
    auto width=p->columns.ActualWidth(); p->compact=width>0 && width<780;
    if(p->actions) p->actions.Orientation(p->compact ? Orientation::Vertical:Orientation::Horizontal);
    p->columns.ColumnDefinitions().Clear();
    bool detail=p->shell->review->details[std::wstring(p->scope)];
    if (p->compact) {
        ColumnDefinition column; column.Width(GridLengthHelper::FromValueAndType(1,GridUnitType::Star)); p->columns.ColumnDefinitions().Append(column);
        Grid::SetColumn(p->listScroll,0); Grid::SetColumn(p->detail,0);
        p->listScroll.Visibility(detail ? xaml::Visibility::Collapsed:xaml::Visibility::Visible);
        p->detail.Visibility(detail ? xaml::Visibility::Visible:xaml::Visibility::Collapsed);
    } else {
        ColumnDefinition list; list.Width(GridLengthHelper::FromPixels(p->kind==L"today" ? std::max(350.0,width*0.55):280));
        ColumnDefinition detailColumn; detailColumn.Width(GridLengthHelper::FromValueAndType(1,GridUnitType::Star));
        p->columns.ColumnDefinitions().Append(list); p->columns.ColumnDefinitions().Append(detailColumn);
        Grid::SetColumn(p->listScroll,0); Grid::SetColumn(p->detail,1);
        p->listScroll.Visibility(xaml::Visibility::Visible);
        p->detail.Visibility(detail || p->kind==L"reply-suggestions" ? xaml::Visibility::Visible:xaml::Visibility::Collapsed);
        if (!detail && p->kind==L"today") { p->columns.ColumnDefinitions().Clear(); ColumnDefinition full; full.Width(GridLengthHelper::FromValueAndType(1,GridUnitType::Star)); p->columns.ColumnDefinitions().Append(full); }
    }
}
ScrollViewer rememberScroll(P const& p,xaml::UIElement const& child,hstring const& key) {
    auto view=scroll(child); auto memory=p->shell->review;
    view.Loaded([weak=std::weak_ptr<Page>(p),key](auto const& sender,auto const&) {
        if(auto page=weak.lock();page && page->current()) { auto target=sender.template as<ScrollViewer>(); target.ChangeView(nullptr,page->shell->review->scrolls[std::wstring(key)],nullptr,true); }
    });
    view.ViewChanged([memory,key](auto const& sender,auto const&) { memory->scrolls[std::wstring(key)]=sender.template as<ScrollViewer>().VerticalOffset(); });
    return view;
}
void mountOriginal(P const& p,StackPanel const& panel,Json const& message) {
    words(panel,L"Original message",18); words(panel,text(message,L"subject"),16);
    words(panel,text(message,L"fromName")+L" <"+text(message,L"fromEmail")+L"> · "+mailDateLabel(text(message,L"date")),12);
    auto owner=text(message,L"accountId"),id=text(message,L"id"); p->originalOwner=owner; p->originalId=id;
    appendReader(p->shell,panel,message,240,[weak=std::weak_ptr<Page>(p),owner,id] {
        auto page=weak.lock(); return page && page->current() && page->originalOwner==owner && page->originalId==id && page->shell->connected(owner);
    });
    appendAttachmentControls(p->shell,panel,message);
}
void paintEditor(P const& p,hstring const& key) {
    if (!p->current() || p->selectedKey!=key) return;
    auto& entry=p->shell->review->entries[std::wstring(key)];
    auto owner=ownerOf(entry.proposal);
    auto content=stack(14); content.Margin(xaml::Thickness{18,10,18,14});
    words(content,L"From: "+owner,12);
    if (entry.message.Size()) mountOriginal(p,content,entry.message);
    if (!entry.draft.Size()) { words(content,L"Loading the account-owned reply…"); p->detailHost.Content(rememberScroll(p,content,L"reply-detail:"+key)); return; }
    words(content,L"Suggested reply",18); words(content,L"To: "+text(entry.draft,L"to"),12);
    for (auto const& question:array(entry.proposal,L"questions")) words(content,L"Needs your answer: "+question.GetString());
    auto body=field(L"Edit suggested reply",text(entry.draft,L"body"),true); body.MinHeight(190); body.MaxHeight(260); body.MaxLength(100000); p->body=body;
    body.IsEnabled(!p->shell->review->writing);
    body.TextChanged([weak=std::weak_ptr<Page>(p),key](auto const& sender,auto const&) {
        if(auto page=weak.lock();page && page->current() && !page->shell->review->writing && page->selectedKey==key) {
            auto& current=page->shell->review->entries[std::wstring(key)]; put(current.draft,L"body",sender.template as<TextBox>().Text()); current.reviewed=false;
            if(page->facts) page->facts.IsChecked(false); if(page->send) page->send.IsEnabled(false);
        }
    }); content.Children().Append(body);
    CheckBox facts; facts.Content(box_value(L"I checked the facts, missing answers and commitments")); facts.IsChecked(entry.reviewed); facts.IsEnabled(!entry.stale); p->facts=facts;
    auto updateFacts=[weak=std::weak_ptr<Page>(p),key](auto const& sender,auto const&) {
        if(auto page=weak.lock();page && page->current() && page->selectedKey==key) {
            auto& current=page->shell->review->entries[std::wstring(key)]; current.reviewed=checked(sender.template as<CheckBox>());
            if(page->send) page->send.IsEnabled(current.reviewed && !current.stale && !page->shell->review->writing && !needsDecision(current.draft));
        }
    }; facts.Checked(updateFacts); facts.Unchecked(updateFacts); content.Children().Append(facts);
    Expander evidence; evidence.Header(box_value(L"Evidence and permitted reference messages")); auto quotes=stack(8);
    for (auto const& value:array(entry.proposal,L"evidence")) words(quotes,text(value.GetObject(),L"quote"));
    for (auto const& value:array(entry.proposal,L"sourceMessages")) {
        auto source=value.GetObject(); words(quotes,text(source,L"subject")+L" · "+mailDateLabel(text(source,L"date")),12);
        quotes.Children().Append(button(L"View reference message",[weak=std::weak_ptr<Page>(p),source]{ if(auto page=weak.lock();page && page->current()) selectOriginal(page,source); }));
    }
    words(quotes,flag(entry.proposal,L"approvedStyleUsed") ? L"Approved writing style used. Style is not evidence of facts.":L"No approved writing style applied.",12);
    evidence.Content(quotes); content.Children().Append(evidence);
    auto warning=label(entry.stale ? L"Sources changed. Your draft is retained; review a fresh suggestion before sending.":L"Edits stay with this mailbox. Sending still requires the normal recipient and delivery confirmation.",12); p->detailNotice=warning; content.Children().Append(warning);
    auto replace=button(L"Load latest suggestion…",[weak=std::weak_ptr<Page>(p)]{ if(auto page=weak.lock();page && page->current()) replaceReply(page); }); p->replace=replace; replace.Visibility(entry.stale ? xaml::Visibility::Visible:xaml::Visibility::Collapsed); content.Children().Append(replace);
    p->detailHost.Content(rememberScroll(p,content,L"reply-detail:"+key));
    auto buttons=stack(8); p->actions=buttons; buttons.Orientation(p->compact ? Orientation::Vertical:Orientation::Horizontal); buttons.Margin(ThicknessHelper::FromUniformLength(12));
    buttons.Children().Append(button(L"Back to suggestions",[weak=std::weak_ptr<Page>(p)]{ if(auto page=weak.lock();page && page->current()){ page->shell->review->details[std::wstring(page->scope)]=false; reflow(page); page->listScroll.Focus(xaml::FocusState::Programmatic); } }));
    buttons.Children().Append(button(L"Save draft",[weak=std::weak_ptr<Page>(p)]{ if(auto page=weak.lock();page && page->current()) saveDraft(page); }));
    auto send=button(L"Review sending…",[weak=std::weak_ptr<Page>(p)]{ if(auto page=weak.lock();page && page->current()) reviewSend(page); }); p->send=send;
    send.IsEnabled(entry.reviewed && !entry.stale && !p->shell->review->writing && !needsDecision(entry.draft));
    buttons.Children().Append(send); Grid::SetRow(buttons,1);
    while(p->detail.Children().Size()>1) p->detail.Children().RemoveAtEnd(); p->detail.Children().Append(buttons);
}
IAsyncAction selectReply(P p,Json proposal) {
    auto owner=ownerOf(proposal),key=keyOf(proposal),id=text(proposal,L"messageId");
    if(!p->current() || p->busy || !p->shell->connected(owner) || id.empty()) co_return;
    p->selectedKey=key; p->shell->review->selections[std::wstring(p->scope)]=key; p->shell->review->details[std::wstring(p->scope)]=true;
    ++p->shell->selectionGeneration; p->shell->readerImageOverride.reset(); auto sequence=++p->selection;
    auto& entry=p->shell->review->entries[std::wstring(key)];
    if(entry.draft.Size()) { if(proposalId(entry.proposal)!=proposalId(proposal) || text(entry.proposal,L"text")!=text(proposal,L"text")){entry.stale=true;entry.reviewed=false;} paintEditor(p,key); reflow(p); co_return; }
    entry.proposal=copy(proposal); paintEditor(p,key); reflow(p); p->say(L"Loading the original message and saved suggestion…");
    try {
        auto response=co_await p->shell->service->request(L"/messages/"+escaped(id),owner);
        if(!p->current() || sequence!=p->selection) co_return;
        auto message=object(response,L"message"); owned(message,owner,id); entry.message=copy(message);
        Json input; put(input,L"messageId",id); put(input,L"mode",L"reply"); put(input,L"body",text(proposal,L"text"));
        auto result=co_await p->shell->service->request(L"/drafts/prepare",owner,L"POST",input);
        if(!p->current() || sequence!=p->selection) co_return;
        auto draft=object(result,L"draft"); require(text(draft,L"accountId")==owner && text(draft,L"replyToId")==id && text(draft,L"body")==text(proposal,L"text") && text(draft,L"bcc").empty(),L"The prepared reply could not be verified for this mailbox.");
        auto latest=co_await p->shell->service->request(L"/reply-suggestions",owner);
        if(!p->current() || sequence!=p->selection) co_return;
        require(validProposal(latest,proposal),L"The suggestion or sources changed. Review a fresh suggestion.");
        draft.Insert(L"footer",object(object(p->shell->state,L"settings"),L"footer")); entry.draft=copy(draft); entry.saved=copy(draft); entry.stale=false;
        paintEditor(p,key); p->say(L"Ready to edit. No mail has been sent.");
    } catch(hresult_error const& error) { if(p->current()){ p->say(error.message()); entry.stale=true; auto retry=button(L"Reload original and suggestion",[weak=std::weak_ptr<Page>(p),proposal]{ if(auto page=weak.lock();page && page->current()) selectReply(page,proposal); }); p->queue.Children().Append(retry); } }
}
IAsyncAction replaceReply(P p) {
    if(!p->current() || p->busy || p->shell->review->writing || p->selectedKey.empty()) co_return;
    auto key=p->selectedKey; auto& entry=p->shell->review->entries[std::wstring(key)];
    auto owner=ownerOf(entry.proposal),id=text(entry.proposal,L"messageId");
    if(!p->shell->connected(owner)) co_return;
    p->busy=true;
    try {
        auto response=co_await p->shell->service->request(L"/reply-suggestions",owner);
        if(!p->current() || p->selectedKey!=key){p->busy=false;co_return;}
        require(text(response,L"owner")==owner,L"The suggestion mailbox changed.");
        Json next; bool found=false;
        for(auto const& value:array(response,L"proposals")){ auto row=value.GetObject(); if(text(row,L"messageId")==id && ownerOf(row)==owner && text(object(row,L"message"),L"accountId")==owner){ next=copy(row);found=true;break; } }
        require(found,L"There is no current suggestion for this message. Your local draft remains available to save.");
        bool accepted=co_await p->shell->confirm(L"Replace the retained draft?",L"Load the latest original message and suggestion for "+owner+L". This replaces the reply text in this review workspace; any previously saved mailbox draft is preserved.",L"Replace with latest suggestion");
        if(!accepted || !p->current() || p->selectedKey!=key){p->busy=false;co_return;}
        entry=ReviewEntry{}; p->busy=false; co_await selectReply(p,next);
    } catch(hresult_error const& error){p->say(error.message());}
    p->busy=false;
}
IAsyncAction selectOriginal(P p,Json metadata) {
    auto owner=text(metadata,L"accountId"),id=text(metadata,L"id");
    if(!p->current() || !p->shell->connected(owner) || id.empty()) co_return;
    auto sequence=++p->selection; ++p->shell->selectionGeneration; p->shell->readerImageOverride.reset();
    p->shell->review->originals[std::wstring(p->scope)]=copy(metadata); p->shell->review->details[std::wstring(p->scope)]=true;
    while(p->detail.Children().Size()>1) p->detail.Children().RemoveAtEnd(); p->actions=nullptr;
    auto panel=stack(12); words(panel,L"Loading original message…"); p->detailHost.Content(scroll(panel)); reflow(p);
    try {
        auto result=co_await p->shell->service->request(L"/messages/"+escaped(id),owner);
        if(!p->current() || sequence!=p->selection) co_return;
        auto message=object(result,L"message"); owned(message,owner,id); panel.Children().Clear();
        words(panel,owner,12); mountOriginal(p,panel,message);
        panel.Children().Append(button(p->kind==L"reply-suggestions" ? L"Back to reply":L"Close original",[weak=std::weak_ptr<Page>(p)] { if(auto page=weak.lock();page && page->current()) {
            if(page->kind==L"reply-suggestions" && !page->selectedKey.empty()){ auto entry=page->shell->review->entries.find(std::wstring(page->selectedKey)); if(entry!=page->shell->review->entries.end()){ selectReply(page,entry->second.proposal); return; } }
            page->shell->review->details[std::wstring(page->scope)]=false; reflow(page);
        } }));
        panel.Children().Append(button(L"Open in mailbox…",[weak=p->shell->weak_from_this(),metadata]{ if(auto shell=weak.lock()) shell->openSource(metadata); }));
    } catch(hresult_error const& error) { if(p->current()){ panel.Children().Clear(); words(panel,error.message()); panel.Children().Append(button(L"Reload original",[weak=std::weak_ptr<Page>(p),metadata]{ if(auto page=weak.lock();page && page->current()) selectOriginal(page,metadata); })); } }
}
struct WriteGuard {
    std::shared_ptr<Shell> shell;
    explicit WriteGuard(P const& p):shell(p->shell) { shell->review->writing=true; shell->navigation.IsEnabled(false); }
    ~WriteGuard(){ shell->review->writing=false; if(!shell->closing) shell->navigation.IsEnabled(true); }
};
IAsyncAction saveDraft(P p) {
    if(!p->current() || p->busy || p->shell->review->writing || p->selectedKey.empty()) co_return;
    auto key=p->selectedKey; auto& entry=p->shell->review->entries[std::wstring(key)]; auto owner=text(entry.draft,L"accountId");
    if(!entry.draft.Size() || !p->shell->connected(owner)) co_return;
    WriteGuard guard(p); auto draft=copy(entry.draft); auto payload=copy(draft); payload.Remove(L"accountId");
    try {
        auto result=co_await p->shell->service->request(L"/drafts",owner,L"POST",payload);
        auto message=object(result,L"message"); require(text(message,L"accountId")==owner && text(message,L"replyToId")==text(draft,L"replyToId") && !text(message,L"id").empty(),L"The saved draft owner could not be verified.");
        put(draft,L"id",text(message,L"id")); entry.draft=copy(draft); entry.saved=copy(draft);
        p->say(L"Draft saved in its original mailbox.");
    } catch(hresult_error const& error){ p->say(error.message()); }
}
IAsyncAction reviewSend(P p) {
    if(!p->current() || p->busy || p->shell->review->writing || p->selectedKey.empty()) co_return;
    auto key=p->selectedKey; auto& entry=p->shell->review->entries[std::wstring(key)];
    if(!entry.reviewed || entry.stale || needsDecision(entry.draft)) co_return;
    auto owner=ownerOf(entry.proposal); auto draft=copy(entry.draft); p->busy=true;
    try {
        auto latest=co_await p->shell->service->request(L"/reply-suggestions",owner);
        if(!p->current()) { p->busy=false; co_return; }
        require(validProposal(latest,entry.proposal),L"This suggestion changed. Keep your edits and review fresh evidence.");
        require(text(draft,L"accountId")==owner && text(draft,L"replyToId")==text(entry.proposal,L"messageId"),L"The reply mailbox changed.");
        p->busy=false;
        co_await compose(p->shell,draft); // Existing reviewed delivery, scheduling and uncertain-send controls.
    } catch(hresult_error const& error){ entry.stale=true; entry.reviewed=false; p->say(error.message()); if(p->send) p->send.IsEnabled(false); }
    p->busy=false;
}
IAsyncAction saveOptions(P p,Json model) {
    if(!p->current() || p->scope==L"all" || p->busy || p->shell->review->writing) co_return;
    auto memory=p->shell->review; auto owner=p->scope; auto next=copy(memory->options[std::wstring(owner)]);
    if(flag(next,L"automatic")) {
        bool accepted=co_await p->shell->confirm(L"Automatically check this mailbox for replies?",owner+L"\nModel: "+text(model,L"model")+L"\nEndpoint: "+text(model,L"baseUrl")+L"\nDaily estimated token budget: "+next.GetNamedValue(L"dailyTokenBudget").Stringify()+L" (UTC). Uses permitted Inbox and correspondence while Morrow is open. Provider charges may apply. Mail is never sent automatically.",L"Save automatic checks");
        if(!accepted || !p->current()) co_return;
    }
    WriteGuard guard(p);
    try {
        auto fresh=co_await p->shell->service->request(L"/reply-suggestions",owner);
        require(p->current() && text(fresh,L"owner")==owner && object(fresh,L"model").Stringify()==model.Stringify(),L"The model or mailbox changed. Review automatic checks again.");
        auto result=co_await p->shell->service->request(L"/reply-suggestions/settings",owner,L"POST",next);
        require(text(result,L"owner")==owner,L"The saved setting owner could not be verified.");
        memory->options[std::wstring(owner)]=copy(object(result,L"settings")); memory->savedOptions[std::wstring(owner)]=copy(object(result,L"settings")); memory->values[std::wstring(owner)]=copy(result);
        p->optionsPaint={}; p->say(L"Automatic-check settings saved for this mailbox.");
    } catch(hresult_error const& error){ p->say(error.message()); }
}
void paintOptions(P const& p,Json const& response) {
    auto memory=p->shell->review; auto owner=p->scope;
    if(owner==L"all") { p->optionsHost.Content(label(L"All accounts is read-only. Select one mailbox to change automatic checks or its budget.",12)); return; }
    auto settings=object(response,L"settings"); auto key=std::wstring(owner);
    if(!memory->options.contains(key) || (memory->savedOptions.contains(key) && memory->options[key].Stringify()==memory->savedOptions[key].Stringify())) { memory->options[key]=copy(settings); memory->savedOptions[key]=copy(settings); }
    auto signature=memory->options[key].Stringify(); if(p->optionsHost.Content() && signature==p->optionsPaint) return;
    if(p->optionsHost.Content() && !p->optionsPaint.empty() && memory->savedOptions.contains(key) && signature!=memory->savedOptions[key].Stringify()) return;
    p->optionsPaint=signature;
    Expander options; options.Header(box_value(L"Automatic checks & budget")); auto fields=stack(12); auto value=memory->options[key];
    CheckBox automatic; automatic.Content(box_value(L"Check new Inbox mail automatically")); automatic.IsChecked(flag(value,L"automatic"));
    auto changed=[weak=std::weak_ptr<Page>(p),key](auto const& sender,auto const&) { if(auto page=weak.lock();page && page->current() && !page->shell->review->writing){ auto enabled=checked(sender.template as<CheckBox>()); auto& next=page->shell->review->options[key]; next.Insert(L"automatic",Value::CreateBooleanValue(enabled)); if(enabled) next.Insert(L"enabled",Value::CreateBooleanValue(true)); } };
    automatic.Checked(changed); automatic.Unchecked(changed); fields.Children().Append(automatic);
    NumberBox budget; budget.Header(box_value(L"Daily estimated token budget (UTC)")); budget.Minimum(4000); budget.Maximum(2000000); budget.SmallChange(1000); budget.Value(value.GetNamedNumber(L"dailyTokenBudget",100000));
    budget.ValueChanged([weak=std::weak_ptr<Page>(p),key](auto const& sender,auto const&) { if(auto page=weak.lock();page && page->current() && !page->shell->review->writing){ auto amount=sender.template as<NumberBox>().Value(); if(std::isfinite(amount)) page->shell->review->options[key].Insert(L"dailyTokenBudget",Value::CreateNumberValue(amount)); } }); fields.Children().Append(budget);
    words(fields,L"Checks use at most the newest 200 downloaded Inbox messages and permitted correspondence. Provider billing may differ. No mail is sent automatically.",12);
    auto model=object(response,L"model"); fields.Children().Append(button(L"Save checks & budget…",[weak=std::weak_ptr<Page>(p),model]{ if(auto page=weak.lock();page && page->current()) saveOptions(page,model); }));
    fields.Children().Append(button(L"Discard setting edits",[weak=std::weak_ptr<Page>(p),key]{ if(auto page=weak.lock();page && page->current()){ auto memory=page->shell->review; memory->options[key]=copy(memory->savedOptions[key]); page->optionsPaint={}; paintQueue(page); } }));
    options.Content(fields); p->optionsHost.Content(options);
}
hstring stateName(hstring const& state) {
    if(state==L"waiting_on_user") return L"Waiting on you";
    if(state==L"waiting_on_others") return L"Waiting on others";
    if(state==L"completed") return L"Completed or cancelled with evidence";
    if(state==L"informational") return L"For information";
    return L"Needs review";
}
void eventCard(P const& p,StackPanel const& parent,Json event) {
    auto card=stack(7); card.Margin(xaml::Thickness{0,0,0,12});
    words(card,text(event,L"title"),16); words(card,text(event,L"action",text(event,L"summary")));
    words(card,text(event,L"accountId")+L" · "+stateName(text(event,L"state")),12);
    auto deadline=object(event,L"deadline"); if(!text(deadline,L"quote").empty()) words(card,L"Deadline, original wording: "+text(deadline,L"quote"),12);
    Json metadata; put(metadata,L"id",text(event,L"messageId")); put(metadata,L"accountId",text(event,L"accountId"));
    card.Children().Append(button(L"View original message",[weak=std::weak_ptr<Page>(p),metadata]{ if(auto page=weak.lock();page && page->current()) selectOriginal(page,metadata); }));
    Expander details; details.Header(box_value(flag(event,L"grounded") ? L"Evidence":L"Older summary · decision status needs review")); auto evidence=stack(8);
    for(auto const& value:array(event,L"evidence")) words(evidence,text(value.GetObject(),L"quote"));
    for(auto const& question:array(event,L"questions")) words(evidence,L"Needs your answer: "+question.GetString());
    details.Content(evidence); card.Children().Append(details); parent.Children().Append(card);
}
void paintToday(P const& p) {
    auto today=object(p->shell->state,L"today"); p->queue.Children().Clear();
    auto counts=object(today,L"replySuggestionCounts"); unsigned replies=0;
    for(auto const& entry:counts) if(p->scope==L"all" || entry.Key()==p->scope) replies+=static_cast<unsigned>(entry.Value().GetNumber());
    words(p->queue,L"Replies to review: "+to_hstring(replies),16);
    words(p->queue,L"Saved decisions use validated downloaded mail. Unread counts include all dates; downloaded coverage may be incomplete.",12);
    words(p->queue,L"Your decisions",20); unsigned shown=0; auto more=stack(12); Expander other; other.Header(box_value(L"More decisions and background information"));
    for(auto const& value:array(today,L"events")) {
        auto event=value.GetObject(); if(p->scope!=L"all" && text(event,L"accountId")!=p->scope) continue;
        auto state=text(event,L"state");
        if((state==L"waiting_on_user" || state==L"uncertain") && shown++<3) eventCard(p,p->queue,event);
        else eventCard(p,more,event);
    }
    if(!shown) words(p->queue,L"No saved decisions waiting on you. Review a mailbox with Summarize now, or enable summaries in AI & Privacy.");
    words(p->queue,L"Replies to review",20); unsigned preview=0;
    for(auto const& value:array(today,L"replySuggestions")) {
        auto proposal=value.GetObject(); if(p->scope!=L"all" && ownerOf(proposal)!=p->scope) continue; if(preview++>=3) break;
        words(p->queue,text(object(proposal,L"message"),L"subject"),15); words(p->queue,ownerOf(proposal)+L" · "+text(proposal,L"reason"),12);
        p->queue.Children().Append(button(L"Review suggested reply",[weak=p->shell->weak_from_this(),proposal]{ if(auto shell=weak.lock()){ shell->review->selections[std::wstring(shell->review->scope)]=keyOf(proposal); shell->review->details[std::wstring(shell->review->scope)]=true; shell->navigate(L"reply-suggestions"); } }));
    }
    p->queue.Children().Append(button(L"View all replies to review",[weak=p->shell->weak_from_this()]{ if(auto shell=weak.lock()) shell->navigate(L"reply-suggestions"); }));
    other.Content(more); p->queue.Children().Append(other);
    Expander summaries; summaries.Header(box_value(L"Full summary details")); auto reports=stack(12);
    for(auto const& value:array(today,L"summaries")) { auto report=value.GetObject(); if(p->scope!=L"all" && text(report,L"accountId")!=p->scope) continue; words(reports,text(report,L"accountId"),12); words(reports,text(report,L"text")); }
    words(reports,L"Latest 20 valid saved summary jobs per mailbox. All accounts aggregates results; AI context and identity stay separate.",12); summaries.Content(reports); p->queue.Children().Append(summaries);
}
void paintQueue(P const& p) {
    if(!p->current()) return;
    if(p->kind==L"today") { paintToday(p); return; }
    auto memory=p->shell->review; auto found=memory->values.find(std::wstring(p->scope)); if(found==memory->values.end()) return;
    auto response=found->second; auto rows=array(response,L"proposals"); auto fingerprint=rows.Stringify();
    paintOptions(p,response);
    if(fingerprint==p->queuePaint) return; p->queuePaint=fingerprint;
    p->queue.Children().Clear(); p->rows.clear(); words(p->queue,L"Waiting for review · "+to_hstring(rows.Size()),18);
    if(flag(response,L"limited")) words(p->queue,L"This combined queue is bounded to the newest 200 suggestions. Select an account to review its full queue.",12);
    for(auto const& value:rows) {
        auto proposal=value.GetObject(); auto key=keyOf(proposal); p->rows.push_back(proposal);
        auto title=text(object(proposal,L"message"),L"subject",L"Subject withheld");
        auto choose=button(title,[weak=std::weak_ptr<Page>(p),proposal]{ if(auto page=weak.lock();page && page->current()) selectReply(page,proposal); });
        auto caption=label(title,14,false); caption.MaxLines(2); choose.Content(caption);
        xaml::Automation::AutomationProperties::SetName(choose,ownerOf(proposal)+L" · "+title); p->queue.Children().Append(choose);
        words(p->queue,ownerOf(proposal)+L" · "+text(proposal,L"reason"),12);
        if(auto it=memory->entries.find(std::wstring(key));it!=memory->entries.end() && it->second.draft.Size() && text(it->second.proposal,L"text")!=text(proposal,L"text")) { it->second.stale=true; it->second.reviewed=false; }
    }
    if(!rows.Size()) {
        words(p->queue,L"No replies waiting for review.",18);
        words(p->queue,L"AI can miss a request. Check another mailbox or review setup and automatic checks below.");
    }
    if(p->scope!=L"all") {
        if(!flag(response,L"identityReady")) p->queue.Children().Append(button(L"Confirm this account's identity",[weak=p->shell->weak_from_this(),scope=p->scope]{ if(auto shell=weak.lock()) shell->navigate(L"learning",scope); }));
        else if(!flag(response,L"modelReady") || !flag(response,L"permitted")) p->queue.Children().Append(button(L"Review AI connection and privacy",[weak=p->shell->weak_from_this(),scope=p->scope]{ if(auto shell=weak.lock()) shell->navigate(L"policy",scope); }));
        words(p->queue,text(response,L"automaticStatus"),12);
    } else words(p->queue,L"All accounts is read-only. Select a mailbox for setup and account-specific checks.",12);
    if(!p->selectedKey.empty()) {
        auto existing=memory->entries.find(std::wstring(p->selectedKey));
        if(existing!=memory->entries.end() && existing->second.draft.Size()) {
            bool valid=false; for(auto const& value:rows) { auto row=value.GetObject(); if(keyOf(row)==p->selectedKey && proposalId(row)==proposalId(existing->second.proposal) && text(row,L"text")==text(existing->second.proposal,L"text")) valid=true; }
            if(!valid && !flag(response,L"limited")){ existing->second.stale=true; existing->second.reviewed=false; if(p->facts) p->facts.IsChecked(false); if(p->send) p->send.IsEnabled(false); if(p->replace) p->replace.Visibility(xaml::Visibility::Visible); if(p->detailNotice) p->detailNotice.Text(L"Sources changed. Local edits are retained; review fresh evidence before sending."); }
        }
    }
}
IAsyncAction refresh(P p) {
    if(!p->current() || p->polling || p->shell->review->writing) co_return; p->polling=true;
    try {
        if(p->kind==L"today") { paintToday(p); p->say(L"Saved results. Reading Today has not started an AI request."); }
        else {
            auto response=co_await p->shell->service->request(L"/reply-suggestions",p->scope);
            if(!p->current()){p->polling=false;co_return;}
            require(text(response,L"owner")==p->scope,L"The suggestion mailbox changed.");
            for(auto const& value:array(response,L"proposals")) { auto proposal=value.GetObject(); auto owner=ownerOf(proposal); require(p->shell->connected(owner) && (p->scope==L"all" || owner==p->scope) && text(object(proposal,L"message"),L"accountId")==owner,L"A suggestion belongs to another mailbox."); }
            p->shell->review->values[std::wstring(p->scope)]=copy(response); paintQueue(p); p->say(L"Saved suggestions. No AI or provider write was started by opening this page.");
        }
    } catch(hresult_error const& error) { p->say(error.message()+L" · Previous results and draft edits are retained. Use Reload to try again."); }
    p->polling=false;
}
IAsyncAction completed() { co_return; }
}

IAsyncAction reviewPage(std::shared_ptr<Shell> shell,hstring kind) {
    auto p=std::make_shared<Page>(); p->shell=shell; p->kind=kind; p->scope=shell->review->scope; p->generation=++shell->generation; shell->section=kind;
    if(p->scope!=L"all" && !shell->connected(p->scope)) { p->scope=L"all"; shell->review->scope=L"all"; }
    p->selectedKey=shell->review->selections[std::wstring(p->scope)];
    Grid root; root.Margin(xaml::Thickness{20,16,20,16});
    for(unsigned i=0;i<4;++i){ RowDefinition row; row.Height(GridLengthHelper::FromValueAndType(i==3 ? 1:0,i==3 ? GridUnitType::Star:GridUnitType::Auto)); root.RowDefinitions().Append(row); }
    auto header=stack(8); header.Orientation(Orientation::Horizontal); words(header,kind==L"today" ? L"Today":L"Reply suggestions",26);
    auto reload=button(L"Reload",[weak=std::weak_ptr<Page>(p)]{ if(auto page=weak.lock();page && page->current()) refresh(page); }); header.Children().Append(reload);
    if(kind==L"today") {
        auto summarize=button(L"Summarize now…",[]{}); MenuFlyout mailboxes;
        for(auto const& value:array(shell->state,L"accounts")){ auto account=value.GetObject(); auto owner=text(account,L"id"); MenuFlyoutItem item; item.Text(owner); item.Click([weak=shell->weak_from_this(),owner](auto const&,auto const&){ if(auto host=weak.lock()) summarizeNow(host,owner); }); mailboxes.Items().Append(item); }
        summarize.Flyout(mailboxes); header.Children().Append(summarize);
    }
    root.Children().Append(header);
    auto tabs=stack(7); tabs.Orientation(Orientation::Horizontal); std::vector<hstring> owners{L"all"}; for(auto const& value:array(shell->state,L"accounts")) owners.push_back(text(value.GetObject(),L"id"));
    for(auto const& owner:owners) {
        controls::Primitives::ToggleButton tab; tab.Content(box_value(owner==L"all" ? hstring(L"All accounts"):owner)); tab.IsChecked(owner==p->scope); tab.IsTabStop(owner==p->scope);
        tab.KeyDown([weak=std::weak_ptr<Page>(p),owners,owner](auto const&,xaml::Input::KeyRoutedEventArgs const& args){
            if(auto page=weak.lock();page && page->current() && !page->shell->review->writing) {
                auto found=std::find(owners.begin(),owners.end(),owner); auto index=static_cast<int>(found-owners.begin());
                if(args.Key()==VirtualKey::Left) index=std::max(0,index-1); else if(args.Key()==VirtualKey::Right) index=std::min(static_cast<int>(owners.size())-1,index+1); else if(args.Key()==VirtualKey::Home) index=0; else if(args.Key()==VirtualKey::End) index=static_cast<int>(owners.size())-1; else return;
                page->shell->review->scope=owners[static_cast<size_t>(index)]; args.Handled(true); reviewPage(page->shell,page->kind);
            }
        });
        if(owner==p->scope) tab.Loaded([weak=std::weak_ptr<Page>(p)](auto const& sender,auto const&){ if(auto page=weak.lock();page && page->current()) sender.template as<controls::Primitives::ToggleButton>().Focus(xaml::FocusState::Programmatic); });
        xaml::Automation::AutomationProperties::SetName(tab,L"Review mailbox: "+owner); tab.Click([weak=std::weak_ptr<Page>(p),owner](auto const&,auto const&) { if(auto page=weak.lock();page && page->current() && !page->shell->review->writing){ page->shell->review->scope=owner; reviewPage(page->shell,page->kind); } }); tabs.Children().Append(tab);
    }
    ScrollViewer tabScroll; tabScroll.HorizontalScrollBarVisibility(ScrollBarVisibility::Auto); tabScroll.VerticalScrollBarVisibility(ScrollBarVisibility::Disabled); tabScroll.Content(tabs); Grid::SetRow(tabScroll,1); root.Children().Append(tabScroll);
    auto notice=label(L"Loading saved results…",12); p->notice=notice; Grid::SetRow(notice,2); root.Children().Append(notice);
    Grid columns; p->columns=columns; Grid::SetRow(columns,3); root.Children().Append(columns);
    auto queue=stack(12); queue.Margin(xaml::Thickness{0,14,14,0}); p->queue=queue; auto list=stack(14); list.Children().Append(queue); ContentControl options; p->optionsHost=options; list.Children().Append(options); p->listScroll=rememberScroll(p,list,kind+L":list:"+p->scope); columns.Children().Append(p->listScroll);
    Grid detail; RowDefinition content; content.Height(GridLengthHelper::FromValueAndType(1,GridUnitType::Star)); RowDefinition actions; actions.Height(GridLengthHelper::FromValueAndType(0,GridUnitType::Auto)); detail.RowDefinitions().Append(content); detail.RowDefinitions().Append(actions);
    ContentControl host; host.HorizontalContentAlignment(xaml::HorizontalAlignment::Stretch); host.VerticalContentAlignment(xaml::VerticalAlignment::Stretch); host.Content(label(L"Choose a suggestion to view the original message and edit its account-owned reply.")); p->detailHost=host; detail.Children().Append(host); p->detail=detail; columns.Children().Append(detail);
    if(kind==L"reply-suggestions") {
        xaml::Input::KeyboardAccelerator save; save.Key(VirtualKey::S); save.Modifiers(VirtualKeyModifiers::Control); save.Invoked([weak=std::weak_ptr<Page>(p)](auto const&,auto const& args){ if(auto page=weak.lock();page && page->current()) { saveDraft(page); args.Handled(true); } }); root.KeyboardAccelerators().Append(save);
        xaml::Input::KeyboardAccelerator send; send.Key(VirtualKey::Enter); send.Modifiers(VirtualKeyModifiers::Control); send.Invoked([weak=std::weak_ptr<Page>(p)](auto const&,auto const& args){ if(auto page=weak.lock();page && page->current()) { reviewSend(page); args.Handled(true); } }); root.KeyboardAccelerators().Append(send);
    }
    columns.SizeChanged([weak=std::weak_ptr<Page>(p)](auto const&,auto const&){if(auto page=weak.lock()) reflow(page);});
    root.Unloaded([p](auto const&,auto const&){ p->live=false; p->columns=nullptr; p->queue=nullptr; p->editor=nullptr; p->actions=nullptr; p->listScroll=nullptr; p->detail=nullptr; p->detailHost=nullptr; p->optionsHost=nullptr; p->notice=nullptr; p->detailNotice=nullptr; p->body=nullptr; p->facts=nullptr; p->send=nullptr; p->replace=nullptr; });
    root.KeyDown([weak=std::weak_ptr<Page>(p)](auto const&,xaml::Input::KeyRoutedEventArgs const& args){if(auto page=weak.lock();page && page->current() && args.Key()==VirtualKey::Escape && page->compact){ page->shell->review->details[std::wstring(page->scope)]=false; reflow(page); args.Handled(true); }});
    std::weak_ptr<Page> weak=p;
    shell->refreshReview=[weak] { if(auto page=weak.lock()) return refresh(page); return completed(); };
    shell->show(root); reflow(p);
    if(kind==L"reply-suggestions") paintQueue(p); else paintToday(p);
    co_await refresh(p); if(!p->current()) co_return;
    if(kind==L"reply-suggestions" && !p->selectedKey.empty()) {
        if(auto cached=shell->review->entries.find(std::wstring(p->selectedKey));cached!=shell->review->entries.end()) co_await selectReply(p,cached->second.proposal);
        else for(auto const& row:p->rows) if(keyOf(row)==p->selectedKey){co_await selectReply(p,row);break;}
    } else if(kind==L"today") {
        if(auto found=shell->review->originals.find(std::wstring(p->scope));found!=shell->review->originals.end() && shell->review->details[std::wstring(p->scope)]) co_await selectOriginal(p,found->second);
    }
}
}
