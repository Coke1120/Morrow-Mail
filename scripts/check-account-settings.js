// Offline renderer/DOM checks. No provider, credential or native OS access.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { renderer } = require('./check-ux-workflows');
const html = fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8');
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
function fixture(t) {
  const dom = new JSDOM(html), { window } = dom, { document } = window, timers = new Set();
  t.after(() => { for (const timer of timers) clearTimeout(timer); window.close(); });
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new window.Event('close')); };
  }
  const calls = [];
  window.morrow = { on() {}, invoke: async (channel, input) => {
    calls.push({ channel, input });
    if (channel === 'mail:oauthStatus') return { success: true, data: { accounts: [] } };
    if (channel === 'mail:googleOauthStatus') return { success: true, data: { ready: true, source: 'bundled' } };
    return { success: true, data: [] };
  } };
  const ui = renderer({ window, document, navigator: window.navigator, Event: window.Event, Node: window.Node,
    requestAnimationFrame: work => { queueMicrotask(() => work(0)); return 1; },
    setTimeout: (work, delay) => { const handle = setTimeout(() => { timers.delete(handle); work(); }, delay); handle.unref(); timers.add(handle); return handle; }, clearTimeout });
  ui.run(`wire(); state.accounts = [
    {id:'a',email:'a@example.invalid',name:'Personal',platform:'imap',authKind:'oauth2',imapSmtpProfile:'gmail',mailTransport:'gmail_api'},
    {id:'b',email:'b@example.invalid',name:'Work',platform:'imap',authKind:'oauth2',imapSmtpProfile:'outlook'}
  ]; state.accountId='a'; openSettings(); revealSettingsFold('mailbox');`);
  return { ui, document, calls, get: id => document.getElementById(id), card: id => document.querySelector(`#settings-accounts button[data-account-id="${id}"]`) };
}

test('account overview opens directly, wraps full identities safely and keeps Settings independent of Mail', async t => {
  const f = fixture(t); await tick();
  assert.equal(f.get('settings-account-detail').hidden, false);
  assert.equal(f.document.querySelector('.settings-account-context').hidden, true);
  assert.match(f.get('settings-account-title').textContent, /a@example.invalid/);
  f.card('b').focus(); f.card('b').click(); await tick();
  assert.equal(f.ui.run('settingsAccount().id'), 'b');
  assert.equal(f.ui.run('state.accountId'), 'a');
  assert.equal(f.document.activeElement, f.card('b'));
  assert.equal(f.card('b').getAttribute('aria-pressed'), 'true');
  f.ui.run(`state.accounts[1].name='<img src=x onerror=unsafe()>'; renderSettingsAccounts()`);
  assert.match(f.card('b').textContent, /<img src=x onerror=unsafe\(\)>/);
  assert.equal(f.card('b').querySelector('img'), null);
  assert.match(f.get('settings-account-title').textContent, /<img src=x/);
  f.ui.run(`state.accounts=[state.accounts[1]]; state.settingsAccountId='removed'; state.accountId=null; renderSettingsAccounts()`); await tick();
  assert.equal(f.ui.run('settingsAccount().id'), 'b');
  assert.equal(f.card('b').getAttribute('aria-pressed'), 'true');
  f.ui.run(`state.accounts=[]; renderSettingsAccounts()`); await tick();
  assert.equal(f.get('settings-account-detail').hidden, true);
  assert.equal(f.get('settings-reconnect').disabled, true);
  assert.equal(f.get('remove').disabled, true);
  assert.match(f.get('settings-accounts').textContent, /No accounts yet.*Add an account/);
  assert.equal(f.document.activeElement, f.get('connect-open'));
});

test('repeated account choices cannot replace an unsaved Out of Office discard review', async t => {
  const f = fixture(t); await tick();
  f.ui.run(`oooBaseline=oooSnapshot(); $('ooo-message').value='Keep my draft'`);
  f.card('b').click(); await tick();
  assert.equal(f.get('confirm').open, true);
  assert.match(f.get('confirm-body').textContent, /a@example.invalid/);
  assert.equal(await f.ui.run(`changeSettingsMailbox('b')`), false);
  assert.equal(f.ui.run('settingsAccount().id'), 'a');
  f.get('confirm-cancel').click(); await tick();
  assert.equal(f.get('ooo-message').value, 'Keep my draft');
  f.card('b').click(); await tick();
  f.ui.run(`state.accounts=state.accounts.filter(a=>a.id!=='b')`);
  f.get('confirm-ok').click(); await tick();
  assert.equal(f.ui.run('settingsAccount().id'), 'a');
  assert.equal(f.get('ooo-message').value, 'Keep my draft');
  assert.equal(await f.ui.run(`changeSettingsMailbox('missing')`), false);
  assert.equal(f.calls.some(row => /vacationPut|removeAccount|migrateGmail/.test(row.channel)), false);
});

test('removing the viewed account refreshes fallback permissions and retires delayed reads', async t => {
  const f = fixture(t); await tick();
  f.ui.run(`globalThis.oldPermissions=null; call=async(channel)=> {
    if(channel==='mail:oauthStatus') return new Promise(resolve=>{oldPermissions=resolve});
    return {ready:true,source:'bundled'};
  }; settingsFoldLoaded.clear(); loadSettingsFold('mailbox');`);
  await tick(); assert.equal(f.get('settings-mailbox-panel').inert, false);
  assert.equal(f.ui.run('typeof oldPermissions'), 'function');
  f.ui.run(`call=async(channel)=>channel==='mail:oauthStatus'?{accounts:[{id:'b',rules:true,organize:true}]}:{ready:true}; state.accounts=state.accounts.filter(a=>a.id!=='a'); renderSettingsAccounts()`);
  await tick();
  assert.match(f.get('settings-account-title').textContent, /b@example.invalid/);
  assert.match(f.get('settings-capabilities').textContent, /Rules: Permission granted/);
  f.ui.run(`oldPermissions({accounts:[{id:'a',rules:false,organize:false}]})`); await tick();
  assert.match(f.get('settings-capabilities').textContent, /Rules: Permission granted/);
});
