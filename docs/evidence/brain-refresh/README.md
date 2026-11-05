# Brain cadence and subject prefix checks

All fixtures use synthetic messages, accounts, local stores and AI responses.
No real mailbox, credentials, AI request or delivery is used.

- `node scripts/check-brain-refresh.js`: ten cases exercise production settings,
  IPC, preload, Settings events, Brain scheduling, atomic persistence, consent
  and request handling. Covers daily/weekly/manual policy, legacy/damaged
  settings, timer/page-open agreement, concurrent and queued requests, restart,
  failures, clock rollback, update admission, destination changes and revocation.
- `node scripts/check-subject-prefixes.js`: three cases cover fresh subjects,
  actual reader/list/Agent/suggestion/proposal entrypoints, window serialization,
  composer initialization, previews, draft/scheduled/send payloads and parsed
  MIME through production Gmail/SMTP submission functions with fake transports.
  Edited/resumed/recovered subjects and mixed action history remain intact.
- `node scripts/check-brain-settings-browser.js`: actual Chromium rendering,
  Settings events, keyboard tabs, Features claims and permission text; 1280px and
  390px viewports in light/dark themes, with no page errors or horizontal content
  overflow. See `browser-results.json`, `brain-light-desktop.png` and
  `brain-dark-narrow.png`. Screenshots use synthetic background permission.
- Existing AI consent, ChatGPT, profile editing and updater shutdown checks
  remain part of the aggregate `CI=1 npm run check` regression run.

The user's missing-prefix report did not reproduce on the investigated dev.
This change preserves existing Re:/Fwd: insertion and fixes demonstrated
duplicate localized/counter prefixes. It does not infer provider disposition
from a subject. Live mail delivery, native windows/sleep/wake and screen-reader
acceptance are not verified by these fixtures.
