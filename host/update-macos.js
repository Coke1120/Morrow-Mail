"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const manifestTools = require("./update-manifest");
const downloads = require("./update-download");
const trust = require("./update-trust");

// This controller never accepts a URL, install path, version or key from IPC.
// Dependency injection is for isolated tests; production uses bundled trust.
function createMacUpdater(options) {
  const { app, state } = options;
  const arch = options.arch || process.arch;
  const publicKey = options.publicKey === undefined ? trust.publicKey : options.publicKey;
  const fetchBytes = options.fetchBytes || downloads.fetchBytes;
  const downloadArtifact = options.downloadArtifact || downloads.downloadArtifact;
  const verifyManifest = options.verifyManifest || manifestTools.verifyManifest;
  let checking = null;
  let installing = null;
  let candidate = null;
  let lifecycle = null;
  function configure(value) { lifecycle = value; }
  function snapshot() { return { ...state }; }
  function error(err) {
    state.checking = false;
    state.downloading = false;
    state.installing = false;
    state.error = err.message || "Authenticated update failed.";
  }
  function requireTrust() {
    if (!publicKey) throw new Error("Signed macOS updates are not configured. No trusted release public key is bundled. Use a verified manual release installation.");
    if (crypto.createPublicKey(publicKey).asymmetricKeyType !== "ed25519") throw new Error("The bundled update public key is invalid.");
    if (!["arm64", "x64"].includes(arch)) throw new Error("Unsupported update architecture.");
  }
  function init() {
    state.channel = "stable";
    state.requiresExplicitInstall = true;
    try { requireTrust(); state.enabled = !!app.isPackaged; }
    catch (err) { state.enabled = false; state.manualAvailable = true; error(err); }
    return snapshot();
  }
  async function performCheck() {
    if (!app.isPackaged || installing) return snapshot();
    if (candidate) return snapshot();
    state.lastAttemptAt = new Date().toISOString();
    state.error = null;
    state.available = false;
    state.downloaded = false;
    try {
      requireTrust();
      state.enabled = true;
      state.checking = true;
      const base = `${manifestTools.RELEASE_ROOT}latest/download/update-manifest-macos-${arch}.json`;
      const bytes = await fetchBytes(base, { maxBytes: manifestTools.MANIFEST_LIMIT });
      const signature = (await fetchBytes(`${base}.sig`, { maxBytes: 100 })).toString("utf8");
      const manifest = verifyManifest(bytes, signature, { publicKey, currentVersion: app.getVersion(), platform: "darwin", arch });
      state.lastCheckedAt = new Date().toISOString();
      state.checking = false;
      state.available = true;
      state.version = manifest.version;
      state.downloading = true;
      const archive = await downloadArtifact(manifest, {
        directory: app.getPath("temp"),
        onProgress: ({ percent }) => { state.progress = Math.min(100, percent); },
      });
      candidate = { archive, manifestBytes: bytes, signature, manifest };
      state.downloading = false;
      state.downloaded = true;
      state.progress = 100;
    } catch (err) {
      candidate = null;
      state.downloaded = false;
      state.available = false;
      if (err.code === "UPDATE_NOT_NEWER") {
        state.checking = false;
        state.lastCheckedAt = new Date().toISOString();
        state.error = null;
      } else error(err);
    }
    return snapshot();
  }
  function check() {
    if (!checking) checking = performCheck().finally(() => { checking = null; });
    return checking;
  }
  async function performInstall() {
    if (!candidate || !lifecycle) return snapshot();
    let resume;
    let started;
    state.error = null;
    state.installing = true;
    state.manualRequired = false;
    state.manualAvailable = false;
    try {
      requireTrust();
      // Closing the write gate and renderer consent happen before helper start.
      resume = await lifecycle.prepare();
      const target = path.resolve(options.resourcesPath || process.resourcesPath, "..", "..");
      const start = options.startInstaller || require("./update-launcher").start;
      started = await start({
        target, archive: candidate.archive, manifestBytes: candidate.manifestBytes,
        signature: candidate.signature, publicKey, currentVersion: app.getVersion(),
        arch, pid: process.pid, execPath: process.execPath,
      });
      // This takes the normal before-quit path. No force-exit or mail-data edits.
      lifecycle.quit();
      // A prevented/hung quit must unfreeze the current application after the
      // helper's exit deadline. The helper never replaces a running old app.
      const timer = setTimeout(async () => {
        try { if (started.cancel) await started.cancel(); } catch { /* journal retains the diagnosis */ }
        if (resume) resume();
        error(new Error("The app did not exit for the update. Your current app and data were retained; retry after finishing active work."));
      }, 120000);
      if (timer.unref) timer.unref();
    } catch (err) {
      if (started && started.cancel) await started.cancel().catch(() => {});
      if (resume) resume();
      error(err);
      if (['UPDATE_MANUAL_TRUST', 'UPDATE_MANUAL_LOCATION', 'EACCES', 'EPERM', 'EROFS'].includes(err.code)) {
        state.manualRequired = true;
        state.manualAvailable = true;
      }
    }
    return snapshot();
  }
  async function manual() {
    if (installing || state.installing || checking || !state.manualAvailable) return snapshot();
    try {
      const shell = options.shell || require('electron').shell;
      if (!candidate) {
        await shell.openExternal('https://github.com/Coke1120/Morrow-Mail/releases/latest');
        return snapshot();
      }
      requireTrust();
      const manifest = verifyManifest(candidate.manifestBytes, candidate.signature, { publicKey, currentVersion: app.getVersion(), platform: 'darwin', arch });
      await (options.validateArtifact || manifestTools.validateArtifact)(candidate.archive, manifest);
      await (options.requireQuarantine || require('./update-installer').requireQuarantine)(candidate.archive);
      // Reveal only: never open/execute a policy-rejected candidate or quit here.
      shell.showItemInFolder(candidate.archive);
      state.manualRequired = true;
      state.error = 'The verified download is shown in Finder. Save your work and quit Morrow before manually replacing the app. Follow macOS security and permission prompts; installation and restart have not been completed by Morrow.';
    } catch (err) { state.manualAvailable = false; error(err); }
    return snapshot();
  }
  function install() {
    if (!installing && !state.installing) installing = performInstall().finally(() => { installing = null; });
    return installing || Promise.resolve(snapshot());
  }
  async function refreshStatus() {
    if (!state.installing && !checking && !candidate && process.resourcesPath) {
      const recovery = await require("./update-launcher").recoveryStatus(path.resolve(process.resourcesPath, "..", ".."));
      if (recovery) state.error = recovery.message;
    }
    return snapshot();
  }
  return { init, configure, check, install, manual, snapshot, refreshStatus };
}
module.exports = { createMacUpdater };
