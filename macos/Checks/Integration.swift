import Foundation

// Observe redirects without ever contacting a real OAuth provider.
final class StopOAuthRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

// Runs the actual native API client against a private bundled-service fixture.
// No UI automation and no real provider requests are used by these checks.
@main
struct NativeClientChecks {
    @MainActor static func main() async throws {
        let model = AppModel()
        await model.start()
        let activity = try await model.request("/activity", mailbox: "")
        assert(!activity["tasks"].isNull && !activity["checkedAt"].string.isEmpty)

        defer { model.stop() }
        guard !model.state.isNull else { throw APIError(model.error) }
        assert(model.state["settings"]["oauthClients"]["google"]["configured"].bool)
        let publicState = try JSONEncoder().encode(model.state)
        assert(!String(decoding: publicState, as: UTF8.self).contains("fixture-bundled-secret"))
        assert(model.features.count == 19)
        assert(model.messages.allSatisfy { $0["body"].isNull && $0["footer"].isNull })
        assert(model.hasMailbox && model.account == "native@example.com" && !model.senderAccounts.contains { $0.id == "demo" })
        try await model.sync() // Fetch isolated provider fixtures into the real mailbox selected at startup.
        await model.loadMailPage()
        assert(!model.listedMessages.isEmpty && model.mailPage["pageSize"].number == 50)
        model.selectedMessage = model.listedMessages[0].viewID
        await model.loadMessage()
        assert(model.current?["body"].nonempty == true)
        let revision = try await model.request("/state/revision")
        assert(revision["revision"] == model.state["revision"])
        let opened = model.current!
        let originalView = [model.account, model.section, model.selectedMessage ?? ""]
        model.openAssistant("reply", message: opened, includeHistory: true)
        assert(model.readerAssistant?["includeHistory"].bool == true)
        assert([model.account, model.section, model.selectedMessage ?? ""] == originalView, "Reader assistance must not navigate to AI Studio or switch accounts.")
        let readerRequest = model.readerAssistant!
        assert(model.readerAssistantIsCurrent(readerRequest))
        model.newDraft()
        assert(model.compose == nil, "Do not open a second sheet over reader assistance.")
        let sourceDetail = model.messageDetail
        model.messageDetail["body"] = .string("changed fixture source")
        assert(!model.readerAssistantIsCurrent(readerRequest), "A changed source must invalidate its AI result.")
        model.messageDetail = sourceDetail
        model.readerAssistant = nil
        _ = try await model.request("/messages/" + encodedPath(opened.id), method: "PATCH", body: .object(["read": .bool(false)]), mailbox: opened["accountId"].string)
        try await model.reload()
        await model.loadMessage()
        assert(model.current?["read"].bool == false, "Refreshing the body must preserve a manual mark-unread action.")
        model.selectedMessage = nil
        model.selectedMessage = opened.viewID
        await model.loadMessage()
        assert(model.current?["read"].bool == true, "Reopening the message still marks it read.")
        model.selectedMessage = nil; model.messageDetail = .null; model.mailPage = .null
        print("Native bounded mail metadata, on-demand body and revision checks passed.")
        let update = try await model.request("/updates?includePrereleases=true")
        assert(update["updateAvailable"].bool && update["latestVersion"].string == "0.5.0-alpha.2")
        model.includePrereleases = true
        let updateTime = Date(timeIntervalSince1970: 1_000_000)
        model.busy = true
        await model.checkForUpdates(now: updateTime)
        assert(model.updateAvailable && model.busy && !model.checkingUpdates)
        assert(model.lastUpdateCheckAttempt == updateTime)
        await model.checkForUpdates(now: updateTime.addingTimeInterval(3599))
        assert(model.lastUpdateCheckAttempt == updateTime)
        await model.checkForUpdates(now: updateTime.addingTimeInterval(3600))
        assert(model.lastUpdateCheckAttempt == updateTime.addingTimeInterval(3600))
        await model.checkForUpdates(force: true, now: updateTime.addingTimeInterval(3601))
        assert(model.lastUpdateCheckAttempt == updateTime.addingTimeInterval(3601))
        model.includePrereleases = false
        assert(!model.updateAvailable && model.lastUpdateCheckAttempt == nil)
        model.includePrereleases = true
        await model.checkForUpdates(now: updateTime)
        model.busy = false
        model.settings(model.updateAvailable ? "about" : "general")
        assert(model.showSettings && model.settingsTab == "about")
        model.showSettings = false
        print("Native hourly update checks, manual checks, channel reset and Settings shortcut passed.")
        let trigger: JSON = .object(["action": .string("summary"), "trigger": .string("onOpen"), "messageId": .string("demo-1")])
        let disabledTrigger = try await model.request("/ai", method: "POST", body: trigger, mailbox: "demo")
        assert(disabledTrigger["skipped"].bool)
        model.state = try await model.request("/settings/policy", method: "POST", body: .object(["triggers": .object(["onOpen": .bool(true), "onReply": .bool(true)])]))
        let automatic = try await model.request("/ai", method: "POST", body: trigger, mailbox: "demo")
        assert(automatic["text"].nonempty && automatic["source"].string == "demo")
        let replyTrigger = try await model.request("/ai", method: "POST", body: .object(["action": .string("reply"), "trigger": .string("onReply"), "messageId": .string("demo-1")]), mailbox: "demo")
        assert(replyTrigger["text"].nonempty)
        model.state = try await model.request("/settings/policy", method: "POST", body: .object(["triggers": .object(["onOpen": .bool(false), "onReply": .bool(false)])]))
        print("Native update response and opt-in AI trigger checks passed.")
        model.state = try await model.request("/settings/preferences", method: "POST", body: .object(["language": .string("繁體中文"), "translationLanguage": .string("日本語"), "syncInterval": .number(1)]))
        assert(model.preferences["language"].string == "繁體中文" && model.preferences["translationLanguage"].string == "日本語")
        model.state = try await model.request("/settings/policy", method: "POST", body: .object(["triggers": .object(["onArrival": .bool(true), "scheduledSummary": .bool(true)]), "summarySchedule": .object(["cadence": .string("interval"), "everyHours": .number(4), "time": .string("09:15"), "timeZone": .string("Asia/Hong_Kong")])]))
        try await model.reload()
        assert(model.policy["triggers"]["onArrival"].bool && model.policy["triggers"]["scheduledSummary"].bool)
        assert(model.policy["summarySchedule"]["everyHours"].number == 4 && model.policy["summarySchedule"]["timeZone"].string == "Asia/Hong_Kong")
        model.state = try await model.request("/settings/policy", method: "POST", body: .object(["triggers": .object(["onArrival": .bool(false), "scheduledSummary": .bool(false)])]))
        model.state = try await model.request("/settings/preferences", method: "POST", body: .object(["syncInterval": .number(0)]))
        print("Native summary schedule and separate language settings round-trip passed.")
        try await model.selectAccount("demo") // Explicit fixture-only catalogue; no Demo entry exists in the UI.
        let selectedID = model.messages[0].id
        let historyReply = try await model.request("/ai", method: "POST", body: .object(["action": .string("reply"), "messageId": .string(selectedID), "includeHistory": .bool(true)]), mailbox: "demo")
        assert(historyReply["text"].nonempty && historyReply["source"].string == "demo")
        assert(historyReply["history"]["scope"].string == "downloaded" && historyReply["history"]["usedMessages"].number >= 1 && historyReply["history"]["usedMessages"].number <= model.policy["maxMessages"].number)
        let calendars = try await model.request("/calendars")
        assert(calendars["connections"].array.filter { $0["connected"].bool }.count == 2)
        assert(calendars["calendars"].array.count == 4)
        for provider in ["google", "microsoft"] {
            let id = UUID().uuidString.lowercased()
            let payload: JSON = .object(["calendarId": .string("primary"), "connectionEmail": .string(provider + "@example.com"), "title": .string("Native calendar check"), "start": .string("2026-10-01T09:00:00Z"), "end": .string("2026-10-01T10:00:00Z"), "requestId": .string(id)])
            let created = try await model.request("/calendars/\(provider)/events", method: "POST", body: payload)
            let replay = try await model.request("/calendars/\(provider)/events", method: "POST", body: payload)
            assert(created["event"].id == id && replay["event"].id == id)
            let events = try await model.request("/calendars/\(provider)/events?calendarId=primary&start=2026-10-01T00%3A00%3A00Z&end=2026-10-02T00%3A00%3A00Z")
            assert(events["events"].array.contains { $0.id == id })
        }
        model.state = try await model.request("/settings/policy", method: "POST", body: .object(["content": .object(["attachments": .bool(true)])]))
        for feature in model.features {
            var input: JSON = .object(["action": .string(feature.id), "messageId": .string(selectedID), "prompt": .string("Summarize or draft a short response."), "draftText": .string("Hello, thank you for your message."), "skillId": model.state["workspace"]["skills"].array.first?["id"] ?? .null])
            if ["followup", "schedule"].contains(feature.id) { input["when"] = .string(utcDate(Date().addingTimeInterval(86400))) }
            if feature["mock"].bool {
                let result = try await model.request("/workflows/preview", method: "POST", body: input)
                assert(!result["preview"].id.isEmpty)
                _ = try await model.request("/workflows/apply", method: "POST", body: .object(["previewId": result["preview"]["id"]]))
            } else {
                let result = try await model.request("/ai", method: "POST", body: input)
                assert(result["text"].nonempty)
            }
        }
        _ = try await model.request("/settings/policy", method: "POST", body: .object(["behaviors": .object(["summary": .bool(false)])]))
        do {
            _ = try await model.request("/ai", method: "POST", body: .object(["action": .string("summary"), "messageId": .string(selectedID)]))
            assertionFailure("Disabled behavior was allowed")
        } catch let error as APIError { assert(error.localizedDescription.contains("disabled")) }
        model.state = try await model.request("/account/live", method: "POST", body: .object([:]))
        var draft = Draft(); draft.to = "recipient@example.com"; draft.subject = "Native recovery check"; draft.body = "Fixture delivery only. Please review the suggested timetable and share your feedback when you have a moment."
        let saved = try await model.request("/drafts", method: "POST", body: draft.payload)
        draft.savedID = saved["message"].id
        var payload = draft.payload
        payload["draftId"] = .string(draft.savedID); payload["requestId"] = .string(draft.requestID)
        do {
            _ = try await model.request("/send", method: "POST", body: payload)
            assertionFailure("Expected an uncertain delivery")
        } catch let error as APIError {
            assert(error.payload["requiresSendReview"].bool)
            let recovered = Draft(message: error.payload["message"])
            assert(recovered.unconfirmed && recovered.requestID == draft.requestID && recovered.savedID == draft.savedID)
        }
        do {
            _ = try await model.request("/send", method: "POST", body: payload)
            assertionFailure("Unreviewed retry was allowed")
        } catch let error as APIError { assert(error.payload["requiresSendReview"].bool) }
        payload["retryUnconfirmed"] = .bool(true)
        let sent = try await model.request("/send", method: "POST", body: payload)
        let replay = try await model.request("/send", method: "POST", body: payload)
        assert(sent["message"].id == replay["message"].id && sent["message"].id == "sent:" + draft.requestID)
        for address in ["first@example.com", "second@example.com"] {
            let mail: JSON = .object(["email": .string(address), "password": .string("fixture"), "imapHost": .string("fixture.invalid"), "smtpHost": .string("fixture.invalid")])
            model.state = try await model.request("/settings/mail", method: "POST", body: mail)
        }
        assert(model.accounts.count == 3) // Includes the migrated legacy connection.
        try await model.selectAccount("all", folder: "inbox")
        let allDuplicates = model.messages.filter { $0.id == "shared-inbox-id" }
        assert(allDuplicates.count == 3 && Set(allDuplicates.map(\.viewID)).count == 3)
        let duplicates = allDuplicates.filter { $0["accountId"].string != "native@example.com" }
        for row in duplicates {
            let detail = try await model.request("/messages/" + encodedPath(row.id), mailbox: row["accountId"].string)
            assert(detail["message"]["accountId"] == row["accountId"] && detail["message"]["body"].nonempty)
        }
        let searchOptions: JSON = .object(["query": .string("Owned"), "scope": .string("all"), "sort": .string("relevance")])
        let search = try await model.request("/search", method: "POST", body: searchOptions)
        assert(search["total"].number == 3 && Set(search["messages"].array.map(\.viewID)).count == 3)
        assert(search["messages"].array.allSatisfy { !$0["searchSnippet"].array.isEmpty })
        model.searchResponse = search; model.selectedMessage = search["messages"].array[1].viewID
        let searchReply = try await model.prepareDraft(message: model.current!, mode: "reply")
        assert(searchReply.accountID == search["messages"].array[1]["accountId"].string)
        _ = try await model.request("/search/preferences", method: "POST", body: .object(["action": .string("save"), "value": searchOptions]))
        let savedSearch = try await model.request("/search/preferences")
        assert(savedSearch["saved"].array.first?["query"].string == "Owned")
        model.searchResponse = .null
        model.selectedMessage = duplicates[1].viewID
        assert(model.current?["accountId"] == duplicates[1]["accountId"])
        for source in duplicates {
            let reply = try await model.prepareDraft(message: source, mode: "replyAll", body: "Reviewed native suggestion")
            assert(reply.accountID == source["accountId"].string && reply.replyToID == source.id)
            assert(reply.to == "sender@example.com" && reply.bcc.isEmpty && reply.body == "Reviewed native suggestion")
            let forward = try await model.prepareDraft(message: source, mode: "forward")
            assert(forward.forwarding && forward.accountID == reply.accountID && forward.replyToID.isEmpty)
            assert(forward.to.isEmpty && forward.cc.isEmpty && forward.bcc.isEmpty && forward.body.contains("Owned by " + reply.accountID))
        }
        model.state = try await model.request("/settings/preferences", method: "POST", body: .object(["signatureFormat": .string("html"), "signature": .string("<b>Native signature</b>")]))
        await model.openDraft(message: duplicates[1], mode: "reply")
        assert(model.compose?.accountID == duplicates[1]["accountId"].string)
        assert(model.compose?.footer["html"].string == "<b>Native signature</b>")
        let reply = model.compose!
        let savedReply = try await model.request("/drafts", method: "POST", body: reply.payload, mailbox: reply.accountID)
        assert(Draft(message: savedReply["message"]).footer == reply.footer)
        model.compose = nil
        model.newDraft()
        assert(model.compose?.accountID == model.accounts.first?.id)
        model.compose = nil
        let owner = duplicates[1]["accountId"].string
        _ = try await model.request("/messages/shared-inbox-id", method: "PATCH", body: .object(["starred": .bool(true)]), mailbox: owner)
        try await model.reload()
        assert(model.messages.filter { $0.id == "shared-inbox-id" && $0["starred"].bool }.count == 1)
        let ownedDraft = try await model.request("/drafts", method: "POST", body: .object(["to": .string("recipient@example.com"), "subject": .string("Combined view"), "body": .string("Account owned draft")]), mailbox: owner)
        assert(Draft(message: ownedDraft["message"]).accountID == owner)
        try await model.sync()
        assert(model.combined)
        model.state = try await model.request("/account/disconnect", method: "POST", body: .object([:]), mailbox: owner)
        assert(model.accounts.count == 2 && model.combined && !model.messages.contains { $0["accountId"].string == owner })
        try await model.selectAccount("native@example.com", folder: "sent")
        assert(model.messages.contains { $0.id == "sent:" + draft.requestID })
        model.state = try await model.request("/imports/start", method: "POST", body: .object(["months": .number(3), "inbox": .bool(true), "sent": .bool(true)]))
        assert(model.accounts.first(where: { $0.id == "native@example.com" })?["import"]["status"].string == "running")
        model.state = try await model.request("/imports/pause", method: "POST", body: .object([:]))
        assert(model.accounts.first(where: { $0.id == "native@example.com" })?["import"]["status"].string == "paused")
        model.state = try await model.request("/settings/ai", method: "POST", body: .object(["baseUrl": .string("http://127.0.0.1:11434/v1"), "model": .string("native-fixture")]))
        model.state = try await model.request("/settings/policy", method: "POST", body: .object(["folders": .object(["sent": .bool(true)]), "content": .object(["body": .bool(true), "contacts": .bool(false)])]))
        model.state = try await model.request("/style/settings", method: "POST", body: .object(["enabled": .bool(true), "maxSamples": .number(50), "tokenBudget": .number(16000)]))
        model.state = try await model.request("/style/preview", method: "POST", body: .object([:]))
        let stylePreview = model.state["workspace"]["styleLearning"]["preview"]
        assert(stylePreview["sampleCount"].number > 0 && stylePreview["estimatedTokens"].number <= 16000)
        model.state = try await model.request("/style/generate", method: "POST", body: .object(["previewId": .string(stylePreview.id)]))
        assert(model.state["workspace"]["styleLearning"]["preview"]["status"].string == "ready")
        model.state = try await model.request("/style/apply", method: "POST", body: .object(["previewId": .string(stylePreview.id), "voice": .string("Reviewed native style.")]))
        assert(model.state["workspace"]["styleLearning"]["profile"]["active"].bool)
        model.state = try await model.request("/style/profile", method: "DELETE", body: .object([:]))
        assert(model.state["workspace"]["styleLearning"]["profile"].isNull)
        print("Native import controls and writing-style preview, review, save and delete checks passed.")
        _ = try await model.request("/search/settings", method: "POST", body: .object(["enabled": .bool(true), "baseUrl": .string("http://127.0.0.1:11434/v1"), "model": .string("fixture-embedding"), "accounts": .array([.string("native@example.com")])]))
        let indexPreview = try await model.request("/search/index/preview", method: "POST", body: .object([:]))
        assert(indexPreview["job"]["sampleCount"].number > 0 && indexPreview["job"]["estimatedTokens"].number <= 16000)
        _ = try await model.request("/search/index/run", method: "POST", body: .object(["previewId": .string(indexPreview["job"].id)]))
        var indexState = try await model.request("/search/settings")
        for _ in 0..<30 { if indexState["job"]["status"].string != "running" { break }; try await Task.sleep(nanoseconds: 50_000_000); indexState = try await model.request("/search/settings") }
        assert(indexState["job"]["status"].string == "complete" && indexState["indexed"].number > 0)
        let hybrid = try await model.request("/search", method: "POST", body: .object(["query": .string("timetable"), "scope": .string("account"), "smart": .bool(true)]))
        assert(hybrid["total"].number > 0 && hybrid["messages"].array.allSatisfy { $0["accountId"].string == "native@example.com" })
        _ = try await model.request("/search/index/clear", method: "POST", body: .object([:]))
        _ = try await model.request("/search/settings", method: "POST", body: .object(["enabled": .bool(false)]))
        print("Native indexed/hybrid search, saved searches, cross-account reply ownership and reviewed embedding indexing passed.")
        let browser = URLSession(configuration: .ephemeral, delegate: StopOAuthRedirects(), delegateQueue: nil)
        defer { browser.invalidateAndCancel() }
        for calendar in [false, true] {
            for provider in ["google", "microsoft"] {
                try await model.selectAccount("native@example.com")
                let route = calendar ? "/calendars/\(provider)/connect" : "/oauth/\(provider)/start"
                let credentials: JSON = provider == "google" ? .object(["useDefaultClient": .bool(true)]) : .object(["clientId": .string("fixture-client")])
                let started = try await model.request(route, method: "POST", body: credentials)
                let handoff = URL(string: started["url"].string)!
                assert(handoff.host == "localhost" && handoff.port == model.baseURL?.port && handoff.path.hasSuffix("/authorize"))
                let (_, authorization) = try await browser.data(from: handoff)
                let authResponse = authorization as! HTTPURLResponse
                assert(authResponse.statusCode == 302)
                let external = URLComponents(string: authResponse.value(forHTTPHeaderField: "Location")!)!
                assert(external.queryItems?.first(where: { $0.name == "code_challenge_method" })?.value == "S256")
                let callback = external.queryItems!.first(where: { $0.name == "redirect_uri" })!.value!
                let state = external.queryItems!.first(where: { $0.name == "state" })!.value!
                var callbackURL = URLComponents(string: callback)!
                callbackURL.queryItems = [URLQueryItem(name: "state", value: state), URLQueryItem(name: "code", value: "fixture-code")]
                let (_, completion) = try await browser.data(from: callbackURL.url!)
                let completed = completion as! HTTPURLResponse
                assert(completed.statusCode == 302)
                let destination = URLComponents(string: completed.value(forHTTPHeaderField: "Location")!)!
                assert(destination.queryItems?.first(where: { $0.name == (calendar ? "calendarConnected" : "connected") })?.value == provider)
                let (page, _) = try await browser.data(from: destination.url!)
                assert(String(decoding: page, as: UTF8.self).contains("Return to Morrow Mail"))
                try await model.reload()
                if calendar {
                    assert(model.account == "native@example.com") // Calendar sign-in does not switch the mailbox.
                    assert(model.state["settings"]["calendars"].array.contains { $0["provider"].string == provider && $0["email"].string == "oauth-\(provider)@example.com" })
                } else {
                    assert(model.account == "oauth-\(provider)@example.com" && model.state["account"]["mode"].string == "live")
                }
            }
        }
        print("Native browser OAuth handoff and callback passed for both mail and calendar providers; mail returns to the connected inbox.")
        print("Native client integration passed: 19 behaviors, permissions, both calendars, send recovery, multi-account routing, combined IDs, and disconnect isolation.")
    }
}
