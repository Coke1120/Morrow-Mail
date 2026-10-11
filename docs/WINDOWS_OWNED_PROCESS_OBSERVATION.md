# Windows owned-process observation — 11 October 2026

This isolated experiment is rejected for WinUI integration and is not an observer
fix. PR29 synchronization passed exact-head paired checks and merged at
`b833ba0b9d2c958552dd272404708654a612ea55`. Sidebar guard restoration remains
in draft PR28. The observer blocker prevents combined acceptance and a new
release; an individual successful run does not repair the first-acquire gap.

## Existing evidence gap

Main `9823843` run [38114776594](https://github.com/Coke1120/Morrow-Mail/actions/runs/38114776594)
passed Windows build/UI/benchmark controls but failed strict resource observation:
two first-acquire errors 87 with unknown exit, and one native-wait record with
unknown exit. PR28 run [38119590098](https://github.com/Coke1120/Morrow-Mail/actions/runs/38119590098)
also failed a first-acquire record. PR24 fixes lookup after a native handle is
pinned; it cannot recover a process already gone before the first acquisition.
Error 87 alone proves neither successful nor failed exit. The old native-wait
record lacks enough raw outcome metadata to infer its exit cause. These baseline
failures are not established product regressions.

## Fixture-only contract

`windows/Checks/OwnedProcessObserver.h` is excluded from product compilation and
release packages. The helper launches only the marked disposable fixture with
an isolated environment and explicit inherited stdin/stdout/stderr handles. It
never attaches, enumerates system processes, reads process memory/debug strings,
enables privileges or changes machine settings.

The launch thread creates its root suspended with `DEBUG_PROCESS`, assigns an
owned kill-on-close Job and records native creation time before resuming user
code. Each native birth supplies its original process handle. Non-inheritable
query/synchronize duplicates are retained through teardown; each must belong to
the exact Job and match one unique earlier parent lifetime proved by original
handles, creation/exit times and event sequence. Parent IDs use exported
`NtQueryInformationProcess` basic information. Query/layout mismatch fails closed;
the Windows interface may change, so this is not an unqualified platform promise.

Each exit must join one birth and match the original handle's native wait,
creation time and exit code. Pending waits after a debug exit are drained.
Unknown waits, denied queries, nonzero/crash exits remain failures. Only each
process's initial breakpoint is consumed; other exceptions return to the process.
The prototype requires Job total, birth/exit ledger and sequence to agree, every
pin to have terminal proof, and Job active count to reach zero before normal
teardown. This is a conservative acceptance condition, not a universal identity
law: [Job accounting](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)
can include failed association attempts in `TotalProcesses`. A mismatch remains
unknown and rejected. Forced cleanup cannot satisfy normal proof. Job membership
alone does not supply process identity, original handles or native exit codes.

One-second counters use those same original pins. Short lifetimes receive native
exit proof without fabricated counter samples. Counter denial remains incomplete
even after a later zero exit. The independent bounded parser joins every sample
to its exact PID/creation-time/parent/role identity and rejects loss, replay,
overlapping PID lifetimes and partial records.

Bounds: 180-second overall wait, 180 samples, 64 total retained identities, 128
birth/exit records, 8192 debug events, 32 KiB records and 2 MiB reports. The total
lifetime bound is stricter than the former live-handle cache. Descendant and forced
cleanup drains have two-second limits. The outer UI wait includes helper setup,
root execution and reporting; it is not a separate 180-second root budget. The
original reader deadline and HTML/network/cancellation behavior remain. Only two
own-token booleans are recorded: elevation and enabled debug privilege; neither
is changed. Hosted CI cannot establish runtime acceptance under an independent
ordinary-user token. The actual hosted helper reported both booleans as true;
this fixture did not enable either privilege.

## Bounded evidence and current blocker

[38126128227](https://github.com/Coke1120/Morrow-Mail/actions/runs/38126128227),
attempt 1, passed 22 shared-source native controls. One-shot native first
acquisition after original pins closed returned error 87 for separately proven
exits zero, 7 and access-violation crash. Other controls cover child/grandchild,
parent-first exit, pending proof, real counter denial 5, closed-handle wait error 6,
unknown wait, identity/Job mismatch, loss and bounded cleanup. Metadata projections
do not claim real PID reuse.

Actual run [38126357908](https://github.com/Coke1120/Morrow-Mail/actions/runs/38126357908)
passed controls/build/fresh UI: three complete lifetimes, six valid samples, root
exit zero, drained Job, all original pins closed. The owned HTML case reached
`html-ready` at 15.1 seconds and all walkthrough phases through `shutdown`, then
stayed alive until the original 180-second limit. Observed service/other lifetimes
ended; UI accumulated about 150 seconds CPU. Helper termination left no final
sidecar/footer; strict observation correctly failed. No third UI case completed.
This is an observer/WinUI compatibility blocker, not a completed fix.

Diagnostic `c8464bb` adds fixed shutdown stages and periodic numeric summaries
from the exact owned Job/debug source. Run
[38127731211](https://github.com/Coke1120/Morrow-Mail/actions/runs/38127731211)
attempt 1 passed 22 controls plus 15 independent parser-corruption negatives.
Native build and fresh UI passed: five samples, three complete lifetimes, root
exit zero after 5.409 seconds, Job total three/active zero, all pins closed.
The owned HTML case reached `html-ready` after 12.255 seconds, completed its
walkthrough and reached these fixed stages: service drained, window closed and
Application.Exit returned. It never reported `XAML application stopped` before
the original 180-second limit. Its 179 counter samples cannot supply the missing
terminal ledger or footer after helper termination; strict observation failed.

The last owned-source summary was 1101 debug events, three birth events, two
exit events, Job total 22/active one, 93 first-chance exceptions, zero second-chance
exceptions and 47 debug-string events. The exception count stayed at 93 across
the retained late summaries, so those summaries do not prove an ongoing exception
storm. Those event counts are not completed lifetime proof: no final ledger/footer
was written for this case. Debug strings and exception addresses were not read. The Job/birth mismatch
does not identify 19 successful WebView creations. Root cause, complete lifetime
coverage and debugger compatibility remain unresolved.

Independent read-only review of combined local `87a3e1d` (the same source tree as
tested `c8464bb`) found no verifiable supported fix within the allowed tools.
The [official WinUI3 sample](https://github.com/MicrosoftEdge/WebView2Samples/blob/main/SampleApps/WebView2_WinUI3_Sample/WebView2_WinUI3_Sample/MainWindow.xaml.cs)
closes WebView2 on window closure for a debug-mode shutdown issue. Morrow already
closes unloaded readers, and the runtime fixture unloads all its test readers.
The observed window closure and Application.Exit both returned. An additional
Close patch is therefore not a proved correction for the blocked XAML loop.
Exception handling and strict gates remain unchanged. The bounded stderr parser
now retains one allowlisted shutdown marker independently of tail trimming; it
adds evidence, not an exit proof.

## Engineering prerequisites for a further experiment

The next source must be a supported, fixture-scoped lifecycle source that can be
installed and verified before the owned UI resumes. The existing permitted tools
do not currently provide that contract. No driver, privileged helper, broad system
trace, token change or security-setting change is authorized by this design.

1. **Prove source coverage first.** A supported launch hook or an already
   available trusted fixture-scoped feed must provide original query/synchronize
   handles before each relevant process can vanish, including sandbox/broker
   paths. Document which successful creations and failed Job associations it
   observes. Preserve unknown status when either cannot be distinguished.
   [Creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)
   permit separate debug chains, and a
   [specified parent](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
   supplies Job inheritance while the actual creator supplies the debug port.
   Job membership does not establish debug-chain coverage. The current evidence
   does not identify which creation path caused the mismatch.
2. **Keep one strict identity and terminal contract.** Bind a ready header to the
   owned helper/root native PID and integer 100-nanosecond creation time. Each
   sequenced birth must include a unique earlier parent's PID/creation time and
   an original retained handle. Each terminal record must retain raw wait outcome,
   native query error and actual exit code from that same handle. Unknown, denied,
   nonzero, crash, overlapping identity or source-loss records remain failures.
   Sequence continuity alone cannot prove a feed delivered all events: require a
   documented source loss/overflow indicator and a reliable scope-closure proof.
3. **Qualify ordinary-user execution and bounds.** Demonstrate the same source
   and actual WinUI fixture with elevation false and debug privilege disabled,
   without changing tokens or enabling privileges. Preserve the original
   180-second UI/30-second reader limits, one-second sampling, report/event/handle
   bounds, fixed diagnostics and owned-only cleanup. Retain terminal proof before
   releasing pins; forced cleanup never becomes normal exit. Source readiness,
   loss detection and cleanup each need bounded failure paths.
4. **Validate the source before integration.** Reuse the rapid zero/nonzero/crash,
   parent-first exit, pending wait, counter denial and parser-corruption controls.
   Add a distinguishable fixture for the newly supported creation path and failed
   Job associations. Actual PID reuse needs actual evidence; projections remain
   projections. Only after the narrow source and actual WinUI checks pass should
   the final combined PR28/PR29 source receive independent exact-head review,
   complete paired CI and main postmerge checks, followed by the existing paired
   publisher and asset/checksum/feed verification.

Job completion-port notifications cannot replace this prerequisite: their
[documented delivery](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_associate_completion_port)
is not generally guaranteed and they do not provide original birth handles plus
native exit codes. WebView2's
[process list](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2environment8)
omits crashpad and supplies IDs/kinds; its
[browser-exit event](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2browserprocessexitedeventargs)
supplies browser ID/exit kind, not the required all-process native proof. Repeating
snapshots or reclassifying error 87 as zero exit would leave the original gap.

The research workflow now runs only native controls on branch push. An actual UI
run is opt-in and requires a stated new reviewed hypothesis; the rejected UI source
is not rerun automatically. Canonical paired checks and release gates are untouched.

Physical keyboard, VoiceOver/Narrator, manual cross-platform UX, actual pickers,
ordinary-user/clean-machine runtime and real accounts remain unverified. The Mac
extreme HTML timeout is still open and is not addressed by this Windows source.
