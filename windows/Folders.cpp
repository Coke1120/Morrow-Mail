#include "pch.h"
#include "Ui.h"
#include <winrt/Microsoft.UI.Xaml.Automation.h>
#include <winrt/Windows.System.h>
#include <map>

namespace morrow {
using namespace winrt;
using namespace Windows::Foundation;
using namespace Windows::Data::Json;
using namespace xaml;
using namespace controls;
namespace {
bool matches(hstring const& name, hstring const& query) {
    return query.empty() || FindStringOrdinal(FIND_FROMSTART, name.c_str(), static_cast<int>(name.size()), query.c_str(), static_cast<int>(query.size()), TRUE) >= 0;
}
bool within(Json const& child, Json const& source, JsonArray const& folders) {
    auto id = text(child, L"id"); auto sourceId = text(source, L"id");
    if (sourceId.empty()) return false;
    std::set<std::wstring> seen;
    while (!id.empty() && seen.insert(std::wstring(id)).second) {
        if (id == sourceId) return true;
        hstring parent;
        for (auto const& value : folders) if (text(value.GetObject(), L"id") == id) { parent = text(value.GetObject(), L"parentId"); break; }
        id = parent;
    }
    auto delimiter = text(source,L"delimiter");
    return !delimiter.empty() && std::wstring_view(text(child,L"name")).starts_with(std::wstring(text(source,L"name") + delimiter));
}
bool canParent(Json const& folder, hstring const& provider) {
    auto kind = text(folder,L"kind");
    return folder.Size() && !flag(folder,L"hidden") && kind != L"spam" && kind != L"trash" && kind != L"virtual" && (provider != L"google" || flag(folder,L"editable"));
}
struct FolderChoice {
    DropDownButton control;
    TextBox search;
    ListView list;
    Flyout popup;
    TextBlock empty;
    JsonArray folders;
    hstring id;
    std::function<void()> changed, create;
    void filter() {
        list.Items().Clear();
        for (auto const& value : folders) {
            auto folder = value.GetObject(); if (!matches(text(folder,L"name"), search.Text())) continue;
            ListViewItem row; row.Content(label(text(folder,L"name"),14,false)); row.Tag(folder);
            Automation::AutomationProperties::SetName(row, text(folder,L"name"));
            list.Items().Append(row); if (text(folder,L"id") == id) list.SelectedItem(row);
        }
        empty.Visibility(list.Items().Size() ? Visibility::Collapsed : Visibility::Visible);
    }
    void set(JsonArray const& values, hstring selected) {
        folders = values; id = selected;
        hstring title = L"Choose…";
        for (auto const& value : folders) if (text(value.GetObject(),L"id") == id) title = text(value.GetObject(),L"name");
        control.Content(box_value(title)); filter();
    }
    void choose(ListViewItem const& row) {
        if (!row) return;
        auto folder = row.Tag().as<Json>(); id = text(folder,L"id"); control.Content(box_value(text(folder,L"name"))); popup.Hide();
        if (changed) changed();
    }
};
std::shared_ptr<FolderChoice> folderChoice(hstring const& title, JsonArray const& folders, hstring const& id = {}) {
    auto picker = std::make_shared<FolderChoice>(); std::weak_ptr<FolderChoice> weak = picker;
    picker->control.HorizontalAlignment(HorizontalAlignment::Stretch);
    Automation::AutomationProperties::SetName(picker->control, title);
    picker->search.PlaceholderText(L"Search names or paths…");
    Automation::AutomationProperties::SetName(picker->search, L"Search " + title);
    picker->list.SelectionMode(ListViewSelectionMode::Single); picker->list.IsItemClickEnabled(true); picker->list.MaxHeight(260);
    auto content = stack(10); content.Width(380); content.Children().Append(picker->search); content.Children().Append(picker->list);
    picker->empty = label(L"No matching labels or folders.",12); content.Children().Append(picker->empty);
    auto create=button(L"Create new label / folder…",[weak] { if(auto state=weak.lock();state&&state->create) { state->popup.Hide(); state->create(); } }); create.Visibility(Visibility::Collapsed); content.Children().Append(create);
    picker->popup.Content(content); picker->control.Flyout(picker->popup);
    picker->search.TextChanged([weak](auto const&,auto const&) { if (auto state=weak.lock()) state->filter(); });
    picker->list.ItemClick([weak](auto const&,ItemClickEventArgs const& e) { if(auto state=weak.lock()) state->choose(clickedListItem(state->list,e.ClickedItem())); });
    auto keyboard = [weak](auto const&,Input::KeyRoutedEventArgs const& e) {
        if(auto state=weak.lock()) {
            using Key=Windows::System::VirtualKey;
            if(e.Key()==Key::Escape) { state->popup.Hide(); e.Handled(true); }
            else if(e.Key()==Key::Enter) {
                if(state->list.SelectedIndex()<0 && state->list.Items().Size()) state->list.SelectedIndex(0);
                state->choose(state->list.SelectedItem().try_as<ListViewItem>()); e.Handled(true);
            } else if(e.Key()==Key::Down || e.Key()==Key::Up) {
                auto count=static_cast<int32_t>(state->list.Items().Size());
                if(count) { state->list.SelectedIndex(std::clamp(state->list.SelectedIndex()+(e.Key()==Key::Down?1:-1),0,count-1)); state->list.ScrollIntoView(state->list.SelectedItem()); }
                e.Handled(true);
            }
        }
    };
    picker->search.KeyDown(keyboard); picker->list.KeyDown(keyboard);
    picker->popup.Opened([weak,create](auto const&,auto const&) { if(auto state=weak.lock()) { create.Visibility(state->create?Visibility::Visible:Visibility::Collapsed); state->search.Text(L""); state->filter(); state->search.Focus(FocusState::Programmatic); } });
    picker->set(folders,id); return picker;
}
JsonArray destinations(Json const& catalog, bool google) {
    JsonArray result;
    for(auto const& value:array(catalog,L"folders")) { auto folder=value.GetObject(); if(!flag(folder,L"hidden") && (!folder.HasKey(L"selectable") || flag(folder,L"selectable")) && text(folder,L"id")!=L"__archive") result.Append(value); }
    if(google) { Json archive; put(archive,L"id",L"__archive"); put(archive,L"name",L"Archive (remove Inbox)"); put(archive,L"kind",L"archive"); result.Append(archive); }
    return result;
}
struct FolderManager {
    ContentDialog dialog;
    TextBox search, name;
    TreeView tree;
    TextBlock selectedName, status;
    CheckBox useForMessage;
    std::shared_ptr<FolderChoice> parent;
    Json catalog, source;
    hstring provider;
    int action=0;
    bool creationOnly=false, refreshing=false, configuring=false;
    std::vector<std::pair<TreeViewNode,Json>> nodes;
    std::vector<Button> edits;
    Button child, create;
    void enabled() {
        bool writable=flag(catalog,L"canManage");
        for(auto const& button:edits) button.IsEnabled(writable && flag(source,L"editable"));
        child.IsEnabled(writable && canParent(source,provider)); create.IsEnabled(writable);
        dialog.IsPrimaryButtonEnabled(writable && (action==0 || flag(source,L"editable")) && (action>1 || !name.Text().empty()));
    }
    void configure(bool reset=true) {
        configuring=true;
        selectedName.Text(action==0?L"Create new label / folder":text(source,L"name",L"Choose a label or folder"));
        name.Visibility(action<2?Visibility::Visible:Visibility::Collapsed);
        parent->control.Visibility(action==0||action==2?Visibility::Visible:Visibility::Collapsed);
        if(reset) name.Text(action==0?L"":text(source,L"leafName",text(source,L"name")));
        JsonArray choices; Json root; put(root,L"name",L"Mailbox root"); choices.Append(root);
        for(auto const& value:array(catalog,L"folders")) { auto folder=value.GetObject(); if(canParent(folder,provider) && (action==0||!within(folder,source,array(catalog,L"folders")))) choices.Append(value); }
        parent->set(choices, reset ? (action==0?hstring{}:text(source,L"parentId")) : parent->id);
        if(!flag(catalog,L"canManage")) status.Text(L"Reconnect in Settings → Mail accounts and approve mail write permission.");
        else if(action==3) status.Text(L"Delete this label/folder from the account. Review its effect on messages and children before applying.");
        else if(action!=0 && source.Size() && !flag(source,L"editable")) status.Text(L"System or unavailable folders cannot be changed.");
        else status.Text(L"Provider changes are reviewed before applying. Cached mail and local drafts are retained.");
        configuring=false; enabled();
    }
    void select(TreeViewNode const& node) {
        if(configuring) return;
        for(auto const& pair:nodes) if(pair.first==node) { source=pair.second; action=1; configure(); break; }
    }
    void rebuild() {
        configuring=true; tree.RootNodes().Clear(); nodes.clear();
        std::vector<Json> folders;
        for(auto const& value:array(catalog,L"folders")) { auto folder=value.GetObject(); if(matches(text(folder,L"name"),search.Text())) folders.push_back(folder); }
        std::sort(folders.begin(),folders.end(),[](Json const& a,Json const& b) { return CompareStringOrdinal(text(a,L"name").c_str(),-1,text(b,L"name").c_str(),-1,TRUE)==CSTR_LESS_THAN; });
        for(auto const& folder:folders) {
            bool hasParent=!text(folder,L"parentId").empty() && std::any_of(folders.begin(),folders.end(),[&](auto const& other) { return text(other,L"id")==text(folder,L"parentId"); });
            TreeViewNode node; node.Content(box_value(search.Text().empty()&&hasParent?text(folder,L"leafName",text(folder,L"name")):text(folder,L"name"))); node.IsExpanded(true); nodes.emplace_back(node,folder);
        }
        // ponytail: at most 1,000 provider labels; index nodes if that bound grows.
        for(auto const& pair:nodes) {
            auto parent=std::find_if(nodes.begin(),nodes.end(),[&](auto const& candidate) { return !text(pair.second,L"parentId").empty() && text(candidate.second,L"id")==text(pair.second,L"parentId") && !within(candidate.second,pair.second,array(catalog,L"folders")); });
            if(search.Text().empty() && parent!=nodes.end()) parent->first.Children().Append(pair.first); else tree.RootNodes().Append(pair.first);
            if(text(pair.second,L"id")==text(source,L"id")) tree.SelectedNode(pair.first);
        }
        configuring=false;
    }
};
}
MenuFlyout Shell::organizationMenu(Json message) {
    MenuFlyout menu; auto account=text(message,L"accountId"); auto remote=text(message,L"remoteId",text(message,L"id"));
    bool google=std::wstring_view(remote).starts_with(L"google:");
    bool imported=google||std::wstring_view(remote).starts_with(L"microsoft:")||std::wstring_view(remote).starts_with(L"imap:");
    auto add=[&](hstring const& title,hstring kind) { MenuFlyoutItem item; item.Text(title); item.IsEnabled(imported&&!flag(message,L"providerFolderMissing")); item.Click([weak=weak_from_this(),message,kind](auto const&,auto const&) { if(auto self=weak.lock()) self->organize(message,kind); }); menu.Items().Append(item); };
    add(L"Move to…",{}); if(google) add(L"Labels…",L"labels"); add(google?L"Create new label…":L"Create new folder…",L"create");
    MenuFlyoutItem manage; manage.Text(google?L"Manage labels…":L"Manage folders…"); manage.Click([weak=weak_from_this(),account](auto const&,auto const&) { if(auto self=weak.lock()) self->manageFolders(account); }); menu.Items().Append(manage);
    return menu;
}
IAsyncOperation<Json> Shell::manageFolders(hstring account, hstring initialFolder, bool creationOnly) {
    auto lifetime=shared_from_this(); auto version=generation; auto captured=owner;
    if(closing||dialogOpen||loading||!service||service->writing()||!connected(account)||!dirty.empty()) co_return Json();
    try {
        auto state=std::make_shared<FolderManager>(); std::weak_ptr<FolderManager> weak=state;
        auto cache=object(serverFolders,account.c_str()); state->catalog=Json::Parse(cache.Stringify()); state->catalog.Insert(L"folders",array(cache,L"managementFolders"));
        if(!array(state->catalog,L"folders").Size()) {
            loading=true; state->catalog=co_await service->request(L"/mail/folders/manage",account); loading=false;
            if(!current(version,captured)||!connected(account)) co_return Json();
            if(text(state->catalog,L"accountId")!=account) throw hresult_error(E_FAIL,L"The folder owner could not be confirmed.");
        }
        state->provider=text(state->catalog,L"provider"); state->creationOnly=creationOnly;
        for(auto const& value:array(state->catalog,L"folders")) if(text(value.GetObject(),L"id")==initialFolder) { state->source=value.GetObject(); state->action=1; }
        auto content=stack(12); content.Children().Append(label(account));
        Grid body; body.ColumnSpacing(20);
        if(!creationOnly) { ColumnDefinition left; left.Width(GridLengthHelper::FromPixels(260)); body.ColumnDefinitions().Append(left); }
        body.ColumnDefinitions().Append(ColumnDefinition());
        auto treePanel=stack(10); state->search.PlaceholderText(L"Search names or paths…"); Automation::AutomationProperties::SetName(state->search,L"Search managed labels and folders");
        state->tree.SelectionMode(TreeViewSelectionMode::Single); state->tree.Height(280); Automation::AutomationProperties::SetName(state->tree,L"Labels and folders hierarchy");
        state->tree.SelectionChanged([weak](auto const&,auto const&) { if(auto state=weak.lock()) state->select(state->tree.SelectedNode()); });
        state->search.TextChanged([weak](auto const&,auto const&) { if(auto state=weak.lock()) state->rebuild(); });
        treePanel.Children().Append(state->search); treePanel.Children().Append(state->tree);
        state->create=button(L"Create at mailbox root…",[weak] { if(auto state=weak.lock()) { state->source=Json(); state->action=0; state->configure(); } }); treePanel.Children().Append(state->create);
        if(!creationOnly) body.Children().Append(treePanel);
        auto details=stack(14); details.MinWidth(300); details.Children().Append(state->selectedName);
        StackPanel actions; actions.Orientation(Orientation::Horizontal); actions.Spacing(8);
        for(auto const& choice:{std::pair{L"Rename",1},{L"Move…",2},{L"Delete…",3}}) {
            auto edit=button(choice.first,[weak,action=choice.second] { if(auto state=weak.lock()) { state->action=action; state->configure(); } }); state->edits.push_back(edit); actions.Children().Append(edit);
        }
        if(!creationOnly) details.Children().Append(actions);
        state->child=button(L"Create child…",[weak] { if(auto state=weak.lock()) { auto id=text(state->source,L"id"); state->action=0; state->configure(); state->parent->set(state->parent->folders,id); } });
        if(!creationOnly) details.Children().Append(state->child);
        state->name=field(L"Name"); state->name.MaxLength(255); state->name.TextChanged([weak](auto const&,auto const&) { if(auto state=weak.lock()) state->enabled(); }); details.Children().Append(state->name);
        state->parent=folderChoice(L"Parent",JsonArray()); details.Children().Append(state->parent->control);
        if(creationOnly) { state->useForMessage.Content(box_value(L"Select this label / folder for the email after creation")); state->useForMessage.IsChecked(true); details.Children().Append(state->useForMessage); }
        details.Children().Append(state->status); Grid::SetColumn(details,creationOnly?0:1); body.Children().Append(details); content.Children().Append(body);
        auto refresh=button(L"Refresh",[weak] { if(auto state=weak.lock()) { state->refreshing=true; state->dialog.Hide(); } }); content.Children().Append(refresh);
        state->dialog.XamlRoot(root.XamlRoot()); state->dialog.Title(box_value(creationOnly?L"Create label / folder":state->provider==L"google"?L"Manage Gmail labels":L"Manage server folders"));
        state->dialog.Resources().Insert(box_value(L"ContentDialogMaxWidth"),box_value(900.0)); state->dialog.Content(scroll(content)); state->dialog.PrimaryButtonText(L"Review change"); state->dialog.CloseButtonText(L"Close"); state->dialog.DefaultButton(ContentDialogButton::Close);
        MenuFlyout menu;
        for(auto const& choice:{std::pair{L"Rename selected…",1},{L"Move selected to another parent…",2},{L"Delete selected from account…",3}}) { MenuFlyoutItem item; item.Text(choice.first); item.Click([weak,action=choice.second](auto const&,auto const&) { if(auto state=weak.lock(); state&&flag(state->source,L"editable")&&flag(state->catalog,L"canManage")) { state->action=action; state->configure(); } }); menu.Items().Append(item); }
        state->tree.ContextRequested([weak](auto const&,Input::ContextRequestedEventArgs const& e) { if(auto state=weak.lock()) { auto element=e.OriginalSource().try_as<DependencyObject>(); while(element) { if(auto item=element.try_as<TreeViewItem>()) { state->tree.SelectedNode(state->tree.NodeFromContainer(item)); state->select(state->tree.SelectedNode()); break; } element=Media::VisualTreeHelper::GetParent(element); } } });
        MenuFlyoutItem child; child.Text(L"Create child…"); child.Click([weak](auto const&,auto const&) { if(auto state=weak.lock(); state&&canParent(state->source,state->provider)&&flag(state->catalog,L"canManage")) { auto id=text(state->source,L"id"); state->action=0; state->configure(); state->parent->set(state->parent->folders,id); } }); menu.Items().Append(child);
        menu.Opening([weak,weakMenu=make_weak(menu),child](auto const&,auto const&) { if(auto state=weak.lock()) if(auto menu=weakMenu.get()) { for(auto const& value:menu.Items()) value.as<MenuFlyoutItem>().IsEnabled(flag(state->catalog,L"canManage") && (value==child?canParent(state->source,state->provider):flag(state->source,L"editable"))); } });
        state->tree.ContextFlyout(menu); state->rebuild(); state->configure();
        while(current(version,captured)&&connected(account)) {
            dialogOpen=true; ContentDialogResult decision;
            try { decision=co_await state->dialog.ShowAsync(); } catch(...) { dialogOpen=false; throw; } dialogOpen=false;
            if(!current(version,captured)||!connected(account)) co_return Json();
            if(state->refreshing) {
                state->refreshing=false;
                try { loading=true; state->catalog=co_await service->request(L"/mail/folders/manage",account); loading=false; if(text(state->catalog,L"accountId")!=account) throw hresult_error(E_FAIL,L"The owning folder list could not be confirmed."); state->rebuild(); state->configure(false); } catch(...) { loading=false; state->status.Text(errorText()); }
                continue;
            }
            if(decision!=ContentDialogResult::Primary) co_return Json();
            try {
                wchar_t const* actions[]={L"create",L"rename",L"move",L"delete"}; auto action=hstring(actions[state->action]);
                Json body; put(body,L"operation",action); put(body,L"id",text(state->source,L"id")); put(body,L"name",state->name.Text()); put(body,L"parentId",state->parent->id);
                loading=true; auto preview=co_await service->request(L"/mail/folders/preview",account,L"POST",body); loading=false;
                if(!current(version,captured)) co_return Json();
                if(text(preview,L"accountId")!=account||text(preview,L"previewId").empty()) throw hresult_error(E_FAIL,L"The folder review could not be confirmed.");
                auto plan=object(preview,L"plan"); auto detail=account+L"\n"+text(plan,L"sourceName")+L" → "+text(plan,L"name")+L"\nAffected labels/folders: "+to_hstring(plan.GetNamedNumber(L"affectedCount",1))+L"\n"+text(plan,L"impact");
                if(plan.HasKey(L"messageCount")&&plan.GetNamedValue(L"messageCount").ValueType()==JsonValueType::Number) detail=detail+L"\nMessages in selected folder: "+to_hstring(plan.GetNamedNumber(L"messageCount"));
                if(!(co_await confirm(L"Apply this provider change?",detail,action==L"delete"?L"Delete on provider":L"Apply change"))) continue;
                if(!current(version,captured)) co_return Json();
                Json apply; put(apply,L"previewId",text(preview,L"previewId")); apply.Insert(L"confirmed",Value::CreateBooleanValue(true));
                loading=true; auto changed=co_await service->request(L"/mail/folders/apply",account,L"POST",apply); loading=false;
                if(text(changed,L"accountId")!=account) throw hresult_error(E_FAIL,L"The changed folder owner could not be confirmed. Refresh before another review.");
                changed.Insert(L"managementFolders",array(changed,L"folders")); changed.Insert(L"folders",destinations(changed,false)); changed.Insert(L"canManage",Value::CreateBooleanValue(true)); serverFolders.Insert(account,changed);
                if(!current(version,captured)) co_return Json();
                if(owner==account) for(auto const& value:array(changed,L"changes")) { auto change=value.GetObject(); if(folder==L"provider:"+text(change,L"oldId")) { folder=text(change,L"newId").empty()?L"inbox":L"provider:"+text(change,L"newId"); break; } }
                rebuildNavigation(); for(auto& cursor:cursors) cursor=L""; if(section==L"mail") co_await loadPage();
                state->catalog=Json::Parse(changed.Stringify()); state->catalog.Insert(L"folders",array(changed,L"managementFolders"));
                if(action==L"create"&&creationOnly) { Json created; for(auto const& value:array(state->catalog,L"folders")) if(text(value.GetObject(),L"name")==text(plan,L"name")) created=value.GetObject(); Json result; result.Insert(L"created",created); result.Insert(L"useForMessage",Value::CreateBooleanValue(state->useForMessage.IsChecked().Value())); co_return result; }
                state->source=Json(); state->action=0; state->rebuild(); state->configure(); state->status.Text(L"Provider label/folder change confirmed.");
            } catch(...) { loading=false; state->status.Text(errorText()); }
        }
    } catch(...) { loading=false; dialogOpen=false; error(errorText()); }
    co_return Json();
}
namespace {
struct MailFolders {
    ContentDialog dialog;
    ComboBox mode;
    TextBox search;
    ListView labels;
    TextBlock status;
    std::shared_ptr<FolderChoice> destination;
    JsonArray folders;
    std::set<std::wstring> baseline, selected;
    bool google=false, managing=false, creating=false;
    void enabled() {
        dialog.IsPrimaryButtonEnabled(mode.SelectedIndex()==1 ? selected!=baseline : !destination->id.empty());
    }
    void filter(std::weak_ptr<MailFolders> weak) {
        labels.Items().Clear();
        for(auto const& value:folders) {
            auto folder=value.GetObject(); if(text(folder,L"kind")!=L"label"||!matches(text(folder,L"name"),search.Text())) continue;
            auto id=std::wstring(text(folder,L"id")); CheckBox check; check.Content(label(text(folder,L"name"),14,false)); check.IsChecked(selected.contains(id));
            Automation::AutomationProperties::SetName(check,text(folder,L"name"));
            check.Click([weak,id,weakCheck=make_weak(check)](auto const&,auto const&) { if(auto state=weak.lock()) if(auto check=weakCheck.get()) { if(check.IsChecked().Value()) state->selected.insert(id); else state->selected.erase(id); state->enabled(); } });
            labels.Items().Append(check);
        }
    }
    void configure(std::weak_ptr<MailFolders> weak) {
        bool labeling=mode.SelectedIndex()==1;
        search.Visibility(labeling?Visibility::Visible:Visibility::Collapsed); labels.Visibility(labeling?Visibility::Visible:Visibility::Collapsed);
        destination->control.Visibility(labeling?Visibility::Collapsed:Visibility::Visible); filter(weak); enabled();
    }
    Json payload() const {
        Json result; put(result,L"mode",mode.SelectedIndex()==1?L"labels":L"move"); result.Insert(L"confirmed",Value::CreateBooleanValue(true));
        if(mode.SelectedIndex()==1) {
            JsonArray add,remove;
            for(auto const& id:selected) if(!baseline.contains(id)) add.Append(Value::CreateStringValue(id));
            for(auto const& id:baseline) if(!selected.contains(id)) remove.Append(Value::CreateStringValue(id));
            result.Insert(L"addLabelIds",add); result.Insert(L"removeLabelIds",remove);
        } else put(result,L"destinationId",destination->id);
        return result;
    }
    hstring review() const {
        auto names=[&](bool adding) {
            hstring result;
            for(auto const& value:folders) { auto folder=value.GetObject(); auto id=std::wstring(text(folder,L"id"));
                if(adding ? selected.contains(id)&&!baseline.contains(id) : baseline.contains(id)&&!selected.contains(id)) result=result+(result.empty()?hstring{}:hstring(L", "))+text(folder,L"name");
            }
            return result;
        };
        if(mode.SelectedIndex()==1) return L"Add: "+names(true)+L"\nRemove from this email: "+names(false);
        for(auto const& value:folders) if(text(value.GetObject(),L"id")==destination->id) return L"Move to: "+text(value.GetObject(),L"name");
        return L"Choose a destination.";
    }
};
}
IAsyncAction Shell::organize(Json message, hstring preferredKind, hstring preferredDestination) {
    if(preferredKind==L"trash") { co_await trash(message); co_return; }
    auto lifetime=shared_from_this(); auto version=generation; auto captured=owner;
    auto sequence=selectionGeneration; auto account=text(message,L"accountId");
    if(closing||dialogOpen||loading||!service||service->writing()||!connected(account)||!dirty.empty()||flag(message,L"providerFolderMissing")) co_return;
    try {
        auto state=std::make_shared<MailFolders>(); std::weak_ptr<MailFolders> weak=state;
        auto catalog=object(serverFolders,account.c_str());
        state->google=std::wstring_view(text(message,L"remoteId",text(message,L"id"))).starts_with(L"google:");
        if(!array(catalog,L"folders").Size()) { loading=true; catalog=co_await service->request(L"/mail/folders",account); loading=false; if(text(catalog,L"accountId")!=account) throw hresult_error(E_FAIL,L"The owning folder list could not be confirmed."); }
        if(!current(version,captured)||sequence!=selectionGeneration) co_return;
        if(state->google) {
            auto detail=message;
            if(!message.HasKey(L"providerLabelIds")) { auto result=co_await service->request(L"/messages/"+escaped(text(message,L"id")),account); detail=object(result,L"message"); }
            if(text(detail,L"id")!=text(message,L"id")||text(detail,L"accountId")!=account) throw hresult_error(E_FAIL,L"The email owner could not be confirmed.");
            for(auto const& id:array(detail,L"providerLabelIds")) state->baseline.insert(std::wstring(id.GetString())); state->selected=state->baseline;
        }
        if(!current(version,captured)||sequence!=selectionGeneration||dialogOpen) co_return;
        state->folders=destinations(catalog,state->google); state->destination=folderChoice(L"Move destination",state->folders,preferredDestination);
        state->destination->changed=[weak] { if(auto state=weak.lock()) state->enabled(); };
        state->destination->create=[weak] { if(auto state=weak.lock()) { state->creating=true; state->dialog.Hide(); } };
        auto content=stack(12); content.Children().Append(label(account+L"\n"+text(message,L"subject")));
        state->mode.Items().Append(box_value(L"Move to")); if(state->google) state->mode.Items().Append(box_value(L"Labels on this email")); state->mode.SelectedIndex(preferredKind==L"labels"&&state->google?1:0);
        if(state->google) content.Children().Append(state->mode);
        state->search.PlaceholderText(L"Search label names or paths…"); Automation::AutomationProperties::SetName(state->search,L"Search email labels");
        state->labels.SelectionMode(ListViewSelectionMode::None); state->labels.MaxHeight(240);
        content.Children().Append(state->search); content.Children().Append(state->labels); content.Children().Append(state->destination->control);
        content.Children().Append(label(state->google?L"Checking applies labels to this email; unchecking removes them from this email only. Move removes Inbox while retaining other labels. Spam / Trash are provider moves.":L"Move this email to the selected folder within the account shown above.",12));
        if(state->google || text(catalog,L"provider")==L"microsoft") content.Children().Append(button(L"Open provider for reporting / blocking",[google=state->google] { Windows::System::Launcher::LaunchUriAsync(Uri(google?L"https://mail.google.com/":L"https://outlook.live.com/mail/")); }));
        content.Children().Append(button(state->google?L"Manage labels…":L"Manage folders…",[weak] { if(auto state=weak.lock()) { state->managing=true; state->dialog.Hide(); } })); content.Children().Append(state->status);
        state->dialog.XamlRoot(root.XamlRoot()); state->dialog.Title(box_value(L"Organize email on provider")); state->dialog.Content(scroll(content)); state->dialog.PrimaryButtonText(L"Review change"); state->dialog.CloseButtonText(L"Cancel"); state->dialog.SecondaryButtonText(state->google?L"Create new label…":L"Create new folder…"); state->dialog.DefaultButton(ContentDialogButton::Close);
        state->mode.SelectionChanged([weak](auto const&,auto const&) { if(auto state=weak.lock()) state->configure(weak); });
        state->search.TextChanged([weak](auto const&,auto const&) { if(auto state=weak.lock()) state->filter(weak); }); state->configure(weak);
        bool creating=preferredKind==L"create";
        while(current(version,captured)&&sequence==selectionGeneration&&connected(account)) {
            ContentDialogResult decision=ContentDialogResult::Secondary;
            if(!creating) { dialogOpen=true; try { decision=co_await state->dialog.ShowAsync(); } catch(...) { dialogOpen=false; throw; } dialogOpen=false; }
            creating=false;
            if(!current(version,captured)||sequence!=selectionGeneration||!connected(account)) co_return;
            if(state->managing||state->creating||decision==ContentDialogResult::Secondary) {
                bool manage=state->managing; state->managing=false; state->creating=false;
                auto result=co_await manageFolders(account,{},!manage);
                if(!current(version,captured)||sequence!=selectionGeneration) co_return;
                auto saved=object(serverFolders,account.c_str()); if(array(saved,L"folders").Size()) state->folders=destinations(saved,state->google);
                auto created=object(result,L"created");
                if(created.Size() && flag(result,L"useForMessage")) { if(state->google) { state->mode.SelectedIndex(1); state->selected.insert(std::wstring(text(created,L"id"))); } else preferredDestination=text(created,L"id"); }
                state->destination->set(state->folders,preferredDestination.empty()?state->destination->id:preferredDestination); state->configure(weak); continue;
            }
            if(decision!=ContentDialogResult::Primary) co_return;
            try {
                auto body=state->payload(); auto detail=account+L"\n"+text(message,L"subject")+L"\n"+state->review();
                if(!(co_await confirm(L"Apply this provider change?",detail,L"Apply provider change"))) continue;
                if(!current(version,captured)||sequence!=selectionGeneration) co_return;
                auto updated=co_await service->request(L"/messages/"+escaped(text(message,L"id"))+L"/organize",account,L"POST",body);
                if(!current(version,captured)||sequence!=selectionGeneration) co_return;
                auto moved=object(updated,L"message");
                if(text(moved,L"accountId")!=account||text(moved,L"id")!=text(message,L"id")) throw hresult_error(E_FAIL,L"The message owner changed. Refresh your mailbox.");
                if(text(selected,L"accountId")==account&&text(selected,L"id")==text(message,L"id")) { selected=moved; renderReader(selected); }
                for(auto& cursor:cursors) cursor=L""; co_await loadPage(); co_return;
            } catch(...) { state->status.Text(errorText()); }
        }
    } catch(...) { loading=false; dialogOpen=false; error(errorText()); }
}
IAsyncAction folderPickerChecks(Grid host) {
    apartment_context ui;
    auto check=[](bool condition,wchar_t const* message) { if(!condition) throw hresult_error(E_FAIL,message); };
    Json root,child; put(root,L"id",L"root"); put(root,L"name",L"Work"); root.Insert(L"editable",Value::CreateBooleanValue(true)); put(root,L"kind",L"label");
    put(child,L"id",L"child"); put(child,L"name",L"Work / Customer"); put(child,L"parentId",L"root"); put(child,L"leafName",L"Customer"); child.Insert(L"editable",Value::CreateBooleanValue(true)); put(child,L"kind",L"label");
    JsonArray folders; folders.Append(root); folders.Append(child);
    auto picker=folderChoice(L"Test destination",folders,L"child");
    auto originalFocus=Input::FocusManager::GetFocusedElement(host.XamlRoot()).try_as<Control>();
    picker->control.HorizontalAlignment(HorizontalAlignment::Left); picker->control.VerticalAlignment(VerticalAlignment::Top);
    bool opened=false; auto openedToken=picker->popup.Opened([&opened](auto const&,auto const&) { opened=true; });
    host.Children().Append(picker->control); host.UpdateLayout(); picker->popup.ShowAt(picker->control);
    auto deadline=GetTickCount64()+1000;
    while(!opened&&GetTickCount64()<deadline) { co_await resume_after(std::chrono::milliseconds(10)); co_await ui; }
    picker->popup.Opened(openedToken); check(opened,L"The native folder picker did not open.");
    // TextChanged is asynchronous; allow the native event to update the list.
    picker->search.Text(L"CUSTOMER"); co_await resume_after(std::chrono::milliseconds(50)); co_await ui;
    check(picker->list.Items().Size()==1&&picker->id==L"child",L"Folder search lost case-insensitive path matching or selection.");
    picker->search.Text(L"no match"); co_await resume_after(std::chrono::milliseconds(50)); co_await ui;
    check(!picker->list.Items().Size()&&picker->id==L"child",L"Filtering cleared the chosen folder.");
    picker->search.Text(L""); co_await resume_after(std::chrono::milliseconds(50)); co_await ui;
    check(picker->list.Items().Size()==2&&within(child,root,folders)&&!within(root,child,folders),L"Folder hierarchy or filter restoration failed.");
    bool closed=false; auto closedToken=picker->popup.Closed([&closed](auto const&,auto const&) { closed=true; });
    picker->popup.Hide(); deadline=GetTickCount64()+1000;
    while(!closed&&GetTickCount64()<deadline) { co_await resume_after(std::chrono::milliseconds(10)); co_await ui; }
    picker->popup.Closed(closedToken); check(closed,L"The native folder picker did not close.");
    if(originalFocus&&originalFocus.IsLoaded()) originalFocus.Focus(FocusState::Programmatic);
    uint32_t index; if(host.Children().IndexOf(picker->control,index)) host.Children().RemoveAt(index);
    Json orphan; put(orphan,L"id",L"orphan"); put(orphan,L"name",L"Other/Leaf"); put(orphan,L"leafName",L"Leaf"); put(orphan,L"parentId",L"missing"); folders.Append(orphan);
    auto manager=std::make_shared<FolderManager>(); manager->catalog.Insert(L"folders",folders); manager->catalog.Insert(L"canManage",Value::CreateBooleanValue(true)); manager->provider=L"google"; manager->source=root; manager->action=2; manager->parent=folderChoice(L"Test parent",JsonArray()); manager->rebuild(); manager->configure();
    check(manager->tree.RootNodes().Size()==2 && unbox_value<hstring>(manager->tree.RootNodes().GetAt(0).Content())==L"Other/Leaf" && manager->tree.RootNodes().GetAt(1).Children().Size()==1,L"Folder tree lost hierarchy or implicit-parent full paths.");
    for(auto const& value:manager->parent->folders) check(text(value.GetObject(),L"id")!=L"root"&&text(value.GetObject(),L"id")!=L"child",L"Parent picker offered the selected folder or a descendant.");
    auto state=std::make_shared<MailFolders>(); state->folders=folders; state->baseline={L"INBOX",L"old"}; state->selected={L"INBOX",L"new"}; state->mode.Items().Append(box_value(L"Move")); state->mode.Items().Append(box_value(L"Labels")); state->mode.SelectedIndex(1);
    auto payload=state->payload(); check(array(payload,L"addLabelIds").Size()==1&&array(payload,L"removeLabelIds").Size()==1&&array(payload,L"addLabelIds").GetAt(0).GetString()==L"new"&&array(payload,L"removeLabelIds").GetAt(0).GetString()==L"old",L"Email labels were not submitted as deltas preserving Inbox.");
}
}
