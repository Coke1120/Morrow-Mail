# Distinguish renewal failures from a grant that needs sign-in

Date: 2026-11-02. Scope: OAuth connection reliability, based on dev `80350e9`.

Refresh previously mapped every unsuccessful token response to “Sign in again”.
The sync classifier latched that as `accounts.auth_error`, suppressing further
background attempts, including when the provider had returned 503. Secure-store
renewal writes were best effort: both mail and feature calls could report success
without saving Microsoft's replacement refresh token. Nonzero Keychain/DPAPI
read exits were treated as missing credentials, so access failures could also
become a persistent sign-in requirement at startup.

Use typed, fixed-message refresh errors. Only failed-refresh grant/interaction
errors require reconnect; network/service failures and unexpected responses
remain retriable. Client/scope configuration errors direct the owner to app
configuration. A 30-second HTTP signal bounds token requests, including response
body reads. Keep existing mail backoff and bounded rate-limit handling. Do not
propagate raw descriptions, fetch errors, credentials or claims to the UI.

Require the existing synchronous credential write to succeed before using a
renewed token. Surface `secure_storage_write` with a retry instruction. Preserve
all scope/resource/client checks and synchronous reconnect compensation. Do not
add an await to a credential/SQLite commit, broaden grants, or move tokens into
settings. Separate requests can still renew concurrently; current guards reject
obsolete writes. Coordinating those requests is a separate mutation-design task.

Only an explicit missing-item process exit returns null: macOS security status
44 (`errSecItemNotFound`, -25300 modulo 256); Windows read-script status 2. Other
exits and decode failures become fixed secure-storage errors. This supersedes
the nonzero-exit compatibility choice in
[the read-deadline decision](2026-10-27-keychain-read-deadlines.md). Native security
can itself collapse some search errors to not-found, which remains a limit.
OS encryption, service/account names and write mechanisms are unchanged.

The app cannot prevent provider revocation or policy expiry. Google External +
Testing grants expire after seven days unless they request only basic identity;
mail/calendar do not qualify. Microsoft native/public refresh lifetime differs
from SPA and remains subject to Conditional Access. Actual project publication
and tenant policy were not inspected. Do not clear historical generic auth errors
automatically because their original cause cannot be recovered.

`scripts/check-oauth-reliability.js` reproduces the three original failures on the
base, exercises both providers' error classes and malformed/unknown responses,
durable rotation across a fresh Node process, omitted refresh-token preservation,
concurrent renewal versus reconnect, and fake child/backend read statuses.
`check-keychain-reads.js` retains removal/recreation, rollback and client-change
coverage. The actual renderer/DOM fixture verifies Accounts help and Features.
All credentials/providers are synthetic; native unlock/ACL/DPAPI, real accounts,
provider Console/tenant policy and actual device upgrade remain unverified.

References:

- [Google token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Google restricted-scope verification and exceptions](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Microsoft refresh lifetimes and rotation](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)
- [Conditional Access sign-in frequency](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-session-lifetime)
- [Apple security tool source](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.c)
- [Apple Keychain find source](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/keychain_find.c)
