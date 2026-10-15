#requires -Version 7.2
# Dot-sourced fixture only. No app/provider workspace, DACL change or process-name
# cleanup. Children wait on owned stdin pipes; timeouts only bound a failed test.
function Test-NativeProcessLifecycle {
    if (-not $IsWindows) { Write-Host 'Native process lifecycle checks require Windows; not run on this host.'; return }
    function Check([bool] $Value, [string] $Stage = 'assertion') {
        if (-not $Value) { throw ('Native process lifecycle fixture failed: ' + $Stage + '.') }
    }
    function New-LifecycleProcessStart([string] $Source) {
        $start = [Diagnostics.ProcessStartInfo]::new([Environment]::ProcessPath)
        $start.UseShellExecute = $false; $start.CreateNoWindow = $true
        $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true
        $start.Environment.Clear()
        foreach ($key in @('SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'ProgramFiles', 'PSModulePath')) {
            $value = [Environment]::GetEnvironmentVariable($key)
            if ($null -ne $value) { $start.Environment[$key] = $value }
        }
        foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Source)))) {
            $start.ArgumentList.Add($argument)
        }
        return $start
    }
    function Start-LifecycleChild {
        $source = @'
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
$command = [Console]::ReadLine()
if ($command -ceq 'exit0') { exit 0 }
if ($command -ceq 'exit7') { exit 7 }
if ($command -ceq 'exitCrashCode') { exit -1073741819 } # Explicit exit-code projection, not an actual crash.
exit 9
'@
        $child = [Diagnostics.Process]::Start((New-LifecycleProcessStart $source))
        try {
            $ready = $child.StandardOutput.ReadLineAsync()
            Check ($ready.Wait(5000) -and $ready.GetAwaiter().GetResult() -ceq 'ready') 'child-ready'
            return $child
        } catch { if (-not $child.HasExited) { $child.Kill(); [void] $child.WaitForExit(5000) }; $child.Dispose(); throw }
    }
    function Close-LifecycleChild($Child, [bool] $AlreadyDisposed = $false) {
        if (-not $Child -or $AlreadyDisposed) { return }
        try {
            if (-not $Child.HasExited) {
                # A failed child can close its pipe before HasExited changes.
                # Cleanup still waits/kills this owned handle, then disposes it.
                try { $Child.StandardInput.WriteLine('exit0'); $Child.StandardInput.Flush() } catch { }
                if (-not $Child.WaitForExit(5000)) { $Child.Kill(); [void] $Child.WaitForExit(5000) }
            }
        } finally { $Child.Dispose() }
    }
    function Read-LifecycleInventory([uint32[]] $Wanted) {
        Check ($Wanted.Count -in @(2, 3, 4) -and @($Wanted | Select-Object -Unique).Count -eq $Wanted.Count) 'inventory-identities'
        # CIM's operation timeout is not a wall bound. Isolate only inventory
        # acquisition; the main fixture keeps ownership of its waiting children.
        # The worker launches no children and emits at most four numeric rows.
        $source = '$wanted = @(' + ($Wanted -join ',') + "); `$ErrorActionPreference = 'Stop'`n" + @'
try {
    $filter = ($wanted | ForEach-Object { 'ProcessId = ' + $_ }) -join ' OR '
    $rows = @(Get-CimInstance Win32_Process -Filter $filter -Property ProcessId, ParentProcessId, CreationDate -OperationTimeoutSec 2 -ErrorAction Stop |
        Where-Object { $wanted -contains [uint32] $_.ProcessId } | ForEach-Object {
            @{ ProcessId = [uint32] $_.ProcessId; ParentProcessId = [uint32] $_.ParentProcessId
                creationUtcTicks = $_.CreationDate.ToUniversalTime().Ticks }
        })
    if ($rows.Count -ne $wanted.Count) { exit 2 }
    $json = ConvertTo-Json -InputObject $rows -Compress -Depth 3
    if ($json.Length -gt 2048) { exit 2 }
    [Console]::Out.Write($json); [Console]::Out.Flush(); exit 0
} catch { exit 2 }
'@
        $start = New-LifecycleProcessStart $source; $start.RedirectStandardError = $true
        $worker = $null; $failed = $true; $watch = [Diagnostics.Stopwatch]::StartNew()
        try {
            $worker = [Diagnostics.Process]::Start($start)
            $output = [MorrowObservationFixture.NativeCounter]::CaptureAsync($worker.StandardOutput, 4096)
            $errors = [MorrowObservationFixture.NativeCounter]::CaptureAsync($worker.StandardError, 1024)
            Check ($worker.WaitForExit([Math]::Max(0, 5000 - [int] $watch.ElapsedMilliseconds))) 'inventory-deadline'
            $drained = [Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]] @($output, $errors))
            Check ($drained.Wait([Math]::Max(0, 5000 - [int] $watch.ElapsedMilliseconds))) 'inventory-drain'
            Check ($worker.ExitCode -eq 0 -and $errors.GetAwaiter().GetResult().Length -eq 0) 'inventory-worker'
            $rows = @(ConvertFrom-Json -InputObject ($output.GetAwaiter().GetResult()) -AsHashtable)
            Check ($rows.Count -eq $Wanted.Count) 'inventory-count'
            $seen = @{}; $result = @(
                foreach ($row in $rows) {
                    Check (($row.Keys | Sort-Object) -join ',' -ceq 'creationUtcTicks,ParentProcessId,ProcessId') 'inventory-fields'
                    foreach ($key in @('ProcessId', 'ParentProcessId', 'creationUtcTicks')) {
                        Check ($row[$key] -is [long] -and $row[$key] -ge 0) 'inventory-number'
                    }
                    Check ($Wanted -contains $row.ProcessId -and -not $seen.ContainsKey($row.ProcessId) -and
                        $row.ParentProcessId -le [uint32]::MaxValue -and $row.creationUtcTicks -gt 0 -and
                        $row.creationUtcTicks -le [DateTime]::MaxValue.Ticks) 'inventory-identity'
                    $seen[$row.ProcessId] = $true
                    @{ ProcessId = $row.ProcessId; ParentProcessId = $row.ParentProcessId
                        CreationDate = [DateTime]::new($row.creationUtcTicks, [DateTimeKind]::Utc) }
                }
            )
            $failed = $false; return $result
        } finally {
            if ($worker) {
                try {
                    if (-not $worker.HasExited) { $worker.Kill(); Check ($worker.WaitForExit(2000)) 'inventory-reap' }
                } catch {
                    if (-not $failed) { throw }
                    Write-Host 'Native process lifecycle inventory cleanup failed after its original error.'
                } finally { $worker.Dispose() }
            }
        }
    }
    function Start-LifecycleFamily {
        # A real parent/grandchild OS relationship, unlike the ancestry-only
        # projections above. Each process is owned, pipe-controlled and bounded.
        $source = @'
$ErrorActionPreference = 'Stop'; $child = $null
try {
    $source = "[Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); `$command = [Console]::ReadLine(); if (`$command -ceq 'exit0') { exit 0 }; if (`$command -ceq 'exit7') { exit 7 }; exit 9"
    $start = [Diagnostics.ProcessStartInfo]::new([Environment]::ProcessPath)
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.Environment.Clear()
    foreach ($key in @('SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'ProgramFiles', 'PSModulePath')) {
        $value = [Environment]::GetEnvironmentVariable($key); if ($null -ne $value) { $start.Environment[$key] = $value }
    }
    foreach ($arg in @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($source)))) { $start.ArgumentList.Add($arg) }
    $child = [Diagnostics.Process]::Start($start)
    $ready = $child.StandardOutput.ReadLineAsync()
    if (-not $ready.Wait(5000) -or $ready.GetAwaiter().GetResult() -cne 'ready') { throw 'Child readiness.' }
    [Console]::Out.WriteLine('ready:' + $child.Id + ':' + $child.StartTime.ToUniversalTime().Ticks); [Console]::Out.Flush()
    while ($true) {
        $command = [Console]::ReadLine()
        if ($command -ceq 'exit0' -or $null -eq $command) { break }
        if ($command -cnotin @('child0', 'child7') -or $null -eq $child) { throw 'Child command.' }
        $child.StandardInput.WriteLine($(if ($command -ceq 'child0') { 'exit0' } else { 'exit7' })); $child.StandardInput.Flush()
        if (-not $child.WaitForExit(5000)) { throw 'Child exit.' }
        $code = $child.ExitCode; $child.Dispose(); $child = $null
        [Console]::Out.WriteLine('released:' + $code); [Console]::Out.Flush()
    }
} finally {
    if ($child) {
        try {
            if (-not $child.HasExited) {
                try { $child.StandardInput.WriteLine('exit0'); $child.StandardInput.Flush() } catch { }
                if (-not $child.WaitForExit(5000)) { $child.Kill(); [void] $child.WaitForExit(2000) }
            }
        } finally { $child.Dispose() }
    }
}
'@
        $family = @{ parent = $null; child = $null; parentDisposed = $false; childDisposed = $false; childId = 0; childTicks = 0L }
        try {
            $family.parent = [Diagnostics.Process]::Start((New-LifecycleProcessStart $source))
            $ready = $family.parent.StandardOutput.ReadLineAsync()
            Check ($ready.Wait(5000)) 'family-ready-deadline'
            $line = $ready.GetAwaiter().GetResult()
            Check ($line -cmatch '^ready:([0-9]{1,10}):([0-9]{1,19})$') 'family-ready-format'
            $family.childId = [uint32] $Matches[1]; $family.childTicks = [long] $Matches[2]
            # Retain this exact, creator-reported child only for cleanup. Close
            # it after real exit, before the collector's original-pin proof.
            $family.child = [Diagnostics.Process]::GetProcessById($family.childId); [void] $family.child.Handle
            Check ($family.child.Id -eq $family.childId -and $family.child.StartTime.ToUniversalTime().Ticks -eq $family.childTicks -and
                -not $family.child.HasExited) 'family-owned-cleanup-identity'
            return $family
        } catch { Close-LifecycleFamily $family; throw }
    }
    function Release-LifecycleFamilyChild($Family, [int] $Code) {
        Check ($Code -in @(0, 7) -and -not $Family.childDisposed) 'family-release-input'
        $Family.parent.StandardInput.WriteLine($(if ($Code -eq 0) { 'child0' } else { 'child7' })); $Family.parent.StandardInput.Flush()
        $reply = $Family.parent.StandardOutput.ReadLineAsync()
        Check ($reply.Wait(5000) -and $reply.GetAwaiter().GetResult() -ceq ('released:' + $Code)) 'family-creator-released'
        Check ($Family.child.WaitForExit(5000) -and $Family.child.ExitCode -eq $Code) 'family-child-real-exit'
        $Family.child.Dispose(); $Family.childDisposed = $true
    }
    function Close-LifecycleFamily($Family) {
        if (-not $Family) { return }
        try {
            if ($Family.parent -and -not $Family.parentDisposed) {
                try {
                    if (-not $Family.parent.HasExited) {
                        try { $Family.parent.StandardInput.WriteLine('exit0'); $Family.parent.StandardInput.Flush() } catch { }
                        if (-not $Family.parent.WaitForExit(5000)) {
                            # Only this fixture-created family's retained parent
                            # handle. Before ready handoff, the caller may not
                            # yet own a separate cleanup handle for its child.
                            $Family.parent.Kill($true)
                            Check ($Family.parent.WaitForExit(5000)) 'family-owned-tree-reap'
                        }
                    }
                } finally { $Family.parent.Dispose(); $Family.parentDisposed = $true }
            }
        } finally {
            if ($Family.child -and -not $Family.childDisposed) {
                try {
                    if (-not $Family.child.HasExited) { $Family.child.Kill(); Check ($Family.child.WaitForExit(5000)) 'family-owned-child-reap' }
                } finally { $Family.child.Dispose(); $Family.childDisposed = $true }
            }
        }
    }
    if (-not ('MorrowObservationFixture.NativeCounter' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace MorrowObservationFixture {
    public sealed class WindowStopResult {
        public Array Pins { get; internal set; }
        public bool RowRejectedAfterStop { get; internal set; }
    }
    public static class NativeCounter {
        // Reflection avoids a second copy/reference of the in-memory native
        // helper assembly. Both competing operations call its real methods.
        public static WindowStopResult StopDuringRow(object window, uint id, uint parentId, long ticks) {
            var type = window.GetType(); var start = new System.Threading.ManualResetEventSlim(false);
            Exception rowFailure = null; Array pins = null;
            var row = new System.Threading.Thread(() => {
                try { start.Wait(); type.GetMethod("ObserveRow").Invoke(window, new object[] { id, parentId, ticks, System.Diagnostics.Stopwatch.GetTimestamp() }); }
                catch (Exception error) { rowFailure = error is System.Reflection.TargetInvocationException ? error.InnerException : error; }
            }) { IsBackground = true };
            try {
                row.Start(); start.Set();
                pins = (Array)type.GetMethod("Complete").Invoke(window, new object[] { 250 });
                if (!row.Join(250)) throw new TimeoutException("Fixture row did not drain.");
                if (rowFailure != null && !(rowFailure is ObjectDisposedException)) throw new InvalidOperationException("Fixture row failed.", rowFailure);
                return new WindowStopResult { Pins = pins, RowRejectedAfterStop = rowFailure is ObjectDisposedException };
            } catch {
                if (pins != null) foreach (var pin in pins) (pin.GetType().GetProperty("Handle").GetValue(pin) as IDisposable)?.Dispose();
                throw;
            } finally { if (!row.IsAlive) start.Dispose(); }
        }
        public static async System.Threading.Tasks.Task<string> CaptureAsync(System.IO.TextReader reader, int limit) {
            char[] buffer = new char[256];
            var text = new System.Text.StringBuilder();
            int count;
            while ((count = await reader.ReadAsync(buffer, 0, buffer.Length)) != 0) {
                if (text.Length + count > limit) throw new InvalidOperationException("Fixture output limit.");
                text.Append(buffer, 0, count);
            }
            return text.ToString();
        }
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern IntPtr OpenProcess(uint rights, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);
        public static void QueryWithoutRights(uint pid) {
            // SYNCHRONIZE permits waiting, not GetProcessTimes. Query rights
            // are deliberately absent; the live owned child's DACL is unchanged.
            IntPtr handle = OpenProcess(0x00100000, false, pid);
            if (handle == IntPtr.Zero) throw new InvalidOperationException("Fixture handle did not open.");
            try {
                long creation, exit, kernel, user;
                if (GetProcessTimes(handle, out creation, out exit, out kernel, out user))
                    throw new InvalidOperationException("Fixture query unexpectedly succeeded.");
                int error = Marshal.GetLastWin32Error();
                if (error != 5) throw new InvalidOperationException("Fixture query did not return access denied.");
                throw new Win32Exception(error);
            } finally { CloseHandle(handle); }
        }
    }
}
'@
    }
    $control = $null; $child = $null; $ancestor = $null; $descendant = $null; $state = $null; $self = [Diagnostics.Process]::GetCurrentProcess()
    $facts = @{ fixtureChildDisposed = $false }
    $path = Join-Path ([IO.Path]::GetTempPath()) ('morrow-resource-lifecycle-' + [Guid]::NewGuid().ToString('N') + '.jsonl')
    try {
        $control = Start-LifecycleChild
        foreach ($case in @('alive-control', 'verified-exit-zero', 'lookup-held-exit-zero', 'stale-identity', 'counter-access-denied',
            'denied-then-exit', 'verified-exit-nonzero', 'forced-collector', 'cached-exit-zero', 'cached-identity-change', 'cached-lookup-held-exit-zero',
            'cached-root-exit-zero', 'cached-root-exit-nonzero', 'retained-descendant-new-child', 'retained-descendant-changed-parent',
            'retained-descendant-parent-nonzero', 'retained-descendant-child-nonzero', 'lookup-held-exit-nonzero',
            'native-acquire-identity-change', 'lookup-parent-exit-during-proof', 'lookup-parent-identity-during-proof', 'lookup-exited-parent-no-adoption',
            'pinned-exit-zero', 'pinned-exit-nonzero', 'projected-first-acquire-unavailable', 'projected-first-acquire-denied',
            'sibling-pinned-exit-zero', 'sibling-pinned-exit-nonzero', 'sibling-pinned-identity-change',
            'inventory-pinned-exit-zero', 'inventory-pinned-exit-nonzero', 'inventory-pinned-identity-change',
            'query-window-exit-zero', 'query-window-exit-nonzero', 'query-window-identity-change',
            'query-window-first-acquire-unavailable', 'query-window-first-acquire-denied')) {
            $facts = @{ snapshot = $false; identified = $false; released = $false; denied = $false; exitProofs = 0
                parentReleased = $false; parentIdentityChanged = $false; acquireCalls = 0; identityProofs = 0; lookupCalls = 0
                fixtureChildDisposed = $false; pinnedExitCode = $null; inventoryPins = 0; windowStopped = $false }
            $graphCase = $case -like 'retained-descendant-*'
            $proofParentCase = $case -in @('lookup-parent-exit-during-proof', 'lookup-parent-identity-during-proof')
            $proofNoAdoptionCase = $case -eq 'lookup-exited-parent-no-adoption'
            $ancestryProjected = $graphCase -or $proofParentCase -or $proofNoAdoptionCase
            if ($graphCase -or $proofParentCase) { $ancestor = Start-LifecycleChild }
            $child = Start-LifecycleChild; $childId = $child.Id
            $childTicks = $child.StartTime.ToUniversalTime().Ticks
            if ($proofNoAdoptionCase) { $descendant = Start-LifecycleChild }
            $rootCase = $case -like 'cached-root-*'; $sampleRoot = if ($rootCase) { $child } else { $self }
            $sampleRootId = [uint32] $sampleRoot.Id; $sampleRootTicks = $sampleRoot.StartTime.ToUniversalTime().Ticks
            $state = New-NativeObservationState $sampleRootId $sampleRootTicks
            $wanted = @([uint32] $self.Id, [uint32] $(if ($graphCase -or $proofParentCase) { $ancestor.Id } elseif ($proofNoAdoptionCase) { $descendant.Id } else { $control.Id }), [uint32] $childId)
            # Real Windows CIM snapshot, projected to the fixed fields used by
            # production. Only the owned fixture processes participate.
            $rows = @(Read-LifecycleInventory $wanted)
            Check ($rows.Count -eq 3 -and -not $child.HasExited -and -not $control.HasExited) ('cim-' + $case)
            if ($rootCase) { $rows = @($rows | Where-Object { $_.ProcessId -eq $childId }) }
            if ($graphCase -or $proofParentCase) {
                # Deterministic ancestry projection U -> P -> C, backed by real
                # owned handles, CIM creation times and counters. All actual OS
                # children remain owned by this fixture; this is not an actual
                # orphan/PID-reuse test. Only ParentProcessId is projected.
                ($rows | Where-Object { $_.ProcessId -eq $childId }).ParentProcessId = [uint32] $ancestor.Id
            }
            if ($proofNoAdoptionCase) {
                # Only ancestry is projected: the real owned C exits while D
                # remains alive. An exit proof for C must not authorize D.
                ($rows | Where-Object { $_.ProcessId -eq $descendant.Id }).ParentProcessId = [uint32] $childId
            }
            if ($case -in @('lookup-held-exit-zero', 'cached-lookup-held-exit-zero')) {
                $actualRow = $rows | Where-Object { $_.ProcessId -eq $childId }
                Check ($actualRow.ParentProcessId -eq $self.Id -and
                    (Test-NativeCreation $child.StartTime.ToUniversalTime().Ticks $child.StartTime.ToUniversalTime().Ticks $actualRow.CreationDate.ToUniversalTime().Ticks)) 'real-cim-child-identity'
            }
            $firstSample = $null; $middleSample = $null; $measurementStart = [Diagnostics.Stopwatch]::GetTimestamp()
            if ($case -like 'cached-*' -or $graphCase) {
                $firstRows = if ($case -eq 'cached-lookup-held-exit-zero') { @($rows | Where-Object { $_.ProcessId -ne $childId }) } else { $rows }
                $first = Get-NativeProcessSnapshot $sampleRootId $sampleRootTicks $firstRows -State $state
                Check ($null -eq $first.terminalReason -and $first.skipped -eq 0 -and $first.lifecycleEvents.Count -eq 0) ('first-snapshot-' + $case)
                $firstSample = @{ kind = 0; elapsedMs = 0.0
                    queryMs = ([Diagnostics.Stopwatch]::GetTimestamp() - $measurementStart) * 1000.0 / [Diagnostics.Stopwatch]::Frequency
                    skipped = $first.skipped; rootSkipped = $first.rootSkipped; rootExitedDuringSample = $first.rootExitedDuringSample
                    skipReasonCounts = $first.skipReasonCounts; processes = $first.processes
                    lifecycleEvents = $first.lifecycleEvents; failedRecords = $first.failedRecords }
                Check ($state.handles.Count -eq $(if ($rootCase) { 1 } elseif ($case -eq 'cached-lookup-held-exit-zero') { 2 } else { 3 })) 'cache-admission'
                if ($graphCase) {
                    Check ($state.handles[[uint32] $childId].parentPid -eq $ancestor.Id) 'retained-parent-admitted'
                    $ancestor.StandardInput.WriteLine($(if ($case -eq 'retained-descendant-parent-nonzero') { 'exit7' } else { 'exit0' }))
                    $ancestor.StandardInput.Flush(); Check ($ancestor.WaitForExit(5000)) 'retained-parent-exit'
                    $descendant = Start-LifecycleChild
                    $rows = @(Read-LifecycleInventory @([uint32] $self.Id, [uint32] $childId, [uint32] $descendant.Id))
                    # P is now genuinely exited and absent from this inventory.
                    # Retain C's verified projected lineage; introduce C -> D.
                    ($rows | Where-Object { $_.ProcessId -eq $childId }).ParentProcessId = [uint32] $ancestor.Id
                    ($rows | Where-Object { $_.ProcessId -eq $descendant.Id }).ParentProcessId = [uint32] $childId
                } else { $rows = @(Read-LifecycleInventory $wanted) }
                if ($rootCase) { $rows = @($rows | Where-Object { $_.ProcessId -eq $childId }) }
            }
            $creationProjected = $case -in @('stale-identity', 'cached-identity-change', 'retained-descendant-changed-parent', 'native-acquire-identity-change', 'lookup-parent-identity-during-proof', 'sibling-pinned-identity-change', 'inventory-pinned-identity-change', 'query-window-identity-change')
            if ($creationProjected -and $case -notin @('lookup-parent-identity-during-proof', 'sibling-pinned-identity-change', 'inventory-pinned-identity-change', 'query-window-identity-change')) {
                # Deterministic stale snapshot, not a claim of actual PID reuse.
                $staleRow = $rows | Where-Object { $_.ProcessId -eq $childId }
                $staleRow.CreationDate = $child.StartTime.AddSeconds(1)
            }
            if ($case -like 'sibling-pinned-*') {
                # Real owned siblings, ordered so C's first pin must precede
                # managed admission of the earlier sibling. No timing sleep.
                $rows = @(@($rows | Where-Object { $_.ProcessId -eq $self.Id })[0],
                    @($rows | Where-Object { $_.ProcessId -eq $control.Id })[0],
                    @($rows | Where-Object { $_.ProcessId -eq $childId })[0])
            }
            if ($case -like 'inventory-pinned-*') {
                # The later control row has not arrived when the child's
                # creator is released. Full inventory/tree admission is later.
                $rows = @(@($rows | Where-Object { $_.ProcessId -eq $self.Id })[0],
                    @($rows | Where-Object { $_.ProcessId -eq $childId })[0],
                    @($rows | Where-Object { $_.ProcessId -eq $control.Id })[0])
            }
            if ($case -eq 'retained-descendant-child-nonzero') {
                $middleAt = [Diagnostics.Stopwatch]::GetTimestamp()
                $middle = Get-NativeProcessSnapshot $sampleRootId $sampleRootTicks $rows -State $state
                Check ($null -eq $middle.terminalReason -and $middle.skipped -eq 0 -and
                    @($middle.processes | Where-Object { $_.pid -eq $descendant.Id }).Count -eq 1 -and
                    $state.handles.ContainsKey([uint32] $descendant.Id)) 'retained-new-child-before-exit'
                $middleSample = @{ kind = 0; elapsedMs = ($middleAt - $measurementStart) * 1000.0 / [Diagnostics.Stopwatch]::Frequency
                    queryMs = ([Diagnostics.Stopwatch]::GetTimestamp() - $middleAt) * 1000.0 / [Diagnostics.Stopwatch]::Frequency
                    skipped = $middle.skipped; rootSkipped = $middle.rootSkipped; rootExitedDuringSample = $middle.rootExitedDuringSample
                    skipReasonCounts = $middle.skipReasonCounts; processes = $middle.processes
                    lifecycleEvents = $middle.lifecycleEvents; failedRecords = $middle.failedRecords }
            }
            $barrier = {
                param($Phase, $Process)
                if ($Phase -eq 'snapshot') { $facts.snapshot = $true }
                if ($Phase -eq 'identified' -and $Process.Id -eq $childId) { $facts.identified = $true }
                if ($Phase -eq 'identityProof' -and [uint32] $Process -eq $childId) { $facts.identityProofs++ }
                if ($Phase -eq 'beforeLookup' -and [uint32] $Process -eq $childId) { $facts.lookupCalls++ }
                if ($case -like 'inventory-pinned-*' -and $Phase -eq 'inventoryPinned' -and [uint32] $Process -eq $childId) {
                    $facts.inventoryPins++
                    if ($case -eq 'inventory-pinned-identity-change') {
                        ($rows | Where-Object { $_.ProcessId -eq $childId }).CreationDate = $child.StartTime.AddSeconds(1)
                    } else {
                        $child.StandardInput.WriteLine($(if ($case -eq 'inventory-pinned-exit-nonzero') { 'exit7' } else { 'exit0' }))
                        $child.StandardInput.Flush()
                        if (-not $child.WaitForExit(5000)) { throw 'Inventory child did not exit at its barrier.' }
                        $facts.released = $true; $facts.pinnedExitCode = $child.ExitCode
                        $child.Dispose(); $facts.fixtureChildDisposed = $true
                    }
                }
                if ($case -like 'sibling-pinned-*' -and $Phase -eq 'identified' -and $Process.Id -eq $control.Id) {
                    if ($case -eq 'sibling-pinned-identity-change') {
                        ($rows | Where-Object { $_.ProcessId -eq $childId }).CreationDate = $child.StartTime.AddSeconds(1)
                    } else {
                        $child.StandardInput.WriteLine($(if ($case -eq 'sibling-pinned-exit-nonzero') { 'exit7' } else { 'exit0' }))
                        $child.StandardInput.Flush()
                        if (-not $child.WaitForExit(5000)) { throw 'Sibling child did not exit at its barrier.' }
                        $facts.released = $true; $facts.pinnedExitCode = $child.ExitCode
                        $child.Dispose(); $facts.fixtureChildDisposed = $true
                    }
                }
                if ($Phase -eq 'nativePinned' -and [uint32] $Process -eq $childId -and $case -in @('pinned-exit-zero', 'pinned-exit-nonzero')) {
                    $child.StandardInput.WriteLine($(if ($case -eq 'pinned-exit-nonzero') { 'exit7' } else { 'exit0' }))
                    $child.StandardInput.Flush()
                    if (-not $child.WaitForExit(5000)) { throw 'Pinned child did not exit at its barrier.' }
                    $facts.released = $true; $facts.pinnedExitCode = $child.ExitCode
                    # Release the creator's handles. The collector's first
                    # native handle remains held throughout the rejected .NET
                    # lookup and the final identity/exit proof.
                    $child.Dispose(); $facts.fixtureChildDisposed = $true
                }
                if ($Phase -eq 'exitProof') {
                    $facts.exitProofs++
                    if ($proofParentCase) {
                        if ($Process.Id -ne $ancestor.Id) { throw 'Unexpected proof parent.' }
                        if ($case -eq 'lookup-parent-identity-during-proof') {
                            # Project only a changed inventory identity after
                            # the native child proof; this is not OS PID reuse.
                            ($rows | Where-Object { $_.ProcessId -eq $ancestor.Id }).CreationDate = $ancestor.StartTime.AddSeconds(1)
                            $facts.parentIdentityChanged = $true
                        } else {
                            $ancestor.StandardInput.WriteLine('exit0'); $ancestor.StandardInput.Flush()
                            if (-not $ancestor.WaitForExit(5000)) { throw 'Proof parent did not exit at its barrier.' }
                            $facts.parentReleased = $true
                        }
                    }
                }
                $release = (($case -in @('lookup-held-exit-zero', 'cached-exit-zero', 'cached-lookup-held-exit-zero',
                    'lookup-held-exit-nonzero', 'native-acquire-identity-change', 'lookup-parent-exit-during-proof', 'lookup-parent-identity-during-proof', 'lookup-exited-parent-no-adoption') -or $rootCase) -and $Phase -eq 'snapshot') -or
                    ($case -in @('verified-exit-zero', 'verified-exit-nonzero') -and $Phase -eq 'identified' -and $Process.Id -eq $childId)
                if ($release) {
                    $child.StandardInput.WriteLine($(if ($case -in @('verified-exit-nonzero', 'cached-root-exit-nonzero', 'lookup-held-exit-nonzero')) { 'exit7' } else { 'exit0' }))
                    $child.StandardInput.Flush()
                    if (-not $child.WaitForExit(5000)) { throw 'Lifecycle child did not exit at its barrier.' }
                    $facts.released = $true
                }
                if ($case -eq 'retained-descendant-child-nonzero' -and $Phase -eq 'snapshot') {
                    $descendant.StandardInput.WriteLine('exit7'); $descendant.StandardInput.Flush()
                    if (-not $descendant.WaitForExit(5000)) { throw 'Retained descendant did not exit at its barrier.' }
                    $facts.released = $true
                }
            }.GetNewClosure()
            $acquiredPins = [Collections.Generic.List[object]]::new()
            $windowHolder = @{ window = $null; failure = $null }
            # GetNewClosure uses a dynamic module: capture script-local helpers
            # explicitly, just like the existing counter-reader callback.
            $startWindow = ${function:Start-NativeInventoryWindow}; $fixtureCheck = ${function:Check}
            $windowFactory = if ($case -like 'query-window-*') {
                {
                    param($Owner, $Cache)
                    $code = if ($case -eq 'query-window-first-acquire-unavailable') { 87 } elseif ($case -eq 'query-window-first-acquire-denied') { 5 } else { 0 }
                    try { $window = if ($code) { & $startWindow $Owner $Cache $childId $code } else { & $startWindow $Owner $Cache } }
                    catch { $windowHolder.failure = $_.Exception.GetBaseException().GetType().Name; throw }
                    $windowHolder.window = $window
                    $item = @($window.BorrowForFixture() | Where-Object { $_.Pid -eq $childId })
                    & $fixtureCheck ($item.Count -eq 1) 'native-pin-before-first-cim-row'
                    $facts.acquireCalls = 1
                    & $fixtureCheck ([object]::ReferenceEquals($item[0], $window.AcquireForRow($childId, $Owner)) -and
                        [object]::ReferenceEquals($item[0], $window.AcquireForRow($childId, $Owner))) 'native-window-first-result-never-reopened'
                    foreach ($pin in $window.BorrowForFixture()) { if ($pin.Handle) { $acquiredPins.Add($pin.Handle) } }
                    if ($case -eq 'query-window-identity-change') {
                        ($rows | Where-Object { $_.ProcessId -eq $childId }).CreationDate = $child.StartTime.AddSeconds(1)
                    } elseif ($case -in @('query-window-exit-zero', 'query-window-exit-nonzero')) {
                        $child.StandardInput.WriteLine($(if ($case -eq 'query-window-exit-nonzero') { 'exit7' } else { 'exit0' }))
                        $child.StandardInput.Flush(); & $fixtureCheck ($child.WaitForExit(5000)) 'native-window-child-exit'
                        $facts.released = $true; $facts.pinnedExitCode = $child.ExitCode
                        $child.Dispose(); $facts.fixtureChildDisposed = $true
                    }
                    return $window
                }.GetNewClosure()
            } else { $null }
            $acquire = {
                param([uint32] $CandidateId)
                if ($CandidateId -eq $childId) {
                    $facts.acquireCalls++
                    # Deterministic error-routing projections, not a claim
                    # that this live fixture PID is missing or ACL-denied.
                    if ($case -eq 'projected-first-acquire-unavailable') { throw [ComponentModel.Win32Exception]::new(87) }
                    if ($case -eq 'projected-first-acquire-denied') { throw [ComponentModel.Win32Exception]::new(5) }
                }
                $handle = [MorrowObservationIdentity.ExitProof]::Acquire($CandidateId)
                $acquiredPins.Add($handle)
                return $handle
            }.GetNewClosure()
            $readActualCounters = ${function:Read-NativeProcessCounters}
            $counter = {
                param($Process)
                if ($case -in @('counter-access-denied', 'denied-then-exit') -and $Process.Id -eq $childId) {
                    try { [MorrowObservationFixture.NativeCounter]::QueryWithoutRights([uint32] $Process.Id) }
                    catch {
                        $errorValue = $_.Exception
                        while ($errorValue.InnerException) { $errorValue = $errorValue.InnerException }
                        $facts.denied = $errorValue -is [ComponentModel.Win32Exception] -and $errorValue.NativeErrorCode -eq 5
                        if ($facts.denied -and $case -eq 'denied-then-exit') {
                            $child.StandardInput.WriteLine('exit0'); $child.StandardInput.Flush()
                            if (-not $child.WaitForExit(5000)) { throw 'Denied child did not exit at its barrier.' }
                            $facts.released = $true
                        }
                        throw
                    }
                }
                return (& $readActualCounters $Process)
            }.GetNewClosure()
            $at = [Diagnostics.Stopwatch]::GetTimestamp()
            $snapshot = Get-NativeProcessSnapshot $sampleRootId $sampleRootTicks $rows $barrier $counter $state $(if ($windowFactory) { $null } else { $acquire }) -InventoryWindowFactory $windowFactory
            if ($windowFactory) {
                Check ($null -ne $windowHolder.window) ('native-window-factory-start-' + $windowHolder.failure)
                $facts.windowStopped = $windowHolder.window.WorkerStopped; Check $facts.windowStopped 'native-window-joined-before-admission'
            }
            $facts.pinsObserved = $acquiredPins.Count
            $facts.pinsClosed = @($acquiredPins | Where-Object { $_.IsClosed }).Count
            Check ($facts.pinsObserved -eq $facts.pinsClosed) 'temporary-pins-disposed'
            $queryMs = ([Diagnostics.Stopwatch]::GetTimestamp() - $at) * 1000.0 / [Diagnostics.Stopwatch]::Frequency
            $expectedTerminal = if ($case -eq 'cached-root-exit-zero') { 0 } elseif ($case -eq 'cached-root-exit-nonzero') { 3 } else { $null }
            Check ($facts.snapshot -and $snapshot.terminalReason -eq $expectedTerminal -and -not $self.HasExited -and -not $control.HasExited) ('snapshot-' + $case)
            $sample = @{ kind = 0; elapsedMs = ($at - $measurementStart) * 1000.0 / [Diagnostics.Stopwatch]::Frequency
                queryMs = $queryMs; skipped = $snapshot.skipped; rootSkipped = $snapshot.rootSkipped
                rootExitedDuringSample = $snapshot.rootExitedDuringSample; skipReasonCounts = $snapshot.skipReasonCounts; processes = $snapshot.processes
                lifecycleEvents = $snapshot.lifecycleEvents; failedRecords = $snapshot.failedRecords }
            $sampleCount = 1 + [int] ($null -ne $firstSample) + [int] ($null -ne $middleSample)
            $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
            try {
                if ($firstSample) { Check (Write-NativeSample $stream $firstSample) }
                if ($middleSample) { Check (Write-NativeSample $stream $middleSample) }
                Check (Write-NativeSample $stream $sample)
                Check (Write-NativeSample $stream @{ kind = 1; reason = $(if ($null -eq $snapshot.terminalReason) { 0 } else { $snapshot.terminalReason })
                    samples = $sampleCount; failureStage = $snapshot.failureStage })
            } finally { $stream.Dispose() }
            $stop = @{ forced = $false; reaped = $true; exitCode = 0 }
            if ($case -eq 'forced-collector') { $stop = Stop-NativeResourceCollector $child; $child = $null; Check $stop.forced }
            $report = Read-NativeResourceReport $path $stop @{}
            Check ($report.samples.Count -eq $sampleCount -and -not $report.invalidRecords -and
                $report.rootSkipped -eq $(if ($case -eq 'cached-root-exit-nonzero') { 1 } else { 0 })) ('report-' + $case)
            # Emit only the parsed, validated numeric sample, before checking
            # expectations so a classification failure has evidence.
            Write-Host ('Native observation lifecycle: ' + (@{ case = $case; native = $true; baseline = $false
                ancestryProjected = $ancestryProjected; creationProjected = $creationProjected; inventorySource = 'native-cim-filtered-owned-pids'
                acquisitionFailureProjected = ($case -like 'projected-first-acquire-*' -or $case -like 'query-window-first-acquire-*')
                barrier = $facts; incomplete = $report.incomplete; reasons = $report.skipReasonCounts; collector = $stop
                rootAlive = (-not $sampleRoot.HasExited); controlAlive = (-not $control.HasExited) } | ConvertTo-Json -Compress -Depth 4))
            foreach ($record in $report.samples) { Write-Host ('Native observation lifecycle sample: ' + ($record | ConvertTo-Json -Compress -Depth 5)) }
            if ($case -eq 'alive-control') { Check (-not $report.incomplete -and $snapshot.processes.Count -eq 3) }
            elseif ($case -in @('verified-exit-zero', 'cached-exit-zero', 'cached-root-exit-zero', 'retained-descendant-new-child',
                'lookup-held-exit-zero', 'cached-lookup-held-exit-zero', 'pinned-exit-zero', 'sibling-pinned-exit-zero', 'inventory-pinned-exit-zero', 'query-window-exit-zero')) { Check (-not $report.incomplete -and $report.normalExitObservations -eq 1) }
            else { Check $report.incomplete }
            switch ($case) {
                { $_ -in @('sibling-pinned-exit-zero', 'sibling-pinned-exit-nonzero', 'inventory-pinned-exit-zero', 'inventory-pinned-exit-nonzero', 'query-window-exit-zero', 'query-window-exit-nonzero') } {
                    Check ($facts.fixtureChildDisposed -and $facts.released -and $facts.acquireCalls -eq 1 -and
                        $facts.identityProofs -eq 1 -and $facts.lookupCalls -eq 1 -and $facts.exitProofs -eq 1 -and
                        -not $facts.identified -and -not $state.handles.ContainsKey([uint32] $childId) -and
                        @($snapshot.processes | Where-Object { $_.pid -eq $childId }).Count -eq 0) 'early-pin-survives-earlier-sibling-admission'
                    if ($case -in @('sibling-pinned-exit-zero', 'inventory-pinned-exit-zero', 'query-window-exit-zero')) {
                        Check ($facts.pinnedExitCode -eq 0 -and $snapshot.failedRecords.Count -eq 0 -and
                            $snapshot.lifecycleEvents[0].pid -eq $childId -and
                            $snapshot.lifecycleEvents[0].startUtcTicks -eq $childTicks) 'early-pin-exact-zero-proof'
                    } else {
                        Check ($facts.pinnedExitCode -eq 7 -and $report.normalExitObservations -eq 0 -and
                            $report.skipReasonCounts.processExited -eq 1 -and $snapshot.failedRecords[0].exitCode -eq 7 -and
                            $snapshot.failedRecords[0].stage -eq 'nativeExit') 'early-pin-nonzero-stays-gap'
                    }
                }
                { $_ -in @('sibling-pinned-identity-change', 'inventory-pinned-identity-change', 'query-window-identity-change') } {
                    Check ($facts.acquireCalls -eq 1 -and $facts.identityProofs -eq 1 -and $facts.lookupCalls -eq 0 -and
                        $report.skipReasonCounts.identityMismatch -eq 1 -and $report.normalExitObservations -eq 0 -and
                        $snapshot.failedRecords[0].stage -eq 'nativeCreation' -and -not $child.HasExited) 'early-pin-changed-identity-stays-gap'
                }
                'verified-exit-zero' { Check ($facts.identified -and $facts.released -and $child.ExitCode -eq 0 -and $report.skipReasonCounts.processExited -eq 0 -and $snapshot.lifecycleEvents[0].identitySource -eq 'currentSnapshot') }
                'verified-exit-nonzero' { Check ($facts.identified -and $facts.released -and $child.ExitCode -eq 7 -and $report.skipReasonCounts.processExited -eq 1) }
                { $_ -in @('lookup-held-exit-zero', 'cached-lookup-held-exit-zero') } {
                    Check ($facts.released -and -not $facts.identified -and $facts.exitProofs -eq 1 -and -not $report.sampleGaps -and
                        $snapshot.lifecycleEvents[0].pid -eq $childId -and $snapshot.lifecycleEvents[0].identitySource -eq 'nativeLookupFallback' -and
                        $snapshot.lifecycleEvents[0].startUtcTicks -eq $child.StartTime.ToUniversalTime().Ticks -and
                        -not $state.handles.ContainsKey([uint32] $childId) -and @($snapshot.processes | Where-Object { $_.pid -eq $childId }).Count -eq 0) 'lookup-zero-not-cached-or-measured'
                }
                'stale-identity' { Check (-not $facts.identified -and -not $child.HasExited -and $report.skipReasonCounts.identityMismatch -eq 1) }
                'counter-access-denied' { Check ($facts.denied -and -not $child.HasExited -and $facts.exitProofs -eq 0 -and $report.skipReasonCounts.counterReadFailed -eq 1) }
                'denied-then-exit' { Check ($facts.denied -and $facts.identified -and $facts.released -and $child.ExitCode -eq 0 -and
                    $facts.exitProofs -eq 0 -and $report.skipReasonCounts.counterReadFailed -eq 1 -and $snapshot.failedRecords[0].errorKind -eq 'accessDenied' -and $report.normalExitObservations -eq 0) }
                'cached-exit-zero' { Check ($facts.released -and $child.ExitCode -eq 0 -and $snapshot.lifecycleEvents[0].pid -eq $childId -and
                    $snapshot.lifecycleEvents[0].identitySource -eq 'priorSnapshot' -and $snapshot.failedRecords.Count -eq 0) }
                'cached-identity-change' { Check (-not $facts.identified -and -not $child.HasExited -and $report.skipReasonCounts.identityMismatch -eq 1) }
                'lookup-held-exit-nonzero' {
                    Check ($facts.released -and -not $facts.identified -and $facts.exitProofs -eq 1 -and $report.skipReasonCounts.processExited -eq 1 -and
                        $snapshot.failedRecords[0].stage -eq 'nativeExit' -and $snapshot.failedRecords[0].exitCode -eq 7 -and $report.normalExitObservations -eq 0) 'lookup-nonzero-remains-gap'
                }
                'native-acquire-identity-change' {
                    Check ($facts.released -and -not $facts.identified -and $facts.acquireCalls -eq 1 -and $facts.identityProofs -eq 1 -and
                        $facts.lookupCalls -eq 0 -and $facts.exitProofs -eq 0 -and $report.skipReasonCounts.identityMismatch -eq 1 -and
                        $snapshot.failedRecords[0].stage -eq 'nativeCreation' -and $report.normalExitObservations -eq 0) 'lookup-changed-identity-remains-gap'
                }
                { $_ -in @('pinned-exit-zero', 'pinned-exit-nonzero') } {
                    Check ($facts.fixtureChildDisposed -and $facts.released -and -not $facts.identified -and $facts.acquireCalls -eq 1 -and
                        $facts.identityProofs -eq 1 -and $facts.lookupCalls -eq 1 -and $facts.exitProofs -eq 1 -and
                        -not $state.handles.ContainsKey([uint32] $childId) -and @($snapshot.processes | Where-Object { $_.pid -eq $childId }).Count -eq 0) 'single-pin-through-rejected-lookup'
                    if ($case -eq 'pinned-exit-zero') {
                        Check ($facts.pinnedExitCode -eq 0 -and $snapshot.lifecycleEvents[0].pid -eq $childId -and
                            $snapshot.lifecycleEvents[0].startUtcTicks -eq $childTicks -and $snapshot.lifecycleEvents[0].identitySource -eq 'nativeLookupFallback' -and
                            $snapshot.failedRecords.Count -eq 0) 'pinned-zero-proof'
                    } else {
                        Check ($facts.pinnedExitCode -eq 7 -and $report.skipReasonCounts.processExited -eq 1 -and
                            $snapshot.failedRecords[0].stage -eq 'nativeExit' -and $snapshot.failedRecords[0].exitCode -eq 7 -and
                            $report.normalExitObservations -eq 0) 'pinned-nonzero-gap'
                    }
                }
                { $_ -like 'projected-first-acquire-*' -or $_ -like 'query-window-first-acquire-*' } {
                    $expectedCode = if ($case -in @('projected-first-acquire-denied', 'query-window-first-acquire-denied')) { 5 } else { 87 }
                    $expectedKind = if ($expectedCode -eq 5) { 'accessDenied' } else { 'native' }
                    Check (-not $child.HasExited -and $facts.acquireCalls -eq 1 -and $facts.identityProofs -eq 0 -and $facts.lookupCalls -eq 0 -and
                        $facts.exitProofs -eq 0 -and $report.skipReasonCounts.processUnavailable -eq 1 -and $report.normalExitObservations -eq 0 -and
                        $snapshot.failedRecords[0].pid -eq $childId -and $snapshot.failedRecords[0].stage -eq 'nativeAcquire' -and
                        $snapshot.failedRecords[0].errorKind -eq $expectedKind -and $snapshot.failedRecords[0].errorCode -eq $expectedCode -and
                        $null -eq $snapshot.failedRecords[0].exitCode -and -not $state.handles.ContainsKey([uint32] $childId) -and
                        @($snapshot.processes | Where-Object { $_.pid -eq $childId }).Count -eq 0) 'first-acquire-failure-no-retry-or-proof'
                    $trace = $report.samples[-1].failedRecords[0].acquisition
                    Check ($trace.version -eq 1 -and $trace.nativeError -eq $expectedCode -and
                        $trace.openCompletedAtQpc -ge $trace.openStartedAtQpc) 'first-acquire-provenance-preserves-error'
                    if ($case -like 'query-window-*') {
                        Check ($trace.source -ceq 'initial-scan' -and $trace.scan -eq 1 -and
                            $trace.windowStoppedAtQpc -ge $trace.openCompletedAtQpc -and
                            $trace.cimReceivedAtQpc -ge $trace.openCompletedAtQpc) 'native-window-first-error-provenance'
                    } else { Check ($trace.source -ceq 'cim-row' -and $trace.windowStartedAtQpc -eq 0) 'row-first-error-provenance' }
                }
                'lookup-parent-exit-during-proof' {
                    Check ($facts.released -and $facts.parentReleased -and $facts.exitProofs -eq 1 -and $ancestor.ExitCode -eq 0 -and
                        $report.skipReasonCounts.parentExited -eq 1 -and $snapshot.failedRecords[0].pid -eq $childId -and
                        $snapshot.failedRecords[0].stage -eq 'parent' -and -not $state.handles.ContainsKey([uint32] $childId) -and
                        @($snapshot.lifecycleEvents | Where-Object { $_.pid -eq $childId }).Count -eq 0) 'proof-parent-exit-invalidates-child'
                }
                'lookup-parent-identity-during-proof' {
                    Check ($facts.released -and $facts.parentIdentityChanged -and $facts.exitProofs -eq 1 -and -not $ancestor.HasExited -and
                        $report.skipReasonCounts.identityMismatch -eq 1 -and $snapshot.failedRecords[0].pid -eq $childId -and
                        $snapshot.failedRecords[0].stage -eq 'parent' -and -not $state.handles.ContainsKey([uint32] $childId) -and
                        @($snapshot.lifecycleEvents | Where-Object { $_.pid -eq $childId }).Count -eq 0) 'proof-parent-identity-invalidates-child'
                }
                'lookup-exited-parent-no-adoption' {
                    Check ($facts.released -and $facts.exitProofs -eq 1 -and -not $descendant.HasExited -and
                        $report.normalExitObservations -eq 1 -and $snapshot.lifecycleEvents[0].pid -eq $childId -and
                        $snapshot.lifecycleEvents[0].identitySource -eq 'nativeLookupFallback' -and $report.skipReasonCounts.parentUnavailable -eq 1 -and
                        $snapshot.failedRecords[0].pid -eq $descendant.Id -and -not $state.handles.ContainsKey([uint32] $descendant.Id) -and
                        @($snapshot.processes | Where-Object { $_.pid -eq $descendant.Id }).Count -eq 0) 'exit-proof-does-not-authorize-descendants'
                }
                'cached-root-exit-zero' { Check ($snapshot.rootExitedDuringSample -and $report.footer.reason -eq 0 -and
                    $snapshot.lifecycleEvents[0].role -eq 'ui' -and $snapshot.lifecycleEvents[0].identitySource -eq 'priorSnapshot') }
                'cached-root-exit-nonzero' { Check ($snapshot.rootExitedDuringSample -and $report.footer.reason -eq 3 -and
                    $report.skipReasonCounts.processExited -eq 1 -and $snapshot.failedRecords[0].exitCode -eq 7) }
                'retained-descendant-changed-parent' { Check (-not $facts.identified -and $report.skipReasonCounts.identityMismatch -eq 1 -and
                    -not $state.handles.ContainsKey([uint32] $descendant.Id) -and
                    @($snapshot.processes | Where-Object { $_.pid -eq $descendant.Id }).Count -eq 0) 'changed-parent-no-adoption' }
                'retained-descendant-parent-nonzero' { Check ($ancestor.ExitCode -eq 7 -and $report.skipReasonCounts.processExited -eq 1 -and
                    @($snapshot.failedRecords | Where-Object { $_.pid -eq $ancestor.Id -and $_.exitCode -eq 7 }).Count -eq 1) 'retained-parent-nonzero' }
                'retained-descendant-child-nonzero' { Check ($facts.released -and $descendant.ExitCode -eq 7 -and
                    $report.normalExitObservations -eq 1 -and $report.skipReasonCounts.processExited -eq 1 -and
                    @($snapshot.failedRecords | Where-Object { $_.pid -eq $descendant.Id -and $_.exitCode -eq 7 }).Count -eq 1) 'retained-child-nonzero' }
            }
            if ($case -like 'inventory-pinned-*') { Check ($facts.inventoryPins -eq 1 -and $facts.acquireCalls -eq 1) 'single-pin-before-inventory-completes' }
            if ($case -in @('retained-descendant-new-child', 'retained-descendant-parent-nonzero')) {
                Check ($state.handles.ContainsKey([uint32] $descendant.Id) -and
                    @($snapshot.processes | Where-Object { $_.pid -eq $descendant.Id -and $_.parentPid -eq $childId }).Count -eq 1) 'retained-new-child-measured'
            }
            Close-NativeObservationState $state; Check ($state.handles.Count -eq 0) 'cache-disposed'; $state = $null
            Close-LifecycleChild $descendant; $descendant = $null
            Close-LifecycleChild $ancestor; $ancestor = $null
            [IO.File]::Delete($path); Close-LifecycleChild $child $facts.fixtureChildDisposed; $child = $null
        }
        # A child genuinely born after the native window starts must be pinned
        # by its worker before any CIM row requests an acquisition. This is an
        # owned fixture, not a historical-race or whole-lifetime coverage claim.
        $window = $null; $completedPins = @(); $childAlreadyDisposed = $false
        try {
            $window = [MorrowObservationIdentity.InventoryPinWindow]::Start([uint32[]] @($self.Id),
                [long[]] @($self.StartTime.ToUniversalTime().Ticks),
                [Microsoft.Win32.SafeHandles.SafeProcessHandle[]] @($self.SafeHandle),
                [uint32[]] @($self.Id, $control.Id), 62)
            $windowAt = [Diagnostics.Stopwatch]::GetTimestamp()
            $child = Start-LifecycleChild; $childId = [uint32] $child.Id; $childTicks = $child.StartTime.ToUniversalTime().Ticks
            Check ($window.WaitForPinForFixture($childId, 5000)) 'child-born-during-native-window-pinned'
            $firstPin = @($window.BorrowForFixture() | Where-Object { $_.Pid -eq $childId })[0]
            Check ($null -eq $firstPin.NativeError -and [object]::ReferenceEquals($firstPin,
                $window.AcquireForRow($childId, [uint32] $self.Id))) 'worker-first-handle-is-row-handle'
            $rows = @(Read-LifecycleInventory @([uint32] $self.Id, [uint32] $control.Id, $childId))
            $childRow = @($rows | Where-Object { $_.ProcessId -eq $childId })[0]
            $parentTicks = $self.StartTime.ToUniversalTime().Ticks
            $initial = [MorrowObservationIdentity.ExitProof]::ReadHandle($firstPin.Handle, $childId, $childRow.CreationDate.ToUniversalTime().Ticks, $parentTicks)
            Check ($initial.IdentityMatched -and $initial.Outcome -ceq 'alive' -and $initial.StartUtcTicks -eq $childTicks) 'worker-native-live-identity'
            $child.StandardInput.WriteLine('exit0'); $child.StandardInput.Flush(); Check ($child.WaitForExit(5000)) 'worker-child-zero-exit'
            $child.Dispose(); $childAlreadyDisposed = $true
            $completedPins = @($window.Complete(250)); Check $window.WorkerStopped 'worker-joined-before-proof'
            $final = [MorrowObservationIdentity.ExitProof]::ReadHandle($firstPin.Handle, $childId, $childRow.CreationDate.ToUniversalTime().Ticks, $parentTicks)
            Check ($final.ProvenZero -and $final.StartUtcTicks -eq $childTicks -and -not $self.HasExited -and
                $self.StartTime.ToUniversalTime().Ticks -eq $parentTicks) 'worker-same-pin-exact-zero-proof'
            foreach ($pin in $completedPins) { if ($pin.Handle) { $pin.Handle.Dispose() } }
            Check (@($completedPins | Where-Object { $_.Handle -and -not $_.Handle.IsClosed }).Count -eq 0) 'worker-all-transferred-pins-closed'
            Write-Host ('Native inventory window: ' + (@{ case = 'child-born-during-query'; native = $true; projection = $false
                windowStartedAtQpc = $windowAt; childStartUtcTicks = $childTicks; singleOriginalHandle = $true
                workerStopped = $window.WorkerStopped; pinsClosed = $true; exactZero = $final.ProvenZero } | ConvertTo-Json -Compress))
        } finally {
            if ($window) { $window.Dispose() }
            foreach ($pin in $completedPins) { if ($pin.Handle) { $pin.Handle.Dispose() } }
            Close-LifecycleChild $child $childAlreadyDisposed; $child = $null
        }
        # The child is genuinely born AFTER the window's initial native scan.
        # Prepare its bounded real-CIM inventory before starting the snapshot's
        # unchanged one-second admission clock; process/CIM startup must not be
        # disguised as a larger production timeout. These are same-pin lifetime
        # controls, not reproductions of the historical unknown kernel exit.
        foreach ($lateExit in @(0, 7)) {
            $lateWindow = $null; $lateState = $null; $lateChild = $null; $lateDisposed = $false; $latePins = @()
            try {
                $beforeRows = @(Read-LifecycleInventory @([uint32] $self.Id, [uint32] $control.Id))
                $lateState = New-NativeObservationState ([uint32] $self.Id) $self.StartTime.ToUniversalTime().Ticks
                $before = Get-NativeProcessSnapshot ([uint32] $self.Id) $self.StartTime.ToUniversalTime().Ticks $beforeRows -State $lateState
                Check ($before.skipped -eq 0 -and $null -eq $before.terminalReason -and $lateState.handles.Count -eq 2) 'late-born-retained-parent'
                $lateWindow = Start-NativeInventoryWindow ([uint32] $self.Id) $lateState.handles
                $lateChild = Start-LifecycleChild; $lateId = [uint32] $lateChild.Id; $lateTicks = $lateChild.StartTime.ToUniversalTime().Ticks
                Check ($lateWindow.WaitForPinForFixture($lateId, 5000)) 'late-born-worker-first-pin'
                $latePin = @($lateWindow.BorrowForFixture() | Where-Object { $_.Pid -eq $lateId })[0]
                Check ($null -eq $latePin.NativeError -and $latePin.Provenance.Source -ceq 'worker-scan' -and
                    $latePin.Provenance.Scan -ge 2 -and $latePin.Provenance.CimReceivedAtQpc -eq 0 -and
                    [object]::ReferenceEquals($latePin, $lateWindow.AcquireForRow($lateId, [uint32] $self.Id))) 'late-born-original-worker-result'
                $lateRows = @(Read-LifecycleInventory @([uint32] $self.Id, [uint32] $control.Id, $lateId))
                $lateRow = @($lateRows | Where-Object { $_.ProcessId -eq $lateId })[0]
                $live = [MorrowObservationIdentity.ExitProof]::ReadHandle($latePin.Handle, $lateId,
                    $lateRow.CreationDate.ToUniversalTime().Ticks, $self.StartTime.ToUniversalTime().Ticks)
                Check ($live.IdentityMatched -and $live.Outcome -ceq 'alive' -and $live.StartUtcTicks -eq $lateTicks) 'late-born-live-original-pin'
                $lateChild.StandardInput.WriteLine($(if ($lateExit -eq 0) { 'exit0' } else { 'exit7' })); $lateChild.StandardInput.Flush()
                Check ($lateChild.WaitForExit(5000) -and $lateChild.ExitCode -eq $lateExit) 'late-born-real-exit'
                $lateChild.Dispose(); $lateDisposed = $true
                $latePins = @($lateWindow.BorrowForFixture())
                $preparedWindow = $lateWindow
                $preparedFactory = { param($Owner, $Cache); return $preparedWindow }.GetNewClosure()
                $sampleAt = [Diagnostics.Stopwatch]::GetTimestamp()
                $lateSnapshot = Get-NativeProcessSnapshot ([uint32] $self.Id) $self.StartTime.ToUniversalTime().Ticks $lateRows -State $lateState -InventoryWindowFactory $preparedFactory
                $queryMs = ([Diagnostics.Stopwatch]::GetTimestamp() - $sampleAt) * 1000.0 / [Diagnostics.Stopwatch]::Frequency
                Check ($lateSnapshot.hasSnapshot -and $null -eq $lateSnapshot.terminalReason -and $lateWindow.WorkerStopped -and
                    @($latePins | Where-Object { $_.Handle -and -not $_.Handle.IsClosed }).Count -eq 0 -and
                    -not $lateState.handles.ContainsKey($lateId)) 'late-born-integrated-disposal'
                Check ($latePin.Provenance.CimReceivedAtQpc -gt $latePin.Provenance.OpenCompletedAtQpc -and
                    $latePin.Provenance.WindowStoppedAtQpc -ge $latePin.Provenance.CimReceivedAtQpc) 'late-born-delayed-row-same-pin'
                $lateSample = @{ kind = 0; nativeProofVersion = 1L; elapsedMs = 0.0; queryMs = $queryMs
                    skipped = $lateSnapshot.skipped; rootSkipped = $lateSnapshot.rootSkipped; rootExitedDuringSample = $lateSnapshot.rootExitedDuringSample
                    skipReasonCounts = $lateSnapshot.skipReasonCounts; processes = $lateSnapshot.processes
                    lifecycleEvents = $lateSnapshot.lifecycleEvents; failedRecords = $lateSnapshot.failedRecords }
                $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
                try {
                    Check (Write-NativeSample $stream $lateSample) 'late-born-bounded-record'
                    Check (Write-NativeSample $stream @{ kind = 1; reason = 0; samples = 1; failureStage = 'none' }) 'late-born-footer'
                } finally { $stream.Dispose() }
                $report = Read-NativeResourceReport $path @{ forced = $false; reaped = $true; exitCode = 0 } @{}
                Check (-not $report.invalidRecords -and $report.samples.Count -eq 1) 'late-born-integrated-schema'
                if ($lateExit -eq 0) {
                    $event = @($report.samples[0].lifecycleEvents | Where-Object { $_.pid -eq $lateId })
                    Check (-not $report.incomplete -and $event.Count -eq 1 -and $event[0].nativeProof.final.startUtcTicks -eq $lateTicks -and
                        $event[0].nativeProof.final.exitCode -eq 0 -and $event[0].nativeProof.final.signaled) 'late-born-exact-zero-only'
                } else {
                    $failed = @($report.samples[0].failedRecords | Where-Object { $_.pid -eq $lateId })
                    Check ($report.incomplete -and $failed.Count -eq 1 -and $failed[0].reason -ceq 'processExited' -and
                        $failed[0].exitCode -eq 7 -and $report.normalExitObservations -eq 0) 'late-born-nonzero-remains-failure'
                }
                Write-Host ('Native late-born integration: ' + (@{ case = $(if ($lateExit -eq 0) { 'zero' } else { 'nonzero' })
                    native = $true; historicalRaceReproduced = $false; projected = $false; originalPin = $true; creatorDisposed = $lateDisposed
                    workerStopped = $lateWindow.WorkerStopped; pinsClosed = $true; incomplete = $report.incomplete
                    acquisition = (ConvertTo-NativeAcquisition $latePin.Provenance) } | ConvertTo-Json -Compress -Depth 4))
                [IO.File]::Delete($path)
            } finally {
                if ($lateWindow) { $lateWindow.Dispose() }
                foreach ($pin in $latePins) { if ($pin.Handle) { $pin.Handle.Dispose() } }
                if ($lateState) { Close-NativeObservationState $lateState }
                Close-LifecycleChild $lateChild $lateDisposed
                if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) }
            }
        }
        # Newly discovered real P -> C is absent from the managed cache. P's
        # original native pin plus current CIM identity must preserve C BEFORE
        # P's managed admission, including child-before-parent row delivery.
        # Startup/CIM preparation is outside the unchanged one-second sample
        # clock; real exit and proof remain inside it. This is not a reproduction
        # of the historical PID 5800/7176 kernel exit or whole-lifetime coverage.
        foreach ($familyCase in @('child-first-zero', 'parent-first-zero', 'child-first-nonzero',
            'parent-creation-mismatch', 'parent-exited', 'parent-first87', 'parent-first5', 'child-first87', 'child-first5', 'concurrent-stop')) {
            $family = $null; $familyWindow = $null; $familyState = $null
            $familyFacts = @{ pins = @(); childPin = $null; transferredRejected = $false; parentUncached = $false }
            try {
                $beforeRows = @(Read-LifecycleInventory @([uint32] $self.Id, [uint32] $control.Id))
                $familyState = New-NativeObservationState ([uint32] $self.Id) $self.StartTime.ToUniversalTime().Ticks
                $before = Get-NativeProcessSnapshot ([uint32] $self.Id) $self.StartTime.ToUniversalTime().Ticks $beforeRows -State $familyState
                Check ($before.skipped -eq 0 -and $null -eq $before.terminalReason -and $familyState.handles.Count -eq 2) 'family-retained-root'
                $projectedError = if ($familyCase -like '*first87') { 87 } elseif ($familyCase -like '*first5') { 5 } else { 0 }
                if (-not $projectedError) { $familyWindow = Start-NativeInventoryWindow ([uint32] $self.Id) $familyState.handles }
                $family = Start-LifecycleFamily
                $familyParentId = [uint32] $family.parent.Id; $familyParentTicks = $family.parent.StartTime.ToUniversalTime().Ticks
                if ($projectedError) {
                    $projectedId = if ($familyCase -like 'parent-*') { $familyParentId } else { [uint32] $family.childId }
                    $familyWindow = Start-NativeInventoryWindow ([uint32] $self.Id) $familyState.handles $projectedId $projectedError
                }
                Check ($familyWindow.WaitForPinForFixture($familyParentId, 5000) -and
                    -not $familyWindow.WaitForPinForFixture([uint32] $family.childId, 0)) 'new-parent-cannot-authorize-without-cim'
                $familyRows = @(Read-LifecycleInventory @([uint32] $self.Id, [uint32] $control.Id, $familyParentId, [uint32] $family.childId))
                $parentRow = @($familyRows | Where-Object { $_.ProcessId -eq $familyParentId })[0]
                $childRow = @($familyRows | Where-Object { $_.ProcessId -eq $family.childId })[0]
                Check ($parentRow.ParentProcessId -eq $self.Id -and $childRow.ParentProcessId -eq $familyParentId -and
                    (Test-NativeCreation $familyParentTicks $familyParentTicks $parentRow.CreationDate.ToUniversalTime().Ticks) -and
                    (Test-NativeCreation $family.childTicks $family.childTicks $childRow.CreationDate.ToUniversalTime().Ticks)) 'family-real-cim-lineage'
                if ($familyCase -eq 'concurrent-stop') {
                    $familyWindow.ObserveRow($familyParentId, [uint32] $self.Id, $parentRow.CreationDate.ToUniversalTime().Ticks, [Diagnostics.Stopwatch]::GetTimestamp())
                    $race = [MorrowObservationFixture.NativeCounter]::StopDuringRow($familyWindow, [uint32] $family.childId,
                        $familyParentId, $childRow.CreationDate.ToUniversalTime().Ticks)
                    $familyFacts.pins = @($race.Pins)
                    Check ($familyWindow.WorkerStopped -and $familyFacts.pins.Count + 2 -le 64) 'concurrent-stop-bounded-join'
                    $rejected = $false
                    try { $familyWindow.ObserveRow([uint32]::MaxValue, $familyParentId, $family.childTicks, [Diagnostics.Stopwatch]::GetTimestamp()) }
                    catch { $rejected = $_.Exception.InnerException -is [ObjectDisposedException] }
                    Check $rejected 'concurrent-stop-no-late-promotion'
                    $familyWindow.Dispose()
                    foreach ($pin in $familyFacts.pins) { if ($pin.Handle) { $pin.Handle.Dispose() } }
                    Check (@($familyFacts.pins | Where-Object { $_.Handle -and -not $_.Handle.IsClosed }).Count -eq 0) 'concurrent-stop-transferred-pins-closed'
                    Write-Host ('Native new-parent stop race: ' + (@{ native = $true; historicalRaceReproduced = $false
                        rowRejectedAfterStop = $race.RowRejectedAfterStop; workerStopped = $true; pinsClosed = $true
                        captureCompleteClaimed = $false } | ConvertTo-Json -Compress))
                    continue
                }
                if ($familyCase -eq 'parent-creation-mismatch') { $parentRow.CreationDate = $parentRow.CreationDate.AddTicks(-10L) }
                if ($familyCase -eq 'parent-exited') { Close-LifecycleFamily $family }
                $orderedRows = @(@($familyRows | Where-Object { $_.ProcessId -eq $self.Id })[0],
                    @($familyRows | Where-Object { $_.ProcessId -eq $control.Id })[0])
                if ($familyCase -eq 'parent-first-zero') { $orderedRows += @($parentRow, $childRow) }
                else { $orderedRows += @($childRow, $parentRow) }
                $preparedFamily = $familyWindow
                $familyFactory = { param($Owner, $Cache); return $preparedFamily }.GetNewClosure()
                $familyBarrier = {
                    param($Phase, $Process)
                    if ($Phase -ne 'snapshot') { return }
                    $familyFacts.parentUncached = -not $familyState.handles.ContainsKey($familyParentId)
                    Check $familyFacts.parentUncached 'grandchild-before-managed-parent-admission'
                    $familyFacts.pins = @($familyWindow.BorrowForFixture())
                    $childPins = @($familyFacts.pins | Where-Object { $_.Pid -eq $family.childId })
                    Check ($familyWindow.WorkerStopped -and $familyFacts.pins.Count + 2 -le 64) 'family-global-pin-bound-and-stop'
                    # Transfer closes promotion authority, even before the
                    # caller disposes the original transferred handles.
                    try { $familyWindow.ObserveRow([uint32]::MaxValue, $familyParentId, $family.childTicks, [Diagnostics.Stopwatch]::GetTimestamp()) }
                    catch { $familyFacts.transferredRejected = $_.Exception.InnerException -is [ObjectDisposedException] }
                    Check $familyFacts.transferredRejected 'transferred-window-cannot-promote'
                    if ($familyCase -in @('child-first-zero', 'parent-first-zero', 'child-first-nonzero', 'child-first87', 'child-first5')) {
                        Check ($childPins.Count -eq 1) 'grandchild-first-pin-preserved'
                        $familyFacts.childPin = $childPins[0]
                        if ($projectedError) {
                            Check ($childPins[0].NativeError -eq $projectedError -and $null -eq $childPins[0].Handle -and
                                $childPins[0].Provenance.NativeError -eq $projectedError) 'grandchild-first-error-preserved'
                        } else {
                            $live = [MorrowObservationIdentity.ExitProof]::ReadHandle($childPins[0].Handle, [uint32] $family.childId,
                                $childRow.CreationDate.ToUniversalTime().Ticks, $familyParentTicks)
                            Check ($live.IdentityMatched -and $live.Outcome -ceq 'alive' -and $live.StartUtcTicks -eq $family.childTicks) 'grandchild-original-live-proof'
                            Release-LifecycleFamilyChild $family $(if ($familyCase -eq 'child-first-nonzero') { 7 } else { 0 })
                        }
                    } else { Check ($childPins.Count -eq 0) 'unproved-parent-never-authorizes-grandchild' }
                }
                $noReopen = { param($Id); throw 'An inventory first result was not retained.' }
                $sampleAt = [Diagnostics.Stopwatch]::GetTimestamp()
                $familySnapshot = Get-NativeProcessSnapshot ([uint32] $self.Id) $self.StartTime.ToUniversalTime().Ticks $orderedRows `
                    -State $familyState -InventoryWindowFactory $familyFactory -ObservationBarrier $familyBarrier -AcquireIdentity $noReopen
                $queryMs = ([Diagnostics.Stopwatch]::GetTimestamp() - $sampleAt) * 1000.0 / [Diagnostics.Stopwatch]::Frequency
                Check ($familySnapshot.hasSnapshot -and $null -eq $familySnapshot.terminalReason -and $familyFacts.parentUncached -and
                    @($familyFacts.pins | Where-Object { $_.Handle -and -not $_.Handle.IsClosed }).Count -eq 0) 'family-snapshot-and-disposal'
                $disposedRejected = $false
                try { $familyWindow.ObserveRow([uint32]::MaxValue, $familyParentId, $family.childTicks, [Diagnostics.Stopwatch]::GetTimestamp()) }
                catch { $disposedRejected = $_.Exception.InnerException -is [ObjectDisposedException] }
                Check ($disposedRejected -and $familyWindow.WorkerStopped) 'disposed-window-cannot-promote'
                $familySample = @{ kind = 0; nativeProofVersion = 1L; elapsedMs = 0.0; queryMs = $queryMs
                    skipped = $familySnapshot.skipped; rootSkipped = $familySnapshot.rootSkipped; rootExitedDuringSample = $familySnapshot.rootExitedDuringSample
                    skipReasonCounts = $familySnapshot.skipReasonCounts; processes = $familySnapshot.processes
                    lifecycleEvents = $familySnapshot.lifecycleEvents; failedRecords = $familySnapshot.failedRecords }
                $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
                try {
                    Check (Write-NativeSample $stream $familySample) 'family-bounded-record'
                    Check (Write-NativeSample $stream @{ kind = 1; reason = 0; samples = 1; failureStage = 'none' }) 'family-footer'
                } finally { $stream.Dispose() }
                $report = Read-NativeResourceReport $path @{ forced = $false; reaped = $true; exitCode = 0 } @{}
                Check (-not $report.invalidRecords -and $report.samples.Count -eq 1) 'family-integrated-schema'
                if ($familyCase -in @('child-first-zero', 'parent-first-zero')) {
                    $event = @($report.samples[0].lifecycleEvents | Where-Object { $_.pid -eq $family.childId })
                    Check (-not $report.incomplete -and $event.Count -eq 1 -and $event[0].nativeProof.final.startUtcTicks -eq $family.childTicks -and
                        $event[0].nativeProof.final.signaled -and $event[0].nativeProof.final.exitCode -eq 0) 'family-exact-zero-only'
                } elseif ($projectedError) {
                    $failed = @($report.samples[0].failedRecords | Where-Object { $_.pid -eq $projectedId })
                    Check ($report.incomplete -and $failed.Count -eq 1 -and $failed[0].stage -ceq 'nativeAcquire' -and
                        $failed[0].errorCode -eq $projectedError -and $null -eq $failed[0].exitCode -and
                        $failed[0].acquisition.nativeError -eq $projectedError -and $report.normalExitObservations -eq 0) 'family-first-error-not-retried-or-normalized'
                } elseif ($familyCase -eq 'child-first-nonzero') {
                    $failed = @($report.samples[0].failedRecords | Where-Object { $_.pid -eq $family.childId })
                    Check ($report.incomplete -and $failed.Count -eq 1 -and $failed[0].reason -ceq 'processExited' -and
                        $failed[0].exitCode -eq 7 -and $report.normalExitObservations -eq 0) 'family-nonzero-remains-failure'
                } else {
                    Check ($report.incomplete -and -not $familyState.handles.ContainsKey([uint32] $family.childId) -and
                        @($report.samples[0].lifecycleEvents | Where-Object { $_.pid -eq $family.childId }).Count -eq 0) 'family-unproved-parent-no-adoption'
                }
                Write-Host ('Native new-parent integration: ' + (@{ case = $familyCase; native = $true; historicalRaceReproduced = $false
                    ancestryProjected = $false; creationProjected = ($familyCase -eq 'parent-creation-mismatch'); acquisitionErrorProjected = $projectedError
                    managedParentUncached = $familyFacts.parentUncached; workerStopped = $familyWindow.WorkerStopped; pinsClosed = $true
                    transferRejected = $familyFacts.transferredRejected; disposalRejected = $disposedRejected; incomplete = $report.incomplete } | ConvertTo-Json -Compress))
                [IO.File]::Delete($path)
            } finally {
                if ($familyWindow) { $familyWindow.Dispose() }
                foreach ($pin in $familyFacts.pins) { if ($pin.Handle) { $pin.Handle.Dispose() } }
                if ($familyState) { Close-NativeObservationState $familyState }
                Close-LifecycleFamily $family
                if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) }
            }
        }
        Test-NativePinnedExitWait $control $self
    } finally {
        if ($state) { Close-NativeObservationState $state }
        try { Close-LifecycleChild $descendant }
        finally {
            try { Close-LifecycleChild $ancestor }
            finally {
                try { Close-LifecycleChild $child $facts.fixtureChildDisposed }
                finally {
                    try { Close-LifecycleChild $control }
                    finally { $self.Dispose(); if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) } }
                }
            }
        }
    }
}
