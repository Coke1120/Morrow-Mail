const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const vm = require("node:vm");

function element(tag) {
  const node = {
    tag,
    children: [],
    className: "",
    hidden: false,
    disabled: false,
    textContent: "",
    value: "",
    dataset: {},
    attrs: {},
    listeners: [],
    style: {},
    classList: null,
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name]; },
    removeAttribute(name) { delete this.attrs[name]; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); },
    append(...nodes) { for (const child of nodes) this.appendChild(child); },
    appendChild(child) {
      if (child && child.parentNode && child.parentNode !== this) {
        child.parentNode.children = child.parentNode.children.filter((item) => item !== child);
      }
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    insertBefore(child, before) {
      if (child && child.parentNode && child.parentNode !== this) {
        child.parentNode.children = child.parentNode.children.filter((item) => item !== child);
      }
      child.parentNode = this;
      const index = before ? this.children.indexOf(before) : -1;
      if (index < 0) this.children.push(child);
      else this.children.splice(index, 0, child);
      return child;
    },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; },
    replaceChildren() { this.children = []; },
    addEventListener(type, fn) { this.listeners.push({ type, fn }); },
    removeEventListener() {},
    focus() {},
    click() {
      for (const listener of this.listeners) {
        if (listener.type === "click") listener.fn({ preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
      }
    },
    querySelector(selector) { return query(this, selector); },
  };
  node.classList = {
    add(...names) { node.className = `${node.className} ${names.join(" ")}`.trim(); },
    remove() {},
    toggle(name, force) {
      const has = node.className.split(/\s+/).includes(name);
      const on = force === undefined ? !has : !!force;
      if (on && !has) node.className = `${node.className} ${name}`.trim();
      if (!on && has) node.className = node.className.split(/\s+/).filter((part) => part !== name).join(" ");
    },
    contains(name) { return node.className.split(/\s+/).includes(name); },
  };
  return node;
}

function matches(node, selector) {
  if (selector.startsWith(".")) return node.className.split(/\s+/).includes(selector.slice(1));
  const attr = selector.match(/^\[([A-Za-z0-9-]+)=['"]([^'"]+)['"]\]$/);
  if (!attr) return false;
  const [, name, value] = attr;
  if (name.startsWith("data-")) {
    const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (node.dataset[key] === value) return true;
  }
  return node.attrs[name] === value;
}

function query(node, selector) {
  for (const child of node.children) {
    if (matches(child, selector)) return child;
    const found = query(child, selector);
    if (found) return found;
  }
  return null;
}

function actions(reader) {
  const bar = reader.children.find((child) => child.className === "reader-actions");
  const names = [];
  const walk = (node) => {
    if (node.dataset && node.dataset.action) names.push(node.dataset.action);
    for (const child of node.children || []) walk(child);
  };
  walk(bar);
  return names;
}

function suggestionCount(calls) {
  return calls.filter((channel) => channel === "aiDraftWrite:replySuggestions").length;
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

function renderer() {
  const reader = element("section");
  reader.id = "reader";
  const status = element("p");
  status.id = "status";
  const document = {
    getElementById(id) {
      if (id === "reader") return reader;
      if (id === "status") return status;
      return element("div");
    },
    createElement: element,
    createElementNS: (_ns, tag) => element(tag),
  };
  const context = vm.createContext({
    window: { morrow: { on() {}, invoke: async () => ({}) }, addEventListener() {} },
    document,
    console,
    setTimeout,
    clearTimeout,
    navigator: { onLine: true },
  });
  context.window.morrowComposePolicy = require("../shared/compose-policy");
  const source = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8")
    .replace(/boot\(\)\.catch\([^\n]+\);\s*$/, `
      globalThis.__mail = {
        get state() { return state; },
        openMessage,
        renderReader,
        get opened() { return globalThis.__opened || null; },
        set call(fn) { call = fn; },
        set renderList(fn) { renderList = fn; },
        set openCompose(fn) { openCompose = fn; },
        makeError(message) { return new Error(message); },
      };
    `);
  vm.runInContext(source, context);
  context.__mail.reader = reader;
  return context.__mail;
}

async function main() {
  const ui = renderer();
  const email = {
    id: "one",
    accountId: "alpha",
    subject: "Notes",
    from: "Ada <ada@example.test>",
    textBody: "See you tomorrow.",
    date: "2026-10-18T08:00:00Z",
    messageId: "<one@test>",
  };
  const other = { ...email, id: "two", subject: "Later", messageId: "<two@test>" };
  ui.state.accounts = [{ id: "alpha", email: "me@alpha.test" }];
  ui.state.accountId = "alpha";
  ui.state.prefs.aiReply = true;
  ui.state.prefs.snooze = true;
  const calls = [];
  let opened = null;
  ui.call = async (channel) => {
    calls.push(channel);
    if (channel === "mail:openEmail") {
      const id = calls.filter((name) => name === "mail:openEmail").length;
      return { email: id === 1 ? email : other, threadMessages: [id === 1 ? email : other] };
    }
    if (channel === "aiDraftWrite:replySuggestions") return { suggestions: ["Thanks, I'll read it."] };
    return {};
  };
  ui.renderList = () => {};
  ui.openCompose = async (seed) => { opened = seed; };

  await ui.openMessage("one", false);
  await flush();
  assert.equal(suggestionCount(calls), 0, "opening mail must not request reply suggestions");
  assert.equal(ui.reader.querySelector(".suggestions").hidden, true);
  const readerActions = actions(ui.reader);
  assert.deepEqual(readerActions.slice(0, 4), ["reply", "reply-all", "suggest", "forward"]);
  const starAt = readerActions.indexOf("star");
  assert.equal(readerActions[starAt + 1], "translate");
  assert.equal(readerActions[starAt + 2], "translate-cancel");
  assert.equal(readerActions.includes("translate-cancel"), true);
  assert.equal(readerActions.includes("snooze"), true);
  assert.equal(ui.reader.children.some((child) => child.className === "translate"), false);
  const suggest = ui.reader.querySelector('[data-action="suggest"]');
  assert.equal(suggest.attrs["aria-label"], "Suggest a reply");
  assert.equal(suggest.children.some((child) => child.textContent === "Suggest"), true);

  ui.reader.querySelector('[data-action="reply"]').click();
  await flush();
  assert.equal(opened.title, "Reply");
  ui.reader.querySelector('[data-action="reply-all"]').click();
  await flush();
  assert.equal(opened.title, "Reply All");
  ui.reader.querySelector('[data-action="forward"]').click();
  await flush();
  assert.equal(suggestionCount(calls), 0, "Reply, Reply All, and Forward must not request suggestions");
  assert.equal(opened.title, "Forward");

  suggest.click();
  suggest.click();
  assert.equal(suggest.disabled, true);
  assert.equal(ui.reader.querySelector("[data-role='suggest-status']").textContent, "Suggesting replies…");
  await flush();
  assert.equal(suggestionCount(calls), 1, "Suggest requests reply suggestions once");
  assert.equal(suggest.disabled, false);
  const chip = ui.reader.querySelector(".suggest-list").children[0];
  assert.equal(chip.textContent, "Thanks, I'll read it.");

  ui.renderReader(false);
  await flush();
  assert.equal(suggestionCount(calls), 1, "repainting the open message must not request suggestions again");
  assert.equal(ui.reader.querySelector(".suggest-list").children[0].textContent, "Thanks, I'll read it.");

  ui.reader.querySelector(".suggest-list").children[0].click();
  await flush();
  assert.equal(opened.title, "Reply");
  assert.equal(opened.body, "Thanks, I'll read it.");
  assert.equal(suggestionCount(calls), 1);

  await ui.openMessage("two", false);
  await flush();
  assert.equal(suggestionCount(calls), 1, "selecting another message must not request suggestions");
  assert.equal(ui.reader.querySelector(".suggestions").hidden, true);

  ui.call = async (channel) => {
    calls.push(channel);
    if (channel === "aiDraftWrite:replySuggestions") return { suggestions: [] };
    return {};
  };
  ui.reader.querySelector('[data-action="suggest"]').click();
  await flush();
  assert.equal(suggestionCount(calls), 2);
  assert.equal(ui.reader.querySelector("[data-role='suggest-status']").textContent, "No reply suggestions.");

  ui.call = async (channel) => {
    calls.push(channel);
    if (channel === "aiDraftWrite:replySuggestions") throw ui.makeError("Add an API key in Morrow Mail → AI Setup.");
    return {};
  };
  ui.reader.querySelector('[data-action="suggest"]').click();
  await flush();
  assert.equal(ui.reader.querySelector("[data-role='suggest-status']").textContent, "Add an API key in Morrow Mail → AI Setup.");
  const beforeRepaint = suggestionCount(calls);
  ui.renderReader(false);
  await flush();
  assert.equal(suggestionCount(calls), beforeRepaint, "an error must not retry suggestions on repaint");

  const log = {
    openSuggestCalls: 0,
    afterSuggest: 1,
    afterSecondMessage: 1,
    replyActionsDoNotSuggest: true,
    empty: "No reply suggestions.",
    error: "Add an API key in Morrow Mail → AI Setup.",
  };
  console.log(`suggest-on-demand-ok ${JSON.stringify(log)}`);
  await browserShot();
}

async function browserShot() {
  const root = path.join(__dirname, "..");
  const out = "/opt/cursor/artifacts";
  const chrome = process.env.CHROMIUM || "/usr/local/bin/google-chrome";
  if (!fs.existsSync(chrome)) {
    console.log("suggest-browser-skipped");
    return;
  }
  fs.mkdirSync(out, { recursive: true });
  const fixture = `
    window.fixtureCalls = [];
    window.morrow = { on() {}, invoke: async (channel) => {
      fixtureCalls.push(channel);
      if (channel === "aiDraftWrite:replySuggestions") return { success: true, data: { suggestions: ["Thanks, I will review the notes."] } };
      return { success: true, data: {} };
    } };
  `;
  const setup = `
    state.accounts = [{ id: "alpha", email: "ada@example.test" }];
    state.accountId = "alpha";
    state.prefs.aiReply = true;
    state.email = { id: "one", accountId: "alpha", subject: "Project notes", from: "Ada Lovelace <ada@example.test>", to: ["ada@example.test"], textBody: "Can you review the notes?", date: "2026-10-18T08:00:00.000Z" };
    state.thread = [];
    renderList = () => {};
    renderReader(false);
    window.fixtureReady = true;
  `;
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
      const type = pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : pathname.endsWith(".html") ? "text/html" : "image/svg+xml";
      res.setHeader("Content-Type", type);
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const profile = fs.mkdtempSync(path.join("/tmp", "morrow-suggest-"));
  const browser = spawn(chrome, [
    "--headless", "--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let endpoint = "";
  browser.stderr.on("data", (buf) => {
    const match = buf.toString().match(/DevTools listening on (ws:\/\/\S+)/);
    if (match) endpoint = match[1];
  });
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    for (let i = 0; i < 100 && !endpoint; i += 1) await delay(100);
    assert.ok(endpoint, "Chrome started");
    const origin = endpoint.replace(/^ws:/, "http:").split("/devtools")[0];
    const target = await (await fetch(`${origin}/json/new?about:blank`, { method: "PUT" })).json();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
    let seq = 0;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    });
    const cdp = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const shot = async (name) => {
      const clip = await evaluate(`(() => { const r = document.getElementById("reader").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(420, r.height), scale: 1 }; })()`);
      const picture = await cdp("Page.captureScreenshot", { format: "png", clip });
      fs.writeFileSync(path.join(out, name), Buffer.from(picture.data, "base64"));
    };
    await cdp("Runtime.enable");
    await cdp("Page.enable");
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/renderer/index.html` });
    for (let i = 0; i < 100; i += 1) {
      if (await evaluate("window.fixtureReady === true")) break;
      await delay(100);
    }
    assert.equal(await evaluate("window.fixtureReady === true"), true);
    const opened = await evaluate(`(() => {
      const names = [...document.querySelectorAll("#reader .reader-actions [data-action]")].map((node) => node.dataset.action);
      const calls = fixtureCalls.filter((channel) => channel === "aiDraftWrite:replySuggestions").length;
      const box = document.querySelector("#reader .suggestions");
      return { names: names.slice(0, 4), calls, hidden: !box || box.hidden, text: document.querySelector("#reader .suggest-list")?.textContent || "" };
    })()`);
    assert.deepEqual(opened.names, ["reply", "reply-all", "suggest", "forward"]);
    assert.equal(opened.calls, 0);
    assert.equal(opened.hidden, true);
    assert.equal(opened.text, "");
    await shot("suggest-open-quiet.png");
    await evaluate(`document.querySelector('#reader [data-action="suggest"]').click()`);
    for (let i = 0; i < 50; i += 1) {
      if (await evaluate(`document.querySelector("#reader .suggest-list")?.textContent.includes("Thanks, I will review the notes.")`)) break;
      await delay(50);
    }
    const suggested = await evaluate(`(() => ({
      calls: fixtureCalls.filter((channel) => channel === "aiDraftWrite:replySuggestions").length,
      text: document.querySelector("#reader .suggest-list")?.textContent || "",
      label: document.querySelector('#reader [data-action="suggest"]')?.getAttribute("aria-label") || "",
    }))()`);
    assert.equal(suggested.calls, 1);
    assert.equal(suggested.text, "Thanks, I will review the notes.");
    assert.equal(suggested.label, "Suggest a reply");
    await shot("suggest-clicked.png");
    console.log(`suggest-browser-ok ${JSON.stringify({ opened, suggested })}`);
    socket.close();
  } finally {
    browser.kill();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
