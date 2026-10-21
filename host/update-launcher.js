'use strict';
const fs = require('node:fs/promises');
const fsConstants = require('node:fs').constants;
const os = require('node:os');
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
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
function appleQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
// shortcut: osascript administrator dialog, upgrade if a signed helper ships
async function runAsAdmin(shellCommand, prompt) {
  if (typeof shellCommand !== 'string' || shellCommand.length > 4000 || /[\0\r\n]/.test(shellCommand)) throw new Error('Invalid privileged command.');
  const script = `do shell script ${appleQuote(shellCommand)} with prompt ${appleQuote(prompt)} with administrator privileges`;
  try { return await execFile('/usr/bin/osascript', ['-e', script], { timeout: 180000, maxBuffer: 65536 }); }
  catch (error) {
    const detail = `${error && error.stderr || ''}\n${error && error.message || ''}`;
    const cancelled = /-128|User canceled|user cancelled/i.test(detail);
    throw Object.assign(new Error(cancelled ? 'Administrator authorization was cancelled.' : 'Administrator authorization could not replace the app.'), { code: cancelled ? 'UPDATE_ADMIN_CANCELLED' : 'UPDATE_ADMIN_FAILED' });
  }
}
function adminStagingScript(parentPath, uid, gid) {
  if (parentPath !== '/Applications') throw new Error('Refusing to authorize a non-Applications parent.');
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid < 0 || gid < 0) throw new Error('Invalid user identity.');
  const template = path.join(parentPath, `${PREFIX}XXXXXXXX`);
  return `staging=$(/usr/bin/mktemp -d ${shQuote(template)}) || exit 1; /usr/sbin/chown ${uid}:${gid} "$staging" && /bin/chmod 700 "$staging" && printf %s "$staging" || { /bin/rmdir "$staging"; exit 1; }`;
}
function allowedPrivilegedPath(file) {
  if (typeof file !== 'string' || !file.startsWith('/Applications/') || path.resolve(file) !== file) return false;
  const parts = file.slice('/Applications/'.length).split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return false;
  const [top, ...nested] = parts;
  if (top.startsWith(PREFIX)) return nested.length > 0 && nested.length < 4;
  return nested.length === 0 && top.endsWith('.app') && top !== '.app';
}
function privilegedMoveScript(from, to) {
  if (!allowedPrivilegedPath(from) || !allowedPrivilegedPath(to)) throw new Error('Refusing privileged replacement outside the application install.');
  return `if [ -e ${shQuote(to)} ]; then exit 1; fi; /bin/mv ${shQuote(from)} ${shQuote(to)}`;
}
async function privilegedRename(from, to) {
  await runAsAdmin(privilegedMoveScript(from, to), 'Morrow Mail needs permission to replace the application in Applications.');
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
}
// access() is not the install decision. A Finder-launched process often fails
// W_OK on root:admin /Applications while an admin Terminal succeeds, and a
// firmlink can make access() disagree with create. A private sibling is the proof.
async function createSiblingStaging(parentPath) {
  let accessFailed = false;
  try { await fs.access(parentPath, fsConstants.W_OK | fsConstants.X_OK); }
  catch { accessFailed = true; }
  let staging;
  try {
    staging = await fs.mkdtemp(path.join(parentPath, PREFIX));
    await fs.chmod(staging, 0o700);
    return staging;
  } catch (error) {
    if (staging) await fs.rmdir(staging).catch(() => {});
    if (parentPath === '/Applications' && ['EACCES', 'EPERM'].includes(error.code)) {
      throw Object.assign(new Error('The installation folder is not writable by this app.'), { code: 'UPDATE_NEEDS_ADMIN' });
    }
    if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) {
      throw manualLocation(accessFailed && error.code !== 'EROFS' ? 'The installation folder is not writable by this app.' : 'This app cannot create installation staging.');
    }
    throw error;
  }
}
async function elevatedStaging(parentPath) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const gid = typeof process.getgid === 'function' ? process.getgid() : -1;
  const result = await runAsAdmin(adminStagingScript(parentPath, uid, gid), 'Morrow Mail needs permission to install an update in Applications.');
  const staging = String(result.stdout || '').trim();
  if (path.dirname(staging) !== parentPath || !path.basename(staging).startsWith(PREFIX) || path.resolve(staging) !== staging) throw new Error('Privileged staging path was rejected.');
  try { await privatePath(staging, true); }
  catch (error) { await fs.rmdir(staging).catch(() => {}); throw error; }
  return staging;
}
async function preflightInstall(archive, manifest, arch) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), PREFIX));
  await fs.chmod(directory, 0o700);
  let failure;
  try {
    const preflight = await extractZip(archive, path.join(directory, 'preflight'));
    await preserveQuarantine(archive, preflight);
    await verifyBundle(preflight, { version: manifest.version, arch });
    await assessBundleTrust(preflight, { enforce: false });
  } catch (error) { failure = error; throw error; }
  finally { await removeTree(directory).catch(error => { if (!failure) throw error; }); }
}
async function openStaging(parentPath, ensureCandidate) {
  try { return { staging: await createSiblingStaging(parentPath), preflighted: false }; }
  catch (error) {
    if (error.code !== 'UPDATE_NEEDS_ADMIN') throw error;
    await ensureCandidate();
    try { return { staging: await elevatedStaging(parentPath), preflighted: true }; }
    catch (adminError) {
      throw manualLocation(adminError.message || 'Administrator authorization could not replace the app.');
    }
  }
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
  // Canonical /Applications that this process cannot write is authorized before any quit.
  const opened = await openStaging(path.dirname(target), () => preflightInstall(archive, manifest, arch));
  const staging = opened.staging;
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
    // Authorization already ran this preflight on the same bytes before the prompt.
    if (!opened.preflighted) {
      const preflight = await extractZip(archiveCopy, path.join(staging, 'preflight'));
      await preserveQuarantine(archiveCopy, preflight);
      await verifyBundle(preflight, { version: manifest.version, arch });
      await assessBundleTrust(preflight, { enforce: false });
      // The helper re-extracts authenticated bytes after quit. This preview is no
      // longer needed and must not accumulate beside the retained backup.
      await assertDirectoryIdentity(staging, identities.staging);
      await removeTree(path.join(staging, 'preflight'));
    }
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
module.exports = { cleanupUnstarted, trustedParent, validateParent, createSiblingStaging, openStaging, adminStagingScript, allowedPrivilegedPath, privilegedMoveScript, privilegedRename, directoryIdentity, assertDirectoryIdentity, recoveryStatus, childEnvironment, start, registerStartup, acknowledge, validateStaging, privatePath, readPrivateJSON, writeExclusive, delay };
