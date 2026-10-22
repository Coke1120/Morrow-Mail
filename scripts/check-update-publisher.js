'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { ARCHIVE_LIMIT, verifyManifest, validateArtifact } = require('../host/update-manifest');
const { createManifest, MANIFEST_NAME, SIGNATURE_NAME } = require('./create-update-manifest');

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'morrow-publisher-test-'));
  try {
    // Test-only ephemeral keys: never written into a production trust configuration.
    const pair = crypto.generateKeyPairSync('ed25519');
    const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
    const artifact = path.join(temp, 'fixture.zip');
    const payload = Buffer.from('Test bytes: publisher binds the final artifact; native ZIP validation is separate.');
    await fs.writeFile(artifact, payload);
    const base = { artifact, version: '0.2.6', privateKey, publicKey };
    const outputDir = path.join(temp, 'signed');
    const result = await createManifest({ ...base, outputDir });
    const bytes = await fs.readFile(path.join(outputDir, MANIFEST_NAME));
    const sig = Buffer.from((await fs.readFile(path.join(outputDir, SIGNATURE_NAME), 'utf8')).trim(), 'base64');
    assert.equal(crypto.verify(null, bytes, pair.publicKey, sig), true);
    assert.deepEqual(JSON.parse(bytes), result);
    const accepted = verifyManifest(bytes, sig.toString('base64'), { publicKey, currentVersion: '0.2.5', platform: 'darwin', arch: 'arm64' });
    assert.deepEqual(accepted, result);
    assert.equal(await validateArtifact(artifact, accepted), true);
    assert.equal(result.size, payload.length);
    assert.equal(result.sha256, crypto.createHash('sha256').update(payload).digest('hex'));
    assert.equal(result.url, 'https://github.com/Coke1120/Morrow-Mail/releases/download/v0.2.6/Morrow-Mail-arm64-mac.zip');
    assert.equal(crypto.verify(null, Buffer.concat([bytes, Buffer.from(' ')]), pair.publicKey, sig), false);
    const other = crypto.generateKeyPairSync('ed25519');
    assert.equal(crypto.verify(null, bytes, other.publicKey, sig), false);
    await assert.rejects(createManifest({ ...base, outputDir }), /EEXIST/);
    assert.deepEqual(await fs.readFile(path.join(outputDir, MANIFEST_NAME)), bytes);
    for (const version of ['0.2.6-alpha.1', 'v0.2.6', '../x', '01.2.6', '0.2', '0.2.6+build']) {
      await assert.rejects(createManifest({ ...base, version, outputDir: path.join(temp, 'invalid') }), /stable/);
    }
    await assert.rejects(createManifest({ ...base, publicKey: other.publicKey.export({ type: 'spki', format: 'pem' }), outputDir: path.join(temp, 'wrong-key') }), /does not match/);
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    await assert.rejects(createManifest({ ...base, privateKey: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey: rsa.publicKey.export({ type: 'spki', format: 'pem' }), outputDir: path.join(temp, 'rsa') }), /Ed25519/);
    const empty = path.join(temp, 'empty.zip');
    await fs.writeFile(empty, '');
    await assert.rejects(createManifest({ ...base, artifact: empty, outputDir: path.join(temp, 'empty') }), /nonempty/);
    const oversized = path.join(temp, 'oversized.zip');
    const sparse = await fs.open(oversized, 'w');
    await sparse.truncate(ARCHIVE_LIMIT + 1);
    await sparse.close();
    await assert.rejects(createManifest({ ...base, artifact: oversized, outputDir: path.join(temp, 'oversized') }), /750 MiB/);
    await assert.rejects(createManifest({ ...base, privateKey: '', outputDir: path.join(temp, 'missing-key') }), /keys are required/);
    if (process.platform !== 'win32') {
      const symlink = path.join(temp, 'symlink.zip');
      await fs.symlink(artifact, symlink);
      await assert.rejects(createManifest({ ...base, artifact: symlink, outputDir: path.join(temp, 'symlink-output') }));
    } else {
      console.log('SKIP POSIX symlink artifact assertion on Windows; manifest authentication and artifact integrity checks still run.');
    }
    // CLI version mismatch must fail before it even tries to read a key path.
    const pkgPath = path.join(temp, 'package.json');
    await fs.writeFile(pkgPath, JSON.stringify({ version: '0.2.5' }));
    const cli = spawnSync(process.execPath, [path.join(__dirname, 'create-update-manifest.js'), '--artifact', artifact,
      '--version', '0.2.6', '--private-key', 'NONEXISTENT_PRIVATE_KEY', '--public-key', 'NONEXISTENT_PUBLIC_KEY',
      '--out-dir', path.join(temp, 'cli'), '--package-json', pkgPath], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.equal(cli.stdout, '');
    assert.ok(!cli.stderr.includes('NONEXISTENT'));
    console.log('Signed update publisher checks passed');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
