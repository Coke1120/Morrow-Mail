'use strict';
// Offline staging: allowlisted filenames and content digests only. No upload.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const { verifyManifest, validateArtifact } = require('../host/update-manifest');
async function digest(file, algorithm = 'sha256', encoding = 'hex') {
  const handle = await fs.open(file, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024 * 1024) throw Error('Invalid release asset.');
    const hash = crypto.createHash(algorithm);
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return { size: stat.size, hash: hash.digest(encoding) };
  } finally { await handle.close(); }
}
function namesFor(platform, version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw Error('Stable version required.');
  if (platform === 'windows') return [`Morrow-Mail-Setup-${version}.exe`, `Morrow-Mail-Setup-${version}.exe.blockmap`, `Morrow-Mail-${version}.exe`, 'latest.yml'];
  if (platform === 'macos') return [`Morrow-Mail-${version}-arm64-mac.zip`, `Morrow-Mail-${version}-arm64-mac.zip.blockmap`, 'latest-mac.yml', 'update-manifest-macos-arm64.json', 'update-manifest-macos-arm64.json.sig'];
  throw Error('Unknown release platform.');
}
async function validateFeed(directory, platform, version) {
  const name = platform === 'windows' ? 'latest.yml' : 'latest-mac.yml';
  const bytes = await fs.readFile(path.join(directory, name));
  if (bytes.length > 16384) throw Error('Oversized updater feed.');
  const feed = yaml.load(bytes.toString(), { schema: yaml.JSON_SCHEMA });
  const primary = namesFor(platform, version)[0];
  const actual = await digest(path.join(directory, primary), 'sha512', 'base64');
  if (!feed || feed.version !== version || feed.path !== primary || feed.sha512 !== actual.hash ||
      !Array.isArray(feed.files) || feed.files.length !== 1 || feed.files[0].url !== primary ||
      feed.files[0].sha512 !== actual.hash || feed.files[0].size !== actual.size) throw Error('Updater feed does not match final artifact.');
}
async function validateMacManifest(directory, version, publicKey) {
  const bytes = await fs.readFile(path.join(directory, 'update-manifest-macos-arm64.json'));
  const sig = await fs.readFile(path.join(directory, 'update-manifest-macos-arm64.json.sig'), 'utf8');
  const manifest = verifyManifest(bytes, sig, { publicKey, currentVersion: '0.0.0', expectedVersion: version, platform: 'darwin', arch: 'arm64' });
  await validateArtifact(path.join(directory, namesFor('macos', version)[0]), manifest);
}
async function prepare({ platform, version, commit, runId, runAttempt, dist = 'dist', output, publicKey }) {
  if (!/^[a-f0-9]{40}$/.test(commit || '') || !/^\d+$/.test(String(runId)) || !/^\d+$/.test(String(runAttempt))) throw Error('Release provenance is missing.');
  const names = namesFor(platform, version);
  await fs.mkdir(output, { mode: 0o700 });
  const available = await fs.readdir(dist);
  for (const name of names) {
    const source = name.startsWith('update-manifest-') ? path.join(dist, 'signed-update-manifest', name) : (() => {
      // electron-builder uses spaces locally; GitHub feeds use dashed names.
      const matches = available.filter(local => local.replace(/ /g, '-') === name);
      if (matches.length !== 1) throw Error('Missing or ambiguous release asset: ' + name);
      return path.join(dist, matches[0]);
    })();
    if (!(await fs.lstat(source)).isFile()) throw Error('Release asset must be a regular file.');
    await fs.copyFile(source, path.join(output, name), require('node:fs').constants.COPYFILE_EXCL);
  }
  await validateFeed(output, platform, version);
  if (platform === 'macos') await validateMacManifest(output, version, publicKey);
  const files = [];
  for (const name of names) { const data = await digest(path.join(output, name)); files.push({ name, size: data.size, sha256: data.hash }); }
  const provenance = { schemaVersion: 1, platform, version, commit, runId: String(runId), runAttempt: String(runAttempt), files };
  await fs.writeFile(path.join(output, `release-provenance-${platform}.json`), JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
  return provenance;
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--platform' || args[2] !== '--output') throw Error('Expected --platform windows|macos --output NEW_DIRECTORY');
  await fs.mkdir(path.dirname(args[3]), { recursive: true });
  await prepare({ platform: args[1], output: args[3], version: require('../package.json').version,
    commit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    publicKey: require('../host/update-trust').publicKey });
  console.log('Validated and staged ' + args[1] + ' release artifacts.');
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepare, namesFor, digest, validateFeed, validateMacManifest };
