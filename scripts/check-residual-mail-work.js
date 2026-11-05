"use strict";

// Mechanism/correctness gates, never timing SLAs or real mail profiles.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { performance } = require("node:perf_hooks");
const Database = require("better-sqlite3");
const db = require("../host/mail/db");
const perf = require("../host/performance-diagnostics");
const { Persistence } = require("../host/mail/persistence");
const { account, message } = require("./mail-performance-fixture");
const tick = () => new Promise(resolve => setImmediate(resolve));
const ids = rows => rows.map(row => row.id);

async function run() {
  // Keep this clock independent of the injected budget clock below. Stage/CPU
  // evidence distinguishes slow durable Windows I/O from an ownership hang.
  const wallNow = performance.now.bind(performance), began = wallNow(), cpu = process.cpuUsage();
  let phase = "opening", completed = 0, heartbeats = 0;
  const progress = () => {
    const used = process.cpuUsage(cpu);
    console.log("residual-check-progress", JSON.stringify({ phase, completed, heartbeats,
      elapsedMs: Math.round(wallNow() - began), cpuUserMs: Math.round(used.user / 1000), cpuSystemMs: Math.round(used.system / 1000) }));
  };
  const stage = next => { phase = next; completed = 0; progress(); };
  const heartbeat = setInterval(() => { heartbeats++; progress(); }, 5000); heartbeat.unref();
  progress();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-residual-check-"));
  const file = path.join(directory, "mail.sqlite");
  const original = { prepare: Database.prototype.prepare, append: Persistence.prototype.append, sync: perf.sync,
    clock: Object.getOwnPropertyDescriptor(performance, "now") };
  let statements = [], raw;
  Database.prototype.prepare = function(sql) {
    const statement = original.prepare.call(this, sql), all = statement.all;
    statement.all = function(...args) { statements.push({ sql, params: args[0] || [] }); return all.apply(this, args); };
    return statement;
  };
  const queryPlan = entry => original.prepare.call(raw, "EXPLAIN QUERY PLAN " + entry.sql).all(entry.params).map(x => x.detail).join("\n");
  try {
    await db.open(file);
    for (const [owner, count] of [["a", 2500], ["b", 83]]) {
      stage(owner === "a" ? "seed-large" : "seed-small");
      db.insertAccount({ ...account, id: owner, email: `${owner}@fixture.invalid` });
      db.replaceFolders(owner, [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" },
        { path: "Trash", name: "Trash", wellKnown: "deleteditems" }, { path: "Spam", name: "Spam", wellKnown: "junkemail" }]);
      for (let start = 0; start < count; start += 100) db.applyFolderSync(owner, "INBOX", { validity: 7, keepOthers: true,
        messages: Array.from({ length: Math.min(100, count - start) }, (_, n) => message(start + n + 1, {
          id: `${owner}-${start + n}`, listSortTs: Math.floor((start + n) / 3),
          subject: (n % 2 ? "Common alpha" : "Common café ζήτα 測試") + (start + n === 7 ? " uniqueonly" : ""),
          from: n % 3 ? "Sender <sender@fixture.invalid>" : "Common <common@fixture.invalid>",
          to: n % 5 ? [owner + "@fixture.invalid"] : ["elsewhere@fixture.invalid"],
          textBody: "common alpha apple body " + Array.from({ length: 12 }, (_, n) => `bodyterm${n}`).join(" "), htmlBody: null,
        })) });
      completed = count; progress();
    }
    // The large seed exists to exercise search plans, not to benchmark recovery
    // repeatedly. Checkpoint it once; pending/body changes below still have to
    // survive journal replay. Replaying all 2.5k seed rows/terms on both reopens
    // needlessly dominated the Windows fixture's original 30-second deadline.
    stage("seed-checkpoint");
    await db.checkpoint();
    raw = new Database(file + ".live");
    stage("exact-search");
    function reference(tokens, owner, toMe = false, limit = 100) {
      const params = [], joins = tokens.map((token, n) => {
        const chars = Array.from(token); chars[chars.length - 1] = String.fromCodePoint(chars.at(-1).codePointAt(0) + 1);
        params.push(token, chars.join(""));
        return `JOIN (SELECT message_id, MAX(CASE field WHEN 'subject' THEN 6 WHEN 'sender' THEN 4 ELSE 1 END) AS weight
          FROM message_fts WHERE term >= ? AND term < ? GROUP BY message_id) t${n} ON t${n}.message_id = m.id`;
      });
      if (owner) params.push(owner);
      return original.prepare.call(raw, `SELECT m.id FROM messages m JOIN accounts a ON a.id = m.account_id ${joins.join(" ")}
        WHERE 1 = 1 ${owner ? "AND m.account_id = ?" : ""}
        ${toMe ? "AND EXISTS (SELECT 1 FROM json_each(m.to_json) WHERE value = a.email)" : ""}
        ORDER BY (${tokens.map((_, n) => `t${n}.weight`).join(" + ")}) DESC, m.list_sort_ts DESC, m.id DESC LIMIT ${limit}`).all(params);
    }
    for (const owner of [null, "a", "b", "absent"]) for (const filterToMe of [false, true]) {
      for (const [query, tokens] of [["common alpha", ["common", "alpha"]], ["a", ["a"]], ["common uniqueonly", ["common", "uniqueonly"]],
        ["CAFÉ", ["cafe"]], ["ζήτα", ["ζητα"]], ["測試", ["測試"]], ["body", ["body"]], ['"common alpha"', ["common", "alpha"]]]) {
        const rows = db.searchMessages({ query, accountId: owner, filterToMe }, { headersOnly: true });
        assert.deepEqual(ids(rows), ids(reference(tokens, owner, filterToMe)), "complete weighted AND/prefix/Unicode/date/id ranking");
        assert.ok(rows.every(row => !Object.hasOwn(row, "text_body") && !Object.hasOwn(row, "html_body")));
        completed++;
      }
    }
    assert.deepEqual(db.searchMessages({ accountRequired: true, query: "common" }), []);
    assert.deepEqual(db.searchMessages({ query: "☀" }), []);
    assert.deepEqual(ids(db.timelineSearch({ query: "common", accountId: "a" })), ids(reference(["common"], "a", false, 1001)));
    statements = [];
    db.searchMessages({ query: "common uniqueonly", accountId: "a" }, { headersOnly: true });
    const search = statements.find(x => x.sql.includes("WITH search_seed"));
    const plan = queryPlan(search);
    assert.match(plan, /SEARCH f USING COVERING INDEX .*\(term>\? AND term<\?\)/);
    assert.match(plan, /SEARCH m USING INDEX sqlite_autoindex_messages_1 \(id=\?\)/);
    assert.doesNotMatch(plan, /SCAN m\b|SEARCH m .*account_id/);
    assert.match(search.sql, /search_seed s CROSS JOIN message_fts f/);
    assert.equal(search.params[0], "uniqueonly", "the selective term drives outer and remaining inner access even when typed last");
    console.log("residual-search-plan", plan);
    statements = [];
    assert.deepEqual(ids(db.searchMessages({ query: "body common", accountId: "a" })), ids(reference(["body", "common"], "a")));
    const broadScope = statements.find(x => x.sql.includes("WITH search_seed"));
    assert.match(broadScope.sql, /FROM messages scoped CROSS JOIN message_fts f/);
    assert.match(broadScope.sql, /search_seed s CROSS JOIN message_fts f/);
    progress(); stage("pending-eligibility");

    // All-complete idle poll, sparse eligibility, scopes/exclusions, retry
    // deadline, equal-date ties and deep keysets use the actual production SQL.
    function pending(input = {}, now = 1000) {
      statements = [];
      const rows = db.selectMessages({ needsBody: true, limit: 200, ...input }, { headersOnly: true, now });
      const entry = statements.find(x => x.sql.includes("FROM messages m"));
      assert.match(queryPlan(entry), /messages_pending_body_page/);
      if (!input.sortBy) assert.doesNotMatch(queryPlan(entry), /TEMP B-TREE FOR ORDER BY/);
      return rows;
    }
    assert.deepEqual(pending(), []);
    for (let n = 0; n < 15; n++) db.updateMessage("a-" + n, { body_complete: 0, list_sort_ts: Math.floor(n / 3) });
    db.updateMessage("a-0", { body_retry_blocked: 1 });
    db.updateMessage("a-1", { body_retry_after: 1001 });
    db.updateMessage("a-2", { is_draft: 1 });
    db.updateMessage("a-3", { uid: 0 });
    db.updateMessage("a-4", { folder_path: "Trash" });
    db.updateMessage("a-5", { folder_path: "Spam" });
    assert.equal(pending().length, 9);
    assert.equal(pending({}, 1001).length, 10);
    assert.deepEqual(pending({ accountId: "b" }), []);
    assert.deepEqual(pending({ excludeFolderPaths: ["INBOX"] }), []);
    assert.deepEqual(pending({ excludeMailboxes: [{ accountId: "a", path: "INBOX" }] }), []);
    const first = pending({ accountId: "a", limit: 3 });
    const boundary = first.at(-1);
    assert.deepEqual(ids([...first, ...pending({ beforeMessage: { ts: boundary.list_sort_ts, id: boundary.id } })]), ids(pending()));
    assert.deepEqual(pending({ sinceTs: 99999 }), []);
    assert.equal(pending({ sinceTs: 4 }).length, 3);
    db.updateMessage("a-0", { uid: 8000 });
    assert.equal(pending().length, 10, "provider identity reset restores retry eligibility and index membership");
    const beforeFailure = ids(pending());
    Persistence.prototype.append = () => { throw Object.assign(new Error("Synthetic full disk"), { code: "ENOSPC" }); };
    assert.throws(() => db.updateMessage("a-6", { body_complete: 1 }), /Synthetic full disk/);
    Persistence.prototype.append = original.append;
    assert.deepEqual(ids(pending()), beforeFailure, "pending index rolls back with the message and journal");
    assert.ok(fs.statSync(file + ".journal").size > 0, "eligibility deltas still require journal recovery");
    stage("pending-reopen");
    raw.close(); raw = null;
    await db.close(); await db.open(file);
    raw = new Database(file + ".live");
    assert.deepEqual(ids(pending()), beforeFailure, "index eligibility survives journal replay");

    stage("elapsed-budget");
    db.insertAccount({ ...account, id: "ingest" }); db.replaceFolders("ingest", [{ path: "INBOX", name: "Inbox" }]);
    const commits = [];
    Persistence.prototype.append = function(commands) {
      const rows = commands.flatMap(x => /INSERT INTO messages/.test(x.sql) ? x.bindings : []);
      const value = original.append.call(this, commands);
      if (rows.length) commits.push(rows.length);
      return value;
    };
    let logicalTime = 0;
    Object.defineProperty(performance, "now", { configurable: true, value: () => logicalTime });
    perf.sync = (stage, work) => { const value = original.sync(stage, work); if (stage === "db.index") logicalTime += 9; return value; };
    let observed = 0;
    await db.applyFolderSyncAsync("ingest", "INBOX", { messages: Array.from({ length: 5 }, (_, n) => message(n + 1, { id: `time-${n}` })),
      validity: 7, keepOthers: true, uidCursor: 5, windowDone: true }, () => {
      raw.prepare("BEGIN IMMEDIATE").run(); raw.prepare("ROLLBACK").run(); // No transaction/lock crosses a yield.
      observed++;
    });
    assert.deepEqual(commits, [1, 1, 1, 1, 1], "elapsed work, independently of row/byte limits, ends each batch");
    assert.ok(observed >= 6);
    completed = commits.length; progress(); stage("byte-budget");
    // Frozen clock isolates byte admission from CPU speed. Two 160 KiB UTF-8
    // rows do not share a 256 KiB batch; oversized rows still make progress.
    perf.sync = original.sync; commits.length = 0;
    const body = "界".repeat(55 * 1024);
    await db.applyFolderSyncAsync("ingest", "INBOX", { messages: Array.from({ length: 4 }, (_, n) => message(10 + n, {
      id: `bytes-${n}`, textBody: n === 2 ? "x".repeat(3 * 1024 * 1024) : body, htmlBody: body })), validity: 7, keepOthers: true });
    assert.deepEqual(commits, [1, 1, 1, 1]);
    assert.equal(db.messageById("bytes-2").text_body.length, 3 * 1024 * 1024);
    const nowRows = db.selectMessages({ accountId: "ingest" });
    assert.equal(nowRows.length, 9);
    assert.equal(db.searchMessages({ query: "synthetic", accountId: "ingest" }).length, 9);
    completed = commits.length; progress(); stage("oversized-reopen");
    if (original.clock) Object.defineProperty(performance, "now", original.clock); else delete performance.now;
    Persistence.prototype.append = original.append;
    raw.close(); raw = null;
    await db.close(); await db.open(file);
    assert.equal(db.messageById("bytes-2").text_body.length, 3 * 1024 * 1024, "oversized normalized body remains durable");
    assert.equal(db.searchMessages({ query: "synthetic", accountId: "ingest" }).length, 9);
    stage("verified");
    console.log("residual-mail-work-ok: exact search, candidate plans, pending eligibility/replay and independent time/byte budgets");
  } finally {
    stage("closing");
    Database.prototype.prepare = original.prepare; Persistence.prototype.append = original.append; perf.sync = original.sync;
    if (original.clock) Object.defineProperty(performance, "now", original.clock); else delete performance.now;
    try { raw?.close(); await db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
    finally { clearInterval(heartbeat); stage("closed"); }
  }
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
