import SwiftUI

struct NativeSearchSettingsView: View {
    @EnvironmentObject var model: AppModel
    @Binding var dirty: Bool
    @Binding var operationBusy: Bool
    enum Presentation { case search, model }
    var presentation: Presentation = .search
    var onConfigureModel: (() -> Void)?
    var onConfigurePermissions: (() -> Void)?
    var active = true
    @State private var value: JSON = .null
    @State private var options: JSON = .null
    @State private var baseline: JSON = .null
    @State private var error = ""
    @State private var busy = false
    @State private var testResult = ""
    @State private var revision = 0
    var indexing: Bool { value["job"]["status"].string == "running" }
    var changed: Bool { options != baseline }
    // indexVersion is supplied by Rust; Node has no batch-control routes.
    var batchControls: Bool { !value["indexVersion"].isNull }
    var resumable: Bool { batchControls && ["paused", "interrupted", "failed"].contains(value["job"]["status"].string) }
    var budgetExhausted: Bool { resumable && value["job"]["spentTokens"].number >= value["job"]["budget"].number }
    var prerequisites: [String] {
        guard presentation == .search, !options.isNull else { return [] }
        var reasons: [String] = []
        if changed { reasons.append("Save your changes before indexing.") }
        if !options["enabled"].bool { reasons.append("Enable Smart Search and save the search settings.") }
        if !value["settings"]["model"].nonempty { reasons.append("Save an embedding model in Model → Search Embedding.") }
        if !value["permitted"].bool { reasons.append("Enable AI access in AI Permissions and save permissions.") }
        if !options["accounts"].array.contains(where: { selected in model.accounts.contains(where: { $0.id == selected.string }) }) { reasons.append("Choose at least one connected account in Indexing scope. Add an account in Mail if needed.") }
        for group in ["folders", "content"] {
            let label = group == "folders" ? "folder" : "content field"
            if !options[group].object.values.contains(where: \.bool) { reasons.append("Choose at least one \(label) in Indexing scope.") }
            else if !options[group].object.contains(where: { $0.value.bool && model.policy[group][$0.key] != .bool(false) }) { reasons.append("Allow at least one selected \(label) in AI Permissions and save permissions.") }
        }
        return reasons
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SectionHeading(title: presentation == .model ? "Embedding model" : "Search & Semantic Indexing", detail: presentation == .model ? "Smart search (智慧搜尋) uses this separate embedding model. Choose indexing scope and review batches in Search." : "Keyword search stays local. Configure the embedding connection in Model. Smart search (智慧搜尋) is optional, stays within your approved scope, and each indexing batch needs review.")
            if !testResult.isEmpty { Text(testResult).foregroundStyle(.secondary).textSelection(.enabled) }
            if busy { ProgressView().controlSize(.small) }
            if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if options.isNull { ProgressView(presentation == .model ? "Loading embedding settings…" : "Loading search settings…") }
            else {
                if presentation == .search {
                    GroupBox("Saved embedding connection") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(value["settings"]["model"].nonempty ? value["settings"]["model"].string : "No embedding model saved").font(.headline)
                            Text(value["settings"]["baseUrl"].string).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                            Text(value["local"].bool ? "Local embedding endpoint" : "Remote embedding endpoint — approved mail text leaves this device").font(.caption).foregroundStyle(.secondary)
                            if presentation == .search {
                            HStack {
                                Button("Test Saved Embedding Connection") { action("test") }.disabled(indexing || !value["settings"]["model"].nonempty).accessibilityIdentifier("search.testConnection")
                                if let onConfigureModel { Button("Edit in Model…", action: onConfigureModel) }
                            }.disabled(busy)
                            Text("Tests the saved connection with a fixed sentence, never your mail. Does not save settings or change the index; the provider may charge for this request.").font(.caption).foregroundStyle(.secondary)
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(6)
                    }
                } else {
                    Text(value["local"].bool ? "Saved connection: local endpoint" : "Saved connection: remote endpoint").font(.caption).foregroundStyle(.secondary)
                }
                configuration.disabled(busy || indexing)
                if presentation == .search {
                    reviewPanel
                    Text("\(Int(value["indexed"].number)) / \(Int(value["eligible"].number)) eligible messages indexed · \(Int(value["pending"].number)) pending").font(.headline)
                    Text(value["local"].bool ? "Local embedding endpoint" : "Remote embedding endpoint — approved mail text leaves this device").font(.callout)
                    Text("Only downloaded mail is searchable. New or modified mail needs another reviewed batch; indexing never starts a paid request automatically.").font(.caption).foregroundStyle(.secondary)
                    if indexing { Text("Indexing continues in the background while Morrow is open. You can leave Search, Model or Settings; check Activity or return here for progress.").font(.callout).foregroundStyle(.secondary) }
                    if !value["job"].isNull { jobPanel }
                    DisclosureGroup("Clear index…") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Deletes all semantic vectors across indexed accounts and cancels the current batch. Your mail and keyword index stay available. Rebuilding requires another reviewed batch and may use provider tokens.").font(.caption)
                            Button("Clear Semantic Index…", role: .destructive) {
                                if model.confirm("Delete all semantic vectors and cancel indexing?", detail: "This clears vectors across indexed accounts. Your mail and keyword index stay available. Rebuilding may use provider tokens.") { action("index/clear") }
                            }.disabled(busy)
                        }
                    }
                }
            }
        }
        .task(id: active) {
            guard active else { return }
            let version = revision
            do {
                var next = try await model.request("/search/settings")
                guard !Task.isCancelled, version == revision else { return }
                if next["job"].id == value["job"].id { next["samples"] = value["samples"] }
                if changed { value = next } else { initialize(next) }
                error = ""
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
        .task(id: indexing && active) {
            guard indexing && active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 1_500_000_000); if busy { continue }; let version = revision; let next = try await model.request("/search/settings"); guard !Task.isCancelled else { return }; if version == revision { value = next; error = "" } } catch { if Task.isCancelled { return }; self.error = error.localizedDescription }
            }
        }
        .onChange(of: options) { _ in dirty = changed; testResult = "" }
        .onDisappear { dirty = false; operationBusy = false }
    }
    var configuration: some View {
        VStack(alignment: .leading, spacing: 14) {
            if presentation == .model {
                Picker("Embedding protocol", selection: text("protocol")) { Text("OpenAI-compatible /embeddings").tag("openai"); Text("Ollama native /api/embed").tag("ollama") }
                field("Embedding base URL", "baseUrl")
                Text("Local OpenAI-compatible: http://127.0.0.1:11434/v1. Ollama native: http://127.0.0.1:11434. Remote endpoints require HTTPS.").font(.caption).foregroundStyle(.secondary)
                field("Embedding model ID", "model")
                Text("Use an embedding model, not a chat-only model. A change of model or scope invalidates existing vectors.").font(.caption).foregroundStyle(.secondary)
                VStack(alignment: .leading) { Text("Embedding API key").font(.caption); SecureField("Optional for local models", text: text("apiKey")) }
                Text(value["settings"]["hasApiKey"].bool ? "Leave blank to keep the saved key at the same base URL. Changing the base URL requires entering the key again." : "No embedding API key saved.").font(.caption).foregroundStyle(.secondary)
                if value["settings"]["hasApiKey"].bool { Toggle("Remove saved key", isOn: flag("clearApiKey")).toggleStyle(.checkbox) }
            } else {
                Toggle("Enable Smart Search", isOn: flag("enabled")).toggleStyle(.checkbox)
                DisclosureGroup("Indexing scope · \(options["accounts"].array.count) account(s) · Last \(Int(options["months"].number)) month(s)") {
                VStack(alignment: .leading, spacing: 14) {
                GroupBox("Accounts to index") { VStack(alignment: .leading) { ForEach(model.accounts) { account in
                    Toggle(account["email"].string, isOn: Binding(get: { options["accounts"].array.contains(.string(account.id)) }, set: { selected in
                        var values = options["accounts"].array.filter { $0 != .string(account.id) }; if selected { values.append(.string(account.id)) }; options["accounts"] = .array(values)
                    })).toggleStyle(.checkbox)
                } }.frame(maxWidth: .infinity, alignment: .leading).padding(6) }
                HStack(alignment: .top) { scopeGroup("Folders", "folders"); scopeGroup("Allowed Content", "content") }
                Text("Global AI permissions also apply. Unchecked fields and folders are excluded before embedding requests. Each account is indexed in separate requests.").font(.caption).foregroundStyle(.secondary)
                Picker("Index history", selection: number("months")) { ForEach([1, 3, 6, 12], id: \.self) { Text("Last \($0) month(s)").tag($0) } }
                HStack { Text("Estimated token budget per batch"); TextField("16000", value: number("tokenBudget"), format: .number.grouping(.never)).frame(width: 120) }
                Text("4,000–64,000 tokens. Conservative UTF-8 estimate, not a billing guarantee. Batches also respect the global message limit and at most 50 text chunks. Unchanged text is reused.").font(.caption).foregroundStyle(.secondary)
                }
                }
            }
            HStack {
                if changed {
                    Button(presentation == .model ? "Save Embedding Model" : "Save Search Settings") { action("settings", body: options) }.buttonStyle(.borderedProminent)
                    Button("Discard Changes") { initialize(value) }
                }
                if presentation == .model {
                    Button("Test Embedding Connection") { action("test", body: options) }.disabled(options["model"].string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            if presentation == .model { Text("Test Connection sends only a fixed test sentence, never your mail. It uses the fields above without saving them and may use provider tokens.").font(.caption).foregroundStyle(.secondary) }
            if presentation == .model && indexing { Text("An indexing batch is running. Wait for it to finish, or manage the batch in Search, before editing the embedding connection.").font(.caption).foregroundStyle(.secondary) }
        }
    }
    var reviewPanel: some View {
        GroupBox("Check scope → Review & Index") {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(prerequisites, id: \.self) { Text($0).font(.callout) }
                if let onConfigurePermissions { Button("Open AI Permissions…", action: onConfigurePermissions).disabled(busy) }
                if resumable { Text("Resume or cancel the current batch before reviewing another.").font(.callout) }
                if !changed && prerequisites.isEmpty && !indexing && !resumable && value["pending"].number == 0 { Text("No new permitted downloaded mail needs indexing. Check Indexing scope and AI Permissions, or download mail in Mail.").font(.callout) }
                Button("Review & Index…") { action("index/now") }.buttonStyle(.borderedProminent).disabled(busy || indexing || resumable || !prerequisites.isEmpty || value["pending"].number == 0)
                Text("Review the saved accounts, folders, content and batch budget first. No AI call is made until you confirm the reviewed batch. Model or scope changes invalidate existing vectors.").font(.caption).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(6)
        }
    }
    var jobPanel: some View {
        GroupBox("Indexing batch") {
            VStack(alignment: .leading, spacing: 8) {
                Text("\(value["job"]["status"].string) · \(Int(value["job"]["completed"].number)) / \(Int(value["job"]["sampleCount"].number)) messages").font(.headline)
                Text("\(Int(value["job"]["chunks"].number)) chunks · estimated tokens ≤ \(Int(value["job"]["estimatedTokens"].number)) · \(Int(value["job"]["oversized"].number)) oversized messages excluded.").font(.caption)
                if value["job"]["error"].nonempty { Text(value["job"]["error"].string).foregroundStyle(.red) }
                if !value["samples"].array.isEmpty {
                    DisclosureGroup("Review excerpts (first three messages)") {
                        ForEach(Array(value["samples"].array.enumerated()), id: \.offset) { item in VStack(alignment: .leading) { Text(item.element["account"].string).bold(); Text(item.element["text"].string).textSelection(.enabled) }.font(.caption).padding(.vertical, 6) }
                    }
                }
                if batchControls {
                    Text("Pause keeps batch progress; cancel discards unfinished work. Completed valid vectors remain. In-flight requests may already have used provider tokens.").font(.caption).foregroundStyle(.secondary)
                    if resumable {
                        Text("Estimated tokens charged to batch budget: \(Int(value["job"]["spentTokens"].number)) / \(Int(value["job"]["budget"].number)).").font(.caption)
                        if budgetExhausted { Text("Budget exhausted. Cancel this batch, then review another to authorize more tokens.").font(.callout) }
                    }
                    HStack {
                        if indexing { Button("Pause Batch") { action("index/pause") } }
                        if resumable { Button("Resume Batch…") { action("index/resume") }.disabled(!prerequisites.isEmpty || budgetExhausted) }
                        if ["prepared", "running", "paused", "interrupted", "failed"].contains(value["job"]["status"].string) {
                            Button("Cancel Batch…") {
                                if model.confirm("Cancel this batch?", detail: "Unfinished work is discarded; completed valid vectors and your mail are kept.") { action("index/cancel") }
                            }
                        }
                    }.disabled(busy)
                } else { Text("This compatibility service does not support pause, resume or cancel without clearing vectors. Failed or interrupted batches need a new review.").font(.caption).foregroundStyle(.secondary) }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
        }
    }
    func text(_ key: String) -> Binding<String> { Binding(get: { options[key].string }, set: { options[key] = .string($0) }) }
    func flag(_ key: String) -> Binding<Bool> { Binding(get: { options[key].bool }, set: { options[key] = .bool($0) }) }
    func number(_ key: String) -> Binding<Int> { Binding(get: { Int(options[key].number) }, set: { options[key] = .number(Double($0)) }) }
    func field(_ title: String, _ key: String) -> some View { VStack(alignment: .leading, spacing: 3) { Text(title).font(.caption); TextField(title, text: text(key)) } }
    func scopeGroup(_ title: String, _ group: String) -> some View {
        GroupBox(title) { VStack(alignment: .leading) { ForEach(options[group].object.keys.sorted(), id: \.self) { key in Toggle(key == "sender" ? "Sender / To / Cc / Bcc" : key.capitalized, isOn: Binding(get: { options[group][key].bool }, set: { options[group][key] = .bool($0) })).toggleStyle(.checkbox) } }.frame(maxWidth: .infinity, alignment: .leading).padding(6) }
    }
    func initialize(_ next: JSON) {
        value = next
        var fields = next["settings"].picking(presentation == .model ? ["baseUrl", "model", "protocol"] : ["enabled", "accounts", "months", "tokenBudget", "folders", "content"])
        if presentation == .model { fields["apiKey"] = .string(""); fields["clearApiKey"] = .bool(false) }
        options = fields; baseline = fields; dirty = false
    }
    func action(_ path: String, body: JSON = .object([:])) {
        guard !busy, !model.busy, !indexing || ["index/pause", "index/cancel", "index/clear"].contains(path) else { return }
        if ["index/now", "index/resume"].contains(path) { guard presentation == .search, prerequisites.isEmpty, path != "index/now" || !resumable else { return } }
        var body = body
        if ["index/pause", "index/resume", "index/cancel"].contains(path) {
            guard batchControls, value["job"]["id"].nonempty, path != "index/resume" || (resumable && !budgetExhausted) else { return }
            body = .object(["previewId": .string(value["job"].id)])
        }
        busy = true; operationBusy = true; revision += 1; error = ""
        testResult = ""
        Task {
            // Only this request/confirmation blocks navigation; the service owns the batch.
            defer { busy = false; operationBusy = false }
            do {
                if path == "index/resume" {
                    let settings = value["settings"], job = value["job"]
                    let accounts = settings["accounts"].array.map(\.string).joined(separator: ", ")
                    guard model.confirm("Resume this reviewed batch?", detail: "Model: \(settings["model"].string)\nEndpoint: \(settings["baseUrl"].string)\nAccounts: \(accounts)\n\(Int(job["completed"].number)) / \(Int(job["sampleCount"].number)) messages completed.\nEstimated tokens charged to this batch budget: \(Int(job["spentTokens"].number)) / \(Int(job["budget"].number)).\nOnly the remaining approved batch will run. An interrupted request may already have used provider tokens; resuming may charge again.") else { return }
                }
                let next = try await model.request("/search/" + (path == "index/now" ? "index/preview" : path), method: "POST", body: body)
                if path == "test" {
                    testResult = "Connection successful · \(Int(next["dimensions"].number)) dimensions. Settings were not changed."
                } else if path == "settings" { initialize(next) }
                else {
                    value = next
                    if path == "index/now" {
                        let settings = next["settings"], job = next["job"]
                        let accounts = settings["accounts"].array.map(\.string).joined(separator: ", ")
                        let folders = settings["folders"].object.filter { $0.value.bool }.keys.sorted().joined(separator: ", ")
                        let fields = settings["content"].object.filter { $0.value.bool }.keys.sorted().joined(separator: ", ")
                        let excerpts = next["samples"].array.map { $0["account"].string + ": " + String($0["text"].string.prefix(200)) }.joined(separator: "\n\n")
                        guard model.confirm("Start this indexing batch?", detail: "Model: \(settings["model"].string)\nEndpoint: \(settings["baseUrl"].string)\nAccounts: \(accounts)\nFolders: \(folders) · Fields: \(fields) · Last \(Int(settings["months"].number)) months\n\(Int(job["sampleCount"].number)) messages · \(Int(job["chunks"].number)) chunks · estimated tokens ≤ \(Int(job["estimatedTokens"].number))\nBudget: \(Int(settings["tokenBudget"].number)) tokens. Remote models may charge.\n\nShort excerpts (cancel to review more on this page):\n\(excerpts)") else { return }
                        value = try await model.request("/search/index/run", method: "POST", body: .object(["previewId": .string(job.id)]))
                    }
                }
            } catch { self.error = error.localizedDescription }
        }
    }
}
