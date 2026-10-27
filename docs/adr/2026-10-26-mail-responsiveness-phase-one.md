# Measure main-process stalls and reduce redundant mail work

Reports identify startup, mail sync and switching messages as beachball triggers.
Source inspection found blocking Keychain calls and synchronous SQL/index/journal
work in Electron main, plus body materialization for metadata-only consumers.
These are risks; no actual user Mac trace establishes the cause.

Keep this change independent of the functional-fix release. The PR base is
release-integrated dev `fe22d215e83fed7f68f39ba3d59efb2d78c020c0`. Benchmark baseline
`aee7006f01f1301452c3d073683d79927beebce2` already includes PR #319; its measured
host data paths are identical to the newer base. Use a bounded first phase rather
than a full database-worker extraction, Rust backend or Tauri shell.

1. Add off-by-default `MORROW_PERF=1` diagnostics with fixed stage labels, numeric
   aggregates and a main-loop histogram. Use the existing bounded in-memory Debug
   log, with no mail/request/identity/credential/path data or telemetry. Async IPC
   timings retain fulfillment/rejection and synchronous return behavior.
2. Use explicit metadata projections for lists and thread headers. Compute body
   availability inside SQLite with the existing whitespace semantics; keep full
   body APIs and every metadata field/order unchanged. Avoid a schema/backfill
   migration during startup and avoid changing long-thread membership behavior.
3. Skip IMAP token-index rewrites when indexed source fields are unchanged. Use
   SQLite comparisons instead of materializing the old bodies just for equality.
   Reindex real edits and repair missing document entries. Preserve Gmail's
   existing conditional reindexing, durable transaction/journal/fsync and replay.

The Keychain call is timed but its synchronous interface is preserved. Making
only some callers async without migrating all token-comparison, account-change,
error and cancellation paths risks stale credentials or changed consent behavior.
There is no credential cache or reduced durability in this performance change.

Correctness checks cover public metadata/full-body parity, Unicode whitespace and
NUL, cached open/thread behavior, actual journal commands for unchanged/changed
index writes, search after replay, diagnostics privacy/bounds and synthetic
Keychain interception. A repeatable offline large-mailbox/long-thread benchmark
compares the same harness on the exact base and candidate. Native UI, actual
beachball resolution, credential delays and live-provider performance remain
unverified. See `docs/PERFORMANCE.md` for measurement interpretation and commands.
