# Verified cross-mailbox Copy, before Move

Copy is a distinct first-party reviewed operation. It does not use SMTP,
Gmail draft upload, Graph within-mailbox copy or source deletion. Existing Local
Folders Copy/Move keeps its existing independent implementation. Remote Move
remains unavailable until destination verification and recoverable source Trash
receive their own implementation and tests.

The host captures both accounts, credential revisions, client binding, exact
source identity and destination folder metadata. Accounts are locked once in
sorted order. A review ticket expires after two minutes; each exact source can
be attempted once in that review. Limits are 50 messages, 32 MiB per original
and 256 MiB per review. No conversation expands implicitly.

Before upload, complete original bytes and source date/read/star state must be
proved. IMAP uses full RFC822.SIZE and UID-checked PEEK download, never a bounded
preview. Destination APPEND requires UIDPLUS/rev2, persistent matching
UIDVALIDITY, a writable selectable destination and APPENDUID. Its complete raw
readback, internal date and read/star state must match before success. Provider
normalization that cannot pass these checks yields an uncertain result, not
partial-message success.

Gmail uses the official [messages.import API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/import),
covered by the existing gmail.modify grant. It never invokes Send. Calendar
processing is off; standard classification is retained. Gmail sorts by the
original valid Date header, so provider receiving time may differ. Readback must
preserve every original header and the entire MIME body; only added recognized
transport/authentication trace headers are tolerated. The source raw MIME is
also checked against all full API MIME parts and attachments. Gmail may add
system labels or group mail into threads. The alternative
[insert endpoint](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/insert)
bypasses much of scanning/classification and is deliberately not used.

The separate SQLite journal contains bounded metadata and hashes, not message
bodies or credentials. It commits uncertainty before the provider write. A lost
acknowledgement without a confirmed provider identity blocks another upload.
Acknowledged copies may be freshly read back under matching proofs; verified
receipts are reused only after that check. Recovery never repeats uploads. The
receipt limit blocks new copies rather than discarding idempotency protection.

Cancellation can stop unstarted work and remaining sources. It cannot recall an
upload already submitted. Source messages stay in place on success, failure,
uncertainty and restart. No permanent-delete or EXPUNGE fallback exists.

Protocol references: [IMAP4rev2 APPEND](https://www.rfc-editor.org/rfc/rfc9051.html#section-6.3.12)
and [UIDPLUS APPENDUID](https://www.rfc-editor.org/rfc/rfc4315.html#section-3).
Provider/native certification is separate from synthetic fixtures; unsupported
or unprovable destinations remain disabled. This phase exposes no bot/CLI API.
