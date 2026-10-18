const { app, ipcMain } = require("electron");
const auth = require("./update-auth");

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

function snapshot() {
  return { ...state };
}

function setError(err) {
  state.error = auth.explainUpdateError(err);
  state.checking = false;
  state.downloading = false;
  state.installing = false;
  if (!state.downloaded) state.available = false;
  state.needsToken = auth.authFailureKind(state.error) !== "";
}

function applyFeed(updater, token) {
  updater.setFeedURL(auth.githubFeed(token));
}

function prepareUpdater() {
  const token = auth.resolveGithubToken();
  state.needsToken = false;
  if (!autoUpdater) {
    ({ autoUpdater } = require("electron-updater"));
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = true;
    bind(autoUpdater);
  }
  applyFeed(autoUpdater, token);
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
  ipcMain.handle("host:updateGetState", () => snapshot());
  ipcMain.handle("host:updateCheck", async () => {
    if (!app.isPackaged) return snapshot();
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
  ipcMain.handle("host:updateInstall", () => {
    if (!autoUpdater || !state.downloaded) return snapshot();
    state.installing = true;
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return snapshot();
  });
}

const CHANNELS = ["host:updateGetState", "host:updateCheck", "host:updateInstall"];

module.exports = { init, registerIpc, snapshot, state, CHANNELS };
