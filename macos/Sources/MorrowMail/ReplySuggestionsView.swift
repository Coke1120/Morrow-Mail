import SwiftUI

struct ReplySuggestionsView: View {
    @EnvironmentObject var model: AppModel
    @State private var value: JSON = .null
    @State private var options: JSON = .null
    @State private var selected: Set<String> = []
    @State private var busy = false
    @State private var revision = 0
    @State private var error = ""
    private var owner: String { model.state["account"]["mode"].string == "live" ? model.account : "" }
    private var job: JSON { value["job"] }
    private var running: Bool { ["queued", "running"].contains(job["status"].string) }
    private var changed: Bool { !options.isNull && !value.isNull && options != value["settings"] }
    private var locked: Bool { busy || model.busy || model.preparingDraft }
    private var previewBlocked: Bool { locked || changed || running || !value["permitted"].bool || !value["identityReady"].bool || selected.isEmpty || selected.count > Int(value["settings"]["maxMessages"].number) }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeading(title: "Reply suggestions", detail: "Review mail that may need a reply, then open a draft in its original account. Suggestions are fallible; nothing is sent automatically.")
                if owner.isEmpty { Text("Choose an individual connected mailbox to review its suggestions.") }
                else if value.isNull || options.isNull { ProgressView("Loading reply suggestions…") }
                else { content }
                if busy { ProgressView("Saving or preparing review…").controlSize(.small) }
                if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            }.padding(24).frame(maxWidth: 920, alignment: .leading).frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: owner) {
            let account = owner
            value = .null; options = .null; selected = []; error = ""
            guard !account.isEmpty else { return }
            while !Task.isCancelled && model.account == account {
                let version = revision
                do {
                    let next = try await model.request("/reply-suggestions", mailbox: account)
                    guard !Task.isCancelled, model.account == account else { return }
                    if version == revision { value = next; if options.isNull { options = next["settings"] } }
                } catch { if Task.isCancelled { return }; self.error = error.localizedDescription }
                do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
            }
        }
        .onChange(of: changed) { dirty in if dirty { model.unsavedForms.insert("reply-suggestions") } else { model.unsavedForms.remove("reply-suggestions") } }
        .onDisappear { model.unsavedForms.remove("reply-suggestions") }
    }
    @ViewBuilder private var content: some View {
        Text(owner).font(.headline)
        Text(value["identityReady"].bool ? "Confirmed identity: \(value["identity"]["displayName"].string)" : "Confirm your identity in Learning settings first.").foregroundStyle(.secondary)
        Button("Review Identity in Learning…") { model.settings("learning") }.disabled(locked || changed)
        GroupBox("Explicit batch permission") {
            VStack(alignment: .leading, spacing: 12) {
                Toggle("Enable reply suggestions for this account", isOn: Binding(get: { options["enabled"].bool }, set: { options["enabled"] = .bool($0) })).toggleStyle(.checkbox)
                Stepper("Maximum messages per batch: \(Int(options["maxMessages"].number))", value: number("maxMessages"), in: 1...10)
                HStack { Text("Token budget per batch"); TextField("16000", value: number("tokenBudget"), format: .number.grouping(.never)).frame(width: 120) }
                Button("Save Suggestion Settings") { action("settings", body: options) }.disabled(!changed)
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
        }.disabled(locked || running)
        Text("Enabling does not start AI. Each batch needs preview and confirmation. Approved writing style is used only while its Brain, Sent and body permissions remain enabled. Estimates include UTF-8 input bytes and response allowance; model billing may differ. Saving these settings clears older previews and proposals.").font(.caption).foregroundStyle(.secondary)
        if !value["permitted"].bool { Text("Requires AI enabled, Reply, Inbox, sender and body access in AI permissions.").foregroundStyle(.secondary) }
        if running { Text("Working in the background: \(Int(job["completed"].number)) / \(Int(job["sampleCount"].number)) assessed. You can leave this view while Morrow stays open. Cancel stops remaining work; an in-flight request may still use tokens.").foregroundStyle(.secondary) }
        if !job.isNull { jobPanel }
        Text("Suggestions to review").font(.title2)
        if value["proposals"].array.isEmpty { Text("No current reply proposals. Completed assessments may find that no reply is needed.").foregroundStyle(.secondary) }
        ForEach(value["proposals"].array) { proposal in proposalPanel(proposal) }
        Text("Inbox candidates").font(.title2)
        Text("Showing eligible candidates among the newest \(Int(value["candidateLimit"].number)) downloaded Inbox messages. This is not an unanswered-mail guarantee; locally recorded replies are excluded where available.").font(.caption).foregroundStyle(.secondary)
        Button("Select Newest \(Int(value["settings"]["maxMessages"].number))") { selected = Set(value["candidates"].array.prefix(Int(value["settings"]["maxMessages"].number)).map(\.id)) }.disabled(locked || running || !value["permitted"].bool)
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                ForEach(value["candidates"].array) { message in
                    Toggle(isOn: Binding(get: { selected.contains(message.id) }, set: { if $0 { selected.insert(message.id) } else { selected.remove(message.id) } })) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(message["subject"].nonempty ? message["subject"].string : "(Subject withheld)")
                            Text("\(message["fromName"].nonempty ? message["fromName"].string : message["fromEmail"].string) · \(message["date"].string)").font(.caption).foregroundStyle(.secondary)
                        }
                    }.toggleStyle(.checkbox).disabled(locked || running)
                }
            }
        }.frame(maxHeight: 360)
        Button("Preview Selected Mail · No AI Call") { action("preview", body: .object(["messageIds": .array(selected.sorted().map(JSON.string))])) }.disabled(previewBlocked)
    }
    private var jobPanel: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                Text("\(job["status"].string.capitalized) · \(Int(job["completed"].number)) / \(Int(job["sampleCount"].number)) assessed").font(.headline)
                Text("Estimated tokens ≤ \(Int(job["estimatedTokens"].number)) · budget \(Int(job["tokenBudget"].number)) · reserved \(Int(job["spentTokens"].number))").font(.caption)
                if job["error"].nonempty { Text(job["error"].string).foregroundStyle(.orange) }
                if job["status"].string == "prepared" {
                    Text("\(value["model"]["model"].string) · \(value["model"]["baseUrl"].string)").font(.caption).textSelection(.enabled)
                    Text("Only downloaded, permitted same-correspondent history (including your Sent replies when permitted) is considered. Per reply: at most \(Int(value["contextLimit"].number)) messages and the saved AI context cap; target body ≤ 5,000 characters, other bodies ≤ 2,000. The model does not read every matching message.").font(.caption).foregroundStyle(.secondary)
                    DisclosureGroup("Review selected mail and context coverage") {
                        ForEach(Array(job["samples"].array.enumerated()), id: \.offset) { _, sample in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(sample["message"]["subject"].nonempty ? sample["message"]["subject"].string : "(Subject withheld)").font(.headline)
                                Text("\(Int(sample["history"]["usedMessages"].number)) used / \(Int(sample["history"]["matchedMessages"].number)) matching downloaded messages").font(.caption)
                                Text(sample["excerpt"].string).textSelection(.enabled)
                            }.padding(.vertical, 6)
                        }
                    }
                    Button("Generate Reviewed Batch · Uses AI") { action("run", body: .object(["previewId": .string(job.id)])) }.buttonStyle(.borderedProminent).disabled(locked || changed || !value["identityReady"].bool || !job["reviewValid"].bool)
                }
                if ["prepared", "queued", "running"].contains(job["status"].string) { Button("Cancel Remaining Work") { action("cancel") }.disabled(locked) }
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func proposalPanel(_ proposal: JSON) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                Text(proposal["message"]["subject"].nonempty ? proposal["message"]["subject"].string : "(Subject withheld)").font(.headline)
                Text(proposal["message"]["fromEmail"].string).font(.caption).foregroundStyle(.secondary)
                Text(proposal["reason"].string).foregroundStyle(.secondary)
                Text(proposal["text"].string).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                Text("\(Int(proposal["history"]["usedMessages"].number)) / \(Int(proposal["history"]["matchedMessages"].number)) matching downloaded messages used. Review facts, recipients and commitments before sending.").font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button(proposal["status"].string == "used" ? "Open Another Draft" : "Use in Draft") { action("use", body: .object(["id": .string(proposal.id)])) }.buttonStyle(.borderedProminent).disabled(changed || model.compose != nil || model.readerAssistant != nil)
                    Button("Dismiss") { action("dismiss", body: .object(["id": .string(proposal.id)])) }
                }.disabled(locked)
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func number(_ key: String) -> Binding<Int> { Binding(get: { Int(options[key].number) }, set: { options[key] = .number(Double($0)) }) }
    private func action(_ path: String, body: JSON = .object([:])) {
        guard !owner.isEmpty, !locked else { return }
        let account = owner, generation = model.draftGeneration
        if path == "run" && !model.confirm("Generate reply suggestions?", detail: "\(account) · \(Int(job["sampleCount"].number)) messages · estimated tokens ≤ \(Int(job["estimatedTokens"].number)) · budget \(Int(job["tokenBudget"].number)).\nModel: \(value["model"]["model"].string)\nEndpoint: \(value["model"]["baseUrl"].string)\nUses the reviewed downloaded history and confirmed identity. No mail will be sent.") { return }
        revision += 1; busy = true; error = ""
        Task { @MainActor in
            defer { revision += 1; busy = false }
            do {
                let next = try await model.request("/reply-suggestions/\(path)", method: "POST", body: body, mailbox: account)
                guard model.account == account else { return }
                if path == "use" {
                    guard next["message"]["accountId"].string == account else { throw APIError("The suggestion belongs to a different mailbox.") }
                    guard generation == model.draftGeneration else { return }
                    let draft = try await model.prepareDraft(message: next["message"], mode: "reply", body: next["text"].string)
                    guard generation == model.draftGeneration, owner == account else { return }
                    model.newDraft(draft)
                } else { value = next; if path == "settings" { options = next["settings"] } }
            } catch is CancellationError { }
            catch { if model.account == account { self.error = error.localizedDescription } }
        }
    }
}
