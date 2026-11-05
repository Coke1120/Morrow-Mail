# Case Timeline evidence

All mail, people, domains, model results and source bodies in these fixtures are
fictional. No mailbox, provider, credentials or live model was accessed. Addresses
use `example.org`; the AI destination is a stub and never contacted.

- [Desktop selection](desktop-selection.png): current account, Case mode, local
  query disclosure, explicit Main/Background selection and separate review gate.
- [Desktop report](desktop-report.png): source-cited status, review follow-ups,
  unresolved gaps, mentioned dates and retained correspondence chronology.
- [Narrow dark report](narrow-dark-report.png): 440px viewport, dark theme, wrapped
  evidence and keyboard-operable controls.

Chromium 151.0.7922.173 with Playwright rendered the production `index.html`,
`app.css`, `timeline.css` and `timeline.js` against synthetic IPC responses.
Unrelated application scripts were removed from the fixture. Local HTTP requests
were fulfilled from the checkout; external requests were blocked and counted (0).
The browser check verified the review gate, Main/Background filter, inert source
text, focus return after source close, Escape dismissal and no horizontal overflow.
These images are rendered evidence rather than a mockup or a native Electron run.

`npm run test:timeline` covers schema 1.0.0/1.1.0, source selection/account ownership,
bounded extraction/synthesis, forged citations and mentioned-date provenance,
consent renewal/revocation, cancellation, local evidence reads, all four export
paths, storage reopen, preload and actual rendered sheet/Features/CLI consistency.
The original synthetic regressions remain in the same suite. Full `CI=1 npm run
check` also exercises the other existing application regressions.

Limitations: local token-prefix search is not exhaustive; To/Cc are local evidence,
not independently supplied to AI. Overview sections contain at most 12 points and
need review against mail. An exact quoted date is not proof of its interpretation.
No follow-up is automatically completed. Native Windows/macOS UI, fonts, PDF page
breaks and actual model quality were not tested. No merge or release is part of
this work.
