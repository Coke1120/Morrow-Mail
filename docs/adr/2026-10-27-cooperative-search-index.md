# Cooperative startup search-index repair

Status: implemented in a separate draft PR; native profiling and review pending.
Base: `163146384267909f527a399891304efd6f1bc0e3` (v0.3.3).

## Scope

Full index repair used one synchronous startup transaction and materialized every
message ID. This change keeps the same SQLite owner, tokenizer, body/term caps,
index schema and durable journal, while awaiting a cooperative rebuild after
schema migration. No worker writes the live DB and no provider is contacted.
PR #340's Keychain read migration is independent; this branch does not include it.

At most 64 IDs are selected by keyset per batch. Work checks an 8 ms slice budget
between messages/orphan IDs, commits through the existing transaction/journal
path, then yields with `setImmediate`. The budget is not a maximum latency: a
single message, SQL scan, serialization, disk/fsync or replay call can still pause
the main thread. No native Mac or end-user speed claim is made.

## Durability and recovery

The existing `message_fts_meta`, `message_fts_doc` and `message_fts` tables remain.
Repair replaces each message's document and terms atomically; it never clears or
drops entire index tables. Separate bounded stages remove orphan document/term
IDs. Version/doc-ID checks detect missing or mismatched documents even when counts
match. Existing incremental content/flag behavior is retained after admission.

Before yielding, repair durably writes `version = building:1` and a `rebuild`
marker carrying target, store generation, total, cursor, completed count and stage.
Each batch commits its cursor together with its index changes. On restart, valid
same-generation progress resumes after checking the source count and document
prefix; malformed/incompatible state restarts repair without deleting mail. Older
apps also see the building version as requiring repair. Only a final verified
transaction restores the complete version and removes the marker. Every existing
journal checksum, append/fsync, rollback and checkpoint rule remains in force.

## Admission and cancellation

Private synchronous scopes allow only migration/rebuild SQL while opening. They
never span an await, and observers run outside those scopes. Public data reads
and mutations reject with retryable `mail_not_ready` until open resolves. Same-file
opens join; another target or conflicting owner signal rejects `mail_open_busy`.
The initiating signal or `close()` cancels shared initialization. Cancellation
waits for owned load/close cleanup, preventing a late load from publishing a stale
connection; completed batches remain durable. A pre-aborted open does not replace
an already ready store. Errors/cancellation never publish partial search readiness.

Startup receives only phase/count/resume progress. The opening window updates at
most every 100 ms plus final completion. It explains preparation/resumption and
finishing checks; it does not claim a provider sync percentage. Startup quit closes
initialization and suppresses an intentional-cancel failure dialog. Ordinary quit
and scheduled-send behavior are unchanged. Features and Search coverage explain
readiness, restart and remaining single-operation pauses; no CLI/API command is
added.

## Validation boundary

`check-index-opening-control.js` exercises actual module lifecycle guards with a
held synthetic storage load and fixed DOM objects, plus fake-window progress
throttling, quit cleanup, intentional/genuine failure and late-success guards.
Initialization resolving after startup quit cannot continue to open the shell.
The real SQLite fixture
`check-search-index-rebuild.js` compares all indexed documents/terms against the
incremental index, checks event-loop heartbeats and admission, malformed markers,
abort/close and resume, journal failures before batches/final publication, child
process exits after partial/final commits, warm reopen and later content/deletion
updates. JSDOM exercises actual progress scripts and Features/help rendering.
All fixtures use temporary synthetic stores; no mailbox, credential or native
window is accessed. Full Linux/Windows checks and independent review are required.

This does not move journal replay, schema migration, tokenization or storage to
another thread. Pure tokenization workers, interactive search during repair and
broader storage architecture remain separate work if measurements justify them.
