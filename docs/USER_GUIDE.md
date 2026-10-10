# Morrow Mail user guide

[README](../README.md) · [Agent CLI](CLI.md) · [Feature coverage](../FEATURE_COVERAGE.md) · [Verification](../VERIFICATION.md)

This guide describes **Morrow Mail 0.7.0**, including attachments, newest-first imports, agent CLI sync, daily Today cards and resumable update handoff. Packages are ad-hoc signed on macOS without notarization and unsigned on Windows; live-account, clean-machine and full accessibility acceptance remain incomplete.

- [Mailbox setup](#connect-a-mailbox), [compose and organize](#compose-and-organize), [attachments](#attachments)
- [Reading safety](#reading-and-mail-safety), [sync and activity](#gmail-coverage-and-activity), [calendars](#connect-calendars)
- [AI setup](#connect-ai), [mail assistance](#in-place-mail-assistance), [AI Studio](#ai-studio-and-reviewed-memory), [Today](#today-dashboard), [search](#search-and-optional-smart-search)
- [Permissions, updates and automation](#permissions-and-settings), [reviewed attention workflows](#reviewed-attention-workflows), [simulations](#ai-studio-simulations)
- [Data](#data-and-configuration), [backup and recovery](#backup-and-recovery)
- [macOS](#native-macos-app), [Windows](#windows-desktop-app), [historical screenshots](#historical-screenshots)

For installation, start with [Download](../README.md#download). Build and release rules are in [AGENTS.md](../AGENTS.md); earlier version announcements remain in the [changelog](../CHANGELOG.md) and [release notes](releases/).

## Connect a mailbox

Open **Settings → Mail accounts** and select a provider. Connect as many mailboxes as you need, including multiple accounts from the same provider. Use **Add Another Account** for the next connection. Builds can include Morrow’s Google Desktop OAuth registration for Gmail and Google Calendar. Those builds show a Google sign-in button without credential fields; custom Google registrations remain an advanced option. Source builds without the Google configuration require your own Google app registration; Outlook uses the bundled public Microsoft client by default. Authorization and token exchange run locally; there is no hosted OAuth service.

The native sidebar includes **All accounts** with combined folders, then separate folders under each connected email address. Both clients group folders under each account. All accounts and individual accounts can be collapsed independently; each client remembers its disclosure state. Combined mail defaults to newest first and supports the selected sort order and shows each message’s mailbox. The current source removes Demo from account navigation, Settings and sender choices. A saved Demo selection switches to the first connected mailbox; without accounts, the app shows Add account. Internal sample data remains available to isolated tests.

**From** chooses the account for a new message. Replies, Reply All, forwards, saved drafts, and uncertain deliveries stay with their original account. Reply All combines sender/To/Cc, excludes your address and deduplicates recipients without copying Bcc. Forward starts with empty recipients, quotes the original plain text and includes the downloaded attachments for review. AI actions on a selected message use that message’s mailbox; choose an individual account for mailbox-wide AI Studio tools, skills, and Email Brain. No AI request combines account histories.

Sync refreshes the selected mailbox, or every connected mailbox from **All accounts**. A failure in one combined sync is reported while successful accounts keep their updates. Disconnect removes only the chosen account’s credentials. Cached mail, drafts, and account-specific workspace records remain on this computer and return when the same email address reconnects. Disconnected accounts are excluded from combined views. Reconnecting an existing address updates its connection rather than adding a duplicate.

Existing single-mailbox installations are supported automatically, preserving their connection and cached mail. The last selected real account or combined view is restored on restart; each message action carries its own account identity so switching views cannot redirect a draft or send.

### Gmail

If Settings says **Google sign-in is ready**, click the browser sign-in button. The publisher manages the Cloud setup below; ordinary users do not need to register an app. These setup steps apply to publishers, source builds, and the advanced custom-client option:

1. Create or select a project in [Google Cloud Console](https://console.cloud.google.com/) and enable the **Gmail API**.
2. Configure the OAuth consent screen. For an external app in testing, add your Google account under **Test users**.
3. Configure `openid`, `email`, and `https://www.googleapis.com/auth/gmail.modify`. Mail sign-in requests reading, sending, moving to Trash and label changes by default; no separate move-permission checkbox is required. Older read/send-only connections need one new sign-in to grant these permissions.
4. Create an OAuth client with application type **Desktop app**. Copy its client ID and client secret into Morrow's Gmail settings, then connect and sign in.

The local callback is `http://localhost:3001/api/oauth/google/callback`. Desktop clients use a loopback callback; they do not use the web-client redirect URI configuration.

Google external apps in testing receive [refresh tokens that expire after seven days](https://developers.google.com/identity/protocols/oauth2#expiration) for these Gmail scopes, requiring reconnection. Publishing an app for other users can require Google's verification process. See the [Gmail API setup guide](https://developers.google.com/workspace/gmail/api/quickstart/nodejs) and [desktop OAuth documentation](https://developers.google.com/identity/protocols/oauth2/native-app).

### Additional Google permissions

Use the existing **Desktop app** OAuth client; another client ID or JSON is not needed. If you use Morrow's built-in client, its publisher must configure the Google project; if you supplied a custom client, do this in that project:

1. In **Google Auth Platform → Data Access**, add the scopes used by the feature. Out of Office requires `https://www.googleapis.com/auth/gmail.settings.basic`; Calendar requires `https://www.googleapis.com/auth/calendar.calendarlist.readonly` and `https://www.googleapis.com/auth/calendar.events`. Enable the Gmail/Google Calendar APIs as applicable.
2. Under **Audience**, keep your Google account in Test users while the app is in Testing. For public use, complete the required sensitive/restricted-scope verification. Adding a scope in the console does not grant access to an already connected account.
3. In Morrow, choose the owning mailbox → **Out of Office → Allow Out of Office Settings…**, or **Settings → Calendar → Sign in with Google in browser**. Finish browser consent with the same intended account. Mail and calendar grants remain separate; existing mail, drafts and other accounts are retained.

Calendar reminders use the event-write scope already requested by Calendar; they need no extra email-send permission. For Out of Office, consent alone does not activate the vacation response: review and save its settings separately. See Google's [scope verification guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) and [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth).

### Google registration for desktop builds

Provide a downloaded **Desktop app** OAuth JSON file when packaging, for example:

```sh
MORROW_GOOGLE_OAUTH_FILE=/absolute/path/google-desktop-client.json /bin/sh scripts/build-macos-native.sh
```

The Windows builder accepts the same environment variable. CI uses the repository Actions secret **`GOOGLE_DESKTOP_OAUTH_JSON`** for both platforms; tagged builds fail if it is missing. Local/fork builds without a build input keep the custom-client flow. The JSON must contain an `installed` client; web-client credentials are rejected.

The build embeds only the Desktop client ID and secret in the private backend bundle, not the renderer or public API. Installed-app credentials can be extracted from the distributed package and are not confidential server secrets. Never put user access/refresh tokens in this input. The raw downloaded file and generated `google-oauth.json` must stay out of Git.

The publisher must enable Gmail and Calendar APIs, configure the consent screen and test users, and complete any required Google verification. Bundling a client does not verify these Cloud settings or lift Testing restrictions. Users still authorize their own Google accounts in the browser.

### Outlook / Microsoft 365

For publisher/custom-client setup, including the additional Google and Microsoft Out of Office permissions and both calendar callbacks, follow the [繁體中文 OAuth setup guide](OAUTH_SETUP.zh-TW.md). The WinUI/Rust migration uses the existing Microsoft Graph registration; it does not require a new client ID.

Click **Sign in with Microsoft in browser** for mail or Outlook Calendar. No client ID, secret or JSON is required from users. Morrow’s public desktop registration is shared by both clients and both services through `shared/microsoft-client-id.txt`; it contains no secret.

For a custom registration, select **Use my own Microsoft OAuth client** under Advanced and follow these steps:

1. In [Microsoft Entra app registrations](https://entra.microsoft.com/), register an application. Select **Accounts in any organizational directory and personal Microsoft accounts** to support both work/school accounts and personal Outlook accounts.
2. Under **Authentication**, add the **Mobile and desktop applications** platform with the custom redirect URI `http://localhost:3001/api/oauth/microsoft/callback`. Enable public client flows.
3. Add Microsoft Graph **delegated** permissions `User.Read`, `Mail.ReadWrite`, and `Mail.Send`. Mail sign-in requests reading, sending and folder/Trash moves by default, without a separate permission checkbox. Older read/send-only connections need one new sign-in. Morrow also requests `offline_access` to refresh the connection.
4. Copy the application/client ID into Morrow's Outlook settings, then connect and sign in. This public desktop client does not require a client secret.

Microsoft uses a client ID, not a downloaded Google-style credentials JSON. The same app registration can serve mail and calendar: also register `http://localhost:3001/api/calendar-oauth/microsoft/callback` and add delegated `Calendars.ReadWrite` for calendar access. Native localhost redirect matching ignores the port but preserves the path, so Morrow’s random desktop port does not need a separate registration. The built-in client is selected by default; these registration details are for publishers and advanced custom clients. See Microsoft’s [desktop registration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration) and [loopback redirect rules](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url).

Your organization may require administrator approval for consent or restrict app registration. See Microsoft's [app registration guide](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app), [platform configuration](https://learn.microsoft.com/en-us/graph/auth-register-app-v2), and [Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference).

### IMAP / SMTP

Enter your email address, mailbox password or provider-issued app password, and the provider's server names in Settings. Use TLS IMAP, normally port **993**. SMTP supports **465** with TLS or **587** with STARTTLS. Providers must permit password/app-password authentication; use the OAuth options above for Gmail and Outlook.

IMAP retrieves mail; SMTP sends it. Use your provider's documented hostnames instead of guessing them.

Current source reports failed IMAP TCP connections as provider failures, preserving cached mail and folder names; they no longer appear as local file-storage errors.

### Yahoo Mail / Hong Kong

Yahoo Mail, including `@yahoo.com.hk`, uses the existing IMAP/SMTP connection. In **Settings → Mail accounts → Yahoo / IMAP**, choose **Use Yahoo Mail / HK Settings**, enter the full email address and a Yahoo **app password**, then choose **Connect & Sync**. The preset keeps the address, fills `imap.mail.yahoo.com:993` and `smtp.mail.yahoo.com:465` (TLS), and clears any password typed for the previous servers. Custom IMAP and SMTP port 587/STARTTLS remain available.

Create the app password in Yahoo Account Security, following [Yahoo’s app-password guide](https://hk.help.yahoo.com/kb/SLN15241.html); do not enter your ordinary Yahoo sign-in password. See [Yahoo Hong Kong’s IMAP settings](https://hk.help.yahoo.com/kb/SLN4075.html). App-password availability is controlled by Yahoo. Morrow currently uses password-based IMAP/SMTP for Yahoo, not Yahoo browser OAuth, calendar integration or server-managed Out of Office. The preset is covered by local checks; a real Yahoo HK account has not been verified.

### Settings navigation

The current Windows source uses the same Morrow light/dark green accent, workspace order and default sidebar/reader proportions as macOS. Compose lives in the sidebar; each account and All accounts expose the same eight mail folders. Search has its own row, with View, Sort and Unread only below it; Sync sits beside Compose. Settings uses a fixed category sidebar and independently scrolling content, collapsed connection/import disclosures, and separate chat/embedding model views. WinUI retains its native controls and system high-contrast colours. The native interface is covered by Windows packaging and automated UI smoke checks; full manual visual/accessibility acceptance remains pending.

Current macOS Settings opens on **Start here**: connect mail, set up and test an optional local or hosted chat model, then review AI permissions. The footer identifies automatic versus explicit saving. Mail starts with an Add or reconnect account disclosure and connected-account status; expand New import range to choose history for your next connection or import. Existing cached mail is retained. Windows uses the same first-account onboarding and category layout; window sizes now account for display scaling, center within the monitor work area, and mail timestamps use local date/time formatting.

Model separates **Chat & replies** from **Search embedding**, with independent test/save controls. General preferences save automatically; AI permissions still require **Save Permissions**, with Discard available. Search uses **Review & Index** before any paid batch; Rust desktop batches can be paused, resumed with confirmation, or cancelled without clearing completed valid vectors. **Clear index** is a separate destructive action. Learning shows the current account and proposal/approved-style status first; identity and learning configuration are separate disclosures, and a generated proposal still requires explicit approval. Calendar supports one Google and one Outlook connection, each with multiple calendars. About labels the previous installer result as history, separate from the installed version.

## Compose and organize

**Settings → General → Sending** sets a default send delay across all accounts: **Immediately** (default), or **1–6 hours**. Native Compose reviews the actual send time, recipients and frozen message before adding delayed mail to **Outbox**. A custom Schedule for later time takes precedence. Changing the default leaves already queued messages unchanged. Each mailbox has an Outbox sidebar entry; the Workspace Outbox also has a mailbox picker. Sent and cancelled jobs leave that list. Cancel an awaiting job to unlock its retained local draft; uncertain deliveries still require the existing explicit retry review.

Delayed and custom scheduled mail use the same persisted local queue. **Morrow must remain open at the chosen time**; catch-up is limited to 15 minutes. A later missed time requires review and rescheduling. This default applies to native Compose, including replies and forwards; explicit `/send` API and CLI delivery keep their immediate-send semantics.

Gmail labels and Outlook/IMAP folder names are automatically downloaded per connected mailbox and saved in the encrypted local settings store. Both native sidebars restore this list on launch without **Browse / Refresh**. While Morrow is open, new/reconnected accounts are checked by the five-second metadata worker; successful catalogs refresh every 15 minutes, independently of the mail-download preference. Offline/network/quota failures retain saved names with persisted retry pacing; authorization or malformed-response failures require reconnect/manual refresh. **Refresh labels / folders** remains an optional immediate read. Browsing uses the provider's exact label/folder ID and shows **downloaded messages only**, including search within that selection. Gmail messages can appear under several labels; local labels and folder overrides do not replace provider membership. Reading names does not require move permission or IMAP MOVE/UIDPLUS support; provider writes retain fresh server validation and review. Folder discovery does not download every message or establish a complete server mirror. Existing Sync and history-import limits still apply.

An account-scoped SQLite membership index for downloaded labels/server folders and search within them avoids full cached-message JSON scans when switching views. Existing workspaces build this index once on first open, which can add startup time for a large cache. Imports, provider moves and deletion maintain it atomically; local folder overrides stay separate. Folder browsing remains complete while the keyword index rebuilds. Paired tagged native checks and public-download/signature verification passed; see [verification](../VERIFICATION.md) for evidence and limits.

To, Cc and Bcc accept up to **100 plain email addresses total**, separated by commas or semicolons. At least one address is required across the three fields; Bcc-only sends are supported. Display-name/group syntax is not accepted. Duplicate addresses are delivered once. Cc/Bcc survive saving and uncertain-send recovery. Review shows all recipients; SMTP Bcc stays in the delivery envelope, and Gmail/Outlook receive it in their provider delivery submission.

Select an imported message and choose **Move / Labels** (or its context menu). The app loads destinations from that message's account, then requires review before writing:

In the native mail list, hovering over a row or focusing it reveals **Mark Read/Unread**, **Reply All**, and **Move to Provider Trash** at the right. **Delete** in the list toolbar or reader uses the same direct provider Trash action. Read/unread writes back for supported imported Gmail/Outlook/IMAP messages with the required provider permission; Reply All opens an owned draft. The Trash action has an Undo button and ⌘Z / Ctrl+Z for one minute per moved message. Undo restores the latest deletion batch to each message's previous provider location and local folder; Gmail keeps its other labels. Closing the app ends the shortcut window; the message remains recoverable in provider Trash. Text fields retain normal text undo. The separate Move / Labels dialog still requires review. Messages without an imported provider identity cannot use provider Delete; permanent deletion is not implemented.

Use **⌘-click on macOS / Ctrl-click on Windows** or **Shift-click** to select multiple messages on the current page. Right-click the selection to delete, mark read/unread, star/unstar, mark/clear Pending, or archive/move to Trash locally. Provider deletions run sequentially using each message's owning account, including in All accounts. A failure stops the batch, reports how many completed and retains Undo for confirmed moves; uncertain writes never retry automatically. Right-clicking an unselected row targets that row. In the **Unread** view, the opened message stays in its original list position after being marked read, until another message is opened or the view/page changes; the unread total still reflects unread messages only.

- **Gmail:** move to a custom label (add it and remove Inbox), return to Inbox, archive, move to Trash, or add/remove a custom label while retaining Inbox status. Other labels remain intact. Trash uses the system `TRASH` label regardless of its displayed name, such as Bin. New sign-ins include organization permission; reconnect older read/send-only accounts once.
- **Outlook:** move to existing folders and nested folders, including Deleted Items, within the same mailbox. Requires delegated `Mail.ReadWrite` permission.
- **IMAP:** move to an existing selectable folder. The Trash shortcut requires a folder advertised with the `\Trash` special-use flag. The server must support **MOVE and UIDPLUS**; Morrow validates UID validity and retains the destination UID to avoid acting on a different message.

The destination limits are 1,000 Gmail labels and 300 Outlook/IMAP folders. Cross-account transfers, bulk moves to arbitrary destinations and full destination-folder synchronization are not included. Moved cached messages outside Inbox appear under local Archive, or local Trash when moved to provider Trash, with their provider location in the reader. Explicitly local folder shortcuts and AI Studio simulations remain separate from these provider changes. Local fixture messages and Pending markers do not trigger provider writes. A failed or lost response requires checking the provider before trying again; there is no automatic move retry. Current-source errors retain safe provider HTTP status and distinguish rejected authorization/permissions, quota limits and uncertain failures, without exposing provider descriptions. When Gmail explicitly reports insufficient permission, sign in again with that same account and approve mail access in the browser. Reading, sending and organization permissions are requested together; incomplete consent retains the existing connection, cached mail, drafts and other accounts. Updating the app does not expand an already-issued token's permissions.


Both clients include a searchable native label/folder manager and message organization pickers on both platforms. The manager opens its account's cached hierarchy, filters full paths, and offers create-at-root, create-child, rename, move-to-parent and delete actions. Parent selection has its own search and excludes the selected item and descendants. Protected folders remain visible with unavailable actions. Provider reads validate each review before writes; errors retain the entered values for explicit review rather than automatic replay.

Email context menus and the reader's **Organize email** menu distinguish **Move to…**, Gmail **Labels…**, **Create new label/folder…** and account-wide **Manage…**. Gmail Labels shows a searchable checklist initialized from the owning cached message's provider label IDs. Filtering retains checked labels; one confirmed request submits only added/removed custom labels (up to 100 of each), preserving Inbox and untouched labels. Outlook and IMAP use a single folder destination. Destination and parent popups have independent search, full paths and keyboard selection. Creating a destination uses the existing folder preview/confirmation, optionally selects it for the email, then requires a separate message-change review. Account-wide rename/delete stays in the manager; removing a label from an email never deletes its account definition.

**Manage labels / folders…** under an individual mailbox opens create, rename, delete and move-to-parent actions in both native clients. A provider read prepares the review; only confirmation writes. Reviews are account/connection-bound, expire after ten minutes and are single-use. System labels and well-known/special-use folders are protected. Gmail hierarchy rename/move updates at most 50 labels per review; it can partially apply because Gmail has no atomic subtree rename. Gmail label deletion retains messages and nested label names. Outlook folder deletion affects its contents and children; IMAP deletion permanently removes the selected mailbox's messages while inferior mailbox names remain. IMAP hierarchy changes use the server delimiter and check UIDVALIDITY; message moves still require MOVE + UIDPLUS. Cached messages, local overrides, Pending and drafts are retained. Renames remap owned provider references and import traversal checkpoints; deletion skips removed traversal entries. Failed or uncertain changes require a fresh provider check and review, with no automatic write replay.

The sidebar's **Filter labels / folders** field filters loaded names locally without changing the current mailbox/message or invoking providers. Names load automatically from the local catalog and update in the background. A label/folder context menu can preselect **Move selected message here…** in the existing reviewed message dialog. On Windows, drag the sidebar's right divider or focus it and use arrow keys; View's wider/narrower actions use the same persisted width (180–600 logical pixels, bounded to retain room for mail). Long names have full-name tooltips. macOS retains native split-view resizing.

Provider semantics: [Gmail modify](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify), [Gmail Trash](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/trash), [Outlook move](https://learn.microsoft.com/en-us/graph/api/message-move?view=graph-rest-1.0), and [Outlook immutable IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id).

### Pending and Out of Office

Mark a message **Pending** in the reader or list menu, then open Pending in that account or All accounts. This local marker is independent of stars, survives sync and does not notify or change the provider.

**Out of Office** reads Gmail vacation settings or Outlook automatic replies. Allow the additional OAuth permission when requested, then review and save the provider settings. The response continues while Morrow is closed; merely opening the tab or granting consent does not activate it. IMAP has no equivalent standard and links to the provider instead.

## Attachments

These attachment features are included in version 0.7.0.

Both native clients can add/remove attachments, download received files, save them with OS quarantine, and include immutable account-owned references in reviewed sends, forwards, copied provider drafts and scheduled messages. Download attachments before forwarding or copying them; Gmail’s original provider draft stays unchanged.

The local limit is **100 files / 50 MiB decoded data per message**, with an **80 MiB raw MIME download ceiling**. Provider sending limits remain separate, including MIME encoding overhead; see the [CLI size-limit details](CLI.md#fetch-current-mail-and-attachments). Outlook uses Graph upload sessions for larger files. A failed or interrupted upload can leave a provider draft and requires delivery review, never automatic replay.

Attachment bytes stay out of AI context and list metadata. Explicitly downloaded CID images support PNG/JPEG/GIF/WebP only, capped at 1 MiB of image data within 1.5 MiB of sanitized HTML. Arbitrary embedded file previews, antivirus scanning and automatic orphan-attachment cleanup are not implemented.

## Reading and mail safety

Newly fetched Gmail, Outlook and IMAP messages retain sanitized formatting and links alongside their plain-text body. Existing cached messages need to be fetched again to gain HTML; plain-text links already work. The reader blocks scripts, forms, embedded pages and external images by default. You can load HTTPS images for one message after a tracking warning, or switch to plain text. Links show their destination for confirmation before opening outside the reader. Use **Load attachments and inline images** to download attachment bytes, then **Save** to a chosen file. Only downloaded PNG/JPEG/GIF/WebP CID images are rendered; arbitrary attachment files are not executed or embedded. These controls reduce active-content and tracking risks; they do not certify a message or destination as free of phishing or malware.

**Settings → General → Automatically load external images (HTTPS)**, under Appearance & reading on macOS. It is off by default, saves automatically and applies to opened messages across all mailboxes, including macOS reply-history readers. Enabling it allows image servers to learn your IP address and that you opened an email. **Hide external images** still blocks images for the current message; turn the preference off to restore blocking by default. Scripts, forms, embedded content and link destination review retain their existing restrictions.

Use **Move / Labels / Spam** to move a downloaded Gmail or Outlook message to the provider's Spam/Junk folder, with existing write permission and explicit confirmation. Moving Gmail mail back to Inbox removes its Spam label. This is a manual provider operation, not a local shortcut or a complete Spam-folder sync. Morrow does not implement phishing reports or sender blocking; the dialog links to the provider website for those actions. Spam stays outside default search and AI context.

Mail settings and Activity show import progress, safe failure reasons and recovery actions. Read-only history fetches automatically retry transient network/5xx errors after 30 seconds, 2, 5, 15 and then 60 minutes, continuing hourly until recovery. HTTP 429 and recognized Gmail 403 quota responses use the existing Sync backoff of 1, 2, 5, 15 and then 60 minutes, also continuing hourly; daily quota errors wait 24 hours. Provider `Retry-After` seconds or HTTP dates can extend these waits. Sync, history import and folder/label reads share a persistent cooldown for the same account and connection; pausing/resuming or restarting an import cannot bypass it. Reconnecting or disconnecting clears only that account's cooldown. Verification of a replacement IMAP connection excludes the previous connection's waits. Error-type changes do not reset the attempt count. The checkpoint and next retry time survive app restarts, and retries run while Morrow is open. No reconnect or manual Resume is needed for these temporary failures. Updating also restores older imports stopped by recognized transient errors, provided the connection is unchanged; old quota records conservatively wait 24 hours from the failure because they did not distinguish daily limits. Authentication, malformed pages, invalid cursors and database errors require explicit recovery. Pause/Resume keeps the cursor; restarting replaces the import. Manually paused and unexplained failed imports stay paused or failed.

Incomplete-content records keep their provider identity when an individual body exceeds a supported limit. **Settings → Mail accounts** and CLI status show the current count. Use **Load attachments and inline images** or CLI `fetch` to try full MIME recovery; provider/parser limits may still prevent loading. Finishing history pages does not mean every body is complete. Invalid provider dates or unresolved IMAP reads retain the same page and require explicit recovery. See [fetch recovery behavior and limits](FETCH_RECOVERY.md).

## Gmail coverage and activity

Gmail refresh checks up to 50 recent messages in each of Inbox, Sent, Drafts, Starred and All Mail, deduplicating overlaps. In **Settings → Mail accounts**, select **All Gmail mail** and start an All history or 1/3/6/12-month import to page through older mail, including archived messages and custom labels. Spam and Trash are excluded from these provider fetches. Existing imports keep their saved scope until restarted.

User label names appear on downloaded messages. To find a label across folders, choose **Filters & Scope → Current account view → Label**. A message has one primary local folder (Trash, Spam, Drafts, Inbox, Sent, then Archive); Starred is a separate view. This is bounded downloading, not a complete Gmail mirror. Cached-message metadata is reconciled in batches; read/star actions write back with organization permission, while local folder shortcuts stay local. Imported Gmail drafts can be copied into an owner-bound local draft; attachments are downloaded before copying and the Gmail original is not updated or removed.

Current source deduplicates Gmail message IDs across the five refresh scopes. Cached non-draft bodies are reused while minimal provider responses update labels/read/star state; new messages, drafts and incomplete older caches without the required body/reply metadata still fetch full content. Known content-limit records reuse validated metadata until explicit MIME recovery. A message removed between listing and reading (detail HTTP 404) is skipped without stopping the history page. Other failures retain their normal recovery rules. This reduces duplicate requests and downloaded bytes; refresh remains bounded polling, not Gmail history-delta synchronization.

Gmail and IMAP reconcile up to 50 cached messages per sync using an account/connection checkpoint. Read/star changes write back to supported provider messages; Gmail needs organization permission. Missing messages keep their cached content. IMAP UIDVALIDITY changes mark an old location unavailable instead of applying its UID to another message. Outlook advances a saved delta page and checks up to 25 cached messages per round. These bounded rounds can require multiple syncs; none is a complete server mirror.

From 0.7.1, a fetched server Read/Unread value repairs a stale local flag even if the server value has not changed since an earlier sync. Missing metadata does not invent a read state. An IMAP folder confirmed absent is marked unavailable while other folders continue; its cached content stays available and later sync rounds can detect its return. Authentication, connection and failed folder-list responses remain visible errors. Use Sync again or enable a regular sync interval to continue through larger caches.

The **Mail and AI activity** control updates independently every two seconds while the app is active. Expand it for each account's fetching, history pages/messages, queued/running AI summaries, learning and embedding indexing, plus paused or failed work. Unknown totals are not shown as percentages. Idle does not mean the whole mailbox has downloaded; older mail depends on the import range, and AI runs only under its existing permissions and triggers.

## Connect calendars

Open **Settings → Calendar** to connect providers, or use **Connections** on the separate Calendar page. You can connect **Google Calendar and Microsoft Calendar at the same time**, independently of your mail accounts. Calendar connections currently support one Google account and one Microsoft account; each can expose multiple calendars. Calendar connections also work before adding a mail account. The Calendar page opens a month grid. Use the calendar checkboxes to display up to **12 calendars** together, including read-only calendars; change month or choose Today. Events crossing midnight appear on each affected day, while all-day end dates are exclusive. A busy or unavailable calendar shows its own error; a failed/truncated response is not shown as complete. The underlying API accepts ranges of up to **90 days**. Outlook all-day events converted away from midnight are reread in their provider-reported original timezone (at most 100 repairs per calendar request, four at once); unrecognized/custom zones or excess repairs show an incomplete-calendar error instead of guessing a date.

Click a date, choose a writable checked calendar, enter the details, then review the destination, date/time and reminder before submitting. Reminder choices are the calendar default, none, notification, or **email for Google only**, from event start to four weeks before. Google sends the reminder to the connected calendar user; it is not an attendee invitation or a Morrow scheduled email. Outlook exposes a notification reminder, not an email reminder. Calendar-provider and device notification settings still determine delivery. Morrow can be closed when the reminder is due. Events are created without attendees; Morrow does not send invitations. Calendar access is separate from AI Studio: its simulated scheduling and meeting-preparation features do not read these live calendars or create live events.

### Google Calendar

A build with Google sign-in configured uses the same built-in Desktop client as Gmail. Choose **Sign in with Google in browser** in Calendar settings; calendar consent remains separate from mail consent. The following setup is for the publisher or a custom-client user:

1. In your Google Cloud project, enable the **Google Calendar API**. You can reuse the Gmail project's **Desktop app** OAuth registration.
2. Configure the consent screen and add your account as a test user when the app is in testing.
3. Add `openid`, `email`, `https://www.googleapis.com/auth/calendar.calendarlist.readonly`, and `https://www.googleapis.com/auth/calendar.events` to the app's requested scopes.
4. Enter the desktop client ID and secret in **Settings → Calendar → Google Calendar** and sign in.

The calendar callback is `http://localhost:3001/api/calendar-oauth/google/callback`. Desktop clients use the local loopback callback rather than a web-client redirect list. These calendar scopes permit listing calendars and reading/writing events; the seven-day testing-token caveat described above also applies. See Google's [Calendar setup guide](https://developers.google.com/workspace/calendar/api/quickstart/nodejs) and [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth).

### Microsoft Calendar

1. Create or reuse a Microsoft Entra app registration that supports **work/school and personal Microsoft accounts**.
2. Under **Authentication → Mobile and desktop applications**, add `http://localhost:3001/api/calendar-oauth/microsoft/callback` and enable public client flows. Keep the mail callback too if using the same app for Outlook mail.
3. Add Microsoft Graph **delegated** permissions `User.Read` and `Calendars.ReadWrite`. Morrow also requests `offline_access` for refresh tokens.
4. Enter the application/client ID in **Settings → Calendar → Outlook Calendar** and sign in. No client secret is required.

An organization may require administrator approval. Microsoft's [event creation documentation](https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0) confirms the delegated permission and explains that adding attendees sends invitations; Morrow's creation flow does not include attendees. See the [Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference) for scope details.

## Connect AI

In **Settings → Advanced setup → AI connection**, enter your own OpenAI-compatible **base URL**, **model ID**, and **API key**. The key is optional for endpoints that do not require one. Response token limits and temperature are under Advanced response settings; ask your IT support or AI provider if you need help with the connection details.

**Test connection** sends a fixed test prompt with no email content and does not save your changes. Save separately. Chat and embedding show saved-key status and collapse the replacement field; changing only the model ID reuses the saved key. Blank API-key input retains that key at the same normalized base URL, including equivalent trailing-slash/default-port spellings. Changing the endpoint requires its own key. Tests and failed saves keep an entered replacement key available for Save or retry; saved keys remain hidden. Use the remove-key control to clear a saved key.

For a local [Ollama](https://ollama.com/) model:

```sh
ollama pull qwen3:8b
```

Use base URL `http://127.0.0.1:11434/v1` and model `qwen3:8b` while Ollama is running. You can substitute another model you have installed. Remote providers must use HTTPS and may require an API key.

Summaries, replies, inbox questions, writing, rewriting, translation, briefings, and custom skills use the configured model when invoked. Model-backed assistance requires a configured model. Isolated demo fixtures return labeled illustrative results.

## In-place mail assistance

**Summarize**, **Suggest Reply** and **Translate** open a popup over the selected message. You can review or copy the result; **Use in Draft** creates a reply from that message’s original account. AI Studio remains available for broader tools. No AI action sends mail automatically.

**Suggest with History** is a separate, explicit action. It scans all downloaded records in the owning account for the exact correspondent address (case-insensitive), within your allowed AI folders. This includes incoming mail from that sender and your Sent mail addressed to that sender in To/Cc when Sent access is allowed. The selected message stays first; the newest matching messages fill the saved **1–50 message** context limit, including the selected message. The result shows how many permitted messages matched and how many were used. Sender access is required; unchecked subject/body fields stay withheld. Selected bodies are capped at 18,000 UTF-16 characters and historical bodies at 5,000 each. It does not fetch provider history, include other accounts, or analyze an unlimited mailbox. Import older mail first if needed. Changed sources, connections or permissions invalidate a running result.

The reader keeps subject, sender and date/time close together. Expand message details for complete addresses, recipients, mailbox and other metadata; expand a summary to read the full result without another AI request.

## AI Studio and reviewed memory

AI Studio has two primary pages: **Assistant** and **Summaries**. Optional **Writing style & notes** is under **More**. Choose a mailbox inside Studio for account-specific AI work; **All accounts** combines saved summaries. Assistant opens on Ask My Mail and shows a task picker containing real model actions. Optional instructions and advanced settings are collapsed. **More** also contains reusable skills, local simulations and simulation history (plus reviewed reply suggestions on Windows). A missing model is shown as setup needed, not a demo response.

Assistant uses one task picker for asking about mail, drafting replies and creating summaries, without duplicate shortcut buttons. Selected-email actions can search downloaded mail by sender or subject, then choose a permitted result without paging the inbox. Model and permission blockers link to the relevant Settings page; generated replies still open as drafts for review.

In **More → Writing style & notes**, **Learn Now** reviews this account’s downloaded Sent samples and offers an AI writing-style proposal for approval. Optional daily Sent review runs while Morrow is open and waits for approval before using a new style; existing weekly consent stays weekly until changed. Approved style guides new-mail and reply assistance from the same account; it never sends mail. The separate, collapsed **Notes and memory suggestions** section offers **Suggest Memories · Uses AI** from permitted cached messages. Every memory proposal displays supporting source subjects/dates; nothing is saved until you select items and choose **Save Selected Memories**. Optional weekly memory suggestions retain their own budget and review flow. Manual proposals expire after ten minutes or service restart. All proposals are rejected after relevant account, settings or source changes. The model may still misinterpret a source: citations are checked against supplied IDs, not independently fact-checked.

Reviewed memories are stored separately from manual voice/notes, with at most 50 per account and individual removal. Their source content and folder permissions are checked each time they are used. Changed or removed sources suppress the affected memories without deleting your saved notes. Interactive assistance, scheduled summaries and batch reply suggestions use the same memory validation. The legacy simulated memory endpoint remains labeled a simulation and cannot replace an existing Brain.

For writing, the explicit request takes precedence over manual writing voice, approved learned style, then default tone. Confirmed identity is passed separately; signatures and memory must not be used to infer the owner's name. Daily style proposals include the still-valid approved baseline, preserve its source references and require explicit approval. After 150 accumulated baseline source references, run a full analysis to refresh the bounded profile.

Ask My Mail reuses the search engine's Unicode and traditional/simplified Chinese normalization and Chinese bigrams, matching whole normalized tokens against permitted redacted fields. It remains a bounded lexical selection; it does not automatically call the embedding service or provide semantic retrieval. Briefings prioritize explicit Pending, stars, unread mail, then recency. This can include older marked work, but does not infer complete thread resolution or guarantee that every outstanding request is included.

Reply Suggestions automatic checks use the newest 200 downloaded Inbox messages, with at most ten permitted correspondence messages per target. The separate daily allowance defaults to 100,000 estimated tokens (4,000–2,000,000); unchanged valid assessments and ignored mail are not charged again. Permission, connection, model or identity changes require renewed approval. AI may misclassify a request; this is not exhaustive unanswered-thread detection.

Settings shows six everyday categories: **Start here**, **General**, **Mail accounts**, **Calendar**, **AI & privacy**, and **About**. **Advanced setup** contains **AI connection**, **Search index**, and **Writing style**; direct setup links open that group. AI & privacy shows permitted folders and information first, with automatic assistance, available tasks, limits and simulations collapsed. The automatic-assistance heading reports the saved On/Off/Paused status. Existing choices are retained. Save/Discard appears for edits where appropriate; General saves automatically. Credentials, permissions, paid automation and applying a learned style retain explicit review.

Mail and Calendar settings refresh saved connection status automatically every three seconds while open (macOS while Morrow is active), including after browser sign-in. Mail imports update on the same read-only refresh. Entered credentials and other unsaved settings stay in place; **Refresh Status / Refresh connections** remains available. Status refresh reads the local service without syncing mail, fetching calendar events or calling AI.

## Today dashboard

Choose **Today** in the sidebar for downloaded unread Inbox / Inbox / Draft totals and summaries from **all connected mailboxes**, regardless of the selected account. Reports retain their account label and separate AI context. Completed jobs use their completion date; queued/running jobs use their creation date, interpreted in your local time. Today groups the latest 20 validated jobs per mailbox into one stable card per local date. Later jobs update each message’s summary within that card; a failed attempt retains the earlier valid content. Opening Today starts no AI and also shows the saved summary schedule. Individual jobs remain in Summary History. Enable scheduled or new-mail summaries in AI Permissions; Morrow must be open when they run. New-mail summaries follow newly synced messages, not historical imports. **Summary History** opens AI Studio → Summaries, where the mailbox picker can show one or all accounts.

**Summarize now** reviews one connected mailbox and immediately generates a saved P0–P4 **On-demand summary** after confirmation. It uses downloaded mail across all dates, the saved folder / Inbox-only / starred-only filters and the 1–50-message context limit, prioritizing Pending, starred and unread mail. A configured AI connection, enabled AI and Inbox briefing permission plus subject, body or sender access are required; automatic summary triggers may stay off. Review shows the mailbox, permitted message metadata, model and endpoint before the model call. The service consumes that preview once and revalidates its sources, permissions and connection; changes invalidate the review. Failed or interrupted calls require another explicit review and never retry automatically. The action does not sync mail, change the automatic schedule or send messages.

Workspace appears above All accounts. The macOS app removes the top title/toolbar area: the sidebar toggle sits beside Morrow, Compose sits below it, Sync is beside Compose, reading layout is available in the list and the macOS View menu, and Expand/Restore is in the reader. Drag the dividers to give the sidebar, list or reader more space. Native window controls and close-to-Dock behavior remain available.

## Search and optional smart search

The SwiftUI and WinUI clients share a SQLite FTS5 index covering downloaded subjects, sender/recipients, bodies and labels. Search supports single/two-character Chinese queries, traditional/simplified conversion, mixed English, quoted phrases, relevance/date sorting, 30-result pages, recent/saved searches and removable filters. Results show their owning account, matching text and folder. Replies retain that account.

Choose the current folder, current account view, or all connected accounts under **Filters & Scope**. The combined view excludes Demo and disconnected mail. **Downloaded Coverage** shows cached counts/date ranges; mail that has not been imported cannot appear. Trash and Spam require an explicit folder selection. Inboxes use bounded metadata pages and load bodies when opened. Outlook uses saved delta checkpoints; Gmail and IMAP use bounded polling and cached-message reconciliation, not Gmail History API or IMAP QRESYNC.

Use `from:jane@example.com to:me@example.com subject:"project update" after:2026-09-01 before:2026-10-01 is:unread label:Finance`, or the filter controls. Words/conditions use AND; quoted phrases preserve word order. `to:` includes To/Cc/Bcc, `is:` also accepts `read`/`starred`/`pending`, and `in:` accepts local folder names. Date bounds are UTC: `after:` includes that day; `before:` excludes it. Filters narrow the selected scope, so choose account/all scope to search another folder. English word prefixes and normalized exact phrases are supported; arbitrary infix/fuzzy spelling and attachment search are not.

**Settings → Advanced setup → AI connection → Search embedding** configures the separate embedding base URL, model ID, API key and OpenAI-compatible `/embeddings` or Ollama `/api/embed` protocol. **Test Connection** uses entered fields without saving them and sends only a fixed sentence, never mail; the provider may charge. **Settings → Advanced setup → Search index** makes reviewed automatic indexing the primary action in version 0.7.0. Choose accounts, folders, content fields and **All downloaded mail / 1 / 3 / 6 / 12 months**, then confirm the connection, scope and daily allowance. New configurations default to All downloaded mail; existing saved ranges and the older implicit three-month scope are retained until explicitly changed and reviewed. Global AI permissions restrict text before any request.

The service automatically processes successive bounded batches and new/changed permitted text while Morrow is open, reusing unchanged valid vectors. Progress shows indexed/eligible messages, pending work and separate size-limit exclusions. **Pause automatic indexing** keeps completed vectors, unfinished chunk checkpoints and unsaved form edits. **Advanced indexing options** contains the 4,000–2,000,000 estimated-token daily limit (default 100,000), Smart Search enable/disable and the 4,000–64,000 per-batch budget. Batches also respect the global message limit and 50 overlapping chunks per message; oversized or over-budget messages remain keyword-searchable. An individual chunk above the entire daily allowance needs a higher daily limit; it is shown separately from waiting for tomorrow. Estimates are conservative UTF-8 counts, not exact billing. **Manual indexing & maintenance** retains explicit batch review/pause/resume/cancel; Clear index remains a separate destructive review.

Daily indexing usage is reserved before network calls, survives restart and resets at midnight UTC; insufficient remaining allowance displays automatic continuation at the next reset. A message can finish across several days using persisted chunk checkpoints without resending completed chunks. Raising the daily allowance keeps waiting checkpoints; lowering it requeues unfinished automatic work within the new limit and requires renewed approval before possible paid replay, while completed mail vectors remain. The limit applies to indexing, not semantic queries. Changing the model, permissions, scope or connection requires renewed review and invalidates prior vectors/results. Clearing the index revokes automatic approval. Failed or uncertain interrupted requests never replay automatically; a restart can continue between completed automatic requests.

Enable **Smart Search (智慧搜尋)** in the search controls and press **Search**. The query goes to the embedding endpoint; local keyword and vector rankings are merged. Query vectors are cached briefly for pagination. Hybrid results include at most 200 keyword and 200 semantic candidates; use keyword mode for exhaustive results. The exact vector scan accepts up to 12,000 scoped chunks and four million vector values, asking for narrower filters above either limit. Retrieval quality depends on your embedding model; it does not generate an answer or establish factual accuracy.

Mail text goes only to the selected embedding endpoint during approved batches; a remote endpoint requires HTTPS. Changed permissions/model/connection invalidate vectors and in-flight results. Vectors stay in the local SQLite database alongside plaintext mail; API keys and search history use the existing encrypted settings store. On Rust desktop, **Pause / Resume / Cancel batch** manage unfinished work while retaining completed valid vectors; resuming requires review. **Clear index** is separate, removes all semantic vectors and cancels the batch, while preserving mail and the keyword index.

After confirming an indexing batch, you can switch settings tabs, close Settings, and read mail while the service continues the batch. Progress remains in Activity and refreshes when you reopen Search. Morrow must remain running; leaving a page does not cancel the job. Unsaved edits and short save/test/start requests retain their navigation guards.

Search also shows the saved embedding model and endpoint, with **Test Connection** for that saved configuration and **Edit in Model…**. The test uses the same fixed sentence without changing settings or the index. Model retains its test for unsaved connection fields. The native inbox also uses compact View/Sort menus and narrower sidebar/list columns to leave more room for reading.

Embedding failures retain completed valid entries. No batch is automatically retried: check the displayed connection, HTTP status, input or vector error, then explicitly preview another batch. A successful connection test validates a short sentence; later mail batches can still encounter provider input limits, quota or availability errors.

OAuth token refresh preserves saved credentials and distinguishes temporary network/provider failure, rejected app configuration and revoked/expired authorization. Only the last category asks you to reconnect. An app update alone is not evidence that provider consent was revoked.

## Permissions and settings

**Settings → AI & privacy** has a master switch and a checkbox for every behavior. Choose permitted folders, message fields, contextual data, and the maximum message count. These permissions are enforced on the server before AI or simulation input is assembled; unchecked fields are excluded from context and search. Turning off AI leaves manual reading, composing, sending, and Calendar-page actions available.

Model settings, permissions, and general preferences are **global across connected accounts**. Mail, drafts, skills, and workflow records belong to an individual account. Folder permissions apply to locally cached messages. Choose the history scope separately in Mail settings; enabling an AI scope alone does not download a folder. All Mail history includes archived mail for Gmail, Outlook and IMAP in current source. IMAP exclusions depend on advertised Junk/Trash special-use folders; virtual All/Flagged collections are skipped to avoid duplicates.

General settings include your display name, plain-text or HTML signature, theme, density, mark-read-on-open behavior, reply tone, preferred AI response language, independent target translation language (blank follows the preferred language), and sync interval. General preferences save automatically after editing, with visible saving/error status and retry on failure; other credentials, permissions and reviewed actions retain their explicit controls. These language settings control AI output, not UI localization. Timed mail sync checks all connected accounts every 1, 5, 15 or 30 minutes while the service is running; it defaults to manual. Review generated text before inserting it into a draft.

**Morrow checks for updates at launch and every hour while running**, including when Settings is closed. Returning after sleep checks again if the hour has elapsed. A red **!** badge on the Settings button indicates an available update; clicking it opens **About → App updates**. **Check for updates** also works manually. These checks use public releases in `Coke1120/Morrow-Mail` on GitHub. Version 0.7.0 checks normal releases by default; the optional pre-release channel remains available for historical compatibility. The app compares semantic versions among the latest 100 published releases, shows the installed/latest version and check time, and opens the release downloads page. Checks share no mail or credentials, time out after 10 seconds, and cache successful results for one minute. Offline, rate-limit and empty-channel responses are shown as errors, not as “up to date.” A failed check keeps the last known release and badge; the next automatic attempt waits an hour. Changing release channels clears the previous channel’s result. Downloading and installation still require your action. Packaged desktop builds offer **Download update → Install & Restart**. Install an updater-enabled build manually once; older apps cannot acquire this feature themselves.

Downloads use the project's GitHub release assets and verify a pinned Ed25519 signature, exact version/platform, size and SHA-256 before extraction. The app checks archive paths and macOS compatibility/signing, then offers installation. Save or discard edits first. Install & Restart can begin during ongoing activity: it freezes new edits/operations and allows accepted work to drain within the existing 65-second shutdown deadline. Checkpointed downloads and indexing can continue after restart; uncertain sends/calendar writes and unfinished paid requests are not replayed automatically. Installation waits for the UI and private service to stop, replaces only the application, and reopens it automatically. Mail, accounts, preferences and uncertain-operation records stay in the separate data folder. Updates are not installed silently on ordinary quit.

On macOS, update settings remain reachable while busy. After installer preparation, Settings closes and the app quits automatically; new forms and operations remain blocked throughout handoff. A lost preparation response can be checked without starting another installer.

The installation's parent folder must be writable; Morrow never requests administrator elevation. Otherwise use the release downloads. The installer waits up to 45 seconds for the new app and its authenticated local service to become ready; a startup failure restores the previous app and attempts to reopen it. A later crash after successful readiness still needs manual recovery. The previous app remains in the sibling hidden `.morrow-update-…/previous` folder. A later successful update attempts to remove older marked backups for the same installation and its downloaded ZIP; the newest previous app remains available. Interrupted/power-loss installs may require restoring this backup manually. Signature verification does not replace Apple notarization or Windows signing.

**Settings → AI & privacy → Automatic assistance** provides four independent, default-off triggers:

- Summarize when a message opens.
- Suggest text when a new, empty reply opens. Saved drafts and uncertain sends are excluded; inserting text requires a click and preserves recipients and the footer.
- Summarize newly synced messages. Runs after manual or automatic sync discovers new provider IDs; connecting/reconnecting does not summarize the initial imported inbox. This is polling, not provider push. Use General → Refresh connected mailboxes for automatic checks.
- Generate scheduled summaries: daily at a 24-hour time in a saved IANA time zone (for example `09:00`, `Asia/Hong_Kong`), or every **1–168 whole hours**. Results appear under **AI Studio → Summaries**; completed arrival summaries also appear in the message reader.

**Only messages in Inbox** (default on) and **Only starred messages** must both match when checked. Behavior, folder and content permissions also apply before context reaches the model. Drafts and Trash are excluded. Settings apply globally but jobs and results remain account-specific, including in combined views. Demo jobs run only when no real mail account is connected. No trigger sends mail, inserts drafts, creates events, moves mail, or updates Email Brain automatically. Remote models may charge for requests. Opening messages/replies again can make another request; overlapping identical UI requests are coalesced. Activity follows the shared model work, so cancelling one automatic UI waiter does not report a false interruption. Model failures show safe connection/HTTP/response diagnostics; the 45-second model timeout is reported separately and does not start an automatic retry. The reader reuses a retained, valid arrival summary when available.

Scheduled jobs use **cached permitted messages ordered by Pending, stars, unread status, then recency, capped at Maximum messages per request (8 by default, 50 maximum)**. They are a bounded digest, not an exhaustive inbox audit. Each automatic report validates one P0–P4 classification per included message: **P0 explicit emergency; P1 explicit action due today; P2 normal action/follow-up or unclear urgency; P3 information; P4 bulk/promotional**. The selected time zone defines today. These are AI suggestions, never a guarantee of urgency. Models must return valid JSON with every source ID; incomplete output fails rather than showing a partial report. Increase response tokens or reduce the context limit if needed. Demo reports are clearly illustrative and do not perform real priority analysis.

The local service checks schedules every 30 seconds, processing at most four queued model calls serially per tick. Both desktop clients use this same scheduler. The app must remain running. After sleep/restart a daily schedule catches up once for the current day, not every missed day; intervals use persisted attempt times and do not replay missed intervals. Changing/enabling the schedule resets its timing. Daily jobs run at most once per local date, including DST repeated hours; a missing DST time runs after the gap. Failed or interrupted calls are not automatically retried, because they may already have spent tokens. Generate a manual briefing if needed.

The queue holds at most 100 pending jobs per account, retains up to 20 completed/failed/interrupted reports, and shows a counter for overflow requiring manual handling. Summaries displays the latest 20 jobs; it refreshes every 30 seconds when the client is idle and has a manual Refresh button. Results are hidden/discarded when model, AI language/tone, policy, owning connection or permitted source content changes. Turning off triggers keeps manual AI available. No OS notification or system background service is installed.

Morrow preserves safe model connection, HTTP, timeout and response-format diagnostics in failed **Summaries** reports. Older failures whose cause was discarded keep their generic message. Activity retains the last finished summary's status, so repeatedly seeing its warning does not imply repeated model calls; a discarded context also appears as interrupted. Failed paid work still requires a fresh manual review.

### Historical import and writing-style learning

In **Settings → Mail accounts**, choose **All history** or **1, 3, 6 or 12 calendar months** (default 3), then **All Mail** or individual **Inbox / Sent** scopes before connecting. Existing accounts can use **Start chosen import**. This downloads mail locally without any AI calls. New imports fetch the latest seven days across the selected folders before older history; existing jobs retain their checkpoint and scope. Progress, pause and resume are per account; read-only pages checkpoint to disk and resume after restart. Refresh progress in Settings. Importing a shorter range never deletes cached mail. Historical import does not generate new-mail summaries. IMAP Sent requires the server to advertise its `\Sent` special-use folder; if unavailable, select Inbox only or configure Sent on the provider. Large IMAP messages still use the existing 5 MB body ceiling. Gmail/Outlook page tokens and IMAP UIDVALIDITY are checked; a changed IMAP folder requires a fresh import.

In **Settings → Advanced setup → Writing style**, select an individual connected account and optionally enable **Learn my writing style**. This requires the global AI switch, Email Brain behavior, Sent scope and body permission. It does **not** require Contacts, Subject or Sender permission: only cleaned body samples go to the model; ownership and diversity selection happen locally. Reviewed Brain memories and manual contact/project notes remain separate. Learning can be skipped entirely.

1. Save the learning range, sample cap (**1–50**) and per-analysis token budget (**4,000–64,000**, default **16,000**). The global **Maximum messages per request** also applies (default 8; raise it explicitly if desired).
2. **Preview samples** uses no AI. It filters sent mail authored by the account, excludes recognized automatic mail, deduplicates normalized text and alternates date/recipient buckets. Common quotes, forwarded chains, signature delimiters and disclaimers are stripped heuristically. Review the exact sample text; unusual formatting may remain. Individual samples are capped at 6,000 characters.
3. Review useful/sample counts and the conservative **UTF-8-based token estimate**, including request framing and output allowance, then choose **Analyze these samples**. Current source also offers **Learn Now · Uses AI**: it prepares samples from saved settings, shows the account/model/endpoint/budget and two short excerpts, then asks for confirmation before analysis. Cancel retains the full preview without calling the model. This estimate is not a custom-model tokenizer or a monetary spending guarantee. Provider-reported token usage is shown when supplied.
4. Edit the proposed style and choose **Save approved style**. Only then can it inform writing/reply/rewrite requests, while the relevant permissions and source scope still allow it. It does not overwrite Email Brain contacts, project notes or manually entered voice. This creates prompt context, not fine-tuned model weights. Delete the learned style to remove the profile/preview and turn learning off; original mail remains.

Optional **weekly analysis** starts with the first eligible analysis after enabling, then runs at most once per seven elapsed days while the service is open. The first proposal uses the saved Sent range; a valid approved baseline enables incremental analysis of newly dated Sent mail. It uses cached mail; enable periodic mail refresh to capture messages sent in another app. Pending review pauses the next run. Newly proposed styles never overwrite the approved style automatically. Failed or interrupted model calls are not replayed automatically; another manual request or a later weekly run may incur new usage. Changing model, permissions, connection or source content invalidates a pending result. Only the current preview and approved profile are retained, not an unlimited audit history.

Mailbox interfaces use 50-row metadata pages independently of historical import pages. Large-mailbox service benchmarks and remaining whole-UI acceptance limits are recorded in [verification](../VERIFICATION.md).

Recommended starting point: daily **09:00**, Inbox only, preferred language **繁體中文**; leave the translation target blank or set **English** independently. Enable new-mail summaries and one-minute sync only if the volume/cost suits you; starred-only further narrows eligibility. Email Brain supports explicitly reviewed, source-linked memory suggestions alongside manual notes in current source. Separate, opt-in writing-style analysis is available in Settings → Advanced setup → Writing style and always requires review before applying a style. Genspark's [official GenMail introduction](https://www.youtube.com/watch?v=i9I4frhlD80) confirms morning briefings and learning voice/contacts, but does not document its precise memory-refresh cadence, per-message triggers, or P0–P4 rules. Morrow's rules above are its own implementation.

In **Settings → General → Email footer**, choose Plain text or HTML, enter the signature, preview it, then save. One workspace signature applies to new messages, replies and AI-created drafts across your accounts. HTML allows bold/italic/underlined text, limited inline colors and font sizes, lists, tables, and HTTPS/mailto/tel links. Images, scripts, active content, remote resources and unsupported styling are removed. Each draft keeps its own footer snapshot, visible in the composer and removable before sending. Editing settings or replacing the body with an AI suggestion does not change that snapshot. Gmail, Outlook and SMTP send HTML footers as multipart mail with a generated plain-text alternative. Legacy saved drafts keep their original text without an extra footer.

Replies, including AI replies and the native Reply shortcut, keep the account that owns the original message even in combined views or when the To address is an alias. Their From identity is locked; replying to a sent message uses its original recipients.

## Reviewed attention workflows

Today links P0–P4 summaries to their source mail and shows up to five current reply suggestions per mailbox. Reply cards show a draft preview, reason and permitted correspondence; open the account’s queue to review, edit or ignore. Opening Today starts no AI job.

Ask defaults to keyword context and offers an explicit **Use my approved Smart Search index** checkbox. It retrieves only permitted mail from that account; query embedding may incur charges and never starts indexing. Answers use numbered, server-derived source links; unavailable reference numbers are rejected. Sources identify supplied context, not a guarantee that a model’s interpretation is correct. Writing Style & Notes separates business facts, writing voice and reviewed writing guardrails.

AI Studio → More → **Local Inbox Rules** previews exact sender/domain or subject-text matches among the newest 500 downloaded Inbox messages. Apply saves the rule and sets a local Star, Pending or Read later marker. Saved rules run only after another preview/apply; each account keeps up to 30. Reviews expire after ten minutes and reject changed source mail or connections. **Later** shows locally marked Inbox/Archive mail; return from Later manually to correct it. These markers survive imports/restarts, keep provider folders and never delete mail or report spam. See the [AI Emaily UI review](AI_EMAILY_REVIEW-2026-10-03.md) for the six recommendations and their implementation limits.

## AI Studio simulations

Priority previews, smart labels, legacy Brain simulations, person/company research, meeting preparation, follow-ups, meeting scheduling, cleanup, unsubscribe, attachment comparisons, and the legacy Batch Replies tool are **local simulations**, even with a model configured. Preview a plan, then apply it to create local changes or records. Custom skills save editable instructions and run through the configured model or labeled demo mode.

Simulations do not browse the web, contact a calendar, send invitations or messages, unsubscribe with a provider, or fetch attachments. Attachment examples are fixtures behind an opt-in permission. Calendar and contact permissions here control local simulated context; they do not authorize access to connected calendars or external address books. Studio reminders and events are local records, not scheduled notifications or background jobs.

## Data and configuration

Messages and drafts are stored in SQLite under `~/Library/Application Support/Morrow Mail` on macOS and `%APPDATA%\Morrow Mail` on Windows. Mail/calendar credentials and tokens are encrypted with AES-GCM using a key in the same directory. Protect and back up **both the database and key**. This is not OS-keychain storage, and someone with access to both can decrypt the secrets. Message contents are stored locally in plaintext.

If delivery becomes uncertain, Morrow retains the draft and its request ID. Check your provider’s Sent folder before explicitly retrying; a retry can send a duplicate. Morrow does not automatically retry sending.

Sync communicates with the configured mail provider. Sending transmits your draft through that provider; AI requests transmit relevant emails to your chosen model endpoint. Calendar actions communicate with the selected calendar provider. Credentials are used for their configured provider. Use a local model to keep AI processing on your computer.

`MORROW_DATA_DIR` may select a separate **absolute** workspace for native development or isolated acceptance. The host supplies the Rust service's authenticated loopback configuration over a private pipe; it does not read the retired Node `.env` file. Keep runtime data and credentials out of version control. This app is intended for local single-user use; do not expose it as a shared internet service.

## Backup and recovery

Use macOS **Settings → About → Back Up Workspace** for a consistent snapshot while the app runs. For the command line, quit Morrow and run the bundled service with absolute paths:

```sh
'/path/to/Morrow Mail.app/Contents/Resources/morrow-service' --backup '/absolute/workspace' '/absolute/new-backup-directory'
```

On Windows use `resources/app/runtime/morrow-service.exe` with the same arguments. The destination must not exist. The service snapshots SQLite, copies the matching encryption key and recovery files, and verifies the result. Backup directories/files use owner-only modes on macOS/Linux; on Windows choose a destination protected by your user ACLs. Copy the resulting directory to your protected backup storage.

To restore, quit Morrow and wait for shutdown. Preserve the current workspace, then copy **both** `genmail.sqlite` and `encryption.key` from the same backup into a new private directory. Also restore `pending-calendar.json` and `client-state.json` if present. Point `MORROW_DATA_DIR` at it and restart. Verify saved mail/settings. Never replace a key by itself. Stop the app before taking a manual filesystem copy.

Normal startup, health, and backup diagnostics do not include credentials. Keep API keys, tokens, and OAuth callback URLs out of shared issue reports.

## Native macOS app

The primary interface is **fully native SwiftUI**, including the mail reader, composer, all 19 AI Studio tools, skills, Email Brain, settings, permissions, and Google/Outlook calendars. The application interface remains native; formatted message bodies alone use an isolated, script-disabled WebKit reader. The app bundles the Rust mail service and needs no terminal, Node or Rust installation to run. Current source uses a 480-point HTML viewport with native scrolling, matching Windows; it executes no height/scroll measurement scripts. Long HTML scrolls within that viewport instead of expanding the entire macOS message pane.

Build on a Mac with Apple's Swift command-line tools and Rust 1.98+ with rustfmt/clippy:

```sh
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --locked
/bin/sh scripts/build-macos-native.sh
cargo run --manifest-path rust/Cargo.toml --locked --bin morrow-native-check -- --service "$PWD/build/macos-native/Morrow Mail.app/Contents/Resources/morrow-service"
open 'build/macos-native/Morrow Mail.app'
```

The result is `build/macos-native/Morrow Mail.app`. You can move it to Applications. Rust desktop builds target Apple silicon and **macOS 13.5+**; packaging rejects non-system dynamic-library dependencies. The native host starts only the Rust service.

Native data lives in `~/Library/Application Support/Morrow Mail`, separate from the retired web app's `./data`. Existing legacy web data is not automatically moved. To reuse it, stop both apps, make a verified backup, and restore that backup's database and encryption key into the native data directory before opening the native app. `MORROW_DATA_DIR` can select a separate absolute data directory for development or acceptance testing. Do not run two apps against the same data directory.

The app starts its own loopback service on a random free port and authenticates native API requests with a per-launch secret sent over a private pipe. OAuth browser handoffs retain PKCE/state/browser-cookie checks. When the build includes Morrow’s Google registration, click **Sign in with Google in browser** without entering a client ID or secret. **Use my own Google OAuth client** is available under advanced settings. Microsoft sign-in uses Morrow’s built-in public desktop client ID; an advanced custom-client option remains available. Keep Morrow open until sign-in finishes; returning to the app refreshes connections and selects the newly connected mailbox. **Do not open the callback URL manually**: it is only the return address after provider authorization. It is available under **Advanced: callback URL for app registration** in native Settings, with a copy button. The fixed `:3001` examples below illustrate registration; native callback ports are assigned at launch. Google desktop clients accept loopback ports. Microsoft [ignores the port when matching localhost redirect URIs](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url#localhost-exceptions); register each mail/calendar callback path separately.

Keyboard shortcuts: **⌘N** compose, **⌘,** Settings, **⌘F** search, **⌘R** sync, **⌘⇧R** reply, **⌘⇧M** provider Move / Labels, **⌘⇧A** local archive, **⌘⇧U** read/unread, and **⌘1/2/3** Inbox / AI Studio / Calendar. In the composer, **⌘S** saves a draft and **⌘⇧D** opens send review. **Esc** cancels. Standard macOS **⌘M**, **⌘W**, **⌃⌘F**, and the red/yellow/green title-bar controls minimize, close, resize, and enter full screen. **Window → Window Size** offers compact, standard, wide and Fill Available Screen sizes; the window also resizes by dragging its edges and restores its saved size.

The inbox's **View** menu selects Compact, Comfortable, or Spacious rows. **Sort** offers newest, oldest, sender, subject, unread-first, and starred-first; both choices persist across launches and apply to individual and combined views. The red close button and ⌘W hide the main window while the app remains in the Dock, retaining drafts and in-flight work. Click the Dock icon to reopen it; ⌘Q quits with the existing unsaved-edit and active-write guards. **Layout** selects a right, bottom or focused reader, and **Expand Reader** gives the message the full content width. Preferences include native light/dark/system appearance and mail density.

Native **Settings → About → Back Up Workspace** creates a verified backup including any pending calendar request. Calendar creation persists its original request ID and details before writing to the provider, so a restart can recover an uncertain attempt. Review the provider's calendar before resolving a pending request.

The distributed macOS build is ad-hoc signed and not notarized. Apple Developer ID signing, hardened runtime and **Apple notarization** remain outstanding distribution work; the numbered release does not claim them. Set `MORROW_SIGNING_IDENTITY` to your Developer ID identity for signing; the script does not submit anything to Apple. The app is not App Store sandboxed. Live provider acceptance testing and signing/notarization remain documented limitations.

## Windows desktop app

The Windows package uses native WinUI 3/C++/WinRT controls over the same Rust provider, account-routing, AI-permission and calendar service as macOS. The host starts a private authenticated loopback service; the isolated HTML reader receives no service token or script bridge. The Electron implementation is retained only in Git history.

Data lives in `%APPDATA%\Morrow Mail`. Sidebar disclosure and pending calendar requests persist across app restarts. Windows uses the current user's profile permissions; Unix file-mode checks do not represent Windows ACLs. Account data is local to each installation; paired releases do **not** synchronize mail caches, credentials or preferences between computers.

The **Sign in … in browser** button opens the system browser. Keep Morrow open, finish authorization, then return to Mail or Calendar Settings. Connections refresh on return when there are no unsaved edits or in-flight operations; **Refresh connections** remains available. The callback in Advanced settings is for provider registration, not a link to start login. Keyboard shortcuts include **Ctrl+N** compose, **Ctrl+F** search, **Ctrl+,** settings, **Ctrl+R** sync, **Ctrl+Shift+R** reply, **Ctrl+1/2/3** Inbox / AI Studio / Calendar, **Ctrl+S** save draft, and **Ctrl+Shift+D** send review.

Build on Windows x64 with PowerShell 7, Rust 1.98+ and the pinned VS 2022/Windows SDK prerequisites in [windows/README.md](../windows/README.md):

```powershell
./scripts/build-windows-native.ps1 -Zip
# Optional fixture acceptance; never uses your real workspace.
./scripts/test-windows-native.ps1 -UiSmoke
```

The runnable folder is `build/windows-native/Morrow Mail-win32-x64`; its versioned ZIP and checksum are in `build/windows-native/artifacts`.

For a Windows backup, quit Morrow Mail, open PowerShell inside the extracted app folder, and run:

```powershell
$workspace = Join-Path $env:APPDATA 'Morrow Mail'
& '.\resources\app\runtime\morrow-service.exe' --backup $workspace 'C:\path\to\new-backup-folder'
```

## Historical screenshots

Captured from the 0.4 development build using fictional messages and isolated provider fixtures. No private mail is shown. These macOS screens show the interface included in the 0.4 alpha line. These historical screenshots do not depict the new WinUI Windows interface.

**Combined inbox with collapsible account groups and per-message mailbox labels**

![Morrow Mail native macOS combined inbox, with separate collapsible personal and work accounts, inbox sorting, and a mail reader](screenshots/macos-inbox.jpg)

**Reply from the receiving account, with Cc / Bcc and an HTML footer**

<img src="screenshots/macos-reply.jpg" alt="Morrow Mail native reply composer with the work account locked as sender, To, Cc and Bcc fields, and a formatted HTML email footer" width="690">
