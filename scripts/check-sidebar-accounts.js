const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { JSDOM } = require('jsdom');
const { renderer } = require('./check-ux-workflows');
const collapse = require('../shared/folder-collapse');
const GET = 'morrow:configGetSidebarAccountFoldersExpanded';
const SET = 'morrow:configSetSidebarAccountFoldersExpanded';
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, legacy = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-sidebar-accounts-'));
  const previous = process.env.MORROW_USER_DATA;
  process.env.MORROW_USER_DATA = dir;
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(legacy));
  const settings = require('../host/settings');
  const window = new JSDOM(fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8'), { url: 'https://fixture.invalid' }).window;
  const calls = [];
  window.morrow = { on() {}, invoke: async (channel, payload) => {
    calls.push({ channel, payload });
    return settings.answer(channel, [payload]);
  } };
  const accounts = ['custom', 'yahoo', 'gmail', 'gmail', 'outlook', 'outlook'].map((profile, i) => ({
    id: 'box-' + i, email: `box-${i}@example.invalid`, platform: 'imap', imapSmtpProfile: profile,
    folders: { primary: [{ id: 'INBOX', name: 'Inbox', wellKnownName: 'inbox' }], more: [
      { id: 'Reports', name: 'Reports' }, { id: 'Reports/Annual', name: 'Annual' },
    ] }, delimiter: '/',
  }));
  const ui = renderer({ window, document: window.document, localStorage: window.localStorage,
    Event: window.Event, Node: window.Node, fixtureAccounts: accounts, morrowFolderCollapse: collapse });
  ui.run(`state.accounts=fixtureAccounts; state.accountId='box-0';
    refreshMailVacation=renderSettingsAccounts=applyLook=applyLayoutPanes=()=>{};`);
  t.after(() => {
    window.close();
    if (previous === undefined) delete process.env.MORROW_USER_DATA;
    else process.env.MORROW_USER_DATA = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const heading = id => window.document.querySelector(`[data-nav-key="account:${id}"]`);
  const runKey = (id, key) => {
    const node = heading(id); node.focus();
    ui.context.keyTarget = node;
    ui.context.keyValue = key;
    ui.run(`onFolderNavKey({target:keyTarget,key:keyValue,preventDefault(){},stopPropagation(){}})`);
  };
  const json = code => JSON.parse(ui.run(`JSON.stringify(${code})`));
  return { ui, window, calls, settings, accounts, heading, runKey, json, dir };
}

test('legacy defaults migrate lazily; per-account writes preserve siblings, survive restart and validate payloads through preload', async t => {
  const f = fixture(t, { sidebarGmailFoldersExpanded: false, sidebarOutlookFoldersExpanded: true });
  let api;
  vm.runInNewContext(fs.readFileSync(require.resolve('../renderer/preload'), 'utf8'), {
    require: name => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
        ipcRenderer: { invoke: async (channel, value) => f.settings.answer(channel, [value]) } };
    },
  });
  assert.deepEqual(await api.invoke(GET), {});
  await f.ui.run('loadShellPrefs();');
  f.ui.run('renderAccounts()');
  assert.deepEqual(f.accounts.map(a => f.heading(a.id).getAttribute('aria-expanded')), ['true','true','false','false','true','true']);
  assert.equal(fs.readFileSync(path.join(f.dir, 'settings.json'), 'utf8').includes('sidebarAccountFoldersExpanded'), false, 'reading legacy state does not write preferences');
  await api.invoke(SET, { accountId: 'box-2', expanded: true });
  await api.invoke(SET, { accountId: 'box-0', expanded: false });
  assert.deepEqual(await api.invoke(GET), { 'box-2': true, 'box-0': false });
  const restart = spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(require('./host/settings').answer('${GET}',[])))`], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(restart.status, 0, restart.stderr);
  assert.deepEqual(JSON.parse(restart.stdout), { 'box-2': true, 'box-0': false });
  await api.invoke(SET, { accountId: 'box-2', expanded: false });
  f.settings.answer('morrow:configSetSidebarGmailFoldersExpanded', [true]);
  await f.ui.run('loadShellPrefs()');
  f.ui.run('renderAccounts()');
  assert.equal(f.heading('box-0').getAttribute('aria-expanded'), 'false');
  assert.equal(f.heading('box-2').getAttribute('aria-expanded'), 'false', 'an explicit choice overrides a later legacy default change');
  assert.equal(f.heading('box-3').getAttribute('aria-expanded'), 'true', 'legacy control remains a default for accounts without an override');
  for (const value of [null, {}, {accountId:'__proto__',expanded:false}, {accountId:'box-0',expanded:'false'}, {accountId:'x'.repeat(201),expanded:true}]) {
    await assert.rejects(api.invoke(SET, value), /mailbox id/);
  }
  await assert.rejects(api.invoke('morrow:configSetUnknown', {}), /Unsupported channel/);
  assert.deepEqual(collapse.normalizeAccountExpanded(JSON.parse('{"__proto__":false,"valid":true,"wrong":"false"}')), {valid:true});
});

test('every provider has a keyboard button; filter expansion and Collapse All preserve individual choices', async t => {
  const f = fixture(t);
  f.ui.run('state.prefs.outlookOpen=true;renderAccounts()');
  assert.equal(f.window.document.querySelectorAll('#folders button[data-nav-kind="account"]').length, 6);
  assert.equal(f.window.document.querySelectorAll('#folders h2').length, 0);
  f.runKey('box-1', 'ArrowLeft'); await tick();
  assert.equal(f.heading('box-1').getAttribute('aria-expanded'), 'false');
  assert.equal(f.window.document.activeElement, f.heading('box-1'));
  assert.equal(f.heading('box-0').getAttribute('aria-expanded'), 'true');
  f.runKey('box-1', 'ArrowRight'); await tick();
  assert.equal(f.heading('box-1').getAttribute('aria-expanded'), 'true');
  f.runKey('box-1', 'ArrowRight');
  assert.equal(f.window.document.activeElement.dataset.accountId, 'box-1');
  await f.ui.run("toggleAccountFolders('box-2')");
  assert.equal(f.heading('box-2').getAttribute('aria-expanded'), 'false');
  assert.equal(f.heading('box-3').getAttribute('aria-expanded'), 'true', 'same-provider accounts stay independent');
  f.window.document.getElementById('folder-filter').value = 'Annual';
  f.ui.run('renderAccounts()');
  assert.equal(f.heading('box-2').getAttribute('aria-expanded'), 'true');
  const before = f.calls.filter(c=>c.channel===SET).length;
  f.runKey('box-2', 'ArrowLeft'); f.heading('box-2').click(); await tick();
  assert.equal(f.calls.filter(c=>c.channel===SET).length, before, 'filter only expands the displayed matches');
  f.window.document.getElementById('folder-filter').value = '';
  f.ui.run('renderAccounts()');
  assert.equal(f.heading('box-2').getAttribute('aria-expanded'), 'false');
  const choices = f.json('state.prefs.accountExpanded');
  await f.ui.run('collapseAllFolders()');
  assert.deepEqual(f.json('state.prefs.accountExpanded'), choices);
  assert.equal(f.heading('box-3').getAttribute('aria-expanded'), 'true');
  assert.equal(f.window.document.querySelector('[data-account-id="box-3"][data-folder-id="Reports/Annual"]'), null);
});

test('reordered acknowledgements preserve other accounts and the latest choice for one account', async t => {
  const f = fixture(t);
  const requests = [];
  f.window.morrow.invoke = (channel, payload) => {
    if (channel !== SET) return Promise.resolve(f.settings.answer(channel, [payload]));
    const saved = f.settings.answer(channel, [payload]);
    return new Promise(resolve => requests.push({ resolve, saved }));
  };
  const first = f.ui.run("toggleAccountFolders('box-0')");
  const second = f.ui.run("toggleAccountFolders('box-1')");
  requests[1].resolve(requests[1].saved); await second;
  requests[0].resolve(requests[0].saved); await first;
  assert.deepEqual(f.json('state.prefs.accountExpanded'), {'box-0':false,'box-1':false});
  const older = f.ui.run("toggleAccountFolders('box-0')");
  const newer = f.ui.run("toggleAccountFolders('box-0')");
  requests[3].resolve(requests[3].saved); await newer;
  requests[2].resolve(requests[2].saved); await older;
  assert.equal(f.ui.run("state.prefs.accountExpanded['box-0']"), false);
  assert.equal(f.heading('box-1').getAttribute('aria-expanded'), 'false');
});

test('failed save restores that account and a stale preference read cannot overwrite a newer choice', async t => {
  const f = fixture(t);
  f.window.morrow.invoke = async (channel, payload) => {
    if (channel === SET && payload.accountId === 'box-0') throw new Error('Synthetic save failure');
    return f.settings.answer(channel, [payload]);
  };
  await Promise.all([f.ui.run("toggleAccountFolders('box-0')"), f.ui.run("toggleAccountFolders('box-1')")]);
  assert.equal(f.heading('box-0').getAttribute('aria-expanded'), 'true');
  assert.equal(f.heading('box-1').getAttribute('aria-expanded'), 'false');
  let release;
  f.window.morrow.invoke = (channel, payload) => {
    if (channel === GET) return new Promise(resolve => { release = resolve; });
    return Promise.resolve(f.settings.answer(channel, [payload]));
  };
  const read = f.ui.run('loadShellPrefs()');
  for (let i=0;i<50&&!release;i++) await tick();
  assert.ok(release);
  await f.ui.run("toggleAccountFolders('box-0')");
  release({}); await read;
  assert.equal(f.ui.run("state.prefs.accountExpanded['box-0']"), false);
  assert.equal(f.ui.run("state.prefs.accountExpanded['box-1']"), false);
});

test('address-first identity is shared by every provider and Local Folders; refreshed labels repaint without changing stored identity', t => {
  const f = fixture(t);
  f.accounts[0].name = 'Backup mailbox';
  f.accounts[1].label = 'Personal';
  f.accounts[2].mailTransport = 'gmail_api';
  f.ui.run(`state.localAccount={id:'__morrow_local__',isLocal:true,name:'Local Folders',email:'Local Folders',folders:{primary:[],more:[]}};renderAccounts()`);
  const details = ['Backup mailbox · IMAP','Personal · Yahoo','Gmail','Gmail','Outlook','Outlook'];
  for (const [index, account] of f.accounts.entries()) {
    const heading = f.heading(account.id);
    assert.equal(heading.querySelector('.account-address').textContent, account.email);
    assert.equal(heading.querySelector('.account-detail').textContent, details[index]);
    assert.equal(heading.getAttribute('aria-description'), details[index]);
    assert.match(heading.getAttribute('aria-label'), new RegExp(account.email.replaceAll('.', '\\.')));
    assert.equal(heading.querySelector('.folder-twist-mark').getAttribute('aria-hidden'), 'true');
  }
  const local = f.heading('__morrow_local__');
  assert.equal(local.querySelector('.account-address').textContent, 'Local Folders');
  assert.equal(local.querySelector('.account-detail').textContent, 'On this computer');
  assert.equal(f.window.document.querySelectorAll('.local-folder-actions button').length, 2);
  f.accounts[0].name = 'Changed 名称';
  f.ui.run('renderAccounts()');
  assert.equal(f.heading('box-0').querySelector('.account-detail').textContent, 'Changed 名称 · IMAP');
  assert.equal(f.accounts[0].email, 'box-0@example.invalid');
});

test('Gmail reserved labels get readable text while custom names, raw identities, counts and real hierarchy remain intact', async t => {
  const f = fixture(t);
  const gmail = f.accounts[2];
  gmail.folders.more.push(
    {id:'CATEGORY_SOCIAL',name:'CATEGORY_SOCIAL',providerId:'CATEGORY_SOCIAL',unreadCount:9},
    {id:'CATEGORY_PERSONAL',name:'CATEGORY_PERSONAL',providerId:'Label_custom'},
    {id:'YELLOW_STAR',name:'YELLOW_STAR',providerId:'YELLOW_STAR'},
    {id:'Projects',name:'Projects'}, {id:'Projects/Client',name:'Projects/Client'},
  );
  const before = JSON.stringify(f.accounts);
  f.ui.run('state.prefs.gmailOpen=true;renderAccounts()');
  const row = id => f.window.document.querySelector(`button.folder[data-account-id="box-2"][data-folder-id="${id}"]`);
  assert.equal(row('CATEGORY_SOCIAL').querySelector('.name').textContent, 'Social');
  assert.equal(row('CATEGORY_SOCIAL').querySelector('.name').title, 'CATEGORY_SOCIAL');
  assert.equal(row('CATEGORY_SOCIAL').querySelector('.count').textContent, '9');
  assert.equal(row('CATEGORY_PERSONAL').querySelector('.name').textContent, 'CATEGORY_PERSONAL');
  assert.equal(row('YELLOW_STAR').querySelector('.name').textContent, 'Yellow star');
  assert.equal(row('Projects/Client').querySelector('.name').textContent, 'Client');
  assert.equal(row('Projects/Client').querySelector('.name').title, 'Projects/Client');
  assert.equal(row('Projects').getAttribute('aria-expanded'), 'true');
  assert.equal(row('Projects/Client').dataset.navParent, 'folder:box-2:Projects');
  assert.equal(row('CATEGORY_SOCIAL').getAttribute('aria-expanded'), null);
  assert.equal(JSON.stringify(f.accounts), before, 'display mapping must not rename or rewrite account/folder records');
  f.ui.run('globalThis.chosen=[];selectFolder=async(accountId,folderId)=>chosen.push({accountId,folderId})');
  row('CATEGORY_SOCIAL').click(); await tick();
  assert.deepEqual(f.json('chosen'), [{accountId:'box-2',folderId:'CATEGORY_SOCIAL'}]);
  f.window.document.getElementById('folder-filter').value = 'CATEGORY_SOCIAL'; f.ui.run('renderAccounts()');
  assert.ok(row('CATEGORY_SOCIAL'), 'original provider name remains searchable');
  f.window.document.getElementById('folder-filter').value = 'Social'; f.ui.run('renderAccounts()');
  assert.ok(row('CATEGORY_SOCIAL'), 'display name is searchable too');
});

test('metadata and unread refresh retain owner routing and custom names that resemble reserved Gmail ids', t => {
  const f = fixture(t);const account=f.accounts[2];
  account.folders.more.push({id:'YELLOW_STAR',name:'YELLOW_STAR',providerId:'Label_custom',unreadCount:1});
  f.ui.run('state.prefs.gmailOpen=true;renderAccounts()');
  const row=()=>f.window.document.querySelector('[data-account-id="box-2"][data-folder-id="YELLOW_STAR"]');
  assert.equal(row().querySelector('.name').textContent,'YELLOW_STAR');
  account.folders.more.at(-1).providerId='YELLOW_STAR'; f.ui.run('renderAccounts()');
  assert.equal(row().querySelector('.name').textContent,'Yellow star');
  const retained=row();account.folders.more.at(-1).unreadCount=7;f.ui.run('renderAccounts()');
  assert.equal(row(),retained,'count-only refresh preserves the existing focused/drag target node');
  assert.equal(row().querySelector('.count').textContent,'7');
  assert.match(row().getAttribute('aria-label'),/Yellow star, 7 unread/);
  assert.equal(row().dataset.dropId,'YELLOW_STAR');
  assert.equal(row().dataset.dropAccount,'box-2');
});
