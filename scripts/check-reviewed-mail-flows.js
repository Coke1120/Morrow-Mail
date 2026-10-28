// Functional review regressions: production host/SQLite/renderer, synthetic I/O.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createRequire } = require("node:module");
const root = process.env.MORROW_REVIEW_SOURCE || path.resolve(__dirname, "..");
const load = createRequire(path.join(root, "package.json"));
const { JSDOM } = load("jsdom");
const { renderer } = load("./scripts/check-ux-workflows");
const { server, message } = load("./scripts/gmail-fixture");
const tick = () => new Promise(setImmediate);
async function until(check) { for (let n = 0; n < 500 && !check(); n++) await tick(); assert.ok(check(), "fixture reached expected state"); }
function gate() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
require("node:net").Socket.prototype.connect = () => { throw new Error("Real sockets are forbidden in reviewed-flow fixtures"); };

async function fixture(messages, work) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-reviewed-flows-"));
  Object.assign(process.env, { MORROW_USER_DATA: directory, MORROW_MAIL_DIR: directory, MORROW_AI_CONFIG_DIR: directory,
    MORROW_MAIL_SECRETS: "memory", MORROW_GMAIL_PACE: "0",
    MORROW_GOOGLE_OAUTH_JSON: JSON.stringify({ installed: { client_id: "review-fixture.apps.googleusercontent.com", client_secret: "synthetic-only" } }) });
  const db = load("./host/mail/db"), engine = load("./host/mail/engine"), secrets = load("./host/mail/secrets");
  const config = load("./host/mail/oauth-config"), { createSession } = load("./host/mail/gmail-session");
  const service = server(messages), priorFetch = global.fetch;
  service.labels.splice(1);
  global.fetch = service.fetcher;
  const session = () => createSession(db.accountById("gmail"), "synthetic-token", { api: service.api() });
  try {
    await engine.init();
    db.insertAccount({ id: "gmail", email: "owner@fixture.invalid", username: "owner@fixture.invalid", profile: "gmail", authKind: "oauth2", createdAt: 1,
      imapHost: "imap.fixture.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.fixture.invalid", smtpPort: 465, smtpTls: true });
    db.enableGmail("gmail");
    secrets.setPassword("gmail", JSON.stringify({ provider: "google", googleClientId: config.credentials("google").clientId, purpose: "imap",
      accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3600000, grantedScopes: config.SCOPES.google }));
    const folders = await session().folders();
    db.replaceFolders("gmail", folders.folders, "/");
    await work({ db, engine, service, session, directory });
  } finally {
    global.fetch = priorFetch;
    await engine.stopIdle(); await db.close();
    secrets.deletePassword("gmail");
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function readerUi(f, target, native = false) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "renderer/index.html"), "utf8"));
  const calls = [];
  async function invoke(channel, input) {
    calls.push({ channel, input });
    const result = await f.engine.answer(channel, [input]);
    if (!result.success) throw Object.assign(new Error(result.error.message), result.error);
    return result.data;
  }
  const ui = renderer({ document: dom.window.document, crypto: require("node:crypto"), requestAnimationFrame: () => 0,
    window: { morrow: { on() {}, invoke, pullReaderSeed: async () => ({ messageId: target.id, accountId: "gmail" }) },
      location: { search: native ? "?role=reader" : "" }, addEventListener() {} } });
  ui.context.askHost = invoke; ui.context.accounts = f.engine.accountViews(); ui.context.targetId = target.id;
  ui.run(`state.accounts=accounts; state.accountId='gmail'; state.folderId='INBOX'; state.view='mail';
    state.prefs.conversation=false; state.prefs.aiReply=false;
    state.emails=[{id:targetId,accountId:'gmail',subject:'Synthetic read',snippet:'Cached summary only.',bodyComplete:false,unread:true}];
    renderList=()=>{}; settleOpenView=async()=>{}; call=askHost;
    wire=()=>{}; loadLook=async()=>{}; loadShellPrefs=async()=>{}; loadSnoozed=async()=>{}; loadProviderFolders=async()=>{};`);
  return { dom, ui, calls, pane: dom.window.document.getElementById("reader") };
}

for (const native of [false, true]) test(`failed body GET keeps unread and Retry recovers ${native ? "reader window" : "mail pane"}`, async () => {
  const source = message("read-fails", ["INBOX", "UNREAD"]);
  source.snippet = "Cached summary only.";
  await fixture([source], async f => {
    await f.session().adopt(source);
    const target = f.db.gmailCopies("gmail", source.id).find(row => row.folder_path === "INBOX");
    f.db.updateMessage(target.id, { text_body: null, html_body: null, body_complete: 0 });
    let failing = true;
    global.fetch = (url, options) => failing && new URL(url).pathname.endsWith("/messages/read-fails")
      ? new Response(JSON.stringify({ error: { message: "must-not-display-provider-body", status: "UNAVAILABLE" } }), { status: 503 })
      : f.service.fetcher(url, options);
    const view = readerUi(f, target, native);
    try {
      if (native) await view.ui.run("bootReaderWindow()");
      else await assert.rejects(view.ui.run("openMessage(targetId,false)"), /could not be downloaded/);
      assert.match(view.pane.textContent, /Retry download/);
      assert.doesNotMatch(view.pane.textContent, /Cached summary only|must-not-display-provider-body/);
      assert.equal(view.pane.querySelector(".body"), null, "summary is not presented as a downloaded body");
      assert.equal(f.db.messageById(target.id).unread, 1);
      assert.equal(view.calls.filter(row => row.channel === "mail:markRead").length, 0);
      failing = false;
      view.pane.querySelector('[data-action="retry-body"]').click();
      await until(() => f.db.messageById(target.id).unread === 0);
      await f.engine.settleAccount("gmail");
      assert.match(view.pane.querySelector(".body").textContent, /Synthetic body read-fails/);
      assert.equal(view.pane.querySelector(".hint.error"), null);
      assert.equal(view.calls.filter(row => row.channel === "mail:openEmail").at(-1).input.full, true);
    } finally { view.dom.window.close(); }
  });
});

test("failed partial-body refresh keeps cached HTML, exposes retry, and clears warning on success", async () => {
  const source = message("partial", ["INBOX", "UNREAD"]);
  await fixture([source], async f => {
    await f.session().adopt(source);
    const target = f.db.gmailCopies("gmail", source.id).find(row => row.folder_path === "INBOX");
    f.db.updateMessage(target.id, { text_body: "Available body", html_body: "<p>Available <strong>body</strong></p>", body_complete: 0 });
    global.fetch = async () => new Response("{}", { status: 503 });
    const result = await f.engine.answer("mail:openEmail", [{ emailId: target.id, full: true }]);
    assert.equal(result.success, true);
    assert.match(result.data.email.bodyWarning, /could not be downloaded/);
    assert.equal(result.data.email.htmlBody, "<p>Available <strong>body</strong></p>");
    const view = readerUi(f, target);
    try {
      view.ui.context.partial = result.data.email;
      view.ui.run("state.email=partial; renderReader(false)");
      assert.ok(view.pane.querySelector(".body strong"));
      assert.ok(view.pane.querySelector('[data-action="retry-body"]'));
      global.fetch = f.service.fetcher;
      view.pane.querySelector('[data-action="retry-body"]').click();
      await until(() => f.db.messageById(target.id).body_complete === 1);
      await f.engine.settleAccount("gmail"); await tick();
      assert.equal(f.db.messageById(target.id).body_warning, null);
      assert.equal(view.pane.querySelector('[data-action="retry-body"]'), null);
    } finally { view.dom.window.close(); }
  });
});

test("a failed background fill publishes a warning without replacing cached content", async () => {
  const source = message("background");
  await fixture([source], async f => {
    await f.session().adopt(source);
    const target = f.db.gmailCopies("gmail", source.id).find(row => row.folder_path === "INBOX");
    f.db.updateMessage(target.id, { html_body: "<b>Cached body</b>", body_complete: 0 });
    global.fetch = async () => new Response("{}", { status: 503 });
    const result = await f.engine.answer("mail:openEmail", [{ emailId: target.id }]);
    assert.equal(result.success, true);
    await until(() => !!f.db.messageById(target.id).body_warning);
    assert.equal(f.db.messageById(target.id).html_body, "<b>Cached body</b>");
    assert.match(f.db.messageById(target.id).body_warning, /Retry download/);
  });
});

function warmHistory(f) {
  for (const folder of f.db.foldersFor("gmail")) f.db.gmailSyncState("gmail", folder.path, { horizonDays: 0, complete: true, historyId: "100", verifyNeeded: false });
}
const fullReads = f => f.service.calls.filter(call => /^\/messages\/[^/]+$/.test(call.route) && call.method === "GET" && call.query.get("format") === "full");

test("one history record with 105 messages is bounded and resumes after reopening the store", async () => {
  const sources = Array.from({ length: 105 }, (_, n) => message(`change-${n}`));
  await fixture(sources, async f => {
    warmHistory(f);
    f.service.history([{ id: "101", messagesAdded: sources.map(row => ({ message: { id: row.id } })) }]);
    const first = await f.session().sync("INBOX", { horizonDays: 0, limit: 20 });
    assert.equal(first.bootstrapped, false);
    assert.equal(fullReads(f).length, 20);
    assert.equal(f.db.gmailSyncState("gmail", "INBOX").historyId, "100");
    await f.db.close(); await f.db.open(path.join(f.directory, "mail.sqlite"));
    let passes = 1;
    while (f.db.gmailSyncState("gmail", "INBOX").historyId !== "101") {
      const before = fullReads(f).length;
      await f.session().sync("INBOX", { horizonDays: 0, limit: 20 });
      assert.ok(fullReads(f).length - before <= 20);
      assert.ok(++passes < 10);
    }
    assert.equal(f.db.countInFolder("gmail", "INBOX"), 105);
    assert.equal(new Set(fullReads(f).map(call => call.route)).size, 105);
    assert.equal(fullReads(f).length, 105, "resume does not repeat committed reads");
    assert.equal(f.service.calls.filter(call => call.method !== "GET").length, 0);
    assert.equal(f.service.calls.filter(call => call.route === "/history").length, 1, "the frozen page is resumed durably");
  });
});

test("a queued foreground open runs before the remainder of a large history record", async () => {
  const sources = Array.from({ length: 100 }, (_, n) => message(`changed-${n}`));
  await fixture([...sources, message("open-target")], async f => {
    await f.session().adopt(f.service.messages.get("open-target"));
    const target = f.db.gmailCopies("gmail", "open-target").find(row => row.folder_path === "INBOX");
    f.db.updateMessage(target.id, { text_body: null, html_body: null, body_complete: 0 });
    warmHistory(f);
    f.service.history([{ id: "101", messagesAdded: sources.map(row => ({ message: { id: row.id } })) }]);
    const started = gate(), held = gate(); let first = true; let sync;
    global.fetch = async (url, options) => {
      if (first && /\/messages\/changed-\d+$/.test(new URL(url).pathname)) { first = false; started.resolve(); await held.promise; }
      return f.service.fetcher(url, options);
    };
    try {
      sync = f.engine.syncAccountById("gmail", { background: true });
      await started.promise;
      const opened = f.engine.answer("mail:openEmail", [{ emailId: target.id, full: true }]);
      await until(() => f.engine.mailQueueForTest("gmail").user === 1);
      held.resolve();
      assert.equal((await opened).success, true);
      const ahead = fullReads(f).findIndex(call => call.route === "/messages/open-target");
      assert.ok(ahead >= 1 && ahead < 20, `foreground waited for ${ahead} full reads`);
      await sync;
      assert.equal(f.db.gmailSyncState("gmail", "INBOX").historyId, "100", "incomplete history cursor is retained");
    } finally { held.resolve(); if (sync) await sync; }
  });
});

test("a failed resume checkpoint rolls back message adoption and can retry without lost IDs", async () => {
  const sources = [message("atomic-one"), message("atomic-two"), message("atomic-three")];
  await fixture(sources, async f => {
    warmHistory(f);
    f.service.history([{ id: "101", messagesAdded: sources.map(row => ({ message: { id: row.id } })) }]);
    const save = f.db.gmailSyncState;
    f.db.gmailSyncState = (accountId, folderPath, next) => {
      if (next?.pending?.offset === 2) throw new Error("Synthetic resume checkpoint failure");
      return save(accountId, folderPath, next);
    };
    try { await assert.rejects(f.session().sync("INBOX", { horizonDays: 0 }), /checkpoint failure/); }
    finally { f.db.gmailSyncState = save; }
    assert.equal(f.db.gmailSyncState("gmail", "INBOX").pending.offset, 1);
    assert.equal(f.db.gmailCopies("gmail", "atomic-two").length, 0);
    assert.equal(f.db.gmailSyncState("gmail", "INBOX").historyId, "100");
    await f.session().sync("INBOX", { horizonDays: 0 });
    assert.equal(f.db.gmailSyncState("gmail", "INBOX").historyId, "101");
    assert.equal(f.db.countInFolder("gmail", "INBOX"), 3);
    assert.equal(f.service.calls.filter(call => call.method !== "GET").length, 0);
  });
});

test("bootstrap newest-page refresh and cached verification share the actual-read budget", async () => {
  await fixture(Array.from({ length: 65 }, (_, n) => message(`bootstrap-${n}`)), async f => {
    let before = 0;
    for (let pass = 0; pass < 15; pass++) {
      const result = await f.session().sync("INBOX", { horizonDays: 0, limit: 20 });
      const now = fullReads(f).length;
      assert.ok(now - before <= 20, `pass ${pass} performed ${now - before} reads`); before = now;
      if (result.bootstrapped) break;
      assert.ok(pass < 14, "bootstrap completes without starving verification");
    }
    assert.equal(f.db.countInFolder("gmail", "INBOX"), 65);
    assert.equal(f.db.gmailSyncState("gmail", "INBOX").verifyNeeded, false);
  });
});

test("deadline, 404 and history page continuation retain every remaining change", async () => {
  const sources = [message("page-one"), message("page-two")];
  await fixture(sources, async f => {
    warmHistory(f);
    const api = f.service.api(), requested = [];
    api.history = async input => {
      requested.push(input.pageToken);
      return input.pageToken ? { history: [{ messagesAdded: [{ message: { id: "page-two" } }] }], historyId: "102" }
        : { history: [{ messagesAdded: [{ message: { id: "page-one" } }, { message: { id: "already-gone" } }] }], nextPageToken: "second-page", historyId: "102" };
    };
    const { createSession } = load("./host/mail/gmail-session");
    const session = () => createSession(f.db.accountById("gmail"), "synthetic", { api });
    await session().sync("INBOX", { horizonDays: 0, deadline: Date.now() - 1 });
    assert.equal(fullReads(f).length, 0);
    assert.equal(f.db.gmailSyncState("gmail", "INBOX").pending.offset, 0);
    await session().sync("INBOX", { horizonDays: 0, limit: 1 });
    assert.equal(f.db.gmailSyncState("gmail", "INBOX").historyId, "100");
    await session().sync("INBOX", { horizonDays: 0, limit: 1 });
    assert.equal(f.db.gmailSyncState("gmail", "INBOX").historyPageToken, "second-page");
    assert.equal(f.db.gmailSyncState("gmail", "INBOX").historyId, "100");
    await session().sync("INBOX", { horizonDays: 0, limit: 1 });
    assert.equal(f.db.gmailSyncState("gmail", "INBOX").historyId, "102");
    assert.equal(f.db.countInFolder("gmail", "INBOX"), 2);
    assert.deepEqual(requested, ["", "second-page"]);
  });
});

test("removal during a pending history read cannot recreate data or its checkpoint", async () => {
  await fixture([message("late")], async f => {
    warmHistory(f); f.service.history([{ messagesAdded: [{ message: { id: "late" } }] }]);
    const started = gate(), held = gate();
    const api = f.service.api(), get = api.getMessage;
    api.getMessage = async (...args) => { started.resolve(); await held.promise; return get(...args); };
    const session = load("./host/mail/gmail-session").createSession(f.db.accountById("gmail"), "synthetic", { api });
    const pending = session.sync("INBOX", { horizonDays: 0 });
    const rejected = assert.rejects(pending, error => error.code === "account_removed");
    await started.promise;
    await f.engine.answer("mail:removeAccount", [{ accountId: "gmail" }]);
    held.resolve(); await rejected;
    assert.equal(f.db.accountById("gmail"), null);
    assert.equal(f.db.gmailCopies("gmail", "late").length, 0);
    assert.deepEqual(f.db.gmailSyncState("gmail", "INBOX"), {});
  });
});

test("Gmail label copies count once, retain the selected copy and leave folder storage intact", async () => {
  const source = message("one-delivery", ["INBOX", "CATEGORY_PERSONAL"]);
  await fixture([source], async f => {
    f.service.labels.push({ id: "CATEGORY_PERSONAL", name: "CATEGORY_PERSONAL", type: "system" });
    f.db.replaceFolders("gmail", (await f.session().folders()).folders, "/");
    await f.session().adopt(source);
    const copies = f.db.gmailCopies("gmail", source.id);
    assert.equal(copies.length, 3);
    for (const selected of copies) {
      const opened = await f.engine.answer("mail:openEmail", [{ emailId: selected.id }]);
      assert.equal(opened.success, true);
      assert.equal(opened.data.isThread, false);
      assert.equal(opened.data.threadMessages.length, 1);
      assert.equal(opened.data.threadMessages[0].id, selected.id);
      for (const channel of ["mail:listThreadMessages", "mail:getLocalThreadMembers"]) for (const headersOnly of [true, false]) {
        const listed = await f.engine.answer(channel, [{ accountId: "gmail", threadId: selected.thread_id, emailId: selected.id, headersOnly }]);
        assert.equal(listed.data.length, 1);
        assert.equal(listed.data[0].id, selected.id);
      }
      const view = readerUi(f, selected);
      try {
        view.ui.run("state.prefs.conversation=true");
        await view.ui.run("openMessage(targetId,false)");
        assert.equal(view.pane.querySelector(".thread"), null);
        assert.doesNotMatch(view.pane.textContent, /Earlier in this conversation/);
      } finally { view.dom.window.close(); }
    }
    assert.equal(f.db.gmailCopies("gmail", source.id).length, 3);
    assert.equal(f.db.messagesByThread("gmail", copies[0].thread_id).length, 3, "raw folder records are not removed");
  });
});

test("a real conversation counts distinct provider messages rather than its nine label copies", async () => {
  const sources = Array.from({ length: 3 }, (_, n) => {
    const row = message(`conversation-${n}`, ["INBOX", "CATEGORY_PERSONAL"]);
    row.payload.headers.find(header => header.name === "Date").value = `Mon, ${19 + n} Oct 2026 00:00:00 +0000`;
    return row;
  });
  await fixture(sources, async f => {
    f.service.labels.push({ id: "CATEGORY_PERSONAL", name: "CATEGORY_PERSONAL", type: "system" });
    f.db.replaceFolders("gmail", (await f.session().folders()).folders, "/");
    for (const source of sources) {
      await f.session().adopt(source);
      for (const copy of f.db.gmailCopies("gmail", source.id)) f.db.updateMessage(copy.id, { thread_id: "one-conversation" });
    }
    const selected = f.db.gmailCopies("gmail", "conversation-2").find(row => row.folder_path === "INBOX");
    const opened = await f.engine.answer("mail:openEmail", [{ emailId: selected.id }]);
    assert.equal(opened.data.threadMessages.length, 3);
    assert.equal(opened.data.isThread, true);
    const view = readerUi(f, selected);
    try {
      view.ui.run("state.prefs.conversation=true");
      await view.ui.run("openMessage(targetId,false)");
      assert.match(view.pane.querySelector(".thread").getAttribute("aria-label"), /^3 messages/);
      assert.match(view.pane.querySelector(".thread-earlier").textContent, /Earlier in this conversation \(1\)/);
      assert.equal(view.pane.querySelectorAll(".thread-item").length, 2);
      assert.equal(view.pane.querySelector('.thread-item[aria-current="true"]').getAttribute("aria-current"), "true");
    } finally { view.dom.window.close(); }
    assert.equal(f.db.messagesByThread("gmail", "one-conversation").length, 9);
  });
});

test("missing IDs, duplicate RFC IDs, distinct provider messages and accounts are not conflated", async () => {
  await fixture([], async f => {
    const threadId = "identity-negatives";
    f.db.insertAccount({ id: "other", email: "other@fixture.invalid", username: "other", profile: "gmail", createdAt: 2,
      imapHost: "imap.fixture.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.fixture.invalid", smtpPort: 465, smtpTls: true });
    function insert(id, accountId, gmailId, extra = {}) {
      f.db.insertMessage({ id, accountId, folderPath: "INBOX", threadId, rfcMessageId: "<same-rfc@fixture.invalid>",
        bodyComplete: true, textBody: "Synthetic body", date: "2026-10-25T00:00:00.000Z", listSortTs: 1, ...extra });
      if (gmailId != null) f.db.updateMessage(id, { gmail_id: gmailId });
    }
    insert("provider-one-a", "gmail", "one"); insert("provider-one-b", "gmail", "one");
    insert("provider-two", "gmail", "two");
    insert("missing-one", "gmail", null); insert("missing-two", "gmail", null);
    insert("missing-rfc", "gmail", "", { rfcMessageId: null });
    insert("edited-draft", "gmail", "one", { isDraft: true, draftPending: true });
    insert("other-copy-a", "other", "one"); insert("other-copy-b", "other", "one");
    const local = await f.engine.answer("mail:listThreadMessages", [{ accountId: "gmail", threadId, headersOnly: true, emailId: "provider-one-b" }]);
    assert.equal(local.data.length, 6);
    assert.ok(local.data.some(row => row.id === "provider-one-b"));
    assert.ok(local.data.some(row => row.id === "provider-two"));
    assert.ok(local.data.some(row => row.id === "edited-draft"));
    const all = await f.engine.answer("mail:getLocalThreadMembers", [{ threadId, headersOnly: true }]);
    assert.equal(all.data.length, 7);
    assert.equal(all.data.filter(row => row.accountId === "other").length, 1);
    assert.equal(f.db.messagesByThread("gmail", threadId).length, 7);
    assert.equal(f.db.messagesByThread("other", threadId).length, 2);
  });
});

test("Features and Settings describe the tested read, sync, signature and conversation behavior", () => {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "renderer/index.html"), "utf8"));
  try {
    const ui = renderer({ document: dom.window.document });
    ui.context.catalog = load("./renderer/features-catalog");
    ui.run("window.morrowFeaturesCatalog=catalog; paintFeatureCatalog(); showFeaturesTab('catalog')");
    const text = dom.window.document.getElementById("features-catalog").textContent;
    for (const pattern of [/Retry download/, /leaves the message unread/, /actual message reads/, /saved positions/, /preserves body formatting and links/, /Gmail label copies appear once/]) assert.match(text, pattern);
    assert.match(dom.window.document.getElementById("conversation-copy-help").textContent, /same account/);
    assert.match(dom.window.document.getElementById("compose-signature-switch-help").textContent, /signature you edited/);
    assert.match(dom.window.document.getElementById("mail-body-cache-note").textContent, /Retry download/);
  } finally { dom.window.close(); }
});

for (const edit of ["text", "markup", "none"]) for (const hasSignature of [true, false]) {
  test(`cross-account From preserves rich body (${edit} signature edit; destination signature ${hasSignature})`, async () => {
    const dom = new JSDOM(fs.readFileSync(path.join(root, "renderer/index.html"), "utf8"));
    const document = dom.window.document;
    for (const node of document.querySelectorAll("dialog")) { node.showModal = () => node.setAttribute("open", ""); node.close = () => node.removeAttribute("open"); }
    const ui = renderer({ document, crypto: require("node:crypto"), requestAnimationFrame: () => 0 });
    ui.context.destHasSignature = hasSignature;
    ui.run(`state.accounts=[{id:'alpha',platform:'imap',email:'owner@alpha.test'}, {id:'beta',platform:'imap',email:'owner@beta.test'}]
      .map(account=>({...account,sendAs:window.morrowComposePolicy.identities(account,window.morrowComposePolicy.emptySettings())}));
      state.accountId='alpha'; state.prefs.undoSend=0; state.prefs.scheduleDelay=0;
      scheduleComposeLayout=()=>{}; paintComposeChrome=()=>{}; paintQuoteBody=()=>{}; syncScheduleFields=()=>{}; loadScheduled=async()=>{};
      call=async(channel,input)=>{
        const id=input.accountId;
        if(channel==='mail:getComposeContext') {
          const settings=window.morrowComposePolicy.emptySettings();
          return {...window.morrowComposePolicy.resolve(state.accounts.find(row=>row.id===id),null,settings,'new',input.fromAddress),settings};
        }
        if(channel==='mail:listSignatures') return {signatures:id==='beta'&&!destHasSignature?[]:[{id:id+'-sig',name:id,text:id+' signature'}],defaultSignaturePerAccount:{[id]:id+'-sig'}};
        throw new Error('Unexpected IPC '+channel);
      };`);
    try {
      await ui.run("openCompose({accountId:'alpha',to:'recipient@fixture.invalid'})");
      const editor = document.getElementById("compose-editor");
      const sig = edit === "text" ? "alpha signature, edited" : edit === "markup" ? "<strong>alpha signature</strong>" : "alpha signature";
      editor.innerHTML = '<p>Keep <strong>bold</strong> and <a href="https://example.test/review">this link</a>.</p><br><br><div data-compose-signature="1">' + sig + "</div>";
      ui.run("syncComposePlainFromEditor()");
      const before = editor.innerHTML;
      document.getElementById("compose-from").value = "owner@beta.test";
      await ui.run("changeComposeFrom()");
      assert.equal(ui.run("state.composeMeta.accountId"), "beta");
      assert.ok(editor.querySelector("p strong"));
      assert.equal(editor.querySelector("a").getAttribute("href"), "https://example.test/review");
      assert.match(ui.run("composePayload(composeAccount()).body"), /<a href="https:\/\/example.test\/review"/);
      if (edit !== "none") assert.equal(editor.innerHTML, before, "user signature edits remain intact without adding another signature");
      else {
        assert.equal(editor.querySelectorAll("[data-compose-signature]").length, hasSignature ? 1 : 0);
        assert.equal(/beta signature/.test(editor.textContent), hasSignature);
        assert.doesNotMatch(editor.textContent, /alpha signature/);
        document.getElementById("compose-from").value = "owner@alpha.test";
        await ui.run("changeComposeFrom()");
        assert.match(editor.textContent, /alpha signature/);
        assert.equal(editor.querySelectorAll("[data-compose-signature]").length, 1);
        assert.equal(editor.querySelector("a").getAttribute("href"), "https://example.test/review");
      }
    } finally { dom.window.close(); }
  });
}
