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
    unreadCount: 3,
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
    unreadCount: 2,
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
      const boxes = payload && Array.isArray(payload.mailboxes) ? payload.mailboxes : null;
      if (payload && (payload.folderKey === "primary" || (boxes && boxes.length))) {
        const combined = [
          { id: "leo-in", accountId: "leo", folderId: "INBOX", from: "Desk <desk@example.invalid>", subject: "Leo inbox note", snippet: "Synthetic inbox row.", date: "2026-10-19T09:00:00Z", unread: true },
          { id: "gm-all", accountId: "gmail", folderId: "[Gmail]/All Mail", from: "Client <client@example.invalid>", subject: "Archived client note", snippet: "All Mail keeps archived mail.", date: "2026-10-17T08:00:00Z", unread: false },
          { id: "leo-read", accountId: "leo", folderId: "INBOX", from: "Read <read@example.invalid>", subject: "Already read", snippet: "Read inbox mail.", date: "2026-10-18T08:00:00Z", unread: false },
        ];
        const allowed = new Set((boxes || []).map((box) => box.accountId + "\0" + box.path));
        const scoped = boxes && boxes.length
          ? combined.filter((row) => allowed.has(row.accountId + "\0" + row.folderId))
          : combined;
        const emails = payload.filterUnread ? scoped.filter((row) => row.unread) : scoped;
        return { data: { emails, total: emails.length, initialSyncDone: true, hasMore: false } };
      }
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
  assert.equal(await evaluate("document.querySelector('button.all-inbox .name').textContent"), "All Account Mail");
  assert.equal(await evaluate("document.querySelector('button.all-account-unread').textContent"), "Unread 3");
  assert.equal(await evaluate("document.querySelector('button.all-account-unread').getAttribute('aria-pressed')"), "false");
  assert.equal(await evaluate("document.querySelector('button.all-inbox').getAttribute('aria-current')"), null);
  assert.equal(await evaluate("[...document.querySelectorAll('button.folder .name')].some((node) => node.textContent === 'All Account Mail')"), false);
  await clickSelector("button.all-inbox");
  await waitFor("state.allInbox===true && window.folderShot().subjects.includes('Already read') && window.folderShot().subjects.includes('Archived client note') && !window.folderShot().subjects.includes('Inbox only')", "All Account Mail list");
  assert.equal(await evaluate("document.getElementById('list-title').textContent"), "All Account Mail");
  assert.equal(await evaluate("document.querySelector('.all-account-mail').classList.contains('is-current')"), true);
  assert.equal(await evaluate("document.querySelector('button.all-account-unread').getAttribute('aria-pressed')"), "false");
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
  const sideClip = async () => evaluate(`(() => {
    const node = document.getElementById("side-mail");
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: Math.min(rect.height, 720), scale: 1 };
  })()`);
  await shot("all-account-mail", await sideClip());
  await clickSelector("button.all-account-unread");
  await waitFor("state.allInboxUnreadOnly===true && window.folderShot().subjects.includes('Leo inbox note') && !window.folderShot().subjects.includes('Already read')", "unread chip on");
  assert.equal(await evaluate("document.getElementById('list-title').textContent"), "All Account Mail · Unread");
  assert.equal(await evaluate("document.querySelector('button.all-account-unread').getAttribute('aria-pressed')"), "true");
  assert.equal(await evaluate("document.querySelector('button.all-inbox').getAttribute('aria-current')"), "true");
  const unreadCall = await evaluate("window.fixtureCalls.filter((call) => call.channel === 'mail:listFromCache' && call.payload && call.payload.folderKey === 'primary').pop()");
  assert.equal(unreadCall.payload.filterUnread, true);
  assert.equal(unreadCall.payload.folderKey, "primary");
  assert.deepEqual(unreadCall.payload.mailboxes.map((box) => box.accountId + ":" + box.path), ["leo:INBOX", "gmail:[Gmail]/All Mail"]);
  await shot("all-account-mail-unread", await sideClip());
  await shot("all-account-mail-unread-list");
  await clickSelector("button.all-account-unread");
  await waitFor("state.allInbox===true && state.allInboxUnreadOnly===false && window.folderShot().subjects.includes('Already read')", "unread chip off");
  assert.equal(await evaluate("document.querySelector('button.all-account-unread').getAttribute('aria-pressed')"), "false");
  assert.equal(await evaluate("document.getElementById('list-title').textContent"), "All Account Mail");
  const openCall = await evaluate("window.fixtureCalls.filter((call) => call.channel === 'mail:listFromCache' && call.payload && call.payload.folderKey === 'primary').pop()");
  assert.equal(openCall.payload.filterUnread, undefined);
  assert.match(await evaluate("document.getElementById('refresh').title"), /Gmail All Mail/);
  await clickSelector('button.folder[data-account-id="leo"][data-folder-id="INBOX"]');
  await waitFor("state.allInbox===false && window.folderShot().folderId==='INBOX' && window.folderShot().subjects[0]==='Leo inbox note'", "back to account inbox");
  assert.equal(await evaluate("document.querySelector('button.all-account-unread').getAttribute('aria-pressed')"), "false");
  assert.equal(await evaluate("document.querySelector('button.all-inbox').getAttribute('aria-current')"), null);
  assert.equal(await evaluate("document.querySelector('.all-account-mail').classList.contains('is-current')"), false);
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
  const fit = async () => evaluate(`(() => {
    const folders = document.getElementById("folders");
    const box = folders.getBoundingClientRect();
    const limit = box.left + folders.clientLeft + folders.clientWidth;
    const origin = box.left + folders.clientLeft;
    const bad = [];
    const nodes = folders.querySelectorAll(".folder-line, button.account, h2, button.ghost");
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0) continue;
      if (rect.right > limit + 1 || rect.left < origin - 1) bad.push((node.innerText || node.className || "").trim().slice(0, 80));
    }
    for (const count of folders.querySelectorAll(".count")) {
      const rect = count.getBoundingClientRect();
      if (rect.right > limit + 1 || rect.left < origin - 1 || rect.width < 12) bad.push("count " + count.textContent);
    }
    for (const twist of folders.querySelectorAll("button.folder-twist, .folder-twist-mark")) {
      const rect = twist.getBoundingClientRect();
      if (rect.right > limit + 1 || rect.left < origin - 1 || rect.width < 10) bad.push("twist " + (twist.getAttribute("aria-label") || "mark"));
    }
    const longName = [...folders.querySelectorAll("button.folder .name")].find((node) => node.scrollWidth > node.clientWidth + 1);
    return {
      bad,
      overflowX: getComputedStyle(folders).overflowX,
      overflowY: getComputedStyle(folders).overflowY,
      scrollWidth: folders.scrollWidth,
      clientWidth: folders.clientWidth,
      truncated: longName ? longName.textContent : "",
      title: longName ? longName.title : "",
    };
  })()`);
  const initialFit = await fit();
  assert.equal(initialFit.overflowX, "hidden");
  assert.equal(initialFit.overflowY, "auto");
  assert.ok(initialFit.scrollWidth <= initialFit.clientWidth + 1, JSON.stringify(initialFit));
  assert.deepEqual(initialFit.bad, []);
  await evaluate(`(() => {
    const input = document.getElementById("folder-filter");
    input.value = "asia";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  assert.deepEqual(await names(), ["leo:AriesCPA.com", "leo:AsiaBs"]);
  assert.equal(await evaluate("document.querySelector('button.all-inbox')"), null);
  const headings = await evaluate("[...document.querySelectorAll('#folders :is(h2, button.account)')].map((node) => node.textContent.trim())");
  assert.deepEqual(headings, ["leo@hkbscl.com"]);
  assert.equal(await evaluate("document.querySelector('button.folder.is-filter-match .name').textContent"), "AsiaBs");
  assert.equal(await evaluate("!!document.querySelector('button.folder.is-filter-match')"), true);
  assert.equal(await evaluate("document.getElementById('folder-filter-clear').hidden"), false);
  await shot("folder-filter-asia");
  await evaluate(`document.getElementById("folder-filter-clear").click()`);
  assert.equal(await evaluate("document.getElementById('folder-filter').value"), "");
  assert.equal(await evaluate("document.getElementById('folder-filter-clear').hidden"), true);
  assert.ok((await names()).includes("leo:1 Internal"));
  await evaluate(`(() => {
    const input = document.getElementById("folder-filter");
    input.value = "asia";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  assert.deepEqual(await names(), ["leo:AriesCPA.com", "leo:AsiaBs"]);
  await evaluate(`(() => {
    state.selectedIds = ["keep-me"];
    const input = document.getElementById("folder-filter");
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  })()`);
  assert.equal(await evaluate("document.getElementById('folder-filter').value"), "");
  assert.deepEqual(await evaluate("state.selectedIds"), ["keep-me"]);
  assert.equal(await evaluate("document.activeElement === document.getElementById('folder-filter')"), true);
  await evaluate(`document.getElementById("folder-filter").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
  assert.equal(await evaluate("document.activeElement === document.getElementById('folder-filter')"), false);
  assert.ok((await names()).includes("leo:1 Internal"));
  assert.ok((await names()).includes("gmail:Inbox"));
  await evaluate(`(() => {
    const input = document.getElementById("folder-filter");
    input.value = "Inbox";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  const inboxNames = await names();
  assert.ok(inboxNames.includes("leo:Inbox") && inboxNames.includes("gmail:Inbox"), JSON.stringify(inboxNames));
  assert.equal(inboxNames.includes("leo:AsiaBs"), false);
  assert.equal(await evaluate("!!document.querySelector('button.all-inbox')"), false);
  await evaluate(`(() => {
    const input = document.getElementById("folder-filter");
    input.value = "account";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  assert.equal(await evaluate("document.querySelector('button.all-inbox .name').textContent"), "All Account Mail");
  assert.equal(await evaluate("!!document.querySelector('button.all-account-unread')"), true);
  await evaluate(`(() => {
    document.getElementById("folder-filter").value = "";
    document.getElementById("folder-filter").dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await evaluate(`(() => {
    const account = state.accounts.find((row) => row.id === "leo");
    account.folders.more.push({ id: "AriesCPA.com/AsiaBs/Q1", name: "Q1", unreadCount: 0 });
    let parent = "AriesCPA.com";
    for (let i = 0; i < 24; i += 1) {
      const id = parent + "/Level " + i + " Very long label name that should truncate";
      account.folders.more.push({
        id,
        name: "Level " + i + " Very long label name that should truncate",
        unreadCount: i === 23 ? 178 : 0,
      });
      parent = id;
    }
    const input = document.getElementById("folder-filter");
    input.value = "q1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  assert.deepEqual(await names(), ["leo:AriesCPA.com", "leo:AsiaBs", "leo:Q1"]);
  await evaluate(`(() => {
    const input = document.getElementById("folder-filter");
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  const deepFit = await fit();
  assert.equal(deepFit.overflowX, "hidden");
  assert.ok(deepFit.scrollWidth <= deepFit.clientWidth + 1, JSON.stringify(deepFit));
  assert.deepEqual(deepFit.bad, [], JSON.stringify(deepFit));
  assert.ok(deepFit.truncated.includes("Very long label"), JSON.stringify(deepFit));
  assert.equal(deepFit.title, deepFit.truncated);
  assert.ok(await evaluate("[...document.querySelectorAll('#folders .count')].some((node) => node.textContent === '178')"));
  await evaluate(`[...document.querySelectorAll("#folders .count")].find((node) => node.textContent === "178").scrollIntoView({ block: "center", inline: "nearest" })`);
  await shot("folder-tree-truncated");
  const rowBox = await evaluate(`(() => {
    const node = document.querySelector(".message-row");
    node.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = node.getBoundingClientRect();
    return { x: rect.x + Math.min(80, rect.width / 2), y: rect.y + rect.height / 2 };
  })()`);
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: rowBox.x, y: rowBox.y });
  await shot("mail-row-hover-actions");
  const listFit = await evaluate(`(() => {
    const list = document.getElementById("message-list");
    return { scrollWidth: list.scrollWidth, clientWidth: list.clientWidth };
  })()`);
  assert.ok(listFit.scrollWidth <= listFit.clientWidth + 1, JSON.stringify(listFit));
  const actions = await evaluate("[...document.querySelectorAll('[data-testid=\"mail-row-actions\"] button')].map((button) => button.getAttribute('aria-label'))");
  assert.deepEqual(actions, ["Star", "Mark unread", "Reply", "Reply All", "Forward", "Delete"]);
  await evaluate(`document.querySelector('[data-testid="mail-row-actions"] [data-action="star"]').click()`);
  await waitFor("state.busy === false && window.fixtureCalls.some((call) => call.channel === 'mail:toggleStar')", "star toggle");
  assert.equal(await evaluate("document.querySelector('[data-action=\"star\"]').getAttribute('aria-label')"), "Unstar");
  assert.equal(await evaluate("document.querySelector('[data-action=\"star\"]').getAttribute('aria-pressed')"), "true");
  assert.equal(await evaluate("document.querySelector('.message-row').mailMessage.isStarred"), true);
  const starCall = await evaluate("window.fixtureCalls.filter((call) => call.channel === 'mail:toggleStar').pop()");
  assert.equal(starCall.payload.isStarred, true);
  await evaluate(`(() => {
    const row = document.querySelector(".message-row");
    state.email = row.mailMessage;
    row.querySelector('[data-action="forward"]').click();
  })()`);
  await waitFor("document.getElementById('compose').open === true", "forward compose");
  assert.equal(await evaluate("document.getElementById('compose-title').textContent"), "Forward");
  assert.equal(await evaluate("document.getElementById('compose-subject').value"), "Fwd: Archived client note");
  await shot("folder-filter-and-hover");
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, "folder-sidebar-results.json"), JSON.stringify({
    output,
    shots: [
      "folder-parent-expanded.png",
      "folder-parent-collapsed.png",
      "gmail-all-mail-above-inbox.png",
      "gmail-all-mail-list.png",
      "folder-filter-asia.png",
      "folder-tree-truncated.png",
      "mail-row-hover-actions.png",
      "folder-filter-and-hover.png",
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
