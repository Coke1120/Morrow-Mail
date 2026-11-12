# Reviewed mailing-list unsubscribe

## Decision

Show an Unsubscribe banner in the normal and independent message readers only
when downloaded Gmail API or IMAP headers contain a supported, safe
`List-Unsubscribe` destination. Outlook, Yahoo and custom mailboxes use the
existing IMAP path. No new OAuth scope, provider setting or subscription state is
introduced. Local Folders and outgoing drafts do not offer this server action.

Keep a minimal parsed record in `messages.list_unsubscribe_json`, separate from
recipient evidence. NULL means an older cache has not been checked. Ordinary
opening of complete cached mail stays immediate and performs no extra provider
read just for these headers. Explicit Reload message / Retry download
can fill missing metadata through the existing bounded source read. New sync/body
downloads capture it naturally; there is no background whole-mailbox backfill.
Already downloaded text remains available after a failed refresh. A checked
message without usable unsubscribe headers has no banner. Do not scrape body links or infer a list from its sender.

The renderer receives only an action kind and destination label. The host
re-resolves the exact account/message and stored destination, shows a native
review naming the mailbox, sender and destination, then rechecks ownership and
metadata before any external action. Concurrent clicks share a host guard, and
stale confirmations cannot act on a different message or account incarnation.

## Supported actions and limits

Parsing is bounded to a complete header section within 64 KiB, eight destinations
and 4,096 characters per URI. Ambiguous duplicate List-Unsubscribe fields are
ignored. Unsupported/unsafe destinations do not become action buttons. Mailto
supports one recipient, up to 512 subject characters and 2,048 body characters;
control characters, including encoded CR/LF, and additional headers are rejected.
DNS preflight waits at most five seconds and requires every returned address to
be public. These conservative limits can hide some sender unsubscribe options.

- HTTP(S) destinations open in the default browser after confirmation. Credentials,
  controls, unsafe ports, private/local hosts and unsafe DNS answers are rejected.
  DNS preflight does not control a separate browser's subsequent DNS resolution,
  redirects, cookies or signed-in state. The review discloses this boundary.
  Opening a site is not proof of a completed unsubscribe; more steps may be needed.
- A supported `mailto:` destination prepares a new compose review with the owning
  mailbox and only the advertised recipient, subject and plain-text body. The
  captured source message uses the existing owned-recipient policy to select From,
  rather than a different preferred new-mail alias. Users still review From. Cc/Bcc,
  arbitrary mail headers and automatic signatures/default recipients are excluded.
  Nothing sends until the user reviews it and chooses Send. The normal compose
  send preview and provider restrictions still apply.
- RFC 8058 candidates require native approval, then fresh complete original MIME
  verification with pinned mailauth 8.0.6. A cryptographically valid SHA256 DKIM
  signature must cover From and both unique list headers, the complete body (no
  l= limit), with valid timestamps and no testing key. Authentication-Results is
  never proof. Standard system DNS establishes DKIM keys; this is not DNSSEC,
  DMARC alignment, sender reputation, or proof of eventual removal.
- IMAP streams originals up to 64 MiB through the DKIM verifier with bounded
  chunks and a 64 KiB header prefix. Exact UID, UIDVALIDITY and declared byte count
  are rechecked, and verified proof requires complete EOF. Early verification
  rejection, oversized/incomplete streams, cancellation and identity changes
  destroy the provider download and release its mailbox lock.
- Gmail deliberately retains a bounded-buffer fallback: its raw endpoint returns
  MIME inside base64url JSON. A counted response reader stops/cancels oversized
  or aborted responses before JSON parsing; decoded MIME retains the existing
  35 MiB cap and then enters the streaming verifier in bounded chunks. Gmail raw
  fetching is not claimed to be fully streaming. This avoids introducing an
  unreviewed incremental JSON/base64 parser into the authenticated provider path.
- Total read/verification deadline is 60 seconds with upstream cancellation;
  queued expired work cannot download or POST. DNS verification remains bounded
  to five seconds. Complete body verification is never replaced by header-only,
  preview, partial body, or a signature using l=. Pathological oversized MIME
  lines over 1 MiB are conservatively refused so streaming canonicalization stays bounded.
- The proof must match exactly the previously reviewed HTTPS URL. POST pins one
  address from an all-public DNS result, verifies TLS for the original hostname,
  sends only List-Unsubscribe=One-Click as application/x-www-form-urlencoded and
  uses no shared agent, proxy, cookies, credentials, redirect or retry. DNS/connect
  limits are five seconds, total POST fifteen seconds, response headers 16 KiB
  and body 64 KiB. Identity is rechecked immediately before dispatch.
- Failed/oversize/incomplete verification offers a separate manual confirmation.
  HTTP 2xx is accepted request, not confirmed removal. Non-2xx is rejected;
  connection uncertainty is unconfirmed. Neither triggers retry or fallback.
  No proof is persisted or accepted from renderer IPC.

No unsubscribe network request runs on render, sync or message selection. No bulk unsubscribe,
SMTP auto-send, background subscription job, sender block, spam flag or deletion
is added. No CLI, MCP or bot unsubscribe action is exposed. External launch
failures can have an uncertain result; the UI does not automatically retry or
claim subscription state changed. Window-local notices are not durable receipts
and cannot prove what a sender did after the browser opened or email was sent.

## Verification

Synthetic parser/action, provider/cache/native-dialog and renderer/Features
fixtures are included in `npm run check`. They use no real mailbox, subscription,
credentials, unsubscribe endpoint or browser launch. CI covers Node on Linux and
Windows. Native macOS/Windows dialog rendering and live sender workflows require
manual validation and are not claimed by these fixtures.
