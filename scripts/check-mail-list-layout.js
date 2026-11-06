// Synthetic renderer/preload/settings and real paged database; no provider traffic.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { renderer } = require('./check-ux-workflows');
const columns = require('../shared/mail-columns');
const fixture = require('./mail-performance-fixture');
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };
function uiFixture(t) {
  const dom = new JSDOM(fs.readFileSync(require.resolve('../renderer/index.html'),'utf8'),{url:'https://fixture.invalid'});
  const window = dom.window, document = window.document; t.after(()=>window.close());
  window.morrowMailColumns=columns;
  const saved=[]; window.morrow={invoke:async(channel,payload)=>{saved.push({channel,payload});return payload},on(){}};
  for(const d of document.querySelectorAll('dialog')) { d.showModal=()=>{d.open=true};d.close=()=>{d.open=false;d.dispatchEvent(new window.Event('close'))}; }
  const ui=renderer({window,document,localStorage:window.localStorage,Event:window.Event,Node:window.Node});
  ui.run("renderList=()=>paintMailListColumns($('message-list'));globalThis.sortCalls=[];changeMailListSort=async key=>sortCalls.push(key);paintMailListColumns($('message-list'));wireMailColumnEditor();");
  return {ui,window,document,saved,get:id=>document.getElementById(id)};
}
test('column normalization upgrades missing/new columns and rejects unknown/duplicate entries',()=>{
  assert.deepEqual(columns.normalize(['subject','subject','obsolete','date']),['subject','date','time','recipient','sender']);
  assert.deepEqual(columns.normalize(null),columns.defaults);
  assert.deepEqual(columns.move(columns.defaults,'date','subject',true),['time','recipient','sender','subject','date']);
  assert.deepEqual(columns.move(columns.defaults,'unknown','subject'),columns.defaults);
  assert.deepEqual(columns.normalize(['status','subject','date','status']),['subject','date','time','recipient','sender']);
  assert.deepEqual(columns.normalize(['sender','date','subject','recipient']),['sender','date','time','subject','recipient']);
  assert.deepEqual(columns.normalize(['time','subject','date','recipient','sender']),['time','subject','date','recipient','sender']);
  assert.deepEqual(columns.normalizeHidden(['time','time','subject','status']),['time']);
  assert.deepEqual(columns.normalizeHidden(['status','sender']),['sender']);
});
test('actual preload/settings persist order independently of sorting and other preferences',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'morrow-layout-')),old=process.env.MORROW_USER_DATA;process.env.MORROW_USER_DATA=dir;
  t.after(()=>{if(old===undefined)delete process.env.MORROW_USER_DATA;else process.env.MORROW_USER_DATA=old;fs.rmSync(dir,{recursive:true,force:true})});
  const settings=require('../host/settings');let bridge;
  vm.runInNewContext(fs.readFileSync(require.resolve('../renderer/preload'),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld:(name,value)=>{if(name==='morrow')bridge=value}},ipcRenderer:{invoke:async(channel,payload)=>settings.answer(channel,[payload])}})});
  await bridge.invoke('config:setTheme','dark');
  await bridge.invoke('morrow:configSetMailColumnOrder',['subject','date','recipient']);
  assert.deepEqual(await bridge.invoke('morrow:configGetMailColumnOrder'),['subject','date','time','recipient','sender']);
  assert.equal(settings.answer('config:getTheme'),'dark');
  await bridge.invoke('morrow:configSetMailHiddenColumns',['date','date','subject','unknown','status']);
  assert.deepEqual(await bridge.invoke('morrow:configGetMailHiddenColumns'),['date']);
  await bridge.invoke('morrow:configSetMailHiddenColumns',['time','sender']);
  assert.deepEqual(await bridge.invoke('morrow:configGetMailHiddenColumns'),['time','sender']);
  assert.deepEqual(columns.visible(['subject','date'],columns.defaults),['subject']);
  await assert.rejects(bridge.invoke('unknown:layout'),/Unsupported/);
});
test('keyboard and dialog movement reorder headers and cells without sorting; reset restores defaults',async t=>{
  const f=uiFixture(t);const subject=f.document.querySelector('[data-sort-key="subject"] button');
  subject.dispatchEvent(new f.window.KeyboardEvent('keydown',{key:'ArrowLeft',altKey:true,bubbles:true,cancelable:true}));await settle();
  assert.deepEqual(Array.from(f.ui.run('mailColumnOrder()')),['date','time','recipient','subject','sender']);
  assert.equal(f.ui.run('sortCalls.length'),0);
  const row=f.ui.run("messageRow({id:'one',subject:'Hello',from:'a@fixture.invalid',to:['b@fixture.invalid']})");
  assert.deepEqual([...row.querySelector('.row-main').children].slice(0,5).map(n=>n.dataset.mailColumn),['date','time','recipient','subject','sender']);
  f.get('mail-columns-open').click();f.document.querySelector('[data-column="date"][data-direction="1"]').click();await settle();
  assert.deepEqual(Array.from(f.ui.run('mailColumnOrder()')),['time','date','recipient','subject','sender']);
  f.get('mail-columns-reset').click();await settle();assert.deepEqual(Array.from(f.ui.run('mailColumnOrder()')),columns.defaults);
  assert.equal(f.saved.filter(r=>r.channel==='morrow:configSetMailColumnOrder').length,3);
});
test('drag cancellation, foreign drops and Escape do not save or sort; successful drop saves once',async t=>{
  const f=uiFixture(t),source=f.document.querySelector('[data-sort-key="date"] button'),target=f.document.querySelector('[data-sort-key="subject"]');
  const data=new Map(),transfer={setData:(k,v)=>data.set(k,v),getData:k=>data.get(k)||''};
  const event=(type,extra={})=>{const e=new f.window.Event(type,{bubbles:true,cancelable:true});Object.assign(e,{dataTransfer:transfer,clientX:50,...extra});return e};
  source.dispatchEvent(event('dragstart'));source.dispatchEvent(event('dragend'));source.click();await settle();
  assert.equal(f.saved.length,0);assert.equal(f.ui.run('sortCalls.length'),0);
  target.dispatchEvent(event('drop'));assert.equal(f.saved.length,0);
  source.dispatchEvent(event('dragstart'));f.document.dispatchEvent(new f.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));target.dispatchEvent(event('drop'));assert.equal(f.saved.length,0);
  source.dispatchEvent(event('dragstart'));target.dispatchEvent(event('drop'));source.click();await settle();
  assert.deepEqual(Array.from(f.ui.run('mailColumnOrder()')),['time','recipient','sender','subject','date']);
  assert.equal(f.saved.filter(r=>r.channel==='morrow:configSetMailColumnOrder').length,1);assert.equal(f.ui.run('sortCalls.length'),0);
});
test('sidebar flag rows replace Inbox chip; counts, selection and invalidation use aggregate scope',async t=>{
  const f=uiFixture(t);
  f.ui.run(`state.accounts=[{id:'a',folders:{primary:[{id:'__morrow_unread__',type:'virtual',view:{unread:true},totalCount:3},{id:'__morrow_starred__',type:'virtual',view:{flagged:true},totalCount:2}],more:[]}},{id:'b',folders:{primary:[{id:'__morrow_unread__',type:'virtual',view:{unread:true},totalCount:4},{id:'__morrow_starred__',type:'virtual',view:{flagged:true},totalCount:5}],more:[]}}];
    globalThis.nav=document.createElement('div');nav.append(allAccountInboxRow(),allAccountFlagRow('starred'),allAccountFlagRow('unread'));document.body.append(nav);
    globalThis.selected=null;selectAllInbox=async (unread,starred)=>{selected={unread,starred}};globalThis.reloads=0;scheduleReload=()=>{reloads++};`);
  assert.equal(f.document.querySelector('.all-account-inbox .count'),null);
  assert.equal(f.document.querySelector('.all-unread .count').textContent,'7');assert.equal(f.document.querySelector('.all-starred .count').textContent,'7');
  f.document.querySelector('.all-starred').click();assert.equal(f.ui.run('selected.starred'),true);
  f.ui.run("state.allInbox=true;state.allInboxStarredOnly=true;state.view='mail';onEmailsUpdated({accountId:'b',folderId:'Archive'})");assert.equal(f.ui.run('reloads'),1);
  f.ui.run("state.accounts[1].folders.primary[1].totalCount=0;applyAllAccountMailChrome(nav)");assert.equal(f.document.querySelector('.all-starred .count').textContent,'2');
  f.ui.run("state.emails=[{id:'a1',accountId:'a',isStarred:true},{id:'b1',accountId:'b',isStarred:false}]");assert.deepEqual(Array.from(f.ui.run('shownEmails().map(row=>row.id)')),['a1']);
  f.ui.run("state.emails[0].isStarred=false");assert.equal(f.ui.run('shownEmails().length'),0);
});
test('host aggregate lists match per-account flags and counts, with bounded pages and account-specific exclusions',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'morrow-aggregate-')),old={...process.env};
  Object.assign(process.env,{MORROW_MAIL_DIR:dir,MORROW_USER_DATA:dir,MORROW_MAIL_SECRETS:'memory'});
  const db=require('../host/mail/db'),engine=require('../host/mail/engine');
  t.after(async()=>{await db.close();for(const key of ['MORROW_MAIL_DIR','MORROW_USER_DATA','MORROW_MAIL_SECRETS']){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key]}fs.rmSync(dir,{recursive:true,force:true})});
  await engine.init();
  const ask=async params=>{const result=await engine.answer('mail:listFromCache',[params]);assert.equal(result.success,true,JSON.stringify(result));return result.data};
  for(const id of ['a','b']){
    db.insertAccount({...fixture.account,id,email:id+'@fixture.invalid'});
    db.replaceFolders(id,[...fixture.folders,{path:'Notes',name:'Notes'},{path:'Shared',name:'Shared',wellKnown:id==='a'?'deleteditems':null},{path:'Drafts',name:'Drafts',wellKnown:'drafts'},{path:'Spam',name:'Spam',wellKnown:'junkemail'}]);
    for(const folder of ['INBOX','Sent','Notes','Shared','Drafts','Spam','Orphan','__search__']) db.applyFolderSync(id,folder,fixture.report(Array.from({length:81},(_,n)=>fixture.message(n+1,{id:`${id}-${folder}-${n}`,threadId:`${id}-${folder}-${n}`,unread:n%2===0,starred:n%3===0}))));
  }
  db.setSnooze('a','a-INBOX-0',new Date(Date.now()+3600000).toISOString());
  for(const kind of ['starred','unread']){
    const folderId=kind==='starred'?'__morrow_starred__':'__morrow_unread__';
    const expected=(await Promise.all(['a','b'].map(accountId=>ask({accountId,folderId,limit:2000})))).flatMap(r=>r.emails).map(r=>r.id).sort();
    const scoped=await ask({aggregateView:kind,accountId:'a',limit:2000});assert.ok(scoped.emails.every(row=>row.accountId==='a'));assert.equal(scoped.total,expected.filter(id=>id.startsWith('a-')).length);
    const actual=[];
    for(let offset=0;offset<expected.length;offset+=37){const result=await ask({aggregateView:kind,limit:37,offset,sortBy:'subject',sortDirection:'asc'});assert.equal(result.total,expected.length);assert.ok(result.emails.length<=37);actual.push(...result.emails.map(r=>r.id));}
    assert.deepEqual(actual.sort(),expected);
    if(kind==='unread'){assert.ok(!actual.includes('a-Shared-0'));assert.ok(actual.includes('b-Shared-0'));assert.ok(actual.includes('b-Orphan-0'));assert.ok(!actual.includes('a-INBOX-0'));}
    const accounts=(await engine.answer('mail:listAccounts',[])).data;
    const count=accounts.reduce((sum,a)=>sum+a.folders.primary.find(f=>f.id===folderId).totalCount,0);assert.equal(count,expected.length);
  }
  const before=await ask({aggregateView:'starred',limit:20});db.updateMessage('a-Notes-0',{starred:0});const after=await ask({aggregateView:'starred',limit:20});assert.equal(after.total,before.total-1);
  const unread=await ask({aggregateView:'unread',limit:20});db.updateMessage('b-Notes-0',{unread:0});const read=await ask({aggregateView:'unread',limit:20});assert.equal(read.total,unread.total-1);
  const held=await ask({aggregateView:'unread',retainIds:['b-Notes-0'],limit:2000});assert.ok(held.emails.some(r=>r.id==='b-Notes-0'));assert.equal(held.total,read.total+1);
});
test('repainting an unchanged header preserves keyboard focus and pending load cannot overwrite an edit',async t=>{
  const f=uiFixture(t),button=f.document.querySelector('[data-sort-key="subject"] button');button.focus();f.ui.run("paintMailListColumns($('message-list'))");assert.equal(f.document.activeElement,button);
  let finish;f.window.morrow.invoke=async channel=>channel==='morrow:configGetMailColumnOrder'?new Promise(resolve=>{finish=resolve}):null;
  const read=f.ui.run('loadMailColumnOrder()');await f.ui.run("changeMailColumnOrder(['subject','sender','date','recipient'])");finish(['date','recipient','sender','subject']);await read;
  assert.deepEqual(Array.from(f.ui.run('mailColumnOrder()')),['subject','sender','date','time','recipient']);
});
test('header menu and dialog share visibility without changing sorting or full order; keyboard closes and restores focus',async t=>{
  const f=uiFixture(t),subject=f.document.querySelector('[data-sort-key="subject"] button');
  const before=JSON.stringify(f.ui.run('state.listSort'));
  subject.dispatchEvent(new f.window.MouseEvent('contextmenu',{clientX:100,clientY:120,bubbles:true,cancelable:true}));
  const menu=f.get('mail-column-menu');assert.equal(menu.hidden,false);
  assert.equal(menu.getAttribute('role'),'menu');assert.equal(menu.querySelector('[data-column="date"]').getAttribute('aria-checked'),'true');
  menu.querySelector('[data-column="date"]').click();await settle();
  assert.equal(f.document.querySelector('[data-sort-key="date"]').hidden,true);
  assert.equal(menu.querySelector('[data-column="date"]').getAttribute('aria-checked'),'false');
  menu.querySelector('[data-column="time"]').click();await settle();
  assert.equal(f.document.querySelector('[data-sort-key="time"]').hidden,true);
  assert.equal(menu.querySelector('[data-column="time"]').getAttribute('aria-checked'),'false');
  assert.equal(f.saved.at(-1).channel,'morrow:configSetMailHiddenColumns');
  assert.deepEqual(Array.from(f.saved.at(-1).payload),['date','time']);
  assert.equal(JSON.stringify(f.ui.run('state.listSort')),before);assert.deepEqual(Array.from(f.ui.run('mailColumnOrder()')),columns.defaults);
  const rendered=f.ui.run("messageRow({id:'hidden',subject:'Subject'})");assert.equal(rendered.querySelector('[data-mail-column="date"]'),null);
  menu.dispatchEvent(new f.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal(menu.hidden,true);assert.equal(f.document.activeElement,subject);
  subject.dispatchEvent(new f.window.KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true}));assert.equal(menu.hidden,false);
  f.document.dispatchEvent(new f.window.Event('pointerdown',{bubbles:true}));assert.equal(menu.hidden,true);
  f.get('mail-columns-open').click();const date=f.document.querySelector('[data-visibility="date"]');assert.equal(date.checked,false);date.click();await settle();
  const time=f.document.querySelector('[data-visibility="time"]');assert.equal(time.checked,false);time.click();await settle();
  assert.equal(f.document.querySelector('[data-sort-key="time"]').hidden,false);
  assert.equal(f.document.querySelector('[data-sort-key="date"]').hidden,false);
  assert.equal(f.document.querySelector('[data-visibility="subject"]').disabled,true);
  await f.ui.run("changeMailColumnVisibility('sender',false)");f.get('mail-columns-reset').click();await settle();
  assert.equal(f.document.querySelector('[data-sort-key="sender"]').hidden,true,'reset order keeps hidden choices');
  f.get('mail-columns-show-all').click();await settle();assert.deepEqual(Array.from(f.ui.run('visibleMailColumns()')),columns.defaults);
  assert.equal(f.ui.run('sortCalls.length'),0);
});
test('subject prefix icons only describe explicit positive flags, with no status column or visibility control',async t=>{
  const f=uiFixture(t);
  for(const [replied,forwarded,count] of [[true,false,1],[false,true,1],[true,true,2],[false,false,0],[null,null,0]]){
    f.ui.context.email={id:'status',subject:'Re: Fwd: subject',inReplyTo:'parent',replied,forwarded};
    const cell=f.ui.run('mailReplyForwardCell(email)');assert.equal(cell.querySelectorAll('svg').length,count);
    assert.equal(cell.hidden,count===0);
    if(count)assert.match(cell.textContent,/saved evidence/);
    const row=f.ui.run('messageRow(email)');
    assert.equal(row.querySelector('[data-mail-column="subject"]').firstElementChild.className,'mail-reply-forward');
    assert.equal(row.querySelector('[data-mail-column="status"]'),null);
    for(const icon of cell.querySelectorAll('svg'))assert.equal(icon.getAttribute('aria-hidden'),'true');
  }
  assert.equal(f.document.querySelector('[data-sort-key="status"]'),null);
  f.get('mail-columns-open').click();
  assert.equal(f.document.querySelector('[data-visibility="status"]'),null);
  assert.equal(f.ui.run('sortCalls.length'),0);
});
test('a failed visibility save is visible and queued later writes can recover; a late settings read cannot undo visibility edits',async t=>{
  const f=uiFixture(t);let finish;
  f.window.morrow.invoke=async channel=>channel==='morrow:configGetMailHiddenColumns'?new Promise(resolve=>{finish=resolve}):null;
  const read=f.ui.run('loadMailColumnOrder()');await f.ui.run("changeMailColumnVisibility('sender',false)");finish([]);await read;
  assert.equal(f.ui.run("visibleMailColumns().includes('sender')"),false);
  f.window.morrow.invoke=async()=>{throw new Error('synthetic settings failure')};
  await assert.rejects(f.ui.run("changeMailColumnVisibility('date',false)"));await settle();assert.match(f.get('mail-columns-status').textContent,/Could not save/);
  f.window.morrow.invoke=async()=>null;await f.ui.run("changeMailColumnVisibility('date',true)");assert.equal(f.ui.run("visibleMailColumns().includes('date')"),true);
});
test('switching aggregate filters fences a late starred page and keeps unread selection',async t=>{
  const f=uiFixture(t);
  f.ui.run(`state.accounts=[{id:'a',email:'a@fixture.invalid',folders:{primary:[{id:'INBOX',wellKnownName:'inbox'}],more:[]}}];state.accountId='a';state.folderId='INBOX';state.view='mail';
    renderAccounts=()=>{};syncRemove=()=>{};renderReader=()=>{};noteMailListLoaded=()=>{};globalThis.requests=[];
    call=(channel,params)=>new Promise(resolve=>requests.push({channel,params,resolve}));`);
  const star=f.ui.run('selectAllInbox(false,true)');const unread=f.ui.run('selectAllInbox(true,false)');
  assert.equal(f.ui.run('requests[0].params.aggregateView'),'starred');assert.equal(f.ui.run('requests[1].params.aggregateView'),'unread');
  f.ui.run("requests[1].resolve({emails:[{id:'unread',accountId:'a',unread:true}],total:1})");await unread;
  f.ui.run("requests[0].resolve({emails:[{id:'starred',accountId:'a',isStarred:true}],total:1})");await star;
  assert.equal(f.ui.run('state.emails[0].id'),'unread');assert.equal(f.ui.run('state.allInboxUnreadOnly'),true);
});
test('failed star/read writes restore aggregate membership without clearing another selection',async t=>{
  const f=uiFixture(t);f.ui.run(`state.allInbox=true;state.allInboxStarredOnly=true;state.selectedIds=['other'];
    state.emails=[{id:'one',accountId:'a',isStarred:true,unread:true}];call=async()=>{throw new Error('synthetic refusal')};`);
  await assert.rejects(f.ui.run('toggleStar(state.emails[0])'),/synthetic refusal/);
  assert.equal(f.ui.run('shownEmails().length'),1);assert.deepEqual(Array.from(f.ui.run('state.selectedIds')),['other']);
  f.ui.run('state.allInboxStarredOnly=false;state.allInboxUnreadOnly=true');
  await assert.rejects(f.ui.run('setRead(state.emails[0],true)'),/synthetic refusal/);
  assert.equal(f.ui.run('shownEmails().length'),1);
});


test('keyboard moves choose visible neighbors while retaining hidden-column order', async t => {
  const f=uiFixture(t);
  f.ui.run("state.mailColumnOrder=['date','recipient','sender','subject'];state.mailHiddenColumns=['recipient'];renderList()");
  f.document.querySelector('[data-sort-key="sender"] button').dispatchEvent(new f.window.KeyboardEvent('keydown',{key:'ArrowRight',altKey:true,bubbles:true,cancelable:true}));
  await settle();
  assert.deepEqual(Array.from(f.ui.run('mailColumnOrder()')),['date','time','recipient','subject','sender']);
  assert.deepEqual(Array.from(f.ui.run('state.mailHiddenColumns')),['recipient']);
  f.document.querySelector('[data-sort-key="sender"] button').dispatchEvent(new f.window.KeyboardEvent('keydown',{key:'ArrowLeft',altKey:true,bubbles:true,cancelable:true}));
  await settle();
  assert.deepEqual(Array.from(f.ui.run('mailColumnOrder()')),columns.defaults);
  await f.ui.run("changeMailColumnVisibility('recipient',true)");
  assert.deepEqual(Array.from(f.ui.run('visibleMailColumns()')),columns.defaults);
  assert.equal(f.ui.run('sortCalls.length'),0);
});
