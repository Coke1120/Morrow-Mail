const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");

const root = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const output = path.resolve(process.argv[3] || "/opt/cursor/artifacts");
fs.mkdirSync(output, { recursive: true });

const fixture = `
const fixtureAccounts = [
  {
    id: "leo",
    email: "leo@hkbscl.com",
    platform: "imap",
    profile: "custom",
    delimiter: "/",
    folders: {
      primary: [
        { id: "INBOX", name: "Inbox", wellKnownName: "inbox", unreadCount: 3, chip: true },
      ],
      more: [
        { id: "AriesCPA.com", name: "AriesCPA.com", unreadCount: 84 },
        { id: "AriesCPA.com/1 Internal", name: "1 Internal", unreadCount: 1 },
        { id: "AriesCPA.com/AsiaBs", name: "AsiaBs", unreadCount: 0 },
        { id: "AriesCPA.com/1 Archive", name: "1 Archive", unreadCount: 0 },
      ],
    },
  },
  {
    id: "gmail",
    email: "howailoklineage@gmail.com",
    platform: "imap",
    profile: "gmail",
    imapSmtpProfile: "gmail",
    delimiter: "/",
    folders: {
      primary: [
        { id: "[Gmail]/All Mail", name: "All Mail", wellKnownName: "all", unreadCount: 0 },
        { id: "INBOX", name: "INBOX", wellKnownName: "inbox", unreadCount: 2, chip: true },
        { id: "[Gmail]/Sent Mail", name: "Sent Mail", wellKnownName: "sentitems", unreadCount: 0, chip: true },
      ],
      more: [],
    },
  },
];
const fixtureMessages = {
  "leo:INBOX": [{ id: "leo-in", accountId: "leo", folderId: "INBOX", from: "Desk <desk@example.invalid>", subject: "Leo inbox note", snippet: "Synthetic inbox row.", date: "2026-10-19T09:00:00Z", unread: true }],
  "leo:AriesCPA.com": [{ id: "leo-parent", accountId: "leo", folderId: "AriesCPA.com", from: "Books <books@example.invalid>", subject: "Aries parent folder", snippet: "Selecting the parent opens this folder.", date: "2026-10-18T09:00:00Z", unread: false }],
  "gmail:INBOX": [{ id: "gm-in", accountId: "gmail", folderId: "INBOX", from: "News <news@example.invalid>", subject: "Inbox only", snippet: "This row stays in Inbox.", date: "2026-10-19T08:00:00Z", unread: true }],
  "gmail:[Gmail]/All Mail": [{ id: "gm-all", accountId: "gmail", folderId: "[Gmail]/All Mail", from: "Client <client@example.invalid>", subject: "Archived client note", snippet: "All Mail keeps archived mail.", date: "2026-10-17T08:00:00Z", unread: false }],
  "gmail:[Gmail]/Trash": [{ id: "gm-trash", accountId: "gmail", folderId: "[Gmail]/Trash", from: "Old <old@example.invalid>", subject: "Trash only", snippet: "Trash is not All Mail.", date: "2026-10-16T08:00:00Z", unread: false }],
};
window.fixtureCalls = [];
window.collapsedStore = {};
window.morrow = {
  on() {},
  invoke: async (channel, payload) => {
    window.fixtureCalls.push({ channel, payload });
    if (channel === "morrow:configSetSidebarCollapsedFolders") {
      window.collapsedStore = payload;
      return payload;
    }
    if (channel === "morrow:configGetSidebarCollapsedFolders") return window.collapsedStore;
    if (channel === "mail:listFromCache" || channel === "mail:listFromNetwork") {
      const key = (payload && payload.accountId ? payload.accountId : "") + ":" + (payload && payload.folderId ? payload.folderId : "");
      const emails = fixtureMessages[key] || [];
      return { data: { emails, total: emails.length, initialSyncDone: true, hasMore: false } };
    }
    if (channel === "mail:listSnoozed") return { data: { records: [] } };
    if (channel === "mail:getSyncStatus") return { data: { state: "idle" } };
    return { data: {} };
  },
};
`;

const setup = `
Object.assign(state, {
  accounts: fixtureAccounts,
  accountId: "leo",
  folderId: "INBOX",
  emails: [{ id: "leo-in", accountId: "leo", folderId: "INBOX", from: "Desk <desk@example.invalid>", subject: "Leo inbox note", snippet: "Synthetic inbox row.", date: "2026-10-19T09:00:00Z", unread: true }],
  listTotal: 1,
  view: "mail",
});
state.prefs.collapsedFolders = {};
state.prefs.gmailOpen = true;
wire();
renderAccounts();
renderList();
window.folderShot = () => {
  const twists = [...document.querySelectorAll("button.folder-twist")].map((button) => ({
    label: button.getAttribute("aria-label"),
    expanded: button.getAttribute("aria-expanded"),
  }));
  const rows = [...document.querySelectorAll("#folders button.folder")].map((button) => ({
    account: button.dataset.accountId,
    id: button.dataset.folderId,
    name: button.querySelector(".name") ? button.querySelector(".name").textContent : "",
    count: button.querySelector(".count") ? button.querySelector(".count").textContent : "",
    current: button.getAttribute("aria-current") || "",
  }));
  const subjects = [...document.querySelectorAll("#message-list .subject")].map((node) => node.textContent);
  return { twists, rows, subjects, folderId: state.folderId, accountId: state.accountId, collapsed: state.prefs.collapsedFolders };
};
window.fixtureReady = true;
`;

let browser;
let socket;
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (!/^\/(renderer|shared)\/[\w./-]+$/.test(pathname) || pathname.includes("..")) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    let data = fs.readFileSync(path.join(root, pathname));
    if (pathname === "/renderer/app.js") {
      data = Buffer.from(fixture + data.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, "") + setup);
    }
    const type = pathname.endsWith(".js")
      ? "text/javascript"
      : pathname.endsWith(".css")
        ? "text/css"
        : pathname.endsWith(".html")
          ? "text/html"
          : "image/svg+xml";
    res.setHeader("Content-Type", type);
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const chromium = process.env.CHROMIUM || "/usr/bin/chromium";
  browser = spawn(chromium, [
    "--headless",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--remote-debugging-port=0",
    "--user-data-dir=" + fs.mkdtempSync(path.join(os.tmpdir(), "morrow-folder-sidebar-")),
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let endpoint = "";
  let chromeLog = "";
  browser.stderr.on("data", (chunk) => {
    chromeLog += chunk.toString();
    const match = chromeLog.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) endpoint = match[1];
  });
  for (let i = 0; i < 100 && !endpoint; i += 1) await delay(100);
  assert.ok(endpoint, "Chromium started\n" + chromeLog.slice(-800));
  const origin = endpoint.replace(/^ws:/, "http:").split("/devtools")[0];
  const target = await (await fetch(origin + "/json/new?about:blank", { method: "PUT" })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  let seq = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      errors.push(details.text + ": " + (details.exception && details.exception.description));
    }
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception && result.exceptionDetails.exception.description);
    }
    return result.result.value;
  };
  const shot = async (name, clip) => {
    await delay(200);
    const params = { format: "png", captureBeyondViewport: false };
    if (clip) params.clip = clip;
    const image = await cdp("Page.captureScreenshot", params);
    fs.writeFileSync(path.join(output, name + ".png"), Buffer.from(image.data, "base64"));
  };
  const clickSelector = async (selector) => {
    const box = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      node.scrollIntoView({ block: "center", inline: "nearest" });
      const rect = node.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    assert.ok(box, "missing " + selector);
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await delay(200);
  };
  const waitFor = async (expression, label) => {
    for (let i = 0; i < 40; i += 1) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    throw new Error(label + " " + JSON.stringify(await evaluate("window.folderShot()")));
  };
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: "http://127.0.0.1:" + server.address().port + "/renderer/index.html" });
  for (let i = 0; i < 100; i += 1) {
    if (await evaluate("window.fixtureReady===true")) break;
    await delay(100);
  }
  assert.equal(await evaluate("window.fixtureReady===true"), true, JSON.stringify(errors));
  const names = async () => evaluate("window.folderShot().rows.map((row) => row.account + ':' + row.name)");
  assert.deepEqual(await names(), [
    "leo:Inbox",
    "leo:AriesCPA.com",
    "leo:1 Internal",
    "leo:AsiaBs",
    "leo:1 Archive",
    "gmail:All Mail",
    "gmail:Inbox",
    "gmail:Sent Mail",
  ]);
  assert.equal(await evaluate("window.folderShot().rows.find((row) => row.id==='AriesCPA.com').count"), "84");
  assert.equal(await evaluate("window.folderShot().twists[0].label"), "Collapse AriesCPA.com");
  assert.equal(await evaluate("window.folderShot().twists[0].expanded"), "true");
  const allIndex = await evaluate("window.folderShot().rows.findIndex((row) => row.account==='gmail' && row.name==='All Mail')");
  const inboxIndex = await evaluate("window.folderShot().rows.findIndex((row) => row.account==='gmail' && row.name==='Inbox')");
  assert.ok(allIndex >= 0 && allIndex < inboxIndex, "All Mail is above Inbox");
  await shot("folder-parent-expanded");
  await clickSelector('button.folder-twist[aria-label="Collapse AriesCPA.com"]');
  await waitFor("window.folderShot().twists[0] && window.folderShot().twists[0].expanded==='false'", "caret collapsed");
  assert.equal(await evaluate("window.folderShot().folderId"), "INBOX");
  assert.equal(await evaluate("window.folderShot().accountId"), "leo");
  assert.deepEqual(await names(), [
    "leo:Inbox",
    "leo:AriesCPA.com",
    "gmail:All Mail",
    "gmail:Inbox",
    "gmail:Sent Mail",
  ]);
  assert.equal(await evaluate("window.folderShot().rows.find((row) => row.id==='AriesCPA.com').count"), "84");
  assert.equal(await evaluate("window.folderShot().twists[0].label"), "Expand AriesCPA.com");
  await shot("folder-parent-collapsed");
  await clickSelector('button.folder[data-account-id="leo"][data-folder-id="AriesCPA.com"]');
  await waitFor("window.folderShot().folderId==='AriesCPA.com'", "parent folder selected");
  assert.equal(await evaluate("window.folderShot().rows.some((row) => row.name==='1 Internal')"), false);
  assert.equal(await evaluate("window.folderShot().subjects[0]"), "Aries parent folder");
  await evaluate('document.querySelector(\'button.folder-twist[aria-label="Expand AriesCPA.com"]\').focus()');
  assert.equal(await evaluate("document.activeElement && document.activeElement.getAttribute('aria-label')"), "Expand AriesCPA.com");
  const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" };
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...enter });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
  await waitFor("window.folderShot().rows.some((row) => row.name==='1 Internal')", "keyboard expanded children");
  assert.equal(await evaluate("window.folderShot().folderId"), "AriesCPA.com");
  await evaluate('document.querySelector(\'button.folder[data-account-id="gmail"][data-folder-id="[Gmail]/All Mail"]\').scrollIntoView({block:"center"})');
  await shot("gmail-all-mail-above-inbox");
  await clickSelector('button.folder[data-account-id="gmail"][data-folder-id="[Gmail]/All Mail"]');
  await waitFor("window.folderShot().folderId==='[Gmail]/All Mail'", "All Mail selected");
  assert.equal(await evaluate("window.folderShot().accountId"), "gmail");
  assert.deepEqual(await evaluate("window.folderShot().subjects"), ["Archived client note"]);
  assert.equal(await evaluate("window.folderShot().subjects.includes('Inbox only')"), false);
  assert.equal(await evaluate("window.folderShot().subjects.includes('Trash only')"), false);
  await shot("gmail-all-mail-list");
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, "folder-sidebar-results.json"), JSON.stringify({
    output,
    shots: [
      "folder-parent-expanded.png",
      "folder-parent-collapsed.png",
      "gmail-all-mail-above-inbox.png",
      "gmail-all-mail-list.png",
    ],
    errors,
  }, null, 2));
  console.log("Folder sidebar shots passed: " + output);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (socket) socket.close();
  if (browser) browser.kill();
  server.close();
});
