# Recover feature reads before requesting OAuth consent

Date: 2026-11-05. Base: dev `4b4598b` (v0.4.1).

Calendar and Graph feature HTTP 401s previously became `scope_missing` without
trying the valid saved refresh token. Calendar quota 403s also requested consent.
An unavailable Google client configuration could become `google_client_changed`
in the rejected-refresh guard and latch a mailbox auth error even after the same
configuration returned. These were reproduced with synthetic provider responses.
They do not establish the cause of a particular user's repeated disconnects.

Keep string-token API compatibility and add an optional guarded supplier to the
shared provider HTTP client. Feature handlers supply that capability. It is held
only for the current operation, owns its existing grant snapshot, and serializes
its own token reads/renewals. Each HTTP call checks ownership and expiry. Only the
rejected GET is repeated once, after a successful durable save. A late 401 uses
the credential already renewed by that operation. Real grant failures, rejected
second reads, client changes and storage errors keep their distinct outcomes.

No POST/PUT/PATCH/DELETE or whole caller is replayed. Reads inside a compound write
can recover independently; subsequent writes use the current saved token. Checks
after HTTP and error parsing retain known rejection/unknown submission evidence
when a reconnect arrives. Vacation's identity check follows only its operation's
own durable rotation. Existing scopes, separate Google Calendar and Microsoft
Outlook/Graph resources, credential storage and consent gates remain unchanged.
Read conflicts do not borrow the retired response's HTTP status: optional-folder
404 handling must not swallow a connection change during parallel discovery.

Separate operations still use the existing revision conflicts; they do not adopt
arbitrary changed credentials or share a global token cache. Two concurrent
renewals can make redundant requests but the loser cannot overwrite the winner
or attach an old invalid_grant to a newer login. Broader coalescing remains a
separate mutation-design task. API requests have a 30-second fetch signal; error
bodies have a 16 KiB/1.5-second parsing bound with fixed diagnostics.

Allowlisted Calendar quota 403 reasons and HTTP 429 produce retryable rate-limit
results. The supplier records only a grant-key/revision/account/deadline pause,
not credential values. Later feature GETs using that saved grant honor bounded
Retry-After (default 30 seconds) without another HTTP call. Expired/removed-account
pauses are discarded; a new credential revision retires a pause. Unknown or
conflicting 403 evidence does not imply missing scope. Actual missing Calendar
permission still offers consent. No provider setting or quota is changed.

Client-read failure is distinct from a proved different Google client ID.
`oauth_not_ready` stays a configuration error and cannot become sticky mail auth.
The normal retry/poll can recover once the original configuration returns.
Different or unknown issuers remain blocked. Historical generic auth errors are
not automatically cleared because their cause cannot be recovered safely.

`scripts/check-feature-oauth-recovery.js` exercises actual engine, sidecar, HTTP,
Calendar and renderer functions with temporary SQLite, memory secrets and fake
HTTP. It covers both providers, rotation/omitted refresh tokens, durable writes,
parallel/late rejections, expiry between pages, bounded retries, quota backoff,
malformed/oversized error bodies, configuration restoration, genuine client
changes, rejected writes and prerequisite GETs, reconnect/removal/client races
and a losing concurrent refresh. Existing mail renewal, Gmail/Outlook recovery,
Keychain, consent and UI/help checks remain enabled in the full check.

All credentials, child processes and providers in these tests are synthetic.
Native Keychain/DPAPI prompts, provider project/tenant policy, real mail/calendar
and installed desktop recovery remain unverified. Google Testing's seven-day
grant limit and Microsoft Conditional Access remain provider constraints.
