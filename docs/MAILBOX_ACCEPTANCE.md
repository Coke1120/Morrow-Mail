# Controlled mailbox acceptance

`scripts/mailbox-acceptance.py` collects current-source evidence in separate,
new directories. It never accepts a user mailbox/workspace or provider credentials.
Run its build stages sequentially with exclusive use of the chosen Cargo target.
No fixture sends mail or calls a model.

| Stage | What runs | What it does not establish |
| --- | --- | --- |
| Protocol | Generated trusted TLS, production IMAP fetch/import/reconciliation, an initially empty target mailbox, and actual 1k/10k/50k downloads | Live-server behavior, background polling cadence/backoff, attachments or a complete provider mirror |
| Service | Existing `morrow-benchmark`: Rust-seeded 1k/10k/50k stores, service HTTP correctness, sampled service RSS and 30-second idle CPU on macOS/Windows | Download completeness, native UI latency, whole-app memory or a guaranteed peak |
| Native macOS | Opt-in executable hosts the production SwiftUI mail view, uses real pagination buttons and table mouse events, and observes layout/display with 50-row pages | Real service/SQLite/WAN cost, compositor presentation, HTML-reader performance or screen-reader acceptance |
| Native Windows | Opt-in executable hosts the production WinUI list/reader/search, invokes real control automation providers and verifies the resulting events and mounted owned content | Real service/SQLite/WAN cost, compositor presentation, HTML-reader performance or full accessibility acceptance |

The protocol test verifies every UID and its unique 1 KiB body, recomputes a
dataset digest, and retains the real importer checkpoint across an interrupted
fetch and workspace restart. It then downloads a 120-message burst, checks both
flag directions through bounded reconciliation, and rejects a stale history page
after a connection change. A reviewed new import retains same-origin cached
rows; a colliding foreign-owner sentinel must remain unchanged. Only that foreign
sentinel is seeded; the measured target starts at zero. A normal 120-message test
exercises the same fixture contract and is **not** 50k evidence.
The flag correctness bound sums each 1,000-UID discovery window's rounded
49-row pending-queue budget, then retains a fixed startup/scope allowance.
Unused queue slots do not carry across windows. A failure retains the original
failed stage and a separate `*.failure.json` with the direction, rounds, remaining
fictional UID flag differences and numeric checkpoint progress. It never copies
mail bodies, connections or credentials, and does not turn a failed run green.
Only this acceptance fixture's server sockets enable `TCP_NODELAY`, with an
explicit read-back check, to avoid artificial delayed ACKs between segmented
loopback writes. Production transport and existing fixture defaults stay
unchanged. Timings do not establish a WAN or historical-product speedup.

The macOS native fixture constructs the stated number of fictional metadata records
before returning bounded pages. All URLSession requests are intercepted and
unexpected origins, methods, owners and routes fail the fixture. No real service
is launched. The runner reuses the existing mail-flow fixture seam: among private
copies of the exact compiler inputs, only `AppModel.swift` receives the initial
loopback URL. Production source is not rewritten. Input enumeration is shared
with the compiler command; ignored inputs and symlinks are rejected, and original
and private input sets/hashes are checked before and after build/execution.
The captured adapter artifact is itself rehashed during evidence validation.
Each action has one first and five warm samples. Selection requires the actual
selected cell's owner/subject and the visible reader subtree's owner/subject/body;
model data or hidden/offscreen text elsewhere cannot satisfy that oracle.
The endpoint is observed layout/display, not compositor presentation or proof
against other-window occlusion. This is a smoke measurement, not a statistically
established latency distribution. Native oracle controls require a real macOS
build/run; passing Python evidence tests does not substitute for that execution.

The [Windows fixture](WINDOWS_MAILBOX_LATENCY.md) constructs the same metadata
sizes and uses a private copy of the existing native builder. Its service seam
rejects startup and intercepts both production request entry points; only fixed
fictional read requests are accepted. Actual Click/SelectionChanged events and
visible owned rows/reader content are required. It also measures Search separately.
The runner re-enumerates every private compiler input root before and after
build/run, including added or removed files admitted by the project wildcard.

## Run stages

Choose new evidence directories outside the checkout. The Rust stages build
offline with the locked dependency set; dependencies and toolchains must already
be installed. They must not share a Cargo target with another active build.

```sh
python3 -B scripts/test-mailbox-acceptance.py
python3 -B scripts/mailbox-acceptance.py run-protocol \
  --target /absolute/exclusive-target --output /absolute/new-protocol-evidence
```

`run-protocol --sizes 1000` is useful for a first run. It leaves 10k and 50k
acceptance missing. The default runs all three sizes from separate empty stores;
50k may take substantial time. The executable is copied and hashed before runs.
Each size has a two-hour execution bound; timeouts retain partial artifacts and
stop the runner's own process group. A timeout is not a pass.

On macOS and Windows, run the existing service benchmark through the same wrapper:

```sh
python3 -B scripts/mailbox-acceptance.py run-service \
  --target /absolute/exclusive-target --output /absolute/new-service-evidence
```

On macOS with Xcode command-line tools and an active graphical session:

```sh
python3 -B scripts/mailbox-acceptance.py run-native-macos \
  --output /absolute/new-native-evidence
```

That command explicitly compiles and runs the opt-in fixture. A missing window,
changed pagination structure, incorrect selection or unexpected request stops
measurement. Normal builds and reader-network/security gates are unchanged.
On an interactive Windows desktop with the pinned native build prerequisites:

```powershell
python -X utf8 -B scripts/test-windows-mailbox-latency.py
python -X utf8 -B scripts/windows-mailbox-latency.py --output C:/QA/new-native-evidence
```

Explicit Python UTF-8 mode makes source-text checks independent of the Windows
system code page. All adapter assertions and strict decoding remain enabled.
The measurement checkout must also preserve committed line endings with
`core.autocrlf=false`; the Windows measurement job configures Git before checkout.
This keeps exact source hashes and private-copy handler checks comparable across
platforms without normalizing recorded evidence or weakening byte comparisons.

The separate [native latency workflow](../.github/workflows/mailbox-latency.yml)
can compile and run both entries on an unmerged PR through its narrow paths
trigger, or be dispatched explicitly. Its green result concerns measurement
validity, not caller-approved performance acceptance. The existing Windows
walkthrough/resource observer remains separate evidence.

For a pull request, this measurement-only workflow checks out its exact head
SHA. This lets independently recorded protocol and native stages measure the
same source manifest even if a stacked base branch advances. Each stage still
records its own commit, tree and full source hashes. The ordinary native and
security workflow retains its normal synthetic-merge checkout and all existing
gates; a head measurement is not evidence of merge-integration acceptance.

## Aggregate without hiding missing work

```sh
python3 -B scripts/mailbox-acceptance.py aggregate \
  --evidence /absolute/protocol /absolute/mac-service /absolute/win-service \
             /absolute/mac-native /absolute/win-native \
  --limits /absolute/reviewed-limits.json --output /absolute/new-acceptance.json
```

Evidence includes the full runtime/test source manifest, source digest, commit,
binary identity, logs and report hashes. Dirty source is explicitly recorded;
all stages must have exactly the same source digest, which must not change during
a run. Writing result documentation does not change that digest. Existing reports
are never overwritten. These are local reproducibility checks, not cryptographic
build provenance or a claim that arbitrary external JSON is trustworthy.

The aggregator requires all three actual protocol sizes, service resource
measurements on both platforms, native measurements on both platforms, and an
explicit caller-approved limit policy. Missing evidence or limits returns
**`incomplete`, exit 2**. Failed checks, changed bytes, mixed source, invalid
numbers, wrong dataset digests, seeded downloads, or exceeded limits return
**`failed`, exit 1**. Only a complete matching set within limits returns exit 0.
Implementing both native entries does not supply their platform measurements.
The combined candidate still needs the matching-source protocol/resource/native
runs and reviewed limits before a full aggregate can pass.

The limits file has `schema: 1` and `platforms.macos` / `platforms.windows`.
Each platform contains `"1000"`, `"10000"` and `"50000"` objects with positive
finite numeric values for `serviceSampledMaxRSSBytes`, `serviceIdleCPUPercent`
(one-core percentage), and `nativeWarmP95Ms` (nearest rank of five warm samples,
applied to Next, Previous and Select separately). There are no invented default
performance targets. Choose and record targets before interpreting measurements.

## Existing evidence stays separate

`scripts/benchmark-imap-sync.py` retains its immutable historical comparison.
Its `synthetic_changed_flags_benchmark` seeds 50,000 warm rows, then changes a flag;
it does not download 50,000 messages. `synthetic_imap_sync_benchmark` exercises
50 cached rows. The existing service benchmark likewise seeds its stores. None
of those results satisfies this harness's full-download or native-latency gates.

See [historical synchronization measurements](SYNC_PERFORMANCE.md) and
[verification](../VERIFICATION.md). This harness makes no same-machine comparison
with Thunderbird, live-account, installed-app or error-free-operation claim.
