// Deterministic offline transport/UI regressions. No sockets, native UI or mail.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createRequire } = require("node:module");
const { createAttachmentCache, LIMITS } = require("../host/mail/attachment-cache");
const { createAttachmentRequests } = require("../host/mail/attachment-requests");
const tick = () => new Promise(resolve => setImmediate(resolve));
function gate() { let release; const wait = new Promise(resolve => { release = resolve; }); return { wait, release }; }
async function until(fn) { for (let i = 0; i < 80 && !fn(); i++) await tick(); assert(fn(), "synthetic phase must be reached"); }
function cut(src, begin, end) { const a = src.indexOf(begin), b = src.indexOf(end, a + begin.length); assert(a >= 0 && b > a, begin); return src.slice(a, b); }
function load(file, mocks) {
  const filename = path.resolve(__dirname, "..", file), module = { exports: {} }, normal = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module, exports: module.exports,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : normal(name), Buffer, TextDecoder, URL, AbortSignal,
    setTimeout, clearTimeout, console }, { filename }); return module.exports;
}
async function cacheChecks() {
  const cache = createAttachmentCache({ bytes: 8, entryBytes: 6, fileBytes: 12, ttlMs: 15, concurrency: 1, pending: 3 });
  const held = gate(); let loads = 0, aborts = 0;
  const loadBytes = async (entries, signal) => { loads++; signal.addEventListener("abort", () => aborts++); await held.wait; for (const e of entries) e.complete(Buffer.from("hello")); };
  const controller = new AbortController(), a = cache.getMany([{ key: "one" }], { accountId: "a", signal: controller.signal, load: loadBytes });
  const b = cache.getMany([{ key: "one" }], { accountId: "a", load: loadBytes });
  const cancelled = assert.rejects(a); controller.abort(); held.release(); await cancelled;
  const first = await b; assert.equal(first[0].toString(), "hello"); assert.equal(loads, 1); assert.equal(aborts, 0);
  first[0][0] = 0;
  assert.equal((await cache.getMany([{ key: "one" }], { accountId: "a", load: loadBytes }))[0].toString(), "hello", "callers cannot mutate cached bytes");
  cache.invalidateAccount("a"); assert.equal(cache.stats().bytes, 0);
  await cache.getMany([{ key: "two" }], { accountId: "b", load: async es => es[0].complete(Buffer.from("123456")) });
  await cache.getMany([{ key: "three" }], { accountId: "b", load: async es => es[0].complete(Buffer.from("abcdef")) });
  assert.equal(cache.stats().bytes, 6, "LRU byte budget"); assert.equal(cache.stats().entries, 1);
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(cache.stats().bytes, 0, "idle TTL releases bytes");
  let tries = 0;
  const retry = () => cache.getMany([{ key: "retry" }], { accountId: "a", load: async es => { if (++tries === 1) throw Error("synthetic failure"); es[0].complete(Buffer.from("ok")); } });
  await assert.rejects(retry(), /failure/); assert.equal((await retry())[0].toString(), "ok"); assert.equal(tries, 2);
  cache.clear();
  await assert.rejects(cache.getMany([{ key: "budget-a" }, { key: "budget-b" }], { accountId: "a", maxTotalBytes: 5,
    load: async es => { for (const e of es) e.complete(Buffer.from("1234")); } }), /combined/);
  cache.clear();
  await cache.getMany([{ key: "large" }], { accountId: "a", load: async es => es[0].complete(Buffer.alloc(7)) });
  assert.equal(cache.stats().entries, 0, "large complete files are delivered without retention");
  await assert.rejects(cache.getMany([{ key: "oversized" }], { accountId: "a", load: async es => es[0].complete(Buffer.alloc(13)) }), /limit/);
  assert.equal(cache.stats().entries, 0);
  await assert.rejects(cache.getMany([1, 2, 3, 4].map(key => ({ key })), { accountId: "a", load: async () => {} }), /Too many/);
  assert.equal(cache.stats().pending, 0, "admission failure leaves no stranded consumers");
  cache.clear();
}

function fixture(apiTransport = false) {
  const events = [], controls = { held: null, fail: false, cancelSave: false, chunk: Buffer.from("synthetic bytes") };
  let account = { id: "account", created_at: 1, auth_kind: "oauth2", username: "synthetic@fixture.invalid", profile: "gmail",
    imap_tls: 1, imap_port: 993, imap_host: "imap.invalid", mail_transport: apiTransport ? "gmail_api" : "imap", gmail_generation: 100 };
  let row = { id: "message", account_id: "account", folder_path: "INBOX", uid: 8, uid_validity: 100, gmail_id: apiTransport ? "provider-id" : null,
    rfc_message_id: "<synthetic@fixture.invalid>", attachments_json: JSON.stringify([{ id: apiTransport ? "gmail:1" : "2", filename: "file.pdf" }, { id: apiTransport ? "gmail:2" : "3", filename: "second.txt" }]) };
  const db = { accountById: () => account && { ...account }, messageById: id => id === row.id ? { ...row } : null,
    folderByPath: () => ({ uid_validity: 100 }), jsonList: JSON.parse,
    readBlob: () => ({ data: Buffer.from("local bytes"), filename: "local.txt" }),
    gmailAlias: () => ({ provider_id: "provider-id", local_uid: row.uid }) };
  class Imap extends EventEmitter {
    constructor() { super(); this.mailbox = { uidValidity: 100 }; this.streams = []; }
    async connect() { events.push("connect"); }
    async logout() { events.push("logout"); }
    close() { events.push("close"); for (const stream of this.streams) stream.destroy(); }
    async getMailboxLock() { return { release() {} }; }
    async download(uid, part, options) {
      events.push(`part:${part}`); assert.equal(options.maxBytes, LIMITS.fileBytes + 1);
      const stream = new PassThrough(); this.streams.push(stream);
      void (async () => { if (controls.held) await controls.held.wait; if (stream.destroyed) return;
        if (controls.fail) stream.destroy(Error("synthetic transport failure")); else stream.end(controls.chunk); })();
      return { content: stream };
    }
  }
  const parser = { simpleParser: async () => ({}) };
  let gmail = { migrated: () => false };
  if (apiTransport) {
    const apiModule = require("../host/mail/gmail-mail-api");
    const api = apiModule.createGmailMailApi({ accessToken: async () => "synthetic-token", fetchImpl: async (url, opts) => {
      events.push(new URL(url).pathname.includes("/attachments/") ? "attachmentGET" : "messageGET");
      if (controls.held) await new Promise((resolve, reject) => {
        const abort = () => { events.push("httpAbort"); reject(opts.signal.reason); };
        opts.signal.addEventListener("abort", abort, { once: true });
        controls.held.wait.then(() => { opts.signal.removeEventListener("abort", abort); resolve(); });
      });
      opts.signal.throwIfAborted();
      if (controls.fail) throw Error("synthetic HTTP failure");
      return new Response(JSON.stringify(events.at(-1) === "attachmentGET" ? { data: controls.chunk.toString("base64url") }
        : { id: "provider-id", payload: { parts: [{ partId: "1", body: { attachmentId: "a" } }, { partId: "2", body: { attachmentId: "b" } }] } }));
    } });
    const sessions = load("host/mail/gmail-session.js", { mailparser: parser, "./db": db });
    gmail = { ...sessions, createSession: (a, t, opts) => sessions.createSession(a, t, { ...opts,
      api: { getMessage: (...args) => api.getMessage(...args), attachment: (...args) => api.attachment(...args) } }) };
  }
  const remote = load("host/mail/remote.js", { imapflow: { ImapFlow: Imap }, nodemailer: {}, "nodemailer/lib/mail-composer": class {}, mailparser: parser, "./gmail-session": gmail });
  const source = fs.readFileSync(path.join(__dirname, "../host/mail/engine.js"), "utf8");
  const cache = createAttachmentCache(), requests = createAttachmentRequests();
  const context = { Buffer, crypto: require("node:crypto"), path, os: { tmpdir: () => "/synthetic-temp" }, db, remote,
    attachmentCache: cache, attachmentRequests: requests, attachmentTransfers: require("../host/mail/attachment-cache"),
    updateGate: { run: fn => fn() }, actions: { assertIdentityReady() { if (controls.pendingAction) throw Error("message moving"); } },
    pumpBodyFills() {}, secretFor: async () => "synthetic-token", zipBytes: require("../host/mail/zip-bytes"), textEncoding: { repairMojibake: x => x },
    fs: { mkdirSync() {}, writeFileSync() { events.push("write"); } }, require(name) { assert.equal(name, "electron"); return {
      BrowserWindow: { getFocusedWindow() {}, getAllWindows: () => [] },
      dialog: { showSaveDialog: async () => { events.push("dialog"); if (controls.dialog) await controls.dialog.wait; return { canceled: controls.cancelSave, filePath: "/synthetic-file" }; } },
      shell: { openPath: async () => { events.push("open"); return ""; } },
    }; } };
  vm.runInNewContext(`const lanes = new Map(), accountEpochs = new Map(), ACCOUNT_EPOCH = Symbol();\n`
    + cut(source, "function removedAccountError()", "function dataFile()")
    + cut(source, "function laneFor(", "function broadcast(")
    + cut(source, "function invalidateAttachmentAccount(", "async function removeAccount(")
    + cut(source, "function attachmentSelection(", "function signatureText(")
    + "globalThis.host = { invoke: attachmentOperation, bytesFor, invalidateAttachmentAccount, exclusive, mailQueueForTest };", context);
  return { ...context.host, remote, events, controls, cache, requests, db, row, params: { emailId: row.id, attachmentId: apiTransport ? "gmail:1" : "2" },
    remove() { account = null; context.host.invalidateAttachmentAccount("account"); },
    owner() { const owner = new EventEmitter(); owner.send = (channel, value) => owner.emit(channel, value); owner.isDestroyed = () => false; return owner; } };
}
const count = (f, name) => f.events.filter(e => e === name).length;
async function engineChecks(apiTransport) {
  let f = fixture(apiTransport), owner = f.owner(), request = (channel, extra = {}) => f.invoke(channel, { ...f.params, ...extra }, owner);
  for (const channel of ["mail:fetchAttachmentBytes", "mail:openAttachmentExternally", "mail:downloadAttachment"]) assert.equal((await request(channel)).success, true);
  assert.equal(count(f, apiTransport ? "attachmentGET" : "part:2"), 1, "Preview/Open/Save share complete bytes");
  if (apiTransport) assert.equal(count(f, "messageGET"), 1); else assert.equal(count(f, "connect"), 1);
  f.controls.pendingAction = true; assert.equal((await request("mail:fetchAttachmentBytes")).success, false, "warm cache still validates action identity"); f.controls.pendingAction = false;
  f.row.uid++; assert.equal((await request("mail:fetchAttachmentBytes")).success, true);
  assert.equal(count(f, apiTransport ? "attachmentGET" : "part:2"), 2, "changed UID cannot reuse old bytes");
  f.row.attachments_json = JSON.stringify([{ id: "replacement", filename: "other.txt" }]);
  const dialogs = count(f, "dialog"); assert.equal((await request("mail:downloadAttachment")).success, false); assert.equal(count(f, "dialog"), dialogs);
  f.remove(); assert.equal(f.cache.stats().bytes, 0);

  f = fixture(apiTransport); owner = f.owner(); f.controls.cancelSave = true;
  assert.equal((await f.invoke("mail:downloadAttachment", f.params, owner)).error.code, "cancelled");
  assert.equal(count(f, apiTransport ? "messageGET" : "connect"), 0, "cancelled Save never contacts provider");
  f.controls.cancelSave = false; f.controls.held = gate();
  const preview = f.invoke("mail:fetchAttachmentBytes", { ...f.params, requestId: "preview" }, owner);
  await until(() => count(f, apiTransport ? "messageGET" : "part:2") === 1);
  const save = f.invoke("mail:downloadAttachment", { ...f.params, requestId: "save" }, owner);
  await until(() => count(f, "dialog") === 2); await tick();
  assert.equal(f.requests.cancel("preview", f.owner()), false, "another renderer cannot cancel this consumer");
  assert.equal(f.requests.cancel("preview", owner), true); assert.equal((await preview).error.code, "cancelled");
  f.controls.held.release(); assert.equal((await save).success, true);
  assert.equal(count(f, apiTransport ? "attachmentGET" : "part:2"), 1, "cancelled preview retains the Save consumer");
  assert.equal(count(f, apiTransport ? "httpAbort" : "close"), 0);
  assert.equal(f.requests.size(), 0); f.cache.clear();

  f = fixture(apiTransport); owner = f.owner(); f.controls.held = gate();
  const stopped = f.invoke("mail:fetchAttachmentBytes", { ...f.params, requestId: "last" }, owner);
  await until(() => count(f, apiTransport ? "messageGET" : "part:2") === 1);
  f.requests.cancel("last", owner); assert.equal((await stopped).error.code, "cancelled");
  await until(() => count(f, apiTransport ? "httpAbort" : "close") > 0);
  assert.equal(f.cache.stats().entries, 0); f.controls.held.release(); await until(() => f.cache.stats().active === 0);
  f.controls.held = null; f.controls.fail = true;
  assert.equal((await f.invoke("mail:fetchAttachmentBytes", f.params, owner)).success, false);
  f.controls.fail = false; assert.equal((await f.invoke("mail:fetchAttachmentBytes", f.params, owner)).success, true, "failure does not poison retry");
  f.cache.clear();

  f = fixture(apiTransport); owner = f.owner(); f.controls.held = gate();
  const obsolete = f.bytesFor(f.params).then(() => null, e => e);
  await until(() => count(f, apiTransport ? "messageGET" : "part:2") === 1);
  f.invalidateAttachmentAccount("account"); f.controls.held.release(); assert.equal((await obsolete).code, "account_removed");
  await until(() => f.cache.stats().active === 0); assert.equal(f.cache.stats().entries, 0);
  f.controls.held = null; assert.equal((await f.invoke("mail:fetchAttachmentBytes", f.params, owner)).success, true);
  f.cache.clear();
  console.log(`attachment-engine-ok (${apiTransport ? "Gmail API" : "IMAP"}: shared reads, identity, Save ordering, cancellation, reconnect, retry)`);
}
async function extraChecks() {
  const f = fixture(), owner = f.owner(), held = gate();
  const active = f.exclusive("account", () => held.wait, { background: true }); await tick();
  const pending = f.invoke("mail:fetchAttachmentBytes", { ...f.params, requestId: "queued" }, owner);
  await until(() => f.mailQueueForTest("account").user > 0); f.requests.cancel("queued", owner);
  assert.equal((await pending).error.code, "cancelled"); held.release(); await active;
  await until(() => f.cache.stats().active === 0); assert.equal(count(f, "connect"), 0, "cancelled queue does not start a connection");
  f.row.attachments_json = JSON.stringify([{ id: "local", storageUrl: "local:synthetic" }]);
  assert.equal((await f.bytesFor({ emailId: "message", attachmentId: "local" })).data.toString(), "local bytes"); assert.equal(count(f, "connect"), 0);
  f.row.attachments_json = JSON.stringify([{ id: "huge", size: LIMITS.fileBytes + 1 }]);
  await assert.rejects(f.bytesFor({ emailId: "message", attachmentId: "huge" }), /limit/); assert.equal(count(f, "connect"), 0);
  f.cache.clear();
  const transport = fixture();
  const stream = new PassThrough(); stream.end(Buffer.from("123456"));
  const client = { mailbox: { uidValidity: 100 }, getMailboxLock: async () => ({ release() {} }),
    download: async (_uid, _part, opts) => { assert.equal(opts.maxBytes, 5); return { content: stream }; } };
  await assert.rejects(transport.remote.readPart(client, "INBOX", 8, "2", 100, { maxBytes: 4 }), /limit/);
  assert(stream.destroyed, "oversize stream is closed, not silently truncated");
  const disappearing = fixture(), window = disappearing.owner(); disappearing.controls.held = gate();
  const closed = disappearing.invoke("mail:fetchAttachmentBytes", { ...disappearing.params, requestId: "closed" }, window);
  await until(() => count(disappearing, "part:2") === 1); window.emit("destroyed");
  assert.equal((await closed).error.code, "cancelled"); disappearing.controls.held.release();
  await until(() => disappearing.cache.stats().active === 0); assert.equal(disappearing.requests.size(), 0);
}

async function uiChecks() {
  const { renderer } = require("./check-ux-workflows");
  class Node {
    constructor() { this.childNodes = []; this.dataset = {}; this.classList = { remove() {}, toggle() {} }; }
    replaceChildren(...nodes) { this.childNodes = nodes; } append(...nodes) { this.childNodes.push(...nodes); }
    appendChild(node) { this.append(node); } setAttribute() {} removeAttribute() {} addEventListener(name, fn) { this[name] = fn; }
    focus() {}
  }
  const activity = new Node(); activity.dataset.attachmentTasks = "all";
  const nodes = new Map(), node = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const jobs = new Map(), listeners = new Set(), calls = [];
  const api = { on(_channel, fn) { listeners.add(fn); return () => listeners.delete(fn); }, invoke(channel, params) {
    calls.push({ channel, params });
    if (channel === "mail:cancelAttachmentRequest") { jobs.get(params.requestId)?.release({ success: false, error: { message: "cancelled" } }); return Promise.resolve({ success: true, data: true }); }
    const held = gate(); jobs.set(params.requestId, held); return held.wait;
  } };
  const ui = renderer({ crypto: require("node:crypto").webcrypto, AbortController, Uint8Array, ArrayBuffer,
    document: { getElementById: node, querySelectorAll: () => [activity], createElement: () => new Node() }, window: { morrow: api } });
  ui.run(`showStatus=()=>{}; showAttachmentPreviewShell=()=>{document.getElementById('attachment-preview').open=true;};
    clearPdfPreviewPages=()=>{}; revokeAttachmentPreviewUrl=()=>{};
    globalThis.email={id:'message'}, file={id:'2',filename:'synthetic.pdf',mimeType:'application/pdf'};`);
  const a = ui.run(`startAttachmentTask('mail:downloadAttachment', email, [file], 'Save')`);
  const b = ui.run(`startAttachmentTask('mail:downloadAttachment', email, [file], 'Save')`);
  assert.equal(a, b); assert.equal(calls.length, 1, "repeated Save opens one request/dialog");
  for (const fn of listeners) fn({ requestId: a.requestId, phase: "downloading", loaded: 2048 });
  assert.match(activity.childNodes[0].childNodes[0].textContent, /2 KiB received/);
  assert.equal(ui.run("state.busy"), false, "attachment requests do not hold global busy state");
  const preview = ui.run(`previewAttachment(email,file)`); await tick();
  const samePreview = ui.run(`previewAttachment(email,file)`); await samePreview;
  assert.equal(calls.filter(c => c.channel === "mail:fetchAttachmentBytes").length, 1);
  ui.run("clearAttachmentPreview()"); await preview;
  assert.equal(calls.filter(c => c.channel === "mail:cancelAttachmentRequest").length, 1);
  assert.equal(a.done, false, "closing preview does not cancel Save");
  const retry = ui.run(`previewAttachment(email,file)`); await tick();
  const attempt = calls.filter(c => c.channel === "mail:fetchAttachmentBytes").at(-1);
  jobs.get(attempt.params.requestId).release({ success: false, error: { message: "synthetic preview error" } });
  await assert.rejects(retry, /synthetic/);
  const retryAgain = ui.run(`previewAttachment(email,file)`); await tick();
  assert.equal(calls.filter(c => c.channel === "mail:fetchAttachmentBytes").length, 3, "failed preview can retry without closing the dialog");
  ui.run("clearAttachmentPreview()"); await retryAgain;
  jobs.get(a.requestId).release({ success: true, data: { path: "/synthetic" } }); await a.promise;
  assert.equal(activity.childNodes.length, 0); assert.equal(listeners.size, 0);
  assert.equal(ui.run("attachmentTasks.size"), 0);
  console.log("attachment-ui-ok (real renderer functions, synthetic DOM: repeated actions, progress, preview close, independent Save)");
}
async function run() {
  await cacheChecks(); await engineChecks(false); await engineChecks(true); await extraChecks(); await uiChecks();
  console.log("attachment-transfers-ok (bounded cache/TTL/LRU, real provider/handler source, offline only)");
}
module.exports = { run };
if (require.main === module) {
  const watchdog = setTimeout(() => { console.error("attachment fixture exceeded 15s"); process.exit(1); }, 15000);
  run().then(() => clearTimeout(watchdog), error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });
}
