# Account folder indentation

Synthetic renderer fixture, 9 November 2026. No live mailbox, credentials,
provider writes or AI calls were used.

Each account's first-level folders have a fixed 14px inset. Real subfolders keep
their existing extra nesting and flexible spacing. Unread badges retain the same
right edge. The separate All Account Mail section is unchanged.

- DOM regression: `node --test scripts/check-sidebar-accounts.js` (8 tests).
- Browser regression: `CHROMIUM=/path/to/chromium node scripts/shot-folder-sidebar.js . /path/to/output --account-indent-only`.
- Full repository check: `npm run check`.

The browser fixture checks 22 folder rows and 18 badges across Gmail, Outlook,
Yahoo, custom IMAP and Local Folders. It covers 1280×1000 with a 260px sidebar,
800×600 with a 220px sidebar, and 390×844 with a 180px sidebar in light/dark
appearances. Measurements verify the fixed root inset, aligned sibling roots,
visible child hierarchy, unchanged badge right edges and no row overflow.
Account collapse/reopen, Inbox collapse/keyboard expansion, folder filtering and
rendered Features text are exercised too. See the JSON results alongside the
screenshots.

The captures expand custom IMAP and Local Folders and collapse the other provider
accounts to make their shared layout visible in one image.

- [Light](sidebar-folder-indent-light.png)
- [Dark](sidebar-folder-indent-dark.png)

Native installed Windows/macOS rendering, operating-system screen readers and
live providers were not tested. Browser tests use a fresh Chromium profile and
synthetic IPC against the first-party renderer.
