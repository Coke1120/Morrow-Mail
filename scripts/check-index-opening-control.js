const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const flush = () => new Promise(setImmediate);

async function bootControls(source = fs.readFileSync(path.join(__dirname, "../host/main.js"), "utf8")) {
  const { startupIndexProgressScript } = require("../host/startup-error");
  const realQuit = require("../host/quit-scheduled");
  async function fixture(pendingMail = true) {
    const load = deferred(), choice = deferred(), close = deferred(), events = new Map();
    const node = { hidden: true, textContent: "" };
    let window, progress, controller, now = 1000;
    const calls = { close: 0, quit: 0, errors: 0, paints: 0, prompts: 0, unsubscribed: 0 };
    const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
    const database = { subscribeIndexProgress(callback) { progress = callback; return () => { calls.unsubscribed++; }; },
      close() { calls.close++; return close.promise; } };
    const context = {
      interactiveBoot: true, bootWindow: null, bootFinished: false, bootFailed: false, bootCancelled: false, startupContinued: false,
      process: { env: {}, platform: process.platform }, console, Date: { now: () => now }, startupIndexProgressScript,
      startupStatusHtml: () => "<html>synthetic opening window</html>", initMail: () => load.promise,
      presentBootFailure: async () => { calls.errors++; context.bootFailed = true; }, onBootRejection() {},
      listScheduledRows: () => pendingMail ? [{ status: "pending", subject: "Synthetic scheduled mail", sendAt: "2026-11-01T00:00:00Z" }] : [],
      requestQuitChoice() { calls.prompts++; return choice.promise; }, scheduledQuitTime: () => "synthetic time",
      app: { on: (name, listener) => events.set(name, listener),
        quit() { calls.quit++; events.get("before-quit")(event()); }, exit() { throw new Error("Unexpected app exit"); } },
      quitScheduled: { createQuitController(options) { controller = realQuit.createQuitController(options); return controller; } },
      BrowserWindow: class {
        constructor(options) {
          assert.equal(options.webPreferences.sandbox, true);
          this.listeners = new Map(); this.destroyed = false; window = this;
          this.webContents = { executeJavaScript(script) {
            calls.paints++;
            vm.runInNewContext(script, { document: { getElementById: () => node } });
            return Promise.resolve();
          } };
        }
        on(name, callback) { this.listeners.set(name, callback); }
        loadURL(url) { assert.match(url, /^data:text\/html/); return Promise.resolve(); }
        isDestroyed() { return this.destroyed; }
        show() {}
        close() {
          if (this.destroyed) return false;
          const request = event(); this.listeners.get("close")?.(request);
          if (!request.prevented) { this.destroyed = true; this.listeners.get("closed")?.(); }
          return request.prevented;
        }
      },
      require(name) {
        if (name === "./mail/db") return database;
        if (name === "./bot/server") return { stop: async () => {} };
        if (name === "./mail/engine") return { stopIdle: async () => {} };
        throw new Error("Unexpected boot-fixture dependency " + name);
      },
    };
    const ctx = vm.createContext(context);
    const quitStart = source.indexOf("const quitController = quitScheduled.createQuitController(");
    vm.runInContext(source.slice(quitStart, source.indexOf('app.on("will-quit"', quitStart)), ctx);
    const statusStart = source.indexOf("async function presentBootStatus()");
    vm.runInContext(source.slice(statusStart, source.indexOf("async function presentBootFailure", statusStart)), ctx);
    await ctx.presentBootStatus();
    const flowStart = source.indexOf("  let lastIndexPaint = -Infinity;");
    const flow = source.slice(flowStart, source.indexOf('  if (process.env.MORROW_MAIL_SELFTEST', flowStart));
    const task = vm.runInContext("(async () => {" + flow + ";globalThis.startupContinued = true;})()", ctx);
    return { ctx, task, load, choice, close, calls, window, controller, node,
      paint: value => progress(value), advance: ms => { now += ms; },
      request(kind) {
        if (kind === "window-close") return window.close();
        const request = event(); events.get("before-quit")(request); return request.prevented;
      } };
  }

  // Delayed initialization represents the credential scan after index readiness.
  // The real quit controller must not cancel startup while a prompt is undecided,
  // declined or dismissed, including a close attempt on the opening window.
  for (const kind of ["before-quit", "window-close"]) {
    for (const answer of ["stay", undefined, "dismiss-error"]) {
      const f = await fixture();
      assert.equal(f.request(kind), true);
      assert.equal(f.ctx.bootCancelled, false, "an undecided quit request is not startup cancellation");
      assert.equal(f.window.destroyed, false);
      await flush(); assert.equal(f.calls.prompts, 1);
      if (answer === "dismiss-error") f.choice.reject(new Error("Synthetic dismissed dialog")); else f.choice.resolve(answer);
      await flush();
      assert.equal(f.ctx.bootCancelled, false); assert.equal(f.controller.cleaning, false);
      assert.equal(f.calls.quit, 0); assert.equal(f.calls.close, 0);
      f.load.resolve(); await f.task;
      assert.equal(f.ctx.startupContinued, true, "Stay open/dismissal must let initialization open the shell");
      assert.equal(f.calls.errors, 0); assert.equal(f.calls.unsubscribed, 1);
    }
  }
  for (const kind of ["before-quit", "window-close"]) {
    for (const outcome of ["success", "failure"]) {
      const f = await fixture();
      f.request(kind); await flush();
      assert.equal(f.ctx.bootCancelled, false);
      f.choice.resolve("quit"); await flush();
      assert.equal(f.controller.cleaning, true); assert.equal(f.ctx.bootCancelled, true);
      assert.equal(f.calls.close, 1); assert.equal(f.calls.quit, 1, "final quit waits for owned storage cleanup");
      if (outcome === "success") f.load.resolve(); else f.load.reject(new Error("Synthetic canceled initialization"));
      await f.task;
      assert.equal(f.ctx.startupContinued, false); assert.equal(f.calls.errors, 0);
      f.close.resolve(); await flush();
      assert.ok(f.calls.quit >= 2); assert.equal(f.window.close(), false); assert.equal(f.window.destroyed, true);
    }
  }

  const progress = await fixture(false);
  progress.paint({ phase: "building", completed: 10, total: 100, resumed: false });
  assert.match(progress.node.textContent, /10 of 100/);
  progress.paint({ phase: "building", completed: 20, total: 100 }); assert.equal(progress.calls.paints, 1);
  progress.advance(100); progress.paint({ phase: "building", completed: 20, total: 100 });
  progress.paint({ phase: "ready", completed: 100, total: 100 });
  assert.equal(progress.calls.paints, 3); assert.equal(progress.node.textContent, "Local search is ready.");
  progress.request("window-close"); await flush();
  assert.equal(progress.ctx.bootCancelled, true); assert.equal(progress.calls.close, 1);
  progress.load.resolve(); await progress.task; assert.equal(progress.ctx.startupContinued, false);
  progress.close.resolve(); await flush(); progress.window.close();
  progress.paint({ phase: "building", completed: 30, total: 100 }); assert.equal(progress.calls.paints, 3);

  const failed = await fixture();
  failed.load.reject(new Error("Synthetic genuine startup failure")); await failed.task;
  assert.equal(failed.calls.errors, 1); assert.equal(failed.ctx.bootCancelled, false);
  const ordinary = await fixture();
  ordinary.load.resolve(); await ordinary.task; ordinary.ctx.bootFinished = true;
  ordinary.request("before-quit"); await flush(); ordinary.choice.resolve("quit"); await flush();
  assert.equal(ordinary.ctx.startupContinued, true); assert.equal(ordinary.ctx.bootCancelled, false);
  assert.equal(ordinary.calls.close, 0, "ordinary quit retains its existing cleanup behavior");
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
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
module.exports = { run, bootControls };
