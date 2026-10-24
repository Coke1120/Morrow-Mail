// Synthetic transports, real temporary SQLite, and separate restart processes.
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const envKeys = ["MORROW_USER_DATA", "MORROW_MAIL_DIR", "MORROW_AI_CONFIG_DIR", "MORROW_MAIL_SECRETS"];
function configure(dir) { fs.mkdirSync(dir, { recursive: true }); Object.assign(process.env,
  { MORROW_USER_DATA: dir, MORROW_MAIL_DIR: dir, MORROW_AI_CONFIG_DIR: dir, MORROW_MAIL_SECRETS: "memory" }); }
function modules() { return { engine: require("../host/mail/engine"), db: require("../host/mail/db"), remote: require("../host/mail/remote"), secrets: require("../host/mail/secrets"), mailer: require("nodemailer") }; }
function seed(db, secrets, id) {
  db.insertAccount({ id, email: id + "@example.test", username: id, profile: "custom", createdAt: Date.now(),
    imapHost: "imap.example.test", imapPort: 993, imapTls: true, smtpHost: "smtp.example.test", smtpPort: 587, smtpTls: true });
  secrets.setPassword(id, "synthetic-only");
  db.replaceFolders(id, [{ path: "Drafts", name: "Drafts", wellKnown: "drafts" }, { path: "Sent", name: "Sent", wellKnown: "sentitems" }]);
}
const fields = { to: ['Accepted <ok@example.test>', '"Family, Example" <bad@example.test>'], cc: ['ccbad@example.test'],
  bcc: ['secretok@example.test', 'secretbad@example.test'], subject: "Partial fixture", body: "<p>Preserve complete body</p>" };
const accepted = ["ok@example.test", "secretok@example.test"], rejected = ["bad@example.test", "ccbad@example.test", "secretbad@example.test"];
function fakeInfo(options) { return { messageId: options.messageId, accepted, rejected,
  rejectedErrors: rejected.map(recipient => ({ recipient, responseCode: 550 })) }; }
function assertRejectedDraft(db, id) {
  const draft = db.messageById(id);
  assert.deepEqual(JSON.parse(draft.to_json), ["bad@example.test"]);
  assert.deepEqual(JSON.parse(draft.cc_json), ["ccbad@example.test"]);
  assert.deepEqual(JSON.parse(draft.bcc_json), ["secretbad@example.test"]);
  assert.equal(draft.html_body, fields.body);
  return draft;
}

async function draftChecks(engine, db) {
  const when = Date.now();
  const local = (id, rfc) => ({ id, accountId: "partial-tests", folderPath: "Drafts", uid: 0, uidValidity: 0,
    rfcMessageId: rfc, subject: "Meeting", to: [id + "@example.test"], date: new Date(when).toISOString(), listSortTs: when,
    isDraft: true, htmlBody: "<p>Local " + id + "</p>", textBody: "Local " + id, bodyComplete: true });
  db.insertMessage(local("independent", "<local@example.test>"));
  const before = db.messageById("independent");
  const server = { uid: 42, threadId: "server-thread", rfcMessageId: "<server@example.test>", subject: "Meeting", to: ["other@example.test"],
    date: new Date(when + 1000).toISOString(), listSortTs: when + 1000, isDraft: true, textBody: "Other server text", bodyComplete: true };
  for (let repeat = 0; repeat < 2; repeat++) {
    db.applyFolderSync("partial-tests", "Drafts", { messages: [server], validity: 100, uids: [42] });
    assert.deepEqual(db.messageById("independent"), before);
    assert.equal(db.countInFolder("partial-tests", "Drafts"), 2);
  }
  db.insertMessage(local("no-id", null));
  db.applyFolderSync("partial-tests", "Drafts", { messages: [{ ...server, uid: 43, rfcMessageId: null }], validity: 100, keepOthers: true });
  assert.equal(db.messageById("no-id").uid, 0);
  db.insertMessage(local("confirmed", "<confirmed@example.test>"));
  db.applyFolderSync("partial-tests", "Drafts", { messages: [{ ...server, uid: 44, rfcMessageId: "<confirmed@example.test>" }], validity: 100, keepOthers: true });
  assert.equal(db.messageById("confirmed").uid, 44, "a unique confirmed RFC identity still adopts the local row");
  for (const id of ["ambiguous-a", "ambiguous-b"]) db.insertMessage(local(id, "<ambiguous@example.test>"));
  db.applyFolderSync("partial-tests", "Drafts", { messages: [{ ...server, uid: 45, rfcMessageId: "<ambiguous@example.test>" }], validity: 100, keepOthers: true });
  assert.equal(db.messageById("ambiguous-a").uid, 0); assert.equal(db.messageById("ambiguous-b").uid, 0);
  await db.close(); await engine.init(); assert.deepEqual(db.messageById("independent"), before);
  db.applyFolderSync("partial-tests", "Drafts", { messages: [{ ...server, uid: 52 }], validity: 200 });
  assert.deepEqual(db.messageById("independent"), before, "a reset and later reconciliation both retain the conflicting local copy");
}

async function deliveryChecks(engine, db, remote, mailer) {
  const saved = { create: mailer.createTransport, withClient: remote.withClient, appendRaw: remote.appendRaw, insert: db.insertScheduled, accept: db.acceptScheduled };
  let calls = 0, partial = true;
  const envelopes = [];
  const fake = () => ({ async sendMail(options) { calls++; envelopes.push(options); return partial ? fakeInfo(options) : { messageId: options.messageId, accepted: rejected, rejected: [] }; }, close() {} });
  mailer.createTransport = fake; assert.equal(mailer.createTransport, fake, "never run this test with a real transport");
  remote.withClient = async (_a, _p, work) => work({}); remote.appendRaw = async () => ({ uid: 80 + calls, uidValidity: 100 });
  try {
    const attachment = engine.answer("mail:uploadAttachment", [{ filename: "notes.txt", fileBytes: Buffer.from("Keep recovery bytes") }]).data;
    const sendFields = { ...fields, attachments: [attachment], accountId: "partial-tests" };
    const direct = await engine.answer("mail:send", [sendFields]);
    assert.equal(direct.success, true); assert.equal(direct.data.partial, true); assert.equal(direct.data.recoverySaved, true);
    assert.match(direct.data.warning, /bad@example.test \(550\)/);
    assert.equal(db.scheduledById(direct.data.recoveryId).status, "partial");
    const scheduled = engine.answer("mail:scheduleSend", [{ ...sendFields, sendAt: "2099-01-01T08:00:00Z" }]);
    db.setScheduledSendAt(scheduled.data.id, 0); await engine.pumpScheduled();
    assert.equal(db.scheduledById(scheduled.data.id).status, "partial");
    assert.equal(calls, 2); await engine.pumpScheduled(); await engine.pumpScheduled(); assert.equal(calls, 2);
    await db.close(); await engine.init(); await engine.pumpScheduled(); assert.equal(calls, 2);
    for (const id of [direct.data.recoveryId, scheduled.data.id]) {
      const shown = engine.answer("mail:listScheduled", [{}]).data.find(row => row.id === id);
      assert.deepEqual(shown.acceptedRecipients, accepted); assert.deepEqual(shown.rejectedRecipients, rejected);
      const dismissed = engine.answer("mail:cancelScheduled", [{ id }]);
      assert.equal(dismissed.data.snapshot.status, "partial");
      assert.equal(engine.answer("mail:restoreScheduled", [{ snapshot: dismissed.data.snapshot }]).data.status, "partial");
      db.setScheduledSendAt(id, 0); db.markScheduledFailed(id, "must not downgrade partial acceptance");
      await engine.pumpScheduled(); assert.equal(calls, 2);
      assert.equal(engine.answer("mail:editScheduled", [{ id }]).error.code, "delivery_review");
      const recovered = engine.answer("mail:editScheduled", [{ id, acknowledgeDelivery: true }]);
      assert.equal(recovered.success, true); const draft = assertRejectedDraft(db, recovered.data.emailId);
      const files = JSON.parse(draft.attachments_json);
      assert.equal((await engine.bytesFor({ emailId: draft.id, attachmentId: files[0].id })).data.toString(), "Keep recovery bytes");
      assert.equal(engine.answer("mail:editScheduled", [{ id, acknowledgeDelivery: true }]).success, false);
    }
    // An explicit new send from a recovered copy excludes every accepted address.
    partial = false;
    const retried = await engine.answer("mail:send", [{ accountId: "partial-tests", to: [rejected[0]], cc: [rejected[1]], bcc: [rejected[2]], body: fields.body }]);
    assert.equal(retried.success, true); assert(!retried.data.partial);
    const last = envelopes.at(-1);
    assert.deepEqual(last.to, [rejected[0]]); assert.deepEqual(last.cc, [rejected[1]]); assert.deepEqual(last.bcc, [rejected[2]]);
    partial = true;
    db.insertMessage({ id: "unsaved-receipt-draft", accountId: "partial-tests", folderPath: "Drafts", uid: 0, uidValidity: 0,
      isDraft: true, date: new Date().toISOString(), listSortTs: Date.now(), textBody: "Keep original" });
    db.insertScheduled = row => { if (row.status === "partial") throw new Error("Synthetic receipt storage failure"); return saved.insert(row); };
    const unstored = await engine.answer("mail:send", [{ ...sendFields, draftId: "unsaved-receipt-draft" }]);
    assert.equal(unstored.data.partial, true); assert.equal(unstored.data.recoverySaved, false);
    assert.match(unstored.data.warning, /could not be saved/); assert(db.messageById("unsaved-receipt-draft"));
    db.insertScheduled = saved.insert;
    const retryStore = engine.answer("mail:scheduleSend", [{ ...sendFields, sendAt: "2099-01-01T08:00:00Z" }]);
    db.setScheduledSendAt(retryStore.data.id, 0);
    db.acceptScheduled = () => { throw new Error("Synthetic acceptance commit failure"); };
    await engine.pumpScheduled(); db.acceptScheduled = saved.accept;
    assert.equal(db.scheduledById(retryStore.data.id).status, "partial", "fallback preserves the known partial receipt without another submission");
    const sentCount = calls; await db.close(); await engine.init(); await engine.pumpScheduled(); assert.equal(calls, sentCount);
    db.insertScheduled({ id: "invalid-receipt", accountId: "partial-tests", payloadJson: JSON.stringify(fields), sendAt: 0, createdAt: 1, status: "partial", receiptJson: "invalid" });
    const empty = engine.answer("mail:editScheduled", [{ id: "invalid-receipt", acknowledgeDelivery: true }]);
    const emptyDraft = db.messageById(empty.data.emailId);
    for (const field of ["to_json", "cc_json", "bcc_json"]) assert.deepEqual(JSON.parse(emptyDraft[field]), []);
    assert.match(empty.data.warning, /could not be safely matched/);
  } finally { mailer.createTransport = saved.create; remote.withClient = saved.withClient; remote.appendRaw = saved.appendRaw; db.insertScheduled = saved.insert; db.acceptScheduled = saved.accept; }
}

async function crashPhase(mode, dir, kind) {
  configure(dir); const { engine, db, remote, secrets, mailer } = modules(); await engine.init();
  if (mode === "crash") seed(db, secrets, "crash-partial"); else secrets.setPassword("crash-partial", "synthetic-only");
  let sends = 0;
  const fake = () => ({ async sendMail(options) { sends++; return fakeInfo(options); }, close() {} });
  mailer.createTransport = fake; assert.equal(mailer.createTransport, fake);
  remote.withClient = async (_a, _p, work) => work({});
  remote.appendRaw = async () => {
    if (mode === "crash") {
      const row = db.listScheduled().find(row => row.status === "partial"); assert(row); assert.deepEqual(JSON.parse(row.receipt_json).rejected, rejected);
      fs.writeFileSync(path.join(dir, "record-id"), row.id); process.exit(19);
    }
    return { uid: 9, uidValidity: 100 };
  };
  if (mode === "crash") {
    if (kind === "direct") await engine.answer("mail:send", [{ ...fields, accountId: "crash-partial" }]);
    else { db.insertScheduled({ id: "crash-queue", accountId: "crash-partial", payloadJson: JSON.stringify(fields), sendAt: 0, createdAt: 1 }); await engine.pumpScheduled(); }
    throw new Error("Crash point not reached");
  }
  const id = fs.readFileSync(path.join(dir, "record-id"), "utf8");
  assert.equal(db.scheduledById(id).status, "partial"); await engine.pumpScheduled(); await engine.pumpScheduled(); assert.equal(sends, 0);
  const recovered = engine.answer("mail:editScheduled", [{ id, acknowledgeDelivery: true }]);
  assertRejectedDraft(db, recovered.data.emailId); await db.close();
}

async function uiChecks() {
  const source = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
  const start = source.indexOf("async function deliverMail("), end = source.indexOf("\n// The local delay", start);
  const status = [], nodes = { "compose-title": {} }; let calls = 0, closes = 0;
  const context = vm.createContext({ state: { composeQueued: false }, $: id => nodes[id] || (nodes[id] = {}), syncCompose() {},
    setComposeStatus: message => status.push(message), showStatus() {}, call: async () => { calls++; return { partial: true, warning: "Partly sent: bad@example.test rejected (550)" }; },
    composeSnapshot: () => "receipt", closeDialog: async () => { closes++; }, loadScheduled: async () => {}, isComposeWindow: () => false,
    composeAccount: () => ({ id: "a" }), isLive: () => true });
  vm.runInContext(source.slice(start, end), context);
  await vm.runInContext("deliverMail({})", context);
  assert.equal(closes, 0); assert.equal(context.state.composeQueued, true); assert.equal(context.state.composePartialReceipt, true);
  assert.match(status.at(-1), /bad@example.test.*550/);
  const sendStart = source.indexOf("async function sendMail("), sendEnd = source.indexOf("\nasync function removeAccount", sendStart);
  vm.runInContext(source.slice(sendStart, sendEnd), context); await vm.runInContext("sendMail()", context); assert.equal(calls, 1, "the partial receipt cannot submit the original recipients again");
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-draft-partial-")), env = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  configure(path.join(root, "main")); const { engine, db, remote, secrets, mailer } = modules();
  try {
    await engine.init(); seed(db, secrets, "partial-tests"); await draftChecks(engine, db); await deliveryChecks(engine, db, remote, mailer); await db.close();
    for (const kind of ["direct", "scheduled"]) for (const mode of ["crash", "restart"]) {
      const child = spawnSync(process.execPath, [__filename, "--phase", mode, path.join(root, kind), kind], { encoding: "utf8", timeout: 20000 });
      assert.equal(child.status, mode === "crash" ? 19 : 0, child.stderr || child.stdout || "Partial restart fixture failed");
    }
    await uiChecks();
  } finally { await db.close(); secrets.deletePassword("partial-tests"); for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(root, { recursive: true, force: true }); }
  console.log("draft-partial-delivery-ok (verified correlation, recipient receipts, Bcc-safe recovery, restart/failures)");
}
module.exports = { run };
if (require.main === module) (process.argv[2] === "--phase" ? crashPhase(process.argv[3], process.argv[4], process.argv[5]) : run())
  .then(() => process.exit(0), error => { console.error(error); process.exit(1); });
