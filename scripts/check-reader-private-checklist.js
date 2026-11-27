// Synthetic messages only, no provider or AI operations.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const db = require("../host/mail/db");
const { readerChecklist } = require("../host/mail/reader-checklist");

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "morrow-reader-checklist-")), "mail.sqlite");
const accounts = ["work", "home"];
const requests = ["Collect the parcel.", "Water the plants.", "Return the key."];
const source = { accountId: "work", messageId: "work-mail", bodyEpoch: 0 };
const borrow = { accountId: "home", messageId: "work-mail", bodyEpoch: 0 };
const lookalike = { accountId: "home", messageId: "home-mail", bodyEpoch: 0 };
const date = "2026-11-27T01:00:00.000Z";
let epoch = 0;
const call = (owner, action, args = {}) => readerChecklist(db, owner, { action, ...args }, () => epoch);

function insert() {
  for (const id of accounts) {
    const address = id + "@example.invalid";
    db.insertAccount({ id, email: address, username: address, profile: "custom", createdAt: Date.parse(date),
      imapHost: "imap.example.invalid", imapPort: 993, imapTls: true,
      smtpHost: "smtp.example.invalid", smtpPort: 465, smtpTls: true });
    db.replaceFolders(id, [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }], "/");
    putMail(id);
  }
}

function putMail(id) {
  db.insertMessage({ id: id + "-mail", accountId: id, folderPath: "INBOX", uid: 23, uidValidity: 7,
    threadId: "shared-thread", rfcMessageId: "<shared@example.invalid>", subject: "Same reminder",
    from: "sender@example.invalid", to: [id + "@example.invalid"], date,
    listSortTs: Date.parse(date), bodyComplete: true, textBody: requests.join("\n") });
}

(async () => {
  try {
    await db.open(file);
    insert();
    assert.deepEqual(call(source, "list"), []);
    assert.throws(() => call(borrow, "list"), /no longer available/);
    assert.throws(() => call(source, "add", { text: "x".repeat(513) }), /512/);
    assert.throws(() => call(source, "add", { text: "a\u0000b" }), /512/);
    let initial;
    for (const text of requests) initial = call(source, "add", { text });
    assert.deepEqual(call(source, "add", { text: " " + requests[0] + " " }), initial);
    assert.deepEqual(call(lookalike, "list"), []);
    const untouched = db.messageById(source.messageId);
    const [a, b, c] = initial;
    call(source, "set", { id: a.id, done: true });
    call(source, "set", { id: b.id, done: true });
    call(lookalike, "set", { id: c.id, done: true });
    assert.deepEqual(db.messageById(source.messageId), untouched);
    await db.close();
    await db.open(file);
    assert.deepEqual(call(source, "list"), [
      { ...a, done: true }, { ...b, done: true }, c,
    ]);
    epoch = 1;
    assert.throws(() => call(source, "remove", { id: a.id }), /no longer available/);
    const current = { ...source, bodyEpoch: 1 };
    assert.equal(call(current, "set", { id: a.id, done: false })[0].done, false);
    assert.equal(call(current, "remove", { id: a.id }).length, 2);

    const replaceCopy = { ...lookalike, bodyEpoch: 1 };
    for (let i = 1; i <= 32; i++) call(replaceCopy, "add", { text: "Item " + i });
    assert.throws(() => call(replaceCopy, "add", { text: "One more" }), /32 items/);
    db.deleteMessage(lookalike.messageId);
    putMail("home");
    assert.deepEqual(call(replaceCopy, "list"), []);
    db.removeAccount(source.accountId);
    assert.throws(() => call(current, "list"), /no longer available/);
    console.log("reader-private-checklist-ok: local persistence, account/epoch isolation, caps, deduplication, no message mutation and deletion cleanup");
  } finally {
    await db.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
