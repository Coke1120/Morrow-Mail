// Exercise unmodified boot/loadAccounts/loadList/changelog/onboarding, synthetic IPC.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { renderer } = require('./check-ux-workflows');
const install = require('./fixtures/google-onboarding-startup');
const version = require('../package.json').version;
const html = fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8');
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
function fixture(t, options = {}) {
  const dom = new JSDOM(html, { url: 'https://synthetic.morrow.invalid' });
  const { window } = dom, { document } = window, opened = [], timers = new Set();
  t.after(() => { for (const id of timers) { clearTimeout(id); clearInterval(id); } window.close(); });
  const host = install(window, { version, ...options });
  function dialog(d) {
    d.showModal = () => { d.open = true; opened.push(d.id); };
    d.close = () => { if (d.open) { d.open = false; d.dispatchEvent(new window.Event('close')); } };
    return d;
  }
  for (const d of document.querySelectorAll('dialog')) dialog(d);
  const ui = renderer({ window, document, navigator: window.navigator, Node: window.Node, Event: window.Event,
    localStorage: window.localStorage, URL, URLSearchParams,
    morrowChangelog: require('../shared/changelog'),
    requestAnimationFrame: fn => { queueMicrotask(() => fn(0)); return 1; }, cancelAnimationFrame() {},
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); id.unref(); timers.add(id); return id; },
    setInterval: (fn, ms) => { const id = setInterval(fn, ms); id.unref(); timers.add(id); return id; }, clearInterval,
  });
  const get = id => document.getElementById(id);
  return { ui, host, window, document, opened, get, dialog,
    boot: async () => { await ui.run('boot()'); await settle(); assert.equal(host.ready, true); },
    cancel: id => { if (get(id).dispatchEvent(new window.Event('cancel', { cancelable: true }))) get(id).close(); },
    saved: () => host.onboarding,
  };
}
for (const action of ['changelog-ok', 'changelog-close', 'Escape']) {
  test(`full fresh boot: ${action} releases one guide; Later persists across restart`, async t => {
    const f = fixture(t); await f.boot(); assert.deepEqual(f.opened, ['changelog']);
    if (action === 'Escape') f.cancel('changelog'); else f.get(action).click();
    await settle(); assert.deepEqual(f.opened, ['changelog', 'setup-guide']);
    assert.equal(f.document.querySelectorAll('dialog[open]').length, 1);
    if (action === 'Escape') f.cancel('setup-guide'); else f.get('setup-guide-later').click();
    await settle(); assert.equal(f.saved().status, 'later');
    const reload = fixture(t, { seen: version, onboarding: f.saved() }); await reload.boot();
    assert.deepEqual(reload.opened, []);
    reload.get('settings').showModal(); reload.get('setup-guide-open').click(); await settle();
    assert.equal(reload.get('setup-guide').open, true);
    assert.equal(reload.document.querySelectorAll('dialog[open]').length, 1);
    assert.equal(f.host.calls.some(c => /importGoogleOauth|addAccount|aiConsentGrant|aiTest/.test(c)), false);
  });
}
test('new user with bundled Google configuration still receives the six-step guide', async t => {
  const f = fixture(t, { seen: version, status: { ready: true, source: 'bundled' } }); await f.boot();
  assert.deepEqual(f.opened, ['setup-guide']); assert.equal(f.get('setup-guide-import').hidden, true);
  assert.equal(f.get('setup-guide-steps').children.length, 6);
});
test('existing mailboxes are preserved without automatic onboarding', async t => {
  const f = fixture(t, { seen: version, accounts: [{ id: 'a', email: 'a@example.invalid', folders: [] }] }); await f.boot();
  assert.deepEqual(f.opened, []); assert.equal(f.saved().status, 'existing');
});
test('late and dynamic dialogs defer onboarding, and close resumes exactly once', async t => {
  const f = fixture(t); await f.boot();
  const other = f.dialog(f.document.createElement('dialog')); other.id = 'other'; f.document.body.append(other);
  f.get('changelog').addEventListener('close', () => other.showModal(), { once: true });
  f.get('changelog-ok').click(); await settle(); assert.equal(f.get('setup-guide').open, false);
  other.close(); await settle(); assert.deepEqual(f.opened, ['changelog', 'other', 'setup-guide']);
});
test('slow changelog readiness releases the guide on seen, unseen and failed reads', async t => {
  for (const outcome of ['unseen', 'seen', 'failed']) {
    const f = fixture(t); let finish, fail;
    f.host.readSeen = () => new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    await f.boot(); assert.deepEqual(f.opened, []);
    if (outcome === 'failed') fail(new Error('Synthetic read failure')); else finish(outcome === 'seen' ? version : '');
    await settle();
    if (outcome === 'unseen') { assert.deepEqual(f.opened, ['changelog']); f.get('changelog-ok').click(); await settle(); }
    assert.equal(f.get('setup-guide').open, true);
    assert.equal(f.document.querySelectorAll('dialog[open]').length, 1);
  }
});
test('skip and finish work without mailbox, calendar or AI, with restart at saved step', async t => {
  const f = fixture(t, { seen: version }); await f.boot();
  f.get('setup-guide-next').click(); await settle();
  assert.equal(f.saved().step, 1); assert.equal(f.get('setup-guide-action').disabled, true);
  const reload = fixture(t, { seen: version, onboarding: f.saved() }); await reload.boot();
  assert.match(reload.get('setup-guide-heading').textContent, /calendar/);
  for (let i = 0; i < 5; i++) { reload.get('setup-guide-next').click(); await settle(); }
  assert.equal(reload.saved().status, 'done'); assert.equal(reload.get('setup-guide').open, false);
  assert.equal(reload.host.calls.includes('host:aiConsentGrant'), false);
});
test('connect handoff returns after cancel and delayed OAuth account updates', async t => {
  const f = fixture(t, { seen: version }); await f.boot();
  f.get('setup-guide-action').click(); await settle();
  assert.equal(f.get('connect').open, true); assert.equal(f.get('setup-guide').open, false);
  f.cancel('connect'); await settle(); assert.equal(f.get('setup-guide').open, true);
  f.ui.run("state.accounts = [{id:'late',email:'late@example.invalid'}]");
  await f.ui.run('paintSetupGuide()'); assert.match(f.get('setup-guide-state').textContent, /Connected: late/);
  assert.equal(f.document.querySelectorAll('dialog[open]').length, 1);
});
test('account-specific completion and editors never inherit another mailbox status', async t => {
  const f = fixture(t, { seen: version }); await f.boot();
  f.ui.run(`state.accounts = [{ id:'a',email:'a@example.invalid',platform:'imap',authKind:'oauth2',imapSmtpProfile:'gmail' },{ id:'b',email:'b@example.invalid',authKind:'password',imapSmtpProfile:'custom' }];
    call = async (channel, body) => {
      if (channel === 'calendar:status') return { accounts:[{id:'a',calendar:true}] };
      if (channel === 'emailBrain:getComposeSettings') return {accounts:{a:{senderNames:{'a@example.invalid':'Alice'}}}};
      if (channel === 'mail:listSignatures') return {signatures:body.accountId==='a'?[{id:'sig',accountId:'a',text:'Alice'}]:[]};
      return {};
    };`);
  for (const step of [1, 2, 3]) {
    f.ui.run(`setupProgress.accountId='a'; setupProgress.step=${step}`); await f.ui.run('paintSetupGuide()');
    assert.equal(f.get('setup-guide-next').textContent, 'Continue');
    f.ui.run("setupProgress.accountId='b'"); await f.ui.run('paintSetupGuide()');
    assert.equal(f.get('setup-guide-next').textContent, 'Skip for now');
  }
  f.ui.run("globalThis.signatureTarget=null; openSignatures=id=>{signatureTarget=id;openDialog('signatures')}");
  f.get('setup-guide-action').click(); await settle();
  assert.equal(f.ui.run('signatureTarget'), 'b'); assert.equal(f.get('setup-guide').open, false);
});
test('stale calendar read cannot repaint another step or a closed guide', async t => {
  const f = fixture(t, { seen: version }); await f.boot();
  f.ui.run("state.accounts=[{id:'a',email:'a@example.invalid',platform:'imap',authKind:'oauth2',imapSmtpProfile:'gmail'}]; setupProgress.accountId='a'; setupProgress.step=1; globalThis.finish=null; call=()=>new Promise(resolve=>{finish=resolve})");
  const pending = f.ui.run('paintSetupGuide()');
  f.ui.run('setupProgress.step=4'); await f.ui.run('paintSetupGuide()');
  f.ui.run("finish({accounts:[{id:'a',calendar:true}]})"); await pending;
  assert.match(f.get('setup-guide-state').textContent, /AI is optional/);
});
test('actual preload and settings host persist navigation only and preserve configured preferences', async t => {
  const vm = require('node:vm'), os = require('node:os'), path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-guide-'));
  const previous = process.env.MORROW_USER_DATA; process.env.MORROW_USER_DATA = directory;
  t.after(() => { if (previous === undefined) delete process.env.MORROW_USER_DATA; else process.env.MORROW_USER_DATA = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  const host = require('../host/settings'); let bridge;
  vm.runInNewContext(fs.readFileSync(require.resolve('../renderer/preload'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return {
      contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'morrow') bridge = value; } },
      ipcRenderer: { invoke: async (channel, payload) => host.answer(channel, [payload]) },
    }; },
  });
  assert.equal(await bridge.invoke('morrow:configGetOnboarding'), null);
  await bridge.invoke('config:setTheme', 'dark');
  await bridge.invoke('morrow:configSetOnboarding', { status:'later',step:3,accountId:'b',token:'must-not-persist' });
  assert.deepEqual(host.answer('morrow:configGetOnboarding'), {status:'later',step:3,accountId:'b'});
  assert.equal(host.answer('config:getTheme'), 'dark');
  await bridge.invoke('morrow:configSetOnboarding', {status:'active',step:5,accountId:''});
  assert.equal(host.answer('morrow:configGetOnboarding').step,5);
  assert.equal(await bridge.invoke('morrow:configGetUndoSendDelaySeconds'),30);
  assert.equal(await bridge.invoke('morrow:configGetDefaultScheduleDelayMinutes'),0);
  assert.equal(await bridge.invoke('morrow:configGetAutoLoadRemoteImages'),true);
  await bridge.invoke('morrow:configSetUndoSendDelaySeconds',0);
  await bridge.invoke('morrow:configSetDefaultScheduleDelayMinutes',10080);
  await bridge.invoke('morrow:configSetAutoLoadRemoteImages',false);
  const stored=JSON.parse(fs.readFileSync(path.join(directory,'settings.json'),'utf8'));
  assert.equal(stored.undoSendDelaySeconds,0);assert.equal(stored.defaultScheduleDelayMinutes,10080);assert.equal(stored.remoteImages,false);
  await assert.rejects(bridge.invoke('morrow:configSetUndoSendDelaySeconds',31));
  await assert.rejects(bridge.invoke('morrow:configSetDefaultScheduleDelayMinutes',10081));
  await assert.rejects(bridge.invoke('morrow:configSetAutoLoadRemoteImages','on'));

  assert.doesNotMatch(fs.readFileSync(path.join(directory, 'settings.json'),'utf8'), /must-not-persist/);
  await assert.rejects(bridge.invoke('morrow:configSetOnboarding',{status:'later',step:99}), /Invalid setup guide/);
  await assert.rejects(bridge.invoke('unsupported:setup'), /Unsupported channel/);
});
test('calendar action is pinned, deduplicated and cancellable; late completion does not reopen a dismissed guide', async t => {
  const f = fixture(t, {seen:version}); await f.boot();
  f.ui.run(`state.accounts=[{id:'a',email:'a@example.invalid',platform:'imap',imapSmtpProfile:'gmail'}];
    setupProgress.accountId='a';setupProgress.step=1;globalThis.finish=null;globalThis.requests=[];
    call=async(channel,body)=>{requests.push({channel,body});if(channel==='calendar:connect')return new Promise(resolve=>{finish=resolve});if(channel==='calendar:status')return {google:true,accounts:[]};return {}};`);
  await f.ui.run('paintSetupGuide()'); f.get('setup-guide-action').click(); await settle();
  await f.ui.run('paintSetupGuide()'); f.get('setup-guide-action').click();
  assert.equal(f.ui.run("requests.filter(r=>r.channel==='calendar:connect').length"),1);
  assert.equal(f.ui.run("requests.find(r=>r.channel==='calendar:connect').body.accountId"),'a');
  f.get('setup-guide-cancel').click(); await settle();
  assert.equal(f.ui.run("requests.some(r=>r.channel==='mail:cancelOAuth')"),true);
  f.get('setup-guide-later').click(); await settle(); f.ui.run('finish({api:true})'); await settle();
  assert.equal(f.get('setup-guide').open,false); assert.equal(f.saved().status,'later');
});
test('failed completion reads never claim connection or a saved signature', async t => {
  const f=fixture(t,{seen:version});await f.boot();
  f.ui.run("state.accounts=[{id:'a',email:'a@example.invalid'}];setupProgress.accountId='a';setupProgress.step=3;call=async()=>{throw new Error('unavailable')}");
  await f.ui.run('paintSetupGuide()'); assert.match(f.get('setup-guide-state').textContent,/Could not check/);
  assert.equal(f.get('setup-guide-next').textContent,'Skip for now');
});

test('mail preferences use saved values; navigation never writes; explicit saves survive restart', async t => {
  const preferences = {UndoSendDelaySeconds:12,DefaultScheduleDelayMinutes:125,AutoLoadRemoteImages:false};
  const f = fixture(t,{seen:version,preferences}); await f.boot();
  f.ui.run('moveSetupGuide(5)'); await settle();
  assert.equal(f.get('setup-undo').value,'12');
  assert.equal(f.get('setup-delay-hours').value,'2'); assert.equal(f.get('setup-delay-minutes').value,'5');
  assert.equal(f.get('setup-images').value,''); assert.match(f.get('setup-images').options[0].textContent,/off/);
  assert.match(f.get('setup-images-help').textContent,/tracking pixels/);
  for (const id of ['setup-undo','setup-delay-hours','setup-delay-minutes','setup-images']) assert.ok(f.get(id).labels.length);
  f.get('setup-images-save').click(); await settle(); assert.equal(f.host.preferenceWrites.length,0);
  f.get('setup-undo').value='20'; f.get('setup-images').value='on';
  f.get('setup-guide-back').click(); await settle(); f.get('setup-guide-next').click(); await settle();
  assert.equal(f.get('setup-undo').value,'20'); assert.equal(f.get('setup-images').value,'on');
  f.get('setup-guide-later').click(); await settle(); assert.equal(f.host.preferenceWrites.length,0);
  const reload=fixture(t,{seen:version,preferences:f.host.preferences,onboarding:f.saved()});await reload.boot();
  reload.get('settings').showModal();reload.get('setup-guide-open').click();await settle();
  assert.equal(reload.get('setup-undo').value,'12'); assert.equal(reload.get('setup-images').value,'');
  reload.get('setup-undo').value='0';reload.get('setup-undo-save').click();await settle();
  reload.get('setup-delay-hours').value='168';reload.get('setup-delay-minutes').value='0';reload.get('setup-delay-save').click();await settle();
  reload.get('setup-images').value='on';reload.get('setup-images-save').click();await settle();
  assert.deepEqual(reload.host.preferenceWrites,[['UndoSendDelaySeconds',0],['DefaultScheduleDelayMinutes',10080],['AutoLoadRemoteImages',true]]);
  assert.equal(reload.ui.run('state.prefs.undoSend'),0);assert.equal(reload.ui.run('state.prefs.scheduleDelay'),10080);assert.equal(reload.ui.run('state.prefs.images'),true);
  const saved=fixture(t,{seen:version,preferences:reload.host.preferences,onboarding:{status:'active',step:5,accountId:''}});await saved.boot();
  assert.equal(saved.get('setup-undo').value,'0');assert.equal(saved.get('setup-delay-hours').value,'168');assert.match(saved.get('setup-images').options[0].textContent,/on/);
  saved.get('setup-guide-next').click();await settle();assert.equal(saved.saved().status,'done');assert.equal(saved.host.preferenceWrites.length,0);
});
test('mail preference validation, failed reads, failed saves and pending save dismissal', async t => {
  const f=fixture(t,{seen:version});await f.boot();
  const invoke=f.window.morrow.invoke;
  let failRead=true,finish;
  f.window.morrow.invoke=async(channel,...args)=>{
    if(failRead && channel==='morrow:configGetUndoSendDelaySeconds')throw new Error('synthetic read failure');
    return invoke(channel,...args);
  };
  f.ui.run('moveSetupGuide(5)');await settle();
  assert.equal(f.get('setup-undo').disabled,true);assert.equal(f.get('setup-guide-action').textContent,'Retry loading preferences');
  failRead=false;f.get('setup-guide-action').click();await settle();assert.equal(f.get('setup-undo').disabled,false);
  for(const invalid of ['', '-1','31','1.5']){f.get('setup-undo').value=invalid;f.get('setup-undo-save').click();await settle();assert.match(f.get('setup-undo-status').textContent,/whole number/);}
  for(const [hours,minutes] of [['168','1'],['169','0'],['0','60'],['1.5','0'],['-1','0']]){
    f.get('setup-delay-hours').value=hours;f.get('setup-delay-minutes').value=minutes;f.get('setup-delay-save').click();await settle();assert.match(f.get('setup-delay-status').textContent,/at most 7 days/);
  }
  assert.equal(f.host.preferenceWrites.length,0);
  f.window.morrow.invoke=async(channel,...args)=>{if(channel==='morrow:configSetAutoLoadRemoteImages')throw new Error('synthetic write failure');return invoke(channel,...args)};
  f.get('setup-images').value='off';f.get('setup-images-save').click();await settle();
  assert.match(f.get('setup-images-status').textContent,/Could not save/);assert.equal(f.get('setup-images').value,'off');assert.equal(f.host.preferences.AutoLoadRemoteImages,true);
  f.window.morrow.invoke=async(channel,...args)=>{if(channel==='morrow:configSetAutoLoadRemoteImages')await new Promise(resolve=>{finish=resolve});return invoke(channel,...args)};
  f.get('setup-images-save').click();await settle();f.ui.run('saveSetupMailPreference("images")');
  assert.equal(f.get('setup-images-save').disabled,true);
  f.get('setup-guide-later').click();await settle();finish();await settle();
  assert.deepEqual(f.host.preferenceWrites,[['AutoLoadRemoteImages',false]]);assert.equal(f.get('setup-guide').open,false);
});
