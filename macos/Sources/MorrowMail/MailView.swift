import SwiftUI
import AppKit

struct MailWorkspace: View {
    @AppStorage("collapsedMailAccounts") private var collapsedAccounts = "[]"
    @AppStorage("mailReaderLayout") private var readerLayout = "right"
    @AppStorage("mailSidebarVisible") private var sidebarVisible = true
    @State private var previousSidebarVisible = true
    @State private var expandedReader = false
    @State private var rightListWidth: CGFloat?
    @State private var outOfOfficeDirty = false
    @State private var assistantDraft: (draft: Draft, generation: Int)?
    @State private var hoveredMessage: String?
    @State private var expandedServerAccounts: Set<String> = []
    @State private var folderFilter = ""
    @EnvironmentObject var model: AppModel
    private var layout: String { expandedReader ? "focus" : ["right", "bottom", "focus"].contains(readerLayout) ? readerLayout : "right" }
    var filtered: [JSON] {
        if !model.searchResponse.isNull { return model.searchResponse["messages"].array }
        return model.listedMessages
    }
    var body: some View {
        Group {
            if model.starting {
                VStack(spacing: 20) { Image(systemName: "sunrise.fill").font(.system(size: 48)).foregroundStyle(morrowGreen); Text("Morrow Mail").font(.largeTitle); ProgressView("Opening your workspace…") }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.state.isNull {
                VStack { EmptyPane(title: "Morrow couldn’t start", detail: model.error, symbol: "exclamationmark.triangle"); Button("Try Again") { Task { await model.start() } }.padding(.bottom, 40) }
            } else {
              VStack(spacing: 0) {
                HSplitView {
                    if sidebarVisible { sidebar.frame(minWidth: 200, idealWidth: 230).background(InitialSplitPosition(230)) }
                    VStack(spacing: 0) {
                        if !sidebarVisible {
                            HStack(spacing: 14) {
                                Button { sidebarVisible = true } label: { Label("Show Sidebar", systemImage: "sidebar.left") }.labelStyle(.iconOnly).help("Show Sidebar")
                                Spacer()
                                composeButton
                            }.buttonStyle(.borderless).padding(.horizontal, 14).padding(.vertical, 8).background(.bar)
                        }
                        if model.section != "calendar" && !model.hasMailbox {
                            VStack(spacing: 16) {
                                EmptyPane(title: model.accounts.isEmpty ? "Add your first account" : "Choose a mailbox", detail: "Connect Gmail, Outlook, or an IMAP account to start reading your mail.", symbol: "envelope.badge")
                                Button("Add account") { model.settings("mail") }.buttonStyle(.borderedProminent)
                            }.padding(30)
                        } else if model.section == "today" {
                            TodayView()
                        } else if model.section == "studio" {
                            GeometryReader { area in
                                StudioView().id(model.account)
                                    .frame(width: area.size.width, height: area.size.height)
                            }
                        }
                        else if model.section == "calendar" { NativeCalendarView() }
                        else if model.section == "reply-suggestions" { ReplySuggestionsView() }
                        else if model.section == "out-of-office" {
                            ScrollView { OutOfOfficeView(dirty: $outOfOfficeDirty).padding(28).frame(maxWidth: .infinity, alignment: .leading) }
                        }
                        else if model.section == "scheduled" { ScheduledMailView() }
                        else {
                            VStack(spacing: 0) {
                              NativeMailSearch().id(model.account + ":" + model.section)
                              readingPanes
                            }
                        }
                    }
                }
                    ActivityStatusView(value: model.activity, error: model.activityError, onOpenSettings: { model.settings("mail") }).padding(.horizontal, 12).padding(.vertical, 5).background(.bar)
                    if !model.trashUndos.isEmpty {
                        HStack {
                            Text("Moved to provider Trash · Undo within one minute").font(.callout)
                            Spacer()
                            Button("Undo (⌘Z)") { model.undoTrash() }.disabled(!model.canUndoTrash)
                        }.padding(12).background(.bar)
                    }
                    if !model.error.isEmpty { statusBar(model.error, error: true) }
                    else if !model.notice.isEmpty { statusBar(model.notice, error: false) }
                    else if model.busy || model.preparingDraft { HStack { ProgressView().controlSize(.small); Text(model.preparingDraft ? "Preparing draft…" : "Working…").foregroundStyle(.secondary); Spacer() }.padding(9).background(.bar) }
              }
            }
        }
        .task(id: model.mailQueryKey) { if model.hasMailbox { await model.refreshMailPage() } }
        .task(id: (model.selectedMessage ?? "") + model.state["revision"].string) { await model.loadMessage() }
        .onChange(of: model.section) { section in if section != "studio" { model.selectedMessage = nil; model.messageDetail = .null }; model.mailPage = .null }
        .onChange(of: readerLayout) { _ in leaveExpandedReader() }
        .onChange(of: outOfOfficeDirty) { model.dirty("out-of-office", $0) }
        .onChange(of: model.selectedMessage) { selection in if selection == nil { leaveExpandedReader() } }
        .sheet(item: $model.compose) { draft in ComposeView(initial: draft).environmentObject(model) }
        .sheet(item: $model.organizing) { request in OrganizeMailView(message: request["message"], preferredKind: request["preferredKind"].string, preferredDestination: request["destinationId"].string).environmentObject(model) }
        .sheet(item: $model.managingFolders) { request in FolderManagementView(owner: request.id, initialFolder: request["folderId"].string).environmentObject(model) }
        .sheet(item: $model.readerAssistant, onDismiss: {
            if let pending = assistantDraft {
                assistantDraft = nil
                if model.draftGeneration == pending.generation { model.newDraft(pending.draft) }
            }
        }) { request in
            ReaderAssistanceView(request: request) { draft in assistantDraft = (draft, model.draftGeneration) }.environmentObject(model)
        }
        .sheet(isPresented: $model.showSettings, onDismiss: model.finishUpdateRestart) { NativeSettingsView().environmentObject(model) }
    }
    private var readingPanes: some View {
        // Keep the reader in the same container when layouts change, including its AI task state.
        HSplitView {
            if layout == "right" || (layout == "focus" && model.current == nil) {
                messageList.frame(minWidth: 260, idealWidth: 320)
                    .background {
                        if layout == "right" {
                            InitialSplitPosition(rightListWidth) { width in
                                if layout == "right" { rightListWidth = width }
                            }
                        }
                    }
            }
            VSplitView {
                if layout == "bottom" { messageList.frame(minHeight: 160, idealHeight: 240).background(InitialSplitPosition(240)) }
                readerPane.frame(minHeight: 200)
            }
            .frame(minWidth: layout == "focus" && model.current == nil ? 0 : 320)
            .frame(width: layout == "focus" && model.current == nil ? 0 : nil)
            .clipped()
            .accessibilityHidden(layout == "focus" && model.current == nil)
        }
    }
    @ViewBuilder private var readerPane: some View {
        if let message = model.current {
            if model.messageDetail.viewID == message.viewID { MessageReader(message: message, expanded: expandedReader, focused: layout == "focus", onExpand: toggleExpandedReader, onBack: { leaveExpandedReader(); model.selectedMessage = nil; model.messageDetail = .null }) }
            else {
                VStack {
                    if model.error.isEmpty { ProgressView("Loading message…") }
                    else { Button("Retry loading message") { Task { await model.loadMessage() } } }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else { EmptyPane(title: "A little room to think", detail: "Choose a message to read, or compose something new.", symbol: "envelope.open") }
    }
    private func toggleExpandedReader() {
        if expandedReader { leaveExpandedReader() }
        else { previousSidebarVisible = sidebarVisible; sidebarVisible = false; expandedReader = true }
    }
    private func leaveExpandedReader() {
        guard expandedReader else { return }
        expandedReader = false; sidebarVisible = previousSidebarVisible
    }
    var sidebar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "sunrise.fill").font(.title2).foregroundStyle(morrowGreen)
                VStack(alignment: .leading) { Text("Morrow").font(.title2.weight(.bold)); Text("A calmer kind of inbox").font(.caption).foregroundStyle(.secondary) }
                Spacer(minLength: 0)
                Button { sidebarVisible = false } label: { Label("Hide Sidebar", systemImage: "sidebar.left") }.labelStyle(.iconOnly).buttonStyle(.borderless).help("Hide Sidebar")
            }.padding(.horizontal, 14).padding(.vertical, 12)
            composeButton.buttonStyle(.borderedProminent).frame(maxWidth: .infinity).padding(.horizontal, 14).padding(.bottom, 10)
            TextField("Filter labels / folders", text: $folderFilter).textFieldStyle(.roundedBorder)
                .accessibilityLabel("Filter sidebar labels and folders").padding(.horizontal, 14).padding(.bottom, 10)
            List(selection: Binding(get: { model.isMailSection ? model.account + "\n" + model.section : model.section == "scheduled" && !model.scheduledAccount.isEmpty ? model.scheduledAccount + "\n" + model.section : model.section }, set: { value in
                guard model.canNavigate else { return }
                let parts = value.components(separatedBy: "\n")
                if parts.count == 2 {
                    if parts[1] == "scheduled" { model.scheduledAccount = parts[0] }
                    if parts[0] == model.account { model.section = parts[1] }
                    else { model.perform { try await model.selectAccount(parts[0], folder: parts[1]) } }
                } else { model.section = value }
            })) {
                Section("Workspace") {
                    Label("Today", systemImage: "sun.max").tag("today").accessibilityIdentifier("workspace.today")
                    Label("Reply Suggestions", systemImage: "text.bubble").tag("reply-suggestions").accessibilityIdentifier("workspace.reply-suggestions")
                    Label("Out of Office", systemImage: "moon").tag("out-of-office").accessibilityIdentifier("workspace.out-of-office")
                    Label("AI Studio", systemImage: "sparkles").tag("studio")
                    Label("Calendar", systemImage: "calendar").tag("calendar")
                    Label("Outbox", systemImage: "clock.arrow.circlepath").tag("scheduled").accessibilityIdentifier("workspace.scheduled")
                }
                if !model.accounts.isEmpty {
                    accountGroup("all", title: "All accounts", subtitle: "Combined mail", symbol: "tray.2")
                    ForEach(model.accounts) { account in
                        accountGroup(account.id, title: account["email"].string, subtitle: account["provider"].string == "imap" ? "IMAP" : providerLabel(account["provider"].string), symbol: "envelope")
                    }
                }
            }.listStyle(.sidebar)
            Button { model.settings("mail") } label: { Label("Add account", systemImage: "plus") }.buttonStyle(.plain).padding(12).disabled(model.busy)
            Divider()
            Button { model.settings(model.updateAvailable ? "about" : "general") } label: {
                HStack {
                    Label("Settings & connections", systemImage: "gearshape")
                    if model.updateAvailable {
                        Text("!").font(.caption.bold()).foregroundStyle(.white)
                            .frame(width: 18, height: 18).background(.red, in: Circle()).accessibilityHidden(true)
                    }
                }
            }
                .accessibilityLabel(model.updateAvailable ? "Settings & connections, update available" : "Settings & connections")
                .help(model.updateAvailable ? "A new version is available. Open App updates." : "Settings & connections")
                .buttonStyle(.plain).disabled(model.busy).frame(maxWidth: .infinity, alignment: .leading).padding(18).fixedSize(horizontal: false, vertical: true)
        }
    }
    private var composeButton: some View {
        Button { model.newDraft() } label: { Label("Compose", systemImage: "square.and.pencil").frame(maxWidth: sidebarVisible ? .infinity : nil) }
            .disabled(model.busy || !model.hasMailbox).help("New message (⌘N)")
    }
    func accountGroup(_ account: String, title: String, subtitle: String, symbol: String) -> some View {
        let collapsed = Set((try? JSONDecoder().decode([String].self, from: Data(collapsedAccounts.utf8))) ?? [])
        return DisclosureGroup(isExpanded: Binding(get: { !folderFilter.isEmpty || !collapsed.contains(account) }, set: { expanded in
            guard folderFilter.isEmpty else { return }
            var next = collapsed
            if expanded { next.remove(account) } else { next.insert(account) }
            if let data = try? JSONEncoder().encode(next.sorted()), let value = String(data: data, encoding: .utf8) { collapsedAccounts = value }
        })) { folderRows(account) } label: {
            HStack(spacing: 8) {
                Image(systemName: symbol).foregroundStyle(morrowGreen)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.system(size: 12, weight: .semibold)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    Text(subtitle).font(.caption2).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                let count = folderCount(account, "inbox")
                if count > 0 { Text("\(count)").font(.caption2.monospacedDigit()).foregroundStyle(.secondary) }
            }.padding(.vertical, 5).help(title)
        }.accessibilityIdentifier("accountGroup.\(account)")
    }
    @ViewBuilder func folderRows(_ account: String) -> some View {
        ForEach(mailFolders.filter { folderFilter.isEmpty || $0.localizedCaseInsensitiveContains(folderFilter) }, id: \.self) { folder in
            HStack {
                Label(folder.capitalized, systemImage: ["inbox": "tray", "starred": "star", "pending": "clock", "sent": "paperplane", "drafts": "doc", "archive": "archivebox", "spam": "exclamationmark.shield", "trash": "trash"][folder] ?? "folder")
                Spacer()
                let count = folderCount(account, folder)
                if count > 0 && ["inbox", "pending", "drafts"].contains(folder) { Text("\(count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
            }.tag(account + "\n" + folder).accessibilityIdentifier("mailbox.\(account).\(folder)")
        }
        if account != "all" {
            Label("Outbox", systemImage: "clock.arrow.circlepath").tag(account + "\nscheduled").accessibilityIdentifier("mailbox.\(account).outbox")
            DisclosureGroup(isExpanded: Binding(get: { expandedServerAccounts.contains(account) || !folderFilter.isEmpty && model.serverFolders[account] != nil }, set: { expanded in
                if expanded {
                    expandedServerAccounts.insert(account)
                } else { expandedServerAccounts.remove(account) }
            })) {
                ForEach((model.serverFolders[account] ?? []).filter { folderFilter.isEmpty || $0["name"].string.localizedCaseInsensitiveContains(folderFilter) }) { folder in
                    Label(folder["name"].string, systemImage: folder["kind"].string == "label" ? "tag" : "folder")
                        .tag(account + "\nprovider:" + folder.id).help(folder["name"].string)
                        .contextMenu {
                            Button("Manage label / folder…") { model.managingFolders = .object(["id": .string(account), "folderId": .string(folder.id)]) }.disabled(!model.canNavigate)
                            Button("Move selected message here…") { model.beginOrganize(model.current, destinationId: folder.id) }
                                .disabled(!model.canNavigate || model.current?["accountId"].string != account || !(model.current.map(model.canOrganize) ?? false))
                        }
                }
                if !model.state["serverFolders"][account]["errorCode"].isNull {
                    Text("Folder list could not refresh. Saved names are retained.").font(.caption).foregroundStyle(.secondary)
                } else if model.state["serverFolders"][account]["updatedAt"].isNull {
                    Text("Loading labels / folders…").font(.caption).foregroundStyle(.secondary)
                }
                Button("Refresh labels / folders") { model.perform { try await model.loadServerFolders(account) } }.disabled(model.busy)
            } label: { Text(model.accounts.first { $0.id == account }?["provider"].string == "google" ? "Gmail labels" : "Server folders") }
            Button("Manage labels / folders…") { model.managingFolders = .object(["id": .string(account)]) }.disabled(!model.canNavigate)
        }
    }
    func folderCount(_ account: String, _ folder: String) -> Int {
        return model.accounts.filter { account == "all" || $0.id == account }.reduce(0) { $0 + Int(folder == "inbox" ? $1["unread"].number : $1["counts"][folder].number) }
    }
    var messageList: some View {
        VStack(spacing: 0) {
            HStack { VStack(alignment: .leading, spacing: 3) { Text(model.mailSectionTitle).font(.headline); Text(model.combined ? "All accounts" : model.account).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle) }; Spacer(); Toggle(isOn: $model.unreadOnly) { Image(systemName: "line.3.horizontal.decrease.circle") }.toggleStyle(.button).controlSize(.small).help("Show unread only").accessibilityLabel("Show unread only").disabled(!model.searchResponse.isNull) }.padding(.horizontal, 14).padding(.vertical, 10)
            if model.section.hasPrefix("provider:") { Text("Labels and folders refresh automatically. Messages shown here are downloaded mail; import history to add older messages.").font(.caption).foregroundStyle(.secondary).padding(.horizontal, 14).padding(.bottom, 8) }
            HStack(spacing: 12) {
                Menu {
                    Picker("Reading layout", selection: $readerLayout) {
                        Label("Reader on Right", systemImage: "rectangle.lefthalf.inset.filled").tag("right")
                        Label("Reader Below", systemImage: "rectangle.bottomhalf.inset.filled").tag("bottom")
                        Label("Focus Reading", systemImage: "rectangle").tag("focus")
                    }
                    Divider()
                    ForEach(["compact", "comfortable", "spacious"], id: \.self) { density in
                        Button { model.preference("density", density) } label: { Label(density.capitalized, systemImage: model.preferences["density"].string == density ? "checkmark" : "text.alignleft") }
                    }
                } label: { Label("View", systemImage: "list.bullet") }.fixedSize().accessibilityIdentifier("mail.viewMenu")
                Menu {
                    ForEach(mailSortOptions, id: \.0) { option in
                        Button { model.preference("sort", option.0) } label: { Label(option.1, systemImage: model.preferences["sort"].string == option.0 ? "checkmark" : "arrow.up.arrow.down") }
                    }
                } label: { Label("Sort", systemImage: "arrow.up.arrow.down") }.fixedSize().accessibilityIdentifier("mail.sortMenu").disabled(!model.searchResponse.isNull)
                Spacer(minLength: 0)
                Button { model.perform { try await model.sync() } } label: { Label("Sync Mail", systemImage: "arrow.clockwise") }.labelStyle(.iconOnly).buttonStyle(.borderless).disabled(!model.canNavigate || !model.hasMailbox).help("Sync Mail (⌘R)")
            }.menuStyle(.borderlessButton).controlSize(.small).disabled(model.busy).padding(.horizontal, 14).padding(.bottom, 8)
            Divider()
            if filtered.isEmpty {
                VStack {
                    EmptyPane(title: model.searchResponse.isNull && !model.unreadOnly ? "All clear" : "No matching messages", detail: model.searchResponse.isNull ? "There are no messages in this view." : "Adjust the search filters or import more mail.", symbol: "tray")
                    if model.unreadOnly { Button("Clear Unread Filter") { model.unreadOnly = false }.padding(.bottom, 24) }
                }
            }
            else {
                List(filtered, id: \.viewID, selection: $model.selectedMessage) { message in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(["sent", "drafts"].contains(message["folder"].string) ? "To: " + message["to"].string : message["fromName"].string).lineLimit(1)
                            Spacer(minLength: 2)
                            if message["starred"].bool { Image(systemName: "star.fill").foregroundStyle(.orange).font(.caption) }
                            if message["pending"].bool { Image(systemName: "clock.fill").foregroundStyle(morrowGreen).font(.caption).accessibilityLabel("Pending") }
                            Circle().fill(message["read"].bool ? .clear : morrowGreen).frame(width: 6, height: 6).accessibilityLabel(message["read"].bool ? "Read" : "Unread")
                            if hoveredMessage == message.viewID || model.selectedMessage == message.viewID { rowActions(message) }
                        }
                        searchHighlighted(message["searchSubject"], fallback: message["subject"].nonempty ? message["subject"].string : "(No subject)").font(.system(size: 13)).fontWeight(message["read"].bool ? .regular : .bold).lineLimit(1)
                        if model.preferences["density"].string != "compact" { searchHighlighted(message["searchSnippet"], fallback: message["preview"].string).fontWeight(message["read"].bool ? .regular : .bold).foregroundStyle(.secondary).font(.caption).lineLimit(model.preferences["density"].string == "spacious" ? 4 : 2) }
                        if model.combined || !model.searchResponse.isNull { Text(message["accountId"].string).font(.caption2).foregroundStyle(morrowGreen).lineLimit(1) }
                        if message["searchMatch"].nonempty { Text(message["folder"].string + " · " + message["searchMatch"].string).font(.caption2).foregroundStyle(.secondary) }
                        Text(dateLabel(message["date"].string)).font(.caption2).foregroundStyle(.tertiary)
                        if message["deliveryStatus"].string == "unconfirmed" { Label("Check delivery", systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
                        if message["scheduledSend"]["status"].string == "scheduled" { Label("Scheduled: " + dateLabel(message["scheduledSend"]["sendAt"].string), systemImage: "clock").font(.caption).foregroundStyle(.secondary) }
                        if message["scheduledSend"]["status"].string == "sending" { Label("Sending", systemImage: "paperplane").font(.caption).foregroundStyle(.secondary) }
                    }.fontWeight(message["read"].bool ? .regular : .bold).padding(.vertical, model.preferences["density"].string == "compact" ? 3 : model.preferences["density"].string == "spacious" ? 14 : 8).tag(message.viewID)
                    .onHover { inside in if inside { hoveredMessage = message.viewID } else if hoveredMessage == message.viewID { hoveredMessage = nil } }
                    .contextMenu {
                        if model.canOrganize(message) { Button("Move / Labels / Spam on Provider…") { model.beginOrganize(message) } }
                        Button(message["starred"].bool ? "Unstar" : "Star") { model.patch(message, .object(["starred": .bool(!message["starred"].bool)])) }
                        Button(message["pending"].bool ? "Clear Pending" : "Mark Pending") { model.patch(message, .object(["pending": .bool(!message["pending"].bool)])) }
                        Button(message["read"].bool ? "Mark Unread" : "Mark Read") { model.patch(message, .object(["read": .bool(!message["read"].bool)])) }
                        if message["folder"].string != "drafts" { Button("Archive Locally") { model.patch(message, .object(["folder": .string("archive")])) } }
                        Button("Move to Local Trash") { model.patch(message, .object(["folder": .string("trash")])) }
                    }
                }.listStyle(.inset).disabled(model.busy)

            }
            Divider()
            if model.searchResponse.isNull {
                HStack {
                    Button("Previous") { Task { await model.turnMailPage(next: false) } }.disabled(model.mailCursors.count < 2 || model.mailLoading)
                    Spacer()
                    if model.mailLoading { ProgressView().controlSize(.small) }
                    else { Text("Page \(model.mailCursors.count) · \(Int(model.mailPage["total"].number)) messages").font(.caption2) }
                    Spacer()
                    Button("Next") { Task { await model.turnMailPage(next: true) } }.disabled(!model.mailPage["nextCursor"].nonempty || model.mailLoading)
                }.padding(10)
            }
        }
    }
    private func rowActions(_ message: JSON) -> some View {
        HStack(spacing: 4) {
            Button { model.patch(message, .object(["read": .bool(!message["read"].bool)])) } label: {
                Label(message["read"].bool ? "Mark Unread" : "Mark Read", systemImage: message["read"].bool ? "envelope.badge" : "envelope.open")
            }.help(message["read"].bool ? "Mark Unread locally" : "Mark Read locally")
            Button { Task { await model.openDraft(message: message, mode: "replyAll") } } label: {
                Label("Reply All", systemImage: "arrowshape.turn.up.left.2")
            }.help("Reply All").disabled(message["folder"].string == "drafts" || !model.canNavigate || model.preparingDraft)
            Button { model.beginOrganize(message, preferredKind: "trash") } label: {
                Label("Move to Provider Trash", systemImage: "trash")
            }.help(model.canOrganize(message) ? "Move to provider Trash · Undo within one minute (⌘Z)" : "Provider Trash is available for imported mail with move permission")
                .disabled(!model.canOrganize(message) || !model.canNavigate || message["folder"].string == "trash")
        }.labelStyle(.iconOnly).buttonStyle(.borderless).controlSize(.small)
    }
    func statusBar(_ text: String, error: Bool) -> some View {
        HStack(alignment: .top) {
            Image(systemName: error ? "exclamationmark.circle" : "checkmark.circle").foregroundStyle(error ? .orange : morrowGreen)
            Text(text).font(.callout).textSelection(.enabled)
            Spacer()
            Button { if error { model.error = "" } else { model.notice = "" } } label: { Image(systemName: "xmark") }.buttonStyle(.plain).accessibilityLabel("Dismiss status")
        }.padding(12).background(.bar)
    }
}

struct MessageReader: View {
    @EnvironmentObject var model: AppModel
    let message: JSON
    let expanded: Bool
    let focused: Bool
    let onExpand: () -> Void
    let onBack: () -> Void
    @State private var detailsExpanded = false
    @State private var summaryExpanded = false
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                if focused { Button(action: onBack) { Label("Back to Messages", systemImage: "chevron.left") }.labelStyle(.iconOnly).help("Back to Messages").disabled(!model.canNavigate) }
                if message["folder"].string == "drafts" {
                    Button(["scheduled", "sending"].contains(message["scheduledSend"]["status"].string) ? "Manage Schedule" : message["providerDraft"].bool ? "Copy to Local Draft" : "Edit Draft") {
                        if message["providerDraft"].bool { Task { await model.openDraft(message: message, mode: "copy") } }
                        else { model.newDraft(Draft(message: message)) }
                    }
                }
                else {
                    Button { Task { await model.openDraft(message: message, mode: "reply") } } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") }.labelStyle(.iconOnly).help("Reply")
                    Button { Task { await model.openDraft(message: message, mode: "replyAll") } } label: { Label("Reply All", systemImage: "arrowshape.turn.up.left.2") }.labelStyle(.iconOnly).help("Reply All")
                    Button { Task { await model.openDraft(message: message, mode: "forward") } } label: { Label("Forward", systemImage: "arrowshape.turn.up.right") }.labelStyle(.iconOnly).help("Forward")
                }
                Spacer()
                if model.canOrganize(message) { Button { model.beginOrganize(message) } label: { Label("Move / Labels / Spam", systemImage: "folder") }.labelStyle(.iconOnly).help("Move, label, or move to Spam on this mailbox’s provider") }
                Button { model.patch(message, .object(["starred": .bool(!message["starred"].bool)])) } label: { Image(systemName: message["starred"].bool ? "star.fill" : "star") }.help("Toggle star").accessibilityLabel("Toggle star")
                Button { model.patch(message, .object(["pending": .bool(!message["pending"].bool)])) } label: { Image(systemName: message["pending"].bool ? "clock.fill" : "clock") }.help(message["pending"].bool ? "Clear Pending" : "Mark Pending locally").accessibilityLabel(message["pending"].bool ? "Clear Pending" : "Mark Pending")
                if message["folder"].string != "drafts" {
                    Button { model.patch(message, .object(["folder": .string(message["folder"].string == "inbox" ? "archive" : "inbox")])) } label: { Image(systemName: message["folder"].string == "inbox" ? "archivebox" : "tray") }.help("Move locally").accessibilityLabel("Move locally")
                }
                Button { model.patch(message, .object(["folder": .string("trash")])) } label: { Image(systemName: "trash") }.help("Move to local trash").accessibilityLabel("Move to local trash")
                Divider().frame(height: 14)
                Button(action: onExpand) { Label(expanded ? "Restore Panes" : "Expand Reader", systemImage: expanded ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right") }.labelStyle(.iconOnly).help(expanded ? "Restore Panes" : "Expand Reader")
            }.buttonStyle(.borderless).controlSize(.small).padding(.horizontal, 16).padding(.vertical, 10).disabled(model.busy)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(message["subject"].nonempty ? message["subject"].string : "(No subject)")
                        .font(.system(size: 21, weight: .semibold)).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(message["fromName"].nonempty ? message["fromName"].string : message["fromEmail"].string)
                            .font(.headline).lineLimit(1).help(message["fromEmail"].string)
                        Spacer(minLength: 0)
                        Text(dateLabel(message["date"].string)).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
                    }.textSelection(.enabled)
                    DisclosureGroup(isExpanded: $detailsExpanded) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("From: " + message["fromName"].string + " <" + message["fromEmail"].string + ">")
                            Text("To: " + message["to"].string)
                            if message["cc"].nonempty { Text("Cc: " + message["cc"].string) }
                            if message["bcc"].nonempty { Text("Bcc: " + message["bcc"].string) }
                            Text("Mailbox: " + message["accountId"].string)
                            Text("Date: " + dateLabel(message["date"].string))
                            if message["providerFolderName"].nonempty { Text("Provider: " + message["providerFolderName"].string) }
                            if !message["labels"].array.isEmpty { Text("Labels: " + message["labels"].array.map(\.string).joined(separator: ", ")) }
                        }.font(.caption).foregroundStyle(.secondary).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 5)
                    } label: {
                        HStack(spacing: 8) {
                            Text("Details")
                            Text("To: " + message["to"].string).foregroundStyle(.secondary).lineLimit(1)
                        }.font(.caption)
                    }
                    if !message["aiSummary"].isNull {
                        VStack(alignment: .leading, spacing: 5) {
                            DisclosureGroup(isExpanded: $summaryExpanded) {
                              VStack(alignment: .leading, spacing: 8) {
                                ForEach(Array(message["aiSummary"]["items"].array.enumerated()), id: \.offset) { _, item in
                                    Text(item["priority"].string + " · " + item["summary"].string).textSelection(.enabled)
                                }
                                if message["aiSummary"]["items"].array.isEmpty { Text(message["aiSummary"]["text"].string).textSelection(.enabled) }
                                Text(dateLabel(message["aiSummary"]["completedAt"].string) + " · Review AI priorities.").font(.caption).foregroundStyle(.secondary)
                              }.padding(.top, 6).frame(maxWidth: .infinity, alignment: .leading)
                            } label: { Label(message["aiSummary"]["source"].string == "demo" ? "Illustrative demo summary" : "AI summary · Review before using", systemImage: "sparkles").font(.caption).foregroundStyle(morrowGreen) }
                            if !summaryExpanded {
                                Text(message["aiSummary"]["items"].array.first?["summary"].string ?? message["aiSummary"]["text"].string)
                                    .font(.callout).foregroundStyle(.secondary).lineLimit(2)
                            }
                        }.padding(10).background(morrowGreen.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                    } else { AutomaticAssistance(messageID: message.id, account: message["accountId"].string, trigger: "onOpen") }
                    Divider()
                    SecureMessageBody(message: message).id(message.viewID)
                    FooterPreview(footer: message["footer"])
                    Divider()
                    LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], alignment: .leading, spacing: 8) {
                        ForEach(["summary", "reply", "history", "translate"], id: \.self) { action in
                            Button(action == "summary" ? "Summarize" : action == "reply" ? "Suggest Reply" : action == "history" ? "Suggest with History" : "Translate") {
                                model.openAssistant(action == "history" ? "reply" : action, message: message, includeHistory: action == "history")
                            }.disabled(!model.canNavigate || model.messageDetail.viewID != message.viewID || !model.allowed(action == "history" ? "reply" : action) || !model.policy["folders"][message["folder"].string].bool || (action == "history" && !model.policy["content"]["sender"].bool))
                                .help(action == "history" ? "Review downloaded same-sender mail in this account, within saved AI permissions. Sender access is required." : "Open AI assistance for this message")
                        }
                    }.controlSize(.small).frame(maxWidth: 400, alignment: .leading)
                    Text("AI uses your saved permissions. Generated text is yours to review.").font(.caption).foregroundStyle(.secondary)
                }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .onChange(of: message.viewID) { _ in detailsExpanded = false; summaryExpanded = false }
    }
}

struct ReaderAssistanceView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    let request: JSON
    let useDraft: (Draft) -> Void
    @State private var result: JSON = .null
    @State private var prompt = ""
    @State private var loading = false
    @State private var started = false
    @State private var invalidated = false
    @State private var localError = ""
    @State private var work: Task<Void, Never>?
    @State private var runID = UUID()
    private var message: JSON { request["message"] }
    private var action: String { request["action"].string }
    private var history: Bool { request["includeHistory"].bool }
    private var current: Bool { !invalidated && model.readerAssistantIsCurrent(request) }
    private var title: String { history ? "Suggest with History" : action == "summary" ? "Summarize" : action == "reply" ? "Suggest Reply" : "Translate" }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Label(title, systemImage: "sparkles").font(.title2.weight(.semibold))
                Spacer()
                Button("Close") { stop(); dismiss() }.keyboardShortcut(.cancelAction)
            }
            ScrollView {
              VStack(alignment: .leading, spacing: 12) {
            Text(message["subject"].nonempty ? message["subject"].string : "(No subject)").lineLimit(2).help(message["subject"].string)
            Text(message["accountId"].string).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            if history {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Downloaded history only").font(.headline)
                    Text("Uses this message and cached mail from \(message["fromEmail"].string) in this account. It does not fetch older mail from your provider.")
                    Text("Up to \(Int(request["settings"]["policy"]["maxMessages"].number)) messages, including this one. Saved folder and content permissions apply; sender access is required.")
                    Text("Permitted folders: " + permissionFolders.filter { request["settings"]["policy"]["folders"][$0].bool }.map { $0.capitalized }.joined(separator: ", "))
                    Text("Permitted content: " + ["subject", "body", "sender"].filter { request["settings"]["policy"]["content"][$0].bool }.joined(separator: ", "))
                }.font(.callout).foregroundStyle(.secondary).padding(12).background(morrowGreen.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
            }
            Text(request["settings"]["ai"]["configured"].bool
                 ? "Model: \(request["settings"]["ai"]["model"].string) · \(request["settings"]["ai"]["baseUrl"].string)"
                 : "No model configured · Choose an AI model in Settings")
                .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            if history || action == "translate" {
                TextField(action == "translate" ? "Language or translation instructions (optional)" : "Reply instructions (optional)", text: $prompt)
                    .textFieldStyle(.roundedBorder).disabled(loading || !current)
                    .onChange(of: prompt) { _ in result = .null; localError = "" }
            }
            if !current {
                Label("The message, account or AI settings changed. Close this window and reopen the action to review the new context.", systemImage: "exclamationmark.circle").foregroundStyle(.secondary)
            } else if loading {
                HStack { ProgressView().controlSize(.small); Text(model.preparingDraft ? "Preparing draft…" : "Generating…"); Spacer(); Button("Cancel") { stop(); localError = "Stopped waiting. The model may already be processing; no retry was started." } }
            } else if !localError.isEmpty {
                Text(localError).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if current && result["text"].nonempty {
                Divider()
                Text(result["source"].string == "demo" ? "Illustrative demo · Review before using" : "AI result · Review before using").font(.caption).foregroundStyle(.secondary)
                if history && result["history"]["scope"].string == "downloaded" {
                    Text("Used \(Int(result["history"]["usedMessages"].number)) of \(Int(result["history"]["matchedMessages"].number)) matching downloaded messages · Limit \(Int(result["history"]["maxMessages"].number))")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Text(result["text"].string).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
            }
              }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: .infinity)
            Divider()
            HStack {
                Button(result["text"].nonempty ? "Generate Again" : "Generate") { generate() }
                    .disabled(loading || !current || model.busy || !request["settings"]["ai"]["configured"].bool)
                Spacer()
                if result["text"].nonempty && current {
                    Button("Copy") {
                        guard current else { return }
                        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(result["text"].string, forType: .string)
                    }
                    if action == "reply" {
                        Button("Use in Draft") {
                            prepareDraft()
                        }.buttonStyle(.borderedProminent).disabled(loading || model.busy || model.preparingDraft)
                    }
                }
            }
            Text("Your model provider may charge. Generated text is a suggestion; nothing is sent until you review a draft and choose Send.").font(.caption).foregroundStyle(.secondary)
        }
        .padding(22).frame(width: 580, height: min(650, (NSScreen.main?.visibleFrame.height ?? 800) - 100))
        .task {
            guard !started else { return }
            started = true
            if !current { invalidate() }
            else if !history { generate() }
        }
        .onChange(of: model.readerAssistantIsCurrent(request)) { valid in if !valid { invalidate() } }
        .onDisappear { stop() }
    }
    private func prepareDraft() {
        guard current, !loading, !model.busy, !model.preparingDraft else { return }
        let run = UUID(), text = result["text"].string
        runID = run; loading = true; localError = ""
        work = Task { @MainActor in
            defer { if runID == run { loading = false; work = nil } }
            do {
                let draft = try await model.prepareDraft(message: message, mode: "reply", body: text)
                guard !Task.isCancelled, runID == run, current else { return }
                useDraft(draft); dismiss()
            } catch is CancellationError { }
            catch { if !Task.isCancelled, runID == run, current { localError = error.localizedDescription } }
        }
    }
    private func stop() { work?.cancel(); work = nil; runID = UUID(); loading = false }
    private func invalidate() { stop(); invalidated = true; result = .null; localError = "" }
    private func generate() {
        guard !loading, current, !model.busy, request["settings"]["ai"]["configured"].bool else { return }
        var payload: JSON = .object(["action": .string(action), "messageId": .string(message.id), "prompt": .string(prompt)])
        if history { payload["includeHistory"] = .bool(true) }
        let owner = message["accountId"].string, run = UUID()
        runID = run; loading = true; result = .null; localError = ""
        work = Task { @MainActor in
            do {
                let next = try await model.request("/ai", method: "POST", body: payload, mailbox: owner)
                guard !Task.isCancelled, runID == run else { return }
                guard current else { invalidate(); return }
                result = next
            } catch {
                guard !Task.isCancelled, runID == run else { return }
                guard current else { invalidate(); return }
                localError = error.localizedDescription
            }
            if runID == run { loading = false; work = nil }
        }
    }
}

struct AutomaticAssistance: View {
    @EnvironmentObject var model: AppModel
    let messageID: String
    let account: String
    let trigger: String
    var use: ((String) -> Void)? = nil
    @State private var result: JSON = .null
    @State private var loading = false
    @State private var error = ""
    @State private var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if loading { ProgressView(trigger == "onOpen" ? "Preparing automatic summary…" : "Preparing reply suggestion…") }
            if result["text"].nonempty {
                if trigger == "onOpen" {
                    VStack(alignment: .leading, spacing: 5) {
                        DisclosureGroup(isExpanded: $expanded) {
                            Text(result["text"].string).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
                        } label: { Label(result["source"].string == "demo" ? "Illustrative demo summary" : "AI summary · Review before using", systemImage: "sparkles").font(.caption).foregroundStyle(morrowGreen) }
                        if !expanded { Text(result["text"].string).font(.callout).foregroundStyle(.secondary).lineLimit(2) }
                    }.padding(10).background(morrowGreen.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                } else {
                    Text(result["source"].string == "demo" ? "Automatic assistance · Illustrative demo" : "Automatic assistance · Review before using").font(.caption).foregroundStyle(.secondary)
                    Text(result["text"].string).textSelection(.enabled)
                }
                if let use { Button("Use Suggested Reply") { use(result["text"].string) }.disabled(model.busy) }
            }
            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.secondary) }
        }
        .task(id: account + "\n" + messageID + "\n" + trigger) {
            result = .null; error = ""; loading = false; expanded = false
            let action = trigger == "onOpen" ? "summary" : "reply", policy = model.policy, ai = model.state["settings"]["ai"], preferences = model.preferences
            guard policy["triggers"][trigger].bool, model.allowed(action) else { return }
            loading = true
            do {
                let next = try await model.request("/ai", method: "POST", body: .object(["action": .string(action), "trigger": .string(trigger), "messageId": .string(messageID)]), mailbox: account)
                if !Task.isCancelled && policy == model.policy && ai == model.state["settings"]["ai"] && preferences == model.preferences { result = next }
            } catch { if !Task.isCancelled { self.error = "Automatic assistance: " + error.localizedDescription } }
            if !Task.isCancelled { loading = false }
        }
        .onChange(of: model.policy) { _ in result = .null; error = "" }
        .onChange(of: model.state["settings"]["ai"]) { _ in result = .null; error = "" }
        .onChange(of: model.preferences) { _ in result = .null; error = "" }
    }
}

struct OrganizeMailView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    let message: JSON
    let preferredKind: String
    var preferredDestination: String = ""
    @State private var folders: [JSON] = []
    @State private var destination = ""
    @State private var mode = "move"
    @State private var provider = ""
    @State private var loading = true
    @State private var localError = ""
    @State private var review = false
    var choices: [JSON] { folders.filter { mode == "move" || $0["kind"].string == "label" } }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(preferredKind == "trash" ? "Move to Provider Trash" : "Move / Labels / Spam on Provider").font(.title2.bold())
            Text(message["subject"].string).lineLimit(2)
            Text(message["accountId"].string).foregroundStyle(.secondary)
            if loading { ProgressView("Loading folders…") }
            else {
                if preferredKind == "trash" {
                    if let folder = folders.first(where: { $0.id == destination }) {
                        Text("Destination: \(folder["name"].string)")
                    }
                } else {
                    if provider == "google" {
                        Picker("Action", selection: $mode) {
                            Text("Move out of Inbox").tag("move")
                            Text("Add label").tag("addLabel")
                            Text("Remove label").tag("removeLabel")
                        }.onChange(of: mode) { _ in destination = choices.first?.id ?? "" }
                    }
                    Picker(provider == "google" ? "Label / location" : "Folder", selection: $destination) {
                        Text("Choose a destination").tag("")
                        ForEach(choices) { folder in Text(folder["name"].string).tag(folder.id) }
                    }
                }
                Text(preferredKind == "trash" ? "This moves the message to Trash on the account shown above. It does not permanently delete the message." : "This changes the message on your mail provider. Moves stay within this account. Gmail labels are shown on downloaded mail. Archive contains mail without Inbox, Sent, Draft, Spam or Trash labels.").font(.callout).foregroundStyle(.secondary)
                if preferredKind != "trash" {
                    if provider == "google" { Text("Move adds the selected label and removes Inbox; other labels remain. Add / Remove label keeps the current Inbox status.").font(.caption).foregroundStyle(.secondary) }
                    Text("Choose Spam / Junk in the destination list, then Review Change to move the message. Morrow does not directly report abuse or block senders; use the same account on your provider for those actions.").font(.caption).foregroundStyle(.secondary)
                    if provider == "google" { Link("Open Gmail to report or block", destination: URL(string: "https://mail.google.com/")!) }
                    else if provider == "microsoft" { Link("Open Outlook to report or block", destination: URL(string: "https://outlook.live.com/mail/")!) }
                }
            }
            if !localError.isEmpty { Text(localError).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(model.busy)
                Spacer()
                Button(preferredKind == "trash" ? "Review Trash Move" : "Review Change") { review = true }.buttonStyle(.borderedProminent).disabled(loading || model.busy || destination.isEmpty)
            }
        }.padding(26).frame(width: 530).interactiveDismissDisabled(model.busy)
        .task {
            do {
                let result = try await model.request("/mail/folders", mailbox: message["accountId"].string)
                folders = result["folders"].array; provider = result["provider"].string
                if folders.contains(where: { $0.id == preferredDestination }) { destination = preferredDestination }
                if preferredKind == "trash" {
                    destination = folders.first { $0["kind"].string == "trash" }?.id ?? ""
                    if destination.isEmpty { localError = "This mailbox did not expose a provider Trash folder. Check its permissions or use your provider." }
                }
            } catch { localError = error.localizedDescription }
            loading = false
        }
        .confirmationDialog("Apply this change on your mail provider?", isPresented: $review, titleVisibility: .visible) {
            Button("Apply Provider Change") {
                model.perform {
                    do {
                        _ = try await model.request("/messages/" + encodedPath(message.id) + "/organize", method: "POST", body: .object(["destinationId": .string(destination), "mode": .string(mode), "confirmed": .bool(true)]), mailbox: message["accountId"].string)
                        try await model.reload(); model.notice = "Provider change confirmed."; dismiss()
                    } catch { localError = error.localizedDescription }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Account: \(message["accountId"].string)\nAction: \(mode == "move" ? "Move" : mode == "addLabel" ? "Add label" : "Remove label")\nDestination: \(choices.first { $0.id == destination }?["name"].string ?? destination)") }
    }
}

struct ScheduledMailView: View {
    @EnvironmentObject var model: AppModel
    @State private var jobs: [JSON] = []
    @State private var loading = false
    @State private var loadGeneration = 0
    @State private var localError = ""
    private var account: String {
        if !model.scheduledAccount.isEmpty { return model.accounts.contains { $0.id == model.scheduledAccount } ? model.scheduledAccount : "" }
        return model.combined ? model.accounts.first?.id ?? "" : model.account
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                SectionHeading(title: "Outbox", detail: "Delayed and scheduled mail waiting to be sent. Morrow must be open to send; catch-up is limited to 15 minutes.")
                HStack {
                    Picker("Mailbox", selection: Binding(get: { account }, set: { model.scheduledAccount = $0 })) {
                        ForEach(model.accounts) { Text($0["email"].string).tag($0.id) }
                    }.disabled(model.busy)
                    Spacer()
                    Button("Refresh") { Task { await load() } }.disabled(loading || model.busy || account.isEmpty)
                    if loading { ProgressView().controlSize(.small) }
                }
                if !localError.isEmpty { Text(localError).foregroundStyle(.red).textSelection(.enabled) }
                if jobs.isEmpty && !loading { Text("No scheduled messages in this mailbox.").foregroundStyle(.secondary) }
                ForEach(jobs) { job in
                    let message = job["payload"].isNull ? job : job["payload"]
                    GroupBox {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(message["subject"].nonempty ? message["subject"].string : "(No subject)").font(.headline)
                                Spacer()
                                Text(statusLabel(job)).font(.caption).foregroundStyle(.secondary)
                            }
                            Text("To: " + message["to"].string).textSelection(.enabled)
                            if message["cc"].nonempty { Text("Cc: " + message["cc"].string).textSelection(.enabled) }
                            if message["bcc"].nonempty { Text("Bcc: " + message["bcc"].string).textSelection(.enabled) }
                            Text("Send at: " + dateLabel(job["sendAt"].string)).font(.callout)
                            if job["error"].nonempty { Text(job["error"].string).font(.callout).foregroundStyle(.orange).textSelection(.enabled) }
                            HStack {
                                if ["scheduled", "missed", "blocked"].contains(job["status"].string) {
                                    Button("Cancel Schedule") { cancel(job, reschedule: false) }
                                    Button("Review New Schedule") { cancel(job, reschedule: true) }.disabled(job["payload"].isNull)
                                }
                                if job["status"].string == "uncertain" || job["requiresSendReview"].bool {
                                    Button("Review Delivery") { reviewDelivery(job) }.disabled(!job["draftId"].nonempty)
                                }
                            }.disabled(model.busy)
                            if job["status"].string == "uncertain" { Text("Delivery may already have happened. Check Sent before reviewing a retry; this schedule cannot be cancelled.").font(.caption).foregroundStyle(.orange) }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                    }
                }
            }.padding(28).frame(maxWidth: .infinity, alignment: .leading)
        }.task(id: account) {
            await load()
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
                if NSApp?.isActive == true && !model.busy { await load() }
            }
        }
    }
    private func statusLabel(_ job: JSON) -> String {
        ["scheduled": "Scheduled", "sending": "Sending", "sent": "Sent", "cancelled": "Cancelled", "missed": "Missed — review required", "blocked": "Blocked — review required", "uncertain": "Check delivery"][job["status"].string] ?? "Status unavailable"
    }
    private func load() async {
        let owner = account
        loadGeneration += 1
        let generation = loadGeneration
        guard !owner.isEmpty, owner != "all", owner != "demo" else { jobs = []; loading = false; return }
        loading = true; localError = ""; jobs = jobs.filter { $0["accountId"].string == owner }
        defer { if generation == loadGeneration { loading = false } }
        do {
            let result = try await model.request("/scheduled", mailbox: owner)
            guard !Task.isCancelled, account == owner, generation == loadGeneration else { return }
            guard case .array = result["scheduled"] else { throw APIError("Morrow received an incomplete schedule list.") }
            jobs = result["scheduled"].array.filter { $0["accountId"].string == owner && !["sent", "cancelled"].contains($0["status"].string) }
        } catch { if !Task.isCancelled, account == owner, generation == loadGeneration { localError = error.localizedDescription } }
    }
    private func cancel(_ job: JSON, reschedule: Bool) {
        let owner = job["accountId"].string
        let message = job["payload"].isNull ? job : job["payload"]
        guard owner == account, ["scheduled", "missed", "blocked"].contains(job["status"].string),
              model.confirm(reschedule ? "Cancel this schedule and review a new one?" : "Cancel this scheduled message?", detail: "Mailbox: \(owner)\nSubject: \(message["subject"].string)\nThe saved draft remains available. No replacement is scheduled until you review and confirm it.") else { return }
        model.perform {
            do {
                let result = try await model.request("/scheduled/" + encodedPath(job.id) + "/cancel", method: "POST", body: .object([:]), mailbox: owner)
                guard result["job"]["id"] == job["id"], result["job"]["accountId"].string == owner, result["job"]["status"].string == "cancelled" else { throw APIError("Cancellation could not be confirmed. Refresh Scheduled before retrying.") }
                model.notice = "Schedule cancelled. The draft is retained."
                try? await model.reload()
                await load()
                if reschedule {
                    var message = job["payload"]
                    message["accountId"] = .string(owner); message["id"] = job["draftId"]
                    var draft = Draft(message: message)
                    draft.scheduleDate = max(parsedDate(job["sendAt"].string) ?? Date(), Date().addingTimeInterval(3600))
                    let reviewedDraft = draft
                    // perform keeps busy true until it returns; open the editor afterwards.
                    DispatchQueue.main.async { model.newDraft(reviewedDraft) }
                }
            } catch { localError = error.localizedDescription }
        }
    }
    private func reviewDelivery(_ job: JSON) {
        let owner = job["accountId"].string
        guard owner == account, job["draftId"].nonempty else { return }
        model.perform {
            do {
                let result = try await model.request("/messages/" + encodedPath(job["draftId"].string), mailbox: owner)
                let message = result["message"]
                guard message["accountId"].string == owner, message["deliveryStatus"].string == "unconfirmed" else { throw APIError("Refresh Scheduled and check Sent before retrying this message.") }
                DispatchQueue.main.async { model.newDraft(Draft(message: message)) }
            } catch { localError = error.localizedDescription }
        }
    }
}

struct ComposeView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    let initial: Draft
    @State private var draft: Draft
    @State private var saved: JSON
    @State private var reviewed = false
    @State private var aiPrompt = ""
    @State private var aiResult = ""
    @State private var aiSource = ""
    @State private var localError = ""
    @State private var confirmSend = false
    @State private var scheduleEnabled = false
    @State private var sendAt: Date
    @State private var confirmSchedule = false
    @State private var scheduleRequestID = UUID().uuidString
    @State private var scheduleAttempt: JSON?
    init(initial: Draft) {
        self.initial = initial; _draft = State(initialValue: initial); _saved = State(initialValue: initial.payload)
        _sendAt = State(initialValue: initial.scheduleDate ?? Date().addingTimeInterval(3600))
        _scheduleEnabled = State(initialValue: initial.scheduleDate != nil)
    }
    var dirty: Bool { scheduleEnabled || scheduleAttempt != nil || draft.payload != saved || (draft.savedID.isEmpty && (!draft.to.isEmpty || !draft.cc.isEmpty || !draft.bcc.isEmpty || !draft.subject.isEmpty || !draft.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)) }
    private var frozen: Bool { model.busy || draft.unconfirmed || draft.scheduleLocked || scheduleAttempt != nil }
    private var reviewedSendAt: Date { scheduleAttempt.flatMap { parsedDate($0["sendAt"].string) } ?? sendAt }
    private var defaultDelay: Int { max(0, min(6, Int(model.preferences["sendDelayHours"].number))) }
    var body: some View {
        VStack(spacing: 0) {
          ScrollView {
           VStack(alignment: .leading, spacing: 16) {
            HStack { Text(draft.savedID.isEmpty ? (draft.forwarding ? "Forward" : draft.replyToID.isEmpty ? "New message" : "Reply") : "Your draft").font(.title2.bold()); Spacer(); Text(draft.accountID == "demo" ? "Simulated send" : draft.accountID).foregroundStyle(.secondary).font(.caption) }
            if !draft.savedID.isEmpty || !draft.replyToID.isEmpty || draft.forwarding || draft.sourceDraft || draft.unconfirmed {
                HStack {
                    Text("From").frame(width: 36, alignment: .leading).foregroundStyle(.secondary)
                    Text(draft.accountID == "demo" ? "Demo workspace (simulated)" : draft.accountID).textSelection(.enabled)
                    Image(systemName: "lock.fill").font(.caption2).foregroundStyle(.secondary)
                }.accessibilityElement(children: .combine)
            } else {
                Picker("From", selection: $draft.accountID) {
                    ForEach(model.senderAccounts) { account in Text(account["email"].string).tag(account.id) }
                }.disabled(frozen)
                .onChange(of: draft.accountID) { _ in aiResult = ""; draft.requestID = UUID().uuidString }
            }
            if draft.sourceDraft { Text("Editing a local copy without attachments. The original Gmail draft stays in Gmail; changes here are not uploaded to it.").font(.caption).foregroundStyle(.secondary) }
            if draft.forwarding { Text("Forwarding the message text. Attachments are not included.").font(.caption).foregroundStyle(.secondary) }
            if draft.scheduleLocked {
                Label("This draft is scheduled for \(dateLabel(draft.scheduledSend["sendAt"].string)). Open Outbox and cancel its schedule before editing or sending it.", systemImage: "lock.fill").font(.callout).foregroundStyle(.orange)
            }
            if !draft.replyToID.isEmpty { Label("Replying from the mailbox that owns this conversation", systemImage: "lock.fill").font(.caption).foregroundStyle(.secondary) }
            if !initial.replyToID.isEmpty && initial.savedID.isEmpty && initial.body.isEmpty && !draft.unconfirmed {
                AutomaticAssistance(messageID: initial.replyToID, account: initial.accountID, trigger: "onReply") { text in
                    guard !frozen else { return }
                    if draft.body.isEmpty || model.confirm("Replace this draft’s text?", detail: "Your current text will be replaced with the suggestion. Recipients and footer stay the same.") { draft.body = text }
                }
            }
            if draft.unconfirmed {
                Label("Delivery was not confirmed. Check your provider’s Sent folder before retrying. Retrying may send a duplicate.", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                Toggle("I checked Sent and want to retry this delivery", isOn: $reviewed).toggleStyle(.checkbox)
            }
            VStack(spacing: 12) {
                recipientField("To", text: $draft.to, placeholder: "Email addresses, separated by commas")
                recipientField("Cc", text: $draft.cc, placeholder: "Copy recipients")
                recipientField("Bcc", text: $draft.bcc, placeholder: "Hidden recipients")
                Text("Use plain email addresses separated by commas or semicolons (100 recipients total). Bcc recipients are hidden from other recipients.").font(.caption).foregroundStyle(.secondary)
                TextField("Subject", text: $draft.subject)
                TextArea(title: "Message", text: $draft.body, height: 210)
            }.textFieldStyle(.roundedBorder).disabled(frozen)
            if draft.footer["text"].nonempty || draft.footer["html"].nonempty {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Label("Email footer", systemImage: "signature").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button("Remove") { draft.footer = .object(["text": .string(""), "html": .string("")]) }.buttonStyle(.borderless).disabled(frozen)
                    }
                    FooterPreview(footer: draft.footer)
                }.padding(12).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
            }
            if !draft.unconfirmed && !draft.scheduleLocked && scheduleAttempt == nil {
                DisclosureGroup("Writing assistance") {
                    VStack(alignment: .leading, spacing: 12) {
                        TextField("Instructions for your assistant", text: $aiPrompt).textFieldStyle(.roundedBorder)
                        HStack {
                            ForEach(["write", "rewrite", "translate"], id: \.self) { action in
                                Button(action.capitalized) { assist(action) }.disabled(model.busy || !model.allowed(action) || (action == "write" ? aiPrompt.isEmpty : draft.body.isEmpty))
                            }
                        }
                        if !aiResult.isEmpty {
                            Text(aiSource == "demo" ? "Illustrative demo result" : "AI suggestion — review before using").font(.caption).foregroundStyle(.secondary)
                            ScrollView { Text(aiResult).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 100)
                            Button("Use in Draft") { draft.body = aiResult; aiResult = "" }.disabled(model.busy)
                        }
                    }.padding(.top, 8)
                }
            }
            if !draft.unconfirmed {
                if defaultDelay > 0 && !scheduleEnabled { Text("Default send delay: \(defaultDelay) hour\(defaultDelay == 1 ? "" : "s"). Review the send time before adding this message to Outbox.").font(.caption).foregroundStyle(.secondary) }
                Toggle("Schedule for later", isOn: $scheduleEnabled).toggleStyle(.checkbox).disabled(frozen)
                if scheduleEnabled {
                    DatePicker("Send at", selection: $sendAt, displayedComponents: [.date, .hourAndMinute]).disabled(frozen)
                    Text("Time zone: \(TimeZone.current.identifier). Morrow must be open to send. A missed time can catch up within 15 minutes; after that, review and schedule again. Scheduled message contents stay locked until you cancel the schedule.").font(.caption).foregroundStyle(.secondary)
                }
            }
            if scheduleAttempt != nil {
                Text("The scheduling request has been submitted. If confirmation was lost, retry the same request or check Outbox before sending another copy.").font(.callout).foregroundStyle(.orange)
            }
            if !localError.isEmpty { Text(localError).foregroundStyle(.red).font(.callout).textSelection(.enabled) }
           }.padding(24)
          }
          Divider()
            HStack {
                Button(scheduleAttempt != nil || draft.scheduleLocked ? "View Outbox" : draft.unconfirmed ? "Close" : "Cancel") { close() }.keyboardShortcut(.cancelAction).disabled(model.busy)
                Spacer()
                if model.busy { ProgressView().controlSize(.small) }
                Button("Save Draft") { save() }.keyboardShortcut("s").disabled(frozen)
                if (scheduleEnabled || defaultDelay > 0 || scheduleAttempt != nil) && !draft.unconfirmed {
                    Button(scheduleAttempt == nil ? "Review & Send Later" : "Retry Same Schedule") {
                        if !scheduleEnabled && scheduleAttempt == nil { sendAt = Date().addingTimeInterval(Double(defaultDelay) * 3600) }
                        confirmSchedule = true
                    }
                        .keyboardShortcut("d", modifiers: [.command, .shift]).buttonStyle(.borderedProminent).disabled(model.busy || draft.scheduleLocked || [draft.to, draft.cc, draft.bcc].allSatisfy { $0.trimmingCharacters(in: .whitespaces).isEmpty } || draft.body.isEmpty || (scheduleEnabled && scheduleAttempt == nil && sendAt <= Date()))
                } else {
                  Button(draft.unconfirmed ? "Review Retry" : "Review & Send") { confirmSend = true }
                    .keyboardShortcut("d", modifiers: [.command, .shift]).buttonStyle(.borderedProminent).disabled(model.busy || draft.scheduleLocked || [draft.to, draft.cc, draft.bcc].allSatisfy { $0.trimmingCharacters(in: .whitespaces).isEmpty } || draft.body.isEmpty || (draft.unconfirmed && !reviewed))
                }
            }.padding(20)
        }.frame(width: 690, height: min(780, (NSScreen.main?.visibleFrame.height ?? 900) - 100))
        .interactiveDismissDisabled(dirty || model.busy)
        .onAppear { model.dirty("compose", dirty) }
        .onChange(of: draft) { _ in model.dirty("compose", dirty) }
        .onChange(of: scheduleEnabled) { _ in model.dirty("compose", dirty) }
        .onChange(of: scheduleAttempt) { _ in model.dirty("compose", dirty) }
        .onDisappear { model.dirty("compose", false) }
        .confirmationDialog(draft.accountID == "demo" ? "Simulate sending this message?" : "Send this message to the listed recipients?", isPresented: $confirmSend, titleVisibility: .visible) {
            Button(draft.accountID == "demo" ? "Simulate Send" : "Send Message") { send() }
            Button("Cancel", role: .cancel) {}
        } message: { Text("From: \(draft.accountID)\nTo: \(draft.to)\nCc: \(draft.cc)\nBcc: \(draft.bcc)\nSubject: \(draft.subject.isEmpty ? "(No subject)" : draft.subject)\n\(draft.unconfirmed ? "This retry may create a duplicate." : "The message and displayed footer will be sent together.")") }
        .confirmationDialog("Schedule this message?", isPresented: $confirmSchedule, titleVisibility: .visible) {
            Button(scheduleAttempt == nil ? "Schedule Message" : "Retry Same Schedule") { schedule() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("From: \(draft.accountID)\nTo: \(draft.to)\nCc: \(draft.cc)\nBcc: \(draft.bcc)\nSubject: \(draft.subject.isEmpty ? "(No subject)" : draft.subject)\nSend at: \(reviewedSendAt.formatted(date: .abbreviated, time: .shortened)) (\(TimeZone.current.identifier))\nMorrow must be open. Catch-up is limited to 15 minutes; later delivery requires a new review. The reviewed message and displayed footer will be locked until this schedule is cancelled.")
        }
    }
    func recipientField(_ label: String, text: Binding<String>, placeholder: String) -> some View {
        HStack {
            Text(label).frame(width: 36, alignment: .leading).foregroundStyle(.secondary)
            TextField(placeholder, text: text).accessibilityLabel(label)
        }
    }
    func close() {
        if scheduleAttempt != nil || draft.scheduleLocked { dismiss(); model.scheduledAccount = draft.accountID; model.section = "scheduled" }
        else if !dirty || draft.unconfirmed || model.confirmDiscard("Discard this draft’s unsaved changes?") { dismiss() }
    }
    func save() {
        guard !draft.scheduleLocked, scheduleAttempt == nil else { return }
        let payload = draft.payload, account = draft.accountID
        model.perform {
            do {
                let result = try await model.request("/drafts", method: "POST", body: payload, mailbox: account)
                draft.savedID = result["message"].id; saved = draft.payload
                try await model.reload(); model.notice = "Draft saved."; dismiss()
            } catch { localError = error.localizedDescription }
        }
    }
    func send() {
        guard !draft.scheduleLocked, scheduleAttempt == nil else { return }
        let account = draft.accountID
        model.perform {
            var submitted = false
            do {
                if !draft.unconfirmed {
                    let savedDraft = try await model.request("/drafts", method: "POST", body: draft.payload, mailbox: account)
                    draft.savedID = savedDraft["message"].id; saved = draft.payload
                }
                var payload = draft.payload
                payload["draftId"] = draft.savedID.isEmpty ? .null : .string(draft.savedID)
                payload["requestId"] = .string(draft.requestID)
                payload["retryUnconfirmed"] = .bool(draft.unconfirmed && reviewed)
                submitted = true
                let result = try await model.request("/send", method: "POST", body: payload, mailbox: account)
                model.notice = result["simulated"].bool ? "Demo message sent locally." : "Message sent."
                try? await model.reload(); dismiss()
            } catch let error as APIError {
                if error.payload["requiresSendReview"].bool {
                    draft = Draft(message: error.payload["message"]); saved = draft.payload; reviewed = false
                    try? await model.reload()
                }
                localError = error.localizedDescription
            } catch {
                // A lost HTTP response can hide a completed send. Freeze the text,
                // keep this request ID, and require review before retrying.
                if submitted {
                    draft.unconfirmed = true; reviewed = false
                    localError = "Delivery could not be confirmed. Check Sent before retrying this same message. " + error.localizedDescription
                    try? await model.reload()
                    if model.messages.contains(where: { $0.id == "sent:" + draft.requestID && $0["accountId"].string == account }) { model.notice = "Message sent."; dismiss() }
                } else { localError = "The draft could not be saved, so sending was not attempted. " + error.localizedDescription }
            }
        }
    }
    func schedule() {
        let account = draft.accountID
        guard !draft.scheduleLocked, !draft.unconfirmed, scheduleAttempt != nil || sendAt > Date() else { localError = "Choose a future send time for an unlocked draft."; return }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let reviewedPayload = draft.payload, reviewedTime = formatter.string(from: sendAt)
        model.perform {
            do {
                if scheduleAttempt == nil {
                    let savedDraft = try await model.request("/drafts", method: "POST", body: reviewedPayload, mailbox: account)
                    draft.savedID = savedDraft["message"].id; saved = draft.payload
                    guard !draft.savedID.isEmpty else { throw APIError("The draft could not be confirmed, so scheduling was not attempted.") }
                    var payload = reviewedPayload.picking(["to", "cc", "bcc", "subject", "body", "footer", "replyToId"])
                    payload["draftId"] = .string(draft.savedID)
                    payload["requestId"] = .string(scheduleRequestID)
                    payload["sendAt"] = .string(reviewedTime)
                    scheduleAttempt = payload
                }
                guard let payload = scheduleAttempt else { return }
                _ = try await model.request("/scheduled", method: "POST", body: payload, mailbox: account)
                model.notice = "Message scheduled. Keep Morrow open at the chosen time."
                try? await model.reload(); dismiss(); model.scheduledAccount = account; model.section = "scheduled"
            } catch { localError = error.localizedDescription }
        }
    }
    func assist(_ action: String) {
        let payload = JSON.object(["action": .string(action), "prompt": .string(aiPrompt), "draftText": .string(draft.body)])
        model.perform {
            do { let result = try await model.request("/ai", method: "POST", body: payload, mailbox: draft.accountID); aiResult = result["text"].string; aiSource = result["source"].string }
            catch { localError = error.localizedDescription }
        }
    }
}
