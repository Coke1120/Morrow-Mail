"use strict";
// Actual renderer and preload; synthetic protocol only, without provider/AI/credentials.
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm"), { JSDOM } = require("jsdom");
const { renderer } = require("./check-ux-workflows");
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const window = new JSDOM(fs.readFileSync(require.resolve("../renderer/index.html"), "utf8"), { url: "https://fixture.invalid" }).window;
  t.after(() => window.close());
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new window.Event("close")); };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  const ui = renderer({ window, document: window.document, localStorage: window.localStorage, Event: window.Event, Node: window.Node });
  ui.run(`state.accounts=['a','b','c'].map(id=>({id,email:id+'@fixture.invalid',platform:'imap',imapSmtpProfile:id==='a'?'gmail':'custom',
    authKind:id==='a'?'oauth':'password',mailTransport:id==='a'?'gmail_api':'imap',bodyEpoch:1,bodyVersion:0,
    imapUsername:id+'@fixture.invalid',imapSmtpCustom:{imap:{host:'imap.fixture.invalid',port:993,tls:true},smtp:{host:'smtp.fixture.invalid',port:465,tls:true}},
    folders:{primary:[{id:'INBOX',name:'Inbox'},{id:'Archive',name:'Archive'},{id:'Other',name:'Other'}],more:[]}}));
    state.localAccount={id:LOCAL_ACCOUNT_ID,folders:{primary:[{id:'local:archive',name:'Archive'}],more:[]}};
    state.emails=['one','two','three'].map(id=>({id,accountId:'a',folderId:'INBOX',subject:'Synthetic '+id}));
    state.accountId='a';state.folderId='INBOX';state.email=state.emails[0];
    globalThis.calls=[];globalThis.confirmations=[];globalThis.hook=null;globalThis.confirmHook=null;
    globalThis.moveGate=false;globalThis.sequence=0;globalThis.copyTickets=new Map();globalThis.moveTickets=new Map();
    loadLocalFolders=async()=>{};loadList=async()=>{};renderAccounts=()=>{};showStatus=()=>{};
    askConfirm=async copy=>{confirmations.push(copy);return confirmHook?await confirmHook(copy):{ok:true}};
    globalThis.reply=(channel,p)=>{
      if(channel==='mail:crossMailboxCopy') {
        if(p.action==='destinations')return {accountId:p.destinationAccountId,copyEnabled:true,moveEnabled:false,moveReason:'Connected Move stays gated.',
          folders:['Archive','Other'].map(id=>({id,name:id,path:id,enabled:true})),notices:[],maxMessages:50,maxBytes:33554432,maxTotalBytes:268435456};
        if(p.action==='review'){const r={reviewId:'copy-review-'+(++sequence),accountId:p.destinationAccountId,folderId:p.folderId,sourceCount:p.items.length,
          sourceLabels:['a@fixture.invalid'],destinationLabel:'b@fixture.invalid / '+p.folderId,expiresAt:Date.now()+60000};copyTickets.set(r.reviewId,r);return r;}
        if(p.action==='copy'){const r=copyTickets.get(p.reviewId);if(!r)throw Error('Missing Copy ticket');return {status:'copied',receiptId:'copy-'+p.emailId,sourceRetained:true,destination:{accountId:r.accountId,folderId:r.folderId}};}
        if(p.action==='cancelReview')return {cancelled:true};
      }
      if(channel==='mail:crossMailboxMove') {
        if(p.action==='capabilities')return {moveEnabled:moveGate,sourceGmailOnly:true,moveReason:'Prepared Gmail-source Move remains unavailable pending independent Copy verification.'};
        if(p.action==='review'){const r={reviewId:'move-review-'+(++sequence),accountId:p.destinationAccountId,folderId:p.folderId,sourceCount:p.items.length,
          sourceLabels:['a@fixture.invalid'],destinationLabel:'b@fixture.invalid / '+p.folderId,notices:[],expiresAt:Date.now()+60000,
          entries:p.items.map(item=>({...item,copyReceiptId:'copy-'+item.emailId}))};moveTickets.set(r.reviewId,r);return r;}
        if(p.action==='move'){if(!p.confirmed||!moveTickets.has(p.reviewId))throw Error('Move requires separate confirmation/ticket');const r=moveTickets.get(p.reviewId);
          return {status:'moved',copyReceiptId:'copy-'+p.emailId,moveReceiptId:'move-'+p.emailId,sourceRetained:false,sourceTrashed:true,destination:{accountId:r.accountId,folderId:r.folderId}};}
        if(p.action==='cancelReview')return {cancelled:true};
      }
      throw Error('Unexpected synthetic invoke '+channel+' '+p.action);
    };
    call=async(channel,p)=>{calls.push({channel,params:p});if(hook){const result=await hook(channel,p);if(result!==undefined)return result;}return reply(channel,p)};`);
  return { ui, window, get: id => window.document.getElementById(id),
    async ready(count = 2, enabled = true) {
      ui.run(`moveGate=${enabled}`); await ui.run(`openLocalTransfer(state.emails.slice(0,${count}),'copy')`);
      ui.run("$('local-transfer-account').value='b'"); await ui.run("chooseLocalTransferAccount()");
      ui.run("$('local-transfer-mode').value='move';changeLocalTransferChoice()"); await ui.run("checkCrossMailboxMoveCapabilities(localTransfer)");
    }, rows(channel, action) { return JSON.parse(ui.run(`JSON.stringify(calls.filter(row=>row.channel===${JSON.stringify(channel)}&&row.params.action===${JSON.stringify(action)}))`)); },
    status() { return window.document.getElementById("local-transfer-status").textContent; } };
}

test("actual preload permits only the exact first-party Move channel", async () => {
  let api; const calls=[];
  vm.runInNewContext(fs.readFileSync(require.resolve("../renderer/preload.js"),"utf8"),{require:()=>({contextBridge:{exposeInMainWorld:(_name,value)=>{api=value}},ipcRenderer:{invoke:async(...args)=>calls.push(args)}})});
  await api.invoke("mail:crossMailboxMove",{action:"capabilities"});
  await assert.rejects(api.invoke("mail:crossMailboxMove:enable",{}),/Unsupported channel/);
  assert.equal(calls[0][0],"mail:crossMailboxMove");
});

test("default compiled gate is represented as unavailable and a forced Move cannot Copy or Trash", async t => {
  const f=fixture(t);await f.ready(2,false);
  assert.equal(f.get("local-transfer-mode").querySelector('[value="move"]').disabled,true);
  assert.match(f.get("local-transfer-move-capability").textContent,/unavailable pending independent Copy verification/);
  await f.ui.run("commitLocalTransfer()");
  assert.equal(f.rows("mail:crossMailboxCopy","copy").length,0);assert.equal(f.rows("mail:crossMailboxMove","move").length,0);
});

test("Copy confirmation cannot authorize Gmail Trash; every Copy finishes before distinct review and confirmation", async t => {
  const f=fixture(t);await f.ready();
  f.ui.run(`confirmHook=async copy=>{
    if(confirmations.length===1){if(calls.some(row=>row.channel==='mail:crossMailboxMove'&&row.params.action==='review'))throw Error('Early Move review');}
    else {if(calls.filter(row=>row.channel==='mail:crossMailboxCopy'&&row.params.action==='copy').length!==2)throw Error('Copy incomplete');if(calls.some(row=>row.params.action==='move'))throw Error('Trash before second confirmation');}
    return {ok:true};}`);
  await f.ui.run("commitLocalTransfer()");
  assert.equal(f.rows("mail:crossMailboxCopy","copy").length,2);
  assert.deepEqual(f.rows("mail:crossMailboxMove","move").map(row=>[row.params.reviewId,row.params.emailId,row.params.accountId,row.params.confirmed]),[["move-review-2","one","a",true],["move-review-2","two","a",true]]);
  assert.equal(f.ui.run("confirmations.length"),2);assert.match(f.ui.run("confirmations[1].body"),/across all their labels.*retention.*not atomic.*No Undo/);
  assert.match(f.status(),/2 Gmail originals confirmed in Trash/);
  await f.ui.run("commitLocalTransfer()");assert.equal(f.rows("mail:crossMailboxMove","move").length,2);
});

for(const cancelAt of [1,2])test(`cancelling confirmation ${cancelAt} never authorizes later source writes`,async t=>{
  const f=fixture(t);await f.ready();f.ui.run(`confirmHook=async()=>({ok:confirmations.length!==${cancelAt}})`);await f.ui.run("commitLocalTransfer()");
  assert.equal(f.rows("mail:crossMailboxMove","move").length,0);
  assert.equal(f.rows("mail:crossMailboxCopy","copy").length,cancelAt===1?0:2);
  if(cancelAt===2){assert.match(f.status(),/copies stay.*sources were retained/);assert.equal(f.rows("mail:crossMailboxMove","cancelReview").length,1);}
});

for(const provider of ["imap","outlook","yahoo","legacy-gmail","local"])test(`${provider} sources stay ineligible even if a synthetic host reports Move enabled`,async t=>{
  const f=fixture(t);
  if(provider==='local')f.ui.run("state.emails[0]={...state.emails[0],accountId:LOCAL_ACCOUNT_ID,isLocal:true,folderId:'local:archive'}");
  else f.ui.run(`state.accounts[0].mailTransport='imap';state.accounts[0].imapSmtpProfile=${JSON.stringify(provider==='legacy-gmail'?'gmail':provider)}`);
  await f.ready(1);assert.equal(f.get("local-transfer-mode").querySelector('[value="move"]').disabled,true);await f.ui.run("commitLocalTransfer()");assert.equal(f.rows("mail:crossMailboxMove","move").length,0);
});

for(const status of ["source_retained","unknown","invalid"])test(`${status} per-item outcome stops later Trash and never replays`,async t=>{
  const f=fixture(t);await f.ready(3);
  f.ui.run(`hook=async(channel,p)=>{if(channel==='mail:crossMailboxMove'&&p.action==='move'){
    const r=reply(channel,p);return ${status==='source_retained'?"{...r,status:'source_retained',sourceRetained:true,sourceTrashed:false}":status==='unknown'?"{...r,status:'unknown',sourceRetained:null,sourceTrashed:null}":"{...r,copyReceiptId:'wrong-receipt'}"};}}`);
  await f.ui.run("commitLocalTransfer()");assert.equal(f.rows("mail:crossMailboxMove","move").length,1);assert.equal(f.rows("mail:crossMailboxCopy","copy").length,3);
  assert.match(f.status(),status==='source_retained'?/0 Gmail originals confirmed.*3 retained or not attempted/:/uncertain/);
  await f.ui.run("commitLocalTransfer()");assert.equal(f.rows("mail:crossMailboxMove","move").length,1);
});

for(const mismatch of ["copy-ticket","receipt","destination","expired"])test(`a ${mismatch} Move review cannot authorize Trash`,async t=>{
  const f=fixture(t);await f.ready();f.ui.run(`hook=async(channel,p)=>{if(channel==='mail:crossMailboxMove'&&p.action==='review'){
    const r=reply(channel,p);${mismatch==='copy-ticket'?"r.reviewId='copy-review-1'":mismatch==='receipt'?"r.entries[0].copyReceiptId='unverified'":mismatch==='destination'?"r.folderId='Other'":"r.expiresAt=Date.now()-1000"};return r;}}`);
  await f.ui.run("commitLocalTransfer()");assert.equal(f.rows("mail:crossMailboxCopy","copy").length,2);assert.equal(f.rows("mail:crossMailboxMove","move").length,0);
});

const changes={
  "navigation ABA":"++mailboxNavigationGen;cancelCrossMailboxMoveOnNavigation();++mailboxNavigationGen;cancelCrossMailboxMoveOnNavigation()",
  "page navigation":"showPrimary('features','features-panel')",
  "folder ABA":"$('local-transfer-folder').value='Other';$('local-transfer-folder').dispatchEvent(new Event('change'));$('local-transfer-folder').value='Archive';$('local-transfer-folder').dispatchEvent(new Event('change'))",
  "mode ABA":"$('local-transfer-mode').value='copy';$('local-transfer-mode').dispatchEvent(new Event('change'));$('local-transfer-mode').value='move';$('local-transfer-mode').dispatchEvent(new Event('change'))",
  "source reconnect":"state.accounts[0].bodyEpoch++;observeCrossMailboxMoveContext()",
  "destination reconnect":"state.accounts[1].bodyEpoch++;observeCrossMailboxMoveContext()",
  "destination identity":"state.accounts[1].folders.primary[1].uidValidity=99;observeCrossMailboxMoveContext()",
  "Stop":"$('local-transfer-cancel').click()",
  "close":"$('local-transfer').close()",
};
for(const [name,change] of Object.entries(changes))test(`${name} revokes an active Move ticket before a pending request settles`,async t=>{
  const f=fixture(t);await f.ready();f.ui.run("hook=(channel,p)=>channel==='mail:crossMailboxMove'&&p.action==='move'?new Promise(resolve=>globalThis.releaseMove=()=>resolve({...reply(channel,p),status:'source_retained',sourceRetained:true,sourceTrashed:false})):undefined");
  const pending=f.ui.run("commitLocalTransfer()");for(let i=0;i<20&&f.ui.run("typeof releaseMove")!=='function';i++)await tick();
  assert.equal(f.ui.run("typeof releaseMove"),'function');f.ui.run(change);await tick();
  assert.equal(f.rows("mail:crossMailboxMove","cancelReview").length,1,"revoked before in-flight await resolves");
  f.ui.run("releaseMove()");await pending;assert.equal(f.rows("mail:crossMailboxMove","move").length,1);
});

for(const phase of ["copy","move-review","move-confirmation"])test(`navigation during ${phase} retains copies and prevents every source Trash request`,async t=>{
  const f=fixture(t);await f.ready();
  const change=changes['navigation ABA'];
  if(phase==='move-confirmation')f.ui.run(`confirmHook=async()=>{if(confirmations.length===2){${change};}return {ok:true}}`);
  else f.ui.run(`hook=async(channel,p)=>{if(${phase==='copy'?"channel==='mail:crossMailboxCopy'&&p.action==='copy'":"channel==='mail:crossMailboxMove'&&p.action==='review'"}){${change};return reply(channel,p)}}`);
  await f.ui.run("commitLocalTransfer()");assert.equal(f.rows("mail:crossMailboxMove","move").length,0);assert.ok(f.rows("mail:crossMailboxCopy","copy").length>0);
});

for(const phase of ["move-review","move-confirmation"])for(const name of ["source reconnect","destination reconnect","folder ABA","mode ABA"])
test(`${name} during ${phase} cannot authorize source Trash`,async t=>{
  const f=fixture(t);await f.ready();const change=changes[name];
  if(phase==='move-confirmation')f.ui.run(`confirmHook=async()=>{if(confirmations.length===2){${change};}return {ok:true}}`);
  else f.ui.run(`hook=async(channel,p)=>{if(channel==='mail:crossMailboxMove'&&p.action==='review'){${change};return reply(channel,p)}}`);
  await f.ui.run("commitLocalTransfer()");assert.equal(f.rows("mail:crossMailboxCopy","copy").length,2);assert.equal(f.rows("mail:crossMailboxMove","move").length,0);
  assert.equal(f.rows("mail:crossMailboxMove","cancelReview").length,1);
});

test("count-only publications during source requests do not revoke or misdirect the exact Move review",async t=>{
  const f=fixture(t);await f.ready();f.ui.run(`hook=async(channel,p)=>{if(channel==='mail:crossMailboxMove'&&p.action==='move'){
    state.accounts[0].folders.primary[0].unreadCount=42;state.accounts[1].folders.primary[1].totalCount=100;
    state.accounts[0].bodyVersion++;state.accounts[1].bodyVersion++;observeCrossMailboxMoveContext();return reply(channel,p);}}`);
  await f.ui.run("commitLocalTransfer()");assert.equal(f.rows("mail:crossMailboxMove","move").length,2);assert.match(f.status(),/2 Gmail originals confirmed in Trash/);
});
