import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';

const owner = 'owner@example.invalid', other = 'other@example.invalid';
const connection = provider => ({ email: owner, provider, connectionId: 'retained-generation', clientId: 'fixture-client',
  ...(provider === 'google' ? { clientSecret: 'fixture-secret' } : {}), refreshToken: 'original-refresh', accessToken: 'expired-access', expiresAt: 0,
  mailScope: provider === 'google' ? 'openid email https://www.googleapis.com/auth/gmail.modify' : 'offline_access User.Read Mail.ReadWrite Mail.Send',
  grantedScopes: provider === 'google' ? 'https://www.googleapis.com/auth/gmail.modify' : 'User.Read Mail.ReadWrite Mail.Send' });
async function fixture(t, mail) {
  const directory = mkdtempSync(`${tmpdir()}/morrow-oauth-refresh-`);
  let store = createStore(directory), app;
  store.setSettings({ mailAccounts: { [owner]: mail, [other]: { email: other, provider: 'imap', password: 'other-credentials' } }, mail, activeAccount: other });
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const start = () => {
    app = createApp({ store, port, appUrl: origin, googleOAuth: null });
    server.on('request', app);
  };
  start();
  t.after(async () => { app.locals.automation.stop(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (path, method = 'POST') => new Promise((resolve, reject) => {
    const req = httpRequest(`${origin}${path}`, { method, headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Genmail-Account': owner, 'X-Morrow-View': 'paged' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject); req.end(method === 'POST' ? '{}' : undefined);
  });
  return { call, get store() { return store; }, restart() { app.locals.automation.stop(); server.removeAllListeners('request'); store.close(); store = createStore(directory); start(); } };
}

test('expired Google/Microsoft authorization distinguishes outages, invalid grants and app configuration without losing credentials', async t => {
  for (const provider of ['google', 'microsoft']) {
    await t.test(provider, async t => {
      const mail = connection(provider), f = await fixture(t, mail), original = f.store.getSettings().mailAccounts;
      let mode, calls = 0;
      t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(new URL(url).hostname, provider === 'google' ? 'oauth2.googleapis.com' : 'login.microsoftonline.com');
        assert.equal(options.body.get('grant_type'), 'refresh_token');
        assert.equal(options.body.get('refresh_token'), 'original-refresh');
        assert.equal(options.body.get('client_secret'), provider === 'google' ? 'fixture-secret' : null);
        assert.equal(options.redirect, 'error'); calls++;
        if (mode === 'network') throw new Error('PRIVATE_PROVIDER_SECRET');
        if (mode === 'invalid-json') return new Response('PRIVATE_PROVIDER_SECRET', { status: 200 });
        if (mode === 'oversized') return Response.json({ error: 'invalid_grant', error_description: 'PRIVATE_PROVIDER_SECRET'.repeat(4000) }, { status: 400 });
        return Response.json({ error: mode, error_description: 'PRIVATE_PROVIDER_SECRET' }, { status: mode === '429' ? 429 : mode === '503' ? 503 : 400 });
      });
      for (const [value, code, recovery] of [['network', 'oauth_refresh_failed', 'retry'], ['429', 'oauth_refresh_failed', 'retry'], ['503', 'oauth_refresh_failed', 'retry'], ['invalid-json', 'oauth_refresh_failed', 'retry'], ['oversized', 'oauth_refresh_failed', 'retry'], ['invalid_grant', 'oauth_reconnect_required', 'reconnect'], ['invalid_client', 'oauth_configuration', 'configure']]) {
        mode = value; const beforeCalls = calls;
        const result = await f.call('/api/sync');
        assert.equal(result.status, 502); assert.equal(result.data.code, code); assert.equal(result.data.recoveryAction, recovery);
        assert.equal(calls, beforeCalls + 1, 'no automatic token retries');
        if (recovery !== 'reconnect') assert.doesNotMatch(result.data.error, /expired|reconnect/i);
        assert.doesNotMatch(JSON.stringify(result.data), /PRIVATE_PROVIDER_SECRET|original-refresh|expired-access|fixture-secret/);
        assert.deepEqual(f.store.getSettings().mailAccounts, original);
        const state = await f.call('/api/state', 'GET');
        assert.equal(state.data.settings.mail.configured, true);
        assert.equal(state.data.syncErrors[0].code, code);
        assert.doesNotMatch(JSON.stringify(state.data), /original-refresh|expired-access|fixture-secret/);
      }
      const withoutRefresh = structuredClone(original); delete withoutRefresh[owner].refreshToken;
      f.store.setSettings({ mailAccounts: withoutRefresh });
      const beforeCalls = calls, missing = await f.call('/api/mail/folders', 'GET');
      assert.equal(missing.status, 401); assert.equal(missing.data.code, 'oauth_reconnect_required');
      assert.equal(calls, beforeCalls);
      f.store.setSettings({ mailAccounts: original });
      f.restart(); assert.deepEqual(f.store.getSettings().mailAccounts, original);
    });
  }
});

test('refresh rotations and omitted refresh tokens retain scopes, client credentials, owners and milliseconds across restart', async t => {
  for (const provider of ['google', 'microsoft']) await t.test(provider, async t => {
    const f = await fixture(t, connection(provider));
    let tokenCalls = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const host = new URL(url).hostname;
      if (['oauth2.googleapis.com', 'login.microsoftonline.com'].includes(host)) {
        tokenCalls++;
        assert.equal(options.body.get('refresh_token'), tokenCalls > 2 ? 'rotated-refresh' : 'original-refresh');
        return Response.json({ access_token: 'current-access', expires_in: '3600', ...(tokenCalls === 2 ? { refresh_token: 'rotated-refresh' } : {}) });
      }
      assert.ok(['gmail.googleapis.com', 'graph.microsoft.com'].includes(host));
      assert.equal(options.headers.Authorization, 'Bearer current-access');
      return Response.json(provider === 'google' ? { messages: [] } : { value: [] });
    });
    const initial = f.store.getSettings(), before = Date.now();
    assert.equal((await f.call('/api/sync')).status, 200);
    let saved = f.store.getSettings();
    assert.equal(saved.mailAccounts[owner].refreshToken, 'original-refresh');
    assert.ok(saved.mailAccounts[owner].expiresAt >= before + 3_600_000);
    assert.ok(saved.mailAccounts[owner].expiresAt <= Date.now() + 3_600_000);
    for (const key of ['clientId', 'clientSecret', 'mailScope', 'grantedScopes', 'connectionId']) assert.equal(saved.mailAccounts[owner][key], initial.mailAccounts[owner][key]);
    assert.deepEqual(saved.mailAccounts[other], initial.mailAccounts[other]);
    assert.equal(saved.activeAccount, other); assert.deepEqual(saved.mail, saved.mailAccounts[owner]);
    f.restart(); assert.equal((await f.call('/api/sync')).status, 200); assert.equal(tokenCalls, 1);
    saved = f.store.getSettings(); saved.mailAccounts[owner].expiresAt = 0;
    f.store.setSettings({ mailAccounts: saved.mailAccounts });
    assert.equal((await f.call('/api/sync')).status, 200);
    assert.equal(f.store.getSettings().mailAccounts[owner].refreshToken, 'rotated-refresh');
    f.restart(); assert.equal(f.store.getSettings().mailAccounts[owner].refreshToken, 'rotated-refresh');
  });
});

test('a pending refresh cannot resurrect a removed/replaced account; storage errors are not reported as expired consent', async t => {
  const f = await fixture(t, connection('google'));
  let entered, release;
  t.mock.method(globalThis, 'fetch', async () => { entered.resolve(); await release.promise; return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 }); });
  for (const replacement of [undefined, { ...connection('google'), connectionId: 'replacement' }]) {
    const accounts = { ...f.store.getSettings().mailAccounts, [owner]: connection('google') };
    f.store.setSettings({ mailAccounts: accounts });
    entered = Promise.withResolvers(); release = Promise.withResolvers();
    const pending = f.call('/api/mail/folders', 'GET'); await entered.promise;
    if (replacement) accounts[owner] = replacement; else delete accounts[owner];
    f.store.setSettings({ mailAccounts: accounts }); release.resolve();
    assert.equal((await pending).status, 409); assert.deepEqual(f.store.getSettings().mailAccounts, accounts);
  }
  f.store.setSettings({ mailAccounts: { ...f.store.getSettings().mailAccounts, [owner]: connection('google') } });
  entered = Promise.withResolvers(); release = Promise.withResolvers();
  const pending = f.call('/api/mail/folders', 'GET'); await entered.promise;
  const save = t.mock.method(f.store, 'setSettings', () => { throw new Error('PRIVATE_STORAGE_ERROR'); });
  release.resolve(); const result = await pending; save.mock.restore();
  assert.equal(result.status, 500); assert.doesNotMatch(JSON.stringify(result.data), /expired|reconnect|PRIVATE_STORAGE_ERROR/i);
  assert.equal(f.store.getSettings().mailAccounts[owner].refreshToken, 'original-refresh');
});
