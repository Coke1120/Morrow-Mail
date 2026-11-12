// Synthetic Web streams only. No provider requests, credentials or sockets.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGmailMailApi } = require('../host/mail/gmail-mail-api');
process.env.MORROW_GMAIL_PACE = '0';
const MAX_MIME = 35 * 1024 * 1024;

test('immediately resolved empty chunks fail closed instead of spinning', async () => {
  let reads = 0, cancels = 0;
  const response = new Response(new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(0)); },
    cancel() { cancels++; }
  }, { highWaterMark: 0 }));
  await assert.rejects(api(async () => response).raw('message-1'), /invalid response/);
  assert.equal(reads, 1); assert.equal(cancels, 1);
});

test('immediately resolved tiny chunks yield so deadline cancellation actually fires', async () => {
  let reads = 0, cancels = 0;
  const deadline = AbortSignal.timeout(10);
  const response = new Response(new ReadableStream({
    pull(controller) {
      // Bound the regression fixture itself if cooperative yielding disappears.
      if (++reads >= 100000) { controller.error(new Error('starved deadline sentinel')); return; }
      controller.enqueue(new Uint8Array([32]));
    },
    cancel() { cancels++; }
  }, { highWaterMark: 0 }));
  await assert.rejects(api(async () => response).raw('message-1', { signal: deadline }), /could not be confirmed/);
  assert.equal(deadline.aborted, true, 'the real timer must run before the fixture sentinel');
  assert.ok(reads > 0 && reads < 100000);
  assert.equal(cancels, 1);
});

const MAX_RESPONSE = Math.ceil(MAX_MIME * 4 / 3) + 1024 * 1024;
const mime = Buffer.from('From: fixture@example.invalid\r\nSubject: Synthetic\r\n\r\nBody\r\n');
const encoded = source => JSON.stringify({ id: 'message-1', raw: source.toString('base64url') });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function api(fetchImpl, extra = {}) {
  return createGmailMailApi({ accessToken: async () => 'synthetic-token', fetchImpl, ...extra });
}
function streamed(text, width = 1024, headers = {}) {
  const bytes = Buffer.from(text);
  let offset = 0, cancels = 0, reads = 0;
  const response = new Response(new ReadableStream({
    pull(controller) {
      reads++;
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(offset + width, bytes.length);
      controller.enqueue(bytes.subarray(offset, end)); offset = end;
    },
    cancel() { cancels++; }
  }, { highWaterMark: 0 }), { headers });
  response.text = () => { throw Error('Unbounded response.text must not be called'); };
  return { response, cancels: () => cancels, reads: () => reads };
}

test('raw compatibility and many split JSON/base64 chunks preserve exact original bytes', async () => {
  for (const width of [1, 7, 65536]) {
    const f = streamed(encoded(mime), width);
    let call;
    const client = api(async (url, options) => { call = { url, options }; return f.response; });
    const result = await client.raw('message-1');
    assert.deepEqual(result.source, mime);
    assert.equal(result.id, 'message-1');
    assert.equal(new URL(call.url).searchParams.get('format'), 'raw');
    assert.equal(call.options.redirect, 'error');
    assert.equal(f.cancels(), 0);
  }
});

test('raw originals larger than 10 MiB remain eligible inside the 35 MiB Gmail cap', async () => {
  const large = Buffer.alloc(11 * 1024 * 1024, 65);
  const f = streamed(encoded(large), 32771);
  const result = await api(async () => f.response).raw('message-1');
  assert.equal(result.source.length, large.length);
  assert.deepEqual(result.source, large);
  assert.ok(f.reads() > 400);
});

test('wire-body overflow cancels before reading the complete response or parsing JSON', async () => {
  let produced = 0, cancels = 0;
  const chunk = new Uint8Array(1024 * 1024).fill(32);
  const response = new Response(new ReadableStream({
    pull(controller) { produced += chunk.length; controller.enqueue(chunk); },
    cancel() { cancels++; }
  }, { highWaterMark: 0 }));
  response.text = () => { throw Error('No unbounded fallback'); };
  await assert.rejects(api(async () => response).raw('message-1'), /oversized/);
  assert.equal(cancels, 1);
  assert.ok(produced > MAX_RESPONSE && produced <= MAX_RESPONSE + chunk.length);
});

test('oversized Content-Length rejects and cancels without reading body chunks', async () => {
  const f = streamed(encoded(mime), 2, { 'content-length': String(MAX_RESPONSE + 1) });
  await assert.rejects(api(async () => f.response).raw('message-1'), /oversized/);
  assert.equal(f.reads(), 0); assert.equal(f.cancels(), 1);
});

test('abort during a stalled body promptly cancels the reader and cannot resume', async () => {
  const abort = new AbortController();
  let cancels = 0, fetchSignal, controller;
  const started = deferred();
  const response = new Response(new ReadableStream({
    start(value) { controller = value; },
    pull() { started.resolve(); },
    cancel() { cancels++; }
  }, { highWaterMark: 0 }));
  const pending = api(async (_url, options) => { fetchSignal = options.signal; return response; })
    .raw('message-1', { signal: abort.signal });
  await started.promise;
  abort.abort(new Error('synthetic cancellation'));
  await assert.rejects(pending, /could not be confirmed/);
  assert.equal(fetchSignal.aborted, true); assert.equal(cancels, 1);
  assert.throws(() => controller.enqueue(Buffer.from(encoded(mime))), /closed/);
});

test('aborted before submission performs no fetch, and late responses are cancelled', async () => {
  const before = new AbortController(); before.abort();
  let calls = 0;
  await assert.rejects(api(async () => { calls++; throw Error('No fetch'); }).raw('message-1', { signal: before.signal }));
  assert.equal(calls, 0);
  const abort = new AbortController(), arrival = deferred(), started = deferred();
  const f = streamed(encoded(mime), 2);
  const pending = api(async () => { started.resolve(); await arrival.promise; return f.response; })
    .raw('message-1', { signal: abort.signal });
  await started.promise; abort.abort(); arrival.resolve();
  await assert.rejects(pending);
  assert.equal(f.cancels(), 1); assert.equal(f.reads(), 0);
});

test('deadline signal stops a stalled stream without waiting for the response to finish', async () => {
  let cancels = 0;
  const response = new Response(new ReadableStream({ pull() {}, cancel() { cancels++; } }));
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(api(async () => response).raw('message-1', { signal: AbortSignal.timeout(10) }), /could not be confirmed/);
    assert.equal(cancels, 1);
  } finally { clearTimeout(keepAlive); }
});

test('malformed or truncated JSON/base64 and empty raw data cannot produce a source', async () => {
  for (const text of ['{', '{"id":"message-1","raw":"QQ', '{"id":"message-1","raw":"***"}',
    '{"id":"message-1","raw":"AB"}', '{"id":"message-1","raw":""}', '{"id":"message-1"}']) {
    const f = streamed(text, 3);
    await assert.rejects(api(async () => f.response).raw('message-1'), /invalid|empty/);
  }
});

test('decoded MIME size remains capped even when the JSON response fits its envelope budget', async () => {
  const f = streamed(encoded(Buffer.alloc(MAX_MIME + 1, 65)), 65536);
  await assert.rejects(api(async () => f.response).raw('message-1'), /oversized/);
});

test('stream errors and account retirement cannot return partially read data', async () => {
  let count = 0, cancels = 0;
  const response = new Response(new ReadableStream({
    pull(controller) { if (count++) controller.error(new Error('synthetic stream loss')); else controller.enqueue(Buffer.from('{"id":')); }
  }, { highWaterMark: 0 }));
  await assert.rejects(api(async () => response).raw('message-1'), /could not be confirmed/);
  let retired = false;
  const retiredResponse = new Response(new ReadableStream({
    pull(controller) { retired = true; controller.enqueue(Buffer.from(encoded(mime))); },
    cancel() { cancels++; }
  }, { highWaterMark: 0 }));
  await assert.rejects(api(async () => retiredResponse, { check() { if (retired) throw Error('account retired'); } }).raw('message-1'), /could not be confirmed/);
  assert.equal(cancels, 1);
});

