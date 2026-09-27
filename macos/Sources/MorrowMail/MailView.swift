import SwiftUI
import AppKit

struct MailWorkspace: View {
    @AppStorage("collapsedMailAccounts") private var collapsedAccounts = "[]"
    @AppStorage("mailReaderLayout") private var readerLayout = "right"
    @AppStorage("mailSidebarVisible") private var sidebarVisible = true
    @State private var previousSidebarVisible = true
    @State private var expandedReader = false
    @State private var assistantDraft: Draft?
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
                            if model.combined {
                                VStack(spacing: 16) {
                                    EmptyPane(title: "Choose an account for AI Studio", detail: "Each mailbox has its own AI context, skills, and activity.", symbol: "envelope.badge.shield.half.filled")
                                    ForEach(model.accounts) { account in Button(account["email"].string) { model.perform { try await model.selectAccount(account.id) } } }
                                }.padding(30)
                            } else { StudioView().id(model.account) }
                        }
                        else if model.section == "calendar" { NativeCalendarView() }
                        else {
                            VStack(spacing: 0) {
                              NativeMailSearch().id(model.account + ":" + model.section)
                              readingPanes
                            }
                        }
                    }
                }
                    ActivityStatusView(value: model.activity, error: model.activityError, onOpenSettings: { model.settings("mail") }).padding(.horizontal, 12).padding(.vertical, 5).background(.bar)
                    if !model.error.isEmpty { statusBar(model.error, error: true) }
                    else if !model.notice.isEmpty { statusBar(model.notice, error: false) }
                    else if model.busy { HStack { ProgressView().controlSize(.small); Text("Working…").foregroundStyle(.secondary); Spacer() }.padding(9).background(.bar) }
              }
            }
        }
        .task(id: model.mailQueryKey) { if model.hasMailbox { await model.refreshMailPage() } }
        .task(id: (model.selectedMessage ?? "") + model.state["revision"].string) { await model.loadMessage() }
        .onChange(of: model.section) { section in if section != "studio" { model.selectedMessage = nil; model.messageDetail = .null }; model.mailPage = .null }
        .onChange(of: readerLayout) { _ in leaveExpandedReader() }
        .onChange(of: model.selectedMessage) { selection in if selection == nil { leaveExpandedReader() } }
        .sheet(item: $model.compose) { draft in ComposeView(initial: draft).environmentObject(model) }
        .sheet(item: $model.organizing) { message in OrganizeMailView(message: message).environmentObject(model) }
        .sheet(item: $model.readerAssistant, onDismiss: {
            if let draft = assistantDraft { assistantDraft = nil; model.newDraft(draft) }
        }) { request in
            ReaderAssistanceView(request: request) { draft in assistantDraft = draft }.environmentObject(model)
        }
        .sheet(isPresented: $model.showSettings) { NativeSettingsView().environmentObject(model) }
    }
    private var readingPanes: some View {
        // Keep the reader in the same container when layouts change, including its AI task state.
        HSplitView {
            if layout == "right" || (layout == "focus" && model.current == nil) {
                messageList.frame(minWidth: 260, idealWidth: 320)
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
            List(selection: Binding(get: { mailFolders.contains(model.section) ? model.account + "\n" + model.section : model.section }, set: { value in
                guard model.canNavigate else { return }
                let parts = value.components(separatedBy: "\n")
                if parts.count == 2 {
                    if parts[0] == model.account { model.section = parts[1] }
                    else { model.perform { try await model.selectAccount(parts[0], folder: parts[1]) } }
                } else { model.section = value }
            })) {
                Section("Workspace") {
                    Label("Today", systemImage: "sun.max").tag("today").accessibilityIdentifier("workspace.today")
                    Label("AI Studio", systemImage: "sparkles").tag("studio")
                    Label("Calendar", systemImage: "calendar").tag("calendar")
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
            Button { model.settings() } label: { Label("Settings & connections", systemImage: "gearshape") }
                .buttonStyle(.plain).disabled(model.busy).frame(maxWidth: .infinity, alignment: .leading).padding(18).fixedSize(horizontal: false, vertical: true)
        }
    }
    private var composeButton: some View {
        Button { model.newDraft() } label: { Label("Compose", systemImage: "square.and.pencil").frame(maxWidth: sidebarVisible ? .infinity : nil) }
            .disabled(model.busy || !model.hasMailbox).help("New message (⌘N)")
    }
    func accountGroup(_ account: String, title: String, subtitle: String, symbol: String) -> some View {
        let collapsed = Set((try? JSONDecoder().decode([String].self, from: Data(collapsedAccounts.utf8))) ?? [])
        return DisclosureGroup(isExpanded: Binding(get: { !collapsed.contains(account) }, set: { expanded in
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
    func folderRows(_ account: String) -> some View {
        ForEach(mailFolders, id: \.self) { folder in
            HStack {
                Label(folder.capitalized, systemImage: ["inbox": "tray", "starred": "star", "sent": "paperplane", "drafts": "doc", "archive": "archivebox", "spam": "exclamationmark.shield", "trash": "trash"][folder]!)
                Spacer()
                let count = folderCount(account, folder)
                if count > 0 && ["inbox", "drafts"].contains(folder) { Text("\(count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
            }.tag(account + "\n" + folder).accessibilityIdentifier("mailbox.\(account).\(folder)")
        }
    }
    func folderCount(_ account: String, _ folder: String) -> Int {
        return model.accounts.filter { account == "all" || $0.id == account }.reduce(0) { $0 + Int(folder == "inbox" ? $1["unread"].number : $1["counts"][folder].number) }
    }
    var messageList: some View {
        VStack(spacing: 0) {
            HStack { VStack(alignment: .leading, spacing: 3) { Text(model.section.capitalized).font(.headline); Text(model.combined ? "All accounts" : model.account).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle) }; Spacer(); Toggle(isOn: $model.unreadOnly) { Image(systemName: "line.3.horizontal.decrease.circle") }.toggleStyle(.button).controlSize(.small).help("Show unread only").accessibilityLabel("Show unread only").disabled(!model.searchResponse.isNull) }.padding(.horizontal, 14).padding(.vertical, 10)
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
                            Circle().fill(message["read"].bool ? .clear : morrowGreen).frame(width: 6, height: 6).accessibilityLabel(message["read"].bool ? "Read" : "Unread")
                        }
                        searchHighlighted(message["searchSubject"], fallback: message["subject"].nonempty ? message["subject"].string : "(No subject)").font(.system(size: 13)).fontWeight(message["read"].bool ? .regular : .bold).lineLimit(1)
                        if model.preferences["density"].string != "compact" { searchHighlighted(message["searchSnippet"], fallback: message["preview"].string).fontWeight(message["read"].bool ? .regular : .bold).foregroundStyle(.secondary).font(.caption).lineLimit(model.preferences["density"].string == "spacious" ? 4 : 2) }
                        if model.combined || !model.searchResponse.isNull { Text(message["accountId"].string).font(.caption2).foregroundStyle(morrowGreen).lineLimit(1) }
                        if message["searchMatch"].nonempty { Text(message["folder"].string + " · " + message["searchMatch"].string).font(.caption2).foregroundStyle(.secondary) }
                        Text(dateLabel(message["date"].string)).font(.caption2).foregroundStyle(.tertiary)
                        if message["deliveryStatus"].string == "unconfirmed" { Label("Check delivery", systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
                    }.fontWeight(message["read"].bool ? .regular : .bold).padding(.vertical, model.preferences["density"].string == "compact" ? 3 : model.preferences["density"].string == "spacious" ? 14 : 8).tag(message.viewID)
                    .contextMenu {
                        if model.canOrganize(message) { Button("Move / Labels / Spam on Provider…") { model.organizing = message } }
                        Button(message["starred"].bool ? "Unstar" : "Star") { model.patch(message, .object(["starred": .bool(!message["starred"].bool)])) }
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
                if message["folder"].string == "drafts" { Button(message["providerDraft"].bool ? "Copy to Local Draft" : "Edit Draft") { model.newDraft(Draft(message: message)) } }
                else {
                    Button { model.newDraft(Draft(message: message, reply: true)) } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") }.labelStyle(.iconOnly).help("Reply")
                    Button { model.newDraft(Draft(message: message, replyAll: true)) } label: { Label("Reply All", systemImage: "arrowshape.turn.up.left.2") }.labelStyle(.iconOnly).help("Reply All")
                    Button { model.newDraft(Draft(forwarding: message)) } label: { Label("Forward", systemImage: "arrowshape.turn.up.right") }.labelStyle(.iconOnly).help("Forward")
                }
                Spacer()
                if model.canOrganize(message) { Button { model.organizing = message } label: { Label("Move / Labels / Spam", systemImage: "folder") }.labelStyle(.iconOnly).help("Move, label, or move to Spam on this mailbox’s provider") }
                Button { model.patch(message, .object(["starred": .bool(!message["starred"].bool)])) } label: { Image(systemName: message["starred"].bool ? "star.fill" : "star") }.help("Toggle star").accessibilityLabel("Toggle star")
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
                HStack { ProgressView().controlSize(.small); Text("Generating…"); Spacer(); Button("Cancel") { stop(); localError = "Stopped waiting. The model may already be processing; no retry was started." } }
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
                            guard current, !loading, !model.busy else { return }
                            var draft = Draft(message: message, reply: true)
                            draft.body = result["text"].string
                            useDraft(draft); dismiss()
                        }.buttonStyle(.borderedProminent).disabled(model.busy)
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
            Text("Move / Labels / Spam on Provider").font(.title2.bold())
            Text(message["subject"].string).lineLimit(2)
            Text(message["accountId"].string).foregroundStyle(.secondary)
            if loading { ProgressView("Loading folders…") }
            else {
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
                Text("This changes the message on your mail provider. Moves stay within this account. Gmail labels are shown on downloaded mail. Archive contains mail without Inbox, Sent, Draft, Spam or Trash labels.").font(.callout).foregroundStyle(.secondary)
                if provider == "google" { Text("Move adds the selected label and removes Inbox; other labels remain. Add / Remove label keeps the current Inbox status.").font(.caption).foregroundStyle(.secondary) }
                Text("Choose Spam / Junk in the destination list, then Review Change to move the message. Morrow does not directly report abuse or block senders; use the same account on your provider for those actions.").font(.caption).foregroundStyle(.secondary)
                if provider == "google" { Link("Open Gmail to report or block", destination: URL(string: "https://mail.google.com/")!) }
                else if provider == "microsoft" { Link("Open Outlook to report or block", destination: URL(string: "https://outlook.live.com/mail/")!) }
            }
            if !localError.isEmpty { Text(localError).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(model.busy)
                Spacer()
                Button("Review Change") { review = true }.buttonStyle(.borderedProminent).disabled(loading || model.busy || destination.isEmpty)
            }
        }.padding(26).frame(width: 530).interactiveDismissDisabled(model.busy)
        .task {
            do {
                let result = try await model.request("/mail/folders", mailbox: message["accountId"].string)
                folders = result["folders"].array; provider = result["provider"].string
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
    init(initial: Draft) { self.initial = initial; _draft = State(initialValue: initial); _saved = State(initialValue: initial.payload) }
    var dirty: Bool { draft.payload != saved || (draft.savedID.isEmpty && (!draft.to.isEmpty || !draft.cc.isEmpty || !draft.bcc.isEmpty || !draft.subject.isEmpty || !draft.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)) }
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
                }.disabled(model.busy)
                .onChange(of: draft.accountID) { _ in aiResult = ""; draft.requestID = UUID().uuidString }
            }
            if draft.sourceDraft { Text("Editing a local copy without attachments. The original Gmail draft stays in Gmail; changes here are not uploaded to it.").font(.caption).foregroundStyle(.secondary) }
            if draft.forwarding { Text("Forwarding the message text. Attachments are not included.").font(.caption).foregroundStyle(.secondary) }
            if !draft.replyToID.isEmpty { Label("Replying from the mailbox that owns this conversation", systemImage: "lock.fill").font(.caption).foregroundStyle(.secondary) }
            if !initial.replyToID.isEmpty && initial.savedID.isEmpty && initial.body.isEmpty && !draft.unconfirmed {
                AutomaticAssistance(messageID: initial.replyToID, account: initial.accountID, trigger: "onReply") { text in
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
            }.textFieldStyle(.roundedBorder).disabled(model.busy || draft.unconfirmed)
            if draft.footer["text"].nonempty || draft.footer["html"].nonempty {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Label("Email footer", systemImage: "signature").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button("Remove") { draft.footer = .object(["text": .string(""), "html": .string("")]) }.buttonStyle(.borderless).disabled(model.busy || draft.unconfirmed)
                    }
                    FooterPreview(footer: draft.footer)
                }.padding(12).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
            }
            if !draft.unconfirmed {
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
            if !localError.isEmpty { Text(localError).foregroundStyle(.red).font(.callout).textSelection(.enabled) }
           }.padding(24)
          }
          Divider()
            HStack {
                Button(draft.unconfirmed ? "Close" : "Cancel") { close() }.keyboardShortcut(.cancelAction).disabled(model.busy)
                Spacer()
                if model.busy { ProgressView().controlSize(.small) }
                Button("Save Draft") { save() }.keyboardShortcut("s").disabled(model.busy || draft.unconfirmed)
                Button(draft.unconfirmed ? "Review Retry" : "Review & Send") { confirmSend = true }
                    .keyboardShortcut("d", modifiers: [.command, .shift]).buttonStyle(.borderedProminent).disabled(model.busy || [draft.to, draft.cc, draft.bcc].allSatisfy { $0.trimmingCharacters(in: .whitespaces).isEmpty } || draft.body.isEmpty || (draft.unconfirmed && !reviewed))
            }.padding(20)
        }.frame(width: 690, height: min(780, (NSScreen.main?.visibleFrame.height ?? 900) - 100))
        .interactiveDismissDisabled(dirty || model.busy)
        .onAppear { model.dirty("compose", dirty) }
        .onChange(of: draft) { _ in model.dirty("compose", dirty) }
        .onDisappear { model.dirty("compose", false) }
        .confirmationDialog(draft.accountID == "demo" ? "Simulate sending this message?" : "Send this message to the listed recipients?", isPresented: $confirmSend, titleVisibility: .visible) {
            Button(draft.accountID == "demo" ? "Simulate Send" : "Send Message") { send() }
            Button("Cancel", role: .cancel) {}
        } message: { Text("From: \(draft.accountID)\nTo: \(draft.to)\nCc: \(draft.cc)\nBcc: \(draft.bcc)\nSubject: \(draft.subject.isEmpty ? "(No subject)" : draft.subject)\n\(draft.unconfirmed ? "This retry may create a duplicate." : "The message and displayed footer will be sent together.")") }
    }
    func recipientField(_ label: String, text: Binding<String>, placeholder: String) -> some View {
        HStack {
            Text(label).frame(width: 36, alignment: .leading).foregroundStyle(.secondary)
            TextField(placeholder, text: text).accessibilityLabel(label)
        }
    }
    func close() { if !dirty || draft.unconfirmed || model.confirmDiscard("Discard this draft’s unsaved changes?") { dismiss() } }
    func save() {
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
    func assist(_ action: String) {
        let payload = JSON.object(["action": .string(action), "prompt": .string(aiPrompt), "draftText": .string(draft.body)])
        model.perform {
            do { let result = try await model.request("/ai", method: "POST", body: payload, mailbox: draft.accountID); aiResult = result["text"].string; aiSource = result["source"].string }
            catch { localError = error.localizedDescription }
        }
    }
}
