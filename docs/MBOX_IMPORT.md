# Import MBOX into Local Folders

This is the proposed implementation for [#521](https://github.com/Coke1120/Morrow-Mail/issues/521),
built on the durable Local Folders foundation in [#524](https://github.com/Coke1120/Morrow-Mail/pull/524).
It is not a published release. No import runs merely by opening the dialog.

Choose the **Import MBOX…** icon button beside **Local Folders** in the account
list, then **Choose files…**. Review the files,
destination and source format before **Import**. Create a destination in the
dialog or use an existing local folder. Multiple files go to that one destination;
repeat with another destination for separate folders. There is no CLI/bot importer.

For Thunderbird, export a mailbox or close Thunderbird and copy a complete
mailbox file out of its profile. Select the **copy**, including a file with no
extension such as `Inbox`. `.msf` is an index and is rejected. `.sbd` directories,
Maildir and entire profiles are not imported recursively: select each exported
mailbox explicitly. A partially downloaded Thunderbird IMAP store cannot supply
messages whose complete bodies were never downloaded. No live profile mutation,
directory discovery, provider folder creation, upload or provider write occurs.

## Formats and fidelity

- Choose **mboxrd** for Thunderbird/recursive quote exports, or **mboxo** only for
  a known legacy single-quote export. This choice is frozen after starting.
  Automatic guessing cannot recover the original quote depth reliably.
- A separator is `From sender Thu Nov  5 10:00:00 2026` (including Thunderbird's
  `From - …`) with a ctime-style English day/month/date; optional timezone words
  or numeric offsets are accepted. LF and CRLF work, as does no final newline.
  Ordinary body lines such as `From the report` do not split a message.
- mboxrd removes one `>` from body lines matching `^>+From `; mboxo removes one
  from `^>From ` only. A legacy mboxo archive cannot distinguish a literal
  single-quoted `>From `; selecting it explicitly accepts that convention.
  Header bytes are never unescaped. Every other byte between separators is
  retained, including inter-message blank lines; no trailing-blank normalization
  is guessed. Consequently a differently padded export may import separately.
- A reserved, unescaped ctime-style envelope followed by a complete header block
  is a separator in these formats. Such text must be quoted when it is body text.
  A possible separator followed by malformed/truncated headers stops before
  acknowledging the preceding ambiguous message. The original remains available.
- Content-Length headers are rejected rather than misreading mboxcl/mboxcl2.
  EML, alternate/non-ctime envelopes and other MBOX dialects are unsupported.
- Production mailparser and MIME decoding diagnostics run in an isolated worker.
  The original de-framed MIME keeps all headers and dates/time zones. Parsed
  unknown dates remain unknown; no import time is invented as a sender date.
  Raw originals, bodies and attachment bytes remain independently owned after
  account removal and cache cleanup. Reading uses the existing sanitizer,
  remote-content preference and attachment safety limits; nothing auto-opens.
- Missing top-level multipart closure fails that entry. Other malformed MIME is
  accepted or rejected according to the production parser; successful parsing is
  not proof that the sender's MIME was well formed. Charset uncertainty/loss stays
  visible in the reader, with recoverable original bytes through **Save EML**.
- `X-Mozilla-Status` maps Read (0x1), Replied (0x2), Marked (0x4) and Forwarded
  (0x1000). Expunged (0x8) entries are counted as skipped, not revived.
  Partial (0x400) entries fail explicitly rather than claim a complete import.
  Queued/draft metadata never creates a sendable draft or scheduled delivery.
  Legacy `Status: R` and `X-Status: F` map read/star; absent flags default to read. Other
  tags, junk classifications, templates, drafts, profile settings and account
  identities are not imported. They remain in raw headers. Local imports do not
  enter provider notification, rules, scheduled-send, Brain/AI or bot enumeration.

## Duplicates, counts and recovery

Duplicate identity is SHA-256 of the exact de-framed RFC message bytes, scoped to
the **original import destination**, with a durable receipt. Identical messages
from renamed archives or a different selected format that produces the same bytes
skip that receipt even if the saved message was later moved locally. Other
destinations keep independent copies. Missing/reused Message-ID is safe; distinct
same-ID content remains separate. Changed headers, line endings, padding and
status headers mean different bytes and are imported separately.

**Imported** counts only complete durable message commits; **Skipped** includes
duplicates and explicitly counted Thunderbird deleted entries. **Failed** counts
entries safely isolated by confirmed boundaries. Ambiguous framing/read/storage
failures stop the job with a partial summary, rather than count unknown input as
successful. The first 50 entry failures show source byte ranges; the latest 100
jobs appear in the dialog. Progress distinguishes examined phase bytes from input
offsets committed with mail. Staging/verification is indeterminate overall progress.

Before reading a file, Morrow copies it in 64 KiB chunks to a mode-0600 private
snapshot, hashes it and compares source inode/device/size/mtime/ctime before and
after copying. Changed/replaced sources are rejected. The snapshot is fsynced and
atomically published before its receipt is saved. Source files are never edited.
Snapshots need free disk roughly equal to the sources **in addition** to parsed
mail, raw MIME, attachments and SQLite rollback-journal needs.

Message/body/attachment bytes, a duplicate receipt and progress/counts commit in
one native SQLite EXTRA transaction. Cancellation stops parsing/remaining work
and checks again before commits. Synchronous SQLite commits finish atomically;
a Stop click can therefore acknowledge the current message before it is observed.
Prior commits remain saved. Closing the app asks the importer to stop; abrupt
exit is recovered by SQLite. Restart marks work interrupted and never imports
automatically. **Continue** verifies the **whole private snapshot** by stat,
length and SHA-256 before reading a committed byte offset, then checks its stamp
before every commit. A byte-identical backup restore may have new filesystem
identity; only a full matching digest permits adopting that new stable stamp.
It does not read a changed original file at an old offset:
the immutable snapshot is the resume source. Editing/removing the original after
snapshot publication does not change that snapshot. Never edit private snapshots.

Parsing failures, oversized messages, storage errors and cancellation retain the
snapshot and acknowledged archive. A storage failure reloads durable counts;
if the database itself is unavailable, reopening/recovery is required before
claims about progress. Fix disk/permission problems before continuing. A changed
snapshot requires a new job from a good original export. Duplicate receipts make
that safe. Failed entries already counted as failures are not retried by Continue;
import a corrected export as a new job to retry them.

**Remove snapshots…** requires a separate review. It deletes only that job's
private source copies, preserves original sources and all local mail/receipts,
and ends continuation and recovery for failed input. Completed and failed jobs
otherwise retain snapshots. Back up `local-folders.sqlite` with Morrow stopped;
also copy `mbox-imports` if you need import-job recovery. Mail already committed
does not depend on that directory. Restore database and snapshots together for
job recovery. Permissions and flush guarantees remain subject to OS/filesystem.

## Resource limits and validation

- At most 20 files / 100 GiB per job; 64 KiB streaming reads, one message and one
  parser worker at a time. Memory scales with bounded message size, not archive
  size. No full-file `readFile`, readline buffer or full-job transaction is used.
- 32 MiB de-framed MIME per message; 256 KiB per line/header block. Oversized
  messages are discarded from memory until a confirmed next boundary and counted
  as failures. Oversized lines/headers stop because framing is no longer safe.
- 256 attachments / 32 MiB combined decoded attachment bytes; worker parsing has
  a 20-second deadline and 256 MiB V8 old-generation limit. Buffers/native memory
  are additionally bounded by the 32 MiB MIME input, but this is not a 256 MiB
  whole-process RSS guarantee. Individual attachment preview/download limits can
  be lower, as in other Local Folders mail.
- Each run pauses at a committed boundary after 512 MiB input or 10 minutes.
  Snapshot copying/verifying also stops after 10 minutes and restarts that phase
  on Continue. If that full pass cannot finish, split the export into smaller
  mailbox files. There is no infinite background retry or automatic resumption.
- Reads yield between chunks, parsing runs off the main thread and transactions
  never cross awaits. SQLite, checksums, JSON serialization and one commit's
  fsync remain synchronous; no native responsiveness guarantee is claimed.

Synthetic checks: `node scripts/check-mbox-import.js`,
`node scripts/check-mbox-import-ui.js`, `node scripts/check-mbox-import-host.js`.
`npm run check` registers those checks for Linux/Windows CI. The browser check
uses only synthetic fixtures and a loopback server. No real user mail,
credentials, provider connection or AI calls are used. Native Windows/macOS
dialogs, live Thunderbird behavior, screen readers and real power loss remain
unverified. See `docs/testing/mbox-import/README.md` for recorded evidence.

Format references: [Thunderbird folder storage](https://source-docs.thunderbird.net/en/latest/backend/folder_storage.html),
[Thunderbird mbox parser](https://searchfox.org/comm-central/source/mailnews/base/src/MboxMsgInputStream.cpp),
[Thunderbird message flags](https://searchfox.org/comm-central/source/mailnews/base/public/nsMsgMessageFlags.idl),
[RFC 4155](https://www.rfc-editor.org/rfc/rfc4155.html). The accepted envelope and
escaping rules above deliberately define a narrower, testable import contract.
