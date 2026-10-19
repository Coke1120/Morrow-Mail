# Compact Inbox browser QA

Run `node scripts/check-inbox-browser.js [source-root] [output-directory]` with Node 22+ and Chromium (`CHROMIUM` overrides `/usr/bin/chromium`). The harness serves the real renderer, replaces only startup with synthetic mail and mocked IPC, and uses a temporary browser profile. It never connects a mailbox.

The check captures wide/narrow, selection, second page, syncing, and forced-colors screenshots. It exercises Space on the page checkbox, partial selection, filtering, paging/selection reset, older-history requests, busy/completed sync, search visibility, Refresh placement outside Mail, account/folder navigation, and scrollbar dragging. Existing `npm run check` remains the dependency-free aggregate gate; this browser check additionally requires Chromium.

On 2026-10-19 both the main baseline and revised renderer were captured in Linux Chromium. All revised checks and `npm run check` passed. Screenshot directories in the task environment: `/tmp/morrow-inbox-qa-before` and `/tmp/morrow-inbox-qa-after`. Data is synthetic; the count is downloaded cache total, never provider total. Load older messages continues the existing history download within the configured sync horizon.

Native macOS/Windows overlay scrollbar and always-show preferences still need platform smoke checks. The styles retain automatic overflow, a 12px drag track, visible rounded thumb, keyboard focus, forced-colors and increased-contrast behavior. No live mailbox or native Electron E2E was performed.
