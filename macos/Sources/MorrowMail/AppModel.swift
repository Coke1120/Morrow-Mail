import SwiftUI
import AppKit
import Security

@MainActor
final class AppModel: ObservableObject {
    @Published var state: JSON = .null {
        didSet {
            if case .object(let catalogs) = state["serverFolders"] {
                serverFolders = catalogs.mapValues { $0["folders"].array }
            }
            if state["account"]["id"] != oldValue["account"]["id"] || state["settings"] != oldValue["settings"] ||
                accounts.map({ $0.picking(["id", "settings"]) }) != oldValue["accounts"].array.map({ $0.picking(["id", "settings"]) }) ||
                state["workspace"].picking(["brain", "styleLearning"]) != oldValue["workspace"].picking(["brain", "styleLearning"]) { draftGeneration += 1 }
        }
    }
    @Published var busy = false
    @Published var starting = true
    @Published var error = ""
    @Published var notice = ""
    @Published var trashUndos: [(message: JSON, token: String, expires: TimeInterval, batch: UUID)] = []
    private var trashUndoKeyMonitor: Any?
    var canUndoTrash: Bool { canNavigate && trashUndos.contains { $0.expires > ProcessInfo.processInfo.systemUptime } }
    @Published var activity: JSON = .null
    @Published var activityError = ""
    @Published var section = "inbox" { didSet { if section != oldValue { draftGeneration += 1 } } }
    @Published var scheduledAccount = ""
    @Published var serverFolders: [String: [JSON]] = [:]
    @Published var selectedMessage: String? {
        didSet { if selectedMessage != oldValue { openedMessage = nil; retainedUnread = nil; selectedMessages = selectedMessage.map { [$0] } ?? []; draftGeneration += 1 } }
    }
    @Published var selectedMessages: Set<String> = []
    @Published private var retainedUnread: (message: JSON, index: Int, scope: String, page: Int)?
    @Published var compose: Draft? { didSet { if compose != oldValue { draftGeneration += 1 } } }
    @Published private(set) var preparingDraft = false
    private(set) var draftGeneration = 0
    @Published var organizing: JSON? { didSet { if organizing != oldValue { draftGeneration += 1 } } }
    @Published var managingFolders: JSON?
    private var mailDrag: JSON = .null
    @Published var searchFocus = 0
    @Published var searchResponse: JSON = .null
    @Published var mailPage: JSON = .null
    @Published var mailLoading = false
    @Published var unreadOnly = false
    @Published var messageDetail: JSON = .null { didSet { if messageDetail != oldValue { draftGeneration += 1 } } }
    @Published var mailCursors = [""]
    private var mailGeneration = 0
    private var mailPageKey = ""
    private var openedMessage: String?
    @Published var showSettings = false { didSet { if showSettings != oldValue { draftGeneration += 1 } } }
    @Published var settingsTab = "start"
    @Published private(set) var updateResult: JSON = .null
    @Published private(set) var updateCheckError = ""
    @Published private(set) var checkingUpdates = false
    @Published var includePrereleases = (Bundle.main.object(forInfoDictionaryKey: "MorrowReleaseVersion") as? String ?? "").contains("-") {
        didSet {
            guard includePrereleases != oldValue else { return }
            updateResult = .null; updateCheckError = ""; lastUpdateCheckAttempt = nil
        }
    }
    private(set) var lastUpdateCheckAttempt: Date?
    var updateAvailable: Bool { updateResult["updateAvailable"].bool }
    @Published var assistantAction = "ask"
    @Published var studioTab = "tools"
    @Published var readerAssistant: JSON?
    @Published var unsavedForms = Set<String>()
    private(set) var restartingForUpdate = false
    private var process: Process?
    private var input: Pipe?
    private var output: Pipe?
    private var token = ""
    private(set) var baseURL: URL?
    private var periodic: Task<Void, Never>?
    private var activityPolling: Task<Void, Never>?
    private var refreshing = false
    private var shuttingDown = false
    private var launchAttempt = 0
    private var launching = false
    let dataDirectory: URL
    let session: URLSession

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 65
        config.timeoutIntervalForResource = 90
        config.httpCookieStorage = nil
        session = URLSession(configuration: config)
        if let override = ProcessInfo.processInfo.environment["MORROW_DATA_DIR"], override.hasPrefix("/") {
            dataDirectory = URL(fileURLWithPath: override)
        } else {
            dataDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Morrow Mail", isDirectory: true)
        }
    }
    var account: String { state["account"]["id"].string }
    var accounts: [JSON] { state["accounts"].array }
    var combined: Bool { account == "all" }
    var senderAccounts: [JSON] { accounts }
    var hasMailbox: Bool { !accounts.isEmpty && account != "demo" }
    var messages: [JSON] { state["messages"].array }
    var features: [JSON] { state["features"].array }
    var preferences: JSON { state["settings"]["preferences"] }
    var policy: JSON { state["settings"]["policy"] }
    var mailScopeKey: String { [account, section, preferences["sort"].string, String(unreadOnly)].joined(separator: "\n") }
    var mailQueryKey: String { mailScopeKey + "\n" + state["revision"].string }
    var isMailSection: Bool { mailFolders.contains(section) || section.hasPrefix("provider:") }
    var mailSectionTitle: String { serverFolders[account]?.first { "provider:" + $0.id == section }?["name"].string ?? section.capitalized }
    var listedMessages: [JSON] {
        if mailPage.isNull { return section.hasPrefix("provider:") ? [] : messages.filter { section == "studio" || messageMatchesFolder($0, folder: section) } }
        guard mailPageKey == mailScopeKey else { return [] }
        var rows = mailPage["messages"].array
        if unreadOnly, let retained = retainedUnread, retained.scope == mailScopeKey, retained.page == mailCursors.count,
           retained.message.viewID == selectedMessage, accounts.contains(where: { $0.id == retained.message["accountId"].string }) {
            if let index = rows.firstIndex(where: { $0.viewID == retained.message.viewID }) { rows[index] = retained.message }
            else { rows.insert(retained.message, at: min(retained.index, rows.count)) }
        }
        return rows
    }
    var visibleMailRows: [JSON] { searchResponse.isNull ? listedMessages : searchResponse["messages"].array }
    var selectedMailRows: [JSON] { visibleMailRows.filter { selectedMessages.contains($0.viewID) } }
    func selectMailMessages(_ ids: Set<String>) {
        let ids = ids.intersection(visibleMailRows.map(\.viewID))
        let primary = selectedMessage.flatMap { ids.contains($0) ? $0 : nil } ?? visibleMailRows.first { ids.contains($0.viewID) }?.viewID
        selectedMessage = primary
        selectedMessages = ids
    }
    private func retainReadRow(_ message: JSON) {
        guard selectedMessage == message.viewID else { return }
        if !message["read"].bool { retainedUnread = nil; return }
        guard unreadOnly, searchResponse.isNull,
              let index = listedMessages.firstIndex(where: { $0.viewID == message.viewID }) else { return }
        var row = listedMessages[index]
        for key in ["read", "starred", "pending"] { row[key] = message[key] }
        retainedUnread = (row, index, mailScopeKey, mailCursors.count)
    }
    var current: JSON? {
        let row = (searchResponse.isNull ? listedMessages : searchResponse["messages"].array).first { message in
            message.viewID == selectedMessage && (message["accountId"].string == "demo" ? account == "demo" : accounts.contains { $0.id == message["accountId"].string })
        }
        let owner = messageDetail["accountId"].string
        let inFolder = section == "studio" || messageMatchesFolder(messageDetail, folder: section)
        let visible = row != nil || (searchResponse.isNull && inFolder && (account == owner || combined && accounts.contains { $0.id == owner }))
        if visible && messageDetail.viewID == selectedMessage && !messageDetail.isNull { return messageDetail }
        return row
    }
    var colorScheme: ColorScheme? {
        switch preferences["theme"].string { case "light": return .light; case "dark": return .dark; default: return nil }
    }
    var canNavigate: Bool { !busy && unsavedForms.isEmpty && compose == nil && organizing == nil && managingFolders == nil && readerAssistant == nil && !showSettings }

    func start() async {
        guard !launching else { return }
        launching = true; defer { launching = false }
        if let previous = process {
            guard shuttingDown else { return }
            // Retain ownership until the previous service has actually drained and exited.
            let deadline = Date().addingTimeInterval(70)
            while previous.isRunning && Date() < deadline {
                guard !Task.isCancelled else { starting = false; return }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            guard !previous.isRunning else {
                error = "The previous local service is still closing. Wait for it to finish before reopening Morrow Mail."
                starting = false; return
            }
            process = nil; input = nil; output = nil
        }
        if let identifier = Bundle.main.bundleIdentifier,
           NSRunningApplication.runningApplications(withBundleIdentifier: identifier).contains(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            error = "Another copy of Morrow Mail is already running. Close it before opening this copy."
            starting = false; return
        }
        starting = true; error = ""; shuttingDown = false; launchAttempt += 1
        if trashUndoKeyMonitor == nil {
            trashUndoKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard event.charactersIgnoringModifiers == "z", event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
                      let self, self.canUndoTrash, NSApp.keyWindow?.firstResponder is NSTextView == false else { return event }
                self.undoTrash(); return nil
            }
        }
        let attempt = launchAttempt
        do {
            let resources = Bundle.main.resourceURL!
            guard Bundle.main.object(forInfoDictionaryKey: "MorrowServiceRuntime") as? String == "rust" else { throw APIError("The app has an invalid service configuration. Reinstall Morrow Mail.") }
            let executable = resources.appendingPathComponent("morrow-service")
            guard FileManager.default.isExecutableFile(atPath: executable.path) else {
                throw APIError("Open a complete Morrow Mail.app bundle. Its private runtime is missing; rebuild or reinstall the app.")
            }
            var random = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, random.count, &random) == errSecSuccess else { throw APIError("The system could not create a private session.") }
            token = random.map { String(format: "%02x", $0) }.joined()
            let child = Process(), input = Pipe(), output = Pipe()
            child.executableURL = executable; child.arguments = []
            child.currentDirectoryURL = resources.appendingPathComponent("backend")
            // Do not inherit preload paths or shell secrets.
            child.environment = ["PATH": "/usr/bin:/bin", "HOME": FileManager.default.homeDirectoryForCurrentUser.path]
            child.standardInput = input; child.standardOutput = output
            child.standardError = FileHandle.nullDevice
            child.terminationHandler = { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.launchAttempt == attempt else { return }
                    self.baseURL = nil; self.process = nil; self.input = nil; self.output = nil; self.starting = false
                    guard !self.shuttingDown else { return }
                    self.error = "The local service stopped. Your saved data is retained. Quit and reopen Morrow Mail."
                }
            }
            try child.run()
            self.process = child; self.input = input; self.output = output
            let config = JSON.object(["token": .string(token), "dataDirectory": .string(dataDirectory.path), "parentPID": .number(Double(ProcessInfo.processInfo.processIdentifier)), "updateToken": .string(token)])
            var data = try JSONEncoder().encode(config); data.append(0x0a)
            try input.fileHandleForWriting.write(contentsOf: data)
            // Read asynchronously so a failed child cannot freeze the window.
            let pipe = output.fileHandleForReading
            let line = try await Task.detached { () throws -> Data in
                var collected = Data()
                for try await byte in pipe.bytes {
                    if byte == 10 { return collected }
                    collected.append(byte)
                    if collected.count > 1024 { break }
                }
                throw APIError("The local service did not start. Check that the data folder is writable.")
            }.value
            let ready = try JSONDecoder().decode(JSON.self, from: line)
            let port = Int(ready["port"].number)
            guard (1...65535).contains(port) else { throw APIError("The local service returned an invalid address.") }
            baseURL = URL(string: "http://127.0.0.1:\(port)")!
            try await reload()
            starting = false
            activityPolling = Task { [weak self] in
                while !Task.isCancelled {
                    guard let self else { return }
                    if NSApp?.isActive == true {
                        do {
                            let next = try await self.request("/activity", mailbox: "")
                            guard !Task.isCancelled else { return }
                            self.activity = next; self.activityError = ""
                        } catch {
                            if !Task.isCancelled { self.activityError = "Activity could not be refreshed. Last known status may be out of date." }
                        }
                    }
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                }
            }
            periodic = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 30_000_000_000)
                    guard !Task.isCancelled, let self else { return }
                    // The service syncs all accounts and schedules AI; this only refreshes visible state.
                    if self.canNavigate && NSApp?.isActive == true {
                        self.perform {
                            let stamp = try await self.request("/state/revision", mailbox: "")
                            if stamp["revision"] != self.state["revision"] || stamp["accountId"].string != self.account { try await self.reload() }
                        }
                    }
                }
            }
        } catch {
            self.error = error.localizedDescription; starting = false
            stop()
        }
    }
    func stop() {
        if let trashUndoKeyMonitor { NSEvent.removeMonitor(trashUndoKeyMonitor); self.trashUndoKeyMonitor = nil }
        trashUndos = []
        shuttingDown = true; periodic?.cancel(); activityPolling?.cancel()
        try? input?.fileHandleForWriting.close()
        if process?.isRunning == true { process?.terminate() }
        baseURL = nil
        if process?.isRunning != true { process = nil; input = nil; output = nil }
    }
    func request(_ path: String, method: String = "GET", body: JSON? = nil, mailbox: String? = nil, authorizeUpdate: Bool = false) async throws -> JSON {
        guard let baseURL, let url = URL(string: "/api" + path, relativeTo: baseURL)?.absoluteURL else { throw APIError("The local service is not connected.") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("paged", forHTTPHeaderField: "X-Morrow-View")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if authorizeUpdate { request.setValue(token, forHTTPHeaderField: "X-Morrow-Update") }
        let sessionToken = token
        let owner = mailbox ?? account
        if !owner.isEmpty { request.setValue(owner, forHTTPHeaderField: "X-Genmail-Account") }
        if let body { request.httpBody = try JSONEncoder().encode(body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: request)
        guard self.baseURL == baseURL, self.token == sessionToken else { throw CancellationError() }
        guard let http = response as? HTTPURLResponse, http.url?.host == baseURL.host, http.url?.port == baseURL.port else { throw APIError("The local service returned an unexpected response.") }
        guard data.count <= 32 * 1024 * 1024 else { throw APIError("The response was too large. Narrow your request.") }
        let result = try await Task.detached(priority: .userInitiated) { try JSONDecoder().decode(JSON.self, from: data) }.value
        guard (200...299).contains(http.statusCode) else { throw APIError(payload: result) }
        return result
    }
    func restartToInstallUpdate(onError: @escaping (String) -> Void) {
        guard !busy, unsavedForms.isEmpty, readerAssistant == nil else { onError("Close AI assistance, save or discard unsaved changes and wait for current operations before installing an update."); return }
        let alert = NSAlert(); alert.messageText = "Install update and restart Morrow Mail?"
        alert.informativeText = "Your saved mail, accounts and settings will stay on this device. The previous app will be retained if installation fails."
        alert.addButton(withTitle: "Install & Restart"); alert.addButton(withTitle: "Later")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        perform {
            do {
                _ = try await self.request("/updates/install", method: "POST", body: .object([:]), authorizeUpdate: true)
                self.restartingForUpdate = true
                // Wait for the Settings sheet's dismissal before asking AppKit to quit.
                if self.showSettings { self.showSettings = false }
                else { self.finishUpdateRestart() }
            } catch { onError(error.localizedDescription) }
        }
    }
    func finishUpdateRestart() {
        if restartingForUpdate { NSApp.terminate(nil) }
    }
    func backup(to destination: URL) async throws {
        _ = try await request("/backup", method: "POST", body: .object(["destination": .string(destination.path)]), authorizeUpdate: true)
    }
    func reload() async throws {
        guard !refreshing else { return }
        refreshing = true; defer { refreshing = false }
        // OAuth selects its newly connected mailbox on the service. Read that view;
        // message mutations still carry their explicitly captured owner.
        var next = try await request("/state", mailbox: "")
        if next["account"]["id"].string == "demo", let first = next["accounts"].array.first {
            next = try await request("/account/select", method: "POST", body: .object(["accountId": .string(first.id)]))
        }
        guard !next["account"].isNull, !next["messages"].isNull else { throw APIError("Morrow received an incomplete workspace.") }
        if next["account"]["id"].string != account { mailPage = .null; messageDetail = .null; selectedMessage = nil; searchResponse = .null }
        state = next
    }
    func refreshConnections() async throws {
        let before = state
        let result = try await request("/state", mailbox: account)
        guard case .array = result["accounts"], case .array = result["settings"]["calendars"] else {
            throw APIError("Incomplete connection status.")
        }
        // A save, disconnect or view change during this read takes precedence.
        guard !Task.isCancelled, state == before else { return }
        var next = state
        next["accounts"] = result["accounts"]
        next["serverFolders"] = result["serverFolders"]
        next["settings"]["calendars"] = result["settings"]["calendars"]
        if next != state { state = next }
    }
    @discardableResult
    func loadMailPage(cursor: String = "", reset: Bool = true, offset: Int? = nil) async -> Bool {
        guard (isMailSection || section == "studio"), baseURL != nil else { return false }
        mailGeneration += 1
        let ticket = mailGeneration, query = mailQueryKey
        mailLoading = true; error = ""
        defer { if ticket == mailGeneration { mailLoading = false } }
        do {
            let result = try await request("/mail/page", method: "POST", body: .object(["folder": .string(section == "studio" ? "" : section), "sort": preferences["sort"], "unreadOnly": .bool(section != "studio" && unreadOnly), "cursor": .string(cursor), "offset": .number(Double(offset ?? 0)), "locale": .string(Locale.current.identifier(.bcp47))]))
            guard !Task.isCancelled, ticket == mailGeneration, query == mailQueryKey else { return false }
            let retainingPage = unreadOnly && retainedUnread?.scope == mailScopeKey && retainedUnread?.page == (offset ?? 0) / 50 + 1 && retainedUnread?.message.viewID == selectedMessage
            if let offset, offset > 0, result["messages"].array.isEmpty, !retainingPage {
                let last = max(0, (Int(result["total"].number) - 1) / 50) * 50
                if last < offset { return await loadMailPage(reset: false, offset: last) }
            }
            if reset { mailCursors = [""] }
            if let offset { mailCursors = Array(repeating: "", count: offset / 50 + 1) }
            mailPageKey = mailScopeKey
            mailPage = result
            selectedMessages.formIntersection(visibleMailRows.map(\.viewID))
            return true
        } catch {
            guard !Task.isCancelled, ticket == mailGeneration, query == mailQueryKey else { return false }
            self.error = error.localizedDescription
            if !cursor.isEmpty { await loadMailPage(); notice = "Mail changed. Showing the first page." }
            return false
        }
    }
    func refreshMailPage() async {
        // Keep the current rows visible while refreshing the same mailbox snapshot.
        let sameScope = mailPageKey == mailScopeKey
        await loadMailPage(reset: !sameScope, offset: sameScope ? (mailCursors.count - 1) * 50 : 0)
    }
    func turnMailPage(next: Bool) async {
        let index = mailCursors.count - 1 + (next ? 1 : -1)
        guard index >= 0, !next || !mailPage["nextCursor"].string.isEmpty else { return }
        if await loadMailPage(reset: false, offset: index * 50) {
            selectedMessage = nil; messageDetail = .null
        }
    }
    func loadMessage() async {
        guard let row = current else { return }
        let id = row.viewID, view = account
        do {
            let result = try await request("/messages/" + encodedPath(row.id), mailbox: row["accountId"].string)
            guard !Task.isCancelled, selectedMessage == id, account == view else { return }
            messageDetail = result["message"]
            if !messageMatchesFolder(messageDetail, folder: section) { retainedUnread = nil }
            else { retainReadRow(messageDetail) }
            let firstOpen = openedMessage != id
            openedMessage = id
            if firstOpen && preferences["markReadOnOpen"].bool && !messageDetail["read"].bool && messageDetail["folder"].string != "drafts" {
                let updated = try await request("/messages/" + encodedPath(row.id), method: "PATCH", body: .object(["read": .bool(true)]), mailbox: row["accountId"].string)
                if selectedMessage == id { retainReadRow(updated["message"]); messageDetail = updated["message"] }
                try await reload()
            }
        } catch { if !Task.isCancelled, selectedMessage == id { messageDetail = .null; self.error = error.localizedDescription } }
    }
    func refreshWhenActive() {
        guard !starting, baseURL != nil, !busy, compose == nil else { return }
        perform { try await self.reload() }
    }
    func checkForUpdates(force: Bool = false, now: Date = Date()) async {
        guard baseURL != nil, !checkingUpdates else { return }
        if !force, let last = lastUpdateCheckAttempt, (0..<3600).contains(now.timeIntervalSince(last)) { return }
        let channel = includePrereleases
        checkingUpdates = true; lastUpdateCheckAttempt = now; updateCheckError = ""
        defer { checkingUpdates = false }
        do {
            let result = try await request("/updates?includePrereleases=\(channel)", mailbox: "")
            guard !Task.isCancelled, channel == includePrereleases else { return }
            updateResult = result
        } catch {
            guard !Task.isCancelled, channel == includePrereleases else { return }
            updateCheckError = error.localizedDescription
        }
    }
    func perform(_ work: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true; error = ""
        Task {
            defer { busy = false }
            do { try await work() } catch { self.error = error.localizedDescription }
        }
    }
    func selectAccount(_ id: String, folder: String? = nil) async throws {
        searchResponse = .null; mailPage = .null; messageDetail = .null
        state = try await request("/account/select", method: "POST", body: .object(["accountId": .string(id)]))
        selectedMessage = nil
        if let folder { section = folder }
    }
    func loadServerFolders(_ owner: String) async throws {
        guard accounts.contains(where: { $0.id == owner }) else { return }
        let result = try await request("/mail/folders", mailbox: owner)
        guard accounts.contains(where: { $0.id == owner }), result["accountId"].string == owner,
              case .array = result["folders"] else { throw APIError("The server folder list could not be confirmed.") }
        serverFolders[owner] = result["folders"].array.filter { $0.id != "__archive" && !$0.id.isEmpty && !$0.id.contains(where: { $0.isNewline }) }
        var catalog = result; catalog["folders"] = .array(serverFolders[owner] ?? []); catalog["errorCode"] = .null
        state["serverFolders"][owner] = catalog
    }
    func openAssistant(_ action: String, message: JSON, includeHistory: Bool = false) {
        guard canNavigate, ["summary", "reply", "translate"].contains(action), allowed(action),
              current == message, messageDetail.viewID == message.viewID,
              policy["folders"][message["folder"].string].bool,
              !includeHistory || action == "reply" && policy["content"]["sender"].bool,
              let owner = accounts.first(where: { $0.id == message["accountId"].string }) else { return }
        readerAssistant = .object([
            "id": .string(UUID().uuidString), "action": .string(action), "message": message,
            "includeHistory": .bool(includeHistory), "viewAccount": .string(account),
            "settings": state["settings"].picking(["ai", "policy", "preferences"]),
            "connection": owner["settings"], "writingContext": state["workspace"].picking(["brain", "styleLearning"]),
        ])
    }
    func readerAssistantIsCurrent(_ request: JSON) -> Bool {
        guard readerAssistant?.id == request.id, account == request["viewAccount"].string,
              current == request["message"],
              state["settings"].picking(["ai", "policy", "preferences"]) == request["settings"],
              state["workspace"].picking(["brain", "styleLearning"]) == request["writingContext"],
              let owner = accounts.first(where: { $0.id == request["message"]["accountId"].string }) else { return false }
        return owner["settings"] == request["connection"]
    }
    func sync() async throws {
        state = try await request("/sync", method: "POST", body: .object([:]))
        let failures = state["syncErrors"].array.map { item in
            item["accountId"].string + ": " + item["error"].string + (item["nextRetryAt"].nonempty ? " Next retry: \(dateLabel(item["nextRetryAt"].string))." : "")
        }
        notice = failures.isEmpty ? "Recent mail refreshed. Older mail follows the import range in Settings; see Activity for progress." : "Some accounts could not sync: " + failures.joined(separator: "; ")
    }
    func preference(_ key: String, _ value: String) {
        perform { self.state = try await self.request("/settings/preferences", method: "POST", body: .object([key: .string(value)])) }
    }
    func canOrganize(_ message: JSON) -> Bool {
        let provider = accounts.first { $0.id == message["accountId"].string }?["provider"].string ?? ""
        return !message["providerFolderMissing"].bool && !provider.isEmpty && (message["remoteId"].nonempty ? message["remoteId"].string : message.id).hasPrefix(provider + ":")
    }
    func startMailDrag(_ message: JSON) -> String? {
        mailDrag = .null
        guard canNavigate, !mailLoading, canOrganize(message), combined || account == message["accountId"].string, !message.id.isEmpty, message["viewId"].nonempty else { return nil }
        let token = UUID().uuidString
        mailDrag = .object(["id": .string(token), "message": message, "scope": .string(mailScopeKey), "connection": accounts.first { $0.id == message["accountId"].string }?["settings"] ?? .null])
        return token
    }
    func mailDropDestination(_ owner: String, folder: String) -> String {
        guard owner != "all", ["inbox", "archive", "spam", "trash"].contains(folder) else { return "" }
        if folder == "archive", accounts.first(where: { $0.id == owner })?["provider"].string == "google" { return "__archive" }
        return serverFolders[owner]?.first { $0["kind"].string == folder && $0["selectable"] != .bool(false) && !$0["hidden"].bool }?.id ?? ""
    }
    func mailDropMessage(_ token: String, owner: String, destination: String) -> JSON? {
        guard !token.isEmpty, !destination.isEmpty, token == mailDrag.id, canNavigate, !mailLoading, mailDrag["scope"].string == mailScopeKey,
              mailDrag["message"]["accountId"].string == owner,
              let account = accounts.first(where: { $0.id == owner }), account["settings"] == mailDrag["connection"],
              (destination == "__archive" && account["provider"].string == "google" || serverFolders[owner]?.contains(where: { $0.id == destination && $0["selectable"] != .bool(false) && !$0["hidden"].bool }) == true),
              let message = (searchResponse.isNull ? listedMessages : searchResponse["messages"].array).first(where: { $0.viewID == mailDrag["message"].viewID && $0.id == mailDrag["message"].id && $0["accountId"].string == owner }),
              canOrganize(message) else { return nil }
        return message
    }
    func finishMailDrop(_ token: String, owner: String, destination: String) -> Bool {
        guard let message = mailDropMessage(token, owner: owner, destination: destination) else { return false }
        mailDrag = .null
        beginOrganize(message, destinationId: destination)
        return true
    }
    var mailDragToken: String { mailDrag.id }
    func beginOrganize(_ message: JSON?, preferredKind: String = "", destinationId: String = "") {
        guard let message, canNavigate, canOrganize(message) else { return }
        if preferredKind == "trash" {
            trashMessages([message])
            return
        }
        organizing = .object(["id": .string(UUID().uuidString), "message": message, "preferredKind": .string(preferredKind), "destinationId": .string(destinationId)])
    }
    func trashMessages(_ messages: [JSON]) {
        guard canNavigate, !messages.isEmpty, messages.allSatisfy({ canOrganize($0) && $0["folder"].string != "trash" }) else { return }
        let batch = UUID()
        perform {
            var completed = 0
            var failure = ""
            do {
                for message in messages {
                    let result = try await self.request("/messages/" + encodedPath(message.id) + "/trash", method: "POST", body: .object([:]), mailbox: message["accountId"].string)
                    guard result["message"].id == message.id, result["message"]["accountId"] == message["accountId"], result["undoToken"].nonempty else { throw APIError("The Trash move could not be verified. Refresh your mailbox.") }
                    self.trashUndos.append((message, result["undoToken"].string, ProcessInfo.processInfo.systemUptime + 60, batch))
                    completed += 1
                    if self.selectedMessage == message.viewID { self.selectedMessage = nil; self.messageDetail = .null }
                }
                self.notice = "Moved \(completed) message(s) to provider Trash. Undo is available for one minute (⌘Z)."
            } catch { failure = "Moved \(completed) of \(messages.count) messages. " + error.localizedDescription }
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                self?.trashUndos.removeAll { $0.expires <= ProcessInfo.processInfo.systemUptime }
            }
            try await self.reload()
            await self.refreshMailPage()
            if !failure.isEmpty { self.error = failure }
        }
    }
    func undoTrash() {
        guard canUndoTrash else { return }
        trashUndos.removeAll { $0.expires <= ProcessInfo.processInfo.systemUptime }
        guard let batch = trashUndos.last?.batch else { return }
        perform {
            while let entry = self.trashUndos.last, entry.batch == batch {
                self.trashUndos.removeLast()
                _ = try await self.request("/messages/" + encodedPath(entry.message.id) + "/undo-trash", method: "POST", body: .object(["undoToken": .string(entry.token)]), mailbox: entry.message["accountId"].string)
            }
            self.notice = "Trash move undone. The message was restored."
            try await self.reload()
            await self.refreshMailPage()
        }
    }
    func patch(_ message: JSON, _ values: JSON) {
        patchMessages([message], values)
    }
    func patchMessages(_ messages: [JSON], _ values: JSON) {
        guard canNavigate, !messages.isEmpty else { return }
        perform {
            var completed = 0
            var failure = ""
            do {
                for message in messages {
                    let result = try await self.request("/messages/" + encodedPath(message.id), method: "PATCH", body: values, mailbox: message["accountId"].string)
                    guard result["message"].id == message.id, result["message"]["accountId"] == message["accountId"] else { throw APIError("The updated message owner could not be verified. Refresh your mailbox.") }
                    if values["folder"].nonempty && self.selectedMessage == message.viewID { self.selectedMessage = nil; self.messageDetail = .null }
                    if !values["folder"].nonempty { self.retainReadRow(result["message"]) }
                    completed += 1
                }
            } catch { failure = "Updated \(completed) of \(messages.count) messages. " + error.localizedDescription }
            try await self.reload()
            await self.refreshMailPage()
            await self.loadMessage()
            if !failure.isEmpty { self.error = failure }
        }
    }
    func prepareDraft(message: JSON, mode: String, body: String? = nil) async throws -> Draft {
        guard !busy, !preparingDraft, compose == nil, organizing == nil, !showSettings else { throw CancellationError() }
        guard unsavedForms.isEmpty else { throw APIError("Save your current changes before opening a new draft.") }
        let owner = message["accountId"].string
        guard !owner.isEmpty, owner != "all", !message.id.isEmpty,
              senderAccounts.contains(where: { $0.id == owner }) else { throw APIError("Reconnect this message’s mailbox before replying or editing its draft.") }
        let replying = ["reply", "replyAll"].contains(mode)
        guard ["reply", "replyAll", "forward", "copy"].contains(mode), body == nil || replying else { throw APIError("Invalid draft preparation request.") }
        let generation = draftGeneration, assistant = readerAssistant
        var payload: JSON = .object(["messageId": .string(message.id), "mode": .string(mode)])
        if let body { payload["body"] = .string(body) }
        preparingDraft = true
        defer { preparingDraft = false }
        do {
            let result = try await request("/drafts/prepare", method: "POST", body: payload, mailbox: owner)
            guard !Task.isCancelled, generation == draftGeneration, readerAssistant == assistant,
                  !busy, compose == nil, unsavedForms.isEmpty else { throw CancellationError() }
            let prepared = result["draft"], draft = try Draft(prepared: result["draft"])
            let fields = ["accountId", "to", "cc", "bcc", "subject", "body"] + (replying ? ["replyToId"] : mode == "forward" ? ["forwarding"] : ["sourceDraft"])
            guard draft.accountID == owner, prepared.object.keys.allSatisfy({ fields.contains($0) }),
                  replying ? draft.replyToID == message.id : prepared.object["replyToId"] == nil,
                  mode != "forward" || prepared["forwarding"] == .bool(true),
                  mode != "copy" || prepared["sourceDraft"] == .bool(true) else {
                throw APIError("The prepared draft could not be verified. Reopen the original message and try again.")
            }
            return draft
        } catch {
            guard !Task.isCancelled, generation == draftGeneration, readerAssistant == assistant else { throw CancellationError() }
            throw error
        }
    }
    func openDraft(message: JSON, mode: String, body: String? = nil) async {
        guard readerAssistant == nil else { return }
        do { newDraft(try await prepareDraft(message: message, mode: mode, body: body)) }
        catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
    func newDraft(_ value: Draft? = nil) {
        guard !busy, compose == nil, organizing == nil, readerAssistant == nil, !showSettings else { return }
        guard unsavedForms.isEmpty else { notice = "Save your current changes before opening a new draft."; return }
        var draft = value ?? Draft()
        guard (draft.replyToID.isEmpty && !draft.forwarding && !draft.sourceDraft) || !draft.accountID.isEmpty else { error = "The original mailbox is unavailable. Reopen the original message."; return }
        if accounts.isEmpty { settings("mail"); return }
        if draft.accountID.isEmpty { draft.accountID = combined ? accounts.first?.id ?? "" : account }
        guard senderAccounts.contains(where: { $0.id == draft.accountID }) else { error = "Reconnect this message’s mailbox before replying or editing its draft."; return }
        if draft.scheduleLocked {
            scheduledAccount = draft.accountID; section = "scheduled"
            notice = "Cancel this message’s schedule before editing or sending its draft."
            return
        }
        if draft.savedID.isEmpty, draft.footer.isNull { draft.footer = state["settings"]["footer"] }
        compose = draft
    }
    func settings(_ tab: String = "start") {
        guard compose == nil, readerAssistant == nil, unsavedForms.subtracting(["settings"]).isEmpty else { notice = "Close AI assistance or save your current changes before opening Settings."; return }
        settingsTab = tab; showSettings = true
    }
    func allowed(_ action: String) -> Bool { policy["enabled"].bool && policy["behaviors"][action].bool }
    func openOAuth(_ result: JSON, provider: String, calendar: Bool) throws {
        let path = "/api/\(calendar ? "calendar-oauth" : "oauth")/\(provider)/authorize"
        guard let url = URL(string: result["url"].string), url.scheme == "http", url.host == "localhost", url.port == baseURL?.port,
              url.path == path, URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == "state" && !($0.value ?? "").isEmpty }) == true,
              NSWorkspace.shared.open(url) else { throw APIError("Morrow could not open the provider sign-in page.") }
        notice = "Finish signing in in your browser, then return to Morrow."
    }
    func confirmDiscard(_ message: String = "Discard unsaved changes?") -> Bool {
        let alert = NSAlert(); alert.messageText = message
        alert.informativeText = "Changes you have not saved will be lost."
        alert.addButton(withTitle: "Keep Editing"); alert.addButton(withTitle: "Discard")
        return alert.runModal() == .alertSecondButtonReturn
    }
    func confirm(_ title: String, detail: String) -> Bool {
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = detail
        alert.addButton(withTitle: "Cancel"); alert.addButton(withTitle: "Continue")
        return alert.runModal() == .alertSecondButtonReturn
    }
    func dirty(_ key: String, _ value: Bool) { if value { unsavedForms.insert(key) } else { unsavedForms.remove(key) } }
}
