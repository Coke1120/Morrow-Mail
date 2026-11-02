# Undo panel interaction evidence

Synthetic renderer fixture; no mail accounts, credentials or live provider writes.
Generated with `MORROW_UNDO_EVIDENCE_DIR=docs/evidence/undo-panel node scripts/check-undo-panel-browser.cjs`
using Playwright and system Chromium. The fixture loads the production renderer
and intercepts all requests locally; it skips application boot and supplies synthetic
completed Archive/Trash changes.

- `selection-retained.png`: Select all / Clear / keyboard activation retain Details.
- `bulk-confirmation.png`: reviewed count and action breakdown with Cancel.
- `features-help.png`: rendered Features catalog containing the updated help.

Before the fix, a native click from Select all to Clear closed Details before Clear's
click handler ran. The same sequence now leaves the panel open with zero checks.
The browser check also covers individual and bulk submissions, frozen IDs while new
completions arrive, stale-session rejection, delayed backend responses, double
activation, nested modal cancellation, focus return, Escape, outside clicks,
read-state cancellation/expiry and empty state. Existing Undo race tests cover
restored-ID filtering and reader ownership.
