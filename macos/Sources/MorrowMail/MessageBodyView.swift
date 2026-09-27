import SwiftUI
import AppKit
import WebKit

// Reader-only content. Never gives email HTML a script bridge or the service token.
struct SecureMessageBody: View {
    let message: JSON
    @State private var showPlain = false
    @State private var loadImages = false
    @State private var reviewImages = false
    @State private var height: CGFloat = 480

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if message["bodyHtml"].nonempty {
                HStack {
                    Toggle("Plain text", isOn: $showPlain).toggleStyle(.checkbox)
                    Spacer()
                    if !showPlain && message["bodyHtml"].string.contains("<img") {
                        Button(loadImages ? "Hide external images" : "Load external images…") {
                            if loadImages { loadImages = false } else { reviewImages = true }
                        }
                    }
                }.font(.caption)
                if !showPlain {
                    Text(loadImages ? "External images enabled for this message." : "External images blocked. Scripts and forms are disabled.")
                        .font(.caption).foregroundStyle(.secondary)
                    MessageHTMLView(html: message["bodyHtml"].string, images: loadImages, height: $height)
                        .frame(height: height).background(Color.white)
                        .accessibilityLabel("Formatted email")
                }
            }
            if showPlain || !message["bodyHtml"].nonempty {
                Text(Self.linkedText(message["body"].string)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .environment(\.openURL, OpenURLAction { url in
                        MessageHTMLView.openLink(url)
                        return .handled
                    })
            }
        }
        .onChange(of: message["viewId"].string + message["accountId"].string + message.id) { _ in
            showPlain = false; loadImages = false; reviewImages = false; height = 480
        }
        .confirmationDialog("Load external images for this message?", isPresented: $reviewImages, titleVisibility: .visible) {
            Button("Load Images") { loadImages = true }
        } message: {
            Text("The sender’s image servers may learn your IP address and that you opened this email. This choice applies only to this message.")
        }
    }

    static func linkedText(_ text: String) -> AttributedString {
        let value = NSMutableAttributedString(string: text)
        if let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) {
            for match in detector.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                if let url = match.url, MessageHTMLView.allowedLink(url) { value.addAttribute(.link, value: url, range: match.range) }
            }
        }
        return AttributedString(value)
    }
}

struct MessageHTMLView: NSViewRepresentable {
    let html: String
    let images: Bool
    @Binding var height: CGFloat

    static func allowedLink(_ url: URL) -> Bool {
        ["https", "http", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "") && url.user == nil && url.password == nil
    }
    @MainActor static func openLink(_ url: URL) {
        guard allowedLink(url) else { return }
        let alert = NSAlert()
        alert.messageText = "Open this email link?"
        alert.informativeText = url.absoluteString
        alert.addButton(withTitle: "Open Link")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(url) }
    }
    static func document(_ html: String, images: Bool) -> String {
        let policy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src \(images ? "https:" : "'none'"); connect-src 'none'; frame-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
        return "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"\(policy)\"><meta name=\"referrer\" content=\"no-referrer\"><style>body{font:15px -apple-system,sans-serif;color:#202720;background:white;margin:8px;overflow-wrap:anywhere}img{max-width:100%;max-height:2048px;object-fit:contain;height:auto}table{max-width:100%}pre{white-space:pre-wrap}blockquote{margin-left:12px;padding-left:12px;border-left:2px solid #ddd}a{color:#236042}</style></head><body>\(html)</body></html>"
    }
    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = MessageWebView(frame: .zero, configuration: configuration)
        view.measureHeight = { [weak coordinator = context.coordinator] web in coordinator?.measureHeight(web) }
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = false
        return view
    }
    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        let next = Self.document(html, images: images)
        guard context.coordinator.document != next else { return }
        context.coordinator.document = next
        view.loadHTMLString(next, baseURL: nil)
    }
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var parent: MessageHTMLView
        var document = ""
        init(_ parent: MessageHTMLView) { self.parent = parent }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if action.navigationType == .linkActivated, let url = action.request.url {
                decisionHandler(.cancel)
                MessageHTMLView.openLink(url)
            } else if action.navigationType == .other && action.request.url?.absoluteString == "about:blank" && action.targetFrame?.isMainFrame == true {
                decisionHandler(.allow)
            } else { decisionHandler(.cancel) }
        }
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if action.navigationType == .linkActivated, let url = action.request.url { MessageHTMLView.openLink(url) }
            return nil
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            measureHeight(webView)
        }
        func measureHeight(_ webView: WKWebView) {
            let currentDocument = document, width = webView.bounds.width
            // App-owned measurement only; email JavaScript stays disabled.
            webView.evaluateJavaScript("document.body.getBoundingClientRect().top + window.scrollY + Math.max(document.body.scrollHeight, document.body.offsetHeight)") { [weak self, weak webView] result, _ in
                guard let self, let webView, !webView.isLoading, self.document == currentDocument,
                      webView.bounds.width == width, let value = result as? Double, value.isFinite else { return }
                (webView as? MessageWebView)?.hasVerticalOverflow = value + 16 > 20000
                self.parent.height = max(180, min(20000, value + 16))
            }
        }
    }
}

final class MessageWebView: WKWebView {
    var measureHeight: ((WKWebView) -> Void)?
    var hasVerticalOverflow = false
    private var forwardsVerticalScroll = true
    private var scrollsHTML = false

    override func setFrameSize(_ newSize: NSSize) {
        let widthChanged = frame.width != newSize.width
        super.setFrameSize(newSize)
        if widthChanged {
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.isLoading else { return }
                self.measureHeight?(self)
            }
        }
    }

    override func scrollWheel(with event: NSEvent) {
        if event.scrollingDeltaY != 0 || event.scrollingDeltaX != 0 {
            forwardsVerticalScroll = abs(event.scrollingDeltaY) >= abs(event.scrollingDeltaX)
        }
        // Keep zero-delta gesture/momentum endings with the same recipient.
        if forwardsVerticalScroll, let scroll = enclosingScrollView {
            guard hasVerticalOverflow else { scroll.scrollWheel(with: event); return }
            // Only app-owned geometry is queried; email scripts remain disabled.
            // The capped WebKit viewport scrolls at the email's lower edge, then
            // hands the original native event back to the reader at either end.
            evaluateJavaScript("[window.scrollY,Math.max(0,document.documentElement.scrollHeight-window.innerHeight)]") { [weak self, weak scroll] result, _ in
                guard let self, let scroll else { return }
                if event.scrollingDeltaY != 0 {
                    let geometry = result as? [Double] ?? [0, 0]
                    let email = self.convert(self.bounds, to: scroll.documentView)
                    let bottom = scroll.documentVisibleRect.maxY
                    self.scrollsHTML = geometry.count == 2 && (event.scrollingDeltaY < 0
                        ? bottom >= email.maxY - 1 && geometry[0] < geometry[1] - 1
                        : bottom <= email.maxY + 1 && geometry[0] > 1)
                }
                if self.scrollsHTML { self.scrollHTML(with: event) }
                else { scroll.scrollWheel(with: event) }
            }
        } else {
            super.scrollWheel(with: event)
        }
    }

    private func scrollHTML(with event: NSEvent) { super.scrollWheel(with: event) }
}
