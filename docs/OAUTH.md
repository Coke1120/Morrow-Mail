# Google / Outlook OAuth (copied from Morrow-Mail)

## What was copied

| Item | Source | In genmail-rea |
|------|--------|----------------|
| Microsoft public client ID `2ca9ca19-add5-4807-bfa1-c2a7ac3cc6bf` | `Morrow-Mail/shared/microsoft-client-id.txt` | `shared/microsoft-client-id.txt` |
| Google Desktop client JSON | GitHub Actions secret `GOOGLE_DESKTOP_OAUTH_JSON` (not readable via API) | **Not in git** — set `GENMAIL_GOOGLE_OAUTH_JSON` / `GENMAIL_GOOGLE_OAUTH_FILE` or `resources/google-oauth.json` (gitignored) |
| Redirect path shape | `http://localhost:<port>/api/oauth/{google\|microsoft}/callback` | Same path prefix for Entra registration compatibility |
| PKCE + offline access | `rust/src/providers.rs` `oauth_start` | `host/mail/oauth.js` |

## Architecture gap (important)

Morrow-Mail uses **Gmail API + Microsoft Graph**. genmail-rea’s mail engine is **IMAP/SMTP** (imapflow / nodemailer).

Therefore this port requests **IMAP XOAUTH2 scopes**:

- Google: `https://mail.google.com/` (+ openid email)
- Microsoft: `https://outlook.office365.com/IMAP.AccessAsUser.All`, `https://outlook.office365.com/SMTP.Send`, `offline_access`

Leo must confirm the shared Entra app allows those IMAP scopes (or register a sibling app). Google Desktop client typically already allows `mail.google.com` if Gmail API is enabled.

## Wire-up

- UI one-click (`mail:addAccount`) now opens system browser OAuth instead of returning `oauth_unavailable`.
- Tokens (refresh + access metadata) stored via Keychain / Windows DPAPI (`host/mail/secrets.js`).
- Password IMAP path (`mail:connectImapSmtp`) unchanged.

## Leo actions

1. Copy `GOOGLE_DESKTOP_OAUTH_JSON` from Morrow-Mail secrets into local env or genmail-rea Actions secret.
2. In Entra, add IMAP/SMTP delegated permissions + public client + localhost redirect path `/api/oauth/microsoft/callback`.
3. Do **not** commit client secrets or user refresh tokens.
