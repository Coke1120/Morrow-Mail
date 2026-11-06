"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{spawnSync}=require("node:child_process");

async function scenario(kind){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"morrow-copy-channel-"));
  Object.assign(process.env,{MORROW_MAIL_DIR:dir,MORROW_USER_DATA:dir,MORROW_AI_CONFIG_DIR:dir,MORROW_MAIL_SECRETS:"memory"});
  delete process.env.MORROW_GOOGLE_OAUTH_JSON;delete process.env.MORROW_GOOGLE_OAUTH_FILE;
  const {createJournal,digest}=require("../host/mail/copy-recovery"),Database=require("better-sqlite3");
  const file=path.join(dir,"mailbox-copy-recovery.sqlite"),RAW=Buffer.from("From: sender@fixture.invalid\r\nTo: recipient@fixture.invalid\r\nDate: Mon, 02 Nov 2026 03:04:05 +0000\r\nSubject: Synthetic engine copy\r\n\r\nComplete body"),DATE=Date.parse("2026-11-02T03:04:05Z");
  let uploads=0;
  if(kind!=="copy"){
    const journal=createJournal(file);journal.insert({id:"old",key:digest("old"),sourceKey:digest("old-source"),destinationKey:digest("old-destination"),phase:"unknown",updatedAt:1});journal.close();
    require("../host/mail/cross-mailbox-access").createAccess=()=>({capture:params=>({sources:params.items.map(row=>({id:row.emailId,accountId:row.accountId,label:row.accountId})),destination:{accountId:"destination"}}),
      async destinations(){return {accountId:"destination",copyEnabled:true,folders:[]}},async review(){return {id:"Archive",label:"Archive"}},
      async withCopy(ticket,source,destination,work){return work({sourceBinding:digest("s"),destinationBinding:digest("d"),folderProof:digest("f"),backend:"imap",check(){},
        async readSource(){return {raw:RAW}},expected(){return {date:DATE,unread:true,starred:false}},sourceKey(){return digest(source.id)},destinationKey(){return digest("destination")},
        async upload(raw,expected,beforeSubmit){beforeSubmit();uploads++;return {accountId:"destination",folderId:"Archive",uid:1,uidValidity:1}},
        async readDestination(){return {raw:RAW}},verifyState(){}})}});
  }
  const engine=require("../host/mail/engine"),db=require("../host/mail/db"),secrets=require("../host/mail/secrets"),remote=require("../host/mail/remote");
  const {Readable}=require("node:stream");
  const savedWith=remote.withClient;
  try{
    await engine.init();
    if(kind!=="copy"){
      if(kind==="corrupt-after")assert.equal((await engine.answer("mail:crossMailboxCopy",[{action:"destinations",items:[{emailId:"new",accountId:"source"}],destinationAccountId:"destination"}])).success,true);
      const other=new Database(file);other.prepare("UPDATE mailbox_copies SET body=? WHERE id='old'").run('{"corrupt":true}');other.close();
      const replies=[];
      for(let i=0;i<3;i++){
        const reviewed=await engine.answer("mail:crossMailboxCopy",[{action:"review",items:[{emailId:"new-"+i,accountId:"source"}],destinationAccountId:"destination",folderId:"Archive"}]);replies.push(reviewed);
        if(reviewed.success)replies.push(await engine.answer("mail:crossMailboxCopy",[{action:"copy",reviewId:reviewed.data.reviewId,emailId:"new-"+i,accountId:"source"}]));
      }
      assert.equal(uploads,0,"repeated real channel requests never bypass corrupt recovery");
      assert.ok(replies.every(reply=>reply.success===false&&reply.error.code==="copy_recovery"));
      return;
    }
    for(const id of ["source","destination"]){db.insertAccount({id,email:id+"@fixture.invalid",username:id+"@fixture.invalid",profile:"custom",createdAt:1,
      imapHost:"imap.fixture.invalid",imapPort:993,imapTls:true,smtpHost:"smtp.fixture.invalid",smtpPort:465,smtpTls:true});secrets.setPassword(id,"synthetic-only");
      db.replaceFolders(id,[{path:"INBOX",name:"Inbox",wellKnown:"inbox"},{path:"Archive",name:"Archive",wellKnown:"archive"}]);}
    db.insertMessage({id:"source-message",accountId:"source",folderPath:"INBOX",uid:4,uidValidity:11,date:new Date(DATE).toISOString(),listSortTs:DATE,unread:true,bodyComplete:true,textBody:"Complete body"});
    const destination=new Map();let hold=null;
    remote.withClient=async(account,_secret,work)=>{
      const client={capabilities:new Map([["UIDPLUS",true]]),mailbox:null,
        async exec(command,attrs,options){await options.untagged?.OK?.({attributes:[{section:[{type:"ATOM",value:"UIDVALIDITY"},{type:"ATOM",value:account.id==="source"?"11":"22"}]}]});return {response:{attributes:[{section:[{type:"ATOM",value:"READ-WRITE"}]}]},next(){}}},
        async list(){await hold?.(account.id);return [{path:"Archive",name:"Archive",delimiter:"/",flags:new Set()},{path:"INBOX",name:"Inbox",delimiter:"/",flags:new Set(),specialUse:"\\Inbox"}]},
        async mailboxOpen(folder,options){await this.exec(options.readOnly?"EXAMINE":"SELECT",[],{untagged:{}});this.mailbox={path:folder,uidValidity:account.id==="source"?11:22,readOnly:!!options.readOnly,permanentFlags:new Set(["\\Seen","\\Flagged"])};return this.mailbox},
        async getMailboxLock(folder,options){await this.mailboxOpen(folder,options);return {release(){}}},
        async *fetch(uid){await hold?.(account.id);const saved=account.id==="source"?{raw:RAW,flags:[],date:DATE}:destination.get(Number(uid));if(saved)yield {uid:Number(uid),size:saved.raw.length,flags:new Set(saved.flags),internalDate:new Date(saved.date)}},
        async download(uid,_part,options){assert.equal(options.uid,true);assert.equal(this.mailbox.readOnly,true);return {content:Readable.from([account.id==="source"?RAW:destination.get(Number(uid)).raw])}},
        async append(folder,raw,flags,date){assert.equal(account.id,"destination");uploads++;destination.set(100+uploads,{raw:Buffer.from(raw),flags,date:date.getTime()});return {uid:100+uploads,uidValidity:22}},
      };
      return work(client);
    };
    const vm=require("node:vm");let bridge;
    vm.runInNewContext(fs.readFileSync(require.resolve("../renderer/preload"),"utf8"),{require:name=>{assert.equal(name,"electron");return {contextBridge:{exposeInMainWorld(name,value){if(name==="morrow")bridge=value}},ipcRenderer:{invoke:(channel,payload)=>engine.answer(channel,[payload]),on(){},removeListener(){}}}}});
    assert.ok(bridge);
    const params=()=>{const views=engine.accountViews(),source=views.find(row=>row.id==="source"),target=views.find(row=>row.id==="destination"),policy=require("../shared/mail-context-owner");return {items:[{emailId:"source-message",accountId:"source"}],contextOwners:[policy.capture(source,{id:"source-message",accountId:"source",folderId:"INBOX"})],destinationAccountId:"destination",destinationOwner:{accountId:"destination",bodyEpoch:target.bodyEpoch,connection:policy.connection(target)},folderId:"Archive"}};
    const reviewed=await bridge.invoke("mail:crossMailboxCopy",{action:"review",...params()});assert.equal(reviewed.success,true,JSON.stringify(reviewed.error));
    const result=await bridge.invoke("mail:crossMailboxCopy",{action:"copy",reviewId:reviewed.data.reviewId,emailId:"source-message",accountId:"source"});assert.equal(result.success,true,JSON.stringify(result.error));assert.equal(result.data.status,"copied");assert.equal(uploads,1);
    assert.equal(db.messageById("source-message").folder_path,"INBOX");assert.equal(db.messageById("source-message").unread,1);
    const second=await bridge.invoke("mail:crossMailboxCopy",{action:"review",...params()});
    const reuse=await bridge.invoke("mail:crossMailboxCopy",{action:"copy",reviewId:second.data.reviewId,emailId:"source-message",accountId:"source"});assert.equal(reuse.data.status,"reused");assert.equal(uploads,1);
    const stale=await bridge.invoke("mail:crossMailboxCopy",{action:"review",...params()});
    hold=async id=>{if(id==="source")db.updateAccountLogin("destination",{username:"changed@fixture.invalid",profile:"custom",authKind:"password",imapHost:"imap.fixture.invalid",imapPort:993,imapTls:true,smtpHost:"smtp.fixture.invalid",smtpPort:465,smtpTls:true})};
    const denied=await bridge.invoke("mail:crossMailboxCopy",{action:"copy",reviewId:stale.data.reviewId,emailId:"source-message",accountId:"source"});assert.equal(denied.success,false);assert.equal(uploads,1);
    const moveGate=await bridge.invoke("mail:crossMailboxMove",{action:"capabilities"});
    assert.equal(moveGate.success,true);assert.equal(moveGate.data.moveEnabled,false,"the prepared Move channel cannot enable source removal");
  }finally{remote.withClient=savedWith;engine.closeMailboxCopyForTest();engine.closeLocalArchiveForTest();db.close();fs.rmSync(dir,{recursive:true,force:true})}
}

if(process.argv[2]==="fixture")scenario(process.argv[3]).then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1)});
else{
  const {test}=require("node:test");
  for(const kind of ["copy","corrupt-start","corrupt-after"])test(`actual engine/preload ${kind} preserves safe Copy admission`,()=>{
    const child=spawnSync(process.execPath,[__filename,"fixture",kind],{encoding:"utf8",timeout:20000});assert.equal(child.status,0,child.stderr||child.stdout);
  });
}
