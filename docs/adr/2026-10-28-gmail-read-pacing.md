# Gmail read pacing and quota pauses

Status: implemented in this draft. Checked against the Gmail API usage limits on 2026-10-28.

Google documents two Gmail API ceilings: 1,200,000 quota units per minute per project, and 6,000 units per minute per user per project. `messages.get` costs 20 units, or 60 when the format is full, raw, or html. `messages.list` costs 5. `history.list` costs 2. Sending costs 100 and is not part of this change.

A Morrow folder pass used to request up to 100 full message reads with no gap. That is 6,000 units, the entire per-user minute, before the next folder or a body download. The old pause then waited 30 seconds twice and, on the third hit, always waited 15 minutes even when Google asked for less. A single blip was already 30 seconds or `Retry-After`. The 15 minute step made a short burst recover more slowly than the per-minute quota requires.

Gmail API GETs for one local mailbox are now spaced to 4,500 units per minute, leaving headroom under the 6,000-unit user ceiling. The first read in a quiet window does not wait. A full read then waits 800ms. Metadata reads wait less because they cost 20 units. POST, PUT, and DELETE are not delayed and are not retried. Gmail list and history passes fetch at most 20 messages so one folder stays near the existing 25 second background tick. IMAP page delay, batch size, and the 5s/15s/45s transient sync schedule are unchanged.

Quota pauses still honor `Retry-After`, capped at 15 minutes. The first two pauses stay 30 seconds when Google does not send a wait. From the third pause the wait is `30s × 2^(n-1)`, and at least any longer `Retry-After`, and never more than 15 minutes. A mailbox UID reset still uses the flat 15 minute pause. Permission and sign-in errors are not quota pauses. Visible body prefetch does not start while that mailbox is already paused. Opening a message still tries once.

Not in this change: one budget shared by several Morrow accounts or machines for the same Google user; pacing the legacy sidecar search helper; a live remaining-quota meter; automatic write or send retries. `MORROW_GMAIL_PACE=0` skips the wait in fixtures only.
