const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const outDir = process.env.MORROW_SHOT_DIR || "/opt/cursor/artifacts";
const preloadPath = path.join(os.tmpdir(), "morrow-agent-shot-preload.js");

const account = {
  id: "acct-ada",
  email: "ada.lovelace@example.com",
  name: "Ada Lovelace",
  platform: "imap",
  imapSmtpProfile: "custom",
  folders: {
    primary: [
      { id: "inbox", name: "Inbox", wellKnownName: "inbox", chip: true },
    ],
    more: [],
  },
};

const messages = {
  "m-ada": {
    id: "m-ada",
    accountId: "acct-ada",
    from: "Charles Babbage <charles.babbage@example.com>",
    to: ["Ada Lovelace <ada.lovelace@example.com>"],
    cc: ["Mary Somerville <mary.somerville@example.com>"],
    subject: "Notes on the Analytical Engine",
    date: "2026-10-21T14:05:00.000Z",
    unread: true,
    hasAttachments: true,
    snippet: "The table of operations is ready for a second reading.",
    textBody: "The table of operations is ready for a second reading.",
    messageId: "<engine@analytical.example>",
    threadId: "thread-engine",
  },
  "m-grant": {
    id: "m-grant",
    accountId: "acct-ada",
    from: "Royal Society <grants@royalsociety.example>",
    to: ["Ada Lovelace <ada.lovelace@example.com>"],
    subject: "Grant figures for Friday",
    date: "2026-10-21T09:40:00.000Z",
    unread: true,
    snippet: "Please confirm the revised totals before the meeting.",
    textBody: "Please confirm the revised totals before the meeting.",
    messageId: "<grant@royalsociety.example>",
    threadId: "thread-grant",
  },
  "m-mary": {
    id: "m-mary",
    accountId: "acct-ada",
    from: "Mary Somerville <mary.somerville@example.com>",
    to: ["Ada Lovelace <ada.lovelace@example.com>"],
    subject: "Thursday salon",
    date: "2026-10-21T08:15:00.000Z",
    unread: false,
    snippet: "I can bring the diagrams if you still want them on the table.",
    textBody: "I can bring the diagrams if you still want them on the table.",
    messageId: "<salon@example>",
    threadId: "thread-salon",
  },
};

const triage = {
  reason: "ready",
  updatedAt: "2026-10-21T18:02:00.000Z",
  stale: false,
  sections: [
    {
      id: "needs-you",
      name: "Needs You",
      description: "Messages waiting on a reply or a decision.",
      items: [
        {
          messageId: "m-ada",
          accountId: "acct-ada",
          from: messages["m-ada"].from,
          subject: messages["m-ada"].subject,
          summary: "Charles wants a second reading of the operation table before he locks the mill.",
          date: messages["m-ada"].date,
          unread: true,
          hasAttachments: true,
          followUps: [{ kind: "open", messageId: "m-ada", label: "Open" }],
        },
        {
          messageId: "m-grant",
          accountId: "acct-ada",
          from: messages["m-grant"].from,
          subject: messages["m-grant"].subject,
          summary: "The society needs the revised totals confirmed before Friday's meeting.",
          date: messages["m-grant"].date,
          unread: true,
          followUps: [],
        },
      ],
    },
    {
      id: "upcoming",
      name: "Upcoming Today",
      description: "Deadlines and plans already in today's mail.",
      items: [
        {
          messageId: "m-mary",
          accountId: "acct-ada",
          from: messages["m-mary"].from,
          subject: messages["m-mary"].subject,
          summary: "Mary can bring the diagrams to Thursday's salon.",
          date: messages["m-mary"].date,
          unread: false,
          followUps: [],
        },
      ],
    },
    {
      id: "fyi",
      name: "FYI",
      description: "Worth a glance, nothing to do yet.",
      collapseView: true,
      items: [
        {
          messageId: "m-mary",
          accountId: "acct-ada",
          from: "Notes <notes@example.com>",
          subject: "Library copy arrived",
          summary: "The bound volume is at the desk.",
          date: "2026-10-20T16:00:00.000Z",
          unread: false,
        },
      ],
    },
    {
      id: "other",
      name: "Other",
      description: "Everything else triage filed.",
      items: [],
    },
  ],
};

fs.writeFileSync(preloadPath, `
const { contextBridge } = require("electron");
const messages = ${JSON.stringify(messages)};
const triage = ${JSON.stringify(triage)};
const account = ${JSON.stringify(account)};
const log = [];
function envelope(data) { return { success: true, data: data }; }
contextBridge.exposeInMainWorld("morrow", {
  invoke(channel, payload) {
    log.push({ channel: channel, payload: payload || null });
    if (channel === "app:getVersion") return Promise.resolve("0.2.23");
    if (channel === "config:getTheme") return Promise.resolve("light");
    if (channel === "morrow:configGetAccent") return Promise.resolve("#193C34");
    if (channel === "morrow:configGetUndoSendDelaySeconds") return Promise.resolve(5);
    if (channel === "morrow:configGetComposeQuoteWidth") return Promise.resolve(460);
    if (channel === "morrow:configGetSyncHorizonDays") return Promise.resolve(30);
    if (channel === "morrow:configGetDefaultScheduleDelayMinutes") return Promise.resolve(15);
    if (channel === "morrow:configGetLayoutPanes") return Promise.resolve(null);
    if (channel === "morrow:configGetSidebarCollapsedFolders") return Promise.resolve({});
    if (channel === "host:updateGetState" || channel === "host:updateCheck") return Promise.resolve({ enabled: false });
    if (channel === "host:aiGetConfig") return Promise.resolve({ hasKey: true });
    if (channel.indexOf("configGet") >= 0 || channel.indexOf("config:get") === 0 || channel.indexOf("configSet") >= 0 || channel.indexOf("config:set") === 0) {
      return Promise.resolve(false);
    }
    if (channel === "mail:listAccounts") return Promise.resolve(envelope([account]));
    if (channel === "mail:listFromCache" || channel === "mail:listFromNetwork") return Promise.resolve(envelope({ emails: [] }));
    if (channel === "mail:openEmail") {
      const email = messages[payload && payload.emailId] || null;
      return Promise.resolve(email ? envelope({ email: email, threadMessages: [email] }) : envelope(null));
    }
    if (channel === "mail:markRead") return Promise.resolve(envelope({ pending: [], outcomes: [] }));
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
    if (channel === "mail:listSignatures") return Promise.resolve(envelope({ signatures: [], defaultSignaturePerAccount: {} }));
    if (channel === "mail:listScheduled" || channel === "mail:listImapSmtpPresets" || channel === "mail:listSnoozed") {
      return Promise.resolve(envelope(channel === "mail:listSnoozed" ? { records: [] } : []));
    }
    if (channel === "mail:oauthStatus") return Promise.resolve(envelope({ google: false }));
    if (channel === "mail:getSyncStatus") return Promise.resolve(envelope(null));
    if (channel === "nativeAgent:home:todosCached" || channel === "nativeAgent:triage" || channel === "nativeAgent:getTriage" || channel === "nativeAgent:home") {
      return Promise.resolve(envelope(triage));
    }
    if (channel === "nativeAgent:history") return Promise.resolve(envelope({ runs: [] }));
    if (channel === "nativeAgent:chatHistory") return Promise.resolve(envelope({ turns: [], memory: { notes: "" } }));
    if (channel === "nativeAgent:home:skills") {
      return Promise.resolve(envelope({ skills: [
        { id: "morning-brief", name: "Morning Brief", description: "Today" },
        { id: "catch-me-up", name: "Catch Me Up", description: "Since yesterday" },
      ] }));
    }
    if (channel === "nativeAgent:home:librarySkills") return Promise.resolve(envelope({ skills: [] }));
    return Promise.resolve(envelope(null));
  },
  on() { return function () {}; },
  reportUpdateReady() {},
  openComposeWindow(seed) {
    log.push({ channel: "compose:open", payload: seed || null });
    return Promise.resolve({ success: true, data: { opened: true } });
  },
});
contextBridge.exposeInMainWorld("morrowShot", {
  log() { return log.slice(); },
});
`);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(win, expression, label) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < 12000) {
    last = await win.webContents.executeJavaScript(expression, true);
    if (last) return last;
    await sleep(120);
  }
  throw new Error(label + " timed out: " + JSON.stringify(last));
}

app.disableHardwareAcceleration();
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "morrow-agent-shot-")));

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
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
  await waitFor(win, `document.querySelectorAll("#folders button").length > 0`, "folders");
  await win.webContents.executeJavaScript(`document.getElementById("rail-agent").click()`, true);
  await waitFor(win, `document.querySelector('[data-testid="agent-todo-actions"]') && document.querySelector("#agent-skill-chips button")`, "agent actions");
  await sleep(250);
  async function restoreViewport() {
    await win.webContents.executeJavaScript(`(() => {
      const app = document.querySelector(".app");
      const workspace = document.querySelector(".workspace");
      const panel = document.getElementById("agent-panel");
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
      app.style.height = "";
      app.style.minHeight = "";
      workspace.style.height = "";
      panel.style.overflow = "";
      panel.style.height = "";
    })()`, true);
    win.setContentSize(1440, 960);
    await sleep(180);
  }
  async function fitPage() {
    const height = await win.webContents.executeJavaScript(`(() => {
      const app = document.querySelector(".app");
      const workspace = document.querySelector(".workspace");
      const panel = document.getElementById("agent-panel");
      document.documentElement.style.overflow = "visible";
      document.body.style.overflow = "visible";
      app.style.height = "auto";
      app.style.minHeight = "100%";
      workspace.style.height = "auto";
      panel.style.overflow = "visible";
      panel.style.height = "auto";
      return Math.ceil(Math.max(app.scrollHeight, app.getBoundingClientRect().height));
    })()`, true);
    win.setContentSize(1440, Math.max(960, Math.min(height + 4, 2200)));
    await sleep(180);
    return height;
  }
  const labels = await win.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('[data-testid="agent-todo-actions"]');
    return [...row.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
  })()`, true);
  const expected = ["Open", "Reply", "Reply All", "Mark as read", "Mark todo done", "Dismiss"];
  if (JSON.stringify(labels) !== JSON.stringify(expected)) {
    throw new Error("action labels " + JSON.stringify(labels));
  }
  const icons = await win.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('[data-testid="agent-todo-actions"]');
    return [...row.querySelectorAll("button")].map((button) => {
      const svg = button.querySelector("svg");
      return {
        label: button.getAttribute("aria-label"),
        stroke: svg && svg.getAttribute("stroke"),
        box: svg && svg.getAttribute("viewBox"),
      };
    });
  })()`, true);
  if (icons.some((icon) => icon.stroke !== "currentColor" || icon.box !== "0 0 24 24")) {
    throw new Error("icons " + JSON.stringify(icons));
  }
  const pageHeight = await fitPage();
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, "agent-todos.png"), image.toPNG());
  await win.webContents.executeJavaScript(`document.getElementById("agent-tab-tools").click()`, true);
  await sleep(200);
  await fitPage();
  fs.writeFileSync(path.join(outDir, "agent-skills.png"), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`document.getElementById("agent-tab-conversation").click()`, true);
  await sleep(200);
  await restoreViewport();
  fs.writeFileSync(path.join(outDir, "agent-conversation.png"), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`document.getElementById("agent-tab-home").click()`, true);
  await waitFor(win, `document.querySelector('[data-testid="agent-todo-actions"]')`, "todos again");
  await fitPage();
  await win.webContents.executeJavaScript(`document.querySelector('[data-action="read"]').click()`, true);
  await waitFor(win, `document.getElementById("status") && document.getElementById("status").textContent.includes("Marked as read")`, "mark read");
  const unread = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector(".agent-item");
    return card.classList.contains("unread") || !!card.querySelector(".unread-dot");
  })()`, true);
  if (unread) throw new Error("first card stayed unread");
  await win.webContents.executeJavaScript(`document.querySelector('[data-action="reply"]').click()`, true);
  await waitFor(win, `window.morrowShot.log().some((row) => row.channel === "compose:open" && row.payload && row.payload.kind === "reply")`, "reply window");
  await win.webContents.executeJavaScript(`document.querySelector('[data-action="reply-all"]').click()`, true);
  await waitFor(win, `window.morrowShot.log().some((row) => row.channel === "compose:open" && row.payload && row.payload.kind === "all")`, "reply all window");
  const shot = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, "agent-todos-after-read.png"), shot.toPNG());
  const summary = await win.webContents.executeJavaScript(`(() => {
    const calls = window.morrowShot.log().filter((row) => row.channel === "compose:open" || row.channel === "mail:markRead");
    return calls.map((row) => ({ channel: row.channel, kind: row.payload && row.payload.kind, isRead: row.payload && row.payload.isRead, title: row.payload && row.payload.title }));
  })()`, true);
  fs.writeFileSync(path.join(outDir, "agent-todo-actions.json"), JSON.stringify({ labels, icons, pageHeight, summary }, null, 2));
  console.log(JSON.stringify(summary));
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
