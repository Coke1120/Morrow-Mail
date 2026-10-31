const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const { test } = require("node:test");
const { renderer } = require("./check-ux-workflows");

const html = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const ok = (data) => ({ success: true, data });
function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

class Element {
  constructor(tagName, document) {
    this.tagName = tagName;
    this.ownerDocument = document;
    this.nodeType = 1;
    this.childNodes = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.classes = new Set();
    this.style = { setProperty() {} };
    this.text = "";
    this.value = "";
    this.hidden = false;
    this.checked = false;
    this.disabled = false;
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, force = !this.classes.has(name)) => force ? this.classes.add(name) : this.classes.delete(name),
    };
  }
  get className() { return [...this.classes].join(" "); }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes.at(-1) || null; }
  get isConnected() { return this.tagName === "body" || !!this.parentNode?.isConnected; }
  get textContent() { return this.text + this.childNodes.map((node) => node.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, before) {
    if (node === before) return node;
    node.remove();
    node.parentNode = this;
    const index = before ? this.childNodes.indexOf(before) : -1;
    if (index < 0) this.childNodes.push(node);
    else this.childNodes.splice(index, 0, node);
    return node;
  }
  append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
  prepend(...nodes) { nodes.reverse().forEach((node) => this.insertBefore(node, this.firstChild)); }
  replaceChildren(...nodes) { this.childNodes.forEach((node) => { node.parentNode = null; }); this.childNodes = []; this.text = ""; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((node) => node !== this); this.parentNode = null; }
  contains(node) { return !!node && (node === this || this.childNodes.some((child) => child.contains(node))); }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === "class") this.className = value; }
  getAttribute(name) {
    if (name === "id") return this.id || null;
    if (name === "class") return this.className;
    if (name.startsWith("data-")) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())] ?? null;
    return this.attributes[name] ?? null;
  }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  dispatch(name) { return this.listeners.get(name)?.({ target: this, preventDefault() {}, stopPropagation() {} }); }
  click() { if (!this.disabled) return this.onclick ? this.onclick() : this.dispatch("click"); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
  matches(selector) {
    const attributes = [...selector.matchAll(/\[([^=\]]+)(?:=["']?([^"'\]]*)["']?)?\]/g)];
    const bare = selector.replace(/\[[^\]]*\]/g, "");
    const tag = bare.match(/^[\w-]+/);
    if (tag && tag[0] !== this.tagName) return false;
    if ([...bare.matchAll(/\.([\w-]+)/g)].some((match) => !this.classes.has(match[1]))) return false;
    const id = bare.match(/#([\w-]+)/);
    if (id && this.id !== id[1]) return false;
    return attributes.every((match) => match[2] == null ? this.getAttribute(match[1]) != null : this.getAttribute(match[1]) === match[2]);
  }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  querySelectorAll(selector) {
    const rows = this.childNodes.flatMap((node) => [node, ...node.querySelectorAll("*")]);
    return rows.filter((node) => selector.split(",").some((group) => {
      const direct = group.trim().startsWith(":scope > ");
      return (!direct || node.parentNode === this) && node.matches(group.trim().replace(/^:scope > /, ""));
    }));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function uiFixture(invoke = async () => ok({})) {
  const nodes = new Map(), subscriptions = new Map();
  const document = { activeElement: null, createElement: (tag) => new Element(tag, document), getElementById: (id) => nodes.get(id) || null };
  document.body = document.createElement("body");
  document.documentElement = document.createElement("html");
  document.createElementNS = (_namespace, tag) => document.createElement(tag);
  document.createTextNode = (text) => { const node = document.createElement("text"); node.nodeType = 3; node.textContent = text; return node; };
  document.querySelectorAll = (selector) => document.body.querySelectorAll(selector);
  document.querySelector = (selector) => document.body.querySelector(selector);
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
    const node = document.createElement("div"); node.id = match[1]; nodes.set(node.id, node); document.body.appendChild(node);
  }
  const window = { morrow: { invoke, on: (channel, listener) => subscriptions.set(channel, listener) }, location: { search: "" } };
  const ui = renderer({ document, window, URLSearchParams, queueMicrotask, setImmediate, setInterval: () => 0, clearInterval() {} });
  ui.run(`globalThis.productionRenderList=renderList; globalThis.productionLoadList=loadList;
    renderReader = () => {}; renderList = () => {}; loadList = async () => {}; settleOpenView = async () => {}; afterPaint = fn => fn();
    state.accounts = [{id:'a',email:'me@example.test',platform:'imap',folders:{primary:[{id:'Inbox',name:'Inbox',wellKnownName:'inbox'}],more:[]}}];
    state.accountId='a'; state.folderId='Inbox'; state.view='mail'; state.prefs.images=false;`);
  return { ...ui, nodes, subscriptions, json: (code) => JSON.parse(ui.run(`JSON.stringify(${code})`)) };
}

function hostFixture(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-wave1-"));
  const filename = path.join(__dirname, "../host/agent.js");
  const localRequire = Module.createRequire(filename);
  const database = { mailActionById: () => null, foldersFor: () => [{ name: "Work", path: "Work" }] };
  const stubs = {
    "./ai-config": { userDataDir: () => directory, loadConfig: () => ({ apiKey: "synthetic" }) },
    "./openai-client": { complete: async () => { throw new Error("Live AI forbidden"); }, extractJson: JSON.parse },
    "./brain": { taxonomy: () => [], writingBrief: () => "", identityBrief: () => "" },
    "./mail/db": database,
    "./mail/sidecar": { answer: async () => ok({ api: false }) },
    "./mail/engine": { answer: async () => ok({ pending: [], outcomes: [] }) },
    electron: { BrowserWindow: { getAllWindows: () => [] } },
    ...overrides,
  };
  const context = vm.createContext({ require: (request) => stubs[request] || localRequire(request), module: { exports: {} }, console, process, setTimeout, clearTimeout, setImmediate, setInterval, clearInterval, Buffer });
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
  const run = (code) => vm.runInContext(code, context);
  run(`cachedMessage = id => ({id,accountId:'a',folderPath:'Inbox'}); mailboxConnected = () => true;`);
  const storePath = path.join(directory, "agent.json");
  const store = { installedSkillIds: ["morning-brief"], runs: [], triage: null, todos: {}, schedules: [], proposals: [{ id: "p", status: "pending", messageId: "one", accountId: "a", labelName: "Work" }] };
  fs.writeFileSync(storePath, JSON.stringify(store));
  return { run, context, database: stubs["./mail/db"], read: () => JSON.parse(fs.readFileSync(storePath, "utf8")), write: (value) => fs.writeFileSync(storePath, JSON.stringify(value)), close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test("Mail F1: an uncertain Outbox claim retains content, identity and recovery across a lost notification", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../host/mail/engine.js"), "utf8");
  const pump = source.slice(source.indexOf("async function pumpScheduledAdmitted()"), source.indexOf("const GOOGLE_OAUTH_IMPORT_MESSAGES"));
  const row = { id: "queued", account_id: "a", status: "pending", payload_json: JSON.stringify({ outbox: true, subject: "Keep me", body: "Durable body" }) };
  const database = { dueScheduled: () => [row], scheduledById: () => row, accountById: () => ({ email: "me@example.test" }),
    claimScheduled: () => { row.status = "sending"; row.message_id = "<stable@example.test>"; return row; },
    failScheduled: (_id, _error, unknown) => { row.status = unknown ? "unknown" : "failed"; },
    deleteScheduled: () => assert.fail("An uncertain record must never be deleted") };
  let deliveries = 0;
  const context = vm.createContext({ ready: true, pumping: false, db: database, scheduledDelivering: new Set(), rfcMessageId: () => "<stable@example.test>",
    clearOutboxWake() {}, textEncoding: { presentMessage: (value) => value }, agentTodoOf: () => null, outboxNoticeSeed: () => ({}),
    deliver: async () => { ++deliveries; return { success: false, error: { delivery: "unknown", message: "Lost DATA acknowledgment" } }; },
    emitAccounts: () => { throw new Error("No renderer listener"); } });
  vm.runInContext(pump, context);
  const notices = await vm.runInContext("pumpScheduledAdmitted()", context);
  assert.equal(row.status, "unknown");
  assert.equal(row.message_id, "<stable@example.test>");
  assert.equal(JSON.parse(row.payload_json).body, "Durable body");
  assert.equal(notices[0].outboxRestore, undefined);
  assert.equal(notices[0].outboxReceipt.uncertain, true);
  assert.match(notices[0].outboxReceipt.message, /uncertain.*Scheduled delivery review/);
  await vm.runInContext("pumpScheduledAdmitted()", context);
  assert.equal(deliveries, 1);
});

test("Mail F2/F8: CSS image functions cannot bypass opt-out and backgrounds expose the per-message gate", () => {
  const ui = uiFixture();
  for (const value of ['image-set("https://example.invalid/pixel" 1x)', '-webkit-image-set("https://example.invalid/pixel" 1x)', 'cross-fade(url(https://example.invalid/pixel), red, 50%)', 'image("https://example.invalid/pixel")']) {
    ui.context.css = value;
    assert.equal(ui.run("mailCssValue('background-image',css,false)"), "");
  }
  assert.equal(ui.run("mailCssValue('background-image','url(https://example.invalid/pixel)',false)"), "");
  assert.match(ui.run("mailCssValue('background-image','url(https://example.invalid/pixel)',true)"), /https:/);
  assert.match(ui.run("mailCssValue('background-image','linear-gradient(red, blue)',false)"), /gradient/);
  ui.run(`globalThis.cssWrites=[]; mailApplyCss({style:{setProperty:(...args)=>cssWrites.push(args)}}, 'background-image:image-set("https://example.invalid/pixel" 1x)', false, false);`);
  assert.equal(ui.run("cssWrites.length"), 0);
  ui.run(`globalThis.message={id:'one',htmlBody:'<table background="https://example.invalid/table"><td style="background-image:url(https://example.invalid/css)"></td></table>'}; renderRemoteGate($('reader'),message);`);
  assert.match(ui.nodes.get("reader").textContent, /2 remote images.*Load remote content/);
  ui.nodes.get("reader").querySelector("button").click();
  assert.equal(ui.run("state.remoteAllowed.one"), true);
});

for (const order of [["one", "two"], ["two", "one"]]) test("Mail F3: split-account settlements stay in one Undo session: " + order.join(","), async () => {
  const ui = uiFixture();
  ui.run(`globalThis.messages=['one','two'].map((id,index)=>({id,accountId:index?'b':'a',subject:id}));
    globalThis.epoch=beginRemovalRequest(messages,'archive');
    call=async(channel,params)=>({pending:params.items.map(item=>({id:item.emailId,actionId:'action-'+item.emailId,generation:1})),outcomes:[]});`);
  await ui.run(`(async()=>{ const outcome=await runBulk([{channel:'mail:archiveBatch',params:{items:messages.map(row=>({emailId:row.id}))}}],epoch); await finishBulkRemoval('Archive',outcome,['one','two'],{messages,action:'archive'}); })()`);
  for (const id of order) ui.run(`applyActionSettlement({outcomes:[{id:'${id}',actionId:'action-${id}',kind:'remove',generation:1,status:'completed',opId:'op-${id}'}],opIds:['op-${id}']});`);
  assert.deepEqual(ui.json("undoOpIds").sort(), ["op-one", "op-two"]);
  assert.deepEqual(ui.json("undoItems.map(item=>item.subject)").sort(), ["one", "two"]);
  ui.run(`beginRemovalRequest([{id:'new',accountId:'a'}],'trash'); applyActionSettlement({outcomes:[{id:'one',actionId:'action-one',kind:'remove',generation:1,status:'completed',opId:'op-one'}],opIds:['op-one']});`);
  assert.deepEqual(ui.json("undoOpIds").sort(), ["op-one", "op-two"]);
  ui.run(`clearUndo(); beginRemovalRequest([{id:'replacement',accountId:'a'}],'trash'); applyActionSettlement({outcomes:[{id:'one',actionId:'action-one',kind:'remove',generation:1,status:'completed',opId:'op-one'}],opIds:['op-one']});`);
  assert.equal(ui.run("undoOpIds"), null);
});

test("Mail F3: settlement before invoke return accumulates across batches but cannot revive a cleared session", async () => {
  const ui = uiFixture();
  ui.run(`globalThis.messages=[{id:'one',accountId:'a',subject:'Early'},{id:'two',accountId:'b',subject:'Later'}]; globalThis.epoch=beginRemovalRequest(messages,'archive');
    call=async()=>{ applyActionSettlement({outcomes:[{id:'one',actionId:'early',generation:1,kind:'remove',status:'completed',opId:'early-op'}],opIds:['early-op']}); return {pending:[{id:'one',actionId:'early',generation:1},{id:'two',actionId:'late',generation:1}],outcomes:[]}; };`);
  await ui.run(`(async()=>{const outcome=await runBulk([{channel:'mail:archiveBatch',params:{items:messages.map(row=>({emailId:row.id}))}}],epoch); await finishBulkRemoval('Archive',outcome,['one','two'],{messages,action:'archive'});})()`);
  ui.run("applyActionSettlement({outcomes:[{id:'two',actionId:'late',generation:1,kind:'remove',status:'completed',opId:'late-op'}],opIds:['late-op']})");
  assert.deepEqual(ui.json("undoOpIds"), ["early-op", "late-op"]);
  ui.run("beginRemovalRequest([{id:'one',accountId:'a'}],'trash'); applyActionSettlement({outcomes:[{id:'one',actionId:'early',generation:1,kind:'remove',status:'completed',opId:'early-op'}],opIds:['early-op']})");
  assert.deepEqual(ui.json("undoOpIds"), ["early-op", "late-op"]);
  ui.run("clearUndo(); beginRemovalRequest([{id:'replacement',accountId:'a'}],'trash'); applyActionSettlement({outcomes:[{id:'one',actionId:'early',generation:1,kind:'remove',status:'completed',opId:'early-op'}],opIds:['early-op']})");
  assert.equal(ui.run("undoOpIds"), null);
});

test("Mail F4/F5: the actual separate-reader boot subscribes to settlements and applies terminal flag refusal", async () => {
  const ui = uiFixture(async (channel) => ok(channel === "mail:listAccounts" ? [] : channel === "mail:openEmail" ? { email: { id: "one", accountId: "a", unread: false, subject: "Reader" } } : {}));
  ui.context.window.morrow.pullReaderSeed = async () => ({ messageId: "one", accountId: "a" });
  ui.run("wire=()=>{}; loadLook=async()=>{}; loadShellPrefs=async()=>{}; paintReaderPending=()=>{}; loadSnoozed=async()=>{}; loadProviderFolders=async()=>{}; pumpBodyRefreshes=()=>{};");
  await ui.run("bootReaderWindow()");
  assert.equal(typeof ui.subscriptions.get("mail:actionsSettled"), "function");
  ui.run(`call=async()=>({pending:[{id:'one',generation:1}],outcomes:[]});`);
  await ui.run("toggleStar(state.email)");
  assert.equal(ui.run("state.email.isStarred"), true);
  ui.subscriptions.get("mail:actionsSettled")({ outcomes: [{ id: "one", kind: "star", generation: 1, status: "failed", error: "Provider refused", projection: { isStarred: false, unread: true } }], opIds: [] });
  assert.equal(ui.run("state.email.isStarred"), false);
  ui.run(`call=async()=>({pending:[],outcomes:[{id:'one',kind:'star',generation:2,status:'failed',error:'Identity unresolved',projection:{isStarred:false,unread:true}}]});`);
  await assert.rejects(ui.run("toggleStar(state.email)"), /Identity unresolved/);
  assert.equal(ui.run("state.email.isStarred"), false);
  await assert.rejects(ui.run("setRead(state.email,true)"), /Identity unresolved/);
  assert.equal(ui.run("state.email.unread"), true);
  assert.doesNotMatch(ui.nodes.get("status").textContent, /^Starred\.$/);
  ui.run(`globalThis.epoch=beginRemovalRequest([state.email],'archive'); rememberRemovalReceipt({pending:[{id:'one',actionId:'removal',generation:3}]},epoch);`);
  ui.subscriptions.get("mail:actionsSettled")({ outcomes: [{ id: "one", actionId: "removal", generation: 3, kind: "remove", status: "completed", opId: "reader-undo" }], opIds: ["reader-undo"] });
  assert.deepEqual(ui.json("undoOpIds"), ["reader-undo"]);
});

test("Mail F5: a delayed terminal refusal cannot overwrite a newer flag projection", async () => {
  const ui = uiFixture();
  ui.run("state.email={id:'one',accountId:'a',unread:true}; call=async()=>{actionGeneration.set('one',3); state.email.unread=false; return {pending:[],outcomes:[{id:'one',kind:'read',generation:2,status:'failed',error:'Older refusal',projection:{unread:true,isStarred:false}}]};};");
  await assert.rejects(ui.run("setRead(state.email,true)"), /Older refusal/);
  assert.equal(ui.run("state.email.unread"), false);
});

for (const channel of ["mail:listFromNetwork", "mail:searchLocal"]) test("Mail F6: late " + channel + " cannot replace Outbox", async () => {
  const delayed = deferred();
  const ui = uiFixture(async (requested) => requested === channel ? delayed.promise : ok([{ id: "queue", accountId: "a", outbox: true, status: "pending", subject: "Waiting" }]));
  ui.run("loadList=productionLoadList;");
  ui.run("paintListPaging=()=>{}; renderAccounts=()=>{}; noteMailListLoaded=()=>{};");
  if (channel === "mail:searchLocal") ui.run("state.query='query';");
  const pending = ui.run("loadList(true)");
  await tick();
  await ui.run("selectOutbox()");
  delayed.resolve(ok(channel === "mail:searchLocal" ? [{ id: "old-search" }] : { emails: [{ id: "old-inbox" }] }));
  await pending;
  assert.equal(ui.run("state.outbox"), true);
  assert.equal(ui.run("state.emails[0].outbox"), true);
});

test("Mail F7: selected Outbox renders Unknown and Retry with an empty or stale queue", async () => {
  let failed = true;
  const ui = uiFixture(async () => { if (failed) throw new Error("Queue unavailable"); return ok([]); });
  ui.run("renderList=productionRenderList;");
  ui.run("paintSyncControl=()=>{}; paintListPaging=()=>{}; rememberLoadedSelection=()=>{}; renderChips=()=>{}; paintSelectionBar=()=>{}; paintSearchCoverage=()=>{}; renderAccounts=()=>{};");
  await ui.run("selectOutbox()");
  assert.equal(ui.nodes.get("scheduled-dialog").open, undefined);
  assert.match(ui.nodes.get("message-list").textContent, /Unknown.*Retry.*Waiting sends are unknown/);
  assert.doesNotMatch(ui.nodes.get("message-list").textContent, /Nothing is waiting/);
  failed = false;
  await ui.nodes.get("message-list").querySelector("button").click();
  assert.match(ui.nodes.get("message-list").textContent, /Nothing is waiting/);
  failed = true;
  ui.run("state.outboxRows=[{id:'stale',accountId:'a',outbox:true,status:'pending'}]; state.emails=[];");
  await ui.run("loadScheduled()");
  assert.match(ui.nodes.get("message-list").textContent, /out of date.*Retry/);
});

test("Agent F1/F2: filing follows matching journal receipts without overwriting interleaved state", async () => {
  const folders = deferred();
  const fixture = hostFixture({ "./mail/sidecar": { answer: () => folders.promise }, "./mail/engine": { answer: async () => ok({ pending: [{ id: "one", actionId: "filing-one", generation: 1 }], outcomes: [] }) } });
  try {
    const pending = fixture.run("confirmProposal({proposalId:'p'})");
    const duplicate = await fixture.run("confirmProposal({proposalId:'p'})");
    assert.equal(duplicate.data.accepted, false);
    const current = fixture.read();
    current.todos.other = { status: "done" };
    current.schedules = [{ skillId: "morning-brief", kind: "interval", everyMinutes: 30, paused: true }];
    current.proposals.push({ id: "dismissed", status: "dismissed" });
    current.runs.push({ id: "new-run" });
    fixture.write(current);
    folders.resolve(ok({ api: false }));
    const result = await pending;
    assert.equal(result.data.accepted, false);
    assert.equal(result.data.pending, true);
    assert.equal(fixture.read().proposals[0].status, "pending");
    assert.equal(fixture.read().todos.other.status, "done");
    assert.equal(fixture.read().schedules[0].paused, true);
    assert.equal(fixture.read().runs[0].id, "new-run");
    assert.equal(fixture.read().proposals[1].status, "dismissed");
    fixture.run("settleFilingOutcomes([{id:'one',actionId:'unrelated',status:'completed'}])");
    assert.equal(fixture.read().proposals[0].status, "pending");
    fixture.run("settleFilingOutcomes([{id:'one',actionId:'filing-one',status:'completed'}])");
    assert.equal(fixture.read().proposals[0].status, "confirmed");
  } finally { fixture.close(); }
});

for (const status of ["failed", "unknown", "not_attempted"]) test("Agent F1: direct and delayed " + status + " filing remains reviewable", async () => {
  for (const pending of [false, true]) {
    let attempts = 0;
    const row = { id: "one", actionId: "filing-one", status, error: "Not confirmed" };
    const fixture = hostFixture({ "./mail/engine": { answer: async () => { ++attempts; return ok(pending ? { pending: [{ id: "one", actionId: "filing-one" }], outcomes: [] } : { pending: [], outcomes: [row] }); } } });
    try {
      await fixture.run("confirmProposal({proposalId:'p'})");
      if (pending) { fixture.context.receipt = row; fixture.run("settleFilingOutcomes([receipt])"); }
      assert.equal(fixture.read().proposals[0].status, "pending");
      assert.equal(fixture.read().proposals[0].filing.status, status);
      if (status === "unknown") {
        await fixture.run("confirmProposal({proposalId:'p'})");
        assert.equal(attempts, 1);
      }
    } finally { fixture.close(); }
  }
});

test("Agent F2: a proposal dismissed during a successful provider write is not resurrected", async () => {
  const provider = deferred();
  const fixture = hostFixture({ "./mail/sidecar": { answer: () => provider.promise } });
  try {
    const pending = fixture.run("confirmProposal({proposalId:'p'})");
    const current = fixture.read(); current.proposals[0].status = "dismissed"; current.todos.other = { status: "done" }; fixture.write(current);
    provider.resolve(ok({ api: true, provider: "google", folders: [{ id: "Work", name: "Work" }] }));
    const result = await pending;
    assert.equal(result.data.accepted, false);
    assert.equal(fixture.read().proposals[0].status, "dismissed");
    assert.equal(fixture.read().todos.other.status, "done");
  } finally { fixture.close(); }
});

test("Agent F1/F2: a successful API filing preserves newer todo, proposal, run and schedule deletions", async () => {
  const provider = deferred();
  let calls = 0;
  const fixture = hostFixture({ "./mail/sidecar": { answer: async () => ++calls === 1 ? provider.promise : ok({}) } });
  try {
    const pending = fixture.run("confirmProposal({proposalId:'p'})");
    const current = fixture.read(); current.todos.other = { status: "done" }; current.runs.push({ id: "new" }); current.schedules = []; current.proposals.push({ id: "other", status: "dismissed" }); fixture.write(current);
    provider.resolve(ok({ api: true, provider: "google", folders: [{ id: "work", name: "Work" }] }));
    const result = await pending;
    assert.equal(result.data.accepted, true);
    assert.equal(fixture.read().todos.other.status, "done");
    assert.equal(fixture.read().runs[0].id, "new");
    assert.equal(fixture.read().proposals[1].status, "dismissed");
    assert.deepEqual(fixture.read().schedules, []);
  } finally { fixture.close(); }
});

test("Agent F1: saved filing links reconcile missed settlement from the matching durable journal", async () => {
  const fixture = hostFixture({ "./mail/engine": { answer: async () => ok({ pending: [{ id: "one", actionId: "persisted" }], outcomes: [] }) } });
  try {
    await fixture.run("confirmProposal({proposalId:'p'})");
    fixture.database.mailActionById = () => ({ id: "persisted", phase: "closed", receipt: "completed", message_id: "other", account_id: "a" });
    fixture.run("homePayload()");
    assert.equal(fixture.read().proposals[0].status, "pending");
    fixture.database.mailActionById = () => ({ id: "persisted", phase: "closed", receipt: "completed", message_id: "one", account_id: "a" });
    fixture.run("homePayload()");
    assert.equal(fixture.read().proposals[0].status, "confirmed");
  } finally { fixture.close(); }
});

test("Agent F1: pending and unsuccessful filing cards remain rendered and only completion removes them", async () => {
  const ui = uiFixture();
  ui.run("askConfirm=async()=>({ok:true}); loadAgent=async()=>{}; brainIsOpen=()=>false;");
  for (const status of ["pending", "failed", "unknown", "not_attempted"]) {
    ui.context.receipt = { accepted: false, pending: status === "pending", error: "Waiting or unconfirmed", proposals: [{ id: "p", status: "pending", messageId: "one", accountId: "a", labelName: "Work", filing: { actionId: "filing", status, error: "Not confirmed" } }] };
    ui.run("call=async()=>receipt");
    const confirm = ui.run("confirmProposal({id:'p',messageId:'one',labelName:'Work'})");
    if (status === "pending") await confirm;
    else await assert.rejects(confirm, /Waiting or unconfirmed/);
    const root = ui.nodes.get("agent-proposals");
    assert.match(root.textContent, /Work/);
    const button = root.querySelectorAll("button").find((node) => node.textContent === "Review filing…");
    assert.equal(button.disabled, status === "pending" || status === "unknown");
    assert.match(root.textContent, /Open in Mail/);
  }
  ui.run("call=async()=>({accepted:true,detail:'Moved',proposals:[]})");
  await ui.run("confirmProposal({id:'p'})");
  assert.match(ui.nodes.get("agent-proposals").textContent, /No moves waiting/);
});

test("Agent F1: the rendered filing button does not announce a pending receipt as confirmed", async () => {
  const ui = uiFixture();
  ui.context.receipt = { accepted: false, pending: true, error: "Waiting for mailbox confirmation.", proposals: [{ id: "p", status: "pending", messageId: "one", accountId: "a", labelName: "Work", filing: { actionId: "filing", status: "pending" } }] };
  ui.run("askConfirm=async()=>({ok:true}); loadAgent=async()=>{}; brainIsOpen=()=>true; call=async()=>receipt; paintProposals($('agent-proposals'),[{id:'p',status:'pending',messageId:'one',accountId:'a',labelName:'Work'}]);");
  const button = ui.nodes.get("agent-proposals").querySelectorAll("button").find((node) => node.textContent === "Review filing…");
  button.click();
  await tick();
  assert.match(ui.nodes.get("brain-skill-status").textContent, /Waiting for mailbox confirmation/);
  assert.doesNotMatch(ui.nodes.get("brain-skill-status").textContent, /Move confirmed/);
  assert.match(ui.nodes.get("agent-proposals").textContent, /Waiting for mailbox confirmation/);
});

test("Agent F3: Learned suppression applies to conversation triage, mail cards and reopened history", () => {
  const ui = uiFixture();
  ui.run(`globalThis.item={messageId:'one',from:'sender@example.test',subject:'Nested',followUps:[{kind:'draft',label:'Review reply',messageId:'one'}]};
    globalThis.turn={role:'agent',kind:'triage',text:'Triage',triage:{sections:[{name:'Needs You',items:[item]}]}};
    agentTurns=[turn]; paintThread();`);
  assert.match(ui.nodes.get("agent-sections").textContent, /Review reply/);
  ui.run("applyAgentLearning({patterns:[],suppressed:['Review reply']})");
  assert.doesNotMatch(ui.nodes.get("agent-sections").textContent, /Review reply/);
  ui.run("agentTurns=[{role:'agent',kind:'list',text:'Mail',reply:{kind:'list',cards:[item]}}]; paintThread();");
  assert.doesNotMatch(ui.nodes.get("agent-sections").textContent, /Review reply/);
  ui.run("applyAgentLearning({patterns:[],suppressed:[]});");
  assert.match(ui.nodes.get("agent-sections").textContent, /Review reply/);
  ui.run("applyAgentLearning({patterns:[],suppressed:['Review reply']});");
  ui.run("agentTurns=[turn]; paintThread(); applyAgentLearning({patterns:[],suppressed:[]});");
  assert.match(ui.nodes.get("agent-sections").textContent, /Review reply/);
});

test("Agent F4: blurred notes, page reopen and save acknowledgments preserve newer edits", async () => {
  const save = deferred();
  const ui = uiFixture(async (channel) => channel === "nativeAgent:memorySet" ? save.promise : ok(channel === "nativeAgent:chatHistory" ? { memory: { notes: "Saved note" }, turns: [] } : {}));
  ui.run("state.view='agent'; paintAgent=()=>{}; loadStudio=async()=>{}; syncAgentPageBusy=()=>{}; agentLoaded=true; applyAgentMemory('Saved note'); $('agent-memory').value='Blurred dirty note';");
  await ui.run("loadAgent({overlay:false})");
  assert.equal(ui.nodes.get("agent-memory").value, "Blurred dirty note");
  ui.run("state.view='mail'; state.view='agent';");
  await ui.run("loadAgent({overlay:false})");
  assert.equal(ui.nodes.get("agent-memory").value, "Blurred dirty note");
  const pending = ui.run("saveAgentMemory()");
  await tick();
  ui.nodes.get("agent-memory").value = "Newer while saving";
  save.resolve(ok({ notes: "Blurred dirty note" }));
  await pending;
  assert.equal(ui.nodes.get("agent-memory").value, "Newer while saving");
  assert.equal(ui.run("updateMemoryBaseline"), "Blurred dirty note");
  assert.match(ui.nodes.get("agent-memory-status").textContent, /Newer edits/);
});

test("Agent F5: rendered Run and Home chips preserve duplicate or command-like skill IDs", async () => {
  const calls = [];
  const ui = uiFixture(async (channel, payload) => { calls.push({ channel, payload }); return ok({}); });
  ui.run("state.view='agent'; brainIsOpen=()=>false; showAgentTab=()=>{}; setAgentBusy=value=>{agentChatBusy=value;}; applyChatPayload=()=>{}; paintHistory=()=>{}; globalThis.skills=[{id:'user:duplicate',name:'Morning Brief',custom:true},{id:'user:command',name:'Triage',custom:true}]; paintSkillList($('studio-home'),skills,'Empty','run'); paintSkillChips(skills);");
  ui.nodes.get("studio-home").querySelectorAll("button").find((button) => button.textContent === "Run").click();
  await tick();
  ui.nodes.get("agent-skill-chips").querySelectorAll("button").find((button) => button.textContent === "Triage").click();
  await tick();
  assert.deepEqual(calls.filter((row) => row.channel === "nativeAgent:chat").map((row) => row.payload.skillId), ["user:duplicate", "user:command"]);
  const fixture = hostFixture();
  try {
    fixture.run(`listHomeSkills=()=>[{id:'builtin',name:'Morning Brief'},{id:'user:duplicate',name:'Morning Brief'},{id:'user:command',name:'Triage'}]; runSkill=async params=>ok({accepted:true,skillId:params.skillId});`);
    for (const [skillId, text] of [["user:duplicate", "Morning Brief"], ["user:command", "Triage"]]) {
      const result = await fixture.run(`chat(${JSON.stringify({ skillId, text })})`);
      assert.equal(result.data.result.skillId, skillId);
      assert.equal(result.data.intent, "skill");
    }
    assert.equal((await fixture.run("chat({skillId:'gone',text:'Triage'})")).success, false);
  } finally { fixture.close(); }
});

test("Agent F6: Retry download stays in unread peek and ignores superseded results", async () => {
  const calls = [];
  const retry = deferred();
  const ui = uiFixture(async (channel, payload) => { calls.push({ channel, payload }); return retry.promise; });
  ui.run("globalThis.peek={id:'one',accountId:'a',unread:true,subject:'Peek',textBody:'Cached',bodyWarning:'Incomplete'}; peekEmail=peek; state.email={id:'main'}; openDialog=()=>{}; pumpBodyRefreshes=()=>{}; renderAttachments=()=>{}; appendMessageBody=()=>{}; paintPeek(peek);");
  const pending = ui.nodes.get("agent-peek-body").querySelector("button").click();
  await tick();
  assert.deepEqual(calls.map((row) => row.channel), ["mail:openEmail"]);
  assert.equal(calls[0].payload.full, true);
  assert.equal(calls[0].payload.accountId, "a");
  retry.resolve(ok({ email: { id: "one", accountId: "a", unread: true, textBody: "Full" } }));
  await pending;
  assert.equal(ui.run("peekEmail.unread"), true);
  assert.equal(ui.run("state.email.id"), "main");
  assert.equal(calls.some((row) => /markRead|todoUpdate/.test(row.channel)), false);
  const late = deferred();
  ui.context.window.morrow.invoke = () => late.promise;
  const obsolete = ui.run("peekMessage('one',true)");
  ui.run("invalidatePeek()");
  late.resolve(ok({ email: { id: "one", accountId: "a", unread: true, textBody: "Obsolete" } }));
  await obsolete;
  assert.equal(ui.run("peekEmail"), null);
  ui.run("peekEmail={id:'one'}; closeDialog=async()=>{}; showMail=()=>{globalThis.handedOff=true;}; openMessage=async id=>{globalThis.mailOpened=id;};");
  await ui.run("openPeekInMail()");
  assert.equal(ui.run("handedOff"), true);
  assert.equal(ui.run("mailOpened"), "one");
});

for (const field of ["Minutes between runs", "Cron schedule", "Contact email for this schedule"]) test("Agent F9: polling retains focused and blurred dirty " + field, async () => {
  const ui = uiFixture(async () => ok({ skills: [{ id: "brief-this-person", name: "Person", schedule: "interval", everyMinutes: 30, person: true }] }));
  ui.run("globalThis.skills=[{id:'brief-this-person',name:'Person',schedule:'interval',everyMinutes:30,person:true}]; paintSkillList($('studio-home'),skills,'Empty','run');");
  const editor = ui.nodes.get("studio-home").querySelector(".skill-schedule");
  const input = editor.querySelectorAll("input").find((node) => node.getAttribute("aria-label") === field);
  input.value = field === "Minutes between runs" ? "75" : field === "Cron schedule" ? "0 9 * * 1-5" : "new@example.test";
  input.focus();
  await ui.run("loadStudio()");
  assert.equal(input.isConnected, true);
  assert.equal(ui.context.document.activeElement, input);
  ui.context.document.activeElement = null;
  await ui.run("loadStudio()");
  assert.equal(ui.nodes.get("studio-home").querySelector(".skill-schedule"), editor);
  assert.equal(input.value, field === "Minutes between runs" ? "75" : field === "Cron schedule" ? "0 9 * * 1-5" : "new@example.test");
});

test("Agent F9: schedule-event reads recheck editor ownership after their await", async () => {
  const home = deferred();
  const ui = uiFixture(async (channel) => channel === "nativeAgent:home:skills" ? home.promise : ok([]));
  ui.run("globalThis.skills=[{id:'morning-brief',name:'Morning Brief',schedule:'interval',everyMinutes:30}]; paintSkillList($('studio-home'),skills,'Empty','run'); onScheduleFired({name:'Morning Brief',accepted:true});");
  await tick();
  const input = ui.nodes.get("studio-home").querySelectorAll("input").find((node) => node.getAttribute("aria-label") === "Minutes between runs");
  input.value = "75";
  home.resolve(ok({ skills: [{ id: "morning-brief", name: "Morning Brief", schedule: "interval", everyMinutes: 30 }] }));
  await tick(); await tick();
  assert.equal(input.isConnected, true);
  assert.equal(input.value, "75");
});

test("Settings F1: actual Bot handlers retain disable, enable-then-disable and revoke while probing", async () => {
  const probe = deferred(), enable = deferred();
  const calls = [];
  let enabled = true;
  const ui = uiFixture(async (channel, payload) => {
    calls.push({ channel, payload });
    if (channel === "bot:probeServe") return probe.promise;
    if (channel === "bot:setEnabled") { if (payload.enabled) await enable.promise; enabled = payload.enabled; return ok({ enabled, grants: [], listen: {} }); }
    if (channel === "bot:revokeGrant") return ok({ enabled, grants: [{ clientId: payload.clientId, revokedAt: "now" }], listen: {} });
    return ok({});
  });
  ui.run("wireBotSections=()=>{}; paintBotProbe=()=>{}; paintBotAccess=access=>{state.botAccess=access;$('bot-enabled').checked=access.enabled;}; state.botAccess={enabled:true,serveHost:'bot.example.test'}; wireBot();");
  const checking = ui.nodes.get("bot-probe").click();
  await tick();
  ui.nodes.get("bot-enabled").checked = false;
  ui.nodes.get("bot-enabled").dispatch("change");
  await tick();
  assert.equal(enabled, false);
  assert.equal(ui.run("state.botAccess.enabled"), false);
  ui.run("paintBotGrants([{clientId:'grant',label:'Bot',accountIds:['a'],capabilities:[]}]);");
  ui.nodes.get("bot-grants").querySelectorAll("button").find((button) => button.textContent === "Revoke").click();
  await tick();
  assert.equal(calls.some((row) => row.channel === "bot:revokeGrant"), true);
  ui.nodes.get("bot-enabled").checked = true;
  ui.nodes.get("bot-enabled").dispatch("change");
  await tick();
  ui.nodes.get("bot-enabled").checked = false;
  ui.nodes.get("bot-enabled").dispatch("change");
  enable.resolve();
  await tick(); await tick();
  assert.equal(enabled, false);
  probe.resolve(ok({ state: "morrow" }));
  await checking;
  assert.equal(ui.run("botBusy"), false);
  assert.equal(ui.nodes.get("bot-enabled").checked, false);
  assert.deepEqual(calls.filter((row) => row.channel === "bot:setEnabled").map((row) => row.payload.enabled), [false, true, false]);
});

test("Settings F1: an older access-status read cannot repaint an acknowledged disable", async () => {
  const read = deferred();
  const ui = uiFixture(() => read.promise);
  ui.run("paintBotProbe=()=>{}; paintBotAccess({enabled:true,grants:[{clientId:'live',label:'Bot',live:true,accountIds:[],capabilities:[]}],accounts:[]});");
  const pending = ui.run("loadBotAccess()");
  ui.run("paintBotAccess({enabled:false,grants:[{clientId:'live',label:'Bot',live:true,accountIds:[],capabilities:[]}],accounts:[]})");
  read.resolve(ok({ enabled: true, grants: [], accounts: [] }));
  await pending;
  assert.equal(ui.run("state.botAccess.enabled"), false);
  assert.equal(ui.nodes.get("bot-enabled").checked, false);
  assert.match(ui.nodes.get("bot-intent").textContent, /off/);
});

function vacationUi(invoke) {
  const ui = uiFixture(invoke);
  ui.nodes.get("ooo-domain").type = "checkbox";
  ui.run("$('settings').open=true; globalThis.savedVacation={accountId:'a',provider:'google',supported:true,canWrite:true,revision:'one',settings:{mode:'always',subject:'Away',message:'Saved reply',audience:'all'}}; paintVacation(savedVacation); oooBaseline=oooSnapshot(); askConfirm=async()=>({ok:true});");
  return ui;
}

test("Settings F2: delayed Out of Office writes and refreshes retain edits and update the saved revision", async () => {
  const write = deferred(), read = deferred();
  const ui = vacationUi(async (channel) => channel === "mail:vacationPut" ? write.promise : read.promise);
  ui.nodes.get("ooo-message").value = "Reviewed reply";
  const pending = ui.run("saveVacation('save')");
  await tick();
  ui.nodes.get("ooo-message").value = "Newer edit";
  ui.nodes.get("settings").open = false;
  ui.nodes.get("settings").open = true;
  write.resolve(ok({ ...ui.json("savedVacation"), revision: "two", settings: { mode: "always", message: "Reviewed reply", audience: "all" } }));
  await pending;
  assert.equal(ui.nodes.get("ooo-message").value, "Newer edit");
  assert.equal(ui.run("oooDirty()"), true);
  assert.equal(ui.run("vacationCache.revision"), "two");
  const refresh = ui.run("refreshVacation()");
  await tick();
  ui.nodes.get("ooo-message").value = "Typed during refresh";
  read.resolve(ok(ui.json("savedVacation")));
  await refresh;
  assert.equal(ui.nodes.get("ooo-message").value, "Typed during refresh");
  assert.equal(ui.run("oooDirty()"), true);
});

test("Settings F3: the real fold loader owns A to B to A vacation reads", async () => {
  const reads = [];
  const ui = uiFixture(async (channel, payload) => { const read = deferred(); reads.push({ channel, payload, ...read }); return read.promise; });
  const fold = ui.nodes.get("settings-ooo"), panel = ui.nodes.get("settings-ooo-panel");
  fold.className = "fold is-open"; fold.dataset.fold = "ooo"; panel.className = "fold-panel"; fold.appendChild(panel);
  const query = ui.context.document.querySelector;
  ui.context.document.querySelector = (selector) => /#settings \.fold/.test(selector) ? fold : query(selector);
  ui.run("$('settings').open=true; paintSettingsMailbox=()=>{}; state.accounts.push({id:'b',email:'b@example.test',platform:'imap'});");
  const first = ui.run("loadSettingsFold('ooo')"); await tick();
  const second = ui.run("changeSettingsMailbox('b')"); await tick();
  const third = ui.run("changeSettingsMailbox('a')"); await tick();
  assert.deepEqual(reads.map((read) => read.payload.accountId), ["a", "b", "a"]);
  const value = (accountId, message) => ok({ accountId, provider: "google", supported: true, canWrite: true, revision: message, settings: { mode: "disabled", message } });
  reads[2].resolve(value("a", "Current A")); await third;
  reads[0].resolve(value("a", "Obsolete A")); reads[1].resolve(value("b", "Obsolete B"));
  await Promise.all([first, second]);
  assert.equal(ui.run("vacationCache.revision"), "Current A");
  assert.equal(ui.run("settingsFoldLoaded.has('ooo:a')"), true);
  assert.equal(ui.nodes.get("ooo-fields").hidden, false);
});

for (const failure of [false, true]) test("Settings F4: schedule autosave preserves newer minutes after " + (failure ? "failure" : "success"), async () => {
  const read = deferred();
  const ui = uiFixture(async (channel) => channel.includes("GetDefaultSchedule") ? read.promise : true);
  ui.nodes.get("pref-schedule-hours").value = "1"; ui.nodes.get("pref-schedule-minutes").value = "0";
  const pending = ui.run("saveScheduleDelay()"); await tick();
  ui.nodes.get("pref-schedule-minutes").value = "30";
  if (failure) read.reject(new Error("Unavailable")); else read.resolve(60);
  await pending;
  assert.equal(ui.nodes.get("pref-schedule-minutes").value, "30");
  if (!failure) assert.match(ui.nodes.get("pref-schedule-status").textContent, /Newer edits/);
});

test("Settings F4: overlapping schedule changes serialize the submitted hour/minute snapshots", async () => {
  const firstRead = deferred(), writes = [];
  let reads = 0, saved = 0;
  const ui = uiFixture(async (channel, value) => {
    if (channel.includes("SetDefaultSchedule")) { writes.push(value); saved = value; return true; }
    if (channel.includes("GetDefaultSchedule")) return ++reads === 1 ? firstRead.promise : saved;
    return {};
  });
  ui.nodes.get("pref-schedule-hours").value = "1"; ui.nodes.get("pref-schedule-minutes").value = "0";
  const first = ui.run("saveScheduleDelay()"); await tick();
  ui.nodes.get("pref-schedule-minutes").value = "30";
  const second = ui.run("saveScheduleDelay()");
  assert.deepEqual(writes, [60]);
  firstRead.resolve(60);
  await Promise.all([first, second]);
  assert.deepEqual(writes, [60, 90]);
  assert.equal(ui.nodes.get("pref-schedule-minutes").value, "30");
  assert.equal(ui.run("state.prefs.scheduleDelay"), 90);
});

test("Settings F4: ordinary preference readback does not replace a newer unsaved input", async () => {
  const read = deferred();
  const ui = uiFixture(async (channel) => channel === "morrow:configGetSyncHorizonDays" ? read.promise : true);
  ui.nodes.get("pref-sync-horizon").value = "7";
  const pending = ui.run("savePref(['pref-sync-horizon','morrow:configGetSyncHorizonDays','morrow:configSetSyncHorizonDays','days'])");
  await tick();
  ui.nodes.get("pref-sync-horizon").value = "30";
  read.resolve(7);
  await pending;
  assert.equal(ui.nodes.get("pref-sync-horizon").value, "30");
  assert.equal(ui.run("state.prefs.syncHorizon"), 7);
});

test("Settings F5: General reads only local learning and the rendered navigation fixture uses the real write channel", async () => {
  const calls = [];
  const ui = uiFixture(async (channel) => { calls.push(channel); return ok({ patterns: [], suppressed: [] }); });
  ui.run("$('settings').open=true;$('settings-prefs').hidden=false");
  await ui.run("loadSettings()");
  assert.deepEqual(calls, ["nativeAgent:learning:list"]);
  const fixture = fs.readFileSync(path.join(__dirname, "check-page-navigation.cjs"), "utf8");
  assert.doesNotMatch(fixture, /count\('mail:vacationSet'\)/);
  assert.match(fixture, /\['nativeAgent:learning:list'\]/);
});

test("cheap P3: Compose mailbox, provider consent, image defaults and AI Setup status match their owners", async () => {
  assert.ok(html.indexOf('id="brain-compose-account"') < html.indexOf('id="brain-compose-advanced"'));
  assert.equal([...html.matchAll(/id="brain-compose-account"/g)].length, 1);
  assert.match(html, /This is on for new profiles\. Turn it off to block remote images/);
  assert.match(fs.readFileSync(path.join(__dirname, "../host/settings.js"), "utf8"), /remoteImages: true/);
  const setup = fs.readFileSync(path.join(__dirname, "../host/ai-setup.html"), "utf8");
  assert.match(setup, /id="status" role="status" aria-live="polite"/);
  const ui = uiFixture();
  assert.match(ui.run("vacationConfirm('grant','me@example.test',{provider:'google'}).body"), /Calendar permission is separate/);
  assert.doesNotMatch(ui.run("vacationConfirm('grant','me@example.test',{provider:'google'}).body"), /calendar, organize/);
  assert.match(ui.run("vacationConfirm('grant','me@example.test',{provider:'microsoft'}).body"), /Microsoft Graph calendar/);
  const oauth = require("../host/mail/oauth-config");
  assert.doesNotMatch(oauth.scopesFor("google", "bundle"), /calendar/);
  assert.match(oauth.scopesFor("google", "bundle"), /gmail\.settings\.basic/);
  assert.match(oauth.scopesFor("microsoft", "bundle"), /Calendars\.ReadWrite.*MailboxSettings\.ReadWrite/);
  for (const [config, connection, ready] of [[{ authMode: "api_key", hasKey: true }, {}, true], [{ authMode: "api_key", hasKey: false }, {}, false], [{ authMode: "chatgpt", hasKey: false }, { connected: true, planEnabled: true }, true], [{ authMode: "chatgpt", hasKey: true }, { connected: false }, false]]) {
    ui.context.window.morrow.invoke = async (channel) => channel === "host:aiGetConfig" ? config : connection;
    await ui.run("refreshAiSetupState()");
    assert.equal(ui.nodes.get("agent-setup").hidden, ready);
    assert.equal(ui.nodes.get("agent-setup-ai").hidden, ready);
  }
  ui.run("state.accounts=[]");
  ui.context.window.morrow.invoke = async (channel) => channel === "host:aiGetConfig" ? { authMode: "chatgpt", hasKey: false } : { connected: true, planEnabled: true };
  await ui.run("refreshAiSetupState()");
  assert.equal(ui.nodes.get("agent-setup").hidden, false);
  assert.equal(ui.nodes.get("agent-setup-connect").hidden, false);
  assert.equal(ui.nodes.get("agent-setup-ai").hidden, true);
});

test("Features: actual catalog render and tab switching keep recovery, privacy and CLI claims aligned", () => {
  const ui = uiFixture();
  const catalog = require("../renderer/features-catalog");
  ui.context.window.morrowFeaturesCatalog = catalog;
  ui.run("paintFeatureCatalog()");
  const rendered = ui.nodes.get("features-catalog").textContent;
  for (const claim of [/uncertain.*Scheduled delivery review/i, /accumulate completed changes across batches/, /retired session cannot revive/, /terminal refusals/, /ai\.json.*not OS encryption/, /Disable and Revoke/, /selected skill ID/, /newer typing/]) assert.match(rendered, claim);
  assert.match(rendered, /Undo reopens Compose.*Agent todo.*confirmed send/);
  assert.match(rendered, /Outlook description edits.*surrounding whitespace.*provider revision/);
  for (const claim of [/On Windows and macOS/, /guarded per-request grant snapshots/, /Durable acknowledgement, journal recovery and fsync are unchanged/, /only for changed headers/, /Next loads more/, /source-limited message is not downloaded automatically again/, /Skills load on the Tools tab/, /in-flight reads are allowed to settle/]) assert.match(rendered, claim);
  assert.doesNotMatch(rendered, /Credentials stay encrypted on this computer/);
  const nav = ui.nodes.get("features-tabs");
  for (const name of ["catalog", "shortcuts", "cli"]) {
    const tab = ui.nodes.get("features-tab-" + name);
    tab.dataset.featuresTab = name; tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", "features-pane-" + name); nav.appendChild(tab);
  }
  ui.run("showFeaturesTab('cli')");
  assert.equal(ui.nodes.get("features-pane-cli").hidden, false);
  assert.equal(ui.nodes.get("features-pane-catalog").hidden, true);
  assert.match(html, /Disable and Revoke remain actionable during connection checks/);
  assert.match(html, /Desktop autocomplete is asynchronous; Scheduled summaries omit bodies and page at 200/);
  assert.match(html, /not new CLI commands or bot permissions/);
  assert.match(html, /Windows frame times or real secure storage/);
  ui.run("showFeaturesTab('catalog')");
  assert.equal(ui.nodes.get("features-pane-catalog").hidden, false);
  const boot = fs.readFileSync(path.join(__dirname, "check-boot-path.js"), "utf8");
  const start = boot.indexOf("const featureSeed = [");
  const seed = vm.runInNewContext(boot.slice(start, boot.indexOf("\n];", start) + 3) + "\nfeatureSeed");
  assert.deepEqual(JSON.parse(JSON.stringify(seed)), catalog.items.map((row) => [row.id, row.title, row.category, row.blurb]));
});
