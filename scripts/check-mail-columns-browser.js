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
  const page=await browser.newPage({viewport:{width:1440,height:900},locale:'en-US',timezoneId:'America/New_York'});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
   if(!localStorage.getItem('fixture.mailColumnOrder'))localStorage.setItem('fixture.mailColumnOrder',JSON.stringify(['date','recipient','sender','subject']));
   window.morrow={invoke:async(channel,payload)=>{
    const keys={'morrow:configGetMailColumnOrder':'fixture.mailColumnOrder','morrow:configSetMailColumnOrder':'fixture.mailColumnOrder','morrow:configGetMailHiddenColumns':'fixture.mailHiddenColumns','morrow:configSetMailHiddenColumns':'fixture.mailHiddenColumns'};
    if(!keys[channel])throw new Error('Unsupported synthetic invoke');
    if(channel.includes('Set'))localStorage.setItem(keys[channel],JSON.stringify(payload));
    return JSON.parse(localStorage.getItem(keys[channel])||'null');
   }};
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
  const initialize=()=>page.evaluate(async()=>{
   document.documentElement.style.setProperty('--list','740px');document.documentElement.style.setProperty('--folders','180px');setNavCollapsed(true);state.view='mail';state.accountId='fixture';state.folderId='INBOX';state.listSyncDone=true;
   state.accounts=[{id:'fixture',email:'owner@fixture.invalid',name:'Synthetic mailbox',folders:[{id:'INBOX',name:'Inbox',wellKnownName:'inbox'},{id:'Drafts',name:'Drafts',wellKnownName:'drafts'},{id:'Sent',name:'Sent',wellKnownName:'sentitems'}]}];
   state.prefs.timeFormat='24h';state.prefs.dateFormat='yyyy-mm-dd';
   globalThis.listRequests=[];
   globalThis.fixtureRows=Array.from({length:450},(_,n)=>({id:`fixture-${String(n).padStart(3,'0')}`,accountId:'fixture',folderId:'INBOX',subject:n%11===0?'':`Project ${String((n*13)%101).padStart(3,'0')} — Quarterly review and next steps`,from:n%17===0?'':`${['Ada Chen','Ben Wong','Carla Smith'][n%3]} <sender${n}@fixture.invalid>`,to:n%13===0?[]:[`team${n%19}@fixture.invalid`,'second@fixture.invalid'],date:new Date(1793577600000-n*3600000).toISOString(),listSortTs:1793577600000-n*3600000,unread:n%3===0,snippet:'Synthetic preview for layout checks. No real mailbox data.',threadId:'thread-'+n}));
   fixtureRows.forEach((row,index)=>{row.replied=index%4===3?null:index%4===0||index%4===2;row.forwarded=index%4===3?null:index%4===1||index%4===2;});
   call=async(channel,p)=>{
    if(channel==='mail:listFromCache'){
     listRequests.push(p);
     const rows=fixtureRows.slice(); const key=r=>p.sortBy==='subject'?r.subject:p.sortBy==='sender'?r.from:p.sortBy==='recipient'?(r.to[0]||''):r.date;
     rows.sort((a,b)=>{const x=key(a),y=key(b);return (x<y?-1:x>y?1:a.id<b.id?-1:1)*(p.sortDirection==='asc'?1:-1)});
     return {emails:rows.slice(p.offset||0,(p.offset||0)+(p.limit||200)),total:rows.length,initialSyncDone:true};
    }
    return null;
   };
   offerChangelog=async()=>{};
   document.documentElement.dataset.view='mail';
   await loadMailColumnOrder();
   renderAccounts();document.getElementById('mail-ooo').hidden=true;
  });
  await initialize();
  await page.evaluate(()=>loadList(false,0));
  assert.equal(await page.locator('.mail-list-columns [role="columnheader"]').count(),5);
  assert.equal(await page.locator('[data-sort-key="status"], [data-mail-column="status"]').count(),0);
  assert.equal(await page.locator('[data-mail-column="subject"]').first().locator('.mail-reply-forward [data-state="replied"]').count(),1);
  assert.equal(await page.locator('[data-mail-column="subject"]').nth(3).locator('.mail-reply-forward').isVisible(),false);
  assert.equal(await page.locator('[data-mail-column="subject"]').first().evaluate(cell=>cell.firstElementChild.className==='mail-reply-forward'&&cell.firstElementChild.nextElementSibling.className==='subject'),true);
  assert.deepEqual(await page.evaluate(()=>mailColumnOrder()),['date','time','recipient','sender','subject'],'an old saved layout gains Time beside Date');
  const stamps=await page.evaluate(()=>['2026-11-01T05:30:00.000Z','2026-11-01T06:30:00.000Z','2026-11-02T00:30:00.000Z'].map((date,index)=>{
   const row=messageRow({id:'zone-'+index,date});
   const time=row.querySelector('[data-mail-column="time"]');
   return {date:row.querySelector('[data-mail-column="date"]').textContent,time:time.textContent,title:time.title,datetime:time.dateTime};
  }));
  assert.deepEqual(stamps.map(row=>row.date),['2026-11-01','2026-11-01','2026-11-01']);
  assert.deepEqual(stamps.map(row=>row.time),['01:30','01:30','19:30'],'device timezone and 24-hour preference apply across DST and UTC date boundaries');
  for(const row of stamps){assert.match(row.title,/America\/New_York/);assert.ok(row.title.includes(row.datetime));}
  assert.notEqual(stamps[0].title,stamps[1].title,'repeated DST times retain distinct exact UTC tooltips');
  assert.match(await page.evaluate(()=>{state.prefs.timeFormat='12h';const row=messageRow({id:'twelve',date:'2026-11-01T05:30:00.000Z'});state.prefs.timeFormat='24h';return row.querySelector('[data-mail-column="time"]').textContent;}),/1:30 AM/);
  await page.locator('[data-sort-key="time"] button').click();
  await page.waitForFunction(()=>document.querySelector('[data-sort-key="time"]').getAttribute('aria-sort')==='descending');
  await page.locator('[data-sort-key="time"] button').press('Space');
  await page.waitForFunction(()=>document.querySelector('[data-sort-key="time"]').getAttribute('aria-sort')==='ascending');
  const sorted=await page.evaluate(()=>({first:state.emails[0].date,expected:fixtureRows.map(row=>row.date).sort()[0],sort:{...state.listSort},saved:readMailListSortColumn(),requests:listRequests.map(row=>row.sortBy)}));
  assert.equal(sorted.first,sorted.expected,'Time sorts all dates before paging rather than grouping by time of day');
  assert.deepEqual(sorted.sort,{sortBy:'date',sortDirection:'asc'});assert.equal(sorted.saved,'time');assert.ok(sorted.requests.every(key=>key!=='time'));
  await page.locator('[data-sort-key="subject"] button').click({button:'right'});
  await page.getByRole('menuitemcheckbox',{name:'Time',exact:true}).click();
  await page.evaluate(()=>mailColumnSave);
  assert.equal(await page.locator('[data-sort-key="time"]').isVisible(),false);
  assert.equal(await page.locator('[data-mail-column="time"]').count(),0);
  assert.deepEqual(await page.evaluate(()=>state.listSort),{sortBy:'date',sortDirection:'asc'});
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-sort-key="subject"] button').evaluate(node=>node===document.activeElement),true);
  await page.reload();await initialize();await page.evaluate(()=>loadList(false,0));
  assert.equal(await page.locator('[data-sort-key="time"]').isVisible(),false,'Time visibility survives restart');
  assert.equal(await page.evaluate(()=>state.listSortColumn),'time');
  await page.locator('[data-sort-key="subject"] button').press('Shift+F10');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.getByRole('menuitemcheckbox',{name:'Time',exact:true}).evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press('Space');await page.evaluate(()=>mailColumnSave);
  assert.equal(await page.locator('[data-sort-key="time"]').isVisible(),true);
  await page.keyboard.press('Escape');
  await page.locator('[data-sort-key="time"] button').press('Alt+ArrowRight');await page.evaluate(()=>mailColumnSave);
  assert.deepEqual(await page.evaluate(()=>mailColumnOrder()),['date','recipient','time','sender','subject']);
  await page.reload();await initialize();await page.evaluate(()=>loadList(false,0));
  assert.deepEqual(await page.evaluate(()=>mailColumnOrder()),['date','recipient','time','sender','subject'],'an explicit Time position survives restart');
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
   const row=[...document.querySelector('.message-row .row-main').children].slice(0,5).map(e=>e.getBoundingClientRect().x);
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
  const columnHelp=page.locator('.feature-card').filter({has:page.getByRole('heading',{name:'Mail columns and sorting',exact:true})});
  assert.match(await columnHelp.textContent(),/Both headers sort by the full timestamp, including the date/);
  assert.match(await columnHelp.textContent(),/Older saved layouts gain Time immediately after Date/);
  const replyHelp=page.locator('.feature-card').filter({has:page.getByRole('heading',{name:'Reply / forward indicators',exact:true})});
  await replyHelp.scrollIntoViewIfNeeded();
  assert.match(await replyHelp.textContent(),/verified original Gmail identity even when its Message-ID is missing/);
  assert.match(await replyHelp.textContent(),/at most two already cached, uninspected Sent reply candidates per pass/);
  assert.match(await replyHelp.textContent(),/Completed MIME checks survive restart/);
  assert.match(await replyHelp.textContent(),/Outlook OAuth, Yahoo app-password and other IMAP accounts/);
  assert.match(await replyHelp.textContent(),/at most two identities per ordinary folder sync after five minutes/);
  assert.match(await replyHelp.textContent(),/flag errors never resubmit mail/);
  assert.match(await page.locator('#mail-columns-provider-help').textContent(),/Cross-device IMAP icons require server and client support/);
  assert.match(await page.locator('#mail-columns-provider-help').textContent(),/at most two per pass within its normal read budget/);
  await page.screenshot({path:path.join(output,'reply-features.png')});
  await page.setViewportSize({width:860,height:700});await replyHelp.scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(output,'reply-features-narrow.png')});
  assert.deepEqual(errors,[]);
  console.log('browser-ok: five columns, Time show/hide and saved order migration, keyboard visibility/reorder and restart persistence, full-timestamp sort, DST/timezone and date/time preferences, subject-prefix provider icons, real renderer sorting, aligned columns, narrow scroll, compact/comfortable layouts and current Gmail/IMAP Reply Features/help');
 } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
