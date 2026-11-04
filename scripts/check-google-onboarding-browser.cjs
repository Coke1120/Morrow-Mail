// Optional: CHROMIUM=/path/to/chromium node scripts/check-google-onboarding-browser.cjs
// Real, unmodified renderer boot and native dialog events; only IPC is synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { WebSocket } = require('ws');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-startup-browser-'));
  const evidence = process.env.MORROW_UI_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      let body = fs.readFileSync(file);
      if (pathname === '/renderer/index.html') body = Buffer.from(body.toString().replace('<script src="./motion.bundle.js">', '<script src="/scripts/fixtures/google-onboarding-startup.js"></script><script src="./motion.bundle.js">'));
      const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chrome = spawn(process.env.CHROMIUM || 'chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let ws;
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; } catch { await pause(50); }
    }
    assert(port, 'Chromium debugging port available');
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await new Promise(resolve => ws.on('open', resolve));
    let serial = 0; const pending = new Map();
    ws.on('message', raw => { const msg = JSON.parse(raw); if (!msg.id) return; const item = pending.get(msg.id); pending.delete(msg.id); msg.error ? item.reject(msg.error) : item.resolve(msg.result); });
    const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async expression => { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
    const until = async expression => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await pause(30); } throw Error('Timed out: ' + expression); };
    const click = async id => {
      const rect = await evaluate(`(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect });
    };
    const escape = async () => { for (const type of ['keyDown', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); };
    const shot = async name => { if (evidence) fs.writeFileSync(path.join(evidence, name + '.png'), Buffer.from((await call('Page.captureScreenshot')).data, 'base64')); };
    let navigation = 0;
    const navigate = async () => { const url = `${origin}/renderer/index.html?version=${version}&run=${++navigation}`; await call('Page.navigate', { url }); await until(`location.href === ${JSON.stringify(url)} && !!window.syntheticStartup?.ready`); await pause(350); };
    await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    await navigate();
    for (const action of ['changelog-ok', 'changelog-close', 'Escape']) {
      await call('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage' }); await navigate();
      assert.equal(await evaluate('document.querySelector("dialog[open]").id'), 'changelog');
      if (action === 'changelog-ok') await shot('startup-changelog');
      if (action === 'Escape') await escape(); else await click(action);
      await until('document.getElementById("google-onboarding").open'); await pause(350);
      assert.equal(await evaluate('document.querySelectorAll("dialog[open]").length'), 1);
      assert.equal(await evaluate('document.activeElement.id'), 'google-onboarding-import');
      if (action === 'changelog-ok') await shot('startup-onboarding');
      if (action === 'Escape') await escape(); else await click('google-onboarding-later');
      await until('!document.getElementById("google-onboarding").open'); await navigate();
      assert.equal(await evaluate('document.querySelectorAll("dialog[open]").length'), 0);
    }
    // Native close event plus another modal in its close handler: do not stack.
    await call('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage' }); await navigate();
    await evaluate('document.getElementById("changelog").addEventListener("close",()=>document.getElementById("settings").showModal(),{once:true})');
    await click('changelog-ok'); await until('document.getElementById("settings").open'); await pause(100);
    assert.equal(await evaluate('document.getElementById("google-onboarding").open'), false);
    await evaluate('syntheticStartup.status={ready:true,source:"bundled"}');
    await click('settings-close'); await until('!document.getElementById("settings").open'); await pause(150);
    assert.equal(await evaluate('document.getElementById("google-onboarding").open'), false);
    assert.equal(await evaluate('localStorage.getItem("morrow.googleOnboarding.v1")'), 'done');
    await evaluate('showFeatures(); showFeaturesTab("catalog")');
    assert.match(await evaluate('document.getElementById("features-catalog").textContent'), /setup prompt waits for What’s New/);
    assert.equal(await evaluate('syntheticStartup.calls.some(c=>/importGoogleOauth|addAccount/.test(c))'), false);
    await shot('startup-features');
    console.log('PASS Chromium full boot: unseen changelog OK/Close/Escape → single focused onboarding; Later/Escape + reload; intervening Settings; newly configured suppression; rendered Features. Synthetic IPC only.');
  } finally {
    if (ws) ws.close(); chrome.kill(); server.close();
    await new Promise(resolve => chrome.once('exit', resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
