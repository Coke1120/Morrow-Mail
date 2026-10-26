// Real temporary SQLite and fake transports/provider/filesystem dialogs only.
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),Module=require("node:module");
const envKeys=["MORROW_USER_DATA","MORROW_MAIL_DIR","MORROW_AI_CONFIG_DIR","MORROW_MAIL_SECRETS","MORROW_PAGE_DELAY_MS"];
function configure(dir){fs.mkdirSync(dir,{recursive:true});Object.assign(process.env,{MORROW_USER_DATA:dir,MORROW_MAIL_DIR:dir,MORROW_AI_CONFIG_DIR:dir,MORROW_MAIL_SECRETS:"memory",MORROW_PAGE_DELAY_MS:"0"});}
function modules(){return{engine:require("../host/mail/engine"),db:require("../host/mail/db"),remote:require("../host/mail/remote"),secrets:require("../host/mail/secrets")};}
function seed(db,secrets,id,created=1){db.insertAccount({id,email:id+"@example.test",username:id,profile:"custom",createdAt:created,
 imapHost:"imap.example.test",imapPort:993,imapTls:true,smtpHost:"smtp.example.test",smtpPort:587,smtpTls:true});
 secrets.setPassword(id,"synthetic-only");db.replaceFolders(id,[{path:"INBOX",name:"Inbox",wellKnown:"inbox"},{path:"Drafts",name:"Drafts",wellKnown:"drafts"}]);}
function message(id,accountId,extra={}){return{id,accountId,folderPath:"INBOX",uid:1,uidValidity:100,threadId:id,rfcMessageId:"<"+id+"@example.test>",
 subject:id,snippet:id,textBody:id,bodyComplete:true,date:"2026-10-24T08:00:00Z",listSortTs:Date.now(),...extra};}
const gate=()=>{let release,started;return{active:new Promise(resolve=>{started=resolve;}),wait:async()=>{started();await new Promise(resolve=>{release=resolve;});},release:()=>release()};};
async function accountChecks(engine,db,remote,secrets){
 seed(db,secrets,"other");db.insertMessage(message("OtherKeptWord","other"));
 for(const phase of ["list","search","fetch","warm","list-failure","fetch-failure"]){
  const id="remove-"+phase;seed(db,secrets,id);const held=gate();let connections=0,heldOnce=false,warmSearch=false;
  let subject="OldRemovedWord"+phase,validity=100;
  if(phase==="warm")db.applyFolderSync(id,"INBOX",{messages:[],validity:100,uids:[],windowDone:true,horizonDays:require("../host/settings").syncHorizonDays(),uidCursor:0});
  remote.withClient=async(_a,_p,work)=>{connections++;return work({});};
  const hold=async at=>{if(!heldOnce&&(phase===at||phase===at+"-failure"||phase==="warm"&&at==="fetch")){
   heldOnce=true;await held.wait();
   if(phase.endsWith("-failure")){const error=new Error("Synthetic old connection rejected after removal");error.code="auth";throw error;}
  }};
  remote.listFolderRecords=async()=>{await hold("list");return{folders:[{path:"INBOX",name:"Inbox",wellKnown:"inbox"}],delimiter:"/"};};
  remote.searchUids=async(_c,_p,criteria)=>{if(criteria.uid)warmSearch=true;await hold("search");return{uids:[1],validity,exists:1,unseen:0,flags:[]};};
  remote.fetchMessages=async()=>{await hold("fetch");return{validity,messages:[message("server-"+phase,id,{subject})]};};
  const active=engine.syncAccountById(id,{background:false,onlyInbox:true}).then(()=>null,error=>error);
  await held.active;
  if(phase==="warm")assert.equal(warmSearch,true);
  const queued=engine.syncAccountById(id,{background:false,onlyInbox:true}).then(()=>null,error=>error);
  assert.equal((await engine.answer("mail:removeAccount",[{accountId:id}])).success,true);
  await engine.answer("mail:removeAccount",[{accountId:id}]); // idempotent no-op, no credential/cache restoration
  assert.equal(db.accountById(id),null);assert.equal(db.foldersFor(id).length,0);assert(!secrets.getPassword(id));
  // Same ID and creation timestamp deliberately defeat timestamp-only guards.
  seed(db,secrets,id,1);db.insertMessage(message("CurrentNewWord"+phase,id,{uid:0,uidValidity:0}));
  held.release();
  for(const outcome of await Promise.all([active,queued]))assert.equal(outcome.code,"account_removed");
  assert.equal(connections,1,"obsolete queued work cannot open a new connection");
  assert.equal(db.messageById("server-"+phase),null);assert.equal(db.messageStats(id).messages,1);
  assert.equal(engine.answer("mail:searchLocal",[{query:"OldRemovedWord"+phase}]).data.length,0);
  assert(!engine.messagesForAi(40).some(row=>row.subject==="OldRemovedWord"+phase));
  assert(db.messageById("CurrentNewWord"+phase));assert.equal(db.accountById(id).auth_error,null);
  subject="FreshConnectedWord"+phase;validity=200;
  await engine.syncAccountById(id,{background:false,onlyInbox:true});
  assert.equal(db.messageById("server-"+phase).subject,subject);
  assert.equal(engine.answer("mail:searchLocal",[{query:subject}]).data.length,1,"a fresh connection still syncs");
  await engine.answer("mail:removeAccount",[{accountId:id}]);
 }
 assert.equal(db.messageById("OtherKeptWord").text_body,"OtherKeptWord");
 for(const write of [
  ()=>db.replaceFolders("missing",[{path:"INBOX",name:"Inbox"}]),
  ()=>db.applyFolderSync("missing","INBOX",{messages:[],validity:100}),
  ()=>db.insertMessage(message("cannot-orphan","missing")),
  ()=>db.insertScheduled({id:"cannot-queue",accountId:"missing",payloadJson:"{}",sendAt:0,createdAt:1}),
 ])assert.throws(write,error=>error.code==="account_removed");
 // Invalidated in-flight actions cannot restore their removed prior message.
 seed(db,secrets,"action-removed");db.insertMessage(message("old-action","action-removed"));
 const actionHeld=gate();remote.withClient=async(_a,_p,work)=>work({});
 remote.changeFlags=async()=>{await actionHeld.wait();const error=new Error("Synthetic refusal");error.operationIssued=false;throw error;};
 await engine.answer("mail:toggleStar",[{emailId:"old-action",isStarred:true}]);
 const actions=engine.settleActions();await actionHeld.active;
 await engine.answer("mail:removeAccount",[{accountId:"action-removed"}]);seed(db,secrets,"action-removed");
 actionHeld.release();await actions;
 assert.equal(db.messageById("old-action"),null);assert.equal(db.mailActionsForMessage("old-action").length,0);
 await engine.answer("mail:removeAccount",[{accountId:"action-removed"}]);
 // Legacy orphan rows are hidden from local search/context without touching unrelated data.
 await db.checkpoint();const file=db.file();await db.close();
 const raw=new(require("better-sqlite3"))(file);
 raw.prepare("INSERT INTO messages (id,account_id,folder_path,uid,uid_validity,thread_id,subject,snippet,date_iso,list_sort_ts) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run("legacy-orphan","missing","INBOX",1,100,"legacy","LegacyOrphanWord","LegacyOrphanWord","2026-10-24T08:00:00Z",Date.now());
 raw.close();await engine.init();
 assert(db.messageById("legacy-orphan"));assert.equal(engine.answer("mail:searchLocal",[{query:"LegacyOrphanWord"}]).data.length,0);
 assert(!engine.messagesForAi(40).some(row=>row.subject==="LegacyOrphanWord"));assert(db.messageById("OtherKeptWord"));
 await db.close();await engine.init();
 assert.equal(engine.answer("mail:searchLocal",[{query:"OldRemovedWord"}]).data.length,0);
}
function reply(body,status=200){return{ok:status>=200&&status<300,status,text:async()=>JSON.stringify(body)};}
async function calendarChecks(){
 const api=require("../host/mail/calendar-api"),dates={title:"Event",start:"2026-10-25T09:00:00Z",end:"2026-10-25T10:00:00Z"};
 function fixture(description="Original",etag='"1"'){
  let stored={id:"evt",summary:"Event",description,etag,start:{dateTime:dates.start},end:{dateTime:dates.end}};
  const requests=[];let getFailure=null,afterGet=false,loseReply=false,patchFailure=null;
  return{requests,get stored(){return stored;},set getFailure(v){getFailure=v;},set afterGet(v){afterGet=v;},set loseReply(v){loseReply=v;},set patchFailure(v){patchFailure=v;},
   fetch:async(_url,options)=>{requests.push({method:options.method,body:options.body&&JSON.parse(options.body),headers:options.headers});
    if(options.method==="GET"){
     if(getFailure==="network")throw new Error("Synthetic offline");
     if(getFailure)return reply({},getFailure);
     const copy=structuredClone(stored);if(afterGet)stored={...stored,description:"External update",etag:'"external"'};return reply(copy);
    }
    assert.equal(options.method,"PATCH");
    if(patchFailure)return reply({},patchFailure);
    if(options.headers["if-match"]&&options.headers["if-match"]!==stored.etag)return reply({},412);
    stored={...stored,...JSON.parse(options.body),etag:'"next"'};
    if(loseReply)throw new Error("Synthetic reply lost after PATCH");return reply(stored);
   }};
 }
 const update=(f,extra={})=>api.updateEvent("google","synthetic-only","primary","evt",{...dates,...extra},f.fetch);
 const full="A".repeat(8000)+" UNSEEN TAIL",long=fixture(full);
 assert.equal(api.normalizeGoogleEvent(long.stored,"primary").descriptionTruncated,true);
 await update(long,{});assert.equal(long.stored.description,full);assert.equal(long.requests.length,1);
 for(let repeat=0;repeat<2;repeat++)await assert.rejects(()=>update(long,{description:"B"+"A".repeat(7999),descriptionBase:"A".repeat(8000)}),e=>e.code==="conflict");
 assert.equal(long.requests.filter(r=>r.method==="PATCH").length,1);assert.equal(long.stored.description,full);
 const safe=fixture();await update(safe,{description:"Edited",descriptionBase:"Original"});
 assert.deepEqual(safe.requests.map(r=>r.method),["GET","PATCH"]);assert.equal(safe.requests[1].headers["if-match"],'"1"');
 await update(safe,{description:"",descriptionBase:"Edited"});assert.equal(safe.stored.description,"");
 const missing=fixture("Original",null);
 await assert.rejects(()=>update(missing,{description:"Edited",descriptionBase:"Original"}),e=>e.code==="conflict");
 const conflict=fixture("Different");
 await assert.rejects(()=>update(conflict,{description:"Edited",descriptionBase:"Original"}),e=>e.code==="conflict");
 for(const failure of ["network",404,429]){
  const f=fixture();f.getFailure=failure;
  await assert.rejects(()=>update(f,{description:"Edited",descriptionBase:"Original"}));
  assert(f.requests.every(r=>r.method==="GET"));assert.equal(f.stored.description,"Original");
 }
 const concurrent=fixture();concurrent.afterGet=true;
 await assert.rejects(()=>update(concurrent,{description:"Edited",descriptionBase:"Original"}),e=>e.code==="conflict"&&e.status===412);
 assert.equal(concurrent.stored.description,"External update");
 const interrupted=fixture();interrupted.loseReply=true;
 await assert.rejects(()=>update(interrupted,{description:"Edited",descriptionBase:"Original"}),e=>e.code==="provider_network");
 interrupted.loseReply=false;
 await assert.rejects(()=>update(interrupted,{description:"Edited",descriptionBase:"Original"}),e=>e.code==="conflict");
 assert.equal(interrupted.requests.filter(r=>r.method==="PATCH").length,1);
 await assert.rejects(()=>update(fixture(),{description:full,descriptionBase:"Original"}),e=>e.code==="invalid");
}
async function attachmentChecks(engine,db,remote,secrets,dir){
 seed(db,secrets,"files");
 let connections=0,partCalls=[],dialogs=0;
 remote.withClient=async()=>{throw new Error("Synthetic offline");};
 const upload=(name,text)=>engine.answer("mail:uploadAttachment",[{filename:name,fileBytes:Buffer.from(text)}]).data;
 const a=upload("a.txt","LOCAL A"),b=upload("b.txt","LOCAL B");
 const first=await engine.answer("mail:upsertDraft",[{accountId:"files",to:"r@example.test",body:"<p>Files</p>",attachments:[a,b]}]);
 const id=first.data.emailId,oldFiles=JSON.parse(db.messageById(id).attachments_json);
 const originalLoad=Module._load;let target="";
 Module._load=function(request,...args){if(request==="electron")return{BrowserWindow:{getFocusedWindow:()=>null,getAllWindows:()=>[]},
  dialog:{showSaveDialog:async()=>{dialogs++;target=path.join(dir,"files-"+dialogs+".zip");return{canceled:false,filePath:target};}}};return originalLoad.call(this,request,...args);};
 const zip=require("../host/mail/zip-bytes");
 const archive=async(emailId,ids)=>{const result=await engine.answer("mail:downloadAttachmentsZip",[{emailId,attachmentIds:ids}]);
  assert.equal(result.success,true,result.error?.message);return zip.unzipFiles(fs.readFileSync(target));};
 try{
  remote.withClient=async(_a,_p,work)=>{connections++;return work({});};
  remote.readPart=async(_c,_f,uid,part,validity)=>{partCalls.push({uid,part,validity});return Buffer.from("REMOTE "+part);};
  assert.deepEqual((await archive(id,oldFiles.map(f=>f.id))).map(f=>[f.name,f.data.toString()]),[["a.txt","LOCAL A"],["b.txt","LOCAL B"]]);
  assert.equal(connections,0,"all-local ZIP needs no account password/IMAP connection");
  assert.equal((await engine.bytesFor({emailId:id})).data.toString(),"LOCAL A","omitted legacy ID still selects the default");
  assert.equal((await engine.bytesFor({emailId:id,attachmentId:undefined})).data.toString(),"LOCAL A");
  const edited=await engine.answer("mail:upsertDraft",[{accountId:"files",emailId:id,draftRevision:first.data.draftRevision,to:"r@example.test",body:"<p>Changed</p>",attachments:[b]}]);
  assert.equal(await engine.bytesFor({emailId:id,attachmentId:oldFiles[0].id,filename:"a.txt"}),null);
  const stale=await engine.answer("mail:fetchAttachmentBytes",[{emailId:id,attachmentId:oldFiles[0].id}]);assert.equal(stale.error.code,"not-found");
  const beforeDialogs=dialogs;
  const incomplete=await engine.answer("mail:downloadAttachmentsZip",[{emailId:id,attachmentIds:[oldFiles[0].id,oldFiles[1].id]}]);
  assert.equal(incomplete.success,false);assert.equal(dialogs,beforeDialogs,"a missing selected file cannot silently produce a partial ZIP");
  // A local blob still resolves locally after a server UID is assigned.
  db.updateMessage(id,{uid:42,uid_validity:100});connections=0;partCalls=[];
  const current=JSON.parse(db.messageById(id).attachments_json);
  assert.equal((await archive(id,[current[0].id]))[0].data.toString(),"LOCAL B");assert.equal(connections,0);
  db.insertMessage(message("remote-files","files",{uid:88,attachments:[{id:"2",filename:"remote.txt"},{id:"3",filename:"second.txt"}]}));
  const rem=await archive("remote-files",["2","3"]);
  assert.deepEqual(rem.map(f=>f.data.toString()),["REMOTE 2","REMOTE 3"]);assert.equal(connections,1);
  const savedRead=remote.readPart,beforeFailure=dialogs;
  engine.attachmentCacheForTest.clear(); // Exercise a cold transport failure, not the newly shared warm bytes.
  remote.readPart=async()=>{throw new Error("Synthetic part read interrupted");};
  assert.equal((await engine.answer("mail:downloadAttachmentsZip",[{emailId:"remote-files",attachmentIds:["2","3"]}])).success,false);
  assert.equal(dialogs,beforeFailure+1,"Save is reviewed before the cold transfer; failure still cannot write an incomplete archive");
  remote.readPart=savedRead;assert.equal((await archive("remote-files",["2"]))[0].data.toString(),"REMOTE 2");
  db.insertMessage(message("mixed-files","files",{uid:89,attachments:[{...current[0],filename:"same.txt"},{id:"2",filename:"same.txt"}]}));
  const mix=await archive("mixed-files",[current[0].id,"2"]);
  assert.deepEqual(mix.map(f=>[f.name,f.data.toString()]),[["same.txt","LOCAL B"],["same-2.txt","REMOTE 2"]]);
  db.insertMessage(message("missing-blob","files",{uid:90,attachments:[{id:"missing",filename:"missing.txt",storageUrl:"local:gone"}]}));
  const readCount=partCalls.length;
  await assert.rejects(()=>engine.bytesFor({emailId:"missing-blob",attachmentId:"missing"}),/local attachment/);assert.equal(partCalls.length,readCount);
  const unknown=await engine.bytesFor({emailId:"remote-files",attachmentId:"unknown"});assert.equal(unknown,null);
  // Validate after connection setup and again after each part read.
  const held=gate();remote.withClient=async(_a,_p,work)=>{await held.wait();return work({});};partCalls=[];
  const pending=engine.bytesFor({emailId:"remote-files",attachmentId:"2"}).then(()=>null,e=>e);await held.active;
  db.updateMessage("remote-files",{uid:99,rfc_message_id:"<replacement@example.test>"});held.release();
  assert.match((await pending).message,/changed/);assert.equal(partCalls.length,0);
  const partHeld=gate();remote.withClient=async(_a,_p,work)=>work({});
  remote.readPart=async()=>{await partHeld.wait();return Buffer.from("STALE");};
  const during=engine.bytesFor({emailId:"remote-files",attachmentId:"2"}).then(()=>null,e=>e);await partHeld.active;
  db.updateMessage("remote-files",{attachments_json:JSON.stringify([{id:"4",filename:"new.txt"}])});partHeld.release();
  assert.match((await during).message,/changed/);
  const removedHeld=gate();remote.readPart=async()=>{await removedHeld.wait();return Buffer.from("REMOVED");};
  const removed=engine.bytesFor({emailId:"remote-files",attachmentId:"4"}).then(()=>null,e=>e);await removedHeld.active;
  await engine.answer("mail:removeAccount",[{accountId:"files"}]);removedHeld.release();assert.equal((await removed).code,"account_removed");
 }finally{Module._load=originalLoad;}
}
async function uiChecks(){
 const {renderer}=require("./check-ux-workflows"),nodes=new Map();
 const get=id=>{if(!nodes.has(id))nodes.set(id,{value:"",checked:false,hidden:false,textContent:"",options:[{value:"primary"}],classList:{remove(){},add(){}},focus(){}});return nodes.get(id);};
 const ui=renderer({document:{getElementById:get,querySelector:()=>null}});
 ui.run("calendarAccount=()=>({id:'a'});state.calendarPayload={accountId:'a'};state.calendarId='primary';state.calendarIds=['primary'];"+
  "openDialog=()=>{};closeDialog=()=>{};showStatus=()=>{};loadCalendar=async()=>{};globalThis.calendarCalls=[];call=async(c,p)=>{calendarCalls.push({c,p});return {};};");
 ui.context.long={id:"long",calendarId:"primary",title:"Long",start:"2026-10-25T09:00:00Z",end:"2026-10-25T10:00:00Z",description:"A".repeat(8000),descriptionTruncated:true};
 ui.run("openCalendarEditor(long)");assert.equal(get("calendar-description").readOnly,true);assert.equal(get("calendar-description-note").hidden,false);
 get("calendar-description").value="Modified incomplete text";
 await assert.rejects(ui.run("submitCalendarEvent({preventDefault(){}})"),/incomplete/);assert.equal(ui.run("calendarCalls.length"),0);
 get("calendar-description").value="A".repeat(8000);get("calendar-event-title").value="Title only";
 await ui.run("submitCalendarEvent({preventDefault(){}})");
 assert.equal(ui.run("Object.hasOwn(calendarCalls[0].p,'description')"),false);
 ui.run("openCalendarEditor(null)");assert.equal(get("calendar-description").readOnly,false);assert.equal(get("calendar-description-note").hidden,true);
}
async function run(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"morrow-account-files-calendar-")),env=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));configure(root);
 const {engine,db,remote,secrets}=modules(),saved=Object.fromEntries(["withClient","listFolderRecords","searchUids","fetchMessages","changeFlags","readPart"].map(k=>[k,remote[k]]));
 try{await engine.init();await accountChecks(engine,db,remote,secrets);await calendarChecks();await attachmentChecks(engine,db,remote,secrets,root);await uiChecks();}
 finally{Object.assign(remote,saved);await db.close();for(const id of ["other","files","action-removed"])secrets.deletePassword(id);
  for(const[k,v]of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v;}fs.rmSync(root,{recursive:true,force:true});}
 console.log("account-calendar-attachments-ok (disconnect/reconnect epochs, full description guards, exact IDs, local/remote ZIP, races/restart)");
}
module.exports={run};
if(require.main===module)run().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
