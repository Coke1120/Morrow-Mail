import SwiftUI

struct StyleLearningView: View {
    @EnvironmentObject var model: AppModel
    @Binding var dirty: Bool
    // The parent must route these links through its guarded selectTab.
    var onOpenSettings: ((String) -> Void)? = nil
    @State private var options: JSON = .null
    @State private var voice = ""
    @State private var error = ""
    @State private var identityName = ""
    @State private var identityAliases = ""
    @State private var identityConfirmed = false
    var value: JSON { model.state["workspace"]["styleLearning"] }
    var preview: JSON { value["preview"] }
    var savedOptions: JSON { value["settings"].picking(["enabled", "weekly", "months", "maxSamples", "tokenBudget"]) }
    var savedIdentity: JSON { value["settings"]["identity"].isNull ? .object(["displayName": .string(""), "aliases": .array([]), "confirmed": .bool(false)]) : value["settings"]["identity"] }
    var identityValue: JSON { .object(["displayName": .string(identityName), "aliases": .array(identityAliases.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.map(JSON.string)), "confirmed": .bool(identityConfirmed)]) }
    var identityChanged: Bool { identityValue != savedIdentity }
    var changed: Bool { options != savedOptions || identityChanged || voice != preview["voice"].string }
    var analysisBlocked: Bool { changed || !value["settings"]["enabled"].bool || !value["permitted"].bool || !model.state["settings"]["ai"]["configured"].bool || preview["status"].string == "running" }
    var statusSummary: String {
        if preview["status"].string == "ready" { return "Proposal ready · Not applied" }
        if !value["profile"].isNull {
            return value["profile"]["active"].bool ? "Approved style · Active for writing and replies" : "Approved style · Inactive under current permissions or source scope"
        }
        return "Not learned"
    }
    var nextStep: String {
        if model.busy { return "Next: wait for the current operation to finish, then review the result before continuing." }
        switch preview["status"].string {
        case "ready": return "Next: review and edit the proposal below, then choose Save Approved Style. Any previous approved style is retained until you explicitly save."
        case "prepared": return "Samples prepared · Next: review the sample text and token estimate below, then choose Analyze These Samples to generate a proposal."
        case "running": return "Analysis running · Wait for the result, then review the proposal before saving. Any previous approved style is retained."
        case "interrupted": return "Analysis interrupted · Tokens may have been used. Next: prepare fresh samples with Preview Samples or Learn Now to retry explicitly. Any previous approved style is retained."
        case "failed": return "Analysis failed · Tokens may have been used. Next: check the error and settings, then prepare fresh samples with Preview Samples or Learn Now. Any previous approved style is retained."
        default:
            if model.state["account"]["mode"].string != "live" { return "Next: choose an individual connected account in the sidebar." }
            if !savedOptions["enabled"].bool { return "Next: open Learning configuration, enable learning, and choose Save Learning Settings." }
            if changed { return "Next: save or discard your unsaved changes before learning again." }
            if !model.state["settings"]["ai"]["configured"].bool || !value["permitted"].bool { return "Next: resolve the model and permission requirements listed beside the learning buttons below." }
            if !value["profile"].isNull && !value["profile"]["active"].bool { return "Next: review learning permissions and cached Sent source mail; use Learn Now if fresh samples are needed. Your approved style is saved but currently inactive." }
            if value["profile"]["active"].bool { return "Your approved style is active. To update it, use Learn Now or Preview Samples; the current style is retained until you explicitly save a new proposal." }
            return "Next: use Learn Now to review samples and confirm AI analysis, or Preview Samples to inspect them without an AI call."
        }
    }
    func flag(_ key: String) -> Binding<Bool> {
        Binding(get: { options[key].bool }, set: { options[key] = .bool($0); if key == "enabled" && !$0 { options["weekly"] = .bool(false) } })
    }
    func number(_ key: String) -> Binding<Int> { Binding(get: { Int(options[key].number) }, set: { options[key] = .number(Double($0)) }) }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            SectionHeading(title: "Learn my writing style", detail: "Optional, per account. Only your own Sent text is analyzed. Contact and project memory remain separate. Importing mail does not use AI tokens.")
            Text(model.state["account"]["mode"].string == "live" ? model.state["account"].id : "Choose an individual connected account in the sidebar.").font(.headline)
            HStack(alignment: .firstTextBaseline) {
                Text(statusSummary).font(.headline)
                if changed { Text("Unsaved changes").font(.caption).foregroundStyle(.secondary) }
            }
            Text(nextStep).font(.callout).foregroundStyle(.secondary)
            if model.state["account"]["mode"].string != "live", let onOpenSettings {
                Button("Connect a Mailbox in Mail") { onOpenSettings("mail") }.disabled(model.busy)
            }
            VStack(alignment: .leading, spacing: 16) {
                if !preview.isNull { previewPanel }
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        if ["prepared", "ready"].contains(preview["status"].string) {
                            Button("Learn Now · Uses AI") { action("preview", learnNow: true) }.buttonStyle(.bordered).disabled(analysisBlocked)
                        } else {
                            Button("Learn Now · Uses AI") { action("preview", learnNow: true) }.buttonStyle(.borderedProminent).disabled(analysisBlocked)
                        }
                        Button("Preview Samples · No AI Call") { action("preview") }.disabled(analysisBlocked)
                    }
                    analysisRequirements
                    Text("Uses saved learning settings. Generating a proposal does not apply it. Save Approved Style activates it under Email Brain permission without changing contacts, notes, or voice.").font(.callout).foregroundStyle(.secondary)
                    HStack {
                        Text("Learning needs cached Sent mail for this account. Import Sent mail in Mail settings.")
                        if let onOpenSettings { Button("Open Mail") { onOpenSettings("mail") } }
                    }.font(.caption).foregroundStyle(.secondary)
                }
                if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                configurationPanel
                identityPanel
                if !value["profile"].isNull {
                    GroupBox("Saved writing style") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(value["profile"]["active"].bool ? "Active for writing and replies" : "Inactive under current permissions or source scope").font(.caption).foregroundStyle(.secondary)
                            Text(value["profile"]["voice"].string).textSelection(.enabled)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(6)
                    }
                }
                Button("Delete Learned Style & Stop Learning") {
                    guard model.confirm("Delete this account’s learned style?", detail: "The style and sample preview will be deleted, and learning turned off. Mail and your confirmed identity are retained.") else { return }
                    action("profile", method: "DELETE")
                }
            }.disabled(model.busy || model.state["account"]["mode"].string != "live")
        }
        .onAppear { load() }
        .onChange(of: model.state["account"].id) { _ in load(); error = "" }
        .onChange(of: value["settings"]) { _ in if !dirty { load() } }
        .onChange(of: preview.id) { _ in if !dirty { load() } }
        .onChange(of: preview["voice"]) { _ in if !dirty { load() } }
        .onChange(of: options) { _ in dirty = changed }
        .onChange(of: voice) { _ in dirty = changed }
        .onChange(of: identityValue) { _ in dirty = changed }
        .onDisappear { dirty = false }
    }
    var analysisRequirements: some View {
        VStack(alignment: .leading, spacing: 6) {
            if model.state["account"]["mode"].string != "live" { Text("Learning is unavailable in this view. Choose an individual connected account.") }
            if model.busy { Text("An operation is in progress. Wait for it to finish before continuing.") }
            if preview["status"].string == "running" { Text("Style analysis is running. Wait for the proposal before starting another analysis.") }
            if changed { Text("Unsaved changes: save identity or learning settings and save or discard proposal edits before learning again.") }
            if !savedOptions["enabled"].bool { Text("Learning opt-in is not saved. Enable learning in Learning configuration below, then choose Save Learning Settings.") }
            if !model.state["settings"]["ai"]["configured"].bool {
                HStack {
                    Text("Configure and save an AI model in Model settings first.")
                    if let onOpenSettings { Button("Open Model") { onOpenSettings("model") } }
                }
            }
            if !value["permitted"].bool {
                HStack {
                    Text("Requires saved learning opt-in plus AI Permissions: AI on, Email Brain, Sent, and email body access.")
                    if let onOpenSettings { Button("Open AI Permissions") { onOpenSettings("permissions") } }
                }
            }
            if model.policy["folders"]["sent"] == .bool(false) { Text("Sent access is off. Enable and save Sent in AI Permissions. Your confirmed identity can remain saved without Sent access.") }
        }.font(.caption).foregroundStyle(.secondary)
    }
    var configurationPanel: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 16) {
                Toggle("Enable writing-style learning for this account", isOn: flag("enabled")).toggleStyle(.checkbox)
                Toggle("Analyze newly sent mail weekly", isOn: flag("weekly")).toggleStyle(.checkbox).disabled(!options["enabled"].bool)
                Text("Weekly analysis uses cached Sent mail and this budget while Morrow is open. Enable mail refresh to capture mail sent elsewhere. Updates always require review and Save; a pending preview pauses the next analysis.").font(.caption).foregroundStyle(.secondary)
                Picker("Sent history", selection: number("months")) { ForEach([1, 3, 6, 12], id: \.self) { Text("Last \($0) month(s)").tag($0) } }
                Stepper("Maximum samples: \(Int(options["maxSamples"].number))", value: number("maxSamples"), in: 1...50)
                Text("Also limited by AI Permissions → Maximum messages (currently \(Int(model.policy["maxMessages"].number))).").font(.caption).foregroundStyle(.secondary)
                HStack { Text("Token budget per analysis"); TextField("16000", value: number("tokenBudget"), format: .number.grouping(.never)).frame(width: 120) }
                Text("4,000–64,000 tokens. Conservative UTF-8 estimate including response allowance; custom model billing may differ. No currency estimate.").font(.caption).foregroundStyle(.secondary)
                Button("Save Learning Settings") { action("settings", body: options) }.disabled(preview["status"].string == "running")
                if preview["status"].string == "running" { Text("Wait for the current analysis before saving learning settings.").font(.caption).foregroundStyle(.secondary) }
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text("Learning configuration")
                Text("Saved: \(savedOptions["enabled"].bool ? "Enabled" : "Off") · Weekly \(savedOptions["weekly"].bool ? "on" : "off") · \(Int(savedOptions["months"].number)) months · Up to \(Int(savedOptions["maxSamples"].number)) samples · \(Int(savedOptions["tokenBudget"].number)) tokens").font(.caption).foregroundStyle(.secondary)
                if options != savedOptions { Text("Unsaved learning settings").font(.caption).foregroundStyle(.secondary) }
            }
        }
    }
    var identityPanel: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 12) {
                Text("Confirm the names people use when addressing you, including in group mail. AI can use only your saved, confirmed identity under its existing permissions. Names inferred from signatures or messages are not automatically verified. This does not change your From address or Email Brain notes.").font(.callout).foregroundStyle(.secondary)
                TextField("Your display name", text: Binding(get: { identityName }, set: { identityName = $0; identityConfirmed = false }))
                TextArea(title: "Other names or nicknames — one per line", text: Binding(get: { identityAliases }, set: { identityAliases = $0; identityConfirmed = false }), height: 75)
                Text("Up to 10 aliases, 100 characters each. Include only names that refer to you.").font(.caption).foregroundStyle(.secondary)
                Toggle("I confirm this name and these aliases identify me for this account", isOn: $identityConfirmed).toggleStyle(.checkbox).disabled(identityName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                HStack {
                    Button("Save Identity · No AI Call") { action("settings", body: .object(["identity": identityValue])) }.disabled(!identityChanged)
                    Text(savedIdentity["confirmed"].bool ? "Saved identity confirmed" : "No confirmed identity is active").font(.caption).foregroundStyle(.secondary)
                }
                Text("Identity confirmation does not need Sent access or enable learning. Editing a name requires confirmation again; save with confirmation unchecked to stop using it.").font(.caption).foregroundStyle(.secondary)
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text("Your identity for this account")
                Text(savedIdentity["displayName"].nonempty ? "Saved: \(savedIdentity["displayName"].string) · \(savedIdentity["aliases"].array.count) aliases · \(savedIdentity["confirmed"].bool ? "Confirmed" : "Unconfirmed, not active")" : "No saved identity · Separate from writing-style learning").font(.caption).foregroundStyle(.secondary)
                if identityChanged { Text("Unsaved identity changes").font(.caption).foregroundStyle(.secondary) }
            }
        }
    }
    var previewPanel: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 12) {
                Text("\(preview["status"].string.capitalized) · \(Int(preview["sampleCount"].number)) / \(Int(preview["eligible"].number)) useful samples").font(.headline)
                if preview["status"].string == "ready" {
                    TextArea(title: "Review and edit proposed style", text: $voice, height: 150)
                    Text(preview["usage"]["total_tokens"].isNull ? "Provider token usage not supplied." : "Provider-reported tokens: \(Int(preview["usage"]["total_tokens"].number))").font(.caption)
                    Button("Save Approved Style") { action("apply", body: .object(["previewId": .string(preview.id), "voice": .string(voice)])) }.buttonStyle(.borderedProminent).disabled(voice.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || voice.count > 2000 || options != savedOptions)
                    if options != savedOptions { Text("Save or discard learning settings changes first. Saving settings replaces this proposal after confirmation.").font(.caption).foregroundStyle(.secondary) }
                    if voice.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || voice.count > 2000 { Text("The approved style must contain 1–2,000 characters.").font(.caption).foregroundStyle(.secondary) }
                    if model.busy { Text("Wait for the current operation before saving the approved style.").font(.caption).foregroundStyle(.secondary) }
                    if model.state["account"]["mode"].string != "live" { Text("Choose the proposal’s connected account before saving.").font(.caption).foregroundStyle(.secondary) }
                }
                Text("Estimated tokens ≤ \(Int(preview["estimatedTokens"].number)) · Budget \(Int(preview["tokenBudget"].number)) · Effective sample cap \(Int(preview["effectiveCap"].number))").font(.caption)
                Text("Quote/signature removal is heuristic. Review the exact text below.").font(.caption).foregroundStyle(.secondary)
                DisclosureGroup("Review text sent to the model") {
                    ForEach(Array(preview["samples"].array.enumerated()), id: \.offset) { index, sample in
                        VStack(alignment: .leading) { Text("Sample \(index + 1)").font(.caption.bold()); Text(sample["body"].string).textSelection(.enabled); Divider() }.padding(.vertical, 6)
                    }
                }
                if preview["error"].nonempty { Text(preview["error"].string).foregroundStyle(.orange) }
                if preview["status"].string == "prepared" {
                    Button("Analyze These Samples · Uses AI") { action("generate", body: .object(["previewId": .string(preview.id)])) }.buttonStyle(.borderedProminent).disabled(analysisBlocked)
                }
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    func loadIdentity() { identityName = savedIdentity["displayName"].string; identityAliases = savedIdentity["aliases"].array.map(\.string).joined(separator: "\n"); identityConfirmed = savedIdentity["confirmed"].bool }
    func loadStyle() { options = savedOptions; voice = preview["voice"].string }
    func load() { loadStyle(); loadIdentity(); dirty = false }
    func action(_ path: String, body: JSON = .object([:]), method: String = "POST", learnNow: Bool = false) {
        guard !model.busy, model.state["account"]["mode"].string == "live" else { return }
        if ["preview", "generate"].contains(path) && analysisBlocked { return }
        let owner = model.state["account"].id
        let identityOnly = path == "settings" && body.object.keys.allSatisfy { $0 == "identity" }
        if identityOnly && !preview.isNull && !model.confirm("Save identity and discard this style preview?", detail: "Pending AI results will be invalidated. Your approved style will be retained.") { return }
        if (path == "preview" || (path == "settings" && !identityOnly)) && preview["status"].string == "ready" && !model.confirm("Replace the current style proposal?", detail: "Your approved style will be retained.") { return }
        guard model.account == owner else { return }
        let keepIdentityEdits = identityChanged
        error = ""
        model.perform {
            do {
                let result = try await model.request("/style/\(path)", method: method, body: body, mailbox: owner)
                guard model.account == owner else { return }
                model.state = result
                if identityOnly { loadIdentity(); voice = preview["voice"].string } else { loadStyle(); if !keepIdentityEdits { loadIdentity() } }
                dirty = changed
                if learnNow {
                    let prepared = result["workspace"]["styleLearning"]["preview"]
                    guard prepared["status"].string == "prepared", !prepared.id.isEmpty, !analysisBlocked else { return }
                    let excerpts = prepared["samples"].array.prefix(2).enumerated().map { index, sample in
                        let text = sample["body"].string
                        return "Sample \(index + 1): \(text.prefix(200))\(text.count > 200 ? "…" : "")"
                    }.joined(separator: "\n\n")
                    let ai = result["settings"]["ai"]
                    let detail = "Account: \(owner) · Your Sent bodies only\nModel: \(ai["model"].string)\nEndpoint: \(ai["baseUrl"].string)\n\(Int(prepared["sampleCount"].number)) / \(Int(prepared["eligible"].number)) useful samples · Cap \(Int(prepared["effectiveCap"].number))\nEstimated tokens ≤ \(Int(prepared["estimatedTokens"].number)) · Budget \(Int(prepared["tokenBudget"].number))\n\nUp to 2 short excerpts; all selected samples will be analyzed:\n\(excerpts)\n\nCancel to review full samples below. Your approved style is retained until Save Approved Style. Continue with AI analysis?"
                    guard model.confirm("Learn Now · Uses AI", detail: detail), model.account == owner, !analysisBlocked else { return }
                    let generated = try await model.request("/style/generate", method: "POST", body: .object(["previewId": .string(prepared.id)]), mailbox: owner)
                    guard model.account == owner else { return }
                    model.state = generated; load()
                }
            } catch {
                guard model.account == owner else { return }
                self.error = error.localizedDescription
                if let refreshed = try? await model.request("/state", mailbox: owner), model.account == owner { model.state = refreshed }
            }
        }
    }
}
