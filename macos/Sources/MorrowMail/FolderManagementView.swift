import SwiftUI

struct FolderManagementView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    let owner: String
    let initialFolder: String
    var creationOnly = false
    var onCreate: ((JSON, Bool) -> Void)? = nil
    @State private var folders: [JSON] = []
    @State private var provider = ""
    @State private var canManage = false
    @State private var operation = "create"
    @State private var sourceID = ""
    @State private var parentID = ""
    @State private var name = ""
    @State private var query = ""
    @State private var useForMessage = true
    @State private var loading = true
    @State private var error = ""
    @State private var preview: JSON = .null
    @State private var reviewing = false
    private var source: JSON { folders.first { $0.id == sourceID } ?? .null }
    private var input: JSON { .object(["operation": .string(operation), "id": .string(sourceID), "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)), "parentId": .string(parentID)]) }
    private var dirty: Bool { operation == "create" ? !name.isEmpty : operation == "rename" ? name != source["leafName"].string : operation == "move" && parentID != source["parentId"].string }
    private var parents: [JSON] { folders.filter { $0["hidden"] != .bool(true) && !["spam", "trash", "virtual"].contains($0["kind"].string) && (provider != "google" || $0["editable"].bool) && (operation == "create" || !folderIsWithin($0, source: source, folders: folders)) } }
    private var canReview: Bool { canManage && (operation == "create" || source["editable"].bool) && (!["create", "rename"].contains(operation) || !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(creationOnly ? (provider == "google" ? "Create Gmail label" : "Create server folder") : (provider == "google" ? "Manage Gmail labels" : "Manage server folders")).font(.title2.bold())
            Text(owner).foregroundStyle(.secondary).textSelection(.enabled)
            HStack(alignment: .top, spacing: 20) {
                if !creationOnly {
                    VStack(alignment: .leading, spacing: 10) {
                        TextField("Search names or paths…", text: $query).textFieldStyle(.roundedBorder).accessibilityLabel("Search managed labels and folders")
                        List(selection: Binding(get: { sourceID }, set: { sourceID = $0; operation = "rename"; resetFields() })) {
                            if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                OutlineGroup(folderTree(folders), children: \.children) { node in folderRow(node.folder, hierarchical: true) }
                            } else {
                                ForEach(folders.filter { $0["name"].string.localizedCaseInsensitiveContains(query.trimmingCharacters(in: .whitespacesAndNewlines)) }) { folder in folderRow(folder, hierarchical: false) }
                            }
                        }.frame(minHeight: 270)
                        Button("Create at mailbox root…") { create(parent: "") }.disabled(!canManage || model.busy)
                    }.frame(width: 270)
                }
                VStack(alignment: .leading, spacing: 14) {
                    if operation != "create" {
                        Text(source["name"].nonempty ? source["name"].string : "Choose a label or folder").font(.headline).textSelection(.enabled)
                        if !source.isNull && !source["editable"].bool { Text("System or unavailable folders cannot be changed.").foregroundStyle(.secondary) }
                        HStack {
                            Button("Rename") { operation = "rename"; resetFields() }
                            Button("Move…") { operation = "move"; resetFields() }
                            Button("Delete…", role: .destructive) { operation = "delete"; resetFields() }
                        }.disabled(!source["editable"].bool || model.busy || !canManage)
                        Button("Create child…") { create(parent: sourceID) }.disabled(!canParent(source) || !canManage || model.busy)
                    } else { Text("Create a new " + (provider == "google" ? "label" : "folder")).font(.headline) }
                    if operation == "create" || operation == "rename" { TextField("Name", text: $name).textFieldStyle(.roundedBorder) }
                    if operation == "create" || operation == "move" { FolderPicker(title: "Parent", folders: parents, selection: $parentID, rootTitle: "Mailbox root") }
                    if operation == "delete" { Text("Delete this label/folder from the account. Review its effect on messages and children before applying.").foregroundStyle(.secondary) }
                    if creationOnly { Toggle(provider == "google" ? "Select this label for the email after creation" : "Select this folder for the email after creation", isOn: $useForMessage) }
                    if !canManage && !loading { Text("Reconnect in Settings → Mail accounts and approve mail write permission to manage labels/folders.").foregroundStyle(.orange) }
                    Text("Provider changes are reviewed before applying. Cached mail and local drafts are retained.").font(.caption).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            if loading { HStack { ProgressView().controlSize(.small); Text("Refreshing folders in the background…").font(.caption).foregroundStyle(.secondary) } }
            if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button("Close") { dismiss() }.keyboardShortcut(.cancelAction).disabled(model.busy)
                Button("Refresh") { Task { await load() } }.disabled(model.busy || loading)
                Spacer()
                Button("Review change…") { review() }.buttonStyle(.borderedProminent).disabled(model.busy || !canReview)
            }
        }.padding(26).frame(width: creationOnly ? 570 : 850, height: creationOnly ? 380 : 510).interactiveDismissDisabled(model.busy)
        .task {
            let cache = model.state["serverFolders"][owner]
            folders = cache["managementFolders"].array; provider = cache["provider"].string; canManage = cache["canManage"].bool
            if !creationOnly && folders.contains(where: { $0.id == initialFolder }) { sourceID = initialFolder; operation = "rename"; resetFields() }
            await load()
            if !creationOnly && sourceID.isEmpty && folders.contains(where: { $0.id == initialFolder }) { sourceID = initialFolder; operation = "rename"; resetFields() }
        }
        .onChange(of: input) { _ in preview = .null; model.dirty("folder-management", dirty) }
        .onDisappear { model.dirty("folder-management", false) }
        .alert("Apply this provider change?", isPresented: $reviewing) {
            Button(operation == "delete" ? "Delete on provider" : "Apply change", role: operation == "delete" ? .destructive : nil) { apply() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(owner)\n\(preview["plan"]["sourceName"].string) → \(preview["plan"]["name"].string)\nAffected labels/folders: \(Int(preview["plan"]["affectedCount"].number))\n\(preview["plan"]["messageCount"].isNull ? "" : "Messages in selected folder: \(Int(preview["plan"]["messageCount"].number))\n")\(preview["plan"]["impact"].string)")
        }
    }
    private func folderRow(_ folder: JSON, hierarchical: Bool) -> some View {
        Label(hierarchical && folder["leafName"].nonempty ? folder["leafName"].string : folder["name"].string, systemImage: provider == "google" ? "tag" : "folder")
            .tag(folder.id).help(folder["name"].string)
            .contextMenu {
                Button("Rename…") { select(folder, action: "rename") }.disabled(!folder["editable"].bool || !canManage)
                Button("Move to another parent…") { select(folder, action: "move") }.disabled(!folder["editable"].bool || !canManage)
                Button("Delete from account…", role: .destructive) { select(folder, action: "delete") }.disabled(!folder["editable"].bool || !canManage)
                Button("Create child…") { create(parent: folder.id) }.disabled(!canManage || !canParent(folder))
            }
    }
    private func canParent(_ folder: JSON) -> Bool { !folder.isNull && folder["hidden"] != .bool(true) && !["spam", "trash", "virtual"].contains(folder["kind"].string) && (provider != "google" || folder["editable"].bool) }
    private func select(_ folder: JSON, action: String) { sourceID = folder.id; operation = action; resetFields() }
    private func create(parent: String) { sourceID = ""; operation = "create"; name = ""; parentID = parent }
    private func resetFields() { name = operation == "create" ? "" : source["leafName"].string; parentID = operation == "create" ? "" : source["parentId"].string }
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
        let token = preview["previewId"], createdName = preview["plan"]["name"].string, creating = operation == "create"
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
                if creating && creationOnly, let created = folders.first(where: { $0["name"].string == createdName }) { onCreate?(created, useForMessage); dismiss() }
            } catch { self.error = error.localizedDescription }
        }
    }
}
