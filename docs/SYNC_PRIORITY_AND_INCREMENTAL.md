# Current-page synchronization and incremental follow-up

This is an unreleased, bounded first batch. Native clients publish the selected
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
are parsed for metadata; only cached body fields are copied, preserving current
internal/sender dates and flags. Unknown identity, changed size/epoch/connection,
incomplete content and mutable drafts use the normal body path. The existing
large-message placeholder and import bounds remain.

Graph requires a matching nonempty internetMessageId and current non-draft
metadata. Drafts fetch their body on every page. Connection changes, missing
identity/markers and incomplete content also fetch normally. Existing Gmail
minimal metadata and immutable body reuse remain unchanged. Explicit attachment
downloads, downloaded-content preservation and file quarantine are unchanged.

## Isolated verification

Linux Cloud Rust 1.98.0 locked formatting, strict all-target Clippy and all
300 tests passed on 11 October 2026. Exact committed heads and subsequent native
results are recorded on the independent draft PR.

Rust fixtures cover the 50/25 background boundaries, selected older messages
outside the import date window, both read directions, duplicate owner IDs,
background fairness, monotonic/expired hints and connection replacement. They
count actual IMAP BODY and Graph body HTTP requests across repeated pages and
exercise draft, incomplete, changed identity/size, folder and epoch cases.
Cancellation/reconnect during a held Graph priority response cannot commit flags
or checkpoints. Gmail/Graph quota responses preserve checkpoints and persisted
backoff. Provider fixture networking is restricted to loopback with generated,
explicitly trusted certificates; no live mailbox is involved.

Native fixtures check selected-first/current-page payload bounds and owner
identity while retaining search page/selection. Full native CI results belong
to the exact draft PR candidate; these statements do not predeclare a pass.
Physical VoiceOver/Narrator, manual cross-platform interaction, real accounts,
and live latency/load acceptance remain unverified.

## Subsequent incremental stages — design only

1. **Gmail history:** persist an owner/connection-bound history cursor only after
   every bounded response page's owned changes commit. Coalesce message IDs and
   reuse existing metadata/body rules. An expired history cursor requires a
   bounded recovery import with a visible incomplete state; it must not erase
   cached mail or silently declare a full mirror. Cancellation/quota/reconnect
   retain the last committed cursor. See Google's [synchronization guide](https://developers.google.com/workspace/gmail/api/guides/sync).
2. **Graph:** extend the existing per-folder delta worker incrementally. Preserve
   opaque next/delta URLs, folder identity, deletion markers and atomic data/
   checkpoint commits. Budget active folders first while retaining fairness for
   other folders. Test multi-page catch-up, folder loss and connection changes
   before changing any polling interval. Microsoft documents [per-folder message delta](https://learn.microsoft.com/en-us/graph/delta-query-messages).
3. **IMAP differences/IDLE:** first establish a connection/UIDVALIDITY-bound
   difference cursor and a bounded UID/FLAGS fallback. Capability-dependent
   extensions require their own identity/deletion fixtures. Only then add one
   supervised IDLE session for the active owner: treat its events as wake-ups,
   coalesce them into the existing gated sync, exit IDLE before commands, and
   bound cancellation/reconnect/cleanup. Unsupported servers retain bounded
   polling. No background session may turn an unobserved event gap into deletion
   or normal-exit proof. The protocol basis is [RFC 2177](https://www.rfc-editor.org/info/rfc2177/).

Each stage needs synthetic failure/cancellation, request-count and owner tests,
then native CI and separately approved live-account acceptance. It must preserve
existing user-selected intervals, write confirmation and failure checkpoints.
No provider notification architecture or extra system tracing is implemented in
this first batch.
