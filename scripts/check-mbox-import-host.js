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
