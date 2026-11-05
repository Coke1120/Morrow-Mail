# Simple Summary evidence

Prepared on 2026-11-05 from `dev` base
`4b4598bf4a084610f4412fa3220bcd963d474421`. All mail, AI replies,
credentials and consent files are synthetic. No real mailbox or model is used.

`node scripts/check-message-summary.js` covers the actual consent/API transport,
ChatGPT routing, temporary SQLite/mail-engine identity lookup, three actual
preload channels and both renderer roles. Cases include Unicode-safe source
parts/excerpts, complete long-message transmission including a fact after the
old cutoff, no transmission during review, explicit full/excerpt choices,
incomplete/oversized source, single-use/expired/foreign reviews, source/connection
and consent changes, queued and mid-run cancellation/revocation, provider and
consolidation failures, bounded response reads, output validation, scoped
cancellation, prompt deadlines, late replies and rendered feature help.

Browser reproduction (external dependencies may use NODE_PATH):

```sh
MORROW_UI_OUTPUT=/tmp/morrow-summary-simple-ui \
node scripts/check-message-summary-browser.js
```

The browser fixture uses Linux Chromium with synthetic IPC and blocks external
network requests. It checks the main/bottom/separate readers, light/dark themes,
560px-wide reader, native bullets, collapsed Details, keyboard/cancel/retry/stale
results, permission errors, explicit long-text review, persistent partial-coverage
notices, rendered Features and scoped axe WCAG A/AA rules. These are scoped
browser checks, not a complete accessibility certification.

Screenshots:

- [Main reading pane](summary-main.png)
- [Dark theme](summary-dark.png)
- [Narrow reader](summary-reader-narrow.png)
- [Long-message review before sending](summary-long-review.png)
- [Incomplete download and excerpt result](summary-partial.png)

Validation passed on this change: `CI=1 npm run check` ended in `ui-path-ok`;
303 JavaScript syntax checks passed; the focused Summary and Chromium suites
passed; AI-consent (8), consent-Settings (20) and ChatGPT (20) checks passed.
Dependencies and browser tools were installed in temporary storage; normal local
module links were used for ESM resolution. No test gates were changed. The preceding
[Summary evidence](../message-summary/README.md) describes the historical fixed-prefix
implementation. The [new ADR](../../adr/2026-11-05-simple-reviewed-message-summary.md)
defines the reviewed coverage and budgets.

Native Windows/macOS, real provider context limits/latency/usage, summary factual
accuracy, formal ASD-STE100 compliance and assistive-technology behavior were not
validated. Cancellation cannot recall text already delivered to a provider.
