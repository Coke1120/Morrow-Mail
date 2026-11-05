# Mail text decoding and cached recovery

Synthetic Big5/GB18030 and Japanese mail reproduced long runs of replacement
characters while ASCII numbers survived. Correctly declared encodings worked.
Gmail's charset regular expression additionally matched quoted unrelated
parameters and ignored RFC2231 continuations, corrupting otherwise valid MIME.

Gmail now parses MIME parameters with libmime, the same parameter parser used by
the existing IMAP MIME stack. The direct libmime and mailsplit dependencies pin
the versions already in the lockfile. Inline Gmail base64url data uses the same
canonical, bounded validation as downloaded attachments/raw MIME; malformed data
cannot silently become a complete body. Gmail part bytes are not transfer-decoded
again. Raw IMAP MIME retains MailParser's transfer/charset decoding.

## Download status and decoding diagnostics

`messages.decoding_json` is nullable. Version 1 stores fixed booleans only: loss,
unsupported charset, uncertainty in already-decoded headers, loss in HTML/plain
parts, the presence of a checked readable plain part, and ambiguous multiple body
alternatives. It stores no text,
charset labels, addresses, raw bytes or telemetry. Existing caches are not
scanned or invalidated at startup. No credential, provider-write or OAuth path is
added. A future version must treat unknown diagnostic versions as unverified.

Gmail checks charset conversion while decoding part bytes. IMAP makes a bounded
diagnostic pass with mailsplit's public transfer-decoded leaf streams over the
already capped source; attachments and embedded-message bodies are excluded.
The parser, source caps, HTML sanitizer and remote-image gates are retained.
An unknown charset uses the existing UTF-8 fallback with disclosure; no Big5,
GB18030 or Japanese encoding is silently guessed. Valid literal U+FFFD is not
classified as loss merely because the decoded body contains it. Already-decoded
headers can establish uncertainty rather than the original byte-level cause.

`body_complete` continues to describe the download. A complete body with a
deterministic decoding notice does not cause repeated automatic downloads. A
missing/truncated part remains incomplete, preserving retry/backoff and source
limit behavior. Diagnostic parse failure adds uncertainty rather than stopping
other messages. The reader combines download and encoding notices for display;
their stored states stay separate.

The host exposes the informational notice as `encodingWarning`, independently
of the existing download `bodyWarning`. Renderer body caches, repaint signatures
and body notifications carry both. An encoding notice must not become a failed
download or block hydration of a complete draft. Provider-decoded text bypasses
the old whole-string mojibake repair, preserving literal `Ã©` when its declared
charset produces that text; the byte-decoding path does not guess a second charset.

If HTML decoding provably lost characters and an independently checked plain
alternative is intact, the host presents plain text. Multiple body sections keep
the existing presentation and require an explicit view choice. Original HTML stays in the
cache. When both versions are available, a per-reading-surface button switches
between sanitized HTML and text nodes. Switching never changes the cached mail
or permits remote images. Unverified old content is not automatically switched
based on a literal replacement character alone.

## Existing caches and explicit retry

A legacy row containing replacement characters gets an uncertainty notice when
read; the cache cannot show whether those characters were introduced locally,
by the provider, or by the sender. Nothing reconstructs original bytes from
U+FFFD. A complete legacy row still opens locally. Users can select the available
plain-text version or explicitly Retry download to recheck the server copy.

Explicit retry now bypasses the complete-body fast path and requests full Gmail
parts, preserving normal account/UID/action identity checks and pending-draft
protections. A failed retry retains the cache and reports failure. A successful
full read replaces its diagnostics with the newly checked state. Partial sync
responses retain a previously complete body together with that body's diagnostic
provenance. Native database migrations only add the nullable column; mail content,
search and journal durability are not rebuilt or weakened.

The `retry` invoke flag is distinct from the pre-existing `full` read flag used
by reply, draft preparation and Timeline. Those ordinary reads continue to reuse
complete cached bodies and refresh only necessary metadata. Only an explicit
reader retry requests a replacement complete body. Locally pending drafts ignore
old provider diagnostics, and saving edited content clears their stale flags.

Explicit retry can fix an earlier client parsing error when the server still
has usable bytes and an appropriate charset declaration. It cannot fix incorrect
sender labels by guessing or repair a server copy already containing U+FFFD.
Locally pending drafts are never replaced by a provider retry. Snippet truncation
also avoids splitting an emoji's surrogate pair; IMAP byte caps still leave the
message incomplete when the source ends mid-character.

## Validation

`scripts/check-mail-decoding.js` runs real MIME parsers, production cache SQL and
persistence, host reads/retry and the renderer using generated fixtures only.
It covers quoted/RFC2231 parameters; UTF-8, Big5, GB18030, CP932, EUC-JP,
ISO-2022-JP, UTF-7 and Windows-1252; B headers; base64/QP/raw input and split UTF-8
streams; malformed bytes and base64url; valid literal U+FFFD; complete/partial and
reopened caches; safe plain-text alternatives and image/script controls; explicit
retry and failure; emoji snippets and source caps; and the rendered Features tab.
Outgoing Unicode MIME is round-tripped without sending anything. CI runs the
fixture through the ordinary boot-path check. Live provider behavior and native
font coverage remain outside synthetic validation.
