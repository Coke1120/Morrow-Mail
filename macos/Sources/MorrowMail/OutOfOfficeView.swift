import SwiftUI

struct OutOfOfficeView: View {
    @EnvironmentObject var model: AppModel
    @Binding var dirty: Bool
    @State private var value: JSON = .null
    @State private var options: JSON = .null
    @State private var error = ""
    @State private var loading = false
    @State private var inFlight = false
    init(dirty: Binding<Bool> = .constant(false)) {
        _dirty = dirty
    }
    var owner: String { model.account }
    var live: Bool { model.state["account"]["mode"].string == "live" }
    var google: Bool { value["provider"].string == "google" }
    var changed: Bool { !options.isNull && options != value["settings"] }
    func text(_ key: String) -> Binding<String> { Binding(get: { options[key].string }, set: { options[key] = .string($0) }) }
    func date(_ key: String) -> Binding<Date> {
        Binding(get: {
            let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return parser.date(from: options[key].string) ?? ISO8601DateFormatter().date(from: options[key].string) ?? Date().addingTimeInterval(key == "end" ? 86400 : 0)
        }, set: { next in options[key] = .string(ISO8601DateFormatter().string(from: next)) })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SectionHeading(title: "Out of Office", detail: "Server-managed automatic replies continue while Morrow is closed. Gmail or Outlook controls delivery and how often each sender receives a reply.")
            Text(live ? owner : "Choose an individual connected mailbox.").font(.headline)
            if live { Button("Refresh Provider Settings") { refresh() }.disabled(loading || model.busy || inFlight) }
            if !value.isNull && !value["supported"].bool {
                Text("IMAP does not support this feature. Configure automatic replies in your provider’s webmail settings. Morrow will not send local automatic replies.").foregroundStyle(.secondary)
            }
            if value["requiresReconnect"].bool {
                Text("Reconnect this mailbox and explicitly allow Out of Office settings permission. Reading and sending mail do not grant permission to change automatic replies.")
                Text(value["requiredScope"].string).font(.caption.monospaced()).textSelection(.enabled)
                Button("Allow Out of Office Settings…", action: reconnect).disabled(loading || model.busy || inFlight)
                Text("After browser sign-in, return here and refresh provider settings.").font(.caption)
            }
            if let url = URL(string: value["providerUrl"].string), ["https://mail.google.com/mail/u/0/#settings/general", "https://outlook.live.com/mail/0/options/mail/automaticReplies"].contains(url.absoluteString) {
                Link("Open Provider Settings", destination: url)
            }
            if !options.isNull {
                fields.disabled(loading || model.busy || inFlight || !value["canWrite"].bool)
            }
            if loading || inFlight { HStack { ProgressView().controlSize(.small); Text("Contacting the mail provider…") } }
            if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
        }
        .task(id: owner) { await load(owner) }
        .onChange(of: options) { _ in dirty = changed }
        .onDisappear { dirty = false }
    }
    var fields: some View {
        VStack(alignment: .leading, spacing: 14) {
            Picker("Automatic replies", selection: text("mode")) {
                Text("Disabled").tag("disabled"); Text("Always enabled").tag("always"); Text("Scheduled").tag("scheduled")
            }
            if options["mode"].string == "scheduled" {
                Text("Dates use your device’s local timezone. \(google ? "At least one date is required; leave one blank for an open-ended schedule." : "Both dates are required.")").font(.caption).foregroundStyle(.secondary)
                ForEach(["start", "end"], id: \.self) { key in
                    HStack {
                        Toggle(key.capitalized, isOn: Binding(get: { options[key].nonempty }, set: { selected in options[key] = .string(selected ? ISO8601DateFormatter().string(from: Date().addingTimeInterval(key == "end" ? 86400 : 0)) : "") })).toggleStyle(.checkbox)
                        if options[key].nonempty { DatePicker("\(key.capitalized) time", selection: date(key)).labelsHidden() }
                    }
                }
            }
            if value["scheduleWarning"].nonempty { Text(value["scheduleWarning"].string).font(.caption).foregroundStyle(.orange) }
            if google { TextField("Subject prefix", text: text("subject")) }
            TextArea(title: google ? "Reply message" : "Reply within your organization", text: text("message"), height: 140)
            Picker(google ? "Reply audience" : "Outside your organization", selection: text("audience")) {
                if !google { Text("No external replies").tag("none") }
                Text("Contacts only").tag("contacts"); Text("All senders").tag("all")
            }
            if !google { TextArea(title: "External reply message", text: text("externalMessage"), height: 140) }
            if google { Toggle("Only my Google Workspace domain (Workspace accounts only)", isOn: Binding(get: { options["restrictToDomain"].bool }, set: { options["restrictToDomain"] = .bool($0) })).toggleStyle(.checkbox) }
            Text("Plain text only. Existing rich replies are shown as text; Save replaces their formatting. Outlook keeps separate internal and external messages. Disable preserves the provider’s existing templates.").font(.caption).foregroundStyle(.secondary)
            HStack {
                Button(options["mode"].string == "disabled" ? "Save Disabled Settings…" : "Save and Enable…") { change("save") }.buttonStyle(.borderedProminent)
                Button("Disable Automatic Replies…") { change("disable") }.disabled(value["settings"]["mode"].string == "disabled")
            }
        }
    }
    func load(_ captured: String) async {
        value = .null; options = .null; error = ""; dirty = false
        guard live else { loading = false; return }
        loading = true
        defer { if owner == captured { loading = false } }
        do {
            let result = try await model.request("/out-of-office", mailbox: captured)
            guard owner == captured, !Task.isCancelled else { return }
            value = result; options = result["settings"]; dirty = false
        } catch { if owner == captured && !Task.isCancelled { self.error = error.localizedDescription } }
    }
    func refresh() {
        guard !loading, !inFlight, !model.busy, !changed || model.confirm("Discard unsaved automatic reply edits?", detail: "Refresh will read the current provider settings.") else { return }
        let captured = owner
        Task { await load(captured) }
    }
    func change(_ action: String) {
        guard live, !model.busy, !loading, !inFlight, value["canWrite"].bool else { return }
        let captured = owner
        let label = action == "disable" ? "Disable" : options["mode"].string == "disabled" ? "Save disabled settings for" : "Save and enable"
        let detail = action == "disable" ? "The provider will stop sending automatic replies. Existing templates are retained.\(changed ? " Unsaved edits in this form will be discarded." : "")" : "The provider will store these plain-text replies. Mode: \(options["mode"].string). Audience: \(options["audience"].string)\(options["restrictToDomain"].bool ? " · Google Workspace domain only" : ""). Saving replaces any existing rich formatting."
        guard model.confirm("\(label) automatic replies for \(captured)?", detail: "\(detail)\n\nEnabled replies continue while Morrow is closed. No mail is sent by this button."), owner == captured else { return }
        var body = options; body["action"] = .string(action); body["confirmed"] = .bool(true); body["revision"] = value["revision"]
        inFlight = true; error = ""
        model.perform {
            defer { inFlight = false }
            do {
                let result = try await model.request("/out-of-office", method: "PUT", body: body, mailbox: captured)
                guard owner == captured else { return }
                value = result; options = result["settings"]; dirty = false
            } catch { if owner == captured { self.error = error.localizedDescription } }
        }
    }
    func reconnect() {
        guard live, !model.busy, !loading, !inFlight, value["supported"].bool else { return }
        let captured = owner, provider = value["provider"].string
        guard model.confirm("Allow Out of Office settings access for \(captured)?", detail: "The browser will request \(value["requiredScope"].string). This permission lets Morrow read and change your provider’s automatic reply settings. Enabling replies still requires a separate Save confirmation."), owner == captured else { return }
        inFlight = true; error = ""
        model.perform {
            defer { inFlight = false }
            do {
                let result = try await model.request("/oauth/\(provider)/start", method: "POST", body: .object(["outOfOffice": .bool(true), "forAccount": .string(captured)]), mailbox: captured)
                guard owner == captured else { return }
                try model.openOAuth(result, provider: provider, calendar: false)
            } catch { if owner == captured { self.error = error.localizedDescription } }
        }
    }
}
