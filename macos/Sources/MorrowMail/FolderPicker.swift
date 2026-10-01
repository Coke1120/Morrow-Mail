import SwiftUI

struct FolderNode: Identifiable {
    let folder: JSON
    var children: [FolderNode]?
    var id: String { folder.id }
}

func folderTree(_ folders: [JSON]) -> [FolderNode] {
    let ids = Set(folders.map(\.id))
    var seen = Set<String>()
    // ponytail: at most 1,000 provider labels; index children if that bound grows.
    func branch(_ folder: JSON) -> FolderNode {
        seen.insert(folder.id)
        let children = folders.filter { $0["parentId"].string == folder.id && !seen.contains($0.id) }.sorted { $0["name"].string.localizedStandardCompare($1["name"].string) == .orderedAscending }.map(branch)
        return FolderNode(folder: folder, children: children.isEmpty ? nil : children)
    }
    let ordered = folders.sorted { $0["name"].string.localizedStandardCompare($1["name"].string) == .orderedAscending }
    var roots = ordered.filter { !ids.contains($0["parentId"].string) }.map(branch)
    for folder in ordered where !seen.contains(folder.id) { roots.append(branch(folder)) }
    return roots
}

func folderIsWithin(_ folder: JSON, source: JSON, folders: [JSON]) -> Bool {
    guard !source.id.isEmpty else { return false }
    var id = folder.id
    var seen = Set<String>()
    while !id.isEmpty && seen.insert(id).inserted {
        if id == source.id { return true }
        id = folders.first { $0.id == id }?["parentId"].string ?? ""
    }
    let delimiter = source["delimiter"].string
    return !delimiter.isEmpty && folder["name"].string.hasPrefix(source["name"].string + delimiter)
}

struct FolderPicker: View {
    let title: String
    let folders: [JSON]
    @Binding var selection: String
    var rootTitle: String? = nil
    var onCreate: (() -> Void)? = nil
    @State private var showing = false
    @State private var query = ""
    @State private var highlighted: String?
    @FocusState private var searching: Bool
    private var choices: [JSON] {
        let all = (rootTitle.map { [JSON.object(["id": .string(""), "name": .string($0)])] } ?? []) + folders
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return all.filter { text.isEmpty || $0["name"].string.localizedCaseInsensitiveContains(text) }
    }
    private func choose() {
        guard let id = highlighted, choices.contains(where: { $0.id == id }) else { return }
        selection = id; showing = false
    }
    var body: some View {
        HStack {
            Text(title)
            Spacer()
            Button { query = ""; highlighted = choices.contains(where: { $0.id == selection }) ? selection : choices.first?.id; showing = true } label: {
                HStack {
                    Text(folders.first { $0.id == selection }?["name"].string ?? (selection.isEmpty ? rootTitle ?? "Choose…" : selection)).lineLimit(1).truncationMode(.middle)
                    Image(systemName: "chevron.up.chevron.down").font(.caption)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(minWidth: 200).accessibilityLabel(title)
            .popover(isPresented: $showing, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: 10) {
                    TextField("Search names or paths…", text: $query).textFieldStyle(.roundedBorder).focused($searching).accessibilityLabel("Search " + title)
                        .onSubmit(choose)
                        .onMoveCommand { direction in
                            let rows = choices
                            guard !rows.isEmpty else { return }
                            let current = rows.firstIndex { $0.id == highlighted } ?? -1
                            if direction == .down { highlighted = rows[min(current + 1, rows.count - 1)].id }
                            if direction == .up { highlighted = rows[max(current - 1, 0)].id }
                        }
                    List(selection: $highlighted) {
                        ForEach(choices) { folder in
                            Button { highlighted = folder.id; choose() } label: {
                                HStack { Text(folder["name"].string); Spacer(); if selection == folder.id { Image(systemName: "checkmark") } }.contentShape(Rectangle())
                            }.buttonStyle(.plain).tag(folder.id).help(folder["name"].string)
                        }
                    }.frame(height: 250)
                    if choices.isEmpty { Text("No matching labels or folders.").foregroundStyle(.secondary) }
                    if let onCreate { Button("Create new label / folder…") { showing = false; onCreate() } }
                }.padding(14).frame(width: 390)
                .onAppear { searching = true }
                .onChange(of: query) { _ in highlighted = choices.first?.id }
                .onExitCommand { showing = false }
            }
        }
    }
}
