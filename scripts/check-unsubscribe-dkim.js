// Synthetic original MIME and ephemeral signing keys only. DNS is injected;
// these fixtures never contact providers, public DNS or unsubscribe endpoints.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { dkimSign } = require('mailauth/lib/dkim/sign');
const { verifyOneClick, MAX_SOURCE_BYTES } = require('../host/mail/unsubscribe-dkim');
const now = new Date('2026-11-12T07:00:00Z');
const signing = new Date(now.getTime() - 60000);
const expires = new Date(now.getTime() + 3600000);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'der' } });
const record = 'v=DKIM1; k=rsa; p=' + publicKey.toString('base64');
const url = 'https://lists.example.net/unsubscribe?token=synthetic';
const fields = ['from', 'to', 'subject', 'date', 'list-unsubscribe', 'list-unsubscribe-post'];
const raw = (list = '<' + url + '>', post = 'List-Unsubscribe=One-Click', extra = '') => Buffer.from(
  'From: Example List <news@example.net>\r\nTo: reader@example.org\r\nSubject: Synthetic newsletter\r\n' +
  'Date: Thu, 12 Nov 2026 06:59:00 +0000\r\n' +
  'List-Unsubscribe: ' + list + '\r\nList-Unsubscribe-Post: ' + post + '\r\n' + extra + '\r\nSynthetic body.\r\n');
const resolver = async (name, type) => { assert.equal(name, 'test._domainkey.example.net'); assert.equal(type, 'TXT'); return [[record]]; };
async function signed(source = raw(), options = {}, signature = {}) {
  const result = await dkimSign(source, { signTime: signing, expires, headerList: fields, strict: true,
    ...options, signatureData: [{ signingDomain: 'example.net', selector: 'test', privateKey, ...signature }] });
  assert.equal(result.errors.length, 0);
  return Buffer.concat([Buffer.from(result.signatures), source]);
}
const verify = (source, opts = {}) => verifyOneClick(source, { resolver, now, ...opts });

test('full original valid RSA DKIM covers both headers in relaxed and simple modes', async () => {
  for (const canonicalization of ['relaxed/relaxed', 'simple/simple']) {
    assert.deepEqual(await verify(await signed(raw(), { canonicalization })), { verified: true, url, domain: 'example.net' });
  }
});

test('Ed25519/SHA256 can verify, while weak RSA and SHA1 cannot authorize POST', async () => {
  const ed = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'der' } });
  const edMessage = await signed(raw(), {}, { privateKey: ed.privateKey, algorithm: 'ed25519-sha256' });
  assert.equal((await verify(edMessage, { resolver: async () => [['v=DKIM1; k=ed25519; p=' + ed.publicKey.subarray(-32).toString('base64')]] })).verified, true);
  const weak = generateKeyPairSync('rsa', { modulusLength: 512, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'der' } });
  const weakMessage = await signed(raw(), { strict: false }, { privateKey: weak.privateKey });
  assert.equal((await verify(weakMessage, { resolver: async () => [['v=DKIM1; k=rsa; p=' + weak.publicKey.toString('base64')]] })).verified, false);
  assert.equal((await verify(await signed(raw(), { strict: false, algorithm: 'rsa-sha1' }))).verified, false);
});

test('optional mailto and folded list headers remain eligible', async () => {
  for (const value of ['<' + url + '>, <mailto:leave@example.net>', '<mailto:leave@example.net>,\r\n\t<' + url + '>']) {
    assert.equal((await verify(await signed(raw(value)))).verified, true);
  }
});

test('tampered body, list destination, post value, From or signature cannot pass', async () => {
  const good = (await signed()).toString();
  for (const bad of [good.replace('Synthetic body.', 'Modified body.'),
    good.replace('token=synthetic', 'token=attacker'), good.replace('List-Unsubscribe=One-Click', 'List-Unsubscribe=Other'),
    good.replace('news@example.net', 'attacker@example.net'), good.replace(/b=([A-Za-z0-9])/, (_, x) => 'b=' + (x === 'A' ? 'B' : 'A'))]) {
    assert.equal((await verify(Buffer.from(bad))).verified, false);
  }
});

test('a cryptographic pass without either list header covered is insufficient', async () => {
  for (const missing of ['list-unsubscribe', 'list-unsubscribe-post']) {
    assert.equal((await verify(await signed(raw(), { headerList: fields.filter(field => field !== missing) }))).verified, false);
  }
});

test('expiry, future timestamps, partial-body l= and test-mode DNS keys stay manual', async () => {
  assert.equal((await verify(await signed(raw(), { signTime: new Date(now.getTime() - 7200000), expires: signing }))).verified, false);
  assert.equal((await verify(await signed(raw(), { signTime: new Date(now.getTime() + 60000) }))).verified, false);
  for (const maxBodyLength of [0, 5, Buffer.byteLength('Synthetic body.\r\n')]) {
    assert.equal((await verify(await signed(raw(), {}, { maxBodyLength }))).verified, false);
  }
  assert.equal((await verify(await signed(), { resolver: async () => [[record + '; t=y']] })).verified, false);
});

test('missing or ambiguous list headers and unsupported destinations fail before DNS', async () => {
  let queries = 0;
  const noDns = async () => { queries++; return [[record]]; };
  for (const source of [raw('<' + url + '>, <' + url + '>'), raw('<' + url + '>, <https://other.example.net/u>'),
    raw('<http://lists.example.net/u>'), raw('<' + url + '>, <ftp://lists.example.net/u>'), raw('<https://127.0.0.1/u>'),
    raw('<' + url + '>', 'List-Unsubscribe=One-Click', 'List-Unsubscribe: <' + url + '>\r\n'),
    raw('<' + url + '>', 'List-Unsubscribe=One-Click', 'List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n'),
    raw('<' + url + '>', 'List-Unsubscribe=One-Click', 'From: Another <other@example.net>\r\n')]) {
    const input = await signed(source);
    assert.equal((await verify(input, { resolver: noDns })).verified, false);
  }
  assert.equal(queries, 0);
  assert.equal((await verify(raw(), { resolver: noDns })).verified, false);
});

test('forged Authentication-Results and malformed signatures are never proof', async () => {
  const forged = raw('<' + url + '>', 'List-Unsubscribe=One-Click',
    'Authentication-Results: trusted.example.net; dkim=pass header.d=example.net\r\n' +
    'DKIM-Signature: v=1; a=rsa-sha256; d=example.net; s=test; h=from:list-unsubscribe:list-unsubscribe-post; bh=bogus; b=bogus\r\n');
  assert.equal((await verify(forged)).verified, false);
  assert.equal((await verify(Buffer.from(forged.toString().replace('DKIM-Signature:', 'X-DKIM-Signature:')))).verified, false);
});

test('bounded source/header/signature admission rejects before DNS', async () => {
  let queries = 0;
  const noDns = async () => { queries++; return [[record]]; };
  const good = await signed();
  const header = good.subarray(0, good.indexOf('From:'));
  const tooMany = Buffer.concat([...Array(9).fill(header), raw()]);
  for (const input of [null, {}, good.toString(), Buffer.alloc(MAX_SOURCE_BYTES + 1),
    Buffer.from('X-Huge: ' + 'a'.repeat(65536) + '\r\n' + good), tooMany,
    Buffer.from(good.toString().replace(/\r\n/g, '\n')), Buffer.from(good.toString().replace('Subject:', '\0Subject:'))]) {
    assert.equal((await verify(input, { resolver: noDns })).verified, false);
  }
  assert.equal(queries, 0);
});

test('DNS refusal, revoked/wrong key and oversized/malformed answers do not verify', async () => {
  const source = await signed();
  const { publicKey: other } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' } });
  for (const response of [[], [['v=DKIM1; p=']], [['v=DKIM1; k=rsa; p=' + other.toString('base64')]],
    ['not TXT chunks'], [['x'.repeat(16385)]], Array(33).fill([record])]) {
    assert.equal((await verify(source, { resolver: async () => response })).verified, false);
  }
  assert.equal((await verify(source, { resolver: async () => { throw new Error('synthetic DNS failure'); } })).verified, false);
});

test('total deadline refuses a slow DNS result without late verification', async () => {
  const source = await signed();
  let settle;
  const pending = new Promise(resolve => { settle = resolve; });
  const result = await verify(source, { resolver: () => pending, timeoutMs: 10 });
  assert.equal(result.verified, false);
  settle([[record]]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(result, { verified: false, reason: 'One-click verification unavailable. Use a reviewed alternative.' });
});

test('an independent valid covered signature can qualify when another signature fails', async () => {
  const valid = await signed();
  const invalid = Buffer.from('DKIM-Signature: v=1; a=rsa-sha256; d=example.net; s=test; h=from; bh=bad; b=bad\r\n');
  assert.equal((await verify(Buffer.concat([invalid, valid]))).verified, true);
});
