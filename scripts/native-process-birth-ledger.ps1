#requires -Version 7.2
# Fixture-only native launcher and independent strict metadata verifier. No app
# settings, real mail, process inventory, credentials or privilege changes.
function New-NativeProcessObserver([string] $Fixture) {
    $compiler = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'VC\Auxiliary\Build\vcvars64.bat'
    if (-not $compiler -or @($compiler).Count -ne 1) { throw 'Pinned native observer compiler is unavailable.' }
    $root = Split-Path $PSScriptRoot -Parent
    $source = Join-Path $root 'windows/Checks/NativeProcessObserver.cpp'
    $name = 'native-observer-' + [Guid]::NewGuid().ToString('N')
    $exe = Join-Path $Fixture ($name + '.exe')
    if (Test-Path -LiteralPath $exe) { throw 'Observer output already exists.' }
    $command = 'call "' + $compiler + '" >nul && cl /nologo /std:c++20 /EHsc /W4 /WX /DUNICODE /D_UNICODE "' + $source + '" /Fe:"' + $exe + '" /Fo:"' + $Fixture + '\' + $name + '.obj"'
    & $env:ComSpec /d /c $command | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Owned native observer failed to compile.' }
    return $exe
}

function Read-NativeBirthLedger([string] $Path, [long] $ExpectedLaunch = 0,
    [uint32] $LauncherPid = 0, [long] $LauncherTicks = 0, [object[]] $Samples = @()) {
    $header = $null; $footer = $null; $invalid = $false; $partial = $false; $proofIncomplete = $false; $stage = 'file'
    $births = @{}; $exits = @{}; $sequence = 0L; $rows = [Collections.Generic.List[object]]::new()
    function Keys($Row, [string] $Expected) {
        if ($Row -isnot [Collections.IDictionary] -or (($Row.Keys | Sort-Object) -join ',') -cne (($Expected.Split(',') | Sort-Object) -join ',')) { throw 'Unexpected lifetime fields.' }
    }
    function Integer($Value, [long] $Minimum, [long] $Maximum) {
        if ($Value -isnot [long] -or $Value -lt $Minimum -or $Value -gt $Maximum) { throw 'Invalid lifetime integer.' }
    }
    function Boolean($Value) { if ($Value -isnot [bool]) { throw 'Invalid lifetime boolean.' } }
    function Identity($Row) {
        Integer $Row.pid 2 ([uint32]::MaxValue); Integer $Row.ticks 1 ([DateTime]::MaxValue.Ticks)
        return $Row.pid.ToString([Globalization.CultureInfo]::InvariantCulture) + ':' + $Row.ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
    }
    try {
        $file = Get-Item -LiteralPath $Path
        if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid lifetime file.' }
        $reader = [IO.BinaryReader]::new([IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read))
        try { $bytes = $reader.ReadBytes(2MB + 1) } finally { $reader.Dispose() }
        if ($bytes.Length -gt 2MB -or -not $bytes.Length) { throw 'Lifetime file limit.' }
        $end = [Array]::LastIndexOf($bytes, [byte] 10); $partial = $end -ne $bytes.Length - 1
        if ($end -lt 0) { throw 'Missing lifetime records.' }
        $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes, 0, $end + 1)
        foreach ($line in $text.Split([char] 10)) {
            if (-not $line.Length) { continue }
            if ([Text.Encoding]::UTF8.GetByteCount($line) -gt 32KB -or $null -ne $footer -or $rows.Count -ge 130) { throw 'Lifetime record limit.' }
            $row = ConvertFrom-Json -InputObject $line -AsHashtable
            Integer $row.kind 0 3
            if ($null -eq $header) {
                $stage = 'header'
                Keys $row 'kind,launchTimestamp,launcherPid,launcherTicks,readyBeforeResume,rootPid,rootTicks,schemaVersion'
                if ($row.kind -ne 0 -or $row.schemaVersion -isnot [long] -or $row.schemaVersion -ne 1) { throw 'Invalid lifetime header.' }
                Integer $row.rootPid 2 ([uint32]::MaxValue); Integer $row.launcherPid 2 ([uint32]::MaxValue)
                Integer $row.rootTicks 1 ([DateTime]::MaxValue.Ticks); Integer $row.launcherTicks 1 ([DateTime]::MaxValue.Ticks)
                Integer $row.launchTimestamp 1 ([long]::MaxValue); Boolean $row.readyBeforeResume
                if ($row.rootPid -eq $row.launcherPid -or $row.rootTicks -lt $row.launcherTicks -or
                    ($ExpectedLaunch -and $row.launchTimestamp -ne $ExpectedLaunch) -or
                    ($LauncherPid -and $row.launcherPid -ne $LauncherPid) -or
                    ($LauncherTicks -and $row.launcherTicks -ne $LauncherTicks)) { throw 'Lifetime launcher identity mismatch.' }
                if (-not $row.readyBeforeResume) { $proofIncomplete = $true }
                $header = $row
            } elseif ($row.kind -eq 1) {
                $stage = 'birth'
                Keys $row 'inJob,kind,parentPid,parentTicks,pid,role,seq,ticks'
                Integer $row.seq 1 128; $sequence++; if ($row.seq -ne $sequence) { throw 'Lifetime event loss.' }
                $identity = Identity $row
                Integer $row.parentPid 2 ([uint32]::MaxValue); Integer $row.parentTicks 1 ([DateTime]::MaxValue.Ticks)
                Boolean $row.inJob; if (-not $row.inJob) { $proofIncomplete = $true }
                if ($births.Count -eq 64 -or $births.ContainsKey($identity) -or $row.parentTicks -gt $row.ticks -or
                    $row.pid -eq $row.parentPid -or $row.role -cnotin @('ui', 'service', 'webview', 'other')) { throw 'Invalid lifetime birth.' }
                if ($row.pid -eq $header.rootPid) {
                    if ($row.ticks -ne $header.rootTicks -or $row.parentPid -ne $header.launcherPid -or
                        $row.parentTicks -ne $header.launcherTicks -or $row.role -ne 'ui' -or $births.Count -ne 0) { throw 'Invalid root birth.' }
                } else {
                    $parent = $row.parentPid.ToString([Globalization.CultureInfo]::InvariantCulture) + ':' + $row.parentTicks.ToString([Globalization.CultureInfo]::InvariantCulture)
                    if ($row.role -eq 'ui' -or -not $births.ContainsKey($parent)) { throw 'Unowned lifetime parent.' }
                }
                $births[$identity] = $row
            } elseif ($row.kind -eq 2) {
                $stage = 'exit'
                Keys $row 'eventCode,exitCode,exitTicks,kind,nativeError,outcome,pid,seq,ticks,waitResult'
                Integer $row.seq 1 128; $sequence++; if ($row.seq -ne $sequence) { throw 'Lifetime event loss.' }
                $identity = Identity $row
                if (-not $births.ContainsKey($identity) -or $exits.ContainsKey($identity)) { throw 'Exit without unique birth.' }
                Integer $row.exitTicks 0 ([DateTime]::MaxValue.Ticks)
                Integer $row.eventCode ([int]::MinValue) ([int]::MaxValue)
                Integer $row.waitResult 0 ([uint32]::MaxValue)
                if ($null -ne $row.exitCode) { Integer $row.exitCode ([int]::MinValue) ([int]::MaxValue) }
                if ($null -ne $row.nativeError) { Integer $row.nativeError 0 ([uint32]::MaxValue) }
                if ($row.outcome -cnotin @('alive', 'zero', 'nonzero', 'nativeFailure', 'invalidWait', 'unproven')) { throw 'Unknown lifetime wait outcome.' }
                if ($row.outcome -in @('zero', 'nonzero')) {
                    if ($row.waitResult -ne 0 -or $null -ne $row.nativeError -or $null -eq $row.exitCode -or
                        $row.exitCode -ne $row.eventCode -or $row.exitTicks -lt $row.ticks -or
                        ($row.outcome -eq 'zero' -and $row.exitCode -ne 0) -or
                        ($row.outcome -eq 'nonzero' -and $row.exitCode -eq 0)) { throw 'Conflicting native exit proof.' }
                    if ($row.exitCode -ne 0) { $proofIncomplete = $true }
                } else {
                    $proofIncomplete = $true
                    if (($row.outcome -eq 'alive' -and $row.waitResult -ne 258) -or
                        ($row.outcome -eq 'nativeFailure' -and ($row.waitResult -ne [uint32]::MaxValue -or $null -eq $row.nativeError)) -or
                        ($row.outcome -eq 'invalidWait' -and ($row.waitResult -in @(0, 258, [uint32]::MaxValue))) -or
                        ($row.waitResult -ne [uint32]::MaxValue -and $null -ne $row.nativeError) -or $null -ne $row.exitCode) { throw 'Invalid unavailable exit proof.' }
                }
                $exits[$identity] = $row
            } elseif ($row.kind -eq 3) {
                $stage = 'footer'
                Keys $row 'births,cleanup,closed,debugEvents,duplicates,exits,failures,forced,jobActive,jobTotal,kind,normalDrain,rootExitCode,sequence'
                foreach ($key in @('births', 'exits', 'duplicates', 'closed', 'jobTotal', 'jobActive')) { Integer $row[$key] 0 64 }
                Integer $row.sequence 0 128; Integer $row.debugEvents 0 8192
                foreach ($key in @('cleanup', 'forced', 'normalDrain')) { Boolean $row[$key] }
                if ($null -ne $row.rootExitCode) { Integer $row.rootExitCode ([int]::MinValue) ([int]::MaxValue) }
                $reasons = @('job-create', 'parent-api', 'stderr-handle', 'launch-attributes', 'root-launch', 'root-admission',
                    'root-resume', 'birth-identity', 'birth-pin', 'root-identity', 'parent-identity', 'birth-proof', 'role-read',
                    'identity-bound', 'exit-without-birth', 'debug-rip', 'debug-continue', 'event-bound', 'debug-wait',
                    'native-wait', 'exit-proof', 'nonzero-exit', 'descendant-drain', 'sample-bound', 'counter-read',
                    'deadline', 'job-accounting', 'event-loss', 'ledger-sequence', 'ledger-birth', 'ledger-exit',
                    'missing-lifetime', 'duplicate-identity', 'job-cleanup', 'cleanup', 'sample-footer',
                    'root-cleanup', 'launch-close', 'pin-close', 'image-close', 'cleanup-wait', 'counter-fixture')
                if ($row.failures -isnot [array] -or $row.failures.Count -gt $reasons.Count -or
                    @($row.failures | Where-Object { $_ -isnot [string] -or $_ -cnotin $reasons }).Count -or
                    @($row.failures | Sort-Object -Unique).Count -ne $row.failures.Count) { throw 'Invalid lifetime failure vocabulary.' }
                if ($row.failures.Count -or -not $row.cleanup -or -not $row.normalDrain -or $row.forced -or $row.jobActive -or
                    $row.births -ne $row.exits -or $row.births -ne $row.jobTotal -or $row.births -ne $births.Count -or
                    $row.exits -ne $exits.Count -or $row.sequence -ne $sequence -or $row.sequence -ne 2 * $births.Count -or
                    $row.duplicates -ne $row.closed -or $row.duplicates -ne $births.Count -or $null -eq $row.rootExitCode -or $row.rootExitCode -ne 0) { $proofIncomplete = $true }
                $footer = $row
            } else { throw 'Duplicate lifetime header.' }
            $rows.Add($row)
        }
        if ($null -eq $footer -or $null -eq $header -or -not $births.Count) { $proofIncomplete = $true }
        $stage = 'parent'
        foreach ($identity in $births.Keys) {
            $birth = $births[$identity]
            if (-not $exits.ContainsKey($identity)) { $proofIncomplete = $true; continue }
            if ($birth.pid -ne $header.rootPid) {
                $parents = @($births.Values | Where-Object {
                    $parentIdentity = $_.pid.ToString([Globalization.CultureInfo]::InvariantCulture) + ':' + $_.ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
                    $_.pid -eq $birth.parentPid -and $_.ticks -le $birth.ticks -and $_.seq -lt $birth.seq -and
                        $exits.ContainsKey($parentIdentity) -and $exits[$parentIdentity].exitTicks -ge $birth.ticks
                })
                if ($parents.Count -ne 1 -or $parents[0].ticks -ne $birth.parentTicks) { throw 'Ambiguous historical parent lifetime.' }
            }
        }
        $rootIdentity = $header.rootPid.ToString([Globalization.CultureInfo]::InvariantCulture) + ':' + $header.rootTicks.ToString([Globalization.CultureInfo]::InvariantCulture)
        if (-not $exits.ContainsKey($rootIdentity) -or $null -eq $footer -or $exits[$rootIdentity].exitCode -ne $footer.rootExitCode) { $proofIncomplete = $true }
        $stage = 'counters'
        foreach ($sample in $Samples) {
            foreach ($process in $sample.processes) {
                $identity = $process.pid.ToString([Globalization.CultureInfo]::InvariantCulture) + ':' + $process.startUtcTicks.ToString([Globalization.CultureInfo]::InvariantCulture)
                if (-not $births.ContainsKey($identity) -or $births[$identity].parentPid -ne $process.parentPid -or
                    $births[$identity].role -cne $process.role) { throw 'Counters outside exact lifetime ledger.' }
            }
        }
    } catch { $invalid = $true } # Do not emit raw file/JSON/OS text.
    return [ordered]@{ source = 'owned-prelaunch-debug-job'; schemaVersion = 1
        incomplete = ($invalid -or $partial -or $proofIncomplete); invalidRecords = $invalid; partialLine = $partial
        failureStage = $(if ($invalid) { $stage } else { 'none' })
        header = $header; footer = $footer; births = $births.Count; exits = $exits.Count; lifetimes = @($rows.ToArray()) }
}
