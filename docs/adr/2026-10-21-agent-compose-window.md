# Agent replies open in their own window

Agent todos that point at a message can Reply and Reply All without covering the Agent page. Those actions call `presentCompose`, which uses `compose:open`, the same BrowserWindow as New Mail, Reply, and Forward. Mark as read uses `mail:markRead`. Completing that todo after a successful reply is specified in [todo completion](./2026-10-29-agent-todo-completion.md).

There is one compose window implementation. Agent reply does not open a second host.
