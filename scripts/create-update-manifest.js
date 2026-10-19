#!/usr/bin/env node
'use strict';

// Offline publisher. Never discovers credentials or creates a trust root.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Writable } = require('node:stream');
const { ARCHIVE_LIMIT, artifactURL } = require('../host/update-manifest');
const MANIFEST_NAME = 'update-manifest-macos-arm64.json';
const SIGNATURE_NAME = 'update-manifest-macos-arm64.json.sig';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

async function createManifest({ artifact, version, privateKey, publicKey, outputDir }) {
  if (typeof version !== 'string' || version.length > 80 || !VERSION.test(version)) throw new Error('A stable major.minor.patch version is required');
  let signer;
  let verifier;
  try {
    signer = crypto.createPrivateKey(privateKey);
    verifier = crypto.createPublicKey(publicKey);
  } catch { throw new Error('Explicit valid signing and verification keys are required'); }
  if (signer.asymmetricKeyType !== 'ed25519' || verifier.asymmetricKeyType !== 'ed25519') {
    throw new Error('Only Ed25519 keys are accepted');
  }
  const derived = crypto.createPublicKey(signer).export({ type: 'spki', format: 'der' });
  const expected = verifier.export({ type: 'spki', format: 'der' });
  if (!derived.equals(expected)) throw new Error('Signing key does not match the approved public key');
  const handle = await fs.promises.open(artifact, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let size;
  let sha256;
  try {
    const before = await handle.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size <= 0 || before.size > ARCHIVE_LIMIT) {
      throw new Error('Artifact must be a nonempty regular file no larger than 750 MiB');
    }
    const hash = crypto.createHash('sha256');
    let count = 0;
    await pipeline(handle.createReadStream({ autoClose: false }), new Writable({
      write(chunk, encoding, done) { count += chunk.length; hash.update(chunk); done(); }
    }));
    const after = await handle.stat();
    if (count !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Artifact changed while hashing');
    }
    size = count;
    sha256 = hash.digest('hex');
  } finally { await handle.close(); }
  const manifest = {
    schemaVersion: 1, version, platform: 'darwin', arch: 'arm64',
    url: artifactURL(version, 'arm64'),
    size, sha256
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const signature = crypto.sign(null, bytes, signer);
  if (!crypto.verify(null, bytes, verifier, signature)) throw new Error('Generated signature verification failed');
  // A fresh directory prevents replacing an existing signed release pair.
  await fs.promises.mkdir(outputDir, { mode: 0o700 });
  try {
    await fs.promises.writeFile(path.join(outputDir, MANIFEST_NAME), bytes, { flag: 'wx', mode: 0o644 });
    await fs.promises.writeFile(path.join(outputDir, SIGNATURE_NAME), `${signature.toString('base64')}\n`, { flag: 'wx', mode: 0o644 });
  } catch (error) {
    // Preserve partial output for investigation. It must never be published.
    throw new Error(`Manifest output incomplete (${error.code || 'write failed'}); do not publish this directory`);
  }
  return manifest;
}

async function main(argv) {
  const accepted = new Set(['artifact', 'version', 'private-key', 'public-key', 'out-dir', 'package-json']);
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!argv[i]?.startsWith('--') || !accepted.has(key) || !argv[i + 1] || Object.hasOwn(args, key)) {
      throw new Error('Usage: --artifact PATH --version VERSION --private-key PATH --public-key PATH --out-dir NEW_DIRECTORY [--package-json PATH]');
    }
    args[key] = argv[i + 1];
  }
  for (const key of ['artifact', 'version', 'private-key', 'public-key', 'out-dir']) {
    if (!args[key]) throw new Error(`Missing required --${key}`);
  }
  const pkg = JSON.parse(await fs.promises.readFile(args['package-json'] || path.join(__dirname, '..', 'package.json'), 'utf8'));
  if (pkg.version !== args.version) throw new Error('Package version does not match requested release version');
  // These paths are explicitly supplied by the release operator. No env/key discovery.
  const privateKey = await fs.promises.readFile(args['private-key']);
  const publicKey = await fs.promises.readFile(args['public-key']);
  try {
    const result = await createManifest({ artifact: args.artifact, version: args.version, privateKey, publicKey, outputDir: args['out-dir'] });
    process.stdout.write(`Created signed macOS ARM64 manifest for ${result.version} (${result.size} bytes)\n`);
  } finally { privateKey.fill(0); }
}
if (require.main === module) main(process.argv.slice(2)).catch(() => {
  // Avoid printing key material, filesystem content, or crypto parser diagnostics.
  process.stderr.write('Manifest generation failed. Check explicit arguments, version, Ed25519 key pair, artifact, and a fresh output directory. No upload was attempted.\n');
  process.exitCode = 1;
});
module.exports = { createManifest, MANIFEST_NAME, SIGNATURE_NAME };
