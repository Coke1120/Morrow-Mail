# IPC diagnostic metadata and provider capability meaning

The IPC trace serialized mail arguments with a credential-key blacklist. Mail
content and unlabelled credentials survived, as did renderer console messages,
source URLs and load-failure text in file/stderr/support copies.

Use a shared metadata writer for those routine sinks. Only literal first-party
channel names, argument counts, console levels/source lines and load codes are
diagnostic data; arbitrary strings and payloads are never traversed. Unknown
channels receive a fixed label. Invocation/send dedup and original dispatch,
returns and exceptions remain. Existing files are not inspected or erased.
Other Debug log sources retain their existing contextual/redaction policy.

The confirmed provider metadata defect is the global false value in
`bridge.describe`, even when `mail.send` is granted. It now means that granted
operations may contact providers, true when send is advertised. Cache-only reads
remain local. Current send responses/receipts had no provider-call field, so no
new counter or receipt schema is introduced. Gmail alias resolution precedes
claim/join/replay and OAuth refresh can precede SMTP authorization denial;
duplicate-SMTP protection does not imply zero provider traffic.

Synthetic regression tests cover all routine diagnostic copies and preservation
of dispatch/error/dedup behavior, plus sender/reader capability metadata and
provider alias lookup during send/join/replay with one synthetic SMTP submission.
