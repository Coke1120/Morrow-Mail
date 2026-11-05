// Real Chromium keyboard/buttons/native confirmation with synthetic mail/IPC.
// Install Playwright outside the checkout. This never boots a mailbox host.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), http = require('node:http'), os = require('node:os'), path = require('node:path');
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
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.morrow = { on() {}, invoke: async () => ({ success: true, data: null }) }; });
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
    await page.evaluate(() => {
      wire();
      refreshMailVacation=()=>{document.getElementById('mail-ooo').hidden=true};
      window.resetFixture = (layout, theme) => {
        clearUndo(); optimisticRemovals.clear(); pendingRemovalMessages.clear();
        state.view='mail'; document.documentElement.dataset.view='mail';
        state.accounts=['alpha','beta'].map(id=>({id,email:id+'@fixture.invalid',folders:{primary:[{id:'INBOX',name:'Inbox'}],more:[]}}));
        state.accountId='alpha';state.folderId='INBOX';state.allInbox=true;state.outbox=false;state.query='';state.prefs.conversation=false;
        state.prefs.mailView={layout};state.selectedIds=[];state.selectionAnchor='';pendingOpenId='';mailShortcutStamp=0;
        window.storeRows=['a','b','c'].map((id,index)=>({id,accountId:index===1?'beta':'alpha',folderId:'INBOX',subject:'Synthetic '+id,
          from:'sender@fixture.invalid',textBody:'Synthetic body '+id,bodyComplete:true,unread:false,hasBody:true}));
        state.emails=storeRows.map(row=>({...row}));state.email={...state.emails[0]};state.thread=[];state.listTotal=3;state.listSyncDone=true;
        window.commands=[];
        call=async(channel,params)=>{
          commands.push({channel,params});
          if(channel==='mail:undoRemoval') {
            for(const opId of params.opIds)storeRows.find(row=>row.id===opId.slice(3)).folderId='INBOX';
            return {outcomes:params.opIds.map(opId=>({id:opId.slice(3),kind:'undo',generation:2,status:'completed'})),opIds:[]};
          }
          if(!['mail:delete','mail:deleteBatch'].includes(channel))throw new Error('Unexpected synthetic IPC '+channel);
          if(Object.hasOwn(params,'folderWellKnownName'))throw new Error('Ordinary Delete must remain Trash');
          const items=params.items||[params];
          for(const item of items){const row=storeRows.find(row=>row.id===item.emailId&&row.accountId===item.accountId);if(!row)throw new Error('Wrong mailbox');row.folderId='Trash'}
          return {outcomes:items.map(item=>({id:item.emailId,kind:'remove',status:'completed',generation:1,opId:'op-'+item.emailId})),opIds:items.map(item=>'op-'+item.emailId)};
        };
        loadList=async()=>{state.emails=storeRows.filter(row=>row.folderId==='INBOX').map(row=>({...row}));renderList()};
        document.getElementById('list-filter').value='';applyShellTheme(document.documentElement,theme,'#193C34');
        renderAccounts();renderList();renderReader(false);
      };
    });
    const select = async id => page.locator(`[data-email-id="${id}"] .row-check`).click();
    const confirm = async count => {
      await page.locator('#confirm[open]').waitFor();
      assert.match(await page.locator('#confirm-body').textContent(), new RegExp(`Move ${count} message`));
      assert.equal(await page.evaluate(()=>commands.filter(row=>['mail:delete','mail:deleteBatch'].includes(row.channel)).length),0,JSON.stringify(await page.evaluate(()=>commands)));
      await page.locator('#confirm-ok').click();
      await page.waitForFunction(n=>undoItems?.length===n&&!state.busy,count);
    };
    let cases=0;
    for (const theme of ['light','dark']) for (const layout of ['right','bottom','window']) for (const key of ['Delete','Backspace']) {
      await page.setViewportSize({width:theme==='light'?1440:700,height:900});
      await page.evaluate(([layout,theme])=>resetFixture(layout,theme),[layout,theme]);
      await select('b');await select('c');
      await page.keyboard.press(key);await confirm(2);
      assert.deepEqual(await page.evaluate(()=>commands[0]),{channel:'mail:deleteBatch',params:{items:[{emailId:'b',accountId:'beta'},{emailId:'c',accountId:'alpha'}]}});
      assert.equal(await page.evaluate(()=>state.email.id),'a');
      await page.locator('#undo').click();await page.locator('#confirm-ok').click();
      await page.waitForFunction(()=>storeRows.every(row=>row.folderId==='INBOX')&&!state.busy);
      cases++;
    }
    const output=process.env.MORROW_UI_OUTPUT||path.join(os.tmpdir(),'morrow-delete-ui');fs.mkdirSync(output,{recursive:true});
    for(const width of [1440,700]){
      await page.setViewportSize({width,height:900});await page.evaluate(()=>resetFixture('right','light'));await select('b');await select('c');
      assert.equal(await page.locator('#reader [data-action="trash"]').getAttribute('aria-label'),'Delete 2 selected messages');
      await page.locator('#reader [data-action="trash"]').click();await page.locator('#confirm[open]').waitFor();
      await page.screenshot({path:path.join(output,`review-${width}.png`)});
      await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>commands.length),0);
      await page.waitForFunction(()=>!state.busy&&!document.getElementById('confirm').open);
      assert.deepEqual(await page.evaluate(()=>state.selectedIds),['b','c']);
      await page.locator('#reader [data-action="trash"]').click();await confirm(2);cases++;
    }
    await page.evaluate(()=>resetFixture('right','light'));await select('b');await select('c');
    await page.locator('#list-filter').fill('Synthetic b');await page.evaluate(()=>renderList());
    assert.match(await page.locator('#selection-count').textContent(),/1 hidden by this filter/);
    await page.locator('#message-list').focus();await page.keyboard.press('Delete');await confirm(2);cases++;
    await page.evaluate(()=>{showFeatures();paintShortcuts()});
    assert.match(await page.locator('#features-catalog').textContent(),/Delete and Backspace.*selected messages to Trash/);
    assert.match(await page.locator('#shortcuts-note').textContent(),/Independent readers keep their own message/);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({result:'passed',cases,checks:'real Delete/Backspace, native confirmation/Escape, cross-account selection and stale preview, reader button count, filter-hidden selection, Undo, right/bottom/window, narrow/wide, light/dark, rendered help',output}));
  } finally { await browser?.close();server.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
