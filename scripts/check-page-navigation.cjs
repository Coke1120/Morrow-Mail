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
// Keep the pending IPC reply alive across renderer GC; boot must remain paused
// while navigation checks measure only the work caused by their own actions.
const startupWaiters = [];
const ok = data => ({ success: true, data });
let providerGranted = true;
ipcMain.handle('fixture:invoke', async (_event, channel, payload) => {
  calls.push({ channel, payload });
  if (routes.has(channel)) return routes.get(channel)(payload);
  const preference = require('../host/settings').answer(channel, [payload]);
  if (preference !== undefined) return preference;
  if (channel === 'app:getVersion') return new Promise(resolve => startupWaiters.push(resolve));
  if (channel === 'host:aiGetConfig') return { hasKey: false, baseUrl: 'https://example.test', model: 'fixture' };
  if (channel.startsWith('host:update')) return { downloaded: true, version: 'fixture', lastCheckedAt: Date.now() };
  if (channel === 'mail:listAccounts') return ok(accounts);
  if (channel === 'mail:listFromCache' || channel === 'mail:listFromNetwork') return ok({ emails: [] });
  if (channel === 'mail:listSnoozed') return ok({ records: [] });
  if (channel === 'mail:listProviderFolders') return ok(providerGranted ? { api: true, folders: providerFolders } : { api: false, reason: 'scope_missing', folders: [] });
  if (channel === 'mail:grantOrganize') { providerGranted = true; return ok({ granted: true }); }
  if (channel === 'mail:oauthStatus') return ok({ google: true, accounts: accounts.map(row => ({ id: row.id, calendar: true })) });
  if (channel === 'mail:vacationGet') return ok({ accountId: payload.accountId, provider: 'google', supported: true, canWrite: true,
    revision: 'fixture', settings: { mode: 'disabled', subject: 'Away', message: 'I will reply when I return.', audience: 'contacts' } });
  if (channel === 'bot:getAccess') return ok({ accounts: [], grants: [], drafts: [], listen: {} });
  if (channel === 'calendar:status') return new Promise(resolve => statusRequests.push(resolve));
  if (channel === 'calendar:list') return new Promise((resolve, reject) => calendarRequests.push({ payload, resolve, reject }));
  return ok({});
});
const count = channel => calls.filter(row => row.channel === channel).length;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const run = code => win.webContents.executeJavaScript(code, true);
async function key(keyCode) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  if (keyCode === 'RETURN') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  if (keyCode === 'SPACE') win.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  await sleep(50);
}
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
  await waitCalls('app:getVersion', 1);
  assert.equal(startupWaiters.length, 1, 'startup is held at the version barrier');
  assert.equal(count('host:updateGetState'), 0, 'startup must not advance past the barrier');
  await run(`state.accounts=${JSON.stringify(accounts)};state.accountId='box-0';state.folderId='Inbox';
    refreshMailVacation=()=>{};loadShellPrefs=async()=>{};refreshAiSetupState=async()=>{};
    renderAccounts();showStatus('');`);
  calls.length = 0;
  const immediate = await run(`(()=>{openSettings();return {open:$('settings').open,options:$('settings-account').options.length};})()`);
  assert.deepEqual(immediate, { open: true, options: 0 }, 'dialog opens before deferred mailbox paint');
  await waitFor(`settingsFoldLoaded.has('prefs:')`);
  assert.equal(calls.length, 0, 'opening Preferences reuses saved prefs and loads no closed folds');
  assert.equal(await run(`document.querySelectorAll('#settings [role="tabpanel"]:not([hidden])').length`), 1);
  assert.equal(await run(`$('settings-log')===null && $('settings-about')===null`), true, 'rail links are not duplicated');
  await run(`$('settings-tab-prefs').focus();$('settings-tab-prefs').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));`);
  await waitFor(`settingsFoldLoaded.has('mail:')`);
  assert.equal(await run(`document.activeElement.id`), 'settings-tab-mail');
  assert.equal(await run(`$('settings-tab-mail').getAttribute('aria-selected')`), 'true');
  assert.equal(await run(`$('settings-prefs').hidden && !$('settings-mail').hidden && document.querySelector('.settings-account-context').hidden`), true);
  await key('LEFT');
  assert.equal(await run(`document.activeElement.id`), 'settings-tab-prefs');
  await key('RIGHT');
  assert.equal(await run(`document.activeElement.id`), 'settings-tab-mail');
  for (const days of [365, 0, 180]) {
    await run(`$('pref-sync-horizon').value='${days}';$('pref-sync-horizon').dispatchEvent(new Event('change'))`);
    await waitFor(`state.prefs.syncHorizon===${days} && $('settings-status').textContent.includes('Sync history saved')`);
    assert.equal(require('../host/settings').syncHorizonDays(), days, 'UI preference reaches settings.json');
  }
  await shot('settings-mail-sync');
  await run(`$('settings').close();openSettings()`);
  await waitFor(`settingsFoldLoaded.has('mail:')`);
  assert.equal(await run(`$('settings-tab-mail').getAttribute('aria-selected')`), 'true', 'reopen remembers the tab');
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
  routes.delete('host:aiGetConfig');
  await shot('settings-ai');
  await run(`setSettingsFold('ooo',true,false)`);
  await waitFor(`settingsFoldLoaded.has('ooo:box-0')`);
  assert.equal(count('mail:vacationGet'), 1);
  assert.equal(count('bot:getAccess'), 0);
  await run(`$('settings-tab-ooo').focus();$('settings-tab-ooo').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));`);
  await waitFor(`settingsFoldLoaded.has('bot:')`);
  assert.equal(await run(`document.activeElement.id`), 'settings-tab-bot');
  await run(`$('settings-tab-bot').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));`);
  assert.equal(await run(`document.activeElement.id`), 'settings-tab-prefs');
  assert.equal(await run(`document.querySelectorAll('#settings [role="tab"][tabindex="0"]').length`), 1);
  await key('TAB');
  assert.equal(await run(`document.activeElement.id`), 'settings-prefs', 'Tab enters the active panel');
  await shot('settings-general');
  await run(`setSettingsFold('ooo',true,false)`);
  await shot('settings-lazy');

  // Disclosures hide explanation, never consent or the reviewed provider write.
  await run(`$('ooo-mode').value='scheduled';$('ooo-mode').dispatchEvent(new Event('change'));`);
  assert.equal(await run(`$('ooo-start').checkVisibility() && $('ooo-end').checkVisibility() && $('ooo-timezone').checkVisibility()`), true);
  assert.equal(await run(`$('ooo-audience').checkVisibility() && !$('ooo-help').checkVisibility()`), true);
  await run(`$('ooo-details').querySelector('summary').focus()`);await key('RETURN');
  assert.equal(await run(`$('ooo-help').checkVisibility()`), true, 'provider details open from the keyboard');
  await key('RETURN');
  await run(`$('ooo-mode').value='always';$('ooo-mode').dispatchEvent(new Event('change'));$('ooo-save').click()`);
  await waitFor(`$('confirm').open`);
  assert.equal(count('mail:vacationSet'), 0, 'save still requires a review');
  await run(`$('confirm-cancel').click()`);await waitFor(`!$('confirm').open`);
  assert.equal(count('mail:vacationSet'), 0);
  await run(`setSettingsFold('mailbox',true,false)`);await waitFor(`settingsFoldLoaded.has('mailbox:box-0')`);
  assert.equal(await run(`$('settings-account').checkVisibility() && $('settings-reconnect').checkVisibility()`), true);
  assert.equal(await run(`$('settings-capabilities').checkVisibility() || $('remove').checkVisibility()`), false);
  await shot('settings-accounts');
  await run(`$('account-permissions').querySelector('summary').focus()`);await key('RETURN');
  assert.equal(await run(`$('settings-calendar').checkVisibility()`), true);
  await run(`$('account-recovery').querySelector('summary').focus()`);await key('SPACE');
  assert.equal(await run(`$('remove').checkVisibility()`), true);
  await run(`$('account-permissions').open=false;$('account-recovery').open=false;`);

  // Exercise the default grant payload, copy-once secret, and explicit enable.
  const botAccess = { enabled: false, accounts: accounts.map(a => ({ accountId: a.id, email: a.email })), grants: [], drafts: [], listen: {} };
  routes.set('bot:getAccess', () => ok(botAccess));
  routes.set('bot:mintGrant', payload => {
    const expiry = payload.expiry && payload.expiry.kind === 'never'
      ? { kind: 'never' }
      : { kind: 'finite', expiresAt: '2099-01-01T00:00:00.000Z' };
    botAccess.grants.push({ ...payload, clientId: 'fixture-client', live: true, expiry });
    return ok({ secret: 'SYNTHETIC SECRET FOR OFFLINE UI CHECK', access: botAccess });
  });
  routes.set('bot:setEnabled', payload => {
    botAccess.enabled = payload.enabled;
    botAccess.listen = { listening: payload.enabled, address: '127.0.0.1', port: 47831 };
    return ok(botAccess);
  });
  await run(`setSettingsFold('bot',true,false);loadBotAccess()`);
  assert.equal(await run(`$('settings-account').checkVisibility()`), false);
  assert.equal(await run(`$('bot-enabled').disabled`), true);
  assert.equal(await run(`$('bot-expiry').checkVisibility()`), false);
  assert.match(await run(`$('bot-listen').textContent`), /listener on this computer/);
  await shot('settings-bot-local');
  await run(`showBotSection('tailscale')`);
  assert.equal(await run(`$('bot-serve-host').checkVisibility()`), true);
  assert.match(await run(`$('bot-remote-status').textContent`), /Not checked/);
  assert.equal(await run(`$('bot-probe-conflict').hidden`), true);
  assert.equal(await run(`$('bot-probe').textContent.trim()`), 'Check connection');
  assert.match(await run(`$('bot-cmd-serve').textContent`), /--https=8443/);
  routes.set('bot:setServeHost', payload => {
    botAccess.serveHost = String(payload.serveHost || '').trim().toLowerCase();
    const port = (botAccess.serveHost.match(/:(\d+)$/) || [])[1] || '8443';
    botAccess.serveCommands = {
      port: Number(port),
      status: 'tailscale serve status',
      serve: `tailscale serve --bg --https=${port} --accept-app-caps=com.coke1120.morrow-mail/bot-access http://127.0.0.1:47831`,
    };
    botAccess.endpoints = {
      local: 'http://127.0.0.1:47831/api/bot/v1/call',
      serve: `https://${botAccess.serveHost}/api/bot/v1/call`,
    };
    return ok(botAccess);
  });
  routes.set('bot:probeServe', () => ok({
    state: 'foreign',
    serveHost: botAccess.serveHost,
    statusCode: 200,
    snippet: 'HTTP 200 · Phase',
    reason: '',
    endpoint: botAccess.endpoints && botAccess.endpoints.serve,
    commands: botAccess.serveCommands,
  }));
  await run(`$('bot-serve-host').value='leos-macbook-air.tail48056.ts.net:8443';$('bot-serve-save').click()`);
  await waitFor(`!botBusy && $('bot-endpoint').textContent.includes('leos-macbook-air')`);
  assert.match(await run(`$('bot-status').textContent`), /does not set up/);
  await run(`$('bot-probe').click()`);
  await waitFor(`!botBusy && !$('bot-probe-conflict').hidden`);
  assert.match(await run(`$('bot-probe-conflict').textContent`), /Another app is using this address/);
  assert.match(await run(`$('bot-probe-saw').textContent`), /HTTP 200 · Phase/);
  assert.match(await run(`$('bot-probe-conflict').textContent`), /Option A/);
  assert.match(await run(`$('bot-probe-conflict').textContent`), /Option B/);
  assert.match(await run(`$('bot-fix-serve').textContent`), /--https=8443/);
  assert.match(await run(`$('bot-fix-status').textContent`), /tailscale serve status/);
  assert.equal(await run(`$('bot-probe').textContent.trim()`), 'Check again');
  assert.equal(count('bot:probeServe'), 1);
  await run(`$('bot-probe-conflict').scrollIntoView({block:'center'})`);
  await shot('settings-bot-serve-conflict');
  await run(`showBotSection('grants')`);
  assert.equal(await run(`$('bot-add-client').open`), true);
  assert.deepEqual(await run(`selectedBotAccounts()`), [], 'mailbox access remains opt-in');
  await shot('settings-bot-first-run');
  await run(`$('bot-expiry').value='never';$('bot-label').value='My assistant';$('bot-accounts').querySelector('input').checked=true;$('bot-mint-btn').click()`);
  await waitFor(`$('confirm').open`);
  await run(`$('confirm-cancel').click()`);
  await waitFor(`!$('confirm').open`);
  assert.equal(count('bot:mintGrant'), 0, 'canceling no expiry writes nothing');
  await run(`$('bot-expiry').value='7';$('bot-grant-options').open=false;
    $('bot-label').value='My assistant';$('bot-accounts').querySelector('input').checked=true;$('bot-mint-btn').click()`);
  await waitFor(`$('bot-secret').open && !botBusy`);
  assert.deepEqual(calls.find(row => row.channel === 'bot:mintGrant').payload, { label: 'My assistant', accountIds: ['box-0'],
    capabilities: ['accounts.read','mail.headers.read','health.read','agent.proposals.read'], expiry: { kind: 'finite', days: 7 } });
  assert.equal(count('bot:setEnabled'), 0, 'creating a grant never enables access');
  await run(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.fixtureCopied=value;}}});$('bot-secret-copy').click()`);
  await waitFor(`$('bot-secret-status').textContent.startsWith('Copied.')`);
  assert.equal(await run(`fixtureCopied===$('bot-secret-value').textContent`), true);
  await shot('settings-bot-copy-secret');
  await run(`$('bot-secret-close').click()`);await waitFor(`!$('bot-secret').open && $('bot-secret-value').textContent===''`);
  assert.equal(await run(`$('bot-enabled').disabled || $('bot-enabled').checked`), false);
  await run(`$('bot-enabled').click()`);await waitFor(`!botBusy && $('bot-listen').textContent.includes('Listening on 127.0.0.1:47831')`);
  assert.equal(count('bot:setEnabled'), 1);
  // Extra permissions and a changed expiry still apply when their disclosure closes.
  await run(`$('bot-grant-options').open=true;$('bot-caps').querySelector('input').click();$('bot-expiry').value='30';
    $('bot-grant-options').open=false;$('bot-label').value='Text reader';$('bot-accounts').querySelector('input').checked=true;$('bot-mint-btn').click()`);
  await waitFor(`$('bot-secret').open && !botBusy`);
  const extraGrant = calls.filter(row => row.channel === 'bot:mintGrant').at(-1).payload;
  assert.deepEqual(extraGrant.expiry, { kind: 'finite', days: 30 });
  assert.deepEqual(extraGrant.capabilities, ['accounts.read','mail.headers.read','health.read','agent.proposals.read','mail.bodies.read']);
  await run(`$('bot-secret-close').click()`);await waitFor(`!$('bot-secret').open && $('bot-secret-value').textContent===''`);
  botAccess.drafts.push({proposalId:'fixture-proposal',subject:'Review this reply',to:['recipient@example.test'],bodyText:'Proposed text',status:'pending'});
  await run(`loadBotAccess()`);
  await run(`showBotSection('grants')`);
  assert.equal(await run(`$('bot-grants').querySelector('button').checkVisibility()`), true);
  assert.match(await run(`$('bot-panel-grants').textContent`), /Revoke stops its access and keeps the row/);
  assert.match(await run(`$('bot-panel-grants').textContent`), /Delete removes the row after you confirm/);
  assert.equal(await run(`$('bot-grants').querySelector('[data-bot-action="delete"]').textContent.trim()`), 'Delete');
  await run(`$('bot-grants').querySelector('[data-bot-action="delete"]').click()`);
  await waitFor(`$('confirm').open`);
  assert.match(await run(`$('confirm-body').textContent`), /removes the bot/);
  await run(`$('confirm-cancel').click()`);
  await waitFor(`!$('confirm').open && !botBusy`);
  assert.equal(count('bot:deleteGrant'), 0, 'canceling delete writes nothing');
  await run(`$('bot-grants').querySelector('[data-bot-action="delete"]').scrollIntoView({block:'center'})`);
  await shot('settings-bot-delete');
  await shot('settings-bot-advanced');
  const listening = botAccess.listen;
  botAccess.listen = { listening: false, error: 'port_in_use' };
  await run(`showBotSection('local');loadBotAccess().then(()=>setBotStatus(botListenerStatus(state.botAccess), true))`);
  await waitFor(`$('bot-listen').textContent.includes('Quit the other program using port 47831') && $('bot-status').textContent.includes('Could not start') && !$('bot-listen-fix').hidden`);
  assert.match(await run(`$('bot-listen').textContent`), /Could not start.*not listening/);
  assert.doesNotMatch(await run(`$('bot-listen').textContent`), /enabled|Listening on/);
  await run(`$('bot-listen-fix').scrollIntoView({block:'center'})`);
  await shot('settings-bot-port-conflict');
  botAccess.listen = listening;
  await run(`loadBotAccess()`);
  await run(`$('bot-review-link').click()`);
  assert.equal(await run(`$('bot-review').open && document.activeElement.id==='bot-draft-heading' && $('bot-drafts').checkVisibility()`), true);
  assert.equal(await run(`$('bot-drafts').querySelector('button').checkVisibility()`), true, 'the proposal review action remains reachable');
  await key('TAB');
  assert.equal(await run(`document.activeElement===$('bot-drafts').querySelector('button')`), true);
  assert.equal(count('mail:send'), 0, 'reviewing proposals never sends');
  await run(`$('bot-review').open=false;`);
  await run(`$('settings').close();`);

  // Discovery owns only fields that have not been deliberately edited.
  routes.set('mail:discoverMail', ({email}) => {
    const domain = email.split('@')[1];
    return ok({source:'srv', imap:{host:'imap.'+domain,port:993,tls:true},
      smtp:domain==='second.test'?null:{host:'smtp.'+domain,port:465,tls:true}});
  });
  await run(`openConnectFor(null);$('email').value='user@first.test';$('email').dispatchEvent(new Event('input'));`);
  await waitFor(`$('smtp-host').value==='smtp.first.test'`);
  await run(`$('email').value='user@second.test';$('email').dispatchEvent(new Event('input'));`);
  assert.equal(await run(`$('smtp-host').value`), '', 'address changes clear auto-filled SMTP immediately');
  await waitFor(`$('imap-host').value==='imap.second.test'`);
  assert.equal(await run(`$('smtp-host').value`), '', 'partial discovery keeps the missing server empty');
  await run(`$('imap-host').value='imap.manual.test';$('imap-host').dispatchEvent(new Event('input'));
    $('email').value='user@third.test';$('email').dispatchEvent(new Event('input'));`);
  await waitFor(`$('smtp-host').value==='smtp.third.test'`);
  assert.equal(await run(`$('imap-host').value`), 'imap.manual.test', 'manual IMAP is pinned independently');
  await run(`$('connect').close();openConnectFor(null);`);
  assert.equal(await run(`$('imap-host').value+$('smtp-host').value`), '', 'new dialog clears both prior endpoints');
  await run(`$('connect').close();`);
  routes.delete('mail:discoverMail');

  // Provider management lives on its own primary page, including drag listeners.
  calls.length = 0;
  await run(`$('rail-folders').click()`);
  await waitFor(`$('provider-content').querySelectorAll('.provider-column').length===1 && $('provider-content').querySelectorAll('.provider-row').length===1`);
  assert.equal(await run(`$('folders').querySelector('.provider-block')`), null);
  assert.equal(await run(`$('shell').hidden && !$('provider-panel').hidden`), true);
  assert.equal(await run(`$('provider-content').querySelector('[data-nest-drag="1"]')!==null`), true);
  await run(`window.providerRow=$('provider-content').querySelector('.provider-row');paintProviderPage();`);
  assert.equal(await run(`providerRow.isConnected`), true);
  await run(`$('provider-content').querySelector('.provider-row').click()`);
  await waitFor(`$('provider-content').querySelectorAll('.provider-column').length===2 && $('provider-content').querySelectorAll('.provider-row').length===2 && $('provider-content').textContent.includes('Work')`);
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
  assert.equal(await run(`$('calendar-layout').hidden`), false, 'cold load keeps the month shell');
  assert.equal(await run(`!!$('calendar-body').querySelector('.calendar-grid')`), true);
  assert.match(await run(`$('calendar-heading').textContent`), /October 2026/);
  assert.equal(await run(`$('calendar-heading').checkVisibility() && $('calendar-account').checkVisibility() && $('calendar-today').checkVisibility()`), true, 'calendar chrome stays visible while loading');
  assert.equal(await run(`$('calendar-panel').querySelector('.page-busy-label').textContent`), 'Loading…');
  assert.doesNotMatch(await run(`$('calendar-status').textContent`), /Loading calendar/);
  assert.equal(await run(`$('calendar-panel').querySelector(':scope > .page-busy') !== null && getComputedStyle($('calendar-panel').querySelector('.page-busy')).pointerEvents === 'none'`), true);
  assert.equal(await run(`(() => {
    const rail = $('rail-mail');
    const box = rail.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return !rail.disabled && !rail.closest('[inert]') && (hit === rail || rail.contains(hit));
  })()`), true, 'sidebar stays clickable during calendar load');
  await shot('calendar-loading');
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
  assert.equal(await run(`$('calendar-panel').querySelector('.page-busy')`), null, 'fresh cache does not flash a loading overlay');
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
  assert.match(await run(`$('calendar-agenda').textContent`), /Fixture event/, 'month switch keeps the last events');
  assert.equal(await run(`$('calendar-panel').querySelector('.page-busy-label').textContent`), 'Updating calendar…');
  assert.doesNotMatch(await run(`$('calendar-status').textContent`), /Loading calendar/);
  assert.equal(await run(`!$('calendar-layout').hidden`), true);
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
  assert.equal(await run(`$('calendar-panel').querySelector('.page-busy')`), null, 'a failed refresh removes the overlay');
  await shot('calendar-cached');
  await run(`shiftMonth(1);$('calendar-account').value='box-1';$('calendar-account').dispatchEvent(new Event('change'));`);
  await waitCalls('calendar:list', 7);
  assert.match(await run(`$('calendar-agenda').textContent`), /Current month/, 'account switch keeps the last month');
  assert.equal(await run(`$('calendar-panel').querySelector('.page-busy-label').textContent`), 'Updating calendar…');
  assert.doesNotMatch(await run(`$('calendar-status').textContent`), /Loading calendar/);
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

  const multiAt = count('calendar:list');
  await run(`localStorage.setItem('morrow.calendarChecks', JSON.stringify({'box-0':['work','home']}));
    state.calendarChecksAccountId=''; void loadCalendar({fresh:true});`);
  await waitCalls('calendar:list', multiAt + 1);
  const multi = calendarRequests[multiAt];
  assert.deepEqual(multi.payload.calendarIds, ['work', 'home']);
  assert.equal(multi.payload.calendarId, undefined);
  const multiStart = multi.payload.timeMin;
  const multiDay = await run(`(() => { const date = new Date(${JSON.stringify(multiStart)});
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0'); })()`);
  multi.resolve(ok({
    api: true,
    accountId: 'box-0',
    calendarId: 'work',
    calendarIds: ['work', 'home'],
    calendars: [{ id: 'work', name: 'Work', primary: true }, { id: 'home', name: 'Home' }],
    events: [
      { id: 'work-evt', title: 'Standup', start: multiStart, end: new Date(Date.parse(multiStart) + 3600000).toISOString(), calendarId: 'work' },
      { id: 'home-evt', title: 'Dentist', allDay: true, start: multiDay, end: multiDay, calendarId: 'home' },
    ],
  }));
  await waitFor(`$('calendar-agenda').textContent.includes('Standup') && $('calendar-agenda').textContent.includes('Dentist')`);
  assert.equal(await run(`document.querySelectorAll('#calendar-list input:checked').length`), 2);
  assert.equal(await run(`document.querySelector('#calendar-list input[value="work"]').checked && document.querySelector('#calendar-list input[value="home"]').checked`), true);
  const multiColors = await run(`JSON.stringify(['work-evt','home-evt'].map(id => document.querySelector('[data-event-id="'+id+'"]').style.getPropertyValue('--event-color')))`);
  assert.equal(JSON.parse(multiColors).length, 2);
  assert.notEqual(JSON.parse(multiColors)[0], JSON.parse(multiColors)[1]);
  await shot('calendar-multi-checked');
  await run(`document.querySelector('#calendar-list input[value="home"]').click()`);
  await waitFor(`!$('calendar-agenda').textContent.includes('Dentist') && $('calendar-agenda').textContent.includes('Standup')`);
  await waitCalls('calendar:list', multiAt + 2);
  assert.deepEqual(calendarRequests[multiAt + 1].payload.calendarIds, ['work']);
  calendarRequests[multiAt + 1].resolve(ok({
    api: true,
    accountId: 'box-0',
    calendarId: 'work',
    calendarIds: ['work'],
    calendars: [{ id: 'work', name: 'Work', primary: true }, { id: 'home', name: 'Home' }],
    events: [{ id: 'work-evt', title: 'Standup', start: multiStart, end: new Date(Date.parse(multiStart) + 3600000).toISOString(), calendarId: 'work' }],
  }));
  await waitFor(`!$('calendar-panel').hasAttribute('aria-busy')`);
  const beforeLast = count('calendar:list');
  await run(`document.querySelector('#calendar-list input[value="work"]').click()`);
  await sleep(80);
  assert.equal(count('calendar:list'), beforeLast, 'the last checked calendar stays checked');
  assert.equal(await run(`document.querySelector('#calendar-list input[value="work"]').checked`), true);
  await run(`document.querySelector('#calendar-list input[value="home"]').click()`);
  await waitCalls('calendar:list', beforeLast + 1);
  assert.deepEqual(calendarRequests[beforeLast].payload.calendarIds, ['work', 'home']);
  calendarRequests[beforeLast].resolve(ok({
    api: true,
    accountId: 'box-0',
    calendarId: 'work',
    calendarIds: ['work', 'home'],
    calendars: [{ id: 'work', name: 'Work', primary: true }, { id: 'home', name: 'Home' }],
    events: [
      { id: 'work-evt', title: 'Standup', start: multiStart, end: new Date(Date.parse(multiStart) + 3600000).toISOString(), calendarId: 'work' },
      { id: 'home-evt', title: 'Dentist', allDay: true, start: multiDay, end: multiDay, calendarId: 'home' },
    ],
  }));
  await waitFor(`$('calendar-agenda').textContent.includes('Dentist')`);
  assert.equal(await run(`state.calendarId`), 'home', 'the calendar last checked on is the create target');
  await run(`$('calendar-add').click()`);
  await waitFor(`$('calendar-event-dialog').open`);
  assert.equal(await run(`$('calendar-pick').value`), 'home');
  await run(`$('calendar-cancel').click()`);
  await waitFor(`!$('calendar-event-dialog').open`);
  await run(`document.querySelector('[data-event-id="work-evt"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  await waitFor(`$('calendar-event-dialog').open`);
  assert.equal(await run(`$('calendar-pick').value`), 'work', 'edit uses the event calendar');
  assert.equal(await run(`$('calendar-pick').disabled`), true, 'existing event cannot be reassigned with its old ID');
  const editPayload = await run(`state.calendarPayload`);
  routes.set('calendar:updateEvent', payload => ok({id:payload.eventId,calendarId:payload.calendarId}));
  routes.set('calendar:list', () => ok(editPayload));
  await run(`$('calendar-pick').value='home';$('calendar-save').click()`);
  await waitFor(`!$('calendar-event-dialog').open && !calendarWritePending`);
  const updated = calls.filter(row => row.channel==='calendar:updateEvent').at(-1);
  assert.equal(updated.payload.calendarId, 'work', 'even programmatic picker changes cannot retarget the write');
  assert.equal(updated.payload.eventId, 'work-evt');
  assert.equal(Object.hasOwn(updated.payload, 'description'), false, 'unchanged preview must never replace the provider body');
  assert.equal(Object.hasOwn(updated.payload, 'location'), false, 'unchanged location is omitted');
  await run(`$('calendar-add').click()`);
  await waitFor(`$('calendar-event-dialog').open`);
  assert.equal(await run(`$('calendar-pick').disabled`), false, 'new events keep the destination picker');
  await run(`$('calendar-cancel').click()`);
  await waitFor(`!$('calendar-event-dialog').open`);
  routes.delete('calendar:updateEvent');routes.delete('calendar:list');
  assert.deepEqual(await run(`JSON.parse(localStorage.getItem('morrow.calendarChecks'))['box-0']`), ['work', 'home']);

  // Cached bodies stay quiet. An incomplete body shows a reader spinner and leaves the list mounted.
  await run(`$('settings').close();showMail();`);
  const cachedBody = { id: 'cached-body', accountId: 'box-0', folderId: 'Inbox', subject: 'Cached body', from: 'ada@example.test', date: '2026-10-20T12:00:00.000Z', unread: false, bodyComplete: true, snippet: 'Ready' };
  const slowBody = { id: 'slow-body', accountId: 'box-0', folderId: 'Inbox', subject: 'Slow download', from: 'ada@example.test', date: '2026-10-20T12:00:00.000Z', unread: false, bodyComplete: false, snippet: 'Waiting' };
  let releaseOpen;
  routes.set('mail:openEmail', (payload) => new Promise((resolve) => {
    releaseOpen = () => resolve(ok({
      email: payload.emailId === 'cached-body'
        ? { ...cachedBody, textBody: 'Cached text', htmlBody: null }
        : { ...slowBody, bodyComplete: true, textBody: 'Loaded body text', htmlBody: null },
      isThread: false,
      threadMessages: [{ id: payload.emailId }],
    }));
  }));
  await run(`state.emails=${JSON.stringify([cachedBody, slowBody])};state.email=null;state.thread=[];renderList();window.cachedOpen=openMessage('cached-body');0`);
  for (let i = 0; i < 50 && !releaseOpen; i += 1) await sleep(10);
  assert.equal(typeof releaseOpen, 'function');
  await sleep(40);
  assert.equal(await run(`document.querySelector('#reader .body-pending')===null`), true, 'cached body does not flash a spinner');
  releaseOpen();
  const cachedResult = await run(`cachedOpen.then(() => '', (error) => String(error && error.stack || error))`);
  if (cachedResult) throw new Error(cachedResult);
  assert.match(await run(`$('reader').textContent`), /Cached text/);
  releaseOpen = null;
  await run(`window.slowOpen=openMessage('slow-body');0`);
  for (let i = 0; i < 50 && !releaseOpen; i += 1) await sleep(10);
  await waitFor(`!!document.querySelector('#reader .body-pending')`);
  assert.equal(await run(`$('reader').getAttribute('aria-busy')`), 'true');
  assert.match(await run(`$('reader').textContent`), /Loading message/);
  assert.equal(await run(`document.querySelector('#reader .reader-actions')===null`), true, 'reply stays unavailable until the body arrives');
  assert.equal(await run(`!!$('message-list').querySelector('[aria-current="true"]') && !!$('folders')`), true, 'list and folders stay mounted while the body loads');
  await shot('reader-body-pending');
  releaseOpen();
  const slowResult = await run(`slowOpen.then(() => '', (error) => String(error && error.stack || error))`);
  if (slowResult) throw new Error(slowResult);
  assert.equal(await run(`document.querySelector('#reader .body-pending')===null`), true);
  assert.match(await run(`$('reader').textContent`), /Loaded body text/);
  assert.equal(await run(`$('reader').hasAttribute('aria-busy')`), false);
  routes.delete('mail:openEmail');

  // Todos and Skills keep one outer scroller. Conversation scrolls the transcript and pins the composer.
  await run(`showPrimary('agent','agent-panel');
    for(const id of ['agent-home','agent-tools']){const p=document.createElement('p');p.textContent='Long fixture content '.repeat(1000);$(id).append(p);}
    agentTurns=Array.from({length:50},(_,i)=>({role:i%2?'agent':'user',text:'Saved turn '+i, ...(i?{at:new Date(Date.UTC(2026,9,23,12,0,i)).toISOString()}:{})}));paintThread();
    window.turn=$('agent-sections').firstElementChild;paintThread();`);
  assert.equal(await run(`turn.isConnected`), true, 'unchanged transcript retains DOM');
  for (const name of ['home', 'conversation', 'tools']) {
    await run(`$('agent-tab-${name}').click()`);
    assert.equal(await run(`$('agent-tab-${name}').getAttribute('aria-selected')`), 'true');
    const scrollers = await run(`[...$('agent-panel').querySelectorAll('*')].filter(n=>!n.closest('[hidden]')&&n.tagName!=='TEXTAREA'&&['auto','scroll'].includes(getComputedStyle(n).overflowY)&&n.scrollHeight>n.clientHeight+1).map(n=>n.id||n.className)`);
    if (name === 'conversation') {
      assert.deepEqual(scrollers, ['agent-sections'], 'conversation scrolls the transcript only');
      assert.equal(await run(`(()=>{const n=$('agent-sections');return n.scrollHeight>n.clientHeight&&n.scrollTop>=n.scrollHeight-n.clientHeight-2;})()`), true, 'Conversation opens on the latest turn');
      assert.equal(await run(`$('agent-sections').firstElementChild.querySelector('time')===null`), true, 'a turn without at hides the time');
      assert.equal(await run(`(()=>{const time=$('agent-sections').lastElementChild.querySelector('time');return !!(time&&time.dateTime.startsWith('2026-10-23')&&time.textContent.trim());})()`), true, 'a saved turn shows its local time');
      assert.equal(await run(`(()=>{
        const panel=$('agent-panel').getBoundingClientRect();
        const before=$('agent-composer').getBoundingClientRect();
        $('agent-sections').scrollTop=$('agent-sections').scrollHeight;
        const after=$('agent-composer').getBoundingClientRect();
        return getComputedStyle($('agent-panel')).overflowY==='hidden'
          && before.height>0 && before.bottom<=panel.bottom+1 && before.top>=panel.top
          && Math.abs(after.top-before.top)<1 && after.bottom<=panel.bottom+1
          && $('agent-input').getBoundingClientRect().height>0;
      })()`), true, 'composer stays pinned while the transcript scrolls');
    } else {
      assert.deepEqual(scrollers, [], 'tab content has no competing scroll containers');
    }
  }
  assert.equal(await run(`getComputedStyle($('agent-panel')).overflowY`), 'auto');
  await run(`$('agent-tab-tools').focus();$('agent-tab-tools').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))`);
  assert.equal(await run(`agentTab`), 'conversation');
  assert.equal(await run(`(()=>{const n=$('agent-sections');return n.scrollTop>=n.scrollHeight-n.clientHeight-2;})()`), true, 'keyboard switch to Conversation shows the latest turn');
  await run(`$('agent-sections').scrollTop=0;agentTurns=agentTurns.concat([{role:'agent',text:'Newest',at:'2026-10-23T18:30:00.000Z'}]);paintThread();`);
  assert.equal(await run(`(()=>{const n=$('agent-sections');const time=n.lastElementChild.querySelector('time');return n.scrollTop>=n.scrollHeight-n.clientHeight-2&&time&&time.textContent.trim()&&n.lastElementChild.textContent.includes('Newest');})()`), true, 'a new turn while Conversation is open stays at the bottom');
  await run(`$('agent-sections').scrollTop=100;window.savedScroll=$('agent-sections').scrollTop;showAgentTab('conversation')`);
  assert.equal(await run(`$('agent-sections').scrollTop===savedScroll && savedScroll>0`),true,'staying in Conversation preserves reading position');
  await run(`(async()=>{
    showAgentTab('home');
    const items=Array.from({length:10},(_,i)=>({messageId:'todo-'+i,accountId:state.accountId,from:'Ada <ada@example.test>',subject:'Todo '+i,summary:'Line '.repeat(20),unread:true,date:'2026-10-23T12:00:00.000Z'}));
    paintAgent({sections:[{name:'Needs You',items}]},'');
    $('shell').hidden=false;
    $('shell').style.cssText='position:absolute;top:5000px;left:0;width:700px;height:800px';
    state.email={id:'todo-4',accountId:state.accountId,unread:true,from:'Ada',subject:'Todo 4',folderId:state.folderId,snippet:'x',date:Date.now()};
    state.emails=[state.email];
    listOpenKey='';
    const panel=$('agent-panel');
    panel.scrollTop=180;
    const before={panel:panel.scrollTop,doc:document.scrollingElement.scrollTop};
    const card=panel.querySelector('[data-message-id="todo-4"]');
    card.querySelector('[data-action="read"]').click();
    await new Promise((resolve)=>setTimeout(resolve,80));
    window.todoScroll={before,after:{panel:panel.scrollTop,doc:document.scrollingElement.scrollTop},status:$('status').textContent,unread:card.classList.contains('unread')};
    $('shell').hidden=true;
    $('shell').style.cssText='';
  })()`);
  assert.equal(await run(`todoScroll.after.panel===todoScroll.before.panel && todoScroll.after.doc===todoScroll.before.doc && todoScroll.before.panel>0`), true, 'Mark as read keeps the Todos scroll position');
  assert.equal(await run(`todoScroll.unread`), false);
  assert.match(await run(`todoScroll.status`), /Marked as read/);
  await shot('agent-composer-pinned');
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
  assert.equal(await run(`$('rail-shortcuts').nextElementSibling.id`), 'rail-log');
  assert.equal(await run(`$('rail-log').nextElementSibling.id`), 'rail-about');
  await run(`$('rail-about').click()`);
  await waitFor(`!$('about-update-install').hidden`);
  assert.equal(await run(`$('about-dialog').open`), true);
  await run(`Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>null)`);
  for (const [width, height] of [[1180, 820], [800, 500]]) {
    win.setSize(width, height);
    await run(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(null))))`);
    const placement = await run(`(()=>{const r=$('about-dialog').getBoundingClientRect();return {x:r.x+r.width/2-innerWidth/2,y:r.y+r.height/2-innerHeight/2};})()`);
    assert.ok(Math.abs(placement.x) <= 1 && Math.abs(placement.y) <= 1, 'About remains centered after viewport resize');
  }
  win.setSize(1180, 820);
  assert.equal(await run(`$('updates')===null && $('update-check')===null`), true);
  await run(`$('about-update-check').click()`);
  await waitCalls('host:updateCheck', 1);
  await run(`$('about-dialog').close();$('rail-about').click();`);
  assert.equal(await run(`$('about-dialog').open`), true);
  await shot('about-rail');
  win.setSize(1180,820);
  await run(`$('about-dialog').close();showMail();state.accountId='box-0';state.folderId='Inbox';state.query='';state.listScope='';`);
  let mail = Array.from({length:2105}, (_,i)=>({id:'paged-'+i,accountId:'box-0',folderId:'Inbox',
    subject:'Downloaded message '+(i+1),from:'Sender <sender@example.test>',snippet:'Cached preview',date:'2026-10-19T08:00:00Z'}));
  routes.set('mail:listFromCache', payload => ok({emails:mail.slice(payload.offset, payload.offset+payload.limit),total:mail.length,initialSyncDone:true}));
  await run(`loadList()`);
  assert.equal(await run(`document.querySelectorAll('.message-row').length`), 200);
  for (let page = 1; page <= 10; page++) {
    await run(`$('list-next').click()`);
    await waitFor(`state.listOffset===${page*200} && !state.busy && !state.listLoading`);
    assert.ok(await run(`document.querySelectorAll('.message-row').length<=200`));
  }
  assert.equal(await run(`$('list-page-status').textContent`), await run(`(2001).toLocaleString()+'–'+(2105).toLocaleString()+' / '+(2105).toLocaleString()+' downloaded'`));
  assert.equal(await run(`$('list-next').disabled && !$('list-prev').disabled`), true);
  assert.equal(await run(`document.querySelectorAll('.message-row').length`), 105);
  await shot('message-last-page');
  await run(`loadList()`);
  assert.equal(await run(`state.listOffset`), 2000, 'refresh preserves the current page');
  mail = mail.slice(0, 1900);
  await run(`loadList()`);
  assert.equal(await run(`state.listOffset`), 1800, 'deletion of last page recovers the last available page');
  await run(`$('list-prev').click()`);
  await waitFor(`state.listOffset===1600 && !state.busy`);
  await run(`window.retainedRow=document.querySelector('.message-row');openSettings();setSettingsFold('mail',true,false)`);
  await waitFor(`settingsFoldLoaded.has('mail:')`);
  assert.equal(await run(`$('pref-compact-list').checked`), true, 'compact message list defaults on');
  await shot('settings-compact-sync');
  await run(`$('pref-compact-list').click()`);
  await waitFor(`state.prefs.compactList===false`);
  assert.equal(require('../host/settings').answer('morrow:configGetCompactMessageList', []), false);
  await run(`$('settings').close();retainedRow.querySelector('button.message').focus();`);
  const comfortableHeight = await run(`document.querySelector('.message-row').getBoundingClientRect().height`);
  assert.ok(comfortableHeight >= 60 && comfortableHeight < 64, `comfortable row stays near the 60px minimum, got ${comfortableHeight}`);
  await run(`openSettings();setSettingsFold('mail',true,false)`);
  await waitFor(`settingsFoldLoaded.has('mail:')`);
  assert.equal(await run(`$('pref-compact-list').checked`), false);
  await run(`$('pref-compact-list').click()`);
  await waitFor(`state.prefs.compactList===true`);
  assert.equal(require('../host/settings').answer('morrow:configGetCompactMessageList', []), true);
  await run(`$('settings').close();retainedRow.querySelector('button.message').focus();`);
  const compact = await run(`(()=>{
    const row=document.querySelector('.message-row');
    const from=row.querySelector('.from').getBoundingClientRect();
    const subject=row.querySelector('.subject').getBoundingClientRect();
    return {retained:row===retainedRow, height:row.getBoundingClientRect().height,
      snippet:getComputedStyle(row.querySelector('.snippet')).display,
      oneLine:Math.abs(from.top+from.height/2-subject.top-subject.height/2)<2};
  })()`);
  assert.equal(compact.retained, true, 'density changes retain row DOM and handlers');
  assert.equal(compact.height, 32);
  assert.equal(compact.snippet, 'none');
  assert.equal(compact.oneLine, true, 'sender and subject share a single line');
  await shot('message-compact-page');
  // Reduced motion and a short window retain one tab panel and reachable controls.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  win.setSize(800,600);
  await run(`openSettings();setSettingsFold('mail',true,true);`);
  await waitFor(`settingsFoldLoaded.has('mail:')`);
  assert.equal(await run(`morrowMotion.reduced()`), true);
  assert.equal(await run(`document.querySelectorAll('#settings [role="tabpanel"]:not([hidden])').length`), 1);
  assert.equal(await run(`$('settings-mail-panel').getAnimations().length`), 0);
  assert.equal(await run(`$('settings').scrollWidth<=$('settings').clientWidth+1`), true);
  await run(`$('pref-snooze').focus();$('pref-snooze').scrollIntoView({block:'nearest'});`);
  assert.equal(await run(`$('pref-snooze').getBoundingClientRect().bottom<=innerHeight && document.activeElement===$('pref-snooze')`), true);
  await shot('settings-short-reduced-motion');
  // Every Settings panel still fits horizontally in a short, narrow dark window.
  win.setSize(560,600);
  await run(`document.documentElement.dataset.theme='dark'`);
  for (const name of ['prefs','mail','ai','mailbox','ooo','bot']) {
    await run(`setSettingsFold('${name}',true,true)`);
    await waitFor(`settingsFoldLoaded.has(settingsFoldKey('${name}')) && !document.querySelector('#settings .fold.is-open .fold-panel').inert`);
    assert.equal(await run(`$('settings').querySelector('.dialog-body').scrollWidth<=$('settings').querySelector('.dialog-body').clientWidth+1`), true, name+' must not scroll horizontally');
    assert.equal(await run(`document.querySelector('.settings-account-context').hidden`), !['mailbox','ooo'].includes(name));
    await shot('settings-short-dark-'+name);
  }
  await run(`$('bot-review-link').click()`);
  assert.equal(await run(`document.activeElement.id==='bot-draft-heading' && $('bot-draft-heading').getBoundingClientRect().bottom<innerHeight`), true);
  console.log(JSON.stringify({ settingsOpen: immediate, preferenceOpenReads: 0, calendarListReads: calendarRequests.length,
    retainedMonthAndSelection: true, agentScrollContainers: 1, providerPage: true, singleUpdater: true }, null, 2));
  console.log('PAGE_NAVIGATION_CHECK_OK');
  app.exit(0);
}).catch(error => { console.error(error.stack || error); app.exit(1); });
