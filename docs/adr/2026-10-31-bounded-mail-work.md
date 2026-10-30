# Bounded mail work without weaker acknowledgement

Date: 2026-10-31

## Context

The October 30 performance review identified blocking credential subprocesses,
header-history rebuilds triggered by unrelated writes, broad renderer invalidations,
and unbounded sync/recovery work. This decision covers P1-1/P1-2, P2-1 through P2-8,
and the related P3 surface work. No native frame-time improvement is claimed.

## Decision

- Routine Windows DPAPI and macOS Keychain reads use bounded asynchronous children.
  Feature/status resolution snapshots candidate grants for one request and checks
  account incarnation, transport/login, credential revisions and Google client binding
  across awaits. There is no completed-credential cache across requests. Serialized
  credential writes and synchronous commit/compensation blocks stay intact.
- SQL triggers track header-only revisions and per-message deltas. A worker owns
  recipient parsing, deduplication and incremental address aggregates. Cold/delta
  reads are paged; unrelated flags/bodies do not invalidate history.
- Startup replay and initial checkpoint publication run in a worker before admission.
  Live sync commits at most 24 messages, 128 flags or 64 deletions per batch and
  yields without an open transaction. Cursor publication follows durable commits.
  SQL, indexing and each individual journal/fsync/commit remain synchronous; moving
  all live database ownership to a worker is not part of this change.
- Scoped notifications reuse supplied account snapshots and defer hidden Mail work.
  Queue badges use counts, visible lists use 200 body-free summaries per page, and
  selecting/editing/recovering fetches the full frozen content. Delivery uncertainty,
  cancellation deadlines and durable recovery acknowledgements do not change.
- Equivalent read jobs share work only within the account incarnation/scope and
  mutation boundary. Background account polling and cold calendar reads each use
  concurrency two. Calendar failure stops successors, settles in-flight work and
  publishes no partial result; this preserves the existing complete-month contract.
- Source-limit retry eligibility persists independently of body completeness. A
  provider-identity change or explicit Retry download can retry; transient incomplete
  automatic reads wait 60 seconds. Overnight reads advance through header pages.
- Compose allows safe editing and closing while identities load, but keeps sending
  gated. Optional Skills/Learned/signature reads are visibility/dependency driven.
  Stable cards, events, logs and Undo rows retain nodes; splitters write once per
  animation frame and flush their final value before persisting layout.

## Consequences and validation

No new grants, transport changes, automatic sends, bot capabilities or telemetry.
Keep fsync, journal admission/restart recovery, draft protection, unread-hold, snooze
and reduced-motion tests. Synthetic checks count children, history scans, IPC calls,
nodes and bounded batches; they do not establish Windows/macOS rendering latency.
Packaged SQLite query plans and native traces remain separate release validation.
