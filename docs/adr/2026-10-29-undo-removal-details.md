# Undo removal details

After a bulk Archive, Trash, or Move, the notice Undo reverses the whole removal session and does not say which messages moved where.

## Decision

Keep **Undo N completed changes** as Undo all for the current removal session. Add **Details** beside it. Details opens a small popover anchored to the notice, not a modal. The popover is a checklist of the completed undoable rows in that session. Select all and Clear sit at the top. **Undo selected (k)** is disabled when nothing is checked.

The status chip only expands or collapses the notice. It does not open Details. Escape and a click outside the popover close it. While Undo all or Undo selected is running, the popover closes and stays closed until that call finishes.

A new removal replaces the whole undo session. There is no multi-batch stack. Mark as read keeps its own Undo and does not replace an active removal session. A partial restore keeps the rows that did not complete, updates N, and reports them with the existing Restore receipt.

## Surface

Each row shows a checkbox, subject, sender, action (`archive`, `trash`, or `move`), and `destinationLabel` when that destination is known. Sessions spanning multiple accounts also show each row's readable mailbox label/address, or "Unavailable mailbox" if that account no longer has readable metadata; internal account IDs are not shown. The list scrolls at about eight to ten rows. Checkboxes are named by subject and reference the visible sender/action/destination/mailbox metadata with `aria-describedby`. The popover is `role="dialog"` labeled "Undo details". Focus returns to Details when Escape closes it.

## Data

The renderer keeps `undoItems` for the current session:

`{ opId, messageId, accountId, subject, from, action, destinationLabel }`

Only completed rows that have an `opId` are included. Subject and sender are captured from the messages in that removal before the list reloads.

## API

Undo all and Undo selected both call the existing `mail:undoRemoval({ opIds, kind: "move" })`. The host already undoes exactly the `opIds` it is given, so a subset uses that same channel. No new IPC channel.

An immediate response with an empty `outcomes` list is still pending. Those rows stay in the session and are not submitted again until `mail:actionsSettled` says they completed or failed. That settlement is applied even while the undo call is still busy, including during the list reload. Each removal session has a generation. A retry from an older generation does not join or revive a newer session.

### Interaction and settlement follow-up (2026-10-30)

Keep the notice anchored at the bottom-right in both expanded and collapsed forms. Its dwell timer pauses during hover, focus or Details interaction. Details preserves its open state, surviving checked rows, scroll position and checkbox focus during same-generation updates, including late completions from another account; new rows start unchecked. Only a new removal generation clears that checklist. Hiding it returns focus to a visible control. Escape returns to Details, while Tab away dismisses the nonmodal popover without taking focus back. The checklist stays bounded by the window height.

Serialize restore requests until all requested rows settle, including after an empty immediate response. The controls show Restoring while waiting. A partial settlement removes only confirmed completions; absent rows remain pending, and failed rows remain available to retry afterward. This preserves the single in-flight tracker and avoids replacing it with a second subset request. A late rejected invoke cannot resurrect settled rows or overwrite a replacement session's receipt.

Match settlement rows against still-outstanding tickets. An explicit retry ticket must match exactly; a completed message row must be newer than the generation captured before its restore request. Repeated completion rows and earlier restores of the same message cannot consume another pending ticket. Later unrelated read/star generations do not invalidate the captured restore boundary.

Scheduled cancellation retains its separate eight-second Undo offer. Expiry ends the unclaimed offer, not ownership of an already-started restore's success or failure feedback. Restore captures the offer's generation separately from its expiring snapshot; a newer cancellation owns its own offer and status, even after that newer offer expires. Outbox cancellation continues to use its durable queue and remains outside this checklist.

## Non-goals

Multi-batch history, opening Details automatically, Outbox Undo send, and Agent todo undo are out of scope.
