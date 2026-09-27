import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';
import { modelPayload } from '../server/integrations.js';

const owner = 'owner@example.invalid', other = 'other@example.invalid';
const ai = { baseUrl: 'https://model.invalid/v1', model: 'fixture', apiKey: 'fixture-key' };
const input = { action: 'reply', messageId: 'target', includeHistory: true };
const message = (id, patch = {}) => ({ id, fromName: 'Sender', fromEmail: 'sender@example.invalid', to: owner,
  subject: id, body: `Body ${id}`, preview: `Preview ${id}`, folder: 'inbox', date: '2026-01-01T00:00:00Z',
  read: false, starred: false, category: 'primary', labels: [], ...patch });

async function fixture(t, runModel = async () => 'Suggested reply') {
  const directory = mkdtempSync(`${tmpdir()}/morrow-reply-history-`), store = createStore(directory), server = createServer();
  const config = { ai, activeAccount: 'all', mailAccounts: {
    [owner]: { email: owner, connectionId: 'owner-connection' }, [other]: { email: other, connectionId: 'other-connection' },
  }, policy: { maxMessages: 3 }, preferences: { syncInterval: 0 } };
  store.setSettings(config);
  store.upsertMessage(owner, message('target'));
  store.upsertMessage(owner, message('history', { date: '2026-02-01T00:00:00Z' }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const unexpected = () => { throw new Error('Unexpected external request'); };
  const app = createApp({ store, port, appUrl: origin, nativeToken: 'fixture-token', googleOAuth: null, services: {
    runModel, sendSmtpMessage: unexpected, sendProviderMessage: unexpected, fetchProviderMessages: unexpected,
    fetchImapMessages: unexpected, refreshMail: unexpected, oauthFinish: unexpected, verifySmtp: unexpected,
  } });
  server.on('request', app);
  t.after(async () => { app.locals.automation.stop(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const post = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}${path}`, { method: 'POST', headers: Object.fromEntries(Object.entries({
      'Content-Type': 'application/json', Authorization: 'Bearer fixture-token', Origin: origin, 'X-Genmail-Account': owner, ...headers,
    }).filter(([, value]) => value !== undefined)) }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    request.on('error', reject); request.end(JSON.stringify(body));
  });
  return { store, config, post, reply: (patch = {}, headers = {}) => post('/api/ai', { ...input, ...patch }, headers) };
}

test('history reply validates explicit input, authentication, owner, sender and permissions before model work', async t => {
  const calls = [], f = await fixture(t, async (...args) => { calls.push(args); return 'Reply'; });
  for (const includeHistory of [null, 0, 1, 'true', [], {}]) assert.equal((await f.reply({ includeHistory })).status, 400);
  for (const patch of [{ action: 'summary' }, { action: 'write' }, { action: 'unknown' }, { trigger: 'onReply' }, { trigger: null }, { draftText: '' }, { draftText: null }]) assert.equal((await f.reply(patch)).status, 400);
  assert.equal((await f.reply({}, { Authorization: undefined })).status, 401);
  assert.equal((await f.reply({}, { Origin: 'https://untrusted.invalid' })).status, 403);
  for (const account of [undefined, 'all', 'missing@example.invalid']) assert.equal((await f.reply({}, { 'X-Genmail-Account': account })).status, 409);
  assert.equal((await f.reply({}, { 'X-Genmail-Account': other })).status, 404);
  for (const fromEmail of ['', ' ', 'not-an-address', null]) {
    f.store.updateMessage(owner, 'target', { fromEmail });
    assert.equal((await f.reply()).status, 400);
  }
  f.store.upsertMessage(owner, message('target'));
  for (const policy of [{ enabled: false }, { behaviors: { reply: false } }, { folders: { inbox: false } }, { content: { sender: false } }]) {
    f.store.setSettings({ policy });
    assert.equal((await f.reply()).status, 403);
  }
  assert.equal(calls.length, 0);
  const normal = await f.reply({ includeHistory: false });
  assert.equal(normal.status, 200); assert.equal(normal.data.history, undefined);
  assert.equal(calls[0][2].length, 1); assert.equal(calls[0][2][0].fromEmail, '');
  assert.equal(calls[0][4].includeHistory, undefined);
  assert.equal((await f.post('/api/ai', { action: 'reply', messageId: 'target' })).status, 200);
  assert.equal(calls[1][2].length, 1);
});

test('history scans downloaded metadata, keeps target first, bounds newest matches and redacts before model', async t => {
  let seen;
  const f = await fixture(t, async (...args) => { seen = args; return 'Reply using permitted history'; });
  f.store.setSettings({ policy: { maxMessages: 4, folders: { archive: true }, content: { subject: false, body: false } } });
  f.store.updateMessage(owner, 'target', { fromEmail: '  SENDER@example.invalid\t', bodyHtml: '<p>private HTML</p>' });
  for (const row of [
    message('a-newest', { fromEmail: '\nSender@Example.Invalid\u00a0', date: '2026-03-03T00:00:00Z' }),
    message('b-newest', { date: '2026-03-03T00:00:00Z' }),
    message('archive', { date: '2026-03-02T00:00:00Z', folder: 'archive' }),
    message('forbidden', { date: '2026-05-01T00:00:00Z', folder: 'trash' }),
    message('not-sender', { fromEmail: 'other@example.invalid', to: 'sender@example.invalid' }),
    message('prefix', { fromEmail: 'prefixsender@example.invalid' }),
    message('unicode', { fromEmail: 'ſender@example.invalid' }),
  ]) f.store.upsertMessage(owner, row);
  f.store.upsertMessage(other, message('a-newest', { subject: 'OTHER OWNER SECRET' }));
  // Source selection must remain complete even if derived search rows are missing.
  f.store.search.query('DELETE FROM search_documents WHERE account=? AND id=?', [owner, 'archive']);
  t.mock.method(f.store, 'listMessages', () => { throw new Error('Do not load every mailbox body'); });
  const get = t.mock.method(f.store, 'getMessage');
  const result = await f.reply({ prompt: 'Keep it concise' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.history, { matchedMessages: 5, usedMessages: 4, maxMessages: 4, scope: 'downloaded' });
  assert.deepEqual(seen[2].map(m => m.id), ['target', 'a-newest', 'b-newest', 'archive']);
  assert.ok(get.mock.calls.every(({ arguments: [account, id] }) => account === owner && ['target', 'a-newest', 'b-newest', 'archive'].includes(id)));
  assert.ok(seen[2].every(m => m.subject === '' && m.body === '' && m.preview === '' && m.bodyHtml === undefined));
  assert.equal(seen[3], 'Keep it concise'); assert.equal(seen[4].includeHistory, true);
  assert.doesNotMatch(JSON.stringify(seen), /OTHER OWNER SECRET|private HTML/);
});

test('history model payload separates target from other context and caps UTF-16 bodies; demo returns counts', async t => {
  let payload;
  const f = await fixture(t, async (...args) => { payload = modelPayload(...args); return 'Model fixture'; });
  f.store.updateMessage(owner, 'target', { body: '😀'.repeat(12000) });
  f.store.updateMessage(owner, 'history', { body: '😀'.repeat(12000) });
  assert.equal((await f.reply()).status, 200);
  const context = JSON.parse(payload.messages[1].content).emails;
  assert.equal(context[0].body.length, 18000); assert.equal(context[1].body.length, 5000);
  assert.match(payload.messages[0].content, /first email is the selected reply target/);
  assert.match(payload.messages[0].content, /historical context.*not separate requests/);
  assert.match(payload.messages[0].content, /Do not invent commitments/);
  assert.match(payload.messages[0].content, /untrusted data/);
  assert.equal(payload.tools, undefined);
  f.store.setSettings({ ai: null, policy: { maxMessages: 1 } });
  f.store.upsertMessage('demo', message('target')); f.store.upsertMessage('demo', message('history'));
  const demo = await f.reply({}, { 'X-Genmail-Account': 'demo' });
  assert.equal(demo.status, 200); assert.equal(demo.data.source, 'demo');
  assert.deepEqual(demo.data.history, { matchedMessages: 2, usedMessages: 1, maxMessages: 1, scope: 'downloaded' });
  f.store.setSettings({ policy: { maxMessages: 500000 } });
  assert.equal((await f.reply({}, { 'X-Genmail-Account': 'demo' })).data.history.maxMessages, 50);
  f.store.setSettings({ policy: { maxMessages: -1 } });
  assert.equal((await f.reply({}, { 'X-Genmail-Account': 'demo' })).data.history.maxMessages, 8);
});

test('in-flight history rejects changed sources, lost owners and revoked context without returning stale text', async t => {
  let started, complete;
  const f = await fixture(t, async () => { started.resolve(); return complete.promise; });
  const changes = [
    () => f.store.updateMessage(owner, 'history', { body: 'changed' }),
    () => f.store.updateMessage(owner, 'history', { folder: 'drafts' }),
    () => f.store.updateMessage(owner, 'history', { fromEmail: 'replacement@example.invalid' }),
    () => f.store.updateMessage(owner, 'history', { date: '2026-04-01T00:00:00Z' }),
    () => f.store.deleteMessage(owner, 'history'),
    () => f.store.updateMessage(owner, 'target', { body: 'target changed' }),
    () => f.store.setSettings({ mailAccounts: { [other]: f.config.mailAccounts[other] } }),
    () => f.store.setSettings({ mailAccounts: { ...f.config.mailAccounts, [owner]: { email: owner, connectionId: 'replacement' } } }),
    () => f.store.setSettings({ policy: { content: { body: false } } }),
    () => f.store.setSettings({ ai: { ...ai, model: 'replacement' } }),
    () => f.store.setSettings({ preferences: { replyTone: 'concise' } }),
    () => f.store.setSettings({ aiGeneration: 1 }),
  ];
  for (const change of changes) {
    f.store.setSettings({ ...f.config, aiGeneration: 0 });
    f.store.upsertMessage(owner, message('target')); f.store.upsertMessage(owner, message('history'));
    started = Promise.withResolvers(); complete = Promise.withResolvers();
    const pending = f.reply(); await started.promise; change(); complete.resolve('PRIVATE STALE OUTPUT');
    const result = await pending;
    assert.equal(result.status, 409); assert.doesNotMatch(JSON.stringify(result.data), /PRIVATE STALE OUTPUT/);
  }
});

test('revoke then restore through settings routes cannot resurrect an in-flight history reply', async t => {
  let started, complete;
  const f = await fixture(t, async () => { started.resolve(); return complete.promise; });
  for (const [path, revoke, restore] of [
    ['/api/settings/policy', { enabled: false }, { enabled: true }],
    ['/api/settings/ai', { ...ai, model: 'replacement' }, ai],
    ['/api/settings/preferences', { replyTone: 'concise' }, { replyTone: 'friendly' }],
  ]) {
    assert.equal((await f.post(path, restore)).status, 200);
    const before = f.store.getSettings();
    started = Promise.withResolvers(); complete = Promise.withResolvers();
    const pending = f.reply(); await started.promise;
    assert.equal((await f.post(path, revoke)).status, 200); assert.equal((await f.post(path, restore)).status, 200);
    assert.deepEqual(f.store.getSettings()[path.split('/').at(-1)], before[path.split('/').at(-1)]);
    complete.resolve('Revoked response'); assert.equal((await pending).status, 409);
  }
});

test('switching views, unrelated mail and withheld source edits do not change the captured owner/context', async t => {
  const started = Promise.withResolvers(), complete = Promise.withResolvers();
  const f = await fixture(t, async () => { started.resolve(); return complete.promise; });
  f.store.setSettings({ policy: { content: { body: false } } });
  const pending = f.reply(); await started.promise;
  f.store.setSettings({ activeAccount: other });
  f.store.updateMessage(owner, 'history', { body: 'withheld body changed', preview: 'withheld preview changed' });
  f.store.upsertMessage(other, message('history', { body: 'Other owner private text' }));
  complete.resolve('Owner-safe reply');
  const result = await pending;
  assert.equal(result.status, 200); assert.equal(result.data.text, 'Owner-safe reply');
  assert.equal(result.data.history.usedMessages, 2);
  assert.deepEqual(f.store.listMessages(owner).map(m => m.id).sort(), ['history', 'target']);
});

test('history replies discard changed Email Brain and redacted brain sources outside sender history', async t => {
  let started, complete, captured;
  const f = await fixture(t, async (...args) => { captured = args; started.resolve(); return complete.promise; });
  const brain = { voice: 'Use short paragraphs.', notes: 'Approved notes', contacts: [], sourceMessageIds: ['brain-source'] };
  const mutations = [
    () => f.store.updateMessage(owner, 'brain-source', { body: 'Changed source body' }),
    () => f.store.updateMessage(owner, 'brain-source', { folder: 'trash' }),
    () => f.store.deleteMessage(owner, 'brain-source'),
    () => f.store.setSettings({ workspaces: { [owner]: { brain: { ...brain, notes: 'Edited notes' } } } }),
    () => f.store.setSettings({ workspaces: { [owner]: { brain: null } } }),
  ];
  for (const mutate of mutations) {
    f.store.setSettings({ workspaces: { [owner]: { brain } } });
    f.store.upsertMessage(owner, message('brain-source', { fromEmail: 'different-sender@example.invalid' }));
    started = Promise.withResolvers(); complete = Promise.withResolvers();
    const pending = f.reply(); await started.promise;
    assert.deepEqual(captured[4].brain, brain);
    assert.ok(captured[2].every(row => row.id !== 'brain-source'));
    mutate(); complete.resolve('STALE BRAIN REPLY');
    const result = await pending;
    assert.equal(result.status, 409); assert.doesNotMatch(JSON.stringify(result.data), /STALE BRAIN REPLY/);
  }
});

test('correspondent history includes permitted own Sent To/Cc, excluding Bcc, strangers and other owners', async t => {
  let seen;
  const f = await fixture(t, async (...args) => { seen = args; return 'Reviewed reply'; });
  f.store.setSettings({ policy: { folders: { sent: true }, maxMessages: 8 } });
  for (const row of [
    message('own-sent', { folder: 'sent', fromEmail: owner, to: '"Sender, Team" <SENDER@example.invalid>', date: '2026-03-01T00:00:00Z' }),
    message('own-cc', { folder: 'sent', fromEmail: owner, to: other, cc: 'sender@example.invalid' }),
    message('bcc-only', { folder: 'sent', fromEmail: owner, to: other, bcc: 'sender@example.invalid' }),
    message('not-owner', { folder: 'sent', fromEmail: other, to: 'sender@example.invalid' }),
    message('prefix-recipient', { folder: 'sent', fromEmail: owner, to: 'prefixsender@example.invalid' }),
  ]) f.store.upsertMessage(owner, row);
  f.store.upsertMessage(other, message('foreign-sent', { folder: 'sent', fromEmail: other, to: 'sender@example.invalid' }));
  const result = await f.reply(); assert.equal(result.status, 200);
  assert.deepEqual(new Set(seen[2].map(m => m.id)), new Set(['target', 'history', 'own-sent', 'own-cc']));
  f.store.setSettings({ policy: { folders: { sent: false } } });
  await f.reply(); assert.deepEqual(seen[2].map(m => m.id), ['target', 'history']);
});
