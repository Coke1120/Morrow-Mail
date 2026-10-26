const assert = require('node:assert/strict');
const {renderer} = require('./check-ux-workflows');
async function run() {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, {value:'',textContent:'',hidden:false,disabled:false,open:false,dataset:{},
      classList:{toggle(){}},focus(){},setSelectionRange(){},replaceChildren(){},appendChild(){},close(){this.open=false;},showModal(){this.open=true;}});
    return nodes.get(id);
  };
  const ui = renderer({document:{getElementById:get,querySelector:()=>null,createElement:()=>({})}});
  ui.run(`
    state.accounts = [{id:'a',email:'me@example.test',platform:'imap'}]; state.accountId='a';
    state.prefs.undoSend = 30;
    resetDraftWrite = () => {}; syncScheduleFields = () => {}; paintComposeChrome = () => {};
    paintQuoteBody = () => {}; scheduleComposeLayout = () => {};
    fillSignatures = async () => {}; loadScheduled = async () => {}; loadList = async () => {};
    globalThis.calls=[]; globalThis.failSave=false; globalThis.failSend=false;
    call = async (channel,payload) => {
      calls.push({channel,payload});
      if (channel === 'mail:getComposeContext') return {...window.morrowComposePolicy.resolve(state.accounts[0], null, {ccByDomain:{},accounts:{}}, 'new', payload.fromAddress), settings:{ccByDomain:{},accounts:{}}};
      if (channel === 'mail:upsertDraft') { if(failSave) throw new Error('Save failed; text retained'); return {draftId:'same-draft'}; }
      if (channel === 'mail:send' && failSend) throw new Error('Delivery failed');
      return {};
    };
  `);
  await ui.run('openCompose()');
  assert.equal(await ui.run('requestComposeClose()'), true, 'untouched empty compose closes directly');
  await ui.run('openCompose()');
  get('compose-to').value='recipient@example.test'; get('compose-body').value='Keep this text';
  let closing = ui.run('requestComposeClose()');
  assert.equal(get('compose-close-review').open,true);
  get('draft-close-keep').onclick();
  assert.equal(await closing,false);
  assert.equal(get('compose-body').value,'Keep this text');
  assert.equal(ui.run(`calls.filter(x=>x.channel==='mail:upsertDraft'||x.channel==='mail:send').length`),0);
  closing=ui.run('requestComposeClose()'); get('draft-close-discard').onclick();
  assert.equal(await closing,true);
  assert.equal(ui.run(`calls.filter(x=>x.channel==='mail:upsertDraft'||x.channel==='mail:send'||x.channel==='mail:scheduleSend').length`),0, 'Close discards and does not save');
  await ui.run('openCompose()');
  get('compose-to').value='recipient@example.test'; get('compose-body').value='Keep this text';
  await ui.run('saveDraft()');
  assert.equal(ui.run('state.draftId'),'same-draft');
  assert.equal(ui.run(`calls.filter(x=>x.channel==='mail:send'||x.channel==='mail:scheduleSend').length`),0);
  await ui.run(`openCompose({draftId:'same-draft',accountId:'a',to:'recipient@example.test',body:'Resume text',inReplyTo:'original'})`);
  get('compose-body').value='Edited same draft';
  ui.run('failSave=true');
  assert.equal(await ui.run('saveDraft()'), false);
  assert.match(get('compose-status').textContent,/Save failed/);
  assert.equal(get('compose').open,true);
  closing=ui.run('requestComposeClose()');
  assert.equal(get('compose-close-review').open,true);
  get('draft-close-keep').onclick();
  assert.equal(await closing,false);
  assert.equal(ui.run(`calls.filter(x=>x.channel==='mail:send').length`),0);
  await ui.run('sendMail()');
  assert.equal(get('compose').open,false);
  await ui.run('openCompose()');
  assert.equal(get('compose-body').value,'Edited same draft','new compose cannot replace a pending send');
  ui.run('cancelUndoSend()');
  assert.equal(get('compose').open,true);
  assert.equal(ui.run('state.draftId'),'same-draft');
  assert.equal(ui.run('state.composeMeta.inReplyTo'),'original');
  assert.equal(ui.run(`calls.filter(x=>x.channel==='mail:send').length`),0);
  ui.run('state.prefs.undoSend=0; failSend=true');
  await ui.run('sendMail()');
  assert.equal(get('compose').open,true);
  assert.equal(get('compose-body').value,'Edited same draft');
  assert.equal(ui.run('state.draftId'),'same-draft');
  assert.match(get('compose-status').textContent,/Delivery was not confirmed/);
  closing=ui.run('requestComposeClose()'); get('draft-close-discard').onclick(); assert.equal(await closing,true);
  await ui.run(`openCompose({to:'recipient@example.test',body:'Schedule once'})`);
  await ui.run('scheduleMail()'); await ui.run('scheduleMail()'); await ui.run('sendMail()');
  assert.equal(ui.run(`calls.filter(x=>x.channel==='mail:scheduleSend').length`),1);
  assert.equal(get('compose-send').disabled,true);
  assert.equal(get('compose-schedule').disabled,true);
  ui.run(`state.draftWrite={pending:false,text:'Late AI response',base:'',previous:''};paintDraft()`);
  assert.equal(get('compose-body').value,'Schedule once','late AI completion cannot change a queued receipt');
  assert.equal(get('ai-generate').disabled,true);
  assert.equal(ui.run(`calls.filter(x=>x.channel==='mail:send').length`),1);
  await ui.run('requestComposeClose()');
  ui.run(`call=async(channel,payload)=>channel==='mail:getComposeContext'
    ? {...window.morrowComposePolicy.resolve(state.accounts[0], null, {ccByDomain:{},accounts:{}}, 'new', payload.fromAddress), settings:{ccByDomain:{},accounts:{}}}
    : {email:{id:payload.emailId,isDraft:true,bodyComplete:true,accountId:'a',fromAddress:state.accounts[0].email,to:['recipient@example.test'],subject:'Saved',textBody:'Saved body',inReplyTo:'source',threadId:'thread'}}`);
  await ui.run(`resumeDraft({id:'saved-id',accountId:'a'})`);
  assert.equal(ui.run('state.draftId'),'saved-id');
  assert.equal(get('compose-body').value,'Saved body');
  assert.equal(ui.run('state.composeMeta.inReplyTo'),'source');
  console.log('compose-recovery-ok');
}
module.exports={run};
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
