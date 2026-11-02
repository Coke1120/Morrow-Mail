'use strict';
// Actual controller and write gate; Windows installer/Electron are mocks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createGate } = require('../host/update-quiescence');
(async () => {
  const handlers = {}, listeners = {}, timers = new Map();
  let installs = 0, preparations = 0, resumes = 0, refuse = true, emitError = false, quits = 0;
  let quitBehavior = () => {};
  const app = new EventEmitter();
  app.isPackaged = true;
  const gate = createGate();
  const contents = { mainFrame: {} }, win = { isDestroyed: () => false, webContents: contents };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const provider = { on: (name, fn) => { listeners[name] = fn; }, setFeedURL() {},
    quitAndInstall() { installs++; assert.equal(gate.closed, true); assert.equal(gate.pending, 0); if (emitError) listeners.error(Error('installer failed')); } };
  const sandbox = { module: { exports: {} }, Date,
    setTimeout(fn, ms) { const id = { unref() {} }; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    require(name) {
      if (name === 'electron') return { app, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } } };
      if (name === 'node:process') return { platform: 'win32' };
      if (name === 'electron-updater') return { autoUpdater: provider };
      if (name === './update-auth') return { githubFeed: () => ({}), explainUpdateError: e => e.message };
      throw Error(name);
    } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../host/updater'), 'utf8'), sandbox);
  const updater = sandbox.module.exports;
  updater.configureInstall({ getWindow: () => win, quit: () => { quits++; quitBehavior(); }, prepare: async () => {
    preparations++;
    if (refuse) throw Error('Unsaved draft');
    await gate.prepare();
    return () => { resumes++; gate.resume(); };
  } });
  updater.init(); updater.registerIpc(); updater.state.downloaded = true;
  assert.equal(provider.autoInstallOnAppQuit, false, 'Normal quit must never start installation without preparation');
  assert.equal(updater.state.requiresExplicitInstall, true);
  assert.throws(() => handlers['host:updateInstall']({ ...event, senderFrame: {} }), /main application window/);
  await handlers['host:updateInstall'](event);
  assert.equal(installs, 0); assert.match(updater.state.error, /Unsaved draft/);
  refuse = false;
  let finish;
  const work = gate.run(() => new Promise(resolve => { finish = resolve; }));
  const first = handlers['host:updateInstall'](event), duplicate = handlers['host:updateInstall'](event);
  assert.equal(first, duplicate);
  assert.equal(installs, 0, 'Installer must wait for admitted writes');
  finish(); await work; await first;
  assert.equal(installs, 0, 'NSIS must wait for the final quit event; before-quit can still be cancelled');
  assert.equal(quits, 1); assert.equal(preparations, 2);
  await handlers['host:updateInstall'](event); assert.equal(quits, 1);
  const watchdog = [...timers.values()].find(t => t.ms === 120000);
  assert(watchdog); watchdog.fn();
  assert.equal(updater.state.installing, false); assert.equal(gate.closed, false); assert.equal(resumes, 1);
  assert.equal(app.listenerCount('quit'), 0, 'Cancelled/failed preparation cannot arm a later normal quit');
  emitError = true;
  await handlers['host:updateInstall'](event);
  assert.equal(installs, 0);
  app.emit('quit', {}, 0);
  assert.equal(resumes, 2); assert.equal(gate.closed, false); assert.match(updater.state.error, /installer failed/);
  assert.equal([...timers.values()].filter(t => t.ms === 120000).length, 0);
  // Exercise the production scheduled-quit controller. A future scheduled mail
  // prompt may decline, or cleanup may wait; neither can launch the NSIS taskkill.
  emitError = false;
  let choose, cleanups = 0, finishCleanup;
  const controller = require('../host/quit-scheduled').createQuitController({
    platform: 'win32', listRows: () => [{ subject: 'fixture scheduled mail', sendAt: '2099-01-01T00:00:00Z' }],
    requestChoice: () => new Promise(resolve => { choose = resolve; }),
    cleanup: () => { cleanups++; return new Promise(resolve => { finishCleanup = resolve; }); },
    quitApp: () => quitBehavior(),
  });
  quitBehavior = () => {
    const decision = controller.onBeforeQuit({ preventDefault() {} });
    if (decision === 'allow') app.emit('quit', {}, 0);
  };
  const before = installs;
  await handlers['host:updateInstall'](event);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(installs, before);
  choose('stay');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(installs, before, 'Stay open must not have started any installer');
  [...timers.values()].find(t => t.ms === 120000).fn();
  assert.equal(app.listenerCount('quit'), 0);
  await handlers['host:updateInstall'](event);
  await new Promise(resolve => setImmediate(resolve));
  choose('quit');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleanups, 1);
  assert.equal(installs, before, 'Installer waits for asynchronous cleanup too');
  finishCleanup();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(installs, before + 1);
  assert.equal(app.listenerCount('quit'), 0);
  console.log('Windows update controller: draft refusal, draining, final-quit installation, scheduled quit refusal, cleanup, duplicates and failure recovery passed (mock installer).');
})().catch(error => { console.error(error); process.exitCode = 1; });
