import SwiftUI
import AppKit

struct ReviewAccountTabs: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var review: ReviewWorkspaceState
    /// Return false to keep the current mailbox, for example while confirming unsaved Studio notes.
    var canPick: ((String) -> Bool)? = nil
    @FocusState private var focused: String?
    private var owners: [String] { ["all"] + model.accounts.map(\.id) }
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: true) {
                HStack(spacing: 7) {
                    Text("Mailbox scope").font(.caption).foregroundStyle(.secondary)
                    ForEach(owners, id: \.self) { owner in
                        Button { choose(owner) } label: {
                            HStack(spacing: 7) {
                                Text(owner == "all" ? "All accounts" : owner).lineLimit(1)
                                let counts = model.state["today"]["replySuggestionCounts"]
                                let count = counts.isNull ? model.state["today"]["replySuggestions"].array.filter { owner == "all" || review.owner($0) == owner }.count : owner == "all" ? counts.object.values.reduce(0) { $0 + Int($1.number) } : Int(counts[owner].number)
                                Text(count.formatted()).font(.caption.monospacedDigit()).foregroundStyle(.secondary).help("Replies waiting for review")
                            }.padding(.horizontal, 12).padding(.vertical, 8)
                                .background(review.scope == owner ? morrowGreen.opacity(0.13) : .clear).clipShape(RoundedRectangle(cornerRadius: 8))
                        }.buttonStyle(.plain).id(owner).focused($focused, equals: owner).help(owner)
                            .accessibilityIdentifier("review.account.\(owner)")
                            .disabled(review.writing)
                            // The visible label is the address plus a count. The press looks up
                            // "address, not selected", which never becomes that button's AX title.
                            .accessibilityRepresentation { Button(scopeLabel(owner)) { choose(owner) }.disabled(review.writing) }
                    }
                }.padding(.horizontal, 24)
            }.frame(height: 48)
                .onChange(of: review.scope) { owner in proxy.scrollTo(owner, anchor: .center) }
                .onMoveCommand { direction in
                    guard let index = owners.firstIndex(of: focused ?? review.scope), direction == .left || direction == .right, !review.writing else { return }
                    choose(owners[max(0,min(owners.count - 1,index + (direction == .left ? -1 : 1)))])
                }
        }
    }
    private func scopeLabel(_ owner: String) -> String {
        "\(owner == "all" ? "All accounts" : owner), \(review.scope == owner ? "selected" : "not selected")"
    }
    private func choose(_ owner: String) {
        guard !review.writing, owner != review.scope, canPick?(owner) ?? true else { return }
        focused = owner
        review.pickScope(owner)
    }
}

struct ReviewScrollMemory: NSViewRepresentable {
    let key: String
    let review: ReviewWorkspaceState
    func makeNSView(context: Context) -> NSView { let view = NSView(); attach(view, coordinator: context.coordinator); return view }
    func updateNSView(_ view: NSView, context: Context) { attach(view, coordinator: context.coordinator) }
    func makeCoordinator() -> Coordinator { Coordinator() }
    static func dismantleNSView(_ view: NSView, coordinator: Coordinator) { coordinator.dismantled = true; coordinator.detach() }
    private func attach(_ view: NSView, coordinator: Coordinator) {
        DispatchQueue.main.async { [weak view, weak coordinator] in
            guard let view, let coordinator, !coordinator.dismantled, let scroll = view.enclosingScrollView,
                  coordinator.key != key || coordinator.scroll !== scroll else { return }
            coordinator.detach(); coordinator.key = key; coordinator.scroll = scroll; coordinator.review = review
            let y = review.scrollPositions[key] ?? 0
            scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0,y))); scroll.reflectScrolledClipView(scroll.contentView)
            scroll.contentView.postsBoundsChangedNotifications = true
            coordinator.observer = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: .main) { [weak coordinator] _ in
                MainActor.assumeIsolated { coordinator?.remember() }
            }
        }
    }
    @MainActor final class Coordinator {
        var dismantled = false
        var key = ""; weak var scroll: NSScrollView?; weak var review: ReviewWorkspaceState?; var observer: NSObjectProtocol?
        func remember() { if let scroll { review?.scrollPositions[key] = scroll.contentView.bounds.minY } }
        func detach() { remember(); if let observer { NotificationCenter.default.removeObserver(observer) }; observer = nil; scroll = nil }
    }
}

// A new NSButton's fitting size stays empty until sizeToFit, and the cell can
// accept the accessibility press without sending the button action.
final class ReviewActionControl: NSButton {
    override func accessibilityRole() -> NSAccessibility.Role? { .button }
    override func accessibilityLabel() -> String? { title }
    override func isAccessibilityEnabled() -> Bool { isEnabled }
    override func isAccessibilityHidden() -> Bool { isHiddenOrHasHiddenAncestor }
    override func accessibilityFrame() -> NSRect {
        guard let window, bounds.width > 0, bounds.height > 0 else { return super.accessibilityFrame() }
        return window.convertToScreen(convert(bounds, to: nil))
    }
    override func accessibilityPerformPress() -> Bool {
        guard isEnabled else { return false }
        performClick(nil)
        return true
    }
}

struct ReviewActionButton: NSViewRepresentable {
    var title: String
    var enabled = true
    var identifier = ""
    var keyEquivalent = ""
    var keyModifiers: NSEvent.ModifierFlags = []
    var action: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(action) }
    func makeNSView(context: Context) -> NSButton {
        let button = ReviewActionControl(title: title, target: context.coordinator, action: #selector(Coordinator.press))
        button.bezelStyle = .rounded
        button.bezelColor = .controlAccentColor
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        button.setContentCompressionResistancePriority(.required, for: .vertical)
        updateNSView(button, context: context)
        button.sizeToFit()
        return button
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSButton, context: Context) -> CGSize? {
        nsView.sizeToFit()
        var size = nsView.bounds.size
        if size.width < 8 || size.height < 8 {
            let font = nsView.font ?? NSFont.systemFont(ofSize: NSFont.systemFontSize)
            let text = NSAttributedString(string: nsView.title, attributes: [.font: font]).size()
            size = NSSize(width: ceil(text.width) + 32, height: max(28, ceil(text.height) + 14))
            nsView.setFrameSize(size)
        }
        return size
    }
    func updateNSView(_ button: NSButton, context: Context) {
        context.coordinator.action = action
        if button.title != title { button.title = title; button.invalidateIntrinsicContentSize() }
        button.setAccessibilityLabel(title)
        button.cell?.setAccessibilityLabel(title)
        if !identifier.isEmpty { button.setAccessibilityIdentifier(identifier) }
        button.keyEquivalent = keyEquivalent
        button.keyEquivalentModifierMask = keyModifiers
        button.isEnabled = enabled
    }
    final class Coordinator: NSObject {
        var action: () -> Void
        init(_ action: @escaping () -> Void) { self.action = action }
        @objc func press() { action() }
    }
}

struct OriginalReviewMessage: View {
    @EnvironmentObject var model: AppModel
    let message: JSON
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Original message").font(.headline)
            Text(message["subject"].nonempty ? message["subject"].string : "(No subject)").font(.callout.weight(.semibold))
            Text("\(message["fromName"].string) <\(message["fromEmail"].string)> · \(dateLabel(message["date"].string))").font(.caption).foregroundStyle(.secondary)
            ScrollView { AttachmentReader(message: message).frame(maxWidth: .infinity, alignment: .leading) }.frame(height: 200)
        }.textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
    }
}
