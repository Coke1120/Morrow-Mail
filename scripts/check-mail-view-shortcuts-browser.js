// Real renderer/keyboard/focus with synthetic IPC; never opens native windows or mail providers.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), http = require('node:http'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const output = process.env.MORROW_UI_OUTPUT || path.join(require('node:os').tmpdir(), 'morrow-mail-view-shortcuts');

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
    if (req.url === '/axe.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(require.resolve(process.env.MORROW_AXE_MODULE || 'axe-core/axe.min.js'))); return; }
    const target = path.resolve(root, '.' + new URL(req.url, 'http://fixture.invalid').pathname);
    if (!target.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      let data = fs.readFileSync(target);
      if (target.endsWith('/renderer/app.js')) data = data.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, '');
      res.setHeader('Content-Type', target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : target.endsWith('.svg') ? 'image/svg+xml' : target.endsWith('.png') ? 'image/png' : 'text/html');
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.MORROW_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const checks = [];
  fs.mkdirSync(output, { recursive: true });
  try {
    async function fixture(options = {}) {
      const page = await browser.newPage({ viewport: options.viewport || { width: 1440, height: 960 } }), errors = [];
      page.setDefaultTimeout(7000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.type() + ': ' + message.text()); });
      await page.addInitScript(() => {
        window.composes = []; window.popouts = []; window.writes = []; window.calls = [];
        window.morrow = { on() {}, invoke: async (_channel, value) => value,
          openComposeWindow: async seed => { composes.push(seed); }, openReaderWindow: async seed => { popouts.push(seed); } };
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html${options.reader ? '?role=reader' : ''}`);
      assert.equal(await page.title(), 'Morrow Mail');
      await page.evaluate(({ conversation = false, crossAccount = true, reader = false, theme = 'light' }) => {
        const account = id => ({ id, name: 'Synthetic ' + id, email: id + '@fixture.invalid', platform: 'imap', imapSmtpProfile: 'custom', folders: { primary: [{ id: 'INBOX', name: 'Inbox', wellKnownName: 'inbox' }], more: [{ id: 'Archive', name: 'Archive' }] } });
        state.accounts = [account('a'), account('b')]; state.accountId = 'a'; state.folderId = 'INBOX'; state.view = 'mail'; state.allInbox = crossAccount;
        state.prefs.conversation = conversation; state.prefs.images = false; state.prefs.chips = false; state.listTotal = 2; state.listSyncDone = true;
        window.messages = ['A', 'B', 'C'].map(id => ({ id, accountId: id === 'B' && crossAccount ? 'b' : 'a', folderId: id === 'C' ? 'Archive' : 'INBOX', subject: 'Message ' + id,
          from: 'sender-' + id.toLowerCase() + '@fixture.invalid', to: [(id === 'B' && crossAccount ? 'b' : 'a') + '@fixture.invalid'], date: '2026-11-02T12:00:00Z', unread: false,
          textBody: 'Synthetic body ' + id, bodyComplete: true, threadId: id === 'B' ? 'thread-b' : 'thread-a', messageId: '<' + id + '@fixture.invalid>' }));
        state.emails = messages.filter(row => row.folderId === 'INBOX').map(row => ({ ...row }));
        call = async (channel, params = {}) => {
          calls.push({ channel, params });
          if (channel === 'mail:openEmail') return { email: { ...messages.find(row => row.id === params.emailId) }, threadMessages: [] };
          if (channel === 'mail:listThreadMessages') return messages.filter(row => row.threadId === params.threadId);
          if (channel === 'mail:listAccounts') return state.accounts;
          if (channel === 'mail:listFromCache') return { emails: messages.filter(row => row.folderId === 'INBOX'), total: 2, initialSyncDone: true };
          if (['mail:delete', 'mail:threadTrash', 'mail:deleteBatch'].includes(channel)) {
            writes.push({ channel, params });
            const items = params.items || [params]; messages = messages.filter(row => !items.some(item => item.emailId === row.id));
            return { outcomes: items.map(item => ({ id: item.emailId, accountId: item.accountId, status: 'completed', opId: 'synthetic-' + item.emailId })) };
          }
          return [];
        };
        refreshMailVacation = () => { $('mail-ooo').hidden = true; };
        wire(); setNavCollapsed(true); applyShellTheme(document.documentElement, theme, '#193C34'); renderAccounts(); renderList(); renderReader(false);
        if (reader) { state.prefs.mailView.layout = 'window'; state.email = messages[1]; state.thread = []; renderReader(false); }
      }, options);
      return { page, errors };
    }
    const row = (page, id) => page.locator(`.message-row[data-email-id="${id}"] button.message`);
    async function choose(page, label) { await page.locator('#mail-view-open').click(); await page.getByRole('menuitemradio', { name: label, exact: true }).click(); }
    async function prepare(page, mode = 'Separate window') {
      await row(page, 'A').click(); await page.waitForFunction(() => state.email?.id === 'A');
      if (mode !== 'Right preview') await choose(page, mode);
      await row(page, 'B').click();
      if (mode !== 'Separate window') await page.waitForFunction(() => state.email?.id === 'B');
    }
    async function done(f, name) { assert.deepEqual(f.errors, []); checks.push(name); await f.page.close(); }

    for (const conversation of [false, true]) for (const crossAccount of [false, true]) {
      const f = await fixture({ conversation, crossAccount }), page = f.page; await prepare(page);
      const before = await page.evaluate(() => ({ email: state.email.id, selected: state.selectedIds, reader: getComputedStyle($('reader')).display, open: mailShortcutContext({ target: document.activeElement }).mailOpen, calls: calls.length }));
      assert.equal(before.email, 'A'); assert.deepEqual(before.selected, ['B']); assert.equal(before.reader, 'none'); assert.equal(before.open, false);
      for (const key of ['r', 'a', 'f', 'Delete', 'Backspace']) await page.keyboard.press(key);
      await page.evaluate(() => { for (const action of ['reply', 'reply-all', 'forward', 'delete']) runMailShortcut(action); });
      assert.deepEqual(await page.evaluate(() => ({ writes: writes.length, composes: composes.length, confirmation: $('confirm').open, calls: calls.length })), { writes: 0, composes: 0, confirmation: false, calls: before.calls });
      await done(f, `hidden preview blocked: conversation=${conversation}, crossAccount=${crossAccount}`);
    }

    for (const mode of ['Right preview', 'Bottom preview', 'reader']) for (const key of ['r', 'a', 'f', 'Delete', 'Backspace']) {
      const f = await fixture({ reader: mode === 'reader' }), page = f.page;
      if (mode !== 'reader') await prepare(page, mode);
      else await page.locator('#reader').getByRole('button', { name: 'Reply', exact: true }).focus();
      await page.keyboard.press(key);
      if (['Delete', 'Backspace'].includes(key)) {
        await page.locator('#confirm[open]').waitFor(); assert.equal(await page.evaluate(() => writes.length), 0);
        await page.locator('#confirm-ok').click(); await page.waitForFunction(() => writes.length > 0);
        assert.deepEqual(await page.evaluate(() => writes[0].params), { accountId: 'b', emailId: 'B' });
      } else { await page.waitForFunction(() => composes.length > 0); assert.deepEqual(await page.evaluate(() => [composes[0].sourceMessageId, composes[0].accountId]), ['B', 'b']); }
      await done(f, `${mode}: ${key} targets visible B`);
    }

    {
      const f = await fixture({ conversation: true }), page = f.page; await prepare(page);
      const message = page.locator('.message-row[data-email-id="B"]'); await message.hover(); await message.getByRole('button', { name: 'Reply', exact: true }).click();
      await page.waitForFunction(() => composes.length > 0); assert.deepEqual(await page.evaluate(() => [composes[0].sourceMessageId, composes[0].accountId]), ['B', 'b']);
      await message.hover(); await message.getByRole('button', { name: 'Delete', exact: true }).click(); await page.locator('#confirm[open]').waitFor();
      await page.locator('#confirm-ok').click(); await page.waitForFunction(() => writes.length > 0);
      assert.deepEqual(await page.evaluate(() => writes[0].params), { emailId: 'B', accountId: 'b' });
      await done(f, 'explicit row actions use B, excluding hidden A/C conversation');
    }

    for (const theme of ['light', 'dark']) for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
      const f = await fixture({ theme, viewport }), page = f.page; await prepare(page); await choose(page, 'Right preview');
      await page.locator('#reader').getByRole('button', { name: 'Reply', exact: true }).focus();
      await page.evaluate(() => saveMailView({ ...state.prefs.mailView, layout: 'window' }));
      assert.equal(await row(page, 'B').evaluate(node => node === document.activeElement), true);
      assert.equal(await page.evaluate(() => state.email.id), 'A'); assert.equal(await page.evaluate(() => writes.length + composes.length + popouts.length), 0);
      const box = await row(page, 'B').boundingBox(); assert.ok(box.y >= 0 && box.y < viewport.height);
      await page.screenshot({ path: path.join(output, `focus-${theme}-${viewport.width}.png`) });
      await page.keyboard.press('Control+f'); assert.equal(await page.locator('#search-query').evaluate(node => node === document.activeElement), true);
      await row(page, 'A').focus(); await page.keyboard.press('ArrowDown'); assert.equal(await row(page, 'B').evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Enter'); await page.waitForFunction(() => popouts.length === 1);
      assert.deepEqual(await page.evaluate(() => popouts[0]), { accountId: 'b', messageId: 'B' });
      await done(f, `${theme}/${viewport.width}: focus returns to B; arrows/Enter/search retain their targets`);
    }

    {
      const f = await fixture(), page = f.page; await prepare(page); await choose(page, 'Right preview');
      await page.locator('#mail-view-open').click();
      for (const key of ['r', 'a', 'f', 'Delete', 'Backspace', 'Control+a']) await page.keyboard.press(key);
      assert.equal(await page.evaluate(() => writes.length + composes.length), 0); assert.deepEqual(await page.evaluate(() => state.selectedIds), ['B']);
      await page.addScriptTag({ url: '/axe.js' });
      assert.deepEqual(await page.evaluate(async () => (await axe.run($('mail-view-control'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations.map(row => row.id)), []);
      await page.keyboard.press('Tab'); assert.equal(await page.locator('#mail-view-menu').isVisible(), false);
      await page.locator('#mail-view-open').click(); await page.keyboard.press('Shift+Tab');
      assert.equal(await page.locator('#mail-view-menu').isVisible(), false); assert.equal(await page.locator('#search-query').evaluate(node => node === document.activeElement), true);
      await page.evaluate(() => saveMailView({ ...state.prefs.mailView, layout: 'window' }));
      assert.equal(await page.locator('#search-query').evaluate(node => node === document.activeElement), true);
      await done(f, 'View menu owns keys, closes on Tab/Shift+Tab, preserves search focus; axe passes');
    }
    {
      const f = await fixture(), page = f.page; await page.evaluate(() => showFeatures());
      assert.match(await page.locator('#features-catalog').textContent(), /R, A, F, Delete and Backspace are inactive/);
      await page.locator('#features-tab-shortcuts').click();
      assert.match(await page.locator('#shortcuts-note').textContent(), /their shortcuts are inactive in the main list/);
      await done(f, 'rendered Features and Shortcuts describe the available reading commands');
    }
    console.log(JSON.stringify({ result: 'passed', cases: checks.length, checks, output }));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
