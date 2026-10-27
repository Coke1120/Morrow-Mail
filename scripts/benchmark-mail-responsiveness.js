"use strict";

// Repeatable host/SQLite benchmark, never a user's profile. Pass --source-root
// to compare a pinned baseline archive using the same fixture and harness.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { performance } = require("node:perf_hooks");
const fixture = require("./mail-performance-fixture");
const args = process.argv.slice(2);
function option(name, fallback) { const index=args.indexOf(name); return index<0?fallback:args[index+1]; }
function bounded(name, fallback, min, max) {
  const value=Number(option(name,fallback));
  assert.ok(Number.isInteger(value)&&value>=min&&value<=max,`${name} must be ${min}–${max}`); return value;
}
const mib = value => Math.round(value/1048576*100)/100;
const rounded = value => Math.round(value*100)/100;

async function run() {
  const root=path.resolve(option("--source-root",path.join(__dirname,"..")));
  const count=bounded("--messages",10000,100,50000),threadCount=bounded("--thread",256,2,1000),iterations=bounded("--iterations",12,3,30);
  assert.ok(threadCount<count);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"morrow-perf-benchmark-"));
  Object.assign(process.env,{MORROW_MAIL_DIR:directory,MORROW_USER_DATA:directory,MORROW_AI_CONFIG_DIR:directory,MORROW_MAIL_SECRETS:"memory"});
  delete process.env.MORROW_PERF; // Compare ordinary production paths, not tracing overhead.
  global.fetch=async()=>{throw new Error("Live provider calls forbidden in benchmark");};
  const engine=require(path.join(root,"host/mail/engine")),db=require(path.join(root,"host/mail/db")),remote=require(path.join(root,"host/mail/remote"));
  remote.withClient=async()=>{throw new Error("Live mailbox calls forbidden in benchmark");};
  const query={accountId:fixture.account.id,folderId:"INBOX",limit:200};
  const ask=async(channel,input)=>{
    const result=await engine.answer(channel,[input]);assert.equal(result.success,true,JSON.stringify(result));return result.data;
  };
  const samples=[];
  let maxSampledRss=0;
  async function measure(name,work,rounds=iterations) {
    for(let n=0;n<2;n++)await work();
    global.gc?.();
    const times=[];
    for(let n=0;n<rounds;n++){
      const began=performance.now();await work();times.push(performance.now()-began);
      maxSampledRss=Math.max(maxSampledRss,process.memoryUsage().rss);
      await new Promise(resolve=>setImmediate(resolve));
    }
    times.sort((a,b)=>a-b);
    samples.push({name,rounds,p50Ms:rounded(times[Math.ceil(rounds*.5)-1]),p95Ms:rounded(times[Math.ceil(rounds*.95)-1]),maxMs:rounded(times.at(-1))});
  }
  try {
    await engine.init();
    const profile=fixture.seed(db,{count,threadCount});
    const rich=Array.from({length:1000},(_,n)=>`syntheticterm${n}`).join(" ");
    const batch=Array.from({length:40},(_,index)=>fixture.message(index+1,{textBody:rich,htmlBody:`<p>${rich}</p>`}));
    db.applyFolderSync(fixture.account.id,"INBOX",fixture.report(batch));
    await db.checkpoint();
    const bodyBytes=rows=>rows.reduce((sum,row)=>sum+Buffer.byteLength(row.html_body||"")+Buffer.byteLength(row.text_body||""),0);
    const materializedBodyBytes={list200:bodyBytes(db.selectMessages(query,{headersOnly:true})),
      threadHeaders:bodyBytes(db.messagesByThread(fixture.account.id,"long-thread",{headersOnly:true}))};
    await measure("cached-list-200",()=>ask("mail:listFromCache",query));
    await measure("thread-headers",()=>ask("mail:listThreadMessages",{accountId:fixture.account.id,threadId:"long-thread",headersOnly:true}));
    await measure("cached-message-open",()=>ask("mail:openEmail",{emailId:profile.openId}));
    await measure("reopen-and-first-list",async()=>{await db.close();await engine.init();await ask("mail:listFromCache",query);},3);
    // This includes durable journal/fsync costs; no persistence bypass is used.
    await measure("unchanged-sync-40",()=>db.applyFolderSync(fixture.account.id,"INBOX",fixture.report(batch)));
    console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,profile,iterations,
      materializedBodyBytes,maxSampledRssMiB:mib(maxSampledRss),samples,
      limits:"Synthetic host/SQLite calls on this machine; no Electron rendering, actual Mac profiling, Keychain or provider timing. Sampled RSS is not a peak-memory measurement. Reopen uses a warm OS cache."},null,2));
  } finally {await db.close();fs.rmSync(directory,{recursive:true,force:true});}
}
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1;});
