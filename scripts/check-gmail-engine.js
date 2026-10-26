// Full engine/provider integration with synthetic OAuth, Gmail HTTP and temporary
// production SQLite. Native dependencies are supplied by the existing CI job.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
async function run() {
  try { require.resolve('better-sqlite3'); require.resolve('nodemailer'); }
  catch (error) { if (process.env.CI) throw error; console.log('gmail-engine-not-run: installed native/parser/MIME dependencies required; existing CI runs this fixture'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-gmail-engine-'));
  Object.assign(process.env, { MORROW_MAIL_DIR: directory, MORROW_USER_DATA: directory, MORROW_AI_CONFIG_DIR: directory, MORROW_MAIL_SECRETS: 'memory' });
  require('node:net').Socket.prototype.connect = function () { throw new Error('Socket forbidden in Gmail fixture'); };
  const { server, message } = require('./gmail-fixture');
  const service = server([message('incoming', ['INBOX', 'UNREAD', 'Label_work'])]);
  const db = require('../host/mail/db'), oauth = require('../host/mail/oauth'), config = require('../host/mail/oauth-config');
  const secrets = require('../host/mail/memory-secrets'), remote = require('../host/mail/remote');
  const sidecar = require('../host/mail/sidecar');
  let scenario = {}, signins = [];
  oauth.signIn = async (provider, purpose, options) => {
    signins.push({provider,purpose,options});
    if (scenario.wait) await scenario.wait;
    if (scenario.declined) throw Object.assign(new Error('Synthetic declined'), {code:'oauth_cancelled'});
    const scopes = scenario.scopes || (purpose === 'calendar' ? config.CALENDAR_SCOPES.google : config.SCOPES.google);
    return { provider:'google', profile:'gmail', email:scenario.email || 'owner@fixture.invalid', username:'owner@fixture.invalid',
      displayName:'Synthetic owner', ...config.IMAP_PRESETS.google, accessToken:'synthetic-access', refreshToken:'synthetic-refresh', expiresAt:Date.now()+3600000,
      grantedScopes:scopes, requestedScopes:config.scopesFor('google', purpose) };
  };
  oauth.cancelActive = () => {};
  oauth.oauthReady = () => ({google:true,microsoft:true});
  global.fetch = async (url, options) => {
    if (String(url).startsWith('https://www.googleapis.com/calendar/v3/')) return new Response(JSON.stringify({items:[]}));
    return service.fetcher(url, options);
  };
  // Do not launch the automatically scheduled post-login sync. Every sync below
  // is explicitly awaited, still using the actual engine and remote dispatch.
  const filename = require.resolve('../host/mail/engine'), module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports:module.exports, require:createRequire(filename), __dirname:path.dirname(filename),
    process, console, Buffer, URL, TextDecoder, TextEncoder, AbortController, setImmediate, clearImmediate, setInterval, clearInterval,
    setTimeout:(work, ms, ...args) => ms === 0 ? {unref(){}} : setTimeout(work, ms, ...args), clearTimeout });
  const engine = module.exports;
  const answer = (channel, params) => engine.answer(channel, params === undefined ? [] : [params]);
  const success = result => { assert.equal(result?.success, true, JSON.stringify(result)); return result.data; };
  const legacy = id => {
    db.insertAccount({id,email:id === 'gmail' ? 'owner@fixture.invalid' : `${id}@fixture.invalid`, username:'owner',profile:'gmail',authKind:'oauth2',createdAt:1,
      imapHost:'imap.gmail.com',imapPort:993,imapTls:true,smtpHost:'smtp.gmail.com',smtpPort:465,smtpTls:true});
    db.replaceFolders(id,[{path:'INBOX',name:'Inbox',wellKnown:'inbox'},{path:'Drafts',name:'Drafts',wellKnown:'drafts'}]);
    const raw = JSON.stringify({provider:'google',purpose:'imap',accessToken:'legacy-access',refreshToken:'legacy-refresh',expiresAt:Date.now()+3600000,
      grantedScopes:'openid email https://mail.google.com/ '+config.CALENDAR_SCOPES.google});
    secrets.setPassword(id,raw); return raw;
  };
  try {
    await engine.init(); const original = legacy('gmail');
    db.insertMessage({id:'cached',accountId:'gmail',folderPath:'INBOX',uid:44,uidValidity:88,rfcMessageId:'<incoming@fixture.invalid>',threadId:'legacy-thread',
      subject:'Retained synthetic mail',textBody:'Retained body',bodyComplete:true,date:new Date().toISOString(),listSortTs:Date.now()});
    assert.equal((await answer('mail:migrateGmail',{accountId:'gmail'})).error.code,'confirmation_required');
    assert.equal(signins.length,0);
    assert.equal((await answer('mail:addAccount',{provider:'google',expectedAccountId:'gmail'})).error.code,'gmail_migration_required');
    for (const variant of [{declined:true},{scopes:config.CALENDAR_SCOPES.google},{email:'wrong@fixture.invalid'}]) {
      scenario=variant; const result=await answer('mail:migrateGmail',{accountId:'gmail',confirmed:true}); assert.equal(result.success,false);
      assert.equal(secrets.getPassword('gmail'),original); assert.equal(db.accountById('gmail').mail_transport,'imap');
    }
    scenario={}; const originalUpdate = db.updateAccountLogin;
    db.updateAccountLogin = (...args) => { originalUpdate(...args); throw new Error('Synthetic transaction failure'); };
    assert.equal((await answer('mail:migrateGmail',{accountId:'gmail',confirmed:true})).success,false);
    db.updateAccountLogin=originalUpdate;
    assert.equal(secrets.getPassword('gmail'),original); assert.equal(db.accountById('gmail').mail_transport,'imap');
    const migrated=success(await answer('mail:migrateGmail',{accountId:'gmail',confirmed:true}));
    assert.equal(migrated.id,'gmail'); assert.equal(db.accountById('gmail').mail_transport,'gmail_api');
    assert.equal(JSON.parse(secrets.getPassword('gmail')).grantedScopes,config.SCOPES.google);
    assert.equal(secrets.getPassword('gmail:calendar'),original,'legacy Calendar stays separate and is truthfully broad');
    assert.equal(db.messageById('cached').text_body,'Retained body');
    await engine.syncAccountById('gmail',{background:false});
    assert.equal(db.messageById('cached').gmail_id,'incoming',JSON.stringify({folders:db.foldersFor('gmail'),calls:service.calls.map(({route,method,query})=>({route,method,query:String(query)}))}));
    success(await answer('calendar:connect',{accountId:'gmail',forceReauthorize:true}));
    assert.equal(signins.at(-1).purpose,'calendar');
    assert.equal(JSON.parse(secrets.getPassword('gmail:calendar')).grantedScopes,config.CALENDAR_SCOPES.google);
    assert.equal(JSON.parse(secrets.getPassword('gmail')).grantedScopes,config.SCOPES.google);
    assert.equal(answer('mail:oauthStatus').data.accounts.find(row=>row.id==='gmail').broadGoogleGrant,false);
    const mailSecret=secrets.getPassword('gmail'), access=oauth.accessTokenFor;
    oauth.accessTokenFor=async()=>({token:'synthetic-partial-refresh',store:JSON.stringify({...JSON.parse(mailSecret),grantedScopes:config.VACATION_SCOPES.google})});
    await assert.rejects(sidecar.gmailSendAsToken(db.accountById('gmail')),error=>error.code==='scope_missing');
    assert.equal(secrets.getPassword('gmail'),mailSecret,'feature refresh cannot replace mail with an insufficient grant'); oauth.accessTokenFor=access;
    console.log('gmail-engine-ok: explicit migration, declined/partial/mismatch/storage rollback, cache retention and separate Calendar');

    success(await answer('mail:markRead',{emailId:'cached',isRead:true})); await engine.settleActions();
    success(await answer('mail:toggleStar',{emailId:'cached',isStarred:true})); await engine.settleActions();
    assert.ok(!service.messages.get('incoming').labelIds.includes('UNREAD'));
    assert.ok(service.messages.get('incoming').labelIds.includes('STARRED'));
    const search=success(await answer('mail:search',{accountId:'gmail',query:'Synthetic'}));
    assert.ok(search.some(row=>db.messageById(row.id)?.gmail_id==='incoming'));
    const history=success(await answer('mail:searchSender',{address:'sender@fixture.invalid'}));
    assert.ok(JSON.stringify(history).includes('incoming@fixture.invalid'));
    success(await answer('mail:delete',{emailId:'cached'})); const trashed = await engine.settleActions();
    const opId = trashed.outcomes.find(row=>row.status==='completed')?.opId; assert.ok(opId,JSON.stringify(trashed));
    assert.ok(service.messages.get('incoming').labelIds.includes('TRASH'));
    success(await answer('mail:deleteBatch',{items:[{emailId:'cached'}],folderWellKnownName:'deleteditems'})); await engine.settleActions();
    success(await answer('mail:undoRemoval',{opIds:[opId]})); await engine.settleActions();
    assert.ok(service.messages.get('incoming').labelIds.includes('INBOX'));
    assert.ok(service.messages.get('incoming').labelIds.includes('Label_work'));
    success(await answer('mail:archive',{emailId:'cached'})); await engine.settleActions();
    assert.ok(!service.messages.get('incoming').labelIds.includes('INBOX'));
    assert.ok(service.calls.every(call=>call.method!=='DELETE'));
    console.log('gmail-engine-ok: real action journal, read/star, Trash/repeated Delete, Undo membership and Archive; no permanent endpoint or sockets');

    const params={accountId:'gmail',to:'to@fixture.invalid',cc:'cc@fixture.invalid',bcc:'hidden@fixture.invalid',subject:'Synthetic reply',body:'<p>Synthetic draft</p>',inReplyTo:'<incoming@fixture.invalid>',references:['<incoming@fixture.invalid>']};
    const saved=success(await answer('mail:upsertDraft',params)); assert.equal(saved.remoteSaved,true);
    let raw=service.mime.at(-1).toString(); assert.match(raw,/Bcc: hidden@fixture.invalid/i); assert.match(raw,/In-Reply-To: <incoming@fixture.invalid>/i);
    const firstUid=db.messageById(saved.emailId).uid;
    const firstProvider=db.messageById(saved.emailId).gmail_id; assert.ok(firstProvider);
    const revised=success(await answer('mail:upsertDraft',{...params,emailId:saved.emailId,draftRevision:saved.draftRevision,body:'<p>Revision two</p>'}));
    assert.equal(revised.remoteSaved,true); assert.notEqual(db.messageById(saved.emailId).uid,firstUid);
    assert.notEqual(db.messageById(saved.emailId).gmail_id,firstProvider);
    assert.ok([...service.messages.values()].some(row=>row.labelIds.includes('TRASH')&&row.labelIds.includes('DRAFT')),'old draft moves to Trash');
    const priorFetch=global.fetch;
    global.fetch=async(url,options)=>String(url).endsWith('/trash') ? new Response('{}',{status:503}) : priorFetch(url,options);
    assert.equal((await answer('mail:deleteDraft',{emailId:saved.emailId})).success,false);
    assert.ok(db.messageById(saved.emailId),'failed remote discard retains local draft'); global.fetch=priorFetch;
    const sent=success(await answer('mail:send',{...params,draftId:saved.emailId,draftRevision:revised.draftRevision}));
    assert.ok(db.messageById(sent.emailId).gmail_id); assert.equal(db.messageById(saved.emailId),null);
    raw=service.mime.at(-1).toString(); assert.match(raw,/Bcc: hidden@fixture.invalid/i); assert.match(raw,/References: <incoming@fixture.invalid>/i);
    const before=service.calls.filter(call=>call.route==='/messages/send').length;
    global.fetch=async(url,options)=>String(url).endsWith('/messages/send') ? (await priorFetch(url,options),Promise.reject(new Error('Synthetic lost acknowledgement'))) : priorFetch(url,options);
    const unknown=await answer('mail:send',params); assert.equal(unknown.error.delivery,'unknown');
    assert.equal(service.calls.filter(call=>call.route==='/messages/send').length,before+1,'ambiguous send is not retried'); global.fetch=priorFetch;
    db.insertScheduled({id:'scheduled',accountId:'gmail',status:'pending',sendAt:Date.now()-1,createdAt:Date.now(),payloadJson:JSON.stringify(params)});
    await engine.pumpScheduled(); assert.equal(service.calls.filter(call=>call.route==='/messages/send').length,before+2);
    console.log('gmail-engine-ok: actual MIME/Bcc/reply headers, draft revisions/cleanup/failure retention, send receipts and ambiguous/scheduled delivery');

    const oldSecret=secrets.getPassword('gmail'); let release;
    let unhold; service.hold(new Promise(resolve=>{unhold=resolve;}));
    const walking=engine.syncAccountById('gmail',{background:false}); await new Promise(resolve=>setImmediate(resolve));
    scenario={}; const queued=answer('mail:migrateGmail',{accountId:'gmail',confirmed:true}); await new Promise(resolve=>setImmediate(resolve));
    success(answer('mail:cancelOAuth')); unhold(); await walking; assert.equal((await queued).success,false);
    assert.equal(secrets.getPassword('gmail'),oldSecret,'cancellation is rechecked after waiting for the mailbox queue');
    scenario={wait:new Promise(resolve=>{release=resolve;})};
    const pending=answer('mail:migrateGmail',{accountId:'gmail',confirmed:true}); await new Promise(resolve=>setImmediate(resolve));
    success(answer('mail:cancelOAuth')); release(); assert.equal((await pending).success,false); assert.equal(secrets.getPassword('gmail'),oldSecret);
    const other=legacy('removed'); scenario={email:'removed@fixture.invalid',wait:new Promise(resolve=>{release=resolve;})};
    const removed=answer('mail:migrateGmail',{accountId:'removed',confirmed:true}); await new Promise(resolve=>setImmediate(resolve));
    success(await answer('mail:removeAccount',{accountId:'removed'})); release(); assert.equal((await removed).success,false);
    assert.equal(db.accountById('removed'),null); assert.equal(secrets.getPassword('removed'),null); assert.ok(other);
    console.log('gmail-engine-ok: cancellation/removal cannot commit a late OAuth result');
  } finally { await engine.stopIdle(); await db.close(); fs.rmSync(directory,{recursive:true,force:true}); }
}
module.exports={run};
if(require.main===module) run().catch(error=>{console.error(error);process.exitCode=1;});
