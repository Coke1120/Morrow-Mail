"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = process.argv.includes('--windows-paths') ? require('node:path').win32 : require('node:path');
const fixtureRoot = path.resolve(path === require('node:path').win32 ? 'C:/morrow-updater-fixture' : require('node:os').tmpdir(), 'controller-fixture');
const target = path.join(fixtureRoot, 'Morrow Mail.app');
const resourcesPath = path.join(target, 'Contents', 'Resources');
const archive = path.join(fixtureRoot, 'fixture.zip');
const authenticatedArchive = path.join(fixtureRoot, 'authenticated-fixture.zip');
let { createMacUpdater } = require("../host/update-macos");
if (process.argv.includes('--windows-paths')) {
  // Exercise Windows path semantics even when the development machine is POSIX.
  const filename = require.resolve('../host/update-macos');
  const localRequire = require('node:module').createRequire(filename);
  const context = { module: { exports: {} }, process, Buffer, setTimeout,
    require: name => name === 'node:path' ? path : localRequire(name) };
  require('node:vm').runInNewContext(require('node:fs').readFileSync(filename, 'utf8'), context, { filename });
  createMacUpdater = context.module.exports.createMacUpdater;
}
// Controller-only fixtures inject file validation; the real-file retry cases
// below explicitly restore production validation.
const controller = createMacUpdater;
createMacUpdater = options => controller({ validateArtifact: async () => {}, ...options });
const { artifactURL } = require("../host/update-manifest");
const key = crypto.generateKeyPairSync("ed25519");
const publicKey = key.publicKey.export({ type: "spki", format: "pem" });
const version = "0.2.6";
const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, version, platform: "darwin", arch: "arm64", url: artifactURL(version, "arm64"), size: 4, sha256: crypto.createHash("sha256").update("test").digest("hex") }));
const sig = crypto.sign(null, bytes, key.privateKey).toString("base64");
const app = { isPackaged: true, getVersion: () => "0.2.5", getPath: () => fixtureRoot };
(async () => {
  let fetches = 0, downloads = 0, starts = 0, quits = 0, resumes = 0;
  const state = {};
  const updater = createMacUpdater({ app, state, arch: "arm64", publicKey, resourcesPath,
    fetchBytes: async url => { fetches++; return Buffer.from(url.endsWith(".sig") ? sig : bytes); },
    downloadArtifact: async (_manifest, options) => { downloads++; options.onProgress({ percent: 50 }); return archive; },
    startInstaller: async options => { starts++; assert.equal(options.currentVersion, "0.2.5"); assert.equal(options.target, target); return { cancel: async () => {} }; },
  });
  updater.configure({ prepare: async () => () => { resumes++; }, quit: () => { quits++; } });
  assert.equal(updater.init().enabled, true);
  await Promise.all([updater.check(), updater.check()]);
  assert.equal(fetches, 2); assert.equal(downloads, 1); assert.equal(state.downloaded, true); assert.equal(state.progress, 100);
  await Promise.all([updater.install(), updater.install()]);
  assert.equal(state.error, null, "Installer fixture must succeed before testing repeated install requests");
  await updater.install();
  assert.equal(starts, 1); assert.equal(quits, 1); assert.equal(state.installing, true); assert.equal(resumes, 0);
  const blocked = createMacUpdater({ app, state: {}, publicKey: "", fetchBytes: () => { throw Error("must not fetch"); } });
  assert.equal(blocked.init().enabled, false); assert.match((await blocked.check()).error, /No trusted release public key/);
  const same = createMacUpdater({ app: { ...app, getVersion: () => version }, state: {}, arch: "arm64", publicKey,
    fetchBytes: async url => Buffer.from(url.endsWith(".sig") ? sig : bytes), downloadArtifact: () => { throw Error("must not download replay"); } });
  assert.equal((await same.check()).available, false); assert.equal(same.snapshot().error, null);
  const failed = createMacUpdater({ app, state: {}, arch: "arm64", publicKey, resourcesPath,
    fetchBytes: async url => Buffer.from(url.endsWith(".sig") ? sig : bytes), downloadArtifact: async () => archive,
    startInstaller: async () => { throw Error("fixture helper refused"); } });
  failed.configure({ prepare: async () => () => { resumes++; }, quit: () => { throw Error("must not quit"); } });
  await failed.check(); await failed.install();
  assert.match(failed.snapshot().error, /helper refused/); assert.equal(resumes, 1); assert.equal(failed.snapshot().installing, false);
  const busy = createMacUpdater({ app, state: {}, arch: "arm64", publicKey,
    fetchBytes: async url => Buffer.from(url.endsWith(".sig") ? sig : bytes), downloadArtifact: async () => archive,
    startInstaller: async () => { throw Error("must not start"); } });
  busy.configure({ prepare: async () => { throw Error("Unsaved draft"); }, quit: () => { throw Error("must not quit"); } });
  await busy.check(); await busy.install(); assert.match(busy.snapshot().error, /Unsaved draft/);
  const interrupted = createMacUpdater({ app, state: {}, arch: "arm64", publicKey,
    fetchBytes: async url => Buffer.from(url.endsWith(".sig") ? sig : bytes), downloadArtifact: async () => { throw Error("interrupted"); } });
  await interrupted.check(); assert.equal(interrupted.snapshot().downloaded, false); assert.equal(interrupted.snapshot().downloading, false);
  let revealed = 0, checked = 0, recovered = 0, forbiddenQuits = 0;
  const handoff = createMacUpdater({ app, state: {}, arch: "arm64", publicKey,
    resourcesPath,
    fetchBytes: async url => Buffer.from(url.endsWith('.sig') ? sig : bytes),
    downloadArtifact: async () => authenticatedArchive,
    startInstaller: async () => { throw Object.assign(Error('Policy needs user review'), { code: 'UPDATE_MANUAL_TRUST' }); },
    validateArtifact: async () => { if (++checked > 2) throw Error('checksum changed'); }, requireQuarantine: async () => {},
    shell: { showItemInFolder: file => { assert.equal(file, authenticatedArchive); revealed++; }, openExternal: () => assert.fail('Candidate handoff must use verified download') }
  });
  handoff.configure({ prepare: async () => () => { recovered++; }, quit: () => { forbiddenQuits++; } });
  handoff.init(); await handoff.check(); await handoff.install();
  assert.equal(handoff.snapshot().manualRequired, true);
  assert.equal(handoff.snapshot().installing, false);
  assert.equal(recovered, 1); assert.equal(forbiddenQuits, 0);
  await handoff.manual(); assert.equal(checked, 2); assert.equal(revealed, 1);
  assert.match(handoff.snapshot().error, /have not been completed/);
  await handoff.manual(); assert.equal(revealed, 1, 'Changed archive must not be revealed');
  assert.equal(handoff.snapshot().manualAvailable, true, 'Invalidated downloads can use the official manual release page');
  assert.equal(handoff.snapshot().downloaded, false);
  assert.match(handoff.snapshot().error, /checksum changed/);
  let website;
  const unconfigured = createMacUpdater({ app, state: {}, publicKey: '', shell: { openExternal: async url => { website = url; }, showItemInFolder: () => assert.fail() } });
  unconfigured.init(); await unconfigured.manual();
  assert.equal(website, 'https://github.com/Coke1120/Morrow-Mail/releases/latest');
  const disk = require('node:fs/promises'), nativePath = require('node:path');
  const retryRoot = await disk.mkdtemp(nativePath.join(require('node:os').tmpdir(), 'morrow-retry-'));
  try {
    const file = nativePath.join(retryRoot, 'update.zip');
    let requests = 0, copies = 0, preparations = 0;
    const retry = createMacUpdater({ app, state: {}, arch: 'arm64', publicKey, resourcesPath,
      fetchBytes: async url => { requests++; return Buffer.from(url.endsWith('.sig') ? sig : bytes); },
      downloadArtifact: async () => { copies++; await disk.writeFile(file, 'test'); return file; },
      validateArtifact: require('../host/update-manifest').validateArtifact,
      startInstaller: async () => assert.fail('Invalid file must not reach installer') });
    retry.configure({ prepare: async () => { preparations++; return () => {}; }, quit: () => assert.fail() });
    await retry.check(); await disk.unlink(file); await retry.install();
    assert.equal(preparations, 0); assert.equal(retry.snapshot().downloaded, false);
    await retry.check(); assert.equal(copies, 2); assert.equal(requests, 4);
    await disk.writeFile(file, 'evil'); await retry.check();
    assert.equal(copies, 3); assert.equal(requests, 6); assert.equal(await disk.readFile(file, 'utf8'), 'test');
    await retry.check(); assert.equal(copies, 3, 'Valid cached bytes are not downloaded again');
  } finally { await disk.rm(retryRoot, { recursive: true, force: true }); }
  // Exercise the actual macOS IPC branch; the Windows provider is not loaded.
  const vm = require("node:vm"), fs = require("node:fs");
  const handlers = {}, contents = { mainFrame: {} }, win = { isDestroyed: () => false, webContents: contents };
  let installs = 0, handoffs = 0;
  const mac = { manual: async () => { handoffs++; return {}; }, configure() {}, init: () => ({}), check: async () => ({}), refreshStatus: async () => ({}), install: async () => { installs++; return {}; } };
  const host = { module: { exports: {} }, setTimeout() {}, setImmediate() {}, Date,
    require(name) {
      if (name === "electron") return { app: { isPackaged: true }, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } } };
      if (name === "node:process") return { platform: "darwin" };
      if (name === "./update-auth") return {};
      if (name === "./update-macos") return { createMacUpdater: () => mac };
      throw Error("Unexpected native updater dependency: " + name);
    } };
  vm.runInNewContext(fs.readFileSync(require.resolve("../host/updater"), "utf8"), host);
  host.module.exports.configureInstall({ getWindow: () => win });
  host.module.exports.registerIpc();
  assert.throws(() => handlers["host:updateInstall"](), /main application window/);
  assert.throws(() => handlers["host:updateInstall"]({ sender: contents, senderFrame: {} }), /main application window/);
  await handlers["host:updateInstall"]({ sender: contents, senderFrame: contents.mainFrame });
  assert.equal(installs, 1);
  assert.throws(() => handlers['host:updateManual']({ sender: contents, senderFrame: {} }), /main application window/);
  await handlers['host:updateManual']({ sender: contents, senderFrame: contents.mainFrame });
  assert.equal(handoffs, 1);
  console.log("signed-macos-controller-ok (" + (process.argv.includes('--windows-paths') ? 'Windows path emulation' : process.platform) + "; fixtures; native transition still required)");
  if (process.platform !== 'win32' && !process.argv.includes('--windows-paths')) {
    const child = require('node:child_process').spawnSync(process.execPath, [__filename, '--windows-paths'], { stdio: 'inherit' });
    if (child.error) throw child.error;
    assert.equal(child.status, 0, 'Windows path semantics regression suite');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
