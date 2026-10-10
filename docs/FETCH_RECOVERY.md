# Fetch recovery changes — unreleased

These source changes repair omissions found in the October 2026 fetch review. They do not turn bounded Sync into a complete mailbox mirror or establish native/live-account acceptance. See [verification](../VERIFICATION.md).

## Dates and catch-up

IMAP uses the provider's INTERNALDATE consistently for search, import windows and the stored sorting date, including Sent. A parsed sender Date, apart from the parser’s epoch sentinel, is retained separately as `senderDate`. Server day searches overlap the UTC boundary and the client applies the exact range, addressing the reproduced gap between the recent seven-day pass and older history when sender/receipt dates or timezone days differ.

Outlook delta expiration retains the original live-sync boundary. A completed history import permits catch-up across its approved date range; paused or unfinished history keeps its existing cutoff and live sync can still recover later arrivals. Older checkpoints are rebuilt once to repair the previous baseline omission. Explicitly blocked checkpoints are not silently unblocked. Local mail remains cached throughout recovery.

Gmail reads accept the provider-supported catalog of up to 10,000 labels. The organization destination picker retains its separate 1,000-entry bound; that limit no longer disables reading ordinary mail. Missing friendly label names do not discard label identities.

## Partial content and manual recovery

History completion means the selected pages have been processed, not that every body or attachment is fully downloaded. A message whose content exceeds a supported processing limit keeps its verified provider identity and safe metadata, with an explicit incomplete-content record. Healthy messages on the same page can be saved atomically with the checkpoint. Account settings and CLI status show the current count of incomplete messages; repeated scope visits do not inflate it, and successful recovery removes it.

Open an incomplete message and use **Load attachments and inline images**, or CLI `fetch`, to request its full MIME. Forward and provider-draft copy preparation also try to obtain required content. A failed download preserves the incomplete record and existing cache. A successful bounded parse repairs content and missing reply metadata without replacing the provider receipt date. Provider/parser limits may still prevent loading; the original can be read at the provider if it remains available there.

Downloaded bodies survive subsequent size-limit placeholders for the same immutable provider identity. Conflicting nonempty Message-IDs prevent reuse of previously downloaded bodies and attachments. Mutable provider drafts still refresh and invalidate downloaded content where necessary. Incomplete legacy Gmail caches receive full content when reconciled, including Reply-To, even outside the newest page. Known permanent Gmail content-limit records can refresh their metadata without repeatedly reparsing the same unsupported body; explicit MIME loading is their recovery route.

Outlook lists request metadata before individually bounded bodies. The JSON response cap is unchanged, and an oversized individual body is represented explicitly rather than stopping unrelated messages. An old saved full-body page that cannot fit the cap requires restarting that import; its checkpoint and cached mail remain intact. Graph requests share a conservative process-wide limit of four concurrent requests, including raw content and calendar operations.

## Errors and checkpoints

Recognized transient IMAP transport errors participate in the existing persisted history backoff. Authentication, certificate/trust, malformed protocol, cursor and storage failures do not become automatic retries.

An IMAP UID with unresolved metadata/body is skipped only after a successful check confirms it was expunged. A still-existing unresolved UID leaves the page checkpoint unchanged and reports an incomplete-page error. Missing or malformed IMAP INTERNALDATE or the applicable Outlook provider date likewise stop the page with a fixed safe error; they are not replaced with 1970 or the current time. This change does not validate every Gmail date path. Resume retries the retained page, but a persistent provider data error must be corrected at the provider before that page can succeed. An unresolved IMAP FETCH does not advance the page checkpoint merely to report completion.

Account ownership, reconnect/pause stale-result checks, page/checkpoint transactions, quota cooldown and uncertain-send protections remain required. These read-recovery changes do not authorize automatic sending or other provider writes.

## Existing IMAP identity limitation

IMAP cache identity uses account, folder, UIDVALIDITY and UID; it has no server-origin namespace. Reconnecting the same account to a different server can collide with an old identity. The Message-ID check only rejects contradictory nonempty IDs: a missing or reused Message-ID does not establish identity, and existing local metadata can still be inherited. This limitation needs a separate identity migration and is not resolved by the content-preservation fix.

## Native presentation

Windows observes service revisions, refreshes mounted mail/search and the selected reader, and retains the bounded page position and selection where possible. Revision-invalidated cursors recover through the existing numeric page/offset contract. Failed navigation restores usable paging controls. macOS remains the behavioral reference; both account settings views expose incomplete-content warnings.

New Windows smoke assertions and macOS source changes must still be compiled and executed on their respective platforms. Linux Rust fixtures verify backend behavior only. Clean-machine, accessibility, signing, installed-updater and real-account acceptance remain separate gates.
