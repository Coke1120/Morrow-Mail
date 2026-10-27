# Bring-your-own Google Desktop OAuth

The shared Google Cloud project for Morrow Mail stays in **Testing**. Publishing that app to Production, and the restricted-scope assessment that would go with it, is out of scope.

While a consent screen is in Testing, only listed test users can consent, and refresh tokens expire after about seven days. A Desktop client baked into a Release from `GOOGLE_DESKTOP_OAUTH_JSON` therefore cannot serve arbitrary open-source users. Maintainers may still bake that shared client for themselves and for people they add as test users.

Everyone else imports their own Desktop client JSON in Settings → Accounts. The file is `google-oauth.json` in the Electron userData directory, outside the asar and outside git. Load order is:

1. `MORROW_GOOGLE_OAUTH_FILE`
2. `MORROW_GOOGLE_OAUTH_JSON` or `GOOGLE_DESKTOP_OAUTH_JSON`
3. The imported userData file
4. `resources/google-oauth.json`
5. `process.resourcesPath/google-oauth.json`

The client secret is not shown in the UI and is not returned over IPC. A mailbox connected with a different client must be connected again; import does not move that refresh token. Web client JSON is rejected. Clear deletes only the imported file. `oauthReady().google` follows the file on the next read, so a restart is unnecessary.

This does not add an app-password path, drop the Gmail API, change requested Google scopes, or change the Microsoft public client id.

Grant binding and safe runtime switching are specified in [Bind Google grants to their Desktop client](2026-10-27-google-client-grant-binding.md). Different-client and older unknown-client grants require Gmail and separate Calendar reauthorization. Import/clear cannot overlap Google authorization, and invalid environment overrides are reported as environment errors. Credentials and cached work are retained.
