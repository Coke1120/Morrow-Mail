# Sync and Out of Office retries

Transient mail sync errors schedule three retries, at 5 seconds, then 15, then 45. After that, the existing 45 second background poll (`POLL_MS`) is the only automatic sync. Password, keychain, rejected-credential, and sign-in-again errors set the mailbox auth error and do not use that schedule. A rate limit still uses the existing pause.

Out of Office status uses the same three delays after a failed `mail:vacationGet` on start or account select. The chip says `Retrying…` until a recheck succeeds or the sequence is finished, then it shows the status or `unknown — refresh to retry`. Refresh status still reads immediately. Staying on that mailbox does not start another sequence after the rechecks are done.

This is issue #192.
