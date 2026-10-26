// Offline regressions for the five independently reproduced v0.3.0 defects.
// Real SQLite/MIME/parser and renderer functions; no native window or live I/O.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { JSDOM } = require("jsdom");
const { renderer } = require("./check-ux-workflows");
const { server, message } = require("./gmail-fixture");
const clone = value => JSON.parse(JSON.stringify(value));

function composeUi() {
  const ids = ["compose-save", "compose-send", "compose-schedule", "compose-send-now", "compose-close", "compose-from-note", "compose-to", "compose-cc", "compose-bcc", "compose-show-cc", "compose-show-bcc", "compose-subject", "compose-body", "signatures-from-compose", "ai-mode", "ai-prompt", "ai-generate", "ai-write-error", "ai-cancel", "compose-attach", "compose-file", "schedule-preset", "schedule-at", "compose-status", "compose-title", "compose-schedule-tools", "undo-send"];
  const dom = new JSDOM(ids.map(id => `<input id="${id}">`).join("") + '<dialog id="compose"></dialog><dialog id="compose-preview"></dialog><select id="compose-from"></select><select id="signature"></select>');
  const document = dom.window.document;
  for (const node of document.querySelectorAll("dialog")) {
    node.showModal = () => node.setAttribute("open", "");
    node.close = () => node.removeAttribute("open");
  }
  const ui = renderer({ document, crypto: require("node:crypto") });
  ui.run(`
    state.accounts=[{id:'gmail',email:'owner@fixture.invalid',platform:'imap'}]; state.accountId='gmail';
    state.composeSession=1; state.composeMeta={accountId:'gmail',fromAddress:'owner@fixture.invalid',fromDisplayName:'Owner'};
    state.prefs.undoSend=0; state.prefs.scheduleDelay=0;
    paintComposeAi=()=>{}; paintComposeAttachments=()=>{}; paintComposeNote=()=>{};
    scheduleComposeLayout=()=>{}; publishComposeTitle=()=>{}; loadList=async()=>{}; loadScheduled=async()=>{};
    paintComposeChrome=()=>{}; paintQuoteBody=()=>{}; syncScheduleFields=()=>{};
    paintComposeEditor=()=>{}; fillSignatures=async()=>{}; showComposeSuggestions=async()=>{};
    readComposeEditorHtml=()=>globalThis.rich || ''; setComposeEditorEditable=()=>{};
    globalThis.calls=[]; call=async(channel,payload)=>{ calls.push({channel,payload}); return {}; };
    paintPreview=draft=>{ globalThis.preview=JSON.parse(JSON.stringify(draft)); };
    document.getElementById('compose').showModal();
  `);
  return { ...ui, document, node: id => document.getElementById(id) };
}

async function rendererChecks() {
  const ui = composeUi();
  ui.node("compose-to").value = "recipient@fixture.invalid";
  ui.node("compose-body").value = "Reviewed sentence.";
  ui.run(`state.draftWrite={reqId:'stream',pending:true,text:'Reviewed sentence.',base:''}; paintDraft();`);
  for (const id of ["compose-save", "compose-send", "compose-schedule"]) assert.equal(ui.node(id).disabled, true);
  assert.equal(ui.run("openComposePreview(null)"), false, "streaming content must finish/cancel before preview");
  await ui.run("sendMail()"); await ui.run("scheduleMail(new Date(Date.now()+60000))");
  assert.equal(ui.run("calls.length"), 0);
  ui.run(`onDraftEvent({reqId:'stream',type:'done'}); globalThis.rich='<p>Reviewed <b>sentence</b>.</p>';`);
  ui.run(`state.composeAttachments=[{id:'file',storageUrl:'local:file',filename:'file.png',contentId:'logo',size:4}];`);
  assert.equal(ui.run("openComposePreview(null)"), true);
  ui.run(`onDraftEvent({reqId:'stream',type:'chunk',data:' Unreviewed commitment.'});`);
  assert.equal(ui.node("compose-body").value, "Reviewed sentence.", "late chunks cannot change a finished stream");
  await ui.run("confirmComposePreview()");
  let submitted = clone(ui.run("calls.find(c=>c.channel==='mail:send').payload"));
  assert.match(submitted.body, /<b>sentence<\/b>/);
  assert.equal(submitted.fromDisplayName, "Owner");
  assert.equal(submitted.attachments[0].contentId, "logo");
  // An asynchronous editor change invalidates the preview instead of sending it.
  ui.run("calls=[]; state.draftWrite=null; document.getElementById('compose').showModal();");
  assert.equal(ui.run("openComposePreview(null)"), true);
  ui.node("compose-cc").value = "later@fixture.invalid";
  assert.equal(await ui.run("confirmComposePreview()"), false);
  assert.equal(ui.run("calls.length"), 0);
  assert.match(ui.node("compose-status").textContent, /changed.*new preview/);
  // Even a mutation during confirmation cannot change the captured scheduled content.
  ui.run(`closeDialog=async(id)=>{document.getElementById(id).close();};`);
  assert.equal(ui.run("openComposePreview(new Date(Date.now()+60000))"), true);
  await ui.run("confirmComposePreview()");
  submitted = clone(ui.run("calls.find(c=>c.channel==='mail:scheduleSend').payload"));
  assert.equal(submitted.cc, "later@fixture.invalid"); assert.equal(submitted.fromDisplayName, "Owner");
  assert.match(submitted.body, /<b>sentence<\/b>/); assert.equal(submitted.attachments[0].contentId, "logo");

  const doc = new JSDOM('<input id="calendar-start" type="datetime-local"><input id="calendar-end" type="datetime-local"><input id="calendar-all-day" type="checkbox"><input id="calendar-event-title"><input id="calendar-location"><textarea id="calendar-description"></textarea><p id="calendar-form-status"></p><label for="calendar-end"></label>').window.document;
  const cal = renderer({ document: doc });
  cal.run(`calendarAccount=()=>({id:'gmail'}); state.calendarId='primary'; state.calendarIds=['primary']; openDialog=()=>{};`);
  const node = id => doc.getElementById(id);
  cal.run(`openCalendarEditor({id:'all-day',calendarId:'primary',title:'Holiday',allDay:true,start:'2026-10-26',end:'2026-10-27'})`);
  assert.equal(node("calendar-start").value, "2026-10-26"); assert.equal(node("calendar-end").value, "2026-10-27");
  cal.run(`openCalendarEditor({id:'timed',calendarId:'primary',title:'Meeting',allDay:false,start:'2026-10-26T09:00:00Z',end:'2026-10-26T10:00:00Z'})`);
  assert.equal(node("calendar-start").value, cal.run("toDateTimeLocal('2026-10-26T09:00:00Z')"));
  node("calendar-start").value = "2026-10-26T09:00"; node("calendar-end").value = "2026-10-26T10:00";
  node("calendar-all-day").checked = true; cal.run("syncAllDayInputs()");
  assert.equal(node("calendar-start").value, "2026-10-26"); assert.equal(node("calendar-end").value, "2026-10-27");
  node("calendar-all-day").checked = false; cal.run("syncAllDayInputs()");
  assert.equal(node("calendar-start").value, "2026-10-26T09:00"); assert.equal(node("calendar-end").value, "2026-10-27T10:00");
  const featureDoc = new JSDOM('<div id="features-catalog"></div><p id="features-empty"></p>').window.document;
  const features = renderer({ document: featureDoc });
  features.context.window.morrowFeaturesCatalog = require("../renderer/features-catalog");
  features.run("paintFeatureCatalog()");
  for (const text of [/Reply-To/, /reviewed message/, /server draft.*every attachment/, /cp932 and UTF-7/, /all-day and timed input keeps the dates/]) {
    assert.match(featureDoc.body.textContent, text);
  }
  const help = fs.readFileSync(require.resolve("../renderer/index.html"), "utf8");
  assert.match(help, /Finish or cancel AI writing before previewing/);
  assert.match(help, /Switching All day keeps the dates/);
  console.log("fresh-review-renderer-ok: immutable preview, AI gates, calendar type sanitization");
}

async function hostChecks() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-five-fixes-"));
  const env = { ...process.env }, originalFetch = global.fetch;
  Object.assign(process.env, { MORROW_MAIL_DIR: directory, MORROW_USER_DATA: directory, MORROW_AI_CONFIG_DIR: directory, MORROW_MAIL_SECRETS: "memory" });
  const db = require("../host/mail/db"), engine = require("../host/mail/engine"), remote = require("../host/mail/remote");
  const secrets = require("../host/mail/memory-secrets"), { createSession } = require("../host/mail/gmail-session");
  const { simpleParser } = require("mailparser");
  const original = { withClient: remote.withClient, readPart: remote.readPart };
  const service = server([]); global.fetch = service.fetcher;
  try {
    await engine.init();
    db.insertAccount({ id: "gmail", email: "owner@fixture.invalid", username: "owner", profile: "gmail", authKind: "oauth2", createdAt: 1,
      imapHost: "imap.fixture.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.fixture.invalid", smtpPort: 465, smtpTls: true });
    db.enableGmail("gmail");
    secrets.setPassword("gmail", JSON.stringify({ provider: "google", accessToken: "synthetic", refreshToken: "synthetic", expiresAt: Date.now()+3600000,
      grantedScopes: require("../host/mail/oauth-config").SCOPES.google }));
    const session = createSession(db.accountById("gmail"), "synthetic", { api: service.api() });
    db.replaceFolders("gmail", (await session.folders()).folders);
    remote.withClient = async (_account, _password, work) => work({ gmail: session });
    const ask = async (channel, input, owner) => {
      const result = await engine.answer(channel, [input], { sender: owner });
      assert.equal(result.success, true, JSON.stringify(result)); return result.data;
    };
    for (const charset of ["cp932", "utf-7", "x-unknown"]) {
      const source = message("encoding-"+charset), bytes = charset === "x-unknown" ? Buffer.from("Fallback text") : require("iconv-lite").encode("Hello 日本語", charset);
      source.payload.headers.push({name:"Content-Type",value:"text/plain; charset="+charset}); source.payload.body.data = bytes.toString("base64url");
      service.messages.set(source.id, source);
    }
    const malformed = message("malformed"); malformed.payload.parts = "not an array";
    service.messages.set(malformed.id, malformed); service.messages.set("healthy", message("healthy"));
    assert.equal((await session.sync("INBOX")).bootstrapped, true);
    for (const charset of ["cp932", "utf-7"]) assert.equal(db.gmailCopies("gmail","encoding-"+charset)[0].text_body, "Hello 日本語");
    assert.ok(db.gmailCopies("gmail","encoding-x-unknown")[0].body_warning);
    assert.equal(db.gmailCopies("gmail","malformed")[0].body_complete, 0);
    assert.ok(db.gmailCopies("gmail","healthy")[0]);
    service.history([{id:"101",messagesAdded:[{message:{id:"malformed"}},{message:{id:"healthy"}}]}]);
    assert.equal((await session.sync("INBOX")).bootstrapped, true, "bad MIME cannot block history cursor progress");
    assert.equal(db.gmailSyncState("gmail","INBOX").historyId,"101");

    const source = message("reply-to"); source.payload.headers.push({ name: "Reply-To", value: '"Customer <West>, 名稱" <customer@fixture.invalid>, other@fixture.invalid' });
    source.payload.headers.push({ name: "Cc", value: "other@fixture.invalid, colleague@fixture.invalid" });
    service.messages.set(source.id,source); await session.adopt(source);
    let email = (await ask("mail:openEmail", {emailId:db.gmailCopies("gmail",source.id)[0].id})).email;
    assert.equal(email.replyTo[0].name, "Customer <West>, 名稱");
    const ui = composeUi(); ui.context.email = email;
    ui.context.seed = ui.run("composeSeed(email,'reply','owner@fixture.invalid')");
    ui.context.windowSeed = require("../host/compose-window").sanitizeComposeSeed(ui.context.seed);
    assert.equal(ui.run("replyParties(windowSeed.quoteEmail,['owner@fixture.invalid'],false).to"), '"Customer <West>, 名稱" <customer@fixture.invalid>, other@fixture.invalid', "the compose-window quote retains Reply-To");
    const replyRow=db.gmailCopies("gmail",source.id)[0];
    db.updateMessage(replyRow.id,{recipient_headers_json:"{}"});
    const readsBefore=service.calls.length;
    await ask("mail:openEmail",{emailId:replyRow.id});
    assert.equal(service.calls.length,readsBefore,"reading a complete legacy cache must stay immediate and offline");
    const refreshed=await ask("mail:getComposeContext",{accountId:"gmail",sourceMessageId:replyRow.id,kind:"reply"});
    assert.equal(refreshed.replyTo[0].address,"customer@fixture.invalid","reply preparation enriches legacy header metadata");
    ui.context.refreshed=refreshed;
    ui.run("call=async()=>refreshed");
    await ui.run("initializeComposeIdentity({kind:'reply',quoteEmail:{from:'no-reply@fixture.invalid'}})");
    assert.match(ui.node("compose-to").value,/customer@fixture.invalid/);
    for (const all of [false,true]) {
      ui.context.all=all;
      const parties=ui.run("replyParties(email,['owner@fixture.invalid'],all)");
      assert.equal(parties.to, '"Customer <West>, 名稱" <customer@fixture.invalid>, other@fixture.invalid');
      assert.equal(parties.cc, all ? "colleague@fixture.invalid" : "");
    }
    const raw = await remote.buildRaw({from:"sender@fixture.invalid",to:"owner@fixture.invalid",replyTo:[{address:"customer@fixture.invalid",name:"Customer <West>, 名稱"}],text:"IMAP body"});
    const parsed=await simpleParser(raw);
    const fetched=await remote.fetchSource({mailbox:{uidValidity:1},getMailboxLock:async()=>({release(){}}),async *fetch(){yield{uid:1,source:raw,envelope:{from:parsed.from.value,to:parsed.to.value,replyTo:parsed.replyTo.value},flags:new Set()};}},"INBOX",1,1);
    assert.equal(fetched.recipientHeaders.replyTo[0].address,"customer@fixture.invalid");

    const draft=message("provider-draft",["DRAFT"]);
    draft.payload.headers=draft.payload.headers.map(h=>h.name==="From"?{...h,value:'"Saved, Name" <owner@fixture.invalid>'}:h);
    draft.payload={...draft.payload,mimeType:"multipart/mixed",body:undefined,parts:[
      {partId:"0",mimeType:"text/plain",body:{data:Buffer.from("Draft body").toString("base64url")}},
      {partId:"1",filename:"contract.pdf",mimeType:"application/pdf",body:{data:Buffer.from("CONTRACT").toString("base64url")}},
      {partId:"2",filename:"logo.png",mimeType:"image/png",headers:[{name:"Content-ID",value:"<logo>"}],body:{data:Buffer.from("IMAGE").toString("base64url")}},
    ]};
    service.messages.set(draft.id,draft); await session.adopt(draft,{full:true});
    const row=db.gmailCopies("gmail",draft.id).find(r=>r.is_draft), revision=db.draftRevision(row), before=clone(row);
    const prepared=(await ask("mail:prepareDraft",{emailId:row.id,draftRevision:revision})).email;
    assert.equal(prepared.fromDisplayName,"Saved, Name"); assert.equal(prepared.draftRevision,revision);
    assert.deepEqual(clone(db.messageById(row.id)),before,"hydration cannot alter source cleanup proofs");
    assert.deepEqual(prepared.attachments.map(f=>Buffer.from(db.readBlob(f.storageUrl.slice(6)).data).toString()),["CONTRACT","IMAGE"]);
    const payload={accountId:"gmail",fromAddress:prepared.fromAddress,fromDisplayName:prepared.fromDisplayName,to:"recipient@fixture.invalid",body:"<p>Draft body</p>",attachments:prepared.attachments,draftId:row.id,draftRevision:revision};
    const queued=await ask("mail:scheduleSend",{...payload,sendAt:new Date(Date.now()+3600000).toISOString()});
    assert.ok(queued);
    const recovered=await ask("mail:editScheduled",{id:queued.id});
    const recoveredDraft=(await ask("mail:openEmail",{emailId:recovered.emailId})).email;
    assert.equal(recoveredDraft.fromDisplayName,"Saved, Name");
    assert.deepEqual(recoveredDraft.attachments.map(f=>Buffer.from(db.readBlob(f.storageUrl.slice(6)).data).toString()),["CONTRACT","IMAGE"]);
    const saved=await ask("mail:upsertDraft",payload);
    const mime=await simpleParser(service.mime.at(-1));
    assert.deepEqual(Object.fromEntries(mime.attachments.map(f=>[f.filename,f.content.toString()])),{"contract.pdf":"CONTRACT","logo.png":"IMAGE"});
    assert.equal(mime.attachments.find(f=>f.filename==="logo.png").contentId,"<logo>");
    // Failures, cancellation and source changes must leave a retryable source.
    assert.ok(db.messageById(saved.emailId));
    const retryDraft=structuredClone(draft); retryDraft.id="retry-draft"; retryDraft.labelIds=["DRAFT"];
    service.messages.set(retryDraft.id,retryDraft); await session.adopt(retryDraft,{full:true});
    const failRow=db.gmailCopies("gmail",retryDraft.id).find(r=>r.is_draft);
    remote.readPart=async()=>{throw new Error("Synthetic attachment failure");};
    const pendingRow=db.messageById(failRow.id), pendingBefore=clone(pendingRow), pendingRevision=db.draftRevision(pendingRow);
    engine.attachmentCacheForTest.clear();
    let failed=await engine.answer("mail:prepareDraft",[{emailId:pendingRow.id,draftRevision:pendingRevision}]);
    assert.equal(failed.success,false); assert.match(failed.error.message,/saved draft was retained/i);
    assert.deepEqual(clone(db.messageById(pendingRow.id)),pendingBefore);
    let release,entered;
    const held=new Promise(resolve=>{release=resolve;}), active=new Promise(resolve=>{entered=resolve;});
    remote.readPart=async(...args)=>{entered();await held;return original.readPart(...args);};
    const owner=new(require("node:events").EventEmitter)(); owner.isDestroyed=()=>false;owner.send=()=>{};
    const preparing=engine.answer("mail:prepareDraft",[{emailId:pendingRow.id,draftRevision:pendingRevision,requestId:"cancel-prepare"}],{sender:owner});
    await active;
    const sharedRead=engine.bytesFor({emailId:pendingRow.id,attachmentId:"gmail:1"});
    await new Promise(resolve=>setImmediate(resolve));
    engine.answer("mail:cancelAttachmentRequest",[{requestId:"cancel-prepare"}],{sender:owner}); release();
    failed=await preparing; assert.equal(failed.error.code,"cancelled");
    assert.equal((await sharedRead).data.toString(),"CONTRACT","cancelling preparation cannot abort another attachment consumer");
    assert.deepEqual(clone(db.messageById(pendingRow.id)),pendingBefore);
    remote.readPart=original.readPart;
    const retry=(await ask("mail:prepareDraft",{emailId:pendingRow.id,draftRevision:pendingRevision})).email;
    assert.equal(retry.attachments.length,2);
    const oldContent=db.messageById(pendingRow.id).text_body;
    const broken=structuredClone(retryDraft);broken.payload.parts="invalid MIME tree";
    await session.adopt(broken);
    assert.equal(db.messageById(pendingRow.id).text_body,oldContent,"malformed refresh retains a complete cached body");
    assert.ok(db.messageById(pendingRow.id).body_warning,"retained bodies must still flag incomplete replacement metadata");
    await session.adopt(retryDraft,{full:true});
    failed=await engine.answer("mail:prepareDraft",[{emailId:pendingRow.id,draftRevision:"obsolete"}]);
    assert.equal(failed.success,false); assert.match(failed.error.message,/changed/);
    // Resumed local files also survive the actual renderer handoff without losing CIDs.
    const resume=composeUi(); resume.context.readyEmail=retry;
    resume.run(`call=async(channel)=>({email:readyEmail}); startAttachmentTask=()=>({promise:Promise.resolve({email:readyEmail})}); presentCompose=async seed=>{globalThis.seed=seed;};`);
    await resume.run(`resumeDraft({id:readyEmail.id,accountId:'gmail'})`);
    assert.equal(resume.run("composeAttachmentList(seed.attachments).length"),2);
    assert.equal(resume.run("attachmentPayload(seed.attachments)[1].contentId"),"logo");
    resume.run(`startAttachmentTask=()=>({promise:Promise.reject(new Error('Synthetic preparation failure'))}); globalThis.seed=null;`);
    await assert.rejects(resume.run(`resumeDraft({id:readyEmail.id,accountId:'gmail'})`),/preparation failure/);
    assert.equal(resume.run("seed"),null,"failed preparation must not open an editable composition missing files");
    let finishPreparation;
    resume.context.pendingPreparation=new Promise(resolve=>{finishPreparation=resolve;});
    resume.run(`globalThis.opens=0; startAttachmentTask=()=>({promise:pendingPreparation}); presentCompose=async()=>{opens++;};`);
    const firstResume=resume.run(`resumeDraft({id:readyEmail.id,accountId:'gmail'})`);
    const secondResume=resume.run(`resumeDraft({id:readyEmail.id,accountId:'gmail'})`);
    assert.equal(firstResume,secondResume,"repeated Resume joins the pending preparation");
    assert.equal(resume.run("state.busy"),false,"draft file preparation does not own the shell-wide guard");
    finishPreparation({email:retry});await firstResume;
    assert.equal(resume.run("opens"),1);
    const directDraft=structuredClone(retryDraft);directDraft.id="direct-draft";
    directDraft.payload.headers=directDraft.payload.headers.map(h=>h.name==="Message-ID"?{...h,value:"<direct-draft@fixture.invalid>"}:h);
    service.messages.set(directDraft.id,directDraft);await session.adopt(directDraft,{full:true});
    const directRow=db.gmailCopies("gmail",directDraft.id).find(r=>r.is_draft);
    const directPrepared=(await ask("mail:prepareDraft",{emailId:directRow.id,draftRevision:db.draftRevision(directRow)})).email;
    await ask("mail:send",{...payload,draftId:directRow.id,draftRevision:directPrepared.draftRevision,attachments:directPrepared.attachments});
    assert.equal(db.messageById(directRow.id),null,"hydration must not invalidate confirmed-send cleanup of an unchanged source draft");
    const sent=await simpleParser(service.mime.at(-1));
    assert.equal(sent.from.value[0].name,"Saved, Name");
    assert.deepEqual(Object.fromEntries(sent.attachments.map(f=>[f.filename,f.content.toString()])),{"contract.pdf":"CONTRACT","logo.png":"IMAGE"});
    assert.equal(sent.attachments.find(f=>f.filename==="logo.png").contentId,"<logo>");
    console.log("fresh-review-host-ok: Gmail charset/MIME isolation, structured Reply-To, draft hydration/MIME/queue/failure/cancel/retry");
  } finally {
    remote.withClient=original.withClient;remote.readPart=original.readPart; global.fetch=originalFetch;
    await db.close();
    for (const key of ["MORROW_MAIL_DIR","MORROW_USER_DATA","MORROW_AI_CONFIG_DIR","MORROW_MAIL_SECRETS"]) {
      if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];
    }
    fs.rmSync(directory,{recursive:true,force:true});
  }
}

async function run(){ await rendererChecks(); await hostChecks(); }
module.exports={run};
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1;});
