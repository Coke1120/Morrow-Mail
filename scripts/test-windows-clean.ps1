#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $PackageDirectory,
    [Parameter(Mandatory = $true)][string] $FixtureHelper,
    [Parameter(Mandatory = $true)][string] $ReportPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Run in a disposable clean Windows VM. This script needs neither Rust nor PowerShell 7.
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Windows is required.' }
$package = (Resolve-Path -LiteralPath $PackageDirectory).Path
$helper = (Resolve-Path -LiteralPath $FixtureHelper).Path
$report = [IO.Path]::GetFullPath($ReportPath)
foreach ($tool in @('cargo.exe', 'cl.exe', 'msbuild.exe', 'node.exe')) {
    if (Get-Command $tool -ErrorAction SilentlyContinue) { throw "Use a clean VM without developer tools on PATH ($tool was found)." }
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('Morrow clean 測試 ' + [Guid]::NewGuid().ToString('N'))
$install = Join-Path $root 'Portable app with spaces'
$results = @()
$process = $null
$originalData = [Environment]::GetEnvironmentVariable('MORROW_DATA_DIR', 'Process')
function Run-Child([string] $File, [string] $Arguments, [string] $Workspace, [int] $Seconds) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $File; $info.Arguments = $Arguments; $info.UseShellExecute = $false
    $info.WorkingDirectory = $install
    $info.EnvironmentVariables['PATH'] = "$env:SystemRoot\System32;$env:SystemRoot;$install"
    $info.EnvironmentVariables['MORROW_DATA_DIR'] = $Workspace
    foreach ($key in @('NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE','WEBVIEW2_BROWSER_EXECUTABLE_FOLDER','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS','WEBVIEW2_USER_DATA_FOLDER')) { $info.EnvironmentVariables.Remove($key) }
    $script:process = [Diagnostics.Process]::Start($info)
    if (-not $script:process.WaitForExit($Seconds * 1000)) { throw 'Clean deployment acceptance timed out.' }
    $code = $script:process.ExitCode
    $script:process.Dispose(); $script:process = $null
    if ($code -ne 0) { throw "Clean deployment acceptance exited with code $code." }
}
try {
    New-Item -ItemType Directory -Path $root | Out-Null
    Copy-Item -LiteralPath $package -Destination $install -Recurse
    $exe = Join-Path $install 'Morrow Mail.exe'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Choose the unpacked native package directory.' }
    # The helper is separate QA material, never part of a published app.
    $qa = Join-Path $root 'native_fixture.exe'
    Copy-Item -LiteralPath $helper -Destination $qa
    foreach ($dll in @('vcruntime140.dll', 'vcruntime140_1.dll')) {
        $source = Join-Path $install $dll
        if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $root $dll) }
    }
    $before = @(Get-ChildItem -LiteralPath $install -Recurse -File | ForEach-Object { $_.FullName + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash })
    $fresh = Join-Path $root 'Fresh workspace'; $owned = Join-Path $root 'Owned fictional mailbox'
    foreach ($workspace in @($fresh,$owned)) {
        New-Item -ItemType Directory -Path $workspace | Out-Null
        [IO.File]::WriteAllText((Join-Path $workspace 'disposable-native-fixture'),'Morrow native acceptance fixture')
    }
    Run-Child $qa ('seed "' + $owned + '"') $owned 60
    foreach ($case in @(@{ workspace=$fresh; name='fresh' }, @{ workspace=$owned; name='owned' }, @{ workspace=$owned; name='restart' })) {
        $resultPath = Join-Path $case.workspace 'native-smoke-result.json'
        if (Test-Path -LiteralPath $resultPath) { Remove-Item -LiteralPath $resultPath }
        Run-Child $exe '--native-smoke' $case.workspace 180
        $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
        if ($result.ok -ne $true -or $result.mode -ne $(if ($case.name -eq 'fresh') { 'fresh' } else { 'owned' })) { throw ('Native smoke did not pass: ' + $case.name) }
        $results += [ordered]@{ name=$case.name; report=$result }
    }
    $after = @(Get-ChildItem -LiteralPath $install -Recurse -File | ForEach-Object { $_.FullName + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash })
    if (Compare-Object $before $after) { throw 'The portable installation changed during acceptance.' }
    [ordered]@{ status='passed'; os=[Environment]::OSVersion.Version.ToString(); developerToolsOnPath=$false; isolatedWorkspace=$true; unicodePortablePath=$true; cases=$results; scope='Relocated-package check; this does not prove clean VM provenance, signing, live accounts or installed-updater rollback.' } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $report -Encoding UTF8
    Write-Host 'Clean deployment checks passed. Inspect the report for HTML-runtime availability and remaining acceptance scope.'
} finally {
    if ($process) { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }; $process.Dispose() }
    [Environment]::SetEnvironmentVariable('MORROW_DATA_DIR', $originalData, 'Process')
    # Preserve failed fixture evidence. No installed app or owner workspace is touched.
    if (Test-Path -LiteralPath $root) { Write-Host "Disposable acceptance files: $root" }
}
