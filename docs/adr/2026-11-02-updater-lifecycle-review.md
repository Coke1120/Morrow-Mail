# Updater discovery and final shutdown

## Decision

Windows starts the existing NSIS updater only on the final successful Electron
`quit` event, armed by an explicit main-window install action after renderer
review and host write draining. Normal quit does not arm it. A prevented quit's
watchdog removes the listener before resuming. Portable launcher copies use the
official manual release page and never load the NSIS provider.

Observe electron-updater's returned `downloadPromise`, as well as its events.
Mark the download active as soon as a release is offered and retire the older
install action. A cached macOS ZIP does not suppress metadata discovery: compare
fresh authenticated metadata before reusing it. A discovery/transfer failure
retains an existing candidate only after rechecking its bytes; the UI keeps its
explicit retry action and shows the error. Fetch the signature from the
manifest version's fixed release tag, while retaining all existing verification.

## Evidence

- **P1 — Windows installer before quit consent.** The pinned electron-updater
  6.8.9 `BaseUpdater.quitAndInstall` starts `doInstall` before `app.quit`.
  electron-builder 25.1.8's `--updated` NSIS path waits briefly, then uses
  `taskkill`, including `/f`. Morrow's scheduled-mail prompt or cleanup can still
  be pending then. `check-update-windows.js` reproduced an installer call before
  the final quit; it now exercises the production scheduled-quit controller with
  Stay open and deferred cleanup. No native installer is run.
- **P1 — Unobserved Windows transfer rejection.** Discovery returns a separate
  background download promise. The provider emits error and rethrows through
  that promise; the host previously ignored it and tracked downloading only on
  progress events. `check-update-schedule.js` uses the pinned dependency's real
  check/download methods with mocked metadata/transport to verify rejection
  handling, no-progress overlap refusal, retry and retirement of an older ready
  download.
- **P2 — Portable Windows enters the NSIS path.** The pinned portable launcher
  sets `PORTABLE_EXECUTABLE_FILE` and `PORTABLE_EXECUTABLE_DIR`; the Windows
  provider loader always selects NSIS. Tests now cover each marker, no provider
  load/timer/install, and the authorized main-window manual link and rendered UI.
- **P2 — macOS cached candidate blocks discovery and retry.** The controller's
  early cached-file return prevented newer metadata checks and preserved an
  install error indefinitely. Tests reproduce a second signed release and a
  transient helper failure, with unchanged validated archives reused.
- **P2 — Moving latest mixes metadata.** Separate latest manifest/signature GETs
  can return different releases. The controller fixture advances latest between
  GETs; the versioned signature succeeds and a mismatched signature still fails.

[Electron app events](https://www.electronjs.org/docs/latest/api/app#event-quit)
define the final quit event. The pinned dependency's `ElectronAppAdapter.onQuit`
also uses that event for its optional install-on-quit path.

## Limits and preserved contracts

This review changes no production tag, release workflow, feed, bundled key,
TLS/signature/hash check, quarantine attribute, Gatekeeper policy, data directory
or credential storage. macOS retains ZIP path/type/expansion checks, strict
codesign, minimum OS/architecture validation, private same-volume staging,
post-exit revalidation and backup/readiness recovery. Windows remains unsigned
and uses the public prerelease feed with provider SHA-512 verification; it does
not gain independent Ed25519 release authentication from these fixes.

Native Windows NSIS/UAC, macOS authorization/quarantine/trust/restart, secure-store
continuity, and bridge-to-candidate transitions remain unrun. macOS retry starts
from zero, has no user cancel action, and retains completed backups; there is no
crash-atomic replacement or automatic proof against a server withholding newer
releases. A Windows installer launch failure after final quit leaves no running
UI to resume; reopen the existing installation to retry. Use the disposable
native test plan in `SIGNED_UPDATES.md` before release.
