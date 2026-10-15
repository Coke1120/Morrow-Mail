import SwiftUI

func searchHighlighted(_ parts: JSON, fallback: String) -> Text {
    if parts.array.isEmpty { return Text(fallback) }
    return parts.array.reduce(Text("")) { result, part in
        result + (part["hit"].bool ? Text(part["text"].string).bold().foregroundColor(morrowGreen) : Text(part["text"].string))
    }
}

struct NativeMailSearch: View {
    @EnvironmentObject var model: AppModel
    @State private var query = ""
    @State private var scope = "folder"
    @State private var sort = "relevance"
    @State private var searchFolder = ""
    @State private var filters: JSON = .object([:])
    @State private var smart = false
    @State private var advanced = false
    @State private var searching = false
    @State private var history: JSON = .null
    @State private var error = ""
    @State private var ticket = UUID()
    @State private var operation: Task<Void, Never>?
    @FocusState private var focused: Bool
    var active: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || scope != "folder" || (!searchFolder.isEmpty && searchFolder != model.section) || filters.object.values.contains(where: \.nonempty) }
    var options: JSON { .object(["query": .string(query), "scope": .string(scope), "folder": .string(searchFolder.isEmpty ? model.section : searchFolder), "sort": .string(sort), "filters": filters, "smart": .bool(smart)]) }
    var result: JSON { model.searchResponse }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search mail · from:, after:, or an exact phrase", text: $query).focused($focused).textFieldStyle(.roundedBorder).onSubmit { run(record: true) }.accessibilityLabel("Search mail")
                Button("Clear") { clear() }.help("Clear search and all filters")
                Button("Search") { run(record: true) }.disabled(searching)
                Button(advanced ? "Hide Filters" : "Filters & Scope") { advanced.toggle() }
                Menu("Recent / Saved") {
                    if active { Button("Save This Search") { remember("save", value: options) } }
                    Section("Saved") { ForEach(Array(history["saved"].array.enumerated()), id: \.offset) { item in
                        Menu(historyLabel(item.element)) { Button("Use Search") { restore(item.element) }; Button("Remove Saved Search") { remember("remove", value: item.element) } }
                    } }
                    Section("Recent") { ForEach(Array(history["recent"].array.enumerated()), id: \.offset) { item in Button(historyLabel(item.element)) { restore(item.element) } } }
                    Button("Clear Recent Searches") { remember("clear") }
                }
            }
            HStack {
                Text("Search downloaded content. Incomplete bodies may not match.").font(.caption).foregroundStyle(.secondary)
                Spacer()
                DownloadControlsButton(owner: model.account).controlSize(.small)
            }
            if advanced { filterPanel }
            if !filters.object.values.filter(\.nonempty).isEmpty || !result["chips"].array.isEmpty {
                ScrollView(.horizontal) { HStack {
                    ForEach(filters.object.keys.sorted(), id: \.self) { key in if filters[key].nonempty { Button("\(key): \(filters[key].string) ×") { filters[key] = .string("") }.help("Remove \(key) filter") } }
                    ForEach(Array(result["chips"].array.enumerated()), id: \.offset) { item in Button(item.element["label"].string + " ×") { query = item.element["query"].string } }
                } }.controlSize(.small)
            }
            if searching { ProgressView("Searching…").controlSize(.small) }
            if !error.isEmpty { Text(error).foregroundStyle(.red).font(.caption).textSelection(.enabled) }
            if result["waiting"].bool && smart { Text("Press Search to run semantic matching.").font(.caption).foregroundStyle(.secondary) }
            if !result["total"].isNull { resultStatus }
        }.padding(12).background(.bar)
        .onChange(of: options) { _ in schedule() }
        .onChange(of: model.state) { _ in refresh() }
        .onChange(of: model.searchFocus) { _ in focused = true }
        .task { model.searchResponse = .null; history = (try? await model.request("/search/preferences")) ?? .null }
        .onDisappear { operation?.cancel(); ticket = UUID(); model.searchResponse = .null }
    }
    var filterPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Picker("Scope", selection: $scope) { Text("Folder: \(searchFolder.isEmpty ? model.section : searchFolder)").tag("folder"); Text("Current account view").tag("account"); Text("All connected accounts").tag("all") }
                Picker("Order", selection: $sort) { Text("Most relevant").tag("relevance"); Text("Newest first").tag("newest"); Text("Oldest first").tag("oldest") }
            }
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                filterField("From", "from"); filterField("To / Cc / Bcc", "to"); filterField("Subject", "subject")
                filterField("Label", "label"); filterField("On / after (YYYY-MM-DD, UTC)", "after"); filterField("Before (YYYY-MM-DD, UTC)", "before")
            }
            HStack {
                Picker("State", selection: filterBinding("is")) { Text("Any").tag(""); Text("Unread").tag("unread"); Text("Read").tag("read"); Text("Starred").tag("starred") }
                Picker("Folder", selection: filterBinding("in")) { Text("Any in scope").tag(""); ForEach(mailFolders, id: \.self) { Text($0.capitalized).tag($0) } }
                Toggle("Smart Search (智慧搜尋)", isOn: $smart).toggleStyle(.checkbox)
                Button("Configure…") { model.settingsTab = "search"; model.showSettings = true }
            }
            Text("Gmail labels: choose Current account view and enter the label name. Words use AND; quotes match a phrase. Filters narrow your scope. Trash requires an explicit folder choice. Smart search sends your query to the embedding model when you press Search.").font(.caption).foregroundStyle(.secondary)
        }
    }
    var resultStatus: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text("\(Int(result["total"].number)) \(smart ? "ranked matches" : "matches")").font(.caption.bold())
                Menu("Downloaded Coverage") {
                    ForEach(Array(result["coverage"].array.enumerated()), id: \.offset) { item in Text("\(item.element["account"].string): \(downloadCoverageText(item.element)) · \(item.element["oldest"].string.prefix(10)) – \(item.element["newest"].string.prefix(10))") }
                    Text("Downloaded content only; incomplete bodies may not match. Use Downloads & storage for repairs and history controls.")
                }.font(.caption)
                Spacer()
                Button("Previous") { run(page: Int(result["page"].number) - 1) }.disabled(searching || result["page"].number == 0)
                Text("Page \(Int(result["page"].number) + 1) / \(max(1, Int(ceil(result["total"].number / 30))))").font(.caption)
                Button("Next") { run(page: Int(result["page"].number) + 1) }.disabled(searching || (result["page"].number + 1) * 30 >= result["total"].number)
            }
            if result["warning"].nonempty { Text(result["warning"].string).font(.caption).foregroundStyle(.secondary).lineLimit(3) }
        }
    }
    func filterBinding(_ key: String) -> Binding<String> { Binding(get: { filters[key].string }, set: { filters[key] = .string($0) }) }
    func filterField(_ title: String, _ key: String) -> some View { VStack(alignment: .leading, spacing: 3) { Text(title).font(.caption); TextField(title, text: filterBinding(key)).textFieldStyle(.roundedBorder) } }
    func clear() { query = ""; filters = .object([:]); scope = "folder"; searchFolder = ""; smart = false; model.searchResponse = .null; model.selectedMessage = nil }
    func schedule() {
        operation?.cancel(); ticket = UUID(); searching = false; error = ""
        if !active { model.searchResponse = .null; return }
        model.searchResponse = .object(["messages": .array([]), "waiting": .bool(true)])
        if smart { return }
        operation = Task { do { try await Task.sleep(nanoseconds: 250_000_000); guard !Task.isCancelled else { return }; run() } catch {} }
    }
    func refresh() {
        guard active, !result["total"].isNull else { schedule(); return }
        // Read-state and draft saves refresh this search, keeping its page and
        // displayed rows while the same query is in flight. Smart refreshes may
        // only reuse cached matching; they never submit another model request.
        run(page: Int(result["page"].number), cachedOnly: smart, retainingResults: true)
    }
    func run(page: Int = 0, record: Bool = false, cachedOnly: Bool = false, retainingResults: Bool = false) {
        operation?.cancel(); let current = UUID(); ticket = current
        let owner = model.account, section = model.section; var payload = options
        payload["page"] = .number(Double(page)); payload["cachedOnly"] = .bool(cachedOnly)
        searching = true; error = ""
        if !retainingResults { model.searchResponse = .object(["messages": .array([]), "loading": .bool(true)]) }
        operation = Task {
            defer { if ticket == current { searching = false } }
            do {
                var next = try await model.request("/search", method: "POST", body: payload, mailbox: owner)
                guard !Task.isCancelled, ticket == current, model.account == owner, model.section == section else { return }
                if page > 0, !next["total"].isNull, next["messages"].array.isEmpty {
                    let last = max(0, (Int(next["total"].number) - 1) / 30)
                    if last < page {
                        payload["page"] = .number(Double(last))
                        next = try await model.request("/search", method: "POST", body: payload, mailbox: owner)
                        guard !Task.isCancelled, ticket == current, model.account == owner, model.section == section else { return }
                    }
                }
                model.searchResponse = next
                if record { remember("recent", value: payload) }
            } catch { if !Task.isCancelled && ticket == current { self.error = error.localizedDescription } }
        }
    }
    func remember(_ action: String, value: JSON = .object([:])) {
        let owner = model.account
        Task { do { let next = try await model.request("/search/preferences", method: "POST", body: .object(["action": .string(action), "value": value]), mailbox: owner); if model.account == owner { history = next } } catch { self.error = error.localizedDescription } }
    }
    func historyLabel(_ value: JSON) -> String {
        if value["query"].nonempty { return value["query"].string }
        let conditions = value["filters"].object.keys.sorted().filter { value["filters"][$0].nonempty }.map { "\($0):\(value["filters"][$0].string)" }.joined(separator: " ")
        return conditions.isEmpty ? "\(value["scope"].string) mail" : conditions
    }
    func restore(_ value: JSON) { query = value["query"].string; scope = value["scope"].string; searchFolder = value["folder"].string; sort = value["sort"].string; filters = value["filters"]; smart = value["smart"].bool; advanced = true }
}
