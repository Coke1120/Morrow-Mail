import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { nodeCompatModule } from './node-compat.js';

const { createStore } = await import(nodeCompatModule('server/store.js'));

const enabled = process.env.MORROW_TEST_RUST === '1';
const executable = resolve('rust/target/debug/morrow-service' + (process.platform === 'win32' ? '.exe' : ''));
async function start(directory, assetDirectory, signal) {
  signal.throwIfAborted();
  const token = randomBytes(32).toString('hex');
  const updateToken = randomBytes(32).toString('hex');
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const abort = () => child.kill();
  signal.addEventListener('abort', abort, { once: true });
  const closed = new Promise(resolve => child.once('close', () => { signal.removeEventListener('abort', abort); resolve(); }));
  let output = '', errors = '';
  child.stderr.on('data', data => { errors += data; });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(Error('Rust startup timed out: ' + errors)); }, 15000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); reject(Error('Rust service exited: ' + errors)); });
    child.stdout.on('data', data => { output += data; if (output.includes('\n')) { clearTimeout(timeout); try { resolve(JSON.parse(output.split('\n')[0]).port); } catch (error) { reject(error); } } });
  });
  child.stdin.write(JSON.stringify({ token, updateToken, dataDirectory: directory, port: 0, parentPID: process.pid, ...(assetDirectory ? { assetDirectory } : {}) }) + '\n');
  let port;
  try { port = await ready; } catch (error) { child.kill(); await closed; throw error; }
  const request = async (path, { method = 'GET', body, owner = 'a@example.test', headers = {} } = {}) => {
    const fetchRequest = headers.Host || headers['Sec-Fetch-Site'] ? (url, options) => new Promise((resolve, reject) => { const req = httpRequest(url, options, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: new Headers(res.headers), json: async () => JSON.parse(Buffer.concat(chunks)) })); }); req.on('error', reject); req.end(options.body); }) : fetch;
    const response = await fetchRequest(`http://127.0.0.1:${port}/api${path}`, { method, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), headers: { Authorization: `Bearer ${token}`, 'X-Genmail-Account': owner, 'X-Morrow-View': 'paged', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { child, closed, request, token, updateToken, origin: `http://127.0.0.1:${port}`, async stop() { const timeout = setTimeout(() => child.kill(), 70000); try { child.stdin.end(); await closed; assert.equal(child.exitCode, 0, errors); assert.equal(errors, ''); } finally { clearTimeout(timeout); } } };
}
test('Trusted desktop assets require an existing absolute root and preserve HTTP authentication', { skip: !enabled, timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'morrow-rust-assets-'));
  let service;
  t.after(async () => { if (service) { service.child.kill(); await service.closed; } rmSync(directory, { recursive: true, force: true }); });
  await assert.rejects(start(directory, 'relative/dist', t.signal), /asset directory is invalid/);
  await assert.rejects(start(directory, join(directory, 'absent'), t.signal), /asset directory is invalid/);
  const assets = join(directory, 'assets'); mkdirSync(assets);
  writeFileSync(join(assets, 'index.html'), '<!doctype html><title>Fixture assets</title>');
  service = await start(directory, assets, t.signal);
  try {
    const headers = { Authorization: `Bearer ${service.token}` };
    assert.equal(await (await fetch(service.origin, { headers })).text(), '<!doctype html><title>Fixture assets</title>');
    assert(!(await (await fetch(service.origin)).text()).includes('Fixture assets'));
    assert.equal((await fetch(service.origin + '/assets/missing.js')).status, 401);
  } finally { await service.stop(); }
});
test('Rust private service authenticates, pages with owners, retains unread changes and releases its writer on EOF', { skip: !enabled, timeout: 120000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'morrow-rust-http-'));
  let service;
  t.after(async () => { if (service) { service.child.kill(); await service.closed; } rmSync(directory, { recursive: true, force: true }); });
  const store = createStore(directory);
  store.setSettings({ mailAccounts: { 'a@example.test': { email: 'a@example.test', password: 'fixture-only', provider: 'imap' }, 'b@example.test': { email: 'b@example.test', provider: 'google', accessToken: 'fixture-only' } }, activeAccount: 'a@example.test', preferences: { syncInterval: 0 } });
  const fixtures = [];
  for (const account of ['a@example.test', 'b@example.test']) for (let i = 0; i < 65; i++) {
    const message = { id: `mail-${String(i).padStart(3, '0')}`, date: '2026-09-01T00:00:00.000Z', folder: 'inbox', category: 'primary', fromName: ['張先生', 'Alice 10', 'Alice 2', 'Álice', 'Åsa', 'A-b', 'Ab', '陳先生'][i % 8], subject: i === 0 ? 'A'.repeat(5000) : `財務 ${i}`, body: 'private full body ' + account, preview: 'summary', read: false, starred: i === 0 };
    store.upsertMessage(account, message); fixtures.push({ ...message, accountId: account, viewId: JSON.stringify([account, message.id]) });
  }
  store.close();
  service = await start(directory, undefined, t.signal);
  const denied = await service.request('/state', { headers: { Authorization: '' } });
  assert.equal(denied.status, 401);
  assert.equal((await service.request('/state', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await service.request('/state', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await service.request('/state', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const state = await service.request('/state', { owner: 'all' });
  assert.equal(state.status, 200);
  assert.equal(state.headers.get('cache-control'), 'no-store');
  assert.equal(state.body.mailPage.total, 130);
  assert.equal(state.body.messages.length, 50);
  assert.equal(state.body.accounts[0].unread, 65);
  assert(!JSON.stringify(state.body).includes('fixture-only'));
  assert(state.body.messages.every(message => !Object.hasOwn(message, 'body') && message.accountId !== 'demo'));
  let cursor = '', ids = [];
  do {
    const result = await service.request('/mail/page', { method: 'POST', owner: 'all', body: { folder: 'inbox', pageSize: 13, cursor, sort: 'sender', locale: 'zh-HK' } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    ids.push(...result.body.messages.map(message => message.viewId)); cursor = result.body.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 130); assert.equal(new Set(ids).size, 130);
  for (const locale of ['en', 'zh-HK', 'sv', 'en-US-u-rg-hkzzzz']) for (const sort of ['sender', 'subject']) {
    const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
    const field = sort === 'sender' ? 'fromName' : 'subject';
    const expected = [...fixtures].sort((a, b) => collator.compare(a[field], b[field]) || (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : a.id < b.id ? -1 : 1));
    let cursor = '', actual = [];
    do {
      const result = await service.request('/mail/page', { method: 'POST', owner: 'all', body: { pageSize: 13, cursor, sort, locale } });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert(result.body.messages.every(message => message.subject.length <= 1000 && !Object.hasOwn(message, 'body')));
      cursor = result.body.nextCursor; assert(cursor.length < 1024, 'cursor must not grow with a provider subject');
      actual.push(...result.body.messages.map(message => message.viewId));
    } while (cursor);
    assert.deepEqual(actual, expected.map(message => message.viewId), sort + ' ' + locale);
  }
  const longSubjectPage = await service.request('/mail/page', { method: 'POST', owner: 'all', body: { sort: 'subject', locale: 'en', pageSize: 1 } });
  assert.equal(longSubjectPage.body.messages[0].subject, 'A'.repeat(1000));
  assert(longSubjectPage.body.nextCursor.length < 1024);
  assert.equal((await service.request('/mail/page', { method: 'POST', owner: 'all', body: { sort: 'subject', locale: 'en', pageSize: 1, cursor: longSubjectPage.body.nextCursor } })).status, 200);
  const legacy = await service.request('/state', { owner: 'all', headers: { 'X-Morrow-View': '' } });
  assert.equal(legacy.body.messages.length, 130);
  assert(legacy.body.messages.every(message => message.body && message.aiSummary === null));
  const page = await service.request('/mail/page', { method: 'POST', body: { pageSize: 2 } });
  assert.equal((await service.request('/messages/mail-000', { method: 'PATCH', owner: 'all', body: { read: true } })).status, 409);
  assert.equal((await service.request('/messages/mail-000', { method: 'PATCH', owner: '', body: { read: true } })).status, 409);
  assert.equal((await service.request('/messages/mail-000', { method: 'PATCH', body: { read: true } })).status, 200);
  assert.equal((await service.request('/messages/mail-000')).body.message.read, true);
  assert.equal((await service.request('/messages/mail-000', { owner: 'b@example.test' })).body.message.read, false);
  assert.equal((await service.request('/mail/page', { method: 'POST', body: { pageSize: 2, cursor: page.body.nextCursor } })).status, 409);
  await service.request('/messages/mail-000', { method: 'PATCH', body: { read: false } });
  const onlineBackup = join(directory, 'online-backup');
  const body = { destination: onlineBackup };
  assert.equal((await service.request('/backup', { method: 'POST', body })).status, 403, 'renderer bearer cannot choose backup paths');
  assert.equal((await service.request('/backup', { method: 'POST', body, headers: { 'X-Morrow-Update': service.token } })).status, 403);
  const headers = { 'X-Morrow-Update': service.updateToken };
  assert.equal((await service.request('/backup', { method: 'POST', body: { destination: 'relative' }, headers })).status, 400);
  assert.equal((await service.request('/backup', { method: 'POST', body, headers })).status, 200);
  assert.notEqual((await service.request('/backup', { method: 'POST', body, headers })).status, 200, 'never overwrite a verified backup');
  const online = createStore(onlineBackup);
  try {
    assert.equal(online.getMessage('a@example.test', 'mail-000').read, false);
    assert.equal(online.getSettings().mailAccounts['b@example.test'].accessToken, 'fixture-only');
  } finally { online.close(); }
  assert.equal((await service.request('/state')).status, 200, 'online backup keeps the service running');
  await service.stop();
  service = await start(directory, undefined, t.signal);
  assert.equal((await service.request('/messages/mail-000')).body.message.read, false);
  await service.stop();
  const destination = join(directory, 'manual-backup');
  assert.match(execFileSync(executable, ['--backup', directory, destination], { encoding: 'utf8', timeout: 30000 }), /Verified/);
  const backup = createStore(destination);
  try { assert.equal(backup.getMessage('a@example.test', 'mail-000').read, false); } finally { backup.close(); }
  assert.throws(() => execFileSync(executable, ['--backup', directory, destination], { stdio: 'pipe', timeout: 30000 }));
});
