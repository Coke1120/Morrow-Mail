"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createMacUpdater } = require("../host/update-macos");
const { artifactURL } = require("../host/update-manifest");
const key = crypto.generateKeyPairSync("ed25519");
const publicKey = key.publicKey.export({ type: "spki", format: "pem" });
const version = "0.2.6";
const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, version, platform: "darwin", arch: "arm64", url: artifactURL(version, "arm64"), size: 4, sha256: crypto.createHash("sha256").update("test").digest("hex") }));
const sig = crypto.sign(null, bytes, key.privateKey).toString("base64");
const app = { isPackaged: true, getVersion: () => "0.2.5", getPath: () => "/tmp" };
(async () => {
  let fetches = 0, downloads = 0, starts = 0, quits = 0, resumes = 0;
  const state = {};
  const updater = createMacUpdater({ app, state, arch: "arm64", publicKey, resourcesPath: "/tmp/Morrow Mail.app/Contents/Resources",
    fetchBytes: async url => { fetches++; return Buffer.from(url.endsWith(".sig") ? sig : bytes); },
    downloadArtifact: async (_manifest, options) => { downloads++; options.onProgress({ percent: 50 }); return "/tmp/fixture.zip"; },
    startInstaller: async options => { starts++; assert.equal(options.currentVersion, "0.2.5"); assert.equal(options.target, "/tmp/Morrow Mail.app"); return { cancel: async () => {} }; },
  });
  updater.configure({ prepare: async () => () => { resumes++; }, quit: () => { quits++; } });
  assert.equal(updater.init().enabled, true);
  await Promise.all([updater.check(), updater.check()]);
  assert.equal(fetches, 2); assert.equal(downloads, 1); assert.equal(state.downloaded, true); assert.equal(state.progress, 100);
  await Promise.all([updater.install(), updater.install()]);
  await updater.install();
  assert.equal(starts, 1); assert.equal(quits, 1); assert.equal(state.installing, true); assert.equal(resumes, 0);
  const blocked = createMacUpdater({ app, state: {}, publicKey: "", fetchBytes: () => { throw Error("must not fetch"); } });
  assert.equal(blocked.init().enabled, false); assert.match((await blocked.check()).error, /No trusted release public key/);
  const same = createMacUpdater({ app: { ...app, getVersion: () => version }, state: {}, arch: "arm64", publicKey,
    fetchBytes: async url => Buffer.from(url.endsWith(".sig") ? sig : bytes), downloadArtifact: () => { throw Error("must not download replay"); } });
  assert.equal((await same.check()).available, false); assert.equal(same.snapshot().error, null);
  const failed = createMacUpdater({ app, state: {}, arch: "arm64", publicKey, resourcesPath: "/tmp/Morrow Mail.app/Contents/Resources",
    fetchBytes: async url => Buffer.from(url.endsWith(".sig") ? sig : bytes), downloadArtifact: async () => "/tmp/fixture.zip",
    startInstaller: async () => { throw Error("fixture helper refused"); } });
  failed.configure({ prepare: async () => () => { resumes++; }, quit: () => { throw Error("must not quit"); } });
  await failed.check(); await failed.install();
  assert.match(failed.snapshot().error, /helper refused/); assert.equal(resumes, 1); assert.equal(failed.snapshot().installing, false);
  const busy = createMacUpdater({ app, state: {}, arch: "arm64", publicKey,
    fetchBytes: async url => Buffer.from(url.endsWith(".sig") ? sig : bytes), downloadArtifact: async () => "/tmp/fixture.zip",
    startInstaller: async () => { throw Error("must not start"); } });
  busy.configure({ prepare: async () => { throw Error("Unsaved draft"); }, quit: () => { throw Error("must not quit"); } });
  await busy.check(); await busy.install(); assert.match(busy.snapshot().error, /Unsaved draft/);
  const interrupted = createMacUpdater({ app, state: {}, arch: "arm64", publicKey,
    fetchBytes: async url => Buffer.from(url.endsWith(".sig") ? sig : bytes), downloadArtifact: async () => { throw Error("interrupted"); } });
  await interrupted.check(); assert.equal(interrupted.snapshot().downloaded, false); assert.equal(interrupted.snapshot().downloading, false);
  let revealed = 0, checked = 0, recovered = 0, forbiddenQuits = 0;
  const handoff = createMacUpdater({ app, state: {}, arch: "arm64", publicKey,
    resourcesPath: "/tmp/Morrow Mail.app/Contents/Resources",
    fetchBytes: async url => Buffer.from(url.endsWith('.sig') ? sig : bytes),
    downloadArtifact: async () => '/tmp/authenticated-fixture.zip',
    startInstaller: async () => { throw Object.assign(Error('Policy needs user review'), { code: 'UPDATE_MANUAL_TRUST' }); },
    validateArtifact: async () => { if (++checked > 1) throw Error('checksum changed'); }, requireQuarantine: async () => {},
    shell: { showItemInFolder: file => { assert.equal(file, '/tmp/authenticated-fixture.zip'); revealed++; }, openExternal: () => assert.fail('Candidate handoff must use verified download') }
  });
  handoff.configure({ prepare: async () => () => { recovered++; }, quit: () => { forbiddenQuits++; } });
  handoff.init(); await handoff.check(); await handoff.install();
  assert.equal(handoff.snapshot().manualRequired, true);
  assert.equal(handoff.snapshot().installing, false);
  assert.equal(recovered, 1); assert.equal(forbiddenQuits, 0);
  await handoff.manual(); assert.equal(checked, 1); assert.equal(revealed, 1);
  assert.match(handoff.snapshot().error, /have not been completed/);
  await handoff.manual(); assert.equal(revealed, 1, 'Changed archive must not be revealed');
  assert.equal(handoff.snapshot().manualAvailable, false);
  assert.match(handoff.snapshot().error, /checksum changed/);
  let website;
  const unconfigured = createMacUpdater({ app, state: {}, publicKey: '', shell: { openExternal: async url => { website = url; }, showItemInFolder: () => assert.fail() } });
  unconfigured.init(); await unconfigured.manual();
  assert.equal(website, 'https://github.com/Coke1120/Morrow-Mail/releases/latest');
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
  console.log("signed-macos-controller-ok (fixtures; native transition still required)");
})().catch(error => { console.error(error); process.exitCode = 1; });
