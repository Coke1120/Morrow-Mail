// Real temporary SQLite and isolated restart processes; transports are fake.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const envKeys = ["MORROW_USER_DATA", "MORROW_MAIL_DIR", "MORROW_AI_CONFIG_DIR", "MORROW_MAIL_SECRETS"];
function configure(profile) {
  fs.mkdirSync(profile, { recursive: true });
  Object.assign(process.env, { MORROW_USER_DATA: profile, MORROW_MAIL_DIR: profile, MORROW_AI_CONFIG_DIR: profile, MORROW_MAIL_SECRETS: "memory" });
}
const account = id => ({ id, email: id + "@example.test", username: id, profile: "custom", createdAt: Date.now(),
  imapHost: "imap.example.test", imapPort: 993, imapTls: true, smtpHost: "smtp.example.test", smtpPort: 587, smtpTls: true });
const payload = { to: "recipient@example.test", subject: "Synthetic recovery", body: "<p>Keep these notes</p>" };

async function draftChecks(profile) {
  configure(profile);
  const engine = require("../host/mail/engine"), db = require("../host/mail/db"), remote = require("../host/mail/remote"), secrets = require("../host/mail/secrets");
  const saved = { withClient: remote.withClient, appendRaw: remote.appendRaw };
  await engine.init();
  try {
    db.insertAccount(account("local-recovery")); secrets.setPassword("local-recovery", "synthetic-only");
    db.replaceFolders("local-recovery", [{ path: "Drafts", name: "Drafts", wellKnown: "drafts" }]);
    db.applyFolderSync("local-recovery", "Drafts", { messages: [], validity: 10, uids: [], windowDone: true });
    const file = engine.answer("mail:uploadAttachment", [{ filename: "notes.txt", fileBytes: Buffer.from("Recover attachment bytes") }]).data;
    remote.withClient = async () => { throw new Error("Synthetic offline refusal"); };
    const savedDraft = await engine.answer("mail:upsertDraft", [{ accountId: "local-recovery", ...payload,
      subject: "UniqueDraftRecoveryWord", attachments: [file] }]);
    assert.equal(savedDraft.data.remoteSaved, false);
    const id = savedDraft.data.emailId, before = db.messageById(id);
    assert.equal(before.uid, 0);
    db.insertMessage({ id: "stale-server-copy", accountId: "local-recovery", folderPath: "Drafts", uid: 4, uidValidity: 10,
      date: new Date().toISOString(), listSortTs: Date.now(), subject: "Stale server copy" });
    for (const validity of [20, 20, 30]) {
      db.applyFolderSync("local-recovery", "Drafts", { messages: [], validity, uids: [], windowDone: false });
      assert.deepEqual(db.messageById(id), before, "reset preserves all local fields and metadata");
      assert(!db.messageById("stale-server-copy"));
      assert.equal(db.searchMessages({ query: "uniquedraftrecoveryword" })[0].id, id);
      const bytes = await engine.bytesFor({ emailId: id, attachmentId: file.id });
      assert.equal(Buffer.from(bytes.data).toString(), "Recover attachment bytes");
    }
    await db.close(); await engine.init();
    assert.deepEqual(db.messageById(id), before);
    assert.equal((await engine.bytesFor({ emailId: id, attachmentId: file.id })).data.toString(), "Recover attachment bytes");
    remote.withClient = async (_a, _p, work) => work({});
    remote.appendRaw = async () => ({ uid: 42, uidValidity: 30 });
    const uploaded = await engine.answer("mail:upsertDraft", [{ accountId: "local-recovery", emailId: id, ...payload,
      subject: "UniqueDraftRecoveryWord", attachments: [file] }]);
    assert.equal(uploaded.data.remoteSaved, true); assert.equal(db.messageById(id).uid, 42);
    assert.equal(db.messageById(id).uid_validity, 30);
  } finally { Object.assign(remote, saved); secrets.deletePassword("local-recovery"); await db.close(); }
}

async function phase(mode, profile, point) {
  configure(profile);
  const engine = require("../host/mail/engine"), db = require("../host/mail/db"), remote = require("../host/mail/remote"), secrets = require("../host/mail/secrets");
  await engine.init();
  const id = "restart-" + point;
  const acceptedFile = path.join(profile, "accepted.jsonl");
  if (mode === "crash") {
    db.insertAccount(account(id));
    db.replaceFolders(id, [{ path: "Sent", name: "Sent", wellKnown: "sentitems" }, { path: "Drafts", name: "Drafts", wellKnown: "drafts" }]);
    const file = engine.answer("mail:uploadAttachment", [{ filename: "recovery.txt", fileBytes: Buffer.from("Durable recovery attachment") }]).data;
    db.insertScheduled({ id, accountId: id, payloadJson: JSON.stringify({ ...payload, attachments: [file] }), sendAt: 0, createdAt: 1 });
  }
  secrets.setPassword(id, "synthetic-only");
  let sends = 0;
  remote.sendSmtp = async (_a, _p, options) => {
    sends++;
    assert.equal(db.scheduledById(id).status, "sending");
    assert(db.scheduledById(id).message_id);
    if (mode === "crash" && point === "before-smtp") process.exit(17);
    fs.appendFileSync(acceptedFile, JSON.stringify({ messageId: options.messageId }) + "\n");
    return { messageId: options.messageId };
  };
  remote.withClient = async (_a, _p, work) => work({});
  remote.appendRaw = async () => {
    if (mode === "crash") {
      assert.equal(db.scheduledById(id).status, "sent", "acceptance precedes Sent filing");
      process.exit(17);
    }
    return { uid: 42, uidValidity: 10 };
  };
  if (mode === "crash") { await engine.pumpScheduled(); throw new Error("Crash point was not reached"); }
  const expected = point === "before-smtp" ? "unknown" : "sent";
  assert.equal(db.scheduledById(id).status, expected);
  await engine.pumpScheduled(); await engine.pumpScheduled(); assert.equal(sends, 0, "restart must never replay an uncertain or accepted delivery");
  const shown = engine.answer("mail:listScheduled", [{}]).data.find(row => row.id === id);
  assert.equal(shown.status, expected); assert.match(shown.error, /Sent/);
  assert.equal(engine.answer("mail:editScheduled", [{ id }]).error.code, "delivery_review");
  const canceled = engine.answer("mail:cancelScheduled", [{ id }]);
  assert.equal(canceled.data.snapshot.status, expected);
  assert.equal(engine.answer("mail:restoreScheduled", [{ snapshot: canceled.data.snapshot }]).data.status, expected);
  assert.equal(engine.answer("mail:restoreScheduled", [{ snapshot: canceled.data.snapshot }]).success, false);
  db.setScheduledSendAt(id, 0); db.markScheduledFailed(id, "must not downgrade uncertainty");
  await engine.pumpScheduled(); assert.equal(sends, 0); assert.equal(db.scheduledById(id).status, expected);
  const recovered = engine.answer("mail:editScheduled", [{ id, acknowledgeDelivery: true }]);
  assert.equal(recovered.success, true); assert.match(recovered.data.warning, /may already/);
  const draft = db.messageById(recovered.data.emailId);
  assert.equal(draft.uid, 0); assert.equal(draft.html_body, payload.body);
  const files = JSON.parse(draft.attachments_json);
  assert.equal((await engine.bytesFor({ emailId: draft.id, attachmentId: files[0].id })).data.toString(), "Durable recovery attachment");
  assert.equal(engine.answer("mail:editScheduled", [{ id, acknowledgeDelivery: true }]).success, false);
  await engine.pumpScheduled(); assert.equal(sends, 0, "recovering a draft is never an implicit send");
  await db.close(); await engine.init(); assert(db.messageById(draft.id));
  assert.equal(sends, 0); await db.close();
}

async function failureChecks(profile) {
  configure(profile);
  const engine = require("../host/mail/engine"), db = require("../host/mail/db"), remote = require("../host/mail/remote"), secrets = require("../host/mail/secrets");
  await engine.init();
  const saved = { sendSmtp: remote.sendSmtp, withClient: remote.withClient, appendRaw: remote.appendRaw,
    claim: db.claimScheduled, accept: db.acceptScheduled };
  try {
    db.insertAccount(account("delivery-errors")); secrets.setPassword("delivery-errors", "synthetic-only");
    db.replaceFolders("delivery-errors", [{ path: "Drafts", name: "Drafts", wellKnown: "drafts" }]);
    let sends = 0, behavior = "refused";
    remote.sendSmtp = async () => {
      sends++;
      if (behavior === "refused") { const error = new Error("Synthetic connection refused"); error.code = "ECONNREFUSED"; throw error; }
      if (behavior === "unknown") throw new Error("Synthetic connection lost after DATA");
      return { messageId: "<accepted@example.test>" };
    };
    const queue = id => db.insertScheduled({ id, accountId: "delivery-errors", payloadJson: JSON.stringify(payload), sendAt: 0, createdAt: 1 });
    queue("definitely-unsent"); await engine.pumpScheduled();
    assert.equal(db.scheduledById("definitely-unsent").status, "failed");
    await engine.pumpScheduled(); assert.equal(sends, 1);
    behavior = "accepted"; db.setScheduledSendAt("definitely-unsent", 0); await engine.pumpScheduled();
    assert(!db.scheduledById("definitely-unsent")); assert.equal(sends, 2);
    queue("unknown-response"); behavior = "unknown"; await engine.pumpScheduled();
    assert.equal(db.scheduledById("unknown-response").status, "unknown");
    await engine.pumpScheduled(); assert.equal(sends, 3);
    await db.close(); await engine.init(); await engine.pumpScheduled(); assert.equal(sends, 3);
    queue("claim-failure"); db.claimScheduled = () => { throw new Error("Synthetic claim storage failure"); };
    await assert.rejects(() => engine.pumpScheduled(), /claim storage failure/); assert.equal(sends, 3);
    assert.equal(db.scheduledById("claim-failure").status, "pending");
    db.claimScheduled = saved.claim; behavior = "accepted"; await engine.pumpScheduled(); assert.equal(sends, 4);
    queue("receipt-failure"); db.acceptScheduled = () => { throw new Error("Synthetic receipt storage failure"); };
    await engine.pumpScheduled(); assert.equal(db.scheduledById("receipt-failure").status, "unknown");
    assert.equal(sends, 5); db.acceptScheduled = saved.accept;
    await db.close(); await engine.init(); await engine.pumpScheduled(); assert.equal(sends, 5);
    assert.equal(db.scheduledById("receipt-failure").status, "unknown");
  } finally { remote.sendSmtp = saved.sendSmtp; remote.withClient = saved.withClient; remote.appendRaw = saved.appendRaw;
    db.claimScheduled = saved.claim; db.acceptScheduled = saved.accept; secrets.deletePassword("delivery-errors"); await db.close(); }
}

async function legacyChecks(profile) {
  configure(profile);
  const SQL = await require("sql.js")();
  const old = new SQL.Database();
  old.run("CREATE TABLE scheduled_sends (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, payload_json TEXT NOT NULL, send_at INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL)");
  for (const status of ["pending", "failed"]) old.run("INSERT INTO scheduled_sends VALUES (?, ?, ?, 0, ?, NULL, 1)", ["legacy-" + status, "legacy", JSON.stringify(payload), status]);
  fs.writeFileSync(path.join(profile, "mail.sqlite"), old.export()); old.close();
  const engine = require("../host/mail/engine"), db = require("../host/mail/db");
  await engine.init();
  assert(db.listScheduled().every(row => row.status === "unknown")); assert.equal(db.dueScheduled(Date.now()).length, 0);
  await db.close(); await engine.init();
  assert(db.listScheduled().every(row => row.status === "unknown")); await db.close();
}

async function uiChecks() {
  const source = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
  const start = source.indexOf("function scheduledLine("), end = source.indexOf("\nfunction removalPayload", start);
  const line = vm.runInNewContext("(" + source.slice(start, end).trim() + ")", { Intl, Date });
  assert.match(line({ status: "unknown" }), /uncertain.*no automatic resend/);
  assert.match(line({ status: "sent" }), /SMTP accepted.*no automatic resend/);
  assert.match(line({ status: "failed" }), /not sent; edit to retry/);
  const editStart = source.indexOf("async function editScheduledMail("), editEnd = source.indexOf("\nasync function composeOperation", editStart);
  const calls = [], confirmations = [], handoffs = [];
  const context = vm.createContext({ state: { accounts: [] }, scheduledLine: line, $: () => ({}),
    askConfirm: async copy => { confirmations.push(copy); return { ok: true }; },
    call: async (channel, data) => { calls.push({ channel, data }); return { emailId: "recovered", accountId: "a", warning: "Check Sent before sending this recovered draft." }; },
    loadScheduled: async () => {}, closeDialog: async () => {}, vacationLocalValue: () => "", api: { openComposeWindow() {} },
    resumeDraft: async (_draft, handoff) => { handoffs.push(handoff); } });
  vm.runInContext(source.slice(editStart, editEnd), context);
  await vm.runInContext("editScheduledMail({id:'uncertain',accountId:'a',status:'unknown'})", context);
  assert.match(confirmations[0].body, /already have reached.*nothing is sent automatically/);
  assert.equal(calls[0].channel, "mail:editScheduled"); assert.equal(calls[0].data.acknowledgeDelivery, true);
  assert.match(handoffs[0].status, /Check Sent/); assert.equal(calls.length, 1, "recovery UI never calls send or schedule");
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-durable-delivery-"));
  const env = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  try {
    await draftChecks(path.join(root, "drafts"));
    for (const point of ["before-smtp", "after-acceptance"]) {
      const profile = path.join(root, point);
      for (const mode of ["crash", "restart"]) {
        const child = spawnSync(process.execPath, [__filename, "--phase", mode, profile, point], { encoding: "utf8", timeout: 20000 });
        assert.equal(child.status, mode === "crash" ? 17 : 0, child.stderr || child.stdout || "Restart fixture failed");
      }
      const file = path.join(profile, "accepted.jsonl");
      assert.equal(fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").length : 0, point === "before-smtp" ? 0 : 1);
    }
    await failureChecks(path.join(root, "failures")); await legacyChecks(path.join(root, "legacy")); await uiChecks();
  } finally {
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("draft-scheduled-recovery-ok (local data, durable claims/receipts, crash/restart, uncertainty and recovery)");
}
module.exports = { run };
if (require.main === module) (process.argv[2] === "--phase" ? phase(process.argv[3], process.argv[4], process.argv[5]) : run())
  .then(() => process.exit(0), error => { console.error(error); process.exit(1); });
