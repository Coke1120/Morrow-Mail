# Message attachment accordion

The attachment list starts collapsed so long lists leave space for the message.
The header keeps its count and Save as ZIP. Click Attachments or press Enter or
Space to show or hide the files. Preview, Save and Open still use the existing
handlers and exact file IDs. Duplicate filenames have position labels for their
actions. Collapse does not stop a transfer; its progress and Cancel control stay
in Attachment transfers.

The choice belongs to the current message on each reading surface. A body repaint
keeps that choice. A different message or mailbox starts collapsed. There is no
new saved preference, provider operation, IPC channel or bot/CLI capability.
Full filenames wrap to fit the available width.

## Evidence

All mail, filenames and bytes are synthetic. The browser loads the actual
renderer, wires its real events and uses a fake preload. Boot is held; unexpected
IPC is rejected and external HTTP/HTTPS requests are blocked.

- [Collapsed desktop](desktop-collapsed.png)
- [Expanded desktop](desktop-expanded.png)
- [Narrow dark reader](narrow-dark-expanded.png)
- [Rendered Features catalog](features-help.png)
- [Browser checks and scoped accessibility results](checks.json)

The Chromium checks cover Enter/Space, Tab order, hidden file actions, visible ZIP,
exact Preview/Save/Open/ZIP file identities, image preview, active transfer status
and Cancel after collapse, body repaint, message changes, right/bottom/separate
readers, 320px/360px widths, light/dark themes and reduced motion. All ten scoped
WCAG A/AA axe checks pass with no renderer errors or external requests. Screenshots
were visually inspected. These are Chromium checks on Linux, not native macOS or
Windows screen-reader tests.

`scripts/check-responsive-attachments.js` is part of `npm run check`. It checks
the real DOM controls, unique IDs across reading surfaces, separate disclosure
choices, repeated-file routing, unknown attachment metadata and rendered help,
alongside the existing ZIP worker and retained-sidebar checks.

On 2026-11-05, the full `CI=1 npm run check` passed on Node 24.19.0 and ended
with `ui-path-ok`. The focused checks listed below and `git diff --check` also
passed. CI still validates the repository's Node 20 Linux/Windows matrix.

## Reproduce

Use the repository's installed dependencies for the Node checks:

```sh
CI=1 npm run check
node scripts/check-responsive-attachments.js
node scripts/check-attachment-transfers.js
node scripts/check-mail-reader.js
node scripts/check-ux-workflows.js
node scripts/check-wave1-review.js
git diff --check
```

The optional browser check uses external Playwright and axe-core, following the
other browser fixtures. It adds no application dependencies. The recorded run
used the runner's Playwright, system Chromium and axe-core 4.11.0:

```sh
MORROW_PLAYWRIGHT_MODULE=/path/to/playwright \
MORROW_AXE_MODULE=/path/to/axe-core/axe.min.js \
MORROW_CHROMIUM=/usr/bin/chromium \
MORROW_UI_OUTPUT=/tmp/morrow-attachment-accordion \
node scripts/check-attachment-accordion-browser.js
```

The Linux runner has no Xvfb. An additional Electron motion fixture could not
start its UI with the headless compositor (process exit 139), so the native
Electron UI suites remain unverified here. The Chromium fixture verifies this
component's normal and reduced-motion behavior. Live providers, system file
pickers and Windows/macOS assistive technology still need native validation.
