# Status line collapses to a corner chip

Action results still use `showStatus` and the `#notice` text. That call chooses the words and whether the line is an error. It does not change what a mail action reports.

A non-error line stays expanded for 4 seconds, then collapses to a bottom-right chip. An error stays expanded for 12 seconds, then collapses to the same chip with an error color so it remains visible. Clicking the chip or the expanded line toggles it. A pointer press outside the notice, or Escape, collapses it. Escape does not take a dialog, an open move menu, or a text field. Opening the line by hand keeps it open until the next status or a dismiss.

Undo, Undo send, and Undo cancel stay in the notice when the text collapses. The last status string stays in the chip's name and title.
