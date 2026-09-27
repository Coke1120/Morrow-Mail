import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { oauthStart, oauthFinish, refreshMail, normalizeGoogleMessage, normalizeMicrosoftMessage, googleFolder, fetchProviderMessages, fetchProviderPage, listProviderFolders, organizeProviderMessage, sendProviderMessage } from '../server/providers.js';

test('OAuth uses random state, PKCE, least-privilege scopes and keeps client secrets out of URLs', () => {
  for (const provider of ['google', 'microsoft']) {
    const result = oauthStart(provider, { clientId: 'client', clientSecret: 'private' }, `http://localhost:3001/api/oauth/${provider}/callback`);
    const params = new URL(result.url).searchParams;
    assert.equal(params.get('code_challenge'), createHash('sha256').update(result.verifier).digest('base64url'));
    assert.equal(params.get('code_challenge_method'), 'S256');
    assert.equal(params.get('state'), result.state);
    assert.ok(result.state.length >= 43);
    assert.notEqual(result.state, oauthStart(provider, { clientId: 'client' }, 'http://localhost').state);
    assert.doesNotMatch(result.url, /private|client_secret|gmail\.modify|Mail\.ReadWrite/);
    assert.match(params.get('scope'), provider === 'google' ? /gmail\.readonly.*gmail\.send/ : /offline_access.*Mail\.Read.*Mail\.Send/);
  }
  assert.throws(() => oauthStart('toString', { clientId: 'id' }, 'http://localhost'), /Unsupported/);
});

test('refresh rotates tokens without mutating settings and sanitizes remote errors', async t => {
  const mail = { provider: 'microsoft', clientId: 'client', refreshToken: 'secret', accessToken: 'expired', expiresAt: 0 };
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
    assert.equal(options.body.get('refresh_token'), 'secret');
    assert.equal(options.body.get('grant_type'), 'refresh_token');
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ access_token: 'new-token', refresh_token: 'rotated', expires_in: 3600 }));
  });
  const updated = await refreshMail(mail);
  assert.equal(mail.accessToken, 'expired');
  assert.equal(updated.accessToken, 'new-token');
  assert.equal(updated.refreshToken, 'rotated');
  assert.ok(updated.expiresAt > Date.now() + 3_500_000);
  await refreshMail(updated);
  assert.equal(fetch.mock.callCount(), 1);
  fetch.mock.mockImplementation(async () => new Response('private token secret', { status: 400 }));
  await assert.rejects(refreshMail(mail), error => /HTTP 400/.test(error.message) && !/secret/.test(error.message));
  fetch.mock.mockImplementation(async () => { throw new Error('private secret'); });
  await assert.rejects(refreshMail(mail), error => /could not be reached/.test(error.message) && !/secret/.test(error.message));
});

test('OAuth code exchange resolves the mailbox profile', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(requests.length === 1
      ? { access_token: 'token', refresh_token: 'refresh', expires_in: 3600 }
      : { emailAddress: 'Person@Example.com' }));
  });
  const result = await oauthFinish('google', { code: 'code', verifier: 'a'.repeat(64), config: { clientId: 'client', clientSecret: 'secret' }, redirectUri: 'http://localhost/callback' });
  assert.equal(result.email, 'person@example.com');
  assert.equal(requests[0].options.body.get('code_verifier'), 'a'.repeat(64));
  assert.equal(requests[0].options.body.get('client_secret'), 'secret');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer token');
});

test('normalization decodes MIME, prefers plain text, skips attachments, and safely converts HTML', async () => {
  const part = (mimeType, content, extra = {}) => ({ mimeType, body: { data: Buffer.from(content).toString('base64url') }, ...extra });
  const google = await normalizeGoogleMessage({ id: 'g1', internalDate: '1700000000000', labelIds: ['UNREAD', 'STARRED'], payload: {
    headers: [{ name: 'From', value: 'Alice <alice@example.com>' }, { name: 'To', value: 'me@example.com' }, { name: 'Subject', value: '=?UTF-8?B?SGVsbG8g4pyT?=' }, { name: 'Message-ID', value: '<one@example.com>' }, { name: 'List-Unsubscribe', value: '<https://example.com/unsubscribe>' }],
    parts: [part('text/html', '<b>wrong alternative</b>'), part('text/plain', 'Hi from plain text.'), part('text/plain', 'attachment secret', { filename: 'notes.txt' })],
  } });
  assert.equal(google.id, 'google:g1');
  assert.equal(google.fromEmail, 'alice@example.com');
  assert.equal(google.subject, 'Hello ✓');
  assert.equal(google.body, 'Hi from plain text.');
  assert.equal(google.messageId, '<one@example.com>');
  assert.equal(google.category, 'newsletters');
  assert.equal(google.read, false);
  assert.equal(google.starred, true);
  const microsoft = await normalizeMicrosoftMessage({ id: 'm1', subject: 'Receipt', body: { contentType: 'html', content: '<p>Hello &amp; welcome</p><script>secretScript()</script>' }, receivedDateTime: 'invalid' });
  assert.match(microsoft.body, /Hello & welcome/);
  assert.doesNotMatch(microsoft.body, /<p>|secretScript/);
  assert.equal(microsoft.category, 'updates');
  assert.equal(microsoft.date, '1970-01-01T00:00:00.000Z');
});

test('provider listing requests immutable Microsoft IDs and bounds Google detail concurrency', async t => {
  let active = 0;
  let maximum = 0;
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('graph.microsoft.com')) {
      assert.match(options.headers.Prefer, /ImmutableId/);
      assert.match(options.headers.Prefer, /body-content-type="html"/);
      return new Response('{"value":[]}');
    }
    if (url.includes('maxResults')) return new Response(JSON.stringify({ messages: Array.from({ length: 12 }, (_, index) => ({ id: String(index) })) }));
    if (url.endsWith('/labels')) return Response.json({ labels: [] });
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return new Response(JSON.stringify({ id: url.split('/messages/')[1].split('?')[0], payload: { headers: [] } }));
  });
  assert.deepEqual(await fetchProviderMessages({ provider: 'microsoft', accessToken: 'token' }), []);
  assert.equal((await fetchProviderMessages({ provider: 'google', accessToken: 'token' })).length, 12);
  assert.equal(maximum, 5);
  assert.equal(fetch.mock.callCount(), 15);
});

test('both native sending APIs encode Unicode and RFC reply headers without contacting a mailbox', async t => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    count++;
    const google = url.includes('gmail.googleapis.com');
    const raw = google ? Buffer.from(JSON.parse(options.body).raw, 'base64url') : Buffer.from(options.body, 'base64');
    const parsed = await simpleParser(raw);
    assert.equal(parsed.subject, 'Hello ✓');
    assert.equal(parsed.text.trim(), 'A reply for 你好.');
    assert.equal(parsed.to.value[0].address, 'to@example.com');
    assert.equal(parsed.inReplyTo, '<original@example.com>');
    assert.equal(options.method, 'POST');
    return new Response(google ? '{"id":"sent-id"}' : null, { status: google ? 200 : 202 });
  });
  for (const provider of ['google', 'microsoft']) {
    const result = await sendProviderMessage({ provider, email: 'me@example.com', accessToken: 'token' }, { to: 'to@example.com', subject: 'Hello ✓', body: 'A reply for 你好.', replyMessageId: '<original@example.com>' });
    assert.match(result.messageId, /^<.+>$/);
  }
  await assert.rejects(sendProviderMessage({ provider: 'google', email: 'me@example.com' }, { to: 'to@example.com\r\nBcc: victim@example.com', subject: 'Bad', body: 'Bad' }), /single line/);
  assert.equal(count, 2);
});

test('history pages use chosen folders and dates and reject foreign Graph continuation URLs', async t => {
  const { fetchProviderPage } = await import('../server/providers.js');
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push({ url: new URL(url), options });
    return new Response(JSON.stringify(String(url).includes('googleapis') ? { messages: [], nextPageToken: 'opaque token' } : { value: [], '@odata.nextLink': 'https://attacker.invalid/leak' }));
  });
  const options = { folder: 'sent', since: '2026-06-24T12:00:00.000Z', before: '2026-09-24T12:00:00.000Z' };
  const google = await fetchProviderPage({ provider: 'google', accessToken: 'private' }, options);
  assert.equal(google.nextCursor, 'opaque token');
  assert.equal(seen[0].url.searchParams.get('labelIds'), 'SENT');
  assert.match(seen[0].url.searchParams.get('q'), /after:\d+ before:\d+/);
  await fetchProviderPage({ provider: 'google', accessToken: 'private' }, { ...options, cursor: google.nextCursor });
  assert.equal(seen[1].url.searchParams.get('pageToken'), 'opaque token');
  const graph = await fetchProviderPage({ provider: 'microsoft', accessToken: 'private' }, options);
  assert.equal(seen[2].url.pathname, '/v1.0/me/mailFolders/sentitems/messages');
  assert.match(seen[2].url.searchParams.get('$filter'), /^sentDateTime ge/);
  await assert.rejects(fetchProviderPage({ provider: 'microsoft', accessToken: 'private' }, { ...options, cursor: graph.nextCursor }), /Invalid mailbox pagination/);
  assert.equal(seen.length, 3);
  for (const folder of ['inbox', 'sent']) {
    const wellKnown = folder === 'sent' ? 'sentitems' : 'inbox';
    const cursor = `https://graph.microsoft.com/v1.0/me/mailFolders('${wellKnown}')/messages?$top=50&$skip=50&$orderby=receivedDateTime%20desc&$filter=receivedDateTime%20ge%202026-06-24T00:00:00Z&$select=id,body`;
    await fetchProviderPage({ provider: 'microsoft', accessToken: 'private' }, { ...options, folder, cursor });
    assert.equal(seen.at(-1).url.href, cursor);
    assert.match(seen.at(-1).options.headers.Prefer, /IdType="ImmutableId"/);
  }
  const calls = seen.length;
  for (const cursor of [
    "https://graph.microsoft.com/v1.0/me/mailFolders('sentitems')/messages?$folder=inbox",
    "https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages/extra",
    "https://graph.microsoft.com/v1.0/me/mailFolders('%69nbox')/messages",
    "https://graph.microsoft.com/v1.0/me/mailFolders('opaque-id')/messages",
    "http://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages",
    "https://evil.example/v1.0/me/mailFolders('inbox')/messages",
    "https://graph.microsoft.com:444/v1.0/me/mailFolders('inbox')/messages",
    "https://user:secret@graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages",
    "https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages#fragment",
  ]) await assert.rejects(fetchProviderPage({ provider: 'microsoft', accessToken: 'private' }, { folder: 'inbox', cursor }), /Invalid mailbox pagination/);
  assert.equal(seen.length, calls);
});

test('Google normalization derives folder precedence and independent Sent/Draft flags from exact labels', async () => {
  for (const [labelIds, folder] of [
    [['TRASH', 'DRAFT', 'INBOX', 'SENT', 'STARRED'], 'trash'],
    [['DRAFT', 'INBOX', 'SENT'], 'drafts'],
    [['INBOX', 'SENT', 'UNREAD'], 'inbox'],
    [['SENT', 'STARRED'], 'sent'],
    [['Label_1'], 'archive'], [[], 'archive'],
  ]) {
    const message = await normalizeGoogleMessage({ id: 'stable', labelIds, payload: { headers: [] } });
    assert.equal(googleFolder(labelIds), folder); assert.equal(message.folder, folder);
    assert.equal(message.id, 'google:stable'); assert.deepEqual(message.providerLabelIds, labelIds);
    assert.equal(message.providerSent, labelIds.includes('SENT')); assert.equal(message.providerDraft, labelIds.includes('DRAFT'));
    assert.equal(message.starred, labelIds.includes('STARRED')); assert.equal(message.read, !labelIds.includes('UNREAD'));
  }
  assert.equal(googleFolder(), 'archive');
  await assert.rejects(normalizeGoogleMessage({ labelIds: 'INBOX' }), /invalid message labels/);
});

test('Google pages cover all five scopes, keep stable IDs and resolve user labels once with readonly permission', async t => {
  const mail = { provider: 'google', accessToken: 'fixture-token', grantedScopes: 'https://www.googleapis.com/auth/gmail.readonly' };
  const rows = [
    { id: 'dual', labelIds: ['INBOX', 'SENT', 'STARRED', 'UNREAD', 'Label_1'] },
    { id: 'sent', labelIds: ['SENT', 'Label_2'] },
    { id: 'draft', labelIds: ['DRAFT', 'INBOX', 'Label_1'] },
    { id: 'archive', labelIds: ['Label_2', 'Label_deleted'] },
  ];
  const lists = []; let labelRequests = 0, details = 0;
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    const url = new URL(target);
    assert.equal(url.origin, 'https://gmail.googleapis.com'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    if (url.pathname.endsWith('/labels')) {
      labelRequests++;
      return Response.json({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'SENT', name: 'SENT', type: 'system' }, { id: 'Label_1', name: '工作 / 專案', type: 'user' }, { id: 'Label_2', name: 'Travel', type: 'user' }] });
    }
    if (url.pathname.endsWith('/messages')) {
      lists.push(url);
      const label = url.searchParams.get('labelIds');
      return Response.json({ messages: rows.filter(row => !label || row.labelIds.includes(label)).map(({ id }) => ({ id })), nextPageToken: 'opaque /?& token' });
    }
    details++;
    assert.equal(url.searchParams.get('format'), 'full');
    const row = rows.find(row => url.pathname.endsWith('/' + row.id)); assert.ok(row);
    return Response.json({ ...row, internalDate: '1700000000000', payload: { headers: [] } });
  });
  const options = { since: '2026-06-24T12:00:00.000Z', before: '2026-09-24T12:00:00.000Z' };
  for (const [folder, label] of [['all', null], ['inbox', 'INBOX'], ['sent', 'SENT'], ['drafts', 'DRAFT'], ['starred', 'STARRED']]) {
    const page = await fetchProviderPage(mail, { ...options, folder, cursor: 'opaque /?& token' });
    const query = lists.at(-1).searchParams;
    assert.equal(query.get('labelIds'), label); assert.equal(query.get('includeSpamTrash'), 'false');
    assert.equal(query.get('maxResults'), '50'); assert.equal(query.get('pageToken'), 'opaque /?& token');
    assert.match(query.get('q'), /^after:\d+ before:\d+$/);
    assert.equal(page.nextCursor, 'opaque /?& token');
    for (const message of page.messages) {
      const raw = rows.find(row => message.id === `google:${row.id}`);
      assert.deepEqual(message.providerLabelIds, raw.labelIds); assert.equal(message.folder, googleFolder(raw.labelIds));
      assert.deepEqual(message.labels, [raw.labelIds.includes('Label_1') ? '工作 / 專案' : 'Travel']);
      assert.equal(message.providerSent, raw.labelIds.includes('SENT')); assert.equal(message.providerDraft, raw.labelIds.includes('DRAFT'));
    }
  }
  assert.equal(labelRequests, 5); assert.equal(details, 10);
  await assert.rejects(listProviderFolders(mail), /Allow moving mail/);
  assert.equal(labelRequests, 5); // Readonly fetch does not weaken organization authorization.
  for (const folder of ['drafts', 'starred']) await assert.rejects(fetchProviderPage({ ...mail, provider: 'microsoft' }, { folder }), /Unsupported import folder/);
});

test('Google custom label changes retain exact Sent and Draft classification from confirmed labels', async t => {
  const mail = { provider: 'google', accessToken: 'fixture-token', grantedScopes: 'https://www.googleapis.com/auth/gmail.modify' };
  let confirmed;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    assert.equal(target, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/stable/modify');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    calls.push(JSON.parse(options.body));
    return Response.json({ labelIds: confirmed });
  });
  for (const [mode, labels, folder] of [
    ['addLabel', ['SENT', 'Label_1'], 'sent'],
    ['removeLabel', ['DRAFT', 'SENT'], 'drafts'],
    ['addLabel', ['TRASH', 'DRAFT', 'SENT', 'INBOX', 'Label_1'], 'trash'],
  ]) {
    confirmed = labels;
    const result = await organizeProviderMessage(mail, { id: 'google:stable' }, { id: 'Label_1', kind: 'label' }, mode);
    assert.equal(result.folder, folder); assert.deepEqual(result.providerLabelIds, labels);
    assert.equal(result.providerSent, labels.includes('SENT')); assert.equal(result.providerDraft, labels.includes('DRAFT'));
    assert.deepEqual(calls.at(-1), mode === 'addLabel' ? { addLabelIds: ['Label_1'], removeLabelIds: [] } : { addLabelIds: [], removeLabelIds: ['Label_1'] });
  }
});

test('Google page and label discovery reject oversized or malformed remote lists before detail requests', async t => {
  const mail = { provider: 'google', accessToken: 'fixture-token' };
  let page = { messages: Array.from({ length: 51 }, (_, id) => ({ id: String(id) })) };
  let labels = { labels: [] }, detailRequests = 0;
  t.mock.method(globalThis, 'fetch', async target => {
    const url = new URL(target);
    if (url.pathname.endsWith('/messages')) return Response.json(page);
    if (url.pathname.endsWith('/labels')) return Response.json(labels);
    detailRequests++; return Response.json({ id: 'one' });
  });
  await assert.rejects(fetchProviderPage(mail, { folder: 'all' }), /invalid message page/);
  page = { messages: [{ id: 'one' }] };
  labels = { labels: Array.from({ length: 1001 }, (_, id) => ({ id: String(id), name: 'Label', type: 'user' })) };
  await assert.rejects(fetchProviderPage(mail), /too many or invalid labels/);
  labels = { labels: [{ id: 'Label_1', name: null, type: 'user' }] };
  await assert.rejects(fetchProviderPage(mail), /too many or invalid labels/);
  assert.equal(detailRequests, 0);
});

test('Microsoft all-mail traverses normal folders with bounded durable pages and excludes Junk/Trash subtrees', async t => {
  const calls = [], folders = [
    { id: 'i=', displayName: 'Inbox' }, { id: 's=', displayName: 'Sent' }, { id: 'd=', displayName: 'Drafts' },
    { id: 'p=', displayName: 'Projects', childFolderCount: 1 },
    { id: 'j=', displayName: 'Junk', childFolderCount: 2 }, { id: 't=', displayName: 'Deleted', childFolderCount: 3 },
  ];
  const known = { inbox: 'i=', sentitems: 's=', drafts: 'd=', junkemail: 'j=', deleteditems: 't=' };
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input), path = url.pathname; calls.push(url);
    assert.equal(url.origin, 'https://graph.microsoft.com'); assert.equal(options.headers.Authorization, 'Bearer fixture');
    const alias = path.match(/^\/v1\.0\/me\/mailFolders\/([a-z]+)$/)?.[1];
    let value;
    if (known[alias]) value = { id: known[alias] };
    else if (path === '/v1.0/me/mailFolders') value = { value: folders };
    else if (path === '/v1.0/me/mailFolders/p%3D/childFolders') value = { value: [{ id: 'c=', displayName: 'Child' }] };
    else {
      assert.ok(!/[jt](?:%3D|=)/.test(path), 'excluded folders and their children are never fetched');
      assert.equal(url.searchParams.get('$top'), '50');
      assert.doesNotMatch(url.searchParams.get('$filter'), / ge /); assert.match(url.searchParams.get('$filter'), / lt 2026-/);
      assert.match(options.headers.Prefer, /ImmutableId/);
      const id = path.includes("('i=')") ? 'i=' : decodeURIComponent(path.split('/')[4]);
      assert.ok(['i=', 's=', 'd=', 'p=', 'c='].includes(id));
      const next = id === 'i=' && !url.searchParams.has('$skip') ? `https://graph.microsoft.com/v1.0/me/mailFolders('i=')/messages?${url.searchParams}&$skip=50` : null;
      value = { value: id === 'p=' ? [] : [{ id: `${id}-${url.searchParams.get('$skip') || 0}`, subject: id, receivedDateTime: '2000-01-01T00:00:00Z', sentDateTime: '2000-01-02T00:00:00Z', createdDateTime: '2000-01-03T00:00:00Z', isDraft: id === 'd=', body: { contentType: 'text', content: 'Fixture' } }], '@odata.nextLink': next };
    }
    return new Response(JSON.stringify(value));
  });
  const mail = { provider: 'microsoft', accessToken: 'fixture', grantedScopes: 'Mail.Read' };
  const options = { folder: 'all', since: '', before: '2026-09-27T00:00:00.000Z' };
  const first = await fetchProviderPage(mail, options);
  assert.equal(first.messages[0].folder, 'inbox'); assert.equal(first.nextCursor.index, 0);
  assert.equal(first.nextCursor.folders.length, 5); assert.match(first.nextCursor.next, /\$skip=50/);
  const metadataCalls = calls.length;
  for (const next of ['https://evil.invalid/v1.0/me/mailFolders/i%3D/messages', "https://graph.microsoft.com/v1.0/me/mailFolders('s=')/messages", "https://graph.microsoft.com/v1.0/me/mailFolders('i=')/messages/extra", "https://graph.microsoft.com/v1.0/me/mailFolders('i=')/messages#fragment"]) {
    await assert.rejects(fetchProviderPage(mail, { ...options, cursor: { ...first.nextCursor, next } }), /pagination/);
  }
  assert.equal(calls.length, metadataCalls);
  const rows = [...first.messages]; let cursor = JSON.parse(JSON.stringify(first.nextCursor)), pages = 1;
  while (cursor) {
    const page = await fetchProviderPage(mail, { ...options, cursor });
    rows.push(...page.messages); cursor = JSON.parse(JSON.stringify(page.nextCursor)); pages++;
    assert.ok(pages <= 6);
  }
  assert.equal(pages, 6); assert.deepEqual(rows.map(row => row.folder), ['inbox', 'inbox', 'sent', 'drafts', 'archive']);
  assert.equal(rows[2].providerSent, true); assert.equal(rows[3].providerDraft, true);
  assert.equal(rows[3].date, '2000-01-03T00:00:00.000Z');
  assert.equal(rows[4].providerFolderName, 'Projects / Child'); assert.equal(rows[4].providerFolderId, 'c=');
  assert.equal(calls.filter(url => url.pathname === '/v1.0/me/mailFolders').length, 1);
  await assert.rejects(listProviderFolders(mail), /Reconnect/); // Reading history does not grant write access.
  await assert.rejects(fetchProviderPage(mail, { ...options, cursor: { ...first.nextCursor, folders: Array(301).fill(first.nextCursor.folders[0]) } }), /cursor/);
});

test('out-of-office scope is explicit, additive to organize, and never changes calendar', () => {
  for (const [provider, scope] of [['google', 'https://www.googleapis.com/auth/gmail.settings.basic'], ['microsoft', 'MailboxSettings.ReadWrite']]) {
    for (const organize of [false, true]) {
      const config = { clientId: 'fixture-client', organize };
      const before = oauthStart(provider, config, 'http://localhost/callback');
      const opted = oauthStart(provider, { ...config, outOfOffice: true }, 'http://localhost/callback');
      assert.equal(new URL(opted.url).searchParams.get('scope'), `${new URL(before.url).searchParams.get('scope')} ${scope}`);
      const calendar = oauthStart(provider, { ...config, outOfOffice: true }, 'http://localhost/callback', 'calendar');
      assert.ok(!new URL(calendar.url).searchParams.get('scope').includes(scope));
    }
  }
});
