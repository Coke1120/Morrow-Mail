# Morrow Mail — contributor guidance

## Communication

請盡量以繁體中文回覆使用者的請求，技術專有名詞可保留原文。

## Scope and structure

This repository is `~/Documents/Github/genmail`. The product name is Morrow Mail.
It is a local, single-user app with native SwiftUI on macOS, WinUI 3/C++/WinRT
on Windows and a Rust service. The owner authorized retiring the React/Electron,
Node service and npm source/tools after beta.18. Preserve their Git history and
fixed historical compatibility CI; source retirement does not waive outstanding
clean-machine, accessibility, signing or live-account acceptance.

- `macos/Sources/MorrowMail/`: SwiftUI views, native client and service lifecycle.
- `windows/`: unpackaged WinUI host, isolated HTML reader and native smoke checks.
- `rust/src/`: storage, authenticated API, providers/OAuth, AI, jobs, search and signed updater.
- `rust/tests/`, `macos/Checks/`, `tests/fixtures/`: native contracts and shared fixture data.
- `scripts/`: native builds/verification and archived compatibility-check preparation.
- `assets/`: branding/fonts; `shared/microsoft-client-id.txt`: public desktop registration.
- `rust/resources/`: versioned catalog/OpenCC data, provenance/notices and pinned update public key. Never rotate that key during migration.
- `package.json`: common product version/metadata only; no npm dependencies or scripts.

See `docs/JAVASCRIPT_RETIREMENT.md` for remaining app-owned reader JavaScript,
security probes and the isolated historical Node test lane. Do not reintroduce a
Node runtime or second database writer into native packages.

## Implementation rules

Reuse existing helpers, SwiftUI controls, and installed dependencies. Keep changes
small and address the shared cause of a bug. Do not add speculative abstractions.
Do not replace the native interface with a web view. Only sanitized message HTML uses an isolated reader: no email scripts, forms, frames, service token or script bridge. Block external images by default; HTTPS images require per-message consent and links require destination review. Preserve plain-text fallback and keep HTML out of AI/list metadata. CID images and attachments remain unsupported.

`settings.mailAccounts` maps an email address to its encrypted connection. Legacy
`settings.mail` is read when the map is absent and retained as a compatibility
pointer. A reconnect must preserve other connections; disconnect removes only
its target's credentials. Keep cached messages and drafts. Email address casing
must not create duplicate connected accounts.

Messages are keyed by `(account, id)` in SQLite. Provider IDs may collide between
accounts: use `viewId` for UI identity and selection, and keep the original `id`
for API/provider operations. Every bound mutation carries `X-Genmail-Account`.
Capture and validate that account before doing work; never route a send or an AI
request through the globally selected view. `all` is a combined read/sync view,
not a sending identity. Demo is internal fixture data, hidden from navigation, settings and sender choices; a fresh workspace shows Add account. Never delete cached user data as an onboarding shortcut.

Replies, forwards, provider-draft copies and saved drafts keep their owner. Reply All excludes the owner and original Bcc; forwarding is unthreaded with blank recipients. Imported Gmail drafts must be copied to a new local draft before editing/sending; leave the provider original unchanged.

Only new unsaved messages may choose a different From account. Keep uncertain-send records and explicit retry review;
never automatically resend. Calendar creation retains its original request ID
and payload across retries and app restarts. Optional calendar reminders belong to that same reviewed payload; absent means provider default and preserves legacy retry hashes. Google supports popup/email, Microsoft popup only. Use provider reminders rather than creating hidden scheduled mail. Month views use civil dates for all-day events and exclusive end dates.
Scheduled sends freeze the reviewed owner, payload, footer, headers and time; lock their
associated drafts until cancelled, send only while the app runs within the 15-minute
late grace, and recover interrupted claims as uncertain without replay. Pending is a
local marker independent of stars and must survive imports. Out of Office changes
are provider-managed writes requiring explicit review and additional OAuth consent;
never replace a connection after partial consent or an obsolete authorization attempt.
Confirmed learning identity is per account and never inferred from signatures.
Reply-suggestion batches require preview/confirmation and may only create drafts;
use permitted downloaded correspondence and source-validated approved writing style.


Keep provider metadata separate from explicit local changes: Gmail imports use
`providerSnapshot` and server-written `localOverrides`. Never trust client-supplied
override markers. Provider moves use actual resulting labels, preserve stable local
identity and clear only the applicable local folder override. Gmail refresh covers
five bounded scopes; All Mail history excludes Spam/Trash and is not a complete mirror.

History retry is only for transient read-fetch network/429/5xx failures, at most
three delays (30/120/300 seconds) with the same checkpoint. Never auto-retry sending,
calendar creation, authentication, malformed/cyclic cursors or database failures.
Public import errors come from the fixed allowlist, not stored provider text;
`nextRetryAt` and `retryCount` are safe status metadata. Activity is observational
and must not trigger AI/provider work or invent coverage percentages.

General preferences auto-save as serialized field diffs; preserve edits made during
an in-flight save and expose retry on failure. Credentials, permissions, paid model
batches and learned-style application keep their explicit review/save controls.
Native read-state refresh retains page, rows and selection. Closing the main macOS
window keeps the scene/service/unsaved work alive; Dock reopens it, while quitting
retains unsaved-edit and active-write guards.

Enforce AI permissions on the server before constructing context. Keep accounts
separate, redact unchecked fields, and discard results when applicable permissions
or connections change. Treat message text as untrusted content. Simulated features
must remain clearly labeled and must not perform hidden provider writes.

Do not log or commit credentials, tokens, database content, or encryption keys.
Keep loopback/host/origin checks, native bearer authentication, PKCE, state, and
browser-bound OAuth callbacks. Do not disable TLS validation. Model endpoints
may use HTTP only on loopback. Public API responses expose safe account metadata,
never connection secrets.

## Build and verify

Use Rust 1.98+ with rustfmt/clippy, Apple's Swift command-line tools on macOS,
and the pinned Windows prerequisites in `windows/README.md`. Normal builds do
not require Node/npm. Run checks appropriate to the change:

```sh
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --locked
/bin/sh scripts/build-macos-native.sh
cargo run --manifest-path rust/Cargo.toml --locked --bin morrow-native-check -- --service "$PWD/build/macos-native/Morrow Mail.app/Contents/Resources/morrow-service"
pwsh -File scripts/build-windows-native.ps1 -Zip
pwsh -File scripts/test-windows-native.ps1 -UiSmoke
codesign --verify --deep --strict 'build/macos-native/Morrow Mail.app'
plutil -lint 'build/macos-native/Morrow Mail.app/Contents/Info.plist'
```

Avoid parallel builds targeting the same output. Inspect free disk space before full builds; `CARGO_INCREMENTAL=0` reduces local accumulation. Generated build cleanup must never touch private workspaces.

Native candidates use `/bin/sh scripts/build-macos-native.sh`, Rust `morrow-native-check --service <candidate-service>`, and Windows `scripts/build-windows-native.ps1 -Zip` / `test-windows-native.ps1 -UiSmoke`. Normal Rust/resource/notice/native checks must work without Node on PATH. Node differential tests are explicitly ignored by the normal Cargo suite and run separately with `MORROW_NODE_COMPAT_ROOT` pointing to fixed beta.16 (`7ab30cbb3e496118513a98f8211ec66481e282c4`). Preserve that CI gate instead of silently omitting historical compatibility. The archived harness is pinned separately in `scripts/prepare-historical-checks.py`; it must exercise current binaries/version/catalog, not archived binaries. See the retirement guide for local commands.

Account-routing changes need coverage for duplicate IDs, combined views,
account-specific sending/AI, reconnect/migration, and disconnect isolation.
Desktop smoke checks must cover both fresh Add account onboarding and an owned fictional mailbox, never depend on visible Demo navigation. Seed and close fixture stores before the Rust writer starts.
Test providers live in isolated temporary workspaces and must never be shipped
in the production app. Use a separate absolute `MORROW_DATA_DIR` for native
acceptance; never use the owner's real workspace for fixtures. Do not send real
mail or create real calendar events as a test without specific authorization.

Swift builds need compiler-cache access and integration tests bind ephemeral
localhost ports. If a sandbox blocks these, report the constraint or use the
provided approval mechanism; do not weaken application security to bypass it.

`build/`, `dist/`, `macos/.build/`, `node_modules/`, `test-results/`, `data/`,
`backups/`, `.env`, and encryption keys are generated/private. Keep them out of
source control. This folder may be inside a parent Git repository: inspect the
Git root and restrict changes to this project; do not initialize or alter an
unrelated repository.

## Documentation and release claims

Keep README.md, FEATURE_COVERAGE.md, and VERIFICATION.md accurate when behavior
changes. Document simulations and limits plainly. Fixture tests do not establish
real-account acceptance. Local ad-hoc signing is not Developer ID notarization;
stable public distribution requires the owner's signing identity, notarization, and
provider verification where applicable. Do not claim error-free operation.

Manual provider organization is separate from local patches and simulations. Require
an explicit mailbox header, server-validated destination, confirmation and provider
write permission. Gmail Spam and Outlook Junk are reviewed provider moves; phishing reports and sender blocking remain provider-site actions, never simulated success. IMAP moves require MOVE + UIDPLUS and matching UIDVALIDITY.
Keep the local message ID stable while recording the provider's destination ID.
To/Cc/Bcc belong to the send fingerprint and uncertain draft; never drop Bcc from
the provider delivery submission or expose it in SMTP recipient-visible headers.
Public alpha and beta releases must explicitly disclose ad-hoc signing and missing live-account
acceptance. Never publish runtime data, fixture workspaces, or secrets.

## Paired release policy

The canonical GitHub repository is `Coke1120/Morrow-Mail`; the local checkout and persisted `genmail` data/API identifiers retain their names for compatibility. Update checks deliberately reject API redirects, so use the canonical repository URL in both runtimes and fixtures. Do not rename persisted files or protocol headers for branding.

Keep package.json as the common version source. Every tagged alpha or beta must build and pass
checks on macOS and Windows before either download becomes public, except the explicit beta.18 test waiver recorded in VERIFICATION.md. Both platform builds and signed provenance remain mandatory. Use the existing
workflow and publisher; never replace published binaries or ship only one platform.
Preserve SwiftUI on macOS, WinUI on Windows and upgrade compatibility with the fixed historical clients. Desktop IPC
must validate the main-frame sender, accept only narrow operations, and never expose
Node, arbitrary filesystem access or private API tokens to the renderer. Calendar
retry IDs and payloads must survive restart on both platforms.

## Desktop update safety

Keep the update signing private key outside source and app bundles; only the pinned
public key is committed. Publish signed manifests only after both platform jobs pass.
Never accept renderer-supplied download URLs, install paths or commands. Installer
preparation requires the host-only update token, and IPC checks the main-frame sender.
Updates must respect pending writes/unsaved edits, wait for both UI/service processes,
retain the previous app and preserve the separate workspace. Use generated fixture
apps/keys and temporary workspaces for install/restart tests, never the owner's data.
