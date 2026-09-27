const { app, BrowserWindow, Menu, dialog, ipcMain, shell, session } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createInterface } = require('node:readline');
const { join, resolve, isAbsolute, dirname, basename } = require('node:path');
const { mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { clientState } = require('./client-state.cjs');
const { isSignInURL, isExternalURL } = require('./security.cjs');

app.setName('Morrow Mail');
const smoke = process.argv.includes('--smoke-test');
const smokeDir = smoke ? realpathSync(process.env.MORROW_SMOKE_WORKSPACE || '') : null;
if (smoke) {
  const parent = dirname(smokeDir), temporary = realpathSync(tmpdir());
  const sameParent = process.platform === 'win32' ? parent.toLowerCase() === temporary.toLowerCase() : parent === temporary;
  if (!isAbsolute(process.env.MORROW_SMOKE_WORKSPACE) || !sameParent || !/^morrow-desktop-check-[A-Za-z0-9]+$/.test(basename(smokeDir)) || readFileSync(join(smokeDir, 'disposable-smoke-fixture'), 'utf8') !== 'Morrow desktop acceptance fixture') throw new Error('Smoke checks require a marked disposable temporary workspace.');
}
const seededSmoke = smoke && existsSync(join(smokeDir, 'genmail.sqlite'));
const workspaceOverride = process.env.MORROW_DATA_DIR;
if (workspaceOverride && !isAbsolute(workspaceOverride)) throw new Error('MORROW_DATA_DIR must be an absolute workspace path.');
if (smokeDir || workspaceOverride) {
  const directory = smokeDir || workspaceOverride;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  app.setPath('userData', directory);
  app.setPath('sessionData', directory);
}
const dataDirectory = app.getPath('userData');
const boundsFile = join(dataDirectory, 'window.json');
let window, child, origin, stopping = false, failed = false;
let serviceToken, updateToken, installRequested = false, updatePrompt = false;
const writes = new Set();
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
app.setAppUserModelId('org.morrowmail.desktop');

async function external(url) {
  if (!isExternalURL(url)) return;
  const { response } = await dialog.showMessageBox(window, { type: 'question', message: 'Open this link in your browser?', detail: new URL(url).hostname, buttons: ['Cancel', 'Open Browser'], defaultId: 0, cancelId: 0 });
  if (response === 1) await shell.openExternal(url);
}
async function startService() {
  const backend = app.isPackaged ? join(__dirname, 'backend') : resolve(__dirname, '..');
  const runtime = app.isPackaged ? JSON.parse(readFileSync(join(__dirname, 'package.json'))).serviceRuntime || 'node' : process.env.MORROW_SERVICE_RUNTIME || 'node';
  if (!['node', 'rust'].includes(runtime)) throw new Error('Invalid packaged service runtime.');
  const executable = runtime === 'rust'
    ? (app.isPackaged ? join(__dirname, 'runtime/morrow-service.exe') : resolve(__dirname, '../rust/target/release', process.platform === 'win32' ? 'morrow-service.exe' : 'morrow-service'))
    : (app.isPackaged ? join(__dirname, 'runtime/node.exe') : process.env.MORROW_NODE_BINARY);
  if (!executable) throw new Error('Set MORROW_NODE_BINARY to a standalone Node executable for desktop development.');
  const token = randomBytes(32).toString('hex');
  serviceToken = token; updateToken = randomBytes(32).toString('hex');
  const env = { ...process.env };
  delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(executable, runtime === 'rust' ? [] : [join(backend, 'server/native.js')], { cwd: backend, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  // Never echo provider errors, request bodies, or credentials to the renderer.
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => {});
  child.on('exit', () => { if (!stopping) fatal(); });
  await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Service startup timed out.')), 20_000);
    const lines = createInterface({ input: child.stdout });
    const rejectExit = () => { clearTimeout(timer); reject(new Error('Service did not start.')); };
    child.once('error', rejectExit); child.once('exit', rejectExit);
    lines.once('line', line => {
      clearTimeout(timer); child.removeListener('exit', rejectExit);
      try { const { port } = JSON.parse(line); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(); origin = `http://127.0.0.1:${port}`; accept(); } catch { reject(new Error('Invalid service response.')); }
    });
    child.stdin.write(JSON.stringify({ token, dataDirectory, parentPID: process.pid, updateToken, ...(runtime === 'rust' && !app.isPackaged ? { assetDirectory: join(backend, 'dist') } : {}) }) + '\n');
  });
  return token;
}
function fatal() {
  if (failed || stopping) return;
  failed = true;
  if (!smoke) dialog.showErrorBox('Morrow Mail could not continue', 'The private mail service stopped. Your saved workspace remains on this device. Close and reopen Morrow Mail.');
  stop(1);
}
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (installRequested) {
    try {
      const result = await fetch(`${origin}/api/updates/install`, { method: 'POST', headers: { Authorization: `Bearer ${serviceToken}`, 'X-Morrow-Update': updateToken, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20000) });
      if (!result.ok) throw new Error();
    } catch {
      dialog.showErrorBox('Update could not start', 'The existing app and your data were not replaced. Morrow will reopen; try downloading the update again.');
      app.relaunch();
    }
  }
  // The external smoke driver cleans its workspace after Chromium releases file locks.
  const finish = () => app.exit(code);
  if (!child || child.exitCode !== null) return finish();
  child.once('exit', finish);
  child.stdin.end();
  setTimeout(() => { child.kill(); finish(); }, 70_000).unref();
}
app.on('window-all-closed', () => stop());
app.on('before-quit', event => { if (!stopping && window && !window.isDestroyed()) { event.preventDefault(); window.close(); } });

app.whenReady().then(async () => {
  const token = await startService();
  const isolated = session.fromPartition('persist:morrow');
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on('will-download', event => event.preventDefault());
  let size = {};
  try { const saved = JSON.parse(readFileSync(boundsFile)); if (Number.isFinite(saved.width) && Number.isFinite(saved.height)) size = { width: Math.max(1040, Math.min(saved.width, 2400)), height: Math.max(700, Math.min(saved.height, 1600)) }; } catch {}
  window = new BrowserWindow({ width: 1280, height: 840, ...size, minWidth: 1040, minHeight: 700, show: !smoke, icon: join(__dirname, app.isPackaged ? 'icon.ico' : '../assets/brand/morrow.ico'), backgroundColor: '#f5f4ec', title: 'Morrow Mail', webPreferences: { session: isolated, preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: !app.isPackaged } });
  isolated.webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.webContentsId === window.webContents.id && new URL(details.url).origin === origin) {
      for (const key of Object.keys(details.requestHeaders)) if (key.toLowerCase() === 'authorization') delete details.requestHeaders[key];
      details.requestHeaders.Authorization = `Bearer ${token}`;
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(details.method)) writes.add(details.id);
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  isolated.webRequest.onCompleted(details => writes.delete(details.id));
  isolated.webRequest.onErrorOccurred(details => writes.delete(details.id));
  window.webContents.on('will-navigate', (event, url) => { event.preventDefault(); external(url).catch(() => {}); });
  window.webContents.on('will-redirect', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => { external(url).catch(() => {}); return { action: 'deny' }; });
  window.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(window, { type: 'question', message: 'Discard unsaved changes and close?', buttons: ['Keep Editing', 'Discard'], defaultId: 0, cancelId: 0 });
    if (choice === 1) event.preventDefault(); else installRequested = false;
  });
  window.on('close', event => {
    if (writes.size) { installRequested = false; event.preventDefault(); dialog.showMessageBoxSync(window, { message: 'Wait for the current operation to finish.', detail: 'Morrow is saving or communicating with a provider.', buttons: ['OK'] }); return; }
    if (!window.isMaximized() && !window.isFullScreen()) { try { const { width, height } = window.getBounds(); writeFileSync(boundsFile, JSON.stringify({ width, height })); } catch {} }
  });
  ipcMain.on('morrow:state', (event, operation, key, value) => {
    try {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== origin) throw new Error();
      event.returnValue = { value: clientState(join(dataDirectory, 'client-state.json'), operation, key, value) };
    } catch { event.returnValue = { error: 'Unable to access saved desktop state. Your pending request has not been discarded.' }; }
  });
  ipcMain.handle('morrow:sign-in', async (event, url) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== origin || !isSignInURL(url, origin)) throw new Error('Invalid sign-in request.');
    await shell.openExternal(url);
  });
  ipcMain.handle('morrow:install-update', async event => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== origin) throw new Error('Invalid update request.');
    if (writes.size || updatePrompt || installRequested) throw new Error('Wait for the current operation to finish.');
    updatePrompt = true;
    try {
      const response = await fetch(`${origin}/api/updates/status`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok || (await response.json()).phase !== 'ready') throw new Error('Download and verify an update first.');
      const result = await dialog.showMessageBox(window, { type: 'question', message: 'Install update and restart Morrow Mail?', detail: 'Your saved mail, accounts and settings will stay on this device. Unsaved changes must be resolved before closing.', buttons: ['Later', 'Install & Restart'], defaultId: 0, cancelId: 0 });
      if (result.response === 1 && !writes.size) { installRequested = true; window.close(); }
    } finally { updatePrompt = false; }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ label: 'Close', accelerator: 'Alt+F4', click: () => window.close() }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
  await window.loadURL(origin);
  if (smoke) {
    if (app.isPackaged && JSON.parse(readFileSync(join(__dirname, 'backend/package.json'), 'utf8')).version !== app.getVersion()) throw new Error('Desktop and backend versions differ.');
    // A fresh temporary workspace only: never open or mutate the owner's mailbox.
    const result = await window.webContents.executeJavaScript(`(async () => {
      const until = async predicate => { const deadline = Date.now() + 10000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Desktop UI did not settle.'); await new Promise(resolve => setTimeout(resolve, 50)); } };
      const response = await fetch('/api/state'); const state = await response.json();
      if (!${seededSmoke}) {
        await until(() => document.querySelector('.reader-empty h2')?.textContent === 'Add your first account');
        if (state.accounts.length || document.querySelector('.message-row') || document.querySelector('.sidebar')?.textContent.includes('Demo workspace')) throw new Error('Fresh onboarding exposed a Demo mailbox.');
        return { ok: response.ok, mode: state.account?.mode, count: 0, node: typeof window.require, bridge: typeof window.morrowDesktop?.openSignIn, csp: !!document.querySelector('script[src]') };
      }
      if (state.account?.id !== 'smoke@fixture.invalid') throw new Error('Unexpected smoke mailbox.');
      const owner = state.account.id;
      await until(() => document.querySelector('.message-row'));
      const disclosureKey = 'morrow.account.collapsed.' + owner;
      window.morrowDesktop.writeState(disclosureKey, 'true');
      if (window.morrowDesktop.readState(disclosureKey) !== 'true') throw new Error('Desktop state was not saved.');
      await until(() => document.querySelector('button[aria-label="Mark unread locally"]') && !document.querySelector('.message-body [role="status"]'));
      const opened = state.messages.find(message => message.subject === document.querySelector('.reader-heading h2').textContent);
      document.querySelector('button[aria-label="Mark unread locally"]').click();
      await until(() => document.querySelector('button[aria-label="Mark read locally"]'));
      await new Promise(resolve => setTimeout(resolve, 250));
      await until(() => document.querySelector('.message-list').getAttribute('aria-busy') === 'false');
      const refreshed = await (await fetch('/api/messages/' + encodeURIComponent(opened.id), { headers: { 'X-Genmail-Account': owner } })).json();
      if (refreshed.message.read) throw new Error('Body refresh undid the manual mark-unread action.');
      const search = document.querySelector('input[aria-label="Search inbox"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, 'Northstar');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await until(() => document.querySelector('.search-status strong')?.textContent.includes('matches') && document.querySelector('.message-row mark'));
      if (!document.querySelector('.mailbox-label') || !document.querySelector('.search-match')) throw new Error('Search ownership or match markers are missing.');
      document.querySelector('.search-history summary').click();
      [...document.querySelectorAll('.search-history button')].find(button => button.textContent === 'Save this search').click();
      await until(() => [...document.querySelectorAll('.search-history button')].some(button => button.textContent.includes('★ Northstar')));
      const history = await (await fetch('/api/search/preferences', { headers: { 'X-Genmail-Account': owner } })).json();
      if (history.saved[0]?.query !== 'Northstar') throw new Error('Saved search was not persisted.');
      document.querySelector('button[aria-label="Clear search"]').click();
      await until(() => !document.querySelector('.search-status'));
      const metadata = await (await fetch('/api/state', { headers: { 'X-Morrow-View': 'paged' } })).json();
      if (metadata.messages.some(message => 'body' in message || 'footer' in message)) throw new Error('Metadata included message bodies.');
      for (let i = 0; i < 55; i++) {
        const saved = await fetch('/api/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Genmail-Account': owner }, body: JSON.stringify({ to: 'fixture@example.invalid', subject: 'Pagination fixture ' + i, body: 'Complete fixture draft body ' + i }) });
        if (!saved.ok) throw new Error('Could not seed temporary drafts.');
      }
      [...document.querySelectorAll('.account-folders button')].find(button => button.textContent.startsWith('Drafts')).click();
      await until(() => document.querySelectorAll('.message-row').length === 50 && document.querySelector('.list-footer').textContent.includes('Page 1'));
      const firstKey = document.querySelector('.message-row h3').textContent;
      [...document.querySelectorAll('.list-footer button')].find(button => button.textContent === 'Next').click();
      await until(() => document.querySelector('.list-footer').textContent.includes('Page 2') && document.querySelectorAll('.message-row').length > 0 && document.querySelectorAll('.message-row').length < 50);
      if (document.querySelector('.message-row h3').textContent === firstKey) throw new Error('Mail pagination repeated the first page.');
      document.querySelector('.message-select').click();
      await until(() => document.querySelector('.compose-body')?.value.startsWith('Complete fixture draft body'));
      document.querySelector('button[aria-label="Close dialog"]').click();
      return { ok: response.ok, mode: state.account?.mode, count: state.messages?.length, node: typeof window.require, bridge: typeof window.morrowDesktop?.openSignIn, csp: !!document.querySelector('script[src]') };
    })()`);
    if (!result.ok || result.mode !== (seededSmoke ? 'live' : 'demo') || (seededSmoke ? !result.count : result.count !== 0) || result.node !== 'undefined' || result.bridge !== 'function' || !result.csp) throw new Error('Desktop smoke test failed.');
    if ((await fetch(`${origin}/api/state`)).status !== 401) throw new Error('Private API was exposed.');
    const health = await fetch(`${origin}/api/health`, { headers: { Authorization: `Bearer ${token}` } });
    if (!health.ok) throw new Error('Private service health check failed.');
    console.log(`Desktop smoke passed: ${app.isPackaged ? 'bundled' : 'development'} service, authenticated renderer, ${seededSmoke ? 'owned fixture inbox, indexed search/highlights/saved search, pagination and complete drafts' : 'fresh Add account onboarding without Demo'}, sandbox, private API.`);
    stop();
  }
}).catch(error => { if (smoke) console.error(error.message); fatal(); });
if (smoke) setTimeout(() => { if (!stopping) fatal(); }, 45_000).unref();
