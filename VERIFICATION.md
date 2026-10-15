# Verification — 15 October 2026

## Selected custom IMAP folder sync — 15 October 2026

This candidate is stacked on bounded read-session commit
`ec0a38363cf303b479ce99d22512aa13b294e03d`, which includes the IMAP origin dependency.
The isolated source adds explicit selected-folder new-mail pages, independent safe
failure/freshness state, and version-checked atomic commits, using the separate
IMAP server-origin identity change as a prerequisite. [Scope and service contract](docs/SELECTED_IMAP_FOLDERS.md).
All 18 new synthetic checks passed: four selection/ownership/state cases, 12
loopback TLS protocol cases and two transaction/request-review cases. They cover
burst pagination and restart, source/reconnect/UIDVALIDITY changes, in-flight
cancellation, persisted backoff, malformed pages, stale/protected catalogs,
both target Inbox commits before a held custom read, and atomic rollback including
search effects. The first route run exposed a test setup error in its partial
settings replacement; the corrected fixture preserves both account and catalog
maps without relaxing the production freshness guard.

Rustfmt and locked all-target Clippy with `-D warnings` passed. The complete locked
Rust suite with `--no-fail-fast` passed **474 tests, 0 failures, 4 existing ignored
benchmarks**. Focused checks, fmt, Clippy and the full suite used the same 102-file
Rust/Cargo source manifest.

Native portable checks passed 71 state assertions and 18 version-fence assertions;
the later string-only periodic-sync wording correction passed 23 source checks.
The interval-zero wording now preserves existing quota/update continuations of
previously requested reads. macOS/Windows SDK builds and native runtime fixtures
remain pending platform CI. All executed provider/model tests used isolated
fixtures; no live-account, release or UI-performance acceptance is claimed.

The initial PR54 focused native run38705784868 at `274e113` failed compilation:
two local functions in FolderSyncView accessed MainActor-owned model state from
an unannotated local-function context. Both are now explicitly `@MainActor`;
their guards and call sites remain inside the existing MainActor `perform`
closure. The original failure is retained. This two-annotation follow-up changes
no Rust source or deadlines and requires fresh platform CI; Linux has no Swift
compiler or macOS SDK, so source review is not a native compile result.

The subsequent PR54 Windows job at `01698b8` passed 470 Rust tests with 0 failures
and 4 ignored, then failed native compilation with 14 C2664 errors in
`FolderSync.cpp`: the UI adapters passed `std::wstring` values to helpers taking
`const winrt::hstring&`. The follow-up adds explicit `hstring` construction at
those 14 call sites only; the portable state helper, owner/version guards,
controls and deadlines are unchanged. The original SDK failure is retained.
Source diff/hash review is not an SDK result; the corrected Windows build and
native fixtures require fresh platform CI.

PR54 Windows job `116341562940` at `4cef395` subsequently passed formatting,
strict Clippy, all 470 Rust tests (0 failures, 4 existing ignored), and native
packaging, then failed the `selected-folder-sync` runtime assertion
`Filtering discarded the native folder selection.` The original log is retained.
That assertion combines the visible-control count and in-memory selection
count; the old log recorded neither value. Its printed phase timestamps come
from a buffered diagnostic tail and do not measure the native operation duration.

Source review confirmed that detached checkbox callbacks could still change the
selection after rows were rebuilt. The follow-up invalidates the row generation
before clearing controls and requires the current pane, generation and exact
current control identity before accepting a checkbox event. It retains the
existing configuring/busy/stale checks. The native fixture keeps the original
filter assertion, five-second waits and unsaved-close checks, adds exact counts
before filtering and bounded numeric failure details, and emits real Unchecked
events from a retained old checkbox both while filtered and after replacement.
This closes a confirmed source-level stale-callback gap; it does not establish
that this event caused the original CI failure. Fresh Windows SDK/runtime
validation is pending; no local native pass is claimed.

The next Windows job `116367581897` at `c5c054f` retained the same filter failure
with concrete counts: two visible controls and two selected folders before and
after the input. Selection was retained; the log does not establish whether the
TextChanged event was delivered, suppressed or unable to rebuild the rows. Its
cause remains unresolved. A fixture-only scoped TextChanged observer now adds
capped event counts, sender/weak-owner checks, row-generation progress, loaded/
size/enabled/configuring/current booleans, query length and equality to the fixed
fictional query, and the matching-row count. Configuring is sampled at the
observer, not claimed as the production handler's branch. No raw folder/query
text is added. Production event/filter code, the single Text assignment, original
five-second wait, selection/control assertions and stale-checkbox controls are
unchanged. There is no forced template/layout, scrolling, focus, render call,
retry or deadline extension. The receipt only distinguishes the next actual
Windows failure; it is not a root-cause fix or a local native pass.

PR54 Windows job `116387074152` at `7d581d4` then passed 475 Rust tests with
0 failures and 4 existing ignored, packaging and the fresh native walkthrough,
but failed the same filter assertion in the owned walkthrough. The bounded
receipt now records zero observed TextChanged events, row generation `1->1`,
the exact eight-character fictional query and zero predicate matches. The
TextBox was not loaded and had no positive dimensions before the input; all
three became true during the unchanged wait. Selection stayed at two. This
identifies an input-before-mount fixture ordering gap; it does not establish a
production filtering defect or retroactively prove the older failures' cause.

The fixture now requires Opened plus the actual filter's loaded state, positive
width/height and enabled state within the original single five-second initial
deadline. It then keeps the single Text assignment, original five-second filter
wait, exact zero-controls/two-selected assertion, bounded receipt and detached
checkbox negative controls, and additionally requires a real TextChanged event.
Production code and handlers are unchanged. There is no forced layout/template,
direct render, second input or additional deadline. Source invariants and diff
checks are the only local validation; Windows SDK/runtime validation remains
pending. The original terminal failure and its complete log are retained.

## IMAP server identity and safe migration — 15 October 2026

This source follow-up starts from main
`d5ac97c5d51cc265cc769d07bd36d7d013fa5c67` and incorporates the documentation/version-only
v0.8.2 main commit `6a52974afdd80edda0ed5e29972157f3288906a8`. It separates cached IMAP identities
by the actual validated endpoint and LOGIN principal, preserves old local IDs
and user data, and prevents foreign or unproven copies from issuing provider
reads or mutations. Old history coverage, scope/date inputs and cursors cannot
be reused by another connection generation. Missing legacy generations require
reconnection before a new import can replace saved progress.

The four unchanged tests in `rust/tests/imap_identity.rs` ran against that exact
base: one same-server compatibility case passed and three regressions failed
(cross-server UID collision, unproven legacy adoption and inherited history
completeness). The repaired source passed all four. Additional synthetic tests
cover two TLS servers returning the same UID/Message-ID, source-specific flags
and body reads, source-bound folder catalogs, malformed provenance, retained
draft/uncertain-send references, missing-generation no-write recovery, and
atomic migration rollback.

A final cross-review also reproduced a separate folder-management gap in the
initially passing implementation: applying one server's confirmed rename/delete
could rewrite another source's retained folder path or history cursor. The
follow-up carries the captured connection into the atomic cache update, filters
IMAP rows by origin and restricts cursor changes to the current import. The
focused regression initially had two failures and one passing current-source
case; it also checks replacement of the captured connection before any local
write. Its API-call adapter changed with the captured-connection parameter;
the four baseline regressions above remain byte-identical.

Schema 1 upgrades to one schema-2 marker in the same transaction as the origin,
FTS, folder-membership and thread work. Empty, malformed, multiple and future
schema markers fail before migration. The actual service binary built from
the base above rejected a synthetic schema-2 workspace with exit 3 / HTTP-style
409 and left both database and key bytes unchanged. This is an executed
downgrade-gate check for that base binary, not a claim about every historical
release. See [backup and recovery requirements](docs/IMAP_SERVER_IDENTITY.md).

Final source `cargo fmt --all -- --check` and locked all-targets Clippy with
`-D warnings` passed. The focused folder/identity/migration/service checks passed
72 tests with one existing ignored benchmark. The locked complete Rust suite
with `--no-fail-fast` passed **444 tests, 0 failures, 4 existing ignored
benchmarks**. All four runs used the same 99-file Rust/Cargo source manifest;
the final folder-management fix is included in those results.

Native macOS/Windows, live-provider, large-workspace migration latency and
signed-release acceptance remain pending. Tests used only temporary synthetic
workspaces and loopback fixtures; no real mailbox, model, external send, user
workspace or user backup was used.

## PR #52 ownership-probe fixture coordination — 15 October 2026

Run `38713018388` at head `921fc1c` failed a macOS Rust fixture before the
package/native gates. Its fake reader exited after a fixed 0.5-second sleep,
before the separately launched Python probe created `started.txt`. The test
was unchanged from the released base. A synthetic 0.8-second probe startup
delay reproduced the same missing-file failure on Linux.

The fixture now signals readiness only after its exclusive single-shot marker
and flushed output exist. The fake reader waits for that signal within the
unchanged two-second absolute deadline, then completes while the probe still
has ten seconds of work. Cancellation, reaping, single-shot, captured output
and reader-success assertions remain unchanged. All 23 native-check binary
tests, formatting and strict all-target Clippy pass on the corrected source;
this does not establish macOS native acceptance.

The same run's Windows native gate separately failed the existing 20-second
controller initialization deadline. Its environment returned after 2,313 ms;
the controller returned only after the timeout. The bounded event trace is
complete and its dispatch observations do not establish a continuously blocked
UI thread. This is a second unresolved Windows acceptance failure, distinct
from the earlier post-navigation initial-document timeout below. No production
deadline, retry, cold-start requirement or success predicate was relaxed.

## PR #52 Windows initial-document diagnostic follow-up — 15 October 2026

PR #52 head `01c1f0a9e27262bb61c9a878961ffe26ed42437a` passed macOS and
Windows Rust checks/packaging in run `38699628543`, but the owned Windows
Reader failed at the unchanged 25-second `initial-document` deadline. Its first
expected navigation was allowed; completion was not observed. This is an open
Windows acceptance blocker, not an established IMAP-origin regression or a
diagnosed runtime fault. PR #51/#53 and the released base's passes do not replace
that failed result.

After normally merging main `337a2f740390d20b329f698ce4e7c5d32bcdcc09` into
the identity branch, this follow-up adds only marked-fixture observations for
actual initialization returns, the first navigation's fixed event fields, early
validated runtime version, and bounded wait/dispatch intervals. It preserves
the original 20/25-second limits, cold setup, success predicates and no-retry
behavior. New details share a 24-record budget with explicit overflow and remain
within the existing 64-event timeline. See the [diagnostic contract and its
limits](docs/WINDOWS_OBSERVATION_PROVENANCE.md).

Linux checks passed **73 actual pure-helper/trace/native-fixture assertions**
with C++20, warnings denied and ASan/UBSan, PowerShell syntax checks, and the
actual bounded pipe/parser controls. Positive/negative cases cover unsigned
64-bit navigation IDs, signed 32-bit error codes, timing/counter limits,
malformed/private text, unavailable observations, overflow and tail trimming.
An actual C++ trace writer also fed the actual PowerShell reader: its typed
records survived while the child retained exit 7. These are synthetic metadata
checks; no Windows SDK, WinUI/WebView2 runtime, real mailbox, provider/model,
Cargo build or CI rerun was executed for this diagnostic edit. The final head's
normal Windows/macOS CI remains required; the historical timeout's cause remains
unknown.

## Saved summary job diagnostics — 15 October 2026

This separate follow-up starts from PR #50's tested tree, later merged as
`d5ac97c5d51cc265cc769d07bd36d7d013fa5c67`. It changes summary status projection
and its native Activity details, independently of Today aggregation. A historical
failed job can remain Activity's last finished summary while Today has no valid
current-day/current-context report. That display does not establish a new model
failure, its original cause, or a retry.

The Activity snapshot includes an opaque mailbox-bound job reference, normalized
status/trigger, recorded times, message count and an allowlisted diagnostic.
Only exact server-authored errors and a strictly parsed HTTP-status template are
mapped; provider bodies, URLs, summary text and message items are not returned.
Cancelled, interrupted and skipped are distinct from failed. New normal terminal
transitions record their finish/update time; restart recovery records observation
time without inventing the interruption's actual finish. Missing legacy identity
or timestamps remain unavailable. No schema change or new detail API is added.

Both native clients capture the selected job metadata when its detail entry opens,
preserve that snapshot across newer activity and close it when its owner or page
scope is revoked. The detail view is read-only and does not navigate to Today's
filtered aggregate or start provider/model work. The saved job is never retried
automatically; independent future arrival/schedule policy is unchanged.

Preparation evidence: three new contract tests failed against the previous
projection because it lacked matching job metadata. The first repaired targeted
run passed **30 tests** across summary diagnostics, Activity and background work,
including synthetic stale/current context, state/error mapping, missing fields,
loopback response failures, terminal persistence and no replay after restart.
Final Linux Rust 1.98 validation passed rustfmt, locked/offline all-target Clippy
with warnings denied, and the full suite: **432 passed, zero failed, four existing
ignored benchmarks**, across 47 result groups. The full-suite log SHA-256 is
`90e584f471b2cf9f5f4636919b10974ab3e0dcb5f28ecd2607636fd3d7191603`.
Additional native fixture assertions cover captured identity, safe fields,
timestamps and the detail entry/lifecycle. Independent source review corrected
an overly restrictive Windows selected-account check: Activity lists every
connected mailbox, so a displayed job's owning account may differ from the
selected mail view. Captured page generation and connected-owner checks remain.
Linux cannot compile or execute the SwiftUI/WinUI candidates; exact-head native
results will be recorded with the draft PR after validation. No real mailbox, outgoing mail or external
model was used, and the user's historical model failure cause remains unknown.

### Initial PR #51 native result and diagnostic follow-up

[Run 38691628248](https://github.com/Coke1120/Morrow-Mail/actions/runs/38691628248),
attempt 1, tested head `96912573a73424a51115f8c86a4091088cd94c4a`.
macOS passed 432 Rust tests and all 40 strict reader samples. Windows passed
428 Rust tests and packaging, then failed its owned reader initialization before
the summary Activity fixture. The retained phases show entry into controller
readiness waiting, not completed readiness; no HRESULT was retained. The original
cause is unknown, and this is not classified as a missing-runtime acceptance pass
or dismissed as flakiness. That failed run does not validate Windows summary UI.

The follow-up retains only the first fixture initialization origin, fixed stage,
HRESULT and elapsed time, with eight-record and parser bounds. It does not alter
the 20/25-second reader deadlines, add retries or weaken acceptance gates. Summary
dialog fixtures now wait for actual Opened before revocation and give closing a
fresh five-second bound. Portable actual-code checks passed 39 diagnostic and
64 summary-helper assertions with ASan/UBSan; PowerShell parsing and actual-pipe
positive/negative diagnostic controls passed. These Linux checks do not compile
or run WinUI/WebView2. Fresh exact-head paired CI remains required, and the
original initialization cause remains unresolved. This draft is excluded from
v0.8.2.

## v0.8.2 release preparation — 15 October 2026

The owner requested a release of already merged main before the separate
diagnostics and mailbox-improvement PRs. The product source is main
`d5ac97c5d51cc265cc769d07bd36d7d013fa5c67`, tree
`6173fb08ad75d57958eca9af48d17dd0936dfde2`, including PRs #48–50.
No intervening main commit was present at preparation. Only `package.json` and
release documentation change here. All unmerged diagnostics/mailbox changes and
the frozen Today follow-up are excluded; workflows, builders, publisher,
production source, persisted formats and the pinned update key are unchanged.

PR #50 head `2405ac126ed52e23e1e6a5077c582f5e6349d607`, its tested synthetic
merge and the actual main merge have the same product tree.
[PR native run 38686362605](https://github.com/Coke1120/Morrow-Mail/actions/runs/38686362605),
attempt 1, passed both complete jobs: macOS 427 and Windows 423 Rust tests,
zero failures and four existing ignored benchmarks on each platform. macOS
captured all 40 reader samples, with parent exit zero, no errors and no network
activity. Windows retained complete fresh/owned/restart observations (4/42/34
samples), complete owned/restart reader timelines, PowerShell 5.1 relocation
and the synthetic service benchmark. The separate
[observer run 38686362200](https://github.com/Coke1120/Morrow-Mail/actions/runs/38686362200)
also passed its native process-family and stop-race fixtures without weakening
unknown-exit or first-acquisition failure gates.

The exact-main [push run 38690524448](https://github.com/Coke1120/Morrow-Mail/actions/runs/38690524448),
attempt 1, completed successfully before tagging. Its macOS job `116275112194`
passed 427 Rust tests and all 40 strict reader samples; Windows job
`116275111938` passed 423 Rust tests and all required native/package checks.
Both had zero Rust failures and four existing ignored benchmarks. The main
push correctly skipped publication. Fresh v0.8.2 tagged checks run both native
platforms again; the existing publisher requires successful same-run,
same-attempt jobs and paired artifacts before signing and publication. The
release tag, all six public downloads, checksums, pinned-key manifest signature
and package versions must be checked after publication. Preparation does not
predeclare those outcomes.

Published v0.8.1 passed its tagged run `38624861643`, attempt 1, and six public
assets were independently downloaded and verified on 14 October. Earlier
preparation sections below retain their original point-in-time status.
Original PR #48/#49 failures and historical Windows error-87/unknown-exit and
reader failures remain failures, not explained away by passing later runs.
macOS remains ad-hoc signed without notarization; Windows is unsigned.
Live-account, clean-machine, manual accessibility and complete installed-updater
acceptance remain incomplete. See [release notes](docs/releases/v0.8.2.md).

## Bounded IMAP read-session candidate — 15 October 2026

The candidate adds one-round connection reuse for IMAP change discovery and
flag reconciliation, plus explicit unsupported-MOVE preflight feedback. Its
10 new loopback TLS cases count LOGIN commands and cover owner isolation,
connection changes, cancellation, partial responses, capability/UIDVALIDITY
changes, the real 45-second deadline and the existing missing-folder fallback.
Two unit cases cover consumed/deadline-bound leases and fixed service error
mapping. The source is stacked on identity commit
`01c1f0a9e27262bb61c9a878961ffe26ed42437a`, including v0.8.2 release metadata.
The focused TLS run passed all 10 cases, including the actual 45-second stalled
read. Locked all-targets Clippy with `-D warnings` and the formatting check passed.
The locked complete Rust suite passed **456 tests, 0 failures, 4 existing ignored
benchmarks**, across 49 result groups. These four runs used the same 100-file
Rust/Cargo manifest; source and log hashes were checked after execution.
The identity author's static cross-review confirmed the origin guards, filtered
queries, import binding and atomic commit proofs remain intact.

This is isolated Linux fixture evidence, not native or live-provider acceptance.
Native CI and live-provider acceptance remain pending. The 90-second bound is
covered with a controlled-deadline unit, not a real 90-second experiment.
IDLE, persistent connection pooling
and non-MOVE fallback are not implemented by this candidate. See
[the precise scope](docs/IMAP_READ_SESSIONS.md).

## IMAP notification candidate — 15 October 2026

This isolated draft adds bounded IDLE for eligible Inbox and selected custom
folders, with explanatory native Settings text. It is stacked on selected-folder
head `4cef39561bb69e9bc170315dd0482f6ee0d1f906`, including the macOS actor and
Windows string-boundary corrections above, server-origin identity and read-session
reuse. It is excluded from the separate v0.8.2 release.

The 31 new notification TLS/Store cases and 18 existing selected-folder focused
cases passed. Formatting and locked all-targets Clippy with `-D warnings` passed.
The locked complete Rust suite passed **505 tests, 0 failures, 4 existing ignored
benchmarks**, across 50 result groups. Final formatting, Clippy and full tests
used the same 105-file Rust/Cargo manifest, checked before and after each run.

The final stack normally merges selected-folder head `c5c054f`, including its
native row-lifetime follow-up and the summary diagnostics already on main.
At combined head `f5221d1`, formatting, strict all-target Clippy and the complete
locked suite passed **510 tests, 0 failures, 4 existing ignored benchmarks**
across 51 result groups. All three checks used the same 106-file Rust/Cargo
manifest, verified before/after and against the final files. The notification
implementation is unchanged by that stack. Native SDK acceptance remains
pending for this combined candidate.
The focused runs preceded two Clippy-only edits (a tuple type alias and equivalent
Option `?` expression); the full suite covers those final sources.

Coverage includes checked continuation/DONE, capabilities, absolute deadlines,
invalid responses, cancellation, Store rollback/ABA, source/selection/UIDVALIDITY
binding, fair owner/folder rotation, four total/one-per-owner notification socket
bounds, clock-only retry/catalog expiry, live LIST checks, connection-wide versus
folder-only failure policy, shutdown/quiesce, quota/backoff preservation, hint
coalescing and the existing sync/arrival-policy path without direct model calls.
Tests shorten leases and backoff; they do not measure a production 60-second
lease or native UI latency.

A static review found a gap between consumer validation and the sync round's
initial settings read. An opaque proof is now checked in the same Store closure
that captures that snapshot. A held-Store control deliberately ignored the proof:
both connection and selection replacement were accepted, each making three
synthetic LOGINs and committing two rows. The guarded case rejects both with zero
provider access or rows. This demonstrates the sync-entry contract; the control
does not reproduce the original consumer's outer cancellation/select scheduling
interleaving, and is not claimed as a byte-identical baseline race reproduction.

The first focused run was 30/31: a 400 ms synthetic lease expired during custom
LIST/setup before its intended wrong-tag protocol failure. Diagnostic results
showed provider_network retries, including for the healthy account. The fixture
now uses one second and requires actual completed DONE exchanges for rotation;
the strict one-login assertion remains. Production lease/setup/retry policy is
unchanged. The narrowed case and final 31-case run passed. Original fixture
shallow settings-patch mistakes were also corrected with full read/modify/write;
the persisted-backoff hint still asserts zero network and unchanged wait/errors.
The initial intentional red control, focused failure and two Clippy diagnostics
are retained in task evidence.

These are isolated Linux fixture results. IDLE native SDK CI, live-provider
acceptance and release validation remain pending. No live mailbox/model or
sending was used. [Behavior and coverage limits](docs/IMAP_IDLE_NOTIFICATIONS.md).

PR57 Windows job `116407284508` (run `38730647752`, head `7529919`)
subsequently failed the Rust checks with **70 passed and 1 failed**. The owned
folder-rotation test reached its final workspace deletion after the fairness,
per-owner socket, global socket and mailbox-gate assertions, then received
Windows OS32. Its native build, walkthrough, relocation and benchmark steps
were skipped. The complete original log is retained; it does not identify the
specific file handle responsible for that deletion failure.

A deterministic held-database control confirms a reachable cleanup gap:
cancelling and joining an `App::db` await can drop the Runtime while its already
started blocking closure still owns Store and the original writer lock. Runtime
Weak expiry or a completed database no-op is therefore not a Store-close proof.
The fixture cleanup now observes the existing writer lock within an absolute
deadline, unlocks and drops its observation handle, and attempts directory
deletion once. Missing-lock, other I/O, deadline and deletion errors still fail;
it never creates a replacement lock or retries deletion. The failed rotation
case uses the remaining budget of the original three-second manager-stop
deadline. Other fixture cleanup calls have an explicit two-second teardown
budget; this is not claimed to be part of their earlier stop deadline. The
manager, socket-drain and production shutdown limits are unchanged.

The new controls cover a cancelled waiter with a still-held Store, timeout
without deletion, pending cleanup until actual lock handoff, an already-expired
deadline and a missing original lock. Production code is unchanged. The initial
retention control passed on Linux before the cleanup change. All **33 IDLE
focused tests passed**, as did formatting and locked all-target Clippy with
`-D warnings`. The complete locked suite passed **512 tests, 0 failures,
4 existing ignored benchmarks**, across 51 result groups. These final checks
used the same 114-file Rust/Cargo manifest, verified before and after execution.
Fresh Windows CI is still required and the historical OS32 failure is not
relabelled as a pass.

## Activity cancellation and native verification repairs — 15 October 2026

This follow-up starts from main `cfe61c9fedfe7f07a99ab84751aabf7bae19d495`,
after PR #48 (`d16c7e2cce1e160c11fa22cf48361eba087e34f7`) and PR #49.
The frozen Today follow-up, release metadata, updater key and workflows are
excluded. This repair does not authorize another merge or release.

Both the [PR #49 run 38680591088](https://github.com/Coke1120/Morrow-Mail/actions/runs/38680591088)
and [merged-main run 38680738219](https://github.com/Coke1120/Morrow-Mail/actions/runs/38680738219),
attempt 1, failed on both native platforms. macOS compilation failed at
`AppModel.swift:779` because the confirmation call omitted the required `detail:`
argument label; the repair supplies it. Windows failed the two new background
cancellation tests with OS error 32 when they removed a temporary SQLite directory
while still owning its App. The tests now join stopped workers and the loopback
server and drop App before removal, retaining their state and no-send assertions.
Successful reader diagnostics after the macOS build error did not run or validate
the skipped package and primary native acceptance steps.

Two deterministic loopback regressions also failed before their respective
repairs. Concurrent manual style workers for A and B both received successful
Activity cancellation responses, but the single watch channel retained only B's
notification when the workers resumed. A kept waiting for the model. A reply
worker similarly retained the shared reply gate when A's cancellation was followed
by B's ordinary reply-settings save before the worker resumed. The background
watch was introduced in PR #49; the separate reply watch already existed and was
reused by the new Activity cancellation route. Terminal result guards prevented
late publication in both cases; these were cancellation/resource-release defects,
not evidence of cross-account writes or sending.

Cancellation now registers a separate mailbox/work-type oneshot receiver
synchronously and delivers every matching stop outside the registry lock. Reply
registration occurs in the same Store closure as its claim. Closed receivers are
pruned, new work does not inherit old notifications, and unrelated mailbox/settings
signals remain isolated. Existing claim identity, result, timeout and drop guards
remain in force. Synthetic tests cover style, scheduled Brain and reply work,
including claim publication after drop, held model responses, real authenticated
cancel routes, stale timestamps, replacement jobs and explicit reviewed retries.
Stale-time tests control stored timestamps; they do not wait for a real 90-second
timer. Brain retries use the real manual preview path, without inventing concurrent
scheduled claims that the production background gate excludes.

Two further controlled scheduling tests reproduced a separate ordering gap:
after a cancellation/settings mutation committed, a new worker could claim work
before the old request resumed and published its stop. The ordinary reply-settings
handler's delayed stop turned a newly approved automatic batch `failed`; a delayed
Activity cancel turned a newly prepared manual style preview `cancelled`. Both
fixtures use production handlers/claims, held loopback models, and database barriers
that check the replacement's persisted state before releasing its response.
The reply approval is created by the actual settings operation. The reply-settings
ordering gap predates PR #49; the Activity route was added in PR #49. Both gaps
precede the oneshot repair. Stop
publication now stays inside the successful mutation's Store closure, including
all four owner-scoped Activity worker kinds and reply settings/cancel. The style
case controls concurrent API scheduling; it is not a natural native-UI reproduction.

The [PR #48 Windows failure](https://github.com/Coke1120/Morrow-Mail/actions/runs/38673897184/job/116223016671)
is retained separately. In owned run 3, sample 3, PID 5800 under parent 5312 had
first native acquisition error 87, source `admission`, no retained window/scan/CIM
receipt clocks and unknown exit code. The collector exited zero and the reader
completed, but strict capture was incomplete. This does not prove why PID 5800
disappeared or establish normal exit. The observer was unchanged by PRs #48/#49.

The observer follow-up covers a demonstrated source gap: a newly discovered parent
was not eligible to preserve its children's handles during the same CIM inventory
window. A new provisional parent now requires its current CIM identity to match
the original live native handle and a revalidated owned parent chain. Child rows
arriving before parent rows are bounded and deferred. The 64-pin/8192-row limits,
original deadlines, first-acquisition errors, final admission and exit gates stay
strict. No missing process becomes proof of successful exit, and the original
error-87 run is not reclassified. New fixtures do not establish universal capture
or explain the historical process's cause of exit.

Local Linux Rust 1.98 validation passed: rustfmt, locked/offline all-target Clippy
with warnings denied and the complete locked/offline test suite, **427 passed,
zero failed, four existing ignored benchmarks**, across 46 result groups. The
full-suite log SHA-256 is
`f0ca553ab1440c99f202edfc91e62b7c2d287a75ac5b4d32ac4e9c30d35cb027`.
All twelve new cancellation tests passed, including four regressions that failed
before their repairs. Independent source/test review found no remaining source
blocker. PowerShell 7.6.6 parsing, identity and fixture C# compilation, bounded
row/schema controls and existing observation/real-pipe checks also passed on Linux;
Windows-only lifecycle checks were explicitly skipped on this host.

Fresh exact-head PR native CI is still required at this preparation checkpoint.
Linux schema/C# compilation cannot establish Win32 behavior or native SwiftUI/WinUI
acceptance. All data and services used here are fictional isolated fixtures, with
no real mailbox, outgoing message or external model. Manual accessibility,
clean-machine, real-account and signing limitations remain unchanged.

## Hybrid navigation shell — 15 October 2026

Source adds the same Mail | Agent | Brain primary chrome on macOS and Windows.
Cold start stays on the Mail three-pane. Agent reuses Inbox Agent, Today, and
Skills. Brain reuses persona, writing rules, and categories. AI Studio moves to
the advanced footer and Settings, with one-release Moved to Agent / Moved to
Brain hints in its More menu. Local Inbox Rules, local simulations, and
simulation history stay in Studio. This does not change review-before-send,
account isolation, or provider writes. No paired native release check has been
run for this shell. It is not a release claim and does not retire any earlier
acceptance record below.

## v0.8.1 release preparation — 14 October 2026

The owner approved merging PR #47 after complete CI and publishing v0.8.1 through
the existing paired workflow. PR #47 was normally merged at
`196e747ce4d66d3862f4fa493ea42110719ef598` on 14 October at 19:23:07 UTC.
Its full tree `4c353b5e373178bac7a5bdefaf489c5e2d0cef8b` exactly matches
the reviewed head `fd43612d60b295f0363e505bc96ce2d588d528c7` and tested
synthetic merge `5451803c247718e34ffa0ba8243cd5aa9ef28392`.
This release changes only the common `package.json` version and documentation.
The frozen Today retention/history/priority follow-up remains excluded.

[PR #47 run 38616699702](https://github.com/Coke1120/Morrow-Mail/actions/runs/38616699702),
attempt 1, completed successfully at 19:22:25 UTC. macOS job 116033689038
passed 410 Rust tests and all 40 reader samples with complete capture, zero
network activity, parent exit zero and no errors. Windows job 116033688475
passed 406 Rust tests, complete fresh/owned/restart observations (4/44/34 samples),
complete owned/restart 22-event reader timelines, PowerShell 5.1 relocated-package
acceptance and the fictional-mail benchmark. Both platforms ran all 16 Gmail
regressions with zero failures and four existing ignored benchmarks. Windows
had no skipped processes, sample gaps, missing milestones or acquisition failures;
collectors exited zero, were reaped and were not forced. These successful samples
do not resolve the preserved intermittent Windows or macOS reader failures.

The separate [main push run 38623219540](https://github.com/Coke1120/Morrow-Mail/actions/runs/38623219540)
was in progress when this release was prepared. Its outcome is not assumed.
The metadata commit uses the existing `[release-on-tag]` convention; the fresh
v0.8.1 tag must run both complete native jobs before the same-run, same-attempt
publisher can sign and publish either download. No test waiver, workflow, builder,
publisher, updater or pinned-key change is included. Tagged CI, publication and
verification of all six public assets remain separate operational checkpoints.

v0.8.0 was published at 18:58:14 UTC, release ID 413074650, from
`0d039aeeeec9db0047a8a57a64a0c5cab2d5e912`. Its tagged run 38613871205
completed successfully at 18:58:19 UTC, including publisher job 116041682601.
It was not cancelled and contains the history authorization regression corrected
here. Its terminal workflow cannot publish later over v0.8.1; all older tags and
assets remain unchanged. Publication metadata is not independent downloaded-byte
verification. The failed, unpublished v0.7.9 candidate and its evidence below
remain preserved. [Release notes](docs/releases/v0.8.1.md) retain Today,
signing, manual/live-account and unresolved native-observation limits.

## Gmail history authorization correction — 14 October 2026

[Review 4274561882](https://github.com/Coke1120/Morrow-Mail/pull/46#discussion_r4274561882)
identified a PR #46 regression: history downloads automatically forced a token
exchange and retried the same page after a Gmail resource-API 401, contrary to
the [history retry policy](AGENTS.md). The earlier 15-test Gmail regression suite
included an incorrect expectation that this recovery should succeed. Its passing
Rust and native runs below remain historical evidence, but do not establish
compliance with the history authorization policy.

The correction starts from `0d039aeeeec9db0047a8a57a64a0c5cab2d5e912`
and removes that retry wrapper from history downloads. Routine token-expiry
refresh before a request remains. The first history resource-API 401 preserves
the last committed checkpoint and cached mail, fails with the existing safe
authorization/reconnect error, and schedules no retry. Neither background work
nor restart resumes that failure. After resolving authorization, explicit Resume
retains the checkpoint only for the same connection. Reconnecting changes the
connection identity and requires starting a new import, while preserving cached
mail. Transient network/quota history backoff is unchanged.
Ordinary sync, folder-catalog and raw-message reads retain their once-only
resource-401 recovery, and compatible reconnect-token retention is unchanged.
No provider-write replay is added.

The replacement first-resource-401 test failed on unchanged v0.8.0 production
with the expected one-token-request-versus-zero assertion. After the correction,
all **16 Gmail tests passed**, retaining the original 13 non-history cases.
The new cases cover list/detail 401, preserved progress and partial-page isolation,
no background/restart retry, explicit same-connection Resume, six token-exchange
failure modes, and successful routine expiry refresh.

Linux Rust 1.98 `cargo fmt --manifest-path rust/Cargo.toml --all -- --check`,
`cargo clippy --manifest-path rust/Cargo.toml --offline --locked --all-targets -- -D warnings`
and `cargo test --manifest-path rust/Cargo.toml --offline --locked` passed.
The full suite completed **410 tests, zero failed, four existing ignored
benchmarks**, across 45 result groups. Its log SHA-256 is
`9b6c49d9433cfd49f5932259b708573d494d43c0923c5bd1e08e67aca208f982`.
Independent source/test/documentation review found no remaining correction blocker.
Fresh PR #47 macOS/Windows native CI passed as recorded above; the earlier
PR #46 native runs do not validate this changed source. All provider tests used isolated fictional
loopback TLS fixtures; no live mailbox, outgoing message or external model was used.

At the recorded 18:25 UTC checkpoint, tag `v0.8.0` already pointed to
`0d039aeeeec9db0047a8a57a64a0c5cab2d5e912` and
[run 38613871205](https://github.com/Coke1120/Morrow-Mail/actions/runs/38613871205)
was still running and unpublished. Cancellation was requested, but no callable
cancel action was available and cancellation was not confirmed. The tag is
preserved; this correction selects no replacement version and changes no release
workflow. The separate Today follow-up remains excluded. Later publication
decisions require current evidence rather than treating this checkpoint as a pass.

## v0.8.0 release preparation — 14 October 2026

The owner requested merging PR #46 and releasing v0.8.0. PR #46 was normally
merged at `258172e9199b6c296ae4a491ac581e81ab3d72d1` after successful native
checks and exact-head/review verification. This main includes PRs #42–46; the
uncommitted Today retention/history/priority follow-up is excluded. Release
preparation changes only `package.json` to 0.8.0 and documentation.

[PR #46 run 38607097601](https://github.com/Coke1120/Morrow-Mail/actions/runs/38607097601), attempt 1, passed both native platforms at head `897dbf717cc55c4be15c471f4388d4e9fdf31218`. macOS passed 409 Rust tests and 40/40 complete, network-zero reader samples. Windows passed 405 Rust tests, complete fresh/owned/restart process observations (4/44/34), complete owned/restart reader timelines, PowerShell 5.1 relocated-package acceptance and the fictional-mail benchmark. Both platforms had zero failures and four existing ignored benchmarks; all 15 new Gmail regression tests ran on each platform.

The actual main merge `258172e9199b6c296ae4a491ac581e81ab3d72d1` has exactly the same full tree (`fcf1be36b41936a99c4c6affd119520e17459265`) as the tested PR head and synthetic merge. Its separate [main push run 38613427620](https://github.com/Coke1120/Morrow-Mail/actions/runs/38613427620) was in progress when these preparation notes were written. That status is not recorded as a pass. Fresh v0.8.0 tagged checks remain required.

macOS job 116000672529 also passed build, mail/reply presentation, service
acceptance, review workspace and wrapping/visibility diagnostics. All reader
captures were complete with parent exit zero and no errors. Windows job
116000672231 passed all strict observation gates with no skipped processes,
sample gaps, acquisition failures or missing milestones; collectors exited zero,
were reaped and were not forced. Both owned reader timelines had 22 complete
phase records ending in passed, with no overflow/partial/read failure. No natural
error 87 or actual ProcessFailed event occurred in this successful run.

The earlier v0.7.9 tag remains at `36202133a13ee634b4eceb8a0dd2693c94ce8c7f`.
[Its run 38606735489](https://github.com/Coke1120/Morrow-Mail/actions/runs/38606735489),
attempt 1, ended failure at 2026-10-14T18:04:43Z: macOS job 115999438976 passed
394 Rust tests and 40/40 complete network-zero reader samples; Windows job
115999438199 passed 390 Rust tests, build/package and benchmark, but its owned
reader failed initialization before html-ready. The timeline was complete and
showed mount-loaded/environment/controller-ready only; that last phase precedes
the readiness wait. No natural acquisition failure or ProcessFailed was recorded,
but the exact initialization HRESULT was not retained. Plain fallback and closed
HTML controls passed before the initialization failure was reported. Restart and
PowerShell 5.1 relocation were not run. The cause remains unresolved; passing
PR #46 does not reclassify this failed tag. Publisher job 116017726388 was skipped,
no v0.7.9 release was published, and the old workflow is terminal before v0.8.0
is triggered. Its tag and all older public releases/assets are preserved.

The metadata commit uses the existing `[release-on-tag]` policy: its main push
avoids duplicate builds, but the v0.8.0 tag must pass both complete native jobs
and the existing same-run/same-attempt publisher. Source, workflow, publisher,
builders, updater, security gates and pinned signing key are unchanged by release
preparation; no test waiver applies. These notes do not predeclare tagged CI,
publication or public-byte verification successful.

Known Today capacity/history/priority limitations remain in the [release notes](docs/releases/v0.8.0.md).
That candidate's Gmail recovery had a one-refresh limit and could perform two
bounded read rounds; its history-download 401 retry was subsequently found to
violate policy, as recorded above. Provider writes are not replayed. Provider
revocation/policy expiry, retained-token
validity and abrupt termination before token persistence remain outside the fix.
macOS is ad-hoc signed without Developer ID notarization; Windows is unsigned.
Hosted fixtures do not complete manual accessibility, physical-device,
clean-machine, live-account/model or installed-updater restart/rollback acceptance.
No real mailbox, outgoing message, external AI or Google Console change was used.

Earlier sections retain their original checkpoints and pending-at-the-time
statements; the exact PR evidence above supersedes the Gmail native-CI status.

## Gmail reconnect recovery — 14 October 2026

This is the original PR #46 checkpoint. The subsequent history authorization
correction above supersedes its history-download 401 behavior, while preserving
the test and CI results as recorded at the time.

This follow-up starts from main `a059dbd76db9c5a7acc8acb34d8c5be8e85ac02a`.
Two isolated TLS fixtures reproduced pre-existing reconnect failures: a Gmail
resource API 401 requested reconnect without trying the saved refresh token, and
a successful authorization response without a refresh token replaced the saved
token. These paths predate PRs #42–45; the reproduction does not identify the
cause of a particular user's failure.

The fix limits resource-401 recovery to explicitly selected safe Gmail reads,
with at most one forced refresh and read retry. OAuth exchange failures keep
their existing revoked-grant versus transient-error classification. Sending and
provider mutations retain their existing no-replay behavior. Reconnect may
reuse a nonempty saved refresh token only after checking the verified owner,
provider, client ID/secret, equal scope sets and unchanged connection. It retains
the newly granted access token and expiry; it does not claim that the provider
has separately revalidated the old refresh token. Missing or incompatible
credentials fail without replacing the old connection.

A sync retry starts from the last committed checkpoint with a fresh fetch cache.
Each attempt retains the existing page/detail bounds; a late 401 can therefore
make one user sync perform up to two bounded rounds. Already imported messages
do not enqueue duplicate arrival jobs. History token-exchange failures retain
manual resume/reconnect handling rather than adding automatic OAuth retries.

Linux Rust 1.98 formatting and strict all-target Clippy passed. The complete
locked offline suite passed **409 tests, zero failed, four existing ignored
benchmarks** across 45 result groups, including all 15 new Gmail regression
tests. The fixtures cover refresh/token rotation and omission, classified token
failures, a single-refresh retry cap, durable checkpoints and arrival deduplication,
connection changes before/during refresh, history cursor ownership and restart,
folder/raw reads, cross-account isolation, Microsoft exclusion, no provider-write
replay, missing-token grant compatibility and wider-scope reconnect rejection.

The first full run exposed an older folder-catalog fixture that assumed every
provider request was GET. Its expectation now permits exactly one owned OAuth
refresh POST returning invalid_grant, while retaining resource-GET, read-count,
offline-name, account-isolation and blocked-retry assertions. That focused case
and the complete rerun passed; the original failed log is retained in task
evidence. This is not a claim that the first run passed.

The existing macOS/Windows PR workflows remain pending for this candidate. Only
isolated fictional accounts and loopback TLS providers were used. No real Google
account, mail, send, external AI call or Google Console change was used. Native CI
does not substitute for live-account, manual accessibility, clean-machine or
signing/notarization acceptance. This follow-up is separate from v0.7.9.

## v0.7.9 release preparation — 14 October 2026

Product source is merged main `a059dbd76db9c5a7acc8acb34d8c5be8e85ac02a`,
containing PRs #42, #43, #44 and #45. This release preparation changes only the
common `package.json` version and documentation. The separate unmerged Gmail
reconnect fix and Today retention/history/priority follow-up are excluded.

Exact-main [run 38598790847](https://github.com/Coke1120/Morrow-Mail/actions/runs/38598790847),
attempt 1, completed successfully at 2026-10-14T17:07:55Z. macOS job 115972305334
passed 394 Rust tests (zero failed, four ignored), native build, mail/reply
presentation, service acceptance, review workspace and reader diagnostics. All
40 reader samples had complete capture, zero network requests, parent exit zero
and no errors. Windows job 115972305734 passed 390 Rust tests (zero failed,
four ignored), native build/package, strict fresh/owned/restart UI observation,
PowerShell 5.1 relocated-package checks and the fictional-mail benchmark.
Observation counts were 4/45/35: all complete, no gaps/acquisition failures or
forced collectors. Reader timeline counts were 0/22/22 with complete owned
mount-to-pass phases and no overflow, rejected lines or partial capture. No
natural error 87 or WebView ProcessFailed event occurred; root-cause repair is
not established. The main run's release job was skipped as expected.

The release metadata commit uses the existing `[release-on-tag]` convention:
its main push does not duplicate builds, while its accompanying v0.7.9 tag must
run both complete native jobs. Publication requires the fresh tag's successful
paired jobs and the existing same-run, same-attempt publisher. These notes do
not predeclare the tag or public-download verification successful. Workflow,
security gates, publisher, builders, updater and pinned signing key are unchanged;
no test waiver applies. Historical failures remain failures.

Known shipped limits are explicit in the [release notes](docs/releases/v0.7.9.md):
Today marker eviction after 200, the latest-20 completion history, unread task
priority ordering, and the two pre-existing Gmail reconnect defects. The owner
requested this release from merged main separately from those follow-ups.
macOS is ad-hoc signed without Developer ID notarization; Windows is unsigned.
No real mailbox, delivery, Google Console change or external AI call was used.
Hosted CI does not complete manual accessibility, real-device, clean-machine,
live-account/model or installed-updater restart/rollback acceptance.

Earlier sections below retain their original evidence and pending-at-the-time
statements; this current exact-main record supersedes their native-CI status.

## Writing-rule edit retention — 14 October 2026

The #42 follow-up keeps unsaved text per rule and in the new-rule field. A
successful save acknowledges only its submitted input; toggles and unrelated
saves retain the other buffers. Both native clients include those edits in their
existing mailbox/page/quit guards. Windows memory actions that rebuild the page
require pending rule edits to be saved or discarded first.

Added macOS assertions in `macos/Checks/main.swift` exercise the production
`WritingRuleEdits` state, including multiple rows, only-new-input dirtiness,
matching save/cancel and edits made after a submitted snapshot. The Windows
native smoke suite now uses the actual TextChanged and automation handlers with
the marked temporary fixture service: toggle, save, duplicate-save failure, add
and discard must preserve unrelated text and global dirty state. These checks
run in the existing paired native CI paths; they do not send mail or call AI.

This follow-up was edited on Linux, without the macOS SDK or WinUI/MSVC. Static
diff checks passed; execution of the new native checks and platform builds is
pending fresh CI. No manual accessibility, live-model or real-account acceptance
is claimed, and prior CI does not establish these new UI scenarios.

## PR #43 Today and category follow-up — 14 October 2026

Today now excludes completed suggestions and summary duplicates before selecting
its eight unread Inbox candidates per mailbox. A partial SQLite index supplies
that ordered window without scanning read/archive messages. Valid completed
summary items remain available when a newer job is queued or failed; the existing
source/permission validation still withdraws changed content. Todo identities are
bounded hashes of the owner, original message ID and category ID. Existing
completion records are read compatibly and can be reopened with the new identity;
old short identities remain accepted for already rendered controls.

Both category editors now guard loading another category, clearing edits and
replacing edited fields with a drafted name. Drafted names remain unsaved. macOS
also registers category edits and draft-name prompts with account/page navigation,
quit and update guards. Reset confirms that it discards the editor. Categories
remain labels selected by priority/order, and skill schedules remain review queues;
this change introduces no classifier, model execution or provider action.

Local Rust 1.98 formatting, strict all-target Clippy and the complete locked Rust
suite passed: **357 passed, zero failed, four existing ignored tests**. Durable fictional
fixtures in `rust/tests/home_regressions.rs` cover the four reproduced failures
(completed-window starvation, newer queued/failed summaries and long IMAP IDs),
plus source invalidation, restart persistence, duplicate IDs across accounts,
legacy completion/reopen compatibility and unchanged mail state. The production
SQL unit fixture covers 5,000 irrelevant read/archive messages, 40 unread rows and
32 exclusions; it requires the partial index, no temporary sort, the next eight
rows and a bounded SQLite VM step count. All six new integration cases and the
indexed-query unit fixture passed within that complete suite.

`python3 -B scripts/test-category-edit-guards.py` passed six source-contract checks
of the actual SwiftUI/WinUI replacement and navigation handlers. Running it with
`--source-ref e59d331ee61df0fbfb64517217404d5ce1d62053` reproduced eight failing
assertions in the original PR; the existing Windows account/page navigation
contract still passed. These are static checks, not native UI execution. This
Linux host has neither macOS nor Windows SDKs. Native builds and interactive
Cancel/Discard, account/page, quit/update and keyboard/accessibility checks remain
required on those platforms. No real mailbox, provider send or model request was
used. This entry does not claim paired release, live-account or signing acceptance.

## v0.7.8 release preparation — 14 October 2026

Product behavior on this branch is main
`b5d049802b24bcd32397e4987f25038fc1924046`. The release commit changes
`package.json` to 0.7.8 and documentation only. No v0.7.8 tag exists, and these
notes do not claim that a tagged run of
[Native checks and paired releases](https://github.com/Coke1120/Morrow-Mail/actions/workflows/check.yml)
has passed. Publication still requires a fresh paired tag: both platform jobs
and the same-run, same-attempt publisher, reading `docs/releases/v0.7.8.md`,
before either download is public. The workflow, publisher, and pinned Ed25519
key are unchanged. There is no gate waiver.

Merged pull-request jobs are separate from that tag. [PR #34 run 38346545006](https://github.com/Coke1120/Morrow-Mail/actions/runs/38346545006),
attempt 1, passed both platform jobs at `0fee5cd` (tree matches merge `973ebce`);
the release job was skipped. Earlier PR attempt
[38305777306](https://github.com/Coke1120/Morrow-Mail/actions/runs/38305777306)
failed and stays a failure; later PR attempt
[38318138779](https://github.com/Coke1120/Morrow-Mail/actions/runs/38318138779)
and main push
[38350446596](https://github.com/Coke1120/Morrow-Mail/actions/runs/38350446596)
passed without reclassifying it. [PR #39 run 38361066616](https://github.com/Coke1120/Morrow-Mail/actions/runs/38361066616),
attempt 1, passed both platform jobs at `d2c717a` (tree matches `cf8ce9b`); main
push [38372551175](https://github.com/Coke1120/Morrow-Mail/actions/runs/38372551175)
also passed; its release job was skipped. [PR #40 run 38445747986](https://github.com/Coke1120/Morrow-Mail/actions/runs/38445747986),
attempt 2, passed both platform jobs at `2b1a652` (tree matches `b5d0498`).
Attempt 1 of that run was cancelled. The release job was skipped. Focused review
lifecycle [38445747941](https://github.com/Coke1120/Morrow-Mail/actions/runs/38445747941),
attempt 1, passed. Main push
[38497374718](https://github.com/Coke1120/Morrow-Mail/actions/runs/38497374718)
of `b5d0498` was still running when these notes were written, so it is not
recorded as passed or failed.

macOS remains ad-hoc signed without Developer ID notarization. Windows remains
unsigned. Residual native observation failures recorded for v0.7.7 stay failures.
Manual VoiceOver/Narrator, keyboard/focus, clean-machine, installed-app, and
real-device UI checks remain incomplete. Live-account, model, and provider
acceptance is not claimed. See [release notes](docs/releases/v0.7.8.md).

## Local Inbox Agent — current source

The in-app Inbox Agent stores conversations per mailbox in the local workspace and calls only the configured OpenAI-compatible model. Fixture tests cover persistence, account isolation, confirm-before-send, a refused direct-send tool, cancellation of an in-flight draft, and the absence of cloud-agent endpoints in `rust/src/inbox_agent.rs`. These checks do not establish live-account or live-model acceptance, and they are not part of the v0.7.8 release claim above. macOS and Windows chat surfaces follow the existing AI Studio More page; this Linux note does not claim a native UI run.

The 14 October follow-up passed Rust formatting, strict all-target Clippy and the full locked suite on Linux: **381 passed, zero failed, four existing ignored tests**. This includes 31 Inbox Agent integration tests and four deterministic database-queue tests for cancellation, deadline expiry, deletion and active confirmation. Fixtures verify revoked/changed model context, aggregate source limits, private staged drafts, shared writing permissions, Reply-To freshness, action revalidation, complete payload review and server rejection of legacy incomplete previews. Models bind loopback only; delivery tests use local Demo simulation. These results apply to this PR branch; the combined writing-rule integration and native SDK jobs are separate verification steps.

Native send confirmation requires a complete, account-bound preview and displays the entire body, From/To/Cc/Bcc, attachment names/IDs/sizes/types and the effective footer. Footer HTML is displayed as noninteractive text so link destinations remain reviewable without loading resources. Legacy truncated or incomplete previews cannot enable Send. Both clients read the saved conversation after an interrupted turn or confirmation, poll a running/recovering conversation, and keep Stop available while a model turn is busy; no mutation is automatically replayed. Account, conversation and operation-generation checks discard stale completions.

`python3 -B scripts/test-agent-stop-lifetime.py` passes on Linux with C++20 AddressSanitizer. It extracts the actual Windows Stop, mutation and recovery-poll coroutine bodies into an isolated fake-request fixture and checks suspended-frame ownership, Stop while busy, duplicate cancellation, captured mailbox/conversation, stale results, interrupted POST → GET recovery and later read-only polling. It does not execute WinUI or the native HTTP client. The macOS model checks and Windows native interaction smoke include the production send-preview formatter with a body over 64,000 characters, duplicate-name attachments, Bcc and footer link destinations, plus incomplete/foreign-preview rejection. Those added platform checks still require the macOS/Windows SDK jobs; this Linux session cannot claim native compilation or UI acceptance.

## v0.7.7 published — exact tagged attempt and public bytes

[v0.7.7](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.7.7) published
at23:20:35UTC fromaeec364f, annotated objected0b9fd. Tagged38318144951 attempt1
passed Windows115039607315,Mac115039607627 and publisher115049780298. Public
six-asset downloads/digests,ZIP CRC/paths/0.7.7 versions/ARM64+x64 architectures,
production updater pinned signature/checksums/archive/stable-channel negatives
passed; oldv0.7.4 and tags5/6 preserved. See [full evidence and hashes](docs/releases/v0.7.7-verification.md).

Preceding main38317496182 and38317725083 remain Windows failures: first87/unknown
ownedcase2/sample13 PID3648/parent5412, and shutdown root inventory gap in restart
case3/sample28 PID4564/parent1536. Both Mac/allUI cases passed, but strict resource
observation did not. Successful tagged samples do not repair these records or
establish all mainCI green/universal87 resolution. Exact causes/limits are recorded
in the linked evidence. Gates were not weakened; no rerun or duplicate publication.

## v0.7.7 release preparation — Codex Cloud, 12 October 2026

The final observer [PR37](https://github.com/Coke1120/Morrow-Mail/pull/37) normally
merged at78e742f9e3d5b841ca10b23a3ce42a87d644703b after exact-head
[paired38314176365](https://github.com/Coke1120/Morrow-Mail/actions/runs/38314176365),
attempt1, passed both platforms. Mac331 / Windows327 Rust tests passed with0
failures and3 existing ignored benchmarks each. Windows4/41/33 observations were
complete, all skip counts/root skips/missing milestones0, collector0/reaped/notforced,
PS5.1 relocation and1k/10k/50k benchmarks passed. Mac native acceptance/review,
wrapping/visibility and40/40 complete/network-zero reader samples passed.

[Diagnostics38314176522](https://github.com/Coke1120/Morrow-Mail/actions/runs/38314176522)
passed37 native lifecycle cases,13 identity,24 pinned-helper and9 snapshot controls.
Exact same-pin zero passed while7/changed creation/first87/5 remained gaps, without
new counters/cache; all temporary pins closed and workers stopped. A real child
born after the window began proved native background capture and same-pin zero.
Initial6ba/b11 diagnostics38313728903/38313790700 failed fixture callback helper
scope before new window controls; explicit function capture fixed wiring at7f07695.
Both initial failures remain failures and were not rerun.

Review [PR35](https://github.com/Coke1120/Morrow-Mail/pull/35) normally merged at
7c2f2cf252024258b22a8daf09221c45dcc1314f after final combined
[paired38314182628](https://github.com/Coke1120/Morrow-Mail/actions/runs/38314182628),
attempt1, passed BOTH platforms at1cb36f49cbf757af516b0b59ad9f6b90b7bf293a.
Mac332 / Windows328 Rust tests passed,0 failed and3 old ignored each. Windows
4/46/35 strict observations were complete with all skips/missing milestones0,
collectors0/reaped/notforced, relocation and benchmarks passed. Mac40/40 reader
samples were complete/network-zero plus full native/review/wrapping/visibility pass.
[Focused Mac38314182626](https://github.com/Coke1120/Morrow-Mail/actions/runs/38314182626)
again reproduced immutable v0.7.6 full Skip/second404 and retarget/save ghost guards,
then passed candidate full handlers, polling, account isolation, same-key/failed
transfers, update/exit guards and retained saved drafts. Linux locked/offline332
tests and23 focused tests passed; all-target Clippy/rustfmt passed. Windows controls
exercise the workspace commit operation, not the full network refresh handler.

The final merged tree exactly matches that tested combined candidate. Thunderbird
PR34 is not an ancestor and no related runtime diff is included. Only common
version metadata and documentation prepare0.7.7 afterward; local author/committer
and tagger usehowailok1120@hotmail.com. Published v0.7.4 metadata/body/all six asset
IDs/sizes/digests/times match the saved baseline. Failed v0.7.5/v0.7.6 annotated
objects37f49dd518db64457c5539f7e861187c98034e75 and97aa4d9566d4e4728643b13d4034b864fe5d0194
remain unchanged and unpublished. Historical unknown87 records remain failures.

This preparation uses the existing release-on-tag policy: its metadata main push
does not duplicate native jobs, while the fresh v0.7.7 tagged run MUST complete
both full native jobs and the same-run/same-attempt Rust publisher before either
download is public. The workflow, publisher and pinned Ed25519 key are unchanged.
No tag is replaced, no failed artifact reused and no acceptance gate waived.
After publication all six public assets require download/hash/version/architecture,
production manifest/signature and old-release preservation checks. See
[release notes and coverage limits](docs/releases/v0.7.7.md). Ad-hoc Mac/unsigned
Windows, manual/clean-machine/installed-app and real-account/model limits remain.

## Pre-row native capture window — cloud follow-up

[PR36 paired38308442440](https://github.com/Coke1120/Morrow-Mail/actions/runs/38308442440)
passed both platforms at exact head484a65e, attempt1; normal merge is0b14ed77.
Windows observations4/47/34 were complete, relocation/benchmark passed, and Mac
40/40 reader samples were complete/network-zero. Diagnostics38308442445 passed
32 native lifecycle cases and13 identity controls.

Combined [PR35 run38308902187](https://github.com/Coke1120/Morrow-Mail/actions/runs/38308902187)
used identical observer source but failed owned case2/sample11: PID6268 and5316,
parent3172, firstnativeAcquire87 with unknown exits. All UI cases passed; Windows
job115009555495 failed and remains failed. Its123.744ms query shows why a row
callback cannot establish an earlier acquisition. [The additional correction](docs/WINDOWS_INVENTORY_WINDOW.md)
keeps bounded native provisional pins during CIM delivery, preserving all final
admission/identity/parent/counter/exit/deadline gates and each first failure.

Linux PowerShell compilation, pure64-bit/input bounds,9 positive/history plus52
strict negative schema controls and script parsing passed. Five additional native
lifecycle controls and a real born-during-window control await fresh native CI;
no Win32 success is inferred from Linux. No rerun, tag replacement or gate waiver.
The previous v0.7.5/v0.7.6 candidates are unpublished and immutable. Next unused
version requires normal tested merges, coherent tagged gates and existing publisher.

## Inventory-delivery observer follow-up

Actual main/tagged logs retained the first-acquire87/unknown-exit failures after
PR33, showing that moving pins ahead of siblings did not remove inventory/tree
collection latency. [The focused row-delivery correction](docs/WINDOWS_INVENTORY_PINS.md)
attempts its original pin as each current child row arrives under an owned live
parent, then keeps all original current-CIM identity/parent/counter/exit/deadline
checks at admission. Every failed first open remains a gap without retry.
New controls release creator handles before later rows/tree processing and
require exact zero/nonzero/changed-identity outcomes. Linux parser/bounds/64-bit/
partial-record and9 positive/history+52 negative schema checks passed; actual
Win32 and paired acceptance remain pending and are not predeclared.

## Delayed PR32 workspace lifecycle findings

The owner added review comments4250639082,4250639092 and4250639096 to the release
completion scope. Full comment bodies and current Rust/Swift/C++ handlers were
read. [Focused scope and controls](docs/REVIEW_STATE_LIFECYCLE.md) distinguish the
review defects from the Windows observer and Thunderbird work.

The isolated Rust index-read trap failed on immutable v0.7.6 source during an
empty projection. After moving Today index loading below nonempty cached saved
items and short-circuiting empty reviewed proposals, the same test passed,
including the real service `/state` path and nonempty-index negative control.
Locked/offline all-target Clippy passed. Native baseline/candidate controls are
required to verify full Mac Skip and retarget/save behavior and Windows workspace
movement; Linux does not predeclare these platform results.

v0.7.6 remains unpublished and its annotated tag is preserved. Tagged
[run38301621120](https://github.com/Coke1120/Morrow-Mail/actions/runs/38301621120),
attempt1, passed Mac but failed Windows strict observation: owned case2/sample13,
PID1464 / parent900, first nativeAcquire87 and unknown exit. All three UI cases
passed; resource observation did not. Publisher was skipped.
Merged-main [run38301357952](https://github.com/Coke1120/Morrow-Mail/actions/runs/38301357952)
also passed Mac but failed owned case2/sample14 (PID3172 / parent3568) and restart
case3/sample4 (PID4788 / parent8152), likewise first nativeAcquire87 / unknown
exit. No rerun or tag replacement occurred. These failures show that sibling
early pins did not remove the inventory-to-first-pin gap. Their actual failure
records remain failures; further observer work and a new unused version are
required before publication.

## v0.7.6 release preparation — Codex Cloud, 12 October 2026

The authorized cloud continuation preserved v0.7.5 and investigated the actual
first `nativeAcquire` 87 / unknown exit failures. [PR #33](https://github.com/Coke1120/Morrow-Mail/pull/33)
pins current children of already-verified live parents before sibling managed
admission. No first failure is retried or inferred to be zero; identity, parent,
counter, exit and existing deadline gates remain strict. Its targeted scope and
pre-pin/process-lifetime limitations are [documented](docs/WINDOWS_EARLY_ADMISSION_PINS.md).

Tested head `1c218f11429ffe88005add18bde5334a7e3459c0` passed
[observer diagnostics 38296886856](https://github.com/Coke1120/Morrow-Mail/actions/runs/38296886856),
attempt 1, with 13 native identity and 29 lifecycle cases. Added sibling/batch
zero controls retained exact original-handle evidence after creator release;
nonzero/changed-identity controls stayed gaps and every pin was disposed.
Existing native 87/5, parent/counter/unknown/deadline negative controls remain.

[Paired PR CI 38296886924](https://github.com/Coke1120/Morrow-Mail/actions/runs/38296886924),
attempt 1, passed Mac 114969999971 and Windows 114970000270. Rust results are
331/327 passed respectively, zero failed, and three existing ignored provider
benchmark cases per platform. Both packages and complete native acceptance
passed. Mac review, 40/40 complete network-zero reader, 12/12 wrapping and 6/6
visibility samples passed. Windows strict fresh/owned/restart observation
(4/44/33 samples) had no gaps, skipped roots, failed counters, missing milestones,
forced collectors or invalid records; relocation under PowerShell 5.1 and the
1k/10k/50k fictional-mail benchmark passed. No rerun or waiver was used.

The PR was normally merged at `6f5a3d0f753f09bd5c9bddec943f07ea314296d6`,
whose parents include the immutable v0.7.5 source and the tested fix head.
Package.json now prepares the next unused version 0.7.6. The release preparation
changes metadata/documentation only after that merge, and uses the existing
paired tagged workflow/publisher. The workflow, publisher and pinned update
public key are byte-for-byte unchanged. New tagged results, public downloads and
signed-manifest verification are not predeclared here.

Cloud execution was checked after a reported disconnection; pushed code and
saved evidence remained intact. No real mail database, credential change or
Thunderbird sync work was used. macOS remains ad-hoc signed without notarization;
Windows unsigned. Manual accessibility, clean-machine, installed-app and
real-account/model/provider acceptance remain incomplete. Unresolved reader
ownership profiling and historical failures remain explicitly disclosed in the
[0.7.6 notes](docs/releases/v0.7.6.md).

## v0.7.5 failed candidate and early observer pins

The immutable v0.7.5 tag points to `966823b948e923df1b7a587c0d08876dee8e9773`
with annotated tag object `37f49dd518db64457c5539f7e861187c98034e75`.
[Tagged run 38287540112](https://github.com/Coke1120/Morrow-Mail/actions/runs/38287540112)
failed strict Windows observation in attempts 1 and 2. The former failed owned
case 2/sample 12 (PID 2400 / parent 6200); the latter failed restart case 3/sample
5 (PID 1544 / parent 1244). Both were first nativeAcquire error 87 with unknown
exit. All three UI cases passed each time, but resource observation did not.
Both macOS attempts passed. The publisher was skipped and no draft/public
v0.7.5 release existed when the cloud continuation inspected the repository.
Failed-attempt Windows artifacts do not establish release eligibility.

The focused [early-pin correction](docs/WINDOWS_EARLY_ADMISSION_PINS.md) removes
earlier siblings' managed admission from the later child's first-open window.
The first failed open, identity/parent/counter failures, nonzero/unknown exits
and existing deadlines remain strict failures. The native batch only pins
current children of already-verified live parents and grants no admission or
descendant authority itself. Added sibling and native batch controls exercise
original-handle retention, exact zero/nonzero evidence and changed identities.

Cloud Linux PowerShell 7.6.6 compiled the helper and passed integer/input checks,
observation parser/bounds/64-bit counter/partial-record checks, and the existing
9 positive/history + 52 negative pinned-exit schema controls. All changed
PowerShell files parsed. Win32 lifecycle proofs were explicitly skipped on Linux;
their CI and tagged release results are separate. The cloud checkout uses no real
mail data, credentials or Thunderbird work. A new unused version must replace
the failed candidate; the v0.7.5 tag will not be moved.

## v0.7.5 release preparation — 12 October 2026

The owner requested a new public release including PR #32. Fresh remote main
was `aee70b6f65915c1af6702b924d9df6096769d5f3`; its parents are the previous
main `537019b29f5b540fbea47c8461adfd4b969a6793` and tested PR head
`a6628d2717de7f0b3c09507cd60ba78d160356f0`. The normal GitHub merge retained
all ten PR commits, with no admin/force bypass or protection change.

Remote tags and public/draft releases had no v0.7.5. Package.json is the common
version source and now prepares 0.7.5; no existing tag/release is overwritten.
Release notes preserve the supplemental ownership and manual/live-account limits.
Only package metadata and documentation change after the tested merge.

[PR run 38277421575](https://github.com/Coke1120/Morrow-Mail/actions/runs/38277421575),
attempt 1, passed macOS 114906188070 and Windows 114906187687; release was
skipped. Windows mounted review editing/facts reset/stale retention/A-B-A/budget/
narrow-pane/placeholder checks passed. All three UI/resource observations were
complete, without missing milestones/counter failures/skipped roots. macOS native
acceptance and fictional review transport passed; retained reader adversarial
40/40, wrapping 12/12 and visibility 6/6 samples were complete and passed.

[Main run 38283121145](https://github.com/Coke1120/Morrow-Mail/actions/runs/38283121145), attempt 1, passed macOS 114924944945 and Windows 114924944578 at the merged commit; its release job was normally skipped.
Fresh tagged macOS and Windows checks and the existing same-run/same-attempt
pinned-key publisher are mandatory before publication. This entry does not
claim tagged success, public downloads or signed-manifest verification.

[Supplemental reader diagnostics 38277421581](https://github.com/Coke1120/Morrow-Mail/actions/runs/38277421581)
failed ownership preflight with requires-root/tool-metadata-unavailable, unresolved
ownership and attachmentAttempted=false; incremental rendering passed. No
privileged capture, signing-key change, permission expansion, workflow waiver or
reader deadline relaxation was used. Real model/provider quality, full manual
VoiceOver/Narrator/keyboard/focus/large-text and installed/clean-machine acceptance
remain incomplete. macOS is ad-hoc signed without notarization; Windows unsigned.
No real mail, credentials or user database was used.


## Unreleased Today and reply review workspace

The independent branch `codex/review-workspace-decisions` starts from main
`537019b29f5b540fbea47c8461adfd4b969a6793`; it does not alter v0.7.4,
its tag, release artifacts or the original release checkout. See
[behavior and known limits](docs/REVIEW_WORKSPACE.md).

Local `cargo clippy --locked --offline --all-targets -- -D warnings` passed.
The full locked/offline Rust suite passed **331 tests, 0 failed, 3 existing
ignored tests**. The focused background/reply/decision integration suites
passed background 17 + reply 10 + decisions 6 + thread index 6 tests. An earlier updater fixture failure was a sandbox
denial of the Swift module cache; the full suite passed with the required
compiler-cache and ephemeral-localhost permissions. No check was weakened.

`scripts/test-macos-review-workspace.py` compiles production SwiftUI sources
with a private initialization seam and an intercepted fictional transport,
never a service or user database. Its assertions cover combined reads,
colliding IDs, per-owner preparation/save/composer review, A/B/A retention,
original ownership, load failure, newer-proposal approval reset, rejected
foreign drafts, dirty-budget retention, unanswered-decision blocking and preserving text when refreshing original evidence.
It can capture the actual views at 1140×720 and 720×720 using
`REVIEW_EVIDENCE_DIR`; screenshots are synthetic UI evidence, not model-quality
or live-account acceptance. The workflow runs this check and retains its PNGs.

The local Windows VM runs Parallels Standard, which rejects `prlctl exec`;
Windows compilation and native acceptance therefore require the PR workflow.
Windows native smoke now checks mounted original/reply editing, approval reset,
newer-suggestion retention, A/B/A scope/draft/selection/budget retention and the
narrow single pane. These additions require the latest PR CI; they do not
establish screen-reader announcements, very narrow
widths/large text, focus retention under polling, installed-app interaction and
live model/provider quality remain manual acceptance items. Existing native
smoke checks do not automatically establish those new review-page cases.


## v0.7.4 published and public downloads verified — 12 October 2026

[v0.7.4](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.7.4) published at **2026-10-12T11:05:52Z** from
`bb72a4fa1d127e9d2d374b3d50476b97a215ed41`. Its ancestry contains PR30 head
`0a0fa2ba808f032c8a14dcfa89d67b63c6d90a16` / merge
`aeb66b1bf8108f4c28dc6564da9083a14304d997` and PR31 head
`77e85046470c44cdef8ab3d2565b9972a5f9f9f8` / merge
`e2e745d5539613839b051431f27774958ee4b2d9`. Normal pushes preserved both
code trees; release author, committer and tagger email is
`howailok1120@hotmail.com`. No protection, admin bypass or force push was used.

[Tagged CI 38236883045](https://github.com/Coke1120/Morrow-Mail/actions/runs/38236883045),
**attempt 1**, passed all required steps and all three jobs without rerun or
waiver. macOS job **114769625036** passed Node-free formatting/strict Clippy,
315 Rust tests, SwiftUI packaging, native search/read/reply and full acceptance,
wrap/visibility diagnostics and **40/40 complete network-zero reader samples**.
Windows job **114769624670** passed 311 Rust tests, WinUI packaging, all
fresh/owned/restart UI and persistence checks, strict observation (4/43/34
complete samples), relocated PowerShell 5.1 acceptance and the 1k/10k/50k
fictional-mail benchmark. Three explicit provider benchmark cases are ignored
in ordinary cargo tests and were separately executed locally; complete numeric
results remain in [the report](docs/SYNC_PERFORMANCE.md). Publisher job
**114780209036** verified actual same-run/same-attempt platform identities and
artifact provenance before publishing paired archives and the signed manifest.

Unauthenticated HTTPS returned release-page **HTTP200** and all **six assets**.
Both downloaded ZIPs passed CRC/path checks, all bundled metadata/plist versions
report 0.7.4, executable architectures match, and exact SHA-256 files match the
bytes and signed manifest sizes/hashes. **Ed25519 verified with the unchanged
`rust/resources/update-public-key.pem`**. The downloaded Mac app passed
deep/strict code-signature verification and plist lint; it remains ad-hoc signed,
without notarization. Windows remains unsigned. Original tagged notes matched
exactly before this verified result and the final candidate failure were appended.
Existing tags and published binaries were not replaced.

| Platform | ZIP bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 14,909,630 | `7f9eaa09e6be9fe69ad83e3bf73824822127ac1b7d351d62aabdd4b09d998689` |
| windows-x64 | 39,450,242 | `51fe29f89fb178905a74655beed23e7b651d54be10911c1888a686529635acc0` |

Final PR31 [run 38235241039](https://github.com/Coke1120/Morrow-Mail/actions/runs/38235241039),
head `77e8504`, attempt 1, completed **failure**: Mac passed all 315 tests and 40/40
reader samples; Windows failed strict restart case 3/sample 4 with PID 7360 /
parent 7708, first nativeAcquire/error 87 and unknown exit. All three UI and
persistence cases, Rust/build and benchmark passed; relocation was skipped.
The always-run benchmark success does not replace failed strict observation. Corrected functional
head `34a9545` separately passed both complete platform jobs in run 38233076840,
attempt 1 (315/311 Rust tests and 40/40 Mac reader samples). Neither its pass nor
this tagged pass erases the retained PR30 or final-PR31 failures, or establishes
a repair of intermittent observer/reader problems.

PR30's separate layout candidate passed direct Parallels fresh/owned/restart
fixtures. Those are not strict collector, final combined package, clean-machine
or full manual accessibility/live-account acceptance. This task used synthetic
stores, mock providers and public artifacts; it never opened real mail/account
workspaces, launched the downloaded app against user data or changed Parallels
configuration. Later source-stage entries retain their historical status.

## 0.7.4 combined merge and release preparation — 12 October 2026

The owner explicitly instructed merging both PR30/31 now and publishing the next
release with known failed/pending verification disclosed, then debugging afterward.
Both drafts were marked ready. Fresh main had no branch-protection configuration
or active rulesets; no protection, admin bypass, force push or required-check
configuration was changed. Ordinary two-parent merges preserve PR30 head
`0a0fa2ba808f032c8a14dcfa89d67b63c6d90a16` at merge
`aeb66b1bf8108f4c28dc6564da9083a14304d997`, and PR31 head
`77e85046470c44cdef8ab3d2565b9972a5f9f9f8` at merge
`e2e745d5539613839b051431f27774958ee4b2d9`. The two documentation conflicts
retain both source-stage records below. Merge author/committer emails are
`howailok1120@hotmail.com`. This task made no observer corrective code change.

PR30's [38231339110](https://github.com/Coke1120/Morrow-Mail/actions/runs/38231339110),
attempt 1, remains Windows failure despite all UI/persistence cases passing.
Owned case 2/sample index 12 records PID4616/parent7140, `nativeAcquire` error 87
and unknown exit, after 12,929.1355 ms with a 54.489 ms sample query. Cases1/3
were complete; relocation was skipped. Its other worker separately completed
fresh/owned/restart Parallels UI/resize/persistence checks, without claiming the
strict collector passed or modifying VM policy. No failed run was retried.

PR31 corrected functional source `34a9545` passed both Rust suites and the complete
Windows native job in [38233076840](https://github.com/Coke1120/Morrow-Mail/actions/runs/38233076840),
attempt 1; its macOS adversarial batch and final documentation-head
[38235241039](https://github.com/Coke1120/Morrow-Mail/actions/runs/38235241039)
remain pending at preparation. Candidate passes do not erase the first CLI
stack-overflow failure or historical observer/reader failures.

Package.json already reports 0.7.4; fresh remote had no v0.7.4 tag or release.
The existing main `[release-on-tag]` preparation policy avoids a duplicate main
build; the accompanying tag still runs all native/Rust/security checks on both
platforms. Publication and usable public assets require that fresh paired run
and the existing same-run/same-attempt pinned-key publisher. No gate, signing
credential, workflow or fixture deadline was changed. Tagged CI/publisher and
public ZIP/checksum/version/Ed25519 verification are pending at this preparation.
The branch-stage entries below retain their original evidence, superseded only
for merged/publication status by this combined record.

## Windows reading-pane fit — Mac mini Parallels, 12 October 2026

The owner's Mac mini runs Parallels Windows 11 ARM64 (`10.0.26200.0`) with x64 emulation and WebView2 `154.0.4258.62`. The VM has no Rust, VS or PowerShell 7 tools on PATH. The public v0.7.3 Windows ZIP was downloaded and passed CRC/path/version, SHA-256 (`e59d1376a2ee23816f1b29e0e26e7d671f2e98fe9f92ec20eb32036c251fad10`) and pinned-key Ed25519 manifest verification. Its application source matches main `5438edf`; only verification documentation differs.

Direct `--native-smoke` runs passed fresh onboarding, owned fictional mail and restart, each with exit 0 and a checked `ok:true` result under the original 180-second deadline. The separate QA helper comes from artifact `11603192938`, source `934297680fc261b8389287551d5e6aefca88613e`; its fixture source and the PowerShell 5.1 relocation script are unchanged. That earlier CI run failed and is not claimed as a successful run. Seeding and final persistence verification passed. The app and helper ran from disposable Windows temporary directories; the fixture stores were seeded and closed before the service launched. No installed app or real mailbox was used.

The existing smoke assertions passed all three densities, light/dark themes and requested list widths 260/320/500, along with settings, composer, native popup and HTML-reader checks. Ten exported mail captures per owned/restart run show that the 500-unit list pushes the 320-unit reading pane beyond the 1024-unit client surface and clips its empty-state text. The existing row-width assertions did not check the reader's outer bounds.

Branch `codex/windows-ui-fit-20261012` bounds the rendered list width using the existing splitter limits and the visible client edge, responds to root/sidebar and mounted mail-view width changes, and preserves the requested width. Unmounted mail bodies do not trigger reflow. The native regression checks the entire reader fits and performs actual DPI-aware window resize cycles without manually reapplying layout. The first run `38221588711` was cancelled after strengthening the client-bound assertion; it supplies no completed validation.

Direct sidebar resizing uses the same fit calculation after native layout places the resized pane. Its regression widens/restores the sidebar twice, checks the actual mail-body position changed by the requested amount, retains the requested list width, and restores the original sidebar without saving fixture preferences.

[Final source run 38231339110](https://github.com/Coke1120/Morrow-Mail/actions/runs/38231339110), head `4437f4eab324758a3531d9363c4e9062863a37b9`, PR merge `29ac6cd18df61d60cbc496bd74efcf353fc71268`, attempt 1, passed the macOS job, Windows Rust/package checks, all three fresh/owned/restart UI results (`ok:true`), actual window/sidebar resize regressions, persistence verification and the fictional-mail benchmark. Windows remains failed because case 2 strict resource observation is incomplete (`nativeAcquire`, native error 87, no exit code); cases 1/3 were complete and relocated acceptance was skipped. This failure was retained without rerun or waiver. Subsequent documentation edits do not change the tested native source.

The exact Windows candidate from artifact `11739826696` (39,093,218 bytes, SHA-256 `4f0f9a63b3e27b336edde9ec7796f3fb3e96e170ce1b2744ed57545fb005b432`) passed CRC/path/version/hash/x64-PE checks and direct Parallels fresh/owned/restart smoke, each exit 0 with `ok:true`, plus final persistence verification. The original 180-second process and 25-second reader gates were unchanged. The owned/restart runs reached the theme/density/width, actual window-resize and sidebar-resize regressions and exported 20 fictional-mail captures. Evidence is retained separately under `candidate-vm/`; the candidate is unreleased. This successful run does not establish that the earlier intermittent reader failures are repaired.

[Run 38221879092](https://github.com/Coke1120/Morrow-Mail/actions/runs/38221879092), head `9efb48da15cbceaa8adb785da8950062576197be`, attempt 1, passed the macOS job and Windows Rust/package checks. The Windows theme/density/width matrix passed, but its subsequent resize assertion failed; relocated acceptance was skipped. Fresh strict observation and the fictional-mail benchmark passed; owned observation is incomplete and the Windows job remains failed. The captured client width was 1008. The revised regression bounds resize targets by the native maximum track width, checks the actual resulting size, restores the original window, and reports client/body/list/reader dimensions on failure.

The same candidate ZIP (`d95a9ebf9919534e083c59a04282202bc21fa357b4661110fde59833a618d76b`) passed CRC/path/hash checks and fresh smoke in Parallels. Its owned run failed earlier at `reader-isolation`: `metadata-html` exceeded the existing 25-second total deadline. A separate diagnostic run also passed fresh smoke but stopped at `metadata-plain` under that same deadline. Neither ran restart or reached the layout regression. These failed results are retained independently under `candidate-vm-9efb48-run1/` and `candidate-vm-9efb48-diagnostic2/`; the gate was not relaxed.

[Run 38225810991](https://github.com/Coke1120/Morrow-Mail/actions/runs/38225810991), head `f2ee15b68acfda24b28baab3f648ce1bbd5c808c`, failed Windows compilation because the new diagnostic passed `hstring` to the smoke helper's `const wchar_t*` parameter. The call is corrected to pass its string data within the expression's lifetime. This run supplies no revised Windows runtime validation; later candidate results are recorded above.

A same-VM control using the unchanged signed public v0.7.3 ZIP passed fresh smoke but also failed at `metadata-plain` under the original 25-second deadline. It is retained under `baseline-control/` and establishes that this currently reproducible reader failure does not require the layout change. A separate fictional-mail UI session for `9efb48` visibly showed the default Inbox, pagination, View/Newest/Delete controls and complete empty-reader text. CUA click/Tab input supplied no confirmable guest-state change, so this is a default-layout observation, not manual resize or keyboard acceptance. The exact fixture process closed normally with identity checks and no forced termination.

[Run 38227299577](https://github.com/Coke1120/Morrow-Mail/actions/runs/38227299577), head `fb5fa645b3b3c5078694db4953c19a4bc6412abb`, passed macOS and Windows Rust/package checks but failed the measured resize assertion: requested/actual outer width 944, client 928, body 765, list 437, reader 320. Fresh and owned resource observation were complete. This proves the mail body's minimum layout could retain an overflowing width even though the window resized correctly; the revised fit therefore includes the visible client boundary and root size events.

[Run 38229444676](https://github.com/Coke1120/Morrow-Mail/actions/runs/38229444676), head `8e13eded887761cb886a51d34a67e7c71550bbc6`, passed macOS, Windows Rust/package checks, all three fresh/owned/restart UI results (`ok:true`), the actual window-resize regression, and persistence verification. Windows remains failed because case 3 resource observation reported `nativeAcquire`, native error 87, with no exit code; cases 1/2 were complete and relocated acceptance was skipped. The fictional-mail benchmark passed. This is a UI regression pass with an unresolved strict-observation failure, not a successful paired run or a waiver. The final sidebar follow-up candidate and its exact Parallels results are recorded above.

Local evidence is retained under ignored `test-results/windows-ui-20261012/`. Parallels guest input/clipboard automation was unreliable, and Windows policy blocked `.ps1` files; direct native command-line checks were used without changing that policy. These runs do not execute the strict resource collector or full relocated-package assertions, establish a clean VM, complete physical keyboard/Narrator or live-account acceptance, or resolve the known observer/signing/updater limits. The Jev review tool was unavailable because its API key was not configured.

## 0.7.4 synchronization candidate — 12 October 2026

Functional head `8fce7fd3d64b912d344cc5762a119f89c06b4c2b` passed all 314 local locked Rust tests, formatting/strict Clippy, the existing macOS candidate builder, deep/strict ad-hoc signature/plist checks and full production-service native acceptance using fictional workspaces. The native reader completed its original checked workload in 13.131 seconds with zero unsolicited loopback connections. Final provider benchmarks are retained in [the performance report](docs/SYNC_PERFORMANCE.md).

Draft [PR31](https://github.com/Coke1120/Morrow-Mail/pull/31) triggered [38229862471](https://github.com/Coke1120/Morrow-Mail/actions/runs/38229862471), attempt 1. Its Windows Rust check failed `executable_closed_and_running_app_share_owned_data_and_reviewed_send`: the CLI child overflowed its main stack, exit `-1073741571` / `0xC00000FD`, where exit 3 was expected. This is retained as a failure, not a normal exit or observer error 87, and was not retried. A subsequent source correction heap-allocates the provider sync state machine. On the same construct-only Mac probe, `mail::sync` shrank 11,176→344 bytes, CLI main 16,344→8,640, CLI execute 15,136→7,432, and mail handler 12,656→4,952. A 4 KiB sync-frame regression was added; no stack limit, timeout or exit gate increased. Fresh source CI is required before merge/release.

Isolated branch `perf/incremental-mailbox-sync` starts from freshly verified main `5438edf9cd1b04578744edd1b5110c178372bb1f`, after the published 0.7.3 tag at `1f9306e0a177cd9892e23641e9b86b41b682df0f`. The owner approved the profiling/database/provider work, then explicitly authorized merge and the next paired release once ready. The original source checkout remained unmodified by this synchronization task; the real approximately 2 GB mailbox, messages and accounts/tokens were never opened. This task made no Parallels changes.

The candidate implements semantic no-op imports, metadata-only search updates, one lazily prepared write statement per changed import batch, persisted Gmail history/expiry/restart/invalid-cursor gates, connection/folder/UIDVALIDITY-bound IMAP new UIDs and capability/enable-gated bounded CONDSTORE/QRESYNC, and conservative Graph overlap/folder fairness. [Measurements and remaining protocol/acceptance limits](docs/SYNC_PERFORMANCE.md) retain complete baseline, initial-candidate and final-storage samples, plus final provider timings. At 50,000 cached rows, unchanged 50-row import is 337.47→4.86 ms and flags-only is 341.58→19.43 ms, with zero FTS rows in both final cases. New/text changes still index; no all-path or native UI speed claim follows. This is not a complete mailbox mirror, a new push/IDLE service, a UI-latency diagnosis or live-account acceptance.

Local Rust 1.99.0 formatting, strict all-target Clippy and the complete locked suite passed (314 tests, three explicit synthetic benchmark cases ignored). A subsequent availability-replay correction is covered by the focused Gmail/storage regression before publishing the review head. The first sandbox unit attempt could not write the Apple compiler cache; the next cold-cache updater fixture exceeded its unchanged 60-second compile deadline. A compile-only AppKit/SwiftUI/WebKit prewarm returned success, and the original updater fixture then passed within its existing gate. Initial fixture revisions also exposed a metadata-FETCH response-shape mistake and an unclassified rejected MODSEQ FETCH; both were corrected and the complete suite passed. No deadline, TLS validation, native unknown-exit gate or release policy was weakened.

Functional head `34a95459e627ff01e2db22ca8dd507e6819831da` triggered fresh [PR CI 38233076840](https://github.com/Coke1120/Morrow-Mail/actions/runs/38233076840), attempt 1. Both platform Rust checks passed, including the previously failing Windows CLI fixture; native package/acceptance and final job results remain pending at this record. The first PR run's macOS job passed. Package metadata and release notes prepare 0.7.4. PR30 at `4437f4eab324758a3531d9363c4e9062863a37b9` separately failed strict Windows resource observation for case 2 in run 38231339110; UI/fixture success does not replace that gate. Combined merge, tagged publisher and public asset/signature verification remain pending; this entry does not declare merge or publication. macOS ad-hoc signing/no notarization, Windows unsigned distribution, pre-existing observer/reader gaps and outstanding manual/live-account/Parallels acceptance remain.

## v0.7.3 published and public downloads verified — 11 October 2026

[v0.7.3](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.7.3) was published at **2026-10-11T18:40:11Z** from `1f9306e0a177cd9892e23641e9b86b41b682df0f`, whose parent is merged main `277c9ccf17b285587ec07be8fc77729d418d904e`. Local ancestry and the remote annotated tag confirm inclusion of PR28 and PR29. Release author, committer and tagger email is `howailok1120@hotmail.com`.

[Tagged CI 38162326664](https://github.com/Coke1120/Morrow-Mail/actions/runs/38162326664), **attempt 1**, completed success without rerun or waiver. macOS job **114537655251** passed 304 Rust tests, Node-free formatting/strict Clippy, SwiftUI packaging, native search/read/reply and full acceptance, wrapping/visibility diagnostics, and **40/40 complete network-zero adversarial-reader samples**. Windows job **114537655039** passed 300 Rust tests, WinUI packaging, fresh/owned/restart UI and strict observation (4/44/32 point samples), relocated PowerShell 5.1 acceptance and the 1,000/10,000/50,000-message fictional-mail benchmark. Rust results have zero failed or ignored tests. Release job **114544231420** verified same-run/same-attempt platform identities and artifact provenance, then used the existing publisher and pinned signing key. All required steps and all three jobs completed success.

Public verification on the Mac mini used unauthenticated HTTPS requests: the release page returned **HTTP 200**, all **six assets** downloaded, both ZIPs passed CRC/path-integrity checks, all bundled product metadata and the macOS plist report **0.7.3**, and exact SHA-256 files match the downloaded bytes and signed manifest sizes/hashes. The **Ed25519 signature verified against the unchanged `rust/resources/update-public-key.pem`**. Public release notes match the tagged notes, including the known limitations. Previously published binaries and tags were not replaced.

| Platform | ZIP bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 14,410,828 | `aab03cf28010aa808c90b3437d6b525931ec3870580c6d7513ed5912f9239d03` |
| windows-x64 | 39,087,311 | `e59d1376a2ee23816f1b29e0e26e7d671f2e98fe9f92ec20eb32036c251fad10` |

This successful attempt does not establish that historical Windows first-acquire native error 87/unknown exits or intermittent reader timeouts are repaired. Mac mini Parallels acceptance, native picker cancellation, full manual accessibility/live-account and clean-machine/updater acceptance remain incomplete as disclosed. macOS is ad-hoc signed without notarization and Windows is unsigned. The original checkout and real mailbox/account workspaces remained untouched; testing used isolated fictional fixtures.

## v0.7.3 release preparation — 11 October 2026

The isolated release checkout on the owner's Mac mini starts from fetched main `277c9ccf17b285587ec07be8fc77729d418d904e`. It contains merged [PR28](https://github.com/Coke1120/Morrow-Mail/pull/28), including the reviewed sidebar correction and [bounded original-pin proof](docs/WINDOWS_PINNED_EXIT_SETTLING.md), and merged [PR29](https://github.com/Coke1120/Morrow-Mail/pull/29) at `b833ba0b9d2c958552dd272404708654a612ea55`. Git ancestry checks passed for both merge commits. GitHub had no v0.7.3 tag or release at preparation time; the latest public release was v0.7.2 at `b93dbfc842ce00f3a459ebe9affe770dd23df90b`.

[Final PR28 paired run 38136009365](https://github.com/Coke1120/Morrow-Mail/actions/runs/38136009365) passed the reviewed source, but [merged-main run 38137948551](https://github.com/Coke1120/Morrow-Mail/actions/runs/38137948551), attempt 1, failed without retry. macOS job 114465599155 passed all checks. Windows job 114465599318 passed Rust checks, packaging and the benchmark; its Native fixture walkthrough failed strict observation: case 2/sample 12, PID 4364/parent 7872, and case 3/sample 4, PID 6060/parent 7864, each reported nativeAcquire/error 87/unknown null exit. Relocation was skipped. Those failures remain failures and do not prove normal exits or a repaired first-acquire gap.

The owner explicitly requested a new release with the known Windows warning and incomplete Parallels acceptance disclosed. Package metadata, changelog, coverage and [v0.7.3 release notes](docs/releases/v0.7.3.md) are prepared. No required check or protection is waived. Tagged Rust 1.98.0 formatting/strict Clippy/locked tests, both native platform builds and acceptance, Windows relocation and benchmark, and the existing same-run/same-attempt pinned-key publisher must pass before public downloads and the signed update manifest are exposed. The original 180-second UI/collector, approximately 1 Hz point sampling, 30-second reader, and unknown/nonzero-exit failure rules are unchanged. Tagged results and publication verification are pending at this preparation commit.

The original checkout and real mail/account workspaces are untouched. Local inspection found Rust 1.99.0, Swift command-line tools and 21 GiB available disk; full Xcode is not selected. The existing hosted paired workflow supplies the release builds and signing. Local preparation does not claim completed Parallels, live-provider/model, native picker cancellation, full accessibility, clean-machine or installed-updater restart/rollback acceptance. macOS remains ad-hoc signed without notarization and Windows remains unsigned.

The development entries below retain their recorded branch-stage evidence. This release record supersedes their earlier statements about the current merged/tagged state.

## Current-page synchronization — merged, unreleased

Branch `codex/priority-mail-sync-20261011` starts from merged PR27 main `982384388097aabb710ca5f146d7ed07290bb597`. The [bounded synchronization change](docs/SYNC_PRIORITY_AND_INCREMENTAL.md) adds expiring owner/connection-bound current-page hints, retains background quotas/checkpoints, and conservatively reuses immutable IMAP/Graph bodies. Linux Cloud Rust 1.98.0 locked verification passed formatting, strict all-target Clippy and all 304 tests across 38 test targets, including synthetic request-count, 51-row/second-batch failure, complete-header, draft-to-Sent, downloaded-attachment/send-replay, identity, quota, cancellation and reconnect cases. Independent exact-head review accepted `43d443fc25f74ceae099156e20f64908f0706f84`. Final [focused run 38121254196](https://github.com/Coke1120/Morrow-Mail/actions/runs/38121254196) and [full paired run 38121493085](https://github.com/Coke1120/Morrow-Mail/actions/runs/38121493085), both attempt 1, passed that source tree on both platforms. The full Mac run passed the original reader in 23.044 seconds and 40/40 complete network-zero samples. Windows passed all three UI cases, 26 lifecycle controls, strict observation, relocation and benchmark. The CI merge tree `2d4d8b1b71f274e174b0c4ff0838ee5226cd93d7` equals the reviewed head tree. The owner explicitly authorized merging PR29 first when ready; [PR29](https://github.com/Coke1120/Morrow-Mail/pull/29) merged at `b833ba0b9d2c958552dd272404708654a612ea55`. [Main postmerge run 38128187209](https://github.com/Coke1120/Morrow-Mail/actions/runs/38128187209), attempt 1, completed failure without retry. Mac job 114436822466 passed: original reader 24.952 seconds, 40/40 complete untruncated network-zero samples (20 cold/20 warm), native exit zero, parent elapsed 16.369–20.887 seconds. Windows job 114436822291 passed Rust/build, all three UI operations, 26 lifecycle controls and benchmark; strict observation failed one case-3 sample-4 record, PID 1644/parent 3148, nativeWait/no error code/unknown exit. Observation counts were 4/44/33; all collectors reaped without force with exit zero. Relocation and release job 114442679674 were skipped. The unknown remains unknown; this does not prove a synchronization regression, a normal exit, or a fixed first-acquire gap. Individual checks do not replace final combined PR28/observer-source acceptance.

The baseline [postmerge main run 38114776594](https://github.com/Coke1120/Morrow-Mail/actions/runs/38114776594) completed failure without retry: Mac passed (21.644-second original reader; 40/40 complete network-zero samples), and Windows build/UI/26 lifecycle controls/benchmark passed. Windows strict observation case 2 had two nativeAcquire/error 87/unknown-exit records and a separate nativeWait/no-error-code/unknown-exit record. Relocation/release were skipped. This is a pre-existing baseline for this branch, not evidence that the new synchronization caused it or that the observation issue is solved.

PR27's [postmerge sidebar review](https://github.com/Coke1120/Morrow-Mail/pull/27#discussion_r4240386164) concerns the real NavigationView invocation route. The separate sidebar branch reproduced pinned main and passed candidate restoration in [focused run 38119005419](https://github.com/Coke1120/Morrow-Mail/actions/runs/38119005419) at `d81d7861f4f85293ffc1f2518682b1568ca7e89e`. The merged PR29 source does not include that sidebar fix or resolve/close that discussion. Physical screen readers, real accounts, clean-machine interaction and extreme-reader timeout/lifecycle profiling remain unverified or unresolved as previously recorded.

## Actual Windows sidebar invocation — independent unreleased candidate

Branch `codex/sidebar-selection-20261011` starts from merged PR27 main `982384388097aabb710ca5f146d7ed07290bb597`. The [postmerge review](https://github.com/Coke1120/Morrow-Mail/pull/27#discussion_r4240386164) identified a route absent from the original direct-navigation fixture: WinUI can change its selected item before the attachment guard rejects navigation. The follow-up restores the canonical selection after the real invocation completes, without changing the retained mailbox/page/draft or captured attachment owner. It also assigns `NavigationView.SelectedItem` after child items are inserted; their pre-insertion `IsSelected` flags do not reliably restore the native selection model.

[Focused native run 38119005419](https://github.com/Coke1120/Morrow-Mail/actions/runs/38119005419), attempt 1, passed both the pinned-main negative control and candidate checks at source `d81d7861f4f85293ffc1f2518682b1568ca7e89e`. The mounted, loaded NavigationView receives the native selection automation action; an independent event counter requires actual `ItemInvoked` before assertions. Main reproduces the sidebar/account mismatch, and the candidate restores account/folder selection and a footer invocation while retaining owner/page/cursors/selection/generation. The private fixture uses fictional accounts, scripted accepted file selection and an in-memory attachment transport. Earlier focused attempts failed fixture setup/history availability or asynchronous event assumptions and are not product reproductions; the [attachment review](docs/ATTACHMENT_FLOW_REVIEW.md#real-sidebar-invocation-after-pr27) retains their exact runs. Final reviewed sidebar head `ddac0031776281e46f7b5631b7c5c40b457a3735` had the same production/fixture source. Its full [run 38119590098](https://github.com/Coke1120/Morrow-Mail/actions/runs/38119590098), attempt 1, passed Mac (19.209-second original reader; 40/40 complete network-zero samples) and Windows build/three UI operations/26 controls/benchmark, but failed strict observation at case 2 sample 11, PID 6444/parent 1668, nativeAcquire/error 87/unknown exit. Relocation/release were skipped without retry. That result does not validate this newly combined source tree.

The unchanged baseline [main CI 38114776594](https://github.com/Coke1120/Morrow-Mail/actions/runs/38114776594) failed its Windows strict observation gate: two `nativeAcquire`/error 87/unknown-exit samples and one separate `nativeWait`/no-error-code/unknown-exit sample in case 2. Mac, Windows build/UI/lifecycle controls and benchmark passed; relocation/release were skipped. This sidebar correction does not fix that observer evidence gap. Release remains gated on fresh paired native acceptance and the existing signed publisher; no tag or release is created by this draft branch. Physical keyboard/VoiceOver/Narrator, interactive picker cancellation, manual cross-platform UX and real accounts remain unverified. Original extreme HTML timing, HTML semantics, network isolation/cancellation/Back and the 30-second gate remain unchanged.

## Attachment state follow-up — unreleased

Branch `codex/attachment-state-safety-20261011` starts from PR26's merged main `654be0d7c65f4e76f8642f1cddf0ee7a4725c0a3`. [Main CI 38108994176](https://github.com/Coke1120/Morrow-Mail/actions/runs/38108994176) passed Mac acceptance, including the 24.723-second original reader phase and 40/40 complete network-zero extreme-reader samples. Windows build/UI operations/26 lifecycle controls/benchmark passed, but strict observation failed in cases 2 and 3 at first `nativeAcquire`, error 87, unknown/null exit. Relocation and release were skipped. The matching baseline evidence gap is unresolved; this result is not a demonstrated attachment regression or normal-exit proof, and was not retried.

[The bounded attachment review](docs/ATTACHMENT_FLOW_REVIEW.md) records three failed fixture-only modal-cancellation attempts and their stop condition: a visible owned dialog's `Close` returned success but `Show` did not return within 30 seconds. No production cancellation fix or acceptance is claimed. That experiment is removed from the independent download-state fixture; it uses a scripted accepted destination and synthetic transport, never a real mailbox/service.

[Pinned-main native reproduction 38112026674](https://github.com/Coke1120/Morrow-Mail/actions/runs/38112026674), fixture head `1dfa0b314aaf000e74b6df913637f2fc939574dd`, proved account/page/cursor/selection replacement during a held attachment save before production changes. The candidate adds the missing existing foreground guard to `Shell::navigate`, plus a real-popup navigation assertion in the regular native smoke. Focused candidate and full native CI outcomes are reported on the draft PR after their respective runs; this checked-in record does not predeclare their outcome.

Native picker cancellation, Mac attachment panels, physical keyboard/VoiceOver/Narrator, cross-platform manual UX and real accounts remain unverified. The original Mac HTML timeout and Windows first-acquire observation gap remain open. Original HTML semantics, isolation, cancellation/Back, the 30-second reader deadline and strict Windows gates are unchanged; there is no new renderer or lifecycle tracing experiment.

## Native mail flow follow-up — unreleased

Separate branch `codex/mail-flow-review-20261010` starts from main `8159b9dda81a938cd2b51258351a69f064f68a7c`, after PR24/25 merged. The [review](docs/MAIL_FLOW_REVIEW.md) describes search-page/row retention and attachment/footer accessibility names, plus concrete prerequisites for future exact-target Mac profiling and pre-launch Windows lifecycle observation. Original HTML semantics, the 30-second reader gate, cancellation/Back and strict Windows observation stay in place. No new renderer or Windows lifecycle experiment is part of this review.

[Initial focused run 38083551361](https://github.com/Coke1120/Morrow-Mail/actions/runs/38083551361), source `3b2403fa3cd533bd461dfc5f35fa21e49afb64d6`, failed compiling the new fixture's incorrectly named accessibility protocol; its pinned-main reproduction did not execute and the candidate stage was skipped. The fixture was corrected to AppKit's `NSAccessibilityProtocol`; the failed run remains evidence, not a reproduction or successful validation. Final focused and full native results are recorded separately after completion.

[Focused run 38083741623](https://github.com/Coke1120/Morrow-Mail/actions/runs/38083741623), source `c3a02a5eb1b32d3368bb640f3c5664106392990c`, compiled the Mac fixture but did not find its Next action immediately after the model published results. The negative control stopped before read/reload and supplies no reproduction. The fixture now waits within a fixed five-second bound for the corresponding mounted native action, retaining bounded fictional-control diagnostics if absent. Product code is unchanged by this fixture correction.

[Focused run 38083890663](https://github.com/Coke1120/Morrow-Mail/actions/runs/38083890663), source `a722e2860464b988de8e0b359feb6b5dfa474475`, passed Windows compilation but still could not find Next after the bounded wait. The Mac fixture's traversal required full protocol conformance, excluding peers that implement AppKit's accessibility selectors informally. It now queries those optional in-process selectors; failure diagnostics go directly to stderr instead of being lost in a top-level Swift trap. All prior failures remain recorded. The isolated driver's timeout cleanup also terminates its own process group before reaping, covering compiler children without process enumeration.

[Focused run 38084192568](https://github.com/Coke1120/Morrow-Mail/actions/runs/38084192568), source `748cc7bf3fe01753b7583925367723801ecb19d2`, compiled the Mac fixture; bounded diagnostics showed a root AXGroup without reported AX children while seven native buttons existed in its physical view tree. The pinned reproduction again stopped at Next. Traversal now includes physical child views as well as reported accessibility children. This is fixture reachability evidence, not a product navigation or screen-reader failure.

[Focused run 38084387667](https://github.com/Coke1120/Morrow-Mail/actions/runs/38084387667), source `4446726db485702e4b08012630603645e163bbf2`, still could not resolve Next: physical peers exposed empty ordinary-button names/unknown AX roles, while native menus had names. This establishes a limit of this in-process hosted AX inspection, not a VoiceOver result. The fixture now invokes mounted NSButton action rows and verifies their actual resulting page/write instead of relying on that unresolved traversal. Mac label changes are compiled but their runtime AX names remain unverified; Windows retains native rendered-name assertions. No accessibility/security setting or permission was changed.

[Focused run 38084662146](https://github.com/Coke1120/Morrow-Mail/actions/runs/38084662146), source `b36361d1523d9c46321b56ea139fa3372c5f24a8`, passed the exact pinned-main reproduction and Windows compilation, but the candidate view process exceeded its own 30-second bound. With no intermediate phase markers this does not locate a product failure. The revised fixture records fixed phase markers, answers its nested discard modal through an AppKit modal-mode timer instead of a main-queue callback, and edits the native message editor before Keep Editing/save so it checks newly entered text. The 30-second fixture bound and original HTML gate remain unchanged.

The isolated Mac driver changes only AppModel's initial URL in private compiler input; all view logic stays as shipped source, while URLProtocol supplies fictional responses and rejects unexpected requests. It starts no service and establishes no provider or persistence acceptance. Existing full native checks supply their own unmodified-client/service evidence. VoiceOver/Narrator on real hardware, cross-platform manual UX, actual attachment-picker/download cancellation and live accounts remain unverified. The original Mac timeout and the baseline Windows case-3 first-acquire error 87/unknown-exit gap remain unresolved; a green fixture cannot overturn either.

## Reader timing and Windows observation — follow-up in progress

This separate [draft PR #24](https://github.com/Coke1120/Morrow-Mail/pull/24) starts from main `052643dcf9046419b93248b73dbc69dfdae72cb4`, after v0.7.2 publication. The initial stages added fixture-only telemetry while retaining existing behavior: macOS records navigation, native-find/snapshot durations and bounded main-thread heartbeat observations; Windows records validated collector skip reasons, exit/identity evidence, milestones and selected raw sample neighborhoods in CI logs. The baseline commits retained the original skipped-sample/incomplete classification. The 180,000-character/1-pixel reader input, its 30-second process gate, existing recovery/isolation assertions and release gates remain unchanged.

The first measurement run, [38055044506](https://github.com/Coke1120/Morrow-Mail/actions/runs/38055044506), passed both native jobs on instrumentation head `b5fb256c1904675b7dcbe58dff32d5402a5f091e` (PR merge checkout `fdb32bfb13aa2e8fc62dc1ded2283b0f1dacfa61`, identical tree). The reader phase timer finished in 23.369 seconds. In the adversarial case, navigation reported loading for 16.899 seconds; the subsequent successful native find took 106 ms. Heartbeats continued, with maximum observed main-queue acknowledgement delay of 133 ms. This locates this sample's dominant wait in loading, without establishing which WebKit work caused it. The 30-second process gate and zero unsolicited loopback checks passed.

Windows raw summaries and selected sample neighborhoods reproduced incomplete owned/restart observations: respectively two and one `processUnavailable` skips, with no root skip, forced termination, truncated/invalid records or missing required milestone. The footer and collector exits were normal; fresh observation was complete. `processUnavailable` covers `GetProcessById` or initial handle acquisition, so these records establish acquisition gaps, not confirmed normal exits. Skipped PIDs were not recorded in this baseline; neighboring process disappearance is insufficient to identify the failed PID.

The collector correction retains at most 64 verified process handles across samples and admits all identities before reading counters. It records exit-zero lifecycle events from those retained identities or a narrowly verified first-seen native proof, with strict schema validation; an unknown/changed identity, access error (including denial followed by exit), nonzero exit, forced collector, missing marker or missing UI counter still makes observation incomplete. Current identity-verified, live cached descendants also seed bounded discovery after an intermediate parent exits, so their new children are not silently omitted. New bounded metadata separates PID lookup from handle acquisition and records allowlisted numeric failure information. Twenty-six native lifecycle cases exercise these distinctions. Two first-seen positive controls use actual filtered CIM creation/parent records and real owned child exit barriers; ancestry or creation projections in other controls remain explicitly labeled, without claiming real OS orphan creation or PID reuse. CI now requires complete fresh/owned/restart observations after saving their evidence and checking UI/persistence results. The collector remains point sampling, not proof of lifetime resource peaks or complete process-lifetime coverage; native validation of this correction is recorded separately in the PR.

[Run 38061994772](https://github.com/Coke1120/Morrow-Mail/actions/runs/38061994772), on the earlier PR25 source stacked over this observer correction, passed all 17 lifecycle cases and the UI walkthrough but failed strict owned observation: a newly seen child vanished at `GetProcessById`, with no exit code available. Retained handles cannot by themselves cover this first-seen gap. [Run 38062511346](https://github.com/Coke1120/Morrow-Mail/actions/runs/38062511346), on `ff5b0a95d43ddcdcaffe3090b285af5ff2e7b6c5`, independently reproduced the same lookup-stage gap after all UI cases and 17 lifecycle controls passed. Its Mac job passed; the paired result remains failed. A separate short Windows diagnostic now compares the managed lookup with read-only native identity/exit proof on fixture-owned processes. It checks PID, integer creation time, a signaled handle and exit zero, with explicit nonzero, unavailable, mismatched-identity and restricted-rights controls. Expected creation comes from the owned process; one control projects CIM timestamp precision. That initial helper-only stage did not validate collector parent admission or integrate a fallback. Previous unknown exits remain incomplete; the diagnostic must establish its native API behavior before a collector change is justified.

The first short Windows proof [38064564565](https://github.com/Coke1120/Morrow-Mail/actions/runs/38064564565), head `ea71df876539a45445a509e6637e7402ab793084`, passed live, held-zero, projected CIM-precision and nonzero controls. The released-handles case then failed because a same-identity kernel object still supplied valid exit-zero evidence after the fixture closed its own handles. This disproves the fixture assumption that its own disposal guarantees global object removal; the failed run remains retained. The revised 11-case diagnostic records that one post-release observation without retrying, and adds an explicitly closed-owned-handle negative control that must carry no exit proof. This negative control does not claim actual missing-PID/OpenProcess-unavailable coverage. [The revised short run 38065057949](https://github.com/Coke1120/Morrow-Mail/actions/runs/38065057949), source `bd33e0f72a673a5d9c445a910f88de60bb5e6394`, passed all 11 cases with normal cleanup. The released-fixture-handles observation again verified zero; closed-handle, mismatched identity and actual query/wait permission-denial cases rejected exit proof. These results establish the isolated helper, while collector integration and strict walkthrough completeness require separate validation.

The collector now acquires one limited native handle for each new current-CIM candidate before managed lookup, validates its PID and integer creation identity, and retains that same handle through managed admission or exit proof. The same admitted parent must match current CIM identity and exact creation time and remain live around the child proof. Only managed lookup ArgumentException can enter the zero-exit fallback, which reads the retained handle without reopening it. A proven child records only a `nativeLookupFallback` event; it gets no counters, live cache entry or descendant admission authority. The temporary handle is disposed on every path. First acquisition errors, denied reads, nonzero exits, mismatched identities, changed/exited parents and later handle/counter failures remain gaps. Normal managed admission also requires its exact creation time to equal the pinned identity. Report validation still requires measured UI data and reads earlier nativeOpen failures as well as the new nativeAcquire stage. The original 64-identity, 180-sample, approximately 1 Hz limits and collector deadlines remain unchanged.

The fixed head `901424d5265c471224230df9aabd9157bfbec40f` passed [paired run 38065690692](https://github.com/Coke1120/Morrow-Mail/actions/runs/38065690692), but [the second fixed-source run 38065862519](https://github.com/Coke1120/Morrow-Mail/actions/runs/38065862519) failed strict owned observation after every UI case and all 22 lifecycle controls passed. Owned sample12 could not open PID3704 / parent8012 (nativeOpen error 87, exit code unknown); it remains incomplete. All six actual short/paired checkout logs report c04ce3dff144bc53bcf4c90696bceb14b79ba610 with the same base/head/tree. Both Mac full gates and original40 batches passed, which does not repair the historical Mac timeout. This source did not meet the two-run acceptance goal.

The current native-first retention removes an avoidable acquire/dispose/reopen window: the [.NET release source](https://github.com/dotnet/runtime/blob/60629d14374c56f1cb51819049ad1fa529307f8d/src/libraries/System.Diagnostics.Process/src/System/Diagnostics/ProcessManager.Windows.cs#L29-L56) uses a temporary limited handle when checking whether a process is running, then disposes it before GetProcessById returns or throws. That source inspection is not a fingerprint of the runner assembly and does not establish why PID3704 became unavailable. Two new real-owned barriers obtain the collector pin, exit the child with zero/nonzero status, close the creator handles, and require proof through the same pin after managed lookup rejection. Two explicitly projected first-acquisition errors (87/5) verify no lookup, proof, counter or cache admission follows the failure; they do not claim actual OS missing-PID or ACL-denial reproduction. Every observed temporary pin must be closed. A process already unavailable at the first native acquisition still cannot be recovered; no retry, faster polling or relaxed completeness definition is used. Native verification of this narrow follow-up is pending.


The fixed 40-sample native reader batch uses 20 fresh views and 20 views first warmed with a small document, each in a fresh fixture process. Both modes use the exact 180,000-character/1-pixel input and the same 30-second parent-process deadline. "Cold-view" does not mean an OS or WebKit cache reset. Per-sample bounded stdout/stderr and JSON are retained even on failure; missing, malformed, truncated or network-positive evidence fails the batch. This adds measurement coverage without changing the production reader or existing full acceptance assertions.

Two predetermined paired runs exercised observer head `d016cb59675193c30071de4f7348b93c6b0f9cf6`. [38059139337](https://github.com/Coke1120/Morrow-Mail/actions/runs/38059139337) passed both complete jobs, all 17 Windows lifecycle cases and strict fresh/owned/restart observations. [38060527489](https://github.com/Coke1120/Morrow-Mail/actions/runs/38060527489) failed the Windows multi-selection menu assertion; its 17 lifecycle cases and fresh/owned observations passed, while restart was never reached. This is a retained UI-fixture failure, not a successful second acceptance run. The original fixture called `ShowAt` on a newly rebuilt row without confirming realization, then assumed 50 ms was sufficient. WinUI can ignore a target outside the live tree; the old log cannot distinguish that branch from another delayed opening. The follow-up fixture requires its exact owned row to be realized before one `ShowAt`, then observes native Opening/Opened/Closed events and the unchanged batch actions within one bounded wait. It retains the outer UI deadline, rejects an unattached negative-control target, and records safe event/identity booleans on success or failure. Product menu behavior and all batch mutation assertions remain unchanged; native results for this correction are recorded in the PR.

[Baseline run 38056323073](https://github.com/Coke1120/Morrow-Mail/actions/runs/38056323073), head `a7022503cfee6c6124ee3804710faea70fde55b1`, passed all 40 focused samples (zero timeouts; all capture/network evidence complete), while the original full reader failed its 30-second gate. Its adversarial navigation took 22.218 seconds; the tail succeeded at 29.865 seconds, leaving insufficient time for the remaining replacement/resize/fallback checks. Setup also increased from 1.175 to 2.760 seconds. This is a full-suite budget failure; focused passes do not replace it. Windows passed the original non-strict baseline checks. Focused parent-process median / nearest-rank p95 / maximum were 18.179 / 21.101 / 22.008 seconds for cold-view and 18.078 / 21.745 / 21.829 for warm-view; adversarial-only timings were 18.096 / 21.013 / 21.847 and 16.695 / 20.292 / 20.379 seconds respectively.

A separate 12-sample diagnostic batch compares fixture-only `overflow-wrap:break-word` and `overflow-wrap:normal` overrides (three cold/warm pairs each). Its binaries reject full-acceptance mode, announce their compile-time policy, and retain independent evidence explicitly marked `productionAcceptance=false`. The input still contains 180,000 characters and `width:1px`; the `normal` control deliberately removes emergency wrapping and cannot count as a product fix or replace the unchanged full/40-sample gates. Each control retains the 30-second process limit and network-zero check. This comparison tests alternative explanations for loading cost without changing production CSS.

A separate six-sample warm-view diagnostic compares three pairs of baseline window presentation and a prepared foreground window, using public AppKit state. Foreground samples require an attached, nonhidden reader in an active, key, visible and nonoccluded window before publishing the original adversarial content, and reject later loss of those conditions. Baseline presentation records its actual state without assuming it is invisible. Both policies retain the same 30-second parent limit, child result contract and network-zero checks, and remain explicitly diagnostic. Public visibility is evidence about presentation conditions, not a direct measurement of WebContent scheduling priority.

The Mac timeout remains unresolved at this measurement stage. Its repair continues in stacked [draft PR #25](https://github.com/Coke1120/Morrow-Mail/pull/25). A separate metadata-only ownership preflight observes the same warm reader with an isolated environment and a bounded, cancelled/reaped helper; it never attaches and always labels ownership unresolved. Its first native run, [38061994875](https://github.com/Coke1120/Morrow-Mail/actions/runs/38061994875), exposed a trigger error: the initial marker wait still reported `loading=false`, followed 7 ms later by the actual navigation-loading event. The reader passed in 18.602 seconds, but the helper never started. That failure supplies no permissions or WebContent ownership evidence and is retained independently from the reader outcome.

Another separate six-sample diagnostic alternates three warm pairs of the exact original document and two nested, unstyled inline spans around its original text. It retains all 180,000 characters, the 1-pixel column, original wrapping, tail marker and 30-second deadline; compiled-policy/depth/event-order checks distinguish the controls. It tests a WebKit layout-path hypothesis and remains `productionAcceptance=false`. Neither a diagnostic input transform nor a focused pass is a production fix. The short diagnostic workflow preserves independent ownership and structure results, including failures.

[Diagnostic run 38062559198](https://github.com/Coke1120/Morrow-Mail/actions/runs/38062559198) exercised the corrected trigger. Its reader passed in 20.128 seconds and metadata identified one new canonical WebContent with stable identities; both unprivileged `launchctl procinfo` calls returned exit 1 with permission diagnostics. Ownership remains unresolved and no attachment was attempted. The runner reported macOS 15.7.9 / 24G830, WebKit 20621.3.11.11.3 and Xcode 16.4 / 16F6. All six structure controls passed their evidence checks, but baseline-to-nested adversarial times were 18.225→18.704, 21.282→20.364 and 20.418→20.625 seconds, with mixed parent/loading differences. This supplies no consistent improvement and does not justify changing production HTML.

The next six-sample control alternates explicit false/true initialization of the public `WKWebViewConfiguration.suppressesIncrementalRendering` setting, read back at three ordered points on the same warm view. Normal product builds leave this setting unchanged. The policy applies during both warmup and adversarial loading; configuration readback does not establish live suppression state. Apple's [matching-version WebKit source](https://github.com/apple-oss-distributions/WebKit/releases/tag/WebKit-7621.3.11.11.3), commit `e97539821b38379d82a51b6740d90191d5d0b7af`, provides a more precise basis than WebKit main, but is not proof of binary identity or a runtime profile. This public setting can suppress some loading-time visual updates; independent layout work can still occur, and suppression has a fallback timeout. The control keeps the exact document and original gates, and cannot count as a fix unless native evidence supports a production change. The short workflow now targets this control; completed structure evidence and its explicit CLI remain available. A separate fixed `sudo -n -T 1 /usr/bin/true` capability probe checks only that harmless command's policy; it neither queries privileged process metadata nor samples a process or changes policy.

Local Linux checks cover formatting, strict all-target Clippy, native-harness Rust regressions, bounded Python metadata fixtures and PowerShell parser/report/drain fixtures. Windows CIM/process lifecycle cases are explicitly skipped on Linux; neither those results nor source review substitute for native execution. The PRs record exact subsequent commits, complete native results and any repeated final-source validation, retaining failures. The v0.7.2 tag and published assets are unchanged; no merge or new release is part of this follow-up.

## 0.7.2 — published paired native release

[v0.7.2](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.7.2) was published at **2026-10-10 12:58:18 UTC** from `b93dbfc842ce00f3a459ebe9affe770dd23df90b` as a normal public release (`draft=false`, `prerelease=false`); GitHub's Latest endpoint resolves to it. [Tagged CI 38051962275, attempt 1](https://github.com/Coke1120/Morrow-Mail/actions/runs/38051962275/attempts/1) passed both native jobs and the existing publisher. The remote annotated tag resolves to that exact commit. The publisher verified same-run/same-attempt platform jobs and candidate bytes before signing with the existing pinned key and publishing both platforms. No waiver, workflow change or replacement of public assets applied.

macOS [job 114212726310](https://github.com/Coke1120/Morrow-Mail/actions/runs/38051962275/job/114212726310) passed **273 Rust tests**, six Python fixtures, Node-free formatting/strict Clippy, SwiftUI packaging, deep/strict ad-hoc signature verification, plist lint and full native reader/window/held-response/service acceptance. Its reader phase timer finished at **20.803 seconds** under the unchanged 30-second process deadline; this excludes compilation and startup. Windows [job 114212726415](https://github.com/Coke1120/Morrow-Mail/actions/runs/38051962275/job/114212726415) passed **272 Rust tests**, Node-free formatting/strict Clippy, WinUI packaging, fresh/owned/restart UI, General retry, all four composer-return cases, the revision/cursor helper with native 409/400 and ordered-page checks, relocated PowerShell 5.1 and the 1,000/10,000/50,000-message fictional-mail service benchmark. Rust totals have zero failed/ignored tests. These are hosted native-platform results, not Linux substitutes or a manual same-source UX comparison.

All six public assets were downloaded anonymously and matched GitHub's SHA-256/size metadata. Both ZIPs passed integrity, duplicate/path and package-version checks; their exact checksum files and the signed manifest's platform hashes/sizes matched. Release notes are byte-identical to the committed notes, and the original manifest's Ed25519 signature verified against the unchanged pinned public key. The existing Rust publisher's local `--check` separately accepted both downloaded archives/checksums and notes without a private key or GitHub calls; that local mode did not verify the published signature. Public-download checks ran on Linux without extracting or executing native apps, and did not rerun codesign, service startup or installed-updater acceptance. Same-attempt candidate provenance was verified by the successful CI publisher, not by comparing a release ZIP hash with the outer Actions artifact hash.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 14,230,541 | `f8dd087272fa5a5b7940239305f4819b578a0cf6160968e9e9a410c1ce96a3cf` |
| windows-x64 | 38,932,326 | `5a9698b25bcb3440062b5e19b008a0f55d415c8cfa3c6312fcd1a54f9e9204b4` |

The first PR run's intermittent Mac reader timeout is unresolved; later same-source passes, including this tag, do not establish a fix. Two existing NSTableView reentrant-delegate warnings also appeared in tagged macOS checks. The successful PR run emitted two Windows owned/restart incomplete-resource warnings; the tagged Windows log emitted none, but its resource JSON was not independently inspected, so no complete UI resource baseline or resolved observer cause is claimed. Other Windows callers' custom ApiError classification remains outside the paging fix. Same-source manual UX comparison, live providers/models, clean-machine/accessibility, distribution signing/notarization and installed-updater acceptance remain outstanding. macOS is ad-hoc signed without notarization and Windows is unsigned. Fictional fixtures do not establish production readiness.

[PR #23](https://github.com/Coke1120/Morrow-Mail/pull/23) merged as `7f27ec35f2be37646867679b42c0b1f72d800ffd`; its tree equals tested head `13d5822164a95a235fc8051036425726be21c0b1`. [Paired PR CI 38048327870](https://github.com/Coke1120/Morrow-Mail/actions/runs/38048327870) had already passed both platforms, with its Mac reader timer at 24.624 seconds. Version preparation changed only the common package version and release documentation; offline Linux checks passed 16 targeted publisher/builder/updater tests, documentation consistency and 112 local link paths. The dated Cloud and local sections below preserve their pre-PR validation stages; their pending native execution was subsequently completed by the exact PR and tagged runs, while manual/live-account limits remain. Ignored logs, public verification and read-only warning diagnoses are retained under `test-results/release-next/`.

## Cloud fetch recovery follow-up — unreleased

The Cloud validation started at `b14d567de516fa9b438410532f2b3e622cb6b013` on branch `work`; the previous 12-file uncommitted native-recovery changes were snapshotted and retained. This follow-up implements the 13 findings from the fetch review: IMAP INTERNALDATE windows and typed transport retry, unresolved FETCH checkpoint retention, Outlook delta catch-up/metadata-first content/four-request gate/strict dates, Gmail label bounds and incomplete-cache/oversized-content recovery, shared downloaded-body preservation and account-owned incomplete counts, and Windows revision/cursor recovery. See [behavior and remaining limits](docs/FETCH_RECOVERY.md).

The final offline Linux run passed formatting, strict all-target Clippy and **273 locked Rust tests, zero failed/ignored**, including all three P1 reproductions and 31 additional tests over the previous 242-test baseline. The Python cleanup suite passed **6/6** only in disposable fixtures. Static resource verification and offline dependency-notice collection for Linux x86_64, macOS arm64 and Windows x64 passed; the macOS build script passed shell syntax checking. These notice graphs do not cross-compile either UI. All provider tests used fictional data and loopback fixtures; Node/npm were absent from the verification PATH. That validation used no real mailbox, credentials or external provider writes, and made no commit, push, release or deployment. The owner subsequently authorized committing these changes to a separate review branch and opening a draft PR; native CI results remain separate from the Linux results recorded here. A reported Cloud disconnection did not interrupt the retained execution process; subsequent commands and the final test run completed in the existing environment without rebuilding or resetting the checkout.

Initial validation found a Clippy formatting warning and two fixture-contract errors (the default Sent import option and percent-encoded Gmail IDs); those fixtures were corrected without weakening production checks. Two raw-response fixtures were also aligned with the validated provider ID contract. The final full run, rather than the partial attempts, supplies the count above. Separate source review found no additional blocking issue after cross-provider cache, draft/date and Windows stale-response/CID corrections.

At this pre-PR Linux validation stage, the new SwiftUI/WinUI changes and smoke assertions had **not been compiled or executed on their platforms**. The pending work then required the pinned native build plus UiSmoke and same-source Mac comparison for background arrival, mail/search paging, selected reader/Unread retention, focus/scroll and raw-download races. macOS needs native build and packaged-service acceptance for the existing recovery changes and the new incomplete-content controls. The Linux suite's installer rollback test retains its early-return branch; Windows-only ACL/process paths are not exercised. Clean-machine, accessibility, signing, installed updater and live-account acceptance remain separate gates.

The existing IMAP identity key has no server-origin namespace: contradictory nonempty Message-IDs now prevent downloaded-content reuse, but absent/reused IDs after reconnecting the same email to another server can still collide. Persistent invalid dates/unresolved reads remain manual errors, parser/download limits remain bounded, Outlook may reread an oversized newest body, and mailbox scheduling remains serialized. These limits are not claimed as solved. Evidence and both incremental/combined patches are in `test-results/fetch-workflow-fixes-20261010/`; generated evidence is not committed.

## Cloud native recovery follow-up — unreleased

Baseline: `b14d567de516fa9b438410532f2b3e622cb6b013` in the saved Debian 13.6 x86_64 Cloud environment. The owner's commits remained intact; this follow-up was validated as an uncommitted working-tree change before the later review-branch commit. Rust 1.98.0, rustfmt and Clippy were installed with the official `https://sh.rustup.rs` installer and `https://static.rust-lang.org` distribution under `/workspace/.morrow-tools`. Later Cloud shells can enable this toolchain with `. /workspace/.morrow-tools/env.sh`; no shell profile was changed. Existing GCC/pkg-config/OpenSSL were sufficient for the Linux build; no application dependencies or lockfile were changed.

Source review confirmed that Windows always displayed General's Retry button and did not restore mail focus after composer return or a loading/error Back action. Retry now follows failed-save state and is hidden while retrying or after another edit; the existing serialized diff saver still owns persistence. Composer return restores its original loaded control, with a visible list/reader fallback after controls are rebuilt. Native smoke now covers right/focus layouts, interrupted reads, return focus and repeated failed retries.

On macOS, a Focus reader had no Back action while loading or after a detail failure. Those states now expose Back/Escape and return keyboard focus to the native list. Reader errors are separate from workspace notices, and retry clears the prior reader error. Selection/request generations reject obsolete success, failure and mark-read completions, including Back followed by reopening the same owned message. Held-response fixtures cover those orderings and preserve owner/page-two state; a window fixture exercises failed loading, Escape and keyboard reselection. These are source-level findings and added regression assertions, not a native red/green test claim. The existing backup destination 409 repair and attachment persistence were reviewed and left unchanged.

Cloud checks completed with no Node/npm on the Rust runtime-check PATH and offline Cargo dependency resolution after a locked fetch: formatting, strict all-target Clippy and the complete locked Rust suite reported **242 passed, zero failed/ignored**. The Python cleanup suite passed **6/6** using only disposable temporary checkouts. Tests used UUID fixture workspaces and loopback providers; `MORROW_DATA_DIR` pointed to a separate empty fallback directory. Bundled OAuth paths next to the test executables were checked for absence without reading credential content. No real mailbox, account settings, mail/calendar writes, cleanup of existing outputs, publishing or deployment was performed.

Static resource manifest/hash checks passed, and the notices generator completed offline for Linux x86_64, macOS arm64 and Windows x64 dependency graphs. The macOS shell build script passed syntax checking. These checks do not compile or run either native UI.

The Rust count includes `signed_download_install_waits_for_both_processes_and_rolls_back_failed_start`, whose Linux branch returns without exercising installation/rollback. Windows-only process/ACL paths are also excluded. Linux test success does not establish installer or native UI acceptance.

Remaining native checks: build the macOS candidate and run the full `morrow-native-check` with its packaged service, including held-response and window assertions; build Windows with the pinned prerequisites and run `scripts/test-windows-native.ps1 -UiSmoke`. Manually compare the same source version on both platforms for loading/error/success Back, Focus/Expand layout and keyboard focus, composer page/query return, General failed-save retry and edits during saving. New SwiftUI/WinUI code and assertions have not been compiled or executed in this Linux environment. Clean-machine, accessibility, signing/notarization, installed-updater and live-account acceptance remain separate gates. No production-readiness claim is made.

Cloud logs and the final patch are retained under `test-results/cloud-readiness-20261010/`; they are local evidence and are not committed.

## Local native readiness work — unreleased

Baseline: `fc18283` / product `0.7.1`, verified on local branch `codex/native-readiness-20261010` before the owner requested committing and pushing to `main`. The installed Mac app and previous local candidate were `0.6.0-beta.48`; the candidate was rebuilt from `0.7.1`. The installed app and its workspace were not replaced. No cleanup or release was performed.

The local Windows diff adds guarded detail loading/retry/cancellation, composer return to the existing mailbox page/query, and General preference flushing through the existing serialized diff saver. Native smoke assertions cover retained detail on failure, stale failures, Back cancelling late results, combined page-two composer return including an interrupted read, and preference edits during saving/failure/retry/duplicate navigation. The Back fixture reads the owned message's original flag, explicitly prepares it unread, and restores its flag and reading preference even after an assertion failure; it no longer assumes the first row remains unread across the runner's two owned-workspace passes. Existing reader reselection and image-consent checks remain. These new assertions are **not yet compiled or executed on Windows**.

Actual local checks: macOS native build succeeded; the full `morrow-native-check` against that candidate passed, including HTML reader isolation/network-zero, owned/combined selection and pagination, draft/Bcc persistence, account isolation, lifecycle, backup and restart. All data was fictional and isolated. This verifies the `fc18283` macOS/Rust baseline, before the backup error repair below, not the new Windows diff. `git diff --check` passed. Jev Review was attempted and returned `JEV_API_KEY is not set`; no score was available.

A focused follow-up used the built Rust service and a separately seeded fictional workspace to prepare unread and restore both original read states across two service starts (four cases). All passed, including unchanged data for the other account's duplicate message ID. Evidence: `cancel-fixture-result.json` and `check-cancel-fixture.py` in the same local evidence directory. This checks the service-side fixture preparation/restoration; the Windows Back interaction and twice-run native smoke remain unexecuted.

Attachment/recovery follow-up found that an existing backup destination returned a generic storage error. `Store::backup` now maps the atomic directory-creation conflict to HTTP 409 with an instruction to choose a new folder. Regression checks preserve the existing backup database and regular-file sentinel. The CLI regression also covers a Chinese/emoji filename and retained owned attachment bytes after removing draft references, both offline and after service restart. All 14 tests across `storage`, `attachments`, `cli` and `provider_memberships` passed, as did strict all-target Clippy. Thirteen distinct focused existing tests also passed for attachment size/ownership/MIME/CID, upload interruption/URL boundaries and uncertain-send/schedule non-replay; these counts overlap the affected suites.

The rebuilt debug Rust service passed 12 isolated API/CLI lifecycle groups: Unicode names and immutable bytes, account boundaries, malformed/interrupted uploads, reference limits and edits, metadata exclusion, authorized online backup, original and backup-restored restarts, standalone CLI reads and actionable offline backup conflicts. The truncated HTTP-body case returns 413 and exposes no stored attachment; it is not a UI cancellation check. Direct SQLite reads were excluded after the expected exclusive-writer lock blocked them. A separate Swift executable using the unchanged production file-write closure passed five filesystem cases: Unicode save plus quarantine, replacement plus quarantine, symlink replacement without changing its target, directory-destination refusal and missing-parent refusal with temporary-file cleanup. This does not exercise save-panel confirmation/cancel, asynchronous UI cancellation or Windows quarantine. Evidence: `attachment-final-validation.json`, `attachment-lifecycle-result.json`, `attachment-save-result.json` and their named logs in the same local directory. The packaged Mac candidate was not rebuilt for this Rust-only error repair, and Jev remains unavailable.

CUA opened a separately identified `0.7.1` fixture bundle with an absolute temporary `MORROW_DATA_DIR`, showing fresh Add account onboarding. Its screenshot is local evidence only. Further UI interaction failed with `Sky Computer Use native pipe closed before response`, including after resetting/reconnecting the CUA runtime. Parallels 20.4.2 Standard booted the existing Windows 11 VM through UI, but guest input did not take effect and `prlctl start/exec` explicitly requires Pro/Business. A requested read-only guest environment probe has not returned a report. The guest app version/toolchain therefore remains unknown; no old Windows binary is counted as acceptance of this diff.

Evidence is retained locally under `test-results/readiness-20261010-5v7pjzxk/`: `baseline.json`, `macos-build.log`, `native-check.log`, `macos-fixture.json`, `macos-071-fresh.png`, `windows-vm-starting.png`, and `results.md`. Full same-version UI comparison, Windows build/smoke and manual keyboard/error/cancel flows remain blocked/unverified. Attachment UI flow coverage, real providers, clean Windows, accessibility, installed updater/rollback, Developer ID/notarization and Windows signing remain separate outstanding gates. This work does not establish production readiness.

## Local post-release cleanup

`python3 -B scripts/test-clean-local-release.py` passes six tests in isolated temporary Git repositories: preview versus apply, repeat execution, seven-day artifact retention, current-candidate/backup/report preservation, private-workspace exclusion, symlink and tracked-file protection, scan-error handling, and refusal during builds or while an extracted app is running. The same fixture check is included in the macOS CI tooling step. No production app code or paired-release publication rules changed.

The real checkout was previewed only; no existing local outputs were deleted. Full native builds and Windows acceptance were not rerun for this maintenance-only change. The command relies on the operator to verify release publication and stop concurrent builds/tests; process detection is not a shared build lock. APFS reclaimable space may differ from its allocated-byte estimate.

## 0.7.1 — read-state reconciliation repair

The review found that Gmail/IMAP could retain a legacy local Read/Unread value indefinitely when the fetched provider flag matched the previous snapshot. Imports now accept each fetched read value, and confirmed flag-write responses clear obsolete read overrides. Local-only stars, Pending, folders and account ownership remain protected. Unavailable results retain cached flags/snapshots. An IMAP EXAMINE rejection no longer blocks other folders when a complete successful LIST confirms the folder is absent; later rounds can recheck it. Tagged LIST failures are explicitly rejected because the dependency's streaming adapter otherwise discards them.

The approach was compared with [Thunderbird Android](https://github.com/thunderbird/thunderbird-android/tree/e3fb7f3341827eb756327e26198f97b7c3f1821e)'s server-flag reconciliation after queued operations, and [Mailspring Sync](https://github.com/Foundry376/Mailspring-Sync/tree/f7b023980b85499909de595f029deb51db9837cf)'s rescan after failed flag writes. Morrow serializes imports and provider-confirmed flag writes with its mailbox gate; it has no deferred flag-write queue to preserve as a permanent read override. This repair retains the existing bounded polling design.

Regression fixtures exercise both read-state directions with unchanged snapshots, reopen/restart, partial metadata, duplicate IDs across accounts, local markers, confirmed star writes, missing/restored IMAP folders and failed LIST/EXAMINE/FETCH responses. Local formatting, strict all-target Clippy and all **242 locked Rust tests** passed (zero failed/ignored). All 85 local file links in the changed user-facing documentation resolve. Jev scoring was attempted but is unavailable because its API key is not configured. Full native packaging/acceptance ran in CI; the standalone existing reader fixture also passed locally in 13.1 seconds with zero unsolicited loopback connections.

[Tagged run 37969112825, attempt 2](https://github.com/Coke1120/Morrow-Mail/actions/runs/37969112825/attempts/2) passed on commit `e71617958e89d2e04b45f6d3ef0ff8cc8bd84774`. macOS [job 113956736522](https://github.com/Coke1120/Morrow-Mail/actions/runs/37969112825/job/113956736522) passed **242 Rust tests**; Windows [job 113956737007](https://github.com/Coke1120/Morrow-Mail/actions/runs/37969112825/job/113956737007) passed **241** (zero failures/ignored). Both passed Node-free formatting, strict Clippy, packaging and native acceptance. macOS covered reader isolation/network-zero, production-service account boundaries, persistence, lifecycle and backup. Windows passed fresh/owned/restarted UI and reader-isolation checks, plus the separate PowerShell 5.1 relocated Unicode-path package check with developer tools removed from PATH. No waiver was used.

The first attempt's macOS reader fixture exceeded its existing 30-second deadline during the adversarial narrow-column text case. The remaining run was cancelled and the entire paired workflow was rerun on the same commit; no source, timeout or test was changed. The second attempt completed the reader in 23.1 seconds and passed full acceptance. This records a timing failure and successful repeat, not a claim that intermittent reader timeouts are resolved.

The Windows 1,000/10,000/50,000-message fictional service benchmark completed, including interrupted-index recovery and all correctness checks. At 50,000 messages it observed 484.6 ms first service startup, 16.9 ms warm state p95, 117.5 ms warm search p95 and 19.59 MiB service RSS after the 30-second idle sample. These are CI fixture service measurements, not whole-app or real-mailbox guarantees. The fresh and restarted UI resource reports were **incomplete because of sample gaps**; the owned report completed, and all functional milestones passed. Existing C++ compiler warnings remain. A separate clean VM and complete UI performance/accessibility acceptance remain outstanding.

Publisher [job 113966456688](https://github.com/Coke1120/Morrow-Mail/actions/runs/37969112825/job/113966456688) verified the same-run/same-attempt paired artifacts and published [v0.7.1](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.7.1) at **2026-10-09 18:33:29 UTC** as a normal public Release (`draft=false`, `prerelease=false`). GitHub's Latest endpoint resolves to v0.7.1. All six assets were downloaded anonymously through their public URLs and matched GitHub's SHA-256/size metadata. Both ZIPs passed integrity/path/content/version checks and their exact checksum files; release notes matched the committed notes. The update manifest's platform hashes/sizes matched both archives, and its Ed25519 signature verified against the unchanged pinned public key. The existing publisher's local check accepted the paired archives/checksums and notes. The downloaded macOS bundle passed strict/deep codesign verification and plist lint; its service reported `Morrow Mail 0.7.1` with a separate temporary workspace path.

| Public ZIP | Bytes | SHA-256 |
| --- | ---: | --- |
| `Morrow-Mail-0.7.1-macos-arm64.zip` | 14100208 | `eb3feba4db2c51aef4fd991ee4ca66c358332e396240b06ff1b44be610291a65` |
| `Morrow-Mail-0.7.1-windows-x64.zip` | 38628907 | `3bb59bae4a452c8dd0de512d1724696918f46ebc2b53e9bb7acf2dafa44ca164` |

This post-publication evidence update does not change the release tag or binaries. macOS remains ad-hoc signed without notarization and Windows unsigned. Full live-provider/model, independently provisioned clean Windows, accessibility and installed-updater acceptance remain outstanding. Tests use isolated fictional mailboxes; no real mail/calendar writes, paid model calls or installed-app replacement were performed.

## 0.7.0 — numbered release verification

The owner requested normal numbered releases starting at **v0.7.0**, without a prerelease suffix. The publisher now accepts exact `vMAJOR.MINOR.PATCH` tags, creates a normal GitHub Release and still requires both platform jobs, same-attempt artifact provenance, immutable assets and the pinned update signature. The update public key is unchanged. Native update-channel labels use “pre-release versions”; new packages default to normal releases. Historical tags and updater compatibility remain intact.

Local formatting, strict all-target Clippy, all 16 publisher/build/updater tests and 112 local documentation links/anchors passed. The focused tests cover canonical version/tag matching, rejection of malformed/suffixed versions, normal macOS bundle metadata and existing-client discovery of 0.7.0 in both update channels. The tagged paired native gate and public-asset verification passed as recorded below. Jev scoring is unavailable because its API key is not configured.

Tagged [run 37919895606](https://github.com/Coke1120/Morrow-Mail/actions/runs/37919895606), attempt 1, built commit `6f4f164eda4a07947fe5988aeb775cceed8cabf8`. macOS [job 113785028315](https://github.com/Coke1120/Morrow-Mail/actions/runs/37919895606/job/113785028315) passed **240 Rust tests**; Windows [job 113785028666](https://github.com/Coke1120/Morrow-Mail/actions/runs/37919895606/job/113785028666) passed **239** (zero failures/ignored). Both passed Node-free formatting, strict Clippy, packaging and native acceptance. macOS verified the production Rust service, reader isolation, account boundaries, persistence, lifecycle and backup. Windows passed fresh/owned/restarted UI checks, script-disabled HTML/fallback checks and the separate Windows PowerShell 5.1 relocated Unicode-path package check with developer tools removed from PATH. No waiver was used.

The Windows 1,000/10,000/50,000-message fictional service benchmark completed, including interrupted-index recovery. At 50,000 messages it observed 110.3 ms first service startup, 23.4 ms warm state p95, 152.9 ms warm search p95 and 19.83 MiB service RSS after the 30-second idle sample. These are CI fixture service measurements, not whole-app or real-mailbox guarantees. The owned UI resource report was **incomplete because of sample gaps**, although its functional check and milestones passed; fresh/restarted resource reports completed. Existing C++ compiler warnings remain. A separate clean VM, full UI performance/accessibility and physical-pointer acceptance remain outstanding.

Publisher [job 113794478036](https://github.com/Coke1120/Morrow-Mail/actions/runs/37919895606/job/113794478036) passed and published [v0.7.0](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.7.0) at **2026-10-09 11:19:57 UTC** as a normal public Release (`draft=false`, `prerelease=false`). GitHub's Latest endpoint resolves to v0.7.0. All six assets were downloaded anonymously through their public URLs and matched GitHub's SHA-256/size metadata. Both ZIPs passed integrity/content/version checks and their exact checksum files; the update manifest's platform hashes/sizes matched both archives, and its Ed25519 signature verified against the unchanged pinned public key. The downloaded macOS bundle also passed strict/deep codesign verification and plist lint, and its service reported `Morrow Mail 0.7.0`. No installed app was replaced.

| Public ZIP | Bytes | SHA-256 |
| --- | ---: | --- |
| `Morrow-Mail-0.7.0-macos-arm64.zip` | 14073723 | `c9f1c41e08638b4d3ebf31a7b1041035a62beaebd21ea60ce1d56022e882fc86` |
| `Morrow-Mail-0.7.0-windows-x64.zip` | 38630575 | `e110337b45325fa0958352c79483b046c018ac75e26d01540422300b173c97a7` |

This post-publication evidence update does not change the release tag or published binaries.

The release includes the attachment, synchronization, CLI, Today, restart and Windows changes verified below. The numbering change does not certify production readiness: macOS remains ad-hoc signed without notarization and Windows unsigned; full live-provider/model, independently provisioned clean Windows, accessibility and installed-updater acceptance remain outstanding. No installed app or real workspace is used for release testing.


## Source verification before 0.7.0 — readiness work

The changes were reviewed in [PR #22](https://github.com/Coke1120/Morrow-Mail/pull/22) and merged before 0.7.0. The checks in this section did not publish a release or replace an installed app. The source adds immutable account-owned attachments, native add/remove/download/save and CID raster display, Graph large-attachment uploads, frozen delivery/schedule references, seven-day-first history imports, Gmail/IMAP flag write-back and resumable cached metadata reconciliation, and Windows reader lifecycle/startup fallback. The separate Windows PowerShell 5.1 relocated-package script uses a prebuilt QA helper; its marked workspaces stay inside the existing native fixture safety boundary.

The earlier PR #22 candidate passed local formatting, strict all-target Clippy, **233 locked Rust tests with zero failed/ignored**, Swift compilation, native macOS packaging, resource/provenance checks, plist lint, ad-hoc signature checks, and full production-service native acceptance. Native acceptance includes reader isolation/zero unsolicited loopback traffic, fallback, scrolling, lifecycle, account separation, draft recovery, encrypted settings, restart and online backup. Native fixtures now use explicit local message identities, so provider flag writes cannot silently turn offline UI acceptance into external traffic; provider behavior uses isolated TLS fixtures. Attachment tests cover cross-account refusal, immutable references and scheduled fingerprints, MIME/Bcc preservation, backup/restart, unrelated local flag preservation, CID reader-only hydration and repeated-reference bounds, bounded upload URLs, bearer-free Graph upload chunks, and interrupted uploads without replay. IMAP tests reject tagged NO/BAD completion before flags, history rows or missing-message decisions are used.

A separate disposable macOS fixture bundle retained the production executable/service with a fixture bundle ID and isolated workspace. Visual inspection confirmed the attachment list, a Chinese filename, and an explicitly loaded blue PNG CID image while external images remained blocked. The native save panel opened; completion of that interactive save and its on-disk quarantine was not verified. No real mail, calendar event or paid model request was submitted.

The follow-up adds 50 MiB attachment limits, CLI sync/status/dry-run/fetch/attachments, one Today card per mailbox/local date, and activity-tolerant update handoff. Local formatting, strict all-target Clippy and **239 locked Rust tests with zero failed/ignored** passed, followed by native macOS packaging and full production-service acceptance. The actual SwiftUI sheet/delegate update-quit fixture now starts with `busy = true`, rejects new forms/operations during handoff and passes; it uses a fictional prepared-installer response and never installs an update. New checks cover the exact 50 MiB boundary and aggregate refusal, Gmail's encoded-size preflight, CLI ownership and retained draft attachments, partial-sync exit status, stable daily-card identity/latest per-message summaries/failure retention, one-time manual sync continuation with periodic sync disabled, committed indexing continuation with unchanged budget, incomplete paid-request refusal, and idempotent host-only update handoff. Update shutdown freezes new mutations and lets accepted requests drain within the existing 65-second deadline; interrupted sends/calendar writes or unfinished paid chunks are not automatically replayed.

Paired baseline CI [37904881478](https://github.com/Coke1120/Morrow-Mail/actions/runs/37904881478), source `7f0b9cc` / merge checkout `fe7c6f7`, passed macOS 233 tests and Windows 232 platform-applicable tests, formatting/strict Clippy, both native packages and native acceptance, Windows fresh/owned/restart and PowerShell 5.1 relocated-package checks, and the 1k/10k/50k fictional-mail service benchmark. Whole-app resource observation had sampling gaps. The [PR checks](https://github.com/Coke1120/Morrow-Mail/pull/22/checks) carry the current revision's paired results; the baseline is not evidence for later changes. Jev scoring remains unavailable because its API key is not configured.

Production acceptance still outstanding: real Gmail/Outlook/IMAP accounts (including attachment size limits and uncertain deliveries), a separately provisioned clean Windows VM, full keyboard/screen-reader and physical-pointer coverage, signing/notarization/provider verification, and installed-updater restart/rollback. CI with a restricted PATH does not establish clean-machine provenance. The earlier intermittent Windows controller initialization timeout is not declared resolved solely by lifecycle safeguards or a passing run. Gmail/IMAP use bounded polling (50 cached messages per sync), not Gmail History API/IMAP IDLE or a complete mirror; large caches converge over multiple cycles. Attachments are bounded to 100 files / 50 MiB decoded data and 80 MiB raw downloads; inline rendering is raster-only with 1 MiB of image bytes and 1.5 MiB of sanitized HTML. Stored attachment bytes are retained with the workspace; automatic orphan reclamation, antivirus and arbitrary file preview are not implemented.


## 0.6.0-beta.48 — published paired native release

[Beta.48](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.48) was published at 2026-10-09 13:47:06 HKT from `7290dcc82df8d1405953c1dedae577d31eedd39d`. [Tagged CI 37888395865, attempt 1](https://github.com/Coke1120/Morrow-Mail/actions/runs/37888395865/attempts/1) passed all three jobs: Node-free Rust formatting, strict all-target Clippy and locked tests (222 on macOS, 221 on Windows, zero failed/ignored); both native builds and package checks; full macOS production-service acceptance; the Windows fresh/owned/restart UI walkthrough and 1,000/10,000/50,000-message fictional-mail benchmark; and the existing publisher's same-run/same-attempt provenance and pinned-key signing gate. No waiver applied.

All six public assets were downloaded without authentication and matched their GitHub sizes and SHA-256 digests. Both ZIPs and checksum files are byte-identical to this tag run's candidates. Archive integrity, duplicate/path checks, exact checksum files, manifest platform/version metadata and the published release body against committed notes passed. The manifest's Ed25519 signature verified against the pinned public key, unchanged from beta.47. The byte-identical macOS candidate passed deep/strict ad-hoc signature verification, plist lint and bundle/release/backend version checks. Both packaged Windows metadata files report beta.48. The existing publisher's local check accepted both archives, checksums and explicit release notes.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 13,736,820 | `4cb7e1dea1e8daeac69ca16f63e856be2968629100d3bef9e644acac7545f423` |
| windows-x64 | 38,227,753 | `68916d36cda6a6da19c3308ea3ee64e83a5a517e7e753fc65d41370b05af02f8` |

Beta.48 includes the sidebar Sync button and Outlook consistency changes described below. Tagged Windows Light/Dark captures at the 260-point mail-list width were inspected: Sync remains beside Compose and the toolbar actions do not overlap. Fresh/owned/restart reports passed, including reader isolation. Tests use fictional providers and isolated temporary workspaces; no real mail, calendar event or paid-model request was submitted, and installed apps were not replaced. macOS is ad-hoc signed without notarization and Windows is unsigned. Full live Outlook/provider/model, full attachments, local Parallels/Windows ARM manual, real external HTTPS image fetching, physical-pointer/accessibility, clean-machine and complete installed-updater restart/rollback acceptance remain outstanding. Gmail/IMAP incremental and deletion synchronization is not included. The previously recorded intermittent Windows reader initialization timeout remains unresolved; its gate passed this run. See the [release notes](docs/releases/v0.6.0-beta.48.md).

## Sync and Outlook consistency — source verification before release

The native sidebar has Sync beside Compose (also beside Compose with the macOS sidebar hidden); Today Sync All calls provider sync without changing the current mailbox. Outlook adds account/connection-bound delta checkpoints committed atomically with their messages, a rolling cached-message scan, authoritative server read/star flags, move-vs-delete resolution using immutable IDs and explicit flag writeback with Mail.ReadWrite. Permanent deletion retains cached content in local Trash. Local markers, drafts and delivery records remain; initial missing historical content stays with the independently pausable importer. Read/write failures never trigger send/calendar or flag-write replays. Each sync cycle refreshes newest Inbox/Sent, one delta page and up to 25 cached rows; continuing work requires configured polling or manual Sync.

TLS-loopback fixtures cover duplicate IDs, stale local flags even when the provider baseline is unchanged, old cached mail, moves/deletions, restart/pagination, failed writes followed by read reconciliation, missing permission, malformed/cyclic/foreign cursors, expired tokens, provider quota and reconnect races. Native AppModel fixtures verify the actual sync route/header, Today scope, retained paging/selection, coalesced clicks and visible failures. Fictional sidebar captures at 200 and 230 points verify placement. These fixtures do not establish live Outlook acceptance.

Rust 1.99 formatting, strict all-target Clippy and all 222 locked Rust tests passed (zero failed/ignored). After the final quota/local-folder refinements, the 32 affected mail/service/Activity tests and strict Clippy passed again. The macOS candidate built with Swift 6.3.3, passed deep/strict ad-hoc signature verification and Info.plist lint, and passed full production-service native acceptance, including the new manual-sync and read-only Outlook mark-on-open checks, retained page/selection, reader isolation/network-zero, window layout/lifecycle, encrypted persistence and online backup. The existing NSTableView reentrant-delegate warning appeared; no check failed. Windows compilation/UI smoke requires a Windows host and was not run locally. The subsequent paired beta.48 tagged run and public verification are recorded above; both platforms and the publisher gate passed without a waiver. No installed app was replaced. Jev review was attempted but unavailable because its API key is not configured.

## 0.6.0-beta.47 — published paired native release

[Beta.47](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.47) was published at 2026-10-08 17:16:19 HKT from `3fa3ddca9801756c4e0d6f1fbd7a6cd0eac3cb81`. [Tagged CI 37752267440, attempt 1](https://github.com/Coke1120/Morrow-Mail/actions/runs/37752267440/attempts/1) passed all three jobs: Node-free Rust formatting, strict all-target Clippy and locked tests (218 on macOS, 217 on Windows, zero failed/ignored); both native builds and package checks; full macOS production-service acceptance; the Windows fresh/owned/restart UI walkthrough and 1,000/10,000/50,000-message fictional-mail benchmark; and the existing publisher's same-run/same-attempt provenance and pinned-key signing gate. No waiver applied.

All six public assets were downloaded without authentication and matched their GitHub sizes and SHA-256 digests. Both public ZIPs and checksum files are byte-identical to this tag run's candidates. Archive integrity, duplicate/path checks, exact checksum files, manifest platform/version metadata and the published release body against the committed notes passed. The manifest's Ed25519 signature verified against the pinned public key, unchanged from beta.46. The byte-identical macOS candidate passed deep/strict ad-hoc signature verification, plist lint and bundle/release/service version checks; its service-version probe used a separate absolute temporary workspace. Both packaged Windows metadata files report beta.47. The existing publisher's local check also accepted both archives, checksums and explicit release notes.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 13,489,161 | `663b758cb178102cea16d16b04ee3ec15883eb074c1aa3ad0a732767023186b4` |
| windows-x64 | 37,872,243 | `77dd33ae9055c5882f345bce2c14f639dd74ec9f26d137fb9bbefe70ddcec143` |

Beta.47 includes the Inbox layout changes and Windows narrow-toolbar fix, merged into main from `codex/inbox-list-ui-check`. The tagged checks repeat the native width/density/theme assertions described below. Fixtures use fictional providers and isolated temporary workspaces; no real mail, calendar event or paid-model request was submitted, and installed apps were not replaced. macOS is ad-hoc signed without notarization and Windows is unsigned. Local Parallels/Windows ARM manual, full live-account/provider/model, real external HTTPS image fetching, physical-pointer/accessibility, clean-machine and complete installed-updater restart/rollback acceptance remain outstanding. The previously recorded intermittent Windows reader initialization timeout remains unresolved; its existing gate passed this run. See the [release notes](docs/releases/v0.6.0-beta.47.md).

## Inbox list layout — source verification before release

Both native mail lists move the date/time to the right of the sender header and place the owning mailbox beside the sender in All accounts and search results. Sender/subject retain unread emphasis; previews use regular weight. Quick actions occupy the subject line. Account identity, selection, search and provider operations are unchanged.

The macOS candidate builds with the normal Node-free builder and passes deep/strict ad-hoc signature verification, plist lint and complete production-service `morrow-native-check` acceptance. The extended native window fixture exercises long sender/account text at 260/320/500-point list widths in all three densities, bounded rows without horizontal scrolling, duplicate-ID owner selection, Command/Shift multi-selection and existing drag/drop guards. Local native-rendered captures were inspected for header placement and truncation. The run emitted an AppKit NSTableView reentrancy warning; assertions passed. These fictional fixtures do not establish full manual VoiceOver or live-account acceptance.

Windows follow-up: [native candidate CI 37746711282](https://github.com/Coke1120/Morrow-Mail/actions/runs/37746711282), at `4f9273d674fa8b3a0f2549ca99bef5f167d7e1fa`, passes Rust checks, WinUI compilation, package checks, the fresh/owned/restart native UI walkthrough and the fictional-mail benchmark. The owned runs exercise every combination of 260/320/500-point list widths, Compact/Comfortable/Spacious density and Light/Dark theme. Assertions require visible non-overlapping sender/account/date fields, preserve the full accessible owning account, and verify that quick actions leave the date in place. Native RenderTargetBitmap captures include the theme background and are retained as CI evidence; the fixture restores its original density, theme and layout afterward. The same run also passes macOS native acceptance.

Visual inspection of the initial candidate found the toolbar's text Delete button overlapping Refresh at 260 points. The final candidate uses the existing accessible icon button with tighter spacing and passes rendered-bounds and accessible-name regression assertions. Its 260-point Light/Dark and restart captures confirm that both actions are visible without overlap; representative 320/500-point and density captures were also inspected. Twenty fixture PNGs are retained across the owned and restart runs.

This is hosted Windows x64 evidence. A local Windows ARM Parallels walkthrough remains unverified: the installed edition rejects guest command execution, and the VM's CUA interface timed out. Jev review was unavailable because its service lacks `JEV_API_KEY`; source inspection and native checks were used. No version/tag/publication, installed-app replacement, real-mail/calendar write or paid-model request was performed.

## 0.6.0-beta.46 — published paired native release

[Beta.46](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.46) was published at 2026-10-07 18:34:12 HKT from `3f94ae9fa7d11ca4f82b04ed6dc9b1343045c360`. [Tagged CI 37604729787, attempt 1](https://github.com/Coke1120/Morrow-Mail/actions/runs/37604729787/attempts/1) passed all three jobs: Node-free Rust formatting, strict all-target Clippy and locked tests (218 on macOS, 217 on Windows, zero failed/ignored); both native builds and package checks; full macOS production-service acceptance; the Windows fresh/owned/restart UI walkthrough and 1,000/10,000/50,000-message fictional-mail benchmark; and the existing publisher's same-run/same-attempt provenance and pinned-key signing gate. No waiver applied.

All six public assets were downloaded without authentication and matched their GitHub sizes and SHA-256 digests. Both public ZIPs and checksum files are byte-identical to this tag run's candidates. Archive integrity, duplicate/path checks, exact checksum files, manifest platform/version metadata and the published release body against the committed notes passed. The manifest's Ed25519 signature verified against the pinned public key, unchanged from beta.45. The downloaded Mac app passed deep/strict ad-hoc signature verification, plist lint, numeric bundle/release/service version checks and the exported private drag-type declaration. Its service-version probe used a separate absolute temporary workspace. Both packaged Windows metadata files report beta.46; Windows execution was verified by the tagged native job.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 13,475,761 | `3d0b19bd59f3a41e344c8793ad6bd5625812ec32fe84ee07585489821f3a0110` |
| windows-x64 | 37,854,054 | `86acd7a619ed6f65f1d780254299bb230e42cda4c20df5301d1e3eba6d874f4a` |

Beta.46 includes PR #21's Reply-To routing, disconnected-account casing recovery, reviewed uncertain-delivery closure, incomplete-text disclosure and macOS reader failure recovery. Tests use fictional providers and isolated temporary workspaces; no real mail, calendar event or paid-model request was submitted, and installed apps were not replaced. macOS is ad-hoc signed without notarization and Windows is unsigned. Full live-account/provider/model, real external HTTPS image fetching, physical-pointer/accessibility, clean-machine and complete installed-updater restart/rollback acceptance remain outstanding. The previously recorded intermittent Windows reader initialization timeout remains unresolved; its existing gate passed this run. See the [release notes](docs/releases/v0.6.0-beta.46.md).

## PR #21 review before publication

PR #21 was reviewed at `54a265fe26351627280b363abb23bca52ab21a8b` and merged into main as `6dcea29916361d207a8a3926ebc0a6d822c92404`. Review traced reply preparation and provider normalization, both reconnect paths, the owner-bound delivery ledger and scheduled-send recovery, and both native review/reader flows. No blocking defect was found. Fresh local Rust 1.99 formatting, strict all-target Clippy and all 46 tests across `draft_concurrency`, `drafts`, `gmail_sync`, `mail`, `mail_service` and `scheduled` passed.

[PR CI 37601930180](https://github.com/Coke1120/Morrow-Mail/actions/runs/37601930180) passed both platform jobs, including Node-free Rust checks (218 tests on macOS, 217 on Windows, zero failed/ignored), native packaging, full macOS production-service acceptance, Windows fresh/owned/restart UI walkthrough and the 1,000/10,000/50,000-message fictional-mail benchmark. This is pre-release evidence using beta.45 metadata. Beta.46 preparation changed only version metadata and release documentation; its subsequent tagged gate and public verification are recorded above. No waiver applies. See the [release notes](docs/releases/v0.6.0-beta.46.md) for scope and remaining acceptance limits.

## Mail-client review fixes — PR validation

Current source addresses Reply-To routing, disconnected-account casing recovery, reviewed uncertain-delivery resolution, incomplete downloaded-text disclosure and macOS renderer failure recovery. Resolution is a local user decision, not provider delivery verification; it preserves the request/payload ledger and blocks retries after restart. It also closes uncertain scheduled jobs without resubmission. No version, tag, release or installed application is changed.

Targeted Rust checks cover all three import normalizers, Reply / Reply All / forward ownership and Bcc exclusions, text-limit boundaries and multipart truncation, reconnect/cache ambiguity, Gmail metadata backfill, explicit resolution confirmation/account guards, idempotent closure, blocked replay and scheduled restart recovery. Forward/copy disclosure stays inside the UTF-16 compose limit, including emoji text. Formatting and strict all-target Clippy pass; the full locked Rust suite passes 218 tests across 35 test binaries/doc-test runs, with no failures or ignored tests. The macOS native candidate builds and passes deep/strict ad-hoc signature verification, plist lint and complete production-service native acceptance, including injected WebKit failure fallback/recovery with images blocked. Windows smoke adds composer resolution-control visibility and incomplete-text disclosure checks; Windows execution passed in [PR CI 37601930180](https://github.com/Coke1120/Morrow-Mail/actions/runs/37601930180). A focused expert subagent review found no blocking issue. Fixtures use isolated temporary workspaces; no real mail, calendar event or paid-model request is submitted. Jev scoring is unavailable because its service has no `JEV_API_KEY`; review uses source inspection and repository checks. Live-account, manual accessibility, clean-machine and installed-updater acceptance limits remain unchanged.

## 0.6.0-beta.45 — published paired native release

[Beta.45](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.45) was published at 2026-10-07 17:15:03 HKT from `cb68c8f91cdce72d9e53b3d7928d7b0d8632eb87`. [Tagged CI 37596278116, attempt 1](https://github.com/Coke1120/Morrow-Mail/actions/runs/37596278116/attempts/1) passed all three jobs: Node-free Rust formatting, strict all-target Clippy and locked tests (214 on macOS, 213 on Windows, zero failed/ignored); both native builds and package checks; full macOS production-service acceptance; the Windows fresh/owned/restart UI walkthrough and 1,000/10,000/50,000-message fictional-mail benchmark; and the existing publisher's same-run/same-attempt provenance and pinned-key signing gate. No waiver applied.

All six public assets were downloaded without authentication and matched their GitHub sizes and SHA-256 digests. Both public ZIPs and checksum files are byte-identical to this tag run's candidates. ZIP integrity and duplicate/path checks, exact checksum files, manifest platform/version metadata and the published release body against committed notes passed. The manifest's Ed25519 signature verified against the pinned public key, unchanged from beta.44. The identical macOS candidate passed deep/strict ad-hoc signature verification and plist lint; its numeric bundle version is 0.6.0 and its release version is beta.45. Both packaged Windows metadata files report beta.45; Windows execution was verified by the tagged native job. The existing publisher's local check also accepted both paired archives, checksums and explicit notes.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 13,429,053 | `6fdad398ab02000ee2eb29aabbd0fb23dc47dee33041fdfb2541dcdd98b283aa` |
| windows-x64 | 37,809,518 | `f1b439f886e6c935437f579447f476b16c6ae070067631e1d5ecdeab04b340b8` |

Beta.45 carries PR #20, merged as `334d305c1d902c5129e8f76cb25643f157396bcd`, including the reviewed legacy quota status correction. Its [PR CI 37590455373](https://github.com/Coke1120/Morrow-Mail/actions/runs/37590455373) separately passed both platform jobs with beta.44 metadata. Tagged checks use fictional providers and isolated temporary workspaces; no real mail, calendar event or paid-model request was submitted, and installed apps were not replaced. macOS is ad-hoc signed without notarization and Windows is unsigned. Full live-account/provider/model, real external HTTPS image fetching, physical-pointer/accessibility, clean-machine and complete installed-updater restart/rollback acceptance remain outstanding. The previously recorded intermittent Windows reader initialization timeout remains unresolved; its existing gate passed this run. See the [release notes](docs/releases/v0.6.0-beta.45.md).

## PR #20 — sync status UX review

The source changes retain Windows mailbox-scoped sync failures during workspace refresh, project persisted sync failures and quota waits into Activity, identify Read/Unread actions as local, distinguish Activity's local status timestamp from remote mail sync and disclose the bounded recent-mail scope. History retry text no longer implies a three-attempt limit. No version/tag/release, provider-write behavior, polling scope or retry schedule changes are included.

Two Rust regression assertions failed before the fix: saved authorization errors were absent from Activity and the seventh retry still displayed `/3`. The updated Activity and history-retry suites pass all 10 tests, including safe error projection, disconnected-owner filtering, runtime restart, retry timing and recovery. Windows smoke now checks combined/selected mailbox warnings, retry timing, persistence across status resets, current-operation error precedence and clearing after recovery. Rust formatting and strict all-target Clippy pass; the full locked Rust suite passes 214 tests across 35 test binaries/doc-test runs, with no failures or ignored tests. The macOS native candidate builds successfully and passes deep/strict ad-hoc signature verification and plist lint. Production-service native acceptance also passes, including fresh onboarding, native reader isolation, window/lifecycle checks, encrypted persistence, read-state/page retention and account isolation. The original PR revision `40b5db3` passed both macOS and Windows builds and native acceptance in [CI run 221](https://github.com/Coke1120/Morrow-Mail/actions/runs/37585467377), including the Windows fixture walkthrough. Fixtures are isolated and fictional; no real-account acceptance is claimed. Jev scoring was unavailable because its service has no `JEV_API_KEY`; the changes were reviewed directly and checked with the repository tests.

The PR review follow-up also reproduced a legacy quota regression: Activity reported `provider_quota_exceeded` as failed even though the background scheduler automatically retries it. Activity now shows it as queued, with a safe pending-retry message when its deadline is absent or invalid. Regression checks cover valid, missing and invalid deadlines without exposing stored provider text; the Activity/history-retry suites and strict Clippy pass. Retry scheduling is unchanged.

## 0.6.0-beta.44 — published paired native release

[Beta.44](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.44) was published at 2026-10-06 14:17:21 HKT from `f4e3b3d24b1e5294b9446d87c797c268d1827c10`. [Tagged CI 37420582083, attempt 1](https://github.com/Coke1120/Morrow-Mail/actions/runs/37420582083/attempts/1) passed all three jobs: Node-free Rust formatting, strict all-target Clippy and locked tests (213 on macOS, 212 on Windows, zero failed/ignored); both native builds and package checks; full macOS production-service acceptance; the Windows fresh/owned/restart UI walkthrough and 1,000/10,000/50,000-message fictional-mail benchmark; and the existing publisher's same-run/same-attempt provenance and pinned-key signing gate. No waiver applied.

All six public assets were downloaded without authentication and matched their GitHub sizes and SHA-256 digests. Both public ZIPs and checksum files are byte-identical to this tag run's candidates. ZIP integrity, duplicate/path checks, exact checksum files, manifest platform/version metadata and the published release body against the committed notes passed. The manifest's Ed25519 signature verified against the pinned public key, unchanged from beta.42. The identical macOS candidate passed deep/strict ad-hoc signature verification, plist lint, numeric bundle/release/service version checks and the exported private drag-type declaration. The service-version probe used a separate absolute fixture workspace. Both packaged Windows metadata files report beta.44; Windows execution was verified by the tagged native job.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 13,418,418 | `66f47a46b6ed1dd70fa435039f3a2d7ea5c69036c7b160647088323c27924af4` |
| windows-x64 | 37,745,171 | `fe1a5431c27a8ae0d61a5da6b5316e082490213cc7aa91ee7c32d6e4e421cb95` |

Beta.44 includes PR #19 read-state reconciliation and the PR #17/#18 mail refresh, summary diagnostics and Windows reader fixes from unpublished beta.43. Tests use fictional providers and isolated temporary workspaces; no real mail, calendar event or paid-model request was submitted, and installed apps were not replaced. macOS is ad-hoc signed without notarization and Windows is unsigned. Full live-account/provider/model, real external HTTPS image fetching, physical-pointer/accessibility, clean-machine and complete installed-updater restart/rollback acceptance remain outstanding. The previously recorded intermittent Windows reader initialization timeout remains unresolved; its existing gate passed this run. See the [release notes](docs/releases/v0.6.0-beta.44.md).

## PR #19 review before publication

PR #19 was reviewed at `b724142d554698ade19a582da9e1412bd9b7d1dc` and merged into main as `8073d3e40f8ca8c85fc1991ccd3edb8076b35d39`. Review traced the common import path through sync, history and account connection, including cached Gmail metadata, local PATCH overrides, restart persistence and colliding account IDs; no blocking defect was found. Fresh local Rust 1.99 formatting, strict all-target Clippy and all 16 mail/Gmail regression tests passed. The PR's [paired native CI 37368658725](https://github.com/Coke1120/Morrow-Mail/actions/runs/37368658725) passed both platform jobs, including native acceptance and Windows UI smoke/benchmark. These runs used beta.43 metadata and are pre-release evidence. The optional Jev evaluation was unavailable because its API key was not configured.

## PR #19 pre-release checks — remote read-state reconciliation

The shared import path now records the last observed provider read flag, accepts changed remote Read/Unread values, and retains local read edits while the server flag is unchanged. It releases obsolete Gmail read overrides on convergence or a changed server flag. Missing read metadata preserves the baseline; legacy caches without one adopt the first fetched server value, with legacy Gmail label IDs used when available. The change applies to sync, history and initial account imports through the existing common function, retaining bounded fetch scopes and local-only marker writes.

The new regression failed against the previous implementation when an Outlook message changed from unread to read remotely. The focused mail/Gmail suites pass all 16 tests, covering both read directions across Gmail/Outlook/IMAP, local edits, convergence, legacy rows, partial metadata, restart, account collisions and retained local markers. The existing TLS-loopback Gmail service fixture also exercises real sync/PATCH requests and cached metadata refreshes. Rust 1.99 formatting, strict all-target Clippy and all 213 locked Rust tests passed (zero failed or ignored). Native packages were not rebuilt or installed; tests use isolated temporary workspaces and fictional providers, without real mail/calendar/model writes or live-account acceptance. This fix is not part of the beta.43 tag.

## 0.6.0-beta.43 — unpublished, superseded by beta.44

The candidate carries merged PR #17 mail refresh/summary diagnostics and PR #18 Windows reader reselection fixes. The integrated main commit `ee0d7d6bc0ee6117051b26fe4d9856e06f14b832` passed [paired native CI 37294922556](https://github.com/Coke1120/Morrow-Mail/actions/runs/37294922556): both Rust checks and native packages, full macOS acceptance, Windows UI smoke and the fictional-mail benchmark. The PR #18 head separately passed [paired CI 37220068928](https://github.com/Coke1120/Morrow-Mail/actions/runs/37220068928), including the new selection/Unread/Hide checks. These runs used beta.42 metadata and are pre-release evidence only.

The beta.43 gate required fresh same-tag macOS and Windows builds, full native checks and the existing publisher's same-run/same-attempt provenance and pinned-key signature verification. No waiver applied. Its preparation changed only version metadata and release documentation. See the [release notes](docs/releases/v0.6.0-beta.43.md) for scope and remaining acceptance limits.

[Tagged attempts 1](https://github.com/Coke1120/Morrow-Mail/actions/runs/37362899273/attempts/1) and [2](https://github.com/Coke1120/Morrow-Mail/actions/runs/37362899273/attempts/2) both passed the complete macOS job. Windows never received a hosted runner and was cancelled after repeated allocation attempts in both runs, with no build or test steps executed; the release jobs were skipped. GitHub's Actions status incident reported hosted-runner assignment delays at that time. Both platform artifacts would have required the same successful attempt; no tests, deadlines or security gates were changed.

No beta.43 release or public assets were created. Its existing tag `v0.6.0-beta.43` (`fdb964e940650476d79771b6ea100512f8bcf85e`) is preserved. Beta.44 supersedes this candidate and adds PR #19; its own complete paired release gate remains required.

## PR #17 pre-release checks — summary failure diagnostics

The shared summary completion path now preserves the server-authored diagnostic from model requests or P0–P4 validation instead of replacing every failure with generic settings advice. Manual, arrival and scheduled jobs use that path. Existing generic historical errors cannot recover the discarded cause, and Activity retains its content-free last-summary projection. Failed paid work still requires a new review; no retry or model timeout was changed.

The expanded regression failed against the previous implementation and passes after the fix. Existing fixtures cover distinct empty-response and malformed-summary diagnostics, exclusion of raw model/provider error text, manual API/report agreement, persistence after restart, and no automatic retry. On macOS with Rust 1.99, formatting, strict all-target Clippy and all 40 tests in `background`, `ai` and `activity` passed. Two unnecessary closure borrows in the model error handler were removed for the current Clippy check. Tests used isolated temporary stores and loopback model fixtures; no real mail, calendar event or paid model request was submitted. Native packages were not rebuilt or installed, and this does not establish the cause of an installed app's historical model failure or live-account acceptance.

## PR #17 pre-release checks — mail refresh review fixes

Four new regression fixtures reproduced the three reviewed failures before the fixes: Outlook All Mail refresh skipped Inbox and Sent when their inactive checkboxes were off; the equivalent IMAP configuration reported success without attempting a fetch; Outlook reimport kept obsolete provider-folder membership; and a busy mailbox consumed the next regular sync interval. Coverage also checks selected-folder refresh, retained paused history options, duplicate provider IDs across accounts, local read/star/Pending/Later/folder markers, indexed provider-folder pages, preserved sent-message fingerprints, and failure pacing after an actual background read attempt. Fixtures use temporary workspaces and loopback providers or deliberately unusable IMAP configurations, with no real mail, calendar or model requests.

Local macOS validation passed: Rust formatting, strict all-target Clippy, all 212 locked Rust tests (zero failed/ignored), the native production build, full production-service native acceptance, deep/strict signature verification and plist lint. The candidate is ad-hoc signed without notarization. Windows execution is left to the PR's existing native CI; no new release or live-account acceptance is claimed.

## PR #15 / #16 review — Windows reselection follow-up

Both requested PRs were already merged into main: PR #15 at `287feaac00b0836884b57719e590dc7775d2c0cc` and PR #16 at `e3ddeef41d858fd9b5bdf46bf8f74541514c9ec9`. Their final heads (`5eff428f` / `bf21142`) passed paired native CI. Fixed-version review found a remaining Windows interleaving: while A is displayed and B's detail GET is pending, selecting A again and changing A's marker could revive B after PATCH, disagree with the highlighted row and mark B read.

The follow-up cancels pending detail reads that no longer match the actual row selection, starts a fresh read on each real single-row selection change, and refreshes interrupted detail from the currently selected owned row after PATCH. This also handles reselection during an in-flight PATCH. Resuming a row explicitly patched Read/Unread suppresses automatic mark-on-open for that read only, preserving the reviewed marker; another row's patch retains normal automatic reading. A valid image override carries into a refresh only for the same owned message, including reducing multi-selection back to its displayed row. Added Windows smoke uses the real SelectionChanged handler and isolated owned fictional mail to exercise A → pending B → A with no PATCH, with Read/Unread/Starred/Pending changes, and with reselection while PATCH is busy; B must remain unread with mark-on-open enabled, and A's manual unread choice must survive the resumed read. A marker-independent oldest sort keeps both fictional rows on the bounded page and is restored afterward. The reader runtime fixture also exercises actual multi-selection → single A events, production Hide handling, and an inert same-message remount under opt-in that must still block images. Existing same-row/other-row detail recovery and reader security checks remain required; the reader's 25-second security deadline is unchanged.

The macOS host cannot execute WinUI; Windows build and smoke execution are checked by the paired PR CI, with exact-run evidence recorded in the follow-up PR. This source change is not published in beta.42. Tests do not use the owner's workspace or real provider writes.

## 0.6.0-beta.42 — published paired native release

[Beta.42](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.42) was published at 2026-10-04T08:48:58Z from `3bcdcc32ac3605fa60a4f3202417bdab488219ca`. [Tagged CI 37188678503, attempt 1](https://github.com/Coke1120/Morrow-Mail/actions/runs/37188678503/attempts/1) passed all three jobs: Node-free Rust formatting, strict all-target Clippy and locked tests (208 on macOS, 207 on Windows, zero failed/ignored); both native production builds and package checks; full macOS production-service acceptance; the complete Windows fresh/owned/restart UI walkthrough, including the new interrupted detail-read/marker PATCH regression and reader/image consent checks; the 1,000/10,000/50,000-message fictional-mail benchmark; and the existing publisher's same-run/same-attempt provenance and signing gate. No waiver applied. PR #16 was merged to main as `e3ddeef41d858fd9b5bdf46bf8f74541514c9ec9` after its paired CI passed.

All six public assets were downloaded and matched their GitHub sizes and SHA-256 digests. Both public ZIPs and checksum files are byte-identical to this tag run's candidates. Archive integrity and duplicate/path checks, exact checksum files, manifest platform/version metadata and the published release body against the committed notes passed. The manifest's Ed25519 signature verified against the pinned public key, unchanged from beta.41. The downloaded macOS candidate and public app passed deep/strict ad-hoc signature verification, plist lint, numeric bundle/release/service version checks and exported private drag type/data conformance checks. The service-version probes used separate absolute fixture workspaces.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 13,421,089 | `31c9543416f09b160e316e785665c910335fe0224a98fe01654945b00bd875c6` |
| windows-x64 | 37,720,457 | `bf33458ab3883b1a55d31858e2246b85559aeee1a97ceec0b08eb2598e5f9de2` |

Beta.42 includes native reader refresh/image consent, macOS Settings persistence and stale-response rejection, draft-save/send serialization, indexed folder reconciliation and updater preparation fixes. All checks use isolated fictional mail/providers; no real mail, calendar event or paid-model request was submitted, and installed apps were not replaced. Full live-account/provider/model, real external HTTPS image fetching, physical-pointer/accessibility, clean-machine and complete installed-updater restart/rollback acceptance remain outstanding. Helper-file fixtures do not establish a full installed prepare handshake; macOS response fixtures do not establish a physical GUI race/confirmation walkthrough. The earlier intermittent Windows reader initialization timeout remains unresolved; its security gate is unchanged and passed this run. macOS is ad-hoc signed without notarization and Windows is unsigned. See the [release notes](docs/releases/v0.6.0-beta.42.md).

## PR #16 review checks — before release preparation

The source fixes eight review findings: Windows metadata updates retain the selected reader and its per-message Hide override; macOS auto-saves `sendDelayHours` and routes Open Today through Settings save/discard review; draft saves hold the mailbox gate across the idle check and queued DB write; folder management loads only indexed affected provider memberships and skips message reads for empty deltas; updater preparation includes app-local Windows CRT companions, removes attempt-owned helper/marker files on failure, and initializes after Store creates a fresh workspace. The macOS reload path also rejects cancelled or superseded state snapshots. Package version and the pinned update key remain unchanged; beta.41 downloads do not contain these fixes.

Local Rust formatting, strict all-target Clippy and all **208 locked tests** passed with zero failed or ignored tests. New regression coverage controls send/save DB queue order without reaching a provider, denies message-table reads for empty folder changes, and checks helper runtime copying, private Unix modes, retry cleanup and preservation of existing markers and verified downloads. Existing account, provider, persistence, reader-security and signed updater/rollback tests passed. The helper-file fixtures do not establish clean-machine Windows installation or a full prepare handshake.

The macOS production candidate built, passed deep/strict ad-hoc signature verification and plist lint, and passed complete `morrow-native-check` acceptance. Added native checks exercise the production preference diff/reconciliation helpers with a lone delay change and another edit during a save; the actual AppModel/URLSession with controlled localhost responses rejects superseded/cancelled reloads, retains same-account paging and follows a new service-selected account. A packaged service launched in a nonexistent fixture workspace reports updater `supported=true` on its first session and shows Add account. Open Today uses the existing reviewed close path, but a physical GUI click/confirmation and a SwiftUI task-cancellation race are not claimed.

The same isolated 10,000-message fixture (171,970,000 bytes of fictional message JSON) measured empty-change `update_cache` calls at 0.136/0.125/0.046 ms in the current debug library, compared with the review baseline of 1334/1340/1232 ms. This measures the cache function only, excluding provider requests, application startup and UI rendering. The SQLite authorizer regression independently rejects any message-table read during an empty change.

Windows smoke now checks actual local PATCH operations under image opt-in after Hide, same-message Starred/Pending/Read, an update to another row, and subsequent Plain text/HTML interaction. Windows compilation/execution is delegated to the paired PR CI rather than this macOS host. All checks use isolated fictional workspaces; no real mail, calendar event, paid model call or installed app replacement is used. Full live-account, clean-machine/accessibility, physical-pointer and installed-updater acceptance remain outstanding; macOS signing remains ad-hoc without notarization and Windows remains unsigned.

PR #16 follow-up review found that invalidating an in-flight Windows detail GET during a local marker PATCH could leave the highlighted new row displaying the previous message. Local patches now capture and reload the interrupted owned detail after the metadata/page refresh, provided the view and selection are still current. Navigation clears the pending read; completed readers retain their image override. The Windows smoke adds immediate GET/PATCH interleavings for Read, Starred, Pending and a patch to another row, checking full body, owner, highlighted identity and current metadata. The updated paired PR CI above passed both platforms, including the full Windows owned-mailbox walkthrough with these interleavings.

## 0.6.0-beta.41 — published paired native release

[Beta.41](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.41) was published at 2026-10-03T20:39:05Z from `89b294eebbfe80cf93341bc366c9315e124dc7b4`. [Tagged CI 37150867059, attempt 1](https://github.com/Coke1120/Morrow-Mail/actions/runs/37150867059/attempts/1) passed all three jobs: Node-free Rust formatting, strict all-target Clippy and locked tests (203 on macOS, 202 on Windows, zero failed/ignored); both native builds and package checks; full macOS production-service acceptance; the complete Windows fresh/owned/restart walkthrough and 1,000/10,000/50,000-message fictional-mail benchmark; and the existing publisher's same-run/same-attempt provenance and signing gate. No waiver applied.

All six public assets were downloaded and matched their GitHub sizes and SHA-256 digests. Both public ZIPs and checksum files are byte-identical to this tag run's candidates. ZIP integrity, duplicate/path checks, exact checksum files, manifest platform/version metadata and the published release body against the committed notes passed. The manifest's Ed25519 signature verified against the pinned public key, unchanged from beta.40. The public macOS app passed deep/strict ad-hoc signature verification, plist lint, numeric bundle/release/service version checks and exported private drag type/data conformance checks. The service-version probe used a separate absolute fixture workspace.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 13,415,286 | `49d3517d33089244fed8070bbf0c7396ddd064de4254e2f30f12dbfa2d5ec4c2` |
| windows-x64 | 37,785,184 | `246687e71c01448d3cc86740e9e1651ef86a45a97dedfbdb5c4ead1865909c65` |

Both native General settings pages expose the default-off automatic HTTPS image preference with its tracking disclosure. Tagged production reader checks cover opt-in, per-message Hide and existing isolation; Windows also checks override retention during refresh. Local preference persistence, macOS new-message reset and revocation evidence appear below. These checks use inert image fixtures and do not establish real external HTTPS image fetching or full live-account acceptance. All checks used isolated fictional workspaces and provider/model fixtures; no real mail, calendar event or paid-model request was submitted, and installed apps were not replaced. macOS is ad-hoc signed without notarization and Windows is unsigned. Full live-account/provider/model, physical-pointer/accessibility, clean-machine and installed-updater restart/rollback acceptance remain outstanding. The earlier intermittent Windows reader initialization timeout remains unresolved; its security gate is unchanged and passed this run. See the [release notes](docs/releases/v0.6.0-beta.41.md).

## Beta.41 local pre-release checks — automatic external image preference

Both native General settings pages now offer a default-off `autoLoadExternalImages` preference with an adjacent IP/open-tracking disclosure. It is a global, automatically saved boolean; existing settings remain off, unrelated field-diff saves preserve it, and restart retains both opt-in and revocation. macOS applies it to the selected message and reply-history readers, with a per-message override reset on message or preference changes. Windows initializes each owned reader from the saved preference, retains the current selection's explicit image choice across reader refreshes using the existing view/selection generations, and keeps its Hide/Load action and credential-free bounded HTTPS image client. The catalog's versioned size/hash and native-preference provenance were updated; the pinned update key is unchanged. This feature is not in the published beta.40 packages.

Formatting, strict all-target Clippy and all 203 locked Rust tests passed with zero failed/ignored. The two new preference regressions cover absent/legacy defaults, rejection of non-booleans, account and combined-view projection, unrelated partial saves, encrypted-store restart and revocation. Existing sanitizer, provider/account isolation, persistence and updater tests also passed. The macOS candidate built and passed full production-service native acceptance, deep/strict ad-hoc signature verification and plist lint. The native integration checks exercise the preference API and malformed-input rejection. The reader fixture mounts the production `SecureMessageBody`, verifies default blocking and HTTPS-only opt-in with scripts still disabled, clicks the actual per-message Hide control using measured native view bounds and window mouse events, and checks new-message reset and global revocation. The original bounded-scrolling, fallback, script/unsafe-link and zero-unsolicited-loopback checks remain and passed. SwiftUI's background fixture exposes no AX children, so that interaction test uses native layout/input rather than assuming an AppKit button or accessibility node.

The corresponding Windows runtime fixture now checks saved opt-in, HTTPS-only policy, the production Hide action and override retention across refresh using inert HTML without image URLs before its existing hostile-content/network-zero phases. Windows compilation and UI smoke were unverified on this macOS host at the local pre-release stage. The initial local candidate used beta.40 metadata; the rebuilt local candidate and fresh tagged CI above verify beta.41 metadata, with tagged packages and native acceptance passing on both platforms. Tests used isolated fictional workspaces, with no real mail/calendar/model writes or installed-app replacement. Real external HTTPS image fetching, physical-pointer/accessibility, clean-machine and live-account acceptance are not established by these fixtures.

The initial unpublished beta.41 tag run ([37149854740](https://github.com/Coke1120/Morrow-Mail/actions/runs/37149854740)) passed macOS Rust checks and packaging but timed out in the new reader image-preference phase. The fixture now queues the complete native mouseDown/mouseUp pair before AppKit handles it, avoiding synchronous control tracking waiting for an event that has not yet been dispatched. Additional phase diagnostics retain the existing 30-second deadline, actual Hide interaction, isolation and network-zero assertions. A rebuilt beta.41 local candidate passed full production-service native acceptance, deep/strict signature verification and plist lint with this event sequence; the fresh paired tagged run recorded above passed before publication. The final tagged reader fixture completed in 26.229 seconds within its unchanged 30-second deadline.

## 0.6.0-beta.40 — published paired native release

[Beta.40](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.40) was published at 2026-10-03T17:32:39Z from `558f21a3c6e59437e93207e322b5e64edbf321c5`. [Tagged CI 37139266791, attempt 1](https://github.com/Coke1120/Morrow-Mail/actions/runs/37139266791/attempts/1) passed all three jobs: Node-free Rust formatting, strict all-target Clippy and locked tests (201 on macOS, 200 on Windows, zero failed/ignored); both native builds and package checks; full macOS production-service acceptance; the complete Windows fresh/owned/restart walkthrough and 1,000/10,000/50,000-message fictional-mail benchmark; and the existing publisher's same-run/same-attempt provenance and signing gate. No waiver applied.

All six public assets were downloaded and matched their GitHub sizes and SHA-256 digests. Both public ZIPs and checksum files are byte-identical to this tag run's candidates. ZIP integrity, duplicate/path checks, exact checksum files, manifest platform/version metadata and the published release body against the committed notes passed. The manifest's Ed25519 signature verified against the pinned public key, unchanged from beta.39. The public macOS app passed deep/strict ad-hoc signature verification, plist lint, numeric bundle/release/service version checks and exported private drag type/data conformance checks. The service-version probe used a separate absolute fixture workspace.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 13,410,388 | `c70d43e386a849ab8ecc9bb21cc0b855712f216f7814f544d73c4d3f81eb444b` |
| windows-x64 | 37,782,081 | `1e3bab68a08496b56458baa5616b90ddccbc20203c73ce637597706926903248` |

The release replaces repeated cached-message JSON scans with an indexed account/provider-folder membership lookup shared by paging and folder-scoped keyword search. The local fixture measurements and migration regressions are recorded below; they do not establish end-to-end UI or real-account latency. All checks used isolated fictional workspaces and provider/model fixtures; no real mail, calendar event or paid-model request was submitted, and installed apps were not replaced. macOS is ad-hoc signed without notarization and Windows is unsigned. Full live-account/provider/model, physical-pointer/accessibility, clean-machine and installed-updater restart/rollback acceptance remain outstanding. The earlier intermittent Windows reader initialization timeout remains unresolved; its security gate is unchanged and passed this run. See the [release notes](docs/releases/v0.6.0-beta.40.md).

## Beta.40 local pre-release checks — cached label/server-folder performance

Current source replaces provider-membership JSON scans with a SQLite table indexed by account and exact provider label/folder ID. Insert/update/delete triggers maintain it in the message write transaction; overlapping folder/label memberships are deduplicated. Existing workspaces build the table once in the opening transaction, retaining cached messages, drafts, settings and the original encryption key. It stays separate from derived keyword/semantic search data, so downloaded folder pages remain complete during keyword-index recovery. Folder-scoped keyword search shares the indexed account lookup. This change is not included in the published beta.39 packages.

All 201 locked Rust tests passed, with zero failures or ignored tests, along with formatting and strict all-target Clippy. Three new regressions cover colliding IDs and provider labels across accounts, duplicate/Unicode/case-sensitive memberships, local overrides, upserted provider moves, deletion and rollback, legacy scalar/null/non-text membership compatibility, first-open backfill without changing messages/settings/key, keyword-index recovery, restart/online backup, all six sorts, cursor/offset paging, unread filtering and folder-scoped keyword search. SQLite's full-scan step counter is zero for the indexed account/folder lookup. Existing provider import/move, reconnect/disconnect, send/AI isolation, reader-security and updater tests also passed.

An isolated SQLite 3.53.4 fixture compared the previous JSON predicate with the current source's membership DDL/backfill and lookup. With two mailboxes, 8,192-byte fictional bodies, newest sorting and five warm requests, median SQL count-plus-first-page time fell from 107.52 ms to 0.62 ms at 10,000 cached messages, and from 536.53 ms to 1.65 ms at 50,000. Identical totals and returned rows were verified. The latter mailbox selection matched 2,500 messages; the page retrieved 50 summaries plus one lookahead. The query plan changed from `SCAN messages`/per-row `json_each` to a covering account/folder index. One-time membership creation/backfill took 94.71/493.36 ms for those fixtures. These are SQL fixture measurements, excluding full application startup, Rust decoding, HTTP and UI rendering; they do not establish real-account latency or cold-cache acceptance. The local probe and report are in ignored `test-results/provider-folder-probe.py` and `test-results/provider-folder-performance.json`.

The macOS candidate built and passed full production-service native acceptance, deep/strict ad-hoc signature verification and plist lint. Native checks cover fresh/owned fictional workspaces, paging/selection, account isolation, lifecycle, encrypted persistence, online backup, and reader isolation/network-zero behavior. They emitted the existing AppKit reentrant-table-delegate warning while passing. This local app used beta.39 metadata; the fresh tagged CI above verifies beta.40 packages on both platforms. Windows native compilation and UI smoke were unverified on this macOS host. At this pre-release stage, no beta.40 release had been published or installed app replaced; fixtures did not use the owner's workspace or submit real provider/model writes. Live-account, clean-machine/accessibility, Developer ID notarization and installed-updater acceptance remain outstanding.

## 0.6.0-beta.39 — published paired native release

[Beta.39](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.39) was published at 2026-10-03T06:36:41Z from `287feaac00b0836884b57719e590dc7775d2c0cc`. [Tagged CI 37102152707, attempt 1](https://github.com/Coke1120/Morrow-Mail/actions/runs/37102152707/attempts/1) passed all three jobs: Node-free Rust formatting, strict all-target Clippy and locked tests (198 on macOS, 197 on Windows, zero failed/ignored); both native builds and package checks; full macOS production-service acceptance; the complete Windows fresh/owned/restart walkthrough and 1,000/10,000/50,000-message fictional-mail benchmark; and the existing publisher's same-run/same-attempt provenance and signing gate. No waiver applied.

All six public assets were downloaded and matched their GitHub sizes and SHA-256 digests. Both public ZIPs and checksum files are byte-identical to this tag run's candidates. ZIP integrity, duplicate/path checks, exact checksum files, manifest platform/version metadata and the published release body against the committed notes passed. The manifest's Ed25519 signature verified against the pinned public key, unchanged from beta.38. The identical macOS candidate app passed deep/strict ad-hoc signature verification, plist lint, numeric bundle/release/service version checks and exported private drag type/data conformance checks. The service-version probe used a separate absolute fixture workspace.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 13,413,990 | `0588a1c08f5a7a29c0ae4b3e4bd407fbdcb10c9d14193016ebeaf863167dae16` |
| windows-x64 | 37,781,593 | `466c480c33368bed6e254595a3da896c77de01a9f0c6947bd301d6efbd9f3d41` |

[PR #15](https://github.com/Coke1120/Morrow-Mail/pull/15) merged at 2026-10-03T06:09:28Z as `287feaac00b0836884b57719e590dc7775d2c0cc`, after [paired PR CI 37100878251](https://github.com/Coke1120/Morrow-Mail/actions/runs/37100878251) passed both native jobs with the same 198/197 Rust test counts and complete native acceptance. Review found that legacy cooldowns could reject verification of a replacement IMAP connection. The shared lookup now requires the currently saved connection, with a regression that fails before the guard and covers all four deadline sources. Local formatting, strict Clippy, all 198 Rust tests, macOS packaging and full native acceptance also passed; that local app used beta.38 metadata, while this tag's fresh CI verifies beta.39 packages.

All tests used isolated fictional workspaces and provider/model fixtures; no real mail, calendar event or paid-model request was submitted, and installed apps were not replaced. macOS is ad-hoc signed without notarization and Windows is unsigned. Full live-account/provider/model, physical-pointer/accessibility, clean-machine and installed-updater restart/rollback acceptance remain outstanding. The earlier intermittent Windows reader initialization timeout remains unresolved; its security gate is unchanged and passed this run. See the [release notes](docs/releases/v0.6.0-beta.39.md).

## Provider fetch reliability — included in beta.39

PR #15 review recovery binds every cooldown lookup, including legacy sync errors without their own connection version, to the currently saved connection. A replacement IMAP connection can complete its verification read before saving clears the target account's old wait. The regression fails before the guard and covers shared, history, catalog and legacy sync waits for saved, replacement and disconnected connections. The merged-main recovery candidate passed formatting, strict all-target Clippy and all 198 locked Rust tests locally (zero failed/ignored); the final paired PR CI subsequently passed both native jobs before merge.

The shared Rust reader now persists one quota cooldown per account/connection across ordinary sync, history import and folder/label reads, including restart and import pause/resume. Existing persisted cooldowns are respected on upgrade. Provider Retry-After seconds/HTTP dates can extend local backoff, including transient history reads; authentication and writes do not gain automatic retry. Reconnect/disconnect clears only the target account's cooldown.

Gmail refresh still checks the same five bounded scopes, but fetches each overlapping message once per refresh. Cached non-draft bodies use minimal metadata reads; drafts and older caches without HTML metadata receive full reads. Detail 404s skip only the vanished message and keep the page/checkpoint transaction; authorization, quota and 5xx errors still abort that page under the existing recovery policy. No server-deletion reconciliation or incremental Gmail history sync is claimed.

The isolated 150-message overlapping-scope fixture falls from 260 to 160 HTTP requests per refresh. Its unchanged second refresh fetches 50 draft bodies and 100 minimal responses, retaining fresh draft contents and account-owned duplicate IDs. Regression checks cover shared pacing, Retry-After, retained checkpoints, restart, pause/resume, reconnect/disconnect isolation and legacy HTML-cache refill. The initial PR candidate passed Rust formatting, strict all-target Clippy, all 193 locked Rust tests, macOS candidate packaging, deep/strict ad-hoc signature verification, plist lint and full production-service native acceptance. Windows compilation and complete native acceptance subsequently passed the final paired PR and tagged CI recorded above. These are fictional local TLS provider tests, not live-account acceptance; no real mail, calendar event or installed app is changed.

## 0.6.0-beta.38 — published paired native release

[Beta.38](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.38) was published at 2026-10-03T05:36:05Z from `d6e01fcd8a73b5a96c05d30db48a498416fdb0d6`. [Tagged CI 37099085526, attempt 1](https://github.com/Coke1120/Morrow-Mail/actions/runs/37099085526/attempts/1) passed all three jobs: Node-free Rust formatting, strict all-target Clippy and locked tests (192 on macOS, 191 on Windows, zero failed/ignored); both native builds and package checks; full macOS production-service acceptance; complete Windows fresh/owned/restart walkthrough and the 1,000/10,000/50,000-message fictional-mail benchmark; and the existing publisher's same-run/same-attempt provenance and signing gate. No waiver applied.

All six public assets were downloaded and matched their GitHub sizes and SHA-256 digests. Both public ZIPs and checksum files are byte-identical to this tag run's candidates. ZIP integrity, duplicate/path checks, exact checksum files, manifest platform/version metadata and the published release body against the committed notes passed. The manifest's Ed25519 signature verified against the pinned public key, which is unchanged from beta.37. The public macOS app passed deep/strict ad-hoc signature verification, plist lint, bundled/service version and exported private drag type/data conformance checks. Its service-version probe used a separate absolute fixture workspace.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 13,242,672 | `72dcaafeaa3fc66561a4384a201d7b00586a4b838d94ecbbc5aa68ab3c6eb460` |
| windows-x64 | 37,530,248 | `cf7d7a71f550c470e221010ddccf88f7a031f1c4a1a2b7d3a3404843b4c69e71` |

[PR #14](https://github.com/Coke1120/Morrow-Mail/pull/14) merged at 2026-10-03T05:11:14Z as `309a3da4a83698dc78de70c291b2e7559f3879c6`, after [paired PR CI 37097864427](https://github.com/Coke1120/Morrow-Mail/actions/runs/37097864427) passed both native jobs. The source fixes retain the owned macOS reader when navigating from Today, Ask and the reply queue, and treat Smart Ask questions as literal text. Native smoke fixes retain the folder/owner, selection, Unread and model-input/key-retention assertions, including loaded/measured controls and native event delivery. The earlier failed attempts below remain historical evidence.

All tests used isolated fictional workspaces and loopback model fixtures; no real mail, calendar event or paid-model request was submitted, and installed apps were not replaced. macOS is ad-hoc signed without notarization and Windows is unsigned. Full live-account/provider/model, physical-pointer/accessibility, clean-machine and installed-updater restart/rollback acceptance remain outstanding. The intermittent Windows reader initialization timeout is unresolved and its security gate remains unchanged; the earlier manual Parallels walkthrough covers beta.30. See the [release notes](docs/releases/v0.6.0-beta.38.md).

## PR #14 review fixes — included in beta.38

The [first complete review-fix CI](https://github.com/Coke1120/Morrow-Mail/actions/runs/37092885268) passed macOS, both platforms' Rust checks, Windows packaging and its 1,000/10,000/50,000-message benchmark. Windows walkthrough failed at the new multi-selection fixture: it requested SelectionItem from the ListViewItem control peer. [WinUI documents](https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.xaml.automation.peers.listviewitemautomationpeer?view=windows-app-sdk-1.8) selection automation on the parent ListView's item peers. The check now obtains its item peer through the native ListViewAutomationPeer; it still invokes SelectionItem and requires the correct owned reader content. No assertion or security gate is removed. Benchmark runs after a walkthrough failure, so reaching it does not establish walkthrough success.

[The next CI](https://github.com/Coke1120/Morrow-Mail/actions/runs/37094286038) passed native selection and batch checks, then exposed an incompatible Unread fixture precondition: its seeded preferences disable mark-read-on-open. That check now explicitly enables the behavior it asserts and restores the original preference before continuing. The already-failed run was cancelled during its redundant benchmark; it is not passing Windows evidence. Fresh full paired CI was still mandatory at that stage.

[CI 37095492871](https://github.com/Coke1120/Morrow-Mail/actions/runs/37095492871) passed those selection/batch/Unread assertions and macOS, then failed the model-settings invalid-endpoint probe. The fixture invoked Test before the asynchronous TextChanged binding received its new URL. It now waits for that native event before testing and again after restoring the original value, preserving HTTPS validation, entered-key retention and clean-edit assertions. [Microsoft documents the asynchronous event timing](https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.xaml.controls.textbox.textchanging?view=windows-app-sdk-2.0). The failed run was cancelled during its redundant benchmark; fresh paired CI was still required at that stage.

[CI 37096881015](https://github.com/Coke1120/Morrow-Mail/actions/runs/37096881015) again passed macOS and both Rust/package gates, but the new wait showed that the endpoint control emitted no TextChanged event. The smoke test now requires a loaded, measured TextBox and applies its native template before writing, then retains the event waits and original invalid-endpoint/key/edit assertions. The failed run was cancelled; it is not passing Windows walkthrough evidence.

Source navigation now clears the previous folder's reader synchronously in the shared macOS model, before selecting the requested owned source. The production SwiftUI/service fixture checks Today, Ask and reply-queue navigation, colliding provider IDs across two accounts and a source outside the first page. Smart Ask passes the literal question into the existing approved search pipeline; the regular Search API retains its operator grammar. Its fixture covers colons, incomplete quotes, operator-looking text, the 500-character boundary and rejection before model work above that boundary, without changing the index or disclosing another account.

All 192 locked Rust tests passed with no failures or ignored tests. Formatting, strict all-target Clippy, macOS packaging, full production-service native acceptance, deep/strict ad-hoc signature verification and plist lint passed locally. The source regression mounts the production SwiftUI view and closes it before restoring the fixture mailbox to avoid racing its automatic page load. The merged candidate retains main's native multi-selection, Unread and shared-model activity fixes. Windows' earlier PR walkthrough failed because its combined-folder count still expected eight folders after adding Later; the assertion now expects all nine and retains the independent destination/owner checks. The passing paired PR/tagged CI recorded above subsequently completed these gates; no test waiver applied.

## Pre-release checks — attention workflows included in beta.38

The [AI Emaily review](docs/AI_EMAILY_REVIEW-2026-10-03.md) records public website interaction, documentation and App Store screenshots; it does not claim authenticated competitor testing. This source adds actionable Today reply previews, Ask with opt-in approved semantic retrieval and numbered context sources, reply-queue evidence, separate Brain guardrails, reviewed manual local rules, a persistent Later view and a Today onboarding entry. Both clients remain native; no provider organization, automatic rule execution, sending or new indexing starts from these views.

All 191 locked Rust tests, formatting and strict all-target Clippy passed. New fixtures cover duplicate provider IDs across accounts, permission-redacted Ask sources and invalid reference rejection, opt-in retrieval without indexing, no paid query without a configured chat model, in-flight search revocation, Brain guardrail compatibility, valid Today proposals, atomic single-use local-rule previews and reconnect invalidation, and Later import/restart persistence. Checks use fictional mail, isolated temporary stores and loopback model fixtures; they do not establish live-account acceptance.

The final macOS release candidate built successfully and passed full production-service native acceptance, including the new Later filter assertions, native HTML reader isolation/network-zero checks, lifecycle guards, account routing, encrypted restart persistence and backup. Deep/strict ad-hoc signature verification and plist lint also passed. Windows smoke adds independent Later/Pending marker checks and the Later navigation destination; Windows compilation and smoke remain pending in the [paired PR workflow](https://github.com/Coke1120/Morrow-Mail/pull/14/checks), unavailable on this macOS host. No release or installed-app replacement occurred, and the owner's working tree and mailbox were not used. Live-account, clean-machine/accessibility, Developer ID notarization and installed-updater acceptance remain outstanding.

## Pre-release checks — Inbox selection, Delete/Undo, Unread and AI activity

Both native clients now expose direct provider Delete from the list toolbar, reader and selection context menu. Multiple selection uses owned view IDs with ⌘/Ctrl and Shift gestures. Selection actions apply local read/star/Pending/archive/Trash patches, or sequential provider Trash moves, through each captured owner. Undo restores the latest deletion batch using its individual one-minute, account-bound tokens; failures stop the batch and report confirmed progress without automatic replay. Arbitrary bulk destination moves and permanent deletion remain unsupported.

Unread keeps the opened, newly read message at its original list position until another message or view/page is opened. The server's unread total remains authoritative. Retained rows update their read/star/Pending markers, and explicit Mark Unread releases the retained read snapshot. AI activity follows the actual shared model work rather than its HTTP waiters, so closing one automatic waiter cannot falsely mark a still-running model request interrupted. Failed model work exposes server-authored connection, HTTP, invalid/empty response or timeout diagnostics without provider bodies, keys or automatic retry; the model timeout remains 45 seconds.

The 38 locked AI/activity/mail-service fixture tests, Rust formatting, strict all-target Clippy, Swift release compilation, macOS candidate packaging, deep/strict ad-hoc signature verification and plist lint passed. Native event checks cover ordinary click, ⌘ multiple selection, Shift ranges, selection collapse, and account-owned duplicate IDs on the production draggable list. Full production-service acceptance passed with combined batch patches, unread retention/release, retained-row manual-unread/Pending regressions, paging, encrypted persistence, online backup, reader isolation and network-zero checks. Fixture UI checks emitted the existing AppKit reentrant-table-delegate warning.

Windows source and smoke checks include multiple selection, context actions, batch patch ownership and retained-row updates, but Windows compilation and UI smoke execution remain unverified on this macOS host. All executed tests used fictional providers/data and isolated temporary workspaces. Live-account batch Trash/Undo, model connectivity and physical/accessibility acceptance remain outstanding. No release was published and no installed app was replaced.

## Pre-release checks — saved model API keys included in beta.38

Chat and embedding now compare both saved and edited base URLs through the existing URL validator before reusing a key. Equivalent legacy trailing-slash, hostname-case and default-port spellings keep the key when changing models; changed endpoints and explicit removal retain their credential isolation. Both native clients show saved-key status and collapse replacement controls. Windows connection tests and failed saves retain an entered replacement key in the password control; successful Save, discard and page disposal still clear it, and request-body cleanup remains.

The two legacy-URL regression cases failed before the fix and passed afterward. All 36 locked AI/smart-search fixture tests, Rust formatting, strict all-target Clippy, Swift release compilation, macOS candidate packaging, deep/strict ad-hoc signature verification, plist lint and full production-service native acceptance passed. Tests used fictional keys and isolated temporary workspaces; no real account, mail, calendar or model request was used. Native window checks emitted the existing AppKit reentrant-table-delegate warning while passing.

A Windows smoke check was added for collapsed saved-key controls and retaining an entered key after an invalid-endpoint test, rejected before model work. Windows compilation and smoke execution remain unverified on this macOS host. No release was published and no installed app was replaced.

## 0.6.0-beta.37 — published paired native release

[Beta.37](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.37) was published at 2026-10-02T06:53:27Z from `87289b1a41891f691b04cfff18cd70902eea1560`. [Tagged CI 36973708743, attempt 1](https://github.com/Coke1120/Morrow-Mail/actions/runs/36973708743/attempts/1) passed all three jobs: Node-free Rust formatting, strict all-target Clippy and locked tests on both platforms; macOS packaging and production-service native acceptance; Windows packaging, complete fresh/owned/restart native walkthrough (including Reply, Reply All, reopened reply drafts, independent scroll panes, wide/narrow positioning and unchanged persistence assertions) and the 1,000/10,000/50,000-message fictional-mail benchmark; and the existing paired publisher's same-run/same-attempt provenance and signing gate. No waiver applied.

All six public assets were downloaded and matched their GitHub sizes and SHA-256 digests. Both public ZIPs and checksum files are byte-identical to this tag run's candidates. Bundled versions, ZIP integrity/path checks and exact checksum files passed; the manifest's Ed25519 signature verified against the unchanged pinned public key. The identical macOS app passed deep/strict ad-hoc signature verification, plist lint, its release version, exported private drag type/data conformance and an isolated service-version check. The published release body matches the committed release notes. Local source checks also passed all 187 Rust tests and full macOS production-service acceptance.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 12,995,208 | `7d00b194a6fcf5925976ebbd0d9b186fdfaf62ac36e6327768d08d4ee77c6d83` |
| windows-x64 | 37,303,756 | `0285054038539d46721c829459c504cac852ed4501d29eed910907c8c5b31ee5` |

The macOS composer walkthrough below used a hardcoded fictional workspace; its unchanged composer source was also reopened with the beta.37 service. Native coordinate clicks opened the correct owned reader and cached folder, and local sidebar filtering retained the combined Inbox. Even with a coordinate-confirmed folder target, CUA drag attempts did not open Move review; complete physical-pointer/drop and live-provider acceptance remain unverified. The fixture companion was quit; the owner's installed app remained running. The candidate Windows ZIP was downloaded and checksum-verified for Parallels. Windowed/full-screen CUA inputs did not reach PowerShell reliably; Coherence exposed the Terminal window but still lost most command characters. The Standard edition disallows `prlctl exec`. The prepared marked-fixture PowerShell/UI Automation relay was not started, so no beta.37 manual Parallels acceptance is claimed. The earlier successful Parallels walkthrough remains beta.30 only; owner assistance to start the new isolated script was requested.

Tests used isolated fictional workspaces; no real mail, calendar event or paid-model request was submitted, and installed apps were not replaced. The unchanged Windows reader gate passed this tagged run; its earlier intermittent controller-ready timeout remains unresolved. macOS is ad-hoc signed without notarization and Windows is unsigned. Full live-account, clean-machine/accessibility and installed-updater restart/rollback acceptance remain outstanding. See the [release notes](docs/releases/v0.6.0-beta.37.md).

## Unpublished beta.36 fixture catalog failure

[Tagged run 36970455171, attempt 1](https://github.com/Coke1120/Morrow-Mail/actions/runs/36970455171/attempts/1) passed macOS completely and Windows Rust checks, native compilation/packaging, fresh and owned UI assertions (including Reply, Reply All and reopened reply drafts), and the fictional-mail benchmark. The post-owned persistence verification failed because legacy fixture folder catalogs omitted `editable`; the metadata worker correctly scheduled their refresh and recorded an error for the fictional IMAP connection. The owned UI result itself was successful. Restart acceptance did not run and the paired publisher was skipped; no downloads were published. Beta.37 supplies current catalog metadata in both existing fixture helpers, adds the field to their existing contract check and keeps all production refresh and persistence assertions unchanged. Fixed lowercase reply phase names also make each mode visible through the existing safe diagnostic allowlist. The original tag and evidence are retained.

## Unpublished beta.35 Windows compile failure

[Tagged run 36969161321, attempt 1](https://github.com/Coke1120/Morrow-Mail/actions/runs/36969161321/attempts/1) completed macOS checks/build/acceptance successfully but Windows compilation failed at Compose.cpp with C3861/C2065: `GridUnitType` was not qualified in the new pane layout. Both Rust gates passed. The publisher was skipped and no release/downloads were created. Beta.36 qualifies it as `xaml::GridUnitType::Star`, matching the existing Calendar implementation, and reruns both platform gates. The original tag and failure log are retained.

## Two-column native replies — included in beta.37

Reply/Reply All and reopened reply drafts now show an editable left pane and independently scrolling previous messages on the right. macOS sheets widen to 1,180 points, bounded by the screen; new/forward sheets widen to 740. Windows widens the composer page to the same sizes and stacks reply panes below 900 points of available width. Existing owner binding, draft/save/send review, Bcc and uncertain/scheduled delivery guards remain in their original paths.

The shared read-only history endpoint uses the explicit connected mailbox and original ID, reads the original plus up to 20 `replyToId` ancestors from the same SQLite account, and returns plain text without HTML or Bcc. It includes quoted text, marks cycles/missing ancestors/limits, and does no provider/model work or read-state mutation. It does not reconstruct complete provider conversations. Rust checks cover duplicate IDs/forged stored account metadata, cycles, missing/cross-account ancestors, the limit, disconnected/combined/missing owner, authenticated HTTP routing and unchanged read state. Native checks cover wider new/reply/saved-reply/forward layouts, account-owned original content, independent Windows scroll panes and wide/narrow positioning.

Local formatting, strict all-target Clippy, all 187 locked Rust tests, macOS packaging, deep/strict ad-hoc signature/plist verification and full production-service native acceptance passed. In a separate hardcoded fictional workspace, CUA opened a production-service message, opened Reply, edited its text while reading the right pane, saved locally and reopened Edit Draft. The wider split layout, retained edited body, original-account history and fixed action bar were visible. The test app was quit and its process exited; the owner's original installed process remained running. No real mail/calendar/model request or installed-app replacement was performed. The beta.37 tagged Windows walkthrough subsequently passed all three runs, as recorded above. This new walkthrough does not establish complete pointer-drop or live-provider acceptance.

## macOS draggable-row click and data type — included in beta.37

The owner reported that macOS rows could start dragging but clicks did not open mail and sidebar drops did not move it. Native inspection found `UTType("com.morrowmail.mail-row")` returned nil and SwiftUI's actual `_PlatformDraggingDestinationView` registered only `public.data`/`public.item`. The macOS package now exports the custom type with data conformance. Mail rows explicitly select on tap and carry their List identity outside the drag/context modifiers. The existing provider Move review, opaque own-process payload and account/connection/destination guards remain unchanged.

The production MailWorkspace fixture uses native AppKit mouse-down/up events to click two fictional messages with duplicate provider IDs across accounts and verifies each reader identity/owner. Its first setup lost a search fixture to the Search view's normal startup reset; supplying the fixture's cached messages corrected the setup without relaxing assertions. The standalone window checks pass, including existing drop guards and layout/lifecycle assertions. Packaging checks require the exported identifier and data conformance. Local strict all-target Clippy, all 186 locked Rust tests, candidate packaging/signature/plist and complete production-service native acceptance passed. Beta.37 tagged paired/public-download evidence is recorded above.

CUA element and coordinate clicks in a separate beta.35 fictional-mail app opened the correct production-service reader bodies. The system now reports the custom UTType as declared and conforming to data. A separate instrumented source copy recorded drag-start with navigation/loading/provider/owner/view-ID guards valid, but the CUA attempts did not produce a target/drop callback; complete pointer-drop acceptance remains unverified. After Quit, the desktop tool automatically relaunched the first test companion without its environment; the existing owner workspace writer lock blocked that startup. It was closed, the installed app's original process remained running, and the diagnostic copy hardcodes the marked fictional workspace to protect automatic relaunches. No owner/provider writes were observed. Both fixture processes were closed. No installed app was replaced, and full live-provider acceptance remains outstanding.

## 0.6.0-beta.34 — published paired native release

[Beta.34](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.34) was published at 2026-10-01T21:00:13Z from `8608181e5ee0a0acf2e3da6d527c29be6a438ca7`. [Tagged CI 36922428951, attempt 1](https://github.com/Coke1120/Morrow-Mail/actions/runs/36922428951/attempts/1) passed all three jobs: Node-free Rust formatting, strict all-target Clippy and locked tests on both platforms; macOS packaging and production-service native acceptance; Windows packaging, the complete fresh/owned/restart native walkthrough including drag guards, folder drop registration, reader and Search controls, and the 1,000/10,000/50,000-message fictional-mail benchmark; and the existing paired publisher's same-run/same-attempt provenance and signing gate. No waiver applied.

All six public assets were downloaded and matched their GitHub sizes and SHA-256 digests. Both public ZIPs and checksum files are byte-identical to this tag run's candidates. Bundled versions, ZIP integrity/path checks and exact checksum files passed; the manifest's Ed25519 signature verified against the unchanged pinned public key. The identical macOS app passed deep/strict ad-hoc signature verification, plist lint, its `MorrowReleaseVersion` check and an isolated `Morrow Mail 0.6.0-beta.34` service-version check. The published release body matches the committed release notes.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 12,959,697 | `ffdc15efc59876bf3c7dc6faaabfce0b576bc6f4a04ee9255ce03ac8dd60ecf4` |
| windows-x64 | 37,232,553 | `4326485585812b67a7b25fcef35f62af7b7d5777ecc069eabd2123343524d515` |

Native automated checks establish drag registration, payload validation and reviewed routing; full physical pointer-drop acceptance remains outstanding. The macOS gesture investigation below uses separate fictional fixtures, and the earlier Parallels walkthrough covers beta.30 only. This tagged run passed the unchanged Windows reader gate; its earlier intermittent controller-ready timeout remains unresolved. No owner workspace or real provider/model write was used, and installed apps were not replaced. macOS remains ad-hoc signed without notarization; Windows remains unsigned. Full live-account, clean-machine/accessibility and installed-updater restart/rollback acceptance remain outstanding. See the [release notes](docs/releases/v0.6.0-beta.34.md).

## Native mail-list to sidebar drag/drop — included in beta.34

SwiftUI uses an own-process NSItemProvider and DropDelegate; WinUI uses native DragStarting/DragOver/Drop/DropCompleted and an opaque DataPackage token. One imported message opens the existing account-owned Move review with a preselected server destination. Provider validation/permissions and confirmed writes stay on the existing server path. Gmail Move removes Inbox while preserving other labels; reviewed Spam/Trash moves are retained. Virtual/combined folders are not provider targets. Keyboard/context-menu alternatives remain available.

Native checks cover combined views with duplicate provider IDs, external/random tokens, deleted/unavailable destinations, view changes, dirty/busy/dialog guards, disconnected or replaced connections, vanished source rows and single-use review routing. Windows also checks its real DataPackage token roundtrip and row drag registration. These are native automated checks, not an end-to-end physical pointer drag or live-provider acceptance. Local rustfmt, strict all-target Clippy, all 186 locked Rust tests, macOS packaging/signature/plist and full production-service acceptance passed. The first standalone drag fixture check used a page without its required page key; correcting that fixture to use the supported search results passed without changing the production guard. [Source CI 36918113157](https://github.com/Coke1120/Morrow-Mail/actions/runs/36918113157) at `ad5c07efd5844500f0e6eb80d52f8452001d2ba3` passed both platform jobs completely, including the Windows fresh/owned/restart native walkthrough and benchmark. The tagged beta.34 checks additionally cover Outlook/IMAP routing and actual WinUI folder drop registration; publication evidence is above.

A separate macOS fictional-mail workspace opened with the candidate, read mail, filtered sidebar paths and restored cached offline folder names. Three CUA pointer drag attempts did not visibly open the review; no successful end-to-end physical drag is claimed and its input/control cause remains unverified. The fixture was closed without provider writes or installed-app replacement.

**Gesture follow-up / withdrawn beta.33:** a separate instrumented SwiftUI package/bundle (outside Git and production packaging) confirmed that the original row received no drag callback. Adding an explicit rectangular hit area received `drag-start` with navigation/source/owner guards valid. The shipping row now has that hit area. A minimal standard-text SwiftUI fixture received drag-start but the desktop tool did not finish its drop, leaving a drag session requiring Escape before Quit. Full physical drop acceptance remains unverified; no provider writes occurred. The fixture processes were closed.

Tagged beta.33 [CI 36919999915](https://github.com/Coke1120/Morrow-Mail/actions/runs/36919999915) was cancelled before publication so the row fix could be included in beta.34. Its macOS job passed completely and its Windows job reached native walkthrough; it is not paired release acceptance. The release job did not publish and the tag is preserved. Beta.34 passed all tagged paired gates with the fix and expanded native guards, as recorded above.

## All-downloaded automatic indexing — included in beta.34

Both native Search pages make explicitly reviewed automatic indexing the main action, expose approved account/folder/content/history choices, and collapse daily/batch limits and manual maintenance. New configurations default to All downloaded mail; older explicit ranges and implicit three-month scopes remain unchanged until reviewed expansion. Progress separates size/per-message-budget/individual-chunk daily-limit exclusions from temporary daily-budget waits. Pause preserves valid vectors, chunk checkpoints and unsaved scope edits. Bounded automatic requests can finish a message across UTC daily resets without resending completed chunks; failed or uncertain requests still require review.

Local formatting, strict all-target Clippy and the complete 186-test locked Rust suite passed. The 16 semantic-search tests include all-history retrieval, old-scope preservation, expansion invalidating approval, cross-account duplicate-ID isolation, changed-text reuse, positive but insufficient remaining allowance, durable daily usage, pause/continue checkpoints and cross-day completion without duplicate chunk requests. The macOS candidate built successfully and passed deep/strict ad-hoc signature verification, plist lint and production-service native acceptance, including model/history labels, reader isolation, lifecycle guards, Settings refresh, account routing, encrypted restart persistence and backup. Windows smoke checks assert the all-downloaded value, primary automatic action, collapsed technical limits and unsaved history edits surviving polling.

[Initial source CI 36907725674](https://github.com/Coke1120/Morrow-Mail/actions/runs/36907725674) for `92b5740e0e1fd33ebc30c84c5a18c27d972b81f3` passed macOS completely and Windows Rust checks/packaging/fresh smoke, but the owned walkthrough failed reader `initial-document` at the unchanged 25-second total deadline before reaching Search. The obsolete run's subsequent benchmark was cancelled to retrieve failure evidence; no benchmark or owned/restart acceptance is claimed for that run. The intermittent reader initialization cause remains unresolved.

[Checkpoint source CI 36910939211](https://github.com/Coke1120/Morrow-Mail/actions/runs/36910939211) at `ad48c1c2bb4d942631f6caa248b1859678b70ebc` passed both platform jobs completely, including Windows packaging, the complete fresh-owned-restart walkthrough with new Search controls and unsaved-edit polling checks, and the 1,000/10,000/50,000-message benchmark. Local native acceptance also passed again. The semantic-search regression covers increasing the daily allowance without discarding waiting chunk checkpoints. A final shared update guard requeues running or paused automatic work when reducing the allowance, preserves completed mail vectors and revokes approval until explicit review, avoiding impossible chunks and unapproved paid replay. Both states pass the regression, strict Clippy and the repeated 186-test suite; the final macOS candidate also passes packaging, signature/plist checks and native acceptance.

[Final source CI 36913332820, attempt 1](https://github.com/Coke1120/Morrow-Mail/actions/runs/36913332820/attempts/1) at `6aaada411fbbc0cb0d9070bcd4e0f01ee45253c1` passed both platform jobs completely: Node-free formatting, strict all-target Clippy and locked Rust tests; native packaging; macOS production-service acceptance; Windows complete fresh-owned-restart walkthrough including reader and new Search controls/polling checks; and the 1,000/10,000/50,000-message benchmark. The reader gate remains unchanged, the initial failure above remains recorded, and no waiver or release publication applied.

These changes first ship in beta.34 and retain semantic retrieval's 12,000-chunk/four-million-vector-scalar bound. The source CI runs above did not publish a release; beta.34's paired publication evidence is recorded at the top. Tests use isolated fictional mail and loopback model fixtures, not owner data or real paid models; installed apps were not replaced.

## 0.6.0-beta.32 — published paired native release

[Beta.32](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.32) was published at 2026-10-01T17:36:31Z from `5697f5ee092cb70aaafdb843497af2baa2d12b9a`. [Tagged CI 36897221096, attempt 1](https://github.com/Coke1120/Morrow-Mail/actions/runs/36897221096/attempts/1) passed all three jobs: Node-free Rust formatting, strict all-target Clippy and locked tests on both platforms; macOS packaging and native production-service acceptance; Windows packaging, complete fresh/owned/restart walkthrough including reader and searchable picker checks, and the 1,000/10,000/50,000-message fictional-mail benchmark; and the existing paired publisher's same-run/same-attempt provenance and signing gate. No waiver applied.

All six public assets were downloaded and matched their GitHub sizes and SHA-256 digests. Both public ZIPs and checksum files are byte-identical to this tag run's candidates. Bundled versions, ZIP integrity/path checks and exact checksum files passed; the manifest's Ed25519 signature verified against the unchanged pinned public key. The identical macOS app passed deep/strict ad-hoc signature verification, plist lint, its `MorrowReleaseVersion` check and an isolated `Morrow Mail 0.6.0-beta.32` service-version check. The published release body matches the committed release notes.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 12,932,766 | `10897fe100f3a39f8569068cf3ea2b3f0552e34968d794bc5f8bf83249ff9114` |
| windows-x64 | 37,197,971 | `384f83a62b7e6df00c26a7c7dca42f29b518f39c6323a230cd45a078c8a45b5c` |

The pre-tag walkthrough below is source validation, not a complete manual walkthrough of these tagged binaries. This first-attempt tagged run passed the Windows reader gate; the earlier intermittent controller-ready timeout's cause remains unresolved. No owner workspace or real provider/model write was used, and installed apps were not replaced. macOS remains ad-hoc signed without notarization; Windows remains unsigned. Full live-account, clean-machine/accessibility and installed-updater restart/rollback acceptance remain outstanding. See the [release notes](docs/releases/v0.6.0-beta.32.md).

## Whole-app scenario walkthrough

See the [walkthrough matrix](docs/WALKTHROUGH-2026-10-01.md) for separate manual, native automated, provider-fixture and outstanding checks. macOS manual checks covered owned/combined reading, Pending, paging/search, owner-bound Reply All, Bcc/Chinese draft persistence, cached offline folder manager/search/Parent popup, failed review retention, Today review/cancel and Calendar's disconnected state. Actual Parallels fresh smoke passed; its owned picker check failed. The fixed 50 ms test sleeps now wait for the expected native list state within a bounded deadline. The original assertions remain; a corrected VM retest is still outstanding.

Follow-up macOS operation of source `bfd42f3` also checked sidebar Chinese/no-match search without changing the mail page, the corrected provider error in the manager, missing-editability protections, Create child parent selection, Escape, offline child review retaining both inputs, Calendar Previous month/Today, Reply Suggestions identity guidance, unsupported IMAP Out of Office, missing/paused AI, Outbox empty state and system window zoom/restore. Settings again lost the desktop tool's native pipe; manual unsaved-Quit acceptance also remains unverified because menu input/capture failed.

The walkthrough also found IMAP TCP failures incorrectly using the workspace I/O message. The shared connection path now returns a safe provider failure, with a loopback refusal regression for normal/management catalogs. Local rustfmt, strict all-target Clippy, all 14 IMAP tests, the complete 184-test serial and final default parallel Rust suite and production-service macOS native acceptance passed. Repeated parallel CLI fixture handoff failures were diagnosed as a briefly retained seed lock after Store closure. The shared test initializer now confirms writer-lock release before returning, with a two-second bound; 30 consecutive parallel CLI runs (90 test executions) and the full default parallel suite passed. Production writer and write-retry guards are unchanged. Desktop tooling later lost guest input and then reported a closed native pipe despite reset; remaining manual paths are explicitly unverified. No live mail/calendar/model write, installed-app replacement or release publication occurred.

Both fixes passed complete paired source CI ([picker 36882998703](https://github.com/Coke1120/Morrow-Mail/actions/runs/36882998703), [IMAP 36885865259](https://github.com/Coke1120/Morrow-Mail/actions/runs/36885865259)). Final source `bfd42f3` passed macOS and both platforms' Rust checks, but [36889386605 attempt 1](https://github.com/Coke1120/Morrow-Mail/actions/runs/36889386605/attempts/1) failed Windows owned reader isolation at the unchanged 25-second controller-ready gate; its fresh smoke and service benchmark passed. Owned/restart acceptance did not. [The same-source Windows rerun, attempt 2](https://github.com/Coke1120/Morrow-Mail/actions/runs/36889386605/attempts/2), passed Rust checks, packaging, complete fresh/owned/restart walkthrough including reader/picker checks, and the 1,000/10,000/50,000-message benchmark. The overall source run passed with the retained macOS result; no waiver or publication applied. The original failure remains recorded and the intermittent reader initialization cause is unresolved despite that successful rerun.

## Searchable label/folder management — included in beta.32

Both native clients now use account-scoped cached catalogs for hierarchy management and searchable destination/parent pickers. The Gmail message checklist applies only explicit add/remove deltas in one provider request; Outlook/IMAP retain single-folder moves. Create-from-email separately reviews creation and subsequent message assignment. Provider catalog validation, single-use folder reviews, protected folders, write permissions and uncertain-write handling remain enforced. Safe manager metadata is projected separately from selectable sidebar destinations; connection secrets remain private.

Local Rust formatting, strict all-target Clippy and the full locked test suite passed. The macOS candidate build and native production-service acceptance passed, including the new cached hierarchy/create/checklist layout checks, hierarchy cycle/orphan checks, reader isolation, lifecycle guards and persistence. The new Gmail fixture checks single-write deltas, custom-label validation, Inbox/system-label preservation, duplicate-ID account isolation, Pending and local folder overrides. WinUI smoke opens a real searchable picker and waits for native events before checking case-insensitive full paths, selection retention, hierarchy/parent exclusion and label deltas.

Initial Windows compilation caught the shared error formatter's anonymous namespace and a smoke declaration using the wrong Grid namespace; both are corrected. The original formatter is shared without duplication. [Source CI 36870555027](https://github.com/Coke1120/Morrow-Mail/actions/runs/36870555027) at `dbe292095444bc3470ed87eae9c5939f97eaff24` passed both platforms' Rust checks, macOS packaging/acceptance and Windows packaging. Both Windows attempts passed the new folder checks and fresh onboarding, then timed out at the existing WebView2 reader controller-ready gate (25-second total deadline) in the owned fixture; their remaining benchmarks were cancelled. The new popup smoke had run before the existing first-reader measurement. It now runs afterward, waits for the Flyout's Closed event and restores original focus before removing its temporary control. No timeout or reader security gate has been weakened.

[Corrected source CI 36876489218](https://github.com/Coke1120/Morrow-Mail/actions/runs/36876489218) at `4930d1d259bc79d8881de8c3dc7bc207656b8440` passed both platform jobs completely: Node-free Rust formatting, strict all-target Clippy and locked tests; macOS packaging and production-service acceptance; Windows packaging and the complete fresh/owned/restart native walkthrough, including reader isolation and the new picker/hierarchy checks; and the 1,000/10,000/50,000 fictional-mail benchmark. No test waiver or new publication applied.

No real-account writes or installed-app replacement are used. These changes first ship in the beta.32 public packages, with paired tagged evidence above. The earlier complete Parallels walkthrough covers beta.30; the pre-tag source candidate's partial VM attempt and failure are recorded in the walkthrough matrix above.

## 0.6.0-beta.31 — published paired native release

[Beta.31](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.31) was published at 2026-10-01T08:58:51Z from `7ae973385ba09ed5f3735fe799d100d9fddc25c7`. [Tagged CI 36837100716](https://github.com/Coke1120/Morrow-Mail/actions/runs/36837100716) passed all three jobs: Node-free Rust formatting, strict all-target Clippy and locked tests on both platforms; macOS native packaging/acceptance; Windows packaging, fresh/owned/restart UI, reader/persistence checks and fictional-mail benchmark; and the existing paired publisher's same-run/same-attempt provenance and signing gate. Both native startup and Settings-refresh folder-cache regressions passed. No test waiver applied.

All six public assets were downloaded and matched their GitHub sizes and SHA-256 digests. Both public ZIPs are byte-identical to this tag run's candidates. Bundled package versions, ZIP integrity/path checks and checksum files passed; the manifest's Ed25519 signature verified against the existing pinned public key. The identical macOS app passed deep/strict ad-hoc signature verification, plist lint, its `MorrowReleaseVersion` check and an isolated `Morrow Mail 0.6.0-beta.31` service-version check.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 12,835,214 | `711331a58644c5301e94670db01e4bdcdf7ee76bdff0993816e96decf0f9e74d` |
| windows-x64 | 37,130,736 | `a5ea8337c9fb2e9dc5549a5afbc4e667ed692f3fcdfa60b5741da1f286b3d700` |

No owner workspace or real provider/model write was used, and installed apps were not replaced. macOS remains ad-hoc signed without notarization; Windows remains unsigned. Full live-account, clean-machine/accessibility and installed-update walkthrough acceptance remain outstanding. The earlier Parallels walkthrough below covers the unchanged public beta.30 only. See the [release notes](docs/releases/v0.6.0-beta.31.md).

## Automatic local folder catalogs — included in beta.31

Both native clients restore each connected account's Gmail labels or Outlook/IMAP folders from encrypted local settings without mandatory Browse/Refresh. The service discovers new/reconnected accounts with a five-second metadata worker and refreshes successful catalogs every 15 minutes, independently of the mail-download schedule. Offline failures retain saved names; transient reads and recognized quota responses use persisted backoff, while authorization/malformed responses stop automatic retries. Fresh provider catalogs, permission checks and confirmation remain required for mutations. This change does not add a complete historical mail or attachment mirror.

Local Rust formatting, strict all-target Clippy and the full locked suite passed. The isolated TLS metadata check covers automatic read-only fetch, duplicate folder IDs across owners, nested Outlook names, encrypted persistence/restart, observational state/Activity reads, retained offline names, daily-quota pacing, authorization/malformed blocking, fresh retry state after reconnect and disconnect isolation. The Node-free macOS candidate passed production-service native acceptance, deep/strict ad-hoc signature verification and plist lint. Native startup restores both fictional owner catalogs; Settings status refresh restores catalogs while preserving unsaved edits, rows, page and selection. The published beta.30 binaries and their Parallels walkthrough below predate this change. No owner workspace or real provider/model write was used.

[Initial source CI 36832274425](https://github.com/Coke1120/Morrow-Mail/actions/runs/36832274425) passed both platforms' Rust checks, macOS packaging/acceptance and Windows compilation; the Windows startup assertion failed because its separate `native_fixture` seed omitted folder catalogs. That seed now includes fresh fictional catalogs and verifies both accounts' names after restart; its local read through the production service and clean shutdown passed.

[Corrected source CI 36834094398](https://github.com/Coke1120/Morrow-Mail/actions/runs/36834094398) at `0e66d1c2fa82fdfa8172a351f6af707cb5cc7c62` passed both platform jobs completely: Node-free Rust formatting, strict all-target Clippy and locked tests; native packaging; macOS production-service acceptance; Windows fresh/owned/restart UI, reader and persistence checks; and the fictional-mail benchmark. Windows startup and Settings refresh restored the owning local catalogs without Browse/Refresh, and the fixture verifier retained both accounts' names after restart. No test waiver or new publication applied. This source change has automated Windows acceptance; the earlier Parallels walkthrough below remains evidence for the unchanged public beta.30 binaries only.

## 0.6.0-beta.30 — published paired native release

[Beta.30](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.30) was published at 2026-10-01T05:40:54Z from `09fa9f3087dbcc3dad9c019be6de88b80462ebd2`. [Tagged CI 36819009935](https://github.com/Coke1120/Morrow-Mail/actions/runs/36819009935) passed all three jobs: Node-free Rust formatting, strict all-target Clippy and locked tests on both platforms; macOS native packaging/acceptance; Windows packaging, native UI/persistence/reader checks and the fictional-mail benchmark; and the existing paired publisher's same-run/same-attempt provenance and signing gate. Sidebar width/filter, settings-refresh and macOS update-quit regressions passed. No test waiver applied.

All six public assets were downloaded and matched their GitHub sizes and SHA-256 digests. Both public ZIPs are byte-identical to this tag run's candidates. Bundled package versions, ZIP integrity/path checks and checksum files passed; the manifest's Ed25519 signature verified against the existing pinned public key. The identical macOS app passed deep/strict ad-hoc signature verification and plist lint; its service returned `Morrow Mail 0.6.0-beta.30` with `--version` in an isolated environment.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 12,733,816 | `2ede1af24d3ce0fed86e29d49a4a3518d81eb00e89db37bf0ee9262611fccb06` |
| windows-x64 | 37,090,893 | `5db0ca7e92a78cf256c91ea0c4a0ccabee3407d2915adf37746bee2d3ece1c9d` |

Corrected source CI [36817309691](https://github.com/Coke1120/Morrow-Mail/actions/runs/36817309691) at `6b8527989c16d70947c57bf2a151dcd8f2ead4a0` also passed both platform jobs completely. The final shared IMAP create-path correction uses the chosen parent's namespace delimiter; its planner/cache check and strict Clippy passed locally and in the tagged suite. The local checks below record earlier source candidates; the paired tagged evidence above establishes beta.30 packaging and automated execution on both platforms.

No real mail/calendar/model write or owner workspace was used. Installed apps were not replaced. macOS remains ad-hoc signed without notarization; Windows remains unsigned. Full live-account, clean-machine/accessibility and real installed-update walkthrough acceptance are outstanding. See the [release notes](docs/releases/v0.6.0-beta.30.md).

## Beta.30 Windows walkthrough in Parallels — 1 October 2026

The unchanged public Windows x64 ZIP above was extracted into a fresh Windows temporary directory and exercised in Parallels Desktop / Windows 11 from 05:55–07:05 UTC. Fresh onboarding and a separately marked fictional two-account workspace used absolute isolated `MORROW_DATA_DIR` paths. The owner explicitly authorized Windows UI Automation / native input after the Parallels CUA mouse bridge proved unreliable. Observations below use Windows-rendered captures and accessibility state; they supplement the tagged CI rather than establish live-account acceptance.

- Fresh launch showed Add your first account without visible Demo navigation. The owned fixture displayed 130 Inbox messages, 64 unread and one draft. Today rendered **Summarize now**; invoking it respected saved paused AI permissions and displayed the permission error without generating a report.
- Inbox/Starred sidebar filtering and clearing retained the selected mailbox, page 1 and opened fictional message. **View → Wider sidebar** added 60 logical pixels; the divider's Right arrow added 20. Width 310 persisted after clean close/reopen. Dark theme auto-save also survived restart.
- General, Mail accounts and Calendar settings rendered. An unsaved fictional address remained after more than seven seconds of connection-status polling. Leaving the form showed the discard review: Cancel retained the edit, and Discard allowed the Calendar category to open.
- The folder-management entry was reachable by keyboard. Its fictional IMAP catalog request ended with a public error; no provider folder or message mutation was performed. No matching Application Error event (ID 1000) for this temporary app/service was found during the run. The isolated UI and Rust service both exited normally, restarted successfully, and were closed again afterward.

Native drag attempts did **not** change sidebar width in this walkthrough. The cause has not been isolated between guest input automation and the control; drag acceptance remains open despite the passing menu/keyboard paths. This run does not establish successful full summary generation, browser OAuth refresh, live folder/message CRUD, clean-machine/accessibility coverage or an installed updater walkthrough. No owner data, real account or paid model was used; private captures, fixture stores and test helpers remain ignored build output.

## Provider hierarchy management and sidebar — included in beta.30

Both native clients add create, rename, delete and move-to-parent actions for custom Gmail labels and Outlook/IMAP folders. The local service prepares and revalidates the owning provider catalog, requires write permission and explicit confirmation, consumes account/connection-bound reviews once, protects system IDs/special-use folders, and never retries provider writes. Provider-specific delete impact appears in the review. Gmail subtree changes are limited to 50 labels per review and can partially apply. Confirmed changes retain cached identities, local overrides, Pending and drafts and reconcile import traversal descriptors, including IMAP page paths and deleted entries. Sidebar name filtering reads loaded names locally and keeps the current mailbox/message. Windows adds a bounded persisted drag/keyboard sidebar divider and full-name tooltips; both context menus preselect the existing reviewed message move.

Isolated TLS Gmail/Graph API checks passed for all four operations, protected localized system IDs, no-write previews, missing/combined and cross-account owner rejection, absent confirmation, stale catalog/connection rejection, single-use review, read-only permission rejection before provider discovery, response loss with one write and retained cached mail. IMAP protocol checks passed for modified UTF-7, special-use protection, control-character rejection, pre/post UIDVALIDITY and failed-write no replay. The pure planner/cache check covers cycles, collisions, reserved names, implicit parents, cross-namespace rejection, Gmail's subtree limit, duplicate IDs across owners, local overrides, Pending and paused import checkpoints. The complete locked Rust suite and Node-free strict all-target Clippy passed locally. The final Node-free macOS candidate passed native production-service acceptance, deep/strict ad-hoc signature verification and plist lint. [Initial source CI 36816248728](https://github.com/Coke1120/Morrow-Mail/actions/runs/36816248728) passed macOS completely and both platforms’ Rust checks; Windows compilation caught unsupported WinRT hstring += concatenation in the folder review. The one-line correction uses the existing immutable-string concatenation pattern. Corrected source CI and tagged CI passed the Windows build, native UI checks and benchmark; publication evidence appears above. No real mailbox or provider/model write was used; live-account, clean-machine and full accessibility acceptance remain outstanding.

## macOS Install & Restart quit — included in beta.30

The native update action previously requested termination while its SwiftUI Settings sheet was still open; AppKit could ignore the request, leaving the installer waiting for a manual Quit. After authenticated installer preparation succeeds, current source dismisses Settings and waits for its actual `onDismiss` callback before terminating. Ordinary Settings dismissal remains inert, and the existing window-close, unsaved-edit, active-write and service-shutdown guards are unchanged.

The added runnable `UpdateRestartAssertions` fixture uses the production AppModel and app/window delegates with a fresh isolated workspace and the production Rust service. Only the install-ready HTTP response is fictional; its native review is approved by a fixture timer. It verifies automatic process exit and service shutdown with an attached Settings sheet and disabled interactive dismissal. The original/immediate-quit flow failed this fixture; dismissal completion passes, including with the original window guard. Full Node-free native acceptance passed, including the new regression, ordinary close/reopen, unsaved/write guards, reader isolation, settings refresh, account routing, encrypted restart persistence and backup. Rust formatting, strict all-target Clippy and all three signed-helper download tests passed: native extractor cancellation, active indexing/calendar gates, both-PID waiting, installation and failed-start rollback. Those helper tests use generated signing keys and temporary apps. No owner workspace, mail/calendar provider or model was used; a real signed installed-app update walkthrough is not established by these fixtures.

The local source candidate built with `/bin/sh scripts/build-macos-native.sh` without Node on PATH and passed deep/strict ad-hoc signature verification, plist lint and its then-current beta.29 service-version check. The earlier `dsymutil` packaging stall did not recur. The tagged beta.30 package subsequently passed the full native checks and public version/signature verification above. Windows updater code is unchanged. No installed app was replaced or used for a real update walkthrough. An older installed macOS version may still need one manual Quit for this upgrade; subsequent update quits use the fix.

## Settings connection refresh — included in beta.30

Mail accounts and Calendar settings automatically refresh local connection metadata every three seconds while open (macOS while active), including after browser OAuth return. IMAP saves and reviewed disconnects refresh status directly. Read-only refresh updates connection/history displays without replacing credential forms, unsaved preferences, the selected mailbox or mail paging; it does not fetch provider calendars, sync mail or invoke AI. Manual refresh remains available. Windows Settings lifetime follows navigation generation so a background/OAuth selection change retains the form and its captured request owner.

The final Node-free macOS candidate build, plist lint and deep/strict ad-hoc signature verification passed, including the follow-up that clears refresh errors before the settings-tab guard. Full native production-service acceptance passed, including the added connection-refresh regression: account/calendar metadata updates while unsaved settings, selected owner/message, mail paging and persisted revision remain intact. Windows automatic-refresh checks with unsaved credentials and a background owner change passed in corrected source CI and tagged CI; local execution through `prlctl exec` was unavailable at that stage. The later public-ZIP Windows UI Automation walkthrough above adds local visual/interaction evidence with its stated limits. An additional isolated SwiftUI walkthrough was attempted; the UI automation native pipe closed before inspection, so no settings visual/interaction acceptance is claimed. No real-account OAuth or provider/model call was used. Paired beta.30 publication evidence appears above.

## Today polish and immediate summaries — included in beta.30

Both native Today pages add **Summarize now**, clearer downloaded-mail totals, report headings/status and empty-state guidance. The action reviews one connected mailbox, permitted message metadata and the saved model/endpoint, then immediately generates a durable P0–P4 report through the existing summary claim/generate/finish pipeline. Automatic triggers may remain off. Preview IDs are account-bound and single-use; permission, model, connection and source changes revoke the review or discard its result. Manual generation preserves the automatic schedule, does not sync providers and never automatically retries a paid failure. Failures remain visible and require another review.

Local Rust formatting, strict all-target Clippy and the complete locked Rust suite passed. The owned manual-summary regression also passed after final response/error handling changes: missing/combined/disconnected owner rejection, unchecked metadata redaction, no model call during preview, duplicate provider IDs, global-view independence, consumed/cross-account preview rejection, source/reconnect/permission changes, unchanged schedule, failed-call no-retry and restart persistence. The SwiftUI candidate built without Node on PATH; native production-service acceptance covers model/calendar/window/reader isolation, account routing, drafts, encrypted persistence and backup. An isolated SwiftUI fixture with in-memory fictional API responses exercised **Summarize now → preview → Generate summary → On-demand summary / Completed** and visually checked the native review/report layout. This fixture made no real model/provider call and did not use the owner's workspace.

Windows source and smoke coverage were updated for the action and individual-mailbox selector and passed corrected source CI and tagged CI. Local execution through `prlctl exec` was unavailable at that stage because the installed Parallels edition does not support it. The later public-ZIP walkthrough above exercised the Windows Today page and paused-permission guard through authorized UI Automation/native input. Paired beta.30 publication evidence appears above; installed apps were not replaced. macOS remains ad-hoc signed; fixture results do not establish live-account, clean-machine or complete accessibility acceptance.

## 0.6.0-beta.29 — published paired native release

[Beta.29](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.29) was published at 2026-09-30T18:31:03Z from `22e3981c3b53ef1840a9e8f7ea1a1414a1c616f7`. [Tagged CI 36756188638](https://github.com/Coke1120/Morrow-Mail/actions/runs/36756188638) passed all three jobs: Node-free Rust formatting, strict Clippy and tests on both platforms; macOS native packaging/acceptance; Windows packaging, native UI/persistence/reader checks and fictional-mail benchmark; and the existing paired publisher's same-run provenance/signing gate. No test waiver applied.

All six public assets were downloaded and matched their GitHub sizes and SHA-256 digests. Both public ZIPs are byte-identical to this tag run's candidates. Their versions, ZIP integrity/path checks and checksum files passed; the manifest's Ed25519 signature verified against the existing pinned public key. The identical macOS candidate passed deep/strict ad-hoc signature verification and plist lint; its service returned `Morrow Mail 0.6.0-beta.29` with `--version` in an isolated environment. The Parallels visual checks below used the same Windows code before the documentation-only release preparation commit.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 12,438,463 | `3456b72c4511a807230703805dc54f673ffd992eb583406b0cf417c9bf99eceb` |
| windows-x64 | 36,679,786 | `f030879b7cabaf99152253bbda201271adea5405ce5dfa3002dd70a0aeff6c31` |

The release includes Windows contrast/layout fixes, one-minute provider Trash undo, the default send delay and server label/folder browsing. Automated and visual acceptance used isolated fictional workspaces. Complete live-account, clean-machine and accessibility acceptance remain outstanding. macOS is ad-hoc signed without notarization; Windows is unsigned. Installed apps and owner workspaces were not replaced. See the [release notes](docs/releases/v0.6.0-beta.29.md).

## Windows theme and layout — beta.29


The macOS/Parallels comparison of the same fictional mailbox found an unpainted Windows root under transparent/translucent NavigationView surfaces. Dark changed foregrounds while leaving a white pane and light-grey content. The root now binds an opaque built-in theme brush; high-contrast resources remain untouched. Native smoke switches Light/Dark and checks the actual root brush alpha/colour. Inbox branding, search order, right-aligned Sync, centred paging and the shared empty-reader envelope follow the macOS design. The same empty view is used when provider Trash clears selection. Outbox uses the macOS heading, horizontal mailbox/Refresh row and empty copy; its scheduling guidance remains visible.

Local Rust formatting, strict all-target Clippy and the complete locked Rust suite passed. The macOS beta.29 candidate built and passed production-service native acceptance, deep/strict ad-hoc signature verification and plist lint. [Paired source CI 36751561649](https://github.com/Coke1120/Morrow-Mail/actions/runs/36751561649) passed both jobs at `5bc8b65bde108ae550a99f463bbd4e1f8b2dd2dc`, including Windows packaging, native UI/persistence/reader checks, the new theme-background regression and the fictional-mail benchmark. The downloaded Windows candidate passed checksum and ZIP integrity checks. In Parallels Windows 11, its isolated fictional mailbox passed Light → Dark switching, readable Settings/Inbox/Outbox/Compose, owner retention, the empty-reader envelope and Sync/paging alignment. Dark persisted across app restart. No mail was sent; the blank composer and test app were closed, no candidate Application Error event was found, and Parallels returned to its original window mode. Cropped native screenshots remain private generated evidence. Tagged paired validation and public asset verification passed, as recorded above. This is not complete visual/accessibility, clean-machine or live-account acceptance. The prior macOS Settings computer-use failure was a crash in the automation helper; the app remained alive. Test stores and captures remain private generated files.

## Global delay and server folder browsing — included in beta.29

Native Settings accepts an auto-saved default send delay of 0–6 hours (0 means immediate). Compose captures a reviewed future time and submits through the existing idempotent scheduled-send API; custom schedules override the default. Both clients expose per-mailbox Outbox entries and exclude completed/cancelled jobs from that list. The shared queue retains frozen recipients/Bcc/footer, draft locks, connection checks, 15-minute late grace and uncertain-send recovery. Native Compose uses the preference; explicit immediate API/CLI sends are unchanged.

The existing provider folder API is now reachable from native navigation. Gmail user labels and Outlook/IMAP server folders filter local pages and search by actual provider IDs, preserving multi-label membership and account isolation. Read-only label/folder discovery no longer requires provider-write permissions or IMAP MOVE/UIDPLUS; organization still enforces them. These views show downloaded mail, not a full server mirror. Resource size/hash and catalog provenance were updated only for the new preference; the pinned update key and OpenCC data are unchanged.

Local locked Rust tests, strict all-target Clippy and rustfmt passed. The new owned regression covers delay bounds/default, unchanged reviewed times and Bcc/footer across preference edits, cancellation/unlocking, provider-ID pages/search, duplicate IDs, multi-label membership and rejection of combined-account provider views. Existing TLS provider checks now verify read-only Gmail/Outlook folder catalogs and IMAP listing without move capabilities while retaining write rejection. The macOS build, resource validation, deep codesign/plist checks and full native fixture acceptance passed. [Paired source CI 36722733537](https://github.com/Coke1120/Morrow-Mail/actions/runs/36722733537) passed both native jobs at `39382b18a0081242dc0a742e26337c46cc34ec30`, including Windows packaging, fixture walkthrough, persistence/reader checks and fictional-mail benchmark. The native Windows composer guard also verifies that the global delay selects reviewed scheduling while an uncertain delivery retains explicit retry review. This was an untagged source run; the publisher did not run. Fixture checks do not establish live-account acceptance.

The same Windows candidate (`02651acead14797aeb02092a54dddd4940c7496be74fd009a9efa9c4935f7ead`) passed checksum/ZIP integrity checks and a Parallels Windows 11 walkthrough in a new absolute temporary workspace copied from the closed fictional fixture. General Settings showed Immediately by default, auto-saved 6 hours, and retained it across restart. Native Compose displayed Review & Send Later, reviewed the owning From/To/Cc/Bcc and a time six hours ahead, and queued the message in Outbox. Restart retained that queue; changing the preference back to Immediately left its exact reviewed UTC time unchanged. Cancel Schedule removed the job from the awaiting list, and its original-owner draft reopened with unchanged To/Cc/Bcc, subject and body, enabled Save Draft and the immediate Review & Send action. The candidate was normally closed and Parallels returned to window mode. No real mail was sent or real calendar event created. Live provider-folder UI acceptance remains outstanding; TLS fixtures and local page/search checks establish only the tested catalog/membership behavior.

## One-minute Trash undo and Windows alignment — included in beta.29

The row Trash button now writes directly to the owning provider without the two modal reviews. The native Undo button and ⌘Z / Ctrl+Z restore the latest confirmed move within 60 seconds, with older moves available newest-first until their own expiry. Text fields retain text undo. Rust keeps the original destination, connection and a single-use token privately; caller-supplied destinations are ignored. Expiry, reconnect, another move or a consumed/uncertain undo cannot replay a write. App shutdown ends the shortcut window; normal provider Trash recovery remains available. Gmail restore changes only Trash/Inbox/Spam placement and retains other labels; Outlook and IMAP restore the original selectable folder while keeping the local message ID stable.

Local locked Rust tests, strict Clippy and the macOS native build passed. Isolated TLS checks cover account collisions, combined/missing mailbox headers, forged destinations, local folder overrides, Gmail labels/Bin, Outlook destination IDs, expiry, reconnect, lost responses and single use; the IMAP check covers return MOVE with destination UIDVALIDITY/UID mapping. This does not establish live-account Undo acceptance.

Parallels Windows 11 ARM64 (build 26200) runs x64 candidates under emulation in separate fictional workspaces. The initial beta.28 walkthrough identified undersized high-DPI windows and clipped settings text. Current source converts saved logical sizes to physical pixels, centers and bounds them to the monitor work area, formats mail timestamps in local time using the existing calendar parser, and shows first-account onboarding before Settings. Closing preserves the saved logical size when a shorter monitor temporarily fits it; the initial candidate's Windows persistence check caught this regression.

The walkthrough found that clicking a native mail row or Settings category only changed selection. WinUI returns the Content of a ListViewItem when the item is its own container; both handlers now resolve that content to the owning row. List metadata leaves pointer selection to the native ListView while reader text stays selectable. Manual checks on candidate `75098d3` confirmed first-account onboarding, Add account opening Mail accounts, General switching its content, one-account search, local dates, Reader below persisting across restart, a clicked message opening for its owner, native text Ctrl+Z, and Ctrl+S preserving To/Cc/Bcc in an owned local draft.

Clicking the Drafts sidebar entry then terminated that candidate with Windows Application Error `c0000005` in `Microsoft.UI.Xaml.Controls.dll`. The navigation callback rebuilt MenuItems while WinUI was processing the invoked item. Current source queues that navigation after the event and retains the captured view generation and owner. Native smoke selects the actual Settings navigation item and invokes the actual mail-row automation action before validating the owner and full body; the row must complete layout first. The initial automation checks exposed an incorrect peer type and an unrealized row, both corrected before final acceptance. [Final source CI 36711214004](https://github.com/Coke1120/Morrow-Mail/actions/runs/36711214004) passed both native jobs at `1cfbcc5a789cde999a17843374924a0e893eb725`, including Node-free locked Rust checks, platform packaging, native interaction/persistence/reader checks and the Windows fictional-mail benchmark. The downloaded Windows candidate passed checksum and ZIP integrity checks. This is an untagged source check; the publisher did not run. The identical Windows candidate then passed the Parallels retest: clicking sidebar Drafts safely switched between the two fictional owners, and the saved draft reopened for `one@fixture.invalid` with its original From/To/Cc/Bcc, subject and body. No message was sent. The fixture app was closed after the walkthrough and Parallels returned to its original window mode.

These checks use fictional mail only and do not establish live-account Undo, clean-machine or full accessibility acceptance. The Windows candidate has not replaced an installed app or public release asset.

## 0.6.0-beta.28 — published paired native release

[Beta.28](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.28) was published at 2026-09-30T09:07:21Z from `14d01070aeb1a414e14aac40ec092797567ef7ba`, containing the Gmail zero-length Trash fix, safe organization diagnostics and default mail permissions in both native clients. [Tagged CI 36691497562](https://github.com/Coke1120/Morrow-Mail/actions/runs/36691497562) passed all three jobs: both platforms completed Node-free Rust formatting, strict Clippy and tests, native packaging and acceptance; Windows completed its fictional-mail benchmark; and the existing publisher verified same-run paired provenance before signing and publishing both packages. No test waiver applied.

All six public assets were downloaded and their sizes and GitHub SHA-256 digests matched. The Ed25519 manifest signature verified against the committed pinned public key; both ZIP sizes, hashes and checksum files matched the signed manifest and the inspected same-run CI candidates. ZIP integrity/path checks and bundled package versions passed. The identical macOS app passed deep/strict ad-hoc signature verification and plist lint; its service returned `Morrow Mail 0.6.0-beta.28` with `--version` in an isolated environment. Windows execution evidence comes from CI.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 12,379,813 | `1f8083f30873d4eba018ce57ff9dd61eeab4271a80efc58a9985875e5d2506cd` |
| windows-x64 | 36,620,401 | `2fbb1cdb8275c4536745f0c41d0062e802b9977fb7c4c9650b5bf75029bf0092` |

Automated acceptance used isolated fictional workspaces and provider/model fixtures. The single approved live Gmail Trash check is recorded below and does not establish complete live-account acceptance. Manual Windows visual/accessibility and clean-machine acceptance remain outstanding; macOS is ad-hoc signed without notarization and Windows is unsigned. The installed app was not replaced. See the [release notes](docs/releases/v0.6.0-beta.28.md).

## Gmail Trash HTTP 411 — local fix and one live-account check

Authorized interactive debugging observed provider HTTP 411 for a reviewed Gmail Trash operation. The shared Rust organization path now sends `Content-Length: 0` on its empty-body Trash POST. System `TRASH` identity remains independent of the displayed name; the existing isolated TLS move fixture now uses Bin and asserts the zero-length header. That regression failed before the fix and passed afterward.

Rust formatting, strict all-target Clippy and all 11 locked `mail_service` tests passed. The macOS candidate rebuilt with the existing bundled Google Desktop registration and passed `morrow-native-check`, plist lint and deep/strict ad-hoc signature verification. Fixture acceptance used separate fictional workspaces; Windows compilation/execution was not run on this host.

With explicit user approval, the updated candidate moved one identified test message on the existing Gmail connection. The native UI showed `Provider change confirmed`, removed the message from Inbox and displayed it in Trash. No OAuth reauthorization was performed for that successful check. This is narrow live Gmail Trash evidence, not complete live-account acceptance. That debugging candidate was closed afterward; the installed `/Applications` app was not replaced. Subsequent paired beta.28 publication is recorded above.

## Default mail permissions — local source verification

Both native sign-in forms now request basic read, send and organization access without a separate organization checkbox: Gmail uses `gmail.modify`; Microsoft uses `Mail.ReadWrite` and `Mail.Send`. Calendar and Out of Office consent remain explicit. Previously issued connections retain their recorded scopes until browser reauthorization; incomplete new consent is rejected before fetching mail or replacing connections.

Rust formatting, strict all-target Clippy and the complete locked Rust test suite passed. Isolated OAuth fixtures cover default scopes, legacy `organize: false` requests, partial Gmail/Microsoft grants and preservation of other accounts, cached messages and drafts after rejected reauthorization.

The updated macOS candidate built with the existing bundled Google Desktop registration and passed `morrow-native-check`, including assertions for default mail scopes, plist lint and deep/strict ad-hoc signature verification. Native acceptance used separate fictional workspaces. Windows compilation/execution was not run on this macOS host. No real mailbox/provider write, public release or installed-app replacement is included.

## Gmail Trash diagnostics — local source verification

Current source preserves safe provider HTTP status for reviewed organization failures instead of replacing every failure with the same uncertain-result message. Recognized Gmail `insufficientPermissions` responses provide same-account browser-reconnect guidance; quota errors retain their safe codes without starting write retries. Provider descriptions remain private, and failed or lost writes retain the cached messages.

Rust formatting, strict all-target Clippy and the complete locked Rust test suite passed. The added isolated TLS regression covers Gmail Trash HTTP 401/403/404/429/503 and a lost response, verifies one write per explicit attempt, preserves colliding message IDs in both accounts while the other account is selected, and rejects provider-detail/credential leaks. Existing provider move/Trash success fixtures also passed.

The macOS candidate built with the existing bundled Google Desktop registration and passed `morrow-native-check`, plist lint and deep/strict ad-hoc signature verification. Native acceptance used separate fictional workspaces. Windows compilation/execution was not run on this macOS host.

These fixture checks establish error diagnostics and cache retention, not the cause of the reported live Gmail failure or live-account deletion acceptance. No real mailbox/provider write, public release or installed-app replacement is included in this source change.

## 0.6.0-beta.27 — published paired native release

[PR #13](https://github.com/Coke1120/Morrow-Mail/pull/13) and [PR #11](https://github.com/Coke1120/Morrow-Mail/pull/11) were merged into `main` after both native jobs passed in [PR #13 CI 36664623922](https://github.com/Coke1120/Morrow-Mail/actions/runs/36664623922) and [PR #11 CI 36616429429](https://github.com/Coke1120/Morrow-Mail/actions/runs/36616429429). Their source branches were deleted after merging. Refresh now commits each bounded provider page independently and validates the captured connection before each commit. AI Studio and Settings use fewer primary choices while retaining account ownership, permissions and explicit review/save controls.

[Beta.27](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.27) was published at 2026-09-30T04:26:49Z from `e5135c88c6e49162d5412c5a24abe58cf4530cd2`. [Tagged CI 36667072161](https://github.com/Coke1120/Morrow-Mail/actions/runs/36667072161) passed all three jobs: both platforms completed Node-free Rust formatting, strict Clippy and tests, native packaging and acceptance; Windows completed its fictional-mail benchmark; and the existing publisher verified same-run paired provenance before signing and publishing both packages. No test waiver applied.

All six public assets were downloaded and their sizes and GitHub SHA-256 digests matched. The Ed25519 update-manifest signature verified against the committed pinned public key; both ZIP sizes, hashes and checksum files matched the signed manifest. ZIP integrity/path checks and bundled package versions passed. The public macOS app passed deep/strict ad-hoc signature verification and plist lint; `MorrowReleaseVersion` matched beta.27 while the numeric bundle versions remained `0.6.0`. Its service returned `Morrow Mail 0.6.0-beta.27` with `--version` in an isolated environment. The application was not opened and no real workspace was accessed. Windows execution evidence comes from CI.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 12,335,067 | `24790d35bdfb91c5cc990ecd3f91fb14ad742f4589e4d494ad071ffbd81b2fd7` |
| windows-x64 | 36,605,827 | `1555ddecff9e3ce7b8bb3a414d88058151f2e6e4c9d26edff3dc9e24ed70be2a` |

Automated checks used isolated fictional workspaces and provider/model fixtures. No real mailbox, paid model or provider write was used. Manual Windows visual/accessibility, clean-machine and live-account acceptance remain outstanding; macOS is ad-hoc signed without notarization and Windows is unsigned. See the [release notes](docs/releases/v0.6.0-beta.27.md).

## PR #11 local review — simpler AI Studio and Settings

Both native clients now show Assistant and Summaries as the primary AI Studio pages, with Writing style & notes under More. Settings has six everyday categories and three entries under Advanced setup. AI & privacy shows permitted mail first; optional controls start collapsed, with automatic assistance's saved On/Off/Paused status visible. Explicit permission saves, connection tests, paid-request review and account ownership are unchanged.

The macOS production package built successfully and passed `morrow-native-check`, plist lint, deep/strict ad-hoc signature verification and Rust formatting. A temporary in-memory SwiftUI harness opened the changed Assistant, privacy and connection pages without starting a service, changing saved state or creating unsaved edits. Its accessibility enumeration returned no entries, so it does not establish label reachability or accessibility acceptance. No real workspace, paid model or provider write was used.

Windows smoke now checks primary navigation, direct advanced setup links and that opening optional permission sections leaves saved policy unchanged; Windows compilation and execution use the existing PR CI, not this macOS host. This review is based on native source and fixture checks, not a usability study with office staff. Manual visual/accessibility, clean-machine and live-account acceptance remain outstanding. The PR did not change the version; subsequent beta.27 publication is recorded above.

## 0.6.0-beta.26 — published native mail-row actions

The macOS and Windows mail lists now reveal local read/unread, an owner-bound Reply All draft, and a reviewed move to the owning provider's Trash on row hover or focus. Gmail uses its Trash endpoint; Outlook uses Deleted Items; IMAP requires a selectable `\\Trash` folder plus MOVE, UIDPLUS and matching UIDVALIDITY. The new provider fixtures check Trash classification, resulting local folder and stable message identity. Windows smoke also checks all three row controls and that patching another row does not replace the open reader.

Local Rust formatting, strict all-target Clippy and the full locked test suite passed with fictional provider fixtures. The macOS native app built and passed native acceptance in a separate fictional workspace. [PR #10](https://github.com/Coke1120/Morrow-Mail/pull/10) passed both native jobs in [PR CI 36603447410](https://github.com/Coke1120/Morrow-Mail/actions/runs/36603447410), including Windows compilation, UI smoke and the fictional-mail benchmark, before merging into `main`.

[Beta.26](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.26) was published at 2026-09-29T18:38:09Z from `e9552d9373ee3fec95b5e27c51198d8bd6d73ada`. [Tagged CI 36610619956](https://github.com/Coke1120/Morrow-Mail/actions/runs/36610619956) passed all three jobs: both platforms completed Node-free Rust checks, native packaging and acceptance, Windows completed its fictional-mail benchmark, and the existing publisher verified same-run paired artifact provenance before signing and publishing both packages. No test waiver applied.

All six public assets were downloaded. The Ed25519 update-manifest signature verified against the committed pinned public key; both ZIP sizes, SHA-256 values and checksum files matched. ZIP integrity/path checks and bundled package metadata versions passed. The public macOS app passed deep/strict ad-hoc signature verification and plist lint; its service returned `Morrow Mail 0.6.0-beta.26` with `--version`. The application was not opened and no real workspace was accessed. Windows execution evidence comes from CI.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 12,330,062 | `d7a4045343ea7da9c2fb5079ab1de1959db3be4a55ab833f4d5ea09676894ec0` |
| windows-x64 | 36,599,455 | `e50dda8300b70bdf917668200be30cc4a616d3cc5ba5ddabc5e78519faccc9e2` |

All automated checks used fictional workspaces and isolated provider/model fixtures; no real mailbox or provider write was used. Manual Windows visual/accessibility, clean-machine and live-account acceptance remain outstanding. macOS is ad-hoc signed without notarization; Windows is unsigned. See the [beta.26 release notes](docs/releases/v0.6.0-beta.26.md).

## 0.6.0-beta.25 — published paired native release

[Beta.25](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.25) was published at 2026-09-29T12:37:16Z from `566fade70857dff23202e6708af55b5e77f2f9a4`. [Tagged CI 36566686505](https://github.com/Coke1120/Morrow-Mail/actions/runs/36566686505) passed all three jobs: both platforms completed Node-free Rust checks, native packaging and acceptance, Windows completed its fictional-mail benchmark, and the existing publisher verified same-run paired artifact provenance before signing and publishing both packages. No test waiver applied.

All six public assets were downloaded. The Ed25519 update-manifest signature verified against the committed pinned public key; both ZIP sizes, SHA-256 values and checksum files matched. ZIP integrity/path checks and bundled package versions passed. The public macOS app passed deep/strict ad-hoc signature verification and plist lint; its service returned `Morrow Mail 0.6.0-beta.25` with `--version`. The application was not opened and no real workspace was accessed. Windows execution evidence comes from CI.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 12,337,605 | `c6f83f02aa0121131ae60f38935d90967f632de6578cc2ffdaf1d8c95d408104` |
| windows-x64 | 36,584,649 | `88e1e738840c90faec694507c4cd759440c9b5fba841180b90b9bbe20db924b5` |

PR #8 and #9 were merged into `main` after each passed both native CI jobs: [PR #8 CI 36561615709](https://github.com/Coke1120/Morrow-Mail/actions/runs/36561615709) and [PR #9 CI 36559233943](https://github.com/Coke1120/Morrow-Mail/actions/runs/36559233943). The combined source at `bee39090eb46d2316348f8e3621db444ed1a9c1f` also passed both native jobs in [main CI 36564056318](https://github.com/Coke1120/Morrow-Mail/actions/runs/36564056318). The Windows fixture checks the resized bottom mail list after its first layout. The macOS integration check rejects a combined-account simulation apply, then accepts its captured owner. Rust regressions cover daily Sent analysis, existing weekly consent and dismissed unchanged proposals.

All automated checks used fictional workspaces and isolated model/provider fixtures; no real mailbox, paid inference or provider write was used. Manual Windows visual/accessibility, clean-machine and live-account acceptance remain outstanding. macOS is ad-hoc signed without notarization; Windows is unsigned. See the [beta.25 release notes](docs/releases/v0.6.0-beta.25.md).

## 0.6.0-beta.24 — published paired native release

[Beta.24](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.24) was published at 2026-09-29T08:16:34Z from `17641cb03104e247f93c0067b4428ef7a55430d5`. [Tagged CI 36539028633](https://github.com/Coke1120/Morrow-Mail/actions/runs/36539028633) passed all three jobs: both platforms completed Node-free Rust checks, native packaging and acceptance, Windows completed its fictional-mail benchmark, and the existing publisher verified same-run paired artifact provenance before signing and publishing both packages. No test waiver applied.

All six public assets were downloaded. The Ed25519 manifest signature verified against the committed pinned public key; ZIP sizes, SHA-256 values and checksum files matched. ZIP integrity/path checks and both bundled backend versions passed. The public macOS app also passed deep/strict ad-hoc signature verification and plist lint; its service returned `Morrow Mail 0.6.0-beta.24` with `--version`. The application was not opened and no real workspace was accessed. Windows execution evidence comes from CI.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 12,321,645 | `4edb73c8f4d7546b088c7a6654800f596867b26435a7613c78593eabdf838e3b` |
| windows-x64 | 36,564,675 | `7592ada328b20ed0cf0c25a99aa9320009d3bfaa152b2a43a4bf3b4eeaf4b7d9` |

PR #5, #6 and #7 were merged into `main` after each passed both native CI jobs. Before tagging, the combined source also passed local Rust formatting, strict all-target Clippy and the complete locked test suite. The macOS SwiftUI/Rust package built, passed full native acceptance with isolated fictional workspaces, plist lint and deep/strict ad-hoc signature verification. No real mailbox or provider write was used.

Native reader fixtures do not complete the consent-dialog/link-review interactions, Out of Office cannot rule out a provider change after its final read without a conditional revision, and unmarked pre-existing update directories are retained. macOS remains ad-hoc signed without notarization and Windows remains unsigned. Manual first-use, clean-machine, full accessibility/IME/DPI and live-account acceptance remain outstanding. See the [beta.24 release notes](docs/releases/v0.6.0-beta.24.md).

## Issue #3 local verification — 29 September 2026

Current macOS source adds a Start here settings path, visible save guidance, direct AI Studio task choices and a sender/subject search for permitted selected-email context. Search uses the existing local indexed API; selected results keep their account-qualified UI identity and original provider ID for the owned AI request. `scripts/build-macos-native.sh` and `morrow-native-check` passed with a separate fictional workspace, including native reader/window checks and Rust account routing. This was a build and fixture check, not a complete first-time-user walkthrough or Windows UI acceptance. No real mailbox, model request or provider write was used.

## 0.6.0-beta.23 — published AI workflow improvements

[Beta.23](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.23) was published at 2026-09-28T09:46:26Z from `077a8a46334a5809bbbd897087777959f4c5c6de`. [Tagged CI 36403166805](https://github.com/Coke1120/Morrow-Mail/actions/runs/36403166805) passed all three jobs: both platforms completed Node-free Rust checks, native packaging and platform acceptance, Windows completed its fictional-mail benchmark, and the existing publisher verified same-run artifact provenance before signing and publishing both packages. No test waiver applied.

All six public assets were downloaded. The Ed25519 manifest signature verified against the committed pinned public key; both ZIP sizes, SHA-256 values and checksum files matched. ZIP integrity/path checks and both bundled release versions passed. The public macOS app also passed deep/strict ad-hoc signature verification and its service returned `Morrow Mail 0.6.0-beta.23` with `--version`; the application was not opened and no real workspace was accessed. Windows execution evidence comes from CI.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 12,226,053 | `35334e564ee3060c180dcdc6ada771240e79096823ab8129ecbf764fe113adfc` |
| windows-x64 | 36,520,860 | `8af8e8cff731eff4af67f99e63803ab023da0d670e5dc4c91448106374c34019` |

macOS remains ad-hoc signed without notarization and Windows remains unsigned. Clean-machine, complete manual accessibility/IME/DPI and live-account acceptance remain outstanding. Beta.22 was never public; its failed tag is retained.

### Change details and local preparation


The shared Rust Brain context validates per-account source content and permissions for interactive assistance, scheduled summaries and reply suggestions. Reviewed memory proposals cite supplied source IDs, retain manual notes and reject expired, replayed, cross-account or changed-source previews. Legacy simulated memory cannot replace an existing Brain. Incremental style proposals retain a valid approved baseline and source references. Ask uses existing Unicode/Chinese token normalization; briefings rank Pending, stars, unread status and recency before the saved cap.

Both native clients expose Assistant, Summaries and Email Brain as the main Studio pages, with advanced tools and manual maintenance collapsed. Today aggregates validated summaries across connected accounts and displays saved timing; each generation request stays account-owned. Reply Suggestions replaces the Inbox candidate picker with positive Needs a reply rows. After one explicit automatic-mode approval, bounded assessments run under a persisted daily allowance. No-reply results remain hidden, Ignore survives restart, and opening a suggestion uses the owned native reply composer for explicit review/edit/Send. Read/star/Pending changes do not invalidate an assessment or trigger another paid call. No automatic sending is introduced.

Smart Search can continue successive indexing batches and handle new/changed downloaded mail after explicit scope/model/daily-budget approval. Daily usage is reserved before network calls, survives restart and renews at UTC midnight. Disabling preserves valid vectors; clearing revokes automatic approval. Uncertain failed/interrupted requests require review rather than automatic replay. Weekly style learning begins with the first eligible sample after opt-in; Brain has an independent bounded weekly proposal option. Pending memory proposals persist across restart and wait for review. Neither feature applies learned context automatically.

Local strict all-target Clippy, rustfmt and the complete locked Rust suite passed: **168 tests, zero failures or ignored tests**. Nine added tests cover normalized retrieval, reviewed memory/source ownership, incremental style provenance, briefing priority, automatic memory persistence/no repeated unchanged analysis, continuous indexing/daily caps/restart/clear, and positive/no-reply/ignored reply assessments with daily limits and permission revocation. Existing background fixtures now verify Today aggregation from both accounts even when an individual mailbox is selected.

macOS production packaging, plist lint and deep/strict ad-hoc signature verification passed. The complete native acceptance also passed against the final candidate: models, HTML reader isolation/zero unsolicited connections, window lifecycle, production Rust service, account routing, owned draft preparation, encrypted persistence and backup/restart. Fictional-data snapshots of Assistant, Brain, Today and Needs a reply were inspected using the production SwiftUI views; the generated harness substitutes an in-memory URL protocol and starts no service, provider or model traffic. This confirms the checked layouts, not complete accessibility or real-model quality acceptance.

[Beta.22 CI 36402130033](https://github.com/Coke1120/Morrow-Mail/actions/runs/36402130033) passed macOS and both Rust suites, then stopped at Windows compilation because the shared `coverage` formatter had been removed while AI Studio still called it. No release was published. Beta.23 restores that existing helper; its successful paired results are recorded above. All runtime checks use isolated fictional data and local model fixtures; no real mailbox, paid model evaluation, provider write or installation into the owner's workspace was involved in these checks. AI relevance and complete unanswered-thread detection remain unverified; source citations do not independently establish factual correctness. Existing signing/notarization and live-account acceptance limits remain.

## 0.6.0-beta.21 — published automatic history recovery

The owner requested removing the three-failure stop introduced in beta.20. Read-only history fetches now keep retrying temporary network, 5xx and recognized quota failures with persistent backoff capped at hourly attempts; daily quotas wait 24 hours. The original checkpoint and attempt count survive restarts. Startup restores older recognized transient failures only when the original connection is still present; paused, disconnected, changed-connection, authorization, storage, malformed/cyclic and unknown failures are not automatically resumed. Old quota records conservatively wait a day from their recorded failure because they did not distinguish daily limits.

Local rustfmt, strict all-target Clippy and the complete locked Rust suite passed: 159 tests, zero failed or ignored. The existing isolated TLS history fixture now alternates seven temporary failures through hourly/daily backoff and process restarts before completing without Resume. Upgrade recovery verifies retained import bounds/cursor/page counts, unchanged retry times on a second restart, no provider calls before the deadline and exclusions for manual/nontransient/connection changes. No real mailbox was used.

[Beta.21](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.21) was published at 2026-09-28T07:47:03Z from `bc43559a3aba4839c4e6d77e7f0bfd19f85f454b`. [Tagged CI 36391416109](https://github.com/Coke1120/Morrow-Mail/actions/runs/36391416109) passed on its first attempt: both platforms completed Node-free Rust checks, native packaging and acceptance, Windows completed its fictional-mail benchmark, and the existing publisher verified both artifacts and signed provenance before publication. No test waiver applied.

All six public assets were downloaded. The Ed25519 manifest signature verified against the committed pinned public key; archive sizes and SHA-256 values matched the signed manifest and checksum files; both ZIP integrity checks and bundled backend versions passed. No downloaded application was launched or real workspace opened.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 12,055,170 | `06853a1be78f9e428aa081a02e102880e09deffe1dcbc27899062b1f9e0d4c04` |
| windows-x64 | 36,294,768 | `08c8e71b742ebb3c21e86d0164ef2c4b383377e94e155ff2725456d5da9134db` |

macOS remains ad-hoc signed without notarization, Windows is unsigned, and live-account, clean-machine and complete accessibility acceptance remain outstanding. Fixture success does not establish live-provider acceptance.

## 0.6.0-beta.20 — published paired native release

[Beta.20](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.20) was published at 2026-09-28T07:12:16Z from `f0bdbce660d162c884b4cd6fdbb3852261edec16`, after [PR #1](https://github.com/Coke1120/Morrow-Mail/pull/1) was reviewed, corrected and merged. The history-import fixes preserve a single three-retry budget across transient error types and require explicit Resume after exhaustion or daily quota errors. Recent-mail Sync retains separate per-account quota backoff.

[Tagged CI 36388373723](https://github.com/Coke1120/Morrow-Mail/actions/runs/36388373723) passed on its first attempt: both platforms completed Node-free Rust formatting, strict Clippy and locked tests, native packaging and acceptance; Windows also completed its fictional-mail benchmark. The existing publisher verified the paired artifacts and signed provenance before publication. No test waiver applied. The final fixture source also passed ten macOS 15 window-check iterations plus Windows storage/mail-service checks in [focused CI 36388240387](https://github.com/Coke1120/Morrow-Mail/actions/runs/36388240387). The window fixture checks the currently displayed pane and awaits its geometry within the original three-second deadline; production window code is unchanged.

All six public assets were downloaded. The Ed25519 manifest signature verified against the committed pinned public key, both archive sizes/SHA-256 values matched the manifest and checksum files, ZIP integrity passed, and both bundled backend versions were beta.20. No downloaded application was launched or real mailbox opened.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 12,022,968 | `662f4421b12ae30a223cbec5661572588d260fdb2ad096b92b1c0feb16947172` |
| windows-x64 | 36,302,660 | `f1c73c135ea93892a7cdb59f0b5e0784875b896f38148d192ab28d2a2c6dc1de` |

Beta.19 was not published; its failed tag remains intact. macOS is ad-hoc signed without notarization, Windows is unsigned, and live-account, clean-machine and complete manual accessibility acceptance remain outstanding.

## Native HTML scrolling without runtime scripts — current source

The macOS reader's two app-owned JavaScript expressions and custom wheel/height
class are removed. It uses a fixed 480-point viewport and WebKit's native
scrolling, matching the existing Windows reader. This intentionally replaces
macOS content-height expansion and custom outer/inner gesture handoff. Sanitized
HTML/plain-text choices, per-message image consent, reviewed links, CSP and
nonpersistent storage remain intact. Normal mail reading executes no host JS.
Windows reader checks now use native DOM protocol operations instead of
`ExecuteScriptAsync`. Enforced CSP audit events must block image/frame probes;
the mounted connect-src policy is inspected, without claiming an executed fetch
probe. Disabled scripts/host objects/web messages, resource denial, fallback and
close/cancellation checks remain. Hostile JavaScript strings are inert fixtures.

The macOS reader fixture itself no longer calls `evaluateJavaScript`. It uses
native find/selection, snapshots and actual wheel events to check both scroll
directions, unchanged outer position, visible/selectable long-message tails,
180k-character narrow-column content, message replacement and width changes.
It also requires disabled scripts/nonpersistent storage and zero unsolicited
loopback connections. The initial 10-second per-document wait proved shorter
than adversarial layout; it now permits 20 seconds within the **unchanged
30-second total reader deadline**. The completed reader run took 12.865 seconds.
The complete `morrow-native-check` passed, including model/window lifecycle,
actual Rust client, account isolation, encrypted persistence and online backup.
Full SwiftUI packaging passed locally. Current Rust checks and Windows CI status
are recorded below; no real mailbox or provider action was used and no new release
has been published.

## Unreleased review fixes for issue #4 — 29 September 2026

The locked Rust suite, rustfmt and strict all-target Clippy passed locally. Focused fixtures exercise an out-of-order OAuth callback and busy callback retry, 256 historical-import pages with bounded settings, a 12-message scheduled-send burst, an Out of Office provider change during save, Gmail label response caching, quick service relaunch after a writer lock, and updater rollback after a launched fixture app fails readiness. The updater fixture uses a generated signing key, temporary app and private workspace; it never launches a release app or uses the owner's data.

The macOS candidate built and passed `morrow-native-check` with its fictional workspace, including the corrected window termination guard, HTML reader isolation and native API/persistence checks. The maintained `.github/workflows/check.yml` runs that native check in its macOS job. Windows package/UI smoke remains a PR CI gate; local macOS results do not establish Windows or live-account acceptance.

Out of Office now re-reads provider settings immediately before writing and reports a conflict when they changed. Without a provider conditional-write revision, a change after the final read remains a possible race. Reader acceptance checks block scripts/resources and reject unsafe link schemes, but automated consent-dialog and link-destination decisions, including cancellation and message switching on both platforms, remain outstanding.

## Historical Node CI retirement — current source

The owner explicitly requested removal of the historical Node lane as well. Both
workflow jobs, archived harness preparation and the two Node oracle calls are
removed. The sanitizer corpus now runs as active Rust contracts. Native updater
signature/download/install/rollback tests remain. Paired native platform builds,
checks, provenance and the existing Rust publisher still gate tagged releases.
CI no longer reruns the original beta.16 installer or old/current differential
checks; earlier results below are historical evidence, not continuing coverage.
See [retirement scope](docs/JAVASCRIPT_RETIREMENT.md).

Local validation passed: rustfmt, all-target Clippy with warnings denied, the
complete locked Cargo suite (zero ignored tests), the full native macOS check,
SwiftUI packaging, plist lint and strict ad-hoc signature verification. Source
inventory confirms no tracked JS/TS files, npm scripts/dependencies or host JS
execution API calls in app/check code. This host cannot compile or run WinUI;
the current Windows build and native DOM/CSP smoke require Windows CI. These
fixture results do not establish live-account or manual visual acceptance.

CI run [36381065432](https://github.com/Coke1120/Morrow-Mail/actions/runs/36381065432)
at `1357f69` passed the complete macOS job and Windows Node-free Rust checks.
Windows compilation caught a fixture-only dynamic JSON key passed to the
literal-key helper. It now uses native `JsonObject.Insert`; no production reader
policy changed.

Follow-up [run 36381768689](https://github.com/Coke1120/Morrow-Mail/actions/runs/36381768689)
at `172064a` passed the entire macOS job and Windows Node-free Rust checks,
WinUI/Rust package build/inspection and the native fresh/owned/restart fixture
walkthrough. The Windows reader gate required `native-dom-no-script` inspection
and enforced `native-audits-image-frame` CSP evidence. This verifies the changed
reader checks on Windows as well as macOS. At recording time the existing
Windows fictional-mail benchmark was still running; the whole workflow is not
claimed complete, and no benchmark result or public release is claimed here.

## JavaScript source retirement — `d22990b`, no new release

At the owner's request, 127 retired JavaScript source files were removed with
the React CSS/web entry, Electron/Node tooling, npm lockfile/dependencies and old
Node-only Swift fixture. The current Git index contains no JS/JSX/CJS/MJS/TS/TSX
files. `package.json` remains version/metadata only. The Swift host now starts
and backs up through Rust only. Provider IDs, resource bytes, production update
key, persisted formats and the shared draft fixture are unchanged.

At that intermediate commit, the two macOS reader geometry expressions, native
reader security probes and ignored Rust-to-Node oracle calls were retained.
Historical checks materialized
five unmodified files from `b5b69d4d276c086ba118583f464bac11341806a0` in an ignored
directory and compared that commit's Rust binaries/version/catalog and native
packages with the fixed beta.16 implementation. This intermediate stage has since
been superseded by the explicit Node CI retirement above. Historical npm commands
and deleted source paths in earlier evidence below refer to their original commits.

Local macOS validation after removal:

- `cargo fmt --all -- --check`, Clippy with `--all-targets -- -D warnings`, and
  the full locked Cargo suite: **152 passed, 2 explicitly ignored Node contracts**.
- All **7 archived storage/search/service differential tests passed**, with no
  skips, against the current copied executables and fixed beta.16 modules.
  Both separately invoked ignored contracts also passed: original Node updater
  layout validation and Node/Rust sanitizer semantics.
- Native SwiftUI/Rust build passed; plist and ad-hoc signature checks passed.
  The full `morrow-native-check` passed Models, HTML bounded-height/scrolling/
  zero-network checks, window lifecycle and actual Swift/Rust integration,
  including encrypted persistence, account isolation and online backup.
- Original beta.16 Node installer → rebuilt actual macOS native candidate,
  restart, uncertain records, calendar recovery, scheduled/Pending/learning/
  reply-suggestion preservation, no replay and bundled backup all passed.

No real mailbox, provider write, paid model request, new tag or published binary
was used. The Windows build and revised historical CI lane still require their
current-commit run; local macOS evidence does not establish Windows acceptance.

## Windows visual alignment and OAuth setup guide — unpublished source

Windows source now applies the SwiftUI Morrow light/dark green through WinUI theme resources, retaining the system HighContrast dictionary. It aligns workspace order, sidebar Compose, account labels/folder badges, combined-folder destinations, initial window and reading proportions, mail/search controls, compact previews, and Settings category/model layouts. No service API, provider credential, signing key, package version or published asset changed.

Local macOS checks: `git diff --check`; `CARGO_INCREMENTAL=0 cargo test --manifest-path rust/Cargo.toml --locked --test mail --test out_of_office` (**7 passed**); the same Cargo command with `--test storage` (**3 passed**). These cover existing OAuth/Out of Office and owner/metadata contracts, not WinUI compilation or visual rendering. The existing Windows native smoke now also checks theme resources, fresh Compose availability, complete account-bound combined folders, actual unread-only results and the Settings grid. Those new Windows checks have **not run here**: this host has no Windows/WinUI toolchain. Run `scripts/build-windows-native.ps1 -Zip` and `scripts/test-windows-native.ps1 -UiSmoke` on Windows, and review light/dark/high-contrast layouts before distribution.

The [繁體中文 OAuth setup guide](docs/OAUTH_SETUP.zh-TW.md) was checked against current runtime scopes/client selection and official Google/Microsoft documentation. No Cloud/Entra settings were inspected or changed, and no real-account consent, send, calendar write or automatic-reply update was performed.

Main commit `b5b69d4` was pushed and [CI 36378387394](https://github.com/Coke1120/Morrow-Mail/actions/runs/36378387394) passed the full macOS job and Windows Rust checks, but Windows compilation rejected `to_hstring(std::wstring)` in the new mailbox heading. Follow-up `c77689e` uses the existing `hstring` constructor; its Windows CI recheck is pending. The failed compile is not recorded as a passed UI check.

## 0.6.0-beta.18 — explicit release validation waiver

The owner explicitly requested merging to main and publishing without new tests. The canonical workflow now builds SwiftUI/Rust and WinUI/Rust packages, retaining same-run artifact provenance, exact checksums and pinned signed manifests. Only the exact beta.18 tag skips Rust checks, native walkthroughs, benchmarks and historical compatibility execution; its historical jobs record the waiver rather than claiming test success. Future tags retain those gates. The accompanying main preparation commit delegates packaging to the tag to avoid duplicate builds.

Prior evidence below remains attributable to its original commit/run, including the four successful jobs at `2f39ade` in CI 36361496967. This exception does not complete N0, clean minimum-OS, IME/accessibility/DPI, live-provider or distribution-signing acceptance. No private workspace or real provider/model action is part of this release. [Beta.18](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.18) was published at 2026-09-28T02:05:20Z from `d6ee967abce78dd32900912ef030b399b8f8928b` by [CI 36367684050](https://github.com/Coke1120/Morrow-Mail/actions/runs/36367684050). Both native builds and the Rust publisher succeeded; historical jobs only recorded the explicit waiver. No new test suites, walkthroughs or benchmarks ran for this tag.

All six public assets were downloaded. The manifest verified with the pinned production Ed25519 key, and both archive sizes/SHA-256 values matched the signed manifest and checksum files. Both backend package versions are beta.18; Windows metadata identifies WinUI/Rust and macOS identifies Rust with its normal numeric `0.6.0` plist version. Neither archive bundles Node/Electron/React runtime files. No downloaded application was launched and no real workspace was opened.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 12,011,008 | `b38deb061cef785632f2f961cbe120b5cc3f74f37d700818058c0c748f2ed08a` |
| windows-x64 | 36,210,163 | `b5fdd4e7ef4040f0aac51c23f5ae272d798a1330c58b68f0c8a9edc7bc477f06` |

The beta.17 attempt at `1b0418897d260fc0c910f1a249f335c3628bcdcf` ([CI 36366623326](https://github.com/Coke1120/Morrow-Mail/actions/runs/36366623326)) built both packages and explicitly omitted all tests. The publisher verified the same-run artifacts and signature, then stopped after creating an empty draft because the immediately reread releases listing did not include it. No assets were uploaded or made public. Beta.18 uses the validated draft ID from the create response and requests fresh API reads; the beta.17 tag is not moved.

## Unreleased native migration candidate — Node-free macOS and N4 preservation

`scripts/build-macos-native.sh` built the SwiftUI/Rust candidate with Node/npm absent from PATH. The Rust resource checker, target-specific notice collector, arm64 macOS 13.5 service/Swift compilation, Info.plist, system-library inspection and deep/strict ad-hoc signature checks passed. Output is isolated at `build/macos-native/Morrow Mail.app`; the installed application and user's workspace were untouched.

The new Rust `morrow-native-check --service <candidate-service>` driver passed the unchanged Swift native acceptance against that actual service, including six sorts, duplicate IDs/combined owners, shared draft preparation, Bcc, manual unread/page retention, Pending, future scheduled creation/replay/cancellation, shutdown/restart, authenticated backup/no-overwrite and disconnect isolation. It seeds and validates with Rust. Historical Node compatibility remains a separate test, not implied by this driver.

The Rust `morrow-benchmark` driver passed its four focused checks and one Node-free 1,000-message/zero-idle smoke run against an immutable copy of the same candidate service (`c06e750a2f4d2f5c1afb240a00e06541da7647a551bfcbde830f595c1e0979da`). Counts, exact invoice owner/IDs, sender ordering, bounded metadata/cursors, single writer, monotonic derived-index recovery and source retention passed. The subsequent Node-free 1k/10k/50k run against that same immutable service completed on arm64 macOS 27.0.0, with every correctness check passing (`test-results/native-benchmark-macos-bfd6815.json`, ignored local evidence). Five warm requests per route measured search p95 at 12.94/19.38/56.31 ms, state at 3.12/3.87/25.44 ms and page at 2.20/2.32/3.26 ms. Each 1,000-row partial derived-index rebuild completed in 0.74/0.81/1.09 seconds, with source rows retained; each 30-second idle interval consumed a sampled 20 ms service CPU. This uses Rust-seeded stores, not Node migration, and is a small API smoke benchmark—not whole-app, full-index-loss, cold-cache, Windows or latency-distribution acceptance. Shared assets were moved without byte changes; the compatibility React build and copied public asset checks passed.

The unwired Rust publisher passed seven focused checks, strict Clippy and a read-only real GitHub artifact parser check. Its publication path binds both platform archives/checksums to immutable artifact IDs from the approved run/attempt/commit, verifies GitHub's transport SHA-256 and compares each expanded file before signing or upload. The beta.16 macOS transport size/hash matched the API, and its actual ZIP/checksum bytes passed the bounded parser. No signing key was used and no release was created or modified. The integrated Rust tree also passed Node-free formatting and all-target strict Clippy; Windows host changes still require CI.

`scripts/test-rust-upgrade.js --candidate=<candidate> --compatibility-root=<fixed-beta16>` passed against an isolated archive of `7ab30cbb3e496118513a98f8211ec66481e282c4`. The unchanged historical Node installer verified/replaced the actual candidate after both fixture PIDs exited, then launched the production SwiftUI/Rust app. Both the restarted workspace and bundled CLI backup preserved keys, full uncertain-delivery drafts/attempts, calendar retry files and N4 Scheduled/Pending/Learning/Reply Suggestions records. Only specified interrupted model claims changed status; no claim replay, send or provider/model call occurred. Disconnected historical proposals being retained is not evidence of current eligibility after reconnect.

Candidate CI [36340489692](https://github.com/Coke1120/Morrow-Mail/actions/runs/36340489692) passed the macOS Node-free Rust checks, SwiftUI build and native acceptance. Windows passed compilation, package/runtime-boundary inspection and private Rust startup/authentication/EOF drain. Fixed-phase diagnostics isolated the WinUI failure to `Application.Resources()` returning `0x8000FFFF` before window creation; the process then exited with `0xC000027B`. The metadata provider alone did not resolve initialization. The PowerShell diagnostic parser passed its synthetic check, but this run produced no supported WER dump. Follow-up CI [36341586899](https://github.com/Coke1120/Morrow-Mail/actions/runs/36341586899) confirmed that moving resource initialization to `OnLaunched` fixed this crash: resources loaded and the native window activated. Fresh onboarding then reached the shutdown assertion, which incorrectly called destructive `Window.Close()` instead of a user close request. CI [36342516279](https://github.com/Coke1120/Morrow-Mail/actions/runs/36342516279) then passed fresh onboarding and the corrected title-bar `SC_CLOSE` drain check. The owned-mailbox case stopped at saved window-size restoration. Bounded geometry diagnostics in [36343529224](https://github.com/Coke1120/Morrow-Mail/actions/runs/36343529224) confirmed the requested `1180×780` was limited to `1044×780`, matching the runner's `1044×788` maximum track size. The fictional previous-host size is now `1040×760`, within those limits; exact restoration and post-close persistence assertions remain. Product resizing is unchanged, and this is not general DPI or minimum-OS acceptance. CI [36344355980](https://github.com/Coke1120/Morrow-Mail/actions/runs/36344355980) passed the macOS checks and fresh Windows onboarding again, but the owned walkthrough exceeded its unchanged 180-second deadline. Its prior harness discarded stderr/result evidence on timeout, so the failing operation is not yet established. A separate source review found that Out of Office returned before its initial read released the busy marker; that existing read is now awaited before page completion. This does not establish the timed-out operation. Fixed operation phases and bounded timeout evidence retention now preserve that failure without treating it as success; assertion cleanup clears only verified disposable-fixture edits so teardown cannot ask for manual discard. CI [36345828247](https://github.com/Coke1120/Morrow-Mail/actions/runs/36345828247) passed macOS again and exercised owned Windows paging, six sorts, read/Pending changes, draft preparation/save, workspace pages and Settings. The retained result identifies the remaining failure as the HTML reader’s 25-second runtime acceptance deadline. A locked WebView temporary file masked that assertion in the console; cleanup now retries only its verified fixture directory and preserves the original failure. Reader diagnostics now distinguish initialization, document loading and individual isolation assertions without changing security settings or deadlines. Native Windows walkthrough and historical upgrade have **not** passed. New native Calendar, HTML reader and Intelligence work still requires Windows runtime evidence. No native cutover, release or production-readiness claim is made.

CI [36347091955](https://github.com/Coke1120/Morrow-Mail/actions/runs/36347091955), at `581131f`, passed formatting, all-target strict Clippy and the full Rust suites on both platforms with Node/npm inaccessible. macOS also passed the canonical versioned ZIP/checksum build and newly retained Swift Models checks. Its existing HTML fixture then failed the upward-scroll assertion. The fixture now awaits each exact scroll position within two seconds instead of sampling after a fixed sleep; production scrolling is unchanged. A focused local reader run passed with zero network requests, but the final fixture change still requires macOS 15 CI. Window assertions and Rust integration were not reached in this run.

Windows again passed packaging, fresh onboarding and owned mail/Settings, then reached the unchanged 25-second reader deadline while waiting for its initial document; environment and controller creation succeeded. Source review found that the navigation guard incorrectly rejected host API loads as user-initiated. [Microsoft documents that WebView2 API navigations are user-initiated](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2navigationstartingeventargs#get_isuserinitiated). The fix retains the one-use expected document, exact `about:blank`, redirect rejection and captured navigation ID, and removes only the incorrect flag condition. Runtime/security acceptance of this fix is pending. Bounded cleanup preserved the original reader failure in this run.

CI [36348488776](https://github.com/Coke1120/Morrow-Mail/actions/runs/36348488776), at `bfd6815`, passed both platforms’ Rust checks. macOS passed the complete Node-free build, canonical packaging, Models, actual HTML bidirectional scrolling/height bounds/network-zero, window close/reopen and Rust client integration checks. Windows passed compilation, packaging, fresh and owned mail/Settings again, but still timed out at initial reader document loading after controller creation. Removing the incorrect user-initiated condition was necessary by API contract but did not resolve this timeout; further bounded navigation diagnostics are required. Historical upgrade remains skipped by the native gate.

Read-only review also found two foreground interaction bugs: closing a pending mail AI popup retained its modal guard, and the sidebar could leave a composer while its save/send/schedule was in flight. The pending candidate releases each popup’s own guard on closure and holds existing foreground navigation disabled through composer writes, releasing it before successful navigation. Native fixture checks exercise guard handoff, synchronous dialog failure and navigation blocking across an await, without provider/model calls; runtime execution is pending. Background index/learning navigation is unchanged.

CI [36349645485](https://github.com/Coke1120/Morrow-Mail/actions/runs/36349645485), at `25559e7`, passed Windows Rust checks, compilation and the new foreground interaction guards in both fresh and owned fixtures. Reader diagnostics now establish the remaining failure: navigation ID 2 started with a non-`about:blank` URI, the production handler cancelled it, and completion reported cancellation. The URI scheme/shape is not yet established; no broader URI permission has been introduced. macOS stopped earlier at a network-sentinel unit-test race: its bounded server close produced `ConnectionReset` on the test client. The test-only correction retains the unchanged observer and requires its exact unsolicited-connection finding, rather than successful HTTP delivery; that single regression passed locally. The preceding full macOS native pass remains valid evidence for its earlier commit, not this failed run.

CI [36350805034](https://github.com/Coke1120/Morrow-Mail/actions/runs/36350805034), at `05240f3`, passed the complete macOS Rust/native/package gates again, including the corrected sentinel regression. Windows passed Rust checks, compilation, packaging and the foreground interaction/mail/Settings fixtures, then recorded that `NavigateToString` starts navigation ID 2 with a Base64 `data:text/html` URI (1,220 characters for the fictional document), not `about:blank`. The current guard cancelled that navigation. URI/body contents were not logged. The pending correction compares the bounded Base64 URI against the exact UTF-8 document supplied by the host, consumes that expectation once, and clears it on close. The existing runtime fixture independently tracks its expected document; malformed, different, oversized and non-HTML navigation remain rejected. Windows compile/runtime validation and historical upgrade are still pending.

The candidate toolchain retains the existing Swift Models, HTML/network-zero and window assertions in `morrow-native-check`. Candidate CI keeps canonical package pairs separate from diagnostic evidence and retains all seven storage/search/service differential contracts against the fixed beta.16 checkout. Import wiring passed syntax checks; differential and historical-upgrade execution remains blocked by the native gates. The canonical publication workflow remains unchanged.

CI [36353708979](https://github.com/Coke1120/Morrow-Mail/actions/runs/36353708979), at `02f9afd`, passed macOS in full and the Windows native CSP observer: all three enforced policy violations were observed, fetch was rejected and the image remained unloaded. Plain-text switching also loaded the empty HTML document successfully, then failed the composite fallback display assertion. That assertion is now split into six fixed, content-free reasons to identify the failed invariant; no product visibility rule or acceptance condition was changed. Windows benchmark and historical upgrade remain unexecuted because the reader gate failed.

CI [36352335146](https://github.com/Coke1120/Morrow-Mail/actions/runs/36352335146), at `371d516`, passed the full macOS candidate again. Windows passed compilation and both initial/adversarial HTML navigations with the exact-document guard, then passed the inline-script sentinel. The remaining 25-second deadline occurred while waiting for JavaScript `securitypolicyviolation` listener flags: fetch was rejected and the image completed without loading, but none of the three listener flags changed. Chromium's [callback gate](https://github.com/chromium/chromium/blob/b31884b84b962aeeb0fa80c783981c7476b03935/third_party/blink/renderer/bindings/core/v8/generated_code_helper.cc#L58) requires enabled scripting even though host ExecuteScript is permitted. The pending fixture instead observes native `Audits.issueAdded` notifications and requires enforced `img-src`, `frame-src` and `connect-src` violations for its exact probe destinations. Script/DevTools UI settings, resource/navigation last-deny, no-load checks and the deadline remain unchanged. Fixed upstream source explains the mechanism; this is not a traced Microsoft runtime revision or completed runtime acceptance. Historical compatibility remains gated. The next candidate also adds the existing Rust benchmark's 1k/10k/50k Windows run after native acceptance; no extra driver or Node dependency is introduced.

CI [36354783178](https://github.com/Coke1120/Morrow-Mail/actions/runs/36354783178), at `4635b2a`, passed macOS in full and Windows Rust/build/package, mail/Settings, exact HTML navigation and native CSP checks. The named fallback failure is `textBlockMissing`: its weak WinRT label reference expired. The candidate now retains Reader labels while mounted, releases them on visual unload, and requires both an actually loaded fallback and released labels in the existing runtime fixture. The same label ownership correction covers Compose, Scheduled, Calendar and Intelligence; no email security setting is relaxed. This correction still requires Windows execution. Candidate CI also lets packaged-service benchmarks and historical preservation run independently of reader UI acceptance; any failed native job continues to fail the workflow and publisher gate.

CI [36356066868](https://github.com/Coke1120/Morrow-Mail/actions/runs/36356066868), at `23d97d1`, passed macOS in full and Windows Rust/build/package again. The Reader passed the previously failing fallback's content, mounted/visible state and collapsed browser checks, then the outer 180-second harness expired after `plain-empty-assertion`. This does not establish a WebView script failure: source review found that the harness waits for process exit after reading only one stderr line, allowing synchronous diagnostic output to fill the redirected pipe and block the UI thread. The harness now drains continuously with a fixed buffer, bounded lines and an allowlisted diagnostic tail. Its retained real-pipe regression passed oversized-output filtering and owned-process timeout checks using PowerShell 7.5.3. Reader assertions and deadlines are unchanged; the precise Windows runtime cause remains subject to the next execution.

The independent Windows Node-free benchmark passed all ten correctness checks at 1k/10k/50k with immutable service SHA-256 `f260122f79a96345896ea362ccff9a7a23c344821c79abdc46b6b6567c83527f` (27,719,168 bytes). On Windows Server build 20348, five warm requests measured state p95 at 5.28/6.47/17.15 ms, lexical search at 25.62/42.18/117.18 ms, page at 3.75/4.13/5.71 ms and sender sort at 9.91/64.52/306.17 ms. Sampled service working set maxima were 19.18/19.45/19.21 MiB. Each 1,000-row partial rebuild completed within its 180-second deadline, with source rows retained. The report records dirty checkout flags and the immutable binary identity; 30-second idle CPU deltas rounded to zero at Windows timer resolution. This is Rust-seeded service smoke evidence, not whole-app, full-loss, cold-cache or latency-distribution acceptance. The JSON is retained in that run's candidate evidence artifact; the native UI job remains failed.

Both historical jobs in that same run passed: fixed beta.16 updater/sanitizer semantics, all seven storage/search/service contracts, and the original installer upgrading the actual SwiftUI and WinUI candidates. The restarted workspaces and bundled backups retained keys, complete uncertain deliveries, calendar retries, Scheduled/Pending/Learning/Reply Suggestions records, and non-replay of interrupted model claims. This is the first candidate Windows actual-upgrade pass; it does not turn the separate failed reader walkthrough into a pass or establish clean minimum-OS/manual accessibility acceptance.

CI [36357924382](https://github.com/Coke1120/Morrow-Mail/actions/runs/36357924382), at `62f3913`, passed all four jobs. Both platforms passed Node-inaccessible Rust checks and candidate packaging. macOS passed its complete native suite; Windows passed the new bounded-pipe regression and fresh/owned/restart walkthrough. Both owned Reader results report HTML runtime, mounted fallback and stale/close checks passed, scripts/web messages/images/frames/connections blocked, host objects disabled and zero native image requests. Empty-HTML inspection, stale navigation, unload/closed-browser checks and explicit failure fallback completed within the unchanged 25-second deadline (about 10.9 seconds first run and 0.7 seconds on restart). Reader source was unchanged from the preceding run: continuous stderr draining resolved the harness stall without relaxing browser protection. The Windows 1k/10k/50k service benchmark and both fixed beta.16 contract/actual-upgrade jobs also passed. These results establish the candidate's automated gates, not whole-app comparative performance, clean minimum-Windows, IME/Narrator/DPI, live-provider or distribution-signing acceptance. No production cutover, tag or release occurred.

The subsequent observational run [36360244463](https://github.com/Coke1120/Morrow-Mail/actions/runs/36360244463), at `a2a83ea`, did **not** pass. Both platforms passed Rust checks and candidate builds, and the Windows service benchmark passed. The new Windows observer failed before UI launch: assigning a DACL through an ordinary write-only file handle returned access denied. The macOS reader fixture exceeded its unchanged 30-second deadline without a phase trace; those reader sources were unchanged from the preceding successful run, and the cause is not established. Historical upgrade jobs were skipped. These failures do not supersede the earlier evidence or count as successful new acceptance; the failed logs are retained. The follow-up uses protected ACLs at file creation and adds fixed macOS fixture phase diagnostics without changing assertions or deadlines.

Follow-up [36361496967](https://github.com/Coke1120/Morrow-Mail/actions/runs/36361496967), at `2f39ade`, passed all four jobs, including both platforms' seven historical storage/search/service contracts and original beta.16 installer → actual candidate restart/record preservation/backup acceptance. Atomic DACL creation allowed all three Windows walkthroughs to run. macOS retained the original 30-second Reader limit and passed in 21.656 seconds; the 180k-character narrow-column stage occupied about 15.855 seconds of this run. The earlier timeout did not recur, but its cause remains unknown. Windows recorded the actual WebView2 runtime **131.0.2903.86** in both owned results; native CSP, script/resource isolation, fallback and stale-close assertions passed. This is runtime evidence, not a claim that Microsoft's runtime corresponds to the separately reviewed upstream Chromium commit.

The same Windows fresh/owned/restart walkthroughs produced the following **individual observations**, on hosted build `10.0.20348.0` with four logical CPUs. UI SHA-256 was `44eee9eb6ade56153b1b3b326a6979a4d73c399e534a2c3bb1fca3fcff6f0d34`; service SHA-256 was `6cff6d927071ac75fde5264220d978d15f7c965b1e75d814f2ca16bc09deb928`.

| Fixture run | First-page marker ms | HTML marker ms | Samples | Sampled max working-set sum MiB | Sampled max private-bytes sum MiB | Collection status |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Fresh workspace | 585.50 | — | 3 | 115.44 | 53.26 | No recorded sample gaps |
| Owned, first run | 413.97 | 13,528.52 | 15 | 359.84 | 145.27 | Incomplete: two process observations unavailable in one snapshot |
| Owned, restart | 431.18 | 2,825.96 | 5 | 128.86 | 76.96 | No recorded sample gaps |

The markers measure launch-to-stderr receipt, not compositor first paint; the HTML marker includes the fixture's deliberate two-second pause after initial-page readiness. The first completed samples arrived 751.68/653.03/575.65 ms after launch. All collectors exited normally and were reaped; no malformed, truncated or oversized records occurred. Working-set sums can double-count shared pages; private bytes are not private working set or macOS footprint. Sampling spans the entire walkthrough, including adversarial Reader work, and may miss early peaks or short-lived processes even when no gap is recorded. These are not idle measurements, percentile estimates, an old-Electron comparison, or full N0 acceptance. Separate JSON reports retain the partial flag and raw numeric samples. The Windows 1k/10k/50k service benchmark also passed all ten checks per size with an immutable copy of the same service; it recorded dirty workspace flags, which remain unaltered in the report.

## Unreleased N1 migration — shared draft preparation

Rust now prepares Reply, Reply All, Forward and provider-draft copies through authenticated `POST /api/drafts/prepare`, using the explicit mailbox header and original message ID. SwiftUI and React callers, including AI result insertion, use this operation instead of duplicating recipient/quoting rules. Saved local draft decoding and uncertain-delivery review remain unchanged. The Node development/compatibility service exposes the same contract; this is not a desktop runtime fallback. The endpoint reads current owned content without saving, sending or calling a provider/model.

Validation passed: two Rust draft tests (a shared 21-case pre-migration corpus plus actual HTTP authentication/owner/input/no-write checks), scoped strict Clippy, 45 affected Node/React checks, React production build, `npm run macos:test`, and `CARGO_INCREMENTAL=0 npm run macos:rust:test`. Native acceptance covers duplicate IDs/combined views, service-owned forward content, provider-draft copy with To/Cc/Bcc and unchanged original, no persistence from preparation, competing requests and selection/account/connection/composer/sheet changes, as well as the existing lifecycle, backup, Pending, scheduled-send and recovery checks. React handler tests exercise success, cancellation, stale context, duplicate clicks and preparation errors; SSR checks retain sender locking and uncertain delivery review.

All work used fictional isolated fixtures. No real mail/model/provider action, Applications replacement, candidate packaging or release was performed. These checks do not establish Windows runtime/WinUI acceptance or complete N0/N1. The native migration plan and inventory track the remaining shared logic, deployment, baseline and toolchain gates.

## 0.6.0-beta.16 paired prerelease

[beta.16](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.16) was published at 2026-09-27T14:24:51Z from `7ab30cbb3e496118513a98f8211ec66481e282c4`. All five platform jobs and the publisher in [tag CI 36323695599](https://github.com/Coke1120/Morrow-Mail/actions/runs/36323695599) passed. The redundant main run was cancelled; every tag gate remained. The full Rust suites, seven Node–Rust contracts, 232 Node checks (two conditional service checks are covered by the separate contracts), React builds, dependency audits and benchmarks passed on the release platforms. Both desktop pipelines passed packaged acceptance and actual old-installer upgrade, restart and backup preservation; macOS also passed the full native checks and Rust client harness.

All six public assets were downloaded and verified with the pinned Ed25519 manifest, exact sizes, SHA-256/checksum files and archive confinement. Both packages identify beta.16/Rust, contain bundled Google Desktop registration and dependency notices, and exclude private workspace data and a standalone Node backend. The downloaded Mac app passed deep/strict codesign, plist, service-version and CLI checks.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macos-arm64 | 11,948,140 | `ab5ed5f077fcea1853f132c1dc27a6145bdc5b3ebee178c797a0cda9b9d2765c` |
| windows-x64 | 168,456,571 | `008b1300ab31caf4a919fd8040a7bc7f883f5609e561cc95146fb66b28c17586` |

No Applications replacement or real provider/model action was performed for this release. The installed app remains beta.14. Yahoo HK setup is fixture-checked, not live-account accepted. Ad-hoc macOS signing, absent Apple notarization, unsigned Windows and incomplete live-provider/model/accessibility acceptance remain explicit beta limitations.

The unpublished beta.15 tag was stopped by one stale UI assertion looking for the old import button label. Its Rust checks and macOS desktop/upgrade acceptance passed; the assertion now checks the enabled Start new import button while retaining all history-range and Spam/Trash exclusion checks. No product behavior was changed for this correction. After rebuilding the versioned local Rust worker, `npm run check` passed 232 checks with two conditional Rust-service checks skipped, plus the React production build. Those conditional checks remain required in the CI Rust contract step. Beta.16 subsequently passed the complete paired release gates above.

## 0.6.0-beta.16 local preparation — Settings UI/UX and Yahoo HK

Both clients now put account connection controls first, separate Chat/reply and Search embedding forms without dropping their unsaved drafts, group General preferences with visible autosave status, and keep explicit permission Save/Discard visible. Search has one reviewed indexing entry and separates supported Rust batch controls from destructive vector clearing; Learning leads with account/proposal/approved-style status and separates identity from opt-in configuration. Calendar explicitly supports one account per provider; About distinguishes current version from the previous installation record. No API/provider/authentication behavior changed.

Yahoo/HK uses the existing IMAP/SMTP path, complete address, Yahoo TLS servers and an app password. The preset clears entered passwords and never connects automatically. No Yahoo OAuth/calendar/Out of Office support or real Yahoo acceptance is claimed.

Validation: focused Settings, Learning and Search UI/contract tests (23 checks); React production build; full native Swift compilation. A temporary native app with two fictional accounts and mocked provider/model services was used to inspect all eight tabs, visible account actions, separate model panels, retained unsaved embedding edits across the Chat switch, persistent permission controls and collapsed calendar reconnect forms. No real workspace, provider writes or paid model calls were used. Browser automation was unavailable; React checks cover rendered/handler behavior, not a Windows runtime walkthrough. Jev review was unavailable because its API key was not configured. Paired release CI is required before publication. No Applications replacement or live Yahoo acceptance was performed for these changes.

The earlier installed beta.14 read-only review is retained in [Settings UX review](docs/SETTINGS_UX_REVIEW.md), now annotated with implemented changes. Screenshots and generated fixture apps remain outside version control.

## 0.6.0-beta.16 local preparation — hourly update checks

Both clients now check at launch and once per hour while running, with a due check on return from sleep/background. Availability is retained outside Settings and shown as an accessible red ! badge linking to About. Manual and automatic checks share the same state; failed checks retain the last successful release, channel changes clear it, and no automatic download or installation is performed.

`node --test tests/updates.test.js tests/settings.test.js` passed 9/9, including deterministic hourly boundaries, manual-check coalescing, offline retention, cancellation and clock rollback. `npm run build` passed. `npm run macos:test` passed the full native compile and isolated client harness, including hourly/manual checks, channel reset and the About shortcut without changing the mailbox or global busy state. Existing Swift onChange deprecation warnings remain. At local preparation these client-only changes had not been installed in Applications or executed on Windows; no real provider or model action was used. Paired CI supplies the release platform checks.

## 0.6.0-beta.14 paired prerelease

[beta.14](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.14) was published at 2026-09-27T09:58:56Z from `0f5b76056284ab74880cf695d48170c86f606d2a`. All five platform jobs and the publisher in [tag CI 36309158377](https://github.com/Coke1120/Morrow-Mail/actions/runs/36309158377) passed. The redundant main run was cancelled; the tag retained every gate. macOS and Windows each passed 125 Rust tests, seven Node–Rust contracts and 223 Node checks (two conditional Rust checks are covered by the separate contracts), plus React builds, audits, benchmarks, package/desktop checks and updater acceptance. The native calendar hosting regression passed on macOS 15. Both dedicated desktop jobs passed actual old-installer upgrade, restart and backup preservation.

All six public assets were downloaded and verified against the pinned Ed25519 manifest, exact sizes, SHA-256 checksums and archive confinement. Both packages identify beta.14/Rust, contain bundled Google Desktop configuration and dependency notices, and exclude private workspace data and a standalone Node backend. The public Mac app passed deep/strict codesign, plist, service-version and CLI checks.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macOS arm64 | 11,842,394 | `bc7b3508c3b09e04164788b35bfd14dc3bd5c8f1106e4b31d76049b69ab7cc17` |
| Windows x64 | 168,449,227 | `3ce4ed1b57ff8fa4f5cae539a3fedae0ccc81255e7ddbea22dc214ceaffb70a9` |

The verified public Mac app was installed into Applications after closing Settings and normally quitting the previous UI/service. The previous app is retained under ignored build output; no workspace file was copied or replaced by the installer. Installed UI/service hashes match the downloaded archive. Relaunch started the expected service child, and its loopback API rejected an unauthenticated request with 401. No further real provider/model action was manually triggered for installation verification.

Installed UI SHA-256: `ccc97b0cd48593aadef73f39848a3826bb416632c9ecda7ee89f4dc8e1bf7283`. Installed service SHA-256: `15ced14b7e9190392fcf2f0bab7246f34e98f47a13bf20985b639e159d9d7271`.

Ad-hoc macOS signing, absent Apple notarization, unsigned Windows and the live-provider/reminder-delivery limitations below remain explicit. Fixture calendar writes do not establish real reminder delivery.

## 0.6.0-beta.14 local verification and authorized Learning follow-up

The React calendar was exercised through the browser in a disposable local workspace with fictional Google/Outlook calendars and injected provider fixtures. Primary selections, a read-only holiday checkbox, persisted selection after reload, month-grid multi-day exclusive ends, date-click creation, a reviewed Google email reminder at event start, successful fixture creation/agenda refresh, removal from display when unchecked and Outlook's notification-only selector were observed. No real calendar/provider was contacted. This walkthrough also reduced the oversized heading/spacing so more of the month is visible at a 1280×720 viewport. Windows host storage explicitly permits only the new bounded calendar-choice key; existing IPC sender checks remain unchanged.

The actual SwiftUI calendar also passed an isolated fictional-provider walkthrough: checked Google/Outlook calendars, exclusive multi-day display, a read-only holiday checkbox, date-click editor with the selected day at 09:00, review of a Google email reminder at event start, fixture creation and refreshed month display. An AppKit constraint-loop crash found during the first walkthrough was fixed by bounding grid-cell and calendar-choice heights; the window harness now hosts the actual calendar at compact, standard and wide sizes. Date cells retain native button accessibility. The native automation bridge remained unreliable, so explicitly authorized AppleScript/System Events was used against a uniquely named fixture process. No real calendar event was created.

Final local checks: 125 Rust cases passed across the full aggregate and the corrected five-case Gmail-sync rerun, strict all-target Clippy/rustfmt, release/debug builds and seven Node–Rust contracts; `MORROW_TEST_RUST=1 npm run check` passed 225/225 with no skips and the React build. `npm run macos:test` passed, followed by the final calendar/window check and `CARGO_INCREMENTAL=0 npm run macos:rust:test` after the layout change. Two old Gmail-only All Mail assertions were updated to malformed-input rejection because Outlook and IMAP are now intentionally supported. The initial Node run also used an old release worker; the final run used the rebuilt beta.14 binaries. Graph fixtures cover positive/negative timezone conversion, all-day exclusive civil dates, bounded original-timezone rereads and explicit rejection when verification fails. Paired CI and publication subsequently passed as recorded above.

An explicitly authorized real Gmail Learning run completed in the installed beta.13 app. Sent access and account-specific learning were enabled, with weekly automation left off. The reviewed batch used the saved model/endpoint, the last three months, a maximum of eight Sent bodies and a 16,000-token budget; only one useful cached sample was available. The app reached Ready and retained the proposal. Save Approved Style was not selected. This confirms one live generation, not a representative learned profile, identity recognition or automatic follow-up accuracy. No extra mail was sent and no out-of-office setting was changed.

Complete history, confirmed identity, Pending, reply-suggestion batches, server-managed Out of Office and scheduled sends are included in the beta.14 candidate. Month-calendar and provider-reminder changes are included; the final calendar checks are recorded above. Local integration passed 48 affected Rust tests and 92 Node tests, strict all-target Clippy, SwiftUI compilation and the native Rust harness. The latter exercises account-owned Pending, a 30-day future schedule with UUID replay, draft locking, cancellation and no delivery, plus safe disabled/ungranted new-tab contracts. Isolated provider fixtures cover Out of Office writes, complete-history checkpoints and exclusions; local model fixtures cover reviewed reply batches and identity/style/source revocation. OAuth-upgrade checks cover wrong/replaced owners, partial consent, obsolete simultaneous authorization attempts and preserved history/selection. No real Out of Office write or new scheduled mail delivery was performed. The earlier beta.13 release and Windows acceptance do not cover these changes; a locally signed candidate was installed into Applications with the previous app retained. The real Gmail walkthrough opened Reply Suggestions (unconfirmed-identity guard), Out of Office (additional-consent guard), Scheduled and the All history menu. A synthetic self-addressed message was scheduled one hour ahead and immediately cancelled; the UI confirmed Cancelled, no delivery occurred, and its retained draft was moved to recoverable local Trash. Pending was set on the earlier synthetic self message, observed in its one-row Pending list, then cleared. The Learning proposal remained Ready after update, without applying it. A stale success banner after schedule cancellation and outdated plain-text-only help were found and corrected after this walkthrough. No full-history download, additional model batch or live Out of Office grant/write was triggered. The final candidate was rebuilt, deep/strict signature-checked and reinstalled after those small corrections; installed UI/service hashes match the generated package. Learning remained Ready with identity unconfirmed and weekly learning off. Existing opt-in per-message AI triggers ran on the synthetic test mail during navigation. IMAP All Mail connection validation also now uses the All Mail scope rather than requiring a Sent special-use folder, with a focused regression. This is a local installation, not a new published release.

## Installed beta.13 real-account walkthrough

The installed macOS app was exercised with the owner's authorization, using Computer Use and, after its Settings bridge disconnected, explicitly authorized AppleScript/System Events. The app and Rust service remained running during those bridge failures. No private screenshots, backup, account identifiers, credentials or mailbox contents are committed.

Observed in the actual app:

- Gmail completed the selected three-month All Mail import. Inbox paging, Archive, Sent and Drafts navigation, and local exact-phrase search worked. An empty Starred view alone is not proof of provider-wide coverage.
- One synthetic message was saved as a draft, reopened, reviewed, sent only to the same Gmail account, then synced back into Inbox and observed in Sent. Reply, Reply All and Forward retained the owner; self-only Reply All had no recipients and Forward had blank recipients. Test-only unsaved drafts were discarded, and a local star toggle was restored.
- The configured model returned an automatic summary/reply and the per-message Summarize, Suggest Reply and Translate popups produced results for the synthetic message. An explicit Traditional Chinese translation worked; Use in Draft retained the locked From account. Suggest with History showed its downloaded-mail scope, permissions and message limit before Generate; history generation was not triggered. Today displayed the completed summary.
- Formatted mail rendered with external images blocked. Scrolling while the pointer was inside the white HTML area moved the reader to the bottom. External-link destination review and per-message image consent appeared; both were cancelled. Provider organization exposed Spam and its review boundary, without applying any move or label change.
- Native divider resizing and View → Reader Below/Reader on Right worked. Closing the red window button retained the same UI/service PIDs; reopening preserved the selected mailbox/message. In-app update checking reported beta.13 current. Back Up Workspace produced a readable database and matching encrypted-settings key while the service stayed available.

The walkthrough found two defects: Outlook history repeatedly failed after its first page because Graph returned `/v1.0/me/mailFolders('inbox')/messages` instead of the slash spelling; expanding/restoring the reader or switching Below/Right reset a manually enlarged list to its 260-point minimum. The local, unreleased provider correction accepts only the equivalent Inbox/Sent OData spelling and retains all origin, credential, fragment and folder checks; calendar pagination remains strict. One targeted regression in each runtime passed, and the corrected Node provider fetched the next real Outlook page read-only using the saved cursor, without updating the workspace/checkpoint. The existing native split helper now remembers the right-list width in memory; one focused native check preserved a 400-point width through both transitions and allowed a subsequent resize to 370. Both corrections were included in the later local installation described above. The saved Outlook failed import still requires a manual resume; no complete live Outlook import is claimed.

AI Studio's Summaries, Email Brain, My Skills and Local Activity pages opened without changing saved memory, skills or simulated records. Activity retained an Interrupted entry from closing a test assistant task, alongside later completed results; cancellation is not evidence of another model/network failure. The temporary private backup and screenshots used for diagnosis were removed after inspection.

The user corrected the embedding base URL to the API base, but Smart Search was disabled and neither account was selected. No new embedding batch was started or verified. At that initial walkthrough, writing-style learning and calendar connections were disabled/unconfigured. The later authorized Learning run is recorded above; calendar read/write remains unverified. No extra mail, provider organization, calendar event or permission change was made. This walkthrough did not rerun the full automated suites or create a new release.

## 0.6.0-beta.13 paired prerelease

[beta.13](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.13) was published at 2026-09-27T06:25:16Z from `b82ea3f7cd896d2112f3a72473da6ee7806fc786`. All five platform jobs and the publisher in [tag CI 36298327254](https://github.com/Coke1120/Morrow-Mail/actions/runs/36298327254) passed, including the complete macOS native suite, Windows settings/background-index regression, both packaged desktop and actual upgrade/restart/backup checks. The redundant main run was cancelled; the tag retained all release gates. Beta.11 and beta.12 were not published.

All six public assets were downloaded and checked: pinned Ed25519 manifest signature, exact sizes and SHA-256/checksum files, archive confinement, common version, Rust runtime, bundled OAuth registration, notices and absence of private workspace data or a separate Node backend. The public Mac package passed deep/strict ad-hoc codesign, plist, service version and CLI checks. Isolated live GitHub update checks report beta.13 available from beta.10 and current from beta.13; they did not contact mail or model endpoints.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macOS arm64 | 11,219,163 | `ad7c135e517b01906805d46ade7d30cae0b4bb7e8a33655d9f8291d9ed467d93` |
| Windows x64 | 167,922,505 | `0ee60f5c81b12df129d2bf5d958a6edd3f9ae743cea086b99155417332d5bf4d` |

Subsequent installed-app Gmail acceptance and the remaining Outlook/indexing limitations are recorded above. Existing ad-hoc Mac signing, unsigned Windows and incomplete live-provider/model acceptance limitations remain.

## 0.6.0-beta.13 local preparation

Postpublication startup inspection found that beta.10's asynchronous representable update could run before a native split-view ancestor existed, leaving the sidebar at half of a restored large window. Initialization now waits for window attachment and native layout, sets only the initial divider, and never falls through an incomplete inner split to an outer one. The mail list retains native flexible sizing; the sidebar and bottom-list starting sizes are set independently.

The delayed-ancestor native regression fails the beta.10 implementation and passes the correction. Checks also cover 1040/1877-point windows, bottom layout and manually adjusted dividers without a later model refresh. An isolated optimized production SwiftUI app (actual MorrowMailApp entry point, released Rust service, unique bundle/workspace and fictional cached mail) starts at a 230-point sidebar, restores a large window after quit/relaunch with the same initial sidebar width, and preserves a manual 400-point width when navigating to Today. No live provider/model request was made by these fixtures.

`npm run macos:test` and `CARGO_INCREMENTAL=0 npm run macos:rust:test` passed, including full SwiftUI compilation, the split/window/WebKit checks, Node native integration and the production Rust native lifecycle/mail/draft/backup harness. Release publication still requires the unchanged paired CI gates. The unpublished beta.11 tag was blocked by a fixture assumption: a 500-point bottom pane exceeded the CI screen-constrained window minus the reader minimum. A local 620-point window reproduces the clamp to 419 points. Beta.12 chooses a manual size within actual split bounds and retains exact size-preservation assertions, with an additional short-window case and geometry diagnostics. The unpublished beta.12 tag then exposed a manually assembled NSSplitView fixture with two zero-size panes on macOS 15: the helper ran, but the fixture had not called adjustSubviews before moving the divider. The fixture now detaches its prior window content, establishes the same sidebar minimum width as production, verifies pane topology and performs native sizing before testing the divider. The isolated macOS 15 workflow passes. A separate Windows background-index fixture exceeded its whole-test five-second deadline under CI load; its bound is now 30 seconds with HTTP cancellation, preserving the gated 202-before-model-completion and exactly-two-model-calls assertions. Both targeted jobs (macOS 15 window and Windows settings) pass in [manual CI 36298216962](https://github.com/Coke1120/Morrow-Mail/actions/runs/36298216962). The final fixture still fails against the beta.10 helper locally; the current full macOS suite passes. Production code is unchanged from beta.11; both failed tags and CI evidence remain intact.

## 0.6.0-beta.10 paired prerelease

[beta.10](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.10) was published at 2026-09-27T04:38:49Z from `fccfcbcb231a53935402b282353aaf38dc232476`. All five platform jobs and the publisher in [tag CI 36293293433](https://github.com/Coke1120/Morrow-Mail/actions/runs/36293293433) passed. Both desktop pipelines passed actual upgrade/restart/backup acceptance; the redundant main run was cancelled while the tag retained every required gate.

All six public assets were downloaded. The pinned Ed25519 signature, sizes, SHA-256/checksum files, archive paths and Rust/version/OAuth/notices metadata passed. Both packages contain no separate Node backend or private workspace data. The public Mac app passed deep/strict ad-hoc codesign, plist, service version and CLI checks. Isolated live GitHub checks using the published beta.9 and beta.10 services correctly report beta.10 available and up to date respectively; no mail/model endpoint was contacted.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macOS arm64 | 11,218,121 | `88fcd35ac96995e6fbb5323ba78b5909888fd230076ca46415580f88f55474bb` |
| Windows x64 | 167,920,967 | `df6921d44031554cd47708cf5a84c82883587d4af0bd055832d83f3ff12782c1` |

The cold-start sidebar issue found after publication is corrected separately in beta.13; beta.10 assets remain unchanged. Existing ad-hoc signing, unsigned Windows and incomplete live-model/provider acceptance limitations apply.

## 0.6.0-beta.10 local preparation

Both clients permit navigation away from Search/Model and closing Settings after a reviewed indexing start request returns. The service continues the batch while Morrow runs; Activity and reopening Search show progress. Pending save/test/start requests, unsaved forms and conflicting starts retain their guards. The loopback HTTP regression verifies 202 acceptance, progress with no settings polling, completion of the same job and duplicate-start rejection without extra model calls.

Workspace now precedes All accounts. Today displays downloaded mailbox totals and the existing latest 20 per-account summary jobs filtered to the local report day; opening it neither requests AI nor reads/marks message bodies. Native chrome puts controls in the sidebar/list/reader, exposes layouts in the macOS View menu and removes hard maximum sidebar/list dimensions. A compact initial divider avoids an oversized first-launch sidebar.

OAuth fixtures for Google and Microsoft distinguish network/429/5xx failure, invalid authorization and rejected app configuration. Rotated/omitted refresh tokens, expiry units, scope/client preservation, restart and replaced/disconnected-owner races pass. Credentials are retained on failure. This fixes misleading expiration messages and stale Node refresh writes; it does not establish why a particular live provider revoked consent.

Embedding fixtures complete three messages, including a 22-chunk message, over four OpenAI-compatible/Ollama requests. A later rejected request now exposes a safe HTTP/response/vector reason while preserving completed entries and making no automatic paid retry. No reproducible first-message indexing logic defect was found; the reported live-model failure remains unconfirmed without its actual model/error. Provider response text and keys are not returned in job errors.

Passed locally: `CARGO_INCREMENTAL=0 npm run rust:test` (102 Rust tests, strict fmt/Clippy, debug/release builds and seven Node↔Rust contracts); `MORROW_TEST_RUST=1 npm run check` (173/173, no skips, React build); `npm run macos:test` (full SwiftUI compilation, model/date/WebKit/window checks and native API fixtures); `CARGO_INCREMENTAL=0 npm run macos:rust:test` (production Rust/native lifecycle, account isolation, paging, drafts and online backup). WebKit checks cover bidirectional wheel/trackpad handoff, the selectable end of capped long mail, million-point text and giant-image bounds, width reflow, blocked scripts/resources and reviewed link protocols.

An isolated native walkthrough visually checked Workspace order, Today/history, removed toolbar, sidebar hide/show and reader expansion/restoration. Native divider controls accepted a 380-point sidebar and 600-point mail list; the system View menu changed to bottom reading with a 240-point starting list. The Settings computer-use bridge remained unreliable while the fixture app stayed alive, and browser automation was unavailable; a full settings click-through is not claimed. Background progress is covered by HTTP fixtures. Fixtures used no real mail/model operations. Paired CI, public package verification and signing limitations are recorded separately when publication completes.

## 0.6.0-beta.9 paired prerelease

[0.6.0-beta.9](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.9) was published as a prerelease at 2026-09-26T20:35:06Z from tag commit `d9026841a93f07079440c6cf098cdaf315a21f54`. All five required platform jobs and the publisher in [tag CI 36267966420](https://github.com/Coke1120/Morrow-Mail/actions/runs/36267966420) passed. The redundant main run for the same commit was cancelled; the tag ran the complete unchanged gates.

The release includes message AI popups, explicit same-sender history replies, compact reader details/summaries and the saved embedding Test Connection under Search. CI passed 98 Rust tests, strict fmt/Clippy, debug/release builds and seven Node↔Rust contracts; the Node suite passed 160 cases with two conditional Rust cases skipped (covered by the separate contracts). Local checks passed all 162 Node cases with those gates enabled. Both desktops passed package/launch checks and original updater plus actual old-installer-to-Rust upgrade/restart/backup acceptance. Windows packaged smoke verified fresh onboarding, owned inbox/search/paging/drafts, private API and normal exit.

All six public assets were downloaded. The pinned Ed25519 manifest signature, exact archive sizes/SHA-256/checksum files and safe archive paths passed. Both bundles identify beta.9 and the Rust runtime, include Google Desktop OAuth configuration and dependency notices, and contain no standalone Node backend or private workspace database/key/recovery files. The downloaded Mac app passed deep/strict ad-hoc codesign and plist validation, reports the correct service version and runs CLI help.

A live read-only update check using the downloaded Rust service in a fresh disposable workspace identified beta.9 and correctly reported no newer update. The canonical Node checker with installed version beta.8 reported beta.9 available. No mail, calendar or external model endpoint was contacted; no installed app or existing workspace was replaced.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macOS arm64 | 11,138,973 | `3019ec8dc7cbbd4b27eb62ab634746be7ac1c85267d61c8be0ea26a7335beb24` |
| Windows x64 | 167,975,625 | `c70848394451eba84d004bb5bf6f9197794fbec03ad1397e21673bea4c5a0320` |

The focused native popup walkthrough and its Settings automation limitation are recorded below. History uses downloaded, permitted mail with the saved context/body limits; it does not fetch or analyze an unlimited provider mailbox. This remains an ad-hoc signed/unnotarized macOS and unsigned Windows beta, with live-provider/model and complete manual UI/accessibility acceptance still pending. Existing published assets were not replaced.

## 0.6.0-beta.9 local preparation — reader assistance and compact layout

Per-message Summarize, Suggest Reply and Translate now open an account-bound popup without changing the mailbox, selection or page. Suggest with History separately reviews the saved model, permissions and limit before generating, then reports used/matched downloaded messages. Both services scan exact same-sender metadata in the owning account and take the selected message plus newest permitted matches up to the saved 1–50 limit. Unchecked fields are withheld; historical bodies are bounded to 5,000 UTF-16 characters and the target to 18,000. Source, connection, permission, writing-style and relevant Email Brain changes invalidate results. Only an explicit Use in Draft creates an editable reply; nothing is sent automatically.

The reader combines sender and time, retains complete recipient/mailbox metadata behind Details, and collapses long AI summaries. Native View/Sort menus use content-sized controls with more space for reading. Search exposes Test Connection for the saved embedding endpoint/model and Edit in Model in both clients; Model retains tests for unsaved fields. Probe results/errors appear at the top and only a fixed sentence is submitted, with no settings or index write.

Passed locally: `MORROW_TEST_RUST=1 CARGO_INCREMENTAL=0 npm run check` (162/162 tests, no skips, React production build); `CARGO_INCREMENTAL=0 npm run rust:test` (98 Rust tests, strict all-target Clippy/rustfmt, debug/release builds and seven Node↔Rust contracts); `npm run macos:test` (model/WebKit/window checks, full SwiftUI compilation and native fixture API); `npm run macos:rust:test` (production Rust/native ownership, paging, drafts/Bcc, backup and restart). New tests exercise deterministic sender history, redaction, bounds, source/permission/reconnect races, independent Brain-source invalidation and unchanged ordinary reply behavior. React SSR/context checks cover popup guards and compact metadata; they do not simulate clicks.

An isolated native SwiftUI walkthrough with fictional mail and injected model responses passed Summarize, Suggest Reply and Translate popups, closing back to the original selected inbox message, explicit History scope → Generate → matched counts → Use in Draft with the original locked From account, and discarding the unsaved fixture draft. The compact reader/sidebar/View/Sort layout was visually inspected. Opening Settings again closed the computer-use bridge while the app remained running, so native Search Test Connection click-through is not claimed; saved-probe API contracts pass. The fixture was stopped and removed. No real account/provider/model call or owner's workspace was used.

The local beta.9 Rust macOS package also passed `npm run macos:build`, deep/strict ad-hoc codesign and plist validation. `npm run updater:rust-upgrade:test` passed the original Node installer → actual SwiftUI/Rust candidate replacement/restart, both-PID wait, previous-app retention, encrypted settings/key/uncertain draft/calendar-retry preservation and bundled backup restoration. The installed app was not replaced.

Publication subsequently passed the paired tag workflow, updater/upgrade jobs and post-download signature/hash checks recorded above. Ad-hoc macOS signing, unsigned Windows, live-account and complete manual UI/accessibility acceptance limitations remain.

## 0.6.0-beta.8 paired prerelease

[0.6.0-beta.8](https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.6.0-beta.8) was published on 2026-09-26 at 19:06:21 UTC from tag commit `a0abf9e23aec25b3a5ebdc719474baac93bb1590`. All five required jobs and the publisher in [tag CI 36263198738](https://github.com/Coke1120/Morrow-Mail/actions/runs/36263198738) passed: Ubuntu/macOS/Windows full checks, dependency audits and benchmarks, both desktop packages, native/packaged acceptance, original updater tests and actual old-installer-to-Rust upgrade/restart/backup preservation on both platforms.

The full Rust suite contains 96 tests; strict fmt/Clippy, debug/release builds and seven Node↔Rust contracts passed. CI's Node suite passes 152 tests with two conditional Rust cases skipped there; the separate seven-case contract run passes without skips. Local `MORROW_TEST_RUST=1 npm run check` also passed all 154 cases and the React production build. Windows packaged smoke verifies fresh Add account onboarding without Demo, then an owned fictional mailbox: manual unread, search/highlights/saved search, bounded pages, complete drafts, private API and normal exit. Both local Rust and Node compatibility modes pass the same two cases. No owner's workspace or live provider writes were used.

All six public assets were downloaded after publication. The pinned Ed25519 manifest signature, exact ZIP sizes/SHA-256/checksum files and safe archive paths pass. Both packages identify version 0.6.0-beta.8 and the Rust service, include bundled Google Desktop OAuth configuration and dependency notices, and contain no standalone Node backend, workspace database, encryption key or recovery files. The downloaded macOS app passes deep/strict ad-hoc codesign and plist checks; its service reports the correct version and its CLI help runs. The canonical public update API reports beta.8 as available from beta.4.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macOS arm64 | 11,024,736 | `7eab8cfcf2f28e836fa099cc6bd377c53b57faca11ee0576899905e8253a2de4` |
| Windows x64 | 167,905,711 | `a80e62a2c97b5df9a927749d00e8eeab40534e880ef9dcac6c3a75c5a3f0bb6c` |

Prepublication candidates beta.5–beta.7 remain unpublished. Beta.5 was cancelled when the repository rename exposed the old update API's 301 redirect; both services now use canonical `Coke1120/Morrow-Mail` URLs without relaxing redirect/signature checks. Beta.6 found a stale visible-Demo smoke assumption. Beta.7 passed Windows fresh onboarding but timed out during shutdown; disposable workspace cleanup now runs in the external driver after Electron exits, avoiding deletion while Chromium can hold file locks; beta.8 passes both exits. Published older assets were not replaced. **Beta.4 and earlier need one manual download** because their installed updater still uses the old API path.

This is an ad-hoc signed/unnotarized macOS and unsigned Windows prerelease. Live-account/provider approval, other hardware/minimum OS, full manual UI/IME/accessibility acceptance and stable signing remain pending. The local preparation evidence and feature-specific limits below remain applicable; passing fixtures is not stable-production certification.

## Safe reading, layout and import recovery — 0.6.0-beta.8

Newly fetched Gmail/Outlook/IMAP messages retain sanitized HTML for reading, separately from plain-text search/AI context. The reader disables active content and blocks images until per-message consent. Native UI stays SwiftUI; only the message body uses a private, script-disabled WebKit view. Provider organization adds reviewed Gmail Spam and Outlook Junk moves. Phishing reports and sender blocking remain provider-site actions. Right/bottom/focused layouts, expanded reading, unread-row styling, General preference auto-save and macOS close-to-Dock behavior are implemented.

Passed locally: full Node checks (154/154, no skips, React production build), full Rust suite (96 tests), strict all-target Clippy and rustfmt. A subsequent sanitizer depth regression passes with all four HTML tests, including 12,000-level closed/unclosed input in a separate process with a 2 MiB stack. History tests cover durable 30/120/300-second bounded read retries, pause/reconnect/disconnect invalidation, auth/schema/cursor/database failures without automatic retries, and fixed allowlisted status messages that never expose stored provider errors or tokens. Provider fixtures verify Spam/Junk identity, permissions and restoring Gmail Inbox without Spam.

`npm run macos:test` passes model checks, complete SwiftUI compilation, the native API fixture and two new executable checks: actual WebKit rejects script execution and sends zero requests for default-blocked images/frames/scripts; native window close/reopen preserves busy work and unsaved forms. `npm run macos:rust:test` passes production Rust/native integration, account-owned reading, paging, drafts/Bcc, online backup, restart and OAuth boundaries. The final targeted reader/settings tests and React build also pass. The rebuilt local Rust macOS app passes deep/strict ad-hoc codesign and plist validation; it remains an unpublished development build, not a notarized release.

A built-React walkthrough with fictional local mail observed formatted body/link rendering with blocked images, right/bottom/focused layouts, General auto-save across a tab switch, and failed-import Resume changing to queued work. It found an unread-sender CSS specificity issue, corrected to inherit the whole unread row's weight. The browser automation connection then failed during the external-link confirmation check, so that interactive step is not claimed as verified; protocol validation, CSP and sandbox controls are covered by executable tests. The fixture service was stopped and its temporary workspace removed. No owner's workspace, real provider write or paid AI request was used. Windows execution, live-provider acceptance, malware/phishing detection and attachment/CID rendering are not established by these checks.

## Gmail coverage and visible activity — 0.6.0-beta.8

Gmail refresh now checks Inbox, Sent, Drafts, Starred and All Mail with bounded pages. All Mail history imports retain the selected date range and durable checkpoints. Both services refresh provider metadata while preserving explicit local changes, heal legacy forced Inbox/Sent classification, and keep confirmed provider label changes separate from local folder overrides. Imported provider drafts require a new local copy before editing/sending; owner and To/Cc/Bcc remain bound and the original stays unchanged.

Both clients show independently polled Mail and AI activity. The endpoint projects safe account/status/counter metadata for fetching, queued history, summaries, learning and embedding indexing. History fetching is distinguished from manual refresh and counted once. Unknown historical counters remain unknown; progress does not assert total mailbox coverage or trigger work.

Passed locally: `MORROW_TEST_RUST=1 CARGO_INCREMENTAL=0 npm run check` (137/137 tests, none skipped, React production build); `CARGO_INCREMENTAL=0 cargo test --manifest-path rust/Cargo.toml --locked` (87 tests); strict all-target Clippy. Google provider fixtures use isolated TLS and cover all five scopes, user-only label names, caps and redirects; sync/organization tests cover refreshed labels, local overrides, primary folder precedence, duplicate owners, provider drafts, uncertain-send replay and pre-network validation. Activity tests cover running/completed/interrupted work, retention, disconnected owners, safe projections and manual/history separation.

`npm run macos:test` passed native model assertions, full SwiftUI compilation and the Node fixture client. `npm run macos:rust:test` passed the production Rust service with the isolated native client, including the new authenticated activity response plus reading, paging, account routing, drafts/Bcc, backup and restart. The model checks verify Gmail draft copies have no provider draft ID and preserve recipients.

A browser walkthrough of the built React app used fictional local messages and injected provider fixtures. It observed fetching → completed activity for all five scopes, history queued → paused, archived starred mail with its user label, and saving a Gmail draft as a second local draft with normalized To, retained Bcc and locked owner. The original remained visible. There were no browser console errors; the test server and tab were closed and the temporary workspace removed. This is fixture/browser evidence, not native visual automation, Windows execution or live Google/model acceptance. No real provider write or paid model call was made. The rebuilt local macOS Rust app also passes deep/strict ad-hoc codesign and plist validation; it is an unpublished development build.


## Embedding and learning actions — 0.6.0-beta.8

Both clients now offer embedding Test Connection with unsaved model fields, Index Now with a saved-scope/budget confirmation, and Learn Now with an account-bound Sent-sample confirmation. Learning generates a proposal; Save Approved Style remains a separate action and preserves manual Email Brain contacts, notes and voice.

Local checks passed: `npm run check` (117 passed, two gated tests skipped, React build); Rust smart-search fixtures (11/11) and strict lib/smart-search clippy; full SwiftUI compilation and both Node/Rust native integration harnesses. The fixed embedding probe checks unsaved fields, saved-key reuse/clear/origin change, auth/Origin boundaries, invalid responses and unchanged settings/index; Rust also covers concurrent-probe rejection. Learning checks cover saved opt-in, permission/model/busy gates, proposal replacement, cancellation and Brain isolation. The rebuilt local Rust macOS app passes deep/strict ad-hoc codesign and plist validation; it has not been published.

A browser walkthrough of the actual built React client used a temporary fictional mailbox and injected model fixtures. It passed unsaved embedding Test Connection, Index Now cancel/confirm/completion, Learn Now cancel/confirm/proposal, and explicit Save Approved Style activation. Cancelling retained previews and made no analysis/indexing call. The fixture server and tab were closed afterward. This is browser UI evidence with isolated Node services, not native visual or Windows packaged execution, and no live provider or external model acceptance is claimed.

## Mail reading and account/settings UX — 0.6.0-beta.8

The current native inbox retains its page, visible metadata rows and selection across read-state revisions. The isolated Rust native harness explicitly opens and switches unread messages on page two, then refreshes without a reset; all six sorts, combined duplicate IDs, manual unread handling and source-account ownership remain covered. Both clients remove Demo from navigation, settings and sender choices, with Add account onboarding and a real-account default for legacy Demo selections. Internal fixture data is retained. Embedding connection fields now live in Model; Search keeps scope, budget and index review. Reply All deduplicates sender/To/Cc and excludes the owner and original Bcc; plain-text Forward locks the source owner, starts with blank recipients and does not include attachments or reply threading.

Passed locally: `npm run check` (114 passed, two gated tests skipped, React build passed); both gated contracts passed with `MORROW_TEST_RUST=1 node --test tests/rust-service.test.js`; Rust storage tests (2/2) and strict lib/storage clippy; `npm run macos:test` (native model assertions, complete SwiftUI compilation and Node fixture integration); `npm run macos:rust:test` (production service with isolated Swift client, migration, paging, startup/account selection, draft/backup/restart and OAuth boundary checks). Composer rendering checks open fresh, Reply All and Forward forms and verify owner-locked sender options without Demo; recipient checks cover quoted names, malformed inputs, deduplication and Bcc privacy. Search/Model partial-save checks retain key preservation/clear/origin-change semantics and prevent stale panels overwriting one another.

The local `npm run macos:build` candidate also passes deep/strict ad-hoc codesign and plist validation. These changes have not been released. These are local fixture/client checks, without live provider sends, Windows execution or UI automation claims.

## Built-in Microsoft OAuth — 0.6.0-beta.4

[0.6.0-beta.4](https://github.com/Coke1120/genmail/releases/tag/v0.6.0-beta.4) was published as a paired prerelease on 2026-09-25 at 17:49:28 UTC from `c758a47b2cd5c1b01052cfa111f090f291311691`. All five checks and the publisher in [tag CI 36165971063](https://github.com/Coke1120/genmail/actions/runs/36165971063) passed: Ubuntu/macOS/Windows full tests, lint, dependency audits and benchmarks, both desktop packages, native/packaged smoke and actual old-installer upgrade/restart/backup restoration. Each platform passed 74 Rust tests and seven Node/Rust contracts.

All six public assets were downloaded. The pinned Ed25519 manifest signature, archive sizes, SHA-256/checksum files and safe archive paths passed verification. Both packages have matching release/runtime metadata, the supplied Microsoft ID embedded in the service, bundled Google OAuth configuration and dependency notices, without a separate Node backend or workspace database/key/recovery files. The public macOS app passes deep/strict ad-hoc codesign and plist validation; its service reports `0.6.0-beta.4`. Windows executable acceptance comes from CI; the public ZIP was inspected locally.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macOS arm64 | 10,780,310 | `80e5e0be77418d45dba500c3caf11332f4e349c5932f1258d35274ff14ead08a` |
| Windows x64 | 167,725,605 | `1ffc97d691b1b4c5c7bf653675906630db0b323aa7a06ffda27c1bacf4766542` |

The supplied public Microsoft application ID is shared by the Node and Rust services. SwiftUI and React now offer default Microsoft mail/calendar sign-in without credential fields, while retaining advanced custom registrations. Default public-client requests never inherit a saved custom client secret. Published 0.6.0-beta.3 assets are unchanged.

Local verification passed: `npm run check` (108 passed, two gated Rust HTTP tests skipped, React production build passed); both skipped contracts passed separately with `MORROW_TEST_RUST=1 node --test tests/rust-service.test.js`. Rust calendar/OAuth fixtures passed 6/6, strict all-target clippy passed, and `swift build --package-path macos` plus `npm run macos:rust:test` passed. Coverage includes default/custom selection, mail/calendar scopes, browser-bound PKCE handoff, callback handling, rejection of mixed default/custom credentials and non-reuse of legacy secrets.

These are isolated fixtures and native/packaged checks, not verification of the Entra registration or live Microsoft consent/token exchange. No live provider writes were performed. Existing ad-hoc signing, unsigned Windows, minimum-OS/hardware and manual/live-account acceptance limitations remain disclosed.

## Agent CLI — 0.6.0-beta.3

[0.6.0-beta.3](https://github.com/Coke1120/genmail/releases/tag/v0.6.0-beta.3) was published as a paired prerelease on 2026-09-25 at 14:05:17 UTC from `5cd67626d33de53f9b55b6cdfbd5a4ca27502779`. All five checks and the publisher in [tag CI 36141813599](https://github.com/Coke1120/genmail/actions/runs/36141813599) passed: three-platform full tests/lint/audits/benchmarks, both desktop builds, native/packaged smoke and actual old-installer upgrade/restart/backup restoration. The corrected Windows HTTP fixture passed in 24.22 seconds, with all assertions retained.

All six public assets were downloaded and verified against the pinned Ed25519 manifest, ZIP sizes, SHA-256/checksum files and archive-path rules. Both packages contain the matching version, Rust service with CLI, bundled Google OAuth registration and dependency notices, without a separate backend Node runtime or workspace database/key/recovery files. The public macOS package passes deep/strict ad-hoc codesign and executes both `--version` and `cli --help`. Windows execution evidence comes from CI; its public ZIP layout and embedded CLI were inspected locally. Existing signing, manual/minimum-OS and live-account limitations still apply.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macOS arm64 | 10,774,305 | `9fe547740d90202764bf90f3ef249822b1549e4788138b444948a3e27492765b` |
| Windows x64 | 167,725,792 | `29a55104dea8c9d6415b7643718a05b210f1e180c3ae912f144099b803013d1c` |

`morrow-service cli` now supports JSON accounts, cached list/search/read, owned drafts, review and explicitly confirmed sending, both attached to a running app and standalone with exclusive workspace ownership. It has a separate owner-private endpoint token, no background scheduler and no implicit provider read/AI calls. See [CLI usage and limits](docs/CLI.md).

Local `npm run rust:test` passed with 74 Rust tests, seven Node/Rust contracts, strict clippy/rustfmt and locked debug/release builds. Three CLI integration cases launch real processes against isolated fictional workspaces: closed/running app access, account collisions and numeric paging, unchanged unread state, footer/To/Cc/Bcc, changed draft/sender/connection rejection, success replay, retained uncertain request IDs, token scope, Origin/body limits, stale endpoints and writer exclusion. Follow-up fixtures also cover copied-workspace isolation and a port impostor replaying an old health proof: no bearer or message is transmitted before fresh workspace-bound proof validation. Delivery in subprocess tests is explicitly simulated; no real provider mail was sent. Existing isolated TLS mail/SMTP tests remain the provider-delivery evidence. `npm run macos:rust:test` also passed with the updated service, including native lifecycle/restart, owned drafts/Bcc, online backup, local OAuth handoff and Node↔Rust encrypted persistence.

All five jobs in [CLI CI 36130997950](https://github.com/Coke1120/genmail/actions/runs/36130997950), source `eb80d6fd3226a6feb855b4ba5384b0b755cf1640`, passed: Ubuntu/macOS/Windows full checks, strict Rust lint/format checks, Node/React tests, dependency audits and benchmarks, plus both desktop packages, native/packaged smoke and actual old-installer upgrade/restart/backup acceptance. The first post-merge run had a Windows background fixture timeout; its wait is now bounded at 30 seconds, with production deadlines and assertions unchanged. This preliminary source verification preceded the complete tagged release checks recorded above. Already published v0.6.0-beta.1 assets are unchanged.

The unpublished 0.6.0-beta.2 candidate passed both desktop jobs, Ubuntu and macOS checks. Its Windows cross-runtime HTTP fixture stalled on the first attempt and explicitly exceeded its 30-second total timeout on retry; all 74 Rust tests and the other six cross-runtime contracts passed. The fixture now has a 120-second total budget, retains the 15-second startup bound, adds 15-second request bounds, kills and awaits children on startup failure or test cancellation, and bounds graceful shutdown and backup commands. All functional assertions and product deadlines remain unchanged. The failed candidate tag is retained; 0.6.0-beta.3 subsequently passed the complete paired gates before publication.

## Rust prerelease cutover — 0.6.0-beta.1

Rust is now the approved default desktop backend; explicit Node compatibility builds remain available. [0.6.0-beta.1](https://github.com/Coke1120/genmail/releases/tag/v0.6.0-beta.1) was published as a paired prerelease on 2026-09-25 at 05:00:07 UTC from tag commit `ebe0ccba967c180580b8ee1460ae67f58011b61b`.

All five checks and the publisher in [tag CI 36094625556](https://github.com/Coke1120/genmail/actions/runs/36094625556) passed: Ubuntu/macOS/Windows Rust and Node/React checks, dependency audits and benchmarks, both actual desktop builds, native/packaged checks, original updater checks, and macOS/Windows old-installer-to-Rust upgrade/restart/backup restoration. Local release preflight also passed `npm run rust:test` (71 Rust tests and seven cross-runtime contracts), `npm run check`, the default-runtime macOS build and actual-package upgrade acceptance.

All six public release assets were downloaded after publication. The pinned Ed25519 signature, both ZIP sizes/SHA-256/checksum files, safe archive paths, common 0.6.0-beta.1 version and Rust runtime metadata passed verification. Both contain bundled Google OAuth configuration and dependency notices, without a backend Node runtime or workspace database/key/recovery files. The public macOS ZIP exactly matches the CI archive and passes deep/strict ad-hoc codesign verification. The beta.2 public key, Node manifest/archive validator and original installer are unchanged.

| Public archive | Bytes | SHA-256 |
| --- | ---: | --- |
| macOS arm64 | 9,463,109 | `8fe4f0a66b4c7f50668ac282481b4b3eb126125e47713d8108391326e2ed9b5d` |
| Windows x64 | 166,320,673 | `a1ef99c56dc11499248f3201cb35a6222ce4d7db80a4183d81b95d53062cbca0` |

The tagged service benchmarks passed every correctness check at 1k/10k/50k. Warm lexical p95 at 10k/50k was 25.21/66.28 ms on Ubuntu, 40.86/81.53 ms on macOS and 54.83/149.39 ms on Windows, within the plan's fixture budgets. These remain service-only, warm-cache fixture samples, not whole-app or arbitrary-hardware guarantees.

Ad-hoc macOS signing, unsigned Windows distribution and the manual/minimum-OS/live-account limitations remain disclosed. The earlier candidate and walkthrough evidence below is historical; this prerelease does not establish stable production certification or M6 Tauri completion.

## Pre-cutover Rust candidate — 25 September 2026 (local and CI)

M0 measurement tools, M1 paged clients, M2 read worker and M3–M5 service functionality are implemented. **At this pre-cutover snapshot, the packaged default was Node and Rust selection was explicit and failed closed.** This is a tested candidate, not a claim of stable production distribution or M6 Tauri completion. See [the compatibility inventory and remaining gates](docs/RUST_MIGRATION_INVENTORY.md).

- Local `npm run check`: 110 Node test entries, 108 passed and two explicitly gated Rust HTTP tests skipped; React production build passed. Rust-only contracts run separately under `npm run rust:test`.
- Rust fixtures cover Gmail/Graph and IMAP/SMTP over isolated TLS, OAuth, all AI catalog workflows, learning, imports, schedules, search/index cancellation and budgets, original retry fingerprints, duplicate-owner IDs, shutdown, panic/disk-full transaction rollback, abrupt process death with on-disk journal recovery, writer exclusion and verified backup restore. `npm run rust:test` passed: rustfmt, clippy with warnings denied, 71 Rust tests, locked release/debug builds and all seven Node/Rust contracts. Additional recovery checks retain a stale index-completion marker across reopen; empty-vector reconciliation succeeds with SQLite writes disabled after permission generations are recorded.
- `npm run macos:test` and `npm run macos:rust:test` passed. The new harness launches the actual AppModel against a production Rust service in an isolated temporary bundle, exercises all six sorts across 130 colliding-ID rows, full-body/draft ownership, unread state, Bcc, permissions, simulated AI/workflows, localhost OAuth handoff, disconnect/cache retention and two clean restarts. Node reopens the Rust-written encrypted settings. The visible backup control now calls the engine-aware AppModel helper; its online backup preserves both connections, duplicate-owner mail and the saved Bcc draft, rejects overwrite without changing bytes, and keeps the service available. Node successfully opens/decrypts this snapshot after service shutdown. Native locale uses BCP47, including region extensions.
- An isolated copy of the actual native Rust app was also exercised through accessibility: 65-message inbox, Next to the 15-row second page, and full Traditional Chinese message text. Opening unread mail updated the badge and refreshed the list to page one while retaining the reader, consistent with revision-bound cursors. The automation connection failed when opening Settings (`native pipe closed before response`) and after one reset; both fixture processes remained running and were then cleanly closed. Settings visual/IME acceptance is not claimed.
- Actual Electron/React development smoke passed with both Node and Rust backends. The Windows Rust packaged executable also passed authenticated renderer, inbox, search/highlights/saved search, paging, full-draft loading, sandbox and private API smoke checks. API/client harnesses do not replace manual UI/IME/accessibility acceptance.
- Rust updater unit/integration fixtures passed, as did the original Node updater suite. `updater:rust-upgrade:test` passed on macOS and Windows: the unchanged Node installer verified and installed copies of the actual Rust candidates, waited for both PIDs, restarted production SwiftUI/Electron with Rust, preserved each fixture workspace and old app, and restored a backup made by the installed service. Existing client recovery values must remain byte-identical while the UI may add normal preferences; backup must preserve the complete post-restart snapshot. Windows native API checks verify protected staging and owner/System-only DACLs. Workspace path preservation is also asserted on a real Rust-helper restart.
- The final local macOS candidate from `f2f6801` passed ad-hoc deep/strict codesign, bundle metadata/common-version checks and actual old-Node-installer upgrade/restart/backup restore. Its packaged service SHA-256 is `1bc1e1c8925f911e362ad855f0b2a9ee07c2ad0337f6a207c6c3e13eaf82d98b` (21,990,864 bytes); bundled version is `0.5.0-beta.2`. It contains the Rust service and 2,661,345 bytes of dependency notices, without a backend Node runtime. Later changes only adjusted Windows/test fixtures and documentation. This is not Developer ID signing or notarization; the Windows candidate remains unsigned.
- Locked dependency audit (`cargo-audit 0.22.2`) reported zero vulnerabilities and zero warnings locally. Packaging collects normal/build dependency notices and source links, including OpenCC and nested upstream notices.

All five check jobs in [CI run 36050110233](https://github.com/Coke1120/genmail/actions/runs/36050110233), source `5ff69436372316e120805c34fb62529f6730cf7f`, passed: Ubuntu/macOS/Windows general checks, dependency audits and benchmarks, plus both macOS/Windows Rust desktop jobs. Default Node packages, native/packaged smoke and the original updater checks also passed. The release job was skipped. Earlier Windows runs exposed fixture tooling/path assumptions and a whole-client-state comparison that incorrectly rejected a normal added preference; fixes retained production verification and exact existing recovery values. Subsequent documentation-only changes record these results without changing the tested product code.

All provider/model traffic used isolated generated fixtures, with no real send, calendar write, paid inference or owner workspace. This historical manual CI run did not publish a release or change the then-default Node runtime. The later approved prerelease cutover is recorded above; signing/notarization, minimum-OS/manual UI and live-account acceptance remain outstanding.

### Native Rust walkthrough — 25 September 2026

Used an isolated copy of the actual macOS Rust candidate (service SHA `1bc1e1c8925f911e362ad855f0b2a9ee07c2ad0337f6a207c6c3e13eaf82d98b`), with a unique bundle identity and temporary workspace. Two fictional accounts contained 65 messages each with colliding provider IDs; sync and AI were disabled.

- Passed through the native UI: 50/15-row inbox paging, full Traditional Chinese message text, unread badge updates, combined 130-message view and distinct owner labels. Opening an unread message refreshed the revision-bound list to page one while retaining the reader.
- `subject:發票` returned 26 matches across both accounts. An empty search operator showed validation. The second account's result opened its own body, and Reply locked From to that account.
- The unsaved-draft warning and Keep Editing retained content. Review displayed exact From/To/Cc/Bcc/subject; Send was cancelled. Saving created one draft under the second account. After quitting/reopening the App, its Chinese body, recipients and owner remained intact.
- After fixture shutdown, Node reopened/decrypted the workspace and verified both connections, all 130 inbox rows, read flags, the owned draft and no delivery attempts. The temporary bundle/workspace were then removed.
- **Blocked:** opening Settings caused the automation service to exit; reset/reconnect failed again. Both new crash reports identify `SkyComputerUseService`, `EXC_BREAKPOINT` / `SIGTRAP`, with `_assertionFailure` and `Array.remove(at:)` frames. Morrow and its Rust child remained running; a one-second sample found the UI main thread waiting in the AppKit event loop, and the private service still returned 401 to an unauthenticated health request. This establishes an automation crash, not successful Settings or backup UI acceptance.

This walkthrough is partial. Settings/online-backup controls, all six sort modes, IME composition, Windows UI and live providers were not completed in this pass. Chinese text was pasted, not entered with an IME. Earlier automated backup/sort/platform checks remain separate evidence. No product code changed; the local report and process sample are under ignored `test-results/rust-walkthrough-20260925/`.

### M0/M1 historical baseline and read-worker comparison

The following was measured before the complete service port and is retained as a data-flow baseline. It must not be used as a direct RSS ratio against the standalone Rust service: the Node sample includes its driver.

On this Apple M4 / Darwin 27.0.0 / Node 26.7.0 host, the state request changed as follows. The new response contains 50 metadata rows; the baseline contains the entire selected mailbox, including bodies.

| Fixture messages | Baseline bytes | Paged bytes | Baseline warm p50 / p95 (ms) | Paged warm p50 / p95 (ms) |
| --- | ---: | ---: | ---: | ---: |
| 1,000 | 1,436,833 | 26,686 | 12.05 / 14.04 | 1.89 / 3.37 |
| 10,000 | 14,344,355 | 26,849 | 151.74 / 154.11 | 2.59 / 3.47 |
| 50,000 | 71,819,978 | 27,006 | 906.54 / 910.22 | 5.39 / 7.16 |

At 50,000 messages, the measured request stopped calling `listMessages` (formerly four calls); settings reads fell from 29 to 15. Warm lexical HTTP p50/p95 was 42.42/42.80 ms on the revised Node path and 29.17/29.40 ms with the release Rust worker. Sampled Node/driver plus worker RSS was about 173.9 MB, of which the worker was 6.9 MB, with two service processes. The Rust round trip on the first query was 16.40 ms including its SQL execution. These figures do not isolate IPC or establish overall application memory/latency.

Each size uses a new process and workspace, two fictional accounts, colliding IDs, mixed English/Chinese text and 1 KiB bodies. Five warm samples are descriptive, not a statistical performance guarantee. The benchmark includes the in-process HTTP driver, excludes UI/parent harness, does not flush OS file caches, and measures Node CPU rather than total worker CPU. It uses unchanged SQLite FULL/DELETE durability. The complete service now has separate locale, indexing and idle fixtures; whole-app RSS, MainActor/slow-account UI traces and minimum-OS acceptance remain separate gates.

### Complete Rust service performance

The service benchmark uses a copied immutable release binary, two fictional accounts, 1 KiB bodies and 1,000 / 10,000 / 50,000 rows. It records migration and restart separately, five warm requests, service PID RSS/CPU separately from the Node driver, 30 seconds idle and recovery of 1,000 missing derived index rows. Exact final measurements are stored under ignored `test-results/migration-rust-service.json`.

Standalone service measurements on Apple M4 / Darwin 27, source `f2f6801`, release SHA `064adb203309d633114cbed8df3827a8bfd4425b5482707ce778458bd4e20fcb` (22,119,344 bytes):

| Rows | Warm state p95 ms | Lexical p95 ms | Page p95 ms | Sender p95 ms | Migration / restart ms | Service sampled RSS MiB | CPU over 30s idle ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 2.80 | 11.22 | 1.04 | 3.59 | 52.33 / 5.56 | 21.28 | 40 |
| 10,000 | 2.59 | 16.54 | 1.22 | 26.31 | 346.69 / 7.79 | 21.11 | 30 |
| 50,000 | 27.20 | 43.97 | 1.83 | 124.54 | 1579.10 / 17.75 | 21.30 | 40 |

At 50k, state/search/page/revision payloads were 26,932 / 22,733 / 20,764 / 73 bytes. All count, sender ordering, distinct-owner cursor, bounded metadata and single-writer assertions passed. Migration includes the consistent backup and first construction of the source-metadata expression index; the migration/restart difference is not a measurement of index creation alone. These are service measurements, not whole-app memory or UI responsiveness.

A 50,000-row partial rebuild initially delayed one state request by 3.81 seconds. Repeated traces identified SQLite sorting/JSON reads blocking the shared DB queue; HTTP body transfer/decoding was below 0.2 ms. Covering anti-joins and separate indexed/missing aggregation first reduced matched state requests from 351–471 ms to 164–198 ms. A source-metadata expression index then removed the missing-row JSON scan. The final main run recovered **1,000 missing rows in a 50,000-row workspace** in 0.99 s, with a largest concurrent state request of 42.80 ms. Counts, metadata-only responses and paging stayed correct. Earlier reports are retained separately; these partial-rebuild results do not establish complete-index-loss or arbitrary-body-size performance.

A separate complete-loss run removed all 50,015 derived rows, including demo mail, and required both real-account coverage and the rebuild warning to reach completion. The final binary restored them in 44.11 s; 252 concurrent state samples had p50 / p95 / maximum of 31.71 / 47.18 / 59.37 ms. Counts, metadata, cursor ownership and monotonically increasing search coverage/expected IDs passed throughout. The report is `test-results/full-loss-after-empty-reconcile.json`. Before the metadata index, the same fixture took 100.08 s with state p95 663.76 ms. An intermediate run recorded an unexplained 2.24 s server-wait spike; it was not reproduced in subsequent runs and is retained in the evidence. Profiling separately confirmed unnecessary empty-vector DELETE journal/fsync work in state/tick reconciliation, now skipped after recording permission generations. This does not prove that it caused the isolated spike. SQLite FULL/DELETE durability is unchanged; no cold-OS-cache, arbitrary body-size, Windows or whole-UI latency claim follows from these Mac runs.

CI run 36050110233 also reproduced the 1k/10k/50k corpus with Node, the Rust read worker and the complete Rust service on both desktop platforms. The complete service's 50k warm lexical p95 was 79.72 ms on the macOS 15 Apple M1 virtual runner and 154.31 ms on the Windows 10.0.26100 AMD EPYC 7763 runner; state p95 was 19.25 / 21.89 ms respectively. Every service correctness and partial-index-recovery assertion passed. Raw reports are in that run's `migration-benchmark-macos-15` and `migration-benchmark-windows-latest` artifacts. These separate virtual-host samples are not a cross-platform speed ratio, minimum-OS acceptance or Windows full-index-loss measurement.

## Original alpha artifact — 23 September 2026

Artifact: `build/macos/Morrow Mail.app`, Apple silicon, minimum macOS 13.5 for the bundled runtime. Native SwiftUI interface; no web view. The generated app contains its runtime, production dependencies, original icon, setup documentation, and license notices.

## Passed

GitHub Actions checks on macOS and Ubuntu with Node 22 passed for the initial public alpha source.

- `npm run check`: **65 backend tests**, followed by a successful web production build.
- `npm run macos:test`: **3 native model/recovery checks plus recipient/footer persistence, reply ownership and all six sort modes**, SwiftUI compilation, and native-client integration against isolated provider fixtures.
- Native-client integration: all **19 AI behaviors**, server-enforced permission denial, independent Google/Outlook calendar listing and creation, calendar request replay, draft persistence, uncertain send review, explicit retry, confirmed-send replay, legacy mailbox migration, multiple accounts, combined-view ID collisions, account-owned drafts, and disconnect isolation.
- Multi-account backend checks: preserved legacy credentials, multiple OAuth providers, case-insensitive reconnect, combined sorting, duplicate message IDs, per-account AI/send/workflow routing, view changes during AI requests, reconnected/disconnected-owner rejection, partial sync failure, and reconnecting retained cache.
- Private native service: per-launch bearer authentication, hostile-origin rejection, OAuth handoff routing, safe callback HTML, parent-pipe shutdown, invalid startup rejection.
- Native UI exercised: app launch, inbox and reader, mark-read-on-open, demo summaries, workflow preview/apply, model test/save, and persisted per-behavior permission changes. All behavior/folder/content controls were visible through accessibility.
- Multi-account UI exercised against an isolated fixture bundle: combined owner badges, individual inbox switching, account-locked replies, draft saving, new-message From selection, explicit send review, uncertain delivery, reviewed retry, and disconnecting one account while the other remains connected.
- Web UI exercised against isolated fixtures: combined account selection, duplicate-ID message selection, account-locked reply composition, draft save into the correct mailbox, and switching to an individual inbox without another account’s drafts.
- Calendar UI exercised against isolated fixtures: Google/Outlook calendar selection, event editor, destination/time review, explicit creation, and event display. No real providers were contacted.
- Online backups preserve the matching encryption key, consistent SQLite data, and pending native calendar requests; restored credentials and database integrity are verified.
- Release app builds successfully; `codesign --verify --deep --strict` and Info.plist validation pass. Bundled production service sources match the workspace, with no acceptance provider fixtures included.

## Alpha UI acceptance

- Native isolated app: Compact removed previews; Oldest-first changed the message order; ⌘N opened the composer; To/Cc/Bcc appeared together in ⌘⇧D review; cancelling review then ⌘S saved the draft; ⌘F focused search.
- ⌘⇧M from the combined inbox retained the selected account, loaded fixture folders, reviewed account/action/destination, and moved only that account's message after confirmation.
- Standard close/minimize/full-screen controls and macOS Window menu were present; Compact window-size preset worked. Reader/list widths and the minimum window width were adjusted after checking the smaller window. Restart restored density and sort choices. Test data was moved to a private temporary directory to avoid macOS Documents-folder permission prompts after re-signing the fixture app.
- Web selectors persisted Compact and Subject sorting. Automated backend checks cover complete recipient persistence. The initial alpha session could not finish web recipient/provider confirmation because of a browser confirmation dialog. The later footer session verified To/Cc/Bcc input, send review and saved reply content; provider-move web acceptance remains pending.

## Alpha mail additions

- Recipient validation, empty-To/Bcc-only delivery, header injection rejection, recipient cap and duplicate removal, complete recipient-set replay identity, SMTP envelope/Bcc header handling, and partial SMTP acceptance recovery are covered by automated checks.
- Opt-in provider organization scopes, Gmail label modification, Outlook nested folders and immutable IDs, hostile pagination rejection, IMAP capability/UID-validity guards, destination UID mapping, explicit account/confirmation checks, and post-move cache identity are covered by isolated provider fixtures.

## UI and footer changes (0.4 alpha)

- Backend tests cover HTML allowlisting, removal of scripts/images/remote resources, bounded inputs, escaped message bodies, and generated plain-text alternatives. MIME tests verify the footer in Gmail, Outlook and SMTP submissions while preserving Bcc behavior.
- Draft/retry tests preserve the footer across settings changes and restart, reject altered retry content, and route a reply to its owning mailbox when provider IDs collide and To uses an alias.
- Native isolated UI verified All accounts, per-account and Demo disclosure, persisted collapse after relaunch, combined-view account-locked reply, HTML footer preview and draft persistence.
- Repository screenshots captured from a fresh isolated native fixture app verify the final sidebar width, combined inbox, locked reply sender, recipient labels, and HTML footer layout. The screenshots contain fictional messages only.
- The native automation connection stopped responding during the final Settings check; the app process remained running and no Morrow crash report was found. Native Settings preview has build/API coverage, but its final visual acceptance is pending.
- Web isolated UI verified independent disclosure persisted after reload, locked reply From, complete To/Cc/Bcc in send review, saved footer/body, and HTML preview in settings.

## Remaining release validation

- Real Gmail, Outlook, IMAP/SMTP, Google Calendar, Outlook Calendar, and remote-model acceptance require the owner's credentials and OAuth consent. Provider tests used fixtures; no real messages or invitations were sent.
- Other supported macOS versions and hardware still need manual acceptance. The current Mac passed native compose/save/send-review/search/move shortcuts, density/sorting, and window-size preset checks.
- This local build is ad-hoc signed. The public alpha is explicitly unnotarized. Stable distribution requires Developer ID signing, Apple notarization, and provider app verification where applicable. No valid Developer ID identity was available on the build Mac.

The implementation is intended for a private, single-user Mac workspace. It does not claim error-free operation or exhaustive GenMail parity. See FEATURE_COVERAGE.md for live features and explicit simulations.

## Cross-platform release checks

- Local: 65 backend checks, React build, SwiftUI compilation and native integration passed.
- Electron shell smoke passed on macOS using an isolated demo profile: actual inbox rendering, authenticated API calls, denied unauthenticated access, no renderer Node API, and persisted disclosure state. This does not substitute for Windows execution.
- Desktop-state tests cover persistence, invalid keys, oversized writes and corrupt-state rejection; backups retain Windows client recovery metadata.
- [Paired CI run 35875758706](https://github.com/Coke1120/genmail/actions/runs/35875758706) passed on Ubuntu, macOS arm64 and Windows x64 with Node 22. Windows built and launched the packaged `.exe`, checked backend/app version agreement, loaded the demo inbox and verified private API access. macOS passed SwiftUI integration and app packaging. Tagged releases repeat these checks before publication.
- Windows manual UI acceptance, live providers and distribution signing remain pending. The alpha is not certified production-ready.

## Published macOS walkthrough — 23 September 2026, 23:12–23:17 HKT

Tested the downloaded `v0.4.0-alpha.1` macOS arm64 release in a fresh, isolated demo workspace. The ZIP matched the published SHA-256 (`c4ad4a5857c9501ffa8977c3db8c7bea09f098f5e04ecc52fbe6b72cc2a866c8`) and its original signature verified. The test copy changed only the bundle identity/name and `MORROW_DATA_DIR` launch environment, then received a local ad-hoc signature; the published application code and bundled backend were unchanged. No real mailbox or calendar was connected.

| Check | This session's result |
| --- | --- |
| Launch the published SwiftUI app | Passed; 12 demo inbox messages and the three-column layout rendered. |
| Open a message | Passed; reader displayed the selected sender, recipient and body, and unread count decreased from 4 to 3. |
| Compact mode | Passed; previews disappeared and the list footer reported `compact`. |
| Sorting | All six choices were visible; selecting Sender A–Z reordered the list. |
| Search shortcut | Passed; Command-F focused the search field. |
| Search results | `Northstar` returned 3 messages; an unmatched term returned 0, an explanatory empty state and Clear Filters. |
| Settings shortcut and further UI walkthrough | Blocked: after Clear Filters and Command-comma, the automation tool returned `Sky Computer Use native pipe closed before response`. Screenshot, session reset and reconnect attempts failed with the same error. The Settings screen itself was not observed. |
| Source regression checks | Passed: all 65 backend tests and React production build; Swift model/recovery, recipients, six sorting modes, reply ownership, footer persistence, SwiftUI compilation and native API integration. |
| Native integration fixtures | Passed: 19 AI behaviors, permission denial, Google/Outlook calendars, request replay, uncertain-send recovery, multi-account ownership, duplicate provider IDs and disconnect isolation. These are API/client checks, not UI or live-provider acceptance. |

The application and bundled Node process remained running after the tool failure. A one-second process sample showed the main thread waiting in the normal AppKit event loop; no Morrow crash report was found. This does not establish that Settings works visually or identify the automation failure's cause.

This walkthrough is **partial**, not a complete acceptance pass. Settings, HTML footer editing/preview, AI checkboxes, composing/replying, multi-account disclosure, calendar editing and window-control interaction still require a resumed UI pass for this release. Earlier sessions above remain separate evidence. No application defect was confirmed, no product code was changed, and no new release was published. Local diagnostic evidence is under the ignored `test-results/macos-walkthrough-0.4.0/` directory.

## Update checks and AI triggers — 24 September 2026

Local source changes, not a newly published release:

- `npm run check`: **70 tests passed**, followed by the React production build. New coverage includes release channels and semantic version ordering, drafts/invalid tags, rate limits/offline/malformed responses, route caching/retry behavior, default-off AI triggers, filter intersection, redaction, duplicate IDs across accounts, invalid trigger requests, overlapping-request coalescing and in-flight permission/model changes.
- `npm run macos:test`: SwiftUI compilation and all native checks passed, including decoding an available-update response and default-off/enabled summary and reply trigger requests. Provider/model traffic in these integration checks uses fixtures.
- `npm run macos:build`, strict/deep code-signature verification and Info.plist validation passed. The local app remains ad-hoc signed.
- `npm run desktop:test`: Electron smoke passed on macOS. This is not Windows packaged acceptance.
- A real public GitHub check returned installed/latest `0.4.0-alpha.1`, no update available, and the correct release page. No credentials or mail were sent to GitHub.
- Isolated React UI: clicked Check for updates and verified installed/latest version, timestamp and download link; excluding prereleases displayed an explicit no-release error. Verified both AI triggers default off, saved both triggers plus starred-only, and observed a labeled demo summary only for a starred message. Starting a reply displayed suggested text while the body stayed empty; clicking Use suggested reply filled the body, retained the recipient and saved as a draft without sending. Reload retained the checkboxes. Turning both triggers off removed automatic assistance while reading remained available.
- Native UI: the isolated rebuilt app launched and Settings → Mail opened. Switching to About again returned `Sky Computer Use native pipe closed before response`, preventing native visual acceptance of the new controls. Native build/API evidence above does not substitute for this missing visual pass.
- Final React trigger check: with summaries enabled, returning to the default first-message preview did not run AI; explicitly selecting that message displayed the summary. This avoids new requests from default selection changes during launch/sync. React production build passed after this adjustment.

No real provider messages/calendar events were created and no paid model was contacted. Windows executable testing and the remaining macOS Settings visual pass remain pending; no paired release was published for these source changes.

## Scheduled summaries and languages — 24 September 2026 (local, unreleased)

- The shared service now owns all-account periodic mail sync and opt-in AI jobs. Both clients expose daily time/time-zone or 1–168-hour summaries, newly synced mail summaries, P0–P4 reports, preferred AI language and an independent translation target. At that checkpoint, Email Brain/style updates remained manual simulations/edits; see the later historical-import and learning checkpoint below.
- `npm run check`: 78 backend tests and React production build passed. New checks cover schedule validation, time zones/DST, clock rollback, persisted interval anchors, no daily replay after restart, initial-import exclusion, repeat-sync deduplication, duplicate IDs across accounts, redacted model context, language separation, P0–P4 response completeness, in-flight policy/model/connection/content invalidation, crash/failure no-retry, and queue/history bounds. Fixtures do not contact live providers/models.
- `npm run macos:test`: SwiftUI compilation, native model checks and actual native-client integration passed, including round-tripping both language settings and the new trigger/schedule values. Existing 19 behaviors, calendar, recipient/footer, send-recovery and account-isolation checks passed.
- Browser UI against a separate temporary demo workspace: saved and reopened 繁體中文 / 日本語 preferences; enabled new-mail and scheduled-summary checkboxes; selected one-minute sync; saved daily `00:00` in `Asia/Hong_Kong`; observed a completed eight-message, P0–P4 illustrative summary in AI Studio → Summaries; changed to every two hours and confirmed persistence after reload. No actual priority/language quality is claimed from demo responses.
- `npm run desktop:test`: Electron development smoke passed on macOS (authenticated renderer, demo inbox, sandbox and private API). Windows packaged execution for these changes remains pending.
- The rebuilt native app launched in an isolated `MORROW_DATA_DIR`. Clicking Settings again caused the computer-use tool to return `Sky Computer Use native pipe closed before response`; the app and bundled service remained running. The new native Settings/summary screens have compilation/API coverage but visual acceptance is still blocked by that tool failure.
- `npm run macos:build`, `codesign --verify --deep --strict`, and Info.plist lint passed for the rebuilt local arm64 app; signing remains ad-hoc.
- No new release was published. Scheduling is best-effort while the service runs, uses bounded cached context, and is not Gmail/Outlook push or an operating-system background service. Real-account/model acceptance and signed/notarized distribution remain outstanding.

## Historical import and writing-style learning — 2026-09-24 (local, unreleased)

- Both clients now expose 1/3/6/12-month Inbox/Sent import choices, account-specific progress, pause/resume, and separate opt-in Learning settings. History downloads do not invoke AI. The writing-style flow previews the exact cleaned bodies and a conservative token estimate, analyzes at most 50 samples intersected with the global context limit, and requires an edited/reviewed Save before using a style. Optional weekly analysis only proposes updates from new cached Sent mail.
- `npm run check`: **87 tests passed**, plus the React production build. Coverage includes calendar-month clamping, checkpoint/restart/pause/reconnect behavior, pagination loops, IMAP folder-specific IDs and changed UIDVALIDITY, matching imported Sent copies to local delivery records without changing their retry fingerprints, Graph bearer-safe page URLs, account/header guards, initial-history arrival suppression, ownership/date/automatic-mail filtering, deduplication and body-only model context, budget/context caps, review/apply/replay controls, permission/source changes, interrupted calls, weekly opt-in and incremental selection.
- `npm run macos:test`: model checks, SwiftUI compilation and native API integration passed, including history controls and the style preview → analyze → approve → delete flow. Tests use temporary fixture workspaces and a fixture model; no live email/calendar/model request is made.
- Browser UI acceptance in an isolated fixture workspace passed: IMAP Settings opens, default 3-month Inbox/Sent choices are visible, an import pauses/resumes and reaches complete, Learning starts off, preview shows three cleaned samples and token estimate, quoted text is absent, analysis exposes provider-reported usage, and edited approved style becomes active. This walkthrough found and fixed a pre-existing IMAP Settings crash caused by an OAuth-only checkbox; a runnable React rendering regression covers all three provider forms.
- `npm run desktop:test` passed the Electron development smoke check on this Mac. It is **not** Windows packaged acceptance. The macOS app was rebuilt locally and its ad-hoc signature and Info.plist verified.
- Native GUI acceptance remains **blocked by the computer-use tool**: it reports “Sky Computer Use native pipe closed before response” when clicking Settings. The isolated app process remains running. This is not evidence that the native Settings page passed visual/interaction acceptance, nor a confirmed app crash.
- Limits: no authenticated Gmail, Microsoft or IMAP acceptance; no live custom-model billing validation; quote/signature removal is heuristic; latest-50 periodic folder refresh is not continuous provider delta sync; very large caches still need UI pagination/performance work. No new public release was created.

## v0.5.0-alpha.1 release candidate — 2026-09-24

- `npm run check`: **88 tests passed** and the React production build passed. The additional regression verifies that renewed weekly-learning consent excludes messages from the paused period and that an invalidated preview cannot permanently block later weekly proposals.
- `npm run macos:test`: native model checks, SwiftUI compilation and fixture-backed native API integration passed, including update checks, language/schedule settings, import controls, and the reviewed writing-style lifecycle.
- `npm run macos:build`, strict/deep signature verification and Info.plist validation passed. The bundled backend reports `0.5.0-alpha.1`; the app remains ad-hoc signed and unnotarized.
- The paired GitHub workflow must pass Ubuntu, macOS packaging and Windows packaged launch checks before its publisher makes either download public. See the tag's Actions run for the resulting CI evidence.
- Earlier checkpoints above describe pre-release work and their test counts at that time. Their native Settings GUI, Windows manual UI and live-provider/model acceptance limitations still apply; this alpha does not establish production readiness.

## Published v0.5.0-alpha.1 — 2026-09-24

- [Release](https://github.com/Coke1120/genmail/releases/tag/v0.5.0-alpha.1), published as a prerelease at 06:26 UTC, contains both platform ZIPs and their two checksum files. Both packages come from commit `924a1950b6e775ee54e59f474e174d8fa2bc7ca4`.
- [Candidate CI](https://github.com/Coke1120/genmail/actions/runs/35963991934) and [tagged release CI](https://github.com/Coke1120/genmail/actions/runs/35964230460) passed on Ubuntu, macOS arm64 and Windows x64. Windows passed the packaged executable smoke test; macOS passed native compilation, fixture integration and app packaging. The publisher waited for all three jobs before publishing.
- Downloaded both public ZIPs and verified their SHA-256 checksums: macOS `b0014dca97ba9cbdf4ff5626c1f650e9d8e0b652c9fda23ae93f43bdc71c9975`; Windows `0d02abe6c216bce15b3752a87a58c660d00788c0d3b1f638b834f084be48fe86`.
- The downloaded Mac app passed strict/deep signature verification and Info.plist validation, and its bundled backend reports `0.5.0-alpha.1`. This is ad-hoc signing, not notarization.
- Live, read-only GitHub update checks found `0.5.0-alpha.1`: an installed `0.4.0-alpha.1` reports an available update; the current version reports no update. These checks included prereleases and did not access mail, calendars or a model.
- The release notes retain the native Settings GUI tool failure, pending Windows manual UI/live-account acceptance, unsigned/unnotarized distribution, and documented feature limits. Publication does not resolve those limitations.

## Browser sign-in UX and native callback refresh — 2026-09-24 (local patch)

- Both clients label the OAuth action as browser sign-in and place the callback URL inside advanced registration details, explaining that it must not be opened manually. macOS includes a callback copy button. OAuth app credentials are still required; this change does not supply a hosted registration.
- Fixed native state refresh retaining the previous mailbox header after a successful browser callback. Workspace reads now follow the service's selected account, while message mutations retain their explicit owner. Windows Settings refreshes connections when returning from the browser if no unsaved edits or operations are pending.
- `npm run check`: **88 tests passed**, including OAuth cookie/PKCE/state/replay checks and React provider-form rendering; the production React build passed.
- `npm run macos:test`: SwiftUI compilation and native client integration passed. The added regression follows actual loopback authorize/callback requests with a separate cookie-bearing session, blocks external redirects, and uses fixture token exchanges for Google/Microsoft mail and calendars. Mail callbacks select the connected live inbox after refresh; calendar callbacks leave the selected mailbox unchanged. No real provider was contacted.
- The local Mac app build, strict/deep signature verification and Info.plist lint passed. `npm run desktop:test` passed on macOS; this is not Windows packaged execution. This patch is not part of the published `v0.5.0-alpha.1` downloads, which remain unchanged.
- Installed this local patch at `/Applications/Morrow Mail.app` after a normal quit, retained the previous application bundle, and verified the new app launches with the existing workspace. No mailbox data or settings were replaced. Clicking Add account again caused the native computer-use bridge to close, so the new Settings controls still lack native GUI acceptance; the four fixture OAuth flows above are API/client evidence only.

## Built-in Google Desktop OAuth — 2026-09-24 (local, unreleased)

- macOS and Windows packaging now accept a Desktop OAuth build input. Both clients offer Google mail/calendar sign-in without credential fields when it is configured, with an advanced custom-client override. Microsoft remains bring-your-own client ID. The public `v0.5.0-alpha.1` assets remain unchanged.
- The repository Actions secret `GOOGLE_DESKTOP_OAUTH_JSON` is configured for both platform build steps; tagged builds reject a missing input. Only the two installed-client fields are embedded; the original JSON and user tokens are not committed or returned by public API responses. Desktop client credentials are extractable from a distributed app.
- `npm run check`: **90 tests passed**, plus the React production build. Added checks cover Desktop-only parsing, sanitized packaging, invalid/missing build inputs, default/custom credential selection, configured-state redaction, and browser-bound Google mail/calendar fixture callbacks using the default client.
- `npm run macos:test`: SwiftUI compilation, model checks and native API integration passed. The isolated test backend packages a fake Desktop client and exercises default Google sign-in alongside custom Microsoft sign-in. No live Google account, token exchange, email, calendar event or model request was used.
- Cloud API enablement, consent-screen test users and Google verification cannot be established by these fixture checks. Native Settings GUI acceptance remains subject to the computer-use bridge failure documented above.
- The local arm64 app built with the supplied Desktop client, passed strict/deep signature verification and Info.plist lint, and passed an isolated packaged-service check for both Google browser handoffs, PKCE, sanitized client fields and public-state redaction. That check stopped before contacting Google. Signing remains ad-hoc.
- `npm run desktop:test` passed on macOS. Installed the new app at `/Applications/Morrow Mail.app` after a normal quit, preserved the prior bundle and all workspace data, and verified inbox launch. The Add account action again caused the computer-use bridge to close; the Settings controls and live consent flow have not passed GUI acceptance.
- [Paired CI for `a50f442`](https://github.com/Coke1120/genmail/actions/runs/35974628274) passed on Ubuntu, macOS arm64 and Windows x64. Both desktop builds passed; Windows also passed its packaged executable smoke test. This validates the source/build pipeline, not Google consent, live-account access or manual Windows UI acceptance. No tag or public release was created for this change.

## v0.5.0-beta.1 release candidate — 2026-09-24

- Promotes the built-in Google sign-in and browser callback changes above to a paired beta. The release publisher now accepts matching numbered alpha/beta tags, still rejects stable/mismatched tags, and retains both-platform, checksum and draft-publication guards.
- Local `npm run check`: **91 tests passed** and the React production build passed. Tests cover the publisher’s version gate and alpha-to-beta update ordering. Tagged CI must run backend/React checks on all three hosts, native macOS tests/build, and Windows build/packaged smoke before publishing either platform.
- Beta naming does not resolve the documented live-account, Google verification, native Settings GUI, manual Windows UI or distribution-signing limitations. See the tagged Actions run and release notes for publication evidence.

## Published v0.5.0-beta.1 — 2026-09-24

- [Beta release](https://github.com/Coke1120/genmail/releases/tag/v0.5.0-beta.1) published at 08:40 UTC as a prerelease, with macOS arm64 and Windows x64 ZIPs plus both SHA-256 files. Both packages use commit `575662a108fe878694870943cf5d6aef1926680f`.
- [Main CI](https://github.com/Coke1120/genmail/actions/runs/35976296548) and [tagged release CI](https://github.com/Coke1120/genmail/actions/runs/35976296570) passed on Ubuntu, macOS and Windows. Checks include 91 backend tests/React build, native Swift compilation/API integration, both desktop builds, and Windows packaged executable smoke. Publication waited for all platform jobs.
- Downloaded both public ZIPs and verified their supplied SHA-256 checksums: macOS `502015ef8bc1c8dcb45cb6740a47ae17fed6bbcf06c658b9d4a307f77206b149`; Windows `cb0f3e61160a5ea816207050d6b827527b8c16762f27cd5e105db6c09cf1ee04`. Both bundled package versions report `0.5.0-beta.1`; both contain the intended publisher Desktop OAuth registration with only the required client fields.
- The downloaded Mac app passed strict/deep signature verification and Info.plist lint. It remains ad-hoc signed and unnotarized; Windows remains unsigned.
- Live, read-only GitHub update checks return `0.5.0-beta.1`: `0.5.0-alpha.1` reports an available update and `0.5.0-beta.1` reports no update. No mailbox, calendar or model was accessed.
- Release notes retain Google test-user/API/verification requirements, native Settings GUI and live-account acceptance gaps, and existing feature limitations. Beta publication does not establish production readiness; existing alpha assets were not replaced.

## In-app updates — 2026-09-24 (0.5.0-beta.2 candidate)

- Both desktop clients expose signed download and explicit Install & Restart. Renderer requests cannot choose an executable, install directory or download URL; preparing installation requires a separate host credential on Windows. Native app termination and Electron close guards protect current operations and unsaved edits.
- Added checks for manifest signatures/version/platform/size, HTTPS redirect restrictions, traversal/symlink/local-header ZIP rejection, replacement rollback and workspace preservation. Existing public macOS/Windows ZIPs pass the archive inspector.
- On macOS, `npm run updater:test` passed the complete isolated flow: fixture-signed download, cancellation, protected install authorization, installer readiness, both process exits, replacement, launch of the new fixture app and preserved workspace. The first fixture incorrectly targeted a newer macOS; setting its deployment target fixed the fixture, and the updater now also checks minimum macOS before installation. This is fixture acceptance, not a live-account test.
- The update signing private key was created outside the repository and stored in GitHub Actions secrets; only the public key is shipped. Bootstrap requires one manual install of an updater-enabled build. Existing public beta.1 assets remain unchanged.
- Local `npm run check`: **94 tests passed**, plus the React build. SwiftUI/model/native API checks and Electron development smoke passed. CI also runs the full updater fixture on both desktop hosts before a release can publish; this includes a separate macOS incompatibility rejection check.

## Published v0.5.0-beta.2 — 2026-09-24

- [Beta release](https://github.com/Coke1120/genmail/releases/tag/v0.5.0-beta.2) published at 09:28 UTC from commit `0d04ddcaaf9870f59bdf38779022c008e8b08315`. It contains both platform ZIPs, two SHA-256 files, and the Ed25519 update manifest/signature. Previously published assets were not replaced.
- [Candidate CI](https://github.com/Coke1120/genmail/actions/runs/35980840002) and [tagged release CI](https://github.com/Coke1120/genmail/actions/runs/35981136707) passed on Ubuntu, macOS arm64 and Windows x64. Both desktop hosts passed the complete isolated updater download/cancel/install/restart test; macOS also passed native compilation/API integration, and Windows passed packaged Electron smoke. The initial Windows fixture loader used a filesystem path where Node required a file URL; the fixture was corrected before tagging.
- Downloaded both public packages and verified signed manifest size/hash/version/platform fields, archive entry safety, bundled version and each bundled public key's ability to verify the release signature. SHA-256: macOS `da93e1185bd5d8cd1eeaf24870249fea1b1f88b65514cb4618317a5bb3ab6a86`; Windows `8e4785ab2f888d223b844df412eea8d4345c8f408ff0ad6beb34bb25e047709b`.
- The downloaded Mac app passed strict/deep code-signature verification and Info.plist lint. Live GitHub update checks identify beta.2 as newer than beta.1 and report no update for beta.2 itself. No mailbox, calendar or model was contacted.
- A manual installation of this release bootstraps future in-app updates; this session did not replace the owner's installed app. The updater test launches generated fixture applications, not the owner's workspace. Native Settings GUI acceptance, manual Windows UI acceptance, real-account acceptance and distribution signing remain limited as documented above. The Mac package remains ad-hoc signed/unnotarized; the Windows package remains unsigned.

## Indexed and smart search — 2026-09-25 (current source, unreleased)

- `npm run check`: **100 backend tests passed**, plus the React production build. Search coverage includes migration/backfill without losing mail, FTS updates/deletes/transaction rollback, short Chinese and traditional/simplified matching, safe highlights, phrases/filters, account ownership and duplicate IDs, disconnected/demo isolation, sorting/pagination and saved searches.
- Embedding fixtures verify preview-before-indexing, redaction before requests, incremental reuse after metadata-only changes, restart persistence, interrupted-job no-retry, OpenAI response ordering, native Ollama requests, denied redirect credential forwarding, and discarded indexing/query results after permission/connection/source changes. The six search test groups also passed using the release's bundled Node 22 runtime. Fixtures do not establish real model relevance or billing accuracy.
- `npm run macos:test`: SwiftUI compilation and native client checks passed, including indexed/hybrid search, saved search, cross-account result/reply ownership, separate embedding settings, preview/run/clear and existing provider/calendar/send recovery checks.
- `npm run macos:build`, strict/deep code-signature verification and Info.plist lint passed. The self-contained local app includes the Chinese conversion dependency. It is ad-hoc signed; this does not replace the installed app or constitute notarization.
- `npm run desktop:test`: Electron on macOS loaded the real React search controls, searched fixture mail, verified highlights/account markers, saved a search through the UI and confirmed persistence, then cleared it. Private API and renderer sandbox checks passed.
- Browser acceptance used an isolated 72-message, two-account fixture: simplified `发票` matched traditional text; all-account scope returned both colliding-ID messages; `report` returned 70 matches with 30-result pagination; filters could be removed, sorting changed, and a saved search persisted. Settings accepted a separate fixture embedding model, previewed eight messages without an AI call, completed the reviewed batch and returned the semantically matching payment email for `延期付款` (absent as a literal phrase). No real account/model was used.
- Native UI acceptance in a separate temporary fixture app verified `发票` → traditional text, all-account scope → two colliding-ID results, owning-account badges and Reply from the other account while the sidebar stayed on the first account; From remained locked to the message owner. The first fixture workspace under Documents stalled in a filesystem permission call; a fresh temporary workspace launched normally. Opening Settings again ended the native automation connection with `Sky Computer Use native pipe closed before response`. Settings visual acceptance and live provider/model acceptance remain incomplete; the API checks above are separate evidence.
- [Search CI run 36026948980](https://github.com/Coke1120/genmail/actions/runs/36026948980), commit `6428c67`, passed on Ubuntu, macOS arm64 and Windows x64. Windows built and launched the packaged application and passed search/highlight/saved-search smoke checks; both desktop hosts also passed updater fixture tests. No tag or release was created; existing beta.2 downloads are unchanged.

## 0.6.0-beta.19 quota retry — release candidate

- Isolated Gmail fixtures verify that manual Sync schedules a persisted per-account retry after HTTP 429, ignores repeated button presses during cooldown, and clears the error after a background retry succeeds. History import preserves its checkpoint through restart and can complete within its three-retry budget after 429 and recognized Gmail 403 rate-limit responses. Review fixes retain the same 30/120/300-second budget when network, 5xx and quota error types alternate; exhaustion and daily quota errors require explicit Resume. Reconnect and disconnect clear only their account's pending Sync retry.
- The complete locked Rust test suite, strict all-target Clippy, rustfmt check and Swift package build passed locally. These fixture results do not establish real-account quota behavior or a published macOS/Windows build.

- PR #1 review found unbounded history quota retries and a retry counter reset on error-type changes. The existing isolated TLS fixtures now assert the shared retry budget, exhausted Gmail 403 handling and retained checkpoint across restarts. The beta.19 paired workflow must run all normal platform checks; beta.18's explicit waiver does not apply. Recent-mail Sync keeps its separate persisted quota backoff.

- Review candidate `3e30d90` passed all 158 locked Rust tests (zero ignored), rustfmt, strict all-target Clippy, Swift build, native macOS packaging, full native acceptance, plist lint and deep/strict ad-hoc signature verification locally. [PR CI 36383807674](https://github.com/Coke1120/Morrow-Mail/actions/runs/36383807674) passed both platforms: Windows includes native package/UI smoke and fictional-mail benchmark; macOS passed on attempt 2 at the unchanged commit. Attempt 1 failed an existing WindowAssertions manual-divider assertion at a 1024×656 content size. Twenty local repetitions at that size passed; the intermittent failure remains unexplained. No assertions, deadlines or production window code were changed. Tagged publication still requires a fresh successful paired run.

## 0.6.0-beta.20 release candidate — native fixture layout ordering

Beta.19 was not published. Its [tag run 36386216124](https://github.com/Coke1120/Morrow-Mail/actions/runs/36386216124) passed both platform Rust checks and macOS packaging/HTML isolation, then failed the same manual-divider fixture at a 1024×620 content size. The run was cancelled before publication. The fixture now re-resolves the displayed native split pane after layout instead of retaining a view that SwiftUI can replace. Manual-size assertions await the displayed pane within the existing three-second fixture deadline instead of relying only on a fixed 50 ms sample. Exact initial/manual sizes and programmatic resizing remain. Production window code is unchanged. The focused workflow now supplies its missing CalendarView compilation dependency and repeats the existing window suite ten times on macOS 15. Beta.20 retains all quota fixes and normal paired release gates.

## Thunderbird-informed IMAP follow-up — saved Codex Cloud environment

This independent branch starts from verified remote main
`966823b948e923df1b7a587c0d08876dee8e9773`. The stopped Mac mini edits and
results were not transferred or used as validation. The workspace's `.agents`
and `.codex` directories contained no additional skills/instructions. Version
metadata, tags, release workflows, candidate packages and the observer work are
outside this branch's scope.

Pinned Thunderbird source/license inspection and RFC references are retained in
[the design notes](docs/THUNDERBIRD_IMAP_SYNC.md). The original Rust change adds
bounded changed-UID discovery, a maximum 1,000-UID queue, a shared 50-message
background budget and atomic message/scan/queue/row-cursor progress. Valid legacy
proofs migrate once. Capability/folder generation markers invalidate untouched
old proofs lazily after support loss/regression, including restored support with
a larger mailbox maximum but smaller per-message MODSEQs. Queued UIDs read fresh
flags. Unchanged omissions use provider snapshots; missing snapshots reread
flags. Concurrent provider moves/confirmed writes cannot be overwritten by an
older response. Existing Gmail/Graph/UID/body/attachment behavior is retained.

Cloud Rust 1.98 checks passed on Linux x86_64 with Node/npm excluded from PATH:
rustfmt, locked all-target Clippy with warnings denied, and the complete locked
suite (342 passed, 0 failed; four explicit performance cases remain normally
ignored). The new 50k performance case was executed separately against immutable
baseline source and the final implementation. Functional checks use a separate
Cargo target with debug symbols disabled; the recorded benchmark uses the normal
debug profile. Generated-certificate loopback fixtures cover snapshot/override
repair, sparse windows, queue bounds, restart, rollback, capability loss/restoration,
UIDVALIDITY/connection replacement, checkpoint conflicts, provider-state races,
duplicate owner/folder IDs, both flag directions and indexed row-cursor seeks.
Static resources and Linux redistribution notices passed. Python mock probe
checks also passed (7 instruments cases and 11 reader-process cases); these do
not establish actual platform instrumentation or UI acceptance.

[The paired synthetic report](docs/performance/thunderbird-imap-cloud.json)
records 50,000 cached messages with 2,100-byte bodies and UID 25,000 changing read
and star state. Baseline/new observations: 500/1 background rounds, 3,000/34 IMAP
commands, 25,000/50 SQLite message updates, and 0/0 body requests or indexed-text
changes. Single shared-cloud elapsed observations are 342.66/1.86 seconds, with
setup excluded and concurrent verification affecting timing. Baseline setup
preceded the fixture-only text memoization shortcut; timed work restores normal
production functions. No seed-time, WAN, polling, cold-cache, UI or live-account
speedup is claimed. The first new round applies the changed message and retains
unfinished scan progress rather than claiming full mailbox completion.

Native SwiftUI/WinUI packaging, signing and UI acceptance require their existing
macOS/Windows PR jobs. Linux cannot run those checks. The standalone native
resource/CPU sampler explicitly refused Linux without creating a report; no
platform restriction was bypassed. No real accounts, credentials or user database
were used. This phase opens a draft PR and does not authorize merge or release.
