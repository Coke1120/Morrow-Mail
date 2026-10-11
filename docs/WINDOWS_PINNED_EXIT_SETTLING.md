# Bounded original-pin exit proof

This is a narrow correction to the existing strict point-sampling collector,
not complete process-lifetime coverage. A separate DEBUG_PROCESS/Job experiment
did not complete the owned HTML fixture and is excluded from this candidate.
Its requirements do not redefine the current sampling gate.

## Hypothesis and evidence limits

Main [run 38128187209](https://github.com/Coke1120/Morrow-Mail/actions/runs/38128187209),
attempt 1, failed one owned/restart sample with nativeWait/no error/unknown exit.
Earlier main runs also recorded independent first-acquire error 87 gaps.
The historical record lacks a raw WAIT value and initial exit code; it cannot
establish a kernel race or the cause of the lookup rejection.

[Official .NET source](https://github.com/dotnet/runtime/blob/60629d14374c56f1cb51819049ad1fa529307f8d/src/libraries/System.Diagnostics.Process/src/System/Diagnostics/ProcessManager.Windows.cs#L285-L319)
checks an exit code before the process signal. That supports testing a pending
zero-exit/signal transition on an already-pinned process. The old CI runtime was
not fingerprinted; source inspection is not proof of its exact assembly or cause.
The focused workflow records PowerShell and FrameworkDescription for comparison.

## Acceptance contract

Only a new current-CIM child whose original limited native pin already matched
may enter this path, and only after managed lookup throws ArgumentException.
The same retained, current-identity, live parent is verified before and after.

- An initial real WAIT_OBJECT_0 and queried native zero retains the existing
  direct proof. Other children's settling budgets do not invalidate it.
- An initial WAIT_TIMEOUT immediately queries the same pin. Only a successful
  native code 0 may settle. STILL_ACTIVE (259), nonzero/crash codes, denied or
  unknown queries and unexpected/failed waits stay gaps without settling.
- All children in one admission loop share one monotonic deadline, at most
  250 ms, also clipped to the sample's one-second window and original collector
  launch + 180 seconds. No per-PID reset, retry or later-sample grace exists.
- A settled success needs WAIT_OBJECT_0, then a real same-handle PID/full native
  creation-tick match to the original pin and GetExitCodeProcess=0. The parent
  recheck also fits the deadline. A late return stays a gap; 250 ms is not a
  hard real-time scheduler guarantee.
- The child proof creates no counter sample, cache identity or descendant
  authority. Original pins are disposed in the existing finally block.

First-acquire 87/5, changed identities/parents, earlier counter failures,
nonzero exits and all other collector/UI failures remain strict failures.
This change cannot recover a process that disappears before the first pin.
Raw WAIT metadata added here covers the managed-lookup fallback; an earlier
pin-validation failure remains a gap and cannot be inferred to be settling.

New records preserve raw uint32 WAIT statuses (including 4294967295), initial
and final native reads, errors, exact identity, parent states, duration and
absolute deadlines. GetLastError is captured only immediately after a failed
native call; it is undefined for successful waits. Strict parser validation
rejects contradictions, expired success, changed full ticks and projected
native acceptance. Older records remain readable without inventing missing data.

## Verification scope

The original 26 lifecycle cases remain. Added controls cover real live/zero/
nonzero/query-only wait-denial handles; deterministic pending-zero timing and
lookup projections; initial 259/nonzero/query-error refusal; real final reads;
parent/cache changes; one shared/clipped deadline; earlier-gap retention;
and strict raw-status/deadline parser mutations. Crash-code controls explicitly
exit with a projected numeric status; they do not trigger or prove an actual
crash. Timing projections do not reproduce the historical race. All use owned
synthetic children, filtered fixture inventories and temporary files.

Linux PowerShell can compile the helper and check the parser/input contracts;
it cannot execute these Win32 proofs. Focused Windows controls and combined
native mail-flow checks precede one final paired native candidate run. Helper
success does not establish full UI/resource acceptance or release eligibility.
No initial Windows native result is predeclared in this document.

The approximately 1 Hz, 64-identity, 180-sample, 32 KiB-line and 2 MiB-file
bounds and 180-second UI/collector/30-second reader gates are unchanged.
HTML semantics, network isolation, cancellation and Back are unchanged.
Mac extreme HTML timing remains unresolved, without trusted WebContent mapping
or approved bounded profiling/cleanup. Physical VoiceOver/Narrator, manual
cross-platform UX and real accounts remain unverified. No privileged helper,
security/network setting change or broad system trace is introduced.
