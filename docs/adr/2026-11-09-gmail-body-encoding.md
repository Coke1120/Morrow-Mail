# Resolve ambiguous Gmail body representations using original MIME

Status: Proposed in this fix PR.

## Context

Gmail's full message representation can expose UTF-8 body data under the
original MIME charset and byte size. Applying that charset again corrupts text.
Conversely, genuine legacy bytes can also be valid UTF-8: C3 A9 is literal
Windows-1252 “Ã©”, and C2 A9 means different text in GBK, Shift-JIS and UTF-8.
Neither valid UTF-8 nor a more readable result establishes the original text.

## Decision

- Keep ordinary MIME charset decoding, including ASCII stateful encodings.
  When non-ASCII strict UTF-8 disagrees with the declared decoding of a Gmail
  text part, read that provider message's original MIME once and use its parsed
  text and HTML together. This applies during sync as well as foreground reads.
- Use the existing raw API's canonical base64url validation and 35 MiB limit.
  Verify the provider ID and any known RFC Message-ID. Recheck cancellation and
  account incarnation after asynchronous work. Keep Gmail attachment IDs and
  metadata; CID hydration remains gated by the existing full-body path.
- The exceptional raw read includes original attachment bytes, which the MIME
  parser may buffer. It does not save ordinary attachment files. Normal file
  downloads remain on demand. The existing Gmail read pacing remains in force.
- Replace body encoding diagnostics with diagnostics from original MIME. Clear
  only full-representation text-size mismatches now independently verified by
  original MIME. Keep unrelated malformed-part, missing-part and file warnings.
  An unavailable or mismatched original leaves available content incomplete
  and unverified; it does not establish a guessed UTF-8 interpretation.
- Keep cache recovery explicit. Received Gmail mail also offers Reload message
  when no warning exists, so old double decoding without replacement characters
  can be replaced. Existing retries use the corrected provider path. Failed
  reloads preserve complete cached bodies; pending drafts are protected. There
  is no cache-wide scan, rewrite, migration, automatic repair or provider write.

## Verification

Synthetic checks exercise normalized UTF-8 with original GB2312/GBK, Big5,
Shift-JIS and Windows-1252 headers, genuine valid-UTF-8 legacy collisions,
base64/quoted-printable original MIME, alternatives, HTML-only mail, literal
replacement characters, original-byte loss, sync and foreground reads, CID and
ordinary attachments, independent warnings, failed/mismatched reads, cancelled
or changed accounts, explicit cache reloads and renderer/Features behavior.
No private email, live provider response, mailbox or credentials are fixtures.
