# Background sync visits every folder

Background sync used to download Inbox and the folder open in the window. Every other folder waited until someone opened it.

The poll now walks every folder row stored for the account. Those rows are the selectable mailboxes from the last folder list. IMAP `\Noselect` boxes are already left out of that list. Gmail labels and Outlook folders that are listed are included. Starred and Unread are filters, not folders, so they are not synced.

Each background pass shares the existing tick budget (`TICK_MS`, 25 seconds unless a test overrides it). A folder gets one download batch, then the next folder gets a turn. The pass remembers the first folder that did not get a turn and continues there on the next poll. When the pass finishes every folder, the next poll starts one folder later so the same mailbox does not keep the first turn.

The open folder is second in that pass when it is not already the folder whose turn it is. A pass that only has time for one folder spends it on the folder whose turn it is. The open folder cannot freeze the rest of the mailbox. Manual Sync on the open folder still uses the longer single-folder download. IDLE still watches Inbox only. New mail in other folders arrives on the rotating poll.

The history horizon, rate-limit pause, and batch sizes are unchanged. A wider horizon still catches up. Shortening the horizon still keeps cached mail.

All history with many folders takes longer the first time and stores more mail. All Mail and labels can store another copy of a message that is also in Inbox or Sent.

Opening a message whose body is not downloaded yet does not wait for the rest of that pass. The walk finishes the current folder batch, then the body fetch uses the account connection. The pass continues in the same tick when time remains, and otherwise on a later poll. See [2026-10-22-priority-open-over-background-sync.md](2026-10-22-priority-open-over-background-sync.md).
