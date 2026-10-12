# Incremental synchronization and synthetic evidence

The 0.7.4 work starts from remote main `5438edf9cd1b04578744edd1b5110c178372bb1f`
on 12 October 2026. The published 0.7.3 commit is
`1f9306e0a177cd9892e23641e9b86b41b682df0f`. Local development uses isolated
checkouts, synthetic SQLite stores and generated-certificate loopback mocks.
The original checkout, production mailbox/database, accounts and credentials
were never opened. No Parallels changes were made.

## Initial storage measurements

`rust/examples/sync_benchmark.rs` always creates fresh temporary fixtures; it
does not accept a workspace path. Each mailbox has two owners, colliding provider
IDs and roughly 2 KiB plain-text bodies. Each timed import has 50 rows per owner
and five warm samples. Timed SQLite scalar wrappers count actual normalization
and tokenization, while temporary triggers count actual message inserts/updates.
The fixtures are integrity-checked and removed afterward.

| Total cached rows | Scenario | Before median ms | After median ms | After message updates | After FTS rows |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1,000 | unchanged, 50 rows | 316.32 | 4.94 | 0 | 0 |
| 10,000 | unchanged, 50 rows | 415.56 | 5.81 | 0 | 0 |
| 50,000 | unchanged, 50 rows | 337.47 | 5.40 | 0 | 0 |
| 1,000 | flags only, 50 rows | 315.70 | 32.14 | 50 | 0 |
| 10,000 | flags only, 50 rows | 384.94 | 37.90 | 50 | 0 |
| 50,000 | flags only, 50 rows | 341.58 | 41.99 | 50 | 0 |
| 50,000 | unchanged, two owners/100 rows | 665.67 | 10.03 | 0 | 0 |
| 50,000 | 50 new rows | 323.24 | 446.10 | 0 (50 inserts) | 50 |
| 50,000 | indexed subject changes, 50 rows | 335.65 | 378.07 | 50 | 50 |

Complete samples, seed times, tokenization time and SQLite change counts are in
[baseline-sync.json](performance/baseline-sync.json) and
[optimized-sync.json](performance/optimized-sync.json). These initial candidate samples precede the final batch-statement reuse. They are debug builds on
the same Mac mini with Rust 1.99.0; other developer/compiler activity and warm
filesystem caches affect timing. New/text-change samples retain all 50 FTS
updates and do not demonstrate a speed gain. New-mail regressions in these
samples are retained, not hidden. FTS timing measures tokenization, rather than
every internal SQLite FTS cost. The benchmark excludes network, native UI,+cold-cache behavior, production 2 GB databases and real-account acceptance.

The observed avoidable work is concrete: before the change, an unchanged
50-row import still updates 50 message rows and rebuilds all 50 FTS rows.
Value comparison skips those writes after the final provider/local-state merge.
The SQL upsert also suppresses byte-identical updates. Search triggers update
flags/folder/date/category in place; only changed indexed text rebuilds FTS.
Provider memberships change only when their account/folder/label IDs change.
Startup transactionally replaces trigger definitions without rebuilding existing
rows or changing schema-version/remote-ID-index contracts. A missing search
document can still be inserted by a real message update.

## Protocol behavior and limits

Gmail captures a history anchor before its five bounded recent scopes, persists
bootstrap progress, then processes one history page with up to 50 records per
cycle. A page's IDs are coalesced into a bounded persistent queue and resolved
in batches of 50. The page token moves only with those message commits; the
history ID moves only after the final page commits. Current detail responses
resolve delete/re-add and label event ordering. A detail 404 for an explicitly
requested ID can mark an owned cached copy deleted. Partial list absence cannot.
Drafts are still fully fetched, and 50 cached rows still rotate each cycle.

History expiry retains cached mail and the original live/reviewed boundary,
reseeds recent scopes and pages through the permitted recovery interval while
continuing history and cached repair. It does not restart a paused user import
or silently promise a mirror. Malformed/cyclic checkpoints block automatic
history reads until a reconnect or explicitly restarted reviewed import.
History pages exceeding the existing 8 MiB response bound or 1,000 distinct
change-ID queue bound fail safely without advancing data progress. All Mail
coverage still excludes new Spam/Trash records and respects the import window.
See Google's [sync guide](https://developers.google.com/workspace/gmail/api/guides/sync)
and [history API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list).

IMAP retains the original bounded newest-first bootstrap and body proof. Later
rounds scan ascending 8,192-UID windows, at most 32 per page, fetching at most
50 messages and committing the scanned UID with their data. Bursts larger than
50 continue from the last processed UID. Checkpoints include connection, folder
and UIDVALIDITY; reconnect or generation change resets the recent baseline.
Sparse bootstrap warnings remain until reviewed history completes. Scheduled new-UID polling retains the existing Inbox/Sent scopes; custom folders receive cached flag/deletion rotation and reviewed historical imports, rather than continuous new-message discovery.

For bounded cached-UID reconciliation, CONDSTORE is requested through read-only
EXAMINE only after capability discovery. Per-row MODSEQ/connection proofs commit
with flags. QRESYNC additionally requires an actual ENABLED confirmation; its
CHANGEDSINCE/VANISHED responses retain unchanged omissions and cached deleted
content. Without QRESYNC, a complete UID existence fetch establishes deletions
independently of filtered flag responses. Rejected extensions, missing MODSEQ
and NOMODSEQ fall back to bounded flag polling. Priority's retained-reader-plus-
50-page operation now shares one connection and still returns no partial batch.
This implements bounded known-UID QRESYNC, not global SELECT QRESYNC, IMAP IDLE
or a persistent connection pool. See [RFC 7162](https://www.rfc-editor.org/info/rfc7162/).

Graph retains per-folder opaque next/delta URLs, the 50-row page and 25-row
rolling budget. Every unique delta ID still resolves current state so folder
moves/removals cannot be skipped. Only rolling IDs already observed and committed
in priority/delta work are skipped. The rolling cursor still advances
over its original rows, preserving fairness. Blocked folders retain their error
while healthy selected folders continue. An all-blocked cycle does not commit
a migration/checkpoint update. No polling interval or four-request concurrency
limit changed. See [Microsoft's per-folder delta guide](https://learn.microsoft.com/en-us/graph/delta-query-messages).

## Diagnostics and verification

`sync_profile` logs contain a fixed provider name, success flag, aggregate
microsecond timings and counts only. They never contain owners, message IDs,+URLs, cursors, subjects, bodies, label names or secrets. HTTP bytes count JSON
response bodies; IMAP bytes count application-protocol bytes, excluding TLS.
Phases can overlap and are not additive. Database queue timing measures waiting
for the blocking worker/store, rather than native main-thread blocking. Failed
cycles can include attempted writes/FTS work that later rolled back; only
successful cycles establish committed progress.

New fixtures exercise semantic no-ops, all indexed fields, flag filters, trigger
replacement, rollback, Gmail 120-ID restart/pagination, explicit deletion,+transaction failure, cursor expiry/cycles, IMAP 120-UID bursts, generation and
connection changes, QRESYNC/CONDSTORE deletion/unchanged cases, rejected/ignored
extensions and NOMODSEQ, and Graph healthy-folder progress past a blocked one.
Existing sent/draft/attachment/priority/quota/reconnect/unknown-exit regressions
remain required. Native and paired CI results are recorded in
[VERIFICATION.md](../VERIFICATION.md); a fixture pass does not certify live mail
or resolve pre-existing Windows observation/reader issues.

Provider benchmark cases are explicit ignored tests named
`synthetic_provider_sync_benchmark`, `synthetic_imap_sync_benchmark` and
`synthetic_graph_sync_benchmark`. They use only their generated local TLS mocks.
Before/after request/byte/timing reports will be retained with final validation.
