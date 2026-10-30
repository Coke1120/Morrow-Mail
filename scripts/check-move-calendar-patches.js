// Offline integration regressions: real engine/SQLite and provider serializers.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

async function moveChecks(engine, db, remote, secrets) {
  const actions = require("../host/mail/actions");
  const saved = remote.withClient;
  const accounts = [];
  function fixture(id, incomplete) {
    accounts.push(id);
    db.insertAccount({ id, email: id + "@example.test", username: id, profile: "custom", createdAt: Date.now(),
      imapHost: "imap.example.test", imapPort: 993, imapTls: true, smtpHost: "smtp.example.test", smtpPort: 587, smtpTls: true });
    secrets.setPassword(id, "synthetic-only");
    db.replaceFolders(id, [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }, { path: "Trash", name: "Trash", wellKnown: "deleteditems" }]);
    db.insertMessage({ id, accountId: id, folderPath: "INBOX", uid: 1, uidValidity: 100, subject: "Selected original",
      date: new Date().toISOString(), listSortTs: Date.now(), threadId: id });
    const server = {
      INBOX: { validity: 100, messages: new Map([[1, "selected"]]) },
      Trash: { validity: 200, messages: new Map([[1, "other"]]) },
    };
    const client = {
      server, moves: 0, deletes: [], statusReads: 0, locked: false,
      async getMailboxLock(folder) {
        this.mailbox = { path: folder, uidValidity: BigInt(server[folder].validity) };
        this.locked = true;
        return { release: () => { this.locked = false; } };
      },
      async messageMove(uid, destination) {
        assert(this.locked); this.moves++;
        const value = server.INBOX.messages.get(Number(uid));
        server.INBOX.messages.delete(Number(uid));
        server[destination].messages.set(51, value);
        const result = { uidValidity: 200n, uidMap: new Map([[Number(uid), 51]]) };
        // A later STATUS would identify generation 300, not this MOVE's 200.
        server[destination] = { validity: 300, messages: new Map([[1, "other"], [51, "replacement"]]) };
        if (incomplete) delete result.uidValidity;
        return result;
      },
      async status(folder) { this.statusReads++; return { uidValidity: BigInt(server[folder].validity) }; },
      async messageDelete(uid) {
        assert(this.locked);
        this.deletes.push(server[this.mailbox.path].messages.get(Number(uid)));
        server[this.mailbox.path].messages.delete(Number(uid));
      },
    };
    remote.withClient = async (_account, _secret, work) => work(client);
    return client;
  }
  const permanent = id => engine.answer("mail:deleteBatch", [{ folderWellKnownName: "deleteditems", items: [{ emailId: id }] }]);
  try {
    const client = fixture("move-response-generation", false);
    await engine.answer("mail:delete", [{ emailId: "move-response-generation" }]);
    const moved = await engine.settleActions();
    assert.equal(moved.outcomes[0].status, "completed");
    const ticket = moved.opIds[0]; assert(ticket);
    assert.equal(db.messageById("move-response-generation").uid, 51);
    assert.equal(db.messageById("move-response-generation").uid_validity, 200);
    assert.equal(client.statusReads, 0);
    for (let repeat = 0; repeat < 2; repeat++) {
      await permanent("move-response-generation");
      assert.equal((await engine.settleActions()).outcomes[0].status, "failed");
      assert.equal(db.messageById("move-response-generation").uid_validity, 200);
    }
    await engine.answer("mail:undoRemoval", [{ opIds: [ticket] }]);
    assert.equal((await engine.settleActions()).outcomes[0].status, "failed");
    assert.equal(client.moves, 1); assert.deepEqual(client.deletes, []);
    assert.equal(client.server.Trash.messages.get(51), "replacement");
    assert.equal(client.locked, false);

    const missing = fixture("move-response-missing", true);
    await engine.answer("mail:delete", [{ emailId: "move-response-missing" }]);
    const unknown = await engine.settleActions();
    assert.equal(unknown.outcomes[0].status, "unknown"); assert.equal(unknown.opIds.length, 0);
    actions.resume(); await engine.settleActions();
    for (let repeat = 0; repeat < 2; repeat++) assert.equal((await permanent("move-response-missing")).data.outcomes[0].status, "failed");
    assert.equal(missing.moves, 1); assert.deepEqual(missing.deletes, []);
    assert.equal(missing.locked, false);

    for (const invalid of [{}, { uidValidity: 0 }, { uidValidity: Infinity }, { uidValidity: 200, uidMap: new Map() }]) {
      const fake = { mailbox: { uidValidity: 100n }, released: false,
        async getMailboxLock() { return { release: () => { this.released = true; } }; },
        async messageMove() { return { uidMap: new Map([[1, 51]]), ...invalid }; },
        async status() { throw new Error("STATUS must not repair an unconfirmed COPYUID"); } };
      await assert.rejects(() => remote.moveUid(fake, "INBOX", 1, "Trash", 100), /outcome is unknown/);
      assert.equal(fake.released, true);
    }
  } finally {
    await engine.settleActions(); remote.withClient = saved;
    for (const id of accounts) { secrets.deletePassword(id); db.removeAccount(id); }
  }
}

async function calendarChecks() {
  const api = require("../host/mail/calendar-api");
  const draft = { title: "Only the title changed", start: "2026-10-25T09:00:00Z", end: "2026-10-25T10:00:00Z", allDay: false };
  function fixture(provider, extra = {}) {
    const originalBody = "<p>Complete notes</p>" + "<p>Keep this detail</p>".repeat(60) + "<div>MEETING_BLOB</div>";
    let stored = provider === "google"
      ? { id: "evt-1", summary: "Original title", start: { dateTime: draft.start }, end: { dateTime: draft.end }, location: "Old room", description: originalBody }
      : { id: "evt-1", subject: "Original title", start: { dateTime: draft.start, timeZone: "UTC" }, end: { dateTime: draft.end, timeZone: "UTC" },
          location: { displayName: "Old room" }, body: { contentType: "HTML", content: originalBody }, bodyPreview: "Short preview", "@odata.etag": 'W/"1"', ...extra };
    const requests = [];
    let getFailure = null, patchFailure = null, changeAfterRead = false, loseReply = false;
    const fetchImpl = async (_url, options) => {
      requests.push({ method: options.method, body: options.body && JSON.parse(options.body), headers: options.headers });
      if (options.method === "GET") {
        if (getFailure === "network") throw new Error("Fixture read interrupted");
        if (getFailure) return reply({}, getFailure);
        const snapshot = structuredClone(stored);
        if (changeAfterRead) stored = { ...stored, body: { contentType: "Text", content: "External change" }, "@odata.etag": 'W/"2"' };
        return reply(snapshot);
      }
      assert.equal(options.method, "PATCH");
      if (patchFailure) return reply({}, patchFailure);
      if (options.headers["if-match"] && options.headers["if-match"] !== stored["@odata.etag"]) return reply({}, 412);
      stored = { ...stored, ...JSON.parse(options.body), "@odata.etag": 'W/"next"' };
      if (loseReply) throw new Error("Fixture response lost after PATCH");
      return reply(stored);
    };
    return { fetchImpl, requests, get stored() { return stored; }, set getFailure(value) { getFailure = value; },
      set patchFailure(value) { patchFailure = value; }, set changeAfterRead(value) { changeAfterRead = value; }, set loseReply(value) { loseReply = value; } };
  }
  const update = (provider, f, fields) => api.updateEvent(provider, "synthetic-only", "cal-1", "evt-1", { ...draft, ...fields }, f.fetchImpl);
  for (const provider of ["google", "microsoft"]) {
    const f = fixture(provider);
    const original = provider === "google" ? f.stored.description : structuredClone(f.stored.body);
    for (let repeat = 0; repeat < 2; repeat++) await update(provider, f, {});
    assert.equal(f.requests.length, 2); assert(f.requests.every(r => r.method === "PATCH"));
    assert(f.requests.every(r => !own(r.body, "body") && !own(r.body, "description") && !own(r.body, "location")));
    assert.deepEqual(provider === "google" ? f.stored.description : f.stored.body, original);
    for (const allDay of [false, true]) {
      for (let repeat = 0; repeat < 2; repeat++) {
        const result = await update(provider, f, { location: "", allDay,
          ...(allDay ? { start: "2026-10-25", end: "2026-10-26" } : {}) });
        assert.equal(result.location, "");
        assert(own(f.requests.at(-1).body, "location"));
      }
    }
    assert.deepEqual(provider === "google" ? f.stored.description : f.stored.body, original);
    const rejected = fixture(provider); rejected.patchFailure = 429;
    await assert.rejects(() => update(provider, rejected, { location: "" }), e => e.status === 429);
    assert.equal(provider === "google" ? rejected.stored.location : rejected.stored.location.displayName, "Old room");
    rejected.patchFailure = null; assert.equal((await update(provider, rejected, { location: "" })).location, "");
    const interrupted = fixture(provider); interrupted.loseReply = true;
    await assert.rejects(() => update(provider, interrupted, { location: "" }), e => e.code === "provider_network");
    interrupted.loseReply = false; assert.equal((await update(provider, interrupted, { location: "" })).location, "");
    assert.deepEqual(provider === "google" ? interrupted.stored.description : interrupted.stored.body,
      provider === "google" ? original : { ...original });
  }
  const preview = fixture("microsoft");
  for (let repeat = 0; repeat < 2; repeat++) {
    await assert.rejects(() => update("microsoft", preview, { description: "Edited preview", descriptionBase: "Short preview" }), e => e.code === "conflict");
  }
  assert(preview.requests.every(r => r.method === "GET")); assert(preview.stored.body.content.includes("MEETING_BLOB"));
  for (const extra of [{ isOnlineMeeting: true }, { "@odata.etag": undefined }, { body: undefined }, { body: { contentType: "Text", content: "x".repeat(9000) } }]) {
    const f = fixture("microsoft", { body: { contentType: "Text", content: "Original" }, ...extra });
    await assert.rejects(() => update("microsoft", f, { description: "New notes", descriptionBase: "Original" }), e => e.code === "conflict");
    assert(f.requests.every(r => r.method === "GET"));
  }
  for (const failure of [404, 429, "network"]) {
    const f = fixture("microsoft", { body: { contentType: "Text", content: "Original" } }); f.getFailure = failure;
    await assert.rejects(() => update("microsoft", f, { description: "New notes", descriptionBase: "Original" }));
    assert(f.requests.every(r => r.method === "GET")); assert.equal(f.stored.body.content, "Original");
  }
  for (const content of ["Original\n", "\t Original", "\r\n Original <literal>  text \t\r\n", " \t\r\n", ""]) {
    const padded = fixture("microsoft", { body: { contentType: "Text", content } });
    const baseline = api.normalizeGraphEvent(padded.stored, "cal-1").description;
    assert.equal(baseline, content);
    const result = await update("microsoft", padded, { description: "Edited <literal> text", descriptionBase: baseline });
    assert.deepEqual(padded.requests.map(request => request.method), ["GET", "PATCH"]);
    assert.equal(padded.requests[1].headers["if-match"], 'W/"1"');
    assert.equal(padded.stored.body.content, "Edited <literal> text");
    assert.equal(result.description, "Edited <literal> text");
  }
  const changed = fixture("microsoft", { body: { contentType: "Text", content: " Original  text\n" } });
  await assert.rejects(() => update("microsoft", changed, { description: "Edited", descriptionBase: " Original text\n" }), error => error.code === "conflict");
  assert.deepEqual(changed.requests.map(request => request.method), ["GET"]);
  assert.equal(changed.stored.body.content, " Original  text\n");
  const safe = fixture("microsoft", { body: { contentType: "Text", content: "Original" } });
  await update("microsoft", safe, { description: "New notes", descriptionBase: "Original" });
  assert.deepEqual(safe.requests.map(r => r.method), ["GET", "PATCH"]);
  assert.equal(safe.requests[1].headers["if-match"], 'W/"1"'); assert.equal(safe.stored.body.content, "New notes");
  await update("microsoft", safe, { description: "", descriptionBase: "New notes" });
  assert.equal(safe.stored.body.content, "", "explicit clearing of a complete description remains available");
  for (const content of ["Original", " \tOriginal\r\n"]) {
    const concurrent = fixture("microsoft", { body: { contentType: "Text", content } }); concurrent.changeAfterRead = true;
    const baseline = api.normalizeGraphEvent(concurrent.stored, "cal-1").description;
    await assert.rejects(() => update("microsoft", concurrent, { description: "New notes", descriptionBase: baseline }), error => error.code === "conflict" && error.status === 412);
    assert.equal(concurrent.requests[1].headers["if-match"], 'W/"1"');
    assert.equal(concurrent.stored.body.content, "External change");
  }
  const lost = fixture("microsoft", { body: { contentType: "Text", content: "Original" } }); lost.loseReply = true;
  await assert.rejects(() => update("microsoft", lost, { description: "New notes", descriptionBase: "Original" }), e => e.code === "provider_network");
  lost.loseReply = false;
  await assert.rejects(() => update("microsoft", lost, { description: "New notes", descriptionBase: "Original" }), e => e.code === "conflict");
  assert.equal(lost.requests.filter(r => r.method === "PATCH").length, 1, "interrupted replacements are not blindly replayed");
  assert.equal(lost.stored.body.content, "New notes");
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-move-calendar-"));
  const keys = ["MORROW_MAIL_DIR", "MORROW_USER_DATA", "MORROW_AI_CONFIG_DIR", "MORROW_MAIL_SECRETS"];
  const env = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { MORROW_MAIL_DIR: dir, MORROW_USER_DATA: dir, MORROW_AI_CONFIG_DIR: dir, MORROW_MAIL_SECRETS: "memory" });
  const engine = require("../host/mail/engine"), db = require("../host/mail/db"), remote = require("../host/mail/remote"), secrets = require("../host/mail/secrets");
  try { await engine.init(); await moveChecks(engine, db, remote, secrets); await calendarChecks(); }
  finally {
    await db.close();
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("move-calendar-patches-ok (COPYUID generations, preview preservation, explicit clears, conflicts/retries)");
}
module.exports = { run, calendarChecks };
if (require.main === module) run().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
