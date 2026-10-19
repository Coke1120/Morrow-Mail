'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { verifyManifest, validateArtifact } = require('./update-manifest');
const { preserveQuarantine, verifyBundle } = require('./update-installer');
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
async function validateStaging(staging, target) {
  if (!path.isAbsolute(target) || !target.endsWith('.app') || path.resolve(target) !== target || path.dirname(staging) !== path.dirname(target) || !path.basename(staging).startsWith(PREFIX)) throw new Error('Invalid update staging location.');
  if (await fs.realpath(path.dirname(target)) !== path.dirname(target)) throw new Error('Symlinked installation parent is unsupported.');
  const parent = await fs.stat(path.dirname(target));
  if (parent.mode & 0o022) throw new Error('Automatic installation requires a private, non-group-writable parent directory. Install Morrow Mail manually in your user-owned ~/Applications directory, then retry; do not change system directory permissions.');
  await privatePath(staging, true);
}
async function writeExclusive(file, value) { await fs.writeFile(file, value, { mode: 0o600, flag: 'wx' }); }
async function readPrivateJSON(file) { const stat = await privatePath(file); if (stat.size > 16384) throw new Error('Update receipt exceeds size limit.'); return JSON.parse(await fs.readFile(file, 'utf8')); }
async function start(options) {
  if (process.platform !== 'darwin') throw new Error('This installer requires macOS.');
  const { target, archive, manifestBytes, signature, publicKey, currentVersion, arch, pid, execPath } = options;
  if (pid !== process.pid || execPath !== process.execPath || !Number.isInteger(pid) || pid < 2) throw new Error('Invalid installer process identity.');
  const manifest = verifyManifest(manifestBytes, signature, { publicKey, currentVersion, arch, platform: 'darwin' });
  await validateArtifact(archive, manifest);
  const installed = await fs.lstat(target);
  if (!installed.isDirectory() || installed.isSymbolicLink() || installed.uid !== process.getuid()) throw new Error('Application must be owned by the current user.');
  await verifyBundle(target, { version: currentVersion, arch });
  // A private same-volume sibling holds immutable input copies and the recovery backup.
  const staging = await fs.mkdtemp(path.join(path.dirname(target), PREFIX));
  await fs.chmod(staging, 0o700);
  try {
    await validateStaging(staging, target);
    for (const name of ['update-helper.js', 'update-launcher.js', 'update-manifest.js', 'update-installer.js']) {
      await writeExclusive(path.join(staging, name), await fs.readFile(path.join(__dirname, name)));
    }
    const archiveCopy = path.join(staging, 'artifact.zip');
    await fs.copyFile(archive, archiveCopy, require('node:fs').constants.COPYFILE_EXCL);
    await fs.chmod(archiveCopy, 0o600);
    await preserveQuarantine(archive, archiveCopy);
    await validateArtifact(archiveCopy, manifest);
    const nonce = crypto.randomBytes(32).toString('hex');
    await writeExclusive(path.join(staging, 'manifest.json'), manifestBytes);
    await writeExclusive(path.join(staging, 'public-key.pem'), publicKey);
    await writeExclusive(path.join(staging, 'config.json'), JSON.stringify({ target, signature, currentVersion, arch, pid, nonce, version: manifest.version }));
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
    // Preserve evidence; a helper that never received parent exit cannot replace the app.
    await writeExclusive(path.join(staging, 'cancel'), 'cancel').catch(() => {});
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
module.exports = { recoveryStatus, childEnvironment, start, registerStartup, acknowledge, validateStaging, privatePath, readPrivateJSON, writeExclusive, delay };
