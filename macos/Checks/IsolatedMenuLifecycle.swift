import AppKit
import SwiftUI

// Branch-only diagnosis using the real Reader and unchanged menu fixture helper.
@main struct IsolatedMenuLifecycle {
#if MORROW_PROBE_APPKIT
    static let mode = "appkit"
    @MainActor static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.regular)
        let checks: Task<Void, Never> = Task { @MainActor in
            await run()
            fflush(stdout); exit(0)
        }
        withExtendedLifetime(checks) { application.run() }
        try? progress("event-loop-returned")
        print("Isolated menu: AppKit event loop returned before completion")
        fflush(stdout); exit(1)
    }
#else
    static let mode = "async"
    @MainActor static func main() async { await run() }
#endif

    @MainActor static func progress(_ phase: String, fields: [String: JSON] = [:]) throws {
        var payload = fields
        payload["mode"] = .string(mode)
        payload["phase"] = .string(phase)
        try ProbeEvidence.emit("menu", .object(payload))
    }

    @MainActor static func run() async {
        do {
            try progress("case-start")
            try await readerMenu()
            // readerMenu's owned window and session have completed their defers.
            try progress("case-cleaned-up")
            try ProbeEvidence.complete(kind: "menu", mode: mode, passed: true)
        } catch {
            try? progress("case-failed", fields: ["error": .string(String(error.localizedDescription.prefix(2048)))])
            try? ProbeEvidence.complete(kind: "menu", mode: mode, passed: false)
            print("Isolated menu failed: " + error.localizedDescription)
            fflush(stdout); exit(1)
        }
    }

    @MainActor static func readerMenu() async throws {
        _ = NSApplication.shared; NSApp.setActivationPolicy(.regular)
        ReviewProtocol.resetLifecycle()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ReviewProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let first = ReviewFixture.owners[0], owner = ReviewFixture.owners[1]
        let model = AppModel(session: session)
        model.state = ReviewFixture.state(owner: first); model.starting = false
        var message = ReviewFixture.message(0, owner: owner)
        message["remoteId"] = .string("imap:1:1")
        model.state["messages"] = .array([message])
        model.selectedMessage = message.viewID; model.messageDetail = message
        var expanded = 0
        let window = NSWindow(contentRect: NSRect(x: 30, y: 30, width: 720, height: 760), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: MessageReader(message: message, expanded: false, focused: false,
            onExpand: { expanded += 1 }, onBack: {}).environmentObject(model))
        window.contentView = host; window.makeKeyAndOrderFront(nil)
        defer { window.close(); window.contentView = nil }
        let identifier = "reader.replyMenu"
        try await ReviewWorkspaceAssertions.settle("Isolated Reply menu did not mount") {
            ReviewWorkspaceAssertions.menuControls(identifier, in: host).count == 1
        }
        try progress("before-bitmap")
        try ProbeEvidence.bitmap(host, name: "menu-" + mode + "-before")
        try progress("before-menu", fields: [
            "hostFrame": .string(NSStringFromRect(host.frame)),
            "hostBounds": .string(NSStringFromRect(host.bounds)),
            "visibleRect": .string(NSStringFromRect(host.visibleRect)),
            "windowFrame": .string(NSStringFromRect(window.frame)),
            "windowVisible": .bool(window.isVisible),
            "ownedWindow": .bool(host.window === window && window.contentView === host),
            "hidden": .bool(host.isHiddenOrHasHiddenAncestor),
            "candidateCount": .number(Double(ReviewWorkspaceAssertions.menuControls(identifier, in: host).count)),
            "ax": .string(ReviewWorkspaceAssertions.menuDiagnostics(identifier, in: host))
        ])
        let prepared = ReviewProtocol.recordedTraffic().filter { $0["path"] == "/api/drafts/prepare" }.count
        try ReviewWorkspaceAssertions.require(model.compose == nil && !model.preparingDraft && prepared == 0,
                                              "The isolated Reader prepared a draft before menu activation")
        // Bitmap capture is outside the original, unchanged five-second menu budget.
        let deadline = Date().addingTimeInterval(5)
        try await ReviewWorkspaceAssertions.withMountedMenu(identifier, in: host, deadline: deadline) { menu in
            let commands = ["Reply", "Reply All", "Forward"]
            try ReviewWorkspaceAssertions.require(commands.allSatisfy { ReviewWorkspaceAssertions.commandIndex($0, in: menu) != nil },
                                                  "A grouped reader command became unreachable: " + identifier)
            try progress("commands-inspected", fields: ["entries": .string(ReviewWorkspaceAssertions.menuEntries(menu))])
        }
        try progress("menu-helper-returned")
        await Task.yield()
        let traffic = ReviewProtocol.recordedTraffic()
        let preparedAfter = traffic.filter { $0["path"] == "/api/drafts/prepare" }.count
        try ReviewWorkspaceAssertions.require(model.compose == nil && !model.preparingDraft && preparedAfter == prepared,
                                              "Opening a menu invoked the primary Reply action")
        try ReviewWorkspaceAssertions.require(model.account == first && model.messageDetail.viewID == message.viewID
                                              && model.messageDetail["accountId"].string == owner && expanded == 0,
                                              "Opening the isolated menu changed its message owner or Reader layout")
        try ReviewWorkspaceAssertions.require(!traffic.contains { $0["path"] == "/api/send" || $0["path"] == "/api/ai" || $0["path"]?.contains("/organize") == true },
                                              "Opening grouped controls issued a send, AI or provider write")
        try progress("no-primary-action", fields: [
            "prepareCountBefore": .number(Double(prepared)), "prepareCountAfter": .number(Double(preparedAfter)),
            "composeAbsent": .bool(model.compose == nil), "preparingDraft": .bool(model.preparingDraft),
            "messageOwnerUnchanged": .bool(model.messageDetail["accountId"].string == owner),
            "globalOwnerUnchanged": .bool(model.account == first)
        ])
    }
}
