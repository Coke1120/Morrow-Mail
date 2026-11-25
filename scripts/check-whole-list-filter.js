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
    db.replaceFolders(id, [...fixture.folders,
      { path: '[Gmail]/Drafts', name: 'Unsent', wellKnown: 'drafts' },
      { path: 'Custom/Drafts', name: 'Drafts', wellKnown: null },
      { path: 'Old Drafts', name: 'Old Drafts', wellKnown: 'draft' },
    ]);
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
  await t.test('a short first page proves the literal total and oldest date in one scan', async t => {
    const summaries = t.mock.method(db, 'messageSummary');
    const scoped = { ...scope, filterUnread: true, retainIds: ['a-648'], sortBy: 'subject' };
    for (const [term, ids, oldest] of [
      ['nothing here', [], null],
      ['final-unique', ['a-649'], 100000 - 649],
      ['Match 064', ['a-649','a-648','a-647','a-645','a-643','a-641'], 100000 - 649],
    ]) {
      const page = await ask({ ...scoped, listFilter: term });
      assert.deepEqual(page.emails.map(row => row.id), ids);
      assert.equal(page.total, ids.length);
      assert.equal(page.syncedOldestDateTs, oldest);
      assert.equal(page.hasMoreInCache, false);
    }
    assert.equal(summaries.mock.callCount(), 0);
    const full = await ask(match);
    assert.equal(full.total, 420);
    assert.ok(summaries.mock.callCount() > 0, 'a full first page still needs an exact count');
  });
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

  const target = 'approval%_team@fixture.invalid';
  const drafts = { ...scope, folderId: '[Gmail]/Drafts' };
  const draftRows = Array.from({ length: 206 }, (_, i) => fixture.message(i + 1, {
    id: `draft-${i}`, subject: 'Purchase order', snippet: '', isDraft: true, listSortTs: 1000 - i,
    from: 'a@fixture.invalid', fromAddress: 'a@fixture.invalid',
    to: i === 205 ? ['supplier@fixture.invalid', { name: 'Équipe approbation', address: target }, 'a@fixture.invalid'] : [],
    cc: [target], bcc: [target], recipientHeaders: { replyTo: [target] },
  }));
  db.applyFolderSync('a', drafts.folderId, fixture.report(draftRows));
  for (const [accountId, folderPath, id] of [
    ['b', drafts.folderId, 'other-account-draft'], ['a', 'Custom/Drafts', 'ordinary-folder-draft'],
    ['a', 'Old Drafts', 'other-folder-draft'],
  ]) db.applyFolderSync(accountId, folderPath, fixture.report([{
    ...draftRows[205], id,
  }]));
  const openDraft = async (emailId, accountId = 'a') => {
    const result = await engine.answer('mail:openEmail', [{ emailId, accountId, full: true, includeThread: false }]);
    assert.equal(result.success, true, JSON.stringify(result.error));
    return result.data.email;
  };

  await t.test('finds the later To entry from page two before count and sorting', async () => {
    assert.equal((await ask(drafts)).total, 206);
    assert.ok((await ask({ ...drafts, offset: 200 })).emails.some(row => row.id === 'draft-205'));
    for (const listFilter of [target.toUpperCase(), 'équipe approbation', '%_']) {
      const result = await ask({ ...drafts, listFilter, sortBy: 'subject' });
      assert.equal(result.total, 1);
      assert.deepEqual(result.emails.map(row => row.id), ['draft-205']);
    }
    assert.equal((await ask({ ...drafts, listFilter: target, filterToMe: true })).total, 1);
    assert.equal((await ask({ ...drafts, listFilter: 'approvalXXteam' })).total, 0);
    const opened = await openDraft('draft-205');
    const expectedTo = ['supplier@fixture.invalid', 'Équipe approbation <' + target + '>', 'a@fixture.invalid'];
    assert.deepEqual(
      [(await ask({ ...drafts, listFilter: target })).emails[0].to, opened.to],
      [expectedTo, expectedTo],
    );
    assert.deepEqual((await openDraft('ordinary-folder-draft')).to, draftRows[205].to, 'custom-folder detail keeps its existing representation');
    // The compose field joins the hydrated entries, and explicit Save submits that text.
    const saved = await engine.answer('mail:upsertDraft', [{
      emailId: opened.id, accountId: opened.accountId, draftRevision: opened.draftRevision,
      fromAddress: opened.fromAddress, fromDisplayName: opened.fromDisplayName,
      threadId: opened.threadId, subject: opened.subject, body: '<p>Body-only edit</p>',
      to: opened.to.join(', '), cc: opened.cc.join(', '), bcc: opened.bcc.join(', '),
    }]);
    assert.deepEqual(
      [saved.success, saved.data?.remoteSaved, JSON.parse(db.messageById(opened.id).to_json)],
      [true, false, [expectedTo.join(', ')]],
      saved.error?.message || 'local Save preserves the hydrated addresses and names',
    );
  });

  await t.test('scopes To to the selected system folder and refreshes counts after To edits', async () => {
    const lookup = { ...drafts, listFilter: target };
    assert.equal((await ask({ ...lookup, folderId: 'Custom/Drafts', includeDraftTo: true })).total, 0);
    assert.equal((await ask({ ...lookup, folderKey: 'drafts' })).total, 0);
    assert.equal((await ask({ ...lookup, accountId: 'b' })).emails[0].id, 'other-account-draft');
    assert.equal((await ask({ ...lookup, folderId: 'Old Drafts' })).emails[0].id, 'other-folder-draft');
    const legacyTo = ['Legacy Approver <' + target + '>'];
    db.updateMessage('draft-205', { to_json: JSON.stringify(legacyTo[0]) });
    assert.deepEqual(
      [(await ask(lookup)).emails[0].to, (await openDraft('draft-205')).to],
      [legacyTo, legacyTo],
    );
    db.updateMessage('draft-205', { to_json: '[null, {"label":"approval%_team@fixture.invalid"}, {"address":7}]' });
    assert.equal((await ask(lookup)).total, 0, 'Cc, Bcc, Reply-To and unrecognized To fields do not match');
    assert.equal((await ask({ ...lookup, listFilter: 'address' })).total, 0, 'serialized keys do not match');
    db.updateMessage('draft-205', { to_json: 'invalid json' });
    assert.equal((await ask({ ...lookup, listFilter: '  ', sortBy: 'recipient' })).total, 206);
    assert.equal((await ask({ ...lookup, listFilter: 'purchase order', sortBy: 'recipient' })).total, 206);
    db.updateMessage('draft-205', { subject: 'Recipient sort' });
    for (const [id, to] of [
      ['draft-0', ['A <' + target + '>']],
      ['draft-1', 'Z <' + target + '>'],
      ['draft-2', [null, ' ', { label: 'Ignore' }, { name: 'Review', email: target }, 'aaa@fixture.invalid']],
      ['draft-11', ['Review <' + target + '>, later@fixture.invalid']],
    ]) db.updateMessage(id, { subject: 'Recipient sort', to_json: JSON.stringify(to) });
    const sort = { ...drafts, listFilter: 'recipient sort', sortBy: 'recipient' };
    const ascending = await ask({ ...sort, sortDirection: 'asc' });
    const descending = await ask({ ...sort, sortDirection: 'desc' });
    assert.deepEqual(
      [ascending.emails.map(row => row.id), descending.emails.map(row => row.id)],
      [['draft-205', 'draft-0', 'draft-11', 'draft-2', 'draft-1'], ['draft-1', 'draft-2', 'draft-11', 'draft-0', 'draft-205']],
    );
    assert.deepEqual(
      [(await ask({ ...lookup, listFilter: 'review <' + target + '>' })).emails.find(row => row.id === 'draft-2')?.to,
        (await openDraft('draft-2')).to, (await openDraft('draft-0')).to, (await openDraft('draft-205')).to],
      [['Review <' + target + '>', 'aaa@fixture.invalid'],
        ['Review <' + target + '>', 'aaa@fixture.invalid'], ['A <' + target + '>'], []],
    );
    db.updateMessage('draft-2', { to_json: JSON.stringify([{ name: 'Review, Jane', address: target }]) });
    assert.deepEqual((await openDraft('draft-2')).to, ['"Review, Jane" <' + target + '>']);
  });
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
