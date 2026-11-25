// Synthetic fixtures only. Run with node --test scripts/check-receipt-pdf.js.
const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");
const vm = require("node:vm");
const { receiptHtml } = require("../host/receipt-pdf-document");
const { createReceiptPdf } = require("../host/receipt-pdf");

const email = {
  id: "receipt-1", accountId: "fixture", bodyEpoch: 6, subject: "Dues <November>",
  from: "Billing", fromAddress: "invoices@example.test", date: "2026-11-25T19:23:55+08:00",
  bodyComplete: true, hasBody: true, htmlBody: null, textBody: "USD 1,234.50\n\nLast line",
};
const reply = email => ({ success: true, data: { email } });
const shownAs = ({ id, accountId, bodyEpoch }, presentation) => ({ id, accountId, bodyEpoch, presentation });
const multipart = {
  ...email, htmlBody: "<p>HTML greeting</p>", textBody: "Order <246>\nPaid HKD 72.40\nFinal & last line",
};
const imageAlternative = { ...multipart, htmlBody: '<img src="cid:order" alt="Order total">' };

test("keeps headings, ordered table cells, spans, money, and final text in inert markup", () => {
  const html = receiptHtml({ ...email, htmlBody: `<head><style>sender CSS</style></head><h2>Item &amp; tax</h2>
    <table><tr><th rowspan="2" colspan="3" onclick="bad()">HK$1,234.50</th><td>USD 9.99</td></tr>
    <tr><td><a href="https://example.test/">Total</a></td></tr></table>
    <img src="cid:private" alt="Only decoration"><svg><text>vector text</text></svg>
    <span style="display:none">Hidden preheader</span><script>sender script</script><p>First<br>Final &lt;line&gt;</p>`, textBody: null }, "html");
  assert.match(receiptHtml({ ...email, date: "2026-11-25T09:00:00" }, "plain"), /09:00:00 \(time zone unavailable\)/);
  assert.match(html, /Dues &lt;November&gt;[\s\S]*invoices@example\.test[\s\S]*2026-11-25 19:23:55 UTC\+08:00/);
  assert.match(html, /<h2>Item &amp; tax<\/h2>[\s\S]*<th colspan="3" rowspan="2">HK\$1,234\.50<\/th><td>USD 9\.99<\/td>[\s\S]*<td>Total<\/td>[\s\S]*First<br>Final &lt;line&gt;/);
  assert.doesNotMatch(html, /Hidden preheader|sender CSS|sender script|onclick=|example\.test\/|cid:private|vector text|<img/);
  assert.match(receiptHtml({ ...email, date: "2026-11-25T11:23:55.000Z" }, "plain"), /11:23:55\.000 UTC[\s\S]*USD 1,234\.50\n\nLast line/);
  const htmlVariant = receiptHtml(multipart, "html");
  assert.match(htmlVariant, /<p>HTML greeting<\/p>/);
  assert.doesNotMatch(htmlVariant, /72\.40|Final &amp;/);
  for (const message of [multipart, imageAlternative]) {
    const plainVariant = receiptHtml(message, "plain");
    assert.match(plainVariant, /Order &lt;246&gt;\nPaid HKD 72\.40\nFinal &amp; last line/);
    assert.doesNotMatch(plainVariant, /HTML greeting|cid:order|<img/);
  }
});

test("rejects incomplete, warning, image-only, snippet-only and oversized bodies", () => {
  for (const patch of [
    { bodyComplete: false }, { encodingWarning: "Unreadable" }, { bodyWarning: "Partial" },
    { textBody: null, snippet: "USD 5.00" }, { textBody: "x".repeat(512 * 1024 + 1) },
    { textBody: "x\n".repeat(3001) },
  ]) assert.throws(() => receiptHtml({ ...email, ...patch }, "plain"));
  assert.throws(() => receiptHtml(imageAlternative, "html"), /no readable text/);
  assert.throws(() => receiptHtml(email, "html"), /no readable text/);
  assert.throws(() => receiptHtml({ ...multipart, textBody: null }, "plain"), /no readable text/);
  assert.throws(() => receiptHtml({ ...email, htmlBody: "<pre>" + "x\n".repeat(3001) + "</pre>" }, "html"), /too large/);
  assert.throws(() => receiptHtml({ ...email, htmlBody: "x".repeat(512 * 1024) }, "plain"), /too large/);
});

test("Reader proof comes from its seeded main-frame reply and expires on reload", async () => {
  const htmlFile = path.resolve(__dirname, "../renderer/index.html");
  function Window() {
    this.webContents = Object.assign(new EventEmitter(), {
      id: 1, setZoomLevel() {}, setWindowOpenHandler() {},
    });
    this.isDestroyed = this.isMinimized = () => false;
    this.isVisible = () => true;
    this.loadFile = async () => {};
  }
  Object.setPrototypeOf(Window.prototype, EventEmitter.prototype);
  const file = path.resolve(__dirname, "../host/reader-window.js");
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), {
    module, AbortController, setTimeout, clearTimeout,
    require: name => ({
      electron: { BrowserWindow: Window, screen: { getAllDisplays: () => [] },
        ipcMain: { handle() {} } },
      "./window-state": require("../host/window-state"),
      "./reader-window-state": { read: () => null },
      "node:url": { pathToFileURL },
    })[name],
  });
  const host = module.exports.createReaderHost({ htmlFile });
  host.register();
  host.open({ accountId: email.accountId, messageId: email.id });
  const win = host.records.get(1).win;
  const contents = win.webContents;
  const url = pathToFileURL(htmlFile).href + "?role=reader";
  const pane = new Proxy({}, { get() { assert.fail("The Reader query must not read mail markup"); } });
  const state = { email: multipart };
  const plainBodyViews = new WeakMap();
  const reader = vm.createContext({
    location: { href: url }, pendingOpenId: null, pendingOpenBody: false, state, plainBodyViews,
    $(id) { assert.equal(id, "reader"); return pane; },
  });
  const frame = { url, processId: 2, routingId: 3, executeJavaScript: async code => {
    // Match Electron's serialization across the main-frame boundary.
    return JSON.parse(JSON.stringify(vm.runInContext(code, reader)));
  } };
  contents.mainFrame = frame;
  contents.emit("did-frame-navigate", {}, url, -1, "", true, 2, 3);
  const params = { accountId: email.accountId, emailId: email.id, includeThread: false };
  assert.equal(host.observeOpen({ sender: contents, senderFrame: {} }, params), null);
  assert.equal(host.observeOpen({ sender: contents, senderFrame: frame }, { ...params, emailId: "other" }), null);
  const event = { sender: contents, senderFrame: frame };
  const observe = host.observeOpen(event, params);
  assert.equal(host.receiptSource(win), null);
  observe(reply(email));
  const source = host.receiptSource(win);
  assert.equal(source.bodyEpoch, 6);
  assert.equal(host.observeOpen(event, params), null);
  assert.equal(await source.renderedIdentity(), null);
  const choice = { key: JSON.stringify([email.accountId, "other"]), plain: false };
  plainBodyViews.set(pane, choice);
  assert.equal(await source.renderedIdentity(), null);
  choice.key = JSON.stringify([email.accountId, email.id]);
  assert.deepEqual(await source.renderedIdentity(), shownAs(email, "html"));
  choice.plain = true;
  assert.deepEqual(await source.renderedIdentity(), shownAs(email, "plain"));
  state.email = imageAlternative;
  assert.deepEqual(await source.renderedIdentity(), shownAs(email, "plain"));
  choice.plain = false;
  assert.deepEqual(await source.renderedIdentity(), shownAs(email, "html"));
  state.email = email;
  assert.deepEqual(await source.renderedIdentity(), shownAs(email, "plain"));
  contents.emit("did-start-navigation", { isMainFrame: true });
  assert.equal(source.isCurrent(), false);
  assert.equal(source.signal.aborted, true);
  assert.equal(source.renderedIdentity(), null);
  observe(reply({ ...email, bodyEpoch: 7 }));
  assert.equal(host.receiptSource(win), null);
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-receipt-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "receipt.pdf");
  const controller = new AbortController();
  const events = new EventEmitter();
  const sessions = [];
  const pdf = Buffer.from("%PDF-1.7\nfixture bytes");
  let cached = email;
  let shown = shownAs(email, "plain");
  let printed;
  let afterPrint = () => {};
  let readerClosed = false;
  let pick = () => ({ canceled: false, filePath: destination });

  class Window extends EventEmitter {
    constructor(options) {
      super();
      const ipc = new Map();
      this.session = options.webPreferences.session;
      this.webContents = Object.assign(new EventEmitter(), {
        ipc: { handle: (name, fn) => ipc.set(name, fn) },
        setWindowOpenHandler() {},
        printToPDF: async () => { afterPrint(); return pdf; },
      });
      this.invoke = (name, frame = this.webContents.mainFrame) => ipc.get("receipt-pdf:" + name)({
        sender: this.webContents, senderFrame: frame,
      });
      this.removeMenu = () => {};
    }
    async loadURL(url) {
      this.webContents.mainFrame = { url };
      this.webContents.emit("did-start-navigation", { isMainFrame: true });
      assert.equal(this.session.blocked({ url, method: "GET", resourceType: "mainFrame" }), false);
      assert.equal(this.session.blocked({ url: "https://example.test/", method: "GET", resourceType: "script" }), true);
      const response = await this.session.serve({ url, method: "GET" });
      assert.equal(response.status, 200);
      if (url === "morrow://receipt-print/index.html") printed = await response.text();
    }
    show() { events.emit("preview", this); }
    isDestroyed() { return !!this.destroyed; }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
  }

  const start = createReceiptPdf({
    electron: {
      BrowserWindow: Window,
      session: {
        fromPartition() {
          const session = Object.assign(new EventEmitter(), {
            protocol: {
              handle: (_, fn) => { session.serve = fn; },
              unhandle: () => { session.serve = null; },
            },
            setPermissionRequestHandler() {},
            setPermissionCheckHandler() {},
            webRequest: { onBeforeRequest: fn => {
              session.blocked = fn && (details => { let value; fn(details, result => { value = result.cancel; }); return value; });
            } },
          });
          sessions.push(session);
          return session;
        },
      },
      dialog: {
        showSaveDialog: async () => pick(),
        showMessageBox: async (_win, info) => events.emit("warning", info.message),
      },
    },
    readCached: params => {
      assert.deepEqual(params, { accountId: email.accountId, emailId: email.id, bodyEpoch: email.bodyEpoch });
      return reply(cached);
    },
    sourceFor: () => ({
      accountId: email.accountId, messageId: email.id, bodyEpoch: email.bodyEpoch,
      signal: controller.signal, isCurrent: () => !readerClosed, renderedIdentity: async () => shown,
    }),
    enabled: () => true,
  });
  return {
    destination, directory, sessions, pdf,
    get printed() { return printed; },
    changeCache(next) { cached = next; },
    render(next) { shown = next; },
    afterPrint(fn) { afterPrint = fn; },
    closeReader() { readerClosed = true; controller.abort(); },
    choose(fn) { pick = fn; },
    async rejectPreview() {
      const warning = once(events, "warning");
      await start({ isDestroyed: () => false });
      const [message] = await warning;
      return message;
    },
    async preview() {
      const opened = once(events, "preview");
      const finished = start({ isDestroyed: () => false });
      const [win] = await opened;
      assert.equal(win.invoke("bytes", {}), null);
      const bytes = win.invoke("bytes");
      assert.deepEqual(Buffer.from(bytes), pdf);
      assert.equal(win.invoke("ready"), true);
      return { win, bytes, finished };
    },
  };
}

test("canceling the save dialog writes nothing and retry writes the exact preview bytes", { timeout: 4000 }, async t => {
  const f = fixture(t);
  f.changeCache(imageAlternative);
  const { win, bytes, finished } = await f.preview();
  assert.match(f.printed, /Order &lt;246&gt;\nPaid HKD 72\.40\nFinal &amp; last line/);
  assert.doesNotMatch(f.printed, /cid:order|<img/);
  f.choose(() => ({ canceled: true }));
  await win.invoke("save");
  assert.deepEqual(fs.readdirSync(f.directory), []);
  f.choose(() => ({ canceled: false, filePath: f.destination }));
  await win.invoke("save");
  await finished;
  assert.deepEqual(fs.readFileSync(f.destination), Buffer.from(bytes));
  assert.deepEqual(fs.readdirSync(f.directory), ["receipt.pdf"]);
  assert.ok(f.sessions.every(session => !session.serve && !session.blocked && !session.listenerCount("will-download")));
});

test("preview and save revalidate the Reader presentation and message", { timeout: 4000 }, async t => {
  const f = fixture(t);
  f.changeCache(multipart);
  for (const source of [shownAs(email, undefined), shownAs(email, "auto")]) {
    f.render(source);
    assert.match(await f.rejectPreview(), /source message or mailbox changed/);
  }
  f.changeCache(imageAlternative);
  f.render(shownAs(email, "html"));
  assert.match(await f.rejectPreview(), /no readable text/);
  assert.equal(f.sessions.length, 0);
  f.changeCache(multipart);
  f.render(shownAs(email, "plain"));
  f.afterPrint(() => f.render(shownAs(email, "html")));
  assert.match(await f.rejectPreview(), /source message or mailbox changed/);
  assert.equal(f.sessions.length, 1);
  f.afterPrint(() => {});

  const { win, finished } = await f.preview();
  assert.match(f.printed, /<p>HTML greeting<\/p>/);
  assert.doesNotMatch(f.printed, /72\.40/);
  f.render(shownAs(email, "plain"));
  f.choose(() => assert.fail("A changed presentation must fail before choosing a destination"));
  assert.match((await win.invoke("save")).error, /source message or mailbox changed/);
  f.render(shownAs(email, "html"));
  f.choose(() => {
    f.render(shownAs(email, "plain"));
    return { canceled: false, filePath: f.destination };
  });
  assert.match((await win.invoke("save")).error, /source message or mailbox changed/);
  f.render(shownAs(email, "html"));
  f.choose(() => {
    f.changeCache({ ...multipart, bodyEpoch: email.bodyEpoch + 1 });
    return { canceled: false, filePath: f.destination };
  });
  assert.match((await win.invoke("save")).error, /source message or mailbox changed/);
  f.changeCache(multipart);
  f.choose(() => {
    f.changeCache({ ...multipart, htmlBody: "<p>Updated greeting</p>" });
    return { canceled: false, filePath: f.destination };
  });
  assert.match((await win.invoke("save")).error, /source message or mailbox changed/);
  f.changeCache(multipart);
  f.choose(() => {
    f.render(shownAs({ ...email, id: "other" }, "html"));
    return { canceled: false, filePath: f.destination };
  });
  assert.match((await win.invoke("save")).error, /source message or mailbox changed/);
  f.render(shownAs(email, "html"));
  f.choose(() => {
    f.closeReader();
    return { canceled: false, filePath: f.destination };
  });
  await win.invoke("save");
  await finished;
  assert.deepEqual(fs.readdirSync(f.directory), []);
});
