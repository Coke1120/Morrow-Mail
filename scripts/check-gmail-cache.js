const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { server, message, cacheRuntime } = require("./gmail-fixture");
const runtime = cacheRuntime(), db = runtime.db;
console.log(runtime.native ? "Gmail cache fixtures: production persistence/parser" : "Gmail cache fixtures: Node SQLite SQL/VM; production persistence/parser require CI dependencies");

async function fixture(t, messages = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-gmail-cache-"));
  await db.open(path.join(directory, "mail.sqlite"));
  t.after(async () => { await db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  db.insertAccount({ id: "gmail", email: "owner@fixture.invalid", username: "owner", profile: "gmail", authKind: "oauth2", createdAt: 1,
    imapHost: "imap.fixture.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.fixture.invalid", smtpPort: 465, smtpTls: true });
  db.replaceFolders("gmail", [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }, { path: "Drafts", name: "Drafts", wellKnown: "drafts" }]);
  const service = server(messages);
  function session() { return runtime.createSession(db.accountById("gmail"), "synthetic-token", { api: service.api() }); }
  function cached(id, rfc = `<${id}@fixture.invalid>`, folder = "INBOX", extra = {}) {
    db.insertMessage({ id, accountId: "gmail", folderPath: folder, uid: 42, uidValidity: 77, threadId: "preserved-thread", rfcMessageId: rfc,
      subject: "Cached synthetic", date: "2026-10-25T00:00:00.000Z", listSortTs: 1792886400000, htmlBody: "<b>Cached synthetic</b>", bodyComplete: true, ...extra });
  }
  async function migrate() { db.enableGmail("gmail"); const s = session(); const listed = await s.folders(); db.replaceFolders("gmail", listed.folders, "/"); return s; }
  return { service, session, cached, migrate, directory };
}

test("legacy cache ids, complete bodies, local work and arbitrary Gmail ids survive adoption", async t => {
  const providerId = "99999999999999999999999999", f = await fixture(t, [message(providerId, ["INBOX"], "<legacy@fixture.invalid>")]);
  f.cached("legacy-local", "<legacy@fixture.invalid>"); f.cached("local-draft", "<local@fixture.invalid>", "Drafts", { uid: 0, isDraft: true, draftPending: true });
  const s = await f.migrate();
  await s.sync("INBOX");
  const row = db.messageById("legacy-local");
  assert.equal(row.gmail_id, providerId); assert.equal(row.thread_id, "preserved-thread"); assert.equal(row.body_complete, 1);
  assert.equal(db.gmailMap("gmail", providerId).local_uid, row.uid);
  assert.ok(Number.isSafeInteger(row.uid));
  assert.equal((await s.resolve("INBOX", 42, 77)).provider_id, providerId);
  assert.equal(db.messageById("local-draft").draft_pending, 1);
  const source = await s.source("INBOX", 42, 77); assert.equal(source.uid, 42); assert.match(source.textBody, /Synthetic body/);
});

test("ambiguous RFC matches retain cache and refuse reads/moves rather than guessing", async t => {
  const f = await fixture(t, [message("one", ["INBOX"], "<same@fixture.invalid>"), message("two", ["INBOX"], "<same@fixture.invalid>")]);
  f.cached("legacy", "<same@fixture.invalid>");
  const s = await f.migrate();
  await assert.rejects(s.resolve("INBOX", 42, 77), error => error.code === "gmail_identity_ambiguous");
  await assert.rejects(s.sync("INBOX"), error => error.code === "gmail_identity_ambiguous");
  assert.equal(db.messageById("legacy").uid, 42);
  assert.equal(f.service.calls.filter(call => call.method !== "GET").length, 0);
});

test("bounded paging resumes across sessions and history removes known copies, with expired-cursor backfill", async t => {
  const f = await fixture(t, [message("one"), message("two")]); f.service.pageSize(1);
  let s = await f.migrate();
  assert.equal((await s.sync("INBOX")).bootstrapped, false);
  assert.equal(db.gmailSyncState("gmail", "INBOX").pageToken, "1");
  s = f.session(); assert.equal((await s.sync("INBOX")).bootstrapped, true);
  assert.equal(db.countInFolder("gmail", "INBOX"), 2);
  f.service.messages.delete("one"); f.service.history([{ id: "101", messagesDeleted: [{ message: { id: "one" } }] }]);
  await s.sync("INBOX"); assert.equal(db.gmailCopies("gmail", "one").length, 0);
  f.service.expire(); f.service.messages.delete("two"); await s.sync("INBOX");
  assert.equal(db.gmailCopies("gmail", "two").length, 0);
});

test("the engine's numeric zero means All history; shorter horizons retain existing cache", async t => {
  const old = message("old"); old.payload.headers = old.payload.headers.filter(row => row.name !== "Date"); old.internalDate = "1000000000000";
  const f = await fixture(t, [old]), s = await f.migrate();
  await s.sync("INBOX", { horizonDays: 0 });
  assert.ok(db.gmailCopies("gmail", "old").length);
  assert.equal(f.service.calls.find(call => call.route === "/messages").query.get("q"), null);
  await s.sync("INBOX", { horizonDays: 180 });
  assert.ok(db.gmailCopies("gmail", "old").length, "shortening the horizon does not remove older downloaded mail");
});

test("body retrieval fetches text and attachment bytes only when needed", async t => {
  const source = message("body"); source.payload = { mimeType: "multipart/mixed", headers: source.payload.headers,
    parts: [{ partId: "1", mimeType: "text/plain", body: { attachmentId: "text-part", size: 20 } },
      { partId: "2", mimeType: "application/octet-stream", filename: "fixture.bin", body: { attachmentId: "file-part", size: 20 } }] };
  const f = await fixture(t, [source]), s = await f.migrate(); await s.sync("INBOX");
  const row = db.gmailCopies("gmail", "body")[0]; assert.equal(row.body_complete, 0);
  assert.equal(f.service.calls.filter(call => call.route.includes("/attachments/")).length, 0);
  const body = await s.source(row.folder_path, row.uid, row.uid_validity); assert.equal(body.bodyComplete, true);
  assert.equal(f.service.calls.filter(call => call.route.includes("/attachments/file-part")).length, 0);
  assert.equal((await s.attachment(row.folder_path, row.uid, "gmail:2", row.uid_validity)).toString(), "Synthetic attachment");
});

test("complete IMAP bodies retain text while attachment metadata rebinds to distinct Gmail part ids", async t => {
  const source = message("files"); source.payload = { mimeType: "multipart/mixed", headers: source.payload.headers, parts: [
    { partId: "0", mimeType: "text/plain", body: { attachmentId: "body-text", size: 100 } },
    { partId: "1", mimeType: "text/plain", filename: "first.txt", body: { data: Buffer.from("FIRST BYTES").toString("base64url") } },
    { partId: "2", mimeType: "text/plain", filename: "second.txt", body: { data: Buffer.from("SECOND BYTES").toString("base64url") } },
  ] };
  const f = await fixture(t, [source]);
  f.cached("legacy-files", "<files@fixture.invalid>", "INBOX", { attachments: [{ id: "2", filename: "first.txt" }, { id: "3", filename: "second.txt" }], hasAttachments: true });
  const s = await f.migrate(); await s.sync("INBOX");
  const row = db.messageById("legacy-files"), files = db.jsonList(row.attachments_json);
  assert.equal(row.html_body, "<b>Cached synthetic</b>"); assert.equal(row.body_complete, 1);
  assert.deepEqual(Array.from(files, item => [item.id, item.filename]), [["gmail:1", "first.txt"], ["gmail:2", "second.txt"]]);
  assert.equal((await s.attachment(row.folder_path, row.uid, files[0].id, row.uid_validity)).toString(), "FIRST BYTES");
  assert.equal((await s.attachment(row.folder_path, row.uid, files[1].id, row.uid_validity)).toString(), "SECOND BYTES");
  await assert.rejects(s.attachment(row.folder_path, row.uid, "2", row.uid_validity), error => error.code === "attachment_changed");
});

test("label copies cannot repeat Trash or replace its snapshot; Undo from All Mail restores Inbox and later flags", async t => {
  const f = await fixture(t, [message("copies", ["INBOX", "Label_work", "UNREAD"])]), s = await f.migrate(); await s.sync("INBOX");
  const rows = db.gmailCopies("gmail", "copies"), inbox = rows.find(row => row.folder_path === "INBOX"), work = rows.find(row => row.folder_path === "Work");
  const first = await s.move("INBOX", inbox.uid, "[Gmail]/Trash", inbox.uid_validity);
  const again = await s.move("Work", work.uid, "[Gmail]/Trash", work.uid_validity);
  assert.equal(again.undoable, false);
  assert.equal(f.service.calls.filter(call => call.route.endsWith("/trash") && call.method === "POST").length, 1);
  assert.ok(JSON.parse(db.gmailMap("gmail", "copies").trash_labels_json).includes("INBOX"));
  await s.flags("[Gmail]/Trash", first.uid, ["\\Seen", "\\Flagged"], [], first.uidValidity);
  await s.move("[Gmail]/Trash", first.uid, "[Gmail]/All Mail", first.uidValidity, null, { kind: "undo", providerUndo: first.providerUndo });
  const labels = f.service.messages.get("copies").labelIds;
  assert.ok(labels.includes("INBOX") && labels.includes("Label_work") && labels.includes("STARRED"));
  assert.ok(!labels.includes("TRASH") && !labels.includes("UNREAD"));
  assert.ok(first.providerUndo.labelIds.includes("INBOX") && first.providerUndo.labelIds.includes("UNREAD"), "operation snapshot is immutable");
});

test("verified Trash reconciles legacy copies outside live labels without touching unrelated or pending mail", async t => {
  const f = await fixture(t, [message("legacy-labels", ["INBOX", "Label_work"])]), s = await f.migrate();
  for (const [id, folder] of [["old-inbox", "INBOX"], ["old-work", "Work"], ["old-all", "[Gmail]/All Mail"]]) f.cached(id, "<legacy-labels@fixture.invalid>", folder);
  f.cached("unrelated", "<unrelated@fixture.invalid>", "Work", { uid: 43 });
  f.cached("pending", "<legacy-labels@fixture.invalid>", "Drafts", { uid: 0, isDraft: true, draftPending: true });
  const result = await s.move("INBOX", 42, "[Gmail]/Trash", 77);
  assert.equal(result.gmailMessage.legacyVerified, true);
  db.applyGmailMessage("gmail", result.gmailPaths, result.gmailMessage);
  db.pruneGmailCopies("gmail", "legacy-labels", result.gmailPaths);
  await s.sync("Work"); await s.sync("[Gmail]/All Mail");
  assert.deepEqual(Array.from(db.gmailCopies("gmail", "legacy-labels"), row => row.folder_path), ["[Gmail]/Trash"]);
  assert.equal(db.messageById("old-work"), null); assert.equal(db.messageById("old-all"), null);
  assert.equal(db.messageById("unrelated").gmail_id, null); assert.equal(db.messageById("pending").draft_pending, 1);
});

test("ambiguous legacy copies in a non-live folder refuse reconciliation atomically", async t => {
  const f = await fixture(t, [message("ambiguous-cache", ["TRASH"])]), s = await f.migrate();
  f.cached("copy-one", "<ambiguous-cache@fixture.invalid>", "Work");
  f.cached("copy-two", "<ambiguous-cache@fixture.invalid>", "Work", { uid: 43 });
  await assert.rejects(s.adopt(f.service.messages.get("ambiguous-cache")), error => error.code === "gmail_identity_ambiguous");
  for (const id of ["copy-one", "copy-two"]) { assert.equal(db.messageById(id).gmail_id, null); assert.equal(db.messageById(id).html_body, "<b>Cached synthetic</b>"); }
  assert.equal(db.gmailAlias("gmail", "Work", 42, 77), null);
  assert.equal(f.service.calls.filter(call => call.method !== "GET").length, 0);
});

test("moves/Trash/restore use stable provider identity and label rename preserves cache ids", async t => {
  const f = await fixture(t, [message("move", ["INBOX", "UNREAD"])]), s = await f.migrate(); await s.sync("INBOX");
  const row = db.gmailCopies("gmail", "move").find(row => row.folder_path === "INBOX"), trash = db.folderByWellKnown("gmail", "deleteditems");
  const moved = await s.move("INBOX", row.uid, trash.path, row.uid_validity);
  await s.move(trash.path, moved.uid, "INBOX", moved.uidValidity);
  assert.ok(f.service.messages.get("move").labelIds.includes("INBOX"));
  await s.flags("INBOX", row.uid, ["\\Seen", "\\Flagged"], [], row.uid_validity);
  assert.ok(!f.service.messages.get("move").labelIds.includes("UNREAD"));
  assert.ok(f.service.messages.get("move").labelIds.includes("STARRED"));
  await s.rename("Work", "Projects"); const listed = await s.folders(); db.replaceFolders("gmail", listed.folders, "/");
  assert.equal(db.folderByPath("gmail", "Projects").provider_id, "Label_work");
  assert.equal(db.messageById(row.id).id, row.id);
});

test("unuploaded drafts survive migration; removed accounts cannot be resurrected by late responses", async t => {
  const f = await fixture(t, [message("late")]);
  f.cached("pending", "<new-revision@fixture.invalid>", "Drafts", { isDraft: true, draftPending: true });
  assert.equal(db.enableGmail("gmail"), 1); assert.equal(db.messageById("pending").uid, 0);
  const s = f.session(); const listed = await s.folders(); db.replaceFolders("gmail", listed.folders, "/");
  let release; f.service.hold(new Promise(resolve => { release = resolve; }));
  const reading = s.sync("INBOX"); await new Promise(resolve => setImmediate(resolve));
  db.removeAccount("gmail"); release();
  await assert.rejects(reading, error => error.code === "account_removed");
  assert.equal(db.accountById("gmail"), null);
});

test("Gmail protected Sent/Draft labels are never manually applied or removed; Trash Undo uses untrash", async t => {
  const f = await fixture(t, [message("sent", ["SENT"]), message("draft", ["DRAFT"])]), s = await f.migrate();
  await s.sync("[Gmail]/Sent Mail"); await s.sync("Drafts");
  const sent = db.gmailCopies("gmail", "sent").find(row => row.folder_path === "[Gmail]/Sent Mail");
  await s.move(sent.folder_path, sent.uid, "Work", sent.uid_validity);
  assert.ok(f.service.messages.get("sent").labelIds.includes("SENT"));
  const draft = db.gmailCopies("gmail", "draft").find(row => row.folder_path === "Drafts");
  await assert.rejects(s.move("Drafts", draft.uid, "Work", draft.uid_validity), error => error.code === "unsupported" && error.operationIssued === false);
  const moved = await s.move("Drafts", draft.uid, "[Gmail]/Trash", draft.uid_validity);
  await s.move("[Gmail]/Trash", moved.uid, "Drafts", moved.uidValidity);
  assert.ok(f.service.messages.get("draft").labelIds.includes("DRAFT"));
  assert.ok(!f.service.messages.get("draft").labelIds.includes("TRASH"));
  await assert.rejects(s.move("Work", sent.uid, "Drafts", sent.uid_validity), error => error.code === "unsupported");
});

test("migration blocks unsettled writes but does not strand already superseded/confirmed flags", async t => {
  const f = await fixture(t); f.cached("legacy");
  function action(id, generation, kind, receipt, phase = "closed") {
    db.insertMailAction({ id, batchId: id, messageId: "legacy", accountId: "gmail", generation,
      intentJson: JSON.stringify({kind}), priorJson: "{}", sourceJson: "{}", phase, receipt, createdAt: generation });
  }
  action("old-read", 1, "read", "superseded"); action("new-read", 2, "read", "completed");
  assert.equal(db.gmailMigrationBlockers("gmail"), 0);
  action("unknown-star", 3, "star", "unknown"); assert.equal(db.gmailMigrationBlockers("gmail"), 1);
  action("confirmed-star", 4, "star", "completed"); assert.equal(db.gmailMigrationBlockers("gmail"), 0);
  action("pending-move", 5, "remove", null, "accepted");
  assert.throws(() => db.enableGmail("gmail"), error => error.code === "conflict");
  assert.equal(db.accountById("gmail").mail_transport, "imap"); assert.ok(db.messageById("legacy"));
});
