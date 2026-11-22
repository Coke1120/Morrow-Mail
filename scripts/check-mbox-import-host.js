"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const Module = require("node:module");
const L = require("../host/mail/local-folders");

test("actual preload/picker/engine imports MIME offline, tracks update admission and survives cache cleanup/account removal/reopen", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-mbox-host-"));
  const env = { MORROW_MAIL_DIR: dir, MORROW_USER_DATA: dir, MORROW_MAIL_SECRETS: "memory" }, previous = { ...process.env };
  Object.assign(process.env, env);
  const originalLoad = Module._load;
  let picked, cancelled = false, exported;
  Module._load = function (name, ...args) {
    if (name === "electron") return { BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
      dialog: { showOpenDialog: async (_win, options) => { assert(options.properties.includes("openFile")); assert(!options.properties.includes("openDirectory")); return { canceled: cancelled, filePaths: [picked] }; },
        showSaveDialog: async () => ({ canceled: false, filePath: exported }) } };
    return originalLoad.call(this, name, ...args);
  };
  const engine = require("../host/mail/engine"), db = require("../host/mail/db"), remote = require("../host/mail/remote"), secrets = require("../host/mail/secrets");
  const originalClient = remote.withClient, originalSecret = secrets.getPasswordAsync;
  const gate = require("../host/update-quiescence").gate;
  let providerCalls = 0, secretReads = 0;
  t.after(async () => {
    gate.resume(); await engine.stopLocalImports(); engine.closeLocalArchiveForTest(); await db.close();
    remote.withClient = originalClient; secrets.getPasswordAsync = originalSecret; Module._load = originalLoad;
    for (const key of Object.keys(env)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await engine.init();
  remote.withClient = async () => { providerCalls++; throw new Error("A local import must not contact a provider"); };
  secrets.getPasswordAsync = async () => { secretReads++; throw new Error("A local import must not read credentials"); };
  db.insertAccount({ id: "synthetic-account", email: "owner@fixture.invalid", username: "owner@fixture.invalid", profile: "custom", createdAt: 1,
    imapHost: "imap.fixture.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.fixture.invalid", smtpPort: 587, smtpTls: true });
  const mime = await remote.buildRaw({ from: "sender@fixture.invalid", to: "owner@fixture.invalid", subject: "Imported offline fixture",
    text: "Searchable synthetic offline source", attachments: [{ filename: "binary.bin", content: Buffer.from([0, 255, 42, 13, 10]) }] });
  picked = path.join(dir, "Thunderbird-Export"); exported = path.join(dir, "exported.eml");
  fs.writeFileSync(picked, Buffer.concat([Buffer.from("From - Thu Nov  5 10:00:00 2026\n"), mime]));
  let preload;
  vm.runInNewContext(fs.readFileSync(require.resolve("../renderer/preload"), "utf8"), { require: name => {
    assert.equal(name, "electron"); return { contextBridge: { exposeInMainWorld(_name, api) { preload = api; } },
      ipcRenderer: { invoke: (channel, params) => engine.answer(channel, [params]), on() {} } };
  } });
  cancelled = true; assert.equal((await preload.invoke("mail:mboxPick")).data.cancelled, true);
  cancelled = false; const selected = await preload.invoke("mail:mboxPick", { paths: ["/ignored-renderer-path"] });
  assert.equal(selected.success, true, JSON.stringify(selected)); assert.equal(selected.data.files[0].name, "Thunderbird-Export");
  assert.equal(selected.data.files[0].source, undefined, "renderer receives no reusable arbitrary file-path API");
  const started = await preload.invoke("mail:mboxStart", { jobId: selected.data.id, folderId: L.ARCHIVE_ID, variant: "mboxrd" });
  assert.equal(started.success, true, JSON.stringify(started)); assert(gate.pending > 0, "whole import participates in updater quiescence");
  await assert.rejects(gate.prepare({ timeoutMs: 1 }), /still running/); gate.resume();
  let status;
  for (let i = 0; i < 200; i++) {
    status = (await preload.invoke("mail:mboxStatus", { jobId: selected.data.id })).data;
    if (!status.running) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(status.status, "completed", JSON.stringify(status)); assert.equal(status.imported, 1);
  assert.equal(engine.answer("mail:listAccounts", []).data.length, 1, "local import does not become a provider account");
  assert.equal(db.countInFolder("synthetic-account", "INBOX"), 0, "provider cache is untouched");
  assert.equal((await preload.invoke("mail:mboxDiscard", { jobId: selected.data.id })).success, false, "snapshot removal requires separate explicit review");
  assert.equal((await engine.answer("mail:removeAccount", [{ accountId: "synthetic-account" }])).success, true);
  await engine.stopLocalImports(); engine.closeLocalArchiveForTest();
  const local = await preload.invoke("mail:listFromCache", { accountId: L.ACCOUNT_ID, folderId: L.ARCHIVE_ID });
  assert.equal(local.data.total, 1); const id = local.data.emails[0].id;
  const opened = (await preload.invoke("mail:openEmail", { emailId: id, accountId: L.ACCOUNT_ID })).data.email;
  assert.match(opened.textBody, /synthetic offline/);
  const bytes = await preload.invoke("mail:fetchAttachmentBytes", { emailId: id, accountId: L.ACCOUNT_ID, attachmentId: opened.attachments[0].id, requestId: "synthetic-mbox" });
  assert.deepEqual(bytes.data, Buffer.from([0, 255, 42, 13, 10]));
  const results = (await preload.invoke("mail:searchLocal", { accountId: L.ACCOUNT_ID, query: "synthetic offline" })).data; assert.equal(results.length, 1);
  assert.equal((await preload.invoke("mail:exportLocalMessage", { accountId: L.ACCOUNT_ID, emailId: id })).success, true);
  assert.deepEqual(fs.readFileSync(exported), mime);
  assert.equal((await preload.invoke("mail:mboxJobs")).data[0].imported, 1);
  assert.deepEqual([providerCalls, secretReads], [0, 0]);
  await assert.rejects(preload.invoke("mail:mboxReadArbitraryPath", { path: picked }), /Unsupported channel/);
});

function importFixture(t, { beforeWrite, ...options } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-mbox-removal-"));
  const source = path.join(dir, "source.mbox");
  const message = subject => `From - Thu Nov  5 10:00:00 2026\nFrom: sender@fixture.invalid\nTo: owner@fixture.invalid\nSubject: ${subject}\n\nSynthetic local message\n`;
  const contents = message("First") + message("Second");
  fs.writeFileSync(source, contents);
  const store = L.createLocalStore(path.join(dir, "local-folders.sqlite"));
  const { createImporter } = require("../host/mail/mbox-import");
  if (beforeWrite) {
    const jobs = store.importJobs();
    store.importJobs = () => ({ ...jobs, write(job) { beforeWrite(job); jobs.write(job); } });
  }
  const importer = createImporter({ store, ...options });
  t.after(async () => {
    await importer.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { importer, store, source, contents };
}

test("confirmed snapshot removal excludes Continue and finishes before shutdown", async t => {
  const { importer, store, source, contents } = importFixture(t, { limits: { runBytes: 1 } });
  const { id } = await importer.select([source]);
  importer.start(id, { destination: L.ARCHIVE_ID, variant: "mboxrd" });
  await importer.idle();
  assert.equal(importer.status(id).status, "paused");
  assert.equal(store.list().total, 1);
  const removal = importer.discard(id);
  try {
    assert.throws(() => importer.start(id), { code: "mbox_busy" });
    await importer.stop();
    assert.equal(importer.status(id).status, "discarded");
  } finally {
    await removal;
    await importer.idle();
  }
  assert.equal(importer.status(id).canContinue, false);
  assert.equal(fs.existsSync(path.join(importer.root, id)), false);
  assert.equal(fs.readFileSync(source, "utf8"), contents);
  assert.equal(store.list().total, 1);
});

test("an early snapshot EOF cannot acknowledge unread input", async t => {
  const { importer, store, source, contents } = importFixture(t, { beforeWrite(job) {
    if (job.status === "importing") fs.truncateSync(path.join(importer.root, job.id, "0.mbox"), 0);
  } });
  const { id } = await importer.select([source]);
  importer.start(id, { destination: L.ARCHIVE_ID, variant: "mboxrd" });
  await importer.idle();
  const status = importer.status(id);
  assert.equal(status.status, "failed");
  assert.equal(status.consumedBytes, 0);
  assert.equal(store.list().total, 0);
  assert.equal(fs.readFileSync(source, "utf8"), contents);
});

test("a readable job with a failed progress write shows the durable checkpoint", async t => {
  let failWrites = true;
  const { importer, store, source } = importFixture(t, { beforeWrite(job) {
    if (failWrites && (job.imported || job.status === "failed")) throw Error("Synthetic SQLite write failure");
  } });
  const { id } = await importer.select([source]);
  importer.start(id, { destination: L.ARCHIVE_ID, variant: "mboxrd" });
  await importer.idle();
  const status = importer.status(id);
  assert.equal(status.status, "interrupted");
  assert.equal(status.running, false);
  assert.equal(status.consumedBytes, 0);
  assert.equal(store.list().total, 0);
  failWrites = false;
  importer.start(id);
  await importer.idle();
  assert.equal(importer.status(id).imported, 2);
  assert.equal(store.list().total, 2);
});

test("import budgets ignore wall clock changes and phase bytes restart on verification and import", async t => {
  const baseTime = Date.now();
  let skew = 0;
  t.mock.method(Date, "now", () => baseTime + skew);
  const phases = new Map();
  const { importer, source } = importFixture(t, {
    limits: { runMs: 10000 },
    beforeWrite(job) {
      if (["verifying", "importing"].includes(job.status) && !phases.has(job.status)) {
        phases.set(job.status, importer.status(job.id).phaseBytes);
      }
    },
    hooks: { stageChunk() { skew = 60000; } },
  });
  const { id } = await importer.select([source]);
  importer.start(id, { destination: L.ARCHIVE_ID, variant: "mboxrd" });
  await importer.idle();
  assert.equal(importer.status(id).status, "completed");
  assert.deepEqual([...phases], [["verifying", 0], ["importing", 0]]);
});

test("if the final removal status cannot be saved, only snapshot removal can be retried", async t => {
  let failFinal = true;
  const { importer, store, source } = importFixture(t, {
    limits: { runBytes: 1 },
    beforeWrite(job) {
      if (failFinal && job.status === "discarded") throw Error("Synthetic SQLite write failure");
    },
  });
  const { id } = await importer.select([source]);
  importer.start(id, { destination: L.ARCHIVE_ID, variant: "mboxrd" });
  await importer.idle();
  await assert.rejects(importer.discard(id), /SQLite write failure/);
  assert.equal(importer.status(id).canContinue, false);
  assert.throws(() => importer.start(id), { code: "mbox_finished" });
  failFinal = false;
  assert.equal((await importer.discard(id)).status, "discarded");
  assert.equal(store.list().total, 1);
});
