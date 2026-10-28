# Complete an Agent todo after a successful reply send

Status: Proposed for [#372](https://github.com/Coke1120/Morrow-Mail/issues/372).
This note records the completion contract. It does not change the Agent page,
and it is not merge or release authorization. Features help stays unchanged
until an implementation ships.

Mark as read is an inbox flag. A successful reply send is the completion
signal for that Agent todo. Todo here is the Agent reply pile (Needs You in
the current category list). This note does not rename it.

## Send

Reply or Reply All completes that todo only after the send for its message
succeeds. The completed todo is the one whose message was sent. Other todos
stay open.

These leave the todo open:

- Opening compose, then closing or cancelling it.
- Saving a draft.
- A send that fails.
- Scheduling a send. Completion waits until that scheduled send succeeds.
  Cancelling the schedule leaves the todo open.

## Mark as read

Mark as read by itself leaves the Agent todo open.

Two optional controls may ship later. Both stay off until the user chooses
them:

- Mark read & done marks the message read and completes the todo, because the
  user asked for done.
- A Settings opt-in, "Mark as read also completes Agent todos", makes a plain
  Mark as read complete the todo. With the opt-in off, Mark as read still
  leaves the todo open.

Selected and batch actions on this pile use the same contract. The pile has
no Mark-all primary; see
[FYI and Other batch read](./2026-10-29-agent-fyi-other-batch-read.md).

Related: [learning](./2026-10-29-agent-learning.md).
