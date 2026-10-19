'use strict';

const crypto = require('node:crypto');

function preflight({ publicKey, signingKeyPresent, version, ref, sha }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version || '')) {
    throw new Error('Release requires a stable package version.');
  }
  if (ref !== 'refs/heads/main' && ref !== `refs/tags/v${version}`) {
    throw new Error('Release must use main or the matching version tag.');
  }
  if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('Release requires an exact source commit.');
  if (typeof publicKey !== 'string' || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----\s*$/.test(publicKey)) {
    throw new Error('No approved public release key is committed.');
  }
  let key;
  try { key = crypto.createPublicKey(publicKey); } catch { throw new Error('Committed release public key is invalid.'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Committed release public key must be Ed25519.');
  if (signingKeyPresent !== true) throw new Error('Required release signing secret is not configured.');
  return { version, sha, publicKeyFingerprint: crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex') };
}

if (require.main === module) {
  try {
    const result = preflight({
      publicKey: require('../host/update-trust').publicKey,
      signingKeyPresent: process.env.SIGNING_KEY_AVAILABLE === 'true',
      version: require('../package.json').version,
      ref: process.env.GITHUB_REF,
      sha: process.env.GITHUB_SHA
    });
    console.log(`Release preflight passed: ${result.version} at ${result.sha}; public key SHA256 ${result.publicKeyFingerprint}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { preflight };
