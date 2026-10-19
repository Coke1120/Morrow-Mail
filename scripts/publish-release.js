'use strict';
// Invoked only by the authorized release workflow after both platform builds.
// API adapter is injected; tests never contact GitHub or inspect credentials.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { namesFor, digest, validateFeed, validateMacManifest } = require('./prepare-release-assets');
const { compareVersions } = require('../host/update-manifest');
async function verifyInputs({ artifactDirectory, version, sha, runId, runAttempt, publicKey }) {
  if (!publicKey || crypto.createPublicKey(publicKey).asymmetricKeyType !== 'ed25519') throw Error('Approved release public key required.');
  const assets = [];
  for (const platform of ['windows', 'macos']) {
    const directory = path.join(artifactDirectory, `release-${platform}`);
    const name = `release-provenance-${platform}.json`;
    const bytes = await fs.readFile(path.join(directory, name));
    if (bytes.length > 16384) throw Error('Oversized provenance.');
    const provenance = JSON.parse(bytes);
    const expected = namesFor(platform, version);
    if (provenance.schemaVersion !== 1 || provenance.platform !== platform || provenance.version !== version ||
        provenance.commit !== sha || provenance.runId !== String(runId) || provenance.runAttempt !== String(runAttempt) ||
        !Array.isArray(provenance.files) || provenance.files.length !== expected.length ||
        provenance.files.map(file => file.name).sort().join() !== expected.slice().sort().join()) throw Error('Unpaired release provenance.');
    if ((await fs.readdir(directory)).sort().join() !== [...expected, name].sort().join()) throw Error('Unexpected staged release file.');
    for (const file of provenance.files) {
      const fullPath = path.join(directory, file.name);
      if (!(await fs.lstat(fullPath)).isFile()) throw Error('Release asset cannot be a symlink.');
      const actual = await digest(fullPath);
      if (actual.size !== file.size || actual.hash !== file.sha256) throw Error('Release asset changed after staging.');
      assets.push({ name: file.name, path: fullPath, ...actual });
    }
    await validateFeed(directory, platform, version);
    if (platform === 'macos') await validateMacManifest(directory, version, publicKey);
    assets.push({ name, path: path.join(directory, name), ...(await digest(path.join(directory, name))) });
  }
  return assets;
}
async function maybe(call) { try { return (await call()).data; } catch (error) { if (error.status === 404) return null; throw error; } }
async function publishRelease({ github, context, artifactDirectory = 'staging',
  version = require('../package.json').version, publicKey = require('../host/update-trust').publicKey,
  runId = process.env.GITHUB_RUN_ID, runAttempt = process.env.GITHUB_RUN_ATTEMPT }) {
  const { owner, repo } = context.repo;
  if (owner !== 'Coke1120' || repo !== 'Morrow-Mail' || !/^[a-f0-9]{40}$/.test(context.sha || '') ||
      !['push', 'workflow_dispatch'].includes(context.eventName) ||
      (context.eventName === 'push' ? context.ref !== `refs/tags/v${version}` : context.ref !== 'refs/heads/main')) throw Error('Release context rejected.');
  const assets = await verifyInputs({ artifactDirectory, version, sha: context.sha, publicKey, runId, runAttempt });
  const tag = `v${version}`;
  const existing = await maybe(() => github.rest.repos.getReleaseByTag({ owner, repo, tag }));
  if (existing) throw Error('Release already exists; existing assets will not be replaced.');
  const latest = await maybe(() => github.rest.repos.getLatestRelease({ owner, repo }));
  if (latest && (!/^v\d+\.\d+\.\d+$/.test(latest.tag_name) || compareVersions(version, latest.tag_name.slice(1)) <= 0)) throw Error('Release downgrade or replay rejected.');
  const ref = await maybe(() => github.rest.git.getRef({ owner, repo, ref: `tags/${tag}` }));
  if (ref) {
    let object = ref.object;
    if (object.type === 'tag') object = (await github.rest.git.getTag({ owner, repo, tag_sha: object.sha })).data.object;
    if (object.type !== 'commit' || object.sha !== context.sha) throw Error('Release tag points to a different source commit.');
  }
  const notes = await github.rest.repos.generateReleaseNotes({ owner, repo, tag_name: tag, target_commitish: context.sha });
  const body = `${notes.data.body}\n\nmacOS update migration: Electron 0.2.4/0.2.5 requires one manual bridge installation. Subsequent macOS updates authenticate an Ed25519 manifest and retain a recovery backup. This authenticates release artifacts; it does not provide Apple Developer ID signing or notarization. Windows remains unsigned. See docs/SIGNED_UPDATES.md at this release tag for installation and recovery limits.\n\nSource: ${context.sha}\n`;
  const release = (await github.rest.repos.createRelease({ owner, repo, tag_name: tag, target_commitish: context.sha, name: version, body, draft: true, prerelease: false, make_latest: 'false' })).data;
  // Any failure from here preserves a private draft; never delete or overwrite
  // existing assets, and never promote an incompletely verified release.
  const uploaded = [];
  for (const asset of assets) {
    const data = await fs.readFile(asset.path);
    if (data.length !== asset.size || crypto.createHash('sha256').update(data).digest('hex') !== asset.hash) throw Error('Release asset changed before upload.');
    const remote = (await github.rest.repos.uploadReleaseAsset({ owner, repo, release_id: release.id, name: asset.name, data, headers: { 'content-type': 'application/octet-stream', 'content-length': data.length } })).data;
    if (remote.name !== asset.name || remote.size !== asset.size) throw Error('Uploaded asset metadata mismatch.');
    uploaded.push({ ...asset, id: remote.id });
  }
  const listed = await github.paginate(github.rest.repos.listReleaseAssets, { owner, repo, release_id: release.id, per_page: 100 });
  if (listed.map(item => item.name).sort().join() !== assets.map(item => item.name).sort().join()) throw Error('Draft asset set mismatch.');
  for (const asset of uploaded) {
    const response = await github.rest.repos.getReleaseAsset({ owner, repo, asset_id: asset.id, headers: { accept: 'application/octet-stream' } });
    if (!(Buffer.isBuffer(response.data) || response.data instanceof ArrayBuffer || ArrayBuffer.isView(response.data))) throw Error('Downloaded release asset was not binary.');
    const bytes = Buffer.from(response.data);
    if (bytes.length !== asset.size || crypto.createHash('sha256').update(bytes).digest('hex') !== asset.hash) throw Error('Published bytes do not match staged assets.');
  }
  const final = (await github.rest.repos.updateRelease({ owner, repo, release_id: release.id, draft: false, prerelease: false, make_latest: 'true' })).data;
  if (final.draft || final.prerelease || final.tag_name !== tag) throw Error('Release promotion response was unexpected.');
  return final.html_url;
}
module.exports = publishRelease;
module.exports.verifyInputs = verifyInputs;
