import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';
import { googleFolder } from '../server/providers.js';
import { updatePolicy } from '../server/policy.js';

const A = 'a@example.invalid', B = 'b@example.invalid';
const connection = email => ({ email, provider: 'google', connectionId: email });
const remote = (id, labelIds, extra = {}) => ({ id: `google:${id}`, providerLabelIds: labelIds, providerSent: labelIds.includes('SENT'), providerDraft: labelIds.includes('DRAFT'), folder: googleFolder(labelIds), read: !labelIds.includes('UNREAD'), starred: labelIds.includes('STARRED'), labels: [], fromEmail: A, to: 'to@example.invalid', cc: '', bcc: '', subject: 'Subject', body: 'Remote body', date: '2026-09-28T00:00:00.000Z', ...extra });

async function fixture(t, services = {}) {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external request'); });
  const directory = mkdtempSync(`${tmpdir()}/morrow-gmail-sync-`), store = createStore(directory);
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const unexpected = async () => { throw new Error('Unexpected integration call'); };
  const app = createApp({ store, port, appUrl: origin, googleOAuth: null, services: { refreshMail: async mail => mail, verifySmtp: unexpected, sendSmtpMessage: unexpected, sendProviderMessage: unexpected, fetchProviderMessages: unexpected, fetchImapMessages: unexpected, oauthFinish: unexpected, runModel: unexpected, ...services } });
  app.locals.automation.stop(); server.on('request', app);
  store.setSettings({ mailAccounts: { [A]: connection(A), [B]: connection(B) }, activeAccount: B });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (path, body = {}, account = A, method = 'POST') => new Promise((resolve, reject) => {
    const req = httpRequest(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Genmail-Account': account } }, response => {
      const chunks = []; response.on('data', data => chunks.push(data)); response.on('end', () => { const raw = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode, headers: response.headers, data: response.headers['content-type']?.includes('application/json') ? JSON.parse(raw) : raw }); });
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  return { store, call };
}

test('Gmail refresh fetches five bounded scopes, deduplicates IDs and preserves explicit local fields across remote changes', async t => {
  let rows = [remote('same', ['INBOX', 'UNREAD'], { labels: ['Old label'] }), remote('sent', ['SENT']), remote('draft', ['DRAFT'])];
  const calls = [];
  const { store, call } = await fixture(t, { fetchProviderPage: async (mail, options) => { calls.push({ owner: mail.email, ...options }); return { messages: structuredClone(rows), nextCursor: 'more-history' }; }, listProviderFolders: async () => [{ id: 'INBOX', kind: 'inbox' }], organizeProviderMessage: async () => ({ folder: 'inbox', providerLabelIds: ['INBOX', 'UNREAD', 'STARRED'] }) });
  const untouched = remote('same', ['INBOX'], { body: 'Other account private text' }); store.upsertMessage(B, untouched);
  store.setSettings({ imports: { [A]: { options: { inbox: true, sent: true, allMail: true, months: 3 }, since: '2026-06-27T00:00:00.000Z', before: '2026-09-27T00:00:00.000Z', folderIndex: 0, status: 'complete', imported: 0 } }, policy: updatePolicy({}, { triggers: { onArrival: true, inboxOnly: false }, folders: { sent: true } }) });
  assert.equal((await call('/api/sync')).status, 200);
  assert.deepEqual(calls.map(call => call.folder), ['inbox', 'sent', 'drafts', 'starred', 'all']);
  assert.ok(calls.every(call => call.owner === A && call.since === '2026-06-27T00:00:00.000Z' && !call.cursor));
  assert.equal(store.listMessages(A).length, 3);
  assert.deepEqual(store.getSettings().automation[A].jobs.map(job => job.messageIds), [['google:same']]);
  assert.deepEqual(store.getMessage(A, 'google:same').providerSnapshot, { folder: 'inbox', read: false, starred: false, labels: ['Old label'] });
  rows[0] = remote('same', ['SENT', 'STARRED'], { labels: ['Renamed label'] });
  assert.equal((await call('/api/sync')).status, 200);
  let saved = store.getMessage(A, 'google:same');
  assert.equal(saved.folder, 'sent'); assert.equal(saved.read, true); assert.equal(saved.starred, true); assert.deepEqual(saved.labels, ['Renamed label']);
  const patched = await call('/api/messages/google:same', { folder: 'archive', read: true, starred: false, localOverrides: { labels: true } }, A, 'PATCH');
  assert.equal(patched.status, 200); assert.deepEqual(patched.data.message.localOverrides, { folder: true, read: true, starred: true });
  rows[0] = remote('same', ['INBOX', 'UNREAD', 'STARRED'], { labels: ['Newest label'] });
  assert.equal((await call('/api/sync')).status, 200);
  saved = store.getMessage(A, 'google:same');
  assert.equal(saved.folder, 'archive'); assert.equal(saved.read, true); assert.equal(saved.starred, false); assert.deepEqual(saved.labels, ['Newest label']);
  assert.deepEqual(saved.providerSnapshot, { folder: 'inbox', read: false, starred: true, labels: ['Newest label'] });
  assert.deepEqual(store.getMessage(B, 'google:same'), untouched);
  assert.equal(store.getSettings().activeAccount, B);
  assert.equal((await call('/api/messages/google:same/organize', { mode: 'move', destinationId: 'INBOX', confirmed: true })).status, 200);
  assert.equal(store.getMessage(A, 'google:same').localOverrides.folder, false);
  rows[0] = remote('same', ['SENT'], { labels: ['Newest label'] });
  assert.equal((await call('/api/sync')).status, 200);
  saved = store.getMessage(A, 'google:same'); assert.equal(saved.folder, 'sent'); assert.equal(saved.starred, false);
});

test('Gmail label organization keeps remote folder snapshots and explicit local folder overrides separate', async t => {
  let row = remote('same', ['SENT', 'Label_1'], { labels: ['Old label'] });
  const { store, call } = await fixture(t, {
    fetchProviderPage: async () => ({ messages: [structuredClone(row)] }),
    listProviderFolders: async () => [{ id: 'Label_1', kind: 'label' }, { id: 'Label_2', kind: 'label' }],
    organizeProviderMessage: async (_mail, _message, destination, mode) => {
      const ids = row.providerLabelIds.filter(id => mode !== 'removeLabel' || id !== destination.id);
      if (mode === 'addLabel' && !ids.includes(destination.id)) ids.push(destination.id);
      row = remote('same', ids, { labels: ['New label'] });
      const { folder, providerLabelIds, providerSent, providerDraft } = row;
      return { folder, providerLabelIds, providerSent, providerDraft };
    },
  });
  // Legacy rows without snapshots must receive one after organizing, too.
  store.upsertMessage(A, row);
  const organize = (mode, destinationId) => call('/api/messages/google:same/organize', { mode, destinationId, confirmed: true });
  let result = await organize('addLabel', 'Label_2');
  assert.equal(result.status, 200);
  assert.equal(result.data.message.folder, 'sent'); assert.equal(result.data.message.providerSent, true); assert.equal(result.data.message.providerDraft, false);
  assert.equal(result.data.message.providerSnapshot.folder, 'sent');
  assert.equal((await call('/api/sync')).status, 200);
  row = remote('same', ['DRAFT', 'SENT', 'Label_1', 'Label_2'], { labels: ['New label'] });
  result = await organize('removeLabel', 'Label_1');
  assert.equal(result.status, 200); assert.equal(result.data.message.folder, 'drafts'); assert.equal(result.data.message.providerDraft, true);
  assert.equal(result.data.message.providerSnapshot.folder, 'drafts');
  const labelsBefore = result.data.message.providerSnapshot.labels;
  assert.equal((await call('/api/messages/google:same', { folder: 'trash' }, A, 'PATCH')).status, 200);
  result = await organize('addLabel', 'Label_1');
  assert.equal(result.status, 200); assert.equal(result.data.message.folder, 'trash');
  assert.equal(result.data.message.providerSnapshot.folder, 'drafts'); assert.equal(result.data.message.localOverrides.folder, true);
  assert.deepEqual(result.data.message.providerSnapshot.labels, labelsBefore);
  assert.equal((await call('/api/sync')).status, 200);
  assert.equal(store.getMessage(A, 'google:same').folder, 'trash');
  assert.equal(store.getMessage(A, 'google:same').providerSnapshot.folder, 'drafts');
});

test('legacy Gmail rows heal forced folders while keeping inferred edits, sent fingerprints and remote identity', async t => {
  const rows = [remote('legacy-sent', ['SENT']), remote('legacy-inbox', ['INBOX']), remote('legacy-draft', ['DRAFT']), remote('archive', ['INBOX']), remote('trash', ['INBOX']), remote('edited', ['SENT', 'UNREAD', 'STARRED'], { labels: ['Provider label'] }), remote('raw-sent', ['SENT', 'INBOX'], { messageId: '<local@example.invalid>', to: 'changed@example.invalid', body: 'Provider-transformed body' })];
  const { store, call } = await fixture(t, { fetchProviderPage: async () => ({ messages: rows }) });
  for (const [id, raw, patch] of [
    ['legacy-sent', ['SENT'], { folder: 'inbox' }], ['legacy-inbox', ['INBOX'], { folder: 'sent' }], ['legacy-draft', ['DRAFT'], { folder: 'inbox' }],
    ['archive', ['INBOX'], { folder: 'archive' }], ['trash', ['INBOX'], { folder: 'trash' }],
    ['edited', ['INBOX', 'UNREAD', 'STARRED'], { read: true, starred: false, labels: ['Local label'], providerFolderId: 'kept-provider-folder', providerFolderName: 'Kept display name' }],
  ]) store.upsertMessage(A, remote(id, raw, patch));
  const sent = { ...remote('unused', ['SENT']), id: 'sent:fixture-request', messageId: '<local@example.invalid>', to: 'original@example.invalid', bcc: 'hidden@example.invalid', body: 'Reviewed original body', footer: { text: 'Reviewed footer' } };
  store.upsertMessage(A, sent);
  assert.equal((await call('/api/sync')).status, 200);
  for (const [id, folder] of [['legacy-sent', 'sent'], ['legacy-inbox', 'inbox'], ['legacy-draft', 'drafts'], ['archive', 'archive'], ['trash', 'trash']]) assert.equal(store.getMessage(A, `google:${id}`).folder, folder);
  const edited = store.getMessage(A, 'google:edited');
  assert.equal(edited.read, true); assert.equal(edited.starred, false); assert.deepEqual(edited.labels, ['Local label']);
  assert.equal(edited.providerFolderId, 'kept-provider-folder'); assert.equal(edited.providerFolderName, 'Kept display name');
  assert.deepEqual(edited.localOverrides, { read: true, starred: true, labels: true });
  const imported = store.getMessage(A, sent.id);
  for (const key of ['id', 'to', 'bcc', 'body', 'footer', 'messageId']) assert.deepEqual(imported[key], sent[key]);
  assert.equal(imported.remoteId, 'google:raw-sent'); assert.equal(store.getMessage(A, 'google:raw-sent'), null);
  assert.equal(store.listMessages(A).length, 7);
});

test('provider drafts require an explicit local copy; sending retries and mailbox ownership remain intact', async t => {
  let sent = 0, refreshed = 0;
  const { store, call } = await fixture(t, { refreshMail: async mail => { refreshed++; return mail; }, sendProviderMessage: async () => { sent++; return { messageId: '<sent@example.invalid>' }; } });
  const draft = remote('draft', ['DRAFT']); store.upsertMessage(A, draft);
  const content = { to: 'recipient@example.invalid', cc: '', bcc: '', subject: 'Reviewed copy', body: 'Body' };
  for (const [path, body] of [['/api/drafts', { ...content, id: draft.id }], ['/api/send', { ...content, draftId: draft.id, requestId: 'remote-draft-test' }]]) {
    const result = await call(path, body); assert.equal(result.status, 409); assert.match(result.data.error, /Copy it to a local draft/);
  }
  assert.equal(refreshed, 0); assert.equal(sent, 0); assert.deepEqual(store.getMessage(A, draft.id), draft);
  assert.equal((await call('/api/drafts', { ...content, id: draft.id }, B)).status, 404);
  const copy = await call('/api/drafts', { ...content, providerDraft: true, remoteId: draft.id });
  assert.equal(copy.status, 200); assert.equal(copy.data.message.accountId, A); assert.equal(copy.data.message.providerDraft, undefined); assert.equal(copy.data.message.remoteId, undefined);
  const send = { ...content, draftId: copy.data.message.id, requestId: 'local-copy-test' };
  assert.equal((await call('/api/send', send)).status, 200);
  assert.equal((await call('/api/send', send)).status, 200); assert.equal(sent, 1);
  assert.deepEqual(store.getMessage(A, draft.id), draft);
});

test('legacy fetchMessages injection still works and malformed allMail fails before provider activity', async t => {
  const fetched = []; let network = 0;
  const { store, call } = await fixture(t, { fetchProviderMessages: async mail => { fetched.push(mail.email); return [remote('legacy', ['INBOX'])]; }, fetchImapMessages: async mail => { fetched.push(mail.email); return []; }, verifySmtp: async () => { network++; }, oauthStart: () => { network++; throw new Error('Must not call'); } });
  store.setSettings({ mailAccounts: { [A]: connection(A), [B]: { email: B, provider: 'imap' } } });
  assert.equal((await call('/api/sync')).status, 200); assert.equal((await call('/api/sync', {}, B)).status, 200);
  assert.deepEqual(fetched, [A, B]);
  assert.equal((await call('/api/oauth/microsoft/start', { importOptions: { allMail: 'true' } })).status, 400);
  assert.equal((await call('/api/settings/mail', { email: B, imapHost: 'imap.example.invalid', smtpHost: 'smtp.example.invalid', password: 'fixture', importOptions: { allMail: 'true' } })).status, 400);
  assert.equal(network, 0);
});
