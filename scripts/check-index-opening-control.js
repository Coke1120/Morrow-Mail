const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const flush = () => new Promise(setImmediate);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function run() {
  const stores = [];
  class Persistence {
    constructor(file) { this.file = file; this.loaded = deferred(); this.closed = 0; stores.push(this); }
    open() { return this.loaded.promise; }
    close() { this.closed++; return Promise.resolve(); }
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../host/mail/db.js"), "utf8"), {
    module, setImmediate,
    require(name) {
      if (name === "./persistence") return { Persistence };
      if (name === "crypto" || name === "node:perf_hooks") return require(name);
      if (name === "../../shared/primary-mailboxes" || name === "./sender-header") return {};
      if (name === "../performance-diagnostics") return { sync: (_stage, work) => work(), measure: (_stage, work) => work() };
      throw new Error("Unexpected control-fixture dependency " + name);
    },
  });
  const db = module.exports;
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(db.open("never-created", { signal: stopped.signal }), { code: "mail_open_cancelled" });
  assert.equal(stores.length, 0);
  const opening = db.open("fixture");
  const rejection = assert.rejects(opening, { code: "mail_open_cancelled" });
  assert.equal(db.open("fixture"), opening);
  await assert.rejects(db.open("different-fixture"), { code: "mail_open_busy" });
  assert.equal(db.isReady(), false);
  assert.throws(() => db.listAccountRows(), { code: "mail_not_ready" });
  assert.throws(() => db.updateMessage("fixture", { subject: "must not write" }), { code: "mail_not_ready" });
  await flush(); assert.equal(stores.length, 1);
  const closing = db.close();
  let closed = 0;
  stores[0].loaded.resolve({ close() { closed++; }, run() { throw new Error("Cancelled opening must not migrate"); } });
  await rejection; await closing;
  assert.equal(closed, 1); assert.equal(stores[0].closed, 1); assert.equal(db.isReady(), false);
  const abort = new AbortController();
  const other = db.open("second", { signal: abort.signal });
  const aborted = assert.rejects(other, { code: "mail_open_cancelled" });
  await flush(); abort.abort();
  stores[1].loaded.resolve({ close() { closed++; }, run() { throw new Error("Aborted opening must not migrate"); } });
  await aborted;
  assert.equal(closed, 2); assert.equal(stores[1].closed, 1); assert.equal(db.isReady(), false);

  const { startupIndexProgressScript } = require("../host/startup-error");
  const node = { hidden: true, textContent: "" };
  const document = { getElementById: () => node };
  vm.runInNewContext(startupIndexProgressScript({ phase: "building", completed: 2, total: 10, resumed: true }), { document });
  assert.equal(node.hidden, false); assert.match(node.textContent, /Resuming local search: 2 of 10 saved messages/);
  vm.runInNewContext(startupIndexProgressScript({ phase: "building", completed: 10, total: 10 }), { document });
  assert.equal(node.textContent, "Finishing local search checks…");
  vm.runInNewContext(startupIndexProgressScript({ phase: "ready", completed: 10, total: 10 }), { document });
  assert.equal(node.textContent, "Local search is ready.");
  assert.equal(startupIndexProgressScript({ phase: "unexpected private payload" }), "");
  console.log("index-opening-control-ok: join/conflict/admission/abort/late-load cleanup/progress; synthetic storage only");
}

if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
