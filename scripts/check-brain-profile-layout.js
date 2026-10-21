// Profile summary holds Refresh and Rebuild beside the persona stats.
// xvfb-run -a npx electron --no-sandbox scripts/check-brain-profile-layout.js
// executeJavaScript results must be cloneable (string, number, boolean). A trailing
// function assignment is returned as the script result and fails the IPC clone.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.join(__dirname, "..");
const outDir = process.env.MORROW_SHOT_DIR || "/opt/cursor/artifacts";
const preloadPath = path.join(os.tmpdir(), "morrow-brain-profile-preload.js");

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

const persona = {
  persona: {
    updatedAt: "2026-10-21T12:00:00.000Z",
    recentActivity: [{ id: "act-1", kind: "refresh", at: "2026-10-21T12:00:00.000Z", detail: "Distilled from 2 sent and 1 inbox messages." }],
    profile: {
      meta: {
        ownerName: "Ada Lovelace",
        emailsAnalyzed: 12,
        factsLearned: 7,
        updatedAt: "2026-10-21T12:00:00.000Z",
      },
      sections: [{
        id: "how-you-write",
        title: "How you write",
        kind: "rows",
        rows: [
          { id: "how-you-write:user:1", value: "Keep replies short.", source: "user" },
          { id: "how-you-write:0", label: "Tone", value: "Direct and brief.", source: "auto" },
        ],
      }],
    },
  },
  fetchedAt: "2026-10-21T12:00:00.000Z",
};

fs.writeFileSync(preloadPath, `
const { contextBridge } = require("electron");
const sent = [];
const listeners = {};
const account = ${JSON.stringify(account)};
const persona = ${JSON.stringify(persona)};
function envelope(data) { return { success: true, data: data }; }
function raw(channel) {
  if (channel === "app:getVersion") return "0.2.22";
  if (channel === "host:aiGetConfig") return { hasKey: true, baseUrl: "https://example.test", model: "fixture" };
  if (channel === "host:updateGetState" || channel === "host:updateCheck" || channel === "host:updateInstall") return { enabled: false };
  if (channel === "config:getTheme") return "light";
  if (channel === "morrow:configGetAccent") return "#193C34";
  if (channel === "morrow:configGetUndoSendDelaySeconds") return 0;
  if (channel === "morrow:configGetAutoLoadRemoteImages") return false;
  if (channel === "morrow:configGetAiWriteAutoOpenOnReply") return false;
  if (channel === "morrow:configGetSidebarOutlookFoldersExpanded") return false;
  if (channel === "morrow:configGetSnoozeEffective") return true;
  if (channel === "morrow:configGetConversationViewEnabled") return true;
  if (channel === "morrow:configGetShowFolderChips") return true;
  if (channel === "morrow:configGetSidebarGmailFoldersExpanded") return true;
  if (channel.indexOf("configGet") >= 0 || channel.indexOf("config:get") === 0) return false;
  if (channel.indexOf("configSet") >= 0 || channel.indexOf("config:set") === 0) return true;
  return null;
}
contextBridge.exposeInMainWorld("morrow", {
  invoke(channel, payload) {
    sent.push({ channel: channel, payload: payload });
    if (channel === "host:aiGetConfig") return Promise.resolve(raw(channel));
    const direct = raw(channel);
    if (direct !== null || channel.indexOf("config") >= 0 || channel.indexOf("app:") === 0 || channel.indexOf("host:") === 0) {
      return Promise.resolve(channel.indexOf("config") >= 0 || channel.indexOf("app:") === 0 || channel.indexOf("host:") === 0 ? raw(channel) : direct);
    }
    if (channel === "mail:listAccounts") return Promise.resolve(envelope([account]));
    if (channel === "mail:listFromCache" || channel === "mail:listFromNetwork") return Promise.resolve(envelope({ emails: [] }));
    if (channel === "mail:listScheduled" || channel === "mail:listImapSmtpPresets") return Promise.resolve(envelope([]));
    if (channel === "mail:listSnoozed") return Promise.resolve(envelope({ records: [] }));
    if (channel === "mail:oauthStatus") return Promise.resolve(envelope({ google: false }));
    if (channel === "mail:listProviderFolders") return Promise.resolve(envelope({ api: false, reason: "profile", folders: [] }));
    if (channel === "emailBrain:getCached") return Promise.resolve(envelope(persona));
    if (channel === "emailBrain:getCategories") return Promise.resolve(envelope({ categories: [], defaultCategories: [] }));
    if (channel === "emailBrain:getSkills" || channel === "emailBrain:getLibrarySkills") return Promise.resolve(envelope([]));
    if (channel === "emailBrain:refresh") {
      const cached = !(payload && payload.source === "manual");
      return Promise.resolve(envelope({ accepted: true, mode: "refresh", cached: cached }));
    }
    if (channel === "emailBrain:rebuild") return Promise.resolve(envelope({ accepted: true, mode: "rebuild" }));
    return Promise.resolve(envelope(null));
  },
  on(channel, callback) {
    listeners[channel] = callback;
    return function () {};
  },
});
contextBridge.exposeInMainWorld("morrowShot", {
  sent() {
    const rows = sent.map((row) => ({
      channel: String(row && row.channel || ""),
      source: row && row.payload && row.payload.source ? String(row.payload.source) : "",
    }));
    return JSON.stringify(rows);
  },
  emit(channel, payload) {
    const fn = listeners[channel];
    if (typeof fn !== "function") return "missing";
    try {
      const value = fn(payload);
      return "called " + typeof value;
    } catch (error) {
      return "threw " + String(error && error.message || error);
    }
  },
});
`);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(win, expression, label) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < 10000) {
    try {
      last = await win.webContents.executeJavaScript("JSON.stringify(!!(" + expression + "))", true);
    } catch (error) {
      throw new Error(label + " script failed: " + (error && error.message));
    }
    if (last === "true") return true;
    await sleep(50);
  }
  throw new Error(label + " timed out: " + JSON.stringify(last));
}

async function shot(win, name) {
  fs.mkdirSync(outDir, { recursive: true });
  await sleep(200);
  const file = path.join(outDir, name + ".png");
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(file, image.toPNG());
      return file;
    } catch (error) {
      lastError = error;
      console.error("shot retry", name, attempt, error && error.message);
      await sleep(150);
    }
  }
  throw lastError;
}

async function json(win, expression) {
  const code = "(() => { try { return JSON.stringify(" + expression + "); } catch (error) { return JSON.stringify({ __error: String(error && error.message || error) }); } })()";
  let raw;
  try {
    raw = await win.webContents.executeJavaScript(code, true);
  } catch (error) {
    throw new Error("json failed: " + expression.slice(0, 140) + " :: " + (error && error.message));
  }
  if (typeof raw !== "string") throw new Error("expected a JSON string for " + expression.slice(0, 80));
  const parsed = JSON.parse(raw);
  if (parsed && parsed.__error) throw new Error(parsed.__error + " in " + expression.slice(0, 140));
  return parsed;
}

async function measure(win) {
  const summary = 'document.querySelector(".brain-summary")';
  const refresh = 'document.getElementById("brain-refresh")';
  const rebuild = 'document.getElementById("brain-rebuild")';
  const status = 'document.getElementById("brain-status")';
  const form = 'document.getElementById("brain-rule-form")';
  const meta = 'document.getElementById("brain-meta")';
  const progress = 'document.getElementById("brain-progress")';
  const refreshInSummary = await json(win, summary + ".contains(" + refresh + ")");
  const rebuildInSummary = await json(win, summary + ".contains(" + rebuild + ")");
  const statusInSummary = await json(win, summary + ".contains(" + status + ")");
  const progressInSummary = await json(win, summary + ".contains(" + progress + ")");
  const metaInSummary = await json(win, summary + ".contains(" + meta + ")");
  const formHasRefresh = await json(win, '!!document.getElementById("brain-rule-form").querySelector("#brain-refresh")');
  const formHasRebuild = await json(win, '!!document.getElementById("brain-rule-form").querySelector("#brain-rebuild")');
  const metaText = await json(win, meta + ".textContent");
  const hint = await json(win, 'document.getElementById("brain-persona-hint").textContent');
  const statusText = await json(win, status + ".textContent");
  const refreshDisabled = await json(win, refresh + ".disabled");
  const rebuildDisabled = await json(win, rebuild + ".disabled");
  const progressHidden = await json(win, progress + ".hidden");
  const metaBox = await json(win, "((r) => ({ top: r.top, bottom: r.bottom }))(" + meta + ".getBoundingClientRect())");
  const refreshBox = await json(win, "((r) => ({ top: r.top, bottom: r.bottom, left: r.left }))(" + refresh + ".getBoundingClientRect())");
  const rebuildBox = await json(win, "((r) => ({ top: r.top, bottom: r.bottom }))(" + rebuild + ".getBoundingClientRect())");
  const statusBox = await json(win, "((r) => ({ top: r.top, bottom: r.bottom }))(" + status + ".getBoundingClientRect())");
  const formBox = await json(win, "((r) => ({ top: r.top }))(" + form + ".getBoundingClientRect())");
  const statusRects = await json(win, status + ".getClientRects().length");
  const summaryBox = await json(win, "((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }))(" + summary + ".getBoundingClientRect())");
  const statusNearButtons = statusRects === 0 || (statusBox.bottom <= refreshBox.top + 2 && refreshBox.top - statusBox.bottom < 48);
  return {
    refreshInSummary,
    rebuildInSummary,
    statusInSummary,
    progressInSummary,
    metaInSummary,
    formHasActions: formHasRefresh || formHasRebuild,
    metaText,
    hint,
    status: statusText,
    refreshDisabled,
    rebuildDisabled,
    progressHidden,
    sameRow: Math.abs(refreshBox.top - rebuildBox.top) < 6,
    refreshBelowMeta: refreshBox.top >= metaBox.bottom - 2,
    statusNearButtons,
    actionsAboveForm: refreshBox.bottom < formBox.top,
    summary: summaryBox,
  };
}

app.disableHardwareAcceleration();
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "morrow-brain-profile-")));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    show: true,
    backgroundColor: "#193c34",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.webContents.on("console-message", (_event, level, messageText) => {
    if (level >= 2) console.error("[console]", messageText);
  });
  await win.loadFile(path.join(root, "renderer", "index.html"));
  await waitFor(win, `!!(document.getElementById("rail-brain") && document.getElementById("brain-refresh"))`, "rail");
  await win.webContents.executeJavaScript(`document.getElementById("rail-brain").click(); true`, true);
  await waitFor(win, `!!(document.getElementById("brain") && !document.getElementById("brain").hidden && document.getElementById("brain-meta") && document.getElementById("brain-meta").textContent.includes("Ada Lovelace"))`, "profile summary");
  await win.webContents.executeJavaScript(`document.querySelector(".brain-summary").scrollIntoView({ block: "center" }); true`, true);
  const settled = await measure(win);
  assert.equal(settled.refreshInSummary, true);
  assert.equal(settled.rebuildInSummary, true);
  assert.equal(settled.statusInSummary, true);
  assert.equal(settled.progressInSummary, true);
  assert.equal(settled.metaInSummary, true);
  assert.equal(settled.formHasActions, false);
  assert.match(settled.metaText, /Ada Lovelace/);
  assert.match(settled.metaText, /Emails analyzed/);
  assert.match(settled.metaText, /Facts learned/);
  assert.match(settled.metaText, /Updated/);
  assert.match(settled.hint, /Refresh distills the living profile/);
  assert.match(settled.hint, /Your writing rules stay/);
  assert.equal(settled.sameRow, true);
  assert.equal(settled.refreshBelowMeta, true);
  assert.equal(settled.actionsAboveForm, true);
  assert.equal(settled.refreshDisabled, false);
  assert.equal(settled.progressHidden, true);
  assert.ok(settled.summary.width > 200 && settled.summary.height > 80);
  const settledShot = await shot(win, "brain-profile-summary");
  await win.webContents.executeJavaScript(`document.getElementById("brain-refresh").click(); true`, true);
  await waitFor(win, `document.getElementById("brain-status").textContent.includes("Refreshing") && document.getElementById("brain-refresh").disabled`, "refreshing");
  const refreshing = await measure(win);
  assert.match(refreshing.status, /Refreshing/);
  assert.equal(refreshing.refreshDisabled, true);
  assert.equal(refreshing.rebuildDisabled, true);
  assert.equal(refreshing.statusInSummary, true);
  assert.equal(refreshing.statusNearButtons, true);
  assert.equal(refreshing.progressHidden, false);
  const manual = JSON.parse(await win.webContents.executeJavaScript(`window.morrowShot.sent()`, true)).filter((row) => row.channel === "emailBrain:refresh" && row.source === "manual");
  assert.equal(manual.length, 1);
  const refreshingShot = await shot(win, "brain-profile-refreshing");
  const idleEmit = await win.webContents.executeJavaScript(`window.morrowShot.emit("emailBrain:refreshState", { refreshing: false, error: null })`, true);
  assert.equal(idleEmit, "called undefined");
  await sleep(50);
  const idle = await json(win, '({ disabled: document.getElementById("brain-refresh").disabled, status: document.getElementById("brain-status").textContent })');
  assert.equal(idle.disabled, false);
  assert.equal(idle.status.includes("Refreshing"), false);

  await win.webContents.executeJavaScript(`window.__rebuildAsks = 0; window.confirm = () => { window.__rebuildAsks += 1; return false; }; "confirm-off"`, true);
  const rebuildsBefore = JSON.parse(await win.webContents.executeJavaScript(`window.morrowShot.sent()`, true)).filter((row) => row.channel === "emailBrain:rebuild").length;
  await win.webContents.executeJavaScript(`document.getElementById("brain-rebuild").click(); true`, true);
  await sleep(100);
  const cancelled = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({ asks: window.__rebuildAsks, rebuilds: JSON.parse(window.morrowShot.sent()).filter(row => row.channel === "emailBrain:rebuild").length, status: document.getElementById("brain-status").textContent })`, true));
  assert.equal(cancelled.asks, 1);
  assert.equal(cancelled.rebuilds, rebuildsBefore);
  assert.equal(cancelled.status.includes("Rebuilding"), false);

  await win.webContents.executeJavaScript(`window.confirm = () => { window.__rebuildAsks += 1; return true; }; "confirm-on"`, true);
  await win.webContents.executeJavaScript(`document.getElementById("brain-rebuild").click(); true`, true);
  await waitFor(win, `document.getElementById("brain-status").textContent.includes("Rebuilding")`, "rebuilding");
  const rebuilding = await measure(win);
  assert.match(rebuilding.status, /Rebuilding/);
  assert.equal(rebuilding.rebuildDisabled, true);
  assert.equal(rebuilding.statusInSummary, true);
  assert.equal(rebuilding.progressHidden, false);
  const rebuildingShot = await shot(win, "brain-profile-rebuilding");
  const asks = await win.webContents.executeJavaScript(`window.__rebuildAsks`, true);
  assert.equal(asks, 2);
  const readyEmit = await win.webContents.executeJavaScript(`window.morrowShot.emit("emailBrain:rebuildState", { rebuilding: false, phase: "ready", percent: 100, error: null })`, true);
  assert.equal(readyEmit, "called undefined");
  await waitFor(win, `!document.getElementById("brain-rebuild").disabled`, "rebuild idle");

  console.log(JSON.stringify({ ok: true, settledShot, refreshingShot, rebuildingShot }, null, 2));
  app.quit();
}).catch((error) => {
  console.error("CAUGHT", error && error.message);
  console.error(error && error.stack);
  app.exit(1);
});
