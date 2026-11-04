// Real Settings markup/controllers and native Chromium dialogs, synthetic data only.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), http = require('node:http'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = process.env.MORROW_UI_OUTPUT || path.join(require('node:os').tmpdir(), 'morrow-settings-help');
const consentDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'morrow-settings-consent-'));
const permission = require('../host/ai-consent').createConsent({ directory: () => consentDir,
  config: () => ({ authMode: 'api_key', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic', model: 'synthetic-model' }) }).status();
async function run() {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + req.url.split('?')[0]);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      let body = fs.readFileSync(file);
      if (file.endsWith('/renderer/app.js')) body = body.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, '');
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : 'text/html'); res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.MORROW_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ permission }) => {
      window.requests = []; window.fixturePermission = permission;
      window.morrow = { on() {}, invoke: async (channel, input) => {
        requests.push({ channel, input });
        if (channel === 'host:aiConsentStatus') return { ...fixturePermission };
        if (channel === 'host:chatgptStatus') return { accounts: [], connected: false, available: true };
        if (channel.startsWith('host:aiConsent') || channel === 'host:aiComplete') throw Error('Unexpected permission write or AI call');
        if (channel.startsWith('mail:')) return { success: true, data: [] };
        return null;
      } };
    }, { permission });
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
    await page.evaluate(async () => {
      loadSettingsFold = () => {}; wire(); openDialog('settings'); revealSettingsFold('compose');
      const account = { id: 'synthetic', email: 'alex@example.invalid', platform: 'imap' };
      state.accounts = [account]; state.accountId = account.id;
      await morrowBrainCompose.load({ accounts: () => state.accounts, selectedId: () => 'synthetic', call: async (channel, input) => {
        requests.push({ channel, input });
        if (channel === 'emailBrain:getComposeSettings') return { accounts: { synthetic: { senderNames: { 'alex@example.invalid': 'Local name' }, aliases: [{ address: 'alias@example.invalid' }] } }, ccByDomain: {}, bccByDomain: {} };
        if (channel === 'mail:getComposeContext') return { sendAs: [{ email: 'alex@example.invalid', name: 'Provider name', isDefault: true }] };
        throw Error(channel);
      } });
      window.testConsent = morrowChatgptSettings.mount({ container: document.getElementById('ai-account-settings'), consentContainer: document.getElementById('ai-data-settings'), invoke: morrow.invoke });
      await testConsent.load({ authMode: 'api_key' });
    });
    const refresh = page.locator('#brain-compose-refresh');
    assert.equal(await refresh.evaluate(node => node.parentElement.querySelector('h4').textContent), 'Sender identities');
    await refresh.click();
    assert.match(await page.locator('#brain-compose-status').textContent(), /refreshed/);
    assert.match(await page.locator('#brain-compose-senders').textContent(), /Local name/);
    assert.equal(await page.evaluate(() => requests.filter(row => row.channel === 'mail:getComposeContext' && row.input.refresh).length), 1);
    await page.screenshot({ path: path.join(output, 'compose-desktop.png') });
    const help = page.locator('[popovertarget="brain-compose-from-help"]').first();
    await help.focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#brain-compose-from-help').evaluate(node => node.matches(':popover-open')), true);
    await page.screenshot({ path: path.join(output, 'compose-help-desktop.png') });
    await page.keyboard.press('Escape'); assert.equal(await help.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('#settings').evaluate(node => node.open), true);
    await help.click(); await page.locator('#brain-compose-from-help button').click();
    assert.equal(await page.locator('#brain-compose-from-help').evaluate(node => node.matches(':popover-open')), false);
    await page.locator('#settings-tab-ai').click();
    const opener = page.locator('#ai-consent-details-open'), modal = page.locator('#ai-consent-details');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({ path: path.join(output, `consent-${theme}-${width}.png`) });
        await opener.focus(); await page.keyboard.press('Enter');
        assert.equal(await modal.evaluate(node => node.open), true);
        assert.equal(await page.locator('#ai-consent-details-close').evaluate(node => node === document.activeElement), true);
        for (let i = 0; i < 6; i++) {
          await page.keyboard.press('Tab');
          assert.equal(await modal.evaluate(node => node.contains(document.activeElement)), true, 'focus stays in details');
        }
        const bounds = await modal.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
        assert.equal(await modal.evaluate(node => node.scrollWidth <= node.clientWidth), true);
        await page.screenshot({ path: path.join(output, `privacy-${theme}-${width}.png`) });
        await page.keyboard.press('Escape');
        assert.equal(await modal.evaluate(node => node.open), false);
        assert.equal(await opener.evaluate(node => node === document.activeElement), true);
        assert.equal(await page.locator('#settings').evaluate(node => node.open), true);
        await opener.click(); await page.locator('#ai-consent-details-close').click();
        assert.equal(await opener.evaluate(node => node === document.activeElement), true);
        assert.equal(await page.locator('#ai-consent-manual').isChecked(), false);
        assert.equal(await page.locator('#ai-consent-background').isChecked(), false);
        assert.equal(await page.locator('#ai-consent-allow').isDisabled(), true);
      }
    }
    await page.locator('#ai-consent-manual').check();
    await opener.click(); await page.locator('#ai-consent-details-close').click();
    assert.equal(await page.locator('#ai-consent-manual').isChecked(), true);
    assert.equal(await page.locator('#ai-consent-background').isChecked(), false);
    assert.equal(await page.evaluate(() => requests.some(row => /host:aiConsent(Grant|Revoke)|host:aiComplete/.test(row.channel))), false);
    await opener.click(); await page.evaluate(() => testConsent.dispose());
    assert.equal(await modal.evaluate(node => node.open), false);
    await page.locator('#settings-tab-compose').click();
    await help.click();
    assert.equal(await page.locator('#brain-compose-from-help').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ path: path.join(output, 'compose-help-narrow-dark.png') });
    await page.keyboard.press('Escape');
    await help.click(); await page.locator('#settings-tab-ai').click();
    assert.equal(await page.locator('#brain-compose-from-help').evaluate(node => node.matches(':popover-open')), false);
    assert.deepEqual(errors, []);
    const setup = await browser.newPage({ viewport: { width: 390, height: 900 } });
    setup.on('pageerror', error => errors.push(error.message));
    await setup.addInitScript(({ permission }) => {
      window.aiSetup = new Proxy({
        get: async () => ({ authMode: 'api_key', baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-model', hasApiKey: true }),
        consentStatus: async () => ({ ...permission }),
        chatgptStatus: async () => ({ accounts: [], available: true, connected: false }),
      }, { get(target, key) { return target[key] || (() => { throw Error('Unexpected Setup action: ' + key); }); } });
    }, { permission });
    await setup.goto(`http://127.0.0.1:${server.address().port}/host/ai-setup.html`);
    await setup.locator('#ai-consent-details-open').click();
    assert.equal(await setup.locator('#ai-consent-details').evaluate(node => node.open), true);
    await setup.screenshot({ path: path.join(output, 'setup-privacy-narrow.png') });
    await setup.keyboard.press('Escape');
    assert.equal(await setup.locator('#ai-consent-details-open').evaluate(node => node === document.activeElement), true);
    assert.equal(await setup.locator('#ai-consent-manual').isChecked(), false);
    assert.equal(await setup.locator('#ai-consent-background').isChecked(), false);
    assert.deepEqual(errors, []);
    await setup.close();
    console.log('settings-help-browser-ok', output);
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(consentDir, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
