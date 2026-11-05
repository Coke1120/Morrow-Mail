# To Me filter verification

Base: `dev` at `4b4598bf4a084610f4412fa3220bcd963d474421`.
Environment: Linux, Node 24.19.0 and headless Chromium. All mail, accounts and
provider responses in these checks are synthetic. No native Mail window,
credential store, real message, live mailbox or AI service is used.

Run:

```sh
npm run check
node scripts/check-to-me-filter.js
MORROW_PLAYWRIGHT_MODULE=/path/to/playwright \
MORROW_AXE_MODULE=/path/to/axe-core/axe.min.js \
node scripts/check-to-me-filter-browser.js
```

The host test uses the production SQLite/engine query path. It checks To-only
matching, case, named and structured addresses, Cc/Bcc-only mail, delivery headers,
aliases and plus variants, other connected accounts, substring/display-name
negatives, Sent to self, counts, pages, edited To fields, cursor invalidation,
draft edits, malformed recipients, account removal and filtering before search's
100-result limit. IMAP MIME formatting, Graph search formatting and Gmail MIME
adoption use the production parsers/formatters. Literal angle brackets and an
email address in a decoded display name cannot substitute for the final mailbox
address. The DOM test verifies scope, text/sort retention, page/selection reset,
focus, Outbox exclusion and the rendered Features tab. It is part of `npm run check`.

The browser check uses the actual renderer and real SQLite fixture behind a local
read-only IPC adapter. Space and Enter toggle once without opening a message.
It checks per-account and aggregate Unread scope, cached pages/counts, search
account scope, page text, folder changes and rendered help. At 440, 900 and 1440px,
in light/dark themes with reduced motion, the chip stays inside the message list.
The list-header axe WCAG A/AA check has no violations. Synthetic screenshots are
written to the temporary output directory for local inspection.

The existing `check-mail-layout-browser.js` also passes its list, preview,
sorting, keyboard, splitters, aggregate counts and accessibility checks.

A local 10,000-message fixture with named To addresses measured a first filtered
count of 54.28ms (5,000 matches), a cached count of 0.33ms and a 200-row first page
of 2.99ms. This is one synthetic measurement, not native-app or large-mailbox
profiling. The first filtered count still scans cached To headers synchronously;
no additional recipient index or schema migration is introduced.

The supplied original screenshot could not be materialized in this run. These
screenshots verify To Me using synthetic data and do not establish a match to the
supplied image. The separate [folder chip alignment checks](../mail-chip-alignment/README.md)
cover the layout fix using rendered synthetic fixtures.
