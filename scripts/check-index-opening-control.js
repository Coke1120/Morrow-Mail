const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const flush = () => new Promise(setImmediate);

async function bootControls() {
  const source = fs.readFileSync(path.join(__dirname, "../host/main.js"), "utf8");
  const { startupIndexProgressScript } = require("../host/startup-error");
  let currentWindow, progress, now = 1000, unsubscribed = 0, errors = 0, quit = 0, paints = 0;
  const node = { hidden: true, textContent: "" };
  const load = deferred(), close = deferred();
  let closeCalls = 0;
  const database = { subscribeIndexProgress(callback) { progress = callback; return () => { unsubscribed++; }; },
    close() { closeCalls++; return close.promise; } };
  const events = new Map();
  let quitOptions;
  const context = {
    interactiveBoot: true, bootWindow: null, bootFinished: false, bootFailed: false, bootCancelled: false,
    startupContinued: false,
    process: { env: {} }, console, Date: { now: () => now }, startupIndexProgressScript,
    startupStatusHtml: () => "<html>synthetic opening window</html>",
    initMail: () => load.promise, presentBootFailure: async () => { errors++; },
    onBootRejection() {}, listScheduledRows() {}, requestQuitChoice() {}, scheduledQuitTime() {},
    app: { on: (name, listener) => events.set(name, listener), quit() { quit++; }, exit() { throw new Error("Unexpected app exit"); } },
    quitScheduled: { createQuitController(options) { quitOptions = options; return { onBeforeQuit() {} }; } },
    BrowserWindow: class {
      constructor(options) {
        assert.equal(options.webPreferences.sandbox, true);
        this.listeners = new Map(); this.destroyed = false; currentWindow = this;
        this.webContents = { executeJavaScript(script) {
          paints++;
          vm.runInNewContext(script, { document: { getElementById: () => node } });
          return Promise.resolve();
        } };
      }
      on(name, callback) { this.listeners.set(name, callback); }
      loadURL(url) { assert.match(url, /^data:text\/html/); return Promise.resolve(); }
      isDestroyed() { return this.destroyed; }
      show() {}
    },
    require(name) {
      if (name === "./mail/db") return database;
      if (name === "./bot/server") return { stop: async () => {} };
      if (name === "./mail/engine") return { stopIdle: async () => {} };
      throw new Error("Unexpected boot-fixture dependency " + name);
    },
  };
  const ctx = vm.createContext(context);
  const statusStart = source.indexOf("async function presentBootStatus()");
  vm.runInContext(source.slice(statusStart, source.indexOf("async function presentBootFailure", statusStart)), ctx);
  await ctx.presentBootStatus();
  const flowStart = source.indexOf("  let lastIndexPaint = -Infinity;");
  const flow = source.slice(flowStart, source.indexOf('  if (process.env.MORROW_MAIL_SELFTEST', flowStart));
  const start = () => vm.runInContext("(async () => {" + flow + ";globalThis.startupContinued = true;})()", ctx);
  const pending = start();
  progress({ phase: "building", completed: 10, total: 100, resumed: false });
  assert.match(node.textContent, /10 of 100/);
  progress({ phase: "building", completed: 20, total: 100, resumed: false });
  assert.equal(paints, 1, "intermediate progress paints are throttled");
  now += 100;
  progress({ phase: "building", completed: 20, total: 100, resumed: false });
  assert.equal(paints, 2);
  progress({ phase: "ready", completed: 100, total: 100, resumed: false });
  assert.equal(paints, 3, "final progress bypasses the throttle");
  assert.equal(node.textContent, "Local search is ready.");
  currentWindow.destroyed = true; currentWindow.listeners.get("closed")();
  assert.equal(ctx.bootCancelled, true); assert.equal(quit, 1);
  progress({ phase: "building", completed: 30, total: 100 });
  assert.equal(paints, 3, "a closed opening window receives no later paints");
  load.resolve(); await pending;
  assert.equal(ctx.startupContinued, false, "late successful initialization cannot continue after startup quit");
  assert.equal(unsubscribed, 1);

  // The actual startup catch suppresses an intentional cancellation only.
  const failed = deferred();
  ctx.initMail = () => failed.promise;
  const cancelled = start();
  failed.resolve(Promise.reject(new Error("Synthetic cancelled startup")));
  await cancelled; assert.equal(errors, 0);
  ctx.bootCancelled = false;
  ctx.initMail = () => Promise.reject(new Error("Synthetic real startup failure"));
  await start();
  assert.equal(errors, 1); assert.equal(unsubscribed, 3);
  await ctx.presentBootStatus();
  ctx.initMail = () => Promise.resolve();
  await start();
  assert.equal(ctx.startupContinued, true, "uncancelled startup still continues");
  assert.equal(unsubscribed, 4);

  const quitStart = source.indexOf("const quitController = quitScheduled.createQuitController(");
  vm.runInContext(source.slice(quitStart, source.indexOf('app.on("will-quit"', quitStart)), ctx);
  ctx.bootCancelled = false; events.get("before-quit")({});
  assert.equal(ctx.bootCancelled, true);
  let settled = false;
  const cleanup = quitOptions.cleanup().then(() => { settled = true; });
  await flush(); assert.equal(closeCalls, 1); assert.equal(settled, false);
  close.resolve(); await cleanup;
  ctx.bootFinished = true;
  await quitOptions.cleanup(); assert.equal(closeCalls, 1, "ordinary quit retains its existing cleanup behavior");
}

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
  await bootControls();
  console.log("index-opening-control-ok: join/conflict/admission/abort/late-load/boot-throttle/quit/failure/progress; synthetic storage/window only");
}

if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
