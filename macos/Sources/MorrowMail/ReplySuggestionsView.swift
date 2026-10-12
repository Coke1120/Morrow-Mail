import SwiftUI

struct ReplySuggestionsView: View {
    @EnvironmentObject var model: AppModel
    var body: some View { ReplyReviewWorkspace(review: model.review) }
}

private struct ReplyReviewWorkspace: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var review: ReviewWorkspaceState
    @FocusState private var rowFocus: String?
    private var rows: [JSON] { review.queue(model) }
    private var selected: JSON? { review.selected(model) }
    private var value: JSON { review.values[review.scope] ?? .null }
    var body: some View {
        GeometryReader { area in
            let compact = area.size.width < 780
            VStack(spacing: 0) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Reply suggestions").font(.title.weight(.semibold))
                        Text("Review the original message and edit your reply here.").font(.callout).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if review.loading.contains(review.scope) && !rows.isEmpty { ProgressView().controlSize(.small).help("Refreshing this mailbox's saved suggestions") }
                    Button("Refresh") { Task { await review.load(review.scope, model: model) } }.disabled(review.writing)
                }.padding(.horizontal, 24).padding(.vertical, 16)
                ReviewAccountTabs(review: review)
                Divider()
                if let error = review.errors[review.scope] {
                    HStack { Text(error).font(.callout).foregroundStyle(.red); Spacer(); Button("Reload suggestions") { Task { await review.load(review.scope, model: model) } } }.padding(12)
                }
                if value["limited"].bool { Text("Showing the newest \(rows.count) of \(Int(value["totalCount"].number)) saved suggestions. Select one account to review its full queue.").font(.caption).foregroundStyle(.secondary).padding(8) }
                if rows.isEmpty {
                    ScrollView { VStack(alignment: .leading, spacing: 16) {
                        setup
                        if review.loading.contains(review.scope) && review.errors[review.scope] == nil { ProgressView("Loading saved suggestions…") }
                        else if review.errors[review.scope] == nil { Text("No replies waiting for review.").font(.headline); Text("AI checks only permitted downloaded Inbox mail and can miss a request. Choose another account or review automatic checks below.").foregroundStyle(.secondary) }
                        options
                    }.padding(24).frame(maxWidth: .infinity, alignment: .leading) }
                } else if compact {
                    if review.detailVisible[review.scope] == true, let selected {
                        VStack(spacing: 0) {
                            HStack { Button("Back to suggestions") { review.detailVisible[review.scope] = false; rowFocus = review.key(selected) }.keyboardShortcut(.cancelAction); Spacer(); Text("Drafts stay with their original mailbox").font(.caption).foregroundStyle(.secondary) }.padding(12)
                            editor(selected)
                        }
                    } else { list }
                } else {
                    HSplitView { list.frame(minWidth: 250, idealWidth: 280, maxWidth: 340); if let selected { editor(selected).frame(minWidth: 360) } }
                }
            }
        }
        .task(id: review.scope) {
            let owner = review.scope
            while !Task.isCancelled {
                await review.load(owner, model: model)
                do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
            }
        }
        .task(id: selected.map(review.key) ?? "") { if let selected { await review.inspect(selected, model: model) } }
    }
    private var list: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Waiting for review · \(rows.count)").font(.headline).padding(14)
                ForEach(rows, id: \.viewID) { proposal in
                    let key = review.key(proposal)
                    Button { review.show(proposal); Task { await review.inspect(proposal, model: model) } } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            HStack { Text(proposal["message"]["fromName"].nonempty ? proposal["message"]["fromName"].string : proposal["message"]["fromEmail"].string).font(.caption.weight(.medium)); Spacer(); Text(review.owner(proposal)).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
                            Text(proposal["message"]["subject"].nonempty ? proposal["message"]["subject"].string : "(Subject withheld)").font(.system(size: 14, weight: .semibold)).lineLimit(2)
                            Text(review.stale.contains(key) ? "Sources changed · local draft retained" : proposal["reason"].string).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                            .background(selected.map(review.key) == key ? morrowGreen.opacity(0.10) : .clear).contentShape(Rectangle())
                    }.buttonStyle(.plain).focused($rowFocus, equals: key).accessibilityIdentifier("review.proposal." + key)
                    Divider()
                }
                options.padding(14)
            }.background(ReviewScrollMemory(key: "reply-list:" + review.scope, review: review))
        }
        .onMoveCommand { direction in
            guard !rows.isEmpty, direction == .up || direction == .down else { return }
            let index = rows.firstIndex { review.key($0) == (rowFocus ?? selected.map(review.key)) } ?? 0
            let next = rows[max(0, min(rows.count - 1, index + (direction == .up ? -1 : 1)))]; rowFocus = review.key(next); review.selection[review.scope] = review.key(next); review.proposals[review.key(next)] = next
        }
    }
    private func editor(_ proposal: JSON) -> some View {
        let key = review.key(proposal), owner = review.owner(proposal)
        return VStack(alignment: .leading, spacing: 0) {
            HStack { Image(systemName: "lock.fill"); Text("From: " + owner).textSelection(.enabled); Spacer() }.font(.caption).foregroundStyle(.secondary).padding(14)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let message = review.messages[key] {
                        OriginalReviewMessage(message: message).frame(minHeight: 120, maxHeight: 260)
                    } else if review.preparing.contains(key) { ProgressView("Loading original message…") }
                    if let error = review.errors[key] { Text(error).foregroundStyle(.red); Button("Reload original and suggestion") { Task { await review.inspect(proposal, model: model, replace: review.drafts[key] == nil) } } }
                    if review.stale.contains(key) {
                        Text("The suggestion or its evidence changed. Your draft is retained. Recheck the original before reviewing a send.").foregroundStyle(.orange)
                        if let fresh = value["proposals"].array.first(where: { review.key($0) == key }) {
                            Button("Review updated suggestion…") {
                                if review.savedPayloads[key] == review.drafts[key]?.payload || model.confirmDiscard("Replace this draft with the updated suggestion?") { Task { await review.inspect(fresh, model: model, replace: true) } }
                            }
                        }
                    }
                    if let draft = review.drafts[key] {
                        HStack { Text("Suggested reply").font(.headline); Spacer(); Text(review.savedPayloads[key] == draft.payload ? "Ready to edit" : "Unsaved edits retained").font(.caption).foregroundStyle(.secondary) }
                        Text("To: " + draft.to).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        ForEach(Array(proposal["questions"].array.enumerated()), id: \.offset) { _, question in Label(question.string, systemImage: "questionmark.circle").font(.callout).foregroundStyle(.secondary) }
                        TextEditor(text: Binding(get: { review.drafts[key]?.body ?? "" }, set: { body in guard !review.writing else { return }; review.drafts[key]?.body = body; review.reviewedFacts.remove(key) }))
                            .font(.system(size: 14)).frame(minHeight: 190).padding(8).background(.background)
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary)).accessibilityLabel("Edit suggested reply from " + owner).disabled(review.writing)
                        Toggle("I checked the facts, missing answers and commitments", isOn: Binding(get: { review.reviewedFacts.contains(key) }, set: { if $0 { review.reviewedFacts.insert(key) } else { review.reviewedFacts.remove(key) } })).toggleStyle(.checkbox).disabled(review.writing || review.stale.contains(key))
                        DisclosureGroup("Evidence and permitted reference messages") {
                            ForEach(Array(proposal["evidence"].array.enumerated()), id: \.offset) { _, quote in Text(quote["quote"].string).font(.callout).textSelection(.enabled) }
                            SourceLinksView(sources: proposal["sourceMessages"].array)
                            Text(proposal["approvedStyleUsed"].bool ? "Approved writing style used; style is not evidence of facts." : "No approved writing style was applied.").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
                    .background(ReviewScrollMemory(key: "reply-detail:" + key, review: review))
            }
            Divider()
            HStack {
                Button("Skip suggestion") {
                    model.perform {
                        _ = try await model.request("/reply-suggestions/dismiss", method: "POST", body: .object(["id": .string(review.proposalID(proposal))]), mailbox: owner)
                        await review.load(review.scope, model: model)
                    }
                }.disabled(model.busy || review.writing)
                Spacer()
                Button("Save draft") { review.save(key, model: model) }.keyboardShortcut("s").disabled(review.drafts[key] == nil || review.writing || model.busy || !model.accounts.contains { $0.id == owner })
                Button("Review sending…") { Task { await review.reviewSending(proposal, model: model) } }.buttonStyle(.borderedProminent)
                    .disabled(review.drafts[key] == nil || review.drafts[key]?.body.lowercased().contains("[decision needed") == true || !review.reviewedFacts.contains(key) || review.stale.contains(key) || review.preparing.contains(key) || review.writing || model.busy || !model.accounts.contains { $0.id == owner })
            }.padding(14)
        }
    }
    @ViewBuilder private var setup: some View {
        if review.scope != "all", !value.isNull {
            if !value["identityReady"].bool { Text("Confirm the identity for this mailbox first."); Button("Confirm this account's identity") { settings("learning") } }
            else if !value["modelReady"].bool { Button("Set up a chat model") { settings("model") } }
            else if !value["permitted"].bool { Text("AI replies need your saved Inbox, sender and body permissions."); Button("Review AI & Privacy") { settings("permissions") } }
            else if !value["automaticReady"].bool {
                Button("Enable automatic reply suggestions…") { var next = review.options[review.scope] ?? value["settings"]; next["enabled"] = .bool(true); next["automatic"] = .bool(true); review.options[review.scope] = next; review.saveOptions(review.scope, model: model) }
            } else { Label(value["job"]["status"].string == "running" ? "Checking downloaded mail…" : "Automatic checks are on", systemImage: "checkmark.circle").foregroundStyle(.secondary) }
            if value["automaticStatus"].nonempty { Text(value["automaticStatus"].string).font(.caption).foregroundStyle(.secondary) }
        }
    }
    @ViewBuilder private var options: some View {
        if review.scope != "all", let current = review.options[review.scope], !current.isNull {
            DisclosureGroup("Automatic checks & budget") {
                VStack(alignment: .leading, spacing: 12) {
                    setup
                    Toggle("Check new Inbox mail automatically", isOn: Binding(get: { review.options[review.scope]?["automatic"].bool ?? false }, set: { enabled in review.options[review.scope]?["automatic"] = .bool(enabled); if enabled { review.options[review.scope]?["enabled"] = .bool(true) } })).toggleStyle(.checkbox)
                    TextField("Daily token budget (UTC)", value: Binding(get: { Int(review.options[review.scope]?["dailyTokenBudget"].number ?? 100000) }, set: { review.options[review.scope]?["dailyTokenBudget"] = .number(Double($0)) }), format: .number.grouping(.never))
                    Text("Used today: \(Int(value["spentToday"].number)) estimated tokens. Checks cover at most the newest 200 downloaded Inbox messages. Mail is never sent automatically.").font(.caption).foregroundStyle(.secondary)
                    if current != value["settings"] { HStack { Button("Save settings…") { review.saveOptions(review.scope, model: model) }; Button("Discard setting edits") { review.options[review.scope] = value["settings"] } } }
                }.padding(.top, 8).disabled(review.writing || model.busy)
            }
        } else { Text("All accounts is a read-only queue. Select one mailbox to change its automatic checks or budget.").font(.caption).foregroundStyle(.secondary) }
    }
    private func settings(_ tab: String) {
        let owner = review.scope
        model.perform { try await model.selectAccount(owner); model.settings(tab) }
    }
}
