"use strict";

// Temporary synthetic SQLite/receipt stores; authorization and provider sockets
// are intercepted. No grants, credentials, user config or live mail are used.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { test } = require("node:test");
const db = require("../host/mail/db"), auth = require("../host/bot/auth");
const service = require("../host/bot/service"), writes = require("../host/bot/mail-actions");
const actions = require("../host/mail/actions"), remote = require("../host/mail/remote");
const catalog = require("../host/bot/catalog"), storage = require("../host/bot/store");
const { state: listenerState } = require("../host/bot/listener-status");
const REQUEST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherId = n => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`;
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-bot-actions-"));
  const previous = process.env.MORROW_USER_DATA;
  process.env.MORROW_USER_DATA = directory;
  const original = { recheck: auth.recheck, enabled: auth.isEnabled, authenticate: auth.authenticate, client: remote.withClient, listening: listenerState.listening };
  listenerState.listening = true; // mocked state; no socket is opened by this fixture
  const control = { live: true, revision: 1, beforeSecret: null, beforeConnect: null, beforeLock: null, duringWrite: null, reject: null };
  const effects = [], broadcasts = [];
  await db.open(path.join(directory, "mail.sqlite"));
  for (const id of ["alpha", "beta"]) {
    db.insertAccount({ id, email: id + "@example.test", username: id, profile: "custom", authKind: "password",
      imapHost: "imap.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.invalid", smtpPort: 465, smtpTls: true, createdAt: 100 });
    db.replaceFolders(id, [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" },
      { path: "Archive", name: "Archive", wellKnown: "archive" }, { path: "Trash", name: "Trash", wellKnown: "deleteditems" },
      { path: "Drafts", name: "Drafts", wellKnown: "drafts" }], "/");
  }
  const add = (id, accountId = "alpha", extra = {}) => db.insertMessage({ id, accountId, folderPath: "INBOX",
    uid: id === "two" ? 2 : id === "other" ? 3 : 1, uidValidity: 7, unread: true, subject: "Synthetic", date: "2026-11-02T10:00:00.000Z", listSortTs: 1793613600000, ...extra });
  add("one"); add("two"); add("other", "beta");
  const grant = { clientId: "synthetic-client", installationId: "synthetic-install", revision: 1,
    accountIds: ["alpha"], capabilities: [...catalog.DEFAULT_CAPABILITIES, ...catalog.MAIL_ACTION_CAPABILITIES] };
  auth.recheck = (candidate, scope) => control.live && candidate === grant && candidate.revision === control.revision && (!scope
    || grant.accountIds.includes(scope.accountId) && grant.capabilities.includes(scope.capability));
  auth.isEnabled = () => control.live;
  auth.authenticate = header => control.live && header === "Bearer synthetic-only" ? grant : null;
  const client = {
    mailbox: { uidValidity: 7 },
    async getMailboxLock() { await control.beforeLock?.(); return { release() {} }; },
    async fetchOne(uid, fields, options) {
      assert.deepEqual(fields, { uid: true }); assert.deepEqual(options, { uid: true });
      return control.missing ? false : { uid: Number(uid) };
    },
    async messageMove(uid, destination) {
      if (control.reject) throw Object.assign(new Error("Synthetic refusal"), { operationIssued: !control.reject.before });
      effects.push({ kind: "move", uid, destination }); await control.duringWrite?.();
      return { uidMap: new Map([[Number(uid), Number(uid) + 100]]), uidValidity: 7 };
    },
    async messageFlagsAdd(uid, flags) {
      if (control.reject) throw Object.assign(new Error("Synthetic refusal"), { operationIssued: !control.reject.before });
      effects.push({ kind: "add", uid, flags }); await control.duringWrite?.();
    },
    async messageFlagsRemove(uid, flags) { effects.push({ kind: "remove", uid, flags }); await control.duringWrite?.(); },
    async messageDelete() { throw Error("Permanent delete must never be called"); },
  };
  remote.withClient = async (_account, _secret, work) => { await control.beforeConnect?.(); return work(client); };
  let queue = Promise.resolve();
  actions.install({ exclusive(_id, work) { const next = queue.then(work, work); queue = next.catch(() => {}); return next; },
    secretFor: async () => { await control.beforeSecret?.(); return "synthetic-only"; },
    emitAccounts() {}, broadcast: (channel, data) => broadcasts.push({ channel, data }) });
  const ctx = (operation = "mail.archive", params = {}, requestId = REQUEST) => ({ operation, requestId,
    installationId: grant.installationId, grant, params: { accountId: "alpha", messageId: "one", ...params } });
  const run = (operation, params, requestId) => service.execute(ctx(operation, params, requestId));
  t.after(async () => {
    control.beforeSecret = control.beforeConnect = control.beforeLock = control.duringWrite = null;
    await actions.settleActions(); actions.resetForTests(); await db.close();
    auth.recheck = original.recheck; auth.isEnabled = original.enabled; auth.authenticate = original.authenticate; remote.withClient = original.client;
    listenerState.listening = original.listening;
    if (previous === undefined) delete process.env.MORROW_USER_DATA; else process.env.MORROW_USER_DATA = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, control, effects, broadcasts, grant, add, ctx, run, client };
}

test("independent scopes default off, exact desktop consent is required, describe reflects writes", async t => {
  const f = await fixture(t);
  for (const cap of catalog.MAIL_ACTION_CAPABILITIES) assert.ok(!catalog.DEFAULT_CAPABILITIES.includes(cap));
  for (const consent of [null, {}, { accountIds: ["beta"], capabilities: ["mail.trash"] },
    { accountIds: ["alpha"], capabilities: ["mail.trash", "mail.archive"] }, { accountIds: ["alpha", "alpha"], capabilities: ["mail.trash"] }]) {
    assert.throws(() => auth.validateMailActionConsent(consent, ["alpha"], ["mail.trash"]), /Review and confirm/);
  }
  assert.doesNotThrow(() => auth.validateMailActionConsent({ accountIds: ["alpha"], capabilities: ["mail.trash"] }, ["alpha"], ["mail.trash"]));
  assert.throws(() => auth.mint({ label: "Fixture", accountIds: ["alpha"], capabilities: ["mail.trash"] }), /Review and confirm/);
  assert.equal(fs.existsSync(storage.accessPath()), false, "the consent rejection never creates a grant or credential");
  for (const [operation, capability] of [["mail.archive", "mail.archive"], ["mail.mark_read", "mail.read_state.write"], ["mail.trash", "mail.trash"]]) {
    f.grant.capabilities = catalog.DEFAULT_CAPABILITIES.slice();
    await assert.rejects(f.run(operation, operation === "mail.mark_read" ? { isRead: true } : {}), { code: "FORBIDDEN" });
    f.grant.capabilities.push(capability);
    const description = await service.execute({ ...f.ctx(), operation: "bridge.describe", params: {} });
    assert.ok(description.data.operations.includes(operation)); assert.equal(description.data.readOnlyMailbox, false);
    assert.equal(description.data.semantics.providerCalls, true); assert.equal(description.data.semantics.sending, false);
  }
  assert.equal(f.effects.length, 0);
});

test("archive uses one confirmed move, idempotent polling, stable UUID casing and normal Undo", async t => {
  const f = await fixture(t);
  const [first, joined] = await Promise.all([f.run(), f.run()]);
  assert.equal(first.data.state, "pending"); assert.equal(first.data.providerConfirmed, false);
  assert.equal(JSON.parse(db.openMailAction("one").source_json).confirmed, false, "older app recovery must also refuse replay after rollback");
  assert.equal(joined.data.receiptId, first.data.receiptId); assert.equal(joined.data.idempotentReplay, true);
  await actions.settleActions();
  const replay = await f.run("mail.archive", {}, REQUEST.toUpperCase());
  assert.equal(replay.data.state, "completed"); assert.equal(replay.data.providerConfirmed, true);
  assert.equal(f.effects.length, 1); assert.equal(f.effects[0].destination, "Archive");
  assert.ok(replay.data.undoOpId); assert.equal(db.readOp(replay.data.undoOpId).moves[0].folderPath, "INBOX");
  assert.ok(f.broadcasts.some(row => row.channel === "mail:actionsSettled" && row.data.opIds.includes(replay.data.undoOpId)));
  await assert.rejects(f.run("mail.trash"), { code: "INVALID_REQUEST" });
  await assert.rejects(f.run("mail.archive", { messageId: "two" }), { code: "INVALID_REQUEST" });
  actions.handle("mail:undoRemoval", { opIds: [replay.data.undoOpId] }); await actions.settleActions();
  assert.equal(db.messageById("one").folder_path, "INBOX");
  assert.equal(f.effects.length, 2);
});

test("read and unread are explicit provider writes, including a matching cached read state", async t => {
  const f = await fixture(t);
  for (const [n, isRead] of [[1, true], [2, true], [3, false]]) {
    const requestId = otherId(n);
    assert.equal((await f.run("mail.mark_read", { isRead }, requestId)).data.state, "pending");
    await actions.settleActions();
    assert.equal((await f.run("mail.mark_read", { isRead }, requestId)).data.state, "completed");
    assert.equal(db.messageById("one").unread, isRead ? 0 : 1);
  }
  assert.deepEqual(f.effects.map(row => row.kind), ["add", "add", "remove"]);
  f.control.missing = true;
  await f.run("mail.mark_read", { isRead: true }, otherId(4)); await actions.settleActions();
  const missing = (await f.run("mail.mark_read", { isRead: true }, otherId(4))).data;
  assert.equal(missing.state, "failed"); assert.equal(missing.providerConfirmed, false);
  assert.equal(f.effects.length, 3, "a missing IMAP UID cannot be reported as a confirmed STORE");
});

test("Trash never expunges, repeated Trash does not replace Undo and unsupported identities fail honestly", async t => {
  const f = await fixture(t);
  await f.run("mail.trash"); await actions.settleActions();
  const completed = (await f.run("mail.trash")).data;
  assert.equal(completed.state, "completed"); assert.equal(f.effects[0].destination, "Trash");
  const repeat = (await f.run("mail.trash", {}, otherId(1))).data;
  assert.equal(repeat.state, "failed"); assert.equal(repeat.providerConfirmed, false);
  assert.ok(db.readOp(completed.undoOpId).moves.length); assert.equal(f.effects.length, 1);
  for (const [id, extra] of [["local", { uid: 0, uidValidity: 0 }], ["draft", { uid: 5, folderPath: "Drafts" }]]) {
    f.add(id, "alpha", extra);
    const value = (await f.run("mail.archive", { messageId: id }, otherId(extra.uid + 2))).data;
    assert.equal(value.state, "failed"); assert.equal(value.providerConfirmed, false);
  }
});

test("cross-account IDs, ungranted/disconnected accounts and arbitrary inputs admit no writes", async t => {
  const f = await fixture(t);
  await assert.rejects(f.run("mail.trash", { messageId: "other" }), { code: "NOT_FOUND" });
  await assert.rejects(f.run("mail.archive", { accountId: "beta", messageId: "other" }), { code: "FORBIDDEN" });
  for (const params of [{ destination: "Trash" }, { permanent: true }, { threadId: "all" }, { messageId: ["one"] }, { accountId: 1 }]) {
    await assert.rejects(f.run("mail.trash", params), { code: "INVALID_REQUEST" });
  }
  for (const isRead of [undefined, "true", 1, null]) await assert.rejects(f.run("mail.mark_read", { isRead }), { code: "INVALID_REQUEST" });
  await assert.rejects(f.run("mail.trash", {}, "not-a-uuid"), { code: "INVALID_REQUEST" });
  db.removeAccount("alpha"); await assert.rejects(f.run(), { code: "NOT_FOUND" });
  assert.equal(fs.existsSync(storage.mailActionReceiptPath()), false); assert.equal(f.effects.length, 0);
});

for (const boundary of ["beforeSecret", "beforeConnect", "beforeLock"]) {
  test(`revoke during ${boundary} prevents the provider write and rolls back the optimistic projection`, async t => {
    const f = await fixture(t); f.control[boundary] = async () => { await tick(); f.control.live = false; };
    await f.run(); await actions.settleActions();
    assert.equal(f.effects.length, 0); assert.equal(db.messageById("one").folder_path, "INBOX");
    assert.equal(writes.recentForSettings()[0].state, "failed");
  });
}

test("an already-submitted change remains recorded after revocation", async t => {
  const f = await fixture(t); f.control.duringWrite = async () => { f.control.live = false; await tick(); };
  await f.run(); await actions.settleActions();
  assert.equal(f.effects.length, 1); assert.equal(writes.recentForSettings()[0].state, "completed");
  await assert.rejects(f.run(), { code: "UNAUTHENTICATED" });
});

test("provider refusal and uncertainty preserve independent outcomes and never resubmit a UUID", async t => {
  const f = await fixture(t);
  await f.run("mail.archive", { messageId: "one" }, otherId(1)); await actions.settleActions();
  f.control.reject = { before: false };
  await f.run("mail.trash", { messageId: "two" }, otherId(2)); await actions.settleActions();
  assert.equal((await f.run("mail.trash", { messageId: "two" }, otherId(2))).data.state, "unknown");
  assert.equal((await f.run("mail.archive", { messageId: "one" }, otherId(1))).data.state, "completed");
  assert.equal(f.effects.length, 1);
  await f.run("mail.trash", { messageId: "two" }, otherId(3)); await actions.settleActions();
  assert.equal((await f.run("mail.trash", { messageId: "two" }, otherId(3))).data.state, "failed");
});

test("receipt failures cannot authorize queued work, and corrupt stores fail closed", async t => {
  const f = await fixture(t), original = fs.renameSync;
  t.after(() => { fs.renameSync = original; });
  let commits = 0;
  fs.renameSync = (from, to) => {
    if (to === storage.mailActionReceiptPath() && ++commits === 2) throw Error("Synthetic binding persistence failure");
    return original(from, to);
  };
  await assert.rejects(f.run(), /Synthetic binding/);
  fs.renameSync = original; await actions.settleActions();
  assert.equal(f.effects.length, 0); assert.equal(db.messageById("one").folder_path, "INBOX");
  assert.equal((await f.run()).data.state, "unknown");
  fs.writeFileSync(storage.mailActionReceiptPath(), "not-json");
  assert.equal(writes.settingsStatus().available, false);
  await assert.rejects(f.run("mail.trash", { messageId: "two" }, otherId(2)), { code: "INTERNAL" });
  assert.equal(f.effects.length, 0);
});

test("grant rotation, listener stop, missing folders and later desktop changes cannot broaden an admitted request", async t => {
  const f = await fixture(t);
  f.control.beforeLock = async () => { f.control.revision = 2; };
  await f.run(); await actions.settleActions();
  assert.equal(f.effects.length, 0); assert.equal(writes.recentForSettings()[0].state, "failed");
  f.control.beforeLock = null; f.control.revision = 1;
  f.control.beforeConnect = async () => { listenerState.listening = false; };
  await f.run("mail.trash", { messageId: "two" }, otherId(1)); await actions.settleActions();
  assert.equal(f.effects.length, 0);
  listenerState.listening = true; f.control.beforeConnect = null;
  const folders = db.foldersFor("alpha").filter(row => row.well_known !== "deleteditems");
  db.replaceFolders("alpha", folders.map(row => ({ path: row.path, name: row.name, wellKnown: row.well_known })), "/");
  assert.equal((await f.run("mail.trash", {}, otherId(2))).data.state, "failed");
  await f.run("mail.mark_read", { isRead: true }, otherId(3));
  actions.handle("mail:markRead", { emailId: "one", isRead: false });
  await actions.settleActions();
  assert.equal((await f.run("mail.mark_read", { isRead: true }, otherId(3))).data.state, "superseded");
  assert.equal(db.messageById("one").unread, 1);
});

for (const publishing of [false, true]) {
  test(`restart retires ${publishing ? "publishing as unknown" : "accepted bot work without retry"}`, async t => {
    const f = await fixture(t); await f.run();
    const pending = db.openMailAction("one");
    if (publishing) db.updateMailAction(pending.id, { phase: "publishing" });
    actions.resume(); await actions.settleActions();
    assert.equal(f.effects.length, 0);
    assert.equal((await f.run()).data.state, publishing ? "unknown" : "not_attempted");
    if (!publishing) assert.equal(db.messageById("one").folder_path, "INBOX");
  });
}

test("real HTTP dispatch uses catalog scopes and stable request IDs with mocked authentication", async t => {
  const f = await fixture(t), server = require("../host/bot/server");
  t.after(() => server.stop());
  assert.equal((await server.start()).listening, true);
  const invoke = async (operation, params, requestId = REQUEST) => {
    const response = await fetch("http://127.0.0.1:47831/api/bot/v1/call", { method: "POST",
      headers: { authorization: "Bearer synthetic-only", "content-type": "application/json", accept: "application/json",
        "Tailscale-App-Capabilities": catalog.markerJson() },
      body: JSON.stringify({ apiVersion: "1.0", installationId: f.grant.installationId, requestId, operation, params }) });
    return response.json();
  };
  const params = { accountId: "alpha", messageId: "one", isRead: true };
  assert.equal((await invoke("mail.mark_read", params)).data.state, "pending");
  await actions.settleActions(); assert.equal((await invoke("mail.mark_read", params)).data.state, "completed");
  assert.equal(f.effects.length, 1);
  f.grant.capabilities = catalog.DEFAULT_CAPABILITIES.slice();
  const denied = await invoke("mail.trash", { accountId: "alpha", messageId: "two" }, otherId(1));
  assert.equal(denied.ok, false); assert.equal(denied.error.code, "FORBIDDEN");
});

test("Gmail checks the grant after asynchronous token reads at the actual write boundary", async () => {
  const { createGmailMailApi } = require("../host/mail/gmail-mail-api");
  for (const method of ["archive", "markRead", "trash"]) {
    let live = true, mutations = 0;
    const api = createGmailMailApi({ accessToken: async () => { await tick(); live = false; return "synthetic-only"; },
      fetchImpl: async (_url, options) => { if (options.method !== "GET") mutations++; return new Response(JSON.stringify({ id: "one", labelIds: ["INBOX"] })); } });
    const options = { beforeSubmit: () => { if (!live) throw Object.assign(Error("Revoked"), { operationIssued: false }); } };
    const work = method === "markRead" ? api.markRead("one", true, options) : api[method]("one", options);
    await assert.rejects(work, error => error.operationIssued === false);
    assert.equal(mutations, 0);
  }
});

async function gmailFixture(t) {
  const f = await fixture(t), { server, message } = require("./gmail-fixture");
  db.insertAccount({ id: "gmail", email: "gmail@example.test", username: "gmail@example.test", profile: "gmail", authKind: "oauth2",
    imapHost: "imap.gmail.com", imapPort: 993, imapTls: true, smtpHost: "smtp.gmail.com", smtpPort: 465, smtpTls: true, createdAt: 100 });
  db.enableGmail("gmail");
  const provider = server([message("gmail-one", ["INBOX", "UNREAD", "Label_work"]), message("gmail-two", ["INBOX", "Label_work"])]);
  const session = require("../host/mail/gmail-session").createSession(db.accountById("gmail"), "synthetic-only", { api: provider.api() });
  const folders = await session.folders(); db.replaceFolders("gmail", folders.folders, "/"); await session.sync("INBOX");
  f.grant.accountIds = ["gmail"];
  remote.withClient = async (_account, _secret, work) => work({ gmail: session });
  const id = providerId => db.gmailCopies("gmail", providerId).find(row => row.folder_path === "INBOX").id;
  return { ...f, provider, session, id };
}

test("Gmail bridge writes use real label/Trash adapters, preserve labels and never call permanent deletion", async t => {
  const f = await gmailFixture(t), one = f.id("gmail-one"), two = f.id("gmail-two");
  const params = id => ({ accountId: "gmail", messageId: id });
  await f.run("mail.archive", params(one)); await actions.settleActions();
  assert.equal((await f.run("mail.archive", params(one))).data.state, "completed");
  assert.ok(!f.provider.messages.get("gmail-one").labelIds.includes("INBOX"));
  assert.ok(f.provider.messages.get("gmail-one").labelIds.includes("Label_work"));
  await f.run("mail.trash", params(two), otherId(1)); await actions.settleActions();
  const receipt = (await f.run("mail.trash", params(two), otherId(1))).data;
  assert.equal(receipt.state, "completed"); assert.ok(receipt.undoOpId);
  assert.ok(f.provider.messages.get("gmail-two").labelIds.includes("TRASH"));
  assert.ok(f.provider.calls.some(row => row.route.endsWith("/trash") && row.method === "POST"));
  assert.ok(!f.provider.calls.some(row => row.method === "DELETE" || /\/delete$/.test(row.route)));
  const before = f.provider.calls.filter(row => row.method !== "GET").length;
  await f.run("mail.trash", params(two), otherId(1));
  assert.equal(f.provider.calls.filter(row => row.method !== "GET").length, before);
});

test("ambiguous legacy Gmail identities do not mutate any guessed message", async t => {
  const f = await gmailFixture(t);
  f.provider.messages.get("gmail-one").payload.headers.find(row => row.name === "Message-ID").value = "<ambiguous@example.test>";
  f.provider.messages.get("gmail-two").payload.headers.find(row => row.name === "Message-ID").value = "<ambiguous@example.test>";
  db.insertMessage({ id: "legacy", accountId: "gmail", folderPath: "INBOX", uid: 999, uidValidity: 7,
    rfcMessageId: "<ambiguous@example.test>", date: "2026-11-02T10:00:00.000Z", listSortTs: 1793613600000 });
  await f.run("mail.trash", { accountId: "gmail", messageId: "legacy" }); await actions.settleActions();
  assert.equal((await f.run("mail.trash", { accountId: "gmail", messageId: "legacy" })).data.state, "failed");
  assert.equal(f.provider.calls.filter(row => row.method !== "GET").length, 0);
});

test("update preparation retires queued bot changes and waits for admitted provider work", async t => {
  const f = await fixture(t), { gate } = require("../host/update-quiescence");
  t.after(() => gate.resume());
  await f.run(); await gate.prepare({ timeoutMs: 100 }); await actions.settleActions();
  assert.equal((await f.run()).data.state, "not_attempted"); assert.equal(f.effects.length, 0);
  gate.resume();
  let release, entered;
  const atProvider = new Promise(resolve => { entered = resolve; });
  const paused = new Promise(resolve => { release = resolve; }); t.after(() => release());
  f.control.duringWrite = async () => { entered(); await paused; };
  await f.run("mail.trash", { messageId: "two" }, otherId(2)); await atProvider;
  await assert.rejects(gate.prepare({ timeoutMs: 25 }), /operations are still running/);
  release(); await actions.settleActions();
  assert.equal((await f.run("mail.trash", { messageId: "two" }, otherId(2))).data.state, "completed");
});
