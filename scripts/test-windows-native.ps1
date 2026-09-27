#requires -Version 7.2
[CmdletBinding()]
param(
    [string] $PackageDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) 'build/windows-native/Morrow Mail-win32-x64'),
    [switch] $LayoutOnly,
    [switch] $UiSmoke
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'Run Windows native acceptance on Windows.' }
$directory = (Resolve-Path -LiteralPath $PackageDirectory).Path
function Require([bool] $Value, [string] $Message) { if (-not $Value) { throw $Message } }
function Require-X64([string] $Path, [bool] $DesktopHost = $false) {
    $stream = [IO.File]::OpenRead($Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        Require ($reader.ReadUInt16() -eq 0x5a4d) "Not a PE file: $Path"
        $stream.Position = 0x3c
        $header = $reader.ReadUInt32()
        Require ($header -ge 0x40 -and $header -lt $stream.Length - 6) "Invalid PE header: $Path"
        $stream.Position = $header
        Require ($reader.ReadUInt32() -eq 0x00004550 -and $reader.ReadUInt16() -eq 0x8664) "Expected x64 PE: $Path"
        if ($DesktopHost) {
            $stream.Position = $header + 24 + 70 # PE optional-header DllCharacteristics
            Require (($reader.ReadUInt16() -band 0x1000) -eq 0) 'An unpackaged desktop host must not carry the APPCONTAINER linker flag.'
        }
    } finally { $reader.Dispose() }
}

# Diagnostic only: documented MINIDUMP directory/exception/memory/module records.
# Never read ErrorText, thread locals or arbitrary heap strings. Module names are
# bounded metadata; only an allowlisted basename may be printed, never its path.
# MiniDumpReadDumpStream requires native mapping/interop and does not resolve the
# stowed virtual addresses; these bounded reads avoid adding a compiler/tool.
function Read-NativeCrash([IO.Stream] $Stream, [string[]] $AllowedModules = @()) {
    $reader = [IO.BinaryReader]::new($Stream, [Text.Encoding]::UTF8, $true)
    $lines = [Collections.Generic.List[string]]::new()
    function Bounds([uint64] $Offset, [uint64] $Size) {
        if ($Offset -gt $Stream.Length -or $Size -gt ([uint64] $Stream.Length - $Offset)) { throw 'Invalid dump bounds.' }
    }
    function Bytes([uint64] $Offset, [int] $Size) {
        if ($Size -lt 0 -or $Size -gt 65536) { throw 'Invalid diagnostic read size.' }
        Bounds $Offset $Size; $Stream.Position = [long] $Offset
        $value = $reader.ReadBytes($Size)
        if ($value.Length -ne $Size) { throw 'Incomplete dump.' }
        return ,$value
    }
    function U32([uint64] $Offset) { return [BitConverter]::ToUInt32((Bytes $Offset 4), 0) }
    function U64([uint64] $Offset) { return [BitConverter]::ToUInt64((Bytes $Offset 8), 0) }
    function Line([string] $Value) {
        # All emitted text is ASCII constants, hex numbers or allowlisted PE names.
        if (($lines -join "`n").Length + $Value.Length + 1 -le 7000) { $lines.Add($Value) }
    }
    try {
        if ($Stream.Length -gt 8GB -or (U32 0) -ne 0x504d444d) { throw 'Unsupported dump.' }
        $count = U32 8; $directoryRva = U32 12
        if ($count -gt 128) { throw 'Too many dump streams.' }
        Bounds $directoryRva (12 * $count); $streams = @{}
        for ($i = 0; $i -lt $count; $i++) {
            $entry = $directoryRva + 12 * $i; $type = U32 $entry
            $size = U32 ($entry + 4); $rva = U32 ($entry + 8); Bounds $rva $size
            if ($streams.ContainsKey($type)) { throw 'Duplicate dump stream.' }
            $streams[$type] = @{ Offset = [uint64] $rva; Size = [uint64] $size }
        }
        function Stream-Range([uint32] $Type, [uint64] $Size) {
            if (-not $streams.ContainsKey($Type) -or $streams[$Type].Size -lt $Size) { throw 'Missing dump structure.' }
            return $streams[$Type].Offset
        }
        $exception = Stream-Range 6 168
        $code = U32 ($exception + 8); $parameters = U32 ($exception + 32)
        Line ('Exception: 0x{0:X8}' -f $code)
        if ($code -ne 0xc000027bL -or $parameters -lt 2 -or $parameters -gt 15) { return ($lines -join "`n") }
        $pointers = U64 ($exception + 40); $stowedCount = U64 ($exception + 48)
        if ($stowedCount -eq 0 -or $stowedCount -gt 16) { throw 'Unsupported stowed count.' }
        $ranges = [Collections.Generic.List[object]]::new()
        if ($streams.ContainsKey([uint32] 9)) {
            $offset = Stream-Range 9 16; $rangeCount = U64 $offset; $fileOffset = U64 ($offset + 8)
            if ($rangeCount -gt 65536) { throw 'Too many memory ranges.' }
            [void] (Stream-Range 9 (16 + 16 * $rangeCount))
            for ($i = 0; $i -lt $rangeCount; $i++) {
                $entry = $offset + 16 + 16 * $i; $address = U64 $entry; $size = U64 ($entry + 8)
                Bounds $fileOffset $size
                $ranges.Add(@{ Address = $address; Size = $size; Offset = $fileOffset }); $fileOffset += $size
            }
        } else {
            $offset = Stream-Range 5 4; $rangeCount = U32 $offset
            if ($rangeCount -gt 65536) { throw 'Too many memory ranges.' }
            [void] (Stream-Range 5 (4 + 16 * $rangeCount))
            for ($i = 0; $i -lt $rangeCount; $i++) {
                $entry = $offset + 4 + 16 * $i; $address = U64 $entry
                $size = U32 ($entry + 8); $fileOffset = U32 ($entry + 12); Bounds $fileOffset $size
                $ranges.Add(@{ Address = $address; Size = [uint64] $size; Offset = [uint64] $fileOffset })
            }
        }
        $ordered = @($ranges | Sort-Object { $_.Address })
        function Memory([uint64] $Address, [uint64] $Size) {
            $lo = 0; $hi = $ordered.Count - 1
            while ($lo -le $hi) {
                $mid = ($lo + $hi) -shr 1; $range = $ordered[$mid]
                if ($Address -lt $range.Address) { $hi = $mid - 1 }
                elseif ($Address - $range.Address -ge $range.Size) { $lo = $mid + 1 }
                else {
                    $delta = $Address - $range.Address
                    if ($Size -gt $range.Size - $delta) { throw 'Split or incomplete memory range.' }
                    return $range.Offset + $delta
                }
            }
            throw 'Address not captured.'
        }
        $modules = [Collections.Generic.List[object]]::new()
        if ($streams.ContainsKey([uint32] 4)) {
            $offset = Stream-Range 4 4; $moduleCount = U32 $offset
            if ($moduleCount -gt 2048) { throw 'Too many modules.' }
            [void] (Stream-Range 4 (4 + 108 * $moduleCount))
            for ($i = 0; $i -lt $moduleCount; $i++) {
                $entry = $offset + 4 + 108 * $i; $size = U32 ($entry + 8)
                $name = 'module-{0}' -f $i; $nameRva = U32 ($entry + 20); $nameSize = U32 $nameRva
                if ($nameSize -gt 0 -and $nameSize -le 2048 -and ($nameSize % 2) -eq 0) {
                    $basename = ([Text.Encoding]::Unicode.GetString((Bytes ($nameRva + 4) $nameSize)) -split '[\\/]')[-1]
                    if ($basename -cmatch '^[A-Za-z0-9 ._-]{1,100}\.(dll|exe)$' -and $AllowedModules -contains $basename) { $name = $basename }
                }
                $modules.Add(@{ Address = (U64 $entry); Size = $size; Name = $name })
            }
        }
        $array = Memory $pointers (8 * $stowedCount)
        for ($i = 0; $i -lt $stowedCount; $i++) {
            $address = U64 ($array + 8 * $i); $offset = Memory $address 16
            $size = U32 $offset; $signature = U32 ($offset + 4)
            # x64 SE01 / SE02; no recursive nested-language-object interpretation.
            if (-not (($signature -eq 0x53453031 -and $size -eq 40) -or ($signature -eq 0x53453032 -and $size -eq 56))) { throw 'Unsupported stowed structure.' }
            $offset = Memory $address $size
            Line ('Stowed[{0}] HRESULT: 0x{1:X8}' -f $i, (U32 ($offset + 8)))
            if (((U32 ($offset + 12)) -band 3) -ne 1) { continue }
            $wordSize = U32 ($offset + 24); $frames = U32 ($offset + 28)
            if ($wordSize -ne 8 -or $frames -gt 4096) { throw 'Invalid x64 backtrace.' }
            $frames = [Math]::Min($frames, 32)
            if (-not $frames) { continue }
            $trace = Memory (U64 ($offset + 32)) (8 * $frames)
            for ($j = 0; $j -lt $frames; $j++) {
                $ip = U64 ($trace + 8 * $j); $frame = 'unmapped'
                foreach ($module in $modules) {
                    if ($ip -ge $module.Address -and $ip - $module.Address -lt $module.Size) {
                        $frame = '{0}+0x{1:X}' -f $module.Name, ($ip - $module.Address); break
                    }
                }
                Line ('  [{0}] {1}' -f $j, $frame)
            }
        }
        return ($lines -join "`n")
    } finally { $reader.Dispose() }
}
function Test-NativeCrashReader {
    # One synthetic fixed-layout dump, never a workspace or real process dump.
    $stream = [IO.MemoryStream]::new([byte[]]::new(1024), $true)
    $writer = [IO.BinaryWriter]::new($stream, [Text.Encoding]::UTF8, $true)
    function W32([int] $Offset, [uint32] $Value) { $stream.Position = $Offset; $writer.Write($Value) }
    function W64([int] $Offset, [uint64] $Value) { $stream.Position = $Offset; $writer.Write($Value) }
    try {
        W32 0 0x504d444d; W32 8 3; W32 12 32
        W32 32 6; W32 36 168; W32 40 80
        W32 44 9; W32 48 32; W32 52 256
        W32 56 4; W32 60 112; W32 64 300
        W32 88 0xc000027bL; W32 112 2; W64 120 0x1000; W64 128 1
        W64 256 1; W64 264 512; W64 272 0x1000; W64 280 128
        W32 300 1; W64 304 0x400000; W32 312 4096; W32 324 704
        $moduleName = [Text.Encoding]::Unicode.GetBytes('C:\private-do-not-print\fixture.dll')
        W32 704 $moduleName.Length; $stream.Position = 708; $writer.Write($moduleName)
        W64 512 0x1020; W32 544 56; W32 548 0x53453032
        W32 552 0x80070057L; W32 556 1; W32 568 8; W32 572 2; W64 576 0x1060
        W64 608 0x400123; W64 616 0x400456
        $result = Read-NativeCrash $stream @('fixture.dll')
        Require ($result -ceq "Exception: 0xC000027B`nStowed[0] HRESULT: 0x80070057`n  [0] fixture.dll+0x123`n  [1] fixture.dll+0x456") 'Crash reader self-check failed.'
        # A pointer beyond captured memory must not turn into an unchecked read.
        W64 512 0x1080; $rejected = $false
        try { [void] (Read-NativeCrash $stream) } catch { $rejected = $true }
        Require $rejected 'Crash reader bounds self-check failed.'
    } finally { $writer.Dispose(); $stream.Dispose() }
}
function Restore-CrashCapture($Capture) {
    if (-not $Capture) { return }
    try {
        if ($Capture.Existed) {
            foreach ($name in $Capture.Saved.Keys) {
                $value = $Capture.Saved[$name]
                if ($value) { $Capture.Key.SetValue($name, $value.Value, $value.Kind) }
                else { $Capture.Key.DeleteValue($name, $false) }
            }
        } else {
            $Capture.Key.Dispose(); $Capture.Key = $null
            $Capture.Base.DeleteSubKey($Capture.Path, $false)
        }
    } catch { Write-Warning 'Could not restore optional per-app WER settings.' }
    finally {
        if ($Capture.Key) { $Capture.Key.Dispose() }; $Capture.Base.Dispose()
        if ($Capture.Directory) {
            try { Remove-Item -LiteralPath $Capture.Directory -Recurse -Force -ErrorAction Stop } catch { Write-Warning 'Could not remove temporary crash diagnostics; do not upload them.' }
        }
    }
}
function New-CrashCapture {
    # Per-executable WER is machine-wide, even though the launched workspace is
    # disposable. Never enable it beside a developer's real same-named app.
    if (-not ($env:GITHUB_ACTIONS -ceq 'true')) { return $null }
    $capture = $null; $base = $null; $key = $null
    try {
        Test-NativeCrashReader
        $path = 'SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\Morrow Mail.exe'
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
        $key = $base.OpenSubKey($path, $true); $existed = $null -ne $key
        if (-not $key) { $key = $base.CreateSubKey($path) }
        $capture = @{ Base = $base; Key = $key; Path = $path; Existed = $existed; Saved = @{}; Directory = $null }
        foreach ($name in @('DumpFolder', 'DumpType', 'DumpCount')) {
            $capture.Saved[$name] = if ($key.GetValueNames() -contains $name) { @{ Value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); Kind = $key.GetValueKind($name) } } else { $null }
        }
        $capture.Directory = Join-Path ([IO.Path]::GetTempPath()) ('morrow-native-crash-' + [Guid]::NewGuid().ToString('N'))
        [void] (New-Item -ItemType Directory -Path $capture.Directory)
        $key.SetValue('DumpFolder', $capture.Directory, [Microsoft.Win32.RegistryValueKind]::ExpandString)
        $key.SetValue('DumpType', 2, [Microsoft.Win32.RegistryValueKind]::DWord)
        $key.SetValue('DumpCount', 1, [Microsoft.Win32.RegistryValueKind]::DWord)
        $cdb = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\Debuggers\x64\cdb.exe'
        Write-Host ('Optional crash diagnostics enabled; SDK CDB present: {0}. Dumps stay temporary, never uploaded.' -f (Test-Path -LiteralPath $cdb))
        return $capture
    } catch {
        if ($capture) { Restore-CrashCapture $capture }
        else { if ($key) { $key.Dispose() }; if ($base) { $base.Dispose() } }
        Write-Warning 'Optional WER diagnostics unavailable; original smoke assertions remain active.'
        return $null
    }
}
function Show-NativeCrash($Capture) {
    if (-not $Capture) { return }
    try {
        $allowed = @('ntdll.dll', 'combase.dll', 'KERNELBASE.dll', 'kernel32.dll', 'ole32.dll', 'user32.dll', 'ucrtbase.dll', 'rpcrt4.dll')
        $allowed += @(Get-ChildItem -LiteralPath $directory -File | Where-Object { $_.Extension -in '.exe', '.dll' } | Select-Object -First 512 -ExpandProperty Name)
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        do {
            $dump = Get-ChildItem -LiteralPath $Capture.Directory -Filter '*.dmp' -File | Select-Object -First 1
            if ($dump) {
                $stream = $null
                try {
                    $stream = [IO.File]::Open($dump.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
                    $trace = Read-NativeCrash $stream $allowed
                    Write-Host $trace; return
                } catch { } finally { if ($stream) { $stream.Dispose() } }
            }
            Start-Sleep -Milliseconds 250
        } while ([DateTime]::UtcNow -lt $deadline)
        Write-Warning 'No complete supported crash dump available; root HRESULT remains unknown.'
    } catch { Write-Warning 'Optional crash decoding failed; original smoke failure is retained.' }
}
function Isolate-NativeEnvironment([Diagnostics.ProcessStartInfo] $Start) {
    # Fresh fixture only needs OS paths/runtime variables, never CI/cloud/model secrets.
    $allowed = @('SystemRoot', 'WINDIR', 'SystemDrive', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'PATH', 'PATHEXT', 'PSModulePath', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'OS', 'SESSIONNAME', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH')
    foreach ($name in @($Start.Environment.Keys)) { if ($allowed -notcontains $name) { [void] $Start.Environment.Remove($name) } }
}
$required = @('Morrow Mail.exe', 'Microsoft.UI.Xaml.dll', 'Microsoft.WindowsAppRuntime.dll',
    'resources/app/backend/package.json', 'resources/app/package.json', 'resources/app/runtime/morrow-service.exe',
    'resources/app/runtime/THIRD_PARTY_LICENSES.txt', 'licenses/windows/packages.config', 'licenses/windows/packages.sha256.json')
foreach ($relative in $required) {
    Require (Test-Path -LiteralPath (Join-Path $directory $relative) -PathType Leaf) "Missing native package file: $relative"
}
foreach ($forbidden in @('node.exe', 'electron.exe', 'resources/app.asar', 'resources/app/main.cjs',
    'resources/app/runtime/node.exe', 'resources/app/backend/server', 'resources/app/backend/dist', 'chrome_100_percent.pak')) {
    Require (-not (Test-Path -LiteralPath (Join-Path $directory $forbidden))) "Unexpected legacy runtime payload: $forbidden"
}
$files = @(Get-ChildItem -LiteralPath $directory -Recurse -Force)
Require (-not ($files | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })) 'Package must not contain reparse points.'
Require (-not ($files | Where-Object { $_.Name -match '^(encryption\.key|genmail\.sqlite(?:-.*)?|client-state\.json|\.env)$' })) 'Private workspace material found in candidate.'
foreach ($file in $files | Where-Object { -not $_.PSIsContainer -and $_.Extension -in '.exe', '.dll' }) { Require-X64 $file.FullName }
$package = Get-Content -LiteralPath (Join-Path $directory 'resources/app/backend/package.json') -Raw | ConvertFrom-Json
$hostMetadata = Get-Content -LiteralPath (Join-Path $directory 'resources/app/package.json') -Raw | ConvertFrom-Json
Require ($hostMetadata.serviceRuntime -ceq 'rust' -and $hostMetadata.nativeHost -ceq 'winui3' -and $hostMetadata.version -ceq $package.version) 'Native host metadata does not match the common version.'
$exe = Join-Path $directory 'Morrow Mail.exe'
Require-X64 $exe $true
$service = Join-Path $directory 'resources/app/runtime/morrow-service.exe'
Require ([Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion -ceq $package.version) 'Native PE version differs from package.json.'
$reported = & $service --version
Require ($LASTEXITCODE -eq 0 -and $reported -ceq "Morrow Mail $($package.version)") 'Rust service version differs from package.json.'
foreach ($path in @($directory, (Split-Path $service))) {
    Require (Test-Path -LiteralPath (Join-Path $path 'vcruntime140.dll')) 'App-local release VC runtime is missing.'
}
Write-Host 'Native package layout, x64 binaries, version and runtime boundaries passed.'
if ($LayoutOnly) { return }

$fixtures = [Collections.Generic.List[string]]::new()
function New-Fixture {
    $path = Join-Path ([IO.Path]::GetTempPath()) ('morrow-native-check-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory $path | Out-Null
    [IO.File]::WriteAllText((Join-Path $path 'disposable-native-fixture'), 'Morrow native acceptance fixture', [Text.UTF8Encoding]::new($false))
    $fixtures.Add($path)
    return $path
}
$fixture = New-Fixture
$process = $null
$crashCapture = $null
$handler = [Net.Http.HttpClientHandler]::new()
$handler.UseProxy = $false
$handler.AllowAutoRedirect = $false
$client = [Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds(15)
try {
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = [Diagnostics.ProcessStartInfo]::new($service)
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.RedirectStandardInput = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    foreach ($key in @('NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES')) { [void] $process.StartInfo.Environment.Remove($key) }
    Require ($process.Start()) 'Could not start the fixture service.'
    $token = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    $updateToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    $bootstrap = @{ token = $token; updateToken = $updateToken; dataDirectory = $fixture; parentPID = $PID; port = 0 } | ConvertTo-Json -Compress
    $process.StandardInput.WriteLine($bootstrap)
    $process.StandardInput.Flush()
    $ready = $process.StandardOutput.ReadLineAsync()
    Require ($ready.Wait(30000)) 'Fixture service startup timed out.'
    $port = ($ready.Result | ConvertFrom-Json).port
    Require ($port -is [long] -or $port -is [int]) 'Invalid private bootstrap response.'
    Require ($port -gt 0 -and $port -le 65535) 'Invalid private service port.'
    $endpoint = "http://127.0.0.1:$port/api/state"
    $unauthenticated = $client.GetAsync($endpoint).GetAwaiter().GetResult()
    try { Require ([int] $unauthenticated.StatusCode -eq 401) 'Private service accepted a request without its bearer.' }
    finally { $unauthenticated.Dispose() }
    $client.DefaultRequestHeaders.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $token)
    $response = $client.GetAsync($endpoint).GetAwaiter().GetResult()
    try {
        Require ([int] $response.StatusCode -eq 200) 'Authenticated fixture state failed.'
        $state = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
        Require ($null -ne $state.accounts) 'Fixture state is missing account metadata.'
    } finally { $response.Dispose() }
    $process.StandardInput.Close()
    Require ($process.WaitForExit(70000)) 'Fixture service did not drain after parent-pipe EOF.'
    Require ($process.ExitCode -eq 0) 'Fixture service exited with failure.'
    $process.Dispose(); $process = $null
    Write-Host 'Private Rust startup/authentication/EOF drain passed in an isolated fresh workspace.'
    if ($UiSmoke) {
        $root = Split-Path $PSScriptRoot -Parent
        $savedIncremental = $env:CARGO_INCREMENTAL
        Push-Location $root
        try {
            $env:CARGO_INCREMENTAL = '0'
            & cargo build --manifest-path rust/Cargo.toml --locked --example native_fixture
            Require ($LASTEXITCODE -eq 0) 'The isolated native fixture helper failed to build.'
        } finally { $env:CARGO_INCREMENTAL = $savedIncremental; Pop-Location }
        $target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $root 'rust/target' }
        if (-not [IO.Path]::IsPathFullyQualified($target)) { $target = Join-Path $root $target }
        $helper = Join-Path $target 'debug/examples/native_fixture.exe'
        Require (Test-Path -LiteralPath $helper) 'The native fixture helper is missing.'
        $owned = New-Fixture
        & $helper seed $owned
        Require ($LASTEXITCODE -eq 0) 'Could not seed the isolated native mailbox.'
        $caseIndex = 0
        foreach ($case in @(@{ path = $fixture; mode = 'fresh' }, @{ path = $owned; mode = 'owned' }, @{ path = $owned; mode = 'owned' })) {
            $caseIndex++
            $resultFile = Join-Path $case.path 'native-smoke-result.json'
            if (Test-Path -LiteralPath $resultFile) { Remove-Item -LiteralPath $resultFile }
            $ui = [Diagnostics.ProcessStartInfo]::new($exe)
            $ui.ArgumentList.Add('--native-smoke')
            $ui.UseShellExecute = $false
            $ui.RedirectStandardError = $true
            $ui.WorkingDirectory = $directory
            Isolate-NativeEnvironment $ui
            $ui.Environment['MORROW_DATA_DIR'] = $case.path
            if ($case.mode -eq 'fresh') {
                Require (Test-Path -LiteralPath (Join-Path $case.path 'disposable-native-fixture')) 'Crash diagnostics require a marked disposable fixture.'
                $crashCapture = New-CrashCapture
            }
            $process = [Diagnostics.Process]::Start($ui)
            $startupDiagnostics = $process.StandardError.ReadLineAsync()
            $completed = $process.WaitForExit(180000)
            if (-not $completed) {
                # Only the UI process launched above, never a name-based/tree kill.
                try { if (-not $process.HasExited) { $process.Kill() }; [void] $process.WaitForExit(5000) }
                catch { Write-Warning 'Timed-out fixture UI termination could not be confirmed.' }
            }
            $safeStartup = '^Native startup: [A-Za-z0-9 .(),:_-]{1,120}$|^Native (startup|XAML) HRESULT: 0x[0-9A-Fa-f]{8}$|^Native startup (constructor|OnLaunched) \((installing unhandled exception handler|reading application resources|reading merged dictionaries|constructing control resources|appending control resources)\) HRESULT: 0x[0-9A-Fa-f]{8}$|^Native smoke: [a-z-]{1,64}$'
            $safeLines = [Collections.Generic.List[string]]::new()
            $stderrDeadline = [Environment]::TickCount64 + 2000
            try {
                for ($lineIndex = 0; $lineIndex -lt 256; $lineIndex++) {
                    $remaining = [Math]::Max(0, $stderrDeadline - [Environment]::TickCount64)
                    if (-not $startupDiagnostics.Wait([int] $remaining)) { break }
                    $line = $startupDiagnostics.GetAwaiter().GetResult()
                    if ($null -eq $line) { break }
                    if ($line.Length -le 256 -and $line -cmatch $safeStartup) { $safeLines.Add($line) }
                    $startupDiagnostics = $process.StandardError.ReadLineAsync()
                }
            } catch { Write-Warning 'Fixture stderr collection was incomplete; only validated phases are retained.' }
            $diagnostics = ($safeLines | Select-Object -Last 20) -join "`n"
            if ($diagnostics.Length -gt 1024) { $diagnostics = $diagnostics.Substring($diagnostics.Length - 1024) }
            if ($diagnostics) { Write-Host $diagnostics }
            if (-not $completed) {
                try {
                    Require (Test-Path -LiteralPath (Join-Path $case.path 'disposable-native-fixture')) 'Timeout evidence requires a marked fixture.'
                    $evidence = Join-Path $root 'test-results'
                    [void] (New-Item -ItemType Directory -Force $evidence)
                    $phase = @($safeLines | Where-Object { $_ -cmatch '^Native smoke: [a-z-]{1,64}$' } | Select-Object -Last 1) -join ''
                    $timeout = @{ ok = $false; mode = $case.mode; timedOut = $true; phase = $phase; diagnostics = $diagnostics } | ConvertTo-Json -Compress
                    [IO.File]::WriteAllText((Join-Path $evidence "windows-native-ui-$caseIndex-timeout.json"), $timeout, [Text.UTF8Encoding]::new($false))
                    if (Test-Path -LiteralPath $resultFile -PathType Leaf) {
                        $record = Get-Item -LiteralPath $resultFile
                        Require (-not ($record.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Fixture result must be a regular file.'
                        $reader = [IO.BinaryReader]::new([IO.File]::Open($resultFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite))
                        try { $bytes = $reader.ReadBytes(16385) } finally { $reader.Dispose() }
                        Require ($bytes.Length -gt 0 -and $bytes.Length -le 16384) 'Fixture result exceeds the diagnostic limit.'
                        [IO.File]::WriteAllBytes((Join-Path $evidence "windows-native-ui-$caseIndex.json"), $bytes)
                    }
                } catch { Write-Warning 'Some optional timeout evidence could not be retained; the timeout remains a failure.' }
                throw 'Native UI fixture did not finish within 180 seconds.'
            }
            if ($process.ExitCode -ne 0) {
                $exitCode = $process.ExitCode
                Write-Host ('Native UI exit code: {0} (0x{1:X8})' -f $exitCode, ($exitCode -band 0xffffffffL))
                Show-NativeCrash $crashCapture
                throw 'Native UI smoke failed before successful completion.'
            }
            Require (Test-Path -LiteralPath $resultFile) 'Native UI did not report its completed smoke checks.'
            $result = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
            $evidence = Join-Path $root 'test-results'
            New-Item -ItemType Directory -Force $evidence | Out-Null
            Copy-Item -LiteralPath $resultFile -Destination (Join-Path $evidence "windows-native-ui-$caseIndex.json")
            Require ($result.ok -eq $true -and $result.mode -ceq $case.mode) "Native UI fixture assertions failed: $($result | ConvertTo-Json -Compress -Depth 4)"
            $process.Dispose(); $process = $null
            Restore-CrashCapture $crashCapture; $crashCapture = $null
            if ($case.mode -eq 'owned') {
                Require ($result.reader.htmlRuntime -ceq 'passed' -and $result.reader.fallback -ceq 'passed' -and $result.reader.staleClose -ceq 'passed') 'Native HTML reader runtime, fallback and stale-close checks must all pass.'
                & $helper verify $case.path
                Require ($LASTEXITCODE -eq 0) 'Native UI fixture ownership or persisted records failed verification.'
            }
        }
        Write-Host 'Native fresh/owned/restart UI smoke passed; no live providers or sending were exercised.'
    }
} finally {
    Restore-CrashCapture $crashCapture
    if ($process) {
        try { if (-not $process.HasExited) { $process.Kill(); [void] $process.WaitForExit(5000) } }
        catch { Write-Warning 'Fixture process cleanup could not be confirmed.' }
        finally { $process.Dispose() }
    }
    $client.Dispose()
    foreach ($path in $fixtures) { Remove-Item -LiteralPath $path -Recurse -Force }
}
