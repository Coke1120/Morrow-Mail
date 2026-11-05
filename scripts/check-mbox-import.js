"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const L = require("../host/mail/local-folders");
const M = require("../host/mail/mbox-import");
const R = require("../host/mail/mbox-reader");

const separator = Buffer.from("From - Thu Nov  5 10:00:00 2026\n");
const raw = (subject = "Synthetic mailbox", extra = "", body = "Synthetic evidence\n") => Buffer.from(
  `From: Synthetic <sender@fixture.invalid>\nTo: owner@fixture.invalid\nSubject: ${subject}\nDate: Thu, 5 Nov 2026 12:00:00 +0800\n${extra}\n${body}`);
function mbox(messages, variant = "mboxrd") {
  return Buffer.concat(messages.map(message => {
    const bytes = message.toString("latin1").replace(variant === "mboxrd" ? /^(>*From )/gm : /^(From )/gm, ">$1");
    return Buffer.concat([separator, Buffer.from(bytes, "latin1")]);
  }));
}
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-mbox-synthetic-"));
  const file = path.join(dir, "archive.sqlite"); let store = L.createLocalStore(file, options.storage);
  let importer = M.createImporter({ store, ...options });
  t.after(async () => { await importer.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, get store() { return store; }, get importer() { return importer; },
    source(bytes, name = "Inbox") { const source = path.join(dir, name); fs.writeFileSync(source, bytes); return source; },
    async reopen(nextOptions = options) { await importer.stop(); store.close(); store = L.createLocalStore(file); importer = M.createImporter({ store, ...nextOptions }); },
    async import(paths, destination = L.ARCHIVE_ID, variant = "mboxrd") {
      const job = await importer.select(paths); importer.start(job.id, { destination, variant }); await importer.idle(); return importer.status(job.id);
    } };
}
async function readEntries(t, bytes, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-mbox-reader-")), file = path.join(dir, "fixture");
  fs.writeFileSync(file, bytes); const handle = await fs.promises.open(file, "r");
  t.after(async () => { await handle.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const result = []; for await (const entry of R.entries(handle, 0, { variant: "mboxrd", ...options })) result.push({ ...entry, raw: entry.raw && Buffer.from(entry.raw) });
  return result;
}

if (process.argv[2] === "--crash") {
  (async () => {
    const dir = process.argv[3], point = process.argv[4], store = L.createLocalStore(path.join(dir, "archive.sqlite"));
    const importer = M.createImporter({ store, hooks: { [point]: () => process.exit(37) } });
    const job = await importer.select([path.join(dir, "Inbox")]);
    importer.start(job.id, { destination: L.ARCHIVE_ID, variant: "mboxrd" }); await importer.idle(); process.exit(38);
  })().catch(failure => { console.error(failure); process.exitCode = 1; });
} else {
  test("mboxrd and explicit legacy mboxo preserve LF/CRLF, From body quoting, raw dates, and no final newline", async t => {
    const one = raw("LF", "Message-ID: <same@fixture.invalid>\n", "From an ordinary body line\n>From nested\n>>From deeper\n");
    const two = Buffer.from(raw("CRLF", "", "Last line without newline").toString().replace(/\n/g, "\r\n"));
    const result = await readEntries(t, mbox([one, two]));
    assert.equal(result.length, 2); assert.deepEqual(result[0].raw, one); assert.deepEqual(result[1].raw, two);
    const old = await readEntries(t, mbox([one], "mboxo"), { variant: "mboxo" });
    assert.deepEqual(old[0].raw.toString(), one.toString().replace(/^>From /gm, "From "), "mboxo convention is explicitly lossy for literal single quotes");
    const oneByte = await readEntries(t, mbox([one, two]), { limits: { chunk: 1 } });
    assert.deepEqual(oneByte.map(item => item.raw), [one, two], "framing works across every chunk boundary");
  });

  test("an ambiguous envelope never acknowledges the preceding body; ordinary From lines stay in it", async t => {
    const f = fixture(t);
    const source = f.source(Buffer.concat([mbox([raw("Safe prefix"), raw("Ambiguous")]), separator, Buffer.from("not a header\n\nbody\n")]));
    const result = await f.import([source]);
    assert.equal(result.status, "failed"); assert.equal(result.imported, 1); assert.match(result.detail, /ambiguous/);
    assert.equal(f.store.list().total, 1); assert.match(f.store.message(f.store.list().emails[0].id).subject, /Safe prefix/);
  });

  test("extensionless Thunderbird files import MIME, inline/binary attachments, status, reply headers and decode warnings offline after restart", async t => {
    const f = fixture(t);
    const binary = Buffer.from([0, 255, 13, 10, 42]);
    const original = await require("../host/mail/remote").buildRaw({ from: "Synthetic <sender@fixture.invalid>", to: "owner@fixture.invalid",
      subject: "合成離線郵件", text: "Offline searchable archive evidence", html: '<p>Evidence<script>window.fixtureExecuted=true</script><img src="cid:logo"><img src="https://fixture.invalid/tracker"></p>',
      inReplyTo: "<parent@fixture.invalid>", references: ["<ancestor@fixture.invalid>", "<parent@fixture.invalid>"],
      attachments: [{ filename: "binary.bin", content: binary }, { filename: "inline.png", content: Buffer.from("synthetic-image"), cid: "logo" }] });
    const bytes = Buffer.concat([Buffer.from("X-Mozilla-Status: 1007\r\nX-Mozilla-Keys: not-imported\r\n"), original]);
    const source = f.source(mbox([bytes]));
    const initial = fs.readFileSync(source); const result = await f.import([source]);
    assert.equal(result.status, "completed"); assert.equal(result.imported, 1); assert.deepEqual(fs.readFileSync(source), initial);
    await f.reopen();
    const email = f.store.verify(f.store.list().emails[0].id);
    assert.equal(email.isRead, true); assert.equal(email.isStarred, true); assert.equal(email.replied, true); assert.equal(email.forwarded, true);
    assert.equal(email.subject, "合成離線郵件"); assert.equal(email.inReplyTo, "<parent@fixture.invalid>"); assert.match(email.references, /ancestor/);
    assert.deepEqual(f.store.raw(email.id), bytes); assert.match(email.htmlBody, /data:image/);
    assert.deepEqual(f.store.attachment(email.id, email.attachments.find(item => item.filename === "binary.bin").id), binary);
    assert.equal(f.store.search({ query: "searchable archive" }).length, 1);
    const unknown = raw("Unknown charset", "Content-Type: text/plain; charset=x-fixture-unknown\n", "Synthetic text\n");
    const decoded = await f.import([f.source(mbox([unknown]), "Legacy")]); assert.equal(decoded.imported, 1);
    const uncertain = f.store.search({ query: "Unknown charset" })[0]; assert.match(f.store.verify(uncertain.id).encodingWarning, /unrecognized text encoding/);
    const legacy = Buffer.concat([Buffer.from("From: sender@fixture.invalid\nSubject: Legacy charset\nContent-Type: text/plain; charset=windows-1252\n\n"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])]);
    const importedLegacy = await f.import([f.source(mbox([legacy]), "Legacy-1252")]); assert.equal(importedLegacy.imported, 1);
    assert.match(f.store.verify(f.store.search({ query: "Legacy charset" })[0].id).textBody, /café/);
  });

  test("exact de-framed byte deduplication survives renamed files and folder moves; missing/reused IDs stay distinct by content", async t => {
    const f = fixture(t), first = raw("First", "Message-ID: <reused@fixture.invalid>\n"), second = raw("Second", "Message-ID: <reused@fixture.invalid>\n"), missing = raw("No ID");
    const source = f.source(mbox([first, second, missing, first]));
    const one = await f.import([source]); assert.deepEqual([one.imported, one.skipped], [3, 1]);
    const destination = f.store.manageFolder({ action: "create", name: "Other" }).id;
    f.store.update(f.store.list().emails[0].id, { folderId: destination });
    await f.reopen();
    const two = await f.import([f.source(mbox([first, second, missing]), "Renamed")]); assert.deepEqual([two.imported, two.skipped], [0, 3]);
    const other = await f.import([source], destination); assert.deepEqual([other.imported, other.skipped], [3, 1]);
  });

  test("empty/multiple mailboxes, explicit destinations and Thunderbird deleted entries have truthful counts", async t => {
    const f = fixture(t); const folder = f.store.manageFolder({ action: "create", name: "Imported" }).id;
    const result = await f.import([f.source(Buffer.alloc(0), "Empty"), f.source(mbox([raw("Deleted", "X-Mozilla-Status: 0008\n"), raw("Kept")]), "Inbox")], folder);
    assert.equal(result.status, "completed"); assert.deepEqual([result.imported, result.skipped, result.expunged], [1, 1, 1]);
    assert.equal(f.store.list({ folderId: folder }).total, 1); assert.equal(f.store.list().total, 0); assert.equal(result.consumedBytes, result.totalBytes);
  });

  test("Thunderbird partial messages fail explicitly and queued/draft metadata never creates a sending item", async t => {
    const f = fixture(t);
    const source = f.source(mbox([raw("Partial", "X-Mozilla-Status: 0400\n"), raw("Queued inert", "X-Mozilla-Status: 0800\n")]));
    const result = await f.import([source]); assert.deepEqual([result.imported, result.failed], [1, 1]); assert.match(result.errors[0].detail, /incomplete/);
    const email = f.store.verify(f.store.list().emails[0].id); assert.equal(email.isDraft, false); assert.equal(email.platform, "local");
  });

  test("MSF, SBD trees, EML, invalid source counts, unsupported variants and Content-Length framing fail clearly", async t => {
    const f = fixture(t);
    await assert.rejects(f.importer.select([f.source(Buffer.from("index"), "Inbox.msf")]), /indexes/);
    fs.mkdirSync(path.join(f.dir, "Inbox.sbd")); await assert.rejects(f.importer.select([path.join(f.dir, "Inbox.sbd")]), /directories/);
    await assert.rejects(f.importer.select([]), /1–20/);
    const job = await f.importer.select([f.source(mbox([raw()]))]);
    assert.throws(() => f.importer.start(job.id, { destination: L.ARCHIVE_ID, variant: "mboxcl" }), /explicitly/);
    const variant = await f.import([f.source(mbox([raw("Unsupported", "Content-Length: 10\n")]), "Length")]);
    assert.equal(variant.status, "failed"); assert.match(variant.detail, /mboxcl/);
    const eml = await f.import([f.source(raw(), "message.eml")]); assert.equal(eml.imported, 0); assert.match(eml.detail, /separator/);
  });

  test("oversized entries and MIME failures are isolated, counted and retain their complete snapshot bytes", async t => {
    const f = fixture(t, { limits: { message: 500 } });
    const source = f.source(mbox([raw("Large", "", "x".repeat(2000) + "\n"), raw("Safe") ]));
    const result = await f.import([source]); assert.equal(result.status, "completed_with_errors"); assert.deepEqual([result.imported, result.failed], [1, 1]);
    assert.match(result.errors[0].detail, /32 MiB/); assert.deepEqual(fs.readFileSync(path.join(f.importer.root, result.id, "0.mbox")), fs.readFileSync(source));
    const broken = raw("Truncated multipart", 'MIME-Version: 1.0\nContent-Type: multipart/mixed; boundary="fixture"\n', "--fixture\nContent-Type: text/plain\n\nunterminated\n");
    const malformed = await f.import([f.source(mbox([broken, raw("After truncated")]), "Broken")]); assert.deepEqual([malformed.imported, malformed.failed], [1, 1]);
    const headers = await f.import([f.source(Buffer.concat([separator, Buffer.from("not headers\n"), separator, raw("After invalid headers")]), "Bad-headers")]);
    assert.notEqual(headers.status, "completed");
  });

  test("huge single lines and header blocks stop within bounds without swallowing acknowledged mail", async t => {
    const f = fixture(t, { limits: { line: 1024, headers: 512 } });
    const result = await f.import([f.source(mbox([raw("Prefix"), raw("Long line", "", "x".repeat(2048))]))]);
    assert.equal(result.status, "failed"); assert.match(result.detail, /line exceeds/); assert.equal(result.imported, 1);
    const hugeHeader = raw("Header", "X-Large: " + "x".repeat(700) + "\n");
    const headerResult = await f.import([f.source(mbox([hugeHeader]), "Long-header")]); assert.equal(headerResult.imported, 0); assert.match(headerResult.detail, /headers exceed/);
  });

  test("cancel after a durable commit, restart and continue use frozen destination/format and keep counts exact", async t => {
    let jobId;
    const f = fixture(t, { hooks: { afterCommit({ job }) { jobId = job.id; f.importer.cancel(job.id); } } });
    const source = f.source(mbox([raw("One"), raw("Two")])); const result = await f.import([source]);
    assert.equal(result.status, "cancelled"); assert.equal(result.imported, 1); assert.equal(f.store.list().total, 1);
    await f.reopen({});
    assert.throws(() => f.importer.start(jobId, { destination: L.TRASH_ID }), /reviewed destination/);
    f.importer.start(jobId); await f.importer.idle();
    assert.equal(f.importer.status(jobId).imported, 2); assert.equal(f.importer.status(jobId).status, "completed");
  });

  test("cancellation while staging never imports partial snapshots and can retry an unchanged source", async t => {
    const f = fixture(t, { hooks: { stageChunk({ job }) { f.importer.cancel(job.id); } } });
    const source = f.source(mbox([raw("Staging", "", "x".repeat(200000) + "\n")]));
    const result = await f.import([source]); assert.equal(result.status, "cancelled"); assert.equal(result.imported, 0);
    assert.equal(fs.existsSync(path.join(f.importer.root, result.id, "0.mbox.partial")), false);
    await f.reopen({}); f.importer.start(result.id); await f.importer.idle(); assert.equal(f.importer.status(result.id).imported, 1);
  });

  test("changed/replaced sources are rejected before publication; saved immutable snapshots resume independently", async t => {
    const f = fixture(t, { hooks: { afterCommit({ job }) { f.importer.cancel(job.id); } } });
    const source = f.source(mbox([raw("One"), raw("Two")])); const job = await f.importer.select([source]);
    fs.appendFileSync(source, "changed"); f.importer.start(job.id, { destination: L.ARCHIVE_ID, variant: "mboxrd" }); await f.importer.idle();
    assert.match(f.importer.status(job.id).detail, /changed|replaced/); assert.equal(f.store.list().total, 0);
    fs.writeFileSync(source, mbox([raw("One"), raw("Two")])); const staged = await f.import([source]); assert.equal(staged.imported, 1);
    fs.writeFileSync(source, "later source changed"); await f.reopen({}); f.importer.start(staged.id); await f.importer.idle();
    assert.equal(f.importer.status(staged.id).imported, 2, "resume uses the immutable verified snapshot, not the edited source");
    assert.equal(fs.readFileSync(source, "utf8"), "later source changed");
  });

  test("source changes during staging and corrupt/replaced snapshots never trust stale offsets", async t => {
    const f = fixture(t, { hooks: { stageChunk() { fs.appendFileSync(path.join(f.dir, "Inbox"), "change"); } } });
    const source = f.source(mbox([raw("Changing") ])); const changed = await f.import([source]); assert.equal(changed.imported, 0); assert.match(changed.detail, /changed/);
    await f.reopen({ hooks: { afterCommit({ job }) { f.importer.cancel(job.id); } } });
    fs.writeFileSync(source, mbox([raw("One"), raw("Two")])); const saved = await f.import([source]);
    const snapshot = path.join(f.importer.root, saved.id, "0.mbox"); const bytes = fs.readFileSync(snapshot); bytes[50] ^= 1; fs.writeFileSync(snapshot, bytes);
    // Update the stat receipt to exercise SHA-256 verification independently.
    const jobs = f.store.importJobs(), state = jobs.read(saved.id); state.files[0].snapshot.stamp = M.stamp(fs.statSync(snapshot)); jobs.write(state);
    await f.reopen({}); f.importer.start(saved.id); await f.importer.idle();
    assert.equal(f.importer.status(saved.id).status, "failed"); assert.match(f.importer.status(saved.id).detail, /verification failed/); assert.equal(f.store.list().total, 1);
  });

  test("a byte-identical restored snapshot can resume after its filesystem identity changes", async t => {
    const f = fixture(t, { hooks: { afterCommit({ job }) { f.importer.cancel(job.id); } } });
    const source = f.source(mbox([raw("Restored one"), raw("Restored two")]));
    const job = await f.import([source]); assert.equal(job.imported, 1);
    const saved = path.join(f.importer.root, job.id, "0.mbox"), restored = saved + ".restore";
    fs.copyFileSync(saved, restored); fs.rmSync(saved); fs.renameSync(restored, saved);
    await f.reopen({}); f.importer.start(job.id); await f.importer.idle();
    const result = f.importer.status(job.id); assert.equal(result.status, "completed"); assert.equal(result.imported, 2); assert.equal(f.store.list().total, 2);
  });

  test("storage rollback atomically preserves message, attachments, receipts, offsets and counters", async t => {
    let fail = true;
    const f = fixture(t, { hooks: { insideCommit() { if (fail) throw new Error("synthetic commit failure"); } } });
    const source = f.source(mbox([raw("Rollback")])); const result = await f.import([source]);
    assert.equal(result.status, "failed"); assert.equal(result.imported, 0); assert.equal(result.consumedBytes, 0); assert.equal(f.store.list().total, 0);
    fail = false; f.importer.start(result.id); await f.importer.idle(); assert.equal(f.importer.status(result.id).imported, 1); assert.equal(f.store.list().total, 1);
  });

  test("corrupt import progress fails closed without resetting previously acknowledged local MIME", async t => {
    const f = fixture(t); await f.import([f.source(mbox([raw("Progress evidence")]))]);
    const id = f.store.list().emails[0].id; await f.importer.stop();
    const sql = new Database(f.file); sql.prepare("UPDATE mbox_import_jobs SET state='{}'").run(); sql.close();
    assert.throws(() => M.createImporter({ store: f.store }), /progress verification failed/);
    assert.match(f.store.raw(id).toString(), /Progress evidence/); assert.equal(f.store.list().total, 1);
  });

  test("real SQLite disk-full failure preserves prior commits and a retry never resets the archive", async t => {
    let sql, arm = false;
    const f = fixture(t, { storage: { database: function (file) { sql = new Database(file); return sql; } },
      hooks: { beforeCommit() { if (arm) sql.pragma("max_page_count=" + sql.pragma("page_count", { simple: true })); } } });
    const prior = await f.import([f.source(mbox([raw("Durable prefix")]), "Small")]); assert.equal(prior.imported, 1);
    arm = true; const failed = await f.import([f.source(mbox([raw("Disk full", "", ("x".repeat(1000) + "\n").repeat(200))]))]);
    assert.equal(failed.status, "failed"); assert.equal(failed.imported, 0); assert.equal(f.store.list().total, 1);
    arm = false; sql.pragma("max_page_count=1073741823"); f.importer.start(failed.id); await f.importer.idle();
    assert.equal(f.importer.status(failed.id).imported, 1); assert.equal(f.store.list().total, 2);
  });

  for (const point of ["stageChunk", "insideCommit", "afterCommit"]) test(`abrupt exit ${point} recovers complete MIME and progress exactly once`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-mbox-exit-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "Inbox"), mbox([raw("One"), raw("Two")]));
    const child = spawnSync(process.execPath, [__filename, "--crash", dir, point], { encoding: "utf8", timeout: 20000 });
    assert.equal(child.status, 37, child.stderr);
    const store = L.createLocalStore(path.join(dir, "archive.sqlite")), importer = M.createImporter({ store });
    try {
      const job = importer.list()[0]; assert.equal(job.status, "interrupted"); assert.equal(job.imported, point === "afterCommit" ? 1 : 0);
      importer.start(job.id); await importer.idle(); assert.equal(importer.status(job.id).imported, 2); assert.equal(store.list().total, 2);
      store.list().emails.forEach(email => assert.match(store.raw(email.id).toString(), /Synthetic evidence/));
    } finally { await importer.stop(); store.close(); }
  });

  test("snapshot read, fsync and atomic-publication failures preserve original files and retry without acknowledged partial input", async t => {
    const f = fixture(t), source = f.source(mbox([raw("Snapshot faults")]));
    const original = fs.readFileSync(source), open = fs.promises.open, rename = fs.promises.rename;
    for (const point of ["read", "fsync", "rename"]) {
      let armed = true;
      fs.promises.open = async function (file, ...args) {
        if (armed && point === "read" && file === source) { armed = false; throw Object.assign(new Error("synthetic read denial"), { code: "EACCES" }); }
        const handle = await open.call(this, file, ...args);
        if (armed && point === "fsync" && String(file).endsWith(".partial")) {
          armed = false; handle.sync = async () => { throw Object.assign(new Error("synthetic sync failure"), { code: "EIO" }); };
        }
        return handle;
      };
      fs.promises.rename = async function (...args) {
        if (armed && point === "rename" && String(args[0]).endsWith(".partial")) { armed = false; throw Object.assign(new Error("synthetic publication failure"), { code: "EIO" }); }
        return rename.apply(this, args);
      };
      let result;
      try { result = await f.import([source]); }
      finally { fs.promises.open = open; fs.promises.rename = rename; }
      assert.equal(result.status, "failed", point); assert.equal(result.imported, 0); assert.equal(result.consumedBytes, 0); assert.deepEqual(fs.readFileSync(source), original);
      f.importer.start(result.id); await f.importer.idle();
      assert.equal(f.importer.status(result.id).status, "completed");
      assert.equal(f.store.list().total, 1, "repeat faults/retries keep a single verified copy");
    }
  });

  test("byte budgets pause at committed boundaries; worker deadlines fail one entry and keep later jobs usable", async t => {
    const f = fixture(t, { limits: { runBytes: 1 } });
    const result = await f.import([f.source(mbox([raw("One"), raw("Two")]))]); assert.equal(result.status, "paused"); assert.equal(result.imported, 1);
    await f.reopen({}); f.importer.start(result.id); await f.importer.idle(); assert.equal(f.importer.status(result.id).imported, 2);
    await f.reopen({ limits: { parseMs: 1 } });
    const deadline = await f.import([f.source(mbox([raw("Worker deadline")]), "Timeout")]); assert.equal(deadline.failed, 1); assert.match(deadline.errors[0].detail, /20 seconds/);
  });

  test("cancelling an actual MIME worker terminates it before any result can be acknowledged", async () => {
    const controller = new AbortController();
    const pending = M.parseMessage(raw("Cancel worker"), controller.signal, R.LIMITS);
    controller.abort(); await assert.rejects(pending, failure => failure.code === "mbox_cancelled");
  });

  test("bounded streaming yields before completion and does not retain archive-sized buffers", async t => {
    const f = fixture(t), source = path.join(f.dir, "Large-synthetic");
    const fd = fs.openSync(source, "w"); const body = raw("Large stream", "", ("x".repeat(4095) + "\n").repeat(256));
    for (let i = 0; i < 40; i++) fs.writeSync(fd, mbox([body])); fs.closeSync(fd);
    const handle = await fs.promises.open(source, "r"); let heartbeat = 0, count = 0, largest = 0;
    const timer = setInterval(() => heartbeat++, 1);
    try {
      for await (const entry of R.entries(handle, 0, { variant: "mboxrd", limits: { message: 2 * 1024 * 1024 } })) { count++; largest = Math.max(largest, entry.raw.length); }
    } finally { clearInterval(timer); await handle.close(); }
    assert.equal(count, 40); assert(largest < 2 * 1024 * 1024); assert(heartbeat > 5, "event loop must advance during the 40 MiB reader fixture");
    console.log(JSON.stringify({ syntheticMboxBytes: fs.statSync(source).size, largestRetainedMessage: largest, heartbeat }));
  });

  test("explicit snapshot removal keeps originals, local mail and duplicate receipts, and ends continuation", async t => {
    const f = fixture(t), source = f.source(mbox([raw("Retained") ])); const original = fs.readFileSync(source);
    const result = await f.import([source]); const removed = await f.importer.discard(result.id);
    assert.equal(removed.status, "discarded"); assert.equal(fs.existsSync(path.join(f.importer.root, result.id)), false);
    assert.deepEqual(fs.readFileSync(source), original); assert.equal(f.store.list().total, 1);
    assert.throws(() => f.importer.start(result.id), /finished/);
    assert.equal((await f.import([source])).skipped, 1);
  });
}

module.exports = { raw, mbox, fixture };
