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
        guard let frame, [frame.minX, frame.minY, frame.width, frame.height].allSatisfy({ $0.isFinite && abs($0) <= 10_000_000 }) else { return .null }
        return .array([frame.minX, frame.minY, frame.width, frame.height].map { .number(Double($0)) })
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
        var json: JSON { .object(["supported": .bool(supported), "present": .bool(present),
            "count": IsolatedRowProjection.count(count), "invalid": IsolatedRowProjection.count(invalid), "truncated": .bool(truncated)]) }
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
                values = [element.accessibilityValue() as? String, element.accessibilityLabel(), element.accessibilityTitle()].map { $0 ?? "" }
            case .attributes:
                values = ["AXValue", "AXDescription", "AXTitle"].map { attribute(node.object, node.attributes, $0) as? String ?? "" }
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
        var json: JSON { .object(["table": .bool(table), "host": .bool(host), "row": .bool(row),
            "hops": IsolatedRowProjection.count(hops), "cycle": .bool(cycle), "truncated": .bool(truncated),
            "hidden": IsolatedRowProjection.count(hidden), "unknownHidden": IsolatedRowProjection.count(unknownHidden),
            "foreignWindow": IsolatedRowProjection.count(foreignWindow), "invisibleNative": IsolatedRowProjection.count(invisibleNative)]) }
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
        return .array([values.contains(subject), values.contains { $0.contains(subject) },
            values.contains(owner) || values.contains("Mailbox: " + owner), values.contains { $0.contains(owner) }].map(JSON.bool))
    }
    @MainActor static func rowFacts(_ object: NSObject, readout: AXReadout, boundary: NativeBoundary) -> JSON {
        guard let seed = readout.node(object) else { return .object(["bounded": .bool(false)]) }
        let path = parentPath(object, readout: readout, boundary: boundary)
        let intersection = seed.frame.flatMap { frame in boundary.clip.map { frame.intersection($0) } }
        let overlap = intersection.map { !$0.isEmpty } ?? false
        let nativeOwner: Bool
        if let view = object as? NSView, let row = boundary.row {
            nativeOwner = view.window === boundary.window && (view === row || view.isDescendant(of: row))
                && MailboxLatency.visibleFrame(view) != nil
        } else if let cell = object as? NSCell, let row = boundary.row, let clip = boundary.clip {
            nativeOwner = MailboxLatency.visibleCellFrame(cell, in: row, window: boundary.window, clip: clip) != nil
        } else { nativeOwner = !(object is NSView) && !(object is NSCell) }
        let anchored = seed.role == NSAccessibility.Role.row.rawValue && seed.index == 0
            && seed.window === boundary.window && path.table && !path.cycle && !path.truncated
            && path.hidden == 0 && path.foreignWindow == 0 && path.invisibleNative == 0 && overlap && nativeOwner
        var nodes = 0, leaves = 0, framedLeaves = 0, knownVisibleLeaves = 0, unbacked = 0, rejected = 0, truncated = false
        var leafText: [String] = [], knownVisibleText: [String] = [], seen = Set<ObjectIdentifier>()
        var channels: [[String]] = [[], [], []]
        if anchored, let clip = intersection, let nativeRow = boundary.row {
            @MainActor func visit(_ current: NSObject, depth: Int) {
                let identity = ObjectIdentifier(current)
                if seen.contains(identity) { return }
                guard nodes < 256, depth < 16 else { truncated = true; return }
                seen.insert(identity); nodes += 1
                guard let node = readout.node(current) else { truncated = true; return }
                let path = parentPath(current, readout: readout, boundary: boundary, row: object)
                guard node.window === boundary.window, path.row, path.table, !path.cycle, !path.truncated,
                      path.hidden == 0, path.foreignWindow == 0, path.invisibleNative == 0,
                      let frame = node.frame, !frame.intersection(clip).isEmpty else { rejected += 1; return }
                if let view = current as? NSView {
                    guard view.window === boundary.window, view === nativeRow || view.isDescendant(of: nativeRow),
                          MailboxLatency.visibleFrame(view) != nil else { rejected += 1; return }
                } else if let cell = current as? NSCell {
                    guard MailboxLatency.visibleCellFrame(cell, in: nativeRow, window: boundary.window, clip: clip) != nil else { rejected += 1; return }
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
        return .object(["role": .string(roleName(seed.role)), "index0": .bool(seed.index == 0),
            "window": .bool(seed.window === boundary.window), "frame": rect(seed.frame), "overlap": .bool(overlap),
            "parent": path.json, "conforms": .bool(seed.conforms), "children": seed.children.json,
            "sameColumn": .bool(object === boundary.column), "sameNativeRow": .bool(object === boundary.row),
            "nativeOwner": .bool(nativeOwner),
            "anchored": .bool(anchored), "rowText": matches(anchored ? readout.text(seed) : []),
            "rowTextChannels": .array((anchored ? readout.text(seed) : ["", "", ""]).map { matches([$0]) }),
            "leafNodes": count(nodes), "textLeaves": count(leaves), "framedLeaves": count(framedLeaves),
            "knownVisibleLeaves": count(knownVisibleLeaves), "unbacked": count(unbacked), "rejected": count(rejected),
            "leafText": matches(leafText), "leafTextChannels": .array(channels.map { matches($0) }),
            "knownVisibleText": matches(knownVisibleText), "truncated": .bool(truncated)])
    }
    @MainActor static func tableProjection(_ readout: AXReadout, boundary: NativeBoundary) throws {
        guard let list = boundary.table else {
            try emit("table-" + readout.family.rawValue, ["nativeTable": .bool(false)]); return
        }
        let rows = readout.rows(list, visible: false), visible = readout.rows(list, visible: true)
        @MainActor func describe(_ values: ArrayRead) -> JSON {
            let candidates = values.objects.filter { object in
                guard let node = readout.node(object) else { return false }
                return node.role == NSAccessibility.Role.row.rawValue && node.index == 0
            }
            return .object(["array": values.json, "index0Rows": count(candidates.count),
                "examples": .array(candidates.prefix(2).map { rowFacts($0, readout: readout, boundary: boundary) })])
        }
        try emit("table-" + readout.family.rawValue, ["rows": describe(rows), "visibleRows": describe(visible), "bounded": .bool(readout.bounded)])
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
        try emit("host-" + readout.family.rawValue, ["nodes": count(nodes), "tables": count(tables),
            "index0RowsInClip": count(rows), "unsupported": count(unsupported), "examples": .array(examples),
            "truncated": .bool(truncated), "bounded": .bool(readout.bounded)])
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
        try emit("baseline", ["originalPredicatePassed": .bool(originalPassed), "listed": count(model.listedMessages.count),
            "loading": .bool(model.mailLoading), "generated": count(observed.0), "unexpected": count(observed.1),
            "requests": count(observed.2), "windowVisible": .bool(window.isVisible),
            "active": .bool(NSApp.isActive), "running": .bool(NSApp.isRunning)])
        // Capture the actual fictional native view before any new AX query.
        try ProbeEvidence.bitmap(host, name: "row-" + mode + "-before")
        let list = MailboxLatency.table(host)
        let column = list.flatMap { $0.numberOfRows > 0 && $0.numberOfColumns > 0 ? $0.view(atColumn: 0, row: 0, makeIfNecessary: false) : nil }
        let row = list.flatMap { $0.numberOfRows > 0 ? $0.rowView(atRow: 0, makeIfNecessary: false) : nil }
        var clip: NSRect?
        if let list, let row, list.window === window, list.isDescendant(of: host), row.window === window,
           row.isDescendant(of: list), let tableFrame = MailboxLatency.visibleFrame(list), let rowFrame = MailboxLatency.visibleFrame(row) {
            let frame = window.convertToScreen(list.convert(list.rect(ofRow: 0), to: nil))
            clip = finiteFrame(frame.intersection(tableFrame).intersection(rowFrame))
        }
        let boundary = NativeBoundary(host: host, window: window, table: list, column: column, row: row, clip: clip)
        try emit("native", ["table": .bool(list != nil), "rows": count(list?.numberOfRows ?? 0),
            "columns": count(list?.numberOfColumns ?? 0), "column0": .bool(column != nil), "row0": .bool(row != nil),
            "tableFrame": rect(list.flatMap { MailboxLatency.visibleFrame($0) }),
            "rowFrame": rect(row.flatMap { MailboxLatency.visibleFrame($0) }), "clip": rect(clip)])
        for family in [Family.method, .attributes] {
            let readout = AXReadout(family)
            try tableProjection(readout, boundary: boundary)
            try hostProjection(readout, boundary: boundary)
        }
        let after = MailboxLatency.displayed(host, page: 0)
        try emit("after", ["afterQueryDisplayed": .bool(after), "originalPredicatePassed": .bool(originalPassed)])
        if after != originalPassed { try ProbeEvidence.bitmap(host, name: "row-" + mode + "-after") }
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
