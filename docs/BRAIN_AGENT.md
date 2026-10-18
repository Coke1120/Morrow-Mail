# Brain skills and Agent triage

GenMail REA runs these on the mailbox cache and your OpenAI-compatible key (`GenMail → AI Setup`). It does not call Genspark. The host has no sample mailbox.

## Skills

Home starts with the catalog installed. Library skills are the ones you removed. Install and remove persist in `agent.json` under the AI config directory.

| Skill | What it uses |
| --- | --- |
| Morning Brief | Recent inbox mail |
| Catch Me Up | Recent inbox mail |
| Organize Inbox | Recent inbox mail. Proposes a label or folder move |
| Plan My Week | Inbox mail, plus `calendar:list` when a calendar grant exists. Otherwise a mail-only plan |
| Newsletter Digest | Inbox mail that looks like newsletters or bulk mail |
| Brief This Person | A selected message in the local cache, or a contact email you pass in |
| Meeting Prep | Calendar events and related mail when a calendar grant exists. Otherwise mail only |

Every skill is `runMode: on_demand`. Schedule and auto-run stay disabled. A run calls the model and returns a title, summary, sections, optional drafts, and optional follow-ups. Drafts open in compose. Send stays on the compose button.

Organize Inbox does not move mail until Confirm. Confirm uses Gmail labels or an Outlook folder when that organize grant exists, or an IMAP folder with the same name. No grant and no matching folder leaves the proposal pending. Dismiss drops it. Nothing is sent.

No API key returns `accepted: false` with the AI Setup error. No connected mailbox returns `accepted: false`. The host has no sample mailbox to read.

## Agent

Agent opens from the leftmost rail, in the same strip as Mail, Calendar, and Brain, and from the toolbar Agent button. It replaces the mail shell with the full Agent page: a greeting, category todo stacks, skill chips, Manage Skills, and a composer that says Ask GenMail Agent. The folder column and message list are the Mail page. Home todos come from `nativeAgent:home:todosCached`. Opening Agent paints that cache, then runs `nativeAgent:triage` when the cache is stale. Saving Brain categories calls `nativeAgent:home:refreshTaxonomy` so the stacks follow the new order. Done and Dismiss call `nativeAgent:home:todoUpdate` and stay on this computer. The transcript and standing notes stay on that page.

A message is routed on the host. Naming a home skill runs that skill. "Triage inbox" (or "sort the inbox") runs triage. "Draft a reply" proposes a draft. Anything else is a question. Each question sends a system prompt that must not invent mail and must not send, the last few turns, standing notes, and snippets from the cached inbox and calendar. There is no sample mailbox to include. The transcript is `agent-chat.json` in the AI config directory. Standing notes are `agent-memory.json` in that same directory. Both survive a relaunch.

Triage still files recent inbox mail into Brain categories. Defaults are Needs You, Upcoming Today, Worth a look, FYI, and Other. Editing categories in Brain changes the next triage. Each row is a short summary, a category, and follow-ups (review a reply, open the message, or open an attachment). Those follow-ups are proposals. Drafts open in compose. Nothing is sent until you choose Send.

Needs an AI key, needs a mailbox, and an empty inbox cache are empty states. They do not show stand-in messages. Each triage row can open its message. Brief This Person uses the open message or a contact email from the panel. Run history is the local list of skill and triage runs, and choosing a row adds that saved run to the transcript.

## Profile

Email Brain is the leftmost rail entry after Calendar, with Profile, Categories, and Skills. It opens from that rail button and the toolbar Brain button, and replaces the mail shell. Mail returns to folders, the message list, and the reader. Opening loads the cached persona, categories, and home and library skills, then calls `emailBrain:refresh` with source `open` (a fresh cache does not call the model).

Profile shows `ownerName`, `emailsAnalyzed`, `factsLearned`, and `updatedAt` when the cached persona includes them, plus recent updates from local activity. Writing rules are added, edited, and deleted there. Learned rows (source `auto`) use Fix and Forget. Fix calls the model and replaces that stored row. Forget asks, then removes the row. Refresh calls `emailBrain:refresh` with source `manual` and updates the living profile from sent mail first, then inbox mail. Rebuild asks, then calls `emailBrain:rebuild` and replaces the generated persona from a larger sent-and-inbox sample. User writing rules stay. Progress is the refresh and rebuild events. Rebuild and Fix call the model when a key is set. Rebuild needs a connected mailbox. No mailbox and an empty cache are host errors, not stand-in mail. A missing key tells you to open GenMail → AI Setup.

Categories edit locally until Save, which replaces the stored list. That list is the taxonomy the next Agent triage uses. Add with AI and Fix category stay local until Save. They need an API key and show the host error when the key is missing. Use defaults copies the host defaults into the list, still unsaved until Save.

## Channels

`emailBrain:getCached`, `emailBrain:refresh`, `emailBrain:rebuild`, `emailBrain:addWritingRule`, `emailBrain:setWritingRule`, `emailBrain:deleteWritingRule`, `emailBrain:fixItem`, `emailBrain:forgetItem`, `emailBrain:getCategories`, `emailBrain:saveCategories`, `emailBrain:addCategoryViaPrompt`, `emailBrain:fixCategory`, `emailBrain:getSkills`, `emailBrain:getLibrarySkills`, `emailBrain:installSkill`, `emailBrain:removeSkill`, `emailBrain:runSkill`, `emailBrain:confirmProposal`, `emailBrain:dismissProposal`, `nativeAgent:getTriage`, `nativeAgent:triage`, `nativeAgent:history`, `nativeAgent:home:skills`, `nativeAgent:home:librarySkills`, `nativeAgent:home:todosCached`, `nativeAgent:home:refreshTaxonomy`, `nativeAgent:home:todoUpdate`, `nativeAgent:chat`, `nativeAgent:chatHistory`, `nativeAgent:chatShow`, `nativeAgent:memoryGet`, `nativeAgent:memorySet`. The Brain pane also listens for `emailBrain:updated`, `emailBrain:refreshState`, and `emailBrain:rebuildState`.
