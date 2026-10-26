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
  const withFiles=message('attachments'); withFiles.payload={mimeType:'multipart/mixed',headers:withFiles.payload.headers,parts:[
    {partId:'0',mimeType:'text/plain',body:{attachmentId:'unfetched-text',size:100}},
    {partId:'1',mimeType:'text/plain',filename:'first.txt',body:{data:Buffer.from('FIRST').toString('base64url')}},
    {partId:'2',mimeType:'text/plain',filename:'second.txt',body:{data:Buffer.from('SECOND').toString('base64url')}},
  ]};
  const service = server([message('incoming', ['INBOX', 'UNREAD', 'Label_work']),withFiles]);
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
    db.replaceFolders(id,[{path:'INBOX',name:'Inbox',wellKnown:'inbox'},{path:'Drafts',name:'Drafts',wellKnown:'drafts'},{path:'Old cached label',name:'Old cached label'}]);
    const raw = JSON.stringify({provider:'google',purpose:'imap',accessToken:'legacy-access',refreshToken:'legacy-refresh',expiresAt:Date.now()+3600000,
      grantedScopes:'openid email https://mail.google.com/ '+config.CALENDAR_SCOPES.google});
    secrets.setPassword(id,raw); return raw;
  };
  try {
    await engine.init(); const original = legacy('gmail');
    db.insertMessage({id:'cached',accountId:'gmail',folderPath:'INBOX',uid:44,uidValidity:88,rfcMessageId:'<incoming@fixture.invalid>',threadId:'legacy-thread',
      subject:'Retained synthetic mail',textBody:'Retained body',bodyComplete:true,date:new Date().toISOString(),listSortTs:Date.now()});
    db.insertMessage({id:'legacy-files',accountId:'gmail',folderPath:'INBOX',uid:45,uidValidity:88,rfcMessageId:'<attachments@fixture.invalid>',
      textBody:'Retained attachment body',bodyComplete:true,attachments:[{id:'2',filename:'first.txt'},{id:'3',filename:'second.txt'}],hasAttachments:true,
      date:new Date().toISOString(),listSortTs:Date.now()});
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
    assert.equal(db.folderByPath('gmail','Old cached label').provider_id,null,'unbound legacy folders stay local without blocking sync');
    assert.equal(db.messageById('legacy-files').text_body,'Retained attachment body');
    const firstFile=db.jsonList(db.messageById('legacy-files').attachments_json).find(row=>row.filename==='first.txt');
    assert.equal((await engine.bytesFor({emailId:'legacy-files',attachmentId:firstFile.id})).data.toString(),'FIRST');
    assert.equal(await engine.bytesFor({emailId:'legacy-files',attachmentId:'2',filename:'first.txt'}),null,'stale IMAP attachment ids cannot address a different Gmail part');
    success(await answer('calendar:connect',{accountId:'gmail',forceReauthorize:true}));
    assert.equal(signins.at(-1).purpose,'calendar');
    assert.equal(JSON.parse(secrets.getPassword('gmail:calendar')).grantedScopes,config.CALENDAR_SCOPES.google);
    assert.equal(JSON.parse(secrets.getPassword('gmail')).grantedScopes,config.SCOPES.google);
    assert.equal(answer('mail:oauthStatus').data.accounts.find(row=>row.id==='gmail').broadGoogleGrant,false);
    const calendarSecret=secrets.getPassword('gmail:calendar'), primarySecret=secrets.getPassword('gmail');
    for (const scopes of [config.SCOPES.google,'openid email https://www.googleapis.com/auth/calendar.events']) {
      scenario={scopes}; const denied=await answer('calendar:connect',{accountId:'gmail',forceReauthorize:true});
      assert.equal(denied.success,false); assert.equal(denied.error.code,'scope_missing');
      assert.equal(secrets.getPassword('gmail:calendar'),calendarSecret,'incomplete Calendar reauthorization preserves the working credential');
      assert.equal(secrets.getPassword('gmail'),primarySecret);
      assert.equal(success(await answer('calendar:list',{accountId:'gmail',timeMin:'2026-10-01T00:00:00Z',timeMax:'2026-11-01T00:00:00Z'})).api,true);
    }
    scenario={};
    const mailSecret=secrets.getPassword('gmail'), access=oauth.accessTokenFor;
    oauth.accessTokenFor=async()=>({token:'synthetic-partial-refresh',store:JSON.stringify({...JSON.parse(mailSecret),grantedScopes:config.VACATION_SCOPES.google})});
    await assert.rejects(sidecar.gmailSendAsToken(db.accountById('gmail')),error=>error.code==='scope_missing');
    assert.equal(secrets.getPassword('gmail'),mailSecret,'feature refresh cannot replace mail with an insufficient grant'); oauth.accessTokenFor=access;
    success(await answer('mail:createFolder',{accountId:'gmail',folderName:'Projects'}));
    const labelId=db.folderByPath('gmail','Projects').provider_id; assert.ok(labelId);
    const nested=success(await answer('mail:moveFolder',{accountId:'gmail',folderId:'Projects',destinationId:'Work'}));
    assert.equal(nested.id,'Work/Projects'); assert.equal(db.folderByPath('gmail',nested.id).provider_id,labelId);
    console.log('gmail-engine-ok: explicit migration, declined/partial/mismatch/storage rollback, cache retention and separate Calendar');

    // Exercise the actual reopen/list handlers before the legacy cache rows
    // have appeared in a provider sync, with complete bodies and headers.
    const unopened=message('unopened-files'); unopened.payload={...withFiles.payload,headers:unopened.payload.headers};
    service.messages.set(unopened.id,unopened);
    db.insertMessage({id:'unopened-legacy',accountId:'gmail',folderPath:'INBOX',uid:500,uidValidity:88,rfcMessageId:'<unopened-files@fixture.invalid>',
      textBody:'Correct complete cached text',htmlBody:'<p>Correct complete cached HTML</p>',bodyComplete:true,recipientHeaders:{deliveredTo:['owner@fixture.invalid']},
      attachments:[{id:'2',filename:'first.txt'},{id:'3',filename:'second.txt'}],hasAttachments:true,date:new Date().toISOString(),listSortTs:Date.now()});
    assert.equal(db.messageById('unopened-legacy').gmail_id,null);
    assert.equal(await engine.bytesFor({emailId:'unopened-legacy',attachmentId:'2'}).then(()=>null,error=>error.code),'attachment_changed');
    const reopened=success(await answer('mail:openEmail',{emailId:'unopened-legacy',full:true})).email;
    assert.equal(reopened.textBody,'Correct complete cached text'); assert.equal(reopened.htmlBody,'<p>Correct complete cached HTML</p>');
    const freshFile=reopened.attachments.find(row=>row.filename==='first.txt'); assert.equal(freshFile.id,'gmail:1');
    const readsAfterOpen=service.calls.filter(call=>call.route==='/messages/unopened-files').length;
    const repeated=success(await answer('mail:openEmail',{emailId:'unopened-legacy',full:true})).email;
    assert.equal(repeated.attachments.find(row=>row.filename==='first.txt').id,'gmail:1');
    assert.equal(service.calls.filter(call=>call.route==='/messages/unopened-files').length,readsAfterOpen,'fresh metadata is reused on repeated open');
    assert.equal((await engine.bytesFor({emailId:'unopened-legacy',attachmentId:freshFile.id})).data.toString(),'FIRST');
    assert.equal((await engine.bytesFor({emailId:'unopened-legacy',attachmentId:'gmail:2'})).data.toString(),'SECOND');
    assert.equal(await engine.bytesFor({emailId:'unopened-legacy',attachmentId:'2'}),null,'stale selection remains invalid after recovery');
    assert.equal(service.calls.filter(call=>call.route==='/messages/unopened-files/attachments/unfetched-text').length,0,'metadata recovery does not replace complete cached text');
    console.log('gmail-engine-ok: repeated openEmail(full:true) refreshes unadopted attachment metadata and retains complete cached text/HTML');

    service.messages.set('unmapped-copies',message('unmapped-copies',['INBOX','Label_work']));
    const legacyIds=['unmapped-inbox','unmapped-work','unmapped-all'];
    for (const [index,folder] of ['INBOX','Work','[Gmail]/All Mail'].entries()) db.insertMessage({id:legacyIds[index],accountId:'gmail',folderPath:folder,
      uid:600+index,uidValidity:88,rfcMessageId:'<unmapped-copies@fixture.invalid>',threadId:'unmapped-conversation',textBody:'Cached legacy copy',bodyComplete:true,
      recipientHeaders:{},date:new Date().toISOString(),listSortTs:Date.now()});
    db.insertMessage({id:'unrelated-legacy-work',accountId:'gmail',folderPath:'Work',uid:610,uidValidity:88,rfcMessageId:'<unrelated-retained@fixture.invalid>',
      textBody:'Retain unrelated cached mail',bodyComplete:true,recipientHeaders:{},date:new Date().toISOString(),listSortTs:Date.now()});
    db.insertMessage({id:'pending-legacy-edit',accountId:'gmail',folderPath:'Drafts',uid:0,uidValidity:0,rfcMessageId:'<unmapped-copies@fixture.invalid>',
      textBody:'Retain unsaved local edits',isDraft:true,draftPending:true,bodyComplete:true,recipientHeaders:{},date:new Date().toISOString(),listSortTs:Date.now()});
    // Other fixture bodies are already downloaded; keep visible-page prefetch
    // out of this deterministic cache-membership test.
    for (const row of db.gmailCopies('gmail','attachments')) if (!row.body_complete) db.updateMessage(row.id,{text_body:'Previously downloaded fixture text',body_complete:1,recipient_headers_json:'{}'});
    for (const folder of ['Work','[Gmail]/All Mail']) assert.ok(success(await answer('mail:listFromCache',{accountId:'gmail',folderId:folder,limit:100})).emails.some(row=>legacyIds.includes(row.id)));
    const legacyTrashBefore=service.calls.filter(call=>call.route==='/messages/unmapped-copies/trash').length;
    const legacyTrash=success(await answer('mail:threadTrash',{accountId:'gmail',threadId:'unmapped-conversation'})); assert.equal(legacyTrash.pending.length,1);
    const legacySettled=await engine.settleActions(); assert.equal(legacySettled.outcomes.filter(row=>row.status==='completed').length,1);
    assert.equal(service.calls.filter(call=>call.route==='/messages/unmapped-copies/trash').length,legacyTrashBefore+1);
    for (const folder of ['Work','[Gmail]/All Mail']) {
      const refreshed=success(await answer('mail:listFromNetwork',{accountId:'gmail',folderId:folder,limit:100}));
      assert.ok(refreshed.emails.every(row=>row.messageId!=='<unmapped-copies@fixture.invalid>'),'refreshed list cannot retain an unadopted label copy after Trash');
      const listed=success(await answer('mail:listFromCache',{accountId:'gmail',folderId:folder,limit:100}));
      assert.ok(listed.emails.every(row=>row.messageId!=='<unmapped-copies@fixture.invalid>'));
    }
    assert.ok(success(await answer('mail:listFromCache',{accountId:'gmail',folderId:'Work',limit:100})).emails.some(row=>row.id==='unrelated-legacy-work'));
    assert.equal(db.messageById('unrelated-legacy-work').gmail_id,null); assert.equal(db.messageById('pending-legacy-edit').draft_pending,1);
    assert.equal(db.gmailCopies('gmail','unmapped-copies').length,1); assert.equal(db.gmailCopies('gmail','unmapped-copies')[0].folder_path,'[Gmail]/Trash');
    console.log('gmail-engine-ok: actual cache/network list handlers remove all verified legacy label copies after one Trash while retaining unrelated mail/local edits');

    success(await answer('mail:markRead',{emailId:'cached',isRead:true})); await engine.settleActions();
    success(await answer('mail:toggleStar',{emailId:'cached',isStarred:true})); await engine.settleActions();
    assert.ok(!service.messages.get('incoming').labelIds.includes('UNREAD'));
    assert.ok(service.messages.get('incoming').labelIds.includes('STARRED'));
    const search=success(await answer('mail:search',{accountId:'gmail',query:'Synthetic'}));
    assert.ok(search.some(row=>db.messageById(row.id)?.gmail_id==='incoming'));
    const history=success(await answer('mail:searchSender',{address:'sender@fixture.invalid'}));
    assert.ok(JSON.stringify(history).includes('incoming@fixture.invalid'));
    for (const row of db.gmailCopies('gmail','incoming')) db.updateMessage(row.id,{thread_id:'conversation-fixture'});
    assert.equal(db.gmailCopies('gmail','incoming').length,3);
    const trashBefore=service.calls.filter(call=>call.route==='/messages/incoming/trash').length;
    const conversation=success(await answer('mail:threadTrash',{accountId:'gmail',threadId:'conversation-fixture'}));
    assert.equal(conversation.pending.length,1,'one journal action for three label copies');
    const trashed = await engine.settleActions();
    assert.equal(trashed.outcomes.filter(row=>row.status==='completed').length,1);
    const opId = trashed.outcomes.find(row=>row.status==='completed')?.opId; assert.ok(opId,JSON.stringify(trashed));
    assert.equal(service.calls.filter(call=>call.route==='/messages/incoming/trash').length,trashBefore+1);
    assert.equal(db.gmailCopies('gmail','incoming').length,1); const survivor=db.gmailCopies('gmail','incoming')[0];
    assert.equal(survivor.folder_path,'[Gmail]/Trash');
    assert.ok(db.readOp(opId).moves[0].providerUndo.labelIds.includes('INBOX'));
    assert.ok(service.messages.get('incoming').labelIds.includes('TRASH'));
    success(await answer('mail:deleteBatch',{items:[{emailId:survivor.id}],folderWellKnownName:'deleteditems'})); await engine.settleActions();
    success(await answer('mail:markRead',{emailId:survivor.id,isRead:false})); await engine.settleActions();
    success(await answer('mail:toggleStar',{emailId:survivor.id,isStarred:false})); await engine.settleActions();
    success(await answer('mail:undoRemoval',{opIds:[opId]})); const restored=await engine.settleActions();
    assert.equal(restored.outcomes.filter(row=>row.status==='completed').length,1); assert.ok(restored.outcomes.every(row=>row.status==='completed'));
    assert.ok(service.messages.get('incoming').labelIds.includes('INBOX'));
    assert.ok(service.messages.get('incoming').labelIds.includes('Label_work'));
    assert.ok(service.messages.get('incoming').labelIds.includes('UNREAD')); assert.ok(!service.messages.get('incoming').labelIds.includes('STARRED'));
    assert.equal(db.gmailCopies('gmail','incoming').length,3);
    const allCopy=db.gmailCopies('gmail','incoming').find(row=>row.folder_path==='[Gmail]/All Mail');
    const archiveBefore=service.calls.filter(call=>call.route==='/messages/incoming/modify').length;
    success(await answer('mail:archive',{emailId:allCopy.id})); const archived=await engine.settleActions();
    assert.equal(service.calls.filter(call=>call.route==='/messages/incoming/modify').length,archiveBefore+1,'Archive from All Mail issues a provider write');
    assert.ok(!service.messages.get('incoming').labelIds.includes('INBOX'));
    assert.ok(!db.gmailCopies('gmail','incoming').some(row=>row.folder_path==='INBOX'));
    const archiveOp=archived.outcomes.find(row=>row.status==='completed')?.opId; assert.ok(archiveOp);
    success(await answer('mail:undoRemoval',{opIds:[archiveOp]})); await engine.settleActions();
    assert.ok(service.messages.get('incoming').labelIds.includes('INBOX'),'Archive Undo from All Mail restores Inbox');
    const found=success(await answer('mail:search',{accountId:'gmail',query:'Synthetic'})).find(row=>db.messageById(row.id)?.gmail_id==='incoming');
    success(await answer('mail:archive',{emailId:found.id})); await engine.settleActions();
    assert.ok(!service.messages.get('incoming').labelIds.includes('INBOX'),'Archive also works from a provider-search copy');
    assert.ok(service.calls.every(call=>call.method!=='DELETE'));
    console.log('gmail-engine-ok: migrated attachment bytes, conversation Trash deduplication/Undo, Archive from All Mail/search and preserved later flags');

    service.messages.set('old-draft',message('old-draft',['DRAFT'],'<old-draft@fixture.invalid>'));
    db.insertMessage({id:'unmapped-draft',accountId:'gmail',folderPath:'Drafts',uid:777,uidValidity:88,rfcMessageId:'<old-draft@fixture.invalid>',isDraft:true,
      textBody:'Old local draft',bodyComplete:true,date:new Date().toISOString(),listSortTs:Date.now()});
    const legacyParams={accountId:'gmail',emailId:'unmapped-draft',to:'to@fixture.invalid',subject:'Legacy edit',body:'<p>First edit</p>'};
    const legacySave=success(await answer('mail:upsertDraft',legacyParams)); assert.equal(legacySave.remoteSaved,true); assert.match(legacySave.warning,/earlier Gmail draft.*retained/i);
    assert.notEqual(db.messageById('unmapped-draft').gmail_id,'old-draft');
    const savedAgain=success(await answer('mail:upsertDraft',{...legacyParams,body:'<p>Second edit</p>',draftRevision:legacySave.draftRevision}));
    assert.equal(savedAgain.remoteSaved,true); assert.match(db.messageById('unmapped-draft').text_body,/Second edit/);
    success(await answer('mail:deleteDraft',{emailId:'unmapped-draft'})); assert.equal(db.messageById('unmapped-draft'),null);
    assert.ok(service.messages.get('old-draft').labelIds.includes('DRAFT')&&!service.messages.get('old-draft').labelIds.includes('TRASH'),'unverified original draft is retained');
    console.log('gmail-engine-ok: save before legacy draft adoption, repeated Save and discard; earlier unmapped server draft is retained');

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
