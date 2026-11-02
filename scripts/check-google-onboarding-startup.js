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
    saved: () => window.localStorage.getItem('morrow.googleOnboarding.v1'),
  };
}
for (const action of ['changelog-ok', 'changelog-close', 'Escape']) {
  test(`full fresh boot: unseen changelog ${action} hands off once, then dismissal persists`, async t => {
    const f = fixture(t, { seen: '' }); await f.boot();
    assert.deepEqual(f.opened, ['changelog']); assert.equal(f.get('google-onboarding').open, false);
    if (action === 'Escape') f.cancel('changelog');
    else { f.get(action).click(); f.get(action).click(); }
    await settle();
    assert.deepEqual(f.opened, ['changelog', 'google-onboarding']);
    assert.equal(f.document.querySelectorAll('dialog[open]').length, 1);
    assert.equal(f.window.localStorage.getItem('synthetic.changelogSeen'), version);
    if (action === 'Escape') f.cancel('google-onboarding');
    else { f.get('google-onboarding-later').click(); f.get('google-onboarding-later').click(); }
    await settle(); assert.equal(f.saved(), 'done');
    f.get('settings').showModal(); f.get('settings').close(); await settle();
    assert.equal(f.opened.filter(id => id === 'google-onboarding').length, 1);
    const reload = fixture(t, { seen: version, saved: f.saved() }); await reload.boot();
    assert.deepEqual(reload.opened, []);
    assert.equal(f.host.calls.some(c => /importGoogleOauth|addAccount/.test(c)), false);
  });
}
test('full boot with seen changelog shows onboarding directly', async t => {
  const f = fixture(t, { seen: version }); await f.boot();
  assert.deepEqual(f.opened, ['google-onboarding']);
});
test('closing changelog can open another modal; wait for its close, including dynamic dialogs', async t => {
  const f = fixture(t); await f.boot();
  const initialReads = f.host.calls.filter(c => c === 'mail:googleOauthStatus').length;
  const other = f.dialog(f.document.createElement('dialog')); other.id = 'synthetic-other'; f.document.body.append(other);
  f.get('changelog').addEventListener('close', () => other.showModal(), { once: true });
  f.get('changelog-ok').click(); await settle();
  assert.deepEqual(f.opened, ['changelog', 'synthetic-other']);
  assert.equal(f.host.calls.filter(c => c === 'mail:googleOauthStatus').length, initialReads);
  other.close(); await settle();
  assert.deepEqual(f.opened, ['changelog', 'synthetic-other', 'google-onboarding']);
});
test('configured users, newly configured clients and newly connected accounts skip deferred onboarding', async t => {
  for (const mode of ['existing', 'new-client', 'new-account']) {
    const f = fixture(t, mode === 'existing' ? { status: { ready: true, source: 'bundled' } } : {});
    await f.boot(); assert.deepEqual(f.opened, ['changelog']);
    if (mode === 'new-client') f.host.status = { ready: true, imported: true, source: 'imported' };
    if (mode === 'new-account') f.ui.run("state.accounts = [{id:'synthetic',email:'fixture@example.invalid'}]");
    f.get('changelog-ok').click(); await settle();
    assert.equal(f.get('google-onboarding').open, false); assert.equal(f.saved(), 'done');
  }
});
test('a dialog opened during a readiness read prevents stacking; its close refreshes stale status', async t => {
  const f = fixture(t); await f.boot(); let finish;
  f.host.readStatus = () => new Promise(resolve => { finish = resolve; });
  f.get('changelog-ok').click(); await settle();
  f.get('settings').showModal();
  finish({ ready: false, source: 'none' }); await settle();
  assert.equal(f.get('google-onboarding').open, false);
  f.host.readStatus = null; f.host.status = { ready: true, source: 'imported', imported: true };
  f.get('settings').close(); await settle();
  assert.equal(f.get('google-onboarding').open, false); assert.equal(f.saved(), 'done');
});
test('close during an in-flight read invalidates it and serializes the fresh check', async t => {
  const f = fixture(t); await f.boot(); let finish, reads = 0;
  const initialReads = f.host.calls.filter(c => c === 'mail:googleOauthStatus').length;
  f.host.readStatus = () => { reads++; return new Promise(resolve => { finish = resolve; }); };
  f.get('changelog-ok').click(); await settle();
  f.get('settings').showModal(); f.get('settings').close(); await settle();
  assert.equal(reads, 1);
  f.host.readStatus = null; f.host.status = { ready: true, source: 'bundled' };
  finish({ ready: false, source: 'none' }); await settle();
  assert.equal(f.host.calls.filter(c => c === 'mail:googleOauthStatus').length, initialReads + 2);
  assert.equal(f.get('google-onboarding').open, false); assert.equal(f.saved(), 'done');
});
test('another window dismissal during readiness prevents any late prompt', async t => {
  const f = fixture(t); await f.boot(); let finish;
  f.host.readStatus = () => new Promise(resolve => { finish = resolve; });
  f.get('changelog-ok').click(); await settle();
  f.window.localStorage.setItem('morrow.googleOnboarding.v1', 'done');
  f.window.dispatchEvent(new f.window.StorageEvent('storage', { key: 'morrow.googleOnboarding.v1', newValue: 'done' }));
  finish({ ready: false, source: 'none' }); await settle();
  assert.equal(f.get('google-onboarding').open, false);
});

test('slow changelog readiness preserves ordering; seen or failed read releases onboarding', async t => {
  for (const outcome of ['unseen', 'seen', 'failed']) {
    const f = fixture(t); let finish, fail;
    f.host.readSeen = () => new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    await f.boot(); assert.deepEqual(f.opened, []);
    if (outcome === 'failed') fail(new Error('Synthetic settings unavailable'));
    else finish(outcome === 'seen' ? version : '');
    await settle();
    if (outcome === 'unseen') {
      assert.deepEqual(f.opened, ['changelog']);
      f.get('changelog-ok').click(); await settle();
      assert.deepEqual(f.opened, ['changelog', 'google-onboarding']);
    } else assert.deepEqual(f.opened, ['google-onboarding']);
  }
});
