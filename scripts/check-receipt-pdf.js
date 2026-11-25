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

test("keeps headings, ordered table cells, spans, money, and final text in inert markup", () => {
  const html = receiptHtml({ ...email, htmlBody: `<head><style>sender CSS</style></head><h2>Item &amp; tax</h2>
    <table><tr><th rowspan="2" colspan="3" onclick="bad()">HK$1,234.50</th><td>USD 9.99</td></tr>
    <tr><td><a href="https://example.test/">Total</a></td></tr></table>
    <img src="cid:private" alt="Only decoration"><svg><text>vector text</text></svg>
    <span style="display:none">Hidden preheader</span><script>sender script</script><p>First<br>Final &lt;line&gt;</p>` });
  assert.match(receiptHtml({ ...email, date: "2026-11-25T09:00:00" }), /09:00:00 \(time zone unavailable\)/);
  assert.match(html, /Dues &lt;November&gt;[\s\S]*invoices@example\.test[\s\S]*2026-11-25 19:23:55 UTC\+08:00/);
  assert.match(html, /<h2>Item &amp; tax<\/h2>[\s\S]*<th colspan="3" rowspan="2">HK\$1,234\.50<\/th><td>USD 9\.99<\/td>[\s\S]*<td>Total<\/td>[\s\S]*First<br>Final &lt;line&gt;/);
  assert.doesNotMatch(html, /Hidden preheader|sender CSS|sender script|onclick=|example\.test\/|cid:private|vector text|<img/);
  assert.match(receiptHtml({ ...email, date: "2026-11-25T11:23:55.000Z" }), /11:23:55\.000 UTC[\s\S]*USD 1,234\.50\n\nLast line/);
});

test("rejects incomplete, warning, image-only, snippet-only and oversized bodies", () => {
  for (const patch of [
    { bodyComplete: false }, { encodingWarning: "Unreadable" }, { bodyWarning: "Partial" },
    { htmlBody: '<img alt="USD 5.00">', textBody: "USD 5.00" },
    { textBody: null, snippet: "USD 5.00" }, { textBody: "x".repeat(512 * 1024 + 1) },
    { htmlBody: "<pre>" + "x\n".repeat(3001) + "</pre>" },
  ]) assert.throws(() => receiptHtml({ ...email, ...patch }));
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
  const frame = { url, processId: 2, routingId: 3, executeJavaScript: async () => email };
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
  assert.equal((await source.renderedIdentity()).id, email.id);
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
  let shown = email;
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
        printToPDF: async () => pdf,
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
    changeCache(next) { cached = next; },
    render(next) { shown = next; },
    closeReader() { readerClosed = true; controller.abort(); },
    choose(fn) { pick = fn; },
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
  const { win, bytes, finished } = await f.preview();
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

test("destination selection cannot commit after reconnect, message change, or Reader closure", { timeout: 4000 }, async t => {
  const f = fixture(t);
  const { win, finished } = await f.preview();
  f.choose(() => {
    f.changeCache({ ...email, bodyEpoch: email.bodyEpoch + 1 });
    return { canceled: false, filePath: f.destination };
  });
  assert.match((await win.invoke("save")).error, /source message or mailbox changed/);
  f.changeCache(email);
  f.choose(() => {
    f.render({ ...email, id: "other" });
    return { canceled: false, filePath: f.destination };
  });
  assert.match((await win.invoke("save")).error, /source message or mailbox changed/);
  f.render(email);
  f.choose(() => {
    f.closeReader();
    return { canceled: false, filePath: f.destination };
  });
  await win.invoke("save");
  await finished;
  assert.deepEqual(fs.readdirSync(f.directory), []);
});
