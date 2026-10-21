# Google / Outlook OAuth

Morrow Mail keeps **IMAP XOAUTH2 as the mail baseline**. Google uses **one full consent**. Microsoft coordinates two resource-specific authorization steps: Outlook IMAP/SMTP first, then one Graph bundle for the same mailbox. Existing grants are reused; Microsoft controls whether a browser step needs interaction. Calendar, organize, Out of Office, and inbox rules reuse the granted permissions without another popup. Bot bridge permissions stay separate. No client secret belongs in git.

## Consent and token scopes

| Connection | Requested scopes | Redirect path |
|------------|------------------|---------------|
| Google full bundle | `openid email https://mail.google.com/ https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.settings.basic https://www.googleapis.com/auth/gmail.labels` | `/api/oauth/google/callback` |
| Microsoft A: mail baseline | `offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send` | `/api/oauth/microsoft/callback` |
| Microsoft B: Graph bundle | `offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite MailboxSettings.ReadWrite Mail.Read` | `/api/oauth/microsoft/callback` |

Google uses `include_granted_scopes=true`, `prompt=consent`, offline access, and the OpenID userinfo profile. Connecting or enabling a missing feature requests the complete bundle. There are no Drive or Contacts scopes. `gmail.settings.basic` covers Out of Office and filters; `gmail.labels` is included for rules label choices.

### Microsoft resources and coordinated onboarding

Outlook IMAP/SMTP and Microsoft Graph are different resources, and each token request targets one resource. This does **not** mean Microsoft requires two separate sign-ins: its [authorization-code documentation](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) allows multi-resource consent on the authorize leg. Morrow keeps two resource-specific PKCE authorization steps for compatibility with its separate token stores. Graph requests carry the saved mailbox as `login_hint` and omit forced `prompt=consent`, allowing the browser session and existing consent to be reused. The hint does not establish identity: the returned profile must match the selected mailbox. Tenant policy, missing permissions or an expired session may still require interaction. The Outlook token is never sent to Graph, and the Graph token is never sent to IMAP/SMTP. No Graph-to-IMAP refresh exchange substitutes for the mail dialog.

1. Authorize and redeem the Outlook-only mail scopes. Resolve the mailbox with `https://outlook.office.com/api/v2.0/me` or token email claims. This flow does not call Microsoft Graph with that token. Save mail credentials and the account.
2. If any API feature is missing, continue with the Graph-only bundle for the same mailbox, without forcing repeat consent. Use Graph `/me` for its profile and reject a different mailbox.
3. Save the Graph token under `<id>:bundle`; keep the Outlook token under the account id. Later refreshes use only saved granted scopes for that resource. Legacy mixed metadata is projected onto the resource chosen by the mail/feature caller and renewed before cached access is used; requested permissions never expand a partial grant. Empty or wrong-resource grants require reconnecting that feature. Successful renewal stores normalized metadata, while failures leave the old record untouched. Explicit mixed-resource token requests remain rejected locally. Token response scopes take precedence over JWT scope hints; recognized contradictory JWT audiences are rejected. Opaque tokens remain supported.

`Mail.Read` remains in the Graph bundle for rules folder enumeration; `Mail.ReadWrite` also satisfies that read requirement. Missing admin consent, a declined second dialog, or a partial Graph grant leaves the saved mail connection available. The returned connection warning identifies incomplete feature access. Enabling a missing feature retries only the Graph bundle. A reconnect with all API grants already saved needs only the mail dialog.

### Persistence, partial grants, and migration

Feature gates check the complete required scope set (including Google calendar-list access, Gmail rules labels, and Microsoft rules folder reads). A partial token enables only the features it covers. The renderer receives scope strings and availability, never credentials. A fresh Google grant must cover mail before creating a mailbox; if optional feature scopes are declined, mail still connects and missing features can be enabled later.

Google's primary full token can serve all features. Incremental Google grants and Microsoft Graph grants use one shared `<id>:bundle` record. A feature first selects a sufficient shared grant, then its legacy `<id>:calendar`, `:organize`, `:rules`, or `:vacation` record, then a sufficient Google primary token. Microsoft API calls never fall back to its Outlook primary token. Legacy feature grants remain usable, and an already granted feature returns success without opening a browser.

When a new shared grant omits a previously available feature, preserve the older shared token in that feature's legacy slot before saving the new bundle. Never combine scope strings from separate tokens. A feature consent never replaces the primary mailbox secret. A narrower Google primary reconnect is rejected before changing credentials. Account ids, cached mail, drafts, and other local work survive incremental consent. Removing the account also deletes its shared bundle.

Credential writes restore previous values on storage failure. The callback page reports success only after its connection or requested feature is saved. A partial feature consent may save other usable permissions while reporting that the requested feature is still missing. Account mismatch or removal/reconnection while the feature dialog is pending prevents saving the stale result.

Stored `grantedScopes` and `requestedScopes` distinguish received permissions from the requested bundle. Scope checks accept case differences, fully qualified Graph names, percent encoding, and comma-separated lists. Microsoft `scp` claims supplement token responses. When `scope` is omitted, only the scopes requested for that resource's token exchange are used as fallback. A refresh requests the scopes actually granted, so a partial consent does not request withheld permissions in the background.

Passwords and OAuth tokens are stored under the service name `morrow-mail` only. On macOS that is the Keychain service (`security -s morrow-mail`). On Windows the DPAPI file is `%LOCALAPPDATA%\morrow-mail\secrets\morrow-mail_<account>`. Reads and deletes use that service. `MORROW_MAIL_SECRETS=memory` is the in-process store for tests and does not touch the keychain. This service is not the Swift app's store, and the bundle id is not `org.morrowmail.desktop`. A mailbox whose token is not already under `morrow-mail` needs to be connected again.

`oauthReady().google` is false until a Desktop client JSON is available. The app and `npm run check` run without that file. Live Google calls are refused with `oauth_not_ready` until it is set. A packaged build also reads `google-oauth.json` from `process.resourcesPath` (`Contents/Resources` next to `app.asar`). Release Actions place that file from the `GOOGLE_DESKTOP_OAUTH_JSON` secret before packaging. Microsoft uses the public client id in `shared/microsoft-client-id.txt` and has no client secret.

## Redirects

Loopback is `http://localhost:<port>` with the port chosen when the browser opens. The path is matched exactly:

- `http://localhost:<port>/api/oauth/google/callback`
- `http://localhost:<port>/api/oauth/microsoft/callback`
- `http://localhost:<port>/api/calendar-oauth/google/callback`
- `http://localhost:<port>/api/calendar-oauth/microsoft/callback`

## Google Cloud checklist

Do this in the same Desktop client Morrow-Mail uses. Do not paste the secret into the repo, a PR, or this doc.

1. OAuth consent screen. Add the scopes above: `openid`, `email` / `userinfo.email`, `https://mail.google.com/`, `https://www.googleapis.com/auth/gmail.modify`, `https://www.googleapis.com/auth/gmail.settings.basic`, `https://www.googleapis.com/auth/gmail.labels`, `https://www.googleapis.com/auth/calendar.calendarlist.readonly`, and `https://www.googleapis.com/auth/calendar.events`. The full bundle includes `gmail.settings.basic` for Out of Office and rules.
2. Enable the Gmail API and the Google Calendar API on the project.
3. Create an OAuth client of type **Desktop**. Download the JSON (`installed.client_id` and `installed.client_secret`).
4. Provide it at runtime as `GOOGLE_DESKTOP_OAUTH_JSON`, `MORROW_GOOGLE_OAUTH_JSON`, `MORROW_GOOGLE_OAUTH_FILE`, dev `resources/google-oauth.json` (gitignored), or packaged `process.resourcesPath/google-oauth.json`.

Release Actions bake the GitHub secret `GOOGLE_DESKTOP_OAUTH_JSON` into packaged builds. `.github/workflows/release.yml` writes that secret to `resources/google-oauth.json` on the Windows and macOS jobs before `npm run dist:win` and `npm run dist:mac`, creating `resources/` when it is absent. The step checks Desktop client JSON (`installed.client_id` ending in `.apps.googleusercontent.com`, and `client_secret`) and fails the job when the secret is missing or invalid. The log records the output path. `build.extraResources` copies `resources/` to `process.resourcesPath` (`google-oauth.json` beside `app.asar`). Never commit `resources/google-oauth.json`.

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

### Tenant consent policy

Work and school consent depends on tenant policy and the requested permissions; admin approval is not universally required for every mailbox. When Microsoft requires admin approval, it is a provider blocker and cannot be bypassed by this client. The mailbox keeps the IMAP folder list and does not show stand-in labels, folders, or events.

## What the UI does when a grant is missing

- No Google Desktop JSON: Google buttons explain that OAuth is not configured. Microsoft can still start.
- No `gmail.modify` / `Mail.ReadWrite`: the sidebar says so and offers the provider bundle consent. IMAP folders stay. No stand-in label list. A consent that does not return that marker keeps the Grant button and says which permission Microsoft or Google left out. It does not say the mail API is connected.
- No mailbox: the calendar page says to connect a Google or Microsoft account. It does not draw events.
- No calendar grant: the calendar page offers Enable mailbox features for the Google full bundle or Microsoft Graph bundle. It does not draw a month of events. After a grant, the month grid and agenda show only events returned by Google Calendar or Graph for that range, including time and location. An empty month says there are no events.
- Loading: the calendar page keeps its toolbar and month chrome and shows a light overlay and spinner (Loading… on a cold open, Updating calendar… when a month is already showing). That wait does not replace the page with a status line. The missing-mailbox and missing-grant states above still use status text and do not draw events.
- No `gmail.settings.basic` / `MailboxSettings.ReadWrite`: Inbox rules says so and offers the provider bundle consent. It does not invent filters. IMAP accounts that are not Google or Microsoft OAuth keep rules on this computer and run them when new Inbox mail is downloaded. Rules do not forward mail.

## Wire-up

- `mail:addAccount` requests the Google full bundle, or Microsoft mail followed by its Graph bundle.
- `mail:grantOrganize`, `mail:grantRules`, and `calendar:connect` reuse existing access or request the provider bundle after matching the mailbox email.
- `mail:grantVacation` reuses the bundle or requests the provider bundle after the browser account matches. A missing `gmail.settings.basic` or `MailboxSettings.ReadWrite` grant does not replace the mailbox secret. Settings → Out of Office then writes Gmail vacation settings or Graph automatic replies, and only after a second confirmation. IMAP accounts try a ManageSieve vacation script named `morrow-vacation` on port 4190. Morrow does not send local automatic replies, and it does not replace a different active Sieve script.
- `mail:listProviderFolders`, create, rename, delete, and move call Gmail labels or Graph `mailFolders` only when the organize marker is granted. Gmail move is `labels.patch` on the label and its descendants. Outlook move is `POST /me/mailFolders/{id}/move`. IMAP folder move uses `RENAME` on the mailbox and does not need that grant.
- `mail:modifyMessageLabels` and `mail:moveProviderMessage` use the provider message id looked up by RFC Message-ID.
- `calendar:list`, `calendar:createEvent`, `calendar:updateEvent`, and `calendar:deleteEvent` call the calendar APIs for a month range.
- `mail:listInboxRules`, `mail:saveInboxRule`, and `mail:deleteInboxRule` call Gmail `users.settings.filters` or Graph `mailFolders/inbox/messageRules` after `mail:grantRules`. Gmail has no update method, so an edit creates the new filter and then deletes the previous one. Outlook edits do the same with message rules so a cleared condition does not stay behind. Filters and rules already on the server that forward mail, or use an action this client does not represent, can be deleted here and are not rewritten.

Plan My Week and Meeting Prep call `calendar:list` only when that calendar grant is already stored. Organize Inbox proposes a move, then Confirm uses `mail:modifyMessageLabels` or `mail:moveProviderMessage` when the organize grant is present, or an existing IMAP folder of the same name. No grant and no matching folder leaves the proposal pending. Skills never send mail. See [BRAIN_AGENT.md](BRAIN_AGENT.md).

## Mock validation and live smoke notes

`npm run check` includes `scripts/check-mail-calendar-consent.js`: real local loopback callbacks with fake provider token/profile responses, memory-only secrets, and a temporary database. It checks one Google dialog, two Microsoft dialogs with separate code exchanges, resource-specific refreshes, no popup for granted features, partial consent, legacy grants, account mismatch, cancellation, storage rollback, and mail sync/calendar availability. It also rejects mixed-resource Microsoft token requests. No live OAuth credentials, Keychain, or mailbox writes are needed.

Live smoke checks are pending. With an authorized test account, approve the full Google dialog or Microsoft's mail then Graph dialogs, verify mail sync, and open Calendar, organize, Out of Office, and Inbox Rules without another popup. View settings only; this consent change does not authorize a live settings/rules/event write. Repeat Microsoft with personal and work/school accounts under their applicable consent policies, including an admin-required case. Decline Graph or individual Google permissions, verify mail and existing grants remain, then enable a missing feature and retry. Verify mail-only and calendar-only migration preserves cached work. Bot bridge still uses its separate grants. Mocks cannot verify provider registration, verification, or tenant policy.
