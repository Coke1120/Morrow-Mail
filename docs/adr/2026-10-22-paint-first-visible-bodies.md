# Paint a cached body, then prefetch the visible page

Sync stores a capped source. Rows that hit the cap stay `body_complete = 0` even when HTML or text was saved. Opening one of those messages waited on a full IMAP fetch before the reader painted.

`mail:openEmail` now returns that stored HTML or text immediately and finishes the download on the background lane. The reader repaints when the full body arrives. A message with no stored body still waits, on the user lane, and still jumps ahead of queued background work. Reply, forward, and resume draft pass `full: true` so they wait for the complete body. The full fetch stays `fetchSource` (the capped RFC822). A text or HTML part fetch needs stored structure before it can keep attachments and recipient headers.

After `mail:listFromCache` or a network list, incomplete rows on that page (at most 200, newest first) prefetch one at a time on the background lane. Before each row, a waiting open stops the queue so the open takes the connection. Changing folder or page drops the rest of that queue. The rest of the mailbox is not prefetched with the visible page. A slow off-hours fill is separate; see `2026-10-22-overnight-body-fill.md`.
