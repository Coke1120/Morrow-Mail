import Foundation
import AppKit
import SwiftUI

// This session observes the localhost handoff but never follows an OAuth redirect.
final class RustStopOAuthRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@main
struct NativeRustChecks {
    static let first = "first@native-rust.invalid"
    static let second = "second@native-rust.invalid"

    static func check(_ condition: Bool, _ message: String) throws {
        if !condition { throw APIError("Native Rust acceptance: " + message) }
    }

    @MainActor static func collect(_ model: AppModel, expected: Int) async throws -> [JSON] {
        try check(await model.loadMailPage(), "first page failed: \(model.error)")
        var rows = [JSON](), seen = Set<String>()
        for _ in 0..<5 {
            let page = model.listedMessages
            try check(model.mailPage["pageSize"].number == 50 && page.count <= 50, "mail pages must remain bounded")
            try check(model.mailPage["total"].number == Double(expected), "mail page total differs from fixture")
            try check(page.allSatisfy { $0["body"].isNull && $0["footer"].isNull }, "body or footer leaked into list metadata")
            for row in page {
                try check(seen.insert(row.viewID).inserted, "pagination repeated an account/message identity")
            }
            rows += page
            if model.mailPage["nextCursor"].string.isEmpty { break }
            await model.turnMailPage(next: true)
            try check(model.error.isEmpty, "next page failed: \(model.error)")
        }
        try check(rows.count == expected, "pagination omitted fixture messages")
        return rows
    }

    @MainActor static func expectFailure(_ model: AppModel, path: String, method: String = "POST", body: JSON = .object([:]), owner: String? = nil) async throws {
        do { _ = try await model.request(path, method: method, body: method == "GET" ? nil : body, mailbox: owner) }
        catch is APIError { return }
        throw APIError("Native Rust acceptance: rejected operation unexpectedly succeeded: " + path)
    }

    @MainActor static func checkPreparedDrafts(_ model: AppModel, sources: [JSON]) async throws {
        let before = try await model.request("/state/revision", mailbox: "")
        for source in sources {
            let owner = source["accountId"].string
            // Supply only metadata, including a misleading client body: the service must load the owned source.
            var metadata = source; metadata["body"] = .string("Never use this client message body")
            let reply = try await model.prepareDraft(message: metadata, mode: "reply", body: "Reviewed suggestion")
            try check(reply.accountID == owner && reply.replyToID == source.id && reply.to == "sender0@example.invalid" && reply.body == "Reviewed suggestion", "prepared reply lost its owner, original ID or reviewed body")
            let all = try await model.prepareDraft(message: source, mode: "replyAll")
            try check(all.accountID == owner && all.replyToID == source.id && all.to == reply.to && all.cc.isEmpty && all.bcc.isEmpty, "prepared Reply All included its owner or lost thread identity")
            let forward = try await model.prepareDraft(message: metadata, mode: "forward")
            try check(forward.accountID == owner && forward.forwarding && forward.replyToID.isEmpty && forward.to.isEmpty && forward.cc.isEmpty && forward.bcc.isEmpty, "prepared forward retained threading or recipients")
            try check(forward.body.contains("Owned by " + owner) && !forward.body.contains("Never use this client") && !forward.body.contains("Fixture footer"), "prepare used client content, another owner or the source footer")
            try check(reply.savedID.isEmpty && all.savedID.isEmpty && forward.savedID.isEmpty && reply.footer.isNull && forward.footer.isNull, "prepare persisted a draft or supplied a footer")
            let history = try await model.request("/messages/" + encodedPath(reply.replyToID) + "/history", mailbox: reply.accountID)
            try check(history["accountId"].string == owner && history["messageId"].string == source.id && history["messages"].array.first?["accountId"].string == owner, "Reply history lost its captured owner or original ID")
            try check(history["messages"].array.first?["body"].string.contains("Owned by " + owner) == true && history["messages"].array.allSatisfy({ $0["bodyHtml"].isNull && $0["bcc"].isNull }), "Reply history disclosed another owner or active HTML/Bcc")
        }
        let providerPath = "/messages/" + encodedPath("google:provider-draft")
        let originalProvider = try await model.request(providerPath, mailbox: first)
        let copied = try await model.prepareDraft(message: originalProvider["message"], mode: "copy")
        try check(copied.sourceDraft && copied.accountID == first && copied.savedID.isEmpty && copied.replyToID.isEmpty && copied.footer.isNull && !copied.unconfirmed, "provider copy retained remote delivery identity")
        try check(copied.to == "to@example.invalid" && copied.cc == "cc@example.invalid" && copied.bcc == "hidden@example.invalid" && copied.body == "Original provider draft; never sent.", "provider copy changed reviewed content or recipients")
        let retainedProvider = try await model.request(providerPath, mailbox: first)
        try check(retainedProvider == originalProvider, "copy changed the original provider draft")
        let source = sources[0], payload: JSON = .object(["messageId": .string(sources[0].id), "mode": .string("reply")])
        for owner in ["", "all", "missing@native-rust.invalid"] {
            try await expectFailure(model, path: "/drafts/prepare", body: payload, owner: owner)
        }
        for id in [source.viewID, "missing-message"] {
            try await expectFailure(model, path: "/drafts/prepare", body: .object(["messageId": .string(id), "mode": .string("reply")]), owner: first)
        }
        try await expectFailure(model, path: "/drafts/prepare", body: .object(["messageId": .string(source.id), "mode": .string("copy")]), owner: first)
        let after = try await model.request("/state/revision", mailbox: "")
        try check(before == after && model.compose == nil, "preparing a draft changed persisted state or opened a composer")

        // Hold the main actor after the request begins: no artificial provider delay or real send is needed.
        for change in ["selection", "account", "composer", "connection", "sheet", "cancel"] {
            let pending = Task { @MainActor in try await model.prepareDraft(message: source, mode: "reply") }
            for _ in 0..<1000 { if model.preparingDraft { break }; await Task.yield() }
            try check(model.preparingDraft, "draft request did not start")
            do {
                _ = try await model.prepareDraft(message: source, mode: "forward")
                throw APIError("Native Rust acceptance: duplicate draft preparation was accepted")
            } catch is CancellationError { }
            if change == "selection" {
                let selection = model.selectedMessage; model.selectedMessage = "another-message"; model.selectedMessage = selection
            } else if change == "account" {
                let selected = model.state["account"]; model.state["account"] = .object(["id": .string(second)]); model.state["account"] = selected
            } else if change == "composer" {
                model.newDraft(); try check(model.compose != nil, "manual draft did not open")
                model.compose = nil // Even opening and closing another composer invalidates the old request.
            } else if change == "connection" {
                let accounts = model.state["accounts"]; model.state["accounts"] = .array([]); model.state["accounts"] = accounts
            } else if change == "sheet" {
                model.organizing = source; model.organizing = nil
            } else { pending.cancel() }
            do {
                _ = try await pending.value
                throw APIError("Native Rust acceptance: stale draft response was accepted after " + change)
            } catch is CancellationError { }
            try check(!model.preparingDraft && model.compose == nil, "cancelled prepare left a lock or reopened the composer")
        }
        print("Native Rust: service draft preparation, explicit owners/IDs, no persistence, duplicate and stale-response guards passed without sending.")
    }

    @MainActor static func checkNewWorkspaceFeatures(_ model: AppModel, draft: Draft) async throws {
        try check(model.account == second && !model.policy["enabled"].bool, "new feature fixture must start on the other account with AI disabled")
        try check(mailFolders.contains("pending") && !permissionFolders.contains("pending"), "Pending is a local view, not an AI permission folder")
        let legacy: JSON = .object(["id": .string("legacy"), "accountId": .string(first), "folder": .string("drafts")])
        try check(!messageMatchesFolder(legacy, folder: "pending") && !Draft(message: legacy).scheduleLocked, "older messages require no new flag or schedule fields")

        let messagePath = "/messages/" + encodedPath("google:shared")
        let original = try await model.request(messagePath, mailbox: first)
        // Exercise the same owner-capturing patch helper as the reader toggle,
        // while the global selected account is deliberately different.
        model.patch(original["message"], .object(["pending": .bool(true)]))
        for _ in 0..<1000 {
            if !model.busy { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        try check(!model.busy && model.error.isEmpty && model.account == second, "Pending toggle failed or changed the selected account: \(model.error)")
        let other = try await model.request(messagePath, mailbox: second)
        try check(!other["message"]["pending"].bool, "Pending toggle changed the other account's duplicate ID")
        try await expectFailure(model, path: messagePath, method: "PATCH", body: .object(["pending": .bool(true)]), owner: "all")
        try await model.selectAccount("all", folder: "pending")
        let pending = try await collect(model, expected: 1)
        try check(pending[0].viewID == original["message"].viewID && pending[0]["pending"].bool && pending[0]["accountId"].string == first, "Pending page lost its flag or owner")
        try check(model.accounts.first { $0.id == first }?["counts"]["pending"].number == 1 && model.accounts.first { $0.id == second }?["counts"]["pending"].number == 0, "Pending sidebar counts crossed accounts")
        model.selectedMessage = pending[0].viewID
        await model.loadMessage()
        try check(model.current?["pending"].bool == true && model.current?["accountId"].string == first, "Pending reader failed to resolve the owned detail")
        _ = try await model.request(messagePath, method: "PATCH", body: .object(["pending": .bool(false)]), mailbox: first)
        try await model.reload()
        await model.loadMessage()
        _ = try await collect(model, expected: 0)
        try check(model.current == nil, "Cleared Pending message remained in the reader")
        model.selectedMessage = nil; model.messageDetail = .null
        try await model.selectAccount(second, folder: "inbox")
        print("Native Rust: Pending reader toggle, combined page, owner isolation and clearing passed.")

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let requestID = UUID().uuidString
        var payload = draft.payload.picking(["to", "cc", "bcc", "subject", "body", "footer", "replyToId"])
        payload["draftId"] = .string(draft.savedID)
        payload["requestId"] = .string(requestID)
        // Never due during this fixture; do not invoke /send or a provider.
        payload["sendAt"] = .string(formatter.string(from: Date().addingTimeInterval(30 * 86400)))
        let created = try await model.request("/scheduled", method: "POST", body: payload, mailbox: first)
        let job = created["job"], scheduledDraft = Draft(message: created["message"])
        try check(job.id == requestID && job["accountId"].string == first && job["status"].string == "scheduled", "Schedule create lost its UUID or owner")
        try check(created["appOpenRequired"].bool && created["lateGraceMinutes"].number == 15, "Schedule review's open-app/catch-up contract changed")
        try check(job["payload"]["bcc"].string == draft.bcc && job["payload"]["footer"] == draft.footer && job["sendAt"] == payload["sendAt"], "Schedule changed the reviewed recipients, footer or time")
        try check(scheduledDraft.scheduleLocked && scheduledDraft.scheduledSend["id"].string == job.id, "Scheduled draft marker did not lock the native model")
        model.newDraft(scheduledDraft)
        try check(model.compose == nil && model.section == "scheduled" && model.scheduledAccount == first && model.account == second, "Scheduled draft did not open its owner's management tab")
        let replay = try await model.request("/scheduled", method: "POST", body: payload, mailbox: first)
        try check(replay["job"].id == job.id, "Retrying the reviewed schedule created a different job")
        let list = try await model.request("/scheduled", mailbox: first)
        let otherList = try await model.request("/scheduled", mailbox: second)
        try check(list["scheduled"].array.count == 1 && list["scheduled"].array[0].id == job.id && otherList["scheduled"].array.isEmpty, "Scheduled listing duplicated a retry or crossed owners")
        let cancelPath = "/scheduled/" + encodedPath(job.id) + "/cancel"
        try await expectFailure(model, path: cancelPath, owner: second)
        try await expectFailure(model, path: "/drafts", body: draft.payload, owner: first)
        try await model.selectAccount(first, folder: "drafts")
        try check(await model.loadMailPage(), "Scheduled draft page failed")
        guard let row = model.listedMessages.first(where: { $0.id == draft.savedID }) else { throw APIError("Native Rust acceptance: scheduled draft metadata missing") }
        try check(row["scheduledSend"]["id"].string == job.id && row["scheduledSend"]["status"].string == "scheduled" && row["body"].isNull && row["footer"].isNull, "Draft list omitted safe schedule metadata or exposed content")
        let cancelled = try await model.request(cancelPath, method: "POST", body: .object([:]), mailbox: first)
        let unlocked = Draft(message: cancelled["message"])
        try check(cancelled["job"]["status"].string == "cancelled" && unlocked.scheduledSend["status"].string == "cancelled" && !unlocked.scheduleLocked, "Cancel did not atomically unlock the draft")
        try check(unlocked.payload == draft.payload && !unlocked.unconfirmed, "Cancel changed the draft or claimed uncertain delivery")
        model.newDraft(unlocked)
        try check(model.compose?.savedID == draft.savedID && model.compose?.accountID == first, "Cancelled draft could not reopen for review")
        model.compose = nil
        try await expectFailure(model, path: "/messages/" + encodedPath("sent:" + requestID), method: "GET", owner: first)
        print("Native Rust: future schedule create/replay, owned metadata, lock and cancel passed without sending.")

        // The fixture connections have no Out of Office scope. GET returns only
        // capabilities before the provider path; suggestions remain AI-disabled.
        for owner in [first, second] {
            let suggestions = try await model.request("/reply-suggestions", mailbox: owner)
            try check(suggestions["owner"].string == owner && suggestions["scope"].string == "downloaded" && !suggestions["settings"]["enabled"].bool && !suggestions["permitted"].bool, "Reply Suggestions tab permission/owner contract changed")
            try check(suggestions["job"].isNull && suggestions["proposals"] == .array([]) && suggestions["candidates"] == .array([]), "Opening Reply Suggestions started or exposed unapproved work")
            let office = try await model.request("/out-of-office", mailbox: owner)
            try check(office["accountId"].string == owner && office["supported"].bool && office["requiresReconnect"].bool && !office["canRead"].bool && !office["canWrite"].bool && office["settings"].isNull, "Out of Office tab bypassed explicit permission or lost its owner")
        }
        for route in ["/scheduled", "/reply-suggestions", "/out-of-office"] { try await expectFailure(model, path: route, method: "GET", owner: "all") }
        try await model.selectAccount(second, folder: "inbox")
        try check(!model.policy["enabled"].bool && model.preferences["syncInterval"].number == 0, "New tabs enabled background provider or AI work")
        print("Native Rust: new workspace tab contracts and permission gates passed without AI/provider calls.")
    }

    static func waitForStop(_ base: URL) async throws {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 0.5
        config.timeoutIntervalForResource = 0.5
        let probe = URLSession(configuration: config)
        defer { probe.invalidateAndCancel() }
        let url = base.appendingPathComponent("api/health")
        for _ in 0..<100 {
            do { _ = try await probe.data(from: url) }
            catch let error as URLError where error.code == .cannotConnectToHost { return }
            catch { /* A timeout or stale keep-alive connection does not prove exit. */ }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw APIError("Native Rust acceptance: stopped service still accepts requests")
    }

    @MainActor static func checkSourceNavigation(_ model: AppModel, sources: [JSON]) async throws {
        NSApplication.shared.setActivationPolicy(.accessory)
        let window = NSWindow(contentRect: NSRect(x: 50, y: 50, width: 1220, height: 780), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: MailWorkspace().environmentObject(model))
        window.makeKeyAndOrderFront(nil)
        defer { window.close(); window.contentView = nil }
        model.state = try await model.request("/settings/preferences", method: "POST", body: .object(["markReadOnOpen": .bool(false)]))
        for (index, section) in ["today", "studio", "reply-suggestions"].enumerated() {
            model.section = section
            try await Task.sleep(nanoseconds: 150_000_000)
            let source = sources[index % sources.count], owner = source["accountId"].string
            try await model.openSource(source)
            try await Task.sleep(nanoseconds: 150_000_000)
            try check(model.selectedMessage == source.viewID && model.current?.id == source.id && model.current?["accountId"].string == owner,
                      "source navigation lost its selection or owner after leaving " + section)
            try check(model.current?["body"].string.contains("Owned by " + owner) == true, "source reader lost its owned content")
        }
        model.section = "archive"
        try check(model.selectedMessage == nil && model.messageDetail.isNull && model.mailPage.isNull, "folder change did not clear the previous reader synchronously")
        model.state = try await model.request("/settings/preferences", method: "POST", body: .object(["markReadOnOpen": .bool(true)]))
        try await model.selectAccount("all", folder: "inbox")
        try check(await model.loadMailPage(), "source navigation did not restore the combined inbox")
        print("Native Rust: production source navigation retains owned content from Today, Ask and reply suggestions.")
    }

    @MainActor static func main() async throws {
        let empty = AppModel()
        empty.state = .object(["account": .object(["id": .string("demo")]), "accounts": .array([])])
        try check(!empty.hasMailbox && empty.senderAccounts.isEmpty, "empty app still exposes a demo sender")
        empty.newDraft()
        try check(empty.compose == nil && empty.showSettings && empty.settingsTab == "mail", "empty compose did not lead to Add account")
        let model = AppModel()
        defer { model.stop() }
        await model.start()
        let activity = try await model.request("/activity", mailbox: "")
        assert(!activity["tasks"].isNull && !activity["checkedAt"].string.isEmpty)

        try check(model.baseURL != nil && !model.state.isNull && model.error.isEmpty, "service launch failed: \(model.error)")
        try check(model.dataDirectory.path == ProcessInfo.processInfo.environment["MORROW_DATA_DIR"], "fixture workspace override was not retained")
        try check(Bundle.main.object(forInfoDictionaryKey: "MorrowServiceRuntime") as? String == "rust", "bundle did not select Rust")
        try check(model.accounts.count == 2 && model.account == first, "seeded account migration failed")
        try check(model.hasMailbox && model.senderAccounts.map(\.id) == [first, second], "real account selection retained the demo sender")
        try check(model.preferences["syncInterval"].number == 0 && !model.policy["enabled"].bool, "fixture background network settings changed")
        try check(model.state["settings"]["oauthClients"]["google"]["configured"].bool, "trusted bundled OAuth client was not loaded")
        try check(model.state["settings"]["oauthClients"]["microsoft"]["configured"].bool, "built-in Microsoft OAuth client was not available")
        let publicState = String(decoding: try JSONEncoder().encode(model.state), as: UTF8.self)
        try check(!publicState.contains("fixture-native-rust-"), "connection secrets appeared in public state")
        try check(model.messages.count == 50 && model.messages.allSatisfy { $0["body"].isNull }, "startup state was not paged")
        for owner in [first, second] {
            try check(model.serverFolders[owner]?.contains(where: { $0.id == "native-label" && $0["name"].string == "Projects/中文/" + owner }) == true, "startup did not restore the owning folder catalog without Browse/Refresh")
        }
        let health = try await model.request("/health")
        try check(health["service"].string == "morrow-mail", "private service health contract changed")
        let calendars = try await model.request("/calendars")
        try check(calendars["calendars"].array.isEmpty && calendars["connections"].array.allSatisfy { !$0["connected"].bool }, "fixture unexpectedly connected a calendar")

        let connected = model.state
        let connectionRevision = try await model.request("/state/revision", mailbox: "")
        model.state["accounts"] = .array([]) // Simulate the pre-connect settings snapshot.
        model.state["settings"]["calendars"] = .array([])
        model.state["serverFolders"] = .object([:])
        model.state["settings"]["preferences"]["language"] = .string("Unsaved fixture edit")
        model.unsavedForms.insert("settings")
        model.selectedMessage = "fixture-selection"
        model.mailPage = .object(["fixture": .bool(true)]); model.mailCursors = ["", "fixture-cursor"]
        let retained = model.state.picking(["account", "messages", "revision", "workspace"])
        try await model.refreshConnections()
        try check(model.state["accounts"] == connected["accounts"] && model.state["settings"]["calendars"] == connected["settings"]["calendars"], "settings did not refresh saved mail/calendar metadata")
        try check(model.state["serverFolders"] == connected["serverFolders"] && model.serverFolders[first]?.first?.id == "native-label", "settings refresh omitted cached folder names")
        try check(model.state.picking(["account", "messages", "revision", "workspace"]) == retained && model.preferences["language"].string == "Unsaved fixture edit" && model.unsavedForms == ["settings"], "connection refresh replaced the selected view or unsaved settings")
        try check(model.selectedMessage == "fixture-selection" && model.mailPage["fixture"].bool && model.mailCursors == ["", "fixture-cursor"], "connection refresh reset mail rows, selection or paging")
        try check(try await model.request("/state/revision", mailbox: "") == connectionRevision, "connection refresh mutated persisted state")
        model.state = connected; model.unsavedForms.remove("settings"); model.selectedMessage = nil
        model.mailPage = .null; model.mailCursors = [""]
        print("Native Rust: local connection refresh preserves settings edits, owner, mail paging and persisted state.")

        for owner in [first, "all"] {
            try await model.selectAccount(owner, folder: "inbox")
            for (sort, _) in mailSortOptions {
                model.state = try await model.request("/settings/preferences", method: "POST", body: .object(["sort": .string(sort)]))
                let rows = try await collect(model, expected: owner == "all" ? 130 : 65)
                try check(rows.map(\.viewID) == sortedMail(rows, by: sort).map(\.viewID), "\(sort) ordering differs from native client for \(owner)")
                try check(rows.allSatisfy { $0["accountId"].string != "demo" && (owner == "all" || $0["accountId"].string == owner) }, "account scope leaked rows")
                if owner == "all" {
                    try check(Set(rows.map(\.id)).count == 65 && Set(rows.map(\.viewID)).count == 130, "combined duplicate IDs lost their owner")
                }
                await model.turnMailPage(next: false)
                try check(model.error.isEmpty && !model.listedMessages.isEmpty, "previous page navigation failed")
            }
        }
        print("Native Rust: six sorts, bounded next/previous pages, combined identities and account scopes passed.")

        model.state = try await model.request("/settings/preferences", method: "POST", body: .object(["sort": .string("newest")]))
        try check(await model.loadMailPage(), "could not reload combined inbox")
        let duplicates = model.listedMessages.filter { $0.id == "google:shared" }
        try check(duplicates.count == 2, "shared fixture messages were not on the first page")
        for row in duplicates {
            let detail = try await model.request("/messages/" + encodedPath(row.id), mailbox: row["accountId"].string)
            try check(detail["message"]["body"].string.contains("Owned by " + row["accountId"].string), "detail routed through a different account")
        }
        try await checkPreparedDrafts(model, sources: duplicates)
        let older = try await model.request("/messages/" + encodedPath("google:fixture-064"), mailbox: first)
        try await checkSourceNavigation(model, sources: duplicates + [older["message"]])
        let opened = duplicates.first { $0["accountId"].string == first }!
        model.selectedMessage = opened.viewID
        await model.loadMessage()
        try check(model.current?["read"].bool == true && model.current?["body"].nonempty == true, "on-demand open did not load and mark read")
        _ = try await model.request("/messages/" + encodedPath(opened.id), method: "PATCH", body: .object(["read": .bool(false)]), mailbox: first)
        try await model.reload()
        await model.loadMessage()
        try check(model.current?["read"].bool == false, "refresh overrode a manual unread action")
        model.selectedMessage = nil
        model.selectedMessage = opened.viewID
        await model.loadMessage()
        try check(model.current?["read"].bool == true, "reopening did not mark read")
        _ = try await model.request("/messages/" + encodedPath(opened.id), method: "PATCH", body: .object(["starred": .bool(true)]), mailbox: first)
        let other = try await model.request("/messages/" + encodedPath(opened.id), mailbox: second)
        try check(!other["message"]["starred"].bool && !other["message"]["read"].bool, "patch changed the other account's duplicate ID")
        try await expectFailure(model, path: "/messages/" + encodedPath(opened.id), method: "PATCH", body: .object(["read": .bool(true)]), owner: "all")
        model.selectMailMessages(Set(duplicates.map(\.viewID)))
        model.patchMessages(duplicates, .object(["starred": .bool(true)]))
        while model.busy { try await Task.sleep(nanoseconds: 10_000_000) }
        try check(model.error.isEmpty && model.selectedMailRows.count == 2, "batch patch lost selection or failed: " + model.error)
        for row in duplicates {
            let result = try await model.request("/messages/" + encodedPath(row.id), mailbox: row["accountId"].string)
            try check(result["message"]["starred"].bool, "batch patch missed an owner with the same provider ID")
        }
        // Restore the established account-specific patch expected by the backup/persistence check.
        _ = try await model.request("/messages/" + encodedPath(opened.id), method: "PATCH", body: .object(["starred": .bool(false)]), mailbox: second)
        try await model.reload()
        print("Native Rust: combined multi-selection patches duplicate IDs through each captured owner and retains selection.")
        model.selectedMessage = nil
        model.unreadOnly = true
        try await model.reload()
        try check(await model.loadMailPage(), "unread filter failed")
        try check(!model.listedMessages.isEmpty && model.listedMessages.allSatisfy { !$0["read"].bool }, "unread filter included read mail")
        let unreadRows = model.listedMessages
        let firstUnread = unreadRows[0], followingUnread = unreadRows[1]
        model.selectedMessage = firstUnread.viewID
        await model.loadMessage()
        await model.refreshMailPage()
        try check(model.current?["read"].bool == true && model.listedMessages.contains { $0.viewID == firstUnread.viewID && $0["read"].bool }, "unread filtering removed the message being read")
        try check(model.listedMessages.first?.viewID == firstUnread.viewID && model.mailCursors.count == 1, "retained unread row moved or reset paging")
        model.selectedMessage = followingUnread.viewID
        await model.loadMessage()
        await model.refreshMailPage()
        try check(!model.listedMessages.contains { $0.viewID == firstUnread.viewID } && model.listedMessages.contains { $0.viewID == followingUnread.viewID && $0["read"].bool }, "switching unread mail did not release the previous read row")
        model.patch(followingUnread, .object(["pending": .bool(true)]))
        while model.busy { try await Task.sleep(nanoseconds: 10_000_000) }
        try check(model.error.isEmpty && model.listedMessages.contains { $0.viewID == followingUnread.viewID && $0["pending"].bool }, "retained read row kept an old Pending marker")
        model.patch(followingUnread, .object(["read": .bool(false), "pending": .bool(false)]))
        while model.busy { try await Task.sleep(nanoseconds: 10_000_000) }
        try check(model.error.isEmpty && model.current?["read"].bool == false && model.listedMessages.contains { $0.viewID == followingUnread.viewID && !$0["read"].bool && !$0["pending"].bool }, "manual unread action kept a stale retained read row")
        print("Native Rust: Unread retains the active read row, releases it on switching and preserves manual unread/Pending updates.")
        model.selectedMessage = nil
        model.unreadOnly = false
        print("Native Rust: owner-bound detail/patch and manual unread preservation passed.")
        try check(await model.loadMailPage(), "inbox reset failed")
        await model.turnMailPage(next: true)
        let secondPage = model.listedMessages.map(\.viewID)
        let secondUnread = model.listedMessages.first { !$0["read"].bool }!
        model.selectedMessage = secondUnread.viewID
        await model.loadMessage()
        try check(model.current?["read"].bool == true && model.selectedMessage == secondUnread.viewID, "reading page two lost its selection")
        try check(model.mailCursors.count == 2 && model.listedMessages.map(\.viewID) == secondPage, "revision change blanked or reset page two")
        await model.refreshMailPage()
        try check(model.mailCursors.count == 2 && model.listedMessages.map(\.viewID) == secondPage && model.current?.viewID == secondUnread.viewID, "refresh did not retain page two and its detail")
        let nextMessage = model.listedMessages.first { $0.viewID != secondUnread.viewID }!
        model.selectedMessage = nextMessage.viewID
        await model.loadMessage()
        await model.refreshMailPage()
        try check(model.current?.viewID == nextMessage.viewID && model.mailCursors.count == 2, "switching mail reset the page")
        print("Native Rust: read/switch keeps page two, visible rows and selected detail.")


        model.selectedMessage = nil
        model.messageDetail = .null
        model.state = try await model.request("/settings/preferences", method: "POST", body: .object(["language": .string("繁體中文"), "translationLanguage": .string("日本語"), "signatureFormat": .string("html"), "signature": .string("<b>Native Rust signature</b>")]))
        model.newDraft()
        try check(model.compose?.accountID == first, "new combined draft chose an invalid From account")
        model.compose = nil
        await model.openDraft(message: opened, mode: "reply")
        try check(model.compose?.accountID == first && model.compose?.replyToID == opened.id, "reply lost original owner")
        var draft = model.compose!
        draft.subject = "Native Rust owned draft"
        draft.body = "Saved fixture draft; no provider delivery is performed."
        draft.to = "recipient@example.invalid"
        draft.cc = "copy@example.invalid"
        draft.bcc = "hidden@example.invalid"
        model.compose = nil
        try await model.selectAccount(second, folder: "inbox")
        await model.openDraft(message: opened, mode: "replyAll", body: "Original owner review")
        try check(model.compose?.accountID == first && model.compose?.body == "Original owner review", "prepared reply followed the globally selected mailbox")
        model.compose = nil
        let saved = try await model.request("/drafts", method: "POST", body: draft.payload, mailbox: draft.accountID)
        let savedDraft = Draft(message: saved["message"])
        try check(savedDraft.accountID == first && savedDraft.bcc == draft.bcc && savedDraft.footer == draft.footer, "saved draft dropped owner, Bcc or footer")
        model.newDraft(savedDraft)
        try check(model.compose?.accountID == first && model.compose?.savedID == savedDraft.savedID, "saved draft changed owner with selected view")
        model.compose = nil
        try await expectFailure(model, path: "/messages/" + encodedPath(savedDraft.savedID), method: "GET", owner: second)
        print("Native Rust: replies and saved draft ownership, Bcc and signature round trips passed.")

        try await checkNewWorkspaceFeatures(model, draft: savedDraft)

        let oldBase = model.baseURL!
        let oldRevision = model.state["revision"].string
        model.stop()
        try check(model.baseURL == nil, "stop retained a callable base URL")
        try await waitForStop(oldBase)
        await model.start()
        try check(model.error.isEmpty && model.baseURL != nil && model.account == second, "service restart did not restore selection: \(model.error)")
        try check(model.state["revision"].string != oldRevision, "restart did not replace revision epoch")
        try check(model.preferences["language"].string == "繁體中文" && model.preferences["translationLanguage"].string == "日本語", "settings did not survive restart")
        let restored = try await model.request("/messages/" + encodedPath(savedDraft.savedID), mailbox: first)
        try check(Draft(message: restored["message"]).accountID == first && restored["message"]["body"].string == draft.body, "draft did not survive restart")
        print("Native Rust: graceful service stop, restart, encrypted settings and draft persistence passed.")

        let backupDirectory = model.dataDirectory.deletingLastPathComponent().appendingPathComponent("native-backup", isDirectory: true)
        try await model.backup(to: backupDirectory)
        let backupDatabase = backupDirectory.appendingPathComponent("genmail.sqlite")
        let backupKey = backupDirectory.appendingPathComponent("encryption.key")
        try check(FileManager.default.fileExists(atPath: backupDatabase.path) && FileManager.default.fileExists(atPath: backupKey.path), "online backup omitted database or encryption key")
        let databaseSnapshot = try Data(contentsOf: backupDatabase)
        let keySnapshot = try Data(contentsOf: backupKey)
        try check(!databaseSnapshot.isEmpty && !keySnapshot.isEmpty, "online backup wrote an empty database or key")
        var overwriteRejected = false
        do { try await model.backup(to: backupDirectory) }
        catch is APIError { overwriteRejected = true }
        try check(overwriteRejected, "online backup overwrote an existing destination")
        try check(try Data(contentsOf: backupDatabase) == databaseSnapshot && Data(contentsOf: backupKey) == keySnapshot, "rejected backup modified existing files")
        let afterBackup = try await model.request("/health")
        try check(afterBackup["status"].string == "ok", "service stopped responding after online backup")
        let afterBackupDraft = try await model.request("/messages/" + encodedPath(savedDraft.savedID), mailbox: first)
        try check(afterBackupDraft["message"] == restored["message"], "online backup changed the live draft")
        print("Native Rust: online backup, database/key preservation, overwrite rejection and continued service availability passed.")

        try await model.selectAccount("demo", folder: "inbox")
        try check(await model.loadMailPage(), "demo inbox did not load")
        let demo = model.listedMessages[0]
        try await expectFailure(model, path: "/ai", body: .object(["action": .string("summary"), "messageId": .string(demo.id)]), owner: "demo")
        model.state = try await model.request("/settings/policy", method: "POST", body: .object(["enabled": .bool(true)]))
        let assistance = try await model.request("/ai", method: "POST", body: .object(["action": .string("summary"), "messageId": .string(demo.id)]), mailbox: "demo")
        try check(assistance["source"].string == "demo" && assistance["text"].nonempty, "demo assistance did not stay local")
        let historyReply = try await model.request("/ai", method: "POST", body: .object(["action": .string("reply"), "messageId": .string(demo.id), "includeHistory": .bool(true)]), mailbox: "demo")
        try check(historyReply["source"].string == "demo" && historyReply["text"].nonempty, "history reply did not stay local")
        try check(historyReply["history"]["scope"].string == "downloaded" && historyReply["history"]["usedMessages"].number >= 1 && historyReply["history"]["usedMessages"].number <= model.policy["maxMessages"].number, "history reply exceeded the saved context limit")
        let preview = try await model.request("/workflows/preview", method: "POST", body: .object(["action": .string("schedule"), "messageId": .string(demo.id), "when": .string(utcDate(Date().addingTimeInterval(86400)))]), mailbox: "demo")
        try check(preview["simulated"].bool && !preview["preview"].id.isEmpty, "workflow preview lost simulation label")
        try await expectFailure(model, path: "/workflows/apply", body: .object(["previewId": preview["preview"]["id"]]), owner: "all")
        let applied = try await model.request("/workflows/apply", method: "POST", body: .object(["previewId": preview["preview"]["id"]]), mailbox: "demo")
        try check(applied["simulated"].bool && applied["workspace"]["events"].array.contains { $0["simulated"].bool }, "simulated schedule was not stored locally")
        try await expectFailure(model, path: "/workflows/apply", body: .object(["previewId": preview["preview"]["id"]]), owner: "demo")
        model.state = try await model.request("/settings/policy", method: "POST", body: .object(["enabled": .bool(false)]))
        print("Native Rust: disabled AI permissions, local demo assistance and one-use simulated workflow passed.")

        try await model.selectAccount(first, folder: "inbox")
        let browser = URLSession(configuration: .ephemeral, delegate: RustStopOAuthRedirects(), delegateQueue: nil)
        defer { browser.invalidateAndCancel() }
        for calendar in [false, true] {
            for provider in ["google", "microsoft"] {
                let route = calendar ? "/calendars/\(provider)/connect" : "/oauth/\(provider)/start"
                let credentials: JSON = .object(["useDefaultClient": .bool(true)])
                let started = try await model.request(route, method: "POST", body: credentials)
                let handoff = URL(string: started["url"].string)!
                try check(handoff.host == "localhost" && handoff.port == model.baseURL?.port && handoff.path.hasSuffix("/authorize"), "OAuth handoff escaped the local service")
                let (_, response) = try await browser.data(from: handoff)
                let authorization = response as! HTTPURLResponse
                try check(authorization.statusCode == 302 && authorization.url?.host == "localhost", "browser followed an external OAuth request")
                let cookie = authorization.value(forHTTPHeaderField: "Set-Cookie") ?? ""
                try check(cookie.contains("HttpOnly") && cookie.contains("SameSite=Lax"), "browser binding cookie is missing")
                let external = URLComponents(string: authorization.value(forHTTPHeaderField: "Location")!)!
                try check(external.scheme == "https" && ["accounts.google.com", "login.microsoftonline.com"].contains(external.host ?? ""), "invalid external authorization target")
                let items = external.queryItems ?? []
                try check(items.first { $0.name == "code_challenge_method" }?.value == "S256", "OAuth omitted PKCE")
                try check(!items.contains { $0.name == "client_secret" }, "OAuth secret leaked into authorization URL")
                let scope = items.first { $0.name == "scope" }?.value ?? ""
                try check(calendar ? !scope.contains("gmail") && !scope.contains("Mail.Read") : !scope.contains("calendar") && !scope.contains("Calendars"), "mail and calendar OAuth scopes mixed")
                if !calendar {
                    try check(scope.contains(provider == "google" ? "gmail.modify" : "Mail.ReadWrite") && (provider == "google" || scope.contains("Mail.Send")), "mail sign-in omitted default read/send/move permissions")
                }
                // Exercise a denied callback locally; never exchange an authorization code.
                var callback = URLComponents(string: items.first { $0.name == "redirect_uri" }!.value!)!
                callback.queryItems = [URLQueryItem(name: "state", value: items.first { $0.name == "state" }!.value), URLQueryItem(name: "error", value: "access_denied")]
                let (_, denied) = try await browser.data(from: callback.url!)
                let deniedResponse = denied as! HTTPURLResponse
                let destination = URLComponents(string: deniedResponse.value(forHTTPHeaderField: "Location")!)!
                try check(deniedResponse.statusCode == 302 && destination.queryItems?.contains { $0.name == (calendar ? "calendarError" : "connectionError") } == true, "denied OAuth callback failed")
            }
        }
        try await model.reload()
        try check(model.account == first && model.accounts.count == 2, "uncompleted OAuth changed an account")
        try check(model.state["settings"]["calendars"].array.allSatisfy { !$0["connected"].bool }, "uncompleted OAuth created a calendar connection")
        print("Native Rust: trusted OAuth configuration and browser-bound PKCE handoff passed without external requests.")

        try await model.selectAccount("all", folder: "inbox")
        model.state = try await model.request("/account/disconnect", method: "POST", body: .object([:]), mailbox: first)
        try check(model.combined && model.accounts.map(\.id) == [second], "disconnect altered the other connection or combined view")
        let remaining = try await collect(model, expected: 65)
        try check(remaining.allSatisfy { $0["accountId"].string == second }, "disconnected account remained visible")
        try await expectFailure(model, path: "/messages/" + encodedPath(savedDraft.savedID), method: "GET", owner: first)
        try await expectFailure(model, path: "/drafts/prepare", body: .object(["messageId": .string(opened.id), "mode": .string("reply")]), owner: first)
        let finalBase = model.baseURL!
        model.stop()
        try await waitForStop(finalBase)
        await model.start()
        try check(model.error.isEmpty && model.accounts.map(\.id) == [second] && model.combined, "disconnect did not survive restart")
        try check(!model.policy["enabled"].bool && model.preferences["syncInterval"].number == 0, "restart enabled background provider work")
        let closing = model.baseURL!
        model.stop()
        try await waitForStop(closing)
        print("Native Rust: disconnect isolation, cached draft retention and final shutdown passed.")
    }
}
