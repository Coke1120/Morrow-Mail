// Real renderer and CSS; all IPC and mail are synthetic. No provider requests.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const root = path.join(__dirname, '..'), output = process.env.MORROW_UI_OUTPUT || '/tmp/morrow-compose-popup-browser';
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
      window.fixtureCalls = []; window.fixtureSuggestionMode = 'success'; window.fixtureAllowAI = false;
      window.morrow = { on() {}, invoke: async (channel, payload) => {
        fixtureCalls.push({ channel, payload });
        if (channel === 'aiDraftWrite:replySuggestions') {
          if (fixtureSuggestionMode === 'pending') return new Promise(resolve => window.finishSuggestions = resolve);
          if (fixtureSuggestionMode === 'error') return { success: false, error: { code: 'ai-consent-required', message: 'AI data permission is required.' } };
          return { success: true, data: { suggestions: ['Thanks. I will review the fictional notes.', 'Please clarify the fictional deadline.'] } };
        }
        if (channel === 'aiDraftWrite:start') return fixtureAllowAI ? { success: true, data: { reqId: payload.reqId } } : { success: false, error: { code: 'ai-consent-required', message: 'AI data permission is required.' } };
        if (channel === 'aiDraftWrite:cancel') return { success: true, data: true };
        throw new Error('Unexpected IPC: ' + channel);
      } };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
    await page.evaluate(() => {
      wire();
      state.accounts = [{ id: 'fixture', email: 'owner@fixture.invalid', platform: 'imap', imapSmtpProfile: 'custom', folders: { primary: [], more: [] } }];
      state.accountId = 'fixture'; state.prefs.aiReply = true; state.signatureText = 'Fictional Signature';
      state.composeQuote = { kind: 'reply', email: { subject: 'Fictional notes', from: 'sender@fixture.invalid', textBody: 'Please review fictional notes.' }, text: 'Fictional quoted mail.' };
      state.composeIdentity = { accountId: 'fixture', fromAddress: 'owner@fixture.invalid' }; state.composeMeta = { accountId: 'fixture', kind: 'reply' };
      document.querySelector('#compose').showModal();
      document.querySelector('#compose-subject').value = 'Re: Fictional notes';
      writeComposeBody('Existing draft\n\nFictional Signature'); setAiMode('reply');
      // Keep the test on the actual popup controls without unrelated send setup.
      syncComposeActions = () => {}; paintComposeNote = () => {};
      openComposeAi();
    });
    assert.equal(await page.locator('#ai-prompt').evaluate(el => el.tagName), 'TEXTAREA');
    assert.equal(await page.locator('#compose-suggestions').evaluate(el => el.closest('#compose-ai-popover') !== null), true);
    const resizeBefore = await page.locator('#ai-prompt').boundingBox();
    await page.mouse.move(resizeBefore.x + resizeBefore.width - 4, resizeBefore.y + resizeBefore.height - 4);
    await page.mouse.down(); await page.mouse.move(resizeBefore.x + resizeBefore.width - 4, resizeBefore.y + resizeBefore.height + 80, { steps: 8 }); await page.mouse.up();
    assert.ok((await page.locator('#ai-prompt').boundingBox()).height > resizeBefore.height + 40);

    await page.evaluate(() => showComposeSuggestions({ kind: 'reply', quoteEmail: state.composeQuote.email }));
    await page.locator('#compose-suggest-list button').first().click();
    assert.match(await page.locator('#compose-body').inputValue(), /Thanks\.[\s\S]*Fictional Signature$/);
    assert.equal(await page.evaluate(() => fixtureCalls.filter(x => x.channel === 'aiDraftWrite:start').length), 0);
    await page.locator('#ai-prompt').fill('Keep my tone\nand second line');
    await page.locator('#compose-suggest-list button').last().click();
    assert.equal(await page.locator('#ai-prompt').inputValue(), 'Keep my tone\nand second line');
    await page.locator('#ai-prompt').press('End'); await page.locator('#ai-prompt').press('Enter'); await page.locator('#ai-prompt').press('b');
    assert.match(await page.locator('#ai-prompt').inputValue(), /second line\nb$/);
    assert.equal(await page.evaluate(() => fixtureCalls.filter(x => x.channel === 'aiDraftWrite:start').length), 0);
    await page.evaluate(() => document.querySelector('#ai-prompt').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true })));
    assert.equal(await page.evaluate(() => fixtureCalls.filter(x => x.channel === 'aiDraftWrite:start').length), 0);
    await page.locator('#ai-prompt').press('Control+Enter');
    await page.locator('#ai-write-error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#ai-write-error').textContent(), /permission/);
    assert.equal(await page.evaluate(() => fixtureCalls.filter(x => x.channel === 'aiDraftWrite:start').length), 1);
    const last = await page.evaluate(() => fixtureCalls.find(x => x.channel === 'aiDraftWrite:start').payload.body);
    assert.match(last.user_prompt, /Keep my tone\nand second line\nb/);
    assert.equal(last.mode, 'reply');
    await page.evaluate(() => { fixtureAllowAI = true; });
    await page.locator('#ai-generate').click();
    assert.equal(await page.locator('#ai-prompt').isDisabled(), true);
    assert.equal(await page.locator('#compose-suggest-list button').first().isDisabled(), true);
    const before = await page.locator('#compose-body').inputValue();
    await page.evaluate(() => applySuggestedReply('MUST NOT APPLY'));
    assert.equal(await page.locator('#compose-body').inputValue(), before);
    await page.locator('#ai-cancel').click();
    await page.locator('#compose-ai-open').click();
    assert.match(await page.locator('#ai-prompt').inputValue(), /Keep my tone/);
    await page.evaluate(() => { fixtureSuggestionMode = 'pending'; window.suggestionJob = showComposeSuggestions({ kind: 'reply', quoteEmail: state.composeQuote.email }); });
    assert.match(await page.locator('#compose-suggest-status').textContent(), /Suggesting replies/);
    await page.evaluate(async () => { finishSuggestions({ success: true, data: { suggestions: [] } }); await suggestionJob; });
    assert.match(await page.locator('#compose-suggest-status').textContent(), /No reply suggestions/);
    await page.evaluate(async () => { fixtureSuggestionMode = 'error'; await showComposeSuggestions({ kind: 'reply', quoteEmail: state.composeQuote.email }); });
    assert.match(await page.locator('#compose-suggest-status').textContent(), /permission/);
    await page.evaluate(async () => { fixtureSuggestionMode = 'success'; await showComposeSuggestions({ kind: 'reply', quoteEmail: state.composeQuote.email }); });
    for (const width of [1100, 390]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 780 });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.querySelector('#ai-prompt').style.height = '300px'; }, theme);
      const dimensions = await page.locator('#ai-prompt').evaluate(el => ({ height: el.getBoundingClientRect().height, resize: getComputedStyle(el).resize, value: el.value }));
      assert.ok(dimensions.height >= 290); assert.equal(dimensions.resize, 'vertical'); assert.match(dimensions.value, /Keep my tone/);
      await page.locator('#ai-generate').scrollIntoViewIfNeeded();
      await page.locator('#ai-cancel').scrollIntoViewIfNeeded();
      const rect = await page.locator('#compose-ai-popover').boundingBox();
      assert.ok(rect.x >= 0 && rect.x + rect.width <= width + 1, JSON.stringify(rect));
      assert.ok(rect.y + rect.height <= 780, JSON.stringify(rect));
      await page.screenshot({ path: path.join(output, `popup-${theme}-${width}.png`) });
    }
    await page.locator('#ai-cancel').focus(); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-ai-mode')), 'reply');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#compose-ai-popover').isHidden(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'compose-ai-open');
    assert.equal(await page.locator('#compose').evaluate(el => el.open), true);
    assert.equal(await page.evaluate(() => fixtureCalls.some(x => /mail:(send|scheduleSend)/.test(x.channel))), false);
    await page.evaluate(() => { document.querySelector('#compose').close(); showFeatures(); });
    assert.match(await page.locator('#features-panel').textContent(), /prompt supports multiple lines and vertical resizing/);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(JSON.stringify({ ok: true, widths: [1100, 390], themes: ['light', 'dark'], screenshots: output, externalRequests: 0 }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
