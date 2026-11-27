# Compose find and replace

Find operates on local text in the editable Compose body, excluding the signature,
quoted history, non-editable blocks and other fields. Adjacent inline text can
form a match; paragraph boundaries, line breaks and images stop a match. The
active match is highlighted without inserting elements into the draft.

Replace writes literal text into a clone of the current editor markup. It then
uses one Chromium editing transaction, including for Replace All. This preserves
surrounding rich content and native undo/redo while the existing Compose input
path updates save and preview state. It adds no provider or AI request. Closing
Compose clears the search. Search and replacement fields are bounded and Replace
All is unavailable for more than 2,000 matches.

Use the platform command modifier for Find and Replace. On macOS only a focused
Compose window passes unmodified Command+H (without Shift, Control or Option) to
the renderer instead of its native menu accelerator; other windows keep Hide.

Run the synthetic native-window check using
`electron scripts/check-compose-window.js --find-replace`.
