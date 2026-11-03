# Provider reply/forward indicators and visible mail columns

Mail keeps Date, Recipient, Sender and Subject sorting and adds an unsorted
Reply / forward column. The new column is appended to saved orders. Reordering
uses the complete order, including hidden columns; header keyboard moves use
visible neighbours. Hiding a sorted column preserves its sort and page.

`mailHiddenColumns` is a separate setting in `settings.json`, with exact preload
get/set channels. Absence or invalid input shows every column. Normalization
removes duplicate/unknown names and always keeps Subject visible. The header
context menu and Columns dialog use the same visibility path; the dialog retains
Move left/right, Reset column order, and adds Show all columns. Shift+F10 or the
context-menu key opens the header menu, arrows/Home/End navigate, and Escape/Tab
dismiss with focus return. Native dialog controls offer a touch alternative.
The grid minimum follows the visible columns in both row densities and all
reading layouts. Header focus and drag cancellation retain their existing rules.

`messages.replied` and `messages.forwarded` are nullable integers. Only an explicit
IMAP FLAGS snapshot supplies booleans: `\Answered` and `$Forwarded`, compared
case-insensitively. Full-message reads, source reads, and existing rotating
200-UID flag refreshes carry them into the cache and metadata-only list/search
responses. Status-only writes invalidate the affected list scope without
reindexing bodies or changing sort. Refreshing the displayed indicators preserves
the message button and its focus. Existing validity/account/action guards and
bounded flag scheduling are retained.

NULL means unavailable, including old caches, unsupported transports and local
messages. A positive flag displays its SVG icon with accessible text; both can
appear. A blank known cell means neither flag was reported, not proof that no
reply or forward occurred. A dash denotes unavailable state. Server/client support
and cached refresh timing limit completeness. A large folder can need several
sync passes to refresh older flags. Gmail API exposes no corresponding message
fields; the normalized state is NULL and reviewed migration to Gmail API clears
old IMAP assertions. We do not request another transport, scope or provider write.

Morrow's send paths currently do not set these flags. Creating/opening a reply or
forward, queueing a send, subject prefixes, In-Reply-To, thread membership and
Sent copies are not substituted for provider evidence. Supporting confirmed local
send receipts across immediate, queued, partial and uncertain delivery is separate
future work; this column does not claim that history.

The All Account Mail Outbox Recipient bug came from a representation mismatch:
`publicScheduled` formats To as a string, `outboxEmails` retains it, and the mail
column previously accepted arrays only. The renderer now accepts both the saved
string and downloaded recipient arrays. It does not split quoted display names
or substitute CC/BCC for an empty To field. Queue summaries remain body-free and
the saved content, delivery order and transport paths are unchanged.

The list toolbar now establishes a stacking context above the sticky column
headers. Sync's existing hover/focus scroll panel therefore paints over the
headers in right, bottom, separate-window and narrow responsive layouts.

Primary protocol references: [IMAP system flags](https://www.rfc-editor.org/rfc/rfc9051.html#section-2.3.2),
[IANA IMAP/JMAP keywords](https://www.iana.org/assignments/imap-jmap-keywords), and
[Gmail Message resource](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages).

Synthetic validation and native/live-provider limits are recorded in
[the verification evidence](../testing/mail-status-columns/README.md).
