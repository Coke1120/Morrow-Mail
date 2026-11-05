// Chromium + actual renderer and synthetic SQLite cache. No live mail, credentials
// or provider calls. Install Playwright/axe outside the checkout if needed.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const fixture = require('./mail-performance-fixture');
const root = path.join(__dirname, '..');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-to-me-browser-'));
  const output = process.env.MORROW_UI_OUTPUT || path.join(os.tmpdir(), 'morrow-to-me-evidence');
  const previous = { ...process.env }, env = { MORROW_MAIL_DIR: dir, MORROW_USER_DATA: dir, MORROW_MAIL_SECRETS: 'memory' };
  Object.assign(process.env, env);
  const db = require('../host/mail/db'), engine = require('../host/mail/engine');
  const secrets = require('../host/mail/secrets'), originalRead = secrets.getPasswordAsync;
  secrets.getPasswordAsync = async () => { throw new Error('Credential access is forbidden in this fixture'); };
  const requests = [], allowed = new Set(['mail:listFromCache', 'mail:searchLocal', 'mail:listAccounts']);
  let browser, server;
  try {
    await engine.init();
    for (const id of ['a', 'b']) {
      db.insertAccount({ ...fixture.account, id, email: `${id}@fixture.invalid` });
      db.replaceFolders(id, [...fixture.folders, { path: 'All Mail', name: 'All Mail', wellKnown: 'all' }]);
      const messages = Array.from({ length: 450 }, (_, n) => fixture.message(n + 1, {
        id: `${id}-${n}`, subject: `${n % 4 === 0 ? 'Keep' : 'Other'} mail ${String(n).padStart(3, '0')}`,
        to: [n % 2 === 0 ? `${id}@fixture.invalid` : id === 'a' ? 'b@fixture.invalid' : 'a@fixture.invalid'],
        cc: n % 2 ? [`${id}@fixture.invalid`] : [], unread: true, starred: true,
      }));
      db.applyFolderSync(id, 'INBOX', fixture.report(messages));
      db.applyFolderSync(id, 'All Mail', fixture.report(messages.map(row => ({ ...row, id: `all-${row.id}` }))));
    }
    server = http.createServer(async (req, res) => {
      if (req.url === '/fixture/ipc' && req.method === 'POST') {
        try {
          let body = ''; for await (const chunk of req) body += chunk;
          const { channel, payload } = JSON.parse(body); requests.push({ channel, payload });
          const result = allowed.has(channel) ? await engine.answer(channel, [payload]) : { success: true, data: null };
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
        } catch (error) { res.writeHead(500).end(JSON.stringify({ error: error.message })); }
        return;
      }
      if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
      const target = path.join(root, decodeURI(req.url.split('?')[0]));
      if (!target.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      try {
        let data = req.url === '/axe.js' ? fs.readFileSync(require.resolve(process.env.MORROW_AXE_MODULE || 'axe-core/axe.min.js')) : fs.readFileSync(target);
        if (target.endsWith('/renderer/app.js')) data = data.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, '');
        res.setHeader('Content-Type', target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : target.endsWith('.svg') ? 'image/svg+xml' : target.endsWith('.png') ? 'image/png' : 'text/html');
        res.end(data);
      } catch { res.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ executablePath: process.env.MORROW_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.morrow = { on() {}, invoke: async (channel, payload) => (await fetch('/fixture/ipc', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel, payload }),
      })).json() };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
    await page.evaluate(async () => {
      state.view = 'mail'; document.documentElement.dataset.view = 'mail';
      document.documentElement.style.setProperty('--list', '760px'); setNavCollapsed(true);
      state.accounts = await call('mail:listAccounts'); state.accountId = 'a'; state.folderId = 'INBOX';
      state.listSort = { sortBy: 'subject', sortDirection: 'asc' };
      offerChangelog = async () => {}; refreshMailVacation = () => {};
      document.addEventListener('keydown', onShellKey); wireSelection(); wireMailColumnEditor();
      renderAccounts(); await loadList(false, 0);
    });
    const chip = page.locator('[data-filter="to-me"]');
    await chip.focus(); await page.keyboard.press('Space');
    await page.waitForFunction(() => state.toMeOnly && !state.listLoading && !state.busy);
    assert.equal(await chip.getAttribute('aria-pressed'), 'true');
    assert.equal(await chip.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.evaluate(() => state.listTotal), 225);
    assert.equal(await page.evaluate(() => state.emails.length), 200);
    assert.equal(await page.evaluate(() => state.emails.every(row => row.to.includes('a@fixture.invalid'))), true);
    await page.evaluate(() => loadList(false, 200));
    assert.equal(await page.evaluate(() => state.emails.length), 25);
    await chip.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => !state.toMeOnly && !state.listLoading && !state.busy);
    assert.equal(await page.evaluate(() => state.listOffset), 0);
    assert.equal(await page.evaluate(() => state.listTotal), 450);
    await chip.click(); await page.waitForFunction(() => state.toMeOnly && !state.listLoading && !state.busy);
    await page.evaluate(async () => {
      state.allInbox = true; state.allInboxUnreadOnly = true; await loadList(false, 0);
    });
    assert.equal(await page.evaluate(() => state.listTotal), 900, 'existing folder-copy membership is retained');
    assert.equal(await page.evaluate(() => state.emails.every(row => row.to.includes(`${row.accountId}@fixture.invalid`))), true);
    await page.locator('#list-filter').fill('Keep');
    await page.waitForFunction(() => shownEmails().every(row => row.subject.includes('Keep')));
    await page.evaluate(async () => { state.query = 'mail'; state.searchAccountId = 'b'; await loadList(false); });
    assert.equal(await page.evaluate(() => state.emails.length), 100);
    assert.equal(await page.evaluate(() => state.emails.every(row => row.accountId === 'b' && row.to.includes('b@fixture.invalid'))), true);
    assert.equal(await page.locator('#list-filter').inputValue(), 'Keep');
    await page.evaluate(async () => { state.query = ''; state.allInbox = false; state.folderId = 'All Mail'; await loadList(false, 0); });
    assert.equal(await page.evaluate(() => state.toMeOnly), true);
    assert.equal(await page.evaluate(() => state.listTotal), 225);
    fs.mkdirSync(output, { recursive: true });
    const views = [];
    for (const theme of ['light', 'dark']) for (const width of [1440, 900, 440]) {
      await page.setViewportSize({ width, height: 960 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate(value => { applyShellTheme(document.documentElement, value, '#193C34'); renderList(); }, theme);
      const bounds = await chip.evaluate(node => {
        const rect = node.getBoundingClientRect(), host = document.getElementById('messages').getBoundingClientRect();
        const style = getComputedStyle(node);
        return { left: rect.left, right: rect.right, hostLeft: host.left, hostRight: host.right, background: style.backgroundColor, color: style.color };
      });
      assert.ok(bounds.left >= bounds.hostLeft && bounds.right <= bounds.hostRight, `${theme}/${width}: chip stays within the list`);
      views.push({ theme, width, ...bounds });
      await page.screenshot({ path: path.join(output, `to-me-${theme}-${width}.png`) });
    }
    assert.notEqual(views[0].background, views[3].background, 'pressed state follows the theme');
    await page.addScriptTag({ url: '/axe.js' });
    const violations = await page.evaluate(async () => (await axe.run(document.getElementById('list-head'), {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    })).violations.map(row => ({ id: row.id, impact: row.impact, targets: row.nodes.map(node => node.target) })));
    assert.deepEqual(violations, []);
    await page.evaluate(() => showFeatures());
    assert.match(await page.locator('#features-catalog').textContent(), /To Me filter/);
    assert.deepEqual(errors, []);
    assert.ok(requests.some(row => row.channel === 'mail:listFromCache' && row.payload.filterToMe === true));
    assert.ok(requests.some(row => row.channel === 'mail:searchLocal' && row.payload.filterToMe === true));
    console.log(JSON.stringify({ result: 'passed', checks: 'real SQLite paging/counts, owning account, Unread composition, page text, search scope, folder retention, Space/Enter focus, light/dark/narrow/reduced-motion, rendered help, scoped axe', views, output }));
  } finally {
    await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
    secrets.getPasswordAsync = originalRead; await db.close();
    for (const key of Object.keys(env)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
