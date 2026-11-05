// Synthetic SMTP receipts, IMAP clients and temporary stores only. No mailbox,
// native credential backend, real TCP/TLS connection or outgoing mail is used.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const fixture = require("./mail-performance-fixture");

test("legacy IMAP cache upgrades preserve provider flags without promoting local evidence", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-imap-flags-upgrade-"));
  const file = path.join(directory, "legacy.sqlite");
  const db = require("../host/mail/db"), Database = require("better-sqlite3");
  t.after(async () => { await db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await db.open(file);
  for (const id of ["legacy-imap", "legacy-gmail"]) {
    db.insertAccount({ ...fixture.account, id });
    db.replaceFolders(id, [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }]);
    db.applyFolderSync(id, "INBOX", fixture.report([
      fixture.message(1, { id: id + "-provider" }),
      fixture.message(2, { id: id + "-local" }),
    ]));
  }
  await db.checkpoint(); await db.close();
  // The released parent stored IMAP flags in these two visible fields only.
  // Use a real checkpoint with the pre-feature schema and nullable raw fields.
  const raw = new Database(file);
  try {
    raw.exec("DROP TABLE imap_dispositions");
    raw.prepare("UPDATE accounts SET mail_transport = 'gmail_api' WHERE id = ?").run("legacy-gmail");
    raw.exec(`UPDATE messages SET replied = 1, forwarded = 1,
      disposition_provider_replied = NULL, disposition_provider_forwarded = NULL WHERE uid = 1`);
    raw.exec(`UPDATE messages SET replied = NULL, forwarded = NULL,
      disposition_provider_replied = NULL, disposition_provider_forwarded = NULL WHERE uid = 2`);
  } finally { raw.close(); }
  await db.open(file);
  const flags = id => {
    const row = db.messageById(id);
    return [row.replied, row.forwarded, row.disposition_provider_replied, row.disposition_provider_forwarded];
  };
  assert.deepEqual(flags("legacy-imap-provider"), [1, 1, 1, 1]);
  assert.deepEqual(flags("legacy-gmail-provider"), [1, 1, null, null], "Gmail evidence is not imported as IMAP provider flags");
  db.updateMessage("legacy-imap-provider", { uid: 101 });
  assert.deepEqual(flags("legacy-imap-provider"), [1, 1, 1, 1], "identity-only projections retain legacy provider flags");
  db.updateAccountLogin("legacy-imap", { ...fixture.account, username: "changed-login" });
  assert.deepEqual(flags("legacy-imap-provider"), [1, 1, 1, 1], "login changes retire local proof without erasing provider flags");
  const row = db.messageById("legacy-imap-local");
  const proof = db.captureDisposition("legacy-imap", { kind: "reply", sourceMessageId: row.id, inReplyTo: row.rfc_message_id });
  assert.ok(proof); assert.equal(db.confirmDisposition("legacy-imap", proof), true);
  assert.deepEqual(flags(row.id), [1, null, null, null]);
  await db.checkpoint(); await db.close(); await db.open(file);
  assert.deepEqual(flags(row.id), [1, null, null, null], "later opens cannot promote a local-only indicator to provider evidence");
  db.updateAccountLogin("legacy-imap", { ...fixture.account, username: "another-login" });
  assert.deepEqual(flags(row.id), [null, null, null, null]);
});

test("IMAP confirmed sends retain scoped local evidence and never replay SMTP for flags", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-imap-dispositions-"));
  const previous = { ...process.env };
  const env = { MORROW_MAIL_DIR: directory, MORROW_USER_DATA: directory, MORROW_MAIL_SECRETS: "memory" };
  Object.assign(process.env, env);
  const db = require("../host/mail/db"), engine = require("../host/mail/engine");
  const remote = require("../host/mail/remote"), secrets = require("../host/mail/secrets");
  const identity = require("../host/mail/compose-identity"), oauth = require("../host/mail/oauth");
  const originals = { withClient: remote.withClient, sendSmtp: remote.sendSmtp,
    listFolderRecords: remote.listFolderRecords, searchUids: remote.searchUids,
    sendingFrom: identity.sendingFrom, accessTokenFor: oauth.accessTokenFor };
  const net = require("node:net"), tls = require("node:tls");
  const originalConnect = [net.connect, net.createConnection, net.Socket.prototype.connect, tls.connect];
  const forbidden = () => { throw new Error("Fixture forbids real network connections"); };
  net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = forbidden;
  t.after(async () => {
    Object.assign(remote, { withClient: originals.withClient, sendSmtp: originals.sendSmtp,
      listFolderRecords: originals.listFolderRecords, searchUids: originals.searchUids });
    identity.sendingFrom = originals.sendingFrom; oauth.accessTokenFor = originals.accessTokenFor;
    [net.connect, net.createConnection, net.Socket.prototype.connect, tls.connect] = originalConnect;
    await db.close();
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  identity.sendingFrom = async (account, from) => from || account.email;
  oauth.accessTokenFor = async account => {
    assert.equal(account.profile, "outlook"); return "synthetic-outlook-access";
  };
  await engine.init();
  const servers = new Map(), stores = [], connections = [];
  let uid = 0, smtpCalls = 0, outcome = "success", duringSend, duringLock, duringFetch;
  const folders = [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" },
    { path: "Work", name: "Work" }, { path: "Drafts", name: "Drafts", wellKnown: "drafts" }];
  for (const [id, profile, authKind] of [["outlook", "outlook", "oauth2"], ["yahoo", "yahoo", "password"], ["custom", "custom", "password"]]) {
    db.insertAccount({ ...fixture.account, id, profile, authKind });
    db.replaceFolders(id, folders);
    secrets.setPassword(id, "synthetic-placeholder");
    servers.set(id, { mode: "success", messages: new Map() });
  }
  const key = (folder, number) => JSON.stringify([folder, number]);
  function admit(accountId = "custom", extra = {}, folder = "INBOX") {
    const number = ++uid, id = `${accountId}-${number}`;
    const message = fixture.message(number, { id, replied: false, forwarded: false, ...extra });
    db.applyFolderSync(accountId, folder, fixture.report([message], { uidCursor: number }));
    servers.get(accountId).messages.set(key(folder, number), new Set(["\\Seen", "\\Flagged", "custom"]));
    return db.messageById(id);
  }
  function client(accountId) {
    const server = servers.get(accountId);
    return {
      accountId, mailbox: null,
      async getMailboxLock(folder) {
        this.mailbox = { path: folder, uidValidity: 7n, readOnly: server.mode === "read-only",
          permanentFlags: new Set(server.mode === "unsupported" ? ["\\Seen", "\\Answered"] : ["\\Seen", "\\Answered", "\\*"]) };
        if (duringLock) { const hook = duringLock; duringLock = null; hook(); }
        return { release() {} };
      },
      async *fetch(range, fields, options) {
        assert.deepEqual(fields, { uid: true, flags: true }); assert.equal(options.uid, true);
        yield { uid: 0xffffffff, flags: new Set(["\\Answered", "$Forwarded"]) };
        const flags = server.messages.get(key(this.mailbox.path, Number(range)));
        if (duringFetch) { const hook = duringFetch; duringFetch = null; hook(this); }
        if (flags) yield { uid: Number(range), flags: new Set(flags) };
      },
      async messageFlagsAdd(range, flags, options) {
        assert.equal(options.uid, true);
        stores.push({ accountId, folder: this.mailbox.path, uid: Number(range), flags });
        if (server.mode === "network") throw new Error("Synthetic lost STORE acknowledgement");
        if (server.mode === "permission") throw Object.assign(new Error("Synthetic denied STORE"), { responseStatus: "NO" });
        if (server.mode === "ignored") return true;
        if (server.mode === "false") return false;
        for (const flag of flags) server.messages.get(key(this.mailbox.path, Number(range))).add(flag);
        return true;
      },
    };
  }
  remote.withClient = async (account, password, work) => {
    assert.equal(password, account.auth_kind === "oauth2" ? "synthetic-outlook-access" : "synthetic-placeholder");
    connections.push(account.id); return work(client(account.id));
  };
  remote.sendSmtp = async (account, password, options) => {
    assert.equal(password, account.auth_kind === "oauth2" ? "synthetic-outlook-access" : "synthetic-placeholder");
    smtpCalls++;
    if (duringSend) { const hook = duringSend; duringSend = null; await hook(); }
    if (outcome === "rejected") throw Object.assign(new Error("Synthetic rejected SMTP"), { operationIssued: false });
    if (outcome === "unknown") throw new Error("Synthetic lost SMTP acknowledgement");
    const recipients = require("../host/mail/delivery-receipt").addresses([].concat(options.to, options.cc, options.bcc));
    return { messageId: options.messageId, accepted: outcome === "incomplete" ? ["other@fixture.invalid"]
      : outcome === "all-recipients" ? recipients.map(value => value.toUpperCase())
        : outcome === "omit-bcc" ? recipients.filter(value => !value.startsWith("blind@")) : ["recipient@fixture.invalid"],
      rejected: outcome === "partial" ? ["failed@fixture.invalid"] : [] };
  };
  function fields(row, extra = {}) {
    return { accountId: row.account_id, to: "recipient@fixture.invalid", body: "<p>Synthetic reply</p>",
      sourceMessageId: row.id, kind: "reply", inReplyTo: row.rfc_message_id || undefined, ...extra };
  }
  const send = (row, extra) => engine.answer("mail:send", [fields(row, extra)]);

  await t.test("Outlook OAuth, Yahoo password and custom IMAP add exact original flags", async () => {
    for (const accountId of servers.keys()) {
      const row = admit(accountId), count = smtpCalls;
      assert.equal((await send(row)).success, true);
      assert.equal(smtpCalls, count + 1); assert.equal(db.messageById(row.id).replied, 1);
      assert.equal((await send(row, { kind: "all" })).success, true);
      assert.equal((await send(row, { kind: "forward", inReplyTo: undefined })).success, true);
      assert.equal(db.messageById(row.id).forwarded, 1);
      assert.ok(servers.get(accountId).messages.get(key("INBOX", row.uid)).has("\\Flagged"));
      assert.deepEqual(stores.filter(item => item.accountId === accountId).map(item => item.flags), [["\\Answered"], ["$Forwarded"]]);
      const listed = (await engine.answer("mail:listFromCache", [{ accountId, folderId: "INBOX" }])).data.emails;
      assert.equal(listed.find(item => item.id === row.id).replied, true);
    }
  });
  await t.test("unsupported, read-only, denied, ignored and transient flags preserve send receipts", async () => {
    for (const mode of ["unsupported", "read-only", "permission", "ignored", "false", "network"]) {
      const row = admit(), before = smtpCalls, beforeStore = stores.length;
      servers.get("custom").mode = mode;
      assert.equal((await send(row, { kind: "forward", inReplyTo: undefined })).success, true, mode);
      assert.equal(smtpCalls, before + 1, mode + " submits exactly once");
      assert.equal(db.messageById(row.id).forwarded, 1, mode + " retains local evidence");
      assert.equal(stores.length - beforeStore, ["unsupported", "read-only"].includes(mode) ? 0 : 1);
      const pending = db.imapDispositions.pending("custom", "INBOX", Date.now() + 6 * 60000);
      assert.equal(pending.some(proof => proof.uid === row.uid), mode === "network", mode + " retry policy");
    }
    servers.get("custom").mode = "success";
  });
  await t.test("failed, partial, incomplete, cancelled and unbound sends add no evidence", async () => {
    for (const mode of ["rejected", "unknown", "partial", "incomplete"]) {
      const row = admit(), before = stores.length; outcome = mode;
      await send(row);
      assert.equal(db.messageById(row.id).replied, 0, mode); assert.equal(stores.length, before);
    }
    outcome = "success";
    const row = admit();
    for (const extra of [{ accountId: "yahoo" }, { inReplyTo: "<wrong@fixture.invalid>" }, { kind: "new" }]) {
      await send(row, extra); assert.equal(db.messageById(row.id).replied, 0);
    }
    const queued = engine.answer("mail:scheduleSend", [fields(row, { sendAt: "2099-01-01T00:00:00Z" })]);
    assert.equal(queued.success, true); assert.equal(db.messageById(row.id).replied, 0);
    engine.answer("mail:cancelScheduled", [{ id: queued.data.id }]); await engine.pumpScheduled();
    assert.equal(db.messageById(row.id).replied, 0);
    for (const extra of [{ uid: 0 }, { uidValidity: 0 }, { isDraft: true }]) {
      const unbound = admit("custom", extra);
      if (extra.uidValidity === 0) db.updateMessage(unbound.id, { uid_validity: 0 });
      await send(unbound); assert.equal(db.messageById(unbound.id).replied, 0);
    }
  });
  await t.test("complete To/Cc/Bcc acceptance, including CC/BCC-only sends, is required", async () => {
    const omitted = admit(); outcome = "omit-bcc";
    await send(omitted, { cc: "copy@fixture.invalid", bcc: "blind@fixture.invalid" });
    assert.equal(db.messageById(omitted.id).replied, 0, "omitted Bcc acceptance is not proof of complete send");
    outcome = "all-recipients";
    for (const to of ["recipient@fixture.invalid", ""]) {
      const row = admit(); await send(row, { to, cc: "copy@fixture.invalid", bcc: "blind@fixture.invalid" });
      assert.equal(db.messageById(row.id).replied, 1, "case-insensitive complete acceptance");
    }
    outcome = "success";
  });
  await t.test("draft, Outbox and scheduled proofs survive restart; no flag before delivery", async () => {
    for (const outbox of [false, true]) {
      const row = admit(), before = stores.length;
      const queued = engine.answer("mail:scheduleSend", [fields(row, { outbox, sendAt: new Date(Date.now() + (outbox ? 30000 : 60000)).toISOString() })]);
      assert.equal(queued.success, true, JSON.stringify(queued.error)); assert.equal(stores.length, before);
      await db.close(); await engine.init();
      db.setScheduledSendAt(queued.data.id, 0); await engine.pumpScheduled();
      assert.equal(db.messageById(row.id).replied, 1);
    }
    const row = admit();
    const saved = await engine.answer("mail:upsertDraft", [fields(row, { kind: "forward", inReplyTo: undefined })]);
    assert.equal(saved.success, true); assert.equal(db.messageById(row.id).forwarded, 0);
    await db.close(); await engine.init();
    assert.equal((await send(row, { sourceMessageId: undefined, kind: "new", inReplyTo: undefined, draftId: saved.data.emailId })).success, true);
    assert.equal(db.messageById(row.id).forwarded, 1);
  });
  await t.test("fallback survives full, flag-only and body refresh, but not UID reuse or another identity", async () => {
    const row = admit(), other = admit("yahoo");
    await send(row, { kind: "forward", inReplyTo: undefined });
    db.applyFolderSync("custom", "INBOX", fixture.report([fixture.message(row.uid, { id: row.id, replied: false, forwarded: false })]));
    db.applyFolderSync("custom", "INBOX", fixture.report([], { flags: [{ uid: row.uid, replied: false, forwarded: false }] }));
    db.updateMessage(row.id, { forwarded: 0 }, { disposition: { replied: false, forwarded: false } });
    assert.equal(db.messageById(row.id).forwarded, 1);
    const revision = db.mailInvalidations(0).revision;
    db.applyFolderSync("custom", "INBOX", { messages: [], validity: 7, keepOthers: true,
      flags: [{ uid: row.uid, replied: false, forwarded: false }] });
    assert.equal(db.mailInvalidations(0).revision, revision, "unchanged provider absence plus local evidence does not churn invalidations");
    assert.equal(db.messageById(other.id).forwarded, 0);
    await db.close(); await engine.init(); assert.equal(db.messageById(row.id).forwarded, 1);
    const proof = db.captureDisposition("custom", fields(row));
    db.updateMessage(row.id, { folder_path: "Work" });
    assert.equal(db.messageById(row.id).forwarded, 0); assert.equal(db.confirmDisposition("custom", proof), false);
    const noHeader = admit("yahoo", { rfcMessageId: null }); await send(noHeader);
    assert.equal(db.messageById(noHeader.id).replied, 1, "UID identity does not require a Message-ID");
    const old = admit("yahoo"); const stale = db.captureDisposition("yahoo", fields(old));
    await send(old);
    db.applyFolderSync("yahoo", "INBOX", fixture.report([fixture.message(old.uid, { id: "replacement", replied: false })], { validity: 8 }));
    assert.equal(db.confirmDisposition("yahoo", stale), false); assert.equal(db.messageById("replacement").replied, 0);
  });
  await t.test("account/folder changes during awaits and failed local writes cannot fail or repeat SMTP", async () => {
    const row = admit(); duringSend = () => db.updateMessage(row.id, { uid: row.uid + 1000 });
    assert.equal((await send(row)).success, true); assert.equal(db.messageById(row.id).replied, 0);
    const moved = admit(); duringFetch = () => db.updateMessage(moved.id, { folder_path: "Work" });
    const before = stores.length; assert.equal((await send(moved)).success, true); assert.equal(stores.length, before);
    const reset = admit(); duringFetch = connection => { connection.mailbox.uidValidity = 8n; };
    assert.equal((await send(reset)).success, true); assert.equal(stores.length, before, "UIDVALIDITY is rechecked after FETCH and before STORE");
    const readOnly = admit(); duringFetch = connection => { connection.mailbox.readOnly = true; };
    assert.equal((await send(readOnly)).success, true); assert.equal(stores.length, before, "new read-only selection cannot issue STORE");
    const changed = admit("outlook"); duringLock = () => db.updateAccountLogin("outlook", { ...fixture.account, username: "different-login", profile: "outlook", authKind: "oauth2" });
    assert.equal((await send(changed)).success, true); assert.equal(stores.length, before);
    assert.equal(db.messageById(changed.id).replied, 0);
    const local = admit(); const originalConfirm = db.confirmDisposition;
    db.confirmDisposition = () => { throw new Error("Synthetic local evidence storage failure"); };
    try { const count = smtpCalls; assert.equal((await send(local)).success, true); assert.equal(smtpCalls, count + 1); }
    finally { db.confirmDisposition = originalConfirm; }
    const renewed = admit(), beforeConnections = connections.length;
    duringSend = () => secrets.setPassword("custom", "synthetic-replaced");
    assert.equal((await send(renewed)).success, true);
    assert.equal(connections.length, beforeConnections, "never reuse a replaced credential for the optional IMAP connection");
    assert.equal(db.messageById(renewed.id).replied, 1, "the completed original send remains valid local evidence");
    secrets.setPassword("custom", "synthetic-placeholder");
  });
  await t.test("bot reply receipt replays preserve the indicator without another SMTP or flag write", async () => {
    const auth = require("../host/bot/auth"), bot = require("../host/bot/send");
    const originalRecheck = auth.recheck;
    auth.recheck = () => true; // synthetic grant only, no listener or real bot access
    try {
      const row = admit(), count = smtpCalls;
      servers.get("custom").mode = "network";
      const request = { requestId: require("node:crypto").randomUUID(),
        grant: { clientId: "synthetic-bot", accountIds: ["custom"] },
        params: { accountId: "custom", to: ["recipient@fixture.invalid"], subject: "Synthetic bot reply",
          bodyText: "Synthetic text", inReplyToMessageId: row.id } };
      const first = await bot.perform(request), beforeStores = stores.length;
      assert.equal(first.data.state, "submitted"); assert.equal(smtpCalls, count + 1);
      assert.equal(db.messageById(row.id).replied, 1);
      const replay = await bot.perform(request);
      assert.equal(replay.data.idempotentReplay, true); assert.equal(replay.data.auditId, first.data.auditId);
      assert.equal(smtpCalls, count + 1); assert.equal(stores.length, beforeStores);
    } finally { auth.recheck = originalRecheck; bot.resetForTest(); servers.get("custom").mode = "success"; }
  });
  await t.test("pending flags retry on a bounded ordinary sync with no SMTP or credential change", async () => {
    const row = admit(); servers.get("custom").mode = "network"; await send(row);
    assert.equal(db.imapDispositions.pending("custom", "INBOX").some(proof => proof.uid === row.uid), false);
    const future = Date.now() + 6 * 60000;
    assert.ok(db.imapDispositions.pending("custom", "INBOX", future).length <= 2);
    servers.get("custom").mode = "success";
    remote.listFolderRecords = async () => ({ folders, delimiter: "/" });
    remote.searchUids = async (connection, folder, criteria) => ({ validity: 7,
      uids: criteria?.uid ? [] : db.uidsFor(connection.accountId, folder), exists: uid, unseen: 0, flags: [] });
    const before = smtpCalls, originalNow = Date.now;
    const beforeStores = stores.filter(item => item.uid === row.uid).length;
    Date.now = () => future;
    try {
      for (let pass = 0; pass < 3 && !servers.get("custom").messages.get(key("INBOX", row.uid)).has("\\Answered"); pass++) {
        const writes = stores.length;
        await engine.answer("mail:listFromNetwork", [{ accountId: "custom", folderId: "INBOX" }]);
        assert.ok(stores.length - writes <= 2, "one sync retries at most two identities");
      }
    }
    finally { Date.now = originalNow; }
    assert.equal(smtpCalls, before);
    assert.equal(stores.filter(item => item.uid === row.uid).length, beforeStores + 1);
    assert.ok(servers.get("custom").messages.get(key("INBOX", row.uid)).has("\\Answered"));
    assert.equal(db.messageById(row.id).replied, 1);
  });
  await t.test("account removal retires evidence even if an account id is reused", async () => {
    const row = admit(); await send(row); const proof = db.captureDisposition("custom", fields(row));
    db.removeAccount("custom");
    db.insertAccount({ ...fixture.account, id: "custom" }); db.replaceFolders("custom", folders);
    db.applyFolderSync("custom", "INBOX", fixture.report([fixture.message(row.uid, { id: "new-account", replied: false })]));
    assert.equal(db.messageById("new-account").replied, 0, "removed account evidence was deleted");
    db.removeAccount("custom"); db.insertAccount({ ...fixture.account, id: "custom", createdAt: 2 });
    db.replaceFolders("custom", folders);
    db.applyFolderSync("custom", "INBOX", fixture.report([fixture.message(row.uid, { id: "new-incarnation", replied: false })]));
    assert.equal(db.confirmDisposition("custom", proof), false);
    assert.equal(db.messageById("new-incarnation").replied, 0);
  });
  await t.test("reviewed Gmail migration retires IMAP evidence and raw provider flags", () => {
    db.insertAccount({ ...fixture.account, id: "legacy", profile: "gmail", authKind: "oauth2" });
    db.replaceFolders("legacy", folders);
    db.applyFolderSync("legacy", "INBOX", fixture.report([fixture.message(1, { id: "legacy-original", replied: true, forwarded: true })]));
    const row = db.messageById("legacy-original"), proof = db.captureDisposition("legacy", fields(row));
    assert.equal(db.confirmDisposition("legacy", proof), true);
    db.enableGmail("legacy");
    const migrated = db.messageById(row.id);
    assert.deepEqual([migrated.replied, migrated.forwarded, migrated.disposition_provider_replied, migrated.disposition_provider_forwarded], [null, null, null, null]);
    assert.equal(db.confirmDisposition("legacy", proof), false);
    // Even transport compensation cannot resurrect already-retired IMAP proof.
    db.setMailTransport("legacy", "imap");
    db.updateMessage(row.id, { snippet: "Synthetic refreshed metadata" }, { disposition: { replied: false, forwarded: false } });
    assert.equal(db.messageById(row.id).replied, 0);
    assert.deepEqual(db.imapDispositions.pending("legacy", "INBOX"), []);
    db.removeAccount("legacy");
  });
});

test("real ImapFlow exercises UID STORE, permissions, ignored flags and unsolicited FETCH rows", async t => {
  const { ImapFlow } = require("imapflow"), { Duplex } = require("node:stream");
  const vm = require("node:vm"), { createRequire } = require("node:module");
  const filename = require.resolve("../host/mail/remote"), load = createRequire(filename);
  const net = require("node:net"), tls = require("node:tls");
  const originals = [net.connect, net.createConnection, net.Socket.prototype.connect, tls.connect];
  const forbidden = () => { throw new Error("IMAP wire fixture forbids network"); };
  net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = forbidden;
  t.after(() => { [net.connect, net.createConnection, net.Socket.prototype.connect, tls.connect] = originals; });

  for (const [mode, kind, expected, writes] of [
    ["success", "replied", "stored", 1], ["success", "forwarded", "stored", 1],
    ["explicit-keyword", "forwarded", "stored", 1], ["uppercase-keyword", "forwarded", "stored", 1],
    ["keyword-only", "replied", "unsupported", 0],
    ["unsupported", "forwarded", "unsupported", 0], ["read-only", "replied", "unsupported", 0],
    ["no-permanent", "forwarded", "unsupported", 0], ["ignored", "forwarded", "unsupported", 1],
    ["existing", "replied", "stored", 0], ["missing", "replied", "missing", 0],
    ["reset", "replied", "uid_validity_changed", 0], ["permission", "replied", "unsupported", 1],
    ["lost-store", "replied", "pending", 1],
    ["stale-after-fetch", "replied", "stale", 0],
  ]) {
    await t.test(mode + " / " + kind, async () => {
      const commands = [], flags = new Set(["\\Seen", "\\Flagged", "custom"]);
      if (mode === "existing") flags.add("\\Answered");
      class Socket extends Duplex {
        constructor() { super(); this.buffer = ""; this.authorized = true; }
        _read() {}
        setKeepAlive() { return this; }
        setTimeout() { return this; }
        getCipher() { return { name: "SYNTHETIC", version: "fixture" }; }
        reply(value) { setImmediate(() => { if (!this.destroyed) this.push(value); }); }
        _write(chunk, _encoding, done) {
          this.buffer += chunk.toString(); let end;
          while ((end = this.buffer.indexOf("\r\n")) >= 0) {
            const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 2); this.handle(line);
          }
          done();
        }
        handle(line) {
          commands.push(line);
          if (line === "DONE") { this.reply(`${this.idleTag} OK IDLE finished\r\n`); return; }
          const [, tag, command] = /^(\S+)\s+(.+)$/.exec(line) || [];
          assert.ok(tag, line);
          if (command === "CAPABILITY") this.reply(`* CAPABILITY IMAP4rev1 NAMESPACE IDLE\r\n${tag} OK CAPABILITY\r\n`);
          else if (command === "NAMESPACE") this.reply(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK NAMESPACE\r\n`);
          else if (command.startsWith("LIST")) this.reply(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK LIST\r\n`);
          else if (command.startsWith("LSUB")) this.reply(`${tag} OK LSUB\r\n`);
          else if (command.startsWith("SELECT")) {
            const permanent = mode === "keyword-only" ? "\\*" : mode === "explicit-keyword" ? "$Forwarded \\Answered"
              : mode === "uppercase-keyword" ? "$FORWARDED \\Answered"
              : mode === "unsupported" ? "\\Seen \\Answered" : "\\Seen \\Flagged \\Answered \\*";
            this.reply(`* FLAGS (\\Seen \\Flagged \\Answered)\r\n* 2 EXISTS\r\n* OK [UIDVALIDITY ${mode === "reset" ? 8 : 7}] Validity\r\n* OK [UIDNEXT 1000] Next\r\n`
              + (mode === "no-permanent" ? "" : `* OK [PERMANENTFLAGS (${permanent})] Permanent\r\n`)
              + `${tag} OK [${mode === "read-only" ? "READ-ONLY" : "READ-WRITE"}] Selected\r\n`);
          } else if (command.startsWith("UID FETCH")) {
            this.reply(`* 2 FETCH (UID 999 FLAGS (\\Answered $Forwarded))\r\n`
              + (mode === "missing" ? "" : `* 1 FETCH (UID 7 FLAGS (${[...flags].join(" ")}))\r\n`)
              + `${tag} OK FETCH\r\n`);
          } else if (command.startsWith("UID STORE")) {
            assert.match(command, /^UID STORE 7 \+FLAGS(?:\.SILENT)? \((?:\\Answered|\$Forwarded)\)$/i);
            if (mode === "permission") { this.reply(`${tag} NO [NOPERM] Synthetic permission denied\r\n`); return; }
            if (mode === "lost-store") { this.destroy(); return; }
            if (mode !== "ignored") flags.add(/\$Forwarded/i.test(command) ? "$Forwarded" : "\\Answered");
            this.reply(`${tag} OK STORE\r\n`);
          } else if (command === "IDLE") { this.idleTag = tag; this.reply("+ idling\r\n"); }
          else if (command === "LOGOUT") this.reply(`* BYE synthetic logout\r\n${tag} OK LOGOUT\r\n`);
          else this.reply(`${tag} OK\r\n`);
        }
      }
      class FixtureImapFlow extends ImapFlow {
        constructor(options) {
          super({ ...options, transport: { connect(_options, onConnect) {
            const socket = new Socket(); setImmediate(() => { onConnect(); socket.reply("* PREAUTH synthetic fixture\r\n"); }); return socket;
          } } });
        }
      }
      const module = { exports: {} };
      const fixtureRequire = name => name === "imapflow" ? { ImapFlow: FixtureImapFlow } : load(name);
      vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, { filename })(fixtureRequire, module, module.exports);
      const remote = module.exports;
      let checks = 0;
      const result = await remote.withClient({ imap_host: "fixture.invalid", imap_port: 993, imap_tls: 1, username: "fixture" }, "synthetic",
        connection => remote.setDisposition(connection, { folderPath: "INBOX", uid: 7, uidValidity: 7, kind }, {
          beforeSubmit() { if (mode === "stale-after-fetch" && ++checks === 2) throw Object.assign(new Error("stale"), { code: "stale" }); },
        })).catch(error => mode === "lost-store" ? "pending"
          : error.code === "uid_validity_changed" || error.code === "stale" ? error.code : error.responseStatus);
      assert.equal(result, expected);
      assert.equal(commands.filter(command => / UID STORE /.test(command)).length, writes);
      assert.ok(flags.has("\\Seen") && flags.has("\\Flagged") && flags.has("custom"), "other flags remain intact");
    });
  }
});
