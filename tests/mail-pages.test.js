import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createStore } from '../server/store.js';
import { createApp } from '../server/app.js';

function fixture(t) {
  const directory = mkdtempSync(`${tmpdir()}/morrow-pages-`), store = createStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const accounts = ['a@example.invalid', 'b@example.invalid'];
  store.setSettings({ mailAccounts: Object.fromEntries(accounts.map(email => [email, { email, connectionId: email }])), activeAccount: 'all' });
  store.transaction(() => { for (let i = 0; i < 122; i++) store.upsertMessage(accounts[i % 2], {
    id: `same-${Math.floor(i / 2)}`, folder: i % 11 === 0 ? 'trash' : i % 5 === 0 ? 'sent' : 'inbox',
    fromName: `Sender ${i % 13}`, fromEmail: 'sender@example.invalid', to: accounts[i % 2],
    date: new Date(Date.UTC(2026, 0, 1) + Math.floor(i / 4) * 1000).toISOString(), subject: `Invoice ${i % 17}`, preview: 'Preview',
    body: 'Private body. '.repeat(1000), footer: { text: 'Private footer' }, category: i % 3 ? 'primary' : 'updates',
    read: i % 3 === 0, starred: i % 4 === 0, labels: ['label'],
  }); });
  return { store, accounts, directory };
}

test('bounded metadata pages retain all six sorts, exact owners, counts and stable cursors; writes invalidate the snapshot', t => {
  const { store, accounts } = fixture(t);
  const all = accounts.flatMap(account => store.listMessages(account).map(message => ({ ...message, accountId: account })));
  const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
  for (const sort of ['newest', 'oldest', 'sender', 'subject', 'unread', 'starred']) {
    const expected = [...all].sort((a, b) => {
      const first = sort === 'sender' || sort === 'subject' ? collator.compare(a[sort === 'sender' ? 'fromName' : 'subject'], b[sort === 'sender' ? 'fromName' : 'subject']) : sort === 'unread' ? Number(a.read) - Number(b.read) : sort === 'starred' ? Number(b.starred) - Number(a.starred) : 0;
      return first || (sort === 'oldest' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)) || a.accountId.localeCompare(b.accountId) || a.id.localeCompare(b.id);
    });
    const rows = []; let cursor = '';
    do {
      const page = store.messagePage(accounts, { sort, cursor, pageSize: 17 });
      assert.equal(page.total, 122); assert.ok(page.messages.length <= 17);
      rows.push(...page.messages); cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(rows.map(m => m.viewId), expected.map(m => JSON.stringify([m.accountId, m.id])), sort);
    assert.ok(rows.every(m => !Object.hasOwn(m, 'body') && !Object.hasOwn(m, 'footer')));
    assert.equal(new Set(rows.map(m => m.viewId)).size, 122);
    assert.deepEqual(store.messagePage(accounts, { sort, offset: 51, pageSize: 17 }).messages.map(m => m.viewId), rows.slice(51, 68).map(m => m.viewId));
  }
  const stats = store.messageStats(accounts);
  for (const account of accounts) {
    const rows = all.filter(m => m.accountId === account);
    assert.equal(stats[account].unread, rows.filter(m => m.folder === 'inbox' && !m.read).length);
    for (const [folder, count] of Object.entries(stats[account].counts)) assert.equal(count, rows.filter(m => folder === 'starred' ? m.starred && m.folder !== 'trash' : m.folder === folder).length);
  }
  const page = store.messagePage(accounts, { folder: 'inbox', unreadOnly: true, category: 'primary', pageSize: 3 });
  assert.equal(page.total, all.filter(m => m.folder === 'inbox' && !m.read && m.category === 'primary').length);
  assert.throws(() => store.messagePage([accounts[0]], { folder: 'inbox', unreadOnly: true, category: 'primary', pageSize: 3, cursor: page.nextCursor }), { status: 409 });
  const second = store.messagePage(accounts, { offset: 50 });
  store.updateMessage(second.messages[0].accountId, second.messages[0].id, { read: !second.messages[0].read });
  assert.deepEqual(store.messagePage(accounts, { offset: 50 }).messages.map(m => m.viewId), second.messages.map(m => m.viewId));
  const before = store.revision();
  assert.throws(() => store.transaction(() => { store.updateMessage(accounts[0], 'same-1', { body: 'Rolled back' }); throw Error('rollback'); }));
  assert.notEqual(store.revision(), before); // Conservative invalidation also covers rolled-back work.
  assert.match(store.getMessage(accounts[0], 'same-1').body, /Private body/);
  assert.throws(() => store.messagePage(accounts, { folder: 'inbox', unreadOnly: true, category: 'primary', pageSize: 3, cursor: page.nextCursor }), { status: 409 });
  for (const input of [{ offset: -1 }, { offset: 1.5 }, { offset: '50' }, { offset: null }, { offset: 200001 }, { offset: 1, cursor: page.nextCursor }, { pageSize: 101 }, { pageSize: '10' }, { sort: 'SQL' }, { folder: 'all' }, { cursor: 'x'.repeat(9000) }, { sql: 'SELECT *' }]) assert.throws(() => store.messagePage(accounts, input), { status: 400 });
  const plan = store.search.query("EXPLAIN QUERY PLAN SELECT id FROM search_documents WHERE account=? AND folder=? ORDER BY date DESC,id LIMIT 51", [accounts[0], 'inbox']);
  assert.ok(plan.some(row => row.detail.includes('mail_folder_date')));
  assert.ok(plan.every(row => !row.detail.includes('TEMP B-TREE')));
});

test('paged HTTP contract is authenticated, bounded and owner-specific; legacy clients and search keep their contracts', async t => {
  const { store, accounts } = fixture(t), server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const previousEngine = process.env.MORROW_SEARCH_ENGINE;
  let app;
  try {
    process.env.MORROW_SEARCH_ENGINE = 'rust';
    app = createApp({ store, port, appUrl: origin, nativeToken: 'fixture-token' });
  } finally {
    if (previousEngine === undefined) delete process.env.MORROW_SEARCH_ENGINE;
    else process.env.MORROW_SEARCH_ENGINE = previousEngine;
  }
  assert.equal(app.locals.smartSearch.worker, null, 'Desktop hosts must not enable the development worker through inherited environment variables');
  server.on('request', app);
  t.after(async () => { app.locals.smartSearch.stop(); await new Promise(resolve => server.close(resolve)); });
  const request = async (path, body, account = 'all', headers = {}) => {
    const response = await fetch(origin + '/api' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json', 'X-Morrow-View': 'paged', ...(account ? { 'X-Genmail-Account': account } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const listMessages = store.listMessages;
  store.listMessages = () => assert.fail('Paged state must not scan complete mailbox bodies');
  const compact = await request('/state');
  assert.equal(compact.status, 200); assert.equal(compact.data.messages.length, 50); assert.equal(compact.data.mailPage.total, 122);
  assert.ok(JSON.stringify(compact.data).length < 70000); assert.ok(compact.data.messages.every(m => m.body === undefined));
  assert.equal((await request('/state/revision')).data.revision, compact.data.revision);
  store.listMessages = listMessages;
  const legacy = await request('/state', null, 'all', { 'X-Morrow-View': '' });
  assert.equal(legacy.data.messages.length, 122); assert.ok(legacy.data.messages[0].body);
  assert.equal((await request('/mail/page', {}, '')).status, 409);
  assert.equal((await request('/mail/page', {}, 'all', { Authorization: '' })).status, 401);
  assert.equal((await request('/mail/page', {}, 'all', { Origin: 'https://hostile.invalid' })).status, 403);
  assert.equal((await request('/messages/same-1')).status, 409);
  for (const account of accounts) {
    const result = await request('/messages/same-1', null, account);
    assert.equal(result.data.message.accountId, account); assert.equal(result.data.message.to, account); assert.ok(result.data.message.body);
  }
  const result = await request('/search', { query: 'Invoice', scope: 'all' });
  assert.equal(result.data.messages.length, 30); assert.ok(result.data.messages.every(m => !m.body && m.searchSnippet.length));
  store.setSettings({ mailAccounts: { [accounts[0]]: { email: accounts[0] } } });
  assert.equal((await request('/messages/same-1', null, accounts[1])).status, 409);
  assert.equal((await request('/mail/page', {}, accounts[1])).status, 409);
  assert.ok((await request('/mail/page', {})).data.messages.every(m => m.accountId === accounts[0]));
});


test('text pagination follows locale collation for Chinese, accents, punctuation and numbers', t => {
  const { store, accounts } = fixture(t);
  const names = ['張先生', '王小姐', '李', 'Alice 10', 'Alice 02', 'Alice 2', 'Álice', 'alice', 'Åke', 'Östen', 'Zebra', 'a-b', 'a b', 'あいう', '山田'];
  for (let index = 0; index < names.length; index++) store.upsertMessage(accounts[0], { id: `locale-${String(index).padStart(2, '0')}`, folder: 'drafts', fromName: names[index], subject: names[index], date: '2026-09-25T00:00:00.000Z', body: 'kept out of pages' });
  for (const locale of ['en', 'zh-HK', 'sv']) for (const sort of ['sender', 'subject']) {
    const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
    const expected = names.map((name, i) => ({ name, id: `locale-${String(i).padStart(2, '0')}` })).sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const actual = []; let cursor = '';
    do { const page = store.messagePage([accounts[0]], { locale, folder: 'drafts', sort, pageSize: 3, cursor }); actual.push(...page.messages.map(message => message.id)); cursor = page.nextCursor; } while (cursor);
    assert.deepEqual(actual, expected.map(value => value.id), `${locale}/${sort}`);
  }
});

test('pending is an independent owner-scoped marker in metadata, counts and search', async t => {
  const { store, accounts } = fixture(t);
  const app = createApp({ store, nativeToken: 'fixture-token' });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.locals.smartSearch.stop(); await new Promise(resolve => server.close(resolve)); });
  const patch = async (account, pending) => fetch(`http://127.0.0.1:${server.address().port}/api/messages/same-1`, {
    method: 'PATCH', headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json', ...(account ? { 'X-Genmail-Account': account } : {}) }, body: JSON.stringify({ pending }),
  });
  assert.equal((await patch('', true)).status, 409);
  assert.equal((await patch(accounts[0], 'true')).status, 400);
  assert.equal((await patch(accounts[0], true)).status, 200);
  assert.equal(store.getMessage(accounts[1], 'same-1').pending, undefined);
  const page = store.messagePage(accounts, { folder: 'pending' });
  assert.equal(page.total, 1); assert.equal(page.messages[0].accountId, accounts[0]);
  assert.equal(page.messages[0].pending, true); assert.equal(page.messages[0].body, undefined);
  assert.equal(store.messageStats(accounts)[accounts[0]].counts.pending, 1);
  const { parseSearch, lexicalSearch } = await import('../server/search.js');
  assert.equal(lexicalSearch(store, parseSearch({ query: 'is:pending', scope: 'all' }), accounts).total, 1);
  assert.equal(lexicalSearch(store, parseSearch({ folder: 'pending' }), accounts).total, 1);
  store.updateMessage(accounts[0], 'same-1', { folder: 'trash' });
  assert.equal(store.messagePage(accounts, { folder: 'pending' }).total, 0);
  assert.equal(store.messageStats(accounts)[accounts[0]].counts.pending, 0);
  assert.equal((await patch(accounts[0], false)).status, 200);
});
