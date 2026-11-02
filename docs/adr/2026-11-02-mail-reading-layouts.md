# Mail reading layouts

The Mail toolbar offers Right preview (the default), Bottom preview and Separate
window beside downloaded-mail search. Layout changes reuse the same list and
reader DOM, so sorting, column order, search scope and selection stay intact.
Scroll offsets are retained per layout in the current folder, filter, query and
page; navigation retires those offsets.

`mailView` stores the layout and bottom list height in local settings, independently
of `layoutPanes` widths and `mailColumnOrder`. Bottom or window resizing must not
replace the saved right-preview widths with the full list width. Preference
writes serialize, and a late preference read or shell refresh cannot undo a newer
view choice. Choosing a view does not open mail or perform a mailbox write.

Separate window makes a plain mouse click select one message. Modifier selection,
checkboxes, drag and row actions retain their existing behavior. Double-click and
keyboard activation reuse `openReaderWindow` / `reader:open`, passing only account
and message IDs to the existing host validation and reader bootstrap. No new
navigation, HTML, URL, preload or window-security path is introduced. Reading and
mark-as-read behavior belongs to the existing independent reader. Outbox retains
its scheduled-message preview below the list, without changing the saved layout.

Small windows stack previews below the list. List minimum height reserves space
for its controls plus scrolling rows, including expanded search coverage; a short
shell can scroll. Dividers expose their axis, current size and bounds and support
the matching arrow keys. The View menu uses radio menu items, focus return,
Escape, outside dismissal and standard arrow/Home/End navigation.

The topmost title/filter toolbar (`.list-head`), above the column headings, needs
its own top radii because its opaque background can cover both outer top corners
of the All Mail card. These are the whole card's corners, independently of the
table's column header. The scrolling surface gets bottom radii when paging
is hidden. The card keeps visible overflow so the existing Sync tooltip can
extend beyond the list rather than being cut off at its border.

`check-mail-view.js` covers actual preload/settings, selection/open semantics,
state retention, read/write races, keyboard controls and splitter persistence.
`check-mail-layout-browser.js` exercises all three layouts in Chromium, themes,
desktop and narrow sizes, expanded controls, pointer and keyboard resizing,
popout seeds, scoped axe checks and rendered Features. Its All Mail corner check
targets both outer corners at the title/filter toolbar, beside a rounded reader;
a negative control flattens only that toolbar and must reproduce the square
corners before restoring the actual CSS. It uses synthetic mail;
native Windows/macOS window behavior still needs platform verification.
