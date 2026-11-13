# Make reply quotes part of the editable message

HTML preservation supersedes the original plain-text insertion below; see
[HTML reply quotes](2026-11-13-html-reply-quotes.md). Editor ownership remains unchanged.

Fresh Reply and Reply All previously kept quoted text outside the message editor
and appended it during payload construction. Seeing the original preview did not
let the sender edit or remove what recipients would receive.

Insert the original's escaped plain text into the live rich-text editor, after
the authored reply and signature. Available earlier cached conversation text is
added to that quote. The editor's sanitized HTML is the only outgoing reply body;
the cached original is never appended separately, even after the user clears the
editor or deletes the whole quote. Save, send, scheduled send and frozen previews
share this payload. Saved/recovered content is not rebuilt or extended. Forward
and Bot proposal review retain their existing quote behavior.

Keep the separate original/history pane as a read-only reference, with explicit
copy that it can differ from the edited message. Hide, Show and Collapse affect
only this reference pane. Existing cached-read scope, completeness disclosures,
limits, sanitizer and remote-content gates remain unchanged. No provider grant,
download, read-flag change or automatic AI transfer is added.

While history loads, the initial quote is already editable. Append older text
only when that exact live quote node is still present and unchanged. Typing above
it remains safe. If the quote was edited, deleted or replaced, retain that work
and show a notice that earlier text was not inserted. Closing or replacing the
compose session still ignores late results. Never reconstruct a removed quote
from cached mail during a later signature, suggestion or AI update.

The existing hidden plaintext source remains authored text for AI and signature
handling; it excludes the live quote node. AI writing and suggested reply changes
replace authored text while retaining the user's actual quote node and its edits.
Signatures are inserted before that node. This preserves the existing AI source
boundary instead of silently adding cached earlier conversation bodies as draft
input. The normal selected-source reply context is unchanged. Manually moving
quoted text into the authored portion makes it part of that authored draft.

Production-renderer/JSDOM tests exercise edit/delete/clear, asynchronous history,
AI input and retained quote edits, signatures, frozen send/schedule confirmation,
save and recovery. The Chromium fixture checks actual contenteditable input,
wide/narrow light/dark layouts, reference hiding/collapse, preview, Close and
reopen. All fixtures use synthetic mail and IPC, never a live provider or AI.
