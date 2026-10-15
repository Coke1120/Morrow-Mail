# Selected custom IMAP folders

This source adds explicit continuous new-mail downloads for selected custom IMAP
folders. It uses the existing regular/manual mailbox Sync and bounded cached-mail
flag reconciliation. Folder catalog refresh alone still downloads no messages.

An IMAP account's **Folders to sync…** editor loads saved local status. Refreshing
the server folder list is a separate read; saving the selection changes only local
download settings. **Sync this mailbox now** starts an explicit read. Periodic
downloads use the existing General sync interval while the app is open. An interval
of zero disables periodic Sync; quota retries and update continuations of previously
requested reads can still run. These actions do not call a model, change provider
folders or flags, send mail, or replace existing provider-write review rules.

Up to 20 custom selectable folders can be selected per mailbox. Each sync finishes
the existing foreground, Inbox/Sent and cached-mail reads for every target account
before starting any selected-folder pages. It then visits at most four eligible
folders per mailbox, choosing the least recently attempted first, with at most 50
messages in each page. A first check fetches a bounded recent page; subsequent
checks advance newly assigned UIDs in ascending order so a burst larger than one
page continues on later rounds. Sparse UID ranges remain bounded to the existing
32 search windows per page. An incomplete initial scan has a separate coverage
warning. Older mail requires the history importer; no coverage percentage or full
mailbox-mirror claim is made. Existing bounded reconciliation refreshes flags for
downloaded messages separately from these new-mail pages.

System, virtual, nonselectable, Spam and Trash folders and excluded subtrees are
not eligible. Saving requires a successful, matching-connection folder catalog
less than 15 minutes old. Each actual selected-folder read also checks a complete
live LIST before EXAMINE. A folder that becomes protected, missing or nonselectable
does not receive a message FETCH. Folder rename/move is not guessed: refresh and
review the new path. Cached messages and drafts remain available.

## Identity, cancellation and progress

Each selection has a stable local UUID, exact IMAP path and server-origin binding.
The server-origin implementation comes from the separate IMAP identity change and
includes the actual server/login/TLS namespace, excluding passwords and SMTP.
An opaque connection-generation token and selection version are required when
saving or retrying. Stale native editors cannot rebind old choices to a replacement
connection. A changed server requires an explicit fresh selection review.

Same-server reconnects retain the new-UID boundary, subject to EXAMINE proving the
same UIDVALIDITY. A recreated mailbox, changed UIDVALIDITY or invalid saved checkpoint blocks downloads until
the user refreshes and saves the selection again, creating a new bounded recent-mail
baseline. The old cache is retained. Deselecting or changing the selection during
an in-flight read invalidates its commit; reconnecting does likewise.
The custom-folder phase also rechecks the round's original connection and selection
version, so it cannot adopt a replacement connection or new selection while other
accounts are being checked.

Messages, their search-index effects, the selected-folder checkpoint and successful
freshness timestamps commit in one SQLite transaction. A failed or stale commit
advances none of them. New-mail downloads do not use the history importer's cursor
or change a paused history job. Each selected folder has its own failure and retry
state, so one blocked folder does not prevent other selected folders from advancing.

`lastAttemptAt` records a real processing attempt. `lastSuccessfulSyncAt` is written
only after an acknowledged page is committed. `lastCaughtUpAt` is written only when
that page reaches its observed new-UID boundary; it does not certify old-history
completeness. Reading status or refreshing folder names never advances these values.
Transient network/provider/quota failures retain the checkpoint and persisted retry
time. Attempts occur on subsequent mailbox Sync rounds after that time, including
periodic Sync, explicit Sync and existing quota/update continuations.
Malformed data, authorization and storage failures require explicit recovery.
Retry clears the folder's block/backoff but performs no provider I/O itself.

## Service contract

All routes require the owning `X-Genmail-Account`; `all` is rejected for selection
operations. Existing native bearer, localhost/origin, JSON and update-restart guards
apply. No additional provider write permission is needed for these reads.

- `GET /api/mail/folders/sync` returns a local snapshot. The same safe projection is
  under `state.serverFolderSync[accountId]`. Private checkpoints and source details
  are omitted. Errors are fixed allowlisted text, never stored provider responses.
- `PUT /api/mail/folders/sync` accepts `folderIds`, `selectionVersion` and opaque
  `connectionVersion`. An empty list cancels the selection even with a stale catalog.
  Saving a `folder_changed` or `checkpoint_invalid` entry starts a newly reviewed baseline for that path.
- `POST /api/mail/folders/sync/retry` accepts `selectionId`, `selectionVersion` and
  `connectionVersion`; it resets local retry state and returns the new version.
  `folder_changed` and `checkpoint_invalid` require saving the selection again instead.
- The existing `POST /api/sync` optionally accepts `folderSyncSelectionVersion`
  and `folderSyncConnectionVersion` from this editor. If either is supplied, both
  must match a single connected IMAP mailbox before provider I/O. Existing callers
  with neither field retain their existing behavior.

The projection includes `supported`, `catalogFresh`, `automaticSyncEnabled`,
`intervalMinutes`, `selectionLimit`, `pagesPerRound`, and folder rows with `folderId`,
`selectionId`, `selected`, `available`, `status`, attempt/success/caught-up timestamps,
`more`, safe errors and retry fields. Rows explicitly report
`coverage: recent_page_and_new_mail`, `olderHistoryIncluded: false`,
`flagRefresh: bounded_cached_messages`, `recentPageIncomplete` and `coverageWarning`.
`current` means the last successful bounded new-UID check completed; clients display
its timestamp and coverage limitation rather than claiming continuous freshness.
`automaticSyncEnabled` reports whether the periodic interval is enabled; it does
not disable already-requested read continuations.

## Evidence and limits

The tests use generated TLS certificates, fictional IMAP sessions and temporary
stores. They cover burst pagination/restart, source and connection isolation,
in-flight cancellation/reconnect, a held custom-folder read after both target accounts'
Inbox commits, phase changes to a connection or selection, UIDVALIDITY recreation, malformed pages, network
backoff, fairness/bounds, stale/nonselectable catalog protection, explicit ownership,
observational status and transaction rollback. See [verification](../VERIFICATION.md)
for the checks actually run. Native release builds and real-account/accessibility
acceptance remain separate; these fixtures establish no live-provider reliability
or UI/performance claim. IMAP IDLE, full-history mirroring and provider-write fallback
are outside this change.
