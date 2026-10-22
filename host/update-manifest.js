'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const MANIFEST_LIMIT = 16384;
const ARCHIVE_LIMIT = 750 * 1024 * 1024;
const RELEASE_ROOT = 'https://github.com/Coke1120/Morrow-Mail/releases/';

function versionParts(value) {
  if (typeof value !== 'string' || value.length > 80 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('A stable update version is required.');
  return value.split('.').map(BigInt);
}
function compareVersions(a, b) {
  const aa = versionParts(a), bb = versionParts(b);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}
function macZipName(arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Unsupported update architecture.');
  return `Morrow-Mail-${arch}-mac.zip`;
}
function artifactURL(version, arch) {
  versionParts(version);
  return `${RELEASE_ROOT}download/v${version}/${macZipName(arch)}`;
}
function verifyManifest(bytes, signature, options = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MANIFEST_LIMIT) throw new Error('Invalid update manifest size.');
  if (typeof signature !== 'string' || signature.length > 100 || !/^[A-Za-z0-9+/]{86}==$/.test(signature.trim())) throw new Error('Invalid update signature.');
  if (!options.publicKey) throw new Error('Signed updates are unavailable: no trusted public key is configured.');
  const key = crypto.createPublicKey(options.publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || !crypto.verify(null, bytes, key, Buffer.from(signature.trim(), 'base64'))) throw new Error('Update signature verification failed.');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const fields = ['schemaVersion', 'version', 'platform', 'arch', 'url', 'size', 'sha256'];
  if (!value || Array.isArray(value) || Object.keys(value).sort().join() !== fields.sort().join()) throw new Error('Invalid update manifest schema.');
  if (value.schemaVersion !== 1 || value.platform !== 'darwin' || value.platform !== options.platform || !['arm64', 'x64'].includes(value.arch) || value.arch !== options.arch) throw new Error('Update platform or architecture mismatch.');
  if (options.expectedVersion && value.version !== options.expectedVersion) throw new Error('Update version mismatch.');
  if (value.url !== artifactURL(value.version, value.arch) || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > ARCHIVE_LIMIT || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('Invalid signed update artifact.');
  const order = compareVersions(value.version, options.currentVersion);
  if (order <= 0) { const error = new Error(order === 0 ? 'This signed release is already installed.' : 'Update downgrade rejected.'); error.code = order === 0 ? 'UPDATE_NOT_NEWER' : 'UPDATE_DOWNGRADE'; throw error; }
  if (options.highestAcceptedVersion && compareVersions(value.version, options.highestAcceptedVersion) <= 0) { const error = new Error('Update replay rejected.'); error.code = 'UPDATE_REPLAY'; throw error; }
  return Object.freeze(value);
}
async function validateArtifact(file, manifest) {
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== manifest.size || stat.size > ARCHIVE_LIMIT) throw new Error('Update artifact size mismatch.');
    const hash = crypto.createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { size += chunk.length; hash.update(chunk); }
    if (size !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new Error('Update artifact checksum mismatch.');
    return true;
  } finally { await handle.close(); }
}
module.exports = { MANIFEST_LIMIT, ARCHIVE_LIMIT, RELEASE_ROOT, compareVersions, macZipName, artifactURL, verifyManifest, validateArtifact };
