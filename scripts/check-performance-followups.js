const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { renderer } = require("./check-ux-workflows");

const root = path.join(__dirname, "..");
const flush = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function load(relative, stubs) {
  const filename = path.join(root, relative);
  const local = Module.createRequire(filename);
  const request = name => Object.hasOwn(stubs, name) ? stubs[name] : local(name);
  request.resolve = local.resolve;
  const context = vm.createContext({ require: request, module: { exports: {} }, console, process, Buffer,
    setTimeout, clearTimeout, setImmediate, AbortController, URL });
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
  return context.module.exports;
}
function productionFunction(source, name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}

class Element {
  constructor(tag, document) {
    this.tagName = tag;
    this.ownerDocument = document;
    this.childNodes = [];
    this.dataset = {};
    this.attributes = {};
    this.style = { setProperty() {} };
    this.value = "";
    this.text = "";
    this.scrollTop = 0;
    this.classes = new Set();
    this.classList = { add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)), contains: name => this.classes.has(name),
      toggle: (name, on = !this.classes.has(name)) => { if (on) this.classes.add(name); else this.classes.delete(name); return on; } };
  }
  get children() { return this.childNodes; }
  get options() { return this.children; }
  get className() { return [...this.classes].join(" "); }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  get isConnected() { return this.tagName === "body" || !!this.parentNode?.isConnected; }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, before) {
    node.remove(); node.parentNode = this;
    const index = before ? this.children.indexOf(before) : -1;
    if (index < 0) this.childNodes.push(node); else this.childNodes.splice(index, 0, node);
    return node;
  }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  replaceChildren(...nodes) { this.children.forEach(node => { node.parentNode = null; }); this.childNodes = []; this.text = ""; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, listener) { (this.listeners ||= new Map()).set(name, listener); }
  focus() { this.ownerDocument.activeElement = this; }
  querySelectorAll(selector) {
    const rows = this.children.flatMap(child => [child, ...child.querySelectorAll("*")]);
    return rows.filter(node => selector === "*" || selector.startsWith(".") && node.classes.has(selector.slice(1))
      || selector === '[role="tab"]' && node.getAttribute("role") === "tab"
      || selector === 'input[type="checkbox"]' && node.tagName === "input" && node.type === "checkbox");
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function uiFixture(extra = {}) {
  const nodes = new Map();
  const document = { createElement: tag => new Element(tag, document), createElementNS: (_namespace, tag) => new Element(tag, document) };
  document.body = new Element("body", document);
  document.getElementById = id => {
    if (!nodes.has(id)) { const node = document.createElement("div"); node.id = id; nodes.set(id, node); document.body.appendChild(node); }
    return nodes.get(id);
  };
  document.querySelector = selector => selector === ".shell" ? document.getElementById("shell") : document.body.querySelector(selector);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  const ui = renderer({ document, queueMicrotask, ...extra });
  ui.run(`state.accounts = [{id:'a',email:'a@example.test',platform:'imap',folders:{primary:[{id:'Inbox',name:'Inbox',wellKnownName:'inbox'}],more:[]}}];
    state.accountId='a'; state.folderId='Inbox'; state.view='mail';`);
  return { ...ui, document, nodes, json: expression => JSON.parse(ui.run(`JSON.stringify(${expression})`)) };
}

test("Windows DPAPI reads use bounded cancellable async children, not spawnSync", async () => {
  const children = [], calls = [];
  const launch = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = children.length + 1;
    child.stdout = new EventEmitter(); child.stdout.destroy = () => {};
    child.kill = signal => { child.killed = signal; }; child.unref = () => {};
    children.push(child); return child;
  };
  const reader = require("../host/mail/keychain-reader");
  const windows = load("host/mail/win-secrets.js", {
    child_process: { spawnSync() { throw new Error("A routine read invoked synchronous PowerShell"); } },
    "./keychain-reader": { ...reader, createReader: options => reader.createReader({ ...options, launch, timeoutMs: 25 }) },
  });
  const pending = windows.getPasswordAsync("synthetic'account");
  await flush();
  assert.equal(calls[0].command, "powershell.exe");
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.shell, undefined);
  assert.match(calls[0].args.at(-1), /ToBase64String/);
  const value = "  synthetic-秘密-😀\n";
  children[0].stdout.emit("data", Buffer.from(value).toString("base64")); children[0].emit("close", 0);
  assert.equal(await pending, value);
  const missing = windows.getPasswordAsync("absent"); children[1].emit("close", 2); assert.equal(await missing, null);
  const timed = windows.getPasswordAsync("blocked");
  await assert.rejects(timed, { code: "secure_storage_timeout" });
  assert.equal(children[2].killed, "SIGKILL"); children[2].emit("close", null);
  const controller = new AbortController();
  const cancelled = windows.getPasswordAsync("cancelled", { signal: controller.signal });
  controller.abort(); await assert.rejects(cancelled, { code: "ABORT_ERR" }); children[3].emit("close", null);
});

function grantsFixture() {
  const accounts = ["google", "microsoft", "custom"].map((profile, index) => ({ id: String(index), profile,
    created_at: 1, email: `${index}@example.test`, auth_kind: "oauth2", mail_transport: profile === "google" ? "gmail_api" : "imap" }));
  const values = new Map(), revisions = new Map(), reads = [];
  let client = "original", wait = null, tokenWait = null, tokenResult = "synthetic-access";
  for (const account of accounts) for (const suffix of ["", ":bundle", ":calendar", ":organize", ":rules", ":vacation"]) {
    const key = account.id + suffix;
    values.set(key, JSON.stringify({ refreshToken: "synthetic", accessToken: "synthetic", grantedScopes: "imap organize calendar rules vacation", googleClientId: client }));
    revisions.set(key, Symbol());
  }
  const config = { providerKey: profile => profile, googleOauthStatus: () => ({ ready: true }), loadGoogleClient: () => ({ clientId: client }),
    hasPurposeScopes: (scopes, _provider, purpose) => String(scopes).split(" ").includes(purpose), hasScopes: () => false,
    googleGrantMatches: grant => grant?.googleClientId === client,
    requireGoogleGrantClient(grant) { if (grant?.googleClientId !== client) throw Object.assign(new Error("Client changed"), { code: "google_client_changed" }); } };
  const secrets = { revision: key => revisions.get(key), getPassword() { throw new Error("Synchronous grant read"); },
    async getPasswordAsync(key) { reads.push(key); if (wait) await wait.promise; return values.get(key) || null; },
    setPassword(key, raw) { values.set(key, raw); revisions.set(key, Symbol()); } };
  const sidecar = load("host/mail/sidecar.js", {
    "./db": { listAccountRows: () => accounts, accountById: id => accounts.find(row => row.id === id) }, "./secrets": secrets,
    "./oauth-config": config, "./oauth": { oauthReady: () => ({ google: true, microsoft: true }),
      async accessTokenFor() { if (tokenWait) await tokenWait.promise; return tokenResult; } },
    "./provider-api": { listLabels: async () => [] }, "./calendar-api": {}, "./inbox-rules": {}, "./vacation-api": {}, "./sieve-vacation": {},
  });
  return { sidecar, accounts, secrets, reads, pause: gate => { wait = gate; }, tokenPause: gate => { tokenWait = gate; }, client: value => { client = value; },
    tokenResult: value => { tokenResult = value; }, invalidate: key => revisions.set(key, Symbol()) };
}

test("feature/status gates share a guarded grant snapshot with no completed credential cache", async () => {
  const fixture = grantsFixture();
  const result = await fixture.sidecar.answer("calendar:status", []);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.data.accounts[0].calendar, true);
  assert.equal(result.data.accounts[1].organize, true);
  assert.equal(result.data.accounts[2].calendar, false);
  assert.equal(fixture.reads.length, 13);
  assert.equal(new Set(fixture.reads).size, 13);
  await fixture.sidecar.answer("mail:oauthStatus", []);
  assert.equal(fixture.reads.length, 26);
  const gate = deferred(); fixture.pause(gate);
  const stale = fixture.sidecar.answer("calendar:status", []); await flush();
  fixture.accounts[0] = { ...fixture.accounts[0], created_at: 2 }; gate.resolve();
  assert.equal((await stale).error.code, "conflict");
});

test("feature tokens reject credential revisions and changed Google clients after OAuth waits", async () => {
  for (const change of ["credential", "client"]) {
    const fixture = grantsFixture(), gate = deferred(); fixture.tokenPause(gate);
    const pending = fixture.sidecar.organizeToken(fixture.accounts[0]); await flush();
    if (change === "credential") fixture.secrets.setPassword("0", "replacement"); else fixture.client("replacement");
    gate.resolve(); assert.equal(await pending, null);
  }
});

test("a failed synchronous refresh store preserves the saved grant and still permits the already-authorized access token", async () => {
  const fixture = grantsFixture();
  fixture.tokenResult({ token: "refreshed-access", store: JSON.stringify({ refreshToken: "refreshed", googleClientId: "original", grantedScopes: "imap organize calendar rules vacation" }) });
  fixture.secrets.setPassword = key => { fixture.invalidate(key); throw new Error("Synthetic secure-store failure"); };
  const token = await fixture.sidecar.organizeToken(fixture.accounts[0]);
  assert.equal(token.accessToken, "refreshed-access");
  const status = await fixture.sidecar.answer("calendar:status", []); assert.equal(status.success, true); assert.equal(status.data.accounts[0].organize, true);
});

test("equivalent refreshes join, but a queued mutation separates later reads", async () => {
  const source = fs.readFileSync(path.join(root, "host/mail/engine.js"), "utf8");
  const gate = deferred(), order = [];
  const context = vm.createContext({ Promise, Map, JSON, lanes: new Map(), accountEpochs: new Map(), pumpBodyFills() {},
    removedAccountError: () => new Error("Removed"), assertAccountCurrent() {}, secretFor: async () => "synthetic",
    withSyncSecret: (_account, _secret, work) => work(),
    remote: { async withClient(_account, _secret, work) { order.push("read"); if (order.length === 1) await gate.promise; return work({}); } },
    syncFolderPolicy: async () => ({ bootstrapped: true }), finishSync() {} });
  vm.runInContext(["laneFor", "priorityWaiting", "drainLane", "exclusive", "syncFolderPathAdmitted"].map(name => productionFunction(source, name)).join("\n"), context);
  const account = { id: "a", created_at: 1, auth_kind: "password", mail_transport: "imap" };
  const reads = Array.from({ length: 5 }, () => context.syncFolderPathAdmitted(account, "Inbox"));
  const mutation = context.exclusive("a", () => { order.push("mutation"); });
  const after = context.syncFolderPathAdmitted(account, "Inbox");
  await flush(); assert.deepEqual(order, ["read"]); gate.resolve();
  await Promise.all([...reads, mutation, after]);
  assert.deepEqual(order, ["read", "mutation", "read"]);
});

test("overnight selection advances beyond 200 attempted headers and Limited bodies are ineligible", () => {
  const source = fs.readFileSync(path.join(root, "host/mail/engine.js"), "utf8");
  const rows = Array.from({ length: 201 }, (_unused, index) => ({ id: String(index + 1), uid: index + 1,
    account_id: "a", body_complete: 0, list_sort_ts: 1000 - index }));
  let pages = 0;
  const context = vm.createContext({ Date, Set, Number, JSON, accountEpochs: new Map(), DAY_MS: 86400000, overnightCursor: null,
    overnightTried: new Set(), syncHorizonDays: () => 0,
    gateOpen: () => true, priorityWaiting: () => false, db: { accountById: () => ({}), selectMessages(query, options) {
      pages++; assert.equal(options.headersOnly, true);
      return rows.filter(row => !query.beforeMessage || row.list_sort_ts < query.beforeMessage.ts).slice(0, 200);
    } } });
  vm.runInContext(["rowNeedsBody", "nextOvernightRow", "overnightIdentity"].map(name => productionFunction(source, name)).join("\n"), context);
  for (const row of rows.slice(0, 200)) context.overnightTried.add(context.overnightIdentity(row));
  assert.equal(context.nextOvernightRow(Date.now()).id, "201"); assert.equal(pages, 2);
  assert.notEqual(context.overnightIdentity(rows[0]), context.overnightIdentity({ ...rows[0], uid_validity: 2 }));
  context.overnightTried.add(context.overnightIdentity(rows[200]));
  assert.equal(context.nextOvernightRow(Date.now()), null); assert.equal(context.overnightCursor, null);
  assert.equal(context.rowNeedsBody({ ...rows[0], body_retry_blocked: 1 }), false);
  assert.equal(context.rowNeedsBody({ ...rows[0], body_retry_after: Date.now() + 60000 }), false);
  assert.equal(context.rowNeedsBody(rows[0]), true);
});

test("overnight selection bounds paused-backlog scans and resumes without wrapping in the same poll", async () => {
  const source = fs.readFileSync(path.join(root, "host/mail/engine.js"), "utf8");
  const rows = Array.from({ length: 100000 }, (_unused, index) => ({ id: String(index), uid: index + 1,
    account_id: "paused", body_complete: 0, list_sort_ts: 100000 - index }));
  let pages = 0, visits = 0, paused = true, yielded = false;
  const starts = [];
  const context = vm.createContext({ Date, Set, Number, JSON, accountEpochs: new Map(), DAY_MS: 86400000,
    overnightCursor: null, overnightTried: new Set(), syncHorizonDays: () => 0,
    gateOpen: () => { visits++; return !paused; }, priorityWaiting: () => false,
    db: { accountById: () => ({}), selectMessages(query, options) {
      pages++;
      assert.equal(options.headersOnly, true);
      assert.equal(query.limit, 200);
      const offset = query.beforeMessage ? Number(query.beforeMessage.id) + 1 : 0;
      starts.push(offset);
      return rows.slice(offset, offset + query.limit);
    } } });
  vm.runInContext(["rowNeedsBody", "nextOvernightRow", "overnightIdentity"].map(name => productionFunction(source, name)).join("\n"), context);
  const turn = new Promise(resolve => setImmediate(() => { yielded = true; resolve(); }));
  assert.equal(context.nextOvernightRow(Date.now()), null);
  assert.equal(pages, 2);
  assert.equal(visits, 400);
  assert.equal(context.overnightCursor.id, "399");
  await turn;
  assert.equal(yielded, true);
  assert.equal(context.nextOvernightRow(Date.now()), null);
  assert.equal(pages, 4);
  assert.equal(visits, 800);
  assert.deepEqual(starts, [0,200,400,600]);
  paused = false;
  assert.equal(context.nextOvernightRow(Date.now()).id, "800", "eligible rows beyond the first budget remain reachable");
  paused = true;
  context.overnightCursor = { ts: rows[99899].list_sort_ts, id: "99899" };
  pages = 0;
  visits = 0;
  assert.equal(context.nextOvernightRow(Date.now()), null);
  assert.equal(pages, 1, "exhaustion must not restart the backlog within this call");
  assert.equal(visits, 100);
  assert.equal(context.overnightCursor, null);
  paused = false;
  assert.equal(context.nextOvernightRow(Date.now()).id, "0", "the next poll can see newer candidates after exhaustion");
});

test("overnight bounded scan crosses daily windows to reach mail behind a disconnected backlog", async () => {
  const source = fs.readFileSync(path.join(root, "host/mail/engine.js"), "utf8");
  const rows = Array.from({ length: 1201 }, (_unused, index) => ({ id: String(index), uid: index + 1,
    account_id: index < 1200 ? "disconnected" : "healthy", body_complete: 0, list_sort_ts: 2000 - index }));
  let at = Date.UTC(2026, 5, 15, 3, 30), disconnected = true, pages = 0, visited = 0;
  const fetched = [];
  const context = vm.createContext({ Date, Set, Number, JSON, accountEpochs: new Map(), DAY_MS: 86400000,
    overnight: require("../host/mail/overnight"), overnightNow: () => at, overnightZone: () => "UTC",
    overnightCursor: null, overnightTried: new Set(), overnightSawWindow: false, overnightRunning: false,
    fillRunning: false, fillQueue: [], syncHorizonDays: () => 0, gateOpen: () => true, priorityWaiting: () => false,
    fillBodyInBackground: async row => { fetched.push(row.id); row.body_complete = 1; },
    db: { accountById: id => ({ auth_error: id === "disconnected" && disconnected ? "Reconnect required" : null }),
      messageById: id => rows.find(row => row.id === id), selectMessages(query, options) {
        pages += 1;
        assert.equal(options.headersOnly, true);
        assert.equal(query.needsBody, true);
        assert.equal(query.limit, 200);
        const selected = rows.filter(row => row.body_complete !== 1 && (!query.beforeMessage || row.list_sort_ts < query.beforeMessage.ts)).slice(0, query.limit);
        visited += selected.length;
        return selected;
      } } });
  vm.runInContext(["rowNeedsBody", "nextOvernightRow", "overnightIdentity", "fillOvernightBodies"]
    .map(name => productionFunction(source, name)).join("\n"), context);
  for (let night = 0; night < 3; night += 1) {
    at = Date.UTC(2026, 5, 15 + night, 3, 30);
    pages = 0;
    visited = 0;
    const result = await context.fillOvernightBodies();
    assert.equal(result.fetched, 0);
    assert.equal(result.window, true);
    assert.equal(pages, 2);
    assert.equal(visited, 400, "disconnected headers count toward the per-poll scan bound");
    const cursor = context.overnightCursor;
    assert.equal(cursor.id, String((night + 1) * 400 - 1));
    context.overnightTried.add("previous-night-attempt");
    at = Date.UTC(2026, 5, 15 + night, 15);
    const daytime = await context.fillOvernightBodies();
    assert.equal(daytime.window, false);
    assert.equal(daytime.ran, false);
    assert.equal(context.overnightCursor, cursor, "closing the nightly window must preserve an unfinished scan");
    assert.equal(context.overnightTried.size, 0, "attempt tracking still resets between nightly windows");
    assert.equal(pages, 2, "daytime polls do not scan or fetch bodies");
    assert.deepEqual(fetched, []);
  }
  at = Date.UTC(2026, 5, 18, 3, 30);
  pages = 0;
  const older = await context.fillOvernightBodies();
  assert.equal(older.fetched, 1);
  assert.equal(pages, 1);
  assert.deepEqual(fetched, ["1200"], "the healthy older message remains reachable across windows");
  const exhausted = await context.fillOvernightBodies();
  assert.equal(exhausted.fetched, 0);
  assert.equal(context.overnightCursor, null);
  assert.deepEqual(fetched, ["1200"], "exhaustion does not wrap within the same poll");
  disconnected = false;
  const recovered = await context.fillOvernightBodies();
  assert.equal(recovered.fetched, 1);
  assert.deepEqual(fetched, ["1200", "0"], "a later scan revisits newer mail after the account recovers");
});

test("hidden mail notifications avoid reads, scope routing skips unrelated mail, bursts coalesce", async () => {
  const timers = [];
  const ui = uiFixture({ setTimeout: work => { timers.push(work); return timers.length; }, clearTimeout() {} });
  ui.run(`globalThis.reads={list:0,provider:0,snooze:0,reader:0,ipc:0};
    renderAccounts=()=>{}; paintBodySyncStatus=()=>{}; syncRemove=()=>{};
    loadList=async()=>{reads.list++}; loadProviderFolders=()=>{reads.provider++}; loadSnoozed=async()=>{reads.snooze++}; renderReader=()=>{reads.reader++};
    call=async()=>{reads.ipc++;throw new Error('Unnecessary IPC')};
    calendarAccount=()=>({id:'a'}); calendarPaintedAccountId='a'; state.view='calendar';`);
  await ui.run("loadAccounts('a',state.accounts)");
  ui.run("onEmailsUpdated({accountId:'a',folderId:'Inbox'})");
  assert.deepEqual(ui.json("reads"), { list: 0, provider: 0, snooze: 0, reader: 0, ipc: 0 });
  ui.run("state.view='mail';mailListDirty=false;onEmailsUpdated({accountId:'other',folderId:'Inbox'});onEmailsUpdated({accountId:'a',folderId:'Archive'})");
  assert.equal(timers.length, 0);
  ui.run("for(let index=0;index<10;index++)onEmailsUpdated({accountId:'a',folderId:'Inbox'})");
  assert.equal(timers.length, 1); await timers.shift()();
  assert.equal(ui.json("reads.list"), 1);
  assert.equal(ui.json("reads.provider"), 0);
});

test("Scheduled reads share pending work and do not reconstruct a hidden dialog", async () => {
  const gate = deferred(), ui = uiFixture({ pendingOverview: gate.promise });
  ui.document.getElementById("scheduled-dialog").open = false;
  ui.run(`globalThis.calls=0;globalThis.paints=0;call=async()=>{calls++;return pendingOverview};
    renderScheduled=()=>{paints++};state.outbox=false;`);
  const first = ui.run("loadScheduled()"), second = ui.run("loadScheduled()");
  assert.equal(ui.run("calls"), 1);
  gate.resolve({ rows: [], total: 4, outboxTotal: 2, reviewCount: 1 });
  await Promise.all([first, second]);
  assert.equal(ui.run("paints"), 0); assert.equal(ui.run("state.outboxCount"), 2);
});

test("account snapshots do not swallow same-burst mail invalidations and account-wide changes refresh snooze state", async () => {
  const timers = [], ui = uiFixture({ setTimeout: work => { timers.push(work); return timers.length; }, clearTimeout() {} });
  ui.run(`globalThis.reads={list:0,provider:0,snooze:0,reader:0};state.view='calendar';calendarAccount=()=>({id:'a'});calendarPaintedAccountId='a';
    renderAccounts=()=>{};paintBodySyncStatus=()=>{};syncRemove=()=>{};
    loadList=async()=>{reads.list++};loadProviderFolders=()=>{reads.provider++};loadSnoozed=async()=>{reads.snooze++};renderReader=()=>{reads.reader++};`);
  await ui.run("loadAccounts('a',state.accounts)");
  ui.run("state.view='mail';onAccountsUpdated({accounts:state.accounts});onEmailsUpdated({accountId:'a',folderId:'Inbox'})");
  assert.equal(timers.length, 1); await timers.shift()();
  assert.deepEqual(ui.json("reads"), { list: 1, provider: 0, snooze: 0, reader: 0 });
  ui.run("onEmailsUpdated({accountId:'a'})"); await timers.shift()();
  assert.deepEqual(ui.json("reads"), { list: 2, provider: 0, snooze: 1, reader: 1 });
});

test("retained lists, Agent cards and appended transcript turns keep unchanged nodes", () => {
  const ui = uiFixture();
  ui.run(`globalThis.cards=0;globalThis.turns=0;agentTodoView='list';
    agentSections=payload=>payload.sections;agentPileRole=()=>'';agentLooksUnread=()=>false;
    agentTodoCard=item=>{cards++;const node=document.createElement('article');node.textContent=item.subject;return node};
    paintTurn=turn=>{turns++;const node=document.createElement('article');node.textContent=turn.text;return node};
    paintReplySelectionLabels=()=>{};paintMotionRows=()=>{};
    globalThis.home={sections:[{id:'one',name:'One',items:Array.from({length:12},(_,index)=>({id:String(index),subject:'Subject '+index}))}]};
    paintAgentHome(home);globalThis.retained=agentHomeCards.get('one\\u0000\\u00000').node;paintAgentHome(JSON.parse(JSON.stringify(home)));`);
  assert.equal(ui.run("cards"), 12);
  ui.run("home.sections[0].items[1].subject='Changed';paintAgentHome(home)");
  assert.equal(ui.run("cards"), 13);
  assert.equal(ui.run("agentHomeCards.get('one\\u0000\\u00000').node===retained"), true);
  ui.run("agentTurns=Array.from({length:40},(_,index)=>({id:String(index),role:'agent',text:'Turn '+index}));paintThread();agentTurns.push({id:'40',role:'agent',text:'New'});paintThread()");
  assert.equal(ui.run("turns"), 41);
});

test("Calendar bucketing preserves overlapping local dates and excludes all-day end dates", () => {
  const ui = uiFixture();
  ui.run(`globalThis.events=[{id:'all',allDay:true,start:'2026-10-29',end:'2026-11-01'},
    {id:'timed',start:'2026-10-30T23:00:00',end:'2026-10-31T01:00:00'}];
    globalThis.buckets=calendarBuckets(events,2026,9);`);
  for (const day of [29, 30, 31]) assert.equal(ui.run(`buckets.get('2026-10-${day}').some(event=>event.id==='all')`), true);
  assert.equal(ui.run("buckets.has('2026-11-01')"), false);
  assert.equal(ui.run("buckets.get('2026-10-30').some(event=>event.id==='timed')"), true);
  assert.equal(ui.run("buckets.get('2026-10-31').some(event=>event.id==='timed')"), true);
});

test("Compose text and Close stay available during identity lookup; obsolete identity results cannot apply", async () => {
  const gate = deferred(), ui = uiFixture({ identityResult: gate.promise });
  ui.run(`state.composeMeta={accountId:'a'};state.composeSession=1;state.composeInitializing=true;
    state.composeInputVersions={to:0,cc:0,bcc:0,body:0};state.composeIdentity=null;
    setComposeFormatLocked=()=>{};syncComposeRecipientRows=()=>{};paintComposeAttachments=()=>{};paintComposeNote=()=>{};paintComposeAi=()=>{};
    call=()=>identityResult;paintComposeFromPicker=()=>{};paintComposeIdentity=()=>{};`);
  ui.run("syncCompose()");
  assert.equal(ui.nodes.get("compose-body").disabled, false);
  assert.equal(ui.nodes.get("compose-subject").disabled, false);
  assert.equal(ui.nodes.get("compose-close").disabled, false);
  assert.equal(ui.nodes.get("compose-from").disabled, true);
  for (const id of ["compose-save", "compose-send", "compose-schedule"]) assert.equal(ui.nodes.get(id).disabled, true);
  const pending = ui.run("initializeComposeIdentity({kind:'new'})");
  ui.run("state.composeSession++;state.composeMeta={accountId:'a',fromAddress:'newer@example.test'}");
  gate.resolve({ fromAddress: "old@example.test" }); await pending;
  assert.equal(ui.run("state.composeMeta.fromAddress"), "newer@example.test");
});

test("background polling runs at most two accounts and a slow first account does not block later mailboxes", async () => {
  const source = fs.readFileSync(path.join(root, "host/mail/engine.js"), "utf8");
  const slow = deferred(), order = [];
  let active = 0, maximum = 0;
  const context = vm.createContext({ Promise, Array, Date, db: { listAccountRows: () => ["a", "b", "c"].map(id => ({ id })) },
    idleController: null, idle: { backgroundPollDue: () => true }, idleSafetyAt: new Map(),
    syncRetryScheduler: { clear() {} }, async syncAccount(account) {
      active++; maximum = Math.max(maximum, active); order.push(account.id);
      if (account.id === "a") await slow.promise;
      active--;
    }, reportSyncFailure: (_account, error) => { throw error; }, fillOvernightBodies: async () => {}, emitAccounts() {} });
  vm.runInContext(productionFunction(source, "syncAllAdmitted"), context);
  const pending = context.syncAllAdmitted({ background: true });
  await flush(); assert.deepEqual(order, ["a", "b", "c"]); assert.equal(maximum, 2);
  slow.resolve(); await pending; assert.equal(active, 0);
});

test("cold Calendar concurrency is bounded and a rate failure stops successors without publishing partial data", async () => {
  const source = fs.readFileSync(path.join(root, "host/mail/calendar-api.js"), "utf8");
  const waiting = deferred(), calls = [], failure = Object.assign(new Error("Rate limited"), { status: 429 });
  let completed = false;
  const context = vm.createContext({ Promise, Array, async listEvents(_provider, _token, id) {
    calls.push(id);
    if (id === "first") throw failure;
    await waiting.promise; return { events: [{ id }], truncated: false };
  } });
  vm.runInContext(productionFunction(source, "listEventsForIds"), context);
  const pending = context.listEventsForIds("google", "synthetic", ["first", "second", "third"], {}).finally(() => { completed = true; });
  const rejected = assert.rejects(pending, error => error === failure);
  await flush(); assert.deepEqual(calls, ["first", "second"]); assert.equal(completed, false);
  waiting.resolve(); await rejected; assert.equal(completed, true);
  context.listEvents = async (_provider, _token, id) => ({ events: [{ id }], truncated: id === "second" });
  const listed = await context.listEventsForIds("google", "synthetic", ["first", "second", "third"], {});
  assert.deepEqual(Array.from(listed.events, event => event.id), ["first", "second", "third"]);
  assert.equal(listed.truncated, true);
});

test("hidden Outbox only reads counts and visible summaries update delivery state without replacing fetched bodies", async () => {
  const ui = uiFixture();
  ui.document.getElementById("scheduled-dialog").open = false;
  ui.run(`globalThis.requests=[];globalThis.readerPaints=0;
    renderList=()=>{};renderReader=()=>{readerPaints++};
    state.outbox=true;state.view='calendar';state.outboxRows=[];
    call=async(_channel,request)=>{requests.push(request);return {rows:[{id:'queued',accountId:'a',outbox:true,status:'sending',subject:'Frozen',sendAt:'2026-11-01'}],outboxTotal:205,reviewCount:0,hasMore:true}};`);
  await ui.run("loadScheduled()");
  assert.equal(ui.run("requests[0].includeRows"), false); assert.equal(ui.run("state.outboxRows.length"), 0);
  assert.equal(ui.run("readerPaints"), 0);
  ui.run("state.view='mail';state.email={id:'queued',outbox:true,outboxStatus:'pending',htmlBody:'Frozen body',attachments:[{filename:'saved'}]}");
  await ui.run("loadScheduled()");
  assert.equal(ui.run("state.listTotal"), 205); assert.equal(ui.run("state.email.outboxStatus"), "sending");
  assert.equal(ui.run("state.email.htmlBody"), "Frozen body"); assert.equal(ui.run("state.email.attachments[0].filename"), "saved");
  assert.equal(ui.run("readerPaints"), 1);
  ui.run("paintListPaging()"); assert.equal(ui.nodes.get("list-next").disabled, false);
  ui.run(`call=async(_channel,request)=>{requests.push(request);return {rows:[],selected:{id:'queued',accountId:'a',outbox:true,status:'sending'},outboxTotal:205,reviewCount:0,hasMore:true}};`);
  await ui.run("loadScheduled()");
  assert.equal(ui.run("requests.at(-1).selectedId"), "queued"); assert.equal(ui.run("state.email.htmlBody"), "Frozen body");
  assert.equal(ui.run("readerPaints"), 1);
  ui.run("state.email=null;call=async()=>({rows:[],selected:null,outboxTotal:0,reviewCount:0})");
  await ui.run("loadScheduled()"); assert.equal(ui.run("state.outboxError"), "");
});

test("Learned only reads visible General content, shares pending reads and retains unchanged patterns", async () => {
  const gate = deferred(), ui = uiFixture({ learnedResult: gate.promise });
  ui.run(`globalThis.learningReads=0;call=()=>{learningReads++;return learnedResult};$('settings').open=true;$('settings-prefs').hidden=true;`);
  await ui.run("paintAgentLearned()"); assert.equal(ui.run("learningReads"), 0);
  ui.run("$('settings-prefs').hidden=false");
  const first = ui.run("paintAgentLearned()"), second = ui.run("paintAgentLearned()");
  assert.equal(ui.run("learningReads"), 1);
  gate.resolve({ patterns: [{ id: "pattern", label: "Synthetic pattern", count: 2 }] }); await Promise.all([first, second]);
  const retained = ui.nodes.get("agent-learned-list").children[0];
  await ui.run("paintAgentLearned()"); assert.equal(ui.nodes.get("agent-learned-list").children[0], retained);
});

test("cold Signatures coordinates its settings dependency into one list read and paint, with stale edit guards", async () => {
  const settings = deferred(), signatures = deferred(), ui = uiFixture({ settingsResult: settings.promise, signatureResult: signatures.promise });
  ui.run(`globalThis.reads={settings:0,signatures:0,paints:0};signatureEditorAccountId='a';signatureEditorSettings=null;
    $('signatures').open=true;paintSignatures=()=>{reads.paints++};
    call=(channel)=>{if(channel==='emailBrain:getComposeSettings'){reads.settings++;return settingsResult}reads.signatures++;return signatureResult};`);
  const first = ui.run("loadSignatureEditor()"), second = ui.run("loadSignatureEditor()");
  assert.equal(ui.run("reads.settings"), 1); assert.equal(ui.run("reads.signatures"), 0);
  settings.resolve({}); await flush(); assert.equal(ui.run("reads.signatures"), 2);
  signatures.resolve({ signatures: [] }); await Promise.all([first, second]); assert.equal(ui.run("reads.paints"), 1);
  const late = deferred(); ui.context.lateResult = late.promise;
  ui.run("call=()=>lateResult"); const pending = ui.run("loadSignatureEditor()");
  ui.run("signatureEditorGeneration++"); late.resolve({ signatures: [{ id: "obsolete" }] }); await pending;
  assert.equal(ui.run("reads.paints"), 1);
  const written = deferred(); ui.context.writtenResult = written.promise;
  ui.run("globalThis.afterWriteReads=0;call=()=>{afterWriteReads++;return writtenResult}");
  const beforeWrite = ui.run("loadSignatureEditor()"), afterWrite = ui.run("loadSignatureEditor(true)");
  assert.equal(ui.run("afterWriteReads"), 2); written.resolve({ signatures: [{ id: "newly-saved" }] });
  await Promise.all([beforeWrite, afterWrite]); assert.equal(ui.run("reads.paints"), 2);
});

test("Debug rows, source options and Undo Details retain node identity, checks, focus and scroll", () => {
  const ui = uiFixture();
  ui.run(`globalThis.lines=[{at:1,source:'host',text:'First'},{at:2,source:'mail',text:'Second'}];paintLog(lines);`);
  const log = ui.nodes.get("log-lines"), sources = ui.nodes.get("log-source"), first = log.children[0], option = sources.children[1];
  ui.run("paintLog(JSON.parse(JSON.stringify(lines)))"); assert.equal(log.children[0], first); assert.equal(sources.children[1], option);
  ui.run(`paintUndoSelectedCount=()=>{};undoItems=[{opId:'one',accountId:'a',subject:'One'},{opId:'two',accountId:'a',subject:'Two'}];paintUndoDetails();`);
  const list = ui.nodes.get("undo-details-list"), row = list.children[0], checkbox = row.querySelector('input[type="checkbox"]');
  checkbox.checked = true; checkbox.focus(); list.scrollTop = 75;
  ui.run("undoItems.push({opId:'three',accountId:'a',subject:'Three'});paintUndoDetails()");
  assert.equal(list.children[0], row); assert.equal(checkbox.checked, true); assert.equal(ui.document.activeElement, checkbox); assert.equal(list.scrollTop, 75);
  assert.equal(list.children[2].querySelector('input[type="checkbox"]').checked, false);
});

test("splitter pointer bursts capture geometry once, batch writes per frame and flush the final width before saving", () => {
  const frames = new Map(), listeners = new Map(), ui = uiFixture({
    requestAnimationFrame: work => { const id = frames.size + 1; frames.set(id, work); return id; },
    cancelAnimationFrame: id => frames.delete(id) });
  ui.context.window.addEventListener = (name, listener) => listeners.set(name, listener);
  ui.context.window.removeEventListener = name => listeners.delete(name);
  const handle = ui.document.getElementById("test-split"); handle.className = "split"; handle.dataset.split = "folders";
  let geometryReads = 0;
  for (const [id, width] of [["shell", 1300], ["side", 260], ["messages", 360]]) {
    ui.document.getElementById(id).getBoundingClientRect = () => { geometryReads++; return { width }; };
  }
  const writes = [];
  ui.document.documentElement = { style: { setProperty: (_name, value) => writes.push(value) } };
  ui.run(`sideColumn=()=>$('side');globalThis.saved=[];rememberLayoutPanes=()=>{saved.push(document.documentElement.style.last)};wireSplits();`);
  handle.listeners.get("pointerdown")({ button: 0, clientX: 100, preventDefault() {} });
  const initialReads = geometryReads;
  for (let index = 1; index <= 20; index++) listeners.get("pointermove")({ clientX: 100 + index });
  assert.equal(frames.size, 1); assert.equal(writes.length, 0); assert.equal(geometryReads, initialReads);
  const [frameId, paint] = [...frames][0]; frames.delete(frameId); paint(); assert.deepEqual(writes, ["280px"]);
  listeners.get("pointermove")({ clientX: 170 }); listeners.get("pointerup")();
  assert.deepEqual(writes, ["280px", "330px"]); assert.equal(ui.run("saved.length"), 1); assert.equal(frames.size, 0); assert.equal(geometryReads, initialReads);
});

test("late Compose defaults preserve typed-then-cleared recipients and native Close does not wait for identity", async () => {
  const gate = deferred(), ui = uiFixture({ identityResult: gate.promise });
  ui.run(`state.composeMeta={accountId:'a'};state.composeSession=1;state.composeInitializing=true;
    state.composeInputVersions={to:0,cc:0,bcc:0,body:0};call=()=>identityResult;
    paintComposeFromPicker=()=>{};paintComposeIdentity=()=>{};`);
  const pending = ui.run("initializeComposeIdentity({kind:'new'})");
  ui.run("state.composeInputVersions.cc=2;state.composeInputVersions.bcc=2;$('compose-cc').value='';$('compose-bcc').value=''");
  gate.resolve({ fromAddress: "a@example.test", selfAddresses: ["a@example.test"], defaultCc: "default@example.test", defaultBcc: "bcc@example.test" });
  await pending; assert.equal(ui.nodes.get("compose-cc").value, ""); assert.equal(ui.nodes.get("compose-bcc").value, "");
  ui.run(`globalThis.closed=0;globalThis.allowed=0;isComposeWindow=()=>true;api.allowComposeClose=()=>{allowed++};
    $('compose').open=true;composeSnapshot=()=>state.composeBaseline;closeDialog=async()=>{closed++;$('compose').open=false};`);
  await ui.run("requestComposeWindowClose()"); assert.equal(ui.run("closed"), 1); assert.equal(ui.run("allowed"), 1); assert.equal(ui.run("state.composeInitializing"), false);
});

test("Calendar agenda retains unchanged display rows while actions resolve the latest description", () => {
  const ui = uiFixture();
  ui.run(`globalThis.events=[{id:'event',calendarId:'calendar',title:'Synthetic',start:'2026-10-30T10:00:00',end:'2026-10-30T11:00:00',description:'Before'}];
    agendaEvents=events=>events;agendaLine=event=>event.title;calendarColor=()=>'';globalThis.selected=null;selectCalendarEvent=event=>{selected=event};
    calendarEventRecords.set(calendarEventKey(events[0]),events[0]);paintAgenda(events);`);
  const button = ui.nodes.get("calendar-agenda").children[0];
  ui.run("events=[{...events[0],description:'After'}];calendarEventRecords.set(calendarEventKey(events[0]),events[0]);paintAgenda(events)");
  assert.equal(ui.nodes.get("calendar-agenda").children[0], button);
  button.listeners.get("click")(); assert.equal(ui.run("selected.description"), "After");
  ui.run("events=[{...events[0],title:'Changed'}];paintAgenda(events)"); assert.notEqual(ui.nodes.get("calendar-agenda").children[0], button);
});

test("source limits suppress queued and later automatic reads, explicit retry succeeds, and empty transient failures remain unreadable", async () => {
  const source = fs.readFileSync(path.join(root, "host/mail/engine.js"), "utf8");
  const account = { id: "a", mail_transport: "imap" };
  let saved = { id: "message", account_id: "a", folder_path: "Inbox", uid: 1, uid_validity: 1, body_complete: 0 };
  let fetched = { uid: 1, htmlBody: "", textBody: "Partial", bodyComplete: false, bodySourceLimited: true };
  let reads = 0, lane = Promise.resolve(), failure = false;
  const results = [];
  const context = vm.createContext({ Date, Number, JSON, Error, Object, accountEpochs: new Map(),
    db: { accountById: () => account, messageById: () => saved, isReady: () => true,
      updateMessage: (_id, patch) => { saved = { ...saved, ...patch }; } },
    exclusive(_id, work) { const pending = lane.then(work); lane = pending.catch(() => {}); return pending; },
    secretFor: async () => "synthetic", priorityWaiting: () => false, needsGmailMetadata: () => false,
    actions: { assertIdentityReady() {} }, bodyProgress: { queue() {}, start() {}, finish: (_task, result) => results.push(result) },
    usableStoredBody: row => !!(row?.html_body?.trim() || row?.text_body?.trim()), http: { isRateLimit: () => false },
    remote: { withClient: (_account, _secret, work) => work({}), async fetchSource() { reads++; if (failure) throw new Error("Synthetic failure"); return fetched; } } });
  vm.runInContext(["ensureBody", "assertReadableBody"].map(name => productionFunction(source, name)).join("\n"), context);
  await Promise.all([context.ensureBody(saved), context.ensureBody(saved)]);
  assert.equal(reads, 1); assert.equal(saved.body_retry_blocked, 1); assert.match(saved.body_warning, /source download limit.*Retry download/);
  await context.ensureBody(saved); assert.equal(reads, 1); assert.ok(results.every(result => result === "source-limit"));
  fetched = { uid: 1, htmlBody: "", textBody: "Complete", bodyComplete: true };
  await context.ensureBody(saved, { retry: true }); assert.equal(reads, 2); assert.equal(saved.body_complete, 1); assert.equal(saved.body_retry_blocked, 0);
  saved = { ...saved, body_complete: 0, html_body: "", text_body: "", body_retry_blocked: 0, body_retry_after: 0 }; failure = true;
  await assert.rejects(context.ensureBody(saved), { code: "body_download_failed" });
  assert.ok(saved.body_retry_after > Date.now()); assert.match(saved.body_warning, /Retry download/);
  const before = reads;
  const blocked = await context.ensureBody(saved); assert.equal(reads, before);
  assert.throws(() => context.assertReadableBody(blocked), { code: "body_download_failed" });
});

test("sync error formatting redacts the credential already in use without a synchronous storage reread", async () => {
  const source = fs.readFileSync(path.join(root, "host/mail/engine.js"), "utf8");
  const context = vm.createContext({ syncCredentialScope: new (require("node:async_hooks").AsyncLocalStorage)(), syncErrorText: new WeakMap(),
    remote: { explain: (error, secret) => error.message.split(secret || "not-a-secret").join("[redacted]") },
    secrets: { getPassword() { throw new Error("Unexpected synchronous credential read"); } } });
  vm.runInContext(["withSyncSecret", "explainSyncError"].map(name => productionFunction(source, name)).join("\n"), context);
  const account = { id: "a" }, error = new Error("Server echoed synthetic-secret");
  await assert.rejects(context.withSyncSecret(account, "synthetic-secret", async () => {
    assert.equal(context.explainSyncError(account, error), "Server echoed [redacted]"); throw error;
  }), cause => cause === error);
  assert.equal(context.explainSyncError(account, error), "Server echoed [redacted]"); assert.equal(context.syncCredentialScope.getStore(), undefined);
});

test("Compose alias discovery shares pending work, cools down failures and invalidation permits a fresh attempt", async () => {
  const gate = deferred(), account = { id: "a", email: "a@example.test", created_at: 1, auth_kind: "oauth2", profile: "google" };
  let discoveries = 0;
  const compose = load("host/mail/compose-identity.js", {
    "./db": { accountById: () => account, saveSendAs() { throw new Error("Failed discovery must not replace cached aliases"); } },
    "../settings": { answer: () => ({}) },
    "../../shared/compose-policy": { identities: () => [], preferredFrom: () => account.email, resolve: () => ({ fromAddress: account.email }) },
    "./sidecar": { providerOf: () => "google", gmailSendAsToken: async () => ({ accessToken: "synthetic" }) },
    "./provider-api": { async listSendAs() { discoveries++; await gate.promise; throw new Error("Synthetic provider failure"); } },
    "./sender-header": {}, "./secrets": { revision: () => 1 }, "./oauth-config": { loadGoogleClient: () => ({ clientId: "synthetic" }) },
  });
  const first = compose.context(account, {}, "new"), second = compose.context(account, {}, "new");
  await flush(); assert.equal(discoveries, 1); gate.resolve();
  const views = await Promise.all([first, second]); assert.ok(views.every(view => /Could not refresh/.test(view.warning)));
  await compose.context(account, {}, "new"); assert.equal(discoveries, 1);
  compose.invalidate(account.id); await compose.context(account, {}, "new"); assert.equal(discoveries, 2);
});

test("actual Features catalog and mounted CLI/storage help describe the mechanisms without native timing or permission claims", () => {
  const ui = uiFixture(), html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
  ui.context.window.morrowFeaturesCatalog = require("../renderer/features-catalog");
  ui.context.window.morrowMotion = { reduced: () => true, fadePane() { throw new Error("Reduced motion must suppress tab animation"); } };
  ui.run("call=()=>{throw new Error('Features must not request credentials or providers')};paintFeatureCatalog()");
  const catalog = ui.nodes.get("features-catalog");
  for (const claim of [/On Windows and macOS/, /guarded per-request grant snapshots/, /only for changed headers/, /source-limited message is not downloaded automatically again/, /Durable acknowledgement, journal recovery and fsync are unchanged/]) assert.match(catalog.textContent, claim);
  const nav = ui.document.getElementById("features-tabs");
  for (const name of ["catalog", "cli"]) {
    const tab = ui.document.createElement("button"); tab.dataset.featuresTab = name; tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", "features-pane-" + name); nav.appendChild(tab);
  }
  ui.document.getElementById("features-pane-catalog").appendChild(catalog);
  const cli = ui.document.getElementById("features-pane-cli"); cli.hidden = true;
  for (const id of ["cli-performance", "cli-body-updates", "mail-secure-storage-help"]) {
    const match = html.match(new RegExp(`<p[^>]*id="${id}"[^>]*>([\\s\\S]*?)</p>`)); assert.ok(match, id);
    const paragraph = ui.document.getElementById(id); paragraph.textContent = match[1].replace(/<[^>]*>/g, "");
    if (id.startsWith("cli-")) cli.appendChild(paragraph);
  }
  ui.run("showFeaturesTab('cli')"); assert.equal(cli.hidden, false); assert.equal(ui.nodes.get("features-pane-catalog").hidden, true);
  assert.match(cli.textContent, /MORROW_PERF=1 npm start/); assert.match(cli.textContent, /not new CLI commands or bot permissions/);
  assert.match(cli.textContent, /does not measure native Mac rendering, Windows frame times or real secure storage/);
  assert.match(ui.nodes.get("mail-secure-storage-help").textContent, /Read errors keep your saved credentials/);
  assert.match(ui.nodes.get("mail-secure-storage-help").textContent, /synchronous compatibility commands/);
  ui.run("showFeaturesTab('catalog')");
  assert.equal(ui.nodes.get("features-pane-catalog").hidden, false);
  assert.equal(cli.hidden, true);
  assert.match(catalog.textContent, /reopened message or selection, even after all changes have been restored/);
  assert.match(catalog.textContent, /at most two 200-header pages.*across nightly windows while the app stays open/);
  assert.match(catalog.textContent, /exhausted scan restarts from newest only on a later pass/);
});
