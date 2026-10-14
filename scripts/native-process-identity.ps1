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
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace MorrowObservationIdentity {
    public sealed class Acquisition {
        public uint Pid { get; internal set; }
        public SafeProcessHandle Handle { get; internal set; }
        public int? NativeError { get; internal set; }
        public AcquisitionProvenance Provenance { get; internal set; }
    }
    // Numeric, fixture-side diagnostics only. No value here proves identity or
    // exit, changes acquisition cadence, or permits a second open after failure.
    public sealed class AcquisitionProvenance {
        public string Source { get; internal set; }
        public int? NativeError { get; internal set; }
        public long WindowStartedAtQpc { get; internal set; }
        public long WindowUtcTicks { get; internal set; }
        public long WindowUtcReadCompletedAtQpc { get; internal set; }
        public long WindowStoppedAtQpc { get; internal set; }
        public long Scan { get; internal set; }
        public long ScanStartedAtQpc { get; internal set; }
        public long SnapshotReadyAtQpc { get; internal set; }
        public long PriorScan { get; internal set; }
        public long PriorScanCompletedAtQpc { get; internal set; }
        public long OpenStartedAtQpc { get; internal set; }
        public long OpenCompletedAtQpc { get; internal set; }
        public long CimReceivedAtQpc { get; internal set; }
    }
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

    public sealed class InventoryAcquisition {
        public uint Pid { get; internal set; }
        public SafeProcessHandle Handle { get; internal set; }
        public int? NativeError { get; internal set; }
        public AcquisitionProvenance Provenance { get; internal set; }
    }
    public sealed class InventoryPinWindow : IDisposable {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct ProcessEntry {
            public uint Size, Usage, Pid;
            public UIntPtr DefaultHeap;
            public uint Module, Threads, ParentPid;
            public int Priority;
            public uint Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
        }
        sealed class SnapshotHandle : SafeHandleZeroOrMinusOneIsInvalid {
            public SnapshotHandle() : base(true) { }
            protected override bool ReleaseHandle() { return CloseHandle(handle); }
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern SnapshotHandle CreateToolhelp32Snapshot(uint flags, uint pid);
        [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool Process32First(SnapshotHandle snapshot, ref ProcessEntry entry);
        [DllImport("kernel32.dll", EntryPoint = "Process32NextW", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool Process32Next(SnapshotHandle snapshot, ref ProcessEntry entry);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint GetProcessId(SafeProcessHandle handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool GetProcessTimes(SafeProcessHandle handle, out long created, out long exited, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint WaitForSingleObject(SafeProcessHandle handle, uint milliseconds);

        readonly object gate = new object();
        readonly Dictionary<uint, int> parents = new Dictionary<uint, int>();
        readonly Dictionary<uint, InventoryAcquisition> pins = new Dictionary<uint, InventoryAcquisition>();
        readonly HashSet<uint> known;
        readonly uint[] parentIds;
        readonly long[] parentTicks;
        readonly SafeProcessHandle[] parentHandles;
        readonly bool[] parentRefs;
        readonly int limit;
        readonly uint projectedPid;
        readonly int projectedError;
        readonly ManualResetEventSlim stop = new ManualResetEventSlim(false);
        Thread worker;
        Exception failure;
        bool transferred;
        int closing, cleaned;
        readonly long windowStartedAtQpc = Stopwatch.GetTimestamp();
        readonly long windowUtcTicks = DateTime.UtcNow.Ticks;
        readonly long windowUtcReadCompletedAtQpc = Stopwatch.GetTimestamp();
        long scanSequence;
        long completedScan, completedScanAtQpc;

        InventoryPinWindow(uint[] ids, long[] ticks, SafeProcessHandle[] handles, uint[] knownIds,
            int maximum, uint fixturePid, int fixtureError) {
            if (ids == null || ticks == null || handles == null || knownIds == null || ids.Length == 0 ||
                ids.Length > 64 || ids.Length != ticks.Length || ids.Length != handles.Length ||
                knownIds.Length > 64 || maximum < 0 || maximum > 64 - knownIds.Length ||
                ((fixturePid == 0) != (fixtureError == 0)) || (fixtureError != 0 && fixtureError != 5 && fixtureError != 87))
                throw new ArgumentException("Invalid inventory pin bounds.");
            known = new HashSet<uint>();
            foreach (uint id in knownIds)
                if (id <= 1 || !known.Add(id)) throw new ArgumentException("Invalid known identity.");
            for (int i = 0; i < ids.Length; i++) {
                if (ids[i] <= 1 || !known.Contains(ids[i]) || parents.ContainsKey(ids[i]) ||
                    ticks[i] <= 0 || ticks[i] > DateTime.MaxValue.Ticks || handles[i] == null || handles[i].IsInvalid || handles[i].IsClosed)
                    throw new ArgumentException("Invalid parent identity.");
                parents.Add(ids[i], i);
            }
            parentIds = (uint[])ids.Clone(); parentTicks = (long[])ticks.Clone();
            parentHandles = (SafeProcessHandle[])handles.Clone(); parentRefs = new bool[ids.Length];
            limit = maximum; projectedPid = fixturePid; projectedError = fixtureError;
            try {
                // Borrow these original retained parent objects, never reopen a
                // PID or adopt/dispose the caller's managed process handles.
                for (int i = 0; i < parentHandles.Length; i++) parentHandles[i].DangerousAddRef(ref parentRefs[i]);
                Capture("initial-scan"); // Cover children already live before slow CIM starts.
                worker = new Thread(Run) { IsBackground = true, Name = "Morrow inventory pins" };
                worker.Start();
            } catch { closing = 1; Cleanup(); throw; }
        }
        public static InventoryPinWindow Start(uint[] ids, long[] ticks, SafeProcessHandle[] handles, uint[] knownIds, int maximum) {
            return new InventoryPinWindow(ids, ticks, handles, knownIds, maximum, 0, 0);
        }
        // Direct deterministic native-error routing control, never an app or
        // environment switch. All successful handles/parent reads remain native.
        public static InventoryPinWindow StartForFixture(uint[] ids, long[] ticks, SafeProcessHandle[] handles,
            uint[] knownIds, int maximum, uint pid, int error) {
            if (pid <= 1 || (error != 5 && error != 87)) throw new ArgumentException("Invalid fixture error.");
            return new InventoryPinWindow(ids, ticks, handles, knownIds, maximum, pid, error);
        }
        bool LiveParent(int index) {
            uint actual = GetProcessId(parentHandles[index]);
            if (actual == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (actual != parentIds[index]) return false;
            long created, exited, kernel, user;
            if (!GetProcessTimes(parentHandles[index], out created, out exited, out kernel, out user))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (DateTime.FromFileTimeUtc(created).Ticks != parentTicks[index]) return false;
            uint wait = WaitForSingleObject(parentHandles[index], 0);
            if (wait == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (wait != 0 && wait != 258) throw new InvalidOperationException("Invalid parent wait.");
            return wait == 258;
        }
        InventoryAcquisition AcquireOnce(uint id, string source, long scan = 0, long scanStarted = 0, long snapshotReady = 0) {
            InventoryAcquisition existing;
            if (pins.TryGetValue(id, out existing)) return existing;
            if (pins.Count >= limit) throw new InvalidOperationException("Pin inventory limit.");
            var item = new InventoryAcquisition { Pid = id, Provenance = new AcquisitionProvenance {
                Source = source, WindowStartedAtQpc = windowStartedAtQpc, Scan = scan,
                WindowUtcTicks = windowUtcTicks, WindowUtcReadCompletedAtQpc = windowUtcReadCompletedAtQpc,
                ScanStartedAtQpc = scanStarted, SnapshotReadyAtQpc = snapshotReady,
                PriorScan = completedScan, PriorScanCompletedAtQpc = completedScanAtQpc,
                OpenStartedAtQpc = Stopwatch.GetTimestamp() } };
            try {
                if (id == projectedPid) throw new Win32Exception(projectedError);
                item.Handle = ExitProof.Acquire(id);
            } catch (Win32Exception error) { item.NativeError = item.Provenance.NativeError = error.NativeErrorCode; }
            finally { item.Provenance.OpenCompletedAtQpc = Stopwatch.GetTimestamp(); }
            pins.Add(id, item); Monitor.PulseAll(gate); return item;
        }
        void Capture(string source) {
            long scan = ++scanSequence, started = Stopwatch.GetTimestamp();
            bool complete = false;
            using (SnapshotHandle snapshot = CreateToolhelp32Snapshot(2, 0)) {
                if (snapshot.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                long ready = Stopwatch.GetTimestamp();
                var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>() };
                var seen = new HashSet<uint>();
                bool available = Process32First(snapshot, ref entry);
                if (!available && Marshal.GetLastWin32Error() != 18) throw new Win32Exception(Marshal.GetLastWin32Error());
                while (available && !stop.IsSet) {
                    if (seen.Count >= 8192 || !seen.Add(entry.Pid)) throw new InvalidOperationException("Process inventory limit or duplicate.");
                    int parent;
                    if (entry.Pid > 1 && !known.Contains(entry.Pid) && parents.TryGetValue(entry.ParentPid, out parent)) {
                        lock (gate) {
                            if (!pins.ContainsKey(entry.Pid) && LiveParent(parent)) AcquireOnce(entry.Pid, source, scan, started, ready);
                        }
                    }
                    available = Process32Next(snapshot, ref entry);
                    if (!available && Marshal.GetLastWin32Error() != 18) throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                complete = !available;
            }
            if (complete) lock (gate) { completedScan = scan; completedScanAtQpc = Stopwatch.GetTimestamp(); }
        }
        void Run() {
            try { while (!stop.Wait(10)) Capture("worker-scan"); }
            catch (Exception error) { lock (gate) failure = error; stop.Set(); }
            finally { if (Volatile.Read(ref closing) != 0) Cleanup(); }
        }
        // Borrow until Complete transfers ALL pins. The first result, including
        // 87/5, is retained under one lock across native scan and CIM delivery.
        public InventoryAcquisition AcquireForRow(uint id, uint parentId) {
            return AcquireForRow(id, parentId, 0);
        }
        public InventoryAcquisition AcquireForRow(uint id, uint parentId, long receivedAtQpc) {
            if (id <= 1 || known.Contains(id)) throw new ArgumentException("Invalid child identity.");
            if (receivedAtQpc < 0 || receivedAtQpc > Stopwatch.GetTimestamp()) throw new ArgumentException("Invalid row receipt clock.");
            lock (gate) {
                if (failure != null) throw new InvalidOperationException("Native inventory failed.", failure);
                if (transferred || Volatile.Read(ref closing) != 0) throw new ObjectDisposedException(nameof(InventoryPinWindow));
                InventoryAcquisition existing;
                if (pins.TryGetValue(id, out existing)) {
                    if (receivedAtQpc != 0 && existing.Provenance.CimReceivedAtQpc == 0) existing.Provenance.CimReceivedAtQpc = receivedAtQpc;
                    return existing;
                }
                int parent;
                if (!parents.TryGetValue(parentId, out parent) || !LiveParent(parent)) throw new InvalidOperationException("Parent is not live and owned.");
                var item = AcquireOnce(id, "cim-row");
                item.Provenance.CimReceivedAtQpc = receivedAtQpc;
                return item;
            }
        }
        public InventoryAcquisition[] BorrowForFixture() {
            lock (gate) { var result = new InventoryAcquisition[pins.Count]; pins.Values.CopyTo(result, 0); return result; }
        }
        public bool WaitForPinForFixture(uint id, int milliseconds) {
            if (id <= 1 || milliseconds < 0 || milliseconds > 5000) throw new ArgumentException("Invalid fixture wait.");
            long deadline = Stopwatch.GetTimestamp() + milliseconds * Stopwatch.Frequency / 1000L;
            lock (gate) {
                while (!pins.ContainsKey(id) && failure == null && !stop.IsSet) {
                    long remaining = deadline - Stopwatch.GetTimestamp();
                    if (remaining <= 0) break;
                    Monitor.Wait(gate, (int)Math.Min(milliseconds, Math.Max(1L, remaining * 1000L / Stopwatch.Frequency)));
                }
                return pins.ContainsKey(id);
            }
        }
        public bool WorkerStopped => worker == null || !worker.IsAlive;
        public InventoryAcquisition[] Complete(int milliseconds) {
            if (milliseconds < 0 || milliseconds > 250) throw new ArgumentException("Invalid inventory join budget.");
            stop.Set();
            if (!worker.Join(milliseconds)) { Interlocked.Exchange(ref closing, 1); throw new TimeoutException("Inventory pin window did not stop."); }
            lock (gate) {
                if (failure != null) throw new InvalidOperationException("Native inventory failed.", failure);
                if (transferred || Volatile.Read(ref closing) != 0) throw new ObjectDisposedException(nameof(InventoryPinWindow));
                var result = new InventoryAcquisition[pins.Count]; pins.Values.CopyTo(result, 0);
                long stopped = Stopwatch.GetTimestamp();
                foreach (var item in result) item.Provenance.WindowStoppedAtQpc = stopped;
                transferred = true; return result;
            }
        }
        void Cleanup() {
            if (Interlocked.Exchange(ref cleaned, 1) != 0) return;
            lock (gate) {
                if (!transferred) foreach (var item in pins.Values) item.Handle?.Dispose();
                pins.Clear();
            }
            for (int i = 0; i < parentRefs.Length; i++) if (parentRefs[i]) parentHandles[i].DangerousRelease();
            stop.Dispose();
        }
        public void Dispose() {
            bool first = Interlocked.Exchange(ref closing, 1) == 0;
            if (Volatile.Read(ref cleaned) != 0) return;
            try { stop.Set(); } catch (ObjectDisposedException) { if (Volatile.Read(ref cleaned) == 0) throw; }
            if (worker == null || worker.Join(first ? 250 : 0)) Cleanup();
            // A timed-out native worker keeps its own parent refs/pins until its
            // finally block. Never dispose a parent object while it is borrowed.
        }
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
        // Pin a bounded set of current children before slower per-child managed
        // admission. This does not validate identity/parentage or retry failures.
        // The caller owns every returned handle, including on rejected admission.
        public static Acquisition[] AcquireMany(uint[] pids) {
            if (pids == null || pids.Length > 64) throw new ArgumentException("Pin inventory limit.");
            var seen = new HashSet<uint>();
            foreach (uint pid in pids)
                if (pid <= 1 || !seen.Add(pid)) throw new ArgumentException("Invalid pin identity.");
            var acquired = new List<Acquisition>();
            try {
                foreach (uint pid in pids) {
                    var item = new Acquisition { Pid = pid, Provenance = new AcquisitionProvenance {
                        Source = "admission", OpenStartedAtQpc = Stopwatch.GetTimestamp() } };
                    try { item.Handle = Acquire(pid); }
                    catch (Win32Exception error) { item.NativeError = item.Provenance.NativeError = error.NativeErrorCode; }
                    finally { item.Provenance.OpenCompletedAtQpc = Stopwatch.GetTimestamp(); }
                    acquired.Add(item);
                }
                return acquired.ToArray();
            } catch {
                foreach (var item in acquired) item.Handle?.Dispose();
                throw;
            }
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
