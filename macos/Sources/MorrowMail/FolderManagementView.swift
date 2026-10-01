import SwiftUI

struct FolderManagementView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    let owner: String
    let initialFolder: String
    @State private var folders: [JSON] = []
    @State private var provider = ""
    @State private var canManage = false
    @State private var operation = "create"
    @State private var sourceID = ""
    @State private var parentID = ""
    @State private var name = ""
    @State private var loading = true
    @State private var error = ""
    @State private var preview: JSON = .null
    @State private var reviewing = false
    private var source: JSON { folders.first { $0.id == sourceID } ?? .null }
    private var input: JSON { .object(["operation": .string(operation), "id": .string(sourceID), "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)), "parentId": .string(parentID)]) }
    private var dirty: Bool { operation == "create" ? !name.isEmpty : operation == "rename" ? name != source["leafName"].string : operation == "move" && parentID != source["parentId"].string }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(provider == "google" ? "Manage Gmail labels" : "Manage server folders").font(.title2.bold())
            Text(owner).foregroundStyle(.secondary).textSelection(.enabled)
            Text("Changes apply to this mailbox on its provider. System folders are protected; every change is reviewed before applying.").font(.callout).foregroundStyle(.secondary)
            if loading { ProgressView("Loading provider folders…") }
            else {
                Form {
                    Picker("Action", selection: $operation) {
                        Text("Create").tag("create"); Text("Rename").tag("rename")
                        Text("Move to another parent").tag("move"); Text("Delete").tag("delete")
                    }.onChange(of: operation) { _ in resetFields() }
                    if operation != "create" {
                        Picker(provider == "google" ? "Label" : "Folder", selection: $sourceID) {
                            Text("Choose…").tag("")
                            ForEach(folders.filter { $0["editable"].bool }) { folder in Text(folder["name"].string).tag(folder.id) }
                        }.onChange(of: sourceID) { _ in resetFields() }
                    }
                    if operation == "create" || operation == "rename" { TextField("Name", text: $name) }
                    if operation == "create" || operation == "move" {
                        Picker("Parent", selection: $parentID) {
                            Text("Mailbox root").tag("")
                            ForEach(folders.filter { (operation == "create" || $0.id != sourceID) && $0["hidden"] != .bool(true) && !["spam", "trash", "virtual"].contains($0["kind"].string) && (provider != "google" || $0["editable"].bool) }) { folder in
                                Text(folder["name"].string).tag(folder.id)
                            }
                        }
                    }
                }.disabled(model.busy || !canManage)
                if !canManage { Text("Reconnect in Settings → Mail accounts and approve mail write permission to manage labels/folders.").foregroundStyle(.orange) }
            }
            if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(model.busy)
                Button("Refresh") { model.perform { await load() } }.disabled(model.busy)
                Spacer()
                Button("Review change…") { review() }.buttonStyle(.borderedProminent)
                    .disabled(loading || model.busy || !canManage || operation != "create" && sourceID.isEmpty || ["create", "rename"].contains(operation) && name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(26).frame(width: 560).interactiveDismissDisabled(model.busy)
        .task { await load(); if folders.contains(where: { $0.id == initialFolder && $0["editable"].bool }) { sourceID = initialFolder; operation = "rename"; resetFields() } }
        .onChange(of: input) { _ in preview = .null; model.dirty("folder-management", dirty) }
        .onDisappear { model.dirty("folder-management", false) }
        .alert("Apply this provider change?", isPresented: $reviewing) {
            Button(operation == "delete" ? "Delete on provider" : "Apply change", role: operation == "delete" ? .destructive : nil) { apply() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(owner)\n\(preview["plan"]["sourceName"].string) → \(preview["plan"]["name"].string)\nAffected labels/folders: \(Int(preview["plan"]["affectedCount"].number))\n\(preview["plan"]["messageCount"].isNull ? "" : "Messages in selected folder: \(Int(preview["plan"]["messageCount"].number))\n")\(preview["plan"]["impact"].string)")
        }
    }
    private func resetFields() {
        name = operation == "create" ? "" : source["leafName"].string
        parentID = operation == "create" ? "" : source["parentId"].string
    }
    private func load() async {
        loading = true; defer { loading = false }
        do {
            let result = try await model.request("/mail/folders/manage", mailbox: owner)
            guard result["accountId"].string == owner, case .array = result["folders"] else { throw APIError("The owning folder list could not be confirmed.") }
            folders = result["folders"].array; provider = result["provider"].string; canManage = result["canManage"].bool; error = ""
            model.serverFolders[owner] = folders.filter { $0["selectable"] != .bool(false) && $0["hidden"] != .bool(true) }
        } catch { self.error = error.localizedDescription }
    }
    private func review() {
        let payload = input
        model.perform {
            do {
                let result = try await model.request("/mail/folders/preview", method: "POST", body: payload, mailbox: owner)
                guard result["accountId"].string == owner, result["previewId"].nonempty else { throw APIError("The folder review could not be confirmed.") }
                preview = result; error = ""; reviewing = true
            } catch { self.error = error.localizedDescription }
        }
    }
    private func apply() {
        let token = preview["previewId"]
        preview = .null
        model.perform {
            do {
                let result = try await model.request("/mail/folders/apply", method: "POST", body: .object(["previewId": token, "confirmed": .bool(true)]), mailbox: owner)
                guard result["accountId"].string == owner, case .array = result["folders"] else { throw APIError("The folder change could not be confirmed. Refresh before another review.") }
                folders = result["folders"].array
                model.serverFolders[owner] = folders.filter { $0["selectable"] != .bool(false) && $0["hidden"] != .bool(true) }
                if model.account == owner, let change = result["changes"].array.first(where: { model.section == "provider:" + $0["oldId"].string }) { model.section = change["newId"].nonempty ? "provider:" + change["newId"].string : "inbox" }
                sourceID = ""; name = ""; parentID = ""; operation = "create"; model.dirty("folder-management", false)
                try await model.reload(); model.notice = "Provider label/folder change confirmed."; error = ""
            } catch { self.error = error.localizedDescription }
        }
    }
}
