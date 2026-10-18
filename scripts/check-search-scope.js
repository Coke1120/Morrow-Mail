const assert=require('node:assert/strict');
const {renderer}=require('./check-ux-workflows');
async function run(){
  const ui=renderer();
  ui.run(`state.accounts=[{id:'a',email:'alpha@example.test'},{id:'b',email:'beta@example.test'}];
    state.accountId='a';state.emails=[{id:'one',accountId:'a',threadId:'t'},{id:'two',accountId:'b'}];state.selectedIds=['one','two'];
    globalThis.calls=[];
    call=async(channel,params)=>{ calls.push({channel,params}); return [{id:'one',accountId:'a',threadId:'t'},{id:'other-folder',accountId:'a',threadId:'t'}]; };
  `);
  assert.match(ui.run('selectionScopeCopy(selectionMoveMessages())'),/1 messages from alpha@example.test.*1 excluded.*stay selected/);
  const review=await ui.run(`reviewedRemoval([{id:'one',accountId:'a',threadId:'t',members:[{id:'one'},{id:'other-folder'}]}],'archive')`);
  assert.equal(review.rows.length,2);
  assert.match(review.detail.scope,/Conversation view.*2 downloaded messages.*unselected/);
  assert.equal(review.calls[0].channel,'mail:archiveBatch');
  assert.equal(review.calls[0].params.threadId,undefined,'reviewed IDs freeze conversation scope');
  ui.context.review=review;
  assert.match(ui.run(`bulkConfirmCopy('trash',review.rows.length,review.detail).body`),/2 downloaded messages/);
  ui.run(`askConfirm=async()=>({ok:false});`);
  await ui.run(`applyBulkMove(state.emails,{kind:'imap',id:'Archive',accountId:'a'},'Archive')`);
  assert.equal(ui.run(`calls.filter(row=>row.channel!=='mail:listThreadMessages').length`),0,'cancel performs no provider write');
  console.log('search-scope-ok');
}
module.exports={run};
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
