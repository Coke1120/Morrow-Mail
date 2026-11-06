// Actual renderer/CSS, synthetic mailbox metadata and local-only mocked IPC.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const root = path.join(__dirname, '..'), output = process.env.MORROW_UI_OUTPUT || path.join(require('node:os').tmpdir(), 'morrow-account-list-browser');

(async () => {
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      let bytes = fs.readFileSync(file);
      if (file.endsWith('/renderer/app.js')) bytes = bytes.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, '');
      res.setHeader('Content-Type', /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
      res.end(bytes);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    fs.mkdirSync(output, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [], external = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (!route.request().url().startsWith(`http://127.0.0.1:${server.address().port}/`)) { external.push(route.request().url().split('?')[0]); return route.abort(); }
      return route.continue();
    });
    await page.addInitScript(() => {
      window.fixtureCalls = []; window.fixtureExpanded = {};
      window.morrow = { on() {}, invoke: async (channel, payload) => {
        fixtureCalls.push({ channel, payload });
        if (channel === 'morrow:configSetSidebarAccountFoldersExpanded') { fixtureExpanded[payload.accountId] = payload.expanded; return { ...fixtureExpanded }; }
        if (channel === 'morrow:configGetSidebarAccountFoldersExpanded') return { ...fixtureExpanded };
        if (channel === 'morrow:configSetSidebarCollapsedFolders') return payload;
        throw new Error('Unexpected synthetic sidebar IPC: ' + channel);
      } };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
    await page.evaluate(() => {
      state.view = 'mail'; document.documentElement.dataset.view = 'mail'; setNavCollapsed(true);
      state.accounts = ['gmail', 'outlook', 'yahoo', 'custom', 'gmail'].map((profile, index) => ({
        id: 'fixture-' + index, email: index === 3 ? 'a-very-long-mailbox-address-for-layout@fixture.invalid' : profile + '-' + index + '@fixture.invalid',
        name: index === 1 ? 'A long saved mailbox name 中文 with punctuation' : '', label: index === 2 ? 'Personal' : '',
        platform: 'imap', imapSmtpProfile: profile, authKind: index === 0 ? 'oauth2' : 'password', mailTransport: index === 0 ? 'gmail_api' : 'imap', delimiter: '/',
        folders: { primary: [{ id: 'INBOX', name: 'Inbox', wellKnownName: 'inbox', type: 'system', unreadCount: 12 },
          { id: '__starred__', name: 'Starred', wellKnownName: 'starred', type: 'virtual', view: { flagged: true } }],
          more: [{ id: 'Projects', name: 'Projects' }, { id: 'Projects/Client', name: 'Projects/Client', unreadCount: 3 }] },
      }));
      state.accounts[0].folders.more.push({ id: 'CATEGORY_SOCIAL', name: 'CATEGORY_SOCIAL', providerId: 'CATEGORY_SOCIAL' },
        { id: 'YELLOW_STAR', name: 'YELLOW_STAR', providerId: 'YELLOW_STAR' }, { id: 'CATEGORY_PERSONAL', name: 'CATEGORY_PERSONAL', providerId: 'Label_custom' });
      state.localAccount = { id: '__morrow_local__', isLocal: true, name: 'Local Folders', email: 'Local Folders', folders: { primary: [{ id: 'local-archive', name: 'Archive', type: 'local', wellKnownName: 'archive' }], more: [] } };
      window.fixtureOriginal = JSON.stringify(mailAccounts());
      state.accountId = 'fixture-0'; state.folderId = 'INBOX'; state.prefs.gmailOpen = true; state.prefs.outlookOpen = true;
      renderSettingsAccounts = refreshMailVacation = () => {};
      window.selections = []; selectFolder = async (accountId, folderId) => { selections.push({ accountId, folderId }); state.accountId = accountId; state.folderId = folderId; renderAccounts(); };
      $('folders').addEventListener('keydown', onFolderNavKey);
      renderAccounts();
    });
    const cases = [];
    for (const width of [1440, 960, 390]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(theme => applyShellTheme(document.documentElement, theme, '#193C34'), theme);
      const metrics = await page.evaluate(() => {
        const headings = [...document.querySelectorAll('.mailbox-account')].map(n => ({ height: n.getBoundingClientRect().height,
          address: n.querySelector('.account-address').textContent, detail: n.querySelector('.account-detail').textContent,
          scroll: n.scrollWidth, width: n.clientWidth, aria: n.getAttribute('aria-label'), description: n.getAttribute('aria-description') }));
        const rows = [...document.querySelectorAll('button.folder[data-folder-id="INBOX"]')].map(n => ({ height: n.getBoundingClientRect().height,
          iconLeft: n.querySelector('.folder-icon').getBoundingClientRect().left, countRight: n.querySelector('.count').getBoundingClientRect().right }));
        return { headings, rows, localActions: [...document.querySelectorAll('.local-folder-actions button')].map(n => ({ label: n.getAttribute('aria-label'), width: n.getBoundingClientRect().width })),
          navOverflow: $('folders').scrollWidth > $('folders').clientWidth + 1 };
      });
      assert.equal(metrics.headings.length, 6);
      assert(metrics.headings.every(h => h.height >= 44 && Math.abs(h.height - metrics.headings[0].height) < 1 && h.scroll <= h.width + 1 && h.aria && h.description), JSON.stringify(metrics));
      assert(metrics.rows.every(r => r.height === 32 && Math.abs(r.iconLeft - metrics.rows[0].iconLeft) < 1 && Math.abs(r.countRight - metrics.rows[0].countRight) < 1));
      assert.equal(metrics.navOverflow, false);
      assert(metrics.localActions.every(b => b.label && b.width >= 28));
      cases.push({ width, theme, accounts: metrics.headings.length, commonHeadingHeight: metrics.headings[0].height, commonFolderHeight: metrics.rows[0].height });
      await page.locator('#folders').screenshot({ path: path.join(output, `accounts-${width}-${theme}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const heading = page.locator('[data-nav-key="account:fixture-3"]');
    await heading.focus(); await heading.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelector('[data-nav-key="account:fixture-3"]').getAttribute('aria-expanded') === 'false');
    assert.equal(await page.locator('[data-account-id="fixture-3"].folder').count(), 0);
    await heading.press('ArrowRight'); await heading.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.accountId), 'fixture-3');
    const parent = page.locator('[data-account-id="fixture-3"][data-folder-id="Projects"]');
    await parent.focus(); await parent.press('ArrowLeft');
    await page.waitForFunction(() => !document.querySelector('[data-account-id="fixture-3"][data-folder-id="Projects/Client"]'));
    await parent.press('ArrowRight');
    await page.waitForFunction(() => !!document.querySelector('[data-account-id="fixture-3"][data-folder-id="Projects/Client"]'));
    await page.locator('[data-account-id="fixture-0"][data-folder-id="CATEGORY_SOCIAL"]').click();
    assert.deepEqual(await page.evaluate(() => selections.at(-1)), { accountId: 'fixture-0', folderId: 'CATEGORY_SOCIAL' });
    assert.equal(await page.locator('[data-account-id="fixture-0"][data-folder-id="CATEGORY_PERSONAL"] .name').textContent(), 'CATEGORY_PERSONAL');
    await page.evaluate(() => showFeatures());
    const card = page.locator('.feature-card').filter({ has: page.getByRole('heading', { name: 'Folder chips and sidebar icons', exact: true }) });
    assert.match(await card.textContent(), /address-first heading/);
    assert.match(await card.textContent(), /Yahoo and custom IMAP/);
    assert.equal(await page.evaluate(() => JSON.stringify(mailAccounts()) === fixtureOriginal), true);
    assert(!await page.evaluate(() => fixtureCalls.some(c => c.channel.startsWith('mail:'))));
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(JSON.stringify({ result: 'passed', cases, keyboard: 'account and real-parent expand/collapse; focus and raw owner routing preserved', externalRequests: 0, pageErrors: 0 }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
