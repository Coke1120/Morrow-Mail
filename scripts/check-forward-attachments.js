// Offline forwarding regressions. Synthetic providers and temporary production
// SQLite/MIME, plus the actual preload and renderer. Never send real mail.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { JSDOM } = require("jsdom");
const { renderer } = require("./check-ux-workflows");
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function gate() { let release; const wait = new Promise(resolve => { release = resolve; }); return { wait, release }; }

async function rendererChecks() {
  const dom = new JSDOM(fs.readFileSync(require.resolve("../renderer/index.html"), "utf8"));
  const document = dom.window.document, calls = [], opened = [], jobs = new Map(), listeners = new Set();
  let bridge;
  vm.runInNewContext(fs.readFileSync(require.resolve("../renderer/preload"), "utf8"), {
    require: name => { assert.equal(name, "electron"); return {
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { invoke: async (channel, payload) => {
        calls.push({ channel, payload });
        if (channel === "compose:open") { opened.push(clone(payload)); return { ok: true }; }
        if (channel === "mail:cancelAttachmentRequest") {
          jobs.get(payload.requestId)?.reject(new Error("cancelled")); return { success: true, data: true };
        }
        if (channel !== "mail:prepareForward") throw new Error("Unexpected IPC: " + channel);
        return new Promise((resolve, reject) => { jobs.set(payload.requestId, { resolve, reject }); });
      }, on: (_channel, fn) => listeners.add(fn), removeListener: (_channel, fn) => listeners.delete(fn), send() {} },
    }; },
  });
  const ui = renderer({ document, crypto, window: { morrow: bridge } });
  ui.context.window.morrowFeaturesCatalog = require("../renderer/features-catalog");
  ui.run(`globalThis.source={id:'original',accountId:'box',from:'Sender <sender@fixture.invalid>',subject:'Files',textBody:'Original body',hasAttachments:true,
    attachments:[{id:'one',filename:'same.txt',mimeType:'text/plain',size:3},{id:'two',filename:'same.txt',mimeType:'text/plain',size:3}]};
    globalThis.seed=composeSeed(source,'forward','owner@fixture.invalid');`);
  const preparedFiles = ["one", "two"].map(id => ({ id, filename: "same.txt", mimeType: "text/plain", size: 3, storageUrl: "local:" + id }));
  const result = files => ({ success: true, data: { emailId: "original", accountId: "box", attachments: files } });
  try {
    const first = ui.run("presentCompose(seed)"), repeated = ui.run("presentCompose(seed)");
    assert.equal(first, repeated, "repeat Forward joins one preparation and opens one window");
    assert.equal(calls.length, 1); assert.equal(calls[0].channel, "mail:prepareForward");
    assert.deepEqual(clone(calls[0].payload.attachmentIds), ["one", "two"]);
    assert.equal(calls[0].payload.accountId, "box"); assert.equal(opened.length, 0);
    assert.equal(ui.run("state.busy"), false, "file preparation leaves mailbox navigation available");
    assert.match(document.querySelector(".attachment-task-list").textContent, /Forward attachments/);
    jobs.get(calls[0].payload.requestId).resolve(result(preparedFiles)); await first;
    assert.equal(opened.length, 1); assert.deepEqual(opened[0].attachments, preparedFiles);
    assert.match(opened[0].quote, /Original body/); assert.doesNotMatch(opened[0].quote, /not included/);
    assert.equal(listeners.size, 0); assert.equal(ui.run("forwardComposes.size"), 0);

    ui.context.prepared = opened[0];
    ui.run(`state.composeMeta={accountId:'box',fromAddress:'owner@fixture.invalid',kind:'forward',sourceMessageId:'original'};
      state.composeAttachments=prepared.attachments; state.composeQuote=quoteStateFromSeed(prepared);
      state.composeInitializing=false;state.composePending=false;state.composeQueued=false;
      readComposeEditorHtml=()=>'';$('compose-body').value='Please see these files.';$('compose-to').value='recipient@fixture.invalid';
      $('compose-subject').value=prepared.subject;paintComposeAttachments();`);
    assert.equal(document.querySelectorAll("#compose-attachments li").length, 2);
    const payload = clone(ui.run("composePayload({id:'box',email:'owner@fixture.invalid'})"));
    assert.deepEqual(payload.attachments, preparedFiles);
    assert.equal(ui.run("previewDraft(composeFields(),state.composeQuote.text,null,state.composeAttachments).attachments.length"), 2);
    ui.run("removeComposeAttachment('local:one')");
    assert.equal(ui.run("composePayload({id:'box'}).attachments.length"), 1, "an explicitly removed file stays removed");
    assert.equal(opened[0].attachments.length, 2, "compose removal does not mutate the source seed");

    for (const failure of ["provider failure", "cancelled"]) {
      const pending = ui.run("presentCompose(seed)");
      const rejected = assert.rejects(pending, new RegExp(failure));
      const request = calls.at(-1).payload;
      if (failure === "cancelled") ui.run("cancelAttachmentTask([...attachmentTasks.values()][0])");
      else jobs.get(request.requestId).reject(new Error(failure));
      await rejected; await tick(); assert.equal(opened.length, 1);
      assert.equal(ui.run("forwardComposes.size"), 0); assert.equal(listeners.size, 0);
    }
    // Host completion can win the IPC cancellation race. Even if there is no
    // longer a host request to abort, the cancelled forward must stay closed.
    const cancelledLate = ui.run("presentCompose(seed)");
    const lateRejected = assert.rejects(cancelledLate, /cancelled/);
    const lateId = calls.at(-1).payload.requestId, lateJob = jobs.get(lateId);
    jobs.delete(lateId);
    ui.run("cancelAttachmentTask([...attachmentTasks.values()][0])");
    lateJob.resolve(result(preparedFiles)); await lateRejected;
    assert.equal(opened.length, 1);
    const incomplete = ui.run("presentCompose(seed)");
    const rejected = assert.rejects(incomplete, /could not be prepared/);
    jobs.get(calls.at(-1).payload.requestId).resolve(result(preparedFiles.slice(0, 1)));
    await rejected; assert.equal(opened.length, 1, "partial preparation never opens compose");
    const retry = ui.run("presentCompose(seed)");
    jobs.get(calls.at(-1).payload.requestId).resolve(result(preparedFiles)); await retry;
    assert.equal(opened.length, 2, "failed/cancelled preparation can be retried");
    const reads = calls.filter(c => c.channel === "mail:prepareForward").length;
    await ui.run("presentCompose({...seed,draftId:'saved',attachments:prepared.attachments})");
    await ui.run("presentCompose({...seed,recoveredSnapshot:true,attachments:prepared.attachments})");
    await ui.run("presentCompose(composeSeed({...source,attachments:[],hasAttachments:false},'forward',''))");
    await ui.run("presentCompose(composeSeed(source,'reply','owner@fixture.invalid'))");
    assert.equal(calls.filter(c => c.channel === "mail:prepareForward").length, reads, "saved/recovered work and replies do not re-add source files");
    await assert.rejects(bridge.invoke("mail:unknown"), /Unsupported channel/);
    ui.run("paintFeatureCatalog()");
    assert.match(document.getElementById("features-catalog").textContent, /Forward prepares every original attachment/);
    assert.match(document.getElementById("features-catalog").textContent, /cancelled or changed-source preparation opens no partial forward/);
    assert.match(document.querySelector(".compose-files").textContent, /Review or remove them/);
    // Exercise the click handlers too: a download must not keep guard's
    // shell-wide busy flag set and prevent unrelated mailbox work.
    ui.run(`globalThis.forwardRunCount=0;globalThis.forwardHeld=new Promise(resolve=>globalThis.finishForward=resolve);
      globalThis.runForward=()=>{forwardRunCount++;return forwardHeld};
      globalThis.readerForward=readerButton('forward','Forward',runForward);
      globalThis.rowForward=rowAction('forward','Forward',runForward);
      readerForward.click();rowForward.click();`);
    await tick(); assert.equal(ui.run("forwardRunCount"), 2); assert.equal(ui.run("state.busy"), false);
    ui.run("state.busy=true;readerForward.click();rowForward.click();state.busy=false;finishForward()");
    await tick(); assert.equal(ui.run("forwardRunCount"), 2, "another pending mailbox action still blocks a fresh Forward");
    console.log("forward-renderer-ok: real preload, repeated clicks, cancel/failure/retry, compose/remove/preview/payload and rendered help");
  } finally { dom.window.close(); }
}

async function hostChecks() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-forward-files-"));
  Object.assign(process.env, { MORROW_MAIL_DIR: directory, MORROW_USER_DATA: directory, MORROW_AI_CONFIG_DIR: directory,
    MORROW_MAIL_SECRETS: "memory", MORROW_GMAIL_PACE: "0",
    MORROW_GOOGLE_OAUTH_JSON: JSON.stringify({ installed: { client_id: "forward-fixture.apps.googleusercontent.com", client_secret: "fixture-only" } }) });
  delete process.env.MORROW_GOOGLE_OAUTH_FILE;
  const { server, message } = require("./gmail-fixture");
  const db = require("../host/mail/db"), engine = require("../host/mail/engine"), remote = require("../host/mail/remote");
  const secrets = require("../host/mail/memory-secrets"), { createSession } = require("../host/mail/gmail-session");
  const { simpleParser } = require("mailparser");
  const original = { fetch: global.fetch, readPart: remote.readPart, withClient: remote.withClient, saveBlob: db.saveBlob };
  const service = server([]); global.fetch = service.fetcher;
  const source = message("forward-files");
  source.payload = { ...source.payload, mimeType: "multipart/mixed", body: undefined, parts: [
    { partId: "0", mimeType: "text/plain", body: { data: Buffer.from("Original body").toString("base64url") } },
    { partId: "1", filename: "same.txt", mimeType: "text/plain", body: { data: Buffer.from("FIRST").toString("base64url") } },
    { partId: "2", filename: "same.txt", mimeType: "text/plain", body: { data: Buffer.from("SECOND").toString("base64url") } },
    { partId: "3", filename: "logo.png", mimeType: "image/png", headers: [{ name: "Content-ID", value: "<logo>" }], body: { data: Buffer.from("IMAGE").toString("base64url") } },
  ] };
  try {
    await engine.init();
    db.insertAccount({ id: "gmail", email: "owner@fixture.invalid", username: "owner", profile: "gmail", authKind: "oauth2", createdAt: 1,
      imapHost: "imap.fixture.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.fixture.invalid", smtpPort: 465, smtpTls: true });
    db.enableGmail("gmail");
    secrets.setPassword("gmail", JSON.stringify({ provider: "google", googleClientId: "forward-fixture.apps.googleusercontent.com", accessToken: "synthetic",
      refreshToken: "synthetic", expiresAt: Date.now() + 3600000, grantedScopes: require("../host/mail/oauth-config").SCOPES.google }));
    const session = createSession(db.accountById("gmail"), "synthetic", { api: service.api() });
    db.replaceFolders("gmail", (await session.folders()).folders);
    service.messages.set(source.id, source); await session.adopt(source, { full: true });
    remote.withClient = async (_account, _secret, work) => work({ gmail: session });
    const row = db.gmailCopies("gmail", source.id)[0], before = clone(row);
    const files = db.jsonList(row.attachments_json), input = { emailId: row.id, accountId: row.account_id, attachmentIds: files.map(file => file.id) };
    const ask = async (channel, params = input, owner) => {
      const result = await engine.answer(channel, [params], { sender: owner });
      assert.equal(result.success, true, JSON.stringify(result)); return result.data;
    };
    const prepared = await ask("mail:prepareForward");
    const bytes = rows => rows.map(file => Buffer.from(db.readBlob(file.storageUrl.slice(6)).data).toString());
    assert.deepEqual(bytes(prepared.attachments), ["FIRST", "SECOND", "IMAGE"]);
    assert.deepEqual(prepared.attachments.map(file => file.filename), ["same.txt", "same.txt", "logo.png"]);
    assert.equal(prepared.attachments[2].contentId, "logo");
    assert.deepEqual(clone(db.messageById(row.id)), before, "preparation does not edit or mark source mail");
    const payload = { accountId: "gmail", fromAddress: "owner@fixture.invalid", to: "recipient@fixture.invalid", kind: "forward", sourceMessageId: row.id,
      subject: "Fwd: Files", body: "<p>Forwarded body</p>", attachments: prepared.attachments };
    const draft = await ask("mail:upsertDraft", payload);
    const saved = (await ask("mail:openEmail", { emailId: draft.emailId })).email;
    assert.deepEqual(bytes(saved.attachments), ["FIRST", "SECOND", "IMAGE"]);
    const queued = await ask("mail:scheduleSend", { ...payload, sendAt: new Date(Date.now() + 3600000).toISOString() });
    const recovered = await ask("mail:editScheduled", { id: queued.id });
    const reopened = (await ask("mail:openEmail", { emailId: recovered.emailId })).email;
    assert.deepEqual(bytes(reopened.attachments), ["FIRST", "SECOND", "IMAGE"]);
    await ask("mail:send", payload);
    const mime = await simpleParser(service.mime.at(-1));
    assert.deepEqual(mime.attachments.map(file => file.content.toString()).sort(), ["FIRST", "IMAGE", "SECOND"]);
    assert.equal(mime.attachments.find(file => file.filename === "logo.png").contentId, "<logo>");
    assert.ok(db.messageById(row.id), "sending a forward retains the original message");

    let published = 0;
    db.saveBlob = (...args) => { published++; return original.saveBlob(...args); };
    const failed = async (params, pattern) => {
      const result = await engine.answer("mail:prepareForward", [params]);
      assert.equal(result.success, false); assert.match(result.error.message, pattern); return result;
    };
    await failed({ ...input, accountId: "different" }, /does not belong/);
    await failed({ ...input, attachmentIds: input.attachmentIds.slice(0, 1) }, /changed/);
    assert.equal(published, 0);
    engine.attachmentCacheForTest.clear();
    remote.readPart = async (...args) => { if (args[3] === "gmail:2") throw new Error("Synthetic second file failure"); return original.readPart(...args); };
    await failed(input, /second file failure.*forward was not opened/i); assert.equal(published, 0, "a read failure publishes no subset");

    for (const kind of ["cancel", "changed", "removed"]) {
      engine.attachmentCacheForTest.clear(); const entered = gate(), held = gate();
      remote.readPart = async (...args) => { entered.release(); await held.wait; return original.readPart(...args); };
      const owner = new EventEmitter(); owner.send = () => {}; owner.isDestroyed = () => false;
      const pending = engine.answer("mail:prepareForward", [{ ...input, requestId: "forward-" + kind }], { sender: owner });
      await entered.wait;
      if (kind === "cancel") engine.answer("mail:cancelAttachmentRequest", [{ requestId: "forward-" + kind }], { sender: owner });
      else if (kind === "changed") db.updateMessage(row.id, { attachments_json: JSON.stringify(files.slice(0, 1)) });
      else db.updateMessage(row.id, { uid: row.uid + 1 });
      held.release(); const result = await pending;
      assert.equal(result.success, false); assert.equal(published, 0, kind + " cannot publish stale files");
      db.updateMessage(row.id, { uid: row.uid, attachments_json: row.attachments_json });
      await tick();
    }
    remote.readPart = original.readPart;
    engine.attachmentCacheForTest.clear();
    db.updateMessage(row.id, { attachments_json: JSON.stringify(files.map((file, index) => ({ ...file, size: index ? 1 : 26 * 1024 * 1024 }))) });
    await failed(input, /25 MiB/); assert.equal(published, 0);
    db.updateMessage(row.id, { attachments_json: row.attachments_json });
    remote.readPart = async () => Buffer.alloc(9 * 1024 * 1024);
    await failed(input, /25 MiB/); assert.equal(published, 0, "actual sizes, not metadata alone, enforce the outgoing cap");
    engine.attachmentCacheForTest.clear(); remote.readPart = original.readPart;
    const staged = [];
    db.saveBlob = (...args) => { staged.push(args[0]); if (staged.length === 2) throw new Error("Synthetic storage failure"); return original.saveBlob(...args); };
    await failed(input, /storage failure/);
    assert.equal(db.readBlob(staged[0]), null, "publication failure rolls back every new blob");
    db.saveBlob = original.saveBlob;
    assert.deepEqual(bytes((await ask("mail:prepareForward")).attachments), ["FIRST", "SECOND", "IMAGE"], "retry after a failed preparation succeeds");

    // Password IMAP / Outlook use the same account-validated production path.
    db.insertAccount({ id: "imap", email: "imap@fixture.invalid", username: "imap", profile: "outlook", authKind: "password", createdAt: 1,
      imapHost: "imap.fixture.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.fixture.invalid", smtpPort: 465, smtpTls: true });
    secrets.setPassword("imap", "synthetic-password");
    db.replaceFolders("imap", [{ path: "INBOX", name: "Inbox", wellKnown: "inbox", uidValidity: 1 }]);
    db.insertMessage({ id: "imap-source", accountId: "imap", folderPath: "INBOX", uid: 8, uidValidity: 1, date: new Date().toISOString(), listSortTs: Date.now(),
      from: "sender@fixture.invalid", to: ["imap@fixture.invalid"], textBody: "Original", bodyComplete: true, hasAttachments: true,
      attachments: [{ id: "2", filename: "imap.txt", mimeType: "text/plain", size: 4 }] });
    remote.withClient = async (_account, _secret, work) => work({}); remote.readPart = async () => Buffer.from("IMAP");
    const imapFiles = await ask("mail:prepareForward", { emailId: "imap-source", accountId: "imap", attachmentIds: ["2"] });
    assert.deepEqual(bytes(imapFiles.attachments), ["IMAP"]);
    console.log("forward-host-ok: Gmail/IMAP, exact bytes and duplicate names, inline CID, draft/schedule/MIME, caps, atomicity, identity changes and cancel/retry");
  } finally {
    db.saveBlob = original.saveBlob; remote.readPart = original.readPart; remote.withClient = original.withClient; global.fetch = original.fetch;
    await db.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}
async function run() { await rendererChecks(); await hostChecks(); }
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
