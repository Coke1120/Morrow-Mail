# Immutable MBOX snapshots and transactional local import progress

Issue #521 depends on the independent Local Folders store (#519 / PR #524).
Feature PRs target dev and remain drafts; no release or merge is implied.

An external mailbox may be compacted/replaced by Thunderbird. A saved offset
into that mutable path can skip or duplicate messages. Copy explicitly selected
files into private fsynced snapshots first, with before/after source identity
checks, and record their full SHA-256 only after atomic publication. Resume
verifies an entire owned snapshot before trusting its offset. This trades disk
space and an additional sequential verification pass for a stable recovery source.
Sources remain read-only; no profile scanning or live-profile writes are allowed.

Extend the version-1 local archive with an optional `mbox_import_jobs` table.
It uses the same native SQLite connection and transaction as complete message,
attachment and transfer-receipt writes. Progress and counters cannot acknowledge
mail whose transaction rolled back. On a failure, reload the durable job state,
not an incremented JavaScript object. Old Local Folders readers ignore the optional
table and preserve data. Snapshots are outside account/cache ownership. Backups
must include them if import recovery is needed; acknowledged mail is independent.

Use exact de-framed content identity scoped to the original destination. Keep
Message-ID as evidence, not uniqueness. Do not normalize line endings or remove
unknown trailing blank lines, which could alter binary or signed content. Retain
duplicates' original receipts even if the local copy moves. Distinct destinations
may own separate copies. This does not promise semantic deduplication across
rewritten exports. All framing/duplicate/status decisions are disclosed before
import and in Features/help.

Frame in bounded 64 KiB reads, cap lines/header blocks and message storage, and
confirm a following envelope's headers before acknowledging the previous entry.
MIME parsing reuses production handling in a disposable worker with deadline and
heap limits; one bounded message is committed at a time. Never await inside the
archive transaction. Known malformed/oversized entries are counted; ambiguous
framing stops without guessing. Keep failed raw input in snapshots until an
explicit separate removal review. Thread headers and original date/time zones
remain in raw MIME even where no parsed UI field exists.

Cancellation checks before copying, parsing and commit. Normal app shutdown asks
the service to cancel and await closure; updater quiescence tracks the full run.
Crashes are recovered through native SQLite journaling and interrupted job state.
Nothing resumes automatically. Budgets pause at durable boundaries. Local-only
ownership keeps imported mail outside provider sync, notifications, account
deletion, automated rules, Brain/AI, sending and bot enumeration.

No mboxcl/cl2, whole-profile/SBD recursion, Maildir, CLI/bot import or native
power-loss claims. Public limits and synthetic/native validation boundaries live
in `docs/MBOX_IMPORT.md`.
