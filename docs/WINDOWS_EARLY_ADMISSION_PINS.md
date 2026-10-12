# Early pins for current Windows children

The v0.7.5 tagged [run 38287540112](https://github.com/Coke1120/Morrow-Mail/actions/runs/38287540112)
failed strict Windows resource observation in both attempts. Attempt 1 recorded
first `nativeAcquire` error 87 / unknown exit in owned case 2, sample 12, PID
2400 / parent 6200. Attempt 2 recorded the same failure in restart case 3,
sample 5, PID 1544 / parent 1244. All three UI cases passed in both attempts;
that does not establish complete resource observation. Both macOS attempts
passed, but the publisher remained skipped. The existing annotated v0.7.5 tag
and its commit are retained; no binaries from these failed attempts are public
release evidence.

## Focused correction

The existing collector receives a CIM inventory, builds the owned tree, and
then admits each child sequentially. Before pinning later children, it checks
parents and performs earlier siblings' native and managed identity/role reads.
Those reads add delay during which a short-lived WebView child may disappear.
The old logs do not contain its exit code and cannot prove its exit was normal
or identify the precise operation that consumed that window.

Before managed admission, the collector now pins current new children whose
parent already has a retained, exact, current-inventory, live identity. Each
parent is checked once for this provisional batch. The root's original exact
handle can provisionally permit these pins before its first counter sample.
New parents still pass ordinary sequential admission before authorizing their
children. No process outside the bounded current candidate tree is opened.

The native batch validates at most 64 distinct non-system PIDs before opening
anything. It requests the same limited query/synchronize, non-inheritable rights
once per PID. A native error is retained and surfaced at `nativeAcquire`; it is
never retried. Each saved handle is transferred into ordinary admission, which
still checks the live current parent before and after the exact child identity
read. The original same-handle zero-exit fallback and shared/clipped settling
deadline are unchanged. Pins do not create counters, cache entries or authority
to admit descendants. Rejected and unused pins are disposed in `finally`.

This removes sibling-admission delay. It cannot recover a process that
disappeared before the batch's first open, and does not establish complete
process-lifetime coverage. Missing handles, error 87/5, changed identities,
parent failures, nonzero exits, unknown exits, counter failures and expired
proofs remain strict gaps. The existing approximately 1 Hz / 180-sample,
64-identity, 32 KiB-record, 2 MiB-file and UI/reader gates are unchanged.

## Controls and release scope

The original lifecycle and strict parser controls remain. Added real owned
sibling barriers release the later child's creator handles while an earlier
sibling is admitted: the saved pin must prove the exact zero exit, while a
nonzero exit or changed creation time must remain a gap. Separate native batch
controls release creator handles before reading zero/nonzero exits. Pure input
controls reject duplicate/system PIDs and oversized batches before any Win32
call. Every temporary pin is checked for disposal.

Linux PowerShell can compile the C# helper and run the integer/input/parser
controls; real process proofs require Windows CI. A successful focused control
does not establish tagged UI/resource acceptance. Both tagged platforms and the
existing same-run/same-attempt publisher are still required before publication.
No app behavior, mail database, signing key, credential, workflow gate, privilege
or Thunderbird synchronization work is changed by this correction.

The [original-pin settling contract](WINDOWS_PINNED_EXIT_SETTLING.md) remains in
force. macOS ad-hoc signing, unsigned Windows packages, manual accessibility,
clean-machine and real-account/model/provider acceptance limits remain.
