# Responsiveness diagnostics and offline measurements

This first phase reduces unnecessary body materialization and repeated IMAP
search-index work. It does not establish the cause of any particular macOS
beachball, move the database to a worker, or replace the mail backend with Rust.

## Opt-in local timings

With a POSIX development checkout:

```sh
MORROW_PERF=1 npm start
```

For PowerShell, set `$env:MORROW_PERF = '1'` before `npm start`. Remove the variable
and restart to disable it (`Remove-Item Env:MORROW_PERF` in PowerShell). The flag
is off by default and does not change saved settings or credentials.

Debug log receives a bounded summary every 30 seconds for fixed startup, SQL,
indexing, journal, Keychain-wait and mail IPC categories. Summaries contain stage
names, call counts, mean/max milliseconds and counts over 50/100 ms. Main-loop
summaries contain mean/p99/max delay and a 20 ms sampling resolution. That
resolution contributes to the reported delay; suspension and other scheduling
delays can also affect it. Stage timings are inclusive and may include network
awaits; overlapping categories must not be added together as CPU time.

There are no per-request values, message bodies, addresses, subjects, account or
message ids, paths, credential command arguments, tokens or error strings in
these summaries. Unknown IPC channels share one fixed category. Aggregation has
a fixed set of stages and capped counters, resets on each report, and reports
through the existing in-memory 200-line Debug log. The monitor timer is unref'd;
there is no separate timing file or remote telemetry. Other existing Debug log
entries can retain account/folder context, so still review support copies.

The macOS `security` bridge is measured as `keychain.wait`. Routine mail credential
reads and startup/missing-credential checks now use an asynchronous child with a
30-second deadline including queue time, at most four live children, and a 1 MiB
stdout limit. Same-account concurrent reads share pending work; no completed
credential cache is added. A caller can abandon its read without cancelling a
remaining consumer. In-app writes/deletes invalidate pending reads and opaque
revisions protect post-await account/refresh checks. Errors from the subprocess
runner use fixed messages rather than child output or command arguments.

Compatibility reads in feature/status gates and existing synchronous reconnect,
write, delete and compensation blocks remain synchronous, now with a 30-second
limit per `security` command and `SIGKILL` on timeout. Several commands can take
longer in total. Windows DPAPI is unchanged. This is a partial API migration,
not a claim that every credential path or native Mac freeze has been fixed.
See [coverage, concurrency and validation limits](adr/2026-10-27-keychain-read-deadlines.md).
The [search-index responsiveness plan](SEARCH_INDEX_RESPONSIVENESS_PLAN.md) is
separate proposed work; no rebuild/storage rewrite is implemented here.

## Data-path changes

- The mail list, open-message thread strip and header-only thread requests use an
  explicit metadata projection. Bodies are omitted from the JavaScript rows.
  SQLite still inspects body values to preserve the existing `hasBody` meaning,
  including JavaScript-compatible whitespace. This does not promise zero body
  disk I/O. Full-message and full-thread requests retain their bodies; thread
  membership, ordering, counts, sender names, Reply-To and attachment metadata
  remain unchanged. Long threads still return all requested header rows.
- IMAP upserts compare the five indexed source fields in SQLite before writing.
  Unchanged content and flag/recipient/warning-only updates retain search terms.
  Changed subject, sender, text, HTML or fallback snippet still reindex. Missing
  document-index entries are repaired. Gmail already avoids unchanged-content
  reindexing and keeps that behavior.
- Transaction acknowledgement, journal hashing/append/fsync, recovery,
  checkpoints and provider/account identity guards are retained. All normal
  database transactions still run on the main thread.

## Repeatable synthetic benchmark

```sh
node --expose-gc scripts/benchmark-mail-responsiveness.js
node --expose-gc scripts/benchmark-mail-responsiveness.js --messages 1000 --thread 32 --iterations 3
```

The default is 10,000 messages (4 KiB text plus HTML), a 256-message thread
(64 KiB text plus HTML per message), and 40 sync records with 1,000 distinct body
terms each. Each scenario has two warmups, then 12 measured rounds (three for
reopen/first list). It uses real production SQLite/host handlers and durable
journaling in a new temporary synthetic profile. It never opens a user profile,
calls Keychain, sends mail or contacts a provider. Temporary data is removed on
completion. Allow several hundred MiB of temporary storage/memory.

To compare the same fixture/harness with the original implementation, materialize
an immutable archive of base `aee7006f01f1301452c3d073683d79927beebce2`, make its
compatible dependencies available, and pass `--source-root` pointing to it. Run
baseline and candidate sequentially on the same machine with other tests stopped.
Save their JSON results with the exact source SHAs and Node/platform information.
Timing thresholds are not correctness tests and should not gate CI.

Measured on 2026-10-26 with Node 20.20.2, Linux x64, using the default fixture and
sequential baseline/candidate runs. Values below are median milliseconds; p95 is
shown in parentheses. Baseline source is the immutable dev commit above; candidate
is this PR's implementation. These are observations on this machine, not an SLA.

| Host scenario | Baseline | Candidate |
| --- | ---: | ---: |
| Cached list, 200 rows | 31.34 (45.06) | 16.62 (20.33) |
| Header-only 256-message thread | 52.80 (63.72) | 14.74 (16.63) |
| Cached message open with thread strip | 53.80 (61.62) | 16.07 (18.02) |
| Reopen SQLite plus first list, warm OS cache | 110.58 (119.84) | 89.61 (108.70) |
| Unchanged 40-message IMAP upsert batch | 170.49 (297.98) | 8.78 (13.18) |

List/thread metadata JavaScript rows materialized 26,215,800 / 33,556,224 body
bytes before and zero after. This measures returned body strings, not physical
SQLite disk reads. Maximum sampled process RSS was 500.61 / 319.33 MiB across the
scenarios; samples are not a peak-memory profile and do not isolate one operation.
The [raw paired results](performance/2026-10-26-phase-one.json) retain the fixture,
round counts, platform and individual scenario summaries.

Results distinguish host-handler durations, body bytes materialized into JS and
sampled process RSS. Sampled RSS is not peak memory. Reopen has a warm OS file
cache; this is not full application cold-start timing. There is no Chromium
renderer, native window, actual Keychain or live-provider latency in the benchmark.

For an actual beachball, collect a macOS process sample plus renderer/main traces
for startup, active sync and message switching. Correlate blocked-loop intervals
with stage durations, CPU, GC and memory pressure before choosing broader worker
extraction or selective Rust work. A backend language change cannot resolve
renderer HTML/CSS/layout work or a synchronous OS/disk wait by itself.
