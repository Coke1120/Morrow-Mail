// Actual first-party shell with synthetic IPC and deterministic timers. No mail/network/credentials.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const root = path.resolve(__dirname, '../renderer');
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), {
    url: 'https://fixture.invalid', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window, timers = new Map(); let serial = 0;
  window.morrow = { on() {}, invoke: async () => ({ success: true, data: null }) };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.setTimeout = (fn, delay) => { const id = ++serial; timers.set(id, { fn, delay }); return id; };
  window.clearTimeout = id => timers.delete(id);
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.showModal = () => dialog.setAttribute('open', '');
    dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); };
  }
  const run = code => vm.runInContext(code, dom.getInternalVMContext());
  const json = code => JSON.parse(run(`JSON.stringify(${code})`));
  for (const script of document.querySelectorAll('script[src]')) {
    const file = script.getAttribute('src');
    if (file === './app.js' || file === './motion.bundle.js') continue;
    run(fs.readFileSync(path.resolve(root, file), 'utf8'));
  }
  run(fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/boot\(\)\.catch\([^\n]+\);\s*$/, ''));
  run(`wire(); state.view='mail'; state.accounts=['alpha','beta'].map(id=>({id,email:id+'@fixture.invalid',folders:{primary:[{id:'INBOX',name:'Inbox',wellKnownName:'inbox'},{id:'Archive',name:'Archive'}],more:[]}}));
    state.accountId='alpha'; state.folderId='INBOX'; state.allInbox=false; state.prefs.conversation=false;
    state.listSort={sortBy:'subject',sortDirection:'asc'}; offerChangelog=async()=>{};
    globalThis.calls=[]; globalThis.pending=[]; globalThis.deferCalls=false;
    globalThis.storeRows=Array.from({length:650},(_,n)=>({id:'m'+n,accountId:'alpha',folderId:'INBOX',
      subject:String(n).padStart(3,'0')+(n>=400?' needle':''),from:'sender@fixture.invalid',snippet:n===649?'ÉCOLE literal %_':'',
      date:'2026-11-05T00:00:00Z',hasBody:true,unread:n%2===0,isStarred:true}));
    globalThis.answer=(channel,p)=>{let rows=storeRows.filter(row=>(!p.accountId||row.accountId===p.accountId)&&(!p.folderId||row.folderId===p.folderId));
      if(p.filterUnread)rows=rows.filter(row=>row.unread); if(p.listFilter) rows=filteredEmails(rows,p.listFilter);
      rows.sort((a,b)=>a.subject.localeCompare(b.subject)*(p.sortDirection==='desc'?-1:1));
      if(channel==='mail:searchLocal')return rows.slice(0,100);
      return {emails:rows.slice(p.offset||0,(p.offset||0)+(p.limit||200)),total:rows.length,initialSyncDone:true};};
    call=async(channel,params)=>{calls.push({channel,params});const result=answer(channel,params);
      if(deferCalls)return new Promise(resolve=>pending.push(()=>resolve(result)));return result;};
    renderAccounts();`);
  const input = value => { document.getElementById('list-filter').value = value; document.getElementById('list-filter').dispatchEvent(new window.Event('input')); };
  const flush = async () => { for (const [id, item] of [...timers]) if (item.delay === 180) { timers.delete(id); item.fn(); } await tick(); };
  return { run, json, document, input, flush, timers };
}
test('whole selected view: beyond first page, exact totals, paging, sort, zero, literal Unicode and clear', async t => {
  const f = fixture(t); await f.run('loadList(false,0)');
  assert.equal(f.run('state.emails.length'),200); assert.equal(f.run('state.listTotal'),650);
  f.input('needle'); await f.flush();
  assert.equal(f.run('state.listTotal'),250); assert.equal(f.run('state.emails[0].id'),'m400');
  assert.equal(f.run('calls.at(-1).params.listFilter'),'needle');
  await f.run('changeListPage(1)'); assert.equal(f.run('state.listOffset'),200); assert.equal(f.run('state.emails.length'),50);
  await f.run('changeListPage(-1)'); assert.equal(f.run('state.emails[0].id'),'m400');
  await f.run("state.listSort.sortDirection='desc'; loadList(false,0)"); assert.equal(f.run('state.emails[0].id'),'m649');
  f.input('école literal %_'); await f.flush(); assert.equal(f.run('state.listTotal'),1); assert.equal(f.run('state.emails[0].id'),'m649');
  f.input('absent'); await f.flush(); assert.equal(f.run('state.listTotal'),0);
  assert.match(f.document.querySelector('#message-list .empty').textContent,/No downloaded messages.*match/);
  f.document.getElementById('filter-chip').click(); await f.flush(); assert.equal(f.run('state.listTotal'),650); assert.equal(f.run('state.listOffset'),0);
});
test('request contract preserves scope and flags and suppresses filtered cursors without changing toolbar search', t => {
  const f=fixture(t);
  for(const source of [
    {accountId:'alpha',folderId:'INBOX'}, {accountId:'local',folderId:'saved'},
    {allInbox:true,accounts:[]}, {allInbox:true,aggregateView:'unread'}, {allInbox:true,aggregateView:'starred'}
  ]) {
    const request=f.json(`mailListRequest(${JSON.stringify({...source,listFilter:' needle ',offset:200,toMeOnly:true,pageCursor:{offset:200},listSort:{sortBy:'subject',sortDirection:'desc'}})})`);
    assert.equal(request.params.listFilter,'needle'); assert.equal(request.params.offset,200); assert.equal(request.params.filterToMe,true);
    assert.equal(request.params.sortBy,'subject'); assert.equal(request.params.pageCursor,undefined);
    if(source.folderId) assert.equal(request.params.folderId,source.folderId);
    if(source.aggregateView)assert.equal(request.params.aggregateView,source.aggregateView);
  }
  const search=f.json("mailListRequest({query:'hello',listFilter:'needle'})");
  assert.equal(search.channel,'mail:searchLocal'); assert.equal(search.params.listFilter,undefined); assert.equal(search.params.limit,100);
});
test('stale response cannot replace typed query during debounce; clear and navigation discard earlier responses', async t => {
  const f=fixture(t); await f.run('loadList(false,0)');
  f.run('deferCalls=true; globalThis.oldLoad=loadList(false,200)');
  f.input('needle'); f.run('pending.shift()()'); await f.run('oldLoad');
  assert.equal(f.run('state.listOffset'),0); assert.equal(f.run('state.emails[0].id'),'m0');
  await f.flush(); assert.equal(f.run('pending.length'),1);
  f.input(''); await f.flush(); assert.equal(f.run('pending.length'),2);
  f.run('pending.pop()()'); await tick(); assert.equal(f.run('state.listTotal'),650);
  f.run('pending.shift()()'); await tick(); assert.equal(f.run('state.listTotal'),650);
  f.input('needle'); await f.flush();
  f.run("state.folderId='Archive'; document.getElementById('list-filter').value=''; globalThis.nav=loadList(false,0)");
  f.run('pending.pop()()'); await f.run('nav');
  f.run('pending.shift()()'); await tick(); assert.equal(f.run('state.folderId'),'Archive'); assert.equal(f.run('state.emails.length'),0);
});
test('hidden selection survives host filtering and stays part of reviewed Delete targets', async t => {
  const f=fixture(t); await f.run('loadList(false,0)');
  f.run("state.selectedIds=['m1','m2']; state.selectionAnchor='m1'; renderList()");
  f.input('needle'); await f.flush();
  assert.deepEqual(f.json('state.selectedIds'),['m1','m2']);
  assert.deepEqual(f.json('shellDeleteSelection().map(row=>row.id)'),['m1','m2']);
  assert.equal(f.run('shownEmails().some(row=>state.selectedIds.includes(row.id))'),false);
  f.input(''); await f.flush(); assert.deepEqual(f.json('shellDeleteSelection().map(row=>row.id)'),['m1','m2']);
});
test('Search and Outbox filter their explicitly bounded loaded rows with honest labels', async t => {
  const f=fixture(t); await f.run("state.query='some search'; loadList(false,0)");
  const before=f.run('calls.length'); f.input('needle'); await f.flush();
  assert.equal(f.run('calls.length'),before); assert.equal(f.document.getElementById('list-filter').placeholder,'Filter returned results');
  assert.match(f.document.getElementById('list-coverage').textContent,/up to 100/);
  f.run("state.query=''; state.outbox=true; state.emails=storeRows.slice(0,10)");
  f.input('mismatch'); await f.flush(); assert.equal(f.run('calls.length'),before);
  assert.equal(f.document.getElementById('list-filter').placeholder,'Filter loaded Outbox');
  assert.match(f.document.getElementById('list-coverage').textContent,/loaded Outbox/);
});
test('typing the bounded filter does not discard an in-flight toolbar search or Outbox load', async t => {
  const f=fixture(t); await f.run('loadList(false,0)');
  f.run("state.query='query'; deferCalls=true; globalThis.searchLoad=loadList(false,0)");
  f.input('049'); await f.flush(); assert.equal(f.run('state.listLoading'),true); f.run('pending.shift()()'); await f.run('searchLoad');
  assert.equal(f.run('state.emails.length'),100);
  assert.deepEqual(f.json('shownEmails().map(row=>row.id)'),['m49']);
  f.run(`state.query=''; state.outbox=true;
    loadScheduled=async()=>{await new Promise(resolve=>{globalThis.finishScheduled=resolve});
      state.outboxRows=[{id:'send1',accountId:'alpha',subject:'Scheduled needle',sendAt:'2026-12-01T00:00:00Z'}];state.outboxCount=1;};
    globalThis.outboxLoad=loadList(false,0)`);
  f.input('needle'); await f.flush(); assert.equal(f.run('state.listLoading'),true); f.run('finishScheduled()'); await f.run('outboxLoad');
  assert.deepEqual(f.json('shownEmails().map(row=>row.id)'),['send1']);
});

test('rendered Features and filter help describe downloaded-view and bounded-mode coverage', t => {
  const f=fixture(t); f.run('paintFeatureCatalog()');
  const catalog=f.document.getElementById('features-catalog').textContent;
  assert.match(catalog,/Filter downloaded view matches all saved messages in the selected local folder before paging/);
  assert.match(catalog,/Filter downloaded view matches a case-insensitive literal phrase/);
  assert.match(catalog,/Search filters only its returned results \(up to 100\); Outbox filters its loaded rows/);
  assert.match(f.document.getElementById('list-filter-help').textContent,/across all downloaded messages in the selected folder or view/);
  assert.match(f.document.getElementById('list-filter-help').textContent,/Settings → Mail & Sync controls sync history/);
});

test('a failed filter reports unavailable results without stale totals or a stuck loading label, then retries', async t => {
  const f=fixture(t); await f.run('loadList(false,0)');
  f.run("globalThis.workingCall=call; call=async()=>{throw new Error('Synthetic filter failure')}");
  f.input('needle'); await f.flush();
  assert.equal(f.run('state.listLoading'),false);
  assert.equal(f.run('state.listFilterError'),true);
  assert.match(f.document.getElementById('list-coverage').textContent,/Could not filter/);
  assert.doesNotMatch(f.document.getElementById('list-coverage').textContent,/650 matches|Filtering/);
  assert.match(f.document.querySelector('#message-list .empty').textContent,/Could not filter/);
  assert.equal(f.document.getElementById('list-next').disabled,true);
  assert.equal(f.document.getElementById('list-page-status').textContent,'Filter results unavailable');
  f.run('call=workingCall'); f.input('needle'); await f.flush();
  assert.equal(f.run('state.listFilterError'),false);
  assert.equal(f.run('state.listTotal'),250);
  assert.equal(f.document.getElementById('list-next').disabled,false);
  assert.match(f.document.getElementById('list-coverage').textContent,/250 matches/);
});
