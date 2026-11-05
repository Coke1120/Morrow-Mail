// Synthetic renderer/browser verification. Install Playwright and axe outside the checkout if desired.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || 'playwright');
const fs=require('fs'),http=require('http'),path=require('path'),assert=require('assert/strict');
const root=path.join(__dirname,'..'),output=process.env.MORROW_UI_OUTPUT||path.join(require('os').tmpdir(),'morrow-mail-layout');
(async()=>{
 const server=http.createServer((req,res)=>{
  if(req.url==='/favicon.ico'){res.writeHead(204).end();return}
  if(req.url==='/axe.js'){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(require.resolve(process.env.MORROW_AXE_MODULE||'axe-core/axe.min.js')))}
  const target=path.join(root,decodeURI(req.url.split('?')[0]));if(!target.startsWith(root+path.sep)){res.writeHead(403).end();return}
  try{let data=fs.readFileSync(target);if(target.endsWith('/renderer/app.js'))data=data.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/,'');res.setHeader('Content-Type',target.endsWith('.js')?'text/javascript':target.endsWith('.css')?'text/css':target.endsWith('.svg')?'image/svg+xml':target.endsWith('.png')?'image/png':'text/html');res.end(data)}catch{res.writeHead(404).end()}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:process.env.MORROW_CHROMIUM||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:960},hasTouch:true}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('console',message=>{if(['error','warning'].includes(message.type()))errors.push(message.type()+': '+message.text())});
  await page.addInitScript(()=>{window.popouts=[];window.morrow={on(){},openReaderWindow:async seed=>{window.popouts.push(seed)},invoke:async(channel,value)=>{
   if(channel==='morrow:configGetMailColumnOrder')return JSON.parse(localStorage.getItem('synthetic.columns')||'null');
   if(channel==='morrow:configSetMailColumnOrder'){localStorage.setItem('synthetic.columns',JSON.stringify(value));return value}
   if(channel==='morrow:configGetMailHiddenColumns')return JSON.parse(localStorage.getItem('synthetic.hidden')||'null');
   if(channel==='morrow:configSetMailHiddenColumns'){localStorage.setItem('synthetic.hidden',JSON.stringify(value));return value}
   if(channel==='morrow:configGetMailView')return JSON.parse(localStorage.getItem('synthetic.view')||'null');
   if(channel==='morrow:configSetMailView'){localStorage.setItem('synthetic.view',JSON.stringify(value));return value}return null;
  }}});
  const url=`http://127.0.0.1:${server.address().port}/renderer/index.html`;
  async function initialize(){await page.evaluate(async()=>{
   document.documentElement.style.setProperty('--list','760px');document.documentElement.style.setProperty('--folders','220px');setNavCollapsed(true);
   state.view='mail';state.accountId='a';state.folderId='INBOX';state.listSyncDone=true;document.documentElement.dataset.view='mail';
   globalThis.fixtureRows=Array.from({length:450},(_,n)=>({id:'row-'+n,accountId:n%2?'b':'a',folderId:n%5?'INBOX':'Archive',subject:'Project '+String(n).padStart(3,'0'),from:`Sender ${n}@fixture.invalid`,to:[`team${n%7}@fixture.invalid`],date:new Date(1793577600000-n*3600000).toISOString(),unread:n%3===0,isStarred:n%4===0,snippet:'Synthetic mail for UI verification.',threadId:'thread-'+n}));
   globalThis.publishFixtureAccounts=()=>{
    state.accounts=['a','b'].map(id=>({id,email:id+'@fixture.invalid',name:'Synthetic '+id,platform:'imap',imapSmtpProfile:'custom',folders:{primary:[
     {id:'INBOX',name:'Inbox',wellKnownName:'inbox',unreadCount:fixtureRows.filter(r=>r.accountId===id&&r.folderId==='INBOX'&&r.unread).length},
     {id:'__morrow_starred__',name:'Starred',wellKnownName:'starred',type:'virtual',view:{flagged:true},totalCount:fixtureRows.filter(r=>r.accountId===id&&r.isStarred).length},
     {id:'__morrow_unread__',name:'Unread',wellKnownName:'unread',type:'virtual',view:{unread:true},totalCount:fixtureRows.filter(r=>r.accountId===id&&r.unread).length}],more:[{id:'Archive',name:'Archive'}]}}));
   };publishFixtureAccounts();globalThis.requests=[];
   call=async(channel,p={})=>{
    requests.push({channel,params:p});
    if(channel==='mail:openEmail')return {email:{...fixtureRows.find(row=>row.id===p.emailId),unread:false,textBody:'Synthetic message body for preview layout verification. No real mailbox data.'},threadMessages:[]};
    if(channel==='mail:searchLocal')return fixtureRows.filter(row=>(!p.accountId||row.accountId===p.accountId)&&row.subject.includes(p.query)).slice(0,p.limit||100);
    if(channel==='mail:listAccounts'){publishFixtureAccounts();return state.accounts}
    if(channel==='mail:toggleStar'||channel==='mail:markRead'){
     const row=fixtureRows.find(r=>r.id===p.emailId&&r.accountId===p.accountId);if(!row)throw new Error('Wrong mailbox');
     if(channel==='mail:toggleStar')row.isStarred=p.isStarred;else row.unread=!p.isRead;
     publishFixtureAccounts();queueMicrotask(()=>onAccountsUpdated({accounts:state.accounts}));return {outcomes:[{id:row.id,status:'completed'}]};
    }
    if(channel==='mail:listFromCache'){
     let rows=fixtureRows.filter(r=>p.aggregateView==='starred'?r.isStarred:p.aggregateView==='unread'?r.unread:p.accountId?r.accountId===p.accountId&&r.folderId===p.folderId:r.folderId==='INBOX');
     const key=r=>p.sortBy==='subject'?r.subject:p.sortBy==='sender'?r.from:p.sortBy==='recipient'?r.to[0]:r.date;
     rows.sort((a,b)=>(key(a)<key(b)?-1:key(a)>key(b)?1:a.id.localeCompare(b.id))*(p.sortDirection==='asc'?1:-1));
     return {emails:rows.slice(p.offset||0,(p.offset||0)+(p.limit||200)),total:rows.length,initialSyncDone:true};
    }return [];
   };
   offerChangelog=async()=>{};refreshMailVacation=()=>{document.getElementById("mail-ooo").hidden=true};await loadMailColumnOrder();await loadMailView();wireMailColumnEditor();wireMailView();wireSplits();renderAccounts();await loadList(false,0);document.getElementById('mail-ooo').hidden=true;
  })}
  await page.goto(url);await initialize();
  await page.evaluate(()=>changeMailColumnVisibility('recipient',false));
  await page.locator('[data-sort-key="sender"] button').focus();await page.keyboard.press('Alt+ArrowRight');
  assert.deepEqual(await page.evaluate(()=>mailColumnOrder()),['date','recipient','subject','sender']);
  await page.keyboard.press('Alt+ArrowLeft');
  await page.evaluate(()=>changeMailColumnVisibility('recipient',true));
  assert.deepEqual(await page.evaluate(()=>mailColumnOrder()),['date','recipient','sender','subject']);
  const outerCorners=await verifyOuterMailCardCorners(page);
  const folderChips=await verifyFolderChipAlignment(page);
  console.log(JSON.stringify({folderChips}));
  await page.reload();await initialize();
  await page.locator('[data-sort-key="date"] button').dragTo(page.locator('[data-sort-key="subject"]'),{targetPosition:{x:150,y:12}});
  await page.waitForFunction(()=>mailColumnOrder()[0]!=='date');
  const dragged=await page.evaluate(()=>mailColumnOrder());assert.equal(dragged.length,4);
  assert.equal(await page.evaluate(()=>state.listSort.sortBy),'date');
  await page.waitForTimeout(350);await page.locator('[data-sort-key="subject"] button').click();
  await page.waitForFunction(()=>state.listSort.sortBy==='subject');assert.deepEqual(await page.evaluate(()=>mailColumnOrder()),dragged);
  await page.reload();await initialize();assert.deepEqual(await page.evaluate(()=>mailColumnOrder()),dragged);
  const beforeKeyboard=await page.evaluate(()=>mailColumnOrder());await page.locator(`[data-sort-key="${beforeKeyboard[1]}"] button`).press('Alt+ArrowLeft');assert.equal(await page.evaluate(()=>mailColumnOrder()[0]),beforeKeyboard[1]);
  await page.locator('#mail-columns-open').click();await page.locator('#mail-columns[open]').waitFor();
  await page.addScriptTag({url:'/axe.js'});
  const violations=await page.evaluate(async()=> (await axe.run(document.getElementById('mail-columns'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa']}})).violations.map(v=>v.id));assert.deepEqual(violations,[]);
  await page.getByRole('button',{name:'Reset column order',exact:true}).click();assert.deepEqual(await page.evaluate(()=>mailColumnOrder()),['date','recipient','sender','subject']);
  await page.getByRole('button',{name:'Move right: Date',exact:true}).click();assert.equal(await page.evaluate(()=>mailColumnOrder()[1]),'date');
  await page.locator('#mail-columns-close').click();await page.locator('#mail-columns').waitFor({state:'hidden'});
  const align=await page.evaluate(()=>({head:[...document.querySelectorAll('.mail-list-columns [role="columnheader"]')].map(n=>n.getBoundingClientRect().x),row:[...document.querySelector('.row-main').children].slice(0,4).map(n=>n.getBoundingClientRect().x)}));assert.ok(align.head.every((x,i)=>Math.abs(x-align.row[i])<2),JSON.stringify(align));
  assert.equal(await page.locator('.all-account-inbox .count').count(),0);assert.ok(await page.locator('button.folder[data-account-id="a"] .count').count()>0);
  await page.locator('.all-starred').click();await page.waitForFunction(()=>state.allInboxStarredOnly&&state.emails.every(r=>r.isStarred));
  const stars=await page.evaluate(()=>state.listTotal);await page.evaluate(()=>toggleStar(state.emails[0]));await page.waitForFunction(n=>state.listTotal===n-1,stars);
  await page.locator('.all-unread').click();await page.waitForFunction(()=>state.allInboxUnreadOnly&&state.emails.every(r=>r.unread));
  const unread=await page.evaluate(()=>state.listTotal);await page.evaluate(()=>setRead(state.emails[0],true));await page.waitForFunction(n=>state.listTotal===n-1,unread);
  assert.equal(Number(await page.locator('.all-unread .count').textContent()),unread-1);
  assert.equal(await page.locator('.all-unread').getAttribute('aria-current'),'true');assert.equal(await page.locator('.all-inbox').getAttribute('aria-current'),null);
  fs.mkdirSync(output,{recursive:true});await page.mouse.move(1400,920);await page.screenshot({path:path.join(output,'wide.png')});
  await page.setViewportSize({width:900,height:700});await page.evaluate(()=>document.documentElement.style.setProperty('--list','360px'));await page.screenshot({path:path.join(output,'narrow.png')});
  assert.ok(await page.evaluate(()=>{const n=document.getElementById('message-list');return n.scrollWidth>n.clientWidth}));
  await verifyReadingLayouts(page);
  await page.reload();await initialize();assert.equal(await page.evaluate(()=>state.prefs.mailView.layout),'window');
  const columns=await verifyColumnControls(page,initialize);
  const notificationRoute=await page.evaluate(async()=>{
    await saveMailView({layout:'window',listHeight:320});notificationShellReady=true;
    const original=call,beforeReaders=popouts.length,beforeOpens=requests.filter(row=>row.channel==='mail:openEmail'||row.channel==='mail:markRead').length;
    call=async(channel,payload)=>channel==='mail:takeNotificationTarget'?{accountId:'b',folderId:'INBOX',messageId:'row-1'}:original(channel,payload);
    try {await onMailNotificationClick()} finally {call=original}
    return {newReaders:popouts.length-beforeReaders,target:popouts.at(-1),previewReads:requests.filter(row=>row.channel==='mail:openEmail'||row.channel==='mail:markRead').length-beforeOpens};
  });
  assert.deepEqual(notificationRoute,{newReaders:1,target:{accountId:'b',messageId:'row-1'},previewReads:0});
  assert.equal(await page.locator('#reader').isVisible(),false);
  await page.evaluate(()=>showFeatures());assert.match(await page.locator('#features-catalog').textContent(),/Drag headers to reorder columns independently of sorting/);
  assert.match(await page.locator('#features-catalog').textContent(),/View, beside Search downloaded mail/);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'passed',url,title:await page.title(),checks:'drag, sort, reload persistence, keyboard/dialog/reset, aligned cells, aggregate flags and live counts, Inbox chip removal, whole All Mail card top corners with negative control, right/bottom/window layouts, splitter keyboard and pointer, selection/search/scroll retention, double-click and keyboard popout, narrow/mobile/light/dark/reduced-motion, rendered Features, status flags, visibility menu/restart, Sync stacking with negative control, hidden-column keyboard order, visible notification popout, axe',outerCorners,columns,output}));
 }finally{await browser.close();server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});

async function verifyFolderChipAlignment(page) {
 const geometry=[];
 await page.evaluate(()=>{
  state.query='';state.searchAccountId='';state.allInbox=false;state.outbox=false;
  state.allInboxUnreadOnly=false;state.allInboxStarredOnly=false;state.accountId='a';
  state.prefs.chips=true;state.email=null;state.thread=[];state.selectedIds=[];state.selectionAnchor='';
  state.emails=fixtureRows.filter(row=>row.accountId==='a').slice(0,20);state.listTotal=20;
  globalThis.chipFixtureFolders=[
   {id:'All Mail',name:'All Mail',wellKnownName:'all',chip:false},
   {id:'INBOX',name:'Inbox',wellKnownName:'inbox',chip:true},
   {id:'Sent',name:'Sent',wellKnownName:'sentitems',chip:true},
   {id:'Drafts',name:'Drafts',wellKnownName:'drafts',chip:true},
   {id:'Unread',name:'Unread',wellKnownName:'unread',chip:true,view:{unread:true},type:'virtual'},
  ];
  state.accounts[0].folders={primary:chipFixtureFolders,more:[]};
 });
 fs.mkdirSync(output,{recursive:true});
 await page.mouse.move(0,0);
 for(const theme of ['light','dark'])for(const width of [1440,900,440]){
  await page.setViewportSize({width,height:960});
  await page.emulateMedia({reducedMotion:'reduce'});
  let firstLeft;
  for(const folderId of ['INBOX','Sent','All Mail']){
   await page.evaluate(({theme,folderId})=>{applyShellTheme(document.documentElement,theme,'#193C34');state.folderId=folderId;renderAccounts();renderList();},{theme,folderId});
   const row=await folderChipBounds(page);
   geometry.push({theme,width,folderId,...row});
   await page.screenshot({path:path.join(output,`folder-chips-${theme}-${width}-${folderId.replace(/\W+/g,'-').toLowerCase()}.png`)});
   if(firstLeft===undefined)firstLeft=row.buttons[0].left;
   assert.ok(Math.abs(row.buttons[0].left-firstLeft)<1,`${theme}/${width}/${folderId}: first chip must align with Inbox (${JSON.stringify(row)})`);
   assert.ok(row.buttons.every(button=>button.left>=row.hostLeft&&button.right<=row.hostRight),`${theme}/${width}/${folderId}: chips stay inside the list`);
   if(folderId==='All Mail')assert.ok(row.buttons[0].top>=row.titleBottom, 'a visible All Mail title gets its own row');
  }
 }
 await page.setViewportSize({width:900,height:960});
 await page.evaluate(()=>{
  state.accounts[0].folders.primary=[...chipFixtureFolders,
   ...[['Starred','starred'],['Trash','deleteditems'],['Junk','junkemail'],['Archived','archive'],['Important','important']].map(([id,wellKnownName])=>({id,name:id,wellKnownName,chip:true}))];
  renderList();
 });
 const wrapped=await folderChipBounds(page);
 assert.ok(new Set(wrapped.buttons.map(button=>button.top)).size>1,'long chip lists wrap');
 assert.ok(wrapped.buttons.every(button=>button.left>=wrapped.hostLeft&&button.right<=wrapped.hostRight),'wrapped chips stay inside the list');
 assert.ok(wrapped.buttons.every(button=>button.right<=wrapped.syncLeft),'wrapped chips do not overlap Sync');
 await page.locator('#list-chips button').first().focus();
 for(let index=0;index<wrapped.buttons.length;index++){
  assert.equal(await page.locator('#list-chips button').nth(index).evaluate(node=>node===document.activeElement),true,'Tab follows the visible chip order');
  await page.keyboard.press('Tab');
 }
 assert.equal(await page.evaluate(()=>document.activeElement.id),'refresh','Tab reaches Sync after the chips');
 await page.evaluate(()=>{
  globalThis.chipChoices=[];
  selectFolder=async(accountId,folderId)=>{chipChoices.push({accountId,folderId});state.folderId=folderId;renderList()};
  document.addEventListener('keydown',onShellKey);
 });
 await page.locator('#list-chips button').filter({hasText:/^Sent$/}).focus();await page.keyboard.press('Enter');
 await page.locator('#list-chips button').filter({hasText:/^Drafts$/}).focus();await page.keyboard.press('Space');
 assert.deepEqual(await page.evaluate(()=>chipChoices),[{accountId:'a',folderId:'Sent'},{accountId:'a',folderId:'Drafts'}]);
 await page.evaluate(()=>{state.prefs.chips=false;renderList()});
 assert.equal(await page.locator('#list-chips').isVisible(),false);
 const noChips=await page.evaluate(()=>{const title=document.getElementById('list-title').getBoundingClientRect(),sync=document.getElementById('refresh').getBoundingClientRect();return Math.abs((title.top+title.bottom)-(sync.top+sync.bottom))/2});
 assert.ok(noChips<2,'hiding chips keeps the title and Sync on one row');
 await page.evaluate(()=>showFeatures());
 assert.match(await page.locator('#features-catalog').textContent(),/Folder chips stay left aligned below a visible title/);
 fs.writeFileSync(path.join(output,'folder-chip-geometry.json'),JSON.stringify({geometry,wrapped},null,2));
 await page.setViewportSize({width:1440,height:960});
 await page.emulateMedia({reducedMotion:'no-preference'});
 return {comparisons:geometry.length,wrappedRows:new Set(wrapped.buttons.map(button=>button.top)).size,keyboard:'Tab, Enter, Space and Sync passed',output};
}

async function folderChipBounds(page) {
 return page.evaluate(()=>{
  const host=document.getElementById('messages').getBoundingClientRect(),title=document.getElementById('list-title').getBoundingClientRect(),sync=document.getElementById('refresh').getBoundingClientRect();
  return {hostLeft:host.left,hostRight:host.right,titleBottom:title.bottom,syncLeft:sync.left,
   buttons:[...document.querySelectorAll('#list-chips button')].map(node=>{const r=node.getBoundingClientRect();return {text:node.textContent,left:r.left,right:r.right,top:r.top}})};
 });
}

async function verifyOuterMailCardCorners(page) {
 await page.setViewportSize({width:1440,height:960});
 await page.evaluate(()=>{
  applyShellTheme(document.documentElement,'light','#193C34');
  state.allInbox=false;state.allInboxUnreadOnly=false;state.allInboxStarredOnly=false;
  state.query='';state.searchAccountId='';state.accountId='a';state.folderId='All Mail';
  state.email=null;state.thread=[];state.selectedIds=[];state.selectionAnchor='';state.prefs.chips=false;
  state.accounts[0].folders.primary.unshift({id:'All Mail',name:'All Mail',wellKnownName:'all'});
  state.emails=fixtureRows.filter(row=>row.accountId==='a').slice(0,200).map(row=>({...row,folderId:'All Mail'}));
  state.listTotal=225;state.listOffset=0;document.getElementById('list-filter').value='';
  renderAccounts();renderList();renderReader(false);
 });
 assert.equal(await page.locator('#list-title').textContent(),'All Mail');
 const measure=()=>page.evaluate(()=>{
  const card=document.getElementById('messages'),toolbar=document.getElementById('list-head'),reader=document.getElementById('reader');
  const c=card.getBoundingClientRect(),t=toolbar.getBoundingClientRect(),r=reader.getBoundingClientRect(),columns=document.querySelector('.mail-list-columns').getBoundingClientRect();
  const inside=(x,y)=>!!document.elementFromPoint(x,y)?.closest('#messages');
  return {cardTop:c.y,toolbarTop:t.y,toolbarBottom:t.bottom,columnHeaderTop:columns.y,readerTop:r.y,
   toolbarRadii:[getComputedStyle(toolbar).borderTopLeftRadius,getComputedStyle(toolbar).borderTopRightRadius],
   readerRadii:[getComputedStyle(reader).borderTopLeftRadius,getComputedStyle(reader).borderTopRightRadius],
   leftCornerInsideCard:inside(c.x+2,c.y+2),rightCornerInsideCard:inside(c.right-2,c.y+2),
   topCenterInsideCard:inside(c.x+c.width/2,c.y+2)};
 });
 // The negative control removes only the title/filter toolbar's outer radii.
 // It reproduces the parent's observed square card, without changing the table header.
 await page.locator('#list-head').evaluate(node=>{node.style.borderTopLeftRadius='0';node.style.borderTopRightRadius='0'});
 const before=await measure();
 assert.equal(before.toolbarTop,before.cardTop);assert.ok(before.toolbarBottom<=before.columnHeaderTop+1);
 assert.equal(before.cardTop,before.readerTop);assert.ok(before.columnHeaderTop>before.cardTop+50);
 assert.equal(before.leftCornerInsideCard,true);assert.equal(before.rightCornerInsideCard,true);
 fs.mkdirSync(output,{recursive:true});await page.mouse.move(1400,940);
 await page.screenshot({path:path.join(output,'all-mail-outer-corners-before.png')});
 await page.locator('#list-head').evaluate(node=>{node.style.removeProperty('border-top-left-radius');node.style.removeProperty('border-top-right-radius')});
 const after=await measure();
 assert.deepEqual(after.toolbarRadii,after.readerRadii);
 assert.equal(after.leftCornerInsideCard,false);assert.equal(after.rightCornerInsideCard,false);assert.equal(after.topCenterInsideCard,true);
 assert.equal(after.toolbarTop,after.cardTop);assert.equal(after.columnHeaderTop,before.columnHeaderTop);
 await page.screenshot({path:path.join(output,'all-mail-outer-corners-after.png')});
 return {before,after};
}

async function verifyReadingLayouts(page) {
 const choose=async name=>{await page.locator('#mail-view-open').click();await page.getByRole('menuitemradio',{name,exact:true}).click()};
 const dimensions=()=>page.evaluate(()=>{
  const rect=id=>{const b=document.getElementById(id).getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height}};
  return {messages:rect('messages'),reader:rect('reader'),shell:rect('shell')};
 });
 await page.setViewportSize({width:1440,height:960});
 await page.evaluate(()=>{document.documentElement.style.setProperty('--list','740px');state.query='Project';state.searchAccountId='b';document.getElementById('search-query').value='Project';return loadList(false,0)});
 await page.locator('button.message').first().click();await page.waitForFunction(()=>!!state.email);
 await page.locator('.row-check').first().click();
 const snapshot=()=>page.evaluate(()=>JSON.stringify([state.query,state.searchAccountId,state.selectedIds,state.selectionAnchor,state.listSort,mailColumnOrder()]));
 const before=await snapshot();
 await page.evaluate(()=>{document.getElementById('message-list').scrollLeft=60;document.getElementById('message-list').scrollTop=220});
 const scrolling=await page.locator('#message-list').evaluate(node=>({left:node.scrollLeft,top:node.scrollTop}));
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>applyShellTheme(document.documentElement,theme,'#193C34'),theme);
  for(const [layout,label] of [['right','Right preview'],['bottom','Bottom preview'],['window','Separate window']]){
   await choose(label);assert.equal(await page.locator('#shell').getAttribute('data-mail-layout'),layout);assert.equal(await snapshot(),before);
   const d=await dimensions();
   if(layout==='right')assert.ok(d.reader.x>=d.messages.right,JSON.stringify(d));
   if(layout==='bottom')assert.ok(d.reader.y>=d.messages.bottom&&Math.abs(d.reader.width-d.messages.width)<2,JSON.stringify(d));
   if(layout==='window')assert.equal(await page.locator('#reader').isVisible(),false);
   assert.ok(await page.evaluate(()=>{const b=document.getElementById('messages').getBoundingClientRect();return !document.elementFromPoint(b.x+1,b.y+1)?.closest('#messages')}),'table chrome must follow the rounded card');
   await page.mouse.move(1400,940);await page.screenshot({path:path.join(output,`${layout}-${theme}.png`)});
   await page.locator('#mail-view-open').press('ArrowDown');
   const violations=await page.evaluate(async()=> (await axe.run({include:[['#mail-view-control'],['.split']]},{runOnly:{type:'tag',values:['wcag2a','wcag2aa']}})).violations.map(v=>v.id));assert.deepEqual(violations,[]);
   if(theme==='light'&&layout==='right')await page.screenshot({path:path.join(output,'view-menu.png')});
   await page.keyboard.press('Escape');assert.equal(await page.locator('#mail-view-open').evaluate(node=>node===document.activeElement),true);
  }
 }
 await choose('Right preview');
 assert.deepEqual(await page.locator('#message-list').evaluate(node=>({left:node.scrollLeft,top:node.scrollTop})),scrolling);
 await choose('Bottom preview');
 const handle=page.locator('[data-split="messages"]'),height=(await dimensions()).messages.height;
 await handle.press('ArrowDown');assert.ok((await dimensions()).messages.height>height);
 const box=await handle.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2,box.y+box.height/2+30);await page.mouse.up();
 assert.ok((await dimensions()).messages.height>height+24);
 await page.locator('#search-scope summary').click();
 await handle.press('ArrowUp');
 await page.evaluate(()=>setPane('messages',200));
 assert.ok(await page.evaluate(()=>{
  const list=document.getElementById('message-list').getBoundingClientRect(),messages=document.getElementById('messages').getBoundingClientRect();
  return list.height>=96&&list.bottom<=messages.bottom+1;
 }),'expanded controls must leave a usable list inside the card');
 await page.screenshot({path:path.join(output,'bottom-expanded-search.png')});
 await page.locator('#search-scope summary').click();
 const rightWidth=await page.evaluate(()=>state.prefs.layout.list);assert.equal(rightWidth,360);
 await choose('Separate window');
 const row=page.locator('button.message').first();await row.scrollIntoViewIfNeeded();
 const seed=await row.evaluate(node=>({accountId:node.closest('.message-row').dataset.accountId,messageId:node.closest('.message-row').dataset.emailId}));
 const reads=await page.evaluate(()=>requests.filter(r=>r.channel==='mail:openEmail'||r.channel==='mail:markRead').length);
 await row.click();assert.equal(await page.evaluate(()=>popouts.length),0);assert.equal(await page.evaluate(()=>requests.filter(r=>r.channel==='mail:openEmail'||r.channel==='mail:markRead').length),reads);
 await row.dblclick();assert.deepEqual(await page.evaluate(()=>popouts),[seed]);
 await row.press('Enter');assert.deepEqual(await page.evaluate(()=>popouts),[seed,seed]);
 await row.dblclick({modifiers:['Control']});assert.equal(await page.evaluate(()=>popouts.length),2);
 for(const viewport of [{width:900,height:700},{width:640,height:800},{width:390,height:844}]){
  await page.setViewportSize(viewport);
  for(const [layout,label] of [['right','Right preview'],['bottom','Bottom preview'],['window','Separate window']]){
   await choose(label);const d=await dimensions();assert.ok(d.messages.x>=0&&d.messages.right<=viewport.width,JSON.stringify({viewport,d}));
   if(viewport.width<=800&&layout!=='window')assert.ok(d.reader.y>=d.messages.bottom,JSON.stringify(d));
   const button=await page.locator('#mail-view-open').boundingBox();assert.ok(button.x>=0&&button.x+button.width<=viewport.width);
   assert.ok(await page.locator('#message-list').evaluate(node=>node.scrollHeight>node.clientHeight));
   if(viewport.width<=900)assert.ok(await page.locator('#message-list').evaluate(node=>node.scrollWidth>node.clientWidth));
   await page.screenshot({path:path.join(output,`${layout}-${viewport.width}.png`)});
  }
 }
 await page.emulateMedia({reducedMotion:'reduce'});await choose('Bottom preview');await choose('Separate window');
}


async function verifyColumnControls(page, initialize) {
 await page.setViewportSize({width:1440,height:960});
 await page.evaluate(()=>{
  state.allInbox=false;state.allInboxUnreadOnly=false;state.allInboxStarredOnly=false;state.query='';state.outbox=false;
  state.prefs.mailView={layout:'right',listHeight:320};applyMailView();
  state.emails=fixtureRows.slice(0,20).map((row,index)=>({...row,replied:index%4===0||index%4===2,forwarded:index%4===1||index%4===2}));
  state.emails[3].replied=null;state.emails[3].forwarded=null;state.listSort={sortBy:'sender',sortDirection:'asc'};state.listTotal=20;renderList();paintSyncControl();paintBodySyncStatus();
 });
 assert.equal(await page.locator('[data-mail-column="subject"]').first().locator('.mail-reply-forward [data-state="replied"]').count(),1);
 assert.equal(await page.locator('[data-mail-column="subject"]').nth(3).locator('.mail-reply-forward').isVisible(),false);
 assert.equal(await page.locator('[data-mail-column="status"], [data-sort-key="status"]').count(),0);
 await page.screenshot({path:path.join(output,'provider-status-icons.png')});
 await page.locator('.message-row button.message').first().focus();
 await page.evaluate(()=>{window.statusFocused=document.activeElement;state.emails[0].replied=false;state.emails[0].forwarded=true;renderList()});
 assert.equal(await page.evaluate(()=>document.activeElement===statusFocused),true,'flag refresh preserves the focused row');
 assert.equal(await page.locator('[data-mail-column="subject"]').first().locator('.mail-reply-forward [data-state="forwarded"]').count(),1);
 const originalSort=await page.evaluate(()=>({...state.listSort}));
 assert.equal(await page.locator('[data-sort-key="status"]').count(),0);
 await page.locator('[data-sort-key="subject"] button').click({button:'right'});
 assert.equal(await page.locator('#mail-column-menu').isVisible(),true);
 await page.screenshot({path:path.join(output,'header-menu.png')});
 await page.addScriptTag({url:'/axe.js'});
 const a11y=await page.evaluate(async()=> (await axe.run(document.getElementById('mail-column-menu'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa']}})).violations.map(row=>row.id));assert.deepEqual(a11y,[]);
 await page.getByRole('menuitemcheckbox',{name:'Sender',exact:true}).click();
 assert.equal(await page.locator('[data-sort-key="sender"]').isVisible(),false);assert.equal(await page.locator('[data-mail-column="sender"]').count(),0);
 assert.deepEqual(await page.evaluate(()=>({...state.listSort})),originalSort,'hiding the sorted column keeps sorting');
 await page.keyboard.press('Escape');assert.equal(await page.locator('[data-sort-key="subject"] button').evaluate(node=>node===document.activeElement),true);
 await page.keyboard.press('Shift+F10');await page.keyboard.press('End');
 assert.equal(await page.locator('#mail-column-menu [data-column="sender"]').evaluate(node=>node===document.activeElement),true);
 assert.equal(await page.locator('#mail-column-menu [data-column="status"]').count(),0);
 await page.keyboard.press('Home');await page.keyboard.press('Space');assert.equal(await page.locator('[data-sort-key="date"]').isVisible(),false);
 await page.keyboard.press('Escape');
 await page.reload();await initialize();
 assert.equal(await page.locator('[data-sort-key="sender"]').isVisible(),false);assert.equal(await page.locator('[data-sort-key="date"]').isVisible(),false);
 await page.locator('#mail-columns-open').click();
 assert.equal(await page.locator('[data-visibility="sender"]').isChecked(),false);
 const editorGeometry=await page.locator('#mail-columns-order li').evaluateAll(rows=>rows.map(row=>{const label=row.querySelector('label').getBoundingClientRect(),check=row.querySelector('input').getBoundingClientRect(),move=row.querySelector('button').getBoundingClientRect();return {labelRight:label.right,checkRight:check.right,checkWidth:check.width,moveLeft:move.left}}));
 assert.ok(editorGeometry.every(row=>row.checkWidth<=20&&row.checkRight<=row.labelRight&&row.labelRight+4<=row.moveLeft),JSON.stringify(editorGeometry));
 await page.screenshot({path:path.join(output,'columns-dialog.png')});
 await page.getByRole('button',{name:'Show all columns',exact:true}).click();
 assert.equal(await page.locator('[data-visibility="sender"]').isChecked(),true);
 await page.locator('#mail-columns-close').click();
 const stacking=[];
 for(const [layout,width,theme,compact] of [['right',1440,'light',true],['bottom',1440,'dark',false],['window',900,'light',true],['right',760,'dark',false]]) {
  await page.setViewportSize({width,height:800});
  await page.evaluate(({layout,theme,compact})=>{
   state.prefs.mailView={layout,listHeight:320};state.prefs.compactList=compact;applyMailView();applyShellTheme(document.documentElement,theme,'#193C34');
   renderList();paintSyncControl();paintBodySyncStatus();
  },{layout,theme,compact});
  await page.locator('#message-list').evaluate(node=>node.scrollTop=180);
  await page.locator('#refresh').hover();
  const topmost=()=>page.evaluate(()=>{
   const tip=document.querySelector('.body-sync-scroll'),r=tip.getBoundingClientRect(),head=document.querySelector('.mail-list-columns').getBoundingClientRect();
   const y=Math.max(r.top,head.top)+Math.min(8,Math.min(r.bottom,head.bottom)-Math.max(r.top,head.top))/2;
   const x=Math.max(r.left,head.left)+12;return {overlap:Math.min(r.bottom,head.bottom)>Math.max(r.top,head.top),tipOnTop:!!document.elementFromPoint(x,y)?.closest('#body-sync')};
  });
  const result=await topmost();assert.equal(result.overlap,true,JSON.stringify({layout,width,result}));assert.equal(result.tipOnTop,true,JSON.stringify({layout,width,result}));
  if(layout==='right'&&width===1440){
   await page.locator('#list-head').evaluate(node=>{node.style.zIndex='3';node.style.position='static'});
   assert.equal((await topmost()).tipOnTop,false,'negative control reproduces sticky headers covering Sync');
   await page.locator('#list-head').evaluate(node=>{node.style.removeProperty('z-index');node.style.removeProperty('position')});
   assert.equal((await topmost()).tipOnTop,true);
  }
  await page.screenshot({path:path.join(output,`sync-${layout}-${width}-${theme}.png`)});
  await page.locator('.body-sync-scroll').focus();assert.equal((await topmost()).tipOnTop,true,'keyboard focus retains the popup');
  await page.evaluate(()=>document.activeElement.blur());await page.mouse.move(1,1);
  await page.locator('[data-sort-key="subject"] button').click({button:'right'});
  const bounds=await page.locator('#mail-column-menu').boundingBox();assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=width);
  await page.keyboard.press('Escape');stacking.push({layout,width,theme,compact,...result});
 }
 await page.setViewportSize({width:900,height:700});
 await page.locator('#mail-columns-open').tap();
 for(const key of ['date','recipient','sender'])await page.locator(`[data-visibility="${key}"]`).tap();
 await page.locator('#mail-columns-close').click();
 assert.equal(await page.locator('.mail-list-columns [role="columnheader"]:visible').count(),1);
 const overflow=await page.locator('#message-list').evaluate(node=>node.scrollWidth>node.clientWidth);assert.equal(overflow,false,'hiding columns reduces the grid minimum width');
 await page.screenshot({path:path.join(output,'subject-only-narrow.png')});
 await page.locator('#mail-columns-open').click();await page.getByRole('button',{name:'Show all columns',exact:true}).click();await page.locator('#mail-columns-close').click();
 await page.setViewportSize({width:1440,height:900});
 await page.evaluate(()=>{
  state.allInbox=true;state.outbox=true;state.prefs.mailView={layout:'window',listHeight:320};state.prefs.compactList=true;
  state.outboxRows=[{id:'outbox-a',accountId:'a',outbox:true,status:'pending',to:'"Team, West" <west@fixture.invalid>, second@fixture.invalid',fromAddress:'a@fixture.invalid',subject:'Multiple recipients',sendAt:'2099-01-01T00:00:00Z'},
   {id:'outbox-b',accountId:'b',outbox:true,status:'pending',to:'b-recipient@fixture.invalid',fromAddress:'b@fixture.invalid',subject:'Second account',sendAt:'2099-01-01T00:00:01Z'},
   {id:'outbox-empty',accountId:'b',outbox:true,status:'pending',to:'',bcc:'hidden@fixture.invalid',fromAddress:'b@fixture.invalid',subject:'BCC only',sendAt:'2099-01-01T00:00:02Z'}];
  state.outboxCount=3;state.emails=outboxEmails(state.outboxRows);state.listTotal=3;renderList();
 });
 assert.deepEqual(await page.locator('[data-mail-column="recipient"]').allTextContents(),['"Team, West" <west@fixture.invalid>, second@fixture.invalid','b-recipient@fixture.invalid','(no recipient)']);
 await page.mouse.move(1,1);await page.screenshot({path:path.join(output,'outbox-recipients.png')});
 const disabledHeader=await page.locator('[data-sort-key="recipient"] button').boundingBox();
 await page.mouse.click(disabledHeader.x+12,disabledHeader.y+12,{button:'right'});
 assert.equal(await page.locator('#mail-column-menu').isVisible(),true,'Outbox disabled sorting header still offers column choices');await page.keyboard.press('Escape');
 return {stacking,menuAxeViolations:a11y,editorGeometry,subjectOnlyOverflow:overflow,outboxRecipients:'formatted multi-account To and empty To passed'};
}
