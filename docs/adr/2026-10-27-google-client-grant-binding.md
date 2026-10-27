# Bind Google grants to their Desktop client

PR #330 allows the effective Google Desktop client to change in Settings. Google refresh tokens belong to the client that issued them. Retaining Calendar scopes after a Gmail reconnect does not make the old Calendar grant usable under a different client.

New Google mail and feature grants store `googleClientId` with their credentials. Reuse, cached access, refresh and host commits require a match with the effective configured client. Client identity stays in the main process; status exposes availability and recovery reasons. A matching fallback can be used when a preferred legacy feature slot belongs to another client.

Older grants without an issuer cannot be reliably bound from their scopes, account email or the current client. They require one-time Gmail and separate Calendar reauthorization. We retain those credentials and all local mailbox work until successful consent replaces the relevant grant. We do not guess an issuer or merge scopes from different tokens. Microsoft grant handling stays resource-specific.

A main-process lease serializes Google authorization and import/clear, covering picker/browser waits through the final credential/account commit. Cancelling retains the lease until the original operation settles. The renderer disables overlapping actions as feedback; the host enforces exclusion for every caller. Commit and refresh-completion identity checks also reject obsolete results after external environment/file changes.

Status retains an invalid configuration's source separately from the existence of an imported file. An invalid environment override must be fixed or removed; it does not trigger fallback or deletion of a valid import.

Offline coverage is in `scripts/check-google-client-switching.js` and the existing consent/Gmail suites. Synthetic credentials, intercepted provider responses, real local callbacks and a temporary database validate the host and renderer paths. This does not verify native picker behavior, packaged OS integration or live Google configuration, and it does not change Console settings, scopes or grants.
