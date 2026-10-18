# Legacy archive

The product is the Electron app at the repository root.

- `host/` is the Electron main process and mail engine.
- `renderer/` is the first-party UI.
- `shared/` is code shared by that app.

`legacy.zip` is archival only. It is the pre-Electron native client (SwiftUI on macOS, WinUI on Windows, and a Rust service), saved from public tip `6b01225` (source labeled 0.8.3) on 2026-10-18. Paths inside the archive start with `legacy/`.

Do not unzip `legacy.zip` for feature work, bug fixes, reviews, or agent context. Do not restore a `legacy/` directory in this tree. Do not treat the Rust, Swift, or WinUI sources in the archive as the current app.
