# Bring your own Google Desktop client

Morrow Mail connects to Gmail with a Google Desktop OAuth client. The shared client shipped in some releases stays in **Testing**. Google only lets listed test users consent to a Testing app, so a Release build cannot sign in arbitrary Google accounts with that shared client.

Create a Desktop client in your own Google Cloud project and import the downloaded JSON in Morrow Mail. The file stays in this app's data on your computer. It is not shown in Settings, and it is not part of the app package.

## Create the client

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project, or use one you already own.
2. Enable the **Gmail API**. Enable the **Google Calendar API** as well if you want Calendar in Morrow Mail.
3. Open **APIs & Services → OAuth consent screen**. Choose **External**. Set **Publishing status** to **Testing**. Leave it there.
4. Under **Test users**, add the Google account you will use in Morrow Mail.
5. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**. Application type: **Desktop**. Download the JSON.
6. In Morrow Mail, open **Settings → Accounts → Google OAuth client → Import Desktop JSON…** and choose that file.
7. Choose **Connect account → Continue with Google** and sign in as the test user you added.

You do not register a fixed port. A Desktop client uses a loopback address. Morrow Mail opens `http://localhost:<port>/api/oauth/google/callback` for mail and `http://localhost:<port>/api/calendar-oauth/google/callback` for Calendar.

## What Morrow Mail does with the file

- Import accepts only a Desktop client (`installed`). A Web client JSON is rejected.
- The imported file is stored as `google-oauth.json` in the app data folder. On macOS that is `~/Library/Application Support/Morrow Mail/`. On Windows it is `%APPDATA%\Morrow Mail\`. On Linux it is `~/.config/Morrow Mail/`.
- That file is used instead of a client bundled with the installer or left in a development checkout. Updating the app does not remove it.
- A developer environment variable (`MORROW_GOOGLE_OAUTH_FILE`, `MORROW_GOOGLE_OAUTH_JSON`, or `GOOGLE_DESKTOP_OAUTH_JSON`) still wins over the imported file.
- **Clear imported client** deletes only the imported file. Your mailbox, the bundled client, and any environment variable stay.
- A mailbox already connected with a different client must be connected again. Its saved refresh token belongs to the client that issued it. Import does not move that token.
- Google OAuth becomes ready or not ready as soon as you import or clear. You do not need to restart Morrow Mail.
- Settings says whether the client in use came from an environment variable, your import, or a bundled file. It does not show the client secret.

## Testing mode

While the consent screen stays in **Testing**, Google refresh tokens expire after about seven days, and only the test users you listed can connect. When Gmail asks you to sign in again, consent again. That is expected. Leave Publishing status on Testing.

## Keep the secret private

Do not paste the JSON, the client secret, or a refresh token into git, a GitHub issue, chat, or a screenshot. Do not commit `resources/google-oauth.json`. If a secret is exposed, delete that OAuth client in Google Cloud Console and create a new Desktop client.
