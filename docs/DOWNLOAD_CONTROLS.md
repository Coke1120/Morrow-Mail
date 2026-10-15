# Download controls and local recovery

The current-source follow-up adds **Downloads & storage…** to both native mail
views and each account in **Settings → Mail accounts**. Opening it reads the
local store. It does not sync, call a model or repair a message automatically.
Choose a connected mailbox; combined views never supply a mutation owner.

The coverage numbers describe all stored local folders for that mailbox, including
drafts and retained copies whose provider original disappeared. **Stored** counts
message records; **indexed** counts their keyword-index entries. Missing-body and
explicit incomplete-content records are counted separately from shortened bodies.
The dates are the first/last indexed dates, not proof of gap-free history or a
complete provider mirror. Counts rely on persisted content markers and cannot
prove that an unmarked legacy body was complete. Search still applies its own
folder/account filters and does not search attachment bytes.

**Message records** measures the UTF-8 bytes of stored message JSON, including
bodies and metadata. **Attachment data** measures the separately stored byte blobs
for that account, including attachments retained for drafts and unreferenced
copies. These figures exclude search indexes, settings, SQLite overhead/free
pages, backups and files saved elsewhere. They are not physical workspace size
or estimates of recoverable disk space. The byte totals are computed on explicit
panel refresh; ordinary search coverage does not scan attachment data or compute
message byte totals. A partial account/date/ID index bounds the incomplete-content
list and avoids sorting the full mailbox. Its first creation can add startup work.

The **Content to review** list returns at most 30 provider records per page, in
date/ID order. **Download full content…** reviews the owning mailbox and one
message, then reuses the existing raw-message/attachment download route. A
successful download refreshes the coverage; oversized messages can remain
shortened. The existing 80 MiB raw-message, 50 MiB decoded-attachment and
100-attachment limits still apply. Failure retains the cached copy and does not
retry automatically. Unavailable provider messages/folders cannot be repaired
through this list. Unverified or foreign IMAP origins require the original
server or a fresh sync/import of the current server, using its new message
identity; the panel must never rebind an old UID to a new server.

Missing, unbound, foreign or invalid IMAP origins disable the download action;
a verified copy from the current server remains eligible after a password-only
reconnect. A message whose full download was already saved but whose body remains
shortened by size limits stays visible with an explanation and no redundant
download action. Read its full body in the original mailbox.

The panel captures the selected owner, view/page request and an opaque connection
reference supplied by the service. It rejects mismatching snapshot/page responses
and invalidates stale state when an updated mailbox connection is observed. Each explicit repair
also checks that reference on the service before provider I/O, under the existing
mailbox gate; the existing full-connection check still protects the final save.
History controls additionally bind to the captured import job, so an older panel
cannot pause/resume a replacement import. These references contain no raw
connection settings, credentials or provider tokens. Existing callers without
Downloads references keep their prior API behavior. No action retries itself.
While the macOS panel is open, mailbox shortcuts and new compose/Settings sheets
are blocked; its own reviewed controls remain available. A delayed Windows panel
request cannot clear the loading state of a newer page after navigation.

**Pause history import** and **Resume from checkpoint** reuse the existing
per-account history controls. **Choose history range…** opens the reviewed import
settings. Changing to a shorter range does not delete cached mail. **Automatic
sync settings…** opens the existing global interval preference. Pausing history
stops later history pages, not a request already in flight or recent-mail sync;
setting recent-mail sync to Manual does not pause history. These are download
controls, not a global offline mode: provider catalog maintenance, explicit
sync/read-state changes and other online actions can still connect.

## Local versus provider moves

**Archive locally** and **Move to Local Trash** only change the local view.
After a new local folder change, open the message in its new local folder and
choose **Undo local move to …** to restore its previous local folder, including
a local draft's Drafts folder. This single last-move receipt survives an app
restart and has no time limit while its message location and saved connection
still match. It is not a history of all moves or a provider operation.

The service creates the receipt; a client cannot supply its original folder.
A later local move replaces its token, preventing an old action from undoing a
move-away/move-back sequence. Provider organization or reimport clears it, and
changed provider identity/location or a new connection invalidates it. Read,
star, Pending and content updates are independent: undo preserves their current
values, including automatic mark-read-on-open. If the receipt is unavailable or
stale, inspect the current locations and choose an explicit local action.

**Move to provider Trash** and **Organize email / Move / Labels** retain their
existing permission, review, owner and server-destination checks. Provider Trash
has a different, single-use **one-minute Undo** kept only for the running app.
After its expiry or app restart, review a provider move to the intended folder or
restore through the original mailbox. If a provider write is uncertain, inspect
the provider's current state before another reviewed attempt; no automatic write
replay was added.

## Scope and remaining decisions

Existing behavior retained: history ranges/selected scope, persisted pause/resume,
single-message MIME repair, explicit attachment loading, reviewed provider moves,
and the one-minute provider Trash undo.

New behavior: account-owned coverage/storage snapshots, bounded repair discovery
and native entry points, precise local/provider action labels, and one safe
persistent local-folder undo.

No cache eviction, automatic mail/attachment deletion, hard storage quota, bulk
repair, complete offline mirror, per-account network-off switch or global offline
mode is introduced. Reclaiming attachment bytes requires a separate reviewed
policy for shared draft/message references and uncertain/scheduled send records;
physical disk reclamation also requires explicit SQLite maintenance decisions.
Those decisions remain open. Synthetic tests and native CI do not establish
live-account, large-mailbox latency or manual accessibility acceptance.
