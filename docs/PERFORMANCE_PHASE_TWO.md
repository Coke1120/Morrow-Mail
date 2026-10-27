# Mail list queries and body update retention

This phase stacks on [PR #324](https://github.com/Coke1120/Morrow-Mail/pull/324),
base `ed95f2b778efa1940526ded29bd360a01bd87354`. Its PR targets
`perf/mail-responsiveness-20261026` while phase one remains unmerged. It includes
no PR #323 consent changes and performs no merge or release.

## Behavior and limits

Action generations are read in one query per 400 IDs, with account ownership
checked by the join. Ordinary 200-row lists no longer issue 200 individual action
queries. Prefetch uses the list's existing owner metadata and keeps queue/account
epoch guards, eliminating another per-row owner lookup for incomplete pages.

Background body updates now broadcast only availability, connection epoch and a
monotonic process-local version. Unopened messages retain no body or per-message
notification state. The current reader/pending open and preview can request fresh
stored snapshots through internal `mail:readCachedBody`; account/epoch validation
is mandatory and that operation never fetches from a provider. This does not add
bot capabilities, OAuth permissions or remote telemetry.

There is at most one cached-body read in flight per window and at most two active
latest notices. A burst coalesces to the latest needed snapshot. Duplicate notices
do not refetch. A failed read retries only after a newer notice or explicit reopen.
Opening another message, closing a preview or changing the account connection
makes old responses ineligible. Local reads may finish after supersession; their
results are ignored. Existing provider-prefetch cancellation boundaries remain.

The per-window LRU reuse cache holds only body strings/flags under
account + connection epoch + message keys. Limits are 32 entries, 8 MiB of
estimated UTF-16 strings (including keys/warnings), and 2 MiB per entry. Object
overhead is additionally bounded by the entry count; these are not total-process
heap limits. Active reader/preview bodies, compose drafts and attachment transfers
retain their own data outside the reuse cache. An oversized body stays visible
without cache reuse or repeated refetch. Eviction never deletes persistent data.

Newer shorter content replaces older longer content. Explicit opens defeat earlier
refresh responses; removed/reconnected accounts invalidate prior keys and reads.
Current snapshots also supply attachment/inline-CID, sender and draft-revision
metadata while preserving optimistic action flags and compose edits. That metadata
does not enter the body cache; a pending-open race can require one additional
local snapshot to refresh metadata after a newer cached body is displayed.

## Regression budgets and measurements

```sh
node scripts/check-mail-phase-two.js
node scripts/benchmark-mail-phase-two.js
node --expose-gc scripts/benchmark-mail-responsiveness.js
```

Both benchmarks accept `--source-root` for an immutable baseline archive with
compatible dependencies. They create only temporary synthetic profiles. Run
baseline and candidate sequentially with unrelated tests stopped.

The focused fixture has 240 messages, 200-row lists, two timing warmups and 12
rounds. A fake transport completes one body after a page change cancels the rest.
Query counts include synchronous SQL before the list RPC returns, including body
progress admission. The renderer retention test sends 1,000 full compatibility
events with 8,192-character bodies; production candidate events are lightweight.

| Observation, Node 20.20.2 / Linux x64 | #324 baseline | Candidate |
| --- | ---: | ---: |
| Complete 200-row list SELECT/PRAGMA calls | 213 | 14 |
| Newly queued incomplete page calls | 415 | 16 |
| One body notification, serialized bytes | 54,057 | 145 |
| Unopened bodies retained after 1,000 events | 1,000 | 0 |
| Retained body-string bytes (UTF-16 estimate) | 16,384,000 | 0 |
| Focused cached-list median ms (p95) | 6.50 (10.81) | 4.37 (6.13) |

Correctness budgets allow at most 16 complete-list and 18 incomplete-page queries
for this fixture, three batch queries for 1,001 unique action IDs, the stated cache
bounds, two reads for a controlled active 1,000-notice burst, and zero list reloads
from body notifications. Timing values do not gate CI.

The unchanged large fixture has 10,000 messages and a 256-message thread. Two
sequential paired trials used opposite execution order. Candidate host medians
were modestly lower for lists (15.52–15.60 vs 16.75–17.30 ms), thread headers
(13.28–13.75 vs 15.32–16.61 ms) and cached opens (15.12–15.43 vs 16.73–17.02 ms).
Warm-cache reopen varied: candidate 93.37–129.92 vs baseline 93.55–96.18 ms;
unchanged-sync medians were essentially unchanged (9.68–9.87 vs 9.49–9.52 ms).
Some candidate p95s were worse. There is no general startup or all-path latency
improvement claim. The deterministic query/notification/retention reductions are
the main evidence for this phase.

Raw focused and both large-trial results are in
[the paired measurement file](performance/2026-10-26-phase-two.json). Host timings
exclude Chromium/native UI, actual Mac/Keychain/provider behavior and cold app
launch. Renderer burst time includes fixture construction and is not an end-to-end
UI latency measure. Sampled process RSS is not peak memory. Actual Mac beachball
cause/resolution remains unverified; broader storage/index or Rust work is deferred.
