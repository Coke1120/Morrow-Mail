# Reviewed, local selected-mail timelines

Status: accepted for the desktop MVP.

Expose a generic correspondence chronology beside the reader. Preparation freezes
an account-scoped downloaded-mail manifest and shows coverage and destination;
only a final Generate click starts AI. Timeline is not an Agent skill, background
job, mail write or bot operation. An expanded disclosure bumps AI permission to
version 2. Use the existing saved API/custom endpoint or ChatGPT adapter without
profile/history context or automatic fallback. Provider retention terms remain an
external prerequisite, not an application guarantee.

Publish an immutable, exact-version Draft 2020-12 schema under `shared/` so it ships
with the desktop bundle. Stable opaque namespace/source UUIDs avoid disclosing
mail-provider identifiers. The host owns chronology metadata; the model supplies
only validated semantic text. One correspondence event per source message keeps
deduplication and timestamp semantics testable. Large sources are chunked; retries,
consolidation, output, total usage, time and cancellation are bounded.

Use feature-owned tables in the existing journaled mail store. Commit completed
validated artifacts atomically with source links. No await belongs inside a database
transaction. New generation creates a separate artifact. Restart interrupts jobs
without automatic model continuation. Account removal deletes any derived artifact
touching that account, including mixed-account results; the UI discloses this
instead of silently retaining partial derived data. Historical journal bytes,
backups and user-exported files are not an erasure guarantee.

Ship reviewed JSON, escaped Markdown and isolated scriptless PDF file exports.
Defer URL/webhook delivery: it introduces destination policy, new secrets,
replay/delivery receipts and per-send network authorization that are unnecessary
for the file-based MVP. No destination-specific fields or sample data belong in
the public format. See `docs/TIMELINE_FORMAT.md` for limits and version policy.
