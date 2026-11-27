# Restore the Settings AI consent bridge

Status: merged through PR #323 after final head
`4a2ddbbf05af7ab3801edab48c343cf038db25ea` passed full CI run40373071406
and an independent Astra final functional recheck with no confirmed blockers.
Included in the v0.3.2 release candidate; native/live validation remains untested.

The shared Settings consent panel calls the existing host status, grant and revoke
handlers, but the first-party renderer preload did not allow those three invoke
channels. Status therefore failed with `Unsupported channel`, leaving Allow
disabled regardless of the saved connection or checkbox. The separate AI Setup
preload already exposes the same handlers.

Add only `host:aiConsentStatus`, `host:aiConsentGrant` and
`host:aiConsentRevoke` to the intended renderer invoke allowlist. Keep the existing
host validation, saved destination/model/account binding, affirmative manual
choice, separate background choice and revocation behavior unchanged. Unknown
channels remain rejected. No credentials, account grants or user consent are
created by this change.

Tests must run the actual preload, Settings component and host consent handler
registration together with synthetic providers and in-memory persistence. A
mocked invoke callback that accepts any known consent channel misses this gap.
Cover ready/unready connections, explicit and background choices, revoke, errors,
stale destination/model tokens and rejection of unknown channels. Existing native
and live-provider validation limits remain; the overnight body diagnosis is
outside this patch.

`scripts/check-ai-consent-settings.js` runs the real Settings mount and preload
against the real host handler registration, config module and consent module with
in-memory filesystem/credentials and synthetic account state. It checks ready and
unready modes, affirmative/manual versus background choices, grant/revoke,
persistence/status errors, changed saved bindings, pending actions, AI Setup and
unknown-channel rejection. It is part of `scripts/check-boot-path.js`. Existing
HTML-parser DOM fixtures run in CI; a dependency-free DOM supports local VM
checks. No provider inference, OAuth grant or real configuration/consent write is
part of these tests.

## Settings simplification (#665)

The consent form described above is historical. Settings → AI and AI Setup
now show a saved connection and one Automatic processing preference. Explicit
actions use the saved ready connection without a separate acknowledgement.
Each host operation takes a stamp for that connection. Timeline and Case bind
the stamp to the reviewed source and require Generate. Mail, account and
source checks stay at their existing entry points.

Automatic processing starts off. Choosing Run background AI binds the
existing automatic activities to the current saved provider, endpoint, key
or ChatGPT registration, and model. Verified legacy background choices for
the same connection still apply if both the core and background scope
versions match. Historic manual grants and disabled, damaged or mismatched
records grant no automatic access. A changed connection or turning automatic
processing off invalidates in-flight requests. The app never enables
background processing when saving or signing in. The two first-party
preloads retain the allowed status, grant and revoke channels. Grant accepts
the current saved-connection stamp and the automatic-processing choice.
