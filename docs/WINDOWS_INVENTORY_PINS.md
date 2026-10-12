# Pin owned children as inventory rows arrive

The sibling-admission correction in PR33 passed focused and paired PR checks,
but its source still completed the entire global CIM inventory and owned tree
before the first pin. Subsequent real failures remained:

- Merged-main [run38301357952](https://github.com/Coke1120/Morrow-Mail/actions/runs/38301357952),
  attempt1: owned case2/sample14 PID3172 / parent3568 and restart case3/sample4
  PID4788 / parent8152, first nativeAcquire87 with unknown exit.
- v0.7.6 [run38301621120](https://github.com/Coke1120/Morrow-Mail/actions/runs/38301621120),
  attempt1: owned case2/sample13 PID1464 / parent900, likewise87/unknown.

All three UI cases passed in both runs; strict resource observation did not.
Both Mac jobs passed and both publishers were skipped. v0.7.5 and v0.7.6 tags
remain immutable failed candidates, with no public app release. No failed
artifact or later sample establishes normal exit or repairs these records.

## Correction and unchanged gates

For a current CIM row whose parent already has an owned retained live handle,
the collector now attempts its single limited, non-inheritable native pin when
that row is delivered. It no longer waits for the remaining inventory, tree
construction or managed sibling admission. The retained parent's native-backed
managed PID/full creation time and live state are checked for this provisional
read; only the original exact root may lack an earlier counter sample.

This provisional handle grants no counter sample, cache identity or admission
authority. Ordinary admission still requires the complete current-CIM parent
identity and retained live handle, before and after exact child identity reads.
New parents follow the ordinary verified admission path. Parent changes/exits,
stale rows, mismatched PID/creation, denied/unknown/nonzero exits and counter
failures remain gaps. Only the original same-handle signaled zero proof can
establish a normal exit; the original shared/clipped settling deadline remains.

Every first-open result is retained, including native87/5 errors, and the later
batch/tree/admission paths cannot reopen it. An inventory failure, rejected
parent/child or unused provisional pin closes all held pins in `finally`.
The existing64-identity bound also limits cached+provisional handles; inventory
is still bounded to8192 rows. Approximately1Hz,180 samples,32KiB record,2MiB
file and original UI/reader/collector gates are unchanged.

This removes latency after a row is delivered. A process already unavailable
before row delivery still fails its first pin; complete process-lifetime
coverage and a historical kernel-race cause are not established. No event trace,
DEBUG_PROCESS/Job replacement, privilege, process ACL or runtime app change is
introduced. The observer remains fixture-only and is not packaged.

## Evidence contract

This correction starts from29 lifecycle cases (the original26 plus
three sibling controls), all of which remain. Three added inventory-delivery
barriers release a real owned child's creator before later rows/tree processing.
The same pin must prove its exact zero exit; nonzero exit and changed creation
must remain gaps. Existing first-open87/5 controls also run through the new row
path and must retain exactly one attempt, unknown exit and no counter/cache.
Temporary pins are checked for disposal. Timing/projection controls stay labeled.

Linux compiles/checks the pure input/parser contracts only; Win32 and complete
UI/resource acceptance require fresh Windows CI. After normal merges of tested
observer/review fixes, the next unused release version must run fresh coherent
tagged Mac/Windows gates and the existing publisher. Thunderbird sync is excluded.
Ad-hoc Mac/unsigned Windows and manual/real-account limits remain unchanged.
