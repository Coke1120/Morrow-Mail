// Optional Chromium smoke: isolated synthetic IPC, no live OAuth, AI or mail.
// Supply MORROW_PLAYWRIGHT_MODULE and MORROW_AXE_MODULE when installed outside this checkout.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || 'playwright');
const fs=require('fs'), http=require('http'), path=require('path'), assert=require('assert/strict');
const root=path.resolve(__dirname, '..');
const output=process.env.MORROW_UI_OUTPUT || require('os').tmpdir();
fs.mkdirSync(output,{recursive:true});
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/axe.js'){res.setHeader('Content-Type','application/javascript');res.end(fs.readFileSync(require.resolve(process.env.MORROW_AXE_MODULE || 'axe-core/axe.min.js')));return;}
 let file=path.join(root,url.pathname==='/'?'renderer/index.html':url.pathname);
 if(!file.startsWith(root+'/')){res.writeHead(403).end();return;}
 try {let body=fs.readFileSync(file); if(file.endsWith('index.html')) body=body.toString().replace('<script src="./app.js"></script>', '<script src="/scripts/fixtures/google-onboarding-startup.js"></script><script src="./app.js"></script>');
 res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(body);}catch{res.writeHead(404).end();}
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:process.env.MORROW_CHROMIUM || '/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const url=`http://127.0.0.1:${server.address().port}/renderer/index.html?version=${require('../package.json').version}`;
 await page.goto(url); await page.waitForFunction(()=>window.syntheticStartup?.ready);
 await page.locator('#changelog-ok').click();await page.locator('#setup-guide[open]').waitFor();
 await page.waitForFunction(()=>getComputedStyle(document.getElementById('setup-guide')).opacity==='1');
 await page.screenshot({path:path.join(output,'morrow-onboarding-desktop.png')});
 assert.equal(await page.locator('dialog[open]').count(),1);
 for(let i=0;i<18;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement.closest('#setup-guide')),true);}
 await page.getByRole('button',{name:'6. Mail preferences',exact:true}).click();
 await page.locator('#setup-undo:enabled').waitFor();
 assert.equal(await page.locator('#setup-undo').inputValue(),'30');
 assert.match(await page.locator('#setup-images').textContent(),/Keep current setting \(on\)/);
 await page.locator('#setup-images-save').click();
 assert.equal(await page.evaluate(()=>syntheticStartup.preferenceWrites.length),0);
 for(const theme of ['light','dark']) {
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   for(const width of [1280,390]) {
     await page.setViewportSize({width,height:900});
     assert.equal(await page.evaluate(()=>document.querySelector('#setup-guide').scrollWidth<=document.querySelector('#setup-guide').clientWidth),true);
     await page.screenshot({path:path.join(output,`morrow-mail-preferences-${theme}-${width}.png`)});
   }
 }
 await page.addScriptTag({url:'/axe.js'});
 const mailAccessibility=await page.evaluate(()=>axe.run(document.querySelector('#setup-guide'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa']}}));
 assert.deepEqual(mailAccessibility.violations.map(v=>v.id),[]);
 await page.setViewportSize({width:1280,height:900});
 await page.locator('#setup-undo').fill('15');await page.locator('#setup-undo-save').click();
 await page.waitForFunction(()=>syntheticStartup.preferences.UndoSendDelaySeconds===15);
 await page.locator('#setup-delay-hours').fill('2');await page.locator('#setup-delay-minutes').fill('30');await page.locator('#setup-delay-save').click();
 await page.waitForFunction(()=>syntheticStartup.preferences.DefaultScheduleDelayMinutes===150);
 await page.locator('#setup-images').selectOption('off');await page.locator('#setup-images-save').click();
 await page.waitForFunction(()=>syntheticStartup.preferences.AutoLoadRemoteImages===false);
 for(let i=0;i<30;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement.closest('#setup-guide')),true);}
 await page.getByRole('button',{name:'3. Sender name',exact:true}).click();
 assert.equal(await page.locator('#setup-guide-action').isDisabled(),true);
 await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.getElementById('setup-guide').open);
 await page.evaluate(()=>{openSettings();revealSettingsFold('prefs')});
 await page.locator('#setup-guide-open').click();await page.locator('#setup-guide[open]').waitFor();assert.equal(await page.locator('dialog[open]').count(),1);
 await page.getByRole('button',{name:'1. Mailbox',exact:true}).click();
 await page.locator('#setup-guide-action').click();await page.locator('#connect[open]').waitFor();assert.equal(await page.locator('dialog[open]').count(),1);
 await page.keyboard.press('Escape');await page.locator('#setup-guide[open]').waitFor();
 await page.waitForFunction(()=>getComputedStyle(document.getElementById('setup-guide')).opacity==='1');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'morrow-onboarding-mobile.png')});
 assert.equal(await page.evaluate(()=>document.querySelector('#setup-guide').scrollWidth<=document.querySelector('#setup-guide').clientWidth),true);
 await page.addScriptTag({url:'/axe.js'});
 const accessibility=await page.evaluate(()=>axe.run(document.querySelector('#setup-guide'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa']}}));
 console.log('accessibility',JSON.stringify(accessibility.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))));assert.equal(accessibility.violations.length,0);
 await page.setViewportSize({width:1280,height:900});
 await page.evaluate(async()=>{
   const invoke=window.morrow.invoke.bind(window.morrow);
   window.syntheticCompose={ccByDomain:{},bccByDomain:{},accounts:{}};
   window.morrow.invoke=async(channel,...args)=>{
     if(channel==='emailBrain:getComposeSettings')return {success:true,data:window.syntheticCompose};
     if(channel==='emailBrain:saveComposeSettings'){window.syntheticCompose=args[0];return {success:true,data:args[0]};}
     if(channel==='mail:listSignatures')return {success:true,data:{signatures:[]}};
     return invoke(channel,...args);
   };
   state.accounts=[{id:'a',email:'a@example.invalid',platform:'imap',imapSmtpProfile:'custom'},{id:'b',email:'b@example.invalid',platform:'imap',imapSmtpProfile:'custom'}];
   state.accountId='a';setupProgress.accountId='b';setupProgress.step=2;await paintSetupGuide();
 });
 await page.locator('#setup-guide-action').click();await page.locator('#settings[open]').waitFor();
 await page.waitForFunction(()=>document.getElementById('brain-compose-account').value==='b');
 await page.getByLabel('Morrow display name for b@example.invalid',{exact:true}).fill('Synthetic Bee');
 await page.locator('#brain-compose-form').evaluate(form=>form.requestSubmit());
 await page.waitForFunction(()=>window.syntheticCompose.accounts.b?.senderNames?.['b@example.invalid']==='Synthetic Bee');
 assert.equal(await page.evaluate(()=>window.syntheticCompose.accounts.a?.senderNames?.['b@example.invalid']),undefined);
 await page.locator('#settings-close').click();await page.locator('#setup-guide[open]').waitFor();
 await page.getByRole('button',{name:'4. Signature',exact:true}).click();await page.locator('#setup-guide-action').click();
 await page.locator('#signatures[open]').waitFor();assert.match(await page.locator('#signatures-title').textContent(),/b@example.invalid/);
 assert.equal(await page.locator('dialog[open]').count(),1);
 await page.locator('#signatures-close').click();await page.locator('#setup-guide[open]').waitFor();
 await page.locator('#setup-guide-later').click();await page.waitForFunction(()=>!document.getElementById('setup-guide').open);
 await page.evaluate(()=>showFeatures());
 assert.match(await page.locator('#features-catalog').textContent(),/First-use setup guide.*Settings → General → Open setup guide/s);
 await page.screenshot({path:path.join(output,'morrow-onboarding-features.png')});
 console.log(JSON.stringify({errors,desktop:path.join(output,'morrow-onboarding-desktop.png'),mobile:path.join(output,'morrow-onboarding-mobile.png'),result:'startup, focus trap, Escape, Settings resume, connect cancel, narrow layout, axe, actual selected-mailbox sender save, signatures and rendered Features passed'}));
 assert.deepEqual(errors,[]); await browser.close();server.close();
})().catch(e=>{console.error(e);server.close();process.exit(1)});
