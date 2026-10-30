# Wave1: settlement and editor ownership

Date: 2026-10-30. Status: accepted.

## Context

The Mail, Agent and Settings page reviews found confusion between an IPC envelope,
acceptance, provider completion, and ownership of an editable snapshot. The
post-#401 Undo/Sync/Limited behavior remains the base, not a replacement target.

## Decision

- An uncertain Outbox send keeps its existing `scheduled_sends` record, content,
  Message-ID and uncertainty. It is never automatically restored to an editable
  compose. Scheduled recovery retains its explicit check-Sent acknowledgment.
  Only a proved pre-acceptance failure uses the existing draft handoff.
- A reviewed removal starts its renderer Undo epoch before invoking mail actions.
  Accepted action IDs and operation IDs retain that epoch across account-specific
  settlements. Message/generation ownership covers settlement before invoke
  return. Earlier sessions cannot replace a newer checklist. Existing pending
  Undo ownership, per-row restore and status dwell behavior remain intact.
- IMAP filing proposals persist their journal action ID and pending/failed/unknown
  state. Matching completion alone confirms them. Action settlement updates the
  current store, and page reads reconcile saved links against the durable journal
  after missed notifications or restart. Confirmation re-reads and validates the
  proposal after provider awaits; in-flight confirmation is deduplicated.
  Dismissing the card does not cancel a provider operation already submitted.
- Async editor responses update the submitted baseline, not newer typing. Notes
  use edit/save ownership, skill rows retain keyed dirty or focused editors, Out
  of Office refreshes/write replies preserve newer drafts, and schedule-delay
  autosaves serialize snapshots. Mailbox fold promises belong to their generation
  and must not mark an unapplied result loaded.
- Bot access mutations use an ordered queue independent of status probes. A
  disable or revoke request cannot be dropped by a busy probe. Controls follow
  acknowledged state; stale status reads cannot replace a newer acknowledgment.

## Boundaries and validation

No provider scopes, credentials, send authorization, transport, schema, release
version or boot renderer change. CSS image function support is deliberately
restricted rather than accepting untracked resource-bearing syntax. Per-message
opt-in covers supported image URLs and table/CSS backgrounds in both readers.

`check-wave1-review.js` exercises production renderer/host functions with synthetic
DOM, stores, receipt streams and delayed IPC. Existing #401 race checks remain.
`check-outbox.js` adds real temporary SQLite restart coverage for uncertain SMTP.
Native rendering, actual tracking requests and live provider writes are not
certified by synthetic checks. Scheduled preflight history (Agent P3 F7) is deferred.
