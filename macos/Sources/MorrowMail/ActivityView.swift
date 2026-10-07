import AppKit
import SwiftUI

struct ActivityStatusView: View {
    let value: JSON
    var error: String = ""
    var onOpenSettings: (() -> Void)? = nil
    @State private var expanded = false

    private var tasks: [JSON] { value["tasks"].array }
    private var ready: Bool { if case .array = value["tasks"] { return true }; return false }
    private var running: [JSON] { tasks.filter { $0["status"].string == "running" } }
    private var queued: Int { tasks.filter { $0["status"].string == "queued" }.count }
    private var attention: Int { tasks.filter { ["paused", "failed", "interrupted"].contains($0["status"].string) }.count }
    private var accounts: [String] { tasks.reduce(into: []) { result, task in let account = owner(task); if !result.contains(account) { result.append(account) } } }
    private var summary: String {
        if !error.isEmpty { return ready ? "Activity unavailable · Showing last known status" : "Activity unavailable" }
        if !ready { return "Checking activity…" }
        let fetching = running.filter { ["sync", "import"].contains($0["kind"].string) }.count
        let ai = running.filter { ["ai", "learning", "index"].contains($0["kind"].string) }.count
        let parts = [("Fetching mail", fetching), ("AI", ai), ("Queued", queued), ("Needs attention", attention)]
            .filter { $0.1 > 0 }.map { "\($0.0) · \($0.1)" }
        return parts.isEmpty ? "No work in progress" : parts.joined(separator: " / ")
    }

    var body: some View {
        Button { expanded.toggle() } label: {
            HStack(spacing: 6) {
                if error.isEmpty && (!running.isEmpty || !ready) { ProgressView().controlSize(.small).accessibilityHidden(true) }
                if !error.isEmpty || attention > 0 { Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange) }
                else if running.isEmpty && ready { Image(systemName: queued > 0 ? "clock" : "checkmark.circle").foregroundStyle(.secondary) }
                Text(summary).font(.caption).lineLimit(2)
                Image(systemName: "chevron.down").font(.caption2).accessibilityHidden(true)
            }
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("Mail and AI activity: \(summary)")
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
        .help("Show fetching, import, and AI task details")
        .popover(isPresented: $expanded) { panel }
        .onChange(of: summary) { next in
            NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested, userInfo: [.announcement: next, .priority: NSAccessibilityPriorityLevel.low.rawValue])
        }
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Mail & AI activity").font(.headline)
            if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            Text("Idle does not mean your entire mailbox is downloaded. Recent-mail sync checks a limited set of messages; older downloaded messages may still have an earlier read/unread state. History is limited to your selected import range.").font(.caption).foregroundStyle(.secondary)
            if let checked = date(value["checkedAt"]) { Text("Activity status updated \(checked) · Local status, not the last mailbox sync.").font(.caption).foregroundStyle(.secondary) }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(accounts, id: \.self) { account in
                        VStack(alignment: .leading, spacing: 10) {
                            Divider()
                            Text(account).font(.subheadline.bold()).textSelection(.enabled)
                            ForEach(Array(tasks.filter { owner($0) == account }.enumerated()), id: \.offset) { _, task in taskRow(task) }
                        }
                    }
                    if ready && tasks.isEmpty { Text("No recent tasks.").foregroundStyle(.secondary) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: 300)
            if let onOpenSettings { Button("Import settings") { expanded = false; onOpenSettings() } }
        }.padding(16).frame(width: 380)
    }

    private func taskRow(_ task: JSON) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(task["label"].nonempty ? task["label"].string : ["sync": "Fetching mail", "import": "Importing history", "ai": "AI processing", "learning": "Learning writing style", "index": "Indexing mail"][task["kind"].string] ?? "Background task").font(.callout.bold())
            Text(status(task["status"].string)).font(.caption).foregroundStyle(["paused", "failed", "interrupted"].contains(task["status"].string) ? Color.orange : Color.secondary)
            if task["detail"].nonempty { Text(task["detail"].string).font(.callout).textSelection(.enabled) }
            if let completed = count(task["completed"]) {
                Text(count(task["total"]).map { "\(completed) / \($0)" } ?? "\(completed) completed · Total not yet known").font(.caption).monospacedDigit()
            } else if let total = count(task["total"]) { Text("Total \(total) · Progress not yet known").font(.caption) }
            if task["error"].nonempty { Text(task["error"].string).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
            if let updated = date(task["updatedAt"]) { Text("Updated \(updated)").font(.caption).foregroundStyle(.secondary) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func owner(_ task: JSON) -> String { task["accountId"].nonempty ? task["accountId"].string : "Workspace" }
    private func status(_ value: String) -> String { ["complete", "completed"].contains(value) ? "Completed" : value.isEmpty ? "Status unknown" : value.capitalized }
    private func count(_ value: JSON) -> String? {
        guard case .number(let number) = value, number.isFinite, number >= 0, number <= 9_007_199_254_740_991, number.rounded() == number else { return nil }
        return String(format: "%.0f", number)
    }
    private func date(_ value: JSON) -> String? {
        if case .number(let milliseconds) = value, milliseconds.isFinite {
            return Date(timeIntervalSince1970: milliseconds / 1000).formatted(date: .abbreviated, time: .standard)
        }
        return parsedDate(value.string)?.formatted(date: .abbreviated, time: .standard)
    }
}
