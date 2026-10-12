import AppKit
import SwiftUI

@main struct ReviewWorkspaceAssertions {
    @MainActor static func require(_ value: Bool, _ message: String) throws { if !value { throw APIError("Review fixture: " + message) } }
    @MainActor static func waitForSave(_ review: ReviewWorkspaceState) async throws {
        let deadline = Date().addingTimeInterval(5)
        while review.writing && Date() < deadline { try await Task.sleep(nanoseconds:20_000_000) }
        try require(!review.writing, "synthetic Save did not complete")
    }
    @MainActor static func lifecycle(session: URLSession) async throws {
        let baseline = ProcessInfo.processInfo.environment["MORROW_REVIEW_BASELINE"] == "1"
        let owner = ReviewFixture.owners[0], other = ReviewFixture.owners[1]
        ReviewProtocol.resetLifecycle()
        let skipModel = AppModel(session: session); skipModel.starting=false; skipModel.state=ReviewFixture.state(owner:owner)
        let skip=skipModel.review, proposal=ReviewFixture.proposal(0,owner:owner), key=skipModel.review.key(ReviewFixture.proposal(0,owner:owner))
        skip.pickScope(owner); await skip.load(owner,model:skipModel); await skip.inspect(proposal,model:skipModel)
        try require(skip.drafts[key] != nil && !skip.hasEdits, "opening alone must create a clean prepared workspace")
        try await invokeReviewSkip(proposal,model:skipModel)
        let reinserted=skip.queue(skipModel).contains { skip.key($0)==key }
        if baseline {
            try require(reinserted && skip.stale.contains(key), "baseline full Skip handler must reproduce its stale retained row")
            try await invokeReviewSkip(proposal,model:skipModel)
            try require(skipModel.error.contains("Suggestion not found"), "baseline second Skip must reproduce its 404")
        } else {
            try require(!reinserted && skip.drafts[key]==nil && skip.proposals[key]==nil && !skip.hasEdits, "successful Skip retained its obsolete workspace")
            for _ in 0..<3 { await skip.load(owner,model:skipModel) }
            try require(!skip.queue(skipModel).contains { skip.key($0)==key } && skipModel.error.isEmpty, "polling reinserted the dismissed suggestion")
        }
        ReviewProtocol.resetLifecycle()
        let model=AppModel(session:session);model.starting=false;model.state=ReviewFixture.state(owner:owner)
        let review=model.review, old=ReviewFixture.proposal(0,owner:owner), oldKey=review.key(ReviewFixture.proposal(0,owner:owner))
        review.pickScope(owner);await review.load(owner,model:model);await review.inspect(old,model:model)
        review.drafts[oldKey]?.body="Persisted mailbox draft before retargeting."
        review.save(oldKey,model:model);try await waitForSave(review)
        let persistedID=review.drafts[oldKey]!.savedID, persisted=ReviewProtocol.persistedDraft(persistedID)
        try require(persisted?["body"].string=="Persisted mailbox draft before retargeting.","initial owned Save must persist the fixture draft")
        review.drafts[oldKey]?.body="Unsaved working text to retain on the later message."
        review.selection["all"]=oldKey;review.scrollPositions["reply-detail:"+oldKey]=180
        review.reviewedFacts.insert(oldKey);review.stale.insert(oldKey);review.errors[oldKey]="Old fixture error"
        var fresh=ReviewFixture.proposal(3,owner:owner);fresh["id"] = .string("later-proposal");fresh["proposalId"] = .string("later-proposal")
        ReviewProtocol.setProposals([fresh],owner:owner)
        await review.refreshKeepingEdits(old,fresh:fresh,model:model)
        let newKey=review.key(fresh)
        try require(newKey != oldKey && review.drafts[newKey]?.body=="Unsaved working text to retain on the later message." && review.drafts[newKey]?.savedID=="","retarget must retain working text without adopting the old persisted draft ID")
        if !baseline {
            try require(review.drafts[oldKey]==nil && review.savedPayloads[oldKey]==nil && review.proposals[oldKey]==nil && review.messages[oldKey]==nil && review.errors[oldKey]==nil && !review.stale.contains(oldKey) && !review.reviewedFacts.contains(oldKey),"retarget left obsolete workspace state")
            try require(review.selection[owner]==newKey && review.selection["all"]==newKey && review.scrollPositions["reply-detail:"+newKey]==180,"retarget left an obsolete scope selection/scroll key")
        }
        try require(review.hasEdits && model.updateHasUnsavedChanges,"unsaved moved text must still guard update/exit")
        review.save(newKey,model:model);try await waitForSave(review)
        if baseline { try require(review.hasEdits && model.updateHasUnsavedChanges && review.drafts[oldKey] != nil,"baseline retarget/save must reproduce ghost edits") }
        else { try require(!review.hasEdits && !model.updateHasUnsavedChanges,"saved retarget left ghost update/exit guards") }
        try require(ReviewProtocol.persistedDraft(persistedID)==persisted && review.drafts[newKey]?.savedID != persistedID,"retarget/save changed the old persisted mailbox draft")
        // Same-key refresh retains its saved identity; failed transfers keep
        // original working state until the full owner/source validation succeeds.
        let newSaved=review.drafts[newKey]!.savedID
        await review.refreshKeepingEdits(fresh,fresh:fresh,model:model)
        try require(review.drafts[newKey]?.savedID==newSaved,"same-key refresh erased its saved identity")
        var failed=ReviewFixture.proposal(4,owner:owner);failed["id"] = .string("failed-retarget");failed["proposalId"] = .string("failed-retarget")
        ReviewProtocol.setProposals([failed],owner:owner);ReviewProtocol.setFailure(true)
        let retained=review.drafts[newKey]!.payload
        await review.refreshKeepingEdits(fresh,fresh:failed,model:model)
        try require(review.drafts[newKey]?.payload==retained && review.drafts[review.key(failed)]==nil && review.errors[newKey] != nil,"failed retarget discarded original workspace state")
        ReviewProtocol.setFailure(false);ReviewProtocol.setProposals([fresh],owner:owner)
        // Edited Skip uses the actual production action and removes only this
        // account's local state, preserving saved mail and the colliding owner.
        let foreign=ReviewFixture.proposal(3,owner:other),foreignKey=review.key(ReviewFixture.proposal(3,owner:other))
        review.pickScope(other);ReviewProtocol.setProposals([foreign],owner:other);await review.load(other,model:model);await review.inspect(foreign,model:model)
        review.drafts[foreignKey]?.body="Other account working text."
        review.pickScope(owner);review.show(fresh);review.drafts[newKey]?.body="Discard this local suggestion edit."
        let savedNew=ReviewProtocol.persistedDraft(review.drafts[newKey]!.savedID)
        try await invokeReviewSkip(fresh,model:model)
        if !baseline { try require(review.drafts[newKey]==nil && !review.queue(model).contains { review.key($0)==newKey },"edited Skip retained its local suggestion") }
        try require(review.drafts[foreignKey]?.body=="Other account working text." && ReviewProtocol.persistedDraft(newSaved)==savedNew && ReviewProtocol.persistedDraft(persistedID)==persisted,"Skip changed another account or a persisted mailbox draft")
        try require(!ReviewProtocol.recordedTraffic().contains { $0["method"]=="DELETE" || $0["path"]=="/api/send" || $0["path"]=="/api/ai" },"lifecycle fixture deleted mail or sent/generated content")
        print(baseline ? "Baseline lifecycle: full Skip handler stale reinsertion + second 404 and retarget/save ghost update/exit guards reproduced. Persisted drafts unchanged." : "Review lifecycle: full Skip handler, polling, retarget/save, same-key and failed transfer, account isolation, update/exit guards and persisted draft retention passed.")
    }
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
            try await lifecycle(session:model.session)
            print("Review workspace: combined owner-bound reads, duplicate IDs, A/B/A draft/selection/scroll retention, inline original owner, load failure, dirty-budget retention, foreign-draft rejection/retry, unanswered-decision blocking, stale proposal approval reset, owned Save and explicit sending review passed. Fictional transport only; VoiceOver and Windows are not established.")
        } catch { print(error.localizedDescription); exit(1) }
    }
}
