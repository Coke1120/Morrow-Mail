// Real accountView/SQLite admission; memory secrets and synthetic transports only.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const ownerPolicy = require("../shared/mail-context-owner");
const { renderer } = require("./check-ux-workflows");

function barrier() {
  let enter,release;
  const active=new Promise(resolve=>{enter=resolve}); const blocked=new Promise(resolve=>{release=resolve});
  return {active,release,async wait(){enter();await blocked}};
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-context-owner-"));
  const keys = ["MORROW_MAIL_DIR", "MORROW_MAIL_SECRETS", "MORROW_USER_DATA", "MORROW_AI_CONFIG_DIR", "MORROW_GOOGLE_OAUTH_JSON", "MORROW_GOOGLE_OAUTH_FILE"];
  const savedEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.MORROW_MAIL_DIR = dir; process.env.MORROW_MAIL_SECRETS = "memory";
  process.env.MORROW_USER_DATA = dir; process.env.MORROW_AI_CONFIG_DIR = dir;
  delete process.env.MORROW_GOOGLE_OAUTH_JSON; delete process.env.MORROW_GOOGLE_OAUTH_FILE;
  const actions = require("../host/mail/actions");
  const install = actions.install;
  let actionHooks;
  actions.install = hooks => { actionHooks=hooks; return install(hooks); };
  let engine;
  try { engine=require("../host/mail/engine"); } finally { actions.install=install; }
  assert.ok(actionHooks,"fixture requires a fresh engine so it can gate the real publication lane");
  const db = require("../host/mail/db"), secrets = require("../host/mail/secrets");
  const remote = require("../host/mail/remote"), sidecar = require("../host/mail/sidecar");
  const savedRemote = Object.fromEntries(["withClient", "listFolderRecords", "verifySmtp", "openIdleClient", "searchUids", "changeFlags", "moveUid", "fetchArchiveSource"].map(key => [key, remote[key]]));
  const savedRead = secrets.getPasswordAsync, savedSidecar = sidecar.answer;
  let secretReads = 0, stores = 0, copies = 0, sidecarCalls = 0;
  const folders = [{path:"INBOX",name:"Inbox",wellKnown:"inbox"}, {path:"Archive",name:"Archive",wellKnown:"archive"}, {path:"Trash",name:"Trash",wellKnown:"deleteditems"}];
  const login = { username:"owner@fixture.invalid",profile:"custom",authKind:"password",imapHost:"imap.fixture.invalid",imapPort:993,imapTls:true,smtpHost:"smtp.fixture.invalid",smtpPort:465,smtpTls:true };
  const message = { id:"source",accountId:"owner",folderId:"INBOX",subject:"Synthetic owner fence",unread:true };
  const view = () => engine.accountViews().find(account => account.id === "owner");
  const capture = () => ownerPolicy.capture(view(), message);
  const reconnectBackground = [];
  const releases = [];
  let pendingReconnect = null;
  const reconnectWork = async () => {
    // The synthetic listing retains source paths but omits the Inbox role to
    // avoid a sync. Reconnect still commits real credentials and bodyEpoch.
    // Reconnect schedules a separate current-generation sync after 200 ms.
    // Capture that unrelated job instead of making keychain-read assertions
    // depend on whether Windows/SQLite has consumed 200 ms. Publisher timers
    // and the mailbox lane remain real and are controlled by explicit gates.
    const nativeTimeout=global.setTimeout;
    const scheduledBefore=reconnectBackground.length;
    global.setTimeout=(work,delay,...args)=>{
      if(delay===200){reconnectBackground.push(()=>work(...args));return {unref(){return this}};}
      return nativeTimeout(work,delay,...args);
    };
    let result;
    try { result = await engine.answer("mail:connectImapSmtp", [{email:"owner@fixture.invalid",expectedAccountId:"owner",username:login.username,
      profile:"custom",password:"synthetic-memory-only",custom:{imap:{host:login.imapHost,port:login.imapPort,tls:true},smtp:{host:login.smtpHost,port:login.smtpPort,tls:true}}}]); }
    finally { global.setTimeout=nativeTimeout; }
    assert.equal(result.success, true, result.error?.message);
    assert.equal(reconnectBackground.length,scheduledBefore+1,"fixture captures exactly the post-reconnect background job");
    db.replaceFolders("owner", folders);
  };
  const reconnect = () => {
    const work=reconnectWork(); pendingReconnect=work;
    return work.finally(()=>{if(pendingReconnect===work) pendingReconnect=null});
  };
  try {
    remote.withClient = async (_account, _secret, work) => work({});
    remote.listFolderRecords = async () => ({folders:folders.map(folder=>({...folder,wellKnown:folder.path==='INBOX' ? null : folder.wellKnown})),delimiter:"/"}); remote.verifySmtp = async () => {};
    remote.searchUids = async () => { throw new Error("Synthetic background sync blocked"); };
    remote.openIdleClient = async () => { throw new Error("Synthetic IDLE blocked"); };
    remote.changeFlags = async (_client,_path,_uid,_add,_remove,_validity,_id,options) => { options?.beforeSubmit?.(); stores++; };
    remote.moveUid = async () => { stores++; throw new Error("Unexpected synthetic move"); };
    remote.fetchArchiveSource = async () => { copies++; throw new Error("Unexpected synthetic download"); };
    secrets.getPasswordAsync = async (...args) => { secretReads++; return savedRead(...args); };
    await engine.init();
    for (const id of ["owner", "other"]) {
      db.insertAccount({id,email:id === "owner" ? "owner@fixture.invalid" : "other@fixture.invalid",...login,createdAt:1});
      secrets.setPassword(id,"synthetic-memory-only"); db.replaceFolders(id,folders);
      db.insertMessage({id:id === "owner" ? "source" : "other-source",accountId:id,folderPath:"INBOX",uid:4,uidValidity:1,
        date:"2026-11-01T00:00:00Z",listSortTs:1,unread:true});
    }
    const originalView = view();
    assert.equal(originalView.createdAt, undefined); assert.equal(originalView.username, undefined);
    assert.equal(originalView.imapHost, undefined); assert.equal(originalView.imapPort, undefined);
    assert.equal(originalView.imapUsername, login.username);
    assert.deepEqual(originalView.imapSmtpCustom.imap,{host:login.imapHost,port:993,tls:true});
    assert.equal(Number.isSafeInteger(originalView.bodyEpoch), true);

    // Exercise actual production-shaped views in the renderer, including each
    // changed field that the old invented createdAt/username proof missed.
    for (const mutation of [
      "account.imapUsername='different@fixture.invalid'", "account.imapSmtpCustom.imap.host='other.fixture.invalid'",
      "account.imapSmtpCustom.imap.port=1993", "account.imapSmtpCustom.imap.tls=false",
      "account.authKind='oauth2'", "account.mailTransport='gmail_api'", "account.bodyEpoch++",
    ]) {
      const ui = renderer({fixtureAccounts:JSON.parse(JSON.stringify(engine.accountViews())),fixtureMessage:message});
      ui.run(`state.accounts=fixtureAccounts; state.accountId='other'; globalThis.review=contextMessages([fixtureMessage]);
        globalThis.submissions=[]; queueBulkRemoval=(...args)=>submissions.push(args); refusePaused=()=>false;
        askConfirm=()=>new Promise(resolve=>globalThis.confirmLater=resolve);`);
      const waiting = ui.run("contextRemoval(review.rows,'trash',review.current)");
      ui.run(`{const account=state.accounts.find(row=>row.id==='owner'); ${mutation};} confirmLater({ok:true});`);
      await assert.rejects(waiting,/mailbox changed while confirmation/);
      assert.equal(ui.run("submissions.length"),0,mutation);
    }
    const ui = renderer({fixtureAccounts:engine.accountViews(),fixtureMessage:message});
    ui.run("state.accounts=fixtureAccounts; globalThis.review=contextMessages([fixtureMessage]); state.accounts.find(row=>row.id==='owner').bodyVersion++");
    assert.equal(ui.run("review.current()"),true,"unrelated body-cache fills are not reconnects");
    assert.equal(ui.run("review.rows[0].contextOwner.connection"),capture().connection);
    for (const action of ["read","unread","star","unstar"]) {
      const calls = ui.run(`contextOwnedCalls(bulkFlagCalls(review.rows,${JSON.stringify(action)}),review.rows)`);
      assert.equal(calls[0].params.contextOwners[0].bodyEpoch,originalView.bodyEpoch);
      assert.equal(calls[0].params.contextOwners[0].emailId,"source");
    }
    for (const expression of [
      "contextOwnedCalls(bulkMoveCalls(review.rows,{kind:'imap',id:'Archive',accountId:'owner'}),review.rows)",
      "contextOwnedCalls(labelEditCalls([{email:review.rows[0],addLabelIds:['synthetic-label'],removeLabelIds:[]}]),review.rows)",
      "[{params:contextOwnedParams({emailId:'source',accountId:'owner',folderId:'local-folder:archive',mode:'copy'},review.rows)}]",
    ]) assert.equal(ui.run(expression)[0].params.contextOwners[0].connection,capture().connection);

    const stale = capture();
    await reconnect();
    assert.ok(view().bodyEpoch > stale.bodyEpoch,"same-login reconnect advances the owner token");
    sidecar.answer = async () => { sidecarCalls++; throw new Error("Stale context reached a provider handler"); };
    const specs = [
      ["mail:markRead",{emailId:"source",accountId:"owner",isRead:true}],
      ["mail:markReadBatch",{items:[{emailId:"source",accountId:"owner"}],isRead:true}],
      ["mail:toggleStar",{emailId:"source",accountId:"owner",isStarred:true}],
      ["mail:toggleStarBatch",{items:[{emailId:"source",accountId:"owner"}],isStarred:true}],
      ["mail:archive",{emailId:"source",accountId:"owner"}],
      ["mail:delete",{emailId:"source",accountId:"owner",moveToTrashOnly:true}],
      ["mail:moveToFolder",{emailId:"source",accountId:"owner",targetFolderId:"Archive"}],
      ["mail:modifyMessageLabels",{emailId:"source",accountId:"owner",addLabelIds:["synthetic-label"]}],
      ["mail:moveProviderMessage",{emailId:"source",accountId:"owner",destinationId:"synthetic-folder"}],
      ["mail:transferToLocal",{emailId:"source",accountId:"owner",folderId:"local-folder:archive",mode:"move"}],
    ];
    secretReads=0;
    for (const [channel,params] of specs) {
      const result=await engine.answer(channel,[{...params,contextOwners:[stale]}]);
      assert.equal(result.success,false,channel); assert.equal(result.error.code,"account_removed",channel);
    }
    assert.equal(secretReads,0); assert.equal(sidecarCalls,0); assert.equal(stores,0); assert.equal(copies,0);
    assert.equal(db.mailActionsForMessage("source").length,0,"stale account snapshots cannot journal optimistic actions");
    const otherOwner=ownerPolicy.capture(engine.accountViews().find(account=>account.id==='other'),{id:'other-source',accountId:'other',folderId:'INBOX'});
    const partial=await engine.answer("mail:deleteBatch",[{items:[{emailId:'other-source',accountId:'other'},{emailId:'source',accountId:'owner'}],contextOwners:[otherOwner,stale],moveToTrashOnly:true}]);
    assert.equal(partial.success,false); assert.equal(db.mailActionsForMessage('other-source').length,0);
    assert.equal(db.messageById('other-source').folder_path,'INBOX');
    const current=capture();
    const wrong=await engine.answer('mail:markRead',[{emailId:'source',accountId:'other',isRead:true,contextOwners:[current]}]);
    assert.equal(wrong.success,false); assert.equal(wrong.error.code,'invalid_context');
    db.updateMessage('source',{folder_path:'Trash'});
    const moved=await engine.answer('mail:delete',[{emailId:'source',accountId:'owner',moveToTrashOnly:true,contextOwners:[current]}]);
    assert.equal(moved.success,false); assert.equal(db.mailActionsForMessage('source').length,0);
    db.updateMessage('source',{folder_path:'INBOX'});
    db.updateAccountLogin('owner',{...login,imapPort:1993});
    const portChanged=await engine.answer('mail:toggleStar',[{emailId:'source',accountId:'owner',isStarred:true,contextOwners:[current]}]);
    assert.equal(portChanged.success,false,"host admission independently compares exposed connection fields");
    db.updateAccountLogin('owner',login);

    // Hold actual publication before credentials; do not assume asynchronous
    // reconnect finishes before a zero-delay publisher timer can run.
    const publication=barrier();
    releases.push(publication.release);
    actions.install({...actionHooks,exclusive:(accountId,work)=>actionHooks.exclusive(accountId,async()=>{await publication.wait();return work()})});
    assert.equal(db.messageById('source')?.folder_path,'INBOX');
    assert.equal(capture().connection,ownerPolicy.connection(view()));
    const queuedOwner=capture(); secretReads=0;
    const accepted=await engine.answer('mail:toggleStar',[{emailId:'source',accountId:'owner',isStarred:true,contextOwners:[capture()]}]);
    assert.equal(accepted.success,true,JSON.stringify(accepted)); assert.equal(accepted.data.pending.length,1);
    assert.ok(JSON.parse(db.mailActionsForMessage('source').at(-1).intent_json).contextOwner);
    const publishingQueued=engine.settleActions(); await publication.active;
    assert.equal(secretReads,0,"publication is held before any credential read");
    assert.equal(db.mailActionsForMessage('source').at(-1).phase,'accepted');
    await reconnect();
    assert.ok(view().bodyEpoch>queuedOwner.bodyEpoch,"reconnect committed before publication resumes");
    assert.equal(secretReads,0,"reconnect did not run the held reviewed action");
    publication.release();
    const settled=await publishingQueued;
    assert.equal(settled.outcomes.find(row=>row.id==='source').status,'failed');
    assert.equal(secretReads,0); assert.equal(stores,0); assert.equal(db.messageById('source').starred,0);
    actions.install(actionHooks);

    // The complementary ordering is valid: while SMTP verification is still
    // pending, the old owner has not expired and its action may finish. Prove
    // that explicitly instead of treating any pre-commit completion as stale.
    const verification=barrier();
    releases.push(verification.release);
    const verifySmtp=remote.verifySmtp;
    remote.verifySmtp=()=>verification.wait();
    const beforeCommit=capture(); const reconnecting=reconnect(); await verification.active;
    assert.equal(view().bodyEpoch,beforeCommit.bodyEpoch);
    const valid=await engine.answer('mail:toggleStar',[{emailId:'source',accountId:'owner',isStarred:true,contextOwners:[beforeCommit]}]);
    assert.equal(valid.success,true);
    const currentSettled=await engine.settleActions();
    assert.equal(currentSettled.outcomes.find(row=>row.id==='source').status,'completed');
    assert.equal(secretReads,1,"exactly one credential read belongs to the explicitly still-current owner");
    assert.equal(stores,1,"only this still-current synthetic action submits");
    assert.equal(view().bodyEpoch,beforeCommit.bodyEpoch);
    verification.release(); await reconnecting; remote.verifySmtp=verifySmtp;
    assert.ok(view().bodyEpoch>beforeCommit.bodyEpoch);
    db.updateMessage('source',{starred:0}); secretReads=0; stores=0;

    // A connection edit while secure storage is pending cannot reach STORE.
    let enter,release;
    const entered=new Promise(resolve=>{enter=resolve}); const held=new Promise(resolve=>{release=resolve});
    releases.push(release);
    secrets.getPasswordAsync=async(...args)=>{secretReads++;enter();await held;return savedRead(...args)};
    const waiting=await engine.answer('mail:toggleStar',[{emailId:'source',accountId:'owner',isStarred:true,contextOwners:[capture()]}]);
    assert.equal(waiting.success,true);
    const publishing=engine.settleActions(); await entered;
    assert.equal(secretReads,1,"one read started while the reviewed connection was current");
    db.updateAccountLogin('owner',{...login,imapPort:1993}); release();
    const afterWait=await publishing;
    assert.equal(afterWait.outcomes.find(row=>row.id==='source').status,'failed'); assert.equal(stores,0);
    assert.equal(secretReads,1,"no additional credential read occurs after the connection edit");
    db.updateAccountLogin('owner',login); secrets.getPasswordAsync=savedRead;
    sidecar.answer=savedSidecar;

    // Transfer and provider-grant requests keep the owner check while secure
    // storage is pending; a same-login reconnect invalidates the old review.
    for (const [channel,params] of [
      ['mail:transferToLocal',{emailId:'source',accountId:'owner',folderId:'local-folder:archive',mode:'move'}],
      ['mail:modifyMessageLabels',{emailId:'source',accountId:'owner',addLabelIds:['synthetic-label']}],
      ['mail:moveProviderMessage',{emailId:'source',accountId:'owner',destinationId:'synthetic-folder'}],
    ]) {
      let enteredRead,releaseRead;
      const active=new Promise(resolve=>{enteredRead=resolve}); const blocked=new Promise(resolve=>{releaseRead=resolve});
      releases.push(releaseRead);
      secrets.getPasswordAsync=async(...args)=>{enteredRead();await blocked;return savedRead(...args)};
      const request=engine.answer(channel,[{...params,contextOwners:[capture()]}]);
      await active; await reconnect(); releaseRead();
      const result=await request;
      assert.equal(result.success,false,channel); assert.match(result.error.message,/connection changed/i,channel);
      assert.equal(copies,0); assert.equal(stores,0);
      secrets.getPasswordAsync=savedRead;
    }
    const interrupted=engine.answer('mail:toggleStar',[{emailId:'source',accountId:'owner',isStarred:true,contextOwners:[capture()]}]);
    assert.equal(interrupted.success,true); assert.equal(interrupted.data.pending.length,1);
    require('../host/mail/actions').resume();
    const resumed=await engine.settleActions();
    assert.equal(resumed.outcomes.find(row=>row.id==='source').status,'not_attempted','restart cannot reauthorize an unsubmitted context action');
    assert.equal(db.messageById('source').starred,0); assert.equal(stores,0);
    console.log('message-context-owner-ok: production accountView fields, deterministic pre/post-commit publication gates, zero stale credential reads/submissions, captured account/source checks and credential-await race; synthetic transports only');
  } finally {
    for(const release of releases) release();
    await pendingReconnect?.catch(()=>{});
    actions.install(actionHooks);
    secrets.getPasswordAsync=savedRead; sidecar.answer=savedSidecar;
    await engine.settleActions().catch(()=>{}); engine.stopIdle();
    Object.assign(remote,savedRemote); engine.closeLocalArchiveForTest(); db.close();
    for (const [key,value] of Object.entries(savedEnv)) { if(value===undefined) delete process.env[key]; else process.env[key]=value; }
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
module.exports={run};
if(require.main===module) run().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1)});
