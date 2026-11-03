// Synthetic provider data, production parser/cache/IPC/renderer; no credentials.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { JSDOM } = require("jsdom");
const { renderer } = require("./check-ux-workflows");
const fixture = require("./mail-performance-fixture");
const { server, message } = require("./gmail-fixture");

test("provider flags survive full sync, rotating refresh, cache restart and metadata lists; Outbox recipients preserve queue summaries", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-status-columns-"));
  const keys = ["MORROW_MAIL_DIR", "MORROW_USER_DATA", "MORROW_MAIL_SECRETS"], previous = { ...process.env };
  Object.assign(process.env, { MORROW_MAIL_DIR: directory, MORROW_USER_DATA: directory, MORROW_MAIL_SECRETS: "memory" });
  const db = require("../host/mail/db"), engine = require("../host/mail/engine"), remote = require("../host/mail/remote");
  t.after(async () => { await db.close(); for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } fs.rmSync(directory, { recursive: true, force: true }); });
  await engine.init();
  for (const [id, profile] of [["imap", "custom"], ["outlook", "outlook"], ["gmail", "gmail"]]) {
    db.insertAccount({ ...fixture.account, id, profile, authKind: profile === "custom" ? "password" : "oauth2", email: id + "@fixture.invalid" });
    db.replaceFolders(id, fixture.folders);
  }
  const ask = async (channel, payload) => { const result = await engine.answer(channel, [payload]); assert.equal(result.success, true, JSON.stringify(result)); return result.data; };
  let flags = new Set(["\\Seen", "\\Answered", "$Forwarded"]), fieldsSeen = [];
  const client = {
    mailbox: { uidValidity: 7, exists: 1 }, getMailboxLock: async () => ({ release() {} }), search: async () => [1],
    async *fetch(range, fields) {
      fieldsSeen.push(fields);
      yield { uid: 1, flags, envelope: { subject: "Re: Fwd: needle", messageId: "<source@fixture.invalid>", inReplyTo: "<parent@fixture.invalid>", date: new Date("2026-11-01T00:00:00Z") },
        ...(fields.source ? { source: Buffer.from("Subject: Re: Fwd: needle\r\nMessage-ID: <source@fixture.invalid>\r\nIn-Reply-To: <parent@fixture.invalid>\r\n\r\nneedle") } : {}) };
      if (!fields.source) yield { uid: 999, flags: new Set(["\\Answered"]) };
    },
  };
  const full = await remote.fetchMessages(client, "INBOX", [1]);
  assert.equal(full.messages[0].replied, true); assert.equal(full.messages[0].forwarded, true);
  full.messages[0].id = "imap-message";
  db.applyFolderSync("imap", "INBOX", { ...full, keepOthers: true });
  db.applyFolderSync("outlook", "INBOX", fixture.report([fixture.message(1, { id: "outlook-message" })]));
  const listed = (await ask("mail:listFromCache", { accountId: "imap", folderId: "INBOX" })).emails[0];
  assert.deepEqual([listed.replied, listed.forwarded], [true, true]);
  assert.equal(Object.hasOwn(listed, "textBody"), false, "status is available without body strings");
  assert.equal((await ask("mail:searchLocal", { accountId: "imap", query: "needle" }))[0].forwarded, true);
  fieldsSeen = []; flags = new Set();
  const refresh = await remote.searchUids(client, "INBOX", {}, { validity: 7, uids: [1] });
  assert.deepEqual(fieldsSeen, [{ uid: true, flags: true }]);
  assert.equal(refresh.flags.length, 1, "unsolicited UID cannot update another row");
  const stale = await remote.searchUids(client, "INBOX", {}, { validity: 99, uids: [1] });
  assert.equal(stale.flags.length, 0, "different UIDVALIDITY cannot supply stale flags");
  const revision = db.mailInvalidations(0).revision;
  db.applyFolderSync("imap", "INBOX", { ...refresh, messages: [], keepOthers: true });
  assert.ok(db.mailInvalidations(revision).scopes.some(row => row.account_id === "imap" && row.folder_path === "INBOX"));
  assert.deepEqual([db.messageById("imap-message").replied, db.messageById("imap-message").forwarded], [0, 0]);
  assert.equal(db.messageById("outlook-message").replied, null, "another account's matching UID stays unknown");
  for (const [values, expected] of [[new Set(["\\answered"]), [true, false]], [new Set(["$FORWARDED"]), [false, true]], [undefined, [null, null]]]) {
    flags = values;
    const report = await remote.fetchMessages(client, "INBOX", [1]);
    assert.deepEqual([report.messages[0].replied, report.messages[0].forwarded], expected, "no subject or parent-header inference");
  }
  const gmailMessage = message("gmail-message", ["INBOX", "SENT"]);
  gmailMessage.payload.headers.push({ name: "In-Reply-To", value: "<source@fixture.invalid>" });
  db.applyFolderSync("gmail", "INBOX", fixture.report([fixture.message(99, { id: "gmail-legacy", replied: true, forwarded: true })]));
  const service = server([gmailMessage]); db.enableGmail("gmail");
  assert.deepEqual([db.messageById("gmail-legacy").replied, db.messageById("gmail-legacy").forwarded], [null, null]);
  const gmail = require("../host/mail/gmail-session").createSession(db.accountById("gmail"), "synthetic-token", { api: service.api() });
  db.replaceFolders("gmail", (await gmail.folders()).folders);
  await gmail.adopt(gmailMessage);
  const gmailCopy = db.gmailCopies("gmail", "gmail-message")[0];
  assert.deepEqual([gmailCopy.replied, gmailCopy.forwarded], [null, null]);
  // A migrated cache cannot keep stale IMAP assertions after Gmail API refresh.
  db.updateMessage(gmailCopy.id, { replied: 1, forwarded: 1 }); await gmail.adopt(gmailMessage);
  assert.equal(db.messageById(gmailCopy.id).replied, null);

  const destinations = ["\"Team, West\" <west@fixture.invalid>, second@fixture.invalid", "outlook-recipient@fixture.invalid", "gmail-recipient@fixture.invalid", ""];
  for (let i = 0; i < destinations.length; i++) {
    const accountId = ["imap", "outlook", "gmail", "imap"][i];
    db.insertScheduled({ id: "queued-" + i, accountId, sendAt: Date.parse("2099-01-01T00:00:00Z") + i, createdAt: 1,
      payloadJson: JSON.stringify({ outbox: true, to: destinations[i], cc: i === 3 ? "cc-only@fixture.invalid" : "", bcc: "private@fixture.invalid", subject: "Queued " + i, body: "Never list this body" }) });
  }
  const overview = await ask("mail:listScheduled", { summary: true, includeRows: true, outbox: true });
  assert.equal(overview.rows.length, 4); assert.equal(overview.outboxTotal, 4);
  assert.ok(overview.rows.every(row => !row.htmlBody));
  const dom = new JSDOM(fs.readFileSync(require.resolve("../renderer/index.html"), "utf8")); t.after(() => dom.window.close());
  const ui = renderer({ document: dom.window.document }); ui.context.summaries = overview.rows;
  const rows = ui.run("outboxEmails(summaries).map(email => ({accountId:email.accountId, text:mailRecipientText(email), cell:messageRow(email).querySelector('.recipient').textContent}))");
  assert.deepEqual(Array.from(rows, row => row.text), destinations);
  assert.equal(rows[3].cell, "(no recipient)", "CC/BCC do not fabricate To recipients");
  assert.deepEqual(Array.from(rows.slice(0, 3), row => row.accountId), ["imap", "outlook", "gmail"]);
  assert.equal(ui.run("mailRecipientText({to:[{name:'Recipient',address:'person@fixture.invalid'},'second@fixture.invalid']})"), "Recipient <person@fixture.invalid>, second@fixture.invalid");
  for (const value of [null, undefined, [], " "]) { ui.context.emptyTo = value; assert.equal(ui.run("mailRecipientText({to:emptyTo})"), ""); }
  const scoped = await ask("mail:listScheduled", { summary: true, includeRows: true, outbox: true, accountId: "outlook" });
  assert.equal(scoped.rows.length, 1); assert.equal(scoped.rows[0].to, destinations[1]);
  await db.close(); await db.open(path.join(directory, "mail.sqlite"));
  assert.deepEqual([db.messageById("imap-message").replied, db.messageById("imap-message").forwarded], [0, 0]);
  assert.equal(db.messageById("outlook-message").forwarded, null);
});
