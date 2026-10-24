// Independent offline regressions for dependent writes, reads and calendar edits.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const latch = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };

async function mailChecks(engine, db, remote, secrets) {
  const actions = require("../host/mail/actions");
  const clients = new Map(), accounts = [], failures = new Set(), releases = [];
  const saved = remote.withClient;
  remote.withClient = async (account, _secret, work) => {
    if (failures.delete(account.id)) throw new Error("Fixture offline before issuing a command");
    return work(clients.get(account.id));
  };
  function fixture(id) {
    accounts.push(id);
    db.insertAccount({id, email:id+"@example.test", username:id, profile:"custom", createdAt:Date.now(),
      imapHost:"imap.example.test",imapPort:993,imapTls:true,smtpHost:"smtp.example.test",smtpPort:587,smtpTls:true});
    secrets.setPassword(id,"synthetic-only");
    db.replaceFolders(id,[{path:"INBOX",name:"Inbox",wellKnown:"inbox"},{path:"Trash",name:"Trash",wellKnown:"deleteditems"},{path:"Archive",name:"Archive",wellKnown:"archive"}]);
    db.insertMessage({id,accountId:id,folderPath:"INBOX",uid:1,uidValidity:100,threadId:id,subject:"Original",from:"Old <old@example.test>",
      rfcMessageId:"<original@example.test>",date:new Date().toISOString(),listSortTs:Date.now(),unread:true});
    const server = {INBOX:new Map([[1,"selected"]]),Trash:new Map([[1,"unrelated"]]),Archive:new Map()};
    let next = 50;
    const client = {server, calls:[], validity:100, mailbox:{uidValidity:100}, locked:false,
      async getMailboxLock(folder) { this.mailbox={path:folder,uidValidity:BigInt(this.validity)};this.locked=true;return{release:()=>{this.locked=false;}}; },
      async status() { return {uidValidity:BigInt(this.validity)}; },
      async messageMove(uid, destination) {
        assert(this.locked); const folder=this.mailbox.path;
        this.calls.push({kind:"move",folder,uid:Number(uid),destination});
        if (this.onMove) await this.onMove();
        const value=server[folder].get(Number(uid));assert(value,"moving a known message");
        server[folder].delete(Number(uid));const to=++next;server[destination].set(to,value);
        if(this.loseMoveReply)throw new Error("Fixture response lost after MOVE");
        return {uidMap:new Map([[Number(uid),to]])};
      },
      async messageDelete(uid) { assert(this.locked);this.calls.push({kind:"delete",folder:this.mailbox.path,uid:Number(uid),victim:server[this.mailbox.path].get(Number(uid))});server[this.mailbox.path].delete(Number(uid)); },
      async messageFlagsAdd(uid, flags) { if(this.onFlags)await this.onFlags();this.calls.push({kind:"flags",folder:this.mailbox.path,uid:Number(uid),flags}); },
      async messageFlagsRemove(uid, flags) { this.calls.push({kind:"unflag",uid:Number(uid),flags}); },
      async *fetch(range) { this.calls.push({kind:"fetch",folder:this.mailbox.path,uid:Number(range)});if(this.onFetch)await this.onFetch();yield{uid:Number(range),flags:new Set(),envelope:{subject:"Fetched",messageId:"<fetched@example.test>"},
        source:Buffer.from("Subject: Fetched\r\nMessage-ID: <fetched@example.test>\r\n\r\nCorrect body\r\n")}; },
      async download(uid) { this.calls.push({kind:"part",folder:this.mailbox.path,uid:Number(uid)});return{content:(async function*(){yield Buffer.from("attachment");})()}; },
    };
    clients.set(id,client);return client;
  }
  const request=(channel,id,extra={})=>engine.answer(channel,[{emailId:id,...extra}]);
  const permanent=id=>request("mail:deleteBatch",id,{folderWellKnownName:"deleteditems",items:[{emailId:id}]});
  const pause=(client,key)=>{const entered=latch(),done=latch();releases.push(done.resolve);client[key]=async()=>{entered.resolve();await done.promise;};return{entered:entered.promise,release:()=>{client[key]=null;done.resolve();}};};
  try {
    // Previously: projected Trash UID 1 permanently deleted the unrelated row.
    const c=fixture("identity-move");const held=pause(c,"onMove");
    await request("mail:delete","identity-move");
    await held.entered;
    for(let repeat=0;repeat<2;repeat++)assert.equal((await permanent("identity-move")).data.outcomes[0].status,"failed");
    assert.equal((await request("mail:toggleStar","identity-move",{isStarred:true})).data.outcomes[0].status,"failed");
    held.release();
    const moved=await engine.settleActions();assert(moved.outcomes.some(o=>o.status==="completed"&&o.opId));
    assert.equal(db.messageById("identity-move").uid,51);
    await permanent("identity-move");await engine.settleActions();
    assert.equal(c.server.Trash.get(1),"unrelated");assert(!c.server.Trash.has(51));
    assert.deepEqual(c.calls.filter(x=>x.kind==="delete").map(x=>x.uid),[51]);

    const f=fixture("identity-fail");failures.add("identity-fail");
    await request("mail:delete","identity-fail");
    assert.equal((await permanent("identity-fail")).data.outcomes[0].status,"failed");
    assert((await engine.settleActions()).outcomes.some(o=>o.status==="failed"));
    assert.equal(db.messageById("identity-fail").folder_path,"INBOX");
    assert.equal((await permanent("identity-fail")).data.outcomes[0].status,"failed","stale Trash context cannot authorize permanent deletion of Inbox mail");
    await request("mail:delete","identity-fail");await engine.settleActions();
    await permanent("identity-fail");await engine.settleActions();assert.equal(f.server.Trash.get(1),"unrelated");

    const u=fixture("identity-undo");await request("mail:delete","identity-undo");const ticket=(await engine.settleActions()).opIds[0];assert(ticket);
    failures.add("identity-undo");await engine.answer("mail:undoRemoval",[{opIds:[ticket]}]);
    const failedUndo=await engine.settleActions();assert(failedUndo.opIds.includes(ticket),"known unissued Undo remains retryable in UI receipts");
    assert(db.readOp(ticket).moves.length);
    const undoHeld=pause(u,"onMove");await engine.answer("mail:undoRemoval",[{opIds:[ticket]}]);await undoHeld.entered;
    assert.equal((await permanent("identity-undo")).data.outcomes[0].status,"failed");
    undoHeld.release();await engine.settleActions();assert.equal(db.messageById("identity-undo").folder_path,"INBOX");
    const used=u.calls.length;await engine.answer("mail:undoRemoval",[{opIds:[ticket]}]);await engine.settleActions();assert.equal(u.calls.length,used,"completed Undo does not replay");

    const unknown=fixture("identity-unknown");unknown.loseMoveReply=true;
    await request("mail:delete","identity-unknown");assert((await engine.settleActions()).outcomes.some(o=>o.status==="unknown"));
    actions.resume();await engine.settleActions();
    assert.equal((await permanent("identity-unknown")).data.outcomes[0].status,"failed");
    const unknownRead=await request("mail:openEmail","identity-unknown",{full:true});assert.equal(unknownRead.error.code,"message_moving");
    assert(!unknown.calls.some(x=>x.kind==="delete"||x.kind==="fetch"));

    const flag=fixture("identity-flag");const flagHeld=pause(flag,"onFlags");
    await request("mail:markRead","identity-flag",{isRead:true});await flagHeld.entered;
    await request("mail:delete","identity-flag");flagHeld.release();
    const both=await engine.settleActions();assert.equal(both.outcomes.filter(o=>o.status==="completed").length,2,"a different intent does not supersede the read or structural confirmation");
    assert.equal(db.messageById("identity-flag").folder_path,"Trash");

    const rollback=fixture("identity-rollback");failures.add("identity-rollback");
    rollback.onMove=async()=>{const error=new Error("Fixture MOVE refused before issue");error.operationIssued=false;throw error;};
    await request("mail:markRead","identity-rollback",{isRead:true});
    await request("mail:delete","identity-rollback");
    const refused=await engine.settleActions();assert.equal(refused.outcomes.filter(o=>o.status==="failed").length,2);
    assert.equal(db.messageById("identity-rollback").folder_path,"INBOX");
    assert.equal(db.messageById("identity-rollback").unread,1,"a move rollback cannot restore an earlier failed flag projection");

    const restart=fixture("identity-restart");await request("mail:delete","identity-restart");actions.resume();await engine.settleActions();
    assert.equal(restart.calls.filter(x=>x.kind==="move").length,1,"new confirmed queued jobs survive restart without duplicate writes");
    const legacy=fixture("identity-legacy");db.updateMessage("identity-legacy",{folder_path:"Trash"});
    for(const [n,phase,folder]of[[1,"publishing","INBOX"],[2,"accepted","Trash"]])db.insertMailAction({id:"legacy-"+n,batchId:"legacy-"+n,messageId:"identity-legacy",accountId:"identity-legacy",generation:n,
      intentJson:JSON.stringify({kind:"remove",destPath:"Trash"}),priorJson:"{}",sourceJson:JSON.stringify({folderPath:folder,uid:1,uidValidity:100}),phase,createdAt:Date.now()+n});
    actions.resume();await engine.settleActions();assert.equal(legacy.calls.length,0,"legacy predicted identities are never replayed after restart");
    assert.equal((await permanent("identity-legacy")).data.outcomes[0].status,"failed");

    const body=fixture("identity-body");body.validity=200;
    for(let repeat=0;repeat<2;repeat++){
      const read=await request("mail:openEmail","identity-body",{full:true});assert.equal(read.error.code,"uid_validity_changed");
      await assert.rejects(()=>remote.readPart(body,"INBOX",1,"1",100),e=>e.code==="uid_validity_changed");
    }
    assert.equal(body.calls.length,0,"reject mismatched generation before reading body or attachment");assert.equal(body.locked,false);
    assert.equal(db.messageById("identity-body").subject,"Original");assert.equal(db.messageById("identity-body").text_body,null);
    body.validity=100;assert.equal((await request("mail:openEmail","identity-body",{full:true})).success,true);
    assert.match(db.messageById("identity-body").text_body,/Correct body/);
    db.updateMessage("identity-body",{attachments_json:JSON.stringify([{id:"2",filename:"fixture.txt"}])});body.validity=200;
    await assert.rejects(()=>engine.bytesFor({emailId:"identity-body",attachmentId:"2"}),e=>e.code==="uid_validity_changed");
    assert(!body.calls.some(x=>x.kind==="part"));

    const race=fixture("identity-read-race");const reading=pause(race,"onFetch");
    const opened=request("mail:openEmail","identity-read-race",{full:true});await reading.entered;
    await request("mail:delete","identity-read-race");reading.release();
    assert.equal((await opened).error.code,"message_moving");await engine.settleActions();
    assert.equal(db.messageById("identity-read-race").text_body,null,"in-flight old-source data cannot overwrite a projected/moved cache row");
  } finally {
    releases.forEach(release=>release());await engine.settleActions();remote.withClient=saved;
    for(const id of accounts){secrets.deletePassword(id);db.removeAccount(id);}
  }
}

async function calendarChecks() {
  const source=fs.readFileSync(path.join(__dirname,"../renderer/app.js"),"utf8");
  function extract(name){const start=source.indexOf("function "+name+"(");assert(start>=0,name);let depth=0;for(let i=source.indexOf("{",start);i<source.length;i++){
    if(source[i]==="{")depth++;if(source[i]==="}"&&--depth===0)return(source.slice(start-6,start)==="async "?"async ":"")+source.slice(start,i+1);}throw Error(name);}
  const fields=Object.fromEntries(["calendar-dialog-title","calendar-save","calendar-delete","calendar-event-title","calendar-location","calendar-description","calendar-all-day","calendar-start","calendar-end","calendar-form-status","calendar-pick"].map(id=>[id,{value:"",checked:false,classList:{remove(){},add(){}},focus(){}}]));
  fields["calendar-pick"].options=[{value:"a"},{value:"b"}];
  let owner="mail-a",closeCount=0,openCount=0,pending=null;
  const calls=[],messages=[];
  const context=vm.createContext({$:id=>fields[id],document:{querySelector:()=>({})},state:{calendarId:"a",calendarIds:["a","b"],calendarPayload:{accountId:"mail-a"}},
    calendarAccount:()=>({id:owner}),calendarCache:new Map(),saveCalendarChecks(){},loadCalendar:async()=>{},
    showStatus:text=>messages.push(text),openDialog:()=>{openCount++;},closeDialog:()=>{closeCount++;},askConfirm:async()=>({ok:true}),
    call:async(channel,payload)=>{calls.push({channel,payload});if(pending)await pending.promise;return{};}});
  const declarations=source.slice(source.indexOf('let calendarDetailKey ='),source.indexOf('function calendarDetailLine('));
  vm.runInContext(declarations+["localDateStamp","plusDays","toDateTimeLocal","calendarDraft","syncAllDayInputs","openCalendarEditor","submitCalendarEvent","deleteCalendarEvent"].map(extract).join("\n"),context);
  const run=code=>vm.runInContext(code,context);
  context.event={id:"abcde12345",calendarId:"a",title:"Original A",start:"2026-10-24T09:00:00Z",end:"2026-10-24T10:00:00Z"};
  run("openCalendarEditor(event)");assert.equal(fields["calendar-pick"].disabled,true);
  fields["calendar-pick"].value="b";pending=latch();const first=run("submitCalendarEvent({preventDefault(){}})");
  await assert.rejects(()=>run("submitCalendarEvent({preventDefault(){}})"),/still being confirmed/);
  assert.equal(calls.length,1);assert.equal(calls[0].payload.calendarId,"a");
  context.eventB={...context.event,calendarId:"b",id:"bbcde12345"};run("openCalendarEditor(eventB)");
  pending.resolve();await first;pending=null;assert.equal(closeCount,0,"an older reply cannot close a newly opened editor");
  assert.equal(run("calendarEditingIdentity.id"),"bbcde12345");
  fields["calendar-pick"].value="a";await run("submitCalendarEvent({preventDefault(){}})");
  assert.equal(calls[1].payload.calendarId,"b");assert.equal(calls[1].payload.eventId,"bbcde12345");
  run("openCalendarEditor(event)");fields["calendar-pick"].value="b";await run("deleteCalendarEvent()");
  assert.equal(calls.at(-1).payload.calendarId,"a");assert.equal(calls.at(-1).payload.eventId,"abcde12345");
  run("openCalendarEditor(event)");owner="mail-b";const before=calls.length;
  await assert.rejects(()=>run("submitCalendarEvent({preventDefault(){}})"),/account changed/);
  await assert.rejects(()=>run("deleteCalendarEvent()"),/account changed/);assert.equal(calls.length,before);
  const opened=openCount;run("openCalendarEditor(event)");assert.equal(openCount,opened,"old visible month cannot be edited under a new mailbox");
  owner="mail-a";run("openCalendarEditor(null,'2026-10-25')");assert.equal(fields["calendar-pick"].disabled,false);
  fields["calendar-pick"].value="b";fields["calendar-event-title"].value="New B";
  await run("submitCalendarEvent({preventDefault(){}})");assert.equal(calls.at(-1).channel,"calendar:createEvent");assert.equal(calls.at(-1).payload.calendarId,"b");
}

async function run() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"morrow-confirmed-identity-"));
  const keys=["MORROW_MAIL_DIR","MORROW_USER_DATA","MORROW_AI_CONFIG_DIR","MORROW_MAIL_SECRETS"],env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  Object.assign(process.env,{MORROW_MAIL_DIR:dir,MORROW_USER_DATA:dir,MORROW_AI_CONFIG_DIR:dir,MORROW_MAIL_SECRETS:"memory"});
  const engine=require("../host/mail/engine"),db=require("../host/mail/db"),remote=require("../host/mail/remote"),secrets=require("../host/mail/secrets");
  try{await engine.init();await mailChecks(engine,db,remote,secrets);await calendarChecks();}
  finally{await db.close();for(const[k,v]of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v;}fs.rmSync(dir,{recursive:true,force:true});}
  console.log("confirmed-identity-ok (dependent writes/retry/restart, body/parts, bound calendar edits)");
}
module.exports={run};
if(require.main===module)run().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
