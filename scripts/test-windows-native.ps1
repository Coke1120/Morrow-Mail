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
function Require-X64([string] $Path) {
    $stream = [IO.File]::OpenRead($Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        Require ($reader.ReadUInt16() -eq 0x5a4d) "Not a PE file: $Path"
        $stream.Position = 0x3c
        $header = $reader.ReadUInt32()
        Require ($header -ge 0x40 -and $header -lt $stream.Length - 6) "Invalid PE header: $Path"
        $stream.Position = $header
        Require ($reader.ReadUInt32() -eq 0x00004550 -and $reader.ReadUInt16() -eq 0x8664) "Expected x64 PE: $Path"
    } finally { $reader.Dispose() }
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
            $ui.WorkingDirectory = $directory
            $ui.Environment['MORROW_DATA_DIR'] = $case.path
            $process = [Diagnostics.Process]::Start($ui)
            Require ($process.WaitForExit(180000)) 'Native UI fixture did not finish within 180 seconds.'
            Require ($process.ExitCode -eq 0) 'Native UI smoke failed.'
            Require (Test-Path -LiteralPath $resultFile) 'Native UI did not report its completed smoke checks.'
            $result = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
            $evidence = Join-Path $root 'test-results'
            New-Item -ItemType Directory -Force $evidence | Out-Null
            Copy-Item -LiteralPath $resultFile -Destination (Join-Path $evidence "windows-native-ui-$caseIndex.json")
            Require ($result.ok -eq $true -and $result.mode -ceq $case.mode) "Native UI fixture assertions failed: $($result | ConvertTo-Json -Compress -Depth 4)"
            $process.Dispose(); $process = $null
            if ($case.mode -eq 'owned') {
                & $helper verify $case.path
                Require ($LASTEXITCODE -eq 0) 'Native UI fixture ownership or persisted records failed verification.'
            }
        }
        Write-Host 'Native fresh/owned/restart UI smoke passed; no live providers or sending were exercised.'
    }
} finally {
    if ($process) {
        if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
    $client.Dispose()
    foreach ($path in $fixtures) { Remove-Item -LiteralPath $path -Recurse -Force }
}
