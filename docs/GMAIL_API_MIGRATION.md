# Gmail API migration: staged draft coverage

Status: **incomplete draft; migration is not available in the app.** This branch contains a Gmail-only Trash correction and an API transport foundation. It does not narrow requested/granted scopes, switch any account from IMAP/SMTP, move user data, start OAuth or change Google Console settings. Do not describe this draft as a completed Gmail provider.

The user approved Gmail API migration/narrower scopes after the original plan-only request. The API layer is implemented first because removing `mail.google.com` while the engine still needs IMAP/SMTP would break mail. The existing `mail:upsertDraft`, Send/reply, attachments, sync/cache/body download and aliases continue using the existing engine in this draft. Microsoft OAuth and generic IMAP/SMTP are preserved. Continue with Google remains OAuth in the eventual migration.

## What changes now

`host/mail/actions.js` no longer accepts permanent Gmail deletion for `mail:deleteBatch` from Trash. It turns that request into ordinary Trash, with already-trashed mail left there. The executor refuses persisted legacy Gmail permanent intents before acquiring credentials or issuing a write, including local-only intents. Ordinary Delete/thread Trash still use the existing move journal/Undo path. Mixed-provider batches apply Gmail policy per actual account; Microsoft/other IMAP retain their prior deletion-from-Trash behavior.

`host/mail/remote.js` associates each created IMAP client with its account. All Gmail `removeUid` calls, including remote draft replacement, discard and post-send cleanup, now move the old copy into the actual server Trash folder instead of calling ImapFlow `messageDelete`. Missing Trash/failed folder discovery fails before a deletion write. An already-trashed Gmail copy stays there. No generic IMAP/Microsoft deletion primitive changes. Moving old drafts to Trash is a deliberate Gmail retention change; Gmail/provider Trash retention still applies. This is not proof of immediate erasure or a new permanent-delete API.

Before this draft, ordinary Delete already moved to Trash. The actual permanent path was batch Delete **from Trash**, plus IMAP draft cleanup. No existing Gmail HTTP `messages.delete`/`threads.delete`/`messages.batchDelete` request was found. Do not claim a bypass-Trash Inbox UI action was removed.

## Implemented API primitives, currently unwired

`host/mail/gmail-mail-api.js` is imported by synthetic tests only, not the production engine. It accepts an explicit token supplier and optional account-liveness check/cancellation signal; it never opens OAuth or reads credentials. Requests are pinned to Gmail's API with redirects refused and no automatic write retry.

| API operation | Coverage in this draft |
| --- | --- |
| Message lists/search/history | Bounded pages with continuation tokens, label/query filters, string provider/history ids and explicit expired-history signal. No UID coercion. |
| Body/MIME/attachments | Full/metadata/raw message reads, checked base64url raw MIME and attachment bytes. Body parsing/cache projection remains in the integration backlog. |
| Drafts | List/get/create/update with complete MIME/thread id; Save never sends. Discard resolves the draft's message and trashes it; no draft/message permanent-delete method. |
| Send/reply/attachments | Explicit confirmed send of prepared MIME/thread id preserving headers/content. No automatic retry after a lost acknowledgment. Engine delivery-receipt/idempotency integration remains outstanding. |
| Read/star/archive/labels | Message modify primitives; reuse existing label list/create/rename/nest/delete implementation. Label deletion does not delete mail. |
| Trash/restoration | Snapshot membership, trash, untrash and restore missing prior folder labels without clearing later read/star/new-label changes. No permanent-delete API is exposed. |
| Error/cancel behavior | 401/403 scope failure, 429 retry-after, ambiguous network/5xx writes, invalid data and cancellation reported explicitly. |

The exported **target** mail request is `openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.settings.basic`. It is not used by current authorization code. `gmail.modify` covers the intended mail read/compose/send/flags/labels/Trash methods, so separate `gmail.send`, `gmail.compose` and `gmail.labels` would be redundant. Settings/filter/vacation/send-as operations retain `gmail.settings.basic`. Calendar's target request is separate: `openid email calendar.calendarlist.readonly calendar.events` with full URIs in the module. Neither declaration changes actual requests or existing grants.

Current actual Google request remains `openid email mail.google.com gmail.modify calendar.calendarlist.readonly calendar.events gmail.settings.basic gmail.labels` (full URIs in `oauth-config.js`), with the full Google bundle and existing incremental inclusion. Restricted Gmail scopes and Google's determination of verification/CASA remain relevant. Do not call current broad grants narrowed.

## Remaining work before scope switching

1. Add persisted Gmail message/thread/draft ids and transport/cursor state to the cache, without treating provider ids as numeric IMAP UIDs. Map existing cached copies using trustworthy provider evidence; RFC Message-ID alone can be duplicate/ambiguous. Preserve account/local message ids, labels, unsent draft revisions/correlations, scheduled payloads, outstanding action receipts, horizon and search/body-progress state. Surface ambiguity rather than dropping or duplicating local work.
2. Route every Gmail OAuth engine operation to the adapter: folder/history polling, horizon/backfill/reconciliation, header/full-body reads, read/star/Trash/Undo/move, provider/server search, MIME attachment open/save/ZIP, send-as identity checks, draft revision/partial-delivery recovery, Send and scheduled send. Do not narrow scopes while any required Gmail path still opens IMAP/SMTP. Gmail API polling/history replaces IDLE; show truthful status and handle expired cursors.
3. Add an explicit reviewed migration action on the existing account, preserving its id/local work. Explain the new transport/scopes and optional Calendar, then validate the new token before switching the account marker/credential. Cancellation, account mismatch/removal, partial grants and storage/crash failures preserve existing usable credentials/work. No delete/recreate instruction, silent migration or unexpected grant request.
4. Separate Google mail and Calendar consent/gates in the engine/sidecar without changing Microsoft resource separation. Preserve legacy Calendar records and actual granted-scope metadata. Display requested and granted scopes separately, visibly flag remaining broad grants, and explain deliberate Google-side revoke/re-consent. A narrower request or refresh does not prove Google's old broad grant was revoked.
5. Extend integrated synthetic tests across legacy and new account records, duplicate/large/labelled mail, interrupted backfills, drafts/attachments/send receipts, races/Undo, no Gmail IMAP/SMTP fallback and unchanged Microsoft/password behavior. Full repository/exact-head CI, truthful Features/help and rendered/native review remain gates. The earlier blocked browser file navigation/daemon access must not be retried or bypassed.

These are concrete integration gaps, not provider verification evidence. Completing them requires a separate reviewed continuation of this draft, not simply deleting scope strings. This draft stays unmerged and unreleased.

## Relationship to disclosures and evidence

AI consent is separate [Morrow draft PR #302](https://github.com/Coke1120/Morrow-Mail/pull/302); its [least-privilege plan](https://github.com/Coke1120/Morrow-Mail/blob/b7d43ada2aad3590c00a503d4df8093a11498e2b/docs/GMAIL_LEAST_PRIVILEGE_PLAN.md) maps current feature/scopes and phases. Public disclosures are separate [hwl-hk draft PR #21](https://github.com/Coke1120/hwl-hk/pull/21), reviewed at `5b788a754db29471161cca75fccd3b640e687dfa`; its ADR requires exact final Gmail coverage before publication. Coordinate through the parent; none of these drafts is a deployed policy or released application.

Outstanding evidence: actual Console approved/requested scopes, domain ownership/authorized URLs, final public policy/terms, actual provider retention/training terms, synthetic demo of real migration/consent UI, local/derived-data deletion instructions and Google's assessment/verification determination. No secrets, Console access, real authorization or mailbox/model requests were used.

Sources checked 2026-10-25: [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Trash](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/trash), [message get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get), [send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send), [modify](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify), [minimum scopes](https://support.google.com/cloud/answer/13807380), [verification FAQ](https://support.google.com/cloud/answer/13463817?hl=en). The requested `drafts.update` page timed out; that primary page was not reread by another route, so live provider behavior remains unverified. The adapter's PUT wire shape is covered by synthetic tests, not a claim of live validation.
