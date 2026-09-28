import SwiftUI

struct TodayView: View {
    @EnvironmentObject var model: AppModel
    private var accounts: [JSON] { model.accounts }
    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    HStack(alignment: .top) {
                        SectionHeading(title: "Today", detail: context.date.formatted(date: .complete, time: .omitted) + " · " + TimeZone.current.identifier)
                        Button { model.perform { try await model.reload() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }.disabled(!model.canNavigate)
                    }
                    Text("All connected accounts").font(.callout).foregroundStyle(.secondary)
                    HStack(spacing: 14) {
                        overview("Unread Inbox", symbol: "envelope.badge", count: accounts.reduce(0) { $0 + Int($1["unread"].number) }, folder: "inbox", unread: true)
                        overview("Inbox", symbol: "tray", count: accounts.reduce(0) { $0 + Int($1["counts"]["inbox"].number) }, folder: "inbox")
                        overview("Drafts", symbol: "doc", count: accounts.reduce(0) { $0 + Int($1["counts"]["drafts"].number) }, folder: "drafts")
                    }
                    Text("Downloaded mail, across all dates. Sync and AI progress appear in Activity below.").font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Text("Today’s summaries").font(.title2.weight(.semibold))
                        Spacer()
                        if !model.combined {
                            Button("Summary History") { model.studioTab = "summaries"; model.section = "studio" }.disabled(!model.canNavigate)
                        }
                    }
                    summaryContent(now: context.date)
                    Spacer(minLength: 0)
                }.padding(28).frame(maxWidth: 1000, alignment: .leading).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
    private func overview(_ title: String, symbol: String, count: Int, folder: String, unread: Bool = false) -> some View {
        Button {
            model.perform {
                try await model.selectAccount("all")
                model.unreadOnly = unread; model.searchResponse = .null; model.section = folder
            }
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                Label(title, systemImage: symbol).font(.callout)
                Text(count.formatted()).font(.system(size: 28, weight: .semibold, design: .rounded)).monospacedDigit()
            }.frame(maxWidth: .infinity, alignment: .leading).padding(18)
                .background(morrowGreen.opacity(0.06)).clipShape(RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain).disabled(!model.canNavigate).accessibilityLabel("\(title), \(count) downloaded messages")
    }
    @ViewBuilder private func summaryContent(now: Date) -> some View {
        let reports = summariesForDay(model.state["today"]["summaries"].array, now: now)
        if !model.policy["enabled"].bool {
            Label("AI is paused. Enable saved permissions to generate future summaries.", systemImage: "pause.circle").foregroundStyle(.secondary)
        }
        if model.policy["triggers"]["scheduledSummary"].bool {
            let schedule = model.policy["summarySchedule"]
            Text(schedule["cadence"].string == "daily" ? "Scheduled daily at \(schedule["time"].string) (\(schedule["timeZone"].string)), while Morrow is open." : "Scheduled every \(Int(schedule["everyHours"].number)) hours, while Morrow is open.").font(.callout).foregroundStyle(.secondary)
        }
        if model.policy["triggers"]["onArrival"].bool {
            Text("New-mail summaries appear after newly synced mail is analyzed. Historical imports do not trigger them.").font(.callout).foregroundStyle(.secondary)
        }
        if reports.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("No summaries today yet").font(.headline)
                Text("Enable scheduled or new-mail summaries in AI Permissions. Opening Today does not run AI or send mail.").foregroundStyle(.secondary)
                Button("AI Permissions") { model.settings("permissions") }.disabled(model.busy)
            }.padding(18).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary.opacity(0.3)).clipShape(RoundedRectangle(cornerRadius: 10))
        }
        ForEach(reports) { report in SummaryReportView(report: report) }
        if model.state["today"]["summaryOverflow"].number > 0 {
            Text("\(Int(model.state["today"]["summaryOverflow"].number)) summary jobs exceeded the queue limit. Review remaining mail in AI Studio.").foregroundStyle(.orange)
        }
        Text("Latest 20 jobs per mailbox, dated in your local time. Each summary uses only its own mailbox. Completed summaries use their completion date.").font(.caption).foregroundStyle(.secondary)
    }
}

struct SummaryReportView: View {
    let report: JSON
    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                if report["accountId"].nonempty { Text(report["accountId"].string).font(.caption.weight(.semibold)).foregroundStyle(morrowGreen) }
                HStack {
                    Text(report["kind"].string == "arrival" ? "New mail" : "Scheduled summary").font(.headline)
                    Spacer()
                    if report["status"].string == "running" { ProgressView().controlSize(.small) }
                    Text(report["status"].string.capitalized).font(.caption).foregroundStyle(.secondary)
                }
                Text(dateLabel(summaryReportTimestamp(report)) + " · \(report["messageIds"].array.count) messages" + (report["source"].string == "demo" ? " · Illustrative demo" : "")).font(.caption).foregroundStyle(.secondary)
                if report["text"].nonempty { Text(report["text"].string).textSelection(.enabled).lineSpacing(5) }
                if report["error"].nonempty { Text(report["error"].string).foregroundStyle(.orange) }
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
