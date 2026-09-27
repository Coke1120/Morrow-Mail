import Foundation

struct WorkspaceTests {
    func testSchemaRoundTripAndUnconfirmedDraft() throws {
        let value = try JSONDecoder().decode(JSON.self, from: Data(#"{"id":"outbox:request","accountId":"owner@example.com","viewId":"unique-owned-message","to":"someone@example.com","subject":"Hello","body":"Text","deliveryStatus":"unconfirmed","deliveryRequestId":"original-request","policy":{"enabled":false},"count":8}"#.utf8))
        expectEqual(try JSONDecoder().decode(JSON.self, from: JSONEncoder().encode(value)), value)
        assert(!value["policy"]["enabled"].bool)
        expectEqual(value["count"].number, 8)
        let draft = Draft(message: value)
        expectEqual(draft.accountID, "owner@example.com")
        expectEqual(Draft(message: value, reply: true).accountID, "owner@example.com")
        expectEqual(value.viewID, "unique-owned-message")
        assert(draft.unconfirmed)
        expectEqual(draft.requestID, "original-request")
        expectEqual(draft.savedID, "outbox:request")
        expectEqual(draft.payload["body"].string, "Text")
        expectNil(draft.payload.object["deliveryStatus"])
    }
    func testCalendarRetrySurvivesRestartWithSamePayload() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        var draft = CalendarDraft(provider: "google", calendarID: "primary", calendarName: "Personal", email: "me@example.com")
        draft.title = "A real event"; draft.attempted = true
        draft.start = Date(timeIntervalSince1970: 1_900_000_000); draft.end = draft.start.addingTimeInterval(3600)
        try draft.savePending(in: directory)
        let restored = try unwrap(CalendarDraft.pending(in: directory))
        expectEqual(restored.id, draft.id)
        expectEqual(restored.payload, draft.payload)
        assert(restored.attempted)
        let permissions = try FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent("pending-calendar.json").path)[.posixPermissions] as? NSNumber
        expectEqual(permissions?.intValue, 0o600)
        try CalendarDraft.clearPending(in: directory)
        expectNil(try CalendarDraft.pending(in: directory))
    }
    func testPathAndTimezoneHandling() throws {
        expectEqual(encodedPath("a/b?c#d+e"), "a%2Fb%3Fc%23d%2Be")
        let date = try unwrap(parsedDate("2026-09-23T12:30:00.123Z"))
        expectEqual(utcDate(date), "2026-09-23T12:30:00Z")
        expectNotNil(parsedDate("2026-09-23T12:30:00Z"))
        expectNil(parsedDate("invalid"))
    }
}

func expectEqual<T: Equatable>(_ a: T, _ b: T) { assert(a == b, "Expected \(a) to equal \(b)") }
func expectNil<T>(_ a: T?) { assert(a == nil) }
func expectNotNil<T>(_ a: T?) { assert(a != nil) }
func unwrap<T>(_ a: T?) throws -> T { guard let a else { throw APIError("Expected a value") }; return a }
let checks = WorkspaceTests()
try checks.testSchemaRoundTripAndUnconfirmedDraft()
try checks.testCalendarRetrySurvivesRestartWithSamePayload()
try checks.testPathAndTimezoneHandling()
print("3 native model and recovery checks passed.")

// Today follows the local calendar (including DST), and a completed job belongs
// to its completion day rather than the day it was queued.
var summaryCalendar = Calendar(identifier: .gregorian)
summaryCalendar.timeZone = TimeZone(identifier: "America/New_York")!
let summaryNow = try unwrap(parsedDate("2026-03-08T15:00:00Z"))
let dayReports: [JSON] = [
    .object(["id": .string("completed-today"), "status": .string("completed"), "createdAt": .string("2026-03-07T20:00:00Z"), "completedAt": .string("2026-03-08T05:00:00Z")]),
    .object(["id": .string("yesterday"), "status": .string("completed"), "createdAt": .string("2026-03-08T05:00:00Z"), "completedAt": .string("2026-03-08T04:59:59Z")]),
    .object(["id": .string("last-second"), "status": .string("running"), "createdAt": .string("2026-03-09T03:59:59Z")]),
    .object(["id": .string("tomorrow"), "createdAt": .string("2026-03-09T04:00:00Z")]),
    .object(["id": .string("invalid"), "createdAt": .string("not-a-date")]),
]
expectEqual(summariesForDay(dayReports, now: summaryNow, calendar: summaryCalendar).map(\.id), ["completed-today", "last-second"])
expectEqual(summaryReportTimestamp(.object(["status": .string("completed"), "createdAt": .string("legacy-date")])), "legacy-date")
print("Today summary local-day, DST and completion-date checks passed.")

let copied = Draft(message: .object(["id": .string("draft"), "accountId": .string("first@example.com"), "to": .string("one@example.com, two@example.com"), "cc": .string("copy@example.com"), "bcc": .string("hidden@example.com")]))
expectEqual(copied.payload["cc"].string, "copy@example.com")
expectEqual(copied.payload["bcc"].string, "hidden@example.com")
let sortFixture: [JSON] = [
    .object(["id": .string("new"), "date": .string("2026-09-23"), "subject": .string("Zebra"), "fromName": .string("Alice"), "read": .bool(true), "starred": .bool(false)]),
    .object(["id": .string("old"), "date": .string("2026-09-22"), "subject": .string("Apple"), "fromName": .string("Bob"), "read": .bool(false), "starred": .bool(true)]),
]
for order in ["oldest", "subject", "unread", "starred"] { expectEqual(sortedMail(sortFixture, by: order).first?.id, "old") }
for order in ["newest", "sender"] { expectEqual(sortedMail(sortFixture, by: order).first?.id, "new") }
print("Native multi-recipient and six sorting checks passed.")

var original: JSON = .object(["id": .string("same-provider-id"), "accountId": .string("receiver@example.com"), "fromEmail": .string("sender@example.com"), "to": .string("alias@example.com"), "subject": .string("Question"), "folder": .string("inbox")])
let reply = Draft(message: original, reply: true)
expectEqual(reply.accountID, "receiver@example.com")
expectEqual(reply.to, "sender@example.com")
expectEqual(reply.replyToID, "same-provider-id")
original["folder"] = .string("sent")
expectEqual(Draft(message: original, reply: true).to, "alias@example.com")
original["footer"] = .object(["text": .string("Leo"), "html": .string("<b>Leo</b>")])
expectEqual(Draft(message: original).payload["footer"], original["footer"])
print("Native reply ownership and footer persistence checks passed.")

let recipientsMessage: JSON = .object([
    "id": .string("provider-id"), "accountId": .string("Owner@example.com"), "folder": .string("inbox"),
    "fromName": .string("Sender"), "fromEmail": .string("sender@example.com"),
    "to": .string(#""Doe, Jane" <JANE@example.com>, OWNER@example.com; teammate@example.com, SENDER@example.com"#),
    "cc": .string(#""Smith, \"JJ\"" <jane@example.com>, copy@example.com, sender@example.com, owner@example.com"#),
    "bcc": .string("hidden@example.com"), "subject": .string("Question"), "body": .string("First line\r\nSecond line"),
    "date": .string("2026-09-26T12:30:00Z"), "footer": .object(["text": .string("Old footer")]), "replyToId": .string("old-thread")
])
let allReply = Draft(message: recipientsMessage, replyAll: true)
expectEqual(allReply.accountID, "Owner@example.com")
expectEqual(allReply.to, "sender@example.com, JANE@example.com, teammate@example.com")
expectEqual(allReply.cc, "copy@example.com"); expectEqual(allReply.bcc, "")
expectEqual(allReply.subject, "Re: Question"); expectEqual(allReply.replyToID, "provider-id")
assert(!allReply.forwarding); expectEqual(allReply.savedID, ""); expectEqual(allReply.footer, .null)
expectEqual(Draft(message: recipientsMessage, replyAll: false).to, "sender@example.com")
var sentMessage = recipientsMessage
sentMessage["folder"] = .string("sent"); sentMessage["fromEmail"] = .string("sending-alias@example.com")
expectEqual(Draft(message: sentMessage, reply: true).to, "JANE@example.com, OWNER@example.com, teammate@example.com, SENDER@example.com")
expectEqual(Draft(message: sentMessage, replyAll: true).to, "JANE@example.com, teammate@example.com, SENDER@example.com")
expectEqual(Draft(message: sentMessage, replyAll: true).cc, "copy@example.com")
var demoMessage = recipientsMessage
demoMessage["accountId"] = .string("demo"); demoMessage["to"] = .string("alex@genmail.example"); demoMessage["cc"] = .string("")
expectEqual(Draft(message: demoMessage, replyAll: true).to, "sender@example.com")
for invalid in ["valid@example.com, broken-recipient", #""Unclosed name <a@example.com>"#, "Missing <>", "Two <a@example.com, b@example.com>", "a@example.com,", "a@example.com\r\nBcc: injected@example.com", "Group: a@example.com;", "Doe, Jane <jane@example.com>"] {
    var message = recipientsMessage; message["to"] = .string(invalid); message["cc"] = .string("")
    expectEqual(Draft(message: message, replyAll: true).to, "sender@example.com, " + invalid)
    message["to"] = .string(""); message["cc"] = .string(invalid)
    expectEqual(Draft(message: message, replyAll: true).cc, invalid)
}
let forward = Draft(forwarding: recipientsMessage)
assert(forward.forwarding); expectEqual(forward.accountID, "Owner@example.com")
expectEqual(forward.to, ""); expectEqual(forward.cc, ""); expectEqual(forward.bcc, "")
expectEqual(forward.savedID, ""); expectEqual(forward.replyToID, ""); expectEqual(forward.footer, .null)
expectNil(forward.payload.object["replyToId"]); expectNil(forward.payload.object["forwarding"])
expectEqual(forward.subject, "Fwd: Question")
assert(forward.body.contains("> From: Sender <sender@example.com>"))
assert(forward.body.contains("> Date: 2026-09-26T12:30:00Z"))
assert(forward.body.contains("> To: ")); assert(forward.body.contains("> Cc: "))
assert(forward.body.hasSuffix("> First line\n> Second line"))
assert(!forward.body.contains("hidden@example.com")); assert(!forward.body.contains("Bcc:")); assert(!forward.body.contains("Old footer"))
for subject in ["Fwd: Already forwarded", "FW: Already forwarded"] {
    var message = recipientsMessage; message["subject"] = .string(subject)
    expectEqual(Draft(forwarding: message).subject, subject)
}
print("Native Reply All recipient privacy and unthreaded Forward checks passed.")

let gmailDraft = Draft(message: .object(["id": .string("google:draft"), "accountId": .string("owner@example.invalid"), "providerDraft": .bool(true), "folder": .string("drafts"), "to": .string("to@example.invalid"), "cc": .string("cc@example.invalid"), "bcc": .string("bcc@example.invalid"), "body": .string("Unsent provider text")]))
assert(gmailDraft.sourceDraft && gmailDraft.savedID.isEmpty)
expectEqual(gmailDraft.accountID, "owner@example.invalid")
expectEqual(gmailDraft.payload["body"].string, "Unsent provider text")
expectEqual(gmailDraft.payload["bcc"].string, "bcc@example.invalid")
assert(gmailDraft.payload["id"].isNull && gmailDraft.payload["sourceDraft"].isNull)
print("Native Gmail draft copy preserves owner and content without mutating the provider draft.")
