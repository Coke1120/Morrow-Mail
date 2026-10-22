// Reader BrowserWindows. Helpers stay free of Electron so plain Node checks can load them.
const CHANNELS = ["reader:open", "reader:pullSeed"];
const OPEN_FAILED = "That message could not be opened.";

function readerWindowTitle(subject) {
  const raw = typeof subject === "string" ? subject.trim() : "";
  const title = (raw || "Message").slice(0, 180);
  return title + " — Morrow Mail";
}

function cleanToken(value) {
  if (typeof value !== "string") return "";
  if (!value || value.length > 200) return "";
  if (/[\u0000-\u001f\u007f]/.test(value)) return "";
  return value;
}

function sanitizeReaderSeed(seed) {
  if (!seed || typeof seed !== "object" || Array.isArray(seed)) {
    throw new Error(OPEN_FAILED);
  }
  const accountId = cleanToken(seed.accountId);
  const messageId = cleanToken(seed.messageId);
  if (!accountId || !messageId) throw new Error(OPEN_FAILED);
  return { accountId: accountId, messageId: messageId };
}

function readerWindowBounds(parentBounds, index) {
  const shift = (Math.max(0, Number(index) || 0) % 6) * 28;
  const bounds = { width: 960, height: 760, minWidth: 640, minHeight: 480 };
  if (parentBounds && Number.isFinite(parentBounds.x) && Number.isFinite(parentBounds.y)) {
    bounds.x = Math.round(parentBounds.x + 48 + shift);
    bounds.y = Math.round(parentBounds.y + 48 + shift);
  }
  return bounds;
}

function createReaderHost(options) {
  const { BrowserWindow, ipcMain, shell } = require("electron");
  const opts = options || {};
  const records = new Map();

  function parentBounds() {
    const parent = typeof opts.getParent === "function" ? opts.getParent() : null;
    if (!parent || typeof parent.isDestroyed !== "function" || parent.isDestroyed()) return null;
    try { return parent.getBounds(); } catch { return null; }
  }

  function backgroundColor() {
    const value = opts.backgroundColor;
    if (typeof value === "function") return value();
    return value || "#e7f0e4";
  }

  function preloadFile() {
    const value = opts.preloadFile;
    return typeof value === "function" ? value() : value;
  }

  function mode() {
    return typeof opts.mode === "function" ? opts.mode() : opts.mode;
  }

  function tellOpener(opener) {
    if (!opener || typeof opener.isDestroyed !== "function" || opener.isDestroyed()) return;
    try { opener.send("reader:openFailed", { message: OPEN_FAILED }); } catch { /* the opener is gone */ }
  }

  function open(seed, opener) {
    const clean = sanitizeReaderSeed(seed);
    let index = 0;
    for (const record of records.values()) {
      if (record.win && !record.win.isDestroyed()) index += 1;
    }
    const bounds = readerWindowBounds(parentBounds(), index);
    // No parent and no modal: the mail window stays usable, and a reader window
    // does not hide when the shell hides. Compose windows are a separate count.
    const win = new BrowserWindow({
      ...bounds,
      title: readerWindowTitle(""),
      icon: opts.icon,
      backgroundColor: backgroundColor(),
      webPreferences: {
        preload: preloadFile(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    try { win.webContents.setZoomLevel(0); } catch { /* the page still opens at the default zoom */ }
    const id = win.webContents.id;
    const record = { win, seed: clean };
    records.set(id, record);
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      tellOpener(opener);
      if (win.isDestroyed()) return;
      win.close();
    };
    win.webContents.setWindowOpenHandler(({ url }) => {
      let parsed;
      try { parsed = new URL(url); } catch { return { action: "deny" }; }
      if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
        shell.openExternal(url).catch(() => {});
      }
      return { action: "deny" };
    });
    win.on("closed", () => { records.delete(id); });
    win.webContents.on("did-finish-load", () => {
      if (win.isDestroyed()) return;
      try { win.webContents.setZoomLevel(0); } catch { /* zoom stays at the level the page opened with */ }
    });
    win.webContents.on("did-fail-load", (_event, _code, _desc, _url, isMainFrame) => {
      if (isMainFrame === false) return;
      fail();
    });
    const loading = mode() === "asar"
      ? win.loadURL("morrow://local/index.html?role=reader")
      : win.loadFile(opts.htmlFile, { query: { role: "reader" } });
    loading.catch(fail);
    return { ok: true, id: id };
  }

  function register() {
    ipcMain.handle("reader:open", (event, seed) => open(seed, event.sender));
    ipcMain.handle("reader:pullSeed", (event) => {
      const record = records.get(event.sender.id);
      if (!record) return null;
      return { accountId: record.seed.accountId, messageId: record.seed.messageId };
    });
    return { open: open, records: records };
  }

  return { open: open, register: register, records: records };
}

module.exports = {
  CHANNELS: CHANNELS,
  OPEN_FAILED: OPEN_FAILED,
  readerWindowTitle: readerWindowTitle,
  sanitizeReaderSeed: sanitizeReaderSeed,
  readerWindowBounds: readerWindowBounds,
  createReaderHost: createReaderHost,
};
