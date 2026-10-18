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
  // fallbackName is used only before Electron is ready. After ready, userData is "Morrow Mail".
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

function supportDir(name, home = os.homedir()) {
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", name);
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(base, name);
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, name);
}

const PRODUCT_DATA_DIR = "Morrow Mail";
const LEGACY_DATA_DIR = "GenMail REA";

function migrateLegacyUserData(options = {}) {
  const next = options.next || supportDir(PRODUCT_DATA_DIR, options.home);
  const prev = options.prev || supportDir(LEGACY_DATA_DIR, options.home);
  if (!options.next && (process.env.GENMAIL_USER_DATA || process.env.GENMAIL_MAIL_DIR || process.env.GENMAIL_AI_CONFIG_DIR)) {
    return [];
  }
  if (!fs.existsSync(prev)) return [];
  let entries;
  try {
    entries = fs.readdirSync(prev);
  } catch {
    return [];
  }
  fs.mkdirSync(next, { recursive: true });
  const copied = [];
  for (const name of entries) {
    const from = path.join(prev, name);
    const to = path.join(next, name);
    if (fs.existsSync(to)) continue;
    fs.cpSync(from, to, { recursive: true });
    copied.push(name);
  }
  return copied;
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
  supportDir,
  migrateLegacyUserData,
  PRODUCT_DATA_DIR,
  LEGACY_DATA_DIR,
};
