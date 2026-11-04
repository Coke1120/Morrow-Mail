# Timeline source revalidation and readable export

Account update broadcasts also report sync progress and cosmetic changes. They
cannot establish account replacement. The renderer now revalidates its opaque,
window-owned host manifest rather than discarding source context on every update.
Preparation checks the previous manifest before capturing edited focus, and checks
the returned manifest before enabling Generate. Serial/token checks reject late
responses from old opens. In-flight generation keeps the existing host incarnation,
credential, fingerprint, cancellation and pre-save checks. No stamps or credentials
are exposed to the renderer.

Keep immutable public schema 1.0.0 and one entry per source message. Show oldest
mail first by actual instant (including offset timestamps), grouped by display day,
with undated mail last. Concrete decisions, requests, changes and uncertainty lead;
recipients and opaque source references remain available as evidence. Sender/date
metadata accompanies each extraction fragment to support attribution; recipients,
internal account IDs and private focus are not added to exports.

Add local HTML export using the existing fresh review, native save dialog and
revision checks. The standalone responsive document also supplies PDF layout.
Escape every dynamic value; emit no links, scripts, forms, remote fonts or images,
and retain a restrictive CSP. Include coverage, timezone, provenance and uncertainty
so a portable report does not imply a complete mailbox or verified event dates.

Sender names/addresses, mail timestamps/date provenance and optional keyword/contact
focus are explicitly included in all host Timeline disclosures. Consent version 3
invalidates earlier grants through the existing version-bound fingerprint; reading
status never rewrites consent. A fresh manual choice does not restore background
permission, and generation still requires a newly prepared snapshot and Generate.
