# Include cached earlier messages in fresh replies

The outgoing quote now lives in the editable Message field. The original pane
is reference only; users can remove or change outgoing quoted text. See
[editable reply quotes](2026-11-11-editable-reply-quotes.md) for the superseding
editor ownership, asynchronous loading and AI boundaries.

Fresh Reply and Reply All previously carried only the selected source message.
If that message did not quote the previous exchanges, the separate compose
window and its outgoing quote omitted them.

Compose now reads source-account/thread headers and earlier cached bodies through
the existing read-only IPC. It captures the source identity before loading,
checks mailbox epochs and ignores results after closing or replacing compose.
Only members before the selected source are considered. Gmail folder copies use
the host's existing provider-identity deduplication; drafts, foreign rows and
newer messages are excluded. The source remains the AI input, recipient source
and reply target. This change does not automatically send earlier messages to AI.

The history pane and outgoing quote use the same selected/cached text. Existing
attributed text already quoted by a newer included message is not appended a
second time. This conservative exact-text check is not a universal parser for
every mail client's quotation format; embedded quoted chains are preserved.
Distinct deliveries with identical unquoted bodies are retained.

No body is downloaded or marked read by preparation. Missing bodies remain
labelled metadata, and their snippets are never substituted into the reply.
Partial/uncertain text is labelled. Additional history is limited to the nearest
100 earlier messages and 2,000,000 content characters, counting retained cached
HTML/plain text and outgoing quote strings. Omitted counts are shown; the source
is not truncated. Header enumeration uses the existing complete local-thread
query; lazy header paging is unchanged. Save/send/schedule remain disabled during
initialization, while typing and Close continue to work.

Quotes are plaintext-escaped in outgoing HTML. Received HTML uses the existing
mail sanitizer and remote-image policy in the history pane. Earlier attachments
are not added. Resumed drafts and recovered scheduled content are not rebuilt or
extended, preserving exactly the saved message.

`scripts/check-reply-history.js` exercises actual renderer/DOM behavior, payloads,
source scoping, repeated/hide-show operations, asynchronous typing/close races,
missing and incomplete bodies, limits, attributed quotes and hostile HTML.
`scripts/check-compose-window.js` exercises the separate Electron window and
preload bridge using synthetic messages and no user accounts or provider writes.
Optional `scripts/check-reply-history-browser.js` uses a fresh sandboxed Chromium
profile, synthetic IPC and loopback-only requests. It checks wide/narrow layouts,
light/dark themes, scrolling, collapse/hide/show, outgoing preview, and Close /
Keep editing / Discard / reopen. Set `MORROW_PLAYWRIGHT_MODULE` and
`MORROW_CHROMIUM` when those tools are outside the checkout.
