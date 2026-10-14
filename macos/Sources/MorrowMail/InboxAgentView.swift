import SwiftUI

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
    @State private var turn = 0
    private var needsMailbox: Bool { mailbox == "all" || mailbox == "demo" || !model.accounts.contains { $0.id == mailbox } }
    private var status: String { conversation["status"].string }
    private var reviewing: Bool { sending || ["awaiting", "running", "confirming"].contains(status) }
    private var operationBusy: Bool { model.busy || model.backgroundBusy }
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
                            Button("Delete") { remove(recent.id) }
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
                            if !conversation["pending"]["preview"].isNull {
                                Text(preview(conversation["pending"]["preview"])).font(.callout).textSelection(.enabled)
                            }
                            HStack {
                                Button(conversation["pending"]["kind"].string == "send" ? "Review and send" : "Review and apply") { confirmPending() }
                                Button("Dismiss review") { answer("deny") }
                            }.disabled(operationBusy)
                        }
                        if sending || status == "running" || status == "awaiting" {
                            Button("Stop") { stop() }
                            if sending || status == "running" { Text("This turn is still running. Stop it before it finishes. Mail is not sent without confirmation.").font(.caption).foregroundStyle(.secondary) }
                        }
                        if status != "running" && status != "confirming" {
                            TextField("Conversation title", text: $title)
                            Button("Rename") { rename() }.disabled(operationBusy || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
            turn += 1; sending = false
            recents = []; conversation = .null; selected = ""; message = ""; title = ""
            guard owner != "all", owner != "demo", model.accounts.contains(where: { $0.id == owner }) else { return }
            await load(owner)
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
    private func preview(_ value: JSON) -> String {
        "To: \(value["to"].string)\nCc: \(value["cc"].string)\nBcc: \(value["bcc"].string)\nSubject: \(value["subject"].string)\n\n\(value["body"].string)"
    }
    private func apply(_ result: JSON, owner: String) {
        guard review.scope == owner else { return }
        guard result["transport"].string == "local-byo", result["cloud"] == .bool(false), result["accountId"].string == owner else {
            model.error = "Inbox Agent returned an unexpected response."
            return
        }
        recents = result["recents"].array
        if result.object.keys.contains("conversation") {
            conversation = result["conversation"]; selected = conversation.id; title = conversation["title"].string
        } else if result["deleted"].bool {
            conversation = .null; selected = ""; title = ""
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
        model.perform({
            let result = try await model.request("/agent/start", method: "POST", body: .object([:]), mailbox: owner)
            guard review.scope == owner else { return }
            apply(result, owner: owner); message = ""
        }, blocksNavigation: false)
    }
    private func open(_ id: String) {
        let owner = mailbox
        guard !needsMailbox, !operationBusy else { return }
        model.perform({
            let result = try await model.request("/agent/conversations/" + encodedPath(id), mailbox: owner)
            guard review.scope == owner else { return }
            apply(result, owner: owner)
        }, blocksNavigation: false)
    }
    private func send() {
        let owner = mailbox, id = selected, text = message
        guard !needsMailbox, !operationBusy, !sending, !id.isEmpty else { return }
        let ticket = turn
        sending = true
        guard model.perform({
            defer { if ticket == turn { sending = false } }
            let result = try await model.request("/agent/send", method: "POST", body: .object(["conversationId": .string(id), "text": .string(text)]), mailbox: owner)
            guard review.scope == owner, ticket == turn else { return }
            apply(result, owner: owner); message = ""
        }, blocksNavigation: false) else {
            sending = false
            return
        }
    }
    private func confirmPending() {
        let owner = mailbox, id = selected, proposal = conversation["pending"].id
        let delivering = conversation["pending"]["kind"].string == "send"
        let summary = conversation["pending"]["summary"].string
        let detail = delivering
            ? summary + "\n\nChoose Continue to send this reviewed draft from \(owner). The model cannot send it alone."
            : summary + "\n\nChoose Continue to apply this mailbox change in \(owner)."
        guard !operationBusy, model.confirm(delivering ? "Send this message?" : "Apply this mailbox change?", detail: detail) else { return }
        model.perform({
            let result = try await model.request("/agent/answer", method: "POST", body: .object(["conversationId": .string(id), "proposalId": .string(proposal), "decision": .string("confirm")]), mailbox: owner)
            guard review.scope == owner else { return }
            apply(result, owner: owner)
            if model.account == owner { try await model.reload() }
        }, blocksNavigation: false)
    }
    private func answer(_ decision: String) {
        let owner = mailbox, id = selected, proposal = conversation["pending"].id
        guard !operationBusy, !id.isEmpty, !proposal.isEmpty else { return }
        model.perform({
            let result = try await model.request("/agent/answer", method: "POST", body: .object(["conversationId": .string(id), "proposalId": .string(proposal), "decision": .string(decision)]), mailbox: owner)
            guard review.scope == owner else { return }
            apply(result, owner: owner)
        }, blocksNavigation: false)
    }
    private func stop() {
        let owner = mailbox, id = selected
        guard !id.isEmpty else { return }
        turn += 1
        let ticket = turn
        sending = false
        Task { @MainActor in
            do {
                let result = try await model.request("/agent/cancel", method: "POST", body: .object(["conversationId": .string(id)]), mailbox: owner)
                guard review.scope == owner, ticket == turn else { return }
                apply(result, owner: owner)
            } catch {
                guard review.scope == owner, ticket == turn else { return }
                model.error = error.localizedDescription
            }
        }
    }
    private func rename() {
        let owner = mailbox, id = selected, next = title
        guard !operationBusy, !id.isEmpty else { return }
        model.perform({
            let result = try await model.request("/agent/rename", method: "POST", body: .object(["conversationId": .string(id), "title": .string(next)]), mailbox: owner)
            guard review.scope == owner else { return }
            apply(result, owner: owner)
        }, blocksNavigation: false)
    }
    private func remove(_ id: String) {
        let owner = mailbox
        guard !operationBusy, model.confirm("Delete this conversation?", detail: "Saved mail stays in the mailbox. This only removes the local chat.") else { return }
        model.perform({
            let result = try await model.request("/agent/conversations/" + encodedPath(id), method: "DELETE", mailbox: owner)
            guard review.scope == owner else { return }
            if selected == id { conversation = .null; selected = ""; title = "" }
            apply(result, owner: owner)
        }, blocksNavigation: false)
    }
}
