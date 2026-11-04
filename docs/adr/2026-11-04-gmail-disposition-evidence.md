# Gmail reply and forward evidence

Gmail REST labels expose neither IMAP Answered nor Forwarded. Gmail migration
continues to clear legacy provider flags; IMAP handling stays authoritative.

For Gmail only, confirmed complete submission records account + Gmail generation +
original provider message ID and disposition. The proof is captured before send,
kept with local drafts and queued snapshots, and committed at the common transport
acceptance callback after every intended recipient is confirmed accepted. Scheduled
receipt and disposition writes commit in one transaction. Opening compose, queuing, cancellation, refusal, partial and
uncertain outcomes do not create local evidence. Unbound legacy sources stay unknown.

A separate account-scoped evidence table survives label-copy removal and ordinary
sync. Provider booleans take priority over local evidence. Local evidence never
writes Gmail labels or requests permissions. Account removal deletes the evidence;
there is no cross-device propagation.

Historical reply inference uses only already-synced Sent folder rows with a stable
Gmail identity and one exact In-Reply-To matching a single original Gmail provider
identity by RFC Message-ID within that account. Label copies count as one identity;
duplicate deliveries, drafts, subjects, References and thread membership do not
prove a reply. Inference works in either sync order and runs over bounded local
Sent-candidate batches at startup, yielding between committed batches. Inferred evidence is kept
when Sent cache rows disappear, but is suppressed if the original becomes ambiguous.
No mailbox download, OAuth scope, subject-based forwarding inference or IMAP change
is introduced. Cross-device forwarded state remains unavailable.

Gmail reaction MIME (`text/vnd.google.email-reaction+json`), including nested
parts, is excluded even when plain/HTML alternatives and In-Reply-To exist.
Legacy Sent rows without this MIME inspection proof stay ineligible until normal
provider refresh; no extra fetch is scheduled. See [Google's reaction examples](https://developers.google.com/workspace/gmail/reactions/examples).
