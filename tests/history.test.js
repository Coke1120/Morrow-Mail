import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createStore } from '../server/store.js';
import { createHistory, importOptions } from '../server/history.js';

const A = 'a@example.invalid', B = 'b@example.invalid';
const now = Date.parse('2026-09-27T12:00:00Z');
const message = (id, folder = 'inbox') => ({ id, folder, date: '2026-09-26T12:00:00.000Z', subject: id, body: 'Fixture only', labels: [], starred: false });
function fixture(t) {
  const directory = mkdtempSync(`${tmpdir()}/morrow-history-`);
  let store = createStore(directory);
  store.setSettings({ mailAccounts: { [A]: { email: A, provider: 'google', connectionId: 'a' }, [B]: { email: B, provider: 'microsoft', connectionId: 'b' } } });
  const f = { now, calls: [], refreshes: 0, locked: false, refresh: async mail => mail, fetch: async () => ({ messages: [], nextCursor: null }), get store() { return store; } };
  const make = () => createHistory({ store, now: () => f.now, connection: account => store.getSettings().mailAccounts[account],
    currentMail: async account => { f.refreshes++; return f.refresh(store.getSettings().mailAccounts[account]); },
    fetchPage: async (mail, options) => { f.calls.push({ mail, options }); return f.fetch(mail, options); },
    importMessages: (mail, messages) => {
      const added = [];
      for (const item of messages) {
        if (!store.getMessage(mail.email, item.id)) added.push(item.id);
        store.upsertMessage(mail.email, item);
        if (item.id === 'rollback') throw f.commitError || new Error('Fixture failure after a write');
      }
      return added;
    },
    lock: async work => {
      if (f.locked) throw Object.assign(new Error('Busy'), { status: 409 });
      f.locked = true;
      try { await work(); } finally { f.locked = false; }
    }
  });
  f.history = make();
  f.restart = () => { store.close(); store = createStore(directory); f.history = make(); };
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return f;
}

test('all-mail options accept supported providers with strict option validation', t => {
  const f = fixture(t);
  assert.deepEqual(importOptions(), { months: 3, inbox: true, sent: true, allMail: false });
  assert.equal(importOptions({ allMail: true, inbox: false, sent: false }).allMail, true);
  for (const input of [null, [], { allMail: 'true' }, { allMail: true, inbox: 1 }, { allMail: true, months: 2 }, { inbox: false, sent: false }, { allMail: false, inbox: false, sent: false }, { unknown: true }]) assert.throws(() => importOptions(input), { status: 400 });
  const before = f.store.getSettings();
  f.store.setSettings({ mailAccounts: { ...before.mailAccounts, [B]: { ...before.mailAccounts[B], provider: 'unsupported' } } });
  assert.throws(() => f.history.start(B, { allMail: true }), { status: 400 });
  f.store.setSettings({ mailAccounts: before.mailAccounts });
  assert.throws(() => f.history.start('missing@example.invalid', { allMail: true }), { status: 400 });
  assert.deepEqual(f.store.getSettings(), before);
  assert.equal(f.refreshes, 0); assert.equal(f.calls.length, 0);
  f.history.start(B, { allMail: true, months: 0 });
  assert.equal(f.history.status(B).currentFolder, 'all');
  assert.equal(f.history.status(B).since, '');
  f.history.start(B, {});
  assert.equal(f.history.status(B).currentFolder, 'inbox');
  assert.equal(f.history.status(B).options.allMail, false);
});

test('Gmail all-mail checkpoints preserve labels and expose durable accurate page counts', async t => {
  const f = fixture(t);
  f.history.start(A, { allMail: true, inbox: false, sent: false });
  let status = f.history.status(A);
  assert.equal(status.currentFolder, 'all'); assert.equal(status.phase, 'queued');
  assert.equal(status.pages, 0); assert.equal(status.processed, 0); assert.equal(status.imported, 0);
  assert.equal(status.lastPageChecked, null);
  const sent = { ...message('sent', 'sent'), labels: ['SENT', 'STARRED', 'Project'], starred: true };
  const draft = { ...message('draft', 'drafts'), providerDraft: true, labels: ['DRAFT', 'Project'] };
  f.fetch = async () => ({ messages: [sent, draft, { ...message('too-old'), date: '2020-01-01T00:00:00.000Z' }], nextCursor: 'private-provider-cursor' });
  await f.history.tick();
  status = f.history.status(A);
  assert.equal(f.calls[0].options.folder, 'all');
  assert.equal(status.pages, 1); assert.equal(status.processed, 3); assert.equal(status.imported, 2);
  assert.equal(status.lastPageChecked, 3); assert.equal(status.lastPageAdded, 2);
  assert.equal(f.store.getMessage(A, 'too-old'), null);
  assert.equal(f.store.getMessage(B, 'sent'), null);
  assert.deepEqual(f.store.getMessage(A, 'sent').labels, sent.labels);
  assert.equal(f.store.getMessage(A, 'sent').starred, true);
  assert.equal(f.store.getMessage(A, 'draft').providerDraft, true);
  f.history.control(A, 'pause');
  assert.equal(f.history.status(A).phase, 'paused');
  f.restart();
  assert.equal(f.history.status(A).processed, 3);
  f.history.control(A, 'resume');
  f.fetch = async () => ({ messages: [sent], nextCursor: null });
  await f.history.tick();
  assert.equal(f.calls[1].options.folder, 'all');
  assert.equal(f.calls[1].options.cursor, 'private-provider-cursor');
  status = f.history.status(A);
  assert.equal(status.pages, 2); assert.equal(status.processed, 4); assert.equal(status.imported, 2);
  assert.equal(status.lastPageAdded, 0); assert.equal(status.lastPageChecked, 1);
  assert.equal(status.status, 'complete'); assert.equal(status.phase, 'complete'); assert.equal(status.currentFolder, null);
  for (const privateField of ['cursor', 'visited', 'connectionId', 'id', 'total']) assert.equal(status[privateField], undefined);
  assert.ok(!JSON.stringify(status).includes('private-provider-cursor'));
});

test('imports retain mailbox gating, pause/reconnect exclusion and atomic progress', async t => {
  const f = fixture(t);
  f.history.start(A, { allMail: true });
  f.locked = true;
  await f.history.tick();
  assert.equal(f.refreshes, 0); assert.equal(f.calls.length, 0);
  assert.equal(f.history.status(A).phase, 'queued');
  f.locked = false;
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  f.fetch = async () => { started(); return new Promise(resolve => { release = resolve; }); };
  const pending = f.history.tick();
  await entered;
  f.history.control(A, 'pause');
  release({ messages: [message('stale')], nextCursor: null });
  await pending;
  assert.equal(f.store.getMessage(A, 'stale'), null);
  assert.equal(f.history.status(A).processed, 0);
  f.history.control(A, 'resume');
  f.fetch = async () => ({ messages: [message('rollback')], nextCursor: 'not-committed' });
  await f.history.tick();
  assert.equal(f.store.getMessage(A, 'rollback'), null);
  assert.equal(f.history.status(A).status, 'failed');
  assert.equal(f.history.status(A).processed, 0); assert.equal(f.history.status(A).pages, 0);
  assert.equal(f.store.getSettings().imports[A].cursor, null);
  f.history.control(A, 'resume');
  f.fetch = async () => ({ messages: [], nextCursor: 'page-a' });
  await f.history.tick();
  assert.equal(f.history.status(A).pages, 1);
  await f.history.tick();
  assert.equal(f.history.status(A).status, 'failed');
  assert.equal(f.history.status(A).pages, 1);
  const accounts = f.store.getSettings().mailAccounts;
  accounts[A].connectionId = 'reconnected'; f.store.setSettings({ mailAccounts: accounts });
  assert.throws(() => f.history.control(A, 'resume'), { status: 400 });
  f.history.start(A, { allMail: true });
  const refreshing = new Promise(resolve => { started = resolve; });
  f.refresh = async mail => { started(); await new Promise(resolve => { release = resolve; }); return mail; };
  const previousCalls = f.calls.length, duringRefresh = f.history.tick();
  await refreshing;
  f.history.control(A, 'pause');
  release(); await duringRefresh;
  assert.equal(f.calls.length, previousCalls);
  assert.equal(f.history.status(A).pages, 0);
});

test('legacy checkpoints resume without inventing historical progress totals', async t => {
  const f = fixture(t);
  f.history.start(B, { inbox: true, sent: true });
  const imports = f.store.getSettings().imports;
  delete imports[B].options.allMail; delete imports[B].pages; delete imports[B].processed;
  imports[B].imported = 20;
  f.store.setSettings({ imports });
  f.restart();
  assert.equal(f.history.status(B).pages, null); assert.equal(f.history.status(B).processed, null);
  f.fetch = async () => ({ messages: [message('new')], nextCursor: null });
  await f.history.tick();
  assert.equal(f.calls[0].options.folder, 'inbox');
  assert.equal(f.history.status(B).currentFolder, 'sent');
  assert.equal(f.history.status(B).pages, null); assert.equal(f.history.status(B).processed, null);
  assert.equal(f.history.status(B).imported, 21); assert.equal(f.history.status(B).lastPageChecked, 1);
  assert.equal(f.history.status(B).lastPageAdded, 1);
});

test('transient read failures retry at durable bounded deadlines without losing a page or starving another owner', async t => {
  const f = fixture(t);
  f.history.start(A, { allMail: true });
  f.fetch = async () => ({ messages: [message('first')], nextCursor: 'private-checkpoint' });
  await f.history.tick();
  const checkpoint = f.store.getSettings().imports[A];
  let failure = { providerStatus: 429 };
  f.fetch = async mail => { if (mail.email === B) return { messages: [] }; throw Object.assign(new Error('secret provider data'), failure); };
  for (const [index, delay] of [30_000, 120_000, 300_000].entries()) {
    await f.history.tick();
    let status = f.history.status(A);
    assert.equal(status.status, 'running'); assert.equal(status.phase, 'retrying'); assert.equal(status.recoveryAction, 'retry');
    assert.equal(status.retryCount, index + 1); assert.equal(Date.parse(status.nextRetryAt), f.now + delay);
    assert.equal(status.pages, 1); assert.equal(status.imported, 1); assert.equal(status.processed, 1);
    assert.equal(f.store.getSettings().imports[A].cursor, checkpoint.cursor);
    assert.doesNotMatch(JSON.stringify(status), /secret|private-checkpoint/);
    f.restart();
    const calls = f.calls.length; await f.history.tick(); assert.equal(f.calls.length, calls);
    if (index === 0) {
      f.history.start(B, { inbox: true, sent: false }); await f.history.tick();
      assert.equal(f.history.status(B).status, 'complete');
    }
    f.now = Date.parse(status.nextRetryAt);
    failure = index === 0 ? { providerStatus: 503 } : { code: 'provider_network' };
  }
  await f.history.tick();
  let status = f.history.status(A);
  assert.equal(status.status, 'failed'); assert.equal(status.retryCount, 3); assert.equal(status.nextRetryAt, null); assert.equal(status.recoveryAction, 'resume');
  f.restart(); const count = f.calls.length; await f.history.tick(); assert.equal(f.calls.length, count);
  f.history.control(A, 'resume');
  status = f.history.status(A); assert.equal(status.retryCount, 0); assert.equal(status.nextRetryAt, null); assert.equal(status.error, '');
  f.fetch = async (_mail, options) => { assert.equal(options.cursor, checkpoint.cursor); return { messages: [message('first')] }; };
  await f.history.tick();
  status = f.history.status(A); assert.equal(status.status, 'complete'); assert.equal(status.retryCount, 0); assert.equal(status.errorCode, null);
  assert.equal(status.imported, 1); assert.equal(status.pages, 2); assert.equal(status.processed, 2);
});

test('auth, invalid pages, non-lock conflicts and commit failures never automatically retry or expose raw errors', async t => {
  const f = fixture(t);
  for (const [failure, code, action] of [
    [{ providerStatus: 401 }, 'authorization', 'reconnect'], [{ providerStatus: 403 }, 'authorization', 'reconnect'],
    [{ status: 500 }, 'import_failed', 'resume'], [{ status: 409 }, 'import_failed', 'resume'],
    [{ message: 'The IMAP folder changed. Start the import again.', status: 409 }, 'invalid_cursor', 'restart'],
    [{ message: 'The IMAP server does not identify a Sent folder. Import Inbox only or configure Sent on your provider.', status: 409 }, 'sent_unavailable', 'restart'],
  ]) {
    f.history.start(A, { allMail: true });
    f.fetch = async () => { throw Object.assign(new Error('secret credential'), failure); };
    await f.history.tick();
    const status = f.history.status(A);
    assert.equal(status.status, 'failed'); assert.equal(status.errorCode, code); assert.equal(status.recoveryAction, action); assert.equal(status.nextRetryAt, null);
    assert.doesNotMatch(status.error, /secret|credential/);
    const calls = f.calls.length; await f.history.tick(); assert.equal(f.calls.length, calls);
  }
  f.history.start(A, { allMail: true });
  f.fetch = async () => ({ messages: 'invalid' }); await f.history.tick();
  assert.equal(f.history.status(A).errorCode, 'invalid_page'); assert.equal(f.history.status(A).recoveryAction, 'restart');
  f.history.start(A, { allMail: true });
  f.commitError = Object.assign(new Error('database secret'), { code: 'provider_network', providerStatus: 503 });
  f.fetch = async () => ({ messages: [message('rollback')] }); await f.history.tick();
  assert.equal(f.history.status(A).errorCode, 'storage_error'); assert.equal(f.history.status(A).status, 'failed');
  assert.equal(f.store.getMessage(A, 'rollback'), null); assert.equal(f.history.status(A).pages, 0);
});

test('pause and connection changes discard late failures; legacy failed work requires explicit resume', async t => {
  const f = fixture(t);
  for (const mutation of ['pause', 'reconnect', 'disconnect']) {
    f.store.setSettings({ mailAccounts: { ...f.store.getSettings().mailAccounts, [A]: { email: A, provider: 'google', connectionId: 'a' } } });
    f.history.start(A, { allMail: true });
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    f.fetch = async () => { entered(); await new Promise(resolve => { release = resolve; }); throw Object.assign(new Error('late failure'), { providerStatus: 503 }); };
    const pending = f.history.tick(); await started;
    if (mutation === 'pause') f.history.control(A, 'pause');
    else { const accounts = f.store.getSettings().mailAccounts; if (mutation === 'reconnect') accounts[A].connectionId = 'new'; else delete accounts[A]; f.store.setSettings({ mailAccounts: accounts }); }
    const state = f.store.getSettings().imports[A]; release(); await pending;
    assert.deepEqual(f.store.getSettings().imports[A], state);
    assert.equal(f.history.status(A).nextRetryAt, null);
    if (mutation !== 'pause') assert.throws(() => f.history.control(A, 'resume'), { status: 400 });
  }
  f.store.setSettings({ mailAccounts: { [A]: { email: A, provider: 'google' } }, imports: { [A]: { id: 'legacy', options: { inbox: true, sent: false }, status: 'failed', cursor: 'saved', imported: 7, folderIndex: 0 } } });
  f.restart(); const calls = f.calls.length; await f.history.tick(); assert.equal(f.calls.length, calls);
  assert.equal(f.history.status(A).recoveryAction, 'resume');
  f.history.control(A, 'resume'); assert.equal(f.store.getSettings().imports[A].cursor, 'saved');
  const accounts = {}; f.store.setSettings({ mailAccounts: accounts });
  assert.throws(() => f.history.control(A, 'resume'), { status: 400 }); // Missing IDs do not make a disconnected legacy owner valid.
});

test('public import status derives errors and recovery only from safe codes, including legacy checkpoints', t => {
  const f = fixture(t); f.history.start(A, { allMail: true });
  for (const code of [undefined, 'RAW-PROVIDER-ERROR', 'authorization', 'invalid_cursor']) {
    const imports = f.store.getSettings().imports;
    Object.assign(imports[A], { status: 'failed', error: 'RAW-PROVIDER-ERROR secret-token private-id', recoveryAction: 'secret-token', errorCode: code });
    f.store.setSettings({ imports });
    const status = f.history.status(A);
    assert.doesNotMatch(JSON.stringify(status), /RAW-PROVIDER-ERROR|secret-token|private-id/);
    assert.equal(status.recoveryAction, code === 'authorization' ? 'reconnect' : code === 'invalid_cursor' ? 'restart' : 'resume');
    assert.ok(status.error.length > 0);
  }
});

test('unlimited history keeps a fixed upper boundary and a durable folder checkpoint', async t => {
  const f = fixture(t);
  for (const months of [-1, 0.5, '0', null]) assert.throws(() => importOptions({ months }), { status: 400 });
  f.history.start(B, { months: 0, allMail: true, inbox: false, sent: false });
  const before = f.history.status(B).before;
  assert.deepEqual(f.history.status(B).coverage, { provider: 'microsoft', folders: ['all'], excludes: ['spam', 'trash'], folderLimit: 300 });
  const cursor = { version: 1, folders: [{ id: 'inbox-id', kind: 'inbox', name: 'Inbox' }], index: 0, next: 'private-next' };
  f.fetch = async (_, options) => {
    assert.equal(options.since, ''); assert.equal(options.before, before);
    return { messages: [{ ...message('old'), date: '1999-01-01T00:00:00.000Z' }, { ...message('future'), date: '2099-01-01T00:00:00.000Z' }], nextCursor: cursor };
  };
  await f.history.tick();
  assert.ok(f.store.getMessage(B, 'old')); assert.equal(f.store.getMessage(B, 'future'), null);
  f.history.control(B, 'pause'); f.restart(); f.now += 86400000; f.history.control(B, 'resume');
  f.fetch = async (_, options) => {
    assert.equal(options.since, ''); assert.equal(options.before, before); assert.deepEqual(options.cursor, cursor);
    return { messages: [], nextCursor: null };
  };
  await f.history.tick();
  assert.equal(f.history.status(B).status, 'complete'); assert.equal(f.history.status(B).imported, 1);
  assert.ok(!JSON.stringify(f.history.status(B)).includes('private-next'));
});
