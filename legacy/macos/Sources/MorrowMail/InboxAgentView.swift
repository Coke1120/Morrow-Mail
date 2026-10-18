import SwiftUI

private struct AgentSendReview: Identifiable {
    let id: String
    let owner: String
    let conversationID: String
    let pending: JSON
    let text: String
}

struct InboxAgentView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var review: ReviewWorkspaceState
    let mailbox: String
    @State private var recents: [JSON] = []
    @State private var conversation: JSON = .null
    @State private var selected = ""
    @State private var message = ""
    @State private var title = ""
    @State private var sending = false
    @State private var recovering = false
    @State private var stopping = false
    @State private var turn = 0
    @State private var sendReview: AgentSendReview?
    private var needsMailbox: Bool { mailbox == "all" || mailbox == "demo" || !model.accounts.contains { $0.id == mailbox } }
    private var status: String { conversation["status"].string }
    private var reviewing: Bool { sending || recovering || stopping || ["awaiting", "running", "confirming"].contains(status) }
    private var operationBusy: Bool { model.busy || model.backgroundBusy || stopping }
    private var sendPreviewReady: Bool { (try? inboxAgentSendReviewText(conversation["pending"]["preview"], owner: mailbox)) != nil }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                SectionHeading(title: "Inbox Agent", detail: "A local multi-turn chat for this mailbox.")
                Text("Uses the model you configured. The chat stays on this device. The agent can read permitted cached mail and save drafts. Archive, star, trash, read, pending and send wait for your confirmation in this conversation. It does not contact a Morrow cloud agent or update Email Brain.").font(.callout).foregroundStyle(.secondary)
                if needsMailbox {
                    Text("Choose one mailbox tab. Inbox Agent keeps a separate conversation for each mailbox.")
                } else {
                    if !model.state["settings"]["ai"]["configured"].bool {
                        Text("Set up a model before using Inbox Agent.").foregroundStyle(.secondary)
                    } else if !model.allowed("ask") {
                        Text("Inbox Agent is off. Enable Ask your inbox in AI permissions.").foregroundStyle(.secondary)
                    }
                    Button("New conversation") { start() }.disabled(operationBusy)
                    Text("Recent conversations").font(.headline)
                    if recents.isEmpty { Text("No conversations yet.").foregroundStyle(.secondary) }
                    ForEach(recents) { recent in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(recent["title"].nonempty ? recent["title"].string : "New conversation")
                                Text(recent["status"].string + (recent["pendingKind"].nonempty ? " · " + recent["pendingKind"].string : "")).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Open") { open(recent.id) }
                            Menu("Conversation actions") {
                                Button("Delete…") { remove(recent.id) }
                            }.fixedSize().accessibilityLabel("Actions for conversation " + recent["title"].string)
                        }.disabled(operationBusy)
                    }
                    if !conversation.isNull {
                        Divider()
                        Text(conversation["title"].string).font(.title3.bold())
                        ForEach(conversation["turns"].array) { entry in
                            Text(label(entry["role"].string) + ": " + entry["text"].string).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if !conversation["pending"].isNull {
                            Text(conversation["pending"]["summary"].string).font(.headline)
                            if conversation["pending"]["kind"].string == "send" {
                                Text(sendPreviewReady ? "Review the complete message, recipients, attachments and footer before sending." : "This saved review is incomplete. Dismiss it and ask for a new review.").font(.callout).foregroundStyle(.secondary)
                            }
                            HStack {
                                Button(conversation["pending"]["kind"].string == "send" ? "Review and send" : "Review and apply") { confirmPending() }
                                    .disabled(recovering || status != "awaiting" || (conversation["pending"]["kind"].string == "send" && !sendPreviewReady))
                                Button("Dismiss review") { answer("deny") }
                                    .disabled(recovering || status != "awaiting")
                            }.disabled(operationBusy)
                        }
                        if sending || recovering || status == "running" || status == "awaiting" {
                            Button(stopping ? "Stopping…" : "Stop") { stop() }.disabled(stopping)
                            if sending || status == "running" { Text("This turn is still running. Stop it before it finishes. Mail is not sent without confirmation.").font(.caption).foregroundStyle(.secondary) }
                        }
                        if recovering { Text("Checking the saved conversation after an interrupted request. Nothing will be resent automatically.").font(.caption).foregroundStyle(.secondary) }
                        if status != "running" && status != "confirming" {
                            DisclosureGroup("Conversation title") {
                                TextField("Conversation title", text: $title).disabled(reviewing || operationBusy)
                                Button("Rename") { rename() }.disabled(reviewing || operationBusy || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            }
                        }
                        if !reviewing {
                            TextEditor(text: $message)
                                .font(.body)
                                .frame(minHeight: 88, maxHeight: 180)
                                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.35)))
                                .accessibilityLabel("Message to Inbox Agent")
                            Button("Send") { send() }.disabled(operationBusy || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.allowed("ask") || !model.state["settings"]["ai"]["configured"].bool)
                        }
                    }
                }
            }.padding(20).frame(maxWidth: 900, alignment: .leading)
        }
        .task(id: mailbox) {
            let owner = mailbox
            turn += 1; sending = false; recovering = false; stopping = false; sendReview = nil
            recents = []; conversation = .null; selected = ""; message = ""; title = ""
            guard owner != "all", owner != "demo", model.accounts.contains(where: { $0.id == owner }) else { return }
            await load(owner)
        }
        .task(id: mailbox + "\n" + selected + "\n" + String(turn)) {
            let owner = mailbox, id = selected, ticket = turn
            guard !id.isEmpty else { return }
            while !Task.isCancelled, review.scope == owner, selected == id, turn == ticket {
                if !sending && !operationBusy && (recovering || status == "running" || status == "confirming") {
                    await refreshConversation(owner: owner, id: id, ticket: ticket)
                }
                do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
            }
        }
        .onDisappear { turn += 1; sendReview = nil }
        .sheet(item: $sendReview) { item in
            VStack(alignment: .leading, spacing: 16) {
                Text("Send this reviewed message?").font(.title2.bold())
                ScrollView {
                    Text(item.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }
                Text("The complete message above will be sent from \(item.owner). Changes to the draft or sender require a new review.").font(.caption).foregroundStyle(.secondary)
                HStack {
                    Spacer()
                    Button("Cancel") { sendReview = nil }.keyboardShortcut(.cancelAction)
                    Button("Send reviewed message") {
                        sendReview = nil
                        guard review.scope == item.owner, selected == item.conversationID,
                              conversation["pending"] == item.pending, status == "awaiting" else {
                            model.error = "This review changed. Open the current review before sending."
                            return
                        }
                        answer("confirm")
                    }.buttonStyle(.borderedProminent).disabled(operationBusy || recovering)
                }
            }.padding(24).frame(width: 680, height: 620)
        }
    }
    private func label(_ role: String) -> String {
        switch role {
        case "user": "You"
        case "assistant": "Assistant"
        case "tool": "Tool"
        case "note": "Note"
        default: role
        }
    }
    @discardableResult private func apply(_ result: JSON, owner: String, expectedID: String? = nil) -> Bool {
        guard review.scope == owner else { return false }
        guard result["transport"].string == "local-byo", result["cloud"] == .bool(false), result["accountId"].string == owner else {
            model.error = "Inbox Agent returned an unexpected response."
            return false
        }
        if expectedID != nil || result.object.keys.contains("conversation") {
            guard result["conversation"]["accountId"].string == owner, !result["conversation"].id.isEmpty,
                  expectedID == nil || result["conversation"].id == expectedID else {
                model.error = "Inbox Agent returned a different conversation."
                return false
            }
            conversation = result["conversation"]; selected = conversation.id; title = conversation["title"].string
        }
        recents = result["recents"].array
        return true
    }
    private func refreshConversation(owner: String, id: String, ticket: Int) async {
        do {
            let result = try await model.request("/agent/conversations/" + encodedPath(id), mailbox: owner)
            guard !Task.isCancelled, review.scope == owner, selected == id, turn == ticket else { return }
            recovering = !apply(result, owner: owner, expectedID: id)
        } catch {
            guard !Task.isCancelled, review.scope == owner, selected == id, turn == ticket else { return }
            recovering = true
            model.error = "The conversation status could not be checked. Stop or wait for recovery before trying again. " + error.localizedDescription
        }
    }
    private func load(_ owner: String) async {
        do {
            let listed = try await model.request("/agent/recents", mailbox: owner)
            guard !Task.isCancelled, review.scope == owner else { return }
            apply(listed, owner: owner)
        } catch is CancellationError {
            return
        } catch {
            guard review.scope == owner else { return }
            model.error = error.localizedDescription
        }
    }
    private func start() {
        let owner = mailbox
        guard !needsMailbox, !operationBusy else { return }
        turn += 1
        let ticket = turn
        model.perform({
            let result = try await model.request("/agent/start", method: "POST", body: .object([:]), mailbox: owner)
            guard review.scope == owner, turn == ticket else { return }
            if apply(result, owner: owner) { message = ""; recovering = false }
        }, blocksNavigation: false)
    }
    private func open(_ id: String) {
        let owner = mailbox
        guard !needsMailbox, !operationBusy else { return }
        turn += 1
        let ticket = turn
        model.perform({
            let result = try await model.request("/agent/conversations/" + encodedPath(id), mailbox: owner)
            guard review.scope == owner, turn == ticket else { return }
            if apply(result, owner: owner, expectedID: id) { recovering = false }
        }, blocksNavigation: false)
    }
    private func send() {
        let owner = mailbox, id = selected, text = message
        guard !needsMailbox, !operationBusy, !reviewing, !id.isEmpty else { return }
        turn += 1
        let ticket = turn
        sending = true
        guard model.perform({
            defer { if ticket == turn { sending = false } }
            do {
                let result = try await model.request("/agent/send", method: "POST", body: .object(["conversationId": .string(id), "text": .string(text)]), mailbox: owner)
                guard review.scope == owner, selected == id, ticket == turn else { return }
                if apply(result, owner: owner, expectedID: id) { message = ""; recovering = false }
                else { recovering = true }
            } catch {
                guard review.scope == owner, selected == id, ticket == turn else { return }
                recovering = true
                model.error = error.localizedDescription
                await refreshConversation(owner: owner, id: id, ticket: ticket)
            }
        }, blocksNavigation: false) else {
            sending = false
            return
        }
    }
    private func confirmPending() {
        let owner = mailbox, id = selected, pending = conversation["pending"]
        let delivering = conversation["pending"]["kind"].string == "send"
        guard !operationBusy, !recovering, status == "awaiting", !id.isEmpty, !pending.id.isEmpty else { return }
        if delivering {
            do {
                sendReview = AgentSendReview(id: pending.id, owner: owner, conversationID: id, pending: pending,
                                            text: try inboxAgentSendReviewText(pending["preview"], owner: owner))
            } catch { model.error = error.localizedDescription }
            return
        }
        let summary = conversation["pending"]["summary"].string
        guard model.confirm("Apply this mailbox change?", detail: summary + "\n\nMailbox: \(owner)") else { return }
        guard review.scope == owner, selected == id, conversation["pending"] == pending else { return }
        answer("confirm")
    }
    private func answer(_ decision: String) {
        let owner = mailbox, id = selected, proposal = conversation["pending"].id
        guard !operationBusy, !recovering, status == "awaiting", !id.isEmpty, !proposal.isEmpty else { return }
        if decision == "confirm", conversation["pending"]["kind"].string == "send", !sendPreviewReady { return }
        turn += 1
        let ticket = turn
        model.perform({
            do {
                let result = try await model.request("/agent/answer", method: "POST", body: .object(["conversationId": .string(id), "proposalId": .string(proposal), "decision": .string(decision)]), mailbox: owner)
                guard review.scope == owner, selected == id, turn == ticket else { return }
                recovering = !apply(result, owner: owner, expectedID: id)
                if decision == "confirm", model.account == owner { try await model.reload() }
            } catch {
                guard review.scope == owner, selected == id, turn == ticket else { return }
                recovering = true
                model.error = error.localizedDescription
                await refreshConversation(owner: owner, id: id, ticket: ticket)
            }
        }, blocksNavigation: false)
    }
    private func stop() {
        let owner = mailbox, id = selected
        guard !id.isEmpty, !stopping else { return }
        turn += 1
        let ticket = turn
        sending = false; stopping = true
        Task { @MainActor in
            defer { if ticket == turn { stopping = false } }
            do {
                let result = try await model.request("/agent/cancel", method: "POST", body: .object(["conversationId": .string(id)]), mailbox: owner)
                guard review.scope == owner, selected == id, ticket == turn else { return }
                recovering = !apply(result, owner: owner, expectedID: id)
            } catch {
                guard review.scope == owner, selected == id, ticket == turn else { return }
                model.error = error.localizedDescription
                recovering = true
                await refreshConversation(owner: owner, id: id, ticket: ticket)
            }
        }
    }
    private func rename() {
        let owner = mailbox, id = selected, next = title
        guard !operationBusy, !reviewing, !id.isEmpty else { return }
        turn += 1
        let ticket = turn
        model.perform({
            let result = try await model.request("/agent/rename", method: "POST", body: .object(["conversationId": .string(id), "title": .string(next)]), mailbox: owner)
            guard review.scope == owner, selected == id, turn == ticket else { return }
            apply(result, owner: owner, expectedID: id)
        }, blocksNavigation: false)
    }
    private func remove(_ id: String) {
        let owner = mailbox
        guard !operationBusy, model.confirm("Delete this conversation?", detail: "Saved mail stays in the mailbox. This only removes the local chat.") else { return }
        turn += 1
        let ticket = turn
        model.perform({
            let result = try await model.request("/agent/conversations/" + encodedPath(id), method: "DELETE", mailbox: owner)
            guard review.scope == owner, turn == ticket else { return }
            if selected == id { conversation = .null; selected = ""; title = "" }
            apply(result, owner: owner)
        }, blocksNavigation: false)
    }
}
