// Synthetic messages, temporary databases and fake providers only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const { Readable, Duplex } = require("node:stream");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const L = require("../host/mail/local-folders");
const remote = require("../host/mail/remote");

const SOURCE = { accountEmail: "owner@fixture.invalid", folderId: "INBOX", unread: true, isStarred: true };
async function mime() {
  return remote.buildRaw({ from: { name: "Synthetic 中文", address: "sender@fixture.invalid" }, to: ["owner@fixture.invalid"],
    cc: ["copy@fixture.invalid"], bcc: ["blind@fixture.invalid"], replyTo: "reply@fixture.invalid", keepBcc: true,
    subject: "Durable 中文 archive", date: new Date("2026-10-01T12:34:56Z"), messageId: "<archive@fixture.invalid>",
    inReplyTo: "<parent@fixture.invalid>", headers: { "X-Archive-Evidence": "kept verbatim" },
    text: "Complete plain text, including 中文.", html: '<p>Complete HTML 中文.</p><img src="cid:picture@fixture.invalid">',
    attachments: [{ filename: "bytes.bin", content: Buffer.from([0, 255, 13, 10, 42]) },
      { filename: "inline.png", cid: "picture@fixture.invalid", content: Buffer.from("synthetic raster"), contentType: "image/png" }] });
}
function fixture(t, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-local-folders-")), file = path.join(dir, "local-folders.sqlite");
  let store = L.createLocalStore(file, options);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, get store() { return store; }, reopen() { store.close(); store = L.createLocalStore(file); return store; } };
}
const transfer = (store, raw, extra = {}) => L.transferToLocal({ store, sourceKey: "source-identity", destination: L.ARCHIVE_ID,
  source: SOURCE, download: async () => raw, assertCurrent() {}, trash: async () => assert.fail("Unexpected server write"), ...extra });

test("complete MIME, headers, recipients, dates, inline and file bytes survive close/reopen with independent ownership", async t => {
  const f = fixture(t), raw = await mime();
  const saved = await transfer(f.store, raw), email = f.store.verify(saved.localId);
  assert.equal(email.subject, "Durable 中文 archive"); assert.equal(email.date, "2026-10-01T12:34:56.000Z");
  assert.deepEqual(email.to, [SOURCE.accountEmail]); assert.deepEqual(email.cc, ["copy@fixture.invalid"]); assert.deepEqual(email.bcc, ["blind@fixture.invalid"]);
  assert.equal(email.replyTo[0].address, "reply@fixture.invalid"); assert.equal(email.inReplyTo, "<parent@fixture.invalid>");
  assert.match(email.textBody, /Complete plain text, including 中文/); assert.match(email.htmlBody, /data:image\/png;base64/);
  assert.equal(email.attachments.length, 2); assert.equal(email.isLocal, true); assert.equal(email.isDraft, false);
  assert.equal(f.store.message(email.id, false).htmlBody, undefined, "paged headers omit bodies");
  assert.equal(f.store.list({ folderId: L.ARCHIVE_ID, filterToMe: true }).total, 1);
  f.reopen(); assert.deepEqual(f.store.raw(email.id), raw);
  assert.match(f.store.raw(email.id).toString(), /X-Archive-Evidence: kept verbatim/);
  const file = email.attachments.find(part => part.filename === "bytes.bin");
  assert.deepEqual(f.store.attachment(email.id, file.id), Buffer.from([0, 255, 13, 10, 42]));
  assert.equal(f.store.attachment(email.id, email.attachments.find(part => part.contentId).id).toString(), "synthetic raster");
  assert.equal(f.store.account().id, L.ACCOUNT_ID);
});

test("folder management preserves stable identities, rejects duplicate names, system changes and nonempty deletes", t => {
  const f = fixture(t), create = (name, parentId) => f.store.manageFolder({ action: "create", name, parentId }).id;
  const parent = create("Projects"), child = create("2026", parent);
  assert.throws(() => create("PROJECTS"), /UNIQUE/); assert.throws(() => create("Bad/Name"), /without slashes/);
  assert.throws(() => f.store.manageFolder({ action: "delete", folderId: parent }), /subfolders/);
  f.store.manageFolder({ action: "rename", folderId: parent, name: "Renamed" });
  assert.equal(f.store.folder(child).parent_id, parent); assert.equal(f.store.folder(parent).name, "Renamed");
  assert.throws(() => f.store.manageFolder({ action: "delete", folderId: L.ARCHIVE_ID }), /permanent/);
  f.store.manageFolder({ action: "delete", folderId: child }); f.store.manageFolder({ action: "delete", folderId: parent });
  assert.equal(f.reopen().folders().length, 2);
});

test("local reading preserves current MIME decoding warnings and original bytes, including a checked plain-text alternative", async t => {
  const f = fixture(t);
  const raw = Buffer.concat([Buffer.from('From: sender@fixture.invalid\r\nTo: owner@fixture.invalid\r\nSubject: Original encoding\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="alt"\r\n\r\n--alt\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nReadable plain text\r\n--alt\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'),
    Buffer.from(Buffer.from([60, 112, 62, 255, 60, 47, 112, 62]).toString('base64')), Buffer.from('\r\n--alt--\r\n')]);
  const saved = await transfer(f.store, raw), email = f.store.verify(saved.localId);
  assert.match(email.encodingWarning, /could not be decoded/); assert.match(email.encodingWarning, /Original bytes are retained in Save EML/);
  assert.match(email.textBody, /Readable plain text/); assert.equal(email.htmlBody, null);
  assert.deepEqual(f.reopen().raw(saved.localId), raw);
});

test("incomplete and damaged archive schemas fail open without resetting saved files", t => {
  const f = fixture(t), broken = path.join(f.dir, "broken.sqlite"), empty = path.join(f.dir, "empty.sqlite");
  fs.writeFileSync(empty, Buffer.alloc(0)); assert.throws(() => L.createLocalStore(empty), /incomplete/); assert.equal(fs.statSync(empty).size, 0);
  const native = new Database(broken); native.pragma("user_version=1"); native.exec("CREATE TABLE retained(value TEXT)"); native.prepare("INSERT INTO retained VALUES(?)").run("synthetic retained evidence"); native.close();
  assert.throws(() => L.createLocalStore(broken), /schema is incomplete/);
  const reader = new Database(broken, { readonly: true }); assert.equal(reader.prepare("SELECT value FROM retained").get().value, "synthetic retained evidence"); reader.close();
});

test("local flags, copy, move, Trash and restore work without a provider; receipts prevent duplicate archives", async t => {
  const f = fixture(t), raw = await mime(), saved = await transfer(f.store, raw);
  const original = saved.localId;
  const duplicate = await transfer(f.store, raw, { download: async () => assert.fail("Repeated copy must reuse its verified bytes") });
  assert.equal(duplicate.localId, original); assert.equal(f.store.list({ folderId: L.ARCHIVE_ID }).total, 1);
  const folderId = f.store.manageFolder({ action: "create", name: "Project" }).id;
  const second = f.store.copy(original, folderId).message_id;
  assert.notEqual(second, original); assert.deepEqual(f.store.raw(second), f.store.raw(original));
  f.store.update(original, { isRead: true, isStarred: false, folderId: L.TRASH_ID });
  assert.equal(f.store.message(original).isRead, true); assert.equal(f.store.message(original).isStarred, false);
  assert.equal(f.store.list({ folderId: L.TRASH_ID }).total, 1);
  assert.throws(() => f.store.manageFolder({ action: "delete", folderId }), /Move all messages/);
  f.reopen().update(original, { folderId }); assert.equal(f.store.list({ folderId }).total, 2);
  assert.equal(f.store.search({ query: "Complete plain text" }).length, 2);
});

test("server Trash only runs after an independently reopened connection verifies the committed raw and attachments", async t => {
  const f = fixture(t), raw = await mime(); let trashes = 0;
  const trash = async () => {
    trashes++;
    const reader = L.createLocalStore(f.file);
    try {
      const saved = reader.receipt("source-identity", L.ARCHIVE_ID);
      assert.equal(saved.status, "remote_unknown", "intent commits before the provider request");
      const email = reader.verify(saved.message_id); assert.equal(email.attachments.length, 2);
      assert.deepEqual(reader.raw(email.id), raw);
    } finally { reader.close(); }
  };
  const saved = await transfer(f.store, raw, { move: true, trash });
  assert.equal(saved.status, "moved");
  await transfer(f.reopen(), raw, { move: true, trash }); assert.equal(trashes, 1);
});

test("definite refusal keeps the copy and allows an explicit retry; unconfirmed writes survive restart without replay", async t => {
  const f = fixture(t), raw = await mime(); let writes = 0;
  const refused = await transfer(f.store, raw, { move: true, trash: async () => { writes++; throw Object.assign(new Error("Denied before submission"), { operationIssued: false }); } });
  assert.equal(refused.status, "remote_failed"); assert.deepEqual(f.store.raw(refused.localId), raw);
  const unknown = await transfer(f.store, raw, { move: true, download: async () => assert.fail("No redownload"), trash: async () => { writes++; throw new Error("Reply lost after MOVE"); } });
  assert.equal(unknown.status, "remote_unknown");
  const repeated = await transfer(f.reopen(), raw, { move: true, trash: async () => assert.fail("Unknown writes cannot replay") });
  assert.equal(repeated.localId, refused.localId); assert.equal(repeated.status, "remote_unknown"); assert.equal(writes, 2);
  const other = f.store.manageFolder({ action: "create", name: "Another destination" }).id;
  const elsewhere = await transfer(f.store, raw, { destination: other, move: true, download: async () => assert.fail("Reuse owned raw bytes"), trash: async () => assert.fail("Changing destination cannot replay an uncertain move") });
  assert.equal(elsewhere.status, "remote_unknown"); assert.deepEqual(f.store.raw(elsewhere.localId), raw);
});

test("offline/incomplete downloads and source replacement create no archive and never reach server Trash", async t => {
  const f = fixture(t), raw = await mime(); let checks = 0;
  await assert.rejects(() => transfer(f.store, raw, { move: true, download: async () => { throw new Error("Synthetic offline"); } }), /offline/);
  await assert.rejects(() => transfer(f.store, raw, { move: true, assertCurrent() { if (++checks > 1) throw new Error("UIDVALIDITY or account changed"); } }), /changed/);
  await assert.rejects(() => transfer(f.store, Buffer.alloc(0), { move: true }), /complete message/);
  assert.equal(f.store.list({ folderId: L.ARCHIVE_ID }).total, 0);
});

test("receipt-write failure blocks submission, and post-Trash identity/storage failures keep an uncertain durable receipt", async t => {
  const f = fixture(t), raw = await mime();
  await transfer(f.store, raw);
  const set = f.store.setReceipt;
  f.store.setReceipt = () => { throw new Error("Synthetic receipt fsync failure"); };
  const blocked = await transfer(f.store, raw, { move: true }); assert.equal(blocked.status, "remote_failed");
  assert.match(blocked.detail, /No server move was submitted/); assert.equal(f.store.receipt("source-identity", L.ARCHIVE_ID).status, "copied");
  f.store.setReceipt = (...args) => { if (args[2] === "remote_unknown") return set(...args); throw new Error("Synthetic acknowledgement storage failure"); };
  const unrecorded = await transfer(f.store, raw, { move: true, trash: async () => {} });
  assert.equal(unrecorded.status, "remote_unknown"); assert.equal(f.store.receipt("source-identity", L.ARCHIVE_ID).status, "remote_unknown");
  f.store.setReceipt = set;
  await transfer(f.store, raw, { sourceKey: "different-source" });
  let done = false;
  const changed = await transfer(f.store, raw, { sourceKey: "different-source", move: true, assertCurrent() {
    if (done) throw Object.assign(new Error("Account removed after submission"), { operationIssued: false });
  }, trash: async () => { done = true; } });
  assert.equal(changed.status, "remote_unknown");
});

test("real SQLITE_FULL rolls back the complete copy before any provider write", async t => {
  let native;
  const f = fixture(t, { database: class { constructor(file) { native = new Database(file); return native; } } });
  native.pragma(`max_page_count = ${native.pragma("page_count", { simple: true })}`);
  const raw = Buffer.from("From: sender@fixture.invalid\r\nTo: owner@fixture.invalid\r\nSubject: Full disk\r\n\r\n" + "x".repeat(1024 * 1024));
  await assert.rejects(() => transfer(f.store, raw, { move: true }), error => error.code === "SQLITE_FULL");
  assert.equal(f.store.list({ folderId: L.ARCHIVE_ID }).total, 0);
  assert.equal(f.store.receipt("source-identity", L.ARCHIVE_ID), undefined);
});

test("corrupt raw or attachment bytes fail verification and block remote cleanup", async t => {
  const f = fixture(t), raw = await mime(), saved = await transfer(f.store, raw);
  const other = new Database(f.file);
  other.prepare("UPDATE attachments SET data=? WHERE message_id=?").run(Buffer.from("corrupt"), saved.localId); other.close();
  await assert.rejects(() => transfer(f.store, raw, { move: true }), /attachment verification failed/);
  assert.equal(f.store.receipt("source-identity", L.ARCHIVE_ID).status, "copied");
  assert.deepEqual(f.store.raw(saved.localId), raw, "independently verified original MIME remains exportable for recovery");
});

test("abrupt process exit during Trash retains an uncertain receipt and all bytes without replay", async t => {
  const f = fixture(t), raw = await mime(), rawPath = path.join(f.dir, "synthetic.eml"); fs.writeFileSync(rawPath, raw);
  const child = spawnSync(process.execPath, ["-e", `
    const L=require(${JSON.stringify(require.resolve("../host/mail/local-folders"))});
    const s=L.createLocalStore(process.argv[1]);
    L.transferToLocal({store:s,destination:L.ARCHIVE_ID,sourceKey:'crashed',source:{},assertCurrent(){},
      download:async()=>require('fs').readFileSync(process.argv[2]),move:true,trash:async()=>process.exit(0)}).catch(()=>process.exit(2));
  `, f.file, rawPath], { timeout: 30000, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const receipt = f.store.receipt("crashed", L.ARCHIVE_ID); assert.equal(receipt.status, "remote_unknown");
  assert.deepEqual(f.store.raw(receipt.message_id), raw);
  const result = await transfer(f.reopen(), raw, { sourceKey: "crashed", move: true }); assert.equal(result.status, "remote_unknown");
});

function imap(raw, options = {}) {
  let locks = 0, downloads = 0;
  return { capabilities: new Set(options.noMove ? [] : ["MOVE"]), mailbox: { uidValidity: options.validity || 100 },
    async getMailboxLock() { locks++; return { release() { locks--; } }; },
    async *fetch(_uid, query) { assert.equal(query.size, true); yield { uid: 999, size: 1 }; yield { uid: 7, flags: new Set() }; yield { uid: 7, size: options.size ?? raw.length }; },
    async download(uid, part, query) { assert.equal(uid, "7"); assert.equal(part, undefined); assert.equal(query.uid, true); downloads++; return { content: Readable.from([raw.subarray(0, 10), raw.subarray(10)]) }; },
    async messageMove(uid, destination, query) { assert.equal(uid, "7"); assert.equal(destination, "Trash"); assert.equal(query.uid, true); return { uidMap: new Map([[7, 77]]), uidValidity: 101 }; },
    stats: () => ({ locks, downloads }) };
}
const ROW = { id: "source", folder_path: "INBOX", uid: 7, uid_validity: 100 };
test("actual IMAP raw-reader matches UID, checks UIDVALIDITY and exact size, bounds streams and releases locks", async () => {
  const raw = await mime(), client = imap(raw);
  assert.deepEqual(await remote.fetchArchiveSource(client, ROW), raw); assert.equal(client.stats().locks, 0);
  for (const options of [{ size: raw.length + 1 }, { size: raw.length - 1 }, { size: 0 }, { validity: 200 }]) {
    const broken = imap(raw, options);
    await assert.rejects(() => remote.fetchArchiveSource(broken, ROW)); assert.equal(broken.stats().locks, 0);
  }
  const limited = imap(raw); await assert.rejects(() => remote.fetchArchiveSource(limited, ROW, { maxBytes: 10 }), /size/);
  assert.equal(limited.stats().downloads, 0);
});

test("Gmail raw-reader uses resolved provider identity and refuses unrelated or oversized raw payloads", async () => {
  const raw = await mime(); let provider;
  const gmail = { resolve: async (...args) => { assert.equal(args[3], ROW.id); return { provider_id: "canonical-id" }; },
    alive() {}, api: { raw: async id => { provider = id; return { id, source: raw }; } } };
  assert.deepEqual(await remote.fetchArchiveSource({ gmail }, ROW), raw); assert.equal(provider, "canonical-id");
  gmail.api.raw = async () => ({ id: "wrong-id", source: raw });
  await assert.rejects(() => remote.fetchArchiveSource({ gmail }, ROW), /complete message/);
  gmail.api.raw = async id => ({ id, source: raw });
  await assert.rejects(() => remote.fetchArchiveSource({ gmail }, ROW, { maxBytes: 10 }), /complete message/);
});

test("real ImapFlow over synthetic Duplex preserves original MIME and issues UID MOVE without expunge", { timeout: 10000 }, async t => {
  const raw = await mime(), commands = [];
  class Socket extends Duplex {
    constructor() { super(); this.authorized = true; this.input = ""; }
    _read() {}
    setKeepAlive() { return this; }
    setTimeout() { return this; }
    getCipher() { return { name: "SYNTHETIC", version: "fixture" }; }
    reply(value) { setImmediate(() => { if (!this.destroyed) this.push(value); }); }
    _write(bytes, _encoding, callback) {
      this.input += bytes.toString();
      let end;
      while ((end = this.input.indexOf("\r\n")) >= 0) {
        const line = this.input.slice(0, end); this.input = this.input.slice(end + 2); commands.push(line);
        const [, tag, command] = /^(\S+)\s+(.+)$/.exec(line) || [];
        if (/^CAPABILITY/.test(command)) this.reply(`* CAPABILITY IMAP4rev1 UIDPLUS MOVE\r\n${tag} OK CAPABILITY\r\n`);
        else if (/^LIST/.test(command)) this.reply(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK LIST\r\n`);
        else if (/^LSUB/.test(command)) this.reply(`${tag} OK LSUB\r\n`);
        else if (/^SELECT/.test(command)) this.reply(`* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 100] generation\r\n* OK [UIDNEXT 8] next\r\n${tag} OK [READ-WRITE] SELECT\r\n`);
        else if (/^UID FETCH/.test(command)) {
          if (/BODY\.PEEK\[\]/.test(command)) {
            const range = /<([0-9]+)\.([0-9]+)>/.exec(command);
            const start = Number(range?.[1] || 0), size = Number(range?.[2] || raw.length), part = raw.subarray(start, start + size);
            this.reply(Buffer.concat([Buffer.from(`* 1 FETCH (UID 7 RFC822.SIZE ${raw.length} BODY[]<${start}> {${part.length}}\r\n`), part, Buffer.from(`)\r\n${tag} OK FETCH\r\n`)]));
          } else this.reply(`* 2 FETCH (UID 999 RFC822.SIZE 1)\r\n* 1 FETCH (UID 7 RFC822.SIZE ${raw.length})\r\n${tag} OK FETCH\r\n`);
        } else if (/^UID MOVE/.test(command)) this.reply(`${tag} OK [COPYUID 101 7 77] moved\r\n`);
        else if (/^LOGOUT/.test(command)) this.reply(`* BYE fixture logout\r\n${tag} OK LOGOUT\r\n`);
        else this.reply(`${tag} BAD unexpected synthetic command\r\n`);
      }
      callback();
    }
  }
  const { ImapFlow } = require("imapflow");
  const client = new ImapFlow({ host: "imap.fixture.invalid", port: 993, secure: true, logger: false, disableAutoIdle: true,
    auth: { user: "owner@fixture.invalid", pass: "synthetic-only" }, transport: { connect(_options, ready) {
      const socket = new Socket(); setImmediate(() => { ready(); socket.reply("* PREAUTH synthetic local archive fixture\r\n"); }); return socket;
    } } });
  client.on("error", () => {}); t.after(() => client.close());
  await client.connect();
  assert.deepEqual(await remote.fetchArchiveSource(client, ROW), raw);
  const moved = await remote.moveUid(client, "INBOX", 7, "Trash", 100, ROW.id);
  assert.deepEqual(moved, { uid: 77, uidValidity: 101 });
  assert(commands.some(command => /UID FETCH.*BODY\.PEEK\[\]/.test(command)));
  assert(commands.some(command => /UID MOVE 7/.test(command))); assert(!commands.some(command => /EXPUNGE|\\Deleted|UID COPY/.test(command)));
  await client.logout();
});

test("host/preload use local ownership after account removal; no credentials or provider calls for offline reads and files", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-local-engine-")), previous = { ...process.env };
  const env = { MORROW_MAIL_DIR: dir, MORROW_USER_DATA: dir, MORROW_MAIL_SECRETS: "memory" }; Object.assign(process.env, env);
  const engine = require("../host/mail/engine"), db = require("../host/mail/db"), secrets = require("../host/mail/secrets");
  const originalClient = remote.withClient, originalRead = secrets.getPasswordAsync;
  let credentialReads = 0, providerCalls = 0; const raw = await mime();
  secrets.getPasswordAsync = (...args) => { credentialReads++; return originalRead(...args); };
  let client = imap(raw), moves = 0;
  const move = client.messageMove; client.messageMove = async (...args) => { moves++; return move(...args); };
  remote.withClient = async (_account, _secret, work) => { providerCalls++; return work(client); };
  t.after(async () => {
    remote.withClient = originalClient; secrets.getPasswordAsync = originalRead; engine.closeLocalArchiveForTest(); await db.close();
    for (const key of Object.keys(env)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await engine.init();
  db.insertAccount({ id: "remote", email: SOURCE.accountEmail, username: SOURCE.accountEmail, profile: "custom", createdAt: 1,
    imapHost: "imap.fixture.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.fixture.invalid", smtpPort: 587, smtpTls: true });
  secrets.setPassword("remote", "synthetic-only");
  db.replaceFolders("remote", [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }, { path: "Trash", name: "Trash", wellKnown: "deleteditems" }]);
  db.insertMessage({ id: ROW.id, accountId: "remote", folderPath: "INBOX", uid: 7, uidValidity: 100, threadId: "source-thread", subject: "A cached header",
    date: "2026-10-01T12:34:56Z", listSortTs: 1, unread: true, rfcMessageId: "<archive@fixture.invalid>", bodyComplete: false });
  let preload;
  vm.runInNewContext(fs.readFileSync(require.resolve("../renderer/preload"), "utf8"), {
    require: name => { assert.equal(name, "electron"); return { contextBridge: { exposeInMainWorld(_name, api) { preload = api; } },
      ipcRenderer: { invoke: (channel, params) => engine.answer(channel, [params]), on() {} } }; },
  });
  const saved = await preload.invoke("mail:transferToLocal", { emailId: ROW.id, accountId: "remote", folderId: L.ARCHIVE_ID, mode: "copy" });
  assert.equal(saved.success, true, JSON.stringify(saved)); assert.equal(saved.data.status, "copied");
  assert.equal(moves, 0); assert.equal(db.messageById(ROW.id).folder_path, "INBOX");
  const localId = saved.data.localId;
  const wrong = await preload.invoke("mail:openEmail", { emailId: localId, accountId: "remote" }); assert.equal(wrong.success, false);
  assert.equal((await engine.answer("mail:removeAccount", [{ accountId: "remote" }])).success, true);
  const before = [credentialReads, providerCalls];
  engine.closeLocalArchiveForTest();
  const local = await preload.invoke("mail:localFolders"); assert.equal(local.data.isLocal, true);
  assert.equal(engine.answer("mail:listAccounts", []).data.length, 0, "local identity never becomes an authenticated account");
  const opened = await preload.invoke("mail:openEmail", { emailId: localId, accountId: L.ACCOUNT_ID });
  assert.equal(opened.success, true); assert.match(opened.data.email.textBody, /Complete plain text/);
  const file = opened.data.email.attachments.find(part => part.filename === "bytes.bin");
  const bytes = await preload.invoke("mail:fetchAttachmentBytes", { emailId: localId, accountId: L.ACCOUNT_ID, attachmentId: file.id, requestId: "local-test" });
  assert.equal(bytes.success, true, JSON.stringify(bytes)); assert.deepEqual(bytes.data, Buffer.from([0, 255, 13, 10, 42]));
  assert.equal((await preload.invoke("mail:markRead", { emailId: localId, accountId: L.ACCOUNT_ID, isRead: true })).success, true);
  assert.equal((await preload.invoke("mail:toggleStar", { emailId: localId, accountId: L.ACCOUNT_ID, isStarred: true })).success, true);
  assert.equal((await preload.invoke("mail:listFromCache", { accountId: L.ACCOUNT_ID, folderId: L.ARCHIVE_ID })).data.emails[0].isStarred, true);
  assert.equal((await preload.invoke("mail:listProviderFolders", { accountId: L.ACCOUNT_ID })).success, false);
  const Module = require("node:module"), load = Module._load, exportedPath = path.join(dir, "synthetic-export.eml"); let cancel = false;
  Module._load = function (name, ...args) {
    if (name === "electron") return { BrowserWindow: {}, dialog: { showSaveDialog: async () => ({ canceled: cancel, filePath: exportedPath }) } };
    return load.call(this, name, ...args);
  };
  try {
    assert.equal((await preload.invoke("mail:exportLocalMessage", { accountId: L.ACCOUNT_ID, emailId: localId })).data.saved, true);
    assert.deepEqual(fs.readFileSync(exportedPath), raw);
    cancel = true;
    assert.equal((await preload.invoke("mail:exportLocalMessage", { accountId: L.ACCOUNT_ID, emailId: localId })).data.cancelled, true);
  } finally { Module._load = load; }
  assert.deepEqual([credentialReads, providerCalls], before, "local operations must never obtain credentials or open a provider connection");
  await assert.rejects(() => preload.invoke("mail:notARealLocalChannel", {}), /Unsupported channel/);
});

test("engine guards actual Trash/MOVE submission, unsupported IMAP, lost replies, changing identities and Gmail label duplicates", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-local-moves-")), previous = { ...process.env };
  const env = { MORROW_MAIL_DIR: dir, MORROW_USER_DATA: dir, MORROW_MAIL_SECRETS: "memory" }; Object.assign(process.env, env);
  const engine = require("../host/mail/engine"), db = require("../host/mail/db"), secrets = require("../host/mail/secrets");
  const oldClient = remote.withClient, oldList = remote.listFolderRecords;
  const raw = await mime(); let current = imap(raw), writes = 0, downloads = 0;
  remote.withClient = async (_account, _secret, work) => work(current);
  remote.listFolderRecords = async () => { throw new Error("Synthetic background sync disabled"); };
  t.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    remote.withClient = oldClient; remote.listFolderRecords = oldList; engine.closeLocalArchiveForTest(); await db.close();
    for (const key of Object.keys(env)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await engine.init();
  db.insertAccount({ id: "moves", email: SOURCE.accountEmail, username: SOURCE.accountEmail, profile: "custom", createdAt: 1,
    imapHost: "imap.fixture.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.fixture.invalid", smtpPort: 587, smtpTls: true });
  secrets.setPassword("moves", "synthetic-only");
  db.replaceFolders("moves", [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }, { path: "Trash", name: "Trash", wellKnown: "deleteditems" }, { path: "Label", name: "Label" }]);
  function seed(id, validity = 100, folderPath = "INBOX") {
    db.insertMessage({ id, accountId: "moves", folderPath, uid: 7, uidValidity: validity, subject: id, date: "2026-10-01T12:34:56Z", listSortTs: 1, bodyComplete: false });
  }
  async function run(id, mode = "move") {
    return engine.answer("mail:transferToLocal", [{ emailId: id, accountId: "moves", folderId: L.ARCHIVE_ID, mode }]);
  }
  seed("confirmed");
  current.messageMove = async (_uid, _destination, _options) => {
    writes++;
    const disk = L.createLocalStore(path.join(dir, "local-folders.sqlite"));
    try { const email = disk.list({ folderId: L.ARCHIVE_ID }).emails[0]; assert.deepEqual(disk.raw(email.id), raw); }
    finally { disk.close(); }
    return { uidMap: new Map([[7, 77]]), uidValidity: 101 };
  };
  const confirmed = await run("confirmed"); assert.equal(confirmed.success, true); assert.equal(confirmed.data.status, "moved");
  await run("confirmed"); assert.equal(writes, 1);
  db.deleteMessage("confirmed"); seed("unsupported", 101);
  current = imap(raw, { noMove: true, validity: 101 }); current.messageDelete = () => assert.fail("Never expunge as a fallback");
  const unsupported = await run("unsupported"); assert.equal(unsupported.data.status, "remote_failed");
  db.deleteMessage("unsupported"); seed("unknown", 102);
  current = imap(raw, { validity: 102 }); current.messageMove = async () => { writes++; throw new Error("Synthetic MOVE reply lost"); };
  const unknown = await run("unknown"); assert.equal(unknown.data.status, "remote_unknown");
  await run("unknown"); assert.equal(writes, 2);
  db.deleteMessage("unknown"); seed("changed-validity", 103); current = imap(raw, { validity: 200 });
  assert.equal((await run("changed-validity")).success, false); assert.equal(current.stats().downloads, 0);
  db.deleteMessage("changed-validity"); seed("removed-during-read", 104); current = imap(raw, { validity: 104 });
  const oldDownload = current.download;
  current.download = async (...args) => { const result = await oldDownload(...args); await engine.answer("mail:removeAccount", [{ accountId: "moves" }]); return result; };
  const removed = await run("removed-during-read"); assert.equal(removed.success, false);
  assert.equal((await engine.answer("mail:listFromCache", [{ accountId: L.ACCOUNT_ID, folderId: L.ARCHIVE_ID }])).data.total, 3);
  // Canonical provider identity, rather than RFC Message-ID or label folder,
  // makes copies of the same Gmail delivery share one archive receipt.
  db.insertAccount({ id: "gmail-copy", email: SOURCE.accountEmail, username: SOURCE.accountEmail, profile: "gmail", createdAt: 2,
    imapHost: "imap.fixture.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.fixture.invalid", smtpPort: 587, smtpTls: true });
  secrets.setPassword("gmail-copy", "synthetic-only");
  db.replaceFolders("gmail-copy", [{ path: "INBOX", name: "Inbox" }, { path: "Label", name: "Label" }]);
  for (const [id, folderPath] of [["gmail-inbox", "INBOX"], ["gmail-label", "Label"]]) {
    db.insertMessage({ id, accountId: "gmail-copy", folderPath, uid: 7, uidValidity: 100, subject: "Gmail duplicate", date: "2026-10-01T12:34:56Z", listSortTs: 1 });
    db.rememberGmail("gmail-copy", { providerId: "canonical-gmail" }); db.bindGmailAlias(db.messageById(id), "canonical-gmail");
  }
  current = imap(raw); const download = current.download;
  current.download = (...args) => { downloads++; return download(...args); };
  const gmailRequest = id => engine.answer("mail:transferToLocal", [{ emailId: id, accountId: "gmail-copy", folderId: L.ARCHIVE_ID, mode: "copy" }]);
  const first = await gmailRequest("gmail-inbox"), second = await gmailRequest("gmail-label");
  assert.equal(first.success, true, JSON.stringify(first)); assert.equal(second.success, true, JSON.stringify(second));
  assert.equal(first.data.localId, second.data.localId); assert.equal(downloads, 1);
});

test("actual Gmail API/session/engine archives raw MIME and confirms TRASH membership; an ignored Trash stays uncertain", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-local-gmail-")), previous = { ...process.env }, oldFetch = global.fetch;
  const env = { MORROW_MAIL_DIR: dir, MORROW_USER_DATA: dir, MORROW_MAIL_SECRETS: "memory", MORROW_GMAIL_PACE: "0",
    MORROW_GOOGLE_OAUTH_JSON: JSON.stringify({ installed: { client_id: "local-folders-fixture.apps.googleusercontent.com", client_secret: "synthetic-only" } }) };
  Object.assign(process.env, env); delete process.env.MORROW_GOOGLE_OAUTH_FILE;
  const engine = require("../host/mail/engine"), db = require("../host/mail/db"), secrets = require("../host/mail/secrets");
  const { server, message } = require("./gmail-fixture"), { createSession } = require("../host/mail/gmail-session");
  const initial = [message("local-gmail-one", ["INBOX", "Label_work"], "<archive@fixture.invalid>"), message("local-gmail-two", ["INBOX"], "<archive@fixture.invalid>")];
  const service = server(initial), raw = await mime(); let rawReads = 0, trashWrites = 0, ignoreTrash = false;
  global.fetch = async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://gmail.googleapis.com", "all provider calls are synthetic");
    if (url.searchParams.get("format") === "raw") {
      rawReads++;
      const id = decodeURIComponent(url.pathname.split("/").at(-1)), value = service.messages.get(id);
      return new Response(JSON.stringify({ id, threadId: value.threadId, labelIds: value.labelIds, raw: raw.toString("base64url") }));
    }
    if (options.method === "POST" && url.pathname.endsWith("/trash")) {
      trashWrites++;
      if (ignoreTrash) return new Response(JSON.stringify(service.messages.get(decodeURIComponent(url.pathname.split("/").at(-2)))));
    }
    return service.fetcher(input, options);
  };
  t.after(async () => {
    await engine.answer("mail:removeAccount", [{ accountId: "local-gmail" }]);
    await new Promise(resolve => setTimeout(resolve, 20));
    engine.closeLocalArchiveForTest(); await db.close(); global.fetch = oldFetch;
    for (const key of [...Object.keys(env), "MORROW_GOOGLE_OAUTH_FILE"]) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await engine.init();
  db.insertAccount({ id: "local-gmail", email: SOURCE.accountEmail, username: SOURCE.accountEmail, profile: "gmail", authKind: "oauth2", createdAt: 1,
    imapHost: "imap.gmail.com", imapPort: 993, imapTls: true, smtpHost: "smtp.gmail.com", smtpPort: 465, smtpTls: true });
  db.enableGmail("local-gmail");
  secrets.setPassword("local-gmail", JSON.stringify({ provider: "google", purpose: "imap", googleClientId: "local-folders-fixture.apps.googleusercontent.com",
    accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3600000, grantedScopes: require("../host/mail/gmail-mail-api").MAIL_SCOPES }));
  const session = createSession(db.accountById("local-gmail"), "synthetic-access", { api: service.api() });
  const folders = await session.folders(); db.replaceFolders("local-gmail", folders.folders);
  for (const item of initial) await session.adopt(item, { full: true });
  const one = db.gmailCopies("local-gmail", initial[0].id).find(row => row.folder_path === "INBOX");
  const request = row => engine.answer("mail:transferToLocal", [{ emailId: row.id, accountId: "local-gmail", folderId: L.ARCHIVE_ID, mode: "move" }]);
  const confirmed = await request(one);
  assert.equal(confirmed.success, true, JSON.stringify(confirmed)); assert.equal(confirmed.data.status, "moved", JSON.stringify(confirmed));
  assert(service.messages.get(initial[0].id).labelIds.includes("TRASH"));
  const two = db.gmailCopies("local-gmail", initial[1].id).find(row => row.folder_path === "INBOX");
  ignoreTrash = true; const unknown = await request(two);
  assert.equal(unknown.success, true, JSON.stringify(unknown)); assert.equal(unknown.data.status, "remote_unknown");
  const repeated = await request(two); assert.equal(repeated.data.status, "remote_unknown");
  assert.equal(trashWrites, 2); assert.equal(rawReads, 2);
  const disk = L.createLocalStore(path.join(dir, "local-folders.sqlite"));
  try { assert.deepEqual(disk.raw(confirmed.data.localId), raw); assert.deepEqual(disk.raw(unknown.data.localId), raw); }
  finally { disk.close(); }
});
