# Contextual actions

Current source reduces the controls shown before a task is selected.
It keeps the existing Mail, Agent and Brain destinations, mailbox ownership,
confirmation and recovery behavior. It was not included in the v0.8.2 downloads.

## Reading and selecting mail

The reader keeps Reply prominent. Reply all and Forward are available with the
reply actions; provider organization has its own named menu. More contains
secondary markers, local organization and layout actions. Local changes remain
labeled as changes on this device, separate from provider moves. AI help is one
entry to the existing reviewed actions. Attachment controls, image consent and
plain-text fallback stay beside the content they affect.

Selection actions appear with the selection count. Windows puts bulk commands
under Actions and keeps provider Delete visible for the selected messages.
macOS hides the selection Delete button while nothing is selected. Existing
provider Trash and its one-minute Undo retain their original behavior; moving
commands into a menu does not create a new confirmation or a new undo guarantee.

## Today and reply review

Today keeps the mailbox scope visible. Selecting a reply suggestion opens its
editor on Today. Narrow windows show one detail pane with Back to Today; wider
windows retain the list beside the reply. The editor identifies the original
From mailbox and uses the same draft, source validation and send-review actions
as Reply suggestions. Switching scope closes the current detail while retaining
account-owned edits. Opening or saving a suggestion does not send it.

Review replies on macOS and Review suggested reply on Windows open the owned
reply editor. Summary creation and saved-suggestion reload are available from
More. Summary creation still requires its existing
scope and permission review. Existing event/task classifications, completion
markers, retention limits and summary freshness rules are unchanged.

## Management and composing

Writing rules, categories, reusable skills and conversations keep their named
management commands in row menus. Running work keeps its Stop control available,
and pending proposals retain their review decisions. The extra Agent/Brain
subpage navigation is hidden only while the expanded sidebar exposes the same
destinations; it returns when the sidebar is collapsed.

Initially empty Cc and Bcc fields can be revealed while composing. Populated
fields remain visible, and revealing them does not edit a draft. Save, send
review, scheduling, attachment ownership and uncertain-send recovery keep their
existing handlers and safeguards.

## Verification boundary

This change extends existing native fixtures to invoke mounted controls and
check mailbox scope, stale controls, selection, draft retention and confirmation
behavior. Static source checks and preserved-handler comparisons do not establish
native compilation, keyboard traversal, screen-reader behavior or usability.
Both platform SDK jobs and their native gates remain required. There is no
measured learning-curve improvement or claim of another application's parity.

See [verification](../VERIFICATION.md) for the tested sources, results and
remaining limitations. No real mail, calendar, external model or provider is used
by the new synthetic UI checks.
