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
    var skipped: Double { value["skipped"]["oversized"].number + value["skipped"]["batchBudget"].number + value["skipped"]["dailyLimit"].number }
    var changed: Bool { options != baseline }
    // indexVersion is supplied by Rust; Node has no batch-control routes.
    var batchControls: Bool { !value["indexVersion"].isNull }
    var resumable: Bool { batchControls && ["paused", "interrupted", "failed"].contains(value["job"]["status"].string) }
    var budgetExhausted: Bool { resumable && value["job"]["spentTokens"].number >= value["job"]["budget"].number }
    var prerequisites: [String] {
        guard presentation == .search, !options.isNull else { return [] }
        var reasons: [String] = []
        if !value["settings"]["model"].nonempty { reasons.append("Save an embedding model in Advanced setup → AI connection → Search embedding.") }
        if !value["permitted"].bool { reasons.append("Enable AI access in AI & privacy and save permissions.") }
        if !options["accounts"].array.contains(where: { selected in model.accounts.contains(where: { $0.id == selected.string }) }) { reasons.append("Choose at least one connected account in Indexing scope. Add an account in Mail if needed.") }
        for group in ["folders", "content"] {
            let label = group == "folders" ? "folder" : "content field"
            if !options[group].object.values.contains(where: \.bool) { reasons.append("Choose at least one \(label) in Indexing scope.") }
            else if !options[group].object.contains(where: { $0.value.bool && model.policy[group][$0.key] != .bool(false) }) { reasons.append("Allow at least one selected \(label) in AI & privacy and save permissions.") }
        }
        return reasons
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SectionHeading(title: presentation == .model ? "Embedding model" : "Search & Semantic Indexing", detail: presentation == .model ? "Smart search (智慧搜尋) uses this separate embedding model. Review accounts and permitted content in Search index." : "Index downloaded mail once and keep it updated while Morrow is open. Keyword search stays local and remains available during indexing.")
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
                                if let onConfigureModel { Button("Edit AI Connection…", action: onConfigureModel) }
                            }.disabled(busy)
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(6)
                    }
                } else {
                    Text(value["local"].bool ? "Saved connection: local endpoint" : "Saved connection: remote endpoint").font(.caption).foregroundStyle(.secondary)
                }
                configuration.disabled(busy || (indexing && presentation == .model))
                if presentation == .search {
                    if value["settings"]["autoIndex"].bool {
                        GroupBox("Automatic indexing") {
                            VStack(alignment: .leading, spacing: 8) {
                                if !value["automatic"]["approved"].bool { Text("Model, permissions or scope changed. Review before continuing.") }
                                else if ["failed", "interrupted"].contains(value["job"]["status"].string) { Text("Indexing stopped. Review before retrying; the last request may already have used tokens.") }
                                else if value["automatic"]["waitingForBudget"].bool { Text("Daily limit reached — resumes automatically at midnight UTC while Morrow is open.") }
                                else if ["paused", "cancelled"].contains(value["job"]["status"].string) { Text("Indexing is paused. Review before continuing.") }
                                else { Text(value["pending"].number == 0 ? "Up to date — new and changed mail will be indexed automatically." : value["pending"].number == skipped ? "Supported messages are indexed. Remaining messages are skipped by size limits." : "Keeps downloaded mail indexed while Morrow is open.") }
                                Text("Today: \(Int(value["automatic"]["spentToday"].number)) / \(Int(value["settings"]["dailyTokenBudget"].number)) estimated tokens · resets at midnight UTC").font(.caption)
                                if value["job"]["error"].nonempty { Text(value["job"]["error"].string).foregroundStyle(.red) }
                                Button("Pause automatic indexing") { action("settings", body: .object(["autoIndex": .bool(false)])) }.disabled(busy)
                                Text("Pausing keeps completed indexes and keyword search. In-flight requests may already have used tokens.").font(.caption).foregroundStyle(.secondary)
                            }.padding(8)
                        }
                    } else if value["settings"]["enabled"].bool { Text("Automatic indexing is paused. Completed indexes remain searchable.").foregroundStyle(.secondary) }
                    Text("\(Int(value["indexed"].number)) / \(Int(value["eligible"].number)) eligible messages indexed · \(Int(value["pending"].number - skipped)) pending").font(.headline)
                    if skipped > 0 { Text("\(Int(skipped)) messages skipped by size limits; keyword search still covers them. See Advanced indexing options.").font(.caption).foregroundStyle(.secondary) }
                    Text(value["local"].bool ? "Local embedding endpoint" : "Remote embedding endpoint — approved mail text leaves this device").font(.callout)
                    Text("Only downloaded mail in approved accounts, folders and content fields is indexed. Remote indexing and semantic queries may incur charges; the daily limit covers indexing, not queries.").font(.caption).foregroundStyle(.secondary)
                    if indexing { Text("Indexing continues in the background while Morrow is open. You can leave Search, Model or Settings; check Activity or return here for progress.").font(.callout).foregroundStyle(.secondary) }
                    DisclosureGroup("Manual indexing & maintenance") { reviewPanel; if !value["job"].isNull { jobPanel } }
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
        .task(id: (indexing || value["settings"]["autoIndex"].bool) && active) {
            guard (indexing || value["settings"]["autoIndex"].bool) && active else { return }
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
                if value["settings"]["hasApiKey"].bool {
                    Text("API key saved. Changing models on the same endpoint reuses it.").font(.caption).foregroundStyle(.secondary)
                    DisclosureGroup("Replace saved API key") {
                        SecureField("New API key", text: text("apiKey")).disabled(options["clearApiKey"].bool)
                    }
                } else {
                    VStack(alignment: .leading) { Text("Embedding API key").font(.caption); SecureField("Optional for local models", text: text("apiKey")) }
                }
                Text("Changing the base URL requires a key for that endpoint. Leave the key blank to reuse it at the same endpoint.").font(.caption).foregroundStyle(.secondary)
                if value["settings"]["hasApiKey"].bool { Toggle("Remove saved key", isOn: flag("clearApiKey")).toggleStyle(.checkbox) }
            } else {
                VStack(alignment: .leading, spacing: 14) {
                GroupBox("Accounts to index") { VStack(alignment: .leading) { ForEach(model.accounts) { account in
                    Toggle(account["email"].string, isOn: Binding(get: { options["accounts"].array.contains(.string(account.id)) }, set: { selected in
                        var values = options["accounts"].array.filter { $0 != .string(account.id) }; if selected { values.append(.string(account.id)) }; options["accounts"] = .array(values)
                    })).toggleStyle(.checkbox)
                } }.frame(maxWidth: .infinity, alignment: .leading).padding(6) }
                HStack(alignment: .top) { scopeGroup("Folders", "folders"); scopeGroup("Allowed Content", "content") }
                Text("Global AI permissions also apply. Unchecked fields and folders are excluded before embedding requests. Each account is indexed in separate requests.").font(.caption).foregroundStyle(.secondary)
                Picker("Index history", selection: number("months")) { Text("All downloaded mail").tag(0); ForEach([1, 3, 6, 12], id: \.self) { Text("Last \($0) month(s)").tag($0) } }
                DisclosureGroup("Advanced indexing options") {
                Toggle("Enable Smart Search", isOn: flag("enabled")).toggleStyle(.checkbox)
                HStack { Text("Daily indexing limit"); TextField("100000", value: number("dailyTokenBudget"), format: .number.grouping(.never)).frame(width: 120); Text("estimated tokens").font(.caption) }
                Text("4,000–2,000,000 estimated tokens per UTC day. Indexing resumes automatically after the daily limit resets.").font(.caption).foregroundStyle(.secondary)
                HStack { Text("Estimated token budget per batch"); TextField("16000", value: number("tokenBudget"), format: .number.grouping(.never)).frame(width: 120) }
                Text("4,000–64,000 tokens. Conservative UTF-8 estimate, not a billing guarantee. Batches also respect the global message limit and at most 50 text chunks. Unchanged text is reused.").font(.caption).foregroundStyle(.secondary)
                Text("Skipped: \(Int(value["skipped"]["oversized"].number)) exceed 50 chunks; \(Int(value["skipped"]["batchBudget"].number)) exceed the per-message batch budget; \(Int(value["skipped"]["dailyLimit"].number)) have a chunk larger than the daily limit. Semantic searches require narrower filters above 12,000 chunks or 4 million vector values.").font(.caption).foregroundStyle(.secondary)
                if changed { Button("Save Search Settings") { action("settings", body: options) } }
                }
                }
            }
            if presentation == .search {
                ForEach(prerequisites, id: \.self) { Text($0).font(.callout) }
                if !prerequisites.isEmpty, let onConfigurePermissions { Button("Open AI & privacy…", action: onConfigurePermissions) }
            }
            HStack {
                if presentation == .search && (!value["settings"]["autoIndex"].bool || !value["automatic"]["approved"].bool || changed || resumable || value["job"]["status"].string == "cancelled") {
                    Button(options["months"].number == 0 ? "Index all downloaded mail & keep updated…" : "Index selected mail & keep updated…") {
                        var next = options; next["enabled"] = .bool(true); next["autoIndex"] = .bool(true); action("settings", body: next)
                    }.buttonStyle(.borderedProminent).disabled(!prerequisites.isEmpty)
                }
                if changed {
                    if presentation == .model { Button("Save Embedding Model") { action("settings", body: options) }.buttonStyle(.borderedProminent) }
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
                if changed { Text("Save your changes before reviewing a manual batch.") }
                if !options["enabled"].bool { Text("Enable Smart Search before reviewing a manual batch.") }
                if let onConfigurePermissions { Button("Open AI & privacy…", action: onConfigurePermissions).disabled(busy) }
                if resumable { Text("Resume or cancel the current batch before reviewing another.").font(.callout) }
                if !changed && prerequisites.isEmpty && !indexing && !resumable && value["pending"].number == 0 { Text("No new permitted downloaded mail needs indexing. Check Indexing scope and AI & privacy, or download mail in Mail.").font(.callout) }
                Button("Review & Index…") { action("index/now") }.disabled(busy || indexing || resumable || changed || !options["enabled"].bool || !prerequisites.isEmpty || value["pending"].number == 0)
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
                        if ["prepared", "running", "paused", "interrupted", "failed", "budget_wait"].contains(value["job"]["status"].string) {
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
        var fields = next["settings"].picking(presentation == .model ? ["baseUrl", "model", "protocol"] : ["enabled", "autoIndex", "dailyTokenBudget", "accounts", "months", "tokenBudget", "folders", "content"])
        if presentation == .model { fields["apiKey"] = .string(""); fields["clearApiKey"] = .bool(false) }
        options = fields; baseline = fields; dirty = false
    }
    func action(_ path: String, body: JSON = .object([:])) {
        guard !busy, !model.busy, !indexing || ["settings", "index/pause", "index/cancel", "index/clear"].contains(path) else { return }
        if ["index/now", "index/resume"].contains(path) { guard presentation == .search, !changed, options["enabled"].bool, prerequisites.isEmpty, path != "index/now" || !resumable else { return } }
        var body = body
        if ["index/pause", "index/resume", "index/cancel"].contains(path) {
            guard batchControls, value["job"]["id"].nonempty, path != "index/resume" || (resumable && !budgetExhausted) else { return }
            body = .object(["previewId": .string(value["job"].id)])
        }
        if path == "settings" && body["autoIndex"].bool {
            let saved = value["settings"]
            let scope = body["accounts"].array.map(\.string).joined(separator: ", ")
            let folders = body["folders"].object.filter { $0.value.bool }.keys.sorted().joined(separator: ", ")
            let fields = body["content"].object.filter { $0.value.bool }.keys.sorted().joined(separator: ", ")
            guard model.confirm("Index this scope and keep it updated?", detail: "Model: \(saved["model"].string)\nEndpoint: \(saved["baseUrl"].string)\nAccounts: \(scope)\nFolders: \(folders)\nContent: \(fields)\nHistory: \(indexHistoryLabel(body))\nDaily limit: \(Int(body["dailyTokenBudget"].number)) estimated tokens, resets at midnight UTC.\nDownloaded, new and changed mail in this scope will be sent automatically while Morrow is open. Provider charges may apply. Retrying after an interrupted request may charge again.") else { return }
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
                } else if path == "settings" {
                    if body.object.count == 1 && body["autoIndex"] == .bool(false) {
                        value = next; options["autoIndex"] = .bool(false); baseline["autoIndex"] = .bool(false); dirty = changed
                    } else { initialize(next) }
                }
                else {
                    value = next
                    if path == "index/now" {
                        let settings = next["settings"], job = next["job"]
                        let accounts = settings["accounts"].array.map(\.string).joined(separator: ", ")
                        let folders = settings["folders"].object.filter { $0.value.bool }.keys.sorted().joined(separator: ", ")
                        let fields = settings["content"].object.filter { $0.value.bool }.keys.sorted().joined(separator: ", ")
                        let excerpts = next["samples"].array.map { $0["account"].string + ": " + String($0["text"].string.prefix(200)) }.joined(separator: "\n\n")
                        guard model.confirm("Start this indexing batch?", detail: "Model: \(settings["model"].string)\nEndpoint: \(settings["baseUrl"].string)\nAccounts: \(accounts)\nFolders: \(folders) · Fields: \(fields) · \(indexHistoryLabel(settings))\n\(Int(job["sampleCount"].number)) messages · \(Int(job["chunks"].number)) chunks · estimated tokens ≤ \(Int(job["estimatedTokens"].number))\nBudget: \(Int(settings["tokenBudget"].number)) tokens. Remote models may charge.\n\nShort excerpts (cancel to review more on this page):\n\(excerpts)") else { return }
                        value = try await model.request("/search/index/run", method: "POST", body: .object(["previewId": .string(job.id)]))
                    }
                }
            } catch { self.error = error.localizedDescription }
        }
    }
}
