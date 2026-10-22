// Translation BrowserWindows. Helpers stay free of Electron so plain Node checks can load them.
const CHANNELS = ["translate:open", "translate:pullSeed", "translate:report"];
const OPEN_FAILED = "That translation could not be opened.";
const BODY_CAP = 2000000;
const recordsByReq = new Map();
const recordsByWeb = new Map();

function cleanLine(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max || 180);
}

function cleanToken(value, max) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  const limit = max || 80;
  if (!text || text.length > limit) return "";
  if (/[\u0000-\u001f\u007f]/.test(text)) return "";
  return text;
}

function translateWindowTitle(subject, language) {
  const subjectText = cleanLine(subject, 180);
  const languageText = cleanLine(language, 80);
  let core = "Translation";
  if (subjectText && languageText) core = subjectText + " — " + languageText;
  else if (subjectText) core = subjectText;
  else if (languageText) core = "Translation — " + languageText;
  return core.slice(0, 180) + " — Morrow Mail";
}

function sanitizeTranslateSeed(seed) {
  if (!seed || typeof seed !== "object" || Array.isArray(seed)) throw new Error(OPEN_FAILED);
  const reqId = cleanToken(seed.reqId, 80);
  const original = typeof seed.original === "string" ? seed.original : "";
  const body = original.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, BODY_CAP);
  if (!reqId || !body.trim()) throw new Error(OPEN_FAILED);
  const nodeIds = [];
  const seen = new Set();
  if (Array.isArray(seed.nodeIds)) {
    for (const item of seed.nodeIds) {
      const id = cleanToken(item, 80);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      nodeIds.push(id);
      if (nodeIds.length >= 5000) break;
    }
  }
  return {
    reqId: reqId,
    subject: cleanLine(seed.subject, 180),
    language: cleanLine(seed.language, 80),
    original: body,
    nodeIds: nodeIds,
  };
}

function translateWindowBounds(parentBounds, index) {
  const shift = (Math.max(0, Number(index) || 0) % 6) * 28;
  const bounds = { width: 1100, height: 760, minWidth: 760, minHeight: 480 };
  if (parentBounds && Number.isFinite(parentBounds.x) && Number.isFinite(parentBounds.y)) {
    bounds.x = Math.round(parentBounds.x + 48 + shift);
    bounds.y = Math.round(parentBounds.y + 48 + shift);
  }
  return bounds;
}

function assembleTranslation(record) {
  const ids = record.nodeIds && record.nodeIds.length ? record.nodeIds : Object.keys(record.texts || {});
  return ids.map((id) => (record.texts && record.texts[id]) || "").filter(Boolean).join("\n\n");
}

function applyTranslateEvent(record, event) {
  if (!record || !event || event.reqId !== record.reqId) return record;
  record.seq = (Number(record.seq) || 0) + 1;
  if (event.type === "progress") {
    if (typeof event.current === "number") record.current = event.current;
    if (typeof event.total === "number") record.total = event.total;
    return record;
  }
  if (event.type === "node") {
    const text = event.status === "success" ? String(event.translatedText || "") : "";
    if (!record.texts) record.texts = {};
    record.texts[event.nodeId] = text;
    record.translated = assembleTranslation(record);
    if (!text && event.error) record.error = String(event.error);
    return record;
  }
  if (event.type === "error") {
    record.error = String(event.message || "Translation failed.");
    record.pending = false;
    return record;
  }
  if (event.type === "done") record.pending = false;
  return record;
}

function publicSnapshot(record) {
  return {
    seq: record.seq,
    reqId: record.reqId,
    subject: record.subject,
    language: record.language,
    original: record.original,
    translated: record.translated || "",
    error: record.error || "",
    pending: record.pending === true,
    current: Number(record.current) || 0,
    total: Number(record.total) || 0,
  };
}

function publish(record) {
  const win = record && record.win;
  if (!win || typeof win.isDestroyed !== "function" || win.isDestroyed()) return;
  try { win.setTitle(translateWindowTitle(record.subject, record.language)); } catch { /* the title stays as opened */ }
  try { win.webContents.send("translate:update", publicSnapshot(record)); } catch { /* the page is closing */ }
}

function note(payload) {
  if (!payload || !payload.reqId) return;
  const record = recordsByReq.get(payload.reqId);
  if (!record) return;
  applyTranslateEvent(record, payload);
  publish(record);
}

function createTranslateHost(options) {
  const { BrowserWindow, ipcMain, shell } = require("electron");
  const opts = options || {};

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
    const clean = sanitizeTranslateSeed(seed);
    const previous = recordsByReq.get(clean.reqId);
    if (previous && previous.win && typeof previous.win.isDestroyed === "function" && !previous.win.isDestroyed()) {
      try { previous.win.close(); } catch { /* a replaced window can already be gone */ }
    }
    let index = 0;
    for (const record of recordsByReq.values()) {
      if (record.win && typeof record.win.isDestroyed === "function" && !record.win.isDestroyed()) index += 1;
    }
    const bounds = translateWindowBounds(parentBounds(), index);
    const win = new BrowserWindow({
      ...bounds,
      title: translateWindowTitle(clean.subject, clean.language),
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
    const record = {
      win: win,
      webContentsId: id,
      reqId: clean.reqId,
      subject: clean.subject,
      language: clean.language,
      original: clean.original,
      nodeIds: clean.nodeIds,
      texts: {},
      translated: "",
      error: "",
      pending: true,
      current: 0,
      total: clean.nodeIds.length,
      seq: 1,
    };
    recordsByReq.set(clean.reqId, record);
    recordsByWeb.set(id, record);
    win.webContents.setWindowOpenHandler(({ url }) => {
      let parsed;
      try { parsed = new URL(url); } catch { return { action: "deny" }; }
      if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
        shell.openExternal(url).catch(() => {});
      }
      return { action: "deny" };
    });
    win.on("closed", () => {
      recordsByWeb.delete(id);
      const current = recordsByReq.get(clean.reqId);
      if (current && current.win === win) recordsByReq.delete(clean.reqId);
    });
    win.webContents.on("did-finish-load", () => {
      if (win.isDestroyed()) return;
      const current = recordsByWeb.get(id);
      if (!current) return;
      try { win.webContents.setZoomLevel(0); } catch { /* zoom stays at the level the page opened with */ }
      publish(current);
    });
    win.webContents.on("did-fail-load", (_event, _code, _desc, _url, isMainFrame) => {
      if (isMainFrame === false) return;
      if (!win.isDestroyed()) win.close();
    });
    const loading = mode() === "asar"
      ? win.loadURL("morrow://local/index.html?role=translate")
      : win.loadFile(opts.htmlFile, { query: { role: "translate" } });
    loading.catch(() => {
      if (!win.isDestroyed()) win.close();
    });
    return { ok: true, id: id };
  }

  function register() {
    ipcMain.handle("translate:open", (_event, seed) => open(seed));
    ipcMain.handle("translate:pullSeed", (event) => {
      const record = recordsByWeb.get(event.sender.id);
      if (!record) return null;
      return publicSnapshot(record);
    });
    ipcMain.handle("translate:report", (_event, payload) => {
      note(payload);
      return { success: true, data: true };
    });
    return { open: open };
  }

  return { open: open, register: register };
}

module.exports = {
  CHANNELS: CHANNELS,
  OPEN_FAILED: OPEN_FAILED,
  translateWindowTitle: translateWindowTitle,
  sanitizeTranslateSeed: sanitizeTranslateSeed,
  translateWindowBounds: translateWindowBounds,
  applyTranslateEvent: applyTranslateEvent,
  publicSnapshot: publicSnapshot,
  note: note,
  createTranslateHost: createTranslateHost,
};
