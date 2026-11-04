# Portable email timelines

## Desktop workflow

Open a message and choose **Timeline** beside Summary in the reader action bar.
One sheet offers optional free-text **Keywords** and editable **Contact emails**,
prefilled from that message's From, To, Cc and Reply-To (not Bcc). Both fields guide
the summaries; neither excludes thread messages from the AI request. Empty fields
add no extra focus. The title comes from the subject, output language from the
supported system locale (otherwise English), and display timezone from the system.
There is no Timeline tab, selection/search entry point or mandatory settings wall.

The source is always that opened message's account and ID, plus its already-local
thread, never current list selection or unrelated search results. Opening the sheet
checks downloaded coverage and saved AI permission without making an AI request.
Only **Generate** prepares a fresh, five-minute, window-owned manifest with the
edited focus and starts extraction through the saved AI destination after explicit
action permission. Sources remain frozen for that run. Limits of 1,000 messages /
200 threads are enforced without silent truncation. Expansion means **downloaded**
thread members, not complete mailbox history; no older-mail fetch runs automatically.

Missing, incomplete or warned bodies and unsupported metadata are excluded, with
counts and a conditional explicit partial-coverage checkbox. A run without usable
complete bodies cannot start. Download mail separately in Mail if needed; the sheet
does not download it. Timeline operations never change mail flags, labels or folders
and never send mail. Closing the sheet requests cancellation, including a job still
starting; data already delivered cannot be recalled.

Completed artifacts show a compact result with secondary reviewed export/delete
actions. **Saved timelines** is collapsed history in the sheet, not a permanent
picker or reader panel. Readable HTML, JSON 1.0.0, Markdown and isolated PDF exports require fresh
personal-information, coverage and uncertainty review each time. There is no bot
operation, CLI command, scheduled generation, automatic rerun or URL/webhook export.

Supported output languages remain English, Traditional/Simplified Chinese, Japanese,
Korean, French, German and Spanish. Dates use `Intl.DateTimeFormat` with the system
IANA timezone and locale. Output language and extraction focus do not change public
field names or metadata; focus remains outside the public export schema.

## Public contract

`shared/timeline-schema/1.0.0.schema.json` is the bundled Draft 2020-12 contract.
Its identifier is `urn:morrow-mail:timeline:1.0.0`; it requires no network resolver.
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

The host supplies all dates, addresses, aliases, file names and identifiers. The
model may return only source tokens, summaries, requests and uncertainties.
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
it receives validated summaries, not expanded mail. Final documents are validated
again before one synchronous durable commit.

Requests are sequential. Limits: 32 calls including retries/consolidation,
128,000 conservative input units, 32,000 output tokens, 8,000 conservative input
units per request, up to 4,096 output tokens per call, 120 seconds per request,
10 minutes per job. Input byte counts are conservative estimates, not tokenizer
measurements. Reported provider usage is recorded; missing output usage charges
the reserved output allowance. Providers must honor their output-limit contract.
These are not precise monetary limits. Limits can stop a large selection after
some calls; earlier provider charges cannot be refunded by cancellation.

Cancellation/revocation stops further calls and rejects late output, but cannot
recall already delivered data. Failed, interrupted or cancelled work never replaces
a completed artifact. Restart marks unfinished jobs interrupted and never resumes
AI automatically. No raw prompt/body copies are saved with jobs.

## Privacy, retention and exports

Disclosure version 3 requires renewed explicit-action AI permission for prior
grants, including version 2. Reading permission status does not migrate or approve
an old grant; manual and background use stay off until a fresh affirmative choice.
Manual approval does not enable background use. Preparation and exports need no
model request. Generation uses only reviewed text, subjects, sender/date evidence,
attachment names and optional keyword/contact focus through the existing saved provider plumbing, without Brain,
Agent notes, chat history, tools or automatic provider/billing fallback.
Prompt version `mail-chronology-3` asks for a chronology of the user's
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
