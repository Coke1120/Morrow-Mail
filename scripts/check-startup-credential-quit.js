const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const flush = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-startup-credential-quit-"));
  const names = ["MORROW_USER_DATA", "MORROW_MAIL_DIR", "MORROW_AI_CONFIG_DIR", "MORROW_MAIL_SECRETS", "ELECTRON_OVERRIDE_DIST_PATH"];
  const environment = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const configure = home => Object.assign(process.env, { MORROW_USER_DATA: home, MORROW_MAIL_DIR: home,
    MORROW_AI_CONFIG_DIR: home, MORROW_MAIL_SECRETS: "memory", ELECTRON_OVERRIDE_DIST_PATH: "/nonexistent" });
  configure(directory);
  const db = require("../host/mail/db"), engine = require("../host/mail/engine");
  const memory = require("../host/mail/memory-secrets"), secrets = require("../host/mail/secrets");
  const quitScheduled = require("../host/quit-scheduled");
  const { startupIndexProgressScript } = require("../host/startup-error");
  const main = fs.readFileSync(path.join(__dirname, "../host/main.js"), "utf8");
  const original = { get: memory.getPasswordAsync, fetch: global.fetch, connect: require("node:net").Socket.prototype.connect };
  let network = 0;
  global.fetch = async () => { network++; throw new Error("Network forbidden in synthetic startup test"); };
  require("node:net").Socket.prototype.connect = function () { network++; throw new Error("Socket forbidden in synthetic startup test"); };
  const watchdog = setTimeout(() => { throw new Error("Combined startup/credential/quit fixture stalled"); }, 110000);
  try {
    for (const [kind, answer] of [["before-quit", "stay"], ["window-close", undefined], ["window-close", "quit"]]) {
      const home = path.join(directory, kind + "-" + String(answer)); fs.mkdirSync(home);
      configure(home);
      const file = path.join(home, "mail.sqlite");
      await db.open(file);
      db.insertAccount({ id: "startup", email: "startup@example.invalid", username: "fixture", profile: "custom", authKind: "oauth2", createdAt: 1,
        imapHost: "imap.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.invalid", smtpPort: 465, smtpTls: true });
      db.insertScheduled({ id: "pending-startup", accountId: "startup", status: "pending", sendAt: Date.now() + 86400000, createdAt: 1,
        payloadJson: JSON.stringify({ subject: "Synthetic pending startup mail", to: ["recipient@example.invalid"], body: "Synthetic" }) });
      secrets.setPassword("startup", "synthetic-credential");
      await db.checkpoint(); await db.close();
      const scan = deferred(), entered = deferred(), choice = deferred(), events = new Map();
      memory.getPasswordAsync = account => { assert.equal(account, "startup"); entered.resolve(); return scan.promise; };
      const calls = { quit: 0, cleanup: 0, errors: 0, prompt: 0 };
      let window;
      const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
      const context = {
        interactiveBoot: true, bootWindow: null, bootFinished: false, bootFailed: false, bootCancelled: false, startupContinued: false,
        process: { env: {}, platform: process.platform }, console, startupIndexProgressScript,
        startupStatusHtml: () => "<html>synthetic startup</html>", initMail: () => engine.init(),
        presentBootFailure: async () => { calls.errors++; }, scheduledQuitTime: () => "synthetic time",
        requestQuitChoice(prompt) { calls.prompt++; assert.equal(prompt.count, 1); return choice.promise; },
        app: { on: (name, callback) => events.set(name, callback), quit() { calls.quit++; events.get("before-quit")(event()); },
          exit() { throw new Error("Unexpected synthetic exit"); } },
        quitScheduled,
        BrowserWindow: class {
          constructor() { this.listeners = new Map(); this.destroyed = false; window = this;
            this.webContents = { executeJavaScript: async () => {} }; }
          on(name, callback) { this.listeners.set(name, callback); }
          loadURL() { return Promise.resolve(); }
          show() {}
          isDestroyed() { return this.destroyed; }
          close() {
            if (this.destroyed) return false;
            const request = event(); this.listeners.get("close")?.(request);
            if (!request.prevented) { this.destroyed = true; this.listeners.get("closed")?.(); }
            return request.prevented;
          }
        },
        require(name) {
          if (name === "./mail/db") return db;
          if (name === "./mail/engine") return engine;
          if (name === "./bot/server") return { stop: async () => { calls.cleanup++; } };
          throw new Error("Unexpected combined startup dependency " + name);
        },
      };
      const ctx = vm.createContext(context);
      const listStart = main.indexOf("function listScheduledRows()");
      const quitStart = main.indexOf("const quitController = quitScheduled.createQuitController(");
      const statusStart = main.indexOf("async function presentBootStatus()");
      vm.runInContext(main.slice(listStart, main.indexOf("function shellCanPrompt", listStart))
        + main.slice(quitStart, main.indexOf('app.on("will-quit"', quitStart))
        + main.slice(statusStart, main.indexOf("async function presentBootFailure", statusStart)), ctx);
      await ctx.presentBootStatus();
      const flowStart = main.indexOf("  let lastIndexPaint = -Infinity;");
      const flow = main.slice(flowStart, main.indexOf('  if (process.env.MORROW_MAIL_SELFTEST', flowStart));
      const initializing = vm.runInContext("(async () => {" + flow + ";globalThis.startupContinued=true;})()", ctx);
      await Promise.race([entered.promise, initializing.then(() => { throw new Error("Startup did not reach its held credential scan"); })]);
      assert.equal(db.isReady(), true, "index opened before the held credential scan");
      assert.equal(db.scheduledById("pending-startup").status, "pending");
      if (kind === "window-close") assert.equal(window.close(), true);
      else { const request = event(); events.get("before-quit")(request); assert.equal(request.prevented, true); }
      await flush();
      assert.equal(calls.prompt, 1); assert.equal(ctx.bootCancelled, false);
      assert.equal(window.destroyed, false);
      choice.resolve(answer); await flush();
      if (answer === "quit") {
        assert.equal(ctx.bootCancelled, true); assert.equal(calls.cleanup, 1);
        assert.equal(db.isReady(), false, "accepted cleanup closes owned mail storage");
      } else {
        assert.equal(ctx.bootCancelled, false); assert.equal(calls.quit, 0); assert.equal(calls.cleanup, 0);
      }
      scan.resolve("synthetic-credential"); await initializing; await flush();
      assert.equal(ctx.startupContinued, answer !== "quit"); assert.equal(calls.errors, 0);
      if (answer === "quit") await db.open(file);
      assert.equal(db.scheduledById("pending-startup").status, "pending");
      assert.equal(secrets.getPassword("startup"), "synthetic-credential");
      assert.equal(network, 0);
      require("../host/mail/actions").resetForTests();
      await db.close(); secrets.deletePassword("startup");
    }
    console.log("startup-credential-quit-ok: actual engine/SQLite/held credential scan/pending scheduled mail; stay/dismiss/accepted window close; no live I/O");
  } finally {
    clearTimeout(watchdog); await db.close();
    if (original.get === undefined) delete memory.getPasswordAsync; else memory.getPasswordAsync = original.get;
    global.fetch = original.fetch; require("node:net").Socket.prototype.connect = original.connect;
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
