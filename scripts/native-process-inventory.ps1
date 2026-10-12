#requires -Version 7.2
# Provisional, read-only pins while CIM is delivering an inventory. This helper
# never admits a process or supplies counters/exit proof; ordinary CIM admission
# still owns every parent, creation, identity, counter and deadline check.
function Start-NativeInventoryWindow([uint32] $Root, [Collections.IDictionary] $Cache,
    [uint32] $ProjectedPid = 0, [int] $ProjectedError = 0) {
    $ids = [Collections.Generic.List[uint32]]::new(); $ticks = [Collections.Generic.List[long]]::new()
    $handles = [Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeProcessHandle]]::new()
    $known = [Collections.Generic.List[uint32]]::new()
    foreach ($id in $Cache.Keys) {
        $known.Add([uint32] $id); $entry = $Cache[$id]
        if (-not $entry.seen -and [uint32] $id -ne $Root) { continue }
        if ($entry.process.Id -ne [uint32] $id -or $entry.process.StartTime.ToUniversalTime().Ticks -ne $entry.ticks -or
            $entry.process.HasExited) { continue }
        $ids.Add([uint32] $id); $ticks.Add([long] $entry.ticks); $handles.Add($entry.process.SafeHandle)
    }
    if ($ids.Count -eq 0) { return $null }
    if ($ProjectedPid) {
        return [MorrowObservationIdentity.InventoryPinWindow]::StartForFixture($ids.ToArray(), $ticks.ToArray(),
            $handles.ToArray(), $known.ToArray(), 64 - $Cache.Count, $ProjectedPid, $ProjectedError)
    }
    return [MorrowObservationIdentity.InventoryPinWindow]::Start($ids.ToArray(), $ticks.ToArray(), $handles.ToArray(), $known.ToArray(), 64 - $Cache.Count)
}
