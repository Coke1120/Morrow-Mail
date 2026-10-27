# Optional personal Google Desktop client

Start with **Continue with Google** for the default browser sign-in. Morrow uses its bundled Desktop OAuth client when present unless you explicitly imported a personal client or set a developer override. A Google password belongs on Google's browser page; Morrow's Other email provider form is the separate manual IMAP path.

This guide is an **optional advanced** choice for using your own client. Google controls which users may approve a project. Local readiness does not establish its Console publication or verification status. If a consent screen is in **Testing**, only listed test users can consent.

If you choose a personal client, create a Desktop client in your own Google Cloud project and import the downloaded JSON in Morrow Mail. The file stays in this app's data on your computer. It is not shown in Settings, and it is not part of the app package.

For an existing legacy Gmail OAuth account, use **Settings → Accounts → Permissions & calendar access → Migrate Gmail to Gmail API**, review the disclosure and choose **Continue with Google**. The sign-in error's **Review Gmail API migration** action opens this section without starting migration. Reconnecting and migration keep local work; removing an account is not a sign-in repair.

## Create the optional client

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project, or use one you already own.
2. Enable the **Gmail API**. Enable the **Google Calendar API** as well if you want Calendar in Morrow Mail.
3. Open **APIs & Services → OAuth consent screen**. Choose **External**. Set **Publishing status** to **Testing**. Leave it there.
4. Under **Test users**, add the Google account you will use in Morrow Mail.
5. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**. Application type: **Desktop**. Download the JSON.
6. In Morrow Mail, open **Settings → Accounts → Advanced: personal Google OAuth client (optional) → Import Desktop JSON…** and choose that file.
7. Choose **Connect account → Continue with Google** and sign in as the test user you added.

You do not register a fixed port. A Desktop client uses a loopback address. Morrow Mail opens `http://localhost:<port>/api/oauth/google/callback` for mail and `http://localhost:<port>/api/calendar-oauth/google/callback` for Calendar.

## What Morrow Mail does with the file

- Import accepts only a Desktop client (`installed`). A Web client JSON is rejected.
- The imported file is stored as `google-oauth.json` in the app data folder. On macOS that is `~/Library/Application Support/Morrow Mail/`. On Windows it is `%APPDATA%\Morrow Mail\`. On Linux it is `~/.config/Morrow Mail/`.
- That file is used instead of a client bundled with the installer or left in a development checkout. Updating the app does not remove it.
- A developer environment variable (`MORROW_GOOGLE_OAUTH_FILE`, `MORROW_GOOGLE_OAUTH_JSON`, or `GOOGLE_DESKTOP_OAUTH_JSON`) still wins over the imported file.
- **Clear imported client** deletes only the imported file. Your mailbox, the bundled client, and any environment variable stay.
- After changing clients, reauthorize Gmail and Google Calendar separately. Settings reports reconnect needed, and Enable Google Calendar requests a new Calendar grant instead of reusing one from another client. Import does not move refresh tokens between clients.
- Older saved Google grants without a recorded client identity need one-time reauthorization, even if you have kept the same client. This preserves your saved credentials, account id, cached mail and local drafts until successful consent replaces the relevant grant. Declined or incomplete Calendar consent leaves the old credential saved, without presenting it as connected to the new client.
- Finish or cancel Google sign-in before importing or clearing a client. Finish or cancel the file picker before starting another Google sign-in. Cancellation may take time while an in-flight exchange settles; retry after it finishes.
- Google OAuth becomes ready or not ready as soon as you import or clear. You do not need to restart Morrow Mail.
- Settings says whether the client in use came from an environment variable, your import, or a bundled file. If an environment override is invalid, fix or remove it; importing or clearing a client cannot override it. Settings does not show the client secret.

## Testing mode

While the consent screen stays in **Testing**, Google refresh tokens expire after about seven days, and only the test users you listed can connect. When Gmail asks you to sign in again, consent again. That is expected. Leave Publishing status on Testing.

## Keep the secret private

Do not paste the JSON, the client secret, or a refresh token into git, a GitHub issue, chat, or a screenshot. Do not commit `resources/google-oauth.json`. If a secret is exposed, delete that OAuth client in Google Cloud Console and create a new Desktop client.
