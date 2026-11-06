// Synthetic first-party renderer and provider protocol checks; no real accounts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { renderer } = require('./check-ux-workflows');
const provider = require('../host/mail/provider-api');
const tick = () => new Promise(resolve => setImmediate(resolve));

function view(t) {
  const window = new JSDOM(fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8'), { url: 'https://fixture.invalid' }).window;
  t.after(() => window.close());
  const ui = renderer({ window, document: window.document, localStorage: window.localStorage, Event: window.Event, Node: window.Node });
  ui.run(`state.accounts=['a','b'].map(id=>({id,email:id+'@fixture.invalid',platform:'imap',imapSmtpProfile:'gmail',bodyEpoch:1,
    folders:{primary:[{id:'INBOX',name:'Inbox'}],more:[]}}));state.accountId='a';
    state.providerFolders={accountId:'a',api:true,folders:[{id:'shared-id',name:'User label',type:'user',editable:true}]};
    globalThis.calls=[];globalThis.confirmReady=null;confirmsBefore=()=>true;
    askConfirm=()=>new Promise(resolve=>confirmReady=resolve);
    call=async(channel,payload)=>{calls.push({channel,payload});return {}};
    globalThis.realFolderLoader=loadProviderFolders;loadProviderFolders=async()=>{};`);
  return { ui, json: code => JSON.parse(ui.run('JSON.stringify(' + code + ')')) };
}

for (const action of ['Delete', 'Rename']) {
  for (const change of ['switch', 'away-and-back', 'reconnect', 'folder-rename']) {
    test(`${action} confirmation rejects ${change} without issuing any folder write`, async t => {
      const f = view(t);
      const pending = f.ui.run(`confirm${action}Folder(state.providerFolders.folders[0],'gmail')`);
      await tick(); assert.equal(f.ui.run('typeof confirmReady'), 'function');
      if (change === 'switch') f.ui.run("state.accountId='b';++accountGen");
      if (change === 'away-and-back') f.ui.run("state.accountId='b';++accountGen;state.accountId='a';++accountGen");
      if (change === 'reconnect') f.ui.run('state.accounts[0].bodyEpoch++');
      if (change === 'folder-rename') f.ui.run("state.providerFolders.folders[0].name='Changed externally'");
      f.ui.run("confirmReady({ok:true,name:'Renamed'})");
      await assert.rejects(pending, /mailbox or folder changed/);
      assert.deepEqual(f.json('calls'), []);
    });
  }
}

test('a reviewed unchanged rename sends its captured account id and folder identity', async t => {
  const f = view(t), pending = f.ui.run("confirmRenameFolder(state.providerFolders.folders[0],'gmail')");
  f.ui.run("confirmReady({ok:true,name:'Renamed'})"); await pending;
  assert.deepEqual(f.json('calls'), [{ channel: 'mail:renameProviderFolder', payload: { accountId: 'a', folderId: 'shared-id', name: 'Renamed' } }]);
});

test('stale account-bound creation cannot use a newly selected account', async t => {
  const f = view(t); f.ui.run("globalThis.owner=folderActionOwner();state.accountId='b';++accountGen");
  await assert.rejects(f.ui.run("createProviderFolder('New','',owner)"), /mailbox or folder changed/);
  assert.deepEqual(f.json('calls'), []);
});

test('out-of-order provider lists after A→B→A cannot install the old visit or retire the newer pending request', async t => {
  const f = view(t);
  f.ui.run(`loadProviderFolders=realFolderLoader;
    globalThis.reads=[];call=(channel,payload)=>new Promise(resolve=>reads.push({payload,resolve}));state.view='mail';`);
  const old = f.ui.run('loadProviderFolders(accountGen)'); await tick();
  f.ui.run("state.accountId='b';++accountGen"); const other = f.ui.run('loadProviderFolders(accountGen)'); await tick();
  f.ui.run("state.accountId='a';++accountGen"); const current = f.ui.run('loadProviderFolders(accountGen)'); await tick();
  assert.equal(f.ui.run('reads.length'), 3);
  f.ui.run("reads[2].resolve({api:true,revision:'current',folders:[]})"); await current;
  f.ui.run("reads[0].resolve({api:true,revision:'old',folders:[]});reads[1].resolve({api:true,revision:'other',folders:[]})");
  await Promise.all([old, other]);
  assert.equal(f.ui.run('state.providerFolders.revision'), 'current');
  assert.equal(f.ui.run('providerFolderPending.size'), 0);
});

test('Gmail deletion checks the current provider type, including future system ids, before any DELETE', async () => {
  for (const type of ['system', undefined]) {
    const calls = [];
    const fetcher = async (url, options = {}) => { calls.push({ url, method: options.method || 'GET' }); return new Response(JSON.stringify({ labels: [{ id: 'future-system-id', name: 'Protected', type }] }), { status: 200 }); };
    await assert.rejects(provider.deleteLabel('synthetic', 'future-system-id', fetcher), /current user label/);
    assert.deepEqual(calls.map(c => c.method), ['GET']);
  }
});

test('the irreversible Graph folder DELETE helper is disabled without sending any HTTP request', async () => {
  let calls = 0;
  await assert.rejects(provider.deleteMailFolder('synthetic', 'opaque-system-or-user-id', async () => { calls++; }), /Irreversible Outlook folder deletion is disabled/);
  assert.equal(calls, 0);
});
