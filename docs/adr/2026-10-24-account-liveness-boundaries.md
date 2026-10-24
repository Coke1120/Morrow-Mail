# Account liveness at reconnect and bot access boundaries

An account removed while a reconnect awaited IMAP/SMTP could be reinserted by
email and have its credentials saved again. Retained legacy cache could also
remain readable by a formerly scoped bot using a known message ID.

Reconnect uses the existing account incarnation/epoch guard, captured before
provider waits. This includes explicit reconnect and implicit same-email add.
OAuth does not know its returned email before sign-in, so it captures the
initially connected incarnations and selects the matching one afterward.
Removed/replaced incarnations fail before synchronous account/credential writes.
The renderer preserves its selected reconnect ID across server discovery and
dialog-close cleanup, so delayed discovery cannot recast it as a fresh add.
A new connection started after removal is deliberate and remains allowed.
This does not attempt to undo provider work already underway or alter consent.

Bot service account authorization is shared across cached reads, attachment
metadata, health, agent proposals and draft proposal submit/list. After grant
membership, it requires ready storage and an existing account: `FORBIDDEN`,
`HOST_NOT_READY`, then `NOT_FOUND`. Message ownership checks still apply. Send
retains its separate grant revalidation and durable receipt contract.

Neither boundary purges legacy data or revokes unrelated grants. Offline or
reauthentication-needed connected accounts retain granted cached reads.
Synthetic tests cover deferred probes/sign-in, same-ID replacement, a deliberate
new connection, cross-protocol overlap, direct-ID and sibling bot routes, and a
fresh process reopening retained legacy cache and the same grant.
