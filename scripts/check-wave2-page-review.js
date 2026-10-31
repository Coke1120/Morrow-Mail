const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { fixture: calendarFixture } = require("./check-calendar-keyboard-followup");
const calendar = require("../host/mail/calendar-api");
const persona = require("../host/brain-persona");
const recipients = require("../shared/recipient-suggest");
const root = path.join(__dirname, "..");
const copy = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

function load(relative, stubs = {}, transform = (source) => source) {
  const filename = path.join(root, relative);
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = instance.require.bind(instance);
  instance.require = (request) => Object.hasOwn(stubs, request) ? stubs[request] : original(request);
  instance._compile(transform(fs.readFileSync(filename, "utf8")), filename);
  return instance.exports;
}

function productionFunctions(relative, names, bindings) {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  const functions = names.map((name) => {
    const match = source.match(new RegExp("(?:async )?function " + name + "\\([^]*?^}", "m"));
    assert.ok(match, name);
    return match[0];
  }).join("\n");
  return vm.runInNewContext(functions + "\n({" + names.join(",") + "})", bindings);
}

const { uiFixture } = load("scripts/check-wave1-review.js", {}, (source) => source.slice(0, source.indexOf("\ntest(")) + "\nmodule.exports = { uiFixture };\n");

function composeFixture(extraApi = {}) {
  const ui = uiFixture();
  const get = (id) => ui.nodes.get(id);
  Object.assign(ui.context.window.morrow, extraApi);
  ui.context.window.morrowRecipientSuggest = recipients;
  ui.context.Event = class { constructor(type) { this.type = type; } };
  for (const node of ui.nodes.values()) {
    node.open = false;
    node.showModal = () => { node.open = true; };
    node.close = () => { node.open = false; };
    node.setSelectionRange = () => {};
    node.dispatchEvent = (event) => node.listeners.get(event.type)?.({ ...event, currentTarget: node, target: node });
    Object.defineProperty(node, "options", { get: () => node.children.flatMap((child) => child.tagName === "optgroup" ? child.children : [child]) });
  }
  ui.run(`state.accounts = [{id:'a',email:'alice@alpha.test',platform:'imap',sendAs:[
      {email:'alice@alpha.test',verified:true},{email:'alice@alias.test',verified:true}]}];
    state.accountId='a';state.prefs.aiReply=false;state.prefs.undoSend=30;
    globalThis.fixture={calls:[],settings:{ccByDomain:{},bccByDomain:{},accounts:{}},signatures:{signatures:[]},queue:[],drafts:new Map(),override:null};
    openDialog=id=>$(id).showModal();closeDialog=async id=>$(id).close();
    syncScheduleFields=()=>{};paintComposeChrome=()=>{};paintQuoteBody=()=>{};scheduleComposeLayout=()=>{};
    loadScheduled=async()=>{};paintComposeAi=()=>{};showStatus=(text,error)=>{globalThis.notice={text,error};};
    call=async(channel,payload)=>{
      fixture.calls.push({channel,payload});
      if(fixture.override){const result=fixture.override(channel,payload);if(result!==undefined)return result;}
      if(channel==='mail:getComposeContext')return {...window.morrowComposePolicy.resolve(state.accounts[0],null,fixture.settings,payload.kind,payload.fromAddress),settings:fixture.settings};
      if(channel==='mail:listSignatures')return fixture.signatures;
      if(channel==='mail:upsertDraft')return {emailId:'saved',draftRevision:'revision'};
      if(channel==='mail:scheduleSend'){const row={...payload,id:'queue-'+fixture.queue.length,status:'pending',htmlBody:payload.body};fixture.queue.push(row);return row;}
      if(channel==='mail:cancelScheduled'&&payload.recoverDraft===true){
        const row=fixture.queue.find(item=>item.id===payload.id);if(!row)throw new Error('Missing queued message');
        const draft={...row,id:'recovered',accountId:'a',isDraft:true,bodyComplete:true,textBody:plainFromMailHtml(row.body)};
        fixture.drafts.set(draft.id,draft);fixture.queue=fixture.queue.filter(item=>item!==row);return {emailId:draft.id,accountId:'a'};
      }
      if(channel==='mail:openEmail')return {email:fixture.drafts.get(payload.emailId)};
      if(channel==='mail:uploadAttachment')return {storageUrl:'local:fixture',filename:payload.filename,size:payload.fileBytes.length,mimeType:payload.mimeType};
      return {};
    };`);
  get("ai-mode").value = "rewrite";
  return { ...ui, get };
}

function brainFixture(initial = {}) {
  let stored = JSON.stringify({ userRules: [], categories: [{ id: "work", name: "Work" }], activity: [],
    generated: persona.buildGenerated(null, { writing: ["Keep replies concise."], voiceQuotes: ["Old quotation."], sections: [] }, { messages: [{}] }, "rebuild", []), ...initial });
  const calls = [], events = [];
  const brain = load("host/brain.js", {
    fs: { readFileSync: () => stored, mkdirSync() {}, writeFileSync: (_file, value) => { stored = value; } },
    electron: { BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel, payload) => events.push({ channel, payload }) } }] } },
    "./ai-config": { userDataDir: () => "/synthetic", loadConfig: () => ({ apiKey: "synthetic-only" }) },
    "./openai-client": { complete: () => { const task = deferred(); calls.push(task); return task.promise; }, extractJson: JSON.parse },
    "./ai-context": { operation: (callback) => callback(), background: (callback) => callback() },
    "./agent": { mailboxConnected: () => true, profileSample: () => ({ messages: [{}], sentCount: 1, inboxCount: 0 }) },
    "./mail/db": { isReady: () => true, listAccountRows: () => [] },
    "./settings": { answer: () => ({ ccByDomain: {}, accounts: {} }) },
  });
  return { brain, calls, events, read: () => JSON.parse(stored), answer: (channel, params = {}) => brain.answer(channel, [params]) };
}

test("Compose P1: actual host broadcasts and late completion/cancel events preserve manual edits and dirty state", async () => {
  const first = composeFixture(), second = composeFixture();
  for (const ui of [first, second]) await ui.run("openCompose({to:'client@example.test',body:'Initial'})");
  for (const completed of [true, false]) {
    await first.run("startDraftWrite()");
    first.run("globalThis.oldId=state.draftWrite.reqId;onDraftEvent({reqId:oldId,type:'chunk',data:'Generated'});");
    if (completed) first.run("onDraftEvent({reqId:oldId,type:'done'})");
    else await first.run("cancelDraftWrite()");
    await first.run("saveDraft()");
    first.get("compose-body").value = "Manual corrections survive";
    const windows = [first, second].map((ui) => ({ isDestroyed: () => false, webContents: { send: (_channel, event) => {
      ui.context.event = event; ui.run("onDraftEvent(event)");
    } } }));
    const host = load("host/draft-write.js", {
      electron: { BrowserWindow: { getAllWindows: () => windows } },
      "./openai-client": { stream: async (_messages, chunk) => chunk("Other window"), complete: async () => "", extractJson: JSON.parse },
      "./brain": { writingBrief: () => "" }, "./ai-context": { operation: (callback) => callback() },
    });
    await host.answer("aiDraftWrite:start", [{ reqId: "other-window", body: { mode: "rewrite", existing_draft_content: "Other" } }]);
    await tick();
    first.run("onDraftEvent({reqId:oldId,type:'chunk',data:'Late'});onDraftEvent({reqId:oldId,type:'done'})");
    assert.equal(first.get("compose-body").value, "Manual corrections survive");
    assert.equal(first.run("composeSnapshot()!==state.composeBaseline"), true);
  }
});

test("Compose P2: Undo and failed-send snapshots preserve empty recipients and exactly one signature", async () => {
  for (const recovery of ["undo", "failed"]) {
    const ui = composeFixture();
    ui.run(`fixture.settings.ccByDomain={'alpha.test':['copy@example.test']};fixture.settings.bccByDomain={'alpha.test':['audit@example.test']};
      fixture.signatures={signatures:[{id:'sig',text:'Alice signature'}],defaultSignaturePerAccount:{a:'sig'}};`);
    await ui.run("openCompose({to:'client@example.test',body:'Message'})");
    ui.get("compose-cc").value = ""; ui.get("compose-bcc").value = "";
    const body = ui.get("compose-body").value;
    await ui.run("sendMail()");
    if (recovery === "undo") await ui.run("undoOutboxItem(fixture.queue[0])");
    else await ui.run("openCompose(outboxComposeSeed(fixture.queue[0],fixture.queue[0]))");
    if (recovery === "undo") {
      assert.deepEqual(copy(ui.run("fixture.calls.filter(item=>item.channel==='mail:cancelScheduled').map(item=>item.payload)")), [{ id: "queue-0", recoverDraft: true }]);
      assert.equal(ui.run("fixture.calls.some(item=>item.channel==='mail:editScheduled')"), false);
    }
    assert.equal(ui.get("compose-cc").value, "");
    assert.equal(ui.get("compose-bcc").value, "");
    assert.equal(ui.get("compose-body").value, body);
    assert.equal(ui.get("compose-body").value.split("Alice signature").length, 2);
  }
});

test("Compose P2: Undo retains an inert recovery draft on both Compose creation and main-frame load failures", async () => {
  for (const loadFailure of [false, true]) {
    const windows = [];
    class SyntheticWindow extends EventEmitter {
      constructor() {
        super(); this.webContents = new EventEmitter(); this.webContents.id = 1;
        this.webContents.setWindowOpenHandler = () => {}; this.webContents.isLoading = () => true;
        windows.push(this);
      }
      isDestroyed() { return !!this.destroyed; }
      loadFile() { return new Promise(() => {}); }
      close() { this.destroyed = true; this.emit("closed"); }
    }
    const host = load("host/compose-window.js", { electron: { BrowserWindow: SyntheticWindow, shell: {}, ipcMain: {} } })
      .createComposeHost({ htmlFile: "synthetic.html", mode: "bundled" });
    const ui = composeFixture({ openComposeWindow: async (seed) => {
      if (!loadFailure) throw new Error("Synthetic creation failure");
      return host.open(seed);
    } });
    await ui.run("openCompose({to:'client@example.test',body:'Recover me'})");
    await ui.run("sendMail()");
    await ui.run("undoOutboxItem(fixture.queue[0])");
    if (loadFailure) windows[0].webContents.emit("did-fail-load", {}, -2, "Synthetic failure", "synthetic", true);
    assert.equal(ui.run("fixture.queue.length"), 0);
    assert.equal(ui.run("fixture.drafts.size"), 1);
    assert.match(ui.run("fixture.drafts.get('recovered').textBody"), /Recover me/);
    assert.equal(ui.run("fixture.calls.some(item=>item.channel==='mail:restoreScheduled'||item.channel==='mail:send')"), false);
    if (loadFailure) assert.equal(host.records.size, 0);
    else assert.match(ui.run("notice.text"), /saved in local Drafts/);
  }
});

test("Compose P2: attachment read and upload block every finalization and cannot mutate a later session", async () => {
  for (const phase of ["read", "upload"]) {
    const ui = composeFixture();
    await ui.run("openCompose({to:'client@example.test',body:'Message'})");
    assert.equal(ui.run("requestSendNowPreview()"), true);
    const task = deferred();
    ui.context.file = { name: "report.txt", size: 6, type: "text/plain", arrayBuffer: () => phase === "read" ? task.promise : Promise.resolve(new Uint8Array(6).buffer) };
    if (phase === "upload") {
      ui.context.upload = task.promise;
      ui.run("fixture.override=channel=>channel==='mail:uploadAttachment'?upload:undefined");
    }
    const preparing = ui.run("addComposeFiles([file])");
    await tick();
    assert.match(ui.get("compose-attachments").textContent, /Preparing attachment.*report.txt/);
    assert.equal(ui.run("composeReady()"), false);
    for (const id of ["compose-save", "compose-send", "compose-schedule"]) assert.equal(ui.get(id).disabled, true);
    assert.equal(await ui.run("confirmComposePreview()"), false);
    await ui.run("saveDraft();sendMail();scheduleMail()");
    assert.equal(ui.run("fixture.calls.some(item=>['mail:upsertDraft','mail:send','mail:scheduleSend'].includes(item.channel))"), false);
    ui.get("compose").close();
    await ui.run("openCompose({to:'new@example.test',body:'New session'})");
    task.resolve(phase === "read" ? new Uint8Array(6).buffer : { storageUrl: "local:old", filename: "report.txt", size: 6 });
    await preparing;
    assert.equal(ui.run("state.composeAttachments.length"), 0);
    assert.equal(ui.run("composeFilesPending()"), false);
  }
});

test("Compose P2: attachment completion or failure clears its pending state before actions resume", async () => {
  for (const failed of [false, true]) {
    const ui = composeFixture();
    await ui.run("openCompose({to:'client@example.test',body:'Message'})");
    const task = deferred();
    ui.context.file = { name: "report.txt", size: 6, type: "text/plain", arrayBuffer: () => task.promise };
    const preparing = ui.run("addComposeFiles([file])");
    if (failed) task.reject(new Error("Synthetic file read failure"));
    else task.resolve(new Uint8Array(6).buffer);
    await preparing;
    assert.equal(ui.run("composeFilesPending()"), false);
    assert.equal(ui.get("compose-send").disabled, false);
    assert.equal(ui.run("state.composeAttachments.length"), failed ? 0 : 1);
    if (failed) assert.match(ui.get("compose-attach-error").textContent, /file read failure/);
    else {
      await ui.run("sendMail()");
      assert.equal(ui.run("fixture.queue[0].attachments.length"), 1);
    }
  }
});

test("Compose P2: production scheduled-to-draft conversion rolls back both sides of failed recovery", () => {
  for (const failure of ["none", "insert", "delete", "sending"]) {
    let queued = { id: "queue", account_id: "a", send_at: Date.parse("2026-10-30T10:00:00Z"), status: failure === "sending" ? "sending" : "pending",
      payload_json: JSON.stringify({ to: ["client@example.test"], cc: [], bcc: [], body: "Queued body", subject: "Queued" }) };
    let draft = null;
    const transaction = (callback) => {
      const beforeQueue = copy(queued), beforeDraft = copy(draft);
      try { return callback(); } catch (error) { queued = beforeQueue; draft = beforeDraft; throw error; }
    };
    const database = {
      scheduledById: () => queued, accountById: () => ({ id: "a", email: "alice@alpha.test" }),
      folderByWellKnown: () => ({ path: "Drafts" }), newMessageId: () => "recovery",
    };
    database.scheduledToDraft = productionFunctions("host/mail/db.js", ["scheduledToDraft"], {
      transaction, scheduledById: () => queued,
      insertMessageRecord: (record) => { draft = record; if (failure === "insert") throw new Error("Synthetic insert failure"); },
      run: () => { if (failure === "delete") throw new Error("Synthetic delete failure"); queued = null; },
    }).scheduledToDraft;
    const engine = productionFunctions("host/mail/engine.js", ["editScheduled"], {
      db: database, scheduledDelivering: new Set(),
      fail: (code, message) => ({ success: false, error: { code, message } }), ok: (data) => ({ success: true, data }),
      resolveAttachments: () => ({ meta: [] }), textEncoding: { presentMessage: (message) => ({ ...message, textBody: message.htmlBody }) },
      plainFromHtml: (text) => text, addrList: (value) => value || [], rfcMessageId: () => "<synthetic@example.test>",
      emitAccounts() {}, agentTodoOf: () => null,
    });
    if (["insert", "delete"].includes(failure)) assert.throws(() => engine.editScheduled({ id: "queue" }), /Synthetic/);
    else assert.equal(engine.editScheduled({ id: "queue" }).success, failure === "none");
    if (failure === "none") {
      assert.equal(queued, null);
      assert.equal(draft.isDraft, true);
      assert.equal(draft.htmlBody, "Queued body");
      assert.deepEqual(copy(draft.cc), []);
      assert.deepEqual(copy(draft.bcc), []);
    } else { assert.ok(queued); assert.equal(draft, null); }
  }
});

test("Compose P2/P3: query changes fence highlighted/clicked choices and escaped contact names round-trip", async () => {
  const ui = composeFixture();
  await ui.run("openCompose()");
  ui.get("compose-to").value = "ali";
  ui.run("paintRecipientSuggest($('compose-to'),[{name:'Alice',email:'alice@old.test'}]);moveRecipientSuggest(1)");
  ui.get("compose-to").value = "bob@new.test";
  ui.run("chooseRecipientSuggest('alice@old.test')");
  assert.equal(ui.get("compose-to").value, "bob@new.test");
  ui.get("compose-to").value = "ali";
  ui.run("paintRecipientSuggest($('compose-to'),[{name:'Alice',email:'alice@old.test'}]);moveRecipientSuggest(1)");
  ui.get("compose-to").value = "bob@new.test";
  ui.run("scheduleRecipientSuggest($('compose-to'));chooseRecipientSuggest('alice@old.test')");
  assert.equal(ui.get("recipient-suggest").hidden, true);
  assert.equal(ui.get("compose-to").value, "bob@new.test");
  ui.run("hideRecipientSuggest()");
  const text = recipients.applyChoice("ops", { name: 'Acme 12" Displays', email: "ops@example.test" });
  assert.equal(recipients.activeQuery(text + "bob"), "bob");
  assert.equal(recipients.activeQuery(recipients.applyChoice("ops", { name: 'Path \\"quoted"', email: "ops@example.test" }) + "bob"), "bob");
});

test("Compose P2: untouched multiline HTML signatures follow an alias; edited signatures do not", async () => {
  for (const edited of [false, true]) {
    const ui = composeFixture();
    ui.run(`fixture.signatures={signatures:[{id:'alpha',html:'<div>Alice</div><div>Alpha team</div>'},{id:'alias',text:'Alias team'}],
      defaultSignaturePerAccount:{a:'alpha'},signatureByDomainPerAccount:{a:{'alias.test':'alias'}}};`);
    await ui.run("openCompose({to:'client@example.test'})");
    const editor = ui.get("compose-editor");
    const signature = { innerHTML: edited ? "<div>My edit</div>" : "<div>Alice</div><div>Alpha team</div>", replaceChildren() {} };
    editor.innerHTML = "<p>Message</p><div data-compose-signature>" + signature.innerHTML + "</div>";
    editor.querySelector = () => signature;
    editor.cloneNode = () => { const clone = { innerHTML: editor.innerHTML }; clone.querySelector = () => ({ remove() { clone.innerHTML = "<p>Message</p>"; } }); return clone; };
    ui.run("appendSafeMailHtml=(node,html)=>{node.innerHTML=html;};sanitizeComposeHtml=html=>html;syncComposePlainFromEditor()");
    ui.get("compose-from").value = "alice@alias.test";
    ui.run("changeComposeFrom()");
    assert.match(ui.get("compose-body").value, edited ? /My edit/ : /Message\n\nAlias team/);
    assert.equal(ui.get("signature").value, edited ? "alpha" : "alias");
  }
});

test("Brain P1: Refresh and Rebuild preserve concurrent rule additions, edits, deletions and categories", async () => {
  for (const mode of ["refresh", "rebuild"]) {
    const host = brainFixture({ userRules: [{ id: "edit", value: "Original" }, { id: "delete", value: "Delete" }] });
    const analyzing = mode === "refresh" ? host.brain.refreshFromMail(false) : host.brain.rebuildFromMail();
    host.answer("emailBrain:setWritingRule", { itemId: "edit", text: "Edited" });
    host.answer("emailBrain:deleteWritingRule", { itemId: "delete" });
    host.answer("emailBrain:addWritingRule", { text: "Added" });
    host.answer("emailBrain:saveCategories", { categories: [{ id: "new", name: "New category" }] });
    const latest = host.read();
    host.calls[0].resolve(JSON.stringify({ writing: ["Fresh generated rule"], sections: [] }));
    await analyzing;
    assert.deepEqual(host.read().userRules, latest.userRules);
    assert.deepEqual(host.read().categories, latest.categories);
    assert.equal(host.read().generated.writing[0], "Fresh generated rule");
  }
});

test("Brain P2: non-Latin facts and names survive all production normalizers", () => {
  for (const facts of [["王小明", "陳大文"], ["田中太郎", "山田花子"], ["Алексей", "Дмитрий"], ["😀", "😎"]]) {
    const generated = persona.buildGenerated(null, { writing: facts, voiceQuotes: facts,
      identity: { ownerName: facts[0], displayNames: facts, nicknames: [], orgs: facts }, sections: [{ id: "work-patterns", rows: facts.map((value) => ({ label: value, value })) }] }, { messages: [] }, "rebuild", []);
    assert.deepEqual(generated.writing, facts);
    assert.deepEqual(generated.voiceQuotes, facts);
    if (facts[0] !== "😀") {
      assert.equal(generated.identity.displayNames.length, 2);
      assert.equal(generated.identity.orgs.length, 2);
    }
    assert.equal(generated.sections.find((section) => section.id === "work-patterns").rows.length, 2);
  }
});

test("Brain P2: voice Fix persists; obsolete positional Fix and missing rows cannot report success", async () => {
  const host = brainFixture();
  const fixingVoice = host.answer("emailBrain:fixItem", { itemId: "voice:0", value: "Old quotation." });
  host.calls[0].resolve("Corrected quotation.");
  assert.equal((await fixingVoice).success, true);
  assert.equal(host.read().generated.voiceQuotes[0], "Corrected quotation.");
  assert.equal(host.answer("emailBrain:getCached").data.persona.profile.sections.find((section) => section.id === "voice").rows[0].value, "Corrected quotation.");
  const refreshing = host.brain.refreshFromMail(false);
  const fixing = host.answer("emailBrain:fixItem", { itemId: "how-you-write:0", value: "Keep replies concise." });
  host.calls[1].resolve(JSON.stringify({ writing: ["Sign off warmly."], sections: [] }));
  await refreshing;
  host.calls[2].resolve("Keep every reply short.");
  assert.equal((await fixing).success, false);
  assert.equal(host.read().generated.writing[0], "Sign off warmly.");
  const missing = await host.answer("emailBrain:fixItem", { itemId: "voice:99", value: "Gone" });
  assert.equal(missing.success, false);
  assert.equal(host.calls.length, 3);
});

test("Brain P1/P2: a learned Fix completed during analysis is not overwritten by the older persona job", async () => {
  const host = brainFixture();
  const refreshing = host.brain.refreshFromMail(false);
  const fixing = host.answer("emailBrain:fixItem", { itemId: "voice:0", value: "Old quotation." });
  host.calls[1].resolve("Keep my correction."); await fixing;
  host.calls[0].resolve(JSON.stringify({ writing: ["New rule"], sections: [] })); await refreshing;
  assert.equal(host.read().generated.voiceQuotes[0], "Keep my correction.");
  assert.match(host.events.findLast((event) => event.channel === "emailBrain:refreshState").payload.error, /profile changed/);
});

test("Brain P2: category save/readback preserves both newer list edits and unsubmitted form typing", async () => {
  for (const duringWrite of [false, true]) {
    const saving = deferred(), readback = deferred();
    const ui = uiFixture(async (channel) => channel === "emailBrain:saveCategories" ? saving.promise
      : channel === "emailBrain:getCategories" ? readback.promise : { success: true, data: {} });
    ui.run("brainCategoriesReady=true;brainCategories=[{id:'work',name:'Work',description:'',collapseView:false}];paintCategories();globalThis.saving=saveBrainCategories()");
    if (!duringWrite) { saving.resolve({ success: true, data: {} }); await tick(); }
    ui.run("startCategoryEdit(0);$('brain-category-name').value='Newer edit';submitCategory({preventDefault(){}});startCategoryEdit(0);$('brain-category-description').value='Still typing'");
    saving.resolve({ success: true, data: {} }); await tick();
    readback.resolve({ success: true, data: { categories: [{ id: "work", name: "Work" }] } });
    await ui.run("saving");
    assert.equal(ui.run("brainCategories[0].name"), "Newer edit");
    assert.equal(ui.nodes.get("brain-category-description").value, "Still typing");
    assert.match(ui.nodes.get("brain-category-status").textContent, /Newer edits are not saved/);
    assert.equal(ui.run("JSON.stringify(brainCategories)!==updateCategoriesBaseline"), true);
  }
});

test("Brain P3: actual compose preferences accept equals in both CC and BCC recipients", () => {
  const context = vm.createContext({ window: { morrowComposePolicy: require("../shared/compose-policy") }, document: {} });
  vm.runInContext(fs.readFileSync(path.join(root, "renderer/brain-compose.js"), "utf8"), context);
  for (const label of ["CC", "BCC"]) {
    context.label = label;
    assert.equal(vm.runInContext("window.morrowBrainCompose.parseDomainLines('@example.test = archive=team@example.org',label)['example.test'][0]", context), "archive=team@example.org");
  }
});

test("Calendar P2: title-only edits omit time fields for both providers during the repeated DST hour", async () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    for (const provider of ["google", "microsoft"]) {
      const { ui } = calendarFixture();
      ui.run("openCalendarEditor({id:'event',calendarId:'primary',title:'Original',start:'2026-11-01T01:30:12-05:00',end:'2026-11-01T02:00:34-05:00'});$('calendar-event-title').value='New title';loadCalendar=async()=>{};globalThis.saving=submitCalendarForm(submit)");
      const draft = copy(ui.run("calls.find(item=>item.channel==='calendar:updateEvent').payload"));
      assert.equal(Object.hasOwn(draft, "start"), false);
      assert.equal(Object.hasOwn(draft, "end"), false);
      const requests = [];
      await calendar.updateEvent(provider, "synthetic", "primary", "event", draft, async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return reply(provider === "google" ? { id: "event", start: { dateTime: "2026-11-01T06:30:12Z" } }
          : { id: "event", start: { dateTime: "2026-11-01T06:30:12Z" } });
      });
      assert.equal(Object.hasOwn(requests[0], "start"), false);
      assert.equal(Object.hasOwn(requests[0], "isAllDay"), false);
      ui.run("writes[0].resolve({})"); await ui.run("saving");
      assert.match(ui.run("calendarDraft({accountId:'box',calendarId:'primary',title:'Time edit',start:'2026-11-01T01:30',end:'2026-11-01T02:30'}).error"), /ambiguous/);
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test("Calendar P2: literal descriptions survive Google HTML and Graph Text serializers; HTML projections retain links", async () => {
  const text = "Bring <laptop> and <adapter>. A & B";
  for (const provider of ["google", "microsoft"]) {
    let payload;
    const result = await calendar.createEvent(provider, "synthetic", "primary", { title: "Meeting", start: "2026-10-30T09:00:00Z", end: "2026-10-30T10:00:00Z", description: text }, async (_url, options) => {
      payload = JSON.parse(options.body);
      return reply(provider === "google" ? { ...payload, id: "created" } : { ...payload, id: "created" });
    });
    assert.equal(provider === "google" ? calendar.plainDescription(payload.description) : payload.body.content, text);
    assert.equal(result.description, text);
  }
  const html = '<p>Join <a href="https://meet.example.test/room?one=1&amp;two=2">the meeting</a></p>';
  assert.match(calendar.plainDescription(html), /https:\/\/meet.example.test\/room\?one=1&two=2/);
  let replacement;
  await calendar.updateEvent("google", "synthetic", "primary", "event", {
    title: "Meeting", description: calendar.plainDescription(html) + " Bring <laptop>.", descriptionBase: calendar.plainDescription(html),
  }, async (_url, options) => {
    if (options.method === "GET") return reply({ id: "event", etag: '"revision"', description: html });
    assert.equal(options.headers["if-match"], '"revision"');
    replacement = JSON.parse(options.body);
    return reply({ ...replacement, id: "event", start: { dateTime: "2026-10-30T09:00:00Z" } });
  });
  assert.match(replacement.description, /meet\.example\.test/);
  assert.match(calendar.plainDescription(replacement.description), /Bring <laptop>/);
});

test("Calendar P2: actual editor retries reuse provider creation IDs after a committed response is lost", async () => {
  for (const provider of ["google", "microsoft"]) {
    const { ui, node } = calendarFixture();
    const events = new Map(), identities = [];
    let first = true;
    const fetcher = async (url, options) => {
      if (options.method === "GET" || !options.method) return reply(events.get(url.split("/").at(-1)));
      const body = JSON.parse(options.body);
      const id = body.id || body.transactionId;
      identities.push(id);
      if (events.has(id)) return provider === "google" ? reply({ error: { code: 409 } }, 409) : reply(events.get(id));
      events.set(id, { ...body, id });
      if (first) { first = false; throw new Error("Synthetic lost response"); }
      return reply(events.get(id));
    };
    ui.context.create = (draft) => calendar.createEvent(provider, "synthetic", "primary", copy(draft), fetcher);
    ui.run("call=(channel,payload)=>channel==='calendar:createEvent'?create(payload):Promise.resolve({});loadCalendar=async()=>{};");
    await ui.run("submitCalendarForm(submit)");
    assert.equal(node("calendar-event-dialog").open, true);
    assert.match(node("calendar-form-status").textContent, /could not be confirmed/);
    const title = node("calendar-event-title").value;
    node("calendar-event-title").value = "Changed uncertain submission";
    await ui.run("submitCalendarForm(submit)");
    assert.match(node("calendar-form-status").textContent, /earlier creation may already exist/);
    assert.equal(identities.length, 1);
    node("calendar-event-title").value = title;
    await ui.run("submitCalendarForm(submit)");
    assert.equal(events.size, 1);
    assert.equal(identities.length, 2);
    assert.equal(identities[0], identities[1]);
    assert.match(identities[0], /^[a-f0-9]{32}$/);
    assert.equal(node("calendar-event-dialog").open, false);
  }
});

test("Calendar P2: known grant failures request explicit reauthorization, without changing ordinary reuse", async () => {
  for (const failed of [false, true]) {
    const { ui } = calendarFixture();
    ui.run("state.accounts[0].profile='outlook';state.calendarStatus={accounts:[{id:'box',calendar:true}]};");
    if (failed) {
      const loading = ui.run("loadCalendar({fresh:true})");
      await tick();
      ui.run("reads[0].reject(Object.assign(new Error('Grant expired'),{code:'needs_auth'}))"); await loading;
      assert.equal(ui.run("calendarConnection(state.calendarStatus,calendarAccount(),oldPayload,calendarAuthFailures.has('box')).label"), "Reauthorize calendar");
    }
    ui.run("loadCalendar=async()=>{};call=async(channel,payload)=>{calls.push({channel,payload});return {api:true};}");
    await ui.run("grantCalendar()");
    assert.equal(ui.run("calls.findLast(item=>item.channel==='calendar:connect').payload.forceReauthorize===true"), failed);
  }
});

test("Calendar P2: the actual sidecar reenters consent for a revoked stored grant and preserves credentials on cancellation", async () => {
  const config = load("host/mail/oauth-config.js", {
    fs: { readFileSync: (filename) => { assert.equal(filename, path.join(root, "shared/microsoft-client-id.txt")); return "synthetic-client"; } },
    "../paths": { userDataDir: () => "/synthetic" },
  });
  const account = { id: "box", email: "box@example.test", profile: "outlook", auth_kind: "oauth2", mail_transport: "imap", created_at: 1 };
  const credentials = new Map([["box", JSON.stringify({ refreshToken: "synthetic-mail", grantedScopes: "IMAP" })],
    ["box:bundle", JSON.stringify({ refreshToken: "synthetic-revoked", grantedScopes: "Calendars.ReadWrite" })]]);
  const original = [...credentials];
  const credentialRevisions = new Map();
  let signIns = 0;
  const sidecar = load("host/mail/sidecar.js", {
    "./db": { accountById: () => account, listAccountRows: () => [account] },
    "./secrets": { getPassword: (key) => credentials.get(key) || null, getPasswordAsync: async (key) => credentials.get(key) || null,
      revision: (key) => credentialRevisions.get(key) || 0,
      setPassword(key, value) { credentials.set(key, value); credentialRevisions.set(key, (credentialRevisions.get(key) || 0) + 1); },
      deletePassword(key) { credentials.delete(key); credentialRevisions.set(key, (credentialRevisions.get(key) || 0) + 1); } },
    "./oauth": { oauthReady: () => ({ microsoft: true }),
      accessTokenFor: async () => { throw Object.assign(new Error("Grant expired"), { code: "needs_auth" }); },
      signIn: async () => { signIns += 1; throw new Error("Synthetic consent canceled"); } },
    "./oauth-config": config, "./calendar-api": calendar, "./provider-api": {}, "./inbox-rules": {}, "./vacation-api": {}, "./sieve-vacation": {},
  });
  const { ui } = calendarFixture();
  ui.context.hostInvoke = async (channel, payload) => {
    const result = await sidecar.answer(channel, [payload]);
    if (result.success === false) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.data;
  };
  ui.run("call=hostInvoke");
  await ui.run("loadCalendar({fresh:true})");
  assert.equal(ui.run("calendarAuthFailures.has('box')"), true);
  await assert.rejects(ui.run("grantCalendar()"), /consent canceled/);
  assert.equal(signIns, 1);
  assert.deepEqual([...credentials], original);
  const ordinary = await sidecar.answer("calendar:connect", [{ accountId: "box" }]);
  assert.equal(ordinary.success, true);
  assert.equal(signIns, 1);
});

test("Calendar P2: confirmed Delete invalidates the captured account even after Cancel or account switch", async () => {
  for (const switched of [false, true]) {
    const { ui, cancel } = calendarFixture();
    ui.run("askConfirm=async()=>({ok:true});openCalendarEditor({id:'deleted',calendarId:'primary',title:'Delete',start:'2026-10-30T09:00:00Z',end:'2026-10-30T10:00:00Z'});globalThis.deleting=deleteCalendarEvent(calendarEditingIdentity)");
    await tick(); cancel();
    if (switched) ui.run("state.calendarAccountId='other'");
    ui.run("writes[0].resolve({})"); await ui.run("deleting");
    assert.equal(ui.run("calendarCache.has(key)||calendarCache.has(secondKey)"), false);
    assert.equal(ui.run("calendarCache.has(otherKey)"), true);
    assert.equal(ui.run("calendarRevisions.get('box')"), 1);
    assert.equal(ui.run("notices.length"), 0);
  }
});

test("Calendar P3: Google calendar pagination preserves later-page selection and rejects incomplete enumeration", async () => {
  let requests = 0;
  const rows = await calendar.listCalendars("google", "synthetic", async (url) => {
    requests += 1;
    return reply(new URL(url).searchParams.has("pageToken") ? { items: [{ id: "wanted", summary: "Wanted" }] }
      : { items: [{ id: "primary", summary: "Primary", primary: true }], nextPageToken: "next" });
  });
  assert.equal(requests, 2);
  assert.deepEqual(calendar.selectedCalendarIds(rows, { calendarIds: ["wanted"] }), ["wanted"]);
  await assert.rejects(calendar.listCalendars("google", "synthetic", async () => reply({ items: [], nextPageToken: "repeat" })), /incomplete calendar list/);
});

test("Calendar P3: agenda and shared day-cell comparator order different offsets by actual instant", () => {
  const { ui } = calendarFixture();
  ui.run("globalThis.offsetEvents=[{id:'first',start:'2026-10-30T09:00:00+09:00'},{id:'second',start:'2026-10-30T08:30:00Z'}]");
  assert.equal(ui.run("agendaEvents(offsetEvents)[0].id"), "first");
  assert.ok(ui.run("compareCalendarStarts(offsetEvents[0],offsetEvents[1])") < 0);
});

test("Features: production catalog rendering and page/CLI help describe the fixed contracts", () => {
  const ui = uiFixture();
  ui.context.window.morrowFeaturesCatalog = require("../renderer/features-catalog");
  ui.run("paintFeatureCatalog()");
  const text = ui.nodes.get("features-catalog").textContent;
  for (const claim of [/AI draft events cannot replace manual edits/, /Preparing attachment/, /inert recovery draft/,
    /cleared Cc\/Bcc/, /Untouched multiline HTML/, /retires old suggestion choices/, /non-Latin names/,
    /voice quotes/, /Category-save readback preserves newer/, /Undo cancels the queued send/,
    /If Compose cannot open, resume it from local Drafts/, /Recovery failure leaves the queued send unchanged/,
    /Once delivery starts, Undo cannot cancel it/, /Reauthorize calendar/, /transaction ID/,
    /literal angle brackets/, /preserving offsets and seconds/, /saves and deletes invalidate/]) assert.match(text, claim);
  const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
  assert.match(html, /id="cli-page-recovery"[^>]*>[^<]*bot capabilities and permissions are unchanged/);
  assert.match(html, /These fixes do not expose calendar writes through the Node bot client/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "shared/bot-contract-v1.json"), "utf8"), /calendar:createEvent/);
  assert.match(html, /id="brain-persona-hint"[^>]*>[^<]*saved edits made during analysis/);
  assert.match(html, /id="calendar-save-note"[^>]*>[^<]*Retry unchanged creation/);
  assert.match(html, /id="pref-undo-help"[^>]*>[^<]*saves a recovery copy in local Drafts before reopening Compose/);
});

test("Existing provider description guards still reject lossy, stale, oversized and uncertain replacements", async () => {
  for (const script of ["scripts/check-move-calendar-patches.js", "scripts/check-account-calendar-attachments.js"]) {
    const suite = load(script, {}, (source) => source + "\nmodule.exports.calendarChecks=calendarChecks;\n");
    await suite.calendarChecks();
  }
});
