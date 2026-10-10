#requires -Version 7.2
[CmdletBinding()]
param([string] $OutputDirectory, [switch] $SchemaSelfTest)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'native-process-identity.ps1')

function Check([bool] $Value, [string] $Stage) {
    if (-not $Value) { throw [InvalidOperationException]::new($Stage) }
}
if ($SchemaSelfTest) {
    # Pure integer identity checks only. No Win32 call, process or native pass.
    $ticks = 639272422968530917L
    Check ([MorrowObservationIdentity.ExitProof]::MatchesCreation($ticks, $ticks, $ticks - 100L)) 'exact-identity'
    Check ([MorrowObservationIdentity.ExitProof]::MatchesCreation($ticks, $ticks - 7L, $ticks - 100L)) 'cim-precision'
    Check (-not [MorrowObservationIdentity.ExitProof]::MatchesCreation($ticks, $ticks + 10L, $ticks - 100L)) 'different-identity'
    Check (-not [MorrowObservationIdentity.ExitProof]::MatchesCreation($ticks, $ticks, $ticks + 1L)) 'parent-order'
    Check (-not [MorrowObservationIdentity.ExitProof]::MatchesCreation($ticks, 0L, $ticks - 100L)) 'invalid-identity'
    $invalid = [MorrowObservationIdentity.ExitProof]::Probe(0, $ticks, $ticks - 100L)
    Check (-not $invalid.ProvenZero -and $invalid.Outcome -ceq 'invalidInput' -and -not $invalid.HandleOpened) 'invalid-input-no-native'
    Write-Host 'Native identity pure integer/input checks passed; Windows proof was not run.'
    return
}
Check $IsWindows 'windows-required'
Check (-not [string]::IsNullOrWhiteSpace($OutputDirectory) -and [IO.Path]::IsPathFullyQualified($OutputDirectory)) 'absolute-new-output-required'
Check (-not [IO.Directory]::Exists($OutputDirectory) -and -not [IO.File]::Exists($OutputDirectory)) 'output-already-exists'
$directory = [IO.Directory]::CreateDirectory($OutputDirectory)
Check (-not ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'output-reparse-point'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace MorrowObservationIdentityFixture {
    public static class Handles {
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern SafeProcessHandle OpenProcess(uint rights, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);
        public static SafeProcessHandle Open(uint pid, string mode) {
            uint rights;
            switch (mode) {
                case "limited": rights = 0x101000; break;
                case "synchronize-only": rights = 0x100000; break;
                case "query-only": rights = 0x1000; break;
                default: throw new ArgumentException("Invalid fixture handle mode.");
            }
            var handle = OpenProcess(rights, false, pid);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error);
            }
            return handle;
        }
    }
}
'@

function Start-OwnedChild {
    $source = @'
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
$command = [Console]::ReadLine()
if ($command -ceq 'exit0') { exit 0 }
if ($command -ceq 'exit7') { exit 7 }
exit 9
'@
    $start = [Diagnostics.ProcessStartInfo]::new([Environment]::ProcessPath)
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true
    $start.Environment.Clear()
    foreach ($key in @('SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'ProgramFiles', 'PSModulePath')) {
        $value = [Environment]::GetEnvironmentVariable($key)
        if ($null -ne $value) { $start.Environment[$key] = $value }
    }
    foreach ($arg in @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($source)))) {
        $start.ArgumentList.Add($arg)
    }
    $child = [Diagnostics.Process]::Start($start)
    try {
        $ready = $child.StandardOutput.ReadLineAsync()
        Check ($ready.Wait(5000) -and $ready.GetAwaiter().GetResult() -ceq 'ready') 'child-ready'
        return $child
    } catch { Stop-OwnedChild $child; throw }
}
function Stop-OwnedChild($Child) {
    if (-not $Child) { return }
    try {
        if (-not $Child.HasExited) {
            try { $Child.StandardInput.WriteLine('exit0'); $Child.StandardInput.Flush() } catch { }
            if (-not $Child.WaitForExit(5000)) { $Child.Kill(); Check ($Child.WaitForExit(2000)) 'owned-child-reap' }
        }
    } finally { $Child.Dispose() }
}
function Read-LookupRejection([uint32] $ProcessId) {
    $found = $null
    try { $found = [Diagnostics.Process]::GetProcessById([int] $ProcessId); return $false }
    catch {
        $failure = $_.Exception
        while ($failure.InnerException) { $failure = $failure.InnerException }
        if ($failure -is [ArgumentException]) { return $true }
        throw
    } finally { if ($found) { $found.Dispose() } }
}
function Convert-Proof($Proof) {
    # Fixed keys, fixed helper enums and numeric/boolean API metadata only.
    return [ordered]@{ outcome = $Proof.Outcome; stage = $Proof.Stage; expectedPid = $Proof.ExpectedPid
        actualPid = $Proof.ActualPid; startUtcTicks = $Proof.StartUtcTicks; handleOpened = $Proof.HandleOpened
        identityMatched = $Proof.IdentityMatched; signaled = $Proof.Signaled; exitCode = $Proof.ExitCode
        nativeError = $Proof.NativeError; provenZero = $Proof.ProvenZero }
}
$records = [Collections.Generic.List[object]]::new()
$report = [ordered]@{ schemaVersion = 1; native = $true; ok = $false; collectorIntegrated = $false
    parentOwnership = 'fixture-created-child-only'; helperChecksParentOwnership = $false
    expectedCreationSource = 'owned-process-start-time'; actualCreationSource = 'native-get-process-times'
    failureCase = $null; failureStage = $null; failureKind = $null; failureNativeError = $null
    cleanupFailed = $false; cases = $records }
$child = $null; $fixtureHandle = $null; $currentCase = 'setup'; $self = [Diagnostics.Process]::GetCurrentProcess()
$failureSeen = $false; $operation = 'start'; $watch = [Diagnostics.Stopwatch]::StartNew()
try {
    foreach ($currentCase in @('live-control', 'held-exit-zero', 'held-exit-zero-cim-precision', 'held-exit-nonzero',
        'released-handles', 'projected-pid-mismatch', 'projected-creation-mismatch', 'projected-parent-start',
        'query-without-rights', 'wait-without-rights')) {
        $operation = 'wall-budget'
        Check ($watch.ElapsedMilliseconds -lt 60000) 'fixture-wall-budget'
        $operation = 'child-ready'
        $child = Start-OwnedChild
        $operation = 'owned-identity'
        $childId = [uint32] $child.Id; $ticks = $child.StartTime.ToUniversalTime().Ticks
        $parentTicks = $self.StartTime.ToUniversalTime().Ticks
        $cimTicks = if ($currentCase -eq 'held-exit-zero-cim-precision') { $ticks - $ticks % 10L } else { $ticks }
        $lookupArgument = $false; $released = $false; $projection = 'none'
        if ($currentCase -notin @('live-control', 'query-without-rights', 'wait-without-rights')) {
            $operation = 'child-exit-barrier'
            $child.StandardInput.WriteLine($(if ($currentCase -eq 'held-exit-nonzero') { 'exit7' } else { 'exit0' }))
            $child.StandardInput.Flush(); Check ($child.WaitForExit(5000)) 'child-exit-barrier'
            if ($currentCase -eq 'released-handles') { $child.Dispose(); $child = $null; $released = $true }
            $operation = 'dotnet-lookup'
            $lookupArgument = Read-LookupRejection $childId
        }
        $operation = 'native-proof'
        switch ($currentCase) {
            'projected-pid-mismatch' {
                $projection = 'expected-pid-only'
                $fixtureHandle = [MorrowObservationIdentityFixture.Handles]::Open($childId, 'limited')
                $proof = [MorrowObservationIdentity.ExitProof]::ReadHandle($fixtureHandle, ([uint32]($childId -bxor 1)), $cimTicks, $parentTicks)
            }
            'projected-creation-mismatch' {
                $projection = 'expected-creation-only'
                $proof = Get-NativeProcessExitProof $childId ($cimTicks + 10L) $parentTicks
            }
            'projected-parent-start' {
                $projection = 'parent-time-lower-bound-only'
                $proof = Get-NativeProcessExitProof $childId $cimTicks ($ticks + 1L)
            }
            'query-without-rights' {
                $projection = 'synchronize-only-handle-rights'
                $fixtureHandle = [MorrowObservationIdentityFixture.Handles]::Open($childId, 'synchronize-only')
                $proof = [MorrowObservationIdentity.ExitProof]::ReadHandle($fixtureHandle, $childId, $cimTicks, $parentTicks)
            }
            'wait-without-rights' {
                $projection = 'query-only-handle-rights'
                $fixtureHandle = [MorrowObservationIdentityFixture.Handles]::Open($childId, 'query-only')
                $proof = [MorrowObservationIdentity.ExitProof]::ReadHandle($fixtureHandle, $childId, $cimTicks, $parentTicks)
            }
            default { $proof = Get-NativeProcessExitProof $childId $cimTicks $parentTicks }
        }
        $record = [ordered]@{ case = $currentCase; native = $true; projection = $projection
            cimPrecisionProjected = ($currentCase -eq 'held-exit-zero-cim-precision'); fixtureHandlesReleased = $released
            lookupArgumentException = $lookupArgument; proof = (Convert-Proof $proof); passed = $false }
        $records.Add($record)
        $operation = 'case-assertion'
        switch ($currentCase) {
            'live-control' { Check (-not $proof.ProvenZero -and $proof.Outcome -ceq 'alive' -and $proof.IdentityMatched -and -not $proof.Signaled) 'live-is-not-zero' }
            { $_ -in @('held-exit-zero', 'held-exit-zero-cim-precision') } {
                Check ($lookupArgument -and $proof.ProvenZero -and $proof.ActualPid -eq $childId -and $proof.StartUtcTicks -eq $ticks) 'held-zero-lookup-vs-native'
            }
            'held-exit-nonzero' { Check ($lookupArgument -and -not $proof.ProvenZero -and $proof.Outcome -ceq 'nonzeroExit' -and $proof.ExitCode -eq 7) 'nonzero-is-not-zero' }
            'released-handles' {
                # If another observer still retains the kernel object, this
                # fixture has not established unavailability and must fail.
                # Do not retry until green or pretend that proof was absent.
                Check (-not $proof.ProvenZero -and (($proof.Stage -ceq 'open' -and $proof.Outcome -ceq 'unavailable') -or $proof.Outcome -ceq 'identityMismatch')) 'released-object-unavailable'
            }
            { $_ -like 'projected-*' } { Check (-not $proof.ProvenZero -and $proof.Outcome -ceq 'identityMismatch') 'projected-identity-rejected' }
            'query-without-rights' { Check (-not $proof.ProvenZero -and $proof.Outcome -ceq 'accessDenied' -and $proof.Stage -ceq 'pid' -and $proof.NativeError -eq 5) 'native-query-denial' }
            'wait-without-rights' { Check (-not $proof.ProvenZero -and $proof.Outcome -ceq 'accessDenied' -and $proof.Stage -ceq 'wait' -and $proof.IdentityMatched -and $proof.NativeError -eq 5) 'native-wait-denial' }
        }
        $record.passed = $true
        Write-Host ('Native process identity proof: ' + ($record | ConvertTo-Json -Compress -Depth 4))
        $operation = 'case-cleanup'
        if ($fixtureHandle) { $fixtureHandle.Dispose(); $fixtureHandle = $null }
        Stop-OwnedChild $child; $child = $null
    }
    $report.ok = $true
} catch {
    $failureSeen = $true; $report.failureCase = $currentCase; $report.failureStage = $operation
    $failure = $_.Exception
    while ($failure.InnerException) { $failure = $failure.InnerException }
    # No exception messages, process command lines or paths enter evidence.
    $report.failureKind = if ($failure -is [ComponentModel.Win32Exception]) { 'win32' }
        elseif ($failure -is [ArgumentException]) { 'argument' }
        elseif ($failure -is [InvalidOperationException]) { 'invalidOperation' } else { 'other' }
    if ($failure -is [ComponentModel.Win32Exception]) { $report.failureNativeError = $failure.NativeErrorCode }
} finally {
    try { if ($fixtureHandle) { $fixtureHandle.Dispose() }; Stop-OwnedChild $child }
    catch { $report.ok = $false; $report.cleanupFailed = $true; if (-not $failureSeen) { $report.failureCase = $currentCase; $report.failureStage = 'cleanup' } }
    finally {
        $self.Dispose()
        $json = $report | ConvertTo-Json -Depth 6
        $bytes = [Text.Encoding]::UTF8.GetBytes($json)
        Check ($bytes.Length -le 32768) 'report-limit'
        $stream = [IO.File]::Open((Join-Path $directory.FullName 'identity-proof.json'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
        Write-Host ('Native process identity proof report: ' + ($report | ConvertTo-Json -Compress -Depth 6))
    }
}
if (-not $report.ok) { throw 'Native process identity proof failed; inspect the fixed-field report.' }
