import SwiftUI
import AppKit
import Darwin

struct AttachmentReader: View {
    @EnvironmentObject var model: AppModel
    let message: JSON
    @State private var downloaded: JSON = .null
    @State private var busy = false
    @State private var error = ""
    private var current: JSON { downloaded.isNull ? message : downloaded }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if message["hasAttachments"].isNull || message["hasAttachments"].bool || current["contentIncomplete"].bool || !current["attachments"].array.isEmpty || message["bodyHtml"].string.contains("cid:") {
                Button("Load attachments and inline images…") { load() }.disabled(busy || model.busy)
                ForEach(current["attachments"].array) { item in
                    HStack {
                        Label(item["name"].string, systemImage: "paperclip").lineLimit(2)
                        Text(ByteCountFormatter.string(fromByteCount: Int64(item["size"].number), countStyle: .file)).foregroundStyle(.secondary)
                        Spacer()
                        Button("Save…") { save(item) }.disabled(busy || model.busy)
                    }
                }
            }
            if busy { ProgressView().controlSize(.small) }
            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.orange) }
            SecureMessageBody(message: current, autoLoadExternalImages: model.preferences["autoLoadExternalImages"].bool)
        }
    }
    func load() {
        guard !busy, !model.busy else { return }
        busy = true; error = ""
        let owner = message["accountId"].string, id = message.id
        model.perform {
            defer { busy = false }
            do {
                let result = try await model.request("/messages/" + encodedPath(id) + "/attachments", method: "POST", body: .object([:]), mailbox: owner)
                guard result["message"]["accountId"].string == owner, result["message"].id == id else { throw APIError("Attachment ownership could not be confirmed.") }
                downloaded = result["message"]
            } catch { self.error = error.localizedDescription }
        }
    }
    func save(_ item: JSON) {
        guard !busy, !model.busy else { return }
        let panel = NSSavePanel(); panel.nameFieldStringValue = item["name"].string
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        let owner = message["accountId"].string
        busy = true; error = ""
        model.perform {
            defer { busy = false }
            do {
                let result = try await model.request("/attachments/" + encodedPath(item.id), mailbox: owner)
                let value = result["attachment"]
                guard value.id == item.id, let data = Data(base64Encoded: value["data"].string), data.count == Int(value["size"].number) else { throw APIError("Attachment download could not be verified.") }
                try await Task.detached(priority: .userInitiated) {
                    let temporary = destination.deletingLastPathComponent().appendingPathComponent(".morrow-\(UUID().uuidString).download")
                    defer { try? FileManager.default.removeItem(at: temporary) }
                    try data.write(to: temporary, options: .withoutOverwriting)
                    let quarantine = "0081;\(String(Int(Date().timeIntervalSince1970), radix: 16));Morrow Mail;"
                    let status = quarantine.withCString { setxattr(temporary.path, "com.apple.quarantine", $0, strlen($0), 0, 0) }
                    guard status == 0 else { throw APIError("The downloaded-file security marker could not be set. Choose another destination.") }
                    guard rename(temporary.path, destination.path) == 0 else { throw APIError("The attachment could not be moved to the selected destination.") }
                }.value
            } catch { self.error = error.localizedDescription }
        }
    }
}

