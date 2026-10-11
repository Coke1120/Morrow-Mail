#requires -Version 7.2
[CmdletBinding()]
param([switch] $BaselineNavigation)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'These are Windows native control checks.' }
$root = Split-Path $PSScriptRoot -Parent
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('morrow-attachment-flow-' + [guid]::NewGuid().ToString())
$process = $null
$stderr = $null
$reported = $false
function Replace-Once([string] $Path, [string] $Before, [string] $After) {
    $source = [IO.File]::ReadAllText($Path)
    if (($source.Split(@($Before), [StringSplitOptions]::None)).Count -ne 2) { throw "Fixture seam changed: $Before" }
    [IO.File]::WriteAllText($Path, $source.Replace($Before, $After), [Text.UTF8Encoding]::new($false))
}
try {
    New-Item -ItemType Directory $temporary | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'windows') -Destination $temporary -Recurse
    New-Item -ItemType Directory (Join-Path $temporary 'scripts'), (Join-Path $temporary 'assets/brand') | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'scripts/build-windows-native.ps1') -Destination (Join-Path $temporary 'scripts')
    Copy-Item -LiteralPath (Join-Path $root 'assets/brand/morrow.ico') -Destination (Join-Path $temporary 'assets/brand')
    Copy-Item -LiteralPath (Join-Path $root 'package.json') -Destination $temporary
    $native = Join-Path $temporary 'windows'
    $app = Join-Path $native 'App.cpp'
    if ($BaselineNavigation) {
        $baseline = & git -C $root show '654be0d7c65f4e76f8642f1cddf0ee7a4725c0a3:windows/App.cpp'
        if ($LASTEXITCODE -ne 0) { throw 'Pinned main source is unavailable.' }
        [IO.File]::WriteAllText($app, ($baseline -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
    }
    # Only private compiler inputs change. The normal application and package
    # never contain a fixture transport, picker hook or alternate startup.
    Copy-Item -LiteralPath (Join-Path $native 'Checks/AttachmentFlowAssertions.cpp') -Destination $native
    Replace-Once $app 'shell = std::make_shared<morrow::Shell>(); shell->start();' 'shell = std::make_shared<morrow::Shell>(); morrow::startAttachmentFlowChecks(shell);'
    Replace-Once $app 'struct MorrowApplication :' 'namespace morrow { winrt::fire_and_forget startAttachmentFlowChecks(std::shared_ptr<Shell>); }
struct MorrowApplication :'
    Replace-Once $app 'Local\\org.morrowmail.desktop.WinUI' 'Local\\org.morrowmail.desktop.AttachmentChecks'
    $attachments = Join-Path $native 'Attachments.cpp'
    Replace-Once $attachments 'namespace morrow {' 'namespace morrow {
std::filesystem::path attachmentFixtureSelection(bool);
void attachmentFixturePicker(IFileDialog*);'
    Replace-Once $attachments '    if (shell->dialogOpen || shell->closing) return {};' '    if (shell->dialogOpen || shell->closing) return {};
    if (auto path = attachmentFixtureSelection(save); !path.empty()) return path;'
    Replace-Once $attachments '    auto result = dialog->Show(hwnd);' '    attachmentFixturePicker(dialog.get());
    auto result = dialog->Show(hwnd);'
    $service = Join-Path $native 'Service.cpp'
    $signature = 'IAsyncOperation<Json> Service::request(hstring path, hstring owner, hstring method, Json body, bool hostOperation) {'
    $end = 'IAsyncOperation<Json> Service::requestWithStatus('
    $source = [IO.File]::ReadAllText($service)
    $start = $source.IndexOf($signature); $stop = $source.IndexOf($end)
    if ($start -lt 0 -or $stop -le $start) { throw 'Fixture transport seam changed.' }
    $replacement = 'IAsyncOperation<Json> attachmentFixtureRequest(hstring, hstring, hstring, Json);
' + $signature + '
    if (hostOperation) throw hresult_error(E_ACCESSDENIED);
    co_return co_await attachmentFixtureRequest(path, owner, method, body);
}
'
    [IO.File]::WriteAllText($service, $source.Substring(0, $start) + $replacement + $source.Substring($stop), [Text.UTF8Encoding]::new($false))
    & (Join-Path $temporary 'scripts/build-windows-native.ps1') -CompileOnly
    $workspace = Join-Path $temporary 'fictional-workspace'
    New-Item -ItemType Directory $workspace | Out-Null
    [IO.File]::WriteAllText((Join-Path $workspace 'attachment-fixture'), 'isolated')
    $exe = Join-Path $temporary 'build/windows-native/bin/x64/Release/Morrow Mail.exe'
    $startInfo = [Diagnostics.ProcessStartInfo]::new($exe)
    $startInfo.UseShellExecute = $false; $startInfo.RedirectStandardError = $true
    $startInfo.WorkingDirectory = Split-Path $exe -Parent
    foreach ($key in @($startInfo.Environment.Keys)) {
        if ($key.StartsWith('MORROW_') -or $key.StartsWith('GENMAIL_')) { [void] $startInfo.Environment.Remove($key) }
    }
    $startInfo.Environment['MORROW_DATA_DIR'] = $workspace
    $startInfo.ArgumentList.Add('--native-smoke')
    if ($BaselineNavigation) { $startInfo.ArgumentList.Add('--expect-navigation-defect') }
    $process = [Diagnostics.Process]::Start($startInfo)
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(30000)) { throw 'Attachment native checks exceeded their 30-second bound.' }
    Write-Host $stderr.GetAwaiter().GetResult()
    $reported = $true
    if ($process.ExitCode -ne 0 -or [IO.File]::ReadAllText((Join-Path $workspace 'attachment-result.txt')) -cne 'passed') {
        throw 'Attachment native assertions failed.'
    }
} finally {
    if ($process) {
        if (-not $process.HasExited) { $process.Kill($true); if (-not $process.WaitForExit(5000)) { throw 'Owned fixture did not terminate.' } }
        if ($stderr -and -not $reported) {
            if (-not $stderr.Wait(5000)) { throw 'Owned fixture stderr did not finish draining.' }
            Write-Host $stderr.GetAwaiter().GetResult()
        }
        $process.Dispose()
    }
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
