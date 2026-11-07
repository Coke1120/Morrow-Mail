# Local MCP over the existing agent bridge

Unify Settings as **Agent access / MCP**. Preserve the HTTP API, Node CLI and
proactive Bearer/Hermes webhook integrations during adoption; changing the
preferred connection experience must not silently revoke or broaden grants.

Use a local stdio adapter that calls the existing loopback bridge. It never
loads mailbox storage, provider credentials or service handlers directly.
Authentication, mailbox/operation permissions, revocation, request budgets,
audit history, provider-write admission and idempotency stay in their existing
host-owned paths. Discovery authenticates the current grant rather than
publishing an unrestricted operation list. Explicit write UUIDs remain separate
from MCP correlation IDs, preserving receipts across all three transports.

Package a standalone Node bundle in resources with the existing esbuild and
resource rules. Installed-app users do not need a checkout or SDK, but must
install Node.js 20+ separately and run their agent on the Morrow computer.
Settings copies command/args containing a private token-file path, never a
secret, and does not install software or edit global agent configuration.
The existing one-time grant dialog and verifier storage remain intact. Add an
MCP agent label for new explicit grants; preserve the legacy API's omitted-
platform default and every saved Grok/Hermes platform and webhook binding.

Support the explicit 2025 handshake versions with tools only; defer remote MCP,
OAuth/HTTP MCP, resources, prompts, subscriptions and the 2026 stateless model.
Do not expose the compatibility Tailscale endpoint as MCP. This avoids a second
network security boundary and preserves the separately reviewed proactive
webhook consent/delivery system. Cancellation stops the adapter's local
consumer, not a submitted provider operation, and never triggers an automatic
retry. See [MCP setup and limits](../MCP.md).
