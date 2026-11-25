const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const db = require("../host/mail/db");
const { recipientHeaders } = require("../host/mail/recipient-headers");
const { createFollowups, messageId, singleRecipient, confirmation } = require("../host/mail/sent-followup");

async function run() {
  const directory = fs.mkdtempSync(path.join(process.env.MORROW_FOLLOWUP_TEST_ROOT || os.tmpdir(), "morrow-followups-"));
  const file = path.join(directory, "mail.sqlite");
  const sentAt = Date.parse("2026-01-05T12:00:00Z");
  let now = sentAt + 3600_000;
  let covered = false;
  const followups = createFollowups({ db, now: () => now, selfAddresses: account => [account.email, "alias@example.invalid"],
    hasCoverage: () => covered });
  const call = (action, values = {}) => followups.answer({ action, ...values });
  const address = id => `${id}@example.invalid`;
  const rfc = id => `<${address(id)}>`;
  const dueAt = now + 3600_000;
  const subject = "Proof approval";
  const insert = ({ id, accountId = "editor", folderPath = "Sent", from = address(accountId),
    to = [address("printer")], cc = [], bcc = [], parent, header = "", received = sentAt + 100_000, legacy = false, ...rest }) => {
    const source = Buffer.from(`From: ${from}\r\n${parent ? `In-Reply-To: ${parent}\r\n` : ""}${header}\r\nBody`);
    db.insertMessage({ id, accountId, folderPath, uid: ++uid, uidValidity: 77,
      threadId: "deliberately-same-thread", rfcMessageId: rfc(id), dateSource: "header",
      from, to, cc, bcc, inReplyTo: parent, subject, date: new Date(sentAt).toISOString(), listSortTs: sentAt,
      recipientHeaders: legacy ? {} : recipientHeaders(source, [], received), ...rest });
  };
  let uid = 0;
  const set = (id, accountId = "editor") => {
    const row = call("inspect", { accountId, emailId: id });
    assert.ok(row);
    return call("save", { ...row, expectedDueAt: row.dueAt, dueAt });
  };
  const rows = () => call("list").map(row => [row.recipient, row.state]);
  try {
    await db.open(file);
    for (const id of ["editor", "personal"]) {
      db.insertAccount({ id, email: address(id), username: address(id), profile: "custom", createdAt: sentAt,
        imapHost: "imap.example.invalid", imapPort: 993, imapTls: true,
        smtpHost: "smtp.example.invalid", smtpPort: 465, smtpTls: true });
      db.replaceFolders(id, [{ path: "Sent", name: "Sent", wellKnown: "sentitems" },
        { path: "INBOX", name: "Inbox", wellKnown: "inbox" }, { path: "Archive", name: "Archive", wellKnown: "archive" }], "/");
      for (const folder of ["Sent", "INBOX", "Archive"]) db.applyFolderSync(id, folder, { validity: 77, messages: [] });
    }
    assert.equal(messageId("proof@example.invalid"), "<proof@example.invalid>");
    assert.equal(messageId("<a@example.invalid> <b@example.invalid>"), "");
    assert.equal(singleRecipient([address("printer")], [], [address("hidden")]), "");
    assert.equal(confirmation([address("printer")], [], { to: [address("printer")] }), address("printer"));
    insert({ id: "different-mailbox", accountId: "personal" });
    insert({ id: "multiple", cc: [address("other")] });
    assert.equal(call("inspect", { accountId: "editor", emailId: "different-mailbox" }), null);
    assert.equal(call("inspect", { accountId: "editor", emailId: "multiple" }), null);

    insert({ id: "current-proof", textBody: "Edition 42 needs approval" });
    insert({ id: "previous-proof" });
    insert({ id: "auto", folderPath: "INBOX", from: address("printer"), parent: rfc("current-proof"), header: "Auto-Submitted: auto-replied\r\n" });
    insert({ id: "old-thread", folderPath: "INBOX", from: address("printer"), parent: rfc("previous-proof") });
    insert({ id: "delivery-report", folderPath: "INBOX", from: address("printer"), parent: rfc("current-proof"),
      header: "Content-Type: multipart/report; report-type=delivery-status\r\n" });
    insert({ id: "other-account", accountId: "personal", folderPath: "INBOX", from: address("printer"), parent: rfc("current-proof") });
    assert.equal(set("current-proof"), true);
    assert.deepEqual(rows(), [[address("printer"), "waiting"]]);
    now = dueAt + 1000;
    assert.deepEqual(rows(), [[address("printer"), "check"]]);
    covered = true;
    assert.deepEqual(rows(), [[address("printer"), "due"]]);
    const open = call("open", { accountId: "editor", messageId: rfc("current-proof"), expectedDueAt: dueAt });
    assert.equal(open.emailId, "current-proof");
    assert.equal(db.messageById(open.emailId).text_body, "Edition 42 needs approval");

    // The other club already replied, then had its reply read and archived on another device.
    now = dueAt - 10_000;
    insert({ id: "club-a", to: [address("club-a")], subject: "Lost jacket" });
    insert({ id: "club-b", to: [address("club-b")], subject: "Lost jacket" });
    assert.equal(set("club-a"), true);
    assert.equal(set("club-b"), true);
    insert({ id: "club-a-reply", folderPath: "Archive", from: address("club-a"), parent: rfc("club-a"), unread: false });
    now = dueAt + 1000;
    assert.deepEqual(rows(), [[address("club-b"), "due"], [address("printer"), "due"]]);
    await db.close();
    await db.open(file);
    assert.deepEqual(rows(), [[address("club-b"), "due"], [address("printer"), "due"]]);
    const later = now + 100_000;
    const club = { accountId: "editor", messageId: rfc("club-b") };
    assert.equal(call("save", { ...club, expectedDueAt: dueAt, dueAt: later }), true);
    assert.throws(() => call("dismiss", { ...club, expectedDueAt: dueAt }), /changed/);
    assert.equal(call("dismiss", { ...club, expectedDueAt: later }), true);
    insert({ id: "unproven-reply", folderPath: "INBOX", from: address("printer"), parent: rfc("current-proof"), legacy: true });
    assert.deepEqual(rows(), [[address("printer"), "check"]]);
    assert.deepEqual(db.listScheduled(), []);
    console.log("Sent follow-up: printer and club fixtures, cache identity, offline uncertainty, restart, reschedule and dismiss passed.");
  } finally {
    await db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
