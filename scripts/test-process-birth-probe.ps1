#requires -Version 7.2
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'This owned process discriminator requires Windows.' }
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'native-process-birth-ledger.ps1')
. (Join-Path $PSScriptRoot 'measure-native-processes.ps1')
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('morrow-birth-probe-' + [Guid]::NewGuid().ToString('N'))
$compiler = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'VC\Auxiliary\Build\vcvars64.bat'
if (-not $compiler) { throw 'Pinned runner native compiler is unavailable.' }
[void] (New-Item -ItemType Directory -Path $temporary)
try {
    $source = Join-Path $root 'windows/Checks/ProcessBirthProbe.cpp'
    $exe = Join-Path $temporary 'process-birth-probe.exe'
    $command = 'call "' + $compiler + '" >nul && cl /nologo /std:c++20 /EHsc /W4 /WX /DUNICODE /D_UNICODE "' + $source + '" /Fe:"' + $exe + '" /Fo:"' + $temporary + '\probe.obj"'
    & $env:ComSpec /d /c $command
    if ($LASTEXITCODE -ne 0) { throw 'Process birth discriminator did not compile.' }
    $adapter = Join-Path $root 'windows/Checks/NativeProcessObserver.cpp'
    $command = 'call "' + $compiler + '" >nul && cl /nologo /std:c++20 /EHsc /W4 /WX /DUNICODE /D_UNICODE "' + $adapter + '" /Fe:"' + $temporary + '\native-process-observer.exe" /Fo:"' + $temporary + '\observer.obj"'
    & $env:ComSpec /d /c $command
    if ($LASTEXITCODE -ne 0) { throw 'Owned process observer adapter did not compile.' }
    foreach ($case in @('zero', 'orphan', 'handled-exception', 'pending-exit-wait', 'counters', 'counter-denied', 'nonzero', 'crash', 'user-breakpoint',
        'loss-birth', 'loss-exit', 'identity-mismatch', 'creation-mismatch', 'wrong-job',
        'wait-failed', 'wait-unknown', 'exit-mismatch', 'overflow', 'timeout',
        'acquire-zero', 'acquire-nonzero', 'acquire-crash')) {
        $start = [Diagnostics.ProcessStartInfo]::new($exe)
        $start.UseShellExecute = $false; $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
        $start.ArgumentList.Add($case)
        $ledgerPath = Join-Path $temporary ($case + '.jsonl')
        $start.ArgumentList.Add($ledgerPath)
        $process = [Diagnostics.Process]::Start($start)
        try {
            $launcherId = $process.Id; $launcherTicks = $process.StartTime.ToUniversalTime().Ticks
            $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
            if (-not $process.WaitForExit(16000)) { $process.Kill(); [void] $process.WaitForExit(2000); throw ('Probe exceeded its owned deadline: ' + $case) }
            $text = $stdout.GetAwaiter().GetResult(); $errors = $stderr.GetAwaiter().GetResult()
            if ($text.Length -gt 16384 -or $errors.Length -gt 2048) { throw 'Probe capture exceeded its bound.' }
            Write-Host ('Process birth case ' + $case + ': ' + $text.Trim())
            if ($process.ExitCode -ne 0) { throw ('Process birth control rejected its expected outcome: ' + $case + '; ' + $errors) }
            $result = $text | ConvertFrom-Json
            if (-not $result.readyBeforeResume -or -not $result.cleanup -or $result.closed -ne $result.duplicates -or
                -not $result.firstAcquireEvidence) { throw 'Probe lifecycle cleanup or first-acquisition evidence failed.' }
            if ($result.accepted -eq $result.expectedNegative) { throw 'Probe confused normal exit and unavailable evidence.' }
            $reasons = @{ 'nonzero' = 'nonzero-exit'; 'crash' = 'nonzero-exit'; 'user-breakpoint' = 'nonzero-exit'
                'counter-denied' = 'counter-read'; 'loss-birth' = 'event-loss'; 'loss-exit' = 'event-loss'
                'identity-mismatch' = 'parent-identity'; 'creation-mismatch' = 'birth-proof'; 'wrong-job' = 'birth-proof'
                'wait-failed' = 'native-wait'; 'wait-unknown' = 'native-wait'; 'exit-mismatch' = 'exit-proof'
                'overflow' = 'identity-bound'; 'timeout' = 'deadline'; 'acquire-nonzero' = 'nonzero-exit'; 'acquire-crash' = 'nonzero-exit' }
            if ($reasons.ContainsKey($case) -and $result.failures -cnotcontains $reasons[$case]) { throw 'Probe did not exercise its intended rejection.' }
            if ($case -eq 'wait-failed' -and -not @($result.lifetimes | Where-Object { $_.waitResult -eq [uint32]::MaxValue -and $_.nativeError -eq 6 -and $_.outcome -ceq 'nativeFailure' }).Count) { throw 'Closed-handle raw wait evidence is missing.' }
            if ($case -eq 'wait-unknown' -and -not @($result.lifetimes | Where-Object { $_.waitResult -eq 128 -and $_.outcome -ceq 'invalidWait' }).Count) { throw 'Unknown wait projection was not rejected.' }
            if ($case -eq 'pending-exit-wait' -and (-not $result.faultUsed -or $result.pendingExitWaits -lt 1)) { throw 'Pending exit proof was not drained.' }
            if ($case -in @('nonzero', 'acquire-nonzero') -and -not @($result.lifetimes | Where-Object { $_.exited -and $_.exitCode -eq 7 }).Count) { throw 'Native nonzero exit was lost.' }
            if ($case -in @('crash', 'acquire-crash') -and -not @($result.lifetimes | Where-Object { $_.exited -and $_.exitCode -eq -1073741819 }).Count) { throw 'Native crash status was lost.' }
            $ledger = Read-NativeBirthLedger $ledgerPath 0 $launcherId $launcherTicks
            Write-Host ('Independent lifetime case ' + $case + ': ' + (@{ incomplete = $ledger.incomplete; invalidRecords = $ledger.invalidRecords; partialLine = $ledger.partialLine; failureStage = $ledger.failureStage; births = $ledger.births; exits = $ledger.exits } | ConvertTo-Json -Compress))
            if ($ledger.incomplete -ne $result.expectedNegative) { throw 'Independent lifetime parser disagrees with expected completeness.' }
            if ($case -in @('counters', 'counter-denied')) {
                $stop = @{ forced = $false; reaped = $true; exitCode = 0 }
                $report = Read-NativeResourceReport ($ledgerPath + '.samples') $stop @{}
                if ($report.invalidRecords -or $report.partialLine -or $report.samples.Count -lt 2 -or
                    $report.incomplete -ne ($case -eq 'counter-denied')) { throw 'Native counter positive/denied control failed.' }
                if ($case -eq 'counter-denied' -and -not @($report.samples.failedRecords | Where-Object { $_.stage -eq 'counters' -and $_.errorCode -eq 5 -and $_.errorKind -eq 'accessDenied' }).Count) { throw 'Real limited-handle counter denial was not retained.' }
                $bound = Read-NativeBirthLedger $ledgerPath 0 $launcherId $launcherTicks $report.samples
                if ($case -eq 'counters' -and $bound.incomplete) { throw 'Native counters did not join their exact lifetimes.' }
            }
        } finally { $process.Dispose() }
    }
} finally { Remove-Item -LiteralPath $temporary -Recurse -Force }
