import SwiftUI
import AppKit

let morrowGreen = Color(nsColor: NSColor(name: nil) { appearance in
    appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        ? NSColor(srgbRed: 0.65, green: 0.83, blue: 0.69, alpha: 1)
        : NSColor(srgbRed: 0.10, green: 0.29, blue: 0.24, alpha: 1)
})

#if !MORROW_WINDOW_CHECKS
@main
struct MorrowMailApp: App {
    @NSApplicationDelegateAdaptor(MorrowDelegate.self) var delegate
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        Window("Morrow Mail", id: "main") {
            MailWorkspace()
                .environmentObject(model)
                .tint(morrowGreen)
                .preferredColorScheme(model.colorScheme)
                .frame(minWidth: 1040, minHeight: 640)
                .background(WindowGuard(model: model, delegate: delegate))
                .task { delegate.model = model; await model.start() }
                .onChange(of: scenePhase) { phase in if phase == .active { model.refreshWhenActive() } }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1220, height: 800)
        .commands {
            ReadingLayoutCommands(model: model)
            CommandGroup(replacing: .newItem) {
                Button("New Message") { model.newDraft() }.keyboardShortcut("n").disabled(model.starting || model.busy || model.showSettings)
            }
            CommandGroup(replacing: .appSettings) {
                Button("Settings…") { model.settings() }.keyboardShortcut(",").disabled(model.starting || model.busy || model.compose != nil)
            }
            CommandGroup(after: .windowSize) {
                Menu("Window Size") {
                    Button("Compact · 1040 × 700") { resizeWindow(width: 1040, height: 700) }
                    Button("Standard · 1220 × 800") { resizeWindow(width: 1220, height: 800) }
                    Button("Wide · 1440 × 900") { resizeWindow(width: 1440, height: 900) }
                    Button("Fill Available Screen") { if let screen = NSApp.mainWindow?.screen { resizeWindow(width: screen.visibleFrame.width, height: screen.visibleFrame.height) } }
                }
            }
            CommandMenu("Mailbox") {
                Button("Search Mail") { if !mailFolders.contains(model.section) { model.section = "inbox" }; model.searchFocus += 1 }.keyboardShortcut("f").disabled(!model.canNavigate || model.compose != nil || model.showSettings)
                Button("Reply") { if let message = model.current { model.newDraft(Draft(message: message, reply: true)) } }.keyboardShortcut("r", modifiers: [.command, .shift]).disabled(!model.canNavigate || model.current == nil || model.messageDetail.viewID != model.current?.viewID || model.current?["folder"].string == "drafts")
                Button("Move / Labels / Spam on Provider…") { model.organizing = model.current }.keyboardShortcut("m", modifiers: [.command, .shift]).disabled(!model.canNavigate || !(model.current.map(model.canOrganize) ?? false))
                Button("Archive Locally") { if let message = model.current { model.patch(message, .object(["folder": .string("archive")])) } }.keyboardShortcut("a", modifiers: [.command, .shift]).disabled(!model.canNavigate || model.current == nil || model.current?["folder"].string == "drafts")
                Button("Toggle Read Locally") { if let message = model.current { model.patch(message, .object(["read": .bool(!message["read"].bool)])) } }.keyboardShortcut("u", modifiers: [.command, .shift]).disabled(!model.canNavigate || model.current == nil)
                Divider()
                Button("Sync Mail") { model.perform { try await model.sync() } }.keyboardShortcut("r").disabled(!model.canNavigate || model.starting)
                Button("Inbox") { model.section = "inbox" }.keyboardShortcut("1").disabled(!model.canNavigate)
                Button("AI Studio") { model.section = "studio" }.keyboardShortcut("2").disabled(!model.canNavigate)
                Button("Calendar") { model.section = "calendar" }.keyboardShortcut("3").disabled(!model.canNavigate)
                Button("Today") { model.section = "today" }.keyboardShortcut("4").disabled(!model.canNavigate)
            }
        }
    }
}
#endif

struct ReadingLayoutCommands: Commands {
    @ObservedObject var model: AppModel
    @AppStorage("mailReaderLayout") private var layout = "right"
    @AppStorage("mailSidebarVisible") private var sidebarVisible = true
    var body: some Commands {
        CommandGroup(after: .sidebar) {
            Toggle("Show Sidebar", isOn: $sidebarVisible)
                .keyboardShortcut("s", modifiers: [.command, .control])
                .disabled(model.starting)
            Picker("Reading Layout", selection: $layout) {
                Text("Reader on Right").tag("right")
                Text("Reader Below").tag("bottom")
                Text("Focus Reading").tag("focus")
            }.disabled(!model.canNavigate || !model.hasMailbox)
        }
    }
}

@MainActor
final class MorrowDelegate: NSObject, NSApplicationDelegate {
    weak var model: AppModel?
    weak var mainWindow: NSWindow?
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        guard let mainWindow else { return true }
        if mainWindow.isMiniaturized { mainWindow.deminiaturize(nil) }
        mainWindow.makeKeyAndOrderFront(nil)
        sender.activate(ignoringOtherApps: true)
        return false
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let model else { return .terminateNow }
        if model.restartingForUpdate { model.stop(); return .terminateNow }
        if model.busy {
            let alert = NSAlert(); alert.messageText = "Wait for the current operation to finish."
            alert.informativeText = "Morrow is saving or communicating with a provider. You can quit when it finishes."
            alert.runModal(); return .terminateCancel
        }
        if !model.unsavedForms.isEmpty && !model.confirmDiscard("Quit with unsaved changes?") { return .terminateCancel }
        model.stop(); return .terminateNow
    }
}

struct WindowGuard: NSViewRepresentable {
    let model: AppModel
    let delegate: MorrowDelegate
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            if let window = view.window {
                window.styleMask.formUnion([.titled, .closable, .miniaturizable, .resizable])
                window.collectionBehavior.insert(.fullScreenPrimary)
                for kind: NSWindow.ButtonType in [.closeButton, .miniaturizeButton, .zoomButton] { window.standardWindowButton(kind)?.isHidden = false }
                window.setFrameAutosaveName("MorrowMainWindow")
                delegate.mainWindow = window
                context.coordinator.original = window.delegate
                window.delegate = context.coordinator
            }
        }
        return view
    }
    func updateNSView(_ view: NSView, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(model) }
    @MainActor final class Coordinator: NSObject, NSWindowDelegate {
        let model: AppModel
        weak var original: NSWindowDelegate?
        init(_ model: AppModel) { self.model = model }
        func windowShouldClose(_ sender: NSWindow) -> Bool {
            // Keep the scene, unsaved forms and service alive. Cmd-Q still uses the quit guards above.
            sender.orderOut(nil)
            return false
        }
        override func responds(to selector: Selector!) -> Bool { super.responds(to: selector) || (original?.responds(to: selector) ?? false) }
        override func forwardingTarget(for selector: Selector!) -> Any? { original }
    }
}

struct EmptyPane: View {
    var title: String
    var detail: String
    var symbol = "tray"
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbol).font(.system(size: 42, weight: .light)).foregroundStyle(morrowGreen)
            Text(title).font(.title2.weight(.semibold))
            Text(detail).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 380)
        }.padding(36).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct SectionHeading: View {
    let title: String
    let detail: String
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.system(size: 30, weight: .semibold, design: .rounded))
            Text(detail).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.bottom, 12)
    }
}

struct TextArea: View {
    let title: String
    @Binding var text: String
    var height: CGFloat = 100
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline)
            TextEditor(text: $text).font(.body).frame(minHeight: height)
                .padding(6).background(.background).clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
                .accessibilityLabel(title)
        }
    }
}

@MainActor
func resizeWindow(width: CGFloat, height: CGFloat) {
    guard let window = NSApp.mainWindow, !window.styleMask.contains(.fullScreen), let screen = window.screen else { return }
    let visible = screen.visibleFrame
    let size = NSSize(width: min(width, visible.width), height: min(height, visible.height))
    let origin = NSPoint(x: max(visible.minX, min(window.frame.minX, visible.maxX - size.width)), y: max(visible.minY, min(window.frame.maxY - size.height, visible.maxY - size.height)))
    window.setFrame(NSRect(origin: origin, size: size), display: true, animate: true)
}
