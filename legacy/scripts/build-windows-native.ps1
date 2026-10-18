#requires -Version 7.2
[CmdletBinding()]
param(
    [switch] $CompileOnly,
    [string] $RustService,
    [string] $RustNotices,
    [switch] $Zip
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'Build native Windows candidates on Windows x64.'
}
$root = Split-Path $PSScriptRoot -Parent
$native = Join-Path $root 'windows'
$work = Join-Path $root 'build/windows-native'
$packages = Join-Path $work 'packages'
$bin = Join-Path $work 'bin/x64/Release'
$bundle = Join-Path $work 'Morrow Mail-win32-x64'
New-Item -ItemType Directory -Force $work | Out-Null

function Invoke-Checked([string] $Program, [string[]] $Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$([IO.Path]::GetFileName($Program)) failed (exit $LASTEXITCODE)." }
}
function Write-Utf8([string] $Path, [string] $Value) {
    [IO.File]::WriteAllText($Path, $Value, [Text.UTF8Encoding]::new($false))
}
function Required-File([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required build input is missing: $Path" }
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
Required-File $vswhere
$vs = (& $vswhere -latest -version '[17.0,18.0)' -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
if (-not $vs) { throw 'Visual Studio 2022 with Desktop development with C++ is required.' }
$msbuild = Join-Path $vs 'MSBuild/Current/Bin/amd64/MSBuild.exe'
Required-File $msbuild
$vcvars = Join-Path $vs 'Common7/Tools/Launch-VsDevShell.ps1'
& $vcvars -Arch amd64 -HostArch amd64 -SkipAutomaticLocation | Out-Null
if (-not $env:VCToolsVersion.StartsWith('14.4')) { throw 'Use the VS 2022 v143 14.4x servicing toolset.' }
Required-File (Join-Path $env:WindowsSdkDir 'Include/10.0.26100.0/um/Windows.h')
Write-Host "VS 2022 v143 $($env:VCToolsVersion); Windows SDK 10.0.26100.0; unpackaged x64"

$nuget = (Get-Command nuget.exe -ErrorAction Stop).Source
Invoke-Checked $nuget @('restore', (Join-Path $native 'packages.config'), '-PackagesDirectory', $packages,
    '-ConfigFile', (Join-Path $native 'NuGet.Config'), '-NonInteractive', '-Verbosity', 'quiet')
$hashes = Get-Content -LiteralPath (Join-Path $native 'packages.sha256.json') -Raw | ConvertFrom-Json -AsHashtable
[xml] $packageList = Get-Content -LiteralPath (Join-Path $native 'packages.config') -Raw
if ($hashes.Count -ne @($packageList.packages.package).Count) { throw 'The NuGet package and integrity locks differ.' }
foreach ($package in $packageList.packages.package) {
    $key = "$($package.id).$($package.version)"
    $archive = Join-Path $packages "$key/$key.nupkg"
    Required-File $archive
    if (-not $hashes.ContainsKey($key) -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $hashes[$key]) {
        throw "NuGet integrity mismatch: $key"
    }
}

$metadata = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = [string] $metadata.version
if ($version -notmatch '^(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9.-]+)?$') { throw 'Invalid common package version.' }
$numbers = "$($Matches[1]),$($Matches[2]),$($Matches[3]),0"
$icon = (Join-Path $root 'assets/brand/morrow.ico').Replace('\', '\\')
$versionResource = Join-Path $work 'version.rc'
Write-Utf8 $versionResource @"
#include <windows.h>
101 ICON "$icon"
VS_VERSION_INFO VERSIONINFO
 FILEVERSION $numbers
 PRODUCTVERSION $numbers
 FILEFLAGSMASK VS_FFI_FILEFLAGSMASK
 FILEFLAGS 0
 FILEOS VOS_NT_WINDOWS32
 FILETYPE VFT_APP
BEGIN
 BLOCK "StringFileInfo"
 BEGIN
  BLOCK "040904b0"
  BEGIN
   VALUE "CompanyName", "Morrow Mail contributors\0"
   VALUE "FileDescription", "Morrow Mail\0"
   VALUE "FileVersion", "$version\0"
   VALUE "InternalName", "MorrowMail\0"
   VALUE "OriginalFilename", "Morrow Mail.exe\0"
   VALUE "ProductName", "Morrow Mail\0"
   VALUE "ProductVersion", "$version\0"
  END
 END
 BLOCK "VarFileInfo"
 BEGIN
  VALUE "Translation", 0x409, 1200
 END
END
"@
Invoke-Checked $msbuild @((Join-Path $native 'MorrowMail.vcxproj'), '/m', '/t:Build', '/p:Configuration=Release',
    '/p:Platform=x64', "/p:MorrowVersionResource=$versionResource", '/verbosity:minimal', '/nologo')
Required-File (Join-Path $bin 'Morrow Mail.exe')
if ($CompileOnly) {
    if ($Zip) { throw '-CompileOnly cannot create a package ZIP.' }
    Write-Host "Native UI compiled: $bin (not a packaged candidate)."
    return
}

# Verify the pinned resources with the Rust tool, not the legacy Node generator.
Push-Location $root
try {
    Invoke-Checked 'cargo' @('run', '--manifest-path', 'rust/Cargo.toml', '--release', '--locked', '--bin', 'morrow-resources', '--', '--check')
} finally { Pop-Location }
# The service consumes checked-in resources; no browser build or Node executable.
if (-not $RustService) {
    Push-Location $root
    try {
        Invoke-Checked 'cargo' @('build', '--manifest-path', 'rust/Cargo.toml', '--release', '--locked', '--bin', 'morrow-service')
    } finally { Pop-Location }
    $target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $root 'rust/target' }
    if (-not [IO.Path]::IsPathFullyQualified($target)) { $target = Join-Path $root $target }
    $RustService = Join-Path $target 'release/morrow-service.exe'
}
$RustService = (Resolve-Path -LiteralPath $RustService).Path
$builtVersion = & $RustService --version
if ($LASTEXITCODE -ne 0 -or $builtVersion -cne "Morrow Mail $version") { throw 'The Rust service and package versions differ.' }
if (-not $RustNotices) {
    $RustNotices = Join-Path $work 'THIRD_PARTY_LICENSES.txt'
    Push-Location $root
    try {
        Invoke-Checked 'cargo' @('fetch', '--manifest-path', 'rust/Cargo.toml', '--locked', '--target', 'x86_64-pc-windows-msvc')
        # PowerShell's native line pipeline rewrites embedded CRLF notices.
        # Capture the UTF-8 stream intact, matching the canonical Rust output.
        $noticeProcess = [Diagnostics.Process]::new()
        try {
            $noticeProcess.StartInfo = [Diagnostics.ProcessStartInfo]::new('cargo')
            $noticeProcess.StartInfo.UseShellExecute = $false
            $noticeProcess.StartInfo.WorkingDirectory = $root
            $noticeProcess.StartInfo.RedirectStandardOutput = $true
            $noticeProcess.StartInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false, $true)
            foreach ($argument in @('run', '--quiet', '--manifest-path', 'rust/Cargo.toml', '--release', '--locked', '--bin', 'morrow-notices', '--', '--target', 'x86_64-pc-windows-msvc')) { $noticeProcess.StartInfo.ArgumentList.Add($argument) }
            if (-not $noticeProcess.Start()) { throw 'Rust notice collection could not start.' }
            $read = $noticeProcess.StandardOutput.ReadToEndAsync()
            $noticeProcess.WaitForExit()
            $noticeText = $read.GetAwaiter().GetResult()
            if ($noticeProcess.ExitCode -ne 0 -or [Text.Encoding]::UTF8.GetByteCount($noticeText) -gt 16MB) { throw 'Rust notice collection failed or exceeded its limit.' }
            Write-Utf8 $RustNotices $noticeText
        } finally { $noticeProcess.Dispose() }
    } finally { Pop-Location }
}
Required-File $RustNotices
$notices = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $RustNotices).Path)
if ($notices -notmatch 'x86_64-pc-windows-msvc' -or $notices -notmatch 'MPL-2.0' -or $notices -notmatch 'OpenCC') {
    throw 'Supply the reviewed Windows Rust/OpenCC redistribution notices using -RustNotices.'
}

# This is an isolated candidate output, never build/windows or an installed app.
if (Test-Path -LiteralPath $bundle) { Remove-Item -LiteralPath $bundle -Recurse -Force }
New-Item -ItemType Directory -Force $bundle | Out-Null
Copy-Item -Path (Join-Path $bin '*') -Destination $bundle -Recurse
Get-ChildItem -LiteralPath $bundle -Recurse -File | Where-Object Extension -In '.pdb', '.lib', '.exp', '.ilk' | Remove-Item -Force
$runtime = Join-Path $bundle 'resources/app/runtime'
$backend = Join-Path $bundle 'resources/app/backend'
New-Item -ItemType Directory -Force $runtime, $backend | Out-Null
Copy-Item -LiteralPath $RustService -Destination (Join-Path $runtime 'morrow-service.exe')
Write-Utf8 (Join-Path $runtime 'THIRD_PARTY_LICENSES.txt') $notices
Copy-Item -LiteralPath (Join-Path $root 'package.json') -Destination $backend
Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination $bundle
Write-Utf8 (Join-Path $bundle 'resources/app/package.json') (@{
    name = 'morrow-mail-desktop'; productName = 'Morrow Mail'; version = $version
    serviceRuntime = 'rust'; nativeHost = 'winui3'; license = 'MIT'; private = $true
} | ConvertTo-Json -Compress)

# Hybrid CRT covers our host, but Rust and SDK DLLs can import the dynamic VC CRT.
# App-local deployment works without elevation or a machine-wide redistributable.
$crt = Join-Path $env:VCToolsRedistDir 'x64/Microsoft.VC143.CRT'
$crtFiles = @(Get-ChildItem -LiteralPath $crt -Filter '*.dll' -File)
if (-not $crtFiles.Count) { throw 'The VS 2022 x64 redistributable CRT files are missing.' }
foreach ($file in $crtFiles) {
    Copy-Item -LiteralPath $file.FullName -Destination $bundle
    Copy-Item -LiteralPath $file.FullName -Destination $runtime
}
$noticeDirectory = Join-Path $bundle 'licenses/windows'
New-Item -ItemType Directory -Force $noticeDirectory | Out-Null
foreach ($package in $packageList.packages.package) {
    $key = "$($package.id).$($package.version)"
    $directory = Join-Path $packages $key
    # This package has URL-only SDK terms and contributes build tools, no shipped
    # payload. Every package contributing runtime/header code must carry terms.
    if ($package.id -ceq 'Microsoft.Windows.SDK.BuildTools') { continue }
    $licenseFiles = @(Get-ChildItem -LiteralPath $directory -File | Where-Object { $_.Name -match '^(?:sdk_)?(?:LICENSE|NOTICE|COPYING)(\..*)?$' })
    if (-not $licenseFiles.Count) { throw "Missing NuGet redistribution license: $key" }
    $destination = Join-Path $noticeDirectory $key
    New-Item -ItemType Directory -Force $destination | Out-Null
    foreach ($file in $licenseFiles) { Copy-Item -LiteralPath $file.FullName -Destination $destination }
}
Copy-Item -LiteralPath (Join-Path $native 'packages.config'), (Join-Path $native 'packages.sha256.json') -Destination $noticeDirectory

# Only installed Desktop OAuth credentials; never copy the original arbitrary JSON.
if ($env:MORROW_GOOGLE_OAUTH_FILE -and $env:MORROW_GOOGLE_OAUTH_JSON) { throw 'Choose one Google OAuth build input.' }
$oauthSource = $env:MORROW_GOOGLE_OAUTH_JSON
if ($env:MORROW_GOOGLE_OAUTH_FILE) {
    $inputFile = Get-Item -LiteralPath $env:MORROW_GOOGLE_OAUTH_FILE
    if ($inputFile.Length -gt 32768) { throw 'Google Desktop OAuth input exceeds its limit.' }
    $oauthSource = [IO.File]::ReadAllText($inputFile.FullName)
}
if ($oauthSource) {
    try {
        if ([Text.Encoding]::UTF8.GetByteCount($oauthSource) -gt 32768) { throw 'size' }
        $oauth = $oauthSource | ConvertFrom-Json -AsHashtable
        if ($oauth.ContainsKey('web') -or $oauth.installed -isnot [Collections.IDictionary]) { throw 'type' }
        $client = $oauth.installed
        if ($client.client_id -isnot [string] -or $client.client_id -cnotmatch '^[A-Za-z0-9._-]{1,1000}\.apps\.googleusercontent\.com$') { throw 'id' }
        if ($client.client_secret -isnot [string] -or -not $client.client_secret -or $client.client_secret.Length -gt 4096 -or $client.client_secret -match '[\s\x00-\x1f\x7f]') { throw 'secret' }
        Write-Utf8 (Join-Path $backend 'google-oauth.json') (@{ installed = @{ client_id = $client.client_id; client_secret = $client.client_secret } } | ConvertTo-Json -Compress)
    } catch { throw 'Use a valid Google Desktop app OAuth JSON build input.' }
} elseif ($env:MORROW_REQUIRE_GOOGLE_OAUTH -eq '1') { throw 'This candidate requires a Google Desktop OAuth build input.' }

& (Join-Path $PSScriptRoot 'test-windows-native.ps1') -PackageDirectory $bundle -LayoutOnly
if ($Zip) {
    $artifacts = Join-Path $work 'artifacts'
    New-Item -ItemType Directory -Force $artifacts | Out-Null
    $filename = "Morrow-Mail-$version-windows-x64.zip"
    $archive = Join-Path $artifacts $filename
    Compress-Archive -LiteralPath $bundle -DestinationPath $archive -Force
    Write-Utf8 (Join-Path $artifacts 'SHA256SUMS-windows-x64.txt') ("$((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant())  $filename`n")
}
Write-Host "Built unsigned native candidate: $bundle. No release was published."
