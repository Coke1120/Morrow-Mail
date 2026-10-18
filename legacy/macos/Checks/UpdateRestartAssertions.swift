import SwiftUI
import AppKit
import Foundation
import Darwin

// The native driver injects only this transport into a temporary AppModel copy.
// Startup uses the production service in a fresh fixture; no installer is launched.
final class PreparedInstallerProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.path == "/api/updates/install" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        precondition(request.httpMethod == "POST" && request.value(forHTTPHeaderField: "X-Morrow-Update") != nil)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{\"phase\":\"installing\"}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main struct UpdateRestartAssertions: App {
    @NSApplicationDelegateAdaptor(MorrowDelegate.self) var delegate
    @StateObject var model = AppModel()
    var body: some Scene {
        Window("Update restart fixture", id: "main") {
            Text("Fictional update · no installer/provider/model traffic")
                .frame(width: 500, height: 280)
                .background(WindowGuard(model: model, delegate: delegate))
                .sheet(isPresented: $model.showSettings, onDismiss: model.finishUpdateRestart) {
                    Text("Settings fixture").frame(width: 350, height: 220)
                        .interactiveDismissDisabled(model.busy)
                }
                .task {
                    delegate.model = model
                    await model.start()
                    guard model.baseURL != nil else { fatalError("Fixture service failed") }
                    model.busy = true // Settings and update handoff remain available during an operation.
                    model.settings("about")
                    precondition(model.showSettings && model.settingsTab == "about", "An active operation must not block opening update settings")
                    for _ in 0..<100 {
                        if delegate.mainWindow?.attachedSheet != nil { break }
                        try? await Task.sleep(nanoseconds: 20_000_000)
                    }
                    precondition(delegate.mainWindow?.attachedSheet != nil, "Settings sheet did not open")
                    _ = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { _ in
                        MainActor.assumeIsolated {
                            precondition(model.restartingForUpdate && model.baseURL == nil, "Update quit did not stop the service")
                            model.busy = false
                            precondition(!model.canNavigate, "Update handoff must keep navigation frozen after Settings closes")
                            model.settings(); model.newDraft()
                            precondition(!model.showSettings && model.compose == nil, "Update handoff must reject new editable forms")
                            model.perform { fatalError("Update handoff accepted a new operation") }
                            precondition(!model.busy, "Update handoff must reject new operations")
                            let path = ProcessInfo.processInfo.environment["MORROW_QUIT_RESULT"]!
                            try! Data("Automatic update quit passed".utf8).write(to: URL(fileURLWithPath: path))
                        }
                    }
                    // Approve only this fixture's native review, even inside its modal run loop.
                    let approve = Timer(timeInterval: 0.25, repeats: false) { _ in NSApp.stopModal(withCode: .alertFirstButtonReturn) }
                    RunLoop.main.add(approve, forMode: .modalPanel)
                    model.restartToInstallUpdate { _ in
                        fputs("Fixture installer preparation failed\n", stderr)
                        model.stop(); exit(1)
                    }
                    precondition(model.preparingUpdateRestart, "Update handoff must freeze new Settings edits")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                        fputs("Prepared update did not automatically quit: prepared=\(model.restartingForUpdate), sheet=\(model.showSettings), attached=\(delegate.mainWindow?.attachedSheet != nil), modal=\(NSApp.modalWindow != nil)\n", stderr)
                        model.stop(); exit(1)
                    }
                }
        }
    }
}
