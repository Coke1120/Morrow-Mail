import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';

const A = 'a@example.invalid', B = 'b@example.invalid';
async function fixture(t) {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external request'); });
  const directory = mkdtempSync(`${tmpdir()}/morrow-scheduled-`);
  let store = createStore(directory), app;
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const f = { now: Date.now(), calls: [], deliver: async () => 'fixture-message-id', get store() { return store; }, get app() { return app; } };
  store.setSettings({ mailAccounts: { [A]: { email: A, provider: 'google', connectionId: 'a' }, [B]: { email: B, provider: 'google', connectionId: 'b' } }, activeAccount: B, preferences: { displayName: 'Reviewed name' } });
  const make = () => {
    app = createApp({ store, port, appUrl: origin, services: { now: () => f.now, refreshMail: async mail => mail, sendProviderMessage: async (mail, message) => { f.calls.push({ mail: structuredClone(mail), message: structuredClone(message) }); return f.deliver(mail, message); } } });
    app.locals.automation.stop(); server.on('request', app);
  };
  make();
  f.restart = async () => { await app.locals.scheduled.stop(); app.locals.automation.stop(); server.removeListener('request', app); store.close(); store = createStore(directory); make(); };
  t.after(async () => { await app.locals.scheduled.stop(); app.locals.automation.stop(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  f.call = (path, body, account = A, method = 'POST') => new Promise((resolve, reject) => {
    const req = httpRequest(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...(account ? { 'X-Genmail-Account': account } : {}) } }, response => {
      const chunks = []; response.on('data', value => chunks.push(value)); response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks)) }));
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  f.input = (requestId = 'schedule-0001', extra = {}) => ({ requestId, sendAt: new Date(f.now + 60_000).toISOString(), to: 'to@example.invalid', cc: 'cc@example.invalid', bcc: 'hidden@example.invalid', subject: 'Reviewed subject', body: 'Reviewed body', footer: { text: 'Reviewed footer' }, ...extra });
  return f;
}

test('scheduled send freezes reviewed payload, locks draft, survives restart and sends once through the ordinary owner path', async t => {
  const f = await fixture(t), input = f.input();
  f.store.upsertMessage(A, { id: 'reply', folder: 'inbox', messageId: '<original@example.invalid>' }); input.replyToId = 'reply';
  const scheduled = await f.call('/api/scheduled', input);
  assert.equal(scheduled.status, 200); assert.equal(scheduled.data.appOpenRequired, true); assert.equal(scheduled.data.lateGraceMinutes, 15);
  const draftId = scheduled.data.job.draftId;
  assert.equal(scheduled.data.message.accountId, A); assert.deepEqual(scheduled.data.message.scheduledSend, { id: input.requestId, sendAt: input.sendAt, status: 'scheduled' });
  assert.equal((await f.call('/api/scheduled', input)).data.job.id, input.requestId);
  assert.equal((await f.call('/api/scheduled', { ...input, body: 'changed' })).status, 409);
  assert.equal((await f.call('/api/drafts', { ...input, id: draftId })).status, 409);
  assert.equal((await f.call(`/api/messages/${encodeURIComponent(draftId)}`, { folder: 'trash' }, A, 'PATCH')).status, 409);
  assert.equal((await f.call('/api/send', { ...input, draftId })).status, 409);
  assert.equal((await f.call('/api/send', input)).status, 409); // Omitting draftId cannot bypass its scheduled request ID.
  assert.equal((await f.call('/api/scheduled', undefined, B, 'GET')).data.scheduled.length, 0);
  assert.equal((await f.call(`/api/scheduled/${input.requestId}/cancel`, {}, B)).status, 404);
  await f.app.locals.scheduled.tick(); assert.equal(f.calls.length, 0);
  await f.restart();
  f.store.setSettings({ preferences: { displayName: 'Changed after review' } });
  f.store.updateMessage(A, 'reply', { messageId: '<changed@example.invalid>' });
  f.now = Date.parse(input.sendAt);
  await f.app.locals.scheduled.tick(); await f.app.locals.scheduled.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].mail.email, A); assert.equal(f.store.getSettings().activeAccount, B);
  const sent = f.calls[0].message;
  assert.equal(sent.to, input.to); assert.equal(sent.cc, input.cc); assert.equal(sent.bcc, input.bcc); assert.equal(sent.body, input.body);
  assert.equal(sent.fromName, 'Reviewed name'); assert.equal(sent.replyMessageId, '<original@example.invalid>'); assert.equal(sent.footer.text, input.footer.text);
  assert.equal(f.store.getMessage(A, draftId), null); assert.equal(f.store.getMessage(A, `sent:${input.requestId}`).fromName, 'Reviewed name');
  assert.equal(f.app.locals.scheduled.list(A).scheduled[0].status, 'sent');
});

test('cancellation, missed time, changed drafts and reconnection never trigger delivery', async t => {
  const f = await fixture(t);
  const cancelled = await f.call('/api/scheduled', f.input('schedule-cancel'));
  assert.equal((await f.call('/api/scheduled/schedule-cancel/cancel', {})).status, 200);
  assert.equal(f.store.getMessage(A, cancelled.data.job.draftId).scheduledSend.status, 'cancelled');
  assert.equal((await f.call('/api/drafts', { ...f.input(), id: cancelled.data.job.draftId })).status, 200);
  const missed = f.input('schedule-missed'); await f.call('/api/scheduled', missed);
  f.now = Date.parse(missed.sendAt) + 15 * 60_000 + 1; await f.app.locals.scheduled.tick();
  assert.equal(f.app.locals.scheduled.list(A).scheduled.find(job => job.id === missed.requestId).status, 'missed');
  const changed = await f.call('/api/scheduled', f.input('schedule-changed'));
  f.store.updateMessage(A, changed.data.job.draftId, { bcc: 'changed@example.invalid' });
  f.now = Date.parse(changed.data.job.sendAt); await f.app.locals.scheduled.tick();
  assert.equal(f.app.locals.scheduled.list(A).scheduled.find(job => job.id === 'schedule-changed').errorCode, 'draft_changed');
  const reconnect = await f.call('/api/scheduled', f.input('schedule-reconnect'));
  f.store.setSettings({ mailAccounts: { ...f.store.getSettings().mailAccounts, [A]: { email: A, provider: 'google', connectionId: 'replacement' } } });
  f.now = Date.parse(reconnect.data.job.sendAt); await f.app.locals.scheduled.tick();
  assert.equal(f.app.locals.scheduled.list(A).scheduled.find(job => job.id === 'schedule-reconnect').errorCode, 'connection_changed');
  assert.equal(f.calls.length, 0);
});

test('claimed restart and provider failure use existing delivery review and never replay automatically', async t => {
  const f = await fixture(t);
  const first = await f.call('/api/scheduled', f.input('schedule-crashed'));
  const jobs = f.store.getSettings().scheduledSends; jobs[0].status = 'sending'; f.store.setSettings({ scheduledSends: jobs });
  await f.restart();
  assert.equal(f.app.locals.scheduled.list(A).scheduled[0].status, 'uncertain'); assert.equal(f.calls.length, 0);
  assert.equal(f.store.getMessage(A, first.data.job.draftId).deliveryStatus, 'unconfirmed');
  assert.equal((await f.call('/api/scheduled/schedule-crashed/cancel', {})).status, 409);
  assert.equal((await f.call('/api/send', { ...f.input('schedule-crashed'), draftId: first.data.job.draftId })).data.requiresSendReview, true);
  const next = await f.call('/api/scheduled', f.input('schedule-lost-response'));
  f.deliver = async () => { throw new Error('Provider may already have accepted'); };
  f.now = Date.parse(next.data.job.sendAt); await f.app.locals.scheduled.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.app.locals.scheduled.list(A).scheduled.find(job => job.id === 'schedule-lost-response').status, 'uncertain');
  await f.restart(); await f.app.locals.scheduled.tick(); assert.equal(f.calls.length, 1);
  assert.equal(f.store.getSettings().deliveryAttempts.length, 2);
});

test('shutdown waits for the in-flight provider call and prevents new work', async t => {
  const f = await fixture(t), input = f.input(); await f.call('/api/scheduled', input);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.deliver = async () => { entered(); return new Promise(resolve => { release = resolve; }); };
  f.now = Date.parse(input.sendAt); const work = f.app.locals.scheduled.tick(); await started;
  let stopped = false; const shutdown = f.app.locals.scheduled.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  await f.app.locals.scheduled.tick(); assert.equal(f.calls.length, 1);
  release('accepted'); await Promise.all([work, shutdown]); assert.equal(stopped, true);
  assert.equal(f.app.locals.scheduled.list(A).scheduled[0].status, 'sent');
});

test('scheduling rejects invalid time, missing owner, original provider drafts and bounds retained work', async t => {
  const f = await fixture(t);
  for (const sendAt of ['2026-02-30T12:00:00.000Z', '2099-01-01T12:00', new Date(f.now).toISOString()]) assert.equal((await f.call('/api/scheduled', f.input('schedule-invalid', { sendAt }))).status, 400);
  for (const owner of [null, 'all', 'demo']) assert.equal((await f.call('/api/scheduled', f.input(), owner)).status, 409);
  f.store.upsertMessage(A, { id: 'remote-draft', folder: 'drafts', providerDraft: true });
  assert.equal((await f.call('/api/scheduled', f.input('schedule-remote', { draftId: 'remote-draft' }))).status, 409);
  assert.equal((await f.call('/api/scheduled', f.input('schedule-other', { draftId: 'remote-draft' }), B)).status, 404);
  const seed = (await f.call('/api/scheduled', f.input())).data.job;
  const stored = f.store.getSettings().scheduledSends[0];
  f.store.setSettings({ scheduledSends: Array.from({ length: 200 }, (_, i) => ({ ...stored, id: `pending-${i}` })) });
  assert.equal((await f.call('/api/scheduled', f.input('schedule-over-limit'))).status, 409);
  f.store.setSettings({ scheduledSends: Array.from({ length: 150 }, (_, i) => ({ ...stored, id: `history-${i}`, status: 'cancelled' })) });
  await f.call('/api/scheduled', f.input('schedule-new-limit'));
  assert.equal(f.store.getSettings().scheduledSends.length, 101); assert.equal(seed.accountId, A);
  assert.equal(f.calls.length, 0);
});
