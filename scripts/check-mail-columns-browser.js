const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs'), http = require('http'), path = require('path'), assert = require('assert/strict');
const root = path.join(__dirname, '..');
const output = process.env.MORROW_UI_OUTPUT || path.join(require('os').tmpdir(), 'morrow-mail-columns');
(async () => {
 const server = http.createServer((req,res) => {
  const target = path.join(root, decodeURI(req.url.split('?')[0]));
  try { let data = fs.readFileSync(target); if(target.endsWith('/renderer/app.js')) data = data.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, '');
   res.setHeader('content-type',target.endsWith('.css')?'text/css':target.endsWith('.js')?'text/javascript':target.endsWith('.png')?'image/png':target.endsWith('.svg')?'image/svg+xml':'text/html');res.end(data);
  } catch { res.statusCode=404;res.end(); }
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{ window.morrow={}; });
  await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
  await page.evaluate(()=>{
   document.documentElement.style.setProperty('--list','740px');document.documentElement.style.setProperty('--folders','180px');setNavCollapsed(true);state.view='mail';state.accountId='fixture';state.folderId='INBOX';state.listSyncDone=true;
   state.accounts=[{id:'fixture',email:'owner@fixture.invalid',name:'Synthetic mailbox',folders:[{id:'INBOX',name:'Inbox',wellKnownName:'inbox'},{id:'Drafts',name:'Drafts',wellKnownName:'drafts'},{id:'Sent',name:'Sent',wellKnownName:'sentitems'}]}];
   globalThis.fixtureRows=Array.from({length:450},(_,n)=>({id:`fixture-${String(n).padStart(3,'0')}`,accountId:'fixture',folderId:'INBOX',subject:n%11===0?'':`Project ${String((n*13)%101).padStart(3,'0')} — Quarterly review and next steps`,from:n%17===0?'':`${['Ada Chen','Ben Wong','Carla Smith'][n%3]} <sender${n}@fixture.invalid>`,to:n%13===0?[]:[`team${n%19}@fixture.invalid`,'second@fixture.invalid'],date:new Date(1793577600000-n*3600000).toISOString(),listSortTs:1793577600000-n*3600000,unread:n%3===0,snippet:'Synthetic preview for layout checks. No real mailbox data.',threadId:'thread-'+n}));
   fixtureRows.forEach((row,index)=>{row.replied=index%4===3?null:index%4===0||index%4===2;row.forwarded=index%4===3?null:index%4===1||index%4===2;});
   call=async(channel,p)=>{
    if(channel==='mail:listFromCache'){
     const rows=fixtureRows.slice(); const key=r=>p.sortBy==='subject'?r.subject:p.sortBy==='sender'?r.from:p.sortBy==='recipient'?(r.to[0]||''):r.date;
     rows.sort((a,b)=>{const x=key(a),y=key(b);return (x<y?-1:x>y?1:a.id<b.id?-1:1)*(p.sortDirection==='asc'?1:-1)});
     return {emails:rows.slice(p.offset||0,(p.offset||0)+(p.limit||200)),total:rows.length,initialSyncDone:true};
    }
    return null;
   };
   offerChangelog=async()=>{};
   document.documentElement.dataset.view='mail';
   renderAccounts();document.getElementById('mail-ooo').hidden=true;
  });
  await page.evaluate(()=>loadList(false,0));
  assert.equal(await page.locator('.mail-list-columns [role="columnheader"]').count(),4);
  assert.equal(await page.locator('[data-sort-key="status"], [data-mail-column="status"]').count(),0);
  assert.equal(await page.locator('[data-mail-column="subject"]').first().locator('.mail-reply-forward [data-state="replied"]').count(),1);
  assert.equal(await page.locator('[data-mail-column="subject"]').nth(3).locator('.mail-reply-forward').isVisible(),false);
  assert.equal(await page.locator('[data-mail-column="subject"]').first().evaluate(cell=>cell.firstElementChild.className==='mail-reply-forward'&&cell.firstElementChild.nextElementSibling.className==='subject'),true);
  await page.locator('[data-sort-key="subject"] button').click();
  await page.waitForFunction(()=>document.querySelector('[data-sort-key="subject"]').getAttribute('aria-sort')==='ascending');
  await page.locator('[data-sort-key="subject"] button').press('Enter');
  await page.waitForFunction(()=>document.querySelector('[data-sort-key="subject"]').getAttribute('aria-sort')==='descending');
  assert.equal(await page.evaluate(()=>state.emails[0].subject), 'Project 100 — Quarterly review and next steps');
  await page.locator('[data-sort-key="date"] button').click();
  await page.evaluate(()=>{document.activeElement.blur();document.getElementById('message-list').scrollLeft=0;});
  await page.mouse.move(1300,850);
  fs.mkdirSync(output,{recursive:true});
  await page.screenshot({path:path.join(output,'wide.png')});
  const align=await page.evaluate(()=>{
   const head=[...document.querySelectorAll('.mail-list-columns [role="columnheader"]')].map(e=>e.getBoundingClientRect().x);
   const row=[...document.querySelector('.message-row .row-main').children].slice(0,4).map(e=>e.getBoundingClientRect().x);
   return {head,row};
  });
  assert.ok(align.head.every((x,n)=>Math.abs(x-align.row[n])<2),JSON.stringify(align));
  await page.setViewportSize({width:860,height:700});await page.evaluate(()=>document.documentElement.style.setProperty('--list','360px'));
  await page.screenshot({path:path.join(output,'narrow.png')});
  assert.ok(await page.evaluate(()=>{const e=document.getElementById('message-list');return e.scrollWidth>e.clientWidth;}));
  await page.evaluate(()=>document.getElementById('message-list').scrollLeft=1000);
  await page.locator('[data-sort-key="subject"] button').press('Space');
  await page.waitForFunction(()=>document.querySelector('[data-sort-key="subject"]').getAttribute('aria-sort')==='ascending');
  await page.setViewportSize({width:1440,height:900});
  await page.evaluate(()=>{document.documentElement.style.setProperty('--list','740px');state.prefs.compactList=false;renderList();document.getElementById('message-list').scrollLeft=0;});
  await page.screenshot({path:path.join(output,'comfortable.png')});
  await page.evaluate(()=>showFeatures());
  const replyHelp=page.locator('.feature-card').filter({has:page.getByRole('heading',{name:'Reply / forward indicators',exact:true})});
  await replyHelp.scrollIntoViewIfNeeded();
  assert.match(await replyHelp.textContent(),/verified original Gmail identity even when its Message-ID is missing/);
  assert.match(await replyHelp.textContent(),/at most two already cached, uninspected Sent reply candidates per pass/);
  assert.match(await replyHelp.textContent(),/Completed MIME checks survive restart/);
  assert.match(await page.locator('#mail-columns-provider-help').textContent(),/at most two per pass within its normal read budget/);
  await page.screenshot({path:path.join(output,'reply-features.png')});
  await page.setViewportSize({width:860,height:700});await replyHelp.scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(output,'reply-features-narrow.png')});
  assert.deepEqual(errors,[]);
  console.log('browser-ok: four columns, subject-prefix provider icons, real renderer sorting, aligned columns, narrow scroll, compact/comfortable layouts and current Gmail Reply Features/help');
 } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
