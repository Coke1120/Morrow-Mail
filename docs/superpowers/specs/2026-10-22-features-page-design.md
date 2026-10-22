# Features page — rename Shortcuts; tabs Features / Shortcuts / CLI

Design spec for the first-party shell in `renderer/`. This document is the spec only. The implementation that follows it is a separate change and is the one that edits the shell, checks, and the help docs named below.

## Goal

Rename the current Shortcuts page to **Features**. Inside that one page, three tabs: **Features** (default), **Shortcuts**, **CLI**.

The Features tab shows a maintained, read-only catalog of Morrow Mail’s distinctive capabilities. The Shortcuts tab keeps today’s keyboard list. The CLI tab keeps today’s copy-only command rows.

## Decisions

These are locked.

| Topic | Decision |
| --- | --- |
| Catalog maintenance | Hand-maintained file in the app. Nothing is generated from the README or from other docs. |
| Default tab | Features, on every visit. |
| Item interaction | Read-only. v1 has no deep links and no Try actions. |
| Shape | Approach A: one page, three tabs, plus a catalog module. |
| Rail icon | Keep the current keyboard icon. |
| Rail button id | Keep `id="rail-shortcuts"` in v1. |
| Last tab | Do not remember it. No `localStorage` key. |

Approach B, three rail entries, is rejected. The rail foot is already this button, Debug log, and About & updates. Splitting help into three buttons crowds that foot and presents the checkout CLI as its own product surface.

Approach C, generating cards from `README.md` or `docs/INDEPENDENT_UI.md`, is rejected. Those files describe operator and agent behavior. They are not a curated list of product capabilities.

`docs/adr/2026-10-21-shortcuts-cli.md` and `docs/adr/2026-10-21-mail-shortcuts.md` stay as written. Copy still does not run a command, and there is still no `morrow` command. This spec moves that CLI section under a tab.

## Current page

The shell is vanilla DOM. `renderer/index.html` loads classic scripts. There is no `ui/` directory.

Today the rail foot button `#rail-shortcuts` is labeled Shortcuts and uses the keyboard SVG (rounded rectangle, key dots, space bar). It sits directly above `#rail-log`. `showShortcuts()` calls `showPrimary("shortcuts", "shortcuts-panel")`, which sets `state.view` and `.workspace[data-view]` to `shortcuts` and paints the keyboard list. `paintShortcuts()` also calls `paintCli()`.

The section `#shortcuts-panel` is one scroll: kicker Help, heading Shortcuts, `#shortcuts-note`, `#shortcuts-list`, then a Command line heading `#cli-title`, `#cli-note`, `#cli-copy-status`, and `#cli-list`. `shortcutCatalog()` returns 15 rows. Chords use ⌘ on macOS and Ctrl on Windows and Linux. `cliCatalog()` is the checkout, package, verify, bot-bridge, and Tailscale Serve commands already documented. Each Copy button writes the command with `navigator.clipboard.writeText` and sets the status to `Command copied. Morrow did not run it.` A failed copy sets `Could not copy. Select the command and copy it.`

`.workspace[data-view="shortcuts"]` hides `#search-form` and lets the leading cluster size to its content, same as Calendar, Brain, and Debug log.

The app does not read `location.hash` today. `mailShortcut` handles reply, reply all, and forward only when `view === "mail"`. `onShellKey` still moves the message list on ArrowUp, ArrowDown, and Enter when focus is outside a field and no dialog is open.

Settings, Agent, and Bot access already implement `role="tablist"` tabs. ArrowLeft, ArrowRight, Home, and End move the selected tab and follow focus. Bot sections call `stopPropagation` on those keys. Settings remembers the open fold for the renderer session. This page does not copy that memory.

## Architecture

### Rail and route

Visible name becomes Features in all four places on `#rail-shortcuts`: `.nav-label`, `aria-label`, `title`, and `data-label`. The keyboard SVG stays, including its `viewBox="0 0 24 24"` and `aria-hidden="true"`. The button stays immediately before `#rail-log`.

The view name becomes `features`.

- `markRail` maps `features` to `rail-shortcuts`.
- `showPrimary`’s pane list uses `features-panel` where it now lists `shortcuts-panel`.
- At the start of `showPrimary`, `view === "shortcuts"` or pane id `shortcuts-panel` is rewritten to `view === "features"` and pane id `features-panel` before the rail and panes update. After that pane swap, the rewritten call runs `paintFeatureCatalog()`, `paintShortcuts()`, `paintCli()`, and `showFeaturesTab("catalog")`, so a leftover `showPrimary("shortcuts", "shortcuts-panel")` opens the same page as the rail. `showFeatures()` passes `"features"` and `"features-panel"`, so it does not take this rewrite branch and does not paint twice.
- `function showShortcuts() { showFeatures(); }` stays as an alias. The rail click listener calls `showFeatures`.
- CSS selectors `.workspace[data-view="shortcuts"]` become `.workspace[data-view="features"]` in both rules (leading width, and hiding `#search-form`). One view name is enough.

`#features-panel` replaces `#shortcuts-panel` and keeps that section’s padding and overflow. `aria-label` is `Features`. The page head kicker stays `Help`. The page heading is `<h2 id="features-title">Features</h2>`.

Direct children of `#features-panel` do not use the class `motion-block`, so `showPrimary` takes the existing `revealPanel` branch. Cards themselves do not animate. `prefers-reduced-motion` stays honored through the existing `motion.reduced()` checks.

### Tabs

A tab strip `#features-tabs` with `class="features-tabs"`, `role="tablist"`, and `aria-label="Features sections"` sits under the page head. Use a separate class so a Brain tweak does not restyle this page. Give `.features-tabs` these values: `position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 2px; margin: 8px 0 6px; padding: 2px; border-radius: 10px; background: var(--hover); box-shadow: 0 0 0 8px var(--paper)`. Each tab button uses `flex: 1 1 72px; height: 28px; border: 0; border-radius: 8px; background: transparent; color: var(--ink-mid); font-size: 13px; font-weight: 600`. The selected tab (`aria-selected="true"`) uses `background: var(--paper); color: var(--ink); box-shadow: inset 0 -2px 0 var(--accent-ink)`.

| Order | Visible label | Button id | `data-features-tab` | Panel id |
| --- | --- | --- | --- | --- |
| 1 | Features | `features-tab-catalog` | `catalog` | `features-pane-catalog` |
| 2 | Shortcuts | `features-tab-shortcuts` | `shortcuts` | `features-pane-shortcuts` |
| 3 | CLI | `features-tab-cli` | `cli` | `features-pane-cli` |

Each button is `type="button"`, `role="tab"`, with `aria-controls` pointing at its panel. Each panel is `role="tabpanel"`, `aria-labelledby` pointing at its tab, and `tabindex="0"`. The selected tab has `aria-selected="true"`, `aria-current="true"`, and `tabindex="0"`. The other tabs have `aria-selected="false"`, `aria-current="false"`, and `tabindex="-1"`. Unselected panels have the `hidden` attribute.

DOM order inside the section is catalog pane, shortcuts pane, CLI pane, so `#shortcuts-list` still precedes `#cli-list`, and `#cli-list` still precedes `#log-panel`.

`wireFeaturesTabs()` follows `wireBotSections()`: click selects that tab and focuses it. On ArrowLeft, ArrowRight, Home, and End, when the event target is one of these tabs, the handler calls `preventDefault` and `stopPropagation`, moves with wrap (ArrowLeft from Features lands on CLI, ArrowRight from CLI lands on Features), selects that tab, and focuses it. Keys apply only when focus is already on a tab. Focus inside a pane does not change tabs.

Tab changes show the newly selected pane with `motion.fadePane(panel, "y")` when that function exists and `motion.reduced()` is false. Otherwise the pane is shown by clearing `hidden` with no animation.

`showFeaturesTab(name)` accepts only `catalog`, `shortcuts`, and `cli`. Any other name returns without changing the current tab.

### Shortcuts pane

Keep the keyboard list as it works today.

```html
<div id="features-pane-shortcuts" role="tabpanel" aria-labelledby="features-tab-shortcuts" tabindex="0" hidden>
  <div class="space-head">
    <div>
      <h2 id="shortcuts-title">Shortcuts</h2>
    </div>
  </div>
  <p class="hint" id="shortcuts-note"></p>
  <ul id="shortcuts-list" class="shortcut-list" aria-labelledby="shortcuts-title"></ul>
</div>
```

`paintShortcuts()` fills `#shortcuts-note` and `#shortcuts-list` and does not call `paintCli()`. `shortcutCatalog()`, `shortcutNote()`, and the 15-row list stay as they are. Single-letter reading shortcuts still require `view === "mail"`.

`onShellKey` returns immediately when `state.view === "features"`, so ArrowUp, ArrowDown, and Enter on this page do not move or activate the hidden message list. Other views keep their current `onShellKey` behavior.

### CLI pane

Keep the copy-only rows.

```html
<div id="features-pane-cli" role="tabpanel" aria-labelledby="features-tab-cli" tabindex="0" hidden>
  <div class="space-head">
    <div>
      <p class="space-kicker">Command line</p>
      <h2 id="cli-title">CLI</h2>
    </div>
  </div>
  <p class="hint" id="cli-note"></p>
  <p id="cli-copy-status" class="hint" role="status"></p>
  <ul id="cli-list" class="shortcut-list cli-list" aria-labelledby="cli-title"></ul>
</div>
```

`cliCatalog()`, `cliNote()`, `copyCliCommand()`, and `wireCliCopy()` stay as they are. Copy writes the command string and does not spawn a process. The status strings stay `Command copied. Morrow did not run it.` and `Could not copy. Select the command and copy it.`

Drop the stacked-page divider from `.cli-head` (`margin-top`, `padding-top`, and `border-top`). Those rules existed because CLI sat under the keyboard list on one scroll. The pane’s own heading is the separator now.

`showFeatures()` paints all three panes while the inactive ones stay in the DOM:

1. `showPrimary("features", "features-panel")`
2. `paintFeatureCatalog()`
3. `paintShortcuts()`
4. `paintCli()`
5. `showFeaturesTab("catalog")`

Painting hidden panes is required so the Shortcuts and CLI lists exist before the user selects those tabs.

### Catalog module

Path: `renderer/features-catalog.js`.

`renderer/index.html` loads it as a classic script immediately before `./app.js`:

```html
<script src="./features-catalog.js"></script>
```

The compose window loads the same HTML, so the catalog script loads there too. The file does not touch the DOM. `bootComposeWindow()` does not open this page.

Use the same UMD wrapper as `shared/mailbox-roles.js`, so the browser gets `window.morrowFeaturesCatalog` and Node checks can `require` the file:

```javascript
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.morrowFeaturesCatalog = api;
})(typeof window === "object" ? window : globalThis, function () {
  return { items: [ /* the Seed catalog array */ ] };
});
```

The file does not read the DOM, does not assign anything except that export, and does not throw while constructing the array. The public value is `{ items }` where `items` is an array of `{ id, title, blurb, category }`. `category` may be omitted. v1 objects have no `href`, `action`, `icon`, or `since`. Extra keys are ignored.

Normalization lives in `renderer/app.js`, not in the catalog file, so a bad row cannot take down the script:

- `normalizeFeatureCatalog(value)` returns `[]` when `value` is not an array.
- A row is kept only when it is a non-null object and not an array, `id` is a string matching `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, and `title` is a string whose trim is non-empty.
- `title` and `blurb` are trimmed. A missing or non-string `blurb` becomes `""`. The row is still kept.
- `category` is the trimmed string when it is a non-empty string. Otherwise the stored category is `""`.
- The first row wins for a repeated `id`. Later duplicates are dropped.
- Returned objects have only `id`, `title`, `blurb`, and `category`, in input order.
- `groupFeatureCatalog(items)` walks that normalized list and returns an array of `{ heading, items }`. Non-empty categories form groups in first-seen order, with `heading` equal to that category text. Rows with `category === ""` append to a final group whose `heading` is `Other` when at least one categorized row exists. When every row has an empty category, the result is one group whose `heading` is `""` and the renderer omits the `<h3>`. An authored category whose text is `Other` is that same final group.

`paintFeatureCatalog()` reads `window.morrowFeaturesCatalog`, passes `catalog && catalog.items` through `normalizeFeatureCatalog`, and renders inside `#features-catalog` with `textContent` only. It then sets `#features-empty` hidden when the rendered card count is greater than zero, and visible when the count is zero. The static markup includes the empty sentence so a paint that never runs still shows it:

```html
<div id="features-pane-catalog" role="tabpanel" aria-labelledby="features-tab-catalog" tabindex="0">
  <div id="features-catalog"></div>
  <p id="features-empty" class="hint">No features listed</p>
</div>
```

The empty sentence is exactly `No features listed`.

A categorized group is a `<section class="feature-group">` with an `<h3>` of the category text and a `<ul class="feature-cards">`. The flat uncategorized list is that same `<ul>` with no `<h3>`. Each card is `<li class="feature-card">` containing `<h4 class="feature-card-title">` and `<p class="feature-card-blurb">`. The category label is the group heading. Cards do not repeat it.

Cards use a grid: `repeat(auto-fill, minmax(16rem, 1fr))`, 12px gap, 8px radius, 1px solid `var(--line)`, padding 14px 16px, transparent background. Group headings use the `.shortcut-group` type style: 12px, weight 700, letter-spacing 0.04em, uppercase, `color: var(--muted)`. Blurbs use the normal text color, wrap fully, and have no line clamp and no ellipsis. Authors keep each blurb to one or two short sentences so it wraps to about two lines at 16rem. Cards use `cursor: default`, are not buttons, have no `href`, and have no click listener. Text selection stays the browser default. v1 cards have no icons.

Skipped rows are not written to the debug log.

### Seed catalog

v1 ships this array, in this order. Titles and blurbs are copied exactly. Every row is a capability that already exists in the shell.

```json
[
  {
    "id": "email-brain",
    "title": "Email Brain",
    "category": "Agent",
    "blurb": "Profile, categories, skills, and inbox rules built from your mail. Skills can draft a reply or propose a move. You still press Send."
  },
  {
    "id": "agent-triage",
    "title": "Agent triage",
    "category": "Agent",
    "blurb": "Files recent inbox mail into your Brain categories and stacks todos. Reply opens a compose window. Done and Dismiss stay on this computer."
  },
  {
    "id": "compose-window",
    "title": "Compose in its own window",
    "category": "Mail",
    "blurb": "New mail, reply, forward, and drafts open in a separate window, so the mailbox stays usable. Closing that window does not send."
  },
  {
    "id": "local-search",
    "title": "Search on this computer",
    "category": "Mail",
    "blurb": "Toolbar search reads subject, from, and body already synced to this computer."
  },
  {
    "id": "schedule-send",
    "title": "Send later",
    "category": "Mail",
    "blurb": "Schedule send keeps the message on this computer and delivers it while Morrow is open. Quitting with a pending send asks you first."
  },
  {
    "id": "out-of-office",
    "title": "Out of Office",
    "category": "Mail",
    "blurb": "After you confirm, Settings writes a Gmail vacation reply, a Microsoft automatic reply, or an IMAP sieve script. Morrow does not send those replies itself."
  },
  {
    "id": "inbox-rules",
    "title": "Inbox rules",
    "category": "Mail",
    "blurb": "Gmail filters and Outlook rules save on the provider after you grant access. Other accounts store the rule here and apply it to new Inbox mail."
  },
  {
    "id": "multi-account",
    "title": "Multiple mailboxes",
    "category": "Accounts",
    "blurb": "Connect Google, Microsoft, and IMAP mailboxes and switch among them. All Account Mail lists downloaded Inbox mail from every account."
  },
  {
    "id": "bot-bridge",
    "title": "Bot bridge",
    "category": "Accounts",
    "blurb": "An optional loopback API lets a bot read cached mail and propose drafts. It stays off until you turn it on. Opening a proposal does not send it."
  },
  {
    "id": "calendar",
    "title": "Calendar",
    "category": "Calendar",
    "blurb": "Month view for Google Calendar or Microsoft Graph when that account has calendar access. Create, edit, and delete events on that page."
  },
  {
    "id": "in-app-updater",
    "title": "In-app updates",
    "category": "Updates",
    "blurb": "About & updates checks for a release. Restart and install applies a downloaded update once every compose window is closed."
  }
]
```

Displayed groups, from first-seen categories: Agent, Mail, Accounts, Calendar, Updates.

Changing the catalog later means editing this file. Ids stay stable once shipped. Renaming an id updates the boot check that lists them.

### Deep links

Rail clicks do not write `location.hash`. Tab changes do not write it. Leaving the page does not clear `#features`. A later reload with that hash opens Features again.

`applyFeaturesHash()` runs for the shell only.

- `#features` calls `showFeatures()`.
- `#shortcuts` calls `showFeatures()`, then `history.replaceState(null, "", location.pathname + location.search + "#features")`. `replaceState` does not fire `hashchange`.
- Any other hash, including an empty hash, is left alone. An empty hash leaves the initial mail view in place.

Register the listener in `wire()` beside the rail click listener, on `window` `hashchange`. Call `applyFeaturesHash()` once at the end of the non-compose `boot()` path, after `await loadAccounts()`, so account loading cannot cover the requested page. `boot()` returns before `wire()` when `isComposeWindow()` is true, and `bootComposeWindow()` does not call `applyFeaturesHash()`.

## Data flow and UX

Tab state is a renderer variable for the current visit only. `showFeatures()` always ends on `showFeaturesTab("catalog")`. That includes opening the page from the rail, calling `showShortcuts()`, following `#shortcuts` or `#features`, and clicking the rail button again while the page is already open. Switching to Shortcuts or CLI and then going to Mail, Calendar, Brain, Debug log, or another surface, then coming back, shows the Features tab again.

The Features tab is a catalog of cards. Each categorized group shows its category as the heading, then cards with a title and the full blurb. The Shortcuts tab is the current keyboard list and its platform note. The CLI tab is the current command list. Copy copies the command.

The page heading stays Features on every tab. The Shortcuts and CLI panes keep their own `h2` so the existing list labels still point at `#shortcuts-title` and `#cli-title`.

An empty catalog shows `No features listed` in the Features pane. The tab strip, Shortcuts pane, and CLI pane still work.

## Error handling and edges

| Case | Result |
| --- | --- |
| `features-catalog.js` missing, failed to parse, or `window.morrowFeaturesCatalog` absent | Features pane shows `No features listed`. Shortcuts and CLI still paint. Boot of `app.js` continues because a failed classic script does not stop the next script tag. |
| `items` missing or not an array | Same empty state. |
| Every row invalid, or `items` is `[]` | Same empty state. |
| One bad row among valid rows | That row is skipped. The valid cards render. |
| Duplicate `id` | The first row is shown. |
| `#shortcuts` | Features page, Features tab, hash replaced with `#features`. |
| `#features` | Features page, Features tab, hash unchanged. |
| Compose window (`?role=compose`) | Hash is ignored. The catalog script still loads with `index.html`. The compose surface does not gain this page. |
| CLI Copy | Unchanged success and failure strings. The command is not run. |
| `view` is `features` or `shortcuts` for `mailShortcut` | Reply, reply all, and forward stay inactive, because those keys require `view === "mail"`. Command chords that already work outside mail, such as New Mail, stay as they are. |

`normalizeFeatureCatalog` and `groupFeatureCatalog` do not throw on hostile values (`null`, numbers, objects without the fields). `paintFeatureCatalog` wraps the read in `try/catch` and treats a throw as an empty list.

## Testing

The implementation updates checks to the new structure. It does not weaken them.

`npm run check` (includes `scripts/check-boot-path.js`):

- `#rail-shortcuts` remains immediately before `#rail-log`. Its visible label and accessible name are Features. The keyboard SVG is still inside the button.
- HTML contains `#features-panel`, `#features-tabs`, the three tab ids, `#features-title`, `#features-empty` with the sentence `No features listed`, and `#features-catalog`. It does not contain `id="shortcuts-panel"`.
- The catalog script tag appears before `./app.js`.
- `#shortcuts-list` still precedes `#cli-list`, and `#cli-list` still precedes `#log-panel`. `aria-labelledby="shortcuts-title"` and `aria-labelledby="cli-title"` remain.
- The `showPrimary` pane list contains `features-panel` and does not contain `shortcuts-panel`.
- `require` of `renderer/features-catalog.js` returns `items` whose ids are exactly the seed sequence above. Each seed row’s `title`, `blurb`, and `category` match this spec.
- `normalizeFeatureCatalog` covers a non-array, a row with a bad id, a blank title, a duplicate id, and a non-string blurb.
- `groupFeatureCatalog` covers first-seen category order, a trailing `Other` group when a row has no category, and a headingless group when none of the rows have a category.
- `shortcutCatalog("Win32").length` stays 15. Platform notes still mention Reload and Zoom. `cliCatalog()` still contains the current `npm install`, `npm start`, `npm run check`, `bridge.describe`, `mail.send`, and `tailscale serve status --json` rows.
- `paintShortcuts` does not call `paintCli`. `showFeatures` calls `paintFeatureCatalog`, `paintShortcuts`, and `paintCli`.
- The existing `mailShortcut` cases stay. The case that passes `view: "shortcuts"` is updated to `view: "features"` and still expects `""`.
- Doc assertions move with the prose below: `docs/INDEPENDENT_UI.md` matches `/The CLI tab lists the checkout commands/`, and `docs/PARITY_SHELL.md` matches `/CLI tab for the checkout/`.

`scripts/check-page-navigation.cjs` already asserts `#rail-shortcuts` is immediately before `#rail-log`. That assertion stays valid because the button id stays.

UX fixture `scripts/check-ux-renderer.cjs` (Linux: `xvfb-run -a npx electron --no-sandbox scripts/check-ux-renderer.cjs`):

- Click `#rail-shortcuts`. Wait until `state.view === "features"`, `#features-panel` is shown, `#log-panel` is hidden, `#features-tab-catalog` has `aria-selected="true"`, and the shortcuts and CLI panes are `hidden`.
- The catalog text includes `Email Brain`, `Agent triage`, `Compose in its own window`, `Bot bridge`, and `In-app updates`, and does not include `npm start`.
- Select Shortcuts. `#shortcuts-note` matches `/Reload/`. `#shortcuts-list` includes `New Mail` and `Reply to the open message`, and matches neither `/⌘R|Ctrl\+R/` nor `/npm start/`.
- Select CLI. `#cli-title` is `CLI`. `#cli-note` matches `/no morrow command/` and `/Copy does not run/`. `#cli-list` includes `npm start`, `npm run check`, and `node scripts/morrow-bot-call.js`.
- Click the Copy button whose `data-cli-copy` is `npm start`. The status matches the existing success or manual-copy sentence. The fixture does not spawn the command.
- Focus the Features tab and dispatch ArrowRight: Shortcuts becomes selected and focused. ArrowLeft from Features wraps to CLI. Home selects Features. End selects CLI.
- Select CLI, click `#rail-mail`, click `#rail-shortcuts` again: the Features tab is selected.
- Set `location.hash` to `#shortcuts` and wait until the view is `features`, the Features tab is selected, and `location.hash` is `#features`.
- With `window.morrowFeaturesCatalog` set to `{ items: [] }`, repaint and assert the Features pane text includes `No features listed`, then select Shortcuts and assert `New Mail` is still there. Restore the real catalog before later assertions.
- Screenshots: `features-catalog` on the default tab at the wide size. Keep `shortcuts` for the Shortcuts tab. Take `shortcuts-cli`, `shortcuts-cli-bot`, `shortcuts-cli-dark`, and `shortcuts-cli-narrow` only after the CLI tab is selected, scrolling `#features-panel`. Take `shortcuts-narrow` on the Shortcuts tab.

Docs the implementation updates, without editing the two ADRs:

- `docs/INDEPENDENT_UI.md`: replace the Shortcuts / CLI sentences with: Features sits above Debug log in the rail and opens on a read-only catalog. The Shortcuts tab lists the keyboard shortcuts with ⌘ on macOS and Ctrl on Windows and Linux. The CLI tab lists the checkout commands from the README, package.json scripts, packaging docs, and the bot bridge client. Copy does not run them.
- `docs/PARITY_SHELL.md`: the rail sentence becomes “Features sits above Debug log.” The page sentence becomes: Features is its own page above Debug log. It opens on a read-only catalog, then a Shortcuts tab for those shortcuts with ⌘ or Ctrl, then a CLI tab for the checkout, packaging, and bot-bridge commands. Copy does not run them.
- `docs/UX_WORKFLOWS.md`: the Shortcuts paragraph opens by describing the Features page, the default catalog tab, the Shortcuts tab as the keyboard list, and the CLI tab as the same checkout commands. Keep the sentences that describe Delete, R, A, F, New Mail, Send, Save draft, search, Esc, Settings, Reload, and Zoom.

No version bump. `package.json` version and `docs/releases/` stay untouched.

## Out of scope

- Remembering the last tab, including any `localStorage` key.
- Deep links, Try buttons, or other actions on catalog cards.
- A generator that reads the README or docs.
- A `morrow` shell command, and any edit to `cliCatalog()` or `shortcutCatalog()` rows.
- A new rail icon, or renaming `id="rail-shortcuts"`.
- Moving Debug log or About & updates.
- An in-app editor for the catalog.
- Host, preload, OAuth, or updater behavior changes.
- A version bump.

## Implementation files

The follow-up change is limited to:

- `renderer/features-catalog.js` (new)
- `renderer/index.html`
- `renderer/app.js`
- `renderer/app.css`
- `scripts/check-boot-path.js`
- `scripts/check-ux-renderer.cjs`
- `docs/INDEPENDENT_UI.md`
- `docs/PARITY_SHELL.md`
- `docs/UX_WORKFLOWS.md`

No other product code.
