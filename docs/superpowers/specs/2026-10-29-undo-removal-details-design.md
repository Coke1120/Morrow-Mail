# Undo removal details

Design for the first-party notice in `renderer/`. Approved approach A, 2026-10-29.

## Problem

After bulk Archive, Trash, or Move, the bottom-right status notice can undo the removal, but it does not say which messages moved where.

## Decision

| Topic | Decision |
| --- | --- |
| Undo all | Keep **Undo N completed changes** for the current removal session. |
| Details | A button beside Undo. It opens a popover anchored to the notice. |
| Popover | Not a modal. Checklist of completed undoable rows. |
| Row | Checkbox, subject, from, action (`archive`, `trash`, or `move`), and destination when known. |
| Selection | Select all and Clear at the top. **Undo selected (k)** is disabled when k is 0. |
| Status chip | Expands or collapses the notice only. It does not open Details. |
| Dismiss | Escape and click-outside close the popover. Focus returns to Details. |
| In flight | Undo all and Undo selected close the popover and refuse re-entry until the call finishes. |
| Large batches | The list scrolls, about eight to ten rows tall. |
| Partial restore | Failed rows stay, N updates, and the existing Restore receipt reports the outcome. |
| Session | A new removal replaces the whole undo session. No multi-batch stack. |
| Mark as read | Its Undo is unchanged and must not replace an active removal Undo. |

## Data

On a completed removal, retain one item per completed `opId`:

```text
{ opId, messageId, accountId, subject, from, action, destinationLabel }
```

Subject and sender come from the messages in that removal. They are kept so a later list reload does not blank the checklist.

## API

Undo all and Undo selected call `mail:undoRemoval({ opIds, kind: "move" })`. Undo selected passes the checked `opId`s. The host already applies the `opIds` it receives, including a subset. There is no new channel.

After a successful subset, drop those items and refresh N. If none remain, clear the undo session and leave the popover closed. Rows that do not complete stay in the list.

An empty immediate `outcomes` list is pending, not success. `mail:actionsSettled` is applied while that undo is still busy. A later retry belongs to the removal generation that created it and does not join a newer removal. Escape while Details is open closes the popover and leaves the mailbox selection as it is.

## Non-goals

- Multi-batch undo history
- Opening Details automatically
- Outbox Undo send
- Agent todo undo
