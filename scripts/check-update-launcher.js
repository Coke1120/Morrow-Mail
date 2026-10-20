'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { cleanupUnstarted, trustedParent, directoryIdentity, assertDirectoryIdentity, recoveryStatus, childEnvironment, acknowledge, registerStartup, validateStaging, writeExclusive, start } = require('../host/update-launcher');
const { launchTrusted, waitReady } = require('../host/update-helper');
(async () => {
  let launches = 0;
  await assert.rejects(launchTrusted('/fixture.app', () => { launches++; }, async () => { throw new Error('Gatekeeper denied fixture'); }), /Gatekeeper denied/);
  assert.equal(launches, 0, 'Policy rejection must not launch any candidate or fallback');
  await launchTrusted('/fixture.app', () => { launches++; }, async () => {});
  assert.equal(launches, 1);
  assert.deepEqual(Object.keys(childEnvironment()).filter(key => !['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].includes(key)), []);
  assert.equal(childEnvironment(true).ELECTRON_RUN_AS_NODE, '1');
  assert.equal(childEnvironment().ELECTRON_RUN_AS_NODE, undefined);
  if (process.platform !== 'darwin') await assert.rejects(start({}), /requires macOS/);
  if (!['darwin', 'linux'].includes(process.platform)) {
    console.log('Update launcher: environment isolation and non-macOS rejection passed; POSIX permission/ownership handoff checks skipped on this platform.');
    return;
  }
  const platform = { platform: 'darwin', uid: 501 };
  assert.equal(trustedParent('/Applications', { uid: 0, gid: 80, mode: 0o40775 }, platform), true);
  for (const [folder, stat] of [
    ['/Applications', { uid: 0, gid: 20, mode: 0o40775 }],
    ['/Applications', { uid: 0, gid: 80, mode: 0o40777 }],
    ['/shared', { uid: 0, gid: 80, mode: 0o40775 }],
    ['/private', { uid: 502, gid: 20, mode: 0o40755 }]
  ]) assert.equal(trustedParent(folder, stat, platform), false);
  assert.equal(trustedParent('/private', { uid: 501, gid: 20, mode: 0o40700 }, platform), true);
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'morrow-launcher-test-'));
  await fs.chmod(root, 0o700);
  try {
    const pinned = path.join(root, 'pinned');
    await fs.mkdir(pinned);
    const identity = await directoryIdentity(pinned);
    await assertDirectoryIdentity(pinned, identity);
    await fs.rename(pinned, path.join(root, 'original'));
    await fs.mkdir(pinned);
    await assert.rejects(assertDirectoryIdentity(pinned, identity), /identity changed/);
    const target = path.join(root, 'Morrow Mail.app');
    await fs.mkdir(target);
    const staging = await fs.mkdtemp(path.join(root, '.morrow-update-'));
    await fs.chmod(staging, 0o700);
    const nonce = 'a'.repeat(64), version = '0.2.6';
    const receipt = path.join(staging, 'receipt.json');
    const argv = [`--morrow-update-receipt=${receipt}`, `--morrow-update-nonce=${nonce}`];
    await writeExclusive(path.join(staging, 'config.json'), JSON.stringify({ target, nonce, version }));
    assert.equal(await acknowledge({ argv: [], target, version }), false);
    assert.equal(await recoveryStatus(target), null);
    await writeExclusive(path.join(staging, 'journal.json'), JSON.stringify({ state: 'recovery-required' }));
    assert.match((await recoveryStatus(target)).message, /Recovery files are retained/);
    await fs.writeFile(path.join(staging, 'journal.json'), JSON.stringify({ state: 'installed' }));
    assert.equal(await recoveryStatus(target), null);

    await assert.rejects(acknowledge({ argv: [...argv, argv[0]], target, version }), /arguments/);
    await assert.rejects(acknowledge({ argv, target, version: '0.2.5' }), /identity/);
    await fs.chmod(staging, 0o755);
    await assert.rejects(acknowledge({ argv, target, version }), /permissions/);
    await fs.chmod(staging, 0o700);
    const linked = path.join(root, '.morrow-update-link');
    await fs.symlink(staging, linked);
    await assert.rejects(validateStaging(linked, target), /permissions/);
    await assert.rejects(acknowledge({ argv, target, version }), /ENOENT/);
    assert.equal(await registerStartup({ argv, target, version }), true);
    await assert.rejects(registerStartup({ argv, target, version }), /EEXIST/);
    assert.equal(await acknowledge({ argv, target, version }), true);
    await assert.rejects(acknowledge({ argv, target, version }), /EEXIST/);
    const candidatePid = process.pid + 100000;
    const record = JSON.stringify({ nonce, version, pid: candidatePid });
    await fs.writeFile(path.join(staging, 'started.json'), record);
    await fs.writeFile(receipt, record);
    let clock = 0;
    const healthy = { receipt, nonce, version, launchState: {}, now: () => clock, sleep: async ms => { clock += ms; }, exited: () => false };
    assert.equal(await waitReady(healthy), 'ready'); assert(clock >= 2000, 'Receipt must survive health observation');
    clock = 0;
    assert.equal(await waitReady({ ...healthy, timeout: 3000, exited: () => clock >= 1000 }), 'timeout');
    assert.equal(await waitReady({ ...healthy, launchState: { exited: true, code: 1 }, exited: () => true }), 'timeout');
    assert.equal(await waitReady({ ...healthy, launchState: { exited: true, code: 0 }, exited: () => true }), 'exited');
    await fs.writeFile(receipt, JSON.stringify({ nonce, version, pid: candidatePid + 1 }));
    await assert.rejects(waitReady(healthy), /receipt/);
    await fs.writeFile(receipt, record);
    await assert.rejects(waitReady({ receipt, nonce: 'b'.repeat(64), version, launchState: {} }), /receipt/);
    await fs.unlink(receipt);
    // Our test PID cannot be a candidate PID; replace with a fake distinct PID.
    await fs.writeFile(path.join(staging, 'started.json'), JSON.stringify({ nonce, version, pid: process.pid + 100000 }));
    assert.equal(await waitReady({ receipt, nonce, version, launchState: { exited: true, code: 0 }, exited: () => true }), 'exited');
    assert.equal(await waitReady({ receipt, nonce, version, launchState: { exited: true, code: 0 }, exited: () => false }), 'timeout');
    await fs.unlink(path.join(staging, 'started.json'));
    assert.equal(await waitReady({ receipt, nonce, version, launchState: { exited: true, code: 0 }, exited: () => true }), 'timeout');
    assert.equal(await waitReady({ receipt, nonce, version, launchState: { exited: true, code: 1 } }), 'timeout');
    let tick = 0;
    assert.equal(await waitReady({ receipt, nonce, version, launchState: {}, timeout: 2, now: () => tick++, sleep: async () => {} }), 'timeout');
    const makeCleanup = async () => {
      const dir = await fs.mkdtemp(path.join(root, '.morrow-update-'));
      await fs.chmod(dir, 0o700);
      return { staging: dir, target, identities: { parent: await directoryIdentity(root), target: await directoryIdentity(target), staging: await directoryIdentity(dir) } };
    };
    const unused = await makeCleanup();
    await fs.writeFile(path.join(unused.staging, 'artifact.zip'), 'discardable');
    await fs.mkdir(path.join(unused.staging, 'preflight'));
    await fs.symlink(target, path.join(unused.staging, 'preflight', 'link'));
    await cleanupUnstarted(unused);
    await assert.rejects(fs.stat(unused.staging), { code: 'ENOENT' });
    assert((await fs.stat(target)).isDirectory(), 'Cleanup never follows links into installed app');
    for (const marker of ['ready.json', 'journal.json', 'previous.app', 'unexpected']) {
      const active = await makeCleanup();
      await fs.writeFile(path.join(active.staging, marker), 'retain');
      await assert.rejects(cleanupUnstarted(active), /may have started/);
      assert.equal(await fs.readFile(path.join(active.staging, marker), 'utf8'), 'retain');
    }
    const swapped = await makeCleanup();
    await fs.rename(swapped.staging, swapped.staging + '-old'); await fs.mkdir(swapped.staging, { mode: 0o700 });
    await assert.rejects(cleanupUnstarted(swapped), /identity changed/);
    // Fault injection through the real launcher catch path: native checks are
    // mocked, but staging/copy/cleanup operate on the isolated filesystem.
    const launcherSource = await fs.readFile(require.resolve('../host/update-launcher'), 'utf8');
    assert.match(launcherSource, /removeTree\(staging\)/);
    assert.match(launcherSource, /removeTree\(path\.join\(staging, 'preflight'\)\)/);
    assert.doesNotMatch(launcherSource, /fs\.rm\(/);
    const helperSource = await fs.readFile(require.resolve('../host/update-helper'), 'utf8');
    assert.match(helperSource, /extractZip\(path\.join\(staging, 'artifact\.zip'\), path\.join\(staging, 'extracted'\)\)/);
    const vm = require('node:vm'), localRequire = require('node:module').createRequire(require.resolve('../host/update-launcher'));
    const denied = Object.assign(Error('fixture Gatekeeper denial'), { code: 'UPDATE_MANUAL_TRUST' });
    let attempts = 0;
    const context = { module: { exports: {} }, __dirname: path.dirname(require.resolve('../host/update-launcher')), setTimeout,
      process: { platform: 'darwin', pid: process.pid, execPath: process.execPath, getuid: () => process.getuid(), env: {} },
      require(name) {
        if (name === './update-manifest') return { verifyManifest: () => ({ version }), validateArtifact: async () => {} };
        if (name === './update-installer') return { preserveQuarantine: async () => {}, requireQuarantine: async () => {}, verifyBundle: async () => {},
          extractZip: async (_file, destination) => { await fs.mkdir(destination); return destination; }, assessBundleTrust: async () => { throw denied; },
          removeTree: async target => fs.rm(target, { recursive: true, force: true }) };
        if (name === 'node:util') return { promisify: () => async () => ({ stdout: '' }) };
        if (name === 'node:child_process') return { spawn: () => { attempts++; assert.fail('Denied candidate must not spawn'); } };
        return localRequire(name);
      } };
    vm.runInNewContext(await fs.readFile(require.resolve('../host/update-launcher'), 'utf8'), context);
    const artifact = path.join(root, 'source.zip'); await fs.writeFile(artifact, 'fixture');
    const before = (await fs.readdir(root)).sort();
    await assert.rejects(context.module.exports.start({ target, archive: artifact, manifestBytes: 'fixture', signature: 'fixture', publicKey: 'fixture', currentVersion: '0.2.5', arch: 'arm64', pid: process.pid, execPath: process.execPath }), e => e === denied);
    assert.equal(attempts, 0); assert.deepEqual((await fs.readdir(root)).sort(), before, 'Denied preflight must not leave staging copies');
    console.log('Update launcher: private handoff, startup identity, duplicate receipt and uncertain-exit recovery checks passed.');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
