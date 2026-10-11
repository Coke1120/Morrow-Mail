#requires -Version 7.2
# Corrupt only a copy of the native positive fixture's fixed metadata. These
# controls test the independent verifier, not real PID reuse or real accounts.
function Test-NativeBirthLedgerVerifier([string] $LedgerPath, [string] $Temporary,
    [uint32] $LauncherPid, [long] $LauncherTicks, [object[]] $Samples) {
    $original = @(Get-Content -LiteralPath $LedgerPath | ForEach-Object { ConvertFrom-Json -InputObject $_ -AsHashtable })
    foreach ($case in @('missing-footer', 'event-loss', 'replayed-birth', 'overlapping-pid', 'parent-identity',
        'false-zero', 'unknown-exit', 'denied-as-zero', 'wrong-job-total', 'wrong-launcher', 'float-identity',
        'extra-field', 'partial-line', 'oversized-file', 'foreign-counter')) {
        $rows = @($original | ForEach-Object { $_.Clone() })
        $sampleCopy = $Samples; $suffix = ''
        switch ($case) {
            'missing-footer' { $rows = @($rows | Where-Object { $_.kind -ne 3 }) }
            'event-loss' { $rows = @($rows | Where-Object { -not ($_.kind -eq 1 -and $_.seq -eq 2) }) }
            'replayed-birth' { $rows = @($rows[0], $rows[1], $rows[1].Clone()) + @($rows | Select-Object -Skip 2) }
            'overlapping-pid' {
                $birth = $rows[2].Clone(); $birth.ticks++; $birth.seq = 3L
                $rows = @($rows[0], $rows[1], $rows[2], $birth) + @($rows | Select-Object -Skip 3)
            }
            'parent-identity' { $rows[2].parentTicks++ }
            'false-zero' { ($rows | Where-Object { $_.kind -eq 2 } | Select-Object -First 1).eventCode = 7L }
            'unknown-exit' {
                $exit = $rows | Where-Object { $_.kind -eq 2 } | Select-Object -First 1
                $exit.exitCode = $null; $exit.exitTicks = 0L; $exit.waitResult = 258L; $exit.outcome = 'alive'
            }
            'denied-as-zero' { ($rows | Where-Object { $_.kind -eq 2 } | Select-Object -First 1).nativeError = 5L }
            'wrong-job-total' { $rows[-1].jobTotal++ }
            'wrong-launcher' { $rows[0].launcherPid++ }
            'float-identity' { $rows[2].ticks = 1.5 }
            'extra-field' { $rows[2]['unexpected'] = 'synthetic' }
            'partial-line' { $suffix = 'partial' }
            'foreign-counter' {
                $sampleCopy = @(@{ processes = @(@{ pid = $rows[1].pid; parentPid = $rows[1].parentPid
                    startUtcTicks = $rows[1].ticks + 1L; role = 'ui' }) })
            }
        }
        $path = Join-Path $Temporary ('verifier-' + $case + '.jsonl')
        if ($case -eq 'oversized-file') { [IO.File]::WriteAllBytes($path, [byte[]]::new(2MB + 1)) }
        else {
            $text = (@($rows | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 5 }) -join "`n") + "`n" + $suffix
            [IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($false))
        }
        $result = Read-NativeBirthLedger $path 0 $LauncherPid $LauncherTicks $sampleCopy
        if (-not $result.incomplete) { throw ('Lifetime verifier accepted its corruption control: ' + $case) }
        Write-Host ('Native lifetime verifier case ' + $case + ': rejected')
    }
    Write-Host 'Native lifetime verifier controls passed (15).'
}
