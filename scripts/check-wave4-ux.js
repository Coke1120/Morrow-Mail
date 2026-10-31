const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { renderer } = require('./check-ux-workflows');
const primaryMailboxes = require('../shared/primary-mailboxes');

function fixture() {
  const nodes = new Map();
  const document = {
    activeElement: null,
    getElementById: id => nodes.get(id) || null,
    querySelector: () => null,
    createElement(tagName) {
      const attributes = new Map();
      const classes = new Set();
      return {
        tagName, nodeType: 1, children: [], dataset: {}, hidden: false, disabled: false, value: '', content: '', scrollTop: 0,
        get textContent() { return this.content + this.children.map(child => child.textContent || '').join(' '); },
        set textContent(value) { this.content = String(value); this.children = []; },
        classList: {
          toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
          add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
        },
        append(...children) { this.children.push(...children); },
        appendChild(child) { this.append(child); return child; },
        replaceChildren(...children) { this.content = ''; this.children = children; },
        setAttribute: (name, value) => attributes.set(name, String(value)),
        getAttribute: name => attributes.get(name) || null,
        removeAttribute: name => attributes.delete(name),
        querySelectorAll(selector) {
          const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
          if (selector === '*') return descendants;
          return descendants.filter(child => selector.split(',').some(part => part.trim() === 'input[type="checkbox"]'
            ? child.tagName === 'input' && child.type === 'checkbox' : part.trim() === child.tagName));
        },
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
        contains(node) { return this === node || this.children.some(child => child.contains(node)); },
        addEventListener() {},
        focus() { document.activeElement = this; },
      };
    },
  };
  for (const id of ['notice','status','status-chip','undo','undo-details','undo-details-popover','list-filter',
    'mail-ooo','mail-ooo-account','mail-ooo-status','mail-ooo-manage','mail-ooo-refresh','ooo-refresh',
    'agent-status','agent-greeting','features-catalog','features-empty','undo-details-list','undo-details-selected']) {
    const node = document.createElement('div');
    node.id = id;
    nodes.set(id, node);
  }
  nodes.get('undo-details-popover').append(nodes.get('undo-details-list'), nodes.get('undo-details-selected'));
  const ui = renderer({ document, setTimeout: () => 1, clearTimeout() {} });
  ui.context.window.morrowPrimaryMailboxes = primaryMailboxes;
  ui.context.window.morrowFeaturesCatalog = require('../renderer/features-catalog');
  ui.run(`globalThis.morrowPrimaryMailboxes = window.morrowPrimaryMailboxes;
    globalThis.frames = []; globalThis.calls = []; globalThis.paints = []; globalThis.overlays = [];
    globalThis.productionLoadList = loadList; afterPaint = task => frames.push(task);
    renderList = () => paints.push(shownEmails().map(row => row.id));
    renderReader = () => {}; loadList = async () => renderList();
    setPageBusy = (panel,on) => overlays.push(on);
    state.accounts = [{id:'alpha',email:'alpha@example.test'}, {id:'beta',email:'beta@example.test'}];
    state.accountId = 'alpha'; state.allInbox = true; state.prefs.conversation = false;
    askConfirm = async () => ({ok:true});`);
  return { ...ui, nodes, json: code => JSON.parse(ui.run('JSON.stringify(' + code + ')')) };
}

async function drainFrames(ui) {
  for (let step = 0; step < 60; step++) {
    ui.run('if (frames.length) frames.shift()()');
    await new Promise(setImmediate);
    if (!ui.run('frames.length')) {
      await new Promise(setImmediate);
      if (!ui.run('frames.length')) return;
    }
  }
  throw new Error('Background removal did not yield and finish');
}

test('W4-1 host account snapshots count cached primary unread, not provider badges or held read rows', () => {
  const engineSource = fs.readFileSync(path.join(__dirname, '../host/mail/engine.js'), 'utf8');
  const source = engineSource.slice(engineSource.indexOf('function accountView('), engineSource.indexOf('\nfunction emitAccounts('));
  const folders = [
    {path:'INBOX',well_known:'inbox',name:'Inbox',unread:900},
    {path:'[Gmail]/All Mail',well_known:'all',name:'All Mail',unread:800},
  ];
  const rows = [
    {accountId:'alpha',folderPath:'[Gmail]/All Mail',unread:true},
    {accountId:'alpha',folderPath:'[Gmail]/All Mail',unread:true,snoozed:true},
    {accountId:'alpha',folderPath:'[Gmail]/All Mail',unread:false,held:true},
    {accountId:'alpha',folderPath:'INBOX',unread:true},
    {accountId:'alpha',folderPath:'Label',unread:true},
    {accountId:'beta',folderPath:'INBOX',unread:true},
  ];
  const db = {
    foldersFor: () => folders,
    inboxUnread: () => 900,
    countMessages(query) {
      assert.equal(query.filterUnread, true);
      assert.equal(query.excludeSnoozed, true);
      return rows.filter(row => row.accountId === query.accountId && row.folderPath === query.folderPath && row.unread && !row.snoozed).length;
    },
  };
  const context = vm.createContext({ db, primaryMailboxes, PRIMARY_ORDER: ['all','inbox'], virtuals: {place() {}},
    remote: {isAllMail: folder => folder.well_known === 'all',allMailLabel: () => 'All Mail'},
    composeIdentity: {accountIdentity: () => ({})}, idlePush: () => ({}),accountEpochs: new Map(),bodyVersion: 0 });
  vm.runInContext(source, context);
  const snapshot = profile => vm.runInContext(`accountView({id:'alpha',profile:'${profile}'},0)`, context);
  const before = snapshot('gmail');
  assert.equal(before.cachedPrimaryUnreadCount, 1);
  assert.equal(before.unreadCount, 900);
  assert.equal(primaryMailboxes.sumUnread([before], account => account.folders.primary), 1);
  rows[0].unread = false;
  const after = snapshot('gmail');
  assert.equal(after.cachedPrimaryUnreadCount, 0);
  assert.equal(primaryMailboxes.sumUnread([after], account => account.folders.primary), 0);
  assert.equal(snapshot('outlook').cachedPrimaryUnreadCount, 1);
  folders.pop();
  assert.equal(snapshot('gmail').cachedPrimaryUnreadCount, 1);
  const ui = fixture();
  ui.context.before = before;
  ui.context.after = after;
  ui.run(`acceptBodyAccounts = accounts => {state.accounts = accounts;}; rememberSelection = () => {};
    globalThis.counts = []; renderAccounts = () => counts.push(allInboxUnread(state.accounts)); syncRemove = () => {};
    scheduleReload = () => {}; onAccountsUpdated({accounts:[before]}); onAccountsUpdated({accounts:[after]});`);
  assert.deepEqual(ui.json('counts'), [1,0]);
  assert.equal(ui.run('allAccountUnreadChip(allInboxUnread(state.accounts), true).text'), 'Unread');
  assert.equal(ui.run('allAccountUnreadChip(0,true).pressed'), true);
});

test('W4-1 selected and page-wide read changes repaint the chip, including a provider refusal', async () => {
  const ui = fixture();
  ui.run(`state.emails=[{id:'one',accountId:'alpha',unread:true},{id:'two',accountId:'beta',unread:true},{id:'three',accountId:'alpha',unread:true}];
    state.selectedIds=['one','two']; globalThis.savedUnread=new Map(state.emails.map(row=>[row.id,true]));
    globalThis.accountsBase=state.accounts;globalThis.counts=[];
    acceptBodyAccounts=accounts=>{state.accounts=accounts;};rememberSelection=()=>{};syncRemove=()=>{};scheduleReload=()=>{};
    renderAccounts=()=>counts.push(allInboxUnread(state.accounts));
    globalThis.publishCounts=()=>onAccountsUpdated({accounts:accountsBase.map(account=>({...account,
      unreadCount:999,folders:{primary:[{id:'INBOX',wellKnownName:'inbox',unreadCount:999}]},
      cachedPrimaryUnreadCount:state.emails.filter(row=>row.accountId===account.id&&savedUnread.get(row.id)).length}))});
    call=async(channel,params)=>{
      const items=params.items||[{emailId:params.emailId}];
      for(const item of items)savedUnread.set(item.emailId,!params.isRead);
      publishCounts();return {pending:items.map(item=>({id:item.emailId,kind:'read',generation:1})),outcomes:[]};
    };publishCounts();`);
  await ui.run('bulkSetRead(true)');
  assert.equal(ui.run('allInboxUnread(state.accounts)'), 1);
  ui.run(`state.selectedIds=['three']`);
  await ui.run('bulkSetRead(true)');
  assert.equal(ui.run('allInboxUnread(state.accounts)'), 0);
  ui.run(`savedUnread.set('one',true);publishCounts();
    applyActionSettlement({outcomes:[{id:'one',kind:'read',generation:1,status:'failed',projection:{unread:true,isStarred:false}}],opIds:[]});`);
  assert.equal(ui.run('allInboxUnread(state.accounts)'), 1);
  await ui.run('setRead(state.emails[0],true)');
  assert.equal(ui.run('allInboxUnread(state.accounts)'), 0);
  assert.deepEqual(ui.json('counts'), [3,1,0,1,0]);
  assert.equal(ui.run('allAccountUnreadChip(0,true).pressed'), true);
});

for (const kind of ['trash', 'archive']) {
  test('W4-3 bulk ' + kind + ' paints immediately, releases guard and bounds background IPC before settlement Undo', async () => {
    const ui = fixture();
    ui.run(`state.emails = Array.from({length:21},(_,index)=>({id:'mail-'+index,accountId:index%2?'beta':'alpha',subject:'Mail '+index,unread:true}));
      state.selectedIds = state.emails.slice(0,20).map(row=>row.id); globalThis.storeRows = state.emails;
      state.email = state.emails[0]; state.unreadHold = {id:'mail-0'};
      loadList = async () => {state.emails = takeEmails(storeRows); renderList();};
      globalThis.first = true;
      call = async (channel,params) => {
        calls.push({channel,params});
        const result = {pending:params.items.map(item=>({id:item.emailId,actionId:'action-'+item.emailId,generation:1,kind:'remove'})),outcomes:[]};
        if (first) {first=false;return new Promise(resolve=>{globalThis.finishFirst=()=>resolve(result);});}
        return result;
      };`);
    await ui.run(kind === 'trash' ? 'guard(bulkTrash)' : 'guard(bulkArchive)');
    assert.deepEqual(ui.json('shownEmails().map(row=>row.id)'), ['mail-20']);
    assert.equal(ui.run('state.busy'), false);
    assert.equal(ui.run('calls.length'), 0);
    assert.equal(ui.run('state.email'), null);
    assert.equal(ui.run('state.unreadHold.id'), 'mail-0');
    assert.deepEqual(ui.json('overlays'), []);
    await drainFrames(ui);
    assert.equal(ui.run('calls.length'), 1);
    assert.equal(ui.run('calls[0].params.items.length'), 4);
    await ui.run('loadList()');
    assert.deepEqual(ui.json('shownEmails().map(row=>row.id)'), ['mail-20']);
    ui.run('finishFirst()');
    await drainFrames(ui);
    assert.deepEqual(ui.json('calls.map(row=>row.params.items.length)'), [4,4,4,4,4]);
    assert.equal(ui.run('undoOpIds'), null);
    assert.match(ui.nodes.get('status').textContent, /20 awaiting confirmation/);
    ui.run(`globalThis.outcomes = state.emails.slice(0,20).map((row,index)=>({id:row.id,actionId:'action-'+row.id,generation:1,kind:'remove',
      status:index===16?'failed':index===17?'unknown':index===18?'not_attempted':'completed',
      opId:index<16||index===19?'undo-'+row.id:undefined,projection:{unread:true,isStarred:false,folderId:'INBOX'}}));
      storeRows = storeRows.filter(row=>!outcomes.some(outcome=>outcome.id===row.id&&outcome.status==='completed'));
      applyActionSettlement({outcomes,opIds:outcomes.filter(row=>row.opId).map(row=>row.opId)});`);
    assert.deepEqual(ui.json('shownEmails().map(row=>row.id)'), ['mail-16','mail-17','mail-18','mail-20']);
    assert.equal(ui.run('optimisticRemovals.size'), 0);
    assert.equal(ui.run('undoOpIds.length'), 17);
    assert.equal(ui.run('calls.length'), 5);
    assert.match(ui.nodes.get('status').textContent, /Refresh before retrying unknown changes/);
  });
}

test('W4-3 confirmation cancel is inert; unknown IPC stops later chunks and retains earlier Undo', async () => {
  const ui = fixture();
  ui.run(`state.emails = Array.from({length:20},(_,index)=>({id:'mail-'+index,accountId:'alpha'}));
    state.selectedIds = state.emails.map(row=>row.id); askConfirm = async () => ({ok:false});`);
  await ui.run('bulkTrash()');
  assert.equal(ui.run('optimisticRemovals.size'), 0);
  assert.equal(ui.run('frames.length'), 0);
  ui.run(`startRemovalSession('Earlier removal.', ['earlier'], false, [{opId:'earlier',messageId:'earlier'}]);
    askConfirm = async () => ({ok:true}); call = async (channel,params) => {calls.push({channel,params});throw Error('IPC lost');};`);
  await ui.run('bulkArchive()');
  await drainFrames(ui);
  assert.equal(ui.run('calls.length'), 1);
  assert.equal(ui.run('shownEmails().length'), 20);
  assert.equal(ui.run('optimisticRemovals.size'), 0);
  assert.equal(ui.run('pendingRemovalMessages.size'), 0);
  assert.deepEqual(ui.json('undoOpIds'), ['earlier']);
  assert.match(ui.nodes.get('status').textContent, /4 unknown.*16 not attempted/);
});

test('W4-3 a failed list refresh does not relabel an accepted removal as an unknown write', async () => {
  const ui = fixture();
  ui.run(`state.emails=[{id:'one',accountId:'alpha'}];state.selectedIds=['one'];
    call=async()=>({pending:[{id:'one',actionId:'remove-one',kind:'remove',generation:1}],outcomes:[]});
    loadList=async()=>{throw Error('Synthetic list failure');};`);
  await ui.run('bulkArchive()');
  await drainFrames(ui);
  assert.equal(ui.run('optimisticRemovals.has("one")'), true);
  assert.equal(ui.run('hasPendingRemovalUndo()'), true);
  assert.match(ui.nodes.get('status').textContent, /result received.*list could not refresh/);
  assert.doesNotMatch(ui.nodes.get('status').textContent, /outcome is unknown/);
});

test('W4-3 an optimistic removal preserves an unread hold through failed settlement and real list reloads', async () => {
  const ui = fixture();
  ui.run(`state.allInboxUnreadOnly=true;
    state.emails=[{id:'held',accountId:'alpha',unread:false},{id:'other',accountId:'alpha',unread:true}];
    globalThis.originalRows=state.emails; globalThis.moved=true; state.selectedIds=['held'];
    state.unreadHold={id:'held',accountId:'alpha',key:'all'};
    loadList=productionLoadList;paintListPaging=()=>{};noteMailListLoaded=()=>{};
    call=async(channel,params)=>{
      calls.push({channel,params});
      if(channel==='mail:listFromCache')return {emails:moved?[originalRows[1]]:originalRows,total:moved?1:2};
      return {pending:[{id:'held',actionId:'remove-held',kind:'remove',generation:1}],outcomes:[]};
    };`);
  await ui.run('bulkArchive()');
  await drainFrames(ui);
  assert.equal(ui.run('state.unreadHold.id'), 'held');
  assert.deepEqual(ui.json('shownEmails().map(row=>row.id)'), ['other']);
  ui.run(`moved=false;applyActionSettlement({outcomes:[{id:'held',actionId:'remove-held',kind:'remove',generation:1,status:'failed',projection:{unread:false,isStarred:false,folderId:'INBOX'}}],opIds:[]});`);
  await new Promise(setImmediate);
  assert.deepEqual(ui.json('calls.at(-1).params.retainIds'), ['held']);
  assert.equal(ui.run('state.unreadHold.id'), 'held');
  assert.deepEqual(ui.json('shownEmails().map(row=>row.id)'), ['held','other']);
});

test('W4-3 terminal settlement before the acceptance reply wins, even after a newer flag generation', async () => {
  const ui = fixture();
  ui.run(`state.emails=[{id:'one',accountId:'alpha'}];state.selectedIds=['one'];
    call=async()=>{
      actionGeneration.set('one',2);
      applyActionSettlement({outcomes:[{id:'one',actionId:'remove-one',kind:'remove',generation:1,status:'failed',error:'Rejected'}],opIds:[]});
      return {pending:[{id:'one',actionId:'remove-one',kind:'remove',generation:1}],outcomes:[]};
    };`);
  await ui.run('bulkArchive()');
  await drainFrames(ui);
  assert.equal(ui.run('optimisticRemovals.size'), 0);
  assert.equal(ui.run('shownEmails().length'), 1);
  assert.match(ui.nodes.get('status').textContent, /1 failed/);
  assert.doesNotMatch(ui.nodes.get('status').textContent, /awaiting confirmation/);
});

test('W4-2 rendered Details preserves checked rows, focus and scroll across batches and restores only the selection', async () => {
  const ui = fixture();
  ui.run(`startRemovalSession('First batch.', ['op-one'], false, [{opId:'op-one',messageId:'one',accountId:'alpha',subject:'First'}]);
    openUndoDetails();setUndoDetailChecks(true);$('undo-details-list').scrollTop=72;
    $('undo-details-list').querySelector('input').focus();
    beginRemovalRequest([{id:'two',accountId:'beta',subject:'Second'}], 'trash', 'Trash');
    rememberRemovalReceipt({pending:[{id:'two',actionId:'remove-two',kind:'remove',generation:1}]},undoEpoch);
    applyActionSettlement({outcomes:[{id:'two',actionId:'remove-two',kind:'remove',generation:1,status:'completed',opId:'op-two'}],opIds:['op-two']});`);
  assert.equal(ui.run('undoPopoverOpen()'), true);
  assert.deepEqual(ui.json('selectedUndoOpIds()'), ['op-one']);
  assert.equal(ui.nodes.get('undo-details-list').scrollTop, 72);
  assert.equal(ui.run('document.activeElement.value'), 'op-one');
  assert.match(ui.nodes.get('undo-details-list').textContent, /alpha@example\.test.*beta@example\.test/);
  assert.equal(ui.nodes.get('undo-details-selected').textContent, 'Undo selected (1)');
  ui.run(`call=async(channel,params)=>{calls.push({channel,params});return {outcomes:[{id:'one',kind:'undo',status:'completed'}]};};`);
  await ui.run('undoSelected()');
  assert.deepEqual(ui.json('calls.at(-1).params.opIds'), ['op-one']);
  assert.deepEqual(ui.json('undoOpIds'), ['op-two']);
});

function agentFixture() {
  const ui = fixture();
  ui.run(`state.view = 'agent'; agentLoaded = true; agentPaintPayload = {sections:[{name:'Saved',items:[]}],updatedAt:'saved'};
    globalThis.agentPaints = []; globalThis.cachedReads = [];
    paintAgent = (payload,error) => {if(payload) agentPaintPayload=payload;agentPaints.push({payload,error});};
    loadStudio = async () => {}; applyAgentMemory = () => {};
    call = async (channel,params) => {
      calls.push({channel,params});
      if(channel==='nativeAgent:home:todosCached') return new Promise(resolve=>cachedReads.push(resolve));
      if(channel==='nativeAgent:triage') return new Promise((resolve,reject)=>{globalThis.finishTriage=resolve;globalThis.failTriage=reject;});
      return {};
    };`);
  return ui;
}

test('W4-5 cached loads paint synchronously, refresh quietly and join in-flight stale triage', async () => {
  const ui = agentFixture();
  const first = ui.run('loadAgent()');
  assert.equal(ui.run('agentPaints[0].payload.updatedAt'), 'saved');
  assert.deepEqual(ui.json('overlays'), [false]);
  ui.run(`cachedReads.shift()({stale:true,sections:[{name:'Cached',items:[]}]})`);
  await new Promise(setImmediate);
  assert.match(ui.nodes.get('agent-status').textContent, /Updating triage.*saved suggestions/);
  const second = ui.run('loadAgent()');
  ui.run(`cachedReads.shift()({stale:true,sections:[{name:'Cached',items:[]}]})`);
  await new Promise(setImmediate);
  assert.equal(ui.run(`calls.filter(row=>row.channel==='nativeAgent:triage').length`), 1);
  assert.equal(ui.run('overlays.some(Boolean)'), false);
  ui.run(`finishTriage({sections:[{name:'Fresh',items:[]}]})`);
  await Promise.all([first,second]);
  assert.equal(ui.run('agentPaintPayload.sections[0].name'), 'Fresh');
  assert.equal(ui.nodes.get('agent-status').getAttribute('aria-busy'), null);
});

test('W4-5 cold and explicit refresh overlay; failed cached refresh retains the last payload', async () => {
  const ui = agentFixture();
  ui.run('agentLoaded=false;agentPaintPayload=null');
  const cold = ui.run('loadAgent()');
  assert.equal(ui.run('agentLoadOverlay'), true);
  ui.run(`cachedReads.shift()({stale:false,sections:[{name:'Cold result',items:[]}]})`);
  await cold;
  assert.equal(ui.run('agentLoaded'), true);
  assert.equal(ui.run('agentLoadOverlay'), false);
  const refresh = ui.run('loadAgent({overlay:true})');
  assert.equal(ui.run('agentLoadOverlay'), true);
  ui.run(`cachedReads.shift()({stale:false,sections:[{name:'Explicit result',items:[]}]})`);
  await refresh;
  const cached = ui.run('loadAgent()');
  const rejected = assert.rejects(cached, /Synthetic triage failure/);
  ui.run(`cachedReads.shift()({stale:true,sections:[{name:'Kept result',items:[]}]})`);
  await new Promise(setImmediate);
  ui.run(`failTriage(Error('Synthetic triage failure'))`);
  await rejected;
  assert.equal(ui.run('agentPaints.at(-1).payload.sections[0].name'), 'Kept result');
  assert.match(ui.run('agentPaints.at(-1).error'), /Synthetic triage failure/);
  assert.equal(ui.run('agentLoadOverlay'), false);
});

test('W4-5 an obsolete triage failure cannot blank or repaint a newer cached load', async () => {
  const ui = agentFixture();
  const old = ui.run('loadAgent()');
  const rejected = assert.rejects(old, /Obsolete failure/);
  ui.run(`cachedReads.shift()({stale:true,sections:[{name:'Old',items:[]}]})`);
  await new Promise(setImmediate);
  const current = ui.run('loadAgent()');
  ui.run(`cachedReads.shift()({stale:false,sections:[{name:'Current',items:[]}]})`);
  await current;
  const paints = ui.run('agentPaints.length');
  ui.run(`failTriage(Error('Obsolete failure'))`);
  await rejected;
  assert.equal(ui.run('agentPaints.length'), paints);
  assert.equal(ui.run('agentPaintPayload.sections[0].name'), 'Current');
});

test('W4-4 All Account OOO chooses a mailbox without inventing status or fetching every provider', async () => {
  const ui = fixture();
  ui.run(`call = async (channel,params) => {calls.push({channel,params});throw Error('No provider calls authorized');}; paintMailVacation();`);
  assert.equal(ui.nodes.get('mail-ooo').hidden, false);
  assert.equal(ui.nodes.get('mail-ooo-account').hidden, false);
  assert.equal(ui.nodes.get('mail-ooo-account').children.length, 2);
  assert.match(ui.nodes.get('mail-ooo-status').textContent, /set per mailbox/);
  assert.doesNotMatch(ui.nodes.get('mail-ooo-status').textContent, /Out of Office: (?:on|off)/);
  assert.equal(ui.nodes.get('mail-ooo-refresh').hidden, true);
  await ui.run('refreshMailVacation()');
  assert.equal(ui.run('calls.length'), 0);
  ui.run(`$('mail-ooo-account').value='beta'; globalThis.openedFold='';
    openSettings = () => {state.settingsAccountId='alpha';}; changeSettingsMailbox = async id => {state.settingsAccountId=id;return true;};
    revealSettingsFold = fold => {openedFold=fold;};`);
  await ui.run('manageMailVacation()');
  assert.equal(ui.run('state.settingsAccountId'), 'beta');
  assert.equal(ui.run('state.accountId'), 'alpha');
  assert.equal(ui.run('openedFold'), 'ooo');
  assert.equal(ui.run('calls.length'), 0);
  ui.run(`state.allInbox=false; rememberVacation({accountId:'alpha',provider:'google',supported:true,settings:{mode:'disabled'}});`);
  assert.equal(ui.nodes.get('mail-ooo-account').hidden, true);
  assert.equal(ui.nodes.get('mail-ooo-status').textContent, 'Out of Office: off');
  ui.run('state.allInbox=true;state.accounts=[];paintMailVacation()');
  assert.equal(ui.nodes.get('mail-ooo').hidden, true);
});

test('Wave4 rendered Features catalog and CLI describe implemented scope and settlement boundaries', () => {
  const ui = fixture();
  ui.run('paintFeatureCatalog()');
  const text = ui.nodes.get('features-catalog').textContent;
  for (const claim of [/downloaded unread messages in each account's primary folder/,/Snoozed messages and a read row held open are excluded/,
    /groups of at most four messages between paints/,/Accepted writes await mailbox confirmation before joining Undo/,
    /accumulate completed changes across batches/,/select one change per message/i,/not a merged on\/off status/,/Agent reopens with its last payload/]) assert.match(text, claim);
  assert.doesNotMatch(text, /A newer removal replaces that list/);
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  assert.match(html, /id="cli-mail-feedback"[^>]*>[^<]*add no bot commands, permissions, bulk cancellation or automatic retries/);
  assert.match(html, /id="mail-ooo-account" aria-label="Mailbox for Out of Office"/);
});
