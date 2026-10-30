# Page writes retain the state the user reviewed

Date: 2026-10-30

## Context

Compose AI streams, Brain analysis and Calendar writes can finish after the
original editor has changed or closed. A renderer generation guard alone cannot
protect durable recovery, user-owned state or account-wide caches.

## Decision

- Ignore AI draft events before repaint unless their request is still pending in
  this composition. Manual editor input retires completed draft-write state.
- Track attachment preparation per composition. Save, preview, Send and Schedule
  cannot finalize while files are being read or stored. Abandoned sessions cannot
  accept late results.
- Undo uses the existing `mail:editScheduled` / `scheduledToDraft` transaction:
  save a new inert local draft and remove the queue row together. Opening Compose
  is a later, fallible presentation step. The local draft survives window/load
  failures and delivery is never rearmed by recovery. Recovery snapshots preserve
  explicit empty recipients and existing signatures rather than seeding defaults.
- Brain analysis commits against a freshly read store, preserving user rules,
  categories and activity. Reject an analysis if its generated-profile baseline
  changed. Fix validates the selected value and stored version before applying
  its result; positional IDs alone do not establish identity after regeneration.
- Calendar non-time updates omit all time properties. The editor does not guess
  which occurrence of an ambiguous local hour a deliberate time edit means;
  choose another time or use the provider editor with an explicit offset.
- Each Calendar creation editor retains a random 32-hex operation identity across
  retries of its frozen submission. Google uses that event ID and reconciles a
  conflict by reading and matching the existing event. Microsoft uses
  `transactionId`. Changed uncertain submissions require provider review before
  starting another editor; these IDs are not a cross-editor or restart journal.
- Validate user-authored descriptions as plain text, escaping Google HTML output
  while keeping Graph Text bodies literal. Inbound HTML projections retain anchor
  targets; description replacement still requires a complete baseline and ETag.
- Known Calendar authentication failures offer explicit reauthorization through
  `forceReauthorize`. Ordinary reads still reuse valid grants. Confirmed writes
  invalidate the captured account before checking editor ownership.

## Validation boundary

Synthetic tests exercise production renderer functions, host handlers and provider
serializers without credentials, live AI or provider writes. Native Electron,
real SQLite durability, OAuth registration and provider-side deduplication still
need the normal dependency-enabled CI and authorized smoke checks.
