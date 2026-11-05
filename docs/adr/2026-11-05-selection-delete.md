# Mail selection owns shell Delete

Delete and Backspace in the main Mail window, and Delete on its reader toolbar,
use the active list selection in every reading layout. Previously Right/Bottom
preview Delete used the opened message even when different rows were selected,
and Separate window disabled Delete for multiple selections.

Deletion has its own selection eligibility. Reply, Reply All and Forward keep
their existing target rules. An incomplete, disconnected or already pending
selection cannot fall back to an unrelated preview. A valid selection does not
need a downloaded body or a completed preview open. Without a selection, preview
Delete keeps the opened-message action; Separate window requires a selection.
Independent readers and row-local Delete keep their own message targets.

Selected rows hidden by a loaded-page filter remain selected, as with the
selection-bar Trash action. The main reader Delete button names the selected
count. Delete captures those rows and uses the existing bulk review and removal
flow: account-specific IDs, rate-limit gate, downloaded conversation expansion,
explicit confirmation, frozen reviewed IDs, bounded submission, individual
settlements and confirmed-only Undo. A selection or conversation change after
review cannot add messages to the submission. Ordinary deletion remains Move to
Trash; no permanent-deletion parameter, provider API or permission is added.

`check-mail-delete-selection.js` exercises the production renderer, selection,
confirmation, bulk queue, settlements and Undo with synthetic DOM/mail/IPC. It
runs in `npm run check`. `check-mail-delete-browser.js` covers real Chromium
keys, reader buttons, native confirmation/Escape, cross-account targets, hidden
selections, Undo, all reading layouts, narrow/wide windows, themes and rendered
help. Existing shortcut and bulk/Undo tests retain their coverage. Native
Windows/macOS behavior and live mailbox mutations are not established by these
fixtures.
