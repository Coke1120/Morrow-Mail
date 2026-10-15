import AppKit
import CryptoKit
import Foundation

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
