const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Worker } = require("node:worker_threads");

const db = require("../host/mail/db");
const account = { id: "persist", email: "persist@example.invalid", username: "persist", profile: "custom",
  createdAt: 1, imapHost: "imap.example.invalid", imapPort: 993, imapTls: true,
  smtpHost: "smtp.example.invalid", smtpPort: 465, smtpTls: true };
const folders = [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }];
const message = (uid, extra = {}) => ({ id: `p-${uid}`, uid, threadId: `t-${uid}`, subject: `Subject ${uid}`,
  from: "sender@example.invalid", date: "2026-10-19T00:00:00Z", listSortTs: Date.now(),
  textBody: "Searchable durable body", bodyComplete: true, ...extra });
const report = (messages = [], extra = {}) => ({ messages, validity: 1, exists: 3, unseen: 0,
  uids: [1, 2, 3], uidCursor: 3, windowDone: true, horizonDays: 180, ...extra });

async function seed(file) {
  await db.open(file);
  db.insertAccount(account);
  db.replaceFolders(account.id, folders, "/");
  db.applyFolderSync(account.id, "INBOX", report([1, 2, 3].map((uid) => message(uid))));
  await db.checkpoint();
}

async function measure(fn) {
  let bytes = 0;
  const original = fs.writeSync;
  fs.writeSync = function (...args) {
    const n = original.apply(this, args);
    bytes += n;
    return n;
  };
  try { await fn(); } finally { fs.writeSync = original; }
  return bytes;
}

function child(file, mode) {
  const result = spawnSync(process.execPath, [__filename, "--child", file, mode], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
}

async function checkHotPaths(dir) {
  const env = { MORROW_MAIL_DIR: process.env.MORROW_MAIL_DIR, MORROW_MAIL_SECRETS: process.env.MORROW_MAIL_SECRETS };
  process.env.MORROW_MAIL_DIR = dir;
  process.env.MORROW_MAIL_SECRETS = "memory";
  const engine = require("../host/mail/engine");
  const remote = require("../host/mail/remote");
  const secrets = require("../host/mail/secrets");
  const saved = { withClient: remote.withClient, listFolderRecords: remote.listFolderRecords,
    searchUids: remote.searchUids, fetchMessages: remote.fetchMessages };
  try {
    await engine.init();
    const file = db.file();
    await db.close();
    await seed(file);
    secrets.setPassword(account.id, "fixture-secret");
    db.saveBlob("attachment", "cache.bin", "application/octet-stream", Buffer.alloc(4 * 1024 * 1024, 73));
    await db.checkpoint();
    const snapshot = fs.readFileSync(file);
    remote.withClient = async (_account, _secret, work) => work({});
    remote.listFolderRecords = async () => ({ folders, delimiter: "/" });
    remote.searchUids = async () => ({ uids: [1, 2, 3], validity: 1, exists: 3, unseen: 0 });
    remote.fetchMessages = async () => { throw new Error("Warm fixture must not fetch messages."); };

    const flagBytes = await measure(() => db.updateMessage("p-1", { starred: 1 }));
    assert.ok(flagBytes > 0 && flagBytes < 4096, `One flag must write a small durable record: ${flagBytes}`);
    assert.equal(await measure(() => db.updateMessage("p-1", { starred: 1 })), 0, "unchanged flag writes nothing");
    assert.equal(await measure(async () => {
      for (let i = 0; i < 3; i += 1) await engine.syncAccountById(account.id, { background: true });
    }), 0, "warm unchanged sync must write neither snapshots nor journal records");
    assert.deepEqual(fs.readFileSync(file), snapshot, "hot paths must leave the SQLite checkpoint untouched");
    const observed = db.folderByPath(account.id, "INBOX").synced_at;
    assert.ok(observed >= Date.now() - 10000, "session freshness advances without a disk write");

    db.setAuthError(account.id, "fixture auth error");
    await engine.syncAccountById(account.id, { background: true });
    assert.equal(db.accountById(account.id).auth_error, null, "real auth changes still persist");
    db.replaceFolders(account.id, [{ ...folders[0], name: "Renamed Inbox" }], ".");
    db.applyFolderSync(account.id, "INBOX", report([], { unseen: 2, exists: 4 }));
    assert.equal(await measure(async () => {
      await db.close();
      await db.open(file);
    }), 0, "closing/reopening a migrated store does not rewrite it");
    assert.deepEqual(fs.readFileSync(file), snapshot);
    assert.equal(db.messageById("p-1").starred, 1);
    assert.equal(db.readBlob("attachment").data.length, 4 * 1024 * 1024);
    assert.equal(db.accountById(account.id).auth_error, null);
    assert.equal(db.accountById(account.id).delimiter, ".");
    assert.equal(db.folderByPath(account.id, "INBOX").name, "Renamed Inbox");
    assert.equal(db.folderByPath(account.id, "INBOX").unread, 2);
    assert.equal(db.folderByPath(account.id, "INBOX").total, 4);
    console.log(`mail-persistence-hot-paths-ok flagBytes=${flagBytes} warmSyncBytes=0`);
  } finally {
    Object.assign(remote, saved);
    secrets.deletePassword(account.id);
    await db.close();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function checkTransactions(file) {
  await seed(file);
  const journal = `${file}.journal`;
  const before = fs.statSync(journal).size;
  assert.throws(() => db.applyFolderSync(account.id, "INBOX", report([
    message(4, { id: "new-before-error", subject: "Rolledbackword" }),
    message(5, { id: "p-1" }),
  ], { keepOthers: true, uidCursor: 5 })), /UNIQUE/);
  assert.equal(db.messageById("new-before-error"), null);
  assert.deepEqual(db.searchMessages({ query: "Rolledbackword" }), []);
  assert.equal(db.folderByPath(account.id, "INBOX").uid_cursor, 3);
  assert.equal(fs.statSync(journal).size, before, "failed multi-statement transaction has no journal record");

  const write = fs.writeSync;
  let calls = 0;
  fs.writeSync = function (fd, data, offset, length) {
    if (++calls === 1) return write.call(this, fd, data, offset, Math.min(length, 17));
    throw new Error("Fixture partial write");
  };
  try { assert.throws(() => db.updateMessage("p-1", { starred: 1 }), /partial write/); }
  finally { fs.writeSync = write; }
  assert.equal(db.messageById("p-1").starred, 0);
  assert.equal(fs.statSync(journal).size, before);

  const sync = fs.fsyncSync;
  let syncs = 0;
  fs.fsyncSync = function (...args) {
    if (++syncs === 1) throw new Error("Fixture fsync failure");
    return sync.apply(this, args);
  };
  try { assert.throws(() => db.updateMessage("p-1", { starred: 1 }), /fsync failure/); }
  finally { fs.fsyncSync = sync; }
  assert.equal(db.messageById("p-1").starred, 0);
  assert.equal(fs.statSync(journal).size, before);
  db.updateMessage("p-2", { starred: 1, text_body: "Updatedindexword café" });
  const bytes = Uint8Array.from([0, 255, 73, 0, 42]);
  db.saveBlob("binary", "binary.bin", "application/octet-stream", bytes);
  db.insertScheduled({ id: "queued", accountId: account.id, payloadJson: "{}", sendAt: Date.now() + 100000, createdAt: 1 });
  db.scheduledToDraft("queued", { id: "draft", accountId: account.id, folderPath: "Drafts", isDraft: true,
    textBody: "Durabledraftword", date: "2026-10-19", listSortTs: 1 });
  await db.close();
  await db.open(file);
  assert.equal(db.messageById("p-2").starred, 1);
  assert.equal(db.searchMessages({ query: "updatedindexword" })[0].id, "p-2");
  assert.deepEqual(db.readBlob("binary").data, bytes);
  assert.equal(db.scheduledById("queued"), null);
  assert.equal(db.searchMessages({ query: "durabledraftword" })[0].id, "draft");
  db.applyFolderSync(account.id, "INBOX", report([], { uids: [2, 3], exists: 2 }));
  assert.equal(db.messageById("p-1"), null);
  db.applyFolderSync(account.id, "INBOX", report([], { validity: 2, uids: [], exists: 0, uidCursor: 0 }));
  await db.close();
  await db.open(file);
  assert.equal(db.countInFolder(account.id, "INBOX"), 0);
  assert.deepEqual(db.searchMessages({ query: "updatedindexword" }), []);
  assert.equal(db.folderByPath(account.id, "INBOX").uid_validity, 2);

  fs.fsyncSync = () => { throw new Error("Fixture persistent storage failure"); };
  try { assert.throws(() => db.updateMessage("draft", { starred: 1 }), /persistent storage failure/); }
  finally { fs.fsyncSync = sync; }
  assert.equal(db.isReady(), false, "uncertain storage errors must stop subsequent writes");
  await db.open(file);
  assert.equal(db.messageById("draft").starred, 0);
  await db.close();
}

async function checkCheckpoint(file) {
  await seed(file);
  db.updateMessage("p-1", { starred: 1 });
  const pending = db.checkpoint();
  db.updateMessage("p-2", { text_body: "Duringcheckpointword", unread: 1 });
  await pending;
  await db.close();
  await db.open(file);
  assert.equal(db.messageById("p-1").starred, 1);
  assert.equal(db.messageById("p-2").unread, 1);
  assert.equal(db.searchMessages({ query: "duringcheckpointword" })[0].id, "p-2");

  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === `${file}.journal.pending`) throw new Error("Fixture rotation failure");
    return rename(from, to);
  };
  try { await assert.rejects(db.checkpoint(), /rotation failure/); }
  finally { fs.renameSync = rename; }
  // Retrying without another mutation must reopen the journal's closed fd.
  await db.checkpoint();
  db.updateMessage("p-2", { unread: 0 });

  fs.mkdirSync(`${file}.tmp`);
  await assert.rejects(db.checkpoint(), /EISDIR/);
  assert.ok(fs.existsSync(`${file}.journal.pending`), "failed checkpoint retains its durable input");
  db.updateMessage("p-3", { starred: 1 });
  fs.rmdirSync(`${file}.tmp`);
  await db.checkpoint();
  await db.close();
  await db.open(file);
  assert.equal(db.messageById("p-3").starred, 1);
  for (let i = 0; i < 300; i += 1) db.updateMessage("p-1", { starred: i % 2 });
  assert.ok(fs.statSync(`${file}.journal`).size > 0);
  const deadline = Date.now() + 15000;
  while (fs.statSync(`${file}.journal`).size || fs.existsSync(`${file}.journal.pending`)) {
    assert.ok(Date.now() < deadline, "background checkpoint must compact an accumulated journal");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await db.close();
}

async function checkCrashes(dir) {
  for (const phase of ["before-rename", "after-rename"]) {
    const file = path.join(dir, `${phase}.sqlite`);
    await seed(file);
    db.updateMessage("p-1", { starred: 1 });
    await db.close();
    fs.renameSync(`${file}.journal`, `${file}.journal.pending`);
    // Run the real checkpoint worker, exiting at the atomic replacement boundary.
    await new Promise((resolve, reject) => {
      const worker = new Worker(`
        const fs = require('node:fs');
        const { workerData, parentPort } = require('node:worker_threads');
        const rename = fs.renameSync;
        fs.renameSync = (from, to) => {
          if (to === workerData.file) {
            if (workerData.phase === 'after-rename') rename(from, to);
            parentPort.postMessage({crashBoundary: workerData.phase});
            process.exit(0);
          }
          return rename(from, to);
        };
        require(workerData.module);
      `, { eval: true, workerData: { file, morrowCheckpointWorker: true, phase,
        module: require.resolve("../host/mail/persistence") } });
      worker.on("message", ({ crashBoundary }) => {
        assert.equal(crashBoundary, phase);
        worker.unref();
        resolve();
      });
      worker.on("error", reject);
      worker.on("exit", (code) => { if (code !== 0) reject(new Error(`Worker exited ${code}`)); });
      worker.postMessage({ file, pending: `${file}.journal.pending` });
    });
    await db.open(file);
    assert.equal(db.messageById("p-1").starred, 1, `${phase} recovers exactly once`);
    db.updateMessage("p-2", { starred: 1 });
    await db.checkpoint();
    await db.close();
    await db.open(file);
    assert.equal(db.messageById("p-2").starred, 1);
    await db.close();
  }

  const file = path.join(dir, "process-exit.sqlite");
  await seed(file);
  await db.close();
  child(file, "committed");
  child(file, "torn-header");
  await db.open(file);
  assert.equal(db.messageById("p-1").starred, 1, "acknowledged flag survives exit without close/checkpoint");
  assert.equal(db.messageById("p-2").starred, 0, "torn transaction is discarded");
  db.updateMessage("p-3", { starred: 1 });
  await db.close();
  child(file, "torn-body");
  await db.open(file);
  assert.equal(db.messageById("p-3").starred, 1, "new appends remain reachable after tail repair");
  assert.equal(db.messageById("p-2").starred, 0);
  await db.close();

  const journal = `${file}.journal`;
  const good = fs.readFileSync(journal);
  for (const byte of [8, 81]) {
    const broken = Buffer.from(good);
    broken[byte] ^= 1;
    fs.writeFileSync(journal, broken);
    await assert.rejects(db.open(file), /checksum mismatch/);
    assert.deepEqual(fs.readFileSync(journal), broken, "corruption must not be silently truncated");
  }
  fs.writeFileSync(journal, good);
  const other = path.join(dir, "different-generation.sqlite");
  await seed(other);
  await db.close();
  fs.writeFileSync(`${other}.journal`, good);
  await assert.rejects(db.open(other), /generation or sequence mismatch/);
  // Remove a complete first transaction: a valid checksum cannot hide a gap.
  fs.writeFileSync(journal, good.subarray(80 + good.readUInt32BE(8)));
  await assert.rejects(db.open(file), /transaction gap/);
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-persistence-"));
  try {
    await checkHotPaths(path.join(dir, "hot"));
    await checkTransactions(path.join(dir, "transactions.sqlite"));
    await checkCheckpoint(path.join(dir, "checkpoint.sqlite"));
    await checkCrashes(dir);
    console.log("mail-persistence-recovery-ok");
  } finally {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  (async () => {
    if (process.argv[2] !== "--child") return run();
    const [, , , file, mode] = process.argv;
    await db.open(file);
    if (mode.startsWith("torn-")) {
      const write = fs.writeSync;
      let calls = 0;
      fs.writeSync = function (fd, data, offset, length) {
        calls += 1;
        if (mode === "torn-body" && calls === 1) return write.call(this, fd, data, offset, length);
        write.call(this, fd, data, offset, Math.min(length, 17));
        process.exit(0);
      };
    }
    db.updateMessage(mode === "committed" ? "p-1" : "p-2", { starred: 1 });
    process.exit(0);
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { run };
