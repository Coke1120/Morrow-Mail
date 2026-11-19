# Let large timelines reuse exact quoted history

For local captures over 512,000 UTF-8 bytes, inspect up to 1,024,000 bytes before
rejecting a selection. Remove a repeated block from extraction only when every
line has a plain-text quote prefix and removing those prefixes yields an exact
match against a strictly earlier unchanged complete selected body in the same
thread. Keep 128 bytes as the minimum match. Keep edited, unmarked, ambiguous,
cross-thread and quote-only bodies intact. Preserve the quoting message as a
separate event and identify omitted duplicates as metadata rather than pretending
a source token can resolve across provider requests.

Send the earlier evidence through ordinary extraction. Preserve raw cached mail,
source proofs and date checks. Keep the 512,000-byte remaining-text and serialized
input protections, plus existing per-request, call, output-token and time limits.
Show local scan counts and exact quote savings before Generate; no new AI access
or destination. Case selection remains the fallback for unique or very large mail.
Ordinary captures retain the previous request-local behavior.
