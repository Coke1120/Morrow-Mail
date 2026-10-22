# Off-hours body fill

Paint-first and the visible page cover the mailbox someone is looking at. The rest of an indexed mailbox can still be headers, or a body cut at the sync cap. Downloading every missing body in a tight loop would trip provider limits: Gmail IMAP is about 2500 MB per day and can pause an account for about an hour when the command rate is too high; Outlook and Graph cap requests and concurrent calls and expect `Retry-After` on 429. Morrow's open and fetch path is IMAP on the existing per-account lane.

From local midnight until 07:00 the background poll downloads one incomplete body after that pass's folder work. There is no second timer and no fast mode. The message is the newest indexed row inside Settings → Mail & Sync (`syncHorizonDays`, where 0 is all history). Trash, spam, and drafts are left alone. The fetch is the same `ensureBody` / `fetchSource` path a cold open uses, so the body stays inside `FULL_CAP` and attachment files stay on demand.

The fill uses the background lane, one IMAP client at a time. It does not start while a visible-page prefetch is queued or in flight, and it does not start while that account is waiting on an open. A 429 pauses the account through the existing rate-limit gate. A message that fails for another reason is skipped until the next night so one bad row cannot occupy every poll.
