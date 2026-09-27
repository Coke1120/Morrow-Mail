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
    $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
        $acl = [Security.AccessControl.FileSecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
        }
        [IO.FileSystemAclExtensions]::SetAccessControl($stream, $acl)
    } finally { $stream.Dispose() }
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
    $count = 0; $reason = 1
    try {
        while ($count -lt 180) {
            $at = [Diagnostics.Stopwatch]::GetTimestamp()
            $elapsed = ($at - $launch) * 1000.0 / [Diagnostics.Stopwatch]::Frequency
            if ($elapsed -ge 180000) { break }
            $handles = @{}; $entries = [Collections.Generic.List[object]]::new(); $skipped = 0
            try {
                try { $rootProcess = [Diagnostics.Process]::GetProcessById($root) } catch { $reason = 0; break }
                $handles[$root] = $rootProcess
                [void] $rootProcess.Handle
                if ($rootProcess.HasExited) { $reason = 0; break }
                if ($rootProcess.StartTime.ToUniversalTime().Ticks -ne $rootTicks) { $reason = 4; break }
                $rows = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate -OperationTimeoutSec 2 -ErrorAction Stop)
                $tree = @(Get-NativeTree $rows $root $rootTicks)
                if (-not $tree.Count) { $reason = 0; break }
                foreach ($row in $tree) {
                    $id = [uint32] $row.ProcessId; $parentId = [uint32] $row.ParentProcessId
                    try {
                        if ($id -ne $root) {
                            if (-not $handles.ContainsKey($parentId) -or $handles[$parentId].HasExited) { $skipped++; continue }
                            $handles[$id] = [Diagnostics.Process]::GetProcessById($id)
                        }
                        $process = $handles[$id]; [void] $process.Handle; $process.Refresh()
                        $ticks = $process.StartTime.ToUniversalTime().Ticks
                        if (-not (Test-NativeCreation $ticks $(if ($id -eq $root) { $rootTicks } else { $ticks }) $row.CreationDate.ToUniversalTime().Ticks) -or
                            ($id -ne $root -and $ticks -lt $handles[$parentId].StartTime.ToUniversalTime().Ticks)) { throw 'Changed process identity.' }
                        $role = if ($id -eq $root) { 'ui' } elseif ($process.ProcessName -ieq 'morrow-service') { 'service' } elseif ($process.ProcessName -ieq 'msedgewebview2') { 'webview' } else { 'other' }
                        $entry = [ordered]@{ pid = $id; parentPid = $parentId; startUtcTicks = $ticks; role = $role
                            workingSetBytes = $process.WorkingSet64; privateBytes = $process.PrivateMemorySize64; cpuMs = $process.TotalProcessorTime.TotalMilliseconds }
                        if ($process.HasExited -or ($id -ne $root -and $handles[$parentId].HasExited)) { throw 'Process exited during observation.' }
                        $entries.Add($entry)
                    } catch {
                        $skipped++
                        if ($handles.ContainsKey($id)) { $handles[$id].Dispose(); [void] $handles.Remove($id) }
                    }
                }
                $finished = [Diagnostics.Stopwatch]::GetTimestamp()
                if (($finished - $launch) * 1000.0 / [Diagnostics.Stopwatch]::Frequency -ge 180000) { break }
                $sample = [ordered]@{ kind = 0; elapsedMs = $elapsed; queryMs = ($finished - $at) * 1000.0 / [Diagnostics.Stopwatch]::Frequency; skipped = $skipped; processes = @($entries.ToArray()) }
                if (-not (Write-NativeSample $stream $sample)) { $reason = 2; break }
                $count++
            } catch { $reason = 3; break }
            finally { foreach ($process in $handles.Values) { $process.Dispose() } }
            # Best effort, no overlapping queries or catch-up burst. A query's
            # operation timeout is not a wall deadline; the parent owns final kill.
            $delay = 1000 - ([Diagnostics.Stopwatch]::GetTimestamp() - $at) * 1000.0 / [Diagnostics.Stopwatch]::Frequency
            if ($delay -gt 0) { Start-Sleep -Milliseconds ([int] $delay) }
        }
        [void] (Write-NativeSample $stream @{ kind = 1; reason = $reason; samples = $count })
    } finally { $stream.Dispose() }
}

function Read-NativeResourceReport([string] $Path, $Stop, $Milestones) {
    $samples = [Collections.Generic.List[object]]::new(); $footer = $null; $invalid = $false; $partial = $false
    $peakWs = 0L; $peakPrivate = 0L; $lastElapsed = -1.0; $gaps = $false
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
                    if (($row.Keys | Sort-Object) -join ',' -cne 'kind,reason,samples' -or $row.reason -isnot [long] -or $row.reason -lt 0 -or $row.reason -gt 4 -or $row.samples -ne $samples.Count) { throw 'Invalid observation footer.' }
                    $footer = @{ reason = $row.reason; samples = $row.samples }; continue
                }
                if ($samples.Count -eq 180 -or $row.kind -ne 0 -or (($row.Keys | Sort-Object) -join ',') -cne 'elapsedMs,kind,processes,queryMs,skipped') { throw 'Invalid observation sample.' }
                foreach ($key in @('elapsedMs', 'queryMs', 'skipped')) {
                    if ($row[$key] -isnot [ValueType] -or $row[$key] -is [bool] -or -not [double]::IsFinite($row[$key]) -or $row[$key] -lt 0 -or $row[$key] -gt 180000) { throw 'Invalid observation number.' }
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
                $peakWs = [Math]::Max($peakWs, $sumWs); $peakPrivate = [Math]::Max($peakPrivate, $sumPrivate)
                [void] $row.Remove('kind'); $row['workingSetSumBytes'] = $sumWs; $row['privateBytesSum'] = $sumPrivate
                $samples.Add($row)
            }
        }
    } catch { $invalid = $true } # Fixed status only; never retain raw CIM/JSON errors.
    return [ordered]@{ schemaVersion = 1; incomplete = ($invalid -or $partial -or $gaps -or $Stop.forced -or -not $Stop.reaped -or $Stop.exitCode -ne 0 -or $null -eq $footer -or $footer.reason -ne 0 -or $samples.Count -eq 0)
        collector = $Stop; invalidRecords = $invalid; partialLine = $partial; sampleGaps = $gaps; footer = $footer
        firstSampleLagMs = $(if ($samples.Count) { $samples[0].elapsedMs + $samples[0].queryMs } else { $null }); milestonesMs = $Milestones
        sampledPeakWorkingSetSumBytes = $peakWs; sampledPeakPrivateBytesSum = $peakPrivate; samples = @($samples.ToArray())
        method = 'Approximately one snapshot/second of the owned UI and currently verified descendants; PID + UTC creation ticks. The observer is excluded from these sums, but its CPU/query overhead can affect the run. Working-set sums can double-count shared pages; they are not private working set. Private bytes are process-private committed memory, not macOS footprint. CPU is cumulative per process identity, not a whole-run total. Sampled maxima can miss startup peaks and short-lived processes. First-sample lag runs from before Process.Start to completion of the first snapshot; elapsedMs and queryMs retain its acquisition interval. Milestones are launch-to-stderr-receipt, not first paint. No beta16 comparison, steady-idle or complete N0 claim.' }
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
    try {
        Check (Write-NativeSample $stream $sample)
        Check (Write-NativeSample $stream @{ kind = 1; reason = 0; samples = 1 })
        $stream.Dispose(); $stream = $null
        $projection = @(Read-NativeResourceReport $path $stop @{})
        Check ($projection.Count -eq 1) # No accidental Remove()/collection output.
        $report = $projection[0]
        Check (-not $report.incomplete -and $report.sampledPeakWorkingSetSumBytes -eq 5000000000L -and $report.firstSampleLagMs -eq 15.5)
        Check ($report.samples[0].processes[0].startUtcTicks -eq $ticks)
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
}

if ($SelfTest) { Test-NativeResourceObservation; return }
if ($MyInvocation.InvocationName -eq '.') { return }
try { Invoke-NativeResourceCollector *> $null; exit 0 } catch { exit 1 }
