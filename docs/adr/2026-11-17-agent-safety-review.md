# Advisory Agent safety review

## Decision

Agent → Todos supplements the configured Brain categories with a collapsed **Safety review** of the currently shown recent cached todo snapshot. It groups a mailbox's threads by their strongest signal: **Needs attention**, **Ordinary mail**, or **Possible cleanup**. It does not reorder, move, mark read, flag, notify, or complete any message. Existing Agent actions and consent do not change.

This deliberately small first step uses subject cues and the existing Needs You / Upcoming Today categories. Mismatched or indistinguishable inputs remain advisory; matching is not sender authentication. It cannot catch every device alert, security message, deadline, or reply and does not certify that an unlisted message is safe. Attachments are neither read nor opened; their presence alone keeps a potential cleanup message in Ordinary. Risk cues outrank promotion cues. Thread grouping uses account and thread IDs when available; alike-looking messages in other accounts are separate.

### Scope preview

Choose one mailbox and enter the **exact displayed sender and subject** in the preview. It only matches displayed cached todos from that mailbox; an out-of-date snapshot must be refreshed first. The comparison is literal and case-sensitive apart from trimming outer whitespace; there are no patterns or domain-wide rules. A matching row, including one whose known thread has an ordinary or attention row, may be held. Matching rows show dates when available. Counts are for cached messages, not whole-mailbox coverage. New cache results or edited inputs retire the previous preview. This panel reads no bodies, requests no additional mail or network access, and never approves, saves or executes a rule.

## Required before standing actions

Design durable, separate explicit approval with one account incarnation, verified source identity and known provider path, authenticated evidence, exact permitted actions, proof of any required conditions and an expiry. Missing, changed or conflicting conditions (e.g. amount, device or credential signal) hold the mail for review; do not infer from a display sender, promotional words, snippet, model output, silence, or past dismissals. Preview scope, set once versus standing explicitly, preserve unread/inbox for alerts by default, show activity, revoke safely, exclude retroactive mail and cancel pending work upon revocation. Reviews, Learned items and notes must not implicitly grant mailbox rules. No guessed approval by another agent. Autodelete and autosend are out of scope. A user-authored draft remains inert until they send.
