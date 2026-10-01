# Native walkthrough — 1 October 2026

This is a scenario-based acceptance record, not a claim that every possible state or every live provider has been tested. Manual desktop checks, native automated checks and provider/model fixtures are separate evidence.

## Candidates and isolation

- Initial candidates: source `4930d1d259bc79d8881de8c3dc7bc207656b8440`, [paired CI 36876489218](https://github.com/Coke1120/Morrow-Mail/actions/runs/36876489218). Package metadata remains beta.31; these contain newer source than the public beta.31 downloads.
- Windows ZIP SHA-256: `153c2935889e3e86a6b148ec4c9ac686da6c335075bd59cded7f022863f9c396`.
- macOS ZIP SHA-256: `8c15b5630f6602e5cca0ea8780e36aba3d26d4979479f6e67b7a91c8288b853a`.
- Both downloaded archives matched their CI checksum files. macOS host: 27.0, build 26A428. Windows: the existing Parallels Windows 11 ARM VM, running the x64 candidate under emulation.
- Fixtures use the existing `native_fixture` seeder: two `.invalid` owners, duplicate provider IDs, 65 messages per owner, provider draft, cached folders and frozen Calendar retry data. Seed stores were closed before a service opened them. Windows copied the closed fixture into its own temporary directory through the existing `C:\Mac\Home` share.
- The macOS fixture bundle has a unique bundle ID and was ad-hoc re-signed only for isolation. Its service's open database was confirmed inside the marked temporary workspace. The installed app and real mailbox/calendar data were not used for tests. No real mail, calendar event, provider mutation or paid model call was submitted.
- Raw local evidence and fixture workspaces remain ignored under `test-results/walkthrough-20261001/`; no database, key, credentials or screenshot is committed.

## Manual macOS results

| Scenario actually operated | Result |
| --- | --- |
| Cold owned startup; two connected accounts; no visible Demo | Passed; first owner's Inbox and locally cached navigation restored. |
| Select mail and read its complete local body | Passed; reader showed the selected owner's full fictional body. |
| Toggle Pending | Passed; first owner's and combined Pending counts became 1; second owner's remained empty. |
| Next page with 65 messages | Passed; page 2 showed the remaining 15 rows, Previous enabled and Next disabled. |
| Structured `from:` and `after:` search | Passed; 18 owning-account matches, filter chips and one result page. |
| Clear search and open combined Inbox | Passed; 130 messages and separate rows for both owners' duplicate IDs. |
| Select second owner's duplicate-ID message | Passed; body and To belonged to the second owner. |
| Reply All from combined view | Passed; From retained the second owner, To was the sender, Cc/Bcc initially empty. Full recipient edge cases are fixture-tested below. |
| Add Bcc and Chinese text, Save Draft, reopen for editing | Passed; draft appeared only in the second owner's Drafts, with unchanged owner, Bcc and body. No send performed. |
| Cancel an unchanged saved draft | Passed; returned to the owned Drafts view. |
| Open Folder Manager while the fictional IMAP server is unreachable | Passed for cache/form continuity; owning cached path remained visible. Found an incorrect workspace-storage error message, fixed below. |
| Manager search for Chinese path text | Passed; matching cached path remained selectable. |
| Enter a new name; open the separate Parent popup | Passed; root and owning cached folder were offered. |
| Parent search with no match, then Chinese path search | Passed; explicit empty state, then matching path. No provider request is needed to filter. |
| Parent popup Enter selection | Passed; popup closed and returned focus to the form. |
| Review create against unreachable provider | Rejected safely; name and search inputs retained, no apply confirmation or successful mutation claimed. |
| Close manager after failed review | Passed; normal navigation restored. |
| Today with AI paused and no report | Passed; downloaded counts were 64 unread / 130 Inbox / 2 Drafts, with paused guidance. |
| Today → Summarize now | Passed; reviewed one explicit mailbox; missing AI setup disabled Generate summary. |
| Cancel immediate-summary review | Passed; returned to Today; Activity reported no work. |
| Calendar without any connection | Passed; October grid and selected day visible; connection guidance and disabled New Event. |
| Calendar month navigation and opening Settings | Not established: the desktop tool's native pipe closed during the action batch. |

## Parallels results and blocker

The initial candidate passed actual VM **fresh onboarding smoke**. The owned VM run failed at `folder-manager-and-pickers` with `Folder search lost case-insensitive path matching or selection.` It therefore did **not** establish complete owned/restart VM acceptance.

The smoke assumed that an asynchronous WinUI TextChanged event had completed after 50 ms. Source `60ff841d07995428e9a097d4eafdb6cd6f375ecd` replaces the fixed sleeps with a bounded wait for the expected list state; the original search, selection, hierarchy and delta assertions remain. [CI 36882998703](https://github.com/Coke1120/Morrow-Mail/actions/runs/36882998703) passed its macOS acceptance and Windows fresh/owned/restart walkthrough. A retest in this VM is still required before attributing the original failure solely to timing.

After the first VM run, CUA could read the VM but could no longer reliably forward guest input. The guest command interface requires Parallels Pro/Business and was unavailable. The desktop tool subsequently returned `Sky Computer Use native pipe closed before response` for native app operations even after a reset. The existing app processes stayed alive; this is not evidence of an application crash. A prepared, test-only PowerShell UI Automation script controls only its independently launched fixture window. Human bootstrap was requested because the tool could not start it. No OS sharing, execution policy, TLS or security setting was changed.

## Automated scenario coverage

The local locked Rust suite with the IMAP error fix passed **184 tests** (31 test-result groups, `--test-threads=1`); rustfmt and strict all-target Clippy passed. The first parallel local suite encountered one CLI fixture initialization 409 writer-lock error; that CLI group passed on isolated rerun, and the complete serial run passed. The cause of that isolated parallel failure is not established; no production writer guard was weakened or retry added to hide it.

The downloaded macOS production service also passed the existing native acceptance runner locally: Models/HTML/WindowAssertions, owned requests, cached folders and Settings refresh, draft/Bcc/signature persistence, Pending, combined pages, schedule locks/cancellation, tab permission gates, shutdown/restart, encrypted persistence, online backup and disconnect isolation. Native HTML/network-zero checks passed. This runner and CI do not substitute for a manual accessibility audit.

| Risk / branch | Runnable evidence |
| --- | --- |
| Fresh onboarding; cached navigation; sidebar width bounds; search without changing owner/selection; reader layouts | Windows native smoke; macOS WindowAssertions and RustIntegration. Actual Windows drag and full long-name visual acceptance remain pending. |
| Folder hierarchy, missing parents, cycles, parent excluding self/descendants; independent dropdown search and retained selection | Both native folder/layout checks; `folders`, `gmail_folders`, `imap` Rust tests. |
| Gmail/Outlook/IMAP create, rename, parent move, delete, protected folders, invalid names, expired/consumed reviews | Provider TLS fixtures and folder service tests. Successful CRUD was not operated through a live-account UI. |
| Email Move and Gmail add/remove checklist; preserve Inbox/Pending/other owner; create then separately assign | `gmail_sync`, `mail_service`, `mail`, `folders` and native picker/delta checks. Native create-from-email success remains pending. |
| Offline cache, provider quota/backoff, authentication rejection, malformed responses, reconnect/disconnect isolation | `folders`, `history_retry`, `gmail_sync`, `background`, `calendar`, `storage`. |
| Reply/Reply All/Forward, owner lock, provider draft copy, Bcc delivery, uncertain send fingerprint | `drafts`, `mail_service`, `gmail_sync`, `imap`, native ownership checks. |
| Scheduled send: immutable payload/time, locked drafts, cancel, restart, interrupted claims, late grace | `scheduled`, `background`, native fixture persistence checks. All test delivery targets are fixtures. |
| Today review, explicit mailbox, disabled AI, context redaction, source/connection change, no hidden retry | `background`, `ai`, native tab/permission checks; manual missing-setup/cancel branch above. |
| Calendar month/all-day/DST boundaries, reminders, provider-specific permissions, immutable restart/retry request | `calendar`, native Calendar/layout and persistence checks. Live event creation remains unverified. |
| General autosave during in-flight save, unsaved review guards, model/permission changes, Settings refresh | Both native interaction/integration checks; `ai`, `calendar`, `learning_identity`. Manual theme/keyboard walkthrough interrupted by tooling. |
| Out of Office partial consent; reply-suggestion preview/draft-only; Brain/skills source validation | `out_of_office`, `reply_suggestions`, `learning_identity`, `ai`. |
| Reader hostile HTML, blocked images/forms/frames/scripts, stale callback/close and plain fallback | `message_html` plus both native reader-isolation checks. |
| Update signature/provenance, manifest/path validation, pending-write/edit guards, installer/restart/rollback | `updater`, native restart/lifecycle checks and fixture installers. Installed-app/live-update walkthrough remains outstanding. |
| Startup authentication, loopback/origin/account headers, duplicate IDs, backup and writer isolation | Native production-service acceptance; `storage`, `cli`, `mail_service`, `calendar`. |
| 1,000/10,000/50,000 fictional-message service workload | Paired CI benchmark. This is not large-cache interactive UI or a Thunderbird comparison. |

## Corrections and remaining acceptance

IMAP TCP errors passed through the generic `std::io::Error` conversion, which says the workspace could not read/save files. The shared IMAP connect function now maps TCP errors to the same safe provider failure as timeout/TLS errors. One loopback connection-refusal regression checks both normal and management catalog calls; all 14 IMAP tests passed, without disabling TLS or changing write retries.

Pending manual acceptance includes the corrected VM picker retest, sidebar drag/long-name and small/large window checks, right-click and create-from-email success/cancel paths, full keyboard/accessibility navigation, live consent/reconnect/write operations, installed updater restart/rollback and clean Windows machines without WebView2. Live provider/model operations require a separate authorized test account/workflow. No new release or public binary replacement is part of this walkthrough.
