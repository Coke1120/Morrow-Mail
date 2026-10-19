'use strict';
// Artifact authenticity is established by update-manifest before this module is
// called. codesign below checks bundle integrity, not Apple notarization/trust.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const MAX_ARCHIVE = 1024 * 1024 * 1024;
const MAX_EXPANDED = 3 * MAX_ARCHIVE;
const MAX_FILE = 512 * 1024 * 1024;
const NATIVE_OPTIONS = { timeout: 60000, maxBuffer: 1024 * 1024 };
const fail = message => { throw new Error(message); };
async function readAt(handle, length, position) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) fail('Truncated update archive.');
  return buffer;
}
function safeName(name, bundleName) {
  if (!name || name.includes('\\') || /[\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || name.includes(':')) fail('Unsafe ZIP path.');
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some(p => p.startsWith('._') || p === '__MACOSX')) fail('Unsupported ZIP AppleDouble metadata.');
  if (parts.some(p => !p || p === '.' || p === '..') || parts[0] !== bundleName) fail('ZIP must contain only the expected application.');
  return parts.join('/');
}
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (0xedb88320 & -(n & 1));
  return n >>> 0;
});
function crcUpdate(crc, bytes) {
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  return crc >>> 0;
}
async function extractZip(archive, destination, { bundleName = 'Morrow Mail.app' } = {}) {
  // Destination must be fresh; never extract into a prior tree or follow links.
  const handle = await fsp.open(archive, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 22 || stat.size > MAX_ARCHIVE) fail('Invalid update archive size.');
    const tailStart = Math.max(0, stat.size - 65557);
    const tail = await readAt(handle, stat.size - tailStart, tailStart);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
    if (end < 0) fail('Invalid ZIP directory.');
    const count = tail.readUInt16LE(end + 10), directorySize = tail.readUInt32LE(end + 12), directoryOffset = tail.readUInt32LE(end + 16);
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || tail.readUInt16LE(end + 8) !== count || count === 65535 || count > 30000 || directorySize > 16 * 1024 * 1024 || directoryOffset + directorySize !== tailStart + end) fail('Unsupported ZIP directory.');
    const directory = await readAt(handle, directorySize, directoryOffset);
    const entries = [], names = new Set(); let cursor = 0, expanded = 0;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) fail('Invalid ZIP entry.');
      const flags = directory.readUInt16LE(cursor + 8), method = directory.readUInt16LE(cursor + 10);
      const crc = directory.readUInt32LE(cursor + 16), compressed = directory.readUInt32LE(cursor + 20), size = directory.readUInt32LE(cursor + 24);
      const nl = directory.readUInt16LE(cursor + 28), el = directory.readUInt16LE(cursor + 30), cl = directory.readUInt16LE(cursor + 32);
      const mode = directory.readUInt32LE(cursor + 38) >>> 16, offset = directory.readUInt32LE(cursor + 42);
      if (cursor + 46 + nl + el + cl > directory.length || flags & ~0x808 || ![0, 8].includes(method) || size > MAX_FILE || (expanded += size) > MAX_EXPANDED) fail('Unsupported ZIP entry.');
      const rawName = directory.subarray(cursor + 46, cursor + 46 + nl);
      const name = new TextDecoder('utf-8', { fatal: true }).decode(rawName);
      const relative = safeName(name, bundleName), key = relative.normalize('NFD').toLowerCase();
      if (names.has(key)) fail('Duplicate ZIP path.'); names.add(key);
      const type = mode & 0xf000;
      if (![0, 0x4000, 0x8000, 0xa000].includes(type) || mode & 0o7000) fail('Unsupported ZIP file type.');
      const isDirectory = name.endsWith('/');
      if ((type === 0x4000 && !isDirectory) || (isDirectory && (size !== 0 || type === 0xa000 || type === 0x8000)) || (type === 0xa000 && size > 4096)) fail('Invalid ZIP entry type.');
      const local = await readAt(handle, 30, offset);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method) fail('ZIP header mismatch.');
      const lnl = local.readUInt16LE(26), lel = local.readUInt16LE(28);
      const localName = await readAt(handle, lnl, offset + 30);
      const start = offset + 30 + lnl + lel;
      if (!(flags & 8) && (local.readUInt32LE(14) !== crc || local.readUInt32LE(18) !== compressed || local.readUInt32LE(22) !== size)) fail('ZIP header mismatch.');
      if (!localName.equals(rawName) || start + compressed > directoryOffset) fail('ZIP header mismatch.');
      let dataEnd = start + compressed;
      if (flags & 8) {
        const first = await readAt(handle, 4, dataEnd);
        const hasSignature = first.readUInt32LE(0) === 0x08074b50;
        const descriptor = await readAt(handle, 12, dataEnd + (hasSignature ? 4 : 0));
        if (descriptor.readUInt32LE(0) !== crc || descriptor.readUInt32LE(4) !== compressed || descriptor.readUInt32LE(8) !== size) fail('ZIP descriptor mismatch.');
        dataEnd += hasSignature ? 16 : 12;
        if (dataEnd > directoryOffset) fail('ZIP descriptor exceeds data region.');
      }
      entries.push({ relative, mode, type, isDirectory, offset, start, dataEnd, compressed, size, crc, method });
      cursor += 46 + nl + el + cl;
    }
    if (cursor !== directory.length || !entries.length) fail('Invalid ZIP directory length.');
    const ranges = [...entries].sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < ranges.length; i++) if (ranges[i].offset < ranges[i - 1].dataEnd) fail('Overlapping ZIP entries.');
    const links = new Set(entries.filter(e => e.type === 0xa000).map(e => e.relative.normalize('NFD').toLowerCase()));
    for (const entry of entries) {
      let parent = path.posix.dirname(entry.relative);
      while (parent !== '.') { if (links.has(parent.normalize('NFD').toLowerCase())) fail('ZIP entry descends through a symlink.'); parent = path.posix.dirname(parent); }
    }
    // Finish archive metadata/path validation before creating any output.
    await fsp.mkdir(destination, { mode: 0o700 });
    const pendingLinks = [];
    for (const entry of entries) {
      const target = path.join(destination, entry.relative);
      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (entry.isDirectory) await fsp.mkdir(target, { recursive: true, mode: 0o755 });
      let length = 0, crc = 0xffffffff; const chunks = [];
      const meter = new Transform({ transform(chunk, encoding, callback) {
        length += chunk.length;
        if (length > entry.size) return callback(new Error('ZIP expansion exceeds declared size.'));
        crc = crcUpdate(crc, chunk); callback(null, chunk);
      } });
      const source = entry.compressed ? fs.createReadStream(archive, { fd: handle.fd, autoClose: false, start: entry.start, end: entry.start + entry.compressed - 1 }) : require('node:stream').Readable.from([]);
      const sink = entry.isDirectory || entry.type === 0xa000 ? new Transform({ transform(chunk, encoding, callback) { chunks.push(chunk); callback(); } }) : fs.createWriteStream(target, { flags: 'wx', mode: entry.mode & 0o111 ? 0o755 : 0o644 });
      const inflater = entry.method === 8 ? zlib.createInflateRaw() : null;
      await pipeline(...[source, inflater, meter, sink].filter(Boolean));
      if (inflater && inflater.bytesWritten !== entry.compressed) fail('ZIP deflate stream has trailing data.');
      if (length !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) fail('ZIP length or checksum mismatch.');
      if (entry.type === 0xa000) {
        const link = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        if (!link || path.posix.isAbsolute(link) || /[\\\x00-\x1f\x7f:]/.test(link)) fail('Unsafe ZIP symlink.');
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry.relative), link));
        if (!resolved.startsWith(bundleName + '/')) fail('ZIP symlink escapes application.');
        pendingLinks.push({ target, link });
      }
    }
    for (const { target, link } of pendingLinks) await fsp.symlink(link, target);
    const bundle = path.join(destination, bundleName);
    // Resolve chains too, rejecting cycles, dangling links and indirect escapes.
    for (const { target } of pendingLinks) { const resolved = await fsp.realpath(target); if (!resolved.startsWith(bundle + path.sep)) fail('ZIP symlink escapes application.'); }
    return bundle;
  } finally { await handle.close(); }
}
async function verifyBundle(bundle, { version, arch, appId = 'com.coke1120.morrow-mail', run = execFile }) {
  if (!['arm64', 'x64'].includes(arch) || !/^\d+\.\d+\.\d+$/.test(version)) fail('Invalid bundle expectations.');
  if ((await fsp.lstat(bundle)).isSymbolicLink()) fail('Application cannot be a symlink.');
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  async function field(name) { return (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :' + name, plist], NATIVE_OPTIONS)).stdout.trim(); }
  if (await field('CFBundleIdentifier') !== appId || await field('CFBundleShortVersionString') !== version) fail('Application identity or version mismatch.');
  const executable = await field('CFBundleExecutable');
  if (!executable || ['.', '..'].includes(executable) || executable !== path.basename(executable) || executable.includes('\\')) fail('Invalid application executable.');
  // Read only the fixed Mach-O 64-bit header: no developer-tools dependency.
  // Current release artifacts are thin binaries; fat/universal and 32-bit
  // binaries are deliberately unsupported rather than inferred from a slice.
  const binary = await fsp.open(path.join(bundle, 'Contents', 'MacOS', executable), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!(await binary.stat()).isFile()) fail('Invalid application executable.');
    const header = await readAt(binary, 32, 0);
    const magic = header.readUInt32LE(0);
    if (![0xfeedfacf, 0xcffaedfe].includes(magic)) fail('Unsupported application Mach-O architecture.');
    const uint32 = offset => magic === 0xfeedfacf ? header.readUInt32LE(offset) : header.readUInt32BE(offset);
    if (uint32(4) !== (arch === 'arm64' ? 0x0100000c : 0x01000007) || uint32(12) !== 2) fail('Application architecture or executable type mismatch.');
  } finally { await binary.close(); }
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], NATIVE_OPTIONS);
}
async function assessBundleTrust(bundle, { run = execFile } = {}) {
  // Integrity and publisher authenticity do not establish Apple platform trust.
  // Propagate rejection/timeouts; callers must never launch a rejected bundle.
  try { await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', bundle], NATIVE_OPTIONS); }
  catch (cause) {
    // spctl(8): exit 3 means assessment denial without another tool error.
    // execFile's configured timeout kills with SIGTERM and reports a null code;
    // maxBuffer, spawn errors and external signals must not become policy results.
    const denied = cause.code === 3 && !cause.killed && !cause.signal;
    const timedOut = cause.code === null && cause.killed === true && cause.signal === 'SIGTERM';
    if (!denied && !timedOut) throw cause;
    throw Object.assign(new Error('macOS has not approved this update for automatic installation. Use Show downloaded update to review it in Finder and follow macOS security prompts.', { cause }), { code: 'UPDATE_MANUAL_TRUST' });
  }
}
async function requireQuarantine(source, { run = execFile } = {}) {
  const value = (await run('/usr/bin/xattr', ['-px', 'com.apple.quarantine', source], NATIVE_OPTIONS)).stdout.replace(/\s/g, '');
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(value) || value.length > 32768) fail('Missing or invalid quarantine metadata.');
  const flags = Buffer.from(value, 'hex').toString('utf8').split(';')[0];
  if (!/^[a-fA-F0-9]{4,8}$/.test(flags)) fail('Invalid quarantine flags.');
  return value;
}
async function preserveQuarantine(source, destination, { run = execFile } = {}) {
  // Missing metadata is an error. Hex mode preserves the exact attribute bytes
  // without shell interpolation or clearing the download's provenance.
  const value = await requireQuarantine(source, { run });
  await run('/usr/bin/xattr', ['-wx', 'com.apple.quarantine', value, destination], NATIVE_OPTIONS);
}
async function createStaging(target) {
  if (!path.isAbsolute(target) || !target.endsWith('.app') || await fsp.realpath(target) !== target || !(await fsp.stat(target)).isDirectory()) fail('Invalid installed application path.');
  const directory = await fsp.mkdtemp(path.join(path.dirname(target), '.morrow-update-'));
  await fsp.chmod(directory, 0o700);
  return directory;
}
async function waitForExit(pids, { timeout = 60000, alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  if (!Array.isArray(pids) || !pids.length || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)) fail('Invalid process identity.');
  const deadline = now() + timeout;
  while (pids.some(alive)) { if (now() >= deadline) fail('Application did not exit; update was not installed.'); await sleep(100); }
}
async function replaceAndLaunch({ target, staged, backup }, { launch, waitReady, relaunchOld, guard = async () => {} }) {
  if (await fsp.realpath(target) !== target || await fsp.realpath(staged) !== staged || path.dirname(backup) !== path.dirname(staged) || path.dirname(path.dirname(staged)) !== path.dirname(target)) fail('Invalid installation paths.');
  try { await fsp.lstat(backup); fail('Previous backup already exists.'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const identity = async file => { const s = await fsp.lstat(file); if (!s.isDirectory() || s.isSymbolicLink()) fail('Update path changed.'); return `${s.dev}:${s.ino}`; };
  const original = await identity(target), candidate = await identity(staged);
  const unchanged = async (file, expected) => { if (await identity(file) !== expected) fail('Update path identity changed.'); };
  const absent = async file => { try { await fsp.lstat(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; } fail('Update destination appeared; recovery files retained.'); };
  await guard();
  await unchanged(target, original);
  await unchanged(staged, candidate);
  await absent(backup);
  await fsp.rename(target, backup);
  let installed = false, launched = false;
  try {
    await guard();
    await unchanged(backup, original);
    await unchanged(staged, candidate);
    await absent(target);
    await fsp.rename(staged, target); installed = true;
    await launch(target); launched = true;
    const outcome = await waitReady();
    if (outcome === 'ready') return { state: 'installed', backup };
    if (outcome !== 'exited') return { state: 'recovery-required', backup, message: 'Readiness unconfirmed; backup retained. Quit the application before recovery.' };
    launched = false;
    fail('Updated application exited before readiness.');
  } catch (error) {
    // A thrown readiness check is uncertain: never rename an app that may run.
    if (launched) return { state: 'recovery-required', backup, message: 'Readiness check failed; backup retained.' };
    await guard();
    await unchanged(backup, original);
    if (installed) { await unchanged(target, candidate); await absent(staged); await fsp.rename(target, staged); }
    await absent(target);
    await fsp.rename(backup, target);
    if (relaunchOld) await relaunchOld(target);
    throw error;
  }
}
module.exports = { requireQuarantine, assessBundleTrust, preserveQuarantine, extractZip, verifyBundle, createStaging, waitForExit, replaceAndLaunch };
