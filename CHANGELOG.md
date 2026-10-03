# Changelog

## 0.6.0-beta.39 — 2026-10-03

- Share persisted provider quota waits across sync, history and folder/label reads; honor longer Retry-After delays while retaining daily limits and indefinite transient history retries.
- Deduplicate Gmail refresh IDs and reuse cached non-draft bodies with fresh minimal metadata. Keep full reads for drafts, new messages and legacy HTML-cache refill.
- Skip only vanished Gmail message-detail 404s without abandoning the successful page or its checkpoint.
- Let replacement IMAP connection verification exclude old waits; retain saved-account pacing, owner isolation and cached user data.
- Retain beta.38 reviewed workflows and native selection/model-setting fixes; require fresh paired tagged builds and the existing signed publisher before publication.

## 0.6.0-beta.37 — 2026-10-02

- Supply current folder/label management metadata in existing native fixtures and verify their schema, retaining production background refresh and persistence checks. Keep safe reply-mode diagnostics visible.
- Carry the wider two-column reply/history composer and macOS click/drag-type fixes from unpublished beta.35/.36; rerun both platform gates before publication.

## 0.6.0-beta.36 — 2026-10-02 (unpublished)

- Preserve the failed tag: Windows UI assertions passed, but persistence verification rejected legacy fixture folder metadata. No downloads were published; beta.37 supersedes it.
- Fix the Windows layout namespace and rerun the paired release gates. Carry the wider native reply/history and macOS click/drag-type changes from the unpublished beta.35 candidate.

## 0.6.0-beta.35 — 2026-10-02 (unpublished)

- Preserve the failed tag: macOS passed, but Windows compilation rejected an unqualified grid-unit enum. No downloads were published; beta.36 supersedes it.

- Widen the native reply composer and show previous messages beside the editable draft, with independent scrolling and fixed save/send actions. Include Reply All and reopened reply drafts; Windows stacks the panes in narrow windows.
- Read the owned downloaded original and up to 20 explicit local reply ancestors, retaining quoted history as plain text. Show missing/limited history and retry failures without losing draft edits; do not infer provider threads or fetch missing mail.
- Restore explicit click selection on draggable macOS mail rows and keep their List identity on the complete row. Preserve keyboard and message organization actions.
- Declare the private mail drag type as exported `public.data`, so native sidebar drop targets receive its opaque token and open the existing Move review. Keep account, destination, connection and provider-write guards.
- Exercise native clicks on the production mail list with duplicate IDs across fictional accounts, and check the packaged type declaration.

## 0.6.0-beta.34 — 2026-10-02

- Drag one imported message from the native mail list to its owning sidebar label/server folder or provider-backed Inbox/Archive/Spam/Trash. Use the entire macOS row as a drag hit area. Open the existing reviewed Move flow with that destination; reject external, cross-account, stale and unavailable drops. Keep keyboard/context-menu organization.

- Make reviewed automatic semantic indexing the main native Search action. Add All downloaded mail as the new-configuration default while retaining existing explicit and legacy three-month scopes until reviewed expansion.
- Move daily/batch limits and manual maintenance into collapsed advanced sections. Show indexed/eligible progress, a prominent pause action, daily-limit automatic continuation and separate size-limit exclusions without hiding keyword search. Finish messages across daily resets using existing chunk checkpoints; pause/restart retains completed chunks.
- Review accounts, folders, content, history, embedding connection and estimated daily cost before starting. Preserve unsaved scope edits when pausing or polling; never replay uncertain model requests automatically. Existing semantic search size limits remain.

## 0.6.0-beta.33 — 2026-10-02 (unpublished)

- Withdraw the candidate before publication after the isolated drag fixture identified a missing macOS row hit area. Preserve the tag and supersede it with beta.34; no assets were published.

## 0.6.0-beta.32 — 2026-10-02

- Add searchable native Label / Folder Managers with hierarchy trees, create/rename/delete/parent-move actions and protected-folder guidance. Reuse account-scoped cached names and metadata.
- Add message context/reader actions for Move, Gmail Labels, Create and Manage. Search destination and parent menus independently of the sidebar; retain selections when filtering. Gmail checklists submit one reviewed custom-label delta while preserving Inbox and other owners.
- Create a label/folder from an email, optionally select it, then separately review the message assignment. Retain form inputs after failed reviews and never replay uncertain provider writes.
- Show a safe provider error for IMAP TCP connection failures instead of a workspace-storage error. Improve native picker and CLI fixture synchronization without weakening production guards. See the [release notes](docs/releases/v0.6.0-beta.32.md) for the recorded intermittent Windows reader timeout and remaining acceptance limits.

## 0.6.0-beta.31 — 2026-10-01

- Automatically download Gmail labels and Outlook/IMAP folder catalogs for connected mailboxes, save names in encrypted local settings and restore them on launch. New/reconnected accounts refresh automatically; successful catalogs refresh every 15 minutes, including when mail downloads are manual.
- Show cached names directly in both native sidebars and refresh Settings status without replacing unsaved edits or mail selection/paging. Browse/Refresh is no longer required; immediate refresh remains available.
- Retain offline names with persisted transient-read/quota backoff, stop automatic retries on authorization or malformed responses, and reset retry state on reconnect. Provider writes keep fresh validation and explicit review. See the [release notes](docs/releases/v0.6.0-beta.31.md) for mail-download, signing and acceptance limits.

## 0.6.0-beta.30 — 2026-10-01

- Add reviewed custom Gmail label and Outlook/IMAP folder creation, rename, deletion and moves to another parent, with protected system folders, account/connection-bound single-use reviews and no automatic provider-write replay. Preserve cached mail, local changes, Pending, drafts and import traversal progress.
- Add local sidebar name filtering and folder context actions for reviewed message moves in both clients. Make the Windows sidebar width persist and support dragging, arrow keys and wider/narrower actions, with full-name tooltips.
- Polish Today and add Summarize now for a reviewed immediate account-owned report without changing the automatic schedule. Automatically refresh Mail/Calendar connection metadata while preserving unsaved forms.
- Wait for actual macOS Settings-sheet dismissal before the update quit so Install and Restart proceeds automatically. See the [release notes](docs/releases/v0.6.0-beta.30.md) for provider-specific deletion impact, Gmail's 50-label subtree limit, signing and validation limits.

## 0.6.0-beta.27 — 2026-09-30

- Commit each bounded provider refresh page as it arrives, retaining earlier pages if a later scope fails and checking the captured mailbox connection before each commit. Complete history remains a separate resumable import.
- Show Assistant and Summaries as the primary AI Studio pages, move Writing style & notes under More, and use one task picker with a task-specific action.
- Keep six everyday Settings categories, move optional connection/index/style setup under Advanced setup, and show permitted mail before collapsed AI automation and limits. Preserve explicit saves, paid-request reviews and account ownership. See the [release notes](docs/releases/v0.6.0-beta.27.md) for validation and limits.

## 0.6.0-beta.25 — 2026-09-29

- Group Windows mailbox controls and paging with the message list, keep reader actions visible above its scrolling body, limit the composer width and keep its actions outside the form. Add the native three-step Start here Settings path.
- Keep message rows visible when resizing the Windows Reader below the list.
- Let both clients choose a mailbox within AI Studio and combine saved summaries with account labels. Apply local simulations to their reviewed mailbox, including when opened from All accounts.
- Bring reviewed Sent writing-style learning to Email Brain with optional daily proposals, while preserving existing weekly consent. Keep the Windows analysis cancel control and account picker usable during review. See the [release notes](docs/releases/v0.6.0-beta.25.md) for verification and limits.

## 0.6.0-beta.24 — 2026-09-29

- Guide macOS first use through account connection, optional model testing and AI permission review; add direct Assistant tasks and account-owned sender/subject context search.
- Keep newer OAuth connections when callbacks arrive out of order, improve historical import and scheduled-send processing, refresh Gmail labels after provider moves, and check Out of Office state before writing.
- Wait for authenticated service readiness during updates, restore the previous app after failed startup, and keep rapid relaunches from racing a previous workspace writer.
- Keep AI Studio within the available macOS window height after account selection. See the [release notes](docs/releases/v0.6.0-beta.24.md) for verification and limits.

## 0.6.0-beta.23 — 2026-09-28

- Publish the AI workflow improvements described below after restoring the shared Windows history-coverage formatter used by AI Studio.
- Beta.22 stopped at Windows compilation and was never public. Preserve its tag and rerun both native build/test gates for beta.23; see [release notes](docs/releases/v0.6.0-beta.23.md).

## 0.6.0-beta.22 — 2026-09-28 (unpublished)

- Replace Reply Suggestions' candidate picker with Needs a reply: explicitly enable bounded automatic assessments, hide no-reply results, retain Ignore across restart, and open suggestions in the owned native composer for review/edit/Send.
- Continue embedding batches automatically after reviewed scope/model/daily-budget approval; pick up new mail, retain usage across restart, preserve valid vectors when stopped, and never replay uncertain failures automatically.
- Add reviewed, source-linked Brain memory proposals, optional weekly generation and persistent pending proposals. Start style learning with the first eligible sample after opt-in; keep style and memory application explicit.
- Share validated per-account Brain context across interactive, scheduled and reply AI. Improve Chinese retrieval, incremental style provenance, prompt precedence and briefing priority selection.
- Combine all connected mailboxes in Today and display summary timing. Simplify AI Studio and Settings by collapsing advanced and manual maintenance controls.
- Retain native SwiftUI/WinUI, Rust, account ownership, paid-operation consent and paired release gates. See [release notes](docs/releases/v0.6.0-beta.22.md) for limits.

## 0.6.0-beta.18 — 2026-09-28

- Publish the native desktop cutover described below, with the same explicit owner waiver for additional tests.
- Read the created draft directly from GitHub's creation response, avoiding the release-list read-after-write visibility failure that stopped beta.17 before any assets were uploaded. Retain all provenance, checksum, pinned-signature and no-overwrite protections.
- Beta.17 was never public; its tag is retained. See [beta.18 release notes](docs/releases/v0.6.0-beta.18.md).

## 0.6.0-beta.17 — 2026-09-28 (unpublished)

- Switch the Windows package to native WinUI 3/C++/WinRT with the existing Rust service; retain SwiftUI on macOS. Neither native package bundles Electron, React or Node.
- Share Rust draft preparation and use Node-free native resource, notice, build and signed paired-publisher tooling. Retain historical compatibility sources and workspace/recovery identities.
- Owner explicitly requested this tag without additional tests. Rebuild both platforms and verify artifact provenance, checksums and signed manifests; prior candidate evidence is recorded separately, not reported as tests of this tag.
- Keep ad-hoc macOS/unsigned Windows, incomplete clean-machine/accessibility/live-provider and whole-app-performance acceptance visible. See [release notes](docs/releases/v0.6.0-beta.17.md).

## 0.6.0-beta.16 — 2026-09-27

- Reorganize Settings in SwiftUI and React: account connection first, grouped General preferences, persistent permission Save/Discard controls, collapsed calendar reconnect forms and clearer current/update history status.
- Separate Chat/reply and Search embedding panels, retain their unsaved edits, and keep connection tests visible. Search uses one Review & Index action with explicit confirmation, supported batch controls and separate destructive clearing.
- Lead Learning with the selected account, proposal/approved-style status and missing prerequisites; keep identity confirmation, generation and style application separate.
- Add a Yahoo / Yahoo HK IMAP/SMTP preset with full-address and app-password guidance. It clears entered passwords and never connects automatically; live Yahoo acceptance remains pending.
- Check for updates at launch and hourly while running, with a due check on return. A red Settings badge opens About when an update is available; download and installation remain explicit.
- Retain Rust desktop services, owner isolation, credential and paid-operation review, and the existing ad-hoc macOS/unsigned Windows prerelease limits.

## 0.6.0-beta.14 — 2026-09-27

- Add a month calendar with independently checked Google/Outlook calendars, cross-day/all-day display and date-click event creation. Review provider-native notification reminders, or Google email reminders, with the event; preserve exact retry identity and prior pending requests.
- Offer complete historical imports without a date cutoff for Gmail, Outlook and selectable IMAP folders, excluding Spam/Trash and retaining bounded pages, checkpoints and safe retry status.
- Add account-owned Pending lists, separate from stars and provider state.
- Add confirmed names/aliases and reviewed background Reply Suggestions using permitted downloaded correspondence and approved style. Proposals remain drafts; no automatic replies.
- Add reviewed Gmail vacation/Outlook automatic-reply settings with explicit additional OAuth consent bound to the original account. These provider settings continue while Morrow is closed.
- Add immutable scheduled mail with explicit review, owner/draft locks, cancellation and durable uncertain-send recovery. Morrow must be open; jobs more than 15 minutes late need a new review.
- Include sent To/Cc correspondence in Suggest with History when permitted. Retain account isolation and bounded context.
- Accept the equivalent Outlook Inbox/Sent OData next-page spelling without weakening same-origin/path checks. Retain a manually resized native list when switching reader layout or expansion.
- Keep ad-hoc macOS signing, unsigned Windows and prerelease acceptance limits explicit. Attachments, CID images, provider delta/deletion mirroring and undo sending remain unsupported.

## 0.6.0-beta.13 — 2026-09-27

- Fix beta.10 sidebar sizing on cold launch: wait for the native split view to attach and lay out before setting its initial divider. Keep subsequent user resizing intact.
- Cover delayed attachment, narrow/wide windows, bottom layout and user-adjusted dividers in the native window checks.

## 0.6.0-beta.10 — 2026-09-27

- Add Today above All accounts: local-day summary reports and downloaded mailbox totals, with account isolation and a direct Summary History link; opening it never starts AI.
- Continue reviewed embedding batches when leaving Search/Model or closing Settings. Keep save/test/start and unsaved-edit guards; Activity retains progress.
- Remove the native title/toolbar band; place actions beside the sidebar, mail list and reader. Allow wider sidebar/list panes and add reading layouts and sidebar visibility to the macOS View menu.
- Forward scrolling over formatted mail to the containing native reader while retaining isolated HTML and reviewed links/images.
- Distinguish temporary OAuth refresh failures, rejected client configuration and authorization requiring reconnect. Preserve credentials and rotated refresh tokens; reject stale refresh writes after account replacement.
- Show safe embedding HTTP/response/dimension errors and retain completed entries. Add multi-message and multi-chunk OpenAI/Ollama regression checks. No automatic paid retry is added.

## 0.6.0-beta.9 — 2026-09-27

- Open message Summarize, Suggest Reply and Translate in a local popup, retaining the reader and original reply owner.
- Add explicitly requested Suggest with History: exact same-sender cached mail, within the same account and saved folder/content/message limits, with visible used/matched counts and stale-source rejection.
- Compact message headers and automatic summaries, retain expandable full details, and tighten native View/Sort menus and sidebar/list widths.
- Add saved embedding Test Connection and Edit in Model directly in Search, with visible result/error feedback.

## 0.6.0-beta.8 — 2026-09-27

- Use the renamed `Coke1120/Morrow-Mail` repository for update checks, downloads and product links without relaxing redirect or signature checks. Older installed versions require a one-time manual update; beta.5 was cancelled before publication.

- Render sanitized HTML mail with links, plain-text fallback and per-message external-image consent; block scripts, forms and embedded pages.
- Add reviewed Gmail Spam / Outlook Junk moves, retaining provider permissions and account ownership; link to the provider for phishing reports and sender blocking.
- Add right/bottom/focused reading layouts, full-width reader expansion and more room for messages; left-align senders, move unread dots right and bold only unread previews.
- Keep the macOS app running when its main window closes; reopen the same window from the Dock and retain quit-time write/edit guards.
- Auto-save General preferences with visible saving/error status and retry, removing the Save Preferences button.
- Recover transient history-fetch failures with checkpointed, bounded backoff; show specific safe failure/recovery actions instead of a permanent generic Import stopped state.

- Fetch Gmail Inbox, Sent, Drafts, Starred and All Mail; add paged All Mail history imports and resolved user label names. Refresh provider metadata while preserving explicit local changes.
- Show independently refreshed mail/AI activity with account-specific fetching, import progress, queued/running jobs and errors in both clients.
- Open imported Gmail drafts as new local copies with their original owner and To/Cc/Bcc; leave the provider draft unchanged.

- Keep the native inbox page, rows and selected message visible when marking mail read or switching messages.
- Move embedding connection settings to Model; keep scopes, budgets and batch review in Search.
- Add embedding Test Connection using unsaved fields and a fixed sentence; Index Now prepares a bounded batch and starts it after scope/budget confirmation.
- Add Learn Now with sample/budget confirmation. Generated writing styles remain proposals until Save Approved Style; manual Email Brain memory is preserved.
- Remove Demo from both clients' account/settings/sender choices; show Add account on a fresh installation and select a real mailbox for old Demo selections.
- Add Reply All and plain-text Forward, retaining the source account, deduplicating To/Cc and excluding original Bcc. Forward does not include attachments.

## 0.6.0-beta.4 — 2026-09-26

- Add built-in Microsoft desktop OAuth for Outlook mail and Calendar in SwiftUI and React. Users can open browser sign-in without entering credentials; custom clients remain under Advanced. Node and Rust share the public application ID, preserve PKCE/browser binding and never reuse a saved secret for the built-in public client.

## 0.6.0-beta.3 — 2026-09-25

- Add `morrow-service cli` for agent JSON accounts, cached list/search/read, drafts, complete send review and explicit confirmation. Attach to the running app or use its workspace independently while closed.
- Scope the CLI token to mail commands, preserve exclusive workspace ownership and reject changed draft/sender/connection reviews; reuse durable To/Cc/Bcc delivery records and exact-request replay.
- Bind app discovery to the canonical workspace and require a fresh authenticated service proof before transmitting a CLI token or message. Copied workspaces and stale ports cannot redirect commands to another mailbox.

## 0.6.0-beta.1 — 2026-09-25

- Implement the complete Rust storage/API/provider/AI/calendar/background/search/update service with compatible encryption, retained recovery records, verified migration backups and one database writer.
- Add bounded mail pages, six locale-aware sorts, body-on-demand loading and revision refresh in SwiftUI and React; preserve owner identity and manually unread messages.
- Make Rust the default desktop backend after explicit prerelease cutover approval. macOS retains SwiftUI; Windows retains Electron and its internal Node runtime, without a separate Node backend.
- Ship full-text search, Chinese normalization, scoped filters, saved searches and opt-in reviewed semantic indexing in both clients.
- Add native integration, isolated TLS protocol/provider fixtures, actual old-installer-to-Rust upgrades, dependency audit/notices and 1k/10k/50k benchmarks.
- Retain existing encrypted accounts, cached mail, owner-bound drafts, To/Cc/Bcc send-review records and calendar retry payloads; first Rust takeover creates a verified migration backup.
- This remains an ad-hoc signed/unnotarized macOS and unsigned Windows prerelease. Live-account, minimum-OS/hardware and complete manual UI/IME acceptance remain pending; no stable-production certification is claimed.

## 0.5.0-beta.2 — 2026-09-24

- In-app download, verified installation and automatic restart on macOS and Windows, with unsaved-edit/write guards.
- Pinned Ed25519 update manifests, exact platform/version/size and SHA-256 checks, archive path validation and macOS compatibility checks.
- Retains the previous app and restores it on failed replacement or immediate launch errors; mailbox data remains separate.
- Requires one manual installation to enable future in-app updates. Read-only installation folders retain manual downloads; no unattended installation or privilege elevation.

## 0.5.0-beta.1 — 2026-09-24

- Built-in Google Desktop OAuth for Gmail and Google Calendar in both desktop packages, with an advanced custom-client option. Microsoft still requires a client ID.
- Explicit browser sign-in buttons and advanced callback details; native callback refresh selects the newly connected mailbox, and Windows refreshes connections on return when no edits are pending.
- Paired beta publishing with matching version guards, draft-first publication and both platform checks required before downloads become public.
- Google Cloud Testing restrictions and verification still apply. The beta remains ad-hoc signed/unnotarized on macOS and unsigned on Windows; live-account and native Settings GUI acceptance are still incomplete.

## 0.5.0-alpha.1 — 2026-09-24

- GitHub update checks, opt-in arrival/open/reply AI triggers, daily/interval P0–P4 summaries, and separate response and translation languages.
- Checkpointed 1/3/6/12-month Inbox/Sent imports with pause/resume and no AI calls during download.
- Per-account writing-style previews, bounded model analysis, explicit approval, and optional weekly incremental proposals.
- Fixed IMAP Settings rendering and preserved Sent-copy identity and retry records.

## 0.4.0-alpha.1 — 2026-09-23

- Windows x64 desktop app with an isolated Electron renderer and bundled private service.
- Paired macOS/Windows builds, checksums and gated releases from one version tag.
- Windows keyboard shortcuts, remembered window size, persistent disclosure and calendar recovery.

- Independently collapsible account groups in native and web sidebars, with saved disclosure states.
- Account-owned replies across combined inbox, AI and keyboard paths; sent-message replies target original recipients.
- Plain-text/HTML footer settings and previews, separate draft snapshots, and safe multipart delivery through all mail transports.
- Scrollable native composer with fixed actions, clearer recipient labels and locked From identity, and filter recovery.
- Native inbox and reply screenshots, clearer README presentation, and repository discovery metadata.

## 0.3.0-alpha.1 — 2026-09-23

- First public Morrow Mail alpha: native SwiftUI macOS app, original icon, MIT license.
- Multiple Gmail, Outlook and IMAP/SMTP accounts, combined and separate inbox views.
- Compact, comfortable and spacious inbox rows; six persisted sort modes.
- Multiple To, Cc and Bcc recipients; reviewed sending and durable uncertain-send recovery.
- Explicit reviewed Gmail label and Outlook/IMAP folder operations.
- Native keyboard commands, standard window controls, size presets and restored size.
- Independent Google and Outlook calendars, custom AI endpoint/model/key, and 19 scoped AI behaviors.
- GitHub Sponsors and Buy Me a Coffee links.

Alpha limitations: ad-hoc signed/unnotarized Apple silicon build; latest-50 Inbox sync;
plain-text mail without attachments; 11 AI behaviors are labeled local simulations;
one calendar connection per provider; live-account acceptance remains pending.
