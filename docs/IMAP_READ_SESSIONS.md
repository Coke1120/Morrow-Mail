# Bounded IMAP read sessions

One cached-mail reconciliation round can use one authenticated connection for
change discovery and the following flag read. Previously these two operations
each connected and logged in. The connection belongs to that round and mailbox;
it is closed before the local checkpoint transaction and never pooled across
sync ticks, requests or accounts. Recent-body downloads, history pages, folder
catalogs and provider writes keep their existing connection lifetimes.

Before either phase, the service compares the complete saved connection with
the captured connection. A changed password, reconnect or disconnect rejects
the next phase. Each phase still rechecks capabilities, selects with EXAMINE,
and validates UIDVALIDITY. Existing origin checks, response-size limits,
50-message flag batches and atomic message/checkpoint commits remain required.
Each phase has a 45-second deadline; preparation and both reads share an outer
90-second deadline. The final local transaction is separate from that network
deadline and retains its existing connection/checkpoint checks.

The session is moved into each pending operation. Cancellation, a partial
response or a returned read error drops its socket; there is no reconnect or
replay inside that round. Existing capability downgrade after a completed
rejected extension command remains supported. A rejected folder examination is
different: the failed discovery socket is dropped, and the existing independent
flags/LIST verification opens a fresh, connection-checked session before it can
declare a folder missing. It does not retry discovery or save partial progress.

Read-session reuse does not change provider-write authorization or recovery.
The original read-session unit required both MOVE and UIDPLUS, matched
case-insensitively as capability atoms, and added no write fallback. Current
source separately implements [reviewed non-MOVE recovery](IMAP_MOVE_RECOVERY.md)
for eligible UIDPLUS servers. Unsupported preflight still makes no move;
uncertain writes require provider review and never replay automatically.

The new loopback TLS tests count actual LOGIN commands, cover independent ticks
and colliding IDs across owners, and exercise connection replacement, cancel,
partial data, capability/UIDVALIDITY changes and missing-folder verification.
A stalled response exercises the real 45-second timer; separate controlled-deadline
unit assertions cover the 90-second cap and exhausted session lease. See
[execution status](../VERIFICATION.md#bounded-imap-read-session-candidate--15-october-2026).
After stacking identity commit `01c1f0a`, the focused TLS run passed all ten cases;
the complete Linux Rust suite passed 456 tests with zero failures and four
existing ignored benchmarks. Formatting and strict all-target Clippy passed on
the same 100-file Rust/Cargo source manifest. Subsequently,
[paired native run 38723970357](https://github.com/Coke1120/Morrow-Mail/actions/runs/38723970357)
passed on PR #53 head `d602c2f`: macOS Rust 461/0/4 and strict reader 40/40;
Windows Rust 457/0/4 with complete fresh/owned/restart observations and
relocated-package acceptance. The actual synthetic checkout `f55a7be`, PR head
and normal main merge `796b93f` share tree `72618791eea82b1afab04d204be9e76aa5461eb4`;
the linked execution status records the original base and full commit identities.
These results cover that tree, not later combined release sources. Fixture
connection counts do not establish WAN speed, battery, UI latency or live-provider
acceptance. Clean-machine and manual accessibility acceptance, Developer ID/
notarization and Windows code signing also remain incomplete.

The original read-session unit did not implement IDLE or non-MOVE recovery.
Their current, separate implementations are documented in
[bounded notifications](IMAP_IDLE_NOTIFICATIONS.md) and
[move recovery](IMAP_MOVE_RECOVERY.md). The notification reader has its own
owned shutdown, selection/reconnect invalidation and resource limits; recovery
uses a durable step journal, targeted UID EXPUNGE and explicit review of
uncertain copies. Read-session reuse itself adds no persistent connection pool.
