'use strict';

// Invoked only by an authorized release workflow; no credential discovery.
// The approved trust root is committed source, never an environment override.
const { createManifest } = require('./create-update-manifest');
const { preflight } = require('./release-preflight');
const { macZipName } = require('../host/update-manifest');
const path = require('node:path');

async function signRelease({ artifact, outputDir, privateKey, publicKey, version, ref, sha }) {
  preflight({ publicKey, signingKeyPresent: Boolean(privateKey), version, ref, sha });
  return createManifest({ artifact, outputDir, privateKey, publicKey, version });
}
if (require.main === module) {
  const privateKey = Buffer.from(process.env.MORROW_UPDATE_SIGNING_KEY || '', 'utf8');
  delete process.env.MORROW_UPDATE_SIGNING_KEY;
  const version = require('../package.json').version;
  const artifact = path.join('dist', macZipName('arm64'));
  signRelease({ artifact, outputDir: path.join('dist', 'signed-update-manifest'), privateKey,
    publicKey: require('../host/update-trust').publicKey, version,
    ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA
  }).then(() => console.log('Release manifest signed and verified against committed public key.'))
    .catch(() => { console.error('Release signing failed; no manifest may be published. Check approved key pairing, artifact and release version.'); process.exitCode = 1; })
    .finally(() => privateKey.fill(0));
}
module.exports = { signRelease };
