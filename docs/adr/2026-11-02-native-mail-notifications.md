# Native new-mail notifications

Use Electron's main-process `Notification` with the existing Windows
`com.coke1120.morrow-mail` AppUserModelID (the electron-builder appId). NSIS's
existing Start menu shortcut receives that same identity. No custom toast XML,
web Notifications, permission bypass, background service, startup setting or bot
permission is added. macOS uses the existing signed app bundle. Actual installed
Windows/macOS delivery and portable Windows behavior remain unverified.

Settings → Mail & Sync saves `mailNotificationsEnabled` (default true) and
`mailNotificationPreview` (`hidden`, `sender`, `message`; default hidden) in
`settings.json`. Hidden notifications disclose no account, sender or subject.
Single-message previews are opt-in, plain, control/bidi-filtered and byte-bounded;
grouped notices always hide mail content. OS permission, Focus/DND, sound settings
and delivery remain authoritative. `isSupported` does not prove permission, and
Morrow does not claim to detect all OS suppression. A native `failed` event is
reported in Settings, without provider/native error contents.
Notification lookup and click validation use the existing body-free metadata
projection; no message body is copied into the notification controller.

## Admission and recovery

Reuse existing sync, including IMAP IDLE and background/manual polling. Only
committed unread Inbox arrivals qualify. IMAP emits after warm incremental UID
sync and local rules, never bootstrap/history/horizon backfill or UIDVALIDITY
reset. Known same-account messages moved from another folder stay quiet; an All
Mail copy can precede the Inbox copy for one genuine Gmail IMAP delivery. Gmail
uses `messagesAdded` history records (not label, flag, verification or bootstrap
records), verifies current Inbox membership, and ignores already adopted provider
identities. Pending history pages persist their arrival IDs with their existing
resume cursor. No new provider request or scope is needed.

Provider receive time (IMAP INTERNALDATE or Gmail internalDate) must be after
process start or the last account/settings invalidation, and within five minutes
of now. The sender's Date header never gates eligibility: a genuinely new server
delivery can notify even with an old, missing or future sender Date. Display-date
fallbacks are not used as arrival evidence. Gmail cache admission also uses its
provider receipt timestamp for the download horizon, so a fresh delayed delivery
is not discarded by a 180/365-day setting. This suppresses offline backlog,
historical imports preserving arrival time, and flag-only changes. Conservative
misses include long sync queues and slow first sync. Neither IMAP nor Gmail
history can prove that a newly added message with a fresh provider receive time
was not an import resetting that timestamp. Such imports can notify; dropping a
genuine delayed delivery based on its sender Date would be incorrect. We do not
promise perfect import provenance detection from these protocols.

`mail_notification_state` in the existing durable mail store holds at most 2,000
SHA-256 identity/timestamp pairs per account (Gmail provider ID or IMAP
folder/UIDVALIDITY/UID), plus an eviction time floor. It holds no preview or body.
Reservations commit **before** native show, so failures, OS suppression, process
exit between commit/show and uncertain delivery do not replay. This is at most
one attempt, not guaranteed delivery. Eviction advances a timestamp floor rather
than allowing old identities to flood again. Account removal deletes this state.
Persistence failure halts this controller until restart and Settings explains it.

Accumulate for two seconds, then submit at most one notification per 15 seconds
across all mailboxes. Keep at most 200 pending messages; excess arrivals are
reserved and stay silent. Keep at most eight native objects for Action Center
clicks, closing older ones. A burst links to its newest eligible message. Recheck
unread Inbox membership before showing; settings/account changes discard pending
work and close retained notices. Tightening privacy cannot erase copies already
delivered to system history or another display.

## Click handling and runtime

The callback captures host-owned account/connection and local message identities.
Revalidate account incarnation, connection invalidation version and message
ownership before focusing the shell, then validate again when the shell takes the
pending target. Gmail may resolve a retired label copy by its same-account
provider ID. A moved cached message opens in its current folder; missing/trashed
messages fall back to Inbox, and removed accounts are ignored. No notification
text, URL, HTML or renderer payload becomes navigation or code. Only the normal
message open path runs after the user clicks, including its usual read-on-open
behavior. Queued clicks survive an asynchronously recreated shell through the
host pull; the renderer waits until its initial account load has finished.

The app must be running, awake and syncing. Windows main-window close quits;
macOS hide/close keeps the existing process running, while Quit stops delivery.
The feature does not launch a closed app, change OS permission, wake a computer or
create a persistent background process.

## Verification

`npm run check` includes `check-mail-notifications.js`,
`check-mail-notifications-sync.js` and `check-mail-notifications-ui.js`:
mock native notices/timers, production Gmail and IMAP sync with synthetic
transports, production database close/reopen/removal, and actual preload through
Settings validation/persistence. Coverage includes bootstrap/history suppression,
arrival/restart/reconnect dedup, fresh deliveries with old/missing sender Date,
batching/rate limits, disabled/unsupported/failed
and suppressed delivery, storage failure, bounded retention, privacy and clicks.

Optional Chromium smoke: `node scripts/check-mail-notifications-browser.js` with
`MORROW_AXE_MODULE` pointing to axe-core/axe.min.js, `MORROW_PLAYWRIGHT_MODULE` if
needed, `MORROW_CHROMIUM` for Chromium and `MORROW_UI_OUTPUT` for screenshots.
It checks real Settings keyboard controls/reload persistence, narrow layout,
OS failure text, account-B message navigation and rendered Features with WCAG
A/AA checks. Fixtures use synthetic mail and never emit real system notifications.
Native notification permission prompts, sound, delivery and activation must still
be tested on installed Windows/macOS builds before claiming platform validation.

Implementation reference: Electron's [main-process notification API](https://www.electronjs.org/docs/latest/api/notification)
and [platform considerations](https://www.electronjs.org/docs/latest/tutorial/notifications).
