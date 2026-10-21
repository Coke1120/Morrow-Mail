'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { cleanupUnstarted, trustedParent, validateParent, createSiblingStaging, openStaging, adminStagingScript, allowedPrivilegedPath, privilegedMoveScript, directoryIdentity, assertDirectoryIdentity, recoveryStatus, childEnvironment, acknowledge, registerStartup, validateStaging, writeExclusive, start } = require('../host/update-launcher');
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
  assert.equal(trustedParent('/Applications', { uid: 0, gid: 80, mode: 0o40775 }, platform), true, 'root:admin 0775 /Applications stays eligible for an admin uid');
  const stagingScript = adminStagingScript('/Applications', 501, 20);
  assert.match(stagingScript, /\/usr\/bin\/mktemp -d '\/Applications\/\.morrow-update-XXXXXXXX'/);
  assert.match(stagingScript, /\/usr\/sbin\/chown 501:20 "\$staging"/);
  assert.match(stagingScript, /\/bin\/chmod 700 "\$staging"/);
  assert.doesNotMatch(stagingScript, /xattr|spctl|chmod [0-7]* '\/Applications'|\/Applications' &&/);
  assert.throws(() => adminStagingScript('/Users/leo/Applications', 501, 20), /non-Applications/);
  assert.equal(allowedPrivilegedPath('/Applications/Morrow Mail.app'), true);
  assert.equal(allowedPrivilegedPath('/Applications/.morrow-update-abc/previous.app'), true);
  assert.equal(allowedPrivilegedPath('/Applications/.morrow-update-abc/candidate.app'), true);
  assert.equal(allowedPrivilegedPath('/tmp/Morrow Mail.app'), false);
  assert.equal(allowedPrivilegedPath('/Applications/Safari.app/Contents'), false);
  assert.equal(allowedPrivilegedPath('/Applications/../etc/passwd'), false);
  const moveScript = privilegedMoveScript("/Applications/O'Brien Mail.app", '/Applications/.morrow-update-abc/previous.app');
  assert.ok(moveScript.startsWith('if [ -e '), 'authorized replace must refuse an existing destination');
  assert.ok(moveScript.includes("'/Applications/O'\\''Brien Mail.app'"));
  assert.ok(moveScript.includes('/bin/mv '));
  assert.doesNotMatch(moveScript, /xattr|spctl/);
  assert.throws(() => privilegedMoveScript('/etc/passwd', '/Applications/Morrow Mail.app'), /outside the application install/);
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
    assert.match(helperSource, /move: privilegedRename/);
    assert.doesNotMatch(launcherSource, /xattr -d|xattr -c|spctl --master-disable/);
    const writable = path.join(root, 'writable-parent');
    await fs.mkdir(writable, { mode: 0o755 });
    await fs.chmod(writable, 0o755);
    await validateParent(path.join(writable, 'Morrow Mail.app'));
    const created = await createSiblingStaging(writable);
    assert.equal((await fs.stat(created)).mode & 0o077, 0);
    await fs.rm(created, { recursive: true });
    const shared = path.join(root, 'shared-parent');
    await fs.mkdir(shared);
    await fs.chmod(shared, 0o777);
    await assert.rejects(validateParent(path.join(shared, 'Morrow Mail.app')), /untrusted writers/);
    const groupWrite = path.join(root, 'group-parent');
    await fs.mkdir(groupWrite);
    await fs.chmod(groupWrite, 0o775);
    await assert.rejects(validateParent(path.join(groupWrite, 'Morrow Mail.app')), /untrusted writers/);
    const realParent = path.join(root, 'real-parent');
    await fs.mkdir(realParent);
    const linkParent = path.join(root, 'link-parent');
    await fs.symlink(realParent, linkParent);
    await assert.rejects(validateParent(path.join(linkParent, 'Morrow Mail.app')), /Symlinked installation parent/);
    const locked = path.join(root, 'locked-parent');
    await fs.mkdir(locked);
    await fs.chmod(locked, 0o555);
    try {
      await assert.rejects(createSiblingStaging(locked), error => error.code === 'UPDATE_MANUAL_LOCATION' && /not writable by this app/.test(error.message) && /Show downloaded update/.test(error.message) && /no system permissions will be changed/.test(error.message));
    } finally { await fs.chmod(locked, 0o700); }
    async function loadLauncher({ access, mkdtemp, exec } = {}) {
      const vm = require('node:vm');
      const localRequire = require('node:module').createRequire(require.resolve('../host/update-launcher'));
      const realFs = localRequire('node:fs/promises');
      const fsProxy = new Proxy(realFs, { get(target, prop, receiver) {
        if (prop === 'access' && access) return access;
        if (prop === 'mkdtemp' && mkdtemp) return mkdtemp;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const context = { module: { exports: {} }, __dirname: path.dirname(require.resolve('../host/update-launcher')), setTimeout,
        process: { platform: 'darwin', pid: process.pid, execPath: process.execPath, getuid: () => process.getuid(), getgid: () => process.getgid(), env: process.env },
        require(name) {
          if (name === 'node:fs/promises') return fsProxy;
          if (name === 'node:util') return { promisify: () => async (cmd, args) => exec ? exec(cmd, args) : { stdout: '' } };
          if (name === 'node:child_process') return { spawn() { throw new Error('spawn'); }, execFile() {} };
          return localRequire(name);
        } };
      vm.runInNewContext(await fs.readFile(require.resolve('../host/update-launcher'), 'utf8'), context);
      return context.module.exports;
    }
    const denyAccess = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    const probeParent = path.join(root, 'probe-parent');
    await fs.mkdir(probeParent, { mode: 0o755 });
    await fs.chmod(probeParent, 0o755);
    let probed = 0;
    const falseNegative = await loadLauncher({ access: denyAccess });
    const probedOpen = await falseNegative.openStaging(probeParent, async () => { probed++; throw new Error('must not authorize a directory this process can create'); });
    assert.equal(probed, 0);
    assert.equal(probedOpen.preflighted, false);
    assert.equal((await fs.stat(probedOpen.staging)).mode & 0o077, 0);
    await fs.rm(probedOpen.staging, { recursive: true });
    const readOnly = await loadLauncher({ access: denyAccess, mkdtemp: async () => { throw Object.assign(new Error('ro'), { code: 'EROFS' }); } });
    await assert.rejects(readOnly.openStaging('/Applications', async () => { throw new Error('must not authorize a read-only parent'); }), error => error.code === 'UPDATE_MANUAL_LOCATION' && /cannot create installation staging/.test(error.message));
    let ensured = 0, scripts = [];
    const cancelled = await loadLauncher({
      access: denyAccess,
      mkdtemp: async prefix => { if (String(prefix).startsWith('/Applications/')) throw Object.assign(new Error('denied'), { code: 'EACCES' }); throw new Error('unexpected mkdtemp ' + prefix); },
      exec: async cmd => { scripts.push(cmd); if (cmd === '/usr/bin/osascript') throw Object.assign(new Error('User canceled. (-128)'), { stderr: 'User canceled. (-128)' }); return { stdout: '' }; }
    });
    await assert.rejects(cancelled.openStaging('/Applications', async () => { ensured++; }), error => error.code === 'UPDATE_MANUAL_LOCATION' && /Administrator authorization was cancelled/.test(error.message) && /Show downloaded update/.test(error.message));
    assert.equal(ensured, 1);
    assert.ok(scripts.includes('/usr/bin/osascript'));
    const rejectedPath = await loadLauncher({
      access: denyAccess,
      mkdtemp: async prefix => { if (String(prefix).startsWith('/Applications/')) throw Object.assign(new Error('denied'), { code: 'EACCES' }); throw new Error('unexpected'); },
      exec: async cmd => cmd === '/usr/bin/osascript' ? { stdout: '/tmp/not-applications\n' } : { stdout: '' }
    });
    await assert.rejects(rejectedPath.openStaging('/Applications', async () => {}), error => error.code === 'UPDATE_MANUAL_LOCATION' && /Privileged staging path was rejected/.test(error.message) && /Show downloaded update/.test(error.message));
    let blockedScripts = [];
    const blocked = await loadLauncher({
      access: denyAccess,
      mkdtemp: async prefix => { if (String(prefix).startsWith('/Applications/')) throw Object.assign(new Error('denied'), { code: 'EACCES' }); throw new Error('unexpected'); },
      exec: async cmd => { blockedScripts.push(cmd); return { stdout: '' }; }
    });
    const trust = Object.assign(new Error('policy'), { code: 'UPDATE_MANUAL_TRUST' });
    await assert.rejects(blocked.openStaging('/Applications', async () => { throw trust; }), error => error === trust);
    assert.deepEqual(blockedScripts, [], 'A rejected candidate must not ask for administrator authorization');
    const aclParent = path.join(root, 'acl-parent');
    await fs.mkdir(aclParent, { mode: 0o755 });
    const allowAcl = await loadLauncher({ exec: async () => ({ stdout: 'drwxr-xr-x  2 user staff 64 Oct 21 00:00 parent\n 0: user:leo allow list,add_file,delete\n' }) });
    await assert.rejects(allowAcl.validateParent(path.join(aclParent, 'Morrow Mail.app')), error => error.code === 'UPDATE_MANUAL_LOCATION' && /additional access-control grant/.test(error.message));
    const denyAcl = await loadLauncher({ exec: async () => ({ stdout: 'drwxr-xr-x  2 user staff 64 Oct 21 00:00 parent\n 0: group:everyone deny delete\n' }) });
    await denyAcl.validateParent(path.join(aclParent, 'Morrow Mail.app'));
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
