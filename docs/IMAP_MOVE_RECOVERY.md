# IMAP move recovery

This feature is a reviewed provider operation. It is not a background migration or
an automatic retry. On servers advertising MOVE and UIDPLUS, the existing UID MOVE
path remains preferred. A server advertising UIDPLUS without MOVE can instead use
one UID COPY, one targeted deletion flag, and one UID EXPUNGE. This sequence is not
atomic: two copies can remain after an interruption.

Each mutation has a durable intent saved before it is sent. The encrypted local
journal retains uncertain operations across restart and never replays them. A
COPYUID must describe exactly the requested source UID and one destination UID,
with the destination's verified UIDVALIDITY. A missing or ambiguous COPYUID cannot
be recovered by guessing from subjects, Message-ID, or similar messages. A failed
or uncertain UID MOVE never falls back to COPY.

The protocol and its journal work share a 45-second absolute budget. Cancellation
discards the owned connection. There is no reconnect or retry within the operation.
At most 100 unfinished operations are retained across the workspace; capacity is
reserved before any provider mutation. Unfinished records are never evicted. The
latest 20 completed/resolved records per account remain as history.

After the exact destination is confirmed, adoption preserves the stable local
message ID, body, read/star choices, Pending marker, and unrelated local
overrides. It clears missing-source markers and invalidates source-folder
MODSEQ/connection/epoch proofs. A later read must obtain the destination's flags;
the old folder's watermark cannot certify them. The cache update and journal
completion commit together.

## Native contract

Every request supplies the exact connected mailbox in `X-Genmail-Account`; `all`
and Demo are rejected. Routes below are prefixed with `/api` by the native client.

`GET /mail/moves` is local-only and returns `accountId`, the current opaque
`connectionRef`, and bounded `operations`. Each operation contains:

- `id`, changing `operationRef`, `accountId`, its captured `connectionRef`;
- `messageId`, `subject`, `sourceName`, `targetName`, `createdAt`, `updatedAt`;
- `stage`, `status`, fixed `diagnosticCode` and `diagnostic`;
- `canPreview`, `canResolve`, `canFinish`, nullable `finishAction`, nullable
  `reviewRef`, and `automaticRetry: false`.

The list does not contain credentials, raw provider responses, message bodies,
attachments, or persisted command payloads. Its account must match the captured
native mailbox. Changing scope or disconnecting invalidates an open review.

`POST /mail/moves/{id}/preview` takes `{operationRef}`. The user-facing action is
**Check provider**: it explicitly performs read-only checks of the exact recorded
copies and UIDVALIDITY values. It returns `{accountId, connectionRef, operation}`.
A fresh result can offer `completeMove` (source remains) or
`applyConfirmedResult` (source absent and destination present). Unknown COPYUID
never enables either action. Provider checks do not run merely by opening or
refreshing the local journal.

`POST /mail/moves/{id}/finish` takes
`{operationRef, reviewRef, confirmed: true}` after a complete review of mailbox,
subject, source, target, action, and diagnostic. The one-use review expires after
five minutes. The server checks both exact copies again and never sends COPY.
It may mark/remove only the recorded source UID, or apply an already confirmed
result locally. The response is the same envelope, with `message` on success.

`POST /mail/moves/{id}/resolve` takes
`{operationRef, confirmed: true, resolution: "reviewedExternally"}`. It performs
no provider action and records only that the user handled the operation in the
provider. It does not claim the message was moved successfully. This action can
close a record whose captured connection is no longer current.

All successful record updates rotate `operationRef`; use the returned operation
or explicitly refresh. The operation and review references already bind the
captured connection, so no additional connection reference is required in a POST.
The response's top-level connection reference describes the current connection;
the operation's reference describes the original one.
Public account settings expose the matching opaque `moveConnectionRef`, so a
credential or generation change on the same host also invalidates native review.

Initial organize, Trash, and undo-Trash failures with a reserved journal return
`code: "imap_move_unresolved"`, `accountId`, `operationId`, and a fixed safe
message. These existing result locations lead to the recovery UI. Status values
are `uncertain`, `partial`, `providerComplete`, `completed`, and `resolved`.

## Deliberate recovery limits

Connection or source-location changes invalidate provider recovery; local
`reviewedExternally` remains available. The server will not merge or delete local
state if ordinary sync already downloaded the destination as another stable local
message ID. That conflict is `cached_destination_conflict`; inspect both copies in
the provider and resolve the record manually. Neither this flow nor its fixtures
establish live-account acceptance or an atomic multi-command move.

The final Linux candidate passed formatting, strict Clippy, 17 protocol/API/state
controls, one safe-error unit, and the complete Rust suite (474 passed, 0 failed,
4 existing ignored). Native portable controls are separate from SwiftUI/WinUI
compilation and execution, which remain pending. See
[verification and preserved failures](../VERIFICATION.md#imap-move-recovery-candidate--15-october-2026).
