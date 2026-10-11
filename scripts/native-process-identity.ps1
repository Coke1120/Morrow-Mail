#requires -Version 7.2
# Read-only, fixture-side process identity proof for the observation collector.
# The caller must separately validate ownership, the current parent's CIM
# identity, and its retained live handle. An exited proof cannot authorize a
# descendant or provide a counter sample.
if (-not ('MorrowObservationIdentity.ExitProof' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace MorrowObservationIdentity {
    public sealed class Result {
        public string Outcome { get; internal set; } = "unavailable";
        public string Stage { get; internal set; } = "input";
        public uint ExpectedPid { get; internal set; }
        public uint? ActualPid { get; internal set; }
        public long? StartUtcTicks { get; internal set; }
        public bool HandleOpened { get; internal set; }
        public bool IdentityMatched { get; internal set; }
        public bool Signaled { get; internal set; }
        public int? ExitCode { get; internal set; }
        public int? NativeError { get; internal set; }
        public uint? WaitStatus { get; internal set; }
        public bool ProvenZero => IdentityMatched && Signaled && ExitCode == 0 && Outcome == "zeroExit";
    }

    public sealed class LookupResult {
        public Result Initial { get; internal set; }
        public Result Final { get; internal set; }
        public long PinnedStartUtcTicks { get; internal set; }
        public long StartedAtQpc { get; internal set; }
        public long CompletedAtQpc { get; internal set; }
        public long DeadlineAtQpc { get; internal set; }
        public long ClockFrequency => Stopwatch.Frequency;
        public double DurationMs => (CompletedAtQpc - StartedAtQpc) * 1000.0 / ClockFrequency;
        public bool WaitAttempted { get; internal set; }
        public uint? SettlingWait { get; internal set; }
        public int? SettlingError { get; internal set; }
        public bool DeadlineExceeded { get; internal set; }
        public bool Projection { get; internal set; }
        public string Outcome { get; internal set; }
        public string Stage { get; internal set; }
        public int? ExitCode { get; internal set; }
        public int? NativeError { get; internal set; }
        public bool ProvenZero => Outcome == "zeroExit" && Final != null && Final.ProvenZero
            && Final.StartUtcTicks == PinnedStartUtcTicks && (!WaitAttempted || !DeadlineExceeded);
    }

    // Direct fixture inputs only, never an environment or application switch.
    // A projection cannot replace the final native identity/signal/exit read.
    public sealed class LookupProjection {
        public uint? InitialWait { get; set; }
        public int? InitialWaitError { get; set; }
        public bool? InitialExitQuerySuccess { get; set; }
        public uint? InitialExitCode { get; set; }
        public int? InitialExitError { get; set; }
        public uint? SettlingWait { get; set; }
        public int? SettlingError { get; set; }
        public bool CompleteAfterDeadline { get; set; }
    }

    public static class ExitProof {
        const uint QueryLimitedInformation = 0x1000, Synchronize = 0x100000;
        const uint WaitObject0 = 0, WaitTimeout = 258, WaitFailed = 0xffffffff;
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern SafeProcessHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint GetProcessId(SafeProcessHandle process);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool GetProcessTimes(SafeProcessHandle process, out long created, out long exited, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool GetExitCodeProcess(SafeProcessHandle process, out uint code);

        // CIM creation timestamps have microsecond precision. All arithmetic
        // stays Int64; a floating-point conversion loses identity precision.
        public static bool MatchesCreation(long actualTicks, long cimTicks, long parentTicks) {
            return actualTicks > 0 && actualTicks <= DateTime.MaxValue.Ticks && cimTicks > 0
                && cimTicks <= DateTime.MaxValue.Ticks && parentTicks > 0 && parentTicks <= actualTicks
                && actualTicks - actualTicks % 10L == cimTicks - cimTicks % 10L;
        }
        static bool ValidInput(uint pid, long cimTicks, long parentTicks) {
            return pid > 1 && cimTicks > 0 && cimTicks <= DateTime.MaxValue.Ticks
                && parentTicks > 0 && parentTicks <= DateTime.MaxValue.Ticks;
        }
        static Result NativeFailure(Result result, string stage, int error) {
            result.Stage = stage; result.Outcome = error == 5 ? "accessDenied" : "unavailable";
            result.NativeError = error; return result;
        }
        // Transfers this limited, non-inheritable handle to the caller. Keep
        // it through managed admission or ReadHandle; reopening loses the pin.
        public static SafeProcessHandle Acquire(uint pid) {
            if (pid <= 1) throw new ArgumentOutOfRangeException(nameof(pid));
            SafeProcessHandle handle = OpenProcess(QueryLimitedInformation | Synchronize, false, pid);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error);
            }
            return handle;
        }
        public static Result Probe(uint pid, long cimTicks, long parentTicks) {
            var result = new Result { ExpectedPid = pid };
            if (!ValidInput(pid, cimTicks, parentTicks)) { result.Outcome = "invalidInput"; return result; }
            using (SafeProcessHandle handle = OpenProcess(QueryLimitedInformation | Synchronize, false, pid)) {
                // Capture the native error before disposal or another API call.
                if (handle.IsInvalid) return NativeFailure(result, "open", Marshal.GetLastWin32Error());
                return ReadHandle(handle, pid, cimTicks, parentTicks);
            }
        }
        // Borrows a caller-owned handle only for this synchronous call. Tests
        // use the same path with restricted rights and projected identities.
        // This method never adopts/disposes the caller's handle or kills a PID.
        public static Result ReadHandle(SafeProcessHandle handle, uint pid, long cimTicks, long parentTicks) {
            return ReadHandleCore(handle, pid, cimTicks, parentTicks, null);
        }
        static Result ReadHandleCore(SafeProcessHandle handle, uint pid, long cimTicks, long parentTicks, LookupProjection projection) {
            var result = new Result { ExpectedPid = pid };
            if (!ValidInput(pid, cimTicks, parentTicks)) { result.Outcome = "invalidInput"; return result; }
            if (handle == null || handle.IsInvalid || handle.IsClosed) { result.Stage = "handle"; return result; }
            result.HandleOpened = true;
            uint actualPid = GetProcessId(handle);
            if (actualPid == 0) return NativeFailure(result, "pid", Marshal.GetLastWin32Error());
            result.ActualPid = actualPid;
            if (actualPid != pid) { result.Stage = "pid"; result.Outcome = "identityMismatch"; return result; }
            long created, exited, kernel, user;
            if (!GetProcessTimes(handle, out created, out exited, out kernel, out user))
                return NativeFailure(result, "creation", Marshal.GetLastWin32Error());
            try { result.StartUtcTicks = DateTime.FromFileTimeUtc(created).Ticks; }
            catch (ArgumentOutOfRangeException) { result.Stage = "creation"; result.Outcome = "invalidIdentity"; return result; }
            if (!MatchesCreation(result.StartUtcTicks.Value, cimTicks, parentTicks)) {
                result.Stage = "creation"; result.Outcome = "identityMismatch"; return result;
            }
            result.IdentityMatched = true;
            uint wait = projection?.InitialWait ?? WaitForSingleObject(handle, 0);
            // GetLastError is defined here only for WAIT_FAILED, and is read
            // before any subsequent native call or clock/cleanup operation.
            int? waitError = wait == WaitFailed ? (projection?.InitialWaitError ?? Marshal.GetLastWin32Error()) : (int?)null;
            result.WaitStatus = wait;
            if (wait == WaitFailed) return NativeFailure(result, "wait", waitError.Value);
            if (wait != WaitObject0) {
                result.Stage = "wait"; result.Outcome = wait == WaitTimeout ? "alive" : "invalidWait"; return result;
            }
            result.Signaled = true;
            uint code;
            if (!GetExitCodeProcess(handle, out code)) return NativeFailure(result, "exit", Marshal.GetLastWin32Error());
            // Keep all native DWORD exit bits, including 0xffffffff, in the
            // observer's existing signed Int32 representation.
            result.ExitCode = unchecked((int)code); result.Stage = "exit";
            result.Outcome = code == 0 ? "zeroExit" : "nonzeroExit";
            return result;
        }

        public static LookupResult ReadLookupHandle(SafeProcessHandle handle, uint pid, long cimTicks,
            long parentTicks, long pinnedTicks, long deadlineAtQpc) {
            return ReadLookupCore(handle, pid, cimTicks, parentTicks, pinnedTicks, deadlineAtQpc, null);
        }
        public static LookupResult ReadLookupHandleForFixture(SafeProcessHandle handle, uint pid, long cimTicks,
            long parentTicks, long pinnedTicks, long deadlineAtQpc, LookupProjection projection) {
            if (projection == null) throw new ArgumentNullException(nameof(projection));
            return ReadLookupCore(handle, pid, cimTicks, parentTicks, pinnedTicks, deadlineAtQpc, projection);
        }
        static Result RequireExactPin(Result result, long pinnedTicks) {
            if (result.IdentityMatched && result.StartUtcTicks != pinnedTicks) {
                result.IdentityMatched = false; result.Stage = "creation"; result.Outcome = "identityMismatch";
            }
            return result;
        }
        static LookupResult Finish(LookupResult lookup, string outcome, string stage, int? code, int? error,
            LookupProjection projection, bool checkDeadline) {
            lookup.CompletedAtQpc = Stopwatch.GetTimestamp();
            if (projection?.CompleteAfterDeadline == true && checkDeadline)
                lookup.CompletedAtQpc = Math.Max(lookup.CompletedAtQpc, lookup.DeadlineAtQpc + 1);
            lookup.DeadlineExceeded = checkDeadline && lookup.CompletedAtQpc >= lookup.DeadlineAtQpc;
            lookup.Outcome = lookup.DeadlineExceeded && outcome == "zeroExit" ? "deadlineExpired" : outcome;
            lookup.Stage = lookup.DeadlineExceeded && outcome == "zeroExit" ? "wait" : stage;
            lookup.ExitCode = code; lookup.NativeError = error;
            return lookup;
        }
        // ONLY the current-CIM ArgumentException admission fallback calls this.
        // The caller retains the original already-matched pin and validates the
        // same live parent before/after. No PID reopen or later-sample grace.
        static LookupResult ReadLookupCore(SafeProcessHandle handle, uint pid, long cimTicks,
            long parentTicks, long pinnedTicks, long deadlineAtQpc, LookupProjection projection) {
            var lookup = new LookupResult { PinnedStartUtcTicks = pinnedTicks, DeadlineAtQpc = deadlineAtQpc,
                StartedAtQpc = Stopwatch.GetTimestamp(), Projection = projection != null };
            var initial = RequireExactPin(ReadHandleCore(handle, pid, cimTicks, parentTicks, projection), pinnedTicks);
            lookup.Initial = initial;
            if (initial.ProvenZero) {
                // Preserve the old already-signaled path independently of the
                // shared settling budget used by other newly observed children.
                lookup.Final = projection == null ? initial : RequireExactPin(ReadHandle(handle, pid, cimTicks, parentTicks), pinnedTicks);
                return Finish(lookup, lookup.Final.Outcome, lookup.Final.Stage, lookup.Final.ExitCode, lookup.Final.NativeError, projection, false);
            }
            if (!initial.IdentityMatched || initial.WaitStatus != WaitTimeout || initial.Outcome != "alive")
                return Finish(lookup, initial.Outcome, initial.Stage, initial.ExitCode, initial.NativeError, projection, false);

            // .NET may reject an exit-code-zero process before its handle is
            // signaled. Immediately read THIS pin. STILL_ACTIVE, nonzero or a
            // failed query cannot enter settling or be forgiven by later zero.
            uint code = 0;
            bool queried = projection?.InitialExitQuerySuccess ?? GetExitCodeProcess(handle, out code);
            int? queryError = !queried ? (projection?.InitialExitError ?? Marshal.GetLastWin32Error()) : (int?)null;
            if (queried && projection?.InitialExitCode != null) code = projection.InitialExitCode.Value;
            if (!queried) {
                NativeFailure(initial, "exit", queryError.Value);
                return Finish(lookup, initial.Outcome, initial.Stage, null, initial.NativeError, projection, false);
            }
            initial.ExitCode = unchecked((int)code);
            initial.Outcome = code == 0 ? "pendingZero" : code == 259 ? "alive" : "nonzeroExit";
            if (code != 0)
                return Finish(lookup, initial.Outcome, initial.Stage, initial.ExitCode, null, projection, false);

            long remaining = deadlineAtQpc - Stopwatch.GetTimestamp();
            if (remaining <= 0)
                return Finish(lookup, "deadlineExpired", "wait", null, null, projection, true);
            // One shared <=250 ms admission deadline; floor rather than round
            // up. Scheduler delay still fails the post-wait absolute check.
            uint milliseconds = (uint)Math.Min(250L, (long)(remaining * 1000.0 / Stopwatch.Frequency));
            lookup.WaitAttempted = true;
            uint settled = projection?.SettlingWait ?? WaitForSingleObject(handle, milliseconds);
            int? settlingError = settled == WaitFailed ? (projection?.SettlingError ?? Marshal.GetLastWin32Error()) : (int?)null;
            lookup.SettlingWait = settled; lookup.SettlingError = settlingError;
            if (settled != WaitObject0) {
                string outcome = settled == WaitTimeout ? "alive" : settled == WaitFailed
                    ? settlingError == 5 ? "accessDenied" : "unavailable" : "invalidWait";
                return Finish(lookup, outcome, "wait", null, settlingError, projection, true);
            }
            // Final acceptance always repeats the REAL native PID/full creation,
            // zero wait and exit query on the same borrowed handle, even for
            // explicit timing projections. Nothing here owns/disposes the pin.
            var final = RequireExactPin(ReadHandle(handle, pid, cimTicks, parentTicks), pinnedTicks);
            lookup.Final = final;
            return Finish(lookup, final.Outcome, final.Stage, final.ExitCode, final.NativeError, projection, true);
        }
    }
}
'@
}

function Get-NativeProcessExitProof([uint32] $ProcessId, [long] $CimStartUtcTicks, [long] $ParentStartUtcTicks) {
    if (-not $IsWindows) { throw 'Native process identity proof requires Windows.' }
    return [MorrowObservationIdentity.ExitProof]::Probe($ProcessId, $CimStartUtcTicks, $ParentStartUtcTicks)
}
