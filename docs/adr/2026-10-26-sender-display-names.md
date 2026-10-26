# Morrow-only sender display names

Status: implementation in progress; separate draft PR, no release integration.

Settings already discovers Gmail's verified Send mail as addresses, including their
display names, but outgoing MIME currently uses bare email addresses. Add an
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
the ongoing v0.2.40 release. Providers and recipients' contact displays can affect
the final visible name; synthetic MIME/UI checks do not prove live delivery behavior.
