import AppKit
import SwiftUI

// Opt-in measurement executable, never linked into the app. Every request is
// intercepted; no service, workspace, provider, model, reader HTML or write is
// opened. The companion runner changes only AppModel's initial baseURL in a
// private compiler input, using the existing MailFlowAssertions transport seam.
final class MailboxLatencyProtocol: URLProtocol {
    static let owners = ["alpha@latency.invalid", "beta@latency.invalid"]
    static let lock = NSLock()
    static var rows: [JSON] = []
    static var unexpected = 0
    static var requests = 0

    static func prepare(_ size: Int) {
        lock.lock(); defer { lock.unlock() }
        rows = (0..<size).map { index in
            let owner = owners[index % 2], id = "imap:55:\(index / 2 + 1)"
            return .object(["id": .string(id), "viewId": .string(owner + ":" + id), "accountId": .string(owner),
                "folder": .string("inbox"), "read": .bool(true), "starred": .bool(false),
                "subject": .string("Fictional mailbox row \(index) 中文"), "fromName": .string("Fictional sender \(index % 37)"),
                "fromEmail": .string("sender@example.invalid"), "to": .string(owner),
                "date": .string("2026-01-01T12:00:00Z"), "preview": .string("Controlled native layout fixture \(index)")])
        }
        unexpected = 0; requests = 0
    }
    static func state() -> JSON {
        .object(["account": .object(["id": .string("all")]), "revision": .string("fixture-1"),
            "accounts": .array(owners.map { .object(["id": .string($0), "provider": .string("imap"),
                "email": .string($0), "settings": .object(["configured": .bool(true)])]) }),
            "messages": .array([]), "settings": .object(["preferences": .object(["markReadOnOpen": .bool(false),
                "density": .string("comfortable"), "sort": .string("date-desc")]), "policy": .object(["enabled": .bool(false)])])])
    }
    static func snapshot() -> (Int, Int, Int) {
        lock.lock(); defer { lock.unlock() }; return (rows.count, unexpected, requests)
    }
    static func payload(_ request: URLRequest) throws -> JSON {
        if let data = request.httpBody { return try JSONDecoder().decode(JSON.self, from: data) }
        guard let stream = request.httpBodyStream else { return .null }
        stream.open(); defer { stream.close() }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 || data.count + count > 65536 { throw APIError("Invalid synthetic request.") }
            if count == 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        return try JSONDecoder().decode(JSON.self, from: data)
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let body = try Self.payload(request), owner = request.value(forHTTPHeaderField: "X-Genmail-Account") ?? ""
            guard request.url?.scheme == "http", request.url?.host == "127.0.0.1", request.url?.port == 18484 else {
                throw APIError("Unexpected synthetic origin.")
            }
            let result: JSON
            Self.lock.lock()
            do {
                defer { Self.lock.unlock() }
                Self.requests += 1
                switch (request.httpMethod ?? "GET", request.url!.path) {
                case ("GET", "/api/search/preferences"):
                    guard owner == "all" else { throw APIError("Wrong preference owner.") }
                    result = .object(["saved": .array([]), "recent": .array([])])
                case ("POST", "/api/mail/page"):
                    let offset = Int(body["offset"].number)
                    guard owner == "all", body["folder"].string == "inbox", offset >= 0, offset < Self.rows.count, offset % 50 == 0 else {
                        throw APIError("Invalid synthetic page.")
                    }
                    let end = min(Self.rows.count, offset + 50)
                    result = .object(["messages": .array(Array(Self.rows[offset..<end])), "total": .number(Double(Self.rows.count)),
                        "nextCursor": .string(end < Self.rows.count ? "fixture-\(end)" : "")])
                case ("POST", "/api/sync/priority"):
                    guard owner == "all", body["messages"].array.count <= 51,
                        body["messages"].array.allSatisfy({ Self.owners.contains($0["accountId"].string) }) else {
                        throw APIError("Invalid synthetic priority hint.")
                    }
                    result = .object(["accepted": .bool(true)])
                case ("GET", let path) where path.hasPrefix("/api/messages/"):
                    let id = String(path.dropFirst("/api/messages/".count))
                    guard let index = Self.rows.firstIndex(where: { $0.id == id && $0["accountId"].string == owner }) else {
                        throw APIError("Unknown synthetic owned message.")
                    }
                    var row = Self.rows[index]
                    row["body"] = .string("Fictional reader body \(index). " + String(repeating: "x", count: 1024))
                    row["bodyHtml"] = .string("")
                    result = .object(["message": row])
                default: throw APIError("Unexpected synthetic operation.")
                }
            }
            let data = try JSONEncoder().encode(result)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
        } catch {
            Self.lock.lock(); Self.unexpected += 1; Self.lock.unlock()
            client?.urlProtocol(self, didFailWithError: APIError("Synthetic request rejected."))
        }
    }
    override func stopLoading() {}
}

@main
struct MailboxLatency {
    @MainActor static func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw APIError(message) }
    }
    @MainActor static func views<T: NSView>(_ root: NSView, _ type: T.Type) -> [T] {
        (root as? T).map { [$0] } ?? root.subviews.flatMap { views($0, type) }
    }
    @MainActor static func table(_ host: NSView) -> NSTableView? {
        views(host, NSTableView.self).first { $0.numberOfRows == 50 && $0.frame.width > 250 }
    }
    @MainActor static func wait(_ message: String, _ condition: () -> Bool) async throws {
        let end = ProcessInfo.processInfo.systemUptime + 10
        while !condition(), ProcessInfo.processInfo.systemUptime < end { try await Task.sleep(nanoseconds: 1_000_000) }
        try require(condition(), message)
    }
    @MainActor static func visibleFrame(_ view: NSView) -> NSRect? {
        guard let window = view.window, window.isVisible, let screen = window.screen,
              !view.isHiddenOrHasHiddenAncestor else { return nil }
        var ancestor: NSView? = view
        while let current = ancestor {
            if current.alphaValue <= 0 || current.isAccessibilityHidden() { return nil }
            ancestor = current.superview
        }
        let local = view.visibleRect.intersection(view.bounds)
        guard !local.isEmpty else { return nil }
        let frame = window.convertToScreen(view.convert(local, to: nil)).intersection(screen.visibleFrame)
        guard [frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite),
              !frame.isEmpty else { return nil }
        return frame
    }
    @MainActor static func visibleCellFrame(_ cell: NSCell, in root: NSView, window: NSWindow, clip: NSRect) -> NSRect? {
        // AX may flatten a cell past its native control. That cell must not
        // bypass the control's actual owner, window or ancestor visibility.
        guard let control = cell.controlView, control.window === window,
              control === root || control.isDescendant(of: root),
              let frame = visibleFrame(control) else { return nil }
        let visible = clip.intersection(frame)
        return visible.isEmpty ? nil : visible
    }
    @MainActor static func visibleText(_ root: NSView, observe: ((NSObject, String, String) -> Void)? = nil) -> [String] {
        guard let boundary = visibleFrame(root), let window = root.window else { return [] }
        var remaining = 2048, seen = Set<ObjectIdentifier>(), text: [String] = []
        @MainActor func append(_ value: String, from object: NSObject, channel: String) {
            text.append(value); observe?(object, channel, value)
        }
        @MainActor func visit(_ raw: Any, clip: NSRect) {
            guard remaining > 0, let object = raw as? NSObject,
                  seen.insert(ObjectIdentifier(object)).inserted else { return }
            remaining -= 1
            var visible = clip
            if let view = object as? NSView {
                guard view.window === window, view === root || view.isDescendant(of: root),
                      let frame = visibleFrame(view) else { return }
                visible = clip.intersection(frame)
                guard !visible.isEmpty else { return }
                if let field = view as? NSTextField {
                    append(field.stringValue, from: object, channel: "native-value")
                    // This mounted native text leaf already passed the view
                    // visibility/ownership checks above. Its label need not
                    // be exposed again by a separate AX text peer.
                    if let label = field.accessibilityLabel() { append(label, from: object, channel: "native-label") }
                }
                if let field = view as? NSTextView { append(field.string, from: object, channel: "native-value") }
            }
            if let cell = object as? NSCell {
                guard let frame = visibleCellFrame(cell, in: root, window: window, clip: visible) else { return }
                visible = frame
            }
            if let element = object as? NSAccessibilityProtocol {
                guard !element.isAccessibilityHidden() else { return }
                let frame = element.accessibilityFrame()
                let framed = [frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite)
                    && !frame.isEmpty
                if framed {
                    visible = visible.intersection(frame)
                    guard !visible.isEmpty else { return }
                }
                // A container's aggregated label can include a hidden/stale
                // child. Only framed text leaves supply identity evidence.
                if framed, let role = element.accessibilityRole(),
                   [NSAccessibility.Role.staticText, .textField, .textArea].contains(role) {
                    if let value = element.accessibilityValue() as? String { append(value, from: object, channel: "ax-value") }
                    if let label = element.accessibilityLabel() { append(label, from: object, channel: "ax-label") }
                }
                for child in element.accessibilityChildren() ?? [] { visit(child, clip: visible) }
            }
            if let view = object as? NSView {
                for child in view.subviews { visit(child, clip: visible) }
            }
        }
        visit(root, clip: boundary)
        return text
    }
    @MainActor static func rowIdentityMatches(_ cell: NSView, index: Int) -> Bool {
        let text = visibleText(cell)
        let owner = MailboxLatencyProtocol.owners[index % 2]
        return text.contains("Fictional mailbox row \(index) 中文")
            && (text.contains(owner) || text.contains("Mailbox: " + owner))
    }
    @MainActor static func syntheticLabelDiagnostic(_ field: NSTextField, in root: NSView, expected: String, recognized: Bool?) {
        // Fixed booleans and an allowlisted role only: no UI/mail text, class
        // names, arbitrary errors or hierarchy dump enter the failure log.
        let element = field as? NSAccessibilityProtocol
        let nativeFrame = visibleFrame(field), rootFrame = visibleFrame(root)
        let axFrame = element?.accessibilityFrame()
        let finite = axFrame.map { [$0.minX, $0.minY, $0.width, $0.height].allSatisfy(\.isFinite) } ?? false
        let axRole = element?.accessibilityRole()
        let role = axRole == .staticText ? "staticText" : axRole == .textField ? "textField"
            : axRole == .textArea ? "textArea" : axRole == .group ? "group" : axRole == nil ? "nil" : "other"
        var intersects = false
        if finite, let axFrame, let nativeFrame, let rootFrame {
            intersects = !axFrame.intersection(nativeFrame).intersection(rootFrame).isEmpty
        }
        let record: JSON = .object([
            "phase": .string("synthetic-label-only"), "recognized": recognized.map(JSON.bool) ?? .null,
            "nativeWindowMatches": .bool(field.window != nil && field.window === root.window),
            "nativeDescendant": .bool(field.isDescendant(of: root)),
            "nativeVisible": .bool(nativeFrame != nil), "rootVisible": .bool(rootFrame != nil),
            "nativeValueEmpty": .bool(field.stringValue.isEmpty),
            "nativeLabelMatches": .bool(field.accessibilityLabel() == expected),
            "axProtocol": .bool(element != nil), "axHidden": element.map { .bool($0.isAccessibilityHidden()) } ?? .null,
            "axFrameFinite": axFrame == nil ? .null : .bool(finite),
            "axFrameNonempty": axFrame.map { .bool(!$0.isEmpty) } ?? .null,
            "axIntersectsNativeClip": axFrame == nil || nativeFrame == nil || rootFrame == nil ? .null : .bool(intersects),
            "axRole": element == nil ? .null : .string(role),
            "axLabelMatches": element.map { .bool($0.accessibilityLabel() == expected) } ?? .null])
        guard let data = try? JSONEncoder().encode(record), data.count <= 2048 else {
            FileHandle.standardError.write(Data("Native mailbox synthetic-label failure diagnostic unavailable.\n".utf8))
            return
        }
        FileHandle.standardError.write(Data("Native mailbox synthetic-label failure diagnostic: ".utf8))
        FileHandle.standardError.write(data)
        FileHandle.standardError.write(Data("\n".utf8))
    }
    @MainActor static func syntheticHiddenDiagnostic(_ body: NSTextField, in root: NSView, recognized: Bool?) {
        // Only fixed channel/kind names and boolean/null observations leave
        // this synthetic check. No text, paths, class names or object IDs.
        var accepted: [JSON] = [], matched = 0
        _ = visibleText(root) { object, channel, value in
            guard value.hasPrefix("Fictional reader body 1. ") else { return }
            matched += 1
            guard accepted.count < 4 else { return }
            let cell = object as? NSCell, view = object as? NSView
            let control = cell?.controlView, element = object as? NSAccessibilityProtocol
            accepted.append(.object([
                "channel": .string(channel), "kind": .string(cell != nil ? "cell" : view != nil ? "view" : "ax-peer"),
                "isBody": .bool(object === body), "cellOwnsBody": cell == nil ? .null : .bool(control === body),
                "nativeHidden": view.map { .bool($0.isAccessibilityHidden()) } ?? .null,
                "axHidden": element.map { .bool($0.isAccessibilityHidden()) } ?? .null,
                "cellHasOwner": cell == nil ? .null : .bool(control != nil),
                "cellOwnerVisible": control.map { .bool(visibleFrame($0) != nil) } ?? .null,
                "cellOwnerInRoot": control.map { .bool($0 === root || $0.isDescendant(of: root)) } ?? .null,
                "cellOwnerWindowMatches": control.map { .bool($0.window != nil && $0.window === root.window) } ?? .null]))
        }
        let cell = body.cell
        let record: JSON = .object([
            "phase": .string("synthetic-accessibility-hidden"), "recognized": recognized.map(JSON.bool) ?? .null,
            "bodyHidden": .bool(body.isAccessibilityHidden()), "bodyVisible": .bool(visibleFrame(body) != nil),
            "rootVisible": .bool(visibleFrame(root) != nil),
            "bodyCellOwnsBody": cell == nil ? .null : .bool(cell?.controlView === body),
            "bodyCellHidden": cell.map { .bool($0.isAccessibilityHidden()) } ?? .null,
            "matchedCount": .number(Double(matched)), "accepted": .array(accepted)])
        guard let data = try? JSONEncoder().encode(record), data.count <= 2048 else {
            FileHandle.standardError.write(Data("Native mailbox synthetic-hidden failure diagnostic unavailable.\n".utf8))
            return
        }
        FileHandle.standardError.write(Data("Native mailbox synthetic-hidden failure diagnostic: ".utf8))
        FileHandle.standardError.write(data)
        FileHandle.standardError.write(Data("\n".utf8))
    }
    @MainActor static func readerIdentityMatches(_ reader: NSView, index: Int) -> Bool {
        let text = visibleText(reader)
        return text.contains("Fictional mailbox row \(index) 中文")
            && text.contains("To: " + MailboxLatencyProtocol.owners[index % 2])
            && text.contains { $0.hasPrefix("Fictional reader body \(index). ") }
    }
    @MainActor static func readerPane(for list: NSTableView) -> NSView? {
        // Locate the actual reader sibling of the production mail-list pane,
        // never a matching string anywhere in the host or the AppModel payload.
        var parent = list.superview
        while let current = parent {
            if let split = current as? NSSplitView, split.isVertical,
               split.arrangedSubviews.count == 2,
               list.isDescendant(of: split.arrangedSubviews[0]),
               !list.isDescendant(of: split.arrangedSubviews[1]),
               let left = visibleFrame(split.arrangedSubviews[0]),
               let right = visibleFrame(split.arrangedSubviews[1]),
               right.minX >= left.maxX - 1, right.width >= 250 {
                return split.arrangedSubviews[1]
            }
            parent = current.superview
        }
        return nil
    }
    @MainActor static func displayed(_ host: NSView, page: Int, readerIndex: Int? = nil) -> Bool {
        host.layoutSubtreeIfNeeded(); host.displayIfNeeded()
        guard let list = table(host), visibleFrame(list) != nil,
              list.rows(in: list.visibleRect).length > 0,
              let first = list.view(atColumn: 0, row: 0, makeIfNecessary: false),
              rowIdentityMatches(first, index: page * 50) else { return false }
        if let readerIndex {
            guard list.selectedRowIndexes.contains(readerIndex),
                  let selected = list.view(atColumn: 0, row: readerIndex, makeIfNecessary: false),
                  rowIdentityMatches(selected, index: page * 50 + readerIndex),
                  let reader = readerPane(for: list),
                  readerIdentityMatches(reader, index: page * 50 + readerIndex) else { return false }
        }
        return true
    }
    @MainActor static func initialPageDiagnostic(_ size: Int, host: NSView, model: AppModel) {
        // Observe only this failed fictional fixture. Never emit text values,
        // identifiers, paths, class names or an accessibility hierarchy.
        func count(_ value: Int) -> JSON { .number(Double(max(0, min(value, 1_000_000)))) }
        var inspected = 0, scanTruncated = false, tables: [NSTableView] = []
        @MainActor func collect(_ view: NSView, depth: Int = 0) {
            guard inspected < 512, depth < 64 else { scanTruncated = true; return }
            inspected += 1
            if let list = view as? NSTableView { tables.append(list); return }
            for child in view.subviews { collect(child, depth: depth + 1) }
        }
        collect(host)
        let selected = table(host), observed = MailboxLatencyProtocol.snapshot()
        let subject = "Fictional mailbox row 0 中文", owner = MailboxLatencyProtocol.owners[0]
        let reported = selected.map { selected in [selected] + Array(tables.filter { $0 !== selected }.prefix(1)) }
            ?? Array(tables.prefix(2))
        let candidates: [JSON] = reported.enumerated().map { index, list in
            let width = list.frame.width
            if index > 0 {
                return .object(["rows": count(list.numberOfRows),
                    "width": width.isFinite && abs(width) <= 10_000_000 ? .number(Double(width)) : .null,
                    "qualifies": .bool(list.numberOfRows == 50 && width > 250)])
            }
            let row = list.numberOfRows > 0 && list.numberOfColumns > 0
                ? list.view(atColumn: 0, row: 0, makeIfNecessary: false) : nil
            var textCount = 0, axCount = 0, unbacked = 0, foreignOwner = false
            var subjectExact = false, subjectContained = false, ownerExact = false, ownerContained = false
            var axSubjectExact = false, axSubjectContained = false, axOwnerExact = false, axOwnerContained = false
            var roles = Set<String>()
            if let row {
                _ = visibleText(row) { object, channel, value in
                    textCount += 1
                    let exactOwner = value == owner || value == "Mailbox: " + owner
                    subjectExact = subjectExact || value == subject; subjectContained = subjectContained || value.contains(subject)
                    ownerExact = ownerExact || exactOwner; ownerContained = ownerContained || value.contains(owner)
                    if channel == "ax-value" || channel == "ax-label" {
                        axCount += 1
                        axSubjectExact = axSubjectExact || value == subject; axSubjectContained = axSubjectContained || value.contains(subject)
                        axOwnerExact = axOwnerExact || exactOwner; axOwnerContained = axOwnerContained || value.contains(owner)
                    }
                    let role = (object as? NSAccessibilityProtocol)?.accessibilityRole()
                    roles.insert(role == .staticText ? "staticText" : role == .textField ? "textField"
                        : role == .textArea ? "textArea" : role == .group ? "group" : role == nil ? "none" : "other")
                    if let control = (object as? NSView) ?? (object as? NSCell)?.controlView {
                        foreignOwner = foreignOwner || control.window !== host.window
                            || !(control === row || control.isDescendant(of: row))
                    } else { unbacked += 1 }
                }
            }
            var rawNodes = 0, cells = 0, noOwner = 0, foreign = 0, hidden = 0, invisible = 0, foreignViews = 0, leaves = 0
            var rawOwned = false, rawTruncated = false, rawSubjectExact = false, rawSubjectContained = false
            var rawOwnerExact = false, rawOwnerContained = false, seen = Set<ObjectIdentifier>()
            if let row, host.window != nil, list.window === host.window, list.isDescendant(of: host),
               row.window === host.window, row.isDescendant(of: list) {
                rawOwned = true
                // Raw AX candidates explain rejections; none enter visibleText
                // or any acceptance predicate. Never follow controlView as a child.
                @MainActor func rawVisit(_ value: Any, depth: Int) {
                    guard let object = value as? NSObject else { return }
                    let identity = ObjectIdentifier(object)
                    if seen.contains(identity) { return }
                    guard rawNodes < 256, depth < 16 else { rawTruncated = true; return }
                    seen.insert(identity); rawNodes += 1
                    if let view = object as? NSView, view !== row,
                       view.window !== host.window || !view.isDescendant(of: row) { foreignViews += 1; return }
                    if let cell = object as? NSCell {
                        cells += 1
                        if let control = cell.controlView {
                            if control.window !== host.window || !(control === row || control.isDescendant(of: row)) { foreign += 1 }
                            if control.isHiddenOrHasHiddenAncestor || control.isAccessibilityHidden() { hidden += 1 }
                            if visibleFrame(control) == nil { invisible += 1 }
                        } else { noOwner += 1 }
                    }
                    guard let element = object as? NSAccessibilityProtocol else { return }
                    if let role = element.accessibilityRole(), [NSAccessibility.Role.staticText, .textField, .textArea].contains(role) {
                        leaves += 1
                        for value in [element.accessibilityValue() as? String, element.accessibilityLabel()].compactMap({ $0 }) {
                            rawSubjectExact = rawSubjectExact || value == subject; rawSubjectContained = rawSubjectContained || value.contains(subject)
                            rawOwnerExact = rawOwnerExact || value == owner || value == "Mailbox: " + owner
                            rawOwnerContained = rawOwnerContained || value.contains(owner)
                        }
                    }
                    let children = element.accessibilityChildren() ?? []
                    if children.count > 256 { rawTruncated = true }
                    for child in children.prefix(256) { rawVisit(child, depth: depth + 1) }
                }
                rawVisit(row, depth: 0)
            }
            return .object([
                "rows": count(list.numberOfRows), "width": width.isFinite && abs(width) <= 10_000_000 ? .number(Double(width)) : .null,
                "visible": .bool(visibleFrame(list) != nil), "ownWindow": .bool(list.window != nil && list.window === host.window),
                "qualifies": .bool(list.numberOfRows == 50 && width > 250), "selected": .bool(list === selected),
                "visibleRows": count(list.rows(in: list.visibleRect).length), "row0": .bool(row != nil),
                "row0Visible": .bool(row.map { visibleFrame($0) != nil } ?? false),
                "subjectExact": .bool(subjectExact), "subjectContained": .bool(subjectContained),
                "ownerExact": .bool(ownerExact), "ownerContained": .bool(ownerContained),
                "axSubjectExact": .bool(axSubjectExact), "axSubjectContained": .bool(axSubjectContained),
                "axOwnerExact": .bool(axOwnerExact), "axOwnerContained": .bool(axOwnerContained),
                "textCount": count(textCount), "axTextCount": count(axCount), "unbackedTextCount": count(unbacked),
                "foreignOwner": .bool(foreignOwner),
                "raw": .object(["rowOwned": .bool(rawOwned), "nodes": count(rawNodes), "truncated": .bool(rawTruncated),
                    "cells": count(cells), "noOwner": count(noOwner), "foreignOwner": count(foreign),
                    "hiddenOwner": count(hidden), "invisibleOwner": count(invisible), "foreignViews": count(foreignViews),
                    "textLeaves": count(leaves), "subjectExact": .bool(rawSubjectExact), "subjectContained": .bool(rawSubjectContained),
                    "ownerExact": .bool(rawOwnerExact), "ownerContained": .bool(rawOwnerContained)]),
                "roles": .array(["staticText", "textField", "textArea", "group", "none", "other"].filter { roles.contains($0) }.map(JSON.string))])
        }
        let record: JSON = .object([
            "phase": .string("initial-page"), "size": [1000, 10000, 50000].contains(size) ? .number(Double(size)) : .null,
            "listed": count(model.listedMessages.count), "mailLoading": .bool(model.mailLoading),
            "generated": count(observed.0), "unexpected": count(observed.1), "requests": count(observed.2),
            "hasMailbox": .bool(model.hasMailbox), "combined": .bool(model.combined), "inbox": .bool(model.section == "inbox"),
            "starting": .bool(model.starting), "hasError": .bool(!model.error.isEmpty), "connected": .bool(model.baseURL != nil),
            "searchActive": .bool(!model.searchResponse.isNull), "hostVisible": .bool(visibleFrame(host) != nil),
            "windowVisible": .bool(host.window?.isVisible == true), "hasScreen": .bool(host.window?.screen != nil),
            "tableCount": count(tables.count), "tablesTruncated": .bool(tables.count > 2),
            "scanTruncated": .bool(scanTruncated), "tables": .array(candidates)])
        let prefix = Data("Native mailbox initial-page failure diagnostic: ".utf8)
        guard let data = try? JSONEncoder().encode(record), prefix.count + data.count + 1 <= 2048 else {
            FileHandle.standardError.write(Data("Native mailbox initial-page failure diagnostic: {\"phase\":\"initial-page\",\"diagnosticComplete\":false}\n".utf8))
            return
        }
        FileHandle.standardError.write(prefix); FileHandle.standardError.write(data)
        FileHandle.standardError.write(Data("\n".utf8))
    }
    @MainActor static func pageButton(_ host: NSView, next: Bool) throws -> NSButton {
        guard let list = table(host), let viewport = list.enclosingScrollView else { throw APIError("Production mail table is missing.") }
        let frame = viewport.convert(viewport.bounds, to: nil)
        // SwiftUI's in-process peers do not always expose AX titles. Pin the
        // actual pagination row immediately below the mounted mail viewport,
        // require exactly two peers, then verify the resulting page and IDs.
        let below = views(host, NSButton.self).filter { button in
            let bounds = button.convert(button.bounds, to: nil)
            return bounds.midX >= frame.minX && bounds.midX <= frame.maxX
                && bounds.midY < frame.minY && bounds.midY > frame.minY - 80
        }
        guard let highest = below.map({ $0.convert($0.bounds, to: nil).midY }).max() else { throw APIError("Pagination peers are missing.") }
        let buttons = below.filter { abs($0.convert($0.bounds, to: nil).midY - highest) < 4 }
            .sorted { $0.convert($0.bounds, to: nil).midX < $1.convert($1.bounds, to: nil).midX }
        try require(buttons.count == 2, "Pagination layout changed; measurement stopped.")
        let button = buttons[next ? 1 : 0]
        try require(button.isEnabled && button.window === host.window, "Pagination action is unavailable.")
        return button
    }
    @MainActor static func clickRow(_ row: Int, list: NSTableView, window: NSWindow) throws {
        let rect = list.rect(ofRow: row), point = list.convert(NSPoint(x: rect.midX, y: rect.midY), to: nil)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            guard let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: row, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0) else {
                throw APIError("Could not create the native selection event.")
            }
            NSApp.postEvent(event, atStart: false)
        }
        // Drain only our posted mouse events; AppKit's tracking loop may consume
        // the matching mouse-up during sendEvent. Async waits below let the
        // production selection binding and owned reader request complete.
        while let event = NSApp.nextEvent(matching: [.leftMouseDown, .leftMouseUp], until: Date(), inMode: .default, dequeue: true) {
            NSApp.sendEvent(event)
        }
    }
    @MainActor static func sample(_ action: String, start: TimeInterval, page: Int, host: NSView, model: AppModel, readerIndex: Int? = nil) throws -> JSON {
        try require(displayed(host, page: page, readerIndex: readerIndex), "The measured owned row/reader text is not displayed.")
        let list = table(host)!, visible = list.rows(in: list.visibleRect)
        let rows = model.listedMessages
        try require(rows.count == 50 && model.mailCursors.count == page + 1, "Displayed page does not match the action.")
        try require(rows.first?.id == "imap:55:\(page * 25 + 1)" && rows.first?["accountId"].string == MailboxLatencyProtocol.owners[0], "Wrong displayed owner/identity page.")
        return .object(["action": .string(action), "completion": .string("layout-and-display"),
            "elapsedMs": .number((ProcessInfo.processInfo.systemUptime - start) * 1000),
            "page": .number(Double(page)), "tableRows": .number(Double(list.numberOfRows)),
            "visibleRows": .number(Double(min(50, visible.length))), "ownerMatched": .bool(true),
            "renderedRowIdentityMatched": .bool(true), "renderedReaderMatched": .bool(readerIndex != nil),
            "renderedSelectedRowIdentityMatched": .bool(readerIndex != nil), "renderedReaderIdentityMatched": .bool(readerIndex != nil),
            "selectedOwnedRow": .bool(model.current != nil)])
    }
    @MainActor private final class SyntheticOracleWindow: NSWindow {
        // Permit the explicit offscreen negative only. Normal synthetic setup
        // and restoration retain AppKit's constraints; dataset windows use NSWindow.
        var permitsOffscreenFrame = false
        override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
            permitsOffscreenFrame ? frameRect : super.constrainFrameRect(frameRect, to: screen)
        }
    }
    @MainActor static func syntheticWindowDiagnostic(_ window: NSWindow, expected: NSRect, restoring: Bool) {
        // Fixed geometry/boolean fields only; never content, paths or object IDs.
        func frame(_ rect: NSRect) -> JSON {
            .array([rect.minX, rect.minY, rect.width, rect.height].map {
                $0.isFinite && abs($0) <= 10_000_000 ? .number(Double($0)) : .null
            })
        }
        let record: JSON = .object([
            "phase": .string(restoring ? "synthetic-window-restored" : "synthetic-window-offscreen"),
            "expectedFrame": frame(expected), "actualFrame": frame(window.frame),
            "frameMatchesExpected": .bool(window.frame == expected), "windowVisible": .bool(window.isVisible),
            "hasDisplays": .bool(!NSScreen.screens.isEmpty),
            "intersectsDisplay": .bool(NSScreen.screens.contains { $0.frame.intersects(window.frame) })])
        guard let data = try? JSONEncoder().encode(record), data.count <= 1024 else { return }
        FileHandle.standardError.write(Data("Native mailbox synthetic-window failure diagnostic: ".utf8))
        FileHandle.standardError.write(data)
        FileHandle.standardError.write(Data("\n".utf8))
    }
    @MainActor static func checkVisibleIdentityOracle() throws -> JSON {
        // Exercise the same oracle against real mounted AppKit text controls.
        // These are rejection controls, not latency or production UI samples.
        let window = SyntheticOracleWindow(contentRect: NSRect(x: 50, y: 50, width: 700, height: 480),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSView(frame: NSRect(x: 0, y: 0, width: 700, height: 480))
        let row = NSView(frame: NSRect(x: 0, y: 300, width: 310, height: 120))
        let reader = NSView(frame: NSRect(x: 330, y: 0, width: 340, height: 460))
        host.addSubview(row); host.addSubview(reader)
        @MainActor func label(_ value: String, _ y: CGFloat, in parent: NSView) -> NSTextField {
            let field = NSTextField(labelWithString: value)
            field.frame = NSRect(x: 10, y: y, width: 310, height: 35)
            parent.addSubview(field)
            return field
        }
        let subject = "Fictional mailbox row 1 中文", owner = MailboxLatencyProtocol.owners[1]
        _ = label(subject, 65, in: row)
        let rowOwner = label(owner, 20, in: row)
        let readerSubject = label(subject, 390, in: reader)
        let readerOwner = label("To: " + owner, 340, in: reader)
        let body = label("Fictional reader body 1. visible control", 270, in: reader)
        let labeledContainer = NSView(frame: NSRect(x: 0, y: 130, width: 310, height: 120))
        labeledContainer.setAccessibilityElement(true)
        labeledContainer.setAccessibilityRole(.group)
        labeledContainer.setAccessibilityLabel("Mailbox: " + owner)
        _ = label(subject, 65, in: labeledContainer)
        _ = label(MailboxLatencyProtocol.owners[0], 20, in: labeledContainer)
        host.addSubview(labeledContainer)
        window.contentView = host; window.makeKeyAndOrderFront(nil)
        defer { window.close(); window.contentView = nil }
        host.layoutSubtreeIfNeeded(); host.displayIfNeeded()
        try require(rowIdentityMatches(row, index: 1) && readerIdentityMatches(reader, index: 1),
            "Visible identity oracle positive control failed.")
        guard let bodyCell = body.cell, let readerClip = visibleFrame(reader) else {
            throw APIError("Native cell-owner positive control is unavailable.")
        }
        try require(bodyCell.controlView === body
            && visibleCellFrame(bodyCell, in: reader, window: window, clip: readerClip) != nil,
            "Visible native cell-owner positive control failed.")
        // This synthetic native field checks label-only evidence. The actual
        // production SwiftUI row/reader is checked separately in dataset().
        rowOwner.stringValue = ""; rowOwner.setAccessibilityLabel("Mailbox: " + owner)
        let labelMatches = rowOwner.accessibilityLabel() == "Mailbox: " + owner
        let fieldVisible = visibleFrame(rowOwner) != nil
        if !labelMatches || !fieldVisible {
            syntheticLabelDiagnostic(rowOwner, in: row, expected: "Mailbox: " + owner, recognized: nil)
        }
        try require(labelMatches, "Synthetic label-only control did not retain its accessibility label.")
        try require(fieldVisible, "Synthetic label-only control is not visibly mounted.")
        let labelRecognized = rowIdentityMatches(row, index: 1)
        if !labelRecognized {
            syntheticLabelDiagnostic(rowOwner, in: row, expected: "Mailbox: " + owner, recognized: false)
        }
        try require(labelRecognized, "Synthetic label-only mailbox identity was not recognized.")
        rowOwner.setAccessibilityLabel("Mailbox: " + MailboxLatencyProtocol.owners[0])
        try require(!rowIdentityMatches(row, index: 1), "Wrong selected-row accessibility owner passed the oracle.")
        try require(visibleFrame(labeledContainer) != nil && labeledContainer.accessibilityRole() == .group
            && labeledContainer.accessibilityLabel() == "Mailbox: " + owner
            && visibleText(labeledContainer).contains(subject), "Container-label negative control did not mount.")
        try require(!rowIdentityMatches(labeledContainer, index: 1), "Container label passed the row identity oracle.")
        labeledContainer.removeFromSuperview()
        rowOwner.stringValue = MailboxLatencyProtocol.owners[0]
        rowOwner.setAccessibilityLabel(MailboxLatencyProtocol.owners[0])
        try require(!rowIdentityMatches(row, index: 1), "Wrong selected-row owner passed the oracle.")
        rowOwner.stringValue = owner; rowOwner.setAccessibilityLabel(owner)
        readerOwner.stringValue = "To: " + MailboxLatencyProtocol.owners[0]
        try require(!readerIdentityMatches(reader, index: 1), "Wrong reader owner passed with the right body.")
        readerOwner.stringValue = "To: " + owner
        readerSubject.stringValue = "Fictional mailbox row 0 中文"
        try require(!readerIdentityMatches(reader, index: 1), "Wrong reader subject passed with the right body.")
        readerSubject.stringValue = subject
        body.isHidden = true
        try require(visibleCellFrame(bodyCell, in: reader, window: window, clip: readerClip) == nil,
            "Hidden native cell owner passed the visibility guard.")
        try require(!readerIdentityMatches(reader, index: 1), "Hidden body passed the oracle.")
        let stale = label("Fictional reader body 1. stale outside reader", 180, in: host)
        try require(visibleText(host).contains { $0.hasPrefix("Fictional reader body 1. ") },
            "Outside-reader stale-body negative control did not mount.")
        try require(!readerIdentityMatches(reader, index: 1), "Outside-reader body passed the reader oracle.")
        guard let staleCell = stale.cell else { throw APIError("Foreign cell-owner control is unavailable.") }
        try require(staleCell.controlView === stale && visibleFrame(stale) != nil,
            "Foreign cell-owner negative control did not mount.")
        try require(visibleCellFrame(staleCell, in: reader, window: window, clip: readerClip) == nil,
            "A cell owned outside the reader passed the visibility guard.")
        do {
            let other = NSWindow(contentRect: NSRect(x: 70, y: 70, width: 340, height: 160),
                styleMask: [.titled], backing: .buffered, defer: false)
            other.isReleasedWhenClosed = false
            let otherRoot = NSView(frame: NSRect(x: 0, y: 0, width: 340, height: 160))
            let otherBody = label("Fictional reader body 1. other window", 60, in: otherRoot)
            other.contentView = otherRoot; other.makeKeyAndOrderFront(nil)
            defer { other.close(); other.contentView = nil }
            otherRoot.layoutSubtreeIfNeeded(); otherRoot.displayIfNeeded()
            guard let otherCell = otherBody.cell, let otherClip = visibleFrame(otherRoot) else {
                throw APIError("Foreign-window cell-owner control is unavailable.")
            }
            try require(otherCell.controlView === otherBody
                && visibleCellFrame(otherCell, in: otherRoot, window: other, clip: otherClip) != nil,
                "Foreign-window cell-owner positive control did not mount.")
            try require(visibleCellFrame(otherCell, in: otherRoot, window: window, clip: otherClip) == nil,
                "A cell from another window passed the visibility guard.")
        }
        stale.removeFromSuperview(); body.isHidden = false
        let frame = body.frame; body.setFrameOrigin(NSPoint(x: 900, y: 270))
        try require(!readerIdentityMatches(reader, index: 1), "Offscreen body passed the oracle.")
        body.frame = frame; reader.isHidden = true
        try require(!readerIdentityMatches(reader, index: 1), "Hidden ancestor passed the oracle.")
        reader.isHidden = false; reader.alphaValue = 0
        try require(!readerIdentityMatches(reader, index: 1), "Transparent ancestor passed the oracle.")
        reader.alphaValue = 1; body.setAccessibilityHidden(true)
        let hidden = body.isAccessibilityHidden()
        if !hidden { syntheticHiddenDiagnostic(body, in: reader, recognized: nil) }
        try require(hidden, "Synthetic accessibility-hidden control did not retain its hidden state.")
        let hiddenRecognized = readerIdentityMatches(reader, index: 1)
        if hiddenRecognized { syntheticHiddenDiagnostic(body, in: reader, recognized: true) }
        try require(visibleCellFrame(bodyCell, in: reader, window: window, clip: readerClip) == nil,
            "Accessibility-hidden native cell owner passed the visibility guard.")
        try require(!hiddenRecognized, "Accessibility-hidden body passed the oracle.")
        body.setAccessibilityHidden(false)
        try require(!body.isAccessibilityHidden(), "Synthetic accessibility-hidden control did not restore its state.")
        let originalFrame = window.frame
        let outsideX = (NSScreen.screens.map { $0.frame.maxX }.max() ?? originalFrame.maxX) + 2000
        let outsideY = (NSScreen.screens.map { $0.frame.maxY }.max() ?? originalFrame.maxY) + 2000
        let offscreenFrame = NSRect(origin: NSPoint(x: outsideX, y: outsideY), size: originalFrame.size)
        do {
            window.permitsOffscreenFrame = true
            defer {
                window.permitsOffscreenFrame = false
                window.setFrame(originalFrame, display: true)
            }
            window.setFrameOrigin(offscreenFrame.origin)
            let outsideDisplays = NSScreen.screens.allSatisfy { !$0.frame.intersects(window.frame) }
            let placed = window.frame == offscreenFrame
            let mounted = window.isVisible && window.contentView === host && row.window === window && reader.window === window
            if NSScreen.screens.isEmpty || !outsideDisplays || !placed || !mounted {
                syntheticWindowDiagnostic(window, expected: offscreenFrame, restoring: false)
            }
            try require(!NSScreen.screens.isEmpty && mounted, "Offscreen-window negative control lost its visible native window.")
            try require(placed, "Offscreen-window negative control did not retain its requested native frame.")
            try require(outsideDisplays, "Offscreen-window negative control did not move beyond the displays.")
            try require(!readerIdentityMatches(reader, index: 1), "Offscreen window passed the oracle.")
        }
        let restored = window.frame == originalFrame && window.isVisible && window.contentView === host
            && row.window === window && reader.window === window
        if !restored { syntheticWindowDiagnostic(window, expected: originalFrame, restoring: true) }
        try require(restored, "Offscreen-window negative control did not restore its native window.")
        try require(rowIdentityMatches(row, index: 1) && readerIdentityMatches(reader, index: 1),
            "Restored visible identity oracle failed.")
        return .object(["cellHiddenOwnerRejected": .bool(true), "cellForeignOwnerRejected": .bool(true),
            "cellForeignWindowRejected": .bool(true), "containerLabelRejected": .bool(true),
            "wrongSelectedOwnerRejected": .bool(true), "wrongReaderOwnerRejected": .bool(true),
            "wrongReaderSubjectRejected": .bool(true), "hiddenBodyRejected": .bool(true),
            "outsideReaderBodyRejected": .bool(true), "offscreenBodyRejected": .bool(true),
            "hiddenAncestorRejected": .bool(true), "transparentAncestorRejected": .bool(true),
            "accessibilityHiddenBodyRejected": .bool(true), "offscreenWindowRejected": .bool(true)])
    }
    @MainActor static func dataset(_ size: Int) async throws -> JSON {
        MailboxLatencyProtocol.prepare(size)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [MailboxLatencyProtocol.self]
        let model = AppModel(session: URLSession(configuration: config))
        model.state = MailboxLatencyProtocol.state(); model.starting = false
        let window = NSWindow(contentRect: NSRect(x: 50, y: 50, width: 1220, height: 820), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: MailWorkspace().environmentObject(model))
        window.contentView = host; window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        defer { window.close(); window.contentView = nil; model.stop(); model.session.invalidateAndCancel() }
        do {
            try await wait("Initial owned native page did not mount.") { model.listedMessages.count == 50 && !model.mailLoading && displayed(host, page: 0) }
        } catch {
            initialPageDiagnostic(size, host: host, model: model)
            throw error
        }
        var samples: [JSON] = []
        for index in 0..<6 {
            let next = try pageButton(host, next: true), startNext = ProcessInfo.processInfo.systemUptime
            next.performClick(nil)
            try await wait("Next did not render page two.") { model.mailCursors.count == 2 && !model.mailLoading && displayed(host, page: 1) }
            samples.append(try sample("next", start: startNext, page: 1, host: host, model: model))
            let previous = try pageButton(host, next: false), startPrevious = ProcessInfo.processInfo.systemUptime
            previous.performClick(nil)
            try await wait("Previous did not render page one.") { model.mailCursors.count == 1 && !model.mailLoading && displayed(host, page: 0) }
            samples.append(try sample("previous", start: startPrevious, page: 0, host: host, model: model))
            let selected = model.listedMessages[index % 2], startSelect = ProcessInfo.processInfo.systemUptime
            try clickRow(index % 2, list: table(host)!, window: window)
            try await wait("Native row selection did not load its owned reader.") {
                model.selectedMessage == selected.viewID && model.messageDetail.viewID == selected.viewID
                    && model.messageDetail["accountId"] == selected["accountId"] && model.messageDetail["body"].nonempty
                    && table(host)?.selectedRowIndexes.contains(index % 2) == true
                    && displayed(host, page: 0, readerIndex: index % 2)
            }
            samples.append(try sample("select", start: startSelect, page: 0, host: host, model: model, readerIndex: index % 2))
        }
        await model.publishSyncPriority()
        let observed = MailboxLatencyProtocol.snapshot()
        try require(observed.0 == size && observed.1 == 0, "Unexpected transport request or dataset count.")
        return .object(["size": .number(Double(size)), "generatedRows": .number(Double(observed.0)), "pageSize": .number(50),
            "unexpectedRequests": .number(Double(observed.1)), "interceptedRequests": .number(Double(observed.2)),
            "ownerSelectionVerified": .bool(true), "samples": .array(samples)])
    }
    @MainActor static func main() async {
        do {
            let arguments = CommandLine.arguments
            guard arguments.count == 5, arguments[1] == "--output", arguments[3] == "--version",
                  let workspace = ProcessInfo.processInfo.environment["MORROW_DATA_DIR"], workspace.hasPrefix("/"),
                  !FileManager.default.fileExists(atPath: arguments[2]) else { throw APIError("A new output, version and isolated fixture workspace are required.") }
            NSApplication.shared.setActivationPolicy(.regular)
            UserDefaults.standard.setVolatileDomain(["mailReaderLayout": "right", "mailSidebarVisible": true,
                "collapsedMailAccounts": "[]"], forName: UserDefaults.argumentDomain)
            let oracleControls = try checkVisibleIdentityOracle()
            var results: [JSON] = []
            for size in [1000, 10000, 50000] { results.append(try await dataset(size)) }
            let report: JSON = .object(["schema": .number(1), "kind": .string("morrow-native-mailbox-latency"),
                "status": .string("complete"), "platform": .string("macos"), "version": .string(arguments[4]),
                "measuredAt": .string(ISO8601DateFormatter().string(from: Date())),
                "measurement": .string("native-event-to-layout-display"), "transport": .string("intercepted-fictional-only"),
                "windowWidth": .number(1220), "windowHeight": .number(820), "pollResolutionMs": .number(1),
                "oracleControls": oracleControls, "results": .array(results), "limitations": .string("Production AppKit/SwiftUI buttons, table mouse events and owned reader, intercepted paginated responses. Includes fixture overhead and layout/display request, not compositor presentation, real service/SQLite/WAN cost, HTML reader, whole-app resources or accessibility automation. One first plus five warm samples; no default performance threshold.")])
            let data = try JSONEncoder().encode(report)
            try data.write(to: URL(fileURLWithPath: arguments[2]), options: .withoutOverwriting)
            print("Native mailbox event/layout measurements completed.")
        } catch { FileHandle.standardError.write(Data(("Native mailbox measurement failed: " + error.localizedDescription + "\n").utf8)); exit(1) }
    }
}
