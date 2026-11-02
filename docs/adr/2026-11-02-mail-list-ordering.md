# Mail list columns and ordering

The mail list exposes Date, Recipient, Sender and Subject in Inbox, Drafts, Sent,
other cached folders and All Account Mail. A repeated header activation reverses
direction. The device-local `morrow.mailListSort` preference defaults to Date
descending, following existing local shell preference storage. It contains no
message content. Changing order returns to page one, clears pagination cursors,
retains the reader, and retains selection only for messages present on that page.
The existing page filter remains a filter of loaded rows.

Ordering belongs in SQLite before LIMIT/OFFSET, including each mailbox branch
and the combined result for aggregated folders. Search also orders all matching
downloaded messages before its existing 100-result cap. Provider mail outside
the downloaded cache is not part of these results. The SQL field/direction are
allowlisted; caller strings cannot become SQL fragments. No schema migration or
new indexes are introduced. Date descending keeps the existing indexed keyset
cursor. Other orders use the existing offset path; a date cursor is rejected for
them. New text sorts examine matching headers, so large-cache costs differ from
the indexed default (see the synthetic benchmark).

Date uses `list_sort_ts`, the existing stored message timestamp, with `date_iso`
shown in the user's display format. Local drafts use their save timestamp; this
is not a separate delivery date. Missing/invalid display dates stay blank.
Recipient displays the complete To list, with truncation and a full tooltip,
and sorts by its first entry; Cc/Bcc are not substituted for To. Sender sorts by
saved display name if available, otherwise cached From text, while the cell
shows the full sender preview. Subject sorts as stored. SQLite NOCASE provides
ASCII case-insensitive text ordering; non-ASCII text follows SQLite's binary
ordering rather than locale collation. Empty text sorts first ascending and
last descending. Equal keys use the unique message ID in the same direction,
providing deterministic ties even across accounts and pages.

The headers share the rows' horizontal scroll area and stay visible vertically.
Native header buttons support Enter and Space, display direction, and expose
`aria-sort` on column headers. Existing native message, selection and action
buttons remain intact; compact and comfortable density remain available.

Outbox is a separate paginated scheduled-send store and retains scheduled order;
its columns are visible but disabled, rather than sorting a partial queue.
This change does not alter provider synchronization, sending, versions or release
workflows.
