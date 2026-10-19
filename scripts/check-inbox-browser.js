// Offline Chromium QA of the real renderer. No Electron host, network mail or credentials.
// CHROMIUM=/path/to/chromium node scripts/check-inbox-browser.js [source-root] [output-dir]
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const output = path.resolve(process.argv[3] || '/tmp/morrow-inbox-qa');
fs.mkdirSync(output, { recursive: true });
const fixture = `
const fixtureAccounts = ['alpha','beta'].map(id => ({id,email:id+'@example.invalid',platform:'imap',profile:'custom',folders:{primary:[{id:'inbox',name:'Inbox',wellKnownName:'inbox'},{id:'sent',name:'Sent',wellKnownName:'sent'},{id:'drafts',name:'Drafts',wellKnownName:'drafts'}],more:[]}}));
function fixtureRows(offset=0, accountId='alpha', folderId='inbox') { return Array.from({length:Math.min(200,4479-offset)},(_,i)=>({id:accountId+':'+folderId+':'+(offset+i),accountId,folderId,from:['Alex Morgan <alex@example.invalid>','Design team <design@example.invalid>','Sam Rivera <sam@example.invalid>'][i%3],subject:['Project notes for Monday','Updated design review','Planning our next milestone'][i%3]+' '+(offset+i+1),snippet:'Synthetic message for offline layout and keyboard checks.',date:'2026-10-19T09:00:00Z',unread:i%4===0,textBody:Array(50).fill('Synthetic review notes. This fixture contains no private mail.').join('\\n\\n')})); }
window.fixtureCalls=[];
window.morrow={on(){},invoke:async(channel,p={})=>{fixtureCalls.push({channel,p});let data={};if(channel==='mail:listAccounts')data=fixtureAccounts;else if(channel==='mail:listFromCache'||channel==='mail:listFromNetwork')data={emails:fixtureRows(p.offset,p.accountId,p.folderId),total:4479,initialSyncDone:false};else if(channel==='mail:getEmail')data={email:state.emails.find(e=>e.id===p.emailId)};else if(channel==='mail:listSnoozed')data={records:[]};return {data};}};
`;
const setup = `
Object.assign(state,{accounts:fixtureAccounts,accountId:'alpha',folderId:'inbox',emails:fixtureRows(),listTotal:4479,listSyncDone:false});
state.email=state.emails[0]; wire(); renderAccounts(); renderList(); renderReader();
window.fixture={state,paint:()=>{renderList();renderReader();},sync:kind=>{state.syncScopes.set(JSON.stringify([state.accountId,state.folderId]),{state:kind,phase:'headers',message:kind,updatedAt:1});renderList();}};
window.fixtureReady=true;
`;
let browser, socket;
const server = http.createServer((req,res)=>{
  const pathname = new URL(req.url,'http://localhost').pathname;
  if (!/^\/(renderer|shared)\/[\w./-]+$/.test(pathname) || pathname.includes('..')) {res.writeHead(404);res.end();return;}
  try { let data=fs.readFileSync(path.join(root,pathname));
    if(pathname==='/renderer/app.js')data=fixture+data.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/,'')+setup;
    res.setHeader('Content-Type',pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':pathname.endsWith('.html')?'text/html':'image/svg+xml');res.end(data);
  }catch{res.writeHead(404);res.end();}
});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=spawn(process.env.CHROMIUM||'/usr/bin/chromium',['--headless','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+path.join(output,'profile'),'about:blank'],{stdio:['ignore','ignore','pipe']});
 let endpoint=''; browser.stderr.on('data',b=>{const m=b.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m)endpoint=m[1];});
 for(let i=0;i<100&&!endpoint;i++)await delay(100);assert(endpoint,'Chromium started');
 const origin=endpoint.replace(/^ws:/,'http:').split('/devtools')[0];
 const target=await (await fetch(origin+'/json/new?about:blank',{method:'PUT'})).json();
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>socket.addEventListener('open',r,{once:true}));
 let seq=0;const pending=new Map(),errors=[];
 socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text+': '+m.params.exceptionDetails.exception?.description);});
 const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description);return r.result.value;};
 const shot=async name=>{await delay(200);fs.writeFileSync(path.join(output,name+'.png'),Buffer.from((await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));};
 await cdp('Runtime.enable');await cdp('Page.enable');
 await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await cdp('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/renderer/index.html'});
 for(let i=0;i<100;i++){if(await evaluate('window.fixtureReady===true'))break;await delay(100);}
 assert(await evaluate('window.fixtureReady===true'),JSON.stringify(errors));await shot('wide');
 const revised=await evaluate('!!document.getElementById("message-list")');
 if(revised){
  assert.equal(await evaluate('document.getElementById("list-page-status").textContent'),'1–200 / 4,479 downloaded');
  assert(await evaluate('document.getElementById("list-coverage").hidden'));
  const track=await evaluate('(()=>{const r=document.getElementById("message-list").getBoundingClientRect();return {x:r.right-6,y:r.top+12};})()');
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...track,button:'left',clickCount:1});await delay(100);
  await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:track.x,y:track.y+100,button:'left',buttons:1});await delay(100);
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:track.x,y:track.y+100,button:'left',clickCount:1});
  await delay(100);assert(await evaluate('document.getElementById("message-list").scrollTop>0'),'scrollbar thumb is draggable');
  await evaluate('document.getElementById("message-list").scrollTop=0');
  await evaluate('document.getElementById("select-visible").focus()');
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
  assert.equal(await evaluate('fixture.state.selectedIds.length'),200);await shot('selection');
  await evaluate('document.getElementById("select-visible").click()');assert.equal(await evaluate('fixture.state.selectedIds.length'),0);
  await evaluate('document.querySelector(".row-check").click()');assert(await evaluate('document.getElementById("select-visible").indeterminate'));
  await evaluate('document.getElementById("list-filter").value="Project";document.getElementById("list-filter").dispatchEvent(new Event("input"));document.getElementById("select-visible").click()');
  assert.equal(await evaluate('fixture.state.selectedIds.length'),67);
  await evaluate('document.getElementById("filter-chip").click();document.getElementById("list-next").click()');await delay(200);
  assert.equal(await evaluate('fixture.state.listOffset'),200);assert.equal(await evaluate('fixture.state.selectedIds.length'),0);
  assert.equal(await evaluate('document.getElementById("list-page-status").textContent'),'201–400 / 4,479 downloaded');await shot('page-two');
  await evaluate('document.getElementById("list-sync-more").click()');await delay(100);assert(await evaluate('fixtureCalls.some(c=>c.channel==="mail:listFromNetwork"&&c.p.offset===200)'));
  await evaluate('fixture.sync("syncing")');assert(await evaluate('document.getElementById("refresh").disabled && document.getElementById("list-sync-more").disabled'));await shot('syncing');
  await evaluate('fixture.sync("paused")');assert(!(await evaluate('document.getElementById("refresh").disabled')));
  await evaluate('fixture.state.listSyncDone=true;fixture.paint()');assert(await evaluate('document.getElementById("list-sync-more").hidden'));
  await evaluate('fixture.state.query="sample";fixture.paint()');assert(await evaluate('document.getElementById("list-paging").hidden'));
  await evaluate('fixture.state.query="";fixture.state.view="log";fixture.paint()');assert(await evaluate('document.getElementById("sync-control").parentElement.id==="page-refresh-slot"'));
  await evaluate('fixture.state.view="mail";fixture.state.listSyncDone=false;fixture.sync("done")');
  await cdp('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'},{name:'prefers-reduced-motion',value:'reduce'}]});await shot('high-contrast');
  assert.equal(await evaluate('getComputedStyle(document.getElementById("message-list")).scrollbarColor'),'auto');
  await cdp('Emulation.setEmulatedMedia',{features:[]});
  await evaluate('document.querySelectorAll("#list-chips button")[1].click()');await delay(200);
  assert.equal(await evaluate('fixture.state.folderId'),'sent');assert.equal(await evaluate('fixture.state.listOffset'),0);
  await evaluate('document.querySelector(`button.folder[data-account-id="beta"][data-folder-id="inbox"]`).click()');await delay(200);
  assert.equal(await evaluate('fixture.state.accountId'),'beta');
  assert(await evaluate('fixture.state.emails.every(e=>e.accountId==="beta" && e.folderId==="inbox")'));

 }
 await cdp('Emulation.setDeviceMetricsOverride',{width:720,height:1000,deviceScaleFactor:1,mobile:false});await shot('narrow');
 if(revised){assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'));assert(await evaluate('document.getElementById("message-list").clientHeight>=64'));}
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({source:root,revised,errors,checks:revised?'keyboard Space selection, tri-state, filter, pagination, history loading, busy/paused/completed sync, search, refresh relocation, high contrast, narrow overflow':'baseline screenshots'},null,2));
 console.log('Inbox browser QA passed: '+output);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{socket?.close();browser?.kill();server.close();});
