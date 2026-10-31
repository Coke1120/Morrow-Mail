const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const { test } = require("node:test");
const http = require("../host/mail/provider-http");
const root = path.join(__dirname, "..");
const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const ok = data => ({ success: true, data });
const reply = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

function load(relative, stubs = {}, transform = source => source) {
  const filename = path.join(root, relative);
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = instance.require.bind(instance);
  instance.require = request => Object.hasOwn(stubs, request) ? stubs[request] : original(request);
  instance._compile(transform(fs.readFileSync(filename, "utf8")), filename);
  return instance.exports;
}

function functions(relative, names, bindings) {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  const declarations = names.map(name => {
    const match = source.match(new RegExp("(?:async )?function " + name + "\\([^]*?^}", "m"));
    assert.ok(match, name);
    return match[0];
  }).join("\n");
  return vm.runInNewContext(declarations + "\n({" + names.join(",") + "})", { Map, Set, ...bindings });
}

const { uiFixture, Element } = load("scripts/check-wave1-review.js", {}, source => source.slice(0, source.indexOf("\ntest(")) + "\nmodule.exports={uiFixture,Element};");
Element.prototype.append = function (...nodes) {
  for (const node of nodes) this.appendChild(typeof node === "string" ? this.ownerDocument.createTextNode(node) : node);
};

function providerFixture(provider = "google", overrides = {}) {
  const account = { id: "a", created_at: 1, auth_kind: "oauth2", mail_transport: provider === "google" ? "gmail_api" : "imap", delimiter: "/" };
  const selected = { id: "selected", account_id: "a", folder_path: "Inbox", uid: 7, uid_validity: 8,
    rfc_message_id: "<shared@fixture.invalid>", gmail_id: provider === "google" ? "provider-selected" : null, draft_pending: 0, ...overrides };
  const cache = new Map([[selected.id, selected]]), memberships = new Map(), calls = [];
  const folders = [{ path: "Inbox", name: "Inbox", provider_id: "source-inbox", well_known: "inbox" },
    { path: "Projects", name: "Projects", provider_id: "Label_9", well_known: null }];
  if (provider === "google") folders[0].provider_id = "INBOX";
  const database = {
    accountById: id => id === account.id ? { ...account } : null,
    messageById: id => cache.has(id) ? { ...cache.get(id) } : null,
    folderByPath: (_accountId, folderPath) => folders.find(folder => folder.path === folderPath),
    foldersFor: () => folders,
    gmailAlias: () => null,
    transaction: work => work(),
    bindGmailAlias: (row, providerId) => { const current = cache.get(row.id); if (current && !current.draft_pending) current.gmail_id = providerId; },
    rememberGmail: (_accountId, message) => memberships.set(message.providerId, message.labelIds),
    gmailCopies: (accountId, providerId) => [...cache.values()].filter(row => row.account_id === accountId && row.gmail_id === providerId),
  };
  Object.assign(database, functions("host/mail/db.js", ["pruneGmailCopies"], {
    transaction: database.transaction, gmailCopies: database.gmailCopies, messageHeld: id => !!cache.get(id)?.held,
    forgetIndex: () => {}, run: (_sql, [id]) => cache.delete(id),
  }));
  const fixture = { account, selected, cache, memberships, folders, calls, database, fetch: null };
  const fetcher = async (url, options) => {
    calls.push({ url: String(url), method: options.method, body: options.body && JSON.parse(options.body) });
    if (fixture.fetch) return fixture.fetch(new URL(url), options);
    if (options.method === "POST") return reply({ id: "provider-selected", labelIds: ["INBOX", "Label_9"] });
    throw new Error("Unexpected synthetic provider read: " + url);
  };
  const api = load("host/mail/provider-api.js", { "./provider-http": { ...http, apiJson: (url, token, options) => http.apiJson(url, token, { ...options, fetchImpl: fetcher }) } });
  const ready = { account: { ...account }, provider, token: { accessToken: "synthetic-token" } };
  const oauthConfig = {
    providerKey(profile) {
      const raw = String(profile || "").toLowerCase();
      if (raw === "gmail" || raw === "google") return "google";
      if (raw === "outlook" || raw === "microsoft" || raw === "office365") return "microsoft";
      return "";
    },
    loadGoogleClient: () => ({ clientId: "synthetic" }),
  };
  const secrets = {
    revision: () => 1,
    getPassword: () => null,
    getPasswordAsync: async () => null,
    setPassword() {},
  };
  const sidecar = load("host/mail/sidecar.js", { "./db": database, "./secrets": secrets, "./oauth": { ready }, "./oauth-config": oauthConfig,
    "./provider-api": api, "./calendar-api": {}, "./inbox-rules": {}, "./vacation-api": {}, "./sieve-vacation": {} },
  source => source + "\nwithPurpose=async()=>oauth.ready;\n");
  return { ...fixture, api, sidecar, answer: (channel, params = {}) => sidecar.answer(channel, [{ accountId: "a", emailId: selected.id, ...params }]),
    get fetch() { return fixture.fetch; }, set fetch(value) { fixture.fetch = value; } };
}

function mailFixture() {
  const ui = uiFixture();
  ui.nodes.get("undo-details-popover").hidden = true;
  ui.run(`globalThis.fixture={calls:[],reloads:0,confirmations:0};
    state.accounts=[{id:'a',email:'a@fixture.invalid',platform:'fixture',profile:'gmail',folders:{primary:[{id:'Inbox',name:'Inbox',wellKnownName:'inbox'}],more:[
      {id:'Projects',name:'Projects',providerId:'Label_9'},{id:'Other',name:'Other'},{id:'Work',name:'Work'},{id:'Projects/Work',name:'Work'}]}},
      {id:'b',email:'b@fixture.invalid',platform:'fixture',folders:{primary:[{id:'Inbox',name:'Inbox',wellKnownName:'inbox'}],more:[{id:'Work',name:'Work'},{id:'Projects',name:'Projects'}]}}];
    state.providerFolders={accountId:'a',api:true,folders:[{id:'INBOX',name:'Inbox',wellKnown:'inbox',editable:false},
      {id:'Label_9',name:'Projects',editable:true},{id:'Label_10',name:'Other',editable:true}]};
    renderSettingsAccounts=()=>{};
    paintSyncControl=()=>{};paintListPaging=()=>{};renderChips=()=>{};paintSelectionBar=()=>{};paintSearchCoverage=()=>{};
    paintProviderPage=()=>{};paintBodySyncStatus=()=>{};noteMailListLoaded=()=>{};syncRemove=()=>{};
    loadSnoozed=async()=>{};loadScheduled=async()=>{};refreshMailVacation=()=>{};
    openDialog=id=>{$(id).open=true;};closeDialog=async id=>{$(id).open=false;};
    showStatus=(text,error)=>{globalThis.notice={text,error};};
    call=async(channel,params)=>{fixture.calls.push({channel,params});return {emails:[]};};
    askConfirm=async()=>{fixture.confirmations++;return {ok:true};};`);
  return ui;
}

test("F1: selected Gmail provider IDs and saved UID aliases win over duplicate RFC matches", async () => {
  for (const alias of [false, true]) {
    const fixture = providerFixture("google", { rfc_message_id: "", ...(alias ? { gmail_id: null } : {}) });
    if (alias) fixture.database.gmailAlias = () => ({ provider_id: "provider-selected" });
    const result = await fixture.answer("mail:modifyMessageLabels", { addLabelIds: ["Label_9"], removeLabelIds: [] });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(fixture.calls.length, 1);
    assert.match(fixture.calls[0].url, /\/messages\/provider-selected\/modify$/);
    assert.deepEqual(fixture.memberships.get("provider-selected"), ["INBOX", "Label_9"]);
  }
});

test("F1: duplicate and paginated legacy Gmail lookups fail closed without a provider write", async () => {
  for (const payload of [{ messages: [{ id: "other" }, { id: "provider-selected" }] }, { messages: [{ id: "other" }], nextPageToken: "more" }]) {
    const fixture = providerFixture("google", { gmail_id: null });
    fixture.fetch = async url => {
      assert.equal(url.searchParams.get("maxResults"), "2");
      assert.equal(url.searchParams.get("includeSpamTrash"), "true");
      return reply(payload);
    };
    assert.equal((await fixture.answer("mail:modifyMessageLabels", { addLabelIds: ["Label_9"] })).error.code, "conflict");
    assert.ok(fixture.calls.every(call => call.method !== "POST"));
  }
});

test("F1/F5: provider acknowledgements retain all memberships, not just the label edit limit", async () => {
  const fixture = providerFixture();
  const labelIds = ["INBOX", ...Array.from({ length: 30 }, (_unused, index) => "Label_" + index)];
  fixture.fetch = async () => reply({ labelIds });
  assert.equal((await fixture.answer("mail:modifyMessageLabels", { addLabelIds: ["Label_9"] })).success, true);
  assert.deepEqual(fixture.memberships.get("provider-selected"), labelIds);
});

test("F1: malformed legacy RFC identities cannot broaden the provider search", async () => {
  for (const rfc of ["<shared@fixture.invalid> OR newer", "shared\u0000@fixture.invalid", 'shared"@fixture.invalid']) {
    const fixture = providerFixture("google", { gmail_id: null, rfc_message_id: rfc });
    assert.equal((await fixture.answer("mail:modifyMessageLabels", { addLabelIds: ["Label_9"] })).error.code, "invalid");
    assert.equal(fixture.calls.length, 0);
  }
});

test("F1: legacy Gmail lookup verifies the source folder and rechecks the selected row/account before POST", async () => {
  for (const variant of ["valid", "wrong-folder", "changed-row", "changed-account"]) {
    const fixture = providerFixture("google", { gmail_id: null });
    fixture.fetch = async (url, options) => {
      if (url.searchParams.has("q")) return reply({ messages: [{ id: "provider-selected" }] });
      if (options.method === "POST") return reply({ labelIds: ["INBOX", "Label_9"] });
      if (variant === "changed-row") fixture.selected.uid++;
      if (variant === "changed-account") fixture.account.created_at++;
      return reply({ id: "provider-selected", labelIds: variant === "wrong-folder" ? ["Label_9"] : ["INBOX"] });
    };
    const result = await fixture.answer("mail:modifyMessageLabels", { addLabelIds: ["Label_9"] });
    assert.equal(result.success, variant === "valid", JSON.stringify(result));
    assert.equal(fixture.calls.filter(call => call.method === "POST").length, variant === "valid" ? 1 : 0);
  }
});

test("F1: Outlook lookup is scoped to the selected source folder, never the mailbox's first RFC hit", async () => {
  const fixture = providerFixture("microsoft");
  fixture.fetch = async (url, options) => {
    if (options.method === "POST") return reply({ id: "moved-selected" });
    assert.equal(url.pathname, "/v1.0/me/mailFolders/source-inbox/messages");
    assert.equal(url.searchParams.get("$top"), "2");
    return reply({ value: [{ id: "provider-selected" }] });
  };
  const result = await fixture.answer("mail:moveProviderMessage", { destinationId: "destination" });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.match(fixture.calls.at(-1).url, /\/messages\/provider-selected\/move$/);
});

test("F1: ambiguous, paginated or missing Outlook matches and cross-account requests cannot write", async () => {
  for (const payload of [{ value: [{ id: "other" }, { id: "provider-selected" }] }, { value: [{ id: "other" }], "@odata.nextLink": "more" }, { value: [] }]) {
    const fixture = providerFixture("microsoft");
    fixture.fetch = async () => reply(payload);
    assert.equal((await fixture.answer("mail:moveProviderMessage", { destinationId: "destination" })).success, false);
    assert.ok(fixture.calls.every(call => call.method !== "POST"));
    assert.equal((await fixture.answer("mail:moveProviderMessage", { accountId: "b", destinationId: "destination" })).error.code, "not-found");
  }
});

test("F1/F4: legacy Outlook source resolution follows the full hierarchy and rejects duplicate paths", async () => {
  for (const ambiguous of [false, true]) {
    const fixture = providerFixture("microsoft", { folder_path: "Projects/Archive" });
    fixture.folders.push({ path: "Projects/Archive", name: "Archive" });
    fixture.fetch = async (url, options) => {
      if (options.method === "POST") return reply({ id: "moved" });
      if (url.searchParams.get("$select") === "id" && !url.pathname.endsWith("/messages")) return reply({}, 404);
      if (url.pathname.endsWith("/childFolders")) return reply({ value: [
        { id: "nested", displayName: "Archive", parentFolderId: "projects" },
        ...(ambiguous ? [{ id: "duplicate", displayName: "Archive", parentFolderId: "projects" }] : []),
      ] });
      if (url.pathname.endsWith("/mailFolders")) return reply({ value: [
        { id: "root-archive", displayName: "Archive" }, { id: "projects", displayName: "Projects", childFolderCount: 1 },
      ] });
      assert.equal(url.pathname, "/v1.0/me/mailFolders/nested/messages");
      return reply({ value: [{ id: "provider-selected" }] });
    };
    const result = await fixture.answer("mail:moveProviderMessage", { destinationId: "destination" });
    assert.equal(result.success, !ambiguous, JSON.stringify(result));
    assert.equal(fixture.calls.filter(call => call.method === "POST").length, ambiguous ? 0 : 1);
  }
});

test("F2: a folder switch retires actual rendered rows before pending or failed cache reads", async () => {
  for (const failed of [false, true]) {
    const pending = deferred(), ui = mailFixture();
    ui.context.pending = pending.promise;
    ui.run(`renderList=productionRenderList;loadList=productionLoadList;
      state.emails=[{id:'old',accountId:'a',folderId:'Inbox',subject:'Old inbox row',from:'sender@fixture.invalid'}];
      renderList();call=async()=>pending;`);
    const row = ui.nodes.get("message-list").querySelector(".message-row");
    assert.ok(row?.isConnected);
    const switching = ui.run("selectFolder('a','Other')");
    assert.equal(ui.nodes.get("folders").querySelector('[aria-current="true"]').dataset.folderId, "Other");
    assert.equal(row.isConnected, false);
    assert.equal(ui.run("state.emails.length"), 0);
    if (failed) { pending.reject(new Error("Synthetic cache failure")); await assert.rejects(switching, /cache failure/); }
    else { pending.resolve({ emails: [{ id: "new", accountId: "a", folderId: "Other" }] }); await switching; }
    assert.equal(ui.nodes.get("message-list").querySelector('[data-email-id="old"]'), null);
    assert.equal(ui.run("state.listLoading"), false);
  }
});

test("F2: reversed folder replies still preserve the newer list", async () => {
  const older = deferred(), newer = deferred(), ui = mailFixture();
  Object.assign(ui.context, { older: older.promise, newer: newer.promise });
  ui.run("loadList=productionLoadList;call=async(_channel,params)=>params.folderId==='Work'?older:newer;");
  const first = ui.run("selectFolder('a','Work')"), second = ui.run("selectFolder('a','Other')");
  newer.resolve({ emails: [{ id: "newer" }] }); await second;
  older.resolve({ emails: [{ id: "older" }] }); await first;
  assert.equal(ui.run("state.folderId"), "Other");
  assert.equal(ui.run("state.emails[0].id"), "newer");
});

test("F2: same-scope refresh keeps current rows actionable until its replacement is ready", async () => {
  const delayed = deferred(), ui = mailFixture();
  ui.context.delayed = delayed.promise;
  ui.run("loadList=productionLoadList;call=async()=>({emails:[{id:'current',accountId:'a',folderId:'Inbox'}]})");
  await ui.run("loadList()");
  ui.run("call=async()=>delayed");
  const refreshing = ui.run("loadList()");
  assert.equal(ui.run("state.emails[0].id"), "current");
  delayed.resolve({ emails: [{ id: "refreshed", accountId: "a", folderId: "Inbox" }] }); await refreshing;
  assert.equal(ui.run("state.emails[0].id"), "refreshed");
});

test("F3: completed folder moves cannot remap another mailbox or a revisited selection", async () => {
  for (const revisit of [false, true]) {
    const pending = deferred(), ui = mailFixture();
    ui.context.pending = pending.promise;
    ui.run(`state.folderId='Work';fixture.refreshes=[];loadAccounts=async preferred=>fixture.refreshes.push(preferred);
      call=async(channel)=>channel==='mail:moveFolder'?pending:{emails:[]};`);
    const moving = ui.run("commitFolderMove({kind:'imap',accountId:'a',sourceId:'Work',sourcePath:'Work'},{id:'Projects',path:'Projects'})");
    await tick();
    await ui.run(revisit ? "selectFolder('a','Other').then(()=>selectFolder('a','Work'))" : "selectFolder('b','Work')");
    pending.resolve({ renames: [{ from: "Work", to: "Projects/Work" }] }); await moving;
    assert.equal(ui.run("state.accountId"), revisit ? "a" : "b");
    assert.equal(ui.run("state.folderId"), "Work");
    assert.equal(ui.run("fixture.refreshes[0]"), undefined);
  }
});

test("F3: an owned folder move follows its new path, without a delayed accounts refresh stealing navigation", async () => {
  const accounts = deferred(), ui = mailFixture();
  ui.context.accounts = accounts.promise;
  ui.run(`state.folderId='Work';call=async(channel)=>channel==='mail:moveFolder'?{renames:[{from:'Work',to:'Projects/Work'}]}:
    channel==='mail:listAccounts'?accounts:{emails:[]};`);
  const moving = ui.run("commitFolderMove({kind:'imap',accountId:'a',sourceId:'Work',sourcePath:'Work'},{id:'Projects',path:'Projects'})");
  await tick();
  assert.equal(ui.run("state.folderId"), "Projects/Work");
  await ui.run("selectFolder('b','Inbox')");
  accounts.resolve(ui.json("state.accounts")); await moving;
  assert.equal(ui.run("state.accountId"), "b");
  assert.equal(ui.run("state.folderId"), "Inbox");
});

test("F4: provider IDs and complete Gmail/Outlook paths outrank repeated leaf names", () => {
  const ui = mailFixture();
  ui.run(`state.accounts[0].folders.more=[{id:'Archive',name:'Archive'},{id:'Projects',name:'Projects'},
    {id:'Projects/Archive',name:'Archive'},{id:'Other/Archive',name:'Archive'}];
    globalThis.gmailTree=providerLabelTree([{id:'root',name:'Archive'},{id:'parent',name:'Projects'},{id:'nested',name:'Projects/Archive'}]);
    globalThis.graphTree=providerLabelTree([{id:'root',name:'Archive'},{id:'parent',name:'Projects'},
      {id:'nested',name:'Archive',parentId:'parent'},{id:'other',name:'Archive',parentId:'missing'}]);`);
  assert.equal(ui.run("imapFolderForProvider(state.accounts[0],gmailTree.find(row=>row.id==='nested'),gmailTree).id"), "Projects/Archive");
  assert.equal(ui.run("imapFolderForProvider(state.accounts[0],graphTree.find(row=>row.id==='nested'),graphTree).id"), "Projects/Archive");
  assert.equal(ui.run("imapFolderForProvider(state.accounts[0],{id:'unknown',name:'Archive',parentId:'missing'},graphTree)"), null);
  ui.run("state.accounts[0].folders.more.unshift({id:'nested',name:'nested'})");
  assert.equal(ui.run("imapFolderForProvider(state.accounts[0],gmailTree.find(row=>row.id==='nested'),gmailTree).id"), "Projects/Archive");
  assert.equal(ui.run("labelRemovesFromView('nested','nested',gmailTree,state.accounts[0])"), false);
  ui.run("state.accounts[0].folders.more.find(row=>row.id==='Other/Archive').providerId='nested'");
  assert.equal(ui.run("imapFolderForProvider(state.accounts[0],gmailTree.find(row=>row.id==='nested'),gmailTree).id"), "Other/Archive");
});

test("F4: production account views carry provider folder identity independently of IMAP paths", () => {
  const { accountView } = functions("host/mail/engine.js", ["accountView"], {
    db: {
      foldersFor: () => [{ path: "Projects/Archive", name: "Archive", provider_id: "provider-nested" }],
      inboxUnread: () => 0,
      countMessages: () => 0,
    },
    remote: { isAllMail: () => false }, composeIdentity: { accountIdentity: () => ({}) }, virtuals: { place() {} },
    primaryMailboxes: require("../shared/primary-mailboxes"),
    PRIMARY_ORDER: [], accountEpochs: new Map(), bodyVersion: 1, idlePush: () => null,
  });
  assert.equal(accountView({ id: "a", profile: "gmail" }, 0).folders.more[0].providerId, "provider-nested");
});

function projectionFixture() {
  const memberships = new Map([["provider-selected", ["INBOX", "Label_9"]]]), batches = [];
  const { gmailLabelMemberships } = functions("host/mail/db.js", ["gmailLabelMemberships"], {
    all: (sql, [accountId, ...ids]) => {
      assert.match(sql, /SELECT provider_id, labels_json FROM gmail_messages/);
      batches.push({ accountId, ids });
      return ids.filter(id => memberships.has(id)).map(provider_id => ({ provider_id, labels_json: JSON.stringify(memberships.get(provider_id)) }));
    },
  });
  let singles = 0;
  const db = { jsonList: value => JSON.parse(value || "[]"), maxActionGenerations: ids => new Map(ids.map(id => [id, 0])), gmailLabelMemberships,
    gmailMap: (_accountId, providerId) => { singles++; return { labels_json: JSON.stringify(memberships.get(providerId)) }; } };
  const projected = functions("host/mail/engine.js", ["listRow", "listRows", "detailOf"], { db, publicAttachment: value => value,
    composePolicy: require("../shared/compose-policy"), composeIdentity: { savedAddress: () => "sender@fixture.invalid" },
    actions: { generationOf: () => 0 }, textEncoding: { repairMojibake: value => value, presentMessage: value => value },
    usableStoredBody: () => false, accountEpochs: new Map(), bodyVersion: 1 });
  const row = { id: "selected", account_id: "a", folder_path: "Inbox", gmail_id: "provider-selected", from_addr: "sender@fixture.invalid" };
  return { ...projected, memberships, batches, gmailLabelMemberships, row, singles: () => singles };
}

test("F5: actual list/detail projections hydrate rendered Gmail label checks and survive fresh projections", async () => {
  const projection = projectionFixture(), ui = mailFixture();
  const listed = projection.listRows([projection.row])[0];
  assert.equal(projection.singles(), 0);
  assert.equal(projection.batches.length, 1);
  ui.context.listed = listed;
  ui.run("loadList=productionLoadList;call=async()=>({emails:[listed]})");
  await ui.run("loadList()");
  ui.run("state.email=listed;openLabelPicker(state.emails,false)");
  const checkbox = ui.nodes.get("label-picker-list").querySelectorAll("input").find(node => node.value === "Label_9");
  assert.equal(checkbox.checked, true);
  projection.memberships.set("provider-selected", ["INBOX", "Label_9", "Label_10"]);
  ui.context.fresh = projection.detailOf(projection.row);
  ui.run("openLabelPicker([fresh],false)");
  assert.ok(ui.nodes.get("label-picker-list").querySelectorAll("input").every(node => node.checked));
  ui.run("openLabelPicker([fresh,{...fresh,id:'other',labelIds:['INBOX']}],true)");
  assert.ok(ui.nodes.get("label-picker-list").querySelectorAll("input").every(node => node.indeterminate));
});

test("F5: membership projection batches bounded account-scoped queries and leaves IMAP labels unknown", () => {
  const projection = projectionFixture();
  const rows = Array.from({ length: 801 }, (_unused, index) => ({ account_id: "a", gmail_id: "provider-" + index }));
  rows.push({ account_id: "b", gmail_id: "provider-selected" });
  projection.gmailLabelMemberships(rows);
  assert.equal(projection.batches.length, 4);
  assert.ok(projection.batches.every(batch => batch.ids.length <= 400));
  assert.equal(projection.listRow({ ...projection.row, gmail_id: null }).labelIds, undefined);
});

test("F6: real provider label removal persists memberships and prunes only matching, unheld cached copies", async () => {
  const fixture = providerFixture("google", { folder_path: "Projects" });
  for (const [id, folder_path, extra] of [["inbox-copy", "Inbox", {}], ["pending-draft", "Projects", { draft_pending: 1 }], ["held", "Projects", { held: true }]]) {
    fixture.cache.set(id, { ...fixture.selected, id, folder_path, ...extra });
  }
  fixture.fetch = async () => reply({ labelIds: ["INBOX"] });
  const result = await fixture.answer("mail:modifyMessageLabels", { addLabelIds: [], removeLabelIds: ["Label_9"] });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(fixture.memberships.get("provider-selected"), ["INBOX"]);
  assert.deepEqual([...fixture.cache.keys()], ["inbox-copy", "pending-draft", "held"]);
});

test("F6: single current-label removal reconciles rows, reader and selection without consuming removal Undo", async () => {
  const ui = mailFixture();
  ui.run(`state.folderId='Projects';state.email={id:'selected',accountId:'a',folderId:'Projects',labelIds:['INBOX','Label_9']};
    state.emails=[state.email,{id:'keep',accountId:'a',folderId:'Projects'}];state.selectedIds=['selected','keep'];state.selectionAnchor='selected';
    undoOpIds=['prior-durable-removal'];loadList=async()=>{fixture.reloads++;};
    call=async(channel,params)=>{fixture.calls.push({channel,params});return {messageId:'provider-selected',labelIds:['INBOX']};};`);
  await ui.run("applyLabelPlans({bulk:false,labels:state.providerFolders.folders,plans:[{email:state.email,removeLabelIds:['Label_9'],addLabelIds:[]}]})");
  assert.deepEqual(ui.json("state.emails.map(row=>row.id)"), ["keep"]);
  assert.deepEqual(ui.json("state.selectedIds"), ["keep"]);
  assert.equal(ui.run("state.email"), null);
  assert.equal(ui.run("state.selectionAnchor"), "");
  assert.equal(ui.run("fixture.reloads"), 1);
  assert.deepEqual(ui.json("undoOpIds"), ["prior-durable-removal"]);
});

test("F6: bulk removal confirms and reconciles only successful current-label removals, retaining failed/unattempted/add-only rows", async () => {
  const ui = mailFixture();
  ui.run(`state.folderId='Projects';state.emails=['remove','add-only','fail','later'].map(id=>({id,accountId:'a',folderId:'Projects',labelIds:['INBOX','Label_9']}));
    state.selectedIds=state.emails.map(row=>row.id);state.email=state.emails[1];loadList=async()=>{fixture.reloads++;};
    globalThis.snapshot={bulk:true,messages:state.emails.slice(),labels:state.providerFolders.folders,plans:state.emails.map((email,index)=>({email,
      addLabelIds:index===1?['Label_10']:[],removeLabelIds:index===1?[]:['Label_9']}))};
    call=async(channel,params)=>{fixture.calls.push({channel,params});if(params.emailId==='fail')throw new Error('Synthetic provider failure');return {messageId:params.emailId};};`);
  await ui.run("applyLabelPlans(snapshot)");
  assert.equal(ui.run("fixture.confirmations"), 1);
  assert.equal(ui.run("fixture.calls.length"), 3);
  assert.deepEqual(ui.json("state.emails.map(row=>row.id)"), ["add-only", "fail", "later"]);
  assert.deepEqual(ui.json("state.selectedIds"), ["add-only", "fail", "later"]);
  assert.equal(ui.run("state.email.id"), "add-only");
  assert.deepEqual(ui.json("state.email.labelIds"), ["INBOX", "Label_9", "Label_10"]);
  assert.match(ui.run("notice.text"), /2 completed.*1 unknown.*1 not attempted/);
});

test("F6: canceled/failed label changes and delayed completion after navigation preserve the current view", async () => {
  const ui = mailFixture();
  ui.run(`state.folderId='Projects';state.email={id:'selected',accountId:'a',labelIds:['Label_9']};state.emails=[state.email];state.selectedIds=['selected'];
    globalThis.snapshot={bulk:true,messages:state.emails.slice(),labels:state.providerFolders.folders,plans:[{email:state.email,removeLabelIds:['Label_9'],addLabelIds:[]}]};
    askConfirm=async()=>({ok:false});`);
  await ui.run("applyLabelPlans(snapshot)");
  assert.equal(ui.run("fixture.calls.length"), 0);
  ui.run("call=async()=>{throw new Error('Synthetic refusal');}");
  await assert.rejects(ui.run("changeLabels(state.email,[],['Label_9'])"), /refusal/);
  assert.equal(ui.run("state.emails.length"), 1);
  const delayed = deferred(); ui.context.delayed = delayed.promise;
  ui.run("call=async()=>delayed");
  const changing = ui.run("changeLabels(state.email,[],['Label_9'])");
  ui.run("++mailboxNavigationGen;state.accountId='b';state.email={id:'selected',accountId:'b',labelIds:['unrelated']};state.emails=[state.email];state.selectedIds=['selected'];");
  delayed.resolve({ messageId: "provider-selected", labelIds: [] }); await changing;
  assert.equal(ui.run("state.email.accountId"), "b");
  assert.deepEqual(ui.json("state.email.labelIds"), ["unrelated"]);
  assert.deepEqual(ui.json("state.selectedIds"), ["selected"]);
});

test("F7: actual Open in Mail enters immediately and delayed completion cannot override newer Support navigation", async () => {
  for (const support of ["showLog()", "showFeatures()", "showPrimary('folders','provider-panel')", "failed-read"]) {
    const delayed = deferred(), ui = mailFixture();
    ui.context.delayed = delayed.promise;
    ui.context.window.morrowFeaturesCatalog = require("../renderer/features-catalog");
    ui.run(`state.view='folders';loadList=productionLoadList;call=async()=>delayed;refreshLog=async()=>{};
      globalThis.block=document.createElement('section');globalThis.actions=document.createElement('div');actions.id='provider-actions';block.appendChild(actions);
      paintProviderActions(block,state.accounts[0],'gmail',[{id:'Label_9',name:'Projects'}],['Label_9']);`);
    const open = ui.run("actions").querySelectorAll("button").find(node => node.textContent === "Open in Mail");
    open.click();
    assert.equal(ui.run("state.view"), "mail");
    ui.run(support === "failed-read" ? "showLog()" : support);
    const view = ui.run("state.view");
    if (support === "failed-read") delayed.reject(new Error("Synthetic read failure"));
    else delayed.resolve({ emails: [] });
    await tick(); await tick();
    assert.equal(ui.run("state.view"), view);
  }
});

test("F8: Escape preserves hidden Mail selection on every non-Mail page and retains Mail typing/overlay guards", () => {
  const ui = mailFixture();
  ui.run("state.email={id:'chosen',accountId:'a'};state.selectedIds=['chosen'];globalThis.escape={key:'Escape',target:document.body,preventDefault(){fixture.prevented=true;}};");
  for (const view of ["log", "features", "folders", "calendar", "agent", "brain"]) {
    ui.run(`state.view=${JSON.stringify(view)};onSelectionKey(escape)`);
    assert.deepEqual(ui.json("state.selectedIds"), ["chosen"]);
  }
  ui.run("state.view='mail';escape.target=document.createElement('input');onSelectionKey(escape)");
  assert.deepEqual(ui.json("state.selectedIds"), ["chosen"]);
  ui.run("escape.target=document.body;globalThis.overlay=document.createElement('dialog');overlay.setAttribute('open','');document.body.appendChild(overlay);onSelectionKey(escape)");
  assert.deepEqual(ui.json("state.selectedIds"), ["chosen"]);
  ui.run("overlay.remove();onSelectionKey(escape)");
  assert.deepEqual(ui.json("state.selectedIds"), []);
  assert.equal(ui.run("state.email.id"), "chosen");
});

test("Features: wave3 catalog, rendered Features/Shortcuts/CLI tabs and identity claims stay aligned", () => {
  const ui = mailFixture();
  ui.context.window.morrowFeaturesCatalog = require("../renderer/features-catalog");
  ui.run("paintFeatureCatalog();paintShortcuts();paintCli()");
  const rendered = ui.nodes.get("features-catalog").textContent;
  for (const claim of [/complete folder hierarchy/, /saved provider memberships/, /unique.*source folder/, /Escape clears selected messages only on the Mail page/, /delayed folder read/]) assert.match(rendered, claim);
  assert.match(ui.nodes.get("shortcuts-list").textContent, /only on the Mail page/);
  const nav = ui.nodes.get("features-tabs");
  for (const name of ["catalog", "shortcuts", "cli"]) {
    const tab = ui.nodes.get("features-tab-" + name);
    tab.dataset.featuresTab = name; tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", "features-pane-" + name); nav.appendChild(tab);
    ui.run(`showFeaturesTab('${name}')`);
    assert.equal(ui.nodes.get("features-pane-" + name).hidden, false);
  }
  const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
  assert.match(html, /id="cli-folder-labels"[^]*ambiguous legacy Message-ID matches are refused/);
  assert.equal(require("../package.json").version, "0.3.12");
});
