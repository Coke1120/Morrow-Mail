# Workflow recovery and receipts

Agent and Brain reply proposals resolve their own source message and mailbox. Missing or mismatched sources block review. Opening a proposal never sends or schedules it. Bot proposals retain their separate account-bound seed and human Send gate.

Compose asks Save draft / Discard / Keep editing when unsaved content is closed. Discard leaves a previously saved copy unchanged. Drafts have a Resume draft action; saving again uses the same ID. Undo Send reopens the pending composition, and an unconfirmed delivery reopens it with its recipients, account, reply headers, quote, and text intact. Check Sent before retrying an uncertain delivery. The local Undo delay cannot recall a send once provider delivery begins. A queued composition locks its delivery controls. The Scheduled list distinguishes a failed read from an empty queue.

Mail changes return per-message `outcomes`: `completed`, `failed`, `unknown`, or `not_attempted`. Remote exceptions are conservatively unknown. Only confirmed moves with a verified destination identity receive Undo IDs. Undo verifies the current destination and never substitutes a local snapshot for a failed remote restore. An uncertain Undo is consumed rather than automatically retried. Receipts retain their errors beside Undo, and unresolved rows remain selected when still loaded. Sync events update the sync control instead of replacing an action receipt.

Freshness is scoped to an account and folder. Empty profiles show No account connected; page refreshes do not update mail freshness. Search covers downloaded subject, sender, and available message text, up to 100 results. A second list filter is visible and removable. Select shown counts loaded visible rows. Account-limited moves and labels explain excluded rows. Conversation removal resolves cached members and freezes the reviewed IDs before confirmation.

Bot access proceeds through account/permission selection, grant creation, one-time copy, enable, and listener verification. Saved enable intent is separate from actual listening. Last successful use is evidence of client use; a valid grant alone is not. Disabling stops the listener without revoking grants. Secrets are cleared on dialog close and cannot be redisplayed.

Rules have a dedicated mailbox selector, generation checks on loads, and account-bound save/delete/grant operations. Dirty account changes and broad/destructive rule saves are reviewed. Out of Office confirmation describes server replies, audience, effective dates, timezone, and reply excerpts; IMAP review shows the actual whole UTC days. Existing purpose-specific grants and Sieve guards are unchanged.

Validation:

- `npm run check` runs offline host and renderer-function checks, including `bot-bridge-ok`, `operation-receipts-ok`, `compose-recovery-ok`, `dialog-feedback-ok`, `search-scope-ok`, `rules-context-ok`, and `ui-path-ok`.
- `npx electron scripts/check-ux-renderer.cjs` runs the isolated renderer fixture. Linux CI can use `xvfb-run -a npx electron --no-sandbox scripts/check-ux-renderer.cjs`. It uses a temporary profile, mocked IPC, and blocked HTTP(S); it loads no production host modules. Set `MORROW_UX_EVIDENCE_DIR` to save synthetic screenshots and a result summary.

Deferred extensions: a dedicated scheduled-mail management page with edit/reschedule; real attachment forwarding; account-wide OOO status outside Settings; the broader account-settings, Agent, logs, and update UX backlog. Native packaged and live-provider behavior still needs separate validation.
