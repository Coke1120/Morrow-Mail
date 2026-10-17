const { app, BrowserWindow, protocol, ipcMain, session, Menu } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openAsar, readFile } = require("./asar");
const { createIpc } = require("./ipc");
const { publicConfig, saveConfig, completionsUrl, DEFAULTS } = require("./ai-config");
const { complete, extractJson } = require("./openai-client");
const { init: initMail, startBackgroundSync } = require("./mail/engine");
const { answer: brainAnswer } = require("./brain");
const { answer: draftAnswer, escapeHtml } = require("./draft-write");

const LOG = path.join(os.homedir(), ".hermes/tmp/genmail-exact/2026-10-16/ipc.log");
const { preloadPath } = require("./paths");
const PRELOAD_OUT = preloadPath();
const FIRST_PARTY_DIR = path.join(__dirname, "..", "renderer");
const FIRST_PARTY_PRELOAD = path.join(FIRST_PARTY_DIR, "preload.js");
const FIRST_PARTY_HTML = path.join(FIRST_PARTY_DIR, "index.html");
const updater = require("./updater");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "genmail",
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
  protocol.handle("genmail", (request) => {
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
  return (process.env.GENMAIL_ASAR || "").trim();
}

function attachIpc(preloadFile) {
  if (!fs.existsSync(preloadFile)) {
    throw new Error(`Renderer preload missing at ${preloadFile}`);
  }
  const bus = createIpc(LOG);
  fs.writeFileSync(LOG, "");
  const src = fs.readFileSync(preloadFile, "utf8");
  const channels = new Set();
  for (const match of src.matchAll(/"([a-zA-Z][\w-]*:[^"\n]{1,180})"/g)) {
    channels.add(match[1]);
  }
  fs.appendFileSync(LOG, `# channels ${channels.size}\n`);
  // updater.registerIpc already owns these. A second ipcMain.handle throws.
  const directHost = new Set(updater.CHANNELS);
  for (const channel of channels) {
    if (directHost.has(channel)) continue;
    ipcMain.handle(channel, (event, ...args) => bus.handle(event, channel, ...args));
    ipcMain.on(channel, (event, ...args) => {
      bus.send(event, channel, ...args);
      // sendSync reads event.returnValue. Leaving it unset comes back as an
      // object, and locale resolution calls .split on that.
      event.returnValue = bus.handle(event, channel, ...args);
    });
  }
}

let setupWindow = null;

function openAiSetup() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 560,
    height: 520,
    title: "AI Setup",
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
  setupWindow.loadFile(path.join(__dirname, "ai-setup.html"));
}

function installMenu() {
  const template = [
    {
      label: "GenMail",
      submenu: [
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
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerHostAi() {
  ipcMain.handle("host:aiGetConfig", () => publicConfig());
  ipcMain.handle("host:aiSaveConfig", (_event, input) => saveConfig(input));
  ipcMain.handle("host:aiTest", async () => {
    try {
      const text = await complete([
        { role: "system", content: "Reply with one short sentence and nothing else." },
        { role: "user", content: "Say hello in five words or fewer." },
      ], { temperature: 0 });
      const preview = String(text).replace(/\s+/g, " ").trim().slice(0, 160);
      return { ok: true, preview: preview || "The model returned an empty reply." };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
}

function runAiSelfTest() {
  const problems = [];
  const pub = publicConfig();
  if (Object.prototype.hasOwnProperty.call(pub, "apiKey")) problems.push("public config includes apiKey");
  if (typeof pub.hasKey !== "boolean") problems.push("public config missing hasKey");
  if (!process.env.GENMAIL_AI_BASE_URL && pub.baseUrl !== DEFAULTS.baseUrl) problems.push(`base ${pub.baseUrl}`);
  if (!process.env.GENMAIL_AI_MODEL && pub.model !== DEFAULTS.model) problems.push(`model ${pub.model}`);
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

async function createWindow(preloadFile, mode) {
  const external = mode === "asar";
  const winOpts = {
    width: external ? 1720 : 1200,
    height: external ? 1040 : 800,
    title: "GenMail REA",
    backgroundColor: external ? "#4c1d95" : "#f6f3fb",
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
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const text = `[console ${level}] ${message} (${sourceId}:${line})`;
    fs.appendFileSync(LOG, text + "\n");
    if (level >= 2) console.error(text);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    const text = `[fail-load] ${code} ${desc} ${url}`;
    fs.appendFileSync(LOG, text + "\n");
    console.error(text);
  });
  if (external) await win.loadURL("genmail://local/index.html#/shell");
  else await win.loadFile(FIRST_PARTY_HTML);
  return win;
}

app.whenReady().then(async () => {
  installMenu();
  registerHostAi();
  updater.registerIpc();
  updater.init();
  if (process.env.GENMAIL_AI_SELFTEST === "1") {
    const code = runAiSelfTest();
    app.exit(code);
    return;
  }
  await initMail();
  if (process.env.GENMAIL_MAIL_SELFTEST === "1") {
    const code = await require("./mail/selftest").run();
    app.exit(code);
    return;
  }
  if (process.env.GENMAIL_MAIL_LIVE === "1") {
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
    attachIpc(preloadFile);
    const win = await createWindow(preloadFile, mode);
    startBackgroundSync();
    if (process.env.GENMAIL_BOOT_EXIT === "1") {
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
            const button = document.querySelector('[aria-label="Email Brain"]');
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
            const section = document.getElementById("brain-skills");
            if (section) section.scrollIntoView({ block: "start" });
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
            const button = document.getElementById("agent-open");
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
    console.error(error instanceof Error ? error.message : error);
    app.exit(1);
  }
});
