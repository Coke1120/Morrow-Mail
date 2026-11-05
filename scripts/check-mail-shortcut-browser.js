// Optional Chromium verification with synthetic mail. Install Playwright outside the checkout.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), http = require('node:http'), path = require('node:path');
const root = path.resolve(__dirname, '..');
(async () => {
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + req.url.split('?')[0]);
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    try {
      let data = fs.readFileSync(file);
      if (file.endsWith('/renderer/app.js')) data = data.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, '');
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.MORROW_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => { window.morrow = { on() {}, invoke: async () => null }; });
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
    await page.evaluate(() => {
      state.accounts = ['alpha','beta'].map(id => ({id,email:id+'@fixture.invalid',folders:{primary:[{id:'INBOX',name:'Inbox'}],more:[]}}));
      state.accountId='alpha';state.folderId='INBOX';state.allInbox=true;state.prefs.conversation=false;
      state.emails = ['alpha','beta'].map((accountId,i) => ({id:'message-'+i,accountId,folderId:'INBOX',subject:'Synthetic '+accountId,from:accountId+'@fixture.invalid',textBody:'Synthetic body'}));
      state.email={...state.emails[0]};state.thread=[];state.listTotal=2;
      window.commands=[];window.compositions=[];
      call=async(channel,payload)=>{commands.push({channel,payload});return {email:{...state.emails.find(e=>e.id===payload.emailId)}}};
      presentCompose=async seed=>compositions.push(seed);
      askConfirm=async()=>({ok:true});beginRemovalRequest=()=>1;finishRemoval=async()=>{};
      queueBulkRemoval=(_label,specs)=>{for(const spec of specs)call(spec.channel,spec.params)};
      document.addEventListener('keydown',onMailShortcut);
      renderAccounts();renderList();renderReader(false);
    });
    for (const theme of ['light','dark']) for (const width of [1440,700]) {
      await page.setViewportSize({width,height:900});
      await page.evaluate(theme => {
        applyShellTheme(document.documentElement,theme,'#193C34');
        state.prefs.mailView={layout:'window'};state.selectedIds=[];mailShortcutStamp=0;renderList();
      }, theme);
      await page.locator('.message-row[data-email-id="message-1"] button.message').click();
      await page.keyboard.press('r');
      await page.waitForFunction(()=>!state.busy);
      assert.equal(await page.evaluate(()=>compositions.at(-1).accountId),'beta');
      await page.keyboard.press('Delete');await page.waitForFunction(()=>!state.busy);
      assert.deepEqual(await page.evaluate(()=>commands.at(-1)),{channel:'mail:delete',payload:{emailId:'message-1',accountId:'beta'}});
      for (const layout of ['right','bottom']) {
        await page.evaluate(layout=>{state.prefs.mailView={layout};pendingOpenId='message-1';mailShortcutStamp=0;renderList()},layout);
        const count=await page.evaluate(()=>compositions.length);await page.keyboard.press('r');
        assert.equal(await page.evaluate(()=>compositions.length),count);
        await page.evaluate(()=>{pendingOpenId='';mailShortcutStamp=0});await page.keyboard.press('r');await page.waitForFunction(()=>!state.busy);
        assert.equal(await page.evaluate(()=>compositions.at(-1).accountId),'alpha');
      }
    }
    await page.evaluate(()=>{
      pendingOpenId=''; state.selectedIds=['message-1']; state.prefs.mailView={layout:'right'};
      renderList(); renderReader(false); wireMailView(); document.addEventListener('keydown',onSelectionKey);
    });
    await page.locator('#mail-view-open').click();
    const beforeMenu=await page.evaluate(()=>[commands.filter(row=>['mail:delete','mail:archive'].includes(row.channel)).length,compositions.length]);
    for(const key of ['r','a','f','Delete','Backspace','Meta+a']) await page.keyboard.press(key);
    await page.waitForFunction(()=>!state.busy);
    assert.deepEqual(await page.evaluate(()=>[commands.filter(row=>['mail:delete','mail:archive'].includes(row.channel)).length,compositions.length]),beforeMenu);
    assert.deepEqual(await page.evaluate(()=>state.selectedIds),['message-1']);
    await page.keyboard.press('Tab'); assert.equal(await page.locator('#mail-view-menu').isVisible(),false);
    await page.evaluate(()=>{showFeatures();paintShortcuts()});
    assert.match(await page.locator('#features-catalog').textContent(),/Delete and Backspace.*selected messages to Trash/);
    assert.match(await page.locator('#shortcuts-note').textContent(),/exactly one visible message/);
    assert.deepEqual(errors,[]);
    console.log('mail-shortcut-browser-ok: real keys, cross-account target, right/bottom/window, narrow/wide, light/dark, rendered help');
  } finally { await browser?.close();server.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
