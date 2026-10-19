'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { verifyManifest, artifactURL, validateArtifact, compareVersions } = require('../host/update-manifest');
const { allowedURL, fetchBytes, downloadArtifact, recordInternetDownload } = require('../host/update-download');

async function main() {
  const attrs = new Map(); let writes = 0;
  const xattr = async (_tool, args) => {
    if (args.length === 1) return { stdout: attrs.has(args[0]) ? 'com.apple.quarantine\n' : '' };
    if (args[0] === '-w') { writes++; attrs.set(args[3], args[2]); return { stdout: '' }; }
    return { stdout: attrs.get(args[2]) || '' };
  };
  await recordInternetDownload('/fixture.zip', { platform: 'darwin', run: xattr });
  assert.match(attrs.get('/fixture.zip'), /^0083;[a-f0-9]+;Morrow Mail;/);
  await recordInternetDownload('/fixture.zip', { platform: 'darwin', run: xattr });
  assert.equal(writes, 1, 'existing quarantine is retained');
  attrs.set('/fixture.zip', '0082;12345678;Safari;existing');
  await recordInternetDownload('/fixture.zip', { platform: 'darwin', run: xattr });
  assert.equal(writes, 1, 'Do not overwrite system-managed approval/quarantine flags');
  assert.equal(attrs.get('/fixture.zip'), '0082;12345678;Safari;existing');
  await assert.rejects(recordInternetDownload('/fixture.zip', { platform: 'darwin', run: async () => ({ stdout: '' }) }), /quarantine/);
  await assert.rejects(recordInternetDownload('/fixture.zip', { platform: 'darwin', run: async () => { throw Error('xattr denied'); } }), /denied/);
  // Ephemeral test-only roots: never written to disk or reused by the application.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const body = Buffer.from('fixture archive bytes');
  const manifest = { schemaVersion: 1, version: '0.2.6', platform: 'darwin', arch: 'arm64', url: artifactURL('0.2.6', 'arm64'), size: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') };
  const opts = { publicKey: pem, currentVersion: '0.2.5', platform: 'darwin', arch: 'arm64' };
  const sign = value => { const bytes = Buffer.from(JSON.stringify(value)); return [bytes, crypto.sign(null, bytes, privateKey).toString('base64')]; };
  const verify = (value, overrides = {}) => verifyManifest(...sign(value), { ...opts, ...overrides });
  assert.deepEqual(verify(manifest), manifest);
  assert.equal(compareVersions('99999999999999999999.0.0', '4.0.0'), 1);
  const [bytes, signature] = sign(manifest);
  assert.throws(() => verifyManifest(Buffer.from(bytes.toString().replace('0.2.6', '0.2.7')), signature, opts));
  assert.throws(() => verifyManifest(bytes, Buffer.alloc(64).toString('base64'), opts));
  assert.throws(() => verify(manifest, { publicKey: null }));
  assert.throws(() => verify(manifest, { publicKey: crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) }));
  for (const change of [{ arch: 'x64' }, { platform: 'win32' }, { version: '0.2.5' }, { version: '0.2.4' }, { version: '0.2.6-beta.1' }, { size: -1 }, { size: 751 * 1024 * 1024 }, { sha256: '0' }, { extra: true }, { url: manifest.url.replace('Coke1120', 'attacker') }]) assert.throws(() => verify({ ...manifest, ...change }));
  assert.throws(() => verify(manifest, { highestAcceptedVersion: '0.2.6' }));
  assert.throws(() => verify(manifest, { expectedVersion: '0.2.7' }));
  const installed = { ...manifest, version: '0.2.5', url: artifactURL('0.2.5', 'arm64') };
  assert.throws(() => verify(installed), error => error.code === 'UPDATE_NOT_NEWER');
  assert.throws(() => verify({ ...installed, size: 0 }), error => error.code !== 'UPDATE_NOT_NEWER');
  for (const url of ['http://github.com/x', manifest.url + '?x=1', manifest.url + '#x', manifest.url.replace('github.com', 'github.com.attacker.test'), manifest.url.replace('https://', 'https://user:pass@'), manifest.url.replace('Morrow-Mail-0.2.6', '../Morrow-Mail-0.2.6'), 'https://release-assets.githubusercontent.com/unrelated']) assert.throws(() => allowedURL(url, true));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'morrow-manifest-test-'));
  const request = (chunks, headers = {}, statusCode = 200) => (_url, _options, callback) => {
    const req = new EventEmitter();
    process.nextTick(() => { const response = Readable.from(chunks); response.statusCode = statusCode; response.headers = headers; callback(response); });
    return req;
  };
  try {
    const file = await downloadArtifact(manifest, { directory: dir, request: request([body]) });
    assert.equal(await validateArtifact(file, manifest), true);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
      assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
    } else {
      console.log('SKIP: POSIX file mode assertions on Windows; signed Mac updater permissions require macOS validation.');
    }
    await fs.rm(path.dirname(file), { recursive: true });
    for (const chunks of [[Buffer.from('wrong hash same size!')], [body.subarray(0, 3)], [Buffer.concat([body, body])]]) {
      await assert.rejects(downloadArtifact(manifest, { directory: dir, request: request(chunks) }));
      assert.deepEqual(await fs.readdir(dir), []);
    }
    async function* interrupted() { yield body.subarray(0, 3); throw new Error('connection interrupted'); }
    await assert.rejects(downloadArtifact(manifest, { directory: dir, request: request(interrupted()) }));
    assert.deepEqual(await fs.readdir(dir), []);
    await assert.rejects(downloadArtifact(manifest, { directory: dir, request: request([body], { 'content-length': String(body.length + 1) }) }));
    await assert.rejects(downloadArtifact(manifest, { directory: dir, request: request([], { location: 'https://attacker.test/update' }, 302) }));
    const signal = AbortSignal.abort();
    await assert.rejects(downloadArtifact(manifest, { directory: dir, request: request([body]), signal }));
    assert.deepEqual(await fs.readdir(dir), []);
    const metadata = 'https://github.com/Coke1120/Morrow-Mail/releases/latest/download/update-manifest-macos-arm64.json';
    assert.deepEqual(await fetchBytes(metadata, { maxBytes: 100, request: request([body]) }), body);
    await assert.rejects(fetchBytes(metadata, { maxBytes: 3, request: request([body]) }));
    let calls = 0;
    const redirected = (url, options, callback) => {
      calls++;
      if (calls === 1) return request([], { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/1/fixture?signature=test' }, 302)(url, options, callback);
      return request([body])(url, options, callback);
    };
    assert.deepEqual(await fetchBytes(metadata, { maxBytes: 100, request: redirected }), body);
    assert.equal(calls, 2);
    await assert.rejects(fetchBytes(metadata, { maxBytes: 100, request: request([], { location: metadata }, 302) }));
    const stalled = (_url, options) => {
      const req = new EventEmitter();
      options.signal.addEventListener('abort', () => req.emit('error', new Error('aborted')), { once: true });
      return req;
    };
    await assert.rejects(downloadArtifact(manifest, { directory: dir, request: stalled, timeoutMs: 5 }));
    assert.deepEqual(await fs.readdir(dir), []);
    await assert.rejects(downloadArtifact(manifest, { directory: dir, request: request([body]), quarantine: async () => { throw Error('quarantine denied'); } }), /quarantine denied/);
    assert.deepEqual(await fs.readdir(dir), [], 'unquarantined downloads cannot be returned');
    const corrupt = path.join(dir, 'corrupt.zip'); await fs.writeFile(corrupt, Buffer.alloc(body.length));
    await assert.rejects(validateArtifact(corrupt, manifest));
    if (process.platform !== 'win32') {
      const valid = path.join(dir, 'valid.zip'); await fs.writeFile(valid, body);
      const link = path.join(dir, 'symlink.zip'); await fs.symlink(valid, link);
      await assert.rejects(validateArtifact(link, manifest));
    } else {
      console.log('SKIP: POSIX O_NOFOLLOW/symlink test on Windows; requires native macOS verification.');
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
  console.log('Signed update manifest and constrained downloads checks passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
