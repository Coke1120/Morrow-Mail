const { app, ipcMain } = require("electron");
const auth = require("./update-auth");
const { platform } = require("node:process");

const state = {
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

function setError(err) {
  state.error = auth.explainUpdateError(err);
  state.checking = false;
  state.downloading = false;
  state.installing = false;
  if (!state.downloaded) state.available = false;
  state.needsToken = false;
}

function applyFeed(updater) {
  updater.setFeedURL(auth.githubFeed());
}

function prepareUpdater() {
  state.needsToken = false;
  if (!autoUpdater) {
    ({ autoUpdater } = require("electron-updater"));
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = true;
    bind(autoUpdater);
  }
  applyFeed(autoUpdater);
  state.enabled = true;
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
  });
  updater.on("update-available", (info) => {
    state.lastCheckedAt = new Date().toISOString();
    state.checking = false;
    state.available = true;
    state.needsToken = false;
    state.version = info && info.version ? info.version : null;
  });
  updater.on("update-not-available", () => {
    state.lastCheckedAt = new Date().toISOString();
    state.checking = false;
    state.available = false;
    state.needsToken = false;
  });
  updater.on("download-progress", (p) => {
    state.downloading = true;
    state.progress = p && typeof p.percent === "number" ? p.percent : state.progress;
  });
  updater.on("update-downloaded", (info) => {
    state.downloading = false;
    state.downloaded = true;
    state.version = info && info.version ? info.version : state.version;
  });
  updater.on("error", (err) => setError(err));
}

function init() {
  // Dev / unpackaged: keep stub state so the shell update:getState stays safe.
  if (!app.isPackaged) {
    state.enabled = false;
    state.needsToken = false;
    return snapshot();
  }
  if (platform === "darwin") {
    const mac = signedMacUpdater();
    const initial = mac.init();
    if (initial.enabled) setTimeout(() => { mac.check(); }, 4000);
    return initial;
  }
  try {
    const updater = prepareUpdater();
    if (!updater) return snapshot();
    setTimeout(() => {
      updater.checkForUpdates().catch((err) => setError(err));
    }, 4000);
  } catch (err) {
    setError(err);
    state.enabled = false;
  }
  return snapshot();
}

function registerIpc() {
  ipcMain.handle("host:updateGetState", () => platform === "darwin" && app.isPackaged ? signedMacUpdater().refreshStatus() : snapshot());
  ipcMain.handle("host:updateCheck", async () => {
    if (!app.isPackaged) return snapshot();
    if (platform === "darwin") return signedMacUpdater().check();
    try {
      const updater = prepareUpdater();
      if (!updater) return snapshot();
      state.checking = true;
      state.error = null;
      await updater.checkForUpdates();
    } catch (err) {
      setError(err);
    }
    return snapshot();
  });
  ipcMain.handle("host:updateInstall", (event) => {
    if (platform === "darwin") {
      authorizeInstall(event);
      return signedMacUpdater().install();
    }
    if (!autoUpdater || !state.downloaded) return snapshot();
    state.installing = true;
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return snapshot();
  });
}

const CHANNELS = ["host:updateGetState", "host:updateCheck", "host:updateInstall"];

module.exports = { init, registerIpc, snapshot, state, CHANNELS, configureInstall };
