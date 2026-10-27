"use strict";

// Same synthetic host/renderer harness for baseline and candidate. No native
// app/window, provider request, user profile or actual credential is involved.
const path=require("node:path");
const {performance}=require("node:perf_hooks");
const {hostChecks,uiFixture}=require("./check-mail-phase-two");
async function run(){
  const index=process.argv.indexOf("--source-root");
  const root=path.resolve(index<0?path.join(__dirname,".."):process.argv[index+1]);
  const host=await hostChecks(root,false),ui=uiFixture(root);
  const began=performance.now();
  ui.run(`for(let n=0;n<1000;n++)applyBodyUpdate({email:{id:'unopened-'+n,accountId:'a',bodyEpoch:0,bodyVersion:n+1,textBody:('synthetic '+n+' ').padEnd(8192,'x'),bodyComplete:true}});`);
  const rendererMs=performance.now()-began;
  const retained=ui.run(`({entries:latestBodies.size,stringBytes:[...latestBodies.values()].reduce((sum,value)=>{
    const body=value.body||value;return sum+2*(String(body.htmlBody||'').length+String(body.textBody||'').length);
  },0),reloads})`);
  console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,
    fixture:{messages:240,listRows:200,unopenedEvents:1000,bodyCharacters:8192,listWarmups:2,listRounds:12},...host,
    rendererBurstMs:Math.round(rendererMs*100)/100,retained,
    limits:"Synthetic Linux host/SQLite calls and VM renderer functions, not native Mac timing. Renderer burst uses full compatibility events to compare retention; production candidate sends lightweight availability notices. Query counts include synchronous work before the list RPC returns. Burst times include fixture construction and are not an end-to-end UI metric."},null,2));
}
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1;});
