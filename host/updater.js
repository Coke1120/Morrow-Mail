const { app, ipcMain, BrowserWindow } = require("electron");
const auth = require("./update-auth");
const { platform } = require("node:process");

// Hourly discovery uses the same check as the About button. It does not install.
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const STARTUP_CHECK_DELAY_MS = 4000;

const state = {
  platform,
  checking: false,
  lastCheckedAt: null,
  lastAttemptAt: null,
  available: false,
  downloading: false,
  downloaded: false,
  version: null,
  progress: 0,
  error: null,
  installing: false,
  enabled: false,
  needsToken: false,
  channel: "prerelease",
};

let autoUpdater = null;
let listenersBound = false;
let macUpdater = null;
let installLifecycle = null;
let installing = null;
let resumeInstall = null;
let installTimer = null;
let hourlyTimer = null;
let startupTimer = null;
let checkFlight = null;
let progressTimer = null;
function resumeAfterFailedInstall() {
  if (installTimer) clearTimeout(installTimer);
  installTimer = null;
  const resume = resumeInstall;
  resumeInstall = null;
  if (resume) resume();
}
function signedMacUpdater() {
  if (!macUpdater) macUpdater = require("./update-macos").createMacUpdater({ app, state });
  if (installLifecycle) macUpdater.configure(installLifecycle);
  return macUpdater;
}
function configureInstall(lifecycle) { installLifecycle = lifecycle; }
function authorizeInstall(event) {
  const win = installLifecycle && installLifecycle.getWindow();
  if (!win || win.isDestroyed() || !event || event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame) {
    throw new Error("Update installation is only available from the main application window.");
  }
}

function snapshot() {
  return { ...state };
}

function publish() {
  if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== "function") return;
  const snap = snapshot();
  let windows = [];
  try { windows = BrowserWindow.getAllWindows(); } catch { return; }
  for (const win of windows) {
    try {
      if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) continue;
      const contents = win.webContents;
      if (!contents || (typeof contents.isDestroyed === "function" && contents.isDestroyed())) continue;
      contents.send("host:updateState", snap);
    } catch { /* the page is already gone */ }
  }
}

function publishProgress() {
  if (progressTimer || typeof setTimeout !== "function") return;
  progressTimer = setTimeout(() => {
    progressTimer = null;
    publish();
  }, 1000);
  if (progressTimer && typeof progressTimer.unref === "function") progressTimer.unref();
}

function setError(err) {
  resumeAfterFailedInstall();
  state.error = auth.explainUpdateError(err);
  state.checking = false;
  state.downloading = false;
  state.installing = false;
  if (!state.downloaded) state.available = false;
  state.needsToken = false;
  publish();
}

function applyFeed(updater) {
  updater.setFeedURL(auth.githubFeed());
}

function prepareUpdater() {
  state.needsToken = false;
  if (!autoUpdater) {
    ({ autoUpdater } = require("electron-updater"));
    autoUpdater.autoDownload = true;
    // A normal quit must not bypass renderer consent and draining writes.
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = true;
    bind(autoUpdater);
  }
  applyFeed(autoUpdater);
  state.enabled = true;
  state.requiresExplicitInstall = true;
  state.error = null;
  return autoUpdater;
}

function bind(updater) {
  if (listenersBound) return;
  listenersBound = true;
  updater.on("checking-for-update", () => {
    state.checking = true;
    state.lastAttemptAt = new Date().toISOString();
    state.error = null;
    state.needsToken = false;
    publish();
  });
  updater.on("update-available", (info) => {
    state.lastCheckedAt = new Date().toISOString();
    state.checking = false;
    state.available = true;
    state.needsToken = false;
    state.version = info && info.version ? info.version : null;
    publish();
  });
  updater.on("update-not-available", () => {
    state.lastCheckedAt = new Date().toISOString();
    state.checking = false;
    state.available = false;
    state.needsToken = false;
    publish();
  });
  updater.on("download-progress", (p) => {
    state.downloading = true;
    state.progress = p && typeof p.percent === "number" ? p.percent : state.progress;
    publishProgress();
  });
  updater.on("update-downloaded", (info) => {
    state.downloading = false;
    state.downloaded = true;
    state.version = info && info.version ? info.version : state.version;
    publish();
  });
  updater.on("error", (err) => setError(err));
}

function clearHourlyTimer() {
  if (hourlyTimer && typeof clearInterval === "function") clearInterval(hourlyTimer);
  hourlyTimer = null;
}

function stopPeriodicCheck() {
  clearHourlyTimer();
  if (startupTimer && typeof clearTimeout === "function") clearTimeout(startupTimer);
  startupTimer = null;
  if (progressTimer && typeof clearTimeout === "function") clearTimeout(progressTimer);
  progressTimer = null;
}

function scheduleStartupCheck() {
  if (typeof setTimeout !== "function") return;
  if (startupTimer && typeof clearTimeout === "function") clearTimeout(startupTimer);
  startupTimer = setTimeout(() => {
    startupTimer = null;
    requestCheck().catch(() => {});
  }, STARTUP_CHECK_DELAY_MS);
  if (startupTimer && typeof startupTimer.unref === "function") startupTimer.unref();
}

function startPeriodicCheck() {
  clearHourlyTimer();
  if (typeof setInterval !== "function") return;
  hourlyTimer = setInterval(() => {
    requestCheck({ periodic: true }).catch(() => {});
  }, CHECK_INTERVAL_MS);
  if (hourlyTimer && typeof hourlyTimer.unref === "function") hourlyTimer.unref();
}

async function runCheck() {
  if (platform === "darwin") return signedMacUpdater().check();
  const updater = prepareUpdater();
  state.checking = true;
  state.error = null;
  publish();
  await updater.checkForUpdates();
  return snapshot();
}

// One check at a time. A download or install already running is left alone.
// state.checking alone does not block: a finished check can leave that flag set
// until the provider emits a terminal event, and Check must still run again.
function requestCheck(options) {
  if (!app.isPackaged) return Promise.resolve(snapshot());
  if (checkFlight) return checkFlight;
  if (state.downloading || state.installing) return Promise.resolve(snapshot());
  if (options && options.periodic && state.enabled === false) return Promise.resolve(snapshot());
  let settle;
  const flight = new Promise((resolve) => { settle = resolve; });
  checkFlight = flight;
  runCheck().then(
    (snap) => {
      if (checkFlight === flight) checkFlight = null;
      settle(snap || snapshot());
    },
    (err) => {
      setError(err);
      if (checkFlight === flight) checkFlight = null;
      settle(snapshot());
    },
  ).finally(() => { publish(); });
  return flight;
}

function init() {
  // Dev / unpackaged: keep stub state so the shell update:getState stays safe.
  if (!app.isPackaged) {
    state.enabled = false;
    state.needsToken = false;
    stopPeriodicCheck();
    return snapshot();
  }
  if (platform === "darwin") {
    const mac = signedMacUpdater();
    const initial = mac.init();
    if (initial.enabled) scheduleStartupCheck();
    startPeriodicCheck();
    return initial;
  }
  try {
    prepareUpdater();
    scheduleStartupCheck();
  } catch (err) {
    setError(err);
    state.enabled = false;
  }
  startPeriodicCheck();
  return snapshot();
}

function registerIpc() {
  ipcMain.handle("host:updateGetState", () => platform === "darwin" && app.isPackaged ? signedMacUpdater().refreshStatus() : snapshot());
  ipcMain.handle("host:updateCheck", () => requestCheck());
  ipcMain.handle("host:updateManual", (event) => {
    if (platform !== "darwin") return snapshot();
    authorizeInstall(event);
    return signedMacUpdater().manual();
  });
  ipcMain.handle("host:updateInstall", (event) => {
    authorizeInstall(event);
    if (platform === "darwin") {
      return signedMacUpdater().install();
    }
    if (!autoUpdater || !state.downloaded || state.installing) return installing || snapshot();
    installing = (async () => {
      state.installing = true;
      state.error = null;
      try {
        resumeInstall = await installLifecycle.prepare();
        if (!state.installing) { resumeAfterFailedInstall(); return snapshot(); }
        // electron-updater can emit error synchronously instead of throwing.
        autoUpdater.quitAndInstall(false, true);
        if (state.installing) {
          installTimer = setTimeout(() => setError(new Error("The app did not exit for the update. Finish active work and retry.")), 120000);
          if (installTimer.unref) installTimer.unref();
        }
      } catch (err) { setError(err); }
      return snapshot();
    })().finally(() => { installing = null; });
    return installing;
  });
}

const CHANNELS = ["host:updateGetState", "host:updateCheck", "host:updateInstall", "host:updateManual"];

module.exports = {
  init, registerIpc, snapshot, state, CHANNELS, configureInstall,
  startPeriodicCheck, stopPeriodicCheck, requestCheck, CHECK_INTERVAL_MS,
};
