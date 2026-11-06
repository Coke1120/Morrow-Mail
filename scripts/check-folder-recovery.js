"use strict";

// Real durable stores and fake protocol/clock boundaries; no credentials/mail.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { createJournal, digest } = require("../host/mail/folder-recovery");
const { createManager, GRACE_MS } = require("../host/mail/folder-management");
const { createAccess, imapListing, gmailListing } = require("../host/mail/folder-adapter");
const { createGmailMailApi } = require("../host/mail/gmail-mail-api");
const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = () => { let done; return { promise: new Promise(resolve => { done = resolve; }), resolve: value => done(value) }; };

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-folder-fixture-"));
  const file = path.join(dir, "recovery.sqlite"), disposers = [], handles = [];
  function database(file, options) { const sql = new Database(file, options); handles.push(sql); return sql; }
  // after hooks run in registration order. Own the whole lifecycle in one
  // hook so Windows never unlinks an open SQLite file, including on failure.
  t.after(() => {
    const failures = [];
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch (error) { failures.push(error); }
    }
    for (const sql of handles) {
      if (!sql.open) continue;
      failures.push(new Error("A recovery fixture left a SQLite handle open before directory cleanup."));
      try { sql.close(); } catch (error) { failures.push(error); }
    }
    // Explicitly detect leaked handles on Linux too; do not rely on its
    // permissive unlink semantics or retry a Windows lock failure.
    if (handles.every(sql => !sql.open)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Recovery fixture cleanup failed.");
  });
  return { file, handles,
    defer(dispose) { disposers.push(dispose); },
    journal(target = file, configure = () => {}) {
      function TrackedDatabase(file) { const sql = database(file); configure(sql); return sql; }
      const journal = createJournal(target, { database: TrackedDatabase });
      disposers.push(() => journal.close()); return journal;
    },
    database(target, options) { const sql = database(target, options); disposers.push(() => sql.close()); return sql; },
  };
}
const operation = (phase = "pending") => ({ id: "fixture:1", accountId: "a", sourceId: "Label_1", owner: digest("a"), source: { id: "Label_1", name: "User" }, phase, mode: "label-grace", intent: "delete", createdAt: 100, updatedAt: 100 });

test("durable journal enforces one active intent, phase CAS, file permissions and paused restart", t => {
  const scope = temp(t), file = scope.file; let journal = scope.journal();
  journal.insert(operation());
  assert.throws(() => journal.insert({ ...operation(), id: "fixture:2" }), /UNIQUE/);
  assert.throws(() => journal.update("fixture:1", "running", { phase: "deleted" }), /changed/);
  assert.deepEqual(journal.read("fixture:1"), operation());
  journal.close(); journal = scope.journal(); journal.recover(200);
  assert.equal(journal.read("fixture:1").phase, "paused");
  journal.update("fixture:1", "paused", { phase: "cancelled", updatedAt: 201 });
  journal.insert({ ...operation("running"), id: "fixture:2" }); journal.close();
  journal = scope.journal(); journal.recover(300);
  assert.equal(journal.read("fixture:2").phase, "uncertain");
  assert.equal(journal.read("fixture:1").phase, "cancelled");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  journal.close();
});

test("journal detects a corrupt receipt and refuses unknown stores without deleting them", t => {
  const scope = temp(t), file = scope.file, journal = scope.journal(); journal.insert(operation()); journal.close();
  const sql = scope.database(file); sql.prepare("UPDATE folder_operations SET body=?").run('{"corrupt":true}'); sql.close();
  const reopened = scope.journal(); assert.throws(() => reopened.list(), /storage could not be verified/); reopened.close();
  const unknown = file + ".unknown", other = scope.database(unknown); other.pragma("user_version=9"); other.close();
  assert.throws(() => scope.journal(unknown), /storage could not be verified/);
  assert.equal(scope.handles.at(-1).open, false, "constructor rejection closes the unknown store immediately");
  assert.ok(fs.existsSync(unknown));
  fs.writeFileSync(file + ".empty", ""); assert.throws(() => scope.journal(file + ".empty"), /storage could not be verified/);
});

for (const failure of ["durability pragma", "schema transaction"]) test(`journal constructor closes its native handle after ${failure} failure`, t => {
  const scope = temp(t);
  assert.throws(() => scope.journal(scope.file, sql => {
    if (failure === "durability pragma") {
      const pragma = sql.pragma.bind(sql);
      sql.pragma = (...args) => { if (args[0] === "synchronous = EXTRA") throw new Error("synthetic pragma failure"); return pragma(...args); };
    } else sql.exec = () => { throw new Error("synthetic schema failure"); };
  }), /storage could not be verified/);
  assert.equal(scope.handles.length, 1); assert.equal(scope.handles[0].open, false, "constructor must release its handle before returning failure");
});

test("committed pending and running intents survive an abrupt child-process exit without replay", t => {
  const scope = temp(t), file = scope.file;
  const result = spawnSync(process.execPath, ["-e", `const {createJournal}=require('./host/mail/folder-recovery');const j=createJournal(process.argv[1]);j.insert(JSON.parse(process.argv[2]));j.insert(JSON.parse(process.argv[3]));process.exit(23);`,
    file, JSON.stringify(operation()), JSON.stringify({ ...operation("running"), id: "fixture:2", sourceId: "Label_2" })], { cwd: path.resolve(__dirname, ".."), timeout: 10000 });
  assert.equal(result.status, 23);
  const journal = scope.journal(); journal.recover(400);
  assert.equal(journal.read("fixture:1").phase, "paused"); assert.equal(journal.read("fixture:2").phase, "uncertain"); journal.close();
});

function fixture(t, options = {}) {
  const scope = temp(t), file = scope.file, journal = scope.journal();
  let mono = 0, wall = 1000, sequence = 0, rev = Symbol("credential"), generation = 1, binding = digest("a"), writes = 0, lists = 0, connects = 0;
  let model = options.model || gmailListing([{ id: "Label_1", name: "User", type: "user", editable: true }, { id: "INBOX", name: "Inbox", type: "system", editable: false }]);
  const timers = new Map();
  const client = { accountId: "a", backend: options.backend || "gmail", label: "a@fixture.invalid", get binding() { return binding; }, get generation() { return generation; },
    get revision() { return rev; }, check() {},
    async list() { lists++; if (options.list) await options.list(); return structuredClone(model); },
    blocked: () => !!options.blocked,
    async deleteLabel(id, name) { writes++; assert.equal(id, "Label_1"); assert.equal(name, "User"); if (options.write) await options.write(); model.folders = model.folders.filter(folder => folder.id !== id); },
    async create(name) { writes++; if (options.write) await options.write(); model.folders.push({ id: name, name, type: "user", editable: true, delimiter: model.delimiter, flags: [], selectable: true, readOnly: false }); },
    async refreshCache() { if (options.cache) await options.cache(); },
  };
  const manager = createManager({ journal: () => journal, owner: () => ({ binding, generation, revision: rev }),
    withAccount: async (id, work) => { connects++; return work(client); }, monotonic: () => mono, now: () => wall,
    setTimer(fn, ms) { const id = ++sequence; timers.set(id, { fn, at: mono + ms }); return id; }, clearTimer(id) { timers.delete(id); }, gate: options.gate });
  scope.defer(() => manager.pause());
  return { manager, journal, file, model, client, options, timers, get writes() { return writes; }, get lists() { return lists; }, get connects() { return connects; },
    changeRevision() { rev = Symbol("new credential"); }, changeGeneration() { generation++; }, changeOwner() { binding = digest("other"); },
    setTime(value) { mono = value; }, setWall(value) { wall = value; },
    async runTimers() { const due = [...timers.entries()].filter(([, timer]) => timer.at <= mono); for (const [id, timer] of due) { timers.delete(id); await timer.fn(); } },
    async review(intent = "delete", extra = {}) { return manager.answer({ accountId: "a", action: "review", intent, ...(intent === "delete" ? { folderId: "Label_1", expectedName: "User" } : {}), ...extra }); },
    async remove(review, confirmation = "confirm") { return manager.answer({ accountId: "a", action: "delete", reviewId: review.reviewId, confirmation }); },
  };
}

test("Gmail Undo cancels a durable intent without any provider write or credential read", async t => {
  const f = fixture(t), review = await f.review(), result = await f.remove(review), count = f.connects;
  assert.equal(result.phase, "pending"); assert.equal(result.remainingMs, GRACE_MS); assert.equal(f.writes, 0);
  assert.equal(f.journal.read(result.id).phase, "pending");
  const undone = await f.manager.answer({ action: "undo", accountId: "a", operationId: result.id });
  assert.equal(undone.phase, "cancelled"); assert.equal(f.connects, count);
  f.setTime(GRACE_MS + 1); await f.runTimers(); assert.equal(f.writes, 0);
});

test("Gmail label removal waits on monotonic grace, commits once and cannot offer restoration", async t => {
  const f = fixture(t), result = await f.remove(await f.review());
  f.setWall(999999999); f.setTime(GRACE_MS - 1); await f.runTimers(); assert.equal(f.writes, 0);
  f.setTime(GRACE_MS); await f.runTimers();
  assert.equal(f.writes, 1); assert.equal(f.journal.read(result.id).phase, "deleted");
  assert.equal(f.manager.operations("a")[0].canUndo, false);
  await assert.rejects(f.manager.answer({ action: "undo", accountId: "a", operationId: result.id }), /window ended/);
  f.setTime(GRACE_MS * 2); await f.runTimers(); assert.equal(f.writes, 1);
});

for (const confirmation of ["", "Confirm", " confirm", "confirm ", true]) test(`delete rejects exact confirmation mismatch ${JSON.stringify(confirmation)}`, async t => {
  const f = fixture(t); await assert.rejects(f.remove(await f.review(), confirmation), /Type confirm exactly/); assert.equal(f.writes, 0); assert.equal(f.journal.list().length, 0);
});

for (const change of ["changeRevision", "changeGeneration", "changeOwner", "rename", "system", "pending-mail"]) test(`changed ${change} pauses delayed deletion without a write`, async t => {
  const f = fixture(t), result = await f.remove(await f.review());
  if (change === "rename") f.model.folders[0].name = "Changed";
  else if (change === "system") f.model.folders[0].type = "system";
  else if (change === "pending-mail") f.options.blocked = true;
  else f[change]();
  f.setTime(GRACE_MS); await f.runTimers(); assert.equal(f.writes, 0); assert.equal(f.journal.read(result.id).phase, "paused");
});

test("Undo during the expiry LIST wins the durable CAS and prevents submission", async t => {
  const f = fixture(t), result = await f.remove(await f.review()), wait = delay();
  f.options.list = () => wait.promise; f.setTime(GRACE_MS);
  const running = f.runTimers(); await tick();
  await f.manager.answer({ action: "undo", accountId: "a", operationId: result.id }); wait.resolve(); await running;
  assert.equal(f.writes, 0); assert.equal(f.journal.read(result.id).phase, "cancelled");
});

test("shutdown pauses a timer even if its fresh LIST is in progress", async t => {
  const f = fixture(t), result = await f.remove(await f.review()), wait = delay();
  f.options.list = () => wait.promise; f.setTime(GRACE_MS); const running = f.runTimers(); await tick();
  f.manager.pause(); wait.resolve(); await running;
  assert.equal(f.writes, 0); assert.equal(f.journal.read(result.id).phase, "paused");
});

test("restart leaves pending deletion paused until cancelled; it never rearms", async t => {
  const f = fixture(t), result = await f.remove(await f.review()); f.manager.pause();
  const again = createManager({ journal: () => f.journal, owner: () => ({ binding: digest("a") }), withAccount: () => { throw new Error("must not reconnect"); } });
  assert.equal(again.operations("a")[0].phase, "paused");
  assert.equal((await again.answer({ action: "undo", accountId: "a", operationId: result.id })).phase, "cancelled");
});

test("obsolete-binding pre-write intents retire safely and cannot permanently block a label", async t => {
  const f = fixture(t), result = await f.remove(await f.review()); f.changeOwner();
  f.setTime(GRACE_MS); await f.runTimers(); assert.equal(f.journal.read(result.id).phase, "paused");
  const status = await f.manager.answer({ action: "list", accountId: "a" });
  assert.equal(f.journal.read(result.id).phase, "cancelled"); assert.equal(f.writes, 0);
  assert.equal(status.operations.length, 0); assert.equal(status.folders[0].deletion.enabled, true);
  assert.ok((await f.review()).reviewId);
});

test("explicit Undo can cancel an obsolete connection's proven pre-write local intent", async t => {
  const f = fixture(t), result = await f.remove(await f.review()); f.changeOwner();
  assert.equal((await f.manager.answer({ action: "undo", accountId: "a", operationId: result.id })).phase, "cancelled");
  f.setTime(GRACE_MS); await f.runTimers(); assert.equal(f.writes, 0);
});

test("obsolete-binding running and uncertain writes remain visible and protected", async t => {
  const f = fixture(t, { write() { throw new Error("synthetic unknown outcome"); } }), result = await f.remove(await f.review());
  f.setTime(GRACE_MS); await f.runTimers(); assert.equal(f.writes, 1); f.changeOwner();
  const view = await f.manager.answer({ action: "list", accountId: "a" });
  assert.equal(view.operations[0].phase, "uncertain"); assert.equal(view.operations[0].canUndo, false);
  assert.match(view.operations[0].name, /previous connection/); assert.match(view.operations[0].reason, /will not replay/);
  assert.equal(view.folders[0].deletion.enabled, false);
  await assert.rejects(f.manager.answer({ action: "undo", accountId: "a", operationId: result.id }), /window ended/);
  assert.equal(f.journal.read(result.id).phase, "uncertain"); assert.equal(f.writes, 1);
});

test("ambiguous write failure becomes uncertain and is never automatically replayed", async t => {
  const f = fixture(t, { write() { throw new Error("synthetic connection loss"); } }), result = await f.remove(await f.review());
  f.setTime(GRACE_MS); await f.runTimers(); assert.equal(f.writes, 1); assert.equal(f.journal.read(result.id).phase, "uncertain");
  assert.equal(f.manager.operations("a")[0].canUndo, false);
  f.setTime(GRACE_MS * 5); await f.runTimers(); assert.equal(f.writes, 1);
  await assert.rejects(f.review(), /pending or uncertain/);
});

for (const failure of ["intent", "running", "receipt"]) test(`journal ${failure} failure cannot cause an untracked or replayed write`, async t => {
  const f = fixture(t), review = await f.review(), insert = f.journal.insert, update = f.journal.update;
  if (failure === "intent") {
    f.journal.insert = () => { throw new Error("synthetic disk failure"); };
    await assert.rejects(f.remove(review), /disk failure/); assert.equal(f.writes, 0); return;
  }
  const result = await f.remove(review);
  f.journal.update = (id, before, patch) => { if (patch.phase === (failure === "running" ? "running" : "deleted")) throw new Error("synthetic disk failure"); return update(id, before, patch); };
  f.setTime(GRACE_MS); await f.runTimers();
  assert.equal(f.writes, failure === "running" ? 0 : 1);
  assert.equal(f.journal.read(result.id).phase, failure === "running" ? "paused" : "uncertain");
  f.journal.insert = insert;
});

test("timer storage failure settles without an unhandled rejection or provider write", async t => {
  const f = fixture(t), result = await f.remove(await f.review()), read = f.journal.read;
  f.journal.read = () => { throw new Error("synthetic unreadable journal"); };
  f.setTime(GRACE_MS); await f.runTimers(); assert.equal(f.writes, 0);
  f.journal.read = read; assert.equal(f.journal.read(result.id).phase, "pending");
  assert.equal(f.timers.size, 0);
  const recovered = f.manager.operations("a")[0]; assert.equal(recovered.phase, "paused"); assert.equal(recovered.canUndo, true);
  assert.equal((await f.manager.answer({ action: "undo", accountId: "a", operationId: result.id })).phase, "cancelled");
});

test("an unreadable recovery journal preserves browsing while disabling every folder write", async t => {
  const f = fixture(t); f.journal.list = () => { throw new Error("synthetic corrupt journal"); };
  const result = await f.manager.answer({ action: "list", accountId: "a" });
  assert.equal(result.folders.length, 2); assert.equal(result.recoveryAvailable, false); assert.match(result.recoveryError, /browsing remains available/);
  assert.equal(result.canCreate, false); assert.ok(result.folders.every(folder => !folder.canCreate && !folder.deletion.enabled));
  await assert.rejects(f.review("create"), /corrupt journal/); await assert.rejects(f.review(), /corrupt journal/); assert.equal(f.writes, 0);
});

test("an update gate refusal pauses expiry without using the provider", async t => {
  let closed = false;
  const f = fixture(t, { gate: { run: work => { if (closed) throw new Error("update preparing"); return work(); } } });
  const result = await f.remove(await f.review()); closed = true; f.setTime(GRACE_MS); await f.runTimers();
  assert.equal(f.writes, 0); assert.equal(f.journal.read(result.id).phase, "paused");
});

test("all IMAP deletes including Gmail IMAP stay disabled and never use mailboxDelete", async t => {
  const model = imapListing([{ path: "User", name: "User", delimiter: "/", flags: new Set() }]);
  const f = fixture(t, { backend: "imap", model });
  assert.equal((await f.manager.answer({ action: "list", accountId: "a" })).folders[0].deletion.enabled, false);
  await assert.rejects(f.review("delete", { folderId: "User" }), /unavailable/); assert.equal(f.writes, 0);
  f.client.gmailImap = true; await assert.rejects(f.review("delete", { folderId: "User" }), /Gmail IMAP uses labels/);
});

test("IMAP creation preserves delimiter and NoSelect parents while respecting NoInferiors and read-only", async t => {
  const model = imapListing([{ path: "Parent", name: "Parent", delimiter: ".", flags: new Set(["\\Noselect"]) },
    { path: "Locked", delimiter: ".", flags: new Set(["\\Noinferiors"]) }, { path: "ReadOnly", delimiter: ".", readOnly: true }]);
  const f = fixture(t, { backend: "imap", model });
  const list = await f.manager.answer({ action: "list", accountId: "a" });
  assert.equal(list.folders[0].selectable, false); assert.equal(list.folders[0].canCreate, true);
  for (const folderId of ["Locked", "ReadOnly"]) await assert.rejects(f.review("create", { folderId }), /cannot accept/);
  const review = await f.review("create", { folderId: "Parent" });
  const result = await f.manager.answer({ action: "create", accountId: "a", reviewId: review.reviewId, name: "Child" });
  assert.equal(result.folderId, "Parent.Child"); assert.equal(f.writes, 1);
  const flat = fixture(t, { backend: "imap", model: imapListing([{ path: "Flat", delimiter: null }]) });
  assert.equal((await flat.manager.answer({ action: "list", accountId: "a" })).canCreate, false);
});

test("expired, reused, cross-account and renamed reviews never authorize creation/deletion", async t => {
  const f = fixture(t), review = await f.review();
  await assert.rejects(f.manager.answer({ action: "delete", accountId: "b", reviewId: review.reviewId, confirmation: "confirm" }), /expired or changed/);
  await assert.rejects(f.remove(review), /expired or changed/);
  const stale = await f.review(); f.setTime(120001); await assert.rejects(f.remove(stale), /expired or changed/);
  const create = await f.review("create"); f.changeGeneration();
  await assert.rejects(f.manager.answer({ action: "create", accountId: "a", reviewId: create.reviewId, name: "New" }), /changed/);
  assert.equal(f.writes, 0);
});

test("a later cache refresh failure preserves a confirmed creation receipt", async t => {
  const f = fixture(t, { cache() { throw new Error("synthetic cache unavailable"); } }), review = await f.review("create");
  const result = await f.manager.answer({ action: "create", accountId: "a", reviewId: review.reviewId, name: "Created" });
  assert.equal(result.phase, "created"); assert.match(result.cacheWarning, /server confirmed/); assert.equal(f.journal.read(result.id).phase, "created"); assert.equal(f.writes, 1);
});

function accessFixture(options = {}) {
  const account = { id: "a", created_at: 10, profile: options.gmail || options.legacyGmail ? "gmail" : "yahoo", auth_kind: options.gmail || options.legacyGmail ? "oauth2" : "password", mail_transport: options.gmail ? "gmail_api" : "imap", username: "a@fixture.invalid", imap_host: "imap.fixture.invalid", imap_port: 993, imap_tls: 1 };
  let gen = 1, rev = Symbol("credential"), reads = 0, connects = 0, writes = 0, clientId = "client-fixture";
  const access = createAccess({ accountById: id => id === "a" ? account : null, bindAccount: a => ({ ...a }), assertAccountCurrent: a => { if (a.created_at !== account.created_at) throw Object.assign(new Error("changed"), { code: "conflict" }); },
    generation: () => gen, revision: () => rev, googleClient: () => clientId,
    exclusive: async (id, work) => { if (options.lane) await options.lane(); return work(); },
    secretFor: async () => { reads++; if (options.secret) await options.secret(); return "synthetic"; },
    withMailClient: async (a, secret, work, hooks) => {
      connects++; if (options.connection) await options.connection();
      const transport = { list: async () => { if (options.list) await options.list(); return [{ path: "User", delimiter: "/", flags: new Set() }]; }, mailboxCreate: async () => { writes++; }, mailboxRename: async () => { writes++; } };
      if (options.gmail) transport.gmail = { api: createGmailMailApi({ check: hooks.check, accessToken: async () => { if (options.token) await options.token(); return "synthetic"; },
        fetchImpl: async (url, request) => { if ((request.method || "GET") !== "GET") writes++; return new Response(JSON.stringify({ labels: [{ id: "Label_1", name: "User", type: "user" }] }), { status: 200 }); } }) };
      return work(transport);
    }, refreshCache: async () => {} });
  return { access, account, get reads() { return reads; }, get connects() { return connects; }, get writes() { return writes; }, reconnect() { gen++; }, rotate() { rev = Symbol("replacement"); }, client() { clientId = "replacement"; } };
}

for (const stage of ["lane", "secret", "connection", "list"]) test(`transport ownership rejects reconnect during ${stage}`, async () => {
  const wait = delay(), options = { [stage]: () => wait.promise }, f = accessFixture(options);
  const running = f.access.withAccount("a", async client => { await client.list(); client.check(); await client.create("New"); });
  await tick(); f.reconnect(); wait.resolve(); await assert.rejects(running, /changed/);
  assert.equal(f.writes, 0); if (stage === "lane") assert.equal(f.reads, 0);
});
for (const operation of ["create", "move"]) for (const stage of ["lane", "secret", "connection", "list"]) test(`legacy Google OAuth IMAP ${operation} rejects client replacement during ${stage}`, async () => {
  const wait = delay(), f = accessFixture({ legacyGmail: true, [stage]: () => wait.promise });
  const ticket = f.access.owner("a");
  const running = f.access.withAccount("a", async client => {
    await client.list(); client.check();
    if (operation === "create") await client.create("New");
    else { client.check(); await client.transport.mailboxRename("User", "Moved"); client.check(); }
  }, ticket);
  await tick(); f.client(); wait.resolve(); await assert.rejects(running, /changed/);
  assert.equal(f.writes, 0); if (stage === "lane") assert.equal(f.reads, 0);
});

test("stale reviewed credential binding rejects before another credential read", async () => {
  const f = accessFixture(), ticket = f.access.owner("a"); f.rotate();
  await assert.rejects(f.access.withAccount("a", () => {}, ticket), /changed/); assert.equal(f.reads, 0); assert.equal(f.connects, 0);
});

test("endpoint or account-incarnation replacement during login cannot receive a folder write", async () => {
  for (const replace of [account => { account.imap_host = "replacement.fixture.invalid"; }, account => { account.created_at++; }]) {
    const wait = delay(), f = accessFixture({ connection: () => wait.promise });
    const running = f.access.withAccount("a", client => client.create("New")); await tick(); replace(f.account); wait.resolve();
    await assert.rejects(running, /changed/); assert.equal(f.writes, 0);
  }
});

for (const change of ["rotate", "client"]) test(`Gmail ${change} during per-request token await cannot submit a label write`, async () => {
  const wait = delay(), f = accessFixture({ gmail: true, token: () => wait.promise });
  const running = f.access.withAccount("a", client => client.create("New")); await tick(); f[change](); wait.resolve();
  await assert.rejects(running, /changed/); assert.equal(f.writes, 0);
});

test("Gmail final provider listing rejects a renamed label before DELETE", async () => {
  let writes = 0;
  const api = createGmailMailApi({ accessToken: async () => "synthetic", fetchImpl: async (url, request) => {
    if (request.method !== "GET") writes++;
    return new Response(JSON.stringify({ labels: [{ id: "Label_1", name: "Renamed", type: "user" }] }), { status: 200 });
  } });
  await assert.rejects(api.deleteLabel("Label_1", { expectedName: "User" }), /reviewed Gmail label changed/); assert.equal(writes, 0);
});
