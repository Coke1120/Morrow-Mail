# Native mail flow review — 10 October 2026

Base: main `8159b9dda81a938cd2b51258351a69f064f68a7c`, including merged PRs 24/25.
This follow-up is an unreleased review candidate; it does not merge, tag, publish
or change the product version. All checks use fictional data.

## Confirmed presentation defects and bounded changes

macOS's ordinary search called its initial-query debounce after every workspace
refresh. From page two, opening an unread message triggers the owner-bound
mark-read operation and reload; that debounce clears the displayed search rows
and requests page zero. Saving a reply triggers the same reload. Smart search
already refreshed its completed page using cached matching, but also cleared its
rows during that request.

The search now refreshes a completed query at its existing page, retaining its
displayed rows while the refresh is pending. A query/filter edit still starts a
new search. Smart refreshes remain `cachedOnly=true`; no additional model call
is authorized. If the requested page becomes empty and the count puts it beyond
the last page, one bounded read fetches the last valid page. Cancellation,
request tickets and captured account/folder checks apply after both reads.

Repeated Mac attachment/footer buttons were all named `Remove`; repeated Windows
attachment buttons were all named `Remove attachment`. Native accessibility
names now identify the attachment filename, and the Mac footer removal identifies
the email footer. This does not establish VoiceOver/Narrator usability or make
duplicate filenames unique.

Existing Mac/Windows Back, Escape, composer return-focus lifetime/mounted-peer
guards, owner-bound reply preparation, uncertain-send review and attachment
quarantine remain in place. The source review found no further demonstrated
defect that justified changing those paths in this round. Existing Windows
combined-view second-page composer-return tests remain part of native acceptance.

## Presentation fixture and evidence limits

`scripts/test-macos-mail-flow.py` compiles the production SwiftUI views and a
private copy of AppModel with only its initial localhost URL set for the test.
The supplied URLSession intercepts every request with a fictional URLProtocol;
unexpected destinations/paths fail. It starts no service, reads no mailbox or
credentials, and uses a new absolute temporary `MORROW_DATA_DIR`. The compiler
has a 180-second bound and the view process a 30-second bound.

The pinned-main negative control must reproduce the precise page-zero request
and empty displayed rows after an actual AppModel read/mark/reload sequence;
an unrelated crash is not accepted as a reproduction. Candidate checks exercise
native search controls and the reply sheet, held refreshes, Keep Editing after
cancel, captured draft owner/text/attachment IDs on save, last-page fallback,
obsolete-account cancellation with colliding provider IDs, and native AX removal
names. Fictional save responses verify submitted content, not durable storage;
the unmodified service's persistence/account contracts stay in native acceptance.
The Windows fixture checks names on rendered removal controls using fictional
metadata, without file access/upload/save.

Focused CI precedes the complete candidate CI. Final run identities and outcomes
are recorded in VERIFICATION.md and the draft PR. Failed runs are retained;
no gate is relaxed or rerun solely to obtain green. Manual keyboard/IME/pointer
UX across platforms, real VoiceOver/Narrator, real attachment picker/download
cancellation, clean hardware and live accounts remain unverified. Existing
native automated checks do not replace them.

## Mac extreme HTML: stop condition and engineering design

The original full reader's 180,000-character, 1-pixel document, wrapping/HTML
semantics, 30-second process deadline, tail/replacement/reflow assertions,
plain-text fallback, network isolation, cancellation and Back remain unchanged.
[The retained full failure](https://github.com/Coke1120/Morrow-Mail/actions/runs/38056323073)
reported loading at 22.218 seconds and tail success at 29.865 seconds. Separate
passes do not overturn that full-budget failure.

PR25 already tested break-word, a semantic-changing normal-wrap control,
foreground presentation, neutral spans and incremental rendering. None supplies
a supported production fix. [The Instruments capability run](https://github.com/Coke1120/Morrow-Mail/actions/runs/38068322515)
establishes installed exact-PID targeting and Time Profiler, but no verified
WKWebView-to-WebContent mapping, capture permission or bounded recording cleanup.
The unique new process candidate is not an ownership proof. This Linux Cloud
review supplies no new independent runtime observation that separates the
remaining renderer hypotheses. No new rendering-control batch, attachment,
sudo/root helper, private WebKit API or process inventory is attempted here.

A useful next experiment needs these prerequisites **before recording**:

1. A permitted runner-provided ownership attestation tying the exact fixture
   WKWebView lifetime to one WebContent PID and creation identity, including
   process replacement. A process name, proximity to navigation, new-process
   uniqueness or shared process pool cannot satisfy that contract. If the runner
   cannot provide such evidence, renderer attribution stops here.
2. A reviewed exact-target recording recipe and documented collector scope.
   Enumerate only fixture targets/recorder children from its own launch handles;
   no all-process/system trace, broad metadata, command lines or real mail.
   Recording permission must be tested through allowed tools, without changing
   security settings or repurposing the earlier rejected command.
3. Fixture-only controls proving bounded recorder readiness, trace flush,
   cancellation and reaping on normal exit, reader timeout, recorder failure
   and replaced target. Specify independent short startup/flush/cleanup limits,
   a trace-size limit and an exact-owned-process watchdog. Missing capture or
   unproven cleanup rejects the experiment; it is not a zero-cost sample.

After those prerequisites, predeclare **one** discriminator: samples attributed
to this renderer during navigation should distinguish line construction/wrapping
from repeated paint/commit work or time with little on-CPU activity. These are
hypotheses, not diagnoses. Use app-owned phase timestamps already outside the
message document to align publish/loading/tail events with the trace. Keep the
original document byte-for-byte, do not introduce message JavaScript, and retain
the original 30-second reader deadline including any recording overhead. One
bounded paired diagnostic may proceed only after its cleanup/attribution controls
pass; unexpected activity ends it and retains failure evidence. A UI-only profile
cannot establish a WebContent hotspot. A result must first justify a semantic-
preserving code change; then validate the final candidate with the full original
reader gate. Timeout remains unresolved until that evidence exists.

The owner would need to approve a concrete permitted runner attestation/recording
facility and its bounded recipe if that facility is unavailable under current
authorization. This is a technical prerequisite, not a request for credentials,
permission bypass, local-machine transfer or broad trace access.

## Windows first-acquire gap: separate observation design

[Baseline main CI](https://github.com/Coke1120/Morrow-Mail/actions/runs/38079525964)
passed Mac acceptance and Windows build/UI operations/benchmark, but Windows
strict resource observation failed in case 3 when first native handle acquisition
returned error 87 and the exit remained unknown. Relocation and release were
skipped. PR24 fixes the managed-lookup window **after** successfully pinning a
native identity; a child that disappears before the first acquisition is still
incomplete. This is a known baseline gap, independent of the presentation patch.
No Windows lifecycle experiment is repeated in this round.

A candidate observer must be ready **before fixture launch**, with an explicit
readiness barrier and loss watermark. Its allowlisted event contract needs:

- PID plus integer creation identity for every fixture lifetime, not PID alone;
- parent PID plus parent creation identity, verified fixture-root ancestry and
  well-defined handling when a parent exits before a child is discovered;
- native exit status tied to that exact lifetime, including a child that exits
  before any sample or handle acquisition;
- sequence/loss information, bounded buffering and a final drained watermark so
  silence cannot be mistaken for complete coverage;
- a fixed metadata-only projection, strict fixture scoping, bounded teardown and
  preservation of the current resource-sample/counter validation.

The reviewed WMI/ETW schemas did not directly satisfy those combined requirements;
this document does not declare another provider a solution. Require a supported,
already permitted source's concrete schema plus independently validated identity,
exit-code, ordering/loss and parent semantics before adding an adapter. A fixture
parent's self-report can be a positive control, not an oracle for uninstrumented
WebView children. Any source requiring a broad trace or changed privileges is
outside this task.

If such a source becomes available, the next narrow fixture should create the
observer first, confirm readiness, then release owned children whose exit precedes
the first sample. Keep zero/nonzero/unknown exits, same-PID different-birth,
parent-identity change, denied acquisition, missing/dropped events, overflow and
cancel/drain negatives. Missing proof remains incomplete; no skipped sample is
silently classified as normal exit and no synthetic counters are added. Complete
lifecycle accounting still cannot establish resource peaks between point samples.
Keep this future change separate from UX and retain `RequireCompleteObservation`.
