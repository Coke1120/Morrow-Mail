# Proposed Apache License 2.0 transition

The owner requested Apache licensing and visible version, source and license
information in README, About & updates, and the app's opening modal.

Use the standard Apache License 2.0 text as the root LICENSE and `Apache-2.0`
as the npm SPDX identifier. Preserve the previous root MIT notice verbatim in
LICENSE-MIT and keep the existing copyright line in NOTICE. Earlier releases
remain under their originally distributed terms; no old tag or release is edited.
Dependencies, bundled libraries, fonts, agent skills and the legacy archive keep
their original licenses. Root metadata describes the first-party distribution,
not a new license grant from third-party authors.

The opening status window shows the version from `app.getVersion()` on every
launch. Its two fixed HTTPS links open in the default browser; other popups and
navigation are denied. The version-keyed What's new dialog shows source and
license links without changing its existing acknowledgement behavior. About &
updates provides the same information persistently. There is no new permission,
provider read, update policy or app-version bump.

## Review and publication handoff

This is a proposed license transition on an owner-requested draft review branch.
It does not update the default branch, existing releases or installed copies.
The owner must review rights and personally perform the final merge/publication;
the agent must not merge or release this proposal. GitHub detects the root LICENSE
on its default branch; a draft or dev-only change does not update main.

The initial dev review at `7fe0efb7b7a0518abf31b1fca1a28823750a7a30`, rechecked
against `9cb5a47504fba1d136e265ee19fc2b09145871b6` for the draft PR, contains
author names Leo Ho, WAI LOK HO and howailok1120, plus Cursor, Codex and
Grok/Bot identities. No CLA or copyright assignment was found. Commit metadata
does not establish ownership or authority for every contribution, particularly
pre-MIT history. The existing MIT grant is preserved; this review does not infer
new patent grants or assignments from earlier contributors. The owner must
resolve any contributions not covered by their rights or existing compatible
terms before making the proposal effective.

Bundled Motion and PDF.js licenses are copied from the locked npm versions into
THIRD_PARTY_NOTICES.md. Existing BSD/OFL font and character-map notices remain
unchanged. These copies and LICENSE-MIT/NOTICE ship inside app.asar on every
platform. Electron's installed native license/Chromium notices are explicitly
copied into Resources/licenses so macOS packaging does not discard them.

A subsequent authorized release needs a new package version and matching entry
in shared/changelog.js. Published 0.4.4 and earlier notes/binaries are unchanged.
Do not claim that installed 0.4.4 or earlier copies have adopted this proposal.
