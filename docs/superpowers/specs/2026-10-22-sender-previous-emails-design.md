# Reader — previous emails from sender (modal → reader window)

Design only. This document locks v1. It adds no runtime behavior and does not change the app version.

## Goal

While reading mail, the user can right-click the sender email address, open a modal listing previous messages from that address across all connected accounts, and click a row to open that message in an independent reader window.

The mailbox the user was reading stays where it is. The modal lists mail the providers return at that moment. Each chosen message opens beside the shell, the same way a compose window does, and more than one reader window may stay open.

## Locked decisions

- Scope is every connected account.
- The surface is a context menu that opens a modal list. v1 has no dedicated history window.
- The open target is an independent reader `BrowserWindow`. Multiple reader windows are allowed. There is no cap.
- Every time the modal opens, the host searches the providers. A local-cache-only result is not this feature.
- v1 is Approach A, specified below.

## Approach A

Approach A is the only v1 shape:

1. The hit target is the sender addr-spec in the reader header.
2. The menu item **Previous emails…** opens a modal `<dialog>` on the window that was clicked.
3. The host runs a parallel `from:` search, one per connected account, and the modal lists one merged page, newest first.
4. A row calls a new `reader:open` channel with that row’s `accountId` and local message id. The host opens `renderer/index.html?role=reader`.

These shapes are out of v1, recorded here so later work does not fold them into this design:

- A history `BrowserWindow` that owns the list.
- Pointing the shell’s folder, search box, or list filter at that sender.
- Serving the modal from `mail:searchLocal` or from mail already downloaded.
- A right-click target on `mailto:` links in the body.
- Reply, Reply All, or Forward from a history row without opening a reader window.

## What exists today

The shell reading pane renders From as one plain line. `renderReader` in `renderer/app.js` sets `p.meta` to `email.from`. A right-click anywhere in `#reader` (except inputs, text areas, selects, and links) reaches `onReaderContext`, which opens the organize menu for the whole message.

Server search is `mail:search` → `searchRemote` in `host/mail/engine.js`. That path walks accounts one after another, stops at one shared limit (`SEARCH_LIMIT` is 100), and fails the whole call on the first hard error. IMAP uses a text search (`findText` / Gmail `gmraw` with the raw needle). Outlook with a Graph token uses `searchGraph`, whose `$search` string is a quoted blob. Gmail with a Google token uses `searchGmail`, which passes `q` through. Hits are stored with `storeImapHits` or `rememberApiHit`, and the rows that come back have local ids. `mail:openEmail` loads one of those ids and `ensureBody` fills a missing body. The shell then marks the message read with `mail:markRead`.

`mail:searchLocal` searches the local index. The list filter does not call `mail:search`. Neither channel is the sender history search.

Compose already has the window pattern this reader copies. `host/compose-window.js` opens an unparented, non-modal `BrowserWindow` on `renderer/index.html?role=compose`. `renderer/compose-role.js` sets `data-window` before paint. `boot` in `renderer/app.js` returns into `bootComposeWindow` and does not subscribe to `mail:emailsUpdated`. Bounds cascade and are not written to `window-state.json`. `host/main.js` refuses an update install while any window other than the shell exists.

Account chips use `accountLabel`: the custom list label, otherwise `name`, then `name · email` when the name and the address both exist and differ.

Status text uses `showStatus`. Dialogs use `openDialog` / `closeDialog`, which call `showModal` and the existing motion helpers. `prefers-reduced-motion: reduce` stays in force.

## Sender address target

Parse the open message’s `from` before drawing the header.

- Collect every `<...>` token. When the header has none, the candidate is the whole trimmed header.
- Keep a candidate only when the entire token matches one ASCII addr-spec: `^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$` (case-insensitive) and the length is at most 254. That pattern already excludes spaces, quotes, backslashes, and angle brackets. An apostrophe is outside the pattern, so v1 has no OData escaping step.
- The menu and the search use the first kept addr-spec. A hit later in search matches when any kept addr-spec on that hit equals the query.
- A display name that merely contains an `@` is not an address. A non-ASCII addr-spec has no menu target in v1.

When the parse fails, the From line stays plain text and **Previous emails…** is absent. There is no disabled item.

When the parse succeeds, the From line is still `p.meta`:

- The display name, when the header has one, is a text node. It is not a hit target.
- The addr-spec is a `button type="button"` with class `sender-address`, `data-sender-address` set to the addr-spec, and accessible name `Previous emails from {addr-spec}`.
- A bare address is that button and nothing else.

The same header is used in the shell reading pane and in a reader window. `onReaderContext` returns without opening Organize when the event target is inside `.sender-address`. The address button’s `contextmenu` handler calls `preventDefault` and `stopPropagation`.

Primary click, Enter, and Space on the address button open the modal directly. Right-click opens the existing popup menu (`ensureOrganizeMenu`, `appendMenuAction`, `placeMenu`) with one item, **Previous emails…**, and that item opens the same modal. The menu’s accessible name is `Previous emails`. Opening it replaces any organize menu already on screen.

The body, `mailto:` links, the display name, and the rest of the reader header do not grow this item. Their current menus stay as they are.

## Modal

The modal is `<dialog id="sender-history">` in `renderer/index.html`. It is opened with `openDialog("sender-history")` and closed with `closeDialog("sender-history")`. It is not a `BrowserWindow`.

- From the shell, the dialog covers the main window.
- From a reader window, the same dialog in that page covers that reader window.

Title: `Previous emails`. Description: `From {addr-spec}`, using the casing parsed from the message. The heading is focused when the dialog opens (`tabindex="-1"`), so Enter does not activate the first row.

While the first search is in flight and no rows are painted, the dialog shows the existing spinner (`.page-busy-spin`) and the text `Searching…`, with `aria-busy="true"` on the dialog.

Esc closes the dialog through the `cancel` event and `closeDialog`, so reduced-motion behavior matches other dialogs. A click whose target is the dialog element itself (the backdrop) closes it the same way. A click inside the dialog does not. Closing the dialog does not close reader windows that are already open.

The shell’s Escape path already returns when a dialog is open (`onSelectionKey`). That guard stays, so dismissing this dialog does not also clear the message selection.

Opening the menu again while the dialog is already open replaces the address, drops the in-memory page, and starts a new search in that same dialog. `openDialog` returns immediately when the dialog is open, so this refresh must not depend on calling it a second time. Dialogs do not stack.

The shell stays on its current account, folder, selection, and open message. This feature does not call `mail:search`, `mail:searchLocal`, or the list filter.

Search and `reader:open` do not go through `guard` and do not set `state.busy`. A long search must not freeze star, archive, or the rest of the shell once the dialog is closed. Failures still reach `showStatus` as errors.

Each open and each Load more bumps a generation counter. A response from an older generation is ignored.

Icons in this dialog, when any are added, use a `viewBox` of `0 0 24 24`, `currentColor`, and Feather or Lucide paths. Decorative icons are `aria-hidden="true"`. The visible label or an `aria-label` remains.

## Search channel

Add `mail:searchSender`. Allow it in `renderer/preload.js` beside `mail:search`. Handle it in the host dispatch next to `mail:search`. Leave `searchRemote` unchanged.

The renderer calls it with:

- `address` — the parsed addr-spec
- `preferAccountId` — the open message’s `accountId`
- `currentId` — the open message’s local id
- `currentMessageId` — the open message’s RFC Message-ID, or an empty string
- `limit` — 50
- `resume` — omitted on a fresh open; the previous response’s `resume` on Load more

A fresh open always omits `resume`. Closing the dialog discards it. The next open searches the providers again.

The host checks the address with the same addr-spec rule. A bad address returns `fail("invalid", "That sender has no email address.")`. The dialog stays open, the status line shows that message, and the dialog body says `Previous mail could not be loaded.`

A well-formed address returns `ok` even when every account fails. Account failures are data. The renderer paints them. One account’s failure does not reject the invoke.

The host searches every row from `accountViews()`, including an account that already needs reauthentication. Account order is that list’s order. Each account runs in its own task that catches and returns a status object. `Promise.all` waits for every task. One account does not wait for another, and a throw inside a task becomes that account’s `error` instead of rejecting the batch.

An account that already has `auth_error` returns status `auth` without a provider call. An account already inside the rate-limit gate returns status `rate_limit` without a provider call. A new rate-limit response uses the existing `noteRateLimit` path, so that account’s sync pauses the way `searchRemote` already pauses it. Other accounts continue.

Persisted hits use `storeImapHits` and `rememberApiHit`, so each painted row has a local id that `mail:openEmail` can load. The search does not broadcast `mail:emailsUpdated`, does not change the open folder, and does not move the shell’s reading pane.

### Provider query

The query is an exact addr-spec match. Comparison is case-insensitive. The host sends the address in lowercase. After hits return, a hit is kept only when `shared/sender-history.js` parses its From header and one of those addr-specs equals the query. Hits that do not parse are dropped. This post-filter is what makes IMAP `FROM` and Gmail `from:` exact, because both can match a substring or a display name.

Providers:

- Gmail with a Google organize token: `searchGmail` with `q` set to `from:"{address}"`. Paging uses the `pageToken` `gmailSearchUrl` already accepts. The cursor is that token.
- Outlook with a Microsoft organize token: a new Graph request, not `graphSearchUrl`. `$filter` is `from/emailAddress/address eq '{address}'`. `$orderby` is `receivedDateTime desc`. `$top` is the page size. `$select` lists the fields `graphHit` already reads. The request sends `ConsistencyLevel: eventual`. The cursor is `@odata.nextLink` only when its host is `graph.microsoft.com` and its path starts with `/v1.0/me/messages`. Any other link is ignored and the account is exhausted. A Graph error stays that account’s `error` (or `auth` / `rate_limit` when the status says so). The host does not fall through to `$search` or to a body search.
- Every other connected account, including Gmail without a Google token and Outlook without a Graph token: IMAP. A Gmail profile sends `X-GM-RAW` with needle `from:{address}` to the first `GMAIL_ALL_PATHS` mailbox that accepts `SEARCH`, so the inbox copy and the All Mail copy are not two hits. Any other profile uses imapflow `{ from: address }` and walks `db.foldersFor` in listed order, highest UIDs first inside a folder, at most 50 UIDs per folder search. One invoke searches at most 4 folders and then sorts the fetched hits by internal date. The cursor is `{ folderIndex, beforeUid }`. Later folders wait for Load more. A malformed cursor restarts that account at the first folder instead of failing the modal. Descending UID is the provider order inside a folder, the same approximation `findText` already uses; the merge then sorts fetched hits by date. v1 does not download every UID in a folder to prove date order.

Gmail API and Graph refill until the account has 50 post-filter matches or the provider is exhausted, with at most 4 provider requests per account per invoke. A short provider page marks that account exhausted. IMAP uses the 4-folder cap above for the same bound.

Status values, one per account, in sidebar order:

| Status | Chip | Retry |
| --- | --- | --- |
| `ok` | none | no |
| `error` | the host’s `remote.explain` text | yes |
| `auth` | `Sign in again` | yes |
| `rate_limit` | `Paused for rate limit` | yes |
| `unavailable` | `Unavailable` | no |

`unavailable` is only for a mailbox whose search command is unsupported (IMAP `NO` / unsupported `SEARCH`, or Graph reporting that this filter is unsupported). A missing secret, a 401, or `needsReauth` is `auth`. A transport failure is `error`.

### Merge, sort, dedupe, paging

Pure functions live in `shared/sender-history.js` with no I/O and no Electron. `SENDER_PAGE_SIZE` is 50. The host runs the provider calls, then this merge.

Inputs are the per-account exact hits (newest first), plus `resume`:

- `buffers` — unshown hit summaries from the last page, keyed by `accountId`
- `seenIds` — local ids already shown or dropped as duplicates
- `seenRfc` — normalized Message-IDs already shown or dropped

Steps:

1. Per account, take that account’s buffer, then its new hits. Drop any hit whose id is in `seenIds` or whose normalized Message-ID is in `seenRfc`.
2. Pool the accounts.
3. Dedupe by RFC Message-ID. Normalization trims, strips one surrounding pair of `<>`, and lowercases. An empty Message-ID does not collapse. The surviving copy is the `preferAccountId` row when that account returned one; otherwise the copy with the lowest `accountViews()` index. Losing ids and that Message-ID join the seen sets so a later page cannot bring the duplicate back.
4. Sort the pool by date descending. The date key is `listSortTs` when it is a finite number, otherwise `Date.parse(date)`. Invalid dates sort after valid ones. Ties break by preferred account, then account order, then `id` ascending.
5. Emit the first 50. Whatever remains returns to that account’s buffer.
6. The response is exhausted when every account is provider-exhausted and every buffer is empty.

A row’s `current` flag is true when its local id equals `currentId`, or its normalized Message-ID equals the open message’s normalized Message-ID.

Gmail API and Graph each contribute their newest 50 exact hits. The first merged page is the newest 50 of that union, plus any IMAP hits fetched under the folder cap, sorted by the same date key. Load more sends the returned `resume` and appends the next 50. The buffer keeps hits that were fetched and then lost the cut, so a quieter account’s newer mail is still in line when another account filled the page.

Response shape:

- `rows` — up to 50 display rows
- `resume` — buffers, seen ids, seen Message-IDs, and per-account cursors
- `exhausted` — boolean
- `accounts` — `{ accountId, email, label, name, status, message }` in sidebar order

Display fields on each row: `id`, `accountId`, `subject`, `date`, `listSortTs`, `unread`, `messageId`, `current`. The chip text is `accountLabel` applied to the account fields on the response, so a rename that exists only on the account row still shows.

## Modal rows

Each row is a button. The visible fields, in order, are the date, the subject, the account chip, and the read state. The date uses `toLocaleString()`, the same call as the reader header. An invalid date leaves the date blank. An empty subject reads `(no subject)`.

Unread rows use the message list’s unread subject weight. Read rows use the read weight. The row’s accessible name includes `Unread` or `Read`. The account chip is text, not a button.

When `current` is true, the row also shows the text `Current` and sets `aria-current="true"`. The row still opens a reader window.

Clicking a row, or pressing Enter or Space on it, calls `reader:open` with `{ accountId, messageId: id }`. The dialog stays open. A second click opens a second reader window. The shell’s open message does not change.

**Load more** sits under the list. It is hidden when `exhausted` is true. While the next page is in flight the button is disabled and `aria-busy="true"`. Existing rows stay. A failed Load more toasts and leaves those rows. New per-account failures add chips.

Empty and failure copy:

- Every searched account is `ok` and `rows` is empty: `No earlier mail from {address}.`
- At least one account failed and `rows` is empty: the chips, plus `Previous mail could not be loaded.`
- Some rows and some failures: the rows, with a chip above the list for each failed account.

Retry on a chip searches that account again and merges by the same function, using the current resume. Successful accounts are not fetched again. Retry does not close the dialog and does not start OAuth. Reconnecting an account stays on the existing account UI.

Toasts, via `showStatus` as an error, one per action:

- Any `auth` in the batch: `Sign in again to search {label}.` using the first such account’s `accountLabel`.
- Any `rate_limit` and no auth: `Paused for rate limit`.
- Any `error` and neither of the above: that account’s message.
- `unavailable` alone does not toast. The chip is the notice.
- Chips still render for every failed account when a toast also fires.

## Reader window

`host/reader-window.js` follows `host/compose-window.js`.

- Channels: `reader:open`, `reader:pullSeed`.
- `reader:open` accepts `{ accountId, messageId }`. Both are strings, at most 200 characters, with no control characters. Anything else throws `That message could not be opened.` The host does not open a window for a bad seed.
- The window is not parented and not modal. The shell stays usable after the dialog closes, and a reader window does not hide with the shell.
- Several reader windows may exist. There is no cap. Cascade uses the compose step: shell bounds plus 48px plus `28px * (open reader count % 6)`. Compose windows are not part of that count. Size is 960×760, minimum 640×480. Missing shell bounds omit `x` and `y` and let the system place the window.
- Bounds are not written to `window-state.json`. The window does not change the shell’s zoom. It opens at zoom level 0.
- The page is `renderer/index.html?role=reader`, or `morrow://local/index.html?role=reader` when the host is in asar mode. The same preload and the same `webPreferences` as compose are used.
- `renderer/compose-role.js` also sets `document.documentElement.dataset.window = "reader"` when the query role is `reader`, before first paint.
- Title is `{subject or "Message"} — Morrow Mail`, with the subject trimmed and cut at 180 characters, the same cut compose uses. The window updates the title after `mail:openEmail` returns.
- Close closes that window immediately. There is no discard confirm and no `preventDefault` on close. The macOS hide-on-close behavior stays on the main window only.
- A main-frame load failure closes the window, as compose does, and the host tells the opener `reader:openFailed` with `That message could not be opened.` The opener toasts it when that page is still alive. The dialog stays open.
- `reader:open` returning a failure toasts the message and leaves the dialog open. No empty window remains.
- The updater rule is unchanged: any window other than the shell blocks install. A reader window counts. Quit-with-scheduled-mail is unchanged. A reader window holds no draft, so it adds no quit prompt.
- Zoom and Cmd/Ctrl+N stay on the application menu and are delivered to the shell.

`boot` treats `role=reader` the way it treats compose: `bootReaderWindow` runs and the shell boot does not. The reader window loads theme and shell prefs, loads accounts, pulls the seed, and calls `mail:openEmail`. It does not call `mail:setOnline`, does not subscribe to `mail:emailsUpdated`, and does not call `host:updateGetState`.

The page shows one message: subject, the From line (with the same address button), date, To, Cc, the existing sanitized HTML or plain body, the remote-image gate, and the existing attachment card (save, open, preview). It does not show the thread stack, the shell toolbar, Organize, labels, snooze, translate, or suggest.

Until `mail:openEmail` resolves, the page shows `Loading message…` with the same pending spinner the shell uses. A failed open shows the error in the page and toasts it. The window stays open so the user can close it. An unread message is marked read with `mail:markRead` after a successful open, same as `openMessage`. A mark-read failure toasts the shell’s existing sentence, `Message opened, but marking it read was not confirmed. Other clients may still show it unread.`, plus the error text, and leaves the message on screen. The modal does not repaint its rows; the next open of the modal searches again.

CSS under `html[data-window="reader"]` hides the rail, the workspace header, and the list column, and lets the reader fill the window. The shell’s own reader layout is unchanged when `data-window` is absent.

### Reply

The reader window has **Close** and **Reply**. Reply calls the existing `openReaderCompose("reply")` → `presentCompose` → `compose:open`, after accounts are loaded so the seed has a From address. Reply All, Forward, and the R / A / F shortcuts are not wired in this window. Close calls `window.close()`.

Reply is in v1 because `presentCompose` is already the compose-window path. No second compose host is added.

## Errors and edges

| Case | Result |
| --- | --- |
| No parseable sender address | No address button and no menu item |
| Account search unsupported | Chip `Unavailable` for that account; other accounts still list |
| Auth failure or existing `auth_error` | Chip `Sign in again`, toast, Retry. Tokens are left as they are |
| Rate limit | Chip `Paused for rate limit`, toast, Retry. That account’s sync pause follows today’s rate-limit path |
| Same Message-ID on two accounts | One row. The open message’s account wins; otherwise the earlier sidebar account wins |
| Rows with no Message-ID | Kept as separate rows |
| `reader:open` or page load fails | Toast. The dialog stays open. A half-created window is closed |
| Load more fails | Toast. Rows already listed stay. The dialog stays open |
| User closes the dialog while a search is in flight | The generation check drops the response. Reader windows already opened stay |

## Testing

`npm run check` (`node scripts/check-boot-path.js`) gains offline coverage, the same way it already loads `host/compose-window.js` and asserts its channels:

- Addr-spec parse: `Ada Lovelace <Ada@Example.com>` → `Ada@Example.com`; a bare address passes; a display name that contains an `@` and no angle-addr fails; a token with a quote, a space, or no dot in the domain fails.
- Query strings: Gmail `from:"ada@example.com"`; Graph filter `from/emailAddress/address eq 'ada@example.com'`; IMAP / Gmail raw needle `from:ada@example.com`. An apostrophe in a token fails the addr-spec pattern.
- Merge: two accounts with interleaved dates come out newest first, capped at 50.
- Dedupe: the same Message-ID keeps `preferAccountId`; when that account is absent, the lower sidebar index remains; empty Message-IDs are not merged; losing ids stay in `seenIds`.
- Current: a matching local id or a matching Message-ID sets `current`.
- Resume: a buffered hit that lost the first cut of 50 is the first row of the next page and is not skipped.
- Partial failure: one account’s `error` leaves the other account’s rows in the list and records the chip status.
- `unavailable` is a status, not a throw.
- Reader-window helpers, with no Electron: title cut, seed rejection, cascade math (`x`/`y` at shell origin + 48 + 28 for index 1; width 960; minimum height 480), and `CHANNELS`.
- Wiring assertions: `host/main.js` registers the reader host before `attachIpc`, the preload lists `reader:open` and `reader:pullSeed`, and `mail:searchSender` is in the preload allowlist and the engine dispatch. `package.json` version stays `0.2.26`.

UX fixture coverage belongs in `scripts/check-ux-renderer.cjs` (synthetic IPC, no production host, no network), asserting visible behavior:

- The address button is the only node that offers **Previous emails…**. A right-click on the subject or the display name does not.
- The dialog lists merged fixture rows newest first, with date, subject, account chip, unread weight, and `Current` on the open id.
- An empty payload shows `No earlier mail from {address}.` A payload with one failed account and one row shows the row and the chip.
- Activating a row invokes `reader:open` with that `accountId` and message id. The dialog is still open afterward.
- Esc closes the dialog and does not send a window-close for a reader.
- A rejected `reader:open` leaves the dialog open and surfaces the error string.

`scripts/check-mail-reader.js` covers the header target if the fixture asserts DOM built by `renderReader`. `scripts/check-compose-window.js` is the model for an Electron reader-window smoke check if one is added; it is not required for the pure helper checks above.

## Files v1 is expected to touch

- `shared/sender-history.js` — parse, query text, merge, page, dedupe
- `host/mail/provider-api.js` — Graph `from` address URL
- `host/mail/remote.js` — IMAP `FROM` / Gmail `from:` fetch beside `findText`
- `host/mail/engine.js` — `mail:searchSender`
- `host/reader-window.js` — reader `BrowserWindow`
- `host/main.js` — register the reader host the way compose is registered
- `renderer/preload.js` — allow the new channels and expose `openReaderWindow` / `pullReaderSeed`
- `renderer/compose-role.js` — set `data-window="reader"`
- `renderer/index.html` — `<dialog id="sender-history">`
- `renderer/app.js` — address target, menu, dialog, `bootReaderWindow`
- `renderer/app.css` — dialog rows and `html[data-window="reader"]`
- `scripts/check-boot-path.js` and `scripts/check-ux-renderer.cjs` — the checks above

No version bump, no release notes, and no change to `mail:search` or `mail:searchLocal`.
