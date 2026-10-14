# Retain bounded Windows observation evidence

Main `2ef9a6217a2b4d5e8deeebc0a95130b2a7dd04f5` failed the strict Windows
observation gate in [run 38577051320](https://github.com/Coke1120/Morrow-Mail/actions/runs/38577051320),
job `115896806006`. Owned case 2/sample 12 reported a first `nativeAcquire`
error 87 for PID 7176/parent 6808, with no exit code. UI and persistence checks
completed; that does not establish a normal exit for the missing child.
The same source tree passed an earlier PR run. Neither that pass nor this
diagnostic change repairs or waives the historical failure.

The old record did not distinguish an initial native scan, a later native scan,
CIM row delivery or admission as the source of the first handle attempt. Early
Reader phases could also disappear from the bounded stderr tail. These omissions
prevented attribution of the capture delay. They do not justify changing polling
frequency, reopening a failed PID, delaying Reader closure or inferring exit zero.

The fixture observer retains typed first-acquisition timing and source metadata,
including native snapshot, CIM receipt and window clocks. A UTC/QPC bracket
helps compare CIM creation time with capture time; it is diagnostic only, not
an identity or exit proof. The original first handle/error remains authoritative.
Only nativeAcquire failures among the first eight failure records in each sample
carry the extra detail; all 64 possible failure records and skip counts remain.
The summary reports recorded and unavailable provenance, including historical
records without the new fields. The 32 KiB record, 2 MiB stream, identity,
ownership, counter and original deadline limits still apply.

The harness separately retains a bounded, exact-allowlist Reader phase timeline
and typed fixture-only ProcessFailed information. It records receipt time and
Reader-relative time separately and makes overflow explicit. It stores no mail,
URLs, command lines, paths or exception messages. This evidence complements the
resource report; it never substitutes for a retained native handle or supplies
a missing process exit code. Normal Reader behavior and the strict observation
gate are unchanged.

Portable parser/schema and pipe-drain checks use:

```powershell
pwsh -File scripts/test-native-process-identity.ps1 -SchemaSelfTest
pwsh -File scripts/test-windows-native.ps1 -ObservationsSelfTest
```

Windows lifecycle controls additionally exercise late-born owned children through
the collector/report path and keep nonzero, identity changes and first-acquire
errors incomplete. The late-born controls prepare the original window and exited
child before entering the unchanged one-second admission path; they test retained
handle lifetime, not the historical race. Synthetic routing projections are
labeled as such. Windows
execution of these controls and `-UiSmoke -RequireCompleteObservation` is required;
Linux checks do not establish Win32 or WinUI acceptance. Complete process-lifetime
capture, repair of every error 87 race and live-mailbox acceptance are not claimed.
