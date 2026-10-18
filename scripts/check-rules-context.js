const assert=require('node:assert/strict');
const {renderer}=require('./check-ux-workflows');
async function run(){
 const ui=renderer();
 ui.run(`state.accounts=[{id:'a',email:'alpha@example.test'},{id:'b',email:'beta@example.test'}];state.accountId='a';
   globalThis.requests={};globalThis.calls=[];globalThis.fields={name:'Rule',from:'news@'};
   paintInboxRules=()=>{};inboxRuleFieldsFromForm=()=>fields;setInboxRulesBusy=value=>{inboxRulesBusy=value;};showInboxRuleStatus=()=>{};
   clearInboxRuleForm=()=>{inboxRuleEditId='';};
   call=async(channel,params)=>{calls.push({channel,params});return new Promise(resolve=>{requests[params.accountId]=resolve;});};
 `);
 const first=ui.run('loadInboxRules()');
 ui.run(`inboxRulesAccountId='b'`);const second=ui.run('loadInboxRules()');
 ui.run(`requests.b({accountId:'b',api:true,backend:'imap',rules:[],destinations:[]})`);await second;
 ui.run(`requests.a({accountId:'a',api:true,backend:'gmail',rules:[],destinations:[]})`);await first;
 assert.equal(ui.run('inboxRulesState.accountId'),'b','late account A response must not overwrite account B');
 ui.run(`state.accountId='a';calls=[];inboxRuleEditId='beta-rule';
   call=async(channel,params)=>{calls.push({channel,params});return {accountId:'b',api:true,backend:'imap',rules:[],destinations:[]};};
 `);
 await ui.run('submitInboxRule({preventDefault(){}})');
 assert.equal(ui.run(`calls.find(row=>row.channel==='mail:saveInboxRule').params.accountId`),'b','save uses displayed rules mailbox, not sidebar');
 assert.equal(ui.run(`calls.find(row=>row.channel==='mail:saveInboxRule').params.rule.id`),'beta-rule');
 ui.run(`inboxRuleBaseline=JSON.stringify({name:'Old'});fields={name:'Unsaved',from:'old@'};askConfirm=async()=>({ok:false});$=()=>({value:''});`);
 const count=ui.run('calls.length');await ui.run(`changeInboxRulesAccount('a')`);
 assert.equal(ui.run('inboxRulesAccountId'),'b');assert.equal(ui.run('calls.length'),count,'canceling dirty account change makes no call');
 ui.run(`inboxRulesState.accountId='a';calls=[];`);await ui.run('submitInboxRule({preventDefault(){}})');assert.equal(ui.run('calls.length'),0,'unbound editor cannot save');
 console.log('rules-context-ok');
}
module.exports={run};
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
