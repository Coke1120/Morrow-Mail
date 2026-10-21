// Compose opens in its own window. The mail shell stays usable.
// xvfb-run -a npx electron --no-sandbox scripts/check-compose-window.js
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const composeWindows = require("../host/compose-window");

const root = path.join(__dirname, "..");
const outDir = process.env.MORROW_SHOT_DIR || "/opt/cursor/artifacts";
const preloadFile = path.join(root, "renderer", "preload.js");
const htmlFile = path.join(root, "renderer", "index.html");

const message = {
  id: "msg-engine",
  accountId: "acct-ada",
  folderId: "inbox",
  threadId: "thread-engine",
  messageId: "<engine@analytical.example>",
  from: "Charles Babbage <charles.babbage@example.com>",
  to: ["Ada Lovelace <ada.lovelace@example.com>"],
  cc: [],
  subject: "Notes on the Analytical Engine",
  date: "2026-10-12T15:04:00.000Z",
  unread: false,
  snippet: "The table of operations is ready for a second reading.",
  textBody: "The table of operations is ready for a second reading.",
  htmlBody: "<p>The table of operations is ready for a second reading.</p>",
  attachments: [],
};

const account = {
  id: "acct-ada",
  email: "ada.lovelace@example.com",
  name: "Ada Lovelace",
  platform: "imap",
  imapSmtpProfile: "custom",
  folders: {
    primary: [
      { id: "inbox", name: "Inbox", wellKnownName: "inbox", chip: true },
      { id: "sent", name: "Sent", wellKnownName: "sent", chip: true },
      { id: "drafts", name: "Drafts", wellKnownName: "drafts", chip: true },
    ],
    more: [],
  },
};

const composeContext = {
  fromAddress: "ada.lovelace@example.com",
  sendAs: [{ email: "ada.lovelace@example.com", source: "account" }],
  selfAddresses: ["ada.lovelace@example.com"],
  domain: "example.com",
  policyDomain: "example.com",
  defaultCc: [],
  defaultBcc: [],
  receivedAddress: "ada.lovelace@example.com",
  fallback: false,
  settings: { ccByDomain: {}, bccByDomain: {}, accounts: {} },
};

const sentChannels = [];

function envelope(data) {
  return { success: true, data };
}

function answer(channel, payload) {
  sentChannels.push(channel);
  if (channel === "app:getVersion") return "0.2.23-test";
  if (channel === "host:updateGetState" || channel === "host:updateCheck" || channel === "host:updateInstall" || channel === "host:updateManual") return { enabled: false };
  if (channel === "config:getTheme" || channel === "config:setTheme") return "light";
  if (channel === "morrow:configGetAccent" || channel === "morrow:configSetAccent") return "#193C34";
  if (channel === "morrow:configGetUndoSendDelaySeconds" || channel === "morrow:configSetUndoSendDelaySeconds") return 30;
  if (channel === "morrow:configGetComposeQuoteWidth" || channel === "morrow:configSetComposeQuoteWidth") return 420;
  if (channel === "morrow:configGetLayoutPanes" || channel === "morrow:configSetLayoutPanes") return { folders: 260, list: 360, reading: 0 };
  if (channel === "morrow:configGetSyncHorizonDays" || channel === "morrow:configSetSyncHorizonDays") return 180;
  if (channel === "morrow:configGetDefaultScheduleDelayMinutes" || channel === "morrow:configSetDefaultScheduleDelayMinutes") return 0;
  if (channel === "morrow:configGetSidebarCollapsedFolders" || channel === "morrow:configSetSidebarCollapsedFolders") return {};
  if (channel.includes("configGet") || channel.startsWith("config:get")) return false;
  if (channel.includes("configSet") || channel.startsWith("config:set")) return true;
  if (channel.startsWith("host:") || channel.startsWith("app:")) return null;
  return envelope(mailData(channel, payload));
}

function mailData(channel, payload) {
  if (channel === "mail:listAccounts") return [account];
  if (channel === "mail:listFromCache" || channel === "mail:listFromNetwork") return { emails: [message], total: 1, initialSyncDone: true };
  if (channel === "mail:openEmail") return { email: message, threadMessages: [message] };
  if (channel === "mail:getComposeContext") return composeContext;
  if (channel === "mail:listSignatures") return { signatures: [], defaultSignatureId: null, defaultSignaturePerAccount: {} };
  if (channel === "mail:listScheduled" || channel === "mail:listImapSmtpPresets") return [];
  if (channel === "mail:listSnoozed") return { records: [] };
  if (channel === "mail:oauthStatus") return { google: false };
  if (channel === "mail:listProviderFolders") return { api: false, folders: [], reason: "profile" };
  if (channel === "mail:getSyncStatus") return { state: "idle" };
  if (channel === "mail:uploadAttachment") {
    const bytes = payload && payload.fileBytes;
    const size = bytes && (bytes.byteLength || bytes.length) ? (bytes.byteLength || bytes.length) : 5;
    return {
      storageUrl: "local:note",
      filename: (payload && payload.filename) || "note.txt",
      size,
      mimeType: (payload && payload.mimeType) || "text/plain",
    };
  }
  if (channel === "mail:upsertDraft") return { emailId: "draft-1", remoteSaved: true };
  if (channel === "mail:send" || channel === "mail:scheduleSend") return { ok: true };
  if (channel === "aiDraftWrite:replySuggestions") return { suggestions: [] };
  if (channel === "aiDraftWrite:start") return { reqId: payload && payload.reqId };
  if (channel === "aiDraftWrite:cancel") return true;
  return {};
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(win, expression, label) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < 15000) {
    if (win.isDestroyed()) throw new Error(label + " window closed");
    try {
      last = await win.webContents.executeJavaScript(expression, true);
      if (last) return last;
    } catch (error) {
      last = String(error.message || error);
    }
    await sleep(50);
  }
  throw new Error(label + " timed out: " + JSON.stringify(last));
}

function liveWindows() {
  return BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
}

function composeWindowsOpen() {
  return liveWindows().filter((win) => {
    const url = win.webContents.getURL();
    return url.includes("role=compose");
  });
}

async function shot(win, name) {
  fs.mkdirSync(outDir, { recursive: true });
  await sleep(200);
  const file = path.join(outDir, name + ".png");
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  return file;
}

async function closeClean(win) {
  if (win.isDestroyed()) return;
  const closed = new Promise((resolve) => win.once("closed", () => resolve(true)));
  win.close();
  const start = Date.now();
  while (!win.isDestroyed() && Date.now() - start < 8000) {
    const review = await win.webContents.executeJavaScript(`!!(document.getElementById("compose-close-review") && document.getElementById("compose-close-review").open)`, true).catch(() => false);
    if (review) await win.webContents.executeJavaScript(`document.getElementById("draft-close-discard").click()`, true);
    await sleep(40);
  }
  if (!win.isDestroyed()) throw new Error("compose window stayed open");
  await closed;
}

app.disableHardwareAcceleration();
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "morrow-compose-window-")));

const consoleNotes = [];

app.whenReady().then(async () => {
  const host = composeWindows.createComposeHost({
    getParent: () => shellWin,
    preloadFile: () => preloadFile,
    mode: () => "bundled",
    htmlFile,
    backgroundColor: "#e7f0e4",
  });
  host.register();
  const preload = fs.readFileSync(preloadFile, "utf8");
  const channels = new Set();
  for (const match of preload.matchAll(/"([a-zA-Z][\w-]*:[^"\n]{1,180})"/g)) channels.add(match[1]);
  for (const channel of channels) {
    if (composeWindows.CHANNELS.includes(channel)) continue;
    ipcMain.handle(channel, (_event, payload) => answer(channel, payload));
  }

  const shellWin = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    backgroundColor: "#e7f0e4",
    webPreferences: {
      preload: preloadFile,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const watchConsole = (win) => {
    win.webContents.on("console-message", (_event, level, messageText) => {
      if (level >= 2) {
        consoleNotes.push(messageText);
        console.error("[console]", messageText);
      }
    });
  };
  watchConsole(shellWin);
  app.on("browser-window-created", (_event, win) => watchConsole(win));
  await shellWin.loadFile(htmlFile);
  await waitFor(shellWin, `state.accounts && state.accounts.length > 0 && !!state.accountId`, "accounts");
  const shellRole = await shellWin.webContents.executeJavaScript(`document.documentElement.dataset.window || ""`, true);
  assert.equal(shellRole, "");

  await shellWin.webContents.executeJavaScript(`document.getElementById("compose-open").click()`, true);
  await waitFor(shellWin, `document.getElementById("compose").open !== true`, "shell compose stays closed");
  let opened = [];
  const started = Date.now();
  while (Date.now() - started < 15000) {
    opened = [];
    for (const win of composeWindowsOpen()) {
      const ready = await win.webContents.executeJavaScript(`document.documentElement.dataset.window === "compose" && document.getElementById("compose").open && document.getElementById("compose-title").textContent === "New message"`, true).catch(() => false);
      if (ready) opened.push(win);
    }
    if (opened.length === 1) break;
    await sleep(50);
  }
  assert.equal(opened.length, 1, "new mail opens one compose window");
  const shellShot = await shot(shellWin, "compose-window-shell");
  shellWin.focus();
  shellWin.webContents.focus();
  const active = await shellWin.webContents.executeJavaScript(`
    const input = document.getElementById("search-query");
    input.focus();
    document.activeElement && document.activeElement.id
  `, true);
  assert.equal(active, "search-query");
  const beforeSettings = liveWindows().length;
  await shellWin.webContents.executeJavaScript(`document.getElementById("settings-open").click()`, true);
  await waitFor(shellWin, `document.getElementById("settings").open === true`, "settings");
  assert.equal(liveWindows().length, beforeSettings, "settings stays in the mail window");
  await shellWin.webContents.executeJavaScript(`document.getElementById("settings-close").click()`, true);
  await waitFor(shellWin, `document.getElementById("settings").open !== true`, "settings closed");

  const firstId = opened[0].webContents.id;
  await shellWin.webContents.executeJavaScript(`document.getElementById("compose-open").click()`, true);
  let second = null;
  const secondStart = Date.now();
  while (Date.now() - secondStart < 15000) {
    for (const win of composeWindowsOpen()) {
      if (win.webContents.id === firstId) continue;
      const ready = await win.webContents.executeJavaScript(`document.getElementById("compose").open`, true).catch(() => false);
      if (ready) second = win;
    }
    if (second) break;
    await sleep(50);
  }
  assert.ok(second, "a second compose window opens");
  await closeClean(second);
  assert.equal(composeWindowsOpen().length, 1);

  const dirty = composeWindowsOpen()[0];
  dirty.focus();
  await waitFor(dirty, `state.composeInitializing === false && document.getElementById("compose").open === true`, "compose ready");
  await dirty.webContents.executeJavaScript(`
    const field = document.getElementById("compose-to");
    field.value = "grace@example.com";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  `, true);
  dirty.close();
  await waitFor(dirty, `document.getElementById("compose-close-review").open === true`, "dirty confirm");
  const discardShot = await shot(dirty, "compose-window-discard");
  await dirty.webContents.executeJavaScript(`document.getElementById("draft-close-keep").click()`, true);
  await sleep(200);
  assert.equal(dirty.isDestroyed(), false);
  const stillOpen = await dirty.webContents.executeJavaScript(`document.getElementById("compose").open === true`, true);
  assert.equal(stillOpen, true);
  dirty.close();
  await waitFor(dirty, `document.getElementById("compose-close-review").open === true`, "dirty confirm again");
  await dirty.webContents.executeJavaScript(`document.getElementById("draft-close-discard").click()`, true);
  const gone = Date.now();
  while (!dirty.isDestroyed() && Date.now() - gone < 8000) await sleep(40);
  assert.equal(dirty.isDestroyed(), true);
  assert.equal(composeWindowsOpen().length, 0);

  await shellWin.webContents.executeJavaScript(`presentCompose({
    kind: "reply",
    title: "Reply",
    accountId: state.accountId,
    to: "charles.babbage@example.com",
    subject: "Re: Notes",
    quote: "The table of operations is ready.",
    quoteShown: true,
    quoteEmail: { from: "Charles Babbage <charles.babbage@example.com>", subject: "Notes", textBody: "The table of operations is ready." },
    aiWrite: true,
    sourceMessageId: "msg-engine"
  })`, true);
  let reply = null;
  const replyStart = Date.now();
  while (Date.now() - replyStart < 15000) {
    for (const win of composeWindowsOpen()) {
      const ready = await win.webContents.executeJavaScript(`state.composeInitializing === false && document.getElementById("compose").open && document.getElementById("compose").dataset.quote === "shown" && (document.getElementById("compose-quote").textContent || "").includes("table of operations")`, true).catch(() => false);
      if (ready) reply = win;
    }
    if (reply) break;
    await sleep(50);
  }
  assert.ok(reply, "reply opens a compose window with the quote");
  const shellStillClosed = await shellWin.webContents.executeJavaScript(`document.getElementById("compose").open === false`, true);
  assert.equal(shellStillClosed, true);
  await waitFor(reply, `document.title.includes("Reply")`, "reply title");
  assert.ok(reply.getTitle().includes("Reply"));
  const replyShot = await shot(reply, "compose-window-reply");
  await reply.webContents.executeJavaScript(`
    const editor = document.getElementById("compose-editor");
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    editor.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  `, true);
  await waitFor(reply, `(document.getElementById("compose-attachments").textContent || "").includes("note.txt")`, "dropped attachment");
  await reply.webContents.executeJavaScript(`
    const field = document.getElementById("compose-to");
    if (!field.value.trim()) field.value = "charles.babbage@example.com";
    document.getElementById("compose-send").click();
  `, true);
  await waitFor(reply, `document.getElementById("compose-preview").open === true`, "send preview");
  await reply.webContents.executeJavaScript(`document.getElementById("compose-preview-confirm").click()`, true);
  await waitFor(reply, `document.getElementById("undo-send").hidden === false && document.getElementById("compose").open === false`, "undo send");
  const undoShot = await shot(reply, "compose-window-undo");
  await reply.webContents.executeJavaScript(`document.getElementById("undo-send").click()`, true);
  await waitFor(reply, `document.getElementById("compose").open === true && document.getElementById("undo-send").hidden === true`, "undo restores the draft");
  assert.equal(sentChannels.filter((channel) => channel === "mail:send").length, 0);

  console.log(JSON.stringify({ ok: true, shots: [shellShot, discardShot, replyShot, undoShot], consoleNotes }));
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
