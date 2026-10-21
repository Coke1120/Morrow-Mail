// Compose AI popover: toolbar sparkle, reply-from-thread draft, Escape, and Send later left alone.
// xvfb-run -a npx electron --no-sandbox scripts/check-compose-ai-popover.js
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.join(__dirname, "..");
const outDir = process.env.MORROW_SHOT_DIR || "/opt/cursor/artifacts";
const preloadPath = path.join(os.tmpdir(), "morrow-compose-ai-preload.js");

const message = {
  id: "msg-engine",
  accountId: "acct-ada",
  folderId: "inbox",
  threadId: "thread-engine",
  messageId: "<engine@analytical.example>",
  from: "Charles Babbage <charles.babbage@example.com>",
  to: ["Ada Lovelace <ada.lovelace@example.com>", "Mary Somerville <mary.somerville@example.com>"],
  cc: ["George Peacock <george.peacock@example.com>"],
  subject: "Notes on the Analytical Engine",
  date: "2026-10-12T15:04:00.000Z",
  unread: false,
  snippet: "The table of operations is ready for a second reading.",
  textBody: "The table of operations is ready for a second reading.\n\nThe brass gears mesh once the mill is set.",
  htmlBody: "<p>The table of operations is ready for a second reading.</p><p>The brass gears mesh once the mill is set.</p>",
  attachments: [{ id: "att-1", filename: "table.txt", size: 1280 }],
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

fs.writeFileSync(preloadPath, `
const { contextBridge } = require("electron");
const sent = [];
const listeners = {};
const message = ${JSON.stringify(message)};
const account = ${JSON.stringify(account)};
const signatures = {
  signatures: [{ id: "sig-ada", name: "Ada", text: "Ada Lovelace\\nAnalytical Engine", accountId: "acct-ada" }],
  defaultSignatureId: "sig-ada",
  defaultSignaturePerAccount: { "acct-ada": "sig-ada" },
};
function envelope(data) { return { success: true, data: data }; }
function raw(channel) {
  if (channel === "app:getVersion") return "0.1.0-alpha.4";
  if (channel === "host:updateGetState" || channel === "host:updateCheck" || channel === "host:updateInstall") return { enabled: false };
  if (channel === "config:getTheme") return "light";
  if (channel === "morrow:configGetAccent") return "#193C34";
  if (channel === "morrow:configGetUndoSendDelaySeconds") return 0;
  if (channel === "morrow:configGetComposeQuoteWidth") return 460;
  if (channel === "morrow:configSetComposeQuoteWidth") return 460;
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
    const direct = raw(channel);
    if (direct !== null || channel.indexOf("config") >= 0 || channel.indexOf("app:") === 0 || channel.indexOf("host:") === 0) {
      return Promise.resolve(channel.indexOf("config") >= 0 || channel.indexOf("app:") === 0 || channel.indexOf("host:") === 0 ? raw(channel) : direct);
    }
    if (channel === "mail:listAccounts") return Promise.resolve(envelope([account]));
    if (channel === "mail:listFromCache" || channel === "mail:listFromNetwork") return Promise.resolve(envelope({ emails: [message] }));
    if (channel === "mail:openEmail") return Promise.resolve(envelope({ email: message, threadMessages: [message] }));
    if (channel === "mail:listSignatures") return Promise.resolve(envelope(signatures));
    if (channel === "mail:getComposeContext") return Promise.resolve(envelope({
      fromAddress: "ada.lovelace@example.com",
      sendAs: [{ email: "ada.lovelace@example.com", source: "account" }],
      selfAddresses: ["ada.lovelace@example.com"],
      domain: "example.com",
      policyDomain: "example.com",
      defaultCc: [],
      defaultBcc: [],
      receivedAddress: "ada.lovelace@example.com",
      fallback: false,
    }));
    if (channel === "mail:listScheduled" || channel === "mail:listImapSmtpPresets") return Promise.resolve(envelope([]));
    if (channel === "mail:listSnoozed") return Promise.resolve(envelope({ records: [] }));
    if (channel === "mail:oauthStatus") return Promise.resolve(envelope({ google: false }));
    if (channel === "mail:listProviderFolders") return Promise.resolve(envelope({ api: false, reason: "profile", folders: [] }));
    if (channel === "mail:markRead") return Promise.resolve(envelope({}));
    if (channel === "aiDraftWrite:replySuggestions") return Promise.resolve(envelope({ suggestions: ["Quick reply. The gears are ready.", "Sounds good."] }));
    if (channel === "aiDraftWrite:start") {
      const reqId = payload && payload.reqId;
      setTimeout(() => {
        const send = listeners["aiDraftWrite:event"];
        if (!send) return;
        send({ reqId: reqId, type: "chunk", data: "I can review the table of operations." });
        send({ reqId: reqId, type: "done" });
      }, 40);
      return Promise.resolve(envelope({ reqId: reqId }));
    }
    if (channel === "aiDraftWrite:cancel") return Promise.resolve(envelope(true));
    return Promise.resolve(envelope(null));
  },
  on(channel, callback) {
    listeners[channel] = callback;
    return function () {};
  },
});
contextBridge.exposeInMainWorld("morrowShot", {
  sent() { return sent.slice(); },
});
`);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(win, expression, label) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < 10000) {
    last = await win.webContents.executeJavaScript(expression, true);
    if (last) return last;
    await sleep(50);
  }
  throw new Error(label + " timed out: " + JSON.stringify(last));
}

async function shot(win, name) {
  fs.mkdirSync(outDir, { recursive: true });
  await sleep(250);
  const file = path.join(outDir, name + ".png");
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  return file;
}

app.disableHardwareAcceleration();
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "morrow-compose-ai-")));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
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
  await waitFor(win, `!!document.querySelector('[data-testid="mail-list-message-row"]')`, "message row");
  await win.webContents.executeJavaScript(`document.querySelector('[data-testid="mail-list-message-row"]').click()`, true);
  await waitFor(win, `!!document.querySelector('[data-action="reply"]')`, "reader");
  await win.webContents.executeJavaScript(`document.querySelector('[data-action="reply"]').click()`, true);
  await waitFor(win, `document.getElementById("compose").open && (document.getElementById("compose-body").value || "").includes("Analytical Engine")`, "reply signature");
  await waitFor(win, `document.getElementById("compose-suggest-list").textContent.includes("Sounds good.")`, "suggestion chips");

  const closed = await win.webContents.executeJavaScript(`(() => {
    const pop = document.getElementById("compose-ai-popover");
    const schedule = document.getElementById("compose-schedule-tools");
    const editor = document.getElementById("compose-editor").getBoundingClientRect();
    return {
      accordion: document.getElementById("compose-ai-tools"),
      grid: document.querySelector(".compose-tools-grid"),
      popHidden: pop.hidden,
      expanded: document.getElementById("compose-ai-open").getAttribute("aria-expanded"),
      label: document.getElementById("compose-ai-open").getAttribute("aria-label"),
      scheduleOpen: schedule.open,
      scheduleSummary: schedule.querySelector("summary").textContent,
      sameParent: pop.parentElement === schedule.parentElement,
      chips: document.getElementById("compose-suggest-list").textContent,
      replyDisabled: document.getElementById("ai-mode-reply").disabled,
      editorTop: editor.top,
    };
  })()`, true);
  assert.equal(closed.accordion, null);
  assert.equal(closed.grid, null);
  assert.equal(closed.popHidden, true);
  assert.equal(closed.expanded, "false");
  assert.equal(closed.label, "Write with AI");
  assert.equal(closed.scheduleOpen, false);
  assert.match(closed.scheduleSummary, /Send later/);
  assert.equal(closed.sameParent, false);
  assert.match(closed.chips, /Quick reply/);
  assert.equal(closed.replyDisabled, false);

  await win.webContents.executeJavaScript(`document.getElementById("compose-ai-open").click()`, true);
  await waitFor(win, `!document.getElementById("compose-ai-popover").hidden && document.getElementById("ai-mode").value === "reply" && document.activeElement && document.activeElement.id === "ai-prompt"`, "reply popover");
  const openBox = await win.webContents.executeJavaScript(`(() => {
    const popEl = document.getElementById("compose-ai-popover");
    const cancelEl = document.getElementById("ai-cancel");
    const generateEl = document.getElementById("ai-generate");
    const pop = popEl.getBoundingClientRect();
    const cancel = cancelEl.getBoundingClientRect();
    const generate = generateEl.getBoundingClientRect();
    const editor = document.getElementById("compose-editor").getBoundingClientRect();
    const spark = document.getElementById("compose-ai-open").getBoundingClientRect();
    const point = document.elementFromPoint(cancel.left + cancel.width / 2, cancel.top + cancel.height / 2);
    return {
      popTop: pop.top, popRight: pop.right, popBottom: pop.bottom, popLeft: pop.left,
      popWidth: pop.width, popHeight: pop.height,
      editorTop: editor.top, sparkRight: spark.right, sparkTop: spark.top,
      checked: document.getElementById("ai-mode-reply").getAttribute("aria-checked"),
      note: document.getElementById("compose-ai-note").textContent,
      expanded: document.getElementById("compose-ai-open").getAttribute("aria-expanded"),
      cancelHidden: cancelEl.hidden,
      cancelText: cancelEl.textContent,
      cancelWidth: cancel.width, cancelHeight: cancel.height,
      cancelTop: cancel.top, cancelBottom: cancel.bottom, cancelLeft: cancel.left, cancelRight: cancel.right,
      generateRight: generate.right,
      hit: point && (point === cancelEl || cancelEl.contains(point)),
      viewH: window.innerHeight, viewW: window.innerWidth,
    };
  })()`, true);
  assert.equal(openBox.checked, "true");
  assert.equal(openBox.expanded, "true");
  assert.match(openBox.note, /empty prompt writes a full reply/);
  assert.ok(openBox.popTop >= openBox.sparkTop, "popover sits on the sparkle");
  assert.ok(openBox.popTop < openBox.editorTop + 80, "popover overlaps the editor");
  assert.ok(openBox.popWidth > 240 && openBox.popHeight > 120);
  assert.equal(openBox.cancelHidden, false);
  assert.equal(openBox.cancelText.trim(), "Cancel");
  assert.ok(openBox.cancelWidth > 40 && openBox.cancelHeight > 20, "Cancel has a box");
  assert.ok(openBox.cancelTop >= openBox.popTop && openBox.cancelBottom <= openBox.popBottom + 1, "Cancel sits inside the popover");
  assert.ok(openBox.cancelLeft >= openBox.popLeft && openBox.cancelRight <= openBox.popRight + 1);
  assert.ok(openBox.cancelLeft >= openBox.generateRight - 1, "Cancel follows Generate");
  assert.ok(openBox.cancelBottom <= openBox.viewH && openBox.cancelTop >= 0 && openBox.cancelRight <= openBox.viewW);
  assert.equal(openBox.hit, true, "Cancel is the painted control under its center");
  const replyShot = await shot(win, "compose-ai-reply-popover");

  await win.webContents.executeJavaScript(`document.getElementById("ai-generate").click()`, true);
  await waitFor(win, `(document.getElementById("compose-body").value || "").includes("table of operations") && (document.getElementById("compose-body").value || "").includes("Analytical Engine")`, "draft kept the signature");
  const started = await win.webContents.executeJavaScript(`(() => {
    const rows = window.morrowShot.sent().filter((row) => row.channel === "aiDraftWrite:start");
    const sends = window.morrowShot.sent().filter((row) => row.channel === "mail:send" || row.channel === "mail:scheduleSend");
    return { last: rows[rows.length - 1], sends: sends.length, body: document.getElementById("compose-body").value };
  })()`, true);
  assert.equal(started.sends, 0);
  assert.equal(started.last.payload.body.mode, "reply");
  assert.match(started.last.payload.body.user_prompt, /comprehensive reply/);
  assert.match(started.last.payload.body.email.text_body, /brass gears/);
  assert.equal(started.last.payload.body.existing_draft_content, "");
  assert.match(started.body, /I can review the table of operations/);
  assert.match(started.body, /Ada Lovelace/);
  const draftedShot = await shot(win, "compose-ai-reply-draft");

  win.focus();
  win.webContents.focus();
  await win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  await win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await waitFor(win, `document.getElementById("compose-ai-popover").hidden && document.getElementById("compose").open && !(document.getElementById("compose-close-review") && document.getElementById("compose-close-review").open)`, "escape closes popover only");
  const focused = await win.webContents.executeJavaScript(`document.activeElement && document.activeElement.id`, true);
  assert.equal(focused, "compose-ai-open");

  await win.webContents.executeJavaScript(`document.getElementById("compose-ai-open").click()`, true);
  await waitFor(win, `!document.getElementById("compose-ai-popover").hidden`, "reopen popover");
  await win.webContents.executeJavaScript(`document.getElementById("compose-editor").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`, true);
  await waitFor(win, `document.getElementById("compose-ai-popover").hidden`, "outside click closes popover");

  await win.webContents.executeJavaScript(`document.getElementById("compose-close").click()`, true);
  await waitFor(win, `document.getElementById("compose-close-review").open`, "dirty close review");
  await win.webContents.executeJavaScript(`document.getElementById("draft-close-discard").click()`, true);
  await waitFor(win, `!document.getElementById("compose").open`, "reply closed");

  await win.webContents.executeJavaScript(`document.getElementById("compose-open").click()`, true);
  await waitFor(win, `document.getElementById("compose").open && document.getElementById("compose-title").textContent === "New message" && document.getElementById("compose-ai-popover").hidden`, "new message");
  await win.webContents.executeJavaScript(`document.getElementById("compose-ai-open").click()`, true);
  await waitFor(win, `!document.getElementById("compose-ai-popover").hidden && document.getElementById("ai-mode-reply").disabled`, "reply mode disabled");
  const fresh = await win.webContents.executeJavaScript(`(() => ({
    mode: document.getElementById("ai-mode").value,
    note: document.getElementById("compose-ai-note").textContent,
    generateDisabled: document.getElementById("ai-generate").disabled,
    scheduleOpen: document.getElementById("compose-schedule-tools").open,
  }))()`, true);
  assert.equal(fresh.mode, "rewrite");
  assert.match(fresh.note, /needs the original message/);
  assert.equal(fresh.generateDisabled, false);
  assert.equal(fresh.scheduleOpen, false);
  const newShot = await shot(win, "compose-ai-new-mail");

  win.focus();
  win.webContents.focus();
  await win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  await win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await waitFor(win, `document.getElementById("compose-ai-popover").hidden && document.getElementById("compose").open`, "escape on new mail");

  await win.webContents.executeJavaScript(`document.getElementById("compose-close").click()`, true);
  await sleep(200);
  if (await win.webContents.executeJavaScript(`document.getElementById("compose-close-review").open`, true)) {
    await win.webContents.executeJavaScript(`document.getElementById("draft-close-discard").click()`, true);
  }
  await waitFor(win, `!document.getElementById("compose").open`, "new mail closed");

  await win.webContents.executeJavaScript(`state.prefs.aiReply = true; document.querySelector('[data-action="reply"]').click()`, true);
  await waitFor(win, `document.getElementById("compose").open && !document.getElementById("compose-ai-popover").hidden && document.getElementById("ai-mode").value === "reply" && document.activeElement && document.activeElement.id === "ai-prompt"`, "reply preference opens the popover");
  await win.webContents.executeJavaScript(`document.getElementById("compose-close").click()`, true);
  await sleep(150);
  if (await win.webContents.executeJavaScript(`document.getElementById("compose-close-review").open`, true)) {
    await win.webContents.executeJavaScript(`document.getElementById("draft-close-discard").click()`, true);
  }
  await waitFor(win, `!document.getElementById("compose").open`, "auto reply closed");

  await win.webContents.executeJavaScript(`document.querySelector('[data-action="forward"]').click()`, true);
  await waitFor(win, `document.getElementById("compose").open && document.getElementById("compose-title").textContent === "Forward"`, "forward");
  await win.webContents.executeJavaScript(`document.getElementById("compose-ai-open").click()`, true);
  await waitFor(win, `document.getElementById("ai-mode-reply").disabled && document.getElementById("compose-ai-note").textContent.includes("original message")`, "forward disables reply mode");

  console.log(JSON.stringify({ ok: true, shots: [replyShot, draftedShot, newShot] }));
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
