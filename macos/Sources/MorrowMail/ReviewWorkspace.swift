import SwiftUI
import AppKit

struct ReviewAccountTabs: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var review: ReviewWorkspaceState
    @FocusState private var focused: String?
    private var owners: [String] { ["all"] + model.accounts.map(\.id) }
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: true) {
                HStack(spacing: 7) {
                    ForEach(owners, id: \.self) { owner in
                        Button { review.pickScope(owner) } label: {
                            HStack(spacing: 7) {
                                Text(owner == "all" ? "All accounts" : owner).lineLimit(1)
                                let counts = model.state["today"]["replySuggestionCounts"]
                                let count = counts.isNull ? model.state["today"]["replySuggestions"].array.filter { owner == "all" || review.owner($0) == owner }.count : owner == "all" ? counts.object.values.reduce(0) { $0 + Int($1.number) } : Int(counts[owner].number)
                                Text(count.formatted()).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            }.padding(.horizontal, 12).padding(.vertical, 8)
                                .background(review.scope == owner ? morrowGreen.opacity(0.13) : .clear).clipShape(RoundedRectangle(cornerRadius: 8))
                        }.buttonStyle(.plain).id(owner).focused($focused, equals: owner).help(owner)
                            .accessibilityLabel("\(owner == "all" ? "All accounts" : owner), \(review.scope == owner ? "selected" : "not selected")")
                            .accessibilityIdentifier("review.account.\(owner)")
                            .disabled(review.writing || model.busy)
                    }
                }.padding(.horizontal, 24)
            }.frame(height: 48)
                .onChange(of: review.scope) { owner in proxy.scrollTo(owner, anchor: .center) }
                .onMoveCommand { direction in
                    guard let index = owners.firstIndex(of: focused ?? review.scope), direction == .left || direction == .right, !review.writing, !model.busy else { return }
                    let next = owners[max(0,min(owners.count - 1,index + (direction == .left ? -1 : 1)))]; focused = next; review.pickScope(next)
                }
        }
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
