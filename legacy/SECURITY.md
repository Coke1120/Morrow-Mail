# Security

This alpha runs locally for a single user. Never expose its service to the internet.
Report vulnerabilities through GitHub private vulnerability reporting on the repository
Security page. Do not include mail, credentials, databases, encryption keys, or callback
URLs in public issues. The app does not upload diagnostics automatically.

See README.md for data storage, model disclosure, provider permissions and alpha limits.

The Windows renderer uses sandboxing and context isolation with Node integration
disabled. Its bridge accepts only validated sign-in URLs and bounded local UI/recovery
state. Private API authorization is attached in the main process for the app's own
loopback origin. External HTTPS links require confirmation; provider OAuth opens the
system browser. All renderer permissions and downloads are denied.
