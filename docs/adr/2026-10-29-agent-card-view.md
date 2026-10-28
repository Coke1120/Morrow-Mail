# Agent card view and one detail popover

Status: Proposed for [#374](https://github.com/Coke1120/Morrow-Mail/issues/374).
This note records the view contract. It does not add the view, and it is not
merge or release authorization. Features help stays unchanged until an
implementation ships.

The Agent page keeps its list. Card is another view in the view switcher. It
is not a permanent Bodies-style panel.

## Card

A card shows the sender, the subject, one line of Agent reason, and one or
two action chips.

## Detail

Hover and keyboard focus open the same detail popover. The popover shows a
fuller summary, the classification reason, one thread line, and quick Reply,
Done, and Dismiss. Escape and blur dismiss it, as other popovers do.

A tap on a touch device opens that same surface. Hover is not required for
the detail to be reachable.

## Accessibility

The open detail is the card's accessible description through
`aria-describedby`. While the popover is open, the card does not also set a
native `title`, so a browser tooltip does not stack on it. That is the Sync
Bodies tooltip pattern from
[#369](https://github.com/Coke1120/Morrow-Mail/pull/369): one description, and
the native `title` suppressed while the tooltip is open.

Related: [FYI and Other batch read](./2026-10-29-agent-fyi-other-batch-read.md),
[todo completion](./2026-10-29-agent-todo-completion.md).
