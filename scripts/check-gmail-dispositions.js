// Offline regression: production Gmail parser, SQLite persistence, send and queue.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { message, server } = require('./gmail-fixture');
const fixture = require('./mail-performance-fixture');

test('Gmail dispositions use confirmed identities and conservative cached Sent evidence', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-gmail-dispositions-'));
  const previous = { ...process.env };
  const env = { MORROW_MAIL_DIR: dir, MORROW_USER_DATA: dir, MORROW_MAIL_SECRETS: 'memory' };
  Object.assign(process.env, env);
  const db = require('../host/mail/db'), engine = require('../host/mail/engine');
  const identity = require('../host/mail/compose-identity');
  const oldSendingFrom = identity.sendingFrom;
  // No credential access or provider traffic is allowed by this fixture.
  identity.sendingFrom = async (account, from) => from || account.email;
  t.after(async () => {
    engine.setSmtpSenderForTest(null); identity.sendingFrom = oldSendingFrom;
    await db.close(); for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await engine.init();
  for (const id of ['a', 'b']) {
    db.insertAccount({ ...fixture.account, id, profile: 'gmail', authKind: 'oauth2' });
    db.replaceFolders(id, [...fixture.folders.map(folder => ({ ...folder, providerId: folder.wellKnown === 'sentitems' ? 'SENT' : 'INBOX' })), { path: 'Drafts', name: 'Drafts', wellKnown: 'drafts' }, { path: 'Work', name: 'Work' }]);
    db.enableGmail(id);
  }
  const admit = (accountId, providerId, extra = {}, folders = ['INBOX']) => {
    db.applyGmailMessage(accountId, folders, { ...fixture.message(1), id: undefined, providerId,
      replied: null, forwarded: null, rfcMessageId: `<${providerId}@fixture.invalid>`, ...extra });
    return db.gmailCopies(accountId, providerId)[0];
  };
  const read = (id, key = 'replied', account = 'a') => db.gmailCopies(account, id)[0][key];
  const original = admit('a', 'original', {}, ['INBOX', 'Work']);
  admit('b', 'original');
  const fields = { accountId: 'a', to: 'recipient@fixture.invalid', body: '<p>Reply</p>',
    kind: 'reply', sourceMessageId: original.id, inReplyTo: original.rfc_message_id };
  let outcome = 'success', calls = 0;
  engine.setSmtpSenderForTest(async ({ messageId }) => {
    calls++;
    if (outcome === 'rejected') throw Object.assign(new Error('Synthetic refusal'), { operationIssued: false });
    if (outcome === 'unknown') throw new Error('Synthetic connection loss');
    if (outcome === 'incomplete') return { messageId, accepted: ['other@fixture.invalid'], rejected: [] };
    return { messageId, accepted: ['recipient@fixture.invalid'], rejected: outcome === 'partial' ? ['failed@fixture.invalid'] : [] };
  });
  const send = async (params = {}) => engine.answer('mail:send', [{ ...fields, ...params }]);
  for (const mode of ['rejected', 'unknown', 'partial', 'incomplete']) {
    outcome = mode; await send(); assert.equal(read('original'), null, mode);
  }
  outcome = 'success';
  await send({ accountId: 'b' }); assert.equal(read('original'), null, 'cross-account source ignored');
  assert.equal(read('original', 'replied', 'b'), null);
  await send({ inReplyTo: '<wrong@fixture.invalid>' }); assert.equal(read('original'), null, 'parent must agree');
  assert.equal((await send()).success, true);
  assert.ok(db.gmailCopies('a', 'original').every(row => row.replied === 1));
  assert.equal(read('original', 'replied', 'b'), null);
  await send({ kind: 'forward', inReplyTo: undefined }); assert.equal(read('original', 'forwarded'), 1);
  admit('a', 'original', {}, ['INBOX', 'Work']);
  assert.equal(read('original'), 1); assert.equal(read('original', 'forwarded'), 1);
  admit('a', 'original', { replied: false }); assert.equal(read('original'), 0, 'provider false wins');
  admit('a', 'original'); assert.equal(read('original'), 1);
  db.updateMessage(db.gmailCopies('a', 'original')[0].id, { replied: null, forwarded: null }, { disposition: { replied: null, forwarded: null } });
  assert.equal(read('original'), 1); assert.equal(read('original', 'forwarded'), 1, 'body flag refresh retains saved evidence');
  db.pruneGmailCopies('a', 'original', []); admit('a', 'original'); assert.equal(read('original'), 1, 'provider identity survives row replacement');

  for (const [name, rfcMessageId] of [['missing-rfc', null], ['malformed-rfc', 'not-an-rfc-id']]) {
    const target = admit('a', name, { rfcMessageId }, ['INBOX', 'Work']);
    await send({ kind: 'forward', sourceMessageId: target.id, inReplyTo: undefined });
    assert.ok(db.gmailCopies('a', name).every(row => row.forwarded === 1));
    admit('a', name, { rfcMessageId }, ['INBOX', 'Work']);
    assert.ok(db.gmailCopies('a', name).every(row => row.forwarded === 1), name + ' provider identity restores confirmed evidence after sync');
    admit('a', name, { rfcMessageId, forwarded: false });
    assert.equal(read(name, 'forwarded'), 0, 'authoritative false still wins');
    admit('a', name, { rfcMessageId, forwarded: true });
    assert.equal(read(name, 'forwarded'), 1, 'authoritative true still wins');
  }
  for (const outbox of [false, true]) {
    const target = admit('a', `queued-${outbox}`);
    const queued = engine.answer('mail:scheduleSend', [{ ...fields, sourceMessageId: target.id, kind: 'forward',
      inReplyTo: undefined, outbox, sendAt: new Date(Date.now() + (outbox ? 30000 : 60000)).toISOString() }]);
    assert.equal(queued.success, true); assert.equal(read(`queued-${outbox}`, 'forwarded'), null);
    // Durable payload, including proof, must survive process-equivalent reopen.
    await db.close(); await engine.init();
    db.setScheduledSendAt(queued.data.id, 0); await engine.pumpScheduled();
    assert.equal(read(`queued-${outbox}`, 'forwarded'), 1);
  }
  for (const mode of ['cancel', 'rejected', 'unknown']) {
    const target = admit('a', mode);
    const queued = engine.answer('mail:scheduleSend', [{ ...fields, sourceMessageId: target.id,
      inReplyTo: target.rfc_message_id, sendAt: '2099-01-01T00:00:00Z' }]);
    assert.equal(queued.success, true);
    if (mode === 'cancel') assert.equal(engine.answer('mail:cancelScheduled', [{ id: queued.data.id }]).success, true);
    else { outcome = mode; db.setScheduledSendAt(queued.data.id, 0); }
    await engine.pumpScheduled(); assert.equal(read(mode), null, mode + ' queue');
  }
  outcome = 'success';
  const draftTarget = admit('a', 'draft-target');
  const saved = await engine.answer('mail:upsertDraft', [{ ...fields, kind: 'forward', sourceMessageId: draftTarget.id, inReplyTo: undefined }]);
  assert.equal(saved.success, true); assert.equal(saved.data.remoteSaved, false);
  assert.ok(db.messageById(saved.data.emailId).disposition_json);
  await db.close(); await engine.init();
  await send({ draftId: saved.data.emailId, sourceMessageId: undefined, kind: 'new', inReplyTo: undefined });
  assert.equal(read('draft-target', 'forwarded'), 1, 'resumed local draft retains proof');

  // Production Gmail MIME parser: nested/single reactions are never replies.
  const service = server([]);
  const session = require('../host/mail/gmail-session').createSession(db.accountById('a'), 'synthetic', { api: service.api() });
  for (const nested of [false, true]) {
    const name = `reaction-${nested}`, target = admit('a', name);
    const reaction = message(`sent-${name}`, ['SENT']);
    reaction.payload.headers.push({ name: 'In-Reply-To', value: target.rfc_message_id });
    const part = { mimeType: 'text/vnd.google.email-reaction+json', body: { data: Buffer.from('{"emoji":"🙂","version":1}').toString('base64url') } };
    if (nested) { reaction.payload.mimeType = 'multipart/related'; reaction.payload.parts = [{ mimeType: 'multipart/alternative', parts: [part, { mimeType: 'text/plain', body: { data: Buffer.from('Reaction fallback').toString('base64url') } }] }]; }
    else Object.assign(reaction.payload, part);
    await session.adopt(reaction); assert.equal(read(name), null);
  }
  // Sent-first and target-first; only exact unique RFC identity is sufficient.
  admit('a', 'sent-first', { inReplyTo: '<later@fixture.invalid>', replyInferenceEligible: true }, ['Sent']);
  admit('a', 'later'); assert.equal(read('later'), 1);
  db.pruneGmailCopies('a', 'sent-first', []); admit('a', 'later');
  assert.equal(read('later'), 1, 'inferred evidence survives removing cached Sent rows');
  db.insertMessage({ ...fixture.message(91), id: 'unbound-original', accountId: 'a', folderPath: 'INBOX', rfcMessageId: '<later@fixture.invalid>' });
  admit('a', 'later'); assert.equal(read('later'), null, 'unbound legacy duplicates also make the original ambiguous');
  const history = admit('a', 'history');
  const reply = message('actual-reply', ['SENT']);
  reply.payload.headers.push({ name: 'In-Reply-To', value: history.rfc_message_id });
  await session.adopt(reply); assert.equal(read('history'), 1);
  assert.equal(read('history', 'forwarded'), null);
  admit('b', 'history'); assert.equal(read('history', 'replied', 'b'), null);
  admit('a', 'duplicate', { rfcMessageId: history.rfc_message_id });
  assert.equal(read('history'), null, 'later duplicate suppresses inferred evidence'); assert.equal(read('duplicate'), null);
  for (const [name, extra, folder] of [
    ['incoming', { replyInferenceEligible: true }, 'INBOX'], ['draft', { isDraft: true, replyInferenceEligible: true }, 'Sent'],
    ['legacy', {}, 'Sent'], ['multi', { replyInferenceEligible: true, inReplyTo: '<no@fixture.invalid> <two@fixture.invalid>' }, 'Sent'],
  ]) {
    const target = admit('a', 'no-' + name);
    admit('a', 'child-' + name, { inReplyTo: target.rfc_message_id, ...extra }, [folder]);
    assert.equal(read('no-' + name), null);
  }
  const draftOriginal = admit('a', 'draft-original', { isDraft: true }, ['Drafts']);
  admit('a', 'draft-original-child', { inReplyTo: draftOriginal.rfc_message_id, replyInferenceEligible: true }, ['Sent']);
  assert.equal(read('draft-original'), null, 'draft originals cannot receive inferred indicators');
  const startup = admit('a', 'startup');
  admit('a', 'startup-sent', { inReplyTo: startup.rfc_message_id, replyInferenceEligible: true }, ['Sent']);
  db.updateMessage(startup.id, { replied: null });
  await db.close(); await engine.init(); assert.equal(read('startup'), 1, 'startup backfills cached headers');
  assert.equal(read('reaction-false'), null); assert.equal(read('reaction-true'), null);
  const stale = db.captureDisposition('a', { ...fields, kind: 'forward', sourceMessageId: db.gmailCopies('a', 'original')[0].id });
  db.removeAccount('a');
  db.insertAccount({ ...fixture.account, id: 'a', profile: 'gmail', authKind: 'oauth2' });
  db.replaceFolders('a', fixture.folders); db.enableGmail('a'); admit('a', 'original');
  db.confirmDisposition('a', stale); assert.equal(read('original', 'forwarded'), null, 'old generation cannot mark a reconnected account');
  assert.ok(calls > 0); assert.equal(service.calls.length, 0, 'inference/adoption never scans the provider');
});
