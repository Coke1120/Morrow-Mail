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
    @MainActor static func settle(_ description: String, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !condition(), Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
        try require(condition(), description)
    }
    @MainActor static func nativeViews<T: NSView>(_ root: NSView, _ type: T.Type) -> [T] {
        ((root as? T).map { [$0] } ?? []) + root.subviews.flatMap { nativeViews($0, type) }
    }
    @MainActor static func accessibilityNodes(_ root: NSView) -> [NSAccessibilityProtocol] {
        var result: [NSAccessibilityProtocol] = [], visited = Set<ObjectIdentifier>()
        @MainActor func visit(_ value: Any) {
            guard let object = value as? NSObject, visited.count < 4096,
                  visited.insert(ObjectIdentifier(object)).inserted else { return }
            if let element = object as? NSAccessibilityProtocol {
                result.append(element)
                for child in element.accessibilityChildren() ?? [] { visit(child) }
            }
            if let view = object as? NSView { for child in view.subviews { visit(child) } }
        }
        visit(root)
        return result
    }
    @MainActor static func control(_ label: String, in root: NSView) -> NSAccessibilityProtocol? {
        root.layoutSubtreeIfNeeded()
        return accessibilityNodes(root).first { element in
            guard let role = element.accessibilityRole(), [NSAccessibility.Role.button, .checkBox, .popUpButton].contains(role) else { return false }
            let labels = [element.accessibilityLabel(), element.accessibilityTitle(), (element as? NSButton)?.title].compactMap { $0 }
            return labels.contains(label) && !element.isAccessibilityHidden()
                && !element.accessibilityFrame().isEmpty
                && root.window?.frame.intersects(element.accessibilityFrame()) == true
        }
    }
    @MainActor static func mountedText(_ root: NSView) -> [String] {
        accessibilityNodes(root).flatMap { element -> [String] in
            guard let role = element.accessibilityRole(), [NSAccessibility.Role.staticText, .textField, .textArea].contains(role),
                  !element.isAccessibilityHidden(), !element.accessibilityFrame().isEmpty,
                  root.window?.frame.intersects(element.accessibilityFrame()) == true else { return [] }
            return [element.accessibilityValue() as? String, element.accessibilityLabel()].compactMap { $0 }
        }
    }
    @MainActor static func pressControl(_ label: String, in root: NSView) async throws {
        try await settle("Mounted enabled control missing: " + label) { control(label, in: root)?.isAccessibilityEnabled() == true }
        guard let button = control(label, in: root) else { throw APIError("Lost mounted control: " + label) }
        try require(button.accessibilityPerformPress(), "Native accessibility action failed: " + label)
    }
    struct MenuNode {
        var role = "", identifier = ""
        var labels: [String] = []
        var parent: Int?
        var children: [Int] = []
        var completeChildren = true, mounted = true
    }
    struct MountedMenuControl {
        let element: NSAccessibilityProtocol
        // Retain the concrete owner, not the identity of a virtual segment
        // wrapper that AppKit may recreate on the next accessibility query.
        let owners: [NSObject]
        let secondarySlot: Int?
        func hasSameOwner(as other: MountedMenuControl) -> Bool {
            owners.map { ObjectIdentifier($0) } == other.owners.map { ObjectIdentifier($0) } && secondarySlot == other.secondarySlot
        }
    }
    struct MenuSnapshot {
        let elements: [NSAccessibilityProtocol]
        let nodes: [MenuNode]
        let childIndices: [[Int?]]
        let bounded: Bool
    }
    @MainActor static func menuSnapshot(_ root: NSView) -> MenuSnapshot {
        var elements: [NSAccessibilityProtocol] = [], parents: [NSObject?] = [], children: [[NSObject?]] = []
        var visited = Set<ObjectIdentifier>(), bounded = true
        @MainActor func visit(_ value: Any) {
            guard let object = value as? NSObject else { return }
            let identity = ObjectIdentifier(object)
            if visited.contains(identity) { return }
            guard visited.count < 4096 else { bounded = false; return }
            visited.insert(identity)
            if let element = object as? NSAccessibilityProtocol {
                // Capture each edge once, retaining that exact getter result
                // until the snapshot is mapped. Never combine child wrappers
                // from a second getter call with the first call's identities.
                let direct = element.accessibilityChildren() ?? []
                if direct.count > 4096 { bounded = false }
                elements.append(element)
                parents.append(element.accessibilityParent() as? NSObject)
                children.append(direct.prefix(4096).map { $0 as? NSObject })
                for child in direct.prefix(4096) { visit(child) }
            }
            if let view = object as? NSView { for child in view.subviews { visit(child) } }
        }
        visit(root)
        let indices = Dictionary(uniqueKeysWithValues: elements.enumerated().map { (ObjectIdentifier($0.element as AnyObject), $0.offset) })
        let childIndices = children.map { $0.map { $0.flatMap { indices[ObjectIdentifier($0)] } } }
        let window = root.window
        let visible = window.map { $0.convertToScreen(root.convert(root.visibleRect, to: nil)).intersection($0.frame) } ?? .zero
        let nodes = elements.enumerated().map { index, element in
            MenuNode(role: element.accessibilityRole()?.rawValue ?? "", identifier: element.accessibilityIdentifier() ?? "",
                     labels: [element.accessibilityLabel(), element.accessibilityTitle()].compactMap { $0 },
                     parent: parents[index].flatMap { indices[ObjectIdentifier($0)] },
                     children: childIndices[index].compactMap { $0 }, completeChildren: childIndices[index].allSatisfy { $0 != nil },
                     mounted: window.map { menuElementIsMounted(element, in: root, window: $0, visible: visible) } ?? false)
        }
        return MenuSnapshot(elements: elements, nodes: nodes, childIndices: childIndices, bounded: bounded && elements.count < 4096)
    }
    @MainActor static func menuNodeIndices(_ identifier: String, nodes: [MenuNode]) -> [Int] {
        let labels = ["reader.replyMenu": "Reply", "reader.organizeMenu": "Organize", "reader.moreMenu": "More", "reader.aiMenu": "AI help"]
        guard let label = labels[identifier] else { return [] }
        return nodes.indices.filter { index in
            let node = nodes[index]
            guard node.mounted, [NSAccessibility.Role.menuButton.rawValue, NSAccessibility.Role.popUpButton.rawValue].contains(node.role),
                  node.identifier.isEmpty || node.identifier == identifier else { return false }
            if identifier != "reader.replyMenu" { return node.labels.contains(label) }
            // A primary-action Menu exposes an unlabeled secondary menu segment.
            // Require its owned group and both reciprocal child links; never
            // choose the primary Reply button or an arbitrary unlabeled control.
            guard node.labels.allSatisfy({ $0.isEmpty || $0 == label }), let parent = node.parent, nodes.indices.contains(parent),
                  nodes[parent].mounted, nodes[parent].role == NSAccessibility.Role.group.rawValue,
                  nodes[parent].completeChildren, nodes[parent].children.count == 2,
                  Set(nodes[parent].children).count == 2, nodes[parent].children.contains(index),
                  let primary = nodes[parent].children.first(where: { $0 != index }), nodes.indices.contains(primary) else { return false }
            let sibling = nodes[primary]
            return sibling.mounted && sibling.parent == parent && sibling.role == NSAccessibility.Role.button.rawValue
                && sibling.labels.contains(label) && (sibling.identifier.isEmpty || sibling.identifier == identifier)
        }
    }
    @MainActor static func menuElementIsMounted(_ element: NSAccessibilityProtocol, in root: NSView, window: NSWindow, visible: NSRect) -> Bool {
        guard (element.accessibilityWindow() as? NSWindow) === window,
              !element.isAccessibilityHidden(), element.isAccessibilityEnabled(),
              !element.accessibilityFrame().isEmpty, visible.intersects(element.accessibilityFrame()) else { return false }
        var next: Any? = element
        var seen = Set<ObjectIdentifier>()
        for _ in 0..<64 {
            guard let object = next as? NSObject, seen.insert(ObjectIdentifier(object)).inserted else { return false }
            if let view = object as? NSView {
                return view.window === window && !view.isHiddenOrHasHiddenAncestor && (view === root || view.isDescendant(of: root))
            }
            guard let ancestor = object as? NSAccessibilityProtocol, !ancestor.isAccessibilityHidden() else { return false }
            next = ancestor.accessibilityParent()
        }
        return false
    }
    @MainActor static func replyMenuOwner(_ group: NSAccessibilityProtocol, secondarySlot: Int, controls: [NSSegmentedControl], in root: NSView) -> [NSObject]? {
        guard let cell = group as? NSCell else { return nil }
        let owners = controls.filter { $0.cell === cell }
        guard let window = root.window, window.isVisible, !root.isHiddenOrHasHiddenAncestor,
              owners.count == 1, let owner = owners.first, owner.segmentCount == 2, secondarySlot == 1,
              owner.label(forSegment: 0) == "Reply",
              (owner.label(forSegment: secondarySlot) ?? "").isEmpty || owner.label(forSegment: secondarySlot) == "Reply" else { return nil }
        let visible = window.convertToScreen(root.convert(root.visibleRect, to: nil)).intersection(window.frame)
        guard menuElementIsMounted(owner, in: root, window: window, visible: visible) else { return nil }
        return [owner, cell]
    }
    @MainActor static func menuControls(_ identifier: String, in root: NSView) -> [MountedMenuControl] {
        root.layoutSubtreeIfNeeded()
        guard let window = root.window, window.isVisible, !root.isHiddenOrHasHiddenAncestor else { return [] }
        let snapshot = menuSnapshot(root), elements = snapshot.elements, nodes = snapshot.nodes
        guard snapshot.bounded else { return [] }
        let candidates = menuNodeIndices(identifier, nodes: nodes)
        guard candidates.count == 1 else { return [] }
        let nativeOwners = elements.compactMap { $0 as? NSSegmentedControl }
        return candidates.compactMap { index in
            if identifier == "reader.replyMenu" {
                guard let parent = nodes[index].parent, let slot = nodes[parent].children.firstIndex(of: index),
                      let owners = replyMenuOwner(elements[parent], secondarySlot: slot, controls: nativeOwners, in: root) else { return nil }
                return MountedMenuControl(element: elements[index], owners: owners, secondarySlot: slot)
            }
            guard let owner = elements[index] as? NSObject else { return nil }
            return MountedMenuControl(element: elements[index], owners: [owner], secondarySlot: nil)
        }
    }
    enum MenuAction: Equatable { case showMenu, press }
    @MainActor static func advertisedMenuAction(_ names: [String]) -> MenuAction? {
        if names.contains("AXShowMenu") { return .showMenu }
        if names.contains("AXPress") { return .press }
        return nil
    }
    @MainActor static func accessibilityActions(_ element: NSAccessibilityProtocol) -> [String]? {
        // This public informal NSObject API reports actions without invoking
        // them. Check the selector and result type instead of assuming that the
        // modern protocol's default PerformShowMenu method is supported.
        let selector = NSSelectorFromString("accessibilityActionNames")
        guard let object = element as? NSObject, object.responds(to: selector),
              let names = object.perform(selector)?.takeUnretainedValue() as? [String], names.count <= 32 else { return nil }
        return names
    }
    @MainActor static func performAdvertisedMenuAction(_ element: NSAccessibilityProtocol) throws {
        guard let object = element as? NSObject, object.responds(to: NSSelectorFromString("accessibilityPerformAction:")) else {
            throw APIError("The owned menu control cannot perform its advertised action")
        }
        guard let action = advertisedMenuAction(accessibilityActions(element) ?? []) else {
            throw APIError("The owned menu control advertises no supported menu action")
        }
        // Pair the public informal action list with its corresponding public
        // dispatcher. Its return is Void; only real NSMenu tracking and command
        // inspection below can establish that the advertised action opened it.
        object.accessibilityPerformAction(action == .showMenu ? .showMenu : .press)
    }
    @MainActor static func menuSelectorControls() throws {
        let reply = [MenuNode(role: "AXGroup", children: [1, 2]),
                     MenuNode(role: "AXButton", labels: ["Reply"], parent: 0),
                     MenuNode(role: "AXMenuButton", labels: [""], parent: 0)]
        try require(menuNodeIndices("reader.replyMenu", nodes: reply) == [2], "split-menu selector lost its exact secondary segment")
        var titled = reply; titled[2].labels = ["", "Reply"]
        try require(menuNodeIndices("reader.replyMenu", nodes: titled) == [2], "an exact Reply secondary title was rejected")
        var checks = 2
        for mutation in 0..<11 {
            var nodes = reply
            switch mutation {
            case 0: nodes[2].parent = nil
            case 1: nodes[1].parent = nil
            case 2: nodes[0].children = [1, 1]
            case 3: nodes[0].completeChildren = false
            case 4: nodes[1].labels = ["Forward"]
            case 5: nodes[2].role = "AXButton"
            case 6: nodes[2].identifier = "other.menu"
            case 7: nodes[0].mounted = false
            case 8: nodes[1].mounted = false
            case 9: nodes[2].mounted = false
            default: nodes[2].labels = ["Other"]
            }
            try require(menuNodeIndices("reader.replyMenu", nodes: nodes).isEmpty, "split-menu selector accepted invalid graph case \(mutation)")
            checks += 1
        }
        var duplicate = reply
        duplicate += [MenuNode(role: "AXGroup", children: [4, 5]), MenuNode(role: "AXButton", labels: ["Reply"], parent: 3), MenuNode(role: "AXMenuButton", parent: 3)]
        try require(menuNodeIndices("reader.replyMenu", nodes: duplicate).count == 2, "ambiguous split menus must remain non-unique")
        let named = [MenuNode(role: "AXMenuButton", labels: ["More"])]
        try require(menuNodeIndices("reader.moreMenu", nodes: named) == [0] && menuNodeIndices("reader.organizeMenu", nodes: named).isEmpty, "named menus lost their exact label")
        try require(advertisedMenuAction([]) == nil && advertisedMenuAction(["AXConfirm"]) == nil, "an unadvertised menu action was invented")
        try require(advertisedMenuAction(["AXShowMenu"]) == .showMenu && advertisedMenuAction(["AXPress"]) == .press && advertisedMenuAction(["AXPress", "AXShowMenu"]) == .showMenu, "advertised menu action choice changed")
        print("Menu selector controls: \(checks) split graph cases plus ambiguity, named-label and advertised-action controls passed; these are synthetic graph checks, not an AppKit action pass.")
    }
    @MainActor final class MenuActionProbe: NSView {
        nonisolated let unavailableSelector: String?
        var advertised: [NSAccessibility.Action] = [.press, .showMenu]
        var performed: [NSAccessibility.Action] = []
        var modernShowMenuCalls = 0, modernPressCalls = 0
        init(unavailableSelector: String? = nil) {
            self.unavailableSelector = unavailableSelector
            super.init(frame: .zero)
        }
        required init?(coder: NSCoder) {
            unavailableSelector = nil
            super.init(coder: coder)
        }
        nonisolated override func responds(to aSelector: Selector!) -> Bool {
            if let unavailableSelector, aSelector == NSSelectorFromString(unavailableSelector) { return false }
            return super.responds(to: aSelector)
        }
        override func accessibilityActionNames() -> [NSAccessibility.Action] { advertised }
        override func accessibilityPerformAction(_ action: NSAccessibility.Action) { performed.append(action) }
        override func accessibilityPerformShowMenu() -> Bool { modernShowMenuCalls += 1; return false }
        override func accessibilityPerformPress() -> Bool { modernPressCalls += 1; return false }
    }
    @MainActor static func menuDispatchControls() throws {
        let positives: [([NSAccessibility.Action], NSAccessibility.Action)] = [([.showMenu], .showMenu), ([.press], .press), ([.press, .showMenu], .showMenu)]
        for (names, expected) in positives {
            let probe = MenuActionProbe(); probe.advertised = names
            try performAdvertisedMenuAction(probe)
            try require(probe.performed == [expected] && probe.modernShowMenuCalls == 0 && probe.modernPressCalls == 0,
                        "Advertised dispatch did not invoke exactly one matching legacy action without a modern fallback")
        }
        for mutation in 0..<5 {
            let unavailable = mutation == 0 ? "accessibilityActionNames" : mutation == 1 ? "accessibilityPerformAction:" : nil
            let probe = MenuActionProbe(unavailableSelector: unavailable)
            if mutation == 2 { probe.advertised = [] }
            if mutation == 3 { probe.advertised = [.increment] }
            if mutation == 4 { probe.advertised = Array(repeating: .showMenu, count: 33) }
            var rejected = false
            do { try performAdvertisedMenuAction(probe) } catch { rejected = true }
            try require(rejected && probe.performed.isEmpty && probe.modernShowMenuCalls == 0 && probe.modernPressCalls == 0,
                        "Missing, unadvertised or oversized action case \(mutation) invoked an action or fallback")
        }
        print("Menu dispatch controls: three exact advertised actions and five missing/unadvertised/oversized negatives passed without a modern callback; synthetic dispatch only, not native menu tracking.")
    }
    @MainActor final class MenuWrapper: NSView {
        weak var fixtureParent: NSView?
        var fixtureRole = NSAccessibility.Role.button
        var fixtureLabel = ""
        override func accessibilityRole() -> NSAccessibility.Role? { fixtureRole }
        override func accessibilityLabel() -> String? { fixtureLabel }
        override func accessibilityParent() -> Any? { fixtureParent }
        override func accessibilityChildren() -> [Any]? { [] }
    }
    @MainActor final class FreshMenuChildren: NSView {
        var reads = 0, oversized = false
        var foreignParent: NSView?
        override func accessibilityRole() -> NSAccessibility.Role? { .group }
        override func accessibilityChildren() -> [Any]? {
            reads += 1
            let primary = MenuWrapper(frame: .zero), secondary = MenuWrapper(frame: .zero)
            primary.fixtureLabel = "Reply"; primary.fixtureParent = self
            secondary.fixtureRole = .menuButton; secondary.fixtureParent = foreignParent ?? self
            return oversized ? Array(repeating: primary as Any, count: 4097) : [primary, secondary]
        }
    }
    @MainActor static func menuSnapshotControls() throws {
        let root = FreshMenuChildren(frame: .zero)
        @MainActor func graph(_ snapshot: MenuSnapshot) -> [MenuNode] {
            // This control tests the getter/edge collector only. The separate
            // mounted controls and real Reader must still prove visibility.
            snapshot.nodes.map { node in var value = node; value.mounted = true; return value }
        }
        let first = menuSnapshot(root)
        try require(root.reads == 1 && first.bounded && first.nodes.count == 3
                    && menuNodeIndices("reader.replyMenu", nodes: graph(first)) == [2], "A one-getter menu snapshot lost its reciprocal wrapper edges")
        let second = menuSnapshot(root)
        try require(root.reads == 2 && second.bounded && menuNodeIndices("reader.replyMenu", nodes: graph(second)) == [2]
                    && ObjectIdentifier(first.elements[2] as AnyObject) != ObjectIdentifier(second.elements[2] as AnyObject), "Fresh wrappers were not retained independently in each snapshot")
        let firstIDs = Set(first.elements.map { ObjectIdentifier($0 as AnyObject) })
        let reread = root.accessibilityChildren() ?? []
        try require(reread.count == 2 && reread.allSatisfy { !firstIDs.contains(ObjectIdentifier($0 as AnyObject)) }, "The former second-getter identity mismatch control did not fail closed")
        root.foreignParent = NSView(frame: .zero)
        try require(menuNodeIndices("reader.replyMenu", nodes: graph(menuSnapshot(root))).isEmpty, "A child from another parent entered the captured menu group")
        root.foreignParent = nil; root.oversized = true
        try require(!menuSnapshot(root).bounded, "An oversized repeated-child list bypassed the menu snapshot bound")
        print("Menu snapshot controls: single getter, fresh wrappers, former reread mismatch, wrong parent and bounded overflow passed; synthetic getter controls only.")
    }
    @MainActor static func menuOwnerControls() throws {
        let window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 360, height: 160), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 160))
        @MainActor func segmented() -> NSSegmentedControl {
            let control = NSSegmentedControl(frame: NSRect(x: 20, y: 30, width: 240, height: 28))
            control.segmentCount = 2; control.setLabel("Reply", forSegment: 0); control.setLabel("", forSegment: 1)
            return control
        }
        let owner = segmented(); root.addSubview(owner)
        window.contentView = root; window.makeKeyAndOrderFront(nil); window.layoutIfNeeded()
        defer { window.close(); window.contentView = nil }
        guard let cell = owner.cell, let original = replyMenuOwner(cell, secondarySlot: 1, controls: [owner], in: root) else { throw APIError("The concrete split-menu owner did not mount") }
        let target = MountedMenuControl(element: cell, owners: original, secondarySlot: 1)
        guard let same = replyMenuOwner(cell, secondarySlot: 1, controls: [owner], in: root) else { throw APIError("The retained native menu owner disappeared") }
        try require(target.hasSameOwner(as: MountedMenuControl(element: cell, owners: same, secondarySlot: 1)), "A fresh snapshot lost its unchanged concrete owner")
        try require(replyMenuOwner(cell, secondarySlot: 0, controls: [owner], in: root) == nil && replyMenuOwner(root, secondarySlot: 1, controls: [owner], in: root) == nil, "A primary slot or unrelated group became the secondary menu")
        try require(replyMenuOwner(cell, secondarySlot: 1, controls: [owner, owner], in: root) == nil, "An ambiguous native owner became current")
        owner.setLabel("Forward", forSegment: 0)
        try require(replyMenuOwner(cell, secondarySlot: 1, controls: [owner], in: root) == nil, "A differently labeled native owner became Reply")
        owner.setLabel("Reply", forSegment: 0); owner.isEnabled = false
        try require(replyMenuOwner(cell, secondarySlot: 1, controls: [owner], in: root) == nil, "A disabled native owner became current")
        owner.isEnabled = true; owner.isHidden = true
        try require(replyMenuOwner(cell, secondarySlot: 1, controls: [owner], in: root) == nil, "A hidden native owner became current")
        owner.isHidden = false; owner.removeFromSuperview()
        try require(replyMenuOwner(cell, secondarySlot: 1, controls: [owner], in: root) == nil, "A detached original owner remained current")
        let replacement = segmented(); root.addSubview(replacement); window.layoutIfNeeded()
        guard let nextCell = replacement.cell, let next = replyMenuOwner(nextCell, secondarySlot: 1, controls: [replacement], in: root) else { throw APIError("The replacement native menu owner did not mount") }
        try require(!target.hasSameOwner(as: MountedMenuControl(element: nextCell, owners: next, secondarySlot: 1)), "An identically labeled replacement reused the captured owner")
        try require(!target.hasSameOwner(as: MountedMenuControl(element: cell, owners: original, secondarySlot: 0)), "A changed segment slot reused the captured secondary identity")
        print("Menu owner controls: exact native control/cell/secondary slot retained; primary, wrong group/label, disabled, hidden, detached, replacement and changed-slot negatives passed; no menu action invoked.")
    }
    @MainActor static func menuMountedGateControls() throws {
        let window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 320, height: 180), styleMask: [.titled], backing: .buffered, defer: false)
        let foreign = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 320, height: 180), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; foreign.isReleasedWhenClosed = false
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 180))
        let root = NSView(frame: container.bounds), sibling = NSView(frame: container.bounds)
        container.addSubview(root); container.addSubview(sibling)
        let button = NSButton(title: "Fixture menu mounting gate", target: nil, action: nil)
        button.frame = NSRect(x: 20, y: 20, width: 240, height: 28); root.addSubview(button)
        window.contentView = container; window.makeKeyAndOrderFront(nil)
        foreign.contentView = NSView(frame: container.bounds)
        defer { foreign.close(); foreign.contentView = nil; window.close(); window.contentView = nil }
        window.layoutIfNeeded()
        let visible = window.convertToScreen(root.convert(root.visibleRect, to: nil)).intersection(window.frame)
        try require(menuElementIsMounted(button, in: root, window: window, visible: visible), "owned enabled mounting control was rejected")
        button.isEnabled = false
        try require(!menuElementIsMounted(button, in: root, window: window, visible: visible), "disabled mounting control was accepted")
        button.isEnabled = true; button.isHidden = true
        try require(!menuElementIsMounted(button, in: root, window: window, visible: visible), "hidden mounting control was accepted")
        button.isHidden = false; root.isHidden = true
        try require(!menuElementIsMounted(button, in: root, window: window, visible: visible), "hidden ancestor was accepted")
        root.isHidden = false; button.setFrameOrigin(NSPoint(x: 900, y: 20))
        try require(!menuElementIsMounted(button, in: root, window: window, visible: visible), "offscreen mounting control was accepted")
        button.setFrameOrigin(NSPoint(x: 20, y: 20)); sibling.addSubview(button)
        try require(!menuElementIsMounted(button, in: root, window: window, visible: visible), "a same-window foreign subtree was accepted")
        foreign.contentView?.addSubview(button); foreign.makeKeyAndOrderFront(nil)
        try require(!menuElementIsMounted(button, in: root, window: window, visible: visible), "a foreign window was accepted")
        print("Menu mounting controls: owned positive and disabled, hidden, hidden ancestor, offscreen, foreign subtree and foreign window negatives passed; no menu action invoked.")
    }
    @MainActor static func menuDiagnostics(_ identifier: String, in root: NSView) -> String {
        // Only this fictional fixture's mounted tree. Prioritize actual menu
        // nodes, include parent/child indices and advertised actions, and bound
        // every count/string. Flat traversal order does not prove ownership.
        let snapshot = menuSnapshot(root), elements = snapshot.elements
        let controls = elements.indices.filter { [NSAccessibility.Role.button, .menuButton, .popUpButton].contains(elements[$0].accessibilityRole() ?? .unknown) }
        let ordered = controls + elements.indices.filter { !controls.contains($0) }
        let nodes = ordered.prefix(32).map { index in
            let element = elements[index]
            let labels = [element.accessibilityLabel(), element.accessibilityTitle()].compactMap { $0 }.map { String($0.replacingOccurrences(of: "\n", with: " ").prefix(100)) }
            let parent = snapshot.nodes[index].parent
            let children = snapshot.childIndices[index].prefix(16).map { $0.map(String.init) ?? "outside" }
            let cellOwners = (element as? NSCell).map { cell in elements.indices.filter { (elements[$0] as? NSSegmentedControl)?.cell === cell } } ?? []
            let actions = accessibilityActions(element)?.prefix(16).map { String($0.prefix(80)) }.joined(separator: ",") ?? "unavailable"
            let segments = (element as? NSSegmentedControl).map { control in (0..<min(control.segmentCount, 16)).map { "\($0):\(String((control.label(forSegment: $0) ?? "").prefix(80)))" }.joined(separator: ",") } ?? "none"
            return "#\(index) \(type(of: element)) parent=\(parent.map(String.init) ?? "outside") children=\(children) cellOwners=\(cellOwners.prefix(16)) id=\(String((element.accessibilityIdentifier() ?? "").prefix(80))) role=\(element.accessibilityRole()?.rawValue ?? "nil") labels=\(labels) actions=\(actions) segments=\(segments) enabled=\(element.isAccessibilityEnabled()) hidden=\(element.isAccessibilityHidden()) ownWindow=\((element.accessibilityWindow() as? NSWindow) === root.window) frame=\(NSStringFromRect(element.accessibilityFrame()))"
        }
        return "Menu fixture \(identifier): bounded=\(snapshot.bounded) windowVisible=\(root.window?.isVisible == true) root=\(NSStringFromRect(root.visibleRect)); " + nodes.joined(separator: " | ")
    }
    @MainActor static func menuEntries(_ menu: NSMenu) -> String {
        menu.items.prefix(32).map { "\(String($0.title.prefix(100))) enabled=\($0.isEnabled) hidden=\($0.isHidden) action=\($0.action != nil)" }.joined(separator: " | ")
    }
    @MainActor final class MenuTracking {
        var armed = false, ended = false, inspected = false
        var begins = 0
        var menu: NSMenu?
        var failure: Error?
        var entries = ""
        var observers: [NSObjectProtocol] = []
        var cancellation: Timer?, watchdog: Timer?
        func stop() {
            armed = false
            watchdog?.invalidate(); cancellation?.invalidate()
            if let menu, !ended { menu.cancelTracking() }
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
            observers.removeAll()
        }
    }
    @MainActor static func withMountedMenu(_ identifier: String, in root: NSView, deadline: Date,
                                          inspect: @escaping @MainActor (NSMenu) throws -> Void) async throws {
        let tracking = MenuTracking()
        defer { tracking.stop() }
        do {
            while menuControls(identifier, in: root).count != 1, Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
            let controls = menuControls(identifier, in: root)
            try require(Date() < deadline && controls.count == 1, "Expected one mounted enabled menu control: " + identifier)
            let target = controls[0], control = controls[0].element
            guard let window = root.window else { throw APIError("Menu fixture lost its window") }
            @MainActor func current() -> Bool {
                let next = menuControls(identifier, in: root)
                return root.window === window && next.count == 1 && next[0].hasSameOwner(as: target)
            }
            tracking.observers.append(NotificationCenter.default.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { notification in
                MainActor.assumeIsolated {
                    guard tracking.armed, let menu = notification.object as? NSMenu, menu.supermenu == nil else { return }
                    tracking.begins += 1
                    print("Menu tracking begin: \(identifier) count=\(tracking.begins)"); fflush(stdout)
                    guard tracking.menu == nil else {
                        tracking.failure = APIError("A menu action opened more than one root menu")
                        menu.cancelTracking(); return
                    }
                    tracking.menu = menu
                    // AppKit may synchronously track inside the accessibility
                    // action. Inspect in its tracking loop, then close that menu.
                    let timer = Timer(timeInterval: 0.001, repeats: false) { _ in
                        MainActor.assumeIsolated {
                            guard tracking.armed else { return }
                            defer { menu.cancelTracking() }
                            do {
                                try require(Date() < deadline && current() && tracking.begins == 1, "The opened menu lost its captured mounted control")
                                tracking.entries = menuEntries(menu)
                                try inspect(menu)
                                tracking.inspected = true
                            } catch { tracking.failure = error }
                        }
                    }
                    tracking.cancellation = timer
                    RunLoop.main.add(timer, forMode: .eventTracking)
                    RunLoop.main.add(timer, forMode: .common)
                }
            })
            tracking.observers.append(NotificationCenter.default.addObserver(forName: NSMenu.didEndTrackingNotification, object: nil, queue: .main) { notification in
                MainActor.assumeIsolated {
                    guard tracking.armed, let menu = notification.object as? NSMenu, menu === tracking.menu else { return }
                    tracking.ended = true
                    print("Menu tracking end: \(identifier) begins=\(tracking.begins)"); fflush(stdout)
                }
            })
            let remaining = deadline.timeIntervalSinceNow
            try require(remaining > 0, "The menu deadline expired before activation")
            let watchdog = Timer(timeInterval: remaining, repeats: false) { _ in
                MainActor.assumeIsolated {
                    print(menuDiagnostics(identifier, in: root))
                    print("Review fixture: native menu exceeded its five-second deadline; begins=\(tracking.begins) ended=\(tracking.ended) entries=\(tracking.entries)")
                    tracking.stop()
                    // Terminate only this isolated fixture if a synchronous
                    // native tracking loop cannot return after cancellation.
                    fflush(stdout); exit(1)
                }
            }
            tracking.watchdog = watchdog
            RunLoop.main.add(watchdog, forMode: .eventTracking)
            RunLoop.main.add(watchdog, forMode: .common)
            tracking.armed = true
            try require(current(), "The menu lost its captured secondary control before activation")
            // AXPress is allowed only on the proven secondary/named menu node,
            // when that exact node advertises it. Never press the Reply primary
            // button and never try a second action after a failed first action.
            print("Menu action start: " + identifier); fflush(stdout)
            try performAdvertisedMenuAction(control)
            print("Menu action returned: " + identifier); fflush(stdout)
            while !tracking.ended, Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
            try require(Date() < deadline && tracking.begins == 1 && tracking.ended, "The native menu did not open and close within five seconds")
            if let failure = tracking.failure { throw failure }
            try require(tracking.inspected, "The menu closed before its native commands were inspected")
            print("Menu tracking complete: \(identifier) begins=\(tracking.begins) ended=\(tracking.ended) inspected=\(tracking.inspected)"); fflush(stdout)
        } catch {
            print(menuDiagnostics(identifier, in: root))
            print("Menu tracking: begins=\(tracking.begins) ended=\(tracking.ended) entries=\(tracking.entries)")
            throw error
        }
    }
    @MainActor static func commandIndex(_ title: String, in menu: NSMenu) -> Int? {
        menu.items.firstIndex { $0.title == title && !$0.isHidden && !$0.isSeparatorItem && $0.action != nil }
    }
    @MainActor static func menuCommand(_ title: String, identifier: String, in root: NSView, enabled: Bool = true, perform: Bool = false) async throws {
        let deadline = Date().addingTimeInterval(5)
        var matched = false
        var entries = ""
        while !matched, Date() < deadline {
            try await withMountedMenu(identifier, in: root, deadline: deadline) { menu in
                entries = menuEntries(menu)
                // SwiftUI .disabled clears the item action; title and isEnabled are the command.
                guard let index = menu.items.firstIndex(where: {
                    $0.title == title && !$0.isHidden && !$0.isSeparatorItem && ($0.action != nil || !enabled) && $0.isEnabled == enabled
                }) else { return }
                matched = true
                if perform {
                    try require(enabled, "A fixture must not invoke a disabled menu item")
                    menu.performActionForItem(at: index)
                }
            }
            if !matched { try await Task.sleep(nanoseconds: 20_000_000) }
        }
        if !matched { print(menuDiagnostics(identifier, in: root)); print("Menu command entries: " + entries) }
        try require(matched, "Mounted menu command did not reach enabled=\(enabled): " + title)
    }
    @MainActor static func mountedReader(session: URLSession) async throws {
        ReviewProtocol.resetLifecycle()
        let first = ReviewFixture.owners[0], owner = ReviewFixture.owners[1]
        let model = AppModel(session: session); model.state = ReviewFixture.state(owner: first); model.starting = false
        var message = ReviewFixture.message(0, owner: owner); message["remoteId"] = .string("imap:1:1")
        model.state["messages"] = .array([message]); model.selectedMessage = message.viewID; model.messageDetail = message
        var expanded = 0
        let window = NSWindow(contentRect: NSRect(x: 30, y: 30, width: 720, height: 760), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: MessageReader(message: message, expanded: false, focused: false, onExpand: { expanded += 1 }, onBack: {}).environmentObject(model))
        window.contentView = host; window.makeKeyAndOrderFront(nil)
        defer { window.close(); window.contentView = nil }
        for (identifier, commands) in [("reader.replyMenu", ["Reply", "Reply All", "Forward"]), ("reader.organizeMenu", ["Move to…", "Create new folder…", "Manage folders…", "Move to provider Trash"]), ("reader.moreMenu", ["Star", "Mark Pending locally", "Archive locally", "Expand Reader"]), ("reader.aiMenu", ["Summarize", "Suggest Reply", "Suggest with History", "Translate"])] {
            let prepared = ReviewProtocol.recordedTraffic().filter { $0["path"] == "/api/drafts/prepare" }.count
            try await withMountedMenu(identifier, in: host, deadline: Date().addingTimeInterval(5)) { menu in
                try require(commands.allSatisfy { commandIndex($0, in: menu) != nil }, "A grouped reader command became unreachable: " + identifier)
            }
            await Task.yield()
            try require(model.compose == nil && !model.preparingDraft && ReviewProtocol.recordedTraffic().filter { $0["path"] == "/api/drafts/prepare" }.count == prepared, "Opening a menu invoked the primary Reply action")
        }
        try await menuCommand("Expand Reader", identifier: "reader.moreMenu", in: host, perform: true)
        try require(expanded == 1, "More did not call the existing reader layout action")
        try await menuCommand("Move to…", identifier: "reader.organizeMenu", in: host, perform: true)
        try require(model.organizing?["message"] == message && model.organizing?["message"]["accountId"].string == owner, "Organize lost the message owner")
        model.organizing = nil
        for (title, mode) in [("Reply", "reply"), ("Reply All", "replyAll"), ("Forward", "forward")] {
            try await menuCommand(title, identifier: "reader.replyMenu", in: host, perform: true)
            try await settle("Grouped reply action did not prepare a draft: " + title) { model.compose != nil }
            try require(model.compose?.accountID == owner && model.account == first, "Grouped reply switched the sending identity")
            try require(ReviewProtocol.recordedTraffic().last(where: { $0["path"] == "/api/drafts/prepare" })?["mode"] == mode, "Grouped reply changed its preparation mode")
            model.compose = nil
        }
        try await menuCommand("Suggest with History", identifier: "reader.aiMenu", in: host)
        model.state["settings"]["policy"]["content"]["sender"] = .bool(false)
        try await menuCommand("Suggest with History", identifier: "reader.aiMenu", in: host, enabled: false)
        try await menuCommand("Suggest Reply", identifier: "reader.aiMenu", in: host)
        model.messageDetail = .null
        try await menuCommand("Suggest Reply", identifier: "reader.aiMenu", in: host, enabled: false)
        try require(!ReviewProtocol.recordedTraffic().contains { $0["path"] == "/api/send" || $0["path"] == "/api/ai" || $0["path"]?.contains("/organize") == true }, "Opening grouped controls issued a send, AI or provider write")
        print("Mounted reader menus retain every command, invoke layout/owned organization and reply variants, and disable forbidden history/stale AI.")
    }
    @MainActor static func mountedToday(session: URLSession, width: CGFloat) async throws {
        ReviewProtocol.resetLifecycle()
        let first = ReviewFixture.owners[0], second = ReviewFixture.owners[1]
        let model = AppModel(session: session); model.state = ReviewFixture.state(owner: first); model.starting = false; model.section = "today"
        let review = model.review
        review.pickScope(first); await review.load(first, model: model)
        let window = NSWindow(contentRect: NSRect(x: 30, y: 30, width: width, height: 780), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: TodayView().environmentObject(model)); window.contentView = host; window.makeKeyAndOrderFront(nil)
        defer { window.close(); window.contentView = nil }
        try await pressControl("Review replies (3)", in: host)
        let key = review.key(ReviewFixture.proposal(0, owner: first))
        try await settle("Today did not mount its original-owner editor") {
            model.section == "today" && review.drafts[key]?.accountID == first
                && mountedText(host).contains("From: " + first)
                && nativeViews(host, NSTextView.self).contains { $0.isEditable && $0.string == review.drafts[key]?.body && $0.window === window }
        }
        try require(control("Review sending…", in: host)?.isAccessibilityEnabled() == false, "Unreviewed suggestion could enter sending review")
        review.drafts[key]?.body = "Retained first-mailbox edit."
        try await pressControl(second + ", not selected", in: host)
        try await settle("Changing scope did not close the old Today editor") { review.scope == second && control("Back to Today", in: host) == nil }
        try require(review.drafts[key]?.body == "Retained first-mailbox edit." && model.account == first && model.section == "today", "Scope change discarded edits or navigated the mailbox")
        try await pressControl("Review replies (3)", in: host)
        let otherKey = review.key(ReviewFixture.proposal(0, owner: second))
        try await settle("Colliding message did not mount its second-owner editor") {
            review.drafts[otherKey]?.accountID == second && mountedText(host).contains("From: " + second)
                && !mountedText(host).contains("From: " + first)
                && nativeViews(host, NSTextView.self).contains { $0.isEditable && $0.string == review.drafts[otherKey]?.body && $0.window === window }
        }
        review.drafts[otherKey]?.body = "Reviewed second-mailbox reply."
        try await settle("Unchecked facts did not block a completed reply") { control("Review sending…", in: host)?.isAccessibilityEnabled() == false }
        review.reviewedFacts.insert(otherKey)
        try await settle("Reviewed reply did not enable sending review") { control("Review sending…", in: host)?.isAccessibilityEnabled() == true }
        review.stale.insert(otherKey)
        try await settle("Stale Today editor did not disable sending review") { control("Review sending…", in: host)?.isAccessibilityEnabled() == false }
        review.stale.remove(otherKey)
        try await pressControl("Review sending…", in: host)
        try await settle("Today did not open the existing owned send review") { model.compose?.accountID == second }
        try require(model.compose?.replyToID == "mail-0" && model.account == first && model.section == "today", "Today changed source identity while opening the composer")
        model.compose = nil
        try await pressControl("Back to Today", in: host)
        try await pressControl(first + ", not selected", in: host)
        try await pressControl("Review replies (3)", in: host)
        try await settle("Returning to Today discarded the first draft") { nativeViews(host, NSTextView.self).contains { $0.isEditable && $0.string == "Retained first-mailbox edit." && $0.window === window } }
        review.writing = true
        try await settle("An in-flight review write did not disable scope changes") { control(second + ", not selected", in: host)?.isAccessibilityEnabled() == false }
        review.writing = false
        try require(!ReviewProtocol.recordedTraffic().contains { $0["path"] == "/api/send" || $0["path"] == "/api/ai" }, "Today review sent or generated content")
        print("Mounted Today at \(Int(width))pt: real Review/scope/back/send-review controls, duplicate-ID owner isolation, retained draft, stale/unreviewed/write gates; no send/model request.")
    }
    @MainActor static func mountedTodayExactSelection(session: URLSession, cachedFirst: Bool) async throws {
        ReviewProtocol.resetLifecycle()
        let owner = ReviewFixture.owners[0]
        let model = AppModel(session: session); model.state = ReviewFixture.state(owner: owner); model.starting = false; model.section = "today"
        let review = model.review, previous = ReviewFixture.proposal(0, owner: owner), clicked = ReviewFixture.proposal(2, owner: owner)
        let previousKey = review.key(previous), clickedKey = review.key(clicked)
        review.pickScope(owner)
        ReviewProtocol.setProposals(cachedFirst ? [previous] : [], owner: owner)
        await review.load(owner, model: model)
        // The saved queue deliberately predates Today. Do not load it again
        // before pressing the actual card: that would hide the original fault.
        model.state["today"]["replySuggestions"] = .array([clicked])
        model.state["today"]["replySuggestionCounts"] = .object([owner: .number(1)])
        model.state["today"]["events"] = .array([])
        ReviewProtocol.setProposals([clicked], owner: owner)
        try require(review.drafts[clickedKey] == nil && (cachedFirst ? review.selected(model).map(review.key) == previousKey : review.selected(model) == nil), "Exact-selection negative control lost its stale queue precondition")
        let window = NSWindow(contentRect: NSRect(x: 30, y: 30, width: 1120, height: 900), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: TodayView().environmentObject(model)); window.contentView = host; window.makeKeyAndOrderFront(nil)
        defer { window.close(); window.contentView = nil }
        try await pressControl("Review suggested reply: " + clicked["message"]["subject"].string, in: host)
        try await settle("Today did not mount the exact clicked suggestion after a stale queue") {
            review.drafts[clickedKey]?.accountID == owner && review.drafts[clickedKey]?.replyToID == clicked["messageId"].string
                && mountedText(host).contains("From: " + owner)
                && mountedText(host).contains(clicked["message"]["subject"].string)
                && nativeViews(host, NSTextView.self).contains { $0.isEditable && $0.string == clicked["text"].string && $0.window === window }
        }
        // An eventual correction to B must not hide an earlier inspection of A.
        try require(!ReviewProtocol.recordedTraffic().contains { $0["path"] == "/api/messages/" + previous["messageId"].string }, "Clicking B inspected cached A before showing B")
        review.selection[owner] = previousKey; review.proposals[previousKey] = previous
        try await Task.sleep(nanoseconds: 40_000_000)
        try require(nativeViews(host, NSTextView.self).contains { $0.isEditable && $0.string == clicked["text"].string && $0.window === window }, "Unrelated same-owner queue selection replaced the clicked Today editor")
        try await pressControl("Skip suggestion", in: host)
        try await settle("Successful Today Skip did not close the exact editor") {
            review.drafts[clickedKey] == nil && review.proposals[clickedKey] == nil && control("Back to Today", in: host) == nil && !review.writing
        }
        try require(review.drafts[previousKey] == nil && !ReviewProtocol.recordedTraffic().contains { $0["path"] == "/api/messages/" + previous["messageId"].string }, "Skip fell back to a different cached suggestion")
        try require(model.section == "today" && !ReviewProtocol.recordedTraffic().contains { $0["path"] == "/api/send" || $0["path"] == "/api/ai" }, "Exact Today selection navigated, sent or generated content")
        print("Mounted Today exact card: cached \(cachedFirst ? "A" : "empty") → B, no A inspection, unrelated selection ignored and successful Skip closes without fallback.")
    }
    @MainActor static func mountedTodayUpdatedSelection(session: URLSession) async throws {
        ReviewProtocol.resetLifecycle()
        let owner = ReviewFixture.owners[0]
        let model = AppModel(session: session); model.state = ReviewFixture.state(owner: owner); model.starting = false; model.section = "today"
        let review = model.review
        var initial = ReviewFixture.proposal(2, owner: owner); initial["conversationKey"] = .string("fixture-thread")
        let oldKey = review.key(initial)
        model.state["today"]["replySuggestions"] = .array([initial]); model.state["today"]["events"] = .array([])
        model.state["today"]["replySuggestionCounts"] = .object([owner: .number(1)])
        review.pickScope(owner); ReviewProtocol.setProposals([initial], owner: owner); await review.load(owner, model: model)
        let window = NSWindow(contentRect: NSRect(x: 30, y: 30, width: 1120, height: 900), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: TodayView().environmentObject(model)); window.contentView = host; window.makeKeyAndOrderFront(nil)
        defer { window.close(); window.contentView = nil }
        try await pressControl("Review suggested reply: " + initial["message"]["subject"].string, in: host)
        try await settle("Updated-selection control did not open its initial editor") { review.drafts[oldKey] != nil && !review.preparing.contains(oldKey) }
        var same = initial; same["id"] = .string("same-source-update"); same["proposalId"] = same["id"]; same["text"] = .string("Updated suggestion for this same original.")
        ReviewProtocol.setProposals([same], owner: owner); await review.load(owner, model: model)
        try require(review.stale.contains(oldKey) && review.savedPayloads[oldKey] == review.drafts[oldKey]?.payload, "Same-key replacement control must start with a clean stale draft")
        try await pressControl("Review updated suggestion…", in: host)
        try await settle("Same-key evidence replacement closed or left the old Today editor") {
            review.proposals[oldKey] == same && !review.stale.contains(oldKey)
                && control("Back to Today", in: host) != nil
                && nativeViews(host, NSTextView.self).contains { $0.isEditable && $0.string == same["text"].string && $0.window === window }
        }
        let retained = "Local edits retained while the conversation moves to a later message."
        review.drafts[oldKey]?.body = retained
        var later = ReviewFixture.proposal(3, owner: owner); later["conversationKey"] = initial["conversationKey"]
        let laterKey = review.key(later)
        ReviewProtocol.setProposals([later], owner: owner); await review.load(owner, model: model)
        try await pressControl("Keep edits and refresh evidence", in: host)
        try await settle("Different-key refresh did not retain Today presentation and edits") {
            review.drafts[oldKey] == nil && review.proposals[oldKey] == nil && review.messages[oldKey] == nil
                && review.drafts[laterKey]?.body == retained && review.drafts[laterKey]?.replyToID == later["messageId"].string
                && review.proposals[laterKey] == later && !review.preparing.contains(laterKey)
                && control("Back to Today", in: host) != nil
                && mountedText(host).contains(later["message"]["subject"].string)
                && nativeViews(host, NSTextView.self).contains { $0.isEditable && $0.string == retained && $0.window === window }
        }
        try require(!review.reviewedFacts.contains(laterKey) && review.hasEdits, "Retarget accepted old facts approval or lost the unsaved-edit guard")
        try await pressControl("Back to Today", in: host)
        try require(review.drafts[laterKey]?.body == retained && model.section == "today", "Closing the retargeted Today editor discarded its draft")
        try require(!ReviewProtocol.recordedTraffic().contains { $0["path"] == "/api/send" || $0["path"] == "/api/ai" }, "Updating the Today editor sent or generated content")
        print("Mounted Today updates: exact same-key replacement and atomic different-key keep-edits retarget remain visible; facts reset, edits and Back retention preserved.")
    }
    @MainActor static func mountedSelection(session: URLSession) async throws {
        let model = AppModel(session: session), owner = ReviewFixture.owners[0]
        model.state = ReviewFixture.state(owner: owner); model.starting = false
        let rows = (0..<2).map { index -> JSON in
            var row = ReviewFixture.message(index, owner: owner)
            row["remoteId"] = .string("imap:1:\(index + 1)")
            return row
        }
        model.searchResponse = .object(["messages": .array(rows), "total": .number(2), "page": .number(0)])
        let defaults = UserDefaults.standard, priorLayout = defaults.object(forKey: "mailReaderLayout"), priorSidebar = defaults.object(forKey: "mailSidebarVisible")
        defaults.set("right", forKey: "mailReaderLayout"); defaults.set(true, forKey: "mailSidebarVisible")
        defer {
            if let priorLayout { defaults.set(priorLayout, forKey: "mailReaderLayout") } else { defaults.removeObject(forKey: "mailReaderLayout") }
            if let priorSidebar { defaults.set(priorSidebar, forKey: "mailSidebarVisible") } else { defaults.removeObject(forKey: "mailSidebarVisible") }
        }
        let window = NSWindow(contentRect: NSRect(x: 30, y: 30, width: 1220, height: 780), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: MailWorkspace().environmentObject(model)); window.contentView = host; window.makeKeyAndOrderFront(nil)
        defer { window.close(); window.contentView = nil }
        try await settle("Production mail table did not mount") { nativeViews(host, NSTableView.self).contains { $0.numberOfRows == 2 } }
        try require(control("Delete (1)", in: host) == nil && control("Delete (2)", in: host) == nil, "Empty selection exposed a delete command")
        for count in [1, 2] {
            model.selectMailMessages(Set(rows.prefix(count).map(\.viewID)))
            try await settle("Selected mail did not expose its owned delete command") { control("Delete (\(count))", in: host)?.isAccessibilityEnabled() == true }
            try require(model.selectedMailRows.count == count, "Selection action count is not the actual selection")
        }
        model.busy = true
        try await settle("Busy selection left Delete enabled") { control("Delete (2)", in: host)?.isAccessibilityEnabled() == false }
        model.busy = false; model.selectMailMessages([])
        try await settle("Clearing selection left Delete visible") { control("Delete (2)", in: host) == nil }
        try require(model.trashUndos.isEmpty, "Presentation check performed a Trash operation")
        print("Mounted mail list exposes Delete only for single/multiple selections and disables it while busy; no Trash command executed.")
    }
    @MainActor static func mountedCompose(session: URLSession) async throws {
        ReviewProtocol.resetLifecycle()
        let model = AppModel(session: session), owner = ReviewFixture.owners[0]
        model.state = ReviewFixture.state(owner: owner); model.starting = false
        for populated in [false, true] {
            var draft = Draft(); draft.accountID = owner; draft.to = "recipient@example.invalid"; draft.body = "Synthetic reviewed content."
            if populated { draft.cc = "copy@example.invalid"; draft.bcc = "hidden@example.invalid" }
            let window = NSWindow(contentRect: NSRect(x: 30, y: 30, width: 740, height: 820), styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            let host = NSHostingView(rootView: ComposeView(initial: draft).environmentObject(model)); window.contentView = host; window.makeKeyAndOrderFront(nil)
            defer { window.close(); window.contentView = nil }
            try await settle("Composer recipients did not mount") { !nativeViews(host, NSTextField.self).isEmpty }
            if !populated {
                try require(!nativeViews(host, NSTextField.self).contains { ["Copy recipients", "Hidden recipients"].contains($0.placeholderString ?? "") }, "Empty optional recipients were not collapsed")
                try await pressControl("Add Cc or Bcc", in: host)
            }
            try await settle("Optional recipients are not reachable or populated recipients were hidden") {
                let fields = nativeViews(host, NSTextField.self)
                return fields.contains { $0.placeholderString == "Copy recipients" && (!populated || $0.stringValue == draft.cc) }
                    && fields.contains { $0.placeholderString == "Hidden recipients" && (!populated || $0.stringValue == draft.bcc) }
            }
            try await pressControl("Review & Send", in: host)
            try await settle("Review & Send bypassed or failed to open confirmation") {
                window.sheets.contains { sheet in sheet.contentView.map { nativeViews($0, NSButton.self).contains { $0.title == "Send Message" } } == true }
            }
            guard let sheet = window.sheets.first(where: { $0.contentView.map { nativeViews($0, NSButton.self).contains { $0.title == "Send Message" } } == true }),
                  let content = sheet.contentView,
                  let cancel = nativeViews(content, NSButton.self).first(where: { $0.title == "Cancel" }) else { throw APIError("Sending confirmation has no mounted Cancel action") }
            try require(cancel.window === sheet && cancel.isEnabled, "Confirmation Cancel is not usable")
            try require(mountedText(content).contains { $0.contains("From: " + owner) && $0.contains("Cc: " + draft.cc) && $0.contains("Bcc: " + draft.bcc) }, "Confirmation lost the reviewed sender or optional recipients")
            cancel.performClick(nil)
            try await settle("Confirmation did not cancel") { window.sheets.isEmpty }
            try require(!ReviewProtocol.recordedTraffic().contains { $0["path"] == "/api/send" }, "Opening or cancelling confirmation sent mail")
        }
        print("Mounted composer reveals empty Cc/Bcc on request, retains populated recipients and opens/cancels the existing send confirmation without sending.")
    }
    // Menu tracking stops whichever run loop is current. Async main's loop is that
    // loop unless NSApp.run owns it, so tracking end exits 0 before the receipt.
    @MainActor static func main() {
        final class Delegate: NSObject, NSApplicationDelegate {
            func applicationDidFinishLaunching(_ notification: Notification) {
                Task { @MainActor in await ReviewWorkspaceAssertions.runSuite() }
            }
            func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
        }
        let delegate = Delegate()
        let app = NSApplication.shared
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.activate(ignoringOtherApps: true)
        app.run()
    }
    @MainActor static func runSuite() async {
        let config=URLSessionConfiguration.ephemeral; config.protocolClasses=[ReviewProtocol.self]
        let model=AppModel(session:URLSession(configuration:config))
        model.starting=false; model.state=ReviewFixture.state(owner:ReviewFixture.owners[0]); model.section="today"
        let completionNonce = ProcessInfo.processInfo.environment["MORROW_REVIEW_COMPLETION_NONCE"] ?? ""
        do {
            try require(!completionNonce.isEmpty, "Missing review fixture completion nonce")
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
            if ProcessInfo.processInfo.environment["MORROW_REVIEW_BASELINE"] != "1" {
                try menuSelectorControls()
                try menuDispatchControls()
                try menuSnapshotControls()
                try menuOwnerControls()
                try menuMountedGateControls()
                try await mountedReader(session: model.session)
                try await mountedToday(session: model.session, width: 1120)
                try await mountedToday(session: model.session, width: 720)
                try await mountedTodayExactSelection(session: model.session, cachedFirst: false)
                try await mountedTodayExactSelection(session: model.session, cachedFirst: true)
                try await mountedTodayUpdatedSelection(session: model.session)
                try await mountedSelection(session: model.session)
                try await mountedCompose(session: model.session)
            }
            print("Review workspace: combined owner-bound reads, duplicate IDs, A/B/A draft/selection/scroll retention, inline original owner, load failure, dirty-budget retention, foreign-draft rejection/retry, unanswered-decision blocking, stale proposal approval reset, owned Save and explicit sending review passed. Fictional transport only; VoiceOver and Windows are not established.")
            let completionMode = ProcessInfo.processInfo.environment["MORROW_REVIEW_BASELINE"] == "1" ? "baseline" : "production"
            print("MORROW_REVIEW_COMPLETE \(completionMode) \(completionNonce)"); fflush(stdout)
            model.session.invalidateAndCancel()
            exit(0) // NSApp.run does not return.
        } catch { print(error.localizedDescription); fflush(stdout); exit(1) }
    }
}
