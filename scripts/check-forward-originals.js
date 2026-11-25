"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, before, after } = require("node:test");
const Database = require("better-sqlite3");
const { simpleParser } = require("mailparser");
const Local = require("../host/mail/local-folders");
const { buildRaw } = require("../host/mail/remote");
const { reviewOriginals, readOriginals } = require("../host/mail/forward-originals");

const LIMIT = 25 * 1024 * 1024;
let dir;
let store;
let metadataDb;
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
    "Date: Tue, 10 Nov 2026 04:05:00 +0000",
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
  metadataDb = new Database(file, { readonly: true });
  const meta = metadataDb.prepare("SELECT folder_id, info, raw_size, raw_sha FROM messages WHERE id=?");
  // The integration will get these fields from the archive owner. This adapter
  // keeps the dedicated fixture useful before the shared entry point is wired.
  archive = {
    originalMetadata(id) {
      const row = meta.get(id);
      if (!row) return null;
      const { from, date, subject } = JSON.parse(row.info);
      return { from, date, subject, folderId: row.folder_id, size: row.raw_size, rawSha: row.raw_sha };
    },
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
  metadataDb?.close();
  store?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("four selections round-trip all eight originals through archive and outgoing MIME", async () => {
  for (const messages of pairs) {
    const [first, second, excluded] = messages;
    const ids = [first.id, second.id];
    const beforeReview = reads;
    const review = reviewOriginals(archive, ids, LIMIT);
    assert.equal(reads, beforeReview, "review reads metadata only");
    assert.deepEqual(review.items.map(item => item.id), ids);
    assert.equal(review.items[0].subject, review.items[1].subject);
    assert.notEqual(review.items[0].from, review.items[1].from);
    assert.notEqual(review.items[0].filename, review.items[1].filename);
    assert.equal(review.totalBytes, first.raw.length + second.raw.length);
    assert.equal(review.overLimit, false);
    const files = readOriginals(archive, ids, review.proof, review.totalBytes);
    assert.deepEqual(files.map(file => file.fileBytes), [first.raw, second.raw]);
    assert.ok(files.every(file => !file.fileBytes.equals(excluded.raw)));

    const wire = await buildRaw({ from: "worker@example.invalid", to: "recipient@example.invalid", text: "Please review.",
      attachments: files.map(file => ({ filename: file.filename, contentType: file.mimeType, content: file.fileBytes })) });
    const parsed = await simpleParser(wire);
    assert.deepEqual(parsed.attachments.map(file => file.filename), files.map(file => file.filename));
    assert.deepEqual(parsed.attachments.map(file => file.content), [first.raw, second.raw]);
    const [primary, other] = await Promise.all(parsed.attachments.map(file => simpleParser(file.content)));
    if (primary.subject === "Summer event confirmation") {
      assert.equal(primary.attachments[0].filename, "seating-plan.pdf");
      assert.match(primary.attachments[0].content.toString(), /seats-[01]/);
      assert.match(other.text, /14:30/);
    } else {
      for (const [part, selected] of [primary, other].entries()) {
        assert.match(selected.messageId, /^<r[23]-[01]@example\.invalid>$/);
        assert.equal(selected.headers.get("delivered-to").value[0].address, `alias-${part}@example.invalid`);
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
