# Simple summaries and reviewed long-message coverage

The Summary panel shows one main point and up to six flat bullets. Subject,
sender, mailbox and data-use information move into a native Details disclosure;
AI attribution, errors, cancellation and actual coverage warnings stay available.
The host validates a small JSON object and the renderer creates paragraphs and
list items with text nodes. Model HTML, Markdown links and images never become
active content. English prompts use ASD-STE100-inspired short, active, consistent
language, while keeping necessary terms, exact source amounts/dates, attribution,
conditions and uncertainty. This is a style goal, not verified formal compliance.
Other languages keep the existing same-language behavior. Synthetic tests do not
establish model factual accuracy or linguistic compliance.

This supersedes the fixed-prefix and plain-text presentation decisions in
[the original Summary ADR](2026-11-03-message-summary.md). The old 24,000 UTF-16
unit prefix was an app bound, without a measured relationship to the selected
model's context window. Raising it alone would neither establish context fit nor
make omitted evidence safe. Summary now prepares a local coverage plan from the
authoritative selected cached message, without making any AI request. A message
that needs multiple requests, exceeds the old prefix or has incomplete download
coverage requires an explicit choice of all downloaded text or a labelled excerpt.
The review names the saved destination/model, Unicode-character coverage and full
run request count. A full run that cannot fit is unavailable; it never silently
falls back to an excerpt. An excerpt is at most the old 24,000 units, reduced to fit
one serialized request and a Unicode boundary; its actual included/omitted
character counts are disclosed before sending and with the result. Downloaded
text means the readable trimmed body, not a promise that the complete email or
thread was downloaded. Missing/unsupported bodies still require a body download.

Plans are random, single-use, expire after five minutes, belong to their originating
webContents and bind request/account/message/connection identity, source content
fingerprint and saved AI-consent stamp. Preparation checks manual AI permission
but grants nothing. Summarization must consume that plan and explicitly accept
expanded or partial coverage. Navigation, cancellation, account invalidation and
window close retire plans/work. Both source content and permission are checked
before each AI request and after each result; reapproval does not revive an old
plan or queued operation. No original renderer-supplied body is trusted.

All reviewed parts are split at Unicode-safe boundaries, preferring line endings.
Each part has an ordered summary. Pairwise consolidation includes every part and
keeps each request bounded; no intermediate result is displayed as a complete
summary. The full run accepts at most 128,000 source UTF-8 bytes and 31 calls,
including consolidation. Each request has at most 16,000 serialized UTF-8 input
bytes; the run allows at most 512,000. Each call requests 1,200 output tokens and
accepts at most 6,000 output bytes. The existing detailed transport bounds response
buffering and requires a confirmed complete API/ChatGPT response; invalid, empty,
oversized or failed output ends the run visibly, without automatic retries.
Per-request deadlines are two minutes and a multi-request job has ten minutes.
Cancellation settles even if a provider ignores its signal. These constants are
conservative local budgets, not token/context measurements or an exact cost
estimate. A custom endpoint or selected model may reject a smaller request. A
larger source or serialized-input/call-budget excess requires an explicitly chosen
excerpt; changing provider/model never happens automatically.

The outbound categories and purpose remain selected cached sender/subject/date,
message text and its quoted history for an explicit answer, through the approved
saved AI destination. No other messages, Brain, Agent context, attachment files,
attachment names or linked-page contents are added, and no older mail is fetched.
The existing disclosure version 3 and separate background choice remain. The
per-action full-text review makes the expanded quantity explicit. Results remain
in the originating window's memory and never become drafts, mail changes, bot
capabilities or CLI operations. Cancellation cannot recall already delivered data.

Checks use synthetic mail, temporary consent/store files and mocked providers.
They exercise the real transport, mail-engine lookup, preload and both renderer
roles, Unicode/long coverage, cross-window and stale-plan fences, mid-run consent
and source changes, cancellation and deadlines. Browser evidence covers layouts,
light/dark themes, narrow readers, native bullets, review choices, keyboard access,
coverage notices and scoped axe checks. Native Windows/macOS, real provider
compatibility/usage/quality and assistive-technology behavior remain unverified.
