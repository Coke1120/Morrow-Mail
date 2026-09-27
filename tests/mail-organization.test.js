import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { simpleParser } from 'mailparser';
import { ImapFlow } from 'imapflow';
import { recipients } from '../server/recipients.js';
import { sendSmtpMessage, organizeImapMessage, listImapFolders } from '../server/integrations.js';
import { oauthStart, canOrganizeMail, listProviderFolders, organizeProviderMessage, sendProviderMessage, googleFolder, normalizeGoogleMessage } from '../server/providers.js';

const google = { provider: 'google', email: 'me@example.com', accessToken: 'fixture-token', grantedScopes: 'https://www.googleapis.com/auth/gmail.modify' };
const microsoft = { ...google, provider: 'microsoft', grantedScopes: 'Mail.ReadWrite Mail.Send' };
const footer = { html: '<b>Signature</b>', text: 'Signature' };
const recipientsInput = { to: 'a@example.com; b@example.com', cc: 'A@example.com, c@example.com', bcc: 'hidden@example.com' };

test('recipients validate every address, cap total, prevent header injection, and retain unfinished drafts', () => {
  assert.deepEqual(recipients(recipientsInput), { to: 'a@example.com, b@example.com', cc: 'c@example.com', bcc: 'hidden@example.com' });
  assert.equal(recipients({ bcc: 'hidden@example.com' }).to, '');
  assert.equal(recipients({ to: 'unfinished, ' }, true).to, 'unfinished,');
  for (const input of [{}, { to: 'a@example.com,' }, { cc: 'bad' }, { to: 'group:a@example.com' }, { to: '.first@example.com' }, { to: 'a@example.com\nBcc: hidden@example.com' }, { bcc: ['a@example.com'] }, { to: Array.from({ length: 101 }, (_, i) => `a${i}@example.com`).join(',') }]) assert.throws(() => recipients(input));
});

test('API MIME includes every To/Cc/Bcc recipient for Google and Microsoft delivery', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const raw = url.includes('googleapis') ? Buffer.from(JSON.parse(options.body).raw, 'base64url') : Buffer.from(options.body, 'base64');
    const parsed = await simpleParser(raw);
    assert.deepEqual(parsed.to.value.map(item => item.address), ['a@example.com', 'b@example.com']);
    assert.deepEqual(parsed.cc.value.map(item => item.address), ['c@example.com']);
    assert.equal(parsed.bcc.value[0].address, 'hidden@example.com');
    assert.equal(parsed.text.trim(), 'Hello\n\nSignature');
    assert.match(parsed.html, /<b>Signature<\/b>/);
    return new Response(null, { status: 202 });
  });
  for (const mail of [google, microsoft]) await sendProviderMessage(mail, { ...recipientsInput, subject: 'Private recipients', body: 'Hello', footer });
});

test('SMTP envelope includes Bcc while message headers omit it; partial acceptance remains uncertain', async t => {
  let partial = false, closed = 0;
  t.mock.method(nodemailer, 'createTransport', () => ({
    close() { closed++; },
    async sendMail(options) {
      const mime = new MailComposer(options).compile();
      assert.deepEqual(mime.getEnvelope().to, ['a@example.com', 'b@example.com', 'c@example.com', 'hidden@example.com']);
      const parsed = await simpleParser(await mime.build());
      assert.equal(parsed.bcc, undefined);
      assert.equal(parsed.text.trim(), 'Text\n\nSignature');
      assert.match(parsed.html, /<b>Signature<\/b>/);
      return { messageId: 'sent', accepted: partial ? ['a@example.com'] : mime.getEnvelope().to, rejected: partial ? ['b@example.com'] : [] };
    },
  }));
  assert.equal(await sendSmtpMessage(google, { ...recipientsInput, subject: 'Hello', body: 'Text', footer }), 'sent');
  partial = true;
  await assert.rejects(sendSmtpMessage(google, { ...recipientsInput, subject: 'Hello', body: 'Text', footer }), /not confirmed/);
  assert.equal(closed, 2);
});

test('provider organization is opt-in and Google moves preserve unrelated labels', async t => {
  for (const provider of ['google', 'microsoft']) {
    const start = oauthStart(provider, { clientId: 'fixture', organize: true }, 'http://localhost:3001/callback');
    assert.equal(canOrganizeMail({ provider, mailScope: start.config.mailScope }), true);
    assert.equal(canOrganizeMail({ provider, email: 'old@example.com' }), false);
  }
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    if (url.endsWith('/labels')) return Response.json({ labels: [{ id: 'Label_1', name: 'Projects', type: 'user' }, { id: 'SENT', name: 'Sent', type: 'system' }] });
    assert.equal(url.endsWith('/messages/abc/modify'), true);
    assert.deepEqual(JSON.parse(options.body), { addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] });
    return Response.json({ labelIds: ['Label_1', 'Label_2'] });
  });
  await assert.rejects(listProviderFolders({ ...google, grantedScopes: '' }), /Reconnect/);
  assert.equal(calls, 0);
  const folders = await listProviderFolders(google);
  assert.equal(folders.length, 3);
  const patch = await organizeProviderMessage(google, { id: 'google:abc' }, folders[2], 'move');
  assert.deepEqual(patch.providerLabelIds, ['Label_1', 'Label_2']);
  assert.equal(patch.folder, 'archive');
});

test('Gmail spam uses verified system labels, preserves other labels, and restores Inbox', async t => {
  for (const [labels, folder] of [[['TRASH', 'SPAM', 'DRAFT'], 'trash'], [['SPAM', 'DRAFT', 'INBOX', 'SENT'], 'spam']]) {
    assert.equal(googleFolder(labels), folder);
    assert.equal((await normalizeGoogleMessage({ id: 'abc', labelIds: labels })).folder, folder);
  }
  let labelIds = ['INBOX', 'UNREAD', 'STARRED', 'SENT', 'Label_1'], writes = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    if (url.endsWith('/labels')) return Response.json({ labels: [
      { id: 'SPAM', name: 'SPAM', type: 'system' }, { id: 'TRASH', name: 'TRASH', type: 'system' },
      { id: 'Label_1', name: 'Spam', type: 'user' },
    ] });
    assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/abc/modify');
    assert.equal(options.method, 'POST');
    const change = JSON.parse(options.body);
    assert.deepEqual(change, writes++ === 0 ? { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] } : { addLabelIds: ['INBOX'], removeLabelIds: ['SPAM'] });
    labelIds = [...labelIds.filter(id => !change.removeLabelIds.includes(id)), ...change.addLabelIds];
    return Response.json({ labelIds });
  });
  const folders = await listProviderFolders(google);
  assert.deepEqual(folders.map(({ id, kind }) => ({ id, kind })), [
    { id: 'INBOX', kind: 'inbox' }, { id: '__archive', kind: 'archive' },
    { id: 'SPAM', kind: 'spam' }, { id: 'Label_1', kind: 'label' },
  ]);
  const spam = folders.find(folder => folder.kind === 'spam'), message = { id: 'google:local', remoteId: 'google:abc' };
  for (const mode of ['addLabel', 'removeLabel']) await assert.rejects(organizeProviderMessage(google, message, spam, mode), /custom Gmail label/);
  await assert.rejects(organizeProviderMessage({ ...google, grantedScopes: 'https://www.googleapis.com/auth/gmail.readonly' }, message, spam, 'move'), /permission/);
  assert.equal(writes, 0);
  const moved = await organizeProviderMessage(google, message, spam, 'move');
  assert.equal(moved.folder, 'spam'); assert.equal(moved.providerSent, true);
  assert.deepEqual(moved.providerLabelIds, ['UNREAD', 'STARRED', 'SENT', 'Label_1', 'SPAM']);
  const restored = await organizeProviderMessage(google, message, folders[0], 'move');
  assert.equal(restored.folder, 'inbox');
  assert.deepEqual(restored.providerLabelIds, ['UNREAD', 'STARRED', 'SENT', 'Label_1', 'INBOX']);
  assert.equal(message.id, 'google:local'); assert.equal(writes, 2);
});

test('Outlook lists nested folders, identifies localized Junk by ID, and moves immutable IDs', async t => {
  let hostile = false, invalidJunk = false, destination = 'child';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/messages/')) {
      assert.match(options.headers.Prefer, /ImmutableId/);
      if (url.endsWith('/move')) { assert.equal(JSON.parse(options.body).destinationId, destination); return Response.json({ id: 'immutable' }); }
      return Response.json({ id: 'immutable', parentFolderId: 'inbox-id' });
    }
    if (url.includes('/mailFolders/inbox?')) return Response.json({ id: 'inbox-id' });
    if (url.includes('/mailFolders/junkemail?')) return Response.json({ id: invalidJunk ? null : 'junk-id' });
    if (url.includes('/childFolders?')) return Response.json({ value: [{ id: 'child', displayName: 'Junk Email' }, { id: 'junk-id', displayName: '垃圾郵件' }] });
    return Response.json({ value: [{ id: 'inbox-id', displayName: 'Inbox' }, { id: 'parent', displayName: 'Projects', childFolderCount: 1 }], ...(hostile ? { '@odata.nextLink': 'https://attacker.example/steal' } : {}) });
  });
  const folders = await listProviderFolders(microsoft);
  assert.equal(folders[0].kind, 'inbox');
  assert.equal(folders[2].name, 'Projects / Junk Email');
  assert.equal(folders[2].kind, 'folder');
  assert.equal(folders[3].kind, 'spam');
  const patch = await organizeProviderMessage(microsoft, { id: 'microsoft:immutable' }, folders[2], 'move');
  assert.equal(patch.remoteId, 'microsoft:immutable');
  assert.equal(patch.providerFolderId, 'child');
  destination = 'junk-id';
  const spam = await organizeProviderMessage(microsoft, { id: 'microsoft:local', remoteId: 'microsoft:immutable' }, folders[3], 'move');
  assert.equal(spam.folder, 'spam'); assert.equal(spam.providerFolderId, 'junk-id');
  assert.equal(spam.remoteId, 'microsoft:immutable');
  invalidJunk = true;
  await assert.rejects(listProviderFolders(microsoft), /invalid folder ID/);
  invalidJunk = false;
  hostile = true;
  await assert.rejects(listProviderFolders(microsoft), /unsafe/);
});

test('IMAP requires MOVE + UIDPLUS and a matching UID validity before writes, and retains destination UID mapping', async t => {
  let capable = true, validity = 55n, moves = 0;
  t.mock.method(ImapFlow.prototype, 'connect', async function () { this.capabilities = new Map(capable ? [['MOVE', true], ['UIDPLUS', true]] : []); this.mailbox = { uidValidity: validity }; });
  t.mock.method(ImapFlow.prototype, 'logout', async () => {});
  t.mock.method(ImapFlow.prototype, 'list', async () => [{ path: 'INBOX', flags: new Set() }, { path: 'Projects', flags: new Set() }]);
  t.mock.method(ImapFlow.prototype, 'getMailboxLock', async () => ({ release() {} }));
  t.mock.method(ImapFlow.prototype, 'fetchOne', async () => ({ uid: 7 }));
  t.mock.method(ImapFlow.prototype, 'messageMove', async (uid, path, options) => { moves++; assert.equal(uid, 7); assert.equal(path, 'Projects'); assert.equal(options.uid, true); return { uidValidity: 88n, uidMap: new Map([[7, 19]]) }; });
  const mail = { provider: 'imap', email: 'a@example.com', password: 'fixture', imapHost: 'imap.example.com', imapPort: 993 };
  assert.equal((await listImapFolders(mail)).length, 2);
  const patch = await organizeImapMessage(mail, { id: 'imap:55:7' }, { id: 'Projects', name: 'Projects', kind: 'folder' }, 'move');
  assert.equal(patch.remoteId, 'imap:88:19');
  assert.equal(patch.providerFolderId, 'Projects');
  validity = 99n;
  await assert.rejects(organizeImapMessage(mail, { id: 'imap:55:7' }, { id: 'Projects' }, 'move'), /changed/);
  capable = false;
  await assert.rejects(listImapFolders(mail), /MOVE and UIDPLUS/);
  assert.equal(moves, 1);
});

test('IMAP history keeps folder-specific identity and refuses changed UIDVALIDITY across pages', async t => {
  const { fetchImapPage } = await import('../server/integrations.js');
  let validity = 55n;
  t.mock.method(ImapFlow.prototype, 'connect', async function () { this.mailbox = { uidValidity: validity, exists: 60 }; });
  t.mock.method(ImapFlow.prototype, 'logout', async () => {});
  t.mock.method(ImapFlow.prototype, 'list', async () => [{ path: 'Sent Items', specialUse: '\\Sent' }]);
  t.mock.method(ImapFlow.prototype, 'getMailboxLock', async (path, options) => { assert.ok(['INBOX', 'Sent Items'].includes(path)); assert.equal(options.readOnly, true); return { release() {} }; });
  t.mock.method(ImapFlow.prototype, 'search', async (query, options) => { assert.equal(options.uid, true); return Array.from({ length: 60 }, (_, i) => i + 1); });
  t.mock.method(ImapFlow.prototype, 'fetch', async function* (range) { for (const uid of range.split(',').map(Number)) yield { uid, flags: new Set(), size: 100, internalDate: new Date('2026-09-23T12:00:00Z') }; });
  t.mock.method(ImapFlow.prototype, 'fetchOne', async () => ({ source: Buffer.from('From: a@example.com\r\nTo: b@example.com\r\nSubject: Sent sample\r\nDate: Wed, 23 Sep 2026 12:00:00 +0000\r\n\r\nHello, this is a useful writing sample from the account owner.') }));
  const mail = { provider: 'imap', email: 'a@example.com', imapHost: 'fixture.invalid', imapPort: 993, password: 'fixture' };
  const sent = await fetchImapPage(mail, { folder: 'sent', since: '2026-06-01T00:00:00Z', before: '2026-09-24T00:00:00Z' });
  const inbox = await fetchImapPage(mail);
  assert.equal(sent.messages.length, 50); assert.equal(sent.messages[0].folder, 'sent');
  assert.notEqual(sent.messages[0].id, inbox.messages[0].id); assert.equal(sent.messages[0].remoteId, inbox.messages[0].remoteId);
  assert.equal(sent.nextCursor.uid, 11);
  validity = 56n;
  await assert.rejects(fetchImapPage(mail, { folder: 'sent', cursor: sent.nextCursor }), /folder changed/);
});

test('IMAP all history persists Unicode folder and UID checkpoints while excluding special-use subtrees', async t => {
  const { fetchImapPage } = await import('../server/integrations.js');
  const opened = []; let lists = 0, validity = 55n;
  const definitions = [
    { path: 'INBOX' }, { path: 'INBOX' }, { path: '已寄件', specialUse: '\\Sent' }, { path: 'Drafts', specialUse: '\\Drafts' }, { path: 'Projects' },
    { path: '垃圾', specialUse: '\\Junk' }, { path: '垃圾/Child' }, { path: 'Trash', specialUse: '\\Trash' }, { path: 'Trash/Child' },
    { path: 'All', specialUse: '\\All' }, { path: 'Flagged', specialUse: '\\Flagged' }, { path: 'Hidden', specialUse: '\\Noselect' },
  ].map(item => ({ ...item, delimiter: '/', flags: new Set(item.specialUse ? [item.specialUse] : []) }));
  t.mock.method(ImapFlow.prototype, 'connect', async function () { this.mailbox = { uidValidity: validity, uidNext: 61, exists: 60 }; });
  t.mock.method(ImapFlow.prototype, 'logout', async () => {});
  t.mock.method(ImapFlow.prototype, 'list', async () => { lists++; return definitions; });
  t.mock.method(ImapFlow.prototype, 'getMailboxLock', async (path, options) => { opened.push(path); assert.ok(['INBOX', '已寄件', 'Drafts', 'Projects'].includes(path)); assert.equal(options.readOnly, true); return { release() {} }; });
  t.mock.method(ImapFlow.prototype, 'search', async query => { assert.equal(query.since, undefined); assert.equal(query.sentSince, undefined); const [lo,hi]=query.uid.split(':').map(Number); return Array.from({length:60},(_,i)=>i+1).filter(uid=>uid>=lo&&uid<=hi); });
  t.mock.method(ImapFlow.prototype, 'fetch', async function* (range) { for (const uid of range.split(',').map(Number)) yield { uid, flags: new Set(), size: 100, internalDate: new Date('2000-01-01T00:00:00Z') }; });
  t.mock.method(ImapFlow.prototype, 'fetchOne', async () => ({ source: Buffer.from('From: a@example.com\r\nSubject: Fixture\r\nDate: Sat, 1 Jan 2000 00:00:00 +0000\r\n\r\nFixture') }));
  const mail={email:'me@example.invalid',password:'fixture',imapHost:'fixture.invalid'}, options={folder:'all',since:'',before:'2026-09-27T00:00:00.000Z'};
  const first=await fetchImapPage(mail,options); assert.equal(first.messages.length,50); assert.equal(first.nextCursor.index,0); assert.equal(first.nextCursor.next.uid,11);
  validity=56n; await assert.rejects(fetchImapPage(mail,{...options,cursor:first.nextCursor}),/folder changed/); validity=55n;
  let cursor=JSON.parse(JSON.stringify(first.nextCursor)), rows=[...first.messages], pages=1;
  while(cursor) {const page=await fetchImapPage(mail,{...options,cursor}); rows.push(...page.messages); cursor=JSON.parse(JSON.stringify(page.nextCursor)); pages++; assert.ok(pages<=8);}
  assert.equal(pages,8); assert.equal(rows.length,240); assert.equal(lists,1); assert.equal(new Set(rows.map(row=>row.id)).size,240);
  assert.equal(rows[60].folder,'sent'); assert.equal(rows[60].providerFolderId,'已寄件'); assert.equal(rows[120].providerDraft,true); assert.equal(rows[180].folder,'archive');
});
