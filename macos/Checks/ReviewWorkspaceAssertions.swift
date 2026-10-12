import AppKit
import SwiftUI

@main struct ReviewWorkspaceAssertions {
    @MainActor static func require(_ value: Bool, _ message: String) throws { if !value { throw APIError("Review fixture: " + message) } }
    @MainActor static func snapshot(_ view: AnyView, name: String, width: CGFloat = 1140) async throws {
        guard let directory=ProcessInfo.processInfo.environment["REVIEW_EVIDENCE_DIR"] else { return }
        let window=NSWindow(contentRect:NSRect(x:30,y:30,width:width,height:720),styleMask:[.titled],backing:.buffered,defer:false)
        window.isReleasedWhenClosed=false; window.appearance=NSAppearance(named:.aqua); window.title="Morrow implementation · synthetic only"
        let host=NSHostingView(rootView:AnyView(view.frame(width:width,height:720).background(Color.white)))
        window.contentView=host; window.makeKeyAndOrderFront(nil)
        defer { window.close(); window.contentView=nil }
        try await Task.sleep(nanoseconds:700_000_000)
        host.frame=NSRect(x:0,y:0,width:width,height:720); host.layoutSubtreeIfNeeded()
        guard let bitmap=host.bitmapImageRepForCachingDisplay(in:host.bounds) else { throw APIError("No native review bitmap") }
        host.cacheDisplay(in:host.bounds,to:bitmap)
        try bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:directory).appendingPathComponent(name+".png"))
    }
    @MainActor static func main() async {
        _=NSApplication.shared; NSApp.setActivationPolicy(.regular)
        let config=URLSessionConfiguration.ephemeral; config.protocolClasses=[ReviewProtocol.self]
        let model=AppModel(session:URLSession(configuration:config))
        model.starting=false; model.state=ReviewFixture.state(owner:ReviewFixture.owners[0]); model.section="today"
        defer { model.session.invalidateAndCancel() }
        do {
            let review=model.review, first=ReviewFixture.owners[0], second=ReviewFixture.owners[1]
            await review.load("all",model:model)
            try require(review.queue(model).count==6,"All must aggregate fictional account-owned rows")
            let a=ReviewFixture.proposal(0,owner:first), b=ReviewFixture.proposal(0,owner:second)
            review.pickScope(first); await review.load(first,model:model); await review.inspect(a,model:model)
            let keyA=review.key(a), keyB=review.key(b)
            try require(review.drafts[keyA]?.accountID==first && review.drafts[keyA]?.replyToID=="mail-0","prepared draft owner and target")
            review.drafts[keyA]?.body="Edited locally. Keep this when switching accounts."
            review.scrollPositions["reply-detail:"+keyA]=180
            review.pickScope(second); await review.load(second,model:model); await review.inspect(b,model:model)
            try require(review.drafts[keyB]?.accountID==second && review.messages[keyB]?["accountId"].string==second,"colliding provider ID must keep its owner")
            review.pickScope(first)
            try require(review.drafts[keyA]?.body=="Edited locally. Keep this when switching accounts." && review.selection[first]==keyA && review.scrollPositions["reply-detail:"+keyA]==180,"A to B to A keeps text, selection and scroll")
            try require(model.account==first && model.canNavigate && model.updateHasUnsavedChanges,"review scope cannot change global sending identity; navigation and quit/update guards differ")
            await review.showOriginal(.object(["id":.string("mail-0"),"accountId":.string(second)]),model:model)
            try require(review.originals["original:"+second+"\nmail-0"]?["accountId"].string==second && model.account==first,"inline original read must not navigate global mailbox")
            review.originalSelection[first]=nil
            ReviewProtocol.setFailure(true); await review.load(first,model:model)
            try require(review.errors[first] != nil && !review.loading.contains(first) && review.drafts[keyA]?.body=="Edited locally. Keep this when switching accounts.","initial/update failure must stop loading and retain edited text")
            ReviewProtocol.setFailure(false); await review.load(first,model:model)
            review.stale.insert(keyA);review.reviewedFacts.insert(keyA)
            await review.refreshKeepingEdits(a,fresh:a,model:model)
            try require(review.drafts[keyA]?.body=="Edited locally. Keep this when switching accounts." && !review.stale.contains(keyA) && !review.reviewedFacts.contains(keyA),"refreshing evidence must preserve text while withdrawing facts approval")
            review.options[first]?["dailyTokenBudget"] = .number(200000)
            review.pickScope(second); await review.load(second,model:model); review.pickScope(first); await review.load(first,model:model)
            try require(review.options[first]?["dailyTokenBudget"].number==200000,"account switches and polling must retain unsaved budget settings")
            ReviewProtocol.setWrongDraftOwner(true)
            let wrong=ReviewFixture.proposal(2,owner:first), wrongKey=review.key(wrong)
            await review.inspect(wrong,model:model)
            try require(review.drafts[wrongKey]==nil && review.errors[wrongKey] != nil,"foreign prepared drafts must be rejected")
            ReviewProtocol.setWrongDraftOwner(false)
            await review.inspect(wrong,model:model)
            try require(review.drafts[wrongKey]?.accountID==first,"failed preparation can be retried with the correct owner")
            review.show(b); review.pickScope(second); review.reviewedFacts.insert(keyB)
            await review.reviewSending(b,model:model)
            try require(model.compose==nil,"unanswered decision placeholders cannot enter sending review")
            review.pickScope(first); review.show(a)
            review.reviewedFacts.insert(keyA)
            var changed=a; changed["id"] = .string("new-proposal"); changed["proposalId"] = .string("new-proposal"); changed["text"] = .string("Updated suggestion")
            review.show(changed)
            try require(review.stale.contains(keyA) && !review.reviewedFacts.contains(keyA) && review.drafts[keyA]?.body=="Edited locally. Keep this when switching accounts.","a new AI version cannot overwrite edits or retain old approval")
            review.stale.remove(keyA); review.proposals[keyA]=a; review.show(a)
            review.save(keyA,model:model)
            let deadline=Date().addingTimeInterval(5)
            while review.writing && Date()<deadline { try await Task.sleep(nanoseconds:20_000_000) }
            try require(!review.writing && review.drafts[keyA]?.savedID=="saved-"+first && review.savedPayloads[keyA]==review.drafts[keyA]?.payload,"save must use the original account")
            review.drafts[keyA]?.body="Thank you. Could you clarify the approval requested?"; review.reviewedFacts.insert(keyA)
            await review.reviewSending(a,model:model)
            try require(model.compose?.accountID==first && model.compose?.replyToID=="mail-0","send review delegates an owner-locked draft to existing explicit composer")
            model.compose=nil
            model.section="today"; review.pickScope("all")
            try await snapshot(AnyView(TodayView().environmentObject(model).tint(morrowGreen).preferredColorScheme(.light)),name:"implementation-today")
            review.pickScope(first); review.show(a); model.section="reply-suggestions"
            review.scrollPositions["reply-detail:"+keyA]=0
            try await snapshot(AnyView(ReplySuggestionsView().environmentObject(model).tint(morrowGreen).preferredColorScheme(.light)),name:"implementation-replies")
            try await snapshot(AnyView(ReplySuggestionsView().environmentObject(model).tint(morrowGreen).preferredColorScheme(.light)),name:"implementation-replies-narrow",width:720)
            model.section="today"; review.originalSelection[first]=nil
            try await snapshot(AnyView(TodayView().environmentObject(model).tint(morrowGreen).preferredColorScheme(.light)),name:"implementation-today-narrow",width:720)
            let traffic=ReviewProtocol.recordedTraffic()
            try require(!traffic.contains { $0["path"]=="/api/send" || $0["path"]=="/api/ai" },"no send or model request is allowed by the fixture")
            print("Review workspace: combined owner-bound reads, duplicate IDs, A/B/A draft/selection/scroll retention, inline original owner, load failure, dirty-budget retention, foreign-draft rejection/retry, unanswered-decision blocking, stale proposal approval reset, owned Save and explicit sending review passed. Fictional transport only; VoiceOver and Windows are not established.")
        } catch { print(error.localizedDescription); exit(1) }
    }
}
