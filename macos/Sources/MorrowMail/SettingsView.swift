import SwiftUI
import AppKit

struct NativeSettingsView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    @State private var values: JSON = .null
    @State private var baseline: JSON = .null
    @State private var preferenceTask: Task<Void, Never>?
    @State private var preferenceSaving = false
    @State private var preferenceError = ""
    @State private var visible = false
    @State private var mailSnapshot: JSON = .null
    @State private var mailStatusVersion = 0
    @State private var importRefreshError = ""
    @State private var searchDirty = false
    @State private var searchRequestBusy = false
    @State private var learningDirty = false
    @State private var importSettings: JSON = .object(["months": .number(3), "inbox": .bool(true), "sent": .bool(true), "allMail": .bool(true)])
    @State private var provider = "google"
    @State private var mailOAuth: JSON = .object([:])
    @State private var calendarOAuth: JSON = .object([:])
    @State private var localError = ""
    @State private var status = ""
    @State private var footerPreview: JSON = .null
    @State private var downloadState: JSON = .null
    @State private var modelSection = "chat"
    @State private var mailEditor = false
    private let tabs = [("general", "General", "slider.horizontal.3"), ("mail", "Mail", "envelope"), ("calendar", "Calendar", "calendar"), ("model", "Model", "cpu"), ("permissions", "AI Permissions", "checkmark.shield"), ("search", "Search", "magnifyingglass"), ("learning", "Learning", "text.badge.star"), ("about", "About", "info.circle")]
    private let generalKeys = ["displayName", "signature", "signatureFormat", "theme", "density", "replyTone", "language", "translationLanguage", "syncInterval", "markReadOnOpen"]
    private var displayedAccounts: [JSON] { mailSnapshot.isNull ? model.accounts : mailSnapshot.array }
    var dirty: Bool { searchDirty || learningDirty || values != baseline || mailOAuth.object.values.contains { $0.object.values.contains(where: \.nonempty) } || calendarOAuth.object.values.contains { $0.object.values.contains(where: \.nonempty) } }
    var body: some View {
        VStack(spacing: 0) {
            HStack { Text("Settings").font(.title2.bold()); Spacer(); if dirty { Text("Unsaved changes").font(.caption).foregroundStyle(.secondary) }; Button("Done") { close() }.keyboardShortcut(.cancelAction).disabled(model.busy || searchRequestBusy || preferenceSaving) }.padding(22)
            Divider()
            HStack(spacing: 0) {
                List(tabs, id: \.0, selection: Binding(get: { model.settingsTab }, set: { next in
                    selectTab(next)
                })) { tab in Label(tab.1, systemImage: tab.2).tag(tab.0) }.listStyle(.sidebar).frame(width: 165)
                ScrollViewReader { scroll in
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        Color.clear.frame(height: 0).id("settings-top")
                        switch model.settingsTab {
                        case "mail": mailPage
                        case "learning": StyleLearningView(dirty: $learningDirty, onOpenSettings: { next in if next == "model" { modelSection = "chat" }; selectTab(next) })
                        case "search": NativeSearchSettingsView(dirty: $searchDirty, operationBusy: $searchRequestBusy, onConfigureModel: { modelSection = "embedding"; selectTab("model") }, onConfigurePermissions: { selectTab("permissions") })
                        case "model":
                            Picker("Model purpose", selection: $modelSection) {
                                Text("Chat & replies").tag("chat")
                                Text("Search embedding").tag("embedding")
                            }.pickerStyle(.segmented).disabled(searchRequestBusy)
                            if modelSection == "chat" { modelPage.disabled(searchRequestBusy) }
                            NativeSearchSettingsView(dirty: $searchDirty, operationBusy: $searchRequestBusy, presentation: .model, active: modelSection == "embedding")
                                .frame(height: modelSection == "embedding" ? nil : 0)
                                .clipped().opacity(modelSection == "embedding" ? 1 : 0)
                                .allowsHitTesting(modelSection == "embedding").accessibilityHidden(modelSection != "embedding")
                        case "permissions": permissionsPage
                        case "calendar": calendarPage
                        case "about": aboutPage
                        default: generalPage
                        }
                    }.padding(28).frame(maxWidth: .infinity, alignment: .leading).disabled(model.busy || (preferenceSaving && model.settingsTab != "general"))
                }.onChange(of: model.settingsTab) { _ in scroll.scrollTo("settings-top", anchor: .top) }
                 .onChange(of: mailEditor) { expanded in if expanded { scroll.scrollTo("mail-connect", anchor: .top) } }
                }
            }
            Divider()
            HStack {
                if model.busy { ProgressView().controlSize(.small) }
                Text(localError.isEmpty ? status : localError).foregroundStyle(localError.isEmpty ? Color.secondary : Color.red).font(.callout).textSelection(.enabled)
                Spacer()
                if model.settingsTab == "general" { preferenceStatus }
                if model.settingsTab == "permissions" && values["policy"] != baseline["policy"] {
                    Button("Discard Changes") { values["policy"] = baseline["policy"] }.disabled(values["policy"] == baseline["policy"] || model.busy || preferenceSaving)
                    Button("Save Permissions") { save("policy") }.buttonStyle(.borderedProminent).disabled(values["policy"] == baseline["policy"] || model.busy || preferenceSaving)
                }
            }.padding(14).frame(minHeight: 45)
        }.frame(minWidth: 820, idealWidth: 980, maxWidth: 1200,
                minHeight: min(580, (NSScreen.main?.visibleFrame.height ?? 850) - 100),
                idealHeight: min(760, (NSScreen.main?.visibleFrame.height ?? 850) - 100),
                maxHeight: (NSScreen.main?.visibleFrame.height ?? 850) - 100)
        .textFieldStyle(.roundedBorder)
        .interactiveDismissDisabled(dirty || model.busy || searchRequestBusy || preferenceSaving)
        .onAppear { initialize(); visible = true }
        .onChange(of: searchDirty) { _ in model.dirty("settings", dirty) }
        .onChange(of: searchRequestBusy) { _ in model.dirty("search-request", searchRequestBusy) }
        .onChange(of: learningDirty) { _ in model.dirty("settings", dirty) }
        .onChange(of: values) { _ in model.dirty("settings", dirty) }
        .onChange(of: values["preferences"]) { _ in preferenceError = ""; schedulePreferences() }
        .onChange(of: model.busy) { _ in schedulePreferences() }
        .onChange(of: searchRequestBusy) { _ in schedulePreferences() }
        .onChange(of: model.state) { _ in mailStatusVersion += 1; mailSnapshot = .null }
        .onChange(of: mailOAuth) { _ in model.dirty("settings", dirty) }
        .onChange(of: calendarOAuth) { _ in model.dirty("settings", dirty) }
        .onDisappear { visible = false; preferenceTask?.cancel(); model.dirty("settings", false); model.dirty("search-request", false) }
        .task(id: model.settingsTab) {
            let tab = model.settingsTab
            guard ["about", "mail"].contains(tab) else { return }
            while !Task.isCancelled {
                if tab == "about" {
                    if let result = try? await model.request("/updates/status") { downloadState = result }
                } else if NSApp?.isActive == true && !model.busy && !preferenceSaving {
                    await refreshImportProgress()
                }
                do { try await Task.sleep(nanoseconds: tab == "mail" ? 3_000_000_000 : 1_500_000_000) } catch { return }
            }
        }
    }
    private func selectTab(_ next: String) {
        if searchRequestBusy || model.busy || preferenceSaving { return }
        if (learningDirty || searchDirty) && !model.confirmDiscard("Discard unsaved learning, search or embedding settings?") { return }
        model.settingsTab = next
    }
    func initialize() {
        var next = model.state["settings"]
        next["ai"] = next["ai"].picking(["baseUrl", "model", "temperature", "maxTokens"])
        next["ai"]["apiKey"] = .string(""); next["ai"]["clearApiKey"] = .bool(false)
        next["mail"] = .object(["email": .string(""), "imapHost": .string(""), "imapPort": .number(993), "smtpHost": .string(""), "smtpPort": .number(465)])
        next["mail"]["password"] = .string("")
        values = next; baseline = next
        mailEditor = model.accounts.isEmpty
        provider = model.state["settings"]["mail"]["provider"].string == "imap" ? "imap" : "google"
    }
    func string(_ group: String, _ key: String) -> Binding<String> {
        Binding(get: { values[group][key].string }, set: { values[group][key] = .string($0) })
    }
    func boolean(_ group: String, _ key: String) -> Binding<Bool> {
        Binding(get: { values[group][key].bool }, set: { values[group][key] = .bool($0) })
    }
    func number(_ group: String, _ key: String) -> Binding<Int> {
        Binding(get: { Int(values[group][key].number) }, set: { values[group][key] = .number(Double($0)) })
    }
    func nestedBool(_ group: String, _ key: String) -> Binding<Bool> {
        Binding(get: { values["policy"][group][key].bool }, set: { values["policy"][group][key] = .bool($0) })
    }
    func field(_ title: String, _ group: String, _ key: String, secure: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline)
            if secure { SecureField(title, text: string(group, key)) } else { TextField(title, text: string(group, key)) }
        }
    }
    var generalPage: some View {
        Group {
            SectionHeading(title: "Make yourself at home", detail: "Choose how Morrow looks, writes, and keeps your inbox up to date.")
            GroupBox("Appearance & reading") { VStack(alignment: .leading, spacing: 12) {
            HStack {
                Picker("Appearance", selection: string("preferences", "theme")) { Text("System").tag("system"); Text("Light").tag("light"); Text("Dark").tag("dark") }
                Picker("Density", selection: string("preferences", "density")) { Text("Comfortable").tag("comfortable"); Text("Compact").tag("compact"); Text("Spacious").tag("spacious") }
            }
            Toggle("Mark messages read when opened", isOn: boolean("preferences", "markReadOnOpen")).toggleStyle(.checkbox)
            }.padding(8) }
            GroupBox("Mail sync") { VStack(alignment: .leading, spacing: 8) {
            Picker("Sync all accounts while Morrow is open", selection: number("preferences", "syncInterval")) { Text("Manually").tag(0); ForEach([1, 5, 15, 30], id: \.self) { Text("Every \($0) minutes").tag($0) } }
                Text("Runs while Morrow is open. Automatic AI actions are controlled separately in AI Permissions.").font(.caption).foregroundStyle(.secondary)
            }.padding(8) }
            Text("Writing & language").font(.title3.bold())
            Text("Display name and footer apply across all connected accounts. Learning identity remains account-specific.").font(.caption).foregroundStyle(.secondary)
            field("Display name", "preferences", "displayName")
            GroupBox("Email footer") {
                VStack(alignment: .leading, spacing: 12) {
                    Picker("Format", selection: string("preferences", "signatureFormat")) { Text("Plain text").tag("plain"); Text("HTML").tag("html") }
                    TextArea(title: values["preferences"]["signatureFormat"].string == "html" ? "HTML source" : "Signature", text: string("preferences", "signature"), height: 95)
                    Text("Added to new messages and replies across your accounts. Saved drafts keep their existing footer. HTML supports text styles, tables and links; images and active content are removed.").font(.caption).foregroundStyle(.secondary)
                    Button("Preview Footer") {
                        run {
                            let result = try await model.request("/signature/preview", method: "POST", body: values["preferences"].picking(["signature", "signatureFormat"]))
                            footerPreview = result["footer"]
                        }
                    }.disabled(preferenceSaving)
                    if !footerPreview.isNull { FooterPreview(footer: footerPreview) }
                }.padding(8)
                .onChange(of: values["preferences"]["signature"]) { _ in footerPreview = .null }
                .onChange(of: values["preferences"]["signatureFormat"]) { _ in footerPreview = .null }
            }
            Picker("Reply tone", selection: string("preferences", "replyTone")) { ForEach(["friendly", "professional", "concise", "warm"], id: \.self) { Text($0.capitalized).tag($0) } }
            field("Preferred AI response language", "preferences", "language")
            field("Target translation language (blank uses preferred language)", "preferences", "translationLanguage")
            Text("These control AI output, not the app’s interface language.").font(.caption).foregroundStyle(.secondary)


        }
    }
    var preferenceStatus: some View {
        VStack(alignment: .trailing, spacing: 4) {
            HStack {
                if preferenceSaving { ProgressView().controlSize(.small) }
                Text(preferenceSaving ? "Saving preferences…" : !preferenceError.isEmpty ? "Changes not saved" : preferencePatch().object.isEmpty ? "Preferences saved automatically" : "Waiting to save…").font(.callout).foregroundStyle(.secondary)
                if !preferenceError.isEmpty { Button("Retry Saving") { Task { await savePreferences() } }.disabled(preferenceSaving) }
            }
            if !preferenceError.isEmpty { Text(preferenceError).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
        }
    }
    var modelPage: some View {
        Group {
            SectionHeading(title: "Chat & reply model", detail: "Used for summaries, replies, translation and learning. Search embedding has its own connection.")
            field("API base URL", "ai", "baseUrl")
            Text("Include /v1 when your provider requires it. Remote endpoints require HTTPS.").font(.caption).foregroundStyle(.secondary)
            field("Model ID", "ai", "model")
            field("API key (optional for local models)", "ai", "apiKey", secure: true)
            Text(model.state["settings"]["ai"]["hasApiKey"].bool ? "Leave blank to keep the saved key at the same base URL." : "No key is stored.").font(.caption).foregroundStyle(.secondary)
            Toggle("Remove saved API key", isOn: boolean("ai", "clearApiKey")).toggleStyle(.checkbox)
            DisclosureGroup("Advanced: response settings") { VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Temperature")
                Slider(value: Binding(get: { values["ai"]["temperature"].number }, set: { values["ai"]["temperature"] = .number($0) }), in: 0...2, step: 0.1)
                Text(values["ai"]["temperature"].number, format: .number.precision(.fractionLength(1))).monospacedDigit().frame(width: 35)
            }
            Stepper("Maximum response tokens: \(Int(values["ai"]["maxTokens"].number))", value: number("ai", "maxTokens"), in: 128...4096, step: 128)
            }.padding(.top, 8) }
            Text("Test connection sends a fixed prompt without mail content. It does not save your settings.").font(.callout).foregroundStyle(.secondary)
            HStack {
                Button("Test Chat Connection") {
                    run {
                        let result = try await model.request("/settings/ai/test", method: "POST", body: values["ai"])
                        status = result["text"].string
                    }
                }
                Button("Save Chat Model") { save("ai") }.buttonStyle(.borderedProminent)
            }
        }
    }
    var permissionsPage: some View {
        Group {
            SectionHeading(title: "Your assistant. Your boundaries.", detail: "These controls are enforced for every AI action and simulation. Manual mail and live calendar actions remain available.")
            Toggle("Enable AI assistance", isOn: boolean("policy", "enabled")).font(.headline).toggleStyle(.checkbox)
            GroupBox("When assistance starts") {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle("Summarize when I open a message", isOn: nestedBool("triggers", "onOpen")).toggleStyle(.checkbox)
                    Toggle("Suggest text when I start a reply", isOn: nestedBool("triggers", "onReply")).toggleStyle(.checkbox)
                    Toggle("Summarize newly synced messages", isOn: nestedBool("triggers", "onArrival")).toggleStyle(.checkbox)
                    Toggle("Generate scheduled inbox summaries", isOn: nestedBool("triggers", "scheduledSummary")).toggleStyle(.checkbox)
                    Toggle("Only messages in Inbox", isOn: nestedBool("triggers", "inboxOnly")).toggleStyle(.checkbox)
                    Toggle("Only starred messages", isOn: nestedBool("triggers", "starredOnly")).toggleStyle(.checkbox)
                    Text("All triggers default to off. Checked filters must all match, for each connected account separately. Drafts and Trash are excluded. Your model may charge per request. Suggestions never send, create events or replace drafts automatically.").font(.caption).foregroundStyle(.secondary)
                    Text("New-mail summaries start after sync discovers a new message; initial account imports are excluded. Enable automatic sync in General for regular checks. This is polling, not instant provider push.").font(.caption).foregroundStyle(.secondary)
                }.padding(8)
            }
            if values["policy"]["triggers"]["scheduledSummary"].bool { summarySchedule }
            DisclosureGroup("Available AI features") { VStack(alignment: .leading, spacing: 12) {
            ForEach(model.features.filter { !$0["mock"].bool || $0.id == "memory" }) { feature in
                VStack(alignment: .leading, spacing: 4) {
                    Toggle(feature["label"].string, isOn: nestedBool("behaviors", feature.id)).toggleStyle(.checkbox)
                    Text(feature.id == "memory" ? "Suggest memories with source references, review what to save, and use permitted saved context." : feature["description"].string).font(.caption).foregroundStyle(.secondary).padding(.leading, 20)
                }
            }
            }.padding(.top, 8) }
            DisclosureGroup("Local simulations") { VStack(alignment: .leading, spacing: 8) {
                ForEach(model.features.filter { $0["mock"].bool && $0.id != "memory" }) { feature in
                    Toggle(feature["label"].string + " · Simulation", isOn: nestedBool("behaviors", feature.id)).toggleStyle(.checkbox)
                    Text(feature["description"].string).font(.caption).foregroundStyle(.secondary)
                }
            }.padding(.top, 8) }
            GroupBox("Allowed data") { VStack(alignment: .leading, spacing: 12) {
            Text("Which folders it can use").font(.headline)
            ForEach(permissionFolders, id: \.self) { folder in Toggle(folder.capitalized, isOn: nestedBool("folders", folder)).toggleStyle(.checkbox) }
            Divider()
            Text("Which information it can see").font(.title3.bold())
            ForEach([("subject", "Subject lines"), ("body", "Message bodies"), ("sender", "Senders and recipients"), ("contacts", "Local contact notes"), ("calendar", "Simulated calendar context"), ("attachments", "Sample attachment fixtures")], id: \.0) { item in Toggle(item.1, isOn: nestedBool("content", item.0)).toggleStyle(.checkbox) }
            Stepper("Maximum messages per request: \(Int(values["policy"]["maxMessages"].number))", value: number("policy", "maxMessages"), in: 1...50)
            Text("Calendar and attachment scopes here control simulations. AI never reads your connected Google or Outlook calendar.").font(.caption).foregroundStyle(.secondary)
            }.padding(8) }
            Text("Changes take effect only after Save Permissions. These settings apply across your accounts; message context stays account-specific.").font(.caption).foregroundStyle(.secondary)
        }
    }
    var summarySchedule: some View {
        GroupBox("Summary schedule · P0–P4") {
            VStack(alignment: .leading, spacing: 12) {
                Picker("Repeat", selection: Binding(get: { values["policy"]["summarySchedule"]["cadence"].string }, set: { values["policy"]["summarySchedule"]["cadence"] = .string($0) })) {
                    Text("Daily at a set time").tag("daily"); Text("Every few hours").tag("interval")
                }
                if values["policy"]["summarySchedule"]["cadence"].string == "daily" {
                    TextField("Time (24-hour HH:mm)", text: Binding(get: { values["policy"]["summarySchedule"]["time"].string }, set: { values["policy"]["summarySchedule"]["time"] = .string($0) }))
                    TextField("Time zone, e.g. Asia/Hong_Kong", text: Binding(get: { values["policy"]["summarySchedule"]["timeZone"].string }, set: { values["policy"]["summarySchedule"]["timeZone"] = .string($0) }))
                } else {
                    Stepper("Every \(Int(values["policy"]["summarySchedule"]["everyHours"].number)) hours", value: Binding(get: { Int(values["policy"]["summarySchedule"]["everyHours"].number) }, set: { values["policy"]["summarySchedule"]["everyHours"] = .number(Double($0)) }), in: 1...168)
                }
                Text("Runs while Morrow is open, using up to your maximum permitted messages from the cached inbox. Results appear in AI Studio → Summaries. Missed daily runs catch up once when reopened; interval timing starts when enabled. Failed or interrupted jobs are not retried automatically.").font(.caption).foregroundStyle(.secondary)
                Text("P0 emergency · P1 due today · P2 action/follow-up · P3 information · P4 bulk/promotional. AI priorities need your review. Email Brain and writing style still require explicit review and saving.").font(.caption).foregroundStyle(.secondary)
            }.padding(8)
        }
    }
    var mailPage: some View {
        Group {
            SectionHeading(title: "Bring your inbox along", detail: "Connect multiple Gmail, Outlook, or IMAP accounts. Sync checks recent mail in bounded batches. History imports fill the chosen range while Morrow is open, without AI calls.")
            DisclosureGroup(isExpanded: $mailEditor) {
                mailConnectionForm.padding(.top, 12)
            } label: { Label("Add or reconnect an account", systemImage: "plus.circle.fill").font(.headline) }.id("mail-connect")
            DisclosureGroup("New import range: \(importSettings["months"].number == 0 ? "All history" : "Last \(Int(importSettings["months"].number)) months") · \(importSettings["allMail"].bool ? "All normal folders" : "Selected folders")") { historyOptions.padding(.top, 8) }
            if !displayedAccounts.isEmpty {
                HStack { Text("Connected accounts").font(.headline); Spacer(); Button("Combined Inbox") { run { try await model.selectAccount("all", folder: "inbox") } } }
            }
            ForEach(displayedAccounts) { account in
                GroupBox {
                    VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        VStack(alignment: .leading) { Text(account["provider"].string.uppercased()).font(.caption).foregroundStyle(.secondary); Text(account["email"].string).font(.headline) }
                        Spacer()
                        Button("Use Mailbox") { run { try await model.selectAccount(account.id, folder: "inbox"); status = "Workspace changed." } }
                        if account["provider"].string == "imap" {
                            Button("Edit") {
                                if values["mail"] != baseline["mail"] && !model.confirmDiscard() { return }
                                provider = "imap"; values["mail"] = account["settings"].picking(["email", "imapHost", "imapPort", "smtpHost", "smtpPort"])
                                values["mail"]["password"] = .string(""); baseline["mail"] = values["mail"]; mailEditor = true
                            }
                        }
                        if account["provider"].string != "imap" {
                            Button("Reconnect") { provider = account["provider"].string; mailEditor = true }
                        }
                        Button("Disconnect") {
                            guard model.confirm("Disconnect \(account["email"].string)?", detail: "Only this account’s credentials will be removed. Cached mail and drafts remain on this Mac.") else { return }
                            run { model.state = try await model.request("/account/disconnect", method: "POST", body: .object([:]), mailbox: account.id); model.selectedMessage = nil; status = "Mailbox disconnected." }
                        }
                    }
                    if !account["import"].isNull {
                        Text(importProgress(account["import"])).font(.caption)
                        if account["import"]["error"].nonempty { Text(account["import"]["error"].string).font(.caption).foregroundStyle(.orange) }
                        if account["import"]["phase"].string == "retrying" && account["import"]["nextRetryAt"].nonempty { Text("Next retry: \(dateLabel(account["import"]["nextRetryAt"].string)). You can pause this import.").font(.caption) }
                        if account["import"]["recoveryAction"].string == "reconnect" { Text("Use Reconnect (or Edit for IMAP), then start a new import.").font(.caption) }
                        if account["import"]["recoveryAction"].string == "restart" { Text("Start a new import below to replace the unusable checkpoint. Downloaded mail is retained.").font(.caption) }
                    } else { Text("History import has not started.").font(.caption).foregroundStyle(.secondary) }
                    HStack {
                        if account["import"]["status"].string != "running" {
                            Button(account["import"].isNull ? "Start History Import…" : "Start New Import…") {
                                guard model.confirm("Import history for \(account["email"].string)?", detail: "Use the range and folders shown above. This starts a new checkpoint; cached mail is retained and no AI is called.") else { return }
                                importAction("start", account: account)
                            }.disabled(!canImport(account["provider"].string))
                        }
                        if let action = importControl(account["import"]) {
                            Button(action == "pause" ? "Pause" : "Resume from Checkpoint") { importAction(action, account: account) }
                        }
                    }
                    }.padding(6)
                }
            }

        }
    }
    var mailConnectionForm: some View {
        VStack(alignment: .leading, spacing: 16) {
            Picker("Provider", selection: $provider) { Text("Gmail").tag("google"); Text("Outlook").tag("microsoft"); Text("Yahoo / IMAP").tag("imap") }.pickerStyle(.segmented)
            if provider == "imap" {
                GroupBox("Yahoo Mail · including Hong Kong") {
                    VStack(alignment: .leading, spacing: 8) {
                        Button("Use Yahoo Mail / HK Settings") { values["mail"] = yahooMailSettings(values["mail"]) }
                        Text("Fills Yahoo’s secure servers and clears the entered password. Your email address stays unchanged, including @yahoo.com.hk.")
                        Text("Enter your full Yahoo email address and a Yahoo app password, not your normal sign-in password. This connection uses IMAP/SMTP, without browser OAuth.")
                        Link("How to Create a Yahoo App Password", destination: URL(string: "https://hk.help.yahoo.com/kb/SLN15241.html")!)
                    }.font(.caption).frame(maxWidth: .infinity, alignment: .leading).padding(6)
                }
                field("Email address", "mail", "email")
                field("App password", "mail", "password", secure: true)
                Text("A blank password keeps the existing one only when the email and both servers are unchanged.").font(.caption).foregroundStyle(.secondary)
                field("IMAP hostname", "mail", "imapHost")
                HStack { Text("IMAP TLS port"); TextField("993", value: number("mail", "imapPort"), format: .number.grouping(.never)).frame(width: 100) }
                field("SMTP hostname", "mail", "smtpHost")
                Picker("SMTP security", selection: number("mail", "smtpPort")) { Text("465 · TLS").tag(465); Text("587 · STARTTLS").tag(587) }
                Button("Connect & Sync") { save("mail") }.buttonStyle(.borderedProminent).disabled(!canImport("imap"))
            } else {
                oauthForm(provider, calendar: false)
            }
            Text("Read, star, archive, and trash shortcuts stay local. The Move / Labels dialog applies reviewed changes on the provider. Sending requires an explicit send or schedule review. Formatted mail uses a protected reader; attachments and CID images are not supported.").font(.caption).foregroundStyle(.secondary)
        }
    }
    var historyOptions: some View {
GroupBox("History for your next connection or import") {
                VStack(alignment: .leading, spacing: 12) {
                    ActivityStatusView(value: model.activity, error: model.activityError)
                    Picker("History range", selection: Binding(get: { Int(importSettings["months"].number) }, set: { importSettings["months"] = .number(Double($0)) })) {
                        Text("All history (no date limit)").tag(0)
                        ForEach([1, 3, 6, 12], id: \.self) { Text("Last \($0) month(s)").tag($0) }
                    }
                    Toggle("All normal folders (excluding Spam/Trash)", isOn: Binding(get: { importSettings["allMail"].bool }, set: { importSettings["allMail"] = .bool($0) })).toggleStyle(.checkbox)
                    if !importSettings["allMail"].bool {
                        Text("Import selected folders:").font(.caption).foregroundStyle(.secondary)
                        ForEach(["inbox", "sent"], id: \.self) { folder in Toggle(folder.capitalized, isOn: Binding(get: { importSettings[folder].bool }, set: { importSettings[folder] = .bool($0) })).toggleStyle(.checkbox) }
                    }
                    Text("Choose All normal folders or at least one folder. All history removes the date limit; choosing a shorter range keeps cached mail. Gmail and Outlook exclude Spam/Trash. IMAP skips folders identified by the provider as Junk or Trash, plus virtual and non-selectable folders. Style learning is a separate opt-in in Learning.").font(.caption).foregroundStyle(.secondary)
                    Button("Refresh Import Progress") { run { await refreshImportProgress() } }
                    if !importRefreshError.isEmpty { Text(importRefreshError).font(.caption).foregroundStyle(.orange) }
                }.padding(8)
            }
    }
    var calendarPage: some View {
        Group {
            SectionHeading(title: "A little space in your day", detail: "Connect one Google and one Outlook calendar account at the same time. Each account can show multiple calendars. Mail connections are separate.")
            ForEach(["google", "microsoft"], id: \.self) { id in
                GroupBox(providerLabel(id) + " Calendar") {
                    VStack(alignment: .leading, spacing: 16) {
                        let connection = model.state["settings"]["calendars"].array.first { $0["provider"].string == id } ?? .null
                        if connection["connected"].bool {
                            HStack {
                                Label(connection["email"].string, systemImage: "checkmark.circle.fill").foregroundStyle(morrowGreen)
                                Spacer()
                                Button("Disconnect") {
                                    guard model.confirm("Disconnect \(providerLabel(id)) Calendar?", detail: "Saved credentials will be removed. Existing events will not change.") else { return }
                                    run {
                                        _ = try await model.request("/calendars/\(id)/disconnect", method: "POST", body: .object(["connectionEmail": connection["email"]]))
                                        try await model.reload(); status = "Calendar disconnected."
                                    }
                                }
                            }
                        }
                        if connection["connected"].bool {
                            DisclosureGroup("Reconnect or change calendar account") { oauthForm(id, calendar: true).padding(.top, 8) }
                        } else { oauthForm(id, calendar: true) }
                    }.padding(12)
                }
            }
            Text("Calendar creates require your explicit review. Events have no attendees, and no invitations are sent. AI Studio’s scheduling tools remain local simulations.").font(.caption).foregroundStyle(.secondary)
        }
    }
    func oauthForm(_ id: String, calendar: Bool) -> some View {
        let credentials = Binding<JSON>(get: { calendar ? calendarOAuth[id] : mailOAuth[id] }, set: { if calendar { calendarOAuth[id] = $0 } else { mailOAuth[id] = $0 } })
        let clientID = Binding<String>(get: { credentials.wrappedValue["clientId"].string }, set: { credentials.wrappedValue["clientId"] = .string($0) })
        let secret = Binding<String>(get: { credentials.wrappedValue["clientSecret"].string }, set: { credentials.wrappedValue["clientSecret"] = .string($0) })
        let hasDefault = model.state["settings"]["oauthClients"][id]["configured"].bool
        let useDefault = hasDefault && !credentials.wrappedValue["useCustomClient"].bool
        let port = model.baseURL?.port ?? 3001
        let callback = "http://localhost:\(port)/api/\(calendar ? "calendar-oauth" : "oauth")/\(id)/callback"
        return VStack(alignment: .leading, spacing: 12) {
            Text("Sign in through your browser").font(.headline)
            Text(useDefault ? "\(id == "google" ? "Google" : "Microsoft") sign-in is ready. No client ID or secret is needed. Keep Morrow open while you approve access in your browser, then return here." : "Enter your OAuth app credentials below, then use the sign-in button. Keep Morrow open while you approve access in your browser, then return here.").font(.callout).foregroundStyle(.secondary)
            if !useDefault {
                Text(id == "google" ? "Register a Desktop app OAuth client in Google Cloud. Enable the \(calendar ? "Calendar" : "Gmail") API and add yourself as a test user." : "Register a Mobile and desktop application in Microsoft Entra. Enable public client flows; no client secret is needed.").font(.callout).foregroundStyle(.secondary)
                TextField("Application / client ID", text: clientID)
                if id == "google" { SecureField("Desktop client secret", text: secret) }
            }
            if !calendar {
                Toggle("Allow moving mail and managing labels", isOn: Binding(get: { credentials.wrappedValue["organize"].bool }, set: { credentials.wrappedValue["organize"] = .bool($0) })).toggleStyle(.checkbox)
                Text("Adds Gmail modify or Outlook Mail.ReadWrite permission. Reconnect an existing account to enable provider moves.").font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Button {
                    run {
                        let path = calendar ? "/calendars/\(id)/connect" : "/oauth/\(id)/start"
                        var body = credentials.wrappedValue.picking(useDefault ? ["organize"] : ["clientId", "clientSecret", "organize"])
                        if useDefault { body["useDefaultClient"] = .bool(true) }
                        if !calendar { body["importOptions"] = importOptions(for: id) }
                        let result = try await model.request(path, method: "POST", body: body)
                        try model.openOAuth(result, provider: id, calendar: calendar)
                        credentials.wrappedValue = .object([:]); status = "Browser opened. Complete sign-in, then return to Morrow to refresh your connections."
                    }
                } label: {
                    Label("Sign in with \(id == "google" ? "Google" : "Microsoft") in browser", systemImage: "arrow.up.right.square")
                }.buttonStyle(.borderedProminent).disabled((!calendar && !canImport(id)) || (!useDefault && (clientID.wrappedValue.trimmingCharacters(in: .whitespaces).isEmpty || (id == "google" && secret.wrappedValue.isEmpty))))
                Button("Refresh Status") { run { try await model.reload(); status = "Connection status refreshed." } }
            }
            Text(useDefault ? (id == "google" ? "If Google says access is restricted to test users, the publisher must add your account or complete app verification." : "Your organization may require administrator approval to connect.") : "The sign-in button becomes available after the required credentials are entered.").font(.caption).foregroundStyle(.secondary)
            DisclosureGroup("Advanced: callback URL for app registration") {
                VStack(alignment: .leading, spacing: 8) {
                    if hasDefault {
                        Toggle("Use my own \(id == "google" ? "Google" : "Microsoft") OAuth client", isOn: Binding(get: { credentials.wrappedValue["useCustomClient"].bool }, set: { credentials.wrappedValue["useCustomClient"] = .bool($0) })).toggleStyle(.checkbox)
                    }
                    Text(callback).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    Button("Copy Callback URL") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(callback, forType: .string); status = "Callback URL copied for app registration." }
                    Text("Do not open this URL to sign in. Your browser returns here automatically after authorization. Desktop loopback ports change each launch; Microsoft matches this localhost path independently of the port.").font(.caption).foregroundStyle(.secondary)
                }.padding(.top, 6)
            }
        }
    }
    var aboutPage: some View {
        Group {
            HStack(spacing: 16) {
                Image(nsImage: NSApplication.shared.applicationIconImage).resizable().frame(width: 70, height: 70)
                VStack(alignment: .leading) { Text("Morrow Mail").font(.largeTitle.bold()); Text("Version \(Bundle.main.object(forInfoDictionaryKey: "MorrowReleaseVersion") as? String ?? "development")").foregroundStyle(.secondary) }
            }
            GroupBox("App updates") {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle("Include alpha and beta releases", isOn: $model.includePrereleases).toggleStyle(.checkbox)
                        .disabled(model.checkingUpdates)
                    Button(model.checkingUpdates ? "Checking…" : "Check for Updates") {
                        Task { await model.checkForUpdates(force: true) }
                    }.disabled(model.checkingUpdates)
                    Text("Checks public GitHub releases at launch and every hour while Morrow is running, without sharing mail or credentials. A red ! badge on Settings means an update is available. Download and Install & Restart remain your choice.").font(.caption).foregroundStyle(.secondary)
                    if !model.updateCheckError.isEmpty { Text(model.updateCheckError).foregroundStyle(.red) }
                    if !model.updateResult.isNull {
                        Text(model.updateResult["updateAvailable"].bool ? "Update available: \(model.updateResult["latestVersion"].string)" : "You’re up to date for this channel.").font(.headline)
                        Text("Installed: \(model.updateResult["currentVersion"].string) · Latest: \(model.updateResult["latestVersion"].string)\nChecked: \(dateLabel(model.updateResult["checkedAt"].string))").font(.caption)
                        if let url = URL(string: model.updateResult["url"].string) { Link("View Release & Downloads", destination: url) }
                        if model.updateResult["updateAvailable"].bool && downloadState["supported"].bool && ["idle", "error"].contains(downloadState["phase"].string) {
                            Button("Download Update") { run { downloadState = try await model.request("/updates/download", method: "POST", body: .object(["includePrereleases": .bool(model.includePrereleases)])) } }
                        }
                    }
                    if ["checking", "downloading", "verifying"].contains(downloadState["phase"].string) {
                        ProgressView(value: downloadState["received"].number, total: max(1, downloadState["total"].number))
                        Text(downloadState["phase"].string == "downloading" ? "Downloading update…" : "Verifying update…").font(.caption)
                        Button("Cancel Download") { run { downloadState = try await model.request("/updates/cancel", method: "POST", body: .object([:])) } }
                    }
                    if downloadState["phase"].string == "ready" {
                        Text("Version \(downloadState["version"].string) is ready to install.").font(.headline)
                        Button("Install & Restart") { localError = ""; model.restartToInstallUpdate { localError = $0 } }.buttonStyle(.borderedProminent).disabled(dirty || !model.unsavedForms.isEmpty)
                        if dirty || !model.unsavedForms.isEmpty { Text("Save or discard unsaved changes before restarting.").font(.caption) }
                    }
                    if downloadState["error"].nonempty { Text(downloadState["error"].string).foregroundStyle(.red) }
                    if downloadState["previous"].nonempty { Text("Last installation record: " + downloadState["previous"].string).font(.caption) }
                }.padding(8)
            }
            HStack {
                Link("GitHub", destination: URL(string: "https://github.com/Coke1120/Morrow-Mail")!)
                Link("GitHub Sponsors", destination: URL(string: "https://github.com/sponsors/Coke1120")!)
                Link("Buy Me a Coffee", destination: URL(string: "https://buymeacoffee.com/Coke1120")!)
            }
            Text("An independent, MIT-licensed alternative inspired by GenMail. A native SwiftUI interface with a private local mail service.")
            Text("19 AI behaviors: model-backed assistance and explicitly labeled local simulations. Sending requires an explicit send or schedule review. Provider setup and consent are required for real accounts.")
            Divider()
            Text("Data on this Mac").font(.headline)
            Text(model.dataDirectory.path).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            Text("Mail is stored in plaintext SQLite. Credentials are encrypted with a key in the same private folder. Back up both the database and the key.").foregroundStyle(.secondary)
            Button("Show Data Folder") { NSWorkspace.shared.open(model.dataDirectory) }
            Button("Open Setup Guide") { NSWorkspace.shared.open(Bundle.main.resourceURL!.appendingPathComponent("backend/README.md")) }
            Button("Back Up Workspace…") { backup() }
            Text("Version \(Bundle.main.object(forInfoDictionaryKey: "MorrowReleaseVersion") as? String ?? "development") · macOS \(Bundle.main.object(forInfoDictionaryKey: "LSMinimumSystemVersion") as? String ?? "13.5") or later · MIT license").font(.caption).foregroundStyle(.secondary)
        }
    }
    func importOptions(for provider: String) -> JSON {
        var options = importSettings
        options["allMail"] = .bool(["google", "microsoft", "imap"].contains(provider) && importSettings["allMail"].bool)
        return options
    }
    func canImport(_ provider: String) -> Bool {
        let options = importOptions(for: provider)
        return options["allMail"].bool || options["inbox"].bool || options["sent"].bool
    }
    func importProgress(_ job: JSON) -> String {
        let labels = ["running": "History import in progress", "paused": "History import paused", "failed": "History import stopped after an error", "interrupted": "History import interrupted", "stopped": "History import stopped", "complete": "Chosen history range completed", "completed": "Chosen history range completed"]
        let runningLabels = ["retrying": "Temporary connection problem — waiting to retry", "queued": "History import queued — waiting for the next page"]
        let label = (job["status"].string == "running" ? runningLabels[job["phase"].string] : nil) ?? labels[job["status"].string] ?? "History import status unknown"
        let months = job["options"]["months"]
        let range = months.isNull ? "History range unavailable" : months.number == 0 ? "All history (no date limit)" : "\(Int(months.number)) months"
        var details = [label, "\(Int(job["imported"].number)) new messages", range]
        if job["currentFolder"].nonempty { details.append(job["currentFolder"].string == "all" ? "All normal folders" : job["currentFolder"].string.capitalized) }
        if !job["pages"].isNull { details.append("\(Int(job["pages"].number)) pages") }
        if !job["processed"].isNull { details.append("\(Int(job["processed"].number)) checked") }
        return details.joined(separator: " · ")
    }
    func importControl(_ job: JSON) -> String? {
        if job["status"].string == "running" { return "pause" }
        if ["reconnect", "restart"].contains(job["recoveryAction"].string) { return nil }
        return ["paused", "failed", "interrupted", "stopped"].contains(job["status"].string) ? "resume" : nil
    }
    func refreshImportProgress() async {
        let version = mailStatusVersion
        do {
            let result = try await model.request("/state", mailbox: model.account)
            guard case .array = result["accounts"] else { throw APIError("Incomplete import status.") }
            guard !Task.isCancelled, visible, version == mailStatusVersion else { return }
            mailSnapshot = result["accounts"]; importRefreshError = ""
        } catch {
            if !Task.isCancelled, visible, version == mailStatusVersion { importRefreshError = "Import status could not be refreshed. Showing last known status." }
        }
    }
    func preferencePatch() -> JSON {
        var patch = JSON.object([:])
        for key in generalKeys where values["preferences"][key] != baseline["preferences"][key] { patch[key] = values["preferences"][key] }
        if patch.object["signature"] != nil || patch.object["signatureFormat"] != nil {
            patch["signature"] = values["preferences"]["signature"]; patch["signatureFormat"] = values["preferences"]["signatureFormat"]
        }
        return patch
    }
    func schedulePreferences() {
        preferenceTask?.cancel(); preferenceTask = nil
        guard visible, !preferenceSaving, !model.busy, !searchRequestBusy, preferenceError.isEmpty, !preferencePatch().object.isEmpty else { return }
        preferenceTask = Task { @MainActor in
            do { try await Task.sleep(nanoseconds: 600_000_000) } catch { return }
            guard !Task.isCancelled else { return }
            preferenceTask = nil
            await savePreferences()
        }
    }
    @discardableResult
    func savePreferences() async -> Bool {
        guard !preferenceSaving, !model.busy, !searchRequestBusy else { return false }
        preferenceTask?.cancel(); preferenceTask = nil
        let sent = preferencePatch()
        guard !sent.object.isEmpty else { return true }
        preferenceSaving = true; preferenceError = ""; model.dirty("preferences-save", true)
        defer { preferenceSaving = false; model.dirty("preferences-save", false); if visible { schedulePreferences() } }
        do {
            let result = try await model.request("/settings/preferences", method: "POST", body: sent)
            let received = result["settings"]["preferences"]
            guard !received.isNull else { throw APIError("Preferences could not be saved.") }
            guard visible else { return false }
            let sameFooter = values["preferences"]["signature"] == sent["signature"] && values["preferences"]["signatureFormat"] == sent["signatureFormat"]
            for key in sent.object.keys {
                baseline["preferences"][key] = received[key]
                if values["preferences"][key] == sent[key] && (!["signature", "signatureFormat"].contains(key) || sameFooter) { values["preferences"][key] = received[key] }
                model.state["settings"]["preferences"][key] = received[key]
            }
            if sent.object["signature"] != nil { model.state["settings"]["footer"] = result["settings"]["footer"] }
            model.dirty("settings", dirty)
            return true
        } catch {
            if visible { preferenceError = error.localizedDescription + " Your changes are still here. Edit them or retry." }
            return false
        }
    }
    func importAction(_ action: String, account: JSON) {
        let body = action == "start" ? importOptions(for: account["provider"].string) : .object([:])
        run { model.state = try await model.request("/imports/\(action)", method: "POST", body: body, mailbox: account.id) }
    }
    func save(_ group: String) {
        run {
            let result = try await model.request("/settings/\(group)", method: "POST", body: group == "mail" ? .object(values[group].object.merging(["importOptions": importOptions(for: "imap")]) { _, new in new }) : values[group])
            model.state = result
            if group == "ai" { values[group]["apiKey"] = .string(""); values[group]["clearApiKey"] = .bool(false) }
            if group == "mail" { values[group]["password"] = .string("") }
            baseline[group] = values[group]; model.dirty("settings", dirty)
            status = "\(group == "ai" ? "Model" : group.capitalized) settings saved."
        }
    }
    func run(_ work: @escaping @MainActor () async throws -> Void) {
        localError = ""; status = ""
        model.perform { do { try await work() } catch { localError = error.localizedDescription } }
    }
    func close() {
        guard !searchRequestBusy, !model.busy, !preferenceSaving else { return }
        Task { @MainActor in
            guard await savePreferences(), preferencePatch().object.isEmpty else { return }
            if !dirty || model.confirmDiscard() { dismiss() }
        }
    }
    func backup() {
        let panel = NSSavePanel(); panel.title = "Back Up Morrow Mail"; panel.nameFieldStringValue = "Morrow-Backup-" + Date().formatted(.iso8601.year().month().day().dateSeparator(.dash))
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        run {
            try await model.backup(to: destination)
            status = "Verified backup saved."; NSWorkspace.shared.activateFileViewerSelecting([destination])
        }
    }
}
