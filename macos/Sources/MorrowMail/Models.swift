import Foundation

func yahooMailSettings(_ mail: JSON) -> JSON {
    .object(["email": .string(mail["email"].string), "password": .string(""),
             "imapHost": .string("imap.mail.yahoo.com"), "imapPort": .number(993),
             "smtpHost": .string("smtp.mail.yahoo.com"), "smtpPort": .number(465)])
}

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
    var errorDescription: String? {
        let message = payload["error"].nonempty ? payload["error"].string : "Morrow could not complete this request."
        return message + (payload["nextRetryAt"].nonempty ? " Next retry: \(dateLabel(payload["nextRetryAt"].string))." : "")
    }
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
    var scheduleDate: Date?
    var scheduledSend: JSON = .null
    var scheduleLocked: Bool {
        ["scheduled", "sending"].contains(scheduledSend["status"].string)
    }
    var payload: JSON {
        var value: [String: JSON] = ["to": .string(to), "cc": .string(cc), "bcc": .string(bcc), "subject": .string(subject), "body": .string(body)]
        if !footer.isNull { value["footer"] = footer }
        if !savedID.isEmpty { value["id"] = .string(savedID) }
        if !replyToID.isEmpty { value["replyToId"] = .string(replyToID) }
        return .object(value)
    }
    init() {}
    init(message: JSON) {
        accountID = message["accountId"].string
        savedID = message.id; to = message["to"].string; cc = message["cc"].string; bcc = message["bcc"].string
        subject = message["subject"].string; body = message["body"].string; footer = message["footer"]
        replyToID = message["replyToId"].string
        unconfirmed = message["deliveryStatus"].string == "unconfirmed"
        if message["deliveryRequestId"].nonempty { requestID = message["deliveryRequestId"].string }
        scheduledSend = message["scheduledSend"]
    }
    init(prepared: JSON) throws {
        guard ["accountId", "to", "cc", "bcc", "subject", "body"].allSatisfy({ if case .string = prepared[$0] { return true }; return false }),
              prepared["accountId"].nonempty else { throw APIError("The local service returned an incomplete draft.") }
        accountID = prepared["accountId"].string
        to = prepared["to"].string; cc = prepared["cc"].string; bcc = prepared["bcc"].string
        subject = prepared["subject"].string; body = prepared["body"].string
        replyToID = prepared["replyToId"].string
        forwarding = prepared["forwarding"].bool; sourceDraft = prepared["sourceDraft"].bool
    }
}

let mailFolders = ["inbox", "starred", "pending", "sent", "drafts", "archive", "spam", "trash"]
let permissionFolders = mailFolders.filter { !["starred", "pending", "spam"].contains($0) }
func messageMatchesFolder(_ message: JSON, folder: String) -> Bool {
    if folder == "starred" || folder == "pending" {
        // Missing flags on older cached messages decode as false.
        return message[folder].bool && !["trash", "spam"].contains(message["folder"].string)
    }
    return message["folder"].string == folder
}
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

struct CalendarSource: Identifiable, Equatable {
    let provider: String, calendarID: String, name: String, email: String, color: String
    let canWrite: Bool, primary: Bool
    var id: String { provider + ":" + encodedPath(calendarID) }
    var preferenceKey: String { id + ":" + encodedPath(email) }
    init(_ value: JSON, connections: [JSON]) {
        provider = value["provider"].string; calendarID = value.id
        name = value["name"].nonempty ? value["name"].string : "Untitled calendar"
        email = connections.first { $0["provider"] == value["provider"] }?["email"].string ?? ""
        color = value["color"].string; canWrite = value["canWrite"].bool; primary = value["primary"].bool
    }
}

struct CalendarMonth {
    let interval: DateInterval
    let days: [Date]
    let calendar: Calendar
    init(containing date: Date, calendar: Calendar = .current) {
        self.calendar = calendar
        interval = calendar.dateInterval(of: .month, for: date)!
        let leading = (calendar.component(.weekday, from: interval.start) - calendar.firstWeekday + 7) % 7
        let first = calendar.date(byAdding: .day, value: -leading, to: interval.start)!
        let count = calendar.dateComponents([.day], from: interval.start, to: interval.end).day!
        days = (0..<((leading + count + 6) / 7 * 7)).compactMap { calendar.date(byAdding: .day, value: $0, to: first) }
    }
    var visibleInterval: DateInterval {
        DateInterval(start: days[0], end: calendar.date(byAdding: .day, value: 1, to: days.last!)!)
    }
}

struct CalendarEntry: Identifiable {
    let source: CalendarSource
    let value: JSON
    let start: Date, end: Date
    var id: String { source.id + ":" + encodedPath(value.id) }
    var allDay: Bool { value["allDay"].bool }
    init(_ value: JSON, source: CalendarSource, calendar: Calendar = .current) throws {
        self.value = value; self.source = source
        // Provider all-day dates are civil dates, not UTC instants. Keep their
        // exclusive end; timed events keep their actual offset across DST.
        func date(_ text: String) -> Date? {
            guard value["allDay"].bool else { return parsedDate(text) }
            guard text.count == 10 else { return nil }
            let parts = text.split(separator: "-", omittingEmptySubsequences: false)
            guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
                  let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]) else { return nil }
            var gregorian = Calendar(identifier: .gregorian); gregorian.timeZone = calendar.timeZone
            guard let result = gregorian.date(from: DateComponents(year: year, month: month, day: day)),
                  gregorian.component(.year, from: result) == year, gregorian.component(.month, from: result) == month,
                  gregorian.component(.day, from: result) == day else { return nil }
            return result
        }
        guard !value.id.isEmpty, let start = date(value["start"].string), let end = date(value["end"].string),
              end >= start, !value["allDay"].bool || end > start else {
            throw APIError("This calendar returned an event with invalid dates. Its events could not be displayed completely.")
        }
        self.start = start; self.end = end
    }
    func overlaps(_ interval: DateInterval) -> Bool {
        start < interval.end && (end > interval.start || (end == start && start >= interval.start))
    }
}

struct CalendarReminder: Codable, Equatable {
    var method: String
    var minutes: Int?
    var payload: JSON {
        var value: JSON = .object(["method": .string(method)])
        if method != "none", let minutes { value["minutes"] = .number(Double(minutes)) }
        return value
    }
    func isValid(for provider: String) -> Bool {
        method == "none" || (["popup", "email"].contains(method) && (method != "email" || provider == "google") && minutes.map { (0...40320).contains($0) } == true)
    }
    var label: String {
        if method == "none" { return "No reminder" }
        let when = minutes == 0 ? "at the start" : "\(minutes ?? 0) minutes before"
        return "\(method == "email" ? "Email" : "Notification") · \(when)"
    }
}

struct CalendarDraft: Codable, Identifiable, Equatable {
    var id = UUID().uuidString
    var provider: String, calendarID: String, calendarName: String, email: String
    var title = "", location = "", description = ""
    var start: Date, end: Date
    var reminder: CalendarReminder?
    var attempted = false
    private var submittedPayload: JSON?
    private var submittedProvider: String?
    var requestProvider: String { submittedProvider ?? provider }
    private var editedPayload: JSON {
        var value: JSON = .object(["requestId": .string(id), "calendarId": .string(calendarID), "connectionEmail": .string(email), "title": .string(title), "location": .string(location), "description": .string(description), "start": .string(utcDate(start)), "end": .string(utcDate(end))])
        if let reminder { value["reminder"] = reminder.payload }
        return value
    }
    var payload: JSON { submittedPayload ?? editedPayload }
    init(provider: String, calendarID: String, calendarName: String, email: String, day: Date? = nil, calendar: Calendar = .current) {
        self.provider = provider; self.calendarID = calendarID; self.calendarName = calendarName; self.email = email
        let day = day ?? calendar.date(byAdding: .day, value: 1, to: Date())!
        start = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: day) ?? calendar.startOfDay(for: day)
        end = calendar.date(byAdding: .hour, value: 1, to: start)!
    }
    private enum CodingKeys: String, CodingKey {
        case id, provider, calendarID, calendarName, email, title, location, description, start, end, reminder, attempted, submittedPayload, submittedProvider
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        provider = try c.decode(String.self, forKey: .provider); calendarID = try c.decode(String.self, forKey: .calendarID)
        calendarName = try c.decode(String.self, forKey: .calendarName); email = try c.decode(String.self, forKey: .email)
        title = try c.decode(String.self, forKey: .title); location = try c.decode(String.self, forKey: .location); description = try c.decode(String.self, forKey: .description)
        start = try c.decode(Date.self, forKey: .start); end = try c.decode(Date.self, forKey: .end)
        reminder = try c.decodeIfPresent(CalendarReminder.self, forKey: .reminder)
        attempted = try c.decodeIfPresent(Bool.self, forKey: .attempted) ?? false
        submittedPayload = try c.decodeIfPresent(JSON.self, forKey: .submittedPayload)
        submittedProvider = try c.decodeIfPresent(String.self, forKey: .submittedProvider)
        // Old pending files have no snapshot/reminder. Freeze the legacy payload
        // on decode without adding a default reminder or changing its email.
        if attempted { prepareForSubmission() }
    }
    mutating func prepareForSubmission() {
        if submittedPayload == nil { submittedPayload = editedPayload }
        if submittedProvider == nil { submittedProvider = provider }
        attempted = true
    }
    func savePending(in directory: URL) throws {
        let url = directory.appendingPathComponent("pending-calendar.json")
        // Persist the same request ID and payload before the external write. A
        // restart offers this exact request again instead of creating a duplicate.
        var snapshot = self; snapshot.prepareForSubmission()
        if let existing = try Self.pending(in: directory) {
            guard existing.payload == snapshot.payload, existing.requestProvider == snapshot.requestProvider else {
                throw APIError("Resolve the original pending calendar request before creating a different event.")
            }
            return
        }
        try JSONEncoder().encode(snapshot).write(to: url, options: .atomic)
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
