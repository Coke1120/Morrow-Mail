# Rust service compatibility inventory — 2026-09-28

Current behavior baseline: **v0.6.0-beta.16**, release commit `7ab30cbb3e496118513a98f8211ec66481e282c4`. Rust is the default desktop service; macOS uses SwiftUI and Windows uses React/Electron. The paired release and its acceptance evidence are recorded in [VERIFICATION.md](../VERIFICATION.md). The original M0–M5 inventory baseline, `585fe1d8bc53c04062911a97c4f1d46fa5ad0ed4`, remains historical evidence, not the current feature scope.

The approved [native migration plan](RUST_NATIVE_MIGRATION_PLAN.md) replaces the unexecuted conditional Tauri direction with WinUI 3/C++/WinRT. The source inventory below is a starting point for N0/N1, not completed WinUI acceptance or new whole-app performance measurements. Stable signing, minimum-OS/accessibility and broader live-account acceptance remain separate gates.

## Responsibility map

| Responsibility | Rust implementation | Acceptance |
| --- | --- | --- |
| Private lifecycle / local API | `bin/morrow-service.rs`, `service.rs` | `rust-service.test.js`, `RustIntegration.swift`, Electron smoke |
| SQLite / AES settings / backups | `store.rs`, `normalize.rs` | `storage.rs`, `rust-storage.test.js`; full OpenCC corpus, Node↔Rust cipher and writes, backup restore, panic/disk-full rollback, legacy writer exclusion |
| Bounded lists / counts | `pages.rs` | Node differential HTTP tests, native integration; six sorts, locale/number/Chinese/diacritic ordering, long-subject cursor bounds, colliding IDs |
| Mail / OAuth / organization | `mail.rs`, `providers.rs`, `imap.rs`, `oauth.rs` | `mail.rs`, `mail_service.rs`, `imap.rs`, `calendar.rs`; isolated TLS, owner/Bcc, explicit send recovery, refresh rotation, Unicode folders, UIDVALIDITY and MOVE/COPYUID |
| Independent calendars | `calendar.rs`, `oauth.rs` | `calendar.rs`; browser-bound PKCE/state, pagination, 409 recovery, original Node request hashes, create/replay/restart, permission and connection races |
| AI / workflows / learning / confirmed identity | `ai.rs`, `workflows.rs`, `learning.rs`, `policy.rs` | `ai.rs`, `learning_identity.rs`; catalog actions, redaction before context, source/Brain/skill/identity revocation, automatic coalescing, preview ownership/replay, budgets/recovery |
| Imports / summary schedules / Activity | `background.rs`, `activity.rs` | `background.rs`, `history_retry.rs`, `activity.rs`; atomic pages/cursors, one history page and ≤4 serial summaries per tick, DST/clock rollback, bounded transient read retries, safe public errors, source/generation revocation and shutdown |
| Scheduled sends | `scheduled.rs`, `mail.rs` | `scheduled.rs`; immutable review, owner/idempotency, draft/request locks, cancellation, late grace, restart uncertainty, shared delivery path and shutdown drain |
| Pending | `service.rs`, `mail.rs`, `pages.rs` | Native `RustIntegration.swift`, `scheduled.rs`; owner-bound patch, count/page/detail, import preservation and duplicate IDs |
| Reply Suggestions | `reply_suggestions.rs`, `learning.rs` | `reply_suggestions.rs`; confirmed identity, downloaded/permitted history, reviewed batch, source/style/generation recheck, draft-only result |
| Out of Office | `out_of_office.rs`, `oauth.rs` | `out_of_office.rs`; provider capabilities, additional consent, owner/revision validation, partial/obsolete consent rejection |
| Sanitized HTML reader | `message_html.rs` | `message_html.rs`, native reader checks; plain fallback, scripts/forms/frames removed, per-message external-image consent and link review |
| Keyword / semantic search | `search.rs`, `search_query.rs`, `smart_search.rs` | `smart_search.rs`, `rust-search.test.js`; parser/OpenCC, exact filters, HMAC pagination, model/permissions/source generations, incremental chunks, query cache, pause/restart/budgets/transport limits |
| Signed updates / installer | `updater.rs` | Unit and `updater.rs` fixtures; real TLS downloads, signatures/ZIP/hash/platform/version, cancellation, mailbox/calendar/index busy guards, both-process wait, restart/rollback |
| Desktop hosts | SwiftUI `AppModel`, Electron `main.cjs` | Single-instance/start-stop ownership, private pipe startup, host-only update token, actual native Rust harness and packaged smoke |

Rust implementation names above are relative to `rust/src/`; Rust test names are relative to `rust/tests/`. This map describes the published clients and service; the partial WinUI candidate results are recorded below.

## Native migration parity matrix

Client paths below are relative to `macos/Sources/MorrowMail/` and `src/`. WinUI must preserve each operation and its recovery boundary; existing fixtures are reusable evidence, not a substitute for executing the new client. The broader [feature coverage](../FEATURE_COVERAGE.md) remains authoritative for simulations and unsupported capabilities.

| Feature / Rust owner | SwiftUI caller | React caller | Existing checks and required WinUI acceptance |
| --- | --- | --- | --- |
| Accounts, OAuth, complete history — `mail`, `oauth`, `background`, `providers`, `imap` | `SettingsView.swift`, `AppModel.swift`, `ActivityView.swift` | `Settings.jsx`, `App.jsx`, `ActivityStatus.jsx` | `gmail_sync.rs`, `imap.rs`, `history_retry.rs`, native harness: reconnect/disconnect isolation, Yahoo IMAP preset, months=0, provider-specific Spam/Trash exclusions, checkpoint/resume/retry; never claim a complete live mirror. |
| Lists, reader, local changes — `pages`, `service`, `message_html` | `MailView.swift`, `MessageBodyView.swift` | `App.jsx`, `MessageBody.jsx` | Paging/HTML contracts and native harness: six sorts, duplicate IDs, retained selection/manual unread, safe links/images, reader scrolling, Pending counts and import preservation. |
| Compose / delivery — `drafts`, `mail`, `content` (draft preparation is unreleased) | `Models.swift`, `MailView.swift`, `AppModel.swift` | `message-draft.js`, `App.jsx` | `drafts.rs`, `mail_service.rs`, `imap.rs`, `draft-prepare.test.js`, `message-draft.test.js`: shared draft corpus, Reply All/Forward ownership, provider-draft copy, To/Cc/Bcc, saved/unsaved guards, exact uncertain-send review. |
| Scheduled — `scheduled`, shared `mail` send | `MailView.swift`, `Models.swift`, `AppModel.swift` | `Scheduled.jsx`, `App.jsx` | `scheduled.rs`, `scheduled.test.js`, native harness: same UUID replay, frozen payload/time, locked draft, cancel/new schedule, 15-minute grace, missed/blocked/uncertain and no replay after restart. |
| Today / Activity — `background`, `activity`, `service` | `TodayView.swift`, `ActivityView.swift` | `Dashboard.jsx`, `ActivityStatus.jsx` | Background/activity fixtures and client checks: display existing account-scoped reports/progress, empty states and failures; reading a dashboard must not trigger provider/AI work. |
| Search / embedding — `search`, `search_query`, `smart_search` | `SearchView.swift`, `SearchSettingsView.swift` | `App.jsx`, `SearchSettings.jsx` | `smart_search.rs`, search UI/contracts: connection probe, scoped preview/budget approval, background indexing while navigating, pause/resume/cancel, cache and revocation. |
| Per-message AI / workflows / Brain — `ai`, `workflows` | `MailView.swift`, `StudioView.swift` | `App.jsx`, `Studio.jsx` | `ai.rs`, `reply-history.test.js`: popup ownership, bounded downloaded correspondent history, redaction/source checks, one-use previews, clearly labeled simulations. |
| Learning / identity — `learning` | `StyleLearningView.swift` | `StyleLearning.jsx` | `ai.rs`, `learning_identity.rs`, `learning.test.js`: account-confirmed name/aliases, opt-in, saved settings → preview → confirmation → proposal → explicit apply; do not overwrite unrelated Brain content. |
| Reply Suggestions — `reply_suggestions` | `ReplySuggestionsView.swift` | `ReplySuggestions.jsx` | `reply_suggestions.rs`, `reply-suggestions.test.js`, native guards: confirmed identity, reviewed paid batch, cancellation, source/style/identity invalidation, proposal use/dismiss; drafts only. |
| Out of Office — `out_of_office`, `oauth` | `OutOfOfficeView.swift` | `OutOfOffice.jsx` | `out_of_office.rs`, `out-of-office.test.js`: additional consent, fresh provider revision, explicit write review, stale owner/partial consent rejection; Google/Microsoft only, no IMAP/Yahoo claim. |
| Calendar — `calendar`, `oauth` | `CalendarView.swift`, `Models.swift` | `Calendar.jsx`, `calendar-dates.js`, `CalendarSettings.jsx` | `calendar.rs`, calendar UI/provider tests and native checks: month/checkbox selection, read-only calendars, civil all-day dates/exclusive end, DST, reminders, frozen retry ID/payload across restart. One calendar account per provider remains the current limit. |
| Settings / backup / updates — `service`, `store`, `updater` | `SettingsView.swift`, `AppModel.swift` | `Settings.jsx`, `useUpdates.js`, Electron bridge | Settings contracts, native/packaged/actual-upgrade harnesses: serialized preference diffs, explicit credential/permission saves, preserved dirty forms, online backup, hourly check/badge, explicit install and both-PID wait. |

## N1 shared-logic audit

This started as a source-level classification. The first draft-builder extraction below is now implemented in unreleased source; the rest remains an audit, not completed N1 acceptance. Follow all callers before changing an API, preserve both existing clients during transition, and keep server validation authoritative.

| Current duplication / boundary | Existing authority | Smallest justified action |
| --- | --- | --- |
| Previously duplicated `Models.swift` and `src/message-draft.js` reply recipients, Reply All, forward quoting and provider-draft copying. | New `rust/src/drafts.rs` reuses `content::recipients` and owned-message lookup through `POST /api/drafts/prepare`. | Implemented in unreleased source: both clients call the service, including AI result insertion. Saved-draft decoding remains local. The original behavior corpus is shared by Rust and the explicit Node compatibility implementation in `server/message-draft.js`; that compatibility code retires with Node, not as a desktop fallback. |
| Account selection, locked From and stale asynchronous response guards exist in both clients. | `service.rs`/`mail.rs` independently validate explicit owner and connection generations. | Keep selection and stale-response guards in the UI; do not invent a second account state machine or weaken server ownership checks. |
| `SearchSettings` and `StyleLearning` display eligibility/budget/dirty-state prerequisites. | `smart_search.rs`, `learning.rs`, `reply_suggestions.rs` validate permission, identity, source, budget and transitions. | Reuse existing state projections; add a narrow missing capability only when a demonstrated mismatch needs it. Keep confirmation and unsaved edits local. |
| Schedule date/UUID review, calendar civil-date layout and frozen retry review are represented in both clients. | `scheduled.rs` owns send transitions/grace/locks; `calendar.rs` validates reminders, writes and idempotency. | Keep platform date input, formatting, month layout and reviewed-operation identity; remove only duplicated business decisions, not the review/recovery state needed across restart. |
| Resource/license compatibility scripts now delegate to Rust; the normal release still calls the JS publisher. | `morrow-resources`, `morrow-notices`, versioned `rust/resources/`; `morrow-publish` remains unwired. | Complete the N5/N6 caller/workflow transition before retiring Node modules. Keep fixed-version historical checks separate from the normal build/release path. |

## API boundary

Both clients retain the loopback HTTP/JSON contract. Desktop startup reads a bounded private stdin JSON line with the random bearer, absolute workspace, optional host update token and parent PID. Development Electron may additionally provide a validated absolute assetDirectory over the private pipe; packaged hosts use bundled assets, and this never selects OAuth credentials. Credentials never enter argv. EOF or termination signals cancel background work, drain accepted requests and finish queued database writes. A selected Rust service does not start Node on failure.

Host must be loopback; hostile Origin and cross-site requests fail. Only narrow, browser-bound OAuth authorize/callback routes omit bearer authentication. Mutation bodies require JSON, have a 256 KiB limit and a read deadline. Mail-bound mutations require a captured `X-Genmail-Account`; `all` is read/sync only. Provider IDs stay unchanged, and `viewId` is JSON `[account,id]`. Public responses contain safe connection metadata, never tokens, API keys or vectors.

Credential-entry forms may temporarily hold user-entered secrets and submit them through the authenticated private API. Hosts do not persist/log them, read saved secrets back or expose them to the mail reader. Rust owns encrypted storage and OAuth refresh; host bootstrap bearer/update tokens remain separate.

Errors retain `{error}` and applicable 400/401/403/404/409/413/415/429/502 statuses. Uncertain sends retain `requiresSendReview`, the owned draft, original request ID and payload fingerprint. Reconnect and disconnect invalidate in-flight AI/search generations even if permissions later return to their original values.

| Read | Contract |
| --- | --- |
| `GET /api/state`, `X-Morrow-View: paged` | Existing settings/account/workspace plus revision/counts; ≤50 metadata rows and `mailPage`. Legacy full state includes account-scoped arrival summaries. |
| `GET /api/state/revision` | Lightweight revision/account; idle clients reload only after change. OAuth/manual refresh still reload. |
| `POST /api/mail/page` | Account header and folder/category/unread/sort/locale/cursor/pageSize; default 50, maximum 100. Signed cursor binds revision and scope. Rust cursors carry a row identity, so large subjects cannot exceed the cursor limit. |
| `GET /api/messages/:id` | Explicit connected owner, full owned message plus validated AI summary. Reader refresh preserves manual unread; drafts wait for full details. |
| `POST /api/search` | Existing syntax, owner scope, 30 results/page, safe snippets/chips/coverage. Semantic query vectors are cached/coalesced; pagination does not repeat paid embedding. |

Additional mutation/recovery contracts to retain:

| API | Contract |
| --- | --- |
| `POST /api/drafts/prepare` (unreleased) | Explicit owner and `{messageId,mode,body?}`; modes `reply`, `replyAll`, `forward`, `copy`. Reads the current owned message, accepts optional text only for replies, returns `{draft}` without saving or contacting providers/models. Rejects client-supplied source/owner/footer fields; only provider drafts may be copied. |
| `PATCH /api/messages/:id` with `pending` | Captured real owner; local boolean independent of stars, retained through import; Pending is a virtual list filter, not a provider folder. |
| `GET/POST /api/scheduled`, `POST /api/scheduled/:id/cancel` | Immutable owner/payload/time and request ID; owner-only list, safe draft marker, guarded cancellation; only the internal claimed send may bypass its own schedule lock. |
| `POST /api/style/{settings,preview,generate,apply}` | Identity is explicit per-account settings, not a model-inferred signature. Preview/generation never silently applies a learned style. |
| `GET /api/reply-suggestions`; `POST` subroutes `settings`, `preview`, `run`, `cancel`, `use`, `dismiss` | Explicit owner; reviewed downloaded/permitted context, source revalidation and draft-only use. Interrupted work does not silently replay paid requests. |
| `GET/PUT /api/out-of-office` | Explicit connected owner, supported provider and additional OAuth scope; write uses fresh reviewed provider revision. Unsupported capability is not simulated success. |

Uncommon text sorts scan scoped metadata. This is intentional until measurements justify persistent collation keys. Folder/date paths use indexes and materialize bounded identities before reading message JSON. SQLite and synchronous work run on a bounded blocking executor; the HTTP request gate permits 32 active handlers and the database has one executor permit. Mailbox-changing work keeps the existing global gate; calendars have independent provider gates.

## Storage and recovery

- SQLite keeps composite `(account,id)` messages and JSON, `settings(id=1,value)`, FTS5 tables/functions/triggers and additive `morrow_schema=1`. FULL synchronous / DELETE journal durability is unchanged. Unsupported schema and missing/wrong keys fail closed before migration.
- Settings remain base64 of **12-byte IV + 16-byte GCM tag + ciphertext**, using the existing raw 32-byte key. Known Node pending-send and calendar hashes remain compatible.
- Preserve `settings.scheduledSends`, `deliveryAttempts`, each draft's safe `scheduledSend` marker and each message's `pending` flag. Scheduled sends require the app to run within a 15-minute late grace; interrupted claims recover as uncertain and never automatically resend. Only scheduled/sending drafts are schedule-locked; uncertain delivery retains its separate review guard.
- Preserve per-owner `styleLearning` settings/confirmed identity/proposal/approved profile and `replySuggestions`. Retaining data does not bypass source/permission/generation validation on use. Calendar review strings in `client-state.json` and native `pending-calendar.json` retain exact request IDs/payloads; migrations must not recreate operations. Out of Office is provider-managed and must not be rewritten on startup.
- First takeover takes an OS workspace lock and retained SQLite exclusive lock, excluding legacy Node writers as well. It writes a consistent, integrity/decryption-checked backup to `migration-backups/<id>` before schema work. The source must be closed before a second process can back it up.
- Backups include the matching key, SQLite and `pending-calendar.json` / `client-state.json`. `morrow-service --backup <absolute-source> <new-absolute-destination>` rejects overwriting a backup. The native Back Up Workspace control uses a host-token-only online backup on the same DB executor; it retains mailbox/calendar operation exclusion. Close the app before restoring a verified matching set; never replace current data with an old backup merely to roll back a binary.
- POSIX directories/files use 0700/0600. Windows uses a protected owner/System DACL and rejects reparse points. Symbolic workspace files are rejected. Native and Electron keep their existing workspace identities; a trusted absolute `MORROW_DATA_DIR` supports isolated workspaces.
- Incremental FTS backfill keeps cached messages readable. A SQLite expression index on source message metadata supports complete counts and pages while derived rows are missing; startup verifies coverage before trusting the completion marker. It uses SQLite builtins and remains writable by Node. Derived semantic chunks carry source/model/normalization version and monotonic scope generations. Revocation removes vectors synchronously; legacy Node vectors need a reviewed rebuild. Interrupted claims do not automatically replay model requests.

## Network and update limits

Production providers keep fixed HTTPS endpoints, validated pagination URLs and platform TLS verification. Shared HTTP retries and redirects are disabled; OAuth/browser redirects and updater GitHub redirects have their own narrow validation. IMAP/SMTP require TLS, with STARTTLS required on non-465 SMTP ports. IMAP responses are bounded at 8 MiB per command before parser allocation; SEARCH uses 8192-UID windows and a 128 KiB response cap. A page scans at most 32 windows, with persistent history cursors across sparse gaps. Manual/initial sync reports incomplete sparse scans and directs the user to history import; it does not claim to have reached all recent mail. MIME parsing runs serially on a blocking worker. Test trust anchors/DNS mappings live only in test/library injection; no production environment/provider override exists.

Model endpoints accept HTTP only on loopback, never follow redirects and bound request time/response size. Smart indexing caps review at 50 messages, batches at 16, and jobs at 12,000 chunks / 4 million scalars with durable budget accounting. Hybrid ranking considers at most 200 lexical plus 200 semantic candidates. Pausing, failure or restart does not silently resume paid work. Calendar listing retains the existing page/count and 90-day query bounds.

The updater keeps the compiled pinned Ed25519 key, paired manifest format, original archive roots and metadata paths (`Contents/Resources/backend/package.json`; `resources/app/backend/package.json`). It rejects renderer-selected URLs/paths/commands, verifies hash/signature/platform/version/archive layout, respects mailbox/calendar/index activity, and waits for both host and service exit before swapping. The old app is retained and the separate workspace is preserved. Stable signing/notarization and live-provider acceptance remain external release gates.

## Build and evidence

One unpublished Cargo package, lockfile, Rust 1.98 minimum; `package.json` supplies the product version. Main/production remains **v0.6.0-beta.16: SwiftUI on macOS, React/Electron on Windows, Rust service on both**. The legacy builders retain `MORROW_SERVICE_RUNTIME` selection in bundle metadata; the native candidate builders use Rust. Third-party license notices accompany the service; source links identify unmodified dependencies. `cargo audit --file rust/Cargo.lock` checks the locked graph.

The native candidate path uses `morrow-resources` for unchanged versioned catalog/OpenCC checks, `morrow-notices` for the locked production dependency graph, and `morrow-build` for the SwiftUI/Rust bundle. Shared branding/fonts live in `assets/`; the compiled update key comes from `rust/resources/`, with the same legacy Node bytes retained separately. The normal `check.yml` release still uses npm/Node callers and `scripts/publish-release.js`. `morrow-publish` implements same-CI-run artifact verification and uploads from verified staging, but is not wired to publication. Live build/test/publisher callers must be migrated before their Node dependencies are retired.

The Node-free macOS candidate build and Rust-driven Swift acceptance passed locally and in CI, followed locally by the actual fixed-beta16 installer upgrade with preservation and backup checks. Windows candidate **`005c9fb`** passed compilation/package inspection and the all-mail, workspace and Settings phases; the reader phase failed at its 25-second limit. Full Windows walkthrough and historical-upgrade acceptance remain incomplete.

Candidate **`581131f`** passed Node-inaccessible formatting, all-target strict Clippy and full Rust tests on both platforms. The canonical macOS ZIP/checksum build and retained Models checks passed; its HTML upward-scroll fixture failed. Windows again reached the initial HTML document timeout after controller creation. The bounded macOS scroll wait and WebView2 host-navigation guard corrections require the next native run. Fixed-beta16 storage/search/service differentials and historical upgrade remain gated on those native checks. **All N0–N6 completion gates remain open**, including required manual/live, accessibility/minimum-OS, signing, main cutover and paired-release gates. No native Windows production replacement is claimed. See [verification](../VERIFICATION.md) and the native plan before removing legacy callers.

Published/legacy compatibility commands below are not the Node-free candidate path:

```sh
npm run rust:test
npm run check
npm run macos:test
npm run macos:rust:test
npm run desktop:test
MORROW_SERVICE_RUNTIME=rust npm run macos:build
# On Windows: select rust, build, then npm run desktop:test -- --packaged
npm run updater:test
npm run updater:rust-upgrade:test
npm run benchmark:mail -- --output=test-results/migration-node.json
npm run benchmark:mail -- --engine=rust --output=test-results/migration-worker.json
npm run benchmark:rust-service -- --output=test-results/migration-rust-service.json
```

Fixtures use temporary fictional workspaces and generated signing/TLS keys. First/warm latency, migration/restart, payload and service CPU/RSS are reported separately from UI and driver. Reopen is not a flushed OS cache; five warm samples are descriptive. The 30-second idle and bounded backfill measurements do not replace Instruments, accessibility/IME checks or minimum-OS hardware acceptance. Exact local/CI outcomes are recorded in [VERIFICATION.md](../VERIFICATION.md); fixture coverage does not imply live-account acceptance.
