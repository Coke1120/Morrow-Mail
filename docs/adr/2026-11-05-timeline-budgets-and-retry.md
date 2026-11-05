# Timeline request budgets and safe explicit retry

Timeline preparation and extraction must use the same request builder. Count the
serialized messages including JSON escaping, actual prompt/language/focus and a
fixed validation-retry notice when sizing fragments. Keep the existing source,
request, call, input, output and time caps. The first-pass estimate is exact for
planned extraction requests, not a guarantee of enough remaining budget for model
retries or consolidation. Never silently truncate source evidence or switch an AI
destination to make a plan fit.

Reduce long-message semantic results in bounded stages, splitting large validated
action/uncertainty arrays at item boundaries. Every item must enter a reduction.
Reject a non-compacting reduction and enforce all budgets before each later call.
Only a final validated document is committed; failed work leaves older artifacts.

Separate one-use generation authorization from source proof lifetime. A consumed
manifest cannot generate again, but remains owner-bound for source checks and
explicit re-preparation for five minutes after the job ends. Re-preparation always
checks the previous account incarnation/source fingerprints before capturing a new
snapshot, and always acquires a new consent binding. Retain the previous proof if
preparation fails, and retain a blocked planning snapshot so edited focus can be
checked without dropping that proof. Do not fix retry by omitting the previous
token: that would allow silently recapturing a replaced account. Closing/navigating
the window, source changes, account invalidation and expiry retain their guards.

Clear busy/lease state before publishing terminal progress so an explicit retry
cannot race a completed job's cleanup. No whole-job retry runs automatically.
Attempt counts describe completion calls started, not confirmed provider delivery.
Fixed limit labels and nonnegative numeric counts are the only diagnostics that
cross IPC. Zero calls may be described as no AI request started for that attempt;
positive counts must warn that earlier data may have reached the saved provider
and that explicit retry can resend it. Never include bodies, addresses, keys,
prompts, dynamic validation paths or raw provider errors.
