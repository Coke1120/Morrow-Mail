# First-use guide and existing settings

The first-use experience is one five-step guide. It runs after the initial account
load and yields to the changelog or any open dialog, resuming after the final close.
A profile with existing mailboxes is grandfathered; a new profile sees the guide
even when Google client configuration is already available. Google Desktop JSON
import is a mailbox-step action, not a second automatic startup prompt.

`settings.json` stores only guide status, step and selected mailbox. Later and
Escape suppress automatic reopening; Settings → General resumes at the saved step.
An active guide resumes after restart, including after leaving for an editor or
browser sign-in. Skip advances without claiming the skipped setting is complete.
Finish guide ends the tour without requiring calendar, signatures or AI.

The guide reads saved configuration for the selected mailbox and reuses Connect,
Compose sender identities, Signatures and AI Settings. It closes before opening
an existing editor and returns after that editor closes. Calendar consent uses
`calendar:connect` for the pinned account, with the existing cancellation channel.
Delayed status reads are invalidated by navigation, account changes and closing.
No credential store, OAuth scope, sender authorization or AI permission is added.
AI connection readiness and data permission remain separate.

Full boot regressions use synthetic IPC, including changelog order, dismissal,
restart, editor handoffs, account-specific states and delayed consent. The optional
Chromium smoke checks native dialog focus, Escape, narrow layout, rendered Features
and WCAG A/AA rules with axe. Neither test substitutes for native Electron or live
provider validation.

## Reproduce validation

`npm run check` runs the full boot and host/preload regressions. There are no
separate lint or TypeScript scripts; CI syntax-checks JavaScript and runs that
aggregate command.

The optional browser smoke needs Chromium, Playwright and axe-core (they can be
installed outside the checkout). Run `node scripts/check-setup-guide-browser.js`
with `MORROW_CHROMIUM` if Chromium is not `/usr/bin/chromium`, and
`MORROW_PLAYWRIGHT_MODULE` / `MORROW_AXE_MODULE` for external module paths.
`MORROW_UI_OUTPUT` chooses the screenshot directory; it defaults to the OS temp
folder. The local HTTP fixture uses synthetic accounts and settings and never
submits live OAuth, AI requests or mail.
