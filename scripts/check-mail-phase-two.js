"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {JSDOM}=require("jsdom"),{renderer}=require("./check-ux-workflows");
const fixture=require("./mail-performance-fixture");
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function flush(){for(let n=0;n<8;n++)await tick();}

function helpChecks(){
  const document=new JSDOM('<div id="features-catalog"></div><p id="features-empty"></p>').window.document;
  const ui=renderer({document});ui.context.window.morrowFeaturesCatalog=require("../renderer/features-catalog");
  ui.run("paintFeatureCatalog()");
  const text=document.body.textContent;
  assert.match(text,/up to 32 recent bodies within an estimated 8 MiB of strings, at most 2 MiB per entry/);
  assert.match(text,/cache eviction never deletes saved mail, drafts or attachments/);
  assert.match(text,/Native Mac responsiveness still needs profiling/);
  assert.equal(ui.run("BODY_CACHE_LIMITS.entries"),32);assert.equal(ui.run("BODY_CACHE_LIMITS.bytes"),8*1048576);assert.equal(ui.run("BODY_CACHE_LIMITS.entryBytes"),2*1048576);
  const help=new JSDOM(fs.readFileSync(require.resolve("../renderer/index.html"),"utf8")).window.document;
  assert.match(help.getElementById("cli-body-updates").textContent,/node scripts\/benchmark-mail-phase-two.js/);
  assert.match(help.getElementById("cli-body-updates").textContent,/internal desktop operation; bot capabilities and permissions are unchanged/);
  assert.match(help.getElementById("mail-body-cache-note").textContent,/An open view can still display a larger body/);
  assert.match(help.getElementById("mail-body-cache-note").textContent,/Reconnect and removal invalidate reuse; superseded local reads are ignored/);
}

function uiFixture(root=path.join(__dirname,"..")){
  const document=new JSDOM('<dialog id="compose"></dialog><dialog id="agent-peek"></dialog>').window.document;
  const ui=require(path.join(root,"scripts/check-ux-workflows")).renderer({document});
  ui.run(`state.accounts=[{id:'a',bodyEpoch:0}];state.accountId='a';globalThis.reads=[];globalThis.renders=0;globalThis.reloads=0;
    renderReader=()=>renders++;paintPeek=()=>renders++;renderList=()=>{};scheduleReload=()=>reloads++;
    call=(channel,params)=>new Promise((resolve,reject)=>reads.push({channel,params,resolve,reject}));`);
  return ui;
}

async function rendererChecks(){
  const ui=uiFixture();
  ui.run(`for(let n=0;n<1000;n++)applyBodyUpdate({accountId:'a',emailId:'unopened-'+n,bodyEpoch:0,bodyVersion:n+1,bodyComplete:true,hasBody:true});`);
  assert.equal(ui.run("latestBodies.size"),0);assert.equal(ui.run("bodyNotices.size"),0);assert.equal(ui.run("reads.length"),0);assert.equal(ui.run("reloads"),0);
  ui.run(`for(let n=0;n<1000;n++)applyBodyUpdate({email:{id:'legacy-'+n,accountId:'a',bodyEpoch:0,bodyVersion:n+1,textBody:'body'.repeat(2048),bodyComplete:true}});`);
  assert.equal(ui.run("latestBodies.size"),0,"unopened full compatibility events retain no bodies");
  const small=uiFixture();
  small.run(`for(let n=0;n<100;n++)noteBody({id:'small-'+n,accountId:'a',bodyEpoch:0,textBody:'Small'});`);
  assert.equal(small.run("latestBodies.size"),32,"the count budget holds independently of the byte budget");
  assert.ok(small.run("![...latestBodies.values()].some(entry=>entry.body.id==='small-0')"));
  small.run(`preferBody({id:'small-68',accountId:'a',bodyEpoch:0});noteBody({id:'small-100',accountId:'a',bodyEpoch:0,textBody:'New'});`);
  assert.ok(small.run("[...latestBodies.values()].some(entry=>entry.body.id==='small-68')"));
  assert.ok(small.run("![...latestBodies.values()].some(entry=>entry.body.id==='small-69')"),"reuse keeps an entry recent when the oldest entry is evicted");
  ui.run(`for(let n=0;n<100;n++)noteBody({id:'cached-'+n,accountId:'a',bodyEpoch:0,bodyVersion:n,textBody:'x'.repeat(300000),attachments:[{content:'do not cache'}]});`);
  assert.ok(ui.run("latestBodies.size<=BODY_CACHE_LIMITS.entries&&latestBodyBytes<=BODY_CACHE_LIMITS.bytes"));
  assert.ok(ui.run("bodyReadFences.size<=64"));
  assert.ok(ui.run("[...latestBodies.values()].every(entry=>!('attachments' in entry.body))"));
  ui.run(`noteBody({id:'huge',accountId:'a',bodyEpoch:0,bodyVersion:1,textBody:'x'.repeat(2000000)});`);
  assert.ok(ui.run("![...latestBodies.values()].some(entry=>entry.body.id==='huge')"));
  ui.run(`state.email={id:'open',accountId:'a',bodyEpoch:0,bodyVersion:0,textBody:'Old long text',bodyComplete:false,isStarred:true,subject:'Keep subject',attachments:[{id:'keep'}]};state.emails=[{...state.email}];
    applyBodyUpdate({accountId:'a',emailId:'open',bodyEpoch:0,bodyVersion:1,bodyComplete:true,hasBody:true});
    for(let n=2;n<=1000;n++)applyBodyUpdate({accountId:'a',emailId:'open',bodyEpoch:0,bodyVersion:n,bodyComplete:true,hasBody:true});`);
  await flush();assert.equal(ui.run("reads.length"),1);
  assert.equal(ui.run("reads[0].channel"),"mail:readCachedBody");
  ui.run(`reads[0].resolve({email:{id:'open',accountId:'a',bodyEpoch:0,bodyVersion:1,textBody:'First',bodyComplete:true}});`);
  await flush();assert.equal(ui.run("reads.length"),2,"a burst has one in-flight read and one latest refresh");
  ui.run(`reads[1].resolve({email:{id:'open',accountId:'a',bodyEpoch:0,bodyVersion:1000,textBody:'New',bodyComplete:true}});`);
  await flush();assert.equal(ui.run("state.email.textBody"),"New","newer shorter bodies replace older longer bodies");
  assert.equal(ui.run("state.email.subject"),"Keep subject");assert.equal(ui.run("state.email.attachments[0].id"),"keep");assert.equal(ui.run("state.email.isStarred"),true);
  assert.equal(ui.run("reloads"),0);
  // An explicit fresh read must win over a previously started cache refresh,
  // even when both snapshots carry the same global body version.
  const race=uiFixture();
  race.run(`state.email={id:'race',accountId:'a',bodyEpoch:0,bodyVersion:0,textBody:'Before'};
    applyBodyUpdate({accountId:'a',emailId:'race',bodyEpoch:0,bodyVersion:1,hasBody:true});`);
  await flush();
  race.run(`state.email={id:'race',accountId:'a',bodyEpoch:0,bodyVersion:1,textBody:'Explicit newer read'};noteBody(state.email);
    reads[0].resolve({email:{id:'race',accountId:'a',bodyEpoch:0,bodyVersion:1,textBody:'Older response'}});`);
  await flush();assert.equal(race.run("state.email.textBody"),"Explicit newer read");assert.equal(race.run("reads.length"),1);
  const large=uiFixture();
  large.run(`state.email={id:'large',accountId:'a',bodyEpoch:0,bodyVersion:0,textBody:'Before'};
    applyBodyUpdate({accountId:'a',emailId:'large',bodyEpoch:0,bodyVersion:1,hasBody:true});`);
  await flush();
  large.run(`reads[0].resolve({email:{id:'large',accountId:'a',bodyEpoch:0,bodyVersion:1,textBody:'x'.repeat(2000000),bodyComplete:false}});`);
  await flush();assert.equal(large.run("state.email.textBody.length"),2000000);assert.equal(large.run("latestBodies.size"),0);
  large.run(`for(let n=0;n<20;n++)applyBodyUpdate({accountId:'a',emailId:'large',bodyEpoch:0,bodyVersion:1,hasBody:true,bodyComplete:false});`);
  await flush();assert.equal(large.run("reads.length"),1,"uncached oversized/incomplete bodies must not refetch repeatedly");
  const pending=uiFixture();
  pending.run(`state.emails=[{id:'pending',accountId:'a',bodyEpoch:0}];pendingOpenId='pending';pendingOpenBody=true;
    applyBodyUpdate({accountId:'a',emailId:'pending',bodyEpoch:0,bodyVersion:2,hasBody:true});`);
  await flush();
  pending.run(`reads[0].resolve({email:{id:'pending',accountId:'a',bodyEpoch:0,bodyVersion:2,textBody:'Fetched while opening',bodyComplete:true}});`);
  await flush();
  pending.run(`pendingOpenId='';pendingOpenBody=false;const incoming={id:'pending',accountId:'a',bodyEpoch:0,bodyVersion:1,textBody:'Late open snapshot'};
    noteBody(incoming);state.email=preferBody(incoming);pumpBodyRefreshes();`);
  await flush();assert.equal(pending.run("state.email.textBody"),"Fetched while opening");assert.equal(pending.run("reads.length"),2,"a cached body must not conceal older attachment/draft metadata in a late open response");
  pending.run(`reads[1].resolve({email:{id:'pending',accountId:'a',bodyEpoch:0,bodyVersion:2,textBody:'Fetched while opening',attachments:[{id:'new-cid',contentId:'logo'}],draftRevision:'new-revision',fromAddress:'alias@fixture.invalid'}});`);
  await flush();assert.equal(pending.run("state.email.attachments[0].contentId"),"logo");assert.equal(pending.run("state.email.draftRevision"),"new-revision");
  assert.equal(pending.run("state.email.fromAddress"),"alias@fixture.invalid");assert.equal(pending.run("reads.length"),2);
  assert.ok(pending.run("[...latestBodies.values()].every(entry=>!('attachments' in entry.body))"));
  const warning=uiFixture();
  warning.run(`state.email={id:'warning',accountId:'a',bodyEpoch:0,bodyVersion:0,textBody:'Same body',bodyWarning:'',bodyComplete:true};state.emails=[state.email];
    applyBodyUpdate({accountId:'a',emailId:'warning',bodyEpoch:0,bodyVersion:1,hasBody:true,bodyComplete:true,bodyWarning:'New warning'});`);
  await flush();warning.run(`reads[0].resolve({email:{id:'warning',accountId:'a',bodyEpoch:0,bodyVersion:1,textBody:'Same body',bodyWarning:'New warning',bodyComplete:true}});`);
  await flush();assert.equal(warning.run("renders"),1,"warning-only updates repaint even when list/reader share an object");
  ui.run(`for(let n=0;n<20;n++)applyBodyUpdate({accountId:'a',emailId:'open',bodyEpoch:0,bodyVersion:1000,bodyComplete:true,hasBody:true});`);
  await flush();assert.equal(ui.run("reads.length"),2,"duplicate notices must not refetch");
  ui.run(`applyBodyUpdate({accountId:'a',emailId:'open',bodyEpoch:0,bodyVersion:1001,bodyComplete:true,hasBody:true});`);
  await flush();ui.run(`reads[2].reject(new Error('Synthetic failed local read'));`);await flush();
  assert.equal(ui.run("reads.length"),3,"failed refresh must not retry in a loop");
  ui.run(`applyBodyUpdate({accountId:'a',emailId:'open',bodyEpoch:0,bodyVersion:1002,bodyComplete:true,hasBody:true});`);
  await flush();assert.equal(ui.run("reads.length"),4);
  ui.run(`acceptBodyAccounts([{id:'a',bodyEpoch:1,bodyVersion:1002}]);reads[3].resolve({email:{id:'open',accountId:'a',bodyEpoch:0,bodyVersion:1002,textBody:'Stale old account'}});`);
  await flush();assert.equal(ui.run("reads.length"),5);assert.equal(ui.run("reads[4].params.bodyEpoch"),1);
  assert.equal(ui.run("state.email.textBody"),"New");
  ui.run(`reads[4].resolve({email:{id:'open',accountId:'a',bodyEpoch:1,bodyVersion:1002,textBody:'Reconnected',bodyComplete:true}});`);
  await flush();assert.equal(ui.run("state.email.textBody"),"Reconnected");
  ui.run(`applyBodyUpdate({accountId:'foreign',emailId:'open',bodyEpoch:1,bodyVersion:9000,hasBody:true});applyBodyUpdate({accountId:'a',emailId:'open',bodyEpoch:0,bodyVersion:9000,hasBody:true});`);
  await flush();assert.equal(ui.run("reads.length"),5,"wrong-account and stale-generation updates are ignored");
  ui.run(`applyBodyUpdate({accountId:'a',emailId:'open',bodyEpoch:1,bodyVersion:1003,hasBody:true});`);await flush();
  const paints=ui.run("renders");
  ui.run(`state.email=null;invalidateReaderOpen();reads[5].resolve({email:{id:'open',accountId:'a',bodyEpoch:1,bodyVersion:1003,textBody:'Cancelled'}});`);
  await flush();assert.equal(ui.run("renders"),paints);assert.equal(ui.run("bodyNotices.size"),0);
  ui.run(`acceptBodyAccounts([]);`);assert.equal(ui.run("latestBodies.size"),0);assert.equal(ui.run("latestBodyBytes"),0);
  const closed=uiFixture();
  closed.run(`state.email={id:'closed',accountId:'a',bodyEpoch:0};applyBodyUpdate({accountId:'a',emailId:'closed',bodyEpoch:0,bodyVersion:1,hasBody:true});`);
  await flush();closed.run(`reads[0].resolve({email:{id:'closed',accountId:'a',bodyEpoch:0,bodyVersion:1,textBody:'Done'}});`);await flush();
  closed.run(`invalidateReaderOpen();state.email=null;`);assert.equal(closed.run("bodyNotices.size"),0,"closing a settled reader releases its notice immediately");
  const preview=uiFixture();
  preview.run(`globalThis.opened=peekMessage('preview');invalidatePeek();reads[0].resolve({email:{id:'preview',accountId:'a',bodyEpoch:0,textBody:'Superseded'}});`);
  await preview.run("opened");assert.equal(preview.run("peekEmail"),null);assert.equal(preview.run("pendingPeekId"),"");assert.equal(preview.run("bodyNotices.size"),0);
  const previewRefresh=uiFixture();
  previewRefresh.run(`$('agent-peek').open=true;peekEmail={id:'preview-refresh',accountId:'a',bodyEpoch:0};applyBodyUpdate({accountId:'a',emailId:'preview-refresh',bodyEpoch:0,bodyVersion:1,hasBody:true});`);
  await flush();previewRefresh.run(`invalidatePeek();reads[0].resolve({email:{id:'preview-refresh',accountId:'a',bodyEpoch:0,bodyVersion:1,textBody:'Closed preview'}});`);await flush();
  assert.equal(previewRefresh.run("peekEmail"),null);assert.equal(previewRefresh.run("renders"),0);assert.equal(previewRefresh.run("latestBodies.size"),0);assert.equal(previewRefresh.run("bodyNotices.size"),0);
  const threadRace=uiFixture();
  threadRace.run(`state.prefs.conversation=true;state.emails=[{id:'thread-race',accountId:'a',hasBody:true,bodyComplete:true}];globalThis.opened=openMessage('thread-race',false).catch(error=>error.message);
    reads[0].resolve({email:{id:'thread-race',accountId:'a',threadId:'thread',bodyEpoch:0,bodyVersion:0,textBody:'Old connection'}});`);
  await flush();assert.equal(threadRace.run("reads[1].channel"),"mail:listThreadMessages");
  threadRace.run(`acceptBodyAccounts([{id:'a',bodyEpoch:1}]);reads[1].resolve([]);`);
  assert.match(await threadRace.run("opened"),/mailbox connection changed/);assert.equal(threadRace.run("state.email.textBody"),null,"account invalidation while thread metadata is pending must not publish the old body");
  return {unopenedNotices:1000,retainedUnopenedBodies:0,cacheEntries:32,cacheBytes:8*1048576,entryBytes:2*1048576,burstReads:2,bodyReloads:0};
}

async function hostChecks(root=path.join(__dirname,".."),verify=true){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"morrow-phase2-"));
  const env={...process.env},fetch=global.fetch,electron=require.resolve("electron"),previousElectron=require.cache[electron];
  const events=[];
  require.cache[electron]={id:electron,filename:electron,loaded:true,exports:{BrowserWindow:{getAllWindows:()=>[{isDestroyed:()=>false,webContents:{send:(channel,payload)=>events.push({channel,payload})}}]}}};
  Object.assign(process.env,{MORROW_MAIL_DIR:dir,MORROW_USER_DATA:dir,MORROW_AI_CONFIG_DIR:dir,MORROW_MAIL_SECRETS:"memory"});
  global.fetch=async()=>{throw new Error("No live provider calls");};
  const db=require(path.join(root,"host/mail/db")),engine=require(path.join(root,"host/mail/engine")),remote=require(path.join(root,"host/mail/remote"));
  const SQLite=require("better-sqlite3"),prepare=SQLite.prototype.prepare;
  let counting=false,count=0,release;const gate=new Promise(resolve=>{release=resolve;});
  const original={withClient:remote.withClient,fetchSource:remote.fetchSource};
  remote.withClient=async(_a,_p,work)=>{await gate;return work({});};
  remote.fetchSource=async(_c,_f,uid)=>({uid,textBody:"Downloaded synthetic body ".repeat(2048),bodyComplete:true,recipientHeaders:{replyTo:[]},attachments:[]});
  function measure(work){count=0;counting=true;try{return{result:work(),queries:count};}finally{counting=false;}}
  SQLite.prototype.prepare=function(sql){if(counting&&/^\s*(SELECT|PRAGMA)\b/i.test(sql))count++;return prepare.call(this,sql);};
  try{
    await engine.init();fixture.seed(db,{count:240,threadCount:20,bodyBytes:1024,threadBytes:2048});
    require(path.join(root,"host/mail/memory-secrets")).setPassword(fixture.account.id,"synthetic-only");
    const query={accountId:fixture.account.id,folderId:"INBOX",limit:200};
    const complete=measure(()=>engine.answer("mail:listFromCache",[query]));
    const durations=[];
    for(let n=0;n<14;n++){const began=performance.now();engine.answer("mail:listFromCache",[query]);if(n>=2)durations.push(performance.now()-began);}
    durations.sort((a,b)=>a-b);
    if(verify){assert.ok(complete.queries<=16,`complete list query budget: ${complete.queries}`);assert.equal(complete.result.data.emails.length,200);}
    db.transaction(()=>{for(let uid=41;uid<=240;uid++)db.updateMessage(`performance-${uid}`,{body_complete:0});});
    const incomplete=measure(()=>engine.answer("mail:listFromCache",[query]));
    if(verify)assert.ok(incomplete.queries<=18,`incomplete list query budget: ${incomplete.queries}`);
    engine.answer("mail:listFromCache",[{accountId:fixture.account.id,folderId:"Sent",limit:200}]); // Cancel the remaining visible-page prefetch.
    release();await flush();
    const updates=events.filter(row=>row.channel==="mail:bodyUpdated");assert.equal(updates.length,1,"page change cancels all but the in-flight body");
    const bytes=Buffer.byteLength(JSON.stringify(updates[0].payload));
    if(verify){
      assert.ok(bytes<512);assert.ok(!("email" in updates[0].payload));assert.ok(!("textBody" in updates[0].payload));
      const notice=updates[0].payload;
      const read=await engine.answer("mail:readCachedBody",[{accountId:notice.accountId,emailId:notice.emailId,bodyEpoch:notice.bodyEpoch}]);
      assert.equal(read.success,true);assert.match(read.data.email.textBody,/Downloaded synthetic body/);
      assert.ok(read.data.email.bodyVersion>=notice.bodyVersion);
      for(const extra of [{accountId:"wrong"},{bodyEpoch:99}])assert.equal((await engine.answer("mail:readCachedBody",[{accountId:notice.accountId,emailId:notice.emailId,bodyEpoch:notice.bodyEpoch,...extra}])).success,false);
      db.insertAccount({...fixture.account,id:"other",email:"other@fixture.invalid"});
      const action=(id,accountId,generation)=>({id,batchId:id,messageId:"performance-240",accountId,generation,intentJson:"{}",priorJson:"{}",sourceJson:"{}",phase:"closed",createdAt:1});
      db.insertMailAction(action("valid",fixture.account.id,7));db.insertMailAction(action("foreign","other",99));
      const generations=measure(()=>db.maxActionGenerations(["performance-240",...Array.from({length:1000},(_,n)=>`missing-${n}`)]));
      assert.equal(generations.queries,3);assert.equal(generations.result.get("performance-240"),7);assert.equal(generations.result.get("missing-0"),0);
      const list=engine.answer("mail:listFromCache",[{accountId:fixture.account.id,folderId:"INBOX",limit:1}]);assert.equal(list.data.emails[0].actionGeneration,7);
      db.insertMessage({...fixture.message(900,{isDraft:true,from:"alias@fixture.invalid",fromAddress:"alias@fixture.invalid",fromDisplayName:"Saved Alias",attachments:[{id:"local-file",storageUrl:"local:local-file",filename:"inline.png",contentId:"logo",size:4}]}),accountId:fixture.account.id,folderPath:"Sent"});
      const draft=engine.answer("mail:readCachedBody",[{accountId:fixture.account.id,emailId:"performance-900",bodyEpoch:0}]);
      assert.equal(draft.success,true);assert.equal(draft.data.email.fromAddress,"alias@fixture.invalid");assert.equal(draft.data.email.fromDisplayName,"Saved Alias");
      assert.ok(draft.data.email.draftRevision);assert.equal(draft.data.email.attachments[0].contentId,"logo");assert.equal(draft.data.email.attachments[0].storageUrl,"local:local-file");
      engine.answer("mail:listFromCache",[{accountId:fixture.account.id,folderId:"Sent",limit:200}]);
      await flush();
      await engine.answer("mail:removeAccount",[{accountId:fixture.account.id}]);
      db.insertAccount(fixture.account);db.replaceFolders(fixture.account.id,fixture.folders);
      db.insertMessage({...fixture.message(240,{textBody:"New connection body"}),accountId:fixture.account.id,folderPath:"INBOX"});
      assert.equal((await engine.answer("mail:readCachedBody",[{accountId:fixture.account.id,emailId:"performance-240",bodyEpoch:0}])).success,false,"old connection epoch must be rejected after account removal/re-add");
      assert.equal((await engine.answer("mail:readCachedBody",[{accountId:fixture.account.id,emailId:"performance-240",bodyEpoch:1}])).data.email.textBody,"New connection body");
    }
    return{completeListQueries:complete.queries,incompleteListQueries:incomplete.queries,bodyNotificationBytes:bytes,
      cachedListMedianMs:Math.round(durations[5]*100)/100,cachedListP95Ms:Math.round(durations.at(-1)*100)/100};
  } finally{
    release();await flush();SQLite.prototype.prepare=prepare;remote.withClient=original.withClient;remote.fetchSource=original.fetchSource;
    await db.close();global.fetch=fetch;if(previousElectron)require.cache[electron]=previousElectron;else delete require.cache[electron];
    for(const key of ["MORROW_MAIL_DIR","MORROW_USER_DATA","MORROW_AI_CONFIG_DIR","MORROW_MAIL_SECRETS"]){if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
async function run(){helpChecks();const ui=await rendererChecks(),host=await hostChecks();console.log("mail-phase-two-ok: "+JSON.stringify({...host,...ui}));}
module.exports={run,hostChecks,uiFixture};
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1;});
