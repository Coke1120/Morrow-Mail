// Real renderer events and responsive Chromium layout; synthetic IPC only.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), http = require('node:http'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = process.env.MORROW_UI_OUTPUT || path.join(require('node:os').tmpdir(), 'morrow-account-settings');
async function run() {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
    const file = req.url === '/axe.js' ? require.resolve(process.env.MORROW_AXE_MODULE || 'axe-core/axe.min.js') : path.resolve(root, '.' + req.url.split('?')[0]);
    if (req.url !== '/axe.js' && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      let body = fs.readFileSync(file);
      if (file.endsWith('/renderer/app.js')) body = body.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, '');
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.MORROW_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.requests = [];
      window.morrow = { on() {}, invoke: async (channel, input) => {
        requests.push({ channel, input });
        if (channel === 'mail:oauthStatus') return { success: true, data: window.readPermissions ? await window.readPermissions() : { accounts: [] } };
        if (channel === 'mail:googleOauthStatus') return { success: true, data: { ready: true, source: 'bundled' } };
        if (channel === 'mail:vacationGet') return { success: true, data: { accountId: input.accountId, provider: 'imap', supported: true, canWrite: true, revision: 'synthetic', settings: { mode: 'always', subject: 'Away', message: 'Synthetic reply', audience: 'all' } } };
        if (channel === 'mail:listSignatures') return { success: true, data: { signatures: [] } };
        if (channel === 'mail:listAccounts') return { success: true, data: [] };
        if (channel.startsWith('mail:')) return { success: true, data: [] };
        return null;
      } };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
    await page.evaluate(() => { wire(); openSettings(); revealSettingsFold('mailbox'); });
    await page.waitForFunction(() => settingsFoldLoaded.has('mailbox:'));
    assert.equal(await page.locator('#settings-account-detail').isVisible(), false);
    assert.match(await page.locator('#settings-accounts').textContent(), /No accounts yet/);
    await page.locator('#connect-open').click(); await page.locator('#connect[open]').waitFor();
    assert.equal(await page.locator('#email').inputValue(), '');
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      state.accounts = [
        { id: 'a', email: 'alex@example.invalid', name: 'Personal', platform: 'imap', authKind: 'oauth2', imapSmtpProfile: 'gmail', mailTransport: 'gmail_api' },
        { id: 'b', email: 'operations.and.support@international-example.invalid', name: 'Work', platform: 'imap', authKind: 'oauth2', imapSmtpProfile: 'outlook', needsReauth: true },
      ];
      state.accountId = 'a'; state.settingsAccountId = null;
      openSettings(); revealSettingsFold('mailbox'); renderSettingsAccounts();
    });
    await page.waitForFunction(() => settingsFoldLoaded.has('mailbox:a'));
    const card = id => page.locator(`#settings-accounts button[data-account-id="${id}"]`);
    assert.match(await page.locator('#settings-account-title').textContent(), /alex@example.invalid/);
    await page.evaluate(() => { state.accountId = null; state.settingsAccountId = null; renderSettingsAccounts(); state.accountId = 'b'; renderSettingsAccounts(); });
    assert.equal(await page.evaluate(() => settingsAccount().id), 'a', 'the displayed fallback stays independent of Mail');
    await page.evaluate(() => { state.accountId = 'a'; });
    assert.equal(await page.locator('.settings-account-context').isVisible(), false);
    await card('b').focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => settingsFoldLoaded.has('mailbox:b'));
    assert.match(await page.locator('#settings-account-title').textContent(), /operations.and.support/);
    assert.equal(await card('b').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.accountId), 'b');
    assert.equal(await page.evaluate(() => state.accountId), 'a');
    assert.match(await card('b').textContent(), /Microsoft.*Sign-in needed/s);
    await page.locator('#settings-reconnect').click();
    assert.match(await page.locator('#connect-title').textContent(), /operations.and.support/);
    await page.keyboard.press('Escape'); await page.evaluate(() => { openSettings(); revealSettingsFold('mailbox'); });
    await page.waitForFunction(() => settingsFoldLoaded.has('mailbox:b'));

    // Scope signatures to B while Mail stays on A.
    await page.locator('#signatures-open').click(); await page.locator('#signatures[open]').waitFor();
    assert.match(await page.locator('#signatures-title').textContent(), /operations.and.support/);
    await page.locator('#signatures-close').click();
    await page.evaluate(() => { openSettings(); revealSettingsFold('mailbox'); });
    await page.waitForFunction(() => settingsFoldLoaded.has('mailbox:b'));
    await page.locator('#settings-account-ooo').click();
    await page.waitForFunction(() => vacationCache?.accountId === 'b');
    assert.equal(await page.locator('.settings-account-context').isVisible(), true);
    await page.locator('#ooo-message').fill('Unsaved work reply');
    await page.locator('#settings-tab-mailbox').click();
    await card('a').click(); await page.locator('#confirm[open]').waitFor();
    await page.evaluate(() => document.querySelector('#settings-accounts button[data-account-id="a"]').click());
    assert.equal(await page.locator('#confirm[open]').count(), 1);
    await page.locator('#confirm-cancel').click();
    assert.equal(await page.evaluate(() => settingsAccount().id), 'b');
    assert.equal(await page.locator('#ooo-message').inputValue(), 'Unsaved work reply');
    await card('a').click(); await page.locator('#confirm-ok').click();
    await page.waitForFunction(() => settingsFoldLoaded.has('mailbox:a'));
    assert.equal(await page.evaluate(() => oooDirty()), false);

    // A late permissions result cannot repaint a newer target; cards stay operable.
    await page.evaluate(() => {
      window.permissionReads = 0;
      window.readPermissions = () => ++window.permissionReads === 1 ? new Promise(resolve => { window.releaseOldPermission = resolve; }) : Promise.resolve({ accounts: [{ id: 'a', organize: true, rules: true }] });
      settingsFoldLoaded.clear(); loadSettingsFold('mailbox');
    });
    await page.waitForFunction(() => typeof window.releaseOldPermission === 'function');
    assert.equal(await page.locator('#settings-mailbox-panel').evaluate(node => node.inert), false);
    await card('b').click(); await card('a').click();
    await page.waitForFunction(() => settingsFoldLoaded.has('mailbox:a'));
    await page.evaluate(() => { window.releaseOldPermission({ accounts: [{ id: 'a', organize: false, rules: false }] }); window.readPermissions = null; });
    await page.waitForTimeout(100);
    assert.match(await page.locator('#settings-capabilities').textContent(), /Rules: Permission granted/);

    // Reviewed removal: cancel must perform no host write.
    await page.locator('#account-recovery > summary').click();
    let review = ''; page.once('dialog', async dialog => { review = dialog.message(); await dialog.dismiss(); });
    await page.locator('#remove').click(); assert.match(review, /alex@example.invalid.*Messages stay on the server/);
    assert.equal(await page.evaluate(() => requests.filter(row => row.channel === 'mail:removeAccount').length), 0);
    await page.locator('#account-recovery > summary').click();

    await page.addScriptTag({ url: '/axe.js' });
    const accessibility = [];
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const size of [{ width: 1440, height: 1000 }, { width: 1024, height: 768 }, { width: 800, height: 600 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
        await page.setViewportSize(size);
        await page.evaluate(() => document.querySelector('#settings .dialog-body').scrollTop = 0);
        assert.equal(await page.locator('#settings .dialog-body').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, `${theme} ${size.width}: horizontal overflow`);
        assert.equal(await card('a').evaluate(node => node.getBoundingClientRect().height >= 44), true);
        const violations = await page.evaluate(async () => (await axe.run(document.getElementById('settings'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })));
        accessibility.push({ theme, size, violations }); assert.deepEqual(violations, [], JSON.stringify({ theme, size, violations }));
        await page.screenshot({ path: path.join(output, `accounts-${theme}-${size.width}x${size.height}.png`) });
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => { document.getElementById('account-recovery').open = true; document.getElementById('remove').focus(); });
    await page.evaluate(() => { state.accounts = [state.accounts[1]]; state.accountId = null; state.settingsAccountId = 'removed'; renderSettingsAccounts(); });
    assert.equal(await page.evaluate(() => document.activeElement.dataset.accountId), 'b', 'removed-account action focus returns to the remaining account');
    await page.evaluate(() => { document.getElementById('account-recovery').open = false; });
    assert.equal(await page.locator('#settings-accounts button').count(), 1);
    assert.equal(await card('b').getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('#settings-account-title').textContent(), /operations.and.support/);
    await page.screenshot({ path: path.join(output, 'accounts-single.png') });
    await page.locator('#settings-close').click();
    await page.evaluate(() => { openSettings(); revealSettingsFold('mailbox'); });
    await page.waitForFunction(() => settingsFoldLoaded.has('mailbox:b'));
    assert.equal(await card('b').getAttribute('aria-pressed'), 'true');
    await card('b').focus(); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-reconnect');
    await page.keyboard.press('Escape'); await page.locator('#settings').waitFor({ state: 'hidden' });
    await page.evaluate(() => { openSettings(); revealSettingsFold('mailbox'); document.getElementById('account-recovery').open = true; document.getElementById('remove').focus(); state.accounts = []; state.settingsAccountId = null; state.accountId = null; renderSettingsAccounts(); });
    await page.waitForFunction(() => settingsFoldLoaded.has('mailbox:'));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'connect-open', 'last-account removal focuses Add account');
    assert.equal(await page.locator('#settings-account-detail').isVisible(), false);
    await page.screenshot({ path: path.join(output, 'accounts-empty.png') });
    await page.evaluate(() => { document.getElementById('settings').close(); showFeatures(); });
    assert.match(await page.locator('#features-catalog').textContent(), /actionable cards.*Unsaved Out of Office edits require discard confirmation/s);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ result: 'passed', errors, accessibility, coverage: 'empty, single, multi, keyboard, reconnect, signatures, Out of Office scope, repeated discard/cancel, stale permissions, removal cancel, reopen, Features', nativeWindows: 'not run' }, null, 2));
    console.log('account-settings-browser-ok', output);
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
