'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { extractZip, verifyBundle } = require('../host/update-installer');

async function verifyReleaseMacos({ artifact, version, extract = extractZip, verify = verifyBundle }) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'morrow-release-verify-'));
  try {
    const bundle = await extract(artifact, path.join(temporary, 'extracted'));
    await verify(bundle, { version, arch: 'arm64' });
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
if (require.main === module) {
  const version = require('../package.json').version;
  if (process.platform !== 'darwin') {
    console.error('Native release verification requires macOS.');
    process.exitCode = 1;
  } else if (Object.hasOwn(process.env, 'MORROW_UPDATE_SIGNING_KEY')) {
    // This runs in a separate secret-free workflow step, before signing.
    console.error('Native verification must run without a release signing secret.');
    process.exitCode = 1;
  } else {
    verifyReleaseMacos({ artifact: path.join('dist', `Morrow Mail-${version}-arm64-mac.zip`), version })
      .then(() => console.log('Extracted release ZIP passed path, bundle identity, architecture and strict signature verification.'))
      .catch(() => { console.error('Native archive verification failed; do not sign or publish this release.'); process.exitCode = 1; });
  }
}
module.exports = { verifyReleaseMacos };
