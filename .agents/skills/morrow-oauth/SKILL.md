---
name: morrow-oauth
description: Use when you change OAuth, IMAP XOAUTH2, the Gmail API, Microsoft Graph, or calendar grants. Google uses one full consent; Microsoft separates Outlook mail and the Graph bundle.
---

# OAuth and provider grants

1. Read `docs/OAUTH.md`.
2. Follow the full grant model: Google requests mail + calendar + organize + Out of Office + rules in one consent. Microsoft uses Outlook-only IMAP/SMTP consent followed by one Graph-only bundle (`User.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `MailboxSettings.ReadWrite`, and `Mail.Read` for rules folders). Never mix these resources on authorize URLs or token requests. Feature grant channels reuse sufficient saved tokens or request the provider bundle. Preserve legacy grants and mailbox credentials after partial consent; Bot bridge stays separate.
3. Do not commit a Google Desktop client JSON, a client secret, or a refresh token.
4. Treat Google consent-screen Testing and OAuth verification as a hard blocker for restricted scopes. Do not invent labels or events when the grant is missing.
5. Treat Entra admin consent as a hard blocker for work and school mailboxes. Keep the IMAP folder list. Do not show stand-in labels, folders, or events.
