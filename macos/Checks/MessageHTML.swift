import AppKit
import SwiftUI
import WebKit

// Fixture-only telemetry. Every mutable field is protected by lock; the timer
// never reads AppKit/WebKit objects. Logs contain only fixture labels and counts.
private final class ReaderFixtureTrace: @unchecked Sendable {
    struct Operation {
        let id: Int
        let name: String
        let started: TimeInterval
    }
    private let started = ProcessInfo.processInfo.systemUptime
    private let lock = NSLock()
    private var phaseName = "setup"
    private var operationCount = 0
    private var findCount = 0
    private var active: Operation?
    private var lastMainAck = ProcessInfo.processInfo.systemUptime
    private var pendingHeartbeat: TimeInterval?
    private var maxMainAckDelay = 0

    private func milliseconds(_ interval: TimeInterval) -> Int { Int(interval * 1000) }
    private func write(_ message: String) {
        let elapsed = milliseconds(ProcessInfo.processInfo.systemUptime - started)
        // Do not hold the state lock during I/O, including on the timer queue.
        FileHandle.standardError.write(Data("Native macOS reader: \(message) +\(elapsed) ms\n".utf8))
    }
    func phase(_ name: String) {
        lock.lock(); phaseName = name; lock.unlock()
        write(name)
    }
    func event(_ message: String) {
        lock.lock(); let phase = phaseName; lock.unlock()
        write("trace phase=\(phase) \(message)")
    }
    func begin(_ name: String, detail: String = "") -> Operation {
        lock.lock()
        operationCount += 1
        if name == "find" { findCount += 1 }
        let operation = Operation(id: operationCount, name: name, started: ProcessInfo.processInfo.systemUptime)
        active = operation
        let count = findCount
        lock.unlock()
        event("\(name)-begin id=\(operation.id) findCount=\(count) \(detail)")
        return operation
    }
    func end(_ operation: Operation, detail: String = "") {
        let elapsed = milliseconds(ProcessInfo.processInfo.systemUptime - operation.started)
        lock.lock()
        if active?.id == operation.id { active = nil }
        lock.unlock()
        event("\(operation.name)-end id=\(operation.id) durationMs=\(elapsed) \(detail)")
    }
    func summary() {
        lock.lock()
        let operations = operationCount, finds = findCount, delay = maxMainAckDelay
        lock.unlock()
        event("summary operations=\(operations) findCount=\(finds) maxMainAckDelayMs=\(delay)")
    }
    func heartbeat() {
        let now = ProcessInfo.processInfo.systemUptime
        lock.lock()
        let phase = phaseName
        // "none" means between measured calls, not that the main thread is idle.
        let operation = active.map { "\($0.name)#\($0.id) ageMs=\(milliseconds(now - $0.started))" } ?? "none"
        let pendingAge = pendingHeartbeat.map { milliseconds(now - $0) } ?? 0
        let ackAge = milliseconds(now - lastMainAck)
        let maxDelay = maxMainAckDelay
        let count = findCount
        let enqueue = pendingHeartbeat == nil
        if enqueue { pendingHeartbeat = now }
        lock.unlock()
        // A blocked main queue leaves one outstanding probe, never a growing queue.
        if enqueue {
            DispatchQueue.main.async { [self] in
                let acknowledged = ProcessInfo.processInfo.systemUptime
                lock.lock()
                let delay = milliseconds(acknowledged - (pendingHeartbeat ?? acknowledged))
                maxMainAckDelay = max(maxMainAckDelay, delay)
                lastMainAck = acknowledged
                pendingHeartbeat = nil
                lock.unlock()
                if delay >= 250 { event("main-heartbeat-recovered delayMs=\(delay)") }
            }
        }
        write("heartbeat phase=\(phase) active=\(operation) findCount=\(count) mainAckAgeMs=\(ackAge) pendingAgeMs=\(pendingAge) maxAckDelayMs=\(maxDelay)")
    }
}

@MainActor final class ReaderFixtureState: ObservableObject {
    @Published var html: String
    @Published var autoLoadExternalImages = false
    @Published var messageID = "reader-fixture-1"
    init(_ html: String) { self.html = html }
}

struct ReaderFixture: View {
    @ObservedObject var state: ReaderFixtureState
    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Color.clear.frame(height: 20)
                SecureMessageBody(message: .object(["id": .string(state.messageID), "accountId": .string("reader@fixture.invalid"), "body": .string("Fictional plain text"), "bodyHtml": .string(state.html)]), autoLoadExternalImages: state.autoLoadExternalImages)
                Color.clear.frame(height: 800)
            }
        }
    }
}

@main struct MessageHTMLChecks {
    @MainActor static func main() {
        let trace = ReaderFixtureTrace()
        func phase(_ name: String) { trace.phase(name) }
        let heartbeat = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "morrow.reader-fixture-heartbeat", qos: .utility))
        heartbeat.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(50))
        heartbeat.setEventHandler { trace.heartbeat() }
        heartbeat.resume()
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let port = CommandLine.arguments[1]
        // Deliberately hostile fixture text, never app-executed JavaScript.
        let content = "<p>Formatted mail fixture</p><script>document.body.append('Forbidden email script ran');fetch('http://127.0.0.1:\(port)/script')</script><img src='http://127.0.0.1:\(port)/image'><iframe src='http://127.0.0.1:\(port)/frame'></iframe>"
        let state = ReaderFixtureState(content)
        let host = NSHostingView(rootView: ReaderFixture(state: state))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 540), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = host
        window.orderBack(nil)
        func findWeb(_ view: NSView) -> WKWebView? { (view as? WKWebView) ?? view.subviews.lazy.compactMap { findWeb($0) }.first }
        var navigationObservations: [NSKeyValueObservation] = []
        @MainActor func observeNavigation(_ web: WKWebView, reader: String) {
            trace.event("navigation-observe reader=\(reader) width=\(Int(web.bounds.width)) height=\(Int(web.bounds.height))")
            // These signals describe navigation, not completion of WebKit layout.
            // Preserve the production delegate and consume only KVO's value here.
            navigationObservations.append(web.observe(\.isLoading, options: [.initial, .new]) { _, change in
                trace.event("navigation-loading reader=\(reader) value=\(change.newValue ?? false)")
            })
            navigationObservations.append(web.observe(\.estimatedProgress, options: [.initial, .new]) { _, change in
                trace.event("navigation-progress reader=\(reader) percent=\(Int((change.newValue ?? 0) * 100))")
            })
        }
        Task { @MainActor in
            do {
                phase("initial-load")
                var web: WKWebView?
                for _ in 0..<200 {
                    web = findWeb(host)
                    if let web, navigationObservations.isEmpty { observeNavigation(web, reader: "initial") }
                    if let web, !web.isLoading, web.url != nil { break }
                    try await Task.sleep(nanoseconds: 50_000_000)
                }
                guard let web, web.url != nil else { fatalError("Formatted reader did not load") }
                trace.event("initial-navigation-poll-end loading=\(web.isLoading)")
                assert(MessageHTMLView.document("", images: false, inlineImages: true).contains("img-src data: ;"))
                assert(!MessageHTMLView.document("", images: false).contains("img-src data:"))
                assert(!web.configuration.defaultWebpagePreferences.allowsContentJavaScript)
                assert(!web.configuration.preferences.javaScriptCanOpenWindowsAutomatically)
                assert(!web.configuration.websiteDataStore.isPersistent)
                assert(MessageHTMLView.allowedLink(URL(string: "https://example.invalid")!))
                assert(!MessageHTMLView.allowedLink(URL(string: "file:///tmp/secret")!))
                assert(!MessageHTMLView.allowedLink(URL(string: "javascript:alert(1)")!))
                assert(!MessageHTMLView.allowedLink(URL(string: "https://user:password@example.invalid")!))
                @MainActor func find(_ text: String) async throws -> Bool {
                    // WebKit selects and scrolls the match through its native API.
                    let operation = trace.begin("find", detail: "marker=\(text) loading=\(web.isLoading)")
                    do {
                        let found = try await web.find(text, configuration: WKFindConfiguration()).matchFound
                        trace.end(operation, detail: "found=\(found) loading=\(web.isLoading)")
                        return found
                    } catch {
                        let failure = error as NSError
                        trace.end(operation, detail: "errorDomain=\(failure.domain) errorCode=\(failure.code)")
                        throw error
                    }
                }
                @MainActor func loaded(_ marker: String) async throws {
                    let began = ProcessInfo.processInfo.systemUptime
                    trace.event("marker-wait-begin marker=\(marker) loading=\(web.isLoading)")
                    for attempt in 0..<400 {
                        if !web.isLoading, try await find(marker) {
                            trace.event("marker-wait-end marker=\(marker) polls=\(attempt + 1) durationMs=\(Int((ProcessInfo.processInfo.systemUptime - began) * 1000)) width=\(Int(web.bounds.width)) height=\(Int(web.bounds.height))")
                            return
                        }
                        try await Task.sleep(nanoseconds: 50_000_000)
                    }
                    phase("fixture-marker-timeout")
                    fatalError("Reader did not load its fixture marker: \(marker)")
                }
                @MainActor func snapshot() async throws -> Data {
                    trace.event("snapshot-settle-begin")
                    try await Task.sleep(nanoseconds: 100_000_000)
                    trace.event("snapshot-settle-end")
                    let operation = trace.begin("snapshot")
                    let image: NSImage
                    do {
                        image = try await web.takeSnapshot(configuration: nil)
                    } catch {
                        let failure = error as NSError
                        trace.end(operation, detail: "errorDomain=\(failure.domain) errorCode=\(failure.code)")
                        throw error
                    }
                    trace.end(operation)
                    let encoding = trace.begin("snapshot-tiff")
                    guard let bytes = image.tiffRepresentation else { fatalError("Reader snapshot unavailable") }
                    trace.end(encoding, detail: "bytes=\(bytes.count)")
                    return bytes
                }
                @MainActor func wheel(_ delta: Int32) {
                    let point = NSPoint(x: web.bounds.midX, y: web.bounds.midY)
                    guard let target = web.hitTest(web.convert(point, to: web.superview)),
                          let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0) else { fatalError("Could not create wheel fixture") }
                    let screenPoint = window.convertPoint(toScreen: web.convert(point, to: nil))
                    cg.location = CGPoint(x: screenPoint.x, y: CGDisplayBounds(CGMainDisplayID()).height - screenPoint.y)
                    cg.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window.windowNumber))
                    cg.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window.windowNumber))
                    guard let event = NSEvent(cgEvent: cg) else { fatalError("Could not create wheel event") }
                    target.scrollWheel(with: event)
                }
                try await loaded("Formatted mail fixture")
                let scriptRan = try await find("Forbidden email script ran")
                assert(!scriptRan, "Email JavaScript executed")
                assert(web.bounds.height == MessageHTMLView.viewportHeight)
                guard let outer = web.enclosingScrollView else { fatalError("Reader has no enclosing scroll view") }

                @MainActor func imagePolicy(_ enabled: Bool) async throws {
                    let expected = "img-src \(enabled ? "https:" : "'none'");"
                    for _ in 0..<100 {
                        if !web.isLoading, (web.navigationDelegate as? MessageHTMLView.Coordinator)?.document.contains(expected) == true { return }
                        try await Task.sleep(nanoseconds: 20_000_000)
                    }
                    fatalError("Reader did not apply its image preference")
                }
                @MainActor func hideImages() async throws {
                    try await Task.sleep(nanoseconds: 100_000_000)
                    let htmlFrame = host.convert(web.bounds, from: web)
                    func views(_ view: NSView) -> [NSView] {
                        [view] + view.subviews.flatMap { views($0) }
                    }
                    // SwiftUI's background fixture may have an empty AX tree.
                    // Use the overlapping native control bounds at the toolbar's
                    // right, then dispatch actual window mouse events.
                    let buttons = views(host).map { host.convert($0.bounds, from: $0) }.filter { frame in
                        frame.width > 0 && frame.height > 0 && frame.midX > htmlFrame.midX
                        && (host.isFlipped ? frame.maxY <= htmlFrame.minY : frame.minY >= htmlFrame.maxY)
                    }
                    guard let first = buttons.first else { fatalError("The reader did not expose its individual image control") }
                    let frame = buttons.dropFirst().reduce(first) { $0.intersection($1) }
                    guard frame.width > 0 && frame.height > 0 else { fatalError("The image control's native bounds did not overlap") }
                    let location = host.convert(NSPoint(x: frame.midX, y: frame.midY), to: nil)
                    // Queue the complete click before AppKit handles mouseDown:
                    // some macOS versions track synchronously until mouseUp.
                    for kind in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                        guard let event = NSEvent.mouseEvent(with: kind, location: location, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1) else { fatalError("Could not create the image-control click") }
                        app.postEvent(event, atStart: false)
                    }
                }
                phase("image-preference")
                try await imagePolicy(false)
                state.autoLoadExternalImages = true
                try await imagePolicy(true)
                phase("image-opt-in")
                assert(!web.configuration.defaultWebpagePreferences.allowsContentJavaScript)
                let enabledScriptRan = try await find("Forbidden email script ran")
                assert(!enabledScriptRan, "Automatic images enabled email scripts")
                try await hideImages()
                try await imagePolicy(false)
                phase("image-hidden")
                state.html = content + "<p>Another owned message</p>"; state.messageID = "reader-fixture-2"
                try await loaded("Another owned message")
                try await imagePolicy(true)
                state.autoLoadExternalImages = false
                try await imagePolicy(false)
                phase("image-revoked")
                state.messageID = "reader-fixture-3"
                try await imagePolicy(false)

                phase("long-scroll")
                state.html = "<p>Long message start</p>" + (0..<1800).map { "<p>Formatted email line \($0), with enough text to wrap when the reader gets narrower.</p>" }.joined() + "<div style='background:#0000ff;height:180px'>Long message end</div>"
                try await loaded("Long message start")
                let before = try await snapshot(), outerY = outer.documentVisibleRect.minY
                wheel(-170)
                try await Task.sleep(nanoseconds: 250_000_000)
                let afterDown = try await snapshot()
                assert(before != afterDown, "Native wheel did not scroll long HTML")
                assert(abs(outer.documentVisibleRect.minY - outerY) < 1, "HTML scrolling displaced the outer reader")
                wheel(90)
                try await Task.sleep(nanoseconds: 250_000_000)
                let afterUp = try await snapshot()
                assert(afterUp != afterDown, "Native wheel did not scroll back up")
                let foundEnd = try await find("Long message end")
                assert(foundEnd, "Native find could not select the long email tail")
                let tail = try await snapshot()
                guard let bitmap = NSBitmapImageRep(data: tail) else { fatalError("Tail snapshot could not be read") }
                var bluePixels = 0
                for y in stride(from: 0, to: bitmap.pixelsHigh, by: 8) {
                    for x in stride(from: 0, to: bitmap.pixelsWide, by: 8) {
                        if let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB), color.blueComponent > 0.8 && color.redComponent < 0.2 { bluePixels += 1 }
                    }
                }
                assert(bluePixels > 10, "The selected tail was not revealed in the native viewport")
                assert(web.bounds.height == MessageHTMLView.viewportHeight, "Long HTML expanded the native allocation")

                phase("adversarial-text")
                trace.event("fixture-update-request begin textCharacters=180000 columnWidthPx=1 viewportWidth=\(Int(web.bounds.width)) viewportHeight=\(Int(web.bounds.height)) windowWidth=\(Int(window.contentLayoutRect.width))")
                state.html = "<div style='width:1px'>" + String(repeating: "x", count: 180000) + "</div><p>Bounded adversarial tail</p>"
                trace.event("fixture-update-request end; SwiftUI navigation/layout may still be pending")
                try await loaded("Bounded adversarial tail")
                assert(web.bounds.height == MessageHTMLView.viewportHeight, "Narrow-column HTML escaped the viewport bound")

                phase("replacement-reflow")
                state.html = "<p>Replacement message</p>" + String(repeating: "<p>Formatted text wraps to the available native width.</p>", count: 30) + "<img src='https://example.invalid/giant.png' style='height:1000000px' width='2048' height='2048'><p>Replacement tail</p>"
                try await loaded("Replacement message")
                let oldTail = try await find("Long message end")
                assert(!oldTail, "Switching messages retained old content")
                window.setContentSize(NSSize(width: 360, height: 540))
                try await Task.sleep(nanoseconds: 100_000_000)
                let narrowWidth = web.bounds.width
                let narrowTail = try await find("Replacement tail")
                assert(narrowTail && web.bounds.height == MessageHTMLView.viewportHeight)
                window.setContentSize(NSSize(width: 720, height: 540))
                try await Task.sleep(nanoseconds: 100_000_000)
                assert(web.bounds.width > narrowWidth && web.bounds.height == MessageHTMLView.viewportHeight)
                assert(!web.configuration.defaultWebpagePreferences.allowsContentJavaScript)
                phase("reader-failure-fallback")
                guard let delegate = web.navigationDelegate as? MessageHTMLView.Coordinator else { fatalError("Missing reader delegate") }
                var failures = 0
                let probe = MessageHTMLView.Coordinator()
                probe.onFailure = { failures += 1 }
                probe.webView(web, didFail: nil, withError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
                assert(failures == 0, "Cancelled navigation must not fail the current message")
                probe.webView(web, didFailProvisionalNavigation: nil, withError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotLoadFromNetwork))
                probe.webViewWebContentProcessDidTerminate(web)
                assert(failures == 1, "Reader failures must notify once")
                delegate.webViewWebContentProcessDidTerminate(web)
                for _ in 0..<100 {
                    if findWeb(host) == nil { break }
                    try await Task.sleep(nanoseconds: 20_000_000)
                }
                assert(findWeb(host) == nil, "Renderer failure did not switch to native plain text")
                state.autoLoadExternalImages = false
                state.messageID = "reader-after-failure"
                for _ in 0..<100 {
                    if let next = findWeb(host) {
                        if navigationObservations.count == 2 { observeNavigation(next, reader: "recovered") }
                        if !next.isLoading, next.url != nil { break }
                    }
                    try await Task.sleep(nanoseconds: 20_000_000)
                }
                guard let next = findWeb(host), let nextDelegate = next.navigationDelegate as? MessageHTMLView.Coordinator else { fatalError("Next message did not recover its HTML reader") }
                assert(next !== web && !next.configuration.defaultWebpagePreferences.allowsContentJavaScript)
                assert(nextDelegate.document.contains("img-src 'none'"), "Recovery enabled external images")
                phase("done")
                trace.summary()
                withExtendedLifetime(navigationObservations) {}
                heartbeat.cancel()
                print("Native email reader: bounded viewport, bidirectional native scrolling, selectable/revealed long tail, adversarial layout, replacement/reflow, scripts/resources blocked and link protocols checked without host script execution.")
                window.orderOut(nil)
                exit(0)
            } catch { fatalError("Reader check failed: \(error)") }
        }
        app.run()
    }
}
