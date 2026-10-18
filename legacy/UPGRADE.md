# Before upgrading the current app

Before first opening a schema 1 workspace with this source, back up using the
currently installed service, or copy the complete closed workspace with its
matching `encryption.key`. The new service migrates to schema 2 before its own
backup operation. Downgrading requires restoring the complete pre-upgrade copy;
do not change the schema marker to bypass the guard. See
[IMAP identity migration and recovery](docs/IMAP_SERVER_IDENTITY.md#before-upgrading).

Current behavior and release limits are documented in README.md,
FEATURE_COVERAGE.md, and AGENTS.md. The implementation notes below are historical;
their Node modules and API descriptions are not the current native/Rust architecture.

## Historical Morrow Mail upgrade contract

Keep current Genmail folder/data and all existing safeguards. Public brand Morrow Mail / Morrow. Public icon /brand/morrow-icon.svg (branding worker may provide PNG; await result).

Shared `shared/features.js` is the single feature/policy/preferences catalog. Parent owns it, server/app.js, server/policy.js, server/integrations.js and root config/docs. Never automatically send emails or publish external actions from new AI workflows.

## State additions

`GET /api/state` adds `settings.policy` = DEFAULT_POLICY merged with saved values, `settings.preferences` = DEFAULT_PREFERENCES merged with saved values, `workspace:{activity:[],reminders:[],events:[],unsubscribed:[],brain:null,skills:[...]}`. Workspace is scoped to active account and persisted; state never exposes secrets.

- `POST /api/settings/policy` takes partial `{enabled,behaviors:{id:boolean},folders:{inbox|sent|drafts|archive|trash:boolean},content:{subject|body|sender:boolean},maxMessages:1..25}`; validate all keys/booleans, merge. Returns state. All AI + mock runs enforced server-side. Disabled/out-of-scope returns403 BEFORE reading/sending model context. Subject/body/sender unchecked = omitted before searching, simulation or model.
- `POST /api/settings/preferences` partial DEFAULT_PREFERENCES keys; returns state. theme=system/light/dark, density=comfortable/compact, syncInterval=0/5/15/30 minutes (while app is open), replyTone=friendly/professional/concise/warm, language arbitrary <=60char, signature<=2000, displayName<=100.
- `POST /api/settings/ai/test` accepts current `{baseUrl,model,apiKey?,clearApiKey?}` same as save. Sends ONLY a fixed test prompt (no email) to provided endpoint and returns `{ok:true,text:'...'}`; errors sanitized. Does not save. AI config also has maxTokens (128..4096) and temperature (0..2), sent to compatible endpoint.
- `POST /api/account/disconnect` disconnects saved live credentials and switches demo; cached emails/drafts retained; returns state.
- `POST /api/ai` now accepts all NON-mock behavior ids. Selected summary/reply/translate use messageId; write requires prompt; rewrite/translate can use `draftText` instead of messageId; briefing/ask/skill use allowed mailbox context. `skill` requires skillId from workspace skills. Optional `prompt` guides output. Returns existing `{text,source}`. Policy always enforced even demo. Model instructions include configured tone/language and explicitly saved Email Brain notes only if memory behavior enabled. Draft content only allowed when draft folder and body permission enabled. Existing source demo remains clearly labeled.
- `POST /api/workflows/preview` body `{action,messageId?,when?}` with mock behavior ID -> `{preview:{id,action,title,summary,items:[{title,detail,messageId?}],createdAt},simulated:true}`. Server keeps authoritative plan 10min, bound to account and policy. UI displays review before apply. For selected actions messageId required. `when` for reminder/calendar is ISO datetime from datetime-local input, default tomorrow9am if absent; timezone shown local.
- `POST /api/workflows/apply` body `{previewId}` -> `{...state,simulated:true}`; applies ONLY local labels/stars/archive, mock reminders/calendar/unsubscribe/brain entries, plus activity log. Never calls external services or sends. Rechecks current policy/message scope and invalidates stale policy/account previews. Second application rejected409, no duplicate changes.
- `POST /api/skills` body `{id?,name,instructions}` -> state; create/update user's skill. `DELETE /api/skills/:id` -> state. Content-Type application/json and account header required. Built-in two skills editable/removable persisted.
- `PATCH /api/workspace/:collection/:id` `{done:true|false}` for reminders/events, or `{cancelled:true}` for events -> state. Local only; account header required. Allows user to finish/remind/cancel simulated records. No scheduled execution.

Existing X-Genmail-Account header required for ALL account-bound AI/workflow/skill/workspace/account disconnect requests. Settings policy/preferences/model global; account switching retains isolation. AI disable does not block manual email reading/composing/sending.

## Module ownership / workflow pure helpers

Worker `server/workflows.js` exports `createWorkflowPlan(action,messages,{when,now=new Date()}={})` -> `{title,summary,items,changes: [{messageId,patch}],records: {reminders?:[],events?:[],unsubscribed?:[],brain?:object,drafts?:[]}}`. Root routes generate previewId, enforce policy, store authoritative plans, add ID/date to records, and persist changes/activity. No provider calls, no DB access. Use deterministic simple mock text and label clearly; show unknowns instead of fabricated research facts. `brain` object `{voice:string,contacts:[{name,email}],notes:string}`. Other records objects `{title,detail,when?,messageId?}`. Draft records `{to,subject,body,replyToId}`. `changes` only read/starred/category/labels/folder allowed parent. `createWorkflowPlan` handles all mock features in shared catalog, takes already policy-filtered/redacted messages. Don't use original DB directly. No unapproved context expansion.

Additional content scopes: contacts=true (allows Email Brain contacts inclusion), calendar=true (local simulated events, no live calendar), attachments=false (opt in to mock attachment fixtures). `attachments` feature requires content.attachments; memory/research require contacts; schedule/meeting require calendar; batchReplies require sender and body. Redacting sender also blanks `to`, so disabled sender addresses cannot leak to previews or drafts.

## UI

Full-page Settings using existing component adapted with tabs General / Mail / Model / AI permissions / About. Each visible control must persist/work; no fake dead buttons. App shell settings nav selects page rather than only modal; allow close/back to inbox. Backend errors visible. Customize base URL, model ID, API key; test/save key masking.

New AI Studio page with working feature cards, clearly marked simulated where appropriate; preview -> apply local action -> activity records. Add Email Brain and custom skills views within Studio. Existing summaries/replies/search use current assistant; compose supports prompt-to-email/rewrite/translate with review-before-insert and signature. Policy controls disable relevant UI and link to Settings. No automatic model execution on loading mail. Model-independent mocks always local even when model configured. Responsive original forest/cream design maintained, branded icon actual image. Theme, density, display name, signature, mark-read, sync interval implemented in App.
