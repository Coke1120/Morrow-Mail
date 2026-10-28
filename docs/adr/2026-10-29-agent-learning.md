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

Command repetitions count only after confirmed success. Failed sends, draft
saves, and queueing or cancelling a scheduled send do not count. A scheduled
send may count once when it succeeds, not when it is queued.

One explicit action contributes at most one observation to the same pattern,
even when it touches a batch. Automatic read-on-open, event retries, and
actions applied by learning do not add observations.

Message bodies, drafts, and mailbox-wide statistics are not training data.

## Threshold

The same pattern is an observation until it has been seen at least three
times. Below three, classification and actions stay as they are. At three,
the pattern may apply. Applying it adds a Learned entry. It does not rewrite
Brain categories, triage prompt text, Gmail filters, or Outlook rules.

A learned pattern cannot authorize a send or change the completion,
batch-selection, or unread-hold contracts linked below.

## Learned list

Settings shows pending observations and Learned entries. Each pattern can be
deleted on its own, including before it reaches three. Delete removes that
pattern and its count. In-flight counts or applications begun before deletion
must not recreate or reapply it. Only later explicit actions start a new
count, which must reach three again. There is no silent rewrite of rules.

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
