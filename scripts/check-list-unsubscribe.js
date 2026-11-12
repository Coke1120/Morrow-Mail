// Synthetic fixtures only. DNS, browser opening, message/account reads and native
// confirmation are mocked; these checks never contact a list or send mail.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHeaders, descriptor, createUnsubscriber, safeUri, publicAddress, checkPublicDns } = require('../host/mail/list-unsubscribe');
const web = 'https://lists.example.net/leave?token=synthetic';
const mail = 'mailto:leave@example.net?subject=unsubscribe&body=Remove%20me';
const raw = (uris = web, post = '') => `From: Sender <sender@example.net>\r\nList-Unsubscribe: ${uris.split('\n').map(uri => `<${uri}>`).join(',\r\n\t')}\r\n${post ? `List-Unsubscribe-Post: ${post}\r\n` : ''}\r\nSynthetic body`;
const data = (uris, post) => parseHeaders(raw(uris, post));
const request = { accountId: 'synthetic-account', emailId: 'synthetic-message' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(options = {}) {
  const calls = { resolve: [], confirm: [], open: [], dns: [] };
  const source = { ...request, accountEmail: 'reader@example.net', sender: 'Sender <sender@example.net>',
    identity: 'synthetic-account-incarnation:1/message:1', metadata: data(web) };
  const unsubscribe = createUnsubscriber({
    resolve: async input => { calls.resolve.push(input); return structuredClone(source); },
    confirm: async (...args) => { calls.confirm.push(args); return true; },
    openExternal: async uri => { calls.open.push(uri); },
    lookup: async (...args) => { calls.dns.push(args); return [{ address: '8.8.8.8', family: 4 }]; },
    ...options
  });
  return { calls, source, unsubscribe };
}

test('raw and Buffer headers produce bounded metadata, not arbitrary message headers', () => {
  const source = raw(web + '\n' + mail, 'List-Unsubscribe=One-Click');
  const expected = { version: 1, urls: [web, mail], oneClick: true };
  assert.deepEqual(parseHeaders(source), expected);
  assert.deepEqual(parseHeaders(Buffer.from(source)), expected);
  assert.deepEqual(parseHeaders('Subject: Nothing\r\n\r\nList-Unsubscribe: <https://ignored.example.net>'), { version: 1, urls: [], oneClick: false });
  for (const invalid of [null, {}, 3, new Map(), 'x'.repeat(65537), Buffer.alloc(65537)]) {
    assert.deepEqual(parseHeaders(invalid), { version: 1, urls: [], oneClick: false });
  }
  assert.deepEqual(parseHeaders(raw(web) + 'x'.repeat(70000)), data(web));
  assert.deepEqual(parseHeaders(`List-Unsubscribe: <${web}>`).urls, []);
  assert.deepEqual(parseHeaders('X-Big: ' + 'x'.repeat(65536) + `\r\nList-Unsubscribe: <${web}>\r\n\r\n`).urls, []);
});

test('case-insensitive field names, folding, comments and commas inside URI tokens', () => {
  assert.deepEqual(parseHeaders('lIsT-uNsUbScRiBe:\r\n \t(comment) <https://lists.example.net/u?a=1,2> (nested (comment)),\r\n\t<mailto:leave@example.net>\n\nbody'), {
    version: 1, urls: ['https://lists.example.net/u?a=1,2', 'mailto:leave@example.net'], oneClick: false
  });
  assert.deepEqual(data(`${web}\n${web}`).urls, [web]);
});

test('duplicate fields and malformed delimiters fail closed', () => {
  for (const header of [
    `List-Unsubscribe: <${web}>\r\nList-Unsubscribe: <${mail}>`,
    `List-Unsubscribe: ${web}`, `List-Unsubscribe: <${web}>,`,
    `List-Unsubscribe: <${web}> garbage`, `List-Unsubscribe: <<${web}>>`,
    `List-Unsubscribe: <${web}> (unclosed`, `List-Unsubscribe: <${web}>\rX: injected`,
    `List-Unsubscribe: ${Array.from({ length: 9 }, (_, i) => `<${web}${i}>`).join(',')}`
  ]) assert.deepEqual(parseHeaders(header + '\r\n\r\n').urls, [], header);
  const duplicatePost = raw(web, 'List-Unsubscribe=One-Click').replace('\r\n\r\n', '\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\n');
  assert.equal(parseHeaders(duplicatePost).oneClick, false);
  assert.equal(data(web, 'List-Unsubscribe=One-Click; extra=yes').oneClick, false);
  assert.equal(data(`${web}\nhttps://other.example.net/u`, 'List-Unsubscribe=One-Click').oneClick, false);
});

test('descriptors reveal no URL/token and never mistake unverified authentication headers for proof', () => {
  const spoofed = raw(web, 'List-Unsubscribe=One-Click').replace('From:', 'Authentication-Results: forged; dkim=pass\r\nDKIM-Signature: h=list-unsubscribe:list-unsubscribe-post; b=synthetic\r\nFrom:');
  assert.deepEqual(descriptor(parseHeaders(spoofed)), { kind: 'web', destination: 'lists.example.net' });
  assert.deepEqual(descriptor(data(`${web}\n${mail}`, 'List-Unsubscribe=One-Click')), { kind: 'mailto', destination: 'leave@example.net' });
  assert.deepEqual(descriptor(data(`${web}\n${mail}`)), { kind: 'web', destination: 'lists.example.net' });
  assert.deepEqual(descriptor(data(`${mail}\n${web}`)), { kind: 'mailto', destination: 'leave@example.net' });
  assert.deepEqual(descriptor(data(`ftp://lists.example.net/u\n${web}`)), { kind: 'web', destination: 'lists.example.net' });
  for (const value of [undefined, null, {}, { version: 2, urls: [web] }, { version: 1, urls: ['javascript:alert(1)'] }]) assert.equal(descriptor(value), null);
});

test('URLs reject unsafe schemes, userinfo, encoded controls, ambiguous hosts and nonstandard ports', () => {
  for (const uri of [
    'file:///tmp/private', 'javascript:alert(1)', 'data:text/plain,hi', '//lists.example.net/u',
    'https://name:password@lists.example.net/u', 'https://@lists.example.net/u',
    'https://lists.example.net:22/u', 'http://lists.example.net:443/u',
    'https://lists.example.net/u#fragment', 'https://lists.example.net/u#',
    'https://lists.example.net/u\\escape', 'https://lists.example.net/u\r\nX:yes',
    'https://lists.example.net/%0d%0a', 'https://lists.example.net/?x=%250A',
    'https://lists.example.net/%5c', 'https://lists.example.net/%00',
    'https://lists.example.net/%QZ', 'https://%6cocalhost/u',
    'https://lists.example.net\u202e/u', 'https://lists.example.net./u',
    'https://local/u', 'https://localhost/u', 'https://one.local/u',
    'https://one.internal/u', 'https://one.home.arpa/u', 'https://one.onion/u',
    'https://one.invalid/u', 'https://one.test/u',
    'https://127.1/u', 'https://0177.0.0.1/u', 'https://0x7f000001/u',
    'https://2130706433/u', 'https://[::ffff:127.0.0.1]/u',
    'https://lists.example.net/' + 'x'.repeat(4096),
    'https://lists.example.net/' + '文'.repeat(1000),
    'mailto:a@example.net?body=' + '文'.repeat(1000),
    'mailto:a@example.net?body=\ud800', 'mailto:a@example.net?subject=\udfff'
  ]) assert.equal(safeUri(uri), null, uri);
  assert.equal(safeUri('https://lists.example.net:443/u').url, 'https://lists.example.net/u');
  assert.equal(safeUri('http://lists.example.net:80/u').url, 'http://lists.example.net/u');
  assert.equal(safeUri('https://8.8.8.8/u').destination, '8.8.8.8');
});

test('private, special-use, mapped, multicast and reserved IPv4/IPv6 addresses are refused', () => {
  for (const ip of ['0.0.0.0','10.1.2.3','100.64.0.1','100.127.255.255','127.0.0.1','169.254.169.254',
    '172.16.0.1','172.31.255.255','192.168.0.1','192.0.0.1','192.0.2.4','192.88.99.1',
    '198.18.0.1','198.19.0.1','198.51.100.1','203.0.113.1','224.0.0.1','239.1.2.3','240.0.0.1','255.255.255.255',
    '::','::1','::ffff:8.8.8.8','64:ff9b::808:808','fe80::1','fc00::1','fd00::1','ff02::1',
    '2001::1','2001:2::1','2001:20::1','2001:db8::1','2002:7f00:1::','3fff::1','fe80::1%lo0']) {
    assert.equal(publicAddress(ip), false, ip);
    assert.equal(safeUri(`https://${ip.includes(':') ? '[' + ip + ']' : ip}/u`), null, ip);
  }
  for (const ip of ['8.8.8.8','1.1.1.1','172.32.0.1','100.128.0.1','2001:4860:4860::8888','2606:4700:4700::1111']) assert.equal(publicAddress(ip), true, ip);
});

test('mailto accepts one recipient and only subject/body, preserving literal plus', () => {
  assert.deepEqual(safeUri(mail), { url: mail, kind: 'mailto', destination: 'leave@example.net', to: 'leave@example.net', subject: 'unsubscribe', text: 'Remove me' });
  assert.equal(safeUri('mailto:list%2Bleave@EXAMPLE.NET?subject=A+B').subject, 'A+B');
  const special = safeUri('mailto:list%23leave@example.net?subject=A%20B');
  assert.equal(special.to, 'list#leave@example.net');
  assert.equal(safeUri(special.url).to, special.to);
  for (const uri of ['mailto:a@example.net,b@example.net','mailto:a@example.net;b@example.net',
    'mailto:Display%20%3Ca@example.net%3E','mailto:a@localhost','mailto:.a@example.net','mailto:a..b@example.net',
    'mailto:a@example.net?cc=b@example.net','mailto:a@example.net?bcc=b@example.net',
    'mailto:a@example.net?to=b@example.net','mailto:a@example.net?from=b@example.net',
    'mailto:a@example.net?subject=one&SUBJECT=two','mailto:a@example.net?body=a%0Ab',
    'mailto:a@example.net?subject=hi%0D%0ABcc%3Ax@example.net','mailto:a@example.net?subject=%250a',
    'mailto:a@example.net?subject=bad%Q0','mailto:a@example.net?subject=' + 'x'.repeat(513)]) assert.equal(safeUri(uri), null, uri);
});

test('all DNS answers must be public; no failed or empty result can reach the browser', async () => {
  for (const answer of [[], undefined, [{ address: '127.0.0.1', family: 4 }],
    [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }],
    [{ address: '::ffff:8.8.8.8', family: 6 }], [{ address: '8.8.8.8', family: 6 }]]) {
    const f = fixture({ lookup: async () => answer });
    assert.equal((await f.unsubscribe(request)).status, 'error');
    assert.deepEqual(f.calls.open, []);
  }
  const f = fixture({ lookup: async () => { throw new Error(web); } });
  const result = await f.unsubscribe(request);
  assert.equal(result.status, 'error');
  assert.ok(!JSON.stringify(result).includes('synthetic'));
  assert.deepEqual(f.calls.open, []);
  await assert.rejects(checkPublicDns(web, () => new Promise(() => {}), 5), /timed out/);
});

test('web action reviews owning mailbox/destination then checks identity, DNS and identity again', async () => {
  const f = fixture(), context = { window: 'synthetic-only' };
  const result = await f.unsubscribe(request, context);
  assert.equal(result.status, 'opened');
  assert.match(result.message, /Completion is not confirmed/);
  assert.deepEqual(f.calls.confirm, [[{ ...request, accountEmail: 'reader@example.net', sender: 'Sender <sender@example.net>', kind: 'web', destination: 'lists.example.net', secure: true }, context]]);
  assert.equal(f.calls.resolve.length, 3);
  assert.deepEqual(f.calls.dns, [['lists.example.net', { all: true, verbatim: true }]]);
  assert.deepEqual(f.calls.open, [web]);
});

test('native review distinguishes unencrypted HTTP without exposing the URL to the renderer', async () => {
  const f = fixture(); f.source.metadata = data('http://lists.example.net/u');
  assert.equal((await f.unsubscribe(request)).status, 'opened');
  assert.equal(f.calls.confirm[0][0].secure, false);
  assert.deepEqual(descriptor(f.source.metadata), { kind: 'web', destination: 'lists.example.net' });
});

test('mailto creates a reviewable draft only, with no DNS/browser action or send callback', async () => {
  const f = fixture(); f.source.metadata = data(`${web}\n${mail}`, 'List-Unsubscribe=One-Click');
  const result = await f.unsubscribe(request);
  assert.deepEqual(result.draft, { accountId: request.accountId, sourceMessageId: request.emailId, to: 'leave@example.net', subject: 'unsubscribe', text: 'Remove me' });
  assert.equal(result.status, 'draft');
  assert.equal(f.calls.resolve.length, 2);
  assert.deepEqual(f.calls.dns, []); assert.deepEqual(f.calls.open, []);
});

test('cancelled or nonboolean confirmations cause no effect', async () => {
  for (const response of [false, null, undefined, { ok: true }, 'yes', 1]) {
    const f = fixture({ confirm: async () => response });
    assert.equal((await f.unsubscribe(request)).status, 'cancelled');
    assert.deepEqual(f.calls.dns, []); assert.deepEqual(f.calls.open, []);
  }
});

test('IPC never supplies destination, metadata, identities, authentication or wrong mailbox', async () => {
  const f = fixture();
  for (const input of [null, [], {}, { ...request, url: web }, { ...request, metadata: data(web) },
    { ...request, verified: true }, { ...request, emailId: 1 }, { ...request, accountId: 'a\n' }]) {
    assert.equal((await f.unsubscribe(input)).status, 'unavailable');
  }
  assert.deepEqual(f.calls.resolve, []);
  const mismatch = fixture({ resolve: async () => ({ ...f.source, accountId: 'other-mailbox' }) });
  assert.equal((await mismatch.unsubscribe(request)).status, 'unavailable');
  assert.deepEqual(mismatch.calls.confirm, []);
});

test('account removal, reconnect, sender change or metadata replacement during confirmation cancels effect', async () => {
  for (const mutate of [source => { source.identity += ':reconnected'; }, source => { source.accountId = 'different'; },
    source => { source.emailId = 'different'; }, source => { source.accountEmail = 'new@example.net'; },
    source => { source.sender = 'Different sender'; }, source => { source.metadata = data('https://other.example.net/u'); }]) {
    const gate = deferred(); const f = fixture({ confirm: () => gate.promise });
    const result = f.unsubscribe(request); await tick(); mutate(f.source); gate.resolve(true);
    assert.equal((await result).status, 'stale');
    assert.deepEqual(f.calls.dns, []); assert.deepEqual(f.calls.open, []);
  }
});

test('the request identity is copied before waits, and DNS awaits cannot hide a message race', async () => {
  const gate = deferred(); const f = fixture({ lookup: () => gate.promise });
  const input = { ...request }, result = f.unsubscribe(input); await tick();
  input.accountId = 'attacker'; input.emailId = 'other';
  f.source.metadata = data('https://different.example.net/u');
  gate.resolve([{ address: '8.8.8.8', family: 4 }]);
  assert.equal((await result).status, 'stale'); assert.deepEqual(f.calls.open, []);
  assert.ok(f.calls.resolve.every(value => value.accountId === request.accountId));
});

test('pending reviews are shared across service instances/windows and clear on cancellation', async () => {
  const gate = deferred(); const first = fixture({ confirm: () => gate.promise }), second = fixture();
  const result = first.unsubscribe(request); await tick();
  assert.equal((await second.unsubscribe(request)).status, 'busy');
  assert.deepEqual(second.calls.resolve, []);
  gate.resolve(false); assert.equal((await result).status, 'cancelled');
  assert.equal((await second.unsubscribe(request)).status, 'opened');
});

test('open uncertainty is reported without retry/fallback; generic pre-effect failures clear pending guard', async () => {
  let opens = 0;
  const f = fixture({ openExternal: async () => { opens++; throw new Error('could already be open ' + web); } });
  const result = await f.unsubscribe(request);
  assert.equal(result.status, 'uncertain'); assert.equal(opens, 1);
  assert.match(result.message, /Check it before trying again/);
  assert.ok(!JSON.stringify(result).includes(web));
  const broken = fixture({ resolve: async () => { throw new Error('missing account'); } });
  assert.equal((await broken.unsubscribe(request)).status, 'error');
  assert.equal((await fixture().unsubscribe(request)).status, 'opened');
});
