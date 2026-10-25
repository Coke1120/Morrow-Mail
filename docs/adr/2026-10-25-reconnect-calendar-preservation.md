# Preserve reconnect state and calendar titles

Status: accepted for the fix implementation; 2026-10-25.

Password reconnect previously changed an existing account's servers before saving its credential, and retained `oauth2` when replacing an OAuth secret with a password. Calendar event normalization also replaced titles over the editor's 200-character limit with `(no title)`, which a later time-only update sent back to the provider.

Password reconnect now saves the primary credential first, then commits the password login type, server metadata and folder changes in one synchronous SQLite transaction. Snapshot and compensation stay in the same uninterrupted block as the existing account-liveness check. A reported failure restores the previous credential or removes a newly created credential. Failed compensation and uncertain journal rollback return explicit recovery instructions. This follows the existing OAuth compensation approach; it does not make the credential store and SQLite atomic across process crashes or power loss.

Calendar reads return a bounded title preview and a truncation flag. Long titles are read-only in the editor. An unchanged title is omitted from updates, including when the provider title is empty; display fallback text is never used as replacement data. Explicit new or changed titles still require the existing 200-character limit. Users edit longer titles with the provider.

Regression coverage uses synthetic accounts, temporary SQLite, memory credentials, controlled refresh races, injected write failures, reopen/process restart checks, both calendar request builders, actual renderer functions and native Electron UI fixtures. Features and contextual help describe these boundaries. Existing `AGENTS.md` feature/documentation rules already cover this work and need no duplicate instruction.
