const { app, BrowserWindow, dialog, protocol, ipcMain, session, Menu, powerMonitor, nativeImage, shell, screen } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openAsar, readFile } = require("./asar");
const { createIpc } = require("./ipc");
const { createDiagnostics, attachRendererDiagnostics } = require("./ipc-diagnostics");
const { loadConfig, publicConfig, saveConfig, completionsUrl, modelsUrl, DEFAULTS } = require("./ai-config");
const { complete, extractJson, modelIds, listModels } = require("./openai-client");

const AI_CHANNELS = ["host:aiGetConfig", "host:aiSaveConfig", "host:aiTest", "host:aiListModels"];
const { init: initMail, startBackgroundSync } = require("./mail/engine");
const { startupFailureDialog, startupStatusHtml } = require("./startup-error");
const { answer: brainAnswer } = require("./brain");
const { answer: draftAnswer, escapeHtml } = require("./draft-write");

const LOG = path.join(os.homedir(), ".hermes", "tmp", "morrow-mail", "ipc.log");
const { preloadPath } = require("./paths");
const PRELOAD_OUT = preloadPath();
const FIRST_PARTY_DIR = path.join(__dirname, "..", "renderer");
const FIRST_PARTY_PRELOAD = path.join(FIRST_PARTY_DIR, "preload.js");
const FIRST_PARTY_HTML = path.join(FIRST_PARTY_DIR, "index.html");
const updater = require("./updater");
const windowState = require("./window-state");
const composeWindows = require("./compose-window");
const readerWindows = require("./reader-window");
const translateWindows = require("./translate-window");
const { gate: updateGate, requestRendererQuiescence } = require("./update-quiescence");
const ZOOM_STEP = 0.5;

function resolveAppIcon() {
  // Windows needs native small icon sizes for the titlebar and taskbar.
  if (process.platform === "win32") {
    const ico = process.resourcesPath && path.join(process.resourcesPath, "icon.ico");
    if (ico && fs.existsSync(ico)) return ico;
    const source = path.join(__dirname, "..", "build", "icon.ico");
    if (fs.existsSync(source)) return source;
  }
  // Packaged apps copy build/icon.png to resources/icon.png. A dev checkout
  // still reads the source file; Electron's own resources directory does not have it.
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, "icon.png") : "";
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, "..", "build", "icon.png");
}

const APP_ICON = resolveAppIcon();

function applyDockIcon() {
  if (process.platform !== "darwin" || app.dock == null) return;
  const image = nativeImage.createFromPath(APP_ICON);
  if (!image.isEmpty()) app.dock.setIcon(image);
}

const singleInstance = app.requestSingleInstanceLock();
let shellWindow = null;
let shellSession = null;
let shellOpening = null;
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    presentShell();
  });
  // Dock icon, and macOS relaunch of an already running app.
  app.on("activate", () => {
    presentShell();
  });
}

app.setName("Morrow Mail");
if (process.platform === "win32") app.setAppUserModelId("com.coke1120.morrow-mail");
app.setAboutPanelOptions({
  applicationName: "Morrow Mail",
  applicationVersion: app.getVersion(),
  copyright: "Copyright (c) 2026 Leo Ho / HWL-HK",
  iconPath: APP_ICON,
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: "morrow",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

function mimeOf(rel) {
  return MIME[path.extname(rel).toLowerCase()] || "application/octet-stream";
}

let archive;

function extractPreload() {
  const bytes = readFile(archive, "out/preload/index.mjs");
  if (!bytes) throw new Error("preload missing from asar");
  fs.mkdirSync(path.dirname(PRELOAD_OUT), { recursive: true });
  fs.writeFileSync(PRELOAD_OUT, bytes);
}

function registerProtocol() {
  protocol.handle("morrow", (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("bad url", { status: 400 });
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const asarPath = `out/renderer${rel}`.replace(/\/+/g, "/");
    if (rel === "/boot-seed.js") {
      // Classic script, served before the module entry, so the store reads
      // the aggregate scope ("*") on its first localStorage lookup.
      const seed = 'localStorage.setItem("gm-mail-scope-account","*");';
      return new Response(seed, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    }
    const body = readFile(archive, asarPath);
    if (!body) {
      return new Response(`missing ${asarPath}`, { status: 404, headers: { "content-type": "text/plain" } });
    }
    if (rel === "/index.html") {
      const html = body.toString("utf8").replace(
        '<script type="module"',
        '<script src="./boot-seed.js"></script>\n    <script type="module"'
      );
      return new Response(html, { headers: { "content-type": mimeOf(asarPath) } });
    }
    return new Response(body, { headers: { "content-type": mimeOf(asarPath) } });
  });
}

function externalAsarPath() {
  return (process.env.MORROW_ASAR || "").trim();
}

function attachIpc(preloadFile) {
  if (!fs.existsSync(preloadFile)) {
    throw new Error(`Renderer preload missing at ${preloadFile}`);
  }
  const bus = createIpc(LOG);
  fs.writeFileSync(LOG, "", { mode: 0o600 });
  const src = fs.readFileSync(preloadFile, "utf8");
  const channels = new Set();
  for (const match of src.matchAll(/"([a-zA-Z][\w-]*:[^"\n]{1,180})"/g)) {
    channels.add(match[1]);
  }
  fs.appendFileSync(LOG, `# channels ${channels.size}\n`);
  // registerHostAi and updater.registerIpc already own these. A second ipcMain.handle throws.
  const directHost = new Set([...updater.CHANNELS, ...AI_CHANNELS]);
  for (const name of ["host:updatePrepared", "host:updatePrepareForInstall", "host:updateResume", "host:updateStartupReady"]) directHost.add(name);
  for (const name of ["app:confirmQuitScheduled", "app:dismissQuitScheduled", "app:quitScheduledChoice", "app:quitScheduledShown"]) directHost.add(name);
  for (const name of composeWindows.CHANNELS) directHost.add(name);
  for (const name of readerWindows.CHANNELS) directHost.add(name);
  directHost.add("reader:openFailed");
  for (const name of translateWindows.CHANNELS) directHost.add(name);
  for (const channel of channels) {
    if (directHost.has(channel)) continue;
    ipcMain.handle(channel, (event, ...args) => updateGate.run(() => bus.handle(event, channel, ...args)));
    ipcMain.on(channel, (event, ...args) => {
      if (updateGate.closed) { event.returnValue = null; return; }
      bus.send(event, channel, ...args);
      // sendSync reads event.returnValue. Leaving it unset comes back as an
      // object, and locale resolution calls .split on that.
      event.returnValue = updateGate.run(() => bus.handle(event, channel, ...args));
    });
  }
}

let setupWindow = null;

function openAiSetup() {
  if (updateGate.closed) return;
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 560,
    height: 520,
    title: "AI Setup — Morrow Mail",
    icon: APP_ICON,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "setup-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  setupWindow.on("closed", () => {
    setupWindow = null;
  });
  setupWindow.loadFile(path.join(__dirname, "ai-setup.html")).then(() => {
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.setTitle("AI Setup — Morrow Mail");
  }).catch(() => {});
}

function shellForZoom() {
  if (shellWindow && !shellWindow.isDestroyed()) return shellWindow;
  return null;
}

function applyZoom(level) {
  const win = shellForZoom();
  if (!win) return;
  const next = windowState.clampZoom(level);
  win.webContents.setZoomLevel(next);
  windowState.update({ zoomLevel: next });
}

function bumpZoom(delta) {
  const win = shellForZoom();
  if (!win) return;
  applyZoom(win.webContents.getZoomLevel() + delta);
}

function sendShellAction(action) {
  const win = shellForZoom();
  if (!win || win.isDestroyed()) return;
  win.webContents.send("host:menuAction", { action: String(action || "") });
}

function installMenu() {
  // Reload stays the View menu role. Zoom stays Plus, =, -, and 0.
  // macOS File → Close Window uses the same close event as the red button.
  const fileMenu = process.platform === "darwin"
    ? [{ label: "File", submenu: [{ role: "close" }] }]
    : [];
  const template = [
    {
      label: "Morrow Mail",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Settings…", accelerator: "CommandOrControl+,", click: () => sendShellAction("settings") },
        { label: "AI Setup…", click: () => openAiSetup() },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    ...fileMenu,
    {
      label: "Mail",
      submenu: [
        { label: "New Mail", accelerator: "CommandOrControl+N", click: () => sendShellAction("new-mail") },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { label: "Actual Size", accelerator: "CommandOrControl+0", click: () => applyZoom(0) },
        { label: "Zoom In", accelerator: "CommandOrControl+Plus", click: () => bumpZoom(ZOOM_STEP) },
        { label: "Zoom In", accelerator: "CommandOrControl+=", visible: false, click: () => bumpZoom(ZOOM_STEP) },
        { label: "Zoom Out", accelerator: "CommandOrControl+-", click: () => bumpZoom(-ZOOM_STEP) },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function rememberWindow(win, includeZoom) {
  if (!win || win.isDestroyed()) return;
  let bounds;
  try {
    bounds = typeof win.getNormalBounds === "function" ? win.getNormalBounds() : win.getBounds();
  } catch {
    return;
  }
  const patch = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
    maximized: !!win.isMaximized(),
    fullscreen: !!win.isFullScreen(),
  };
  if (includeZoom) {
    try { patch.zoomLevel = windowState.clampZoom(win.webContents.getZoomLevel()); } catch { /* keep the saved zoom */ }
  }
  try { windowState.update(patch); } catch { /* a failed write keeps the previous file */ }
}

function trackWindow(win, savedZoom) {
  let timer = null;
  let zoomLive = false;
  let suppressZoom = false;
  let currentZoom = windowState.clampZoom(savedZoom);
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => rememberWindow(win, false), 250);
  };
  const restoreZoom = () => {
    suppressZoom = true;
    try { win.webContents.setZoomLevel(currentZoom); } catch { /* zoom restores on the next launch */ }
    setTimeout(() => { suppressZoom = false; }, 300);
  };
  win.on("resize", schedule);
  win.on("move", schedule);
  win.on("maximize", () => rememberWindow(win, false));
  win.on("unmaximize", () => rememberWindow(win, false));
  win.on("enter-full-screen", () => rememberWindow(win, false));
  win.on("leave-full-screen", () => rememberWindow(win, false));
  win.on("close", () => {
    clearTimeout(timer);
    rememberWindow(win, zoomLive);
  });
  win.webContents.on("did-finish-load", () => {
    restoreZoom();
    zoomLive = true;
  });
  win.webContents.on("did-fail-load", () => {
    restoreZoom();
    zoomLive = true;
  });
  win.webContents.on("zoom-changed", () => {
    if (!zoomLive || suppressZoom) return;
    try {
      currentZoom = windowState.clampZoom(win.webContents.getZoomLevel());
      windowState.update({ zoomLevel: currentZoom });
    } catch { /* closing */ }
  });
  restoreZoom();
}

function registerHostAi() {
  ipcMain.handle("host:aiGetConfig", () => publicConfig());
  ipcMain.handle("host:aiSaveConfig", (_event, input) => updateGate.run(() => saveConfig(input)));
  ipcMain.handle("host:aiTest", async (_event, input) => {
    try {
      // Renderer sends the visible form values so a dirty form is tested as
      // shown. Blank fields keep using the saved config.
      const saved = loadConfig();
      const draft = input && typeof input === "object" ? input : {};
      const cfg = {
        baseUrl: typeof draft.baseUrl === "string" && draft.baseUrl.trim() ? draft.baseUrl.trim() : saved.baseUrl,
        model: typeof draft.model === "string" && draft.model.trim() ? draft.model.trim() : saved.model,
        apiKey: typeof draft.apiKey === "string" && draft.apiKey.trim() ? draft.apiKey.trim() : saved.apiKey,
      };
      if (!cfg.apiKey) throw new Error("Add an API key in Morrow Mail → AI Setup.");
      const text = await complete([
        { role: "system", content: "Reply with one short sentence and nothing else." },
        { role: "user", content: "Say hello in five words or fewer." },
      ], { temperature: 0, config: cfg });
      const preview = String(text).replace(/\s+/g, " ").trim().slice(0, 160);
      return { ok: true, preview: preview || "The model returned an empty reply." };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("host:aiListModels", (_event, input) => listModels(input));
}

function runAiSelfTest() {
  const problems = [];
  const pub = publicConfig();
  if (Object.prototype.hasOwnProperty.call(pub, "apiKey")) problems.push("public config includes apiKey");
  if (typeof pub.hasKey !== "boolean") problems.push("public config missing hasKey");
  if (!process.env.MORROW_AI_BASE_URL && pub.baseUrl !== DEFAULTS.baseUrl) problems.push(`base ${pub.baseUrl}`);
  if (!process.env.MORROW_AI_MODEL && pub.model !== DEFAULTS.model) problems.push(`model ${pub.model}`);
  const snap = brainAnswer("emailBrain:getCached", []);
  const persona = snap && snap.data && snap.data.persona;
  if (!snap || snap.success !== true || !persona || persona.status !== "ready") problems.push("getCached shape");
  const sections = persona && persona.profile && persona.profile.sections;
  if (!sections || !sections.some((section) => section.id === "how-you-write")) problems.push("missing how-you-write");
  const added = brainAnswer("emailBrain:addWritingRule", [{ text: "Keep it short." }]);
  const section = added && added.data && added.data.persona && added.data.persona.profile
    && added.data.persona.profile.sections.find((item) => item.id === "how-you-write");
  const rows = section && section.rows;
  if (!rows || !rows.some((row) => row.value === "Keep it short." && row.source === "user")) {
    problems.push("writing rule did not stick");
  }
  const missing = draftAnswer("aiDraftWrite:start", [{}]);
  if (!missing || missing.success !== false) problems.push("start without reqId should fail");
  const emptyTranslate = require("./translate").answer("mail:translateStart", [{ reqId: "t-self", nodes: [] }]);
  if (!emptyTranslate || emptyTranslate.success !== true || emptyTranslate.data.reqId !== "t-self") {
    problems.push("translate start shape");
  }
  const parsed = extractJson("```json\n{\"suggestions\":[\"Thanks\"]}\n```");
  if (!parsed || parsed.suggestions[0] !== "Thanks") problems.push("extractJson");
  if (completionsUrl("https://api.x.ai/v1/") !== "https://api.x.ai/v1/chat/completions") problems.push("completions url");
  if (completionsUrl("https://example.com/v1/chat/completions") !== "https://example.com/v1/chat/completions") {
    problems.push("completions url already complete");
  }
  if (modelsUrl("https://api.x.ai/v1/") !== "https://api.x.ai/v1/models") problems.push("models url");
  if (modelsUrl("https://example.com/v1/models") !== "https://example.com/v1/models") {
    problems.push("models url already complete");
  }
  const ids = modelIds({ data: [{ id: "grok-4.7" }, { id: " grok-4 " }, { id: "grok-4.7" }, { id: "" }] });
  if (!ids || ids.join(",") !== "grok-4.7,grok-4") problems.push("model ids");
  if (escapeHtml("<b>") !== "&lt;b&gt;") problems.push("escapeHtml");
  const labels = [];
  const menu = Menu.getApplicationMenu();
  if (menu) {
    menu.items.forEach((item) => item.submenu && item.submenu.items.forEach((child) => labels.push(child.label)));
  }
  if (!labels.includes("AI Setup…")) problems.push("menu missing AI Setup");
  if (!labels.includes("Copy")) problems.push("edit menu missing");
  if (problems.length) {
    console.error(problems.join("\n"));
    return 1;
  }
  console.log("AI_SELFTEST_OK");
  return 0;
}

function revealShell(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

function hideShell(win) {
  if (!win || win.isDestroyed()) return;
  let hidden = false;
  const hide = () => {
    if (hidden || win.isDestroyed()) return;
    hidden = true;
    win.hide();
  };
  // A fullscreen window on macOS ignores hide until it has left fullscreen.
  if (win.isFullScreen()) {
    win.once("leave-full-screen", hide);
    try { win.setFullScreen(false); } catch { hide(); }
    return;
  }
  hide();
}

function openShellWindow() {
  if (shellWindow && !shellWindow.isDestroyed()) {
    revealShell(shellWindow);
    return Promise.resolve(shellWindow);
  }
  if (!shellSession) return Promise.resolve(null);
  if (shellOpening) return shellOpening;
  const session = shellSession;
  shellOpening = createWindow(session.preloadFile, session.mode)
    .then((win) => {
      shellWindow = win;
      win.on("closed", () => {
        if (shellWindow === win) shellWindow = null;
      });
      return win;
    })
    .finally(() => {
      shellOpening = null;
    });
  return shellOpening;
}

function presentShell() {
  openShellWindow().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
  });
}

async function createWindow(preloadFile, mode) {
  const external = mode === "asar";
  let displays = [];
  try { displays = screen.getAllDisplays(); } catch { displays = []; }
  const placed = windowState.place(windowState.read(), displays, {
    width: external ? 1720 : 1200,
    height: external ? 1040 : 800,
  });
  const winOpts = {
    ...placed.bounds,
    title: "Morrow Mail",
    icon: APP_ICON,
    backgroundColor: external ? "#193c34" : "#e7f0e4",
    webPreferences: {
      preload: preloadFile,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };
  if (external && process.platform === "darwin") {
    winOpts.titleBarStyle = "hiddenInset";
    winOpts.trafficLightPosition = { x: 14, y: 16 };
  }
  const win = new BrowserWindow(winOpts);
  if (placed.fullscreen) win.setFullScreen(true);
  else if (placed.maximized) win.maximize();
  trackWindow(win, placed.zoomLevel);
  win.webContents.setWindowOpenHandler(({ url }) => {
    let parsed;
    try { parsed = new URL(url); } catch { return { action: "deny" }; }
    if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
      shell.openExternal(url).catch(() => {});
    }
    return { action: "deny" };
  });
  attachRendererDiagnostics(win.webContents, createDiagnostics(LOG));
  win.on("close", (event) => {
    const action = quitController.onClose(event);
    if (action === "hide") {
      hideShell(win);
      return;
    }
    if (action !== "allow") return;
    try { require("./mail/engine").answer("mail:cancelOAuth", []); } catch { /* mail is not open */ }
  });
  const updateLaunch = process.argv.some(arg => arg.startsWith("--morrow-update-receipt="));
  let rendererReady = false;
  const onUpdateReady = event => {
    if (event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame) rendererReady = true;
  };
  if (updateLaunch) ipcMain.on("host:updateStartupReady", onUpdateReady);
  try {
    if (external) await win.loadURL("morrow://local/index.html#/shell");
    else await win.loadFile(FIRST_PARTY_HTML);
    if (updateLaunch) {
      const deadline = Date.now() + 30000;
      while (!rendererReady) {
        if (win.isDestroyed() || Date.now() >= deadline) throw new Error("Updated application did not finish initialization.");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  } finally { ipcMain.removeListener("host:updateStartupReady", onUpdateReady); }
  if (!external) win.setTitle("Morrow Mail");
  return win;
}

// Scheduled mail leaves only while this process is alive. The first before-quit
// is held for the dialog; cleanup then quits again, and that second quit exits.
const quitScheduled = require("./quit-scheduled");

function listScheduledRows() {
  const result = require("./mail/engine").answer("mail:listScheduled", []);
  if (result === undefined) return [];
  if (!result || result.success !== true || !Array.isArray(result.data)) {
    throw new Error("Scheduled mail could not be checked.");
  }
  return result.data;
}

function shellCanPrompt(win) {
  return !!(win && !win.isDestroyed() && win.isVisible() && win.webContents && !win.webContents.isDestroyed() && !win.webContents.isLoading());
}

function fromShellFrame(win, event) {
  return shellCanPrompt(win) && event && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
}

function rendererQuitChoice(win, prompt) {
  if (!shellCanPrompt(win)) return Promise.resolve("unavailable");
  const nonce = require("crypto").randomUUID();
  const payload = { nonce, ...quitScheduled.promptPayload(prompt) };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (choice) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener("app:quitScheduledChoice", onChoice);
      ipcMain.removeListener("app:quitScheduledShown", onShown);
      win.removeListener("closed", onClosed);
      resolve(choice);
    };
    const onChoice = (event, body) => {
      if (!fromShellFrame(win, event) || !body || body.nonce !== nonce) return;
      finish(body.choice === "quit" || body.choice === "view" ? body.choice : "stay");
    };
    const onShown = (event, body) => {
      if (!fromShellFrame(win, event) || !body || body.nonce !== nonce) return;
      clearTimeout(timer);
    };
    const onClosed = () => finish("stay");
    const timer = setTimeout(() => {
      try {
        if (!win.isDestroyed()) win.webContents.send("app:dismissQuitScheduled", { nonce });
      } catch { /* the native dialog still offers the same choice */ }
      finish("unavailable");
    }, 2000);
    ipcMain.on("app:quitScheduledChoice", onChoice);
    ipcMain.on("app:quitScheduledShown", onShown);
    win.once("closed", onClosed);
    try {
      win.webContents.send("app:confirmQuitScheduled", payload);
    } catch {
      finish("unavailable");
    }
  });
}

async function nativeQuitChoice(prompt) {
  const { dialog } = require("electron");
  const options = quitScheduled.nativeDialogOptions(prompt);
  const parent = shellWindow && !shellWindow.isDestroyed() && shellWindow.isVisible() ? shellWindow : null;
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return quitScheduled.nativeResponseChoice(result && result.response);
}

async function requestQuitChoice(prompt) {
  // Cmd+Q from a hidden or minimized window still shows the in-app confirm.
  revealShell(shellWindow);
  let updateClosed = false;
  try { updateClosed = require("./update-quiescence").gate.closed; } catch { updateClosed = false; }
  if (!updateClosed) {
    const rendered = await rendererQuitChoice(shellWindow, prompt);
    if (rendered === "quit" || rendered === "stay" || rendered === "view") return rendered;
  }
  return nativeQuitChoice(prompt);
}

function scheduledQuitTime(when) {
  try {
    const display = require("../shared/display-format");
    const settings = require("./settings");
    const prefs = {
      timeFormat: settings.answer("morrow:configGetTimeFormat", []),
      dateFormat: settings.answer("morrow:configGetDateFormat", []),
    };
    const text = display.formatDateTime(when, prefs);
    let zone = "";
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { zone = ""; }
    return text + (zone ? " (" + zone + ")" : "");
  } catch {
    let zone = "";
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { zone = ""; }
    return when.toLocaleString() + (zone ? " (" + zone + ")" : "");
  }
}

const quitController = quitScheduled.createQuitController({
  listRows: listScheduledRows,
  requestChoice: requestQuitChoice,
  quitApp: () => app.quit(),
  cleanup: async () => {
    try { await require("./bot/server").stop(); } catch { /* the bridge is already stopped */ }
    try { await require("./mail/engine").stopIdle(); } catch { /* mail is not open */ }
  },
  platform: process.platform,
  format: scheduledQuitTime,
});

app.on("before-quit", (event) => {
  quitController.onBeforeQuit(event);
});

app.on("will-quit", () => {
  try { updater.stopPeriodicCheck(); } catch { /* updater timers are already cleared */ }
});

// Subscribing replaces Electron's default, which quits on every platform when
// the last window closes. macOS stays running; Windows and Linux still quit.
app.on("window-all-closed", () => {
  if (!quitScheduled.hidesWindowOnClose(process.platform)) app.quit();
});

let bootWindow = null;
let bootFinished = false;
let bootFailed = false;

function mailboxFile() {
  const override = (process.env.MORROW_MAIL_DIR || "").trim();
  if (override) return path.join(override, "mail.sqlite");
  try { return path.join(app.getPath("userData"), "mail.sqlite"); } catch { return ""; }
}

function dismissBootWindow() {
  bootFinished = true;
  process.off("unhandledRejection", onBootRejection);
  const win = bootWindow;
  bootWindow = null;
  if (win && !win.isDestroyed()) win.close();
}

async function presentBootStatus() {
  if (bootWindow && !bootWindow.isDestroyed()) return bootWindow;
  const win = new BrowserWindow({
    width: 480,
    height: 420,
    title: "Morrow Mail",
    show: true,
    autoHideMenuBar: true,
    backgroundColor: "#e7f0e4",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  bootWindow = win;
  win.on("closed", () => {
    if (bootWindow === win) bootWindow = null;
    if (!bootFinished && !bootFailed) app.quit();
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(startupStatusHtml())}`);
  if (!win.isDestroyed()) win.show();
  return win;
}

async function presentBootFailure(error) {
  if (bootFailed) return;
  bootFailed = true;
  process.off("unhandledRejection", onBootRejection);
  console.error(error instanceof Error ? error.stack || error.message : error);
  const parent = bootWindow && !bootWindow.isDestroyed() ? bootWindow : undefined;
  try {
    const options = startupFailureDialog(error, mailboxFile());
    if (parent) await dialog.showMessageBox(parent, options);
    else await dialog.showMessageBox(options);
  } catch (dialogError) {
    console.error(dialogError instanceof Error ? dialogError.message : dialogError);
  }
  app.quit();
}

function onBootRejection(reason) {
  if (bootFinished || bootFailed) return;
  const shellUp = BrowserWindow.getAllWindows().some((win) => win !== bootWindow && !win.isDestroyed() && win.isVisible());
  if (shellUp) return;
  presentBootFailure(reason instanceof Error ? reason : new Error(String(reason))).catch((failure) => {
    console.error(failure instanceof Error ? failure.message : failure);
    app.exit(1);
  });
}

app.whenReady().then(async () => {
  if (!singleInstance) {
    app.exit(0);
    return;
  }
  applyDockIcon();
  installMenu();
  registerHostAi();
  updater.configureInstall({
    getWindow: () => shellWindow,
    async prepare() {
      if (externalAsarPath() || BrowserWindow.getAllWindows().some(w => w !== shellWindow)) {
        throw new Error("Close other application windows before installing an update.");
      }
      const resumeRenderer = await requestRendererQuiescence(shellWindow, ipcMain);
      const resume = () => {
        updateGate.resume(); resumeRenderer();
        try { startBackgroundSync(); } catch { /* normal sync can resume */ }
        require("./bot/server").startIfEnabled().catch(() => {});
      };
      try {
        await updateGate.prepare();
        await require("./bot/server").stop();
        await require("./mail/engine").stopIdle();
        await require("./mail/db").checkpoint();
      } catch (error) {
        resume();
        throw error;
      }
      return resume;
    },
    quit: () => app.quit(),
  });
  updater.registerIpc();
  updater.init();
  if (process.env.MORROW_AI_SELFTEST === "1") {
    const code = runAiSelfTest();
    app.exit(code);
    return;
  }
  if (process.platform === "darwin" && app.isPackaged) {
    await require("./update-launcher").registerStartup({
      argv: process.argv, target: path.resolve(process.resourcesPath, "..", ".."), version: app.getVersion(),
    });
  }
  const interactiveBoot = process.env.MORROW_MAIL_SELFTEST !== "1" && process.env.MORROW_MAIL_LIVE !== "1";
  if (interactiveBoot) {
    process.on("unhandledRejection", onBootRejection);
    try { await presentBootStatus(); } catch (error) { console.error(error instanceof Error ? error.message : error); }
  }
  try {
    await initMail();
  } catch (error) {
    if (!interactiveBoot) {
      console.error(error instanceof Error ? error.stack || error.message : error);
      app.exit(1);
      return;
    }
    await presentBootFailure(error);
    return;
  }
  if (process.env.MORROW_MAIL_SELFTEST === "1") {
    const code = await require("./mail/selftest").run();
    app.exit(code);
    return;
  }
  if (process.env.MORROW_MAIL_LIVE === "1") {
    const code = await require("./mail/livetest").run();
    app.exit(code);
    return;
  }
  try {
    const asarPath = externalAsarPath();
    let preloadFile = FIRST_PARTY_PRELOAD;
    let mode = "bundled";
    if (asarPath) {
      archive = openAsar(asarPath);
      extractPreload();
      registerProtocol();
      preloadFile = PRELOAD_OUT;
      mode = "asar";
    }
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: details.responseHeaders });
    });
    shellSession = { preloadFile, mode };
    composeWindows.createComposeHost({
      getParent: () => shellWindow,
      preloadFile: () => shellSession && shellSession.preloadFile,
      mode: () => shellSession && shellSession.mode,
      htmlFile: FIRST_PARTY_HTML,
      icon: APP_ICON,
      backgroundColor: () => (shellSession && shellSession.mode === "asar" ? "#193c34" : "#e7f0e4"),
    }).register();
    readerWindows.createReaderHost({
      getParent: () => shellWindow,
      preloadFile: () => shellSession && shellSession.preloadFile,
      mode: () => shellSession && shellSession.mode,
      htmlFile: FIRST_PARTY_HTML,
      icon: APP_ICON,
      backgroundColor: () => (shellSession && shellSession.mode === "asar" ? "#193c34" : "#e7f0e4"),
    }).register();
    translateWindows.createTranslateHost({
      getParent: () => shellWindow,
      preloadFile: () => shellSession && shellSession.preloadFile,
      mode: () => shellSession && shellSession.mode,
      htmlFile: FIRST_PARTY_HTML,
      icon: APP_ICON,
      backgroundColor: () => (shellSession && shellSession.mode === "asar" ? "#193c34" : "#e7f0e4"),
    }).register();
    attachIpc(preloadFile);
    const win = await openShellWindow();
    if (!win) throw new Error("Morrow Mail could not open its window.");
    dismissBootWindow();
    if (process.platform === "darwin" && app.isPackaged) {
      await require("./update-launcher").acknowledge({
        argv: process.argv, target: path.resolve(process.resourcesPath, "..", ".."), version: app.getVersion(),
      });
    }
    startBackgroundSync();
    try { await require("./bot/server").startIfEnabled(); } catch { /* a missing grant leaves the bridge off */ }
    try {
      powerMonitor.on("suspend", () => {
        try { require("./mail/engine").idleSleep(); } catch { /* mail is not open */ }
      });
      powerMonitor.on("resume", () => {
        try { require("./mail/engine").idleWake(); } catch { /* mail is not open */ }
      });
    } catch { /* this platform does not emit power events */ }
    try { require("./brain").scheduleLivingRefresh(); } catch { /* brain store is optional at boot */ }
    try { require("./agent").startSkillScheduler(); } catch { /* skill schedules are optional at boot */ }
    if (process.env.MORROW_BOOT_EXIT === "1") {
      setTimeout(async () => {
        try {
          const info = await win.webContents.executeJavaScript(`({
            href: location.href,
            title: document.title,
            text: (document.body && document.body.innerText || "").slice(0, 1800)
          })`);
          fs.writeFileSync(path.join(path.dirname(LOG), "boot.json"), JSON.stringify(info, null, 2));
          const image = await win.webContents.capturePage();
          fs.writeFileSync(path.join(path.dirname(LOG), "boot.png"), image.toPNG());
          console.log("BOOT_TEXT_START");
          console.log(info.text);
          console.log("BOOT_TEXT_END");
          await win.webContents.executeJavaScript(`(() => {
            const row = document.querySelector('[data-testid="mail-list-message-row"]');
            if (row) row.click();
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 800));
          const readerImage = await win.webContents.capturePage();
          fs.writeFileSync(path.join(path.dirname(LOG), "reader.png"), readerImage.toPNG());
          await win.webContents.executeJavaScript(`(() => {
            const button = [...document.querySelectorAll("button")].find((el) => (el.innerText || "").includes("New Mail"));
            if (button) button.click();
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 800));
          const composeImage = await win.webContents.capturePage();
          fs.writeFileSync(path.join(path.dirname(LOG), "compose.png"), composeImage.toPNG());
          const composeText = await win.webContents.executeJavaScript(`(document.body && document.body.innerText || "").slice(0, 2200)`);
          console.log("COMPOSE_TEXT_START");
          console.log(composeText);
          console.log("COMPOSE_TEXT_END");
          await win.webContents.executeJavaScript(`(() => {
            const button = document.getElementById("rail-brain");
            if (button) button.click();
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const brainText = await win.webContents.executeJavaScript(`(document.body && document.body.innerText || "").slice(0, 2200)`);
          fs.writeFileSync(path.join(path.dirname(LOG), "brain.txt"), brainText);
          const brainImage = await win.webContents.capturePage();
          fs.writeFileSync(path.join(path.dirname(LOG), "brain.png"), brainImage.toPNG());
          console.log("BRAIN_TEXT_START");
          console.log(brainText);
          console.log("BRAIN_TEXT_END");
          await win.webContents.executeJavaScript(`(() => {
            const tab = document.getElementById("brain-tab-skills");
            if (tab) tab.click();
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 300));
          const skillsText = await win.webContents.executeJavaScript(`(document.getElementById("brain-skills") && document.getElementById("brain-skills").innerText || "").slice(0, 1200)`);
          fs.writeFileSync(path.join(path.dirname(LOG), "skills.txt"), skillsText);
          const skillsImage = await win.webContents.capturePage();
          fs.writeFileSync(path.join(path.dirname(LOG), "skills.png"), skillsImage.toPNG());
          console.log("SKILLS_TEXT_START");
          console.log(skillsText);
          console.log("SKILLS_TEXT_END");
          await win.webContents.executeJavaScript(`(() => {
            const button = document.querySelector("#brain-home-skills button");
            if (button) button.click();
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 500));
          const skillStatus = await win.webContents.executeJavaScript(`(document.getElementById("brain-skill-status") && document.getElementById("brain-skill-status").innerText || "")`);
          console.log("SKILL_RUN_STATUS_START");
          console.log(skillStatus);
          console.log("SKILL_RUN_STATUS_END");
          const skillRunImage = await win.webContents.capturePage();
          fs.writeFileSync(path.join(path.dirname(LOG), "skill-run.png"), skillRunImage.toPNG());
          await win.webContents.executeJavaScript(`(() => {
            for (const open of document.querySelectorAll("dialog[open]")) open.close();
            const button = document.getElementById("rail-agent");
            if (button) button.click();
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 800));
          const studioText = await win.webContents.executeJavaScript(`(document.body && document.body.innerText || "").slice(0, 2200)`);
          fs.writeFileSync(path.join(path.dirname(LOG), "studio.txt"), studioText);
          const studioImage = await win.webContents.capturePage();
          fs.writeFileSync(path.join(path.dirname(LOG), "studio.png"), studioImage.toPNG());
          console.log("STUDIO_TEXT_START");
          console.log(studioText);
          console.log("STUDIO_TEXT_END");
          await win.webContents.executeJavaScript(`(() => {
            const button = document.querySelector('[aria-label="Mail"]');
            if (button) button.click();
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 600));
        } catch (error) {
          console.error("capture failed", error);
        }
        app.exit(0);
      }, 8000);
    }
  } catch (error) {
    if (interactiveBoot) {
      await presentBootFailure(error);
      return;
    }
    console.error(error instanceof Error ? error.message : error);
    app.exit(1);
  }
});
