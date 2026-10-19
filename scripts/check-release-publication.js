'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { prepare, namesFor } = require('./prepare-release-assets');
const { createManifest } = require('./create-update-manifest');
const publish = require('./publish-release');
const version = '0.2.6', sha = 'a'.repeat(40), runId = '123', runAttempt = '1';
const missing = () => { const e = Error('not found'); e.status = 404; throw e; };
function mock({ failUpload = false, corruptDownload = false, existing = false, wrongTag = false } = {}) {
  const calls = [], assets = new Map();
  const repos = {
    getReleaseByTag: async () => existing ? { data: { id: 9 } } : missing(),
    getLatestRelease: async () => ({ data: { tag_name: 'v0.2.5' } }),
    generateReleaseNotes: async () => ({ data: { body: 'Fixture release notes' } }),
    createRelease: async args => { calls.push(['create', args]); return { data: { id: 1 } }; },
    uploadReleaseAsset: async args => {
      calls.push(['upload', args.name]); if (failUpload) throw Error('fixture upload failed');
      const id = assets.size + 1; assets.set(id, Buffer.from(args.data));
      return { data: { id, name: args.name, size: args.data.length } };
    },
    listReleaseAssets() {},
    getReleaseAsset: async args => ({ data: corruptDownload ? Buffer.from('tampered') : assets.get(args.asset_id) }),
    updateRelease: async args => { calls.push(['promote', args]); return { data: { draft: false, prerelease: false, tag_name: `v${version}`, html_url: 'https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.2.6' } }; },
  };
  return { calls, rest: { repos, git: { getRef: async () => ({ data: { object: { type: 'commit', sha: wrongTag ? 'b'.repeat(40) : sha } } }) } },
    paginate: async () => calls.filter(call => call[0] === 'upload').map((call, i) => ({ id: i + 1, name: call[1] })) };
}
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'morrow-release-test-'));
  try {
    const keys = crypto.generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' });
    const privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' });
    const staging = path.join(root, 'staging'); await fs.mkdir(staging);
    for (const platform of ['windows', 'macos']) {
      const dist = path.join(root, platform); await fs.mkdir(dist);
      const names = namesFor(platform, version), bytes = Buffer.from('fixture ' + platform);
      for (const name of names.filter(n => /\.(exe|zip|blockmap)$/.test(n))) await fs.writeFile(path.join(dist, name), bytes);
      const hash = crypto.createHash('sha512').update(bytes).digest('base64');
      await fs.writeFile(path.join(dist, platform === 'windows' ? 'latest.yml' : 'latest-mac.yml'), JSON.stringify({ version, path: names[0], sha512: hash, files: [{ url: names[0], size: bytes.length, sha512: hash }] }));
      if (platform === 'macos') await createManifest({ artifact: path.join(dist, names[0]), version, privateKey, publicKey, outputDir: path.join(dist, 'signed-update-manifest') });
      await prepare({ platform, version, commit: sha, runId, runAttempt, dist, output: path.join(staging, `release-${platform}`), publicKey });
    }
    const args = { context: { repo: { owner: 'Coke1120', repo: 'Morrow-Mail' }, sha, eventName: 'push', ref: `refs/tags/v${version}` }, artifactDirectory: staging, version, publicKey, runId, runAttempt };
    const good = mock(); await publish({ ...args, github: good });
    assert.equal(good.calls[0][0], 'create'); assert.equal(good.calls[0][1].draft, true);
    assert.equal(good.calls.at(-1)[0], 'promote'); assert.equal(good.calls.at(-1)[1].make_latest, 'true');
    assert.equal(good.calls.filter(c => c[0] === 'upload').length, 11);
    for (const issue of [{ failUpload: true }, { corruptDownload: true }]) {
      const api = mock(issue); await assert.rejects(publish({ ...args, github: api }));
      assert.ok(api.calls.some(c => c[0] === 'create')); assert.ok(!api.calls.some(c => c[0] === 'promote'));
    }
    for (const issue of [{ existing: true }, { wrongTag: true }]) {
      const api = mock(issue); await assert.rejects(publish({ ...args, github: api })); assert.equal(api.calls.length, 0);
    }
    const wrongRun = mock(); await assert.rejects(publish({ ...args, runAttempt: '2', github: wrongRun }), /provenance/); assert.equal(wrongRun.calls.length, 0);
    const noKey = mock(); await assert.rejects(publish({ ...args, publicKey: '', github: noKey }), /public key/); assert.equal(noKey.calls.length, 0);
    const wrongRef = mock(); await assert.rejects(publish({ ...args, context: { ...args.context, ref: 'refs/heads/feature' }, github: wrongRef }), /context/);
    const file = path.join(staging, 'release-macos', namesFor('macos', version)[0]); await fs.appendFile(file, 'tamper');
    const changed = mock(); await assert.rejects(publish({ ...args, github: changed }), /changed/); assert.equal(changed.calls.length, 0);
    const again = path.join(root, 'again');
    await fs.appendFile(path.join(root, 'windows', namesFor('windows', version)[0]), 'tamper');
    await assert.rejects(prepare({ platform: 'windows', version, commit: sha, runId, runAttempt, dist: path.join(root, 'windows'), output: again, publicKey }), /feed/);
    console.log('Paired release staging and draft-only publication failure tests passed (mock API; no network).');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
