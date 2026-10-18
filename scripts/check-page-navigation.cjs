// Offline full-entry-point checks. Assert work avoided and navigation behavior,
// never machine-dependent latency. No real providers or mailbox writes.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-page-check-'));
app.setPath('userData', path.join(temp, 'profile'));
app.disableHardwareAcceleration();
const preload = path.join(temp, 'preload.cjs');
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('morrow',{invoke:(channel,payload)=>ipcRenderer.invoke('fixture:invoke',channel,payload),on:()=>{}});`);
const accounts = ['gmail', 'outlook'].map((provider, i) => ({ id: 'box-' + i, email: provider + '@example.test',
  platform: 'imap', authKind: 'oauth2', imapSmtpProfile: provider, folders: { primary: [{ id: 'Inbox', name: 'Inbox', wellKnownName: 'inbox' }], more: [] } }));
const providerFolders = [{ id: 'parent', name: 'Projects', editable: true }, { id: 'child', name: 'Projects/Work', editable: true, parentFolderId: 'parent' }];
const calls = [];
const routes = new Map();
const calendarRequests = [];
const statusRequests = [];
const ok = data => ({ success: true, data });
let providerGranted = true;
ipcMain.handle('fixture:invoke', async (_event, channel, payload) => {
  calls.push({ channel, payload });
  if (routes.has(channel)) return routes.get(channel)(payload);
  if (channel === 'app:getVersion') return new Promise(() => {}); // Boot wired; suspend unrelated startup reads.
  if (channel === 'host:aiGetConfig') return { hasKey: false, baseUrl: 'https://example.test', model: 'fixture' };
  if (channel.startsWith('host:update')) return { downloaded: true, version: 'fixture', lastCheckedAt: Date.now() };
  if (channel === 'mail:listAccounts') return ok(accounts);
  if (channel === 'mail:listFromCache' || channel === 'mail:listFromNetwork') return ok({ emails: [] });
  if (channel === 'mail:listSnoozed') return ok({ records: [] });
  if (channel === 'mail:listProviderFolders') return ok(providerGranted ? { api: true, folders: providerFolders } : { api: false, reason: 'scope_missing', folders: [] });
  if (channel === 'mail:grantOrganize') { providerGranted = true; return ok({ granted: true }); }
  if (channel === 'mail:oauthStatus') return ok({ google: true, accounts: accounts.map(row => ({ id: row.id, calendar: true })) });
  if (channel === 'mail:vacationGet') return ok({ accountId: payload.accountId, provider: 'google', supported: true, settings: { mode: 'disabled' } });
  if (channel === 'bot:getAccess') return ok({ accounts: [], grants: [], drafts: [], listen: {} });
  if (channel === 'calendar:status') return new Promise(resolve => statusRequests.push(resolve));
  if (channel === 'calendar:list') return new Promise((resolve, reject) => calendarRequests.push({ payload, resolve, reject }));
  return ok({});
});
const count = channel => calls.filter(row => row.channel === channel).length;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const run = code => win.webContents.executeJavaScript(code, true);
async function waitFor(code) {
  for (let i = 0; i < 200; i++) { if (await run(code)) return; await sleep(25); }
  throw new Error('Timed out: ' + code);
}
async function waitCalls(channel, expected) {
  for (let i = 0; i < 200; i++) { if (count(channel) >= expected) return; await sleep(25); }
  throw new Error('Missing ' + channel + ' call ' + expected);
}
function resolveMonth(index, title = 'Fixture event') {
  const request = calendarRequests[index];
  const start = request.payload.timeMin;
  request.resolve(ok({ api: true, calendarId: 'primary', calendars: [{ id: 'primary', name: 'Fixture calendar' }],
    events: [{ id: 'event-' + index, title, start, end: new Date(Date.parse(start) + 3600000).toISOString(), calendarId: 'primary' }] }));
}
async function shot(name) {
  if (!process.env.MORROW_UX_EVIDENCE_DIR) return;
  await run(`Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>null)`);
  await run(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(null))))`);
  fs.mkdirSync(process.env.MORROW_UX_EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.MORROW_UX_EVIDENCE_DIR, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, cb) => cb({ cancel: true }));
  win = new BrowserWindow({ width: 1180, height: 820, show: true, webPreferences: { preload, contextIsolation: true, sandbox: true } });
  await win.loadFile(path.join(__dirname, '../renderer/index.html'));
  await run(`state.accounts=${JSON.stringify(accounts)};state.accountId='box-0';state.folderId='Inbox';
    refreshMailVacation=()=>{};loadShellPrefs=async()=>{};refreshAiSetupState=async()=>{};
    renderAccounts();showStatus('');`);
  calls.length = 0;
  const immediate = await run(`(()=>{openSettings();return {open:$('settings').open,options:$('settings-account').options.length};})()`);
  assert.deepEqual(immediate, { open: true, options: 0 }, 'dialog opens before deferred mailbox paint');
  await waitFor(`settingsFoldLoaded.has('prefs:')`);
  assert.equal(calls.length, 0, 'opening Preferences reuses saved prefs and loads no closed folds');
  await run(`window.settingsOption=$('settings-account').firstElementChild;openSettings();`);
  assert.equal(await run(`settingsOption===$('settings-account').firstElementChild`), true);
  let finishAi;
  routes.set('host:aiGetConfig', () => new Promise(resolve => { finishAi = resolve; }));
  await run(`setSettingsFold('ai',true,true);setSettingsFold('ai',true,true);`);
  await waitCalls('host:aiGetConfig', 1);
  assert.equal(count('host:aiGetConfig'), 1, 'repeated fold activation coalesces reads');
  assert.equal(await run(`$('settings-ai-panel').inert`), true, 'late config cannot overwrite edits made during loading');
  finishAi({ hasKey: false, baseUrl: 'https://example.test', model: 'fixture' });
  await waitFor(`settingsFoldLoaded.has('ai:')`);
  await run(`$('ai-model').value='Unsaved choice';setSettingsFold('prefs',true,false);setSettingsFold('ai',true,false);`);
  assert.equal(await run(`$('ai-model').value`), 'Unsaved choice');
  assert.equal(count('host:aiGetConfig'), 1);
  await run(`setSettingsFold('ooo',true,false)`);
  await waitFor(`settingsFoldLoaded.has('ooo:box-0')`);
  assert.equal(count('mail:vacationGet'), 1);
  assert.equal(count('bot:getAccess'), 0);
  await shot('settings-lazy');
  await run(`$('settings').close();`);

  // Provider management lives on its own primary page, including drag listeners.
  calls.length = 0;
  await run(`$('rail-folders').click()`);
  await waitFor(`$('provider-content').querySelectorAll('.provider-row').length===2`);
  assert.equal(await run(`$('folders').querySelector('.provider-block')`), null);
  assert.equal(await run(`$('shell').hidden && !$('provider-panel').hidden`), true);
  assert.equal(await run(`$('provider-content').querySelector('[data-nest-drag="1"]')!==null`), true);
  await run(`window.providerRow=$('provider-content').querySelector('.provider-row');paintProviderPage();`);
  assert.equal(await run(`providerRow.isConnected`), true);
  await run(`const input=$('provider-content').querySelector('input');input.value='Projects/New';input.form.requestSubmit();`);
  await waitCalls('mail:createProviderFolder', 1);
  assert.deepEqual(calls.find(row => row.channel === 'mail:createProviderFolder').payload, { accountId: 'box-0', name: 'Projects/New', parentId: '' });
  await waitFor(`!state.busy`);
  await run(`const row=$('provider-content').querySelector('[data-nest-drag="1"]');
    row.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:new DataTransfer()}));`);
  assert.equal(await run(`state.dragFolder?.accountId`), 'box-0');
  await run(`$('provider-content').dispatchEvent(new DragEvent('dragend',{bubbles:true}));`);
  assert.equal(await run(`state.dragFolder`), null);
  await shot('folders-labels');
  providerGranted = false;
  await run(`loadProviderFolders(accountGen)`);
  await run(`$('provider-content').querySelector('.provider-grant').click()`);
  await waitCalls('mail:grantOrganize', 1);
  await waitFor(`!state.busy && $('provider-content').querySelector('.provider-row')!==null`);
  await run(`$('provider-account').value='box-1';$('provider-account').dispatchEvent(new Event('change'))`);
  await waitFor(`!state.busy && state.providerFolders?.accountId==='box-1'`);
  assert.equal(await run(`$('provider-content').querySelector('select').options.length`), 3, 'Outlook retains parent folder creation');
  assert.equal(await run(`$('folders').querySelector('.provider-block')`), null);

  // Calendar paints without waiting for status, coalesces list reads, and keeps DOM.
  calls.length = 0;
  await run(`state.calendarAccountId='box-0';state.calendarCursor=new Date(2026,9,1);showCalendar();`);
  assert.equal(await run(`$('calendar-panel').hidden`), false);
  await waitCalls('calendar:list', 1);
  await run(`void loadCalendar();void loadCalendar();`);
  assert.equal(count('calendar:list'), 1);
  assert.equal(count('calendar:status'), 1);
  resolveMonth(0);
  await waitFor(`$('calendar-body').querySelector('.calendar-event')!==null`);
  assert.equal(statusRequests.length, 1, 'events paint while status is still unresolved');
  await run(`window.grid=$('calendar-body').firstElementChild;window.eventButton=$('calendar-body').querySelector('.calendar-event');
    window.calendarOption=$('calendar-account').firstElementChild;eventButton.focus();eventButton.click();`);
  assert.equal(await run(`grid.isConnected && eventButton.isConnected && document.activeElement===eventButton`), true, 'selecting an event retains month and focus');
  await run(`showMail();showCalendar();`);
  await waitFor(`!calendarOpenScheduled`);
  assert.equal(count('calendar:list'), 1, 'fresh month cache avoids reopening IPC');
  assert.equal(await run(`grid===$('calendar-body').firstElementChild && eventButton.isConnected && calendarOption===$('calendar-account').firstElementChild`), true);
  await run(`void loadCalendar()`);
  await waitCalls('calendar:list', 2);
  // Return the identical event identity/data to exercise unchanged refresh.
  await run(`showMail();showCalendar()`);
  await waitFor(`!calendarOpenScheduled`);
  assert.equal(count('calendar:list'),2,'reopening joins the pending refresh');
  calendarRequests[1].resolve(ok({...await run(`state.calendarPayload`),truncated:true}));
  await waitFor(`!$('calendar-panel').hasAttribute('aria-busy') && state.calendarPayload.truncated`);
  assert.equal(await run(`grid.isConnected && eventButton.isConnected`), true);
  await run(`shiftMonth(1);shiftMonth(1);`);
  await waitCalls('calendar:list', 4);
  resolveMonth(2, 'Stale month');
  await sleep(30);
  assert.equal(await run(`state.calendarPayload?.events?.some(e=>e.title==='Stale month')`), false);
  resolveMonth(3, 'Current month');
  await waitFor(`$('calendar-agenda').textContent.includes('Current month')`);
  assert.match(await run(`$('calendar-heading').textContent`), /December 2026/);
  await run(`void loadCalendar()`);
  await waitCalls('calendar:list', 5);
  calendarRequests[4].reject(new Error('Offline fixture'));
  await waitFor(`$('calendar-status').textContent.includes('Showing the saved month')`);
  assert.match(await run(`$('calendar-agenda').textContent`), /Current month/);
  await shot('calendar-cached');
  await run(`shiftMonth(1);$('calendar-account').value='box-1';$('calendar-account').dispatchEvent(new Event('change'));`);
  await waitCalls('calendar:list', 7);
  resolveMonth(5, 'Old account');resolveMonth(6, 'New account');
  await waitFor(`$('calendar-agenda').textContent.includes('New account')`);
  assert.doesNotMatch(await run(`$('calendar-agenda').textContent`), /Old account/);
  await run(`shiftMonth(1)`);
  await waitCalls('calendar:list',8);
  await run(`state.accounts=state.accounts.filter(a=>a.id!=='box-1');`);
  resolveMonth(7,'Removed account');
  await sleep(30);
  assert.equal(await run(`state.calendarPayload?.events?.some(e=>e.title==='Removed account')`),false);
  await run(`showMail();showCalendar()`);
  await waitCalls('calendar:list',9);
  assert.equal(calendarRequests[8].payload.calendarId,undefined,'removed mailbox cannot leak its calendar selection');
  resolveMonth(8,'Remaining account');
  await waitFor(`$('calendar-agenda').textContent.includes('Remaining account')`);
  statusRequests.forEach(resolve => resolve(ok({ google: true, accounts: accounts.map(row => ({ id: row.id, calendar: true })) })));

  // One outer Agent scroller; all tabs and long skill/history content are reachable.
  await run(`showPrimary('agent','agent-panel');
    for(const id of ['agent-home','agent-tools']){const p=document.createElement('p');p.textContent='Long fixture content '.repeat(1000);$(id).append(p);}
    agentTurns=Array.from({length:50},(_,i)=>({role:'user',text:'Saved turn '+i}));paintThread();
    window.turn=$('agent-sections').firstElementChild;paintThread();`);
  assert.equal(await run(`turn.isConnected`), true, 'unchanged transcript retains DOM');
  for (const name of ['home', 'conversation', 'tools']) {
    await run(`$('agent-tab-${name}').click()`);
    assert.equal(await run(`$('agent-tab-${name}').getAttribute('aria-selected')`), 'true');
    const scrollers = await run(`[...$('agent-panel').querySelectorAll('*')].filter(n=>!n.closest('[hidden]')&&n.tagName!=='TEXTAREA'&&['auto','scroll'].includes(getComputedStyle(n).overflowY)&&n.scrollHeight>n.clientHeight+1).map(n=>n.id||n.className)`);
    assert.deepEqual(scrollers, [], 'tab content has no competing scroll containers');
  }
  assert.equal(await run(`getComputedStyle($('agent-panel')).overflowY`), 'auto');
  await run(`$('agent-tab-tools').focus();$('agent-tab-tools').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))`);
  assert.equal(await run(`agentTab`), 'conversation');
  await run(`$('agent-panel').scrollTop=100;window.savedScroll=$('agent-panel').scrollTop;showAgentTab('conversation')`);
  assert.equal(await run(`$('agent-panel').scrollTop===savedScroll && savedScroll>0`),true,'staying in Conversation preserves reading position');
  await shot('agent-single-scroll');
  win.setSize(800,600);
  await run(`showAgentTab('tools')`);
  assert.equal(await run(`$('agent-panel').scrollWidth<=$('agent-panel').clientWidth+1`), true);

  // Sync success stays next to Sync and disappears when old. About is shared.
  await run(`showMail();showStatus('');rememberSyncStatus({accountId:state.accountId,folderId:state.folderId,state:'done',lastSuccessAt:Date.now(),updatedAt:Date.now()});paintSyncControl();`);
  assert.match(await run(`$('sync-detail').textContent`), /Synced/);
  assert.equal(await run(`$('status').textContent`), '');
  assert.equal(await run(`$('sync-detail').parentElement===$('refresh').parentElement`), true);
  await run(`currentFolderSync().updatedAt=1;paintSyncControl();`);
  assert.equal(await run(`$('sync-detail').hidden`), true);
  assert.equal(await run(`$('rail-log').nextElementSibling.id`), 'rail-about');
  await run(`$('rail-about').click()`);
  await waitFor(`!$('about-update-install').hidden`);
  assert.equal(await run(`$('about-dialog').open`), true);
  assert.equal(await run(`$('updates')===null && $('update-check')===null`), true);
  await run(`$('about-update-check').click()`);
  await waitCalls('host:updateCheck', 1);
  await run(`$('about-dialog').close();openSettings();$('settings-about').click();`);
  assert.equal(await run(`$('about-dialog').open`), true);
  await shot('about-rail');
  console.log(JSON.stringify({ settingsOpen: immediate, preferenceOpenReads: 0, calendarListReads: calendarRequests.length,
    retainedMonthAndSelection: true, agentScrollContainers: 1, providerPage: true, singleUpdater: true }, null, 2));
  console.log('PAGE_NAVIGATION_CHECK_OK');
  app.exit(0);
}).catch(error => { console.error(error.stack || error); app.exit(1); });
