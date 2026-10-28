# Agent card view and one detail popover

Status: Proposed for [#374](https://github.com/Coke1120/Morrow-Mail/issues/374).
This note records the view contract. It does not add the view, and it is not
merge or release authorization. Features help stays unchanged until an
implementation ships.

The Agent page keeps its list. Card is another view in the view switcher. It
is not a permanent Bodies-style panel. The reply pile remains Needs You
(Todo in the related issues); this view does not rename categories.

## Card

A card shows the sender, the subject, one line of Agent reason, and one or
two action chips.

## Detail

Hover and keyboard focus open the same detail popover. The popover shows a
fuller summary, the classification reason, one thread line, and quick Reply,
Done, and Dismiss. Moving the pointer or focus from the card into the popover
keeps it open. Blur dismisses it only after focus leaves both surfaces;
pointer leave dismisses it only when neither surface is hovered or focused.
Escape dismisses it and returns focus to the card without reopening it. A
new hover/focus entry or tap can reopen it.

A tap on a touch device opens that same surface without invoking an action;
a separate tap chooses an action, and tapping outside dismisses it. Hover is
not required for the detail to be reachable.

Showing detail is not opening the message or completing a todo. Reply opens
compose; Done is explicit completion, not a mailbox read. Actions follow the
same contracts as list actions, including
[todo completion](./2026-10-29-agent-todo-completion.md).

## Accessibility

The detail summary is the card's accessible description through
`aria-describedby`, not the action controls. Quick actions are labeled,
keyboard-focusable controls; the interactive popover is not a `role="tooltip"`.
Add and remove its description id without losing other descriptions. While
the popover is open, suppress the card's native `title`, so a browser tooltip
does not stack on it. Reuse the Sync Bodies description/title pattern from
[#369](https://github.com/Coke1120/Morrow-Mail/pull/369): one description, and
the native `title` suppressed while the tooltip is open.

Related: [FYI and Other batch read](./2026-10-29-agent-fyi-other-batch-read.md),
[todo completion](./2026-10-29-agent-todo-completion.md).
