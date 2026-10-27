# Google mail via app password (Path 3)

Status: **proposed**. Leo chose this on 2026-10-27. This ADR does not change connect, scopes, tokens, Google Cloud Console, or the public privacy site. The Gmail API path in [2026-10-25-gmail-api-staging.md](2026-10-25-gmail-api-staging.md) and [GMAIL_API_MIGRATION.md](../GMAIL_API_MIGRATION.md) is still what the app does. Those docs stay accurate until a later PR switches mail and updates help in the same change.

## Decision

Production Google **mail** should use an app password (the remaining password-shaped login Google documents) on the existing Gmail IMAP/SMTP preset:

- IMAP `imap.gmail.com:993` implicit TLS
- SMTP `smtp.gmail.com:465` implicit TLS

That consent must not request `https://www.googleapis.com/auth/gmail.modify`, `https://www.googleapis.com/auth/gmail.settings.basic`, or `https://mail.google.com/`.

Optional **Calendar** may keep today's separate OAuth request: `openid email`, `calendar.calendarlist.readonly`, `calendar.events`. Microsoft mail and the Graph bundle stay as they are.

## Why this path

`gmail.modify`, `gmail.settings.basic`, and `https://mail.google.com/` are Restricted on Google's Gmail scope list (page updated 2026-09-10). An app that requests Restricted scopes and can access that data from or through a third-party server is in Google's restricted-scope verification and CASA assessment. Morrow's current mail connect requests the first two. The point of Path 3 is to take Gmail Restricted scopes off the mail consent so that assessment is not required for mail.

Calendar `calendar.events` is already recorded in [OAUTH.md](../OAUTH.md) as Sensitive. That is a different review from CASA. Keeping Calendar does not keep the Gmail Restricted request.

Stopping the request in a document does not change Google's view of the Cloud project. CASA still follows whatever the consent screen and the binary actually request. Console edits are a later step, after the app stops asking.

## Why not IMAP OAuth

IMAP and SMTP with XOAUTH2 still need `https://mail.google.com/`. Google classifies that scope as Restricted (read, compose, send, and permanently delete). Thunderbird's Gmail OAuth uses it. A narrower Gmail API scope set was the v0.2.39 attempt to leave full-mail behind; it is still Restricted because `gmail.modify` and `gmail.settings.basic` are on the same list. Path 3 does not use either OAuth mail grant.

## What stays

- IMAP sync and SMTP send, including the Gmail preset already in `host/mail/presets.js` and `host/mail/oauth-config.js` `IMAP_PRESETS.google`.
- Password reconnect, which already sets `auth_kind` to `password`, sets `mail_transport` to `imap`, and replaces the folder list (`host/mail/engine.js` `connectAccount`). It is not the migration procedure below.
- On-device inbox rules for non-OAuth accounts (`host/mail/inbox-rules.js` `backendFor` returns `imap` unless `auth_kind` is `oauth2`).
- Manual aliases and Morrow-only sender names. Gmail send-as discovery is a loss, listed below.
- Optional Calendar OAuth on `<account id>:calendar`, separate from the mailbox secret.
- Microsoft: Outlook IMAP/SMTP, then one Graph bundle. No change.
- AI still sends locally cached mail only under the existing AI permission. That is not a Google scope. Privacy-site copy is a different repo and is out of scope here.

## Feature losses

These work today only through the Gmail API grants. They do not move to app-password IMAP.

| Loss | What the user gets instead |
| --- | --- |
| Gmail labels as the mailbox (create, rename, nest, delete, apply) and `messages.modify` / history / one Trash snapshot for every label copy | IMAP folders on `imap.gmail.com`, including Gmail's `[Gmail]/…` mailboxes. Trash-only delete stays: `isGmail` still refuses permanent delete, and `remote.removeUid` moves to Trash and returns without deleting when the message is already there. What goes away is the API's single-id Undo snapshot across label copies. |
| Server filters (`users.settings.filters`) | Rules stored on this computer, run when Inbox mail is downloaded. They do not forward. |
| In-app Gmail vacation (`users.settings.vacation`) | No Gmail settings write. A password account does not take the API path once vacation checks `auth_kind`. The other path is ManageSieve `morrow-vacation` on port 4190; if that connection fails, Settings already says the server has no vacation script and Morrow does not send local replies. The settings link for `imap.gmail.com` already opens Gmail's vacation page. |
| Send-as discovery (`users.settings.sendAs`) | The account address, manual aliases, and local display-name overrides. Refresh will not learn new Gmail aliases. See [sender display names](2026-10-26-sender-display-names.md). |
| Gmail API search and history polling | IMAP search, and IDLE where Gmail's IMAP server allows it. `gmail_api` accounts skip IDLE today (`host/mail/idle.js`). |
| "Grant Gmail labels / filters / vacation" | Those buttons request Restricted scopes. They cannot stay on the Path 3 mail path. |

App-password limits, from Google's own help (not from a live Morrow mailbox):

- An app password is a 16-digit code created by the user at [Sign in with app passwords](https://support.google.com/mail/answer/185833). It requires 2-Step Verification.
- It is unavailable when 2-Step Verification is security-key only, when Advanced Protection is on, or when a work or school admin hides it.
- The Google account password is not this login. Google turned off less-secure-app username/password access (Workspace admin note dated for 2025-03-14), with app passwords called out as the exception.
- A Workspace admin can turn IMAP off, or allow IMAP only for listed OAuth client IDs ([admin IMAP setting](https://support.google.com/a/answer/105694)). Those mailboxes cannot use Path 3.

## Calendar

Leave Calendar on its current scopes and callback `/api/calendar-oauth/google/callback`. Do not add a Gmail scope to that request. A password mailbox secret and a Calendar refresh token can already sit side by side: password reconnect does not delete `<id>:calendar`.

`calendar.events` is Sensitive. Confirm `calendar.calendarlist.readonly` stays in that same grant before any Console edit. This ADR does not claim that Sensitive verification is free or finished.

## Existing Google OAuth tokens

Do not delete the account, do not call Google's revoke endpoint from the app, and do not treat a smaller request as proof that an old grant is gone.

What is stored today, under the `morrow-mail` secret service:

- The primary secret for a `gmail_api` account is the Gmail OAuth JSON (`gmail.modify` + `gmail.settings.basic`, and sometimes an older `https://mail.google.com/` grant).
- Feature keys `<id>:calendar`, `<id>:organize`, `<id>:rules`, `<id>:vacation`, and `<id>:bundle` may still hold tokens. Migration to Gmail API copies a still-needed feature token into its legacy key and deletes the bundle key when the new mail token covers that feature (`connectOAuthAccount` in `host/mail/engine.js`).
- `include_granted_scopes=false` does not revoke anything. `hasMarker` still treats a saved `https://mail.google.com/` grant as enough for Gmail IMAP and organize.

A reviewed later migration, not this PR:

1. Leave the account id, cached mail, drafts, schedules, and the Calendar secret in place.
2. Do not run today's password reconnect on a `gmail_api` account until the cache rule is chosen. That handler already overwrites the primary secret, sets `mail_transport` to `imap`, and replaces folders. It does not delete feature secrets. Messages may still carry `gmail_id` and a `gmail_generation` uid validity, which are not IMAP UIDs. `replaceFolders` does not remap those rows. Using the handler as-is can orphan or duplicate cache.
3. After the account is on the app password, the user who wants the old Restricted grant gone revokes Morrow in their Google Account, then signs in to Calendar again if that grant was on the same client. The app does not do this. Revoking can drop Calendar too.
4. Remove Restricted scopes from the Cloud consent screen only after the binary no longer requests them. This PR does not open the Console.

New mailboxes can be added on the password path without that cache problem. Accounts still on legacy OAuth IMAP (`auth_kind` oauth2, `mail_transport` not `gmail_api`) should not be pushed through "Migrate Gmail to Gmail API" once Path 3 is the target.

## Code inventory

Google-only. Microsoft rows in the same files stay. "If removed" means if that call or grant is dropped from the Google mail path.

### Restricted requests

| Path | If removed |
| --- | --- |
| `host/mail/oauth-config.js` `SCOPES.google`, `ORGANIZE_SCOPES.google`, `RULES_SCOPES.google`, `VACATION_SCOPES.google`, `MARKERS` for those purposes, and `BUNDLE_SCOPES` built from them | New Google mail, organize, rules, and vacation dialogs stop asking for Restricted scopes. |
| `host/mail/oauth-config.js` `hasMarker` special case for `https://mail.google.com/` on imap and organize | Old full-mail tokens would no longer count as Gmail API mail or label access. Keep until those accounts have left the API. |
| `host/mail/oauth-config.js` `ENDPOINTS.google.profile` (`gmail/v1/users/me/profile`) for the mail purpose | Mail sign-in would stop calling Gmail to identify the mailbox. Calendar already uses OpenID userinfo. |
| `host/mail/gmail-mail-api.js` `MAIL_SCOPES` | Duplicate of the mail request string. Tests assert it. Not a second consent screen. |
| `host/mail/oauth.js` Google authorize, code exchange, and refresh | Still required for Calendar. Mail must stop calling it with the Gmail scope set. |

`gmail.labels`, `gmail.send`, `gmail.compose`, Drive, and Contacts are not in the current request. Rules still accept a legacy `gmail.labels` token plus `gmail.settings.basic` (`hasPurposeScopes`). That legacy acceptance is not a reason to request `gmail.labels` again.

### Gmail API mail transport

| Path | If removed |
| --- | --- |
| `host/mail/gmail-mail-api.js` `createGmailMailApi` | Loses list/get/raw, attachments, history, drafts, `messages.send`, label modify, trash, untrash, and label CRUD for `gmail_api` accounts. |
| `host/mail/gmail-session.js` | The engine adapter for that API, including the synthetic All Mail folder and RFC Message-ID binding. |
| `host/mail/remote.js` | Migrated accounts never open IMAP. A password account must be `mail_transport` `imap` before IMAP is used. Do not add a silent API-to-IMAP fallback. |
| `host/mail/engine.js` `connectOAuthAccount`, `enableGmail`, and the `gmail_api` sync, draft, send, and search branches | New Google mail would stop being switched onto the API. Search also calls `provider-api.searchGmail` when an organize token exists, including for a Gmail profile that is still on IMAP. |
| `host/mail/db.js` `enableGmail`, `gmail_generation`, Gmail id columns | Stored rows remain. Clearing the transport flag does not rewrite UID validity. |
| `host/mail/actions.js` | Trash and archive dedupe label copies by Gmail id. IMAP Gmail goes back to per-folder copies. |
| `host/mail/idle.js` | `gmail_api` does not use IDLE. Password IMAP can. |

### Organize, rules, vacation bundles

| Path | If removed |
| --- | --- |
| `host/mail/provider-api.js` label list/create/rename/move/delete, `modifyLabels`, `searchGmail` | Server label edits and Gmail API search stop. IMAP folder list remains. |
| `host/mail/provider-api.js` `listSendAs` | Gmail stops supplying alias defaults. |
| `host/mail/sidecar.js` `mail:grantOrganize`, `mail:listProviderFolders`, and the folder create/rename/delete/move/message channels when `providerOf` is google | "Grant Gmail labels" goes away. `providerOf` keys off profile `gmail`, not `auth_kind`, so a password Gmail account is still "google" and the grant is still offered. |
| `host/mail/inbox-rules.js` `GMAIL_FILTERS` and the Gmail create/delete filter calls | OAuth Gmail loses server filters. Password accounts already use local rules. |
| `host/mail/sidecar.js` `mail:grantRules` | Stops requesting `gmail.settings.basic` plus `gmail.modify`. |
| `host/mail/vacation-api.js` `users/me/settings/vacation` | In-app Gmail vacation read/write stops. |
| `host/mail/sidecar.js` `vacationGet` / `vacationPut` | Profile `gmail` always takes the API path, including password accounts. Until that checks `auth_kind`, Path 3 still asks for `gmail.settings.basic`. The sieve path must not be used to invent replies when port 4190 is closed. |
| `host/mail/compose-identity.js`, `host/brain-persona.js` `sendAsRead` | Brain and compose stop seeing discovered Gmail send-as rows. Explicit aliases remain. |

### Calendar (do not remove)

| Path | If removed |
| --- | --- |
| `host/mail/calendar-api.js` Google `calendarList` and `events` | Calendar read/write for Google stops. Path 3 does not ask for that. |
| `host/mail/oauth-config.js` `CALENDAR_SCOPES.google` | The Sensitive request. Keep it off the mail dialog. |

### Copy that still describes the shipped Gmail API

Left unchanged here so it keeps matching the code. The implementation PR has to change these together with the catalog and tests:

- `renderer/index.html` connect hint, `#settings-gmail-migration`, `#cli-gmail-transport`, `#oauth-google` ("Continue with Google")
- `renderer/app.js` connect status, migrate confirm (`gmail.modify` and `gmail.settings.basic`), "Grant Gmail labels" / "Grant Gmail filters"
- `renderer/features-catalog.js` `multi-account`
- `docs/GMAIL_API_MIGRATION.md`, `docs/releases/v0.2.39.md`, `docs/INDEPENDENT_UI.md`, `docs/PARITY_SHELL.md`, `docs/BOT_BRIDGE.md`, `AGENTS.md`
- `scripts/check-boot-path.js`, `scripts/check-gmail-mail-api.js`, `scripts/check-gmail-mail-api-ui.js` lock the current scope strings

The Yahoo control is the pattern for a later hint, not a new wizard: `chooseYahoo` in `renderer/app.js` opens the existing password form and `syncPasswordHint` explains the app password. Gmail hosts are already on the Gmail card.

`docs/GMAIL_LEAST_PRIVILEGE_PLAN.md` is the historical plan that led to the Restricted Gmail API request. It is not the Path 3 target.

## Follow-up, when Leo accepts the checklist

One connect change, no new stack:

1. "Continue with Google" opens the existing Gmail password card and a short app-password hint (the Yahoo hint is the model), including the help link above. It must not call Google mail OAuth.
2. Password Gmail must not be offered Grant labels, Grant filters, or Grant vacation. Rules already stay local. Vacation should show the existing unsupported-IMAP result and the Gmail settings link, not a Restricted consent.
3. Calendar stays a separate button and the current Sensitive scopes only.
4. Existing `gmail_api` and legacy OAuth IMAP accounts keep working until the cache rule in the migration section is implemented. No silent flip.
5. In that same PR, update `AGENTS.md`, Features, `docs/OAUTH.md` wire-up, and the docs listed above so help matches the code.

No UI copy in this PR. The button still starts Gmail API OAuth; a hint that said otherwise would be wrong.

## Decision checklist for Leo

- [ ] Path 3 replaces the v0.2.39 Gmail API goal for **new** Google mail.
- [ ] IMAP XOAUTH2 stays rejected because of `https://mail.google.com/`.
- [ ] The feature losses in the table are acceptable.
- [ ] Accounts that cannot create an app password, or whose admin blocks IMAP, have no Google mail connection in Morrow.
- [ ] Optional Calendar OAuth stays, Sensitive scopes only, same Desktop client, separate consent.
- [ ] Microsoft is unchanged.
- [ ] The app does not revoke tokens. The user revokes Morrow in Google Account if they want the old Restricted grant removed. Account ids are kept.
- [ ] Cache handling for `gmail_api` is decided before any existing API account is moved. Today's password reconnect is not that migration.
- [ ] Console scope removal waits until the app no longer requests Restricted Gmail scopes.
- [ ] Privacy-site and AI-disclosure edits stay in the privacy repo, after the binary matches this ADR.
- [ ] The follow-up may retarget "Continue with Google" at the Gmail app-password card and drop the three Google grant buttons.

## Sources

Checked 2026-10-27:

- [Choose Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) (updated 2026-09-10 UTC). Restricted table includes `https://mail.google.com/`, `gmail.modify`, and `gmail.settings.basic`.
- [Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification). CASA applies when the app requests Restricted data and can access it from or through a third-party server.
- [Sign in with app passwords](https://support.google.com/mail/answer/185833).
- [Less secure apps to OAuth](https://support.google.com/a/answer/14114704) and [admin IMAP](https://support.google.com/a/answer/105694).

No Google account was signed in, and no Console or mailbox call was made.
