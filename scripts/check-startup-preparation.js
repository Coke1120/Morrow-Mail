"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { checkpointDelay, checkpointHeadroom, checkpointRetry } = require("../host/mail/checkpoint-policy");
const { startupProgressScript, startupStatusHtml, startupFailureDialog } = require("../host/startup-error");
const root = path.join(__dirname, "..");
const mib = 1024 ** 2;

function policyChecks() {
  assert.equal(checkpointDelay(), null);
  const small = { databaseBytes: mib, journalBytes: 100000, transactions: 300, sinceCheckpointMs: 100000 };
  assert.equal(checkpointDelay(small), 0);
  assert.equal(checkpointDelay({ ...small, startup: true }), 120000);
  assert.equal(checkpointDelay({ ...small, databaseBytes: 5 * 1024 ** 3 }), 60000);
  assert.equal(checkpointDelay({ ...small, startup: true, ageMs: 120000 }), 0);
  assert.equal(checkpointDelay({ ...small, startup: true, journalBytes: 32 * mib }), 0);
  assert.equal(checkpointDelay({ ...small, startup: true, pending: true, ageMs: 119000 }), 1000);
  assert.equal(checkpointDelay({ ...small, checkpointMs: 10000, sinceCheckpointMs: 1000 }), 39000);
  assert.equal(checkpointDelay({ ...small, checkpointMs: 10000, sinceCheckpointMs: 1000, ageMs: 59000 }), 1000);
  assert.equal(checkpointHeadroom(5 * 1024 ** 3, 6 * 1024 ** 3), true);
  assert.equal(checkpointHeadroom(5 * 1024 ** 3, 4 * 1024 ** 3), false);
  assert.equal(checkpointHeadroom(5 * 1024 ** 3, null), true);
  assert.equal(checkpointRetry(1, true), 60000);
  assert.equal(checkpointRetry(2, true), 120000);
  assert.equal(checkpointRetry(100, true), 300000);
}

function progressChecks() {
  assert.match(startupStatusHtml(), /id="startup-index-progress"/);
  const node = { hidden: true, textContent: "" };
  const render = progress => vm.runInNewContext(startupProgressScript(progress), { document: { getElementById: () => node } });
  const cases = [
    [{ phase: "copy", sourceBytes: 5 * 1024 ** 3 }, /Copying.*5.0 GiB.*indeterminate/],
    [{ phase: "journal", completedBytes: 25, totalBytes: 100 }, /journal: 25% checked.*not overall/],
    [{ phase: "migrate" }, /schema/],
    [{ phase: "initialize" }, /initial.*checkpoint/],
    [{ phase: "body-backfill", completed: 2, total: 10 }, /2 of 10 pending messages committed/],
    [{ phase: "summaries" }, /saved message summaries/],
    [{ phase: "search" }, /Checking local search/],
    [{ phase: "search", searchPhase: "building", completed: 10, total: 10 }, /Finishing local search checks/],
    [{ phase: "search", searchPhase: "building", completed: 2, total: 10, resumed: true }, /Resuming local search: 2 of 10/],
    [{ phase: "admit" }, /verified.*Finishing local mailbox/],
    [{ phase: "ready" }, /Finishing startup/],
  ];
  for (const [progress, expected] of cases) { render(progress); assert.equal(node.hidden, false); assert.match(node.textContent, expected); }
  assert.equal(startupProgressScript({ phase: "private@example.test" }), "");
  render({ phase: "copy", sourceBytes: "private@example.test" });
  assert.ok(!node.textContent.includes("private"));
  for (const code of ["ENOSPC", "SQLITE_FULL"]) {
    const error = Object.assign(new Error("Synthetic disk allocation failure"), { code });
    assert.match(startupFailureDialog(error).detail, /Free space.*Do not delete or rename.*journal files/);
  }
  assert.match(startupFailureDialog(new Error("database or disk is full")).detail, /Free space/);
  const { createRecorder } = require("../host/performance-diagnostics");
  const recorder = createRecorder({ enabled: true });
  const labels = ["startup.copy", "startup.journal", "startup.migrate", "startup.initialize", "startup.body-backfill",
    "startup.summaries", "startup.index", "startup.admit", "storage.checkpoint", "storage.checkpoint.copy",
    "storage.checkpoint.replay", "storage.checkpoint.publish"];
  for (const label of labels) recorder.record(label, 1);
  recorder.record("private@example.test", 100);
  assert.deepEqual(recorder.snapshot().stages.map(row => row.stage), labels);
}

async function backfillChecks() {
  const source = fs.readFileSync(path.join(root, "host/mail/db.js"), "utf8");
  const work = source.slice(source.indexOf("const BODY_METADATA_BATCH_IDS ="), source.indexOf("function recipientHeaderStamp()"));
  async function fixture({ cost = 0, cancel = false, fail = false } = {}) {
    const rows = Array.from({ length: 130 }, (_, index) => ({ id: String(index).padStart(4, "0"), pending: true }));
    let clock = 0, depth = 0, inTransaction = false, committed = 0, yields = 0;
    const events = [], batches = [], operation = { cancelled: false };
    const context = {
      performance: { now: () => clock }, BODY_SPACE: "char(32)",
      internal(callback) { depth++; try { return callback(); } finally { depth--; } },
      assertOpening(owner) { if (owner.cancelled) throw Object.assign(new Error("cancelled"), { code: "mail_open_cancelled" }); },
      get(sql) { assert.equal(depth, 1); assert.match(sql, /WHERE has_body IS NULL/); return { n: rows.filter(row => row.pending).length }; },
      all(sql, params) {
        assert.equal(depth, 1); assert.match(sql, /has_body IS NULL ORDER BY id LIMIT \?/);
        assert.equal(params[0], 64); return rows.filter(row => row.pending).slice(0, params[0]);
      },
      run(sql, params) {
        assert.equal(inTransaction, true); assert.equal(depth, 1);
        assert.match(sql, /AND has_body IS NULL/);
        rows.find(row => row.id === params[0]).pending = false; clock += cost;
      },
      transaction(callback) {
        assert.equal(inTransaction, false); inTransaction = true;
        const before = rows.map(row => row.pending);
        try {
          callback();
          if (fail) throw new Error("synthetic durable commit failure");
          const processed = before.filter(Boolean).length - rows.filter(row => row.pending).length;
          batches.push(processed); committed += processed;
        } catch (error) { rows.forEach((row, index) => { row.pending = before[index]; }); throw error; }
        finally { inTransaction = false; }
      },
      reportStartup(event) {
        assert.equal(depth, 0); assert.equal(inTransaction, false);
        assert.equal(event.completed, committed); events.push(event);
        if (cancel && event.completed > 0) operation.cancelled = true;
      },
      setImmediate(callback) { assert.equal(depth, 0); assert.equal(inTransaction, false); yields++; setImmediate(callback); },
    };
    vm.runInNewContext(work + "\nglobalThis.backfill = ensureBodyMetadata;", context);
    if (fail) await assert.rejects(context.backfill(operation), /durable commit failure/);
    else if (cancel) await assert.rejects(context.backfill(operation), { code: "mail_open_cancelled" });
    else await context.backfill(operation);
    return { rows, events, batches, committed, yields, context };
  }
  const fast = await fixture();
  assert.deepEqual(fast.batches, [64, 64, 2]); assert.equal(fast.yields, 3);
  const slow = await fixture({ cost: 9 });
  assert.equal(slow.batches.length, 130); assert.ok(slow.batches.every(count => count === 1));
  const cancelled = await fixture({ cost: 9, cancel: true });
  assert.equal(cancelled.committed, 1); assert.equal(cancelled.rows.filter(row => row.pending).length, 129);
  const failed = await fixture({ fail: true });
  assert.equal(failed.committed, 0); assert.equal(failed.events.length, 1); assert.ok(failed.rows.every(row => row.pending));
}

async function schedulerChecks() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-startup-policy-"));
  let clock = 0, free = 1024 ** 4;
  const timers = new Set(), records = [];
  class Worker extends EventEmitter {
    ref() {} unref() {} terminate() {} postMessage() {}
  }
  const fileSystem = Object.create(fs);
  fileSystem.statfsSync = () => ({ bavail: free, bsize: 1 });
  const persistenceModule = { exports: {} };
  const context = {
    module: persistenceModule, Buffer, Uint8Array, process, console: { warn() {} }, __filename: path.join(root, "host/mail/persistence.js"),
    setTimeout(callback, delay) { const timer = { callback, at: clock + delay, unref() {} }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    require(name) {
      if (name === "node:fs") return fileSystem;
      if (name === "node:perf_hooks") return { performance: { now: () => clock } };
      if (name === "node:worker_threads") return { Worker, isMainThread: true };
      if (name === "better-sqlite3") return class { constructor() { throw new Error("No SQLite in policy fixtures"); } };
      if (name === "./checkpoint-policy") return require("../host/mail/checkpoint-policy");
      if (name === "../performance-diagnostics") return { sync: (_stage, callback) => callback(), record: (stage, duration) => records.push({ stage, duration }) };
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(context.__filename, "utf8"), context);
  const { Persistence } = persistenceModule.exports;
  const stores = [];
  const store = name => { const value = new Persistence(path.join(directory, name), { startup: true }); value.generation = "fixture"; value.sequence = 0; stores.push(value); return value; };
  const flush = () => new Promise(setImmediate);
  const advance = async milliseconds => {
    clock += milliseconds;
    for (const timer of [...timers]) if (timer.at <= clock) { timers.delete(timer); timer.callback(); }
    await flush();
  };
  try {
    const startup = store("coalesced");
    let dispatches = 0;
    startup.dispatchCheckpoint = async () => { dispatches++; return { bytes: 1, sequence: startup.sequence }; };
    for (let index = 0; index < 300; index++) { startup.append([]); startup.committed(); }
    await advance(1000); assert.equal(dispatches, 0, "small startup commits cannot spam full copies");
    startup.finishStartup(); await advance(1000);
    assert.equal(dispatches, 1); assert.equal(fs.existsSync(startup.pending), false);
    const aged = store("aged");
    aged.append([]); aged.committed();
    aged.dispatchCheckpoint = async () => { dispatches++; return { bytes: 1, sequence: aged.sequence }; };
    await advance(120000); assert.equal(dispatches, 2, "startup coalescing has an age bound");
    const sealed = store("sealed-and-active");
    sealed.append([]); sealed.committed();
    fs.closeSync(sealed.fd); sealed.fd = null;
    fs.renameSync(sealed.journal, sealed.pending); sealed.pendingBytes = sealed.bytes;
    sealed.openJournal(); sealed.append([]); sealed.committed();
    let sealedCopies = 0;
    sealed.dispatchCheckpoint = async () => ({ bytes: 1, sequence: ++sealedCopies });
    const automatic = await sealed.checkpoint({ automatic: true });
    assert.equal(automatic.sequence, 1); assert.equal(sealedCopies, 1);
    assert.ok(fs.statSync(sealed.journal).size > 0, "automatic publication leaves the current journal for a newly gated job");
    const target = await sealed.checkpoint();
    assert.equal(target.sequence, 2, "explicit checkpoint still reaches its captured target");
    const low = store("low-space");
    low.append([]); low.committed();
    const journal = fs.readFileSync(low.journal);
    fs.writeFileSync(low.file + ".tmp", "abandoned staging"); fs.writeFileSync(low.file + ".tmp-journal", "abandoned rollback");
    free = 0;
    await assert.rejects(low.checkpoint({ automatic: true }), { code: "mail_checkpoint_low_space" });
    assert.deepEqual(fs.readFileSync(low.journal), journal); assert.equal(fs.existsSync(low.pending), false);
    assert.equal(fs.existsSync(low.file + ".tmp"), false); assert.equal(fs.existsSync(low.file + ".tmp-journal"), false);
    assert.ok(low.timerAt >= clock + 60000);
    await assert.rejects(low.checkpoint({ automatic: true }), { code: "mail_checkpoint_low_space" });
    assert.ok(low.timerAt >= clock + 120000, "repeated low-space failures postpone retries");
    low.dispatchCheckpoint = async () => ({ bytes: 1, sequence: low.sequence });
    const explicit = await low.checkpoint();
    assert.equal(explicit.sequence, low.sequence, "explicit checkpoints bypass advisory headroom and still reach their target");
    assert.equal(fs.existsSync(low.pending), false);
    const crashed = store("owned-staging");
    crashed.append([]); crashed.committed();
    fs.writeFileSync(crashed.file + ".tmp", "worker staging");
    const completion = crashed.dispatchCheckpoint();
    const rejection = assert.rejects(completion, /synthetic worker crash/);
    crashed.worker.emit("error", new Error("synthetic worker crash"));
    await flush(); assert.equal(fs.existsSync(crashed.file + ".tmp"), true);
    crashed.worker.emit("exit", 1); await rejection;
    assert.equal(fs.existsSync(crashed.file + ".tmp"), false); assert.ok(fs.existsSync(crashed.journal));
    assert.ok(records.some(row => row.stage === "storage.checkpoint"));
  } finally {
    await Promise.all(stores.map(value => value.close()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

(async () => {
  policyChecks(); progressChecks(); await backfillChecks(); await schedulerChecks();
  console.log("startup-preparation-ok: fixed phases, durable budgeted batches, startup/size/cost/age/headroom gating, retries and owned cleanup; no native dependencies");
})().catch(error => { console.error(error); process.exitCode = 1; });
