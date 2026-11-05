// Production parser, cache, renderer and send gates; synthetic providers only.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { message, server } = require('./gmail-fixture');
const fixture = require('./mail-performance-fixture');
const { renderer } = require('./check-ux-workflows');
const { JSDOM } = require('jsdom');

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-reply-backfill-'));
  const previous = { ...process.env }, oldFetch = global.fetch;
  const env = { MORROW_MAIL_DIR: directory, MORROW_USER_DATA: directory, MORROW_MAIL_SECRETS: 'memory', MORROW_GMAIL_PACE: '0' };
  Object.assign(process.env, env);
  global.fetch = async () => { throw new Error('Live network is forbidden in this fixture'); };
  const db = require('../host/mail/db'), engine = require('../host/mail/engine');
  const identity = require('../host/mail/compose-identity'), oldSendingFrom = identity.sendingFrom;
  identity.sendingFrom = async (account, from) => from || account.email;
  let outcome = 'success';
  engine.setSmtpSenderForTest(async ({ messageId }) => {
    if (outcome === 'rejected') throw Object.assign(new Error('Synthetic refusal'), { operationIssued: false });
    if (outcome === 'unknown') throw new Error('Synthetic connection loss');
    return { messageId, accepted: [outcome === 'incomplete' ? 'other@fixture.invalid' : 'recipient@fixture.invalid'],
      rejected: outcome === 'partial' ? ['failed@fixture.invalid'] : [] };
  });
  t.after(async () => {
    engine.setSmtpSenderForTest(null); identity.sendingFrom = oldSendingFrom; global.fetch = oldFetch;
    await db.close();
    for (const key of Object.keys(env)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await engine.init();
  for (const id of ['a', 'b']) {
    db.insertAccount({ ...fixture.account, id, profile: 'gmail', authKind: 'oauth2' }); db.enableGmail(id);
  }
  const service = server([]);
  const session = (options = {}) => require('../host/mail/gmail-session').createSession(db.accountById('a'), 'synthetic-token', { api: service.api(), ...options });
  for (const id of ['a', 'b']) {
    db.replaceFolders(id, (await session().folders()).folders);
    db.gmailSyncState(id, '[Gmail]/Sent Mail', { complete: true, horizonDays: null, historyId: '100' });
  }
  const row = (id, account = 'a') => db.gmailCopies(account, id).find(r => r.folder_path === 'INBOX') || db.gmailCopies(account, id)[0];
  const ask = async (channel, params) => {
    const result = await engine.answer(channel, [params]); assert.equal(result.success, true, JSON.stringify(result)); return result.data;
  };
  async function original(id, rfc = `<${id}@fixture.invalid>`) {
    const source = message(id);
    if (rfc == null) source.payload.headers = source.payload.headers.filter(h => h.name !== 'Message-ID');
    else source.payload.headers.find(h => h.name === 'Message-ID').value = rfc;
    await session().adopt(source); return row(id);
  }
  async function legacy(id, parent, source = message(id, ['SENT'])) {
    source.payload.headers.push({ name: 'In-Reply-To', value: parent }); service.messages.set(id, source);
    const normalized = await session().adopt(source, { cache: false });
    // Equivalent to a pre-feature cache: provider identity and headers present,
    // but no MIME inspection proof. Do not infer while creating this fixture.
    db.applyGmailMessage('a', ['[Gmail]/Sent Mail', '[Gmail]/All Mail'], { ...normalized, replyInferenceEligible: undefined });
    return db.gmailCopies('a', id).find(r => r.folder_path === '[Gmail]/Sent Mail');
  }
  const reads = () => service.calls.filter(c => /^\/messages\/[^/]+$/.test(c.route) && c.method === 'GET');
  return { db, engine, service, session, row, ask, original, legacy, reads, outcome: value => { outcome = value; }, sent: '[Gmail]/Sent Mail' };
}

test('headerless local Reply and Reply All use the exact provider source through renderer, acceptance, queue and restart', async t => {
  const f = await setup(t), { db, engine } = f;
  const dom = new JSDOM(fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8')); t.after(() => dom.window.close());
  const ui = renderer({ document: dom.window.document });
  for (const kind of ['reply', 'all']) {
    const id = 'local-' + kind, target = await f.original(id, null);
    ui.context.email = (await f.ask('mail:openEmail', { emailId: target.id, includeThread: false })).email;
    ui.context.kind = kind;
    const seed = ui.run('composeSeed(email, kind, "owner@fixture.invalid")');
    assert.equal(seed.inReplyTo, undefined);
    await f.ask('mail:send', { ...seed, to: 'recipient@fixture.invalid', body: '<p>Synthetic reply</p>' });
    assert.equal(f.row(id).replied, 1);
    const listed = (await f.ask('mail:listFromCache', { accountId: 'a', folderId: 'INBOX' })).emails.find(r => r.id === target.id);
    ui.context.listed = listed;
    assert.equal(ui.run('mailReplyForwardCell(listed).querySelectorAll("[data-state=replied]").length'), 1);
    await f.session().adopt(message(id, ['INBOX'])); assert.equal(f.row(id).replied, 1, 'later header refresh keeps provider-scoped proof');
  }
  for (const outbox of [false, true]) {
    const target = await f.original('queued-' + outbox, null);
    const queued = await f.ask('mail:scheduleSend', { accountId: 'a', sourceMessageId: target.id, kind: 'reply',
      to: 'recipient@fixture.invalid', body: '<p>Queued reply</p>', outbox, sendAt: new Date(Date.now() + (outbox ? 30000 : 60000)).toISOString() });
    assert.equal(f.row('queued-' + outbox).replied, null);
    await db.close(); await engine.init();
    db.setScheduledSendAt(queued.id, 0); await engine.pumpScheduled();
    assert.equal(f.row('queued-' + outbox).replied, 1);
  }
  const target = await f.original('draft-reply', null);
  const draft = await f.ask('mail:upsertDraft', { accountId: 'a', sourceMessageId: target.id, kind: 'reply',
    to: 'recipient@fixture.invalid', body: '<p>Draft reply</p>' });
  assert.ok(db.messageById(draft.emailId).disposition_json);
  await db.close(); await engine.init();
  await f.ask('mail:send', { accountId: 'a', draftId: draft.emailId, kind: 'new', to: 'recipient@fixture.invalid', body: '<p>Draft reply</p>' });
  assert.equal(f.row('draft-reply').replied, 1);
});

test('headerless capture retains acceptance, account, incarnation, provider binding and parent guards', async t => {
  const f = await setup(t), { db } = f;
  for (const outcome of ['rejected', 'unknown', 'partial', 'incomplete']) {
    const target = await f.original(outcome, null); f.outcome(outcome);
    await f.engine.answer('mail:send', [{ accountId: 'a', sourceMessageId: target.id, kind: 'reply', to: 'recipient@fixture.invalid', body: '<p>Unconfirmed</p>' }]);
    assert.equal(f.row(outcome).replied, null, outcome);
  }
  f.outcome('success');
  const target = await f.original('guarded', null), input = { sourceMessageId: target.id, kind: 'reply' };
  assert.equal(db.captureDisposition('b', input), null);
  assert.equal(db.captureDisposition('a', { ...input, inReplyTo: '<other@fixture.invalid>' }), null);
  for (const patch of [{ uid_validity: target.uid_validity + 1 }, { uid: target.uid + 999 }, { gmail_id: 'unbound' }, { is_draft: 1 }]) {
    db.updateMessage(target.id, patch); assert.equal(db.captureDisposition('a', input), null);
    db.updateMessage(target.id, { uid_validity: target.uid_validity, uid: target.uid, gmail_id: target.gmail_id, is_draft: 0 });
  }
  const proof = db.captureDisposition('a', input); assert.ok(proof);
  db.removeAccount('a');
  db.insertAccount({ ...fixture.account, id: 'a', profile: 'gmail', authKind: 'oauth2' }); db.enableGmail('a');
  db.replaceFolders('a', (await f.session().folders()).folders); await f.original('guarded', null);
  db.confirmDisposition('a', proof); assert.equal(f.row('guarded').replied, null, 'old captured send cannot mark a reconnected mailbox');
});

test('legacy Sent repair is bounded, durable, quiet and scoped to already-cached candidates', async t => {
  const f = await setup(t);
  for (let n = 0; n < 7; n++) { await f.original('parent-' + n); await f.legacy('sent-' + n, `<parent-${n}@fixture.invalid>`); }
  await f.original('unanswered');
  const revision = f.db.mailInvalidations(0).revision;
  const first = await f.session().sync(f.sent);
  assert.equal(f.reads().length, 2); assert.equal(first.bootstrapped, false); assert.deepEqual(first.arrivals, []);
  assert.equal(Array.from({ length: 7 }, (_, n) => f.row('parent-' + n).replied).filter(v => v === 1).length, 2);
  assert.ok(f.db.mailInvalidations(revision).scopes.some(s => s.account_id === 'a' && s.folder_path === 'INBOX'));
  const committed = f.reads().map(r => r.route);
  await f.db.close(); await f.engine.init();
  await f.session().sync(f.sent);
  assert.equal(f.reads().length, 4); assert.ok(f.reads().slice(2).every(r => !committed.includes(r.route)));
  await f.session().sync(f.sent); const last = await f.session().sync(f.sent);
  assert.equal(last.bootstrapped, true); assert.equal(f.reads().length, 7);
  await f.session().sync(f.sent); assert.equal(f.reads().length, 7, 'completed repair makes no repeated full reads');
  assert.equal(f.row('unanswered').replied, null);
  assert.ok(f.service.calls.every(c => c.method === 'GET' && (c.route === '/labels' || c.route === '/history' || /^\/messages\/[^/]+$/.test(c.route))), 'no mailbox scan, attachment read or provider write');
});

test('repair shares the twenty-read budget with pending sync and yields for foreground work and deadlines', async t => {
  const f = await setup(t);
  for (let n = 0; n < 3; n++) { await f.original('budget-parent-' + n); await f.legacy('budget-sent-' + n, `<budget-parent-${n}@fixture.invalid>`); }
  const ids = Array.from({ length: 20 }, (_, n) => 'pending-' + n);
  for (const id of ids) f.service.messages.set(id, message(id, ['SENT']));
  f.db.gmailSyncState('a', f.sent, { complete: true, horizonDays: null, historyId: '100', pending: { kind: 'history', ids, offset: 0, nextPageToken: '', historyId: '101' } });
  await f.session().sync(f.sent, { deadline: Date.now() - 1 }); await f.session().sync(f.sent, { shouldYield: () => true });
  assert.equal(f.reads().length, 0);
  let waiting = false;
  const api = f.service.api(), getMessage = api.getMessage;
  api.getMessage = async id => { const value = await getMessage(id); waiting = true; return value; };
  await f.session({ api }).sync(f.sent, { shouldYield: () => waiting });
  assert.equal(f.reads().length, 1); assert.equal(f.db.gmailSyncState('a', f.sent).pending.offset, 0);
  const before = f.reads().length; await f.session().sync(f.sent);
  assert.equal(f.reads().length - before, 20); assert.equal(f.db.gmailSyncState('a', f.sent).pending.offset, 18);
  await f.session().sync(f.sent); assert.equal(f.db.gmailSyncState('a', f.sent).historyId, '101');
});

test('offline and quota failures preserve uninspected candidates and resume after a process-equivalent reopen', async t => {
  const f = await setup(t);
  for (let n = 0; n < 4; n++) { await f.original('retry-parent-' + n); await f.legacy('retry-sent-' + n, `<retry-parent-${n}@fixture.invalid>`); }
  const { createGmailMailApi } = require('../host/mail/gmail-mail-api');
  for (const mode of ['offline', 'quota']) {
    let attempts = 0;
    const api = createGmailMailApi({ accessToken: async () => 'synthetic', fetchImpl: async (input, options) => {
      if (/\/messages\/[^/]+$/.test(new URL(input).pathname) && ++attempts === 2) {
        if (mode === 'offline') throw new Error('Synthetic offline');
        return new Response(JSON.stringify({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }), { status: 429, headers: { 'Retry-After': '60' } });
      }
      return f.service.fetcher(input, options);
    } });
    await assert.rejects(f.session({ api }).sync(f.sent), e => e.code === (mode === 'offline' ? 'provider_network' : 'rate_limit') && (mode !== 'quota' || e.retryAfterMs === 60000));
    assert.equal(attempts, 2, 'the repair does not retry a rejected read in a loop');
    await f.db.close(); await f.engine.init();
  }
  assert.equal(f.db.gmailReplyBackfillPage('a', f.sent).length, 2);
  await f.session().sync(f.sent); assert.equal(f.db.gmailReplyBackfillPage('a', f.sent).length, 0);
  assert.equal(new Set(f.reads().map(r => r.route)).size, 4, 'already committed candidates are not fetched again');
});

test('repair excludes reaction and malformed MIME, duplicate identities, drafts, incoming mail and thread guesses', async t => {
  const f = await setup(t);
  for (const nested of [false, true]) {
    const name = 'reaction-' + nested; await f.original(name);
    const child = message('sent-' + name, ['SENT']);
    const part = { mimeType: 'text/vnd.google.email-reaction+json', body: { data: Buffer.from('{}').toString('base64url') } };
    if (nested) { child.payload.mimeType = 'multipart/mixed'; child.payload.parts = [{ mimeType: 'multipart/alternative', parts: [part, { mimeType: 'text/plain', body: { data: 'ZmFsbGJhY2s' } }] }]; }
    else Object.assign(child.payload, part);
    await f.legacy(child.id, `<${name}@fixture.invalid>`, child);
  }
  await f.original('malformed'); const malformed = message('sent-malformed', ['SENT']); malformed.payload.body.data = 'invalid!';
  await f.legacy(malformed.id, '<malformed@fixture.invalid>', malformed);
  await f.original('duplicate'); await f.original('other-delivery', '<duplicate@fixture.invalid>'); await f.legacy('sent-duplicate', '<duplicate@fixture.invalid>');
  await f.original('references'); const refs = message('sent-references', ['SENT']); refs.payload.headers.push({ name: 'References', value: '<references@fixture.invalid>' });
  await f.session().adopt(refs);
  await f.original('draft-parent'); const draft = message('draft-child', ['SENT', 'DRAFT']); await f.legacy(draft.id, '<draft-parent@fixture.invalid>', draft);
  await f.original('incoming-parent'); const incoming = message('incoming-child', ['INBOX']);
  incoming.payload.headers.push({ name: 'In-Reply-To', value: '<incoming-parent@fixture.invalid>' }); await f.session().adopt(incoming);
  await f.session().sync(f.sent); await f.session().sync(f.sent);
  for (const name of ['reaction-false', 'reaction-true', 'malformed', 'duplicate', 'other-delivery', 'references', 'draft-parent', 'incoming-parent']) assert.equal(f.row(name).replied, null, name);
  for (const name of ['reaction-false', 'reaction-true', 'malformed']) assert.equal(f.row('sent-' + name).reply_inference_eligible, 0);
  assert.equal(f.db.gmailReplyBackfillPage('a', f.sent).length, 0);
  const count = f.reads().length; await f.session().sync(f.sent); assert.equal(f.reads().length, count, 'excluded MIME is durably inspected');
});

test('provider identity mismatch and a stale in-flight account cannot publish repair evidence', async t => {
  const f = await setup(t);
  await f.original('identity-parent'); const target = await f.legacy('identity-sent', '<identity-parent@fixture.invalid>');
  const wrong = f.service.api(); wrong.getMessage = async () => message('different-provider', ['SENT']);
  await assert.rejects(f.session({ api: wrong }).sync(f.sent), e => e.code === 'gmail_identity_ambiguous');
  assert.equal(f.row('identity-parent').replied, null); assert.equal(f.row('identity-sent').reply_inference_eligible, null);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const api = f.service.api(), get = api.getMessage;
  api.getMessage = async id => { const data = await get(id); entered(); await held; return data; };
  const pending = f.session({ api }).sync(f.sent); await waiting;
  f.db.removeAccount('a'); f.db.insertAccount({ ...fixture.account, id: 'a', profile: 'gmail', authKind: 'oauth2' }); f.db.enableGmail('a');
  f.db.replaceFolders('a', (await f.session().folders()).folders); await f.original('identity-parent');
  release(); await assert.rejects(pending, e => e.code === 'account_removed');
  assert.equal(f.row('identity-parent').replied, null); assert.equal(f.db.messageById(target.id), null);
});

test('repair acknowledgement and inferred flags roll back together; 404 removes only the missing provider copies', async t => {
  const f = await setup(t);
  await f.original('atomic-parent'); await f.legacy('atomic-sent', '<atomic-parent@fixture.invalid>');
  const apply = f.db.applyGmailMessage;
  f.db.applyGmailMessage = (...args) => { apply(...args); throw new Error('Synthetic transaction failure'); };
  try { await assert.rejects(f.session().sync(f.sent), /Synthetic transaction failure/); }
  finally { f.db.applyGmailMessage = apply; }
  assert.equal(f.row('atomic-parent').replied, null); assert.equal(f.row('atomic-sent').reply_inference_eligible, null);
  await f.session().sync(f.sent); assert.equal(f.row('atomic-parent').replied, 1);
  await f.original('missing-parent'); await f.legacy('missing-sent', '<missing-parent@fixture.invalid>');
  f.service.messages.delete('missing-sent');
  await f.session().sync(f.sent);
  assert.equal(f.db.gmailCopies('a', 'missing-sent').length, 0); assert.equal(f.row('missing-parent').replied, null);
  assert.equal(f.row('atomic-parent').replied, 1); assert.equal(f.db.gmailReplyBackfillPage('a', f.sent).length, 0);
});

test('held removals and pending edits are retained without starving other cached Sent candidates', async t => {
  const f = await setup(t);
  await f.original('free-parent'); await f.legacy('free-sent', '<free-parent@fixture.invalid>');
  const held = [];
  for (let n = 0; n < 21; n++) {
    await f.original('held-parent-' + n); const row = await f.legacy('held-sent-' + n, `<held-parent-${n}@fixture.invalid>`);
    const id = 'held-action-' + n; held.push(id);
    f.db.insertMailAction({ id, batchId: id, messageId: row.id, accountId: 'a', generation: 1,
      intentJson: JSON.stringify({ kind: 'remove' }), priorJson: '{}', sourceJson: '{}',
      phase: n % 2 ? 'accepted' : 'closed', receipt: n % 2 ? null : 'unknown', createdAt: n + 1 });
    assert.equal(f.db.messageHeld(row.id), true);
  }
  await f.original('pending-parent'); const edited = await f.legacy('pending-sent', '<pending-parent@fixture.invalid>');
  f.db.updateMessage(edited.id, { draft_pending: 1 });
  await f.session().sync(f.sent);
  assert.equal(f.reads().length, 1); assert.equal(f.row('free-parent').replied, 1);
  assert.equal(f.row('pending-parent').replied, null);
  for (let n = 0; n < 21; n++) { assert.equal(f.row('held-parent-' + n).replied, null); assert.equal(f.row('held-sent-' + n).reply_inference_eligible, null); }
  for (const id of held) f.db.updateMailAction(id, { phase: 'closed', receipt: 'not_attempted' });
  f.db.updateMessage(edited.id, { draft_pending: 0 });
  await f.session().sync(f.sent);
  assert.equal(f.reads().length, 3); assert.equal(f.row('pending-parent').replied, 1, 'deferred work resumes when its edit is released');
});
