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
        if CommandLine.arguments.contains("--mail-only") { checkMailDrop(); checkReaderBack(); return }
        checkRestoredListWidth()
        if CommandLine.arguments.contains("--list-width-only") { return }
        checkMailDrop()
        checkReaderBack()
        checkFolderLayouts()
        checkFolderSyncSelection()
        checkActivitySummaryDiagnostics()
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

    @MainActor static func checkActivitySummaryDiagnostics() {
        // Uses only immutable metadata: no AppModel, workspace, service or model
        // request is needed to open a matching job outside Today's date/context.
        let owner = "summary-owner@example.invalid", other = "other-summary@example.invalid"
        let checkedAt = JSON.string("2026-10-15T01:00:00Z")
        let job: JSON = .object(["id": .string(String(repeating: "a", count: 64)), "accountId": .string(owner),
                                 "kind": .string("scheduled"), "status": .string("failed"),
                                 "createdAt": .string("2026-10-13T23:55:00Z"), "startedAt": .string("2026-10-14T00:00:00Z"),
                                 "finishedAt": .null, "updatedAt": .string("2026-10-14T00:01:30Z"), "messageCount": .number(12),
                                 "diagnosticCode": .string("summary_timeout"), "diagnostic": .string("The summary job timed out after 90 seconds. No result was saved."),
                                 "automaticRetry": .bool(false), "error": .string("PRIVATE_RAW_PROVIDER_SENTINEL"),
                                 "text": .string("PRIVATE_MAIL_SENTINEL"), "items": .array([.string("PRIVATE_MAIL_SENTINEL")])])
        var task: JSON = .object(["id": .string("last-summary:" + owner), "accountId": .string(owner), "kind": .string("ai"), "summaryJob": job])
        guard let captured = ActivitySummarySnapshot(task: task, checkedAt: checkedAt, connectedAccounts: [owner, other]) else { fatalError("A matching connected summary job could not open") }
        let fields = Dictionary(uniqueKeysWithValues: captured.fields)
        assert(fields["Mailbox"] == owner && fields["Status"] == "Failed" && fields["Trigger"] == "Scheduled" && fields["Messages"] == "12")
        assert(fields["Finished"] == "Not recorded" && fields["Started"] != "Not recorded" && fields["Updated"] != "Not recorded", "Observed update time must not become a fabricated finish time")
        assert(captured.job["error"].isNull && captured.job["text"].isNull && captured.job["items"].isNull, "Details must never retain raw provider error or mail/result payload")
        assert(!captured.fields.contains { $0.1.contains(job["id"].string) }, "Opaque matching identity is not a user-facing report field")

        task["summaryJob"]["id"] = .string(String(repeating: "b", count: 64))
        task["summaryJob"]["status"] = .string("completed")
        assert(captured.job["id"] == job["id"] && captured.job["status"].string == "failed" && captured.checkedAt == checkedAt, "Polling a newer last-summary must not retarget the captured job")
        assert(ActivitySummarySnapshot(task: task, checkedAt: checkedAt, connectedAccounts: [other]) == nil, "Disconnected owner must not open stale summary details")
        task["summaryJob"]["accountId"] = .string(other)
        assert(ActivitySummarySnapshot(task: task, checkedAt: checkedAt, connectedAccounts: [owner, other]) == nil, "A row cannot open another owner's summary")
        task["accountId"] = .string(other)
        assert(ActivitySummarySnapshot(task: task, checkedAt: checkedAt, connectedAccounts: [owner, other])?.owner == other)
        for missingID in [JSON.null, .string(""), .string("   ")] {
            task["summaryJob"]["id"] = missingID
            assert(ActivitySummarySnapshot(task: task, checkedAt: checkedAt, connectedAccounts: [owner, other]) == nil, "Legacy missing job identity must not expose a misleading detail entry")
        }
        assert(activityDate(.null) == nil && activityDate(.string("not-a-date")) == nil && activityDate(.number(.infinity)) == nil)
        assert(activityCount(.null) == nil && activityCount(.number(-1)) == nil && activityCount(.number(1.5)) == nil)
        var timeJob = job
        assert(activitySummaryTime(timeJob).hasPrefix("Updated "), "Recorded update must take precedence over start time")
        timeJob["finishedAt"] = .string("2026-10-14T00:01:20Z")
        assert(activitySummaryTime(timeJob).hasPrefix("Finished "), "Recorded finish must take precedence over update time")
        timeJob["finishedAt"] = .null; timeJob["updatedAt"] = .null
        assert(activitySummaryTime(timeJob).hasPrefix("Started "))
        timeJob["startedAt"] = .null
        assert(activitySummaryTime(timeJob).hasPrefix("Created "))
        timeJob["createdAt"] = .null
        assert(activitySummaryTime(timeJob) == "Job time not recorded.")

        for (status, label) in [("failed", "Failed"), ("cancelled", "Cancelled"), ("interrupted", "Interrupted"), ("skipped", "Skipped")] {
            var stateJob = job; stateJob["status"] = .string(status)
            stateJob["diagnostic"] = .string(String(repeating: "Safe recorded diagnostic. ", count: 18))
            let row: JSON = .object(["accountId": .string(owner), "summaryJob": stateJob])
            guard let snapshot = ActivitySummarySnapshot(task: row, checkedAt: checkedAt, connectedAccounts: [owner]) else { fatalError("Terminal state snapshot is missing") }
            assert(Dictionary(uniqueKeysWithValues: snapshot.fields)["Status"] == label, "Terminal states must remain distinct")
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: 560), styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            let host = NSHostingView(rootView: ActivitySummaryDetails(snapshot: snapshot).padding(16).frame(width: 380))
            window.contentView = host; window.orderBack(nil)
            RunLoop.current.run(until: Date().addingTimeInterval(0.1)); host.layoutSubtreeIfNeeded()
            assert(host.fittingSize.height <= 560, "Summary detail must keep diagnostics scrollable within its native panel")
            window.close(); window.contentView = nil
        }
        print("Activity summary details: captured owned job, distinct terminal states, honest timestamps, legacy/foreign/disconnected rejection and bounded metadata-only native layout passed.")
    }

    @MainActor static func checkMailDrop() {
        let model = AppModel(), owner = "drag@example.invalid", other = "other@example.invalid"
        let accounts: [JSON] = [owner, other].map { .object(["id": .string($0), "provider": .string("google"), "settings": .object(["connection": .string("original")])]) }
        let folder: JSON = .object(["id": .string("label"), "kind": .string("label"), "name": .string("Work / 中文")])
        let messages: [JSON] = [owner, other].map { .object(["id": .string("google:duplicate"), "viewId": .string($0 + ":duplicate"), "accountId": .string($0), "folder": .string("inbox"), "fromName": .string("Alex Chen · Long sender name 中文"), "fromEmail": .string("alex@example.invalid"), "subject": .string("Fictional project update"), "preview": .string("A short preview for the native mail list layout."), "date": .string("2026-10-08T09:41:00Z")]) }
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
        var ancestor = list.superview
        while ancestor != nil && !(ancestor is NSSplitView) { ancestor = ancestor?.superview }
        guard let split = ancestor as? NSSplitView else { fatalError("Mail list split is missing") }
        for width in [260.0, 320.0, 500.0] {
            split.setPosition(width, ofDividerAt: 0)
            for density in ["compact", "comfortable", "spacious"] {
                model.state["settings"]["preferences"]["density"] = .string(density)
                RunLoop.current.run(until: Date().addingTimeInterval(0.1)); host.layoutSubtreeIfNeeded()
                guard let displayed = lists(host).first(where: { $0.numberOfRows == messages.count && $0.frame.width > 250 }) else { fatalError("Resizing lost the mail list") }
                let row = displayed.rect(ofRow: 0)
                assert(row.height > 30 && row.height < 180, "Mail metadata must stay bounded at \(width), \(density): \(row)")
                assert(displayed.enclosingScrollView?.hasHorizontalScroller == false, "Mail rows must truncate within the list")
            }
        }
        print("Mail rows with long sender/account text stay bounded at narrow/default/wide widths in every density.")
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

    @MainActor static func checkReaderBack() {
        let defaults = UserDefaults.standard
        let previousLayout = defaults.object(forKey: "mailReaderLayout")
        let previousSidebar = defaults.object(forKey: "mailSidebarVisible")
        defaults.set("focus", forKey: "mailReaderLayout")
        defaults.set(false, forKey: "mailSidebarVisible")
        defer {
            if let previousLayout { defaults.set(previousLayout, forKey: "mailReaderLayout") } else { defaults.removeObject(forKey: "mailReaderLayout") }
            if let previousSidebar { defaults.set(previousSidebar, forKey: "mailSidebarVisible") } else { defaults.removeObject(forKey: "mailSidebarVisible") }
        }
        let model = AppModel(), owner = "reader-back@example.invalid"
        let message: JSON = .object(["id": .string("fixture-reader"), "viewId": .string(owner + ":fixture-reader"), "accountId": .string(owner), "folder": .string("inbox"), "subject": .string("Reader recovery fixture")])
        model.state = .object(["account": .object(["id": .string(owner)]), "accounts": .array([.object(["id": .string(owner)])]), "messages": .array([message])])
        model.starting = false; model.selectedMessage = message.viewID
        let window = NSWindow(contentRect: NSRect(x: 50, y: 50, width: 1040, height: 700), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: MailWorkspace().environmentObject(model))
        window.contentView = host; window.makeKeyAndOrderFront(nil)
        defer { window.close(); window.contentView = nil }
        // No service is started: the production detail request fails locally.
        RunLoop.current.run(until: Date().addingTimeInterval(0.4)); host.layoutSubtreeIfNeeded()
        assert(!model.messageError.isEmpty && model.current?.viewID == message.viewID && model.messageDetail.isNull, "Fixture did not reach the Focus reader's failed-load state")
        func press(_ characters: String, keyCode: UInt16) {
            let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                        windowNumber: window.windowNumber, context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: keyCode)!
            NSApp.postEvent(event, atStart: false)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.stopModal() }
            NSApp.runModal(for: window)
            host.layoutSubtreeIfNeeded()
        }
        press("\u{1b}", keyCode: 53)
        assert(model.selectedMessage == nil && model.selectedMessages.isEmpty && model.messageDetail.isNull && model.messageError.isEmpty, "Escape did not return from failed loading to the message list")
        func lists(_ view: NSView) -> [NSTableView] {
            ((view as? NSTableView).map { [$0] } ?? []) + view.subviews.flatMap(lists)
        }
        assert(lists(host).contains { $0.numberOfRows == 1 && $0.frame.width > 250 }, "Back did not restore the Focus layout's native message list")
        press("\u{f701}", keyCode: 125)
        assert(model.selectedMessage == message.viewID, "The restored message list did not receive keyboard navigation after Back")
        print("Focus reader failure exposes Escape/Back, clears detail/error and restores keyboard navigation to the native message list.")
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

    @MainActor static func checkFolderSyncSelection() {
        let owner = "folders@example.invalid", other = "other@example.invalid"
        func row(_ id: String, selected: Bool = false, available: Bool = true) -> JSON {
            .object(["folderId": .string(id), "name": .string(id), "selected": .bool(selected), "available": .bool(available),
                     "selectionId": selected ? .string("saved-" + id) : .null, "status": .string(selected ? "queued" : "unselected")])
        }
        let original: JSON = .object(["accountId": .string(owner), "supported": .bool(true), "connectionVersion": .string("connection-1"),
            "selectionVersion": .string("selection-1"), "catalogFresh": .bool(true), "automaticSyncEnabled": .bool(false), "intervalMinutes": .number(0),
            "folders": .array([row("Projects", selected: true), row("Projects / 中文"), row("Other")])])
        var editor = FolderSyncSelection(owner: owner)
        assert(editor.adopt(original) && !editor.dirty && editor.canSync && !editor.canSave)
        editor.select("Projects / 中文", true)
        assert(editor.dirty && editor.canSave && !editor.canSync)
        assert(Set(editor.payload["folderIds"].array.map(\.string)) == ["Projects", "Projects / 中文"])
        assert(editor.payload["connectionVersion"] == original["connectionVersion"] && editor.payload["selectionVersion"] == original["selectionVersion"])
        var replacement = original; replacement["selectionVersion"] = .string("selection-2")
        assert(!editor.adopt(replacement) && editor.dirty && editor.snapshot == original, "A late reload must not replace unsaved selection.")
        editor.discard(); assert(editor.adopt(replacement) && !editor.dirty)
        var otherOwner = replacement; otherOwner["accountId"] = .string(other)
        assert(!editor.saved(otherOwner) && editor.snapshot == replacement, "Duplicate folder paths must retain mailbox ownership.")
        var duplicate = original; duplicate["folders"] = .array([row("Projects"), row("Projects")])
        assert(!editor.adopt(duplicate))
        var stale = original; stale["catalogFresh"] = .bool(false)
        stale["folders"] = .array([row("Projects", selected: true, available: false), row("Other", selected: true, available: false)])
        assert(editor.saved(stale)); editor.select("Projects", false); assert(editor.dirty && !editor.canSave)
        editor.deselectAll(); assert(editor.canSave && editor.payload["folderIds"] == .array([]), "All selections can be cancelled with a stale folder catalog.")
        var crowded = original; crowded["folders"] = .array((0..<21).map { row("Folder \($0)") })
        assert(editor.saved(crowded))
        for index in 0..<21 { editor.select("Folder \(index)", true) }
        assert(editor.selected.count == 20 && editor.canSave)
        editor.discard(); assert(editor.selected.isEmpty)
        for code in ["folder_changed", "connection_changed", "checkpoint_invalid"] {
            var reset = original, affected = row("Projects", selected: true)
            affected["errorCode"] = .string(code); affected["recoveryAction"] = .string("reselect")
            reset["folders"] = .array([affected]); assert(editor.saved(reset))
            assert(!editor.dirty && editor.needsBaseline && !editor.canSave && !editor.canSync)
            editor.reviewedBaseline = true; assert(editor.canSave, "Saving unchanged paths must allow an explicitly reviewed new baseline.")
            editor.select("Projects", false); assert(!editor.reviewedBaseline && editor.canSave)
        }
        var retry = original, failed = row("Projects", selected: true)
        failed["recoveryAction"] = .string("retry"); failed["status"] = .string("retry")
        failed["error"] = .string("The mail server could not be reached. Try again later.")
        failed["coverageWarning"] = .string("The initial recent-page scan reached its limit. Use history import to download the remaining older mail.")
        failed["lastAttemptAt"] = .string("2026-10-15T09:00:00Z")
        retry["folders"] = .array([failed, row("Other")]); assert(editor.saved(retry))
        assert(editor.retryPayload(failed)?["selectionId"].string == "saved-Projects")
        assert(editor.retryPayload(failed)?["connectionVersion"] == retry["connectionVersion"])
        assert(editor.syncPayload["folderSyncConnectionVersion"] == retry["connectionVersion"] && editor.syncPayload["folderSyncSelectionVersion"] == retry["selectionVersion"])
        editor.select("Other", true); assert(editor.retryPayload(failed) == nil); editor.discard()
        assert(folderSyncTimes(failed).components(separatedBy: "Not recorded").count == 3)
        assert(folderSyncStatus(failed) == "Retry pending")
        failed["status"] = .string("current"); assert(folderSyncStatus(failed) == "Last bounded check caught up")
        failed["status"] = .string("unknown"); assert(folderSyncStatus(failed) == "Status not recorded")
        let connection: JSON = .object(["configured": .bool(true)]), scope = other + "\ninbox"
        let accounts: [JSON] = [owner, other].map { .object(["id": .string($0), "settings": connection]) }
        func current(active: Bool = true, page: String? = nil, list: [JSON]? = nil, ticket: UInt64 = 7) -> Bool {
            folderSyncContextCurrent(owner: owner, scope: scope, connection: connection, ticket: 7, active: active, currentScope: page ?? scope, accounts: list ?? accounts, operation: ticket)
        }
        assert(current(), "A mailbox's own folder controls can open from another selected mailbox.")
        assert(!current(active: false) && !current(page: owner + "\ninbox") && !current(ticket: 8) && !current(list: [accounts[1]]))
        var reconnected = accounts; reconnected[0]["settings"] = .object(["configured": .bool(true), "connection": .string("new")])
        assert(!current(list: reconnected), "Late responses after reconnect must not replace the buffer.")
        let capturedVersions = FolderSyncVersions(original), newerSelection = FolderSyncVersions(replacement)
        var newConnection = original; newConnection["connectionVersion"] = .string("connection-2")
        let reconnectedVersions = FolderSyncVersions(newConnection)
        assert(folderSyncVersionsCurrent(capturedVersions, capturedVersions))
        assert(!folderSyncVersionsCurrent(capturedVersions, newerSelection)
            && !folderSyncVersionsCurrent(capturedVersions, reconnectedVersions), "A queued request must stop when the observed saved versions change.")
        assert(!folderSyncVersionsCurrent(capturedVersions, newerSelection, response: capturedVersions)
            && !folderSyncVersionsCurrent(capturedVersions, reconnectedVersions, response: capturedVersions), "A late status response must not undo a newer selection or reconnect.")
        assert(folderSyncVersionsCurrent(capturedVersions, capturedVersions, response: newerSelection)
            && folderSyncVersionsCurrent(capturedVersions, newerSelection, response: newerSelection), "A successful save remains valid if a state refresh observes that same response first.")

        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("morrow-folder-sync-layout-\(UUID())")
        let previous = getenv("MORROW_DATA_DIR").map { String(cString: $0) }
        setenv("MORROW_DATA_DIR", temporary.path, 1); let model = AppModel()
        if let previous { setenv("MORROW_DATA_DIR", previous, 1) } else { unsetenv("MORROW_DATA_DIR") }
        defer { try? FileManager.default.removeItem(at: temporary) }
        model.state = .object(["accounts": .array(accounts), "account": .object(["id": .string(other)]), "serverFolderSync": .object([owner: retry])])
        // Real perform() queues its MainActor closure. Revoke a captured context
        // before yielding; the request counter is a local spy, never transport.
        var queuedActive = true, queuedScope = scope, queuedAccounts = accounts, queuedTicket: UInt64 = 7
        var queuedVersions = capturedVersions, requests = 0
        func queueCheck(_ revoke: () -> Void, expected: Int) {
            queuedActive = true; queuedScope = scope; queuedAccounts = accounts; queuedTicket = 7; queuedVersions = capturedVersions
            let before = requests
            assert(model.perform {
                guard folderSyncContextCurrent(owner: owner, scope: scope, connection: connection, ticket: 7,
                    active: queuedActive, currentScope: queuedScope, accounts: queuedAccounts, operation: queuedTicket),
                    folderSyncVersionsCurrent(capturedVersions, queuedVersions) else { return }
                requests += 1
            })
            assert(requests == before, "perform must defer its action until the MainActor can run it.")
            revoke()
            let deadline = Date().addingTimeInterval(2)
            while model.busy && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
            assert(!model.busy && requests == before + expected, "A revoked queued folder action reached the request boundary.")
        }
        queueCheck({}, expected: 1)
        queueCheck({ queuedActive = false }, expected: 0)
        queueCheck({ queuedScope = owner + "\ninbox" }, expected: 0)
        queueCheck({ queuedAccounts = [accounts[1]] }, expected: 0)
        queueCheck({ queuedAccounts = reconnected }, expected: 0)
        queueCheck({ queuedTicket = 8 }, expected: 0)
        queueCheck({ queuedVersions = newerSelection }, expected: 0)
        queueCheck({ queuedVersions = reconnectedVersions }, expected: 0)
        model.syncingFolders = .object(["id": .string(owner)])
        assert(!model.canNavigate)
        let host = NSHostingView(rootView: FolderSyncView(owner: owner).environmentObject(model))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 850), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.orderBack(nil)
        RunLoop.current.run(until: Date().addingTimeInterval(0.3)); host.layoutSubtreeIfNeeded(); let settled = host.fittingSize
        RunLoop.current.run(until: Date().addingTimeInterval(0.2)); host.layoutSubtreeIfNeeded()
        assert(host.fittingSize == settled && settled.height <= 850 && settled.width <= 720, "Selected-folder controls and errors must fit a native sheet.")
        window.close(); window.contentView = nil; model.syncingFolders = nil
        assert(model.unsavedForms.isEmpty && !model.busy)
        print("Selected IMAP folder state preserves owner/version/edits, explicit baseline review, stale-catalog cancellation, limits and real status times; native sheet settles without a running service.")
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
