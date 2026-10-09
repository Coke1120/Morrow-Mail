import SwiftUI

struct TodayView: View {
    @EnvironmentObject var model: AppModel
    @State private var showSummaryReview = false
    @State private var reviewing = false
    private var accounts: [JSON] { model.accounts }
    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    HStack(alignment: .top) {
                        SectionHeading(title: "Today", detail: context.date.formatted(date: .complete, time: .omitted) + " · " + TimeZone.current.identifier)
                        Button { model.perform { try await model.sync() } } label: { Label(model.syncing ? "Syncing…" : "Sync All", systemImage: "arrow.clockwise") }
                            .disabled(!model.canNavigate || !model.hasMailbox).help("Sync recent mail from all connected accounts (⌘R)").accessibilityIdentifier("mail.syncAll")
                    }
                    Label("All connected accounts", systemImage: "person.2").font(.callout).foregroundStyle(.secondary)
                    HStack(spacing: 14) {
                        overview("Unread Inbox", symbol: "envelope.badge", count: accounts.reduce(0) { $0 + Int($1["unread"].number) }, folder: "inbox", unread: true)
                        overview("Inbox", symbol: "tray", count: accounts.reduce(0) { $0 + Int($1["counts"]["inbox"].number) }, folder: "inbox")
                        overview("Drafts", symbol: "doc", count: accounts.reduce(0) { $0 + Int($1["counts"]["drafts"].number) }, folder: "drafts")
                    }
                    Text("Downloaded mail, across all dates. Sync and AI progress appear in Activity below.").font(.caption).foregroundStyle(.secondary)
                    HStack(alignment: .center, spacing: 12) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Today’s summaries").font(.title2.weight(.semibold))
                            Text("A clearer view of what needs your attention.").font(.callout).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Summary History") { model.studioTab = "summaries"; model.section = "studio" }.disabled(!model.canNavigate)
                        Button { showSummaryReview = true } label: { Label("Summarize now", systemImage: "sparkles") }
                            .buttonStyle(.borderedProminent).disabled(!model.canNavigate || accounts.isEmpty)
                    }
                    summaryContent(now: context.date)
                    Text("Replies to review").font(.title2.weight(.semibold))
                    Text("Up to five current suggestions per mailbox. Drafts wait for your review and are never sent here.").font(.caption).foregroundStyle(.secondary)
                    ForEach(model.state["today"]["replySuggestions"].array) { proposal in
                        GroupBox {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(proposal["accountId"].string).font(.caption).foregroundStyle(morrowGreen)
                                Text(proposal["message"]["subject"].nonempty ? proposal["message"]["subject"].string : "(Subject withheld)").font(.headline)
                                Text(proposal["reason"].string).foregroundStyle(.secondary)
                                Text(proposal["text"].string).lineLimit(4)
                                SourceLinksView(sources: proposal["sourceMessages"].array)
                                Button("Review suggested reply") {
                                    reviewing = true
                                    Task { @MainActor in
                                        defer { reviewing = false }
                                        do { try await model.reviewReplySuggestion(owner: proposal["accountId"].string, id: proposal["proposalId"].string) }
                                        catch is CancellationError { }
                                        catch { model.error = error.localizedDescription }
                                    }
                                }.disabled(reviewing || !model.canNavigate)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                        }
                    }
                    if model.state["today"]["replySuggestions"].array.isEmpty {
                        Text("No current suggestions. Review reply suggestions for one mailbox to get started.").foregroundStyle(.secondary)
                        Button("Review Reply Suggestions") { model.section = "reply-suggestions" }.disabled(!model.canNavigate)
                    }
                    Spacer(minLength: 0)
                }.padding(28).frame(maxWidth: 1000, alignment: .leading).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .sheet(isPresented: $showSummaryReview) { TodaySummaryReview().environmentObject(model) }
    }
    private func overview(_ title: String, symbol: String, count: Int, folder: String, unread: Bool = false) -> some View {
        Button {
            model.perform {
                try await model.selectAccount("all")
                model.unreadOnly = unread; model.searchResponse = .null; model.section = folder
            }
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                Label(title, systemImage: symbol).font(.callout).foregroundStyle(.secondary)
                Text(count.formatted()).font(.system(size: 28, weight: .semibold, design: .rounded)).monospacedDigit()
            }.frame(maxWidth: .infinity, alignment: .leading).padding(18)
                .background(morrowGreen.opacity(0.06)).clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(morrowGreen.opacity(0.12)))
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
                Label("A fresh start for today", systemImage: "sun.max").font(.headline)
                Text(accounts.isEmpty ? "Connect a mailbox to see your mail and summaries here." : "Choose Summarize now to review downloaded mail from one mailbox. You can also enable scheduled or new-mail summaries in AI & privacy.").foregroundStyle(.secondary)
                Button(accounts.isEmpty ? "Add account" : "AI & Privacy") { model.settings(accounts.isEmpty ? "mail" : "permissions") }.disabled(model.busy)
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
    @EnvironmentObject var model: AppModel
    let report: JSON
    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                if report["accountId"].nonempty { Text(report["accountId"].string).font(.caption.weight(.semibold)).foregroundStyle(morrowGreen) }
                HStack {
                    Label(report["kind"].string == "arrival" ? "New mail" : report["kind"].string == "manual" ? "On-demand summary" : "Scheduled summary", systemImage: report["kind"].string == "arrival" ? "envelope.badge" : report["kind"].string == "manual" ? "sparkles" : "clock").font(.headline)
                    Spacer()
                    if report["status"].string == "running" { ProgressView().controlSize(.small) }
                    Text(report["status"].string.capitalized).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                        .padding(.horizontal, 9).padding(.vertical, 4).background(.quaternary).clipShape(Capsule())
                }
                Text(dateLabel(summaryReportTimestamp(report)) + " · \(report["messageIds"].array.count) messages" + (report["source"].string == "demo" ? " · Illustrative demo" : "")).font(.caption).foregroundStyle(.secondary)
                if report["text"].nonempty { Text(report["text"].string).textSelection(.enabled).lineSpacing(5) }
                ForEach(Array(report["items"].array.enumerated()), id: \.offset) { _, item in
                    Button("Open source · " + item["priority"].string + " · " + item["summary"].string) { model.perform { try await model.openSource(.object(["id": item["messageId"], "accountId": report["accountId"].nonempty ? report["accountId"] : .string(model.account)])) } }.disabled(!model.canNavigate)
                }
                if report["error"].nonempty { Text(report["error"].string).foregroundStyle(.orange) }
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct TodaySummaryReview: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var owner = ""
    @State private var preview: JSON = .null
    @State private var loading = false
    @State private var generating = false
    @State private var error = ""
    @State private var reviewRevision = 0
    private var ready: Bool {
        model.state["settings"]["ai"]["configured"].bool && model.allowed("briefing") &&
            ["subject", "body", "sender"].contains { model.policy["content"][$0].bool }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            SectionHeading(title: "Summarize now", detail: "Review one mailbox, then generate a saved P0–P4 summary.")
            Picker("Mailbox", selection: $owner) {
                ForEach(model.accounts) { account in Text(account["email"].string).tag(account.id) }
            }.disabled(model.busy)
            if !model.state["settings"]["ai"]["configured"].bool {
                Text("Set up an AI connection before generating a summary.").foregroundStyle(.secondary)
                Button("Set Up AI") { dismiss(); model.settings("model") }
            } else if !ready {
                Text("Enable AI, Inbox briefing and subject, body or sender access in your saved AI permissions.").foregroundStyle(.secondary)
                Button("Review AI & Privacy") { dismiss(); model.settings("permissions") }
            } else if loading {
                ProgressView("Reviewing downloaded mail…")
            } else if !preview.isNull {
                Text("\(preview["messages"].array.count) downloaded messages · \(preview["model"]["model"].string)").font(.headline)
                Text(preview["model"]["baseUrl"].string).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(preview["messages"].array) { message in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(message["subject"].nonempty ? message["subject"].string : "(Subject withheld)").font(.headline)
                                Text([message["fromEmail"].string, message["folder"].string.capitalized, dateLabel(message["date"].string)].filter { !$0.isEmpty }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                            }
                            Divider()
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.frame(maxHeight: 260)
                Text("Uses saved folder, Inbox-only and starred-only filters across all dates, up to your context limit. Only permitted fields reach the model. Provider charges may apply.").font(.caption).foregroundStyle(.secondary)
            }
            if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(model.busy)
                Spacer()
                if !error.isEmpty && ready { Button("Review again") { reviewRevision += 1 }.disabled(model.busy) }
                Button {
                    let account = owner, id = preview["previewId"]
                    generating = true; error = ""
                    model.perform {
                        defer { generating = false }
                        do {
                            let result = try await model.request("/summaries/generate", method: "POST", body: .object(["previewId": id]), mailbox: account)
                            try await model.reload()
                            guard result["status"].string == "completed" else { throw APIError(result["error"].nonempty ? result["error"].string : "Summary was interrupted. Review before generating again.") }
                            dismiss()
                        } catch { self.error = error.localizedDescription; preview = .null }
                    }
                } label: {
                    if generating { ProgressView().controlSize(.small) }
                    Text(generating ? "Generating…" : "Generate summary")
                }.buttonStyle(.borderedProminent).disabled(model.busy || loading || preview.isNull || !ready)
            }
        }.padding(28).frame(minWidth: 500, idealWidth: 600, maxWidth: 700, maxHeight: 650)
        .interactiveDismissDisabled(model.busy)
        .onAppear { owner = model.accounts.contains { $0.id == model.account } ? model.account : model.accounts.first?.id ?? "" }
        .task(id: owner + "\n\(reviewRevision)") {
            preview = .null; error = ""
            guard !owner.isEmpty, ready else { return }
            let account = owner
            loading = true
            defer { if !Task.isCancelled, owner == account { loading = false } }
            do {
                let next = try await model.request("/summaries/preview", method: "POST", body: .object([:]), mailbox: account)
                guard !Task.isCancelled, owner == account else { return }
                guard next["accountId"].string == account else { throw APIError("The preview belongs to a different mailbox.") }
                preview = next
            } catch { if !Task.isCancelled, owner == account { self.error = error.localizedDescription } }
        }
    }
}
