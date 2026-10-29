# Learn only revocable Agent corrections

Status: Accepted and implemented for [#371](https://github.com/Coke1120/Morrow-Mail/issues/371).
Settings → Learned, the Agent page, and the Features catalog follow this
contract. This note is not merge or release authorization.

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

Read acceptance is not provider success. The renderer retains the click's
`begunAt`, action id and generation until a completed journal settlement.
Failed, unknown, superseded and unattempted reads do not count or complete
todos. Split settlements from one batch reuse that click identity. Undo can
cancel a pending read observation; it does not remove a confirmed observation.
Reply source identity is frozen separately from the optional Needs You todo,
so successful FYI, Other and already-completed-source replies can also count.

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

## Application

Reaching three sets `learned` on that row. That is the audit trail. Stored
triage assignments, Brain categories, triage prompt text, Gmail filters, and
Outlook rules stay as written.

- Category: the row records the pair and the senders in those moves. A later
  message that is still stored in the source category, from one of those
  senders, shows “Learned: move to …”. It stays in the source pile until the
  user moves it. Delete does not put an already moved message back.
- Action: a matching sender or thread shows “Learned: Mark as read”,
  “Learned: Reply”, or “Learned: Reply All”. The row does not mark read,
  reply, or complete a todo.
- Suggestion: a learned Dismiss hides that suggestion label until Delete,
  unless a later learned Open of the same label is newer. Open does not
  open the suggestion or send.

Learning changes invalidate mounted conversations, skill results and proposal
lists as well as Home and Settings. Fresh triage retains validated thread ids;
old cached rows may acquire one from the same message and mailbox in the cache.

Undo of Mark as read does not erase the observation. Delete does.

An observation carries `begunAt` from the click or from Send. Delete records
that moment. An observation that started earlier does not recreate the row.
The same `begunAt` does not count twice. A batch is one observation for each
distinct pattern it touches. Automatic read-on-open, and any action whose
source is learning itself, does not count.

Reply and Reply All count only after confirmed send success, including one
successful scheduled or undo-delay send. Queueing, cancelling, a failed send,
and a partial delivery do not count.

## Learned list

Settings shows pending observations and Learned entries. Each pattern can be
deleted on its own, including before it reaches three. Delete removes that
pattern and its count. In-flight counts or applications begun before deletion
must not recreate or reapply it. Only later explicit actions start a new
count, which must reach three again. There is no silent rewrite of rules.

## Storage and consent

Rows live in `agent-learning.json` beside `agent.json` in the AI config
directory (the same userData directory as other Morrow preferences). A row is
the signal kind, the match (category pair, sender, thread, or suggestion
class), the count, and whether the threshold has been reached. Category rows
also keep the sender addresses from those moves, capped, so the hint stays
on that mail. Rows are not written into `brain.json` categories or provider
rules. A damaged file is left in place and is not replaced with an empty list.

Schema damage, including a malformed pattern or revocation, also blocks writes;
the complete original file stays available for explicit recovery. Percent-encoded
legacy ids remain valid up to the shared 2048-character reader/deleter bound;
larger generated identities use a stable SHA-256 suffix. Each row retains up to
256 recent observation timestamps to deduplicate non-adjacent retries while
allowing distinct out-of-order completions. Older legacy rows seed that history
from `lastBegunAt`; timestamps never move the latest choice backwards.

Counting these actions adds no cloud mailbox export and no new scope. A later
model call stays inside the existing AI consent and the saved target.

Out of scope: on-device model training, and any upload of mailbox contents
beyond consent already granted.

Related: [todo completion](./2026-10-29-agent-todo-completion.md),
[FYI and Other batch read](./2026-10-29-agent-fyi-other-batch-read.md),
[card view](./2026-10-29-agent-card-view.md),
[unread-filter hold](./2026-10-29-unread-filter-defer-removal.md).
