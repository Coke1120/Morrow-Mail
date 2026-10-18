---
name: morrow-oauth
description: Use when you change OAuth, IMAP XOAUTH2, the Gmail API, Microsoft Graph, or calendar grants. Mail and calendar use separate grants.
---

# OAuth and provider grants

1. Read `docs/OAUTH.md`.
2. Keep the grants separate. IMAP baseline is `mail:addAccount`. Organize is `mail:grantOrganize`. Calendar is `calendar:connect`. Out of Office is `mail:grantVacation` and must not replace the mailbox secret when consent is partial.
3. Do not commit a Google Desktop client JSON, a client secret, or a refresh token.
4. Treat Google consent-screen Testing and OAuth verification as a hard blocker for restricted scopes. Do not invent labels or events when the grant is missing.
5. Treat Entra admin consent as a hard blocker for work and school mailboxes. Keep the IMAP folder list. Do not show stand-in labels, folders, or events.
