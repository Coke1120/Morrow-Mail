import SwiftUI

struct SourceLinksView: View {
    @EnvironmentObject var model: AppModel
    let sources: [JSON]
    var body: some View {
        DisclosureGroup("Mail supplied as context (\(sources.count))") {
            ForEach(sources) { source in
                Button {
                    model.perform { try await model.openSource(source) }
                } label: {
                    Text((source["reference"].number > 0 ? "[\(Int(source["reference"].number))] " : "") + (source["subject"].nonempty ? source["subject"].string : "(Subject withheld)") + " · " + dateLabel(source["date"].string))
                        .font(.caption).multilineTextAlignment(.leading)
                }.disabled(!model.canNavigate)
            }
        }.font(.caption)
    }
}

struct LocalRulesView: View {
    @EnvironmentObject var model: AppModel
    @State private var condition = "domain"
    @State private var value = ""
    @State private var action = "lowPriority"
    @State private var rules: [JSON] = []
    @State private var preview: JSON = .null
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                SectionHeading(title: "Local Inbox Rules", detail: "Review exact matches before applying a local marker.")
                Text("Checks the newest 500 downloaded Inbox messages in this mailbox. Rules run only when you preview and apply them. Mail stays in its provider folder; Later is a local review view.").font(.callout).foregroundStyle(.secondary)
                if model.combined || model.accounts.isEmpty {
                    Text("Choose one connected mailbox above.")
                } else {
                    Picker("Match", selection: $condition) { Text("Sender address equals").tag("sender"); Text("Sender domain equals").tag("domain"); Text("Subject contains").tag("subject") }
                    TextField(condition == "domain" ? "example.com" : condition == "sender" ? "sender@example.com" : "Match text", text: $value)
                    Picker("Local marker", selection: $action) { Text("Read later").tag("lowPriority"); Text("Pending").tag("pending"); Text("Star").tag("starred") }
                    Button("Preview Matches") { review() }.disabled(model.busy || value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if !preview.isNull {
                        Text("\(preview["messages"].array.count) matches among \(Int(preview["scanned"].number)) downloaded Inbox messages").font(.headline)
                        ForEach(preview["messages"].array) { message in Text(message["fromEmail"].string + " · " + message["subject"].string).font(.callout) }
                        Button("Apply Reviewed Matches & Save Rule") {
                            let owner = model.account, id = preview["previewId"]
                            model.perform {
                                let result = try await model.request("/workspace/rules/apply", method: "POST", body: .object(["previewId": id]), mailbox: owner)
                                preview = .null; rules = try await model.request("/workspace/rules", mailbox: owner)["rules"].array
                                try await model.reload(); model.notice = "Applied \(Int(result["applied"].number)) local markers. Saved rule runs only after another review."
                            }
                        }.buttonStyle(.borderedProminent).disabled(model.busy)
                        Text("Preview expires in ten minutes. Changed mail or a reconnected account requires a new review.").font(.caption).foregroundStyle(.secondary)
                    }
                    Divider()
                    Text("Saved rules").font(.headline)
                    ForEach(rules) { rule in
                        HStack {
                            Text(rule["condition"].string + ": " + rule["value"].string + " → " + (rule["action"].string == "lowPriority" ? "Later" : rule["action"].string.capitalized))
                            Spacer()
                            Button("Review") { condition = rule["condition"].string; value = rule["value"].string; action = rule["action"].string; review() }
                            Button("Remove") { let owner = model.account; model.perform { _ = try await model.request("/workspace/rules/" + encodedPath(rule.id), method: "DELETE", mailbox: owner); rules = try await model.request("/workspace/rules", mailbox: owner)["rules"].array } }
                        }.disabled(model.busy)
                    }
                }
            }.padding(20).frame(maxWidth: 900, alignment: .leading).disabled(model.busy)
        }
        .task(id: model.account) {
            preview = .null; rules = []
            let owner = model.account
            guard !model.combined, model.accounts.contains(where: { $0.id == owner }) else { return }
            do { let next = try await model.request("/workspace/rules", mailbox: owner); if model.account == owner { rules = next["rules"].array } }
            catch { if model.account == owner { model.error = error.localizedDescription } }
        }
        .onChange(of: condition) { _ in preview = .null }
        .onChange(of: value) { _ in preview = .null }
        .onChange(of: action) { _ in preview = .null }
    }
    private func review() {
        let owner = model.account, rule: JSON = .object(["condition": .string(condition), "value": .string(value), "action": .string(action)])
        preview = .null
        model.perform { let next = try await model.request("/workspace/rules/preview", method: "POST", body: rule, mailbox: owner); if model.account == owner { preview = next } }
    }
}
