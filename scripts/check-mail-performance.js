"use strict";

// Isolated temporary SQLite, fake transports/Keychain and DOM only. No real
// account, Keychain command, app window, listener or provider request is used.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { account, folders, message, report } = require("./mail-performance-fixture");

async function diagnosticChecks() {
  const { createRecorder } = require("../host/performance-diagnostics");
  let clock = 0;
  const on = createRecorder({ enabled: true, now: () => clock }), off = createRecorder({ now: () => { throw new Error("Disabled timing must not sample"); } });
  const value = { subject: "private subject", body: "private body", token: "private secret", path: "/private/file", address: "private@fixture.invalid" };
  assert.equal(off.sync("db.index", () => value), value);
  assert.equal(off.measure("db.index", () => value), value);
  const promise = Promise.resolve(value);
  assert.equal(off.measure("db.index", () => promise),promise,"disabled tracing preserves the original promise");
  assert.equal(on.sync("db.index", () => { clock += 75; return value; }), value);
  const error = new Error(JSON.stringify(value));
  assert.throws(() => on.sync("db.index", () => { clock += 25; throw error; }), candidate => candidate === error);
  assert.equal(await on.ipc("mail:openEmail", async () => { clock += 200; return value; }), value);
  await assert.rejects(on.measure("ipc.mail.open", async () => { clock += 5; throw error; }), candidate => candidate === error);
  assert.equal(on.measure("ipc.other", () => 42),42,"synchronous IPC replies retain their type");
  assert.equal(on.ipc(value.address,()=>value),value,"unknown IPC names are grouped without recording caller text");
  for (let n = 0; n < 10000; n++) on.record(`/private/${n}@fixture.invalid`,99);
  const data = on.snapshot();
  assert.equal(data.stages.length,3,"untrusted labels cannot grow or leak into diagnostics");
  assert.deepEqual(data.stages.find(row => row.stage === "db.index"),{stage:"db.index",count:2,meanMs:50,maxMs:75,over50ms:1,over100ms:0});
  const text = JSON.stringify(data);
  for (const secret of Object.values(value)) assert.ok(!text.includes(secret));
  on.snapshot(true); assert.deepEqual(on.snapshot().stages,[]);
  assert.deepEqual(off.snapshot(),{enabled:false,stages:[]});
  const {JSDOM} = require("jsdom"), {renderer} = require("./check-ux-workflows");
  const document = new JSDOM('<div id="features-catalog"></div><p id="features-empty"></p>').window.document;
  const ui=renderer({document}); ui.context.window.morrowFeaturesCatalog=require("../renderer/features-catalog");
  ui.run("paintFeatureCatalog()");
  assert.match(document.body.textContent,/MORROW_PERF=1 enables bounded local timings/);
  assert.match(document.body.textContent,/Native Mac freezes still need profiling/);
  const help=new JSDOM(fs.readFileSync(require.resolve("../renderer/index.html"),"utf8")).window.document;
  assert.match(help.getElementById("cli-performance").textContent,/MORROW_PERF=1 npm start/);
  assert.match(help.getElementById("performance-diagnostics-note").textContent,/paths and credentials/);
}

async function run() {
  await diagnosticChecks();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),"morrow-performance-check-"));
  const environment = {...process.env}, originalFetch = global.fetch;
  Object.assign(process.env,{MORROW_MAIL_DIR:directory,MORROW_USER_DATA:directory,MORROW_AI_CONFIG_DIR:directory,MORROW_MAIL_SECRETS:"memory",MORROW_PERF:"1"});
  // diagnosticChecks imported this module before enabling; use an isolated fresh
  // singleton for production integration below, including its actual stage labels.
  delete require.cache[require.resolve("../host/performance-diagnostics")];
  const perf = require("../host/performance-diagnostics");
  const db = require("../host/mail/db"), engine = require("../host/mail/engine"), remote = require("../host/mail/remote");
  const {Persistence} = require("../host/mail/persistence");
  const original = {append:Persistence.prototype.append,withClient:remote.withClient,select:db.selectMessages};
  let commands = [], reads = 0;
  global.fetch = async () => { throw new Error("Live requests forbidden"); };
  remote.withClient = async () => { reads++; throw new Error("Synthetic unavailable provider"); };
  const ask = async (channel, input) => {
    const result = await engine.answer(channel,[input]); assert.equal(result.success,true,JSON.stringify(result)); return result.data;
  };
  try {
    await engine.init(); db.insertAccount(account); db.replaceFolders(account.id,folders);
    const cases = [null,""," \t\n\r","\u00a0\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000\ufeff","\0"," \u200b "," \nreal body\t"];
    const rows = cases.map((value,index)=>message(index+1,{textBody:value,htmlBody:null,threadId:"whitespace"}));
    rows.push(message(20,{htmlBody:"<p>HTML only</p>",textBody:null,threadId:"whitespace",isDraft:true,attachments:[{id:"local-file",storageUrl:"local:local-file",filename:"synthetic.bin",size:4}]}));
    db.applyFolderSync(account.id,"INBOX",report(rows));
    const query = {accountId:account.id,folderId:"INBOX",limit:200};
    const full = db.selectMessages(query), headers = db.selectMessages(query,{headersOnly:true});
    assert.equal(full.length,headers.length);
    for (const row of headers) {
      const before = full.find(item=>item.id===row.id);
      assert.equal(row.has_body,Number(!!((before.html_body||"").trim()||(before.text_body||"").trim())),"hasBody must match JS trim, including Unicode and NUL");
      assert.ok(!Object.hasOwn(row,"html_body")&&!Object.hasOwn(row,"text_body"));
      for (const [key,value] of Object.entries(before)) if(!["html_body","text_body"].includes(key)) assert.deepEqual(row[key],value,key);
    }
    const projected = await ask("mail:listFromCache",query);
    db.selectMessages = input => original.select(input);
    const unprojected = await ask("mail:listFromCache",query); db.selectMessages = original.select;
    assert.deepEqual(projected.emails,unprojected.emails,"list API/flags/attachment/sender metadata must be identical");
    const headerThread = await ask("mail:listThreadMessages",{accountId:account.id,threadId:"whitespace",headersOnly:true});
    const fullThread = await ask("mail:listThreadMessages",{accountId:account.id,threadId:"whitespace"});
    assert.equal(headerThread.length,fullThread.length);
    for(const row of headerThread) {
      const whole = fullThread.find(item=>item.id===row.id);
      assert.equal(row.hasBody,whole.hasBody); assert.equal(row.from,whole.from); assert.deepEqual(row.attachments,whole.attachments);
      assert.ok(!Object.hasOwn(row,"htmlBody")&&!Object.hasOwn(row,"textBody"));
    }
    const opened = await ask("mail:openEmail",{emailId:"performance-7"});
    assert.equal(opened.email.textBody," \nreal body\t"); assert.equal(opened.threadMessages.length,rows.length);
    assert.equal(reads,0,"complete cached list, thread and open must stay offline");
    const sync = message(100,{textBody:"originalneedle durable text",htmlBody:"<p>HTML original</p>"});
    db.applyFolderSync(account.id,"INBOX",report([sync]));
    Persistence.prototype.append = function(writes) { commands.push(...writes.map(row=>row.sql)); return original.append.call(this,writes); };
    const indexed = () => commands.filter(sql=>/\b(?:INSERT INTO|DELETE FROM) message_fts(?:_doc)?\b/.test(sql));
    for(const extra of [{},{unread:true},{starred:true},{to:["other@fixture.invalid"]},{bodyWarning:"Synthetic MIME warning"}]) {
      commands=[]; db.applyFolderSync(account.id,"INBOX",report([{...sync,...extra}]));
      assert.equal(indexed().length,0,"unchanged indexed content must not rewrite search terms");
      assert.ok(commands.length>0,"mail changes must still use the durable journal");
    }
    for(const extra of [{subject:"Changed subject"},{from:"changed@fixture.invalid"},{textBody:"replacementneedle new durable text"},{htmlBody:"<p>Changed HTML</p>"},{snippet:"Changed fallback snippet"}]) {
      commands=[]; db.applyFolderSync(account.id,"INBOX",report([{...sync,...extra}]));
      assert.ok(indexed().length>0,"every changed indexed field must update search");
    }
    db.applyFolderSync(account.id,"INBOX",report([{...sync,textBody:"replacementneedle new durable text"}]));
    assert.ok(db.searchMessages({query:"replacementneedle",accountId:account.id}).some(row=>row.id==="performance-100"));
    const SQLite = require("better-sqlite3"), damaged = new SQLite(db.file()+".live");
    try {damaged.prepare("DELETE FROM message_fts_doc WHERE message_id = ?").run("performance-100");} finally {damaged.close();}
    commands=[];
    db.applyFolderSync(account.id,"INBOX",report([{...sync,textBody:"replacementneedle new durable text"}]));
    assert.ok(indexed().length>0,"an unchanged row with a missing search document must be repaired");
    await db.close(); await engine.init();
    assert.equal(db.messageById("performance-100").text_body,"replacementneedle new durable text");
    assert.ok(db.searchMessages({query:"replacementneedle",accountId:account.id}).some(row=>row.id==="performance-100"),"search survives durable journal replay");
    const diagnostics = JSON.stringify(perf.snapshot());
    for(const privateText of [account.email,directory,"replacementneedle","Synthetic subject","changed@fixture.invalid"]) assert.ok(!diagnostics.includes(privateText));
    assert.ok(perf.snapshot().stages.some(row=>row.stage==="db.thread.headers"));
    // Stub before requiring mac-secrets so no actual Keychain command can run.
    const child = require("node:child_process"), originalSpawn = child.spawnSync;
    try {
      let reply = {status:0,stdout:"synthetic-private-credential\n"};
      child.spawnSync = () => reply;
      delete require.cache[require.resolve("../host/mail/mac-secrets")];
      const mac = require("../host/mail/mac-secrets");
      assert.equal(mac.getPassword("synthetic-private-account"),"synthetic-private-credential");
      reply={status:1,stderr:"Synthetic private Keychain denial"};
      assert.equal(mac.getPassword("synthetic-private-account"),null);
      assert.throws(()=>mac.setPassword("synthetic-private-account","synthetic-private-value"),/Synthetic private Keychain denial/);
      assert.ok(!JSON.stringify(perf.snapshot()).includes("synthetic-private"));
      assert.ok(perf.snapshot().stages.some(row=>row.stage==="keychain.wait"));
    } finally { child.spawnSync=originalSpawn; delete require.cache[require.resolve("../host/mail/mac-secrets")]; }
    const intervals = {set:global.setInterval,clear:global.clearInterval};
    const lines = []; let flush,unref=false;
    try {
      global.setInterval = (callback,delay) => {assert.equal(delay,30000);flush=callback;return{unref(){unref=true;}};};
      global.clearInterval = () => {};
      perf.startMonitoring(line=>lines.push(line)); assert.ok(unref);
      perf.startMonitoring(()=>{throw new Error("monitor must start only once");});
      flush();
      assert.ok(lines.length>1&&lines.length<=19);
      assert.ok(lines.every(line=>line.length<400),"summaries must fit bounded Debug lines");
      assert.ok(lines.some(line=>JSON.parse(line).stage==="main.loop"));
      for(const privateText of [account.email,directory,"replacementneedle","Synthetic subject","synthetic-private"]) assert.ok(!lines.join(" ").includes(privateText));
      assert.deepEqual(perf.snapshot().stages,[],"a report resets the finite stage aggregates");
    } finally {perf.stopMonitoring();global.setInterval=intervals.set;global.clearInterval=intervals.clear;}
    console.log("mail-performance-ok: metadata parity/Unicode, cached open, unchanged-index journal evidence, changed-field search/recovery, bounded private timings and fake Keychain");
  } finally {
    perf.stopMonitoring(); Persistence.prototype.append=original.append; remote.withClient=original.withClient; db.selectMessages=original.select;
    await db.close(); global.fetch=originalFetch;
    for(const key of ["MORROW_MAIL_DIR","MORROW_USER_DATA","MORROW_AI_CONFIG_DIR","MORROW_MAIL_SECRETS","MORROW_PERF"]){
      if(environment[key]===undefined)delete process.env[key];else process.env[key]=environment[key];
    }
    fs.rmSync(directory,{recursive:true,force:true});
  }
}
module.exports={run};
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1;});
