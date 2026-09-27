<img src="src/assets/brand/morrow-icon.svg" alt="Morrow Mail icon" width="64" height="64">

# Morrow Mail

**An open-source email client for macOS and Windows, with calendars and your choice of AI.**

[![Checks](https://github.com/Coke1120/Morrow-Mail/actions/workflows/check.yml/badge.svg)](https://github.com/Coke1120/Morrow-Mail/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Windows 10/11](https://img.shields.io/badge/Windows-10%2F11-blue.svg)](#windows-desktop-app)
[![macOS 13.5+](https://img.shields.io/badge/macOS-13.5%2B-black.svg)](#native-macos-app)
[![Beta release](https://img.shields.io/github/v/release/Coke1120/Morrow-Mail?include_prereleases&label=beta)](https://github.com/Coke1120/Morrow-Mail/releases)

[Download macOS / Windows beta](https://github.com/Coke1120/Morrow-Mail/releases) · [Feature coverage](FEATURE_COVERAGE.md) · [Verification](VERIFICATION.md) · [GitHub Sponsors](https://github.com/sponsors/Coke1120) · [Buy Me a Coffee](https://buymeacoffee.com/Coke1120)

Morrow Mail is an independent, MIT-licensed alternative inspired by Genspark GenMail. It runs locally with a **fully native SwiftUI macOS interface** and a **React / Electron Windows desktop interface**. Both bundle the same mail service and use the same release version. The React interface also runs in a browser for development. Rust owns the production desktop backend; JavaScript remains for React, the Electron host, build/test tools and the optional Node development service. A full JavaScript rewrite is not required for the Rust desktop migration.

- **Multiple mailboxes:** Gmail, Outlook / Microsoft 365, and IMAP / SMTP; combined or separate inboxes with collapsible account groups, sorting, and compact views.
- **Indexed search:** local full-text search, Chinese traditional/simplified matching, filters, saved searches and optional reviewed semantic indexing in both clients.
- **Mail and calendars together:** read, search, compose, reply / reply all / forward, manage provider folders / Gmail labels, and connect Google Calendar and Outlook Calendar.
- **Bring your own AI:** configure a custom base URL, model ID, and API key for an OpenAI-compatible endpoint or use Ollama. Enable individual AI behaviors and choose what context they can access.
- **Controlled AI automation:** GitHub update checks, daily/interval P0–P4 summaries, opt-in arrival/open/reply triggers, separate response/translation languages, and reviewed writing-style learning.
- **History on your terms:** date-limited or complete history imports, excluding Spam/Trash, pause/resume, body-only style samples and a per-analysis token budget.
- **Agent CLI (from v0.6.0-beta.3):** JSON accounts, cached mail list/search/read, owned drafts and explicitly confirmed sending; works with the app open or closed. See the [CLI guide](docs/CLI.md).
- **Native composition:** To / Cc / Bcc, multiple recipients, replies bound to the receiving account, HTML email footers, keyboard shortcuts, and standard macOS window controls.

AI Studio covers 19 behaviors through model-backed assistance and clearly labeled local simulations. Sending always requires an explicit action; AI does not send email automatically. Local storage does not mean every operation stays offline: connected mail/calendar providers and your configured AI endpoint receive the data needed for enabled actions.

This project is not affiliated with Genspark and does not claim complete parity. See [feature coverage](FEATURE_COVERAGE.md) for implementation status and simulation limits, and [verification](VERIFICATION.md) for completed checks and remaining release validation.

## Screenshots

Captured from the 0.4 development build using fictional messages and isolated provider fixtures. No private mail is shown. These macOS screens show the interface included in the 0.4 alpha line. Windows uses the React interface; it is not a SwiftUI port.

**Combined inbox with collapsible account groups and per-message mailbox labels**

![Morrow Mail native macOS combined inbox, with separate collapsible personal and work accounts, inbox sorting, and a mail reader](docs/screenshots/macos-inbox.jpg)

**Reply from the receiving account, with Cc / Bcc and an HTML footer**

<img src="docs/screenshots/macos-reply.jpg" alt="Morrow Mail native reply composer with the work account locked as sender, To, Cc and Bcc fields, and a formatted HTML email footer" width="690">

## Download the beta

**Upgrading from beta.4 or earlier:** download and install this release manually once. The GitHub repository was renamed to `Coke1120/Morrow-Mail`; those versions reject the old update API redirect. Beta.8 and later use the canonical address and retain signature verification. Back up the workspace and quit the old app before replacing it; keep the separate data directory.

[Download the latest paired beta and checksums](https://github.com/Coke1120/Morrow-Mail/releases). Starting with **v0.4.0-alpha.1**, each release contains both:

| Platform | Package | Interface |
| --- | --- | --- |
| macOS 13.5+, Apple silicon | `Morrow-Mail-<version>-macos-arm64.zip` | Native SwiftUI |
| Windows 10/11, x64 | `Morrow-Mail-<version>-windows-x64.zip` | React in an isolated Electron window |

Both include their runtimes; no Node installation is needed. On macOS, unzip and move **Morrow Mail.app** to Applications. On Windows, extract the **entire folder** and run **Morrow Mail.exe**; keep the accompanying files together.

These are experimental prereleases. macOS builds are **ad-hoc signed, not Apple notarized**; Windows builds are **unsigned** and may show SmartScreen warnings. Review the source and supplied SHA-256 checksum before opening. For macOS, see Apple's [opening an app from an unidentified developer](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unidentified-developer-mh40616/mac) instructions. Stable distribution signing and live-account acceptance remain pending.

## v0.6 beta scope

This beta switches both desktop packages to the shared Rust service, adds bounded inbox paging and ships keyword/optional semantic search. It preserves built-in Google sign-in, controlled AI automation, historical import, reviewed writing-style learning and signed updates. Full provider delta sync, app-wide AI usage budgets, attachments and undo sending remain roadmap items. See [verification](VERIFICATION.md) for release checks and acceptance limits.

**0.6.0-beta.8** adds safe formatted mail, right/bottom/focused reading layouts, reviewed Spam/Junk moves, visible mail/AI activity, recoverable imports and auto-saving General preferences. Demo entries are hidden; Reply All and Forward retain their source account. Embedding settings move to Model with Test Connection and Index Now; Learning adds Learn Now with explicit approval before a style becomes active. On macOS, closing the window keeps Morrow in the Dock. See the [changelog](CHANGELOG.md) for the full beta.8 changes.

**0.6.0-beta.9** adds message-bound AI popups, a compact reader header and expandable summaries, plus **Suggest with History**. Search also exposes the saved embedding connection test. See [verification](VERIFICATION.md) for release status and checks.

**0.6.0-beta.10** adds Today, background indexing navigation, adjustable native panes and View-menu layouts. OAuth errors distinguish temporary failures from required reauthorization, and embedding errors identify safe HTTP/response causes without exposing provider response text. See the [changelog](CHANGELOG.md).

**0.6.0-beta.13** fixes the beta.10 cold-start sidebar occasionally occupying half a restored window. Native panes remain freely adjustable.

## 0.6.0-beta.16 additions

Settings now puts account connection first and separates Chat/reply from Search embedding panels with visible connection tests. Search uses one **Review & Index** entry; Learning shows the account and proposal/approved-style status before its detailed configuration. Yahoo / Yahoo HK has a secure IMAP/SMTP preset and app-password guidance. Updates are checked at launch and hourly while running; a red **!** on Settings opens About when an update is available. Download and installation still require your action. See [Settings navigation](#settings-navigation), the [changelog](CHANGELOG.md) and [verification](VERIFICATION.md).

## 0.6.0-beta.14 additions

- **Month calendar:** display several Google/Outlook calendars with checkboxes, move between months, and click a day to create a reviewed event. Google offers notification or email reminders; Outlook offers notification reminders. These are provider-managed and continue while Morrow is closed.
- **Complete history:** Settings → Mail offers All history, without a date cutoff. All Mail excludes Spam/Trash; imports remain paged, resumable and visible in Activity. It is a downloaded snapshot, not continuous deletion/delta synchronization.
- **Pending:** mark a message Pending in the reader or list menu, then open Pending in that account or the combined view. This local marker is independent of stars, survives refresh, and does not notify or change the provider.
- **Identity and reply suggestions:** confirm your name and aliases per account in Learning. Morrow does not infer your identity from other people's signatures. Reply Suggestions reviews a bounded Inbox batch against that identity and permitted downloaded correspondence; an approved writing style is used only while Email Brain access allows it. Each paid batch needs preview/confirmation, runs in the background, and produces reviewable proposals. Use in Draft never sends. The initial candidate scan covers the latest 200 Inbox messages; a batch defaults to five targets, with at most ten context messages per target and the configured token budget. It cannot guarantee that every unanswered message is found.
- **Out of Office:** read and review Gmail vacation settings or Outlook automatic replies. Saving changes the provider's configuration, so it continues while Morrow is closed. The first use may require explicit additional OAuth consent; IMAP has no equivalent standard and links to the provider instead. No setting is activated merely by opening the tab.
- **Scheduled send:** review an account-owned message and date/time before scheduling. Morrow must be running and connected at delivery time. It sends at most once automatically; within 15 minutes late it may catch up, otherwise the job becomes Missed and needs a new review. Cancel a pending schedule before editing it. Interrupted/uncertain sends retain the existing manual delivery-review flow and are never automatically repeated.

Learning still generates a proposal, not a new model or an automatically active profile. **Save Approved Style** activates the reviewed writing style for permitted writing/reply assistance; it does not overwrite Email Brain contacts or notes. Attachments and CID inline images remain unsupported. Sanitized HTML and explicitly consented external HTTPS images are supported.

## In-place mail assistance

**Summarize**, **Suggest Reply** and **Translate** open a popup over the selected message. You can review or copy the result; **Use in Draft** creates a reply from that message’s original account. AI Studio remains available for broader tools. No AI action sends mail automatically.

**Suggest with History** is a separate, explicit action. It scans all downloaded records in the owning account for the exact correspondent address (case-insensitive), within your allowed AI folders. This includes incoming mail from that sender and your Sent mail addressed to that sender in To/Cc when Sent access is allowed. The selected message stays first; the newest matching messages fill the saved **1–50 message** context limit, including the selected message. The result shows how many permitted messages matched and how many were used. Sender access is required; unchecked subject/body fields stay withheld. Selected bodies are capped at 18,000 UTF-16 characters and historical bodies at 5,000 each. It does not fetch provider history, include other accounts, or analyze an unlimited mailbox. Import older mail first if needed. Changed sources, connections or permissions invalidate a running result.

The reader keeps subject, sender and date/time close together. Expand message details for complete addresses, recipients, mailbox and other metadata; expand a summary to read the full result without another AI request.

## Today dashboard (from beta.10)

Choose **Today** in the sidebar for downloaded unread Inbox / Inbox / Draft totals and this mailbox’s summaries dated today in your local time. Completed jobs use their completion date; queued/running jobs use their creation date. It displays the existing latest 20 reports without starting AI. Combined mail shows totals and asks you to choose an account for summaries; **Summary History** opens AI Studio → Summaries. Enable scheduled or arrival summaries in AI Permissions if no reports exist yet.

From beta.10, Workspace appears above All accounts. The macOS app removes the top title/toolbar area: the sidebar toggle sits beside Morrow, Compose sits below it, Sync is beside View/Sort, reading layout is available in the list and the macOS View menu, and Expand/Restore is in the reader. Drag the dividers to give the sidebar, list or reader more space. Native window controls and close-to-Dock behavior remain available.

## Search and optional smart search

The native and Windows/browser clients share a SQLite FTS5 index covering downloaded subjects, sender/recipients, bodies and labels. Search supports single/two-character Chinese queries, traditional/simplified conversion, mixed English, quoted phrases, relevance/date sorting, 30-result pages, recent/saved searches and removable filters. Results show their owning account, matching text and folder. Replies retain that account.

Choose the current folder, current account view, or all connected accounts under **Filters & Scope**. The combined view excludes Demo and disconnected mail. **Downloaded Coverage** shows cached counts/date ranges; mail that has not been imported cannot appear. Trash and Spam require an explicit folder selection. Inboxes use bounded metadata pages and load bodies when opened; provider delta sync is not implemented.

Use `from:jane@example.com to:me@example.com subject:"project update" after:2026-09-01 before:2026-10-01 is:unread label:Finance`, or the filter controls. Words/conditions use AND; quoted phrases preserve word order. `to:` includes To/Cc/Bcc, `is:` also accepts `read`/`starred`/`pending`, and `in:` accepts local folder names. Date bounds are UTC: `after:` includes that day; `before:` excludes it. Filters narrow the selected scope, so choose account/all scope to search another folder. English word prefixes and normalized exact phrases are supported; arbitrary infix/fuzzy spelling and attachment search are not.

**Settings → Model → Search embedding** configures the separate embedding base URL, model ID, API key and OpenAI-compatible `/embeddings` or Ollama `/api/embed` protocol. **Test Connection** uses the entered fields without saving them and sends only a fixed test sentence, never mail; the model provider may charge for this request. **Settings → Search** controls indexing scopes, budgets and reviewed batches. Smart search defaults off. Select accounts, folders, content fields and 1/3/6/12 months; global AI permissions further restrict the text before any model request. Save, then choose **Review & Index…** in Search to inspect the model, endpoint, scope, token estimate and short excerpts before confirming one batch. Cancel keeps the excerpts on the page without calling AI; use Review & Index again when ready to review and confirm a batch. Only new/changed permitted text is indexed. Each batch respects the global message limit, a 4,000–64,000 estimated-token budget and 50 overlapping text chunks; oversized messages remain keyword-searchable. Estimates are conservative UTF-8 counts, not exact provider billing. New mail needs another reviewed batch; there is no automatically started paid indexing or automatic retry of failed/interrupted batches.

Enable **Smart Search (智慧搜尋)** in the search controls and press **Search**. The query goes to the embedding endpoint; local keyword and vector rankings are merged. Query vectors are cached briefly for pagination. Hybrid results include at most 200 keyword and 200 semantic candidates; use keyword mode for exhaustive results. The initial exact vector scan accepts up to 12,000 scoped chunks and asks for narrower filters above that limit. Retrieval quality depends on your embedding model; it does not generate an answer or establish factual accuracy.

Mail text goes only to the selected embedding endpoint during approved batches; a remote endpoint requires HTTPS. Changed permissions/model/connection invalidate vectors and in-flight results. Vectors stay in the local SQLite database alongside plaintext mail; API keys and search history use the existing encrypted settings store. On Rust desktop, **Pause / Resume / Cancel batch** manage unfinished work while retaining completed valid vectors; resuming requires review. **Clear index** is separate, removes all semantic vectors and cancels the batch, while preserving mail and the keyword index. The Node compatibility service offers Clear index but not independent batch controls. Versions through beta.4 configure the embedding connection under Search; beta.8 moves it to Model.

**From beta.10:** After confirming an indexing batch, you can switch settings tabs, close Settings, and read mail while the service continues the batch. Progress remains in Activity and refreshes when you reopen Search. Morrow must remain running; leaving a page does not cancel the job. Unsaved edits and short save/test/start requests retain their navigation guards.

**From beta.9:** Search also shows the saved embedding model and endpoint, with **Test Connection** for that saved configuration and **Edit in Model…**. The test uses the same fixed sentence without changing settings or the index. Model retains its test for unsaved connection fields. The native inbox also uses compact View/Sort menus and narrower sidebar/list columns to leave more room for reading.

Embedding failures retain completed valid entries. No batch is automatically retried: check the displayed connection, HTTP status, input or vector error, then explicitly preview another batch. A successful connection test validates a short sentence; later mail batches can still encounter provider input limits, quota or availability errors.

OAuth token refresh preserves saved credentials and distinguishes temporary network/provider failure, rejected app configuration and revoked/expired authorization. Only the last category asks you to reconnect. An app update alone is not evidence that provider consent was revoked.

## Native macOS app

The primary interface is **fully native SwiftUI**, including the mail reader, composer, all 19 AI Studio tools, skills, Email Brain, settings, permissions, and Google/Outlook calendars. The application interface remains native; formatted message bodies alone use an isolated, script-disabled WebKit reader. The app bundles the Rust mail service and needs no terminal, Node or Rust installation to run.

Build on a Mac with Apple's Swift command-line tools, Rust 1.98+ with rustfmt/clippy, Node.js 22.13+, and npm:

```sh
npm ci
npm run check
npm run macos:test
npm run macos:rust:test
npm run macos:build
npm run macos:open
```

The result is `build/macos/Morrow Mail.app`. You can move it to Applications. Rust desktop builds target Apple silicon and **macOS 13.5+**; packaging rejects non-system dynamic-library dependencies. An explicit `MORROW_SERVICE_RUNTIME=node` compatibility build still requires an official self-contained Node distribution with its license.

Native data lives in `~/Library/Application Support/Morrow Mail`, separate from the web app's `./data`. Existing web data is not automatically moved. To reuse it, stop both apps, make a verified backup, and restore that backup's database and encryption key into the native data directory before opening the native app. `MORROW_DATA_DIR` can select a separate absolute data directory for development or acceptance testing. Do not run two apps against the same data directory.

The app starts its own loopback service on a random free port and authenticates native API requests with a per-launch secret sent over a private pipe. OAuth browser handoffs use the same PKCE/state/cookie checks as the web app. When the build includes Morrow’s Google registration, click **Sign in with Google in browser** without entering a client ID or secret. **Use my own Google OAuth client** is available under advanced settings. Microsoft sign-in uses Morrow’s built-in public desktop client ID; an advanced custom-client option remains available. Keep Morrow open until sign-in finishes; returning to the app refreshes connections and selects the newly connected mailbox. **Do not open the callback URL manually**: it is only the return address after provider authorization. It is available under **Advanced: callback URL for app registration** in native Settings, with a copy button. The fixed `:3001` examples below describe the web app. Google desktop clients accept loopback ports. Microsoft [ignores the port when matching localhost redirect URIs](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url#localhost-exceptions); register each mail/calendar callback path separately.

Keyboard shortcuts: **⌘N** compose, **⌘,** Settings, **⌘F** search, **⌘R** sync, **⌘⇧R** reply, **⌘⇧M** provider Move / Labels, **⌘⇧A** local archive, **⌘⇧U** local read/unread, and **⌘1/2/3** Inbox / AI Studio / Calendar. In the composer, **⌘S** saves a draft and **⌘⇧D** opens send review. **Esc** cancels. Standard macOS **⌘M**, **⌘W**, **⌃⌘F**, and the red/yellow/green title-bar controls minimize, close, resize, and enter full screen. **Window → Window Size** offers compact, standard, wide and Fill Available Screen sizes; the window also resizes by dragging its edges and restores its saved size.

The inbox's **View** menu selects Compact, Comfortable, or Spacious rows. **Sort** offers newest, oldest, sender, subject, unread-first, and starred-first; both choices persist across launches and apply to individual and combined views. The red close button and ⌘W hide the main window while the app remains in the Dock, retaining drafts and in-flight work. Click the Dock icon to reopen it; ⌘Q quits with the existing unsaved-edit and active-write guards. **Layout** selects a right, bottom or focused reader, and **Expand Reader** gives the message the full content width. Preferences include native light/dark/system appearance and mail density.

Native **Settings → About → Back Up Workspace** creates a verified backup including any pending calendar request. Calendar creation persists its original request ID and details before writing to the provider, so a restart can recover an uncertain attempt. Review the provider's calendar before resolving a pending request.

Builds are ad-hoc signed for local use. A stable public distribution requires your Apple Developer ID certificate, hardened-runtime signing and **Apple notarization**. Public prereleases remain unnotarized. Set `MORROW_SIGNING_IDENTITY` to your Developer ID identity for signing; the script does not submit anything to Apple. The app is not App Store sandboxed. Live provider acceptance testing and signing/notarization are release requirements, not claims made by the local build.

## Windows desktop app

The Windows package reuses the React interface and the same provider, account-routing, AI-permission and calendar service as macOS. It has standard minimize/maximize/close controls, remembered window size, and an isolated renderer with no Node access. The bundled backend uses a fresh loopback port and private bearer token on every launch; credentials and the token are not exposed through the desktop bridge.

Data lives in `%APPDATA%\Morrow Mail`. Sidebar disclosure and pending calendar requests persist across app restarts. Windows uses the current user's profile permissions; Unix file-mode checks do not represent Windows ACLs. Account data is local to each installation; paired releases do **not** synchronize mail caches, credentials or preferences between computers.

The **Sign in … in browser** button opens the system browser. Keep Morrow open, finish authorization, then return to Mail or Calendar Settings. Connections refresh on return when there are no unsaved edits or in-flight operations; **Refresh connections** remains available. The callback in Advanced settings is for provider registration, not a link to start login. Keyboard shortcuts include **Ctrl+N** compose, **Ctrl+F** search, **Ctrl+,** settings, **Ctrl+R** sync, **Ctrl+Shift+R** reply, **Ctrl+1/2/3** Inbox / AI Studio / Calendar, **Ctrl+S** save draft, and **Ctrl+Shift+D** send review.

Build on Windows x64 with official Node.js 22.13+, npm, Rust 1.98+ with rustfmt/clippy, and the Microsoft C++ build tools:

```sh
npm ci --ignore-scripts
npm run check
npm run windows:build
npm run desktop:test -- --packaged
node scripts/package-release.js
```

The runnable folder is `build/windows/Morrow Mail-win32-x64`; the distributable ZIP and SHA-256 checksum are in `build/release`. The packaged smoke test uses a fresh temporary demo workspace and sends no real mail. Desktop-shell development can be checked on a Mac with `npm run build` followed by `npm run desktop:test`; this does not replace Windows verification.

For a Windows backup, quit Morrow Mail, open PowerShell inside the extracted app folder, and run:

```powershell
$workspace = Join-Path $env:APPDATA 'Morrow Mail'
& '.\resources\app\runtime\morrow-service.exe' --backup $workspace 'C:\path\to\new-backup-folder'
```

## Keeping platform releases aligned

`package.json` is the version source for both apps and archive names. Pushes and pull requests run backend/web checks on Ubuntu, macOS and Windows. macOS also compiles and tests SwiftUI; Windows builds and launches its packaged `.exe`. Tag and manually dispatched builds upload both packages as short-lived CI artifacts; published release downloads remain available.

To publish a new alpha or beta, update the changelog and verification notes, bump the package version with `npm version <version>-<alpha|beta>.<number> --no-git-tag-version`, commit, then push the matching `v<version>-<alpha|beta>.<number>` tag. The workflow builds both platforms from that **same tag**. It verifies both archives and their checksums, signs a two-platform update manifest, uploads all six files to a draft release, and makes the release public only after every platform job succeeds. Failed builds publish no partial release; failed uploads leave a draft. Published assets are never overwritten.

The release job requires `MORROW_UPDATE_SIGNING_KEY` in GitHub Actions secrets. Its Ed25519 public key is pinned in `server/update-public-key.pem`; only the public key belongs in Git. The current private signing key is kept outside the repository at `~/.config/morrow-release/update-signing-key.pem`. Keep a secure backup: losing it prevents existing apps from accepting new update manifests. Do not rotate or replace the public key casually; a key change needs a transition release signed with the existing key. `npm run updater:test` uses generated fixture keys and temporary apps, never this release key or a real workspace.

Every change is checked; versioned tags publish paired downloads. Unsigned automation accepts numbered alpha and beta versions; stable and release-candidate tags are rejected. Native UI differences remain explicit in [feature coverage](FEATURE_COVERAGE.md); API changes must preserve both clients.

## Rust desktop service

The Rust backend implements storage, the local API, Gmail/Outlook OAuth and mail, IMAP/SMTP, calendars, AI/workflows/learning, background imports/summaries, keyword/semantic search, and signed desktop updates. SwiftUI and React use bounded metadata pages, SQL counts, on-demand bodies and revision checks. Rust is the desktop default from 0.6.0-beta.1 following explicit prerelease cutover approval; remaining stable-release gates are recorded in [VERIFICATION.md](VERIFICATION.md).

```sh
npm run rust:test
npm run macos:rust:test                  # macOS: actual native client + isolated Rust service
MORROW_SERVICE_RUNTIME=rust npm run macos:build
# Windows PowerShell:
# $env:MORROW_SERVICE_RUNTIME = 'rust'; npm run windows:build
# npm run desktop:test -- --packaged
npm run benchmark:rust-service -- --output=test-results/migration-rust-service.json
```

Desktop bundles contain `morrow-service` instead of a backend Node runtime. Rust fails closed if it cannot start; it never falls back to a second writer. Windows still uses Electron and its internal Node runtime. The [native migration plan](docs/RUST_NATIVE_MIGRATION_PLAN.md) targets WinUI 3/C++/WinRT after separate parity, deployment and upgrade acceptance. Build selection is recorded in bundle metadata, not accepted from the renderer. `package.json` remains the version source. The locked Rust build requires Rust 1.98+, rustfmt/clippy and a C compiler; bundled third-party notices accompany the executable. Node remains available for browser development and explicit compatibility builds.

The first unreleased native-migration change moves Reply, Reply All, Forward and provider-draft copying into the local service. Both clients request an unsaved draft using the original message ID and explicit mailbox owner; desktop builds use the Rust implementation. This does not contact a provider or model, save a draft or send mail. Saved drafts keep their existing editing and delivery-review paths. Node browser/compatibility service retains the same API until its planned retirement.

On the first Rust open, the service locks the workspace against both Rust and legacy SQLite writers, verifies the existing key, and makes a consistent backup before migration. Mail, drafts, send-review records, calendar retry IDs and the AES-256-GCM settings format are preserved. It never restores an old database automatically during binary rollback. Interrupted paid jobs stop for review; legacy semantic vectors require a reviewed rebuild.

The macOS Back Up Workspace control creates a consistent snapshot while the service runs. For a command-line desktop backup, quit the app and run its bundled executable with **absolute** workspace and new destination paths:

```sh
'/path/to/Morrow Mail.app/Contents/Resources/morrow-service' --backup '/absolute/workspace' '/absolute/new-backup'
# Windows: .\resources\app\runtime\morrow-service.exe --backup C:\absolute\workspace C:\absolute\new-backup
```

The older development-only read worker remains available with `MORROW_SEARCH_ENGINE=rust`; Node owns its writes and falls back locally on worker failure. It is separate from the complete Rust service. Compare that pilot with `npm run benchmark:mail -- --engine=rust`; compare the full service with `benchmark:rust-service`. All benchmarks use fictional temporary data, without provider or model calls.

See [the migration plan](docs/RUST_MIGRATION_PLAN.md) and [compatibility inventory](docs/RUST_MIGRATION_INVENTORY.md) for limits and acceptance evidence. Fixture tests do not establish live-account acceptance or Developer ID notarization.

## Web development interface

Requires **Node.js 22.13 or newer** and npm. SQLite is built into Node; no database service is needed.

```sh
cd ~/Documents/Github/genmail
npm install
npm run dev
```

Open <http://localhost:5173>. The API runs at <http://localhost:3001>. The app starts with an empty Add account screen; connect Gmail, Outlook, or IMAP to read your mail.

For a checked production build served locally:

```sh
npm ci
npm run check
npm start
```

Open <http://localhost:3001>. The server binds to loopback (`127.0.0.1`). Check its health with `curl --fail http://localhost:3001/api/health`. Run tests separately with `npm test`; `npm run check` runs tests and the production build.

This deployment is a local, single-user process. Public hosting and shared access are not supported; a production build does not add user authentication or establish production certification. Live provider acceptance testing still requires your own accounts.

## Connect a mailbox

Open **Settings → Mail** and select a provider. Connect as many mailboxes as you need, including multiple accounts from the same provider. Use **Add Another Account** for the next connection. Builds can include Morrow’s Google Desktop OAuth registration for Gmail and Google Calendar. Those builds show a Google sign-in button without credential fields; custom Google registrations remain an advanced option. Source builds without the Google configuration require your own Google app registration; Outlook uses the bundled public Microsoft client by default. Authorization and token exchange run locally; there is no hosted OAuth service.

The native sidebar includes **All accounts** with combined folders, then separate folders under each connected email address. Both clients group folders under each account. All accounts and individual accounts can be collapsed independently; each client remembers its disclosure state. Combined mail defaults to newest first and supports the selected sort order and shows each message’s mailbox. The current source removes Demo from account navigation, Settings and sender choices. A saved Demo selection switches to the first connected mailbox; without accounts, the app shows Add account. Internal sample data remains available to isolated tests.

**From** chooses the account for a new message. Replies, Reply All, forwards, saved drafts, and uncertain deliveries stay with their original account. Reply All combines sender/To/Cc, excludes your address and deduplicates recipients without copying Bcc. Forward starts with empty recipients and quotes the original plain text; attachments are not included. AI actions on a selected message use that message’s mailbox; choose an individual account for mailbox-wide AI Studio tools, skills, and Email Brain. No AI request combines account histories.

Sync refreshes the selected mailbox, or every connected mailbox from **All accounts**. A failure in one combined sync is reported while successful accounts keep their updates. Disconnect removes only the chosen account’s credentials. Cached mail, drafts, and account-specific workspace records remain on this Mac and return when the same email address reconnects. Disconnected accounts are excluded from combined views. Reconnecting an existing address updates its connection rather than adding a duplicate.

Existing single-mailbox installations are supported automatically, preserving their connection and cached mail. The last selected real account or combined view is restored on restart; each message action carries its own account identity so switching views cannot redirect a draft or send.

### Gmail

If Settings says **Google sign-in is ready**, click the browser sign-in button. The publisher manages the Cloud setup below; ordinary users do not need to register an app. Built-in Google sign-in is included starting with `v0.5.0-beta.1`; older alpha downloads require a custom registration. These setup steps apply to publishers, source builds, and the advanced custom-client option:

1. Create or select a project in [Google Cloud Console](https://console.cloud.google.com/) and enable the **Gmail API**.
2. Configure the OAuth consent screen. For an external app in testing, add your Google account under **Test users**.
3. To enable provider moves, check **Allow moving mail and managing labels** in Settings and configure `https://www.googleapis.com/auth/gmail.modify`. Without that option, configure these scopes: `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/gmail.send`, `openid`, and `email`.
4. Create an OAuth client with application type **Desktop app**. Copy its client ID and client secret into Morrow's Gmail settings, then connect and sign in.

The local callback is `http://localhost:3001/api/oauth/google/callback`. Desktop clients use a loopback callback; they do not use the web-client redirect URI configuration.

Google external apps in testing receive [refresh tokens that expire after seven days](https://developers.google.com/identity/protocols/oauth2#expiration) for these Gmail scopes, requiring reconnection. Publishing an app for other users can require Google's verification process. See the [Gmail API setup guide](https://developers.google.com/workspace/gmail/api/quickstart/nodejs) and [desktop OAuth documentation](https://developers.google.com/identity/protocols/oauth2/native-app).

### Additional Google permissions

Use the existing **Desktop app** OAuth client; another client ID or JSON is not needed. If you use Morrow's built-in client, its publisher must configure the Google project; if you supplied a custom client, do this in that project:

1. In **Google Auth Platform → Data Access**, add the scopes used by the feature. Out of Office requires `https://www.googleapis.com/auth/gmail.settings.basic`; Calendar requires `https://www.googleapis.com/auth/calendar.calendarlist.readonly` and `https://www.googleapis.com/auth/calendar.events`. Enable the Gmail/Google Calendar APIs as applicable.
2. Under **Audience**, keep your Google account in Test users while the app is in Testing. For public use, complete the required sensitive/restricted-scope verification. Adding a scope in the console does not grant access to an already connected account.
3. In Morrow, choose the owning mailbox → **Out of Office → Allow Out of Office Settings…**, or **Settings → Calendar → Sign in with Google in browser**. Finish browser consent with the same intended account. Mail and calendar grants remain separate; existing mail, drafts and other accounts are retained.

Calendar reminders use the event-write scope already requested by Calendar; they need no extra email-send permission. For Out of Office, consent alone does not activate the vacation response: review and save its settings separately. See Google's [scope verification guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) and [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth).

### Google registration for desktop builds

Provide a downloaded **Desktop app** OAuth JSON file when packaging, for example:

```sh
MORROW_GOOGLE_OAUTH_FILE=/absolute/path/google-desktop-client.json npm run macos:build
```

The Windows builder accepts the same environment variable. CI uses the repository Actions secret **`GOOGLE_DESKTOP_OAUTH_JSON`** for both platforms; tagged builds fail if it is missing. Local/fork builds without a build input keep the custom-client flow. The JSON must contain an `installed` client; web-client credentials are rejected.

The build embeds only the Desktop client ID and secret in the private backend bundle, not the renderer or public API. Installed-app credentials can be extracted from the distributed package and are not confidential server secrets. Never put user access/refresh tokens in this input. The raw downloaded file and generated `google-oauth.json` must stay out of Git.

The publisher must enable Gmail and Calendar APIs, configure the consent screen and test users, and complete any required Google verification. Bundling a client does not verify these Cloud settings or lift Testing restrictions. Users still authorize their own Google accounts in the browser.

### Outlook / Microsoft 365

From v0.6.0-beta.4, click **Sign in with Microsoft in browser** for mail or Outlook Calendar. No client ID, secret or JSON is required from users. Morrow’s public desktop registration is shared by both clients and both services through `shared/microsoft-client-id.txt`; it contains no secret. 0.6.0-beta.3 and earlier packages still use the manual setup.

For a custom registration, select **Use my own Microsoft OAuth client** under Advanced and follow these steps:

1. In [Microsoft Entra app registrations](https://entra.microsoft.com/), register an application. Select **Accounts in any organizational directory and personal Microsoft accounts** to support both work/school accounts and personal Outlook accounts.
2. Under **Authentication**, add the **Mobile and desktop applications** platform with the custom redirect URI `http://localhost:3001/api/oauth/microsoft/callback`. Enable public client flows.
3. Add Microsoft Graph **delegated** permissions `User.Read`, `Mail.Read`, and `Mail.Send`. To enable provider moves, add `Mail.ReadWrite` and check **Allow moving mail and managing labels** in Settings. Reconnect existing accounts after changing permissions. Morrow also requests `offline_access` to refresh the connection.
4. Copy the application/client ID into Morrow's Outlook settings, then connect and sign in. This public desktop client does not require a client secret.

Microsoft uses a client ID, not a downloaded Google-style credentials JSON. The same app registration can serve mail and calendar: also register `http://localhost:3001/api/calendar-oauth/microsoft/callback` and add delegated `Calendars.ReadWrite` for calendar access. Native localhost redirect matching ignores the port but preserves the path, so Morrow’s random desktop port does not need a separate registration. The built-in client is selected by default; these registration details are for publishers and advanced custom clients. See Microsoft’s [desktop registration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration) and [loopback redirect rules](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url).

Your organization may require administrator approval for consent or restrict app registration. See Microsoft's [app registration guide](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app), [platform configuration](https://learn.microsoft.com/en-us/graph/auth-register-app-v2), and [Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference).

### IMAP / SMTP

Enter your email address, mailbox password or provider-issued app password, and the provider's server names in Settings. Use TLS IMAP, normally port **993**. SMTP supports **465** with TLS or **587** with STARTTLS. Providers must permit password/app-password authentication; use the OAuth options above for Gmail and Outlook.

IMAP retrieves mail; SMTP sends it. Use your provider's documented hostnames instead of guessing them.

### Yahoo Mail / Hong Kong

Yahoo Mail, including `@yahoo.com.hk`, uses the existing IMAP/SMTP connection. In **Settings → Mail → Yahoo / IMAP**, choose **Use Yahoo Mail / HK Settings**, enter the full email address and a Yahoo **app password**, then choose **Connect & Sync**. The preset keeps the address, fills `imap.mail.yahoo.com:993` and `smtp.mail.yahoo.com:465` (TLS), and clears any password typed for the previous servers. Custom IMAP and SMTP port 587/STARTTLS remain available.

Create the app password in Yahoo Account Security, following [Yahoo’s app-password guide](https://hk.help.yahoo.com/kb/SLN15241.html); do not enter your ordinary Yahoo sign-in password. See [Yahoo Hong Kong’s IMAP settings](https://hk.help.yahoo.com/kb/SLN4075.html). App-password availability is controlled by Yahoo. Morrow currently uses password-based IMAP/SMTP for Yahoo, not Yahoo browser OAuth, calendar integration or server-managed Out of Office. The preset is covered by local checks; a real Yahoo HK account has not been verified.

### Settings navigation

Settings groups Mail and Calendar connections before Model and AI Permissions. Mail starts with an Add or reconnect account disclosure and connected-account status; expand New import range to choose history for your next connection or import. Existing cached mail is retained.

Model separates **Chat & replies** from **Search embedding**, with independent test/save controls. General preferences save automatically; AI permissions still require **Save Permissions**, with Discard available. Search uses **Review & Index** before any paid batch; Rust desktop batches can be paused, resumed with confirmation, or cancelled without clearing completed valid vectors. **Clear index** is a separate destructive action. Learning shows the current account and proposal/approved-style status first; identity and learning configuration are separate disclosures, and a generated proposal still requires explicit approval. Calendar supports one Google and one Outlook connection, each with multiple calendars. About labels the previous installer result as history, separate from the installed version.

## Compose and organize

To, Cc and Bcc accept up to **100 plain email addresses total**, separated by commas or semicolons. At least one address is required across the three fields; Bcc-only sends are supported. Display-name/group syntax is not accepted. Duplicate addresses are delivered once. Cc/Bcc survive saving and uncertain-send recovery. Review shows all recipients; SMTP Bcc stays in the delivery envelope, and Gmail/Outlook receive it in the API MIME submission for provider delivery.

Select an imported message and choose **Move / Labels** (or its context menu). The app loads destinations from that message's account, then requires review before writing:

- **Gmail:** move to a custom label (add it and remove Inbox), return to Inbox, archive, or add/remove a custom label while retaining Inbox status. Other labels remain intact. Reconnect with the organization permission enabled.
- **Outlook:** move to existing folders and nested folders within the same mailbox. Requires delegated `Mail.ReadWrite` permission.
- **IMAP:** move to an existing selectable folder. The server must support **MOVE and UIDPLUS**; Morrow validates UID validity and retains the destination UID to avoid acting on a different message.

The destination limits are 1,000 Gmail labels and 300 Outlook/IMAP folders. Creating/deleting folders or labels, cross-account transfers, bulk moves, and full destination-folder synchronization are not included. Moved cached messages outside Inbox appear under local Archive, with their provider location in the reader. These manual provider writes are separate from local read/star/archive/trash shortcuts and AI Studio simulations. A failed or lost response requires checking the provider before trying again; there is no automatic move retry.

Provider semantics: [Gmail modify](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify), [Outlook move](https://learn.microsoft.com/en-us/graph/api/message-move?view=graph-rest-1.0), and [Outlook immutable IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id).

## Connect calendars

Open **Settings → Calendar** to connect providers, or use **Connections** on the separate Calendar page. You can connect **Google Calendar and Microsoft Calendar at the same time**, independently of your mail accounts. Calendar connections currently support one Google account and one Microsoft account; each can expose multiple calendars. Calendar connections also work before adding a mail account. The Calendar page opens a month grid. Use the calendar checkboxes to display up to **12 calendars** together, including read-only calendars; change month or choose Today. Events crossing midnight appear on each affected day, while all-day end dates are exclusive. A busy or unavailable calendar shows its own error; a failed/truncated response is not shown as complete. The underlying API accepts ranges of up to **90 days**. Outlook all-day events converted away from midnight are reread in their provider-reported original timezone (at most 100 repairs per calendar request, four at once); unrecognized/custom zones or excess repairs show an incomplete-calendar error instead of guessing a date.

Click a date, choose a writable checked calendar, enter the details, then review the destination, date/time and reminder before submitting. Reminder choices are the calendar default, none, notification, or **email for Google only**, from event start to four weeks before. Google sends the reminder to the connected calendar user; it is not an attendee invitation or a Morrow scheduled email. Outlook exposes a notification reminder, not an email reminder. Calendar-provider and device notification settings still determine delivery. Morrow can be closed when the reminder is due. Events are created without attendees; Morrow does not send invitations. Calendar access is separate from AI Studio: its simulated scheduling and meeting-preparation features do not read these live calendars or create live events.

### Google Calendar

A build with Google sign-in configured uses the same built-in Desktop client as Gmail. Choose **Sign in with Google in browser** in Calendar settings; calendar consent remains separate from mail consent. The following setup is for the publisher or a custom-client user:

1. In your Google Cloud project, enable the **Google Calendar API**. You can reuse the Gmail project's **Desktop app** OAuth registration.
2. Configure the consent screen and add your account as a test user when the app is in testing.
3. Add `openid`, `email`, `https://www.googleapis.com/auth/calendar.calendarlist.readonly`, and `https://www.googleapis.com/auth/calendar.events` to the app's requested scopes.
4. Enter the desktop client ID and secret in **Settings → Calendar → Google Calendar** and sign in.

The calendar callback is `http://localhost:3001/api/calendar-oauth/google/callback`. Desktop clients use the local loopback callback rather than a web-client redirect list. These calendar scopes permit listing calendars and reading/writing events; the seven-day testing-token caveat described above also applies. See Google's [Calendar setup guide](https://developers.google.com/workspace/calendar/api/quickstart/nodejs) and [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth).

### Microsoft Calendar

1. Create or reuse a Microsoft Entra app registration that supports **work/school and personal Microsoft accounts**.
2. Under **Authentication → Mobile and desktop applications**, add `http://localhost:3001/api/calendar-oauth/microsoft/callback` and enable public client flows. Keep the mail callback too if using the same app for Outlook mail.
3. Add Microsoft Graph **delegated** permissions `User.Read` and `Calendars.ReadWrite`. Morrow also requests `offline_access` for refresh tokens.
4. Enter the application/client ID in **Settings → Calendar → Outlook Calendar** and sign in. No client secret is required.

An organization may require administrator approval. Microsoft's [event creation documentation](https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0) confirms the delegated permission and explains that adding attendees sends invitations; Morrow's creation flow does not include attendees. See the [Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference) for scope details.

## Connect AI

In **Settings → Model**, enter your own OpenAI-compatible **base URL**, **model ID**, and **API key**. The key is optional for endpoints that do not require one. Configure the output token limit and temperature for models that support those parameters.

**Test connection** sends a fixed test prompt with no email content and does not save your changes. Save separately. Blank API-key input retains the saved key only when the base URL is unchanged; changing the endpoint requires its own key. Use the remove-key control to clear it.

For a local [Ollama](https://ollama.com/) model:

```sh
ollama pull qwen3:8b
```

Use base URL `http://127.0.0.1:11434/v1` and model `qwen3:8b` while Ollama is running. You can substitute another model you have installed. Remote providers must use HTTPS and may require an API key.

Summaries, replies, inbox questions, writing, rewriting, translation, briefings, and custom skills use the configured model when invoked. Model-backed assistance requires a configured model. Isolated demo fixtures return labeled illustrative results.

## Gmail coverage and activity

Gmail refresh checks up to 50 recent messages in each of Inbox, Sent, Drafts, Starred and All Mail, deduplicating overlaps. In **Settings → Mail**, select **All Gmail mail** and start a 1/3/6/12-month history import to page through older mail, including archived messages and custom labels. Spam and Trash are excluded from these provider fetches. Existing imports keep their saved scope until restarted.

User label names appear on downloaded messages. To find a label across folders, choose **Filters & Scope → Current account view → Label**. A message has one primary local folder (Trash, Spam, Drafts, Inbox, Sent, then Archive); Starred is a separate view. This is bounded downloading, not a complete Gmail mirror or deletion reconciliation. Explicit local read/star/folder changes remain local. Imported Gmail drafts can be copied into an owner-bound local draft; attachments are not copied and the Gmail original is not updated or removed.

The **Mail and AI activity** control updates independently every two seconds while the app is active. Expand it for each account's fetching, history pages/messages, queued/running AI summaries, learning and embedding indexing, plus paused or failed work. Unknown totals are not shown as percentages. Idle does not mean the whole mailbox has downloaded; older mail depends on the import range, and AI runs only under its existing permissions and triggers.

## Reading and mail safety

Newly fetched Gmail, Outlook and IMAP messages retain sanitized formatting and links alongside their plain-text body. Existing cached messages need to be fetched again to gain HTML; plain-text links already work. The reader blocks scripts, forms, embedded pages and external images by default. You can load HTTPS images for one message after a tracking warning, or switch to plain text. Links show their destination for confirmation before opening outside the reader. Inline attachment/CID images and attachment viewing are not implemented. These controls reduce active-content and tracking risks; they do not certify a message or destination as free of phishing or malware.

Use **Move / Labels / Spam** to move a downloaded Gmail or Outlook message to the provider's Spam/Junk folder, with existing write permission and explicit confirmation. Moving Gmail mail back to Inbox removes its Spam label. This is a manual provider operation, not a local shortcut or a complete Spam-folder sync. Morrow does not implement phishing reports or sender blocking; the dialog links to the provider website for those actions. Spam stays outside default search and AI context.

Mail settings and Activity show import progress, safe failure reasons and recovery actions. Temporary network or 429/5xx errors during a read-only history fetch retry at most three times after 30, 120 and 300 seconds, preserving the checkpoint. Authentication, malformed pages, invalid cursors and database errors require explicit recovery. Pause/Resume keeps the cursor; restarting replaces the import. Old unexplained failed imports require Resume and are not silently restarted.

## Permissions and settings

**Settings → AI permissions** has a master switch and a checkbox for every behavior. Choose permitted folders, message fields, contextual data, and the maximum message count. These permissions are enforced on the server before AI or simulation input is assembled; unchecked fields are excluded from context and search. Turning off AI leaves manual reading, composing, sending, and Calendar-page actions available.

Model settings, permissions, and general preferences are **global across connected accounts**. Mail, drafts, skills, and workflow records belong to an individual account. Folder permissions apply to locally cached messages. Choose the history scope separately in Mail settings; enabling an AI scope alone does not download a folder. All Mail history includes archived mail for Gmail, Outlook and IMAP in current source. IMAP exclusions depend on advertised Junk/Trash special-use folders; virtual All/Flagged collections are skipped to avoid duplicates.

General settings include your display name, plain-text or HTML signature, theme, density, mark-read-on-open behavior, reply tone, preferred AI response language, independent target translation language (blank follows the preferred language), and sync interval. General preferences save automatically after editing, with visible saving/error status and retry on failure; other credentials, permissions and reviewed actions retain their explicit controls. These language settings control AI output, not UI localization. Timed mail sync checks all connected accounts every 1, 5, 15 or 30 minutes while the service is running; it defaults to manual. Review generated text before inserting it into a draft.

**Morrow checks for updates at launch and every hour while running**, including when Settings is closed. Returning after sleep checks again if the hour has elapsed. A red **!** badge on the Settings button indicates an available update; clicking it opens **About → App updates**. **Check for updates** also works manually. These checks use public releases in `Coke1120/Morrow-Mail` on GitHub. Prerelease builds initially include alpha/beta releases; uncheck that option to check stable releases only. The app compares semantic versions among the latest 100 published releases, shows the installed/latest version and check time, and opens the release downloads page. Checks share no mail or credentials, time out after 10 seconds, and cache successful results for one minute. Offline, rate-limit and empty-channel responses are shown as errors, not as “up to date.” A failed check keeps the last known release and badge; the next automatic attempt waits an hour. Changing release channels clears the previous channel’s result. Downloading and installation still require your action. Packaged desktop builds from **0.5.0-beta.2** offer **Download update → Install & Restart**. Install an updater-enabled build manually once; older apps cannot acquire this feature themselves. The browser development interface keeps manual downloads.

Downloads use the project's GitHub release assets and verify a pinned Ed25519 signature, exact version/platform, size and SHA-256 before extraction. The app checks archive paths and macOS compatibility/signing, then offers installation. Save or discard edits first; active writes block closing. Installation waits for the UI and private service to stop, replaces only the application, and reopens it automatically. Mail, accounts, preferences and uncertain-operation records stay in the separate data folder. Updates are not installed silently on ordinary quit.

The installation's parent folder must be writable; Morrow never requests administrator elevation. Otherwise use the release downloads. Failed replacement or immediate launch errors restore the previous app; a later crash after a successful launch still needs manual recovery. The previous app remains in the sibling hidden `.morrow-update-…/previous` folder. Keep it until the new version works, then remove that old backup if desired. Interrupted/power-loss installs may require restoring this backup manually. Signature verification does not replace Apple notarization or Windows signing.

**Settings → AI permissions → When assistance starts** provides four independent, default-off triggers:

- Summarize when a message opens.
- Suggest text when a new, empty reply opens. Saved drafts and uncertain sends are excluded; inserting text requires a click and preserves recipients and the footer.
- Summarize newly synced messages. Runs after manual or automatic sync discovers new provider IDs; connecting/reconnecting does not summarize the initial imported inbox. This is polling, not provider push. Use General → Refresh connected mailboxes for automatic checks.
- Generate scheduled summaries: daily at a 24-hour time in a saved IANA time zone (for example `09:00`, `Asia/Hong_Kong`), or every **1–168 whole hours**. Results appear under **AI Studio → Summaries**; completed arrival summaries also appear in the message reader.

**Only messages in Inbox** (default on) and **Only starred messages** must both match when checked. Behavior, folder and content permissions also apply before context reaches the model. Drafts and Trash are excluded. Settings apply globally but jobs and results remain account-specific, including in combined views. Demo jobs run only when no real mail account is connected. No trigger sends mail, inserts drafts, creates events, moves mail, or updates Email Brain automatically. Remote models may charge for requests. Opening messages/replies again can make another request; overlapping identical UI requests are coalesced. The reader reuses a retained, valid arrival summary when available.

Scheduled jobs use the **newest cached permitted messages, capped at Maximum messages per request (8 by default, 50 maximum)**. They are a bounded digest, not an exhaustive inbox audit. Each automatic report validates one P0–P4 classification per included message: **P0 explicit emergency; P1 explicit action due today; P2 normal action/follow-up or unclear urgency; P3 information; P4 bulk/promotional**. The selected time zone defines today. These are AI suggestions, never a guarantee of urgency. Models must return valid JSON with every source ID; incomplete output fails rather than showing a partial report. Increase response tokens or reduce the context limit if needed. Demo reports are clearly illustrative and do not perform real priority analysis.

The local service checks schedules every 30 seconds, processing at most four queued model calls serially per tick. Both desktop clients use this same scheduler. The app must remain running; browser development uses the running server. After sleep/restart a daily schedule catches up once for the current day, not every missed day; intervals use persisted attempt times and do not replay missed intervals. Changing/enabling the schedule resets its timing. Daily jobs run at most once per local date, including DST repeated hours; a missing DST time runs after the gap. Failed or interrupted calls are not automatically retried, because they may already have spent tokens. Generate a manual briefing if needed.

The queue holds at most 100 pending jobs per account, retains up to 20 completed/failed/interrupted reports, and shows a counter for overflow requiring manual handling. Summaries displays the latest 20 jobs; it refreshes every 30 seconds when the client is idle and has a manual Refresh button. Results are hidden/discarded when model, AI language/tone, policy, owning connection or permitted source content changes. Turning off triggers keeps manual AI available. No OS notification or system background service is installed.

### Historical import and writing-style learning (v0.5 alpha)

In **Settings → Mail**, choose **All history** or **1, 3, 6 or 12 calendar months** (default 3), then **All Mail** or individual **Inbox / Sent** scopes before connecting. Existing accounts can use **Start chosen import**. This downloads mail locally without any AI calls. Progress, pause and resume are per account; read-only pages checkpoint to disk and resume after restart. Refresh progress in Settings. Importing a shorter range never deletes cached mail. Historical import does not generate new-mail summaries. IMAP Sent requires the server to advertise its `\Sent` special-use folder; if unavailable, select Inbox only or configure Sent on the provider. Large IMAP messages still use the existing 5 MB body ceiling. Gmail/Outlook page tokens and IMAP UIDVALIDITY are checked; a changed IMAP folder requires a fresh import.

In **Settings → Learning**, select an individual connected account and optionally enable **Learn my writing style**. This requires the global AI switch, Email Brain behavior, Sent scope and body permission. It does **not** require Contacts, Subject or Sender permission: only cleaned body samples go to the model; ownership and diversity selection happen locally. Contact/project notes remain separate. Learning can be skipped entirely.

1. Save the learning range, sample cap (**1–50**) and per-analysis token budget (**4,000–64,000**, default **16,000**). The global **Maximum messages per request** also applies (default 8; raise it explicitly if desired).
2. **Preview samples** uses no AI. It filters sent mail authored by the account, excludes recognized automatic mail, deduplicates normalized text and alternates date/recipient buckets. Common quotes, forwarded chains, signature delimiters and disclaimers are stripped heuristically. Review the exact sample text; unusual formatting may remain. Individual samples are capped at 6,000 characters.
3. Review useful/sample counts and the conservative **UTF-8-based token estimate**, including request framing and output allowance, then choose **Analyze these samples**. Current source also offers **Learn Now · Uses AI**: it prepares samples from saved settings, shows the account/model/endpoint/budget and two short excerpts, then asks for confirmation before analysis. Cancel retains the full preview without calling the model. This estimate is not a custom-model tokenizer or a monetary spending guarantee. Provider-reported token usage is shown when supplied.
4. Edit the proposed style and choose **Save approved style**. Only then can it inform writing/reply/rewrite requests, while the relevant permissions and source scope still allow it. It does not overwrite Email Brain contacts, project notes or manually entered voice. This creates prompt context, not fine-tuned model weights. Delete the learned style to remove the profile/preview and turn learning off; original mail remains.

Optional **weekly analysis** runs at most once per seven elapsed days while the service is open, using only newly dated Sent mail since the last successful analysis (or weekly opt-in). It uses cached mail; enable periodic mail refresh to capture messages sent in another app. Pending review pauses the next run. Newly proposed styles never overwrite the approved style automatically. Failed or interrupted model calls are not replayed automatically; another manual request or a later weekly run may incur new usage. Changing model, permissions, connection or source content invalidates a pending result. Only the current preview and approved profile are retained, not an unlimited audit history.

Current-source mailbox interfaces use 50-row metadata pages independently of historical import pages. Already-published beta.2 clients still load the mailbox cache as a whole. Large-mailbox service benchmarks and remaining whole-UI acceptance limits are recorded in [verification](VERIFICATION.md).

Recommended starting point: daily **09:00**, Inbox only, preferred language **繁體中文**; leave the translation target blank or set **English** independently. Enable new-mail summaries and one-minute sync only if the volume/cost suits you; starred-only further narrows eligibility. Email Brain contact/project notes remain manual or simulated. Separate, opt-in writing-style analysis is available in Settings → Learning and always requires review before applying a style. Genspark's [official GenMail introduction](https://www.youtube.com/watch?v=i9I4frhlD80) confirms morning briefings and learning voice/contacts, but does not document its precise memory-refresh cadence, per-message triggers, or P0–P4 rules. Morrow's rules above are its own implementation.

The Windows/browser reader starts a summary only after you select a message (including previous/next navigation), not when it merely displays the default first-message preview at launch or after sync.

In **Settings → General → Email footer**, choose Plain text or HTML, enter the signature, preview it, then save. One workspace signature applies to new messages, replies and AI-created drafts across your accounts. HTML allows bold/italic/underlined text, limited inline colors and font sizes, lists, tables, and HTTPS/mailto/tel links. Images, scripts, active content, remote resources and unsupported styling are removed. Each draft keeps its own footer snapshot, visible in the composer and removable before sending. Editing settings or replacing the body with an AI suggestion does not change that snapshot. Gmail, Outlook and SMTP send HTML footers as multipart mail with a generated plain-text alternative. Legacy saved drafts keep their original text without an extra footer.

Replies, including AI replies and the native Reply shortcut, keep the account that owns the original message even in combined views or when the To address is an alias. Their From identity is locked; replying to a sent message uses its original recipients.


## AI Studio simulations

Priority previews, smart labels, Email Brain, person/company research, meeting preparation, follow-ups, meeting scheduling, cleanup, unsubscribe, attachment comparisons, and batch replies are **local simulations**, even with a model configured. Preview a plan, then apply it to create local changes or records. Custom skills save editable instructions and run through the configured model or labeled demo mode.

Simulations do not browse the web, contact a calendar, send invitations or messages, unsubscribe with a provider, or fetch attachments. Attachment examples are fixtures behind an opt-in permission. Calendar and contact permissions here control local simulated context; they do not authorize access to connected calendars or external address books. Studio reminders and events are local records, not scheduled notifications or background jobs.

## Data and configuration

Messages and drafts are stored in SQLite under `./data`. Mail/calendar credentials and tokens are encrypted with AES-GCM using a key in the same directory. Protect and back up **both the database and key**. This is not OS-keychain storage, and someone with access to both can decrypt the secrets. Message contents are stored locally in plaintext.

If delivery becomes uncertain, Morrow retains the draft and its request ID. Check your provider’s Sent folder before explicitly retrying; a retry can send a duplicate. Morrow does not automatically retry sending.

Sync communicates with the configured mail provider. Sending transmits your draft through that provider; AI requests transmit relevant emails to your chosen model endpoint. Calendar actions communicate with the selected calendar provider. Credentials are used for their configured provider. Use a local model to keep AI processing on your computer.

| Environment variable | Default |
| --- | --- |
| `PORT` | `3001`, API and production server port |
| `DATA_DIR` | `./data`, runtime database and encryption key |
| `APP_URL` | `http://localhost:5173` in development; `http://localhost:3001` otherwise |
| `NODE_ENV` | Unset; `production` also makes startup reject a missing frontend build |

Set environment variables in your shell, or copy [`.env.example`](.env.example) to `.env` for `npm start` and `npm run backup`. The development launcher uses shell variables. If you change the API port, adjust the development proxy and OAuth callback registration to match; `APP_URL` must remain a loopback HTTP origin. Keep runtime data and credentials out of version control. This app is intended for local single-user use; do not expose it as a shared internet service.

## Backup and recovery

```sh
npm run backup
# Or choose a destination that does not already exist:
npm run backup -- /path/to/new-backup-directory
```

The default destination is `./backups/morrow-<timestamp>`. `DATA_DIR` selects the source directory, just as it does for the server. The backup command can run while Morrow is open: it creates a consistent SQLite snapshot, copies the matching encryption key, and verifies the result. Backup directories/files use owner-only modes on macOS/Linux; on Windows, choose a destination protected by your user ACLs. Copy the resulting directory to your own protected backup storage.

To restore, quit the native app, or stop the web server with Ctrl+C, and wait for shutdown. Preserve the current data directory, then copy **both** `genmail.sqlite` and `encryption.key` from the same backup into a new private directory. Also restore `pending-calendar.json` and `client-state.json` if the backup contains them. Point the web server’s `DATA_DIR` or native app’s `MORROW_DATA_DIR` at it and restart. Verify your saved mail and settings; the web server also exposes `/api/health`. Never replace a key by itself. If taking a manual filesystem copy instead of using the backup command, stop the app first.

Normal startup, health, and backup diagnostics do not include credentials. Keep API keys, tokens, and OAuth callback URLs out of shared issue reports.

## Current limits

- Current source offers **All history / 1 / 3 / 6 / 12 months** (default 3) and All Mail for Gmail, Outlook and IMAP, excluding Spam/Trash. IMAP relies on server special-use flags for exclusions. Historical pages contain at most 50 messages and continue while the app is open. Existing history jobs retain their saved scope; start a new All Mail import to expand it. Gmail refresh checks five bounded scopes, while other providers retain their chosen Inbox/Sent scopes; continuous provider delta synchronization is not implemented.
- Read/unread, star, archive, and trash shortcuts are local. The explicit Move / Labels dialog writes to the provider after review; full provider folder synchronization is not implemented.
- Formatted incoming mail uses an isolated sanitized HTML reader with plain-text fallback and blocked external images until consent. Outgoing HTML footers have a plain-text alternative; full HTML editing, CID images and real attachments are unsupported. Studio attachment examples are simulated.
- Connected accounts send through their configured provider only after you review and confirm Send.
- AI summaries can run on an opt-in schedule or newly synced mail while the service is running. Weekly incremental style analysis is a separate per-account opt-in; applying its result remains manual. Unattended sending, automatic reply insertion and autonomous contact/project memory updates are not implemented.
- The Calendar page supports live event reading and explicit event creation without attendees. Editing/deleting existing events, invitations, and automatic scheduling are not implemented. AI Studio scheduling remains a local simulation.
- Calendar reads are bounded to 500 calendars and 1,000 events per calendar request. The month view selects at most 12 calendars; it reports an error if a calendar exceeds the read cap. Event editing/deletion, attendees and Morrow-generated reminder emails are not implemented.
- macOS uses SwiftUI; Windows uses React / Electron. Core features share the same backend, while native controls and layouts differ. iOS and Android apps are not implemented. Windows manual UI acceptance remains pending.
- Provider and model integrations have automated checks with mocks. Authenticated mail, Google/Microsoft Calendar, and remote-model use still require your credentials and consent; they are not claimed as live-account verified or error-free.

## Support development

Donations are optional and do not unlock features: [GitHub Sponsors](https://github.com/sponsors/Coke1120) or [Buy Me a Coffee](https://buymeacoffee.com/Coke1120). The same links appear in Settings → About and GitHub's Sponsor button.

## License

[MIT](LICENSE) © 2026 Morrow Mail contributors.

## Contributing

See [AGENTS.md](AGENTS.md) for the source layout, account-routing rules, and verification commands. Generated bundles, test workspaces, runtime data, and credentials do not belong in source control.
