# Mail folder chip alignment

Base: `dev` at `d3271402c0654bd09d58a5b77c2558645c7d4eab`.
The original user screenshot was not inspected. All rendering and interaction
checks use synthetic mail in the bundled renderer with mocked IPC, without
booting the host or reading a real mailbox or credential store.

The browser reproduced the offset on the unmodified stylesheet: in a 760px list,
Inbox and Sent began at x=290px while All Mail began at x=630.625px. The comparison
failed before the fix. All Mail keeps a visible title because it is not enabled
as a folder chip by default; that title and the chip group both grew to fill the
same flex row. Inbox and Sent hide their duplicate title, so their chips began
at the left.

A visible title now takes its own row when folder chips are shown. The chip group
wraps within its available width and stays before Sync in DOM and keyboard order.
When chips are hidden, the title and Sync keep their existing single row.

Validation:

```sh
node scripts/check-folder-chips.js
MORROW_PLAYWRIGHT_MODULE=/path/to/playwright \
MORROW_AXE_MODULE=/path/to/axe-core/axe.min.js \
MORROW_UI_OUTPUT=/tmp/morrow-mail-chip-alignment \
node scripts/check-mail-layout-browser.js
npm run check
```

The rendered comparison checks All Mail, Inbox and Sent at 440, 900 and 1440px,
in light and dark themes with reduced motion: 18 comparisons. After the fix,
all three start at x=290px in the wide fixture. Nine enabled folder chips wrap
onto three rows in a 320px list without leaving the card or overlapping Sync.
Tab visits those chips in order and reaches Sync; Enter and Space each dispatch
one choice for the correct mailbox/folder. The rendered Features tab and hidden
chip layout are checked. The existing column, preview, splitters, paging and
accessibility checks continue in the same browser run.

The browser writes synthetic PNGs and `folder-chip-geometry.json` to its temporary
output directory. These verify the implemented layout, not the unavailable
original screenshot. Native Windows/macOS window rendering remains unverified.
