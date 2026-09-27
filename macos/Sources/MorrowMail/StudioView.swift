import SwiftUI
import AppKit

struct StudioView: View {
    @EnvironmentObject var model: AppModel
    private var tab: String { model.studioTab }
    @State private var action = "summary"
    @State private var messageID = ""
    @State private var skillID = ""
    @State private var prompt = ""
    @State private var draftText = ""
    @State private var result: JSON = .null
    @State private var preview: JSON = .null
    @State private var when = Date().addingTimeInterval(86400)
    @State private var voice = ""
    @State private var notes = ""
    @State private var savedVoice = ""
    @State private var savedNotes = ""
    @State private var skillEditor: SkillEdit?
    var feature: JSON { model.features.first { $0.id == action } ?? .null }
    var workspace: JSON { model.state["workspace"] }
    var permitted: [JSON] { (model.listedMessages + (model.current.map { current in model.listedMessages.contains { $0.viewID == current.viewID } ? [] : [current] } ?? [])).filter { model.policy["folders"][$0["folder"].string].bool } }
    var chosen: JSON { permitted.first { $0.id == messageID } ?? .null }
    var brainDirty: Bool { voice != savedVoice || notes != savedNotes }
    var blocked: Bool {
        !model.allowed(action) || (feature["context"].string == "selected" && chosen.isNull) ||
        (feature["context"].string == "draft" && draftText.isEmpty) ||
        (["ask", "write"].contains(action) && prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) ||
        (action == "skill" && skillID.isEmpty)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                SectionHeading(title: "AI Studio", detail: "Thoughtful tools. You’re in control.")
                Text(model.state["settings"]["ai"]["configured"].bool ? model.state["settings"]["ai"]["model"].string : "Demo responses").font(.caption).foregroundStyle(morrowGreen).padding(8).background(morrowGreen.opacity(0.08)).clipShape(Capsule())
                Button("Permissions") { model.settings("permissions") }.disabled(model.busy)
            }
            Picker("Studio section", selection: Binding(get: { tab }, set: { value in
                guard !model.busy else { return }
                if brainDirty && !model.confirmDiscard("Discard unsaved Brain notes?") { return }
                voice = savedVoice; notes = savedNotes; model.studioTab = value
            })) {
                Text("All Tools").tag("tools"); Text("Summaries").tag("summaries"); Text("Email Brain").tag("brain"); Text("My Skills").tag("skills"); Text("Local Activity").tag("activity")
            }.pickerStyle(.segmented)
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
            action = model.assistantAction
            messageID = permitted.first(where: { $0.viewID == model.selectedMessage })?.id ?? permitted.first?.id ?? ""
            skillID = workspace["skills"].array.first(where: { $0["enabled"].bool })?.id ?? ""
            loadBrain()
        }
        .onChange(of: action) { _ in clearResult() }
        .onChange(of: messageID) { _ in clearResult() }
        .onChange(of: model.mailPage) { _ in if !permitted.contains(where: { $0.id == messageID }) { messageID = permitted.first?.id ?? "" } }
        .onChange(of: skillID) { _ in clearResult() }
        .onChange(of: prompt) { _ in clearResult() }
        .onChange(of: draftText) { _ in clearResult() }
        .onChange(of: when) { _ in clearResult() }
        .onChange(of: voice) { _ in model.dirty("brain", brainDirty) }
        .onChange(of: notes) { _ in model.dirty("brain", brainDirty) }
        .onDisappear { model.dirty("brain", false) }
        .sheet(item: $skillEditor) { skill in SkillEditor(initial: skill.value).environmentObject(model) }
    }
    var summariesPage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    SectionHeading(title: "Scheduled & new-mail summaries", detail: "Latest 20 jobs for this account. P0 emergency · P1 due today · P2 action · P3 information · P4 bulk. Review AI priorities.")
                    Button("Refresh") { model.perform { try await model.reload() } }.disabled(model.busy)
                }
                Text("Configure triggers in Settings → AI Permissions. Summaries use cached mail and saved permissions. Results are hidden if the model, language, permissions, connection or source scope changes.").font(.callout).foregroundStyle(.secondary)
                if workspace["summaryOverflow"].number > 0 { Text("\(Int(workspace["summaryOverflow"].number)) jobs exceeded the queue limit. Use a manual summary for those messages.").foregroundStyle(.orange) }
                ForEach(model.state["syncErrors"].array) { item in Text(item["accountId"].string + ": " + item["error"].string).foregroundStyle(.orange) }
                if workspace["summaries"].array.isEmpty { Text("No summaries yet. Enable a trigger and wait for a scheduled time or newly synced mail.").foregroundStyle(.secondary) }
                ForEach(workspace["summaries"].array) { report in SummaryReportView(report: report) }
            }.padding(20)
        }
    }
    var toolsPage: some View {
        HSplitView {
            List(model.features, selection: $action) { item in
                VStack(alignment: .leading, spacing: 5) {
                    Text(item["label"].string).font(.system(size: 13, weight: .medium))
                    Text(model.allowed(item.id) ? (item["mock"].bool ? "Local simulation" : "On-demand AI") : "Disabled in permissions").font(.caption2).foregroundStyle(model.allowed(item.id) ? .secondary : .tertiary)
                }.padding(.vertical, 6).tag(item.id)
            }.listStyle(.inset).frame(minWidth: 200, idealWidth: 235, maxWidth: 300).disabled(model.busy)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text(feature["label"].string).font(.title2.bold())
                    Text(feature["description"].string).foregroundStyle(.secondary)
                    if feature["mock"].bool {
                        Label("Local simulation. Preview and apply inside Morrow. No external research, attachments, invitations, unsubscribe, or automatic sending.", systemImage: "checkmark.shield").font(.callout).foregroundStyle(.secondary)
                    }
                    if feature["context"].string == "selected" {
                        Picker("Email context", selection: $messageID) {
                            if permitted.isEmpty { Text("No permitted messages").tag("") }
                            ForEach(permitted) { item in Text(model.policy["content"]["subject"].bool ? item["subject"].string : "Subject withheld · " + dateLabel(item["date"].string)).tag(item.id) }
                        }
                    }
                    if feature["context"].string == "selected" {
                        HStack {
                            Button("Previous messages") { Task { await model.turnMailPage(next: false) } }.disabled(model.mailCursors.count < 2 || model.mailLoading)
                            Text("Page \(model.mailCursors.count)").font(.caption)
                            Button("Next messages") { Task { await model.turnMailPage(next: true) } }.disabled(!model.mailPage["nextCursor"].nonempty || model.mailLoading)
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
                    if !feature["mock"].bool { TextArea(title: action == "ask" ? "Your question" : action == "write" ? "What would you like to say?" : action == "translate" ? "Language or translation instructions" : "Additional instructions (optional)", text: $prompt, height: 70) }
                    if ["followup", "schedule"].contains(action) { DatePicker("Proposed date & time", selection: $when, in: Date()...) }
                    if !model.allowed(action) { Text("Enable this behavior in Settings → AI Permissions to use it.").foregroundStyle(.orange) }
                    HStack {
                        Button(feature["mock"].bool ? "Create Preview" : "Generate Response") { generate() }.buttonStyle(.borderedProminent).disabled(blocked || model.busy)
                        if model.busy { ProgressView().controlSize(.small) }
                    }
                    if !result.isNull {
                        Divider()
                        Text(result["source"].string == "demo" ? "Illustrative demo result" : "Your AI result").font(.headline)
                        Text(result["text"].string).textSelection(.enabled).lineSpacing(5)
                        HStack {
                            Button("Copy") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(result["text"].string, forType: .string) }
                            if ["write", "reply", "rewrite", "translate"].contains(action) { Button("Review in a Draft") { useDraft() } }
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
                            Button("Dismiss Preview") { preview = .null }
                            Button("Apply Local Simulation") {
                                model.perform {
                                    model.state = try await model.request("/workflows/apply", method: "POST", body: .object(["previewId": preview["id"]]))
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
                SectionHeading(title: "Your Email Brain", detail: "Save the writing preferences and context you want your assistant to remember. Saved notes are used only when permitted.")
                TextArea(title: "Writing voice", text: $voice, height: 85)
                TextArea(title: "Notes to remember", text: $notes, height: 130)
                HStack {
                    Button("Save Brain") {
                        model.perform {
                            model.state = try await model.request("/workspace/brain", method: "POST", body: .object(["voice": .string(voice), "notes": .string(notes)]))
                            loadBrain(); model.dirty("brain", false); model.notice = "Brain notes saved."
                        }
                    }.buttonStyle(.borderedProminent)
                    Button("Discard Changes") { loadBrain(); model.dirty("brain", false) }.disabled(!brainDirty)
                    Button("Clear Brain") {
                        guard model.confirm("Clear your Email Brain?", detail: "Saved voice, notes, and contacts will be removed.") else { return }
                        model.perform { model.state = try await model.request("/workspace/brain", method: "DELETE", body: .object([:])); loadBrain(); model.dirty("brain", false) }
                    }
                }
                Divider()
                Text("Saved contacts").font(.headline)
                ForEach(Array(workspace["brain"]["contacts"].array.enumerated()), id: \.offset) { _, item in Label("\(item["name"].string) · \(item["email"].string)", systemImage: "person.crop.circle") }
                if workspace["brain"]["contacts"].array.isEmpty { Text("Preview Email Brain from All Tools to create local contact notes.").foregroundStyle(.secondary) }
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
    func generate() {
        var payload: JSON = .object(["action": .string(action), "prompt": .string(prompt)])
        if feature["context"].string == "selected" { payload["messageId"] = .string(messageID) }
        if action == "rewrite" { payload["draftText"] = .string(draftText) }
        if action == "skill" { payload["skillId"] = .string(skillID) }
        if ["followup", "schedule"].contains(action) { payload["when"] = .string(utcDate(when)) }
        let simulation = feature["mock"].bool
        clearResult()
        model.perform {
            let response = try await model.request(simulation ? "/workflows/preview" : "/ai", method: "POST", body: payload)
            if simulation { preview = response["preview"] } else { result = response }
        }
    }
    func record(_ collection: String, _ item: JSON, _ payload: JSON) { model.perform { model.state = try await model.request("/workspace/\(collection)/" + encodedPath(item.id), method: "PATCH", body: payload) } }
    func useDraft() {
        var draft = action == "reply" ? Draft(message: chosen, reply: true) : Draft()
        draft.body = result["text"].string
        if action == "translate" { draft.subject = chosen["subject"].string }
        model.newDraft(draft)
    }
    func clearResult() { result = .null; preview = .null }
    func loadBrain() { voice = workspace["brain"]["voice"].string; notes = workspace["brain"]["notes"].string; savedVoice = voice; savedNotes = notes }
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
