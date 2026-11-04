# Reader-owned timeline sheet and inline mail flags

Status: accepted. Supersedes the reader-tab workflow in the selected-mail timeline
ADR and the standalone status column in the mail-status/visible-columns ADR.

Keep a single Timeline entry in the opened message's action bar, beside Summary.
Capture that message's account and ID rather than deriving context from selection,
search or a later reader change. Expand only its locally stored thread. Use a
native modal dialog so keyboard shortcuts and Separate window layout remain
independent of timeline state. Default title, supported output language and display
timezone from the subject/system; show only optional keywords and editable contact
emails on the normal path. Contacts come from From, To, Cc and Reply-To, not Bcc.

Keywords and contacts guide extraction without authorizing addresses, inventing
participation, searching unrelated mail or excluding thread messages from AI
transfer. Disclose that distinction beside the fields. Bind validated focus to the
host's frozen manifest and keep it outside immutable public schema 1.0.0. Preserve
explicit-action AI consent, bounded extraction, conditional explicit acceptance of
omissions, cancellation and reviewed local exports. Saved results are secondary
history inside the sheet, not a permanent reader surface.

Remove the Reply / forward column from canonical and saved column normalization.
Keep provider flags and their in-place refresh, but render only reported positive
icons immediately before Subject. Unavailable or absent flags occupy no space;
neither implies that a reply or forward did not happen. Subject remains mandatory.
