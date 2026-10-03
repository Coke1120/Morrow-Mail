import AppKit
import SwiftUI

// Standalone fixture, without starting the service or opening any workspace:
// swiftc -D MORROW_WINDOW_CHECKS -parse-as-library macos/Sources/MorrowMail/*.swift macos/Checks/WindowAssertions.swift -o /tmp/morrow-window-checks
// /tmp/morrow-window-checks
@main
struct WindowAssertions {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        if CommandLine.arguments.contains("--mail-only") { checkMailDrop(); return }
        checkRestoredListWidth()
        if CommandLine.arguments.contains("--list-width-only") { return }
        checkMailDrop()
        checkFolderLayouts()
        checkComposeLayout()
        checkCalendarLayout()
        for width in [1040.0, 1877.0] { checkInitialSplit(width: width, vertical: true) }
        checkInitialSplit(width: 1040, vertical: false)
        checkInitialSplit(width: 1040, vertical: false, height: 620)
        checkInitialSplit(width: 1877, vertical: true, lateAttachment: true)
        let model = AppModel(), delegate = MorrowDelegate()
        let window = NSWindow(contentRect: NSRect(x: 50, y: 50, width: 400, height: 260), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Morrow window lifecycle fixture"
        window.isReleasedWhenClosed = false
        let guardDelegate = WindowGuard.Coordinator(model)
        window.delegate = guardDelegate
        delegate.model = model; delegate.mainWindow = window
        defer { window.delegate = nil; window.close() }

        assert(!delegate.applicationShouldTerminateAfterLastWindowClosed(app))
        model.unsavedForms.insert("fixture-draft")
        model.busy = true
        window.makeKeyAndOrderFront(nil)
        assert(!guardDelegate.windowShouldClose(window))
        assert(!window.isVisible)
        assert(model.busy && model.unsavedForms.contains("fixture-draft"), "Closing must keep pending work and edits alive.")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.stopModal(withCode: .alertFirstButtonReturn) }
        assert(delegate.applicationShouldTerminate(app) == .terminateCancel, "An active write must block quitting.")
        assert(!delegate.applicationShouldHandleReopen(app, hasVisibleWindows: false))
        assert(window.isVisible, "Dock reopen must reveal the same window.")
        assert(delegate.mainWindow === window && model.unsavedForms.contains("fixture-draft"))
        model.busy = false
        assert(!guardDelegate.windowShouldClose(window))
        assert(!delegate.applicationShouldHandleReopen(app, hasVisibleWindows: false))
        assert(window.isVisible && model.unsavedForms.contains("fixture-draft"))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.stopModal(withCode: .alertFirstButtonReturn) }
        assert(delegate.applicationShouldTerminate(app) == .terminateCancel, "Keeping unsaved edits must block quitting.")
        model.unsavedForms.remove("fixture-draft")
        assert(delegate.applicationShouldTerminate(app) == .terminateNow)
        print("Window close/reopen preserves pending work and unsaved forms.")
    }

    @MainActor static func checkMailDrop() {
        let model = AppModel(), owner = "drag@example.invalid", other = "other@example.invalid"
        let accounts: [JSON] = [owner, other].map { .object(["id": .string($0), "provider": .string("google"), "settings": .object(["connection": .string("original")])]) }
        let folder: JSON = .object(["id": .string("label"), "kind": .string("label"), "name": .string("Work / 中文")])
        let messages: [JSON] = [owner, other].map { .object(["id": .string("google:duplicate"), "viewId": .string($0 + ":duplicate"), "accountId": .string($0), "folder": .string("inbox")]) }
        model.state = .object(["account": .object(["id": .string("all")]), "accounts": .array(accounts), "messages": .array(messages)])
        model.serverFolders = [owner: [folder], other: [folder]]
        model.searchResponse = .object(["messages": .array(messages)])
        checkMailClicks(model, messages: messages)
        model.searchResponse = .object(["messages": .array(messages)])
        let token = model.startMailDrag(messages[0])!
        assert(model.mailDropMessage(token, owner: owner, destination: "label") == messages[0])
        assert(model.mailDropMessage(token, owner: other, destination: "label") == nil, "Duplicate IDs must not cross owners.")
        assert(model.mailDropMessage("external", owner: owner, destination: "label") == nil)
        assert(model.mailDropMessage(token, owner: owner, destination: "missing") == nil)
        assert(model.mailDropDestination("all", folder: "archive").isEmpty)
        assert(model.mailDropDestination(owner, folder: "archive") == "__archive")
        for field in ["busy", "loading", "dirty", "scope", "connection", "disconnected", "row", "hidden", "selectable", "providerFolderMissing"] {
            let savedState = model.state, savedPage = model.searchResponse
            if field == "busy" { model.busy = true }
            if field == "loading" { model.mailLoading = true }
            if field == "dirty" { model.unsavedForms.insert("fixture") }
            if field == "scope" { model.section = "sent" }
            if field == "connection" { var changed = accounts; changed[0]["settings"] = .object(["connection": .string("replacement")]); model.state["accounts"] = .array(changed) }
            if field == "disconnected" { model.state["accounts"] = .array([accounts[1]]) }
            if field == "row" { model.searchResponse["messages"] = .array([messages[1]]) }
            if field == "hidden" { var hidden = folder; hidden["hidden"] = .bool(true); model.serverFolders[owner] = [hidden] }
            if field == "selectable" { var unavailable = folder; unavailable["selectable"] = .bool(false); model.serverFolders[owner] = [unavailable] }
            if field == "providerFolderMissing" { var missing = messages[0]; missing["providerFolderMissing"] = .bool(true); model.searchResponse["messages"] = .array([missing]) }
            assert(model.mailDropMessage(token, owner: owner, destination: "label") == nil, "Drop guard failed: \(field)")
            model.busy = false; model.mailLoading = false; model.unsavedForms = []; model.section = "inbox"
            model.state = savedState; model.searchResponse = savedPage; model.serverFolders[owner] = [folder]
        }
        assert(model.finishMailDrop(token, owner: owner, destination: "label"))
        assert(model.organizing?["message"] == messages[0] && model.organizing?["destinationId"].string == "label", "Drop must open review for the captured owner and destination.")
        model.organizing = nil
        assert(!model.finishMailDrop(token, owner: owner, destination: "label"), "Drop tokens must be single use.")
        assert(model.startMailDrag(.object(["id": .string("local"), "accountId": .string(owner)])) == nil)
        for provider in ["microsoft", "imap"] {
            var account = accounts[0]; account["provider"] = .string(provider)
            var message = messages[0]; message["id"] = .string(provider + ":duplicate")
            model.state["accounts"] = .array([account]); model.searchResponse["messages"] = .array([message])
            let token = model.startMailDrag(message)!
            assert(model.mailDropMessage(token, owner: owner, destination: "label") == message)
            assert(model.mailDropDestination(owner, folder: "archive").isEmpty, "Only Gmail may synthesize Archive.")
        }
        print("Mail drag/drop guards cover combined duplicate IDs, stale connections, unavailable targets and review-only single-use routing.")
    }

    @MainActor static func checkMailClicks(_ model: AppModel, messages: [JSON]) {
        model.starting = false
        let window = NSWindow(contentRect: NSRect(x: 50, y: 50, width: 1220, height: 780), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: MailWorkspace().environmentObject(model))
        window.contentView = host; window.makeKeyAndOrderFront(nil)
        defer { window.close(); window.contentView = nil; model.selectedMessage = nil; model.error = "" }
        RunLoop.current.run(until: Date().addingTimeInterval(0.5)); host.layoutSubtreeIfNeeded()
        func lists(_ view: NSView) -> [NSTableView] {
            if let list = view as? NSTableView { return [list] }
            return view.subviews.flatMap(lists)
        }
        guard let list = lists(host).first(where: { $0.numberOfRows == messages.count && $0.frame.width > 250 }) else {
            assertionFailure("The production mail list is missing."); return
        }
        assert(list.allowsMultipleSelection, "The native mail table is in single-selection mode.")
        func click(_ row: Int, modifiers: NSEvent.ModifierFlags = []) {
            let rect = list.rect(ofRow: row), point = list.convert(NSPoint(x: rect.midX, y: rect.midY), to: nil)
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: modifiers, timestamp: ProcessInfo.processInfo.systemUptime,
                                              windowNumber: window.windowNumber, context: nil, eventNumber: row, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0)!
                NSApp.postEvent(event, atStart: false)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.stopModal() }
            NSApp.runModal(for: window)
        }
        for (row, message) in messages.enumerated() {
            click(row)
            assert(model.selectedMessage == message.viewID && model.current?["accountId"] == message["accountId"], "Clicking a draggable row must select its owned message.")
        }
        click(0); click(1, modifiers: .command)
        assert(model.selectedMessages == Set(messages.map(\.viewID)), "Command-click must select both account-owned duplicate IDs: \(model.selectedMessages), native: \(list.selectedRowIndexes)")
        click(0)
        assert(model.selectedMessages == [messages[0].viewID], "Plain-click must collapse multiple selection: \(model.selectedMessages)")
        click(1, modifiers: .shift)
        assert(model.selectedMailRows.count == 2, "Shift-click must select a range in the draggable native mail list: \(model.selectedMessages), native: \(list.selectedRowIndexes)")
        model.selectMailMessages([messages[1].viewID])
        assert(model.selectedMailRows == [messages[1]] && model.current?["accountId"] == messages[1]["accountId"])
        print("Native clicks on the production draggable mail list select each duplicate-ID message's own reader identity.")
    }

    @MainActor static func checkFolderLayouts() {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("morrow-folder-layout-\(UUID())")
        let previous = getenv("MORROW_DATA_DIR").map { String(cString: $0) }
        setenv("MORROW_DATA_DIR", temporary.path, 1)
        let model = AppModel()
        if let previous { setenv("MORROW_DATA_DIR", previous, 1) } else { unsetenv("MORROW_DATA_DIR") }
        defer { try? FileManager.default.removeItem(at: temporary) }
        let owner = "folder-layout@example.invalid"
        let folders: [JSON] = [
            .object(["id": .string("work"), "name": .string("Work"), "leafName": .string("Work"), "kind": .string("label"), "editable": .bool(true)]),
            .object(["id": .string("client"), "name": .string("Work/Long customer folder 中文"), "leafName": .string("Long customer folder 中文"), "parentId": .string("work"), "kind": .string("label"), "editable": .bool(true)])
        ]
        model.state = .object(["accounts": .array([.object(["id": .string(owner), "provider": .string("google")])]), "serverFolders": .object([owner: .object(["provider": .string("google"), "canManage": .bool(true), "folders": .array(folders), "managementFolders": .array(folders)])])])
        let message: JSON = .object(["id": .string("google:fixture"), "accountId": .string(owner), "subject": .string("Fictional message"), "providerLabelIds": .array([.string("INBOX"), .string("work")])])
        let views = [AnyView(FolderManagementView(owner: owner, initialFolder: "client")), AnyView(FolderManagementView(owner: owner, initialFolder: "", creationOnly: true)), AnyView(OrganizeMailView(message: message, preferredKind: "labels"))]
        for view in views {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 920, height: 700), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            let host = NSHostingView(rootView: view.environmentObject(model)); window.contentView = host; window.orderBack(nil)
            RunLoop.current.run(until: Date().addingTimeInterval(0.3)); host.layoutSubtreeIfNeeded()
            let settled = host.frame
            RunLoop.current.run(until: Date().addingTimeInterval(0.2)); host.layoutSubtreeIfNeeded()
            assert(host.frame == settled && host.fittingSize.height <= 700, "Folder manager/create/checklist must fit and settle without a constraint loop.")
            window.close()
        }
        print("Cached folder hierarchy, create form and Gmail checklist fit native sheets without provider/service requests.")
    }

    @MainActor static func checkComposeLayout() {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("morrow-compose-layout-\(UUID())")
        let previous = getenv("MORROW_DATA_DIR").map { String(cString: $0) }
        setenv("MORROW_DATA_DIR", temporary.path, 1)
        let model = AppModel()
        if let previous { setenv("MORROW_DATA_DIR", previous, 1) } else { unsetenv("MORROW_DATA_DIR") }
        defer { try? FileManager.default.removeItem(at: temporary) }
        let owner = "reply-layout@example.invalid"
        let account: JSON = .object(["id": .string(owner), "settings": .object(["configured": .bool(true)])])
        model.state = .object(["accounts": .array([account])])
        for mode in ["new", "reply", "savedReply", "forward"] {
            var draft = Draft(); draft.accountID = owner
            if mode == "reply" || mode == "savedReply" { draft.replyToID = "owned-original" }
            if mode == "savedReply" { draft.savedID = "saved-reply" }
            draft.forwarding = mode == "forward"
            let host = NSHostingView(rootView: ComposeView(initial: draft).environmentObject(model))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false; window.contentView = host; window.orderBack(nil)
            RunLoop.current.run(until: Date().addingTimeInterval(0.3)); host.layoutSubtreeIfNeeded()
            let settled = host.fittingSize
            RunLoop.current.run(until: Date().addingTimeInterval(0.2)); host.layoutSubtreeIfNeeded()
            assert(host.fittingSize == settled && settled.height <= 820, "Composer layout must settle and keep its actions visible.")
            let expected = min(draft.replyToID.isEmpty ? 740 : 1180, (NSScreen.main?.visibleFrame.width ?? 1280) - 80)
            assert(abs(settled.width - expected) < 2, "Replies must use the wider two-column sheet, including saved replies.")
            window.close(); window.contentView = nil
        }
        print("New/forward and wider reply/saved-reply composers settle without starting provider work.")
    }

    @MainActor static func checkCalendarLayout() {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("morrow-calendar-layout-\(UUID())")
        let previous = getenv("MORROW_DATA_DIR").map { String(cString: $0) }
        setenv("MORROW_DATA_DIR", temporary.path, 1)
        let model = AppModel()
        if let previous { setenv("MORROW_DATA_DIR", previous, 1) } else { unsetenv("MORROW_DATA_DIR") }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1220, height: 800), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close(); try? FileManager.default.removeItem(at: temporary) }
        let host = NSHostingView(rootView: HSplitView {
            Color.clear.frame(width: 230)
            NativeCalendarView().environmentObject(model)
        })
        window.contentView = host
        window.orderBack(nil)
        for size in [NSSize(width: 1220, height: 800), NSSize(width: 1040, height: 640), NSSize(width: 1440, height: 900)] {
            window.setContentSize(size)
            host.layoutSubtreeIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
            let settled = host.frame
            host.layoutSubtreeIfNeeded()
            assert(host.frame == settled && host.frame.height.isFinite, "Calendar layout must settle without an AppKit constraint loop.")
        }
        print("Calendar month grid settles at compact, standard and wide window sizes.")
    }

    @MainActor static func checkRestoredListWidth() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1220, height: 800), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        var layout = "right", sidebarVisible = true
        var remembered: CGFloat?
        // Match MailWorkspace's conditional panes, including the outer sidebar.
        func content() -> some View {
            HSplitView {
                if sidebarVisible { Color.clear.frame(minWidth: 200, idealWidth: 230).background(InitialSplitPosition(230)) }
                HSplitView {
                    if layout == "right" {
                        Color.clear.frame(minWidth: 260, idealWidth: 320)
                            .background(InitialSplitPosition(remembered) { if layout == "right" { remembered = $0 } })
                    }
                    VSplitView {
                        if layout == "bottom" { Color.clear.frame(minHeight: 160, idealHeight: 240).background(InitialSplitPosition(240)) }
                        Color.clear.frame(minHeight: 200)
                    }.frame(minWidth: 320)
                }
            }
        }
        let host = NSHostingView(rootView: content())
        window.contentView = host
        window.orderBack(nil)
        func splits(_ view: NSView) -> [NSSplitView] {
            ((view as? NSSplitView).map { [$0] } ?? []) + view.subviews.flatMap(splits)
        }
        func listSplit() -> NSSplitView {
            guard let split = splits(host).filter({ $0.isVertical }).last else { fatalError("Right list split did not attach") }
            return split
        }
        func settle() {
            host.layoutSubtreeIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        settle()
        let initial = listSplit()
        assert(initial.arrangedSubviews.count == 2 && remembered != nil, "Right list width was not captured")
        let manual = min(400, initial.bounds.width - 320 - initial.dividerThickness)
        assert(manual > 280, "Fixture has no room to resize: \(initial.bounds)")
        initial.setPosition(manual, ofDividerAt: 0)
        settle()
        assert(abs((remembered ?? 0) - manual) < 2, "Manual list width was not captured: \(String(describing: remembered))")
        for temporary in ["focus", "bottom"] {
            layout = temporary; sidebarVisible = temporary != "focus"
            host.rootView = content()
            settle()
            assert(abs((remembered ?? 0) - manual) < 2, "Removing the list overwrote its width: \(temporary)")
            layout = "right"; sidebarVisible = true
            host.rootView = content()
            settle()
            let restored = listSplit()
            let actual = restored.arrangedSubviews.first?.frame.width ?? 0
            assert(restored.arrangedSubviews.count == 2 && abs(actual - manual) < 2, "List width reset after \(temporary): expected=\(manual), actual=\(actual), bounds=\(restored.bounds)")
        }
        let resized = manual - 30
        listSplit().setPosition(resized, ofDividerAt: 0)
        settle()
        assert(abs((listSplit().arrangedSubviews.first?.frame.width ?? 0) - resized) < 2 && abs((remembered ?? 0) - resized) < 2, "Restoration kept reapplying over the user's divider")
        print("Right list width survives Expand/Restore and Below/Right, and remains resizable.")
    }

    @MainActor static func checkInitialSplit(width: CGFloat, vertical: Bool, lateAttachment: Bool = false, height: CGFloat = 800) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let position: CGFloat = vertical ? 230 : 240
        let host = NSHostingView(rootView: AnyView(Color.clear))
        window.contentView = host
        window.orderBack(nil)
        // Attach after the restored-size window already exists, then perform no
        // model updates: initial sizing must not depend on a later mail refresh.
        if lateAttachment {
            host.rootView = AnyView(Color.clear.frame(minWidth: 200).background(InitialSplitPosition(position)))
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
            let bounds = host.bounds
            window.contentView = nil
            let split = NSSplitView(frame: bounds)
            split.isVertical = true
            split.addArrangedSubview(host)
            split.addArrangedSubview(NSView())
            window.contentView = split
            assert(split.arrangedSubviews.count == 2 && split.arrangedSubviews.first === host && host.superview === split && host.window === window, "Late attachment lost its pane")
            split.adjustSubviews()
            split.setPosition(split.bounds.width / 2, ofDividerAt: 0)
        } else { host.rootView = vertical
            ? AnyView(HSplitView { Color.clear.frame(minWidth: 200).background(InitialSplitPosition(position)); Color.clear.frame(minWidth: 320) })
            : AnyView(VSplitView { Color.clear.frame(minHeight: 160).background(InitialSplitPosition(position)); Color.clear.frame(minHeight: 200) })
        }
        func findSplit(_ view: NSView) -> NSSplitView? {
            if let split = view as? NSSplitView { return split }
            return view.subviews.lazy.compactMap(findSplit).first
        }
        let deadline = Date().addingTimeInterval(3)
        var split: NSSplitView?
        repeat {
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
            split = findSplit(window.contentView!)
            if let first = split?.subviews.first,
               abs((vertical ? first.frame.width : first.frame.height) - position) < 2 { break }
        } while Date() < deadline
        guard let split, let first = split.subviews.first else { fatalError("Split fixture did not attach") }
        let context = "width=\(width), vertical=\(vertical), lateAttachment=\(lateAttachment), bounds=\(split.bounds), panes=\(split.arrangedSubviews.count)"
        assert(abs((vertical ? first.frame.width : first.frame.height) - position) < 2, "Initial pane size waited for an unrelated model update: \(context), pane=\(first.frame)")
        // AppKit constrains the window to its screen; leave room for the other
        // pane's minimum size instead of requesting an impossible 500 points.
        let extent = vertical ? split.bounds.width : split.bounds.height
        let minimumOther: CGFloat = lateAttachment ? 0 : (vertical ? 320 : 200)
        let manual = min(position + 100, extent - minimumOther - split.dividerThickness)
        assert(manual > position + 20, "Fixture has no room to resize: \(context)")
        split.setPosition(manual, ofDividerAt: 0)
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        // SwiftUI can replace its native pane during layout; re-resolve the
        // displayed hierarchy instead of inspecting the retained, detached view.
        var displayed = findSplit(window.contentView!)?.arrangedSubviews.first
        while Date() < deadline && displayed.map({ abs((vertical ? $0.frame.width : $0.frame.height) - manual) >= 2 }) != false {
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
            displayed = findSplit(window.contentView!)?.arrangedSubviews.first
        }
        guard let current = displayed else { fatalError("Resized split fixture did not attach") }
        if current !== first { print("Split fixture re-resolved a replaced native pane after layout.") }
        assert(abs((vertical ? current.frame.width : current.frame.height) - manual) < 2, "Initial sizing reset the user's divider: \(context), requested=\(manual), pane=\(current.frame), previousAttached=\(first.superview === split)")
        window.close()
    }
}
