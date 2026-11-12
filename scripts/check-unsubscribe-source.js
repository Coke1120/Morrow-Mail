// Synthetic provider originals only. No credentials or live network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { withUnsubscribeSource } = require('../host/mail/remote');
const row = { id: 'synthetic', account_id: 'a', folder_path: 'INBOX', uid: 7, uid_validity: 9 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(options = {}) {
  const state = { locks: 0, releases: 0, downloads: 0, yielded: 0, destroyed: 0 };
  const size = options.size ?? 12 * 1024 * 1024;
  const chunk = Buffer.alloc(64 * 1024, 97);
  const client = {
    mailbox: { uidValidity: options.validity ?? 9 },
    async getMailboxLock(path) { assert.equal(path, 'INBOX'); state.locks++; return { release() { state.releases++; } }; },
    async *fetch(uid, fields, opts) {
      assert.equal(uid, '7'); assert.deepEqual(fields, { uid: true, size: true }); assert.deepEqual(opts, { uid: true });
      yield { uid: options.uid ?? 7, size };
    },
    async download(uid, part, opts) {
      state.downloads++; assert.equal(uid, '7'); assert.equal(part, undefined);
      assert.deepEqual(opts, { uid: true, maxBytes: 64 * 1024 * 1024 + 1 });
      const bytes = options.bytes ?? size;
      const content = Readable.from((async function* () {
        let offset = 0;
        while (offset < bytes) {
          state.yielded++;
          if (options.chunkHook) await options.chunkHook({ client, state, offset });
          const next = chunk.subarray(0, Math.min(chunk.length, bytes - offset)); offset += next.length;
          yield next;
        }
      })(), { highWaterMark: 1, objectMode: false });
      const destroy = content.destroy.bind(content);
      content.destroy = (...args) => { state.destroyed++; return destroy(...args); };
      return { content };
    },
  };
  return { client, state };
}
async function consume(source) {
  let bytes = 0;
  assert.equal(Buffer.isBuffer(source), false);
  for await (const chunk of source) { assert.ok(chunk.length <= 65536); bytes += chunk.length; }
  return { verified: true, bytes };
}

test('IMAP streams a complete >10 MiB original with bounded writes and owns the lock until EOF', async () => {
  const f = fixture();
  const result = await withUnsubscribeSource(f.client, row, {}, async source => {
    let bytes = 0;
    for await (const chunk of source) {
      assert.ok(chunk.length <= 65536); assert.equal(f.state.releases, 0);
      bytes += chunk.length;
      if (bytes === chunk.length) { await new Promise(resolve => setImmediate(resolve)); assert.ok(f.state.yielded < 5, 'no whole-body read-ahead'); }
    }
    return { verified: true, bytes };
  });
  assert.equal(result.bytes, 12 * 1024 * 1024);
  assert.equal(f.state.releases, 1); assert.ok(f.state.destroyed >= 1);
});

test('unknown/wrong UID, changed UIDVALIDITY and oversized source reject before download', async () => {
  for (const options of [{ uid: 8 }, { validity: 10 }, { size: 0 }, { size: 64 * 1024 * 1024 + 1 }]) {
    const f = fixture(options);
    await assert.rejects(withUnsubscribeSource(f.client, row, {}, consume));
    assert.equal(f.state.downloads, 0); assert.equal(f.state.releases, 1);
  }
});

test('truncated and overflowing streams cannot yield a verified result and always close', async () => {
  for (const bytes of [65535, 65537]) {
    const f = fixture({ size: 65536, bytes });
    await assert.rejects(withUnsubscribeSource(f.client, row, {}, consume), /incomplete|exceeds/);
    assert.equal(f.state.releases, 1); assert.ok(f.state.destroyed >= 1);
  }
});

test('source ownership and UIDVALIDITY are rechecked during reading and at EOF', async () => {
  for (const cause of ['ownership', 'validity']) {
    let current = true;
    const f = fixture({ size: 131072, chunkHook({ client, offset }) { if (offset > 0) { if (cause === 'ownership') current = false; else client.mailbox.uidValidity = 10; } } });
    await assert.rejects(withUnsubscribeSource(f.client, row, { check() { if (!current) throw Error('stale'); } }, consume), /stale|folder changed/);
    assert.equal(f.state.releases, 1); assert.ok(f.state.destroyed >= 1);
  }
});

test('early failure is cleaned up; early claimed success cannot bypass complete EOF', async () => {
  for (const verified of [false, true]) {
    const f = fixture();
    const call = withUnsubscribeSource(f.client, row, {}, async source => {
      for await (const _chunk of source) break;
      return { verified };
    });
    if (verified) await assert.rejects(call, /Complete original/);
    else assert.deepEqual(await call, { verified: false });
    assert.ok(f.state.yielded < 5); assert.equal(f.state.releases, 1); assert.ok(f.state.destroyed >= 1);
  }
});

test('abort during streaming destroys content and does not wait for a stalled verifier', async () => {
  const controller = new AbortController(), f = fixture();
  const call = withUnsubscribeSource(f.client, row, { signal: controller.signal }, async source => {
    for await (const _chunk of source) { controller.abort(); await new Promise(() => {}); }
    return { verified: true };
  });
  await assert.rejects(call);
  assert.equal(f.state.releases, 1); assert.ok(f.state.destroyed >= 1);
});

test('abort during pending lock/download rejects promptly and cleans late resources', async () => {
  for (const phase of ['lock', 'download']) {
    const controller = new AbortController(), wait = deferred(), f = fixture({ size: 65536 });
    let destroyed = 0, entered;
    const started = new Promise(resolve => { entered = resolve; });
    if (phase === 'lock') f.client.getMailboxLock = () => { entered(); return wait.promise; };
    else f.client.download = () => { entered(); return wait.promise; };
    const call = withUnsubscribeSource(f.client, row, { signal: controller.signal }, consume);
    await started; controller.abort();
    await assert.rejects(call);
    wait.resolve(phase === 'lock' ? { release() { f.state.releases++; } } : { content: { destroy() { destroyed++; } } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.state.releases, 1);
    if (phase === 'download') assert.equal(destroyed, 1);
  }
});

test('provider stream errors cannot pass and release the mailbox lock', async () => {
  const f = fixture({ size: 65536, chunkHook() { throw Error('synthetic stream failed'); } });
  await assert.rejects(withUnsubscribeSource(f.client, row, {}, consume), /synthetic stream failed/);
  assert.equal(f.state.releases, 1); assert.ok(f.state.destroyed >= 1);
});

test('Gmail uses exact resolved raw identity and bounded chunks without claiming HTTP streaming', async () => {
  const raw = Buffer.alloc(11 * 1024 * 1024, 97);
  let reads = 0, checks = 0;
  const controller = new AbortController();
  const client = { gmail: {
    alive() { checks++; },
    async resolve(path, uid, validity, id) { assert.deepEqual([path, uid, validity, id], ['INBOX', 7, 9, 'synthetic']); return { provider_id: 'gmail-one' }; },
    api: { async raw(id, options) { reads++; assert.equal(id, 'gmail-one'); assert.equal(options.signal, controller.signal); return { id, source: raw }; } },
  } };
  const result = await withUnsubscribeSource(client, row, { signal: controller.signal }, consume);
  assert.equal(result.bytes, raw.length); assert.equal(reads, 1); assert.ok(checks >= 3);
  client.gmail.api.raw = async () => ({ id: 'other-message', source: raw });
  await assert.rejects(withUnsubscribeSource(client, row, {}, consume), /identity or size/);
  client.gmail.api.raw = async () => ({ id: 'gmail-one', source: raw });
  await assert.rejects(withUnsubscribeSource(client, row, { maxBytes: 10 * 1024 * 1024 }, consume), /identity or size/);
});

test('invalid bounds and an already-aborted signal never enter provider reads', async () => {
  const f = fixture();
  for (const maxBytes of [0, -1, Infinity, 64 * 1024 * 1024 + 1]) await assert.rejects(withUnsubscribeSource(f.client, row, { maxBytes }, consume));
  await assert.rejects(withUnsubscribeSource(f.client, row, { signal: AbortSignal.abort() }, consume));
  assert.equal(f.state.locks, 0); assert.equal(f.state.downloads, 0);
});


test('Gmail independently enforces its 35 MiB ceiling even when the API supplies larger bytes', async () => {
  let verificationCalls = 0;
  const client = { gmail: {
    alive() {}, async resolve() { return { provider_id: 'gmail-one' }; },
    api: { async raw() { return { id: 'gmail-one', source: Buffer.alloc(35 * 1024 * 1024 + 1) }; } },
  } };
  await assert.rejects(withUnsubscribeSource(client, row, { maxBytes: 64 * 1024 * 1024 }, async () => {
    verificationCalls++; return { verified: true };
  }), /identity or size/);
  assert.equal(verificationCalls, 0);
  client.gmail.api.raw = async () => ({ id: 'gmail-one', source: Buffer.alloc(35 * 1024 * 1024) });
  const accepted = await withUnsubscribeSource(client, row, {}, consume);
  assert.equal(accepted.bytes, 35 * 1024 * 1024);
});


test('single-UID metadata response budget stops an unbounded wrong-UID provider and releases its lock', async () => {
  const f = fixture(); let responses = 0, closed = false;
  f.client.fetch = async function* () {
    try { while (true) { responses++; yield { uid: 999, size: 65536 }; } }
    finally { closed = true; }
  };
  await assert.rejects(withUnsubscribeSource(f.client, row, {}, consume), /Too many.*metadata/);
  assert.equal(responses, 64, 'budget exhaustion fails closed without requesting another response');
  assert.equal(closed, true); assert.equal(f.state.releases, 1); assert.equal(f.state.downloads, 0);
});
