import SwiftUI

func downloadCoverageText(_ value: JSON) -> String {
    "\(Int(value["cachedCount"].number)) stored · \(Int(value["count"].number)) indexed · \(Int(value["incompleteCount"].number)) incomplete · \(Int(value["truncatedCount"].number)) shortened bodies"
}

func validDownloadPage(_ value: JSON, owner: String, connectionRef: String) -> Bool {
    guard !connectionRef.isEmpty, value["connectionRef"].string == connectionRef,
          value["accountId"].string == owner, value["pageSize"].number == 30,
          case .array(let rows) = value["items"], rows.count <= 30,
          case .number(let page) = value["page"], page.isFinite, page >= 0, page <= 9_007_199_254_740_991, page.rounded() == page else { return false }
    return rows.allSatisfy { $0["accountId"].string == owner && $0["id"].nonempty && $0["viewId"].nonempty }
}

struct DownloadRequestContext: Equatable {
    let owner: String
    let connectionRef: String
    let ticket: UUID
    func accepts(_ current: DownloadRequestContext) -> Bool {
        !owner.isEmpty && !connectionRef.isEmpty && self == current
    }
}

struct DownloadControlsButton: View {
    @EnvironmentObject var model: AppModel
    var owner: String = ""
    var openSettings: ((String) -> Void)?
    @State private var presented = false
    @State private var presentation: UUID?
    @State private var pendingSettings: String?
    var body: some View {
        Button("Downloads & storage…") {
            guard let id = model.beginDownloadControls() else { return }
            presentation = id; pendingSettings = nil; presented = true
        }
            .disabled(!model.canOpenDownloads)
            .sheet(isPresented: $presented) {
                if let id = presentation {
                    DownloadControlsView(initialOwner: owner, openSettings: { tab in
                        pendingSettings = tab; presented = false
                    })
                    .onDisappear { finishPresentation(id) }
                }
            }
    }
    private func finishPresentation(_ id: UUID) {
        guard presentation == id else { return }
        let tab = pendingSettings
        presentation = nil; pendingSettings = nil; presented = false
        guard model.endDownloadControls(id), let tab else { return }
        if let openSettings { openSettings(tab) }
        else { model.settings(tab) }
    }
}

struct DownloadControlsView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let initialOwner: String
    let openSettings: (String) -> Void
    @State private var owner = ""
    @State private var snapshot: JSON = .null
    @State private var page: JSON = .null
    @State private var error = ""
    @State private var status = ""
    @State private var loading = false
    @State private var ticket = UUID()
    @State private var operation: Task<Void, Never>?
    private var connected: Bool { model.accounts.contains { $0.id == owner } }
    private var connectionRef: String { model.accounts.first { $0.id == owner }?["settings"]["connectionRef"].string ?? "" }
    private var context: DownloadRequestContext { DownloadRequestContext(owner: owner, connectionRef: connectionRef, ticket: ticket) }
    private var ready: Bool { connected && !connectionRef.isEmpty && snapshot["connectionRef"].string == connectionRef && page["connectionRef"].string == connectionRef }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack { Text("Downloads & storage").font(.title2.bold()); Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.cancelAction).disabled(model.busy) }
            Picker("Mailbox", selection: $owner) { ForEach(model.accounts) { account in Text(account.id).tag(account.id) } }.disabled(loading || model.busy)
            Text("Opening this panel reads local records only. Downloads need an explicit action; no AI is called.").font(.caption).foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if !snapshot.isNull {
                        GroupBox("Available offline and in keyword search") {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(downloadCoverageText(snapshot))
                                if snapshot["indexPendingCount"].number > 0 { Text("\(Int(snapshot["indexPendingCount"].number)) stored records are waiting for the keyword index.").foregroundStyle(.orange) }
                                Text("Indexed dates: \(snapshot["oldest"].nonempty ? String(snapshot["oldest"].string.prefix(10)) : "Not recorded") – \(snapshot["newest"].nonempty ? String(snapshot["newest"].string.prefix(10)) : "Not recorded")")
                                Text(snapshot["coverageDescription"].string).font(.caption).foregroundStyle(.secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
                        }
                        GroupBox("Stored data for this mailbox") {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Message records: \(bytes(snapshot["messageBytes"])) · Attachment data: \(bytes(snapshot["attachmentBytes"])) (\(Int(snapshot["attachmentCount"].number)) copies)")
                                Text(snapshot["storageDescription"].string).font(.caption).foregroundStyle(.secondary)
                                Text("Cached mail is retained when you shorten the history range or disconnect. There is no automatic cache deletion or storage quota.").font(.caption).foregroundStyle(.secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
                        }
                        GroupBox("Download controls") {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(historyText(snapshot["import"]))
                                if snapshot["import"]["error"].nonempty { Text(snapshot["import"]["error"].string).foregroundStyle(.orange) }
                                HStack {
                                    if let action = historyControl(snapshot["import"]) { Button(action == "pause" ? "Pause history import" : "Resume from checkpoint") { control(action) }.disabled(!ready || !snapshot["jobRef"].nonempty || loading || model.busy) }
                                    Button("Choose history range…") { openSettings("mail") }.disabled(model.busy)
                                    Button("Automatic sync settings…") { openSettings("general") }.disabled(model.busy)
                                }
                                Text(snapshot["syncIntervalMinutes"].number == 0 ? "Automatic recent-mail sync is set to Manually." : "Automatic recent-mail sync: every \(Int(snapshot["syncIntervalMinutes"].number)) minutes for all accounts.")
                                Text("Pausing history stops subsequent history pages, retaining the checkpoint and cache. It does not stop recent-mail sync or a request already in flight. Manual sync settings do not pause history. Attachments download only on request.").font(.caption).foregroundStyle(.secondary)
                                Text("These are download controls, not a global offline mode. Explicit sync, read-state changes and other online actions can still connect.").font(.caption).foregroundStyle(.secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
                        }
                    }
                    GroupBox("Local and provider recovery") {
                        Text("Archive locally and Move to Local Trash change only this app. Open that local folder and use the message's Undo local move while its location and connection still match. Provider Trash has a separate one-minute Undo; after it expires or the app restarts, use a reviewed provider move or your original mailbox. If a provider change is uncertain, check its current location before another attempt.").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(4)
                    }
                    GroupBox("Content to review") {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Incomplete or shortened provider messages, including cached records whose original is unavailable. A download retries one message; limits can still leave content shortened.").font(.caption).foregroundStyle(.secondary)
                            ForEach(page["items"].array) { message in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(message["subject"].nonempty ? message["subject"].string : "(No subject)").font(.callout.bold()).lineLimit(2)
                                    Text("\(message["folder"].string.capitalized) · \(dateLabel(message["date"].string))").font(.caption)
                                    Text(message["reason"].string).font(.caption).foregroundStyle(.secondary)
                                    Button("Download full content…") { repair(message) }.disabled(!ready || !message["canRepair"].bool || loading || model.busy)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                                Divider()
                            }
                            if !page.isNull && page["items"].array.isEmpty { Text("No incomplete provider records in this cache.").font(.caption) }
                            HStack {
                                Button("Previous") { load(max(0, Int(page["page"].number) - 1)) }.disabled(loading || model.busy || page["page"].number == 0)
                                Text("Page \(Int(page["page"].number) + 1) · \(Int(page["total"].number)) records · 30 per page").font(.caption)
                                Button("Next") { load(Int(page["page"].number) + 1) }.disabled(loading || model.busy || !page["hasNext"].bool)
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
                    }
                }
            }
            HStack { Button("Refresh local status") { load(Int(page["page"].number)) }.disabled(loading || model.busy); if loading || model.busy { ProgressView().controlSize(.small) }; Text(error.isEmpty ? status : error).foregroundStyle(error.isEmpty ? Color.secondary : Color.orange).font(.caption).textSelection(.enabled) }
        }.padding(22).frame(width: 690, height: 650)
        .onAppear { owner = model.accounts.contains(where: { $0.id == initialOwner }) ? initialOwner : model.accounts.first?.id ?? "" }
        .onChange(of: owner) { _ in snapshot = .null; page = .null; load(0) }
        .onChange(of: connectionRef) { _ in snapshot = .null; page = .null; status = ""; load(0) }
        .onChange(of: model.accounts.map(\.id)) { _ in if !connected { operation?.cancel(); ticket = UUID(); dismiss() } }
        .onChange(of: model.account) { _ in operation?.cancel(); ticket = UUID(); dismiss() }
        .onChange(of: model.section) { _ in operation?.cancel(); ticket = UUID(); dismiss() }
        .onDisappear { operation?.cancel(); ticket = UUID() }
        .interactiveDismissDisabled(model.busy)
    }
    private func bytes(_ value: JSON) -> String { ByteCountFormatter.string(fromByteCount: Int64(max(0, min(Double(Int64.max / 2), value.number))), countStyle: .file) }
    private func historyText(_ job: JSON) -> String {
        if job.isNull { return "History import has not started." }
        let state = ["running":"Running", "paused":"Paused", "failed":"Stopped after an error", "complete":"Chosen range completed"][job["status"].string] ?? "Status unknown"
        if job["options"].isNull { return "History: \(state) · Previous connection's range is unavailable." }
        let range = job["options"]["months"].number == 0 ? "All history" : "Last \(Int(job["options"]["months"].number)) months"
        return "History: \(state) · \(range) · \(job["options"]["allMail"].bool ? "All normal folders" : "Selected Inbox/Sent folders")"
    }
    private func historyControl(_ job: JSON) -> String? {
        if job["status"].string == "running" { return "pause" }
        if ["paused", "failed"].contains(job["status"].string) && !["reconnect", "restart"].contains(job["recoveryAction"].string) { return "resume" }
        return nil
    }
    private func current(_ captured: DownloadRequestContext) -> Bool {
        !Task.isCancelled && connected && captured.accepts(context)
    }
    private func refresh(_ requested: Int, context captured: DownloadRequestContext) async throws {
        guard current(captured) else { return }
        let next = try await model.request("/downloads", mailbox: captured.owner)
        guard current(captured) else { return }
        let records = try await model.request("/downloads/incomplete?page=\(requested)", mailbox: captured.owner)
        guard current(captured) else { return }
        guard next["accountId"].string == captured.owner, next["connectionRef"].string == captured.connectionRef,
              validDownloadPage(records, owner: captured.owner, connectionRef: captured.connectionRef) else {
            snapshot = .null; page = .null
            throw APIError("The mailbox connection or download page changed. Close this panel and refresh the mailbox.")
        }
        snapshot = next; page = records
    }
    private func load(_ requested: Int) {
        operation?.cancel(); ticket = UUID()
        guard connected, !connectionRef.isEmpty else { loading = false; return }
        let captured = context; loading = true; error = ""; status = ""
        operation = Task {
            defer { if captured.accepts(context) { loading = false } }
            do { try await refresh(requested, context: captured) }
            catch { if current(captured) { self.error = error.localizedDescription } }
        }
    }
    private func control(_ action: String) {
        guard ready, snapshot["jobRef"].nonempty, !loading, !model.busy else { return }
        let captured = context, requested = Int(page["page"].number)
        let body: JSON = .object(["connectionRef": .string(captured.connectionRef), "jobRef": snapshot["jobRef"]])
        model.perform {
            do {
                guard current(captured) else { return }
                _ = try await model.request("/imports/" + action, method: "POST", body: body, mailbox: captured.owner)
                try await refresh(requested, context: captured)
                if current(captured) { error = ""; status = action == "pause" ? "History checkpoint paused." : "History checkpoint resumed." }
            } catch { if current(captured) { self.error = error.localizedDescription } }
        }
    }
    private func repair(_ message: JSON) {
        guard ready, message["accountId"].string == owner, message["canRepair"].bool, !model.busy, !loading else { return }
        let captured = context, requested = Int(page["page"].number)
        let view = model.account, section = model.section, presentation = model.downloadsPresentation
        let currentRepair: @MainActor () -> Bool = {
            current(captured) && model.account == view && model.section == section &&
                presentation != nil && model.downloadsPresentation == presentation
        }
        guard model.confirm("Download this message's full content?", detail: "Mailbox: \(captured.owner)\n\(message["subject"].string)\nThis explicitly downloads one message, including attachments (up to 50 MiB) and raw message data (up to 80 MiB). No email is moved, deleted or sent; no AI is called."), current(captured) else { return }
        model.perform {
            do {
                guard currentRepair() else { return }
                try await model.repairDownloadedMessage(message, connectionRef: captured.connectionRef, isCurrent: currentRepair)
                guard currentRepair() else { return }
                try await refresh(requested, context: captured)
                if currentRepair() { error = ""; status = "Download saved. Review remaining content limits above." }
            } catch { if currentRepair() { self.error = error.localizedDescription } }
        }
    }
}
