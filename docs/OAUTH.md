# Google / Outlook OAuth

GenMail REA keeps **IMAP XOAUTH2 as the mail baseline** and adds a provider API side-car. Calendar is a separate OAuth purpose with its own token. No client secret belongs in git.

## Baseline vs side-car

| Purpose | What it unlocks | Google scopes | Microsoft scopes | Redirect path |
|---------|-----------------|---------------|------------------|---------------|
| IMAP (first consent, `mail:addAccount`) | IMAP and SMTP XOAUTH2 | `openid email https://mail.google.com/` | `offline_access` `https://outlook.office365.com/IMAP.AccessAsUser.All` `https://outlook.office365.com/SMTP.Send` | `/api/oauth/{google\|microsoft}/callback` |
| Organize (second consent, `mail:grantOrganize`) | Gmail labels or Graph mailFolders | IMAP scopes plus `https://www.googleapis.com/auth/gmail.modify` | IMAP/SMTP scopes plus `offline_access User.Read Mail.ReadWrite Mail.Send` | same `/api/oauth/.../callback` path |
| Calendar (`calendar:connect`) | Google Calendar or Graph calendars | `openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events` | `offline_access User.Read Calendars.ReadWrite` | `/api/calendar-oauth/{google\|microsoft}/callback` |

The organize consent asks for the IMAP scopes again so one grant can keep XOAUTH2 when the provider returns both. If `gmail.modify` or `Mail.ReadWrite` is missing from `grantedScopes`, label and folder changes stay on the IMAP folder list. Calendar calls run only when the calendar marker is in that purpose's `grantedScopes`.

Tokens are stored per account and purpose (`grantedScopes`, refresh token, access token) in the keychain / DPAPI / `GENMAIL_MAIL_SECRETS=memory`. The renderer receives scope strings, not tokens.

`oauthReady().google` is false until a Desktop client JSON is available. The app and `npm run check` run without that file. Live Google calls are refused with `oauth_not_ready` until it is set. Microsoft uses the public client id in `shared/microsoft-client-id.txt` and has no client secret.

## Redirects

Loopback is `http://localhost:<port>` with the port chosen when the browser opens. The path is matched exactly:

- `http://localhost:<port>/api/oauth/google/callback`
- `http://localhost:<port>/api/oauth/microsoft/callback`
- `http://localhost:<port>/api/calendar-oauth/google/callback`
- `http://localhost:<port>/api/calendar-oauth/microsoft/callback`

## Google Cloud checklist

Do this in the same Desktop client Morrow-Mail uses. Do not paste the secret into the repo, a PR, or this doc.

1. OAuth consent screen. Add the scopes above: `openid`, `email` / `userinfo.email`, `https://mail.google.com/`, `https://www.googleapis.com/auth/gmail.modify`, `https://www.googleapis.com/auth/calendar.calendarlist.readonly`, and `https://www.googleapis.com/auth/calendar.events`.
2. Enable the Gmail API and the Google Calendar API on the project.
3. Create an OAuth client of type **Desktop**. Download the JSON (`installed.client_id` and `installed.client_secret`).
4. Provide it at runtime as `GOOGLE_DESKTOP_OAUTH_JSON`, `GENMAIL_GOOGLE_OAUTH_JSON`, `GENMAIL_GOOGLE_OAUTH_FILE`, or `resources/google-oauth.json` (gitignored). `MORROW_GOOGLE_OAUTH_JSON` / `MORROW_GOOGLE_OAUTH_FILE` are accepted aliases.

### Hard blocker: Testing and verification

`https://mail.google.com/` and `gmail.modify` are restricted scopes. `calendar.events` is sensitive. While the consent screen is in **Testing**, only listed test users can consent, and refresh tokens expire after about seven days. Production use needs Google's OAuth verification, and restricted scopes also need a security assessment. Until that is done, Google sign-in is limited to test users. The app will not invent labels or events to paper over a missing grant.

Desktop clients accept loopback redirects on any port. The paths above are what the app sends.

## Entra checklist

The shared public client id stays `2ca9ca19-add5-4807-bfa1-c2a7ac3cc6bf` (`shared/microsoft-client-id.txt`). This change does not rotate it. There is no client secret.

1. Authentication: allow public client flows. Register both redirect paths (`/api/oauth/microsoft/callback` and `/api/calendar-oauth/microsoft/callback`) as public-client localhost redirects. The port is chosen at runtime. A registered URI of `http://localhost` with that path is what the sign-in uses; a fixed port in the tenant will fail until it matches.
2. Delegated permissions:
   - Office 365 Exchange Online: `IMAP.AccessAsUser.All`, `SMTP.Send`
   - Microsoft Graph: `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `offline_access`
3. Do not commit user refresh tokens.

### Hard blocker: admin consent

Work and school mailboxes cannot grant those delegated permissions until an admin consents on the shared Entra app. A missing admin consent is a provider error. The mailbox keeps the IMAP folder list and does not show stand-in labels, folders, or events.

## What the UI does when a grant is missing

- No Google Desktop JSON: Google buttons explain that OAuth is not configured. Microsoft can still start.
- No `gmail.modify` / `Mail.ReadWrite`: the sidebar says so and offers the second consent. IMAP folders stay. No stand-in label list.
- No calendar grant: the calendar page says it needs a grant. It does not draw a month of events. After a grant, the month grid shows only events returned by Google Calendar or Graph for that range. An empty month says there are no events.

## Wire-up

- `mail:addAccount` is the IMAP baseline.
- `mail:grantOrganize` stores the organize token on that mailbox after the email matches.
- `calendar:connect` stores the calendar token the same way.
- `mail:listProviderFolders`, create, rename, and delete call Gmail labels or Graph `mailFolders` only when the organize marker is granted.
- `mail:modifyMessageLabels` and `mail:moveProviderMessage` use the provider message id looked up by RFC Message-ID.
- `calendar:list` and `calendar:createEvent` call the calendar APIs for a month range.
