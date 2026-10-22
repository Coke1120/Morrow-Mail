'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { extractZip, verifyBundle, assessBundleTrust } = require('../host/update-installer');
const { macZipName } = require('../host/update-manifest');

async function verifyReleaseMacos({ artifact, version, extract = extractZip, verify = verifyBundle, assess = assessBundleTrust, tempRoot = os.tmpdir() }) {
  // macOS TMPDIR may use /var while realpath resolves /private/var. Anchor
  // extraction at the canonical directory so internal links compare correctly.
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(tempRoot, 'morrow-release-verify-')));
  try {
    const bundle = await extract(artifact, path.join(temporary, 'extracted'));
    await verify(bundle, { version, arch: 'arm64' });
    // Distribution authenticates bytes; it never grants execution permission.
    // Ad hoc releases remain distributable for user-mediated installation.
    try {
      await assess(bundle);
      return { integrity: 'verified', platformTrust: 'accepted-on-build-host' };
    } catch (error) {
      if (error.code !== 'UPDATE_MANUAL_TRUST') throw error;
      return { integrity: 'verified', platformTrust: 'manual-review-required' };
    }
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
    verifyReleaseMacos({ artifact: path.join('dist', macZipName('arm64')), version })
      .then(result => {
        console.log('Extracted release ZIP passed path, bundle identity, architecture and strict integrity checks.');
        console.log(`Build-host policy assessment: ${result.platformTrust}. Distribution is ad hoc, without Apple notarization; installation remains subject to each Mac and user approval.`);
      })
      .catch(error => {
        // This CLI refuses signing credentials above; report bounded native/path
        // diagnostics without dumping environments or archive contents.
        const detail = String(error.message || error).replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 2000);
        console.error('Native archive verification failed; do not sign or publish this release. ' + detail);
        process.exitCode = 1;
      });
  }
}
module.exports = { verifyReleaseMacos };
