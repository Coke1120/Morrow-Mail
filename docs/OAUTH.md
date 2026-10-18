# Google / Outlook OAuth

Morrow Mail keeps **IMAP XOAUTH2 as the mail baseline** and adds a provider API side-car. Calendar is a separate OAuth purpose with its own token. No client secret belongs in git.

## Baseline vs side-car

| Purpose | What it unlocks | Google scopes | Microsoft scopes | Redirect path |
|---------|-----------------|---------------|------------------|---------------|
| IMAP (first consent, `mail:addAccount`) | IMAP and SMTP XOAUTH2 | `openid email https://mail.google.com/` | `offline_access` `https://outlook.office.com/IMAP.AccessAsUser.All` `https://outlook.office.com/SMTP.Send` | `/api/oauth/{google\|microsoft}/callback` |
| Organize (second consent, `mail:grantOrganize`) | Gmail labels or Graph mailFolders | IMAP scopes plus `https://www.googleapis.com/auth/gmail.modify` | `offline_access User.Read Mail.ReadWrite Mail.Send` | same `/api/oauth/.../callback` path |
| Calendar (`calendar:connect`) | Google Calendar or Graph calendars | `openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events` | `offline_access User.Read Calendars.ReadWrite` | `/api/calendar-oauth/{google\|microsoft}/callback` |
| Inbox rules (`mail:grantRules`) | Gmail filters or Graph inbox message rules | `openid email https://www.googleapis.com/auth/gmail.settings.basic https://www.googleapis.com/auth/gmail.labels` | `offline_access User.Read MailboxSettings.ReadWrite Mail.Read` | same `/api/oauth/.../callback` path |
| Out of Office (`mail:grantVacation`) | Gmail vacation settings or Graph automatic replies | `openid email https://www.googleapis.com/auth/gmail.settings.basic` | `offline_access User.Read MailboxSettings.ReadWrite` | same `/api/oauth/.../callback` path |

Google's organize consent asks for the IMAP scopes again so one grant can keep XOAUTH2 when Google returns both. Microsoft organize stays on Graph scopes only. Entra returns `invalid_scope` when that authorize URL also includes `https://outlook.office.com` IMAP or SMTP scopes, so Outlook XOAUTH2 stays on the first consent.

The IMAP access token's audience is `https://outlook.office.com`, so the first consent does not call Microsoft Graph `/me` (that needs `User.Read`, which is only on the organize and calendar grants). Outlook email and display name come from `https://outlook.office.com/api/v2.0/me`, then from the token's email claims (`preferred_username`, `upn`, `unique_name`, `email`) if that call fails. Graph `/me` still runs for organize and calendar. Cancel, timeout, or closing the connect dialog aborts the loopback flow and does not keep a draft account row. The browser page says Connected only after the account row and mailbox secret are saved. That page and `mail:addAccount` return without waiting for folder listing or the first inbox sync. A second callback with the same state and code shows Connected once that save succeeds, including while the first response is still completing. Cancel after the save does not mark the mailbox as missing its secret. If `gmail.modify` or `Mail.ReadWrite` is missing from `grantedScopes`, label and folder changes stay on the IMAP folder list. Calendar calls run only when the calendar marker is in that purpose's `grantedScopes`.

Tokens are stored per account and purpose (`grantedScopes`, refresh token, access token) in the keychain / DPAPI / `MORROW_MAIL_SECRETS=memory`. The renderer receives scope strings, not tokens.

Passwords and OAuth tokens are stored under the service name `morrow-mail` only. On macOS that is the Keychain service (`security -s morrow-mail`). On Windows the DPAPI file is `%LOCALAPPDATA%\morrow-mail\secrets\morrow-mail_<account>`. Reads and deletes use that service. `MORROW_MAIL_SECRETS=memory` is the in-process store for tests and does not touch the keychain. This service is not the Swift app's store, and the bundle id is not `org.morrowmail.desktop`. A mailbox whose token is not already under `morrow-mail` needs to be connected again.

`oauthReady().google` is false until a Desktop client JSON is available. The app and `npm run check` run without that file. Live Google calls are refused with `oauth_not_ready` until it is set. A packaged build also reads `google-oauth.json` from `process.resourcesPath` (`Contents/Resources` next to `app.asar`). Microsoft uses the public client id in `shared/microsoft-client-id.txt` and has no client secret.

## Redirects

Loopback is `http://localhost:<port>` with the port chosen when the browser opens. The path is matched exactly:

- `http://localhost:<port>/api/oauth/google/callback`
- `http://localhost:<port>/api/oauth/microsoft/callback`
- `http://localhost:<port>/api/calendar-oauth/google/callback`
- `http://localhost:<port>/api/calendar-oauth/microsoft/callback`

## Google Cloud checklist

Do this in the same Desktop client Morrow-Mail uses. Do not paste the secret into the repo, a PR, or this doc.

1. OAuth consent screen. Add the scopes above: `openid`, `email` / `userinfo.email`, `https://mail.google.com/`, `https://www.googleapis.com/auth/gmail.modify`, `https://www.googleapis.com/auth/gmail.settings.basic`, `https://www.googleapis.com/auth/gmail.labels`, `https://www.googleapis.com/auth/calendar.calendarlist.readonly`, and `https://www.googleapis.com/auth/calendar.events`. Out of Office asks for `gmail.settings.basic` on its own. It does not replace the IMAP grant.
2. Enable the Gmail API and the Google Calendar API on the project.
3. Create an OAuth client of type **Desktop**. Download the JSON (`installed.client_id` and `installed.client_secret`).
4. Provide it at runtime as `GOOGLE_DESKTOP_OAUTH_JSON`, `MORROW_GOOGLE_OAUTH_JSON`, `MORROW_GOOGLE_OAUTH_FILE`, dev `resources/google-oauth.json` (gitignored), or packaged `process.resourcesPath/google-oauth.json`.

### Hard blocker: Testing and verification

`https://mail.google.com/` and `gmail.modify` are restricted scopes. `calendar.events` is sensitive. While the consent screen is in **Testing**, only listed test users can consent, and refresh tokens expire after about seven days. Production use needs Google's OAuth verification, and restricted scopes also need a security assessment. Until that is done, Google sign-in is limited to test users. The app will not invent labels or events to paper over a missing grant.

Desktop clients accept loopback redirects on any port. The paths above are what the app sends.

## Entra checklist

The shared public client id stays `2ca9ca19-add5-4807-bfa1-c2a7ac3cc6bf` (`shared/microsoft-client-id.txt`). This change does not rotate it. There is no client secret.

1. Authentication: allow public client flows. Register both redirect paths (`/api/oauth/microsoft/callback` and `/api/calendar-oauth/microsoft/callback`) as public-client localhost redirects. The port is chosen at runtime. A registered URI of `http://localhost` with that path is what the sign-in uses; a fixed port in the tenant will fail until it matches.
2. Delegated permissions:
   - Office 365 Exchange Online: `IMAP.AccessAsUser.All`, `SMTP.Send`
   - Microsoft Graph: `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `Mail.Read`, `MailboxSettings.ReadWrite`, `Calendars.ReadWrite`, `offline_access`

   IMAP and SMTP scope URLs use the resource host `https://outlook.office.com`. The mailbox servers stay `outlook.office365.com` and `smtp.office365.com`. If the Entra app is missing those Exchange permissions, sign-in still fails with `invalid_scope`.
3. Do not commit user refresh tokens.

### Hard blocker: admin consent

Work and school mailboxes cannot grant those delegated permissions until an admin consents on the shared Entra app. A missing admin consent is a provider error. The mailbox keeps the IMAP folder list and does not show stand-in labels, folders, or events.

## What the UI does when a grant is missing

- No Google Desktop JSON: Google buttons explain that OAuth is not configured. Microsoft can still start.
- No `gmail.modify` / `Mail.ReadWrite`: the sidebar says so and offers the second consent. IMAP folders stay. No stand-in label list.
- No mailbox: the calendar page says to connect a Google or Microsoft account. It does not draw events.
- No calendar grant: the calendar page says it needs a grant. It does not draw a month of events. After a grant, the month grid and agenda show only events returned by Google Calendar or Graph for that range, including time and location. An empty month says there are no events.
- No `gmail.settings.basic` / `MailboxSettings.ReadWrite`: Inbox rules says so and offers that consent. It does not invent filters. IMAP accounts that are not Google or Microsoft OAuth keep rules on this computer and run them when new Inbox mail is downloaded. Rules do not forward mail.

## Wire-up

- `mail:addAccount` is the IMAP baseline.
- `mail:grantOrganize` stores the organize token on that mailbox after the email matches.
- `calendar:connect` stores the calendar token the same way.
- `mail:grantVacation` stores a separate vacation token after the browser account matches. A missing `gmail.settings.basic` or `MailboxSettings.ReadWrite` grant does not replace the mailbox secret. Settings → Out of Office then writes Gmail vacation settings or Graph automatic replies, and only after a second confirmation. IMAP accounts try a ManageSieve vacation script named `morrow-vacation` on port 4190. Morrow does not send local automatic replies, and it does not replace a different active Sieve script.
- `mail:listProviderFolders`, create, rename, delete, and move call Gmail labels or Graph `mailFolders` only when the organize marker is granted. Gmail move is `labels.patch` on the label and its descendants. Outlook move is `POST /me/mailFolders/{id}/move`. IMAP folder move uses `RENAME` on the mailbox and does not need that grant.
- `mail:modifyMessageLabels` and `mail:moveProviderMessage` use the provider message id looked up by RFC Message-ID.
- `calendar:list` and `calendar:createEvent` call the calendar APIs for a month range.
- `mail:listInboxRules`, `mail:saveInboxRule`, and `mail:deleteInboxRule` call Gmail `users.settings.filters` or Graph `mailFolders/inbox/messageRules` after `mail:grantRules`. Gmail has no update method, so an edit creates the new filter and then deletes the previous one. Outlook edits do the same with message rules so a cleared condition does not stay behind. Filters and rules already on the server that forward mail, or use an action this client does not represent, can be deleted here and are not rewritten.

Plan My Week and Meeting Prep call `calendar:list` only when that calendar grant is already stored. Organize Inbox proposes a move, then Confirm uses `mail:modifyMessageLabels` or `mail:moveProviderMessage` when the organize grant is present, or an existing IMAP folder of the same name. No grant and no matching folder leaves the proposal pending. Skills never send mail. See [BRAIN_AGENT.md](BRAIN_AGENT.md).
