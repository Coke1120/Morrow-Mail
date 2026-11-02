// Synthetic renderer/browser verification. Install Playwright and axe outside the checkout if desired.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || 'playwright');
const fs=require('fs'),http=require('http'),path=require('path'),assert=require('assert/strict');
const root=path.join(__dirname,'..'),output=process.env.MORROW_UI_OUTPUT||path.join(require('os').tmpdir(),'morrow-mail-layout');
(async()=>{
 const server=http.createServer((req,res)=>{
  if(req.url==='/axe.js'){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(require.resolve(process.env.MORROW_AXE_MODULE||'axe-core/axe.min.js')))}
  const target=path.join(root,decodeURI(req.url.split('?')[0]));if(!target.startsWith(root+path.sep)){res.writeHead(403).end();return}
  try{let data=fs.readFileSync(target);if(target.endsWith('/renderer/app.js'))data=data.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/,'');res.setHeader('Content-Type',target.endsWith('.js')?'text/javascript':target.endsWith('.css')?'text/css':target.endsWith('.svg')?'image/svg+xml':target.endsWith('.png')?'image/png':'text/html');res.end(data)}catch{res.writeHead(404).end()}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:process.env.MORROW_CHROMIUM||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{window.morrow={on(){},invoke:async(channel,value)=>{
   if(channel==='morrow:configGetMailColumnOrder')return JSON.parse(localStorage.getItem('synthetic.columns')||'null');
   if(channel==='morrow:configSetMailColumnOrder'){localStorage.setItem('synthetic.columns',JSON.stringify(value));return value}return null;
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
   offerChangelog=async()=>{};refreshMailVacation=()=>{document.getElementById("mail-ooo").hidden=true};await loadMailColumnOrder();wireMailColumnEditor();renderAccounts();await loadList(false,0);document.getElementById('mail-ooo').hidden=true;
  })}
  await page.goto(url);await initialize();
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
  await page.evaluate(()=>showFeatures());assert.match(await page.locator('#features-catalog').textContent(),/Drag headers to reorder columns independently of sorting/);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'passed',checks:'drag, sort, reload persistence, keyboard/dialog/reset, aligned cells, aggregate flags and live counts, Inbox chip removal, narrow layout, rendered Features, axe',output}));
 }finally{await browser.close();server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
