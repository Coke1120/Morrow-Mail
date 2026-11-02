// Production sync/cache integration. All transports and native notices are synthetic.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-notification-sync-"));
Object.assign(process.env, { MORROW_MAIL_DIR: directory, MORROW_USER_DATA: directory, MORROW_MAIL_SECRETS: "memory", MORROW_PAGE_DELAY_MS: "0", MORROW_GMAIL_PACE: "0" });
const db = require("../host/mail/db"), engine = require("../host/mail/engine"), remote = require("../host/mail/remote");
const notifications = require("../host/mail/notifications");
const { server, message } = require("./gmail-fixture");
const { createSession } = require("../host/mail/gmail-session");
const { before, after } = require("node:test");
before(async () => { await engine.init(); });
after(async () => { notifications.stop(); await db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
function account(id, profile = "custom") {
  db.insertAccount({ id, profile, authKind: profile === "gmail" ? "oauth2" : "password", email: `${id}@fixture.invalid`, username: id,
    imapHost: "imap.fixture.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.fixture.invalid", smtpPort: 465, smtpTls: true, createdAt: Date.now() });
  db.replaceFolders(id, [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }, { path: "Archive", name: "Archive", wellKnown: "archive" }]);
  require("../host/mail/secrets").setPassword(id, "synthetic-secret");
  return db.accountById(id);
}
function delivery() {
  let timer;
  const shown = [];
  class Native extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; }
    show() { shown.push(this); this.emit("show"); } close() {}
  }
  const controller = notifications.createNotifications({ setTimer: work => { timer = work; return 1; }, clearTimer: () => { timer = null; },
    preferences: () => ({ enabled: true, preview: "hidden" }) });
  controller.configure({ Notification: Native, platform: "darwin", open() {} });
  return { controller, shown, flush() { const fn = timer; timer = null; fn?.(); } };
}

test("Outlook and password IMAP: bootstrap/history/flags suppress; committed recent arrivals notify; resync/UID reset suppress", async () => {
  const original = { withClient: remote.withClient, searchUids: remote.searchUids, fetchMessages: remote.fetchMessages, enqueue: notifications.enqueue };
  const d = delivery();
  notifications.enqueue = (a, rows) => d.controller.enqueue(a, rows);
  try {
    for (const profile of ["outlook", "custom"]) {
      const a = account(`imap-${profile}`, profile), rows = new Map(); let validity = 1;
      const add = (uid, age = 0) => rows.set(uid, { uid, rfcMessageId: `<${a.id}-${uid}@fixture.invalid>`, threadId: `${a.id}-${uid}`,
        subject: "Synthetic", from: "sender@fixture.invalid", to: [], cc: [], bcc: [], unread: true,
        date: new Date(Date.now() - age).toISOString(), sentAt: Date.now() - age, listSortTs: Date.now() - age, receivedAt: Date.now() - age, textBody: "Synthetic", bodyComplete: true });
      remote.withClient = async (_account, _secret, work) => work({});
      remote.searchUids = async (_client, folder, query) => ({ validity, exists: rows.size, unseen: rows.size, flags: [],
        uids: [...rows.keys()].filter(uid => !query.uid || uid >= Number(query.uid.split(":")[0])) });
      remote.fetchMessages = async (_client, folder, uids) => ({ validity, messages: uids.map(uid => rows.get(uid)) });
      const sync = async () => { const result = await engine.answer("mail:listFromNetwork", [{ accountId: a.id, folderId: "INBOX" }]); assert.equal(result.success, true, JSON.stringify(result)); };
      const before = d.shown.length;
      add(1); await sync(); d.flush(); assert.equal(d.shown.length, before, "initial sync is quiet, even for recent unread mail");
      add(2); await sync(); d.flush(); assert.equal(d.shown.length, before + 1, "incremental Inbox delivery reaches the native adapter");
      await sync(); d.flush(); assert.equal(d.shown.length, before + 1, "flag/repeated sync is quiet");
      add(3, 86400000); await sync(); d.flush(); assert.equal(d.shown.length, before + 1, "old imported mail is quiet");
      validity = 2; await sync(); await sync(); d.flush(); assert.equal(d.shown.length, before + 1, "UIDVALIDITY reset/bootstrap does not alert");
      assert.ok(db.notificationState(a.id).seen.length);
    }
  } finally { Object.assign(remote, { withClient: original.withClient, searchUids: original.searchUids, fetchMessages: original.fetchMessages }); notifications.enqueue = original.enqueue; d.controller.stop(); }
});

test("Gmail: only messagesAdded with current Inbox membership emit arrivals; persisted pending pages resume without duplicate or history alerts", async () => {
  const a = account("gmail-notices", "gmail"), service = server();
  db.enableGmail(a.id);
  const session = () => createSession(db.accountById(a.id), "synthetic-token", { api: service.api() });
  let s = session(); db.replaceFolders(a.id, (await s.folders()).folders, "/");
  function incoming(id, labels = ["INBOX", "UNREAD"], age = 0) {
    const row = message(id, labels); row.internalDate = String(Date.now() - age);
    row.payload.headers.find(h => h.name === "Date").value = new Date(Date.now() - age).toUTCString();
    service.messages.set(id, row); return row;
  }
  incoming("bootstrap");
  const d = delivery(), deliver = result => { d.controller.enqueue(db.accountById(a.id), result.arrivals); d.flush(); };
  deliver(await s.sync("INBOX")); assert.equal(d.shown.length, 0);
  incoming("fresh"); incoming("flag-only"); incoming("archive", ["UNREAD"]); incoming("old-import", ["INBOX", "UNREAD"], 86400000);
  service.history([{ id: "101", messagesAdded: ["fresh", "archive", "old-import"].map(id => ({ message: { id } })),
    labelsAdded: [{ message: { id: "flag-only" }, labelIds: ["INBOX"] }] }]);
  const first = await s.sync("INBOX", { limit: 1 });
  assert.equal(first.arrivals.length, 1); deliver(first); assert.equal(d.shown.length, 1);
  assert.ok(db.gmailSyncState(a.id, "INBOX").pending);
  s = session();
  while (db.gmailSyncState(a.id, "INBOX").pending) deliver(await s.sync("INBOX", { limit: 1 }));
  assert.equal(d.shown.length, 1, "old imports, archive-only and label events do not notify");
  deliver(await s.sync("INBOX")); assert.equal(d.shown.length, 1, "repeated history events are deduplicated");
  const before = db.notificationState(a.id); assert.equal(before.seen.length, 1);
  const cached = db.gmailCopies(a.id, "fresh")[0];
  for (const headers of [db.messageById(cached.id, { headersOnly: true }),
    db.messageByUid(a.id, "INBOX", cached.uid, cached.uid_validity, { headersOnly: true }),
    db.messageByRfc(a.id, cached.rfc_message_id, { headersOnly: true }), ...db.gmailCopies(a.id, "fresh", { headersOnly: true })]) {
    assert.equal(Object.hasOwn(headers, "html_body"), false); assert.equal(Object.hasOwn(headers, "text_body"), false);
  }
  service.expire(); deliver(await s.sync("INBOX")); assert.equal(d.shown.length, 1, "history-expiry rescan is quiet");
  d.controller.stop();
  await db.close(); await db.open(path.join(directory, "mail.sqlite"));
  assert.deepEqual(db.notificationState(a.id), before, "dedup state survives production journal/checkpoint reopen");
  db.removeAccount(a.id); assert.deepEqual(db.notificationState(a.id), {}, "account removal removes delivery state");
});

test("production IMAP parser carries INTERNALDATE independently of an old Date header", async () => {
  const filename = require.resolve("../host/mail/remote"), vm = require("node:vm"), load = require("node:module").createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8") + "\nmodule.exports.readFetched = readFetched;", {
    module, exports: module.exports, require: load, __dirname: path.dirname(filename), process, console, Buffer, URL, Date, TextDecoder, TextEncoder, setTimeout, clearTimeout,
  });
  const received = new Date(), row = await module.exports.readFetched({ uid: 1, flags: new Set(), internalDate: received,
    envelope: { date: new Date("2001-01-01T00:00:00Z"), from: [{ address: "sender@fixture.invalid" }], subject: "Synthetic" },
    source: Buffer.from("From: sender@fixture.invalid\r\nDate: Mon, 01 Jan 2001 00:00:00 +0000\r\n\r\nSynthetic") }, 1);
  assert.equal(row.receivedAt, received.getTime()); assert.match(row.date, /^2001-/);
});
