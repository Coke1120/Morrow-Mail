#requires -Version 7.2
# Dot-sourced collector fixtures only. Timing/lookup projections are explicit;
# they do not claim reproduction of a historical kernel race or native UI pass.
function Test-NativePinnedExitSchema {
    function Check([bool] $Value, [string] $Stage) {
        if (-not $Value) { throw ('Pinned exit schema fixture failed: ' + $Stage + '.') }
    }
    function Copy-ProofFixture($Value) { return ConvertFrom-Json ($Value | ConvertTo-Json -Compress -Depth 8) -AsHashtable }
    $ticks = 638999000000000017L
    $initial = @{ actualPid = 21L; startUtcTicks = $ticks; identityMatched = $true; signaled = $false
        waitStatus = 258L; exitCode = 0L; nativeError = $null; stage = 'wait'; outcome = 'pendingZero' }
    $final = $initial.Clone(); $final.waitStatus = 0L; $final.signaled = $true; $final.stage = 'exit'; $final.outcome = 'zeroExit'
    $proof = @{ pinnedStartUtcTicks = $ticks; parentStartUtcTicks = $ticks - 1000L; parentBefore = 'valid'; parentAfter = 'valid'
        clockFrequency = 1000L; sampleStartedAtQpc = 100000L; admissionStartedAtQpc = 100001L; collectorDeadlineAtQpc = 280000L
        startedAtQpc = 100002L; completedAtQpc = 100004L; deadlineAtQpc = 100251L; durationMs = 2.0
        waitAttempted = $true; settlingWait = 0L; settlingError = $null; deadlineExceeded = $false; projection = $false
        outcome = 'zeroExit'; initial = $initial; final = $final }
    $event = @{ pid = 21L; parentPid = 20L; startUtcTicks = $ticks; role = 'other'; exitCode = 0L; phase = 'beforeCounters'
        source = 'cim'; identitySource = 'nativeLookupFallback'; nativeProof = $proof }
    $sample = @{ kind = 0; nativeProofVersion = 1L; elapsedMs = 0.0; queryMs = 4.0; skipped = 0L; rootSkipped = 0L
        rootExitedDuringSample = $false; skipReasonCounts = New-NativeSkipReasonCounts; lifecycleEvents = @($event); failedRecords = @()
        processes = @(@{ pid = 20L; parentPid = 10L; startUtcTicks = $ticks - 1000L; role = 'ui'
            workingSetBytes = 1000L; privateBytes = 1000L; cpuMs = 0.0 }) }
    $path = Join-Path ([IO.Path]::GetTempPath()) ('morrow-pinned-schema-' + [Guid]::NewGuid().ToString('N') + '.jsonl')
    function Read-ProofFixture([object[]] $Samples) {
        $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        try {
            foreach ($row in $Samples) { Check (Write-NativeSample $stream $row) 'bounded-write' }
            Check (Write-NativeSample $stream @{ kind = 1; reason = 0; samples = $Samples.Count; failureStage = 'none' }) 'bounded-footer'
        } finally { $stream.Dispose() }
        try { return Read-NativeResourceReport $path @{ forced = $false; reaped = $true; exitCode = 0 } @{} }
        finally { [IO.File]::Delete($path) }
    }
    try {
        $report = Read-ProofFixture @($sample)
        Check (-not $report.incomplete -and -not $report.invalidRecords -and $report.normalExitObservations -eq 1) 'pending-zero-positive'
        Check ($report.samples[0].lifecycleEvents[0].nativeProof.final.startUtcTicks -eq $ticks) 'exact-int64-native-ticks'
        $direct = Copy-ProofFixture $sample; $p = $direct.lifecycleEvents[0].nativeProof
        $p.initial = Copy-ProofFixture $p.final; $p.waitAttempted = $false; $p.settlingWait = $null
        # Already-signaled real zero retains the prior behavior when another
        # child's shared settling deadline is exhausted.
        $p.completedAtQpc = 100300L; $p.durationMs = 298.0
        Check (-not (Read-ProofFixture @($direct)).incomplete) 'direct-zero-independent-budget'
        $denied = Copy-ProofFixture $sample; $denied.lifecycleEvents = @(); $denied.skipped = 1L
        $denied.skipReasonCounts.processUnavailable = 1L
        $p = Copy-ProofFixture $proof; $p.final = $null; $p.settlingWait = 4294967295L; $p.settlingError = 5L; $p.outcome = 'accessDenied'
        $denied.failedRecords = @(@{ pid = 21L; parentPid = 20L; cimStartUtcTicks = $ticks; source = 'cim'; reason = 'processUnavailable'
            stage = 'nativeWait'; errorKind = 'accessDenied'; errorCode = 5L; exitCode = $null; nativeProof = $p })
        $report = Read-ProofFixture @($denied)
        Check ($report.incomplete -and -not $report.invalidRecords -and
            $report.samples[0].failedRecords[0].nativeProof.settlingWait -eq 4294967295L) 'unsigned-wait-failed-remains-gap'
        $initialDenied = Copy-ProofFixture $denied; $p = $initialDenied.failedRecords[0].nativeProof
        $p.initial.waitStatus = 4294967295L; $p.initial.nativeError = 5L; $p.initial.exitCode = $null; $p.initial.outcome = 'accessDenied'
        $p.waitAttempted = $false; $p.settlingWait = $null; $p.settlingError = $null
        Check (-not (Read-ProofFixture @($initialDenied)).invalidRecords) 'initial-wait-failed-valid-gap'
        $before = Copy-ProofFixture $denied; $before.failedRecords[0].Remove('nativeProof'); $before.failedRecords[0].stage = 'counters'
        $before.failedRecords[0].reason = 'counterReadFailed'; $before.skipReasonCounts.processUnavailable = 0L; $before.skipReasonCounts.counterReadFailed = 1L
        $later = Copy-ProofFixture $sample; $later.elapsedMs = 10.0
        $report = Read-ProofFixture @($before, $later)
        Check ($report.incomplete -and $report.sampleGaps -and -not $report.invalidRecords -and
            $report.normalExitObservations -eq 1 -and $report.skipReasonCounts.counterReadFailed -eq 1) 'earlier-denied-not-erased-by-zero'
        $parentFailure = Copy-ProofFixture $denied; $p = $parentFailure.failedRecords[0]
        $p.stage = 'parent'; $p.reason = 'parentExited'; $p.errorKind = 'other'; $p.errorCode = $null; $p.exitCode = 0L
        $p.nativeProof = Copy-ProofFixture $proof; $p.nativeProof.parentAfter = 'parentExited'
        $parentFailure.skipReasonCounts.processUnavailable = 0L; $parentFailure.skipReasonCounts.parentExited = 1L
        $report = Read-ProofFixture @($parentFailure)
        Check ($report.incomplete -and -not $report.invalidRecords -and
            $report.samples[0].failedRecords[0].nativeProof.final.exitCode -eq 0) 'parent-failure-retains-child-zero-proof'

        $negativeCases = @('missing-metadata', 'missing-initial', 'extra-field', 'wait-string', 'wait-float', 'wait-bool',
            'wait-negative', 'wait-overflow', 'initial-259', 'initial-7', 'initial-crash-code', 'initial-code-missing',
            'initial-query-denied', 'initial-query-error', 'initial-wait-failed', 'final-timeout', 'final-7', 'final-crash-code',
            'final-wait-failed', 'final-unexpected-wait', 'final-pid-change', 'final-submicro-creation-change', 'final-missing',
            'parent-exited', 'parent-changed', 'parent-unavailable', 'expired', 'deadline-over-budget', 'collector-deadline-clip',
            'collector-over-budget', 'duration-negative', 'duration-mismatch', 'outcome-conflict', 'wait-not-attempted',
            'error-on-success', 'projected-proof', 'duplicate-event', 'clock-order', 'clock-float', 'native-proof-version')
        foreach ($case in $negativeCases) {
            $bad = Copy-ProofFixture $sample; $p = $bad.lifecycleEvents[0].nativeProof
            switch ($case) {
                'missing-metadata' { $bad.lifecycleEvents[0].Remove('nativeProof') }
                'missing-initial' { $p.Remove('initial') }
                'extra-field' { $p.extra = 0L }
                'wait-string' { $p.initial.waitStatus = '258' }
                'wait-float' { $p.initial.waitStatus = 258.1 }
                'wait-bool' { $p.initial.waitStatus = $true }
                'wait-negative' { $p.initial.waitStatus = -1L }
                'wait-overflow' { $p.initial.waitStatus = 4294967296L }
                'initial-259' { $p.initial.exitCode = 259L; $p.initial.outcome = 'alive' }
                'initial-7' { $p.initial.exitCode = 7L; $p.initial.outcome = 'nonzeroExit' }
                'initial-crash-code' { $p.initial.exitCode = -1073741819L; $p.initial.outcome = 'nonzeroExit' }
                'initial-code-missing' { $p.initial.exitCode = $null }
                'initial-query-denied' { $p.initial.nativeError = 5L; $p.initial.exitCode = $null; $p.initial.stage = 'exit'; $p.initial.outcome = 'accessDenied' }
                'initial-query-error' { $p.initial.nativeError = 87L; $p.initial.exitCode = $null; $p.initial.stage = 'exit'; $p.initial.outcome = 'unavailable' }
                'initial-wait-failed' { $p.initial.waitStatus = 4294967295L; $p.initial.nativeError = 5L; $p.initial.exitCode = $null; $p.initial.outcome = 'accessDenied' }
                'final-timeout' { $p.final.waitStatus = 258L; $p.final.exitCode = $null; $p.final.signaled = $false; $p.final.stage = 'wait'; $p.final.outcome = 'alive' }
                'final-7' { $p.final.exitCode = 7L; $p.final.outcome = 'nonzeroExit' }
                'final-crash-code' { $p.final.exitCode = -1073741819L; $p.final.outcome = 'nonzeroExit' }
                'final-wait-failed' { $p.final.waitStatus = 4294967295L; $p.final.exitCode = $null; $p.final.nativeError = 5L; $p.final.signaled = $false; $p.final.stage = 'wait'; $p.final.outcome = 'accessDenied' }
                'final-unexpected-wait' { $p.final.waitStatus = 128L; $p.final.exitCode = $null; $p.final.signaled = $false; $p.final.stage = 'wait'; $p.final.outcome = 'invalidWait' }
                'final-pid-change' { $p.final.actualPid = 22L }
                'final-submicro-creation-change' { $p.final.startUtcTicks++ }
                'final-missing' { $p.final = $null }
                'parent-exited' { $p.parentAfter = 'parentExited' }
                'parent-changed' { $p.parentAfter = 'identityMismatch' }
                'parent-unavailable' { $p.parentAfter = 'parentUnavailable' }
                'expired' { $p.completedAtQpc = $p.deadlineAtQpc + 1L; $p.durationMs = 250.0 }
                'deadline-over-budget' { $p.deadlineAtQpc++ }
                'collector-deadline-clip' { $p.collectorDeadlineAtQpc = 100003L }
                'collector-over-budget' { $p.collectorDeadlineAtQpc = 280001L }
                'duration-negative' { $p.durationMs = -1.0 }
                'duration-mismatch' { $p.durationMs = 100.0 }
                'outcome-conflict' { $p.outcome = 'alive' }
                'wait-not-attempted' { $p.waitAttempted = $false }
                'error-on-success' { $p.final.nativeError = 5L }
                'projected-proof' { $p.projection = $true }
                'duplicate-event' { $bad.lifecycleEvents += Copy-ProofFixture $bad.lifecycleEvents[0] }
                'clock-order' { $p.completedAtQpc = 100001L }
                'clock-float' { $p.deadlineAtQpc = 100251.1 }
                'native-proof-version' { $bad.nativeProofVersion = 2L }
            }
            $report = Read-ProofFixture @($bad)
            Check ($report.incomplete -and $report.invalidRecords) $case
        }
        $bad = Copy-ProofFixture $denied; $bad.failedRecords[0].nativeProof.settlingWait = -1L
        Check (Read-ProofFixture @($bad)).invalidRecords 'wait-failed-not-signed-exit-minus-one'
        Write-Host ('Pinned exit schema controls passed: 6 positive/history controls, ' + ($negativeCases.Count + 1) + ' strict negative controls; synthetic parser evidence only.')
    } finally { if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) } }
}

function Test-NativePinnedSnapshot($Control, $Self) {
    $child = $null; $ancestor = $null; $state = $null
    $path = Join-Path ([IO.Path]::GetTempPath()) ('morrow-pinned-snapshot-' + [Guid]::NewGuid().ToString('N') + '.jsonl')
    $root = [uint32] $Self.Id; $rootTicks = $Self.StartTime.ToUniversalTime().Ticks
    $cases = @('projected-same-query-zero', 'initial-259-later-zero', 'earlier-counter-denied-later-zero',
        'projected-parent-exit', 'projected-parent-identity-change', 'projected-parent-cache-change',
        'projected-parent-recheck-budget', 'projected-shared-deadline', 'projected-collector-deadline-clip')
    try {
        foreach ($case in $cases) {
            $facts = @{ pins = [Collections.Generic.List[object]]::new(); proofs = [Collections.Generic.List[object]]::new()
                deadlines = [Collections.Generic.List[long]]::new(); lookups = 0; countersDenied = 0 }
            $parentCase = $case -like 'projected-parent-*'; $shared = $case -eq 'projected-shared-deadline'
            if ($parentCase -or $shared) { $ancestor = Start-LifecycleChild }
            $child = Start-LifecycleChild; $childId = [uint32] $child.Id
            $parentId = if ($parentCase) { [uint32] $ancestor.Id } else { $root }
            $wanted = @($root, [uint32] $(if ($parentCase -or $shared) { $ancestor.Id } else { $Control.Id }), $childId)
            $rows = @(Read-LifecycleInventory $wanted)
            if ($parentCase) { ($rows | Where-Object { $_.ProcessId -eq $childId }).ParentProcessId = $parentId }
            $state = New-NativeObservationState $root $rootTicks
            $first = $null; $later = $null
            $acquire = {
                param([uint32] $CandidateId)
                $handle = [MorrowObservationIdentity.ExitProof]::Acquire($CandidateId)
                $facts.pins.Add($handle); return $handle
            }.GetNewClosure()
            $lookup = {
                param([uint32] $CandidateId)
                if ($CandidateId -eq $childId -or ($shared -and $CandidateId -eq $ancestor.Id)) {
                    $facts.lookups++; throw [ArgumentException]::new('Fixture lookup timing projection.')
                }
                return [Diagnostics.Process]::GetProcessById($CandidateId)
            }.GetNewClosure()
            $readProof = {
                param($Handle, [uint32] $CandidateId, [long] $CimTicks, [long] $ParentTicks, [long] $PinnedTicks, [long] $Deadline)
                $facts.deadlines.Add($Deadline)
                if ($case -eq 'initial-259-later-zero') {
                    $proof = [MorrowObservationIdentity.ExitProof]::ReadLookupHandle($Handle, $CandidateId, $CimTicks, $ParentTicks, $PinnedTicks, $Deadline)
                } else {
                    $projection = [MorrowObservationIdentity.LookupProjection]::new(); $projection.InitialWait = 258
                    if ($shared -and $facts.proofs.Count -eq 0) {
                        # Deterministic bounded budget consumption. Both real
                        # children are already zero-exited; this is a clock
                        # projection, not delayed-kernel-exit reproduction.
                        [Threading.Thread]::Sleep(275)
                    }
                    $proof = [MorrowObservationIdentity.ExitProof]::ReadLookupHandleForFixture($Handle, $CandidateId, $CimTicks, $ParentTicks, $PinnedTicks, $Deadline, $projection)
                }
                $facts.proofs.Add($proof); return $proof
            }.GetNewClosure()
            $barrier = {
                param($Phase, $Process)
                if ($Phase -eq 'snapshot' -and $case -notin @('initial-259-later-zero', 'earlier-counter-denied-later-zero')) {
                    $child.StandardInput.WriteLine('exit0'); $child.StandardInput.Flush()
                    if (-not $child.WaitForExit(5000)) { throw 'Snapshot child did not exit at its owned barrier.' }
                    if ($shared) {
                        $ancestor.StandardInput.WriteLine('exit0'); $ancestor.StandardInput.Flush()
                        if (-not $ancestor.WaitForExit(5000)) { throw 'Snapshot second child did not exit at its owned barrier.' }
                    }
                }
                if ($Phase -eq 'exitProof' -and $parentCase) {
                    if ($case -eq 'projected-parent-exit') {
                        $ancestor.StandardInput.WriteLine('exit0'); $ancestor.StandardInput.Flush()
                        if (-not $ancestor.WaitForExit(5000)) { throw 'Snapshot parent did not exit at its owned barrier.' }
                    } elseif ($case -eq 'projected-parent-identity-change') {
                        ($rows | Where-Object { $_.ProcessId -eq $parentId }).CreationDate = $ancestor.StartTime.AddSeconds(1)
                    } elseif ($case -eq 'projected-parent-cache-change') {
                        $state.handles[$parentId] = $state.handles[$parentId].Clone()
                    } elseif ($case -eq 'projected-parent-recheck-budget') {
                        $remaining = ($facts.deadlines[0] - [Diagnostics.Stopwatch]::GetTimestamp()) * 1000.0 / [Diagnostics.Stopwatch]::Frequency
                        [Threading.Thread]::Sleep([Math]::Max(1, [Math]::Min(275, [int] [Math]::Ceiling($remaining) + 1)))
                    }
                }
            }.GetNewClosure()
            $readActualCounters = ${function:Read-NativeProcessCounters}
            $counter = {
                param($Process)
                if ($case -eq 'earlier-counter-denied-later-zero' -and $Process.Id -eq $childId) {
                    $facts.countersDenied++; throw [ComponentModel.Win32Exception]::new(5)
                }
                return (& $readActualCounters $Process)
            }.GetNewClosure()
            $deadline = if ($case -eq 'projected-collector-deadline-clip') { [Diagnostics.Stopwatch]::GetTimestamp() - 1L } else { 0L }
            $first = Get-NativeProcessSnapshot $root $rootTicks $rows -ObservationBarrier $barrier -ReadCounters $counter -State $state -AcquireIdentity $acquire `
                -CollectorDeadlineAtQpc $deadline -LookupProcess $(if ($case -ne 'earlier-counter-denied-later-zero') { $lookup } else { $null }) -ReadLookupProof $readProof
            Check ($null -eq $first.terminalReason -and $first.hasSnapshot) ('snapshot-native-' + $case)
            if ($case -eq 'projected-same-query-zero') {
                Check ($first.skipped -eq 0 -and $first.lifecycleEvents.Count -eq 1 -and $facts.proofs.Count -eq 1 -and
                    $facts.proofs[0].WaitAttempted -and $first.lifecycleEvents[0].nativeProof.initial.waitStatus -eq 258 -and
                    $first.lifecycleEvents[0].nativeProof.initial.exitCode -eq 0 -and $first.lifecycleEvents[0].nativeProof.final.waitStatus -eq 0 -and
                    $first.lifecycleEvents[0].nativeProof.final.exitCode -eq 0 -and $first.lifecycleEvents[0].nativeProof.parentAfter -eq 'valid') 'same-query-native-final-zero'
            } elseif ($case -in @('initial-259-later-zero', 'earlier-counter-denied-later-zero')) {
                Check ($first.skipped -eq 1 -and $first.lifecycleEvents.Count -eq 0) 'earlier-gap-preserved'
                if ($case -eq 'initial-259-later-zero') {
                    Check ($facts.proofs.Count -eq 1 -and $facts.proofs[0].Initial.ExitCode -eq 259 -and -not $facts.proofs[0].WaitAttempted -and
                        -not $state.handles.ContainsKey($childId) -and $first.failedRecords[0].stage -eq 'nativeWait') 'initial-live-not-admitted'
                } else {
                    Check ($facts.countersDenied -eq 1 -and $facts.proofs.Count -eq 0 -and $state.handles.ContainsKey($childId) -and
                        $first.failedRecords[0].stage -eq 'counters' -and $first.failedRecords[0].errorCode -eq 5) 'counter-denied-retained-as-gap'
                }
                $child.StandardInput.WriteLine('exit0'); $child.StandardInput.Flush(); Check ($child.WaitForExit(5000)) 'later-child-zero'
                $later = Get-NativeProcessSnapshot $root $rootTicks $rows -State $state -AcquireIdentity $acquire -LookupProcess $lookup -ReadLookupProof $readProof
                Check ($later.skipped -eq 0 -and $later.lifecycleEvents.Count -eq 1) 'later-native-zero'
                $samples = @(); $elapsed = 0.0
                foreach ($snapshot in @($first, $later)) {
                    $samples += @{ kind = 0; nativeProofVersion = 1L; elapsedMs = $elapsed; queryMs = 1.0; skipped = $snapshot.skipped
                        rootSkipped = $snapshot.rootSkipped; rootExitedDuringSample = $snapshot.rootExitedDuringSample; skipReasonCounts = $snapshot.skipReasonCounts
                        processes = $snapshot.processes; lifecycleEvents = $snapshot.lifecycleEvents; failedRecords = $snapshot.failedRecords }
                    $elapsed += 10.0
                }
                $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
                try {
                    foreach ($sample in $samples) { Check (Write-NativeSample $stream $sample) 'snapshot-history-bounded-write' }
                    Check (Write-NativeSample $stream @{ kind = 1; reason = 0; samples = 2; failureStage = 'none' }) 'snapshot-history-footer'
                } finally { $stream.Dispose() }
                $report = Read-NativeResourceReport $path @{ forced = $false; reaped = $true; exitCode = 0 } @{}
                Check ($report.incomplete -and $report.sampleGaps -and -not $report.invalidRecords -and $report.normalExitObservations -eq 1) 'later-native-zero-keeps-earlier-gap'
                [IO.File]::Delete($path)
                if ($case -eq 'earlier-counter-denied-later-zero') { Check ($facts.proofs.Count -eq 0 -and $facts.lookups -eq 0) 'counter-error-never-lookup-fallback' }
            } else {
                $count = if ($shared) { 2 } else { 1 }
                Check ($first.skipped -eq $count -and $first.failedRecords.Count -eq $count -and
                    @($first.lifecycleEvents | Where-Object { $_.pid -eq $childId }).Count -eq 0 -and
                    $first.lifecycleEvents.Count -eq $(if ($case -eq 'projected-parent-exit') { 1 } else { 0 })) ('snapshot-gap-' + $case)
                if ($parentCase) {
                    $failure = $first.failedRecords[0]
                    Check ($failure.nativeProof.initial.exitCode -eq 0 -and $failure.nativeProof.final.exitCode -eq 0 -and
                        $failure.nativeProof.final.startUtcTicks -eq $failure.nativeProof.pinnedStartUtcTicks) 'parent-failure-retains-native-child-proof'
                    $expectedParent = switch ($case) { 'projected-parent-exit' { 'parentExited' }; 'projected-parent-identity-change' { 'identityMismatch' }
                        'projected-parent-cache-change' { 'parentUnavailable' }; default { 'valid' } }
                    Check ($failure.nativeProof.parentAfter -eq $expectedParent) 'retained-parent-after-proof'
                    if ($case -eq 'projected-parent-recheck-budget') {
                        Check ($failure.stage -eq 'nativeWait' -and $failure.nativeProof.outcome -eq 'deadlineExpired' -and
                            $failure.nativeProof.deadlineExceeded) 'parent-recheck-cannot-extend-budget'
                    } else { Check ($failure.stage -eq 'parent') 'parent-change-is-gap' }
                }
                if ($shared) {
                    Check ($facts.deadlines.Count -eq 2 -and $facts.deadlines[0] -eq $facts.deadlines[1] -and
                        @($facts.proofs | Where-Object { $_.WaitAttempted -or -not $_.DeadlineExceeded }).Count -eq 0) 'shared-deadline-not-reset-per-child'
                }
                if ($case -eq 'projected-collector-deadline-clip') {
                    Check ($facts.deadlines[0] -eq $deadline -and -not $facts.proofs[0].WaitAttempted -and
                        $facts.proofs[0].DeadlineExceeded) 'deadline-clipped-to-original-collector'
                }
            }
            if ($case -ne 'earlier-counter-denied-later-zero') {
                Check (-not $state.handles.ContainsKey($childId) -and @($first.processes | Where-Object { $_.pid -eq $childId }).Count -eq 0) 'fallback-no-cache-counter-or-descendant-authority'
            }
            Check (@($facts.pins | Where-Object { -not $_.IsClosed }).Count -eq 0) 'snapshot-original-pins-disposed'
            Write-Host ('Pinned exit snapshot: ' + (@{ case = $case; lookupRejectionProjected = ($case -ne 'earlier-counter-denied-later-zero')
                ancestryProjected = $parentCase; timingProjected = ($case -like 'projected-*'); nativeUiAcceptance = $false
                skipped = $first.skipped; proofs = $facts.proofs.Count; pinCount = $facts.pins.Count; pinsClosed = $true
                lifecycleEvents = $first.lifecycleEvents; failedRecords = $first.failedRecords; laterZeroKeepsGap = ($null -ne $later) } | ConvertTo-Json -Compress -Depth 6))
            Close-NativeObservationState $state; $state = $null
            Close-LifecycleChild $child; $child = $null; Close-LifecycleChild $ancestor; $ancestor = $null
        }
        Write-Host ('Pinned exit snapshot controls passed: ' + $cases.Count + '; original 26 lifecycle cases retained.')
    } finally {
        try { if ($state) { Close-NativeObservationState $state } }
        finally { try { Close-LifecycleChild $child } finally { Close-LifecycleChild $ancestor; if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) } } }
    }
}

function Test-NativePinnedExitWait($Control, $Self) {
    # Reuse the existing fixture's bounded owned pipes/CIM helpers. Called from
    # Test-NativeProcessLifecycle, after all original 26 cases have passed.
    if (-not $IsWindows) { throw 'Pinned exit native fixtures require Windows.' }
    if (-not ('MorrowPinnedExitFixture.Handles' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace MorrowPinnedExitFixture {
    public static class Handles {
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern SafeProcessHandle OpenProcess(uint rights, bool inherit, uint pid);
        public static SafeProcessHandle QueryOnly(uint pid) {
            var handle = OpenProcess(0x1000, false, pid);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error);
            }
            return handle;
        }
    }
}
'@
    }
    $child = $null; $pin = $null
    $parentTicks = $Self.StartTime.ToUniversalTime().Ticks
    $helperCases = @('direct-zero-exhausted-budget', 'projected-pending-zero', 'actual-live-still-active', 'projected-initial-259',
        'projected-initial-7', 'projected-initial-crash-code', 'actual-signaled-7', 'projected-final-7', 'projected-final-crash-code',
        'actual-wait-denied', 'projected-initial-wait-failed', 'projected-initial-unexpected-wait',
        'projected-initial-query-denied', 'projected-initial-query-error', 'projected-settling-wait-failed',
        'projected-settling-unexpected-wait', 'projected-settling-timeout', 'projected-deadline-expired',
        'projected-late-zero', 'projected-submicro-pin-change', 'projected-pid-change', 'closed-pin',
        'projected-settling-zero-live-final', 'projected-initial-signaled-zero')
    try {
        foreach ($case in $helperCases) {
            $child = Start-LifecycleChild; $childId = [uint32] $child.Id; $ticks = $child.StartTime.ToUniversalTime().Ticks
            $pin = if ($case -eq 'actual-wait-denied') { [MorrowPinnedExitFixture.Handles]::QueryOnly($childId) }
                else { [MorrowObservationIdentity.ExitProof]::Acquire($childId) }
            $live = $case -in @('actual-live-still-active', 'actual-wait-denied', 'closed-pin', 'projected-settling-zero-live-final')
            if (-not $live) {
                $child.StandardInput.WriteLine($(if ($case -eq 'projected-final-crash-code') { 'exitCrashCode' }
                    elseif ($case -in @('actual-signaled-7', 'projected-final-7')) { 'exit7' } else { 'exit0' }))
                $child.StandardInput.Flush(); Check ($child.WaitForExit(5000)) ('pinned-child-exit-' + $case)
            }
            $projection = $null
            if ($case -like 'projected-*') {
                $projection = [MorrowObservationIdentity.LookupProjection]::new(); $projection.InitialWait = 258
            }
            $expectedTicks = $ticks; $expectedPid = $childId
            $deadline = [Diagnostics.Stopwatch]::GetTimestamp() + [long] [Math]::Floor([Diagnostics.Stopwatch]::Frequency / 4.0)
            switch ($case) {
                'direct-zero-exhausted-budget' { $deadline = [Diagnostics.Stopwatch]::GetTimestamp() - 1L }
                'projected-initial-259' { $projection.InitialExitCode = 259 }
                'projected-initial-7' { $projection.InitialExitCode = 7 }
                'projected-initial-crash-code' { $projection.InitialExitCode = 3221225477 }
                'projected-final-7' { $projection.InitialExitCode = 0 }
                'projected-final-crash-code' { $projection.InitialExitCode = 0 }
                'projected-initial-wait-failed' { $projection.InitialWait = [uint32]::MaxValue; $projection.InitialWaitError = 6 }
                'projected-initial-unexpected-wait' { $projection.InitialWait = 128 }
                'projected-initial-query-denied' { $projection.InitialExitQuerySuccess = $false; $projection.InitialExitError = 5 }
                'projected-initial-query-error' { $projection.InitialExitQuerySuccess = $false; $projection.InitialExitError = 87 }
                'projected-settling-wait-failed' { $projection.SettlingWait = [uint32]::MaxValue; $projection.SettlingError = 5 }
                'projected-settling-unexpected-wait' { $projection.SettlingWait = 128 }
                'projected-settling-timeout' { $projection.SettlingWait = 258 }
                'projected-deadline-expired' { $deadline = [Diagnostics.Stopwatch]::GetTimestamp() - 1L }
                'projected-late-zero' { $projection.CompleteAfterDeadline = $true }
                'projected-submicro-pin-change' { $expectedTicks += $(if ($ticks % 10L -eq 9L) { -1L } else { 1L }) }
                'projected-pid-change' { $expectedPid++ }
                'closed-pin' { $pin.Dispose() }
                'projected-settling-zero-live-final' { $projection.InitialExitCode = 0; $projection.SettlingWait = 0 }
                'projected-initial-signaled-zero' { $projection.InitialWait = 0 }
            }
            $result = if ($null -eq $projection) {
                [MorrowObservationIdentity.ExitProof]::ReadLookupHandle($pin, $expectedPid, $ticks, $parentTicks, $expectedTicks, $deadline)
            } else {
                [MorrowObservationIdentity.ExitProof]::ReadLookupHandleForFixture($pin, $expectedPid, $ticks, $parentTicks, $expectedTicks, $deadline, $projection)
            }
            $positive = $case -in @('direct-zero-exhausted-budget', 'projected-pending-zero', 'projected-initial-signaled-zero')
            Check ($result.ProvenZero -eq $positive) ('pinned-helper-' + $case)
            $noWait = $case -in @('direct-zero-exhausted-budget', 'actual-live-still-active', 'projected-initial-259', 'projected-initial-7',
                'projected-initial-crash-code', 'actual-signaled-7', 'actual-wait-denied', 'projected-initial-wait-failed',
                'projected-initial-unexpected-wait', 'projected-initial-query-denied', 'projected-initial-query-error',
                'projected-deadline-expired', 'projected-submicro-pin-change', 'projected-pid-change', 'closed-pin', 'projected-initial-signaled-zero')
            Check ($result.WaitAttempted -ne $noWait) ('wait-admission-' + $case)
            if ($positive) {
                Check ($result.Final.WaitStatus -eq 0 -and $result.Final.ExitCode -eq 0 -and $result.Final.ActualPid -eq $childId -and
                    $result.Final.StartUtcTicks -eq $ticks -and $result.Final.IdentityMatched) 'real-final-zero-and-exact-pin'
            }
            if ($case -eq 'actual-live-still-active') {
                Check ($result.Initial.WaitStatus -eq 258 -and $result.Initial.ExitCode -eq 259 -and -not $result.WaitAttempted) 'live-initial-259-no-wait'
                $child.StandardInput.WriteLine('exit0'); $child.StandardInput.Flush(); Check ($child.WaitForExit(5000)) 'live-later-zero'
                Check ([MorrowObservationIdentity.ExitProof]::ReadHandle($pin, $childId, $ticks, $parentTicks)).ProvenZero 'later-actual-zero'
                Check (-not $result.ProvenZero -and -not $result.WaitAttempted) 'later-zero-cannot-revise-initial-259'
            }
            if ($case -eq 'actual-wait-denied') {
                Check ($result.Initial.WaitStatus -eq [uint32]::MaxValue -and $result.Initial.NativeError -eq 5 -and
                    -not $result.WaitAttempted -and $null -eq $result.Initial.ExitCode) 'real-query-only-wait-denied'
            }
            if ($case -eq 'projected-settling-zero-live-final') {
                Check ($result.Final.WaitStatus -eq 258 -and -not $result.Final.Signaled -and $null -eq $result.Final.ExitCode) 'projected-signal-cannot-replace-native-final'
            }
            if ($case -eq 'projected-final-7') { Check ($result.Final.ExitCode -eq 7 -and $result.Outcome -eq 'nonzeroExit') 'real-final-nonzero' }
            if ($case -eq 'projected-final-crash-code') { Check ($result.Final.ExitCode -eq -1073741819 -and $result.Outcome -eq 'nonzeroExit') 'final-native-crash-code-projection' }
            if ($case -eq 'projected-initial-crash-code') { Check ($result.Initial.ExitCode -eq -1073741819) 'raw-dword-crash-code-preserved' }
            if ($case -in @('projected-deadline-expired', 'projected-late-zero')) { Check ($result.DeadlineExceeded -and $result.Outcome -eq 'deadlineExpired') 'absolute-deadline-rejection' }
            $pin.Dispose(); Check $pin.IsClosed 'helper-pin-disposed'; $pin = $null
            Write-Host ('Pinned exit helper: ' + (@{ case = $case; timingProjected = ($null -ne $projection); nativeFinalRequired = $true
                actualCrash = $false; provenZero = $result.ProvenZero; waitCalls = [int] $result.WaitAttempted; outcome = $result.Outcome
                initial = ConvertTo-NativeProofRead $result.Initial; final = ConvertTo-NativeProofRead $result.Final
                settlingWait = $result.SettlingWait; settlingError = $result.SettlingError; durationMs = $result.DurationMs
                deadlineExceeded = $result.DeadlineExceeded; pinClosed = $true } | ConvertTo-Json -Compress -Depth 4))
            Close-LifecycleChild $child; $child = $null
        }
        Test-NativePinnedSnapshot $Control $Self
        Write-Host ('Pinned exit native helper controls passed: ' + $helperCases.Count + '; projections are labeled and are not historical-race or release acceptance.')
    } finally {
        try { if ($pin) { $pin.Dispose() } } finally { Close-LifecycleChild $child }
    }
}
