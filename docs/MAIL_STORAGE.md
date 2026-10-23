# Mail storage

The host stores cached mail and attachment bytes in a normal SQLite file.
`better-sqlite3` reads that file in pages. Startup does not copy it into a
JavaScript `ArrayBuffer` or a WASM heap. Small mutations still do not rewrite
the checkpoint. `host/mail/persistence.js` keeps a SQLite checkpoint plus a
durable SQL transaction journal:

| File | Purpose |
| --- | --- |
| `mail.sqlite` | Last complete SQLite checkpoint, including a database generation and transaction sequence |
| `mail.sqlite.live` | Disposable working copy, rebuilt from the checkpoint on open. Not part of a backup |
| `mail.sqlite.journal` | Transactions committed since the checkpoint (or since rotation) |
| `mail.sqlite.journal.pending` | Sealed journal being folded into a new checkpoint |
| `mail.sqlite.tmp` | Unpublished checkpoint; never used for recovery |

## Commit and recovery

Every DB mutation runs inside a synchronous SQLite transaction. The host records
the SQL and its bound values, including prepared search-index inserts. Adjacent
uses of the same statement share one set of bindings. Binary attachment data is
stored directly after the JSON metadata, without base64 expansion.

Before the in-memory transaction commits or its caller receives success, the host
appends a complete journal frame and calls `fsync`. Each frame has independent
SHA-256 checks for its header and payload, a database generation, and a monotonic
sequence. A transaction that throws rolls back both its message/index changes and
its journal append. If repairing/syncing a failed append also fails, the database
closes and requires reopening; later writes cannot follow an uncertain tail.

On open, replay the sealed journal and then the active journal. Records already in
the checkpoint are skipped by sequence. A short final active frame is an
interrupted append and is truncated before further writes. A complete invalid
frame, invalid header, different generation, sequence gap, or incomplete sealed
journal fails open with an error, preserving the files for diagnosis. The store
does not reset a corrupt database to an empty mailbox. An exit between syncing a
record and returning success can recover that unacknowledged transaction, as with
other durable commit protocols.

`db.close()` closes the working copy without rewriting the checkpoint:
acknowledged changes are already in the journal. Its returned promise waits for
a checkpoint already in progress. `db.open()` also waits for that worker before
reopening/replacing an existing handle. It copies the checkpoint to
`mail.sqlite.live` and replays the journals there. Initial adoption of an older
SQLite file performs one atomic snapshot after migration; subsequent opens
replay changes and skip unchanged migrations. A failed copy deletes only a
partial working copy.

## Checkpoints and no-op sync

After 256 transactions or 8 MiB of journal data, a one-second timer coalesces a
checkpoint. The host seals the active journal by rename, opens a new active file,
and sends only file paths to a Node worker. That worker copies the last checkpoint
to `mail.sqlite.tmp`, replays the sealed records, fsyncs, and atomically renames
it over `mail.sqlite`. Only after that completes is the sealed journal removed.
New transactions remain in the active journal and the working copy. The worker
does not read the working copy and does not allocate a second copy of the file
in the JavaScript heap.
`await db.checkpoint()` can explicitly checkpoint all transactions acknowledged at
the time of the call, including when another checkpoint is running.

On POSIX, directory fsync orders file creation, rename, and journal removal.
Windows uses file fsync and same-directory atomic rename; Node does not provide
the equivalent directory handle flush there. Rename/write failures retain the
durable journal and background checkpoints retry after 30 seconds. The engine is
`better-sqlite3`. Packaged builds rebuild that native module for Electron and
unpack it from the asar. There is no sql.js database and no full-file export.

The worker closes its database before reporting completion and is reused for
later checkpoints. The watchdog is 60 seconds plus 30 seconds per 256 MiB and
then terminates a stalled worker; failure retains the sealed journal for retry.
Reopen waits for outstanding disk work to finish. It does not wait for teardown
of an already idle worker: Electron can stall thread teardown after a successful
completion reply.

Unchanged flag values, folder names/delimiters, auth errors, and sync metadata are
guarded before mutation. Empty transactions create no journal frame. Warm sync
prunes missing UIDs and updates counts/cursors in one transaction. The latest
successful observation is kept in session memory without dirtying the DB merely
to update `synced_at`. After a restart, freshness falls back to the last durable
sync change until a new observation arrives. New mail, deletions, UIDVALIDITY
resets, search index changes, counts, cursors, and real auth changes remain durable.

## Maintenance and limits

- Back up the SQLite file **and both journal files together**, with the app
  stopped. Copying only `mail.sqlite` can omit acknowledged changes. Before
  downgrading to a build without journal support, quiesce writes, await
  `db.checkpoint()`, and close; confirm no pending journal and an empty active one.
- The app's existing single-instance lock supplies the single writer. Do not open
  the same storage directory in independent host processes.
- SQL execution, journal encoding, and the small commit fsync remain synchronous.
  Large new bodies/attachments and startup recovery still need disk and CPU.
  Opening a mailbox needs about as much free disk as the checkpoint, for the
  working copy. If that copy cannot be made, startup stops and leaves
  `mail.sqlite` and the journals untouched.
- A checkpoint copies the checkpoint file once in a worker. The wait is 60
  seconds plus 30 seconds per 256 MiB. A slow disk can still hit that limit; the
  sealed journal is kept and the copy is retried. shortcut: raise the timeout
  when a healthy copy of a large mailbox is still killed.
- Repeated checkpoint failures can grow the journal; storage errors must be fixed
  before compaction can succeed. The journal contains the same sensitive mail
  data as SQLite and uses mode `0600`, subject to platform permission semantics.
- Future writes must use the transaction/recording helpers, including prepared
  writes. Replay must remain compatible with stored SQL across schema changes.
  Replay existing journals before migrating the schema.
- Power-loss guarantees remain subject to OS/filesystem/hardware flush and
  atomic-rename behavior. Tests simulate process exits and I/O failures; they do
  not certify power loss or Windows antivirus/storage behavior.

## Validation

`npm run check` includes `scripts/check-mail-persistence.js`: real SQLite with fake
IMAP, zero-write warm sync, small durable flag records, rollback, search/index and
blob recovery, scheduled-to-draft atomicity, UID reset/deletion recovery, partial
write/fsync failures, automatic compaction, concurrent mutations during a worker
checkpoint, failed rotation/retry, exits before/after snapshot rename, abrupt
process exit, torn tails, checksums, generation mismatches, and sequence gaps.

Run `node scripts/probe-mail-persistence.cjs` for observations using 500 headers,
32 KiB indexed bodies, and a 64 MiB cached attachment. It counts main-thread
exports and bytes written, checks that hot paths leave the snapshot untouched,
and reports event-loop progress during a worker checkpoint. It has no latency
thresholds. Repeat on Windows with a real mailbox/storage profile before drawing
conclusions about that machine's responsiveness.
