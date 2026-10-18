# Current-page synchronization and incremental follow-up

The 0.7.3 first batch remains bounded. Native clients publish the selected
message first, then the current page, as at most 51 account/local-ID pairs. The
service resolves those local identities, binds each to its current connection,
and expires hints after 90 seconds. New generations replace older ones; stale or
out-of-order requests cannot revive expired hints. Hints contain no bodies or
credentials and do not change durable mail state or import checkpoints.

Manual sync publishes the hint before syncing. Existing native refresh loops
refresh it while browsing. Background sync uses the same priority phase. Gmail
and IMAP still receive their existing 50-row older-cache quota; Outlook still
receives its 25-row quota and per-folder delta work. Priority rows do not consume
or advance these background cursors. Leaving mail clears the hint; service
restart forgets it. Sync intervals remain user-controlled and require the app
to be running. This does not create a push subscription or promise immediate
server notifications.

IMAP checks the selected message plus a full 50-row page as two batches of at
most 50 messages under the existing overall 45-second read deadline. A failure
in either batch returns no partial priority result. Ordinary reconciliation
retains its 50-message limit.

Read/unread writes remain explicit, owner-bound and provider-confirmed. A failed
write does not become an automatic retry. The native page, cursor and selected
message are not changed by hint publication. Account-specific and combined views
deduplicate by account plus local ID, preserving collisions between mailboxes.

## Immutable body reuse

Recent IMAP/Graph pages still fetch current metadata and flags. Cache lookup is
bounded to the actual page's at most 50 remote identities. It requires the same
account and connection version, complete content, and a non-draft/non-deleted
message. Legacy bodies without a server-written connection marker fetch once.

IMAP additionally requires the same provider folder, UIDVALIDITY and UID, current
non-draft flags, matching nonempty Message-ID and RFC822.SIZE. Current headers
must end with the complete header separator below the 64 KiB partial-header
limit before reuse; otherwise the normal body fetch supplies all metadata.
Only cached body fields are copied, preserving current internal/sender dates
and flags. Unknown identity, changed size/epoch/connection,
incomplete content and mutable drafts use the normal body path. The existing
large-message placeholder and import bounds remain.

Graph requires a matching nonempty internetMessageId and both current and
cached non-draft metadata. A provider draft becoming Sent fetches its final
body before recent-page reuse and adopts the provider folder when no explicit
local folder override exists. Drafts fetch their body on every page. Connection
changes, missing identity/markers and incomplete content also fetch normally.
Downloaded attachment bytes survive a bounded large-body placeholder for the
same immutable identity. Local `sent:` records retain the reviewed body,
footer, recipients, attachments and delivery fingerprint; provider metadata
does not give that local representation a fresh server-body marker. Existing
Gmail minimal metadata/body reuse and attachment quarantine remain unchanged.

## Isolated verification

Linux Cloud Rust 1.98.0 locked formatting, strict all-target Clippy and all
304 tests passed on 11 October 2026. Exact committed heads and subsequent native
results are recorded in [VERIFICATION.md](../VERIFICATION.md). Reviewed head
`43d443fc25f74ceae099156e20f64908f0706f84` passed focused
[38121254196](https://github.com/Coke1120/Morrow-Mail/actions/runs/38121254196)
and paired [38121493085](https://github.com/Coke1120/Morrow-Mail/actions/runs/38121493085),
both attempt 1. Their tree `2d4d8b1b71f274e174b0c4ff0838ee5226cd93d7`
matches merged PR29 main `b833ba0b9d2c958552dd272404708654a612ea55`.

Rust fixtures cover the 50/25 background boundaries, selected older messages
outside the import date window, both read directions, duplicate owner IDs,
background fairness, monotonic/expired hints and connection replacement. They
count actual IMAP BODY and Graph body HTTP requests across repeated pages and
exercise draft, incomplete, changed identity/size, folder and epoch cases.
Additional boundary controls cover a retained reader plus 50 rows, second-batch
failure, truncated headers, same-ID draft-to-Sent transitions with and without
priority, and oversized-body fallback after an actual attachment download.
An owned synthetic send replay retains its reviewed fingerprint and attachment
bytes across two syncs, returns confirmed without a provider send, and rejects
cross-owner attachment reads.
Cancellation/reconnect during a held Graph priority response cannot commit flags
or checkpoints. Gmail/Graph quota responses preserve checkpoints and persisted
backoff. Provider fixture networking is restricted to loopback with generated,
explicitly trusted certificates; no live mailbox is involved.

Native fixtures passed selected-first/current-page payload bounds and owner
identity while retaining search page/selection on that exact candidate.
PR29 merged after explicit owner authorization. Postmerge main
[38128187209](https://github.com/Coke1120/Morrow-Mail/actions/runs/38128187209),
attempt 1, passed Mac but failed Windows strict observation at one case-3
nativeWait/no-error/unknown-exit record; relocation/publication were skipped.
Candidate success is not main acceptance, and no new release was published.
Physical VoiceOver/Narrator, manual cross-platform interaction, real accounts,
and live latency/load acceptance remain unverified.

## 0.7.4 incremental follow-up

The [performance report](SYNC_PERFORMANCE.md) records the implemented follow-up
and isolated before/after measurements. Gmail history and IMAP UID/MODSEQ tracking
now use atomic, owner/connection-bound checkpoints. Gmail still refreshes mutable
drafts and rotates through 50 cached rows. IMAP still rotates through 50 cached
rows, while its 51-row priority check shares one connection across both chunks.
QRESYNC handles bounded known-UID VANISHED responses; unfiltered complete UID
existence reads support CONDSTORE without QRESYNC. Partial or changed-only
omissions never imply deletion. Unsupported/rejected/NOMODSEQ servers retain
bounded flag polling. Graph still resolves all delta records and keeps its
25-row rotation; only already-observed rolling IDs are skipped.

User-selected polling intervals remain unchanged. Gmail push subscriptions,
IMAP IDLE, global full-mailbox QRESYNC and a long-lived pooled connection are
future work. The implemented connection reuse is limited to one bounded
priority operation. No notification architecture, real-account latency or
physical UI acceptance is claimed.
