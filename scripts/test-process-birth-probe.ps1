#requires -Version 7.2
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'This owned process discriminator requires Windows.' }
$root = Split-Path $PSScriptRoot -Parent
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
    foreach ($case in @('zero', 'orphan', 'handled-exception', 'nonzero', 'crash', 'user-breakpoint',
        'loss-birth', 'loss-exit', 'identity-mismatch', 'creation-mismatch', 'wrong-job',
        'wait-failed', 'wait-unknown', 'exit-mismatch', 'overflow', 'timeout',
        'acquire-zero', 'acquire-nonzero', 'acquire-crash')) {
        $start = [Diagnostics.ProcessStartInfo]::new($exe)
        $start.UseShellExecute = $false; $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
        $start.ArgumentList.Add($case)
        $process = [Diagnostics.Process]::Start($start)
        try {
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
        } finally { $process.Dispose() }
    }
} finally { Remove-Item -LiteralPath $temporary -Recurse -Force }
