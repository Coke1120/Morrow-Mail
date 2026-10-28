# Mark FYI and Other read in one step, with Undo

Status: Proposed for [#373](https://github.com/Coke1120/Morrow-Mail/issues/373).
This note records the batch-read contract. It does not add the control, and
it is not merge or release authorization. Features help stays unchanged until
an implementation ships.

FYI and Other are skim-and-dismiss piles. The Agent reply pile (Todo in this
issue; Needs You in the current category list) stays off this batch action.

## FYI and Other

Each FYI and Other category header offers Mark category as read. The control
is hidden when that category list is empty.

The action marks read only the items currently listed in that Agent category.
It leaves the rest of the mailbox, other categories, and items absent from
that list unchanged.

A short Undo on the existing status Undo control restores the previous unread
state of that batch. Undo expires with the notice. A newer status replaces
it. After it expires, the reads stand.

The action is mark-read only. It does not complete Agent todos. Completion
stays in [todo completion](./2026-10-29-agent-todo-completion.md).

## Reply pile

The reply pile has no Mark-all primary. The user selects items, then Mark
read or Complete selected. The label says "all" only when the user has
explicitly selected every row the command will touch. An empty selection
marks nothing and completes nothing.

Mark read on a selected reply-pile item follows the todo contract: it leaves
the todo open unless the Settings opt-in is on. Complete selected completes
those todos. It does not mark the mailbox read.

Related: [card view](./2026-10-29-agent-card-view.md).
