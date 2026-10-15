import AppKit
import SwiftUI

// Branch-only probe. The driver removes only @main from its private copy of
// MailboxLatency.swift; its transport, original oracle and ten-second wait stay
// byte-identical. Nothing in this file can satisfy the measurement predicate.
@main struct IsolatedRowProjection {
#if MORROW_PROBE_APPKIT
    static let mode = "appkit"
    @MainActor static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.regular)
        let checks: Task<Void, Never> = Task { @MainActor in
            await run()
            fflush(stdout); exit(0)
        }
        withExtendedLifetime(checks) { application.run() }
        print("Isolated row: AppKit event loop returned before completion")
        fflush(stdout); exit(1)
    }
#else
    static let mode = "async"
    @MainActor static func main() async { await run() }
#endif

    @MainActor static func emit(_ phase: String, _ fields: [String: JSON] = [:]) throws {
        var payload = fields
        payload["phase"] = .string(phase); payload["mode"] = .string(mode)
        try ProbeEvidence.emit("row", .object(payload))
    }
    static func count(_ value: Int) -> JSON { .number(Double(max(0, min(value, 1_000_000)))) }
    static func rect(_ frame: NSRect?) -> JSON {
        guard let frame else { return JSON.null }
        let components: [CGFloat] = [frame.minX, frame.minY, frame.width, frame.height]
        guard components.allSatisfy({ $0.isFinite && abs($0) <= 10_000_000 }) else { return JSON.null }
        var encoded: [JSON] = []
        for component in components { encoded.append(JSON.number(Double(component))) }
        return JSON.array(encoded)
    }
    static func roleName(_ value: String?) -> String {
        let names: [(NSAccessibility.Role, String)] = [(.row, "row"), (.table, "table"), (.list, "list"),
            (.outline, "outline"), (.cell, "cell"), (.group, "group"), (.scrollArea, "scrollArea"),
            (.window, "window"), (.staticText, "staticText"), (.textField, "textField"), (.textArea, "textArea")]
        return names.first { $0.0.rawValue == value }?.1 ?? (value == nil ? "none" : "other")
    }
    static func finiteFrame(_ frame: NSRect) -> NSRect? {
        [frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite) && !frame.isEmpty ? frame : nil
    }

    enum Family: String { case method, attributes }
    struct ArrayRead {
        var supported = false, present = false, truncated = false
        var count = 0, invalid = 0
        var objects: [NSObject] = []
        var json: JSON {
            var fields: [String: JSON] = [:]
            fields["supported"] = .bool(supported)
            fields["present"] = .bool(present)
            fields["count"] = IsolatedRowProjection.count(count)
            fields["invalid"] = IsolatedRowProjection.count(invalid)
            fields["truncated"] = .bool(truncated)
            return JSON.object(fields)
        }
    }
    struct Node {
        let object: NSObject
        var supported = false, conforms = false
        var role: String?, frame: NSRect?, index: Int?, window: NSObject?, parent: NSObject?, hidden: Bool?
        var children = ArrayRead()
        var attributes: [NSAccessibility.Attribute] = []
    }
    // One retained snapshot per getter/object/family. Never mix key-based and
    // method-based parent, window, frame, role or child edges into one graph.
    @MainActor final class AXReadout {
        let family: Family
        var cache: [ObjectIdentifier: Node] = [:]
        var textCache: [ObjectIdentifier: [String]] = [:]
        var bounded = true
        init(_ family: Family) { self.family = family }
        func array(_ value: Any?, supported: Bool) -> ArrayRead {
            var result = ArrayRead(); result.supported = supported
            guard let values = value as? [Any] else { return result }
            result.present = true; result.count = values.count; result.truncated = values.count > 64
            for value in values.prefix(64) {
                if let object = value as? NSObject { result.objects.append(object) } else { result.invalid += 1 }
            }
            return result
        }
        func attribute(_ object: NSObject, _ names: [NSAccessibility.Attribute], _ key: String) -> Any? {
            let name = NSAccessibility.Attribute(rawValue: key)
            guard names.contains(name) else { return nil }
            return object.accessibilityAttributeValue(name)
        }
        func node(_ object: NSObject) -> Node? {
            let identity = ObjectIdentifier(object)
            if let node = cache[identity] { return node }
            guard cache.count < 512 else { bounded = false; return nil }
            var result = Node(object: object)
            result.conforms = object is NSAccessibilityProtocol
            switch family {
            case .method:
                if let element = object as? NSAccessibilityProtocol {
                    result.supported = true
                    result.role = element.accessibilityRole()?.rawValue
                    result.frame = IsolatedRowProjection.finiteFrame(element.accessibilityFrame())
                    result.index = element.accessibilityIndex()
                    result.window = element.accessibilityWindow() as? NSObject
                    result.parent = element.accessibilityParent() as? NSObject
                    result.hidden = element.isAccessibilityHidden()
                    result.children = array(element.accessibilityChildren(), supported: true)
                }
            case .attributes:
                if object.responds(to: NSSelectorFromString("accessibilityAttributeNames")),
                   object.responds(to: NSSelectorFromString("accessibilityAttributeValue:")) {
                    let names = (object.accessibilityAttributeNames() as Any) as? [NSAccessibility.Attribute] ?? []
                    if names.count <= 128 {
                        result.supported = true; result.attributes = names
                        let role = attribute(object, names, "AXRole")
                        result.role = (role as? NSAccessibility.Role)?.rawValue ?? (role as? String)
                        if let point = attribute(object, names, "AXPosition") as? NSValue,
                           let size = attribute(object, names, "AXSize") as? NSValue {
                            result.frame = IsolatedRowProjection.finiteFrame(NSRect(origin: point.pointValue, size: size.sizeValue))
                        }
                        result.index = (attribute(object, names, "AXIndex") as? NSNumber)?.intValue
                        result.window = attribute(object, names, "AXWindow") as? NSObject
                        result.parent = attribute(object, names, "AXParent") as? NSObject
                        // Unknown hidden state stays unknown. A legacy row or
                        // label is never promoted to accepted evidence here.
                        result.hidden = (attribute(object, names, "AXHidden") as? NSNumber)?.boolValue
                        result.children = array(attribute(object, names, "AXChildren"),
                            supported: names.contains(NSAccessibility.Attribute(rawValue: "AXChildren")))
                    } else { bounded = false }
                }
            }
            cache[identity] = result
            return result
        }
        func rows(_ object: NSObject, visible: Bool) -> ArrayRead {
            guard let node = node(object) else { return ArrayRead() }
            switch family {
            case .method:
                guard let element = object as? NSAccessibilityProtocol else { return ArrayRead() }
                return array(visible ? element.accessibilityVisibleRows() : element.accessibilityRows(), supported: true)
            case .attributes:
                let key = visible ? "AXVisibleRows" : "AXRows"
                return array(attribute(object, node.attributes, key),
                    supported: node.attributes.contains(NSAccessibility.Attribute(rawValue: key)))
            }
        }
        func text(_ node: Node) -> [String] {
            let identity = ObjectIdentifier(node.object)
            if let text = textCache[identity] { return text }
            let values: [String]
            switch family {
            case .method:
                guard let element = node.object as? NSAccessibilityProtocol else { return [] }
                let rawValues: [String?] = [element.accessibilityValue() as? String, element.accessibilityLabel(), element.accessibilityTitle()]
                var resolved: [String] = []
                for value in rawValues { resolved.append(value ?? "") }
                values = resolved
            case .attributes:
                let keys: [String] = ["AXValue", "AXDescription", "AXTitle"]
                var resolved: [String] = []
                for key in keys {
                    let value: Any? = attribute(node.object, node.attributes, key)
                    let text: String = value as? String ?? ""
                    resolved.append(text)
                }
                values = resolved
            }
            textCache[identity] = values
            return values
        }
    }

    struct NativeBoundary {
        let host: NSView, window: NSWindow
        let table: NSTableView?, column: NSView?, row: NSTableRowView?, clip: NSRect?
    }
    struct ParentPath {
        var table = false, host = false, row = false, cycle = false, truncated = false
        var hops = 0, hidden = 0, unknownHidden = 0, foreignWindow = 0, invisibleNative = 0
        var json: JSON {
            var fields: [String: JSON] = [:]
            fields["table"] = .bool(table)
            fields["host"] = .bool(host)
            fields["row"] = .bool(row)
            fields["hops"] = IsolatedRowProjection.count(hops)
            fields["cycle"] = .bool(cycle)
            fields["truncated"] = .bool(truncated)
            fields["hidden"] = IsolatedRowProjection.count(hidden)
            fields["unknownHidden"] = IsolatedRowProjection.count(unknownHidden)
            fields["foreignWindow"] = IsolatedRowProjection.count(foreignWindow)
            fields["invisibleNative"] = IsolatedRowProjection.count(invisibleNative)
            return JSON.object(fields)
        }
    }
    @MainActor static func parentPath(_ object: NSObject, readout: AXReadout, boundary: NativeBoundary, row: NSObject? = nil) -> ParentPath {
        var result = ParentPath(), next: NSObject? = object, seen = Set<ObjectIdentifier>()
        for _ in 0..<32 {
            guard let current = next else { return result }
            guard seen.insert(ObjectIdentifier(current)).inserted else { result.cycle = true; return result }
            result.hops += 1
            result.table = result.table || current === boundary.table
            result.host = result.host || current === boundary.host
            result.row = result.row || (row != nil && current === row)
            if let view = current as? NSView {
                if view.window !== boundary.window { result.foreignWindow += 1 }
                if MailboxLatency.visibleFrame(view) == nil { result.invisibleNative += 1 }
            }
            guard let node = readout.node(current) else { result.truncated = true; return result }
            if let hidden = node.hidden { if hidden { result.hidden += 1 } } else { result.unknownHidden += 1 }
            if let window = node.window, window !== boundary.window { result.foreignWindow += 1 }
            if result.table { return result }
            next = node.parent
        }
        result.truncated = next != nil
        return result
    }
    static func matches(_ values: [String]) -> JSON {
        let subject = "Fictional mailbox row 0 中文", owner = MailboxLatencyProtocol.owners[0]
        let subjectExact: Bool = values.contains(subject)
        let subjectContained: Bool = values.contains { $0.contains(subject) }
        let ownerExact: Bool = values.contains(owner) || values.contains("Mailbox: " + owner)
        let ownerContained: Bool = values.contains { $0.contains(owner) }
        var result: [JSON] = []
        result.append(JSON.bool(subjectExact))
        result.append(JSON.bool(subjectContained))
        result.append(JSON.bool(ownerExact))
        result.append(JSON.bool(ownerContained))
        return JSON.array(result)
    }
    @MainActor static func nodeDiagnostic(_ node: Node, path: ParentPath, stage: String, readout: AXReadout,
        boundary: NativeBoundary, row: NSObject, nativeRow: NSView, clip: NSRect) -> JSON {
        let view: NSView? = node.object as? NSView
        let cell: NSCell? = node.object as? NSCell
        let control: NSView? = cell?.controlView
        let owner: NSView? = view ?? control
        let ownerWindow: Bool = owner?.window === boundary.window
        let ownerDescendant: Bool = owner.map { $0 === nativeRow || $0.isDescendant(of: nativeRow) } ?? false
        let ownerVisible: Bool = owner.map { MailboxLatency.visibleFrame($0) != nil } ?? false
        let cellFrame: Bool = cell.map { MailboxLatency.visibleCellFrame($0, in: nativeRow, window: boundary.window, clip: clip) != nil } ?? false
        let inClip: Bool = node.frame.map { !$0.intersection(clip).isEmpty } ?? false
        var reasons: [String: JSON] = [:]
        reasons["missingWindow"] = .bool(node.window == nil)
        reasons["foreignWindow"] = .bool(node.window != nil && node.window !== boundary.window)
        reasons["missingRowParent"] = .bool(!path.row)
        reasons["missingTableParent"] = .bool(!path.table)
        reasons["parentCycle"] = .bool(path.cycle)
        reasons["parentTruncated"] = .bool(path.truncated)
        reasons["hiddenAncestor"] = .bool(path.hidden > 0)
        reasons["foreignAncestorWindow"] = .bool(path.foreignWindow > 0)
        reasons["invisibleNativeAncestor"] = .bool(path.invisibleNative > 0)
        reasons["missingFrame"] = .bool(node.frame == nil)
        reasons["outsideClip"] = .bool(node.frame != nil && !inClip)
        reasons["nativeViewOwner"] = .bool(view != nil && !(ownerWindow && ownerDescendant && ownerVisible))
        reasons["nativeCellOwner"] = .bool(cell != nil && !cellFrame)
        var fields: [String: JSON] = [:]
        fields["stage"] = .string(stage)
        fields["role"] = .string(roleName(node.role))
        fields["frame"] = rect(node.frame)
        fields["inClip"] = .bool(inClip)
        fields["windowKnown"] = .bool(node.window != nil)
        fields["windowSame"] = .bool(node.window === boundary.window)
        fields["windowAdvertised"] = .bool(readout.family == .method ? node.conforms : node.attributes.contains(NSAccessibility.Attribute(rawValue: "AXWindow")))
        fields["parentKnown"] = .bool(node.parent != nil)
        fields["parentSameRow"] = .bool(node.parent === row)
        fields["parentSameTable"] = .bool(node.parent === boundary.table)
        fields["parent"] = path.json
        fields["reasons"] = .object(reasons)
        fields["nativeView"] = .bool(view != nil)
        fields["nativeCell"] = .bool(cell != nil)
        fields["controlViewKnown"] = .bool(control != nil)
        fields["ownerWindow"] = .bool(ownerWindow)
        fields["ownerDescendant"] = .bool(ownerDescendant)
        fields["ownerVisible"] = .bool(ownerVisible)
        fields["cellFrame"] = .bool(cellFrame)
        fields["children"] = node.children.json
        return JSON.object(fields)
    }
    @MainActor static func rawDescendantFacts(_ row: NSObject, readout: AXReadout, boundary: NativeBoundary,
        nativeRow: NSView, clip: NSRect) -> JSON {
        // Only called for the already proven current legacy AXrow. Continue
        // through rejected candidates for fixed metadata; none enter acceptance.
        var totals: [String: Int] = [:], roles: [String: Int] = [:]
        var seen = Set<ObjectIdentifier>(), nodes = 0, truncated = false
        var text: [String] = [], leafExamples: [JSON] = []
        func add(_ key: String) { totals[key] = (totals[key] ?? 0) + 1 }
        @MainActor func visit(_ current: NSObject, depth: Int) {
            let identity = ObjectIdentifier(current)
            if seen.contains(identity) { return }
            guard nodes < 256, depth < 16 else { truncated = true; return }
            seen.insert(identity); nodes += 1
            guard let node = readout.node(current) else { truncated = true; return }
            let path = parentPath(current, readout: readout, boundary: boundary, row: row)
            let role: String = roleName(node.role)
            roles[role] = (roles[role] ?? 0) + 1
            if node.window == nil { add("missingWindow") }
            if node.window != nil && node.window !== boundary.window { add("foreignWindow") }
            if node.window === boundary.window { add("sameWindow") }
            if path.row { add("rowParent") }
            if path.table { add("tableParent") }
            if path.cycle { add("parentCycle") }
            if path.truncated { add("parentTruncated") }
            if path.unknownHidden > 0 { add("unknownHidden") }
            if node.frame == nil { add("missingFrame") }
            let inClip: Bool = node.frame.map { !$0.intersection(clip).isEmpty } ?? false
            if inClip { add("inClip") }
            let view: NSView? = current as? NSView
            let cell: NSCell? = current as? NSCell
            let control: NSView? = cell?.controlView
            if view != nil { add("nativeViews") }
            if cell != nil { add("nativeCells"); if control == nil { add("missingControlView") } }
            let nativeOwner: Bool
            if let view {
                nativeOwner = view.window === boundary.window && (view === nativeRow || view.isDescendant(of: nativeRow))
                    && MailboxLatency.visibleFrame(view) != nil
            } else if let cell {
                nativeOwner = MailboxLatency.visibleCellFrame(cell, in: nativeRow, window: boundary.window, clip: clip) != nil
            } else { nativeOwner = true }
            let scoped: Bool = node.window === boundary.window && path.row && path.table && !path.cycle && !path.truncated
                && path.hidden == 0 && path.foreignWindow == 0 && path.invisibleNative == 0 && inClip && nativeOwner
            if ["staticText", "textField", "textArea"].contains(role) {
                add("textLeaves")
                if node.window == nil { add("leafMissingWindow") }
                if path.row { add("leafRowParent") }
                if path.table { add("leafTableParent") }
                if inClip { add("leafInClip") }
                if scoped { add("scopedTextLeaves"); text += readout.text(node) }
                if leafExamples.count < 2 {
                    leafExamples.append(nodeDiagnostic(node, path: path, stage: "raw-text-leaf", readout: readout,
                        boundary: boundary, row: row, nativeRow: nativeRow, clip: clip))
                }
            }
            // Missing per-node window/parent metadata does not prune this raw
            // fact scan. Explicit foreign windows stop before further descent.
            if node.window != nil && node.window !== boundary.window { return }
            if let view, view.window !== boundary.window { return }
            if let control, control.window !== boundary.window { return }
            if node.children.truncated { truncated = true }
            for child in node.children.objects { visit(child, depth: depth + 1) }
        }
        visit(row, depth: 0)
        let keys: [String] = ["missingWindow", "foreignWindow", "sameWindow", "rowParent", "tableParent", "parentCycle",
            "parentTruncated", "unknownHidden", "missingFrame", "inClip", "nativeViews", "nativeCells", "missingControlView",
            "textLeaves", "leafMissingWindow", "leafRowParent", "leafTableParent", "leafInClip", "scopedTextLeaves"]
        var fields: [String: JSON] = [:], roleFields: [String: JSON] = [:]
        fields["nodes"] = count(nodes)
        fields["truncated"] = .bool(truncated)
        for key in keys { fields[key] = count(totals[key] ?? 0) }
        let allowedRoles: [String] = ["row", "table", "list", "outline", "cell", "group", "scrollArea", "window", "staticText", "textField", "textArea", "none", "other"]
        for role in allowedRoles { roleFields[role] = count(roles[role] ?? 0) }
        fields["roles"] = .object(roleFields)
        fields["text"] = matches(text)
        fields["leafExamples"] = .array(leafExamples)
        return JSON.object(fields)
    }
    @MainActor static func rowFacts(_ object: NSObject, readout: AXReadout, boundary: NativeBoundary) -> JSON {
        guard let seed = readout.node(object) else { return .object(["bounded": .bool(false)]) }
        let path = parentPath(object, readout: readout, boundary: boundary)
        let intersection: NSRect? = seed.frame.flatMap { frame in boundary.clip.map { frame.intersection($0) } }
        let overlap: Bool = intersection.map { !$0.isEmpty } ?? false
        let nativeOwner: Bool
        if let view = object as? NSView, let row = boundary.row {
            nativeOwner = view.window === boundary.window && (view === row || view.isDescendant(of: row))
                && MailboxLatency.visibleFrame(view) != nil
        } else if let cell = object as? NSCell, let row = boundary.row, let clip = boundary.clip {
            nativeOwner = MailboxLatency.visibleCellFrame(cell, in: row, window: boundary.window, clip: clip) != nil
        } else { nativeOwner = !(object is NSView) && !(object is NSCell) }
        let anchored: Bool = seed.role == NSAccessibility.Role.row.rawValue && seed.index == 0
            && seed.window === boundary.window && path.table && !path.cycle && !path.truncated
            && path.hidden == 0 && path.foreignWindow == 0 && path.invisibleNative == 0 && overlap && nativeOwner
        var nodes = 0, leaves = 0, framedLeaves = 0, knownVisibleLeaves = 0, unbacked = 0, rejected = 0, truncated = false
        var leafText: [String] = [], knownVisibleText: [String] = [], seen = Set<ObjectIdentifier>()
        var channels: [[String]] = [[], [], []]
        var rejectedNodes: [JSON] = []
        if anchored, let clip = intersection, let nativeRow = boundary.row {
            @MainActor func rejectedNode(_ node: Node, _ path: ParentPath, stage: String) {
                guard rejectedNodes.count < 2 else { return }
                rejectedNodes.append(nodeDiagnostic(node, path: path, stage: stage, readout: readout,
                    boundary: boundary, row: object, nativeRow: nativeRow, clip: clip))
            }
            @MainActor func visit(_ current: NSObject, depth: Int) {
                let identity = ObjectIdentifier(current)
                if seen.contains(identity) { return }
                guard nodes < 256, depth < 16 else { truncated = true; return }
                seen.insert(identity); nodes += 1
                guard let node = readout.node(current) else { truncated = true; return }
                let path = parentPath(current, readout: readout, boundary: boundary, row: object)
                guard node.window === boundary.window, path.row, path.table, !path.cycle, !path.truncated,
                      path.hidden == 0, path.foreignWindow == 0, path.invisibleNative == 0,
                      let frame = node.frame, !frame.intersection(clip).isEmpty else { rejected += 1; rejectedNode(node, path, stage: "ax"); return }
                if let view = current as? NSView {
                    guard view.window === boundary.window, view === nativeRow || view.isDescendant(of: nativeRow),
                          MailboxLatency.visibleFrame(view) != nil else { rejected += 1; rejectedNode(node, path, stage: "native-view"); return }
                } else if let cell = current as? NSCell {
                    guard MailboxLatency.visibleCellFrame(cell, in: nativeRow, window: boundary.window, clip: clip) != nil else { rejected += 1; rejectedNode(node, path, stage: "native-cell"); return }
                } else { unbacked += 1 }
                if [NSAccessibility.Role.staticText.rawValue, NSAccessibility.Role.textField.rawValue, NSAccessibility.Role.textArea.rawValue].contains(node.role ?? "") {
                    leaves += 1; framedLeaves += 1
                    let text = readout.text(node); leafText += text
                    for index in 0..<min(3, text.count) { channels[index].append(text[index]) }
                    if path.unknownHidden == 0 { knownVisibleLeaves += 1; knownVisibleText += text }
                }
                if node.children.truncated { truncated = true }
                for child in node.children.objects { visit(child, depth: depth + 1) }
            }
            visit(object, depth: 0)
        }
        var fields: [String: JSON] = [:]
        fields["role"] = .string(roleName(seed.role))
        fields["index0"] = .bool(seed.index == 0)
        fields["window"] = .bool(seed.window === boundary.window)
        fields["frame"] = rect(seed.frame)
        fields["overlap"] = .bool(overlap)
        fields["parent"] = path.json
        fields["conforms"] = .bool(seed.conforms)
        fields["children"] = seed.children.json
        fields["sameColumn"] = .bool(object === boundary.column)
        fields["sameNativeRow"] = .bool(object === boundary.row)
        fields["nativeOwner"] = .bool(nativeOwner)
        fields["anchored"] = .bool(anchored)
        fields["rowText"] = matches(anchored ? readout.text(seed) : [])
        let rowChannelValues: [String] = anchored ? readout.text(seed) : ["", "", ""]
        var rowChannelMatches: [JSON] = []
        for value in rowChannelValues { rowChannelMatches.append(matches([value])) }
        fields["rowTextChannels"] = JSON.array(rowChannelMatches)
        fields["leafNodes"] = count(nodes)
        fields["textLeaves"] = count(leaves)
        fields["framedLeaves"] = count(framedLeaves)
        fields["knownVisibleLeaves"] = count(knownVisibleLeaves)
        fields["unbacked"] = count(unbacked)
        fields["rejected"] = count(rejected)
        fields["leafText"] = matches(leafText)
        var leafChannelMatches: [JSON] = []
        for values in channels { leafChannelMatches.append(matches(values)) }
        fields["leafTextChannels"] = JSON.array(leafChannelMatches)
        fields["knownVisibleText"] = matches(knownVisibleText)
        fields["truncated"] = .bool(truncated)
        fields["rejectedNodes"] = .array(rejectedNodes)
        fields["rawDescendants"] = .null
        if anchored, readout.family == .attributes, let clip = intersection, let nativeRow = boundary.row {
            fields["rawDescendants"] = rawDescendantFacts(object, readout: readout, boundary: boundary, nativeRow: nativeRow, clip: clip)
        }
        return JSON.object(fields)
    }
    @MainActor static func selectorObjects(_ row: NSObject, cell: NSObject, boundary: NativeBoundary) throws {
        // Every performed selector below is a fixed public zero-argument
        // object-returning getter. Geometry, indices and BOOLs are not invoked.
        let keys: [String] = ["accessibilityRole", "accessibilityWindow", "accessibilityParent", "accessibilityChildren",
            "accessibilityValue", "accessibilityLabel", "accessibilityTitle", "accessibilityHelp"]
        let textKeys: [String] = ["accessibilityValue", "accessibilityLabel", "accessibilityTitle", "accessibilityHelp"]
        var retained: [ObjectIdentifier: NSObject] = [:], cache: [ObjectIdentifier: Node] = [:]
        var queried: [ObjectIdentifier: Set<String>] = [:], available: [ObjectIdentifier: Set<String>] = [:]
        var values: [ObjectIdentifier: [String: AnyObject]] = [:], bounded = true
        @MainActor func read(_ object: NSObject, _ key: String) -> AnyObject? {
            guard keys.contains(key) else { return nil }
            let id = ObjectIdentifier(object)
            if queried[id]?.contains(key) == true { return values[id]?[key] }
            guard retained[id] != nil || retained.count < 512 else { bounded = false; return nil }
            retained[id] = object
            queried[id, default: []].insert(key)
            let selector = NSSelectorFromString(key)
            guard object.responds(to: selector) else { return nil }
            available[id, default: []].insert(key)
            let value: AnyObject? = object.perform(selector)?.takeUnretainedValue()
            if let value { values[id, default: [:]][key] = value }
            return value
        }
        @MainActor func node(_ object: NSObject) -> Node? {
            let id = ObjectIdentifier(object)
            if let existing = cache[id] { return existing }
            guard retained[id] != nil || retained.count < 512 else { bounded = false; return nil }
            var result = Node(object: object)
            result.role = read(object, "accessibilityRole") as? String
            result.window = read(object, "accessibilityWindow") as? NSObject
            result.parent = read(object, "accessibilityParent") as? NSObject
            let children: AnyObject? = read(object, "accessibilityChildren")
            result.children.supported = available[id]?.contains("accessibilityChildren") == true
            if let children = children as? [Any] {
                result.children.present = true; result.children.count = children.count
                result.children.truncated = children.count > 64
                for child in children.prefix(64) {
                    if let object = child as? NSObject { result.children.objects.append(object) }
                    else { result.children.invalid += 1 }
                }
            }
            cache[id] = result
            return result
        }
        @MainActor func path(_ object: NSObject) -> (ParentPath, Bool) {
            var result = ParentPath(), hasCell = false, next: NSObject? = object, seen = Set<ObjectIdentifier>()
            for _ in 0..<32 {
                guard let current = next else { return (result, hasCell) }
                guard seen.insert(ObjectIdentifier(current)).inserted else { result.cycle = true; return (result, hasCell) }
                result.hops += 1; result.row = result.row || current === row
                result.table = result.table || current === boundary.table; result.host = result.host || current === boundary.host
                hasCell = hasCell || current === cell
                if let view = current as? NSView {
                    if view.window !== boundary.window { result.foreignWindow += 1 }
                    if MailboxLatency.visibleFrame(view) == nil { result.invisibleNative += 1 }
                } else if let owner = (current as? NSCell)?.controlView, owner.window !== boundary.window {
                    result.foreignWindow += 1
                }
                guard let value = node(current) else { result.truncated = true; return (result, hasCell) }
                result.unknownHidden += 1
                if let window = value.window, window !== boundary.window { result.foreignWindow += 1 }
                if result.table { return (result, hasCell) }
                next = value.parent
            }
            result.truncated = next != nil
            return (result, hasCell)
        }
        func strings(_ value: AnyObject?) -> [String] {
            if let string = value as? String { return [string] }
            if let attributed = value as? NSAttributedString { return [attributed.string] }
            return []
        }
        func valueType(_ value: AnyObject?) -> String {
            guard let value else { return "missing" }
            if value is String { return "string" }
            if value is NSAttributedString { return "attributedString" }
            if value is [Any] { return "array" }
            if value is NSNumber { return "number" }
            return "object"
        }
        @MainActor func facts(_ object: NSObject) -> JSON {
            guard let value = node(object) else { return .object(["bounded": .bool(false)]) }
            let id = ObjectIdentifier(object), owned = path(object)
            var fields: [String: JSON] = [:], getters: [String: JSON] = [:], channels: [String: JSON] = [:]
            fields["role"] = .string(roleName(value.role))
            fields["windowKnown"] = .bool(value.window != nil)
            fields["windowSame"] = .bool(value.window === boundary.window)
            fields["sameRow"] = .bool(object === row); fields["sameCell"] = .bool(object === cell)
            fields["parentKnown"] = .bool(value.parent != nil)
            fields["parentSameRow"] = .bool(value.parent === row); fields["parentSameCell"] = .bool(value.parent === cell)
            fields["parentSameTable"] = .bool(value.parent === boundary.table)
            fields["parentPath"] = owned.0.json; fields["parentPathCell"] = .bool(owned.1)
            fields["children"] = value.children.json
            for key in keys {
                var getter: [String: JSON] = [:]
                getter["available"] = .bool(available[id]?.contains(key) == true)
                getter["queried"] = .bool(queried[id]?.contains(key) == true)
                getter["type"] = .string(valueType(values[id]?[key]))
                getters[key] = .object(getter)
            }
            for key in textKeys { channels[key] = matches(strings(values[id]?[key])) }
            fields["getters"] = .object(getters); fields["channels"] = .object(channels)
            return JSON.object(fields)
        }
        var seen = Set<ObjectIdentifier>(), nodes = 0, truncated = false, foreign = 0, unknownWindow = 0, sameWindow = 0
        var tableParents = 0, rowParents = 0, cellParents = 0, leaves = 0
        var roles: [String: Int] = [:], text: [String] = [], leafText: [String] = [], examples: [JSON] = []
        @MainActor func visit(_ object: NSObject, depth: Int) {
            let id = ObjectIdentifier(object)
            if seen.contains(id) { return }
            guard nodes < 256, depth < 16 else { truncated = true; return }
            seen.insert(id); nodes += 1
            guard let value = node(object) else { truncated = true; return }
            let owned = path(object), role = roleName(value.role)
            roles[role] = (roles[role] ?? 0) + 1
            if value.window == nil { unknownWindow += 1 }
            if value.window === boundary.window { sameWindow += 1 }
            if owned.0.table { tableParents += 1 }; if owned.0.row { rowParents += 1 }; if owned.1 { cellParents += 1 }
            if owned.0.foreignWindow > 0 || (value.window != nil && value.window !== boundary.window) {
                foreign += 1; return
            }
            // These are raw diagnostic matches on this retained modern child
            // graph. Missing geometry/hidden/parent proof never enters acceptance.
            var observed: [String] = []
            for key in textKeys { observed += strings(read(object, key)) }
            text += observed
            if ["staticText", "textField", "textArea"].contains(role) {
                leaves += 1; leafText += observed
                if examples.count < 2 { examples.append(facts(object)) }
            }
            if value.children.truncated { truncated = true }
            for child in value.children.objects { visit(child, depth: depth + 1) }
        }
        visit(row, depth: 0); visit(cell, depth: 0)
        let rowFacts = facts(row), cellFacts = facts(cell)
        var getterCounts: [String: JSON] = [:], roleCounts: [String: JSON] = [:]
        for key in keys {
            var getter: [String: JSON] = [:]
            getter["available"] = count(available.values.filter { $0.contains(key) }.count)
            getter["present"] = count(values.values.filter { $0[key] != nil }.count)
            getterCounts[key] = .object(getter)
        }
        let allowedRoles: [String] = ["row", "table", "list", "outline", "cell", "group", "scrollArea", "window", "staticText", "textField", "textArea", "none", "other"]
        for role in allowedRoles { roleCounts[role] = count(roles[role] ?? 0) }
        var fields: [String: JSON] = [:]
        fields["nodes"] = count(nodes); fields["retained"] = count(retained.count)
        fields["truncated"] = .bool(truncated); fields["bounded"] = .bool(bounded)
        fields["foreignWindowRejected"] = count(foreign); fields["unknownWindow"] = count(unknownWindow)
        fields["sameWindow"] = count(sameWindow); fields["tableParent"] = count(tableParents)
        fields["rowParent"] = count(rowParents); fields["cellParent"] = count(cellParents)
        fields["textLeaves"] = count(leaves); fields["roles"] = .object(roleCounts)
        fields["getters"] = .object(getterCounts); fields["row"] = rowFacts; fields["cell"] = cellFacts
        fields["text"] = matches(text); fields["leafText"] = matches(leafText); fields["leafExamples"] = .array(examples)
        try emit("selector-objects", fields)
    }
    @MainActor static func cellProjection(_ object: NSObject?, readout: AXReadout, boundary: NativeBoundary) throws {
        var fields: [String: JSON] = [:]
        fields["capturedRow"] = .bool(object != nil)
        guard let object, let seed = readout.node(object), let table = boundary.table,
              let nativeRow = boundary.row, let column = boundary.column, let clip = boundary.clip else {
            try emit("cell-attributes", fields); return
        }
        let currentSlot: Bool = table.numberOfRows > 0 && table.numberOfColumns > 0
            && table.rowView(atRow: 0, makeIfNecessary: false) === nativeRow
            && table.view(atColumn: 0, row: 0, makeIfNecessary: false) === column
        let nativeOwned: Bool = table.window === boundary.window && table.isDescendant(of: boundary.host)
            && nativeRow.window === boundary.window && nativeRow.isDescendant(of: table)
            && column.window === boundary.window && column.isDescendant(of: nativeRow)
        let nativeVisible: Bool = MailboxLatency.visibleFrame(table) != nil && MailboxLatency.visibleFrame(nativeRow) != nil
            && MailboxLatency.visibleFrame(column) != nil
        let path = parentPath(object, readout: readout, boundary: boundary)
        let rowPathOwned: Bool = path.table && !path.cycle && !path.truncated && path.hidden == 0
            && path.foreignWindow == 0 && path.invisibleNative == 0
        let rowScoped: Bool = seed.role == NSAccessibility.Role.row.rawValue && seed.index == 0
            && seed.window === boundary.window && rowPathOwned && (seed.frame.map { $0.intersects(clip) } ?? false)
        fields["currentSlot"] = .bool(currentSlot)
        fields["nativeOwned"] = .bool(nativeOwned)
        fields["nativeVisible"] = .bool(nativeVisible)
        fields["rowScoped"] = .bool(rowScoped)
        let cells: [Node] = seed.children.objects.compactMap { readout.node($0) }.filter { $0.role == NSAccessibility.Role.cell.rawValue }
        fields["cells"] = count(cells.count)
        guard let node = cells.first else { try emit("cell-attributes", fields); return }
        let cellPath = parentPath(node.object, readout: readout, boundary: boundary, row: object)
        let cellInClip: Bool = node.frame.map { clip.contains($0) } ?? false
        let cellPathOwned: Bool = cellPath.table && !cellPath.cycle && !cellPath.truncated && cellPath.hidden == 0
            && cellPath.foreignWindow == 0 && cellPath.invisibleNative == 0
        let cellNativeOwned: Bool
        if let view = node.object as? NSView {
            cellNativeOwned = view.window === boundary.window && view.isDescendant(of: nativeRow) && MailboxLatency.visibleFrame(view) != nil
        } else if let cell = node.object as? NSCell {
            cellNativeOwned = MailboxLatency.visibleCellFrame(cell, in: nativeRow, window: boundary.window, clip: clip) != nil
        } else { cellNativeOwned = true }
        let scoped: Bool = currentSlot && nativeOwned && nativeVisible && rowScoped && cellNativeOwned
            && node.window === boundary.window && cellPathOwned && cellInClip
        fields["scoped"] = .bool(scoped)
        fields["role"] = .string(roleName(node.role))
        fields["frame"] = rect(node.frame)
        fields["window"] = .bool(node.window === boundary.window)
        fields["inClip"] = .bool(cellInClip)
        fields["parentPath"] = cellPath.json
        fields["sameCapturedRowParent"] = .bool(node.parent === object)
        var parentFields: [String: JSON] = [:]
        if let parent = node.parent, let parentNode = readout.node(parent) {
            parentFields["role"] = .string(roleName(parentNode.role))
            parentFields["index0"] = .bool(parentNode.index == 0)
            parentFields["index"] = parentNode.index.map { count($0) } ?? .null
            parentFields["window"] = .bool(parentNode.window === boundary.window)
            parentFields["frame"] = rect(parentNode.frame)
            parentFields["sameRowFrame"] = .bool(parentNode.frame != nil && parentNode.frame == seed.frame)
            parentFields["path"] = parentPath(parent, readout: readout, boundary: boundary).json
        }
        fields["parent"] = .object(parentFields)
        let keys: [String] = ["AXValue", "AXDescription", "AXTitle", "AXRowIndexRange", "AXColumnIndexRange",
            "AXContents", "AXVisibleChildren", "AXChildren", "AXWindow", "AXParent", "AXPosition", "AXSize", "AXIndex", "AXHidden"]
        var advertised: [String: JSON] = [:]
        for key in keys { advertised[key] = .bool(node.attributes.contains(NSAccessibility.Attribute(rawValue: key))) }
        fields["advertised"] = .object(advertised)
        // All new channel reads are confined to this captured current cell.
        // Missing wrapper identity is observed here, never accepted by an oracle.
        if scoped {
            func valueType(_ value: Any?) -> String {
                guard let value else { return "missing" }
                if value is NSNull { return "null" }
                if value is String { return "string" }
                if value is NSAttributedString { return "attributedString" }
                if value is NSNumber { return "number" }
                if value is [Any] { return "array" }
                return value is NSObject ? "object" : "other"
            }
            var channelFields: [String: JSON] = [:]
            for key in ["AXValue", "AXDescription", "AXTitle"] {
                let value: Any? = readout.attribute(node.object, node.attributes, key)
                var channel: [String: JSON] = [:]
                channel["type"] = .string(valueType(value))
                channel["match"] = matches((value as? String).map { [$0] } ?? [])
                channelFields[key] = .object(channel)
            }
            fields["channels"] = .object(channelFields)
            var ranges: [String: JSON] = [:]
            let rangeType: String = String(cString: NSValue(range: NSRange(location: 0, length: 1)).objCType)
            for key in ["AXRowIndexRange", "AXColumnIndexRange"] {
                let value: Any? = readout.attribute(node.object, node.attributes, key)
                var rangeFields: [String: JSON] = [:]
                rangeFields["type"] = .string(valueType(value))
                if let value = value as? NSValue, String(cString: value.objCType) == rangeType {
                    let range: NSRange = value.rangeValue
                    rangeFields["location"] = count(range.location)
                    rangeFields["length"] = count(range.length)
                    rangeFields["slot0"] = .bool(range.location == 0 && range.length == 1)
                }
                ranges[key] = .object(rangeFields)
            }
            fields["ranges"] = .object(ranges)
            var childFields: [String: JSON] = [:]
            for key in ["AXContents", "AXVisibleChildren"] {
                let value: Any? = readout.attribute(node.object, node.attributes, key)
                let supported: Bool = node.attributes.contains(NSAccessibility.Attribute(rawValue: key))
                var child: [String: JSON] = [:]
                child["type"] = .string(valueType(value))
                child["array"] = readout.array(value, supported: supported).json
                childFields[key] = .object(child)
            }
            fields["alternateChildren"] = .object(childFields)
        }
        try emit("cell-attributes", fields)
        if scoped { try selectorObjects(object, cell: node.object, boundary: boundary) }
    }
    @MainActor static func tableProjection(_ readout: AXReadout, boundary: NativeBoundary) throws {
        guard let list = boundary.table else {
            try emit("table-" + readout.family.rawValue, ["nativeTable": .bool(false)]); return
        }
        let rows = readout.rows(list, visible: false), visible = readout.rows(list, visible: true)
        var capturedRow: NSObject?
        @MainActor func describe(_ values: ArrayRead) -> JSON {
            let candidates = values.objects.filter { object in
                guard let node = readout.node(object) else { return false }
                return node.role == NSAccessibility.Role.row.rawValue && node.index == 0
            }
            if readout.family == .attributes, capturedRow == nil { capturedRow = candidates.first }
            var fields: [String: JSON] = [:]
            fields["array"] = values.json
            fields["index0Rows"] = count(candidates.count)
            var examples: [JSON] = []
            for object in candidates.prefix(2) { examples.append(rowFacts(object, readout: readout, boundary: boundary)) }
            fields["examples"] = JSON.array(examples)
            return JSON.object(fields)
        }
        var tableFields: [String: JSON] = [:]
        tableFields["rows"] = describe(rows)
        tableFields["visibleRows"] = describe(visible)
        tableFields["bounded"] = .bool(readout.bounded)
        try emit("table-" + readout.family.rawValue, tableFields)
        if readout.family == .attributes { try cellProjection(capturedRow, readout: readout, boundary: boundary) }
    }
    @MainActor static func hostProjection(_ readout: AXReadout, boundary: NativeBoundary) throws {
        var seen = Set<ObjectIdentifier>(), nodes = 0, rows = 0, tables = 0, unsupported = 0, truncated = false
        var examples: [JSON] = []
        @MainActor func visit(_ object: NSObject, depth: Int) {
            let identity = ObjectIdentifier(object)
            if seen.contains(identity) { return }
            guard nodes < 256, depth < 16 else { truncated = true; return }
            seen.insert(identity); nodes += 1
            guard let node = readout.node(object) else { truncated = true; return }
            if !node.supported { unsupported += 1 }
            if node.role == NSAccessibility.Role.table.rawValue || node.role == NSAccessibility.Role.list.rawValue || node.role == NSAccessibility.Role.outline.rawValue { tables += 1 }
            if node.role == NSAccessibility.Role.row.rawValue, node.index == 0,
               node.window === boundary.window, let frame = node.frame, let clip = boundary.clip, frame.intersects(clip) {
                rows += 1
                if examples.count < 2 { examples.append(rowFacts(object, readout: readout, boundary: boundary)) }
            }
            if node.children.truncated { truncated = true }
            for child in node.children.objects { visit(child, depth: depth + 1) }
        }
        visit(boundary.host, depth: 0)
        var hostFields: [String: JSON] = [:]
        hostFields["nodes"] = count(nodes)
        hostFields["tables"] = count(tables)
        hostFields["index0RowsInClip"] = count(rows)
        hostFields["unsupported"] = count(unsupported)
        hostFields["examples"] = .array(examples)
        hostFields["truncated"] = .bool(truncated)
        hostFields["bounded"] = .bool(readout.bounded)
        try emit("host-" + readout.family.rawValue, hostFields)
    }

    @MainActor static func caseBody() async throws -> Bool {
        guard let workspace = ProcessInfo.processInfo.environment["MORROW_DATA_DIR"], workspace.hasPrefix("/") else {
            throw APIError("An isolated fixture workspace is required")
        }
        _ = NSApplication.shared; NSApp.setActivationPolicy(.regular)
        UserDefaults.standard.setVolatileDomain(["mailReaderLayout": "right", "mailSidebarVisible": true,
            "collapsedMailAccounts": "[]"], forName: UserDefaults.argumentDomain)
        MailboxLatencyProtocol.prepare(1000)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [MailboxLatencyProtocol.self]
        let model = AppModel(session: URLSession(configuration: config))
        model.state = MailboxLatencyProtocol.state(); model.starting = false
        let window = NSWindow(contentRect: NSRect(x: 50, y: 50, width: 1220, height: 820), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: MailWorkspace().environmentObject(model))
        window.contentView = host; window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        defer { window.close(); window.contentView = nil; model.stop(); model.session.invalidateAndCancel() }
        var originalPassed = false
        do {
            try await MailboxLatency.wait("Initial owned native page did not mount.") { model.listedMessages.count == 50 && !model.mailLoading && MailboxLatency.displayed(host, page: 0) }
            originalPassed = true
        } catch { originalPassed = false }
        let observed = MailboxLatencyProtocol.snapshot()
        var baselineFields: [String: JSON] = [:]
        baselineFields["originalPredicatePassed"] = .bool(originalPassed)
        baselineFields["listed"] = count(model.listedMessages.count)
        baselineFields["loading"] = .bool(model.mailLoading)
        baselineFields["generated"] = count(observed.0)
        baselineFields["unexpected"] = count(observed.1)
        baselineFields["requests"] = count(observed.2)
        baselineFields["windowVisible"] = .bool(window.isVisible)
        baselineFields["active"] = .bool(NSApp.isActive)
        baselineFields["running"] = .bool(NSApp.isRunning)
        try emit("baseline", baselineFields)
        // Capture the actual fictional native view before any new AX query.
        try ProbeEvidence.bitmap(host, name: "row-" + mode + "-before")
        let list = MailboxLatency.table(host)
        let column: NSView? = list.flatMap { $0.numberOfRows > 0 && $0.numberOfColumns > 0 ? $0.view(atColumn: 0, row: 0, makeIfNecessary: false) : nil }
        let row: NSTableRowView? = list.flatMap { $0.numberOfRows > 0 ? $0.rowView(atRow: 0, makeIfNecessary: false) : nil }
        var clip: NSRect?
        if let list, let row, list.window === window, list.isDescendant(of: host), row.window === window,
           row.isDescendant(of: list), let tableFrame = MailboxLatency.visibleFrame(list), let rowFrame = MailboxLatency.visibleFrame(row) {
            let frame = window.convertToScreen(list.convert(list.rect(ofRow: 0), to: nil))
            clip = finiteFrame(frame.intersection(tableFrame).intersection(rowFrame))
        }
        let boundary = NativeBoundary(host: host, window: window, table: list, column: column, row: row, clip: clip)
        var nativeFields: [String: JSON] = [:]
        nativeFields["table"] = .bool(list != nil)
        nativeFields["rows"] = count(list?.numberOfRows ?? 0)
        nativeFields["columns"] = count(list?.numberOfColumns ?? 0)
        nativeFields["column0"] = .bool(column != nil)
        nativeFields["row0"] = .bool(row != nil)
        nativeFields["tableFrame"] = rect(list.flatMap { MailboxLatency.visibleFrame($0) })
        nativeFields["rowFrame"] = rect(row.flatMap { MailboxLatency.visibleFrame($0) })
        nativeFields["clip"] = rect(clip)
        try emit("native", nativeFields)
        for family in [Family.method, .attributes] {
            let readout = AXReadout(family)
            try tableProjection(readout, boundary: boundary)
            try hostProjection(readout, boundary: boundary)
        }
        let after = MailboxLatency.displayed(host, page: 0)
        var afterFields: [String: JSON] = [:]
        afterFields["afterQueryDisplayed"] = .bool(after)
        afterFields["originalPredicatePassed"] = .bool(originalPassed)
        try emit("after", afterFields)
        if after != originalPassed { try ProbeEvidence.bitmap(host, name: "row-" + mode + "-after") }
        await ProbeEvidence.windowBitmap(host, name: "row-" + mode + "-window-after")
        return originalPassed
    }
    @MainActor static func run() async {
        do {
            try emit("case-start")
            let passed = try await caseBody()
            // The owned native window/model/session have completed their defers.
            try emit("case-cleaned-up", ["originalPredicatePassed": .bool(passed)])
            try ProbeEvidence.complete(kind: "row", mode: mode, passed: passed)
        } catch {
            try? emit("diagnostic-incomplete")
            print("Isolated row projection diagnostic did not complete")
            fflush(stdout); exit(1)
        }
    }
}
