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
                        }.frame(height: 270)
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
                    if !creationOnly { Spacer(minLength: 0) }
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
        }.padding(26).frame(width: creationOnly ? 570 : 850).disabled(model.busy).interactiveDismissDisabled(model.busy)
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

struct MessageOrganizationActions: View {
    @EnvironmentObject var model: AppModel
    let message: JSON
    private var gmail: Bool { model.accounts.first { $0.id == message["accountId"].string }?["provider"].string == "google" }
    var body: some View {
        Button("Move to…") { model.beginOrganize(message) }
        if gmail { Button("Labels…") { model.beginOrganize(message, preferredKind: "labels") } }
        Button(gmail ? "Create new label…" : "Create new folder…") { model.beginOrganize(message, preferredKind: "create") }
        Divider()
        Button(gmail ? "Manage labels…" : "Manage folders…") { model.managingFolders = .object(["id": message["accountId"]]) }
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
    @State private var baseline = Set<String>()
    @State private var selected = Set<String>()
    @State private var query = ""
    @State private var localError = ""
    @State private var review = false
    @State private var showManager = false
    @State private var creating = false
    private var owner: String { message["accountId"].string }
    private var added: [String] { selected.subtracting(baseline).sorted() }
    private var removed: [String] { baseline.subtracting(selected).sorted() }
    private var choices: [JSON] { folders.filter { $0["selectable"] != .bool(false) && $0["hidden"] != .bool(true) } }
    private var canReview: Bool { mode == "labels" ? !added.isEmpty || !removed.isEmpty : choices.contains { $0.id == destination } }
    private func names(_ ids: [String]) -> String { ids.map { id in folders.first { $0.id == id }?["name"].string ?? id }.joined(separator: ", ") }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(mode == "labels" ? "Labels on this email" : "Move email on provider").font(.title2.bold())
            Text(message["subject"].string).lineLimit(2)
            Text(owner).foregroundStyle(.secondary).textSelection(.enabled)
            if provider == "google" {
                Picker("Action", selection: $mode) { Text("Move to").tag("move"); Text("Labels").tag("labels") }.pickerStyle(.segmented)
            }
            if mode == "labels" {
                TextField("Search label names or paths…", text: $query).textFieldStyle(.roundedBorder).accessibilityLabel("Search email labels")
                List {
                    ForEach(choices.filter { $0["kind"].string == "label" && (query.isEmpty || $0["name"].string.localizedCaseInsensitiveContains(query)) }) { folder in
                        Toggle(folder["name"].string, isOn: Binding(get: { selected.contains(folder.id) }, set: { if $0 { selected.insert(folder.id) } else { selected.remove(folder.id) } })).help(folder["name"].string)
                    }
                }.frame(height: 230).disabled(loading)
                Text("Selected: \(selected.intersection(Set(choices.filter { $0["kind"].string == "label" }.map(\.id))).count)").font(.caption).foregroundStyle(.secondary)
                Text("Checked labels stay on this email. Unchecking removes a label from this email only; Inbox and other messages are unchanged.").font(.caption).foregroundStyle(.secondary)
            } else {
                FolderPicker(title: provider == "google" ? "Label / location" : "Folder", folders: choices, selection: $destination, onCreate: { creating = true; showManager = true })
                Text(provider == "google" ? "Move adds the chosen label and removes Inbox; other labels remain. Spam and Trash are provider moves." : "Move this email to the selected folder within the account shown above.").font(.callout).foregroundStyle(.secondary)
            }
            HStack {
                Button(provider == "google" ? "Create new label…" : "Create new folder…") { creating = true; showManager = true }.disabled(model.busy)
                Button(provider == "google" ? "Manage labels…" : "Manage folders…") { creating = false; showManager = true }.disabled(model.busy)
            }
            if provider == "google" { Link("Open Gmail to report or block", destination: URL(string: "https://mail.google.com/")!) }
            else if provider == "microsoft" { Link("Open Outlook to report or block", destination: URL(string: "https://outlook.live.com/mail/")!) }
            if loading { HStack { ProgressView().controlSize(.small); Text("Refreshing saved labels / folders…").font(.caption).foregroundStyle(.secondary) } }
            if !localError.isEmpty { Text(localError).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(model.busy)
                Spacer()
                Button("Review change…") { review = true }.buttonStyle(.borderedProminent).disabled(model.busy || !canReview)
            }
        }.padding(26).frame(width: 590).disabled(model.busy).interactiveDismissDisabled(model.busy)
        .task {
            let cache = model.state["serverFolders"][owner]
            provider = cache["provider"].nonempty ? cache["provider"].string : model.accounts.first { $0.id == owner }?["provider"].string ?? ""
            folders = model.serverFolders[owner] ?? []
            if provider == "google" { folders.append(.object(["id": .string("__archive"), "name": .string("Archive (remove Inbox)"), "kind": .string("archive")])) }
            mode = preferredKind == "labels" ? "labels" : "move"
            destination = preferredDestination
            var detail = message
            if provider == "google" && message["providerLabelIds"].isNull {
                do {
                    detail = try await model.request("/messages/" + encodedPath(message.id), mailbox: owner)["message"]
                    guard detail["accountId"].string == owner, detail.id == message.id else { throw APIError("The email owner could not be confirmed.") }
                } catch { localError = error.localizedDescription; return }
            }
            baseline = Set(detail["providerLabelIds"].array.map(\.string)); selected = baseline
            loading = false
            if preferredKind == "create" { creating = true; showManager = true }
            do {
                let result = try await model.request("/mail/folders", mailbox: owner)
                guard result["accountId"].string == owner, case .array = result["folders"] else { throw APIError("The owning folder list could not be confirmed.") }
                folders = result["folders"].array; provider = result["provider"].string
                model.serverFolders[owner] = folders.filter { $0.id != "__archive" }
            } catch { localError = error.localizedDescription }
            loading = false
        }
        .sheet(isPresented: $showManager, onDismiss: {
            folders = model.serverFolders[owner] ?? folders
            if provider == "google" { folders.append(.object(["id": .string("__archive"), "name": .string("Archive (remove Inbox)"), "kind": .string("archive")])) }
        }) {
            FolderManagementView(owner: owner, initialFolder: "", creationOnly: creating, onCreate: { folder, use in
                if !folders.contains(where: { $0.id == folder.id }) { folders.append(folder) }
                if use { if provider == "google" { mode = "labels"; selected.insert(folder.id) } else { mode = "move"; destination = folder.id } }
            }).environmentObject(model)
        }
        .confirmationDialog("Apply this change on your mail provider?", isPresented: $review, titleVisibility: .visible) {
            Button("Apply provider change") {
                let payload: JSON = mode == "labels" ? .object(["mode": .string("labels"), "addLabelIds": .array(added.map(JSON.string)), "removeLabelIds": .array(removed.map(JSON.string)), "confirmed": .bool(true)]) : .object(["destinationId": .string(destination), "mode": .string("move"), "confirmed": .bool(true)])
                model.perform {
                    do {
                        let result = try await model.request("/messages/" + encodedPath(message.id) + "/organize", method: "POST", body: payload, mailbox: owner)
                        guard result["message"].id == message.id, result["message"]["accountId"].string == owner else { throw APIError("The provider change could not be confirmed. Refresh this mailbox.") }
                        try await model.reload(); model.notice = "Provider change confirmed."; dismiss()
                    } catch { localError = error.localizedDescription }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(mode == "labels" ? "Account: \(owner)\nAdd: \(names(added))\nRemove from this email: \(names(removed))" : "Account: \(owner)\nMove to: \(names([destination]))")
        }
    }
}
