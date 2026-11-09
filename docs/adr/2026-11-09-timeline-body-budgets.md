# Timeline body budgets and request-local quoted evidence

The old 128,000-byte source guard rejected text-only mail while calling the count
"Downloaded mail size". It was not an attachment or model-context limit. Give
source bodies and serialized requests explicit byte units: 512,000 bytes for
included complete bodies and total run input, 16,000 per request, 12,000 per
fragment batch. Retain 32 calls, 32,000 output tokens, 128,000 provider-reported
input tokens, 120 seconds per call and 10 minutes per run. This is a bounded
increase, not a promise every selection under the source cap can complete.

Do not strip reply history globally or replace it with a lossy earlier summary.
Share exact >-quoted complete bodies only within one request, after the earlier
same-thread source is fully present. A reference always resolves to directly
visible literal content, not another reference. Require at least 128 UTF-8 bytes;
remove only quote prefixes and an optional final newline for matching. Keep
uncertain/edited/unmarked/short/split/cross-request quotes. Original sources and
fingerprints never change. Preserve distinct message events, authors, dates and
case-date validation against original bodies. Text reuse does not establish who
wrote the quote or that the current sender agreed with it.

Use the same request builder for planning and generation, including quote sharing,
JSON escaping, prompt, focus and validation retry reservation. Preview body/literal
bytes, shared quotes, per-source counts, planned initial requests and explicit run
protections. Hide stale counts on edits. No attachment contents, silent truncation,
automatic continuation, new AI destination or exact monetary estimate is added.
