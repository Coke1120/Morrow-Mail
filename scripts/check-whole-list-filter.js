// Synthetic downloaded cache and archives only. Never connects to a provider.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const fixture = require('./mail-performance-fixture');
const L = require('../host/mail/local-folders');

test('literal list filter runs before count/sort/pagination in every downloaded scope', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-list-filter-'));
  const previous = { ...process.env };
  const env = { MORROW_MAIL_DIR: dir, MORROW_USER_DATA: dir, MORROW_MAIL_SECRETS: 'memory' };
  Object.assign(process.env, env);
  const db = require('../host/mail/db'), engine = require('../host/mail/engine');
  t.after(async () => { await db.close(); for (const key of Object.keys(env)) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  } fs.rmSync(dir, { recursive: true, force: true }); });
  await engine.init();
  for (const id of ['a', 'b']) {
    db.insertAccount({ ...fixture.account, id, email: `${id}@fixture.invalid` });
    db.replaceFolders(id, fixture.folders);
  }
  const rows = Array.from({ length: 650 }, (_, i) => fixture.message(i + 1, {
    id: `a-${i}`, subject: i >= 230 ? `Match ${String(i).padStart(4, '0')}` : `Other ${i}`,
    snippet: i === 649 ? 'ÉLODIE 100%_literal final-unique' : '',
    from: 'sender@fixture.invalid', fromDisplayName: '', to: [i % 2 ? 'a@fixture.invalid' : 'other@fixture.invalid'],
    listSortTs: 100000 - i, unread: i % 2 === 1, starred: i % 3 === 0, bodyComplete: true,
  }));
  db.applyFolderSync('a', 'INBOX', fixture.report(rows));
  db.applyFolderSync('a', 'Archive', fixture.report([fixture.message(900, { id: 'archive', subject: 'Match archive', bodyComplete: true })]));
  db.applyFolderSync('b', 'INBOX', fixture.report([fixture.message(900, { id: 'b', subject: 'Match other mailbox', bodyComplete: true })]));
  const ask = async params => { const result = await engine.answer('mail:listFromCache', [params]);
    assert.equal(result.success, true, JSON.stringify(result.error)); return result.data; };
  const scope = { accountId: 'a', folderId: 'INBOX', limit: 200 };
  const match = { ...scope, listFilter: '  MATCH  ' };
  const first = await ask(match), second = await ask({ ...match, offset: 200 }), third = await ask({ ...match, offset: 400 });
  assert.equal(first.total, 420); assert.equal(first.emails.length, 200); assert.equal(second.emails.length, 200); assert.equal(third.emails.length, 20);
  assert.equal(first.emails[0].id, 'a-230'); assert.equal(second.emails[0].id, 'a-430'); assert.equal(third.emails.at(-1).id, 'a-649');
  assert.equal(new Set([...first.emails, ...second.emails, ...third.emails].map(r => r.id)).size, 420);
  assert.deepEqual((await ask(match)).emails.map(r => r.id), first.emails.map(r => r.id), 'previous page is stable');
  assert.equal(first.nextCursor, null); assert.equal(first.hasMoreInCache, true); assert.equal(third.hasMoreInCache, false);
  const cursor = (await ask(scope)).nextCursor;
  const staleCursor = await ask({ ...match, offset: 200, pageCursor: cursor });
  assert.equal(staleCursor.cursorReset, !!cursor); assert.equal(staleCursor.emails[0].id, 'a-430');
  for (const listFilter of ['final-unique', 'élodie', '100%_literal', '%_', 'sender@fixture.invalid\nélodie']) {
    const result = await ask({ ...scope, listFilter }); assert.equal(result.total, 1, listFilter); assert.equal(result.emails[0].id, 'a-649');
  }
  assert.equal((await ask({ ...scope, listFilter: '100XXliteral' })).total, 0);
  assert.equal((await ask({ ...scope, listFilter: 'nothing here' })).total, 0);
  assert.equal((await ask({ ...scope, listFilter: '' })).total, 650);
  assert.equal((await ask({ ...match, filterUnread: true })).total, 210);
  assert.equal((await ask({ ...match, filterFlagged: true })).total, 140);
  assert.equal((await ask({ ...match, filterToMe: true })).total, 210);
  const retained = await ask({ ...match, filterUnread: true, retainIds: ['a-230'] });
  assert.equal(retained.total, 211); assert.ok(retained.emails.some(r => r.id === 'a-230'));
  assert.equal((await ask({ ...match, filterUnread: true, retainIds: ['a-0'] })).total, 210, 'held rows must also match');
  for (const sortBy of ['date', 'subject', 'sender', 'recipient']) {
    const sorted = await ask({ ...match, sortBy, sortDirection: 'asc' });
    assert.equal(sorted.total, 420); assert.equal(sorted.emails.length, 200);
  }
  assert.equal((await ask({ ...match, sortBy: 'date', sortDirection: 'asc' })).emails[0].id, 'a-649');
  assert.equal((await ask({ folderKey: 'inbox', listFilter: 'match' })).total, 421);
  assert.equal((await ask({ mailboxes: [{ accountId: 'a', path: 'INBOX' }, { accountId: 'b', path: 'INBOX' }], listFilter: 'match' })).total, 421);
  assert.equal((await ask({ ...match, aggregateView: 'starred' })).total, 140);
  for (const patch of [{ subject: 'edited-only' }, { from_addr: 'edited-only' }, { snippet: 'edited-only' }]) {
    const q = { ...scope, listFilter: 'edited-only' }; assert.equal((await ask(q)).total, 0);
    db.updateMessage('a-0', patch); assert.equal((await ask(q)).total, 1, 'content edits invalidate cached counts');
    db.updateMessage('a-0', { subject: 'Other 0', from_addr: 'sender@fixture.invalid', snippet: '' });
    assert.equal((await ask(q)).total, 0);
  }
  db.updateMessage('a-0', { from_address: 'sender@fixture.invalid', from_display_name: 'ЛЮДМИЛА' });
  assert.equal((await ask({ ...scope, listFilter: 'людмила' })).total, 1, 'matches the displayed sender');
  db.updateMessage('a-0', { from_display_name: 'Someone' });
  assert.equal((await ask({ ...scope, listFilter: 'людмила' })).total, 0, 'display-name edits invalidate counts');
  assert.equal((await ask({ ...scope, listFilter: 'someone <updated@fixture.invalid>' })).total, 0);
  db.updateMessage('a-0', { from_address: 'updated@fixture.invalid' });
  assert.equal((await ask({ ...scope, listFilter: 'someone <updated@fixture.invalid>' })).total, 1);
  db.updateMessage('a-0', { subject: 'CafÃ© draft', draft_pending: 1 });
  const renderedDraft = (await ask({ ...scope, limit: 1 })).emails[0];
  assert.equal(renderedDraft.subject, 'Café draft');
  assert.equal((await ask({ ...scope, listFilter: 'café draft' })).total, 1, 'draft filter uses repaired displayed text');
  db.updateMessage('a-0', { draft_pending: 0 });
  assert.equal((await ask({ ...scope, listFilter: 'café draft' })).total, 0, 'draft repair-state edits invalidate counts');

});

test('local folders apply the identical literal filter before counts and bounded pages', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-local-filter-'));
  const store = L.createLocalStore(path.join(dir, 'local.sqlite'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 650; i++) store.save(`source-${i}`, L.ARCHIVE_ID, {
    raw: Buffer.from(`synthetic ${i}`), files: [], body: { textBody: 'body-only' },
    info: { subject: i >= 230 ? `Match ${i}` : `Other ${i}`, from: 'sender@fixture.invalid',
      snippet: i === 649 ? 'ÉLODIE 100%_literal' : '', listSortTs: 100000 - i,
      attachments: [], toMe: i % 2 === 1, hasAttachments: false },
  }, { unread: i % 2 === 1, isStarred: i % 3 === 0 });
  const q = { folderId: L.ARCHIVE_ID, listFilter: 'match', limit: 200 };
  const first = store.list(q), second = store.list({ ...q, offset: 200 }), third = store.list({ ...q, offset: 400 });
  assert.equal(first.total, 420); assert.equal(first.emails.length, 200); assert.equal(second.emails.length, 200); assert.equal(third.emails.length, 20);
  assert.equal(new Set([...first.emails, ...second.emails, ...third.emails].map(r => r.id)).size, 420);
  assert.deepEqual(store.list(q).emails, first.emails);
  assert.equal(store.list({ ...q, listFilter: '  ÉLODIE  ' }).total, 1);
  assert.equal(store.list({ ...q, listFilter: '%_' }).total, 1);
  assert.equal(store.list({ ...q, listFilter: 'body-only' }).total, 0);
  assert.equal(store.list({ ...q, listFilter: '' }).total, 650);
  assert.equal(store.list({ ...q, folderId: L.TRASH_ID }).total, 0);
  assert.equal(store.list({ ...q, filterUnread: true }).total, 210);
  assert.equal(store.list({ ...q, filterFlagged: true }).total, 140);
  assert.equal(store.list({ ...q, filterToMe: true }).total, 210);
  assert.equal(store.list({ ...q, sortDirection: 'asc' }).emails[0].subject, 'Match 649');
});
