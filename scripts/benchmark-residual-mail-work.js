"use strict";

// Offline paired probe for #520. Use the same harness against immutable source
// archives, serially; wall-clock observations are deliberately not CI gates.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { account, message } = require("./mail-performance-fixture");
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const root = path.resolve(option("--source-root", path.join(__dirname, "..")));
const count = Number(option("--messages", 10000)), rounds = Number(option("--rounds", 5));
assert.ok(Number.isSafeInteger(count) && count >= 1000 && count <= 200000);
assert.ok(Number.isSafeInteger(rounds) && rounds >= 3 && rounds <= 20);
const tick = () => new Promise(resolve => setImmediate(resolve));
const round = value => Math.round(value * 1000) / 1000;
const samples = [], plans = {};
const fixtureFile = option("--fixture-file", null);
if (args.includes("--prepare-only")) assert.ok(fixtureFile, "--prepare-only requires --fixture-file");
const fixtureDigest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const harnessSha256 = fixtureDigest(__filename);
const prepare = Database.prototype.prepare;
let capture = null;
Database.prototype.prepare = function(sql) {
  const stmt = prepare.call(this, sql), all = stmt.all;
  stmt.all = function(...params) {
    if (capture && /SELECT/.test(sql) && !/^PRAGMA/.test(sql)) capture.push({ sql, params: params[0] || [] });
    return all.apply(this, params);
  };
  return stmt;
};
let maxSampledRss = 0;
async function measure(label, work) {
  process.stderr.write(label + "\n");
  await work(); await tick();
  const raw = [];
  for (let n = 0; n < rounds; n++) {
    // A continuous immediate heartbeat covers *every* yield and the final
    // callback, including commit/fsync and oversized operations late in a pass.
    let previous = performance.now(), maxGap = 0, callbacks = 0, stopped = false;
    function heartbeat() {
      const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; callbacks++;
      if (!stopped) setImmediate(heartbeat);
    }
    setImmediate(heartbeat);
    const began = performance.now();
    await work();
    const duration = performance.now() - began;
    await tick(); stopped = true; await tick();
    const rss = process.memoryUsage().rss; maxSampledRss = Math.max(maxSampledRss, rss);
    raw.push({ elapsedMs: round(duration), maxCallbackGapMs: round(maxGap), callbacks, sampledRssBytes: rss });
  }
  samples.push({ label, medianMs: [...raw.map(x => x.elapsedMs)].sort((a,b) => a-b)[Math.floor(rounds/2)], raw });
}

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-residual-bench-"));
  const db = require(path.join(root, "host/mail/db"));
  const file = path.join(directory, "mail.sqlite");
  global.fetch = async () => { throw new Error("Live access forbidden"); };
  let raw;
  try {
    let restored = false;
    if (fixtureFile && fs.existsSync(fixtureFile)) {
      const manifest = JSON.parse(fs.readFileSync(fixtureFile + ".json", "utf8"));
      assert.equal(manifest.kind, "morrow-residual-synthetic-v1"); assert.equal(manifest.count, count);
      assert.equal(fixtureDigest(fixtureFile), manifest.sha256);
      fs.copyFileSync(fixtureFile, file); restored = true;
    }
    const openBegan = performance.now();
    await db.open(file);
    const openMs = performance.now() - openBegan;
    if (!restored) {
      for (const id of ["a", "b"]) {
        db.insertAccount({ ...account, id, email: `${id}@fixture.invalid` });
        db.replaceFolders(id, [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }]);
      }
      for (const [owner, first, end] of [["a", 0, Math.floor(count * .95)], ["b", Math.floor(count * .95), count]]) {
        for (let start = first; start < end; start += 100) {
          const messages = Array.from({ length: Math.min(100, end - start) }, (_, n) => {
            const uid = start + n + 1;
            return message(uid, { subject: `Common alpha ${uid % 97 === 0 ? "ζήτα rareterm" : "apple"} ${uid === count - 13 ? "uniqueonly" : ""}`,
              listSortTs: 1700000000000 + Math.floor(uid / 3),
              textBody: "common alpha apple searchable synthetic body ".repeat(6), htmlBody: null });
          });
          db.applyFolderSync(owner, "INBOX", { messages, validity: 7, keepOthers: true });
          if (start % 10000 === 0) process.stderr.write(`seed ${start}\n`);
        }
      }
      await db.checkpoint();
      if (fixtureFile) {
        fs.copyFileSync(file, fixtureFile);
        fs.writeFileSync(fixtureFile + ".json", JSON.stringify({ kind: "morrow-residual-synthetic-v1", count, sha256: fixtureDigest(fixtureFile) }));
      }
    }
    if (args.includes("--prepare-only")) return;
    // Apply identically to each temporary copy, including older tagged fixture
    // checkpoints, so a one-hit query also exercises the large outer account.
    const rare = db.messageById("performance-37");
    db.updateMessage(rare.id, { subject: rare.subject + " uniquelarge" });
    await db.checkpoint(); // Quiesce schema/index migration before paired work.
    raw = new Database(file + ".live", { readonly: true });
    assert.equal(prepare.call(raw, "SELECT COUNT(*) AS n FROM messages").get().n, count);
    assert.equal(prepare.call(raw, "SELECT COUNT(*) AS n FROM messages WHERE body_complete != 1").get().n, 0);
    global.gc?.();
    async function traced(label, work) {
      capture = [];
      try { await work(); } finally {
        const queries = capture; capture = null;
        plans[label] = queries.filter(x => /WITH search_seed|FROM messages m|FROM message_fts f/.test(x.sql)).map(x => ({
          sql: x.sql, plan: prepare.call(raw, "EXPLAIN QUERY PLAN " + x.sql).all(x.params).map(row => row.detail),
        })); // Synthetic SQL templates only; bindings never printed.
      }
      await measure(label, work);
    }
    for (const [label, query] of [
      ["search.common.global", { query: "common alpha" }],
      ["search.common.large-account", { query: "common alpha", accountId: "a" }],
      ["search.common.small-account", { query: "common alpha", accountId: "b" }],
      ["search.rare.scoped", { query: "uniqueonly", accountId: "b" }],
      ["search.rare.large-account", { query: "uniquelarge", accountId: "a" }],
      ["search.rare-and-common", { query: "common uniqueonly", accountId: "b" }],
      ["search.prefix", { query: "a", accountId: "a" }],
    ]) await traced(label, () => db.searchMessages(query, { headersOnly: true }));
    for (const pending of [0, 1, 200]) {
      for (let n = 0; n < pending; n++) db.updateMessage(`performance-${count - 3 * n}`, { body_complete: 0 });
      const query = { needsBody: true, limit: 200 };
      await traced(`pending.${pending}`, () => db.selectMessages(query, { headersOnly: true, now: 1800000000000 }));
      await traced(`pending.${pending}.deep`, () => db.selectMessages({ ...query,
        beforeMessage: { ts: 1700000000000 + Math.floor(count / 6), id: "synthetic-boundary" } }, { headersOnly: true, now: 1800000000000 }));
    }
    let indexBytes = null;
    try { indexBytes = prepare.call(raw, "SELECT name, SUM(pgsize) AS bytes FROM dbstat WHERE name LIKE 'messages_pending_body%' GROUP BY name").all(); } catch {}
    await measure("pending.maintenance-200", () => {
      for (const complete of [1, 0]) db.transaction(() => {
        for (let n = 0; n < 200; n++) db.updateMessage(`performance-${count - 3 * n}`, { body_complete: complete });
      });
    });
    const normalized = Array.from({ length: 1000 }, (_, n) => `bodyterm${n}`).join(" ");
    const ingest = (bytes, total = 96) => Array.from({ length: total }, (_, n) => message(count + 1 + n, {
      textBody: bytes ? "x".repeat(bytes) : normalized, htmlBody: bytes ? "x".repeat(bytes) : `<p>${normalized}</p>` }));
    let revision = 0;
    for (const [label, rows] of [["ingest.96-indexed", ingest(0)], ["ingest.oversized-late", [...ingest(0, 30), ...ingest(3 * 1024 * 1024, 1).map(row => ({ ...row, id: "oversized", uid: count + 1000 }))]]]) {
      await measure(label, () => db.applyFolderSyncAsync("a", "INBOX", { messages: rows.map(row => ({ ...row,
        subject: `Changed content ${++revision}`, textBody: row.textBody + revision })), validity: 7, keepOthers: true }));
    }
    const sourceSha = option("--source-sha", null) || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const output = { sourceSha, harnessSha256, fixtureSha256: fixtureFile ? fixtureDigest(fixtureFile) : null,
      node: process.version, electronPackageVersion: require("electron/package.json").version, sqlite: prepare.call(raw, "SELECT sqlite_version() AS v").get().v,
      platform: process.platform, arch: process.arch, fixture: { count, split: "95/5 percent, two accounts, one folder each", bodyBytes: 270,
        terms: "common/alpha all rows; rareterm 1/97; uniqueonly one small-account row; uniquelarge one large-account row added before timing; tied dates every three rows", pending: [0, 1, 200] },
      rounds, samples, plans, indexBytes, maxSampledRssBytes: maxSampledRss,
      setup: { templateRestored: restored, openMs: round(openMs), checkpointBytes: fs.statSync(file).size },
      limits: "Synthetic Linux host-only, warm cache, no Electron/native frames/provider/credentials; sampled RSS is not peak memory. Gaps cover entire passes. Individual SQL/index/journal/fsync remain synchronous." };
    const json = JSON.stringify(output, null, 2) + "\n";
    if (option("--output", null)) fs.writeFileSync(option("--output"), json); else process.stdout.write(json);
  } finally {
    Database.prototype.prepare = prepare; raw?.close(); await db.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
