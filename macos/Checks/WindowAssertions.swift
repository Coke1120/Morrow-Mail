import AppKit
import SwiftUI

// Standalone fixture, without starting the service or opening any workspace:
// swiftc -D MORROW_WINDOW_CHECKS -parse-as-library macos/Sources/MorrowMail/{Models,AppModel,MorrowMailApp}.swift macos/Checks/WindowAssertions.swift -o /tmp/morrow-window-checks
// /tmp/morrow-window-checks
@main
struct WindowAssertions {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
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
            host.rootView = AnyView(Color.clear.background(InitialSplitPosition(position)))
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
            let split = NSSplitView(frame: window.contentView!.bounds)
            split.isVertical = true
            split.addArrangedSubview(host)
            split.addArrangedSubview(NSView())
            window.contentView = split
            split.setPosition(width / 2, ofDividerAt: 0)
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
        let context = "width=\(width), vertical=\(vertical), lateAttachment=\(lateAttachment), bounds=\(split.bounds)"
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
        assert(abs((vertical ? first.frame.width : first.frame.height) - manual) < 2, "Initial sizing reset the user's divider: \(context), requested=\(manual), pane=\(first.frame)")
        window.close()
    }
}
