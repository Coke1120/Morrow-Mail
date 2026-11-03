# Message Summary evidence

Prepared on 2026-11-03 from `dev` commit
`52ce7a83b65f2e4be1629eb9d48f65c366bd6faa`. All messages, addresses,
AI outputs, credentials and permissions used by these fixtures are synthetic.
No live mailbox, model endpoint or real consent file is used.

The repository's `morrow-dev` and static `ui-ux-pro-max` guidance informed the
implementation and review. The optional upstream skill Python files were not run.

## Checks

`node scripts/check-message-summary.js` exercises the real AI consent and transport
paths in API and ChatGPT modes, temporary SQLite and the mail engine, the actual
preload allowlist, and the production reader functions in JSDOM. Cases include
unconfigured/refused permission, manual-only permission, stale queued permission,
wrong mailbox/epoch, forged renderer content, HTML-only and snippet-only content,
partial and over-24,000-character input, empty/oversized/incomplete output,
provider failure, duplicate requests, owner/request-scoped cancellation, close,
account removal/re-add, content races, late output, retry and a simulated deadline.
Both reader roles and the rendered Features catalog are checked.

Browser reproduction (Playwright and axe can be installed outside this checkout):

```bash
MORROW_PLAYWRIGHT_MODULE=/tmp/morrow-ui-tools/node_modules/playwright \
MORROW_AXE_MODULE=/tmp/morrow-ui-tools/node_modules/axe-core/axe.min.js \
MORROW_UI_OUTPUT=/tmp/morrow-message-summary \
node scripts/check-message-summary-browser.js
```

This passed with Linux Chromium, Node 24.19.0, Playwright 1.64.1 and axe-core
4.14.0. It uses the real renderer/layout/keyboard handlers with synthetic IPC,
checks right/bottom previews and a separate-reader surface at 560×720, verifies
cancel/retry and stale replies, checks Labels alongside Summary, and renders the
Features entry. Axe found no WCAG A/AA violations within the tested reader
success states in light/dark, narrow-reader success, and permission-error state.
This is scoped automated evidence, not a full accessibility certification.

The complete `CI=1 npm run check` passed (exit 0, ending in `ui-path-ok`) and
includes the new synthetic summary suite.
Focused mail-reader, suggestion-on-demand, body-cache, attachment-transfer,
AI-consent and ChatGPT checks also cover the reused paths.

## Screenshots

- [Main reading pane](summary-main.png)
- [Bottom preview](summary-bottom.png)
- [Separate reader](summary-separate.png)
- [Narrow reader](summary-reader-narrow.png)
- [Gmail Labels alongside Summary](summary-gmail-labels.png)
- [Dark theme](summary-dark.png)
- [Loading and Cancel](summary-loading.png)
- [Permission required](summary-permission-required.png)
- [Incomplete/shortened input](summary-partial.png)
- [Rendered Features help](summary-features.png)

## Limits

These are Chromium/DOM and synthetic host checks. Native Windows/macOS windows,
assistive technology, live provider compatibility, latency, model quality and
provider retention are unverified. Summary uses only downloaded body text, capped
at 24,000 characters, plus bounded selected sender/subject/date; it can omit later
content and includes quoted history present in that message. Attachments and
linked pages are excluded. Results are per-window memory only, with no cross-window
reuse or persistence. Cancellation cannot recall data already transmitted.
