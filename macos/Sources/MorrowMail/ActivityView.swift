import AppKit
import SwiftUI

func activityStatusLabel(_ value: String) -> String {
    ["queued": "Queued", "running": "Running", "paused": "Paused", "complete": "Completed", "completed": "Completed", "failed": "Failed", "cancelled": "Cancelled", "interrupted": "Interrupted", "skipped": "Skipped"][value] ?? "Status unknown"
}

func activityDate(_ value: JSON) -> String? {
    if case .number(let milliseconds) = value, milliseconds.isFinite, abs(milliseconds) <= 253_402_300_799_999 {
        return Date(timeIntervalSince1970: milliseconds / 1000).formatted(date: .abbreviated, time: .standard)
    }
    return parsedDate(value.string)?.formatted(date: .abbreviated, time: .standard)
}

func activityCount(_ value: JSON) -> String? {
    guard case .number(let number) = value, number.isFinite, number >= 0, number <= 9_007_199_254_740_991, number.rounded() == number else { return nil }
    return String(format: "%.0f", number)
}

func activitySummaryTime(_ job: JSON) -> String {
    for (label, key) in [("Finished", "finishedAt"), ("Updated", "updatedAt"), ("Started", "startedAt"), ("Created", "createdAt")] {
        if let date = activityDate(job[key]) { return "\(label) \(date)" }
    }
    return "Job time not recorded."
}

struct ActivitySummarySnapshot {
    let job: JSON
    let checkedAt: JSON
    var owner: String { job["accountId"].string }

    init?(task: JSON, checkedAt: JSON, connectedAccounts: [String]) {
        let job = task["summaryJob"]
        guard job.isObject, job["id"].nonempty, job["accountId"].nonempty,
              job["accountId"] == task["accountId"], connectedAccounts.contains(job["accountId"].string),
              job["automaticRetry"] == .bool(false) else { return nil }
        self.job = job.picking(["id", "accountId", "kind", "status", "createdAt", "startedAt", "finishedAt", "updatedAt", "messageCount", "diagnosticCode", "diagnostic", "automaticRetry"])
        self.checkedAt = checkedAt
    }

    var fields: [(String, String)] {
        var result = [("Mailbox", owner), ("Status", activityStatusLabel(job["status"].string)),
                      ("Trigger", ["manual": "Manual", "arrival": "On arrival", "scheduled": "Scheduled"][job["kind"].string] ?? "Unknown")]
        result += [("Created", "createdAt"), ("Started", "startedAt"), ("Finished", "finishedAt"), ("Updated", "updatedAt")].map { ($0.0, activityDate(job[$0.1]) ?? "Not recorded") }
        result.append(("Messages", activityCount(job["messageCount"]) ?? "Not recorded"))
        return result
    }
}

struct ActivitySummaryDetails: View {
    let snapshot: ActivitySummarySnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Summary job details").font(.headline)
            Text("Recorded information for the selected job. New activity does not replace this snapshot.").font(.caption).foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(snapshot.fields.enumerated()), id: \.offset) { _, field in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(field.0).font(.caption).foregroundStyle(.secondary).frame(width: 68, alignment: .leading)
                            Text(field.1).font(.callout).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    Divider()
                    Text(snapshot.job["diagnostic"].nonempty ? snapshot.job["diagnostic"].string : "No further diagnostic information was recorded.").textSelection(.enabled)
                    Text("This job is not retried automatically.").font(.caption).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: 320)
            Text(activityDate(snapshot.checkedAt).map { "Activity snapshot recorded \($0)" } ?? "Activity snapshot time not recorded.").font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct ActivityStatusView: View {
    let value: JSON
    var error: String = ""
    var connectedAccounts: [String] = []
    var scope: String = ""
    var onOpenSettings: (() -> Void)? = nil
    var onCancel: ((String) -> Void)? = nil
    @State private var expanded = false
    @State private var selectedSummary: ActivitySummarySnapshot?

    private var tasks: [JSON] { value["tasks"].array }
    private var ready: Bool { if case .array = value["tasks"] { return true }; return false }
    private var running: [JSON] { tasks.filter { $0["status"].string == "running" } }
    private var queued: Int { tasks.filter { $0["status"].string == "queued" }.count }
    private var attention: Int { tasks.filter { ["paused", "failed", "interrupted", "cancelled"].contains($0["status"].string) }.count }
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
        .onChange(of: expanded) { if !$0 { selectedSummary = nil } }
        .onChange(of: connectedAccounts) { owners in
            if let selectedSummary, !owners.contains(selectedSummary.owner) { self.selectedSummary = nil }
        }
        .onChange(of: scope) { _ in expanded = false; selectedSummary = nil }
        .onDisappear { expanded = false; selectedSummary = nil }
        .onChange(of: summary) { next in
            NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested, userInfo: [.announcement: next, .priority: NSAccessibilityPriorityLevel.low.rawValue])
        }
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let selectedSummary {
                Button("Back to activity") { self.selectedSummary = nil }
                ActivitySummaryDetails(snapshot: selectedSummary)
            } else {
                Text("Mail & AI activity").font(.headline)
                if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                Text("Idle does not mean your entire mailbox is downloaded. Recent-mail sync checks a limited set of messages; older downloaded messages may still have an earlier read/unread state. History is limited to your selected import range.").font(.caption).foregroundStyle(.secondary)
                if let checked = activityDate(value["checkedAt"]) { Text("Activity status updated \(checked) · Local status, not the last mailbox sync.").font(.caption).foregroundStyle(.secondary) }
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
            }
        }.padding(16).frame(width: 380)
    }

    private func taskRow(_ task: JSON) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(task["label"].nonempty ? task["label"].string : ["sync": "Fetching mail", "import": "Importing history", "ai": "AI processing", "learning": "Learning writing style", "index": "Indexing mail"][task["kind"].string] ?? "Background task").font(.callout.bold())
            Text(activityStatusLabel(task["status"].string)).font(.caption).foregroundStyle(["paused", "failed", "interrupted", "cancelled", "skipped"].contains(task["status"].string) ? Color.orange : Color.secondary)
            if task["cancellable"].bool, let onCancel {
                Button("Cancel") { onCancel(task["id"].string) }
                    .font(.caption)
                    .help("Discard this result. Nothing will be sent.")
            }
            if task["detail"].nonempty { Text(task["detail"].string).font(.callout).textSelection(.enabled) }
            if let completed = activityCount(task["completed"]) {
                Text(activityCount(task["total"]).map { "\(completed) / \($0)" } ?? "\(completed) completed · Total not yet known").font(.caption).monospacedDigit()
            } else if let total = activityCount(task["total"]) { Text("Total \(total) · Progress not yet known").font(.caption) }
            if task["error"].nonempty { Text(task["error"].string).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
            if task["summaryJob"].isObject {
                Text(activitySummaryTime(task["summaryJob"])).font(.caption).foregroundStyle(.secondary)
                if let snapshot = ActivitySummarySnapshot(task: task, checkedAt: value["checkedAt"], connectedAccounts: connectedAccounts) {
                    Button("Summary job details") { selectedSummary = snapshot }.font(.caption)
                } else {
                    Text("Summary job details unavailable.").font(.caption).foregroundStyle(.secondary)
                }
            } else if let updated = activityDate(task["updatedAt"]) { Text("Updated \(updated)").font(.caption).foregroundStyle(.secondary) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func owner(_ task: JSON) -> String { task["accountId"].nonempty ? task["accountId"].string : "Workspace" }
}
