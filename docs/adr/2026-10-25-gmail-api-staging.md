# Stage Gmail API support before changing mail grants

Status: incomplete draft, not shipped.

The user does not need bypass-Trash permanent deletion and approved narrower Gmail scopes with continued Google OAuth. The current engine still relies on IMAP UID/UIDVALIDITY, SMTP receipts and draft correlation. Removing full-mail scopes without integrating those paths would break connected mailboxes and risk local drafts/actions.

Implement/test explicit Gmail API primitives first. Correct current Gmail deletion paths to Trash, including old remote draft cleanup, while preserving Microsoft/other-provider behavior. Keep the adapter unavailable and current scope requests unchanged until persisted provider ids/cache backfill, all engine operations, explicit migration/reauthorization and separate Calendar grants are complete. Smaller requested scopes do not imply older broad granted scopes disappeared. No silent account migration or delete/recreate flow.

This staged draft exposes its incomplete status in Features/Accounts help and [coverage documentation](../GMAIL_API_MIGRATION.md). It is separate from AI-consent PR #302 and the independently released timeout/Bodies changes. Do not merge, release or claim narrowed Gmail grants based on this foundation. Google still determines verification/CASA from actual scopes/data flows.
