import AppKit
import SwiftUI

// Synthetic review only. No service, Store, credentials, provider or user database.
enum ReviewFixture {
    static let owners = ["work@fixture.invalid", "personal@fixture.invalid"]
    static let subjects = ["Friday launch: confirm the final artwork", "October invoice: approve the revised estimate", "Lunch next week?", "Workshop: choose a time", "Press preview: confirm attendance", "Weekend plans"]
    static let reasons = ["A decision is needed before Friday's launch.", "The sender asks you to approve the updated estimate.", "The sender asks which day works for you."]
    static let replies = ["Hi Maya,\n\nThank you for the artwork. [decision needed: approve or request changes]\n\nAlex", "Hi Sam,\n\nThank you for the revised estimate. [decision needed: approve or ask about the line items]\n\nAlex", "Hi Jordan,\n\nThanks for the invitation. [decision needed: Tuesday, Wednesday, or another day]\n\nAlex"]
    static let originals = ["Hi Alex,\n\nWe have attached the final artwork for Friday's launch. Could you confirm the visual direction by 3 pm today? We will export the production files after your approval.\n\nThanks,\nMaya", "Hi Alex,\n\nHere is the revised estimate for October. Please check the extra workshop materials and confirm whether the new total is approved.\n\nThanks,\nSam", "Hi Alex,\n\nWould you like to catch up for lunch next week? Tuesday or Wednesday would work for me. Let me know which is best.\n\nJordan", "Hi Alex,\n\nWe are waiting for the venue to confirm the workshop time.\n\nMaya", "The event has been cancelled. No attendance confirmation is needed.\n\nSam", "Here are our weekend photographs for your information.\n\nJordan"]
    static var stamp: String { utcDate(Date()) }
    static func message(_ index: Int, owner: String) -> JSON {
        .object(["id":.string("mail-\(index)"), "viewId":.string(owner+"/mail-\(index)"), "accountId":.string(owner), "subject":.string(subjects[index % subjects.count]), "fromName":.string(["Maya Chen","Sam Lee","Jordan Park"][index % 3]), "fromEmail":.string(["maya","sam","jordan"][index % 3]+"@example.invalid"), "to":.string(owner), "cc":.string(""), "bcc":.string(""), "body":.string(originals[index % 6]), "date":.string(stamp), "folder":.string("inbox"), "read":.bool(false), "starred":.bool(false), "pending":.bool(false), "labels":.array([]), "attachments":.array([])])
    }
    static func proposal(_ index: Int, owner: String) -> JSON {
        .object(["id":.string("proposal-\(index)"), "proposalId":.string("proposal-\(index)"), "accountId":.string(owner), "messageId":.string("mail-\(index)"), "message":message(index,owner:owner), "reason":.string(reasons[index % 3]), "text":.string(replies[index % 3]), "questions":.array([.string(["Do you approve the final artwork?","Is the revised amount approved?","Which day suits you?"][index % 3])]), "evidence":.array([.object(["messageId":.string("mail-\(index)"),"field":.string("body"),"quote":.string(originals[index % 3])])]), "sourceMessages":.array([.object(["id":.string("mail-\(index)"),"accountId":.string(owner),"subject":.string(subjects[index % subjects.count]),"date":.string(stamp),"reference":.number(1)])]), "approvedStyleUsed":.bool(true)])
    }
    static func event(_ index: Int, owner: String) -> JSON {
        let states=["waiting_on_user","waiting_on_user","uncertain","waiting_on_others","completed","informational"]
        var event: JSON = .object(["id":.string(owner+"/event-\(index)"),"accountId":.string(owner),"messageId":.string("mail-\(index)"),"messageIds":.array([.string("mail-\(index)")]),"priority":.string("P\(min(index,4))"),"title":.string(subjects[index]),"action":.string(["Approve the artwork or request changes.","Approve the revised amount or question the new items.","Choose a day before drafting an answer.","Wait for the venue's confirmation.","No attendance reply is needed.","Read when convenient."][index]),"state":.string(states[index]),"replyNeeded":.string(index<2 ? "yes":index==2 ? "uncertain":"no"),"grounded":.bool(true),"evidence":.array([.object(["messageId":.string("mail-\(index)"),"accountId":.string(owner),"field":.string("body"),"quote":.string(originals[index])])]),"questions":.array(index<3 ? [.string(["Do you approve the final artwork?","Is the revised amount approved?","Which day suits you?"][index])]:[]),"deadline":.null,"updatedAt":.string(stamp)])
        if index==0 { event["deadline"] = .object(["messageId":.string("mail-0"),"accountId":.string(owner),"field":.string("body"),"quote":.string("by 3 pm today"),"sourceDate":.string(stamp)]) }
        return event
    }
    static func replyState(owner: String) -> JSON {
        .object(["owner":.string(owner),"identityReady":.bool(true),"modelReady":.bool(true),"permitted":.bool(true),"automaticReady":.bool(true),"automaticStatus":.string("All downloaded Inbox mail has been checked. Waiting for new mail."),"spentToday":.number(12000),"settings":.object(["enabled":.bool(true),"automatic":.bool(true),"tokenBudget":.number(64000),"dailyTokenBudget":.number(100000)]),"job":.object(["status":.string("completed")]),"model":.object(["model":.string("Synthetic model"),"baseUrl":.string("http://127.0.0.1:18484")]),"proposals":.array((0..<3).map { proposal($0,owner:owner) })])
    }
    static func state(owner: String) -> JSON {
        let reports: [JSON] = owners.enumerated().map { offset, account in
            .object(["id":.string("summary-\(offset)"),"accountId":.string(account),"kind":.string("daily"),"status":.string("completed"),"updatedAt":.string(stamp),"messageIds":.array((0..<6).map { .string("mail-\($0)") }), "text":.string("P0 — Launch artwork needs a decision today. Confirm the final export with Maya before the production team starts.\n\nP1 — The October invoice includes revised workshop costs. Sam is waiting for budget approval.\n\nP2 — Jordan suggested lunch next week. Pick a day when you have a moment.\n\nP3 — The workshop schedule has been circulated. Read the agenda before Thursday.\n\nP4 — The press preview and weekend plans are informational. No immediate reply is required."),"items":.array((0..<6).map { i in .object(["messageId":.string("mail-\(i)"),"priority":.string("P\(min(i,4))"),"summary":.string(subjects[i])]) })])
        }
        let todayReplies = owners.flatMap { account in (0..<3).map { index -> JSON in var p = proposal(index,owner:account); p["id"] = .string(account+"/proposal-\(index)"); return p } }
        return .object(["account":.object(["id":.string(owner),"mode":.string(owner == "all" ? "combined" : "live")]),"accounts":.array(owners.map { .object(["id":.string($0),"email":.string($0),"mode":.string("live"),"provider":.string("imap"),"unread":.number(14),"counts":.object(["inbox":.number(42),"drafts":.number(3)]),"settings":.object(["configured":.bool(true)])]) }),"messages":.array((0..<6).map { message($0,owner:owner == "all" ? owners[0] : owner) }),"features":.array([]),"revision":.string("synthetic"),"today":.object(["summaries":.array(reports),"events":.array(owners.flatMap { account in (0..<6).map { event($0,owner:account) } }),"replySuggestions":.array(todayReplies),"replySuggestionCounts":.object(Dictionary(uniqueKeysWithValues:owners.map { ($0,JSON.number(3)) })),"summaryOverflow":.number(0)]),"settings":.object(["ai":.object(["configured":.bool(true)]),"policy":.object(["enabled":.bool(true),"behaviors":.object(["reply":.bool(true),"briefing":.bool(true)]),"folders":.object(["inbox":.bool(true)]),"content":.object(["sender":.bool(true),"subject":.bool(true),"body":.bool(true)]),"triggers":.object(["scheduledSummary":.bool(true),"onArrival":.bool(true)]),"summarySchedule":.object(["cadence":.string("daily"),"time":.string("08:00"),"timeZone":.string("Etc/UTC")])]),"preferences":.object(["theme":.string("light"),"markReadOnOpen":.bool(false)]),"calendars":.object([:])]),"workspace":.object([:])])
    }
}

final class ReviewProtocol: URLProtocol {
    static let lock = NSLock()
    static var owner = ReviewFixture.owners[0]
    static var failReply = false
    static var wrongDraftOwner = false
    static var traffic: [[String:String]] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard request.url?.host == "127.0.0.1", request.url?.port == 18484 else { throw APIError("Fixture rejects every external destination.") }
            let path = request.url!.path, account = request.value(forHTTPHeaderField:"X-Genmail-Account") ?? ""
            guard account.isEmpty || account == "all" || ReviewFixture.owners.contains(account) else { throw APIError("Unexpected fixture owner") }
            let body = try Self.body(request)
            Self.lock.lock(); defer { Self.lock.unlock() }
            Self.traffic.append(["path":path,"method":request.httpMethod ?? "GET","account":account])
            var response: JSON = .null
            var status = 200
            switch path {
            case "/api/reply-suggestions":
                if Self.failReply { status=503; response = .object(["error":.string("Synthetic connection error. Try again.")]) }
                else if account == "all" {
                    let proposals=ReviewFixture.owners.flatMap { owner in ReviewFixture.replyState(owner:owner)["proposals"].array.map { p -> JSON in var p=p; p["id"] = .string(owner+"/"+p.id); return p } }
                    response = .object(["owner":.string("all"),"proposals":.array(proposals)])
                } else { response=ReviewFixture.replyState(owner:account) }
            case "/api/reply-suggestions/use":
                let i = Int(body["id"].string.split(separator:"-").last ?? "0") ?? 0
                response = .object(["message":ReviewFixture.message(i,owner:account),"text":.string(ReviewFixture.replies[i % 3])])
            case "/api/drafts":
                var saved=body; saved["id"] = .string("saved-"+account); saved["accountId"] = .string(account); saved["folder"] = .string("drafts")
                response = .object(["message":saved])
            case "/api/drafts/prepare":
                let i = Int(body["messageId"].string.split(separator:"-").last ?? "0") ?? 0
                let m = ReviewFixture.message(i,owner:account)
                response = .object(["draft":.object(["accountId":.string(account),"to":m["fromEmail"],"cc":.string(""),"bcc":.string(""),"subject":.string("Re: "+m["subject"].string),"body":body["body"],"replyToId":body["messageId"]])])
                if Self.wrongDraftOwner { response["draft"]["accountId"] = .string(ReviewFixture.owners.first { $0 != account }!) }
            case "/api/account/select": Self.owner=body["accountId"].string; response=ReviewFixture.state(owner:Self.owner)
            case "/api/state": response=ReviewFixture.state(owner:Self.owner)
            case "/api/sync/priority": response = .object(["accepted":.bool(true)])
            case "/api/mail/page": response = .object(["messages":ReviewFixture.state(owner:account)["messages"],"total":.number(6),"nextCursor":.null])
            case "/api/search/preferences": response = .object(["saved":.array([]),"recent":.array([])])
            case let p where p.hasPrefix("/api/messages/") && request.httpMethod == "GET":
                let i = Int(p.split(separator:"-").last ?? "0") ?? 0
                response = .object(["message":ReviewFixture.message(i,owner:account)])
            default: throw APIError("Fixture rejects unexpected request: "+path)
            }
            let data = try JSONEncoder().encode(response)
            client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:"HTTP/1.1",headerFields:["Content-Type":"application/json"])!,cacheStoragePolicy:.notAllowed)
            client?.urlProtocol(self,didLoad:data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self,didFailWithError:error) }
    }
    override func stopLoading() {}
    static func setFailure(_ value: Bool) { lock.lock(); defer { lock.unlock() }; failReply=value }
    static func setWrongDraftOwner(_ value: Bool) { lock.lock(); defer { lock.unlock() }; wrongDraftOwner=value }
    static func recordedTraffic() -> [[String:String]] { lock.lock(); defer { lock.unlock() }; return traffic }

    static func body(_ request: URLRequest) throws -> JSON {
        if let data=request.httpBody { return try JSONDecoder().decode(JSON.self,from:data) }
        guard let stream=request.httpBodyStream else { return .null }
        stream.open(); defer { stream.close() }
        var data=Data(), buffer=[UInt8](repeating:0,count:4096)
        while stream.hasBytesAvailable { let n=stream.read(&buffer,maxLength:buffer.count); guard n>=0,data.count+n<=65536 else { throw APIError("Invalid fixture body") }; if n==0 { break }; data.append(contentsOf:buffer.prefix(n)) }
        return data.isEmpty ? .null : try JSONDecoder().decode(JSON.self,from:data)
    }
}
