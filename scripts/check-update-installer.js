'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { requireQuarantine, assessBundleTrust, preserveQuarantine, extractZip, verifyBundle, createStaging, waitForExit, replaceAndLaunch } = require('../host/update-installer');
function crc(bytes) { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = c >>> 1 ^ (0xedb88320 & -(c & 1)); } return (c ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, content = '', mode = 0o100644] of entries) {
    const n = Buffer.from(name), data = Buffer.from(content), l = Buffer.alloc(30), c = Buffer.alloc(46);
    l.writeUInt32LE(0x04034b50); l.writeUInt16LE(20, 4); l.writeUInt32LE(crc(data), 14); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x314, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc(data), 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE((mode << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    locals.push(l, n, data); centrals.push(c, n); offset += l.length + n.length + data.length;
  }
  const central = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
async function main() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'morrow-installer-test-'))); let id = 0;
  async function extract(entries, mutate) { const archive = path.join(root, `test${id++}.zip`), destination = path.join(root, `extract${id++}`); let bytes = zip(entries); if (mutate) bytes = mutate(bytes); await fs.writeFile(archive, bytes); return extractZip(archive, destination); }
  try {
    const bundle = await extract([['Morrow Mail.app/Contents/fixture', 'binary']]);
    let nativeLinks = true;
    try {
      // macOS framework directory links cannot be exercised on Windows hosts
      // without symlink privilege; the parser rejection tests below still run.
      const linkedBundle = await extract([['Morrow Mail.app/Contents/Frameworks/F.framework/Versions/A/F', 'binary', 0o100755], ['Morrow Mail.app/Contents/Frameworks/F.framework/Versions/Current', 'A', 0o120777], ['Morrow Mail.app/Contents/Frameworks/F.framework/F', 'Versions/Current/F', 0o120777]]);
    assert.equal(await fs.readFile(path.join(linkedBundle, 'Contents/Frameworks/F.framework/F'), 'utf8'), 'binary');
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'ENOTDIR', 'EINVAL'].includes(error.code)) throw error;
      nativeLinks = false;
      console.log('Native framework symlink fixture unavailable on Windows:', error.code);
    }
    if (nativeLinks) await assert.rejects(extract([['Morrow Mail.app/a', 'b', 0o120777], ['Morrow Mail.app/b', 'a', 0o120777]]), error => error.code === 'ELOOP');
    for (const entries of [
      [['../outside', 'x']], [['Morrow Mail.app/../outside', 'x']], [['/Morrow Mail.app/file', 'x']], [['Morrow Mail.app/a\\b', 'x']],
      [['Morrow Mail.app/a', 'x'], ['Morrow Mail.app/A', 'y']],
      [['Morrow Mail.app/link', '../../outside', 0o120777]],
      [['Morrow Mail.app/link', 'actual', 0o120777], ['Morrow Mail.app/link/file', 'x']],
      [['Morrow Mail.app/device', '', 0o020644]], [['Morrow Mail.app/setuid', 'x', 0o104755]],
    ]) await assert.rejects(extract(entries));
    await assert.rejects(extract([['Morrow Mail.app/x', 'hello']], bytes => { bytes[30 + Buffer.byteLength('Morrow Mail.app/x')] ^= 1; return bytes; }), /checksum/);
    await assert.rejects(extract([['Morrow Mail.app/x', 'hello']], bytes => bytes.subarray(0, bytes.length - 1)));
    const descriptorZip = bytes => {
      const end = bytes.length - 22, offset = bytes.readUInt32LE(end + 16), descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50); bytes.copy(descriptor, 4, 14, 26);
      bytes.writeUInt16LE(8, 6); bytes.writeUInt16LE(8, offset + 8); bytes.writeUInt32LE(offset + 16, end + 16);
      return Buffer.concat([bytes.subarray(0, offset), descriptor, bytes.subarray(offset)]);
    };
    await extract([['Morrow Mail.app/described', 'ok']], descriptorZip);
    await assert.rejects(extract([['Morrow Mail.app/described', 'ok']], bytes => { const out = descriptorZip(bytes); const offset = out.readUInt32LE(out.length - 6); out[offset - 12] ^= 1; return out; }), /descriptor/);
    await assert.rejects(extract([['Morrow Mail.app/described', 'ok']], bytes => { const offset = bytes.readUInt32LE(bytes.length - 6); bytes.writeUInt16LE(8, 6); bytes.writeUInt16LE(8, offset + 8); return bytes; }), /descriptor/);
    await extract([['Morrow Mail.app/', '', 0o040755]]);
    await assert.rejects(extract([['Morrow Mail.app/', '', 0o040755]], bytes => { const offset = bytes.readUInt32LE(bytes.length - 6); bytes.writeUInt32LE(1, 14); bytes.writeUInt32LE(1, offset + 16); return bytes; }), /checksum/);
    for (const badName of ['Morrow Mail.app/Contents/._Info.plist', '__MACOSX/._Morrow Mail.app', 'Morrow Mail.app/__MACOSX/data']) {
      const archive = path.join(root, `metadata${id++}.zip`), destination = path.join(root, `metadata-output${id++}`);
      await fs.writeFile(archive, zip([['Morrow Mail.app/Contents/first', 'safe'], [badName, 'unsupported metadata']]));
      await assert.rejects(extractZip(archive, destination), /metadata/);
      await assert.rejects(fs.lstat(destination), { code: 'ENOENT' });
    }
    assert.equal(await requireQuarantine('archive', { run: async () => ({ stdout: '30 30 38 33' }) }), '30303833');
    await assert.rejects(requireQuarantine('archive', { run: async () => ({ stdout: '' }) }), /quarantine/);
    await assert.rejects(requireQuarantine('archive', { run: async () => { throw new Error('No such xattr'); } }), /No such xattr/);
    assert.equal(await requireQuarantine('archive', { run: async () => ({ stdout: '30303832' }) }), '30303832', 'Preserve existing system-managed quarantine flags');
    await assert.rejects(preserveQuarantine('archive', 'bundle', { run: async () => ({ stdout: '' }) }), /quarantine/);
    const assessments = [];
    await assessBundleTrust(bundle, { run: async (...args) => { assessments.push(args); return { stdout: '' }; } });
    assert.deepEqual(assessments[0], ['/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', bundle], { timeout: 60000, maxBuffer: 1024 * 1024 }]);
    for (const message of ['rejected', 'timed out']) await assert.rejects(assessBundleTrust(bundle, { run: async () => { throw new Error(message); } }), error => error.code === 'UPDATE_MANUAL_TRUST' && error.cause.message === message);
    const attrs = [];
    await preserveQuarantine('archive', 'bundle', { run: async (cmd, args) => { attrs.push(args); return { stdout: args.length === 1 ? 'com.apple.quarantine\n' : args[0] === '-px' ? '30 30 38 33' : '' }; } });
    assert.deepEqual(attrs.at(-1), ['-wx', 'com.apple.quarantine', '30303833', 'bundle']);
    await assert.rejects(preserveQuarantine('archive', 'bundle', { run: async () => { throw new Error('denied'); } }), /denied/);
    const executable = path.join(bundle, 'Contents', 'MacOS', 'Morrow Mail');
    await fs.mkdir(path.dirname(executable), { recursive: true });
    function macho(cpu = 0x0100000c, bigEndian = false, magic = 0xfeedfacf) {
      const header = Buffer.alloc(32), write = bigEndian ? header.writeUInt32BE.bind(header) : header.writeUInt32LE.bind(header);
      write(magic, 0); write(cpu, 4); write(2, 12); return header;
    }
    await fs.writeFile(executable, macho());
    const commands = [];
    const run = async (cmd, args) => { commands.push([cmd, args]); return { stdout: cmd.endsWith('PlistBuddy') ? ({ 'Print :CFBundleIdentifier': 'com.coke1120.morrow-mail', 'Print :CFBundleShortVersionString': '0.2.6', 'Print :CFBundleExecutable': 'Morrow Mail' })[args[1]] : '' }; };
    await verifyBundle(bundle, { version: '0.2.6', arch: 'arm64', run }); assert(commands.some(([cmd, args]) => cmd.endsWith('codesign') && args.includes('--strict')));
    await assert.rejects(verifyBundle(bundle, { version: '0.2.6', arch: 'x64', run }), /architecture/);
    await assert.rejects(verifyBundle(bundle, { version: '0.2.7', arch: 'arm64', run }), /identity or version/);
    await fs.writeFile(executable, macho(0x01000007));
    await verifyBundle(bundle, { version: '0.2.6', arch: 'x64', run });
    await fs.writeFile(executable, macho(0x0100000c, true));
    await verifyBundle(bundle, { version: '0.2.6', arch: 'arm64', run });
    for (const invalid of [macho(0x0100000c, false, 0xcafebabe), macho(0x0100000c, false, 0xfeedface), Buffer.alloc(12)]) {
      await fs.writeFile(executable, invalid);
      await assert.rejects(verifyBundle(bundle, { version: '0.2.6', arch: 'arm64', run }));
    }
    assert(!commands.some(([cmd]) => cmd.includes('lipo')));
    let tick = 0;
    await assert.rejects(waitForExit([123], { timeout: 1, alive: () => true, now: () => tick++, sleep: async () => {} }), /did not exit/);
    await waitForExit([123], { alive: () => false });
    for (const outcome of ['ready', 'exited', 'timeout', 'launch-failed']) {
      const parent = path.join(root, `swap${id++}`); await fs.mkdir(parent); const target = path.join(parent, 'Morrow Mail.app'); await fs.mkdir(target); await fs.writeFile(path.join(target, 'version'), 'old');
      const dir = await createStaging(target), staged = path.join(dir, 'Morrow Mail.app'), backup = path.join(dir, 'backup.app'); await fs.mkdir(staged); await fs.writeFile(path.join(staged, 'version'), 'new'); let restarted = false;
      const action = replaceAndLaunch({ target, staged, backup }, { launch: async () => { if (outcome === 'launch-failed') throw new Error('launch failed'); }, waitReady: async () => outcome, relaunchOld: async () => { restarted = true; } });
      if (['exited', 'launch-failed'].includes(outcome)) { await assert.rejects(action); assert.equal(await fs.readFile(path.join(target, 'version'), 'utf8'), 'old'); assert(restarted); }
      else { const result = await action; assert.equal(result.state, outcome === 'ready' ? 'installed' : 'recovery-required'); assert.equal(await fs.readFile(path.join(backup, 'version'), 'utf8'), 'old'); }
    }
    // Refuse an unrelated destination observed between renames.
    const parent = path.join(root, 'race'); await fs.mkdir(parent);
    const target = path.join(parent, 'Morrow Mail.app'); await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'version'), 'old');
    const dir = await createStaging(target), staged = path.join(dir, 'candidate.app'), backup = path.join(dir, 'previous.app');
    await fs.mkdir(staged); let guards = 0, launches = 0;
    await assert.rejects(replaceAndLaunch({ target, staged, backup }, {
      guard: async () => { if (++guards === 2) { await fs.mkdir(target); await fs.writeFile(path.join(target, 'unrelated'), 'preserve'); } },
      launch: async () => { launches++; }, waitReady: async () => 'ready'
    }), /destination appeared/);
    assert.equal(launches, 0);
    assert.equal(await fs.readFile(path.join(target, 'unrelated'), 'utf8'), 'preserve');
    assert.equal(await fs.readFile(path.join(backup, 'version'), 'utf8'), 'old');
    console.log('update installer: ZIP attacks, framework links, identity/arch/strict checks, exit timeout, replacement and rollback passed');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
