# Gmail reply and forward evidence

Gmail REST labels expose neither IMAP Answered nor Forwarded. Gmail migration
continues to clear legacy provider flags; IMAP handling stays authoritative.

For Gmail only, confirmed complete submission records account + Gmail generation +
original provider message ID and disposition. The proof is captured before send,
kept with local drafts and queued snapshots, and committed at the common transport
acceptance callback after every intended recipient is confirmed accepted. Scheduled
receipt and disposition writes commit in one transaction. Opening compose, queuing, cancellation, refusal, partial and
uncertain outcomes do not create local evidence. Unbound legacy sources stay unknown.

Confirmed local Reply and Reply All also work when the original RFC Message-ID is
absent. Capture requires the exact source row, account, current Gmail generation
and matching provider/local-UID mapping. A supplied In-Reply-To must still agree
with the original; absent and empty parent fields are equivalent only when that
original header is absent. No synthetic RFC identifier is invented. Draft and
scheduled proofs retain the same account-generation check at acceptance.

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
No full mailbox scan, OAuth scope, subject-based forwarding inference or IMAP change
is introduced. Cross-device forwarded state remains unavailable.

Gmail reaction MIME (`text/vnd.google.email-reaction+json`), including nested
parts, is excluded even when plain/HTML alternatives and In-Reply-To exist.
Legacy Sent rows without this MIME inspection proof stay ineligible until checked.
See [Google's reaction examples](https://developers.google.com/workspace/gmail/reactions/examples).

## Legacy Sent repair (2026-11-05)

Incremental Gmail history does not revisit unchanged pre-feature caches, and
opening an already-complete body can return locally. Ordinary Sent sync therefore
rechecks at most two cached, provider-bound Sent rows with an In-Reply-To and no
inspection marker per pass. These full MIME reads count toward the existing
twenty-read limit, pacing, deadline and foreground-open yield. There is no broad
provider mailbox listing, attachment-content download or separate startup network
job for repair. Existing exact RFC identity lookups still protect adoption of
unbound label copies. Already-downloaded mail is eligible even outside a shorter
download horizon.

The existing persisted MIME eligibility field is the durable work checkpoint:
adoption commits inspection, refreshed headers and inferred flags atomically.
Success removes the row from the uninspected queue, including inspected reactions
and malformed MIME that remain ineligible. No second cursor can acknowledge an
uncommitted result. Network and quota failures leave the failed row uninspected
and follow the normal sync retry/pause policy. Restart resumes the remaining
indexed queue. Missing provider messages use existing local-copy reconciliation;
responses for a different provider ID and obsolete account generations are
rejected. Pending local edits and held removals are retained.

Repair applies the same unique-original attribution and MIME exclusion rules as
new sync. It never marks other members of a thread, infers from References alone,
creates cross-device forward evidence or changes provider labels. IMAP remains
provider-authoritative. Tests use synthetic providers, temporary stores, mocked
submission and the actual renderer; live Gmail and native windows remain outside
this validation.
