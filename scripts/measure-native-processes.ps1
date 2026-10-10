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

function Get-NativeProcessSnapshot([uint32] $Root, [long] $RootTicks, [object[]] $SnapshotRows = $null,
    [scriptblock] $ObservationBarrier = $null, [scriptblock] $ReadCounters = $null) {
    # Production and native lifecycle fixtures use the same handle/identity and
    # counter path. The optional barriers are direct fixture arguments only;
    # no environment variable or packaged-app switch can enable them.
    $handles = @{}; $entries = [Collections.Generic.List[object]]::new(); $stage = 'root'
    $sample = [ordered]@{ terminalReason = $null; failureStage = 'none'; skipped = 0; rootSkipped = 0
        rootExitedDuringSample = $null; skipReasonCounts = (New-NativeSkipReasonCounts); processes = @() }
    try {
        try { $rootProcess = [Diagnostics.Process]::GetProcessById($Root) } catch { $sample.terminalReason = 0; return $sample }
        $handles[$Root] = $rootProcess; [void] $rootProcess.Handle
        if ($rootProcess.HasExited) { $sample.terminalReason = 0; return $sample }
        if ($rootProcess.StartTime.ToUniversalTime().Ticks -ne $RootTicks) {
            $sample.terminalReason = 4; $sample.failureStage = 'root'; return $sample
        }
        $stage = 'cim'
        $rows = if ($null -eq $SnapshotRows) {
            @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate -OperationTimeoutSec 2 -ErrorAction Stop)
        } else { $SnapshotRows }
        $stage = 'tree'; $tree = @(Get-NativeTree $rows $Root $RootTicks)
        if (-not $tree.Count) { $sample.terminalReason = 0; return $sample }
        if ($ObservationBarrier) { [void] (& $ObservationBarrier 'snapshot' $null) }
        foreach ($row in $tree) {
            $id = [uint32] $row.ProcessId; $parentId = [uint32] $row.ParentProcessId; $skipReason = 'counterReadFailed'
            try {
                if ($id -ne $Root) {
                    if (-not $handles.ContainsKey($parentId)) { $sample.skipped++; $sample.skipReasonCounts.parentUnavailable++; continue }
                    if ($handles[$parentId].HasExited) { $sample.skipped++; $sample.skipReasonCounts.parentExited++; continue }
                    $skipReason = 'processUnavailable'; $handles[$id] = [Diagnostics.Process]::GetProcessById($id)
                }
                $process = $handles[$id]; [void] $process.Handle
                $skipReason = 'counterReadFailed'; $process.Refresh()
                $ticks = $process.StartTime.ToUniversalTime().Ticks
                if (-not (Test-NativeCreation $ticks $(if ($id -eq $Root) { $RootTicks } else { $ticks }) $row.CreationDate.ToUniversalTime().Ticks) -or
                    ($id -ne $Root -and $ticks -lt $handles[$parentId].StartTime.ToUniversalTime().Ticks)) {
                    $skipReason = 'identityMismatch'; throw 'Changed process identity.'
                }
                if ($ObservationBarrier) { [void] (& $ObservationBarrier 'identified' $process) }
                $role = if ($id -eq $Root) { 'ui' } elseif ($process.ProcessName -ieq 'morrow-service') { 'service' } elseif ($process.ProcessName -ieq 'msedgewebview2') { 'webview' } else { 'other' }
                $counters = if ($ReadCounters) { & $ReadCounters $process } else { Read-NativeProcessCounters $process }
                $entry = [ordered]@{ pid = $id; parentPid = $parentId; startUtcTicks = $ticks; role = $role
                    workingSetBytes = $counters.workingSetBytes; privateBytes = $counters.privateBytes; cpuMs = $counters.cpuMs }
                if ($process.HasExited) { $skipReason = 'processExited'; throw 'Process exited during observation.' }
                if ($id -ne $Root -and $handles[$parentId].HasExited) { $skipReason = 'parentExited'; throw 'Parent exited during observation.' }
                $entries.Add($entry)
            } catch {
                $sample.skipped++; if ($id -eq $Root) { $sample.rootSkipped++ }
                if ($skipReason -eq 'counterReadFailed' -and $handles.ContainsKey($id)) {
                    try { if ($handles[$id].HasExited) { $skipReason = 'processExited' } } catch { }
                }
                $sample.skipReasonCounts[$skipReason]++
                if ($id -eq $Root -and $skipReason -eq 'processExited') { $sample.rootExitedDuringSample = $true }
                if ($handles.ContainsKey($id)) { $handles[$id].Dispose(); [void] $handles.Remove($id) }
            }
        }
        if ($handles.ContainsKey($Root)) {
            try { $sample.rootExitedDuringSample = $handles[$Root].HasExited } catch { }
        }
        $sample.processes = @($entries.ToArray())
    } catch { $sample.terminalReason = 3; $sample.failureStage = $stage }
    finally { foreach ($process in $handles.Values) { $process.Dispose() } }
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
    $count = 0; $reason = 1; $failureStage = 'none'
    try {
        while ($count -lt 180) {
            $at = [Diagnostics.Stopwatch]::GetTimestamp()
            $elapsed = ($at - $launch) * 1000.0 / [Diagnostics.Stopwatch]::Frequency
            if ($elapsed -ge 180000) { break }
            $stage = 'sample'
            try {
                $snapshot = Get-NativeProcessSnapshot $root $rootTicks
                if ($null -ne $snapshot.terminalReason) { $reason = $snapshot.terminalReason; $failureStage = $snapshot.failureStage; break }
                $finished = [Diagnostics.Stopwatch]::GetTimestamp()
                if (($finished - $launch) * 1000.0 / [Diagnostics.Stopwatch]::Frequency -ge 180000) { break }
                $sample = [ordered]@{ kind = 0; elapsedMs = $elapsed; queryMs = ($finished - $at) * 1000.0 / [Diagnostics.Stopwatch]::Frequency
                    skipped = $snapshot.skipped; rootSkipped = $snapshot.rootSkipped; rootExitedDuringSample = $snapshot.rootExitedDuringSample
                    skipReasonCounts = $snapshot.skipReasonCounts; processes = $snapshot.processes }
                if (-not (Write-NativeSample $stream $sample)) { $reason = 2; break }
                $count++
            } catch { $reason = 3; $failureStage = $stage; break }
            # Best effort, no overlapping queries or catch-up burst. A query's
            # operation timeout is not a wall deadline; the parent owns final kill.
            $delay = 1000 - ([Diagnostics.Stopwatch]::GetTimestamp() - $at) * 1000.0 / [Diagnostics.Stopwatch]::Frequency
            if ($delay -gt 0) { Start-Sleep -Milliseconds ([int] $delay) }
        }
        [void] (Write-NativeSample $stream @{ kind = 1; reason = $reason; samples = $count; failureStage = $failureStage })
    } finally { $stream.Dispose() }
}

function Read-NativeResourceReport([string] $Path, $Stop, $Milestones) {
    $samples = [Collections.Generic.List[object]]::new(); $footer = $null; $invalid = $false; $partial = $false
    $peakWs = 0L; $peakPrivate = 0L; $lastElapsed = -1.0; $gaps = $false
    $skipTotals = New-NativeSkipReasonCounts; $rootSkippedTotal = 0L; $unknownRootSkips = $false
    $extendedSampleKeys = (@('elapsedMs', 'kind', 'processes', 'queryMs', 'rootExitedDuringSample', 'rootSkipped', 'skipped', 'skipReasonCounts') | Sort-Object) -join ','
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
                if ($samples.Count -eq 180 -or $row.kind -ne 0 -or $keys -cnotin @('elapsedMs,kind,processes,queryMs,skipped', $extendedSampleKeys)) { throw 'Invalid observation sample.' }
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
                    $identities[$item.pid] = $true; $sumWs += $item.workingSetBytes; $sumPrivate += $item.privateBytes
                }
                $lastElapsed = $row.elapsedMs; $gaps = $gaps -or $row.skipped -gt 0
                foreach ($key in @($skipTotals.Keys)) { $skipTotals[$key] += $skipCounts[$key] }
                if ($null -ne $rootSkipped) { $rootSkippedTotal += $rootSkipped }
                $peakWs = [Math]::Max($peakWs, $sumWs); $peakPrivate = [Math]::Max($peakPrivate, $sumPrivate)
                $row['skipReasonCounts'] = $skipCounts; $row['rootSkipped'] = $rootSkipped; $row['rootExitedDuringSample'] = $rootExited
                [void] $row.Remove('kind'); $row['workingSetSumBytes'] = $sumWs; $row['privateBytesSum'] = $sumPrivate
                $samples.Add($row)
            }
        }
    } catch { $invalid = $true } # Fixed status only; never retain raw CIM/JSON errors.
    return [ordered]@{ schemaVersion = 2; incomplete = ($invalid -or $partial -or $gaps -or $Stop.forced -or -not $Stop.reaped -or $Stop.exitCode -ne 0 -or $null -eq $footer -or $footer.reason -ne 0 -or $samples.Count -eq 0)
        collector = $Stop; invalidRecords = $invalid; partialLine = $partial; sampleGaps = $gaps; footer = $footer
        skipReasonCounts = $skipTotals; rootSkipped = $(if ($unknownRootSkips) { $null } else { $rootSkippedTotal })
        firstSampleLagMs = $(if ($samples.Count) { $samples[0].elapsedMs + $samples[0].queryMs } else { $null }); milestonesMs = $Milestones
        sampledPeakWorkingSetSumBytes = $peakWs; sampledPeakPrivateBytesSum = $peakPrivate; samples = @($samples.ToArray())
        method = 'Approximately one snapshot/second of the owned UI and currently verified descendants; PID + UTC creation ticks. The observer is excluded from these sums, but its CPU/query overhead can affect the run. Working-set sums can double-count shared pages; they are not private working set. Private bytes are process-private committed memory, not macOS footprint. CPU is cumulative per process identity, not a whole-run total. Sampled maxima can miss startup peaks and short-lived processes. First-sample lag runs from before Process.Start to completion of the first snapshot; elapsedMs and queryMs retain its acquisition interval. Milestones are launch-to-stderr-receipt, not first paint. No beta16 comparison, steady-idle or complete N0 claim.' }
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
            if ($samples[$i].skipped -gt 0) {
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
                skipReasonCounts = $sample.skipReasonCounts }
        }
    )
    return [ordered]@{ schemaVersion = 1; run = $Run; mode = $Mode; uiCompleted = $UiCompleted; collectorStarted = $CollectorStarted
        incomplete = ($Report.incomplete -or $missing.Count -gt 0); invalidRecords = $Report.invalidRecords; partialLine = $Report.partialLine; sampleGaps = $Report.sampleGaps
        collector = @{ forced = [bool] $Report.collector.forced; reaped = [bool] $Report.collector.reaped; exitCode = $Report.collector.exitCode }
        footer = $Report.footer; sampleCount = $samples.Count; skipReasonCounts = $Report.skipReasonCounts; rootSkipped = $Report.rootSkipped
        milestonesMs = $milestones; missingMilestones = @($missing.ToArray()); timeline = $timeline }
}

function Get-NativeObservationSamples([Collections.IDictionary] $Report, [ValidateRange(1, 3)] [int] $Run,
    [ValidateSet('fresh', 'owned')] [string] $Mode) {
    # Each source sample passed the strict parser (32 KiB/record, 180 records,
    # 2 MiB file). Export all gap neighborhoods and the edges, explicitly as a
    # selection, not a complete trace. Full validated JSON stays in the artifact.
    $samples = @($Report.samples); $indices = [Collections.Generic.SortedSet[int]]::new()
    if ($samples.Count) {
        [void] $indices.Add(0); [void] $indices.Add($samples.Count - 1)
        for ($i = 0; $i -lt $samples.Count; $i++) {
            if ($samples[$i].skipped -gt 0) {
                foreach ($j in @(([Math]::Max(0, $i - 1)), $i, ([Math]::Min($samples.Count - 1, $i + 1)))) { [void] $indices.Add($j) }
            }
        }
    }
    foreach ($i in $indices) {
        $sample = $samples[$i]
        [ordered]@{ run = $Run; mode = $Mode; selection = 'all-gap-neighbors-and-edges'; selectedSamples = $indices.Count
            totalSamples = $samples.Count; sample = $i; elapsedMs = $sample.elapsedMs; queryMs = $sample.queryMs
            skipped = $sample.skipped; rootSkipped = $sample.rootSkipped; rootExitedDuringSample = $sample.rootExitedDuringSample
            skipReasonCounts = $sample.skipReasonCounts; processes = $sample.processes
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
