'use strict';
// Detached, builtins-only helper. Runs from a private sibling directory, never
// from the app bundle being replaced. No renderer input or network access.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { verifyManifest, validateArtifact } = require('./update-manifest');
const { extractZip, verifyBundle, waitForExit, replaceAndLaunch, preserveQuarantine, requireQuarantine, assessBundleTrust } = require('./update-installer');
const { childEnvironment, assertDirectoryIdentity, validateStaging, privatePath, readPrivateJSON, writeExclusive, delay } = require('./update-launcher');
async function journal(staging, state, extra = {}) {
  const temp = path.join(staging, 'journal.next');
  await writeExclusive(temp, JSON.stringify({ state, at: new Date().toISOString(), ...extra }));
  await fs.rename(temp, path.join(staging, 'journal.json'));
}
async function cancelled(staging) {
  try { await fs.lstat(path.join(staging, 'cancel')); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}
function definitelyExited(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}
async function waitReady({ receipt, nonce, version, launchState, timeout = 60000, healthyMs = 2000, sleep = delay, now = Date.now, exited = definitelyExited }) {
  const deadline = now() + timeout;
  let healthySince = null;
  while (now() < deadline) {
    try {
      const value = await readPrivateJSON(receipt);
      const started = await readPrivateJSON(path.join(path.dirname(receipt), 'started.json'));
      if (value.nonce !== nonce || value.version !== version || !Number.isSafeInteger(value.pid) || value.pid < 2 || value.pid === process.pid ||
          started.nonce !== nonce || started.version !== version || started.pid !== value.pid) throw new Error('Invalid startup receipt.');
      // An acknowledgement is a startup milestone, not proof of health after
      // an immediate crash. Keep the candidate alive for a short observation.
      if (!launchState.exited && !exited(value.pid)) {
        if (healthySince === null) healthySince = now();
        if (now() - healthySince >= healthyMs) return 'ready';
      } else healthySince = null;
    } catch (error) { if (error.code !== 'ENOENT') throw error; healthySince = null; }
    // open exiting does not prove candidate descendants have stopped. Without
    // a readiness receipt, preserve the running candidate and its backup.
    if (launchState.exited) {
      if (launchState.code !== 0) return 'timeout';
      try {
        const started = await readPrivateJSON(path.join(path.dirname(receipt), 'started.json'));
        if (started.nonce !== nonce || started.version !== version || !Number.isSafeInteger(started.pid) || started.pid < 2 || started.pid === process.pid) throw new Error('Invalid startup process receipt.');
        return exited(started.pid) ? 'exited' : 'timeout';
      } catch (error) { if (error.code !== 'ENOENT') throw error; return 'timeout'; }
    }
    await sleep(100);
  }
  return 'timeout';
}
async function launchTrusted(bundle, launch, assess = bundle => assessBundleTrust(bundle, { enforce: false })) {
  await assess(bundle);
  return launch();
}
async function run(staging) {
  if (process.platform !== "darwin") throw new Error("This installer requires macOS.");
  await privatePath(staging, true);
  const config = await readPrivateJSON(path.join(staging, 'config.json'));
  const { target, signature, currentVersion, arch, pid, nonce, version } = config;
  await validateStaging(staging, target);
  const checkLocation = async () => {
    await validateStaging(staging, target);
    await assertDirectoryIdentity(path.dirname(target), config.identities?.parent);
    await assertDirectoryIdentity(staging, config.identities?.staging);
  };
  await checkLocation();
  await assertDirectoryIdentity(target, config.identities?.target);
  if (!/^[a-f0-9]{64}$/.test(nonce) || !Number.isSafeInteger(pid) || pid < 2 || pid === process.pid) throw new Error('Invalid installer handoff.');
  for (const name of ['manifest.json', 'public-key.pem', 'artifact.zip']) await privatePath(path.join(staging, name));
  const manifestBytes = await fs.readFile(path.join(staging, 'manifest.json'));
  const publicKey = await fs.readFile(path.join(staging, 'public-key.pem'));
  const check = () => verifyManifest(manifestBytes, signature, { publicKey, currentVersion, arch, platform: 'darwin', expectedVersion: version });
  check();
  await journal(staging, 'waiting-for-exit');
  await writeExclusive(path.join(staging, 'ready.json'), JSON.stringify({ nonce, pid: process.pid }));
  await waitForExit([pid]);
  if (await cancelled(staging)) { await journal(staging, 'cancelled'); return; }
  let replacementAttempted = false;
  try {
  // Verify signed bytes and archive again after the installed app has stopped.
  const manifest = check();
  await validateArtifact(path.join(staging, 'artifact.zip'), manifest);
  await requireQuarantine(path.join(staging, 'artifact.zip'));
  await journal(staging, 'verifying');
  // extractZip uses original-fs. This process is still the Electron binary under
  // ELECTRON_RUN_AS_NODE, so patched fs would reject Contents/Resources/app.asar.
  const extracted = await extractZip(path.join(staging, 'artifact.zip'), path.join(staging, 'extracted'));
  await preserveQuarantine(path.join(staging, 'artifact.zip'), extracted);
  await verifyBundle(extracted, { version, arch });
  await assessBundleTrust(extracted, { enforce: false });
  const staged = path.join(staging, 'candidate.app');
  await fs.rename(extracted, staged);
  const backup = path.join(staging, 'previous.app');
  await journal(staging, 'installing', { target, backup, version });
  const launchState = { exited: false, code: null };
  const appEnvironment = childEnvironment();
  await verifyBundle(target, { version: currentVersion, arch });
  await checkLocation();
  await assertDirectoryIdentity(target, config.identities?.target);
  replacementAttempted = true;
  const result = await replaceAndLaunch({ target, staged, backup }, {
    guard: checkLocation,
    launch: bundle => launchTrusted(bundle, () => new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/open', ['-W', '-n', bundle, '--args', `--morrow-update-receipt=${path.join(staging, 'receipt.json')}`, `--morrow-update-nonce=${nonce}`], { stdio: 'ignore', env: appEnvironment });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
      child.once('exit', code => { launchState.exited = true; launchState.code = code; });
    })),
    waitReady: () => waitReady({ receipt: path.join(staging, 'receipt.json'), nonce, version, launchState }),
    relaunchOld: bundle => launchTrusted(bundle, () => new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/open', [bundle], { stdio: 'ignore', detached: true, env: appEnvironment });
      child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
    }))
  });
  await journal(staging, result.state, { target, backup, version, message: result.message });
  } catch (error) {
    if (!replacementAttempted) {
      // Failed authentication/extraction leaves the original bundle intact. Only
      // relaunch it after verifying its expected identity and strict integrity.
      await verifyBundle(target, { version: currentVersion, arch });
      const env = childEnvironment();
      await launchTrusted(target, () => new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/open', [target], { stdio: 'ignore', detached: true, env });
        child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
      }));
    }
    throw error;
  }
}
if (require.main === module) {
  const staging = process.argv[2];
  run(staging).catch(async error => {
    // Do not trust an arbitrary argument as a location for an error report.
    try { await privatePath(staging, true); await journal(staging, 'failed', { message: error.message }); } catch (_) {}
    process.exitCode = 1;
  });
}
module.exports = { launchTrusted, run, waitReady, journal };
