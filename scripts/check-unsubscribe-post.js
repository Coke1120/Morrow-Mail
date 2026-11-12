const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { postUnsubscribe } = require('../host/mail/unsubscribe-post');
const URL = 'https://newsletter.example.com/unsubscribe?opaque=secret';
const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

function fixture({ status = 200, chunks = ['ok'], mode = 'normal', lookup = async () => PUBLIC, checkCurrent = () => true, ...limits } = {}) {
  const calls = [], sockets = [], responses = [];
  const options = { lookup, checkCurrent, ...limits,
    request(settings, onResponse) {
      const req = new EventEmitter();
      const socket = new EventEmitter(); sockets.push(socket);
      const record = { settings, destroyed: false }; calls.push(record);
      req.destroy = () => { record.destroyed = true; };
      req.end = body => {
        record.body = body;
        queueMicrotask(() => {
          req.emit('socket', socket);
          if (mode === 'connect-stall') return;
          socket.emit('secureConnect');
          if (mode === 'request-error') { req.emit('error', new Error('private error with token')); return; }
          if (mode === 'response-stall') return;
          const res = new EventEmitter();
          res.statusCode = status; res.complete = true;
          res.destroy = () => { res.destroyed = true; };
          responses.push(res); onResponse(res);
          if (mode === 'response-error') { res.emit('error', new Error('internal')); return; }
          if (mode === 'aborted') { res.emit('aborted'); return; }
          for (const chunk of chunks) res.emit('data', chunk);
          if (mode === 'incomplete') res.complete = false;
          if (mode !== 'body-stall') res.emit('end');
        });
      };
      return req;
    },
  };
  return { calls, responses, options };
}

function lookupPinned(options, host, all = false) {
  return new Promise((resolve, reject) => options.lookup(host, { all }, (error, address, family) =>
    error ? reject(error) : resolve(all ? address : { address, family })));
}

test('POST uses exact RFC 8058 body, isolated credentials-free HTTPS, TLS and pinned DNS', async () => {
  let lookups = 0, ownershipChecks = 0;
  const f = fixture({ lookup: async (host, settings) => {
    lookups++; assert.equal(host, 'newsletter.example.com'); assert.deepEqual(settings, { all: true, verbatim: true }); return PUBLIC;
  }, checkCurrent: () => { ownershipChecks++; return true; } });
  assert.deepEqual(await postUnsubscribe(URL, f.options), { status: 'accepted', issued: true, reason: 'request-accepted', httpStatus: 200 });
  assert.equal(lookups, 1); assert.equal(ownershipChecks, 1); assert.equal(f.calls.length, 1);
  const { settings, body, destroyed } = f.calls[0];
  assert.equal(body, 'List-Unsubscribe=One-Click');
  assert.equal(settings.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(settings.headers['Content-Length'], Buffer.byteLength(body));
  assert.equal(settings.protocol, 'https:'); assert.equal(settings.port, 443); assert.equal(settings.method, 'POST');
  assert.equal(settings.path, '/unsubscribe?opaque=secret'); assert.equal(settings.hostname, 'newsletter.example.com');
  assert.equal(settings.servername, 'newsletter.example.com'); assert.equal(settings.rejectUnauthorized, true);
  assert.equal(settings.agent, false); assert.equal(settings.autoSelectFamily, false); assert.equal(settings.family, 4);
  assert.equal(settings.maxHeaderSize, 16 * 1024); assert.ok(destroyed); assert.ok(f.responses[0].destroyed);
  for (const name of ['auth', 'proxy', 'proxyEnv', 'cookie', 'cert', 'key', 'pfx', 'ca']) assert.equal(settings[name], undefined);
  for (const name of Object.keys(settings.headers)) assert.ok(!/cookie|authorization|referer|origin/i.test(name));
  assert.deepEqual(await lookupPinned(settings, settings.hostname), PUBLIC[0]);
  assert.deepEqual(await lookupPinned(settings, settings.hostname, true), PUBLIC);
  await assert.rejects(lookupPinned(settings, 'localhost'));
});

test('DNS pin survives resolver answer mutation and does not resolve again', async () => {
  const answer = [{ address: PUBLIC[0].address, family: 4 }];
  let count = 0;
  const f = fixture({ lookup: async () => { count++; return answer; }, checkCurrent: () => {
    answer[0].address = '127.0.0.1'; answer[0].family = 6; return true;
  } });
  assert.equal((await postUnsubscribe(URL, f.options)).status, 'accepted');
  assert.deepEqual(await lookupPinned(f.calls[0].settings, 'newsletter.example.com'), PUBLIC[0]);
  assert.equal(count, 1);
});

test('unsafe schemes, userinfo, aliases, local/private/special addresses and ports never reach DNS or request', async () => {
  for (const value of ['http://newsletter.example.com/u', 'https://user:pass@newsletter.example.com/u', 'https://@newsletter.example.com/u',
    'https://newsletter.example.com:444/u', 'https://127.0.0.1/u', 'https://2130706433/u', 'https://0x7f000001/u',
    'https://[::1]/u', 'https://[::ffff:127.0.0.1]/u', 'https://[2002:7f00:1::]/u', 'https://[2001:db8::1]/u',
    'https://169.254.169.254/u', 'https://10.0.0.1/u', 'https://100.64.0.1/u', 'https://198.18.0.1/u',
    'https://localhost/u', 'https://mail.local/u', 'https://newsletter.example.com/u#fragment', 'https://newsletter.example.com/%0d%0aX:yes']) {
    let count = 0; const f = fixture({ lookup: () => { count++; throw new Error('must not resolve'); } });
    const result = await postUnsubscribe(value, f.options);
    assert.equal(result.status, 'failed', value); assert.equal(result.issued, false); assert.equal(f.calls.length, 0); assert.equal(count, 0);
  }
});

test('all DNS answers must be valid and public; mixed answers cannot choose only the safe one', async () => {
  for (const answers of [[], null, [PUBLIC[0], { address: '10.0.0.1', family: 4 }],
    [{ address: '::ffff:5db8:d822', family: 6 }], [{ address: '93.184.216.34', family: 6 }],
    Array.from({ length: 65 }, () => PUBLIC[0]), [{ address: '2001:20::1', family: 6 }]]) {
    const f = fixture({ lookup: async () => answers });
    const result = await postUnsubscribe(URL, f.options);
    assert.deepEqual(result, { status: 'failed', issued: false, reason: 'unsafe-dns' }); assert.equal(f.calls.length, 0);
  }
});

test('public literal IPv4/IPv6 are validated without DNS and public IPv6 hostname answers are pinned', async () => {
  for (const value of ['https://93.184.216.34/u', 'https://[2606:4700:4700::1111]/u']) {
    const f = fixture({ lookup: () => { throw new Error('No DNS for literals'); } });
    assert.equal((await postUnsubscribe(value, f.options)).status, 'accepted');
    assert.equal(f.calls[0].settings.servername, '');
  }
  const ipv6 = [{ address: '2606:4700:4700::1111', family: 6 }];
  const f = fixture({ lookup: async () => ipv6 });
  assert.equal((await postUnsubscribe(URL, f.options)).status, 'accepted');
  assert.equal(f.calls[0].settings.family, 6);
  assert.deepEqual(await lookupPinned(f.calls[0].settings, 'newsletter.example.com'), ipv6[0]);
});

test('stale ownership or nonboolean approval never creates a request', async () => {
  for (const current of [false, undefined, 'yes']) {
    const f = fixture({ checkCurrent: () => current });
    assert.deepEqual(await postUnsubscribe(URL, f.options), { status: 'failed', issued: false, reason: 'stale' });
    assert.equal(f.calls.length, 0);
  }
  const f = fixture({ checkCurrent: () => { throw new Error('gone'); } });
  assert.equal((await postUnsubscribe(URL, f.options)).issued, false); assert.equal(f.calls.length, 0);
});

test('DNS and ownership waits are bounded and late resolutions never send', async () => {
  let resolveDns, resolveOwner;
  const f = fixture({ dnsTimeoutMs: 5, lookup: () => new Promise(resolve => { resolveDns = resolve; }) });
  assert.equal((await postUnsubscribe(URL, f.options)).issued, false);
  resolveDns(PUBLIC); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 0);
  const g = fixture({ timeoutMs: 5, checkCurrent: () => new Promise(resolve => { resolveOwner = resolve; }) });
  assert.deepEqual(await postUnsubscribe(URL, g.options), { status: 'failed', issued: false, reason: 'timeout' });
  resolveOwner(true); await new Promise(resolve => setImmediate(resolve)); assert.equal(g.calls.length, 0);
});

test('2xx accepts only the request; redirects and HTTP failures never replay or follow', async () => {
  for (const status of [200, 202, 204, 299, 301, 302, 303, 307, 308, 400, 401, 429, 500]) {
    const f = fixture({ status }); const result = await postUnsubscribe(URL, f.options);
    assert.equal(result.status, status < 300 ? 'accepted' : 'failed'); assert.equal(result.issued, true);
    assert.equal(result.httpStatus, status); assert.equal(f.calls.length, 1);
    if (status >= 300 && status < 400) assert.equal(result.reason, 'redirect-refused');
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
});

test('network failures, incomplete/oversize bodies, and deadlines are uncertain without retry', async () => {
  for (const mode of ['request-error', 'response-error', 'aborted', 'incomplete', 'connect-stall', 'response-stall', 'body-stall']) {
    const f = fixture({ mode, timeoutMs: 15, connectTimeoutMs: 5 });
    const result = await postUnsubscribe(URL, f.options);
    assert.equal(result.status, 'uncertain', mode); assert.equal(result.issued, true); assert.equal(f.calls.length, 1);
    assert.ok(f.calls[0].destroyed); assert.ok(!JSON.stringify(result).includes('secret'));
  }
  const f = fixture({ chunks: [Buffer.alloc(5), Buffer.alloc(5)], maxResponseBytes: 8 });
  assert.deepEqual(await postUnsubscribe(URL, f.options), { status: 'uncertain', issued: true, reason: 'response-too-large' });
  assert.equal(f.calls.length, 1);
});

test('request-construction uncertainty remains retired and does not expose exceptions', async () => {
  const result = await postUnsubscribe(URL, { lookup: async () => PUBLIC, request() { throw new Error('secret'); } });
  assert.deepEqual(result, { status: 'uncertain', issued: true, reason: 'request-error' });
});
