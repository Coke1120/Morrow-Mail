> Historical implementation notes. Current behavior and release limits are documented in README.md, FEATURE_COVERAGE.md, and AGENTS.md.

# Genmail first release

Independent, MIT-licensed, single-user local email workspace. Original interface; no Genspark code or assets. React/Vite frontend, Express backend, Node 22.13+ built-in SQLite. Starts with a labeled demo inbox. IMAP imports INBOX; read/star/archive organization is local. Explicit send only, SMTP for live accounts; demo sending creates a simulated sent message. Plain text emails only in this release.

## HTTP contract

All routes under `/api`, JSON. Failures `{error: string}` with non-2xx status. Frontend uses relative URLs and Vite proxies /api to 127.0.0.1:3001. Production serves built frontend from backend.

Account-bound actions (send, drafts, message PATCH, AI, sync) require `X-Genmail-Account` equal to the account displayed in the requesting tab: `demo` or the live email. A mismatch returns 409, preventing a stale demo tab from sending live email or sharing another account's content with AI. `/api/send` additionally requires a stable per-compose `requestId` to deduplicate retries of confirmed sends.

Gmail and Outlook also have native OAuth API support. `POST /api/oauth/:provider/start` with `clientId` (and Google `clientSecret`) returns a local authorization URL; the browser follows it to bind OAuth to the callback host before provider sign-in. Callback imports the inbox then redirects to the app with `connected` or `connectionError`. Provider is `google` or `microsoft`. Stored mail config for OAuth contains encrypted access/refresh tokens and client credentials. Public state never includes secrets.

- `GET /api/state` -> `{account: {email, name, mode: 'demo'|'live'}, messages: Message[], settings: {mail: {configured,email,imapHost,imapPort,smtpHost,smtpPort}, ai: {configured,baseUrl,model,hasApiKey}}}`. Never returns secrets.
- `POST /api/settings/mail` body `{email,password,imapHost,imapPort,smtpHost,smtpPort}` -> same shape as state. Validates connection and syncs before activating the account. Password may be omitted to retain saved password for the same email. TLS only: IMAP 993 default, SMTP 465 or STARTTLS 587.
- `POST /api/settings/ai` body `{baseUrl,model,apiKey?}` -> same shape as state. OpenAI-compatible API, e.g. http://127.0.0.1:11434/v1 + a local Ollama model. Blank API key preserves saved key. Set `clearApiKey: true` to remove it.
- `POST /api/account/demo` -> state. Switches to demo without deleting saved settings.
- `POST /api/account/live` -> state. Switches back to a previously connected mailbox.
- `POST /api/sync` -> state. Demo is a no-op. Fetch latest 50 INBOX messages on live account.
- `PATCH /api/messages/:id` body subset `{read:boolean, starred:boolean, folder:'inbox'|'archive'|'trash'}` -> `{message:Message}`. Local organization only.
- `POST /api/drafts` body `{id?,to,subject,body,replyToId?}` -> `{message:Message}`. Save or update a draft, recipient can be empty.
- `POST /api/send` body `{to,subject,body,draftId?,replyToId?}` -> `{message:Message, simulated:boolean}`. Validates recipient. UI requires an explicit Send click; AI never sends.
- `POST /api/ai` body `{action:'summary'|'reply'|'ask', messageId?, prompt?}` -> `{text:string, source:'model'|'demo'}`. Summary/reply require selected message. Ask searches current account messages based on prompt. Without a configured model, demo account returns a clearly labeled illustrative response; live account returns 409 to ask user to configure AI. Only selected/context emails are sent to configured model after explicit action.

`Message = {id, fromName, fromEmail, to, subject, body, preview, date:ISO, folder:'inbox'|'archive'|'trash'|'sent'|'drafts', read:boolean, starred:boolean, category:'primary'|'updates'|'newsletters', labels:string[], replyToId?:string, messageId?:string}`. UI derives search, folders, unread/total counts client-side. Do not render email HTML. No attachment support in this release.

## Store contract (server/store.js)

`createStore(dataDir)` returns synchronous methods:
- `getSettings()` -> `{mail: object|null, ai: object|null, activeAccount: 'demo'|email}`. Secrets decrypted for server use only; mail password and ai apiKey encrypted at rest.
- `setSettings(partial)` shallow merges top-level settings.
- `listMessages(account)` -> Message[].
- `getMessage(account,id)` -> Message|null.
- `upsertMessage(account,message)` -> Message. Generic complete message upsert.
- `updateMessage(account,id,patch)` -> Message|null.
- `deleteMessage(account,id)` -> boolean.
- `close()` closes db.

Store initializes demo data once, persists to dataDir, creates a chmod-600 encryption key beside db, and uses account in all message queries. New IMAP messages get stable id `imap:<uidValidity>:<uid>`; caller preserves local flags/folder on sync. All content remains on local disk until explicit SMTP sending or AI action. Do not commit runtime data.
