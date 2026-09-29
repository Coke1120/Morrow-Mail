import SwiftUI

struct ReplySuggestionsView: View {
    @EnvironmentObject var model: AppModel
    @State private var value: JSON = .null
    @State private var options: JSON = .null
    @State private var busy = false
    @State private var revision = 0
    @State private var error = ""
    private var owner: String { model.state["account"]["mode"].string == "live" ? model.account : "" }
    private var job: JSON { value["job"] }
    private var running: Bool { ["queued", "running"].contains(job["status"].string) }
    private var changed: Bool { !options.isNull && !value.isNull && options != value["settings"] }
    private var locked: Bool { busy || model.busy || model.preparingDraft }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeading(title: "Needs a reply", detail: "AI checks downloaded Inbox mail and leaves out messages that do not need a reply. Open a suggestion to edit or send it, or ignore the email.")
                if owner.isEmpty { Text("Choose a connected mailbox for its reply suggestions.") }
                else if value.isNull || options.isNull { ProgressView("Loading…") }
                else { content }
                if busy { ProgressView().controlSize(.small) }
                if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            }.padding(24).frame(maxWidth: 920, alignment: .leading).frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: owner) {
            let account = owner
            value = .null; options = .null; error = ""
            guard !account.isEmpty else { return }
            while !Task.isCancelled && model.account == account {
                let version = revision
                do {
                    let next = try await model.request("/reply-suggestions", mailbox: account)
                    guard !Task.isCancelled, model.account == account else { return }
                    if version == revision { value = next; if options.isNull { options = next["settings"] }; error = "" }
                } catch { if Task.isCancelled { return }; self.error = error.localizedDescription }
                do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
            }
        }
        .onChange(of: changed) { model.dirty("reply-suggestions", $0) }
        .onDisappear { model.dirty("reply-suggestions", false) }
    }
    @ViewBuilder private var content: some View {
        Text(owner).font(.headline)
        if !value["identityReady"].bool {
            Text("Confirm the name to use in your replies first.").foregroundStyle(.secondary)
            Button("Confirm My Identity") { model.settings("learning") }.disabled(locked || changed)
        } else if !value["modelReady"].bool {
            Button("Set Up a Chat Model") { model.settings("model") }.disabled(locked || changed)
        } else if !model.allowed("reply") || !model.policy["folders"]["inbox"].bool || !model.policy["content"]["sender"].bool || !model.policy["content"]["body"].bool {
            Text("Allow AI replies to use Inbox, sender and body in AI & privacy.").foregroundStyle(.secondary)
            Button("Review AI & Privacy") { model.settings("permissions") }.disabled(locked || changed)
        } else if !value["automaticReady"].bool {
            Text("Enable automatic checks once. Each suggested reply still requires your approval before sending.").foregroundStyle(.secondary)
            Button("Enable Automatic Reply Suggestions") {
                var next = options; next["enabled"] = .bool(true); next["automatic"] = .bool(true); next["tokenBudget"] = .number(64000)
                action("settings", body: next)
            }.buttonStyle(.borderedProminent).disabled(locked || changed)
        } else {
            Label(running ? "Checking mail in the background…" : "Automatic checks are on", systemImage: "checkmark.circle").foregroundStyle(.secondary)
        }
        if job["error"].nonempty { Text(job["error"].string).foregroundStyle(.orange) }
        if ["failed", "interrupted", "cancelled"].contains(job["status"].string) {
            Button("Review & Restart Checks") { action("settings", body: options) }.disabled(locked)
        }
        if value["automaticReady"].bool && value["automaticStatus"].nonempty { Text(value["automaticStatus"].string).font(.caption).foregroundStyle(.secondary) }
        if value["proposals"].array.isEmpty {
            Text(running ? "Suggestions will appear as messages are checked." : "No replies waiting for review. Unnecessary replies are filtered out; AI can still miss a request.").foregroundStyle(.secondary).padding(.vertical, 18)
        }
        ForEach(value["proposals"].array) { proposal in
            GroupBox {
                HStack(alignment: .top, spacing: 16) {
                    Button { action("use", body: .object(["id": proposal["id"]])) } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(proposal["message"]["subject"].nonempty ? proposal["message"]["subject"].string : "(Subject withheld)").font(.headline)
                            Text(proposal["message"]["fromEmail"].string).font(.caption).foregroundStyle(.secondary)
                            Text(proposal["reason"].string).font(.callout).foregroundStyle(.secondary)
                            Text("Review suggested reply…").foregroundStyle(morrowGreen)
                        }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                    }.buttonStyle(.plain).disabled(locked || changed || model.compose != nil)
                    Button("Ignore") { action("dismiss", body: .object(["id": proposal["id"]])) }.disabled(locked)
                }.padding(10)
            }
        }
        DisclosureGroup("Automatic checks & budget") {
            VStack(alignment: .leading, spacing: 12) {
                Toggle("Check new Inbox mail automatically", isOn: Binding(get: { options["automatic"].bool }, set: { options["automatic"] = .bool($0); if $0 { options["enabled"] = .bool(true) } })).toggleStyle(.checkbox)
                HStack { Text("Daily token budget"); TextField("100000", value: number("dailyTokenBudget"), format: .number.grouping(.never)).frame(width: 120) }
                Text("Used today: \(Int(value["spentToday"].number)) estimated tokens. Resets at midnight UTC; provider billing may differ. Checks use at most the newest 200 downloaded Inbox messages and permitted correspondence. Mail is never sent automatically.").font(.caption).foregroundStyle(.secondary)
                if changed {
                    HStack {
                        Button("Save") { action("settings", body: options) }.buttonStyle(.borderedProminent)
                        Button("Discard") { options = value["settings"] }
                    }
                }
            }.padding(8).disabled(locked)
        }
    }
    private func number(_ key: String) -> Binding<Int> { Binding(get: { Int(options[key].number) }, set: { options[key] = .number(Double($0)) }) }
    private func action(_ path: String, body: JSON = .object([:])) {
        guard !owner.isEmpty, !locked else { return }
        let account = owner, generation = model.draftGeneration
        if path == "settings" && body["automatic"].bool && !model.confirm("Automatically find mail that needs a reply?", detail: "\(account) · \(value["model"]["model"].string)\nEndpoint: \(value["model"]["baseUrl"].string)\nUp to \(Int(body["dailyTokenBudget"].number)) estimated tokens per UTC day, while Morrow is open. Uses permitted Inbox and correspondence. Provider charges may apply. Open each suggestion to review, edit or send it; enabling never sends mail.") { return }
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
