# Keep the opened unread row until the next unread open

Status: Accepted and implemented for [#375](https://github.com/Coke1120/Morrow-Mail/issues/375).
The Unread list keeps one opened row, as described below. This note is not
merge or release authorization.

Opening a message under the Unread filter may still mark it read, using the
existing open-to-read policy. The opened row stays in that filtered list
while the user is reading it.

## Hold

While the Unread filter is showing, opening unread message A may mark A read.
A stays listed. A is the held row. At most one row is held; there is no hold
until an unread message opens.

The row may show its read flag and remain in the list. The hold is list
membership, not a second copy of the flag.

Opening a different message B that is unread at the moment of open releases
A's hold. A leaves the list only if it is read; if opening did not mark it
read, it still matches Unread. B becomes the sole held row under the same
rule, including mark-read-on-open.
Opening a message that is already read, or opening the held row again, leaves
the hold where it is. Highlighting a row without opening it does not start
or move the hold.

Other filters do not gain a held row.

A refresh or sync repaint of the Unread list keeps the held row. If that
message is gone from the folder, the hold ends.

## Toolbar and shortcut mark read

Mark as read from the toolbar or a shortcut removes a row that is not the
held row immediately.

The same command on the held row leaves it listed. The hold is what keeps
the open message from leaving under the reader.

Marking the held row unread clears the hold. The row stays because it
matches Unread on its own. A later toolbar or shortcut Mark as read, with no
new unread open, then removes it. Opening that unread message again starts a
new hold.

## Leave the filter

Leaving the Unread-filtered list clears the hold. That includes switching
folder or account, clearing the filter, and choosing another filter.
Returning does not restore the previous held row. The list shows mail that
is still unread until a new open creates a new hold.

## Batch mark read

Multi-select Mark as read on the mail list removes every selected row
immediately, including the held row when it is selected. When that command
includes the held row, it clears the sole hold; a held row outside the
selection stays. Unlike the single-message toolbar or shortcut command,
this batch clears a selected hold even with only one selected row.

Agent category mark-read is a different surface. See
[FYI and Other batch read](./2026-10-29-agent-fyi-other-batch-read.md).

The hold changes list membership, not completion of the Agent reply pile
(Todo in the related issues; Needs You today). See
[todo completion](./2026-10-29-agent-todo-completion.md).

Related: [learning](./2026-10-29-agent-learning.md).
