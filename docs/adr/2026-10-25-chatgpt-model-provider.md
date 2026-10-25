# Add ChatGPT plan usage as an AI provider

Status: implemented for a draft feature PR to `dev`; native/live validation pending. This change does not modify version/release configuration or the v0.2.37 release work.

## Decision

Keep the existing OpenAI-compatible Chat Completions adapter, API key, custom endpoint and model unchanged. Add an explicit `authMode` (`api_key`, the migration default, or `chatgpt`) and a separate `chatgptModel` in `ai.json`. A saved mode chooses one adapter. Errors never trigger a change of mode, account or billing path. Environment API overrides remain confined to API mode. The native AI Setup window and first-party AI settings share the same account controls.

Use the official open-source Sign in with ChatGPT public-client flow directly from the Electron main process. No general proxy, cookie scraping, embedded login, borrowed first-party client, shared secret, partner key or copied CLIProxyAPI code is included. We reviewed CLIProxyAPI at `bc0643405a1d0adf77dd0f109972ac3313d66397` (`sdk/auth/codex.go`, `internal/auth/codex/siwc_auth.go`) as background for loopback/paste-back and dynamic registration; this implementation is independent JavaScript.

## OAuth boundary and state

First registration sends `dynamic_agent_client`, `agent_name_hint=Morrow Mail`, a persisted per-host UUID URN, the official resource and requested identity/direct/offline scopes. Each attempt binds fresh random state, nonce and S256 PKCE to an exact ephemeral `http://127.0.0.1:<port>/auth/callback`. The listener starts before the system browser. The optional app paste-back uses the same parser and pending attempt; it never extracts cookies. Callback secrets stay in memory and are cleared from the field before IPC. Only status and opaque local registration IDs leave the main process.

Callbacks require the exact origin/path, single state/code/error/client/issuer parameters, matching state, and an unexpired unconsumed attempt. New callbacks must supply an issued `oaiapp_` client ID; returning callbacks cannot change the saved ID. Provider errors are handled before code exchange. Cancel, replacement, mode change, timeout and shutdown invalidate pending work. A late token exchange cannot activate an account. An initial `invalid_grant` retains the issued client only in memory for a fresh retry; it never creates a verified account mapping.

Discovery pins the production issuer, authorize and token endpoints; JWKS/revocation URLs must use the issuer origin. `jose` verifies signatures with an algorithm allowlist, required claims, a five-second clock tolerance and refreshed JWKS for unfamiliar key IDs. Identity validation checks issuer, issued-client audience, nonce and expiry; returning subjects must match. The signed access token must match resource audience, subject, client and returned scopes. Identity without direct plan permission is retained with inference disabled. Explicit Enable plan usage requests consent again; ordinary reauthorization does not force consent.

Each registration stores its own issued-client/verified-subject mapping, stable label, token set, expiry and grant. Email is display metadata and never merges registrations/workspaces. Add or select accounts explicitly; no rotation. Logout retains the mapping and host ID, clears login hints and tokens, resets background permission, and attempts discovery-directed refresh-session revocation. Unconfirmed revocation is disclosed with instructions to disconnect in ChatGPT settings.

## Local persistence and concurrency

`chatgpt-credentials.enc` is separate from `ai.json`, `settings.json`, mailbox tokens, and bot grants. The entire record is encrypted through Electron safeStorage; unavailable or Linux `basic_text` storage fails closed. Files use random exclusive temporary names, owner-only permissions and atomic rename. A locked/damaged file is preserved and reported. There is no plaintext or environment-token fallback. No auth URL, callback, tokens or arbitrary provider error text is logged or returned to general renderer storage.

Electron's existing single-instance lock is the process ownership boundary. Refresh is single-flight per registration, respects expiry/earliest refresh time, omits `scope`, and replaces rotating credentials together. Identity and granted permissions are rechecked. Temporary network errors preserve credentials; terminal refresh failures clear unusable tokens but retain the mapping. Credential generations prevent older refresh/login results overwriting a newer session. Logout stops requests immediately, waits for an in-flight refresh, then revokes the latest rotating token. Mode/account/model changes and background-consent withdrawal abort admitted ChatGPT requests, whose leases are also checked before delivering output. Background consent is read per registration for every new lease.

## Inference and user control

The dedicated adapter accepts text messages, maps system prompts to developer messages, sends full context in the `input` array, and fixes the only inference endpoint to `POST https://api.openai.com/v1/responses`. It always sends `store:false` and `stream:true`. No temperature, token cap, previous response ID, server background field, hosted tools or other unsupported preview fields are forwarded. Completion wrappers consume streaming internally; partial output does not mean success. Malformed/truncated streams, `response.failed`, `response.incomplete`, refusal, cancellation and transport failure surface errors without an API retry.

Models come from the account's `/v1/models` response (`models`, `visibility:list`, `slug`, `display_name`) and are revalidated before inference using a short per-registration cache. No model availability or unlimited plan usage is promised. Usage-limit events pause requests for that registration until an explicit retry; eligibility and capability errors are actionable. Error status, safe machine code/param, request ID and body shape survive without arbitrary body text that could echo mail or credentials.

The UI discloses required mail/prompt processing before sign-in and links privacy/terms and ChatGPT usage. First plan connection shows a dismissible welcome. Connection/model changes require Save AI; account actions and the clearly labeled background opt-in apply immediately. Background profile refresh, automatic profile/Agent refresh and scheduled skills are classified by the host and require express opt-in. Manually requested Brain, draft, translation and agent work continue through the selected provider. No mail is sent by this provider integration.

## Evidence and remaining validation

`scripts/check-chatgpt.js` uses a synthetic signed issuer, mocked token/Responses transports, a temporary encrypted store and synthetic DOM/VM interactions. It performs no real login, dynamic registration, service-agreement acceptance, model request, mail transmission or live account change. It is included in `npm run check` and PR CI.

Rendered/native browser QA and real provider eligibility/consent/secure-storage/redirect behavior need separate action-time authorization. The earlier `ERR_BLOCKED_BY_ADMINISTRATOR` file-navigation restriction is respected: no alternate browser route/environment is used. Unit/VM/CI evidence does not verify the operating system browser or keychain. Before enabling this in a release, maintainers must review current official terms/docs and explicitly authorize live testing; this draft does not accept terms on their behalf.

## Official references (reviewed 2026-10-25)

- [Quickstart](https://developers.openai.com/siwc/quickstart)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)
- [Identity validation](https://developers.openai.com/siwc/website)
- [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/)
