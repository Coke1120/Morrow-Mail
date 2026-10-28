# Compose closes into Outbox

Issue: https://github.com/Coke1120/Morrow-Mail/issues/363

This supersedes the undo-in-compose-window paragraph of [Compose opens in its own window](2026-10-21-compose-window.md). Partial delivery receipts stay as decided in [Draft correlation and partial delivery](2026-10-24-draft-correlation-and-partial-delivery.md).

## Decision

Send with an undo delay closes the compose window as soon as the send is queued. The message waits in a local **Outbox** under **All Account Mail** until that delay ends or the user undoes it. Outbox lists every mailbox. It is not an IMAP, Gmail, or Graph folder.

The wait is the existing `scheduled_sends` row with `payload.outbox === true` and `send_at` set to now plus the undo delay. There is no second queue. An exact wake calls the same `pumpScheduled` path that already delivers scheduled mail, so the in-app delay stays about 30 seconds. The 15 second pump and the next launch are the backstop if the wake does not run. The setting stays 0–30 seconds, default 30. Zero still calls `mail:send` immediately and skips Outbox.

Undo in Outbox calls `mail:cancelScheduled` and reopens the same draft. It does not use the scheduled-send double confirm or the 8 second restore. Opening a waiting row shows a plain-text preview and does not send it. When the delay elapses, delivery is the same `deliver()` path as Send today, and the row leaves Outbox.

Quit uses the existing scheduled-send confirm. The dialog still says “scheduled” because that copy already covers every pending `scheduled_sends` row. Stay open keeps the wait. Quit anyway leaves the row; the next launch sends it and it can no longer be undone. A row already claimed for SMTP is not an Outbox undo: it stays the uncertain scheduled record and is not replayed automatically.

A partial SMTP result is not an Outbox close. The row leaves Outbox, stays in Scheduled delivery review, and the shell reopens the read-only receipt. A send that fails before acceptance deletes the Outbox row and reopens the draft with the existing “check Sent” warning, so Scheduled review does not keep a second copy.

## Why the same queue

The compose window and the mail shell do not share renderer state. A timer inside the compose window is canceled when that window closes. The scheduled queue is already durable, already blocks quit, and already sends through `deliver()`.
