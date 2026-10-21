const path = require("path");

// Agent Reply and Reply All open here. Reader compose still uses the in-window
// dialog until a shared compose-window branch lands; this module is that seam.
let options = {
  preloadFile: path.join(__dirname, "..", "renderer", "preload.js"),
  icon: "",
  load: null,
};

const seeds = new Map();
const byKey = new Map();
const closing = new Set();
let quitting = false;
let quitWatch = false;

function configure(next) {
  const incoming = next && typeof next === "object" ? next : {};
  options = {
    preloadFile: incoming.preloadFile || options.preloadFile,
    icon: incoming.icon || options.icon,
    load: typeof incoming.load === "function" ? incoming.load : options.load,
  };
}

function publicSeed(seed) {
  if (!seed || typeof seed !== "object" || Array.isArray(seed)) return {};
  try {
    return JSON.parse(JSON.stringify(seed));
  } catch {
    return {};
  }
}

function composeWindowKey(seed) {
  const safe = publicSeed(seed);
  const id = safe.sourceMessageId || safe.draftId || "";
  if (!id) return "";
  const kind = safe.kind ? String(safe.kind) : "new";
  return kind + "\0" + String(id);
}

function watchQuit() {
  if (quitWatch) return;
  quitWatch = true;
  const electron = require("electron");
  const app = electron && electron.app;
  if (!app || typeof app.on !== "function") return;
  app.on("before-quit", () => {
    quitting = true;
  });
}

function browserWindow() {
  const electron = require("electron");
  if (!electron || typeof electron !== "object" || !electron.BrowserWindow) {
    throw new Error("Compose windows open in the Morrow Mail app.");
  }
  return electron.BrowserWindow;
}

function openComposeWindow(seed) {
  const safe = publicSeed(seed);
  const key = composeWindowKey(safe);
  const BrowserWindow = browserWindow();
  watchQuit();
  if (key && byKey.has(key)) {
    const existing = byKey.get(key);
    if (existing && !existing.isDestroyed()) {
      if (typeof existing.isMinimized === "function" && existing.isMinimized()) existing.restore();
      existing.focus();
      return { success: true, data: { opened: true, focused: true } };
    }
    byKey.delete(key);
  }
  const winOpts = {
    width: 960,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    title: (safe.title ? String(safe.title) : "New message") + " — Morrow Mail",
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    webPreferences: {
      preload: options.preloadFile,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };
  if (options.icon) winOpts.icon = options.icon;
  try {
    const focused = typeof BrowserWindow.getFocusedWindow === "function" ? BrowserWindow.getFocusedWindow() : null;
    if (focused && !focused.isDestroyed()) {
      const bounds = focused.getBounds();
      winOpts.x = Math.round(bounds.x + 32);
      winOpts.y = Math.round(bounds.y + 32);
    }
  } catch {
    /* the system places the window */
  }
  const win = new BrowserWindow(winOpts);
  const id = win.webContents.id;
  seeds.set(id, safe);
  if (key) byKey.set(key, win);
  const forget = () => {
    seeds.delete(id);
    closing.delete(id);
    if (key && byKey.get(key) === win) byKey.delete(key);
  };
  win.on("closed", forget);
  win.on("close", (event) => {
    if (quitting || closing.has(id)) return;
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    try { win.webContents.send("compose:requestClose"); } catch { /* already closing */ }
  });
  const pending = options.load
    ? options.load(win)
    : win.loadFile(path.join(__dirname, "..", "renderer", "index.html"), { query: { surface: "compose" } });
  Promise.resolve(pending).catch(() => {});
  return { success: true, data: { opened: true, focused: false } };
}

function takeComposeSeed(event) {
  const id = event && event.sender && event.sender.id;
  return { success: true, data: { seed: seeds.has(id) ? seeds.get(id) : null } };
}

function closeComposeWindow(event) {
  const BrowserWindow = browserWindow();
  const contents = event && event.sender;
  const win = contents && typeof BrowserWindow.fromWebContents === "function"
    ? BrowserWindow.fromWebContents(contents)
    : null;
  if (!win || win.isDestroyed()) return { success: true, data: { closed: true } };
  closing.add(win.webContents.id);
  win.close();
  return { success: true, data: { closed: true } };
}

function answer(channel, payload, event) {
  try {
    if (channel === "host:openComposeWindow") return openComposeWindow(payload && payload.seed);
    if (channel === "host:takeComposeSeed") return takeComposeSeed(event);
    if (channel === "host:closeComposeWindow") return closeComposeWindow(event);
  } catch (error) {
    return { success: false, error: { message: error instanceof Error ? error.message : String(error) } };
  }
  return undefined;
}

module.exports = {
  configure,
  publicSeed,
  composeWindowKey,
  answer,
};
