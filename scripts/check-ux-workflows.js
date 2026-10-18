// Offline workflow regressions: real renderer functions, mocked IPC, no credentials.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
function renderer(extra = {}) {
  const context = vm.createContext({ window: { morrow: {} }, document: {}, console, setTimeout, clearTimeout, ...extra });
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8').replace(/boot\(\)\.catch\([^\n]+\);\s*$/, '');
  vm.runInContext(source, context);
  return { context, run: (code) => vm.runInContext(code, context) };
}
async function run() {
  const ui = renderer();
  ui.run(`
    state.accounts = [{id:'alpha',email:'me@alpha.test'}, {id:'beta',email:'me@beta.test'}];
    state.accountId = 'alpha';
    state.email = {id:'one',accountId:'alpha',subject:'Alpha',from:'Ada <ada@example.test>'};
    globalThis.opened = null;
    globalThis.calls = [];
    call = async (channel, payload) => {
      calls.push({channel, payload});
      return {email:{id:payload.emailId,accountId:'beta',subject:'Beta',from:'Ben <ben@example.test>',textBody:'Beta source',messageId:'<beta@test>',threadId:'beta-thread'}};
    };
    openCompose = async seed => { opened = seed; };
  `);
  await ui.run(`reviewDraft({messageId:'two',accountId:'beta',body:'Beta reply'})`);
  assert.equal(ui.run('opened.accountId'), 'beta');
  assert.equal(ui.run('opened.to'), 'Ben <ben@example.test>');
  assert.equal(ui.run('opened.subject'), 'Re: Beta');
  assert.match(ui.run('opened.quote'), /Beta source/);
  assert.equal(ui.run('opened.quoteEmail.id'), 'two');
  assert.equal(ui.run('opened.body'), 'Beta reply');
  await assert.rejects(ui.run(`reviewDraft({body:'Missing source'})`), /no source message/);
  await assert.rejects(ui.run(`reviewDraft({messageId:'two',accountId:'alpha',body:'Wrong account'})`), /source message or account/);
  ui.run(`call = async () => ({email:null})`);
  await assert.rejects(ui.run(`reviewDraft({messageId:'gone',body:'Gone'})`), /source message or account/);
  assert.ok(ui.run(`calls.every(item => item.channel === 'mail:openEmail')`));
  const bulk = renderer();
  bulk.run(`
    globalThis.hits = [];
    call = async (channel, params) => {
      hits.push(params.emailId);
      if (params.emailId === 'two') throw new Error('Second operation failed');
      return {outcomes:[{id:params.emailId,status:'completed',opId:'verified-op'}]};
    };
  `);
  const outcome = await bulk.run(`runBulk(['one','two','three'].map(emailId => ({channel:'mail:archive',params:{emailId}})))`);
  assert.deepEqual(Array.from(outcome.outcomes,row=>row.status), ['completed','unknown','not_attempted']);
  assert.deepEqual(Array.from(outcome.opIds), ['verified-op']);
  assert.equal(bulk.run('hits.length'), 2);
  bulk.context.outcome = outcome;
  assert.match(bulk.run(`receiptText('Archive',outcome)`), /1 completed.*1 unknown.*1 not attempted.*Second operation failed/);
  assert.equal(bulk.run(`receiptRows({opIds:['legacy']}, {params:{items:[{emailId:'one'},{emailId:'two'}]}}).filter(row=>row.status==='completed').length`), 0);
  assert.match(bulk.run(`botListenerStatus({enabled:true,listen:{listening:false,error:'port_in_use'}})`), /Could not start.*not listening/);
  assert.doesNotMatch(bulk.run(`botListenerStatus({enabled:true,listen:{listening:false,error:'port_in_use'}})`), /enabled|Listening on/);
  assert.equal(bulk.run(`botPermissionNames(['accounts.read','mail.headers.read','draft.proposals.create'])`), 'account details, cached mail headers, draft proposals');
  console.log('ux-workflows-ok');
}
module.exports = { run, renderer };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
