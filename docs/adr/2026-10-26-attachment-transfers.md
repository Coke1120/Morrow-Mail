# Share bounded attachment transfers across user actions

Status: implemented for draft review; independent functional review pending.

Preview, Open and Save currently fetch the same remote attachment again, and Save
downloads before presenting its dialog. A dismissed preview leaves the transfer
running behind the renderer's global busy flag. Source-based synthetic diagnosis
confirmed these behaviors in v0.2.38 and the v0.2.39 candidate; no real-user speed
measurement was made. Gmail API migration alone does not provide attachment caching.

Use an account- and message-identity-bound, bounded process-memory cache and shared
in-flight transfer. Retain complete results only, expire/evict them, and invalidate
transfers when an account is removed, reconnected or migrated. Validate current
message/attachment identity before returning bytes, including cache hits. Failure or
cancellation must never cache partial bytes. A consumer's cancellation detaches only
that consumer; stop provider work when no consumers remain.

Present Save before fetching, expose request-scoped progress/cancellation, and keep
unrelated UI actions usable. Preserve current Gmail attachment identity recovery,
IMAP UIDVALIDITY checks, local draft files, and ZIP selection behavior. Do not expand
bot access to attachment bytes. Keep connection pooling, body-sync redesign and PDF
worker changes separate. Tune IMAP chunks only with bounded synthetic evidence.

The draft PR must record completed implementation, real test results and remaining
native/live boundaries. No release, live mailbox, OAuth grant or Console action is
part of this change.

Limits: 64 MiB total retained bytes, 32 MiB per retained file, 64 entries, five-minute
TTL, two active batches and 16 pending files. Incoming transfer and ZIP budgets are
64 MiB/file and 128 MiB combined; Gmail keeps its existing response bounds and
outgoing files keep their existing limit. No partial bytes enter the cache. Each
large ZIP is read in bounded eight-file batches rather than limiting its selection
to the in-flight file count. Each
consumer receives its own copy. Keys include the account incarnation/transport and
full local message/attachment snapshot. Current identities and pending actions are
checked on warm hits as well as provider reads. Reconnect/removal/migration abort
consumers and release account cache entries; expiry and LRU eviction release bytes.

Request IDs and cancellation/progress are scoped to the originating webContents.
Window destruction aborts its consumers. The last consumer aborts the shared
provider work; one cancelled consumer never closes a read still needed by another.
IMAP closes the batch client on final cancellation and destroys the part stream;
Gmail receives AbortSignals for message and attachment reads. Background sync is
still serialized through the existing account lane. The patch does not tune IMAP
chunks, pool connections, redesign body filling or modify PDF workers.
