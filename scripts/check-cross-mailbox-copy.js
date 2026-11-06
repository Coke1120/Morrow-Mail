"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createJournal, digest } = require("../host/mail/copy-recovery");
const { createService } = require("../host/mail/cross-mailbox-copy");
const mime = require("../host/mail/copy-message");

const RAW = Buffer.from("From: Sender <sender@fixture.invalid>\r\nTo: owner@fixture.invalid\r\nDate: Mon, 02 Nov 2026 03:04:05 +0000\r\nMessage-ID: <duplicate@fixture.invalid>\r\nSubject: Synthetic complete copy\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=owned-boundary\r\n\r\n--owned-boundary\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSynthetic body\r\n--owned-boundary\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=owned.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAP8Q\r\n--owned-boundary--\r\n");
const DATE = Date.parse("2026-11-02T03:04:05Z");
const failure = () => Object.assign(new Error("Synthetic owner changed"), { code: "copy_conflict", operationIssued: false });

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-mailbox-copy-")), file = path.join(dir, "copies.sqlite");
  let ledger = createJournal(file), service, valid = true, folderProof = digest("folder-v1"), clock = 0;
  const state = { uploads: 0, reads: 0, sourceReads: 0, cancelled: 0, beforeWrite: null, afterWrite: null, failRead: false,
    raw: RAW, destinationRaw: null, ack: true, unread: true, starred: true, date: DATE, destinations: new Map() };
  const access = {
    capture(params) { if (!valid) throw failure(); return { sources: params.items.map(item => ({id:item.emailId,accountId:item.accountId,label:item.accountId})), destination:{accountId:"destination"} }; },
    async destinations() { return {accountId:"destination",copyEnabled:true,copyReason:"",folders:[{id:"Archive",name:"Archive",enabled:true}],notices:[]}; },
    async review() { if (!valid) throw failure(); return {id:"Archive",label:"Destination / Archive",proof:folderProof,backend:options.gmail?"gmail":"imap"}; },
    async withCopy(ticket, source, reviewed, work) {
      const checked = () => { if (!valid || reviewed.proof !== folderProof) throw failure(); };
      const session = {check:checked,backend:options.gmail?"gmail":"imap",sourceBinding:digest("source-binding"),destinationBinding:digest("destination-binding"),folderProof,
        async readSource() { checked(); state.sourceReads++; await options.sourceWait?.(); checked(); return {raw:state.raw,unread:true,starred:true,date:DATE}; },
        expected(snapshot) { return {unread:snapshot.unread,starred:snapshot.starred,date:snapshot.date}; },
        sourceKey() { return digest(options.sameIdentity?"canonical-provider-id":source.id); }, destinationKey() { return digest("destination-Archive"); },
        async upload(snapshot, expected, beforeSubmit) {
          await state.beforeWrite?.(); checked(); beforeSubmit();
          assert.equal(ledger.list().at(-1).phase,"unknown","durable uncertainty must precede upload");
          state.uploads++;
          const destination={accountId:"destination",folderId:"Archive",uid:100+state.uploads,uidValidity:1};
          state.destinations.set(destination.uid,{raw:state.destinationRaw||snapshot.raw,unread:state.unread,starred:state.starred,date:state.date});
          await state.afterWrite?.();
          if(!state.ack) throw Object.assign(new Error("Synthetic acknowledgement lost"),{operationIssued:true});
          checked(); return destination;
        },
        async readDestination(locator) { checked();state.reads++;if(state.failRead) throw new Error("Synthetic destination unavailable");return state.destinations.get(locator.uid); },
        verifyState(saved, expected) { if(!saved||saved.unread!==expected.unread||saved.starred!==expected.starred||saved.date!==expected.date) throw failure(); },
      };
      return work(session);
    },
  };
  const start = () => { service=createService({access,journal:()=>ledger,now:()=>1000,clock:()=>clock}); return service; };
  start();
  t.after(()=>{ledger.close();fs.rmSync(dir,{recursive:true,force:true});});
  const params = ids => ({items:(ids||["source"]).map(emailId=>({emailId,accountId:"source-account"})),destinationAccountId:"destination",folderId:"Archive"});
  const review = ids => service.answer({action:"review",...params(ids)});
  const copy = (reviewed,id="source") => service.answer({action:"copy",reviewId:reviewed.reviewId,emailId:id,accountId:"source-account"});
  return {state,file,params,review,copy,get ledger(){return ledger},get service(){return service},invalidate(){valid=false},changeFolder(){folderProof=digest("folder-v2")},expire(){clock+=120001},
    restart(){ledger.close();ledger=createJournal(file);ledger.recover();start();}};
}

test("Copy persists intent before upload and verifies complete body, attachments, date and flags; source stays unchanged",async t=>{
  const f=fixture(t), reviewed=await f.review();
  const result=await f.copy(reviewed);
  assert.equal(result.status,"copied");assert.equal(result.sourceRetained,true);assert.equal(f.state.uploads,1);assert.equal(f.state.reads,1);
  assert.equal(f.ledger.list()[0].phase,"verified");
  const again=await f.copy(await f.review());
  assert.equal(again.status,"reused");assert.equal(f.state.uploads,1);assert.equal(f.state.sourceReads,2);assert.equal(f.state.reads,2);
  await assert.rejects(f.copy(reviewed),/review|already/i);
});

for(const variant of ["body","attachment","headers","read","star","date"]){
  test(`destination ${variant} mismatch never reports success or retries upload`,async t=>{
    const f=fixture(t);
    if(variant==="body") f.state.destinationRaw=Buffer.from(RAW.toString().replace("Synthetic body","Truncated body"));
    if(variant==="attachment") f.state.destinationRaw=Buffer.from(RAW.toString().replace("AP8Q","AA=="));
    if(variant==="headers") f.state.destinationRaw=Buffer.from(RAW.toString().replace("Subject: Synthetic","Subject: Changed"));
    if(variant==="read") f.state.unread=false;
    if(variant==="star") f.state.starred=false;
    if(variant==="date") f.state.date++;
    const result=await f.copy(await f.review());assert.equal(result.status,"unknown");assert.equal(result.sourceRetained,true);
    assert.equal((await f.copy(await f.review())).status,"unknown");assert.equal(f.state.uploads,1);
  });
}
test("lost APPEND/HTTP acknowledgement blocks repeat uploads across process-style reopen",async t=>{
  const f=fixture(t);f.state.ack=false;
  const first=await f.copy(await f.review());assert.equal(first.status,"unknown");assert.equal(first.destination.accountId,"destination");
  f.restart();f.state.ack=true;
  const next=await f.copy(await f.review());assert.equal(next.status,"unknown");assert.equal(f.state.uploads,1);assert.equal(f.state.reads,0);
});
test("acknowledged but unreadable destination can be freshly verified after restart without a second upload",async t=>{
  const f=fixture(t);f.state.failRead=true;
  assert.equal((await f.copy(await f.review())).status,"unknown");f.restart();f.state.failRead=false;
  assert.equal((await f.copy(await f.review())).status,"reused");assert.equal(f.state.uploads,1);
});
test("duplicate Message-ID headers do not identify different sources, while proven canonical aliases reuse one receipt",async t=>{
  const f=fixture(t);for(const id of ["first","second"]) assert.equal((await f.copy(await f.review([id]),id)).status,"copied");assert.equal(f.state.uploads,2);
  const canonical=fixture(t,{sameIdentity:true});
  assert.equal((await canonical.copy(await canonical.review(["first"]),"first")).status,"copied");
  assert.equal((await canonical.copy(await canonical.review(["alias"]),"alias")).status,"reused");assert.equal(canonical.state.uploads,1);
});
test("source or destination owner/folder changes before upload cause zero writes",async t=>{
  for(const kind of ["owner","folder"]){
    const f=fixture(t);const reviewed=await f.review();
    if(kind==="owner")f.invalidate();else f.changeFolder();
    await assert.rejects(f.copy(reviewed),/changed/);assert.equal(f.state.uploads,0);assert.equal(f.ledger.list().length,0);
  }
  const pending=fixture(t);pending.state.beforeWrite=()=>pending.invalidate();
  await assert.rejects(pending.copy(await pending.review()),/changed/);assert.equal(pending.state.uploads,0);assert.equal(pending.ledger.list()[0].phase,"not_uploaded");
});
test("cancellation before submission causes no upload; stopping a started upload permits only its verification",async t=>{
  const before=fixture(t),reviewed=await before.review();before.state.beforeWrite=()=>before.service.answer({action:"cancelReview",reviewId:reviewed.reviewId});
  await assert.rejects(before.copy(reviewed),/cancel/i);assert.equal(before.state.uploads,0);
  const started=fixture(t),batch=await started.review(["first","second"]);
  started.state.afterWrite=()=>started.service.answer({action:"cancelReview",reviewId:batch.reviewId});
  assert.equal((await started.copy(batch,"first")).status,"copied");
  await assert.rejects(started.copy(batch,"second"),/review/i);assert.equal(started.state.uploads,1);
});
test("expired reviews, duplicate selection, Move and over-limit selections cannot upload",async t=>{
  const f=fixture(t),reviewed=await f.review();f.expire();await assert.rejects(f.copy(reviewed),/expired/);
  await assert.rejects(f.review(["source","source"]),/once/);
  await assert.rejects(f.review(Array.from({length:51},(_,i)=>String(i))),/1–50/);
  await assert.rejects(f.service.answer({action:"review",...f.params(),mode:"move"}),/Move/);assert.equal(f.state.uploads,0);
});
test("MIME verification permits only additional Gmail trace headers and keeps every original body/header byte",async()=>{
  const prefixed=Buffer.concat([Buffer.from("Received: synthetic trace\r\n"),RAW]);
  assert.equal(mime.verify(RAW,prefixed,{gmail:true}).rawSha,mime.digest(RAW));
  assert.throws(()=>mime.verify(RAW,prefixed),/match/);
  assert.throws(()=>mime.verify(RAW,Buffer.concat([Buffer.from("Subject: injected\r\n"),RAW]),{gmail:true}),/headers/);
  const parts=await mime.decodedParts(RAW);assert.equal(parts.length,2);assert.equal(parts.find(p=>p.type==="application/octet-stream").size,3);
  assert.equal(mime.dateHeader(RAW),DATE);
  await mime.verifyGmailSource(RAW,{parts:[{mimeType:"text/plain",body:{size:14,data:Buffer.from("Synthetic body").toString("base64url")}},
    {mimeType:"application/octet-stream",body:{size:3,attachmentId:"owned"}}]},async()=>Buffer.from([0,255,16]));
  await assert.rejects(mime.verifyGmailSource(RAW,{mimeType:"text/plain",body:{size:2,data:"YWI"}},async()=>Buffer.alloc(0)),/match|complete/);
});
test("SQLite abrupt exit preserves pre-upload uncertainty and never permits automatic replay",t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"morrow-copy-crash-")),file=path.join(dir,"copies.sqlite");
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const program=`const j=require(${JSON.stringify(require.resolve("../host/mail/copy-recovery"))}).createJournal(process.argv[1]);const d='a'.repeat(64);j.insert({id:'crashed',key:d,sourceKey:d,destinationKey:d,phase:'prepared',updatedAt:1});j.update('crashed','prepared',{phase:'unknown',updatedAt:2});process.exit(77);`;
  const child=spawnSync(process.execPath,["-e",program,file],{encoding:"utf8",timeout:10000});assert.equal(child.status,77,child.stderr);
  const ledger=createJournal(file);try{ledger.recover();assert.equal(ledger.read("crashed").phase,"unknown");}finally{ledger.close();}
});

module.exports={RAW,DATE};
