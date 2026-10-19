const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const outDir = process.env.MORROW_SHOT_DIR || "/opt/cursor/artifacts";
const preloadPath = path.join(os.tmpdir(), "morrow-shot-preload.js");

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
  unread: true,
  snippet: "The table of operations is ready for a second reading.",
  textBody: "The table of operations is ready for a second reading.\n\nThe brass gears mesh once the mill is set.",
  htmlBody: "<p>The table of operations is ready for a second reading.</p><p>The brass gears mesh once the mill is set.</p><script></script><img src=\"https://example.com/gear.png\" alt=\"Gear diagram\"><img src=\"javascript:alert(1)\" alt=\"bad\">",
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
const { contextBridge, ipcRenderer } = require("electron");
const sent = [];
const message = ${JSON.stringify(message)};
const account = ${JSON.stringify(account)};
const signatures = {
  signatures: [{ id: "sig-ada", name: "Ada", text: "Ada Lovelace\\nAnalytical Engine", accountId: "acct-ada" }],
  defaultSignatureId: "sig-ada",
  defaultSignaturePerAccount: { "acct-ada": "sig-ada" },
};
function envelope(data) {
  return { success: true, data: data };
}
function raw(channel) {
  if (channel === "app:getVersion") return "0.1.0-alpha.4";
  if (channel === "host:updateGetState" || channel === "host:updateCheck" || channel === "host:updateInstall") {
    return { enabled: false };
  }
  if (channel === "config:getTheme") return "light";
  if (channel === "morrow:configGetAccent") return "#193C34";
  if (channel === "morrow:configGetUndoSendDelaySeconds") return 5;
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
    if (channel === "mail:send" || channel === "mail:upsertDraft" || channel === "mail:scheduleSend") {
      sent.push(channel);
    }
    const direct = raw(channel);
    if (direct !== null || channel.indexOf("config") >= 0 || channel.indexOf("app:") === 0 || channel.indexOf("host:") === 0) {
      return Promise.resolve(channel.indexOf("config") >= 0 || channel.indexOf("app:") === 0 || channel.indexOf("host:") === 0 ? raw(channel) : direct);
    }
    if (channel === "mail:listAccounts") return Promise.resolve(envelope([account]));
    if (channel === "mail:listFromCache" || channel === "mail:listFromNetwork") return Promise.resolve(envelope({ emails: [message] }));
    if (channel === "mail:openEmail") return Promise.resolve(envelope({ email: message, threadMessages: [message] }));
    if (channel === "mail:listSignatures") return Promise.resolve(envelope(signatures));
    if (channel === "mail:listScheduled" || channel === "mail:listImapSmtpPresets") return Promise.resolve(envelope([]));
    if (channel === "mail:listSnoozed") return Promise.resolve(envelope({ records: [] }));
    if (channel === "mail:oauthStatus") return Promise.resolve(envelope({ google: false }));
    if (channel === "mail:listProviderFolders") return Promise.resolve(envelope({ api: false, reason: "profile", folders: [] }));
    if (channel === "aiDraftWrite:replySuggestions") return Promise.resolve(envelope({ suggestions: [] }));
    if (channel === "mail:markRead") return Promise.resolve(envelope({}));
    return Promise.resolve(envelope(null));
  },
  on() { return function () {}; },
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
    await sleep(100);
  }
  throw new Error(label + " timed out: " + JSON.stringify(last));
}

async function shotState(win) {
  return win.webContents.executeJavaScript(`(() => {
    const dialog = document.getElementById("compose");
    const quote = document.getElementById("compose-quote");
    const split = document.getElementById("compose-split");
    const draft = document.querySelector(".compose-draft");
    const body = document.getElementById("compose-body");
    const quoteBox = quote.getBoundingClientRect();
    const draftBox = draft.getBoundingClientRect();
    return {
      open: dialog.open,
      layout: dialog.dataset.layout,
      quote: dialog.dataset.quote,
      collapsed: dialog.dataset.quoteCollapsed,
      width: dialog.clientWidth,
      viewport: window.innerWidth,
      direction: getComputedStyle(split).flexDirection,
      quoteHidden: quote.hidden,
      handleHidden: document.getElementById("compose-split-handle").hidden,
      collapseHidden: document.getElementById("compose-quote-collapse").hidden,
      text: (document.getElementById("compose-quote-body").innerText || "").slice(0, 800),
      script: !!quote.querySelector("script"),
      image: !!quote.querySelector("img"),
      draft: body.value,
      title: document.getElementById("compose-title").textContent,
      quoteLeft: quoteBox.left,
      draftLeft: draftBox.left,
      quoteTop: quoteBox.top,
      draftTop: draftBox.top,
      sendDisabled: document.getElementById("compose-send").disabled,
      noteHidden: document.getElementById("compose-quote-note").hidden,
    };
  })()`, true);
}

function assertState(state, expect) {
  for (const [key, value] of Object.entries(expect)) {
    if (state[key] !== value) {
      throw new Error(key + " expected " + JSON.stringify(value) + " got " + JSON.stringify(state[key]) + "\\n" + JSON.stringify(state, null, 2));
    }
  }
}

app.disableHardwareAcceleration();
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "morrow-shot-")));

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
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
  const shell = await win.webContents.executeJavaScript(`(() => {
    const row = document.querySelector("button.message");
    const chips = document.getElementById("list-chips");
    const chipText = chips ? [...chips.querySelectorAll("button")].map((button) => button.textContent) : [];
    return {
      title: document.title,
      product: (document.getElementById("product-name") || {}).textContent || "",
      agentToolbar: !!document.getElementById("agent-open"),
      brainToolbar: !!document.getElementById("brain-open"),
      railBrain: document.getElementById("rail-brain") ? document.getElementById("rail-brain").getAttribute("aria-label") : "",
      chips: chipText,
      chipsInHead: !!(chips && chips.parentElement && chips.parentElement.id === "list-head"),
      rowMin: row ? getComputedStyle(row).minHeight : "",
      avatar: row && row.querySelector(".avatar") ? getComputedStyle(row.querySelector(".avatar")).width : "",
      listTitle: document.getElementById("list-title") ? document.getElementById("list-title").textContent : "",
      folderText: document.getElementById("folders") ? document.getElementById("folders").innerText : "",
    };
  })()`, true);
  if (shell.title !== "Morrow Mail") throw new Error("window title is " + shell.title);
  if (shell.product !== "Morrow Mail") throw new Error("footer brand is " + shell.product);
  if (shell.agentToolbar || shell.brainToolbar) throw new Error("toolbar still duplicates Agent or Brain");
  if (shell.railBrain !== "Email Brain") throw new Error("rail brain label is " + shell.railBrain);
  if (shell.chips.join(",") !== "Inbox,Sent,Drafts") throw new Error("chips are " + shell.chips.join(","));
  if (!shell.chipsInHead) throw new Error("chips are outside the list header");
  if (shell.rowMin !== "60px") throw new Error("row min-height is " + shell.rowMin);
  if (shell.avatar !== "32px") throw new Error("avatar width is " + shell.avatar);
  if (shell.listTitle !== "Inbox") throw new Error("list title is " + shell.listTitle);
  if (!shell.folderText.includes("Inbox")) throw new Error("folders missing: " + shell.folderText);
  await sleep(350);
  const shellPath = path.join(outDir, "mail-shell.png");
  fs.writeFileSync(shellPath, (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`document.querySelectorAll("#list-chips button")[1].click()`, true);
  await waitFor(win, `document.getElementById("list-title").textContent === "Sent" && document.querySelector('#list-chips button[aria-current="true"]').textContent === "Sent"`, "sent chip");
  await win.webContents.executeJavaScript(`document.querySelectorAll("#list-chips button")[0].click()`, true);
  await waitFor(win, `document.getElementById("list-title").textContent === "Inbox" && !!document.querySelector('[data-testid="mail-list-message-row"]')`, "inbox chip");
  await win.webContents.executeJavaScript(`document.querySelector('[data-testid="mail-list-message-row"]').click()`, true);
  await waitFor(win, `!!document.querySelector('[data-action="forward"]')`, "reader actions");

  await win.webContents.executeJavaScript(`document.querySelector('[data-action="forward"]').click()`, true);
  await waitFor(win, `document.getElementById("compose").open && document.getElementById("compose-title").textContent === "Forward"`, "forward dialog");
  await sleep(400);
  const forwarded = await shotState(win);
  assertState(forwarded, { layout: "wide", quote: "hidden", quoteHidden: true, noteHidden: false, title: "Forward" });
  await win.webContents.executeJavaScript(`document.getElementById("compose-close").click()`, true);
  await waitFor(win, `!document.getElementById("compose").open`, "forward close");

  await win.webContents.executeJavaScript(`document.querySelector('[data-action="reply"]').click()`, true);
  await waitFor(win, `document.getElementById("compose").open && (document.getElementById("compose-body").value || "").includes("Analytical Engine")`, "reply signature");
  await sleep(500);
  await win.webContents.executeJavaScript(`document.querySelector(".compose-draft").scrollTop = 0; document.getElementById("compose-quote-body").scrollTop = 0;`, true);
  const wide = await shotState(win);
  assertState(wide, {
    layout: "wide",
    quote: "shown",
    quoteHidden: false,
    handleHidden: false,
    direction: "row",
    script: false,
    image: false,
    title: "Reply",
    sendDisabled: false,
    noteHidden: true,
  });
  if (!(wide.width >= 900)) throw new Error("wide dialog is " + wide.width);
  if (!(wide.quoteLeft < wide.draftLeft)) throw new Error("quote is not on the left");
  if (!wide.text.includes("brass gears")) throw new Error("quoted text missing: " + wide.text);
  if (!wide.text.includes("Charles Babbage")) throw new Error("quoted from missing");
  if (!wide.text.includes("1 remote image is blocked.")) throw new Error("remote image was not sanitized");
  if (wide.draft.includes("brass gears")) throw new Error("quote was copied into the editor");
  if (!wide.draft.includes("Ada Lovelace")) throw new Error("signature missing");
  const widePath = path.join(outDir, "compose-split-wide.png");
  fs.writeFileSync(widePath, (await win.webContents.capturePage()).toPNG());

  await win.webContents.executeJavaScript(`document.getElementById("compose-close").click()`, true);
  await waitFor(win, `!document.getElementById("compose").open`, "reply close");
  win.setContentSize(780, 940);
  await sleep(400);
  await win.webContents.executeJavaScript(`document.querySelector('[data-action="reply"]').click()`, true);
  await waitFor(win, `document.getElementById("compose").dataset.layout === "narrow" && document.getElementById("compose").dataset.quote === "shown"`, "narrow layout");
  await sleep(400);
  await win.webContents.executeJavaScript(`document.getElementById("compose-quote-collapse").click()`, true);
  await sleep(200);
  const collapsed = await shotState(win);
  assertState(collapsed, { layout: "narrow", collapsed: "true", direction: "column" });
  const collapsedBodyHidden = await win.webContents.executeJavaScript(`document.getElementById("compose-quote-body").hidden`, true);
  if (collapsedBodyHidden !== true) throw new Error("collapsed body still shown");
  const collapsedPath = path.join(outDir, "compose-split-collapsed.png");
  fs.writeFileSync(collapsedPath, (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`document.getElementById("compose-quote-collapse").click()`, true);
  await sleep(250);
  await win.webContents.executeJavaScript(`document.querySelector(".compose-draft").scrollTop = 0; document.getElementById("compose-quote-body").scrollTop = 0;`, true);
  const narrow = await shotState(win);
  assertState(narrow, {
    layout: "narrow",
    quote: "shown",
    collapsed: "false",
    direction: "column",
    handleHidden: true,
    collapseHidden: false,
    script: false,
    image: false,
  });
  if (!(narrow.width < 900)) throw new Error("narrow dialog is " + narrow.width);
  if (!(narrow.quoteTop < narrow.draftTop)) throw new Error("quote is not above the draft");
  if (!narrow.text.includes("brass gears")) throw new Error("narrow quote missing");
  const fit = await win.webContents.executeJavaScript(`(() => {
    const dialog = document.getElementById("compose").getBoundingClientRect();
    const body = document.getElementById("compose-quote-body").getBoundingClientRect();
    return {
      dialogHeight: dialog.height,
      inner: window.innerHeight,
      bodyBottom: body.bottom,
      dialogBottom: dialog.bottom,
      dialogTop: dialog.top,
      bodyTop: body.top,
    };
  })()`, true);
  if (fit.bodyBottom > fit.dialogBottom + 1 || fit.bodyTop < fit.dialogTop - 1) {
    throw new Error("quote paints outside the dialog " + JSON.stringify(fit));
  }
  if (fit.dialogHeight < fit.inner - 40) {
    throw new Error("quoting dialog does not fill the window " + JSON.stringify(fit));
  }
  const narrowPath = path.join(outDir, "compose-split-narrow.png");
  fs.writeFileSync(narrowPath, (await win.webContents.capturePage()).toPNG());

  await win.webContents.executeJavaScript(`document.getElementById("compose-close").click()`, true);
  await waitFor(win, `!document.getElementById("compose").open`, "narrow close");
  await win.webContents.executeJavaScript(`document.querySelector('[data-action="reply"]').click()`, true);
  await waitFor(win, `document.getElementById("compose").open`, "reopen for escape");
  await sleep(200);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await waitFor(win, `!document.getElementById("compose").open`, "escape close");
  const sent = await win.webContents.executeJavaScript(`window.morrowShot.sent()`, true);
  if (sent.length) throw new Error("close or cancel sent mail: " + sent.join(","));
  const report = {
    shell: shellPath,
    wide: widePath,
    collapsed: collapsedPath,
    narrow: narrowPath,
    shellState: shell,
    wideState: wide,
    narrowState: narrow,
    forwarded: { layout: forwarded.layout, quote: forwarded.quote, width: forwarded.width },
    sent: sent,
  };
  fs.writeFileSync(path.join(outDir, "compose-split-check.json"), JSON.stringify(report, null, 2));
  const setup = new BrowserWindow({
    width: 560,
    height: 520,
    show: true,
    backgroundColor: "#e7f0e4",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await setup.loadFile(path.join(root, "host/ai-setup.html"));
  setup.setTitle("AI Setup — Morrow Mail");
  await sleep(250);
  const setupPath = path.join(outDir, "ai-setup.png");
  fs.writeFileSync(setupPath, (await setup.webContents.capturePage()).toPNG());
  report.setup = setupPath;
  fs.writeFileSync(path.join(outDir, "compose-split-check.json"), JSON.stringify(report, null, 2));
  console.log("SHOT_OK");
  console.log(JSON.stringify({ wide: wide.width, narrow: narrow.width, sent: sent }));
  app.exit(0);
}).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  app.exit(1);
});

setTimeout(() => {
  console.error("shot timeout");
  app.exit(1);
}, 45000);
