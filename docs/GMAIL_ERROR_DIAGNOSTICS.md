# Gmail API error diagnostics

Gmail API mail requests and the delegated label hierarchy requests parse error
responses before reporting rejection. Sync activity, its tooltip/accessibility
text, and Debug log retain only a numeric HTTP status, a fixed operation and
allowlisted Google reason/status codes. Existing IPC envelopes carry the fixed
message; no provider text or new diagnostic payload crosses IPC.

The parser reads at most 16 KiB and waits at most 1.5 seconds after headers,
also respecting the request abort signal. It cancels the stream on completion
or early exit. It never falls back to unbounded `text()`/`json()`. Malformed,
oversized, unreadable, timed out and unsupported bodies yield unknown evidence;
the known HTTP result and write-issued uncertainty are retained.

| Evidence | Meaning / next step |
| --- | --- |
| `rateLimitExceeded`, `userRateLimitExceeded`, `dailyLimitExceeded`, `quotaExceeded`, `RATE_LIMIT_EXCEEDED`, `RESOURCE_QUOTA_EXCEEDED`, `RESOURCE_EXHAUSTED`, or HTTP 429 | Quota/rate pressure; sync uses its existing pause and Retry-After limit. A daily limit may persist longer. |
| `insufficientPermissions`, `ACCESS_TOKEN_SCOPE_INSUFFICIENT` | Missing mail permission; review Gmail API access. |
| `accessNotConfigured`, `SERVICE_DISABLED` | API disabled; the app owner must review the Google project. |
| `domainPolicy` | Domain policy; contact the domain administrator. |
| HTTP 401 | Sign-in rejected; review the account connection. |
| Bare 403, `forbidden`, `PERMISSION_DENIED`, unfamiliar or conflicting reasons | Cause unknown; no missing-scope claim. |

Reason classification applies to HTTP 403; other HTTP errors retain their status
and safe codes without guessing a cause, except 401/429. ErrorInfo requires its
exact Google RPC type and `googleapis.com` domain. Unknown reason/status values
are replaced with `unknown`; no free-text matching is used. Raw bodies, provider
messages, metadata, links, request values, IDs, mail content, addresses and tokens
are never added to errors/logs/UI. Existing mailbox/folder context in other log
fields remains and needs review before sharing.

No OAuth scopes, grants, credential storage, automatic reauthentication or write
retry loops change. HTTP write-issued uncertainty, explicit-send requirements,
hierarchy partial-result receipts and the existing Retry-After cap are retained.
Rate evidence reaches the existing account pause; non-credential Gmail 403s can
use the existing transient **read** retries instead of the sticky sign-in gate.
The Features catalog and Accounts/Debug help describe these limits. No CLI or
bot command is added.

`scripts/check-gmail-error-diagnostics.js` covers synthetic legacy/RPC errors,
unknown/conflicting evidence, privacy, byte/time/abort bounds, static operations,
write counts, and engine-to-activity/DOM propagation. Existing Gmail transport,
engine, sync-retry, migration/UI and the full `npm run check` remain applicable.
Synthetic results do not establish the user's actual 403 cause, Gmail API
enablement, Console verification, domain policy or native Mac behavior.

Provider schema references: [Gmail errors](https://developers.google.com/workspace/gmail/api/guides/handle-errors),
[Google API JSON error schema](https://google.aip.dev/193), and
[Google infrastructure reasons](https://github.com/googleapis/googleapis/blob/master/google/api/error_reason.proto).
