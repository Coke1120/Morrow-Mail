# Gmail API before narrower mail requests

Status: implemented in draft PR #305, pending review/release. Supersedes the initial primitive-only staging boundary.

The user approved separate Gmail migration implementation because Morrow does not need bypass-Trash permanent deletion. Removing full-mail scopes while Gmail still used IMAP/SMTP would break normal mail. This draft therefore introduces stable provider-id/cache mapping and a complete API engine route before requesting gmail.modify + gmail.settings.basic for new/migrated OAuth mail. Google OAuth login stays; Calendar is separate. Microsoft and password transports remain compatible.

Existing accounts require reviewed reauthorization, preserve account/local data and retain omitted grants. A narrower request does not revoke earlier broad grants; requested/received scopes remain distinct and displayed. Pending/unknown actions block transport migration. Ambiguous legacy identities or write outcomes fail for review rather than guessing or automatically resubmitting. Gmail Trash replaces actual permanent paths: batch Delete from Trash and old remote draft cleanup. Other-provider deletion semantics stay unchanged.

The API has bounded list/history backfill, lazy MIME/attachments, drafts, send/receipts/schedules, flags, labels/search and Trash/Undo, with no migrated Gmail IMAP/SMTP fallback. Gmail API uses polling/history rather than IDLE. Credential-store/SQL reported failures are compensated, without claiming process-crash atomicity across both stores. See [exact coverage and validation limits](../GMAIL_API_MIGRATION.md).

Consent PR #302 is already integrated; this draft preserves it and the original published Gmail history with a non-force merge. This Gmail task does not merge/release #305 or modify the policy site. The policy owner separately published hwl-hk #21/#22 at `179adf38a1d6f0b52472c8420e89a9b6427df26d`; those disclosures describe released v0.2.38, not unreleased #305. Native/live grant/registration/demo and Google verification/CASA evidence remain review gates. No Console/live mailbox/model action or retry/bypass of blocked browser/daemon access occurred.
