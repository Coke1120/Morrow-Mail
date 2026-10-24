// Offline regressions: real UID helpers, engine/SQLite, and renderer form logic.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

function fakeClient(validity = 100) {
  const calls = [];
  return {
    validity, calls, mailbox: { uidValidity: 100 }, locked: false,
    async getMailboxLock(folder) {
      this.mailbox = { uidValidity: BigInt(this.validity), path: folder };
      this.locked = true;
      return { release: () => { this.locked = false; } };
    },
    async messageFlagsAdd(uid, flags) { assert(this.locked); calls.push(["add", uid, flags]); },
    async messageFlagsRemove(uid, flags) { assert(this.locked); calls.push(["remove", uid, flags]); },
    async messageDelete(uid) { assert(this.locked); calls.push(["delete", uid]); },
    async messageMove(uid, dest) { assert(this.locked); calls.push(["move", uid, dest]); return { uidValidity: this.mailbox.uidValidity, uidMap: new Map([[Number(uid), 84]]) }; },
    async status() { return { uidValidity: 300n }; },
  };
}

async function uidHelpers(remote) {
  const client = fakeClient(200);
  const operations = [
    expected => remote.changeFlags(client, "INBOX", 42, ["\\Seen"], [], expected),
    expected => remote.changeFlags(client, "INBOX", 42, [], ["\\Flagged"], expected),
    expected => remote.removeUid(client, "INBOX", 42, expected),
    expected => remote.moveUid(client, "INBOX", 42, "Archive", expected),
  ];
  for (const operation of operations) {
    for (const expected of [100, 0, undefined]) {
      await assert.rejects(() => operation(expected), error => error.code === "uid_validity_changed" && error.operationIssued === false && /Sync the folder/.test(error.message));
      assert.equal(client.locked, false, "failed checks release the selection lock");
    }
  }
  assert.deepEqual(client.calls, [], "a UID reused after mailbox recreation must never be written");
  for (const operation of operations) await operation(200);
  assert.deepEqual(client.calls.map(call => call[0]), ["add", "remove", "delete", "move"]);
}

const account = id => ({ id, email: id + "@example.test", username: id, profile: "custom", createdAt: Date.now(),
  imapHost: "imap.example.test", imapPort: 993, imapTls: true, smtpHost: "smtp.example.test", smtpPort: 587, smtpTls: true });
const folders = [
  {path: "INBOX", name: "Inbox", wellKnown: "inbox"}, {path: "Trash", name: "Trash", wellKnown: "deleteditems"},
  {path: "Archive", name: "Archive", wellKnown: "archive"}, {path: "Drafts", name: "Drafts", wellKnown: "drafts"},
];
const message = (id, extra = {}) => ({ id, accountId: "uid-review", folderPath: "INBOX", uid: 42, uidValidity: 100,
  threadId: id, subject: "Synthetic " + id, date: new Date().toISOString(), listSortTs: Date.now(), unread: true, ...extra });

async function uidActions(engine, db, remote, secrets) {
  db.insertAccount(account("uid-review"));
  db.replaceFolders("uid-review", folders);
  secrets.setPassword("uid-review", "synthetic-only");
  const client = fakeClient(200);
  remote.withClient = async (_a, _s, work) => work(client);
  const operations = [
    ["mail:markRead", {isRead: true}], ["mail:toggleStar", {isStarred: true}],
    ["mail:moveToFolder", {targetFolderId: "Archive"}], ["mail:delete", {}],
    ["mail:deleteBatch", {folderWellKnownName: "deleteditems"}],
  ];
  for (const [index, [channel, extra]] of operations.entries()) {
    const id = "uid-review-" + index;
    const folder = channel === "mail:deleteBatch" ? "Trash" : "INBOX";
    db.insertMessage(message(id, {folderPath: folder}));
    const accepted = await engine.answer(channel, [{emailId: id, items: [{emailId: id}], ...extra}]);
    assert.equal(accepted.success, true);
    const result = await engine.settleActions();
    const outcome = result.outcomes.find(row => row.id === id);
    assert.equal(outcome.status, "failed", "known pre-write rejection must roll back, not become unknown");
    assert.match(outcome.error, /Sync the folder/);
    const restored = db.messageById(id);
    assert.equal(restored.folder_path, folder);
    assert.equal(restored.unread, 1);
    assert.equal(restored.starred, 0);
  }
  assert.deepEqual(client.calls, []);

  // Successful move creates an Undo receipt; its destination identity is guarded too.
  client.validity = 100;
  db.insertMessage(message("uid-undo"));
  await engine.answer("mail:moveToFolder", [{emailId: "uid-undo", targetFolderId: "Archive"}]);
  const moved = await engine.settleActions();
  const opId = moved.outcomes.find(row => row.id === "uid-undo").opId;
  assert(opId);
  client.calls.length = 0;
  client.validity = 200;
  await engine.answer("mail:undoRemoval", [{opIds: [opId]}]);
  assert.equal((await engine.settleActions()).outcomes.find(row => row.id === "uid-undo").status, "failed");
  assert.equal(db.messageById("uid-undo").folder_path, "Archive");
  assert.deepEqual(client.calls, []);

  db.insertMessage(message("uid-draft", {folderPath: "Drafts", isDraft: true}));
  const discarded = await engine.answer("mail:deleteDraft", [{emailId: "uid-draft"}]);
  assert.equal(discarded.success, false);
  assert.equal(discarded.error.code, "uid_validity_changed");
  assert(db.messageById("uid-draft"), "refused discard keeps the local draft");
  let appended = 0;
  remote.appendRaw = async () => { appended++; };
  const saved = await engine.answer("mail:upsertDraft", [{accountId: "uid-review", emailId: "uid-draft", subject: "Preserve my text", body: "<p>New draft</p>"}]);
  assert.equal(saved.data.remoteSaved, false);
  assert.match(saved.data.warning, /Sync the folder/);
  assert.equal(db.messageById("uid-draft").subject, "Preserve my text");
  assert.equal(appended, 0, "stale replacement cannot continue into APPEND");
  assert.deepEqual(client.calls, []);
  const rules = require("../host/mail/inbox-rules");
  for (const action of [{markRead: true}, {moveToId: "Archive"}]) {
    const ruled = await rules.runImapPlan({account: db.accountById("uid-review"), folder: db.folderByPath("uid-review", "INBOX"),
      rules: [{id: "stale-rule", enabled: true, match: {subject: "Fixture"}, actions: action}],
      messages: [{uid: 42, subject: "Fixture"}], client, remote, db, validity: 100});
    assert.equal(ruled.failed, 1, "local rules pass their observed source validity to the guarded write");
  }
  assert.deepEqual(client.calls, []);
  db.removeAccount("uid-review");
}

async function flagSync(engine, db, remote, secrets) {
  const id = "flag-review";
  db.insertAccount(account(id));
  secrets.setPassword(id, "synthetic-only");
  db.replaceFolders(id, [folders[0]]);
  const uids = Array.from({length: 450}, (_, i) => i + 1);
  db.applyFolderSync(id, "INBOX", {validity: 100, exists: 450, uids, uidCursor: 450, windowDone: true, horizonDays: 0,
    messages: uids.map(uid => ({uid, id: "flag-" + uid, threadId: "flag-" + uid, subject: "Fixture", date: new Date().toISOString(),
      listSortTs: Date.now(), unread: uid % 2 === 0, starred: false, bodyComplete: true}))});
  const server = new Map(uids.map(uid => [uid, {unread: uid % 2 === 0, starred: false}]));
  server.set(450, {unread: false, starred: true});
  server.set(300, {unread: false, starred: true});
  server.set(1, {unread: true, starred: true});
  const client = fakeClient(100);
  const pages = [];
  client.search = async criteria => criteria.uid ? [] : uids;
  client.fetch = async function* (range, fields, options) {
    assert.deepEqual(fields, {uid: true, flags: true}, "reconciliation never fetches bodies/envelopes");
    assert.deepEqual(options, {uid: true});
    const picked = range.split(",").map(Number);
    assert(picked.length <= 200);
    pages.push(picked);
    for (const uid of picked) {
      const flags = server.get(uid);
      yield {uid, flags: new Set([...(flags.unread ? [] : ["\\Seen"]), ...(flags.starred ? ["\\Flagged"] : [])])};
    }
    yield {uid: 999, flags: new Set(["\\Flagged"])}; // unsolicited FETCH is not this page
  };
  remote.withClient = async (_a, _s, work) => work(client);
  remote.listFolderRecords = async () => ({folders: [folders[0]], delimiter: "/"});
  remote.fetchMessages = async () => { throw new Error("No new messages; body fetch forbidden"); };
  for (let i = 0; i < 3; i++) await engine.syncAccountById(id, {background: i !== 0});
  assert.deepEqual(pages.map(page => page.length), [200, 200, 50]);
  assert.equal(new Set(pages.flat()).size, 450, "bounded pages must reach older messages");
  for (const uid of [450, 300, 1]) {
    assert.equal(db.messageById("flag-" + uid).unread, server.get(uid).unread ? 1 : 0);
    assert.equal(db.messageById("flag-" + uid).starred, 1);
  }
  assert.equal(db.folderByPath(id, "INBOX").unread, 224);
  assert.equal(engine.answer("mail:listFromCache", [{accountId: id, folderId: engine.STARRED_FOLDER_ID}]).data.total, 3);
  assert.equal(engine.answer("mail:listFromCache", [{accountId: id, folderId: engine.UNREAD_FOLDER_ID}]).data.total, 224);
  assert.equal(db.messageByUid(id, "INBOX", 999, 100), null);
  let bytes = 0;
  const write = fs.writeSync;
  fs.writeSync = function (...args) { const n = write.apply(this, args); bytes += n; return n; };
  try { await engine.syncAccountById(id, {background: true}); } finally { fs.writeSync = write; }
  assert.equal(pages[3][0], 450, "cursor wraps after the oldest page");
  assert.equal(bytes, 0, "unchanged flag pages must not dirty journals/checkpoints");

  const hold = (actionId, kind, phase, receipt, generation = 1) => db.insertMailAction({id: actionId, batchId: actionId,
    messageId: "flag-450", accountId: id, generation, intentJson: JSON.stringify({kind}), priorJson: "{}", sourceJson: "{}", phase, receipt, createdAt: Date.now()});
  const apply = () => db.applyFolderSync(id, "INBOX", {messages: [], validity: 100, flags: [{uid: 450, unread: false, starred: false}]});
  db.updateMessage("flag-450", {unread: 1, starred: 1});
  hold("pending-read", "read", "accepted");
  apply();
  assert.equal(db.messageById("flag-450").unread, 1);
  assert.equal(db.messageById("flag-450").starred, 0, "pending read protects only read, not independent star");
  db.updateMailAction("pending-read", {phase: "closed", receipt: "completed"});
  db.updateMessage("flag-450", {starred: 1});
  hold("unknown-star", "star", "closed", "unknown");
  apply();
  assert.equal(db.messageById("flag-450").unread, 0);
  assert.equal(db.messageById("flag-450").starred, 1);
  hold("completed-star", "star", "closed", "completed", 2);
  apply();
  assert.equal(db.messageById("flag-450").starred, 0, "newer completed intent releases an older unknown projection");
  db.updateMessage("flag-450", {unread: 1, starred: 1});
  hold("pending-move", "remove", "accepted");
  apply();
  assert.equal(db.messageById("flag-450").starred, 1);
  db.updateMailAction("pending-move", {phase: "closed", receipt: "failed"});
  const beforeReset = pages.length;
  client.validity = 200;
  await engine.syncAccountById(id, {background: true});
  assert.equal(pages.length, beforeReset, "a changed validity must not fetch/apply flags for old UIDs");
  assert.equal(db.folderByPath(id, "INBOX").window_done, 0);
  assert.equal(db.countInFolder(id, "INBOX"), 0);
  db.removeAccount(id);
}

async function discoveryForm() {
  const source = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
  const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const elements = Object.fromEntries(["profile", "email", "username", "password", "imap-host", "imap-port", "imap-tls", "smtp-host", "smtp-port", "smtp-tls", "custom-fields", "password-hint", "connect-title", "connect-recovery-note"].map(id => [id, {value: "", checked: true}]));
  elements.profile.options = ["custom", "gmail", "yahoo"].map(value => ({value}));
  const calls = [], statuses = [];
  let pendingDiscovery;
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({$: id => elements[id], state: {connectPending: false, oauthPending: false},
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
    openDialog() {}, closeDialog() {}, paintConnectPending() {}, setConnectStatus: text => statuses.push(text),
    showStatus() {}, loadAccounts: async () => {},
    call(channel) { calls.push(channel); return new Promise(resolve => { pendingDiscovery = resolve; }); },
  });
  vm.runInContext(between("let discoverGen =", "function connectButton(") + between("function connectPayload(", "function setConnectStatus(") +
    between("async function connectImap(", "async function connectOAuth(") + between("function openConnectFor(", "function brainSections("), context);
  const run = code => vm.runInContext(code, context);
  const full = name => ({source: "autoconfig", imap: {host: "imap." + name, port: 993, tls: true}, smtp: {host: "smtp." + name, port: 465, tls: true}});
  context.first = full("first.test"); context.second = full("second.test");
  elements.email.value = "user@first.test";
  run("prepareDiscoveryAddress();applyDiscovery(first)");
  elements.email.value = "user@second.test";
  run("prepareDiscoveryAddress();applyDiscovery({source:'srv',imap:second.imap,smtp:null})");
  assert.equal(elements["smtp-host"].value, "", "IMAP-only discovery cannot retain old SMTP");
  assert.equal(run("connectPayload().custom.imap.host"), "imap.second.test");
  elements.email.value = "user@third.test";
  run("scheduleDiscover()");
  assert.equal(elements["imap-host"].value, "", "clear stale endpoints before any delayed/no-result lookup");
  run("applyDiscovery({source:'srv',imap:null,smtp:second.smtp})");
  assert.equal(elements["imap-host"].value, "");

  run("customEndpointEdits.add('imap')");
  elements["imap-host"].value = "imap.manual.test";
  elements["imap-port"].value = "143";
  elements["imap-tls"].checked = false;
  elements.email.value = "user@fourth.test";
  run("prepareDiscoveryAddress();applyDiscovery(second)");
  assert.equal(elements["imap-host"].value, "imap.manual.test");
  assert.equal(elements["imap-port"].value, "143");
  assert.equal(elements["imap-tls"].checked, false);
  assert.equal(elements["smtp-host"].value, "smtp.second.test");
  run("customEndpointEdits.add('smtp');applyDiscovery(first)");
  assert.equal(elements["smtp-host"].value, "smtp.second.test", "two manual endpoints opt out of discovery");
  run("openConnectFor(null)");
  assert.equal(elements["imap-host"].value, "");
  assert.equal(elements["smtp-host"].value, "");

  // An old lookup must not populate a reopened dialog, even for the same address.
  elements.email.value = "user@first.test";
  run("scheduleDiscover()");
  const timer = [...timers.values()].pop(); timer();
  const oldReply = pendingDiscovery;
  run("openConnectFor(null)");
  elements.email.value = "user@first.test";
  oldReply(context.first);
  await Promise.resolve();
  assert.equal(elements["imap-host"].value, "");
  const connect = run("connectImap()");
  elements.email.value = "changed@second.test";
  pendingDiscovery(context.first);
  await connect;
  assert(!calls.includes("mail:connectImapSmtp"), "editing the address during discovery cancels submission");
  assert(statuses.some(text => /address changed/.test(text)));
  context.existing = {id: "saved", email: "saved@example.test", imapSmtpProfile: "custom", imapSmtpCustom: full("saved.test")};
  run("openConnectFor(existing);applyDiscovery(first)");
  assert.equal(elements["smtp-host"].value, "smtp.saved.test", "explicit saved custom endpoints survive reconnect");
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-review-fixes-"));
  const keys = ["MORROW_MAIL_DIR", "MORROW_USER_DATA", "MORROW_AI_CONFIG_DIR", "MORROW_MAIL_SECRETS"];
  const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {MORROW_MAIL_DIR: dir, MORROW_USER_DATA: dir, MORROW_AI_CONFIG_DIR: dir, MORROW_MAIL_SECRETS: "memory"});
  const engine = require("../host/mail/engine"), db = require("../host/mail/db"), remote = require("../host/mail/remote"), secrets = require("../host/mail/secrets");
  const saved = Object.fromEntries(["withClient", "listFolderRecords", "fetchMessages", "appendRaw"].map(key => [key, remote[key]]));
  try {
    await uidHelpers(remote);
    await engine.init();
    await uidActions(engine, db, remote, secrets);
    await flagSync(engine, db, remote, secrets);
    await discoveryForm();
  } finally {
    Object.assign(remote, saved);
    for (const id of ["uid-review", "flag-review"]) secrets.deletePassword(id);
    await db.close();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, {recursive: true, force: true});
  }
  console.log("mail-review-regressions-ok (UID validity, rotating flags, discovery ownership)");
}
module.exports = {run};
if (require.main === module) run().then(() => process.exit(0), error => {console.error(error); process.exit(1);});
