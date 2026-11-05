// Production shell/reader, confirmation, bulk receipts and Undo with synthetic
// DOM/mail/IPC only. No credentials, provider connections or real mail.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, layout = 'right', role = '') {
  const root = path.resolve(__dirname, '../renderer');
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), {
    url: 'https://fixture.invalid', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window;
  window.document.documentElement.dataset.window = role;
  window.morrow = { on() {}, invoke: async () => ({ success: true, data: null }) };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  let timer = 0;
  window.setTimeout = () => ++timer;
  window.clearTimeout = () => {};
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.showModal = () => dialog.setAttribute('open', '');
    dialog.close = () => {
      dialog.removeAttribute('open');
      dialog.dispatchEvent(new window.Event('close'));
    };
  }
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
    state.accounts = ['alpha', 'beta'].map(id => ({ id, email: id+'@fixture.invalid',
      folders: {primary: [{id:'INBOX',name:'Inbox',wellKnownName:'inbox'}],more:[]} }));
    state.accountId='alpha'; state.folderId='INBOX'; state.allInbox=true;
    state.prefs.conversation=false; state.prefs.mailView={layout:${JSON.stringify(layout)}};
    globalThis.storeRows = ['a','b','c'].map((id,index) => ({id,accountId:index===1?'beta':'alpha',
      folderId:'INBOX',subject:'Fixture '+id,from:'sender@fixture.invalid',date:'2026-11-05T00:00:00Z',
      textBody:'Synthetic body '+id,bodyComplete:true,hasBody:true,unread:false}));
    state.emails=storeRows.map(row=>({...row})); state.email={...state.emails[0]}; state.thread=[];
    state.listTotal=3; state.listSyncDone=true;
    globalThis.calls=[]; globalThis.jobs=[]; globalThis.frames=[]; globalThis.delivery='completed';
    globalThis.originalGuard=guard;
    guard=fn=>{const job=originalGuard(fn);jobs.push(job);return job};
    afterPaint=fn=>frames.push(fn);
    loadList=async()=>{state.emails=storeRows.filter(row=>row.folderId==='INBOX').map(row=>({...row}));renderList()};
    call=async(channel,params)=>{
      calls.push({channel,params});
      if(channel==='mail:listThreadMessages') return storeRows.filter(row=>row.accountId===params.accountId&&row.threadId===params.threadId).map(row=>({...row}));
      if(channel==='mail:undoRemoval') {
        for(const opId of params.opIds){const id=opId.slice(3);storeRows.find(row=>row.id===id).folderId='INBOX'}
        return {outcomes:params.opIds.map(opId=>({id:opId.slice(3),kind:'undo',status:'completed',generation:2})),opIds:[]};
      }
      if(channel!=='mail:delete'&&channel!=='mail:deleteBatch') throw new Error('Unexpected fixture IPC '+channel);
      const items=params.items||[params];
      if(delivery==='lost') throw new Error('Synthetic IPC lost');
      if(delivery==='accepted') return {pending:items.map(item=>({id:item.emailId,kind:'remove',actionId:'action-'+item.emailId,generation:1})),outcomes:[]};
      for(const item of items){const row=storeRows.find(row=>row.id===item.emailId&&row.accountId===item.accountId);if(!row)throw new Error('Wrong synthetic identity');row.folderId='Trash'}
      return {outcomes:items.map(item=>({id:item.emailId,kind:'remove',status:'completed',generation:1,opId:'op-'+item.emailId})),opIds:items.map(item=>'op-'+item.emailId)};
    };
    renderAccounts();renderList();renderReader(false);
  `);
  const press = (key = 'Delete', extra = {}, target = document.body) => target.dispatchEvent(
    new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
  const select = (...ids) => ids.forEach(id => document.querySelector(`[data-email-id="${id}"] .row-check`).click());
  const settle = async () => {
    let complete = false;
    const pending = run('Promise.all(jobs)').then(() => { complete = true; });
    for (let round = 0; round < 20; round++) {
      const frames = run('frames.splice(0)');
      for (const frame of frames) frame();
      await tick();
      if (complete && !run('frames.length')) break;
    }
    assert.equal(complete, true, 'UI action settled after queued paint boundaries');
    await pending;
  };
  const confirm = async (ok = true) => {
    await tick();
    assert.equal(document.getElementById('confirm').open, true);
    const body = document.getElementById('confirm-body').textContent;
    document.getElementById(ok ? 'confirm-ok' : 'confirm-cancel').click();
    await settle();
    return body;
  };
  return { window, document, run, json, press, select, settle, confirm,
    writes: () => json("calls.filter(row=>['mail:delete','mail:deleteBatch'].includes(row.channel))") };
}

for (const layout of ['right','bottom','window']) for (const key of ['Delete','Backspace']) {
  test(`${layout}: ${key} reviews and trashes the selection across accounts, excluding the old preview`, async t => {
    const f=fixture(t,layout); f.select('b','c'); f.press(key);
    const body=await f.confirm();
    assert.match(body,/Move 2 messages to Trash/); assert.match(body,/beta@fixture.invalid, alpha@fixture.invalid/);
    assert.deepEqual(f.writes(),[{channel:'mail:deleteBatch',params:{items:[{emailId:'b',accountId:'beta'},{emailId:'c',accountId:'alpha'}]}}]);
    assert.deepEqual(f.json('storeRows.map(row=>[row.id,row.folderId])'),[['a','INBOX'],['b','Trash'],['c','Trash']]);
    assert.equal(f.run('state.email.id'),'a'); assert.deepEqual(f.json('state.selectedIds'),[]);
    assert.deepEqual(f.json('undoItems.map(row=>row.messageId)'),['b','c']);
    f.document.getElementById('undo').click(); await f.confirm();
    assert.deepEqual(f.json('storeRows.map(row=>row.folderId)'),['INBOX','INBOX','INBOX']);
  });
}

test('reader Delete follows one or multiple selected rows and updates its accessible count', async t => {
  const f=fixture(t); const button=()=>f.document.querySelector('#reader [data-action="trash"]');
  assert.equal(button().getAttribute('aria-label'),'Delete');
  f.select('b'); assert.equal(button().getAttribute('aria-label'),'Delete 1 selected message');
  f.select('c'); assert.equal(button().getAttribute('aria-label'),'Delete 2 selected messages');
  button().click(); await f.confirm(); assert.equal(f.writes()[0].params.items.length,2);
  assert.equal(f.run('state.email.id'),'a');assert.equal(button().getAttribute('aria-label'),'Delete');
});

test('Ctrl, Cmd and Shift row selection feed the same reviewed Delete action', async t => {
  for (const modifier of ['ctrlKey','metaKey','shiftKey']) {
    const f=fixture(t);
    if (modifier==='shiftKey') f.select('b');
    else f.document.querySelector('[data-email-id="b"] button.message').dispatchEvent(new f.window.MouseEvent('click',{bubbles:true,[modifier]:true}));
    f.document.querySelector('[data-email-id="c"] button.message').dispatchEvent(new f.window.MouseEvent('click',{bubbles:true,[modifier]:true}));
    assert.deepEqual(f.json('state.selectedIds'),['b','c']);
    f.press();await f.confirm();assert.deepEqual(f.writes()[0].params.items.map(row=>row.emailId),['b','c']);
  }
});

test('Separate-window multiple selection enables Delete while R/A/F retain single-message eligibility', async t => {
  const f=fixture(t,'window');f.select('b','c');
  f.run('globalThis.composes=[];presentCompose=async seed=>composes.push(seed)');
  for (const key of ['r','a','f']) f.press(key);
  await f.settle();assert.deepEqual(f.json('composes'),[]);assert.deepEqual(f.writes(),[]);
  f.press();await f.confirm();assert.equal(f.writes()[0].params.items.length,2);
});

test('one selected message beats an unrelated or absent preview, even during a failed body open', async t => {
  for (const preview of ["state.email=null", "pendingOpenId='failed-open';state.email.bodyError='Unavailable'"]) {
    const f=fixture(t); f.select('b'); f.run(preview); f.press(); await f.confirm();
    assert.deepEqual(f.writes(),[{channel:'mail:delete',params:{emailId:'b',accountId:'beta'}}]);
  }
});

test('row Delete and independent-reader Delete retain their own single-message targets', async t => {
  const row=fixture(t); row.select('b','c');
  row.document.querySelector('[data-email-id="b"] [data-action="delete"]').click(); await row.confirm();
  assert.equal(row.writes()[0].params.emailId,'b'); assert.equal(row.run('storeRows[2].folderId'),'INBOX');
  for (const action of ['button','key']) {
    const f=fixture(t,'window','reader'); f.run("state.selectedIds=['b','c'];renderReader(false)");
    if (action==='button') f.document.querySelector('#reader [data-action="trash"]').click(); else f.press();
    await f.confirm(); assert.equal(f.writes()[0].params.emailId,'a');assert.equal(f.writes()[0].channel,'mail:delete');
  }
});

test('no-selection preview fallback and Separate-window no-selection behavior remain scoped', async t => {
  for (const layout of ['right','bottom','window']) {
    const f=fixture(t,layout); f.press();
    if(layout==='window'){await tick();assert.deepEqual(f.writes(),[]);assert.equal(f.document.getElementById('confirm').open,false)}
    else {await f.confirm();assert.equal(f.writes()[0].params.emailId,'a')}
  }
});

test('Cancel and Escape send no deletion; pending confirmation does not retarget a changed selection', async t => {
  for (const cancel of ['button','escape']) {
    const f=fixture(t); f.select('b','c');f.press();await tick();
    if(cancel==='button')await f.confirm(false);
    else {const dialog=f.document.getElementById('confirm');if(dialog.dispatchEvent(new f.window.Event('cancel',{cancelable:true})))dialog.close();await f.settle()}
    assert.deepEqual(f.writes(),[]);assert.deepEqual(f.json('state.selectedIds'),['b','c']);
  }
  const f=fixture(t);f.select('b','c');f.press();await tick();
  f.run("state.selectedIds=['a'];state.selectionAnchor='a'");
  await f.confirm(); assert.deepEqual(f.writes()[0].params.items.map(row=>row.emailId),['b','c']);
});

test('stale, disconnected and already pending selections fail closed without a preview fallback', async t => {
  for (const setup of ["state.selectedIds=['missing']", "state.selectedIds=['b','missing']", "state.selectedIds=['b'];state.accounts=state.accounts.slice(0,1)", "state.selectedIds=['b'];optimisticRemovals.set('b',{})"]) {
    const f=fixture(t);f.run(setup);f.press();await tick();assert.deepEqual(f.writes(),[]);
    assert.equal(f.document.getElementById('confirm').open,false);
    f.document.querySelector('#reader [data-action="trash"]').click(); await f.settle();
    assert.deepEqual(f.writes(),[]);assert.match(f.document.getElementById('status').textContent,/selected messages are no longer available/);
  }
});

test('typing, selected text, menus, modal, repeat, busy and non-Mail/Outbox guards still block bulk keys', async t => {
  const f=fixture(t);f.select('b','c');
  for (const extra of [{repeat:true},{isComposing:true},{ctrlKey:true},{altKey:true},{shiftKey:true}])f.press('Delete',extra);
  f.press('Backspace',{},f.document.getElementById('list-filter'));
  const editable=f.document.createElement('div');editable.contentEditable='true';editable.setAttribute('contenteditable','true');Object.defineProperty(editable,'isContentEditable',{value:true});f.document.body.append(editable);f.press('Delete',{},editable);
  for (const setup of ["state.busy=true", "state.view='features'", "state.outbox=true", "document.getElementById('mail-view-menu').hidden=false", "document.getElementById('settings').showModal()", "window.getSelection=()=>({isCollapsed:false,toString:()=> 'selected body text'})"]) {
    f.run(setup);f.press();await tick();
    f.run("state.busy=false;state.view='mail';state.outbox=false;document.getElementById('mail-view-menu').hidden=true;document.getElementById('settings').removeAttribute('open');window.getSelection=()=>null;mailShortcutStamp=0");
  }
  await f.settle();assert.deepEqual(f.writes(),[]);assert.equal(f.document.getElementById('confirm').open,false);
});

test('filter-hidden selections stay in the reviewed count; Select All includes only visible loaded rows', async t => {
  const f=fixture(t);f.select('b','c');f.document.getElementById('list-filter').value='Fixture b';f.run('renderList()');
  assert.match(f.document.getElementById('selection-count').textContent,/2 selected · 1 hidden by this filter/);
  f.press();await f.confirm();assert.equal(f.writes()[0].params.items.length,2);
  const g=fixture(t);g.document.getElementById('list-filter').value='Fixture b';g.run('renderList()');g.press('a',{ctrlKey:true});g.press();await g.confirm();
  assert.equal(g.writes()[0].params.emailId,'b');
});

test('conversation review preserves account/folder expansion and freezes IDs before newer members arrive', async t => {
  const f=fixture(t);f.run(`state.prefs.conversation=true;storeRows[1].threadId='same';state.emails[1].threadId='same';
    storeRows.push({id:'earlier',accountId:'beta',folderId:'Sent',threadId:'same'});state.thread=[{...storeRows[1]},{...storeRows[3]}];state.email={...storeRows[1]}`);
  f.select('b');f.press();await tick();
  assert.match(f.document.getElementById('confirm-body').textContent,/Move 2 messages to Trash.*including unselected members in other folders/);
  f.run("storeRows.push({id:'new-arrival',accountId:'beta',folderId:'INBOX',threadId:'same'})");
  await f.confirm();assert.deepEqual(f.writes()[0].params.items.map(row=>row.emailId),['b','earlier']);
  assert.equal(f.run("storeRows.find(row=>row.id==='new-arrival').folderId"),'INBOX');
  assert.equal(f.writes()[0].params.folderWellKnownName,undefined);
});

test('accepted bulk deletion keeps confirmed-only Undo and restores failed rows after settlement', async t => {
  const f=fixture(t);f.select('b','c');f.run("delivery='accepted'");f.press();await f.confirm();
  assert.equal(f.run('undoOpIds'),null);assert.match(f.document.getElementById('status').textContent,/2 awaiting confirmation/);
  f.run(`storeRows[1].folderId='Trash';applyActionSettlement({outcomes:[
    {id:'b',kind:'remove',generation:1,status:'completed',opId:'op-b'},
    {id:'c',kind:'remove',generation:1,status:'failed',error:'Synthetic rejection',projection:{folderId:'INBOX',unread:false,isStarred:false}}
  ],opIds:['op-b']})`);await tick();
  assert.deepEqual(f.json('undoOpIds'),['op-b']);assert.deepEqual(f.json('shownEmails().map(row=>row.id)'),['a','c']);
  assert.match(f.document.getElementById('status').textContent,/1 completed.*1 failed/);
  const lost=fixture(t);lost.select('b','c');lost.run("delivery='lost'");lost.press();await lost.confirm();
  assert.equal(lost.run('undoOpIds'),null);assert.equal(lost.writes().length,1);assert.match(lost.document.getElementById('status').textContent,/2 unknown.*Refresh before retrying/);
});

test('rendered Features, Shortcuts and list help describe selection Delete and separate reader scope', t => {
  const f=fixture(t);f.run('paintFeatureCatalog();paintShortcuts()');
  assert.match(f.document.getElementById('features-catalog').textContent,/Delete and Backspace.*selected messages to Trash/);
  assert.match(f.document.getElementById('shortcuts-note').textContent,/including selected rows hidden by a filter/);
  assert.match(f.document.getElementById('shortcuts-note').textContent,/Independent readers keep their own message/);
  assert.match(f.document.getElementById('shortcuts-note').textContent,/exactly one visible message/);
  assert.match(f.document.getElementById('mail-view-help').textContent,/Delete.*selected messages/);
});
