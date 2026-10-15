import SwiftUI

struct FolderSyncView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let owner: String
    @State private var selection: FolderSyncSelection
    @State private var working = false
    @State private var active = false
    @State private var stale = false
    @State private var operation: UInt64 = 0
    @State private var scope = ""
    @State private var error = ""
    @State private var notice = ""
    @State private var query = ""

    init(owner: String) { self.owner = owner; _selection = State(initialValue: FolderSyncSelection(owner: owner)) }
    private var key: String { "folder-sync:\(owner)" }
    private var connected: Bool { model.accounts.contains { $0.id == owner } }
    private var scopeKey: String { model.account + "\n" + model.section }
    private var editable: Bool { !working && !stale && connected && selection.supported }
    private var clean: Bool { !working && !selection.dirty && connected }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    header
                    TextField("Filter folder names", text: $query).textFieldStyle(.roundedBorder)
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(selection.rows.filter { query.isEmpty || $0["name"].string.localizedCaseInsensitiveContains(query) }, id: \.self) { row in
                            folder(row)
                        }
                        if selection.loaded && selection.rows.isEmpty { Text("No eligible custom folders are in the saved folder list. Use Refresh server folder list to check the server.").foregroundStyle(.secondary) }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    if selection.needsBaseline {
                        Toggle("Start a new recent-mail baseline for the affected selected folders. Cached mail is retained; older mail still requires history import.", isOn: $selection.reviewedBaseline)
                            .disabled(!editable).accessibilityIdentifier("folderSync.reviewBaseline")
                    }
                    if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled).accessibilityIdentifier("folderSync.error") }
                    if !notice.isEmpty { Text(notice).foregroundStyle(.secondary).textSelection(.enabled) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(height: 540)
            HStack {
                Text("\(selection.selected.count) / 20 selected\(selection.dirty ? " · Unsaved changes" : "")").font(.caption)
                Button("Deselect all") { selection.deselectAll(); markDirty() }.disabled(!editable || selection.selected.isEmpty)
                Spacer()
                Button("Discard changes") { selection.discard(); markDirty(); notice = "Unsaved selection discarded. Reload saved status to check for changes." }.disabled(working || !selection.dirty)
            }
            HStack {
                Button("Close") { if !selection.dirty || model.confirmDiscard("Discard this unsaved folder selection?") { dismiss() } }.keyboardShortcut(.cancelAction).disabled(working)
                Spacer()
                Button("Sync this mailbox now") { run(.sync) }.disabled(!editable || !selection.canSync || model.syncing)
                Button("Save selection") { run(.save) }.buttonStyle(.borderedProminent).disabled(!editable || !selection.canSave).accessibilityIdentifier("folderSync.save")
            }
        }.padding(22).frame(width: 680)
            .interactiveDismissDisabled(working || selection.dirty)
            .onAppear {
                active = true; scope = scopeKey
                _ = selection.adopt(model.state["serverFolderSync"][owner])
                run(.reload)
            }
            .onDisappear { active = false; operation &+= 1; model.dirty(key, false) }
            .onChange(of: scopeKey) { _ in active = false; operation &+= 1; dismiss() }
            .onChange(of: connected) { value in if !value { stale = true; error = "This mailbox was disconnected. Close this window and reconnect it in Settings → Mail accounts." } }
            .onChange(of: model.state["serverFolderSync"][owner]["connectionVersion"]) { value in
                if selection.loaded && value.nonempty && value != selection.snapshot["connectionVersion"] { stale = true; error = "This mailbox connection changed. Discard unsaved changes, then reload and review the folder selection." }
            }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Folders to sync").font(.title2.bold())
            Text(owner).font(.headline).textSelection(.enabled)
            Text("Choose custom IMAP folders to download during mailbox sync. Saving changes only the local selection; a later mailbox sync can download selected folders.").fixedSize(horizontal: false, vertical: true)
            Text("Recent page and new mail only; older mail requires history import. Flags refresh in bounded batches.").font(.callout).foregroundStyle(.secondary)
            if selection.loaded {
                Text(selection.snapshot["automaticSyncEnabled"].bool
                     ? "Periodic sync: every \(Int(selection.snapshot["intervalMinutes"].number)) minutes while Morrow is running."
                     : "Periodic sync is off. Previously requested reads may still continue after provider waits or update restarts. Use Sync this mailbox now for an explicit sync.").font(.callout)
                Text("Up to 20 selected folders; at most 4 folder pages per sync round.").font(.caption).foregroundStyle(.secondary)
                if !selection.snapshot["catalogFresh"].bool { Text("The saved folder list needs refreshing. Refresh the server folder list to select folders, or deselect all to stop syncing them.").foregroundStyle(.orange) }
                if !selection.supported { Text("Selected-folder sync is available for connected IMAP mailboxes.") }
            }
            HStack {
                Button("Reload saved status") { run(.reload) }.disabled(!clean)
                Button("Refresh server folder list") { run(.catalog) }.disabled(!clean)
                if working { ProgressView().controlSize(.small) }
            }
            Text("Reload reads local status. Refresh contacts this mailbox’s server for folder names; it does not download messages.").font(.caption).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func folder(_ row: JSON) -> some View {
        let id = row["folderId"].string
        VStack(alignment: .leading, spacing: 4) {
            Toggle(isOn: Binding(get: { selection.selected.contains(id) }, set: { selection.select(id, $0); markDirty() })) {
                Text(row["name"].string).font(.headline).textSelection(.enabled)
            }.disabled(!editable || !selection.selected.contains(id) && (!row["available"].bool || selection.selected.count >= 20))
            Text(folderSyncStatus(row) + (row["available"].bool ? "" : " · Folder unavailable in the current saved list")).font(.callout)
            if row["selected"].bool {
                Text(folderSyncTimes(row)).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                if row["coverageWarning"].nonempty { Text(row["coverageWarning"].string).font(.callout).foregroundStyle(.orange) }
                if row["error"].nonempty { Text(row["error"].string).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
                if row["nextRetryAt"].nonempty { Text("Next eligible retry: \(dateLabel(row["nextRetryAt"].string))").font(.caption) }
                if row["recoveryAction"].string == "reconnect" { Text("Reconnect this mailbox in Settings → Mail accounts, then reload its folder selection.").font(.caption) }
                if row["recoveryAction"].string == "retry" {
                    Button("Allow retry on the next sync") { run(.retry, row: row) }.disabled(!editable || selection.retryPayload(row) == nil)
                }
            }
            Divider()
        }
    }

    private enum Action { case reload, catalog, save, retry, sync }
    private func markDirty() { model.dirty(key, selection.dirty); notice = "" }
    private func run(_ action: Action, row: JSON = .null) {
        guard active, !working, connected, scope == scopeKey else { return }
        if action != .save && selection.dirty { return }
        if action == .save && (!editable || !selection.canSave) { return }
        if action == .sync && (!editable || !selection.canSync || model.syncing) { return }
        let body: JSON
        switch action {
        case .save: body = selection.payload
        case .sync: body = selection.syncPayload
        case .retry: guard editable, let retry = selection.retryPayload(row) else { return }; body = retry
        default: body = .null
        }
        let observed = FolderSyncVersions(model.state["serverFolderSync"][owner])
        if action == .save || action == .retry || action == .sync {
            if observed.connection.nonempty && observed != FolderSyncVersions(selection.snapshot) {
                stale = true; error = "This mailbox connection or saved selection changed. Discard unsaved changes, then reload and review the folder selection."
                return
            }
        }
        working = true; operation &+= 1
        let ticket = operation, connection = model.accounts.first { $0.id == owner }?["settings"] ?? .null
        error = ""; notice = ""
        let accepted = model.perform {
            defer { if active && operation == ticket { working = false } }
            @MainActor func current() -> Bool { folderSyncContextCurrent(owner: owner, scope: scope, connection: connection, ticket: ticket, active: active, currentScope: scopeKey, accounts: model.accounts, operation: operation) }
            // perform queues a MainActor task: the sheet may be gone before it starts.
            guard current() else { return }
            @MainActor func verifyVersions(response: JSON? = nil) throws {
                guard folderSyncVersionsCurrent(observed, FolderSyncVersions(model.state["serverFolderSync"][owner]), response: response.map(FolderSyncVersions.init)) else {
                    stale = true
                    throw APIError("This mailbox connection or saved selection changed. Discard unsaved changes, then reload and review the folder selection.")
                }
            }
            do {
                try verifyVersions()
                let next: JSON
                switch action {
                case .catalog:
                    _ = try await model.request("/mail/folders/manage", mailbox: owner)
                    guard current() else { return }
                    try verifyVersions()
                    next = try await model.request("/mail/folders/sync", mailbox: owner)
                case .save: next = try await model.request("/mail/folders/sync", method: "PUT", body: body, mailbox: owner)
                case .retry: next = try await model.request("/mail/folders/sync/retry", method: "POST", body: body, mailbox: owner)
                case .sync:
                    _ = try await model.request("/sync", method: "POST", body: body, mailbox: owner)
                    guard current() else { return }
                    try verifyVersions()
                    next = try await model.request("/mail/folders/sync", mailbox: owner)
                case .reload: next = try await model.request("/mail/folders/sync", mailbox: owner)
                }
                guard current() else { return }
                try verifyVersions(response: next)
                let adopted = action == .save ? selection.saved(next) : selection.adopt(next)
                guard adopted else { throw APIError("The saved folder selection could not be verified. Reload and review it before continuing.") }
                stale = false; model.state["serverFolderSync"][owner] = next; markDirty()
                if action == .save { notice = "Selection saved locally. A later mailbox sync can download these folders; use Sync this mailbox now to request a sync." }
                if action == .retry { notice = "Retry is allowed on a later mailbox sync. No messages were downloaded by this action." }
                if action == .sync { notice = "Mailbox sync finished. The folder status below reports each bounded check; errors and older history may remain." }
            } catch {
                guard current() else { return }
                self.error = error.localizedDescription
                if action == .save || action == .retry || action == .sync { stale = true; self.error += " Discard unsaved changes if needed, then reload saved status before another action." }
            }
        }
        if !accepted { working = false; error = "Another operation is in progress. Try again when it finishes." }
    }
}
