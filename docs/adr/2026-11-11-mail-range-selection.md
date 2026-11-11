# Mail range selection anchors

A plain preview click keeps the clicked message as the range anchor without
activating checkboxes or the bulk-selection bar. Previously clearing the checked
selection also forgot that anchor, so the next Shift-click selected just its own
row. The anchor now survives ordinary list/reader repaints independently of the
checked IDs. Plain clicks, checkbox toggles and Ctrl/Cmd-clicks establish it;
repeated Shift-clicks retain it while extending or shrinking an inclusive range.
Row checkboxes use the same Shift range calculation as message buttons.

Ranges follow `shownEmails()` in its displayed order, on the loaded page only.
They cannot add filter-hidden or pending-removal messages. If the anchor is not
visible, the clicked message starts a one-message range. Ordinary Shift replaces
the checked selection; Ctrl/Cmd + Shift adds to it, preserving existing selections
even if a page filter hides them. Neither opens the Shift target or marks it read.
Separate window keeps its existing plain-click selection and independent reader.
Outbox keeps its existing non-selectable scheduled preview.

Clear/Escape, search, folder navigation and page changes retire the anchor.
Pruning loaded rows retains a valid unselected anchor, but removes one that is no
longer loaded. Search and local move explicitly clear it when clearing selection
instead of relying on the old checked-ID pruning rule.

`check-mail-selection.js` runs in the aggregate check with production handlers and
synthetic DOM/mail/IPC. `check-mail-selection-browser.js` uses actual Chromium
clicks, modifiers, repaints and rendered Features/Shortcuts across layouts and
themes. Neither suite certifies native Windows/macOS or live mailbox behavior.
