import Foundation

let previousMail: JSON = .object(["email": .string("Owner@yahoo.com.hk"), "password": .string("do-not-carry-this-secret"), "imapHost": .string("old.example")])
let yahooMail = yahooMailSettings(previousMail)
assert(yahooMail["email"].string == "Owner@yahoo.com.hk" && yahooMail["password"].string.isEmpty)
assert(yahooMail["imapHost"].string == "imap.mail.yahoo.com" && yahooMail["imapPort"].number == 993)
assert(yahooMail["smtpHost"].string == "smtp.mail.yahoo.com" && yahooMail["smtpPort"].number == 465)
assert(previousMail["password"].string == "do-not-carry-this-secret" && yahooMailSettings(.null)["email"].string.isEmpty)
print("Yahoo HK preset keeps the complete address, uses TLS ports and clears the entered password.")

struct WorkspaceTests {
    func testSchemaRoundTripAndUnconfirmedDraft() throws {
        let value = try JSONDecoder().decode(JSON.self, from: Data(#"{"id":"outbox:request","accountId":"owner@example.com","viewId":"unique-owned-message","to":"someone@example.com","subject":"Hello","body":"Text","deliveryStatus":"unconfirmed","deliveryRequestId":"original-request","policy":{"enabled":false},"count":8}"#.utf8))
        expectEqual(try JSONDecoder().decode(JSON.self, from: JSONEncoder().encode(value)), value)
        assert(!value["policy"]["enabled"].bool)
        expectEqual(value["count"].number, 8)
        let draft = Draft(message: value)
        expectEqual(draft.accountID, "owner@example.com")
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
    func testCalendarMonthSpansAndReminderRecovery() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!; calendar.firstWeekday = 2
        func day(_ month: Int, _ day: Int) -> Date { calendar.date(from: DateComponents(year: 2026, month: month, day: day))! }
        let month = CalendarMonth(containing: day(3, 8), calendar: calendar)
        expectEqual(month.days.count, 42)
        expectEqual(month.days.first, day(2, 23)); expectEqual(month.visibleInterval.end, day(4, 6))
        expectEqual(month.interval.start, day(3, 1)); expectEqual(month.interval.end, day(4, 1))
        expectEqual(calendar.dateInterval(of: .day, for: day(3, 8))!.duration, 23 * 3600)
        expectEqual(calendar.dateInterval(of: .day, for: day(11, 1))!.duration, 25 * 3600)
        expectEqual(CalendarMonth(containing: day(11, 1), calendar: calendar).days.count, 42)
        let connections: [JSON] = [.object(["provider": .string("google"), "email": .string("Exact.Case@example.com")])]
        var sourceValue: JSON = .object(["provider": .string("google"), "id": .string("primary"), "name": .string("Personal"), "canWrite": .bool(true), "color": .string("#123456")])
        let source = CalendarSource(sourceValue, connections: connections)
        expectEqual(source.email, "Exact.Case@example.com"); expectEqual(source.color, "#123456")
        let allDay: JSON = .object(["id": .string("shared:event"), "start": .string("2026-03-07"), "end": .string("2026-03-10"), "allDay": .bool(true)])
        let entry = try CalendarEntry(allDay, source: source, calendar: calendar)
        let timed = try CalendarEntry(.object(["id": .string("overnight"), "start": .string("2026-03-07T23:30:00-05:00"), "end": .string("2026-03-10T00:00:00-04:00")]), source: source, calendar: calendar)
        for date in 6...10 {
            let interval = calendar.dateInterval(of: .day, for: day(3, date))!
            expectEqual(entry.overlaps(interval), (7...9).contains(date))
            expectEqual(timed.overlaps(interval), (7...9).contains(date))
        }
        sourceValue["provider"] = .string("microsoft")
        let otherProvider = try CalendarEntry(allDay, source: CalendarSource(sourceValue, connections: []), calendar: calendar)
        sourceValue["provider"] = .string("google"); sourceValue["id"] = .string("other:calendar")
        let otherCalendar = try CalendarEntry(allDay, source: CalendarSource(sourceValue, connections: connections), calendar: calendar)
        expectEqual(Set([entry.id, otherProvider.id, otherCalendar.id]).count, 3)
        for invalid in ["2026-02-30", "2026-03-07T00:00:00Z"] {
            var value = allDay; value["start"] = .string(invalid)
            do { _ = try CalendarEntry(value, source: source, calendar: calendar); assertionFailure("Invalid all-day date accepted") } catch {}
        }

        var draft = CalendarDraft(provider: source.provider, calendarID: source.calendarID, calendarName: source.name, email: source.email, day: day(3, 8), calendar: calendar)
        expectEqual(calendar.component(.day, from: draft.start), 8)
        expectEqual(calendar.component(.hour, from: draft.start), 9)
        expectEqual(calendar.component(.hour, from: draft.end), 10)
        expectNil(draft.payload.object["reminder"])
        draft.reminder = CalendarReminder(method: "none", minutes: 15)
        expectEqual(draft.payload["reminder"], .object(["method": .string("none")]))
        for minutes in [0, 5, 15, 1440, 40320] {
            let reminder = CalendarReminder(method: "popup", minutes: minutes)
            assert(reminder.isValid(for: "google") && reminder.isValid(for: "microsoft"))
            draft.reminder = reminder; expectEqual(draft.payload["reminder"]["minutes"], .number(Double(minutes)))
        }
        assert(!CalendarReminder(method: "popup", minutes: -1).isValid(for: "google"))
        assert(!CalendarReminder(method: "popup", minutes: 40321).isValid(for: "google"))
        assert(!CalendarReminder(method: "popup", minutes: nil).isValid(for: "google"))
        assert(CalendarReminder(method: "email", minutes: 0).isValid(for: "google"))
        assert(!CalendarReminder(method: "email", minutes: 0).isValid(for: "microsoft"))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        draft.title = "Reviewed event"; draft.reminder = CalendarReminder(method: "email", minutes: 0)
        let originalPayload = draft.payload
        draft.prepareForSubmission(); try draft.savePending(in: directory)
        var restored = try unwrap(CalendarDraft.pending(in: directory))
        expectEqual(restored.payload, originalPayload)
        restored.title = "Edited"; restored.id = UUID().uuidString; restored.calendarID = "different"; restored.email = "other@example.com"
        restored.reminder = nil; restored.provider = "microsoft"; restored.start = day(11, 1)
        restored.prepareForSubmission()
        expectEqual(restored.payload, originalPayload); expectEqual(restored.requestProvider, "google")
        let replacement = CalendarDraft(provider: "google", calendarID: "different", calendarName: "Other", email: "other@example.com")
        do { try replacement.savePending(in: directory); assertionFailure("Replaced a different pending request") } catch {}
        expectEqual(try CalendarDraft.pending(in: directory)?.payload, originalPayload)
        try CalendarDraft.clearPending(in: directory)

        // Recreate the complete old Codable shape with no new reminder/snapshot
        // properties, then verify its request is frozen without adding fields.
        var legacy = try JSONDecoder().decode(JSON.self, from: JSONEncoder().encode(draft)).object
        legacy.removeValue(forKey: "reminder"); legacy.removeValue(forKey: "submittedPayload"); legacy.removeValue(forKey: "submittedProvider")
        var old = try JSONDecoder().decode(CalendarDraft.self, from: JSONEncoder().encode(JSON.object(legacy)))
        expectNil(old.payload.object["reminder"])
        let oldPayload = old.payload
        old.reminder = CalendarReminder(method: "popup", minutes: 30); old.email = "changed@example.com"
        expectEqual(old.payload, oldPayload)
        try old.savePending(in: directory)
        expectEqual(try CalendarDraft.pending(in: directory)?.payload, oldPayload)
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
try checks.testCalendarMonthSpansAndReminderRecovery()
try checks.testPathAndTimezoneHandling()
print("4 native model and recovery checks passed (calendar month/DST, spanning events, reminders and immutable legacy retry).")

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

// Shared service output is decoded verbatim; recipient and quoting rules live in the service.
let prepared = try JSONDecoder().decode(JSON.self, from: Data(#"{"draft":{"accountId":"owner@example.com","to":"sender@example.com, editable-invalid","cc":"copy@example.com","bcc":"","subject":"Re: Question","body":"Reviewed AI text","replyToId":"same-provider-id"}}"#.utf8))
let reply = try Draft(prepared: prepared["draft"])
expectEqual(reply.accountID, "owner@example.com"); expectEqual(reply.replyToID, "same-provider-id")
expectEqual(reply.to, "sender@example.com, editable-invalid"); expectEqual(reply.cc, "copy@example.com")
expectEqual(reply.body, "Reviewed AI text"); expectEqual(reply.bcc, "")
assert(reply.savedID.isEmpty && reply.footer.isNull && !reply.forwarding && !reply.sourceDraft)
var forwardPayload = prepared["draft"]
forwardPayload["to"] = .string(""); forwardPayload["cc"] = .string(""); forwardPayload["replyToId"] = .null
forwardPayload["subject"] = .string("Fwd: Question"); forwardPayload["body"] = .string("Service-quoted text")
forwardPayload["forwarding"] = .bool(true)
let forward = try Draft(prepared: forwardPayload)
assert(forward.forwarding && forward.savedID.isEmpty && forward.replyToID.isEmpty)
expectEqual(forward.body, "Service-quoted text"); expectEqual(forward.subject, "Fwd: Question")
assert(forward.payload["replyToId"].isNull && forward.payload["forwarding"].isNull)
var copyPayload = forwardPayload
copyPayload["forwarding"] = .null; copyPayload["sourceDraft"] = .bool(true)
copyPayload["to"] = .string("to@example.com"); copyPayload["bcc"] = .string("hidden@example.com")
// A prepared draft cannot inherit a persisted ID, delivery attempt, schedule or footer.
copyPayload["id"] = .string("provider-draft"); copyPayload["footer"] = .object(["text": .string("Old footer")])
copyPayload["deliveryStatus"] = .string("unconfirmed"); copyPayload["deliveryRequestId"] = .string("old-request")
copyPayload["scheduledSend"] = .object(["status": .string("scheduled")])
let copy = try Draft(prepared: copyPayload)
assert(copy.sourceDraft && copy.savedID.isEmpty && !copy.forwarding && !copy.unconfirmed && !copy.scheduleLocked)
expectEqual(copy.accountID, "owner@example.com"); expectEqual(copy.bcc, "hidden@example.com")
assert(copy.footer.isNull && copy.requestID != "old-request" && copy.payload["sourceDraft"].isNull)
for malformed in [JSON.null, .object(["accountId": .string("owner@example.com")])] {
    do { _ = try Draft(prepared: malformed); assertionFailure("Incomplete service draft accepted") } catch is APIError { }
}
let savedFooter: JSON = .object(["text": .string("Saved signature")])
expectEqual(Draft(message: .object(["id": .string("local-draft"), "footer": savedFooter])).footer, savedFooter)
print("Native prepared draft decoding preserves service recipients, reply/copy/forward flags and text; saved draft recovery stays synchronous.")
