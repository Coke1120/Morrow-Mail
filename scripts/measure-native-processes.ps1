#requires -Version 7.2
[CmdletBinding()]
param([switch] $SelfTest)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Fixture-only observer, never packaged. The caller owns the UI and this child.
# No CIM, sampler pipe or sampler wait runs in the UI stderr drain loop.
function New-NativeSampleFile([string] $Fixture) {
    $directory = Get-Item -LiteralPath $Fixture
    if (-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        [IO.Path]::GetDirectoryName($directory.FullName).TrimEnd('\', '/') -ine [IO.Path]::GetTempPath().TrimEnd('\', '/') -or
        $directory.Name -cnotmatch '^morrow-native-check-[0-9a-f]{32}$') { throw 'Invalid observation fixture.' }
    $marker = Get-Item -LiteralPath (Join-Path $Fixture 'disposable-native-fixture')
    if (($marker.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $marker.Length -gt 64 -or
        [IO.File]::ReadAllText($marker.FullName) -cne 'Morrow native acceptance fixture') { throw 'Invalid observation marker.' }
    $path = Join-Path $Fixture ('native-resources-' + [Guid]::NewGuid().ToString('N') + '.jsonl')
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
    }
    # Apply the DACL atomically at creation. An ordinary FileAccess.Write handle
    # lacks WRITE_DAC and cannot be passed to FileStream.SetAccessControl.
    $rights = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Synchronize
    $stream = [IO.FileSystemAclExtensions]::Create([IO.FileInfo]::new($path), [IO.FileMode]::CreateNew,
        $rights, [IO.FileShare]::Read, 4096, [IO.FileOptions]::None, $acl)
    $stream.Dispose()
    return $path
}

function Start-NativeResourceCollector([Diagnostics.Process] $Ui, [string] $Path, [long] $LaunchTimestamp) {
    $start = [Diagnostics.ProcessStartInfo]::new([Environment]::ProcessPath)
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', (Join-Path $PSScriptRoot 'measure-native-processes.ps1'))) {
        $start.ArgumentList.Add($argument)
    }
    Isolate-NativeEnvironment $start
    $start.Environment['MORROW_SAMPLE_PID'] = $Ui.Id.ToString([Globalization.CultureInfo]::InvariantCulture)
    $start.Environment['MORROW_SAMPLE_START'] = $Ui.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
    $start.Environment['MORROW_SAMPLE_LAUNCH'] = $LaunchTimestamp.ToString([Globalization.CultureInfo]::InvariantCulture)
    $start.Environment['MORROW_SAMPLE_FILE'] = $Path
    return [Diagnostics.Process]::Start($start)
}

function Stop-NativeResourceCollector([Diagnostics.Process] $Collector) {
    $forced = $false; $reaped = $true; $exitCode = $null
    if ($Collector) {
        try {
            if (-not $Collector.WaitForExit(2000)) {
                $forced = $true
                $Collector.Kill() # This process handle only, never Kill(true)/name/tree.
                $reaped = $Collector.WaitForExit(2000)
            }
            if ($reaped) { $exitCode = $Collector.ExitCode }
        } catch { $reaped = $false }
        finally { $Collector.Dispose() }
    }
    return @{ forced = $forced; reaped = $reaped; exitCode = $exitCode }
}

function Test-NativeCreation([long] $Actual, [long] $Expected, [long] $CimTicks) {
    # WMI dates have microsecond precision; Process.StartTime is the persisted
    # identity in 100 ns UTC ticks. Never convert these large integers to double.
    return $Actual -eq $Expected -and ($Actual - $Actual % 10L) -eq ($CimTicks - $CimTicks % 10L)
}

function Get-NativeTree([object[]] $Rows, [uint32] $Root, [long] $RootTicks) {
    if ($Rows.Count -gt 8192) { throw 'Process inventory limit.' }
    $byId = @{}; $children = @{}
    foreach ($row in $Rows) {
        $id = [uint32] $row.ProcessId; $parentId = [uint32] $row.ParentProcessId
        if ($byId.ContainsKey($id)) { throw 'Duplicate process identity.' }
        $byId[$id] = $row
        if (-not $children.ContainsKey($parentId)) { $children[$parentId] = [Collections.Generic.List[object]]::new() }
        $children[$parentId].Add($row)
    }
    if (-not $byId.ContainsKey($Root)) { return }
    $rootRow = $byId[$Root]
    if ($null -eq $rootRow.CreationDate -or -not (Test-NativeCreation $RootTicks $RootTicks $rootRow.CreationDate.ToUniversalTime().Ticks)) { throw 'Root identity changed.' }
    $queue = [Collections.Generic.Queue[object]]::new(); $queue.Enqueue($rootRow)
    $seen = @{}
    while ($queue.Count) {
        $row = $queue.Dequeue(); $id = [uint32] $row.ProcessId
        if ($seen.ContainsKey($id) -or $seen.Count -eq 64) { throw 'Descendant limit or cycle.' }
        $seen[$id] = $true
        $row
        if ($children.ContainsKey($id)) {
            foreach ($child in $children[$id]) {
                if ($child.CreationDate -and $child.CreationDate.ToUniversalTime().Ticks -ge $row.CreationDate.ToUniversalTime().Ticks) { $queue.Enqueue($child) }
            }
        }
    }
}

function Write-NativeSample([IO.Stream] $Stream, $Value) {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Compress -Depth 5) + "`n")
    $limit = if ($Value.kind -eq 0) { 2MB - 512 } else { 2MB }
    if ($bytes.Length -gt 32KB -or $Stream.Position + $bytes.Length -gt $limit) { return $false }
    $Stream.Write($bytes, 0, $bytes.Length); $Stream.Flush()
    return $true
}

function New-NativeSkipReasonCounts {
    # Fixed vocabulary only. An unavailable handle is not proof of process exit.
    return @{ parentUnavailable = 0L; parentExited = 0L; processUnavailable = 0L; processExited = 0L
        identityMismatch = 0L; counterReadFailed = 0L; unclassified = 0L }
}

function Read-NativeProcessCounters([Diagnostics.Process] $Process) {
    return @{ workingSetBytes = $Process.WorkingSet64; privateBytes = $Process.PrivateMemorySize64
        cpuMs = $Process.TotalProcessorTime.TotalMilliseconds }
}

function New-NativeObservationState([uint32] $Root, [long] $RootTicks) {
    return @{ root = $Root; rootTicks = $RootTicks; handles = @{} }
}

function Close-NativeObservationState([Collections.IDictionary] $State) {
    foreach ($entry in $State.handles.Values) { $entry.process.Dispose() }
    $State.handles.Clear()
}

function Add-NativeObservationFailure($Sample, $Row, [uint32] $Root, [string] $Source,
    [string] $Reason, [string] $Stage, $Failure = $null, $ExitCode = $null) {
    $kind = 'none'; $code = $null
    if ($Failure) {
        while ($Failure.InnerException) { $Failure = $Failure.InnerException }
        if ($Failure -is [ComponentModel.Win32Exception]) {
            $code = $Failure.NativeErrorCode
            $kind = if ($code -eq 5) { 'accessDenied' } else { 'native' }
        } elseif ($Failure -is [UnauthorizedAccessException]) { $kind = 'accessDenied'; $code = 5 }
        elseif ($Failure -is [ArgumentException]) { $kind = 'argument' }
        elseif ($Failure -is [InvalidOperationException]) { $kind = 'invalidOperation' }
        else { $kind = 'other' }
    }
    $Sample.skipped++; $Sample.skipReasonCounts[$Reason]++
    if ([uint32] $Row.ProcessId -eq $Root) { $Sample.rootSkipped++ }
    $Sample.failedRecords.Add([ordered]@{ pid = [uint32] $Row.ProcessId; parentPid = [uint32] $Row.ParentProcessId
        cimStartUtcTicks = $Row.CreationDate.ToUniversalTime().Ticks; source = $Source
        reason = $Reason; stage = $Stage; errorKind = $kind; errorCode = $code; exitCode = $ExitCode })
}

function Get-NativeProcessSnapshot([uint32] $Root, [long] $RootTicks, [object[]] $SnapshotRows = $null,
    [scriptblock] $ObservationBarrier = $null, [scriptblock] $ReadCounters = $null,
    [Collections.IDictionary] $State = $null) {
    # A collector owns this bounded cache until its finally block. Retaining the
    # original handle preserves exit evidence; a missing PID is never that proof.
    # Fixture barriers are direct arguments, never environment/app switches.
    $ownsState = $null -eq $State
    if ($ownsState) { $State = New-NativeObservationState $Root $RootTicks }
    $cache = $State.handles; $entries = [Collections.Generic.List[object]]::new(); $stage = 'root'
    $sample = [ordered]@{ terminalReason = $null; failureStage = 'none'; hasSnapshot = $false; skipped = 0; rootSkipped = 0
        rootExitedDuringSample = $null; skipReasonCounts = (New-NativeSkipReasonCounts); processes = @()
        lifecycleEvents = [Collections.Generic.List[object]]::new(); failedRecords = [Collections.Generic.List[object]]::new() }
    try {
        if ($State.root -ne $Root -or $State.rootTicks -ne $RootTicks) { throw 'Observation owner changed.' }
        if (-not $cache.ContainsKey($Root)) {
            $rootProcess = [Diagnostics.Process]::GetProcessById($Root)
            try {
                [void] $rootProcess.Handle
                if ($rootProcess.StartTime.ToUniversalTime().Ticks -ne $RootTicks) { throw 'Root identity changed.' }
                $cache[$Root] = @{ process = $rootProcess; ticks = $RootTicks; parentPid = 0; parentTicks = 0
                    cimTicks = $RootTicks; role = 'ui'; exitRecorded = $false; seen = $false }
            } catch { $rootProcess.Dispose(); throw }
        }
        $rootEntry = $cache[$Root]; $rootExited = $rootEntry.process.HasExited
        $rootIdentitySource = if ($rootEntry.seen) { 'priorSnapshot' } else { 'currentSnapshot' }
        $stage = 'cim'
        $rows = if ($rootExited) { @() } elseif ($null -eq $SnapshotRows) {
            @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate -OperationTimeoutSec 2 -ErrorAction Stop)
        } else { $SnapshotRows }
        $stage = 'tree'; $byId = @{}
        if (@($rows).Count -gt 8192) { throw 'Process inventory limit.' }
        foreach ($row in $rows) {
            $id = [uint32] $row.ProcessId
            if ($byId.ContainsKey($id)) { throw 'Duplicate process identity.' }
            $byId[$id] = $row
        }
        $tree = if ($byId.ContainsKey($Root)) { @(Get-NativeTree $rows $Root $RootTicks) } else { @() }
        # Previously verified descendants remain owned after a parent exits.
        # New descendants still need a current, live, verified parent admission.
        $candidates = [Collections.Generic.List[object]]::new(); $selected = @{}
        foreach ($row in $tree) { $candidates.Add(@{ row = $row; source = 'cim' }); $selected[[uint32] $row.ProcessId] = $true }
        foreach ($id in @($cache.Keys)) {
            if ($selected.ContainsKey($id)) { continue }
            $known = $cache[$id]
            $row = if ($byId.ContainsKey($id)) { $byId[$id] } else {
                @{ ProcessId = $id; ParentProcessId = $known.parentPid; CreationDate = [DateTime]::new($known.cimTicks, [DateTimeKind]::Utc) }
            }
            $candidates.Add(@{ row = $row; source = $(if ($byId.ContainsKey($id)) { 'cim' } else { 'retained' }) })
        }
        if ($candidates.Count -gt 64) { throw 'Descendant limit.' }
        $sample.hasSnapshot = $true; $rejected = @{}
        if (-not $rootExited -and -not $byId.ContainsKey($Root)) {
            $row = @{ ProcessId = $Root; ParentProcessId = $rootEntry.parentPid; CreationDate = [DateTime]::new($rootEntry.cimTicks, [DateTimeKind]::Utc) }
            Add-NativeObservationFailure $sample $row $Root retained processUnavailable inventory
            $rejected[$Root] = $true
        }
        if ($ObservationBarrier) { [void] (& $ObservationBarrier 'snapshot' $null) }
        $admitted = [Collections.Generic.List[object]]::new()
        # Admit every handle before reading any counters, reducing the CIM-to-
        # handle race without weakening failures for a first-seen missing child.
        foreach ($candidate in $candidates) {
            $row = $candidate.row; $id = [uint32] $row.ProcessId; $parentId = [uint32] $row.ParentProcessId
            if ($rejected.ContainsKey($id)) { continue }
            $skipReason = 'counterReadFailed'; $failureStage = 'identity'; $newProcess = $null
            try {
                if ($cache.ContainsKey($id)) {
                    $known = $cache[$id]
                    if (-not (Test-NativeCreation $known.ticks $known.ticks $row.CreationDate.ToUniversalTime().Ticks) -or
                        ($known.seen -and $known.parentPid -ne $parentId)) {
                        $skipReason = 'identityMismatch'; throw 'Changed cached identity.'
                    }
                    if ($id -eq $Root -and -not $known.seen) { $known.parentPid = $parentId }
                } else {
                    $failureStage = 'parent'; $skipReason = 'parentUnavailable'
                    if (-not $cache.ContainsKey($parentId) -or $rejected.ContainsKey($parentId)) { throw 'Parent was not verified.' }
                    $parent = $cache[$parentId]; $skipReason = 'parentExited'
                    if ($parent.process.HasExited) { throw 'Parent exited before child admission.' }
                    if ($cache.Count -ge 64) { $failureStage = 'inventory'; $skipReason = 'counterReadFailed'; throw 'Handle cache limit.' }
                    $failureStage = 'lookup'; $skipReason = 'processUnavailable'
                    $newProcess = [Diagnostics.Process]::GetProcessById($id)
                    $failureStage = 'handle'; [void] $newProcess.Handle
                    $failureStage = 'identity'; $skipReason = 'counterReadFailed'
                    $ticks = $newProcess.StartTime.ToUniversalTime().Ticks
                    if (-not (Test-NativeCreation $ticks $ticks $row.CreationDate.ToUniversalTime().Ticks) -or $ticks -lt $parent.ticks) {
                        $skipReason = 'identityMismatch'; throw 'Changed process identity.'
                    }
                    $failureStage = 'role'
                    $role = if ($newProcess.ProcessName -ieq 'morrow-service') { 'service' } elseif ($newProcess.ProcessName -ieq 'msedgewebview2') { 'webview' } else { 'other' }
                    $known = @{ process = $newProcess; ticks = $ticks; parentPid = $parentId; parentTicks = $parent.ticks
                        cimTicks = $row.CreationDate.ToUniversalTime().Ticks; role = $role; exitRecorded = $false; seen = $false }
                    $cache[$id] = $known; $newProcess = $null
                }
                if ($id -ne $Root -and $byId.ContainsKey($parentId) -and
                    -not (Test-NativeCreation $known.parentTicks $known.parentTicks $byId[$parentId].CreationDate.ToUniversalTime().Ticks)) {
                    $skipReason = 'identityMismatch'; throw 'Changed parent identity.'
                }
                if ($ObservationBarrier) { [void] (& $ObservationBarrier 'identified' $known.process) }
                $identitySource = if ($known.seen) { 'priorSnapshot' } else { 'currentSnapshot' }
                if ($candidate.source -eq 'cim') { $known.cimTicks = $row.CreationDate.ToUniversalTime().Ticks }
                $known.seen = $true; $admitted.Add(@{ row = $row; source = $candidate.source; identitySource = $identitySource; entry = $known })
            } catch {
                $rejected[$id] = $true
                Add-NativeObservationFailure $sample $row $Root $candidate.source $skipReason $failureStage $_.Exception
            } finally { if ($newProcess) { $newProcess.Dispose() } }
        }
        foreach ($item in $admitted) {
            $known = $item.entry; $process = $known.process; $row = $item.row; $id = [uint32] $row.ProcessId
            $failureStage = 'exit'; $skipReason = 'counterReadFailed'; $exitCode = $null
            try {
                $phase = 'beforeCounters'; $exited = $process.HasExited
                if (-not $exited) {
                    $failureStage = 'counters'; $process.Refresh()
                    $counters = if ($ReadCounters) { & $ReadCounters $process } else { Read-NativeProcessCounters $process }
                    $entries.Add([ordered]@{ pid = $id; parentPid = [uint32] $known.parentPid; startUtcTicks = $known.ticks; role = $known.role
                        workingSetBytes = $counters.workingSetBytes; privateBytes = $counters.privateBytes; cpuMs = $counters.cpuMs })
                    $failureStage = 'exit'; $phase = 'afterCounters'; $exited = $process.HasExited
                }
                if ($exited) {
                    $exitCode = $process.ExitCode; $skipReason = 'processExited'
                    if ($exitCode -ne 0) { throw 'Process exited unsuccessfully.' }
                    $sample.lifecycleEvents.Add([ordered]@{ pid = $id; parentPid = [uint32] $known.parentPid; startUtcTicks = $known.ticks
                        role = $known.role; exitCode = 0; phase = $phase; source = $item.source; identitySource = $item.identitySource })
                    $known.exitRecorded = $true
                }
            } catch {
                # Preserve the failing operation even if the same process exits
                # later. In particular an access denial never becomes normal.
                if ($null -eq $exitCode) { try { if ($process.HasExited) { $exitCode = $process.ExitCode } } catch { } }
                Add-NativeObservationFailure $sample $row $Root $item.source $skipReason $failureStage $_.Exception $exitCode
            }
        }
        $sample.rootExitedDuringSample = $rootEntry.process.HasExited
        if ($sample.rootExitedDuringSample) {
            $sample.terminalReason = if ($rootEntry.process.ExitCode -eq 0) { 0 } else { 3 }
            if ($sample.terminalReason -ne 0) { $sample.failureStage = 'root' }
            elseif (-not $sample.rootSkipped -and -not @($sample.lifecycleEvents | Where-Object { $_.pid -eq $Root }).Count) {
                $sample.lifecycleEvents.Add([ordered]@{ pid = $Root; parentPid = [uint32] $rootEntry.parentPid; startUtcTicks = $RootTicks
                    role = 'ui'; exitCode = 0; phase = 'afterSnapshot'; source = 'retained'; identitySource = $rootIdentitySource })
            }
        }
        foreach ($id in @($cache.Keys)) {
            if ($id -ne $Root -and $cache[$id].exitRecorded -and -not $byId.ContainsKey($id)) {
                $cache[$id].process.Dispose(); [void] $cache.Remove($id)
            }
        }
        $sample.processes = @($entries.ToArray())
    } catch { $sample.terminalReason = 3; $sample.failureStage = $stage }
    finally {
        $sample.lifecycleEvents = @($sample.lifecycleEvents.ToArray()); $sample.failedRecords = @($sample.failedRecords.ToArray())
        if ($ownsState) { Close-NativeObservationState $State }
    }
    return $sample
}

function Invoke-NativeResourceCollector {
    if (-not $IsWindows) { throw 'Windows observation only.' }
    $root = [uint32]::Parse($env:MORROW_SAMPLE_PID, [Globalization.CultureInfo]::InvariantCulture)
    $rootTicks = [long]::Parse($env:MORROW_SAMPLE_START, [Globalization.CultureInfo]::InvariantCulture)
    $launch = [long]::Parse($env:MORROW_SAMPLE_LAUNCH, [Globalization.CultureInfo]::InvariantCulture)
    if ($root -le 1 -or $rootTicks -le 0 -or $launch -le 0 -or $launch -gt [Diagnostics.Stopwatch]::GetTimestamp()) { throw 'Invalid observation identity.' }
    $file = Get-Item -LiteralPath $env:MORROW_SAMPLE_FILE
    $parent = $file.Directory
    if ($file.PSIsContainer -or $file.Length -ne 0 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.Name -cnotmatch '^native-resources-[0-9a-f]{32}\.jsonl$' -or
        $parent.Name -cnotmatch '^morrow-native-check-[0-9a-f]{32}$' -or
        $parent.Parent.FullName.TrimEnd('\', '/') -ine [IO.Path]::GetTempPath().TrimEnd('\', '/')) { throw 'Invalid observation file.' }
    # Existing caller-created protected file; no Create/Append/truncation fallback.
    $stream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $count = 0; $reason = 1; $failureStage = 'none'; $state = New-NativeObservationState $root $rootTicks
    try {
        while ($count -lt 180) {
            $at = [Diagnostics.Stopwatch]::GetTimestamp()
            $elapsed = ($at - $launch) * 1000.0 / [Diagnostics.Stopwatch]::Frequency
            if ($elapsed -ge 180000) { break }
            $stage = 'sample'
            try {
                $snapshot = Get-NativeProcessSnapshot $root $rootTicks -State $state
                if (-not $snapshot.hasSnapshot) { $reason = $snapshot.terminalReason; $failureStage = $snapshot.failureStage; break }
                $finished = [Diagnostics.Stopwatch]::GetTimestamp()
                if (($finished - $launch) * 1000.0 / [Diagnostics.Stopwatch]::Frequency -ge 180000) { break }
                $sample = [ordered]@{ kind = 0; elapsedMs = $elapsed; queryMs = ($finished - $at) * 1000.0 / [Diagnostics.Stopwatch]::Frequency
                    skipped = $snapshot.skipped; rootSkipped = $snapshot.rootSkipped; rootExitedDuringSample = $snapshot.rootExitedDuringSample
                    skipReasonCounts = $snapshot.skipReasonCounts; processes = $snapshot.processes
                    lifecycleEvents = $snapshot.lifecycleEvents; failedRecords = $snapshot.failedRecords }
                if (-not (Write-NativeSample $stream $sample)) { $reason = 2; break }
                $count++
                if ($null -ne $snapshot.terminalReason) { $reason = $snapshot.terminalReason; $failureStage = $snapshot.failureStage; break }
            } catch { $reason = 3; $failureStage = $stage; break }
            # Best effort, no overlapping queries or catch-up burst. A query's
            # operation timeout is not a wall deadline; the parent owns final kill.
            $delay = 1000 - ([Diagnostics.Stopwatch]::GetTimestamp() - $at) * 1000.0 / [Diagnostics.Stopwatch]::Frequency
            if ($delay -gt 0) { Start-Sleep -Milliseconds ([int] $delay) }
        }
        [void] (Write-NativeSample $stream @{ kind = 1; reason = $reason; samples = $count; failureStage = $failureStage })
    } finally { Close-NativeObservationState $state; $stream.Dispose() }
}

function Read-NativeResourceReport([string] $Path, $Stop, $Milestones) {
    $samples = [Collections.Generic.List[object]]::new(); $footer = $null; $invalid = $false; $partial = $false
    $peakWs = 0L; $peakPrivate = 0L; $lastElapsed = -1.0; $gaps = $false
    $skipTotals = New-NativeSkipReasonCounts; $rootSkippedTotal = 0L; $unknownRootSkips = $false
    $normalExitObservations = 0L; $modernRecords = $false; $measuredRoot = $false
    $extendedSampleKeys = (@('elapsedMs', 'kind', 'processes', 'queryMs', 'rootExitedDuringSample', 'rootSkipped', 'skipped', 'skipReasonCounts') | Sort-Object) -join ','
    $lifecycleSampleKeys = (@('elapsedMs', 'failedRecords', 'kind', 'lifecycleEvents', 'processes', 'queryMs', 'rootExitedDuringSample', 'rootSkipped', 'skipped', 'skipReasonCounts') | Sort-Object) -join ','
    try {
        $file = Get-Item -LiteralPath $Path
        if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid observation file.' }
        $reader = [IO.BinaryReader]::new([IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read))
        try { $bytes = $reader.ReadBytes(2MB + 1) } finally { $reader.Dispose() }
        if ($bytes.Length -gt 2MB) { throw 'Observation limit.' }
        $end = [Array]::LastIndexOf($bytes, [byte] 10)
        $partial = $end -ne $bytes.Length - 1
        if ($end -ge 0) {
            $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes, 0, $end + 1)
            foreach ($line in $text.Split([char] 10)) {
                if (-not $line.Length) { continue }
                if ([Text.Encoding]::UTF8.GetByteCount($line) -gt 32KB -or $null -ne $footer) { throw 'Observation record limit.' }
                $row = ConvertFrom-Json -InputObject $line -AsHashtable
                if ($row.kind -eq 1) {
                    $keys = ($row.Keys | Sort-Object) -join ','
                    if ($keys -cnotin @('kind,reason,samples', 'failureStage,kind,reason,samples') -or $row.reason -isnot [long] -or $row.reason -lt 0 -or $row.reason -gt 4 -or $row.samples -ne $samples.Count) { throw 'Invalid observation footer.' }
                    $failureStage = if ($row.ContainsKey('failureStage')) { $row.failureStage } else { 'unclassified' }
                    if ($failureStage -cnotin @('none', 'root', 'cim', 'tree', 'sample', 'unclassified')) { throw 'Invalid observation stage.' }
                    $footer = @{ reason = $row.reason; samples = $row.samples; failureStage = $failureStage }; continue
                }
                $keys = ($row.Keys | Sort-Object) -join ','
                if ($samples.Count -eq 180 -or $row.kind -ne 0 -or $keys -cnotin @('elapsedMs,kind,processes,queryMs,skipped', $extendedSampleKeys, $lifecycleSampleKeys)) { throw 'Invalid observation sample.' }
                foreach ($key in @('elapsedMs', 'queryMs', 'skipped')) {
                    if ($row[$key] -isnot [ValueType] -or $row[$key] -is [bool] -or -not [double]::IsFinite($row[$key]) -or $row[$key] -lt 0 -or $row[$key] -gt 180000) { throw 'Invalid observation number.' }
                }
                $skipCounts = New-NativeSkipReasonCounts; $rootSkipped = 0L; $rootExited = $null
                if ($row.skipped -isnot [long] -or $row.skipped -gt 64) { throw 'Invalid skipped count.' }
                if ($row.ContainsKey('skipReasonCounts')) {
                    if ($row.rootSkipped -isnot [long] -or $row.rootSkipped -lt 0 -or $row.rootSkipped -gt 1 -or $row.rootSkipped -gt $row.skipped -or
                        ($null -ne $row.rootExitedDuringSample -and $row.rootExitedDuringSample -isnot [bool]) -or
                        $row.skipReasonCounts -isnot [Collections.IDictionary] -or
                        (($row.skipReasonCounts.Keys | Sort-Object) -join ',') -cne (($skipCounts.Keys | Sort-Object) -join ',')) { throw 'Invalid skip reasons.' }
                    $sum = 0L
                    foreach ($key in @($skipCounts.Keys)) {
                        $value = $row.skipReasonCounts[$key]
                        if ($value -isnot [long] -or $value -lt 0 -or $value -gt 64) { throw 'Invalid skip reason count.' }
                        $skipCounts[$key] = $value; $sum += $value
                    }
                    if ($sum -ne $row.skipped) { throw 'Skip reasons do not match skipped count.' }
                    $rootSkipped = $row.rootSkipped
                    $rootExited = $row.rootExitedDuringSample
                } else {
                    $skipCounts.unclassified = $row.skipped
                    if ($row.skipped) { $rootSkipped = $null; $unknownRootSkips = $true }
                }
                if ($row.elapsedMs -lt $lastElapsed -or $row.processes -isnot [array] -or $row.processes.Count -gt 64) { throw 'Invalid observation sequence.' }
                $identities = @{}; $sumWs = 0L; $sumPrivate = 0L
                foreach ($item in $row.processes) {
                    if (($item.Keys | Sort-Object) -join ',' -cne 'cpuMs,parentPid,pid,privateBytes,role,startUtcTicks,workingSetBytes' -or $item.role -cnotin @('ui', 'service', 'webview', 'other')) { throw 'Invalid observation fields.' }
                    foreach ($key in @('pid', 'parentPid', 'startUtcTicks', 'workingSetBytes', 'privateBytes')) {
                        if ($item[$key] -isnot [long] -or $item[$key] -lt 0) { throw 'Invalid observation integer.' }
                    }
                    if ($item.pid -le 1 -or $item.pid -gt [uint32]::MaxValue -or $item.parentPid -gt [uint32]::MaxValue -or $item.startUtcTicks -le 0 -or $item.startUtcTicks -gt [DateTime]::MaxValue.Ticks -or
                        $item.workingSetBytes -gt 1PB -or $item.privateBytes -gt 1PB -or $item.cpuMs -isnot [ValueType] -or $item.cpuMs -is [bool] -or -not [double]::IsFinite($item.cpuMs) -or $item.cpuMs -lt 0 -or $item.cpuMs -gt 1e15 -or $identities.ContainsKey($item.pid)) { throw 'Invalid process observation.' }
                    $identities[$item.pid] = $item.startUtcTicks; $sumWs += $item.workingSetBytes; $sumPrivate += $item.privateBytes
                    if ($item.role -eq 'ui') { $measuredRoot = $true }
                }
                $events = @(); $failures = @()
                if ($row.ContainsKey('lifecycleEvents')) {
                    $modernRecords = $true; $events = $row.lifecycleEvents; $failures = $row.failedRecords
                    if ($events -isnot [array] -or $events.Count -gt 64 -or $failures -isnot [array] -or $failures.Count -ne $row.skipped) { throw 'Invalid lifecycle records.' }
                    $exited = @{}; $failed = @{}; $recordReasons = New-NativeSkipReasonCounts
                    foreach ($event in $events) {
                        if (($event.Keys | Sort-Object) -join ',' -cne 'exitCode,identitySource,parentPid,phase,pid,role,source,startUtcTicks' -or
                            $event.role -cnotin @('ui', 'service', 'webview', 'other') -or
                            $event.source -cnotin @('cim', 'retained') -or $event.identitySource -cnotin @('currentSnapshot', 'priorSnapshot') -or
                            $event.phase -cnotin @('beforeCounters', 'afterCounters', 'afterSnapshot') -or
                            $event.exitCode -isnot [long] -or $event.exitCode -ne 0) { throw 'Invalid lifecycle event.' }
                        foreach ($key in @('pid', 'parentPid', 'startUtcTicks')) {
                            if ($event[$key] -isnot [long] -or $event[$key] -lt 0) { throw 'Invalid lifecycle identity.' }
                        }
                        if ($event.pid -le 1 -or $event.pid -gt [uint32]::MaxValue -or $event.parentPid -gt [uint32]::MaxValue -or
                            $event.startUtcTicks -le 0 -or $event.startUtcTicks -gt [DateTime]::MaxValue.Ticks -or $exited.ContainsKey($event.pid)) { throw 'Invalid lifecycle identity.' }
                        if ($event.phase -eq 'beforeCounters') {
                            if ($identities.ContainsKey($event.pid)) { throw 'Exited process has unexpected counters.' }
                        } elseif (-not $identities.ContainsKey($event.pid) -or $identities[$event.pid] -ne $event.startUtcTicks -or
                            ($event.phase -eq 'afterSnapshot' -and $event.role -ne 'ui')) { throw 'Lifecycle counters do not match.' }
                        $exited[$event.pid] = $true
                    }
                    foreach ($failure in $failures) {
                        if (($failure.Keys | Sort-Object) -join ',' -cne 'cimStartUtcTicks,errorCode,errorKind,exitCode,parentPid,pid,reason,source,stage' -or
                            $failure.source -cnotin @('cim', 'retained') -or -not $recordReasons.ContainsKey($failure.reason) -or
                            $failure.stage -cnotin @('inventory', 'parent', 'lookup', 'handle', 'identity', 'role', 'counters', 'exit') -or
                            $failure.errorKind -cnotin @('none', 'accessDenied', 'native', 'argument', 'invalidOperation', 'other')) { throw 'Invalid failure record.' }
                        foreach ($key in @('pid', 'parentPid', 'cimStartUtcTicks')) {
                            if ($failure[$key] -isnot [long] -or $failure[$key] -lt 0) { throw 'Invalid failure identity.' }
                        }
                        foreach ($key in @('errorCode', 'exitCode')) {
                            if ($null -ne $failure[$key] -and ($failure[$key] -isnot [long] -or $failure[$key] -lt [int]::MinValue -or $failure[$key] -gt [int]::MaxValue)) { throw 'Invalid failure code.' }
                        }
                        if ($failure.pid -le 1 -or $failure.pid -gt [uint32]::MaxValue -or $failure.parentPid -gt [uint32]::MaxValue -or
                            $failure.cimStartUtcTicks -le 0 -or $failure.cimStartUtcTicks -gt [DateTime]::MaxValue.Ticks -or
                            $failed.ContainsKey($failure.pid) -or $exited.ContainsKey($failure.pid) -or
                            ($failure.errorKind -eq 'accessDenied' -and $failure.errorCode -ne 5) -or
                            ($failure.errorKind -eq 'native' -and $null -eq $failure.errorCode) -or
                            ($failure.errorKind -in @('none', 'argument', 'invalidOperation', 'other') -and $null -ne $failure.errorCode)) { throw 'Invalid failure evidence.' }
                        $failed[$failure.pid] = $true; $recordReasons[$failure.reason]++
                    }
                    foreach ($key in @($skipCounts.Keys)) {
                        if ($recordReasons[$key] -ne $skipCounts[$key]) { throw 'Failure reasons do not match.' }
                    }
                    $normalExitObservations += $events.Count
                }
                $lastElapsed = $row.elapsedMs; $gaps = $gaps -or $row.skipped -gt 0
                foreach ($key in @($skipTotals.Keys)) { $skipTotals[$key] += $skipCounts[$key] }
                if ($null -ne $rootSkipped) { $rootSkippedTotal += $rootSkipped }
                $peakWs = [Math]::Max($peakWs, $sumWs); $peakPrivate = [Math]::Max($peakPrivate, $sumPrivate)
                $row['skipReasonCounts'] = $skipCounts; $row['rootSkipped'] = $rootSkipped; $row['rootExitedDuringSample'] = $rootExited
                $row['lifecycleEvents'] = $events; $row['failedRecords'] = $failures
                [void] $row.Remove('kind'); $row['workingSetSumBytes'] = $sumWs; $row['privateBytesSum'] = $sumPrivate
                $samples.Add($row)
            }
        }
    } catch { $invalid = $true } # Fixed status only; never retain raw CIM/JSON errors.
    return [ordered]@{ schemaVersion = 3; incomplete = ($invalid -or $partial -or $gaps -or $Stop.forced -or -not $Stop.reaped -or $Stop.exitCode -ne 0 -or $null -eq $footer -or $footer.reason -ne 0 -or $samples.Count -eq 0 -or ($modernRecords -and -not $measuredRoot))
        collector = $Stop; invalidRecords = $invalid; partialLine = $partial; sampleGaps = $gaps; footer = $footer
        skipReasonCounts = $skipTotals; rootSkipped = $(if ($unknownRootSkips) { $null } else { $rootSkippedTotal }); normalExitObservations = $normalExitObservations
        firstSampleLagMs = $(if ($samples.Count) { $samples[0].elapsedMs + $samples[0].queryMs } else { $null }); milestonesMs = $Milestones
        sampledPeakWorkingSetSumBytes = $peakWs; sampledPeakPrivateBytesSum = $peakPrivate; samples = @($samples.ToArray())
        method = 'Approximately one snapshot/second during the owned UI lifetime; verified descendants retain their original process handles and UTC creation identities. Explicit zero exits without an earlier read failure are lifecycle events, not fabricated zero counters. Unverified/acquisition/read failures remain gaps. The observer is excluded from these sums, but its CPU/query overhead can affect the run. Working-set sums can double-count shared pages; they are not private working set. Private bytes are process-private committed memory, not macOS footprint. CPU is cumulative per process identity, not a whole-run total. Sampled maxima can miss startup peaks and short-lived processes. First-sample lag runs from before Process.Start to completion of the first snapshot; elapsedMs and queryMs retain its acquisition interval. Milestones are launch-to-stderr-receipt, not first paint. No beta16 comparison, steady-idle or complete N0 claim.' }
}

function Get-NativeObservationSummary([Collections.IDictionary] $Report, [ValidateRange(1, 3)] [int] $Run,
    [ValidateSet('fresh', 'owned')] [string] $Mode, [bool] $UiCompleted, [bool] $CollectorStarted) {
    # Only validated numeric fields and fixed names reach the CI log. Keep the
    # full report artifact, but never print paths, names or raw exceptions.
    $milestones = @{}; $missing = [Collections.Generic.List[string]]::new()
    $required = @('first-page-ready'); if ($Mode -eq 'owned') { $required += 'html-ready' }
    foreach ($key in $required) {
        if ($Report.milestonesMs.ContainsKey($key)) { $milestones[$key] = [double] $Report.milestonesMs[$key] }
        else { $missing.Add($key) }
    }
    $samples = @($Report.samples); $indices = [Collections.Generic.SortedSet[int]]::new()
    if ($samples.Count) {
        [void] $indices.Add(0)
        foreach ($i in @(([Math]::Max(0, $samples.Count - 2)), ($samples.Count - 1))) { [void] $indices.Add($i) }
        for ($i = 0; $i -lt $samples.Count; $i++) {
            if ($samples[$i].skipped -gt 0 -or $samples[$i].lifecycleEvents.Count -gt 0) {
                foreach ($j in @(([Math]::Max(0, $i - 1)), $i, ([Math]::Min($samples.Count - 1, $i + 1)))) { [void] $indices.Add($j) }
                break
            }
        }
    }
    $timeline = @(
        foreach ($i in $indices) {
            $sample = $samples[$i]; $roles = @{ ui = 0; service = 0; webview = 0; other = 0 }
            foreach ($process in $sample.processes) { $roles[$process.role]++ }
            [ordered]@{ sample = $i; elapsedMs = $sample.elapsedMs; queryMs = $sample.queryMs; observedRoles = $roles
                skipped = $sample.skipped; rootSkipped = $sample.rootSkipped; rootExitedDuringSample = $sample.rootExitedDuringSample
                skipReasonCounts = $sample.skipReasonCounts; lifecycleEvents = $sample.lifecycleEvents; failedRecords = $sample.failedRecords }
        }
    )
    return [ordered]@{ schemaVersion = 2; run = $Run; mode = $Mode; uiCompleted = $UiCompleted; collectorStarted = $CollectorStarted
        incomplete = ($Report.incomplete -or $missing.Count -gt 0); invalidRecords = $Report.invalidRecords; partialLine = $Report.partialLine; sampleGaps = $Report.sampleGaps
        collector = @{ forced = [bool] $Report.collector.forced; reaped = [bool] $Report.collector.reaped; exitCode = $Report.collector.exitCode }
        footer = $Report.footer; sampleCount = $samples.Count; skipReasonCounts = $Report.skipReasonCounts; rootSkipped = $Report.rootSkipped
        normalExitObservations = $Report.normalExitObservations
        milestonesMs = $milestones; missingMilestones = @($missing.ToArray()); timeline = $timeline }
}

function Get-NativeObservationSamples([Collections.IDictionary] $Report, [ValidateRange(1, 3)] [int] $Run,
    [ValidateSet('fresh', 'owned')] [string] $Mode) {
    # Each source sample passed the strict parser (32 KiB/record, 180 records,
    # 2 MiB file). Export event/gap neighborhoods and the edges, explicitly as a
    # selection, not a complete trace. Full validated JSON stays in the artifact.
    $samples = @($Report.samples); $indices = [Collections.Generic.SortedSet[int]]::new()
    if ($samples.Count) {
        [void] $indices.Add(0); [void] $indices.Add($samples.Count - 1)
        for ($i = 0; $i -lt $samples.Count; $i++) {
            if ($samples[$i].skipped -gt 0 -or $samples[$i].lifecycleEvents.Count -gt 0) {
                foreach ($j in @(([Math]::Max(0, $i - 1)), $i, ([Math]::Min($samples.Count - 1, $i + 1)))) { [void] $indices.Add($j) }
            }
        }
    }
    foreach ($i in $indices) {
        $sample = $samples[$i]
        [ordered]@{ run = $Run; mode = $Mode; selection = 'all-event-and-gap-neighbors-and-edges'; selectedSamples = $indices.Count
            totalSamples = $samples.Count; sample = $i; elapsedMs = $sample.elapsedMs; queryMs = $sample.queryMs
            skipped = $sample.skipped; rootSkipped = $sample.rootSkipped; rootExitedDuringSample = $sample.rootExitedDuringSample
            skipReasonCounts = $sample.skipReasonCounts; processes = $sample.processes
            lifecycleEvents = $sample.lifecycleEvents; failedRecords = $sample.failedRecords
            workingSetSumBytes = $sample.workingSetSumBytes; privateBytesSum = $sample.privateBytesSum }
    }
}

function Test-NativeResourceObservation {
    function Check([bool] $Value) { if (-not $Value) { throw 'Native observation self-check failed.' } }
    $ticks = 638999000000000007L
    Check (Test-NativeCreation $ticks $ticks ($ticks - 7))
    Check (-not (Test-NativeCreation ($ticks + 10) $ticks ($ticks - 7)))
    $date = [DateTime]::new($ticks - 7, [DateTimeKind]::Utc)
    $rows = @(@{ ProcessId = 20; ParentProcessId = 10; CreationDate = $date }, @{ ProcessId = 21; ParentProcessId = 20; CreationDate = $date.AddSeconds(1) },
        @{ ProcessId = 22; ParentProcessId = 20; CreationDate = $date.AddSeconds(-1) }, @{ ProcessId = 23; ParentProcessId = 999; CreationDate = $date.AddSeconds(1) })
    $tree = @(Get-NativeTree $rows 20 $ticks)
    Check ($tree.Count -eq 2 -and $tree[1].ProcessId -eq 21)
    $rejected = $false; try { [void] (Get-NativeTree $rows 20 ($ticks + 10)) } catch { $rejected = $true }; Check $rejected
    $tooMany = @($rows[0]) + @(1..64 | ForEach-Object { @{ ProcessId = 30 + $_; ParentProcessId = 20; CreationDate = $date.AddSeconds(1) } })
    $rejected = $false; try { [void] (Get-NativeTree $tooMany 20 $ticks) } catch { $rejected = $true }; Check $rejected
    $path = Join-Path ([IO.Path]::GetTempPath()) ('morrow-resource-self-check-' + [Guid]::NewGuid().ToString('N'))
    $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
    $sample = @{ kind = 0; elapsedMs = 12.5; queryMs = 3.0; skipped = 0; processes = @(@{ pid = 20L; parentPid = 10L; startUtcTicks = $ticks; role = 'ui'; workingSetBytes = 5000000000L; privateBytes = 3000000000L; cpuMs = 12.0 }) }
    $stop = @{ forced = $false; reaped = $true; exitCode = 0 }
    function Read-ObservationFixture([object[]] $Records, $CollectorStop = $stop, $Milestones = @{}) {
        $lines = @($Records | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 6 })
        [IO.File]::WriteAllText($path, (($lines -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
        return Read-NativeResourceReport $path $CollectorStop $Milestones
    }
    try {
        Check (Write-NativeSample $stream $sample)
        Check (Write-NativeSample $stream @{ kind = 1; reason = 0; samples = 1 })
        $stream.Dispose(); $stream = $null
        $projection = @(Read-NativeResourceReport $path $stop @{})
        Check ($projection.Count -eq 1) # No accidental Remove()/collection output.
        $report = $projection[0]
        Check (-not $report.incomplete -and $report.sampledPeakWorkingSetSumBytes -eq 5000000000L -and $report.firstSampleLagMs -eq 15.5)
        Check ($report.samples[0].processes[0].startUtcTicks -eq $ticks)

        # Old records remain readable, with unknown reasons explicitly retained.
        $legacyGap = $sample.Clone(); $legacyGap.skipped = 1
        $report = Read-ObservationFixture @($legacyGap, @{ kind = 1; reason = 0; samples = 1 })
        Check ($report.incomplete -and $report.skipReasonCounts.unclassified -eq 1 -and $null -eq $report.rootSkipped)
        Check ($report.footer.failureStage -ceq 'unclassified')

        $detailed = $sample.Clone(); $detailed['rootSkipped'] = 0L; $detailed['rootExitedDuringSample'] = $false
        $detailed['skipReasonCounts'] = New-NativeSkipReasonCounts
        $footer = @{ kind = 1; reason = 0; samples = 1; failureStage = 'none' }
        $markers = @{ 'first-page-ready' = 15.0; 'html-ready' = 25.0; 'secret-token' = 30.0 }
        $report = Read-ObservationFixture @($detailed, $footer) $stop $markers
        Check (-not $report.incomplete -and $report.footer.failureStage -ceq 'none')
        $summary = Get-NativeObservationSummary $report 1 fresh $true $true
        Check (-not $summary.incomplete -and $summary.missingMilestones.Count -eq 0 -and $summary.sampleCount -eq 1)
        Check (@(Get-NativeObservationSamples $report 1 fresh).Count -eq 1)

        $modern = $detailed.Clone(); $modern.lifecycleEvents = @(); $modern.failedRecords = @()
        $exit = @{ pid = 21L; parentPid = 20L; startUtcTicks = $ticks + 10L; role = 'other'
            exitCode = 0L; phase = 'beforeCounters'; source = 'retained'; identitySource = 'priorSnapshot' }
        $modern.lifecycleEvents = @($exit)
        $report = Read-ObservationFixture @($modern, $footer) $stop $markers
        Check (-not $report.incomplete -and $report.normalExitObservations -eq 1 -and -not $report.sampleGaps)
        Check ($report.samples[0].lifecycleEvents[0].startUtcTicks -eq $ticks + 10L)
        $failure = @{ pid = 21L; parentPid = 20L; cimStartUtcTicks = $ticks + 3L; source = 'cim'
            reason = 'processUnavailable'; stage = 'lookup'; errorKind = 'argument'; errorCode = $null; exitCode = $null }
        $modernGap = $modern.Clone(); $modernGap.lifecycleEvents = @(); $modernGap.failedRecords = @($failure)
        $modernGap.skipped = 1L; $modernGap.skipReasonCounts = New-NativeSkipReasonCounts; $modernGap.skipReasonCounts.processUnavailable = 1L
        $report = Read-ObservationFixture @($modernGap, $footer) $stop $markers
        Check ($report.incomplete -and -not $report.invalidRecords -and $report.normalExitObservations -eq 0)
        $denied = $failure.Clone(); $denied.reason = 'counterReadFailed'; $denied.stage = 'counters'
        $denied.errorKind = 'accessDenied'; $denied.errorCode = 5L; $denied.exitCode = 0L
        $deniedGap = $modernGap.Clone(); $deniedGap.failedRecords = @($denied)
        $deniedGap.skipReasonCounts = New-NativeSkipReasonCounts; $deniedGap.skipReasonCounts.counterReadFailed = 1L
        $report = Read-ObservationFixture @($deniedGap, $footer) $stop $markers
        Check ($report.incomplete -and -not $report.invalidRecords -and $report.skipReasonCounts.counterReadFailed -eq 1)
        Check ($report.samples[0].failedRecords[0].exitCode -eq 0)
        $onlyExit = $modern.Clone(); $onlyExit.processes = @()
        $report = Read-ObservationFixture @($onlyExit, $footer)
        Check ($report.incomplete -and -not $report.invalidRecords) # No measured UI counters.
        foreach ($case in @('event-code', 'event-phase', 'event-fields', 'event-duplicate', 'event-counters',
            'failure-code', 'failure-count', 'failure-duplicate', 'failure-and-exit')) {
            $bad = $modern.Clone(); $bad.lifecycleEvents = @($exit.Clone())
            switch ($case) {
                'event-code' { $bad.lifecycleEvents[0].exitCode = 7L }
                'event-phase' { $bad.lifecycleEvents[0].phase = 'secret-token' }
                'event-fields' { $bad.lifecycleEvents[0]['secret-token'] = 1L }
                'event-duplicate' { $bad.lifecycleEvents = @($exit, $exit) }
                'event-counters' { $bad.lifecycleEvents[0].phase = 'afterCounters' }
                'failure-code' { $bad = $deniedGap.Clone(); $bad.failedRecords = @($denied.Clone()); $bad.failedRecords[0].errorCode = 0L }
                'failure-count' { $bad = $modernGap.Clone(); $bad.failedRecords = @() }
                'failure-duplicate' { $bad = $modernGap.Clone(); $bad.failedRecords = @($failure, $failure) }
                'failure-and-exit' { $bad = $modernGap.Clone(); $bad.lifecycleEvents = @($exit) }
            }
            $report = Read-ObservationFixture @($bad, $footer)
            Check ($report.incomplete -and $report.invalidRecords)
            Check ((Get-NativeObservationSummary $report 2 owned $true $true | ConvertTo-Json -Depth 8) -cnotmatch 'secret-token')
        }

        $childGap = $detailed.Clone(); $childGap.elapsedMs = 1012.5; $childGap.skipped = 1L
        $childGap.skipReasonCounts = New-NativeSkipReasonCounts; $childGap.skipReasonCounts.processExited = 1L
        $rootGap = $childGap.Clone(); $rootGap.elapsedMs = 2012.5; $rootGap.rootSkipped = 1L
        $rootGap.rootExitedDuringSample = $true; $rootGap.processes = @()
        $end = $footer.Clone(); $end.samples = 3
        $report = Read-ObservationFixture @($detailed, $childGap, $rootGap, $end) $stop $markers
        Check ($report.incomplete -and $report.sampleGaps -and $report.skipReasonCounts.processExited -eq 2 -and $report.rootSkipped -eq 1)
        $report['candidate'] = @{ path = 'secret-token' }
        $summary = Get-NativeObservationSummary $report 2 owned $true $true
        $evidence = @(Get-NativeObservationSamples $report 2 owned)
        Check ($summary.incomplete -and $summary.timeline.Count -eq 3 -and $evidence.Count -eq 3)
        Check ($evidence[1].rootSkipped -eq 0 -and -not $evidence[1].rootExitedDuringSample -and $evidence[2].rootExitedDuringSample)
        Check ($evidence[1].elapsedMs -eq 1012.5 -and $evidence[2].processes.Count -eq 0)
        Check ((@{ summary = $summary; selected = $evidence } | ConvertTo-Json -Depth 10) -cnotmatch 'secret-token|candidate')

        # Diagnostics do not turn real evidence failures into complete reports.
        $report = Read-ObservationFixture @($detailed, $footer) @{ forced = $true; reaped = $true; exitCode = -1 }
        Check ($report.incomplete -and $report.collector.forced)
        $report = Read-ObservationFixture @($detailed)
        Check ($report.incomplete -and $null -eq $report.footer)
        $report = Read-ObservationFixture @($detailed, $footer)
        $summary = Get-NativeObservationSummary $report 3 owned $true $true
        Check ($summary.incomplete -and $summary.missingMilestones.Count -eq 2)
        $report = Read-ObservationFixture @(@{ kind = 1; reason = 3; samples = 0; failureStage = 'cim' })
        $summary = Get-NativeObservationSummary $report 2 owned $false $true
        Check ($summary.incomplete -and $summary.sampleCount -eq 0 -and $summary.footer.failureStage -ceq 'cim')

        foreach ($case in @('unknown-reason', 'count-mismatch', 'negative', 'fractional', 'unknown-stage', 'invalid-root')) {
            $bad = $detailed.Clone(); $bad.skipReasonCounts = New-NativeSkipReasonCounts; $badFooter = $footer.Clone()
            switch ($case) {
                'unknown-reason' { $bad.skipReasonCounts['secret-token'] = 1L }
                'count-mismatch' { $bad.skipReasonCounts.processExited = 1L }
                'negative' { $bad.skipReasonCounts.processExited = -1L }
                'fractional' { $bad.skipReasonCounts.processExited = 0.5 }
                'unknown-stage' { $badFooter.failureStage = 'secret-token' }
                'invalid-root' { $bad.rootExitedDuringSample = 'secret-token' }
            }
            $report = Read-ObservationFixture @($bad, $badFooter)
            Check ($report.incomplete -and $report.invalidRecords)
            Check ((Get-NativeObservationSummary $report 2 owned $true $true | ConvertTo-Json -Depth 8) -cnotmatch 'secret-token')
        }
        $line = ($sample | ConvertTo-Json -Compress -Depth 5) + "`n"
        [IO.File]::WriteAllText($path, $line + '{"secret-token":"incomplete', [Text.UTF8Encoding]::new($false))
        $report = Read-NativeResourceReport $path $stop @{}
        Check ($report.incomplete -and $report.partialLine -and $report.samples.Count -eq 1 -and ($report | ConvertTo-Json -Depth 8) -cnotmatch 'secret-token')
        $sample.processes[0].role = 'secret-token'
        [IO.File]::WriteAllText($path, ($sample | ConvertTo-Json -Compress -Depth 5) + "`n", [Text.UTF8Encoding]::new($false))
        $report = Read-NativeResourceReport $path $stop @{}
        Check ($report.incomplete -and $report.invalidRecords -and $report.samples.Count -eq 0)
        $stream = [IO.File]::OpenWrite($path); $stream.Position = 2MB - 513
        Check (-not (Write-NativeSample $stream $sample))
        $stream.SetLength(2MB + 1); $stream.Dispose(); $stream = $null
        Check (Read-NativeResourceReport $path $stop @{}).invalidRecords
        Write-Host 'Native observation identity, bounds, 64-bit counters and partial-record checks passed.'
    } finally { if ($stream) { $stream.Dispose() }; [IO.File]::Delete($path) }
    . (Join-Path $PSScriptRoot 'test-native-process-lifecycle.ps1')
    Test-NativeProcessLifecycle
}

if ($SelfTest) { Test-NativeResourceObservation; return }
if ($MyInvocation.InvocationName -eq '.') { return }
try { Invoke-NativeResourceCollector *> $null; exit 0 } catch { exit 1 }
