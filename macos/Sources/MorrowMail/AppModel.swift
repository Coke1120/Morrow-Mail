import SwiftUI
import AppKit
import Security

@MainActor
final class AppModel: ObservableObject {
    @Published var state: JSON = .null
    @Published var busy = false
    @Published var starting = true
    @Published var error = ""
    @Published var notice = ""
    @Published var activity: JSON = .null
    @Published var activityError = ""
    @Published var section = "inbox"
    @Published var scheduledAccount = ""
    @Published var selectedMessage: String? {
        didSet { if selectedMessage != oldValue { openedMessage = nil } }
    }
    @Published var compose: Draft?
    @Published var organizing: JSON?
    @Published var searchFocus = 0
    @Published var searchResponse: JSON = .null
    @Published var mailPage: JSON = .null
    @Published var mailLoading = false
    @Published var unreadOnly = false
    @Published var messageDetail: JSON = .null
    @Published var mailCursors = [""]
    private var mailGeneration = 0
    private var mailPageKey = ""
    private var openedMessage: String?
    @Published var showSettings = false
    @Published var settingsTab = "general"
    @Published var assistantAction = "summary"
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
    var listedMessages: [JSON] {
        if mailPage.isNull { return messages.filter { section == "studio" || messageMatchesFolder($0, folder: section) } }
        return mailPageKey == mailScopeKey ? mailPage["messages"].array : []
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
    var canNavigate: Bool { !busy && unsavedForms.isEmpty && compose == nil && organizing == nil && readerAssistant == nil && !showSettings }

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
        let attempt = launchAttempt
        do {
            let resources = Bundle.main.resourceURL!
            let runtime = Bundle.main.object(forInfoDictionaryKey: "MorrowServiceRuntime") as? String ?? "node"
            guard ["node", "rust"].contains(runtime) else { throw APIError("The app has an invalid service configuration. Reinstall Morrow Mail.") }
            let backend = resources.appendingPathComponent("backend/server/native.js")
            let executable = resources.appendingPathComponent(runtime == "rust" ? "morrow-service" : "node")
            guard FileManager.default.isExecutableFile(atPath: executable.path), runtime == "rust" || FileManager.default.fileExists(atPath: backend.path) else {
                throw APIError("Build and open Morrow Mail.app with npm run macos:build. The app includes its own runtime.")
            }
            var random = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, random.count, &random) == errSecSuccess else { throw APIError("The system could not create a private session.") }
            token = random.map { String(format: "%02x", $0) }.joined()
            let child = Process(), input = Pipe(), output = Pipe()
            child.executableURL = executable; child.arguments = runtime == "rust" ? [] : [backend.path]
            child.currentDirectoryURL = resources.appendingPathComponent("backend")
            // Do not inherit NODE_OPTIONS, preload paths, or shell secrets.
            child.environment = ["PATH": "/usr/bin:/bin", "HOME": FileManager.default.homeDirectoryForCurrentUser.path, "NODE_ENV": "production"]
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
                NSApp.terminate(nil)
            } catch { onError(error.localizedDescription) }
        }
    }
    func backup(to destination: URL) async throws {
        let resources = Bundle.main.resourceURL!
        if Bundle.main.object(forInfoDictionaryKey: "MorrowServiceRuntime") as? String == "rust" {
            _ = try await request("/backup", method: "POST", body: .object(["destination": .string(destination.path)]), authorizeUpdate: true)
        } else {
            let process = Process(); process.executableURL = resources.appendingPathComponent("node")
            process.arguments = [resources.appendingPathComponent("backend/scripts/backup.js").path, destination.path]
            process.environment = ["DATA_DIR": dataDirectory.path, "PATH": "/usr/bin:/bin"]
            process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
            try process.run()
            await Task.detached { process.waitUntilExit() }.value
            guard process.terminationStatus == 0 else { throw APIError("Backup failed. Choose a new destination that does not already exist.") }
        }
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
    @discardableResult
    func loadMailPage(cursor: String = "", reset: Bool = true, offset: Int? = nil) async -> Bool {
        guard (mailFolders.contains(section) || section == "studio"), baseURL != nil else { return false }
        mailGeneration += 1
        let ticket = mailGeneration, query = mailQueryKey
        mailLoading = true; error = ""
        defer { if ticket == mailGeneration { mailLoading = false } }
        do {
            let result = try await request("/mail/page", method: "POST", body: .object(["folder": .string(section == "studio" ? "" : section), "sort": preferences["sort"], "unreadOnly": .bool(section != "studio" && unreadOnly), "cursor": .string(cursor), "offset": .number(Double(offset ?? 0)), "locale": .string(Locale.current.identifier(.bcp47))]))
            guard !Task.isCancelled, ticket == mailGeneration, query == mailQueryKey else { return false }
            if let offset, offset > 0, result["messages"].array.isEmpty {
                let last = max(0, (Int(result["total"].number) - 1) / 50) * 50
                if last < offset { return await loadMailPage(reset: false, offset: last) }
            }
            if reset { mailCursors = [""] }
            if let offset { mailCursors = Array(repeating: "", count: offset / 50 + 1) }
            mailPageKey = mailScopeKey
            mailPage = result
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
            let firstOpen = openedMessage != id
            openedMessage = id
            if firstOpen && preferences["markReadOnOpen"].bool && !messageDetail["read"].bool && messageDetail["folder"].string != "drafts" {
                let updated = try await request("/messages/" + encodedPath(row.id), method: "PATCH", body: .object(["read": .bool(true)]), mailbox: row["accountId"].string)
                if selectedMessage == id { messageDetail = updated["message"] }
                try await reload()
            }
        } catch { if !Task.isCancelled, selectedMessage == id { messageDetail = .null; self.error = error.localizedDescription } }
    }
    func refreshWhenActive() {
        guard !starting, baseURL != nil, !busy, compose == nil else { return }
        perform { try await self.reload() }
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
        let failures = state["syncErrors"].array.map { $0["accountId"].string }
        notice = failures.isEmpty ? "Recent mail refreshed. Older mail follows the import range in Settings; see Activity for progress." : "Some accounts could not sync: " + failures.joined(separator: ", ") + ". Reconnect them in Settings."
    }
    func preference(_ key: String, _ value: String) {
        perform { self.state = try await self.request("/settings/preferences", method: "POST", body: .object([key: .string(value)])) }
    }
    func canOrganize(_ message: JSON) -> Bool {
        let provider = accounts.first { $0.id == message["accountId"].string }?["provider"].string ?? ""
        return !provider.isEmpty && (message["remoteId"].nonempty ? message["remoteId"].string : message.id).hasPrefix(provider + ":")
    }
    func patch(_ message: JSON, _ values: JSON) {
        perform {
            _ = try await self.request("/messages/" + encodedPath(message.id), method: "PATCH", body: values, mailbox: message["accountId"].string)
            try await self.reload()
            await self.loadMessage()
        }
    }
    func newDraft(_ value: Draft? = nil) {
        guard !busy, compose == nil, readerAssistant == nil else { return }
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
    func settings(_ tab: String = "general") {
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
