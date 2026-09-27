import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/store.js';
import { createApp } from '../server/app.js';
import { parseSearch, lexicalSearch, searchSegments } from '../server/search.js';
import { createSmartSearch, fetchEmbeddings } from '../server/smart-search.js';
import { updatePolicy } from '../server/policy.js';
import { initializeSearchIndex } from '../server/search-index.js';

function fixture(t) {
  const directory = mkdtempSync(`${tmpdir()}/morrow-search-`), store = createStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const accounts = ['a@example.com', 'b@example.com'];
  store.setSettings({ mailAccounts: Object.fromEntries(accounts.map(email => [email, { email, connectionId: email }])), activeAccount: 'all', policy: updatePolicy({}, { folders: { inbox: true, sent: true, archive: true }, content: { body: true, subject: true, sender: true } }) });
  const add = (account, id, patch = {}) => store.upsertMessage(account, { id, date: new Date().toISOString(), folder: 'inbox', fromName: 'Jane Doe', fromEmail: 'jane@example.com', to: 'a@example.com', cc: 'copy@example.com', bcc: 'private@example.com', subject: '報價 INV-1042', body: '請於本月付款，附上發票。 Café project payment timeline.', read: false, starred: true, labels: ['Finance'], ...patch });
  return { directory, store, accounts, add, search: (query, options = {}, scope = accounts) => lexicalSearch(store, parseSearch({ query, scope: 'account', ...options }), scope), connections: () => store.getSettings().mailAccounts };
}

test('indexed search supports short Han, traditional/simplified, phrases, accents, exact IDs, filters and durable mutation rollback', t => {
  const legacy = new DatabaseSync(':memory:');
  try {
    legacy.exec('CREATE TABLE messages(account TEXT, id TEXT, data TEXT, PRIMARY KEY(account,id))');
    legacy.prepare('INSERT INTO messages VALUES(?,?,?)').run('legacy@example.com', 'old', JSON.stringify({ subject: '發票', body: 'Existing mail' }));
    initializeSearchIndex(legacy); initializeSearchIndex(legacy);
    assert.equal(legacy.prepare("SELECT count(*) n FROM search_fts WHERE search_fts MATCH '发票'").get().n, 1);
    assert.equal(legacy.prepare('SELECT count(*) n FROM messages').get().n, 1);
  } finally { legacy.close(); }
  const f = fixture(t), [a, b] = f.accounts;
  f.add(a, 'same'); f.add(b, 'same', { fromName: 'Other Person', body: 'A different mail.', subject: '报价 INV-2042' });
  for (const query of ['付款', '发票', '發票', '票', 'cafe', 'INV-1042', '"project payment"', '付款 cafe', 'from:"Jane Doe" to:private@example.com label:finance is:unread']) assert.equal(f.search(query).total, 1, query);
  assert.equal(f.search('报价').total, 2);
  assert.equal(f.search('"payment project"').total, 0);
  assert.throws(() => f.search('invoice" OR *'), { status: 400 });
  assert.throws(() => parseSearch({ query: 'unknown:thing' }), { status: 400 });
  for (const query of ['"unfinished', 'after:2026-02-30', 'is:wrong', 'in:missing', 'from:', 'from:""']) assert.throws(() => parseSearch({ query }), { status: 400 });
  assert.equal(f.search('', { filters: { after: '2099-01-01' } }).total, 0);
  f.store.updateMessage(a, 'same', { body: '改為明日報價', read: true, folder: 'archive', labels: ['Work'] });
  assert.equal(f.search('付款').total, 0); assert.equal(f.search('明日').total, 1);
  assert.equal(f.search('is:unread label:finance').total, 1);
  assert.throws(() => f.store.transaction(() => { f.add(a, 'rolledback', { body: 'rollbackneedle' }); throw Error('abort'); }));
  assert.equal(f.search('rollbackneedle').total, 0);
  f.store.deleteMessage(a, 'same'); assert.equal(f.search('明日').total, 0);
  const reopened = createStore(f.directory); assert.equal(lexicalSearch(reopened, parseSearch({ query: '报价', scope: 'all' }), [b]).total, 1); reopened.close();
  const segments = searchSegments('A <script>發票</script> and more', ['发票']);
  assert.equal(segments.filter(item => item.hit).map(item => item.text).join(''), '發票');
  assert.equal(segments.map(item => item.text).join(''), 'A <script>發票</script> and more');
});

test('search API separates colliding account IDs, excludes demo/disconnected mail, paginates, and persists scoped history without exposing keys', async t => {
  const f = fixture(t), [a, b] = f.accounts;
  for (let i = 0; i < 35; i++) f.add(a, `m${i}`, { date: new Date(Date.now() - i * 1000).toISOString() });
  f.add(b, 'm0', { folder: 'sent' }); f.add(b, 'trash', { folder: 'trash' }); f.add('disconnected@example.com', 'm0');
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const app = createApp({ store: f.store, port, appUrl: origin, nativeToken: 'private-fixture-token' }); server.on('request', app);
  t.after(async () => { app.locals.smartSearch.stop(); await new Promise(resolve => server.close(resolve)); });
  const request = async (path, body, account = a, extra = {}) => { const response = await fetch(origin + '/api' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer private-fixture-token', 'Content-Type': 'application/json', ...(account ? { 'X-Genmail-Account': account } : {}), ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json() }; };
  assert.equal((await request('/search', {}, '')).status, 409);
  assert.equal((await request('/search', {}, a, { Origin: 'https://hostile.example' })).status, 403);
  const first = await request('/search', { query: '付款', scope: 'all', sort: 'newest' });
  const second = await request('/search', { query: '付款', scope: 'all', sort: 'newest', page: 1 });
  assert.equal(first.data.total, 36); assert.equal(first.data.messages.length, 30); assert.equal(second.data.messages.length, 6);
  const rows = [...first.data.messages, ...second.data.messages]; assert.equal(new Set(rows.map(item => item.viewId)).size, 36);
  assert.ok(rows.filter(item => item.id === 'm0').length === 2); assert.ok(first.data.coverage.every(item => f.accounts.includes(item.account)));
  assert.equal((await request('/search', { query: '付款', scope: 'folder', folder: 'inbox' }, b)).data.total, 0);
  assert.equal((await request('/search', { query: 'in:trash', scope: 'all' })).data.total, 1);
  await request('/search/preferences', { action: 'save', value: { query: 'from:jane', scope: 'all' } });
  assert.equal((await request('/search/preferences')).data.saved.length, 1);
  assert.equal((await request('/search/preferences', null, b)).data.saved.length, 0);
  f.store.setSettings({ mailAccounts: { [a]: f.connections()[a] } });
  assert.equal((await request('/search', { query: '付款', scope: 'all' })).data.total, 35);
  assert.equal((await request('/search', {}, b)).status, 409);
  assert.doesNotMatch(JSON.stringify((await request('/search/settings')).data), /private-fixture-token/);
});

test('semantic indexing is reviewed, incremental, scoped before embedding and durable; hybrid matching and pagination reuse query vectors', async t => {
  const f = fixture(t), [a, b] = f.accounts, calls = [];
  f.add(a, 'payment', { subject: 'PRIVATE SUBJECT', body: 'The customer asks for extra time to settle their bill.' });
  f.add(a, 'meeting', { body: 'Team lunch and coffee.' }); f.add(b, 'payment', { body: 'OTHER ACCOUNT SECRET' });
  f.store.setSettings({ policy: updatePolicy(f.store.getSettings().policy, { content: { subject: false, sender: false } }) });
  const embed = async (_config, texts) => { calls.push(texts); return texts.map(text => /extra time|延期付款/.test(text) ? [1, 0] : [0, 1]); };
  const settings = { store: f.store, connections: f.connections, apiBase: value => { const url = new URL(value); if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw Error('unsafe'); return value; }, embed };
  const smart = createSmartSearch(settings);
  assert.throws(() => smart.preview(), { status: 403 });
  smart.update({ enabled: true, model: 'fixture', baseUrl: 'http://localhost/v1', apiKey: 'fixture-secret', accounts: [a] });
  let preview = smart.preview(); assert.equal(calls.length, 0); assert.equal(preview.job.sampleCount, 2); assert.ok(preview.job.estimatedTokens < 16000);
  assert.doesNotMatch(JSON.stringify(preview), /PRIVATE SUBJECT|OTHER ACCOUNT|private@example|fixture-secret/);
  await smart.index(preview.job.id); assert.equal(smart.state().indexed, 2);
  assert.doesNotMatch(JSON.stringify(calls), /PRIVATE SUBJECT|OTHER ACCOUNT|jane@example|private@example/);
  assert.throws(() => smart.preview(), { status: 409 });
  const options = parseSearch({ query: '延期付款', scope: 'all', smart: true });
  const found = await smart.search(options, [a, b]); assert.equal(found.rows[0].message.id, 'payment'); assert.equal(found.rows[0].account, a);
  const count = calls.length; await smart.search({ ...options, page: 1 }, [a, b]); assert.equal(calls.length, count);
  f.store.updateMessage(a, 'payment', { read: true }); assert.equal(smart.state().pending, 0);
  f.store.updateMessage(a, 'payment', { body: 'The customer asks for extra time to pay a new bill.' }); assert.equal(smart.state().pending, 1);
  preview = smart.preview(); assert.equal(preview.job.sampleCount, 1); await smart.index(preview.job.id);
  const restarted = createSmartSearch(settings); assert.equal(restarted.state().indexed, 2);
  await assert.rejects(restarted.search({ ...options, cachedOnly: true }, [a]), { status: 409 });
  restarted.update({ model: 'different-model' }); assert.equal(restarted.state().indexed, 0);
  assert.equal(restarted.state().settings.hasApiKey, true);
  restarted.update({ baseUrl: 'https://new.example/v1' }); assert.equal(restarted.state().settings.hasApiKey, false);
});

test('permission revocation and changing source/scope discard in-flight embeddings; interrupted batches do not retry', async t => {
  const f = fixture(t), [a] = f.accounts; f.add(a, 'x');
  let finish, calls = 0;
  const settings = { store: f.store, connections: f.connections, apiBase: value => value, embed: async () => { calls++; return new Promise(resolve => { finish = resolve; }); } };
  const smart = createSmartSearch(settings); smart.update({ enabled: true, model: 'fixture', accounts: [a] });
  let preview = smart.preview(), running = smart.index(preview.job.id);
  f.store.setSettings({ policy: updatePolicy(f.store.getSettings().policy, { content: { body: false } }) });
  finish([[1, 0]]); await running; assert.equal(f.store.search.query('SELECT * FROM search_vectors').length, 0);
  f.store.setSettings({ policy: updatePolicy(f.store.getSettings().policy, { content: { body: true } }) });
  preview = smart.preview(); running = smart.index(preview.job.id); smart.clear(); finish([[1, 0]]); await running;
  assert.equal(f.store.search.query('SELECT * FROM search_vectors').length, 0);
  preview = smart.preview(); f.store.setSettings({ searchIndex: { ...f.store.getSettings().searchIndex, status: 'running' } });
  const restarted = createSmartSearch(settings); assert.equal(restarted.state().job.status, 'interrupted'); assert.equal(calls, 2);
  f.store.setSettings({ mailAccounts: {} }); assert.equal(restarted.state().indexed, 0);
});

test('embedding transport validates OpenAI ordering, Ollama shape and refuses redirect credential forwarding', async t => {
  const seen = []; const server = createServer(async (req, res) => {
    let bytes = ''; for await (const chunk of req) bytes += chunk;
    seen.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(bytes) });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/redirect')) { res.writeHead(302, { Location: 'http://127.0.0.1:9/secret' }); res.end(); }
    else res.end(JSON.stringify(req.url.endsWith('/api/embed') ? { embeddings: [[1, 0], [0, 1]] } : { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`, config = { baseUrl, model: 'fixture', apiKey: 'local-fixture-key', protocol: 'openai' };
  assert.deepEqual(await fetchEmbeddings(config, ['first', 'second']), [[1, 0], [0, 1]]);
  assert.deepEqual(await fetchEmbeddings({ ...config, protocol: 'ollama' }, ['first', 'second']), [[1, 0], [0, 1]]);
  assert.equal(seen[1].body.truncate, false); assert.equal(seen[0].authorization, 'Bearer local-fixture-key');
  await assert.rejects(fetchEmbeddings({ ...config, baseUrl: baseUrl + '/redirect' }, ['first'])); assert.equal(seen.length, 3);
});

test('semantic queries discard results when permissions, connections or mail change during the model call', async t => {
  for (const change of ['policy', 'connection', 'message']) {
    const f = fixture(t), [a] = f.accounts; f.add(a, 'x');
    let querying = false, finish;
    const smart = createSmartSearch({ store: f.store, connections: f.connections, apiBase: value => value,
      embed: async (_config, texts) => querying ? new Promise(resolve => { finish = resolve; }) : texts.map(() => [1, 0]) });
    smart.update({ enabled: true, model: 'fixture', accounts: [a] });
    await smart.index(smart.preview().job.id); querying = true;
    const result = smart.search(parseSearch({ query: 'bill', smart: true, scope: 'all' }), [a]);
    if (change === 'policy') f.store.setSettings({ policy: updatePolicy(f.store.getSettings().policy, { enabled: false }) });
    if (change === 'connection') f.store.setSettings({ mailAccounts: {} });
    if (change === 'message') f.store.updateMessage(a, 'x', { body: 'Replaced text', folder: 'trash' });
    finish([[1, 0]]);
    await assert.rejects(result, { status: 409 }, change);
  }
});

test('a second-message model rejection preserves progress and a safe actionable reason without retries', async t => {
  for (const protocol of ['openai', 'ollama']) for (const [status, reason] of [[429, /rate limit/], [413, /input/], [401, /API key/], [503, /service/]]) {
    const f = fixture(t), [a] = f.accounts;
    f.add(a, 'first'); f.add(a, 'second');
    let calls = 0;
    const server = createServer(async (req, res) => {
      let bytes = ''; for await (const chunk of req) bytes += chunk;
      const body = JSON.parse(bytes); calls++;
      if (calls > 1) { res.writeHead(status); res.end('PRIVATE MODEL BODY fixture-key mail-content'); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(protocol === 'ollama' ? { embeddings: body.input.map(() => [1, 0]) } : { data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const smart = createSmartSearch({ store: f.store, connections: f.connections, apiBase: value => value });
      smart.update({ enabled: true, model: 'fixture', protocol, baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'fixture-key', accounts: [a] });
      await smart.index(smart.preview().job.id);
      const state = smart.state();
      assert.equal(state.job.status, 'failed'); assert.equal(state.job.completed, 1); assert.equal(state.indexed, 1);
      assert.match(state.job.error, new RegExp(`HTTP ${status}`)); assert.match(state.job.error, reason);
      assert.doesNotMatch(JSON.stringify(state), /PRIVATE MODEL BODY|fixture-key|mail-content/);
      assert.equal(smart.state().job.status, 'failed'); await smart.stop(); assert.equal(calls, 2);
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
});

test('index failures retain locally validated vector reasons but redact arbitrary transport errors', async t => {
  for (const [mode, reason] of [['empty', /empty vector/], ['dimension', /dimensions changed/], ['raw', /Check the connection and model service/]]) {
    const f = fixture(t), [a] = f.accounts;
    f.add(a, 'first'); f.add(a, 'second');
    let calls = 0;
    const smart = createSmartSearch({ store: f.store, connections: f.connections, apiBase: value => value, embed: async () => {
      if (++calls === 1) return [[1, 0]];
      if (mode === 'raw') throw Object.assign(new Error('PRIVATE MODEL BODY fixture-key mail-content'), { status: 502 });
      return [mode === 'empty' ? [0, 0] : [1, 0, 0]];
    } });
    smart.update({ enabled: true, model: 'fixture', accounts: [a] });
    await smart.index(smart.preview().job.id);
    const state = smart.state();
    assert.equal(state.job.status, 'failed'); assert.equal(state.job.completed, 1); assert.equal(state.indexed, 1);
    assert.match(state.job.error, reason); assert.doesNotMatch(JSON.stringify(state), /PRIVATE MODEL BODY|fixture-key|mail-content/);
    await smart.stop(); assert.equal(calls, 2);
  }
});

test('embedding connection probe validates unsaved settings without mail, writes or credential forwarding', async t => {
  const f = fixture(t), seen = [];
  let invalid = false;
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const app = createApp({ store: f.store, port, appUrl: origin, nativeToken: 'probe-fixture-token', services: {
    embed: async (config, input) => { seen.push({ config, input }); return invalid ? [[0, 0]] : [[1, 2, 3]]; },
  } }); server.on('request', app);
  t.after(async () => { await app.locals.smartSearch.stop(); await new Promise(resolve => server.close(resolve)); });
  const request = async (body, headers = {}) => {
    const response = await fetch(origin + '/api/search/test', { method: 'POST', headers: { Authorization: 'Bearer probe-fixture-token', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  app.locals.smartSearch.update({ baseUrl: 'https://embedding.example/v1', model: 'saved-model', apiKey: 'saved-fixture-key' });
  f.store.setSettings({ policy: { enabled: false } });
  const before = f.store.getSettings();
  const input = { baseUrl: 'https://embedding.example/v1', model: 'unsaved-model', protocol: 'openai', apiKey: '' };
  assert.equal((await request(input, { Authorization: '' })).status, 401);
  assert.equal((await request(input, { Origin: 'https://hostile.invalid' })).status, 403);
  const result = await request(input);
  assert.deepEqual(result, { status: 200, data: { ok: true, dimensions: 3 } });
  assert.equal(seen[0].config.model, 'unsaved-model'); assert.equal(seen[0].config.apiKey, 'saved-fixture-key');
  assert.deepEqual(seen[0].input, ['Morrow Mail embedding connection test.']);
  assert.equal((await request({ ...input, baseUrl: 'https://different.example', protocol: 'ollama' })).status, 200);
  assert.equal(seen[1].config.apiKey, ''); assert.equal(seen[1].config.protocol, 'ollama');
  assert.equal((await request({ ...input, clearApiKey: true })).status, 200); assert.equal(seen[2].config.apiKey, '');
  assert.deepEqual(await request({}), { status: 200, data: { ok: true, dimensions: 3 } });
  assert.equal(seen[3].config.model, 'saved-model'); assert.equal(seen[3].config.apiKey, 'saved-fixture-key');
  assert.deepEqual(seen[3].input, ['Morrow Mail embedding connection test.']);
  const count = seen.length;
  for (const change of [{ model: '' }, { baseUrl: 'http://remote.invalid' }, { apiKey: 'bad\r\nkey' }, { input: 'private body' }, { enabled: true }]) assert.equal((await request({ ...input, ...change })).status, 400);
  assert.equal(seen.length, count);
  invalid = true;
  const failure = await request(input);
  assert.equal(failure.status, 502); assert.doesNotMatch(JSON.stringify(failure.data), /saved-fixture-key/);
  assert.deepEqual(f.store.getSettings(), before);
  assert.equal(f.store.search.query('SELECT count(*) n FROM search_vectors')[0].n, 0);
});
