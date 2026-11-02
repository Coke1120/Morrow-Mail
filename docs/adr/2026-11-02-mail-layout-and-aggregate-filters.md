# Mail column layout and aggregate flag views

Column order is a presentation preference in `settings.json` (`mailColumnOrder`),
separate from the existing sort preference. All four existing fields retain their
sort semantics, widths and content. Dragging commits only on a valid header drop;
Escape or an outside drop changes nothing. Alt + Left/Right and the Columns dialog
provide keyboard alternatives. Reset restores Date, Recipient, Sender, Subject.
Unknown and duplicate keys are discarded and missing supported keys are appended.
Header and row DOM order match the visible order. A layout change never loads mail
or changes sorting, selection, folder/account scope or search limits. Outbox still
uses scheduled delivery order and can share a layout chosen through Columns.

All Account Mail contains Inbox, Outbox, Starred and Unread. Inbox keeps its
existing primary-folder scope. The former Inbox unread chip is removed. The two
new rows aggregate the existing per-account virtual filters and their counts.
Per-account unread badges remain. Starred uses stored flags across folders. Unread
keeps the same Sent/Drafts/Trash/Spam/search-only/snoozed exclusions as each account's
Unread view, with exclusions bound to account and folder together. A Trash path in
one account cannot hide an ordinary folder with the same path in another.

The renderer requests `aggregateView: starred|unread` through `mail:listFromCache`.
The host resolves it into the existing virtual filters and SQL predicates, with
bounded metadata-only pages, existing sort allowlists and cached counts. It does
not fetch every message into JavaScript or perform network sync. Per-account
folder copies retain existing virtual-folder semantics; this does not introduce
provider-identity deduplication. The unread held-row rule remains, and sidebar
counts exclude a read row held open. Aggregate scope is included in stale-response
fencing and invalidation routing. Definitive flag updates refresh filtered lists.

Validation uses temporary databases and synthetic IPC. `check-mail-list-layout.js`
covers persistence/preload, invalid preferences, keyboard and cancelled/foreign
DnD, account-bound exclusion/count parity, pagination, updates and stale replies.
`check-mail-layout-browser.js` runs Chromium DnD, sort, restart persistence,
keyboard/dialog controls, live flag counts, narrow layouts, rendered Features and
axe WCAG A/AA checks. Supply `MORROW_PLAYWRIGHT_MODULE`, `MORROW_AXE_MODULE` and
optionally `MORROW_CHROMIUM`; screenshots go to `MORROW_UI_OUTPUT` or the temporary
`morrow-mail-layout` directory. No provider sign-in, credential access or live
mail is used. Native Electron behavior remains unverified.
