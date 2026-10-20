'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const { verifyManifest, validateArtifact } = require('./update-manifest');
const { preserveQuarantine, requireQuarantine, extractZip, verifyBundle, assessBundleTrust, removeTree } = require('./update-installer');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const PREFIX = '.morrow-update-';
function childEnvironment(runAsNode = false) {
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const name of ['HOME', 'TMPDIR', 'LANG', 'LC_ALL']) if (typeof process.env[name] === 'string') env[name] = process.env[name];
  if (runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}
async function privatePath(file, directory = false) {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Unsafe update staging permissions.');
  return stat;
}
function manualLocation(message) {
  return Object.assign(new Error(message + ' Use Show downloaded update for manual installation; no system permissions will be changed.'), { code: 'UPDATE_MANUAL_LOCATION' });
}
function trustedParent(parentPath, stat, { platform = process.platform, uid = process.getuid() } = {}) {
  if (stat.mode & 0o002) return false;
  // The system Applications directory is administered by root/admin already.
  // Do not generalize this exception to arbitrary shared folders/groups.
  if (stat.mode & 0o020) return platform === 'darwin' && parentPath === '/Applications' && stat.uid === 0 && stat.gid === 80;
  return stat.uid === uid || stat.uid === 0;
}
async function validateParent(target) {
  const parentPath = path.dirname(target);
  if (await fs.realpath(parentPath) !== parentPath) throw manualLocation('Symlinked installation parent is unsupported.');
  const parent = await fs.stat(parentPath);
  if (!trustedParent(parentPath, parent)) throw manualLocation('The installation folder is shared with untrusted writers.');
  if (process.platform === 'darwin') {
    // A mode check alone misses ACL-granted writers. Default deny ACLs are fine;
    // additional allow ACLs require a manual handoff instead of guessing rights.
    const result = await execFile('/bin/ls', ['-lde', parentPath], { timeout: 10000, maxBuffer: 65536 });
    if (/^\s*\d+:.*\ballow\b/m.test(result.stdout)) throw manualLocation('The installation folder has an additional access-control grant.');
  }
  try { await fs.access(parentPath, require('node:fs').constants.W_OK | require('node:fs').constants.X_OK); }
  catch { throw manualLocation('The installation folder is not writable by this app.'); }
}
async function validateStaging(staging, target) {
  if (!path.isAbsolute(target) || !target.endsWith('.app') || path.resolve(target) !== target || path.dirname(staging) !== path.dirname(target) || !path.basename(staging).startsWith(PREFIX)) throw new Error('Invalid update staging location.');
  await validateParent(target);
  await privatePath(staging, true);
}
async function directoryIdentity(file) {
  const stat = await fs.lstat(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(file) !== file) throw new Error('Update directory changed or is a symlink.');
  return { dev: stat.dev, ino: stat.ino };
}
async function assertDirectoryIdentity(file, expected) {
  const actual = await directoryIdentity(file);
  if (!expected || actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error('Update directory identity changed; no further replacement is safe.');
}
async function writeExclusive(file, value) { await fs.writeFile(file, value, { mode: 0o600, flag: 'wx' }); }
async function readPrivateJSON(file) { const stat = await privatePath(file); if (stat.size > 16384) throw new Error('Update receipt exceeds size limit.'); return JSON.parse(await fs.readFile(file, 'utf8')); }
async function cleanupUnstarted({ staging, target, identities }) {
  // Called only while this launcher knows spawn has not been attempted. Never
  // use directory age or a missing PID to infer that an existing helper stopped.
  await validateStaging(staging, target);
  await assertDirectoryIdentity(path.dirname(target), identities.parent);
  await assertDirectoryIdentity(target, identities.target);
  await assertDirectoryIdentity(staging, identities.staging);
  const allowed = new Set(['update-helper.js', 'update-launcher.js', 'update-manifest.js', 'update-installer.js',
    'artifact.zip', 'preflight', 'manifest.json', 'public-key.pem', 'config.json', 'cancel']);
  if ((await fs.readdir(staging)).some(name => !allowed.has(name))) throw new Error('Update transaction may have started; recovery files retained.');
  await removeTree(staging);
}
async function start(options) {
  if (process.platform !== 'darwin') throw new Error('This installer requires macOS.');
  const { target, archive, manifestBytes, signature, publicKey, currentVersion, arch, pid, execPath } = options;
  if (pid !== process.pid || execPath !== process.execPath || !Number.isInteger(pid) || pid < 2) throw new Error('Invalid installer process identity.');
  const manifest = verifyManifest(manifestBytes, signature, { publicKey, currentVersion, arch, platform: 'darwin' });
  await validateArtifact(archive, manifest);
  await requireQuarantine(archive);
  const installed = await fs.lstat(target);
  if (!installed.isDirectory() || installed.isSymbolicLink() || ![0, process.getuid()].includes(installed.uid)) throw new Error('Application must be owned by the current user or root.');
  await verifyBundle(target, { version: currentVersion, arch });
  await validateParent(target);
  const identities = { parent: await directoryIdentity(path.dirname(target)), target: await directoryIdentity(target) };
  // A private same-volume sibling holds immutable input copies and the recovery backup.
  let staging;
  try { staging = await fs.mkdtemp(path.join(path.dirname(target), PREFIX)); }
  catch (error) { if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw manualLocation('This app cannot create installation staging.'); throw error; }
  await fs.chmod(staging, 0o700);
  let helperMayRun = false;
  try {
    await validateStaging(staging, target);
    identities.staging = await directoryIdentity(staging);
    await assertDirectoryIdentity(path.dirname(target), identities.parent);
    await assertDirectoryIdentity(target, identities.target);
    for (const name of ['update-helper.js', 'update-launcher.js', 'update-manifest.js', 'update-installer.js']) {
      await writeExclusive(path.join(staging, name), await fs.readFile(path.join(__dirname, name)));
    }
    const archiveCopy = path.join(staging, 'artifact.zip');
    await fs.copyFile(archive, archiveCopy, require('node:fs').constants.COPYFILE_EXCL);
    await fs.chmod(archiveCopy, 0o600);
    await preserveQuarantine(archive, archiveCopy);
    await validateArtifact(archiveCopy, manifest);
    await requireQuarantine(archiveCopy);
    // Native policy approval is required while the current app is still running.
    // A rejected candidate must never cause shutdown or helper handoff.
    const preflight = await extractZip(archiveCopy, path.join(staging, 'preflight'));
    await preserveQuarantine(archiveCopy, preflight);
    await verifyBundle(preflight, { version: manifest.version, arch });
    await assessBundleTrust(preflight);
    // The helper re-extracts authenticated bytes after quit. This preview is no
    // longer needed and must not accumulate beside the retained backup.
    await assertDirectoryIdentity(staging, identities.staging);
    await removeTree(path.join(staging, 'preflight'));
    const nonce = crypto.randomBytes(32).toString('hex');
    await writeExclusive(path.join(staging, 'manifest.json'), manifestBytes);
    await writeExclusive(path.join(staging, 'public-key.pem'), publicKey);
    await writeExclusive(path.join(staging, 'config.json'), JSON.stringify({ target, signature, currentVersion, arch, pid, nonce, version: manifest.version, identities }));
    await assertDirectoryIdentity(path.dirname(target), identities.parent);
    await assertDirectoryIdentity(staging, identities.staging);
    await assertDirectoryIdentity(target, identities.target);
    helperMayRun = true;
    const child = spawn(execPath, [path.join(staging, 'update-helper.js'), staging], { detached: true, stdio: 'ignore', env: childEnvironment(true) });
    let failed;
    child.on('error', err => { failed = err; });
    child.on('exit', code => { failed = new Error(`Installer helper exited before handoff (${code}).`); });
    child.unref();
    for (let i = 0; i < 100; i++) {
      if (failed) throw failed;
      try {
        const ready = await readPrivateJSON(path.join(staging, 'ready.json'));
        if (ready.nonce !== nonce || ready.pid !== child.pid) throw new Error('Invalid installer readiness receipt.');
        return { staging, receipt: path.join(staging, 'receipt.json'), cancel: () => writeExclusive(path.join(staging, 'cancel'), 'cancel') };
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
      await delay(100);
    }
    throw new Error('Installer helper readiness timed out.');
  } catch (error) {
    if (!helperMayRun && identities.staging) {
      try { await cleanupUnstarted({ staging, target, identities }); }
      catch { error.message += ` Temporary files retained for review at ${staging}.`; }
    } else {
      // Once spawn was attempted, a timeout is not proof the helper stopped.
      await writeExclusive(path.join(staging, 'cancel'), 'cancel').catch(() => {});
    }
    throw error;
  }
}
async function startupContext({ argv, target, version }) {
  const receiptArgs = argv.filter(v => v.startsWith('--morrow-update-receipt='));
  const nonceArgs = argv.filter(v => v.startsWith('--morrow-update-nonce='));
  if (!receiptArgs.length && !nonceArgs.length) return false;
  if (receiptArgs.length !== 1 || nonceArgs.length !== 1) throw new Error('Invalid update startup receipt arguments.');
  const receipt = receiptArgs[0].slice('--morrow-update-receipt='.length);
  const nonce = nonceArgs[0].slice('--morrow-update-nonce='.length);
  if (!/^[a-f0-9]{64}$/.test(nonce) || path.basename(receipt) !== 'receipt.json') throw new Error('Invalid update startup receipt.');
  const staging = path.dirname(receipt);
  await validateStaging(staging, target);
  const config = await readPrivateJSON(path.join(staging, 'config.json'));
  if (config.nonce !== nonce || config.target !== target || config.version !== version) throw new Error('Update startup identity mismatch.');
  return { staging, receipt, nonce, version };
}
async function registerStartup(options) {
  const context = await startupContext(options);
  if (!context) return false;
  await writeExclusive(path.join(context.staging, 'started.json'), JSON.stringify({ nonce: context.nonce, version: context.version, pid: process.pid }));
  return true;
}
async function acknowledge(options) {
  const context = await startupContext(options);
  if (!context) return false;
  const started = await readPrivateJSON(path.join(context.staging, 'started.json'));
  if (started.nonce !== context.nonce || started.version !== context.version || started.pid !== process.pid) throw new Error('Invalid update startup process identity.');
  await writeExclusive(context.receipt, JSON.stringify(started));
  return true;
}
// Read only bounded, owner-private transaction records for this exact app.
// This does not perform recovery or choose a new install target.
async function recoveryStatus(target) {
  let entries;
  try { entries = await fs.readdir(path.dirname(target), { withFileTypes: true }); }
  catch { return null; }
  const directories = entries.filter(entry => entry.isDirectory() && entry.name.startsWith(PREFIX)).slice(0, 100);
  const records = [];
  for (const entry of directories) {
    const staging = path.join(path.dirname(target), entry.name);
    try {
      await validateStaging(staging, target);
      const config = await readPrivateJSON(path.join(staging, 'config.json'));
      if (config.target !== target) continue;
      const file = path.join(staging, 'journal.json');
      const stat = await privatePath(file);
      if (stat.size > 8192) continue;
      const value = await readPrivateJSON(file);
      records.push({ state: value.state, staging, time: stat.mtimeMs });
    } catch { /* unrelated or invalid records cannot authorize any action */ }
  }
  records.sort((a, b) => b.time - a.time);
  const latest = records[0];
  if (!latest || !['failed', 'recovery-required', 'installing'].includes(latest.state)) return null;
  return { state: latest.state, message: `An update transaction needs review (${latest.state}). Recovery files are retained at ${latest.staging}. Quit all app copies before restoring a verified backup; see Signed Updates recovery instructions.` };
}
module.exports = { cleanupUnstarted, trustedParent, validateParent, directoryIdentity, assertDirectoryIdentity, recoveryStatus, childEnvironment, start, registerStartup, acknowledge, validateStaging, privatePath, readPrivateJSON, writeExclusive, delay };
