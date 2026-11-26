// Synthetic provider data, production parser/cache/IPC/renderer; no credentials.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { JSDOM } = require("jsdom");
const Database = require("better-sqlite3");
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
        bodyStructure: { type: "multipart/mixed", childNodes: ["invoice.pdf", "details.pdf"].map((filename, index) => ({
          part: String(index + 2), type: "application/pdf", disposition: "attachment", dispositionParameters: { filename },
        })) },
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
  assert.equal(listed.hasAttachments, true);
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
  const inline = { filename: "Inline logo.png", mimeType: "image/png", contentId: "inline-logo" };
  const photo = { filename: "Ordinary photo.png", mimeType: "image/png", contentId: null };
  const file = { filename: "Private fixture file.pdf", mimeType: "application/pdf" };
  const queuedAttachments = [[], [inline], [photo], [inline, file]];
  const fileFlags = [false, false, true, true];
  for (let i = 0; i < destinations.length; i++) {
    const accountId = ["imap", "outlook", "gmail", "imap"][i];
    db.insertScheduled({ id: "queued-" + i, accountId, sendAt: Date.parse("2099-01-01T00:00:00Z") + i, createdAt: 1,
      payloadJson: JSON.stringify({ outbox: true, to: destinations[i], cc: i === 3 ? "cc-only@fixture.invalid" : "", bcc: "private@fixture.invalid", subject: "Queued " + i, body: "Never list this body",
        ...(i > 0 ? { attachments: queuedAttachments[i] } : {}) }) });
  }
  const summary = { summary: true, includeRows: true, outbox: true, selectedId: "queued-1" };
  const fresh = await ask("mail:listScheduled", summary);
  assert.deepEqual(fresh.rows.map(row => row.hasAttachments), fileFlags);
  assert.equal(fresh.selected.hasAttachments, false);
  for (const [index, attachments] of queuedAttachments.entries()) {
    const [full] = await ask("mail:listScheduled", { id: "queued-" + index });
    assert.equal(full.hasAttachments, fileFlags[index]);
    assert.deepEqual(full.attachments || [], attachments);
  }

  // Write the two historical summary shapes into this disposable queue.
  const legacy = new Database(path.join(directory, "mail.sqlite.live"), { fileMustExist: true });
  try {
    legacy.prepare(`UPDATE scheduled_sends SET summary_json =
      json_set(json_remove(summary_json, '$.hasFileAttachments'), '$.hasAttachments', json('true')) WHERE id = 'queued-1'`).run();
    legacy.prepare(`UPDATE scheduled_sends SET summary_json =
      json_remove(summary_json, '$.hasFileAttachments') WHERE id = 'queued-2'`).run();
  } finally { legacy.close(); }
  const overview = await ask("mail:listScheduled", summary);
  assert.equal(overview.rows.length, 4); assert.equal(overview.outboxTotal, 4);
  assert.ok(overview.rows.every(row => !row.htmlBody && !row.attachments));
  assert.deepEqual(overview.rows.map(row => row.hasAttachments), fileFlags);
  assert.equal(overview.selected.hasAttachments, false);
  assert.ok(!overview.selected.htmlBody && !overview.selected.attachments);
  const dom = new JSDOM(fs.readFileSync(require.resolve("../renderer/index.html"), "utf8")); t.after(() => dom.window.close());
  const ui = renderer({ document: dom.window.document }); ui.context.summaries = overview.rows;
  ui.context.providerMail = listed;
  const subject = ui.run("messageRow(providerMail).querySelector('.subject')");
  const prefix = subject.previousElementSibling;
  assert.equal(subject.textContent, "Re: Fwd: needle");
  assert.equal(subject.title, subject.textContent);
  assert.equal(prefix.className, "mail-attachment-prefix");
  assert.equal(prefix.querySelectorAll('svg[aria-hidden="true"]').length, 1);
  assert.equal(prefix.querySelector(".sr").textContent, "Has attachments.");
  const queuedIconCounts = ui.run("outboxEmails(summaries).map(email => messageRow(email).querySelectorAll('.mail-attachment-prefix').length)");
  assert.deepEqual(Array.from(queuedIconCounts), [0, 0, 1, 1]);
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

test("Undo, saved drafts and local Sent copies count file attachments while retaining CID parts", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-outgoing-status-"));
  const keys = ["MORROW_MAIL_DIR", "MORROW_USER_DATA", "MORROW_MAIL_SECRETS"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { MORROW_MAIL_DIR: directory, MORROW_USER_DATA: directory, MORROW_MAIL_SECRETS: "memory" });
  const db = require("../host/mail/db"), engine = require("../host/mail/engine");
  t.after(async () => {
    engine.setSmtpSenderForTest(null);
    await db.close();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await engine.init();
  const accountId = fixture.account.id;
  db.insertAccount(fixture.account);
  db.replaceFolders(accountId, [...fixture.folders, { path: "Drafts", name: "Drafts", wellKnown: "drafts" }]);
  const ask = async (channel, payload) => {
    const result = await engine.answer(channel, [payload]);
    assert.equal(result.success, true, JSON.stringify(result));
    return result.data;
  };
  const inline = { ...(await ask("mail:uploadAttachment", { filename: "logo.png", mimeType: "image/png", fileBytes: Buffer.from("inline bytes") })), contentId: "logo" };
  const photo = await ask("mail:uploadAttachment", { filename: "photo.png", mimeType: "image/png", fileBytes: Buffer.from("photo bytes") });
  const pdf = await ask("mail:uploadAttachment", { filename: "report.pdf", mimeType: "application/pdf", fileBytes: Buffer.from("file bytes") });
  const cases = [[inline], [photo], [pdf], [inline, pdf]];
  let submissions = 0;
  engine.setSmtpSenderForTest(async ({ options, messageId }) => {
    assert.deepEqual(options.attachments.map(file => file.cid || null), cases[submissions].map(file => file.contentId || null));
    submissions++;
    return { messageId, accepted: options.to, rejected: [] };
  });

  const legacyIds = [];
  for (const [index, attachments] of cases.entries()) {
    const payload = { accountId, to: "recipient@fixture.invalid", body: '<p>Fixture</p><img src="cid:logo">', attachments };
    const id = "queue-cid-" + index;
    db.insertScheduled({ id, accountId, sendAt: Date.parse("2099-01-01T00:00:00Z"), createdAt: index,
      payloadJson: JSON.stringify({ ...payload, subject: "Recovered " + index, outbox: true }) });
    const recovered = await ask("mail:cancelScheduled", { id, recoverDraft: true });
    assert.equal(db.scheduledById(id), null);
    const saved = await ask("mail:upsertDraft", { ...payload, subject: "Saved " + index });
    await ask("mail:upsertDraft", { ...payload, emailId: saved.emailId, draftRevision: saved.draftRevision, subject: "Updated " + index });
    assert.equal(submissions, index, "saving or recovering a draft cannot submit it");
    const sent = await ask("mail:send", { ...payload, subject: "Sent " + index });
    for (const copy of [recovered, saved, sent]) {
      const reopened = (await ask("mail:openEmail", { emailId: copy.emailId })).email;
      assert.equal(db.messageById(copy.emailId).has_attachments, Number(index !== 0));
      assert.equal(reopened.hasAttachments, index !== 0);
      assert.deepEqual(reopened.attachments.map(file => file.contentId), attachments.map(file => file.contentId || null));
      if (index === 0) {
        assert.equal((await engine.bytesFor({ emailId: copy.emailId, attachmentId: inline.id })).data.toString(), "inline bytes");
        db.updateMessage(copy.emailId, { has_attachments: 1 });
        legacyIds.push(copy.emailId);
      }
    }
  }
  assert.equal(submissions, cases.length);
  await db.close(); await engine.init();
  for (const [folderId, total] of [["Drafts", 8], ["Sent", 4]]) {
    const { emails } = await ask("mail:listFromCache", { accountId, folderId });
    assert.equal(emails.length, total);
    assert.deepEqual(emails.filter(email => !email.hasAttachments).map(email => email.id).sort(),
      legacyIds.filter(id => emails.some(email => email.id === id)).sort());
    assert.equal(emails.filter(email => !email.hasAttachments).length, total / 4);
  }
});
