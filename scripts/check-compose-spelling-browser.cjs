// Real renderer and CSS; all IPC and mail are synthetic. No provider requests.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const root = path.join(__dirname, '..'), output = process.env.MORROW_UI_OUTPUT || '/tmp/morrow-compose-spelling-browser';
(async () => {
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    try {
      let bytes = fs.readFileSync(file);
      if (file.endsWith('/renderer/app.js')) bytes = bytes.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, '');
      res.setHeader('Content-Type', /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(bytes);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    fs.mkdirSync(output, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
    const errors = [], external = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(`http://127.0.0.1:${server.address().port}/`) ? route.continue() : (external.push(route.request().url().split('?')[0]), route.abort()));
    await page.addInitScript(() => {
      window.fixtureCalls = []; window.fixtureSaved = null;
      window.morrow = { on() {}, invoke: async (channel, payload) => {
        fixtureCalls.push({ channel, payload });
        if (channel === 'compose:setTitle') return true;
        if (channel === 'host:aiGetConfig') return { authMode: 'api_key', baseUrl: 'https://synthetic.invalid/v1', model: 'fixture-model', hasApiKey: false };
        if (channel === 'mail:upsertDraft') { fixtureSaved = payload; return { success: true, data: { draftId: 'synthetic-draft', draftRevision: 'revision-1' } }; }
        throw new Error('Unexpected synthetic spelling IPC: ' + channel);
      } };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html?role=compose`);
    await page.evaluate(() => {
      wire();
      state.accounts = [{ id: 'fixture', email: 'owner@fixture.invalid', platform: 'imap', folders: { primary: [], more: [] } }];
      state.accountId = 'fixture'; state.composeMeta = { accountId: 'fixture', kind: 'new', fromAddress: 'owner@fixture.invalid' };
      state.composeSession = 1; state.composeAttachments = []; state.composeFileJobs = [];
      document.querySelector('#compose').showModal(); document.querySelector('#compose-to').value = 'recipient@fixture.invalid';
      paintComposeEditor('Wrod in a fictional draft.', '<p><b>Wrod</b> in a fictional draft.</p>'); syncComposePlainFromEditor();
      const node = document.querySelector('#compose-editor b').firstChild, range = document.createRange();
      range.setStart(node, 0); range.setEnd(node, 4); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.querySelector('#compose-editor').focus();
      // Exercise Chromium's native editing/input path. Actual Electron menu dispatch is unit-tested separately.
      if (!document.execCommand('insertText', false, 'Word')) throw new Error('Chromium editing command failed');
    });
    assert.match(await page.locator('#compose-body').inputValue(), /^Word in a fictional draft/);
    assert.equal(await page.locator('#compose-editor b').textContent(), 'Word');
    await page.keyboard.press('Control+z'); assert.match(await page.locator('#compose-body').inputValue(), /^Wrod/);
    await page.keyboard.press('Control+Shift+z'); assert.match(await page.locator('#compose-body').inputValue(), /^Word/);
    assert.equal(await page.locator('#compose-editor b').textContent(), 'Word');
    assert.equal(await page.evaluate(() => saveDraft()), true);
    assert.match(await page.evaluate(() => fixtureSaved.body), /<b>Word<\/b>/);
    await page.evaluate(() => {
      const saved = fixtureSaved;
      writeComposeBody(''); paintComposeEditor(plainFromMailHtml(saved.body), saved.body); syncComposePlainFromEditor();
    });
    assert.match(await page.locator('#compose-body').inputValue(), /^Word in a fictional draft/);
    assert.equal(await page.locator('#compose-editor b').textContent(), 'Word');
    await page.locator('#compose-subject').fill('Wrod'); await page.locator('#compose-subject').press('Control+a'); await page.locator('#compose-subject').press('W');
    await page.locator('#compose-subject').fill('Word');
    assert.equal(await page.evaluate(() => saveDraft()), true);
    assert.equal(await page.evaluate(() => fixtureSaved.subject), 'Word');
    assert.equal(await page.evaluate(() => fixtureCalls.filter(row => !['mail:upsertDraft', 'compose:setTitle', 'host:aiGetConfig'].includes(row.channel)).length), 0, JSON.stringify(await page.evaluate(() => fixtureCalls.map(row => row.channel))));
    await page.screenshot({ path: path.join(output, 'corrected-rich-draft.png') });
    await page.evaluate(() => { document.querySelector('#compose').close(); showFeatures(); });
    assert.match(await page.locator('#features-panel').textContent(), /native right-click menu offers available spelling corrections/);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(JSON.stringify({ ok: true, nativeEditingPath: 'Chromium insertText/input/undo/redo', draftIPC: 'synthetic', nativeElectronMenu: 'mocked separately; no Electron binary installed', externalRequests: 0 }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
