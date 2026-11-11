// Production selection/render/open handlers with synthetic mail and IPC only.
// No credentials, provider connections, native windows or actual user mail.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { JSDOM } = require('jsdom');
const settle = async () => { for (let n = 0; n < 5; n++) await new Promise(resolve => setImmediate(resolve)); };

function fixture(t, layout = 'right') {
  const root = path.resolve(__dirname, '../renderer');
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), {
    url: 'https://fixture.invalid', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window;
  window.morrow = { on() {}, invoke: async () => ({ success: true, data: null }) };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  let timer = 0; window.setTimeout = () => ++timer; window.clearTimeout = () => {};
  const run = code => vm.runInContext(code, dom.getInternalVMContext());
  const json = code => JSON.parse(run(`JSON.stringify(${code})`));
  for (const script of document.querySelectorAll('script[src]')) {
    const file = script.getAttribute('src');
    if (file === './app.js' || file === './motion.bundle.js') continue;
    run(fs.readFileSync(path.resolve(root, file), 'utf8'));
  }
  run(fs.readFileSync(process.env.MORROW_RENDERER_SOURCE || path.join(root, 'app.js'), 'utf8').replace(/boot\(\)\.catch\([^\n]+\);\s*$/, ''));
  run(`
    wire();
    refreshMailVacation=()=>{};
    state.accounts=['alpha','beta'].map(id=>({id,email:id+'@fixture.invalid',
      folders:{primary:[{id:'INBOX',name:'Inbox'}],more:[]}}));
    state.accountId='alpha';state.folderId='INBOX';state.allInbox=true;
    state.prefs.conversation=false;state.prefs.mailView={layout:${JSON.stringify(layout)}};
    globalThis.storeRows=['a','b','c','d','e'].map((id,index)=>({id,
      accountId:index%2?'beta':'alpha',folderId:'INBOX',subject:'Synthetic '+id,
      from:'sender@fixture.invalid',snippet:index===2?'excluded':'keep',
      textBody:'Synthetic body '+id,bodyComplete:true,hasBody:true,unread:false}));
    state.emails=storeRows.map(row=>({...row}));state.email=null;state.thread=[];
    state.listTotal=5;state.listSyncDone=true;
    globalThis.calls=[];globalThis.pendingOpen=null;globalThis.delayOpen=false;
    call=async(channel,params)=>{
      calls.push({channel,params});
      if(channel==='mail:openEmail') {
        if(delayOpen) await new Promise(resolve=>pendingOpen=resolve);
        return {email:{...storeRows.find(row=>row.id===params.emailId)},threadMessages:[]};
      }
      throw new Error('Unexpected synthetic IPC '+channel);
    };
    renderAccounts();renderList();renderReader(false);
  `);
  const click = async (id, mods = {}, checkbox = false) => {
    const button = document.querySelector(`[data-email-id="${id}"] ${checkbox ? '.row-check' : 'button.message'}`);
    assert.ok(button, `visible synthetic row ${id}`);
    button.dispatchEvent(new window.MouseEvent('click', { detail: 1, bubbles: true, cancelable: true, ...mods }));
    await settle();
  };
  const press = key => document.getElementById('message-list').dispatchEvent(
    new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const selection = () => json('({ids:state.selectedIds,anchor:state.selectionAnchor})');
  return { window, document, run, json, click, press, selection };
}

for (const layout of ['right','bottom','window']) {
  test(`${layout}: plain click anchors forward/reverse ranges without opening the Shift target`, async t => {
    const f=fixture(t,layout);await f.click('b');
    assert.deepEqual(f.selection(),{ids:layout==='window'?['b']:[],anchor:'b'});
    if(layout!=='window')assert.equal(f.document.getElementById('selection-bar').hidden,true);
    const opens=f.json('calls');
    await f.click('e',{shiftKey:true});assert.deepEqual(f.selection(),{ids:['b','c','d','e'],anchor:'b'});
    await f.click('c',{shiftKey:true});assert.deepEqual(f.selection(),{ids:['b','c'],anchor:'b'});
    await f.click('a',{shiftKey:true});assert.deepEqual(f.selection(),{ids:['a','b'],anchor:'b'});
    assert.deepEqual(f.json('calls'),opens,'Shift changes only selection, never opens or marks a target read');
    assert.equal(f.document.querySelector('[data-email-id="a"]').getAttribute('aria-selected'),'true');
    assert.equal(f.document.querySelector('[data-email-id="b"] .row-check').getAttribute('aria-checked'),'true');
    assert.match(f.document.getElementById('selection-count').textContent,/2 selected/);
  });

  test(`${layout}: checkbox Shift click shares the row anchor and keeps it for repeated ranges`, async t => {
    const f=fixture(t,layout);await f.click('b',{},true);
    await f.click('e',{shiftKey:true},true);assert.deepEqual(f.selection(),{ids:['b','c','d','e'],anchor:'b'});
    await f.click('a',{shiftKey:true},true);assert.deepEqual(f.selection(),{ids:['a','b'],anchor:'b'});
    await f.click('d',{},true);await f.click('b',{shiftKey:true});
    assert.deepEqual(f.selection(),{ids:['b','c','d'],anchor:'d'});
    assert.deepEqual(f.json('calls'),[]);
  });
}

for (const modifier of ['ctrlKey','metaKey']) test(`${modifier}: ordinary toggles and additive Shift ranges remain distinct`, async t => {
  const f=fixture(t);await f.click('e',{[modifier]:true});await f.click('b',{[modifier]:true});
  await f.click('d',{shiftKey:true,[modifier]:true});assert.deepEqual(f.selection(),{ids:['e','b','c','d'],anchor:'b'});
  await f.click('c',{shiftKey:true});assert.deepEqual(f.selection(),{ids:['b','c'],anchor:'b'});
  await f.click('b',{[modifier]:true});assert.deepEqual(f.selection(),{ids:['c'],anchor:'b'});
  assert.deepEqual(f.json('calls'),[]);
});

test('a new plain click reanchors and clearing retires the anchor', async t => {
  const f=fixture(t);await f.click('a');await f.click('e',{shiftKey:true});await f.click('d');
  assert.deepEqual(f.selection(),{ids:[],anchor:'d'});
  await f.click('b',{shiftKey:true});assert.deepEqual(f.selection(),{ids:['b','c','d'],anchor:'d'});
  f.document.getElementById('selection-clear').click();assert.deepEqual(f.selection(),{ids:[],anchor:''});
  await f.click('e',{shiftKey:true});assert.deepEqual(f.selection(),{ids:['e'],anchor:'e'});
  f.press('Escape');assert.deepEqual(f.selection(),{ids:[],anchor:''});
  await f.click('b');f.press('Escape');await f.click('d',{shiftKey:true});
  assert.deepEqual(f.selection(),{ids:['d'],anchor:'d'});
});

test('an unchecked checkbox still anchors the next range', async t => {
  const f=fixture(t);await f.click('b',{},true);await f.click('b',{},true);
  assert.deepEqual(f.selection(),{ids:[],anchor:'b'});
  await f.click('e',{shiftKey:true},true);assert.deepEqual(f.selection(),{ids:['b','c','d','e'],anchor:'b'});
});

test('ranges follow the displayed page order and skip filter-hidden or pending rows', async t => {
  const f=fixture(t);f.run("state.emails.reverse();$('list-filter').value='keep';renderList()");
  await f.click('e');await f.click('a',{shiftKey:true});
  assert.deepEqual(f.selection(),{ids:['e','d','b','a'],anchor:'e'});
  f.run("optimisticRemovals.set('d',{});renderList()");
  await f.click('a',{shiftKey:true});assert.deepEqual(f.selection(),{ids:['e','b','a'],anchor:'e'});
  assert.equal(f.json('state.selectedIds').includes('c'),false);
});

test('a hidden/missing anchor cannot select unseen messages, even with an unrelated preview', async t => {
  const f=fixture(t);await f.click('c');f.run("$('list-filter').value='keep';renderList()");
  await f.click('e',{shiftKey:true});assert.deepEqual(f.selection(),{ids:['e'],anchor:'e'});
  f.run("state.emails=state.emails.filter(row=>row.id!=='e');renderList()");
  assert.deepEqual(f.selection(),{ids:[],anchor:''});
  await f.click('a',{shiftKey:true});assert.deepEqual(f.selection(),{ids:['a'],anchor:'a'});
  assert.equal(f.run('state.email.id'),'c','the saved preview is not a range fallback');
});

test('a pending preview completion cannot erase or move the new range anchor', async t => {
  const f=fixture(t);f.run('delayOpen=true');await f.click('b');await f.click('e',{shiftKey:true});
  assert.deepEqual(f.selection(),{ids:['b','c','d','e'],anchor:'b'});
  f.run('pendingOpen()');await settle();
  assert.deepEqual(f.selection(),{ids:['b','c','d','e'],anchor:'b'});
  assert.equal(f.run('state.email.id'),'b');
});

test('removing the anchor never substitutes a different checked message', async t => {
  const f=fixture(t);await f.click('a',{ctrlKey:true});await f.click('b',{ctrlKey:true});
  f.run("state.emails=state.emails.filter(row=>row.id!=='b');renderList()");
  assert.deepEqual(f.selection(),{ids:['a'],anchor:''});
  await f.click('e',{shiftKey:true});assert.deepEqual(f.selection(),{ids:['e'],anchor:'e'});
});

test('search, folder navigation and page changes retire even an unselected anchor', async t => {
  const f=fixture(t);f.run('loadList=async()=>{renderList();return {}}');
  await f.click('b');f.document.getElementById('search-query').value='Synthetic';await f.run('applySearch()');
  assert.deepEqual(f.selection(),{ids:[],anchor:''});
  await f.click('c');await f.run("selectFolder('alpha','INBOX')");
  assert.deepEqual(f.selection(),{ids:[],anchor:''});
  await f.click('b');await f.run('changeListPage(-1)');
  assert.deepEqual(f.selection(),{ids:[],anchor:''});
});

test('Features, Shortcuts and accessible list help describe the same range behavior', t => {
  const f=fixture(t);f.run('showFeatures();paintShortcuts()');
  for(const id of ['features-catalog','shortcuts-note','mail-selection-help']){
    const text=f.document.getElementById(id)?.textContent||'';
    assert.match(text,/Shift-click/);assert.match(text,/checkbox/);assert.match(text,/visible/);
  }
  assert.match(f.document.getElementById('message-list').getAttribute('aria-describedby'),/mail-selection-help/);
});

test('the browser fixture supports bounded synthetic host-filter lists without real mail', async t => {
  const f=fixture(t);
  const source=fs.readFileSync(path.join(__dirname,'check-mail-selection-browser.js'),'utf8');
  const start=source.indexOf('      window.resetFixture=');
  const end=source.indexOf('\n    });\n    const click',start);
  assert.ok(start>=0&&end>start);
  f.run(source.slice(start,end));await f.run("window.resetFixture('right','light')");
  assert.equal(f.run('state.emails.length'),5);
  const rows=await f.run("call('mail:listFromCache',{listFilter:'keep',offset:1,limit:1})");
  assert.deepEqual(JSON.parse(JSON.stringify(rows)),{emails:[f.json("storeRows.find(row=>row.id==='b')")],total:4,syncDone:true});
  const local=await f.run("call('mail:listLocalFolder',{accountId:'beta',listFilter:'keep'})");
  assert.deepEqual(JSON.parse(JSON.stringify(local.emails.map(row=>row.id))),['b','d']);
});
