// Synthetic cache, production recipient formatters and renderer. No real mail,
// credentials, live provider calls or native account windows.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { JSDOM } = require('jsdom');
const { renderer } = require('./check-ux-workflows');
const fixture = require('./mail-performance-fixture');

test('To Me uses the owning account and To only before paging, counts and search limits', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-to-me-'));
  const previous = { ...process.env };
  const env = { MORROW_MAIL_DIR: dir, MORROW_USER_DATA: dir, MORROW_MAIL_SECRETS: 'memory' };
  Object.assign(process.env, env);
  const db = require('../host/mail/db'), engine = require('../host/mail/engine');
  t.after(async () => {
    await db.close();
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await engine.init();
  for (const id of ['a', 'b']) {
    db.insertAccount({ ...fixture.account, id, email: `${id}@fixture.invalid` });
    db.replaceFolders(id, [...fixture.folders, { path: 'All Mail', name: 'All Mail', wellKnown: 'all' },
      { path: 'Drafts', name: 'Drafts', wellKnown: 'drafts' }]);
  }
  const ask = async (params, channel = 'mail:listFromCache') => {
    const result = await engine.answer(channel, [params]);
    assert.equal(result.success, true, JSON.stringify(result.error));
    return result.data;
  };
  const ids = result => result.emails.map(row => row.id).sort();
  const cases = [
    ['bare', { to: ['a@fixture.invalid'] }, true],
    ['named', { to: ['"Last, First" <A@FIXTURE.INVALID>'] }, true],
    ['multiple', { to: ['other@fixture.invalid', 'a@fixture.invalid'] }, true],
    ['structured', { to: [{ name: 'A', address: 'a@fixture.invalid' }] }, true],
    ['cc', { to: ['other@fixture.invalid'], cc: ['a@fixture.invalid'] }, false],
    ['bcc', { to: [], bcc: ['a@fixture.invalid'] }, false],
    ['delivered', { to: ['team@fixture.invalid'], recipientHeaders: { deliveredTo: ['a@fixture.invalid'], originalTo: ['a@fixture.invalid'], envelopeTo: ['a@fixture.invalid'] } }, false],
    ['display', { to: ['"a@fixture.invalid" <other@fixture.invalid>'] }, false],
    ['display-angle', { to: ['Owner <a@fixture.invalid> <other@fixture.invalid>'] }, false],
    ['actual-angle', { to: ['Name <other@fixture.invalid> <a@fixture.invalid>'] }, true],
    ['comment', { to: ['Other (a@fixture.invalid) <other@fixture.invalid>'] }, false],
    ['prefix', { to: ['nota@fixture.invalid'] }, false],
    ['domain', { to: ['a@fixture.invalid.example'] }, false],
    ['plus', { to: ['a+tag@fixture.invalid'] }, false],
    ['alias', { to: ['alias@fixture.invalid'] }, false],
    ['other-account', { to: ['b@fixture.invalid'] }, false],
    ['missing', { to: [] }, false],
  ];
  db.applyFolderSync('a', 'INBOX', fixture.report(cases.map(([id, fields], n) =>
    fixture.message(n + 1, { ...fields, id, unread: true, starred: true }))));
  db.applyFolderSync('b', 'INBOX', fixture.report([
    fixture.message(1, { id: 'b-owned', to: ['B@fixture.invalid'], unread: true, starred: true }),
    fixture.message(2, { id: 'b-other-account', to: ['a@fixture.invalid'], unread: true, starred: true }),
  ]));
  const expectedA = cases.filter(row => row[2]).map(row => row[0]).sort();
  const scope = { accountId: 'a', folderId: 'INBOX', filterToMe: true };
  assert.deepEqual(ids(await ask(scope)), expectedA);
  assert.equal((await ask(scope)).total, expectedA.length);
  assert.equal((await ask({ ...scope, filterToMe: false })).total, cases.length);
  assert.equal((await ask({ ...scope, filterToMe: 'true' })).total, cases.length, 'strict boolean admission');
  const merged = { folderKey: 'primary', filterToMe: true, sortBy: 'subject', sortDirection: 'asc' };
  const allExpected = [...expectedA, 'b-owned'].sort(), pages = [];
  for (let offset = 0; offset < allExpected.length; offset += 2) {
    const page = await ask({ ...merged, limit: 2, offset });
    assert.equal(page.total, allExpected.length); assert.ok(page.emails.length <= 2);
    pages.push(...page.emails.map(row => row.id));
    assert.ok(page.emails.every(row => !('textBody' in row) && !('htmlBody' in row)));
  }
  assert.deepEqual(pages.sort(), allExpected);
  for (const aggregateView of ['starred', 'unread']) {
    assert.deepEqual(ids(await ask({ aggregateView, filterToMe: true })), allExpected);
  }
  db.applyFolderSync('a', 'Sent', fixture.report([
    fixture.message(1, { id: 'self-sent', from: 'a@fixture.invalid', to: ['a@fixture.invalid'] }),
    fixture.message(2, { id: 'outgoing', from: 'a@fixture.invalid', to: ['b@fixture.invalid'] }),
  ]));
  assert.deepEqual(ids(await ask({ accountId: 'a', folderId: 'Sent', filterToMe: true })), ['self-sent']);
  const first = await ask({ ...scope, limit: 1 });
  assert.ok(first.nextCursor);
  db.updateMessage('bare', { to_json: '["other@fixture.invalid"]' });
  const changed = await ask({ ...scope, offset: 1, limit: 1, pageCursor: first.nextCursor });
  assert.equal(changed.total, expectedA.length - 1); assert.equal(changed.cursorReset, true);
  db.applyFolderSync('a', 'Drafts', fixture.report([fixture.message(1, { id: 'draft', isDraft: true, to: ['a@fixture.invalid'] })]));
  const drafts = { accountId: 'a', folderId: 'Drafts', filterToMe: true };
  assert.equal((await ask(drafts)).total, 1);
  db.updateMessage('draft', { to_json: '[]' });
  assert.equal((await ask(drafts)).total, 0, 'draft To edit invalidates the filtered count');
  const corrupt = ['{', 'null', '{}', '"a@fixture.invalid"'];
  for (const to_json of corrupt) {
    db.updateMessage('draft', { to_json });
    assert.equal((await ask(drafts)).total, 0, 'unknown or invalid recipients cannot match');
  }
  db.updateMessage('draft', { to_json: '[]' });
  // More than 100 unrelated hits sort ahead of the matching search results.
  const searchRows = Array.from({ length: 140 }, (_, n) => fixture.message(1000 + n, {
    id: `search-${n}`, subject: 'Needle synthetic', to: [n < 125 ? 'other@fixture.invalid' : 'a@fixture.invalid'], listSortTs: 1000 + (140 - n),
  }));
  db.applyFolderSync('a', 'All Mail', fixture.report(searchRows));
  const search = await ask({ query: 'needle', accountId: 'a', limit: 100, filterToMe: true }, 'mail:searchLocal');
  assert.equal(search.length, 15); assert.ok(search.every(row => Number(row.id.slice(7)) >= 125));
  assert.equal((await ask({ query: 'needle', limit: 100 }, 'mail:searchLocal')).length, 100);
  // The normalized identity comes from SQLite, not an IPC-supplied email.
  assert.deepEqual(ids(await ask({ ...scope, email: 'other@fixture.invalid' })), expectedA.filter(id => id !== 'bare'));

  await t.test('production MIME/provider formatters preserve direct To evidence', async () => {
    const remote = require('../host/mail/remote');
    const raw = await remote.buildRaw({ from: 'sender@fixture.invalid',
      to: [{ name: 'Last, "First" Ω', address: 'a@fixture.invalid' }], cc: 'b@fixture.invalid',
      subject: 'Provider synthetic', text: 'Synthetic body' });
    const parsed = await require('mailparser').simpleParser(raw);
    db.applyFolderSync('a', 'INBOX', fixture.report([fixture.message(200, {
      id: 'imap-formatted', to: remote.formatList(parsed.to.value), cc: remote.formatList(parsed.cc.value),
    })]));
    assert.ok(ids(await ask(scope)).includes('imap-formatted'));
    for (const [id, name, address, expected] of [
      ['imap-angle-name', 'Owner <a@fixture.invalid>', 'other@fixture.invalid', false],
      ['imap-angle-recipient', 'Name <other@fixture.invalid>', 'a@fixture.invalid', true],
    ]) {
      db.applyFolderSync('a', 'INBOX', fixture.report([fixture.message(expected ? 203 : 202, { id,
        to: remote.formatList([{ name, address }]),
      })]));
      assert.equal(ids(await ask(scope)).includes(id), expected, 'the production display name cannot become recipient evidence');
    }
    const api = require('../host/mail/provider-api');
    const graph = await api.searchGraph('synthetic-fixture-token', 'provider', 10, async () => new Response(JSON.stringify({ value: [
      { id: 'graph-result', subject: 'Provider synthetic', toRecipients: [{ emailAddress: { name: 'Last, First Ω', address: 'a@fixture.invalid' } }] },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    db.applyFolderSync('a', 'INBOX', fixture.report([fixture.message(201, { id: 'graph-formatted', to: graph[0].to })]));
    assert.ok(ids(await ask(scope)).includes('graph-formatted'));
    db.updateAccountLogin('a', { ...fixture.account, profile: 'gmail', authKind: 'oauth2' });
    db.enableGmail('a');
    db.replaceFolders('a', [{ path: 'INBOX', name: 'Inbox', wellKnown: 'inbox', providerId: 'INBOX' }]);
    const session = require('../host/mail/gmail-session').createSession(db.accountById('a'), '', { api: {} });
    const gmail = require('./gmail-fixture').message('gmail-to-me');
    gmail.payload.headers.find(header => header.name === 'To').value = '"Last, First Ω" <a@fixture.invalid>';
    const adopted = await session.adopt(gmail, { full: true });
    assert.ok(ids(await ask(scope)).some(id => db.messageById(id)?.gmail_id === adopted.providerId));
    db.removeAccount('a');
    assert.equal((await ask(scope)).total, 0);
  });
});

test('To Me toggles preserve filters and keyboard focus, retire stale pages and update rendered help', async t => {
  const dom = new JSDOM(fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8'), { url: 'https://fixture.invalid' });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window;
  window.morrow = { invoke: async () => null, on() {} };
  window.morrowMailColumns = require('../shared/mail-columns');
  window.morrowFeaturesCatalog = require('../renderer/features-catalog');
  const ui = renderer({ window, document, localStorage: window.localStorage, Event: window.Event, Node: window.Node });
  ui.run(`
    state.accounts=[{id:'a',email:'a@fixture.invalid',folders:{primary:[{id:'INBOX',name:'Inbox',wellKnownName:'inbox',chip:true}],more:[]}}];
    state.accountId='a';state.folderId='INBOX';state.listOffset=200;
    state.listCursors=[{offset:200,cursor:{id:'old'}}];state.listSort={sortBy:'subject',sortDirection:'asc'};
    state.selectedIds=['old'];state.selectionAnchor='old';$('list-filter').value='Keep';
    globalThis.calls=[];call=async(channel,params)=>{calls.push({channel,params});return {emails:[],total:0}};
    offerChangelog=async()=>{};wireSelection();renderList();
  `);
  let chip = document.querySelector('[data-filter="to-me"]');
  assert.equal(chip.textContent, 'To Me'); assert.equal(chip.getAttribute('aria-pressed'), 'false');
  chip.focus(); chip.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(document.activeElement, chip); assert.equal(chip.getAttribute('aria-pressed'), 'true');
  assert.equal(ui.run('calls.at(-1).params.filterToMe'), true);
  assert.equal(ui.run('calls.at(-1).params.sortBy'), 'subject');
  assert.equal(ui.run('state.listOffset'), 0); assert.equal(ui.run('state.listCursors.length'), 0);
  assert.equal(ui.run('state.selectedIds.length'), 0); assert.equal(document.getElementById('list-filter').value, 'Keep');
  assert.equal(ui.run('state.folderId'), 'INBOX');
  for (const aggregateView of ['', 'unread', 'starred']) {
    ui.context.aggregateView = aggregateView;
    assert.equal(ui.run('mailListRequest({allInbox:true,toMeOnly:true,aggregateView}).params.filterToMe'), true);
  }
  ui.run(`state.allInbox=true;state.allInboxUnreadOnly=true;state.prefs.chips=false;renderList()`);
  chip = document.querySelector('[data-filter="to-me"]'); assert.ok(chip);
  assert.equal(chip.getAttribute('aria-pressed'), 'true');
  ui.run(`state.query='needle';state.searchAccountId='a'`); await ui.run('loadList(false)');
  assert.equal(ui.run('calls.at(-1).channel'), 'mail:searchLocal');
  assert.equal(ui.run('calls.at(-1).params.filterToMe'), true);
  assert.equal(ui.run('calls.at(-1).params.accountId'), 'a');
  ui.run(`state.query='';state.outbox=true;renderList()`);
  assert.equal(document.querySelector('[data-filter="to-me"]').hidden, true);
  ui.run(`state.outbox=false;state.allInbox=false;state.prefs.chips=true;renderList()`);
  assert.equal(document.querySelector('[data-filter="to-me"]').hidden, false);
  ui.run('showFeatures()');
  const help = document.getElementById('features-catalog').textContent;
  assert.match(help, /To Me filter/); assert.match(help, /Cc-only, Bcc-only/);
  assert.match(help, /before paging and before search's 100-result limit/);
});
