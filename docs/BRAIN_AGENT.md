# Brain skills and Agent triage

GenMail REA runs these on the mailbox cache and your OpenAI-compatible key (`GenMail → AI Setup`). It does not call Genspark. Sample mail is not treated as your inbox.

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

No API key returns `accepted: false` with the AI Setup error. No connected mailbox returns `accepted: false` and does not read the sample mailbox.

## Agent

The Agent rail tab and the toolbar Agent button show triage sections from Brain categories. Defaults are Needs You, Upcoming Today, Worth a look, FYI, and Other. Editing categories in Brain changes the next triage.

Triage reads recent inbox messages already in the local cache. Each row is a short summary, a category, and follow-ups (review a reply, open the message, or open an attachment). Those follow-ups are proposals.

Needs an AI key, needs a mailbox, and an empty inbox cache are empty states. They do not show stand-in messages. Run history is the local list of skill and triage runs.

## Profile

The Brain dialog has three panes: Profile, Categories, and Skills. It opens and closes from the toolbar Brain button. Opening loads the cached persona, categories, and home and library skills.

Profile shows `ownerName`, `emailsAnalyzed`, `factsLearned`, and `updatedAt` when the cached persona includes them. Writing rules are added, edited, and deleted there. Learned rows (source `auto`) use Fix and Forget. Fix calls the model and replaces that stored row. Forget removes it. Refresh tries `emailBrain:refresh`, then `emailBrain:rebuild` when refresh is not accepted. Rebuild calls `emailBrain:rebuild`. Progress is the refresh and rebuild events. Rebuild and Fix call the model when a key is set. Rebuild refuses sample mail. No mailbox and an empty cache are host errors, not stand-in mail. A missing key tells you to open GenMail → AI Setup.

Categories edit locally until Save, which replaces the stored list. That list is the taxonomy the next Agent triage uses. Add with AI and Fix category stay local until Save. They need an API key and show the host error when the key is missing. Use defaults copies the host defaults into the list, still unsaved until Save.

## Channels

`emailBrain:getCached`, `emailBrain:refresh`, `emailBrain:rebuild`, `emailBrain:addWritingRule`, `emailBrain:setWritingRule`, `emailBrain:deleteWritingRule`, `emailBrain:fixItem`, `emailBrain:forgetItem`, `emailBrain:getCategories`, `emailBrain:saveCategories`, `emailBrain:addCategoryViaPrompt`, `emailBrain:fixCategory`, `emailBrain:getSkills`, `emailBrain:getLibrarySkills`, `emailBrain:installSkill`, `emailBrain:removeSkill`, `emailBrain:runSkill`, `emailBrain:confirmProposal`, `emailBrain:dismissProposal`, `nativeAgent:getTriage`, `nativeAgent:triage`, `nativeAgent:history`, `nativeAgent:home:skills`, `nativeAgent:home:librarySkills`. The dialog also listens for `emailBrain:updated`, `emailBrain:refreshState`, and `emailBrain:rebuildState`.
