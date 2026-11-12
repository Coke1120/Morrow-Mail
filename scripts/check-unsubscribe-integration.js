// Production provider/cache/preload/native-review integration, entirely synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const Module = require('node:module');
const fixture = require('./mail-performance-fixture');

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-unsubscribe-'));
  const env = { ...process.env }, oldLoad = Module._load, oldFetch = global.fetch;
  const dns = require('node:dns').promises, oldLookup = dns.lookup;
  const net = require('node:net'), oldConnect = net.Socket.prototype.connect;
  let dialogResponse = 0, duringReview = null, destroyed = false;
  const dialogs = [], launches = [], sender = { isDestroyed: () => destroyed };
  const win = { isDestroyed: () => destroyed };
  const electron = { BrowserWindow: { fromWebContents: candidate => candidate === sender ? win : null },
    dialog: { async showMessageBox(parent, options) { assert.equal(parent, win); dialogs.push(options); if (duringReview) await duringReview(); return { response: dialogResponse }; } },
    shell: { async openExternal(url) { launches.push(url); } } };
  Module._load = function(request, ...args) { return request === 'electron' ? electron : oldLoad.call(this, request, ...args); };
  Object.assign(process.env, { MORROW_MAIL_DIR: directory, MORROW_USER_DATA: directory, MORROW_AI_CONFIG_DIR: directory, MORROW_MAIL_SECRETS: 'memory', MORROW_GMAIL_PACE: '0' });
  global.fetch = async () => { throw new Error('Live fetch forbidden'); };
  net.Socket.prototype.connect = function() { throw new Error('Live socket forbidden'); };
  dns.lookup = async () => [{ address: '8.8.8.8', family: 4 }];
  const engine = require('../host/mail/engine'), db = require('../host/mail/db');
  const remote = require('../host/mail/remote'), secrets = require('../host/mail/secrets');
  const policy = require('../host/mail/list-unsubscribe'), oldClient = remote.withClient;
  let reads = 0;
  const raw = Buffer.from('From: Newsletter <list@news.example.com>\r\nTo: owner@fixture.invalid\r\nSubject: Synthetic newsletter\r\nMessage-ID: <list@news.example.com>\r\nList-Unsubscribe: <https://news.example.com/unsubscribe?token=opaque>,\r\n <mailto:leave@news.example.com?subject=Leave&body=Remove%20this%20address>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\nSynthetic body\r\n');
  const client = { mailbox: { uidValidity: 7 },
    async getMailboxLock() { return { release() {} }; },
    async *fetch(range) { reads++; yield { uid: Number(range), envelope: { subject: 'Synthetic newsletter', from: [{ address: 'list@news.example.com', name: 'Newsletter' }] }, source: raw, flags: new Set(), internalDate: new Date('2026-11-12T00:00:00Z') }; } };
  remote.withClient = async (_account, _secret, work) => work(client);
  const ask = async (channel, params, event = { sender }) => {
    const result = await engine.answer(channel, [params], event);
    assert.equal(result.success, true, JSON.stringify(result)); return result.data;
  };
  try {
    await engine.init();
    for (const id of ['imap', 'other']) {
      db.insertAccount({ ...fixture.account, id }); db.replaceFolders(id, fixture.folders); secrets.setPassword(id, 'synthetic-only');
    }
    // Real IMAP parser and actual SQL sync path retain only parsed list fields.
    const parsed = await remote.fetchSource(client, 'INBOX', 1, 7);
    assert.equal(parsed.listUnsubscribe.oneClick, true);
    assert.equal(parsed.listUnsubscribe.urls.length, 2);
    assert.deepEqual(policy.descriptor(parsed.listUnsubscribe), { kind: 'mailto', destination: 'leave@news.example.com' });
    db.applyFolderSync('imap', 'INBOX', fixture.report([{ ...parsed, id: 'newsletter' }]));
    const stored = db.messageById('newsletter');
    assert.deepEqual(JSON.parse(stored.list_unsubscribe_json), parsed.listUnsubscribe);
    const listed = (await ask('mail:listFromCache', { accountId: 'imap', folderId: 'INBOX' })).emails.find(row => row.id === stored.id);
    assert.deepEqual(listed.unsubscribe, { kind: 'mailto', destination: 'leave@news.example.com' });
    assert.equal(JSON.stringify(listed).includes('token=opaque'), false, 'opaque URLs stay out of renderer data');
    assert.equal(Object.hasOwn(listed, 'listUnsubscribe'), false);
    const email = (await ask('mail:openEmail', { accountId: 'imap', emailId: stored.id, includeThread: false })).email;
    assert.deepEqual(email.unsubscribe, listed.unsubscribe);
    assert.equal(email.unsubscribeChecked, true);
    const before = reads;
    await ask('mail:openEmail', { accountId: 'imap', emailId: stored.id, includeThread: false });
    assert.equal(reads, before, 'checked metadata does not add a provider read');

    // Older complete caches stay immediate/offline; only explicit reload fills missing headers.
    db.insertMessage({ ...fixture.message(2), id: 'legacy', accountId: 'imap', folderPath: 'INBOX', uidValidity: 7 });
    assert.equal(db.messageById('legacy').list_unsubscribe_json, null);
    assert.equal((await ask('mail:listFromCache', { accountId: 'imap', folderId: 'INBOX' })).emails.find(row => row.id === 'legacy').unsubscribe, null);
    assert.equal(reads, before, 'list/render does not fetch unsubscribe headers');
    const oldRead = remote.withClient;
    let providerAttempts = 0;
    remote.withClient = async () => { providerAttempts++; throw new Error('A cached open must not wait for a slow or offline provider'); };
    const cached = (await ask('mail:openEmail', { accountId: 'imap', emailId: 'legacy', includeThread: false })).email;
    assert.equal(cached.textBody, 'Synthetic searchable body'); assert.equal(cached.unsubscribe, null);
    assert.equal(cached.unsubscribeChecked, false);
    assert.equal(reads, before, 'ordinary complete cached opens never request missing unsubscribe metadata');
    assert.equal(providerAttempts, 0, 'cached opening cannot enter the provider, even when a failed read would preserve the body');
    remote.withClient = oldRead;
    const legacy = (await ask('mail:openEmail', { accountId: 'imap', emailId: 'legacy', includeThread: false, retry: true })).email;
    assert.equal(legacy.unsubscribe.kind, 'mailto'); assert.equal(legacy.unsubscribeChecked, true); assert.equal(reads, before + 1);

    // Actual native review, captured destination, no automatic SMTP or browser.
    const target = { accountId: 'imap', emailId: stored.id };
    let result = await ask('mail:unsubscribe', target);
    assert.equal(result.status, 'cancelled'); assert.equal(launches.length, 0);
    assert.equal(dialogs.at(-1).defaultId, 0); assert.equal(dialogs.at(-1).cancelId, 0);
    assert.match(dialogs.at(-1).detail, /owner@fixture.invalid/);
    assert.match(dialogs.at(-1).detail, /leave@news.example.com/);
    assert.match(dialogs.at(-1).detail, /Nothing is sent now/);
    dialogResponse = 1;
    result = await ask('mail:unsubscribe', target);
    assert.equal(result.status, 'draft');
    assert.deepEqual(result.draft, { accountId: 'imap', sourceMessageId: stored.id, to: 'leave@news.example.com', subject: 'Leave', text: 'Remove this address' });
    assert.equal(launches.length, 0);
    assert.equal((await ask('mail:unsubscribe', { ...target, accountId: 'other' })).status, 'unavailable');
    assert.equal((await ask('mail:unsubscribe', { ...target, url: 'https://attacker.example.com' })).status, 'unavailable');
    assert.equal((await ask('mail:unsubscribe', { accountId: '__morrow_local__', emailId: 'local-message:missing' })).status, 'unavailable');
    destroyed = true;
    assert.equal((await ask('mail:unsubscribe', target)).status, 'cancelled'); destroyed = false;

    duringReview = async () => db.updateMessage(stored.id, { folder_path: 'Sent' });
    assert.equal((await ask('mail:unsubscribe', target)).status, 'stale');
    duringReview = null; db.updateMessage(stored.id, { folder_path: 'INBOX' });
    const webMetadata = policy.parseHeaders('List-Unsubscribe: <https://news.example.com/manual?token=private>\r\n\r\n');
    db.updateMessage(stored.id, { list_unsubscribe_json: JSON.stringify(webMetadata) });
    result = await ask('mail:unsubscribe', target);
    assert.equal(result.status, 'opened'); assert.match(result.message, /Completion is not confirmed/);
    assert.deepEqual(launches, ['https://news.example.com/manual?token=private']);
    assert.match(dialogs.at(-1).detail, /signed-in session and follow redirects/);
    assert.equal(dialogs.at(-1).detail.includes('token=private'), false);

    // The Gmail full-payload parser follows the same metadata/persistence route.
    db.insertAccount({ ...fixture.account, id: 'gmail', profile: 'gmail', authKind: 'oauth2' }); db.enableGmail('gmail');
    const account = db.accountById('gmail');
    db.replaceFolders('gmail', [{ path: 'INBOX', name: 'Inbox', wellKnown: 'inbox', providerId: 'INBOX' }]);
    const data = { id: 'gmail-provider', threadId: 'gmail-thread', labelIds: ['INBOX'], internalDate: '1794441600000', snippet: 'Body',
      payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'list@news.example.com' }, { name: 'Subject', value: 'Gmail list' },
        { name: 'Message-ID', value: '<gmail-list@news.example.com>' },
        { name: 'List-Unsubscribe', value: '<mailto:leave@news.example.com?subject=Unsubscribe>' },
        { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' }], body: { size: 4, data: Buffer.from('Body').toString('base64url') } } };
    const session = require('../host/mail/gmail-session').createSession(account, 'synthetic-only', { api: {} });
    const normalized = await session.adopt(data, { full: true });
    assert.equal(normalized.listUnsubscribe.urls.length, 1);
    const gmail = db.gmailCopies('gmail', data.id)[0];
    assert.deepEqual(JSON.parse(gmail.list_unsubscribe_json), normalized.listUnsubscribe);
    data.payload.headers = data.payload.headers.filter(header => !header.name.startsWith('List-Unsubscribe'));
    await session.adopt(data, { full: true });
    assert.deepEqual(JSON.parse(db.messageById(gmail.id).list_unsubscribe_json).urls, [], 'removed metadata does not leave a stale banner');

    // SQL reinsert/recovery, draft exclusion and durable restart.
    db.insertMessage({ ...fixture.message(3), id: 'reinsert', accountId: 'imap', folderPath: 'INBOX', uidValidity: 7, listUnsubscribe: webMetadata });
    db.insertMessage({ ...fixture.message(4), id: 'draft', accountId: 'imap', folderPath: 'INBOX', uidValidity: 7, isDraft: true, listUnsubscribe: webMetadata });
    assert.equal((await ask('mail:openEmail', { emailId: 'draft', accountId: 'imap' })).email.unsubscribe, null);
    const metadata = db.messageById('reinsert').list_unsubscribe_json;
    await db.close(); await db.open(path.join(directory, 'mail.sqlite'));
    assert.equal(db.messageById('reinsert').list_unsubscribe_json, metadata);

    // Execute the real preload so a missing bridge allowlist fails this suite.
    let bridge, invoked;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/preload.js'), 'utf8'), {
      require: name => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'morrow'); bridge = value; } },
        ipcRenderer: { invoke(channel, params) { invoked = { channel, params }; return Promise.resolve(); } } }; }
    });
    await bridge.invoke('mail:unsubscribe', target); assert.equal(invoked.channel, 'mail:unsubscribe');
    await assert.rejects(bridge.invoke('mail:unsubscribeAll', target), /Unsupported channel/);
    console.log('unsubscribe-integration-ok: provider headers, cache/restart/explicit reload, host ownership/native review, manual-only outcomes and preload');
  } finally {
    remote.withClient = oldClient; Module._load = oldLoad; global.fetch = oldFetch; dns.lookup = oldLookup; net.Socket.prototype.connect = oldConnect;
    await engine.stopIdle(); await db.close();
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env); fs.rmSync(directory, { recursive: true, force: true });
  }
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
