# Account settings open on account management

Base: dev at `3c24b6c`.

Accounts previously placed mailbox tools before a passive connected-account list,
with a separate Settings mailbox dropdown above the tab content. This made it
hard to tell which connection a tool would change.

Accounts now starts with Add account and actionable identity/provider/status
cards. The current Settings mailbox opens immediately, falling back to the first
connected account when Mail has no selection. A full identity heads the scoped
tools, reconnect, permissions and recovery/removal section. A single account uses
the same direct view; an empty profile shows an explanation and Add account.
The Mail selection is independent. Out of Office retains its labelled selector.
Sender identity editing stays in Compose. Computer-wide Google client configuration
and credential help remain separate, below the scoped account section.

Cards are native buttons with pressed state, visible focus and full wrapping
identity text. They reflow for narrow windows and preserve focus after rendering.
Read-only permission loading leaves account navigation available; generations and
account IDs reject stale responses. Repeated switches during an unsaved Out of
Office confirmation cannot open another confirmation. Provider writes, OAuth,
removal confirmation and account-scoped IPC continue through existing handlers.

No host, credential, provider, translation or IPC contract changes are required.
The first-party settings shell uses English strings today; message translation
and its language choices remain unchanged.
