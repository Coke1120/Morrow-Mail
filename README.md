<img src="assets/brand/morrow-icon.svg" alt="Morrow Mail icon" width="64" height="64">

# Morrow Mail

**An open-source email client for macOS and Windows, with calendars, an agent CLI and your choice of AI.**

[![Checks](https://github.com/Coke1120/Morrow-Mail/actions/workflows/check.yml/badge.svg)](https://github.com/Coke1120/Morrow-Mail/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Coke1120/Morrow-Mail?label=release)](https://github.com/Coke1120/Morrow-Mail/releases)

[Download](https://github.com/Coke1120/Morrow-Mail/releases) · [User guide](docs/USER_GUIDE.md) · [Agent CLI](docs/CLI.md) · [Feature coverage](FEATURE_COVERAGE.md)

Morrow is a local, single-user app: **SwiftUI on macOS**, **WinUI 3 on Windows**, and a shared **Rust service**. Desktop packages include their runtime; no Node, Electron or Rust installation is needed to use them.

The IMAP identity follow-up separates cached mail by server endpoint and login,
so reconnecting the same email to another server cannot reuse old UIDs or local
state. Proven legacy messages keep their IDs; unverified copies remain readable
locally and cannot act on the new server. **Back up before opening this source:**
workspace schema 2 is incompatible with the prior service. See
[migration and recovery limits](docs/IMAP_SERVER_IDENTITY.md).
This source change is not a release or live-account acceptance claim.

The v0.8.2 source includes the merged Mail | Agent | Brain navigation shell and activity-recovery fixes from PRs #48–50. Cancellation remains scoped to its mailbox and work type, and delayed cancellation or settings responses cannot stop replacement work. Release preparation changes only the common version and documentation; summary-job diagnostics, IMAP/mailbox improvements and the separate Today follow-up are excluded. See [validation](VERIFICATION.md#v082-release-preparation--15-october-2026) and [release notes and known limits](docs/releases/v0.8.2.md). Publication requires fresh paired v0.8.2 tag checks and the existing signed-manifest publisher. macOS remains ad-hoc signed without Developer ID notarization, Windows unsigned, and live-account/manual accessibility acceptance incomplete.

[Published v0.8.1](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.8.1) corrected the v0.8.0 Gmail history authorization regression: the first history resource-API 401 stops the import for manual recovery while preserving its checkpoint and cached mail. Routine token-expiry refresh and other Gmail read/reconnect fixes remain. Writing rules, Today suggestions and categories, skill review queues and the local Inbox Agent with explicit action/send review are retained. Today still keeps 200 completion markers and exposes the latest 20 per mailbox; old suggestions can reappear after eviction, and unread-task priority ordering remains limited. See the [v0.8.1 notes](docs/releases/v0.8.1.md). Older tags and assets remain unchanged.

The v0.8.2 source adds a Mail | Agent | Brain navigation shell on macOS and Windows. Cold start stays on the Mail three-pane. Agent reuses Inbox Agent, Today, and Skills; Brain reuses persona, writing rules, and categories. AI Studio is an advanced footer and Settings entry, and its More menu keeps one-release Moved to Agent / Moved to Brain hints. Review-before-send is unchanged; publication follows the paired tag gates above.

The [IMAP read-session candidate](docs/IMAP_READ_SESSIONS.md) reuses one owned
connection for change discovery and cached-mail flag reconciliation, with
connection checks and bounded deadlines. It closes the socket after the round
and discards failed or cancelled reads. IDLE remains a separate implementation
unit; persistent connection pooling is not added here.

The [IMAP move-recovery candidate](docs/IMAP_MOVE_RECOVERY.md) adds a durable,
explicitly reviewed fallback for servers with UIDPLUS but no MOVE. It records
each COPY/delete/UID EXPUNGE step before sending it and never replays uncertain
work. Interrupted moves may leave two copies; native recovery can check the exact
recorded copies, finish a reviewed removal, apply an already confirmed result, or
record that the user handled it in the provider. Opening recovery is local-only.
This separate draft source is not part of v0.8.2 or live-account acceptance.

The download-controls follow-up adds account-owned downloaded-content coverage,
logical storage totals and a 30-record repair list to both native clients. It
reuses reviewed history controls and explicit single-message downloads. The macOS
repair follow-up refreshes the current reader and shared mailbox metadata from
local records, preserving the selected owner and page without another mark-read
action. Local archive/Trash changes gain a restart-safe last-move undo while their location
and connection remain unchanged. Provider Trash keeps its separate one-minute
undo. No cache deletion, quota or global offline mode is introduced. See
[controls and remaining limits](docs/DOWNLOAD_CONTROLS.md).

The activity-recovery follow-up keeps cancellation requests separate across
mailboxes and AI work types. Cancelling one analysis remains effective when
another mailbox is cancelled or its reply settings change; completed or cancelled
work still cannot publish a late result. A delayed cancellation or settings
response also cannot stop a replacement analysis started afterward. Synthetic
cancellation and Windows process-observation coverage, original failures and remaining native acceptance
limits are recorded in [verification](VERIFICATION.md#activity-cancellation-and-native-verification-repairs--15-october-2026).

Activity now shows each last summary job's recorded times and safe diagnostic
details, independently of Today's current-day and current-context summary card.
Failed, cancelled, interrupted and skipped jobs have distinct labels. Opening
saved job details keeps that job's snapshot and never retries analysis. Missing
historical times and discarded error causes remain unknown. See
[diagnostic behavior and checks](VERIFICATION.md#saved-summary-job-diagnostics--15-october-2026).

Current source adds mailbox categories, local Today suggestions and skill review queues. Today keeps valid saved summary suggestions while newer jobs are queued or failed, and completing unread suggestions makes room for older unread mail. Category edits require review before being discarded. Skill schedules only queue items for review; they do not run a model, send mail or update Email Brain. See [behavior and limits](docs/USER_GUIDE.md#reviewed-attention-workflows) and [follow-up validation](VERIFICATION.md#pr-43-today-and-category-follow-up--14-october-2026).

The 0.7.7 [Today and reply review workspace](docs/REVIEW_WORKSPACE.md) adds shared account tabs, compact saved decisions, inline original messages and editable account-owned replies. All accounts is a read-only aggregate. Downloaded conversations use account-scoped provider/RFC/reply relationships; new sources withdraw stale suggestions while retaining user edits. Decisions remain AI suggestions with checked source quotations; historical summaries and incomplete conversations require review. Saving or opening a suggestion never sends mail. Skip now clears only its dismissed ephemeral state, source refresh moves edits without ghost unsaved guards, and empty projections avoid redundant index loads; saved mailbox drafts remain. See [release notes and limits](docs/releases/v0.7.7.md), [workspace lifecycle](docs/REVIEW_STATE_LIFECYCLE.md) and [validation](VERIFICATION.md#v077-release-preparation--codex-cloud-12-october-2026). [v0.7.7 is published](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.7.7) after its exact paired tagged attempt and public-byte verification; the unpublished failed v0.7.5/v0.7.6 tags remain preserved. See [publication evidence and residual observation limits](docs/releases/v0.7.7-verification.md).

Version 0.7.3 includes search-page retention across reading/reply saves and clearer attachment removal names, covered in the [mail flow review](docs/MAIL_FLOW_REVIEW.md). Native CI does not complete manual accessibility/live-account acceptance; the extreme Mac HTML timeout and Windows first-acquire observation gap remain open.

The cloud observer follow-up retains provisional handles during delayed CIM
delivery while preserving every strict final admission and exit gate. Successful
and failed runs are both recorded in [evidence and scope](docs/WINDOWS_INVENTORY_WINDOW.md).
Final PR and tagged checks passed both platforms and the existing publisher.
Preceding main acquisition/shutdown-inventory failures remain failures; this does
not establish universal observation-gap resolution. See the linked publication evidence.

Version 0.7.4 keeps the side-by-side reading pane inside the mail view when the window or sidebar changes width, restoring the requested list width when space returns. The separate Mac mini Parallels checks and tagged release status are recorded in [verification](VERIFICATION.md#windows-reading-pane-fit--mac-mini-parallels-12-october-2026).

The [attachment follow-up](docs/ATTACHMENT_FLOW_REVIEW.md) keeps Windows on the current account/page during an attachment save. The subsequent sidebar correction restores WinUI's actual selected item when a guarded invocation is rejected, so its account/folder label matches the retained mailbox. Isolated native checks cover real `ItemInvoked` events, ownership, repeated operations and saved-file security metadata; interactive picker cancellation remains unverified.

The 0.7.4 source adds persisted Gmail history, connection/folder/UIDVALIDITY-bound IMAP UID progression and capability-gated flag/deletion reads, plus Graph overlap/folder fairness improvements. Unchanged mail skips database writes, and flag-only changes avoid full-text reindexing. See [synthetic measurements and protocol limits](docs/SYNC_PERFORMANCE.md). [v0.7.4](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.7.4) passed the paired tagged checks; these measurements do not establish live-account or UI latency acceptance.

Current source adds explicit [selected custom IMAP folder sync](docs/SELECTED_IMAP_FOLDERS.md): up to 20 reviewed local selections, four bounded folder pages per Sync, and per-folder success times, coverage limits and recovery actions. Periodic downloads obey the existing sync interval; already-requested quota/update continuations remain available, and history import remains separate. Selection/reconnect changes invalidate in-flight commits, and a recreated folder requires a new selection review. This is recent-page and new-mail coverage with bounded cached-flag refresh, not a full mailbox mirror or live-account acceptance.

The [Thunderbird-informed IMAP follow-up](docs/THUNDERBIRD_IMAP_SYNC.md) discovers changed cached UIDs in bounded MODSEQ windows, prioritizes their flags within the existing 50-message background budget, and commits pending work with message updates. Unchanged MODSEQ reads use the provider snapshot, preserving local-only stars; missing snapshots reread flags. Legacy proof migration, capability fallback and UIDVALIDITY resets retain cached content. 0.7.8 includes this follow-up and the later reconcile-stall repairs. The synthetic comparison does not establish live-account or native UI acceptance; see the [0.7.8 release notes](docs/releases/v0.7.8.md).

[Current-page synchronization](docs/SYNC_PRIORITY_AND_INCREMENTAL.md) in the 0.7.3 source prioritizes the selected message and visible page while retaining older-cache checks. Recent IMAP/Outlook pages reuse proven immutable cached bodies; drafts and uncertain content still fetch normally. Sync preserves reviewed sent payloads and owned downloaded attachments. The 0.7.4 follow-up implements bounded incremental polling. A separate [IMAP notification candidate](docs/IMAP_IDLE_NOTIFICATIONS.md) rotates eligible Inbox and selected custom folders under the existing automatic-sync opt-in, with at most four accounts and one folder per account watched at once. Coalesced hints use the existing bounded sync path; selected folders need a committed UIDVALIDITY baseline, fresh catalog and current recovery/backoff eligibility. The candidate passed its Linux synthetic Rust checks; native SDK and live-provider acceptance remain pending. It is excluded from the separate v0.8.2 release. Publication requires fresh paired tagged checks; see the [0.7.3 release notes](docs/releases/v0.7.3.md).

## Download

Get a release package and its SHA-256 checksum from [GitHub Releases](https://github.com/Coke1120/Morrow-Mail/releases).

| Platform | Package | Install |
| --- | --- | --- |
| macOS 13.5+, Apple silicon | `Morrow-Mail-<version>-macos-arm64.zip` | Unzip and move **Morrow Mail.app** to Applications. |
| Windows 10/11, x64 | `Morrow-Mail-<version>-windows-x64.zip` | Extract the **entire folder**, keep its files together, and run **Morrow Mail.exe**. |

**Distribution limits:** macOS builds are ad-hoc signed without Apple notarization; Windows builds are unsigned and may show SmartScreen warnings. Full live-account, clean-machine and accessibility acceptance remains incomplete. See [verification](VERIFICATION.md) before relying on Morrow for critical mail.

Older builds using the retired update URL require a manual download. Back up your workspace and quit the old app before replacing it. See [backup and recovery](docs/USER_GUIDE.md#backup-and-recovery).

## Get started

1. Open **Settings → Mail accounts** and connect Gmail, Outlook / Microsoft 365, or IMAP / SMTP. Use **Sync** for the selected mailbox or **Today → Sync All** for every connected account.
2. Optionally connect Google Calendar or Outlook Calendar under **Settings → Calendar**.
3. For AI assistance, configure an OpenAI-compatible endpoint or Ollama under **Advanced setup → AI connection**, then choose permitted folders and fields in **AI & privacy**. AI is optional.

Browser sign-in uses the desktop registration included in the build; custom registrations remain available. Source builds without Google configuration need a custom Google client. See [mailbox setup](docs/USER_GUIDE.md#connect-a-mailbox) and the [OAuth guide（繁體中文）](docs/OAUTH_SETUP.zh-TW.md).

Current source permits one refresh and read retry after a rejected Gmail access
token during sync, folder-catalog and raw-message reads. History downloads retain
routine token-expiry refresh before a request, but their first resource-API 401
preserves the checkpoint and cached mail and stops with an authorization error.
Resolve the authorization failure, then manually **Resume** if the saved
connection is unchanged. Reconnecting changes the connection identity and
requires starting a new import; cached mail remains. That 401 does not trigger a
forced token exchange, another read or background/restart resume.
Reconnecting without a new refresh token retains the previous one only for the
same verified mailbox, provider, OAuth client and granted scopes; an incompatible response retains the
existing connection and reports a failure. This does not renew a revoked Google
grant or change the seven-day limit of External/Testing OAuth projects. See
[validation and limits](VERIFICATION.md#gmail-history-authorization-correction--14-october-2026).

## What it does

- **Mail:** multiple accounts, combined inboxes, To/Cc/Bcc, reply/reply-all/forward, provider folders and Gmail labels, local Pending/Later markers, and reviewed scheduled sends.
- **Search:** local full-text search, Chinese traditional/simplified matching, filters and saved searches; optional semantic indexing with a reviewed scope and budget.
- **Calendars:** Google and Outlook month views, explicit event creation and provider reminders. Invitations and editing/deleting existing events are not implemented.
- **AI assistance:** summaries, reply suggestions, translation, inbox questions and reviewed writing-style learning. Per-mailbox writing rules keep separate unsaved editors; saving or toggling one rule preserves other edits. Optional automation requires consent; AI never sends mail by itself. Studio simulations are labeled separately.
- **Agent access:** JSON commands for reading mail and preparing, reviewing and explicitly sending owned drafts through the same Rust service.

Detailed behavior and limits are in [feature coverage](FEATURE_COVERAGE.md) and the [user guide](docs/USER_GUIDE.md).

The [native reader and resource-observation follow-up](VERIFICATION.md#reader-timing-and-windows-observation--follow-up-in-progress) records fixture measurements and strict observation checks. The [early Windows child pins](docs/WINDOWS_EARLY_ADMISSION_PINS.md) remove serial sibling-admission delay while preserving first-acquire failure gates; error 87 before a first pin remains unresolved. Mac mini Parallels acceptance is incomplete. Diagnostic controls do not establish production readiness; the latest tagged outcome is recorded in [verification](VERIFICATION.md).

## New in 0.7.3

Merged [PR28](https://github.com/Coke1120/Morrow-Mail/pull/28) restores the actual Windows sidebar selection after blocked attachment-save navigation. Merged [PR29](https://github.com/Coke1120/Morrow-Mail/pull/29) prioritizes visible-mail synchronization and conservatively reuses immutable bodies. macOS search retains its page through reading/reply saves. The release retains strict paired native checks and signed update provenance; known observer, reader, signing and manual-acceptance limits remain in the [release notes](docs/releases/v0.7.3.md).

### Included since 0.7.2

[Fetch recovery changes](docs/FETCH_RECOVERY.md) address IMAP date gaps, Outlook delta catch-up, Gmail label limits and incomplete content. Native reader recovery, Windows composer focus and expired mail/search cursors retain their account and page context. The paired source CI passed on both platforms; each release tag requires fresh paired checks before publication. See the [0.7.2 release notes](docs/releases/v0.7.2.md) for fixes and remaining limits.

### Included since 0.7.1

Fetched server Read/Unread values now repair stale local states even when the server flag has not changed since the last sync. Missing IMAP folders no longer block the rest of a cached-message reconciliation batch; cached mail is retained. Larger mailboxes may need multiple sync rounds. See the [0.7.1 release notes](docs/releases/v0.7.1.md).

### Included since 0.7.0

Version **0.7.0** includes the changes from [PR #22](https://github.com/Coke1120/Morrow-Mail/pull/22). Releases now use ordinary version numbers without a prerelease suffix:

- Attachment add/remove/download/save, reviewed sending and scheduling: **100 files / 50 MiB total per message**. Provider send limits and MIME encoding overhead still apply; attachment bytes stay out of AI context.
- New history imports fetch the **latest seven days first**, then older mail. Gmail/IMAP read/star write-back and checkpointed cached-message reconciliation complement Outlook delta sync. Sync remains bounded, not a complete server mirror.
- CLI `sync`, `status`, `--dry-run`, MIME `fetch` and attachment commands.
- **Today** updates one summary card per mailbox/local date while keeping job history.
- **Install & Restart** accepts ongoing activity, drains accepted work and resumes safe checkpointed work. Unsaved edits stay protected; uncertain deliveries and unfinished paid requests never replay automatically.

See the [changelog](CHANGELOG.md), [release notes](docs/releases/) and [verification](VERIFICATION.md) for version-specific changes and test evidence.

## Agent CLI

The CLI ships inside `morrow-service` with Morrow Mail **0.7.0 and later**. It returns JSON and works with the app open or closed. Set up your accounts in the app first.

For macOS, define a temporary shell helper:

```sh
morrow() { '/Applications/Morrow Mail.app/Contents/Resources/morrow-service' cli "$@"; }
morrow accounts
morrow list --account all --folder inbox --limit 20
morrow read --account person@example.com --id 'provider-message-id'
```

For Windows PowerShell, adjust the extracted app path:

```powershell
function morrow { & 'C:\Apps\Morrow Mail\resources\app\runtime\morrow-service.exe' cli @args }
morrow accounts
```

Use these commands to preview synchronization, fetch recent mail and inspect progress:

```sh
morrow sync --account all --dry-run
morrow sync --account person@example.com
morrow status --account person@example.com
```

`list`, `search` and `read` use cached mail without marking it read or triggering AI. `sync` explicitly fetches a bounded round of recent mail; `fetch` downloads MIME/attachments for an already cached message. Sending uses **draft → review → send --confirm** with the owning account and reviewed payload. Never automatically retry an uncertain send. The in-app Inbox Agent, under Agent in the primary chrome, is a separate local multi-turn chat for one mailbox: it uses your configured model, keeps the conversation on this device, and sends only after you confirm in that chat. Its read tools and reused history share the saved message limit and current permissions. Drafts are published after a complete turn; cancellation or the 50-second turn limit discards unfinished drafts. Send review includes the full body, sender, recipients, footer and attachments.

See the [CLI guide](docs/CLI.md) for draft/send examples, attachments, workspaces, JSON output and exit codes. External agents with workspace access can read mail independently of the app's AI checkboxes; grant access only to agents you trust.

## Data and safety

Mail is stored locally in SQLite in `~/Library/Application Support/Morrow Mail` on macOS or `%APPDATA%\Morrow Mail` on Windows. **Message content is plaintext.** Credentials are encrypted with a key in the same directory; protect and back up both the database and key.

Mail/calendar operations contact their providers. Enabled AI requests send permitted content to your selected model endpoint; local storage does not make remote AI processing offline. The reader blocks scripts and external images by default, with explicit image consent and destination review for links.

Scheduled mail and background jobs require Morrow to remain running. See [data and configuration](docs/USER_GUIDE.md#data-and-configuration), [backup and recovery](docs/USER_GUIDE.md#backup-and-recovery), and [known limits](FEATURE_COVERAGE.md).

## Build from source

Use **Rust 1.98+** with rustfmt/clippy, plus Apple's Swift command-line tools on macOS or the [pinned Windows prerequisites](windows/README.md). Node/npm is not used.

The 0.7.2 native recovery checks passed in hosted macOS and Windows CI, including Windows return focus and General retry plus macOS loading/error Back and stale-response protection. Linux checks alone do not establish UI acceptance. See [verification](VERIFICATION.md).

```sh
# macOS
/bin/sh scripts/build-macos-native.sh
```

```powershell
# Windows
./scripts/build-windows-native.ps1 -Zip
```

For checks, source layout and release rules, see [AGENTS.md](AGENTS.md). Platform details are in the [macOS guide](docs/USER_GUIDE.md#native-macos-app) and [Windows README](windows/README.md). Use an isolated absolute `MORROW_DATA_DIR` for fixtures; never test against a real mailbox workspace.

An existing backup destination reports a conflict without overwriting it. Manual same-source Mac/Windows UX, real-account, clean-machine, accessibility and installed-updater acceptance remain separate gates; see [verification](VERIFICATION.md).

### Local cleanup after a release (macOS)

After confirming that both platforms passed and their downloads are publicly available, stop local builds/tests and preview cleanup on your Mac (Python 3 required):

```sh
python3 scripts/clean-local-release.py
# Review the list, then delete those generated outputs:
python3 scripts/clean-local-release.py --apply
```

This removes checkout-local `rust/target`, `macos/.build`, `build/swift-cache` and `build/swift-module-cache`. It also removes recognized Morrow ZIP/DMG files and extracted `Morrow Mail.app` bundles older than seven days within `build/` and `test-results/`'s `release`, `releases` and `release-*` directories, plus old recognized archives directly in `dist/`. Age uses modification times, including bundle contents. Current native candidate directories, installed-app backups, reports, screenshots, checksums and manifests stay in place. Symlink targets and detected private workspaces are skipped; tracked cleanup targets cause refusal.

Run it manually after each successful paired release; it does not contact GitHub or verify publication. The process check is best effort, so do not start builds/tests while it runs. Clearing compiler outputs makes the next build slower. Shared/global caches, custom external Cargo target directories and app data are outside its scope. Reported savings are estimates; APFS clones/snapshots can affect reclaimed space. GitHub-hosted CI cleanup does not free local Mac storage.

## Documentation

| Document | Contents |
| --- | --- |
| [User guide](docs/USER_GUIDE.md) | Account setup, mail, calendars, AI, search, updates, backup and recovery |
| [Agent CLI](docs/CLI.md) | Commands, reviewed sending, attachments and automation contract |
| [Feature coverage](FEATURE_COVERAGE.md) | Implemented features, simulations and limits |
| [Verification](VERIFICATION.md) | Test evidence and outstanding production acceptance |
| [OAuth setup（繁體中文）](docs/OAUTH_SETUP.zh-TW.md) | Google/Microsoft registrations and permissions |
| [Changelog](CHANGELOG.md) · [Release notes](docs/releases/) | Version history |

## Support and license

[MIT](LICENSE) © 2026 Morrow Mail contributors. Independent and inspired by Genspark GenMail; not affiliated with Genspark.

Optional support: [GitHub Sponsors](https://github.com/sponsors/Coke1120) · [Buy Me a Coffee](https://buymeacoffee.com/Coke1120). Donations do not unlock features.
