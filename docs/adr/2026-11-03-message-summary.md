# Explicit summaries belong to one message and renderer

Summary is an explicit answer about the selected downloaded email. Existing
Agent/Brain summaries are derived from triage samples and cannot represent an
arbitrary opened message. Use the existing `openai-client.complete` transport,
saved API/custom endpoint or ChatGPT configuration, error messages, consent lease
and operation stamp. There is no automatic generation, provider fallback, new
grant or background path. This is within version 1's existing explicit answers
purpose and selected-message text/quoted-history categories; the scope and
disclosure version stay unchanged.

The mail engine reads the authoritative cached message using account ID, local
message ID and connection epoch. It does not fetch bodies or attachment files for
Summary. A snippet alone is insufficient. HTML-only mail uses the existing
non-executing HTML-to-text converter. Input is limited to the first 24,000 body
characters plus bounded sender, subject and date. Partial/shortened input is
disclosed. The prompt treats mail as untrusted data and asks for concise plain
text, explicit actions and deadlines without inventing missing information.
Summary opts into rejecting API responses with a non-stop completion reason;
the existing ChatGPT adapter already rejects incomplete streams. Empty or
unexpectedly long answers are errors rather than displayed as completed output.

Each webContents owns one active request and receives only its invoke reply.
Cancel is scoped to that sender and request ID; closing the sender, a connection
invalidation or a two-minute deadline aborts it. Cancellation settles even if a
provider ignores abort. The consent transport still rejects its late output.
The engine revalidates identity and content before returning a result. The
renderer also binds results to the request, account, message, connection epoch
and content snapshot, retiring work on navigation, body changes and account
changes. No summary is persisted or shared between windows.

The shared reader toolbar exposes Summary with visible text and a decorative SVG.
Its labelled panel names the subject, sender and mailbox and announces loading,
errors and cancellation. Cancel, Dismiss and retry through Summary stay reachable
in narrow and separate readers. Missing configuration/permission links to the
existing AI settings review without granting consent. Features and AI data-use
help describe the content/cancellation limits. Native provider output quality and
Windows/macOS rendering require live validation; synthetic tests use no mail
credentials, real consent records or AI endpoints.
