import SwiftUI
import AppKit

struct StudioView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var review: ReviewWorkspaceState
    private var tab: String { model.studioTab == "summaries" ? "tools" : model.studioTab }
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
    @State private var useSmartSearch = false
    @State private var result: JSON = .null
    @State private var resultID = UUID()
    @State private var resultGeneration: Int?
    @State private var preview: JSON = .null
    @State private var previewOwner = ""
    @State private var when = Date().addingTimeInterval(86400)
    @State private var voice = ""
    @State private var notes = ""
    @State private var guardrails = ""
    @State private var ruleText = ""
    @State private var editingRuleID = ""
    @State private var editingRuleText = ""
    @State private var savedGuardrails = ""
    @State private var savedVoice = ""
    @State private var savedNotes = ""
    @State private var learningDirty = false
    @State private var skillEditor: SkillEdit?
    @State private var memoryPreview: JSON = .null
    @State private var memoryOptions: JSON = .null
    @State private var findingMemories = false
    @State private var selectedMemories: Set<String> = []
    @State private var scopedState: JSON = .null
    @State private var scopeStateTicket = UUID()
    @State private var localMessages: [JSON] = []
    @State private var localCursors = [""]
    @State private var localNext = ""
    @State private var localOwner = ""
    @State private var localLoading = false
    @State private var localTicket = UUID()
    var feature: JSON { model.features.first { $0.id == action } ?? .null }
    var scope: String {
        let owner = review.scope
        return owner == "all" || model.accounts.contains { $0.id == owner } ? owner : "all"
    }
    var scopeAll: Bool { scope == "all" }
    /// Scoped `/state` is page-local. Ignore it until its account matches the tab, so a previous mailbox cannot be edited or saved as the new one.
    var scopeStateReady: Bool { scopeAll || scope == model.account || scopedState["account"]["id"].string == scope }
    var usesReadingList: Bool { scope == model.account || (scopeAll && model.account == "all") }
    var operationBusy: Bool { model.busy || model.backgroundBusy }
    var workspace: JSON {
        if scopeAll { return .object([:]) }
        if scope == model.account { return model.state["workspace"] }
        guard scopedState["account"]["id"].string == scope else { return .object([:]) }
        return scopedState["workspace"]
    }
    func canUse(_ message: JSON) -> Bool {
        let owner = message["accountId"].string, folder = message["folder"].string
        return model.accounts.contains { $0.id == owner } && (scopeAll || scope == owner) &&
            model.policy["folders"][folder].bool
    }
    var pageMessages: [JSON] {
        if usesReadingList { return model.listedMessages }
        return localOwner == scope ? localMessages : []
    }
    var permitted: [JSON] {
        var rows = pageMessages
        if let current = model.current, !rows.contains(where: { $0.viewID == current.viewID }) { rows.insert(current, at: 0) }
        return rows.filter(canUse)
    }
    var contextChoices: [JSON] { contextSearch.isNull ? permitted : contextSearch["messages"].array.filter(canUse) }
    var chosen: JSON { contextChoices.first { $0.viewID == messageID } ?? .null }
    var savedMemoryOptions: JSON { workspace["brainLearning"].picking(["enabled", "tokenBudget"]) }
    var memoryOptionsDirty: Bool { !memoryOptions.isNull && memoryOptions != savedMemoryOptions }
    var brainDirty: Bool { voice != savedVoice || notes != savedNotes || guardrails != savedGuardrails || memoryOptionsDirty || learningDirty }
    var visibleMemoryPreview: JSON { memoryPreview.isNull ? workspace["brainLearning"]["preview"] : memoryPreview }
    var blocked: Bool {
        !model.allowed(action) || (feature["context"].string == "selected" && chosen.isNull) ||
        (scopeAll && feature["context"].string != "selected") ||
        (feature["context"].string == "draft" && draftText.isEmpty) ||
        (["ask", "write"].contains(action) && prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) ||
        (action == "skill" && skillID.isEmpty)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                SectionHeading(title: "AI Studio", detail: "Ask about your mail or draft replies.")
                Text(model.state["settings"]["ai"]["configured"].bool ? "AI connected" : "AI not set up").font(.caption).foregroundStyle(morrowGreen).padding(8).background(morrowGreen.opacity(0.08)).clipShape(Capsule())
                Button("AI & Privacy") { model.settings("permissions") }
            }
            ReviewAccountTabs(review: review, canPick: { owner in
                owner == review.scope || !brainDirty || model.confirmDiscard("Discard unsaved writing style and notes changes?")
            })
            HStack {
                Button("Assistant") { navigate("tools") }.disabled(tab == "tools")
                Spacer()
                Menu("More") {
                    Button("Writing Style & Notes") { navigate("brain") }
                    Button("Local Inbox Rules") { navigate("rules") }
                    Button("Reusable Skills") { navigate("skills") }
                    Button("Local Simulations") { navigate("simulations") }
                    Button("Simulation History") { navigate("activity") }
                }.fixedSize()
            }
            if tab != "rules" && !model.state["settings"]["ai"]["configured"].bool {
                HStack {
                    Text("Set up AI to use the assistant. Your IT support can help.").foregroundStyle(.secondary)
                    Button("Set Up AI") { model.settings("model") }
                }
            }
            if !model.policy["enabled"].bool { Label("AI is paused in your saved permissions. Manual mail and calendars still work.", systemImage: "pause.circle").foregroundStyle(.secondary) }
            switch tab {
            case "brain": brainPage
            case "rules": LocalRulesView()
            case "skills": skillsPage
            case "activity": activityPage
            default: toolsPage
            }
        }.padding(26)
        .onAppear {
            if model.studioTab == "summaries" { model.studioTab = "tools" }
            action = tab == "simulations" ? "triage" : model.assistantAction
            messageID = permitted.first(where: { $0.viewID == model.selectedMessage })?.viewID ?? permitted.first?.viewID ?? ""
            skillID = workspace["skills"].array.first(where: { $0["enabled"].bool })?.id ?? ""
            loadBrain()
        }
        .task(id: scope + "\n" + model.account) {
            if review.scope != "all", !model.accounts.contains(where: { $0.id == review.scope }), !review.writing { review.pickScope("all") }
            await loadScopedState()
            await loadLocal(offset: 0)
        }
        .onChange(of: model.draftGeneration) { _ in clearResult(); memoryPreview = .null; selectedMemories = [] }
        .onChange(of: action) { _ in clearResult() }
        .onChange(of: messageID) { _ in clearResult() }
        .onChange(of: model.mailPage) { _ in if usesReadingList && contextSearch.isNull && !permitted.contains(where: { $0.viewID == messageID }) { messageID = permitted.first?.viewID ?? "" } }
        .onChange(of: review.scope) { _ in skillEditor = nil; clearResult(); clearContextSearch(); memoryPreview = .null; selectedMemories = []; learningDirty = false; ruleText = ""; editingRuleID = ""; editingRuleText = ""; model.dirty("brain", false); loadBrain() }
        .onChange(of: model.account) { _ in clearContextSearch() }
        .onChange(of: skillID) { _ in clearResult() }
        .onChange(of: prompt) { _ in clearResult() }
        .onChange(of: useSmartSearch) { _ in clearResult() }
        .onChange(of: draftText) { _ in clearResult() }
        .onChange(of: when) { _ in clearResult() }
        .onChange(of: voice) { _ in model.dirty("brain", brainDirty) }
        .onChange(of: notes) { _ in model.dirty("brain", brainDirty) }
        .onChange(of: guardrails) { _ in model.dirty("brain", brainDirty) }
        .onChange(of: memoryOptions) { _ in model.dirty("brain", brainDirty) }
        .onChange(of: learningDirty) { _ in model.dirty("brain", brainDirty) }
        .onDisappear { contextOperation?.cancel(); contextTicket = UUID(); contextSearching = false; model.dirty("brain", false) }
        .sheet(item: $skillEditor) { skill in SkillEditor(initial: skill.value, mailbox: scope, onSaved: { store($0, owner: scope) }).environmentObject(model) }
    }
    var toolsPage: some View {
        VStack(alignment: .leading, spacing: 14) {
            if tab == "simulations" {
                SectionHeading(title: "Local simulations", detail: "Sample workflows for exploration. Results are labeled as simulations.")
            } else {
                Text("Start with a task").font(.headline)
                if scopeAll { Text("Choose one mailbox above for inbox-wide AI tasks. You can still select a specific email across accounts below.").font(.callout).foregroundStyle(.secondary) }
            }
            Picker("What would you like to do?", selection: $action) {
                ForEach(model.features.filter { $0.id != "memory" && $0["mock"].bool == (tab == "simulations") }) { item in
                    Text(item["label"].string).tag(item.id)
                }
            }.disabled(operationBusy)
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
                            if contextSearch.isNull && usesReadingList {
                                Button("Previous messages") { Task { await model.turnMailPage(next: false) } }.disabled(model.mailCursors.count < 2 || model.mailLoading)
                                Text("Page \(model.mailCursors.count)").font(.caption)
                                Button("Next messages") { Task { await model.turnMailPage(next: true) } }.disabled(!model.mailPage["nextCursor"].nonempty || model.mailLoading)
                            } else if contextSearch.isNull {
                                Button("Previous messages") { Task { await loadLocal(offset: max(0, localCursors.count - 2) * 50) } }.disabled(localCursors.count < 2 || localLoading)
                                Text("Page \(localCursors.count)").font(.caption)
                                Button("Next messages") { Task { await loadLocal(offset: localCursors.count * 50) } }.disabled(localNext.isEmpty || localLoading)
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
                            if action == "ask" {
                                HStack {
                                    ForEach(["What did we agree about the project deadline?", "Which questions about the proposal remain unanswered?"], id: \.self) { example in Button(example) { prompt = example }.font(.caption) }
                                }
                                Toggle("Use my approved Smart Search index", isOn: $useSmartSearch).toggleStyle(.checkbox)
                                Text(useSmartSearch ? "Retrieves this mailbox’s permitted indexed mail. The question may be sent to your embedding model and incur charges; no indexing starts here. Maximum question length: 500 characters." : "Include a person, project or topic. Uses keyword matches from downloaded, permitted mail.").font(.caption).foregroundStyle(.secondary)
                            }
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
                    HStack {
                        Button(feature["mock"].bool ? "Preview Simulation" : action == "ask" ? "Ask My Mail" : action == "reply" ? "Draft Reply" : ["summary", "briefing"].contains(action) ? "Create Summary" : "Create Text") { generate() }.buttonStyle(.borderedProminent).disabled(blocked || operationBusy || (!feature["mock"].bool && !model.state["settings"]["ai"]["configured"].bool))
                        if operationBusy { ProgressView().controlSize(.small) }
                    }
                    if !result.isNull {
                        Divider()
                        Text(result["source"].string == "demo" ? "Illustrative demo result" : "Your AI result").font(.headline)
                        Text(result["text"].string).textSelection(.enabled).lineSpacing(5)
                        if !result["sources"].array.isEmpty { SourceLinksView(sources: result["sources"].array) }
                        if result["retrievalWarning"].nonempty { Text(result["retrievalWarning"].string).font(.caption).foregroundStyle(.secondary) }
                        HStack {
                            Button("Copy") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(result["text"].string, forType: .string) }
                            if ["write", "reply", "rewrite", "translate"].contains(action) { Button("Review in a Draft") { useDraft() }.disabled(operationBusy || model.preparingDraft || resultGeneration != model.draftGeneration) }
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
                                let owner = previewOwner, id = preview["id"], viewed = scope
                                guard !operationBusy else { return }
                                model.perform {
                                    let next = try await model.request("/workflows/apply", method: "POST", body: .object(["previewId": id]), mailbox: owner)
                                    guard review.scope == viewed else { return }
                                    store(next, owner: owner)
                                    preview = .null; model.notice = "Simulation applied locally."; loadBrain()
                                }
                            }.buttonStyle(.borderedProminent).disabled(operationBusy || !model.allowed(action))
                        }
                    }
                }.padding(22).frame(maxWidth: .infinity, alignment: .leading)
            }.frame(minWidth: 360)
        }
    }
    var brainPage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                SectionHeading(title: "Writing style & notes", detail: "Learn your writing voice from this account’s downloaded Sent mail.")
                if scopeAll {
                    Text("Choose a mailbox above to learn its writing voice. Approved styles stay separate and are used for new mail and replies from their own account.").foregroundStyle(.secondary)
                } else if scope == model.account {
                    StyleLearningView(dirty: $learningDirty, onOpenSettings: { model.settings($0) })
                } else if scopedState["account"]["id"].string == scope {
                    StyleLearningView(dirty: $learningDirty, mailbox: scope, stateOverride: $scopedState, onOpenSettings: { model.settings($0) })
                } else {
                    ProgressView("Loading this mailbox…").controlSize(.small)
                }
                writingRulesBox
                DisclosureGroup("Notes and memory suggestions") {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("Optional notes and reviewed memories provide extra context. Manual writing instructions override the approved Sent style. How-you-write rules above stay separate from this voice field.").font(.callout).foregroundStyle(.secondary)
                brainAutomation
                GroupBox("Find memories in your mail") {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Suggests up to 8 memories from your latest permitted mail (up to \(Int(model.policy["maxMessages"].number)) messages). Review the sources and select what to keep. Your saved notes are retained.").foregroundStyle(.secondary)
                        Button("Suggest Memories · Uses AI") { suggestMemories() }.buttonStyle(.borderedProminent)
                            .disabled(operationBusy || brainDirty || !model.allowed("memory") || !model.state["settings"]["ai"]["configured"].bool)
                        if brainDirty { Text("Save or discard your notes before requesting suggestions.").font(.caption).foregroundStyle(.secondary) }
                        if !model.allowed("memory") { Button("Enable Memory Permissions") { model.settings("permissions") } }
                        if findingMemories { ProgressView("Finding memory suggestions…") }
                        memorySuggestions
                    }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                }
                Text("Your instructions").font(.title3.bold())
                TextArea(title: "Writing voice", text: $voice, height: 85)
                TextArea(title: "Business facts & notes", text: $notes, height: 130)
                TextArea(title: "Writing guardrails", text: $guardrails, height: 85)
                Text("Keep facts separate from tone. For example: do not quote prices or promise a delivery date without current evidence. Saved context belongs to this mailbox.").font(.caption).foregroundStyle(.secondary)
                HStack {
                    if voice != savedVoice || notes != savedNotes || guardrails != savedGuardrails { Button("Save Notes") {
                        let owner = scope
                        guard !operationBusy else { return }
                        model.perform {
                            let next = try await model.request("/workspace/brain", method: "POST", body: .object(["voice": .string(voice), "notes": .string(notes), "guardrails": .string(guardrails)]), mailbox: owner)
                            guard review.scope == owner else { return }
                            store(next, owner: owner)
                            savedVoice = voice; savedNotes = notes; savedGuardrails = guardrails; memoryPreview = .null; model.dirty("brain", brainDirty); model.notice = "Notes saved."
                        }
                    }.buttonStyle(.borderedProminent).disabled(operationBusy) }
                    Button("Discard Changes") { loadBrain(); model.dirty("brain", false) }.disabled(!brainDirty)
                    Button("Clear Notes & Memories") {
                        guard model.confirm("Clear saved notes and memories?", detail: "Removes saved voice, notes, memories and contacts for this mailbox. How-you-write rules, confirmed identity and the approved Sent style remain saved.") else { return }
                        let owner = scope
                        guard !operationBusy else { return }
                        model.perform {
                            let next = try await model.request("/workspace/brain", method: "DELETE", body: .object([:]), mailbox: owner)
                            guard review.scope == owner else { return }
                            store(next, owner: owner); loadBrain(); model.dirty("brain", false)
                        }
                    }.disabled(operationBusy)
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
                                let owner = scope, id = fact.id
                                guard !operationBusy else { return }
                                model.perform {
                                    let next = try await model.request("/workspace/brain/facts/" + encodedPath(id), method: "DELETE", body: .object([:]), mailbox: owner)
                                    guard review.scope == owner else { return }
                                    store(next, owner: owner)
                                }
                            }.disabled(operationBusy)
                        }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                Text("Memories are used only while their source mail and permissions still match.").font(.caption).foregroundStyle(.secondary)
                DisclosureGroup("Saved contacts") {
                ForEach(Array(workspace["brain"]["contacts"].array.enumerated()), id: \.offset) { _, item in Label("\(item["name"].string) · \(item["email"].string)", systemImage: "person.crop.circle") }
                if workspace["brain"]["contacts"].array.isEmpty { Text("No saved contacts.").foregroundStyle(.secondary) }
                }
                    }
                }.disabled(scopeAll || !scopeStateReady)
            }.padding(20).disabled(operationBusy)
        }
    }
    var skillsPage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if scopeAll { Text("Choose one mailbox above for reusable skills.").foregroundStyle(.secondary) }
                else if !scopeStateReady { ProgressView("Loading this mailbox…").controlSize(.small) }
                HStack { SectionHeading(title: "Reusable email skills", detail: "Your instructions, run only when you ask. Global AI permissions always apply."); Button("New Skill") { skillEditor = SkillEdit(value: .null) }.buttonStyle(.borderedProminent).disabled(scopeAll || !scopeStateReady || operationBusy) }
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
                                    let owner = scope, id = skill.id
                                    guard !operationBusy else { return }
                                    model.perform {
                                        let next = try await model.request("/skills/" + encodedPath(id), method: "DELETE", body: .object([:]), mailbox: owner)
                                        guard review.scope == owner else { return }
                                        store(next, owner: owner)
                                    }
                                }
                            }
                        }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }.padding(16).disabled(operationBusy)
        }
    }
    var activityPage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeading(title: "Local workspace activity", detail: "These are simulated records. No notifications, external events, or unsubscribe requests are scheduled here.")
                if scopeAll { Text("Choose one mailbox above for simulation history.").foregroundStyle(.secondary) }
                else if !scopeStateReady { ProgressView("Loading this mailbox…").controlSize(.small) }
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
                                    }.disabled(operationBusy)
                                }
                            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    Divider()
                }
            }.padding(16).disabled(scopeAll || !scopeStateReady)
        }
    }
    func navigate(_ destination: String) {
        guard destination != tab, !brainDirty || model.confirmDiscard("Discard unsaved writing style and notes changes?") else { return }
        loadBrain()
        model.studioTab = destination
        if destination == "simulations" { action = model.features.first { $0["mock"].bool }?.id ?? "memory" }
        if destination == "tools" && feature["mock"].bool { action = "ask" }
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
                    let owner = scope
                    let payload: JSON = .object(["previewId": visibleMemoryPreview["id"], "itemIds": .array(selectedMemories.sorted().map { .string($0) })])
                    guard !operationBusy else { return }
                    model.perform {
                        let next = try await model.request("/workspace/brain/apply", method: "POST", body: payload, mailbox: owner)
                        guard review.scope == owner else { return }
                        store(next, owner: owner)
                        memoryPreview = .null; selectedMemories = []; model.notice = "Selected memories saved. Your notes were retained."
                    }
                }.disabled(selectedMemories.isEmpty || brainDirty || operationBusy)
                Button("Dismiss") {
                    if memoryPreview.isNull {
                        let owner = scope, id = visibleMemoryPreview["id"]
                        guard !operationBusy else { return }
                        model.perform {
                            let next = try await model.request("/workspace/brain/dismiss", method: "POST", body: .object(["previewId": id]), mailbox: owner)
                            guard review.scope == owner else { return }
                            store(next, owner: owner)
                        }
                    } else { memoryPreview = .null }
                    selectedMemories = []
                }.disabled(operationBusy)
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
        let owner = scope, generation = model.draftGeneration
        guard !scopeAll, !operationBusy else { return }
        memoryPreview = .null; selectedMemories = []
        model.perform({
            findingMemories = true
            defer { findingMemories = false }
            let response = try await model.request("/workspace/brain/preview", method: "POST", body: .object([:]), mailbox: owner)
            guard review.scope == owner, model.draftGeneration == generation else { return }
            memoryPreview = response["preview"]
        }, blocksNavigation: false)
    }
    func generate() {
        var payload: JSON = .object(["action": .string(action), "prompt": .string(prompt)])
        if feature["context"].string == "selected" { payload["messageId"] = .string(chosen.id) }
        if action == "ask" { payload["useSmartSearch"] = .bool(useSmartSearch) }
        if action == "rewrite" { payload["draftText"] = .string(draftText) }
        if action == "skill" { payload["skillId"] = .string(skillID) }
        if ["followup", "schedule"].contains(action) { payload["when"] = .string(utcDate(when)) }
        let simulation = feature["mock"].bool
        let viewed = scope
        let owner = feature["context"].string == "selected" ? chosen["accountId"].string : viewed
        guard !owner.isEmpty, owner != "all", !operationBusy else { return }
        clearResult()
        let run = resultID, generation = model.draftGeneration
        model.perform({
            let response = try await model.request(simulation ? "/workflows/preview" : "/ai", method: "POST", body: payload, mailbox: owner)
            guard !Task.isCancelled, run == resultID, generation == model.draftGeneration, model.section == "studio", review.scope == viewed else { return }
            if simulation { previewOwner = owner; preview = response["preview"] } else { result = response; resultGeneration = generation }
        }, blocksNavigation: false)
    }
    func record(_ collection: String, _ item: JSON, _ payload: JSON) {
        let owner = scope, id = item.id
        guard !scopeAll, !operationBusy else { return }
        model.perform {
            let next = try await model.request("/workspace/\(collection)/" + encodedPath(id), method: "PATCH", body: payload, mailbox: owner)
            guard review.scope == owner else { return }
            store(next, owner: owner)
        }
    }
    func useDraft() {
        guard !result.isNull, resultGeneration == model.draftGeneration, !operationBusy, !model.preparingDraft else { return }
        let text = result["text"].string, message = chosen, run = resultID
        let fromAccount = action == "reply" || action == "translate" ? message["accountId"].string : scope
        guard fromAccount != "all", model.accounts.contains(where: { $0.id == fromAccount }) else { return }
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
            var draft = Draft(); draft.accountID = fromAccount; draft.body = text
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
        let ticket = UUID(), owner = scope, field = contextField
        contextTicket = ticket; contextSearching = true; contextError = ""
        let body: JSON = .object(["query": .string(""), "scope": .string(owner == "all" ? "all" : "account"), "folder": .string("inbox"), "sort": .string("newest"), "page": .number(Double(page)), "filters": .object([field: .string(query)]), "smart": .bool(false)])
        contextOperation = Task {
            defer { if contextTicket == ticket { contextSearching = false } }
            do {
                let response = try await model.request("/search", method: "POST", body: body, mailbox: owner)
                guard !Task.isCancelled, contextTicket == ticket, review.scope == owner else { return }
                contextSearch = response; contextPage = page; messageID = contextChoices.first?.viewID ?? ""
            } catch { if !Task.isCancelled && contextTicket == ticket { contextError = error.localizedDescription } }
        }
    }
    func store(_ next: JSON, owner: String) {
        guard next["account"]["id"].string == owner else { return }
        if owner == model.account { model.state = next }
        if owner == review.scope { scopedState = next }
    }
    func loadScopedState() async {
        let owner = scope
        guard !scopeAll, owner != model.account else { scopedState = .null; return }
        let ticket = UUID(); scopeStateTicket = ticket
        do {
            let next = try await model.request("/state", mailbox: owner)
            guard scopeStateTicket == ticket, review.scope == owner, next["account"]["id"].string == owner else { return }
            scopedState = next
            if !brainDirty { loadBrain() }
        } catch { if scopeStateTicket == ticket, review.scope == owner { model.error = error.localizedDescription } }
    }
    func loadLocal(offset: Int) async {
        let owner = scope
        guard !usesReadingList, offset >= 0, offset % 50 == 0 else { localMessages = []; localCursors = [""]; localNext = ""; localOwner = ""; return }
        if localOwner != owner { localMessages = []; localCursors = [""]; localNext = ""; localOwner = "" }
        let ticket = UUID(); localTicket = ticket; localLoading = true
        defer { if localTicket == ticket { localLoading = false } }
        do {
            let result = try await model.request("/mail/page", method: "POST", body: .object(["folder": .string(""), "sort": model.preferences["sort"], "unreadOnly": .bool(false), "cursor": .string(""), "offset": .number(Double(offset)), "locale": .string(Locale.current.identifier(.bcp47))]), mailbox: owner)
            guard localTicket == ticket, review.scope == owner else { return }
            let rows = result["messages"].array
            guard rows.allSatisfy({ row in
                let account = row["accountId"].string
                return model.accounts.contains { $0.id == account } && (owner == "all" || account == owner)
            }) else { throw APIError("The mail page could not be confirmed for this mailbox.") }
            localMessages = rows; localNext = result["nextCursor"].string; localOwner = owner; localCursors = Array(repeating: "", count: offset / 50 + 1)
            if contextSearch.isNull && !permitted.contains(where: { $0.viewID == messageID }) { messageID = permitted.first?.viewID ?? "" }
        } catch { if localTicket == ticket, review.scope == owner { model.error = error.localizedDescription } }
    }
    var writingRulesBox: some View {
        GroupBox("How you write") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Add short rules in your own words. Enabled rules guide Write, Reply, Rewrite and reply suggestions for this mailbox. They never send mail. Learn Now still reviews Sent mail separately and does not create or replace these rules.").font(.callout).foregroundStyle(.secondary)
                if scopeAll || !scopeStateReady {
                    Text("Choose a mailbox to edit its writing rules.").foregroundStyle(.secondary)
                } else {
                    TextArea(title: "New writing rule", text: $ruleText, height: 70)
                    if ruleText.utf16.count > 500 { Text("Use at most 500 characters.").font(.caption).foregroundStyle(.orange) }
                    Button("Add Rule") {
                        let text = ruleText.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !text.isEmpty, text.utf16.count <= 500 else { return }
                        changeWritingRule("POST", "/workspace/brain/writing-rules", .object(["text": .string(text), "enabled": .bool(true), "source": .string("user")]), resetDraft: true)
                    }.buttonStyle(.borderedProminent).disabled(ruleText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || ruleText.utf16.count > 500)
                    if workspace["brain"]["writingRules"].array.isEmpty {
                        Text("No writing rules yet. The approved Sent style stays separate.").foregroundStyle(.secondary)
                    }
                    ForEach(workspace["brain"]["writingRules"].array) { rule in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(rule["source"].string == "learned" ? "Learned" : "You wrote this").font(.caption).foregroundStyle(.secondary)
                                Spacer()
                                Text(dateLabel(rule["updatedAt"].string)).font(.caption).foregroundStyle(.secondary)
                            }
                            if editingRuleID == rule.id && rule["source"].string != "learned" {
                                TextArea(title: "Edit writing rule", text: $editingRuleText, height: 70)
                                HStack {
                                    Button("Save Rule") {
                                        let text = editingRuleText.trimmingCharacters(in: .whitespacesAndNewlines)
                                        guard !text.isEmpty, text.utf16.count <= 500 else { return }
                                        changeWritingRule("POST", "/workspace/brain/writing-rules/" + encodedPath(rule.id), .object(["text": .string(text)]))
                                    }.disabled(editingRuleText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || editingRuleText.utf16.count > 500)
                                    Button("Cancel") { editingRuleID = ""; editingRuleText = "" }
                                }
                            } else {
                                Text(rule["text"].string).textSelection(.enabled)
                                if rule["source"].string == "learned" {
                                    Text("Learned rules can be turned on or off, or deleted. Add your own rule to change the wording.").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            HStack {
                                Toggle("Enabled", isOn: Binding(get: { rule["enabled"].bool }, set: { enabled in
                                    guard enabled != rule["enabled"].bool else { return }
                                    changeWritingRule("POST", "/workspace/brain/writing-rules/" + encodedPath(rule.id), .object(["enabled": .bool(enabled)]))
                                })).toggleStyle(.checkbox)
                                if rule["source"].string != "learned" && editingRuleID != rule.id {
                                    Button("Edit") { editingRuleID = rule.id; editingRuleText = rule["text"].string }
                                }
                                Button("Delete", role: .destructive) {
                                    guard model.confirm("Delete this writing rule?", detail: "It will stop guiding drafts and replies for this mailbox. Nothing is sent.") else { return }
                                    changeWritingRule("DELETE", "/workspace/brain/writing-rules/" + encodedPath(rule.id), .object([:]))
                                }
                            }
                        }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
                    }
                    Text("Up to 30 rules. Disabled rules stay saved and are left out of prompts.").font(.caption).foregroundStyle(.secondary)
                }
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    func changeWritingRule(_ method: String, _ path: String, _ body: JSON, resetDraft: Bool = false) {
        let owner = scope
        guard !scopeAll, scopeStateReady, !operationBusy else { return }
        model.perform {
            let next = try await model.request(path, method: method, body: body, mailbox: owner)
            guard review.scope == owner else { return }
            store(next, owner: owner)
            if resetDraft { ruleText = "" }
            editingRuleID = ""
            editingRuleText = ""
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
                        let owner = scope
                        if memoryOptions["enabled"].bool && !model.confirm("Enable automatic memory suggestions?", detail: "\(owner) · \(model.state["settings"]["ai"]["model"].string)\nWeekly budget: \(Int(memoryOptions["tokenBudget"].number)) estimated tokens. Uses permitted downloaded mail while Morrow is open. Provider charges may apply. Suggestions require your review before saving.") { return }
                        guard !operationBusy else { return }
                        model.perform {
                            let next = try await model.request("/workspace/brain/settings", method: "POST", body: memoryOptions, mailbox: owner)
                            guard review.scope == owner else { return }
                            store(next, owner: owner); memoryOptions = savedMemoryOptions
                        }
                    }.buttonStyle(.borderedProminent)
                }
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    func loadBrain() { memoryOptions = savedMemoryOptions; voice = workspace["brain"]["voice"].string; notes = workspace["brain"]["notes"].string; guardrails = workspace["brain"]["guardrails"].string; savedVoice = voice; savedNotes = notes; savedGuardrails = guardrails }
}

struct SkillEdit: Identifiable { let id = UUID(); let value: JSON }
struct SkillEditor: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    let initial: JSON
    let mailbox: String
    var onSaved: (JSON) -> Void
    @State private var skill: JSON
    @State private var baseline: JSON
    @State private var error = ""
    init(initial: JSON, mailbox: String, onSaved: @escaping (JSON) -> Void) {
        self.initial = initial
        self.mailbox = mailbox
        self.onSaved = onSaved
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
                    let owner = mailbox
                    model.perform {
                        do {
                            let next = try await model.request("/skills", method: "POST", body: skill, mailbox: owner)
                            guard model.review.scope == owner else { return }
                            onSaved(next); baseline = skill; dismiss()
                        }
                        catch { self.error = error.localizedDescription }
                    }
                }.buttonStyle(.borderedProminent).disabled(!skill["name"].nonempty || !skill["instructions"].nonempty || mailbox == "all")
            }
        }.padding(28).frame(width: 660).disabled(model.busy)
        .interactiveDismissDisabled(dirty || model.busy)
        .onChange(of: skill) { _ in model.dirty("skill", dirty) }
        .onDisappear { model.dirty("skill", false) }
    }
}
