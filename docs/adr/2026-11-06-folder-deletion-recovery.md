# Reviewed folder changes and Gmail deletion cancellation

Folders & Labels uses the mailbox's mail transport for browsing and creation so
IMAP, Yahoo and Outlook do not need a separate Google or Graph grant. Raw IMAP
LIST delimiters, flags and non-selectable container parents are preserved. The
existing provider tools and Local Folders controls keep their own capabilities.

Gmail label deletion keeps messages but destroys the original label memberships.
Creating a replacement label cannot undo that loss. Morrow therefore offers an
explicit 30-second cancellation window, with the reviewed label still present
on Gmail until it expires. Undo cancels the durable intent before any deletion
request. The UI discloses that it cannot restore memberships after removal.

The recovery journal contains folder metadata and intent/receipt state, never
mail bodies or credentials. It uses SQLite synchronous EXTRA and a delete
journal. The timer uses monotonic time. A process restart pauses pending intent;
an interrupted write becomes uncertain. Neither state is automatically replayed.
Paused intent can be cancelled. An unknown provider outcome must be inspected
at the provider. A failed storage/proof check never authorizes a provider write.
When the mailbox binding changes, only journal-proven pending/paused label
intent is cancelled locally. It cannot permanently block that label under a new
connection. Older running or uncertain writes remain visible without an Undo
claim, with provider inspection required. They are never retired as unwritten.

One-use, expiring host reviews bind the exact folder, account incarnation,
endpoint/transport, credential revision and Google client. Proofs are checked
before credential reads, after lane/connection waits, after provider awaits and
before submission. The renderer also retires reviews after mailbox/navigation
changes. Account switching cannot redirect an old confirmation to a new mailbox.
System and virtual folders are independently protected by the host.
Retained legacy folder creation/nesting also uses this transport ownership proof,
including after login and logout waits, before touching provider or cache state.

IMAP/Outlook/Yahoo folder deletion remains unavailable. A universal recoverable
subtree move cannot be promised from LIST alone, and Gmail over legacy IMAP must
retain label semantics. No generic mailbox DELETE or irreversible Graph fallback
is exposed. A future implementation needs independently proven server identity,
subtree/UIDVALIDITY behavior, durable receipts and restore collision handling.
Local Folders retains its existing empty-folder deletion without an Undo claim.

Synthetic tests cover actual journal reopen, corruption, compare-and-set races,
timer/Undo/shutdown, ambiguous outcomes, storage failures, transport ownership
and first-party channel/preload behavior. They do not prove real power-loss
durability, server-specific recovery, or native screen-reader behavior.
