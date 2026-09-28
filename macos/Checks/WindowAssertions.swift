import AppKit
import SwiftUI

// Standalone fixture, without starting the service or opening any workspace:
// swiftc -D MORROW_WINDOW_CHECKS -parse-as-library macos/Sources/MorrowMail/{Models,AppModel,MorrowMailApp,CalendarView}.swift macos/Checks/WindowAssertions.swift -o /tmp/morrow-window-checks
// /tmp/morrow-window-checks
@main
struct WindowAssertions {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        checkRestoredListWidth()
        if CommandLine.arguments.contains("--list-width-only") { return }
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
        assert(!delegate.applicationShouldHandleReopen(app, hasVisibleWindows: false))
        assert(window.isVisible, "Dock reopen must reveal the same window.")
        assert(delegate.mainWindow === window && model.unsavedForms.contains("fixture-draft"))
        model.busy = false
        assert(!guardDelegate.windowShouldClose(window))
        assert(!delegate.applicationShouldHandleReopen(app, hasVisibleWindows: false))
        assert(window.isVisible && model.unsavedForms.contains("fixture-draft"))
        assert(MorrowDelegate().applicationShouldTerminate(app) == .terminateNow)
        print("Window close/reopen preserves pending work and unsaved forms.")
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
        dragDivider(initial, to: manual)
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
        dragDivider(listSplit(), to: resized)
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
            // Drain SwiftUI's pending layout before observing the initial size
            // or simulating a user drag on the attached native split view.
            window.contentView!.layoutSubtreeIfNeeded()
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
        dragDivider(split, to: manual)
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        assert(abs((vertical ? first.frame.width : first.frame.height) - manual) < 2, "Initial sizing reset the user's divider: \(context), requested=\(manual), pane=\(first.frame)")
        window.close()
    }

    @MainActor static func dragDivider(_ split: NSSplitView, to position: CGFloat) {
        let pane = split.arrangedSubviews[0].frame
        let start = split.isVertical
            ? NSPoint(x: pane.maxX + split.dividerThickness / 2, y: split.bounds.midY)
            : NSPoint(x: split.bounds.midX, y: pane.maxY + split.dividerThickness / 2)
        let end = split.isVertical
            ? NSPoint(x: position + split.dividerThickness / 2, y: start.y)
            : NSPoint(x: start.x, y: position + split.dividerThickness / 2)
        func event(_ type: NSEvent.EventType, _ point: NSPoint) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: split.convert(point, to: nil), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: split.window!.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        }
        // Exercise AppKit's tracking path so SwiftUI observes a real divider drag.
        // Events stay inside this fixture application, without global input access.
        NSApp.postEvent(event(.leftMouseUp, end), atStart: true)
        NSApp.postEvent(event(.leftMouseDragged, end), atStart: true)
        split.mouseDown(with: event(.leftMouseDown, start))
    }
}
