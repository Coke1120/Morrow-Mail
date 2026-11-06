"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{Readable}=require("node:stream");
const {createAccess}=require("../host/mail/cross-mailbox-access"),{createService}=require("../host/mail/cross-mailbox-copy");
const {createJournal,digest}=require("../host/mail/copy-recovery"),ownerPolicy=require("../shared/mail-context-owner");
const {createGmailMailApi,MAIL_SCOPES}=require("../host/mail/gmail-mail-api");
const RAW=Buffer.from("From: sender@fixture.invalid\r\nTo: owner@fixture.invalid\r\nDate: Mon, 02 Nov 2026 03:04:05 +0000\r\nSubject: Synthetic protocol\r\nMessage-ID: <duplicate@fixture.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSynthetic body");
const DATE=Date.parse("2026-11-02T03:04:05Z");
const bad=()=>Object.assign(new Error("Synthetic connection changed"),{code:"copy_conflict",operationIssued:false});

function fixture(t,options={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"morrow-copy-protocol-"));
  const ledger=createJournal(path.join(dir,"copies.sqlite"));
  t.after(()=>{ledger.close();fs.rmSync(dir,{recursive:true,force:true})});
  const accounts=new Map(["source","destination"].map(id=>[id,{id,email:id+"@fixture.invalid",username:id+"@fixture.invalid",created_at:1,
    profile:options[id+"Gmail"]||options[id+"LegacyGmail"]?"gmail":"custom",auth_kind:options[id+"Gmail"]||options[id+"LegacyGmail"]?"oauth2":"password",mail_transport:options[id+"Gmail"]?"gmail_api":"imap",
    imap_host:"imap.fixture.invalid",imap_port:993,imap_tls:1,gmail_generation:1,epoch:1,revision:1}]));
  const row={id:"source-message",account_id:"source",folder_path:"INBOX",uid:4,uid_validity:11,gmail_id:options.sourceGmail?"original-provider-id":null,
    rfc_message_id:"<duplicate@fixture.invalid>",draft_pending:0,is_draft:0,unread:1,starred:1,date_iso:new Date(DATE).toISOString(),date_source:"header"};
  const rows=new Map([[row.id,row]]);
  const cacheFolder={path:"INBOX",uid_validity:11,well_known:"inbox",provider_id:null};
  const events=[],uploaded=new Map();let hook=async()=>{},googleClient="synthetic-client";
  const state={uploads:0,sourceDownloads:0,sourceWrites:0,uidValidity:22,uidPlus:true,readOnly:false,partial:false,missingSize:false,
    flags:new Set(["\\Flagged"]),date:DATE,ack:true,ackValidity:null,wrongRaw:false,metadata:[],folderFlags:[],parentFlags:[],permanentFlags:new Set(["\\Seen","\\Flagged"])};
  const publicAccount=account=>({id:account.id,email:account.email,imapUsername:account.username,authKind:account.auth_kind,imapSmtpProfile:account.profile,
    mailTransport:account.mail_transport,bodyEpoch:account.epoch,...(account.profile==="custom"?{imapSmtpCustom:{imap:{host:account.imap_host,port:account.imap_port,tls:!!account.imap_tls}}}:{})});
  const owner=id=>{const account=accounts.get(id);return account&&{binding:digest(JSON.stringify([account.id,account.created_at,account.username,account.imap_host,account.imap_port,account.imap_tls,account.mail_transport,account.mail_transport==='gmail_api'?googleClient:null])),generation:account.epoch,revision:account.revision}};
  const db={accountById:id=>accounts.get(id),messageById:id=>rows.get(id),folderByPath:(id,folder)=>folder==="INBOX"?(id==="source"?cacheFolder:{...cacheFolder,uid_validity:state.uidValidity}):null};
  const queues=new Map();
  const exclusive=async(id,work)=>{const prior=queues.get(id)||Promise.resolve();let release;const held=new Promise(resolve=>{release=resolve});queues.set(id,held);await prior;try{return await work()}finally{release();if(queues.get(id)===held)queues.delete(id)}};
  const clients={};
  function client(role){
    const transport={capabilities:new Map(state.uidPlus?[["UIDPLUS",true]]:[]),mailbox:null,
      async list(){events.push("list:"+role);await hook("list:"+role);return [{path:"Parent",name:"Parent",delimiter:"/",flags:new Set(state.parentFlags)},
        {path:"Parent/Archive",name:"Archive",delimiter:"/",flags:new Set(state.folderFlags),readOnly:state.readOnly},
        {path:"INBOX",name:"Inbox",delimiter:"/",specialUse:"\\Inbox",flags:new Set()},
        {path:"Trash",name:"Trash",delimiter:"/",specialUse:"\\Trash",flags:new Set()},
        {path:"Container",name:"Container",delimiter:"/",flags:new Set(["\\Noselect"])}]},
      async exec(command,attributes,options){if(options.untagged?.OK)await options.untagged.OK({attributes:[{section:[{type:'ATOM',value:'UIDVALIDITY'},{type:'ATOM',value:String(role==='source'?11:state.uidValidity)}]}]});return {response:{attributes:[{section:[{type:'ATOM',value:'READ-WRITE'}]}]},next(){}}},
      async mailboxOpen(folder,opts){events.push("select:"+role);await hook("select:"+role);await transport.exec(opts.readOnly?'EXAMINE':'SELECT',[],{untagged:{}});transport.mailbox={path:folder,uidValidity:role==="source"?11:state.uidValidity,
        readOnly:opts.readOnly||state.readOnly,permanentFlags:state.permanentFlags};return transport.mailbox},
      async getMailboxLock(folder,opts){await transport.mailboxOpen(folder,opts);return {release(){}}},
      async *fetch(uid){events.push("fetch:"+role);await hook("fetch:"+role);const saved=role==="source"?{raw:RAW,flags:new Set(["\\Flagged"]),date:DATE}:uploaded.get(Number(uid));
        if(saved)yield {uid:Number(uid),size:state.missingSize?undefined:saved.raw.length,flags:saved.flags,internalDate:new Date(saved.date)}},
      async download(uid,part,opts){events.push("download:"+role);await hook("download:"+role);assert.equal(part,undefined);assert.equal(opts.uid,true);assert.equal(transport.mailbox.readOnly,true,"full MIME reads use EXAMINE/PEEK semantics");
        const saved=role==="source"?{raw:RAW}:uploaded.get(Number(uid));if(role==="source")state.sourceDownloads++;
        return {content:Readable.from([state.partial&&role==="source"?saved.raw.subarray(0,20):saved.raw])}},
      async append(folder,raw,flags,date){events.push("append:"+role);assert.equal(role,"destination");state.uploads++;
        await hook("append:"+role);const uid=100+state.uploads;
        uploaded.set(uid,{raw:state.wrongRaw?Buffer.from(raw.toString().replace("Synthetic body","Different body")):Buffer.from(raw),flags:new Set(flags),date:date.getTime()});
        if(!state.ack)return {uidValidity:state.uidValidity};return {uid,uidValidity:state.ackValidity||state.uidValidity}},
    };
    if(options[role+"Gmail"]){
      transport.gmail={alive(){},async resolve(){await hook("resolve:"+role);return {provider_id:"original-provider-id"}},api:{
        async labels(){events.push("labels:"+role);await hook("list:"+role);return [{id:"Label_archive",name:"Parent/Archive",type:"user",editable:true},{id:"INBOX",name:"Inbox",type:"system",editable:false},{id:"TRASH",name:"Trash",type:"system",editable:false}]},
        async raw(id){events.push("raw:"+role);await hook("raw:"+role);const saved=role==="source"?{raw:RAW,flags:new Set(["\\Flagged"]),date:DATE}:uploaded.get(id);
          return {id,source:saved.raw,internalDate:String(saved.date),labelIds:role==="source"?["INBOX","UNREAD","STARRED"]:saved.labels}},
        async getMessage(id){await hook("full:"+role);return {id,labelIds:["INBOX","UNREAD","STARRED"],payload:{mimeType:"text/plain",body:{size:14,data:Buffer.from("Synthetic body").toString("base64url")}}}},
        async attachment(){throw new Error("Unexpected synthetic attachment read")},
        async importMessage(raw,labels,{beforeSubmit}){await hook("token:"+role);beforeSubmit();state.uploads++;const id="imported-"+state.uploads;
          uploaded.set(id,{raw:state.wrongRaw?Buffer.from(raw.toString().replace("Synthetic body","Different body")):Buffer.from(raw),labels,date:DATE});await hook("import:"+role);return {id}},
        async send(){throw new Error("Copy must never send")},async saveDraft(){throw new Error("Copy must never upload a draft")},
      }};
    }
    clients[role]=transport;return transport;
  }
  const access=createAccess({db,publicAccount,owner,googleClient:()=>googleClient,bindAccount(account){if(!account)throw bad();return {...account}},
    assertAccountCurrent(account){const current=accounts.get(account.id);if(!current||current.created_at!==account.created_at||current.epoch!==account.epoch)throw bad()},
    async secretFor(account){events.push("secret:"+account.id);await hook("secret:"+account.id);return {token:"synthetic-only",revision:account.revision}},
    async withMailClient(account,_secret,work){events.push("connect:"+account.id);await hook("connect:"+account.id);return work(client(account.id))},exclusive,
    identityReady(){},localArchive(){throw new Error("Local source not selected in this fixture")}});
  const service=createService({access,journal:ledger});
  const params=()=>({items:[{emailId:row.id,accountId:"source"}],contextOwners:[ownerPolicy.capture(publicAccount(accounts.get("source")),{id:row.id,accountId:"source",folderId:row.folder_path})],
    destinationAccountId:"destination",destinationOwner:{accountId:"destination",bodyEpoch:accounts.get("destination").epoch,connection:ownerPolicy.connection(publicAccount(accounts.get("destination")))},folderId:options.destinationGmail?"Label_archive":"Parent/Archive"});
  const review=()=>service.answer({action:"review",...params()});
  const copy=reviewed=>service.answer({action:"copy",reviewId:reviewed.reviewId,emailId:row.id,accountId:"source"});
  return {state,accounts,row,rows,cacheFolder,events,clients,ledger,service,params,review,copy,access,publicAccount,
    setHook(fn){hook=fn},clientChange(){googleClient="different-client"}};
}

for(const [sourceGmail,destinationGmail]of [[false,false],[true,false],[false,true],[true,true]]){
  test(`full source ${sourceGmail?"Gmail":"IMAP"} -> destination ${destinationGmail?"Gmail import":"IMAP APPEND"} verifies without source writes`,async t=>{
    const f=fixture(t,{sourceGmail,destinationGmail}),review=await f.review(),result=await f.copy(review);
    assert.equal(result.status,"copied");assert.equal(result.sourceRetained,true);assert.equal(f.state.uploads,1);assert.equal(f.row.unread,1);assert.equal(f.row.starred,1);
    assert.equal((await f.copy(await f.review())).status,"reused");assert.equal(f.state.uploads,1);
  });
}
for(const stage of ["secret:destination","connect:destination","secret:source","connect:source","download:source"]){
  for(const side of ["source","destination"]){
    test(`${side} incarnation/revision change at ${stage} prevents upload`,async t=>{
      const f=fixture(t),review=await f.review();f.setHook(at=>{if(at===stage)f.accounts.get(side).revision++});
      await assert.rejects(f.copy(review),/changed/i);assert.equal(f.state.uploads,0);assert.equal(f.ledger.list().some(row=>row.phase==="unknown"),false);
    });
  }
}
test("missing UIDPLUS, protected/NoSelect and read-only destinations remain unavailable",async t=>{
  const f=fixture(t);f.state.uidPlus=false;let listing=await f.service.answer({action:"destinations",...f.params()});
  assert.equal(listing.copyEnabled,false);assert.ok(listing.folders.every(folder=>!folder.enabled));
  f.state.uidPlus=true;listing=await f.service.answer({action:"destinations",...f.params()});
  assert.equal(listing.folders.find(folder=>folder.id==="Trash").enabled,false);assert.equal(listing.folders.find(folder=>folder.id==="Container").enabled,false);
  f.state.readOnly=true;await assert.rejects(f.review(),/read-only|protected/);assert.equal(f.state.uploads,0);
});
for(const kind of ["UIDVALIDITY","parent metadata","NoSelect","readonly"]){
  test(`destination ${kind} changes after review cause zero APPENDs`,async t=>{
    const f=fixture(t),review=await f.review();
    if(kind==="UIDVALIDITY")f.state.uidValidity++;if(kind==="parent metadata")f.state.parentFlags=["\\Noinferiors"];
    if(kind==="NoSelect")f.state.folderFlags=["\\Noselect"];if(kind==="readonly")f.state.readOnly=true;
    await assert.rejects(f.copy(review),/changed|selectable|read-only/i);assert.equal(f.state.uploads,0);
  });
}
for(const kind of ["partial","missingSize","flags","date"]){
  test(`unprovable source ${kind} is retained without uploading`,async t=>{
    const f=fixture(t),review=await f.review();
    if(kind==="partial")f.state.partial=true;if(kind==="missingSize")f.state.missingSize=true;
    if(kind==="flags")f.row.unread=0;if(kind==="date")f.setHook(at=>{if(at==="download:source")f.row.date_iso="2025-01-01T00:00:00Z"});
    await assert.rejects(f.copy(review));assert.equal(f.state.uploads,0);
  });
}
for(const kind of ["missing APPENDUID","changed APPENDUID UIDVALIDITY","mismatched destination raw"]){
  test(`${kind} yields uncertainty and never repeats APPEND`,async t=>{
    const f=fixture(t);if(kind==="missing APPENDUID")f.state.ack=false;if(kind==="changed APPENDUID UIDVALIDITY")f.state.ackValidity=999;if(kind==="mismatched destination raw")f.state.wrongRaw=true;
    assert.equal((await f.copy(await f.review())).status,"unknown");assert.equal((await f.copy(await f.review())).status,"unknown");assert.equal(f.state.uploads,1);
  });
}
test("Google client change during source read retires both-account ticket before destination import",async t=>{
  const f=fixture(t,{sourceGmail:true,destinationGmail:true}),review=await f.review();f.setHook(at=>{if(at==="full:source")f.clientChange()});
  await assert.rejects(f.copy(review),/changed/);assert.equal(f.state.uploads,0);
});
for(const side of ["source","destination"]){
  test(`legacy Gmail OAuth IMAP ${side} fences Desktop client changes after credentials`,async t=>{
    const f=fixture(t,{[side+"LegacyGmail"]:true}),review=await f.review();
    f.setHook(at=>{if(at==="download:source")f.clientChange()});
    await assert.rejects(f.copy(review),/changed/);assert.equal(f.state.uploads,0);
  });
}
test("actual pinned ImapFlow SELECT parser cannot discard UIDNOTSTICKY before Copy rejects it",async()=>{
  const {EventEmitter}=require("node:events");
  const select=require(path.join(path.dirname(require.resolve("imapflow")),"commands/select.js")).default;
  const {persistentSelection}=require("../host/mail/copy-imap-selection");
  for(const marker of ["OK","NO","tagged",null]){
    const transport=new EventEmitter();
    Object.assign(transport,{states:{AUTHENTICATED:2,SELECTED:3},state:2,folders:new Map([["Archive",{path:"Archive",delimiter:"/"}]]),enabled:new Set(),capabilities:new Map([["UIDPLUS",true]]),
      log:{debug(){},warn(){},error(){},info(){}},options:{},untaggedHandlers:{},async exec(command,attributes,options){
        await options.untagged.OK({attributes:[{section:[{type:"ATOM",value:"UIDVALIDITY"},{type:"ATOM",value:"10"}]}]});
        if(marker==="OK"||marker==="NO")await options.untagged[marker]({attributes:[{section:[{type:"ATOM",value:"UIDNOTSTICKY"}]}]});
        return {response:{attributes:[{section:[{type:"ATOM",value:marker==="tagged"?"UIDNOTSTICKY":"READ-WRITE"}]}]},next(){}};
      }});
    const selecting=persistentSelection(transport,()=>select(transport,"Archive",{readOnly:false}));
    if(marker)await assert.rejects(selecting,/persistent UIDs/);else assert.equal(Number((await selecting).uidValidity),10);
    assert.equal(transport.mailbox?.uidNotSticky,undefined,"the pinned parser drops this code; the structured boundary must catch it");
  }
});
test("opposite-direction account copies serialize without lock inversion or nested reentry",async t=>{
  const f=fixture(t);
  f.rows.set("reverse",{...f.row,id:"reverse",account_id:"destination",uid_validity:22});
  const forward=f.access.capture(f.params());
  const source=f.publicAccount(f.accounts.get("destination")),destination=f.publicAccount(f.accounts.get("source"));
  const reverse=f.access.capture({items:[{emailId:"reverse",accountId:"destination"}],contextOwners:[ownerPolicy.capture(source,{id:"reverse",accountId:"destination",folderId:"INBOX"})],
    destinationAccountId:"source",destinationOwner:{accountId:"source",bodyEpoch:destination.bodyEpoch,connection:ownerPolicy.connection(destination)}});
  const oneFolder=await f.access.review(forward,"Parent/Archive"),twoFolder=await f.access.review(reverse,"Parent/Archive");
  let enter,release,active=0,maximum=0;
  const entered=new Promise(resolve=>{enter=resolve}),held=new Promise(resolve=>{release=resolve});
  const first=f.access.withCopy(forward,forward.sources[0],oneFolder,async()=>{active++;maximum=Math.max(maximum,active);enter();await held;active--;return "forward"});
  await entered;
  const second=f.access.withCopy(reverse,reverse.sources[0],twoFolder,async()=>{active++;maximum=Math.max(maximum,active);active--;return "reverse"});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(active,1);release();
  let timeout;try{const completed=await Promise.race([Promise.all([first,second]),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error("Cross-copy deadlock")),3000)})]);assert.deepEqual(completed,["forward","reverse"])}finally{clearTimeout(timeout)}
  assert.equal(maximum,1);assert.equal(f.state.uploads,0);
});
test("Gmail API import is one non-sending POST, uses existing grant and never retries a rejected write",async()=>{
  const calls=[];let refreshes=0;
  const api=createGmailMailApi({accessToken:async()=>"synthetic-token",refreshAccessToken:async()=>{refreshes++;return "other"},
    fetchImpl:async(url,request)=>{calls.push({url,request});return new Response(JSON.stringify({id:"imported"}),{status:200})}});
  let submitted=0;assert.equal((await api.importMessage(RAW,["INBOX","UNREAD","STARRED"],{beforeSubmit(){submitted++}})).id,"imported");
  assert.equal(calls.length,1);assert.equal(submitted,1);assert.match(calls[0].url,/\/messages\/import\?/);
  const url=new URL(calls[0].url);assert.equal(url.searchParams.get("processForCalendar"),"false");assert.equal(url.searchParams.get("deleted"),"false");assert.equal(url.searchParams.get("internalDateSource"),"dateHeader");
  const body=JSON.parse(calls[0].request.body);assert.equal(Buffer.from(body.raw,"base64url").equals(RAW),true);assert.equal(body.threadId,undefined);assert.match(MAIL_SCOPES,/gmail.modify/);assert.doesNotMatch(calls[0].url,/drafts|send/);
  const rejected=createGmailMailApi({accessToken:async()=>"synthetic",refreshAccessToken:async()=>{refreshes++;return "other"},fetchImpl:async()=>{calls.push({rejected:true});return new Response(JSON.stringify({error:{message:"Synthetic rejected write"}}),{status:401})}});
  await assert.rejects(rejected.importMessage(RAW,["INBOX"]));assert.equal(calls.length,2);assert.equal(refreshes,0);
});
