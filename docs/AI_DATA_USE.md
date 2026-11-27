# AI data use and permission

Release coverage: v0.2.39 includes consent #302 and Gmail migration #305; see [versioned release notes](releases/v0.2.39.md). The separately published public disclosures were confirmed against v0.2.38, so their deployment does not establish alignment with this app version or Google verification. Review [the decision](adr/2026-10-25-ai-data-permission.md) and the separate [Gmail migration plan](GMAIL_LEAST_PRIVILEGE_PLAN.md).

## Before using AI

Save a provider, authentication method and model in Settings → AI or AI Setup.
A manual request uses the saved ready connection when you start the action.
Timeline and Case show the selected mail and destination before you choose
Generate. Test connection sends a fixed greeting prompt. Fetch models uses
the selected credentials to read the model catalog.

Automatic processing defaults to **Only when requested**. Choose **Run
background AI** to enable automatic Brain refresh, Agent-open triage,
reply-compose suggestions and scheduled skills for the current connection.
An unchanged, verified background choice from an earlier version is
preserved. Saving an endpoint, model, key or ChatGPT account change turns it
off for that connection.

Each request is bound to the provider, model and account at its start.
Changing the connection or turning automatic processing off cancels pending
work. If writing the off preference fails, the running process still stops
background work and reports the error. Cancellation stops later calls.
Provider account settings govern data that already reached the provider.

## Actual outbound paths

All production AI prompt sends in this repository call `host/openai-client.js` (`complete` or `stream`). The consent lease is checked before the API request or ChatGPT adapter, before each stream/fallback send and before accepting returned output. API requests reject redirects. The ChatGPT adapter also rejects redirects and honors the combined cancellation signal. It sends to `https://api.openai.com/v1/responses`, after its account model catalog check. API mode sends to the configured completions destination. A loopback destination is identified as a service on this computer, which may forward data according to its own configuration; it is not a promise of local-only inference.

| Feature and source | Context actually sent | Trigger |
| --- | --- | --- |
| Message summary (`host/message-summary.js`) | Selected cached sender, subject and date; reviewed downloaded body text including quoted history. The local coverage check sends no message text. Longer or incomplete messages require an explicit full-downloaded-text or excerpt choice. Full runs accept up to 128,000 source UTF-8 bytes subject to 31-request/serialized-input budgets, split without breaking Unicode and consolidate all reviewed parts. Incomplete downloads and excerpt omissions stay labelled. No attachment files, linked pages, other messages, Brain or Agent history are included. | Explicit Summary in either reader; explicit coverage choice when needed. Cancel aborts pending requests; two-minute per-request and ten-minute multi-request deadlines. |
| Translation (`host/translate.js`) | Text nodes from the visible message, including quoted history; node ids; target language. Long text is split into batches. | Explicit Translate; Cancel aborts pending batches. |
| AI Write (`host/draft-write.js`) | Instructions, selected text, draft content (which may include a signature), cursor context, subject, recent supplied writing history; source sender/subject/snippet or reply source text; Brain writing rules. | Explicit writing action. |
| Reply suggestions (`host/draft-write.js`) | Sender, subject and snippet/text body supplied by the reader/composition. | Explicit Suggest, or separately classified background suggestions when reply composition opens. |
| Brain refresh/rebuild (`host/brain.js`, `agent.profileSample`) | Sent/inbox message ids, senders, subjects, dates, folder and snippets (280 characters); refresh also includes the previous generated profile/voice/identity. Account identity is collected locally after distillation. | Explicit Refresh/Rebuild; separately permitted automatic refresh using Settings → Brain: Daily (default), Weekly, or Manual only. Timer checks and Brain open share the selected interval; missed slots combine into one attempt while the app runs. Failed automatic attempts wait the full interval across restart. Cadence never grants background permission, and skill schedules/Agent triage are independent. |
| Brain category/profile correction | Category prompt/id, or supplied row/identity correction parameters. | Explicit Add with AI/Fix. |
| Catalog/custom skills (`host/agent.js`) | Up to 24 recent inbox message records or person-scoped cached mail; ids/account/folder/thread identifiers, senders, subjects, snippets, dates, read/star/attachment-presence flags; categories, writing rules, Agent notes, person address and skill instructions. Calendar-enabled skills add up to 20 event titles/start/end/location from the coming week when an existing calendar grant permits a read. | Explicit Run/chat-routed skill; saved schedules require background permission. |
| Agent triage | Recent inbox metadata/snippets, categories, writing rules, Agent notes and available Brain identity brief. | Explicit triage or separately permitted stale triage on Agent open. |
| Agent draft reply | Selected source metadata/snippet, four inbox metadata/snippets and writing rules. | Explicit chat request; output is a reviewable draft. |
| Other Agent questions | User question, up to eight inbox sender/subject/snippet/date records, recent conversation turns, standing notes and available calendar titles/times/locations. | Explicit question. Some inventory/filter/page routes answer locally. |

These paths do not send attachment file bytes. Mail metadata can reveal that attachments exist. They do not hand mailbox passwords or mail OAuth tokens to the model. AI API credentials or the separate ChatGPT access token authenticate the selected AI service.

Morrow stores its mail cache and AI profile/chat/notes on this computer. The ChatGPT adapter sets `store: false`; this describes a request parameter, not verified retention, training, human-access or deletion terms. API/custom endpoint provider practices and downstream forwarding are not verified by this code. No assertion that a provider never retains/trains on Google data is made. Provider contractual suitability and Google's review of the real data flow remain release/verification evidence gaps; user consent alone does not waive Google's Limited Use restrictions.

## Bot bridge background delivery

Grok Bot and Hermes Agent can separately receive proactive cached-mail digests at a user-configured private webhook. This path calls no AI model and does not use `host/openai-client.js` or the AI provider's version 1 permission. It requires a valid scoped Bot access grant, the running listener and an explicit **Allow proactive notify to this webhook in the background** choice in each bot's Settings. The review includes the destination, mailbox subset, schedule, headers/snippets and optional permitted cached text, downstream handling and revocation limits. Saving credentials or enabling the listener alone cannot authorize it.

Bot archive, read/unread and Trash permissions are separate default-off mailbox capabilities. AI permission and webhook consent grant none of them. Stop this transfer with **Stop proactive notify**, bridge disable or grant revoke in Bot access. Settings → AI revoke still controls AI model requests independently. The platform bot decides what to do with the untrusted raw data and may use its own model/provider according to its operator's configuration; Morrow neither invokes that model nor verifies retention/forwarding. Already delivered data cannot be recalled. See [Bot bridge proactive notify](BOT_BRIDGE.md#proactive-notify-grok-bot-and-hermes-agent) for private routing, data limits, cursor semantics and Activity. This feature does not change public policy, OAuth scopes or provider verification status.

## Validation and policy coordination

`scripts/check-ai-consent.js` uses synthetic messages/providers and temporary files to exercise the real entrypoints, migration default, separate background gate, target changes, stale approval, abort, queued-work revocation and fallback prevention. Shared Settings and AI Setup DOM/VM fixtures cover affirmative controls, stale reads, duplicate submissions, revoke/late-grant ordering and disposal. These are logic checks, not rendered/native validation.

Public disclosure task `01a17414-44de-7281-9133-577f18efe0f2` distinguishes released behavior from this implementation: existing remote AI paths can transfer the context above; PR #302 adds an explicit universal gate and a separate background gate. The earlier no-Google-data-third-party-sharing description must not be used for those paths. This app task does not modify the policy site, terms, domain or Google Console. The v0.2.39 app release records the implemented gates; external policy and Google rollout alignment remain separate owner work.

The policy owner confirmed that [hwl-hk PR #21](https://github.com/Coke1120/hwl-hk/pull/21) and [promotion #22](https://github.com/Coke1120/hwl-hk/pull/22) are merged, with main/dev at `179adf38a1d6f0b52472c8420e89a9b6427df26d`, Vercel production READY and hwl-hk.com assigned. The published disclosures describe released v0.2.38. See the [policy evidence/dependency ADR](https://github.com/Coke1120/hwl-hk/blob/179adf38a1d6f0b52472c8420e89a9b6427df26d/docs/adr/2026-10-25-morrow-mail-disclosure-review.md). The v0.2.39 app release includes consent #302 and Gmail #305; the website deployment alone does not establish this version coverage, provider suitability or Google compliance. No external policy update is made by this release.

The browser `file:` page navigation previously returned `ERR_BLOCKED_BY_ADMINISTRATOR`, and `/tmp/codex-daemon-1000` access previously returned Permission denied. Neither action is retried or routed around here. Rendered/native validation remains pending. The web reader could read the sources linked below, but could not read the requested `13807382` (500 redirect to Google's inaccessible sorry page), `13805798` (inaccessible), or the public Morrow privacy URL (inaccessible). Those exact URLs were not retried by another route.

Sources checked 2026-10-25: [Google app privacy policy guidance](https://support.google.com/cloud/answer/13806988), [minimum scopes](https://support.google.com/cloud/answer/13807380), [Workspace user data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy), [verification FAQ](https://support.google.com/cloud/answer/13463817?hl=en). Outstanding requested sources: [13807382](https://support.google.com/cloud/answer/13807382), [13805798](https://support.google.com/cloud/answer/13805798). No Console, OAuth grant/login, mailbox data, model request or public-policy deployment was used for this work.
