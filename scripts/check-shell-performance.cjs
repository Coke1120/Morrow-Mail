// Offline Electron profile and behavior checks; no mailbox or provider writes.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-shell-profile-'));
app.setPath('userData', path.join(temp, 'profile'));
app.disableHardwareAcceleration();
const baseline = process.argv.includes('--baseline');
const out = process.env.MORROW_UX_EVIDENCE_DIR;
let win;
const run = code => win.webContents.executeJavaScript(code, true);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function metrics() {
  const result = await win.webContents.debugger.sendCommand('Performance.getMetrics');
  return Object.fromEntries(result.metrics.map(({ name, value }) => [name, value]));
}
async function profile(name, code) {
  const before = await metrics();
  const result = await run(code);
  await sleep(300);
  const after = await metrics();
  return { name, result, layoutCount: after.LayoutCount - before.LayoutCount,
    layoutMs: +(1000 * (after.LayoutDuration - before.LayoutDuration)).toFixed(2),
    styleMs: +(1000 * (after.RecalcStyleDuration - before.RecalcStyleDuration)).toFixed(2) };
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true }));
  win = new BrowserWindow({ width: 1180, height: 820, show: true, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Performance.enable');
  await run(`
    window.fixtureCalls = {};
    call = async (channel, params) => {
      fixtureCalls[channel] = (fixtureCalls[channel] || 0) + 1;
      if (channel === 'mail:listAccounts') return state.accounts;
      if (channel === 'mail:listFromCache' || channel === 'mail:listFromNetwork') return {emails: state.emails};
      if (channel === 'mail:listSnoozed') return {records:[]};
      if (channel === 'mail:listProviderFolders') return {api:false,folders:[]};
      if (channel === 'mail:vacationGet') return {accountId:params.accountId,supported:true,settings:{mode:'disabled'}};
      if (channel === 'host:getDebugLog') return {lines:[]};
      return null;
    };
    wire();
    setNavCollapsed(false);
    // No preload is used: stub configuration reads that dialog close hooks make.
    refreshAiSetupState = async () => {};
    loadLook = async () => {};
    loadShellPrefs = async () => {};
    showStatus("");
    state.accountId = 'fixture'; state.folderId = 'Inbox';
    state.accounts = [{id:'fixture',email:'fixture@example.test',platform:'imap',imapSmtpProfile:'custom',folders:{
      primary:[{id:'Inbox',name:'Inbox',wellKnownName:'inbox'}],
      more:Array.from({length:150},(_,i)=>({id:'folder-'+i,name:'Folder '+i}))}}];
    state.emails = Array.from({length:500},(_,i)=>({id:'message-'+i,accountId:'fixture',folderId:'Inbox',
      from:'Sender '+i+' <sender@example.test>',subject:'Message '+i,snippet:'Preview text '+i,date:'2026-10-19T08:00:00Z',unread:i%2===0}));
    renderAccounts(); renderList();
  `);
  await sleep(400);
  const report = [];
  report.push(await profile('500-row selection', `(() => {
    const original = document.querySelector('.message-row');
    const observer = new MutationObserver(()=>{}); observer.observe($('messages'),{childList:true});
    const started = performance.now();
    for(let i=0;i<10;i++) commitSelection({ids:['message-'+i],anchor:'message-'+i});
    const ms = performance.now()-started;
    const removed = observer.takeRecords().reduce((sum,row)=>sum+row.removedNodes.length,0); observer.disconnect();
    return {ms, removed, retained:original===document.querySelector('.message-row')};
  })()`));
  report.push(await profile('unchanged sidebar', `(() => {
    const original = $('folders').firstElementChild; const started = performance.now();
    for(let i=0;i<10;i++) renderAccounts();
    return {ms:performance.now()-started,retained:original===$('folders').firstElementChild};
  })()`));
  report.push(await profile('drag hover same folder', `(() => {
    const target=$('folders').querySelector('[data-drop-kind]');
    state.dragMessage={id:'message-0',accountId:'fixture',folderId:'Inbox'};
    const observer=new MutationObserver(()=>{});observer.observe($('folders'),{subtree:true,attributes:true,attributeFilter:['class']});
    const started=performance.now();
    for(let i=0;i<100;i++)onFolderDragOver({target,preventDefault(){},dataTransfer:{}});
    const changes=observer.takeRecords().length;observer.disconnect();clearDropTargets();state.dragMessage=null;
    return {ms:performance.now()-started,changes};
  })()`));
  await run(`openDialog('settings');wireSettingsFolds();`); await sleep(300);
  report.push(await profile('settings accordion', `(async()=>{
    setSettingsFold('ai',true,true);await new Promise(r=>setTimeout(r,300));
    const panel=document.querySelector('#settings .fold[data-fold="ai"] .fold-panel');
    const before=panel.getBoundingClientRect().height;
    const extra=document.createElement('div');extra.style.height='200px';panel.append(extra);
    const grew=panel.getBoundingClientRect().height-before;extra.remove();
    return {height:panel.style.height,overflow:panel.style.overflow,grew};
  })()`));
  await run(`$('settings').close();`);
  report.push(await profile('rail navigation', `(async()=>{
    const samples=[];
    for(const [view,id] of [['agent','agent-panel'],['calendar','calendar-panel'],['brain','brain'],['mail','shell']]){
      showPrimary(view,id);await new Promise(r=>setTimeout(r,220));
      samples.push({view,animations:$(id).getAnimations({subtree:true}).length,opacity:getComputedStyle($(id)).opacity});
    }return samples;
  })()`));
  report.push(await profile('background mail notification burst', `(async()=>{
    fixtureCalls={};for(let i=0;i<10;i++)scheduleReload();await new Promise(r=>setTimeout(r,450));return fixtureCalls;
  })()`));
  const ooo = await run(`(async()=>{
    rememberVacation({accountId:'fixture',supported:true,settings:{mode:'disabled'}});
    const off=$('mail-ooo').getBoundingClientRect().height;
    rememberVacation({accountId:'fixture',supported:true,settings:{mode:'always'}});
    const on=$('mail-ooo').getBoundingClientRect().height;
    rememberVacation({accountId:'fixture',supported:true,settings:{mode:'disabled'}});
    return {off,on};
  })()`);
  if(out){fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'ooo-off.png'),(await win.webContents.capturePage()).toPNG());}
  const log = await run(`(()=>{
    showPrimary('log','log-panel');
    paintLog(Array.from({length:200},(_,i)=>({at:Date.now(),source:'sync',text:'Log '+i+' '+('long-value-'.repeat(40))})));
    const panel=$('log-panel'), list=$('log-lines');return {panelWidth:panel.clientWidth,panelScroll:panel.scrollWidth,
      panelBottom:panel.getBoundingClientRect().bottom,viewport:innerHeight,listHeight:list.clientHeight,listScroll:list.scrollHeight};
  })()`);
  await sleep(300);
  if(out)fs.writeFileSync(path.join(out,'log.png'),(await win.webContents.capturePage()).toPNG());
  const behavior = baseline ? null : await run(`(async()=>{
    showMail();
    const row=document.querySelector('.message-row');const button=row.querySelector('.message');button.focus();
    commitSelection({ids:['message-0','message-1'],anchor:'message-0'});
    const focused=document.activeElement===button;
    state.emails[0]={...state.emails[0],subject:'Changed subject',isStarred:true};renderList();
    const updated=document.querySelector('.message-row').textContent.includes('Changed subject');
    $('list-filter').value='Message 499';renderList();
    const filtered=document.querySelectorAll('.message-row').length===1&&document.querySelector('.message-row').dataset.emailId==='message-499';
    $('list-filter').value='';renderList();
    const last=document.querySelector('[data-email-id="message-499"] button.message');last.focus();
    const reachedLast=document.activeElement===last&&last.getBoundingClientRect().bottom<=$('messages').getBoundingClientRect().bottom+2;
    openDialog('settings');setSettingsFold('ai',true,true);setSettingsFold('mailbox',true,true);setSettingsFold('prefs',true,true);
    await new Promise(r=>setTimeout(r,220));
    const folds=[...document.querySelectorAll('#settings .fold')].every(f=>f.querySelector('.fold-panel').hidden!==f.classList.contains('is-open'));
    $('settings').close();
    mailVacation.set('fixture',{error:true,at:Date.now()});paintMailVacation();
    const oooError=!$('mail-ooo').classList.contains('is-off')&&!$('mail-ooo-refresh').hidden;
    fixtureCalls={};showPrimary('log','log-panel');for(let i=0;i<100;i++)pushDebug('sync','burst '+i);
    await new Promise(r=>setTimeout(r,300));const logReads=fixtureCalls['host:getDebugLog']||0;
    const originalCall=call;let finishNetwork;let networkStarted=false;
    call=(channel,params)=>channel==='mail:listFromNetwork'
      ? (networkStarted=true,new Promise(resolve=>{finishNetwork=resolve;})) : originalCall(channel,params);
    const picked=selectFolder('fixture','Inbox');
    const cacheFirst=await Promise.race([picked.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),200))]);
    finishNetwork?.({emails:state.emails});await picked;call=originalCall;
    showPrimary('log','log-panel');
    return {focused,updated,filtered,reachedLast,folds,oooError,logReads,cacheFirst,networkStarted};
  })()`);
  // A short, narrow Windows-sized viewport must retain a scrollable log body.
  win.setSize(800,600);await sleep(100);
  const narrow=await run(`(()=>{const p=$('log-panel'),l=$('log-lines');return {width:p.clientWidth,scroll:p.scrollWidth,height:l.clientHeight,bottom:p.getBoundingClientRect().bottom,viewport:innerHeight};})()`);
  if(out)fs.writeFileSync(path.join(out,'log-narrow.png'),(await win.webContents.capturePage()).toPNG());
  if(!baseline){
    assert.ok(Object.entries(behavior).filter(([key])=>key!=='logReads').every(([,value])=>value),JSON.stringify(behavior));
    assert.equal(behavior.logReads,1,'sync log bursts must coalesce reads');
    assert.ok(narrow.scroll<=narrow.width+1&&narrow.height>40&&narrow.bottom<=narrow.viewport,'short log viewport must fit');
  }
  console.log(JSON.stringify({baseline,report,ooo,log,behavior,narrow},null,2));
  if(!baseline){
    assert.equal(report[0].result.retained,true,'selection must retain existing rows');
    assert.equal(report[0].result.removed,0,'selection must not rebuild rows');
    assert.equal(report[1].result.retained,true,'unchanged sidebar must retain nodes');
    assert.ok(report[2].result.changes<=2,'hovering the same drop target must not churn classes');
    assert.equal(report[3].result.height,'','fold must return to natural height');
    assert.ok(report[3].result.grew>=199,'loaded settings must not be clipped');
    assert.ok(report[4].result.every(row=>row.animations===0&&row.opacity==='1'),'navigation must settle promptly');
    assert.equal(report[5].result['mail:listProviderFolders']||0,0,'mail changes must not reload provider folders');
    assert.ok(ooo.off<=48&&ooo.on>ooo.off,'disabled OOO must be compact');
    assert.ok(log.panelScroll<=log.panelWidth+1&&log.panelBottom<=log.viewport,'log must stay inside viewport');
    assert.ok(log.listScroll>log.listHeight,'log lines must scroll within the page');
  }
  console.log(baseline?'SHELL_PROFILE_BASELINE':'SHELL_PERFORMANCE_CHECK_OK');
  app.exit(0);
}).catch(error=>{console.error(error.stack||error);app.exit(1);});
