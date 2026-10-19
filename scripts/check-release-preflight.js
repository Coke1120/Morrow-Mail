'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { preflight } = require('./release-preflight');
const { signRelease } = require('./sign-release-manifest');
const { verifyReleaseMacos } = require('./verify-release-macos');
const { verifyManifest } = require('../host/update-manifest');

(async () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const base = { publicKey, signingKeyPresent: true, version: '0.2.6', ref: 'refs/heads/main', sha: 'a'.repeat(40) };
  assert.equal(preflight(base).version, '0.2.6');
  assert.equal(preflight({ ...base, ref: 'refs/tags/v0.2.6' }).sha, base.sha);
  assert.match(preflight(base).publicKeyFingerprint, /^[a-f0-9]{64}$/);
  for (const [field, value] of [
    ['publicKey', ''], ['publicKey', 'malformed'], ['publicKey', privateKey],
    ['signingKeyPresent', false], ['signingKeyPresent', 'true'],
    ['ref', 'refs/heads/feature'], ['ref', 'refs/tags/v0.2.5'],
    ['version', '0.2.6-alpha.1'], ['version', 'v0.2.6'], ['sha', 'HEAD'], ['sha', '']
  ]) assert.throws(() => preflight({ ...base, [field]: value }));
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => preflight({ ...base, publicKey: rsa.publicKey.export({ type: 'spki', format: 'pem' }) }), /Ed25519/);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'morrow-release-fixture-'));
  try {
    const artifact = path.join(temporary, 'test.zip');
    await fs.writeFile(artifact, Buffer.from('ephemeral artifact fixture'));
    const outputDir = path.join(temporary, 'manifest');
    await signRelease({ ...base, artifact, outputDir, privateKey });
    const bytes = await fs.readFile(path.join(outputDir, 'update-manifest-macos-arm64.json'));
    const signature = await fs.readFile(path.join(outputDir, 'update-manifest-macos-arm64.json.sig'), 'utf8');
    assert.equal(verifyManifest(bytes, signature, { publicKey, currentVersion: '0.2.5', platform: 'darwin', arch: 'arm64' }).version, '0.2.6');
    const other = crypto.generateKeyPairSync('ed25519');
    await assert.rejects(signRelease({ ...base, artifact, outputDir: path.join(temporary, 'mismatch'), privateKey: other.privateKey.export({ type: 'pkcs8', format: 'pem' }) }), /does not match/);
    await assert.rejects(signRelease({ ...base, artifact, outputDir: path.join(temporary, 'missing'), privateKey: '' }), /secret/);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }

  let extractedPath;
  let verified = false;
  let assessed = false;
  await verifyReleaseMacos({ artifact: 'fixture.zip', version: '0.2.6',
    extract: async (file, destination) => {
      assert.equal(file, 'fixture.zip');
      extractedPath = destination;
      await fs.mkdir(destination);
      return path.join(destination, 'Morrow Mail.app');
    },
    verify: async (bundle, options) => {
      verified = true;
      assert.equal(bundle, path.join(extractedPath, 'Morrow Mail.app'));
      assert.deepEqual(options, { version: '0.2.6', arch: 'arm64' });
    },
    assess: async bundle => {
      assert.equal(verified, true, 'Integrity must pass before policy assessment');
      assert.equal(bundle, path.join(extractedPath, 'Morrow Mail.app'));
      assessed = true;
    }
  });
  assert.equal(verified, true);
  assert.equal(assessed, true);
  await assert.rejects(fs.stat(path.dirname(extractedPath)), { code: 'ENOENT' });
  await assert.rejects(verifyReleaseMacos({ artifact: 'fixture.zip', version: '0.2.6',
    extract: async (file, destination) => { extractedPath = destination; throw new Error('unsafe archive'); },
    verify: async () => assert.fail('Invalid archive must not reach codesign')
  }), /unsafe archive/);
  await assert.rejects(fs.stat(path.dirname(extractedPath)), { code: 'ENOENT' });

  for (const reason of ['Gatekeeper rejected', 'Gatekeeper timed out']) {
    await assert.rejects(verifyReleaseMacos({ artifact: 'fixture.zip', version: '0.2.6',
      extract: async (_file, destination) => {
        extractedPath = destination;
        await fs.mkdir(destination);
        return path.join(destination, 'Morrow Mail.app');
      },
      verify: async () => {},
      assess: async () => { throw new Error(reason); }
    }), new RegExp(reason));
    await assert.rejects(fs.stat(path.dirname(extractedPath)), { code: 'ENOENT' });
  }
  await assert.rejects(verifyReleaseMacos({ artifact: 'fixture.zip', version: '0.2.6',
    extract: async () => '/fixture.app',
    verify: async () => { throw new Error('broken seal'); },
    assess: async () => assert.fail('Broken seals must not reach policy assessment')
  }), /broken seal/);

  // Structural regression checks for authority boundaries and release ordering.
  const workflow = await fs.readFile(path.join(__dirname, '..', '.github/workflows/release.yml'), 'utf8');
  const windows = workflow.split('\n  windows:\n')[1].split('\n  macos:\n')[0];
  assert.ok(!windows.includes('MORROW_UPDATE_SIGNING_KEY:'));
  assert.ok(windows.includes("SIGNING_KEY_AVAILABLE: ${{ secrets.MORROW_UPDATE_SIGNING_KEY != '' }}"));
  assert.ok(windows.indexOf('release-preflight.js') < windows.indexOf('npm ci'));
  assert.ok(!workflow.includes('--publish always'));
  assert.equal((workflow.match(/runs-on:/g) || []).length, 2);
  assert.ok(workflow.includes('needs: windows'));
  assert.ok(workflow.includes('dist:win -- --publish never'));
  assert.ok(workflow.includes('dist:mac -- --arm64 --publish never'));
  assert.ok(workflow.indexOf('verify-release-macos.js') < workflow.indexOf('sign-release-manifest.js'));
  assert.ok(workflow.indexOf('sign-release-manifest.js') < workflow.indexOf('Publish and verify paired release'));
  assert.ok(workflow.indexOf('actions/download-artifact@v4') < workflow.indexOf('Publish and verify paired release'));
  console.log('Release preflight and signing checks passed (ephemeral fixture keys only)');
})().catch(error => { console.error(error); process.exitCode = 1; });
