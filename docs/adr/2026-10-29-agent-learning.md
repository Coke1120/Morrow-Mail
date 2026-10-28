# Learn only revocable Agent corrections

Status: Proposed for [#371](https://github.com/Coke1120/Morrow-Mail/issues/371).
This note records the contract. It does not implement learning, and it is not
merge or release authorization. Features help stays unchanged until an
implementation ships.

Agent triage classifies a message and then forgets how the user corrected it.
The next similar message starts again. Learning stays a small local list of
explicit corrections.

## What may be learned

Three signals, each from an explicit action:

- A category move between the Agent reply pile (Todo in this issue; Needs You
  in the current category list), FYI, and Other. This note does not rename
  categories. Moves among other Brain categories are not signals.
- The same explicit command repeated on one sender, or on one thread, such as
  Mark as read. A missing reply is not counted by itself.
- Opening a suggestion class versus dismissing that same class. The class is
  the suggestion label the UI already shows.

Message bodies, drafts, and mailbox-wide statistics are not training data.

## Threshold

The same pattern is an observation until it has been seen at least three
times. Below three, classification and actions stay as they are. At three,
the pattern may apply. Applying it adds a Learned entry. It does not rewrite
Brain categories, triage prompt text, Gmail filters, or Outlook rules.

## Learned list

Settings shows the Learned list. Each entry can be deleted on its own. Delete
removes that entry and its count. The pattern has to reach three again before
it can apply. There is no silent rewrite of rules.

## Storage and consent

Rows stay on this computer with other Morrow preferences. A row is the signal
kind, the match (category pair, sender, thread, or suggestion class), the
count, and whether the threshold has been reached. Rows are not written into
`brain.json` categories or provider rules.

Counting these actions adds no cloud mailbox export and no new scope. A later
model call stays inside the existing AI consent and the saved target.

Out of scope: on-device model training, and any upload of mailbox contents
beyond consent already granted.

Related: [todo completion](./2026-10-29-agent-todo-completion.md),
[FYI and Other batch read](./2026-10-29-agent-fyi-other-batch-read.md),
[card view](./2026-10-29-agent-card-view.md),
[unread-filter hold](./2026-10-29-unread-filter-defer-removal.md).
