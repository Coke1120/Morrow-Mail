const fs = require("fs");
const os = require("os");
const path = require("path");

function electronUserData() {
  try {
    const { app } = require("electron");
    if (app && app.isReady()) return app.getPath("userData");
  } catch {
    // plain node / pre-ready
  }
  return null;
}

function legacyMacSupport(name) {
  return path.join(os.homedir(), "Library/Application Support", name);
}

function userDataDir(fallbackName = "genmail-rea") {
  const override = (process.env.GENMAIL_USER_DATA || process.env.GENMAIL_MAIL_DIR || process.env.GENMAIL_AI_CONFIG_DIR || "").trim();
  if (override) return override;
  const fromApp = electronUserData();
  if (fromApp) return fromApp;
  if (process.platform === "darwin") return legacyMacSupport(fallbackName);
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), fallbackName);
  }
  return path.join(os.homedir(), ".config", fallbackName);
}

function preloadPath() {
  return path.join(userDataDir("GenMail Exact"), "preload.mjs");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { userDataDir, preloadPath, ensureDir, electronUserData };
