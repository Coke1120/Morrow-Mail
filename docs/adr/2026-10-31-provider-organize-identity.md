# Bind organize writes to the selected message

Status: Accepted, 2026-10-31 (wave3 F1–F8 corrections).

Gmail label edits use the selected cached row's provider ID or saved UID alias.
An unbound legacy row requires a unique, non-paginated RFC Message-ID match and
verification of its source-folder membership. Outlook moves resolve the source
folder by provider identity, well-known identity or complete hierarchy, then
require exactly one match in that folder. First-hit searches and ambiguous leaf
names cannot authorize a write. The selected row and account are rechecked
after asynchronous lookups, immediately before the mutation.

Provider memberships are projected from the account-scoped Gmail mapping table
into lists and details, with batched list reads. Confirmed label removals retire
the corresponding cached folder copies using the existing draft/action-hold
guards. Renderer reconciliation clears only successfully removed messages in
the still-owned folder view; it does not consume an unrelated removal Undo.

Mailbox navigation owns asynchronous list and folder-move completion. A new
list scope retires old actionable rows before awaiting cache reads. Open in Mail
enters Mail synchronously, so completion cannot override later Support visits.
Escape outside Mail does not alter its hidden selection. These changes add no
permissions, delivery behavior, bot operations or release/version changes.
