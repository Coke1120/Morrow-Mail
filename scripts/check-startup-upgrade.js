"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
process.env.MORROW_PERF = "1";
const Database = require("better-sqlite3");
const { Persistence } = require("../host/mail/persistence");
const perf = require("../host/performance-diagnostics");
const sourceFile = path.join(__dirname, "../host/mail/db.js");
const load = createRequire(sourceFile);
const count = 300;

function sql(file, work) {
  const database = new Database(file);
  try { return work(database); } finally { database.close(); }
}

function bodies(database) {
  return crypto.createHash("sha256").update(JSON.stringify(database.prepare("SELECT id, html_body, text_body FROM messages ORDER BY id").all())).digest("hex");
}

async function seed(file) {
  const database = require("../host/mail/db");
  await database.open(file);
  database.insertAccount({ ...require("./mail-performance-fixture").account, id: "synthetic" });
  database.replaceFolders("synthetic", [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }]);
  await database.checkpoint(); await database.close();
  return sql(file, raw => {
    raw.exec("DROP TRIGGER message_body_metadata_insert; DROP TRIGGER message_body_metadata_update; DROP INDEX messages_body_metadata_pending; ALTER TABLE messages DROP COLUMN has_body");
    const insert = raw.prepare(`INSERT INTO messages(id, account_id, folder_path, uid, uid_validity, thread_id,
      date_iso, list_sort_ts, html_body, text_body) VALUES (?, 'synthetic', 'INBOX', ?, 1, ?, '2026-11-01', ?, ?, ?)`);
    const whitespace = [null, "", " \t\r\n\u00a0\u200a\u202f\ufeff", "\u200b", "bodyneedle"];
    raw.transaction(() => {
      for (let index = 0; index < count; index++) {
        const id = "legacy-" + String(index).padStart(4, "0");
        insert.run(id, index + 1, id, index, index === 0 ? "<p>largebodyneedle " + "large ".repeat(180000) + "</p>" : null,
          index === 0 ? "largebodyneedle " + "large ".repeat(180000) : whitespace[index % whitespace.length]);
      }
      raw.prepare("UPDATE message_fts_meta SET meta_value = 'legacy' WHERE meta_key = 'version'").run();
    })();
    assert.equal(raw.prepare("PRAGMA table_info(messages)").all().some(row => row.name === "has_body"), false);
    return bodies(raw);
  });
}

async function freshAdmissionChecks(directory) {
  const database = require("../host/mail/db");
  for (const phase of ["migrate", "initialize"]) {
    const file = path.join(directory, "fresh-abort-" + phase + ".sqlite");
    const controller = new AbortController(), pending = [], errors = [];
    const stop = database.subscribeStartupProgress(event => {
      if (event.phase !== phase) return;
      try {
        pending.push(assert.rejects(database.checkpoint(), error => error.code === "mail_not_ready"));
        assert.equal(fs.existsSync(file + ".journal"), false, "uninitialized maintenance must not create a recovery journal");
        controller.abort();
      } catch (error) { errors.push(error); }
    });
    try {
      await assert.rejects(database.open(file, { signal: controller.signal }), error => error.code === "mail_open_cancelled");
      await Promise.all(pending); assert.equal(pending.length, 1); assert.deepEqual(errors, []);
    } finally { stop(); await database.close(); }
    assert.equal(fs.existsSync(file + ".journal"), false);
    await database.open(file); assert.equal(database.isReady(), true); await database.close();
  }
}

async function upgrade(file, { abortAfter = 0, closeAfter = 0, exitAfter = 0, failAt = 0, sqlFullAt = 0, expectedRemaining = count, expectedHash } = {}) {
  let clock = 0, adapter, owner, batches = 0, updates = 0, startupCopies = 0, yields = 0;
  const began = performance.now(), cpu = process.cpuUsage();
  const scenario = exitAfter ? "process-exit" : abortAfter ? "abort" : closeAfter ? "close" : failAt ? "journal-failure"
    : sqlFullAt ? "sqlite-full" : expectedRemaining === 0 ? "warm" : expectedRemaining === count ? "complete" : "resume";
  let phase = "opening", completed = 0;
  const diagnostic = event => {
    const usage = process.cpuUsage(cpu);
    console.log("startup-upgrade-progress " + JSON.stringify({ scenario, event, phase, completed, expectedRemaining,
      updates, batches, yields, elapsedMs: Math.round(performance.now() - began),
      cpuUserMs: Math.round(usage.user / 1000), cpuSystemMs: Math.round(usage.system / 1000) }));
  };
  // Fixed synthetic counters identify healthy durable work versus an idle wait.
  // This timer never keeps the process alive and changes no storage behavior.
  const heartbeat = setInterval(() => diagnostic("heartbeat"), 10000);
  heartbeat.unref();
  diagnostic("start");
  const events = [], errors = [], controller = new AbortController();
  const originalOpen = Persistence.prototype.open;
  const originalDispatch = Persistence.prototype.dispatchCheckpoint;
  Persistence.prototype.open = async function (...args) {
    owner = this;
    adapter = await originalOpen.apply(this, args);
    const originalRun = adapter.run;
    adapter.run = function (statement, params) {
      const value = originalRun.call(this, statement, params);
      if (/^UPDATE messages SET has_body/.test(statement.trim())) {
        clock += 9; updates++;
        if (updates === sqlFullAt) throw Object.assign(new Error("Synthetic database or disk is full"), { code: "SQLITE_FULL" });
      }
      return value;
    };
    const append = this.append;
    this.append = function (commands) {
      const updates = commands.filter(command => /^UPDATE messages SET has_body/.test(command.sql.trim()));
      if (updates.length) {
        assert.equal(updates.reduce((total, command) => total + command.bindings.length, 0), 1, "the per-message time budget ends this real SQLite batch");
        batches++;
        if (batches === failAt) throw Object.assign(new Error("Synthetic backfill journal failure"), { code: "ENOSPC" });
      }
      return append.call(this, commands);
    };
    return adapter;
  };
  Persistence.prototype.dispatchCheckpoint = function (...args) {
    if (this.startup) startupCopies++;
    return originalDispatch.apply(this, args);
  };
  const databaseModule = { exports: {} };
  const context = {
    module: databaseModule,
    require(name) { return name === "node:perf_hooks" ? { performance: { now: () => clock } } : load(name); },
    setImmediate(callback) {
      assert.equal(adapter?.raw.open ? adapter.raw.inTransaction : false, false);
      yields++; setImmediate(callback);
    },
  };
  vm.runInNewContext(fs.readFileSync(sourceFile, "utf8"), context);
  const database = databaseModule.exports;
  const stop = database.subscribeStartupProgress(event => {
    try {
      phase = event.phase;
      if (event.phase === "body-backfill" && Number.isSafeInteger(event.completed)) completed = event.completed;
      events.push(event);
      if (!["idle", "ready", "failed", "cancelled"].includes(event.phase)) {
        assert.equal(database.isReady(), false);
        assert.throws(() => database.listAccountRows(), error => error.code === "mail_not_ready", "observers cannot borrow internal admission");
      }
      if (event.phase === "body-backfill" && Number.isSafeInteger(event.completed)) {
        assert.equal(event.total, expectedRemaining);
        assert.equal(adapter.raw.inTransaction, false);
        const remaining = adapter.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE has_body IS NULL").get().n;
        assert.equal(remaining, expectedRemaining - event.completed);
        assert.equal(adapter.raw.prepare("SELECT sequence FROM morrow_storage WHERE id = 1").get().sequence, owner.sequence);
        if (event.completed > 0) assert.ok(fs.statSync(owner.journal).size > 0);
        if (event.completed === abortAfter && abortAfter) controller.abort();
        if (event.completed === closeAfter && closeAfter) database.close();
        if (event.completed === exitAfter && exitAfter) process.exit(27);
      }
    } catch (error) { errors.push(error); }
  });
  try {
    const opening = database.open(file, { signal: controller.signal });
    if (abortAfter || closeAfter) await assert.rejects(opening, error => error.code === "mail_open_cancelled");
    else if (failAt) await assert.rejects(opening, /Synthetic backfill journal failure/);
    else if (sqlFullAt) await assert.rejects(opening, error => error.code === "SQLITE_FULL");
    else {
      await opening;
      assert.equal(database.isReady(), true);
      if (expectedHash) assert.equal(bodies(adapter.raw), expectedHash, "body-bearing records keep exact contents");
      for (const row of adapter.raw.prepare("SELECT has_body, html_body, text_body FROM messages").all()) {
        assert.equal(row.has_body, Number(!!((row.html_body || "").trim() || (row.text_body || "").trim())));
      }
      assert.equal(adapter.raw.prepare("SELECT COUNT(*) AS n FROM message_fts_doc").get().n, count);
      assert.equal(adapter.raw.prepare("SELECT meta_value FROM message_fts_meta WHERE meta_key = 'rebuild'").get(), undefined);
      assert.ok(database.searchMessages({ query: "largebodyneedle" }).length > 0);
      assert.equal(startupCopies, 0, "300 small startup commits are coalesced instead of starting full copies");
      const checkpoint = await database.checkpoint();
      assert.ok(!checkpoint || checkpoint.sequence >= owner.sequence);
      assert.equal(sql(file, raw => raw.prepare("SELECT sequence FROM morrow_storage WHERE id = 1").get().sequence), owner.sequence);
    }
    assert.deepEqual(errors, []);
    assert.ok(yields > 0);
    const progress = events.filter(event => event.phase === "body-backfill" && Number.isSafeInteger(event.completed));
    assert.equal(progress.at(-1).completed, failAt || sqlFullAt ? (failAt || sqlFullAt) - 1 : abortAfter || closeAfter || expectedRemaining);
    return { events, batches };
  } finally {
    stop();
    try { await database.close(); }
    finally {
      clearInterval(heartbeat);
      diagnostic("closed");
      Persistence.prototype.open = originalOpen;
      Persistence.prototype.dispatchCheckpoint = originalDispatch;
    }
  }
}

(async () => {
  if (process.argv[2] === "--exit-after-body") return upgrade(process.argv[3], { exitAfter: 2 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-startup-upgrade-"));
  try {
    await freshAdmissionChecks(directory);
    const base = path.join(directory, "legacy.sqlite"), expectedHash = await seed(base);
    const copy = name => { const file = path.join(directory, name + ".sqlite"); fs.copyFileSync(base, file); return file; };
    const clean = copy("complete");
    const complete = await upgrade(clean, { expectedHash });
    const phases = [...new Set(complete.events.map(event => event.phase))];
    assert.deepEqual(phases, ["idle", "copy", "journal", "migrate", "body-backfill", "summaries", "search", "admit", "ready"]);
    const warm = await upgrade(clean, { expectedRemaining: 0, expectedHash });
    assert.equal(warm.batches, 0);
    for (const mode of ["abort", "close", "failure", "sqlite-full"]) {
      const file = copy(mode);
      await upgrade(file, mode === "abort" ? { abortAfter: 2 } : mode === "close" ? { closeAfter: 2 }
        : mode === "failure" ? { failAt: 2 } : { sqlFullAt: 2 });
      await upgrade(file, { expectedRemaining: count - (["failure", "sqlite-full"].includes(mode) ? 1 : 2), expectedHash });
    }
    const exited = copy("process-exit");
    const child = spawnSync(process.execPath, [__filename, "--exit-after-body", exited], { env: process.env, encoding: "utf8", timeout: 30000 });
    assert.equal(child.status, 27, child.stderr || child.error?.message);
    await upgrade(exited, { expectedRemaining: count - 2, expectedHash });
    const timings = perf.snapshot().stages.map(row => row.stage);
    for (const stage of ["startup.copy", "startup.journal", "startup.migrate", "startup.body-backfill", "startup.index", "startup.admit",
      "storage.replay", "storage.checkpoint.copy", "storage.checkpoint.replay", "storage.checkpoint.publish"]) assert.ok(timings.includes(stage), stage);
    perf.phase("private@example.test", "start"); perf.phase("startup.copy", "private-token");
    const logs = require("../host/debug-log").recent(200).filter(row => row.source === "performance").map(row => JSON.parse(row.text));
    assert.ok(logs.some(row => row.stage === "startup.body-backfill" && row.event === "start"));
    assert.ok(logs.some(row => row.stage === "startup.body-backfill" && row.event === "complete"));
    assert.ok(logs.every(row => Object.keys(row).sort().join() === "event,stage"));
    assert.ok(!JSON.stringify(logs).includes("private"));
    console.log("startup-upgrade-ok: fresh checkpoint admission, legacy bodies, phase/admission boundaries, per-message budgets, abort/close/journal-failure/SQLITE_FULL/process-exit resume, parity and numeric worker timings");
    console.log("startup-upgrade-resources " + JSON.stringify(process.getActiveResourcesInfo()));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
