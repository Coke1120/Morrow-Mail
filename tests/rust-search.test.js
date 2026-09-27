import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { nodeCompatModule } from './node-compat.js';

const { createStore } = await import(nodeCompatModule('server/store.js'));
const { createApp } = await import(nodeCompatModule('server/app.js'));
const { lexicalSearch, parseSearch } = await import(nodeCompatModule('server/search.js'));
const { createRustSearch, rustSearchExecutable } = await import(nodeCompatModule('server/rust-search.js'));
const { createSmartSearch } = await import(nodeCompatModule('server/smart-search.js'));
const { updatePolicy } = await import(nodeCompatModule('server/policy.js'));

// The historical bridge finds its worker in that checkout's rust/target/release.
// Stage the current candidate there; the version assertion below stays current.
const available = existsSync(rustSearchExecutable);
if (process.env.MORROW_TEST_RUST && !available) throw Error('Build the release Rust worker before the required contract checks.');
const options = { skip: !available && 'Run npm run rust:test to build the development worker.' };
function fixture(t) {
  const directory = mkdtempSync(`${tmpdir()}/morrow-rust-`), store = createStore(directory), accounts = ['a@example.invalid', 'b@example.invalid'];
  store.setSettings({ activeAccount: 'all', mailAccounts: Object.fromEntries(accounts.map(email => [email, { email, connectionId: email }])), policy: updatePolicy({}, { content: { body: true, subject: true, sender: true } }) });
  for (const account of [...accounts, 'disconnected@example.invalid']) for (let i = 0; i < 42; i++) store.upsertMessage(account, {
    id: `same-${i}`, folder: i === 0 ? 'trash' : 'inbox', date: `2026-09-${i % 2 ? '24' : '25'}T00:00:00.000Z`,
    subject: `報價 INV-${i}`, body: '請於本月付款。 Café project payment timeline.', fromName: 'Jane Doe', fromEmail: 'jane@example.invalid',
    to: account, bcc: 'hidden@example.invalid', read: i % 2 === 0, starred: i % 3 === 0, labels: ['財務', ' White  Space '],
  });
  const workers = [];
  t.after(async () => { await Promise.all(workers.map(worker => worker.stop())); store.close(); rmSync(directory, { force: true, recursive: true }); });
  return { store, accounts, workers };
}

test('Rust read-only search matches the Node corpus, rejects unbounded/unknown operations, and uses the common product version', options, async t => {
  const { store, accounts, workers } = fixture(t), worker = createRustSearch(store.databasePath);
  workers.push(worker);
  assert.equal(execFileSync(rustSearchExecutable, ['--version'], { encoding: 'utf8' }).trim(), JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
  const checksum = () => createHash('sha256').update(readFileSync(store.databasePath)).digest('hex'), before = checksum();
  for (const query of ['', '付款', '票', '發票', '报价', 'INV-12', 'cafe', '"project payment"', '"payment project"', 'from:"Jane Doe" to:hidden@example.invalid', 'after:2026-09-25 before:2026-09-26', 'is:unread', 'is:starred', 'in:trash', 'label:財務', 'label:"white space"']) {
    for (const sort of ['relevance', 'newest', 'oldest']) for (const page of [0, 1, 2]) {
      const parsed = parseSearch({ query, scope: 'all', sort, page }), expected = lexicalSearch(store, parsed, accounts), actual = await worker.lexical(parsed, accounts);
      assert.equal(actual.total, expected.total, query);
      assert.deepEqual(actual.rows, expected.rows.map(row => ({ account: row.account, id: row.message.id })), `${query}/${sort}/${page}`);
    }
  }
  assert.equal(checksum(), before, 'The worker must never write the database');
  assert.deepEqual(await worker.cosine([1, 0], [{ vector: '[0.6,0.8]' }, { vector: '[-1,0]' }]), [0.6, -1]);
  await assert.rejects(worker.call({ kind: 'cosine', query: [1], vectors: [[1, 0]] }));
  await assert.rejects(worker.call({ kind: 'cosine', query: [1], vectors: Array.from({ length: 17 }, () => [1]) }));
  await assert.rejects(worker.call({ kind: 'cosine', query: Array(4097).fill(0), vectors: [] }));
  await assert.rejects(worker.call({ kind: 'sql', sql: 'DELETE FROM messages' }));
  assert.equal(checksum(), before);
});

test('Rust HTTP search falls back without side effects and hybrid scoring rechecks revoked permissions after worker IPC', options, async t => {
  const { store, accounts, workers } = fixture(t), server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const app = createApp({ store, port, appUrl: origin, searchEngine: 'rust' }); server.on('request', app); workers.push(app.locals.smartSearch.worker);
  t.after(async () => { await app.locals.smartSearch.stop(); await new Promise(resolve => server.close(resolve)); });
  const search = async query => {
    const response = await fetch(origin + '/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Genmail-Account': 'all', 'X-Morrow-View': 'paged' }, body: JSON.stringify({ query, scope: 'all' }) });
    assert.equal(response.status, 200); return response.json();
  };
  assert.equal((await search('付款')).engine, 'rust');
  const label = await search('label:"white space"'); assert.equal(label.engine, 'rust'); assert.equal(label.total, 82);
  await app.locals.smartSearch.worker.stop();
  const fallback = await search('付款'); assert.equal(fallback.engine, 'node'); assert.equal(fallback.total, 82);
  assert.ok(fallback.messages.every(m => accounts.includes(m.accountId)));
  const worker = createRustSearch(store.databasePath); workers.push(worker);
  let calls = 0, revoke = false;
  const smart = createSmartSearch({ store, connections: () => store.getSettings().mailAccounts, apiBase: value => value,
    embed: async (_config, texts) => { calls++; return texts.map(() => [1, 0]); },
    cosine: async (query, rows) => {
      assert.ok(rows.every(row => row.account === accounts[0]));
      const result = await worker.cosine(query, rows);
      if (revoke) store.setSettings({ policy: updatePolicy(store.getSettings().policy, { enabled: false }) });
      return result;
    },
  });
  smart.update({ enabled: true, model: 'fixture', accounts: [accounts[0]] });
  await smart.index(smart.preview().job.id);
  const parsed = parseSearch({ query: '延期付款', scope: 'all', smart: true });
  const result = await smart.search(parsed, accounts); assert.ok(result.rows.length && result.rows.every(row => row.account === accounts[0]));
  const count = calls; await smart.search({ ...parsed, page: 1 }, accounts); assert.equal(calls, count);
  revoke = true;
  await assert.rejects(smart.search(parsed, accounts), { status: 409 });
  assert.equal(calls, count, 'Worker retries must never regenerate paid embeddings');
});
