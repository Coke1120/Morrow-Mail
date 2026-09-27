import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDraft, replyDraft, forwardDraft, copyProviderDraft } from '../server/message-draft.js';
import { recipients } from '../server/recipients.js';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';

const message = {
  id: 'provider-id', viewId: 'owned-provider-id', accountId: 'Owner@example.com', folder: 'inbox',
  fromName: 'Sender', fromEmail: 'sender@example.com',
  to: '"Doe, Jane" <JANE@example.com>, OWNER@example.com; teammate@example.com, SENDER@example.com',
  cc: '"Smith, \\"JJ\\"" <jane@example.com>, copy@example.com, sender@example.com, owner@example.com',
  bcc: 'hidden@example.com', subject: 'Question', body: 'First line\r\nSecond line', date: '2026-09-26T12:30:00Z',
  footer: { text: 'Old footer' }, replyToId: 'old-thread', deliveryRequestId: 'old-request',
};

test('reply all normalizes quoted names, deduplicates To/Cc and excludes only the owner without copying Bcc', () => {
  const draft = replyDraft(message, { all: true, body: 'My answer' });
  assert.deepEqual(draft, { accountId: message.accountId, to: 'sender@example.com, JANE@example.com, teammate@example.com', cc: 'copy@example.com', bcc: '', subject: 'Re: Question', body: 'My answer', replyToId: message.id });
  assert.deepEqual(recipients(draft), { to: draft.to, cc: draft.cc, bcc: '' });
  assert.doesNotMatch(JSON.stringify(draft), /hidden@example|old-request|Old footer|owned-provider-id/);
  assert.equal(replyDraft({ ...message, subject: 'rE: Already replied' }).subject, 'rE: Already replied');
  assert.equal(replyDraft({ ...message, accountId: 'demo', to: 'alex@genmail.example' }, { all: true }).to, 'sender@example.com');
});

test('ordinary replies retain their API and sent reply-all addresses the original recipients, not the sending alias', () => {
  const ordinary = replyDraft(message);
  assert.equal(ordinary.to, message.fromEmail); assert.equal(ordinary.cc, ''); assert.equal(ordinary.bcc, '');
  const sent = { ...message, folder: 'sent', fromEmail: 'sending-alias@example.com' };
  assert.equal(replyDraft(sent).to, 'JANE@example.com, OWNER@example.com, teammate@example.com, SENDER@example.com');
  const all = replyDraft(sent, { all: true });
  assert.equal(all.to, 'JANE@example.com, teammate@example.com, SENDER@example.com');
  assert.equal(all.cc, 'copy@example.com'); assert.equal(all.replyToId, sent.id);
  assert.doesNotMatch(all.to + all.cc, /sending-alias|owner@example/i);
});

test('malformed or unsupported recipient lists remain visible for correction instead of being partially parsed', () => {
  for (const value of ['valid@example.com, broken-recipient', '"Unclosed name <a@example.com>', 'Missing <>', 'Two <a@example.com, b@example.com>', 'a@example.com,', 'a@example.com\r\nBcc: injected@example.com', 'Group: a@example.com;', 'Doe, Jane <jane@example.com>']) {
    const draft = replyDraft({ ...message, to: value, cc: '' }, { all: true });
    assert.equal(draft.to, `sender@example.com, ${value}`, value);
    assert.throws(() => recipients(draft), value);
    assert.equal(replyDraft({ ...message, to: '', cc: value }, { all: true }).cc, value);
  }
});

test('forwarding locks the original owner, starts blank recipients and quotes plaintext without Bcc or reply threading', () => {
  const draft = forwardDraft(message);
  assert.equal(draft.accountId, message.accountId); assert.equal(draft.forwarding, true);
  assert.equal(draft.to, ''); assert.equal(draft.cc, ''); assert.equal(draft.bcc, '');
  assert.equal(draft.subject, 'Fwd: Question');
  assert.match(draft.body, /> From: Sender <sender@example.com>/);
  assert.match(draft.body, /> Date: 2026-09-26T12:30:00Z/);
  assert.match(draft.body, /> To: /); assert.match(draft.body, /> Cc: /);
  assert.match(draft.body, /> First line\n> Second line$/);
  for (const key of ['id', 'viewId', 'replyToId', 'footer', 'deliveryRequestId']) assert.equal(Object.hasOwn(draft, key), false);
  assert.doesNotMatch(JSON.stringify(draft), /hidden@example|Bcc:|old-thread|Old footer/);
  for (const subject of ['Fwd: Already forwarded', 'FW: Already forwarded']) assert.equal(forwardDraft({ ...message, subject }).subject, subject);
  assert.equal(forwardDraft({ ...message, accountId: undefined }).accountId, undefined);
});


test('Gmail drafts become unthreaded local copies with normalized To/Cc/Bcc and a fixed owner', () => {
  const copy = copyProviderDraft({ ...message, providerDraft: true, folder: 'drafts' });
  assert.equal(copy.accountId, message.accountId); assert.equal(copy.sourceDraft, true);
  assert.equal(copy.to, 'JANE@example.com, OWNER@example.com, teammate@example.com, SENDER@example.com');
  assert.equal(copy.bcc, 'hidden@example.com'); assert.equal(copy.body, message.body);
  for (const key of ['id', 'remoteId', 'providerDraft', 'replyToId', 'deliveryRequestId', 'footer']) assert.equal(Object.hasOwn(copy, key), false);
});

test('the compatibility builder retains the captured pre-migration draft corpus', () => {
  for (const row of JSON.parse(readFileSync(new URL('./fixtures/draft-prepare.json', import.meta.url)))) {
    assert.deepEqual(prepareDraft(row.owner, row.input, () => row.message), row.expected, row.name);
  }
});

test('draft prepare route requires an explicit owner, reads the owned source and never saves or sends', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'morrow-draft-prepare-'));
  const store = createStore(directory), owner = 'Owner@example.com', other = 'other@example.com';
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const app = createApp({ store, port, appUrl: origin, googleOAuth: null, nativeToken: 'fixture-bearer' });
  app.locals.automation.stop(); server.on('request', app);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.setSettings({ mailAccounts: { [owner]: { email: owner }, [other]: { email: other } }, activeAccount: other, preferences: { syncInterval: 0 } });
  store.upsertMessage(owner, { ...message, id: 'same', accountId: other });
  store.upsertMessage(other, { ...message, id: 'same', body: 'Other private body' });
  store.upsertMessage(owner, { ...message, id: 'provider', providerDraft: true, folder: 'drafts' });
  const beforeSettings = store.getSettings(), beforeMessages = store.listMessages(owner);
  const call = async (body, account = owner, headers = {}) => {
    const response = await fetch(origin + '/api/drafts/prepare', { method: 'POST', headers: { Authorization: 'Bearer fixture-bearer', 'Content-Type': 'application/json', 'X-Genmail-Account': account, ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const input = { messageId: 'same', mode: 'forward' };
  assert.equal((await call(input, owner, { Authorization: '' })).status, 401);
  assert.equal((await call(input, owner, { Origin: 'https://evil.invalid' })).status, 403);
  for (const account of ['', 'all', 'disconnected@example.com']) assert.equal((await call(input, account)).status, 409);
  const result = await call(input); assert.equal(result.status, 200);
  assert.equal(result.body.draft.accountId, owner);
  assert.match(result.body.draft.body, /First line/); assert.doesNotMatch(JSON.stringify(result.body), /Other private body/);
  for (const body of [{ ...input, body: 'injected' }, { ...input, accountId: other }, { ...input, mode: 'reply', body: null }, { ...input, mode: 'reply', body: 'a'.repeat(100001) }, { ...input, mode: 'unknown' }, { mode: 'reply' }]) assert.equal((await call(body)).status, 400);
  assert.equal((await call({ messageId: 'missing', mode: 'reply' })).status, 404);
  assert.equal((await call({ messageId: 'same', mode: 'copy' })).status, 409);
  assert.equal((await call({ messageId: 'provider', mode: 'reply' })).status, 409);
  const copy = await call({ messageId: 'provider', mode: 'copy' });
  assert.equal(copy.status, 200); assert.equal(copy.body.draft.sourceDraft, true); assert.equal(copy.body.draft.bcc, message.bcc);
  assert.deepEqual(store.getSettings(), beforeSettings); assert.deepEqual(store.listMessages(owner), beforeMessages);
  // Disconnect through the real route to remove only this owner.
  const disconnected = await fetch(origin + '/api/account/disconnect', { method: 'POST', headers: { Authorization: 'Bearer fixture-bearer', 'Content-Type': 'application/json', 'X-Genmail-Account': owner }, body: '{}' });
  assert.equal(disconnected.status, 200);
  assert.equal((await call(input)).status, 409);
});
