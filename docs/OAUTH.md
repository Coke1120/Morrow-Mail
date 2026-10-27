# Google / Outlook OAuth

Google login remains **OAuth**. New Google mail connections use **Gmail API**, requesting mail/labels/settings separately from optional Calendar. Existing Google OAuth IMAP accounts switch only after reviewed migration in Accounts. Other providers retain their mail transports. Microsoft coordinates two resource-specific authorization steps: Outlook IMAP/SMTP first, then one Graph bundle for the same mailbox. Existing grants are reused; Microsoft controls whether a browser step needs interaction. Calendar, organize, Out of Office, and inbox rules reuse the granted permissions without another popup. Bot bridge permissions stay separate. No client secret belongs in git.

## Consent and token scopes

This behavior is included in the v0.2.39 release scope; see [versioned rollout prerequisites](releases/v0.2.39.md). See [implementation coverage and validation limits](GMAIL_API_MIGRATION.md). Requesting fewer scopes does not revoke existing broad grants; Settings shows requested and actual saved granted scopes separately.

| Connection | Requested scopes | Redirect path |
|------------|------------------|---------------|
| Google Gmail API mail | `openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.settings.basic` | `/api/oauth/google/callback` |
| Google Calendar (separate) | `openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events` | `/api/calendar-oauth/google/callback` |
| Microsoft A: mail baseline | `offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send` | `/api/oauth/microsoft/callback` |
| Microsoft B: Graph bundle | `offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite MailboxSettings.ReadWrite Mail.Read` | `/api/oauth/microsoft/callback` |

Google uses `include_granted_scopes=false`, `prompt=consent`, offline access and OpenID userinfo. Mail consent includes organize, Out of Office and rules; Calendar starts its own request. `gmail.modify` covers reading, drafts, send, labels, Trash/restore; `gmail.settings.basic` additionally covers vacation, filters and send-as enumeration. No full-mail, redundant labels/send/compose, Drive or Contacts scope is requested. Google may return an earlier broad grant: the app reports that fact and retains actual scopes. To deliberately replace old broad grants, review Google Account app access, revoke Morrow there, then explicitly reauthorize mail and Calendar separately. Revoking access may interrupt other saved Morrow Google grants. Local mail is retained; do not delete/recreate the account. No Console or grant revocation is performed by migration.

### Microsoft resources and coordinated onboarding

Outlook IMAP/SMTP and Microsoft Graph are different resources, and each token request targets one resource. This does **not** mean Microsoft requires two separate sign-ins: its [authorization-code documentation](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) allows multi-resource consent on the authorize leg. Morrow keeps two resource-specific PKCE authorization steps for compatibility with its separate token stores. Graph requests carry the saved mailbox as `login_hint` and omit forced `prompt=consent`, allowing the browser session and existing consent to be reused. The hint does not establish identity: the returned profile must match the selected mailbox. Tenant policy, missing permissions or an expired session may still require interaction. The Outlook token is never sent to Graph, and the Graph token is never sent to IMAP/SMTP. No Graph-to-IMAP refresh exchange substitutes for the mail dialog.

1. Authorize and redeem the Outlook-only mail scopes. Resolve the mailbox with `https://outlook.office.com/api/v2.0/me` or token email claims. This flow does not call Microsoft Graph with that token. Save mail credentials and the account.
2. If any API feature is missing, continue with the Graph-only bundle for the same mailbox, without forcing repeat consent. Use Graph `/me` for its profile and reject a different mailbox.
3. Save the Graph token under `<id>:bundle`; keep the Outlook token under the account id. Later refreshes use only saved granted scopes for that resource. Legacy mixed metadata is projected onto the resource chosen by the mail/feature caller and renewed before cached access is used; requested permissions never expand a partial grant. Empty or wrong-resource grants require reconnecting that feature. Successful renewal stores normalized metadata, while failures leave the old record untouched. Explicit mixed-resource token requests remain rejected locally. Token response scopes take precedence over JWT scope hints; recognized contradictory JWT audiences are rejected. Opaque tokens remain supported.

`Mail.Read` remains in the Graph bundle for rules folder enumeration; `Mail.ReadWrite` also satisfies that read requirement. Missing admin consent, a declined second dialog, or a partial Graph grant leaves the saved mail connection available. The returned connection warning identifies incomplete feature access. Enabling a missing feature retries only the Graph bundle. A reconnect with all API grants already saved needs only the mail dialog.

### Persistence, partial grants, and migration

Feature gates check the complete required scope set (including Google calendar-list access, Gmail rules mail-modification access, and Microsoft rules folder reads). A partial token enables only the features it covers. The renderer receives scope strings and availability, never credentials. A fresh Google grant must cover mail before creating a mailbox; if optional feature scopes are declined, mail still connects and missing features can be enabled later.

Google Calendar prefers its separate `<id>:calendar` record. Google mail features prefer a sufficient primary API token; legacy shared/feature grants remain compatible. Microsoft Graph grants use `<id>:bundle` and legacy feature records. Microsoft API calls never fall back to its Outlook primary token. Legacy feature grants remain usable, and an already granted feature returns success without opening a browser.

Google grant reuse also requires the issuing Desktop client to match the effective configured client. New mail and feature grants save `googleClientId` in the main-process credential record; cached access tokens and refreshes both enforce it. A stale preferred feature record cannot hide a sufficient matching fallback. Different-client or older unknown-client grants remain saved but need reauthorization, including a separate Calendar consent. Older unknown-client grants require this one-time step because assigning the current client would guess their issuer. No scopes or credentials are silently moved between clients. Settings reports the mismatch before a provider call; ordinary Enable Google Calendar performs the needed consent. See [the client-binding decision](adr/2026-10-27-google-client-grant-binding.md).

When a new shared grant omits a previously available feature, preserve the token selected by the client-aware read path in that feature's legacy slot before saving the new bundle. A stale shared grant must not overwrite a usable separate Calendar grant. Gmail reconnect likewise preserves a usable current-client primary/shared fallback ahead of a stale Calendar slot. Stale-only history stays saved but blocked. Never combine scope strings from separate tokens. A feature consent never replaces the primary mailbox secret. Legacy Google OAuth IMAP reconnects require explicit reviewed Gmail migration. After successful matching mail consent, credential writes and the SQLite transport marker are committed with compensation on reported failures. Unsettled actions or sending scheduled deliveries block migration; unuploaded draft edits are preserved locally and detached from unverified old server copies. Calendar credentials are retained separately, including actual older broad scopes, until explicitly reauthorized. Account ids, cached mail, drafts, and other local work survive incremental consent. Removing the account also deletes its shared bundle.

Credential writes restore previous values on storage failure. The callback page reports success only after its connection or requested feature is saved. A partial feature consent may save other usable permissions while reporting that the requested feature is still missing. Account mismatch or removal/reconnection while the feature dialog is pending prevents saving the stale result.

Primary reconnects also pin the account incarnation before waiting: IMAP pins explicit or same-email existing accounts before probes; OAuth captures existing accounts before browser sign-in and matches the returned email afterward. Removal invalidates those pending results (`account_removed`) before account or credential writes, including same-ID recreation. A deliberate new connection begun after removal can add the mailbox again. Existing IMAP transport and credentials remain in use until reviewed migration succeeds.

Password/app-password reconnects explicitly set the primary login type to `password`, including when replacing an OAuth mail connection; this explicitly returns that account to IMAP/SMTP. The primary credential is saved first; login type, server settings and discovered folders then commit in one synchronous SQLite transaction. If either write fails, the handler restores the previous credential (or deletes a new credential) and returns a failure without publishing partial server settings. No await occurs between the liveness check and this commit/compensation block. A refresh started with the old OAuth credential cannot overwrite a successful password reconnect. Separate feature grant records are not changed by this transition.

Credential storage and SQLite are separate stores: compensation handles reported failures, but is not atomic across a process crash or power loss. A failed credential restoration or uncertain journal rollback tells the user to reconnect (and restart for uncertain storage), rather than claiming the prior connection was restored.

Routine mail credential reads and startup/missing-credential scans use an asynchronous macOS Keychain path with a 30-second deadline, including queue time. Pending reads share work; completed credentials are not cached. Account incarnation, login/transport and credential revisions are rechecked after waits, and Google client binding is rechecked before returning a token. In-app writes and deletes invalidate outstanding reads before attempting mutation. Synchronous feature/status and credential commit/compensation APIs remain compatible and have a 30-second limit per macOS command; a multi-command flow can wait longer. Windows DPAPI and provider scopes are unchanged. Native Keychain prompts/ACL behavior is not verified by synthetic tests. See [the read migration boundary](adr/2026-10-27-keychain-read-deadlines.md).

Stored `grantedScopes` and `requestedScopes` distinguish received permissions from the requested bundle. Scope checks accept case differences, fully qualified Graph names, percent encoding, and comma-separated lists. Microsoft `scp` claims supplement token responses. When `scope` is omitted, only the scopes requested for that resource's token exchange are used as fallback. A refresh requests the scopes actually granted, so a partial consent does not request withheld permissions in the background.

Passwords and OAuth tokens are stored under the service name `morrow-mail` only. On macOS that is the Keychain service (`security -s morrow-mail`). On Windows the DPAPI file is `%LOCALAPPDATA%\morrow-mail\secrets\morrow-mail_<account>`. Reads and deletes use that service. `MORROW_MAIL_SECRETS=memory` is the in-process store for tests and does not touch the keychain. This service is not the Swift app's store, and the bundle id is not `org.morrowmail.desktop`. A mailbox whose token is not already under `morrow-mail` needs to be connected again.

`oauthReady().google` is false until a Desktop client JSON is available. The app and `npm run check` run without that file. Live Google calls are refused with `oauth_not_ready` until it is set. Load order is `MORROW_GOOGLE_OAUTH_FILE`, then `MORROW_GOOGLE_OAUTH_JSON` or `GOOGLE_DESKTOP_OAUTH_JSON`, then `google-oauth.json` in the app userData directory (Settings → Accounts → Advanced: personal Google OAuth client (optional) → Import Desktop JSON), then `resources/google-oauth.json`, then `process.resourcesPath/google-oauth.json`. The imported file is preferred over the repo copy and the release bake. Environment variables still win. The client secret is not shown in Settings and is not returned to the renderer. A packaged build also reads `google-oauth.json` from `process.resourcesPath` (`Contents/Resources` next to `app.asar`). Release Actions place that file from the `GOOGLE_DESKTOP_OAUTH_JSON` secret before packaging. Microsoft uses the public client id in `shared/microsoft-client-id.txt` and has no client secret. Continue with Google uses the bundled client by default when present and no explicit override is selected. Personal client import is optional; see [the advanced personal-client guide](bring-your-own-google-oauth.md). Local readiness does not check Google Console publication, verification or allowed users.

Import/clear and Google mail/feature authorization share a main-process lease covering the native picker or browser wait through the final host commit. A second operation is refused with `conflict`; cancelling OAuth retains the lease until the in-flight operation settles. Invalid/cancelled imports preserve the previous client. Commits and refresh completions additionally check client identity, so an external configuration change cannot save an obsolete result. Invalid environment overrides report their actual source and do not fall back to, or blame, a healthy imported file.

## Redirects

Loopback is `http://localhost:<port>` with the port chosen when the browser opens. The path is matched exactly:

- `http://localhost:<port>/api/oauth/google/callback`
- `http://localhost:<port>/api/oauth/microsoft/callback`
- `http://localhost:<port>/api/calendar-oauth/google/callback`
- `http://localhost:<port>/api/calendar-oauth/microsoft/callback`

## Google Cloud checklist

Do this in the same Desktop client Morrow-Mail uses. Do not paste the secret into the repo, a PR, or this doc.

1. Review the actual approved scopes against the two Google request sets above. This PR does not change Console settings. Do not remove an existing registration requirement until legacy-account support and verification have been reviewed with Google.
2. Enable the Gmail API on the Desktop client project; additionally enable the Google Calendar API when Calendar is used. This release does not inspect or change those Console settings.
3. Create an OAuth client of type **Desktop**. Download the JSON (`installed.client_id` and `installed.client_secret`).
4. Provide it at runtime as `GOOGLE_DESKTOP_OAUTH_JSON`, `MORROW_GOOGLE_OAUTH_JSON`, `MORROW_GOOGLE_OAUTH_FILE`, an imported `google-oauth.json` in the app userData directory, dev `resources/google-oauth.json` (gitignored), or packaged `process.resourcesPath/google-oauth.json`. Settings → Accounts offers optional advanced import for people choosing a personal Desktop client. See [Bring your own Google Desktop client](bring-your-own-google-oauth.md). Leave the consent screen in Testing.

Release Actions bake the GitHub secret `GOOGLE_DESKTOP_OAUTH_JSON` into packaged builds. `.github/workflows/release.yml` writes that secret to `resources/google-oauth.json` on the Windows and macOS jobs before `npm run dist:win` and `npm run dist:mac`, creating `resources/` when it is absent. The step checks Desktop client JSON (`installed.client_id` ending in `.apps.googleusercontent.com`, and `client_secret`) and fails the job when the secret is missing or invalid. The log records the output path. `build.extraResources` copies `resources/` to `process.resourcesPath` (`google-oauth.json` beside `app.asar`). Never commit `resources/google-oauth.json`.

### Hard blocker: Testing and verification

`https://mail.google.com/` and `gmail.modify` are restricted scopes. `calendar.events` is sensitive. While the consent screen is in **Testing**, only listed test users can consent, and refresh tokens expire after about seven days. Production use remains subject to Google's OAuth verification and restricted-scope assessment requirements. A narrower request does not prove verification or CASA is unnecessary; Google determines requirements from the actual app/data flow. Until that is done, Google sign-in is limited to test users. The app will not invent labels or events to paper over a missing grant.

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

- No Google Desktop JSON: Google buttons explain that OAuth is not configured and point to Settings → Accounts, where a Desktop client JSON can be imported or cleared. The secret is not shown. Microsoft can still start. An imported client is used without restarting the app.
- No `gmail.modify` / `Mail.ReadWrite`: the sidebar says so and offers the provider bundle consent. IMAP folders stay. No stand-in label list. A consent that does not return that marker keeps the Grant button and says which permission Microsoft or Google left out. It does not say the mail API is connected.
- No mailbox: the calendar page says to connect a Google or Microsoft account. It does not draw events.
- No calendar grant: the calendar page offers Enable Google Calendar for a separate Calendar request, or Enable mailbox features for the Microsoft Graph bundle. It does not draw a month of events. After a grant, the month grid and agenda show only events returned by Google Calendar or Graph for that range, including time and location. An empty month says there are no events.
- Loading: the calendar page keeps its toolbar and month chrome and shows a light overlay and spinner (Loading… on a cold open, Updating calendar… when a month is already showing). That wait does not replace the page with a status line. The missing-mailbox and missing-grant states above still use status text and do not draw events.
- No `gmail.settings.basic` / `MailboxSettings.ReadWrite`: Inbox rules says so and offers the provider bundle consent. It does not invent filters. IMAP accounts that are not Google or Microsoft OAuth keep rules on this computer and run them when new Inbox mail is downloaded. Rules do not forward mail.

## Wire-up

- `mail:addAccount` requests Gmail API mail permissions without Calendar, or Microsoft mail followed by its Graph bundle.
- `mail:grantOrganize`, `mail:grantRules`, and `calendar:connect` reuse existing access or request the provider bundle after matching the mailbox email.
- `mail:grantVacation` reuses the bundle or requests the provider bundle after the browser account matches. A missing `gmail.settings.basic` or `MailboxSettings.ReadWrite` grant does not replace the mailbox secret. Settings → Out of Office then writes Gmail vacation settings or Graph automatic replies, and only after a second confirmation. IMAP accounts try a ManageSieve vacation script named `morrow-vacation` on port 4190. Morrow does not send local automatic replies, and it does not replace a different active Sieve script.
- `mail:listProviderFolders`, create, rename, delete, and move call Gmail labels or Graph `mailFolders` only when the organize marker is granted. Gmail move is `labels.patch` on the label and its descendants. Outlook move is `POST /me/mailFolders/{id}/move`. IMAP folder move uses `RENAME` on the mailbox and does not need that grant.
- `mail:modifyMessageLabels` and `mail:moveProviderMessage` use the provider message id looked up by RFC Message-ID.
- `calendar:list`, `calendar:createEvent`, `calendar:updateEvent`, and `calendar:deleteEvent` call the calendar APIs for a month range.
- `mail:listInboxRules`, `mail:saveInboxRule`, and `mail:deleteInboxRule` call Gmail `users.settings.filters` or Graph `mailFolders/inbox/messageRules` after `mail:grantRules`. Gmail has no update method, so an edit creates the new filter and then deletes the previous one. Outlook edits do the same with message rules so a cleared condition does not stay behind. Filters and rules already on the server that forward mail, or use an action this client does not represent, can be deleted here and are not rewritten.

Plan My Week and Meeting Prep call `calendar:list` only when that calendar grant is already stored. Organize Inbox proposes a move, then Confirm uses `mail:modifyMessageLabels` or `mail:moveProviderMessage` when the organize grant is present, or an existing IMAP folder of the same name. No grant and no matching folder leaves the proposal pending. Skills never send mail. See [BRAIN_AGENT.md](BRAIN_AGENT.md).

## Mock validation and live smoke notes

Gmail API mail errors now retain bounded, allowlisted diagnostics in sync activity
and Debug log: numeric HTTP status, a static operation and recognized Google
reason/status codes. A 403 alone is not classified as missing scope. Legacy
`error.errors[].reason` and `google.rpc.ErrorInfo` in `error.details` can establish
quota/rate limits, missing mail permission, a disabled API or domain policy.
`PERMISSION_DENIED` alone remains an unknown cause; `RESOURCE_EXHAUSTED` indicates
quota/rate pressure. Malformed, oversized, unreadable or unsupported responses
fall back to unknown. No raw error body, provider message/metadata, URL, id, mail
content, address or token is retained in these diagnostics. Existing surrounding
mailbox/folder log context still needs review before sharing.

Quota/rate evidence uses the existing sync pause. Other non-credential Gmail
403s use the existing transient read retry schedule rather than marking the
credential invalid; confirmed missing permission and 401s keep the sign-in gate.
Scopes, stored grants/credentials, consent and write retry/submission behavior
are unchanged. Review the safe diagnostic before choosing an action: wait for
quota pressure, ask the app owner to review API enablement, contact the domain
administrator for domain policy, or review mail access for missing permission.
Do not infer a cause from successful login, a folder label such as
`CATEGORY_PERSONAL`, or HTTP 403 alone. The reported v0.3.3 failure has not been
reproduced against a live mailbox or diagnosed by these synthetic tests.

See [Gmail error diagnostic boundaries and fixtures](GMAIL_ERROR_DIAGNOSTICS.md).

`scripts/check-google-client-switching.js` exercises the real preload, Settings/Features DOM, host handlers, OAuth loopback and temporary database. It covers source precedence and diagnostics, rejected/cancelled imports, pending picker/mail/Calendar exclusion, partial consent, same/changed/unknown-client grants, cached-token and refresh gating, normal Calendar recovery, cancellation during exchange, obsolete commits/refreshes and binding after process restart. Provider responses are intercepted; only local callbacks use sockets. Native picker/package and live-provider validation remain pending.

`npm run check` includes `scripts/check-mail-calendar-consent.js`: real local loopback callbacks with fake provider token/profile responses, memory-only secrets, and a temporary database. It checks Google mail and its separate optional Calendar grant, two Microsoft dialogs with separate code exchanges, resource-specific refreshes, no popup for granted features, partial consent, legacy grants, account mismatch, cancellation, storage rollback, and mail sync/calendar availability. It also rejects mixed-resource Microsoft token requests. No live OAuth credentials, Keychain, or mailbox writes are needed.

Live smoke checks are pending. With an authorized test account, approve Google mail and the separate optional Calendar dialog, or Microsoft's mail then Graph dialogs, verify mail sync, and open Calendar, organize, Out of Office, and Inbox Rules without another popup. View settings only; this consent change does not authorize a live settings/rules/event write. Repeat Microsoft with personal and work/school accounts under their applicable consent policies, including an admin-required case. Decline Graph or individual Google permissions, verify mail and existing grants remain, then enable a missing feature and retry. Verify mail-only and calendar-only migration preserves cached work. Bot bridge still uses its separate grants. Mocks cannot verify provider registration, verification, or tenant policy.
