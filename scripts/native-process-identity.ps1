#requires -Version 7.2
# Read-only, fixture-side process identity proof for the observation collector.
# The caller must separately validate ownership, the current parent's CIM
# identity, and its retained live handle. An exited proof cannot authorize a
# descendant or provide a counter sample.
if (-not ('MorrowObservationIdentity.ExitProof' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
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
        public bool ProvenZero => IdentityMatched && Signaled && ExitCode == 0 && Outcome == "zeroExit";
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
            uint wait = WaitForSingleObject(handle, 0);
            if (wait == WaitFailed) return NativeFailure(result, "wait", Marshal.GetLastWin32Error());
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
    }
}
'@
}

function Get-NativeProcessExitProof([uint32] $ProcessId, [long] $CimStartUtcTicks, [long] $ParentStartUtcTicks) {
    if (-not $IsWindows) { throw 'Native process identity proof requires Windows.' }
    return [MorrowObservationIdentity.ExitProof]::Probe($ProcessId, $CimStartUtcTicks, $ParentStartUtcTicks)
}
