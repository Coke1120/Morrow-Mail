"use strict";
// Hourly update discovery and the rail attention flag. Provider and DOM are fakes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function loadUpdater(platform, packaged = true) {
  const timers = [];
  const intervals = [];
  const sent = [];
  const stats = { checks: 0, installs: 0 };
  const events = {};
  const handlers = {};
  let hold = null;
  const mac = { checks: 0, finish: null };
  const browser = {
    getAllWindows() { return []; },
  };
  const provider = {
    on(name, fn) { events[name] = fn; },
    setFeedURL() {},
    quitAndInstall() { stats.installs += 1; },
    checkForUpdates() {
      stats.checks += 1;
      if (events["checking-for-update"]) events["checking-for-update"]();
      if (hold) return hold;
      if (events["update-not-available"]) events["update-not-available"]();
      return Promise.resolve(null);
    },
  };
  const sandbox = {
    module: { exports: {} },
    console,
    Date,
    Promise,
    setTimeout(fn, ms) {
      const entry = {
        ms,
        unref() {},
        fn() {
          const index = timers.indexOf(entry);
          if (index >= 0) timers.splice(index, 1);
          fn();
        },
      };
      timers.push(entry);
      return entry;
    },
    clearTimeout(id) {
      const index = timers.indexOf(id);
      if (index >= 0) timers.splice(index, 1);
    },
    setInterval(fn, ms) {
      const entry = { fn, ms, unref() {} };
      intervals.push(entry);
      return entry;
    },
    clearInterval(id) {
      const index = intervals.indexOf(id);
      if (index >= 0) intervals.splice(index, 1);
    },
    require(name) {
      if (name === "electron") {
        return {
          app: { isPackaged: packaged },
          ipcMain: { handle(channel, fn) { handlers[channel] = fn; } },
          BrowserWindow: browser,
        };
      }
      if (name === "node:process") return { platform };
      if (name === "electron-updater") return { autoUpdater: provider };
      if (name === "./update-auth") {
        return {
          githubFeed: () => ({ provider: "github", owner: "Coke1120", repo: "Morrow-Mail", private: false }),
          explainUpdateError: (err) => (err && err.message) || String(err || ""),
        };
      }
      if (name === "./update-macos") {
        return {
          createMacUpdater({ state }) {
            let pending = null;
            return {
              init() {
                state.enabled = true;
                state.platform = "darwin";
                return { enabled: true };
              },
              configure() {},
              check() {
                if (!pending) {
                  mac.checks += 1;
                  state.checking = true;
                  pending = new Promise((resolve) => {
                    mac.finish = () => {
                      state.checking = false;
                      state.available = true;
                      state.version = "9.9.9";
                      state.lastCheckedAt = new Date().toISOString();
                      pending = null;
                      resolve({ ...state });
                    };
                  });
                }
                return pending;
              },
              snapshot() { return { ...state }; },
              refreshStatus() { return Promise.resolve({ ...state }); },
              manual() { return Promise.resolve({ ...state }); },
              install() { return Promise.resolve({ ...state }); },
            };
          },
        };
      }
      throw new Error("Unexpected dependency " + name);
    },
  };
  vm.runInNewContext(
    fs.readFileSync(require.resolve("../host/updater"), "utf8"),
    sandbox,
    { filename: "updater.js" },
  );
  return { updater: sandbox.module.exports, timers, intervals, sent, stats, events, handlers, provider, browser, mac, hold: (promise) => { hold = promise; } };
}

function node() {
  const el = { textContent: "", hidden: false, disabled: false, attrs: {}, classFlags: {} };
  el.classList = { toggle(name, on) { el.classFlags[name] = on !== false; } };
  el.setAttribute = (name, value) => { el.attrs[name] = value; };
  return el;
}

async function checkWindows() {
  const env = loadUpdater("win32");
  const { updater, timers, intervals, stats, events, handlers, provider } = env;
  updater.init();
  updater.registerIpc();
  assert.equal(updater.CHECK_INTERVAL_MS, 60 * 60 * 1000);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, updater.CHECK_INTERVAL_MS);
  assert.equal(timers.filter((entry) => entry.ms === 4000).length, 1);
  assert.equal(provider.autoDownload, true);
  assert.equal(provider.autoInstallOnAppQuit, false);
  assert.equal(updater.state.requiresExplicitInstall, true);
  assert.equal(stats.installs, 0);
  assert.equal(stats.checks, 0);

  timers.find((entry) => entry.ms === 4000).fn();
  await flush();
  assert.equal(stats.checks, 1, "startup uses the manual check path");

  intervals[0].fn();
  await flush();
  assert.equal(stats.checks, 2, "the hourly tick checks when idle");

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  env.hold(gate);
  const first = updater.requestCheck();
  const second = updater.requestCheck({ periodic: true });
  intervals[0].fn();
  assert.equal(first, second);
  assert.equal(stats.checks, 3, "an in-flight check is not started again");
  events["update-not-available"]();
  release(null);
  await first;
  await flush();
  assert.equal(stats.checks, 3);
  assert.equal(stats.installs, 0);

  updater.state.downloading = true;
  const duringDownload = stats.checks;
  const skipped = await updater.requestCheck();
  assert.equal(stats.checks, duringDownload);
  assert.equal(skipped.downloading, true);
  updater.state.downloading = false;
  updater.state.installing = true;
  await updater.requestCheck({ periodic: true });
  assert.equal(stats.checks, duringDownload);
  updater.state.installing = false;

  env.hold(null);
  updater.state.checking = true;
  await handlers["host:updateCheck"]();
  await flush();
  assert.equal(stats.checks, duringDownload + 1, "a finished check can run again");

  updater.state.enabled = false;
  updater.state.checking = false;
  const paused = stats.checks;
  await updater.requestCheck({ periodic: true });
  assert.equal(stats.checks, paused, "hourly discovery waits until the updater is enabled");
  await updater.requestCheck();
  await flush();
  assert.equal(stats.checks, paused + 1, "Check for updates still runs");

  const sent = [];
  env.browser.getAllWindows = () => [
    { isDestroyed: () => false, webContents: { isDestroyed: () => false, send(channel, payload) { sent.push({ channel, payload }); } } },
    { isDestroyed: () => true, webContents: { send() { throw new Error("closed"); } } },
  ];
  events["update-available"]({ version: "9.9.9" });
  assert.equal(updater.state.available, true);
  assert.equal(updater.state.version, "9.9.9");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "host:updateState");
  assert.equal(sent[0].payload.version, "9.9.9");
  events["download-progress"]({ percent: 40 });
  assert.equal(sent.length, 1, "progress does not push on every byte");
  const progress = timers.find((entry) => entry.ms === 1000);
  assert.ok(progress);
  progress.fn();
  assert.equal(sent.at(-1).payload.downloading, true);
  assert.equal(sent.at(-1).payload.progress, 40);
  events["update-downloaded"]({ version: "9.9.9" });
  assert.equal(updater.state.downloaded, true);
  assert.equal(updater.state.downloading, false);
  events["update-not-available"]();
  assert.equal(updater.state.available, false);
  assert.equal(updater.state.downloaded, true, "a ready download stays ready after a later check");
  events.error(new Error("Offline fixture"));
  assert.equal(updater.state.checking, false);
  assert.equal(updater.state.error, "Offline fixture");
  assert.equal(stats.installs, 0);

  env.browser.getAllWindows = () => { throw new Error("no windows"); };
  await updater.requestCheck();
  await flush();
  updater.stopPeriodicCheck();
  assert.equal(intervals.length, 0);
  assert.equal(timers.some((entry) => entry.ms === 4000), false);
  updater.stopPeriodicCheck();
  updater.init();
  assert.equal(intervals.length, 1, "starting again replaces the hourly timer");
  updater.stopPeriodicCheck();
}

async function checkDarwin() {
  const env = loadUpdater("darwin");
  const { updater, intervals, timers, mac } = env;
  const initial = updater.init();
  assert.equal(initial.enabled, true);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, updater.CHECK_INTERVAL_MS);
  assert.equal(timers.filter((entry) => entry.ms === 4000).length, 1);
  const first = updater.requestCheck({ periodic: true });
  const second = updater.requestCheck();
  intervals[0].fn();
  assert.equal(first, second);
  assert.equal(mac.checks, 1);
  mac.finish();
  const snap = await first;
  await flush();
  assert.equal(snap.available, true);
  assert.equal(snap.version, "9.9.9");
  updater.state.downloading = true;
  const again = await updater.requestCheck({ periodic: true });
  assert.equal(mac.checks, 1);
  assert.equal(again.downloading, true);
  updater.stopPeriodicCheck();
  assert.equal(intervals.length, 0);
  assert.equal(timers.some((entry) => entry.ms === 4000), false);
}

function checkBadgePaint() {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  };
  const { renderer } = require("./check-ux-workflows");
  const ui = renderer({ document: { getElementById: get } });
  const paint = (source) => ui.run(`paintUpdate(updateView(${source}, "0.2.31"))`);
  paint(`{ available: true, version: "9.9.9" }`);
  assert.equal(get("update-attention").hidden, false);
  assert.equal(get("rail-about").attrs["aria-label"], "About & updates, update available");
  assert.equal(get("rail-about").attrs["data-label"], "About & updates, update available");
  assert.equal(get("rail-about").classFlags["has-update"], true);
  paint(`{ checking: true }`);
  assert.equal(get("update-attention").hidden, true);
  assert.equal(get("rail-about").attrs["aria-label"], "About & updates");
  paint(`{ error: "offline", downloaded: true }`);
  assert.equal(get("update-attention").hidden, true);
  paint(`{ downloaded: true, version: "9.9.9" }`);
  assert.equal(get("update-attention").hidden, false);
  assert.equal(get("about-update-install").hidden, false);
  paint(`{ downloading: true, progress: 15 }`);
  assert.equal(get("update-attention").hidden, false);
  paint(`{}`);
  assert.equal(get("update-attention").hidden, true);
}

function checkSources() {
  const root = path.join(__dirname, "..");
  const updater = fs.readFileSync(path.join(root, "host/updater.js"), "utf8");
  const main = fs.readFileSync(path.join(root, "host/main.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "renderer/app.css"), "utf8");
  const preload = fs.readFileSync(path.join(root, "renderer/preload.js"), "utf8");
  assert.match(main, /will-quit[\s\S]{0,180}stopPeriodicCheck/);
  assert.match(updater, /CHECK_INTERVAL_MS = 60 \* 60 \* 1000/);
  assert.match(updater, /autoInstallOnAppQuit = false/);
  assert.doesNotMatch(updater, /autoInstallOnAppQuit = true/);
  assert.ok(html.includes('id="update-attention"') && html.includes(">!</span>"));
  assert.ok(css.includes(".update-attention") && css.includes("#e10600"));
  assert.ok(preload.includes('"host:updateState"'));
}

async function checkUnpackaged() {
  const env = loadUpdater("win32", false);
  const snap = env.updater.init();
  assert.equal(snap.enabled, false);
  assert.equal(env.intervals.length, 0);
  assert.equal(env.timers.length, 0);
  const again = await env.updater.requestCheck();
  assert.equal(env.stats.checks, 0);
  assert.equal(again.enabled, false);
}

(async () => {
  await checkWindows();
  await checkDarwin();
  await checkUnpackaged();
  checkBadgePaint();
  checkSources();
  console.log("update-schedule-ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
