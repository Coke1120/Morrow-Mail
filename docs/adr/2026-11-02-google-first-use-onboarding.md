# Nonblocking Google client setup on first use

A fresh shell profile without accounts or any existing Google client configuration
gets an Import Google Console JSON / Later dialog after account readiness loads.
A bundled, imported or environment client, including invalid existing overrides,
stays on the existing Settings repair path. An unknown readiness response must not
ask the user for credentials. The existing browser sign-in and importer remain the
only authorization and import paths; selecting a file is not proof of Cloud setup
or consent.

Later, Escape/back cancellation and dialog close persist a versioned, non-secret
localStorage choice on the Electron profile. Successful imports also mark it done.
Storage events close prompts in other shell windows. A cancelled picker or failed
import leaves retry available; the existing renderer and host operation guards
serialize imports/sign-in. Closing the prompt does not cancel an already-open
native picker. If profile storage is unavailable, dismissal lasts for this window.
There is no automatic reset when credentials are cleared. Settings → Accounts
keeps a visible import reminder outside the existing Advanced disclosure.

Only the main shell runs onboarding; reader, composer and translation windows keep
their own boot paths. Existing motion and native dialog focus/Escape behavior are
reused. Tests use synthetic profiles and IPC; no real Google project or account is
changed.

## Startup sequencing correction

Keep a pending offer while What’s New readiness is loading or another dialog
occupies the shell. Completion of the changelog check also retries the offer, so
a slow settings read preserves ordering without requiring another launch. A
capturing close listener retries in the next event task after close handlers finish, including
for dynamically created dialogs. Recheck Google readiness and current accounts
before showing; serialize reads and discard a response if another dialog closed
while it was pending. A microtask is insufficient: native event dispatch can run
microtasks between listeners, before a later close handler opens another dialog.
This avoids both stacking and stale setup offers after a
configuration change. Dismissal or successful import still ends the offer.

The original tests called onboarding directly and only asserted suppression behind
an open dialog. Full-boot tests now include the real changelog module and unseen
version state, then close it through OK, Close and Escape. Browser coverage runs
unmodified boot with synthetic IPC, including real native dialog close events.
