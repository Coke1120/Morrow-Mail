# Thunderbird-informed IMAP synchronization

This follow-up starts from verified remote main
`966823b948e923df1b7a587c0d08876dee8e9773` in the saved Codex Cloud environment.
It independently implements the design in Rust. No edits or test results from the
stopped Mac mini task were transferred or used as validation for this change.
Version metadata, tags, release workflows and the release candidate are unchanged.

## Source and protocol evidence

The inspected official Thunderbird source is pinned to
[`30cdf5a03b41253e744bc058a699c1947a2b8123`](https://github.com/thunderbird/thunderbird-desktop/tree/30cdf5a03b41253e744bc058a699c1947a2b8123):

- [`nsImapProtocol.cpp`](https://github.com/thunderbird/thunderbird-desktop/blob/30cdf5a03b41253e744bc058a699c1947a2b8123/mailnews/imap/src/nsImapProtocol.cpp#L4250)
  compares folder MODSEQ progress and uses conditional flag retrieval. Its
  `UseCondStore` checks server support and usable modification sequences.
- [`nsImapMailFolder.cpp`](https://github.com/thunderbird/thunderbird-desktop/blob/30cdf5a03b41253e744bc058a699c1947a2b8123/mailnews/imap/src/nsImapMailFolder.cpp#L2647)
  invalidates UID/MODSEQ state when UIDVALIDITY changes.

Both files have MPL 2.0 headers. They were inspected for design; no Thunderbird
code was copied or directly adapted. Morrow retains its existing MIT code and
its own bounded, account-owned SQLite implementation. In particular, Morrow
retains cached content when provider identity becomes unavailable.

[RFC 7162 sections 3.1.2, 3.1.4 and 6](https://www.rfc-editor.org/rfc/rfc7162)
define persistent MODSEQ, strict CHANGEDSINCE filtering and UIDVALIDITY resets.
[RFC 9051 sections 2.3.1.1 and 6.4.8](https://www.rfc-editor.org/rfc/rfc9051)
define UID identity and UID commands. Incremental progress requires a successful
tagged completion, not an individual FETCH response. A smaller EXAMINE boundary
is retained when concurrent changes produce larger per-message MODSEQs.

## Morrow implementation

The normal background round first discovers changed UIDs in a cached provider
folder. Each numeric UID window spans at most 1,000 UIDs; a response is capped at
128 KiB. Up to 32 empty windows are scanned in one round, stopping after a
nonempty window. At most 1,000 UIDs are queued. Remaining scan bounds and pending
UIDs survive restart. Completed folders rotate; an unfinished folder resumes.
There is no unbounded UID SEARCH or whole-mailbox FLAGS/body fetch.

Changed cached UIDs take priority within the existing 50-message background
budget. Uncached UIDs are discarded from this metadata queue; the independent
new-mail/history importer still discovers and downloads arrivals. Any remaining
budget advances ordinary row rotation, preserving expunge checks and repair of
legacy rows. Visible-page/retained-reader priority work remains separate.

For a legacy cache without folder progress, a one-time SQLite metadata aggregate
can seed the minimum existing MODSEQ only if every applicable cached row has
matching connection/UIDVALIDITY proof and boolean provider snapshots. It does
not hydrate message bodies. Missing or invalid proof, including MODSEQs outside
SQLite's exact integer range, starts conservative bounded backfill. This initial
aggregate is proportional to the cached folder; it is not repeated on every
successful fetch. Folder metadata and account/rowid indexes keep that initial
aggregate scoped and make subsequent 50-row rotation a seek rather than a
mailbox sort. Creating these indexes is a one-time SQLite migration.

Metadata imports, queue consumption, scan advancement and the background row
cursor commit in one transaction. Connection and expected-checkpoint comparisons
reject stale concurrent work. A failed read or SQLite write commits no partial
message/checkpoint progress. UIDVALIDITY/connection changes or regressed MODSEQ
discard prior incremental proof. Unsupported, rejected or ignored extensions
fall back to ordinary flags; capabilities lost between discovery and retrieval
also invalidate folder progress. TLS validation and provider write behavior are
unchanged.
Private capability/folder generation markers invalidate untouched per-message
proofs lazily after loss of support or MODSEQ regression. Re-enabling support
cannot reuse an old flag watermark even when the new mailbox maximum is higher.
Queued changed UIDs read authoritative flags; generation changes do not cause
whole-mailbox writes or invalidate immutable downloaded bodies.
Imports also reject a provider location or confirmed snapshot that changed
during the read, so an older response cannot undo a reviewed move or flag write.

The unchanged-message optimization now returns `providerSnapshot.read/starred`
under a valid MODSEQ proof. Reusing local fields could incorrectly turn a local
star into remote truth and clear its override. Missing snapshots force a flags
reread. Fresh remote read/unread and star changes still flow through the existing
provider/local merge; cached bodies, attachments, Pending and stable local IDs
remain owned by their account and provider folder.

## Reproduce the synthetic comparison

The independent cloud observations are retained in
[`thunderbird-imap-cloud.json`](performance/thunderbird-imap-cloud.json):

| Until changed UID 25,000 is synchronized | Baseline `966823b` | Incremental source |
| --- | ---: | ---: |
| Background rounds | 500 | 1 |
| IMAP commands | 3,000 | 34 |
| SQLite message updates | 25,000 | 50 |
| Body requests | 0 | 0 |
| Indexed-text changes | 0 | 0 |
| Observed elapsed seconds | 342.66 | 1.86 |

These are one observation per strategy on a shared Linux cloud host, with
concurrent validation affecting timing. The baseline's setup preceded the
fixture-text memoization shortcut; the final runner uses the same setup for
both strategies. Seeding was excluded from both timings. The deterministic
round/command/write reduction is the relevant result; elapsed time does not
establish a corresponding real-provider/UI speedup. The first incremental
round applies the changed message and retains unfinished scan progress; it does
not claim that the entire mailbox has been reconciled in one round.

With Rust 1.98, rustfmt and Clippy available, run:

```sh
python3 -B scripts/benchmark-imap-sync.py --output /tmp/morrow-imap-comparison
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --locked
```

The runner archives immutable baseline `966823b`, injects only generated-fixture
TLS transport into a copy of its original reconciliation function, and runs the
same 50,000-message fixture against both algorithms. Each cache is fresh, has
2,100-byte synthetic bodies, and starts with verified MODSEQ 10 metadata. UID
25,000 changes read/star state at MODSEQ 11. Timed work ends when both flags and
the provider snapshot are synchronized. Seed time is recorded separately.
Actual message updates and indexed-text changes are counted with SQLite
triggers; protocol commands and body requests are counted by the mock server.
The final fixture harness memoizes identical synthetic text during seeding and
restores production normalization/tokenization functions before timing. Setup
time is not an application performance comparison.

Measurements are local TLS/debug-build observations. They exclude normal polling
delays, WAN/provider throttling, cold filesystem caches, native UI refresh and
real-account acceptance. Sparse UID space needs multiple bounded windows/rounds;
large change bursts need multiple 50-message rounds. Servers without usable
MODSEQ and incomplete legacy proofs still require rolling checks. These are
physical/protocol limits, not a complete mailbox mirror or push/IDLE sync.

Linux can validate Rust, storage, protocol mocks and the service. Native SwiftUI,
WinUI, signing and paired UI acceptance require the existing macOS/Windows cloud
checks. No live account, credential or user database is used by this work.
