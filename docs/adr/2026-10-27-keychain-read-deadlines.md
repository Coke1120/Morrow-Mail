# Bound asynchronous macOS credential reads; preserve synchronous commits

Status: proposed implementation in a draft PR. Native validation is pending.

Base: `163146384267909f527a399891304efd6f1bc0e3` (v0.3.3).

## Problem and chosen scope

`host/mail/mac-secrets.js` invoked `security` through `spawnSync` without a
deadline. Routine `engine.secretFor` reads, startup scans, feature gates and
credential mutations could block the main event loop. Prior performance work
measured this wait but did not migrate it.

This change moves routine mail reads and startup/missing-credential scans to
asynchronous subprocesses. It bounds all remaining macOS compatibility commands,
but deliberately retains the synchronous API used by feature/status gates,
reconnect commits, deletion and compensation. Those paths can still pause the
main thread for up to 30 seconds per command. Multiple commands can take longer.
This is an incremental read migration, not complete asynchronous credential I/O.

## Read contract

- A read-only `find-generic-password` child has a 30-second deadline including
  time in its queue, a 1 MiB output limit and ignored stderr. At most four
  children run; cancellation/deadline/overflow sends SIGKILL and stops collecting
  output. A child that has not closed retains its concurrency slot. Callers stop
  waiting even if a synthetic child ignores kill. There is no shell invocation.
- Same-backend/account concurrent callers share pending work. Each caller can
  cancel separately; the underlying read stops when no callers remain. Completed
  credentials are never cached. Error messages omit child output and arguments.
  Nonzero find exits retain the existing `null` compatibility result; native
  prompt/denial distinctions have not been redesigned.
- The facade invalidates pending reads before every in-app write/delete attempt,
  including an attempt that later fails. Opaque revisions detect changes after
  an await without a permanent cache of credential values. Deleting a record
  releases its tracking entry; a later same-ID record has a different token.
- `secretFor` pins account incarnation and rechecks login/transport and revision
  around each async read. It retains the actual-value comparison after OAuth and
  verifies Google client binding again before returning/storing a token. There
  is no await between the final guards and a synchronous refresh-store attempt.
  A failed synchronous reconnect which restores the exact prior account and
  credential can still allow an already-running refresh to finish. A successful
  reconnect or a changed value/read revision remains rejected.
- Startup/cancel scans do not mark a removed/recreated/reconnected mailbox as
  missing. OAuth cancellation increments its generation and cancels the browser
  flow and acknowledges synchronously before its async scan. This preserves the
  public immediate-cancellation contract; a failed scan records only a fixed
  deferred-check note and cannot replace cancellation success. A read timeout never deletes or
  replaces credentials; its generic storage error is not treated as a new
  password failure or followed by another synchronous redaction read.

## Boundaries and later work

Scopes, Google client precedence, provider transports, Keychain service/account
names, Windows DPAPI, SQLite/journal/fsync and existing compensation are unchanged.
There are no new IPC or CLI operations. Features and Accounts help explain both
the async read path and remaining compatibility waits.

Moving writes to async requires a separate per-account mutation protocol that
serializes reconnect, refresh, feature writes, removal and rollback, revalidates
after storage waits, and never compensates over a newer commit. Simply adding
`await` inside the current synchronous credential/SQLite block is unsafe. The two
stores remain non-atomic across a process crash; this change makes no stronger
atomicity claim. Read revisions track in-app mutation, not an OS-wide transaction
against unrelated external Keychain edits.

This decision covers PR #340's credential-read work. The combined draft also
includes PR #341's [cooperative startup search repair](2026-10-27-cooperative-search-index.md),
which implements the first slice of [the original design plan](../SEARCH_INDEX_RESPONSIVENESS_PLAN.md).
The two changes retain their separate scope and validation evidence.

## Validation

`node scripts/check-keychain-reads.js` uses fake child processes, a manual timer,
the actual facade and extracted production engine functions. It covers event-loop
availability during a blocked read, queue/deadline/output bounds, kill failures,
late events, launch errors, independent/shared cancellation, revision invalidation,
removal, reconnect, stale refresh, changed Google client, startup/cancel races and
compatibility command options. Full checks additionally exercise the real engine
with in-memory credentials and synthetic providers and mount the Features/help
DOM. No real Keychain, password, OAuth grant, mailbox, AI request or native window
is accessed.

Native macOS unlock prompts, permission dialogs, actual `security` termination,
ACL behavior and real-user latency remain unverified. A blocked fake process
demonstrates event-loop availability, not a speedup or guarantee for all app work.
