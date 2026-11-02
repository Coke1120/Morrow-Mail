"use strict";

// Real ZIP worker, synthetic bytes and DOM; no provider, mailbox or native window.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { EventEmitter, getEventListeners } = require("node:events");
const { createZipQueue } = require("../host/mail/zip-worker");
const { zipFilesAsync, unzipFiles } = require("../host/mail/zip-bytes");
const tick = () => new Promise(resolve => setImmediate(resolve));

async function workerChecks() {
  const source = crypto.randomBytes(16 * 1024 * 1024), originalHash = crypto.createHash("sha256").update(source).digest("hex");
  let heartbeat = false;
  setImmediate(() => { heartbeat = true; });
  const packed = await zipFilesAsync([{ name: "../same.bin", data: source }, { name: "same.bin", data: Buffer.from("second") }]);
  assert(heartbeat, "ZIP CPU work must allow other host callbacks before completion");
  const files = unzipFiles(packed);
  assert.deepEqual(files.map(file => file.name), ["same.bin", "same-2.bin"]);
  assert.deepEqual(files[0].data, source); assert.equal(files[1].data.toString(), "second");
  assert.equal(crypto.createHash("sha256").update(source).digest("hex"), originalHash, "worker must not detach/mutate another consumer's bytes");
  assert.equal(unzipFiles(await zipFilesAsync([])).length, 0, "small pooled ZIP output transfers correctly");
  const known = await zipFilesAsync([{ name: "known", data: Buffer.from("123456789") },
    { name: "compressible", data: Buffer.alloc(1024 * 1024, 65) }]);
  assert.equal(known.readUInt32LE(14), 0xcbf43926, "worker preserves the standard CRC-32 vector");
  assert.deepEqual(unzipFiles(known)[1].data, Buffer.alloc(1024 * 1024, 65));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(zipFilesAsync([], { signal: aborted.signal }), { code: "cancelled" });
  const active = new AbortController(), task = zipFilesAsync([{ name: "large", data: source }], { signal: active.signal });
  const stopped = assert.rejects(task, { code: "cancelled" }); active.abort(); await stopped;
  assert.deepEqual(unzipFiles(await zipFilesAsync([{ name: "retry", data: Buffer.from("ok") }]))[0].data, Buffer.from("ok"));
}

async function queueChecks() {
  const workers = [];
  class ControlledWorker extends EventEmitter {
    constructor() { super(); workers.push(this); }
    terminate() { queueMicrotask(() => this.emit("exit", 1)); return Promise.resolve(1); }
    complete() { this.emit("message", { data: Uint8Array.of(1) }); this.emit("exit", 0); }
  }
  const service = createZipQueue({ WorkerClass: ControlledWorker, maxJobs: 2, maxBytes: 8 });
  const input = [{ name: "file", data: Buffer.alloc(4) }], a = new AbortController(), b = new AbortController();
  const first = service.zip(input, { signal: a.signal }), second = service.zip(input, { signal: b.signal });
  const firstRejected = assert.rejects(first, { code: "cancelled" }), secondRejected = assert.rejects(second, { code: "cancelled" });
  assert.equal(workers.length, 1); assert.deepEqual(service.stats(), { active: 1, queued: 1, bytes: 8 });
  await assert.rejects(service.zip(input), /Too many/);
  b.abort(); await secondRejected; assert.equal(workers.length, 1, "queued cancellation starts no worker");
  a.abort(); assert.equal(service.stats().active, 1, "ownership stays until confirmed exit");
  await firstRejected; await tick(); assert.deepEqual(service.stats(), { active: 0, queued: 0, bytes: 0 });
  assert.equal(getEventListeners(a.signal, "abort").length, 0);
  assert.equal(getEventListeners(b.signal, "abort").length, 0);
  const failed = service.zip(input), failure = assert.rejects(failed, /synthetic/);
  const next = service.zip(input); workers.at(-1).emit("error", new Error("synthetic worker failure"));
  assert.equal(workers.length, 2); workers.at(-1).emit("exit", 1); await failure;
  assert.equal(workers.length, 3); workers.at(-1).complete(); await next;
  for (const event of ["exit", "message"]) {
    const broken = service.zip(input), rejected = assert.rejects(broken, /stopped|invalid/);
    workers.at(-1).emit(event, event === "message" ? null : 1);
    if (event === "message") workers.at(-1).emit("exit", 0);
    await rejected; assert.deepEqual(service.stats(), { active: 0, queued: 0, bytes: 0 });
  }
  const bytes = createZipQueue({ WorkerClass: ControlledWorker, maxBytes: 3 });
  await assert.rejects(bytes.zip(input), /Too many/); assert.equal(bytes.stats().bytes, 0);
  const spawn = createZipQueue({ WorkerClass: class { constructor() { throw new Error("synthetic spawn failure"); } } });
  await assert.rejects(spawn.zip(input), /spawn failure/); assert.equal(spawn.stats().bytes, 0);
}

function sidebarChecks() {
  const { JSDOM } = require("jsdom"), { renderer } = require("./check-ux-workflows");
  const dom = new JSDOM(fs.readFileSync(require.resolve("../renderer/index.html"), "utf8"));
  try {
    const ui = renderer({ document: dom.window.document });
    ui.context.window.morrowFeaturesCatalog = require("../renderer/features-catalog");
    ui.run(`state.view='agent';state.accountId='fixture';state.folderId='folder-1';call=async()=>null;
      state.accounts=[{id:'fixture',email:'fixture@example.invalid',platform:'imap',imapSmtpProfile:'custom',folders:{primary:[],
        more:Array.from({length:500},(_,i)=>({id:'folder-'+i,name:'Folder '+i,unreadCount:i%2}))}}];
      renderAccounts();globalThis.retained=document.querySelector('button.folder');
      globalThis.copied=0;globalThis.originalFoldersOf=foldersOf;
      foldersOf=function(account){const rows=originalFoldersOf(account);copied+=rows.length;return rows};
      state.accounts[0].folders.more[1].unreadCount=42;renderAccounts();`);
    assert.equal(ui.run("retained===document.querySelector('button.folder')"), true);
    assert(ui.run("copied") <= 500 * 8, "unchanged sidebar must do linear folder lookup work");
    const selected = dom.window.document.querySelector('button.folder[data-folder-id="folder-1"]');
    assert.equal(selected.querySelector(".count").textContent, "42");
    assert.equal(selected.getAttribute("aria-current"), "true");
    assert.match(ui.run("attachmentTaskCopy({phase:'packing',label:'Save ZIP'})"), /Creating ZIP/);
    assert.match(ui.run("attachmentTaskCopy({phase:'waitingToSave',label:'Save ZIP'})"), /Waiting to save/);
    ui.run("paintFeatureCatalog()");
    assert.match(dom.window.document.getElementById("features-catalog").textContent, /ZIP preparation runs one at a time/);
    assert.match(dom.window.document.getElementById("features-catalog").textContent, /cannot undo a file already written/);
  } finally { dom.window.close(); }
}

async function run() { await workerChecks(); await queueChecks(); sidebarChecks(); console.log("responsive-attachments-ok: worker parity/heartbeat/cancellation/admission/recovery, retained sidebar linear lookups, rendered help"); }
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
