# Scope AI permission to stable data uses

The historical global disclosure number participated in the destination fingerprint.
Adding Timeline sender/date evidence or cross-thread Case mode invalidated unchanged
manual and background grants. Re-selecting the active ChatGPT registration also
revoked the grant. Saved checkboxes appeared empty despite an allowed status.

Use a stable destination fingerprint bound to authentication mode, exact endpoint
(including query), model, registration and API credential. Version ordinary actions,
Thread Timeline, Case and background use independently. A changed destination still
revokes all uses, including when switching back. Timeline and Case require their
specific scope at preparation, job admission and each actual provider request; Case
also requires Thread Timeline. They cannot run as background actions.

Verify legacy fingerprints using their original disclosure version before mapping
known unchanged uses: versions 1/2 preserve ordinary actions and the existing
background choice; version 3 additionally preserves current Thread Timeline;
version 4 additionally preserves Case. The narrow version-2 Timeline grant does not
cover the later sender/date/focus expansion. Unknown or malformed versions,
revocations and wrong destination/credential bindings remain denied. Status reads
never write or expand a grant. New records contain explicit per-use versions.
Increasing a use version invalidates that use; dependent uses also remain blocked.

The shared first-party Settings/Setup UI restores already granted checkboxes and
shows a prominent saved status. New Timeline/Case choices start unchecked. Saving
choices is affirmative and uses the existing owner-bound target token and three
exact IPC channels; saving a connection, opening Settings or reading privacy details
never grants permission. Pending/dirty controls and stale-response fencing remain.
Re-selecting the connected active ChatGPT account changes neither consent nor its
request epoch. Different account selection, reauthorization and sign-out retain the
existing revocation behavior. Explicit revoke cancels active and queued work.

Synthetic tests cover historical records, independent scope upgrades, restart,
wrong targets, mandatory Timeline/Case provider gates, Settings/Setup preloads,
checkboxes, incremental approval, revocation and account selection. No real consent
files, credentials, mail or user AI are read. This supersedes the global-renewal and
empty-checkbox behavior recorded in the earlier consent review ADR, without adding
any new data use or provider scope.
