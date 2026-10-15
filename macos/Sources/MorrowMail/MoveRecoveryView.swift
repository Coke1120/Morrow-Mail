import SwiftUI

@MainActor struct MoveRecoveryView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let request: JSON
#if MORROW_WINDOW_CHECKS
    var fixtureSnapshot: JSON? = nil
    var fixtureReview: JSON? = nil
#endif
    @State private var snapshot: JSON = .null
    @State private var selectedID = ""
    @State private var reviewed: JSON = .null
    @State private var loading = false
    @State private var error = ""
    @State private var notice = ""
    @State private var ticket = UUID()
    @State private var alive = true
    private var owner: String { request["accountId"].string }
    private var connectionRef: String { moveRecoveryConnectionRef(request["connection"]) }
    private var expected: MoveRecoveryContext {
        MoveRecoveryContext(owner: owner, viewOwner: request["viewOwner"].string, section: request["section"].string,
                            connection: request["connection"], presentationID: request.id)
    }
    private var current: Bool {
        alive && !Task.isCancelled && expected.accepts(MoveRecoveryContext(owner: owner, viewOwner: model.account, section: model.section,
            connection: model.accounts.first { $0.id == owner }?["settings"] ?? .null, presentationID: model.organizing?.id ?? ""))
    }
    private var operation: JSON {
        let saved = snapshot["operations"].array.first { $0.id == selectedID } ?? .null
        return moveRecoveryReviewMatches(reviewed, saved: saved, selectedID: selectedID, owner: owner) ? reviewed : saved
    }
    private var finishAction: String? {
        guard !reviewed.isNull, reviewed == operation else { return nil }
        return moveRecoveryFinishAction(reviewed, owner: owner, connectionRef: snapshot["connectionRef"].string)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Review IMAP moves").font(.title2.bold())
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction).disabled(model.busy)
            }
            Text(owner).textSelection(.enabled).foregroundStyle(.secondary)
            Text("Saved move records. Opening or refreshing this view reads only local records. No move is retried automatically.").font(.callout).foregroundStyle(.secondary)
            if !current { Text("This mailbox or view changed. Close this review and reopen it from the original mailbox.").foregroundStyle(.red) }
            if loading { ProgressView("Loading saved move records…") }
            HSplitView {
                List(selection: Binding(get: { selectedID }, set: { selectedID = $0; reviewed = .null; error = ""; notice = "" })) {
                    ForEach(snapshot["operations"].array) { entry in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(entry["subject"].nonempty ? entry["subject"].string : "(No subject)").lineLimit(2)
                            Text(moveRecoveryStatus(entry)).font(.caption).foregroundStyle(.secondary)
                        }.tag(entry.id).padding(.vertical, 4)
                    }
                }.frame(minWidth: 200, idealWidth: 230)
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if !operation.isNull {
                            Text(operation["subject"].nonempty ? operation["subject"].string : "(No subject)").font(.headline).textSelection(.enabled)
                            Text(moveRecoveryStatus(operation)).bold()
                            if moveRecoveryIsOpen(operation) {
                                Text("This multi-step move is not atomic. An interruption can leave two copies or an unconfirmed source removal.").font(.callout).foregroundStyle(.secondary)
                            }
                            Text("From folder: \(operation["sourceName"].string)\nTo folder: \(operation["targetName"].string)").textSelection(.enabled)
                            Text("Created: \(recordedTime(operation["createdAt"]))\nUpdated: \(recordedTime(operation["updatedAt"]))").font(.caption).foregroundStyle(.secondary)
                            Text(operation["diagnostic"].string).textSelection(.enabled)
                            if operation["connectionRef"].string != snapshot["connectionRef"].string {
                                Text("The saved move belongs to a previous connection. Automatic completion is unavailable. Review the original mailbox at your provider.").foregroundStyle(.secondary)
                            }
                            if moveRecoveryIsOpen(operation) && operation["canPreview"].bool && operation["connectionRef"] == snapshot["connectionRef"] {
                                Button("Check provider — read only") { act("preview") }.accessibilityIdentifier("moveRecovery.preview")
                                Text("Connects to the provider to check this saved source and destination. It does not copy or delete mail.").font(.caption).foregroundStyle(.secondary)
                            }
                            if let finishAction {
                                Button(finishAction == "completeMove" ? "Finish checked move…" : "Apply checked location…") { act("finish") }
                                    .buttonStyle(.borderedProminent).accessibilityIdentifier("moveRecovery.finish")
                                Text("This check expires after five minutes. Finishing rechecks the exact source and destination.").font(.caption).foregroundStyle(.secondary)
                            }
                            if moveRecoveryIsOpen(operation) && operation["canResolve"].bool {
                                Button("I resolved this in my provider…") { act("resolve") }.accessibilityIdentifier("moveRecovery.resolve")
                            }
                            if operation["status"].string == "resolved" { Text("This is your local resolution record, not a new provider confirmation.").font(.caption).foregroundStyle(.secondary) }
                        } else {
                            Text(selectedID.isEmpty ? "No saved IMAP moves to review." : "This saved move is no longer available. Refresh local records or review the original mailbox at your provider.").foregroundStyle(.secondary)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                }.frame(minWidth: 330, idealWidth: 380)
            }.frame(height: 390).disabled(loading || model.busy || !current)
            if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if !notice.isEmpty { Text(notice).foregroundStyle(.secondary).textSelection(.enabled) }
            Button("Refresh local records") { Task { await load() } }.disabled(loading || model.busy || !current)
        }.padding(24).frame(width: 720).interactiveDismissDisabled(model.busy)
        .task {
            selectedID = request["operationId"].string
#if MORROW_WINDOW_CHECKS
            if let fixtureSnapshot {
                guard validMoveRecoverySnapshot(fixtureSnapshot, owner: owner), fixtureSnapshot["connectionRef"].string == connectionRef else { return }
                snapshot = fixtureSnapshot; reviewed = fixtureReview ?? .null
                return
            }
#endif
            await load()
        }
        .onChange(of: model.account) { _ in invalidateIfNeeded() }
        .onChange(of: model.section) { _ in invalidateIfNeeded() }
        .onChange(of: model.accounts) { _ in invalidateIfNeeded() }
        .onDisappear { alive = false; ticket = UUID(); reviewed = .null }
    }
    private func recordedTime(_ value: JSON) -> String { value.nonempty ? dateLabel(value.string) : "Not recorded" }
    private func invalidateIfNeeded() { if !current { alive = false; ticket = UUID(); reviewed = .null; loading = false } }
    private func load() async {
        guard current, !loading else { return }
        let captured = UUID(); ticket = captured; loading = true; reviewed = .null
        defer { if ticket == captured { loading = false } }
        do {
            let next = try await model.request("/mail/moves", mailbox: owner)
            guard current, ticket == captured else { return }
            guard validMoveRecoverySnapshot(next, owner: owner), next["connectionRef"].string == connectionRef else { throw APIError("The saved move records could not be verified for this mailbox connection. Close this review and reopen it after refreshing the account.") }
            snapshot = next; error = ""
            if selectedID.isEmpty { selectedID = next["operations"].array.first?.id ?? "" }
        } catch { if current, ticket == captured { self.error = error.localizedDescription } }
    }
    private func act(_ action: String) {
        let saved = operation, id = operation.id
        guard current, !loading, !model.busy, validMoveRecoveryOperation(saved, owner: owner),
              moveRecoveryIsOpen(saved), !connectionRef.isEmpty, snapshot["connectionRef"].string == connectionRef else { return }
        if action == "preview" {
            guard saved["canPreview"].bool, saved["connectionRef"] == snapshot["connectionRef"] else { return }
        } else if action == "finish" {
            guard let kind = finishAction, model.confirm(kind == "completeMove" ? "Finish this checked move?" : "Apply this checked location?",
                detail: moveRecoveryConfirmation(saved, owner: owner, action: kind)) else { return }
        } else if action == "resolve" {
            guard saved["canResolve"].bool, model.confirm("Mark this move resolved by you?", detail: moveRecoveryConfirmation(saved, owner: owner, action: "resolve")) else { return }
        } else { return }
        guard current, operation == saved else { return }
        let captured = UUID(); ticket = captured
        var body: JSON = .object(["operationRef": saved["operationRef"]])
        if action == "finish" { body["confirmed"] = .bool(true); body["reviewRef"] = saved["reviewRef"] }
        if action == "resolve" { body["confirmed"] = .bool(true); body["resolution"] = .string("reviewedExternally") }
        model.perform {
            do {
                guard current, ticket == captured, operation == saved else { return }
                let next = try await model.request("/mail/moves/" + encodedPath(id) + "/" + action, method: "POST", body: body, mailbox: owner)
                guard current, ticket == captured else { return }
                let updated = next["operation"]
                guard next["accountId"].string == owner, next["connectionRef"].string == connectionRef,
                      updated.id == id, validMoveRecoveryOperation(updated, owner: owner) else { throw APIError("The move result could not be verified. Refresh local records before continuing.") }
                if action == "finish", updated["status"].string != "completed" { throw APIError("Completion was not confirmed. Refresh local records before another check.") }
                if action == "resolve", updated["status"].string != "resolved" { throw APIError("Your resolution was not recorded. Refresh local records before continuing.") }
                snapshot["operations"] = .array(snapshot["operations"].array.map { $0.id == id ? updated : $0 })
                reviewed = action == "preview" ? updated : .null
                error = ""
                notice = action == "preview" ? "Provider check recorded. Review the result before choosing an action."
                    : action == "finish" ? "The checked move and local location are confirmed."
                    : "Your resolution was recorded locally. No provider change was made."
                if action == "finish" { try await model.reload(); await model.refreshMailPage() }
            } catch {
                if current, ticket == captured { reviewed = .null; self.error = error.localizedDescription + " No action was retried. Refresh local records before continuing." }
            }
        }
    }
}
