import Foundation

// The API owns feature and permission definitions; the native client consumes the
// same schema as the web client instead of maintaining a second feature catalog.
enum JSON: Codable, Equatable, Hashable, Sendable, Identifiable {
    case object([String: JSON]), array([JSON]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([JSON].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSON].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    subscript(key: String) -> JSON {
        get { if case .object(let v) = self { return v[key] ?? .null }; return .null }
        set { var v = object; v[key] = newValue; self = .object(v) }
    }
    var object: [String: JSON] { if case .object(let v) = self { return v }; return [:] }
    var array: [JSON] { if case .array(let v) = self { return v }; return [] }
    var string: String { if case .string(let v) = self { return v }; return "" }
    var bool: Bool { if case .bool(let v) = self { return v }; return false }
    var number: Double { if case .number(let v) = self { return v }; return 0 }
    var id: String { self["id"].string }
    var viewID: String { self["viewId"].nonempty ? self["viewId"].string : id }
    var isNull: Bool { self == .null }
    var nonempty: Bool { !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    func picking(_ keys: [String]) -> JSON { .object(object.filter { keys.contains($0.key) }) }
    static func text(_ value: String) -> JSON { .string(value) }
}

struct APIError: LocalizedError {
    let payload: JSON
    var errorDescription: String? { payload["error"].nonempty ? payload["error"].string : "Morrow could not complete this request." }
    init(_ message: String) { payload = .object(["error": .string(message)]) }
    init(payload: JSON) { self.payload = payload }
}

struct Draft: Identifiable, Equatable {
    var id = UUID().uuidString
    var accountID = ""
    var savedID = ""
    var requestID = UUID().uuidString
    var to = "", cc = "", bcc = "", subject = "", body = "", replyToID = ""
    var footer: JSON = .null
    var unconfirmed = false
    var forwarding = false
    var sourceDraft = false
    var payload: JSON {
        var value: [String: JSON] = ["to": .string(to), "cc": .string(cc), "bcc": .string(bcc), "subject": .string(subject), "body": .string(body)]
        if !footer.isNull { value["footer"] = footer }
        if !savedID.isEmpty { value["id"] = .string(savedID) }
        if !replyToID.isEmpty { value["replyToId"] = .string(replyToID) }
        return .object(value)
    }
    init() {}
    init(message: JSON, reply: Bool = false) {
        accountID = message["accountId"].string
        if reply {
            to = Self.mailboxes(message[message["folder"].string == "sent" ? "to" : "fromEmail"].string).joined(separator: ", ")
            subject = message["subject"].string.lowercased().hasPrefix("re:") ? message["subject"].string : "Re: " + message["subject"].string
            replyToID = message.id
        } else {
            sourceDraft = message["providerDraft"].bool
            savedID = sourceDraft ? "" : message.id; to = message["to"].string; cc = message["cc"].string; bcc = message["bcc"].string
            subject = message["subject"].string; body = message["body"].string; footer = message["footer"]
            if sourceDraft {
                to = Self.mailboxes(to).joined(separator: ", ")
                cc = Self.mailboxes(cc).joined(separator: ", ")
                bcc = Self.mailboxes(bcc).joined(separator: ", ")
            }
            replyToID = message["replyToId"].string
            unconfirmed = message["deliveryStatus"].string == "unconfirmed"
            if message["deliveryRequestId"].nonempty { requestID = message["deliveryRequestId"].string }
        }
    }
    init(message: JSON, replyAll: Bool) {
        self.init(message: message, reply: true)
        guard replyAll else { return }
        var seen: Set<String> = [accountID == "demo" ? "alex@genmail.example" : accountID.lowercased()]
        func unique(_ fields: [String]) -> String {
            fields.flatMap { Self.mailboxes(message[$0].string) }.filter { seen.insert($0.lowercased()).inserted }.joined(separator: ", ")
        }
        to = unique(message["folder"].string == "sent" ? ["to"] : ["fromEmail", "to"])
        cc = unique(["cc"])
    }
    init(forwarding message: JSON) {
        accountID = message["accountId"].string; forwarding = true
        subject = message["subject"].string
        if !subject.lowercased().hasPrefix("fwd:") && !subject.lowercased().hasPrefix("fw:") { subject = "Fwd: " + subject }
        let name = message["fromName"].string, email = message["fromEmail"].string
        let from = name.isEmpty || name == email ? email : email.isEmpty ? name : "\(name) <\(email)>"
        let headers = [("From", from), ("Date", message["date"].string), ("Subject", message["subject"].string), ("To", message["to"].string), ("Cc", message["cc"].string)]
            .filter { !$0.1.isEmpty }.map { "\($0.0): " + $0.1.replacingOccurrences(of: "[\\r\\n]+", with: " ", options: .regularExpression) }
        let quoted = (headers + ["", message["body"].string]).joined(separator: "\n").replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        body = "\n\n---------- Forwarded message ----------\n" + quoted.components(separatedBy: "\n").map { "> " + $0 }.joined(separator: "\n")
    }
    private static func mailboxes(_ value: String) -> [String] {
        if value.rangeOfCharacter(from: CharacterSet(charactersIn: "\r\n\0")) != nil { return [value] }
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return [] }
        // ponytail: normalize simple mailbox lists; keep unsupported syntax for review until an RFC group-address editor is needed.
        var tokens: [String] = [], token = "", quoted = false, escaped = false, angle = false
        for character in value {
            if escaped { escaped = false }
            else if quoted && character == "\\" { escaped = true }
            else if character == "\"" { quoted.toggle() }
            else if !quoted {
                if character == "<" { if angle { return [value] }; angle = true }
                else if character == ">" { if !angle { return [value] }; angle = false }
                else if !angle && ["(", ")", ":"].contains(character) { return [value] }
                else if !angle && (character == "," || character == ";") { tokens.append(token); token = ""; continue }
            }
            token.append(character)
        }
        guard !quoted, !escaped, !angle else { return [value] }
        tokens.append(token)
        var addresses: [String] = []
        for token in tokens {
            var address = token.trimmingCharacters(in: .whitespacesAndNewlines)
            if let open = address.firstIndex(of: "<"), let close = address.lastIndex(of: ">") {
                guard !address[..<open].contains("@"), address[address.index(after: close)...].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [value] }
                address = String(address[address.index(after: open)..<close]).trimmingCharacters(in: .whitespacesAndNewlines)
            }
            let pattern = #"^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$"#
            guard address.count <= 254, address.range(of: pattern, options: .regularExpression) != nil, !address.hasPrefix("."), !address.contains(".."), !address.contains(".@") else { return [value] }
            addresses.append(address)
        }
        return addresses
    }
}

let mailFolders = ["inbox", "starred", "sent", "drafts", "archive", "spam", "trash"]
let permissionFolders = mailFolders.filter { !["starred", "spam"].contains($0) }
func encodedPath(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
}
func parsedDate(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}
func dateLabel(_ value: String) -> String {
    guard let date = parsedDate(value) else { return value }
    return date.formatted(date: .abbreviated, time: .shortened)
}
func summaryReportTimestamp(_ report: JSON) -> String {
    report["status"].string == "completed" && report["completedAt"].nonempty ? report["completedAt"].string : report["createdAt"].string
}
func summariesForDay(_ reports: [JSON], now: Date = Date(), calendar: Calendar = .current) -> [JSON] {
    reports.filter { report in
        guard let date = parsedDate(summaryReportTimestamp(report)) else { return false }
        return calendar.isDate(date, inSameDayAs: now)
    }
}
func utcDate(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
func providerLabel(_ id: String) -> String { id == "google" ? "Google" : "Outlook" }

struct CalendarDraft: Codable, Identifiable, Equatable {
    var id = UUID().uuidString
    var provider: String, calendarID: String, calendarName: String, email: String
    var title = "", location = "", description = ""
    var start = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: Date().addingTimeInterval(86400)) ?? Date()
    var end = Calendar.current.date(bySettingHour: 10, minute: 0, second: 0, of: Date().addingTimeInterval(86400)) ?? Date().addingTimeInterval(3600)
    var attempted = false
    var payload: JSON { .object(["requestId": .string(id), "calendarId": .string(calendarID), "connectionEmail": .string(email), "title": .string(title), "location": .string(location), "description": .string(description), "start": .string(utcDate(start)), "end": .string(utcDate(end))]) }
    func savePending(in directory: URL) throws {
        let url = directory.appendingPathComponent("pending-calendar.json")
        // Persist the same request ID and payload before the external write. A
        // restart offers this exact request again instead of creating a duplicate.
        try JSONEncoder().encode(self).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    static func pending(in directory: URL) throws -> CalendarDraft? {
        let url = directory.appendingPathComponent("pending-calendar.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
    }
    static func clearPending(in directory: URL) throws {
        let url = directory.appendingPathComponent("pending-calendar.json")
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }
}


let mailSortOptions = [("newest", "Newest first"), ("oldest", "Oldest first"), ("sender", "Sender A–Z"), ("subject", "Subject A–Z"), ("unread", "Unread first"), ("starred", "Starred first")]
func sortedMail(_ messages: [JSON], by order: String) -> [JSON] {
    messages.sorted { a, b in
        if order == "sender" || order == "subject" {
            let key = order == "sender" ? "fromName" : "subject"
            let comparison = a[key].string.localizedStandardCompare(b[key].string)
            if comparison != .orderedSame { return comparison == .orderedAscending }
        }
        if order == "unread", a["read"].bool != b["read"].bool { return !a["read"].bool }
        if order == "starred", a["starred"].bool != b["starred"].bool { return a["starred"].bool }
        if a["date"].string != b["date"].string { return order == "oldest" ? a["date"].string < b["date"].string : a["date"].string > b["date"].string }
        return a.viewID < b.viewID
    }
}
