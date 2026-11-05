# Configurable automatic Brain profile refresh

Settings → Brain stores `brainRefreshCadence` in `settings.json`: `daily`
(the default for missing legacy preferences), `weekly`, or `manual`. Invalid
persisted values or damaged settings records fall back to manual; invalid writes are rejected. The setting
is global because the existing profile samples cached Sent/Inbox snippets across
connected mailboxes. It does not change skill schedules, Agent triage, mail sync,
AI destination, provider usage or data permission.

Both Brain-open refresh and the running app's hourly eligibility check use the
same elapsed-time policy: at least 24 hours or seven days after the later of the
last successful profile generation and last automatic attempt. There is no
wall-clock delivery promise or OS job. Missed slots combine into one eligible
attempt while the app runs. A missing profile is eligible on the next check or
Brain open, with the existing separate background permission.

One claimed job covers queued and running Refresh/Rebuild work. Repeated requests
join that job and report its actual mode. Cadence and saved-destination consent
are checked again after queueing, retaining the original consent stamp. The
actual AI request also uses the existing consent lease and ChatGPT account gate.
Choosing a cadence never grants permission. Revocation continues to cancel
queued and active requests; delivered data cannot be recalled.

`brain.json` records `refreshAttemptAt` atomically before automatic model work.
Failure, process exit or restart therefore waits the full selected interval;
explicit Refresh/Rebuild can retry immediately and successful generation resets
freshness. Persistence failure starts no AI request and retains the old profile.
Manual only prevents future automatic work, including work still queued; it
does not cancel an already processing run. Revoke AI data permission to cancel.
The existing version fence and re-read before saving preserve concurrent user
rules/categories and reject conflicting generated-profile edits.

Settings shows the cadence, permission state, last success and next eligibility.
It reads locally and never generates a profile merely by loading or saving.
Regression checks use production scheduling, persistence, consent, preload,
Settings and request code with synthetic stores, time and AI responses. Native
sleep/wake timing and live provider usage remain outside those checks.
