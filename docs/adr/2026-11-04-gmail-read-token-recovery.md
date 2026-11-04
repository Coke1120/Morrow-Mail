# Recover rejected Gmail reads within a durable connection

Gmail sessions previously captured one access token. A 401 during a folder walk
became a persistent authentication error even when the refresh grant was usable.
The Outlook login retry in #484 does not apply to Gmail HTTP requests.

Existing-account mail sessions now obtain a token for every HTTP request through
the engine's guarded secret reader. A snapshot returns the token and its durable
secret revision together. The session accepts only its own renewed revisions;
account incarnation/epoch, transport, Gmail generation, secret revision and Google
Desktop client checks retire obsolete sessions before credential use. Token
acquisition is serialized within each session, without retaining completed
credentials. Concurrent sessions keep the existing conservative conflict behavior.
No synchronous secure-store commit/compensation becomes asynchronous.

On HTTP 401, a GET can force renewal and repeat that exact HTTP read once. A late
401 for an older token reuses the already renewed saved connection. Failed renewal
must preserve its typed error; no retry uses an unsaved token. API label workflows
share this behavior per HTTP request, without restarting a workflow that may have
already written. POST, PUT, PATCH and DELETE are never replayed. New-account
verification still uses its provisional token before credentials are committed.
Send's separate transport path remains one submission with no automatic replay.
If a connection changes while an error response body is being read, preserve
that HTTP result's write-submission evidence: 408/5xx writes remain unknown,
while known rejections remain unissued. Retiring a stale session must not turn
an uncertain provider write into a local rollback.
Failed renewal of a rejected GET is explicitly unissued, preserving its typed
error so a failed pre-write metadata read rolls back the optimistic move. A
cache-read failure after an acknowledged move retains completion without replay.

The existing-account wrapper covers sync, body/attachment reads, search, actions
and draft/label sessions. The post-sign-in profile check uses the same supplier so
it cannot reintroduce a stale-token sign-in failure. Separate feature/calendar
provider APIs retain their own grant handling and are outside this mail fix.

`scripts/check-gmail-auth-retry.js` exercises the real engine, memory credentials,
session and HTTP API with synthetic provider responses, including durable refresh,
mid-session expiry, concurrent reads, bounded 401 handling, renewal/service/storage
failures, reconnect/removal/replacement/transport/client races, abort and no write
replay. It checks the rendered Features catalog and Accounts help. The aggregate
boot check runs this fixture. No real Google account, native secure store or
provider policy is verified by these fixtures.
