import AppKit
import SwiftUI

// All requests are intercepted. This is native presentation/routing evidence,
// not provider acceptance or a persistence test. The production service's
// ownership/persistence contracts remain in RustIntegration.swift.
final class MailFlowProtocol: URLProtocol {
    static let owner = "first@mail-flow.invalid", other = "second@mail-flow.invalid"
    static let lock = NSLock()
    static var searches: [(String, JSON)] = []
    static var drafts: [(String, JSON)] = []
    static var holdSearch = false
    static var held: MailFlowProtocol?
    static var total = 65
    static var revision = 1
    static var readIDs: Set<String> = []
    static var failures: [String] = []
    var response: JSON = .null

    static func row(_ index: Int, owner: String) -> JSON {
        .object(["id": .string("fixture:\(index)"), "viewId": .string(owner + ":\(index)"),
                 "accountId": .string(owner), "folder": .string("inbox"), "read": .bool(readIDs.contains(owner + ":\(index)")),
                 "subject": .string("Fictional search result \(index)"), "body": .string("Fictional message")])
    }
    static func state() -> JSON {
        .object(["account": .object(["id": .string(owner)]), "revision": .string("fixture-\(revision)"),
                 "accounts": .array([owner, other].map { .object(["id": .string($0), "email": .string($0), "provider": .string("imap"), "settings": .object(["configured": .bool(true)])]) }),
                 "messages": .array([]), "settings": .object(["preferences": .object(["markReadOnOpen": .bool(true)]), "policy": .object(["enabled": .bool(false)])])])
    }
    static func body(_ request: URLRequest) throws -> JSON {
        if let data = request.httpBody { return try JSONDecoder().decode(JSON.self, from: data) }
        guard let stream = request.httpBodyStream else { return .null }
        stream.open(); defer { stream.close() }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 || data.count + count > 65536 { throw APIError("Invalid fixture request body.") }
            if count == 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        return try JSONDecoder().decode(JSON.self, from: data)
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let body = try Self.body(request), owner = request.value(forHTTPHeaderField: "X-Genmail-Account") ?? ""
            guard request.url?.host == "127.0.0.1", request.url?.port == 18484,
                  [Self.owner, Self.other, ""].contains(owner) else { throw APIError("Unexpected fixture destination or owner.") }
            Self.lock.lock(); defer { Self.lock.unlock() }
            switch request.url!.path {
            case "/api/search/preferences": response = .object(["saved": .array([]), "recent": .array([])])
            case "/api/search":
                Self.searches.append((owner, body))
                let page = Int(body["page"].number), start = page * 30, end = min(Self.total, start + 30)
                response = .object(["page": .number(Double(page)), "total": .number(Double(Self.total)),
                                    "messages": .array(start < end ? (start..<end).map { Self.row($0, owner: owner) } : [])])
                if Self.holdSearch { Self.holdSearch = false; Self.held = self; return }
            case "/api/state": response = Self.state()
            case "/api/drafts":
                Self.drafts.append((owner, body)); Self.revision += 1
                var saved = body; saved["id"] = .string("fixture-saved"); saved["accountId"] = .string(owner)
                response = .object(["message": saved])
            case let path where path.hasPrefix("/api/messages/"):
                let id = String(path.dropFirst("/api/messages/".count))
                if id.hasSuffix("/history") {
                    let source = String(id.dropLast("/history".count))
                    var row = Self.row(30, owner: owner); row["id"] = .string(source)
                    response = .object(["accountId": .string(owner), "messageId": .string(source), "messages": .array([row])])
                } else {
                    var row = Self.row(Int(id.split(separator: ":").last ?? "0") ?? 0, owner: owner)
                    if request.httpMethod == "PATCH" { row["read"] = .bool(true); Self.readIDs.insert(owner + ":" + String(id.split(separator: ":").last ?? "0")); Self.revision += 1 }
                    response = .object(["message": row])
                }
            default: throw APIError("Unexpected fixture API path.")
            }
            deliver()
        } catch {
            Self.lock.lock(); Self.failures.append(error.localizedDescription); Self.lock.unlock()
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    func deliver() {
        let data = try! JSONEncoder().encode(response)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
    static func release() {
        lock.lock(); let value = held; held = nil; lock.unlock()
        value?.deliver()
    }
    static func snapshot() -> ([(String, JSON)], [(String, JSON)], Bool, [String]) {
        lock.lock(); defer { lock.unlock() }; return (searches, drafts, held != nil, failures)
    }
    static func holdNext() { lock.lock(); holdSearch = true; lock.unlock() }
    static func shrink() { lock.lock(); total = 30; revision += 1; lock.unlock() }
}

struct MailFlowHost: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        NativeMailSearch().id(model.account + ":" + model.section)
            .sheet(item: $model.compose) { ComposeView(initial: $0).environmentObject(model) }
    }
}

@main
struct MailFlowAssertions {
    @MainActor static func require(_ value: Bool, _ message: String) throws {
        if !value { throw APIError("Mail flow fixture: " + message) }
    }
    @MainActor static func wait(_ message: String, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !condition(), Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
        try require(condition(), message)
    }
    @MainActor static func views<T: NSView>(_ root: NSView, _ type: T.Type) -> [T] {
        (root as? T).map { [$0] } ?? root.subviews.flatMap { views($0, type) }
    }
    @MainActor static func accessibility(_ root: Any, depth: Int = 0) -> [AnyObject] {
        guard depth < 20 else { return [] }
        // AppKit/SwiftUI peers can implement the Objective-C accessibility
        // selectors without declaring conformance to the full Swift protocol.
        let element = root as AnyObject
        let children = (element.accessibilityChildren?() ?? []) + ((root as? NSView)?.subviews ?? [])
        return [element] + children.prefix(100).flatMap { accessibility($0, depth: depth + 1) }
    }
    @MainActor static func press(_ name: String, in root: NSView) async throws {
        var button: AnyObject?
        let deadline = Date().addingTimeInterval(5)
        repeat {
            root.layoutSubtreeIfNeeded()
            button = accessibility(root).first { $0.accessibilityRole?() == .button && ($0.accessibilityLabel?() == name || $0.accessibilityTitle?() == name) }
            if button != nil { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        } while Date() < deadline
        if button == nil {
            // This tree contains only the fictional fixture; bound diagnostic
            // output and avoid descriptions/paths or general process metadata.
            for element in accessibility(root).prefix(40) {
                trace("Fixture AX: role=\(element.accessibilityRole?()?.rawValue ?? "nil") label=\(element.accessibilityLabel?() ?? "") title=\(element.accessibilityTitle?() ?? "")")
            }
            for native in views(root, NSButton.self).prefix(20) {
                trace("Fixture native button: title=\(native.title) label=\(native.accessibilityLabel() ?? "") AXtitle=\(native.accessibilityTitle() ?? "")")
            }
        }
        try require(button?.accessibilityPerformPress?() == true, "Missing native action: " + name)
    }
    @MainActor static func query(_ value: String, in root: NSView) throws {
        guard let field = views(root, NSTextField.self).first(where: { $0.placeholderString?.hasPrefix("Search mail") == true }) else { throw APIError("Native search field is missing.") }
        field.stringValue = value
        field.delegate?.controlTextDidChange?(Notification(name: NSControl.textDidChangeNotification, object: field))
    }
    static func trace(_ message: String) { FileHandle.standardError.write(Data((message + "\n").utf8)) }
    @MainActor static func main() async {
        do { try await run() }
        catch { trace(error.localizedDescription); exit(1) }
    }
    @MainActor static func run() async throws {
        let app = NSApplication.shared; app.setActivationPolicy(.regular)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [MailFlowProtocol.self]
        let model = AppModel(session: URLSession(configuration: config))
        defer { model.stop(); model.session.invalidateAndCancel() }
        model.state = MailFlowProtocol.state(); model.starting = false
        let window = NSWindow(contentRect: NSRect(x: 50, y: 50, width: 1220, height: 820), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: MailFlowHost().environmentObject(model)); window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { window.close(); window.contentView = nil; MailFlowProtocol.release() }
        try await wait("Search view did not mount.") { !views(host, NSTextField.self).isEmpty }
        try query("fictional", in: host)
        try await wait("Initial search did not finish.") { model.searchResponse["total"].number == 65 }
        try await press("Next", in: host)
        try await wait("Search did not reach page two.") { model.searchResponse["page"].number == 1 }
        let secondPage = model.searchResponse
        model.selectedMessage = secondPage["messages"].array.first!.viewID
        MailFlowProtocol.holdNext()
        await model.loadMessage() // Actual owner-bound GET, mark-read PATCH and reload.
        try await wait("Read-state refresh did not issue a search.") { MailFlowProtocol.snapshot().2 }
        let refreshing = MailFlowProtocol.snapshot().0.last!
        let baseline = CommandLine.arguments.contains("--expect-baseline-reset")
        try require(refreshing.0 == MailFlowProtocol.owner, "Read refresh changed search owner.")
        if baseline {
            try require(refreshing.1["page"].number == 0 && model.searchResponse["messages"].array.isEmpty,
                        "Pinned main did not reproduce its page-reset/empty-row defect.")
            MailFlowProtocol.release()
            print("Pinned main reproduced: marking a second-page search result read requests page zero and clears its displayed rows.")
            return
        }
        try require(refreshing.1["page"].number == 1 && model.searchResponse == secondPage && model.current != nil,
                    "Read refresh lost page two or its displayed reader identity.")
        MailFlowProtocol.release()
        try await wait("Read refresh did not settle on page two.") { model.searchResponse["page"].number == 1 && model.searchResponse != secondPage }
        // Two different Remove targets must be identifiable through native AX.
        var draft = Draft(); draft.accountID = MailFlowProtocol.owner; draft.replyToID = "fixture:30"
        draft.to = "recipient@example.invalid"; draft.subject = "Fictional reply"; draft.body = "Keep these unsaved edits."
        draft.attachments = ["one.txt", "two.txt"].enumerated().map { .object(["id": .string("fixture-file-\($0.offset)"), "name": .string($0.element), "size": .number(1)]) }
        draft.footer = .object(["text": .string("Fictional footer")])
        model.newDraft(draft)
        try await wait("Reply sheet did not mount.") { window.attachedSheet?.contentView != nil && model.unsavedForms.contains("compose") }
        let sheet = window.attachedSheet!, sheetRoot = sheet.contentView!
        try await wait("Composer accessibility controls did not mount.") {
            accessibility(sheetRoot).contains { $0.accessibilityLabel?() == "Remove attachment one.txt" }
        }
        for name in ["Remove attachment one.txt", "Remove attachment two.txt", "Remove email footer"] {
            try require(accessibility(sheetRoot).contains { $0.accessibilityRole?() == .button && $0.accessibilityLabel?() == name }, "Ambiguous removal label: " + name)
        }
        var sawDiscardReview = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            sawDiscardReview = NSApp.modalWindow != nil
            NSApp.stopModal(withCode: .alertFirstButtonReturn)
        }
        try await press("Cancel", in: sheetRoot)
        try await wait("Cancel did not present and finish its unsaved-edit review.") { sawDiscardReview && NSApp.modalWindow == nil }
        try require(model.compose != nil && model.unsavedForms.contains("compose") && window.attachedSheet === sheet,
                    "Keep Editing discarded the mounted reply.")
        MailFlowProtocol.holdNext()
        try await press("Save Draft", in: sheetRoot)
        try await wait("Saved reply did not return to search.") { model.compose == nil && MailFlowProtocol.snapshot().2 }
        let saved = MailFlowProtocol.snapshot().1.last!
        try require(saved.0 == draft.accountID && saved.1["body"].string == draft.body && saved.1["attachments"].array == draft.attachments,
                    "Cancellation or save changed draft owner, edits or attachment identities.")
        try require(MailFlowProtocol.snapshot().0.last!.1["page"].number == 1 && model.searchResponse["page"].number == 1,
                    "Saving a reply reset the original search page.")
        MailFlowProtocol.release()
        try await Task.sleep(nanoseconds: 100_000_000)
        MailFlowProtocol.shrink(); model.state = MailFlowProtocol.state()
        try await wait("An emptied last search page did not fall back to the last valid page.") { model.searchResponse["page"].number == 0 && model.searchResponse["total"].number == 30 }
        MailFlowProtocol.holdNext(); model.state["revision"] = .string("held-owner-refresh")
        try await wait("Stale-owner search was not held.") { MailFlowProtocol.snapshot().2 }
        model.state["account"]["id"] = .string(MailFlowProtocol.other)
        try await wait("New account did not clear the old search.") { model.searchResponse.isNull }
        MailFlowProtocol.release(); try await Task.sleep(nanoseconds: 100_000_000)
        try require(model.account == MailFlowProtocol.other && model.searchResponse.isNull, "An obsolete search crossed accounts.")
        try query("other fictional", in: host)
        try await wait("New-owner search did not complete.") { model.searchResponse["total"].number == 30 }
        try require(model.searchResponse["messages"].array.allSatisfy { $0["accountId"].string == MailFlowProtocol.other }
                    && MailFlowProtocol.snapshot().3.isEmpty, "Unexpected request or account-owned result.")
        print("Native search/read/reply: page retention, rows during held refresh, Keep Editing, owner/attachment-preserving Save, last-page fallback, stale-account cancellation and distinct AX removal labels passed. Fictional transport only; VoiceOver and persistence are not asserted.")
    }
}
