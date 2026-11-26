"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, before, after } = require("node:test");
const Database = require("better-sqlite3");
const { simpleParser } = require("mailparser");
const Local = require("../host/mail/local-folders");
const { reviewOriginals, readOriginals } = require("../host/mail/forward-originals");

const LIMIT = 25 * 1024 * 1024;
let dir;
let store;
let archive;
let reads = 0;
const pairs = [];

function original(run, part) {
  const name = `r${run}-${part}`;
  const event = run < 2;
  const sender = event ? `venues-${part}` : `news-${part}`;
  const subject = event ? "Summer event confirmation" : "Bulletin";
  const headers = [
    `From: <${sender}@example.invalid>`,
    `To: <crew-${part}@example.invalid>`,
    `Subject: ${subject}`,
    `Date: Tue, 10 Nov 2026 0${4 + part}:05:00 +0000`,
    `Message-ID: <${name}@example.invalid>`,
    `Delivered-To: <alias-${part}@example.invalid>`,
    "MIME-Version: 1.0",
  ];
  if (event && part === 0) return Buffer.from([...headers, 'Content-Type: multipart/mixed; boundary="plan"', "",
    "--plan", "Content-Type: text/plain; charset=utf-8", "", "Use the current seating plan.", "--plan",
    "Content-Type: application/pdf", 'Content-Disposition: attachment; filename="seating-plan.pdf"',
    "Content-Transfer-Encoding: base64", "", Buffer.from(`%PDF-1.5\nseats-${run}\n%%EOF`).toString("base64"),
    "--plan--", ""].join("\r\n"));
  return Buffer.from([...headers, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "",
    event ? "Pick up the key at 14:30." : "Alias delivery status — fixture."].join(part === 0 ? "\r\n" : "\n"));
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-forward-originals-"));
  const file = path.join(dir, "local-folders.sqlite");
  store = Local.createLocalStore(file);
  archive = {
    originalMetadata: store.originalMetadata,
    raw(id) {
      reads += 1;
      return store.raw(id);
    },
  };
  for (let run = 0; run < 4; run += 1) {
    const messages = [];
    for (let part = 0; part < 3; part += 1) {
      const raw = original(run, part);
      const saved = store.save(Local.digest(raw), Local.ARCHIVE_ID, await Local.parseArchive(raw));
      messages.push({ id: saved.message_id, raw });
    }
    pairs.push(messages);
  }
});

after(() => {
  store?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("four saved drafts reopen with all eight originals intact in SQLite and outgoing MIME", async t => {
  const profile = dir;
  const env = { MORROW_USER_DATA: profile, MORROW_MAIL_DIR: profile,
    MORROW_AI_CONFIG_DIR: profile, MORROW_MAIL_SECRETS: "memory" };
  const previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const engine = require("../host/mail/engine");
  const db = require("../host/mail/db");
  const remote = require("../host/mail/remote");
  const secrets = require("../host/mail/secrets");
  const accountId = "fixture-drafts";
  const from = "worker@example.invalid";
  t.mock.method(remote, "withClient", async () => { throw new Error("Fixture is offline"); });
  t.after(async () => {
    secrets.deletePassword(accountId);
    engine.closeLocalArchiveForTest();
    await db.close();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  await engine.init();
  db.insertAccount({ id: accountId, email: from, username: "worker", profile: "custom", createdAt: Date.now(),
    imapHost: "imap.example.invalid", imapPort: 993, imapTls: true,
    smtpHost: "smtp.example.invalid", smtpPort: 587, smtpTls: true });
  secrets.setPassword(accountId, "fixture-only");
  db.replaceFolders(accountId, [{ path: "Drafts", name: "Drafts", wellKnown: "drafts" }]);

  const savedDrafts = [];
  const body = "<p>Please review.</p>";
  for (const [run, messages] of pairs.entries()) {
    const [first, second, excluded] = messages;
    const ids = [first.id, second.id];
    const beforeReview = reads;
    const review = reviewOriginals(archive, ids, LIMIT);
    assert.equal(reads, beforeReview, "review reads metadata only");
    assert.deepEqual(review.items.map(item => item.id), ids);
    assert.equal(review.items[0].subject, review.items[1].subject);
    assert.notEqual(review.items[0].from, review.items[1].from);
    assert.equal(new Date(review.items[0].date).toISOString(), "2026-11-10T04:05:00.000Z");
    assert.equal(new Date(review.items[1].date).toISOString(), "2026-11-10T05:05:00.000Z");
    assert.notEqual(review.items[0].filename, review.items[1].filename);
    assert.equal(review.totalBytes, first.raw.length + second.raw.length);
    assert.equal(review.overLimit, false);
    const files = readOriginals(archive, ids, review.proof, review.totalBytes);
    assert.deepEqual(files.map(file => file.fileBytes), [first.raw, second.raw]);
    assert.ok(files.every(file => !file.fileBytes.equals(excluded.raw)));

    const params = { accountId: Local.ACCOUNT_ID, messageIds: ids };
    const checked = await engine.answer("mail:reviewForwardOriginals", [params]);
    assert.deepEqual(checked.data, reviewOriginals(archive, ids, LIMIT));
    if (run === 0) {
      const single = await engine.answer("mail:reviewForwardOriginals", [{ ...params, messageIds: ids.slice(0, 1) }]);
      assert.equal(single.success, false);
      const wrongAccount = await engine.answer("mail:stageForwardOriginals", [{ ...params, accountId, proof: checked.data.proof }]);
      assert.equal(wrongAccount.success, false);
      const stale = await engine.answer("mail:stageForwardOriginals", [{ ...params, proof: "stale" }]);
      assert.equal(stale.success, false);
      const saveBlob = db.saveBlob;
      let writtenId;
      const failSecond = t.mock.method(db, "saveBlob", (id, ...rest) => {
        if (writtenId) throw new Error("Synthetic second write failure");
        writtenId = id;
        return saveBlob(id, ...rest);
      });
      try {
        const rolledBack = await engine.answer("mail:stageForwardOriginals", [{ ...params, proof: checked.data.proof }]);
        assert.equal(rolledBack.success, false);
        assert.ok(writtenId);
        assert.equal(db.readBlob(writtenId), null);
      } finally { failSecond.mock.restore(); }
    }
    const staged = await engine.answer("mail:stageForwardOriginals", [{ ...params, proof: checked.data.proof }]);
    assert.equal(staged.success, true, JSON.stringify(staged.error));
    const { attachments } = staged.data;
    const to = `recipient-${run}@example.invalid`;
    const saved = await engine.answer("mail:upsertDraft", [{ accountId, to, body, subject: "Fixture handoff", attachments }]);
    assert.equal(saved.success, true);
    assert.equal(saved.data.remoteSaved, false);
    assert.equal(db.messageById(saved.data.emailId).uid, 0);
    savedDrafts.push({ ...saved.data, to, files, expected: [first.raw, second.raw] });
  }

  await db.close();
  await engine.init();
  for (const { emailId, draftRevision, to, files, expected } of savedDrafts) {
    const reopened = await engine.answer("mail:prepareDraft", [{ emailId, draftRevision }]);
    assert.equal(reopened.success, true, JSON.stringify(reopened.error));
    const { email } = reopened.data;
    assert.equal(email.id, emailId);
    assert.equal(email.htmlBody, body);
    assert.deepEqual(email.to, [to]);
    assert.deepEqual(email.attachments.map(file => file.filename), files.map(file => file.filename));
    const attachments = await Promise.all(email.attachments.map(async file => {
      const { data } = await engine.bytesFor({ emailId, attachmentId: file.id });
      return { filename: file.filename, contentType: file.mimeType, content: data };
    }));
    assert.deepEqual(attachments.map(file => file.content), expected);
    const wire = await remote.buildRaw({ from, to, text: email.textBody, attachments });
    const parsed = await simpleParser(wire);
    assert.deepEqual(parsed.attachments.map(file => file.filename), files.map(file => file.filename));
    assert.ok(parsed.attachments.every(file => file.headers.get("content-transfer-encoding") === "base64"));
    assert.deepEqual(parsed.attachments.map(file => file.content), expected);
    const [primary, other] = await Promise.all(parsed.attachments.map(file => simpleParser(file.content)));
    if (primary.subject === "Summer event confirmation") {
      assert.equal(primary.attachments[0].filename, "seating-plan.pdf");
      assert.match(primary.attachments[0].content.toString(), /seats-[01]/);
      assert.match(other.text, /14:30/);
    } else {
      for (const [part, selected] of [primary, other].entries()) {
        assert.match(selected.messageId, /^<r[23]-[01]@example\.invalid>$/);
        assert.equal(selected.headers.get("delivered-to").value[0].address, `alias-${part}@example.invalid`);
        assert.equal(selected.date.toISOString(), `2026-11-10T0${4 + part}:05:00.000Z`);
      }
      assert.notEqual(primary.messageId, other.messageId);
    }
  }
});

test("an over-limit or unavailable selection reads no original payload", () => {
  const ids = pairs[0].slice(0, 2).map(message => message.id);
  const beforeReview = reads;
  const limit = reviewOriginals(archive, ids, LIMIT).totalBytes - 1;
  const review = reviewOriginals(archive, ids, limit);
  assert.equal(review.overLimit, true);
  assert.throws(() => readOriginals(archive, ids, review.proof, limit), /limit/);
  assert.throws(() => reviewOriginals(archive, [ids[0], "local-message:missing"], LIMIT), /unavailable/);
  assert.throws(() => reviewOriginals(archive, [ids[0], ids[0]], LIMIT), /different messages/);
  assert.throws(() => reviewOriginals(archive, [ids[0], "provider-message"], LIMIT), /Local Folders/);
  assert.equal(reads, beforeReview);
});

test("confirming a different order, shorter set or moved source requires a fresh review", () => {
  const ids = pairs[1].slice(0, 2).map(message => message.id);
  const { proof } = reviewOriginals(archive, ids, LIMIT);
  const beforeReview = reads;
  assert.throws(() => readOriginals(archive, ids.slice().reverse(), proof, LIMIT), /changed/);
  assert.throws(() => readOriginals(archive, ids.slice(0, 1), proof, LIMIT), /changed/);
  assert.throws(() => readOriginals(archive, [ids[0], pairs[1][2].id], proof, LIMIT), /changed/);
  try {
    store.update(ids[0], { folderId: Local.TRASH_ID });
    assert.throws(() => readOriginals(archive, ids, proof, LIMIT), /changed/);
    assert.equal(reads, beforeReview);
  } finally {
    store.update(ids[0], { folderId: Local.ARCHIVE_ID });
  }
});

test("a changed final payload produces no attachment set", () => {
  const ids = pairs[2].slice(0, 2).map(message => message.id);
  const { proof } = reviewOriginals(archive, ids, LIMIT);
  const invalid = { ...archive, raw(id) {
    const raw = archive.raw(id);
    if (id === ids[1]) raw[0] ^= 1;
    return raw;
  } };
  assert.throws(() => readOriginals(invalid, ids, proof, LIMIT), /changed/);
});

test("SQLite verifies metadata at review and the raw original at confirmation", () => {
  const { id, raw } = pairs[3][0];
  const sqlite = new Database(store.file);
  const writeInfo = sqlite.prepare("UPDATE messages SET info=? WHERE id=?");
  const writeRaw = sqlite.prepare("UPDATE messages SET raw=? WHERE id=?");
  const { info } = sqlite.prepare("SELECT info FROM messages WHERE id=?").get(id);
  const { proof } = reviewOriginals(archive, [id], LIMIT);
  const beforeReview = reads;
  try {
    writeInfo.run(JSON.stringify({ ...JSON.parse(info), subject: "Changed subject" }), id);
    assert.throws(() => reviewOriginals(archive, [id], LIMIT), /metadata verification failed/);
    writeInfo.run(info, id);

    const changed = Buffer.from(raw);
    changed[0] ^= 1;
    writeRaw.run(changed, id);
    assert.equal(reviewOriginals(archive, [id], LIMIT).proof, proof);
    assert.equal(reads, beforeReview);
    assert.throws(() => readOriginals(archive, [id], proof, LIMIT), /Original MIME verification failed/);
  } finally {
    writeInfo.run(info, id);
    writeRaw.run(raw, id);
    sqlite.close();
  }
});
