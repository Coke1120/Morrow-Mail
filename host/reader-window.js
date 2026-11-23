// Reader BrowserWindows. Helpers stay free of Electron so plain Node checks can load them.
const windowState = require("./window-state");
const readerState = require("./reader-window-state");

const CHANNELS = ["reader:open", "reader:pullSeed", "reader:arrangePair"];
const OPEN_FAILED = "That message could not be opened.";
const ARRANGE_FAILED = "Could not place the reader windows side by side.";
const READER_WIDTH = 960;
const READER_HEIGHT = 760;
const READER_MIN_WIDTH = 640;
const READER_MIN_HEIGHT = 480;
const READER_CASCADE = 28;
const READER_CASCADE_ORIGIN = 48;

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

function readerCascadeShift(index) {
  return (Math.max(0, Number(index) || 0) % 6) * READER_CASCADE;
}

// Saved nulls are omitted so place() does not treat them as the origin.
function readerPlaceInput(saved) {
  const source = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  return {
    x: source.x == null || source.x === "" ? undefined : source.x,
    y: source.y == null || source.y === "" ? undefined : source.y,
    width: source.width == null || source.width === "" ? undefined : source.width,
    height: source.height == null || source.height === "" ? undefined : source.height,
  };
}

function readerWindowBounds(parentBounds, index, saved, displays) {
  const shift = readerCascadeShift(index);
  const placed = windowState.place(readerPlaceInput(saved), displays, { width: READER_WIDTH, height: READER_HEIGHT });
  const bounds = {
    width: placed.bounds.width,
    height: placed.bounds.height,
    minWidth: READER_MIN_WIDTH,
    minHeight: READER_MIN_HEIGHT,
  };
  if (Number.isFinite(placed.bounds.x) && Number.isFinite(placed.bounds.y)) {
    bounds.x = Math.round(placed.bounds.x + shift);
    bounds.y = Math.round(placed.bounds.y + shift);
    bounds.originShift = shift;
  } else if (parentBounds && Number.isFinite(parentBounds.x) && Number.isFinite(parentBounds.y)) {
    bounds.x = Math.round(parentBounds.x + READER_CASCADE_ORIGIN + shift);
    bounds.y = Math.round(parentBounds.y + READER_CASCADE_ORIGIN + shift);
    bounds.originShift = shift;
  }
  return bounds;
}

function readerBrowserBounds(draft) {
  const bounds = {
    width: draft.width,
    height: draft.height,
    minWidth: draft.minWidth,
    minHeight: draft.minHeight,
  };
  if (Number.isFinite(draft.x) && Number.isFinite(draft.y)) {
    bounds.x = draft.x;
    bounds.y = draft.y;
  }
  return bounds;
}

// A nudged window stores the unshifted origin so the next first reader does not walk by 28px.
function canonicalReaderBounds(bounds, originShift) {
  if (!bounds || typeof bounds !== "object") return null;
  const shift = Math.round(Number(originShift));
  const applied = Number.isFinite(shift) ? shift : 0;
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
  return {
    x: Math.round(x - applied),
    y: Math.round(y - applied),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function sameReaderBounds(a, b) {
  return a != null && b != null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function readerPairBounds(left, right, area) {
  if (area.width < 2 * READER_MIN_WIDTH || area.height < READER_MIN_HEIGHT) return null;
  // If both widths cannot fit, keep any narrower reader and share the space otherwise.
  const preferredRight = Math.max(right.width, READER_MIN_WIDTH);
  const leftLimit = Math.max(Math.floor(area.width / 2), area.width - preferredRight);
  const leftWidth = Math.min(Math.max(left.width, READER_MIN_WIDTH), leftLimit);
  const rightWidth = Math.min(preferredRight, area.width - leftWidth);
  const leftHeight = Math.min(Math.max(left.height, READER_MIN_HEIGHT), area.height);
  const rightHeight = Math.min(Math.max(right.height, READER_MIN_HEIGHT), area.height);
  const x = Math.max(area.x, Math.min(left.x, right.x, area.x + area.width - leftWidth - rightWidth));
  const y = Math.max(area.y, Math.min(left.y, right.y, area.y + area.height - Math.max(leftHeight, rightHeight)));
  return [
    { x, y, width: leftWidth, height: leftHeight },
    { x: x + leftWidth, y, width: rightWidth, height: rightHeight },
  ];
}

function isVisibleReader(win) {
  return !win.isDestroyed() && win.isVisible() && !win.isMinimized();
}

function isNormalReader(win) {
  return !win.isMaximized() && !win.isFullScreen() && !win.isSimpleFullScreen?.();
}

function createReaderHost(options) {
  const { BrowserWindow, ipcMain, shell, screen } = require("electron");
  const opts = options || {};
  const records = new Map();

  function trackReaderBounds(record, originShift) {
    const { win } = record;
    const write = () => {
      record.boundsTimer = null;
      if (record.arranging || win.isDestroyed()) return;
      let bounds;
      try {
        bounds = typeof win.getNormalBounds === "function" ? win.getNormalBounds() : win.getBounds();
      } catch {
        return;
      }
      if (sameReaderBounds(bounds, record.temporaryBounds)) return;
      const patch = canonicalReaderBounds(bounds, originShift);
      if (!patch) return;
      record.temporaryBounds = null;
      try { readerState.update(patch); } catch { /* a failed write keeps the previous file */ }
    };
    const schedule = () => {
      if (record.arranging) return;
      clearTimeout(record.boundsTimer);
      record.boundsTimer = setTimeout(write, 250);
    };
    win.on("resize", schedule);
    win.on("move", schedule);
    win.on("close", () => {
      clearTimeout(record.boundsTimer);
      write();
    });
  }

  function placeReaderPair(pair, bounds, current) {
    for (const { record } of pair) {
      clearTimeout(record.boundsTimer);
      record.boundsTimer = null;
      record.arranging = true;
    }
    try {
      for (const [index, { record, before }] of pair.entries()) {
        if (!sameReaderBounds(before, bounds[index])) record.win.setBounds(bounds[index]);
      }
      if (!pair.every(({ record }, index) => sameReaderBounds(record.win.getBounds(), bounds[index]))) {
        throw new Error(ARRANGE_FAILED);
      }
      // The Inbox may cover the earlier reader. Keep the invoking window foremost.
      const peer = pair[0].record === current ? pair[1].record : pair[0].record;
      peer.win.moveTop();
      current.win.moveTop();
    } catch (error) {
      for (const { record, before } of pair) {
        const { win } = record;
        try {
          if (!win.isDestroyed() && !sameReaderBounds(win.getBounds(), before)) win.setBounds(before);
        } catch { /* Still attempt to restore the other reader. */ }
      }
      throw error;
    } finally {
      // Delayed move/resize events and close must also skip the temporary frames.
      for (const { record, before } of pair) {
        try { record.temporaryBounds = record.win.getBounds(); } catch { record.temporaryBounds = before; }
        record.arranging = false;
      }
    }
  }

  function arrangePair(event) {
    try {
      const sender = event.sender;
      const current = records.get(sender.id);
      const frame = event.senderFrame;
      if (!current || !isVisibleReader(current.win) || current.win.webContents !== sender ||
          !frame || frame !== sender.mainFrame) {
        return { ok: false, message: "Use this action from a visible detached message reader." };
      }
      const currentBounds = current.win.getBounds();
      const display = screen.getDisplayMatching(currentBounds);
      const pair = [];
      // Map iteration keeps the first-opened reader on the left.
      for (const record of records.values()) {
        if (record !== current && !isVisibleReader(record.win)) continue;
        const before = record === current ? currentBounds : record.win.getBounds();
        if (record === current || screen.getDisplayMatching(before).id === display.id) pair.push({ record, before });
      }
      if (pair.length !== 2) {
        return { ok: false, message: "Keep exactly two message readers visible on this display to place them side by side." };
      }
      if (pair.some(({ record }) => !isNormalReader(record.win))) {
        return { ok: false, message: "Restore both reader windows to normal size to place them side by side." };
      }
      const bounds = readerPairBounds(pair[0].before, pair[1].before, display.workArea);
      if (!bounds) {
        return { ok: false, message: "This display needs at least 1280 × 480 usable pixels to place two readers side by side." };
      }
      placeReaderPair(pair, bounds, current);
      return { ok: true };
    } catch {
      return { ok: false, message: ARRANGE_FAILED };
    }
  }

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
    let displays = [];
    try { displays = screen.getAllDisplays(); } catch { displays = []; }
    let saved = null;
    try { saved = readerState.read(); } catch { saved = null; }
    const draft = readerWindowBounds(parentBounds(), index, saved, displays);
    const bounds = readerBrowserBounds(draft);
    const originShift = draft.originShift || 0;
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
    const record = { win, seed: clean, boundsTimer: null, temporaryBounds: null, arranging: false };
    records.set(id, record);
    trackReaderBounds(record, originShift);
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
    ipcMain.handle("reader:arrangePair", arrangePair);
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
  readerBrowserBounds: readerBrowserBounds,
  canonicalReaderBounds: canonicalReaderBounds,
  createReaderHost: createReaderHost,
};
