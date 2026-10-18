// Offline work/latency probe. Real sql.js and engine, fake IMAP, no provider writes.
// Run: node scripts/probe-mail-persistence.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-persistence-probe-"));
process.env.MORROW_MAIL_DIR = dir;
process.env.MORROW_MAIL_SECRETS = "memory";
const db = require("../host/mail/db");
const engine = require("../host/mail/engine");
const remote = require("../host/mail/remote");
const secrets = require("../host/mail/secrets");
const folders = [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }];
const uids = Array.from({ length: 500 }, (_, i) => i + 1);
const write = fs.writeSync;
let written = 0;
let mainExports = 0;
let restoreExport;

remote.withClient = async (_account, _secret, fn) => fn({});
remote.listFolderRecords = async () => ({ folders, delimiter: "/" });
remote.searchUids = async () => ({ uids, validity: 1, exists: 500, unseen: 0 });
remote.fetchMessages = async () => { throw new Error("Warm fixture must not download messages."); };
const rows = (bodySize) => uids.map((uid) => ({ id: `m-${uid}`, uid, threadId: `t-${uid}`, subject: `Message ${uid}`,
  from: "sender@example.test", snippet: "Small preview", date: "2026-10-19T08:00:00Z", listSortTs: Date.now() - uid,
  textBody: bodySize ? "sample mail body ".repeat(Math.ceil(bodySize / 17)).slice(0, bodySize) : "", bodyComplete: bodySize > 0 }));

async function measure(fn) {
  written = 0;
  mainExports = 0;
  const at = performance.now();
  const timer = new Promise((resolve) => setTimeout(() => resolve(performance.now() - at), 0));
  await fn();
  const ms = performance.now() - at;
  return { ms: +ms.toFixed(2), timerDelayMs: +(await timer).toFixed(2), writtenBytes: written, mainExports };
}

async function shape(name) {
  // Drain seeding checkpoints so the measured paths cannot hide work in a timer.
  await db.checkpoint();
  await db.checkpoint();
  const before = fs.statSync(db.file());
  const flags = [];
  for (let i = 0; i < 3; i += 1) {
    const run = await measure(() => db.updateMessage("m-1", { starred: db.messageById("m-1").starred ? 0 : 1 }));
    assert.ok(run.writtenBytes > 0 && run.writtenBytes < 4096);
    assert.equal(run.mainExports, 0);
    flags.push(run);
  }
  const warm = await measure(() => engine.syncAccountById("fixture", { background: true }));
  assert.equal(warm.writtenBytes, 0);
  assert.equal(warm.mainExports, 0);
  assert.equal(fs.statSync(db.file()).mtimeMs, before.mtimeMs, "flag/sync must not replace the checkpoint");
  return { name, databaseBytes: before.size, flags, warm };
}

(async () => {
  await engine.init();
  const SQL = await require("sql.js")();
  const original = SQL.Database.prototype.export;
  SQL.Database.prototype.export = function (...args) { mainExports += 1; return original.apply(this, args); };
  restoreExport = () => { SQL.Database.prototype.export = original; };
  fs.writeSync = function (...args) { const n = write.apply(this, args); written += n; return n; };
  db.insertAccount({ id: "fixture", email: "fixture@example.test", username: "fixture", profile: "custom",
    imapHost: "imap.example.test", imapPort: 993, imapTls: true, smtpHost: "smtp.example.test", smtpPort: 465,
    smtpTls: true, createdAt: 1, authKind: "password" });
  secrets.setPassword("fixture", "synthetic-test-secret");
  db.replaceFolders("fixture", folders, "/");
  const seed = (bodySize) => db.applyFolderSync("fixture", "INBOX", { messages: rows(bodySize), validity: 1,
    exists: 500, unseen: 0, windowDone: true, horizonDays: 180, uidCursor: 500 });
  seed(0);
  const shapes = [await shape("500 header-only messages")];
  seed(32768);
  shapes.push(await shape("500 messages with 32 KiB indexed bodies"));
  db.saveBlob("attachment", "cache.bin", "application/octet-stream", Buffer.alloc(64 * 1024 * 1024, 65));
  shapes.push(await shape("same messages plus 64 MiB cached attachment"));
  // A full checkpoint is amortized and exported by the worker; the event loop
  // remains available while it runs. Report observations without timing gates.
  mainExports = 0;
  let ticks = 0;
  const interval = setInterval(() => { ticks += 1; }, 1);
  const at = performance.now();
  const checkpoint = await db.checkpoint();
  clearInterval(interval);
  assert.equal(mainExports, 0);
  assert.ok(ticks > 0);
  console.log(JSON.stringify({ node: process.versions.node, electron: process.versions.electron || null,
    platform: process.platform, shapes, checkpoint: { ...checkpoint, ms: +(performance.now() - at).toFixed(2),
      mainExports, mainEventLoopTicks: ticks } }, null, 2));
  console.log("MAIL_PERSISTENCE_PROBE_OK");
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  fs.writeSync = write;
  if (restoreExport) restoreExport();
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
