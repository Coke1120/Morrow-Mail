# Batch mail metadata and bound body update retention

This is a stacked change on PR #324, branch `perf/mail-responsiveness-20261026`,
exact base `ed95f2b778efa1940526ded29bd360a01bd87354`. Its PR targets that branch
while #324 is unmerged, keeping the phase-one diff and PR #323 consent work out
of this review. Retarget to dev after phase one integrates; do not merge or release
as part of this task.

An independent source/synthetic assessment found per-message action-generation
queries, repeated prefetch owner lookups and an unbounded renderer body map.

- Batch action-generation queries in groups of 400 IDs, joining message/account
  ownership. Lists, thread formatting, local search and snoozed lists use the
  batch. Keep individual action guards for standalone detail operations. Reuse
  prefetch admission's host-generated account metadata; queued work still checks
  message ownership and the existing account connection epoch before running.
- Replace full background body broadcasts with availability, account/id, account
  epoch and a process-local monotonic update version. Closed/invalidated account
  callbacks cannot publish body updates. No unbounded host revision map or schema
  migration is needed.
- An internal `mail:readCachedBody` reads the current stored snapshot only after
  validating account ownership and connection epoch. It starts no provider work.
  Visible consumers coalesce requests to one in-flight read and at most two latest
  notices (reader/pending open and preview). Duplicate notices and failed reads
  do not loop; newer notices or explicit reopen can retry. Superseded results are
  ignored rather than claiming a completed local read can be recalled.
- Cache only body fields under account/epoch/message keys, with 32 entries,
  estimated 8 MiB UTF-16 string accounting and a 2 MiB per-entry limit. Active
  reader/preview/composition content stays outside this reuse budget. Eviction
  changes no on-disk mail, draft, blob or attachment data. Removed/reconnected
  accounts cannot reuse earlier cache entries. A bounded 64-key explicit-read
  marker set prevents an earlier refresh from overwriting a newer explicit read.
- Fresh local snapshots include body-associated attachment/CID, sender and draft
  revision metadata, but the reuse cache excludes that metadata. If a late open
  uses a newer cached body, its older metadata is refreshed separately. Preserve
  optimistic action flags and compose edits. Version ordering replaces the old
  body-length preference, so a newer shorter body can replace an older one.

Tests enforce query-count, cache-bound, notification and reload/request budgets,
account invalidation, pending-open races, fresh draft/attachment metadata and
oversized/incomplete-body handling. Measurements use synthetic data only and do
not establish actual Mac beachball cause or resolution. Storage, search-index
architecture, fsync/durability, Keychain and Rust/Tauri remain outside this change.
