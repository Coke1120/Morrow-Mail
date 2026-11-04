# Account settings redesign verification

Implementation baseline: dev `3c24b6c50bdf7ba85eb5db5e42d4cece7a95ff80`.
Working branch: `redesign/account-settings`. Synthetic account identities only.

## Passed

- `npm run check`: exit 0, final marker `ui-path-ok`. Includes the new three-case
  Account settings DOM suite, existing OAuth/migration, Out of Office, account
  recovery, sender identities, Features consistency, mail and host regressions.
  Full output: `aggregate-check.txt`.
- `node scripts/check-account-settings.js`: 3/3 passed. Actual DOM events, safe
  identity rendering, Mail/Settings isolation, single/empty fallback, repeated
  discard review, removed targets and delayed permissions.
- `node --test scripts/check-google-oauth-default-ui.js`: 12/12 passed, including
  migration cancellation, changed/removed account targets and visible focus.
- `npm run test:timeline`: 81/81 passed.
- JavaScript syntax checks and `git diff --check`: passed. The repository has no
  dedicated lint or TypeScript type-check script; neither is claimed as run.
- `scripts/check-account-settings-browser.js`: passed in Linux Chromium with
  synthetic IPC and reduced motion. Empty, single and multi-account states;
  Enter/Tab/Escape and focus preservation; reconnect/signatures target; Out of
  Office discard/cancel/repeated clicks; permission reads completed out of order;
  reviewed removal cancellation; reopening and rendered Features claims.
- Browser layout matrix: 1440×1000, 1024×768, 800×600, 390×844 and 844×390, each
  in light/dark mode. No horizontal overflow. Account targets are at least 44px.
  Axe WCAG 2 A/AA found zero violations across the ten matrix cases. See
  `results.json` and `accounts-{theme}-{width}x{height}.png`. Single and empty
  state screenshots are also included. Desktop and portrait screenshots were
  visually inspected; the initial inherited global header styling was corrected
  before final captures and verification.

Reproduce the browser suite with external testing dependencies:

```sh
MORROW_PLAYWRIGHT_MODULE=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright \
MORROW_AXE_MODULE=/tmp/morrow-ui-tools/node_modules/axe-core/axe.min.js \
MORROW_UI_OUTPUT=/tmp/morrow-account-settings \
node scripts/check-account-settings-browser.js
```

## Failed attempts and limits

The initial dependency install used an unwritable default npm cache. It succeeded
using `/tmp/morrow-npm-cache`; dependencies were installed without lifecycle
scripts, then the needed SQLite dependency was rebuilt. Electron installation
initially failed on GitHub DNS/default cache access, then succeeded using the
configured proxy and a writable XDG cache. An early aggregate run stopped on the
missing Electron package; a later run caught the Features catalog's duplicate
seed needing synchronization. Both were resolved before the successful final
aggregate run. A new DOM fixture initially did not drain frame/task handoffs;
the fixture now waits and clears its timers, and all three cases pass.

The standalone Electron `check-page-navigation.cjs` runner was attempted with
`--no-sandbox --headless --ozone-platform=headless`; Electron exited with SIGSEGV
before test results in this display-less container. See
`electron-headless-attempt.txt`. This is an unavailable native runner, not a passed
suite. `check-ux-renderer.cjs` was not run. Its overlapping Account settings flows
were exercised in Chromium instead. No native Windows/macOS, screen-reader,
live OAuth/provider/credential, packaging or deployment validation was performed.
No skill Python, upstream installer, live mail action, PR, push, merge or deploy
was performed.
