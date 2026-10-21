// Compose BrowserWindows. Helpers stay free of Electron so plain Node checks can load them.
const CHANNELS = ["compose:open", "compose:pullSeed", "compose:allowClose", "compose:setTitle"];
const MAX_SEED_CHARS = 8000000;

function composeWindowTitle(seed) {
  const raw = seed && typeof seed.title === "string" ? seed.title.trim() : "";
  const title = (raw || "New message").slice(0, 180);
  return title + " — Morrow Mail";
}

function sanitizeComposeSeed(seed) {
  if (seed == null) return {};
  if (typeof seed !== "object" || Array.isArray(seed)) {
    throw new Error("Compose could not be opened.");
  }
  let text;
  try {
    text = JSON.stringify(seed);
  } catch {
    throw new Error("That message could not be opened in a compose window.");
  }
  if (typeof text !== "string") {
    throw new Error("That message could not be opened in a compose window.");
  }
  if (text.length > MAX_SEED_CHARS) {
    throw new Error("That message is too large to open in a compose window.");
  }
  return JSON.parse(text);
}

function composeWindowBounds(parentBounds, index) {
  const shift = (Math.max(0, Number(index) || 0) % 6) * 28;
  const bounds = { width: 1040, height: 780, minWidth: 720, minHeight: 560 };
  if (parentBounds && Number.isFinite(parentBounds.x) && Number.isFinite(parentBounds.y)) {
    bounds.x = Math.round(parentBounds.x + 48 + shift);
    bounds.y = Math.round(parentBounds.y + 48 + shift);
  }
  return bounds;
}

function createComposeHost(options) {
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

  function open(seed) {
    const clean = sanitizeComposeSeed(seed);
    let index = 0;
    for (const record of records.values()) {
      if (record.win && !record.win.isDestroyed()) index += 1;
    }
    const bounds = composeWindowBounds(parentBounds(), index);
    // No parent and no modal: the mail window stays usable, and a compose window
    // does not hide when the shell hides.
    const win = new BrowserWindow({
      ...bounds,
      title: composeWindowTitle(clean),
      icon: opts.icon,
      backgroundColor: backgroundColor(),
      webPreferences: {
        preload: preloadFile(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    const id = win.webContents.id;
    const record = { win, seed: clean, allowClose: false, closeRequested: false };
    records.set(id, record);
    win.webContents.setWindowOpenHandler(({ url }) => {
      let parsed;
      try { parsed = new URL(url); } catch { return { action: "deny" }; }
      if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
        shell.openExternal(url).catch(() => {});
      }
      return { action: "deny" };
    });
    const fail = () => {
      if (win.isDestroyed()) return;
      record.allowClose = true;
      win.close();
    };
    win.on("closed", () => { records.delete(id); });
    win.on("close", (event) => {
      const current = records.get(id);
      if (!current || current.allowClose) return;
      event.preventDefault();
      current.closeRequested = true;
      if (win.webContents.isLoading()) return;
      if (!win.isVisible()) win.show();
      win.focus();
      try { win.webContents.send("compose:requestClose"); } catch { /* the page is already gone */ }
    });
    win.webContents.on("did-finish-load", () => {
      if (win.isDestroyed()) return;
      win.setTitle(composeWindowTitle(record.seed));
      if (!record.closeRequested) return;
      try { win.webContents.send("compose:requestClose"); } catch { /* listener arrives with the page */ }
    });
    win.webContents.on("did-fail-load", (_event, _code, _desc, _url, isMainFrame) => {
      if (isMainFrame === false) return;
      fail();
    });
    const loading = mode() === "asar"
      ? win.loadURL("morrow://local/index.html?role=compose")
      : win.loadFile(opts.htmlFile, { query: { role: "compose" } });
    loading.catch(fail);
    return { ok: true, id };
  }

  function register() {
    ipcMain.handle("compose:open", (_event, seed) => open(seed));
    ipcMain.handle("compose:pullSeed", (event) => {
      const record = records.get(event.sender.id);
      if (!record) return null;
      return JSON.parse(JSON.stringify(record.seed));
    });
    ipcMain.handle("compose:setTitle", (event, text) => {
      const record = records.get(event.sender.id);
      if (!record || record.win.isDestroyed()) return false;
      record.win.setTitle(composeWindowTitle({ title: typeof text === "string" ? text : "" }));
      return true;
    });
    ipcMain.on("compose:allowClose", (event) => {
      const record = records.get(event.sender.id);
      if (!record || record.win.isDestroyed()) return;
      record.allowClose = true;
      record.win.close();
    });
    return { open, records };
  }

  return { open, register, records };
}

module.exports = {
  CHANNELS,
  MAX_SEED_CHARS,
  composeWindowTitle,
  sanitizeComposeSeed,
  composeWindowBounds,
  createComposeHost,
};
