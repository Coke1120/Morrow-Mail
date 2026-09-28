# Changelog

## 0.6.0-beta.22 — 2026-09-28

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
