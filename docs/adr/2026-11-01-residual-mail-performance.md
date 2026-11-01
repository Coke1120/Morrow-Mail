# Residual mailbox performance after the Astra review

Base: `b47c9c90aa85e48728bcbf724e83eff6ff973875` (0.3.15).
This supersedes the tiny-journal age/cooldown and refresh-reset portions of the
earlier November 1 startup/runtime decisions. Checkpoint plus durable journals
remain authoritative; there is no database-owner, working-copy or body-layout change.

## Decisions

- **G02:** Keep first-dirty times separately for active and sealed journals.
  Rotation transfers the old time; commits during a worker establish the active
  journal's own time, which publication never backdates. The existing size and
  transaction thresholds remain. Below them, soft age is the greater of the
  60-second runtime / 120-second startup base, one base interval per 64 MiB of
  database (capped at 15 / 30 minutes), and eight times the last checkpoint cost,
  capped at one hour. Threshold-driven work and soft age respect a four-times-cost
  cooldown, clamped to 1–300 seconds. A separate one-hour backlog age or journal
  size of `max(256 MiB, 4 * phase byte threshold)` makes work eligible without
  that cooldown. These are dispatch gates, not hard journal-size, replay-time or
  publication deadlines: one-worker ownership, retry backoff and headroom still
  take precedence. At 5 GiB with a previous 120-second copy, a 1 KiB journal has
  a 16-minute soft age instead of one minute. Constants are conservative policy
  choices tested synthetically, not thresholds tuned to native APFS/NTFS traces.
  Restarts start a new monotonic age observation after validated recovery.
- **G03:** Lazily seed `mail_folder_counts` for concrete Gmail folder consumers
  using the existing exact, revision-validated count-only queries. No migration
  scans or rewrites existing message bodies. Insert/delete/unread/account/folder
  triggers maintain seeded totals inside the same SQL transaction as content
  and resume state. Unseeded folders incur no aggregate work until first use;
  their first seed may still scan index history. Cursor-only saves read those
  durable counts. Provider totals remain distinct. Rollback discards both count
  and resume changes; journal replay runs the same triggers. Account removal
  deletes its count rows. General filtered count/oldest caching is unchanged.
- **G07:** Cache ordinary unread summaries independently of selection. A held
  row contributes only if a primary-key lookup proves it is read and satisfies
  the same scope, exclusions, filters and snooze predicate. Total and oldest
  combine disjoint contributions, and snooze expiry still invalidates the base.
  Test the aggregate's partial-index plan, including merged scopes, rather than
  inferring aggregate behavior from the list plan.
- **G08:** Keep the bounded 32-boundary history across ordinary refreshes.
  The host still binds a cursor to scope/order/membership/snooze revisions and
  rejects stale boundaries with offset fallback and exact geometry. Scope
  changes clear history. No unconditional reuse, accumulating pages, filtered
  keysets or reverse seeks are introduced.
- **G09:** Asynchronous IMAP reconciliation pages 64 *visited* metadata rows in
  `(uid_validity, uid, rowid)` order using the existing UID index, then compares
  them against one per-pass provider UID set. Eligibility (local-only, pending
  draft, horizon and held action) is checked without excluding visited rows in
  SQL. Even unchanged pages yield with no open transaction. Account/store and
  folder-generation freshness are rechecked after yields. Only complete UID
  arrays allow deletion; `keepOthers`, absent coverage and failed/incomplete
  provider searches never imply deletion. The provider UID array plus membership
  set are still history-sized; this does not claim constant-memory provider sync.
  The compatibility synchronous reconciliation helper remains unchanged.
- **G11:** Conversation action enumeration uses ID/folder/provider identity only,
  retaining complete membership and chronological ordering. `mail:openEmail`
  accepts `includeThread: false`; omitted/true preserves the prior full-header
  contract. Conversation-disabled Mail, separate readers, previews and
  reply/draft preparation omit unused summaries. The post-await account check
  and fresh full-message read remain; no draft/content freshness is sacrificed.

## Deferred review findings and remaining scope

- **G01:** Exclusive migration-worker ownership needs its own ADR, handoff and
  crash/restart/cancellation tests. Useful indexes remain; migration is synchronous.
- **G04:** `.live` reuse / copy-on-write authority changes need a separate recovery
  protocol and publication-race evidence. No working-copy protocol changes here.
- **G05:** Body-metadata layout rewrites are high-risk and excluded. Keep #433's
  8 ms / 64-row budget, durable progress and large-operation caveat.
- **G06:** Warm verification still has negative document/orphan scans. A bounded
  verifier must integrate all three consistency tables, repair admission, restart
  proofs and final durable markers; that is not a low-risk loop-only change.
- **G10:** Exact broad search still groups and ranks all candidates. Current
  metadata projection already avoids body hydration; no safe bounded winner
  shortcut was found that preserves the complete weighted/prefix/AND top 100.
  Query-owner/snapshot work needs separate design. No first-N truncation is used.
- **G12–G14:** Recipient-worker retention, scheduled queue enumeration and retained
  sidebar complexity are P3 and excluded from this job.
- **G08 remainder:** Filtered/held cursors, reverse seeks and arbitrary deep offsets
  need explicit geometry and hold semantics; retain offset fallback.
- **G11 remainder:** Lazy long-thread headers and avoiding the second full body
  read need revision/lifecycle design. Conversation-enabled opens still return
  all local headers, and action planning still validates each member.

## Validation boundary

The existing runtime-10k, storage and startup checks cover actual SQLite/provider
adapters and synthetic renderer mounts. Added checks exercise per-message count
acknowledgements and journal rollback/recovery, aggregate plans and held-row
scope/expiry, deep refresh rejection, body-free membership and omitted threads,
unchanged visited-row seeks and partial provider results, late writes during a
long checkpoint, hard/soft dispatch gates and retained headroom/retry behavior.
Persistence, upgrade, Gmail/action, unread and search suites provide the wider
durability regressions. No live mailbox, Keychain, AI, provider write or send is
needed. Packaged SQLite plans, native physical allocation, foreground I/O and
Mac/Windows frame times still require native tracing; no native speed guarantee.
