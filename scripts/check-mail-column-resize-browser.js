// Optional real-browser synthetic QA. No mailbox, provider or user data is used.
// MORROW_PLAYWRIGHT_MODULE and MORROW_CHROMIUM may select installed browser tools.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), http = require('node:http'), path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = process.env.MORROW_UI_OUTPUT || path.join(require('node:os').tmpdir(), 'morrow-column-resize-browser');
(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
    const target = path.resolve(root, '.' + decodeURI(req.url.split('?')[0]));
    if (!target.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      let data = fs.readFileSync(target);
      if (target.endsWith('/renderer/app.js')) data = data.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, '');
      res.setHeader('Content-Type', target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : target.endsWith('.svg') ? 'image/svg+xml' : target.endsWith('.png') ? 'image/png' : 'text/html');
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    browser = await chromium.launch({ executablePath: process.env.MORROW_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const keys = {
        'morrow:configGetMailColumnOrder': 'resize.order', 'morrow:configSetMailColumnOrder': 'resize.order',
        'morrow:configGetMailHiddenColumns': 'resize.hidden', 'morrow:configSetMailHiddenColumns': 'resize.hidden',
        'morrow:configGetMailColumnWidths': 'resize.widths', 'morrow:configSetMailColumnWidths': 'resize.widths',
      };
      window.fixtureWrites = [];
      window.morrow = { on() {}, invoke: async (channel, value) => {
        if (!keys[channel]) return null;
        if (channel.includes('Set')) { localStorage.setItem(keys[channel], JSON.stringify(value)); fixtureWrites.push({ channel, value }); }
        return JSON.parse(localStorage.getItem(keys[channel]) || 'null');
      } };
    });
    async function initialize() {
      await page.evaluate(async () => {
        document.documentElement.dataset.view = 'mail';
        document.documentElement.style.setProperty('--list', '1100px');
        document.documentElement.style.setProperty('--folders', '180px');
        setNavCollapsed(true); state.view = 'mail'; state.accountId = 'fixture'; state.folderId = 'INBOX'; state.listSyncDone = true;
        state.accounts = [{ id: 'fixture', email: 'owner@fixture.invalid', name: 'Synthetic mailbox', folders: { primary: [{ id: 'INBOX', name: 'Inbox', wellKnownName: 'inbox' }], more: [] } }];
        state.emails = Array.from({ length: 8 }, (_, i) => ({ id: 'fixture-' + i, accountId: 'fixture', folderId: 'INBOX',
          from: 'Synthetic Sender <sender@fixture.invalid>', to: ['recipient@fixture.invalid'], subject: 'Synthetic subject ' + i,
          date: new Date(1793577600000 - i * 1000).toISOString(), unread: false, snippet: 'Synthetic mail only.', threadId: 'fixture-thread-' + i }));
        state.listTotal = state.emails.length;
        globalThis.fixtureCalls = [];
        call = async (channel, params) => { fixtureCalls.push({ channel, params }); return channel === 'mail:listFromCache' ? { emails: state.emails, total: state.emails.length, initialSyncDone: true } : []; };
        offerChangelog = async () => {};
        refreshMailVacation = async () => {};
        await loadMailColumnOrder(); wireMailColumnEditor(); renderAccounts(); renderList();
        document.getElementById('mail-ooo').hidden = true;
      });
    }
    const handle = id => page.locator('.mail-column-resize[data-resize-column="' + id + '"]');
    const widths = () => page.evaluate(() => ({ ...state.mailColumnWidths }));
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('resize.widths') || '{}'));
    const sort = () => page.evaluate(() => JSON.stringify(state.listSort));
    async function settled() { await page.waitForFunction(() => JSON.stringify(JSON.parse(localStorage.getItem('resize.widths') || '{}')) === JSON.stringify(state.mailColumnWidths)); }
    async function stableGeometry() {
      // Startup/navigation motion can change flexible tracks across multiple
      // frames. Wait for actual geometry to settle instead of loosening asserts.
      await page.evaluate(() => { globalThis.fixtureGeometry = { sample: null, frames: 0 }; });
      await page.waitForFunction(() => {
        const list = document.getElementById('message-list');
        const rects = [list, ...document.querySelectorAll('.mail-list-columns [data-sort-key]')]
          .filter(node => node.getBoundingClientRect().width > 0)
          .map(node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
        const sample = JSON.stringify([list.scrollLeft, list.scrollTop, rects]);
        const probe = globalThis.fixtureGeometry;
        probe.frames = probe.sample === sample ? probe.frames + 1 : 0;
        probe.sample = sample;
        return probe.frames >= 6;
      }, null, { polling: 'raf' });
    }
    async function alignment() {
      await stableGeometry();
      const values = await page.evaluate(() => [...document.querySelectorAll('.mail-list-columns [data-sort-key]')]
        .filter(head => head.getBoundingClientRect().width > 0).map(head => {
          const key = head.dataset.sortKey, cell = document.querySelector('.row-main [data-mail-column="' + key + '"]');
          const h = head.getBoundingClientRect(), c = cell?.getBoundingClientRect();
          return { key, head: { x: h.x, width: h.width }, cell: c && { x: c.x, width: c.width } };
        }));
      assert.equal(values.length, await page.locator('.mail-list-columns [data-resize-column]:visible').count());
      for (const v of values) assert.ok(v.cell && Math.abs(v.head.x - v.cell.x) < 2 && Math.abs(v.head.width - v.cell.width) < 2, JSON.stringify(v));
      return values;
    }
    async function beginDrag(id, delta) {
      await handle(id).scrollIntoViewIfNeeded();
      await stableGeometry();
      const box = await handle(id).boundingBox(); assert.ok(box);
      const column = await page.locator('[data-sort-key="' + id + '"]').boundingBox(); assert.ok(column);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + delta, box.y + box.height / 2, { steps: 8 });
      return column.width;
    }
    await page.goto('http://127.0.0.1:' + server.address().port + '/renderer/index.html'); await initialize();
    const originalSort = await sort(); await alignment();
    const senderBefore = await beginDrag('sender', 45); await page.mouse.up(); await settled();
    const dragWidths = await widths();
    assert.ok(Math.abs(dragWidths.sender - (senderBefore + 45)) <= 2, JSON.stringify({ senderBefore, dragWidths }));
    assert.equal(await sort(), originalSort, 'resize must not sort'); await alignment();
    assert.equal((await saved()).sender, dragWidths.sender);
    await handle('sender').focus(); await page.keyboard.press('ArrowRight'); await settled();
    assert.equal((await widths()).sender, dragWidths.sender + 10);
    await page.keyboard.press('Shift+ArrowLeft'); await settled(); assert.equal((await widths()).sender, dragWidths.sender - 40);
    await page.keyboard.press('Home'); await settled(); assert.equal((await widths()).sender, 100);
    await page.keyboard.press('End'); await settled(); assert.equal((await widths()).sender, 640);
    assert.equal(await handle('sender').getAttribute('aria-valuenow'), '640');
    await page.keyboard.press('ArrowRight'); assert.equal((await widths()).sender, 640, 'maximum bound');
    await page.keyboard.press('Shift+ArrowLeft'); await settled();
    const stable = await widths();
    await beginDrag('sender', -80); await page.keyboard.press('Escape'); await page.mouse.up();
    assert.deepEqual(await widths(), stable); assert.deepEqual(await saved(), stable); assert.equal(await sort(), originalSort);
    await beginDrag('sender', -80); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.mouse.up();
    assert.deepEqual(await widths(), stable); assert.deepEqual(await saved(), stable);
    await beginDrag('sender', -60);
    await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointercancel', { pointerId: mailColumnResize.pointerId, bubbles: true })));
    await page.mouse.up(); assert.deepEqual(await widths(), stable); assert.deepEqual(await saved(), stable);
    await beginDrag('sender', -60); await page.evaluate(() => renderList()); await page.mouse.up();
    assert.deepEqual(await widths(), stable); assert.deepEqual(await saved(), stable);
    // Reordering uses the real existing keyboard UI, not a new resize shortcut.
    await page.locator('[data-sort-key="sender"] button').press('Alt+ArrowLeft');
    await page.evaluate(() => mailColumnSave); await alignment(); assert.deepEqual(await widths(), stable);
    await page.evaluate(() => changeMailColumnVisibility('sender', false));
    assert.equal(await handle('sender').isVisible(), false); assert.deepEqual(await widths(), stable);
    await page.evaluate(() => changeMailColumnVisibility('sender', true)); await alignment();
    await page.reload(); await initialize(); assert.deepEqual(await widths(), stable); await alignment();
    await handle('sender').focus(); await page.keyboard.press('Delete'); await settled();
    assert.equal(Object.hasOwn(await widths(), 'sender'), false, 'keyboard reset restores responsive width');
    await beginDrag('sender', 35); await page.mouse.up(); await settled();
    await handle('sender').dblclick(); await settled(); assert.equal(Object.hasOwn(await widths(), 'sender'), false);
    // Narrow layout keeps matching header/cell tracks and intentional scrolling.
    await handle('subject').focus(); await page.keyboard.press('End'); await settled();
    await page.setViewportSize({ width: 900, height: 900 });
    await page.evaluate(() => document.documentElement.style.setProperty('--list', '360px'));
    await alignment();
    assert.ok(await page.evaluate(() => { const list = document.getElementById('message-list'); return list.scrollWidth > list.clientWidth; }));
    fs.mkdirSync(output, { recursive: true }); await page.screenshot({ path: path.join(output, 'narrow.png') });
    assert.deepEqual(errors, []);
    assert.ok(await page.evaluate(() => fixtureCalls.every(item => item.channel === 'mail:listFromCache')));
    console.log(JSON.stringify({ result: 'passed', checks: 'real pointer drag; aligned tracks; keyboard/bounds/reset; no sorting; Escape/blur/pointercancel/rerender cancellation; hide/reorder/reload retention; narrow horizontal scrolling', output }));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
