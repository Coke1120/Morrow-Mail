// Real shared permission component and CSS, synthetic host and isolated consent only.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), os = require('node:os'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { createConsent } = require('../host/ai-consent');
const root = path.join(__dirname, '..'), output = process.env.MORROW_UI_OUTPUT || '/tmp/morrow-scoped-consent-browser';
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-permission-browser-'));
  const cfg = { authMode: 'api_key', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic-only', model: 'fixture-model' };
  fs.writeFileSync(path.join(directory, 'ai-consent.json'), JSON.stringify({ id: 'legacy-v3', version: 3, manual: true, background: false,
    fingerprint: crypto.createHash('sha256').update(JSON.stringify([3, 'api_key', cfg.baseUrl + '/chat/completions', cfg.model, '', cfg.apiKey])).digest('hex') }));
  const consent = createConsent({ directory: () => directory, config: () => cfg }), calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/fixture' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { channel, input } = JSON.parse(body); calls.push(channel);
      try {
        let value;
        if (channel === 'host:chatgptStatus') value = { connected: false, available: true, accounts: [] };
        else if (channel === 'host:aiConsentStatus') value = consent.status();
        else if (channel === 'host:aiConsentGrant') value = consent.grant(input);
        else if (channel === 'host:aiConsentRevoke') value = consent.revoke();
        else throw new Error('Unexpected synthetic IPC');
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));
      } catch { res.writeHead(400).end('{}'); } return;
    }
    const file = path.resolve(root, '.' + decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    try { let data = fs.readFileSync(file);
      if (file.endsWith('/renderer/app.js')) data = data.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, '');
      res.setHeader('Content-Type', /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    fs.mkdirSync(output, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
    const errors = [], external = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(`http://127.0.0.1:${server.address().port}/`) ? route.continue() : (external.push('external'), route.abort()));
    await page.addInitScript(() => { window.morrow = { on() {}, invoke: async (channel, input) => {
      const response = await fetch('/fixture', { method: 'POST', body: JSON.stringify({ channel, input }) });
      if (!response.ok) throw new Error('Synthetic request refused'); return response.json();
    } }; });
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
    await page.evaluate(async () => {
      document.querySelector('#settings').showModal(); document.querySelectorAll('#settings .fold').forEach(el => el.hidden = true);
      document.querySelector('#settings-ai').hidden = false; document.querySelector('#settings-ai-panel').hidden = false;
      window.fixtureComponent = window.morrowChatgptSettings.mount({ container: document.querySelector('#ai-account-settings'), consentContainer: document.querySelector('#ai-data-settings'), invoke: morrow.invoke });
      await fixtureComponent.load({ authMode: 'api_key' });
    });
    assert.equal(await page.locator('#ai-consent-manual').isChecked(), true);
    assert.equal(await page.locator('#ai-consent-timeline').isChecked(), true);
    assert.equal(await page.locator('#ai-consent-case').isChecked(), false);
    assert.match(await page.locator('#ai-consent-status').textContent(), /Saved permission:.*Case needs approval/);
    await page.evaluate(async () => { fixtureComponent.dispose(); await fixtureComponent.resume(); });
    assert.equal(await page.locator('#ai-consent-manual').isChecked(), true);
    assert.equal(calls.filter(x => x === 'host:aiConsentGrant').length, 0);
    await page.locator('#ai-consent-case').check(); assert.equal(consent.status().scopes.case, false);
    await page.locator('#ai-consent-allow').click();
    await page.waitForFunction(() => document.querySelector('#ai-consent-status').textContent.includes('Case allowed'));
    assert.equal(consent.status().scopes.case, true); assert.equal(consent.status().background, false);
    for (const width of [1100, 390]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.locator('#ai-consent-status').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('#ai-consent-manual').isChecked(), true);
      await page.screenshot({ path: path.join(output, `saved-${theme}-${width}.png`) });
    }
    await page.locator('#ai-consent-revoke').click(); await page.waitForFunction(() => !document.querySelector('#ai-consent-manual').checked);
    assert.equal(consent.status().manual, false); assert.equal(consent.status().scopes.case, false);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(JSON.stringify({ ok: true, widths: [1100, 390], themes: ['light', 'dark'], hostCalls: calls.length, modelCalls: 0, screenshots: output }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
