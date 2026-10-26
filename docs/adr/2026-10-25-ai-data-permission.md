# Versioned permission before AI data transfers

Status: implemented through PR #302 and included in the v0.2.39 release scope. Native/live and provider/Google validation remain pending; see [release limits](../releases/v0.2.39.md).

Existing remote AI entrypoints share `openai-client`, but API-key presence previously authorized transfers implicitly. ChatGPT account background consent did not cover API mode or explicit data transfer consent. Google/user authorization needs an understandable disclosure and affirmative choice before transfers, including derived mail/profile data and calendar context.

Use one main-process consent record (`ai-consent.json`) with the disclosure version and a fingerprint of the effective saved destination/model/mode/credential or ChatGPT registration. Store separate explicit-action and background permissions; both default off for every existing configuration. UI approval uses an opaque current-target token. No key/token value is exposed by this record's UI. Save/sign-in/catalog reads are not consent. A material disclosure change increments the contract version. Changes retire the grant rather than accumulating dormant grants for former destinations.

Enforce at the shared AI transport and retain the authorization stamp across each feature's asynchronous work. Check before every send/fallback and reject redirected API sends. Abort active requests on revoke/config/account changes; discard late output and refuse queued work even after later reapproval. Already delivered data cannot be recalled. Ordinary local/mail functionality is separate. A loopback service receives the same context and may forward it; local-only inference is not assumed.

Keep the existing API/custom endpoint and ChatGPT account choices. Do not infer retention or training terms from `store: false`, and do not silently fall back to paid APIs or another provider. Provider terms and Google eligibility still require evidence; a permission control is not a compliance certification.

Base `6217cfe` includes merged settings-race PR #296 (`a600c6c`, original head `f105f0e`). This change extends its shared settings component and adds post-save consent refresh; its save/test/sign-in ownership logic is retained and regression-tested. No duplicate patch or rebase of that PR is needed. The timeout/Bodies/release branches are not modified. Gmail transport/scopes are handled in a separate draft; no Gmail transport or OAuth scopes change in this PR.

The consent branch was safely rebased onto dev `09081ae` after PR #296 had merged, retaining both the IMAP timeout fixture and consent fixture in the full-check list. This updates the review base after the independent release work; it does not add compliance work to that release.

See [AI data use](../AI_DATA_USE.md) for actual payloads, permission management, policy coordination and synthetic/native evidence limits.
