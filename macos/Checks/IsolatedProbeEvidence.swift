import AppKit
import CryptoKit
import Foundation
import ScreenCaptureKit

// Branch-only native diagnostics. Never linked into a distributed app.
@MainActor enum ProbeEvidence {
    static func emit(_ kind: String, _ payload: JSON) throws {
        guard !kind.isEmpty, kind.utf8.count <= 64,
              kind.utf8.allSatisfy({ $0 == 45 || (48...57).contains($0) || (97...122).contains($0) }) else {
            throw APIError("Invalid fixed diagnostic kind")
        }
        let record: JSON = .object(["schema": .number(1), "kind": .string(kind), "payload": payload])
        let data = try JSONEncoder().encode(record)
        guard data.count <= 32768, let line = String(data: data, encoding: .utf8) else {
            throw APIError("Native diagnostic exceeds its fixed output bound")
        }
        print("MORROW_ISOLATED_OBSERVATION " + line); fflush(stdout)
    }

    static func bitmap(_ host: NSView, name: String) throws {
        let names = ["menu-async-before", "menu-appkit-before", "row-async-before", "row-async-after", "row-appkit-before", "row-appkit-after"]
        guard names.contains(name), let window = host.window,
              window.isVisible, window.contentView === host,
              host.bounds.width > 0, host.bounds.height > 0,
              host.bounds.width <= 1600, host.bounds.height <= 1000,
              [host.bounds.minX, host.bounds.minY, host.bounds.width, host.bounds.height].allSatisfy(\.isFinite) else {
            throw APIError("Native bitmap lost its owned visible fixture root")
        }
        host.layoutSubtreeIfNeeded(); host.displayIfNeeded()
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds),
              bitmap.pixelsWide > 0, bitmap.pixelsHigh > 0,
              bitmap.pixelsWide <= 3200, bitmap.pixelsHigh <= 2000,
              bitmap.pixelsWide * bitmap.pixelsHigh <= 6_400_000 else {
            throw APIError("Native bitmap dimensions exceed the fixed fixture bound")
        }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        try emitPNG(bitmap, name: name)
    }

    // Called after the independent predicate/AX observations. Content comes
    // only from this process, then one exact owned synthetic window. No desktop
    // enumeration, permission request, fallback or retry is performed.
    static func windowBitmap(_ host: NSView, name: String) async {
        let mode = ProcessInfo.processInfo.environment["MORROW_ISOLATED_MODE"] ?? ""
        do {
            guard #available(macOS 14.4, *) else { throw APIError("Current-process compositor capture requires macOS 14.4") }
            guard ["row-async-window-after", "row-appkit-window-after"].contains(name),
                  let window = host.window, window.contentView === host,
                  window.isVisible, !window.isMiniaturized,
                  let windowID = CGWindowID(exactly: window.windowNumber), windowID != 0 else {
                throw APIError("Owned fixture window is unavailable for compositor capture")
            }
            let frame = window.frame, scale = window.backingScaleFactor
            let pid = ProcessInfo.processInfo.processIdentifier
            let width = (frame.width * scale).rounded(.up), height = (frame.height * scale).rounded(.up)
            guard width.isFinite, height.isFinite, width > 0, width <= 3200,
                  height > 0, height <= 2000, width * height <= 6_400_000 else {
                throw APIError("Owned fixture window exceeds compositor capture bounds")
            }
            @MainActor func stillOwned() -> Bool {
                host.window === window && window.contentView === host && window.windowNumber == Int(windowID)
                    && window.frame == frame && window.backingScaleFactor == scale
                    && window.isVisible && !window.isMiniaturized
            }
            let content: SCShareableContent = try await withCheckedThrowingContinuation {
                (continuation: CheckedContinuation<SCShareableContent, Error>) in
                SCShareableContent.getCurrentProcessShareableContent { content, error in
                    if let error { continuation.resume(throwing: error) }
                    else if let content { continuation.resume(returning: content) }
                    else { continuation.resume(throwing: APIError("Current-process capture content is unavailable")) }
                }
            }
            guard stillOwned() else { throw APIError("Owned fixture window changed during capture enumeration") }
            let matches = content.windows.filter { $0.windowID == windowID && $0.owningApplication?.processID == pid }
            guard matches.count == 1 else { throw APIError("Exact owned fixture window is absent from current-process content") }
            let configuration = SCStreamConfiguration()
            configuration.width = Int(width); configuration.height = Int(height)
            configuration.showsCursor = false; configuration.capturesAudio = false
            let image = try await SCScreenshotManager.captureImage(
                contentFilter: SCContentFilter(desktopIndependentWindow: matches[0]), configuration: configuration)
            guard stillOwned() else { throw APIError("Owned fixture window changed during compositor capture") }
            try emitPNG(NSBitmapImageRep(cgImage: image), name: name)
            try emit("row", .object(["mode": .string(mode), "phase": .string("own-window-capture"),
                "status": .string("captured"), "scope": .string("exact-current-process-window"),
                "afterAXQueries": .bool(true)]))
        } catch {
            let failure = error as NSError
            // No arbitrary localized message, title, application or mail text.
            try? emit("row", .object(["mode": .string(mode), "phase": .string("own-window-capture"),
                "status": .string("unavailable"), "domain": .string(String(failure.domain.prefix(128))),
                "code": .number(Double(failure.code)), "retried": .bool(false),
                "afterAXQueries": .bool(true)]))
        }
    }

    private static func emitPNG(_ bitmap: NSBitmapImageRep, name: String) throws {
        guard bitmap.pixelsWide > 0, bitmap.pixelsHigh > 0, bitmap.pixelsWide <= 3200,
              bitmap.pixelsHigh <= 2000, bitmap.pixelsWide * bitmap.pixelsHigh <= 6_400_000 else {
            throw APIError("Native PNG dimensions exceed the fixed fixture bound")
        }
        guard let png = bitmap.representation(using: .png, properties: [:]),
              !png.isEmpty, png.count <= 524288 else {
            throw APIError("Native PNG exceeds the fixed 512KiB diagnostic bound")
        }
        let digest = SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined()
        let encoded = png.base64EncodedString(), bytes = Array(encoded.utf8)
        let count = (bytes.count + 1023) / 1024
        print("MORROW_ISOLATED_IMAGE_BEGIN \(name) \(png.count) \(digest) \(count)")
        for index in 0..<count {
            let start = index * 1024, end = min(start + 1024, bytes.count)
            print("MORROW_ISOLATED_IMAGE_CHUNK \(name) \(index) " + String(decoding: bytes[start..<end], as: UTF8.self))
        }
        print("MORROW_ISOLATED_IMAGE_END " + name); fflush(stdout)
    }

    static func complete(kind: String, mode: String, passed: Bool) throws {
        let environment = ProcessInfo.processInfo.environment
        let nonce = environment["MORROW_ISOLATED_NONCE"] ?? ""
        guard ["menu", "row"].contains(kind), ["async", "appkit"].contains(mode),
              environment["MORROW_ISOLATED_KIND"] == kind,
              environment["MORROW_ISOLATED_MODE"] == mode,
              nonce.utf8.count == 32,
              nonce.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw APIError("Missing or mismatched isolated native completion identity")
        }
        let value: JSON = .object(["schema": .number(1), "kind": .string(kind), "mode": .string(mode),
            "nonce": .string(nonce), "passed": .bool(passed), "diagnosticComplete": .bool(true)])
        let data = try JSONEncoder().encode(value)
        print("MORROW_ISOLATED_RESULT " + String(decoding: data, as: UTF8.self))
        print("MORROW_ISOLATED_COMPLETE \(kind) \(mode) \(nonce)"); fflush(stdout)
    }
}
