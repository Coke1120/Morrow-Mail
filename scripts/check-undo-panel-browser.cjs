// Real Chromium interactions against production HTML/CSS/handlers; synthetic mail only.
// Requires Playwright and Chromium (CHROMIUM_PATH can override the executable).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'morrow.test') return route.abort();
      const file = path.join(root, url.pathname);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      let body = fs.readFileSync(file);
      if (url.pathname === '/renderer/app.js') body = body.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, '');
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : 'text/html' });
    });
    await page.addInitScript(() => { window.morrow = { on() {}, invoke: async () => ({ success: true, data: null }) }; });
    await page.goto('http://morrow.test/renderer/index.html');
    await page.evaluate(() => {
      wire(); loadList = async () => {};
      state.accounts = [{ id: 'fixture', email: 'synthetic@example.test' }];
      window.fixtureItems = ['a','b'].map((id, i) => ({ opId: id, messageId: id, accountId: 'fixture', subject: 'Synthetic report ' + id, from: 'fixture@example.test', action: i ? 'trash' : 'archive', destinationLabel: i ? 'Trash' : 'Archive' }));
      window.restoreCalls = [];
      call = async (channel, payload) => {
        restoreCalls.push({ channel, payload });
        return new Promise(resolve => { window.finishRestore = resolve; });
      };
      window.resetUndo = () => startRemovalSession('Archive and Trash: 2 completed.', ['a','b'], false, fixtureItems);
      resetUndo();
    });
    const click = id => page.locator('#' + id).click();
    const value = expression => page.evaluate(expression);
    const open = () => value('undoPopoverOpen()');
    const shots = process.env.MORROW_UNDO_EVIDENCE_DIR;
    const shot = async name => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, name + '.png'), animations: 'disabled' }); } };
    await click('undo-details');
    // This native focus transition reproduced the bug before the fix: Clear never got its click.
    await click('undo-details-all'); await click('undo-details-clear');
    assert.equal(await open(), true);
    assert.deepEqual(await value('selectedUndoOpIds()'), []);
    await click('undo-details-all');
    await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
    assert.equal(await open(), true);
    assert.deepEqual(await value('selectedUndoOpIds()'), []);
    await click('undo-details-all');
    await shot('selection-retained');
    await click('undo-details-selected');
    assert.equal(await value("$('confirm').open"), true);
    assert.match(await page.locator('#confirm-body').textContent(), /2 completed changes.*1 archive, 1 trash/);
    assert.equal(await value('restoreCalls.length'), 0);
    await shot('bulk-confirmation');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !undoConfirmationPending);
    assert.equal(await open(), true);
    assert.equal(await value('document.activeElement.id'), 'undo-details-selected');
    assert.equal(await value('restoreCalls.length'), 0);
    await click('undo-details-clear');
    await page.locator('#undo-details-list input').first().check();
    await click('undo-details-selected');
    assert.equal(await page.locator('#confirm-title').textContent(), 'Undo 1 change?');
    await click('confirm-cancel');
    await page.waitForFunction(() => !undoConfirmationPending);
    assert.equal(await value('restoreCalls.length'), 0);
    // Freeze a reviewed subset even if another account settles while the prompt is open.
    await click('undo-details-selected');
    await value("showUndo('Late completion.', ['a','b','c'], false, [...fixtureItems,{...fixtureItems[0],opId:'c',messageId:'c'}])");
    await page.locator('#confirm-ok').dblclick();
    await page.waitForFunction(() => restoreCalls.length === 1);
    assert.deepEqual(await value('restoreCalls[0].payload.opIds'), ['a']);
    await value("$('undo').click(); $('undo-details-selected').click()");
    assert.equal(await value('restoreCalls.length'), 1);
    await value('finishRestore({outcomes:[]})');
    await page.waitForFunction(() => !undoConfirmationPending);
    assert.equal(await value("$('undo').disabled"), true);
    await value("applyActionSettlement({outcomes:[{id:'a',kind:'undo',status:'completed'}],opIds:[]})");
    assert.deepEqual(await value('undoOpIds'), ['b','c']);
    // Replacing a session while reviewing must never execute the replacement or stale IDs.
    await click('undo');
    await value('resetUndo()');
    await click('confirm-ok');
    await page.waitForFunction(() => !undoConfirmationPending);
    assert.equal(await value('restoreCalls.length'), 1);
    // Existing modal remains open when nested Undo review is cancelled.
    await value("openDialog('connect'); void requestUndoRemoval(['a'])");
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !undoConfirmationPending);
    assert.equal(await value("$('connect').open"), true);
    await value("$('connect').close()");
    await click('undo-details');
    await page.keyboard.press('Escape');
    assert.equal(await open(), false);
    assert.equal(await value('document.activeElement.id'), 'undo-details');
    await click('undo-details');
    await click('undo-details-all');
    await page.locator('#undo-details-selected').focus();
    await page.keyboard.press('Tab');
    assert.equal(await open(), false);
    await click('undo-details');
    await page.locator('#search-query').click();
    assert.equal(await open(), false);
    // Bulk confirmation executes precisely its reviewed IDs, then reaches the empty state.
    await click('undo');
    await click('confirm-ok');
    await page.waitForFunction(() => restoreCalls.length === 2);
    assert.deepEqual(await value('restoreCalls[1].payload.opIds'), ['a','b']);
    await value("finishRestore({outcomes:['a','b'].map(id=>({id,kind:'undo',status:'completed'}))})");
    await page.waitForFunction(() => !undoConfirmationPending);

    assert.equal(await page.locator('#undo').isVisible(), false);
    assert.equal(await page.locator('#undo-details').isVisible(), false);
    await value("showReadUndo('Marked as read.', [{emailId:'read-fixture',accountId:'fixture',wasRead:false}])");
    await click('undo');
    assert.match(await page.locator('#confirm-body').textContent(), /previous read state of 1 message/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !undoConfirmationPending);
    assert.equal(await value('restoreCalls.length'), 2);
    await click('undo');
    await value('clearUndo()'); // Expiry/another notice while a read review is open.
    await click('confirm-ok');
    await page.waitForFunction(() => !undoConfirmationPending);
    assert.equal(await value('restoreCalls.length'), 2);
    await value("showFeatures()");
    assert.match(await page.locator('#features-panel').textContent(), /Select all and Clear keep Details open/);
    await shot('features-help');
    console.log('PASS: native pointer/keyboard selection, bulk/individual review, Cancel/Escape/focus, frozen IDs, stale session, delayed once-only restore, nested dialogs, outside click, empty state and Features.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
