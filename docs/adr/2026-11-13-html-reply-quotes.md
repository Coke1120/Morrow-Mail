# Preserve safe HTML in editable reply quotes

Fresh Reply and Reply All should quote the available original message's safe HTML
formatting inside Message, rather than always flattening it to plain text. This
extends the editable-quote ownership established in the November 11 decision; the
editor remains the sole outgoing body authority. Deleting or editing the quote
must not restore the cached original at save, preview, send, or schedule time.

Use the existing received-mail/compose sanitizer, with remote content disabled
regardless of permissions in the read-only original pane. Do not copy untrusted
markup directly into the editor. Unsafe active content, external styles and
remote images/backgrounds are not loaded. This is preservation of the supported
safe HTML subset, not a pixel-perfect reproduction of arbitrary email HTML.

Apply the same safe HTML handling to available earlier cached history, sanitizing
each message in an isolated subtree. Stop quoted CSS application after a
250,000-character application budget per message and disclose text fallback; count
sanitized output against the existing additional-history budget.

Use escaped plain text when usable HTML is unavailable. Preserve captured-source
identity, bounded cached-history reads, late-result ownership and the guard that
only an untouched live quote can be extended. Earlier history does not become
authored AI input. Signatures and AI edits retain the user's actual edited quote.
Saved drafts and scheduled recovery remain their saved content. Forward behavior
is unchanged. No new provider read, scope, remote-content grant, or bot action is
introduced.
