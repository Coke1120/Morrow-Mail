# Brain Self graph (Persona weighting for Needs You)

## Goal

Improve Agent triage accuracy for the **Needs You** category by teaching Email Brain a structured **Self graph** (who the mailbox owner is) through auto distill, then injecting that identity into the triage prompt.

v1 is approach A only: persona weighting. The model still chooses the category. The host does not add a mention flag, and it does not override the model's category with a hard Needs You rule.

## Decisions

| Topic | v1 choice |
| --- | --- |
| Feature | Self graph: one structured identity for the mailbox owner |
| Source | Auto distill. Refresh is a soft distill. Rebuild is a hard distill. Fix and Forget apply to auto rows |
| Primary consumer | `nativeAgent:triage` when it files mail into Needs You |
| Approach | A. Persona weighting |
| Storage | `identity` on the existing Brain persona in `brain.json`. No new database and no new IPC channel |
| Mail on disk | Unchanged. Distill, Fix, Forget, and triage do not edit message bodies |

Needs You is the default category `{ id: "needs-you", name: "Needs You" }` in `host/brain.js`. People can rename or reorder categories. The guidance names that job (a reply or a decision from the owner) and mentions id `needs-you` when that id is still in the taxonomy.

## Non-goals for v1

- Mention chips in the message list or the reader
- A host `mentionsOwner` flag on messages or triage rows
- A Needs You score in the Agent UI
- Rewriting mailbox messages
- Approach B (a host mention signal). The same identity fields can feed that later. This spec does not implement it
- A second persona per account. Every connected account contributes addresses to one Self graph
- Editing Settings → Compose from the identity list. Aliases stay on that settings form

## Current seams

These are the pieces v1 extends.

- The generated persona lives in `brain.json` (`host/brain.js` `readStore` / `writeStore`). `store.generated` is shaped by `buildGenerated` in `host/brain-persona.js`.
- Profile meta is `ownerName`, `emailsAnalyzed`, `factsLearned`, and `updatedAt`, rendered into `#brain-meta` by `brainProfileMeta` / `paintBrainMeta`. The summary card is `.brain-summary`.
- Refresh (`emailBrain:refresh`) and Rebuild (`emailBrain:rebuild`) call `personaSystemPrompt` and `applyGenerated`. A fresh cache on open (`source` other than `manual`, age under 30 minutes) does not call the model. User writing rules stay out of the generated JSON. Section rows, auto writing, and voice quotes keep their caps (8, 8, and 6) and the near-duplicate dedupe in `factsNearDuplicate`.
- Learned profile rows use `source: "auto"`. Fix is `emailBrain:fixItem`. Forget is `emailBrain:forgetItem` and asks before it removes the row.
- `nativeAgent:triage` in `host/agent.js` sends `TRIAGE_SYSTEM` plus user JSON `{ instruction, categories, writingRules, notes, messages }`. `gate()` returns before that call when the AI key or the mailbox is missing. The key error is `Add an API key in Morrow Mail → AI Setup.` The mailbox error is `Connect a mailbox. Sample mail is not used.`
- Owned addresses already exist for compose. `shared/compose-policy.js` `identities()` unions the account primary, cached Gmail send-as (pending and unverified rows skipped), and explicit aliases plus preferred From from `settings.json` `brainCompose`. Gmail send-as discovery uses an existing `gmail.settings.basic` grant and does not open consent. The stored cache is `accounts.send_as_json`.

`check-boot-path.js` requires this order inside `#brain-profile`: `.brain-summary`, then `#brain-meta`, then `#brain-status`, then `#brain-refresh`, then `#brain-rebuild`, then `#brain-sections`. The hint string `Refresh distills the living profile.` stays. `docs/PARITY_SHELL.md` must keep the words `ownerName`, `emailsAnalyzed`, and `factsLearned`.

## Architecture

Self graph is an `identity` object on the generated persona. `personaFrom` copies it to `persona.profile.identity` on the cached snapshot (`emailBrain:getCached`). When `generated.identity` is absent, that profile key is absent too.

`generated.ownerName` remains the string Profile meta already shows. `identity.ownerName` is the same string. One name, two reads.

```json
{
  "ownerName": "Ada Lovelace",
  "displayNames": [
    { "id": "identity:displayNames:a-lovelace", "value": "A. Lovelace", "source": "auto" }
  ],
  "emails": [
    {
      "id": "identity:emails:ada@example.com",
      "address": "ada@example.com",
      "source": "account",
      "accountId": "acct-1",
      "kind": "primary"
    }
  ],
  "nicknames": [
    { "id": "identity:nicknames:ada", "value": "Ada", "source": "auto" }
  ],
  "orgs": [
    { "id": "identity:orgs:analytical-engines", "value": "Analytical Engines", "source": "auto" }
  ]
}
```

| Field | Who writes it | Source | Fix / Forget |
| --- | --- | --- | --- |
| `ownerName` | Distill, with the same fallback as today's `buildGenerated` | The meta string | Shown on the summary card. No Fix or Forget on that line |
| `displayNames[]` | Distill | `auto` | Yes |
| `nicknames[]` | Distill, after the weak-nickname drop | `auto` | Yes |
| `orgs[]` | Distill | `auto` | Yes |
| `emails[]` | Host, after the model returns | `account` only | No |

`emails[].kind` is `primary`, `sendAs`, or `alias`. Preferred From that is not already the primary or a send-as address is `alias`. The profile list shows the address and the source word `account`. Kind and `accountId` are host bookkeeping.

The model JSON may include an `emails` array. The host ignores it. Account addresses are merged by the host after the model returns.

### Caps and ids

`displayNames`, `nicknames`, and `orgs` each cap at 8. That is `SECTION_ROW_CAP`. Dedupe uses `dedupeFacts` / `factsNearDuplicate` on the value. Empty values are dropped. Each value is trimmed and sliced to 80 characters, the same label slice sections use.

`emails[]` does not use the 8-row cap. Addresses are normalized with `address()` from `shared/compose-policy.js`. One row per lowercase address. Order follows connected accounts (`listAccountRows`: `created_at`, then id). Inside an account the order is primary, then accepted send-as in cache order, then explicit aliases and preferred From in settings order. The same address on two accounts keeps a single row. Kind priority is primary, then sendAs, then alias. `accountId` is the first account that supplied the winning kind.

Auto row ids:

- `identity:displayNames:<slug>`
- `identity:nicknames:<slug>`
- `identity:orgs:<slug>`

`slug` is the value lowercased, with non-alphanumeric runs collapsed to a single hyphen, trimmed of hyphens. The full id is sliced to 80 characters. A value that slugs to empty is dropped. A collision gets `-2`, `-3`, and so on, still within 80 characters.

Email ids are `identity:emails:` plus the normalized address, sliced to 80 characters.

### Weak nicknames

`isWeakNickname` lives next to the other persona normalizers in `host/brain-persona.js`. A nickname is weak when either check matches:

1. Compact length is 2 or less. Compact form is the trimmed value with whitespace and punctuation removed. Count Unicode code points. `Al`, `Jo`, and `A.L.` are weak. `Ada` is kept.
2. The lowercased trimmed value, or its compact form, is one of: `me`, `my`, `i`, `hi`, `hey`, `hiya`, `yo`, `ok`, `okay`, `the`, `and`, `you`, `mr`, `ms`, `mrs`, `dr`, `re`, `fw`, `fwd`, `cc`, `to`, `from`.

Weak nicknames are not added to `nicknames[]`. They are not stored with a weak flag. Fix of a nickname that comes back weak leaves the stored row unchanged and returns a failure: `That nickname is too short or too generic to keep.`

Display names and orgs do not use this filter. A short signature form can sit in `displayNames` and show on the profile. The triage brief includes stored display names and stored nicknames. Because weak nicknames were never stored, triage does not emphasize them.

### Account email merge

`host/brain-persona.js` stays free of the mail database. `mergeIdentity(prior, parsed, accountEmails)` is pure. `host/brain.js` collects `accountEmails` and passes them into `applyGenerated` / `buildGenerated`.

Each collected row is `{ address, source: "account", accountId, kind }`. Collection reuses `identities()`:

- Primary: `accounts.email`
- Send-as: parsed `send_as_json`, which discovery already limits to primary or `verificationStatus === "accepted"`
- Aliases: `brainCompose.accounts[accountId].aliases` and `preferredFromAddress`

Collection does not call Gmail, does not open consent, and does not refresh send-as. A cold cache means send-as is unknown for that account, not empty.

`accountEmails` is `null` when the account list, compose settings, or the database cannot be read. `null` means keep the prior `emails[]` unchanged.

When the list loads:

- `send_as_json` null or unreadable for one account: that account still contributes primary and explicit aliases. Prior `sendAs` rows for that `accountId` stay until a later successful array read replaces them.
- `send_as_json` parses to an array, including `[]`: that array is the send-as set for that account.
- An account missing from the loaded list drops its emails.
- A successful load with no addresses stores `emails: []` only when every source for every connected account was readable. If any source was unknown, keep the prior emails that the successful part of the read did not replace.

The model cannot clear `emails[]`. Forget cannot clear `emails[]`. A distill that throws before `applyGenerated` does not write identity.

### Distill merge

Add `identity` to `PERSONA_SHAPE` and to the prior object Refresh sends (Rebuild still sends `prior: null`):

```json
{
  "ownerName": "string",
  "displayNames": ["string"],
  "nicknames": ["string"],
  "orgs": ["string"]
}
```

The model returns strings. The host assigns ids and `source: "auto"`.

An identity object is complete when it is a non-null object, `ownerName` is a string (empty is allowed), and `displayNames`, `nicknames`, and `orgs` are arrays (empty is allowed). Anything else is incomplete, including a missing `identity` key.

| Model identity | Auto fields (`displayNames`, `nicknames`, `orgs`) | `ownerName` | `emails[]` |
| --- | --- | --- | --- |
| Complete | Replace with the normalized arrays. An empty array clears that auto list | Non-empty `identity.ownerName`, else non-empty top-level `ownerName`, else prior `ownerName`, else `You` | Host merge after this step |
| Incomplete | Keep the prior auto lists. If there is no prior identity, store empty arrays | Same resolution, using top-level `ownerName` and the prior generated name | Host merge after this step. Never replace emails from the model |

Refresh and Rebuild both use this table. Rebuild still replaces generated writing, voice quotes, and sections from the new sample and does not restore those prior rows. User writing rules stay as they are today. Identity is the field covered by the incomplete-model rule: a bad identity payload keeps the prior Self graph, then merges account emails.

`generated.ownerName` and `identity.ownerName` are set to the resolved name, including the existing `You` fallback, so the summary card does not change behavior. The triage brief omits `ownerName` when it is empty or `You`.

`factsLearned` stays writing rows plus learned section rows. Identity rows are not facts.

Both `personaSystemPrompt("refresh")` and `personaSystemPrompt("rebuild")` gain this instruction, without removing the sentences `scripts/check-brain-persona.js` already matches:

> Fill identity from the mail. Read sent mail first for the owner's names: the From display name and the signature. Then read inbox mail for how other people address the owner, including nicknames and organizations. Put that in identity.ownerName, identity.displayNames, identity.nicknames, and identity.orgs. Leave email addresses out of identity; the host adds the mailbox addresses. Do not invent names that are not in the mail or the prior profile. Do not edit mailbox messages. Omit nicknames of one or two characters and generic tokens such as hi, ok, and re.

Sent mail still weighs voice. Inbox mail is evidence of how others address the owner, not the owner's voice. The existing section caps and dedupe stay on sections, writing, and voice quotes.

Identity is written only on the success path of `applyGenerated`. These paths do not create or clear it:

- No API key. Refresh and Rebuild return `accepted: false` as they do today. Triage `gate()` returns the AI Setup error.
- No connected mailbox. Refresh and Rebuild use their current `failJob` copy. Triage `gate()` returns the mailbox error.
- Empty mailbox cache. The current empty-cache `failJob` copy.
- A cached open refresh that does not call the model.
- A thrown model call. `analyzeMailAdmitted` already skips `applyGenerated` on that error.

The host does not invent nicknames, orgs, or display names on those paths.

### Worked merge

Prior identity: owner `Ada`, nickname `Ada`, emails `ada@example.com` (primary) and `old@example.com` (alias).

The refresh model returns owner `Ada Lovelace`, display name `A. Lovelace`, nicknames `Al` and `Ada`, org `Analytical Engines`, and email `stranger@example.com`.

The host account read returns `ada@example.com` (primary) and `ada@other.com` (alias).

Stored result:

- `ownerName` `Ada Lovelace` on both `generated` and `identity`
- display name `A. Lovelace` (`auto`)
- nickname `Ada` (`auto`). `Al` is dropped
- org `Analytical Engines` (`auto`)
- emails `ada@example.com` and `ada@other.com`, both `source: "account"`
- `stranger@example.com` is ignored
- `old@example.com` is gone because the account read succeeded and did not include it

If that model payload is incomplete (`{}` or no `identity` key), the prior nickname `Ada` and the prior display names stay, `Al` is not added, and emails are still replaced by the successful account read.

## Data flow and UX

1. Profile still shows Owner, Emails analyzed, and Facts learned from `brainProfileMeta`. `updatedAt` stays on that list when the cache has it. Inside `.brain-summary`, after `#brain-meta` and before `#brain-status`, add a collapsed disclosure:

```html
<details id="brain-identity">
  <summary>
    <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></polyline></svg>
    Identity
  </summary>
  <div id="brain-identity-list"></div>
</details>
```

The icon is the Feather chevron-down path (`react-icons/fi` `FiChevronDown`): `viewBox="0 0 24 24"`, `currentColor`, decorative `aria-hidden="true"`. The visible summary text is `Identity`. The control is the native `details` element, collapsed by default (no `open` attribute). It adds no extra animation. Existing `prefers-reduced-motion` handling in the shell stays as it is.

`paintBrain` fills `#brain-identity-list` from `persona.profile.identity`:

- Groups, in order, only when they have rows: Emails, Names, Nicknames, Organizations.
- An email row shows the address and the word `account`. It has no Fix or Forget button.
- An auto row shows the value and the word `auto`, then Fix and Forget. Labels match the other learned rows: `aria-label` `Fix {value}` and `Forget {value}`.
- Forget still asks, then calls `emailBrain:forgetItem`. Fix still uses the Fix note and `emailBrain:fixItem`.
- When `profile.identity` is absent, the disclosure shows: `Refresh learns names from your mail. Mailbox addresses show up here after that distill.`

`#brain-persona-hint` stays `Refresh distills the living profile. Rebuild replaces the generated persona. Your writing rules stay.`

2. `nativeAgent:triage` reads the cached persona through `identityBrief()` in `host/brain.js` (next to `writingBrief()`). The brief is null when `generated.identity` is absent, and when the resolved brief would have no name, no aka, no email, and no org. A null brief means the triage system text and the user JSON match today: no identity object and no extra Needs You sentence. Triage still runs.

When the brief exists, the user JSON gains:

```json
{
  "ownerName": "Ada Lovelace",
  "aka": ["A. Lovelace", "Ada"],
  "emails": ["ada@example.com", "ada@other.com"],
  "orgs": ["Analytical Engines"]
}
```

Omit `ownerName` when it is empty or `You`. Omit any array that is empty. `aka` is display names then nicknames, deduped case-insensitively, at most 16 strings.

`triageSystemPrompt(brief)` in `host/brain-persona.js` returns the system text. `host/agent.js` uses it for the triage call. When `brief` is null the text is exactly the current `TRIAGE_SYSTEM`:

> You sort inbox mail into the user's categories. Use only the messages and categories in the user JSON. Do not invent messages. Do not send mail. Reply with JSON only, no markdown. Shape: {"items":[{"messageId":string,"categoryId":string,"summary":string,"followUps":[{"messageId":string,"kind":"draft"|"open"|"flag-attachment","label":string,"body":string}]}]}. Assign each message exactly once. summary is one short sentence from that message.

When `brief` is set, that text gains this paragraph after a space:

> Identity in the user JSON is the mailbox owner: name, also known as, and email addresses, plus organizations when present. Choose Needs You for a direct ask, named responsibility, or a primary action on that owner. Do not choose Needs You for FYI, newsletter, or noreply mail when the only reason is an incidental name collision.

The host still files each message with `groupTriage` from the model's `categoryId`. v1 does not rewrite that assignment.

3. Missing identity (never distilled, so `generated.identity` is absent) leaves triage on today's prompt. Agent home still opens. An empty inbox still stores the empty triage snapshot triage already writes, and it does not call the model.

4. Mailbox messages on disk are never edited. No path in this feature updates `html_body`, `text_body`, or MIME.

`emailBrain:updated` already repaints Profile after Refresh, Rebuild, Fix, and Forget. The hourly living refresh uses the same soft distill as Refresh, so it updates auto identity fields the same way. No new preload channel is required. `renderer/preload.js` stays as it is.

### Fix and Forget wiring

`forgetIdentity(identity, itemId)` in `host/brain-persona.js` returns `{ identity, removed }`.

- An auto id removes that one row and sets `removed` true.
- An email id, an unknown id, or a missing identity returns the same identity and `removed` false.

`emailBrain:forgetItem` uses that helper. A removed auto row still pushes the existing forget activity (`Forgot one profile row.`). An account email id pushes no activity and leaves `emails[]` as it was. User rules, writing rows, section rows, and voice quotes keep their current Forget behavior.

`persistItemValue` learns identity auto ids. Fix calls the model as it does today (`Rewrite this profile row.`). The host writes the new value onto that auto row and re-slugs the id. A weak nickname result does not write. An account email id fails with `Account addresses stay with the connected mailbox.` and does not change the address. An empty model rewrite still fails with `The model returned an empty rewrite.`

## Error handling and edges

- No AI key, no mailbox, or an empty cache: the host errors above. Do not fabricate identity and do not clear a prior identity.
- Incomplete model identity: keep the prior identity, then merge account emails. Never assign `emails[]` from the model.
- Account list unreadable (`accountEmails === null`): keep prior `emails[]`.
- Weak nicknames: drop them in `isWeakNickname` before they enter `nicknames[]`.
- Multi-account: union every connected account into the one Self graph, deduped by address.
- Gmail send-as cache missing: keep prior send-as rows for that account, and still add primary and explicit aliases. Do not open an OAuth dialog from distill.
- `ownerName` fallback `You` remains on the profile meta when the model and the prior name are both empty. Triage does not present `You` as the owner's name.
- A renamed Needs You category still receives the weighting sentence. The model assigns ids from the categories in the user JSON. v1 does not require the id `needs-you` to exist.

## Testing

Implementation keeps `npm run check` green. That command syntax-checks the Brain and Agent files and runs `scripts/check-brain-persona.js`. The assertions already in that file for refresh and rebuild prompt phrases stay passing. The new identity sentences are added beside them.

`scripts/check-brain-persona.js` covers the pure merge:

- Account lock: a model `emails` list and a model identity that omits a known account address cannot remove it. After merge, the address is still present with `source: "account"`.
- Weak nick drop: `Al` and `ok` are absent from `nicknames[]`. `Ada` is kept. A display name `Al` is kept on `displayNames`.
- Incomplete payload: prior nicknames and orgs remain, and a successful `accountEmails` array still updates emails.
- `accountEmails === null`: prior emails remain, including when the model identity is complete.
- Forget helper: an auto nickname id removes that row. `identity:emails:ada@example.com` removes nothing.
- Prompt fixture: `personaSystemPrompt("refresh")` and `personaSystemPrompt("rebuild")` include the sent-mail-then-inbox identity instruction. `triageSystemPrompt(null)` equals today's triage system text and does not contain `incidental name collision`. `triageSystemPrompt(brief)` contains `Choose Needs You for a direct ask, named responsibility, or a primary action on that owner` and `Do not choose Needs You for FYI, newsletter, or noreply mail when the only reason is an incidental name collision`.

`scripts/check-brain-profile-layout.js` is the UX smoke. It already boots Electron with a stubbed persona. Extend the fixture with `profile.identity` and assert:

- The summary card still shows the owner, emails analyzed, and facts learned.
- `#brain-identity` is collapsed and lists the account email with source `account` and no Forget button.
- An auto nickname shows Fix and Forget.
- Painting a second snapshot whose auto nickname changed (the result of a refresh merge) updates the list text.

That script does not call the model. The refresh behavior of auto fields is the `buildGenerated` refresh case in `check-brain-persona.js`. Run the layout script with the command in its header (`xvfb-run -a npx electron --no-sandbox scripts/check-brain-profile-layout.js`) when a display is available. `npm run check` syntax-checks the file.

`scripts/check-boot-path.js` Brain and Agent assertions stay green, including the profile element order, the hint `Refresh distills the living profile.`, preload channels, and the parity words `ownerName`, `emailsAnalyzed`, `factsLearned`, `nativeAgent:triage`, and `Needs You`.

The implementation PR updates the Profile section of `docs/BRAIN_AGENT.md` and the Email Brain paragraph of `docs/PARITY_SHELL.md` so they describe the identity disclosure. Those edits keep the strings the boot check requires. This design spec does not change them.

## Out of scope

Approach B, a host mention signal, can reuse `identity.ownerName`, `displayNames`, `nicknames`, `emails`, and `orgs` later. v1 does not scan bodies for those strings, does not set `mentionsOwner`, and does not add list or reader chips. This document is the design only. It does not change runtime code.
