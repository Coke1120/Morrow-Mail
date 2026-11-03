// Real DOM events and renderer paths with synthetic mail; no live accounts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { renderer } = require('./check-ux-workflows');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, layout = 'window', role = '') {
  const window = new JSDOM(fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8'), { url: 'https://fixture.invalid' }).window;
  t.after(() => window.close());
  window.document.documentElement.dataset.window = role;
  window.morrowMailColumns = require('../shared/mail-columns');
  const ui = renderer({ window, document: window.document });
  ui.run(`
    state.accounts = [{id:'alpha',email:'self@alpha.test'}, {id:'beta',email:'self@beta.test'}];
    state.accountId = 'alpha'; state.prefs.conversation = false;
    state.prefs.mailView = {layout:${JSON.stringify(layout)}};
    state.emails = [{id:'one',accountId:'alpha',subject:'First',from:'a@fixture.test',textBody:'first body'},
      {id:'two',accountId:'beta',subject:'Second',from:'b@fixture.test',hasBody:true}];
    state.email = {...state.emails[0]}; state.thread = [];
    globalThis.realGuard = guard; globalThis.calls = []; globalThis.composes = []; globalThis.errors = []; globalThis.jobs = [];
    renderList = () => {}; renderReader = () => {}; paintReaderPending = () => {};
    setRead = async () => {}; noteBody = () => {}; preferBody = email => email; pumpBodyRefreshes = () => {};
    presentCompose = async seed => { composes.push(seed); };
    guard = fn => { const job = Promise.resolve().then(fn).catch(e => errors.push(e.message)); jobs.push(job); return job; };
    call = async (channel, payload) => { calls.push({channel,payload}); return {email:{...state.emails.find(row=>row.id===payload.emailId),textBody:'loaded body'}}; };
    document.addEventListener('keydown', onMailShortcut);
    for (const email of state.emails) document.getElementById('message-list').append(messageRow(email));
  `);
  const press = (key, extra = {}) => window.document.body.dispatchEvent(new window.KeyboardEvent('keydown', {key,bubbles:true,cancelable:true,...extra}));
  const select = index => window.document.querySelectorAll('button.message')[index].dispatchEvent(new window.MouseEvent('click', {detail:1,bubbles:true}));
  return { ui, window, press, select, finish: () => ui.run('Promise.all(jobs)'), reset: () => ui.run(`mailShortcutStamp=0`) };
}

test('Separate window keys follow the single clicked message across accounts, not the hidden preview', async t => {
  const f = fixture(t); f.select(1);
  for (const [key, kind] of [['r','reply'], ['a','all'], ['f','forward']]) {
    f.reset(); f.press(key); await f.finish();
    assert.equal(f.ui.run('composes.at(-1).accountId'), 'beta');
    assert.equal(f.ui.run('composes.at(-1).quoteEmail.id'), 'two');
    assert.equal(f.ui.run('composes.at(-1).kind'), kind);
  }
  assert.equal(f.ui.run('calls[0].payload.accountId'), 'beta');
  assert.equal(f.ui.run('state.email.id'), 'one');
  f.ui.run(`globalThis.removed=[]; askConfirm=async()=>({ok:true}); beginRemovalRequest=()=>1; finishRemoval=async()=>{};
    call=async(channel,payload)=>{removed.push({channel,payload});return {};}`);
  f.press('Delete'); await f.finish();
  assert.equal(f.ui.run('removed[0].channel'), 'mail:delete');
  assert.equal(f.ui.run('removed[0].payload.emailId'), 'two');
  assert.equal(f.ui.run('removed[0].payload.accountId'), 'beta');
  f.select(0); f.press('Delete'); await f.finish();
  assert.equal(f.ui.run('removed[1].payload.emailId'), 'one', 'different targets are not swallowed by debounce');
  for (const setup of ["state.selectedIds=[]", "state.selectedIds=['one','two']", "state.selectedIds=['missing']", "state.selectedIds=['two'];state.accounts=[state.accounts[0]]"]) {
    f.ui.run(setup); f.reset(); f.press('Delete'); f.press('r'); await f.finish();
    assert.equal(f.ui.run('removed.length'), 2); assert.equal(f.ui.run('composes.length'), 3);
  }
});

test('captured reply survives later selection without retargeting; repeat and failed/mismatched reads never compose stale mail', async t => {
  const f = fixture(t); f.select(1);
  f.ui.run(`globalThis.complete=null;call=(channel,payload)=>{calls.push({channel,payload});return new Promise(resolve=>complete=resolve);}`);
  f.press('r'); await tick(); f.press('r', {repeat:true}); f.select(0);
  f.ui.run(`complete({email:{...state.emails[1],textBody:'second body'}})`); await f.finish();
  assert.equal(f.ui.run('calls.length'), 1); assert.equal(f.ui.run('composes[0].accountId'), 'beta');
  assert.equal(f.ui.run('composes[0].quoteEmail.id'), 'two');
  for (const result of ["throw new Error('download failed')", "return {email:null}", "return {email:{...state.emails[0],id:'two'}}", "return {email:{...state.emails[1],id:'one'}}"]) {
    f.select(1); f.reset(); f.ui.run(`call=async()=>{${result}}`); f.press('r'); await f.finish();
    assert.equal(f.ui.run('composes.length'), 1);
  }
  assert.equal(f.ui.run('errors.length'), 4);
  // Same message id alone must not allow another account's cached body to be reused.
  f.ui.run(`state.email={...state.emails[0],id:'two'};call=async(channel,payload)=>{calls.push({channel,payload});return {email:{...state.emails[1],textBody:'beta body'}}}`);
  f.reset(); f.press('r'); await f.finish();
  assert.equal(f.ui.run('composes.at(-1).accountId'), 'beta');
  assert.equal(f.ui.run('calls.at(-1).payload.accountId'), 'beta');
});

test('right/bottom previews block old-message shortcuts during opens, stale completion and failures', async t => {
  for (const layout of ['right','bottom']) {
    const f = fixture(t, layout);
    f.ui.run(`globalThis.pending=[];call=(channel,payload)=>new Promise((resolve,reject)=>pending.push({payload,resolve,reject}));`);
    const first = f.ui.run(`openMessage('two',false)`);
    f.press('r'); f.press('Delete'); await f.finish(); assert.equal(f.ui.run('composes.length'), 0);
    assert.equal(f.ui.run('pending[0].payload.accountId'), 'beta');
    const second = f.ui.run(`openMessage('one',false)`);
    f.ui.run(`pending[0].resolve({email:{...state.emails[1],textBody:'stale'}})`); await first;
    f.press('r'); await f.finish(); assert.equal(f.ui.run('composes.length'), 0);
    f.ui.run(`pending[1].resolve({email:{...state.emails[0]}})`); await second;
    f.press('r'); await f.finish(); assert.equal(f.ui.run('composes[0].accountId'), 'alpha');
    const failed = f.ui.run(`openMessage('two',false)`);
    f.ui.run(`pending[2].reject(new Error('synthetic failure'))`); await assert.rejects(failed, /synthetic failure/);
    f.reset(); f.press('r'); f.press('Delete'); await f.finish(); assert.equal(f.ui.run('composes.length'), 1);
    const interrupted = f.ui.run(`openMessage('two',false)`);
    f.ui.run(`invalidateReaderOpen(); state.email=null; pending[3].resolve({email:state.emails[1]})`); await interrupted;
    assert.equal(f.ui.run('state.email'), null);
  }
});

test('independent reader retains its own target with Separate window preferences and shell selection', async t => {
  const f = fixture(t, 'window', 'reader');
  f.ui.run(`state.selectedIds=['two']`); f.press('r'); await f.finish();
  assert.equal(f.ui.run('composes[0].accountId'), 'alpha');
  f.ui.run(`pendingOpenId='two'`); f.reset(); f.press('r'); await f.finish(); assert.equal(f.ui.run('composes.length'), 1);
});

test('busy shortcut dispatch does not queue repeated replies or substitute a newer selection', async t => {
  const f = fixture(t); f.select(1);
  f.ui.run(`guard=fn=>{const job=realGuard(fn);jobs.push(job);return job};
    globalThis.complete=null;call=(channel,payload)=>{calls.push({channel,payload});return new Promise(resolve=>complete=resolve)}`);
  f.press('r'); await tick(); f.reset(); f.press('r'); f.select(0); f.press('f');
  assert.equal(f.ui.run('calls.length'), 1);
  f.ui.run(`complete({email:{...state.emails[1],textBody:'loaded body'}})`); await f.finish();
  assert.equal(f.ui.run('composes.length'), 1); assert.equal(f.ui.run('composes[0].accountId'), 'beta');
  assert.equal(f.ui.run('state.busy'), false);
});

test('help describes selection scope and blocked previews in the rendered Features and Shortcuts', t => {
  const f = fixture(t);
  assert.match(f.ui.run(`shortcutNote('win')`), /exactly one visible message/);
  f.window.morrowFeaturesCatalog = require('../renderer/features-catalog');
  f.ui.run('paintFeatureCatalog();paintShortcuts()');
  assert.match(f.window.document.getElementById('features-catalog').textContent, /no selection or multiple selections disable these shortcuts/);
  assert.match(f.window.document.getElementById('shortcuts-note').textContent, /Preview shortcuts wait until loading succeeds/);
});


test('open View menu blocks mail actions and selection shortcuts', async t => {
  const f = fixture(t); f.select(1);
  f.window.document.getElementById('mail-view-menu').hidden = false;
  f.ui.run("document.addEventListener('keydown', onSelectionKey)");
  for (const key of ['r', 'a', 'f', 'Delete', 'Backspace']) {
    f.reset(); f.press(key); await f.finish();
  }
  f.press('a', {ctrlKey:true}); f.press('Escape');
  assert.equal(f.ui.run('calls.length'), 0);
  assert.equal(f.ui.run('composes.length'), 0);
  assert.equal(f.ui.run('state.selectedIds.join()'), 'two');
});
