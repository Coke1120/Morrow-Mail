# Capture provisional native pins before delayed CIM rows

The row-delivery correction in PR36 normally merged at
[`0b14ed77`](https://github.com/Coke1120/Morrow-Mail/commit/0b14ed77f4ac7f3b54239b123611ebac5157e997).
Its exact-head [paired run38308442440](https://github.com/Coke1120/Morrow-Mail/actions/runs/38308442440)
passed both platforms in attempt1: Windows fresh/owned/restart observations were
complete with4/47/34 samples; Mac40/40 reader samples were complete/network-zero.

That successful run does not repair the separate combined
[PR35 run38308902187](https://github.com/Coke1120/Morrow-Mail/actions/runs/38308902187).
It used the identical observer source (SHA256
`90533f2c7515be825b085fa5c9e37525d4ce4c8d6bdfa893bff03ba258be43d4`),
but owned case2/sample11 failed its first nativeAcquire87 for PID6268 and5316,
parent3172. All three UI cases passed; strict observation did not. The failed
sample's query took123.744ms. One child's creation was within that query's
sampling interval. Its exit remains unknown; neither later samples nor the
other successful run establishes zero exit for either failed PID.

## Focused correction

The fixture collector starts a bounded native pin window before its CIM query.
A native process-only Toolhelp snapshot immediately pins new children of already
retained, exact, live owned parents. A worker checks again every10ms while CIM
delivers rows. It closes each snapshot and stops before tree building/admission.
The helper uses the documented read-only
[process snapshot API](https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/nf-tlhelp32-createtoolhelp32snapshot)
and [parent PID field](https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32w).
It reads no process memory and changes no ACL, privilege, app, Job or debugger.

Each seed borrows the caller's original retained parent handle with a safe-handle
reference. Native PID, full100ns creation time and live signal state must match
before it authorizes even a provisional open. Newly pinned children never become
parent seeds. A lock records each child's FIRST limited, non-inheritable open or
Win32 error across native scans and CIM delivery. A row borrows that same result;
it cannot reopen a failed87/5 or replace a handle with a later PID lookup.

This window provides no admission, counters, identity cache or exit classification.
All ordinary current-CIM tree/parent identity, exact child creation, live-parent
rechecks, managed counters, same-pin signaled zero proof and negative outcomes
remain. New parents follow ordinary admission. Inventory is bounded to8192 rows
and64 cached+provisional identities. The worker join is clipped to the original
one-second sample and180-second collector deadlines, with an absolute250ms maximum.
No exit-settling deadline resets. Native inventory/stop failure makes observation
incomplete. Transferred, rejected and unused pins close; a failed worker retains
borrowed parent references until its own cleanup, never using a disposed object.

This covers acquisition during slow delivery, not complete process-lifetime
tracing. Pre-capture unavailability, denied access, changed identity, failed
counters and unknown/nonzero exits remain strict gaps. Historical v0.7.5/v0.7.6
and combined records stay failed. No rerun, retag, publisher/key change or waiver
is part of this correction.

## Checks and release scope

The original32 lifecycle cases remain. Five new controls capture before any
supplied CIM row, release the real creator, and require exact zero to pass while
nonzero/changed creation/first87/first5 stay gaps. They check one retained result,
no counter/cache for exited or failed children, stopped worker and full disposal.
A separate child genuinely born after the window starts checks background capture
and same-handle native zero. Projections stay labeled and never replace proof.

Linux compilation, pure integer/input bounds and9 positive/history plus52 strict
negative report-schema controls passed. Native proofs and paired acceptance
require Windows/macOS CI; no native success is claimed from Linux. This fixture
script is not packaged. Review-state fixes remain separate PR35; Thunderbird PR34
is excluded. A fresh unused version with same-attempt tagged gates and the existing
publisher is required. Ad-hoc Mac/unsigned Windows, manual and real-account
limitations remain.
