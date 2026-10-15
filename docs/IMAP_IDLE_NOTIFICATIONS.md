# Bounded IMAP notifications

Current source accelerates existing automatic mail synchronization with read-only
IMAP IDLE. Inbox and eligible selected custom folders participate. It does not
make IMAP a complete mirror or guarantee real-time delivery. Identity,
read-session reuse and selected-folder synchronization are stacked prerequisites.
The original candidate's Linux synthetic results are recorded below. Each later
combined source requires its own native SDK and release checks; live-provider
acceptance remains incomplete. This feature was not included in v0.8.2.

## Eligibility and actual watch scope

The existing **Sync all accounts while Morrow is open** interval enables
notifications. **Manually** stops periodic synchronization and IDLE; ordinary
already-requested quota/update continuations retain their existing rules.
Gmail and Outlook use their existing paths. There is no hidden provider write or
new preference.

An Inbox scope is eligible when the current connection's saved import options
include Inbox or All Mail, or ordinary sync uses its default Inbox scope.
Sent-only options do not permit an Inbox watcher. An older connection's import
cannot change the new connection's scope.

A selected custom folder is eligible only while all of these hold:

- The saved selection has the current IMAP server origin, a selection version,
  a stable entry ID, a safe path, and a committed checkpoint with known nonzero
  UIDVALIDITY. Saving a new selection alone does not establish that baseline.
- Its catalog belongs to the current connection, succeeded within the last
  15 minutes, and still identifies an available, selectable custom folder
  outside protected Spam/Trash/virtual subtrees.
- The folder is not blocked for recovery, and both its own retry deadline and
  the account's existing read backoff permit a read.

Eligibility is permission to join the rotation, not evidence that a folder is
currently watched or fully downloaded. At most four accounts have notification
leases at a time, with one folder per account. Both accounts and eligible folders
rotate fairly. Each lease includes setup and DONE within a 60-second budget;
a changed-mail hint delays that account's next lease by 30 seconds. Selecting
20 custom folders does not create 20 sockets or simultaneous push coverage.
Notification scopes that are not currently watched retain ordinary bounded sync
and its recovery rules. An expired catalog pauses custom notification eligibility
until the existing background catalog refresh or an explicit folder refresh
succeeds. That metadata worker retains its own schedule and recovery rules,
including when periodic mail sync is off; IDLE adds no catalog refresh worker.

There is at most one pending or running hint per account and at most four in
total. These are resource limits, not measured latency or completeness claims.
A notification does not advance the folder's checkpoint, successful-sync time,
or caught-up time. Only the existing atomic sync commit can do that.

## Ownership and cancellation

Each lease captures the account, full connection, canonical server origin,
folder path, known UIDVALIDITY and private monotonic generation. Custom leases
also capture the selection version and entry ID. Settings writes invalidate
changed identities synchronously. Deselect/reselect and connection A→B→A cannot
revive an old worker even if a receiver observes only the latest value.

Attempt/success timestamps and checkpoint UID progress are not identity changes.
Catalog freshness, folder blocking and retry deadlines are separate eligibility
gates. Their clocks are rechecked without requiring a settings write; expired
or future scopes retain their place and failure policy without repeatedly
starting false-ready leases.

The private watch snapshot is not network authorization. Before connecting,
publishing a hint and starting its read, the worker checks committed settings
through the serialized Store executor. The consumer's opaque scope proof is
checked in the same Store closure that captures the sync round's initial
settings, so a queued old hint cannot adopt a new connection or selection.
A rolled-back write can conservatively
cancel a socket but cannot authorize speculative provider access. Network work
does not run under the Store lock.

Disconnect, credentials/origin/connection changes, loss of eligible scope,
deselection, rename, UIDVALIDITY changes, recovery gates and disabling the
interval cancel the affected lease. Cancellation drops the read-only socket
without waiting for DONE. The service owns its task group and joins it during
shutdown. Update quiescing cancels active readers and pauses new leases/reads
with a one-second check. Failed update preparation can resume the same worker
with its existing blocked failures and retry deadlines. No detached retry
worker or cross-tick connection pool survives the service task.

## Protocol, failures and the existing sync path

The server must advertise an exact case-insensitive IDLE capability. Custom
folders also undergo a complete live LIST check before read-only EXAMINE;
unsafe, missing, nonselectable and protected paths cannot become IDLE targets.
EXAMINE must report nonzero UIDVALIDITY matching any known value. A continuation
must arrive before DONE. Normal departure sends untagged DONE and requires its
matching tagged OK within the remaining absolute lease budget. That socket is
never reused for another command. Keepalives cannot extend the deadline.
Notification and DONE phases each bound responses to 128 KiB; setup retains
existing command bounds and is limited to 45 seconds within the lease.

Missing/rejected IDLE, authentication, TLS trust and protocol failures block
notifications for the entire current account/connection generation. Rotating
its other folders, reviewing a selection, writing progress timestamps or
pausing/resuming for an update does not retry that login. A changed connection,
explicit disable/re-enable or service restart permits detection again. A missing
folder or UIDVALIDITY mismatch blocks only that folder's notification identity
until its reviewed identity changes; another eligible folder/account can
continue. Transport failures back off for the whole account from 30 seconds to
five minutes. Existing persisted quota waits always take precedence. Polling
and selected-folder recovery retain their existing behavior.

A hint contains no message content, UID list or provider text. Its separate
consumer takes the existing mailbox gate, revalidates the captured scope and
calls the thin owner-scoped `mail::sync_notification` entry into the shared sync
round. Thus the normal primary-before-custom ordering, selected page budget,
atomic checkpoints, source guards and provider read backoff still apply. An IDLE
wait never holds the mailbox gate. If a bounded hint is coalesced or dropped,
ordinary sync still owns progress.

As in ordinary sync, committed new mail may queue an arrival summary only when
the existing AI arrival policy permits it. IDLE does not call a model or wake
the separate Brain/AI/automation tick; later execution uses that worker's
existing permissions.

## Verification boundary

The 20 original protocol/lifecycle cases and 11 selected-folder cases use
owned ephemeral TLS servers, temporary stores and fictional credentials. They
cover continuation/DONE ordering, capabilities, partial/oversized responses,
absolute deadlines, cancellation, rollback/ABA, current import/UIDVALIDITY,
fair owner/folder rotation, four total/one-per-owner socket bounds, clock-only
retry/expiry, live catalog checks, account-wide versus folder-only failure
policy, update quiescing, hint coalescing and read-gate freshness. Real TLS
notification-to-sync cases use the shared production sync implementation;
Inbox arrival-policy off/on checks include zero direct model calls, and the
custom case checks owned message/checkpoint commits without inventing freshness
from the notification itself. A held-Store guard case rejects a captured proof
when connection or selection changes before the initial sync snapshot. Its
intentional unchecked control adopted replacement scope; this is a sync-entry
contract test, not a reproduction of the original consumer’s entire scheduling
interleaving.

For the original Linux candidate, all 31 notification cases and 18 existing
selected-folder focused cases passed.
Formatting and locked all-targets Clippy with `-D warnings` passed. The complete
Rust suite passed 505 tests with zero failures and four existing ignored
benchmarks. Final formatting, Clippy and full tests used the same 105-file
Rust/Cargo manifest. Tests use shortened private lease/backoff injection, not
a production 60-second timing experiment. No live
mailbox, live model, sending, native SDK build or release validation was run for
this candidate. No production TLS bypass or global trust override is added.

Protocol basis: [RFC 2177](https://www.rfc-editor.org/rfc/rfc2177.html).
The cached async-imap 0.11.3 IDLE helper resets its wait timeout on keepalives,
so this implementation checks raw responses under an absolute budget.
