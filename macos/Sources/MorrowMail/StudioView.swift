import SwiftUI
import AppKit

struct StudioView: View {
    @EnvironmentObject var model: AppModel
    private var tab: String { model.studioTab }
    @State private var action = "ask"
    @State private var messageID = ""
    @State private var contextField = "subject"
    @State private var contextQuery = ""
    @State private var contextSearch: JSON = .null
    @State private var contextPage = 0
    @State private var contextSearching = false
    @State private var contextError = ""
    @State private var contextTicket = UUID()
    @State private var contextOperation: Task<Void, Never>?
    @State private var skillID = ""
    @State private var prompt = ""
    @State private var draftText = ""
    @State private var result: JSON = .null
    @State private var resultID = UUID()
    @State private var resultGeneration: Int?
    @State private var preview: JSON = .null
    @State private var previewOwner = ""
    @State private var when = Date().addingTimeInterval(86400)
    @State private var voice = ""
    @State private var notes = ""
    @State private var savedVoice = ""
    @State private var savedNotes = ""
    @State private var learningDirty = false
    @State private var skillEditor: SkillEdit?
    @State private var memoryPreview: JSON = .null
    @State private var memoryOptions: JSON = .null
    @State private var findingMemories = false
    @State private var selectedMemories: Set<String> = []
    var feature: JSON { model.features.first { $0.id == action } ?? .null }
    var workspace: JSON { model.state["workspace"] }
    func canUse(_ message: JSON) -> Bool {
        let owner = message["accountId"].string, folder = message["folder"].string
        return model.accounts.contains { $0.id == owner } && (model.combined || model.account == owner) &&
            model.policy["folders"][folder].bool
    }
    var permitted: [JSON] { (model.listedMessages + (model.current.map { current in model.listedMessages.contains { $0.viewID == current.viewID } ? [] : [current] } ?? [])).filter(canUse) }
    var contextChoices: [JSON] { contextSearch.isNull ? permitted : contextSearch["messages"].array.filter(canUse) }
    var chosen: JSON { contextChoices.first { $0.viewID == messageID } ?? .null }
    var savedMemoryOptions: JSON { workspace["brainLearning"].picking(["enabled", "tokenBudget"]) }
    var memoryOptionsDirty: Bool { !memoryOptions.isNull && memoryOptions != savedMemoryOptions }
    var brainDirty: Bool { voice != savedVoice || notes != savedNotes || memoryOptionsDirty || learningDirty }
    var visibleMemoryPreview: JSON { memoryPreview.isNull ? workspace["brainLearning"]["preview"] : memoryPreview }
    var blocked: Bool {
        !model.allowed(action) || (feature["context"].string == "selected" && chosen.isNull) ||
        (model.combined && feature["context"].string != "selected") ||
        (feature["context"].string == "draft" && draftText.isEmpty) ||
        (["ask", "write"].contains(action) && prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) ||
        (action == "skill" && skillID.isEmpty)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                SectionHeading(title: "AI Studio", detail: "Choose a mailbox here. Summaries can show every account together.")
                Text(model.state["settings"]["ai"]["configured"].bool ? model.state["settings"]["ai"]["model"].string : "Choose an AI model").font(.caption).foregroundStyle(morrowGreen).padding(8).background(morrowGreen.opacity(0.08)).clipShape(Capsule())
                Button("Permissions") { model.settings("permissions") }.disabled(model.busy)
            }
            Picker("Mailbox", selection: Binding(get: { model.account }, set: { owner in
                guard owner != model.account, !model.busy, !brainDirty || model.confirmDiscard("Discard unsaved Email Brain changes?") else { return }
                model.perform { try await model.selectAccount(owner) }
            })) {
                Text("All accounts").tag("all")
                ForEach(model.accounts) { account in Text(account["email"].string).tag(account.id) }
            }.disabled(model.busy)
            Picker("Studio section", selection: Binding(get: { tab }, set: { value in
                guard !model.busy else { return }
                if brainDirty && !model.confirmDiscard("Discard unsaved Email Brain changes?") { return }
                loadBrain(); model.studioTab = value; if value == "tools" && feature["mock"].bool { action = "ask" }
            })) {
                Text("Assistant").tag("tools"); Text("Summaries").tag("summaries"); Text("Email Brain").tag("brain")
            }.pickerStyle(.segmented)
            HStack {
                if !model.state["settings"]["ai"]["configured"].bool {
                    Text("Set up a model to use the assistant.").foregroundStyle(.secondary)
                    Button("Set Up Model") { model.settings("model") }
                }
                Spacer()
                Menu("More") {
                    Button("Reusable Skills") { navigate("skills") }
                    Button("Local Simulations") { navigate("simulations") }
                    Button("Simulation History") { navigate("activity") }
                }.fixedSize().disabled(model.busy)
            }
            if !model.policy["enabled"].bool { Label("AI is paused in your saved permissions. Manual mail and calendars still work.", systemImage: "pause.circle").foregroundStyle(.secondary) }
            switch tab {
            case "summaries": summariesPage
            case "brain": brainPage
            case "skills": skillsPage
            case "activity": activityPage
            default: toolsPage
            }
        }.padding(26)
        .onAppear {
            action = tab == "simulations" ? "triage" : model.assistantAction
            messageID = permitted.first(where: { $0.viewID == model.selectedMessage })?.viewID ?? permitted.first?.viewID ?? ""
            skillID = workspace["skills"].array.first(where: { $0["enabled"].bool })?.id ?? ""
            loadBrain()
        }
        .onChange(of: model.draftGeneration) { _ in clearResult(); memoryPreview = .null; selectedMemories = [] }
        .onChange(of: action) { _ in clearResult() }
        .onChange(of: messageID) { _ in clearResult() }
        .onChange(of: model.mailPage) { _ in if contextSearch.isNull && !permitted.contains(where: { $0.viewID == messageID }) { messageID = permitted.first?.viewID ?? "" } }
        .onChange(of: model.account) { _ in clearContextSearch() }
        .onChange(of: skillID) { _ in clearResult() }
        .onChange(of: prompt) { _ in clearResult() }
        .onChange(of: draftText) { _ in clearResult() }
        .onChange(of: when) { _ in clearResult() }
        .onChange(of: voice) { _ in model.dirty("brain", brainDirty) }
        .onChange(of: notes) { _ in model.dirty("brain", brainDirty) }
        .onChange(of: memoryOptions) { _ in model.dirty("brain", brainDirty) }
        .onChange(of: learningDirty) { _ in model.dirty("brain", brainDirty) }
        .onDisappear { contextOperation?.cancel(); contextTicket = UUID(); contextSearching = false; model.dirty("brain", false) }
        .sheet(item: $skillEditor) { skill in SkillEditor(initial: skill.value).environmentObject(model) }
    }
    var summariesPage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    SectionHeading(title: "Saved summaries", detail: model.combined ? "All connected accounts · Each report keeps its mailbox label." : model.account)
                    Button("Refresh") { model.perform { try await model.reload() } }.disabled(model.busy)
                }
                Text("These are saved results from scheduled or newly synced mail. Opening this page does not run AI. Each report uses only mail from its own account.").font(.callout).foregroundStyle(.secondary)
                HStack {
                    Button("Summarize inbox now") { action = "briefing"; model.studioTab = "tools" }.disabled(model.combined)
                    if model.combined { Text("Choose one mailbox above for a new briefing.").font(.caption).foregroundStyle(.secondary) }
                    Button("Summary schedule") { model.settings("permissions") }
                }
                let overflow = model.combined ? model.state["today"]["summaryOverflow"] : workspace["summaryOverflow"]
                if overflow.number > 0 { Text("\(Int(overflow.number)) jobs exceeded the queue limit. Use a manual summary for those messages.").foregroundStyle(.orange) }
                ForEach(model.state["syncErrors"].array) { item in Text(item["accountId"].string + ": " + item["error"].string + (item["nextRetryAt"].nonempty ? " Next retry: \(dateLabel(item["nextRetryAt"].string))." : "")).foregroundStyle(.orange) }
                let reports = model.combined ? model.state["today"]["summaries"].array : workspace["summaries"].array
                if reports.isEmpty {
                    Text("No saved summaries yet. Set a schedule, wait for newly synced mail, or request a briefing above.").foregroundStyle(.secondary)
                }
                ForEach(reports) { report in SummaryReportView(report: report) }
            }.padding(20)
        }
    }
    var toolsPage: some View {
        VStack(alignment: .leading, spacing: 14) {
            if tab == "simulations" {
                SectionHeading(title: "Local simulations", detail: "Sample workflows for exploration. Results are labeled as simulations.")
            } else {
                Text("Start with a task").font(.headline)
                if model.combined { Text("Choose one mailbox above for inbox-wide AI tasks. You can still select a specific email across accounts below.").font(.callout).foregroundStyle(.secondary) }
                HStack {
                    Button("Ask my inbox") { action = "ask" }
                    Button("Draft a reply") { action = "reply" }
                    Button("Summarize an email") { action = "summary" }
                    Button("Summarize my inbox") { action = "briefing" }
                }.disabled(model.busy)
            }
            Picker("What would you like to do?", selection: $action) {
                ForEach(model.features.filter { $0.id != "memory" && $0["mock"].bool == (tab == "simulations") }) { item in
                    Text(item["label"].string).tag(item.id)
                }
            }.disabled(model.busy)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text(feature["label"].string).font(.title2.bold())
                    Text(feature["description"].string).foregroundStyle(.secondary)
                    if feature["mock"].bool {
                        Label("Local simulation. Preview and apply inside Morrow. No external research, attachments, invitations, unsubscribe, or automatic sending.", systemImage: "checkmark.shield").font(.callout).foregroundStyle(.secondary)
                    }
                    if feature["context"].string == "selected" {
                        HStack {
                            Picker("Find by", selection: $contextField) { Text("Subject").tag("subject"); Text("Sender").tag("from") }.frame(width: 170)
                            TextField("Search downloaded mail", text: $contextQuery).onSubmit { searchContext() }
                            Button("Find Email") { searchContext() }.disabled(contextSearching || contextQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            if !contextSearch.isNull { Button("Clear Search") { clearContextSearch() } }
                        }
                        if contextSearching { ProgressView("Finding email…").controlSize(.small) }
                        if !contextError.isEmpty { Text(contextError).foregroundStyle(.red).font(.caption) }
                        if !contextSearch.isNull { Text("Page \(contextPage + 1) · \(contextChoices.count) permitted email(s) here").font(.caption).foregroundStyle(.secondary) }
                        Picker("Email context", selection: $messageID) {
                            if contextChoices.isEmpty { Text("No permitted messages").tag("") }
                            ForEach(contextChoices) { item in Text(model.policy["content"]["subject"].bool ? item["subject"].string : "Subject withheld · " + dateLabel(item["date"].string)).tag(item.viewID) }
                        }
                    }
                    if feature["context"].string == "selected" {
                        HStack {
                            if contextSearch.isNull {
                                Button("Previous messages") { Task { await model.turnMailPage(next: false) } }.disabled(model.mailCursors.count < 2 || model.mailLoading)
                                Text("Page \(model.mailCursors.count)").font(.caption)
                                Button("Next messages") { Task { await model.turnMailPage(next: true) } }.disabled(!model.mailPage["nextCursor"].nonempty || model.mailLoading)
                            } else {
                                Button("Previous results") { searchContext(page: contextPage - 1) }.disabled(contextSearching || contextPage == 0)
                                Button("Next results") { searchContext(page: contextPage + 1) }.disabled(contextSearching || (contextPage + 1) * 30 >= Int(contextSearch["total"].number))
                            }
                        }
                    }
                    if feature["context"].string == "mailbox" {
                        Text("Uses up to \(Int(model.policy["maxMessages"].number)) messages from your permitted folders. Unchecked fields are excluded.").font(.caption).foregroundStyle(.secondary)
                    }
                    if action == "skill" {
                        Picker("Saved skill", selection: $skillID) {
                            Text("Choose a skill").tag("")
                            ForEach(workspace["skills"].array.filter { $0["enabled"].bool }) { skill in Text(skill["name"].string).tag(skill.id) }
                        }
                    }
                    if action == "rewrite" { TextArea(title: "Your draft", text: $draftText, height: 140) }
                    if !feature["mock"].bool {
                        if ["ask", "write"].contains(action) {
                            TextArea(title: action == "ask" ? "What would you like to know about your mail?" : "What would you like to say?", text: $prompt, height: 90)
                            if action == "ask" { Text("Include a person, project or topic to help find relevant downloaded mail.").font(.caption).foregroundStyle(.secondary) }
                        } else {
                            DisclosureGroup("Additional instructions (optional)") { TextArea(title: "Instructions", text: $prompt, height: 70) }
                        }
                    }
                    if ["followup", "schedule"].contains(action) { DatePicker("Proposed date & time", selection: $when, in: Date()...) }
                    if !model.allowed(action) {
                        Text("This action is off in your saved AI permissions.").foregroundStyle(.orange)
                        Button("Enable This Action") { model.settings("permissions") }
                    }
                    if feature["context"].string == "selected" && chosen.isNull { Text("Choose a permitted email to continue.").foregroundStyle(.secondary) }
                    if !feature["mock"].bool && !model.state["settings"]["ai"]["configured"].bool { Button("Set Up a Model") { model.settings("model") } }
                    HStack {
                        Button(feature["mock"].bool ? "Preview Simulation" : action == "ask" ? "Ask My Mail" : action == "briefing" ? "Create Briefing" : "Generate") { generate() }.buttonStyle(.borderedProminent).disabled(blocked || model.busy || (!feature["mock"].bool && !model.state["settings"]["ai"]["configured"].bool))
                        if model.busy { ProgressView().controlSize(.small) }
                    }
                    if !result.isNull {
                        Divider()
                        Text(result["source"].string == "demo" ? "Illustrative demo result" : "Your AI result").font(.headline)
                        Text(result["text"].string).textSelection(.enabled).lineSpacing(5)
                        HStack {
                            Button("Copy") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(result["text"].string, forType: .string) }
                            if ["write", "reply", "rewrite", "translate"].contains(action) { Button("Review in a Draft") { useDraft() }.disabled(model.busy || model.preparingDraft || resultGeneration != model.draftGeneration) }
                        }
                    }
                    if !preview.isNull {
                        Divider()
                        Text(preview["title"].string).font(.title3.bold())
                        Text(preview["summary"].string).foregroundStyle(.secondary)
                        ForEach(Array(preview["items"].array.enumerated()), id: \.offset) { _, item in
                            VStack(alignment: .leading, spacing: 6) { Text(item["title"].string).font(.headline); Text(item["detail"].string).foregroundStyle(.secondary).textSelection(.enabled) }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary.opacity(0.3)).clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        Text("Preview expires after ten minutes. Applying changes this local workspace only.").font(.caption).foregroundStyle(.secondary)
                        HStack {
                            Button("Dismiss Preview") { preview = .null; previewOwner = "" }
                            Button("Apply Local Simulation") {
                                let owner = previewOwner, id = preview["id"]
                                model.perform {
                                    model.state = try await model.request("/workflows/apply", method: "POST", body: .object(["previewId": id]), mailbox: owner)
                                    preview = .null; model.notice = "Simulation applied locally."; loadBrain()
                                }
                            }.buttonStyle(.borderedProminent).disabled(model.busy || !model.allowed(action))
                        }
                    }
                }.padding(22).frame(maxWidth: .infinity, alignment: .leading)
            }.frame(minWidth: 360)
        }
    }
    var brainPage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                SectionHeading(title: "Email Brain", detail: "Learn your writing voice from this account’s downloaded Sent mail.")
                if model.combined {
                    Text("Choose a mailbox above to learn its writing voice. Approved styles stay separate and are used for new mail and replies from their own account.").foregroundStyle(.secondary)
                } else {
                    StyleLearningView(dirty: $learningDirty, onOpenSettings: { model.settings($0) })
                }
                DisclosureGroup("Notes and memory suggestions") {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("Optional notes and reviewed memories provide extra context. Manual writing instructions override the approved Sent style.").font(.callout).foregroundStyle(.secondary)
                brainAutomation
                GroupBox("Find memories in your mail") {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Suggests up to 8 memories from your latest permitted mail (up to \(Int(model.policy["maxMessages"].number)) messages). Review the sources and select what to keep. Your saved notes are retained.").foregroundStyle(.secondary)
                        Button("Suggest Memories · Uses AI") { suggestMemories() }.buttonStyle(.borderedProminent)
                            .disabled(model.busy || brainDirty || !model.allowed("memory") || !model.state["settings"]["ai"]["configured"].bool)
                        if brainDirty { Text("Save or discard your notes before requesting suggestions.").font(.caption).foregroundStyle(.secondary) }
                        if !model.allowed("memory") { Button("Enable Memory Permissions") { model.settings("permissions") } }
                        if findingMemories { ProgressView("Finding memory suggestions…") }
                        memorySuggestions
                    }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                }
                Text("Your instructions").font(.title3.bold())
                TextArea(title: "Writing voice", text: $voice, height: 85)
                TextArea(title: "Notes to remember", text: $notes, height: 130)
                HStack {
                    if voice != savedVoice || notes != savedNotes { Button("Save Notes") {
                        model.perform {
                            model.state = try await model.request("/workspace/brain", method: "POST", body: .object(["voice": .string(voice), "notes": .string(notes)]))
                            savedVoice = voice; savedNotes = notes; memoryPreview = .null; model.dirty("brain", brainDirty); model.notice = "Brain notes saved."
                        }
                    }.buttonStyle(.borderedProminent) }
                    Button("Discard Changes") { loadBrain(); model.dirty("brain", false) }.disabled(!brainDirty)
                    Button("Clear Brain") {
                        guard model.confirm("Clear your Email Brain?", detail: "Saved voice, notes, memories and contacts will be removed.") else { return }
                        model.perform { model.state = try await model.request("/workspace/brain", method: "DELETE", body: .object([:])); loadBrain(); model.dirty("brain", false) }
                    }
                }
                Divider()
                Text("Reviewed memories").font(.title3.bold())
                if workspace["brain"]["facts"].array.isEmpty { Text("No reviewed memories yet. Start with Suggest Memories above.").foregroundStyle(.secondary) }
                ForEach(workspace["brain"]["facts"].array) { fact in
                    GroupBox {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(fact["text"].string).textSelection(.enabled)
                            memorySources(fact)
                            Button("Remove Memory", role: .destructive) {
                                model.perform { model.state = try await model.request("/workspace/brain/facts/" + encodedPath(fact.id), method: "DELETE", body: .object([:])) }
                            }
                        }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                Text("Memories are used only while their source mail and permissions still match.").font(.caption).foregroundStyle(.secondary)
                DisclosureGroup("Saved contacts") {
                ForEach(Array(workspace["brain"]["contacts"].array.enumerated()), id: \.offset) { _, item in Label("\(item["name"].string) · \(item["email"].string)", systemImage: "person.crop.circle") }
                if workspace["brain"]["contacts"].array.isEmpty { Text("No saved contacts.").foregroundStyle(.secondary) }
                }
                    }
                }.disabled(model.combined)
            }.padding(20).disabled(model.busy)
        }
    }
    var skillsPage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack { SectionHeading(title: "Reusable email skills", detail: "Your instructions, run only when you ask. Global AI permissions always apply."); Button("New Skill") { skillEditor = SkillEdit(value: .null) }.buttonStyle(.borderedProminent) }
                ForEach(workspace["skills"].array) { skill in
                    GroupBox {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack { Text(skill["name"].string).font(.headline); Spacer(); Text(skill["enabled"].bool ? "Enabled" : "Disabled").font(.caption).foregroundStyle(.secondary) }
                            Text(skill["instructions"].string).foregroundStyle(.secondary).textSelection(.enabled)
                            Text("Folders: " + permissionFolders.filter { skill["folders"][$0].bool }.joined(separator: ", ")).font(.caption)
                            HStack {
                                Button("Use Skill") { skillID = skill.id; action = "skill"; model.studioTab = "tools" }.disabled(!skill["enabled"].bool)
                                Button("Edit") { skillEditor = SkillEdit(value: skill) }
                                Button("Delete") {
                                    guard model.confirm("Delete “\(skill["name"].string)” ?", detail: "This removes the saved instructions.") else { return }
                                    model.perform { model.state = try await model.request("/skills/" + encodedPath(skill.id), method: "DELETE", body: .object([:])) }
                                }
                            }
                        }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }.padding(16).disabled(model.busy)
        }
    }
    var activityPage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeading(title: "Local workspace activity", detail: "These are simulated records. No notifications, external events, or unsubscribe requests are scheduled here.")
                ForEach(["reminders", "events", "activity", "unsubscribed"], id: \.self) { collection in
                    Text(collection == "unsubscribed" ? "Simulated unsubscribe requests" : collection.capitalized).font(.title3.bold())
                    if workspace[collection].array.isEmpty { Text("No records yet.").foregroundStyle(.secondary) }
                    ForEach(workspace[collection].array) { item in
                        GroupBox {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(item["title"].string).font(.headline).strikethrough(item["done"].bool || item["cancelled"].bool)
                                Text(item["detail"].string).foregroundStyle(.secondary)
                                Text(dateLabel(item["when"].nonempty ? item["when"].string : item["createdAt"].string)).font(.caption).foregroundStyle(.secondary)
                                if ["reminders", "events"].contains(collection) && !item["cancelled"].bool {
                                    HStack {
                                        Button(item["done"].bool ? "Mark Incomplete" : "Mark Complete") { record(collection, item, .object(["done": .bool(!item["done"].bool)])) }
                                        if collection == "events" { Button("Cancel Local Record") { record(collection, item, .object(["cancelled": .bool(true)])) } }
                                    }.disabled(model.busy)
                                }
                            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    Divider()
                }
            }.padding(16)
        }
    }
    func navigate(_ destination: String) {
        guard !model.busy, !brainDirty || model.confirmDiscard("Discard unsaved Email Brain changes?") else { return }
        loadBrain()
        model.studioTab = destination
        if destination == "simulations" { action = model.features.first { $0["mock"].bool }?.id ?? "memory" }
    }
    @ViewBuilder var memorySuggestions: some View {
        if !visibleMemoryPreview.isNull {
            if visibleMemoryPreview["items"].array.isEmpty { Text("No durable memories found in this selection.").foregroundStyle(.secondary) }
            ForEach(visibleMemoryPreview["items"].array) { item in
                Toggle(isOn: Binding(get: { selectedMemories.contains(item.id) }, set: { if $0 { selectedMemories.insert(item.id) } else { selectedMemories.remove(item.id) } })) {
                    VStack(alignment: .leading, spacing: 5) { Text(item["text"].string); memorySources(item) }
                }.toggleStyle(.checkbox)
            }
            HStack {
                Button("Save Selected Memories") {
                    let payload: JSON = .object(["previewId": visibleMemoryPreview["id"], "itemIds": .array(selectedMemories.sorted().map { .string($0) })])
                    model.perform {
                        model.state = try await model.request("/workspace/brain/apply", method: "POST", body: payload)
                        memoryPreview = .null; selectedMemories = []; model.notice = "Selected memories saved. Your notes were retained."
                    }
                }.disabled(selectedMemories.isEmpty || brainDirty)
                Button("Dismiss") {
                    if memoryPreview.isNull {
                        let id = visibleMemoryPreview["id"]
                        model.perform { model.state = try await model.request("/workspace/brain/dismiss", method: "POST", body: .object(["previewId": id])) }
                    } else { memoryPreview = .null }
                    selectedMemories = []
                }
            }
        }
    }
    func memorySources(_ item: JSON) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(item["sourceLabels"].array) { source in
                Text("Source: " + source["subject"].string + " · " + dateLabel(source["date"].string)).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
    func suggestMemories() {
        let owner = model.account, generation = model.draftGeneration
        memoryPreview = .null; selectedMemories = []
        model.perform {
            findingMemories = true
            defer { findingMemories = false }
            let response = try await model.request("/workspace/brain/preview", method: "POST", body: .object([:]), mailbox: owner)
            guard model.account == owner, model.draftGeneration == generation else { return }
            memoryPreview = response["preview"]
        }
    }
    func generate() {
        var payload: JSON = .object(["action": .string(action), "prompt": .string(prompt)])
        if feature["context"].string == "selected" { payload["messageId"] = .string(chosen.id) }
        if action == "rewrite" { payload["draftText"] = .string(draftText) }
        if action == "skill" { payload["skillId"] = .string(skillID) }
        if ["followup", "schedule"].contains(action) { payload["when"] = .string(utcDate(when)) }
        let simulation = feature["mock"].bool
        let owner = feature["context"].string == "selected" ? chosen["accountId"].string : model.account
        guard !owner.isEmpty, owner != "all" else { return }
        clearResult()
        let run = resultID, generation = model.draftGeneration
        model.perform {
            let response = try await model.request(simulation ? "/workflows/preview" : "/ai", method: "POST", body: payload, mailbox: owner)
            guard !Task.isCancelled, run == resultID, generation == model.draftGeneration, model.section == "studio" else { return }
            if simulation { previewOwner = owner; preview = response["preview"] } else { result = response; resultGeneration = generation }
        }
    }
    func record(_ collection: String, _ item: JSON, _ payload: JSON) { model.perform { model.state = try await model.request("/workspace/\(collection)/" + encodedPath(item.id), method: "PATCH", body: payload) } }
    func useDraft() {
        guard !result.isNull, resultGeneration == model.draftGeneration, !model.busy, !model.preparingDraft else { return }
        let text = result["text"].string, message = chosen, run = resultID
        if action == "reply" {
            Task { @MainActor in
                do {
                    let draft = try await model.prepareDraft(message: message, mode: "reply", body: text)
                    guard run == resultID, resultGeneration == model.draftGeneration else { return }
                    model.newDraft(draft)
                } catch is CancellationError { }
                catch { if run == resultID { model.error = error.localizedDescription } }
            }
        } else {
            var draft = Draft(); draft.accountID = action == "translate" ? message["accountId"].string : model.account; draft.body = text
            if action == "translate" { draft.subject = message["subject"].string }
            model.newDraft(draft)
        }
    }
    func clearResult() { resultID = UUID(); resultGeneration = nil; result = .null; preview = .null; previewOwner = "" }
    func clearContextSearch() {
        contextOperation?.cancel(); contextTicket = UUID(); contextSearching = false; contextSearch = .null; contextQuery = ""; contextError = ""; contextPage = 0
        messageID = permitted.first?.viewID ?? ""
    }
    func searchContext(page: Int = 0) {
        let query = contextQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, page >= 0 else { return }
        contextOperation?.cancel()
        let ticket = UUID(), owner = model.account, field = contextField
        contextTicket = ticket; contextSearching = true; contextError = ""
        let body: JSON = .object(["query": .string(""), "scope": .string(owner == "all" ? "all" : "account"), "folder": .string("inbox"), "sort": .string("newest"), "page": .number(Double(page)), "filters": .object([field: .string(query)]), "smart": .bool(false)])
        contextOperation = Task {
            defer { if contextTicket == ticket { contextSearching = false } }
            do {
                let response = try await model.request("/search", method: "POST", body: body, mailbox: owner)
                guard !Task.isCancelled, contextTicket == ticket, model.account == owner else { return }
                contextSearch = response; contextPage = page; messageID = contextChoices.first?.viewID ?? ""
            } catch { if !Task.isCancelled && contextTicket == ticket { contextError = error.localizedDescription } }
        }
    }
    var brainAutomation: some View {
        GroupBox("Automatic learning") {
            VStack(alignment: .leading, spacing: 10) {
                Toggle("Suggest new memories weekly", isOn: Binding(get: { memoryOptions["enabled"].bool }, set: { memoryOptions["enabled"] = .bool($0) })).toggleStyle(.checkbox)
                Text("First analysis starts after enabling; later analyses run weekly when mail changes. Proposals wait here for review, including after restart. Saving a proposal is always your choice.").font(.caption).foregroundStyle(.secondary)
                DisclosureGroup("Budget and status") {
                    HStack { Text("Estimated tokens per analysis"); TextField("16000", value: Binding(get: { Int(memoryOptions["tokenBudget"].number) }, set: { memoryOptions["tokenBudget"] = .number(Double($0)) }), format: .number.grouping(.never)).frame(width: 120) }
                    Text("4,000–64,000 tokens · " + workspace["brainLearning"]["status"].string).font(.caption)
                    if workspace["brainLearning"]["error"].nonempty { Text(workspace["brainLearning"]["error"].string).foregroundStyle(.orange) }
                }
                if memoryOptionsDirty {
                    Button("Save Automatic Learning") {
                        if memoryOptions["enabled"].bool && !model.confirm("Enable automatic memory suggestions?", detail: "\(model.account) · \(model.state["settings"]["ai"]["model"].string)\nWeekly budget: \(Int(memoryOptions["tokenBudget"].number)) estimated tokens. Uses permitted downloaded mail while Morrow is open. Provider charges may apply. Suggestions require your review before saving.") { return }
                        model.perform { model.state = try await model.request("/workspace/brain/settings", method: "POST", body: memoryOptions); memoryOptions = savedMemoryOptions }
                    }.buttonStyle(.borderedProminent)
                }
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    func loadBrain() { memoryOptions = savedMemoryOptions; voice = workspace["brain"]["voice"].string; notes = workspace["brain"]["notes"].string; savedVoice = voice; savedNotes = notes }
}

struct SkillEdit: Identifiable { let id = UUID(); let value: JSON }
struct SkillEditor: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    let initial: JSON
    @State private var skill: JSON
    @State private var baseline: JSON
    @State private var error = ""
    init(initial: JSON) {
        self.initial = initial
        let value: JSON = initial.isNull ? .object(["name": .string(""), "instructions": .string(""), "enabled": .bool(true), "folders": .object(Dictionary(uniqueKeysWithValues: permissionFolders.map { ($0, .bool($0 == "inbox")) }))]) : initial
        _skill = State(initialValue: value); _baseline = State(initialValue: value)
    }
    var dirty: Bool { skill != baseline }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(initial.isNull ? "Create an email skill" : "Edit your email skill").font(.title2.bold())
            TextField("Skill name", text: Binding(get: { skill["name"].string }, set: { skill["name"] = .string($0) })).textFieldStyle(.roundedBorder)
            TextArea(title: "Instructions", text: Binding(get: { skill["instructions"].string }, set: { skill["instructions"] = .string($0) }), height: 150)
            Toggle("Enable this skill", isOn: Binding(get: { skill["enabled"].bool }, set: { skill["enabled"] = .bool($0) })).toggleStyle(.checkbox)
            Text("Folders this skill can use").font(.headline)
            HStack { ForEach(permissionFolders, id: \.self) { folder in Toggle(folder.capitalized, isOn: Binding(get: { skill["folders"][folder].bool }, set: { skill["folders"][folder] = .bool($0) })).toggleStyle(.checkbox) } }
            Text("Global AI permissions still apply. Skills never execute external actions or send mail.").font(.caption).foregroundStyle(.secondary)
            if !error.isEmpty { Text(error).foregroundStyle(.red) }
            HStack {
                Button("Cancel") { if !dirty || model.confirmDiscard() { dismiss() } }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Save Skill") {
                    model.perform {
                        do { model.state = try await model.request("/skills", method: "POST", body: skill); baseline = skill; dismiss() }
                        catch { self.error = error.localizedDescription }
                    }
                }.buttonStyle(.borderedProminent).disabled(!skill["name"].nonempty || !skill["instructions"].nonempty)
            }
        }.padding(28).frame(width: 660).disabled(model.busy)
        .interactiveDismissDisabled(dirty || model.busy)
        .onChange(of: skill) { _ in model.dirty("skill", dirty) }
        .onDisappear { model.dirty("skill", false) }
    }
}
