import AppKit
import SwiftUI
import WebKit

@MainActor final class ReaderFixtureState: ObservableObject {
    @Published var html: String
    @Published var height: CGFloat = 480
    init(_ html: String) { self.html = html }
}

struct ReaderFixture: View {
    @ObservedObject var state: ReaderFixtureState
    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Color.clear.frame(height: 80)
                MessageHTMLView(html: state.html, images: false, height: $state.height).frame(height: state.height)
                Color.clear.frame(height: 800)
            }
        }
    }
}

@main struct MessageHTMLChecks {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let port = CommandLine.arguments[1]
        let content = "<p>Formatted <b>mail</b></p><script>window.emailScriptRan=true;fetch('http://127.0.0.1:\(port)/script')</script><img src='http://127.0.0.1:\(port)/image'><iframe src='http://127.0.0.1:\(port)/frame'></iframe>"
        let state = ReaderFixtureState(content)
        let host = NSHostingView(rootView: ReaderFixture(state: state))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = host
        window.orderBack(nil)
        func findWeb(_ view: NSView) -> WKWebView? { (view as? WKWebView) ?? view.subviews.lazy.compactMap { findWeb($0) }.first }
        Task { @MainActor in
            do {
                var web: WKWebView?
                for _ in 0..<200 {
                    web = findWeb(host)
                    if let web, !web.isLoading, web.url != nil, state.height != 480 { break }
                    try await Task.sleep(nanoseconds: 50_000_000)
                }
                guard let web, web.url != nil else { fatalError("Formatted reader did not load") }
                assert(!web.configuration.defaultWebpagePreferences.allowsContentJavaScript)
                let ran = try await web.evaluateJavaScript("window.emailScriptRan === true")
                assert((ran as? Bool) == false, "Email JavaScript executed")
                assert(state.height != 480, "Reader did not measure content height")
                assert(MessageHTMLView.allowedLink(URL(string: "https://example.invalid")!))
                assert(!MessageHTMLView.allowedLink(URL(string: "file:///tmp/secret")!))
                assert(!MessageHTMLView.allowedLink(URL(string: "javascript:alert(1)")!))
                assert(!MessageHTMLView.allowedLink(URL(string: "https://user:password@example.invalid")!))
                guard let scroll = web.enclosingScrollView else { fatalError("Reader has no enclosing scroll view") }
                @MainActor func wheel(_ delta: Int32, phase: CGScrollPhase? = nil) {
                    let visible = web.visibleRect.intersection(web.bounds)
                    let point = NSPoint(x: visible.midX, y: visible.midY)
                    guard !visible.isEmpty, let target = web.hitTest(web.convert(point, to: web.superview)),
                          let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0) else { fatalError("Could not create wheel fixture: delta=\(delta), HTML=\(web.frame), visible=\(web.visibleRect), parent=\(scroll.documentVisibleRect)") }
                    cg.setIntegerValueField(.scrollWheelEventScrollPhase, value: Int64(phase?.rawValue ?? 0))
                    let screenPoint = window.convertPoint(toScreen: web.convert(point, to: nil))
                    cg.location = CGPoint(x: screenPoint.x, y: CGDisplayBounds(CGMainDisplayID()).height - screenPoint.y)
                    cg.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window.windowNumber))
                    cg.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window.windowNumber))
                    guard let event = NSEvent(cgEvent: cg) else { fatalError("Could not create wheel event") }
                    assert(target === web, "Wheel must hit the interactive HTML surface")
                    assert(event.hasPreciseScrollingDeltas && event.scrollingDeltaY == CGFloat(delta), "Synthetic pixel wheel changed its delta: input=\(delta), actual=\(event.scrollingDeltaY), phase=\(event.phase.rawValue)")
                    target.scrollWheel(with: event)
                }
                @MainActor func waitForOuterY(_ expected: CGFloat, _ label: String) async throws {
                    // AppKit applies pixel scrolling asynchronously. Establish a
                    // completed downward baseline before reversing direction;
                    // a fixed sleep can sample midway through the first scroll.
                    for _ in 0..<100 {
                        if abs(scroll.documentVisibleRect.minY - expected) < 1 { return }
                        try await Task.sleep(nanoseconds: 20_000_000)
                    }
                    assert(abs(scroll.documentVisibleRect.minY - expected) < 1, "\(label): expectedY=\(expected), actual=\(scroll.documentVisibleRect), HTML=\(web.frame), contentHeight=\(state.height), OS=\(ProcessInfo.processInfo.operatingSystemVersionString)")
                }
                let beforeShort = scroll.documentVisibleRect.minY
                wheel(-100)
                try await waitForOuterY(beforeShort + 100, "Downward wheel did not finish")
                assert(scroll.documentVisibleRect.minY > beforeShort, "Wheel over short HTML did not scroll the reader")
                let beforeUp = scroll.documentVisibleRect.minY
                wheel(0, phase: .began)
                try await Task.sleep(nanoseconds: 50_000_000)
                wheel(30, phase: .changed)
                try await Task.sleep(nanoseconds: 50_000_000)
                wheel(0, phase: .ended)
                try await waitForOuterY(beforeUp - 30, "Upward trackpad scrolling did not reach the reader")
                assert(scroll.documentVisibleRect.minY < beforeUp, "Upward trackpad scrolling did not reach the reader")

                state.html = "<p>Long message start</p>" + String(repeating: "<p>Formatted long email line, with enough text to wrap when this reader gets narrower.</p>", count: 1800) + "<p>Long message end</p>"
                for _ in 0..<200 {
                    if state.height == 20000 && !web.isLoading { break }
                    try await Task.sleep(nanoseconds: 50_000_000)
                }
                assert(state.height == 20000, "Long content did not respect the native height cap")
                try await Task.sleep(nanoseconds: 250_000_000)
                let beforeLong = scroll.documentVisibleRect.minY
                wheel(-100)
                try await Task.sleep(nanoseconds: 250_000_000)
                assert(scroll.documentVisibleRect.minY > beforeLong, "Wheel over long HTML did not scroll the reader")
                let contentHeight = try await web.evaluateJavaScript("document.body.scrollHeight") as! Double
                assert(contentHeight > 20000 && web.bounds.height <= 20000, "Long HTML allocated an unbounded native view")
                let email = web.convert(web.bounds, to: scroll.documentView)
                scroll.contentView.scroll(to: NSPoint(x: 0, y: email.maxY - scroll.contentView.bounds.height))
                scroll.reflectScrolledClipView(scroll.contentView)
                try await Task.sleep(nanoseconds: 100_000_000)
                let outerAtBoundary = scroll.documentVisibleRect.minY
                wheel(-300)
                try await Task.sleep(nanoseconds: 250_000_000)
                let innerY = try await web.evaluateJavaScript("window.scrollY") as! Double
                assert(innerY > 0, "Native wheel could not enter capped HTML")
                assert(abs(scroll.documentVisibleRect.minY - outerAtBoundary) < 2, "Reader skipped capped content to the footer")
                _ = try await web.evaluateJavaScript("window.scrollTo(0,document.documentElement.scrollHeight-window.innerHeight-120)")
                try await Task.sleep(nanoseconds: 100_000_000)
                wheel(-200)
                try await Task.sleep(nanoseconds: 250_000_000)
                let tail = try await web.evaluateJavaScript("document.body.lastElementChild.getBoundingClientRect().bottom") as! Double
                assert(tail <= web.bounds.height && tail > web.bounds.height - scroll.contentView.bounds.height, "Native wheel could not reveal the end beyond 20k")
                wheel(-100)
                try await Task.sleep(nanoseconds: 250_000_000)
                assert(scroll.documentVisibleRect.minY > outerAtBoundary, "Native wheel did not leave the HTML end for the footer")
                let selected = try await web.evaluateJavaScript("const r=document.createRange();r.selectNodeContents(document.body.lastElementChild);const s=window.getSelection();s.removeAllRanges();s.addRange(r);s.toString()")
                assert((selected as? String) == "Long message end", "Email text is no longer selectable")
                wheel(100)
                try await Task.sleep(nanoseconds: 250_000_000)
                let innerAtEnd = try await web.evaluateJavaScript("window.scrollY") as! Double
                wheel(100)
                try await Task.sleep(nanoseconds: 250_000_000)
                let innerAfterUp = try await web.evaluateJavaScript("window.scrollY") as! Double
                assert(innerAfterUp < innerAtEnd, "Upward wheel did not return from the footer into capped HTML")
                _ = try await web.evaluateJavaScript("window.scrollTo(0,100)")
                try await Task.sleep(nanoseconds: 100_000_000)
                wheel(200)
                try await Task.sleep(nanoseconds: 250_000_000)
                let outerBeforeUp = scroll.documentVisibleRect.minY
                wheel(100)
                try await Task.sleep(nanoseconds: 250_000_000)
                assert(scroll.documentVisibleRect.minY < outerBeforeUp, "Upward wheel did not leave the HTML start for the reader")

                // Valid bounded-size markup can still lay out millions of points
                // tall. Keep the native viewport capped independently of bytes.
                state.html = "<div style='width:1px'>" + String(repeating: "x", count: 180000) + "</div>"
                for _ in 0..<200 {
                    try await Task.sleep(nanoseconds: 50_000_000)
                    if !web.isLoading, (try await web.evaluateJavaScript("document.body.textContent.length") as? Int) == 180000 { break }
                }
                let adversarialHeight = try await web.evaluateJavaScript("document.body.scrollHeight") as! Double
                assert(adversarialHeight > 1_000_000 && state.height == 20000 && web.bounds.height <= 20000, "Single-column HTML escaped the native height bound")

                state.html = String(repeating: "<p>Formatted email text, with enough words to wrap when the reader gets narrower.</p>", count: 30) + "<img src='https://example.invalid/giant.png' alt='Giant image' width='2048' height='2048'>"
                for _ in 0..<200 {
                    if state.height < 20000 && !web.isLoading { break }
                    try await Task.sleep(nanoseconds: 50_000_000)
                }
                assert(state.height < 20000, "Switching messages retained the capped viewport height")
                // Simulate a huge intrinsic image layout without a remote fetch.
                let imageHeight = try await web.evaluateJavaScript("const image=document.querySelector('img');image.style.height='1000000px';image.getBoundingClientRect().height") as! Double
                assert(imageHeight == 2048, "Simulated giant HTTPS image layout did not respect its height bound")
                _ = try await web.evaluateJavaScript("document.querySelector('img').style.height='auto'")
                let wideHeight = state.height
                window.setContentSize(NSSize(width: 360, height: 500))
                for _ in 0..<100 {
                    if state.height > wideHeight { break }
                    try await Task.sleep(nanoseconds: 50_000_000)
                }
                assert(state.height > wideHeight, "Narrow reader did not remeasure wrapped email text")
                window.setContentSize(NSSize(width: 720, height: 500))
                for _ in 0..<100 {
                    if abs(state.height - wideHeight) < 2 { break }
                    try await Task.sleep(nanoseconds: 50_000_000)
                }
                assert(abs(state.height - wideHeight) < 2, "Reader height retained the larger viewport after widening")
                assert(!web.configuration.defaultWebpagePreferences.allowsContentJavaScript)
                print("Native email reader: bidirectional short/capped HTML scrolling, selectable tail, bounded million-point text/image layout, width reflow, scripts/resources blocked and link protocols checked.")
                window.orderOut(nil)
                exit(0)
            } catch { fatalError("Reader check failed: \(error)") }
        }
        app.run()
    }
}
