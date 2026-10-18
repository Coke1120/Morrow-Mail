import SwiftUI
import AppKit

// Only server-sanitized footer HTML reaches this view; remote resources are removed.
struct FooterPreview: View {
    let footer: JSON
    @State private var formatted: AttributedString?
    var body: some View {
        if footer["text"].nonempty || footer["html"].nonempty {
            ScrollView {
                Group {
                    if let formatted { Text(formatted) }
                    else { Text(footer["text"].string) }
                }.textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(10)
            }
            .frame(maxHeight: 120)
            .background(footer["html"].nonempty ? Color.white : Color.clear, in: RoundedRectangle(cornerRadius: 6))
            .accessibilityLabel("Email footer preview")
            .task(id: footer) {
                formatted = nil
                if footer["html"].nonempty,
                   let rich = try? NSAttributedString(data: Data(("<html><body style=\"font-family:Helvetica;font-size:14px\">" + footer["html"].string + "</body></html>").utf8), options: [.documentType: NSAttributedString.DocumentType.html, .characterEncoding: String.Encoding.utf8.rawValue], documentAttributes: nil) {
                    formatted = AttributedString(rich)
                }
            }
        }
    }
}
