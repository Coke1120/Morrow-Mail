# Let large timelines reuse exact quoted history

For local captures over 512,000 UTF-8 bytes, inspect up to 1,024,000 bytes of
original flattened bodies before rejecting a selection. The plain-text fallback
keeps its existing `>` prefix rules and uses an unchanged earlier body as its
canonical evidence. Also look for marked HTML history in oversized captures and
when the reviewed plan exceeds its batch or serialized-input budget. Retry that
plan with the same language, focus and Case reservation. An ordinary selection
that fits is planned once.

Use HTML quote markers only for HTML-only mail or when the cached text exactly
equals the ordinary HTML projection. A distinct plain MIME part is authoritative.
Recognize explicitly closed `blockquote` elements and Gmail quote wrappers. Keep
leading Gmail attribution and any other text outside a matched quote. Verify raw
boundaries against the complete projected text before using their positions. This
keeps identical unmarked occurrences and interleaved text in place. An uncertain
parse or projection keeps the existing text. Quote-only HTML bodies stay intact.

Each omitted quote must match at least 128 UTF-8 bytes and the entire original
body of a complete selected mail in the same thread at a strictly earlier known
timestamp. A nested HTML reply may use an earlier reply whose extraction is
already reduced. Every omission in that earlier reply has its own exact proof at
an earlier timestamp, so the chain terminates in literal evidence. An
unchanged-only canonical rule would keep progressively longer copies of a nested
thread in the input. Send every mail's retained text through ordinary extraction
under its own identity, and send only the count of omitted quote blocks. The
local proof needs no provider references across batches.

Keep up to 1,024,000 UTF-8 bytes of raw HTML eligible for this additional local
scan. Bound structure to 128 open elements and 256 marked ranges per body, and
stop if comparing nested ranges would inspect more than four times that body's
projected length. Raw markup and range metadata stay inside source capture. Raw
cached mail, fingerprints, original projected bodies and all existing source,
request, input, call, token and duration limits keep their original values.
Ordinary plannable captures retain the previous request-local behavior.
Prepare shows local scan counts and exact quote savings before Generate. Case
selection remains available for unique or very large mail.
