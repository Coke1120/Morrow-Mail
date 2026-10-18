import AppKit
import Foundation
import SwiftUI

// This transport never opens a socket. It holds actual AppModel requests at
// their suspension points; every unexpected route/method is a test failure.
final class DownloadRepairProtocol: URLProtocol {
    static let owner = "repair-first@example.invalid", other = "repair-second@example.invalid"
    static let lock = NSLock()
    static var fixtures: [String: DownloadRepairFixture] = [:]
    static func register(_ fixture: DownloadRepairFixture) { lock.lock(); fixtures[fixture.id] = fixture; lock.unlock() }
    static func unregister(_ id: String) { lock.lock(); fixtures.removeValue(forKey: id); lock.unlock() }
    var fixture: DownloadRepairFixture?
    var response: JSON = .null
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        fixture = Self.fixtures[request.value(forHTTPHeaderField: "X-Morrow-Repair-Fixture") ?? ""]
        Self.lock.unlock()
        guard let fixture else { client?.urlProtocol(self, didFailWithError: APIError("Missing repair fixture.")); return }
        do {
            guard request.url?.host == "127.0.0.1", request.url?.port == 18484 else { throw APIError("Unexpected repair destination.") }
            let payload = try MailFlowProtocol.body(request)
            if try fixture.prepare(self, payload: payload) { deliver() }
        } catch {
            fixture.fail(error.localizedDescription)
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    func deliver() {
        let data = try! JSONEncoder().encode(response)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class DownloadRepairFixture {
    typealias Entry = (key: String, owner: String, body: JSON)
    let id = UUID().uuidString
    private let lock = NSLock()
    private var downloaded = false
    private var holds: Set<String> = []
    private var held: [String: DownloadRepairProtocol] = [:]
    private var entries: [Entry] = []
    private var errors: [String] = []
    private var badIdentity = ""
    private var detailText = "Full repaired fictional body"
    private var readBefore = false
    private var allowReadSetup = false
    private var setupWrites = 0
    static let post = "POST /api/messages/shared-id/attachments"
    static let state = "GET /api/state", page = "POST /api/mail/page", detail = "GET /api/messages/shared-id"
    static func reference(_ owner: String) -> String { "fixture-connection:" + owner }
    static func row(_ owner: String, repaired: Bool = false, full: Bool = false, body: String = "Full repaired fictional body") -> JSON {
        var result: JSON = .object(["id": .string("shared-id"), "viewId": .string("[\"\(owner)\",\"shared-id\"]"),
            "accountId": .string(owner), "folder": .string("inbox"), "subject": .string("Fictional repair"),
            "preview": .string(repaired ? "Repaired preview" : "Short preview"), "read": .bool(repaired),
            "starred": .bool(repaired), "pending": .bool(repaired), "canRepair": .bool(true)])
        if full {
            result["body"] = .string(repaired ? body : "Short body")
            result["bodyHtml"] = .string(repaired ? "<p>Repaired fictional body</p>" : "<p>Short body</p>")
            result["bodyTruncated"] = .bool(!repaired)
            result["contentIncomplete"] = .bool(!repaired)
            result["attachmentsLoaded"] = .bool(repaired)
            result["attachments"] = .array(repaired ? [.object(["id": .string("fictional-file"), "name": .string("note.txt"), "size": .number(4)])] : [])
        }
        return result
    }
    static func state(_ view: String = "all", repaired: Bool = false) -> JSON {
        .object(["account": .object(["id": .string(view)]), "revision": .string(repaired ? "after-repair" : "before-repair"),
            "accounts": .array([DownloadRepairProtocol.owner, DownloadRepairProtocol.other].map {
                .object(["id": .string($0), "provider": .string("imap"), "incompleteCount": .number(repaired && $0 == DownloadRepairProtocol.owner ? 0 : 1),
                    "settings": .object(["configured": .bool(true), "connectionRef": .string(reference($0))])]) }),
            "messages": .array([row(DownloadRepairProtocol.owner, repaired: repaired), row(DownloadRepairProtocol.other)]),
            "settings": .object(["preferences": .object(["markReadOnOpen": .bool(true), "sort": .string("newest")]), "policy": .object(["enabled": .bool(false)])])])
    }
    func prepare(_ value: DownloadRepairProtocol, payload: JSON) throws -> Bool {
        lock.lock(); defer { lock.unlock() }
        let request = value.request, owner = request.value(forHTTPHeaderField: "X-Genmail-Account") ?? ""
        let key = (request.httpMethod ?? "GET") + " " + (request.url?.path ?? "")
        entries.append((key, owner, payload))
        switch key {
        case Self.post:
            guard owner == DownloadRepairProtocol.owner, payload["connectionRef"].string == Self.reference(owner) else { throw APIError("Repair lost its reviewed mailbox connection.") }
            downloaded = true
            var message = Self.row(owner, repaired: true, full: true)
            // A newer flag update is visible to subsequent local reads. Replaying
            // this successful POST's older flags must not replace that update.
            message["read"] = .bool(false); message["starred"] = .bool(false); message["pending"] = .bool(false)
            if badIdentity == "owner" { message["accountId"] = .string(DownloadRepairProtocol.other) }
            if badIdentity == "id" { message["id"] = .string("wrong-id") }
            if badIdentity == "viewId" { message["viewId"] = Self.row(DownloadRepairProtocol.other)["viewId"] }
            value.response = .object(["message": message])
        case Self.state:
            guard ["all", DownloadRepairProtocol.owner, DownloadRepairProtocol.other, ""].contains(owner) else { throw APIError("Wrong state owner.") }
            value.response = Self.state(owner.isEmpty ? "all" : owner, repaired: downloaded)
            if readBefore { value.response["messages"] = .array(value.response["messages"].array.map { var row = $0; if row["accountId"].string == DownloadRepairProtocol.owner { row["read"] = .bool(true) }; return row }) }
        case Self.page:
            guard owner == "all", payload["folder"].string == "inbox", payload["offset"].number == 50 else { throw APIError("Repair reset its mail scope or page.") }
            var rows = [Self.row(DownloadRepairProtocol.owner, repaired: downloaded), Self.row(DownloadRepairProtocol.other)]
            if readBefore { rows[0]["read"] = .bool(true) }
            if payload["unreadOnly"].bool { rows.removeAll { $0["read"].bool } }
            value.response = .object(["messages": .array(rows), "total": .number(52), "nextCursor": .string("")])
        case Self.detail:
            guard [DownloadRepairProtocol.owner, DownloadRepairProtocol.other].contains(owner) else { throw APIError("Wrong detail owner.") }
            var message = Self.row(owner, repaired: downloaded && owner == DownloadRepairProtocol.owner, full: true, body: detailText)
            if readBefore && owner == DownloadRepairProtocol.owner { message["read"] = .bool(true) }
            if badIdentity == "detail:owner" { message["accountId"] = .string(DownloadRepairProtocol.other) }
            if badIdentity == "detail:id" { message["id"] = .string("wrong-id") }
            if badIdentity == "detail:viewId" { message["viewId"] = Self.row(DownloadRepairProtocol.other)["viewId"] }
            value.response = .object(["message": message])
        case "PATCH /api/messages/shared-id":
            guard allowReadSetup, !downloaded, owner == DownloadRepairProtocol.owner, payload == .object(["read": .bool(true)]) else { throw APIError("Repair introduced a mark-read write.") }
            readBefore = true; setupWrites += 1
            var message = Self.row(owner, full: true); message["read"] = .bool(true)
            value.response = .object(["message": message])
        case "GET /api/search/preferences":
            value.response = .object(["saved": .array([]), "recent": .array([])])
        case "POST /api/search":
            guard owner == "all", payload["query"].string == "fictional" else { throw APIError("Search changed its captured query or owner.") }
            value.response = .object(["page": payload["page"], "total": .number(65), "messages": .array([Self.row(DownloadRepairProtocol.owner, repaired: downloaded), Self.row(DownloadRepairProtocol.other)])])
        case "POST /api/sync/priority":
            guard ["all", DownloadRepairProtocol.owner, DownloadRepairProtocol.other].contains(owner), payload["messages"].array.count <= 51 else { throw APIError("Wrong local view hint.") }
            value.response = .object(["accepted": .bool(true)])
        default: throw APIError("Unexpected repair fixture request: " + key)
        }
        if holds.remove(key) != nil { held[key] = value; return false }
        return true
    }
    func fail(_ value: String) { lock.lock(); errors.append(value); lock.unlock() }
    func hold(_ key: String) { lock.lock(); holds.insert(key); lock.unlock() }
    func isHeld(_ key: String) -> Bool { lock.lock(); defer { lock.unlock() }; return held[key] != nil }
    func release(_ key: String) { lock.lock(); let value = held.removeValue(forKey: key); lock.unlock(); value?.deliver() }
    func releaseAll() { lock.lock(); let values = Array(held.values); held.removeAll(); lock.unlock(); values.forEach { $0.deliver() } }
    func identity(_ value: String) { lock.lock(); badIdentity = value; lock.unlock() }
    func newerBody() { lock.lock(); detailText = "Newer reader request"; lock.unlock() }
    func readSetup(_ enabled: Bool) { lock.lock(); allowReadSetup = enabled; lock.unlock() }
    func readSetupCount() -> Int { lock.lock(); defer { lock.unlock() }; return setupWrites }
    func snapshot() -> ([Entry], [String]) { lock.lock(); defer { lock.unlock() }; return (entries, errors) }
}

@MainActor
enum DownloadRepairAssertions {
    static let owner = DownloadRepairProtocol.owner, other = DownloadRepairProtocol.other
    static func require(_ value: Bool, _ message: String) throws {
        if !value { throw APIError("Download repair fixture: " + message) }
    }
    static func wait(_ fixture: DownloadRepairFixture, _ key: String) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !fixture.isHeld(key), Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
        try require(fixture.isHeld(key), "The expected actual request did not reach its held response: " + key)
    }
    static func runCase(_ name: String, _ action: (AppModel, DownloadRepairFixture, UUID) async throws -> Void) async throws {
        let fixture = DownloadRepairFixture()
        DownloadRepairProtocol.register(fixture)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DownloadRepairProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Morrow-Repair-Fixture": fixture.id]
        let model = AppModel(session: URLSession(configuration: configuration))
        defer {
            fixture.releaseAll(); model.stop(); model.session.invalidateAndCancel()
            DownloadRepairProtocol.unregister(fixture.id)
        }
        model.state = DownloadRepairFixture.state(); model.starting = false
        try require(await model.loadMailPage(reset: false, offset: 50), "Initial page did not load.")
        model.selectedMessage = DownloadRepairFixture.row(owner).viewID
        model.messageDetail = DownloadRepairFixture.row(owner, full: true)
        guard let modal = model.beginDownloadControls() else { throw APIError("Fixture Downloads did not acquire its modal.") }
        try await action(model, fixture, modal)
        let (requests, errors) = fixture.snapshot()
        try require(errors.isEmpty, "Unexpected request: " + errors.joined(separator: "; "))
        try require(requests.allSatisfy { [DownloadRepairFixture.post, DownloadRepairFixture.state, DownloadRepairFixture.page, DownloadRepairFixture.detail, "POST /api/sync/priority", "GET /api/search/preferences", "POST /api/search", "PATCH /api/messages/shared-id"].contains($0.key) } && requests.filter { $0.key == "PATCH /api/messages/shared-id" }.count == fixture.readSetupCount(), "Repair caused another write, provider action or model request.")
        print("Download repair case passed: " + name)
    }
    static func repair(_ model: AppModel, valid: @escaping @MainActor () -> Bool = { true }) async throws {
        try await model.repairDownloadedMessage(DownloadRepairFixture.row(owner), connectionRef: DownloadRepairFixture.reference(owner), isCurrent: valid)
    }
    static func rejected(_ task: Task<Void, Error>) async throws {
        do { try await task.value; throw APIError("Download repair fixture accepted an obsolete result.") }
        catch is CancellationError { }
        catch let error as URLError where task.isCancelled && error.code == .cancelled { }
    }
    static func run() async throws {
        _ = NSApplication.shared
        try await runCase("fresh body, current flags, metadata, page, duplicate owners and old reload") { model, fixture, _ in
            fixture.hold(DownloadRepairFixture.state)
            let obsolete = Task { try await model.reload() }
            defer { obsolete.cancel(); fixture.release(DownloadRepairFixture.state) }
            try await wait(fixture, DownloadRepairFixture.state)
            let otherBefore = model.listedMessages.first { $0["accountId"].string == other }
            try await repair(model)
            try require(model.current?["body"].string == "Full repaired fictional body" && model.current?["contentIncomplete"].bool == false && model.current?["bodyTruncated"].bool == false, "The opened reader still shows its old body or incomplete status.")
            try require(model.messageDetail["attachments"].array.first?.id == "fictional-file" && model.messageDetail["read"].bool && model.messageDetail["starred"].bool && model.messageDetail["pending"].bool, "Repair lost attachments or overwrote newer flags with its POST response.")
            try require(model.state["revision"].string == "after-repair" && model.accounts.first?["incompleteCount"].number == 0 && model.messages.first?["preview"].string == "Repaired preview", "Shared state or coverage did not refresh.")
            try require(model.mailCursors.count == 2 && model.selectedMessage == DownloadRepairFixture.row(owner).viewID && model.listedMessages.first?["preview"].string == "Repaired preview" && model.listedMessages.first(where: { $0["accountId"].string == other }) == otherBefore, "Repair changed the page, selection or another owner's same-ID row.")
            try require((model.messages + model.listedMessages).allSatisfy { $0["body"].isNull && $0["bodyHtml"].isNull && $0["attachments"].isNull }, "Reader payload leaked into shared list metadata.")
            let state = model.state, detail = model.messageDetail, page = model.mailPage
            fixture.release(DownloadRepairFixture.state); try await obsolete.value
            try require(model.state == state && model.messageDetail == detail && model.mailPage == page, "A pre-download reload overwrote the repaired snapshot.")
            let records = fixture.snapshot().0
            try require(records.filter { $0.key == DownloadRepairFixture.post }.count == 1 && records.filter { $0.key == DownloadRepairFixture.detail }.map(\.owner) == [owner], "Repair retried or routed the detail read through All accounts.")
        }
        for scenario in ["other selection", "selection ABA"] {
            try await runCase(scenario) { model, fixture, _ in
                fixture.hold(DownloadRepairFixture.post)
                let task = Task { try await repair(model) }; defer { task.cancel(); fixture.releaseAll() }
                try await wait(fixture, DownloadRepairFixture.post)
                model.selectedMessage = DownloadRepairFixture.row(other).viewID
                model.messageDetail = DownloadRepairFixture.row(other, full: true)
                if scenario == "selection ABA" { model.selectedMessage = DownloadRepairFixture.row(owner).viewID; model.messageDetail = DownloadRepairFixture.row(owner, full: true); model.messageDetail["body"] = .string("New A selection") }
                let expected = model.messageDetail
                fixture.release(DownloadRepairFixture.post); try await task.value
                try require(model.messageDetail == expected && fixture.snapshot().0.filter { $0.key == DownloadRepairFixture.detail }.isEmpty, "A late repair replaced a later selection.")
            }
        }
        try await runCase("repair an unselected row without replacing the selected owner") { model, fixture, _ in
            model.selectedMessage = DownloadRepairFixture.row(other).viewID
            model.messageDetail = DownloadRepairFixture.row(other, full: true)
            let before = model.messageDetail
            try await repair(model)
            try require(model.state["revision"].string == "after-repair" && model.listedMessages.first?["preview"].string == "Repaired preview" && model.messageDetail == before && fixture.snapshot().0.filter { $0.key == DownloadRepairFixture.detail }.isEmpty, "Unselected repair failed to update metadata or replaced the current reader.")
        }
        try await runCase("retained unread row and no additional mark-read write") { model, fixture, _ in
            model.unreadOnly = true
            try require(await model.loadMailPage(reset: false, offset: 50), "Unread fixture page did not load.")
            fixture.readSetup(true); await model.loadMessage(); fixture.readSetup(false)
            try require(fixture.readSetupCount() == 1 && model.current?["read"].bool == true, "The real first-open path did not establish a retained read row.")
            try await repair(model)
            let retained = model.listedMessages.first { $0["accountId"].string == owner }
            try require(!model.mailPage["messages"].array.contains(where: { $0["accountId"].string == owner }) && retained?["preview"].string == "Repaired preview" && retained?["read"].bool == true && retained?["starred"].bool == true && retained?["pending"].bool == true && retained?["bodyHtml"].isNull == true, "The retained unread row kept stale metadata or received reader content.")
            try require(model.mailCursors.count == 2 && model.current?["body"].string == "Full repaired fictional body" && fixture.snapshot().0.filter { $0.key == "PATCH /api/messages/shared-id" }.count == 1, "Repair changed the page/body or marked an opened message again.")
        }
        for scenario in ["modal replacement", "connection changed", "disconnected", "account changed", "folder changed", "caller revoked", "cancelled"] {
            try await runCase(scenario) { model, fixture, modal in
                fixture.hold(DownloadRepairFixture.post)
                var valid = true
                let task = Task { try await repair(model, valid: { valid }) }; defer { task.cancel(); fixture.releaseAll() }
                try await wait(fixture, DownloadRepairFixture.post)
                switch scenario {
                case "modal replacement": try require(model.endDownloadControls(modal) && model.beginDownloadControls() != nil, "Replacement modal failed.")
                case "connection changed": model.state["accounts"] = .array(model.accounts.map { var row = $0; if row.id == owner { row["settings"]["connectionRef"] = .string("reconnected") }; return row })
                case "disconnected": model.state["accounts"] = .array(model.accounts.filter { $0.id != owner })
                case "account changed": model.state["account"]["id"] = .string(other)
                case "folder changed": model.section = "archive"
                case "caller revoked": valid = false
                default: task.cancel()
                }
                let state = model.state, detail = model.messageDetail, page = model.mailPage
                fixture.release(DownloadRepairFixture.post); try await rejected(task)
                try require(model.state == state && model.messageDetail == detail && model.mailPage == page && !fixture.snapshot().0.contains(where: { [DownloadRepairFixture.state, DownloadRepairFixture.detail].contains($0.key) }), "Obsolete repair started a refresh or changed the current view.")
            }
        }
        for identity in ["owner", "id", "viewId", "detail:owner", "detail:id", "detail:viewId"] {
            try await runCase("wrong response " + identity) { model, fixture, _ in
                fixture.identity(identity)
                let before = model.state, detail = model.messageDetail
                var rejected = false
                do { try await repair(model) } catch let error as APIError { rejected = error.localizedDescription == "Downloaded message ownership could not be confirmed." }
                try require(rejected && model.state == before && model.messageDetail == detail, "Unverified response identity was adopted.")
                if !identity.hasPrefix("detail:") { try require(!fixture.snapshot().0.contains(where: { $0.key == DownloadRepairFixture.state }), "An invalid download response initiated a shared refresh.") }
            }
        }
        for scenario in ["revoked before request", "invalid selected view"] {
            try await runCase(scenario) { model, fixture, _ in
                if scenario == "invalid selected view" { model.state["account"]["id"] = .string("") }
                let state = model.state, detail = model.messageDetail
                let task = Task { try await repair(model, valid: { scenario != "revoked before request" }) }
                try await rejected(task)
                try require(model.state == state && model.messageDetail == detail && !fixture.snapshot().0.contains(where: { $0.key == DownloadRepairFixture.post }), "An obsolete queued action started its download.")
            }
        }
        try await runCase("connection change during page refresh") { model, fixture, _ in
            fixture.hold(DownloadRepairFixture.page)
            let task = Task { try await repair(model) }; defer { task.cancel(); fixture.releaseAll() }
            try await wait(fixture, DownloadRepairFixture.page)
            let page = model.mailPage, detail = model.messageDetail
            model.state["accounts"] = .array(model.accounts.map { var row = $0; if row.id == owner { row["settings"]["connectionRef"] = .string("replacement") }; return row })
            fixture.release(DownloadRepairFixture.page); try await rejected(task)
            try require(model.mailPage == page && model.messageDetail == detail && !model.mailLoading, "Late page read crossed connections or retained loading ownership.")
        }
        try await runCase("later reader wins") { model, fixture, _ in
            fixture.hold(DownloadRepairFixture.detail)
            let task = Task { try await repair(model) }; defer { task.cancel(); fixture.releaseAll() }
            try await wait(fixture, DownloadRepairFixture.detail)
            fixture.newerBody(); await model.loadMessage()
            fixture.release(DownloadRepairFixture.detail); try await task.value
            try require(model.messageDetail["body"].string == "Newer reader request", "Repair overwrote a newer reader request.")
        }
        try await runCase("shared state changes while the local read is held") { model, fixture, _ in
            fixture.hold(DownloadRepairFixture.state)
            let task = Task { try await repair(model) }; defer { task.cancel(); fixture.releaseAll() }
            try await wait(fixture, DownloadRepairFixture.state)
            model.state["settings"]["preferences"]["theme"] = .string("dark")
            let state = model.state
            fixture.release(DownloadRepairFixture.state)
            var rejected = false
            do { try await task.value } catch let error as APIError { rejected = error.localizedDescription.hasPrefix("Content was downloaded, but the mailbox changed") }
            try require(rejected && model.state == state, "The refresh overwrote newer shared settings.")
        }
        try await runCase("mounted search retains its query, page and selected repaired body") { model, fixture, _ in
            let window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 1220, height: 820), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            let host = NSHostingView(rootView: MailFlowHost().environmentObject(model))
            window.contentView = host; window.makeKeyAndOrderFront(nil)
            defer { window.close(); window.contentView = nil }
            try await MailFlowAssertions.wait("Repair search did not mount.") { !MailFlowAssertions.views(host, NSTextField.self).isEmpty }
            try MailFlowAssertions.query("fictional", in: host)
            try await MailFlowAssertions.wait("Repair search did not finish.") { model.searchResponse["total"].number == 65 }
            try await MailFlowAssertions.press("Next", fromEnd: 1, in: host, expectedCount: 8)
            try await MailFlowAssertions.wait("Repair search did not retain page two.") { model.searchResponse["page"].number == 1 }
            model.selectedMessage = DownloadRepairFixture.row(owner).viewID
            model.messageDetail = DownloadRepairFixture.row(owner, full: true)
            try await repair(model)
            try await MailFlowAssertions.wait("State refresh did not update the mounted search.") { model.searchResponse["messages"].array.first?["preview"].string == "Repaired preview" }
            try require(model.searchResponse["page"].number == 1 && model.current?["body"].string == "Full repaired fictional body" && model.selectedMessage == DownloadRepairFixture.row(owner).viewID, "Repair reset the search page, selection or body.")
            try require(model.searchResponse["messages"].array.allSatisfy { $0["bodyHtml"].isNull && $0["attachments"].isNull }, "Search received reader-only content.")
            try require(fixture.snapshot().0.filter { $0.key == "POST /api/search" }.allSatisfy { !$0.body["smart"].bool && !$0.body["record"].bool }, "An observational search refresh requested another action.")
        }
        print("Download repair shared-state checks passed: 24 fictional transport cases; repair adds no provider, model, mark-read or account-selection writes beyond its explicit download.")
    }
}
