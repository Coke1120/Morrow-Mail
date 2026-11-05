# Reviewed case timelines across downloaded threads

Status: proposed in the Case Timeline draft PR. Extends the reader-sheet ADR;
the existing single-thread path and immutable public schema 1.0.0 remain supported.

The supplied email-timeline design describes a case/client workflow: search several
threads, distinguish the main case from background, and report status, follow-ups
and gaps alongside chronology. A prompt-only change cannot broaden source coverage
or establish provenance. Add Case mode to the same sheet with local search,
accumulated explicit selections, per-message Main/Background choices and a separate
source/coverage/destination review before Generate. Freeze only selected messages;
do not expand selected threads or silently include search results.

Bind Case mode and searches to the opened message's current account through the
owner-bound source proof. Use the existing token-prefix local index and disclose
its body-index and query caps, lack of To/Cc or Gmail syntax support, omitted bodies,
undownloaded mail and other sources. Count limited search rounds without exporting
queries. No search can establish mailbox completeness. No live user mail is used
in implementation or tests.

Retain per-message extraction and host-owned mail dates. Under the same sequential
call/usage/output/time/cancellation budget, synthesize a separate bounded case
report from validated summaries. Each point requires included source UUIDs and
uncertainty; mentioned dates are attributed text distinct from mail time, checked
against a cited original body during generation. Large reports reduce at semantic
item boundaries with date/phase provenance retained, never by silently dropping input.
Report sections are capped at 12 points; they are an overview for review. No follow-up
is automatically checked off. Silence, unread state and absent replies do not prove
completion or outstanding work. AI interpretation and summaries need human checking.

Keep independent To/Cc and alias headers in local evidence. Supplying recipients to
AI would require a separately reviewed category/prompt/consent change; do not imply
the model independently saw them. Existing body text and focus can contain addresses.
Version 4 disclosure explicitly covers cross-thread synthesis and selected phases;
older grants require a new affirmative manual choice, with background still separate.

Add a local plain-text evidence reader. Saved source membership, opaque identity and
captured fingerprints must match; changed/deleted mail is unavailable. Never call the
normal engine-open path, mark read, load remote content or fetch a missing body.

Publish schema 1.1.0 separately with case report/scope and optional event phase. Keep
the exact version registry and semantic citation checks, preserving old stored results.
All four reviewed file exports retain case sections, scope, uncertainty and source IDs;
only the application offers cached source opening. Portable files contain no executable
links or account/provider IDs. No Canvas service, fixed mailbox or timezone is copied.

This work does not merge, release, change mail flags, extract attachments, create
provider queries or enable scheduled/automatic generation. Native platform rendering,
actual PDF pagination and live model quality require separate validation.

Case mode remains available if initial thread capture exceeds source-byte or
message-count limits. A separate body-free context snapshots only the opened
message fingerprint and account incarnation, without expanding its thread. It
authorizes cached search in that account, never generation or download. The
selection starts empty after failed thread capture; explicit smaller selection,
review, current source proofs and AI confirmation are still required. Contexts
retain the same owner, expiry and account/source change checks.
