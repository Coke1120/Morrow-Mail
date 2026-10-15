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

Move preflight still requires both MOVE and UIDPLUS, matched case-insensitively
as IMAP capability atoms. Missing support returns the fixed explanation that no
move was attempted. An unconfirmed result after a move keeps the existing
check-provider-before-retry warning. No COPY/STORE/EXPUNGE fallback or automatic
write replay is introduced.

The new loopback TLS tests count actual LOGIN commands, cover independent ticks
and colliding IDs across owners, and exercise connection replacement, cancel,
partial data, capability/UIDVALIDITY changes and missing-folder verification.
A stalled response exercises the real 45-second timer; separate controlled-deadline
unit assertions cover the 90-second cap and exhausted session lease. See
[execution status](../VERIFICATION.md#bounded-imap-read-session-candidate--15-october-2026).
After stacking identity commit `01c1f0a`, the focused TLS run passed all ten cases;
the complete Linux Rust suite passed 456 tests with zero failures and four
existing ignored benchmarks. Formatting and strict all-target Clippy passed on
the same 100-file Rust/Cargo source manifest. Native CI remains pending.
Fixture connection counts do not establish WAN speed, battery, UI latency or
live-provider acceptance.

IDLE watchers and non-MOVE fallback are separate, unfinished implementation
units. [RFC 2177](https://www.rfc-editor.org/rfc/rfc2177.html) requires capability
support and DONE/tagged completion before another command; a watcher also needs
owned shutdown, selection/reconnect invalidation and bounded resource use.
[RFC 6851](https://www.rfc-editor.org/rfc/rfc6851.html) explains the intermediate
states of COPY/STORE/EXPUNGE. A safe fallback needs a durable step journal,
UID-specific expunge guarantees and explicit recovery for uncertain copies;
this read-session change does not supply them.
