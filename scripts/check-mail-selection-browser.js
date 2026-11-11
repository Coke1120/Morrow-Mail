// Actual Chromium clicks/modifiers and production renderer, synthetic mail/IPC.
// Install Playwright outside this checkout. No host, credentials or live mail.
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
      if (file.endsWith('/renderer/app.js')) data = fs.readFileSync(process.env.MORROW_RENDERER_SOURCE || file, 'utf8').replace(/boot\(\)\.catch\([^\n]+\);\s*$/, '');
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
      wire();refreshMailVacation=()=>{};
      window.resetFixture=async(layout,theme)=>{
        clearUndo();optimisticRemovals.clear();pendingRemovalMessages.clear();
        if(typeof filterSelection!=='undefined')filterSelection.clear();
        if(typeof listFilterTimer!=='undefined'){clearTimeout(listFilterTimer);listFilterTimer=null}
        ++listGen;state.listScope='';state.loadedListFilter='';state.listFilterError=false;state.listCursors=[];
        state.view='mail';document.documentElement.dataset.view='mail';
        state.accounts=['alpha','beta'].map(id=>({id,email:id+'@fixture.invalid',folders:{primary:[{id:'INBOX',name:'Inbox'}],more:[]}}));
        state.accountId='alpha';state.folderId='INBOX';state.allInbox=true;state.outbox=false;state.query='';
        state.prefs.mailView={layout};state.prefs.conversation=false;state.selectedIds=[];state.selectionAnchor='';
        pendingOpenId='';state.email=null;state.thread=[];state.listTotal=5;state.listSyncDone=true;
        window.storeRows=['a','b','c','d','e'].map((id,index)=>({id,accountId:index%2?'beta':'alpha',folderId:'INBOX',
          subject:'Synthetic '+id,from:'sender@fixture.invalid',snippet:index===2?'excluded':'keep',
          textBody:'Synthetic body '+id,bodyComplete:true,hasBody:true,unread:false}));
        state.emails=storeRows.map(row=>({...row}));window.commands=[];
        call=async(channel,params)=>{
          commands.push({channel,params});
          if(channel==='mail:openEmail')return {email:{...storeRows.find(row=>row.id===params.emailId)},threadMessages:[]};
          if(channel==='mail:listFromCache'||channel==='mail:listLocalFolder'){
            const query=String(params.listFilter||'').trim().toLowerCase();
            const rows=storeRows.filter(row=>(!params.accountId||row.accountId===params.accountId)
              &&[row.subject,row.from,row.snippet].join('\n').toLowerCase().includes(query));
            const offset=params.offset||0,limit=params.limit||200;
            return {emails:rows.slice(offset,offset+limit).map(row=>({...row})),total:rows.length,syncDone:true};
          }
          throw new Error('Unexpected synthetic IPC '+channel);
        };
        $('list-filter').value='';applyShellTheme(document.documentElement,theme,'#193C34');
        renderAccounts();await loadList(false,0);renderReader(false);commands=[];
      };
    });
    const click = (id, modifiers=[], box=false) => page.locator(`[data-email-id="${id}"] ${box?'.row-check':'button.message'}`).click({modifiers});
    const selection = () => page.evaluate(()=>({ids:state.selectedIds,anchor:state.selectionAnchor}));
    const reset = (layout='right',theme='light') => page.evaluate(([layout,theme])=>resetFixture(layout,theme),[layout,theme]);
    const filter = async value => {
      await page.locator('#list-filter').fill(value);
      await page.waitForFunction(()=>typeof currentListFilter!=='function'
        ||(!listFilterTimer&&!state.listLoading&&state.loadedListFilter===currentListFilter()));
    };
    // Control-click is a native secondary click on macOS. Exercise the platform's
    // actual additive gesture here; check-mail-selection.js covers both key flags.
    const additiveModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    let cases=0;
    for(const theme of ['light','dark'])for(const layout of ['right','bottom','window']){
      await page.setViewportSize({width:theme==='light'?1440:700,height:960});await reset(layout,theme);
      await click('b');
      if(layout!=='window')await page.waitForFunction(()=>state.email?.id==='b'&&!pendingOpenId);
      assert.deepEqual(await selection(),{ids:layout==='window'?['b']:[],anchor:'b'});
      assert.equal(await page.locator('#selection-bar').isVisible(),layout==='window');
      const commands=await page.evaluate(()=>window.commands);
      await click('e',['Shift']);assert.deepEqual(await selection(),{ids:['b','c','d','e'],anchor:'b'});
      await click('c',['Shift']);assert.deepEqual(await selection(),{ids:['b','c'],anchor:'b'});
      await click('a',['Shift']);assert.deepEqual(await selection(),{ids:['a','b'],anchor:'b'});
      assert.deepEqual(await page.evaluate(()=>window.commands),commands);
      assert.equal(await page.locator('[data-email-id="a"] .row-check').getAttribute('aria-checked'),'true');cases++;

      await reset(layout,theme);await click('d',[],true);await click('a',['Shift'],true);
      assert.deepEqual(await selection(),{ids:['a','b','c','d'],anchor:'d'});
      await click('c',['Shift'],true);assert.deepEqual(await selection(),{ids:['c','d'],anchor:'d'});
      assert.deepEqual(await page.evaluate(()=>window.commands),[]);cases++;

      for(const modifier of [additiveModifier]){
        await reset(layout,theme);await click('e',[modifier]);await click('b',[modifier]);
        await click('d',[modifier,'Shift'],true);assert.deepEqual(await selection(),{ids:['e','b','c','d'],anchor:'b'});
        await click('c',['Shift']);assert.deepEqual(await selection(),{ids:['b','c'],anchor:'b'});
        assert.deepEqual(await page.evaluate(()=>window.commands),[]);cases++;
      }
    }
    await reset();await page.evaluate(()=>{storeRows.reverse();state.emails=storeRows.map(row=>({...row}));renderList()});
    await filter('keep');await click('e');await click('a',['Shift']);
    assert.deepEqual(await selection(),{ids:['e','d','b','a'],anchor:'e'});cases++;

    await reset();await click('c');await filter('keep');await click('e',['Shift']);
    assert.deepEqual(await selection(),{ids:['e'],anchor:'e'});cases++;

    await reset();await click('b');await click('e',['Shift']);
    await page.locator('#selection-clear').click();assert.deepEqual(await selection(),{ids:[],anchor:''});
    await click('d',['Shift']);assert.deepEqual(await selection(),{ids:['d'],anchor:'d'});
    await page.keyboard.press('Escape');assert.deepEqual(await selection(),{ids:[],anchor:''});cases++;

    await reset();await click('c',[],true);await click('d',[],true);
    await filter('keep');await click('b',[additiveModifier,'Shift']);
    assert.deepEqual(await selection(),{ids:['c','d','b'],anchor:'d'});
    assert.deepEqual(await page.evaluate(()=>selectedMessages().map(row=>[row.id,row.accountId])),[['c','alpha'],['d','beta'],['b','beta']]);cases++;

    await reset();await click('b');await click('e',['Shift']);
    const output=process.env.MORROW_UI_OUTPUT||path.join(os.tmpdir(),'morrow-selection-ui');fs.mkdirSync(output,{recursive:true});
    await page.screenshot({path:path.join(output,'inclusive-range.png')});
    await page.evaluate(()=>{showFeatures();paintShortcuts()});
    assert.match(await page.locator('#features-catalog').textContent(),/Mail range selection/);
    assert.match(await page.locator('#shortcuts-note').textContent(),/Shift-click a message or its checkbox/);
    assert.match(await page.locator('#mail-selection-help').textContent(),/including both ends/);
    assert.deepEqual(errors,[]);cases++;
    console.log(JSON.stringify({result:'passed',cases,checks:'plain-click anchor, row/checkbox inclusive and repeated ranges, native additive modifier ranges, displayed order/filter boundaries, Clear/Escape, mailbox identity, right/bottom/window, wide/narrow, light/dark, rendered Features/Shortcuts/help',output}));
  } finally { await browser?.close();server.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
