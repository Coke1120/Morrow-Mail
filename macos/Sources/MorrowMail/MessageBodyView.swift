import SwiftUI
import AppKit
import WebKit

// Reader-only content. Never gives email HTML a script bridge or the service token.
struct SecureMessageBody: View {
    let message: JSON
    var autoLoadExternalImages = false
    @State private var showPlain = false
    @State private var imageOverride: Bool?
    @State private var reviewImages = false
    @State private var readerFailed = false
    private var loadImages: Bool { imageOverride ?? autoLoadExternalImages }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if message["bodyTruncated"].bool {
                Text("Downloaded message text was truncated. Check the original mailbox for the complete message.").font(.callout).foregroundStyle(.orange)
            }
            if message["deliveryStatus"].string == "resolved" {
                Text(message["deliveryResolution"].string == "sent" ? "You marked this delivery as sent after checking your mailbox. Morrow did not send another copy." : "You closed this delivery without retrying. Its original delivery status remains unknown.").font(.callout)
            }
            if readerFailed {
                Text("Formatted mail is unavailable. Showing downloaded plain text; external images are blocked.").font(.callout).foregroundStyle(.orange)
            }
            if message["bodyHtml"].nonempty {
                HStack {
                    Toggle("Plain text", isOn: $showPlain).toggleStyle(.checkbox).disabled(readerFailed)
                    Spacer()
                    if !showPlain && message["bodyHtml"].string.contains("<img") {
                        Button(loadImages ? "Hide external images" : "Load external images…") {
                            if loadImages { imageOverride = false } else { reviewImages = true }
                        }
                    }
                }.font(.caption)
                if !showPlain {
                    Text(loadImages ? "External images enabled for this message." : "External images blocked. Scripts and forms are disabled.")
                        .font(.caption).foregroundStyle(.secondary)
                    MessageHTMLView(html: message["bodyHtml"].string, images: loadImages, inlineImages: message["inlineImages"].bool) {
                        readerFailed = true; showPlain = true; imageOverride = false; reviewImages = false
                    }
                        .frame(height: MessageHTMLView.viewportHeight).background(Color.white)
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
            showPlain = false; imageOverride = nil; reviewImages = false; readerFailed = false
        }
        .onChange(of: autoLoadExternalImages) { _ in
            imageOverride = nil; reviewImages = false
        }
        .confirmationDialog("Load external images for this message?", isPresented: $reviewImages, titleVisibility: .visible) {
            Button("Load Images") { imageOverride = true }
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
    var inlineImages = false
    var onFailure: () -> Void = {}
    // ponytail: bounded viewport uses native scrolling; resize with native layout if needed.
    static let viewportHeight: CGFloat = 480

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
    static func document(_ html: String, images: Bool, inlineImages: Bool = false) -> String {
        let policy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src \(inlineImages ? "data: " : "")\(images ? "https:" : inlineImages ? "" : "'none'"); connect-src 'none'; frame-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
        return "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"\(policy)\"><meta name=\"referrer\" content=\"no-referrer\"><style>body{font:15px -apple-system,sans-serif;color:#202720;background:white;margin:8px;overflow-wrap:anywhere}img{max-width:100%;max-height:2048px;object-fit:contain;height:auto}table{max-width:100%}pre{white-space:pre-wrap}blockquote{margin-left:12px;padding-left:12px;border-left:2px solid #ddd}a{color:#236042}</style></head><body>\(html)</body></html>"
    }
    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = false
        return view
    }
    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.onFailure = onFailure
        let next = Self.document(html, images: images, inlineImages: inlineImages)
        guard context.coordinator.document != next else { return }
        context.coordinator.document = next
        context.coordinator.navigation = view.loadHTMLString(next, baseURL: nil)
    }
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.onFailure = {}; coordinator.navigation = nil
        view.navigationDelegate = nil; view.uiDelegate = nil; view.stopLoading()
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var document = ""
        var navigation: WKNavigation?
        var onFailure: () -> Void = {}
        private func failed(_ webView: WKWebView) {
            let notify = onFailure; onFailure = {}
            webView.stopLoading(); notify()
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            guard navigation === self.navigation, (error as NSError).code != NSURLErrorCancelled else { return }
            failed(webView)
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            self.webView(webView, didFail: navigation, withError: error)
        }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { failed(webView) }
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
    }
}
