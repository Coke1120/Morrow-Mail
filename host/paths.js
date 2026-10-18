const fs = require("fs");
const os = require("os");
const path = require("path");

const PRODUCT_DATA_DIR = "Morrow Mail";

function electronUserData() {
  try {
    const { app } = require("electron");
    if (app && app.isReady()) return app.getPath("userData");
  } catch {
    // plain node / pre-ready
  }
  return null;
}

function userDataDir(fallbackName = PRODUCT_DATA_DIR) {
  // fallbackName is used only before Electron is ready. After ready, userData is "Morrow Mail".
  const override = (process.env.MORROW_USER_DATA || process.env.MORROW_MAIL_DIR || process.env.MORROW_AI_CONFIG_DIR || "").trim();
  if (override) return override;
  const fromApp = electronUserData();
  if (fromApp) return fromApp;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", fallbackName);
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), fallbackName);
  }
  return path.join(os.homedir(), ".config", fallbackName);
}

function preloadPath() {
  return path.join(userDataDir(PRODUCT_DATA_DIR), "preload.mjs");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  userDataDir,
  preloadPath,
  ensureDir,
  electronUserData,
  PRODUCT_DATA_DIR,
};
