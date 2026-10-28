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

The action snapshots the items currently listed in that Agent category when
invoked and marks read only those items. Later arrivals or category moves do
not expand the batch. It leaves the rest of the mailbox, other categories,
and items absent from that snapshot unchanged. If there are no unread items
in the snapshot, the action is a no-op and creates no Undo.

A short Undo on the existing status Undo control restores the previous unread
state of that batch. Undo expires with the notice. A newer status replaces
the notice and invalidates its Undo; an expired or replaced Undo cannot run.
Undo must not overwrite a later per-message flag change. After it expires,
the reads stand.

The action is mark-read only. It does not complete Agent todos, even with the
reply-pile Mark as read opt-in enabled. Completion stays in
[todo completion](./2026-10-29-agent-todo-completion.md).

## Reply pile

The reply pile has no Mark-all primary. The user selects items, then Mark
selected as read or Complete selected. The label says "all" only after an
explicit selection of every row currently listed in that pile. Both commands
touch only the captured selection, not the whole category. An empty selection
marks nothing and completes nothing.

Mark read on a selected reply-pile item follows the todo contract: it leaves
the todo open unless the Settings opt-in is on. Complete selected completes
those todos. It does not mark the mailbox read.

Related: [card view](./2026-10-29-agent-card-view.md).
