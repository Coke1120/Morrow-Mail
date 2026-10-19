'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { trustedParent, directoryIdentity, assertDirectoryIdentity, recoveryStatus, childEnvironment, acknowledge, registerStartup, validateStaging, writeExclusive, start } = require('../host/update-launcher');
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
    assert.equal(await waitReady({ receipt, nonce, version, launchState: {} }), 'ready');
    await assert.rejects(acknowledge({ argv, target, version }), /EEXIST/);
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
    console.log('Update launcher: private handoff, startup identity, duplicate receipt and uncertain-exit recovery checks passed.');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
