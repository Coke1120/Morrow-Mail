# Morrow-only sender display names

Status: implemented on draft PR #315; full CI passed for the implementation at
`ff511e389fb1e52489f057def361282110ee2ddf`. Independent functional review and
the final head's checks remain integration gates.

Previously Settings discovered Gmail's verified Send mail as addresses, including
their display names, while outgoing MIME used bare email addresses. Add an
identity editor in Settings → Compose that defaults to Gmail's discovered name and
supports local overrides keyed by account id and exact normalized email address.
Refreshing provider identities must preserve overrides and manually configured
aliases. A local account label is separate from a recipient-visible sender name.

Resolve and preview the sender name/address when composing. Persist that identity
with drafts and scheduled content, and carry it through the actual MIME builders;
settings edits must not silently rename an already saved or queued composition.
Address authorization and provider alias verification remain independent of names.
Validate names against header control characters and use the existing MIME library
for Unicode/quoting instead of hand-built From headers.

This feature changes messages sent from Morrow only. It does not update Gmail's
send-as settings, request new OAuth scopes, enumerate Workspace domains, or modify
release preparation branches. Integration/versioning waits for checks and independent review. Providers and recipients' contact displays can affect
the final visible name; synthetic MIME/UI checks do not prove live delivery behavior.

The optional `senderNames` object preserves existing compose settings unchanged.
An empty value is an explicit address-only override; an absent key inherits the
provider default. Existing mailbox labels and manually configured aliases remain
separate. Saved content carries `fromDisplayName` independently of address
authorization; the nullable SQLite column preserves legacy draft revision proofs.
Legacy queued mail stays address-only. No new name parameter is exposed to bots,
and idempotent replay uses the original receipt even after default-name edits.

Validation uses synthetic providers, temporary SQLite, parsed MIME and synthetic
DOM/IPC. `check-sender-names.js` covers provider defaults, local/blank/reset
overrides, manual identities, account isolation, stale/concurrent discovery,
account removal, Settings edits/refresh and Features/CLI consistency.
`check-compose-identity.js`, `check-gmail-engine.js` and bot authorization checks
exercise actual draft/send/queue builders, Unicode/commas/quotes, saved-name
snapshots, address restrictions and idempotent replay. Full checks run through
`node scripts/check-boot-path.js` in the existing CI environment. The local VM
also runs the dependency-free DOM/policy/SQL and attachment/Gmail fixtures;
its full suite stops on missing native/parser dependencies. No native window,
OAuth grant, live Gmail/SMTP delivery or recipient-contact behavior was tested.
