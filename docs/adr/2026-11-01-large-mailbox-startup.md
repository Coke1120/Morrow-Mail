# Large-mailbox startup preparation and checkpoint scheduling

Date: 2026-11-01

## Context

Approved investigation candidates F07/F09, F01 and F03/F04 identify invisible
pre-search work, body-bearing metadata updates without a per-message time budget,
and small preparation commits repeatedly triggering whole-checkpoint copies.
These changes retain checkpoint plus durable journals as the recovery authority.
They do not reuse `.live`, move the database owner, split schema migration or
eliminate the SQLite record rewrites caused by metadata updates.

## Decision

- A separate startup observation stream names copy, journal recovery, migration,
  initial checkpoint publication when needed, body metadata, saved summaries,
  search verification/repair and admission. The existing search progress contract
  stays unchanged. Observers run outside internal admission and SQL transactions.
  An explicit checkpoint before storage initialization rejects as not ready,
  rather than creating an unmatched journal during a new phase boundary.
  UI updates are limited to once per 100 ms within a phase, with phase transitions
  and final counts delivered immediately. Copy/schema work is indeterminate;
  journal percentages describe checked journal bytes, never overall startup.
- With `MORROW_PERF=1`, fixed-label phase entry/completion/failure events identify
  the active work before its aggregate timing becomes available. Copy, recovery,
  migration, initial publication, body metadata, summaries, search and admission
  have separate durations. Workers return numeric replay and checkpoint
  copy/replay/publication durations to the main recorder. No mail, identity,
  path, SQL, error text or credential is included in these new observations.
- Body metadata checks an 8 ms elapsed-time budget after each message and retains
  the 64-ID maximum. The existing transaction/journal/fsync path commits before
  progress or yielding. Only rows whose `has_body` is NULL remain eligible on
  restart. A single SQL/body operation, commit or fsync can exceed the budget;
  this is not a maximum-latency or faster-total-startup guarantee.
- Automatic checkpoint thresholds scale from 8 to 64 MiB of journal and from
  256 to 4096 transactions with mailbox size. During startup, transaction count
  and a sealed journal alone do not trigger copies; the byte threshold is four
  times the normal threshold. Dirty journals also get a 120-second startup /
  60-second runtime age trigger. The cooldown after a checkpoint is four times
  its measured duration, clamped to 1–60 seconds, and cannot postpone the age
  trigger. These are scheduling bounds, not hard growth or recovery-time limits:
  a running worker, disk contention, headroom or failures can delay publication.
  Automatic work publishes one sealed journal per job and gates any remaining
  journal again; it does not immediately chain full copies for an old sealed tail.
- Before an automatic copy, reclaim abandoned owned staging and sample available
  space. The advisory estimate is one additional staging database, using the
  larger of published/live size, plus a reserve of 5% clamped to 64–512 MiB.
  Existing checkpoint/live allocations are not counted again. Unknown headroom
  permits an attempt. This is not a three-times-database opening requirement or
  a guarantee that replay/rollback/index growth will fit. Explicit checkpoints
  bypass this advisory gate and retain their captured target-sequence contract;
  actual write failures still reject.
- Failed automatic work retains both durable journal inputs and uses exponential
  retry backoff, capped at five minutes (initially 60 seconds for low-space
  conditions, 30 seconds otherwise). More disk space can be necessary before
  automatic publication resumes. Journals are still appended and fsynced before
  acknowledgement; no fsync, recovery validation or consistency table is removed.
  Staging cleanup runs only before owned work, after a worker closes its database,
  or after confirmed worker exit. It never removes checkpoint or journal inputs.
- Startup disk-full errors explain freeing unrelated space and explicitly warn
  against deleting or renaming the database or its journals. No new OAuth grants,
  provider operations, sending behavior or automatic replies are introduced.

## Validation and remaining work

Dependency-free synthetic checks cover phase scripts, per-message budget and row
caps, post-commit observations, startup/size/cost/age scheduling, disk headroom,
retry timing, explicit checkpoints and worker-owned staging cleanup. SQLite
upgrade checks insert body-bearing rows before the metadata column exists, then
exercise admission, abort/close, journal failure, SQLITE_FULL, abrupt process exit, restart,
body/whitespace parity, warm reopening and main-recorder worker timings. Existing
search-repair and persistence suites retain their crash and consistency coverage.
Rendered Features, Search help, CLI diagnostics help and splash are checked with
synthetic DOM data. These tests do not measure Leo's mailbox or native macOS /
Windows latency; missing-index migration and individual large operations remain
synchronous and need separate profiling and review.
