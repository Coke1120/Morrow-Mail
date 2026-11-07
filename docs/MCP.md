# Agent access / MCP

Settings has one **Agent access / MCP** entry. Create an agent with an explicit
mailbox selection and permissions, keep its one-time secret in a private file,
turn local access on, then choose **Connect MCP**. Existing API/CLI credentials
and Grok/Hermes proactive webhooks remain supported. No existing grant acquires
permissions and no webhook is enabled by opening setup or copying configuration.

## What actually runs

This iteration provides **local stdio**, on the computer running Morrow. The MCP
client launches a separate **Node.js 20+** process. Morrow does not include or
install that Node runtime, verify the configured executable, automatically edit
an agent's configuration, or turn the Morrow executable into an MCP server.
Morrow must stay open with Agent access enabled. Another computer's localhost
does not reach Morrow, and there is no remote HTTP/SSE MCP endpoint.

Installed builds containing this change include a standalone, bundled adapter:

- macOS: `Morrow Mail.app/Contents/Resources/morrow-mcp.cjs`.
- Windows: the installation's `resources\morrow-mcp.cjs` (portable extraction
  paths can change; use a stable installed build for saved client configuration).

Settings supplies the actual full path. Older installations do not gain an
adapter just by copying a config. Use an absolute Node executable path if a GUI
agent does not inherit the terminal's PATH. The bundled adapter needs no source
checkout, npm install or external MCP SDK. It is generated during `npm ci` /
postinstall by `scripts/bundle-mcp.js` using the already locked esbuild/Ajv
dependencies, then included by the existing `resources/` packaging rule.

A **source checkout** instead needs `npm ci` and uses this command:

```sh
node scripts/morrow-mcp.js --token-file /absolute/path/to/morrow-agent-token --installation '<installation-id-from-settings>'
```

`npm run mcp -- ...` runs the same source adapter. MCP clients should invoke
`node` directly, because npm can add non-protocol output to stdout. Both the
source and standalone adapter use only newline-delimited MCP JSON on stdout.
Errors use fixed diagnostics; credentials and mail are never diagnostic logs.

## Client configuration and credentials

Settings copies a common `mcpServers` JSON entry with `command` and `args`.
Client formats vary: configure those values as a stdio server if your client
uses another format. Merge the entry with existing servers instead of replacing
the client's configuration. For example, replacing all paths/UUID locally:

```json
{
  "mcpServers": {
    "morrow-mail": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/resources/morrow-mcp.cjs",
        "--token-file", "/absolute/path/to/private-agent-token",
        "--installation", "11111111-1111-4111-8111-111111111111"
      ]
    }
  }
}
```

Put the one-time secret into that file yourself, outside chat and command
arguments. On macOS/Linux restrict it to your owner, mode `0600`; the adapter
rejects group/world permissions, another owner, symlinks and nonregular files.
On Windows restrict the file ACL to your user; Node's portable stat API does not
certify the ACL. An agent client or other process running as that same user can
read the file, so connect only trusted clients. A local client may itself forward
tool results to its model/provider according to its own policies.

The adapter reads a bounded token file on each data/discovery call. Settings
continues storing only the existing verifier and clearing the one-time dialog.
Its config form stores no token or new preference and never reads the file.
Rotation/revocation is checked by the original bridge on every request. After
rotation, replace the local file deliberately; a copied configuration alone
cannot restore access. Disable stops new calls but retains grants; revoke
invalidates that credential. Neither recalls delivered data or a submitted write.

Endpoint, token-file path and installation are trusted setup values, never
mail-derived tool arguments. The adapter accepts only `--token-file` and
`--installation`, always calling the existing `127.0.0.1:47831` bridge with its
Bearer credential and unchanged capability marker. There is no endpoint flag,
credential environment fallback, redirect following or automatic retry. Existing
API/Tailscale/CLI connection controls stay under **Compatibility**.

## Operations and results

Tools project the existing [bridge catalog](../host/bot/catalog.js), without
opening the database, provider credentials, Keychain or a parallel dispatcher.
`tools/list` authenticates a fresh `bridge.describe` call and lists only currently
granted operations. A cached tool list is never authority: all calls use the
original host authentication, mailbox/connection checks, expiry/revocation,
budgets, audit and durable write receipts. Discovery consumes the same budget.

Tool names use `morrow_` plus the API operation with dots replaced by underscores:
`mail.list_cached` becomes `morrow_mail_list_cached`. Inputs are the catalog's
existing params; write tools additionally require a UUID **`requestId`**. The
MCP JSON-RPC ID is a separate correlation value and never substitutes for a
durable write UUID. Draft proposals retain their explicit `idempotencyKey`.

Only separately granted sending or mail-change tools can contact providers.
There is no new bulk action, arbitrary move, permanent deletion, calendar,
timeline, folder administration or attachment-byte access. Draft proposals stay
inert and require desktop review; sending acts immediately only when separately
granted and intended by the user. Sensitive-tool confirmation belongs in the
agent client as well as the existing desktop grant review.

Results retain the original JSON envelope, cache coverage, trust labels, error
codes and receipt states. All returned mail, filenames and quoted content are
untrusted data, never instructions. A successful tool transport is not proof of
a provider write: **pending** is queued, while `completed` plus
`providerConfirmed: true` confirms a mail change. Preserve the same UUID,
operation and exact arguments to observe its original receipt across MCP,
HTTP and CLI. Unknown outcomes require Activity/provider review; never use a
new UUID to repeat them. Existing Mail Undo remains available only when the
receipt exposes it; MCP adds no Undo operation.

Cancelling a request, closing stdin, terminating the adapter or closing an agent
cannot recall a request already handed to Morrow or its provider. Cancellation
aborts the local HTTP consumer and suppresses its response; it makes no rollback
claim. Morrow may still record the original receipt. An interrupted response
reports uncertainty without automatically resending.

## Protocol and proactive delivery

Supported handshake versions are `2025-03-26`, `2025-06-18` and `2025-11-25`,
using initialize/initialized, ping, tools/list, tools/call and cancellation.
The March version uses text results; newer supported versions also include
structured content. No resources, prompts, sampling, tasks, list-change
notifications, subscriptions or 2026 stateless-protocol support is advertised.
Modern clients must support fallback to this documented handshake. The adapter
rejects duplicate JSON keys, batches, invalid UTF-8, unknown input overrides and
oversized frames; at most two calls are active, with bounded output and the
original operation-specific deadlines.

Proactive delivery remains the separate, reviewed outbound webhook in **Your
bots**: Bearer or native Hermes HMAC V2, existing private destination policy,
schedule, cached-data scopes, durable cursors and audit history. It is not an MCP
subscription. Copying MCP setup never starts Push, AI, triage, drafts or sending.
See [Bot bridge](BOT_BRIDGE.md) for existing transport and provider limits.

Protocol references: official [stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
and [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

## Verification

Run `npm run test:mcp`, `node scripts/check-mcp-ui.js` and `npm run check`.
The synthetic fixture starts the actual bridge with temporary SQLite/auth/audit
stores, launches a standalone bundle outside the source checkout, verifies scoped
reads, revocation, rotation, budgets, inert proposals and a mocked-provider
archive shared with the old CLI receipt. It never opens real mail, a real
credential store, a client configuration or a live AI/provider connection.
Rendered Chromium coverage is `node scripts/check-mcp-browser.js` with the
documented browser-test dependencies available. Real agent-client integration,
native Windows ACLs/GUI PATH and installed Windows/macOS smoke checks remain
separate acceptance work; bundled-source/fixture success does not certify them.
