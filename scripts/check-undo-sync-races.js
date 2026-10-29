// Dependency-free state/race regressions. Production renderer, synthetic nodes/IPC/timers only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(process.env.MORROW_RENDERER_SOURCE || path.join(__dirname, '../renderer/app.js'), 'utf8')
  .replace(/boot\(\)\.catch\([^\n]+\);\s*$/, '');

function fixture() {
  const timers = new Map(), nodes = new Map(); let timer = 0;
  const document = { activeElement: null, querySelector() { return null; }, getElementById: id => nodes.get(id) || null };
  for (const id of ['notice', 'status', 'status-chip', 'undo', 'undo-details', 'undo-details-popover', 'undo-schedule', 'scheduled-undo', 'scheduled-status']) {
    const classes = new Set();
    nodes.set(id, { id, hidden: id.startsWith('undo'), disabled: false, textContent: '', attrs: {},
      classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); } },
      setAttribute(k, v) { this.attrs[k] = v; }, contains() { return false; },
      focus() { document.activeElement = this; } });
  }
  const context = vm.createContext({ document, window: { morrow: {} }, console, queueMicrotask,
    setTimeout(fn) { timers.set(++timer, fn); return timer; }, clearTimeout(id) { timers.delete(id); } });
  const run = code => vm.runInContext(code, context);
  vm.runInContext(source, context);
  run(`loadList = async () => {}; loadScheduled = async () => {}; renderList = () => {}; renderReader = () => {};
    globalThis.calls = []; call = async (channel, payload) => { calls.push({channel, payload}); return {outcomes:[]}; };
    globalThis.items = ['a','b','c'].map(id => ({opId:'op-'+id,messageId:id,subject:id,accountId:id}));
    startRemovalSession('Archive: 3 completed.', items.map(item=>item.opId), false, items);`);
  return { run, nodes, timers, json: code => JSON.parse(run(`JSON.stringify(${code})`)) };
}

test('failed-first settlement retains unreported rows and their pending ownership', async () => {
  const f = fixture();
  await f.run('undoRemoval()');
  f.run(`applyActionSettlement({outcomes:[{id:'a',kind:'undo',status:'failed',retryOpId:'op-a'}],opIds:['op-a']})`);
  assert.deepEqual(f.json('undoOpIds'), ['op-a','op-b','op-c']);
  assert.deepEqual(f.json('[...undoPending]'), ['op-b','op-c']);
  f.run(`applyActionSettlement({outcomes:[{id:'b',kind:'undo',status:'completed'}],opIds:[]})`);
  assert.deepEqual(f.json('undoOpIds'), ['op-a','op-c']);
  f.run(`applyActionSettlement({outcomes:[{id:'c',kind:'undo',status:'completed'}],opIds:[]})`);
  assert.deepEqual(f.json('undoOpIds'), ['op-a']);
  assert.equal(f.nodes.get('undo').disabled, false);
});

test('a second subset cannot overwrite a pending Undo tracker', async () => {
  const f = fixture();
  await f.run(`undoRemoval(['op-a'])`);
  await f.run(`undoRemoval(['op-b'])`);
  assert.equal(f.run('calls.length'), 1);
  assert.equal(f.nodes.get('undo-details').disabled, true);
  f.run(`applyActionSettlement({outcomes:[{id:'a',kind:'undo',status:'completed'}],opIds:[]})`);
  assert.deepEqual(f.json('undoOpIds'), ['op-b','op-c']);
  assert.deepEqual(f.json('[...undoPending]'), []);
  await f.run(`undoRemoval(['op-b'])`);
  assert.equal(f.run('calls.length'), 2);
});

test('a repeated completion cannot resolve the last outstanding row', async () => {
  const f = fixture();
  await f.run(`undoRemoval(['op-a','op-b'])`);
  const settled = `applyActionSettlement({outcomes:[{id:'a',kind:'undo',status:'completed'}],opIds:[]})`;
  f.run(settled); f.run(settled);
  assert.deepEqual(f.json('undoOpIds'), ['op-b','op-c']);
  assert.deepEqual(f.json('[...undoPending]'), ['op-b']);
});

test('an old settlement of the same message cannot claim a replacement Undo', async () => {
  const f = fixture();
  await f.run(`undoRemoval(['op-a'])`);
  f.run(`actionGeneration.set('a',3); startRemovalSession('Replacement.', ['new'], false, [{opId:'new',messageId:'a'}]);`);
  await f.run('undoRemoval()');
  f.run(`applyActionSettlement({outcomes:[{id:'a',generation:2,kind:'undo',status:'failed',retryOpId:'op-a'}],opIds:['op-a']});`);
  assert.deepEqual(f.json('[...undoPending]'), ['new']);
  f.run(`applyActionSettlement({outcomes:[{id:'a',generation:2,kind:'undo',status:'completed'}],opIds:[]});`);
  assert.deepEqual(f.json('undoOpIds'), ['new']);
  assert.deepEqual(f.json('[...undoPending]'), ['new']);
  // A later read changes the projection generation but must not hide this restore's receipt.
  f.run(`actionGeneration.set('a',5); applyActionSettlement({outcomes:[{id:'a',generation:4,kind:'undo',status:'completed'}],opIds:[]});`);
  assert.equal(f.run('undoKind'), '');
});

test('settlement before a rejected invoke never resurrects completed Undo rows', async () => {
  const f = fixture();
  f.run(`call = () => new Promise((resolve,reject) => { globalThis.rejectUndo = reject; })`);
  const pending = f.run('undoRemoval()');
  f.run(`applyActionSettlement({outcomes:items.map(item=>({id:item.messageId,kind:'undo',status:'completed'})),opIds:[]}); rejectUndo(new Error('late IPC failure'));`);
  await pending;
  assert.equal(f.run('undoKind'), '');
  assert.equal(f.nodes.get('undo').hidden, true);
  assert.doesNotMatch(f.nodes.get('status').textContent, /outcome is unknown|late IPC/);
});

test('an old rejected Undo cannot overwrite the replacement session receipt', async () => {
  const f = fixture();
  f.run(`call = () => new Promise((resolve,reject) => { globalThis.rejectUndo = reject; })`);
  const pending = f.run('undoRemoval()');
  f.run(`startRemovalSession('New removal.', ['new'], false, [{opId:'new',messageId:'new'}]); rejectUndo(new Error('old failure'));`);
  await pending;
  assert.deepEqual(f.json('undoOpIds'), ['new']);
  assert.equal(f.nodes.get('status').textContent, 'New removal.');
  assert.equal(f.nodes.get('undo').disabled, false);
});

test('a list reload failure does not report a completed restore as unknown', async () => {
  const f = fixture();
  f.run(`call = async () => ({outcomes:items.map(item=>({id:item.messageId,status:'completed'}))}); loadList = async () => { throw Error('list offline'); };`);
  await f.run('undoRemoval()');
  assert.equal(f.run('undoKind'), '');
  assert.match(f.nodes.get('status').textContent, /list could not refresh/);
  assert.doesNotMatch(f.nodes.get('status').textContent, /outcome is unknown/);
});

test('an older scheduled restore leaves the replacement Undo and receipt intact', async () => {
  const f = fixture();
  f.run(`clearUndo(); armScheduleUndo({id:'old'}); call = () => new Promise(resolve => { globalThis.resolveRestore = resolve; });`);
  const pending = f.run('undoCancelScheduled()');
  assert.equal(f.nodes.get('undo-schedule').disabled, true);
  f.run(`armScheduleUndo({id:'new'}); showStatus('New scheduled cancellation.'); resolveRestore({});`);
  await pending;
  assert.equal(f.run('scheduleUndo.id'), 'new');
  assert.equal(f.nodes.get('undo-schedule').hidden, false);
  assert.equal(f.nodes.get('undo-schedule').disabled, false);
  assert.equal(f.nodes.get('status').textContent, 'New scheduled cancellation.');
});

test('Details cancels the notice dwell timer until dismissed', () => {
  const f = fixture();
  f.run('openUndoDetails(); scheduleStatusCollapse()');
  assert.equal(f.run('statusCollapseTimer'), 0);
  f.run('closeUndoDetails(false)');
  assert.notEqual(f.run('statusCollapseTimer'), 0);
});
