import SwiftUI
import AppKit

// Scene-owned review state, independent of the globally selected reading mailbox.
@MainActor final class ReviewWorkspaceState: ObservableObject {
    @Published var scope = "all"
    @Published var values: [String: JSON] = [:]
    @Published var options: [String: JSON] = [:]
    @Published var errors: [String: String] = [:]
    @Published var loading = Set<String>()
    @Published var selection: [String: String] = [:]
    @Published var drafts: [String: Draft] = [:]
    @Published var messages: [String: JSON] = [:]
    @Published var proposals: [String: JSON] = [:]
    @Published var savedPayloads: [String: JSON] = [:]
    @Published var reviewedFacts = Set<String>()
    @Published var stale = Set<String>()
    @Published var preparing = Set<String>()
    @Published var writing = false
    @Published var detailVisible: [String: Bool] = [:]
    @Published var originalSelection: [String: JSON] = [:]
    @Published var originals: [String: JSON] = [:]
    var scrollPositions: [String: CGFloat] = [:]
    private var revisions: [String: Int] = [:]
    var hasEdits: Bool { drafts.contains { key, value in savedPayloads[key] != value.payload } || options.contains { owner, value in values[owner]?["settings"] != value } }
    func owner(_ proposal: JSON) -> String { proposal["accountId"].nonempty ? proposal["accountId"].string : proposal["message"]["accountId"].string }
    func key(_ proposal: JSON) -> String { owner(proposal) + "\n" + proposal["messageId"].string }
    func proposalID(_ proposal: JSON) -> String { proposal["proposalId"].nonempty ? proposal["proposalId"].string : proposal.id }
    func queue(_ model: AppModel) -> [JSON] {
        var rows = values[scope]?["proposals"].array ?? model.state["today"]["replySuggestions"].array.filter { scope == "all" || owner($0) == scope }
        if let selected = selection[scope], let retained = proposals[selected], drafts[selected] != nil,
           !rows.contains(where: { key($0) == selected }), model.accounts.contains(where: { $0.id == owner(retained) }) { rows.append(retained) }
        return rows
    }
    func selected(_ model: AppModel) -> JSON? {
        let rows = queue(model)
        return rows.first { key($0) == selection[scope] } ?? rows.first
    }
    func pickScope(_ owner: String) { guard !writing else { return }; scope = owner }
    func show(_ proposal: JSON) {
        let key=key(proposal); selection[scope]=key; detailVisible[scope]=true
        if drafts[key] != nil, let previous=proposals[key], (proposalID(previous) != proposalID(proposal) || previous["text"] != proposal["text"]) { stale.insert(key); reviewedFacts.remove(key) }
        else if drafts[key] == nil { proposals[key]=proposal }
    }
    func load(_ owner: String, model: AppModel) async {
        let revision = (revisions[owner] ?? 0) + 1; revisions[owner] = revision
        if values[owner] == nil { loading.insert(owner) }
        defer { if revisions[owner] == revision { loading.remove(owner) } }
        do {
            let next = try await model.request("/reply-suggestions", mailbox: owner)
            guard !Task.isCancelled, revisions[owner] == revision else { return }
            guard next["owner"].string == owner, next["proposals"].array.allSatisfy({ proposal in
                model.accounts.contains { $0.id == self.owner(proposal) } && (owner == "all" || self.owner(proposal) == owner) && proposal["message"]["accountId"].string == self.owner(proposal)
            }) else { throw APIError("The suggestion mailbox could not be verified.") }
            if owner != "all", options[owner] == nil || options[owner] == values[owner]?["settings"] { options[owner] = next["settings"] }
            values[owner] = next; errors[owner] = nil
            for (key, previous) in proposals where drafts[key] != nil && (owner == "all" || self.owner(previous) == owner) {
                let matched = next["proposals"].array.first { self.key($0) == key }
                if (matched != nil || !next["limited"].bool) && (matched == nil || matched?["text"] != previous["text"] || matched.map(proposalID) != proposalID(previous)) { stale.insert(key); reviewedFacts.remove(key) }
            }
        } catch { if !Task.isCancelled, revisions[owner] == revision { errors[owner] = error.localizedDescription } }
    }
    func showOriginal(_ source: JSON, model: AppModel) async {
        let owner=source["accountId"].string, id=source.id
        let key="original:"+owner+"\n"+id
        guard !owner.isEmpty, !id.isEmpty, model.accounts.contains(where: { $0.id == owner }) else { return }
        originalSelection[scope] = source; loading.insert(key); errors[key] = nil
        defer { loading.remove(key) }
        do {
            let next=try await model.request("/messages/"+encodedPath(id),mailbox:owner)
            guard !Task.isCancelled, next["message"]["accountId"].string == owner, next["message"].id == id,
                  model.accounts.contains(where: { $0.id == owner }) else { throw APIError("The original message mailbox changed.") }
            originals[key]=next["message"]
        } catch { if !Task.isCancelled { errors[key]=error.localizedDescription } }
    }
    func saveOptions(_ owner: String, model: AppModel) {
        guard let next=options[owner], !writing else { return }
        if next["automatic"].bool && !model.confirm("Automatically check this mailbox for replies?",detail:"\(owner) · \(values[owner]?["model"]["model"].string ?? "")\nUp to \(Int(next["dailyTokenBudget"].number)) estimated tokens per UTC day while Morrow is open. Only permitted correspondence is used. Provider charges may apply. Mail is never sent automatically.") { return }
        writing=true
        model.perform {
            defer { self.writing=false }
            do {
                let result=try await model.request("/reply-suggestions/settings",method:"POST",body:next,mailbox:owner)
                guard result["owner"].string == owner else { throw APIError("The saved setting mailbox could not be verified.") }
                self.values[owner]=result; self.options[owner]=result["settings"]; self.errors[owner]=nil
            } catch { self.errors[owner]=error.localizedDescription }
        }
    }
    func inspect(_ proposal: JSON, model: AppModel, replace: Bool = false) async {
        let owner = owner(proposal), key = key(proposal), id = proposal["messageId"].string
        guard !preparing.contains(key), !writing, model.accounts.contains(where: { $0.id == owner }) else { return }
        show(proposal)
        if drafts[key] != nil && messages[key] != nil && !replace { return }
        preparing.insert(key); errors[key] = nil
        defer { preparing.remove(key) }
        do {
            let response = try await model.request("/messages/" + encodedPath(id), mailbox: owner)
            let message = response["message"]
            guard !Task.isCancelled, model.accounts.contains(where: { $0.id == owner }), message["accountId"].string == owner, message.id == id else { throw APIError("The original message owner could not be verified.") }
            messages[key] = message
            let prepared = try await model.request("/drafts/prepare", method: "POST", body: .object(["messageId": .string(id), "mode": .string("reply"), "body": proposal["text"]]), mailbox: owner)
            var draft = try Draft(prepared: prepared["draft"])
            guard draft.accountID == owner, draft.replyToID == id, draft.body == proposal["text"].string, draft.bcc.isEmpty else { throw APIError("The prepared reply owner could not be verified.") }
            let latest = try await model.request("/reply-suggestions", mailbox: owner)
            guard !Task.isCancelled, latest["owner"].string == owner,
                  latest["proposals"].array.contains(where: { proposalID($0) == proposalID(proposal) && $0["messageId"].string == id && $0["text"] == proposal["text"] && $0["message"]["accountId"].string == owner }) else { throw APIError("This suggestion changed. Your edits have been retained; review a fresh suggestion.") }
            if draft.footer.isNull { draft.footer = model.state["settings"]["footer"] }
            if replace || drafts[key] == nil { drafts[key] = draft; savedPayloads[key] = draft.payload; reviewedFacts.remove(key) }
            proposals[key] = proposal; stale.remove(key)
        } catch { if !Task.isCancelled { errors[key] = error.localizedDescription } }
    }
    func save(_ key: String, model: AppModel) {
        guard let draft = drafts[key], !writing, model.accounts.contains(where: { $0.id == draft.accountID }) else { return }
        writing = true; errors[key] = nil
        model.perform {
            defer { self.writing = false }
            do {
                let next = try await model.request("/drafts", method: "POST", body: draft.payload, mailbox: draft.accountID)
                guard next["message"]["accountId"].string == draft.accountID, next["message"]["replyToId"].string == draft.replyToID, next["message"].id.nonEmptyString else { throw APIError("The saved draft owner could not be verified.") }
                var saved = draft; saved.savedID = next["message"].id
                self.drafts[key] = saved; self.savedPayloads[key] = saved.payload
                try await model.reload(); model.notice = "Review draft saved in its original mailbox."
            } catch { self.errors[key] = error.localizedDescription }
        }
    }
    func refreshKeepingEdits(_ previous: JSON, fresh: JSON, model: AppModel) async {
        let oldKey=key(previous), newKey=key(fresh), owner=owner(previous), id=fresh["messageId"].string
        guard let old=drafts[oldKey], owner==self.owner(fresh), !writing, !preparing.contains(newKey), model.accounts.contains(where:{$0.id==owner}) else{return}
        preparing.insert(newKey);defer{preparing.remove(newKey)}
        do{
            let original=try await model.request("/messages/"+encodedPath(id),mailbox:owner)
            guard original["message"]["accountId"].string==owner,original["message"].id==id else{throw APIError("The latest original message owner changed.")}
            let response=try await model.request("/drafts/prepare",method:"POST",body:.object(["messageId":.string(id),"mode":.string("reply"),"body":.string(old.body)]),mailbox:owner)
            var updated=try Draft(prepared:response["draft"])
            guard updated.accountID==owner,updated.replyToID==id,updated.body==old.body,updated.bcc.isEmpty else{throw APIError("The refreshed reply owner changed.")}
            let latest=try await model.request("/reply-suggestions",mailbox:owner)
            guard !Task.isCancelled,latest["owner"].string==owner,latest["proposals"].array.contains(where:{proposalID($0)==proposalID(fresh)&&$0["messageId"].string==id&&$0["text"]==fresh["text"]&&self.owner($0)==owner}) else{throw APIError("The latest conversation changed again. Your edits are retained.")}
            updated.footer=old.footer;updated.attachments=old.attachments
            if old.replyToID==id{updated.savedID=old.savedID}
            drafts[newKey]=updated;messages[newKey]=original["message"];proposals[newKey]=fresh
            if newKey != oldKey{var baseline=updated;baseline.body=fresh["text"].string;savedPayloads[newKey]=baseline.payload}
            reviewedFacts.remove(newKey);stale.remove(newKey);errors[newKey]=nil;selection[scope]=newKey;detailVisible[scope]=true
        }catch{errors[oldKey]=error.localizedDescription}
    }
    func reviewSending(_ proposal: JSON, model: AppModel) async {
        let key = key(proposal), owner = owner(proposal)
        guard let draft = drafts[key], !writing, !preparing.contains(key), !stale.contains(key), reviewedFacts.contains(key), !draft.body.lowercased().contains("[decision needed"), model.accounts.contains(where: { $0.id == owner }) else { return }
        preparing.insert(key); defer { preparing.remove(key) }
        do {
            let latest = try await model.request("/reply-suggestions", mailbox: owner)
            guard !Task.isCancelled, latest["owner"].string == owner,
                  latest["proposals"].array.contains(where: { proposalID($0) == proposalID(proposal) && $0["text"] == proposal["text"] && $0["messageId"].string == draft.replyToID && $0["message"]["accountId"].string == owner }) else { throw APIError("The suggestion or its sources changed. Keep your draft and review fresh evidence.") }
            model.newDraft(draft) // Existing recipient/footer/send/scheduling review remains authoritative.
        } catch { errors[key] = error.localizedDescription; stale.insert(key); reviewedFacts.remove(key) }
    }
}

private extension String { var nonEmptyString: Bool { !isEmpty } }

