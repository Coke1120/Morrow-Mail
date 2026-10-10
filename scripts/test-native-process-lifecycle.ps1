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
        Check ($Wanted.Count -eq 3 -and @($Wanted | Select-Object -Unique).Count -eq 3) 'inventory-identities'
        # CIM's operation timeout is not a wall bound. Isolate only inventory
        # acquisition; the main fixture keeps ownership of its waiting children.
        # The worker launches no children and emits only three numeric rows.
        $source = '$wanted = @(' + ($Wanted -join ',') + "); `$ErrorActionPreference = 'Stop'`n" + @'
try {
    $filter = ($wanted | ForEach-Object { 'ProcessId = ' + $_ }) -join ' OR '
    $rows = @(Get-CimInstance Win32_Process -Filter $filter -Property ProcessId, ParentProcessId, CreationDate -OperationTimeoutSec 2 -ErrorAction Stop |
        Where-Object { $wanted -contains [uint32] $_.ProcessId } | ForEach-Object {
            @{ ProcessId = [uint32] $_.ProcessId; ParentProcessId = [uint32] $_.ParentProcessId
                creationUtcTicks = $_.CreationDate.ToUniversalTime().Ticks }
        })
    if ($rows.Count -ne 3) { exit 2 }
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
            Check ($rows.Count -eq 3) 'inventory-count'
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
    if (-not ('MorrowObservationFixture.NativeCounter' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace MorrowObservationFixture {
    public static class NativeCounter {
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
            'pinned-exit-zero', 'pinned-exit-nonzero', 'projected-first-acquire-unavailable', 'projected-first-acquire-denied')) {
            $facts = @{ snapshot = $false; identified = $false; released = $false; denied = $false; exitProofs = 0
                parentReleased = $false; parentIdentityChanged = $false; acquireCalls = 0; identityProofs = 0; lookupCalls = 0
                fixtureChildDisposed = $false; pinnedExitCode = $null }
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
            $creationProjected = $case -in @('stale-identity', 'cached-identity-change', 'retained-descendant-changed-parent', 'native-acquire-identity-change', 'lookup-parent-identity-during-proof')
            if ($creationProjected -and $case -ne 'lookup-parent-identity-during-proof') {
                # Deterministic stale snapshot, not a claim of actual PID reuse.
                $staleRow = $rows | Where-Object { $_.ProcessId -eq $childId }
                $staleRow.CreationDate = $child.StartTime.AddSeconds(1)
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
            $snapshot = Get-NativeProcessSnapshot $sampleRootId $sampleRootTicks $rows $barrier $counter $state $acquire
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
                acquisitionFailureProjected = ($case -like 'projected-first-acquire-*')
                barrier = $facts; incomplete = $report.incomplete; reasons = $report.skipReasonCounts; collector = $stop
                rootAlive = (-not $sampleRoot.HasExited); controlAlive = (-not $control.HasExited) } | ConvertTo-Json -Compress -Depth 4))
            foreach ($record in $report.samples) { Write-Host ('Native observation lifecycle sample: ' + ($record | ConvertTo-Json -Compress -Depth 5)) }
            if ($case -eq 'alive-control') { Check (-not $report.incomplete -and $snapshot.processes.Count -eq 3) }
            elseif ($case -in @('verified-exit-zero', 'cached-exit-zero', 'cached-root-exit-zero', 'retained-descendant-new-child',
                'lookup-held-exit-zero', 'cached-lookup-held-exit-zero', 'pinned-exit-zero')) { Check (-not $report.incomplete -and $report.normalExitObservations -eq 1) }
            else { Check $report.incomplete }
            switch ($case) {
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
                { $_ -like 'projected-first-acquire-*' } {
                    $expectedCode = if ($case -eq 'projected-first-acquire-denied') { 5 } else { 87 }
                    $expectedKind = if ($expectedCode -eq 5) { 'accessDenied' } else { 'native' }
                    Check (-not $child.HasExited -and $facts.acquireCalls -eq 1 -and $facts.identityProofs -eq 0 -and $facts.lookupCalls -eq 0 -and
                        $facts.exitProofs -eq 0 -and $report.skipReasonCounts.processUnavailable -eq 1 -and $report.normalExitObservations -eq 0 -and
                        $snapshot.failedRecords[0].pid -eq $childId -and $snapshot.failedRecords[0].stage -eq 'nativeAcquire' -and
                        $snapshot.failedRecords[0].errorKind -eq $expectedKind -and $snapshot.failedRecords[0].errorCode -eq $expectedCode -and
                        $null -eq $snapshot.failedRecords[0].exitCode -and -not $state.handles.ContainsKey([uint32] $childId) -and
                        @($snapshot.processes | Where-Object { $_.pid -eq $childId }).Count -eq 0) 'first-acquire-failure-no-retry-or-proof'
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
            if ($case -in @('retained-descendant-new-child', 'retained-descendant-parent-nonzero')) {
                Check ($state.handles.ContainsKey([uint32] $descendant.Id) -and
                    @($snapshot.processes | Where-Object { $_.pid -eq $descendant.Id -and $_.parentPid -eq $childId }).Count -eq 1) 'retained-new-child-measured'
            }
            Close-NativeObservationState $state; Check ($state.handles.Count -eq 0) 'cache-disposed'; $state = $null
            Close-LifecycleChild $descendant; $descendant = $null
            Close-LifecycleChild $ancestor; $ancestor = $null
            [IO.File]::Delete($path); Close-LifecycleChild $child $facts.fixtureChildDisposed; $child = $null
        }
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
