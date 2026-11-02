// Real renderer/DOM, synthetic IPC and profile storage; never opens a real account.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { renderer } = require('./check-ux-workflows');
const html = fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8');
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(t, { status = { ready: false, source: 'none', imported: false }, saved = null, accounts = [] } = {}) {
  const dom = new JSDOM(html, { url: 'https://morrow.invalid' });
  const { window } = dom, { document } = window;
  t.after(() => window.close());
  if (saved) window.localStorage.setItem('morrow.googleOnboarding.v1', saved);
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { if (dialog.open) { dialog.open = false; dialog.dispatchEvent(new window.Event('close')); } };
  }
  const calls = [];
  let importer = async () => ({ ...status, cancelled: true });
  window.morrow = { on() {}, invoke: async channel => {
    calls.push(channel);
    if (channel === 'mail:googleOauthStatus') return { success: true, data: status };
    if (channel === 'mail:importGoogleOauth') return { success: true, data: await importer() };
    if (channel === 'mail:oauthStatus') return { success: true, data: { google: false } };
    return { success: true, data: [] };
  } };
  const ui = renderer({ window, document, navigator: window.navigator, Event: window.Event, Node: window.Node,
    requestAnimationFrame: work => { queueMicrotask(() => work(0)); return 1; } });
  ui.context.accounts = accounts;
  ui.run('state.accounts = accounts; wire();');
  return { ui, window, calls, get: id => document.getElementById(id), setImporter: fn => { importer = fn; },
    show: () => ui.run('maybeShowGoogleOnboarding()'), saved: () => window.localStorage.getItem('morrow.googleOnboarding.v1') };
}
test('first use offers import and Later, with actual Accounts settings entry visible outside Advanced', async t => {
  const f = fixture(t); await f.show();
  assert.equal(f.get('google-onboarding').open, true);
  assert.match(f.get('google-onboarding-help').textContent, /Desktop app/);
  assert.match(f.get('google-onboarding').textContent, /Settings → Accounts → Advanced/);
  assert.match(f.get('google-onboarding-settings-help').textContent, /Skipped Google setup/);
  assert.equal(f.get('google-onboarding-settings-help').closest('details'), null);
  assert.match(fs.readFileSync(require.resolve('../renderer/features-catalog'), 'utf8'), /Later and closing the dialog are remembered/);
  f.get('google-onboarding-later').click();
  assert.equal(f.saved(), 'done'); assert.equal(f.get('google-onboarding').open, false);
  await f.show(); assert.equal(f.get('google-onboarding').open, false);
  const reload = fixture(t, { saved: f.saved() }); await reload.show();
  assert.equal(reload.get('google-onboarding').open, false);
  assert.equal(f.calls.includes('mail:addAccount'), false);
});
test('configured profiles and existing accounts never receive the setup prompt', async t => {
  for (const options of [
    { status: { ready: true, source: 'bundled' } },
    { status: { ready: true, source: 'imported', imported: true } },
    { status: { ready: true, source: 'env' } },
    { status: { ready: false, source: 'invalid', imported: true } },
    { accounts: [{ id: 'synthetic', email: 'fixture@example.invalid' }] },
  ]) {
    const f = fixture(t, options); await f.show();
    assert.equal(f.get('google-onboarding').open, false); assert.equal(f.saved(), 'done');
  }
});
test('Escape/back cancellation and programmatic close persist dismissal', async t => {
  const f = fixture(t); await f.show();
  const event = new f.window.Event('cancel', { cancelable: true });
  f.get('google-onboarding').dispatchEvent(event);
  assert.equal(event.defaultPrevented, true); assert.equal(f.saved(), 'done');
  assert.equal(f.get('google-onboarding').open, false);
  const other = fixture(t); await other.show(); other.get('google-onboarding').close();
  assert.equal(other.saved(), 'done');
});
test('picker cancellation and invalid schema keep retry available without storing dismissal', async t => {
  const f = fixture(t); await f.show();
  f.get('google-onboarding-import').click(); await settle();
  assert.match(f.get('google-onboarding-status').textContent, /No file imported/);
  for (const message of ['Invalid JSON', 'Missing client_id', 'Web client is not a Desktop app']) {
    f.setImporter(async () => { throw new Error(message); });
    f.get('google-onboarding-import').click(); await settle();
    assert.match(f.get('google-onboarding-status').textContent, /Could not import/);
    assert.equal(f.get('google-onboarding').open, true);
    assert.equal(f.get('google-onboarding-import').disabled, false); assert.equal(f.saved(), null);
  }
});
test('repeat clicks share importer; success saves dismissal and does not start authorization', async t => {
  const f = fixture(t); await f.show(); let finish;
  f.setImporter(() => new Promise(resolve => { finish = resolve; }));
  f.get('google-onboarding-import').click(); f.get('google-onboarding-import').click();
  assert.equal(f.get('google-onboarding-import').disabled, true);
  assert.equal(f.calls.filter(c => c === 'mail:importGoogleOauth').length, 1);
  finish({ ready: true, source: 'imported', imported: true }); await settle();
  assert.equal(f.saved(), 'done'); assert.equal(f.get('google-onboarding').open, false);
  assert.equal(f.calls.includes('mail:addAccount'), false);
  assert.equal(f.get('google-onboarding-import').disabled, false);
});
test('Later remains nonblocking during picker and other windows observe dismissal', async t => {
  const f = fixture(t); await f.show(); let finish;
  f.setImporter(() => new Promise(resolve => { finish = resolve; }));
  f.get('google-onboarding-import').click(); f.get('google-onboarding-later').click();
  assert.equal(f.get('google-onboarding').open, false);
  finish({ cancelled: true, ready: false, source: 'none' }); await settle();
  assert.equal(f.get('google-onboarding').open, false);
  const other = fixture(t); await other.show();
  other.window.localStorage.setItem('morrow.googleOnboarding.v1', 'done');
  other.window.dispatchEvent(new other.window.StorageEvent('storage', { key: 'morrow.googleOnboarding.v1', newValue: 'done' }));
  assert.equal(other.get('google-onboarding').open, false); await other.show();
  assert.equal(other.get('google-onboarding').open, false);
});
test('readiness failure or another open dialog never triggers a setup prompt', async t => {
  const f = fixture(t); f.ui.run('call = async () => { throw new Error("offline"); }');
  await f.show(); assert.equal(f.get('google-onboarding').open, false); assert.equal(f.saved(), null);
  const other = fixture(t); other.get('connect').showModal(); await other.show();
  assert.equal(other.get('google-onboarding').open, false);
});
test('successful Settings import records onboarding completion, even without the prompt', async t => {
  const f = fixture(t);
  f.setImporter(async () => ({ imported: true, ready: true, source: 'imported' }));
  f.get('google-oauth-import').click(); await settle();
  assert.equal(f.saved(), 'done'); await f.show();
  assert.equal(f.get('google-onboarding').open, false);
});
