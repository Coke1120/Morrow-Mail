# Safe HTML in send previews and Outbox

Preview Send used the hidden plain-text composer field while the confirmed
payload contained HTML. Outbox retained that HTML but displayed a regex-derived
plain-text copy. Both lost lists, links, tables and signature formatting; some
queued HTML entities appeared verbatim. Outbox also hid attachment metadata.

The compose preview now paints the captured payload used by confirmation, rather
than the live editor or its plain-text cache. Metadata and attachment names come
from that same snapshot. Existing composition/session checks still refuse a
changed message; Cancel remains inert. Scheduled previews use the same path.

Both send-preview surfaces reuse `appendMessageBody` and its allowlist sanitizer.
HTML uses the existing mail layout and normal whitespace; genuine plain-text
fallbacks remain text nodes with preserved line breaks. Empty bodies are labelled.
Scripts, handlers, frames, active URLs and unsupported CSS are filtered without
weakening CSP or admitting unsanitized markup into the visible document.

Remote image, CSS-background and table-background URLs remain blocked even when
received-mail images or a reader's per-message permission are enabled. These
local previews previously made no remote-content requests; changing body layout
must not introduce tracking requests. A note explains blocked images. This change
adds no remote-content opt-in or stored permission. Embedded raster data images
remain supported; unresolved CID sources retain their safe fallback.

Outbox keeps its scheduled-send ID, account, status, Undo and delivery boundary.
Opening or repainting a queued item neither sends it nor extends its delay.
Files display as names and sizes only. Mailbox attachment actions require a
`messages` identity and are not attached to a `scheduled_sends` ID. No new provider
or local-blob read path is introduced.

The sent quote remains the escaped plain-text quote already in the captured
payload. Showing the original rich source instead would misrepresent the send.
The sanitizer and recipient clients can render differently; this is a safe view
of the reviewed content, not a promise of pixel-identical delivery.

Validation uses actual renderer functions and HTML parsing with synthetic drafts
and queue rows: rich/plain/empty content, entities, quoted text, frozen metadata,
changed-message refusal, Cancel, send/schedule capture, queue status/account
changes, inert attachment metadata and filtering with received images enabled.
The Features tab and preview help are exercised against the rendered catalog.
Headless Chromium checks cover blocked external requests, keyboard scrolling,
light/dark themes and narrow widths. Native Electron, real providers, attachment
files and recipient-client rendering require separate validation.
