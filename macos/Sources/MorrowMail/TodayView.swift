import SwiftUI

struct TodayView: View {
    @EnvironmentObject var model: AppModel
    var body: some View { TodayReviewWorkspace(review: model.review) }
}

private struct TodayReviewWorkspace: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var review: ReviewWorkspaceState
    @State private var showSummaryReview = false
    private var accounts: [JSON] { model.accounts.filter { review.scope == "all" || $0.id == review.scope } }
    private var events: [JSON] { model.state["today"]["events"].array.filter { review.scope == "all" || $0["accountId"].string == review.scope } }
    private var replies: [JSON] { model.state["today"]["replySuggestions"].array.filter { review.scope == "all" || review.owner($0) == review.scope } }
    private var replyCount: Int { let counts=model.state["today"]["replySuggestionCounts"]; return counts.isNull ? replies.count : review.scope == "all" ? counts.object.values.reduce(0) { $0 + Int($1.number) } : Int(counts[review.scope].number) }
    private var source: JSON? { review.originalSelection[review.scope] }
    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            GeometryReader { area in
                VStack(spacing: 0) {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) { Text("Today").font(.title.weight(.semibold)); Text(context.date.formatted(date: .complete, time: .omitted) + " · " + TimeZone.current.identifier).font(.callout).foregroundStyle(.secondary) }
                        Spacer()
                        Button("Summarize now…") { showSummaryReview = true }.buttonStyle(.borderedProminent).disabled(model.busy || model.backgroundBusy || accounts.isEmpty)
                        Button { model.perform({ try await model.sync() }, blocksNavigation: false) } label: { Label(model.syncing ? "Syncing…" : "Sync all", systemImage: "arrow.clockwise") }.disabled(model.busy || model.backgroundBusy || model.syncing || !model.hasMailbox)
                    }.padding(.horizontal, 24).padding(.vertical, 16)
                    ReviewAccountTabs(review: review)
                    Divider()
                    if let source, area.size.width < 780 {
                        VStack(spacing: 0) { Button("Back to Today") { review.originalSelection[review.scope] = nil }.keyboardShortcut(.cancelAction).padding(12); original(source) }
                    } else if let source {
                        HSplitView { content(context.date).frame(minWidth: 350); original(source).frame(minWidth: 320, idealWidth: 380) }
                    } else { content(context.date) }
                }
            }
        }.sheet(isPresented: $showSummaryReview) { TodaySummaryReview().environmentObject(model) }
    }
    private func content(_ now: Date) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 12) {
                    metric("Decisions", count: events.filter { $0["state"].string == "waiting_on_user" }.count)
                    metric("Replies to review", count: replyCount)
                    metric("Downloaded unread", count: accounts.reduce(0) { $0 + Int($1["unread"].number) })
                }
                Text("Unread covers all dates. Decisions use the latest valid saved summaries; downloaded coverage can be incomplete.").font(.caption).foregroundStyle(.secondary)
                let attention = events.filter { ["waiting_on_user", "uncertain"].contains($0["state"].string) }
                Text("Your decisions").font(.headline)
                if attention.isEmpty { Text(events.isEmpty ? "No saved decisions yet. Review one mailbox with Summarize now, or enable summaries in AI & Privacy." : "No saved items currently waiting on you.").foregroundStyle(.secondary) }
                ForEach(Array(attention.prefix(3))) { event in eventRow(event) }
                if attention.count > 3 { DisclosureGroup("More decisions (\(attention.count - 3))") { ForEach(Array(attention.dropFirst(3))) { event in eventRow(event) } } }
                HStack { Text("Replies to review").font(.headline); Spacer(); Button("View all \(replyCount) →") { model.section = "reply-suggestions" }.disabled(!model.canNavigate) }
                if replies.isEmpty { Text("No current suggestions for this scope. Automatic checks and setup live on Reply suggestions.").foregroundStyle(.secondary) }
                ForEach(Array(replies.prefix(3)), id: \.viewID) { proposal in
                    Button {
                        review.show(proposal); model.section = "reply-suggestions"
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(proposal["message"]["subject"].nonempty ? proposal["message"]["subject"].string : "(Subject withheld)").font(.system(size: 14, weight: .semibold))
                            Text(review.owner(proposal) + " · " + proposal["reason"].string).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }.padding(14).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary.opacity(0.3)).clipShape(RoundedRectangle(cornerRadius: 9))
                    }.buttonStyle(.plain).disabled(model.busy).accessibilityLabel("Review suggested reply: " + proposal["message"]["subject"].string)
                }
                let waiting = events.filter { $0["state"].string == "waiting_on_others" }
                if !waiting.isEmpty { DisclosureGroup("Waiting on others (\(waiting.count))") { ForEach(waiting) { eventRow($0) } } }
                let completed = events.filter { $0["state"].string == "completed" }
                if !completed.isEmpty { DisclosureGroup("Completed or cancelled with evidence (\(completed.count))") { ForEach(completed) { eventRow($0) } } }
                let info = events.filter { $0["state"].string == "informational" }
                if !info.isEmpty { DisclosureGroup("For information (\(info.count))") { ForEach(info) { eventRow($0) } } }
                DisclosureGroup("Full summary details") {
                    let reports = summariesForDay(model.state["today"]["summaries"].array, now: now).filter { review.scope == "all" || $0["accountId"].string == review.scope }
                    ForEach(reports) { SummaryReportView(report: $0) }
                    if reports.isEmpty { Text("No saved summary updated today in this scope.").foregroundStyle(.secondary) }
                    if !model.policy["enabled"].bool { Text("AI is paused in your saved permissions.").foregroundStyle(.secondary) }
                    Text("Latest 20 validated summary jobs per mailbox. The All tab aggregates results; AI context and identity remain separate.").font(.caption).foregroundStyle(.secondary)
                    if model.state["today"]["summaryOverflow"].number > 0 { Text("Some summary jobs exceeded the queue limit. Review the remaining downloaded mail.").foregroundStyle(.orange) }
                }
            }.padding(24).frame(maxWidth: 1000, alignment: .leading).frame(maxWidth: .infinity, alignment: .leading)
                .background(ReviewScrollMemory(key: "today:" + review.scope, review: review))
        }
    }
    private func metric(_ title: String, count: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) { Text(title).font(.caption).foregroundStyle(.secondary); Text(count.formatted()).font(.title3.weight(.semibold)).monospacedDigit() }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(morrowGreen.opacity(0.06)).clipShape(RoundedRectangle(cornerRadius: 8))
    }
    private func eventRow(_ event: JSON) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(event["title"].string).font(.system(size: 14, weight: .semibold)).lineLimit(2)
                    Text(event["action"].nonempty ? event["action"].string : event["summary"].string).font(.callout).lineLimit(2)
                    Text(event["accountId"].string + " · " + stateLabel(event["state"].string) + (event["waitingOn"].nonempty && event["waitingOn"].string != "you" ? " · " + event["waitingOn"].string : "")).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 6)
                Button("View original message") { Task { await review.showOriginal(.object(["id": event["messageId"], "accountId": event["accountId"]]), model: model) } }.disabled(model.busy)
            }
            if event["deadline"].isObject { Text("Deadline, original wording: " + event["deadline"]["quote"].string).font(.caption).foregroundStyle(.secondary) }
            DisclosureGroup(event["grounded"].bool ? "Evidence · \(event["messageIds"].array.count) message(s)" : "Older summary · decision status needs review") {
                ForEach(Array(event["questions"].array.enumerated()), id: \.offset) { _, question in Label(question.string, systemImage: "questionmark.circle").font(.caption) }
                ForEach(Array(event["evidence"].array.enumerated()), id: \.offset) { _, quote in
                    VStack(alignment: .leading, spacing: 4) { Text(quote["quote"].string).font(.callout).textSelection(.enabled); Button("View original message") { Task { await review.showOriginal(.object(["id": quote["messageId"], "accountId": event["accountId"]]), model: model) } } }
                }
                SourceLinksView(sources: event["sources"].array)
            }.font(.caption)
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary.opacity(0.3)).clipShape(RoundedRectangle(cornerRadius: 9))
    }
    private func stateLabel(_ state: String) -> String {
        switch state { case "waiting_on_user": return "Waiting on you"; case "waiting_on_others": return "Waiting on others"; case "completed": return "Completed or cancelled"; case "informational": return "For information"; default: return "Needs review" }
    }
    private func original(_ source: JSON) -> some View {
        let key = "original:" + source["accountId"].string + "\n" + source.id
        return VStack(alignment: .leading, spacing: 12) {
            HStack { Text(source["accountId"].string).font(.caption).foregroundStyle(.secondary); Spacer(); Button("Close original") { review.originalSelection[review.scope] = nil }.keyboardShortcut(.cancelAction) }
            if review.loading.contains(key) { ProgressView("Loading original message…") }
            if let error = review.errors[key] { Text(error).foregroundStyle(.red); Button("Reload original") { Task { await review.showOriginal(source, model: model) } } }
            if let message = review.originals[key] { OriginalReviewMessage(message: message) }
            Spacer(minLength: 0)
            Button("Open in mailbox…") { model.perform { try await model.openSource(source) } }.disabled(!model.canNavigate)
        }.padding(18).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private extension JSON { var isObject: Bool { if case .object = self { return true }; return false } }

struct SummaryReportView: View {
    @EnvironmentObject var model: AppModel
    let report: JSON
    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                if report["accountId"].nonempty { Text(report["accountId"].string).font(.caption.weight(.semibold)).foregroundStyle(morrowGreen) }
                HStack {
                    Label(report["kind"].string == "daily" ? "Daily summary" : report["kind"].string == "arrival" ? "New mail" : report["kind"].string == "manual" ? "On-demand summary" : "Scheduled summary", systemImage: report["kind"].string == "arrival" ? "envelope.badge" : report["kind"].string == "manual" ? "sparkles" : "clock").font(.headline)
                    Spacer()
                    if report["status"].string == "running" { ProgressView().controlSize(.small) }
                    Text(report["status"].string.capitalized).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                        .padding(.horizontal, 9).padding(.vertical, 4).background(.quaternary).clipShape(Capsule())
                }
                Text(dateLabel(summaryReportTimestamp(report)) + " · \(report["messageIds"].array.count) messages" + (report["source"].string == "demo" ? " · Illustrative demo" : "")).font(.caption).foregroundStyle(.secondary)
                if report["text"].nonempty { Text(report["text"].string).textSelection(.enabled).lineSpacing(5) }
                ForEach(Array(report["items"].array.enumerated()), id: \.offset) { _, item in
                    Button("View original message · " + item["priority"].string + " · " + item["summary"].string) { model.perform { try await model.openSource(.object(["id": item["messageId"], "accountId": report["accountId"].nonempty ? report["accountId"] : .string(model.account)])) } }.disabled(!model.canNavigate)
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
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(model.busy || generating)
                Spacer()
                if !error.isEmpty && ready { Button("Review again") { reviewRevision += 1 }.disabled(model.busy) }
                Button {
                    let account = owner, id = preview["previewId"]
                    generating = true; error = ""
                    if !model.perform({
                        defer { generating = false }
                        do {
                            let result = try await model.request("/summaries/generate", method: "POST", body: .object(["previewId": id]), mailbox: account)
                            try await model.reload()
                            guard result["status"].string == "completed" else { throw APIError(result["error"].nonempty ? result["error"].string : "Summary was interrupted. Review before generating again.") }
                            dismiss()
                        } catch { self.error = error.localizedDescription; preview = .null }
                    }, blocksNavigation: false) { generating = false }
                } label: {
                    if generating { ProgressView().controlSize(.small) }
                    Text(generating ? "Generating…" : "Generate summary")
                }.buttonStyle(.borderedProminent).disabled(model.busy || model.backgroundBusy || generating || loading || preview.isNull || !ready)
            }
        }.padding(28).frame(minWidth: 500, idealWidth: 600, maxWidth: 700, maxHeight: 650)
        .interactiveDismissDisabled(model.busy || generating)
        .onAppear { owner = model.accounts.contains { $0.id == model.review.scope } ? model.review.scope : model.accounts.first?.id ?? "" }
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
