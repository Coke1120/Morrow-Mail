# Recoverable reads, bounded sync, preserved signatures and conversation identity

The v0.3.6 functional review reproduced three failures with production host and
renderer code and synthetic data: a failed body GET returned the cached summary
as a successful open and marked it read; a history record containing many
messages monopolized the account lane; and cross-mailbox From changes rebuilt
edited signature content as plain text.

A fourth owner-confirmed failure showed one Gmail message as several earlier
conversation members because its label-folder records were counted separately.

## Reader failure boundary

A foreground download with no usable cached body now fails with a fixed,
actionable error. Main and separate readers expose Retry download. The failed
open never reaches their automatic mark-read step. Retry uses a full body read.
Existing partial bodies still paint immediately. A failed fill retains those
bodies and publishes a persisted download warning; Retry can finish the body
and clear the warning. A changed account/message cannot receive a stale warning.
Complete cached bodies remain available if a metadata-only refresh fails.

## Durable read budget

Gmail `history.list.maxResults` limits records, not messages. Each folder pass
now allows at most 20 actual full-message reads, shared by history changes,
bootstrap's older/newest pages and cache verification. Deadline and waiting
foreground work stop the pass between reads. An in-flight provider request is
not preempted, and no live latency bound is promised.

Before processing a page, store its exact IDs, offset and continuation in the
existing `gmail_sync.state_json.pending` record. Keep the old history/page cursor
until every ID has been applied. Adoption and its offset commit in the same
synchronous SQLite/journal transaction, after parsing and any identity lookup.
There is no await or observer inside that transaction. A 404 removal and its
offset also commit together. Failed checkpoints roll back both data and offset.
The next pass/restart resumes the pending IDs before requesting another page.
History deletion pruning and admission of that pending page are atomic.

Cache verification uses its saved UID position and the same read budget. Finish
pending verification before admitting new history, so busy updates cannot starve
it. Horizon changes discard obsolete pending work and bootstrap the new window;
already stored mail stays. Reconnect/removal retains the existing incarnation
checks. No OAuth scopes, grants, write retries or provider mutations are added.
An older version ignores the new pending field and re-reads from the old cursor;
it does not advance past unapplied history.

## Signature ownership

Cross-mailbox From changes reload the destination's signature choices while
checking the current signature's text and DOM. Only an unchanged automatic
signature is replaced or removed. An edited signature, including markup-only
edits, stays with the body and stops following From. The same rule applies when
the destination has no signatures. The rest of the rich body is never rebuilt
for this change. An explicit picker selection retains its existing behavior.

## Conversation identity

Only conversation results are deduplicated; raw per-folder rows remain stored.
A nonempty validated Gmail provider message ID within the same account identifies
label copies. Keep the selected row as representative when it is part of that
group. Both openEmail and the thread-member channels use the same projection.
There is deliberately no RFC Message-ID fallback: separate deliveries can reuse
it, and absent provider IDs cannot prove equivalence. Different accounts,
different provider IDs, and pending local draft edits remain separate. A single
unique member does not create a thread strip or Earlier section.

`scripts/check-reviewed-mail-flows.js` exercises actual host/SQLite and renderer
with fake Gmail responses, temporary stores and JSDOM. It covers failed reads,
retry/mark-read boundaries, large history records, restart/checkpoint recovery,
foreground queue priority, shared bootstrap/verification budgets and real
signature application with edited or unedited rich bodies, and multi-label
conversation identity/counts without deleting folder copies. The full check runner
includes it. Native macOS/Windows windows, real providers and native latency
remain separate validation; prior administratively blocked browser navigation
is not retried or bypassed.
