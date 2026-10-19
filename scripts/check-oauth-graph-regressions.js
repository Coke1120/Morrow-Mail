const assert = require('node:assert/strict');
const http = require('node:http');
const oauth = require('../host/mail/oauth');
const api = require('../host/mail/provider-api');
const config = require('../host/mail/oauth-config');

const json = (value, status = 200) => ({ ok: status < 400, status, json: async () => value, text: async () => JSON.stringify(value) });
function hit(target) {
  return new Promise((resolve, reject) => {
    http.get(target, (res) => {
      let body = '';
      res.on('data', (part) => { body += part; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}
async function callbackTest(saved) {
  let target, originalPage, duplicatePage, exchanges = 0;
  const signed = await oauth.signIn('microsoft', 'bundle', {
    timeoutMs: 3000,
    fetchImpl: async (url, init) => {
      if (url === config.ENDPOINTS.microsoft.token) {
        exchanges++;
        const body = new URLSearchParams(init.body);
        assert.equal(body.get('code'), 'fixture-code');
        assert.ok(body.get('code_verifier'));
        assert.ok(!body.get('scope').includes('outlook.office.com'));
        return json({ access_token: 'fixture-graph', refresh_token: 'fixture-refresh', scope: config.BUNDLE_SCOPES.microsoft });
      }
      assert.ok(String(url).startsWith('https://graph.microsoft.com/'));
      return json({ mail: 'fixture@example.invalid' });
    },
    openBrowser: async (url) => {
      const auth = new URL(url);
      assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
      target = new URL(auth.searchParams.get('redirect_uri'));
      target.hostname = '127.0.0.1';
      target.searchParams.set('state', auth.searchParams.get('state'));
      target.searchParams.set('code', 'fixture-code');
      const stray = new URL(target);
      stray.searchParams.delete('code');
      stray.searchParams.set('error', 'access_denied');
      stray.searchParams.set('state', 'wrong-state');
      assert.equal((await hit(stray)).status, 400, 'wrong-state error must not cancel pending consent');
      const wrongPath = new URL(target); wrongPath.pathname += '/wrong';
      assert.equal((await hit(wrongPath)).status, 404);
      const missingState = new URL(target); missingState.searchParams.delete('state');
      assert.equal((await hit(missingState)).status, 400);
      originalPage = hit(target);
    },
  });
  const differentCode = new URL(target); differentCode.searchParams.set('code', 'another-code');
  assert.equal((await hit(differentCode)).status, 400, 'replay must match accepted authorization code');
  duplicatePage = hit(target);
  await new Promise((resolve) => setTimeout(resolve, 20));
  signed.complete({ ok: saved, message: saved ? '' : 'Requested feature was not saved.' });
  for (const page of await Promise.all([originalPage, duplicatePage])) {
    assert.equal(page.status, saved ? 200 : 400);
    assert.match(page.body, saved ? /<h1>Connected/ : /Requested feature was not saved/);
  }
  assert.equal(exchanges, 1);
}
async function foldersTest() {
  const calls = [];
  const allowed = new Set(['id', 'displayName', 'parentFolderId', 'childFolderCount']);
  const fetchImpl = async (target, init) => {
    const url = new URL(target); calls.push(url);
    assert.equal(init.headers.authorization, 'Bearer folder-fixture');
    assert.equal(init.method, 'GET');
    assert.equal(url.origin, 'https://graph.microsoft.com');
    assert.ok(url.pathname.startsWith('/v1.0/'));
    for (const field of url.searchParams.get('$select').split(',')) assert.ok(allowed.has(field), `v1.0 does not expose ${field}`);
    if (url.pathname.endsWith('/mailFolders')) return json({ value: [
      { id: 'localized-inbox', displayName: '收件匣', childFolderCount: 1 },
      { id: 'user-folder', displayName: 'Inbox', childFolderCount: 0 },
    ] });
    if (url.pathname.endsWith('/childFolders')) return json({ value: [{ id: 'child', displayName: 'Child', parentFolderId: 'localized-inbox' }] });
    if (url.pathname.endsWith('/inbox')) return json({ id: 'localized-inbox' });
    return json({ error: { code: 'ErrorItemNotFound', message: 'fixture only' } }, 404);
  };
  const rows = await api.listMailFolders('folder-fixture', fetchImpl);
  assert.equal(rows.find((row) => row.id === 'localized-inbox').editable, false);
  assert.equal(rows.find((row) => row.id === 'localized-inbox').wellKnown, 'inbox');
  assert.equal(rows.find((row) => row.id === 'user-folder').editable, true, 'display name alone must never identify a system folder');
  assert.equal(rows.find((row) => row.id === 'child').parentId, 'localized-inbox');
  const firstCount = calls.length;
  await api.listMailFolders('folder-fixture', fetchImpl);
  assert.equal(calls.length - firstCount, 2, 'system identities are cached for this exact grant');
  await assert.rejects(api.listMailFolders('bad-format-fixture', async () => json({ error: { message: 'Bearer secret-fixture' } }, 400)), (error) => /HTTP 400/.test(error.message) && !/secret-fixture/.test(error.message));
  await assert.rejects(api.listMailFolders('denied-fixture', async () => json({}, 403)), /Grant access again/);
}
async function run() {
  await callbackTest(true);
  await callbackTest(false);
  await foldersTest();
  console.log('OAuth callback and Graph v1.0 folder regressions passed.');
}
module.exports = { run };
if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
