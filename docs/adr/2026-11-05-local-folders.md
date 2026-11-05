# Independently owned Local Folders and verified transfers

Issue: [#519](https://github.com/Coke1120/Morrow-Mail/issues/519). MBOX import is
tracked separately in #521. This feature targets dev and is not a release.

Connected-account SQLite rows are a sync cache: disconnect, missing UIDs,
UIDVALIDITY resets and Gmail label pruning can remove them. Attachment downloads
are a bounded process-memory cache. Neither supplies an archive's ownership or
durability contract.

Keep a separate `local-folders.sqlite` beside the account cache. A reserved local
identity is displayed in Mail only, outside account enumeration, authentication,
sync, notifications, AI/Brain, sending, bots and account deletion. UUID folder and
message IDs do not encode a provider account or a server path. Local read and
management IPC dispatches before provider handlers and rejects cross-account
hints. Archive and Trash always exist. User folders can nest and rename without
changing identity; only empty leaf folders can be deleted. Messages move to local
Trash and can be restored locally; this version has no permanent-delete action.
Only `mail:` entity calls use local dispatch; sidebar preference invokes continue
through the existing Settings facade and its raw saved-value contract.

Store original MIME bytes, parsed text/HTML and metadata, and independently owned
binary attachment rows. The raw source retains headers that do not have visible
fields. Inline CID content uses mailparser's normal inlining and the existing
reader sanitizer/image policy. Flags and folder membership are local preferences.
Native SQLite rollback journaling, `synchronous=EXTRA` and `fullfsync=ON` commit a
complete message, its attachments and a transfer receipt together. SHA-256 and
length checks cover raw bytes, body/metadata and each attachment. Failed writes
roll back. A verification failure never resets the store or triggers remote
cleanup. Back up the database with the app stopped; there is no disposable live
copy, account-cache checkpoint dependency or attachment TTL eviction.

First server copies fetch original bytes rather than combining cached previews.
IMAP checks exact UID and UIDVALIDITY under a mailbox lock and requires a complete
RFC822.SIZE match. Gmail resolves its canonical provider ID and uses the raw API.
The transfer uses the foreground account lane and existing credential facade,
connection/incarnation checks and update-quiescence admission. Recheck source
identity after asynchronous work and before writing or submitting Trash. Limit
original MIME to 64 MiB; Gmail's existing API bound remains 35 MiB. Paged local
lists omit bodies. SQLite commits/checksums remain synchronous and bounded;
there are no claimed native frame-time improvements or unlimited import support.

Move first commits and rereads the full local copy. Persist `remote_unknown`
before submission, then use recoverable provider Trash. IMAP requires the MOVE
capability and the existing destination UID/UIDVALIDITY confirmation, with no
COPY/EXPUNGE or permanent-delete fallback. Gmail uses Trash and rechecks its
canonical provider ID and TRASH membership. Source Trash, missing Trash and
unsupported servers keep a local copy and report an unsubmitted failure.

Record confirmed completion separately from definitely unsubmitted failure and
uncertainty after submission. Failed or uncertain moves retain every local byte.
Restart never submits Trash; an uncertain receipt cannot replay, including when
another local destination is chosen. Explicit retry of a definitely unsubmitted
failure can reuse the verified copy. Canonical Gmail label copies share an
identity. Repeated requests to the same destination reuse the original local
record even if it has since moved locally. A later normal account sync reconciles
the provider cache; a failed or uncertain move never speculatively hides it.

The desktop dialog freezes selected IDs and destination before transfer. It
discloses Gmail label-wide Trash and provider retention, includes filter-hidden
selections and reports per-batch completion/error. Stop/Escape stops the remaining
messages after the current operation, not an already submitted provider move.
Local storage and partial/unknown results survive closing a window. The local
root stays outside sending/account-settings pickers. New mail selects an actual
connected sender. Local reading and attachments work after disconnect, without
credential access. Local search has its own scope; All Account Mail and global
connected-account search keep their established scope.

No MBOX import, upload/restore to a provider, local reply/AI actions, bot/CLI
extension, local permanent deletion or drag/drop is included. Provider Trash can
be emptied by its retention policy; Local Folders does not sync or make an
automatic external backup. Hardware/OS flush guarantees and live/native behavior
remain outside synthetic validation. Evidence and commands are kept in
`docs/testing/local-folders/README.md`.
