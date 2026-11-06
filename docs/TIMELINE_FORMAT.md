# Portable email timelines

## Desktop workflow

Open a message and choose **Timeline** beside Summary. The default **This downloaded
thread** mode preserves the lightweight chronology of that message and its locally
stored thread. The reader, list selection and current Mail search are unchanged.

**Case / client across threads** starts with those downloaded sources in the same
account. Search local mail, add relevant messages over several search rounds, remove
unneeded sources and choose **Main** or **Background** for each. Every local query
word must match a token prefix in subject, sender or indexed body (first 200,000
characters per message). There is no Gmail query syntax, recipient-header search,
server search or automatic download. Up to 100 results are shown per query, with
limited queries flagged; the underlying query stops after 1,001 rows, before
provider-copy deduplication. Refine broad queries and search variants separately.
Neither successful search nor the selected messages establish exhaustive coverage.
Undownloaded mail, other accounts, calls and attachment contents remain outside scope.

Case mode uses exactly the checked messages, without automatic thread expansion.
Choose **Review selected mail**, inspect the selected/included/omitted counts and AI
destination, accept any omissions and affirm the separate review checkbox. Only
**Generate** transmits data. Changing selection, roles, focus or running another
search clears case review. The host requires an owner-bound existing account proof,
explicit phases, the current account only and a reviewed frozen source manifest.
There is no automatic regeneration after a source change or failure.

Optional keywords and contact emails (prefilled from the opened message's From,
To, Cc and Reply-To, never Bcc) guide extraction without filtering or discovering
sources. AI receives reviewed body text/quoted history, subject, sender, mail dates
and provenance, attachment names, optional focus and case Main/Background choices.
Independent To/Cc and alias headers remain local evidence; body and focus can still
contain these addresses. The report cannot independently establish routing identities
that were not supplied to the model. Title, supported language and display timezone
follow the opened subject/system; Case title can be edited. No fixed mailbox, Canvas service or timezone is used.

Case results add cited **Current status**, **Follow-ups for review**, **Unresolved
gaps** and **Mentioned events and deadlines**. All generated points require selected
source references and explicit uncertainty. No task is automatically checked off;
unread, missing replies and silence do not establish incomplete or completed work.
The report is a bounded AI synthesis of validated per-message summaries, not an
independent audit of raw mail or a completeness guarantee. Each overview section has
at most 12 points. Human review remains necessary for claims and contradictions.

The full per-message correspondence chronology remains available under All / Main /
Background filters. Its dates are mail timestamps, not mentioned event/deadline dates.
Mentioned dates remain attributed text with uncertainty, never normalized calendar
entries. During generation a reported date must occur verbatim in at least one cited
original body; that check establishes provenance, not the meaning or correctness of
the date. Missing dates stay missing rather than using today's date.

**Read cached source** opens text-only local mail with recorded From/To/Cc and date
provenance. It makes no provider request, model call, attachment read or mark-read.
For saved results the host verifies membership, opaque identity and the captured
fingerprint. Changed/deleted sources show unavailable rather than silently replacing
historical evidence. HTML and remote content are not rendered.

Opening/preparing the sheet creates a five-minute window-owned source proof without
using AI. Sources/accounts are revalidated before calls and before saving. Missing,
incomplete, warned or unsupported messages are omitted with explicit acceptance;
no usable complete bodies means no generation. Limits of 1,000 messages / 200 threads
are ceilings, and lower input/call/output/time budgets can reject smaller selections.
The estimate covers initial extraction only. Case synthesis, bounded reductions and
one validation retry per step share the same total budgets. No report is saved after
a failed/cancelled run. Attempted call counts disclose possible prior transmission.
Retry is explicit and may send reviewed mail again. Closing requests cancellation,
including a still-starting job; already delivered data cannot be recalled.

Saved history remains local in the sheet. Every HTML, Markdown, isolated PDF and
public JSON export requires fresh personal-information, coverage and uncertainty
review. Thread results retain schema 1.0.0; Case results use 1.1.0. Existing results
remain readable/exportable. Account removal still deletes every related local
artifact; exports, backups and historical journal bytes remain. There is no bot or
CLI operation, scheduled generation, automatic send or URL/webhook export.

Supported output languages are English, Traditional/Simplified Chinese, Japanese,
Korean, French, German and Spanish. Dates use the system IANA timezone and locale.

## Public contract

`shared/timeline-schema/1.0.0.schema.json` is the immutable original Draft 2020-12 contract.
Case capability is bundled separately in `shared/timeline-schema/1.1.0.schema.json`.
Their identifiers are `urn:morrow-mail:timeline:1.0.0` and `urn:morrow-mail:timeline:1.1.0`;
the exact local registry never uses a network resolver.
JSON exports contain exactly the validated public document, never a local wrapper.
Consumers must select an exact supported `schema_version` from their own bundled
registry, not resolve the input's `$schema` over the network.

The envelope requires `$schema`, `schema_version`, `timeline_id`, `source_namespace`,
`generator` (name/version), `generated_at`, `title`, `display_timezone`,
`time_basis: "mail_timestamp"`, `coverage`, `source_threads` and `events`.
Coverage records selected, included and omitted message counts and
`selection_truncated`. This producer refuses truncation. Each source thread has an
opaque `thread_id` and its selected message count, including omitted sources.

Each source message has exactly one correspondence event:

| Field | Meaning |
| --- | --- |
| `event_id` | UUID for this extraction's event, not a mail identifier |
| `source_thread_id` | Reference to a declared opaque thread UUID |
| `source_message_id` | Stable opaque UUID within the producer namespace |
| `occurred_at` | Mail timestamp with `Z` or offset; `null` when unknown |
| `date_source` | `header`, `received`, `cached_unknown` or `unknown` |
| `from` | `{address, name?}` or `null` |
| `to`, `cc` | Arrays of recorded `{address, name?}` mailboxes |
| `via_alias` | A uniquely evidenced local identity address, otherwise `null` |
| `summary` | One-line generated summary, at most 500 characters |
| `attachments` | File names only, never attachment bytes or paths |
| `open_actions` | Up to 25 requests/unresolved items for human review, not tasks |
| `unclear` | Up to 25 uncertainties; no inferred resolution from later silence |

The host supplies all chronology dates, addresses, aliases, file names and identifiers.
Per-message extraction returns only source tokens, summaries, requests and uncertainties.
Case synthesis separately produces only the validated cited report fields described below.
Mentioned past/future dates remain in semantic text; they never replace mail time.
New IMAP and Gmail reads save header/received/unknown provenance. Older cached
timestamps are explicitly `cached_unknown`; synthetic or invalid dates are `null`
with `unknown`, never replaced by the current time for timeline purposes.

`source_namespace` is a random persistent UUID, not a hardware ID or an address.
Source UUID mappings use account creation identity plus a reliable same-account
provider message identifier, otherwise the local message identifier. Only reliable
Gmail label copies are deduplicated; matching RFC Message-ID alone never proves two
deliveries equivalent. Pending local drafts remain distinct. RFC identifiers and
account/provider details stay local. Opaque IDs are **not** proof of authenticity.
Every completed generation creates a new artifact; regeneration does not silently
replace an older result. Exporting the same artifact preserves its IDs and revision.

Validation uses strict Ajv 8 plus `ajv-formats`, without coercion, removal of unknown
fields or remote references. Semantic checks cover supported IANA zones, unique
events/messages/threads, source references, date provenance and count equations.
All objects reject unknown fields. JSON is limited to 2 MiB UTF-8, 16 nesting
levels, valid UTF-8 and unique object keys. No body, HTML or open-ended extension
bag is permitted. Unsupported attachment metadata causes a visible omission rather
than silently rewriting its evidence.

Schema 1.1.0 retains the original envelope and event fields. It adds optional event
`phase: "main" | "background"` and paired `case_report` / `case_scope` capabilities.
This producer requires phases on all case events. Case scope records `local_only`,
`account_count: 1`, `search_count`, `limited_search_count`, `mailbox_complete: false`
and `search_is_exhaustive: false`. No raw search queries or local account IDs are
exported. A report contains `current_status`, `follow_ups`, `gaps` and `dates` arrays;
each point has bounded `text`, mandatory `uncertainty` and 1–25 unique, validated
`source_message_ids`. Date points also have `kind: "event" | "deadline"` and
`date_text`. No completion boolean or executable task is accepted. References must
belong to included source messages; arbitrary model links and extra fields fail.

## Version policy

- Schema and application versions are independent. Published schema files are
  immutable; publish a new file for every new schema version.
- Patch releases only correct documentation/annotations, never validation rules
  or field semantics.
- Minor releases add optional capabilities. New consumers retain old schemas.
- Major releases change required fields, identity/date semantics or cardinality.
- With `additionalProperties: false`, older consumers need not accept an unknown
  minor version. Reject it as unsupported instead of ignoring new fields.
- Consumers should vendor reviewed schema bytes with a checksum and use an exact
  local version registry. They must repeat semantic and size checks themselves.

## Extraction and limits

Messages are ordered deterministically, divided at message/paragraph boundaries
and, only when necessary, within a long paragraph without splitting Unicode pairs.
Every part keeps its source token. There is no extra source identity for overlap.
Each extraction must return exactly the supplied tokens once. Invalid JSON,
unknown properties, missing/forged tokens or incomplete output receive at most one
validation retry per step, using fixed error paths/codes rather than model text as
instructions. Part summaries are deduplicated and combined. A bounded model
consolidation is used only if the combined structured text exceeds field limits;
it receives validated summaries, not expanded mail. Large semantic arrays are split
at item boundaries and reduced in bounded stages using the same complete request
limit, without silently dropping items. A non-compacting reduction stops. Final documents are validated
again before one synchronous durable commit.

Requests are sequential. Limits: 32 calls including retries/consolidation,
128,000 conservative input units, 32,000 output tokens, 8,000 conservative input
units per request, up to 4,096 output tokens per call, 120 seconds per request,
10 minutes per job. Input byte counts are conservative estimates, not tokenizer
measurements. Reported provider usage is recorded; missing output usage charges
the reserved output allowance. Providers must honor their output-limit contract.
These are not precise monetary limits. Limits can stop a large selection after
some calls; earlier provider charges cannot be refunded by cancellation.

The 128,000-unit budget also bounds the complete cached source text. Fragments are
at most 4,500 serialized bytes and eight fragments per extraction request. These
budgets can reject selections smaller than the 1,000-message / 200-thread ceiling;
headers, attachment names, repeated quoted history and UTF-8 text all consume space.
No model-context-size setting overrides these application limits.

Failure diagnostics contain only an allowlisted limit name, numeric usage/limit
and the number of AI completion calls attempted. Zero attempts means no AI call
started for that attempt. A positive count means data may already have reached the
saved provider; it is not a receipt proving delivery. Preparation never calls AI.
Messages, addresses, prompts, credentials and raw provider errors are not included
in these diagnostics. Failed or cancelled jobs save no partial timeline.

Cancellation/revocation stops further calls and rejects late output, but cannot
recall already delivered data. Failed, interrupted or cancelled work never replaces
a completed artifact. Restart marks unfinished jobs interrupted and never resumes
AI automatically. No raw prompt/body copies are saved with jobs.

## Privacy, retention and exports

AI permissions are scoped to unchanged ordinary actions, Thread Timeline, Case and
background processing. Verified version 1/2 grants retain ordinary uses and their
explicit background choice; current expanded Thread Timeline and Case remain off.
Verified version 3 additionally retains Thread Timeline; version 4 retains Case.
Unknown, corrupt, revoked or differently bound grants allow nothing. Reading status
does not write a grant or approve expanded uses. Expanded scopes need an explicit
choice at the saved destination; unchanged scopes survive app updates.
Manual approval does not enable background use. Preparation and exports need no
model request. Generation uses only reviewed text, subjects, sender/date evidence,
attachment names, optional keyword/contact focus and Main/Background selections through the existing saved provider plumbing, without Brain,
Agent notes, chat history, tools or automatic provider/billing fallback.
Prompt version `mail-chronology-5-case-1` asks for a chronology of the user's
currently selected mail in the current mailbox account (no named person or fixed
inbox), treating focus as topics rather than instructions or additional evidence;
the host still owns dates, addresses and opaque IDs. Generated
text remains untrusted: the UI uses text nodes, Markdown escapes syntax/HTML, and
PDF uses a separate scriptless, network-blocked sandbox with escaped text.

Provider retention/training depends on the selected service, configuration and
agreement. A loopback endpoint may forward data. `store: false` on the ChatGPT
adapter is not a no-retention guarantee. Existing API keys remain in the existing
local configuration; file permissions are not secret encryption. This feature adds
no new credentials or secret-storage claim.

Validated artifacts, opaque mappings, source hashes/links and bounded job metadata
live in the existing journaled `mail.sqlite`, not in Agent/Brain memory. New tables
and the source-account index are provisioned and checked at startup; ordinary mail
admission and synchronous transaction rules are unchanged. Older mail remains
readable, with unknown legacy provenance. Removing an account deletes all local
artifacts linked to it, including multi-account artifacts, and invalidates its jobs
and manifests. Explicit artifact deletion removes its source links. Stable opaque
mappings remain for future extractions until account removal. There is no automatic
retention timer. Local artifacts are not end-to-end encrypted by this feature.

Before each HTML, JSON, Markdown or PDF save, review addresses/names, attachment names,
summaries, omissions and uncertainty and affirm the export checkbox. The host uses
a native save dialog, never a renderer-provided path. Exports do not run AI and
are never automatically transmitted. Deletion does not erase exported files,
backups or historical journal bytes. Webhook/URL delivery is deferred.

## Verification

`npm run test:timeline` runs synthetic schema, chunk/merge, source, orchestration,
provider-contract, export isolation, SQLite lifecycle, preload and rendered-tab
checks without live AI, credentials, user mail or the Electron GUI. `npm run check`
runs the existing regression suite plus the timeline checks. PDF text/CJK escaping,
wrapping/pagination styles and sandbox options are tested synthetically; native
font availability, actual pagination and PDF save behavior on Windows and macOS
still require manual platform validation before a release.

HTML export is a standalone, responsive, printable chronology, oldest first with
undated mail last. It includes coverage, timezone, uncertainty and source references,
without raw bodies, internal account IDs, credentials or the private focus fields.
All mail and model text is escaped; there are no scripts, links, images, external
resources or forms. The same HTML layout is used for isolated PDF printing.
Routine account refresh notifications revalidate the window-owned host manifest,
rather than invalidating the renderer source. Host incarnation, credential and
source-fingerprint checks still reject real changes before AI calls and saving.

Case synthesis receives validated semantic rows, sender/date evidence and selected
phases, without independent recipient headers. Large overviews are reduced at
semantic-item boundaries, with source references and mail-date/phase context
preserved. Every source summary/request/uncertainty is admitted; no input row is
silently dropped to fit a request. Non-compacting reductions stop. Repeated summaries
can still omit important nuance, so the full source-linked chronology stays available.
Synthetic checks cover case review, account isolation, capped search, forged citations,
revocation, exports and stale UI responses. Native Windows/macOS layout, live model
quality, actual PDF pagination and real-provider behavior remain manual validation
limits; development never uses actual user mail or live model calls.

## Provider output validation

Each extraction, long-message consolidation or case step has at most one validation retry. Fixed feedback distinguishes JSON formatting, schema/text limits, source-reference failures and incomplete responses. It never includes raw output, mail, offending values or schema paths. Consolidation must synthesize a new summary of at most 500 characters rather than concatenate parts. A single whole-response JSON fence is accepted for provider compatibility; duplicate keys, extra prose, extra fields, missing/forged sources and incomplete responses still fail. Portable artifact imports retain strict JSON parsing. No unsupported structured-output parameters are sent to custom providers.

All attempts retain the existing call, input, output and time limits. Failed jobs preserve earlier saved timelines. A user-initiated retry revalidates and resends the reviewed mail; failures never start a new run automatically. These diagnostics identify a validation category, not the exact cause of an earlier incident.
