# Exact local search and bounded runtime body work

Status: proposed for dev in the draft PR for #520.
Baseline: `e0ca1151e8fbf08929266463afbda6a382583786` (v0.4.2).

## Search access and accuracy

Keep the existing SQLite owner, index documents, tokenizer, source caps and
incremental consistency/repair protocol. Bounded probes (at most 2,049 index
entries per token and 8,193 account rows) choose an access path; they do not
truncate candidates. The smallest observed prefix range seeds the query. A
smaller account may seed it instead. A materialized seed prevents the outer
query from choosing an account-history scan. Small seeds constrain subsequent
term grouping through the existing message-ID index; broad terms retain covering
term-range access. For a bounded account and a saturated term probe, one refined
probe visits at most 65,537 postings, using eight postings per account row as
an access-cost heuristic. These constants choose work only and are not tuned
native latency targets. Final message/account lookups use primary keys.

Every matching prefix still contributes its maximum field weight (subject 6,
sender 4, body 1). All terms must match. Ranking sums every term's weight before
the existing date/ID ordering and result limit; explicit column sorts, To Me,
account-required queries and Timeline's larger coverage sentinel are retained.
Quoted input keeps the existing tokenizer's word-prefix AND behavior; no phrase
search or provider syntax is introduced. No first-N candidate shortcut, new
search index or asynchronous index-consistency bypass is used.

Broad exact ranking still examines all matching candidates synchronously.
Materialized groups and automatic temporary indexes cost memory/CPU. A query
cannot service host callbacks until it returns. Smaller SQL work does not make
a frame-time guarantee or establish the cause of a native macOS beachball.

## Pending-body access

Use one partial date/ID index for `uid > 0 AND body_complete != 1 AND is_draft = 0
AND body_retry_blocked = 0`. The production pending selector explicitly chooses
it: SQLite without ANALYZE otherwise prefers the old draft/account indexes and
still scans/sorts completed history. Retry deadlines and folder exclusions stay
residual predicates. No moving-clock index predicate or separate backlog table
is introduced. Account/folder queries visit eligible backlog rather than whole
completed history; large not-yet-due or excluded backlogs can still be expensive.
Date/ID keysets seek inside this index. The engine's two-page budget, horizons,
day/night state and unfinished cursor behavior remain unchanged.

Normal SQL maintains eligibility within the existing message transaction. The
index adds schema creation, storage and write maintenance. Old complete mail is
not rewritten. The initial index build remains synchronous; journal replay and
schema migration keep their existing order and durability rules.

## Runtime ingestion and durability

The asynchronous IMAP ingestion path retains the 24-message maximum, adds an
8 ms elapsed-work check between messages, and admits at most 256 KiB of incoming
normalized UTF-8 text plus HTML per batch. One oversized message proceeds alone.
Each transaction finishes its existing index writes, journal append/hash/fsync
and SQL commit before `setImmediate`. No transaction spans an await. Final folder
counts/resume state still publish only after all content batches. Generation,
account incarnation/transport, folder validity and caller checks run after every
yield. Flag/deletion bounds and single-message Gmail commits remain unchanged.

These are cooperative budgets, not strict per-turn deadlines. One body, body
normalization, SQL/index call, serialization or fsync can exceed 8 ms or 256 KiB;
the final journal/commit cost follows the elapsed check. Smaller batches may
increase total fsync cost and journal frames. No reduced flush, altered recovery,
content truncation, acknowledgement before journaling or parallel live writer is
introduced. Failed batches roll back; earlier acknowledged batches survive
restart and an unfinished folder cursor remains unfinished.

## Deferred database ownership

This PR does not extract search or body writes to a worker. If broad searches or
single oversized writes need strict responsiveness, first design a separate
snapshot/ownership protocol: one live writer; a worker reading only a validated,
immutable snapshot with explicit generation and committed-sequence coverage;
bounded snapshot retention; index admission/verification for each snapshot; and
account/content revision checks before publishing results. A superseded query
needs termination or interruption with ownership cleanup so it neither publishes
stale rows nor indefinitely queues newer work. Checkpoint lag must be explicit;
silently searching the older checkpoint would omit acknowledged mail. Body
layout/writer ownership changes additionally need journal replay, disk-full,
crash/publication and lifecycle proofs. Those changes belong in a separate ADR
and implementation, rather than being implied by these query/batch improvements.

## Evidence

`check-residual-mail-work.js` asserts exact reference parity, actual production
query plans, pending eligibility/retry/keysets/rollback/replay, and independent
time/UTF-8 byte batching with no SQL transaction held across a yield.
`check-runtime-10k.js`, persistence/search/body suites and configured CI cover the
existing contracts. `benchmark-residual-mail-work.js` records source/harness
fingerprints, runtime versions, full SQL plans, raw timings, the maximum callback
gap throughout each pass, index storage and sampled RSS with synthetic profiles.
Wall-clock measurements are diagnostic, never CI thresholds. Native Electron
frames, packaged SQLite, live accounts and Mac/Windows storage remain separate
validation gaps. See the paired report linked from `docs/PERFORMANCE.md`.
