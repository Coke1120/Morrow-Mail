const { app, ipcMain } = require("electron");

const state = {
  checking: false,
  available: false,
  downloading: false,
  downloaded: false,
  version: null,
  progress: 0,
  error: null,
  installing: false,
  enabled: false,
  channel: "prerelease",
};

let autoUpdater = null;
let listenersBound = false;

function snapshot() {
  return { ...state };
}

function setError(err) {
  state.error = err instanceof Error ? err.message : String(err || "update failed");
  state.checking = false;
  state.downloading = false;
  state.installing = false;
}

function bind(updater) {
  if (listenersBound) return;
  listenersBound = true;
  updater.on("checking-for-update", () => {
    state.checking = true;
    state.error = null;
  });
  updater.on("update-available", (info) => {
    state.checking = false;
    state.available = true;
    state.version = info && info.version ? info.version : null;
  });
  updater.on("update-not-available", () => {
    state.checking = false;
    state.available = false;
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
  // Dev / unpackaged: keep stub state so GenMail UI update:getState stays safe.
  if (!app.isPackaged) {
    state.enabled = false;
    return snapshot();
  }
  try {
    ({ autoUpdater } = require("electron-updater"));
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = true;
    // Private GitHub Releases need GH_TOKEN or electron-builder publish token in env.
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
      autoUpdater.requestHeaders = {
        Authorization: `token ${process.env.GH_TOKEN || process.env.GITHUB_TOKEN}`,
      };
    }
    bind(autoUpdater);
    state.enabled = true;
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => setError(err));
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
    if (!autoUpdater) return snapshot();
    try {
      state.checking = true;
      await autoUpdater.checkForUpdates();
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
