const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const db = require("../host/mail/db");
const recipients = require("../host/mail/recipient-suggest");
const suggest = require("../shared/recipient-suggest");
const perf = require("../host/performance-diagnostics");
const { Persistence } = require("../host/mail/persistence");

function account(id) {
  return { id, email: `${id}@example.test`, username: id, profile: "custom", createdAt: 1,
    imapHost: "imap.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.invalid", smtpPort: 465, smtpTls: true };
}
function message(owner, index) {
  return { id: `${owner}-${String(index).padStart(4, "0")}`, uid: index + 1, threadId: `${owner}-thread-${index}`,
    from: `person${index % 27}@example.test`, fromAddress: `person${index % 27}@example.test`,
    fromDisplayName: `Person ${index % 27}`, to: ["reader@example.test"], date: new Date(1700000000000 + index).toISOString(),
    listSortTs: 1700000000000 + index, textBody: "Stored body", bodyComplete: true };
}
function allHeaders() {
  const rows = [];
  let after = "";
  while (true) {
    const page = db.recipientHeaderRows(after);
    if (!page.length) return rows;
    rows.push(...page); after = page.at(-1).id;
  }
}

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-performance-storage-"));
  const file = path.join(directory, "mail.sqlite");
  const originalAppend = Persistence.prototype.append, originalStage = perf.sync;
  const readHeaders = db.recipientHeaderRows, readChanges = db.recipientHeaderChanges;
  try {
    await db.open(file);
    for (const owner of ["a", "b"]) {
      db.insertAccount(account(owner));
      db.replaceFolders(owner, [{ path: "Inbox", name: "Inbox", wellKnown: "inbox" }]);
      let heartbeat = false;
      const pending = db.applyFolderSyncAsync(owner, "Inbox", { validity: 1, uidCursor: 210, windowDone: true,
        messages: Array.from({ length: 210 }, (_unused, index) => message(owner, index)), uids: Array.from({ length: 210 }, (_unused, index) => index + 1) });
      setImmediate(() => { heartbeat = true; assert.equal(db.isReady(), true); db.accountById(owner); });
      await pending;
      assert.equal(heartbeat, true, "changed sync batches yield with database admission available and no open transaction");
    }
    const query = { mailboxes: [{ accountId: "a", path: "Inbox" }, { accountId: "b", path: "Inbox" }], limit: 200 };
    const first = db.selectMessages(query, { headersOnly: true });
    const second = db.selectMessages({ ...query, offset: 200 }, { headersOnly: true });
    assert.equal(first.length, 200); assert.equal(second.length, 200);
    assert.equal(new Set([...first, ...second].map(row => row.id)).size, 400);
    for (let index = 1; index < first.length; index++) assert.ok(first[index - 1].list_sort_ts >= first[index].list_sort_ts);
    assert.ok(first.every(row => !Object.hasOwn(row, "html_body") && !Object.hasOwn(row, "text_body") && row.has_body === 1));
    let summaries = 0;
    perf.sync = (stage, work) => { if (stage === "db.list.summary") summaries++; return originalStage(stage, work); };
    assert.equal(db.countMessages(query), 420); db.oldestTs({ ...query, offset: 200 }); db.countMessages({ ...query, offset: 400 });
    assert.equal(summaries, 1, "pages share exact revisioned counts and oldest-date results");
    const headerStamp = db.recipientHeaderStamp();
    const expected = suggest.filter(suggest.rank(allHeaders()), "example.test");
    assert.deepEqual(await recipients.list("example.test"), expected);
    let fullPages = 0, deltaPages = 0;
    db.recipientHeaderRows = (...args) => { fullPages++; return readHeaders(...args); };
    db.recipientHeaderChanges = (...args) => { deltaPages++; return readChanges(...args); };
    db.updateMessage("a-0000", { text_body: "A changed stored body" });
    db.countMessages(query);
    assert.equal(summaries, 1, "body-only changes do not invalidate list counts");
    db.updateMessage("a-0000", { unread: 1, starred: 1 });
    assert.equal(db.recipientHeaderStamp(), headerStamp);
    assert.deepEqual(await recipients.list("example.test"), expected);
    assert.equal(fullPages, 0); assert.equal(deltaPages, 0);
    db.updateMessage("a-0001", { from_address: "updated@example.test", from_addr: "updated@example.test", from_display_name: "Updated Person" });
    assert.deepEqual(await recipients.list("updated@"), [{ email: "updated@example.test", name: "Updated Person" }]);
    assert.equal(fullPages, 0); assert.ok(deltaPages > 0);
    db.deleteMessage("a-0001"); assert.deepEqual(await recipients.list("updated@"), []);
    assert.equal(fullPages, 0);
    db.recipientHeaderRows = readHeaders; db.recipientHeaderChanges = readChanges;

    db.updateMessage("a-0002", { body_complete: 0, body_retry_blocked: 1, body_retry_after: 0 });
    assert.equal(db.selectMessages({ accountId: "a", needsBody: true }).some(row => row.id === "a-0002"), false);
    await db.close(); await db.open(file);
    assert.equal(db.messageById("a-0002").body_retry_blocked, 1, "source limits survive reopen");
    db.updateMessage("a-0002", { uid: 9000 });
    assert.equal(db.messageById("a-0002").body_retry_blocked, 0, "a changed provider identity restores retry eligibility");
    assert.equal(db.selectMessages({ accountId: "a", needsBody: true }).some(row => row.id === "a-0002"), true);
    const whitespace = [null, "", " \t\r\n\u00a0\u200a\u202f\ufeff", "\u200b", " real "];
    for (const [index, text] of whitespace.entries()) {
      db.updateMessage(`b-${String(index).padStart(4, "0")}`, { text_body: text, html_body: null });
      const row = db.selectMessages({ retainOnly: `b-${String(index).padStart(4, "0")}`, limit: 1 }, { headersOnly: true })[0];
      assert.equal(row.has_body, text && text.trim() ? 1 : 0);
    }
    const scope = { ...query, excludeSnoozed: true };
    db.setSnooze("a", "a-thread-5", new Date(Date.now() + 80).toISOString());
    assert.equal(db.countMessages(scope), 418);
    await new Promise(resolve => setTimeout(resolve, 90));
    assert.equal(db.countMessages(scope), 419, "cached counts expire exactly with snooze visibility");
    db.updateMessage("a-0000", { unread: 0 });
    assert.equal(db.selectMessages({ ...query, filterUnread: true, retainIds: ["a-0000"] }, { headersOnly: true })[0].id, "a-0000");

    for (let index = 0; index < 205; index++) db.insertScheduled({ id: `scheduled-${String(index).padStart(3, "0")}`, accountId: "a",
      sendAt: 1800000000000 + index, createdAt: index, payloadJson: JSON.stringify({ to: "to@example.test", subject: `Subject ${index}`, body: "PRIVATE_BODY".repeat(100), attachments: [{ path: "PRIVATE_FILE" }] }) });
    db.insertScheduled({ id: "outbox", accountId: "b", sendAt: 1800000001000, createdAt: 1000,
      payloadJson: JSON.stringify({ outbox: true, to: "to@example.test", subject: "Outbox", body: "PRIVATE_OUTBOX_BODY", attachments: [{ path: "PRIVATE_FILE" }] }) });
    const badges = db.scheduledOverview("");
    assert.equal(badges.rows.length, 0); assert.equal(badges.outboxTotal, 1); assert.equal(badges.total, 205);
    const page = db.scheduledOverview("", { includeRows: true });
    assert.equal(page.rows.length, 200); assert.equal(page.hasMore, true);
    assert.equal(db.scheduledOverview("", { includeRows: true, offset: 200 }).rows.length, 5);
    assert.doesNotMatch(JSON.stringify(page), /PRIVATE_BODY|PRIVATE_FILE/);
    const queued = db.scheduledOverview("", { includeRows: true, outbox: true });
    assert.equal(queued.rows.length, 1); assert.doesNotMatch(JSON.stringify(queued), /PRIVATE_OUTBOX_BODY|PRIVATE_FILE/);
    const selected = db.scheduledOverview("", { includeRows: true, outbox: true, selectedId: "outbox" }).selected;
    assert.equal(selected.id, "outbox"); assert.doesNotMatch(JSON.stringify(selected), /PRIVATE_OUTBOX_BODY|PRIVATE_FILE/);
    assert.equal(db.scheduledOverview("a", { includeRows: true, outbox: true, selectedId: "outbox" }).selected, null);
    assert.match(db.scheduledById("outbox").payload_json, /PRIVATE_OUTBOX_BODY/);
    const changes = db.mailInvalidations(-1);
    assert.ok(changes.scopes.some(row => row.account_id === "a" && row.folder_path === "Inbox"));
    assert.equal(db.mailInvalidations(changes.revision).scopes.length, 0);

    const raw = new Database(`${file}.live`, { readonly: true });
    try {
      const plan = raw.prepare("EXPLAIN QUERY PLAN SELECT id FROM messages WHERE account_id = ? AND folder_path = ? ORDER BY list_sort_ts DESC, id DESC LIMIT 200").all("a", "Inbox");
      assert.match(JSON.stringify(plan), /messages_folder_page/);
      console.log("bounded-list-plan", JSON.stringify(plan));
    } finally { raw.close(); }

    db.insertAccount(account("partial")); db.replaceFolders("partial", [{ path: "Inbox", name: "Inbox", wellKnown: "inbox" }]);
    let changedBatches = 0;
    Persistence.prototype.append = function (commands) {
      if (commands.some(command => /INSERT INTO messages/.test(command.sql)) && ++changedBatches === 2) throw Object.assign(new Error("Synthetic journal failure"), { code: "ENOSPC" });
      return originalAppend.call(this, commands);
    };
    await assert.rejects(db.applyFolderSyncAsync("partial", "Inbox", { validity: 1, messages: Array.from({ length: 60 }, (_unused, index) => message("partial", index)),
      keepOthers: true, uidCursor: 60, windowDone: true }), /Synthetic journal failure/);
    Persistence.prototype.append = originalAppend;
    assert.equal(db.countMessages({ accountId: "partial" }), 24);
    assert.notEqual(db.folderByPath("partial", "Inbox").uid_cursor, 60);
    await db.close(); await db.open(file);
    assert.equal(db.countMessages({ accountId: "partial" }), 24, "only durable complete batches survive recovery");
    db.insertAccount(account("invalidated")); db.replaceFolders("invalidated", [{ path: "Inbox", name: "Inbox", wellKnown: "inbox" }]);
    let validations = 0;
    await assert.rejects(db.applyFolderSyncAsync("invalidated", "Inbox", { validity: 1, messages: Array.from({ length: 60 }, (_unused, index) => message("invalidated", index)),
      keepOthers: true, uidCursor: 60, windowDone: true }, () => {
      if (++validations > 1) throw new Error("Synthetic account incarnation changed");
    }), /Synthetic account incarnation changed/);
    assert.equal(db.countMessages({ accountId: "invalidated" }), 24);
    assert.notEqual(db.folderByPath("invalidated", "Inbox").uid_cursor, 60, "invalidated work cannot publish its final cursor");
    console.log("performance-storage-ok: bounded sync/recovery, header deltas, metadata/counts, scope/hold/snooze, queue summaries and pagination");
  } finally {
    Persistence.prototype.append = originalAppend; perf.sync = originalStage;
    db.recipientHeaderRows = readHeaders; db.recipientHeaderChanges = readChanges;
    await db.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
