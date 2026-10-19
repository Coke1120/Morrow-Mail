// Isolated Electron integration check: synthetic IPC, temporary profile, blocked network.
const {app,BrowserWindow,session}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'morrow-ux-fixture-'));
const out=process.env.MORROW_UX_EVIDENCE_DIR;
app.setPath('userData',path.join(temp,'profile'));app.disableHardwareAcceleration();
const preload=path.join(temp,'preload.cjs');
fs.writeFileSync(preload,`
const {contextBridge}=require('electron');
let populated=false, failSave=true, queueReady=false, failRead=false;
let queue=[], update={enabled:false};
const calls=[], listeners={};
const accounts=['a','b'].map(id=>({id,email:id+'@example.test',platform:'imap',imapSmtpProfile:'custom',folders:{primary:[{id:'Inbox',name:'Inbox',wellKnownName:'inbox'},{id:'Drafts',name:'Drafts',wellKnownName:'drafts'}],more:[{id:'Archive',name:'Archive',wellKnownName:'archive'}]}}));
const messages=[{id:'one',accountId:'a',folderId:'Inbox',threadId:'thread-a',subject:'Alpha report',from:'Ada <ada@example.test>',textBody:'Alpha source',snippet:'Alpha preview',messageId:'<alpha@test>',date:'2026-10-18T08:00:00Z'},
{id:'two',accountId:'b',folderId:'Inbox',threadId:'thread-b',subject:'Beta report',from:'Ben <ben@example.test>',textBody:'Beta source',snippet:'Beta preview',messageId:'<beta@test>',date:'2026-10-18T07:00:00Z'}];
let draft={id:'saved-draft',accountId:'b',isDraft:true,to:['ben@example.test'],subject:'Saved Beta',textBody:'Saved body',inReplyTo:'<beta@test>',threadId:'thread-b'};
const access={enabled:true,listen:{listening:false,error:'port_in_use'},accounts:accounts.map(a=>({accountId:a.id,email:a.email})),grants:[{clientId:'fixture-client',label:'Fixture client',keyId:'fixture-id',live:true,accountIds:['a'],capabilities:['accounts.read','mail.headers.read'],expiry:{kind:'finite',expiresAt:'2090-10-25T00:00:00Z'}}],drafts:[]};
const ok=data=>({success:true,data});
contextBridge.exposeInMainWorld('morrow',{
 async invoke(channel,payload){calls.push({channel,payload});
 if(channel==='app:getVersion')return '0.1.0-alpha.9';
 if(channel.startsWith('host:update'))return update;
 if(channel==='config:getTheme')return 'light';
 if(channel==='morrow:configGetAccent')return '#193C34';
 if(channel==='morrow:configGetUndoSendDelaySeconds')return 30;
 if(channel==='morrow:configGetComposeQuoteWidth')return 420;
 if(channel==='morrow:configGetConversationViewEnabled')return true;
 if(channel.startsWith('config:')||channel.startsWith('morrow:config'))return false;
 if(channel==='mail:listAccounts')return ok(populated?accounts:[]);
 if(channel==='mail:getSyncStatus')return ok({state:'idle',message:'No account connected',lastSuccessAt:null});
 if(channel==='mail:listImapSmtpPresets')return ok([]);
 if(channel==='mail:oauthStatus')return ok({google:false,accounts:accounts.map(a=>({id:a.id,organize:false,rules:false,calendar:false,vacation:false}))});
 if(channel==='mail:addAccount'){await new Promise(r=>setTimeout(r,180));return {success:false,error:{message:'Fixture browser sign-in failed'}};}
 if(channel==='mail:listFromCache'||channel==='mail:listFromNetwork')return ok({emails:populated?messages:[]});
 if(channel==='mail:searchLocal')return ok(payload.accountId?messages.filter(m=>m.accountId===payload.accountId):messages);
 if(channel==='mail:openEmail'){const email=payload.emailId==='saved-draft'?draft:messages.find(m=>m.id===payload.emailId);return ok({email,threadMessages:email?[email]:[]});}
 if(channel==='mail:listThreadMessages')return ok([messages[0],{...messages[0],id:'other-folder',folderId:'Archive'}]);
 if(channel==='mail:listProviderFolders')return ok({api:false,reason:'profile',folders:[]});
 if(channel==='mail:listSnoozed')return ok({records:[]});
 if(channel==='mail:listSignatures')return ok({signatures:[]});
 // The current compose entry point requires the mailbox's From context.
 if(channel==='mail:getComposeContext'){
   const email=accounts.find(a=>a.id===payload.accountId).email;
   return ok({fromAddress:payload.fromAddress||email,sendAs:[{email}],selfAddresses:[email],defaultCc:[],domain:'example.test',settings:{ccByDomain:{},accounts:{}}});
 }
 if(channel==='mail:listScheduled')return queueReady?ok(queue):{success:false,error:{message:'Fixture queue read failure'}};
 if(channel==='mail:editScheduled'){const row=queue.find(r=>r.id===payload.id);queue=queue.filter(r=>r.id!==payload.id);draft={...draft,accountId:row.accountId,to:row.to,subject:row.subject,textBody:'Scheduled body preserved'};return ok({emailId:'saved-draft',accountId:row.accountId,sendAt:row.sendAt});}
 if(channel==='mail:cancelScheduled'){queue=queue.filter(r=>r.id!==payload.id);return ok(true);}
 if(channel==='mail:markRead'&&failRead)return {success:false,error:{message:'Fixture mark-read persistence failed'}};
 if(channel==='mail:upsertDraft'){
   if(failSave)return {success:false,error:{message:'Fixture save failed; your text is still here'}};
   draft={...draft,accountId:payload.accountId,to:payload.to,subject:payload.subject,textBody:'Recovered draft'};
   return ok({draftId:'saved-draft'});
 }
 if(channel==='mail:send')return {success:false,error:{message:'Fixture delivery failed'}};
 if(channel==='mail:scheduleSend'){queue.push({id:'scheduled-fixture',...payload,status:'pending'});return ok({id:'scheduled-fixture'});}
 if(channel==='mail:archiveBatch')return ok({outcomes:[{id:'one',status:'completed',opId:'fixture-op'},{id:'two',status:'unknown',error:'Fixture second remote operation failed'}],opIds:['fixture-op']});
 if(channel==='mail:undoRemoval')return ok({outcomes:[{id:'one',status:'unknown',error:'Fixture reverse move failed'}],opIds:[]});
 if(channel==='mail:vacationGet')return ok({accountId:payload.accountId,provider:'imap',supported:true,canWrite:true,revision:'fixture',extensions:['date'],settings:{mode:payload.accountId==='a'?'always':'disabled',message:'Fixture automatic reply',subject:'Away',audience:'all'}});
 if(channel==='bot:getAccess'||channel==='bot:setEnabled')return ok(access);
 if(channel==='host:aiGetConfig')return {baseUrl:'',model:'',hasKey:false};
 if(channel==='host:getDebugLog')return ok({lines:[{at:1792310400000,source:'sync',text:'address@example.test password=fixture-private-value'}]});
 return ok(null);
 },on(channel,callback){listeners[channel]=callback;return()=>{};}
});
contextBridge.exposeInMainWorld('uxFixture',{queueWorks(){queueReady=true;queue.push({id:'failed-fixture',accountId:'a',subject:'Failed queued mail',to:'recipient@example.test',sendAt:'2026-10-18T08:00:00Z',status:'failed',error:'Fixture failure'});},readyUpdate(){update={enabled:true,downloaded:true,version:'9.9.9-fixture',lastCheckedAt:'2026-10-18T08:00:00Z'};},failRead(){failRead=true;messages[0].unread=true;},populate(){populated=true;},saveWorks(){failSave=false;},counts(){return calls.reduce((out,row)=>(out[row.channel]=(out[row.channel]||0)+1,out),{});},emit(channel,payload){if(listeners[channel])listeners[channel](payload);}});
`);
let win;const run=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(error){throw new Error('Fixture step failed: '+code.slice(0,100)+' '+error.message);}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function shot(name){if(!out)return;fs.mkdirSync(out,{recursive:true});await sleep(300);fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
async function waitFor(code){for(let i=0;i<60;i++){if(await run(code))return;await sleep(50);}throw new Error('UI condition timed out: '+code);}
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,cb)=>cb({cancel:true}));
 win=new BrowserWindow({width:1180,height:820,show:true,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:true}});
 win.webContents.on('console-message',(_event,level,message)=>{if(level>=2)console.error('Renderer:',message);});
 await win.loadFile(path.join(root,'renderer/index.html'));
 await waitFor(`$('reader').textContent.includes('No mailbox yet')`);
 assert.equal(await run(`document.documentElement.dataset.nav`),'expanded');
 assert.equal(await run(`$('sync-detail').hidden`),true);assert.equal(await run(`$('refresh').disabled`),true);
 await shot('empty-profile');
 await run(`openDialog('connect');$('oauth-microsoft').click();`);
 await waitFor(`$('connect-status').textContent.includes('browser')`);
 assert.equal(await run(`$('oauth-microsoft').disabled`),true);
 await waitFor(`$('connect-status').textContent.includes('Could not finish')`);
 assert.equal(await run(`$('connect').contains($('connect-status'))`),true);
 await shot('connect-local-error');await run(`$('connect').close();uxFixture.populate();loadAccounts()`);
 await run(`openMessage('one',false);`);await run(`reviewDraft({messageId:'two',accountId:'b',body:'Beta reply'})`);
 assert.equal(await run(`$('compose-to').value`),'Ben <ben@example.test>');assert.equal(await run(`state.composeMeta.accountId`),'b');
 assert.equal(await run(`state.composeMeta.inReplyTo`),'<beta@test>');assert.equal(await run(`state.composeQuote.email.id`),'two');
 await shot('proposal-source');
 await run(`$('compose-close').click()`);await waitFor(`$('compose-close-review').open`);
 await shot('dirty-close');await run(`$('draft-close-keep').click()`);assert.equal(await run(`$('compose').open`),true);
 await run(`$('compose-save').click()`);await waitFor(`$('compose-status').textContent.includes('Fixture save failed')`);
 assert.equal(await run(`$('compose-body').value`),'Beta reply');await shot('compose-local-error');
 await run(`uxFixture.saveWorks();saveDraft()`);assert.equal(await run('state.draftId'),'saved-draft');
 await run(`(async()=>{await sendMail();cancelUndoSend();})()`);assert.equal(await run(`$('compose').open`),true);assert.equal(await run('state.draftId'),'saved-draft');
 assert.equal((await run('uxFixture.counts()'))['mail:send']||0,0);
 await run(`state.prefs.undoSend=0;sendMail()`);assert.equal(await run(`$('compose').open`),true);assert.equal(await run('state.draftId'),'saved-draft');
 assert.match(await run(`$('compose-status').textContent`),/Delivery was not confirmed/);
 await run(`$('compose').close();openMessage('saved-draft',false)`);
 assert.match(await run(`$('reader').textContent`),/Resume draft/);await run(`resumeDraft(state.email)`);assert.equal(await run('state.draftId'),'saved-draft');
 await run(`$('compose').close();openCompose({to:'recipient@example.test',body:'Schedule exactly once'})`);
 await run(`scheduleMail();`);await run(`scheduleMail();sendMail();`);
 assert.equal((await run('uxFixture.counts()'))['mail:scheduleSend'],1);assert.equal((await run('uxFixture.counts()'))['mail:send'],1);
 assert.equal(await run(`$('compose-send').disabled && $('compose-schedule').disabled`),true);
 assert.match(await run(`$('scheduled').textContent`),/could not be loaded.*Retry/);
 await shot('scheduled-receipt');await run(`$('compose').close()`);
 await run(`$('list-filter').value='unmatched';$('search-query').value='report';applySearch()`);
 assert.match(await run(`$('list-coverage').textContent`),/2 returned.*0 shown/);assert.equal(await run(`$('filter-chip').hidden`),false);
 await shot('search-filter-coverage');await run(`$('filter-chip').click();state.selectedIds=['one','two'];$('list-filter').value='Alpha';renderList()`);
 assert.match(await run(`$('selection-count').textContent`),/2 selected.*1 hidden/);assert.equal(await run(`$('select-visible').textContent`),'Select shown (1)');
 await run(`openSelectionMove('imap')`);assert.match(await run(`$('move-picker-source').textContent`),/1 excluded.*stay selected/);await run(`closeMovePicker()`);
 await run(`void applyBulkMove(selectedMessages(),{kind:'imap',id:'Archive',accountId:'a'},'Archive')`);await waitFor(`$('confirm').open`);
 assert.match(await run(`$('confirm-body').textContent`),/1 excluded.*stay selected/);await run(`$('confirm-cancel').click()`);await sleep(200);
 assert.equal((await run('uxFixture.counts()'))['mail:moveToFolder']||0,0);
 await run(`state.selectedIds=['one'];state.email=state.emails[0];state.thread=[state.email,{...state.email,id:'other-folder'}];void bulkArchive()`);
 await waitFor(`$('confirm').open`);assert.match(await run(`$('confirm-body').textContent`),/Conversation view.*2 downloaded messages/);
 await shot('conversation-scope');await run(`$('confirm-cancel').click()`);await sleep(200);
 await run(`(async()=>{state.selectedIds=['one','two'];const outcome=await runBulk([{channel:'mail:archiveBatch',params:{items:[{emailId:'one'},{emailId:'two'}]}}]);await finishBulkRemoval('Archive',outcome,['one','two']);})()`);
 assert.match(await run(`$('status').textContent`),/1 completed.*1 unknown.*second remote operation failed/);
 assert.equal(await run(`$('undo').hidden`),false);assert.deepEqual(await run('state.selectedIds'),['two']);
 const receipt=await run(`$('status').textContent`);
 await run(`uxFixture.emit('mail:syncStatus',{state:'done',accountId:'a',folderId:'Inbox',lastSuccessAt:Date.now()})`);
 assert.equal(await run(`$('status').textContent`),receipt);await shot('partial-receipt');
 await run(`undoRemoval()`);assert.match(await run(`$('status').textContent`),/Restore.*1 unknown.*reverse move failed/);assert.doesNotMatch(await run(`$('status').textContent`),/Undone/);
 await run(`openSettings();revealSettingsFold('bot')`);await waitFor(`settingsFoldLoaded.has('bot:')`);await run(`$('settings-bot').scrollIntoView({block:'start'})`);
 assert.match(await run(`$('bot-grants').textContent`),/a@example.test.*account details.*cached mail headers/);
 assert.equal(await run(`getComputedStyle($('bot-accounts').querySelector('label')).display`),'flex');
 assert.match(await run(`$('bot-listen').textContent`),/Could not start.*not listening/);
 await run(`$('bot-enabled').checked=true;$('bot-enabled').dispatchEvent(new Event('change'))`);await waitFor(`$('bot-status').textContent.includes('Could not start')`);
 await shot('bot-listener-conflict');
 await run(`showBotSecret('SYNTHETIC UI PLACEHOLDER');setBotSecretStatus('Copied.');`);
 assert.equal(await run(`$('bot-secret').contains($('bot-secret-status'))`),true);
 await run(`$('bot-secret').close()`);await waitFor(`$('bot-secret-value').textContent === ''`);
 await run(`$('settings').close();openCompose(composeSeed(state.emails[0],'reply','a@example.test'))`);
 await shot('reply-wide');win.setSize(780,760);await sleep(180);await run(`scheduleComposeLayout()`);
 assert.equal(await run(`$('compose').dataset.layout`),'narrow');await run(`toggleComposeQuoteCollapse()`);
 assert.equal(await run(`$('compose-quote-body').hidden`),true);await shot('reply-narrow');
 // Remaining UX acceptance, using only synthetic state and IPC.
 await run(`$('compose').close()`);win.setSize(1180,820);await sleep(150);
 await run(`uxFixture.queueWorks();showScheduled()`);
 assert.match(await run(`$('scheduled').textContent`),/Pending/);
 assert.match(await run(`$('scheduled').textContent`),/Failed.*check Sent/);
 assert.match(await run(`$('scheduled').textContent`),/a@example.test/);
 assert.match(await run(`$('scheduled').textContent`),/Edit\/reschedule/);
 await shot('scheduled-management');
 await run(`editScheduledMail({id:'scheduled-fixture',accountId:'a',subject:'Schedule exactly once',sendAt:'2099-01-01T08:00:00Z',status:'pending'});void 0;`);
 await waitFor(`$('confirm').open`);await run(`$('confirm-ok').click()`);
 await waitFor(`$('compose').open && $('compose-status').textContent.includes('Removed from queue')`);
 assert.equal(await run(`$('compose-body').value`),'Scheduled body preserved');
 assert.equal(await run(`state.draftId`),'saved-draft');
 assert.equal((await run('uxFixture.counts()'))['mail:scheduleSend'],1,'editing never reschedules automatically');
 assert.equal(await run(`$('compose-ai-tools').open`),false);assert.equal(await run(`$('compose-schedule-tools').open`),false);
 await shot('scheduled-draft-handoff');await run(`$('compose').close();state.accountId='a';openSettings();revealSettingsFold('ooo')`);
 await waitFor(`vacationCache && vacationCache.accountId==='a'`);
 await run(`$('ooo-message').value='Unsaved Alpha vacation';$('settings-account').value='b';$('settings-account').dispatchEvent(new Event('change'))`);
 await waitFor(`$('confirm').open`);await run(`$('confirm-cancel').click()`);await sleep(150);
 assert.equal(await run(`settingsAccount().id`),'a');assert.equal(await run(`$('ooo-message').value`),'Unsaved Alpha vacation');
 await run(`$('settings-account').value='b';$('settings-account').dispatchEvent(new Event('change'))`);
 await waitFor(`$('confirm').open`);await run(`$('confirm-ok').click()`);await waitFor(`vacationCache?.accountId==='b'`);
 assert.equal(await run(`state.accountId`),'a','Settings selection does not silently change Mail');
 await run(`$('settings-account').scrollIntoView({block:'center'})`);await shot('settings-mailbox');
 await run(`revealSettingsFold('mailbox')`);await waitFor(`settingsFoldLoaded.has('mailbox:b')`);
 await run(`$('settings-reconnect').click()`);assert.match(await run(`$('connect-title').textContent`),/b@example.test/);assert.match(await run(`$('connect-recovery-note').textContent`),/Cached mail/);assert.match(await run(`$('oauth-unavailable').textContent`),/unavailable/);
 await shot('reconnect-account');await run(`$('connect').close();$('settings').close();state.accountId='a';refreshMailVacation(true)`);
 assert.match(await run(`$('mail-ooo-status').textContent`),/a@example.test.*on until disabled/);
 await run(`clearUndo();showStatus('')`);await shot('mail-ooo-status');
 await run(`manageMailVacation()`);await waitFor(`settingsAccount().id==='a'`);assert.equal(await run(`$('settings').open`),true);
 await run(`$('settings').close();showAgent()`);await waitFor(`!$('agent-setup').hidden`);
 assert.equal(await run(`$('agent-setup-ai').hidden`),false);
 await run(`$('agent-setup-ai').click()`);assert.equal(await run(`$('settings').open`),true);await run(`$('settings').close();$('agent-manage-skills').click()`);
 assert.equal(await run(`$('brain-return-agent').hidden`),false);await run(`$('brain-return-agent').click()`);assert.equal(await run(`state.view`),'agent');
 await run(`paintSkillBlocks($('agent-result'),{accepted:true,drafts:[{messageId:'two',accountId:'b',body:'Review only'}],proposals:[{id:'filing',accountId:'a',messageId:'one',subject:'Alpha report',labelName:'Archive',status:'pending'}]});showAgentTab('tools');$('agent-result').hidden=false;`);
 await waitFor(`$('agent-result').textContent.includes('Ben <ben@example.test>')`);
 assert.match(await run(`$('agent-result').textContent`),/Account: b@example.test.*Source: Beta report/s);
 assert.match(await run(`$('agent-result').textContent`),/Destination: Archive.*pending/s);
 await shot('agent-proposals');
 await run(`uxFixture.readyUpdate();$('rail-about').click()`);await waitFor(`!$('about-update-install').hidden`);
 assert.match(await run(`$('about-update-status').textContent`),/9.9.9-fixture.*Last checked/);
 assert.equal(await run(`$('updates')`),null);
 assert.equal(await run(`$('update-check')`),null);
 assert.equal(await run(`$('rail-log').nextElementSibling.id`),'rail-about');
 assert.equal(await run(`$('about-update-install').textContent`),'Restart and install');assert.equal(await run(`$('about-update-quit').hidden`),false);
 await shot('about-updates');await run(`$('about-dialog').close();$('rail-log').click()`);await waitFor(`state.view==='log'`);
 await run(`refreshLog();`);await run(`$('log-preview').click()`);
 const support=await run(`$('support-preview').value`);assert.doesNotMatch(support,/fixture-private-value/);assert.match(support,/addresses.*may remain/);assert.match(support,/2026/);assert.match(support,/address@example.test/);
 await shot('support-preview');await run(`$('support-dialog').close();showMail();uxFixture.failRead();openMessage('one',false)`);
 assert.equal(await run(`state.email.id`),'one');assert.match(await run(`$('status').textContent`),/marking it read was not confirmed/);
 await run(`setNavCollapsed(true)`);assert.equal(await run(`readNavCollapsed()`),true);await run(`setNavCollapsed(false)`);assert.equal(await run(`readNavCollapsed()`),false);
 const counts=await run('uxFixture.counts()');
 const result={result:'UX_FIXTURE_OK',network:'blocked',mailSendCalls:counts['mail:send'],explicitScheduleCalls:counts['mail:scheduleSend'],liveProviderCalls:0};
 if(out)fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify(result,null,2)+'\n');
 console.log('UX_FIXTURE_OK');win.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1);}).finally(()=>fs.rmSync(temp,{recursive:true,force:true}));
