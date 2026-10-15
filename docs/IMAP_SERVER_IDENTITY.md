# IMAP server identity and migration

The current source separates an IMAP message's origin from its reconnect generation.
The origin is a versioned digest of the validated IMAP host, effective port,
implicit-TLS transport and exact LOGIN principal. The current transport uses the
validated account email as LOGIN; it has no separate username setting. DNS host
case and a terminal root dot normalize to the same host. Password changes, SMTP
settings and reconnect generation do not change this origin. Host aliases are
kept separate; DNS lookup results and certificate fingerprints are not identities.

Imports and cached-body lookups match account, origin, provider folder,
UIDVALIDITY and UID. Reconnecting the same email to another host or port cannot
inherit the old message's body, attachments, Pending, local folder, labels or
stars, even if both servers return the same UID tuple and Message-ID. Existing
local message IDs remain stable. A new colliding origin receives a distinct
local ID; `remoteId` remains the provider UID tuple. Returning to the original
server can match its retained messages again.

## Before upgrading

Close the app and make a backup with the currently installed service, or copy
the complete closed workspace including its matching `encryption.key`, before
opening an important workspace with this source. The new service opens and
migrates a workspace before its own backup operation, so that later backup is
not a pre-upgrade downgrade copy. No user backup was created as
part of these synthetic tests. Opening upgrades the workspace marker from 1 to
2 in the same transaction as the identity migration. The tested prior service
rejects that marker before writing. Downgrading requires restoring a complete pre-upgrade
backup, including its matching encryption key; do not edit the marker to bypass
the guard.

The migration processes bounded batches of metadata. It does not rename local
IDs, delete messages, remove attachments, change draft references, discard user
flags or advance history/reconciliation checkpoints. It derives each legacy
message's origin only from that message's saved `bodyConnection` or
`imapSyncConnection`. Conflicting, malformed or absent evidence becomes
`imapOrigin: "unbound"`. The current account connection is never used to assign
an unknown message's source. Failure rolls back all origin markers and the
workspace version together. Existing FTS, thread and folder-membership creation
remain in the same enclosing store transaction.

## Retained copies and recovery

Downloaded content remains readable locally. A cached message from another or
unverified source cannot fetch raw MIME, change flags, move or participate in
provider reconciliation against the current source. The service rejects such
actions before network access with `imap_origin_unverified` and an explanation:
reconnect the original server for a proven old copy, or sync/import the current
server and use the newly fetched copy. An unbound copy stays retained; this
change does not add a manual source-reassignment operation. Older unproven cache
may therefore coexist with a newly verified copy.

Folder catalogs from a different origin are not presented or used to inherit
hidden-folder state. Same-origin reconnects retain their stale catalog until
refresh. Confirmed folder rename/delete results update only messages from the
captured current origin and history cursors from its current connection; retained
foreign or unbound copies keep their original provider paths.
History cursors, sync scope/date inputs and completeness require a
matching, nonempty connection generation. An old job remains stored, but after
reconnect its public status requests a new import and does not claim coverage or
progress for the new connection. An unversioned legacy IMAP job cannot resume
automatically or explicitly; reconnect and start a new import. Starting an IMAP
import without a nonblank connection generation is rejected before any job or
checkpoint write with `imap_connection_unverified` and reconnect guidance.
UID checkpoints, MODSEQ epochs and
read commits keep their existing connection checks and atomic transactions.
Provider writes still require the existing permissions and explicit user action;
uncertain writes are never replayed.

## Limits

This migration cannot recover content or state already overwritten before the upgrade.
A server replacement behind the same endpoint and LOGIN remains dependent on
the provider honoring UIDVALIDITY; aliases or changed ports deliberately create
separate sources. Selected-folder continuous sync, IDLE, session reuse and move
fallback are separate work. Synthetic SQLite and loopback protocol tests do not
establish live-account, native UI, large-workspace migration latency or signed
release acceptance.
