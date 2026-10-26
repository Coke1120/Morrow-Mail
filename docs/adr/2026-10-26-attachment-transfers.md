# Share bounded attachment transfers across user actions

Status: implementation in progress; draft review only.

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
