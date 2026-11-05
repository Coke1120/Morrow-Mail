# Local Folders evidence

Implements [#519](https://github.com/Coke1120/Morrow-Mail/issues/519), on a separate
feature branch integrated with the completed dev batch
`70477e4c1aff781a56fd6fc91c270abd6a274571`. MBOX import (#521), merge and release are
outside this feature PR. See the [storage/transfer decision](../../adr/2026-11-05-local-folders.md).

## Validation

`node scripts/check-local-folders.js` passes 18 cases using real temporary SQLite,
production MIME parsing, full host/preload handlers and synthetic providers:

- Exact original MIME/header bytes, Unicode, To/Cc/Bcc/Reply-To, dates, inline CID
  images and file attachment bytes survive reopening. Local flags, nested folder
  names/IDs, copy/move, Trash/restore and separate search preserve ownership.
- A second database connection verifies the committed complete copy before Trash.
  Repeated operations reuse verified records. Gmail canonical label copies share
  one receipt; changing local destinations cannot replay an uncertain server write.
- Actual `SQLITE_FULL` rolls back an uncommitted copy. Damaged schemas fail open
  without resetting data. Corrupt attachment bytes block server cleanup while
  independently verified original MIME remains exportable for recovery.
- Offline/truncated reads, wrong UID, UIDVALIDITY changes, missing MOVE capability,
  source/account replacement, definite refusal, lost replies and receipt-write
  failures never delete the archive. An abrupt child-process exit after persisting
  intent recovers an uncertain receipt and does not resubmit Trash.
- A real ImapFlow instance over a synthetic Duplex transport downloads `BODY[]`
  unchanged and sends `UID MOVE`, with no COPY/EXPUNGE/Deleted fallback. The actual
  Gmail API/session/engine path downloads raw MIME, uses Trash and checks TRASH
  membership; a provider that ignores Trash produces a retained uncertain copy.
- After disconnect, actual preload/host local reads, attachment bytes, flags,
  folder listing and native-dialog-mocked EML Save/cancel obtain no credentials
  and make no provider calls. Unknown preload channels remain rejected.
- Charset decoding diagnostics preserve the recently integrated dev behavior,
  including a checked plain-text fallback and original bytes for export.

`node scripts/check-local-folders-ui.js` exercises actual first-party renderer DOM
with a real temporary archive and synthetic IPC. It checks the Local Folders root,
account expansion, nested hierarchy, keyboard context menu, frozen source IDs,
changed Copy/Move disclosures, cancellation, stop-after-current-message behavior,
offline reading/attachments/flags, the EML reader button and rendered Features/help.
A stale native close event cannot discard a reopened transfer review. Supplied
background account notifications never open/retry the independent archive.
Local IDs are excluded from connected account/sending choices. These cases are included in
`npm run check`; the complete suite passed (`ui-path-ok`) during implementation.

For browser rendering:

```sh
MORROW_PLAYWRIGHT_MODULE=/path/to/playwright \
MORROW_UI_OUTPUT=/tmp/morrow-local-folders-browser \
node scripts/check-local-folders-browser.js
```

The Chromium run passed at 1440px and 390px, in light/dark themes and with reduced
motion. It checks local reading after simulated account disconnection, nested
folders, Shift+F10, review focus, Copy/Move disclosures, safe Escape, completion and
rendered Features. The transfer dialog stays inside the viewport with no content
overflow. There were no page errors. Screenshots contain synthetic data only:

- [Reader, light](local-reader-light.png) and [dark](local-reader-dark.png).
- [Move review, wide](move-1440-light.png) and [narrow/dark](move-390-dark.png).
- [Rendered Features, narrow](features-narrow.png).

Local checks ran on Node 24.19.0. The environment could install registry/native
dependencies but could not download the Electron executable from GitHub, so its
download was skipped and plain-Node checks used
`ELECTRON_OVERRIDE_DIST_PATH=/tmp/morrow-electron-unavailable`. No Electron process
was launched; browser validation used installed Chromium. The PR's Linux/Windows
CI runs the repository's normal install and full checks on the pushed head.

The first Windows CI run exposed a fixture cleanup omission: reader-window boot
now opens the separate archive, and that fixture closed only the account cache.
Windows correctly refused to unlink the still-open archive. Its teardown now
closes both independently owned stores before removing synthetic files; the
read/download assertions and the archive's persistence guarantees are unchanged.

Additional performance checks preserve the supplied-account notification path:

```sh
node --test --test-name-pattern='hidden mail notifications|account snapshots do not swallow' scripts/check-performance-followups.js
```

Both cases pass: background account snapshots do not initialize/retry local
storage or add an IPC read. The complete optional helper (not in `npm run check`)
also has three failures reproduced unchanged in a detached `70477e4` dev checkout:
the failed-refresh-store expectation, the VM missing `withSyncClient`, and its
source-limited-body fixture. They remain outside this feature's runtime changes;
no credential/read safety rule was weakened to satisfy those older expectations.

## Limits

No real mail, live providers, credentials, AI, native dialogs or user profile were
used. Native Windows/macOS UX, screen-reader acceptance, storage hardware/power
loss and live-provider behavior remain unverified. Original MIME is capped at
64 MiB (Gmail's existing API limit is 35 MiB). SQLite/checksums are synchronous and
large copies can pause the host. Transfers stop between messages, not during an
already submitted server mutation. A confirmed move's connected-account cache
settles on ordinary sync; a sync failure can leave an old cached source row.

The archive is local to this app profile and needs a stopped-app backup. Provider
Trash retention can expire server originals. No permanent local delete/empty
Trash, MBOX import, provider restore/upload, local reply/AI, bot/CLI access or
drag/drop is included. Local search matches a phrase in saved fields and returns
up to 100 results; it remains separate from connected-account global search.
