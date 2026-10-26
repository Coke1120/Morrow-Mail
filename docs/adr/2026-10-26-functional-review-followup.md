# Preserve draft files, reviewed sends and message metadata

The independent v0.3.0 functional review reproduced dropped provider-draft files,
send content changing after preview, Gmail charset sync stalls, missing Reply-To,
and calendar dates being cleared by input-type sanitization.

## Decisions

- `mail:prepareDraft` prepares all draft attachment bytes through the existing
  cache, account/message snapshots, request progress and cancellation. It validates
  the complete body, draft revision and 25 MiB outgoing file limit. Only after all
  reads succeed are local blobs committed together. The source draft row and its
  revision are unchanged, so pending scheduled cleanup proofs remain meaningful.
  A failure/cancellation retains the source for retry. Compose and scheduled
  content retain inline content IDs as well as the selected sender name/address.
- Save/Send/Schedule wait for active AI writing to finish or be cancelled. The
  preview captures the complete payload, composition session and content snapshot.
  Confirmation rejects changed content and passes the captured payload through
  send-delay/scheduling paths. It never reconstructs reviewed content after an
  asynchronous dialog close.
- Gmail text decoding uses iconv-lite mail charset aliases. Malformed MIME and
  unknown charsets produce an incomplete-body warning while preserving available
  content. The nullable `messages.body_warning` field keeps that warning after
  restart and exposes it in the reader. Unknown labels use a UTF-8 fallback.
  Network, identity and storage failures are not treated as MIME failures.
- Structured Reply-To addresses are stored in the existing recipient metadata
  JSON, separately from the recipient-delivery evidence used to choose From.
  Complete cached reading stays immediate. Reply preparation refreshes missing
  metadata and blocks a reply if those headers cannot be obtained. Reply/Reply All
  prefer Reply-To, then From, retaining self-address filtering and deduplication.
- Calendar editors set input types before initial value assignment. Type toggles
  copy the previous strings before changing type and assign converted values
  afterward, preserving dates under real HTML input sanitization.

## Validation and limits

`scripts/check-fresh-review-fixes.js` exercises production SQLite, provider
adapters, MIME and renderer functions with synthetic data. jsdom is a development
dependency so calendar tests enforce actual input-value sanitization rather than
using plain value properties. Existing migration, sender-name, attachment,
scheduled-recovery and full-suite checks remain required.

Features/help describes these paths. CLI/bot capabilities and OAuth scopes are
unchanged. Native/rendered validation remains unavailable under the existing
renderer-navigation restriction; fixtures do not establish live-provider or OS
dialog behavior. No mail, OAuth grant or live model/provider request is needed for
the tests.

## Independent review follow-up

Keep the union of iconv mail aliases and TextDecoder/ICU encodings. In particular, ISO-2022-JP must not become an incomplete UTF-8 fallback when iconv lacks it. Only a charset rejected by both decoders receives that fallback and warning. Real MIME/IMAP and Gmail fixtures cover ISO-2022-JP, UTF-8, Windows-1252, cp932, UTF-7 and an unknown label.

Locally generated MIME has known empty Reply-To, even before its Sent copy has a server UID. Sent filing, bot Sent records, draft saves and scheduled recovery persist that value explicitly. The historical unfiled Sent format can be repaired narrowly: complete non-draft body, Sent role, zero UID/UIDVALIDITY and no Gmail mapping, an empty metadata object, Morrow cache-id and RFC-id formats, a bare sender, and an id domain matching the primary account or that stored sender. Desktop sends generated ids from the account; bot sends used the selected From, including different-domain aliases. Current alias settings do not establish historical origin. Fixtures captured from unmodified v0.3.0 production bot/send, submitSmtp, fileSentMessage and noteBotSent paths preserve both conventions without rewriting old metadata by hand. UID zero, folder membership, or a matching From alone does not establish local provenance. Remote API search hits have different cache IDs, provider-fetched records carry transport evidence, and unknown remote rows retain the reply-header gate. Authoritative provider adoption overrides local metadata.

An editor keeps the original full timed values only while an all-day conversion is reversible without guessing: toggling back over the unchanged all-day range restores the exact timed range. Edits to that date range keep the selected dates with explicit timed defaults; a new editor starts without another event's snapshot.
