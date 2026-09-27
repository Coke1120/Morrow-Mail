import SwiftUI

struct NativeSearchSettingsView: View {
    @EnvironmentObject var model: AppModel
    @Binding var dirty: Bool
    @Binding var operationBusy: Bool
    enum Presentation { case search, model }
    var presentation: Presentation = .search
    var onConfigureModel: (() -> Void)?
    @State private var value: JSON = .null
    @State private var options: JSON = .null
    @State private var baseline: JSON = .null
    @State private var error = ""
    @State private var busy = false
    @State private var testResult = ""
    var indexing: Bool { value["job"]["status"].string == "running" }
    var changed: Bool { options != baseline }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SectionHeading(title: presentation == .model ? "Embedding model" : "Search & Semantic Indexing", detail: presentation == .model ? "Smart search (智慧搜尋) uses this separate embedding model. Choose indexing scope and review batches in Search." : "Keyword search stays local. Configure the embedding connection in Model. Smart search (智慧搜尋) is optional, stays within your approved scope, and each indexing batch needs review.")
            if !testResult.isEmpty { Text(testResult).foregroundStyle(.secondary).textSelection(.enabled) }
            if busy { ProgressView().controlSize(.small) }
            if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if options.isNull { ProgressView(presentation == .model ? "Loading embedding settings…" : "Loading search settings…") }
            else {
                if presentation == .search {
                    GroupBox("Embedding connection") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(value["settings"]["model"].nonempty ? value["settings"]["model"].string : "No embedding model saved").font(.headline)
                            Text(value["settings"]["baseUrl"].string).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                            HStack {
                                Button("Test Connection") { action("test") }.disabled(indexing || !value["settings"]["model"].nonempty).accessibilityIdentifier("search.testConnection")
                                if let onConfigureModel { Button("Edit in Model…", action: onConfigureModel) }
                            }.disabled(busy)
                            Text("Tests the saved connection with a fixed sentence, never your mail. Does not save settings or change the index; the provider may charge for this request.").font(.caption).foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(6)
                    }
                }
                configuration.disabled(busy || indexing)
                Group {
                    Text("\(Int(value["indexed"].number)) / \(Int(value["eligible"].number)) eligible messages indexed · \(Int(value["pending"].number)) pending").font(.headline)
                    Text(value["local"].bool ? "Local embedding endpoint" : "Remote embedding endpoint — approved mail text leaves this device").font(.callout)
                    Text("Only downloaded mail is searchable. New or modified mail needs another reviewed batch; indexing never starts a paid request automatically.").font(.caption).foregroundStyle(.secondary)
                    if indexing { Text("Indexing continues in the background while Morrow is open. You can leave Search, Model or Settings; check Activity or return here for progress.").font(.callout).foregroundStyle(.secondary) }
                    if !value["job"].isNull { jobPanel }
                    Button("Clear Semantic Index / Cancel Batch") {
                        if model.confirm("Delete semantic vectors and cancel indexing?", detail: "Your mail and keyword index stay available.") { action("index/clear") }
                    }.disabled(busy)
                }
            }
        }
        .task { do { let next = try await model.request("/search/settings"); if !Task.isCancelled { initialize(next) } } catch { if !Task.isCancelled { self.error = error.localizedDescription } } }
        .task(id: indexing) {
            guard indexing else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 1_500_000_000); let next = try await model.request("/search/settings"); guard !Task.isCancelled else { return }; value = next; error = "" } catch { if Task.isCancelled { return }; self.error = error.localizedDescription }
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
                Text(value["settings"]["hasApiKey"].bool ? "Leave blank to keep the saved key at the same base URL." : "No embedding API key saved.").font(.caption).foregroundStyle(.secondary)
                Toggle("Remove saved key", isOn: flag("clearApiKey")).toggleStyle(.checkbox)
            } else {
                Toggle("Enable Smart Search", isOn: flag("enabled")).toggleStyle(.checkbox)
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
            HStack {
                Button(presentation == .model ? "Save Embedding Model" : "Save Search Settings") { action("settings", body: options) }.buttonStyle(.borderedProminent)
                if presentation == .model {
                    Button("Test Connection") { action("test", body: options) }.disabled(options["model"].string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Button("Index Now…") { action("index/now") }.disabled(changed || !value["settings"]["enabled"].bool || !value["permitted"].bool)
                if presentation == .search {
                    Button("Preview Next Batch · No AI Call") { action("index/preview") }.disabled(changed || !options["enabled"].bool || !value["permitted"].bool)
                }
            }
            if presentation == .model { Text("Test Connection sends only a fixed test sentence, never your mail. It uses the fields above without saving them and may use provider tokens.").font(.caption).foregroundStyle(.secondary) }
            Text(changed ? "Save your changes before indexing." : "Index Now reviews one batch within the saved Search scope and token budget, then asks you to confirm before sending mail text to the embedding model. Enable Smart Search and choose accounts in Search first.").font(.caption).foregroundStyle(.secondary)
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
                if value["job"]["status"].string == "prepared" { Button("Index Reviewed Batch · Uses Embeddings") { action("index/run", body: .object(["previewId": .string(value["job"].id)])) }.buttonStyle(.borderedProminent).disabled(changed || busy) }
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
        guard !busy, !model.busy, !indexing || path == "index/clear" else { return }; busy = true; operationBusy = true; error = ""
        testResult = ""
        Task {
            // Only this request/confirmation blocks navigation; the service owns the batch.
            defer { busy = false; operationBusy = false }
            do {
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
