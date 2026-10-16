import SwiftUI

struct TodayView: View {
    @EnvironmentObject var model: AppModel
    var body: some View { TodayReviewWorkspace(review: model.review) }
}

private struct TodayReplySelection {
    let id = UUID()
    let scope: String
    let owner: String
    let key: String
    let proposal: JSON
}

@MainActor
private struct TodayReviewWorkspace: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var review: ReviewWorkspaceState
    @State private var showSummaryReview = false
    @State private var replySelection: TodayReplySelection?
    private var accounts: [JSON] { model.accounts.filter { review.scope == "all" || $0.id == review.scope } }
    private var events: [JSON] { model.state["today"]["events"].array.filter { review.scope == "all" || $0["accountId"].string == review.scope } }
    private var replies: [JSON] { model.state["today"]["replySuggestions"].array.filter { review.scope == "all" || review.owner($0) == review.scope } }
    private var todos: [JSON] { model.state["today"]["todos"].array.filter { review.scope == "all" || $0["accountId"].string == review.scope } }
    private var completedTodos: [JSON] { model.state["today"]["completedTodos"].array.filter { review.scope == "all" || $0["accountId"].string == review.scope } }
    private var replyCount: Int { let counts=model.state["today"]["replySuggestionCounts"]; return counts.isNull ? replies.count : review.scope == "all" ? counts.object.values.reduce(0) { $0 + Int($1.number) } : Int(counts[review.scope].number) }
    private var source: JSON? { review.originalSelection[review.scope] }
    private var selectedReply: JSON? {
        guard let selection = replySelection, selection.scope == review.scope,
              selection.scope == "all" || selection.scope == selection.owner,
              model.accounts.contains(where: { $0.id == selection.owner }),
              review.proposals[selection.key] == selection.proposal else { return nil }
        return selection.proposal
    }
    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            VStack(spacing: 0) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) { Text("Today").font(.title.weight(.semibold)); Text(context.date.formatted(date: .complete, time: .omitted) + " · " + TimeZone.current.identifier).font(.callout).foregroundStyle(.secondary).lineLimit(1) }
                    Spacer()
                    if let first = replies.first {
                        ReviewActionButton(title: "Review replies (\(replyCount))", enabled: !model.busy && !review.writing, identifier: "today.reviewReplies") { openReply(first) }
                            .fixedSize().layoutPriority(1)
                    }
                    Menu("More") {
                        Button("Summarize now…") { showSummaryReview = true }.disabled(model.busy || model.backgroundBusy || accounts.isEmpty)
                        Button("Reload saved suggestions") { Task { await review.load(review.scope, model: model) } }.disabled(review.writing)
                    }.fixedSize().accessibilityLabel("More Today actions").accessibilityIdentifier("today.moreMenu")
                }.padding(.horizontal, 24).padding(.vertical, 16)
                GeometryReader { area in
                VStack(spacing: 0) {
                    ReviewAccountTabs(review: review)
                    if let error = review.errors[review.scope] {
                        HStack { Text(error).font(.callout).foregroundStyle(.red); Spacer(); Button("Reload suggestions") { Task { await review.load(review.scope, model: model) } }.disabled(review.writing) }.padding(12)
                    }
                    Divider()
                    if let selectedReply, area.size.width < 780 {
                        VStack(spacing: 0) { closeReply; replyEditor(selectedReply) }
                    } else if let selectedReply {
                        HSplitView {
                            content(context.date).frame(minWidth: 350)
                            VStack(spacing: 0) { closeReply; replyEditor(selectedReply) }.frame(minWidth: 360, idealWidth: 420)
                        }
                    } else if let source, area.size.width < 780 {
                        VStack(spacing: 0) { Button("Back to Today") { review.originalSelection[review.scope] = nil }.keyboardShortcut(.cancelAction).padding(12); original(source) }
                    } else if let source {
                        HSplitView { content(context.date).frame(minWidth: 350); original(source).frame(minWidth: 320, idealWidth: 380) }
                    } else { content(context.date) }
                }
                }.frame(maxHeight: .infinity)
            }
        }.sheet(isPresented: $showSummaryReview) { TodaySummaryReview().environmentObject(model) }
        .task(id: replySelection?.id) {
            guard let captured = replySelection else { return }
            // Reopening can overlap the cancelled inspection's deferred cleanup.
            // Wait locally; the original inspection and all its guards stay intact.
            while review.preparing.contains(captured.key) {
                do { try await Task.sleep(nanoseconds: 20_000_000) } catch { return }
            }
            guard !Task.isCancelled, replySelection?.id == captured.id,
                  review.scope == captured.scope, selectedReply == captured.proposal else { return }
            await review.inspect(captured.proposal, model: model)
        }
        .task(id: selectedReply == nil ? nil : review.scope) {
            guard selectedReply != nil else { return }
            let owner = review.scope
            while !Task.isCancelled {
                await review.load(owner, model: model)
                do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
            }
        }
        .onChange(of: review.scope) { _ in replySelection = nil }
        .onChange(of: source) { next in if next != nil { replySelection = nil } }
        .onChange(of: review.proposals[replySelection?.key ?? ""]) { _ in
            if let selection = replySelection, review.proposals[selection.key] == nil { replySelection = nil }
        }
    }
    private var closeReply: some View {
        HStack {
            Button("Back to Today") { replySelection = nil }.keyboardShortcut(.cancelAction).accessibilityIdentifier("today.closeReply")
            Spacer()
            Text("Draft edits stay with their mailbox").font(.caption).foregroundStyle(.secondary)
        }.padding(12)
    }
    private func openReply(_ proposal: JSON) {
        let owner = review.owner(proposal), key = review.key(proposal)
        guard !model.busy, !review.writing, review.scope == "all" || review.scope == owner,
              model.accounts.contains(where: { $0.id == owner }) else { return }
        review.originalSelection[review.scope] = nil
        review.show(proposal)
        guard let working = review.proposals[key], review.owner(working) == owner else { return }
        replySelection = TodayReplySelection(scope: review.scope, owner: owner, key: key, proposal: working)
    }
    private func replyEditor(_ proposal: JSON) -> some View {
        let captured = replySelection
        return ReplySuggestionEditor(review: review, proposal: proposal, onUpdated: { previous, fresh in
            guard let captured, replySelection?.id == captured.id, review.scope == captured.scope,
                  previous == captured.proposal, review.key(previous) == captured.key,
                  review.owner(fresh) == captured.owner,
                  model.accounts.contains(where: { $0.id == captured.owner }) else { return }
            // Only the explicit editor action can retarget this presentation;
            // unrelated shared selection changes never choose a different mail.
            replySelection = TodayReplySelection(scope: captured.scope, owner: captured.owner, key: review.key(fresh), proposal: fresh)
        })
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
                        openReply(proposal)
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(proposal["message"]["subject"].nonempty ? proposal["message"]["subject"].string : "(Subject withheld)").font(.system(size: 14, weight: .semibold))
                                Spacer(minLength: 8)
                                Label("Review", systemImage: "chevron.right").font(.caption)
                            }
                            Text(review.owner(proposal) + " · " + proposal["reason"].string).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }.padding(14).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary.opacity(0.3)).clipShape(RoundedRectangle(cornerRadius: 9))
                    }.buttonStyle(.plain).disabled(model.busy || review.writing).accessibilityLabel("Review suggested reply: " + proposal["message"]["subject"].string)
                        .accessibilityIdentifier("today.reviewReply." + review.key(proposal))
                }
                Text("Suggested tasks").font(.headline)
                Text("From saved summaries and unread Inbox mail on this device. Completing a suggestion does not mark mail read.").font(.caption).foregroundStyle(.secondary)
                if todos.isEmpty { Text("No open suggestions in this scope.").foregroundStyle(.secondary) }
                ForEach(todos) { todo in suggestionRow(todo, reopen: false) }
                if !completedTodos.isEmpty {
                    DisclosureGroup("Completed suggestions (\(completedTodos.count))") {
                        ForEach(completedTodos) { todo in suggestionRow(todo, reopen: true) }
                    }
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
    private func suggestionRow(_ todo: JSON, reopen: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(todo["title"].string).font(.system(size: 14, weight: .semibold)).lineLimit(2)
            Text((todo["categoryName"].nonempty ? todo["categoryName"].string + " · " : "") + todo["accountId"].string).font(.caption).foregroundStyle(.secondary)
            if !reopen { Text(todo["detail"].string).font(.callout).lineLimit(3) }
            HStack {
                Button(reopen ? "Reopen…" : "Complete…") { confirmSuggestion(todo, reopen: reopen) }
                Button("View original message") { Task { await review.showOriginal(.object(["id": todo["messageId"], "accountId": todo["accountId"]]), model: model) } }
            }
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary.opacity(0.3)).clipShape(RoundedRectangle(cornerRadius: 9))
    }
    private func confirmSuggestion(_ todo: JSON, reopen: Bool) {
        let title = reopen ? "Reopen this suggestion?" : "Complete this suggestion?"
        let detail = "Mail stays unchanged. Nothing is sent and Email Brain is not updated."
        guard model.confirm(title, detail: detail) else { return }
        let owner = todo["accountId"].string, id = todo.id, path = reopen ? "/workspace/todos/reopen" : "/workspace/todos/complete"
        model.perform({
            let next = try await model.request(path, method: "POST", body: .object(["id": .string(id), "confirm": .bool(true)]), mailbox: owner)
            guard next["account"]["id"].string == owner else { return }
            if owner == model.account { model.state = next }
            else if !next["today"].isNull { model.state["today"] = next["today"] }
            model.notice = reopen ? "Suggestion reopened." : "Suggestion completed. The message was not marked read."
        }, blocksNavigation: false)
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
