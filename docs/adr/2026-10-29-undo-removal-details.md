# Undo removal details

After a bulk Archive, Trash, or Move, the notice Undo reverses the whole removal session and does not say which messages moved where.

## Decision

Keep **Undo N completed changes** as Undo all for the current removal session. Add **Details** beside it. Details opens a small popover anchored to the notice, not a modal. The popover is a checklist of the completed undoable rows in that session. Select all and Clear sit at the top. **Undo selected (k)** is disabled when nothing is checked.

The status chip only expands or collapses the notice. It does not open Details. Escape and a click outside the popover close it. While Undo all or Undo selected is running, the popover closes and stays closed until that call finishes.

A new removal replaces the whole undo session. There is no multi-batch stack. Mark as read keeps its own Undo and does not replace an active removal session. A partial restore keeps the rows that did not complete, updates N, and reports them with the existing Restore receipt.

## Surface

Each row shows a checkbox, subject, sender, action (`archive`, `trash`, or `move`), and `destinationLabel` when that destination is known. The list scrolls at about eight to ten rows. Checkboxes are named by subject. The popover is `role="dialog"` labeled "Undo details". Focus returns to Details when Escape closes it.

## Data

The renderer keeps `undoItems` for the current session:

`{ opId, messageId, accountId, subject, from, action, destinationLabel }`

Only completed rows that have an `opId` are included. Subject and sender are captured from the messages in that removal before the list reloads.

## API

Undo all and Undo selected both call the existing `mail:undoRemoval({ opIds, kind: "move" })`. The host already undoes exactly the `opIds` it is given, so a subset uses that same channel. No new IPC channel.

An immediate response with an empty `outcomes` list is still pending. Those rows stay in the session and are not submitted again until `mail:actionsSettled` says they completed or failed. That settlement is applied even while the undo call is still busy, including during the list reload. Each removal session has a generation. A retry from an older generation does not join or revive a newer session.

## Non-goals

Multi-batch history, opening Details automatically, Outbox Undo send, and Agent todo undo are out of scope.
