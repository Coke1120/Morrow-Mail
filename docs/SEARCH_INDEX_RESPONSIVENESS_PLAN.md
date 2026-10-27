# Local search rebuild responsiveness — original design plan

Status: original proposal retained for rationale. This combined draft includes
the cooperative startup implementation from PR #341; see
[the implementation decision and remaining limits](adr/2026-10-27-cooperative-search-index.md).
The proposed worker/interactive-search extensions remain deferred. This does not
describe a published release.
Source inspected: `163146384267909f527a399891304efd6f1bc0e3` (v0.3.3).

## Existing path

`host/mail/db.js:openDatabase` loads/replays the durable store and calls the
synchronous `migrate`. `migrate` ends in `ensureSearchIndex`. That function creates
the three consistency tables, checks index version and document/message counts,
then rebuilds the full index in one synchronous transaction when they differ.
It materializes every message ID and calls `indexText` for each. Tokenization,
body normalization, term inserts and journal serialization execute on the main
thread. `startup.index` measures the rebuild; `db.index` measures per-message work.

PRs #324/#328 already reduced metadata/body materialization, unchanged-content
reindexing, repeated queries, renderer cache growth and body notification payloads.
Retain those changes. A full startup rebuild is a different path. Actual native
mailbox/rebuild timings have not been collected, so no user latency is asserted.

## Smallest separate implementation

1. Add a synthetic stale-version/missing-document rebuild scenario and measure
   heartbeat delay, work per batch, duration and peak memory. Include many small
   messages plus one large Unicode/HTML body; report fsync cost separately from
   tokenization. Use fixed numeric diagnostics, never mail text or identifiers.
2. Extract only rebuild work from synchronous migration into an awaited startup
   phase. Process deterministic keyset pages of message IDs rather than an
   all-ID array. Commit bounded document/term batches through the existing durable
   journal, then yield to the event loop. Keep admission closed until the complete
   index is verified; display truthful startup progress without exposing partial
   search results. Explicitly gate reentrant init/IPC and old background tasks.
3. Persist a rebuild-in-progress/version/cursor marker together with each batch.
   Per-message document and term replacement remains transactionally consistent.
   Mark the target version complete only after verifying matching document IDs
   and terms, not counts alone. A crash/quit/cancel retains durable committed work
   and resumes or safely restarts the unfinished rebuild on the next open.
4. Keep `message_fts_meta`, `message_fts_doc` and `message_fts`, their consistency
   role and indexes. Do not drop these tables, suppress repair, weaken fsync or
   acknowledge work before journaling. Any necessary row replacement is part of
   the explicit rebuild state machine, not removal of the consistency mechanism.

Yielding between batches improves responsiveness between those batches; it does
not bound a huge message's tokenization or a synchronous durable disk call. If
measurements show that one document still blocks, separately move only pure
normalization/tokenization to a bounded worker and validate identical tokens.
Keep SQLite writes on their existing owner and enforce body/term transfer budgets.
Do not point a worker at the live DB or invent a second writer. Interactive search
while rebuilding would require an additional old/new index generation design;
that broader schema/cutover work is outside this first proposal.

## Required tests and review gate

- Search parity for Unicode, HTML/plain/snippet fallback, phrase/prefix matches,
  deleted messages and all previously repaired missing-index cases.
- Fresh/current/stale/corrupt/incomplete rebuild metadata, deterministic batching,
  bounded ID materialization and main-loop heartbeat between batches.
- Fault injection before/after each durable batch and final publication; reopen
  and prove that complete indexes contain exactly the expected documents/terms.
  Interrupted work must never be presented as a complete search index.
- Removal/reconnect/migration/init reentry, shutdown cancellation and queued
  account work cannot write against an unfinished or closed store.
- Existing journal corruption, rollback, checkpoint, large-file and crash tests
  continue to pass, with no filesystem durability check disabled.
- Features/help describe progress and any search-unavailable interval. Full
  Linux/Windows CI and independent review precede merge. Native profiling remains
  a separate evidence gap; synthetic timing is not an end-user speed promise.
