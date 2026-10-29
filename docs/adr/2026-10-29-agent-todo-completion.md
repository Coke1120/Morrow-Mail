# Complete an Agent todo after a successful reply send

Status: Accepted and implemented for [#372](https://github.com/Coke1120/Morrow-Mail/issues/372).
The Agent page and the Features catalog follow this contract. This note is
not merge or release authorization.

Mark as read is an inbox flag. A successful reply send is the completion
signal for that Agent todo. Todo here is the Agent reply pile (Needs You in
the current category list). This note does not rename it.

## Send

Reply or Reply All completes only the source mailbox's todo recorded when
the reply starts, and only after confirmed send success. The new outgoing
message id, current selection, and other todos in the thread are not completion
targets. Forward and a new message do not complete the source todo.

These leave the todo open:

- Opening compose, then closing or cancelling it.
- Saving a draft.
- A send that fails.
- Queueing or scheduling a send. Completion waits until that send succeeds.
  A failed or cancelled queued or scheduled send leaves the todo open.

## Mark as read

Mark as read by itself leaves the Agent todo open. Automatic mark-read-on-open
never completes it.

Two controls ship with this contract:

- Mark read & done, on a reply-pile row, marks the message read and completes
  the todo, because the user asked for done.
- A Settings opt-in, "Mark as read also completes Agent todos", is off by
  default. When it is on, a plain explicit Mark as read on a reply-pile item
  completes the todo. With the opt-in off, Mark as read still leaves the todo
  open. This opt-in does not cover automatic reads or the FYI/Other category
  action.

Selected and batch actions on this pile use the same contract. The pile has
no Mark-all primary; see
[FYI and Other batch read](./2026-10-29-agent-fyi-other-batch-read.md).

The opt-in and Mark read & done wait for the matching read journal operation's
completed settlement, not its pending acceptance. Failure restores the Agent
unread projection without completing the todo. Unknown, superseded and
unattempted operations also leave it open.

Related: [learning](./2026-10-29-agent-learning.md),
[unread-filter hold](./2026-10-29-unread-filter-defer-removal.md).
