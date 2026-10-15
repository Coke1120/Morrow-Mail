#include "pch.h"
#include "Ui.h"
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Peers.h>
#include <winrt/Microsoft.UI.Xaml.Automation.Provider.h>
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
using namespace Microsoft::UI::Xaml;
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
    TextBlock notice{nullptr},detailNotice{nullptr}; TextBox body{nullptr}; CheckBox facts{nullptr}; Button send{nullptr},replace{nullptr},refreshEvidence{nullptr};
    DropDownButton replyMore{nullptr};
    std::vector<Json> rows;
    bool current() const { return live && !shell->closing && shell->generation==generation && shell->section==kind && shell->review->scope==scope; }
    void say(hstring const& value) { if (current()) notice.Text(value); }
};
using P=std::shared_ptr<Page>;
std::weak_ptr<Page> mountedReview;
IAsyncAction refresh(P page);
IAsyncAction selectReply(P page,Json proposal);
IAsyncAction selectOriginal(P page,Json metadata);
IAsyncAction replaceReply(P page);
IAsyncAction keepEdits(P page);
IAsyncAction saveDraft(P page);
IAsyncAction reviewSend(P page);
IAsyncAction saveOptions(P page,Json model);
void paintQueue(P const& page);
void reflow(P const& page);
void showDecision(P const& page, Json item, bool task);
MenuFlyout summaryMailboxMenu(P const& p) {
    MenuFlyout menu;
    for(auto const& value:array(p->shell->state,L"accounts")) {
        auto owner=text(value.GetObject(),L"id");
        if(!p->shell->connected(owner) || (p->scope!=L"all" && p->scope!=owner))continue;
        auto item=menuItem(owner,[weak=std::weak_ptr<Page>(p),owner]{if(auto page=weak.lock();page && page->current() && !page->shell->review->writing)summarizeNow(page->shell,owner);});
        item.Tag(box_value(owner));menu.Items().Append(item);
    }
    return menu;
}
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
    if (!p->current() || p->selectedKey!=key || p->shell->review->detailKinds[std::wstring(p->scope)]!=L"reply") return;
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
        if(auto page=weak.lock();page && page->current() && !page->shell->review->writing && page->selectedKey==key
            && page->body==sender.template as<TextBox>() && page->shell->review->detailKinds[std::wstring(page->scope)]==L"reply"
            && page->shell->review->details[std::wstring(page->scope)]) {
            auto& current=page->shell->review->entries[std::wstring(key)]; put(current.draft,L"body",sender.template as<TextBox>().Text()); current.reviewed=false;
            if(page->facts) page->facts.IsChecked(false); if(page->send) page->send.IsEnabled(false);
        }
    }); content.Children().Append(body);
    CheckBox facts; facts.Content(box_value(L"I checked the facts, missing answers and commitments")); facts.IsChecked(entry.reviewed); facts.IsEnabled(!entry.stale); p->facts=facts;
    auto updateFacts=[weak=std::weak_ptr<Page>(p),key](auto const& sender,auto const&) {
        if(auto page=weak.lock();page && page->current() && page->selectedKey==key
            && page->facts==sender.template as<CheckBox>() && page->shell->review->detailKinds[std::wstring(page->scope)]==L"reply"
            && page->shell->review->details[std::wstring(page->scope)]) {
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
    MenuFlyout more;auto moreButton=actionMenu(L"More",more,L"More actions for this suggested reply");p->replyMore=moreButton;
    auto replyContext=[weak=std::weak_ptr<Page>(p),control=make_weak(moreButton),key,owner,
        scope=p->scope,generation=p->generation,sequence=p->selection,proposal=entry.proposal.Stringify()]() -> P {
        auto page=weak.lock();auto target=control.get();
        if(!page || !page->current() || !target || !target.IsLoaded() || page->replyMore!=target
            || target.XamlRoot()!=page->shell->root.XamlRoot() || page->generation!=generation || page->selection!=sequence
            || page->scope!=scope || page->selectedKey!=key || !page->shell->connected(owner)
            || page->shell->review->detailKinds[std::wstring(scope)]!=L"reply" || !page->shell->review->details[std::wstring(scope)])return {};
        auto found=page->shell->review->entries.find(std::wstring(key));
        if(found==page->shell->review->entries.end() || ownerOf(found->second.proposal)!=owner || keyOf(found->second.proposal)!=key
            || found->second.proposal.Stringify()!=proposal)return {};
        return page;
    };
    auto refreshEvidence=button(L"Keep edits and refresh evidence",[replyContext]{if(auto page=replyContext())keepEdits(page);});
    p->refreshEvidence=refreshEvidence; refreshEvidence.Visibility(entry.stale ? Visibility::Visible : Visibility::Collapsed); content.Children().Append(refreshEvidence);
    more.Items().Append(menuItem(L"Keep edits and refresh evidence",[replyContext]{if(auto page=replyContext())keepEdits(page);}));
    xaml::Automation::AutomationProperties::SetAutomationId(moreButton,L"review.reply.more"); content.Children().Append(moreButton);
    p->detailHost.Content(rememberScroll(p,content,L"reply-detail:"+key));
    auto buttons=stack(8); p->actions=buttons; buttons.Orientation(p->compact ? Orientation::Vertical:Orientation::Horizontal); buttons.Margin(ThicknessHelper::FromUniformLength(12));
    buttons.Children().Append(button(p->kind==L"today" ? L"Back to Today" : L"Back to suggestions",[weak=std::weak_ptr<Page>(p)]{ if(auto page=weak.lock();page && page->current()){ page->shell->review->details[std::wstring(page->scope)]=false; reflow(page); page->listScroll.Focus(xaml::FocusState::Programmatic); } }));
    buttons.Children().Append(button(L"Save draft",[weak=std::weak_ptr<Page>(p)]{ if(auto page=weak.lock();page && page->current()) saveDraft(page); }));
    auto send=button(L"Review sending…",[weak=std::weak_ptr<Page>(p)]{ if(auto page=weak.lock();page && page->current()) reviewSend(page); }); p->send=send;
    xaml::Automation::AutomationProperties::SetAutomationId(send,L"review.reply.send");
    send.IsEnabled(entry.reviewed && !entry.stale && !p->shell->review->writing && !needsDecision(entry.draft));
    buttons.Children().Append(send); Grid::SetRow(buttons,1);
    while(p->detail.Children().Size()>1) p->detail.Children().RemoveAtEnd(); p->detail.Children().Append(buttons);
}
IAsyncAction selectReply(P p,Json proposal) {
    auto owner=ownerOf(proposal),key=keyOf(proposal),id=text(proposal,L"messageId");
    if(!p->current() || p->busy || p->shell->review->writing || !p->shell->connected(owner) || id.empty() || (p->scope!=L"all" && p->scope!=owner)) co_return;
    p->shell->review->detailKinds[std::wstring(p->scope)]=L"reply";
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
    if(!p->current() || p->busy || p->shell->review->writing || p->selectedKey.empty()
        || p->shell->review->detailKinds[std::wstring(p->scope)]!=L"reply" || !p->shell->review->details[std::wstring(p->scope)]) co_return;
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
    if(!p->current() || p->busy || p->shell->review->writing || !p->shell->connected(owner) || id.empty() || (p->scope!=L"all" && p->scope!=owner)) co_return;
    bool backToReply=p->shell->review->detailKinds[std::wstring(p->scope)]==L"reply";
    p->shell->review->detailKinds[std::wstring(p->scope)]=L"original";
    p->body=nullptr;p->facts=nullptr;p->send=nullptr;p->replace=nullptr;p->refreshEvidence=nullptr;p->replyMore=nullptr;
    auto sequence=++p->selection; ++p->shell->selectionGeneration; p->shell->readerImageOverride.reset();
    p->shell->review->originals[std::wstring(p->scope)]=copy(metadata); p->shell->review->details[std::wstring(p->scope)]=true;
    while(p->detail.Children().Size()>1) p->detail.Children().RemoveAtEnd(); p->actions=nullptr;
    auto panel=stack(12); words(panel,L"Loading original message…"); p->detailHost.Content(scroll(panel)); reflow(p);
    try {
        auto result=co_await p->shell->service->request(L"/messages/"+escaped(id),owner);
        if(!p->current() || sequence!=p->selection) co_return;
        auto message=object(result,L"message"); owned(message,owner,id); panel.Children().Clear();
        words(panel,owner,12); mountOriginal(p,panel,message);
        panel.Children().Append(button(backToReply ? L"Back to reply":L"Close original",[weak=std::weak_ptr<Page>(p),backToReply] { if(auto page=weak.lock();page && page->current()) {
            if(backToReply && !page->selectedKey.empty()){ auto entry=page->shell->review->entries.find(std::wstring(page->selectedKey)); if(entry!=page->shell->review->entries.end()){ selectReply(page,entry->second.proposal); return; } }
            page->shell->review->details[std::wstring(page->scope)]=false; reflow(page);
        } }));
        panel.Children().Append(button(L"Open in mailbox…",[weak=p->shell->weak_from_this(),metadata]{ if(auto shell=weak.lock()) shell->openSource(metadata); }));
    } catch(hresult_error const& error) { if(p->current()){ panel.Children().Clear(); words(panel,error.message()); panel.Children().Append(button(L"Reload original",[weak=std::weak_ptr<Page>(p),metadata]{ if(auto page=weak.lock();page && page->current()) selectOriginal(page,metadata); })); } }
}
struct WriteGuard {
    std::shared_ptr<Shell> shell;
    P page;
    explicit WriteGuard(P const& p):shell(p->shell),page(p) { shell->review->writing=true; shell->navigation.IsEnabled(false);if(p->body)p->body.IsEnabled(false);if(p->facts)p->facts.IsEnabled(false);if(p->send)p->send.IsEnabled(false); }
    ~WriteGuard(){ shell->review->writing=false; if(!shell->closing) shell->navigation.IsEnabled(true);if(page->current()){if(page->body)page->body.IsEnabled(true);auto found=shell->review->entries.find(std::wstring(page->selectedKey));if(found!=shell->review->entries.end()){auto const& entry=found->second;if(page->facts)page->facts.IsEnabled(!entry.stale);if(page->send)page->send.IsEnabled(entry.reviewed&&!entry.stale&&!needsDecision(entry.draft));}} }
};
IAsyncAction keepEdits(P p) {
    if(!p->current()||p->busy||p->shell->review->writing||p->selectedKey.empty()
        ||p->shell->review->detailKinds[std::wstring(p->scope)]!=L"reply"||!p->shell->review->details[std::wstring(p->scope)])co_return;
    auto oldKey=p->selectedKey;auto old=p->shell->review->entries[std::wstring(oldKey)];auto owner=ownerOf(old.proposal);if(!old.draft.Size()||!p->shell->connected(owner))co_return;
    WriteGuard guard(p);
    try{
        auto response=co_await p->shell->service->request(L"/reply-suggestions",owner);if(!p->current())co_return;
        require(text(response,L"owner")==owner,L"The refreshed mailbox changed.");Json fresh;bool found=false;
        for(auto const& value:array(response,L"proposals")){auto row=value.GetObject();if(ownerOf(row)==owner&&(text(row,L"messageId")==text(old.proposal,L"messageId")||(!text(old.proposal,L"conversationKey").empty()&&text(row,L"conversationKey")==text(old.proposal,L"conversationKey")))){fresh=copy(row);found=true;break;}}
        require(found,L"No current reply is suggested for this conversation. Your edits can still be saved.");auto id=text(fresh,L"messageId"),key=keyOf(fresh);
        auto original=co_await p->shell->service->request(L"/messages/"+escaped(id),owner);if(!p->current())co_return;auto message=object(original,L"message");owned(message,owner,id);
        Json input;put(input,L"messageId",id);put(input,L"mode",L"reply");put(input,L"body",text(old.draft,L"body"));auto prepared=co_await p->shell->service->request(L"/drafts/prepare",owner,L"POST",input);if(!p->current())co_return;auto draft=object(prepared,L"draft");
        require(text(draft,L"accountId")==owner&&text(draft,L"replyToId")==id&&text(draft,L"body")==text(old.draft,L"body")&&text(draft,L"bcc").empty(),L"The refreshed reply owner could not be verified.");
        auto latest=co_await p->shell->service->request(L"/reply-suggestions",owner);require(p->current()&&validProposal(latest,fresh),L"The conversation changed again. Your original edits remain intact.");
        for(auto field:{L"footer",L"attachments"})if(old.draft.HasKey(field))draft.Insert(field,old.draft.GetNamedValue(field));if(id==text(old.draft,L"replyToId")&&!text(old.draft,L"id").empty())put(draft,L"id",text(old.draft,L"id"));
        ReviewEntry updated;updated.proposal=copy(fresh);updated.message=copy(message);updated.draft=copy(draft);updated.reviewed=false;updated.stale=false;
        if(key!=oldKey){updated.saved=copy(draft);put(updated.saved,L"body",text(fresh,L"text"));}else updated.saved=copy(old.saved);
        p->shell->review->moveEntry(oldKey,key,std::move(updated));
        p->selectedKey=key;p->shell->review->selections[std::wstring(p->scope)]=key;p->shell->review->values[std::wstring(p->scope)]=copy(latest);++p->shell->selectionGeneration;paintEditor(p,key);p->say(L"Latest evidence loaded. Your text is preserved; check the new recipient, facts and commitments again.");
    }catch(hresult_error const& error){p->say(error.message());}
}
IAsyncAction saveDraft(P p) {
    if(!p->current() || p->busy || p->shell->review->writing || p->selectedKey.empty()
        || p->shell->review->detailKinds[std::wstring(p->scope)]!=L"reply" || !p->shell->review->details[std::wstring(p->scope)]) co_return;
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
    if(!p->current() || p->busy || p->shell->review->writing || p->selectedKey.empty()
        || p->shell->review->detailKinds[std::wstring(p->scope)]!=L"reply" || !p->shell->review->details[std::wstring(p->scope)]) co_return;
    auto key=p->selectedKey; auto& entry=p->shell->review->entries[std::wstring(key)];
    if(!entry.reviewed || entry.stale || needsDecision(entry.draft) || !p->shell->connected(ownerOf(entry.proposal))
        || (p->scope!=L"all" && p->scope!=ownerOf(entry.proposal))) co_return;
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
    card.Children().Append(button(L"Review",[weak=std::weak_ptr<Page>(p),event]{ if(auto page=weak.lock();page && page->current()) showDecision(page,event,false); }));
    parent.Children().Append(card);
}
void paintToday(P const& p);
fire_and_forget reviewTodo(P page, hstring path, hstring owner, hstring id, hstring title, hstring confirmTitle, hstring done) {
    if (!page || !page->current() || page->busy) co_return;
    page->busy = true;
    try {
        if (!(co_await page->shell->confirm(confirmTitle, title + L"\nMail stays unchanged. Nothing is sent and Email Brain is not updated.", L"Continue")) || !page->current()) {
            page->busy = false; co_return;
        }
        Json input; put(input, L"id", id); input.Insert(L"confirm", Value::CreateBooleanValue(true));
        auto result = co_await page->shell->service->request(path, owner, L"POST", input);
        if (!page->current()) { page->busy = false; co_return; }
        if (text(object(result, L"account"), L"id") == page->shell->owner) page->shell->state = result;
        else if (result.HasKey(L"today")) page->shell->state.Insert(L"today", object(result, L"today"));
        page->shell->review->details[std::wstring(page->scope)]=false;
        paintToday(page); reflow(page); page->say(done);
    } catch (hresult_error const& error) { if (page->current()) page->say(error.message()); }
    catch (...) { if (page->current()) page->say(L"The suggestion could not be updated. Mail was not changed."); }
    page->busy = false;
}
void showDecision(P const& p,Json item,bool task) {
    auto owner=text(item,L"accountId");
    if(!p->current() || p->busy || p->shell->review->writing || !p->shell->connected(owner) || (p->scope!=L"all" && p->scope!=owner)) return;
    ++p->selection; p->shell->review->detailKinds[std::wstring(p->scope)]=L"decision";
    p->selectedKey={};p->originalOwner={};p->originalId={};
    p->body=nullptr;p->facts=nullptr;p->send=nullptr;p->replace=nullptr;p->refreshEvidence=nullptr;p->replyMore=nullptr;
    Json retained;retained.Insert(L"item",copy(item));retained.Insert(L"task",Value::CreateBooleanValue(task));
    p->shell->review->decisions[std::wstring(p->scope)]=retained;
    p->shell->review->details[std::wstring(p->scope)]=true;
    auto panel=stack(12); panel.Margin(xaml::Thickness{18,10,18,14});
    words(panel,text(item,L"title"),20); words(panel,owner,12);
    words(panel,task ? text(item,L"detail") : text(item,L"action",text(item,L"summary")));
    if(!task) {
        words(panel,stateName(text(item,L"state")),12);
        for(auto const& value:array(item,L"evidence")) words(panel,text(value.GetObject(),L"quote"));
        for(auto const& question:array(item,L"questions")) words(panel,L"Needs your answer: "+question.GetString());
    }
    Json metadata; put(metadata,L"id",text(item,L"messageId")); put(metadata,L"accountId",owner);
    panel.Children().Append(button(L"Open original message",[weak=std::weak_ptr<Page>(p),metadata]{ if(auto page=weak.lock();page && page->current())selectOriginal(page,metadata); }));
    if(task) {
        words(panel,L"Completing this suggestion does not mark mail read, send mail, or change Email Brain.",12);
        auto complete=button(L"Complete suggestion…",[weak=std::weak_ptr<Page>(p),item,owner]{
            if(auto page=weak.lock();page && page->current()) {
                bool retained=false;
                for(auto const& value:array(object(page->shell->state,L"today"),L"todos")) if(value.GetObject().Stringify()==item.Stringify())retained=true;
                if(!retained){page->say(L"This saved suggestion changed. Return to Today and review the current item.");return;}
                reviewTodo(page,L"/workspace/todos/complete",owner,text(item,L"id"),text(item,L"title"),L"Complete this suggestion?",L"Suggestion completed. The message was not marked read.");
            }
        });
        xaml::Automation::AutomationProperties::SetAutomationId(complete,L"review.today.complete");panel.Children().Append(complete);
    }
    panel.Children().Append(button(L"Back to Today",[weak=std::weak_ptr<Page>(p)]{if(auto page=weak.lock();page && page->current()){page->shell->review->details[std::wstring(page->scope)]=false;reflow(page);page->listScroll.Focus(xaml::FocusState::Programmatic);}}));
    while(p->detail.Children().Size()>1)p->detail.Children().RemoveAtEnd();p->actions=nullptr;
    p->detailHost.Content(scroll(panel)); reflow(p);
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
    if(!shown) words(p->queue,L"No saved decisions waiting on you. More offers a reviewed summary for one mailbox; saved AI settings remain unchanged.");
    words(p->queue,L"Replies to review",20); unsigned preview=0;
    for(auto const& value:array(today,L"replySuggestions")) {
        auto proposal=value.GetObject(); if(p->scope!=L"all" && ownerOf(proposal)!=p->scope) continue; if(preview++>=3) break;
        words(p->queue,text(object(proposal,L"message"),L"subject"),15); words(p->queue,ownerOf(proposal)+L" · "+text(proposal,L"reason"),12);
        auto review=button(L"Review suggested reply",[weak=std::weak_ptr<Page>(p),proposal]{ if(auto page=weak.lock();page && page->current())selectReply(page,proposal); });
        xaml::Automation::AutomationProperties::SetAutomationId(review,L"review.today.reply."+keyOf(proposal));p->queue.Children().Append(review);
    }
    p->queue.Children().Append(button(L"View all replies to review",[weak=p->shell->weak_from_this()]{ if(auto shell=weak.lock()) shell->navigate(L"reply-suggestions"); }));
    words(p->queue, L"Suggested tasks", 20);
    words(p->queue, L"From saved summaries and unread Inbox mail on this device. Completing one does not mark mail read, send mail, or change Email Brain.", 12);
    unsigned suggestions = 0;
    for (auto const& value : array(today, L"todos")) {
        auto todo = value.GetObject(); if (p->scope != L"all" && text(todo, L"accountId") != p->scope) continue; ++suggestions;
        words(p->queue, text(todo, L"title"), 15);
        words(p->queue, text(todo, L"categoryName") + L" · " + text(todo, L"accountId"), 12);
        words(p->queue, text(todo, L"detail"), 12);
        auto review=button(L"Review",[weak=std::weak_ptr<Page>(p),todo]{if(auto page=weak.lock();page && page->current())showDecision(page,todo,true);});
        xaml::Automation::AutomationProperties::SetAutomationId(review,L"review.today.task."+text(todo,L"accountId")+L"."+text(todo,L"id"));p->queue.Children().Append(review);
    }
    if (!suggestions) words(p->queue, L"No open suggestions in this scope.");
    Expander completed; completed.Header(box_value(L"Completed suggestions")); auto doneList = stack(8);
    unsigned finished = 0;
    for (auto const& value : array(today, L"completedTodos")) {
        auto todo = value.GetObject(); if (p->scope != L"all" && text(todo, L"accountId") != p->scope) continue; ++finished;
        words(doneList, text(todo, L"title"), 15);
        words(doneList, text(todo, L"categoryName") + L" · " + text(todo, L"accountId"), 12);
        auto id = text(todo, L"id"), owner = text(todo, L"accountId"), title = text(todo, L"title");
        doneList.Children().Append(button(L"Reopen suggestion…", [weak = std::weak_ptr<Page>(p), id, owner, title] {
            if (auto page = weak.lock()) reviewTodo(page, L"/workspace/todos/reopen", owner, id, title, L"Reopen this suggestion?", L"Suggestion reopened. Mail was not changed.");
        }));
    }
    if (!finished) words(doneList, L"No completed suggestions in this scope.");
    completed.Content(doneList); p->queue.Children().Append(completed);
    other.Content(more); p->queue.Children().Append(other);
    Expander summaries; summaries.Header(box_value(L"Full summary details")); auto reports=stack(12);
    for(auto const& value:array(today,L"summaries")) { auto report=value.GetObject(); if(p->scope!=L"all" && text(report,L"accountId")!=p->scope) continue; words(reports,text(report,L"accountId"),12); words(reports,text(report,L"text")); }
    words(reports,L"Latest 20 valid saved summary jobs per mailbox. All accounts aggregates results; AI context and identity stay separate.",12); summaries.Content(reports); p->queue.Children().Append(summaries);
    bool hasSummary=false;for(auto const& value:array(today,L"summaries"))if(p->scope==L"all" || text(value.GetObject(),L"accountId")==p->scope)hasSummary=true;
    if(!hasSummary && !shown && !preview && !suggestions) {
        auto choices=summaryMailboxMenu(p);auto start=actionMenu(L"Review a mailbox for a summary…",choices,L"Review downloaded mail before generating a summary");
        start.IsEnabled(choices.Items().Size()!=0);p->queue.Children().Append(start);
    }
}
void reconcileReply(P const& p,Json const& response) {
    if(p->selectedKey.empty())return;
    auto memory=p->shell->review;auto existing=memory->entries.find(std::wstring(p->selectedKey));
    if(existing==memory->entries.end() || !existing->second.draft.Size())return;
    auto ownedResponse=copy(response);put(ownedResponse,L"owner",ownerOf(existing->second.proposal));
    bool valid=validProposal(ownedResponse,existing->second.proposal);
    if((!valid && !flag(response,L"limited")) || !p->shell->connected(ownerOf(existing->second.proposal))) {
        existing->second.stale=true;existing->second.reviewed=false;
        if(p->facts)p->facts.IsChecked(false);if(p->send)p->send.IsEnabled(false);
        if(p->replace)p->replace.Visibility(Visibility::Visible);
        if(p->refreshEvidence)p->refreshEvidence.Visibility(Visibility::Visible);
        if(p->detailNotice)p->detailNotice.Text(L"Sources changed. Local edits are retained; review fresh evidence before sending.");
    }
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
    reconcileReply(p,response);
}
IAsyncAction refresh(P p) {
    if(!p->current() || p->polling || p->shell->review->writing) co_return; p->polling=true;
    try {
        if(p->kind==L"today") {
            paintToday(p);
            if(p->shell->review->detailKinds[std::wstring(p->scope)]==L"reply" && p->shell->review->details[std::wstring(p->scope)]) {
                auto found=p->shell->review->entries.find(std::wstring(p->selectedKey));
                if(found!=p->shell->review->entries.end()) {
                    auto key=p->selectedKey;auto sequence=p->selection;auto owner=ownerOf(found->second.proposal);
                    if(p->shell->connected(owner)) {
                        auto response=co_await p->shell->service->request(L"/reply-suggestions",owner);
                        if(!p->current() || p->selection!=sequence || p->selectedKey!=key){p->polling=false;co_return;}
                        require(text(response,L"owner")==owner,L"The suggestion mailbox changed.");
                        reconcileReply(p,response);
                    } else { Json absent;reconcileReply(p,absent); }
                }
            }
            p->say(L"Saved results. Reading Today has not started an AI request.");
        }
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
IAsyncAction invokeReviewButton(std::shared_ptr<Shell> shell,Button target) {
    apartment_context ui;auto deadline=GetTickCount64()+5000;target.StartBringIntoView();shell->root.UpdateLayout();
    while((!target.IsLoaded() || !target.ActualWidth() || !target.ActualHeight()) && GetTickCount64()<deadline) {
        co_await resume_after(std::chrono::milliseconds(10));co_await ui;shell->root.UpdateLayout();
    }
    require(target.IsLoaded() && target.ActualWidth() && target.ActualHeight() && target.Focus(FocusState::Keyboard),L"The review action did not become a focusable mounted native button.");
    auto peer=xaml::Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(target);
    peer.GetPattern(xaml::Automation::Peers::PatternInterface::Invoke).as<xaml::Automation::Provider::IInvokeProvider>().Invoke();
}
IAsyncAction staleReplyFlyoutChecks(P p,Json first,Json next) {
    apartment_context ui;auto more=p->replyMore;auto menu=more.Flyout().as<MenuFlyout>();
    require(p->selectedKey==keyOf(first) && p->shell->navigation.IsEnabled() && !p->shell->review->writing,L"The stale-reply fixture did not start with the first idle reply.");
    auto opened=std::make_shared<bool>(false),closed=std::make_shared<bool>(false);
    auto openEvent=menu.Opened(auto_revoke,[opened](auto const&,auto const&){*opened=true;});
    auto closeEvent=menu.Closed(auto_revoke,[closed](auto const&,auto const&){*closed=true;});
    auto deadline=GetTickCount64()+5000;more.StartBringIntoView();p->shell->root.UpdateLayout();
    while((!more.IsLoaded() || !more.ActualWidth()) && GetTickCount64()<deadline){co_await resume_after(std::chrono::milliseconds(10));co_await ui;p->shell->root.UpdateLayout();}
    require(more.IsLoaded() && more.ActualWidth() && more.Focus(FocusState::Keyboard),L"The original reply More control did not mount.");
    menu.ShowAt(more);while(!*opened && GetTickCount64()<deadline){co_await resume_after(std::chrono::milliseconds(10));co_await ui;}
    require(*opened && menu.IsOpen(),L"The original reply flyout did not open.");
    auto item=menu.Items().GetAt(0).as<MenuFlyoutItem>();auto invoked=std::make_shared<unsigned>(0);
    auto clickEvent=item.Click(auto_revoke,[invoked](auto const&,auto const&){if(*invoked<2)++*invoked;});
    auto invoke=xaml::Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(item).GetPattern(xaml::Automation::Peers::PatternInterface::Invoke).as<xaml::Automation::Provider::IInvokeProvider>();
    menu.Hide();deadline=GetTickCount64()+5000;while(!*closed && GetTickCount64()<deadline){co_await resume_after(std::chrono::milliseconds(10));co_await ui;}
    require(*closed && !menu.IsOpen(),L"The retained reply flyout did not close.");
    co_await invokeReviewButton(p->shell,p->actions.Children().GetAt(0).as<Button>());
    Button choose{nullptr};for(auto const& child:p->queue.Children())if(auto candidate=child.try_as<Button>();candidate && xaml::Automation::AutomationProperties::GetAutomationId(candidate)==L"review.today.reply."+keyOf(next))choose=candidate;
    require(bool(choose),L"The replacement reply has no mounted Today card.");co_await invokeReviewButton(p->shell,choose);
    require(p->current() && p->selectedKey==keyOf(next) && p->replyMore!=more,L"The replacement reply did not invalidate the original More control.");
    auto firstDraft=p->shell->review->entries.at(std::wstring(keyOf(first))).draft.Stringify();
    auto nextDraft=p->shell->review->entries.at(std::wstring(keyOf(next))).draft.Stringify();
    auto disabled=std::make_shared<unsigned>(0);auto nav=p->shell->navigation;
    auto token=nav.RegisterPropertyChangedCallback(Control::IsEnabledProperty(),[disabled](auto const& sender,auto const&){if(!sender.template as<Control>().IsEnabled() && *disabled<2)++*disabled;});
    struct Unregister {NavigationView nav;int64_t token;~Unregister(){nav.UnregisterPropertyChangedCallback(Control::IsEnabledProperty(),token);}} unregister{nav,token};
    invoke.Invoke();deadline=GetTickCount64()+5000;while(!*invoked && GetTickCount64()<deadline){co_await resume_after(std::chrono::milliseconds(10));co_await ui;}
    co_await resume_after(std::chrono::milliseconds(10));co_await ui;
    require(*invoked==1 && *disabled==0 && !p->shell->review->writing && p->shell->navigation.IsEnabled()
        && p->selectedKey==keyOf(next) && p->shell->review->entries.at(std::wstring(keyOf(first))).draft.Stringify()==firstDraft
        && p->shell->review->entries.at(std::wstring(keyOf(next))).draft.Stringify()==nextDraft,L"A retained reply flyout refreshed/rebased the replacement reply or entered its write guard.");
    // The matching, newly mounted menu must still reach the original handler.
    // These fictional proposal IDs have no stored suggestion; its local GET
    // must finish with the retained draft intact, without preparing or sending.
    // More diagnostics: fixed observations only; the original callbacks,
    // invocation, wait, assertion and deadline positions remain below.
    struct MoreSnapshot {
        bool captured=false,readFailed=false,current=false,live=false,closing=false,memoryMatches=false,ownerMatches=false;
        bool shellGenerationMatches=false,shellSectionMatches=false,reviewScopeMatches=false;
        bool moreMatches=false,moreLoaded=false,moreSized=false,moreEnabled=false,moreRootMatches=false;
        bool itemLoaded=false,itemSized=false,itemEnabled=false,itemRootMatches=false;
        bool generationMatches=false,selectionMatches=false,scopeMatches=false,selectedMatches=false,connected=false,kindReply=false,detailsOpen=false;
        bool entryExists=false,entryOwnerMatches=false,entryKeyMatches=false,entryProposalMatches=false,draftExists=false,draftMatches=false;
        bool busy=false,writing=false,navEnabled=false,menuOpen=false,noticeExpected=false;
    };
    struct MoreProbe {
        struct Event {unsigned kind=0,phase=0;uint64_t tick=0;bool writing=false,navEnabled=false;};
        MoreSnapshot beforeInvoke,atClick,final;
        Event events[8];unsigned eventCount=0,phase=0,clicks=0,opens=0,closes=0,falseNotifications=0,trueNotifications=0,disableEdges=0,enableEdges=0;
        unsigned disabledBeforeInvoke=0;
        uint64_t origin=GetTickCount64(),invokeStart=0,waitStart=0,finalTick=0;
        bool overflow=false,traceOverflow=false,readFailed=false,previousEnabled=true;
        bool clickSenderExact=true,openSenderExact=true,closeSenderExact=true,navSenderExact=true;
    };
    auto probe=std::make_shared<MoreProbe>();probe->previousEnabled=nav.IsEnabled();
    auto increment=[probe](unsigned& value) noexcept {if(value<2)++value;else probe->overflow=true;};
    auto record=[probe](unsigned kind,bool writing,bool enabled) noexcept {
        if(probe->eventCount<8)probe->events[probe->eventCount++]={kind,probe->phase,GetTickCount64(),writing,enabled};
        else probe->traceOverflow=true;
    };
    auto probeToken=nav.RegisterPropertyChangedCallback(Control::IsEnabledProperty(),[p,nav,probe,increment,record](auto const& sender,auto const&) noexcept {
        try {
            auto control=sender.template as<Control>();auto enabled=control.IsEnabled();
            probe->navSenderExact&=sender.template try_as<NavigationView>()==nav;
            if(enabled){increment(probe->trueNotifications);if(!probe->previousEnabled)increment(probe->enableEdges);}
            else {increment(probe->falseNotifications);if(probe->previousEnabled)increment(probe->disableEdges);}
            probe->previousEnabled=enabled;record(enabled?2u:1u,p->shell->review->writing,enabled);
        }catch(...){probe->readFailed=true;}
    });
    Unregister unregisterProbe{nav,probeToken};
    auto expectedGeneration=p->generation,expectedSelection=p->selection;
    auto expectedScope=p->scope,expectedOwner=ownerOf(next),expectedKey=keyOf(next),expectedProposal=next.Stringify();
    auto expectedMemory=p->shell->review;auto expectedShellOwner=p->shell->owner;
    // End More diagnostics setup.
    auto active=p->replyMore;auto activeMenu=active.Flyout().as<MenuFlyout>();
    auto activeOpened=std::make_shared<bool>(false),activeClosed=std::make_shared<bool>(false);
    auto activeOpenEvent=activeMenu.Opened(auto_revoke,[activeOpened](auto const&,auto const&){*activeOpened=true;});
    auto activeCloseEvent=activeMenu.Closed(auto_revoke,[activeClosed](auto const&,auto const&){*activeClosed=true;});
    // More diagnostics: passive event receipts; no command is called here.
    auto openProbe=activeMenu.Opened(auto_revoke,[p,nav,activeMenu,probe,increment,record](auto const& sender,auto const&) noexcept {
        try {increment(probe->opens);probe->openSenderExact&=sender.template try_as<MenuFlyout>()==activeMenu;record(3,p->shell->review->writing,nav.IsEnabled());}
        catch(...){probe->readFailed=true;}
    });
    auto closeProbe=activeMenu.Closed(auto_revoke,[p,nav,activeMenu,probe,increment,record](auto const& sender,auto const&) noexcept {
        try {increment(probe->closes);probe->closeSenderExact&=sender.template try_as<MenuFlyout>()==activeMenu;record(4,p->shell->review->writing,nav.IsEnabled());}
        catch(...){probe->readFailed=true;}
    });
    // End More diagnostics menu observers.
    deadline=GetTickCount64()+5000;active.StartBringIntoView();p->shell->root.UpdateLayout();
    while((!active.IsLoaded() || !active.ActualWidth()) && GetTickCount64()<deadline){co_await resume_after(std::chrono::milliseconds(10));co_await ui;p->shell->root.UpdateLayout();}
    require(active.IsLoaded() && active.ActualWidth() && active.Focus(FocusState::Keyboard),L"The replacement reply More control did not mount.");
    activeMenu.ShowAt(active);while(!*activeOpened && GetTickCount64()<deadline){co_await resume_after(std::chrono::milliseconds(10));co_await ui;}
    require(*activeOpened && activeMenu.IsOpen(),L"The replacement reply flyout did not open.");
    auto activeItem=activeMenu.Items().GetAt(0).as<MenuFlyoutItem>();
    // More diagnostics: a projection of guard inputs, not a call to replyContext.
    auto snapshot=[p,nav,active,activeMenu,activeItem,probe,expectedGeneration,expectedSelection,expectedScope,expectedOwner,expectedKey,expectedProposal,expectedMemory,expectedShellOwner,nextDraft]() noexcept {
        MoreSnapshot value;
        try {
            auto memory=p->shell->review;auto entry=memory->entries.find(std::wstring(expectedKey));
            auto kind=memory->detailKinds.find(std::wstring(expectedScope));auto detail=memory->details.find(std::wstring(expectedScope));
            value.current=p->current();value.live=p->live;value.closing=p->shell->closing;value.memoryMatches=memory==expectedMemory;value.ownerMatches=p->shell->owner==expectedShellOwner;
            value.shellGenerationMatches=p->shell->generation==p->generation;value.shellSectionMatches=p->shell->section==p->kind;value.reviewScopeMatches=memory->scope==p->scope;
            value.moreMatches=p->replyMore==active;value.moreLoaded=active.IsLoaded();value.moreSized=active.ActualWidth()>0 && active.ActualHeight()>0;
            value.moreEnabled=active.IsEnabled();value.moreRootMatches=active.XamlRoot()==p->shell->root.XamlRoot();
            value.itemLoaded=activeItem.IsLoaded();value.itemSized=activeItem.ActualWidth()>0 && activeItem.ActualHeight()>0;
            value.itemEnabled=activeItem.IsEnabled();value.itemRootMatches=activeItem.XamlRoot()==p->shell->root.XamlRoot();
            value.generationMatches=p->generation==expectedGeneration;value.selectionMatches=p->selection==expectedSelection;value.scopeMatches=p->scope==expectedScope;
            value.selectedMatches=p->selectedKey==expectedKey;value.connected=p->shell->connected(expectedOwner);
            value.kindReply=kind!=memory->detailKinds.end() && kind->second==L"reply";value.detailsOpen=detail!=memory->details.end() && detail->second;
            value.entryExists=entry!=memory->entries.end();
            if(value.entryExists){auto const& current=entry->second;value.entryOwnerMatches=ownerOf(current.proposal)==expectedOwner;value.entryKeyMatches=keyOf(current.proposal)==expectedKey;
                value.entryProposalMatches=current.proposal.Stringify()==expectedProposal;value.draftExists=current.draft.Size()>0;value.draftMatches=current.draft.Stringify()==nextDraft;}
            value.busy=p->busy;value.writing=memory->writing;value.navEnabled=nav.IsEnabled();value.menuOpen=activeMenu.IsOpen();
            value.noticeExpected=p->notice && p->notice.Text()==L"No current reply is suggested for this conversation. Your edits can still be saved.";value.captured=true;
        }catch(...){value.readFailed=true;probe->readFailed=true;}
        return value;
    };
    auto activeClickProbe=activeItem.Click(auto_revoke,[probe,increment,record,snapshot,activeItem](auto const& sender,auto const&) noexcept {
        try {
            auto current=snapshot();if(!probe->clicks)probe->atClick=current;increment(probe->clicks);
            probe->clickSenderExact&=sender.template try_as<MenuFlyoutItem>()==activeItem;
            record(5,current.writing,current.navEnabled);
        }catch(...){probe->readFailed=true;}
    });
    probe->beforeInvoke=snapshot();probe->disabledBeforeInvoke=*disabled;probe->invokeStart=GetTickCount64();probe->phase=1;
    // End More diagnostics pre-Invoke receipt.
    xaml::Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(activeItem).GetPattern(xaml::Automation::Peers::PatternInterface::Invoke).as<xaml::Automation::Provider::IInvokeProvider>().Invoke();
    deadline=GetTickCount64()+5000;
    // More diagnostics: observe the original post-Invoke deadline without resetting it.
    probe->waitStart=deadline-5000;probe->phase=2;
    // End More diagnostics wait marker.
    while((!*disabled || !*activeClosed || p->shell->review->writing) && GetTickCount64()<deadline){co_await resume_after(std::chrono::milliseconds(10));co_await ui;}
    // More diagnostics: the original assertion is preserved inside this wrapper.
    probe->finalTick=GetTickCount64();probe->final=snapshot();
    try {
    require(*disabled==1 && *activeClosed && !activeMenu.IsOpen() && !p->shell->review->writing && p->shell->navigation.IsEnabled()
        && p->selectedKey==keyOf(next) && p->shell->review->entries.at(std::wstring(keyOf(next))).draft.Stringify()==nextDraft,
        L"The current reply More action was blocked or did not retain the fictional draft after its local lookup.");
    }catch(...) {
        auto resultCode=hresult{E_FAIL};hstring message=L"The current reply More assertion could not be evaluated.";bool evaluationFailed=false;
        try {throw;}catch(hresult_error const& error){resultCode=error.code();message=error.message();}catch(...){evaluationFailed=true;}
        auto encode=[](MoreSnapshot const& value) {
            Json json;
            for(auto const& [name,flag]:{std::pair{L"captured",value.captured},{L"readFailed",value.readFailed},{L"current",value.current},{L"live",value.live},{L"closing",value.closing},
                {L"memoryMatches",value.memoryMatches},{L"ownerMatches",value.ownerMatches},{L"shellGenerationMatches",value.shellGenerationMatches},{L"shellSectionMatches",value.shellSectionMatches},{L"reviewScopeMatches",value.reviewScopeMatches},
                {L"moreMatches",value.moreMatches},{L"moreLoaded",value.moreLoaded},{L"moreSized",value.moreSized},{L"moreEnabled",value.moreEnabled},{L"moreRootMatches",value.moreRootMatches},
                {L"itemLoaded",value.itemLoaded},{L"itemSized",value.itemSized},{L"itemEnabled",value.itemEnabled},{L"itemRootMatches",value.itemRootMatches},
                {L"generationMatches",value.generationMatches},{L"selectionMatches",value.selectionMatches},{L"scopeMatches",value.scopeMatches},{L"selectedMatches",value.selectedMatches},{L"connected",value.connected},
                {L"kindReply",value.kindReply},{L"detailsOpen",value.detailsOpen},{L"entryExists",value.entryExists},{L"entryOwnerMatches",value.entryOwnerMatches},{L"entryKeyMatches",value.entryKeyMatches},
                {L"entryProposalMatches",value.entryProposalMatches},{L"draftExists",value.draftExists},{L"draftMatches",value.draftMatches},{L"busy",value.busy},{L"writing",value.writing},
                {L"navEnabled",value.navEnabled},{L"menuOpen",value.menuOpen},{L"noticeExpected",value.noticeExpected}})json.Insert(name,Value::CreateBooleanValue(flag));
            return json;
        };
        Json receipt;receipt.Insert(L"beforeInvoke",encode(probe->beforeInvoke));receipt.Insert(L"atFirstClick",encode(probe->atClick));receipt.Insert(L"final",encode(probe->final));
        for(auto const& [name,value]:{std::pair{L"staleClicks",*invoked},{L"disabled",*disabled},{L"disabledBeforeInvoke",probe->disabledBeforeInvoke},
            {L"activeClicks",probe->clicks},{L"openedEvents",probe->opens},{L"closedEvents",probe->closes},{L"falseNotifications",probe->falseNotifications},
            {L"trueNotifications",probe->trueNotifications},{L"disableEdges",probe->disableEdges},{L"enableEdges",probe->enableEdges}})receipt.Insert(name,Value::CreateNumberValue(value));
        for(auto const& [name,flag]:{std::pair{L"combinedScope",expectedScope==L"all"},{L"proposalOwnersSame",ownerOf(first)==expectedOwner},{L"activeOpened",*activeOpened},{L"activeClosed",*activeClosed},
            {L"disabledExactlyOne",*disabled==1},{L"menuClosed",!probe->final.menuOpen},{L"notWriting",!probe->final.writing},{L"navEnabled",probe->final.navEnabled},
            {L"selectedMatches",probe->final.selectedMatches},{L"draftMatches",probe->final.draftMatches},{L"observationReadFailed",probe->readFailed},{L"counterOverflow",probe->overflow},{L"traceOverflow",probe->traceOverflow},
            {L"clickSenderExact",probe->clickSenderExact},{L"openSenderExact",probe->openSenderExact},{L"closeSenderExact",probe->closeSenderExact},{L"navSenderExact",probe->navSenderExact},
            {L"deadlineExpired",probe->finalTick>=deadline},{L"assertionEvaluationFailed",evaluationFailed},{L"invokeToWaitSaturated",probe->waitStart-probe->invokeStart>5001},
            {L"noticeBecameExpected",probe->beforeInvoke.captured && probe->final.captured && !probe->beforeInvoke.noticeExpected && probe->final.noticeExpected}})
            receipt.Insert(name,Value::CreateBooleanValue(flag));
        JsonArray trace;
        for(unsigned i=0;i<probe->eventCount;++i){auto const& event=probe->events[i];auto elapsed=event.tick-probe->origin;Json value;
            value.Insert(L"kind",Value::CreateNumberValue(event.kind));value.Insert(L"phase",Value::CreateNumberValue(event.phase));
            value.Insert(L"elapsedMs",Value::CreateNumberValue(static_cast<double>(std::min<uint64_t>(elapsed,10001))));value.Insert(L"elapsedSaturated",Value::CreateBooleanValue(elapsed>10001));
            value.Insert(L"beforeDeadline",Value::CreateBooleanValue(event.tick<deadline));value.Insert(L"writing",Value::CreateBooleanValue(event.writing));value.Insert(L"navEnabled",Value::CreateBooleanValue(event.navEnabled));trace.Append(value);}
        receipt.Insert(L"events",trace);
        receipt.Insert(L"invokeToWaitMs",Value::CreateNumberValue(static_cast<double>(std::min<uint64_t>(probe->waitStart-probe->invokeStart,5001))));
        receipt.Insert(L"waitElapsedMs",Value::CreateNumberValue(static_cast<double>(std::min<uint64_t>(probe->finalTick-probe->waitStart,5001))));
        // v2 compact receipt survives the observed 512-character error boundary.
        // c: disabled, disabledBeforeInvoke, activeClicks, false/trueNotifications,
        //    disable/enableEdges, openedEvents, closedEvents (counts saturate at 2).
        // p: disabledExactlyOne, activeClosed, menuClosed, notWriting, navEnabled,
        //    selectedMatches, draftMatches (the seven original assertion terms).
        // f: observationReadFailed, counterOverflow, traceOverflow, finalCaptured,
        //    finalReadFailed, assertionEvaluationFailed, deadlineExpired,
        //    invokeToWaitSaturated, clickSenderExact, combinedScope, activeOpened,
        //    noticeBecameExpected, atFirstClickCaptured. Boolean entries are 0/1.
        // g: beforeInvoke, atFirstClick, final; bit order is the existing verbose
        // encoder order: captured, readFailed, current, live, closing,
        // memoryMatches, ownerMatches, shellGenerationMatches, shellSectionMatches,
        // reviewScopeMatches, moreMatches, moreLoaded, moreSized, moreEnabled,
        // moreRootMatches, itemLoaded, itemSized, itemEnabled, itemRootMatches,
        // generationMatches, selectionMatches, scopeMatches, selectedMatches,
        // connected, kindReply, detailsOpen, entryExists, entryOwnerMatches,
        // entryKeyMatches, entryProposalMatches, draftExists, draftMatches, busy,
        // writing, navEnabled, menuOpen, noticeExpected (least significant first).
        auto guardMask=[](MoreSnapshot const& value) {
            uint64_t result=0,bit=1;
            for(bool flag:{value.captured,value.readFailed,value.current,value.live,value.closing,value.memoryMatches,value.ownerMatches,
                value.shellGenerationMatches,value.shellSectionMatches,value.reviewScopeMatches,value.moreMatches,value.moreLoaded,value.moreSized,value.moreEnabled,value.moreRootMatches,
                value.itemLoaded,value.itemSized,value.itemEnabled,value.itemRootMatches,value.generationMatches,value.selectionMatches,value.scopeMatches,value.selectedMatches,value.connected,
                value.kindReply,value.detailsOpen,value.entryExists,value.entryOwnerMatches,value.entryKeyMatches,value.entryProposalMatches,value.draftExists,value.draftMatches,value.busy,
                value.writing,value.navEnabled,value.menuOpen,value.noticeExpected}){if(flag)result|=bit;bit<<=1;}
            return result;
        };
        Json compact;compact.Insert(L"v",Value::CreateNumberValue(2));JsonArray counts,predicates,flags,guards;
        for(auto value:{*disabled,probe->disabledBeforeInvoke,probe->clicks,probe->falseNotifications,probe->trueNotifications,probe->disableEdges,probe->enableEdges,probe->opens,probe->closes})counts.Append(Value::CreateNumberValue(value));
        for(bool value:{*disabled==1,*activeClosed,!probe->final.menuOpen,!probe->final.writing,probe->final.navEnabled,probe->final.selectedMatches,probe->final.draftMatches})predicates.Append(Value::CreateNumberValue(value?1:0));
        for(bool value:{probe->readFailed,probe->overflow,probe->traceOverflow,probe->final.captured,probe->final.readFailed,evaluationFailed,probe->finalTick>=deadline,probe->waitStart-probe->invokeStart>5001,probe->clickSenderExact,expectedScope==L"all",*activeOpened,probe->beforeInvoke.captured && probe->final.captured && !probe->beforeInvoke.noticeExpected && probe->final.noticeExpected,probe->atClick.captured})flags.Append(Value::CreateNumberValue(value?1:0));
        for(auto const* value:{&probe->beforeInvoke,&probe->atClick,&probe->final})guards.Append(Value::CreateNumberValue(static_cast<double>(guardMask(*value))));
        compact.Insert(L"c",counts);compact.Insert(L"p",predicates);compact.Insert(L"f",flags);compact.Insert(L"g",guards);
        throw hresult_error(resultCode,compact.Stringify()+L" "+message+L" "+receipt.Stringify());
    }
    // End More diagnostics failure wrapper.
}
}

IAsyncAction reviewPage(std::shared_ptr<Shell> shell,hstring kind) {
    auto p=std::make_shared<Page>(); p->shell=shell; p->kind=kind; p->scope=shell->review->scope; p->generation=++shell->generation; shell->section=kind;
    if(p->scope!=L"all" && !shell->connected(p->scope)) { p->scope=L"all"; shell->review->scope=L"all"; }
    p->selectedKey=shell->review->selections[std::wstring(p->scope)];
    Grid root; root.Margin(xaml::Thickness{20,16,20,16});
    for(unsigned i=0;i<4;++i){ RowDefinition row; row.Height(GridLengthHelper::FromValueAndType(i==3 ? 1:0,i==3 ? GridUnitType::Star:GridUnitType::Auto)); root.RowDefinitions().Append(row); }
    auto header=stack(8); header.Orientation(Orientation::Horizontal); words(header,kind==L"today" ? L"Today":L"Reply suggestions",26);
    MenuFlyout housekeeping;
    housekeeping.Items().Append(menuItem(L"Reload saved results",[weak=std::weak_ptr<Page>(p)]{if(auto page=weak.lock();page && page->current())refresh(page);}));
    if(kind==L"today") {
        MenuFlyoutSubItem summarize; summarize.Text(L"Generate a summary…");
        xaml::Automation::AutomationProperties::SetAutomationId(summarize,L"review.summarize");
        auto choices=summaryMailboxMenu(p);while(choices.Items().Size()){auto item=choices.Items().GetAt(0);choices.Items().RemoveAt(0);summarize.Items().Append(item);}
        summarize.IsEnabled(summarize.Items().Size()!=0);housekeeping.Items().Append(summarize);
    }
    auto more=actionMenu(L"More",housekeeping,kind==L"today" ? L"Today summary and saved-result actions" : L"Reply suggestion saved-result actions");
    xaml::Automation::AutomationProperties::SetAutomationId(more,L"review.more");header.Children().Append(more);
    root.Children().Append(header);
    auto tabs=stack(7); tabs.Orientation(Orientation::Horizontal); words(tabs,L"Review mailbox:",12); std::vector<hstring> owners{L"all"}; for(auto const& value:array(shell->state,L"accounts")) owners.push_back(text(value.GetObject(),L"id"));
    for(auto const& owner:owners) {
        controls::Primitives::ToggleButton tab; tab.Content(box_value(owner==L"all" ? hstring(L"All accounts"):owner)); tab.IsChecked(owner==p->scope); tab.IsTabStop(owner==p->scope);
        xaml::Automation::AutomationProperties::SetAutomationId(tab,L"review.scope."+owner);
        tab.Checked([weak=std::weak_ptr<Page>(p),owner](auto const&,auto const&){if(auto page=weak.lock();page&&page->current()&&!page->shell->review->writing&&page->scope!=owner){page->shell->review->scope=owner;reviewPage(page->shell,page->kind);}});
        tab.Unchecked([weak=std::weak_ptr<Page>(p),owner](auto const& sender,auto const&){if(auto page=weak.lock();page&&page->current()&&page->scope==owner)sender.template as<controls::Primitives::ToggleButton>().IsChecked(true);});
        tab.KeyDown([weak=std::weak_ptr<Page>(p),owners,owner](auto const&,xaml::Input::KeyRoutedEventArgs const& args){
            if(auto page=weak.lock();page && page->current() && !page->shell->review->writing) {
                auto found=std::find(owners.begin(),owners.end(),owner); auto index=static_cast<int>(found-owners.begin());
                if(args.Key()==VirtualKey::Left) index=std::max(0,index-1); else if(args.Key()==VirtualKey::Right) index=std::min(static_cast<int>(owners.size())-1,index+1); else if(args.Key()==VirtualKey::Home) index=0; else if(args.Key()==VirtualKey::End) index=static_cast<int>(owners.size())-1; else return;
                page->shell->review->scope=owners[static_cast<size_t>(index)]; args.Handled(true); reviewPage(page->shell,page->kind);
            }
        });
        if(owner==p->scope) tab.Loaded([weak=std::weak_ptr<Page>(p)](auto const& sender,auto const&){ if(auto page=weak.lock();page && page->current()) sender.template as<controls::Primitives::ToggleButton>().Focus(xaml::FocusState::Programmatic); });
        xaml::Automation::AutomationProperties::SetName(tab,L"Review mailbox: "+owner); tabs.Children().Append(tab);
    }
    ScrollViewer tabScroll; tabScroll.HorizontalScrollBarVisibility(ScrollBarVisibility::Auto); tabScroll.VerticalScrollBarVisibility(ScrollBarVisibility::Disabled); tabScroll.Content(tabs); Grid::SetRow(tabScroll,1); root.Children().Append(tabScroll);
    auto notice=label(L"Loading saved results…",12); p->notice=notice; Grid::SetRow(notice,2); root.Children().Append(notice);
    Grid columns; p->columns=columns; Grid::SetRow(columns,3); root.Children().Append(columns);
    auto queue=stack(12); queue.Margin(xaml::Thickness{0,14,14,0}); p->queue=queue; auto list=stack(14); list.Children().Append(queue); ContentControl options; p->optionsHost=options; list.Children().Append(options); p->listScroll=rememberScroll(p,list,kind+L":list:"+p->scope); columns.Children().Append(p->listScroll);
    Grid detail; RowDefinition content; content.Height(GridLengthHelper::FromValueAndType(1,GridUnitType::Star)); RowDefinition actions; actions.Height(GridLengthHelper::FromValueAndType(0,GridUnitType::Auto)); detail.RowDefinitions().Append(content); detail.RowDefinitions().Append(actions);
    ContentControl host; host.HorizontalContentAlignment(xaml::HorizontalAlignment::Stretch); host.VerticalContentAlignment(xaml::VerticalAlignment::Stretch); host.Content(label(L"Choose a suggestion to view the original message and edit its account-owned reply.")); p->detailHost=host; detail.Children().Append(host); p->detail=detail; columns.Children().Append(detail);
    {
        xaml::Input::KeyboardAccelerator save; save.Key(VirtualKey::S); save.Modifiers(VirtualKeyModifiers::Control); save.Invoked([weak=std::weak_ptr<Page>(p)](auto const&,auto const& args){ if(auto page=weak.lock();page && page->current()) { saveDraft(page); args.Handled(true); } }); root.KeyboardAccelerators().Append(save);
        xaml::Input::KeyboardAccelerator send; send.Key(VirtualKey::Enter); send.Modifiers(VirtualKeyModifiers::Control); send.Invoked([weak=std::weak_ptr<Page>(p)](auto const&,auto const& args){ if(auto page=weak.lock();page && page->current()) { reviewSend(page); args.Handled(true); } }); root.KeyboardAccelerators().Append(send);
    }
    columns.SizeChanged([weak=std::weak_ptr<Page>(p)](auto const&,auto const&){if(auto page=weak.lock()) reflow(page);});
    root.Unloaded([p](auto const&,auto const&){ p->live=false; p->columns=nullptr; p->queue=nullptr; p->editor=nullptr; p->actions=nullptr; p->listScroll=nullptr; p->detail=nullptr; p->detailHost=nullptr; p->optionsHost=nullptr; p->notice=nullptr; p->detailNotice=nullptr; p->body=nullptr; p->facts=nullptr; p->send=nullptr; p->replace=nullptr; p->refreshEvidence=nullptr; p->replyMore=nullptr; });
    root.KeyDown([weak=std::weak_ptr<Page>(p)](auto const&,xaml::Input::KeyRoutedEventArgs const& args){if(auto page=weak.lock();page && page->current() && args.Key()==VirtualKey::Escape && page->compact){ page->shell->review->details[std::wstring(page->scope)]=false; reflow(page); args.Handled(true); }});
    std::weak_ptr<Page> weak=p;
    shell->refreshReview=[weak] { if(auto page=weak.lock()) return refresh(page); return completed(); };
    mountedReview=p;shell->show(root); reflow(p);
    if(kind==L"reply-suggestions") paintQueue(p); else paintToday(p);
    co_await refresh(p); if(!p->current()) co_return;
    if((kind==L"reply-suggestions" || (shell->review->detailKinds[std::wstring(p->scope)]==L"reply" && shell->review->details[std::wstring(p->scope)])) && !p->selectedKey.empty()) {
        if(auto cached=shell->review->entries.find(std::wstring(p->selectedKey));cached!=shell->review->entries.end()) co_await selectReply(p,cached->second.proposal);
        else for(auto const& row:p->rows) if(keyOf(row)==p->selectedKey){co_await selectReply(p,row);break;}
    } else if(kind==L"today" && shell->review->detailKinds[std::wstring(p->scope)]==L"original") {
        if(auto found=shell->review->originals.find(std::wstring(p->scope));found!=shell->review->originals.end() && shell->review->details[std::wstring(p->scope)]) co_await selectOriginal(p,found->second);
    } else if(kind==L"today" && shell->review->detailKinds[std::wstring(p->scope)]==L"decision") {
        if(auto found=shell->review->decisions.find(std::wstring(p->scope));found!=shell->review->decisions.end() && shell->review->details[std::wstring(p->scope)]) showDecision(p,object(found->second,L"item"),flag(found->second,L"task"));
    }
}

IAsyncAction reviewWorkspaceChecks(std::shared_ptr<Shell> shell) {
    require(std::wstring_view(GetCommandLineW()).find(L"--native-smoke")!=std::wstring_view::npos,L"Review checks require the isolated native smoke fixture.");
    auto accounts=array(shell->state,L"accounts");if(accounts.Size()<2)co_return;
    auto owner=text(accounts.GetAt(0).GetObject(),L"id"),other=text(accounts.GetAt(1).GetObject(),L"id");
    require(std::wstring_view(owner).ends_with(L"@fixture.invalid")&&std::wstring_view(other).ends_with(L"@fixture.invalid"),L"Review checks require owned fictional accounts.");
    auto saved=shell->review;auto globalOwner=shell->owner;bool timerRunning=shell->timer&&shell->timer.IsEnabled();if(timerRunning)shell->timer.Stop();shell->review=std::make_shared<ReviewMemory>();shell->review->scope=owner;
    struct Restore {std::shared_ptr<Shell> shell;std::shared_ptr<ReviewMemory> saved;Json today;bool timerRunning;~Restore(){shell->review=saved;shell->state.Insert(L"today",today);if(timerRunning)shell->timer.Start();}} restore{shell,saved,copy(object(shell->state,L"today")),timerRunning};
    apartment_context ui;co_await reviewPage(shell,L"reply-suggestions");co_await ui;
    auto page=mountedReview.lock();require(page&&page->current(),L"The review page did not mount.");
    Json proposal,message,draft;put(proposal,L"id",L"fixture-proposal");put(proposal,L"proposalId",L"fixture-proposal");put(proposal,L"accountId",owner);put(proposal,L"messageId",L"same-id");put(proposal,L"text",L"Original proposed text");
    put(message,L"id",L"same-id");put(message,L"accountId",owner);put(message,L"subject",L"Fictional review subject");put(message,L"fromEmail",L"sender@fixture.invalid");put(message,L"body",L"Please review the fictional decision.");message.Insert(L"hasAttachments",Value::CreateBooleanValue(false));proposal.Insert(L"message",message);
    put(draft,L"accountId",owner);put(draft,L"replyToId",L"same-id");put(draft,L"to",L"sender@fixture.invalid");put(draft,L"body",L"Original proposed text");
    auto key=keyOf(proposal);auto memory=shell->review;memory->entries[std::wstring(key)]={copy(proposal),copy(message),copy(draft),copy(draft),true,false};
    co_await selectReply(page,proposal);co_await ui;require(page->body&&page->facts&&page->send,L"The original/reply editor did not mount.");
    auto ready=GetTickCount64()+5000;shell->root.UpdateLayout();
    while((!page->body.IsLoaded()||!page->body.ActualWidth())&&GetTickCount64()<ready){co_await resume_after(std::chrono::milliseconds(20));co_await ui;shell->root.UpdateLayout();}
    require(page->current()&&page->body.IsLoaded()&&page->body.ActualWidth(),L"The owned review TextBox did not load for native input.");page->body.ApplyTemplate();page->body.Text(L"User edit preserved across accounts.");
    ready=GetTickCount64()+5000;while(text(memory->entries[std::wstring(key)].draft,L"body")!=L"User edit preserved across accounts."&&GetTickCount64()<ready){co_await resume_after(std::chrono::milliseconds(20));co_await ui;}
    require(page->current(),L"The review page became obsolete during native text input.");require(text(memory->entries[std::wstring(key)].draft,L"body")==L"User edit preserved across accounts.",L"Native TextChanged did not retain the owned review text.");require(!memory->entries[std::wstring(key)].reviewed&&!page->send.IsEnabled(),L"Native text editing retained old facts approval.");
    Json changed=copy(proposal);put(changed,L"id",L"new-fixture-proposal");put(changed,L"proposalId",L"new-fixture-proposal");put(changed,L"text",L"New proposed text");Json response;put(response,L"owner",owner);JsonArray rows;rows.Append(changed);response.Insert(L"proposals",rows);memory->values[std::wstring(owner)]=response;page->queuePaint=L"force-refresh";paintQueue(page);
    require(memory->entries[std::wstring(key)].stale&&text(memory->entries[std::wstring(key)].draft,L"body")==L"User edit preserved across accounts."&&!page->send.IsEnabled(),L"A newer suggestion replaced an edit or retained approval.");
    page->columns.Width(500);shell->root.UpdateLayout();reflow(page);require(page->compact&&page->detail.Visibility()==Visibility::Visible&&page->listScroll.Visibility()==Visibility::Collapsed,L"Narrow review must show one pane.");
    memory->options[std::wstring(owner)]=Json::Parse(L"{\"dailyTokenBudget\":200000}");memory->savedOptions[std::wstring(owner)]=Json::Parse(L"{\"dailyTokenBudget\":100000}");
    auto root=shell->page.Content().as<Grid>();auto tabs=root.Children().GetAt(1).as<ScrollViewer>().Content().as<StackPanel>();
    for(auto const& tab:tabs.Children())if(xaml::Automation::AutomationProperties::GetAutomationId(tab)==L"review.scope."+other)tab.as<controls::Primitives::ToggleButton>().IsChecked(true);
    co_await resume_after(std::chrono::milliseconds(100));co_await ui;require(memory->scope==other,L"Native account selection did not change the shared scope.");
    co_await reviewPage(shell,L"today");co_await ui;require(memory->scope==other&&shell->owner==globalOwner,L"Today and Reply lost shared scope or changed the global sending mailbox.");
    memory->scope=owner;co_await reviewPage(shell,L"reply-suggestions");co_await ui;
    require(text(memory->entries[std::wstring(key)].draft,L"body")==L"User edit preserved across accounts."&&memory->selections[std::wstring(owner)]==key&&memory->options[std::wstring(owner)].GetNamedNumber(L"dailyTokenBudget")==200000&&memory->hasEdits(),L"A/B/A lost retained draft, selection or dirty budget.");
    auto back=mountedReview.lock();require(back&&back->current(),L"The returned review page did not mount.");auto& entry=memory->entries[std::wstring(key)];entry.stale=false;put(entry.draft,L"body",L"[decision needed: choose an answer]");paintEditor(back,key);back->facts.IsChecked(true);require(!back->send.IsEnabled(),L"Unanswered decision entered sending review.");
    // Mount the actual Today card and invoke it through its native peer. The
    // cached fictional draft avoids model/provider work, as in the editor checks above.
    Json today;JsonArray suggestions;suggestions.Append(proposal);today.Insert(L"replySuggestions",suggestions);shell->state.Insert(L"today",today);
    memory->details[std::wstring(owner)]=false;memory->detailKinds[std::wstring(owner)]={};
    co_await reviewPage(shell,L"today");co_await ui;auto inlinePage=mountedReview.lock();require(inlinePage&&inlinePage->current(),L"Today did not mount for inline review.");
    auto todayGeneration=shell->generation;Button review{nullptr};
    for(auto const& child:inlinePage->queue.Children())if(auto candidate=child.try_as<Button>();candidate && xaml::Automation::AutomationProperties::GetAutomationId(candidate)==L"review.today.reply."+key)review=candidate;
    require(bool(review),L"Today has no named review entry for its saved reply.");co_await invokeReviewButton(shell,review);
    ready=GetTickCount64()+5000;
    while((!inlinePage->body || !inlinePage->body.IsLoaded())&&GetTickCount64()<ready){co_await resume_after(std::chrono::milliseconds(20));co_await ui;shell->root.UpdateLayout();}
    require(inlinePage->current() && inlinePage->body && inlinePage->body.IsLoaded() && shell->section==L"today" && shell->generation==todayGeneration && shell->owner==globalOwner,
        L"Reviewing a Today reply navigated away or changed the sending mailbox.");
    require(text(entry.draft,L"body")==L"[decision needed: choose an answer]" && !inlinePage->send.IsEnabled(),L"Inline Today review replaced retained text or bypassed missing-answer approval.");
    auto retainedSend=inlinePage->send;auto retainedDraft=entry.draft.Stringify();
    Json newer=copy(proposal);put(newer,L"proposalId",L"new-today-proposal");Json updated;put(updated,L"owner",owner);JsonArray newerRows;newerRows.Append(newer);updated.Insert(L"proposals",newerRows);reconcileReply(inlinePage,updated);
    require(entry.stale && !entry.reviewed && !retainedSend.IsEnabled() && inlinePage->refreshEvidence.Visibility()==Visibility::Visible && entry.draft.Stringify()==retainedDraft,
        L"A stale Today reply lost its draft or hid evidence recovery.");
    auto retainedBody=inlinePage->body;auto retainedFacts=inlinePage->facts;
    co_await invokeReviewButton(shell,inlinePage->actions.Children().GetAt(0).as<Button>());
    require(!memory->details[std::wstring(owner)] && inlinePage->listScroll.Visibility()==Visibility::Visible,L"Back to Today did not restore the review queue.");
    Json task;put(task,L"id",L"fictional-inline-task");put(task,L"accountId",owner);put(task,L"messageId",L"same-id");put(task,L"title",L"Fictional decision retained in Today");put(task,L"detail",L"Review this saved task without changing mail.");
    JsonArray todos;todos.Append(task);today.Insert(L"todos",todos);shell->state.Insert(L"today",today);paintToday(inlinePage);
    Button taskReview{nullptr};for(auto const& child:inlinePage->queue.Children())if(auto candidate=child.try_as<Button>();candidate && xaml::Automation::AutomationProperties::GetAutomationId(candidate)==L"review.today.task."+owner+L".fictional-inline-task")taskReview=candidate;
    require(bool(taskReview),L"Today has no native Review entry for its saved task.");
    {
    struct StaleEvents {
        unsigned taskClicks=0,text=0,matchingText=0,facts=0,checkedFacts=0;
        bool textSender=true,textCurrent=true,textIdle=true,textKey=true,textBody=true,textReply=true,textClosed=true;
        bool textOwned=true,textLoaded=true,textSized=true,textBeforeTask=true,textDraft=true,textUnreviewed=true;
        bool taskSender=true,factsSender=true,factsAfterTask=true,textInTime=true,taskInTime=true,factsInTime=true;
    };
    auto events=std::make_shared<StaleEvents>();
    auto count=[](unsigned& value){if(value<16)++value;};
    auto taskClick=taskReview.Click(auto_revoke,[&,events,count,taskReview](auto const& sender,auto const&){
        count(events->taskClicks);events->taskSender&=sender.template try_as<Button>()==taskReview;events->taskInTime&=GetTickCount64()<ready;
    });
    auto expectedTask=task.Stringify();
    auto ownsReply=[&] {
        return inlinePage->shell==shell && shell->review==memory && memory->scope==owner && inlinePage->scope==owner && shell->owner==globalOwner
            && ownerOf(entry.proposal)==owner && text(entry.draft,L"accountId")==owner;
    };
    auto adopted=[&] {
        auto kind=memory->detailKinds.find(std::wstring(owner));auto detail=memory->details.find(std::wstring(owner));
        auto decision=memory->decisions.find(std::wstring(owner));
        return inlinePage->current() && memory->scope==owner && kind!=memory->detailKinds.end() && kind->second==L"decision"
            && detail!=memory->details.end() && detail->second && decision!=memory->decisions.end()
            && flag(decision->second,L"task") && object(decision->second,L"item").Stringify()==expectedTask;
    };
    auto receipt=[&] {
        Json value;
        value.Insert(L"taskClicks",Value::CreateNumberValue(events->taskClicks));
        value.Insert(L"textEvents",Value::CreateNumberValue(events->text));
        value.Insert(L"matchingTextEvents",Value::CreateNumberValue(events->matchingText));
        value.Insert(L"factsEvents",Value::CreateNumberValue(events->facts));
        value.Insert(L"checkedFactsEvents",Value::CreateNumberValue(events->checkedFacts));
        value.Insert(L"current",Value::CreateBooleanValue(inlinePage->current()));
        value.Insert(L"taskAdopted",Value::CreateBooleanValue(adopted()));
        value.Insert(L"selectedKeyEmpty",Value::CreateBooleanValue(inlinePage->selectedKey.empty()));
        value.Insert(L"bodyCleared",Value::CreateBooleanValue(!inlinePage->body));
        value.Insert(L"factsCleared",Value::CreateBooleanValue(!inlinePage->facts));
        value.Insert(L"draftUnchanged",Value::CreateBooleanValue(entry.draft.Stringify()==retainedDraft));
        value.Insert(L"reviewed",Value::CreateBooleanValue(entry.reviewed));
        value.Insert(L"oldBodyLoaded",Value::CreateBooleanValue(retainedBody.IsLoaded()));
        value.Insert(L"oldBodySized",Value::CreateBooleanValue(retainedBody.ActualWidth()>0 && retainedBody.ActualHeight()>0));
        value.Insert(L"oldFactsLoaded",Value::CreateBooleanValue(retainedFacts.IsLoaded()));
        value.Insert(L"deadlineExpired",Value::CreateBooleanValue(GetTickCount64()>=ready));
        for(auto const& [name,flag]:{std::pair{L"textSenderExact",events->textSender},
            {L"textCurrent",events->textCurrent},{L"textNotWriting",events->textIdle},{L"textKeyMatches",events->textKey},
            {L"textBodyMatches",events->textBody},{L"textKindReply",events->textReply},{L"textDetailsClosed",events->textClosed},
            {L"textOwnersMatch",events->textOwned},{L"textBodyLoaded",events->textLoaded},{L"textBodySized",events->textSized},
            {L"textBeforeTask",events->textBeforeTask},{L"textDraftUnchanged",events->textDraft},{L"textUnreviewed",events->textUnreviewed},
            {L"taskSenderExact",events->taskSender},{L"factsSenderExact",events->factsSender},{L"factsAfterTask",events->factsAfterTask},
            {L"textBeforeDeadline",events->textInTime},{L"taskBeforeDeadline",events->taskInTime},{L"factsBeforeDeadline",events->factsInTime}})
            value.Insert(name,Value::CreateBooleanValue(flag));
        return value.Stringify();
    };
    auto observed=[&](bool condition,wchar_t const* message){if(!condition)throw hresult_error(E_FAIL,hstring(message)+L" "+receipt());};
    // Prepare the same mounted native peer before the shared event budget.
    // Invoking it below must not start another helper's five-second mount wait.
    auto mountDeadline=GetTickCount64()+5000;taskReview.StartBringIntoView();shell->root.UpdateLayout();
    while((!taskReview.IsLoaded() || !taskReview.ActualWidth() || !taskReview.ActualHeight()) && GetTickCount64()<mountDeadline) {
        co_await resume_after(std::chrono::milliseconds(10));co_await ui;shell->root.UpdateLayout();
    }
    require(taskReview.IsLoaded() && taskReview.ActualWidth() && taskReview.ActualHeight() && taskReview.Focus(FocusState::Keyboard),
        L"The stale-input task action did not become a focusable mounted native button.");
    auto taskPeer=xaml::Automation::Peers::FrameworkElementAutomationPeer::CreatePeerForElement(taskReview);
    auto taskInvoke=taskPeer.GetPattern(xaml::Automation::Peers::PatternInterface::Invoke).as<xaml::Automation::Provider::IInvokeProvider>();
    hstring staleText=L"An obsolete editor must not update a task or retained reply.";
    auto changedEvent=retainedBody.TextChanged(auto_revoke,[&,events,count,staleText,retainedBody](auto const& sender,auto const&){
        count(events->text);auto target=sender.template try_as<TextBox>();events->textSender&=target==retainedBody;
        if(target && target.Text()==staleText) {
            count(events->matchingText);
            auto kind=memory->detailKinds.find(std::wstring(owner));auto detail=memory->details.find(std::wstring(owner));
            events->textCurrent&=inlinePage->current();events->textIdle&=!memory->writing;
            events->textKey&=inlinePage->selectedKey==key;events->textBody&=inlinePage->body==target;
            events->textReply&=kind!=memory->detailKinds.end() && kind->second==L"reply";
            events->textClosed&=detail!=memory->details.end() && !detail->second;events->textOwned&=ownsReply();
            events->textLoaded&=target.IsLoaded();events->textSized&=target.ActualWidth()>0 && target.ActualHeight()>0;
            events->textBeforeTask&=!events->taskClicks && !adopted();events->textDraft&=entry.draft.Stringify()==retainedDraft;
            events->textUnreviewed&=!entry.reviewed;events->textInTime&=GetTickCount64()<ready;
        }
    });
    auto checkedEvent=retainedFacts.Checked(auto_revoke,[&,events,count,retainedFacts](auto const& sender,auto const&){
        count(events->facts);auto target=sender.template try_as<CheckBox>();events->factsSender&=target==retainedFacts;
        if(target && checked(target)) {
            count(events->checkedFacts);events->factsAfterTask&=events->taskClicks>0 && adopted()
                && inlinePage->selectedKey.empty() && !inlinePage->body && !inlinePage->facts && ownsReply()
                && entry.draft.Stringify()==retainedDraft && !entry.reviewed;events->factsInTime&=GetTickCount64()<ready;
        }
    });
    // Back closed the reply scope without replacing its loaded controls. Prove
    // an actual matching native TextChanged is rejected by the details guard.
    // No post-task/unloaded TextChanged delivery is assumed or claimed.
    ready=GetTickCount64()+5000;
    observed(GetTickCount64()<ready && inlinePage->current() && !memory->writing && ownsReply()
        && inlinePage->selectedKey==key && inlinePage->body==retainedBody && inlinePage->facts==retainedFacts
        && memory->detailKinds[std::wstring(owner)]==L"reply" && !memory->details[std::wstring(owner)]
        && retainedBody.IsLoaded() && retainedBody.ActualWidth()>0 && retainedBody.ActualHeight()>0
        && retainedBody.Text()!=staleText && !events->taskClicks && entry.draft.Stringify()==retainedDraft && !entry.reviewed
        && !checked(retainedFacts),L"Back did not retain the loaded reply with only its details guard revoked.");
    observed(GetTickCount64()<ready,L"The stale reply text assignment exceeded the shared deadline.");
    retainedBody.Text(staleText);
    while(!events->matchingText && GetTickCount64()<ready){co_await resume_after(std::chrono::milliseconds(10));co_await ui;}
    observed(GetTickCount64()<ready && events->matchingText>0 && events->textSender && events->textCurrent && events->textIdle
        && events->textKey && events->textBody && events->textReply && events->textClosed && events->textOwned
        && events->textLoaded && events->textSized && events->textBeforeTask && events->textDraft && events->textUnreviewed && events->textInTime
        && !events->taskClicks && entry.draft.Stringify()==retainedDraft && !entry.reviewed,
        L"The closed loaded reply did not deliver unchanged, account-owned native text input.");
    observed(GetTickCount64()<ready,L"The native task action exceeded the shared stale-input deadline.");
    taskInvoke.Invoke();
    while((!adopted() || !events->taskClicks) && GetTickCount64()<ready){co_await resume_after(std::chrono::milliseconds(10));co_await ui;}
    observed(GetTickCount64()<ready && adopted() && events->taskClicks==1 && events->taskSender && events->taskInTime,
        L"The native task action did not adopt its captured decision after closed-reply input.");
    observed(inlinePage->selectedKey.empty() && !inlinePage->body && !inlinePage->facts && ownsReply()
        && entry.draft.Stringify()==retainedDraft && !entry.reviewed,L"Task review did not revoke the reply controls while retaining its draft and approval.");
    observed(GetTickCount64()<ready && !checked(retainedFacts),L"The retained facts control was not reset within the shared stale-input deadline.");
    retainedFacts.IsChecked(true);
    while(!events->checkedFacts && GetTickCount64()<ready){co_await resume_after(std::chrono::milliseconds(10));co_await ui;}
    observed(GetTickCount64()<ready && events->checkedFacts>0 && events->factsSender && events->factsAfterTask && events->factsInTime,
        L"The detached reply facts control did not deliver native checked input after task adoption.");
    observed(GetTickCount64()<ready && adopted() && inlinePage->selectedKey.empty() && !inlinePage->body && !inlinePage->facts && ownsReply()
        && entry.draft.Stringify()==retainedDraft && !entry.reviewed,L"A detached reply control changed the retained draft or approval from task review.");
    }
    co_await reviewPage(shell,L"today");co_await ui;inlinePage=mountedReview.lock();
    require(inlinePage && inlinePage->current() && memory->detailKinds[std::wstring(owner)]==L"decision" && inlinePage->selectedKey.empty() && !inlinePage->body,L"Returning to Today restored an unrelated reply or original instead of its selected task.");
    auto decision=inlinePage->detailHost.Content().as<ScrollViewer>().Content().as<StackPanel>();
    require(decision.Children().GetAt(0).as<TextBlock>().Text()==text(task,L"title"),L"Today did not retain the captured task detail.");
    co_await invokeReviewButton(shell,decision.Children().GetAt(decision.Children().Size()-1).as<Button>());
    // Re-open the same reply through its mounted card before checking scope revocation.
    review=nullptr;for(auto const& child:inlinePage->queue.Children())if(auto candidate=child.try_as<Button>();candidate && xaml::Automation::AutomationProperties::GetAutomationId(candidate)==L"review.today.reply."+key)review=candidate;
    require(bool(review),L"Returning from task detail lost the saved reply entry.");co_await invokeReviewButton(shell,review);
    require(inlinePage->body && !inlinePage->send.IsEnabled() && entry.draft.Stringify()==retainedDraft,L"Returning from task review lost the stale reply guard or retained text.");
    auto inlineTabs=shell->page.Content().as<Grid>().Children().GetAt(1).as<ScrollViewer>().Content().as<StackPanel>();
    for(auto const& tab:inlineTabs.Children())if(xaml::Automation::AutomationProperties::GetAutomationId(tab)==L"review.scope."+other)tab.as<controls::Primitives::ToggleButton>().IsChecked(true);
    ready=GetTickCount64()+5000;while(memory->scope!=other&&GetTickCount64()<ready){co_await resume_after(std::chrono::milliseconds(20));co_await ui;}
    require(memory->scope==other && !inlinePage->current() && shell->section==L"today" && shell->owner==globalOwner,L"Today account switching left the prior detail current.");
    co_await reviewSend(inlinePage);require(!shell->dialogOpen && entry.draft.Stringify()==retainedDraft,L"An obsolete Today review opened sending or modified its draft.");
    // Both replies have cached fictional drafts. No preparation or model call
    // is needed to exercise A -> B and combined-scope duplicate message IDs.
    for(bool combined:{false,true}) {
        auto nextOwner=combined ? other : owner;auto nextMessage=copy(message);put(nextMessage,L"accountId",nextOwner);put(nextMessage,L"id",combined ? L"same-id" : L"second-fixture-message");
        auto nextProposal=copy(proposal);put(nextProposal,L"accountId",nextOwner);put(nextProposal,L"messageId",text(nextMessage,L"id"));put(nextProposal,L"proposalId",L"second-fixture-proposal");nextProposal.Insert(L"message",nextMessage);
        auto nextDraft=copy(draft);put(nextDraft,L"accountId",nextOwner);put(nextDraft,L"replyToId",text(nextMessage,L"id"));put(nextDraft,L"body",L"Retained second fictional reply.");
        memory->entries[std::wstring(keyOf(nextProposal))]={copy(nextProposal),copy(nextMessage),copy(nextDraft),copy(nextDraft),false,false};
        Json menuToday;JsonArray cards;cards.Append(proposal);cards.Append(nextProposal);menuToday.Insert(L"replySuggestions",cards);shell->state.Insert(L"today",menuToday);
        memory->scope=combined ? hstring(L"all") : owner;memory->details[std::wstring(memory->scope)]=false;memory->detailKinds[std::wstring(memory->scope)]={};
        co_await reviewPage(shell,L"today");co_await ui;auto menuPage=mountedReview.lock();Button first{nullptr};
        for(auto const& child:menuPage->queue.Children())if(auto candidate=child.try_as<Button>();candidate && xaml::Automation::AutomationProperties::GetAutomationId(candidate)==L"review.today.reply."+key)first=candidate;
        require(bool(first),L"The stale-flyout fixture lost its first Today card.");co_await invokeReviewButton(shell,first);
        co_await staleReplyFlyoutChecks(menuPage,proposal,nextProposal);
    }
    // Synthetic transfer through the same commit operation used after the
    // full authenticated refresh. Existing persisted draft data is a separate
    // value and is never passed to the cleanup operation.
    ReviewMemory moved;auto old=copy(draft);put(old,L"id",L"old-persisted-fixture-draft");auto persisted=copy(old);
    auto edited=copy(old);put(edited,L"body",L"Retain this edit on the later message.");
    moved.entries[std::wstring(key)]={copy(proposal),copy(message),copy(edited),copy(old),true,true};
    moved.selections[std::wstring(owner)]=key;moved.selections[L"all"]=key;moved.scrolls[std::wstring(L"reply-detail:"+key)]=180;
    auto fresh=copy(proposal);put(fresh,L"messageId",L"later-fixture-message");auto newKey=keyOf(fresh);auto newDraft=copy(edited);newDraft.Remove(L"id");put(newDraft,L"replyToId",L"later-fixture-message");
    moved.moveEntry(key,newKey,{copy(fresh),copy(message),copy(newDraft),copy(draft),false,false});
    require(!moved.entries.contains(std::wstring(key))&&moved.entries.size()==1&&moved.selections[std::wstring(owner)]==newKey&&moved.selections[L"all"]==newKey&&moved.scrolls[std::wstring(L"reply-detail:"+newKey)]==180,L"Refresh retained an obsolete workspace key or selection.");
    require(moved.hasEdits()&&text(moved.entries[std::wstring(newKey)].draft,L"body")==L"Retain this edit on the later message.",L"Refresh lost the retained edit.");
    moved.entries[std::wstring(newKey)].saved=copy(moved.entries[std::wstring(newKey)].draft);
    require(!moved.hasEdits()&&persisted.Stringify()==old.Stringify(),L"Saving the moved entry left ghost edits or changed the old persisted draft.");
    moved.moveEntry(newKey,newKey,moved.entries[std::wstring(newKey)]);require(moved.entries.size()==1&&!moved.hasEdits(),L"Same-key refresh erased its workspace.");
}
}
