// Temporary SQLite, synthetic transports and independent crash/restart processes.
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const keys = ["MORROW_USER_DATA", "MORROW_MAIL_DIR", "MORROW_AI_CONFIG_DIR", "MORROW_MAIL_SECRETS"];
function configure(dir) { fs.mkdirSync(dir, { recursive: true }); Object.assign(process.env,
  { MORROW_USER_DATA: dir, MORROW_MAIL_DIR: dir, MORROW_AI_CONFIG_DIR: dir, MORROW_MAIL_SECRETS: "memory" }); }
function modules() { return { engine: require("../host/mail/engine"), db: require("../host/mail/db"), remote: require("../host/mail/remote"), secrets: require("../host/mail/secrets") }; }
function seed(db, secrets) {
  db.insertAccount({ id: "revisions", email: "author@example.test", username: "author", profile: "custom", createdAt: Date.now(),
    imapHost: "imap.example.test", imapPort: 993, imapTls: true, smtpHost: "smtp.example.test", smtpPort: 587, smtpTls: true });
  secrets.setPassword("revisions", "synthetic-only");
  db.replaceFolders("revisions", [{ path: "Drafts", name: "Drafts", wellKnown: "drafts" }, { path: "Sent", name: "Sent", wellKnown: "sentitems" },
    { path: "Trash", name: "Trash", wellKnown: "deleteditems" }]);
  db.applyFolderSync("revisions", "Drafts", { messages: [], validity: 100, uids: [] });
}
function row(id, uid = 7, validity = 100) { return { id, accountId: "revisions", folderPath: "Drafts", uid, uidValidity: validity,
  rfcMessageId: "<" + id + "@example.test>", threadId: id, to: ["old@example.test"], subject: "Old server draft",
  htmlBody: "<p>Old server text</p>", textBody: "Old server text", isDraft: true, bodyComplete: true,
  date: "2026-10-24T08:00:00Z", listSortTs: 1792828800000 }; }
const fields = { accountId: "revisions", to: "new@example.test", cc: "new-cc@example.test", bcc: "new-bcc@example.test", subject: "Protected local revision", body: "<p>Newer local text</p>" };
function save(engine, db, id, extra = {}) { return engine.answer("mail:upsertDraft", [{ ...fields, emailId: id, draftRevision: db.draftRevision(db.messageById(id)), ...extra }]); }
function due(engine, db, id, proof = true) {
  const draft = db.messageById(id);
  const queued = engine.answer("mail:scheduleSend", [{ accountId: "revisions", draftId: id, body: draft.html_body,
    to: "old@example.test", sendAt: "2099-01-01T08:00:00Z", ...(proof ? { draftRevision: db.draftRevision(draft) } : {}) }]);
  assert.equal(queued.success, true); db.setScheduledSendAt(queued.data.id, 0); return queued.data.id;
}
async function draftChecks(engine, db, remote) {
  const order = []; let fetches = 0;
  remote.withClient = async (_a, _p, work) => work({});
  remote.checkUidValidity = async () => {};
  remote.removeUid = async (_c, _f, uid) => { order.push("remove:" + uid); };
  remote.fetchSource = async () => { fetches++; throw new Error("Unexpected body fetch"); };
  remote.appendRaw = async () => { order.push("append"); throw new Error("Synthetic APPEND failure"); };
  db.insertMessage(row("offline-edit"));
  const file = engine.answer("mail:uploadAttachment", [{ filename: "keep.txt", fileBytes: Buffer.from("Keep revision attachment") }]).data;
  const old = db.messageById("offline-edit"), saved = await save(engine, db, old.id, { attachments: [file] });
  assert.equal(saved.data.remoteSaved, false); assert.deepEqual(order, ["append"], "never delete before replacement");
  let current = db.messageById(old.id);
  assert.equal(current.draft_pending, 1); assert.notEqual(current.rfc_message_id, old.rfc_message_id);
  const revision = db.draftRevision(current);
  const opened = await engine.answer("mail:openEmail", [{ emailId: old.id, full: true }]);
  assert.equal(opened.data.email.draftPending, true); assert.equal(opened.data.email.draftRevision, revision); assert.equal(fetches, 0);
  for (let repeat = 0; repeat < 2; repeat++) {
    db.applyFolderSync("revisions", "Drafts", { validity: 100, messages: [row(old.id)], uids: [7] });
    db.pruneMissing("revisions", "Drafts", []);
    assert.equal(db.draftRevision(db.messageById(old.id)), revision);
    assert.equal(db.messageById(old.id).html_body, fields.body);
    assert.deepEqual(JSON.parse(db.messageById(old.id).to_json), [fields.to]);
    assert.deepEqual(JSON.parse(db.messageById(old.id).cc_json), [fields.cc]);
    assert.deepEqual(JSON.parse(db.messageById(old.id).bcc_json), [fields.bcc]);
  }
  await db.close(); await engine.init();
  assert.equal(db.messageById(old.id).draft_pending, 1);
  db.applyFolderSync("revisions", "Drafts", { validity: 101, messages: [], uids: [] });
  current = db.messageById(old.id); assert.equal(current.uid, 0); assert.equal(current.uid_validity, 0);
  assert.equal(db.draftRevision(current), revision);
  assert.equal((await engine.bytesFor({ emailId: old.id, attachmentId: file.id })).data.toString(), "Keep revision attachment");
  assert.equal(db.searchMessages({ query: "protected" })[0].id, old.id);
  remote.appendRaw = async () => ({ uid: 50, uidValidity: 101 });
  const retry = await save(engine, db, old.id, { attachments: [file] });
  assert.equal(retry.data.remoteSaved, true); assert.equal(db.messageById(old.id).draft_pending, 0);
  assert.equal(db.messageById(old.id).uid, 50);
  // No APPEND result and no-UID confirmation have different meanings.
  db.insertMessage(row("no-response", 8, 101)); remote.appendRaw = async () => false; order.length = 0;
  assert.equal((await save(engine, db, "no-response")).data.remoteSaved, false); assert.deepEqual(order, []);
  assert.equal(db.messageById("no-response").draft_pending, 1);
  db.insertMessage(row("no-uid", 9, 101)); remote.appendRaw = async () => ({});
  const noUid = await save(engine, db, "no-uid");
  assert.equal(noUid.data.remoteSaved, true); assert.equal(db.messageById("no-uid").uid, 0);
  assert.equal(db.messageById("no-uid").draft_pending, 0); assert.match(noUid.data.warning, /retained/); assert.deepEqual(order, []);
  db.applyFolderSync("revisions", "Drafts", { validity: 101, keepOthers: true, messages: [
    { ...row("adopt-upload", 60, 101), rfcMessageId: db.messageById("no-uid").rfc_message_id, htmlBody: fields.body }] });
  assert.equal(db.messageById("no-uid").uid, 60, "a confirmed upload without UID can later adopt its unique revision identity");
  db.insertMessage(row("retire-failure", 10, 101));
  remote.appendRaw = async () => { order.push("append"); return { uid: 70, uidValidity: 101 }; };
  remote.removeUid = async () => { order.push("remove"); throw new Error("Synthetic retirement failure"); };
  const retired = await save(engine, db, "retire-failure");
  assert.equal(retired.data.remoteSaved, true); assert.match(retired.data.warning, /older server copy/i);
  assert.equal(db.messageById("retire-failure").uid, 70); assert.equal(db.messageById("retire-failure").draft_pending, 0);
  assert.deepEqual(order, ["append", "remove"]);
  // A newer local save can arrive while an older APPEND is in flight.
  db.insertMessage(row("concurrent", 11, 101));
  let release, started; const active = new Promise(resolve => { started = resolve; }); let appends = 0; order.length = 0;
  remote.appendRaw = async () => { appends++; if (appends === 1) { started(); await new Promise(resolve => { release = resolve; }); } return { uid: 70 + appends, uidValidity: 101 }; };
  remote.removeUid = async (_c, _f, uid) => order.push(uid);
  const baseline = db.draftRevision(db.messageById("concurrent"));
  const first = save(engine, db, "concurrent", { body: "<p>First pending</p>" }); await active;
  const conflict = await engine.answer("mail:upsertDraft", [{ ...fields, emailId: "concurrent", draftRevision: baseline, body: "Stale window" }]);
  assert.equal(conflict.error.code, "draft_conflict"); assert.equal(db.messageById("concurrent").html_body, "<p>First pending</p>");
  const second = save(engine, db, "concurrent", { body: "<p>Second pending</p>" });
  assert.equal(db.messageById("concurrent").html_body, "<p>Second pending</p>");
  release(); const outcomes = await Promise.all([first, second]);
  assert.equal(outcomes[0].data.remoteSaved, false); assert.equal(outcomes[1].data.remoteSaved, true);
  assert.equal(db.messageById("concurrent").html_body, "<p>Second pending</p>"); assert.equal(db.messageById("concurrent").uid, 72);
  assert.deepEqual(order, [11], "the obsolete completion cannot delete or overwrite the newer revision");
  db.insertMessage(row("commit-failure", 12, 101)); order.length = 0;
  const update = db.updateMessage;
  remote.appendRaw = async () => ({ uid: 73, uidValidity: 101 });
  db.updateMessage = (id, patch) => { if (patch.draft_pending === 0) throw new Error("Synthetic confirmation commit failure"); return update(id, patch); };
  try { assert.equal((await save(engine, db, "commit-failure")).data.remoteSaved, false); }
  finally { db.updateMessage = update; }
  assert.equal(db.messageById("commit-failure").draft_pending, 1); assert.equal(db.messageById("commit-failure").uid, 12);
  assert.deepEqual(order, [], "a local confirmation failure must not retire the old remote copy");
  db.insertMessage({ ...row("read-race", 13, 101), bodyComplete: false });
  let readStarted, finishRead; const readingActive = new Promise(resolve => { readStarted = resolve; });
  remote.fetchSource = async () => { readStarted(); return new Promise(resolve => { finishRead = resolve; }); };
  remote.appendRaw = async () => ({ uid: 74, uidValidity: 101 });
  const reading = engine.answer("mail:openEmail", [{ emailId: "read-race", full: true }]); await readingActive;
  const editDuringRead = save(engine, db, "read-race");
  finishRead({ ...row("read-race", 13, 101), bodyComplete: true });
  assert.equal((await reading).data.email.htmlBody, fields.body); await editDuringRead;
  assert.equal(db.messageById("read-race").html_body, fields.body, "an earlier body fetch cannot overwrite a pending edit");
  db.insertMessage({ ...row("rollback-pending", 15, 101), folderPath: "Trash", draftPending: true });
  remote.withClient = async () => { throw new Error("Synthetic failure before deleting"); };
  await engine.answer("mail:deleteBatch", [{ folderWellKnownName: "deleteditems", items: [{ emailId: "rollback-pending" }] }]);
  await engine.settleActions();
  assert.equal(db.messageById("rollback-pending").draft_pending, 1, "operation rollback retains pending protection");
  db.pruneMissing("revisions", "Trash", []); assert(db.messageById("rollback-pending"));
}
async function cleanupChecks(engine, db, remote) {
  const removals = [], sent = [];
  remote.withClient = async (_a, _p, work) => work({}); remote.checkUidValidity = async () => {};
  remote.appendRaw = async (_c, folder) => ({ uid: folder === "Drafts" ? 80 : 90, uidValidity: 101 });
  remote.removeUid = async (_c, folder, uid) => removals.push(uid);
  remote.sendSmtp = async (_a, _p, options) => { sent.push(options.html); return { messageId: options.messageId, accepted: options.to, rejected: [] }; };
  db.insertMessage(row("queued-edit", 21, 101)); const queuedEdit = due(engine, db, "queued-edit");
  await save(engine, db, "queued-edit"); await db.close(); await engine.init(); await engine.pumpScheduled(); await engine.pumpScheduled();
  assert.equal(sent.length, 1); assert.equal(sent[0], "<p>Old server text</p>");
  assert.equal(db.messageById("queued-edit").html_body, fields.body); assert.equal(db.messageById("queued-edit").uid, 80);
  assert.deepEqual(removals, [21], "the later uploaded UID is not retired by an older delivery");
  assert.equal(db.scheduledById(queuedEdit).status, "sent"); assert.match(db.scheduledById(queuedEdit).error, /source draft was kept/);
  db.insertMessage(row("untouched", 22, 101)); due(engine, db, "untouched"); await engine.pumpScheduled();
  assert.equal(db.messageById("untouched"), null); assert(removals.includes(22), "a verified unchanged source still cleans up");
  db.insertMessage(row("legacy-source", 23, 101)); due(engine, db, "legacy-source", false); await engine.pumpScheduled();
  assert(db.messageById("legacy-source")); assert(!removals.includes(23), "legacy snapshots cannot guess a revision");
  // Build actual MIME, then run the production parser/IMAP formatter both when
  // caching the legacy row and during provider search. These names deliberately
  // produce display text that is not a correctly quoted RFC From header.
  const withClient = remote.withClient;
  const settings = require("../host/settings"), composeSettings = settings.answer("emailBrain:getComposeSettings", []);
  const changedSettings = structuredClone(composeSettings);
  changedSettings.accounts.revisions = { aliases: [{ address: "other-author@example.test" }], preferredFromAddress: "", defaultDomain: "" };
  settings.answer("emailBrain:saveComposeSettings", [changedSettings]);
  const cases = [
    { name: "" }, { name: "Operations <West>" }, { name: 'Operations "West"' },
    { name: '陳美玲, "Ops <香港>"' }, { name: "Operations <help@example.test>" },
    { name: "Operations <West>", address: "Author@Example.Test" },
    { name: "Operations <West>", edit: "name" }, { name: 'Operations "West"', edit: "from" },
    { name: '陳美玲, "Ops <香港>"', edit: "body" },
  ];
  try {
    for (const [index, { name, address = "author@example.test", edit }] of cases.entries()) {
      const id = "legacy-metadata-" + index;
      const raw = await remote.buildRaw({ from: { name, address }, to: ["old@example.test"], subject: "Legacy provider formatting",
        text: "Old provider text", html: "<p>Old provider text</p>", messageId: `<${id}@example.test>`, date: new Date("2026-10-24T08:00:00Z") });
      const parsed = await require("mailparser").simpleParser(raw);
      assert.equal(parsed.from.value[0].name, name);
      let folder = "";
      const client = {
        mailbox: { uidValidity: 101 },
        getMailboxLock: async path => { folder = path; return { release() {} }; },
        search: async () => folder === "Drafts" ? [31 + index] : [],
        fetch: async function* () {
          if (folder !== "Drafts") return;
          yield { uid: 31 + index, source: raw, flags: new Set(["\\Draft", "\\Seen"]),
            envelope: { from: parsed.from.value, to: parsed.to.value, date: parsed.date, subject: parsed.subject, messageId: parsed.messageId } };
        },
      };
      const formatted = await remote.findText(client, "Drafts", "sender metadata", 100);
      const original = formatted.messages[0];
      assert.equal(original.fromDisplayName, name);
      db.insertMessage({ ...original, id, accountId: "revisions", folderPath: "Drafts", uidValidity: 101,
        fromDisplayName: undefined, fromAddress: undefined });
      db.updateMessage(id, { from_display_name: null, from_address: null });
      const before = db.messageById(id), proof = db.draftRevision(before), queued = due(engine, db, id);
      remote.withClient = async (_account, _password, work) => work(client);
      const refreshed = await engine.answer("mail:search", [{ accountId: "revisions", query: "sender metadata" }]);
      assert.equal(refreshed.success, true, JSON.stringify(refreshed));
      const after = db.messageById(id);
      assert.deepEqual(Object.keys(before).filter(key => before[key] !== after[key]).sort(), ["from_address", "from_display_name"],
        "actual provider search only enriches the two sender metadata columns");
      assert.equal(after.from_display_name, name);
      assert.equal(db.draftRevision(db.messageById(id)), proof, "equivalent name enrichment preserves a preexisting queued proof");
      if (edit) {
        const edited = await engine.answer("mail:upsertDraft", [{ accountId: "revisions", emailId: id, draftRevision: proof,
          fromAddress: edit === "from" ? "other-author@example.test" : "author@example.test",
          fromDisplayName: edit === "name" ? "Actually edited name" : name, to: original.to,
          subject: original.subject, body: edit === "body" ? "<p>Actually edited body</p>" : original.htmlBody }]);
        assert.equal(edited.success, true); assert.equal(edited.data.remoteSaved, true);
        assert.notEqual(db.draftRevision(db.messageById(id)), proof);
      }
      const sentBefore = sent.length, removalsBefore = removals.length;
      await engine.pumpScheduled();
      assert.equal(sent.length, sentBefore + 1, "the queued snapshot submits exactly once");
      if (edit) {
        assert.equal(db.scheduledById(queued).status, "sent");
        const kept = db.messageById(id);
        assert.equal(kept.from_display_name, edit === "name" ? "Actually edited name" : name);
        assert.equal(kept.from_address, edit === "from" ? "other-author@example.test" : "author@example.test");
        assert.equal(kept.html_body, edit === "body" ? "<p>Actually edited body</p>" : original.htmlBody);
        assert.ok(!removals.slice(removalsBefore).includes(kept.uid), "queued cleanup cannot delete the genuinely edited revision");
        assert.match(db.scheduledById(queued).error, /source draft was kept/);
      } else {
        assert.equal(db.scheduledById(queued), null, "successful delivery without a warning clears its queue row");
        assert.equal(db.messageById(id), null, "an unchanged legacy draft is removed after its queued message is accepted");
        assert.ok(removals.includes(31 + index));
      }
    }
  } finally { remote.withClient = withClient; settings.answer("emailBrain:saveComposeSettings", [composeSettings]); }
  console.log("legacy-sender-proof-ok: production MIME/parser/IMAP formatter, historical display text, queued cleanup and real name/From/body edits");
  // Save another revision during the submitted version's remote deletion.
  db.insertMessage(row("during-cleanup", 24, 101)); const revision = db.draftRevision(db.messageById("during-cleanup"));
  let started, release; const active = new Promise(resolve => { started = resolve; }); let first = true;
  remote.removeUid = async (_c, _f, uid) => { removals.push(uid); if (uid === 24 && first) { first = false; started(); await new Promise(resolve => { release = resolve; }); } };
  const sending = engine.answer("mail:send", [{ ...fields, draftId: "during-cleanup", draftRevision: revision, body: "<p>Submitted text</p>" }]);
  await active; const editing = save(engine, db, "during-cleanup", { body: "<p>Written during cleanup</p>" });
  release(); const [delivered, edited] = await Promise.all([sending, editing]);
  assert.equal(delivered.success, true); assert.match(delivered.data.warning, /source draft was kept/);
  assert.equal(edited.data.remoteSaved, true); assert.equal(db.messageById("during-cleanup").html_body, "<p>Written during cleanup</p>");
  await db.close(); await engine.init(); assert.equal(db.messageById("during-cleanup").html_body, "<p>Written during cleanup</p>");
}
async function phase(mode, dir) {
  configure(dir); const { engine, db, remote, secrets } = modules(); await engine.init();
  if (mode === "crash") seed(db, secrets); else secrets.setPassword("revisions", "synthetic-only");
  remote.withClient = async (_a, _p, work) => work({}); remote.checkUidValidity = async () => {};
  remote.removeUid = async () => { throw new Error("Must not delete an old copy before durable replacement"); };
  if (mode === "crash") {
    db.insertMessage(row("crash-edit")); remote.appendRaw = async () => ({ uid: 42, uidValidity: 100 });
    const update = db.updateMessage;
    db.updateMessage = (id, patch) => {
      if (patch.draft_pending === 0) { assert.equal(db.messageById("crash-edit").draft_pending, 1); process.exit(23); }
      return update(id, patch);
    };
    await save(engine, db, "crash-edit"); throw new Error("Crash point not reached");
  }
  const revision = db.draftRevision(db.messageById("crash-edit"));
  assert.equal(db.messageById("crash-edit").html_body, fields.body);
  for (const validity of [100, 200, 200]) {
    db.applyFolderSync("revisions", "Drafts", { validity, uids: [7], messages: [row("old-copy")] });
    assert.equal(db.draftRevision(db.messageById("crash-edit")), revision); assert.equal(db.messageById("crash-edit").draft_pending, 1);
  }
  await db.close(); await engine.init(); assert.equal(db.draftRevision(db.messageById("crash-edit")), revision); await db.close();
}
async function uiChecks() {
  const { renderer } = require("./check-ux-workflows"); const nodes = new Map(), timers = [];
  const get = id => { if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", open: false, dataset: {}, style: {}, classList: { toggle() {} },
    showModal() { this.open = true; }, close() { this.open = false; } }); return nodes.get(id); };
  const ui = renderer({ document: { getElementById: get }, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {} });
  ui.run("state.accounts=[{id:'a',email:'a@example.test',platform:'imap'}];state.accountId='a';state.composeMeta={accountId:'a'};state.composeSession=1;" +
    "state.prefs.undoSend=30;syncCompose=()=>{};scheduleComposeLayout=()=>{};showStatus=()=>{};composePayload=()=>({body:'original'});" +
    "composeHasRecipient=()=>true;composeSnapshot=()=> 'receipt';loadScheduled=async()=>{};loadList=async()=>{};" +
    "globalThis.sendCalls=0;globalThis.channels=[];call=async(channel)=>{sendCalls++;channels.push(channel);return {partial:true,warning:'Partly sent; rejected bad@example.test'};}");
  get("compose").open = true; await ui.run("sendMail()"); assert.equal(get("compose").open, false);
  assert.deepEqual([...ui.run("channels")], ["mail:scheduleSend"]);
  assert.equal(ui.run("state.composeQueued"), true);
  await ui.run("sendMail()"); assert.equal(ui.run("sendCalls"), 1);
  ui.run("state.composeQueued=false;state.composePartialReceipt=false;state.composeSession=2;globalThis.resolveSend=null;" +
    "globalThis.receipts=[];separatePartialReceipt=async(p,m)=>receipts.push({p,m});" +
    "call=()=>new Promise(resolve=>{resolveSend=resolve;});");
  const pending = ui.run("deliverMail({body:'older snapshot'},2)");
  ui.run("state.composeSession=3;state.composePending=true;state.draftId='new-draft';");
  get("compose-body").value = "Newer text"; get("compose-title").textContent = "Newer composition";
  ui.run("resolveSend({partial:true,warning:'Older submission partly sent'})"); await pending;
  assert.equal(get("compose-body").value, "Newer text"); assert.equal(get("compose-title").textContent, "Newer composition");
  assert.equal(ui.run("state.draftId"), "new-draft"); assert.equal(ui.run("state.composePending"), true);
  assert.equal(ui.run("receipts.length"), 1); assert.equal(ui.run("receipts[0].p.body"), "older snapshot");
  const seeds = [];
  const separate = renderer({ window: { morrow: { async openComposeWindow(seed) { seeds.push(seed); } } } });
  separate.run("plainFromMailHtml=value=>value;");
  await separate.run("separatePartialReceipt({accountId:'a',to:['old@example.test'],bcc:['private@example.test'],body:'Original copy'},'Review partial delivery')");
  assert.equal(seeds[0].partialReceipt, "Review partial delivery"); assert.equal(seeds[0].bcc, "private@example.test");
  assert.equal(seeds[0].body, "Original copy"); assert.equal(seeds[0].title, "Partial delivery receipt");
}
async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-revisions-")), env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  configure(path.join(root, "main")); const { engine, db, remote, secrets } = modules();
  const saved = Object.fromEntries(["withClient","checkUidValidity","appendRaw","removeUid","fetchSource","sendSmtp"].map(key => [key, remote[key]]));
  try {
    await engine.init(); seed(db, secrets); await draftChecks(engine, db, remote); await cleanupChecks(engine, db, remote); await db.close();
    for (const mode of ["crash", "restart"]) {
      const child = spawnSync(process.execPath, [__filename, "--phase", mode, path.join(root, "crash")], { encoding: "utf8", timeout: 20000 });
      assert.equal(child.status, mode === "crash" ? 23 : 0, child.stderr || child.stdout || "Revision restart fixture failed");
    }
    await uiChecks();
  } finally { Object.assign(remote, saved); secrets.deletePassword("revisions"); await db.close();
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(root, { recursive: true, force: true }); }
  console.log("draft-revisions-ok (pending edits, replace-before-retire, versioned cleanup, concurrency/crash, delayed and stale receipts)");
}
module.exports = { run };
if (require.main === module) (process.argv[2] === "--phase" ? phase(process.argv[3], process.argv[4]) : run())
  .then(() => process.exit(0), error => { console.error(error); process.exit(1); });
