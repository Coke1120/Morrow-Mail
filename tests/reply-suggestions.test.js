import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';
import { createLearning } from '../server/learning.js';
import { modelPayload } from '../server/integrations.js';
import { updatePolicy } from '../server/policy.js';

const A = 'owner@example.invalid', B = 'other@example.invalid';
const result = JSON.stringify({ needsReply: true, reason: 'The sender asks for a review.', reply: 'Thank you. Could you clarify the proposed date?' });
const message = (id, patch = {}) => ({ id, folder: 'inbox', fromName: 'Sender', fromEmail: 'sender@example.invalid', to: A, cc: 'cc@example.invalid', bcc: 'PRIVATE BCC', date: '2026-01-01T12:00:00Z', subject: `PRIVATE SUBJECT ${id}`, body: `Please review ${id}`, read: false, starred: false, ...patch });
async function fixture(t, model = async () => ({ text: result })) {
  const directory = mkdtempSync(`${tmpdir()}/morrow-reply-suggestions-`);
  let store = createStore(directory), app;
  const calls = [], server = createServer();
  store.setSettings({ activeAccount: 'all', mailAccounts: { [A]: { email: A, connectionId: 'a' }, [B]: { email: B, connectionId: 'b' } }, ai: { baseUrl: 'https://model.invalid/v1', model: 'fixture', apiKey: 'PRIVATE API KEY', maxTokens: 800 }, policy: updatePolicy({}, { maxMessages: 50, folders: { sent: true }, content: { subject: false, contacts: false } }), preferences: { syncInterval: 0 }, workspaces: { [A]: { brain: { voice: 'Keep manual voice', notes: 'Keep private notes' } } } });
  store.upsertMessage(A, message('target')); store.upsertMessage(A, message('second', { date: '2026-02-01T12:00:00Z' }));
  store.upsertMessage(B, message('target', { body: 'OTHER OWNER PRIVATE' }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const unexpected = () => { throw new Error('Unexpected provider/send/model call'); };
  const make = () => {
    app = createApp({ store, port, appUrl: origin, nativeToken: 'reply-fixture', googleOAuth: null, services: { runModel: async (...args) => { calls.push(args); return model(...args); }, sendSmtpMessage: unexpected, sendProviderMessage: unexpected, fetchProviderMessages: unexpected, fetchImapMessages: unexpected, refreshMail: unexpected, oauthFinish: unexpected, verifySmtp: unexpected } });
    app.locals.automation.stop(); server.on('request', app);
  };
  make();
  const learning = () => createLearning({ store, connection: owner => store.getSettings().mailAccounts[owner], runModel: unexpected });
  const confirmIdentity = owner => learning().updateSettings(owner, { identity: { displayName: owner === A ? 'Confirmed Alice' : 'Confirmed Bob', aliases: ['Reviewed alias'], confirmed: true } });
  confirmIdentity(A); confirmIdentity(B);
  t.after(async () => { await app.locals.replySuggestions.stop(); app.locals.automation.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const f = { calls, get store() { return store; }, get queue() { return app.locals.replySuggestions; }, learning, confirmIdentity };
  f.request = (path = '', body, account = A, extraHeaders = {}) => new Promise((resolve, reject) => {
    const headers = Object.fromEntries(Object.entries({ 'Content-Type': 'application/json', Authorization: 'Bearer reply-fixture', Origin: origin, 'X-Genmail-Account': account, ...extraHeaders }).filter(([, value]) => value !== undefined));
    const req = httpRequest(origin + (path.startsWith('/api/') ? path : `/api/reply-suggestions${path}`), { method: body === undefined ? 'GET' : 'POST', headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject); response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks)) }));
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  f.enable = (owner = A, extra = {}) => f.queue.updateSettings(owner, { enabled: true, maxMessages: 5, tokenBudget: 64000, ...extra });
  f.prepare = (ids = ['target']) => f.queue.preview(A, { messageIds: ids });
  f.run = (ids = ['target']) => { const state = f.prepare(ids); f.queue.run(A, state.job.id); return state.job; };
  f.restart = async () => { await app.locals.replySuggestions.stop(); app.locals.automation.stop(); server.removeListener('request', app); store.close(); store = createStore(directory); make(); };
  f.approveStyle = () => {
    store.upsertMessage(A, message('style-source', { folder: 'sent', fromEmail: A, date: new Date(Date.now() - 3600000).toISOString(), body: 'Hello, please review the proposed schedule and send your thoughts when convenient. Thank you for your help.' }));
    const l = learning(); l.updateSettings(A, { enabled: true }); const preview = l.prepare(A), saved = store.getSettings().styleLearning;
    saved[A].preview.status = 'ready'; store.setSettings({ styleLearning: saved }); l.apply(A, { previewId: preview.id, voice: 'Approved concise paragraphs.' });
  };
  return f;
}

test('reply suggestions require authentication, owner, consent, identity and review before bounded serial work', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.request('', undefined, A, { Authorization: undefined })).status, 401);
  assert.equal((await f.request('/settings', { enabled: true }, A, { Origin: 'https://hostile.invalid' })).status, 403);
  for (const owner of [undefined, 'all', 'demo', 'unknown@example.invalid']) assert.equal((await f.request('', undefined, owner === undefined ? null : owner, { 'X-Genmail-Account': owner })).status, 409);
  assert.throws(() => f.prepare(), { status: 403 }); f.enable();
  const l = f.learning(); l.updateSettings(A, { identity: { displayName: 'Alice', aliases: [], confirmed: false } });
  assert.throws(() => f.prepare(), { status: 409 }); f.confirmIdentity(A);
  for (let i = 0; i < 13; i++) f.store.upsertMessage(A, message(`history-${i}`, { fromEmail: ' SENDER@example.invalid ', date: `2026-03-${String(i + 1).padStart(2, '0')}T00:00:00Z` }));
  f.store.upsertMessage(A, message('trash-secret', { folder: 'trash', body: 'TRASH PRIVATE' }));
  const preview = f.prepare(['target', 'second']); assert.equal(f.calls.length, 0); assert.equal(preview.job.samples[0].history.matchedMessages, 15); assert.equal(preview.job.samples[0].history.usedMessages, 10);
  assert.doesNotMatch(JSON.stringify(preview), /OTHER OWNER PRIVATE|TRASH PRIVATE|PRIVATE SUBJECT|PRIVATE BCC|PRIVATE API KEY|sourceHash|"sources"/);
  const started = await f.request('/run', { previewId: preview.job.id }); assert.equal(started.status, 202); assert.equal(f.calls.length, 0);
  assert.equal((await f.request('/run', { previewId: preview.job.id })).status, 409);
  await f.queue.tick(); assert.equal(f.calls.length, 1); assert.equal(f.queue.state(A).job.status, 'queued');
  await f.queue.tick(); await f.queue.tick(); assert.equal(f.calls.length, 2); assert.equal(f.queue.state(A).job.status, 'complete');
  assert.equal(f.calls[0][2][0].id, 'target'); assert.equal(f.calls[0][2].length, 10);
  assert.match(f.calls[0][3], /Confirmed Alice/); assert.doesNotMatch(JSON.stringify(f.calls[0]), /Confirmed Bob|OTHER OWNER PRIVATE|TRASH PRIVATE|PRIVATE SUBJECT|PRIVATE BCC/);
  const proposal = f.queue.state(A).proposals[0];
  assert.equal((await f.request('/use', { id: proposal.id }, B)).status, 404);
  const used = (await f.request('/use', { id: proposal.id })).data;
  const prepared = await f.request('/api/drafts/prepare', { messageId: used.message.id, mode: 'reply', body: used.text });
  assert.equal(prepared.status, 200);
  const draft = prepared.data.draft;
  assert.equal(draft.accountId, A); assert.equal(draft.replyToId, 'target'); assert.equal(draft.bcc, ''); assert.equal(f.store.getSettings().activeAccount, 'all');
  assert.equal(f.store.listMessages(A).some(m => m.folder === 'drafts'), false);
  assert.equal((await f.request('/dismiss', { id: proposal.id })).status, 200); assert.equal(f.queue.state(A).proposals.length, 1);
});

test('approved learned style requires Brain/Sent/body permission and matching Sent source; identity alone is not style', { timeout: 30000 }, async t => {
  const f = await fixture(t); f.enable(); const brain = f.store.getSettings().workspaces; f.approveStyle();
  f.run(); await f.queue.tick();
  assert.equal(f.calls[0][4].styleVoice, 'Approved concise paragraphs.');
  assert.equal(JSON.parse(modelPayload(...f.calls[0]).messages[1].content).approvedWritingStyle, 'Approved concise paragraphs.');
  assert.equal(f.queue.state(A).proposals.length, 1);
  f.store.updateMessage(A, 'style-source', { body: 'Changed sent source' });
  assert.equal(f.queue.state(A).proposals.length, 0); f.run(); await f.queue.tick(); assert.equal(f.calls[1][4].styleVoice, '');
  for (const patch of [{ behaviors: { memory: false } }, { folders: { sent: false } }]) {
    f.approveStyle(); f.store.setSettings({ policy: updatePolicy(f.store.getSettings().policy, patch) });
    f.run(); await f.queue.tick(); assert.equal(f.calls.at(-1)[4].styleVoice, '');
    f.store.setSettings({ policy: updatePolicy(f.store.getSettings().policy, { behaviors: { memory: true }, folders: { sent: true } }) });
  }
  f.store.setSettings({ policy: updatePolicy(f.store.getSettings().policy, { content: { body: false } }) });
  assert.throws(() => f.prepare(), { status: 403 }); assert.equal(f.queue.state(A).proposals.length, 0);
  assert.deepEqual(f.store.getSettings().workspaces, brain);
});

test('revoked generations, identity/model/connection/source changes discard in-flight results without retries', { timeout: 30000 }, async t => {
  const mutations = [
    f => f.store.updateMessage(A, 'second', { body: 'Changed history' }),
    f => f.learning().updateSettings(A, { identity: { displayName: 'Changed identity', aliases: [], confirmed: true } }),
    f => { const config = f.store.getSettings(); f.store.setSettings({ aiGeneration: (config.aiGeneration || 0) + 2 }); },
    f => f.store.setSettings({ ai: { ...f.store.getSettings().ai, model: 'changed' } }),
    f => f.store.setSettings({ mailAccounts: { ...f.store.getSettings().mailAccounts, [A]: { email: A, connectionId: 'new' } } }),
    f => f.store.updateMessage(A, 'style-source', { body: 'Changed independent style source' }),
  ];
  for (const mutate of mutations) await t.test(mutate.toString().slice(0, 85), async t => {
    const entered = Promise.withResolvers(), released = Promise.withResolvers();
    const f = await fixture(t, async () => { entered.resolve(); return released.promise; }); t.after(() => released.resolve({ text: result }));
    f.enable(); f.approveStyle(); f.run(); const pending = f.queue.tick(); await entered.promise;
    mutate(f); released.resolve({ text: result }); await pending; await f.queue.tick();
    assert.equal(f.calls.length, 1); assert.equal(f.queue.state(A).proposals.length, 0); assert.equal(f.store.getSettings().replySuggestions[A].job.status, 'failed');
  });
});

test('cancel and process restart never replay a charged request; completed proposals persist and source changes revoke previews', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers(), released = Promise.withResolvers(); let hold = true;
  const f = await fixture(t, async () => { if (hold) { entered.resolve(); return released.promise; } return { text: result }; });
  t.after(() => released.resolve({ text: result })); f.enable(); f.run(['target', 'second']);
  const pending = f.queue.tick(); await entered.promise;
  assert.equal(f.queue.tick(), pending); // Coalesces duplicate ticks, no second model call.
  assert.equal((await f.request('/cancel', {})).status, 200); released.resolve({ text: result }); await pending;
  assert.equal(f.queue.state(A).job.status, 'cancelled'); assert.equal(f.queue.state(A).proposals.length, 0); assert.equal(f.calls.length, 1);
  hold = false; f.run(); await f.queue.tick(); const proposal = f.queue.state(A).proposals[0];
  await f.restart(); assert.equal(f.queue.state(A).proposals[0].id, proposal.id); await f.queue.tick(); assert.equal(f.calls.length, 2);
  f.run(['second']); await f.restart(); assert.equal(f.queue.state(A).job.status, 'interrupted'); await f.queue.tick(); assert.equal(f.calls.length, 2);
  const prepared = f.prepare(); f.store.updateMessage(A, 'second', { folder: 'trash' });
  assert.equal(f.queue.state(A).job.reviewValid, false); assert.deepEqual(f.queue.state(A).job.samples, []);
  assert.throws(() => f.queue.run(A, prepared.job.id), { status: 409 });
  assert.throws(() => f.queue.use(A, proposal.id), { status: 409 });
});

test('budgets and malformed output fail closed, expose safe errors, and do not repeat model work', { timeout: 30000 }, async t => {
  let output = 'PRIVATE MODEL ERROR'; const f = await fixture(t, async () => ({ text: output })); f.enable();
  for (const options of [{ enabled: 1 }, { maxMessages: 11 }, { tokenBudget: 3999 }, { extra: true }]) assert.throws(() => f.queue.updateSettings(A, options), { status: 400 });
  f.store.updateMessage(A, 'target', { body: '漢'.repeat(5000) }); f.enable(A, { tokenBudget: 4000 });
  assert.throws(() => f.prepare(), { status: 409 }); assert.equal(f.calls.length, 0);
  f.enable(); f.run(); await f.queue.tick(); await f.queue.tick(); assert.equal(f.calls.length, 1);
  assert.equal(f.queue.state(A).job.status, 'failed'); assert.ok(f.queue.state(A).job.spentTokens > 0); assert.doesNotMatch(JSON.stringify(f.queue.state(A)), /PRIVATE MODEL ERROR/);
  output = JSON.stringify({ needsReply: false, reason: 'Informational notice.', reply: 'This unused text must be discarded.' });
  f.run(); await f.queue.tick(); assert.equal(f.queue.state(A).job.status, 'complete'); assert.equal(f.queue.state(A).proposals.length, 0);
  assert.equal(f.store.getSettings().replySuggestions[A].proposals.at(-1).text, '');
});

test('two-way permitted history includes owned Sent to correspondent without leaking Bcc-only or foreign mail', { timeout: 30000 }, async t => {
  const f = await fixture(t); f.enable();
  f.store.upsertMessage(A, message('mine', { folder: 'sent', fromEmail: A, to: 'Sender <sender@example.invalid>', body: 'MY PRIOR ANSWER' }));
  f.store.upsertMessage(A, message('bcc-only', { folder: 'sent', fromEmail: A, to: 'unrelated@example.invalid', bcc: 'sender@example.invalid', body: 'BCC ONLY PRIVATE' }));
  f.run(); await f.queue.tick();
  assert.ok(f.calls[0][2].some(m => m.id === 'mine')); assert.doesNotMatch(JSON.stringify(f.calls[0][2]), /BCC ONLY PRIVATE|OTHER OWNER PRIVATE/);
  assert.match(f.calls[0][3], /same correspondent/);
});

test('standalone React view renders account guard without starting requests or model work', { timeout: 30000 }, async t => {
  const { createServer: createVite } = await import('vite');
  const { default: React } = await import('react'); const { renderToString } = await import('react-dom/server');
  const vite = await createVite({ server: { middlewareMode: true, hmr: false }, appType: 'custom' }); t.after(() => vite.close());
  const { default: View } = await vite.ssrLoadModule('/src/ReplySuggestions.jsx');
  const html = renderToString(React.createElement(View, { state: { account: { id: 'all', mode: 'combined' } } }));
  assert.match(html, /Choose an individual connected mailbox/); assert.doesNotMatch(html, /Generate Reviewed Batch/);
});
