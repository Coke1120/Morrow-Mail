# Controlled Windows mailbox latency

This unit must be stacked on the controlled acceptance harness before running:
`scripts/windows-mailbox-latency.py` deliberately imports the common source,
binary/report and native-evidence checks from `scripts/mailbox-acceptance.py`.
It does not start Rust, use a real mailbox, send mail or call a model.

On an interactive Windows x64 desktop with the prerequisites pinned in
[windows/README.md](../windows/README.md):

Use a measurement checkout created with `core.autocrlf=false` so Git preserves
the committed source bytes. The CI job sets this before checkout. Runtime/test
hashes and unchanged production-handler checks intentionally compare exact
bytes; converting a report or its source after measurement is not valid evidence.

```powershell
python -X utf8 -B scripts/test-windows-mailbox-latency.py
python -X utf8 -B scripts/windows-mailbox-latency.py --output C:/QA/new-native-latency-evidence
```

Choose a new absolute directory outside the checkout. Existing evidence is never
overwritten. Explicit Python UTF-8 mode keeps source-text checks independent of
the Windows system code page; decoding errors remain failures. The runner uses
the existing builder's `-CompileOnly` path, including
its pinned NuGet integrity checks; it does not run Cargo or package a release.
Build and fixture execution have separate 20-minute and 10-minute bounds. The
common runner stops only its owned process tree on timeout/interruption.

Only the private project sets the pinned CppWinRT package's documented
[`GeneratedFilesDir`](https://www.nuget.org/packages/Microsoft.Windows.CppWinRT/3.0.260818.1)
before SDK imports, pointing to
`compiler-inputs/build/windows-native/obj/<platform>/<configuration>/mailbox-latency-generated/`.
A private `PrepareForBuild` assertion rejects a changed effective property.
This keeps generated projection headers outside the immutable source roots;
it does not exempt any `windows/` path from the manifest. The production project
and builder remain unchanged. Local Python controls check the private XML and
actual runner ordering with controlled subprocess results; they do not establish
that the pinned SDK has built or executed the new fixture.

The runner makes an isolated compiler copy, as the existing attachment-flow
checks do. Exact-count source seams replace application startup, reject service
startup, and replace the **entire** blocking service transport. Both production
async request methods, their lifetimes and write guards remain intact. All
non-allowlisted paths, methods, host operations and owners are rejected and
counted. Native controls first verify rejected service-start, send, unknown-owner,
host-operation and unsafe-method requests. The measured child receives only an
OS environment allowlist plus a new marked fictional workspace and public
version. It has no live service/provider/model transport. No fixture hook is
compiled into the normal application or release package.

For each actual 1,000 / 10,000 / 50,000 metadata dataset, the fixture hosts the
production `Shell::mailPage`, list, plain-text reader, search field and buttons.
Two fictional owners deliberately share provider IDs. Each dataset measures one
first plus five warm Next, Previous and Select actions through WinUI Invoke and
SelectionItem automation providers; actual Click/SelectionChanged events must
occur. It does not call `loadPage` or `read` directly to simulate measured actions.
Initial unmeasured setup uses the ordinary page loader.

Completion requires an attached, geometrically visible native tree with positive
layout size, the expected **mounted TextBlock** subjects and owners for the first
two rows, the actual page label, 50 bounded rows and, for selection, matching
selected owner/view ID plus the displayed owned reader body and recipient. A
model or Tag update alone cannot satisfy those checks. Native Search uses the
real TextBox Value and Search/Clear Invoke providers, verifies 30 displayed
results with the expected even-row identities, and reports six separate search
samples. Search is supplemental; the shared cross-platform limit currently
applies to Next/Previous/Select only.

The clock is QueryPerformanceCounter and polling resolution is one millisecond.
The endpoint is observed mounted content plus `UpdateLayout`, **not compositor
presentation or physical input latency**. Fixture transport, thread-pool and
observer overhead are included. The native stage excludes real service/SQLite,
network, HTML-reader, attachment and whole-app resource costs. Five warm samples
are smoke measurements, not a statistical latency guarantee.

`evidence.json` is compatible with the common acceptance aggregator as the
`native:windows` stage. It records the exact source commit/tree/full source
manifest, private compiler-input hashes, copied native runtime hashes, logs,
version/time, process result and native report. Source, compiler inputs and the
measured runtime must remain unchanged. The executable is copied before use;
the runner executes that frozen copy with its self-contained dependencies.
The runner re-enumerates the complete private `windows`, `scripts` and `assets`
input roots plus `package.json` after build and measurement; added or removed
inputs invalidate the evidence. Only generated `build/` outputs are excluded
from that input comparison. Rehashing only previously known filenames would
miss a new `windows/*.cpp` admitted by the project wildcard.
The report preserves actual window size/DPI, data size, owned selection, visible
rows and page identity. Failed or missing native execution cannot become a
successful evidence stage. These checks are local reproducibility controls,
not independent cryptographic provenance for arbitrary external reports.

## Run on an unmerged candidate

[mailbox-latency.yml](../.github/workflows/mailbox-latency.yml) has a narrow
`pull_request` path trigger and also supports `workflow_dispatch`. The PR trigger
lets a new workflow run on a reviewed, unmerged candidate without first adding
it to the default branch. A new dispatch-only workflow may not be registered on
the default branch yet; do not merge merely to register it. Publish only after
the stacked candidate contains both platform fixtures and the common harness.

The two jobs compile and execute the actual WinUI and AppKit fixture entries.
They have read-only repository permissions, no secrets or release actions, and
retain JSON/logs, source adapters and measured executable bytes for seven days.
The artifact selection excludes synthetic mailbox workspaces, compiler caches,
NuGet downloads and build object files. It is evidence, not an installable app
distribution. Existing native reader/network/security and release gates remain
unchanged; these extra jobs do not replace them.

Both native jobs print a bounded diagnostic receipt and matching errors from
only `native-build.log` and `native.log`. Each JSON input is limited to 1 MiB,
each log to 16 MiB, and total diagnostic reads to 64 MiB. At most 40 matching
lines per log are shown, with 1,024-character excerpts and explicit truncation.
Missing, invalid, oversized or linked inputs produce an incomplete diagnostic.

Windows also compares the saved compiler manifest with the same fixed private
input roots after the stage stops. It first inventories names, file types and
sizes, verifies existing inputs before hashing newly added files, and reports
at most 40 relative paths with old/new SHA-256 values. Source contents and
environment variables are never printed. Added/removed counts are exact only
when enumeration completes; otherwise total counts remain null and the observed
paths are labeled partial. An unavailable hash stays null with an explicit
`hashStatus`; an unchecked existing file is never counted as unchanged. The
changed count stays null while any existing hash is unknown. Enumeration is
limited to 2,048 files, 4,096 directory
entries, depth 32, 1,024-byte relative paths and 16 MiB per input within the shared
64 MiB read budget; symlinks and reparse points are rejected. The comparison is
labeled `diagnostic-after-stage`, not an immediate post-build snapshot. Overflow
and incomplete enumeration stay explicit; no generated path is silently waived.
The original stage result and retained artifacts remain authoritative. A
successful diagnostic step cannot turn a failed measurement into a pass.

A green job means its measurement/report validity checks completed. It does not
mean the full product acceptance aggregate passed: all actual protocol sizes,
both service-resource stages and caller-reviewed performance limits are still
required. No default performance threshold or Thunderbird comparison is added.

At the local implementation checkpoint, Python adapter/evidence controls run on
Linux. There is no Windows SDK/desktop here, so WinUI compilation and actual
control-event measurements remain pending. Static inspection and fabricated
negative-control JSON are not native execution evidence.
