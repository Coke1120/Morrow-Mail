// Synthetic renderer, actual preload and settings. No mailbox or native windows.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { renderer } = require('./check-ux-workflows');
const settle = async () => { for (let n = 0; n < 4; n++) await new Promise(resolve => setTimeout(resolve, 0)); };

function fixture(t) {
  const window = new JSDOM(fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8'), { url: 'https://fixture.invalid' }).window;
  t.after(() => window.close());
  const saves = [], opened = [];
  window.morrowMailColumns = require('../shared/mail-columns');
  window.morrow = { on() {}, invoke: async (channel, payload) => { saves.push({ channel, payload }); return payload; }, openReaderWindow: async seed => { opened.push(seed); } };
  const ui = renderer({ window, document: window.document, localStorage: window.localStorage, Event: window.Event, Node: window.Node });
  ui.run(`renderList = () => applyMailView(); globalThis.previewed = []; openMessage = async id => previewed.push(id); wireMailView();`);
  return { ui, window, saves, opened, get: id => window.document.getElementById(id) };
}

test('actual preload saves a validated view independently of pane widths, columns and theme', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-view-')), old = process.env.MORROW_USER_DATA;
  process.env.MORROW_USER_DATA = dir;
  t.after(() => { if (old === undefined) delete process.env.MORROW_USER_DATA; else process.env.MORROW_USER_DATA = old; fs.rmSync(dir, { recursive: true, force: true }); });
  const settings = require('../host/settings');
  const channels = []; let bridge;
  vm.runInNewContext(fs.readFileSync(require.resolve('../renderer/preload'), 'utf8'), { require: () => ({ contextBridge: { exposeInMainWorld: (name, api) => { if (name === 'morrow') bridge = api; } }, ipcRenderer: { invoke: async (channel, value) => { channels.push({ channel, value }); return settings.answer(channel, [value]); } } }) });
  assert.deepEqual(await bridge.invoke('morrow:configGetMailView'), { layout: 'right', listHeight: 320 });
  await bridge.invoke('morrow:configSetLayoutPanes', { folders: 260, list: 720, reading: 480 });
  await bridge.invoke('morrow:configSetMailColumnOrder', ['subject', 'date', 'sender', 'recipient', 'status']);
  await bridge.invoke('config:setTheme', 'dark');
  await bridge.invoke('morrow:configSetMailView', { layout: 'bottom', listHeight: 440, untrusted: '<html>' });
  assert.deepEqual(await bridge.invoke('morrow:configGetMailView'), { layout: 'bottom', listHeight: 440 });
  for (const invalid of [null, { layout: 'url', listHeight: 320 }, { layout: 'right', listHeight: 199 }, { layout: 'window', listHeight: 2001 }]) await assert.rejects(bridge.invoke('morrow:configSetMailView', invalid), /Mail view must/);
  assert.deepEqual(await bridge.invoke('morrow:configGetLayoutPanes'), { folders: 260, list: 720, reading: 480 });
  assert.deepEqual(await bridge.invoke('morrow:configGetMailColumnOrder'), ['subject', 'date', 'time', 'sender', 'recipient']);
  assert.equal(await bridge.invoke('config:getTheme'), 'dark');
  await bridge.openReaderWindow({ accountId: 'b', messageId: 'message-b' });
  assert.equal(channels.at(-1).channel, 'reader:open');
  assert.deepEqual(JSON.parse(JSON.stringify(channels.at(-1).value)), { accountId: 'b', messageId: 'message-b' });
  const dest = path.join(dir, 'settings.json'), saved = JSON.parse(fs.readFileSync(dest));
  assert.deepEqual(saved.mailView, { layout: 'bottom', listHeight: 440 });
  saved.mailView = { layout: '__proto__', listHeight: -1 }; fs.writeFileSync(dest, JSON.stringify(saved));
  assert.deepEqual(await bridge.invoke('morrow:configGetMailView'), { layout: 'right', listHeight: 320 });
});

test('View menu supports arrows, Home/End, Escape, outside dismissal and focus return', async t => {
  const f = fixture(t), key = (node, value) => node.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  f.get('mail-view-open').focus(); key(f.get('mail-view-open'), 'ArrowDown');
  const buttons = [...f.get('mail-view-menu').querySelectorAll('button')];
  assert.equal(f.window.document.activeElement, buttons[0]);
  key(buttons[0], 'ArrowUp'); assert.equal(f.window.document.activeElement, buttons[2]);
  key(buttons[2], 'Home'); assert.equal(f.window.document.activeElement, buttons[0]);
  key(buttons[0], 'End'); assert.equal(f.window.document.activeElement, buttons[2]);
  key(buttons[2], 'Escape'); assert.equal(f.get('mail-view-menu').hidden, true); assert.equal(f.window.document.activeElement, f.get('mail-view-open'));
  f.get('mail-view-open').click(); buttons[1].click(); await settle();
  assert.equal(f.get('shell').dataset.mailLayout, 'bottom'); assert.equal(buttons[1].getAttribute('aria-checked'), 'true');
  assert.equal(f.get('mail-view-open').getAttribute('aria-expanded'), 'false'); assert.equal(f.window.document.activeElement, f.get('mail-view-open'));
  assert.equal(f.get('shell').querySelector('[data-split="messages"]').getAttribute('aria-orientation'), 'horizontal');
  f.get('mail-view-open').click(); f.get('search-query').dispatchEvent(new f.window.Event('pointerdown', { bubbles: true })); assert.equal(f.get('mail-view-menu').hidden, true);
  f.get('mail-view-open').click(); f.get('search-query').focus(); assert.equal(f.get('mail-view-menu').hidden, true);
});

test('view switches retain reader DOM, selection, query, columns, sort and scroll; Outbox keeps a preview', async t => {
  const f = fixture(t), list = f.get('message-list'), reader = f.get('reader');
  reader.textContent = 'Existing preview'; list.scrollLeft = 90; list.scrollTop = 240;
  f.ui.run(`state.query='project'; state.selectedIds=['a','b']; state.selectionAnchor='b'; state.mailColumnOrder=['subject','date','recipient','sender']; state.listSort={sortBy:'subject',sortDirection:'asc'};`);
  const before = f.ui.run('JSON.stringify([state.query,state.selectedIds,state.selectionAnchor,state.mailColumnOrder,state.listSort])');
  for (const layout of ['bottom', 'window', 'right']) {
    await f.ui.run(`saveMailView({layout:'${layout}',listHeight:360})`);
    assert.equal(f.ui.run('JSON.stringify([state.query,state.selectedIds,state.selectionAnchor,state.mailColumnOrder,state.listSort])'), before);
    assert.equal(reader.textContent, 'Existing preview'); assert.equal(list.scrollLeft, 90); assert.equal(list.scrollTop, 240);
  }
  await f.ui.run(`saveMailView({layout:'window',listHeight:360}); state.outbox=true; applyMailView()`);
  assert.equal(f.get('shell').dataset.mailLayout, 'bottom'); assert.equal(f.ui.run('state.prefs.mailView.layout'), 'window');
  f.ui.run('state.outbox=false;applyMailView()'); assert.equal(f.get('shell').dataset.mailLayout, 'window');
  f.window.document.documentElement.dataset.window = 'reader'; f.get('shell').removeAttribute('data-mail-layout'); f.ui.run('applyMailView()'); assert.equal(f.get('shell').dataset.mailLayout, undefined);
});

test('Separate window only selects on mouse click, opens once on double click or keyboard, and preserves account identity', async t => {
  const f = fixture(t);
  f.ui.run(`state.prefs.mailView={layout:'window',listHeight:320}; state.emails=[{id:'one',accountId:'b',subject:'Synthetic'}]; globalThis.row=messageRow(state.emails[0]); document.getElementById('message-list').append(row);`);
  const button = f.get('message-list').querySelector('button.message');
  const mouse = (type, detail, extra = {}) => button.dispatchEvent(new f.window.MouseEvent(type, { detail, bubbles: true, cancelable: true, ...extra }));
  mouse('click', 1); mouse('click', 2); assert.equal(f.opened.length, 0); assert.equal(f.ui.run('previewed.length'), 0);
  assert.deepEqual(Array.from(f.ui.run('state.selectedIds')), ['one']);
  mouse('dblclick', 2); await settle(); assert.deepEqual(JSON.parse(JSON.stringify(f.opened)), [{ accountId: 'b', messageId: 'one' }]);
  button.click(); await settle(); assert.equal(f.opened.length, 2);
  mouse('dblclick', 2, { ctrlKey: true }); mouse('click', 1, { shiftKey: true }); await settle(); assert.equal(f.opened.length, 2);
  f.ui.run(`state.prefs.mailView.layout='right'`); mouse('click', 1); await settle(); assert.deepEqual(Array.from(f.ui.run('previewed')), ['one']);
  f.ui.run(`state.prefs.mailView.layout='window'; globalThis.outbox=messageRow({id:'waiting',accountId:'a',outbox:true});document.getElementById('message-list').append(outbox)`);
  f.get('message-list').querySelector('.outbox-row button.message').click(); await settle(); assert.deepEqual(Array.from(f.ui.run('previewed')), ['one', 'waiting']); assert.equal(f.opened.length, 2);
});

test('pending reads cannot overwrite a chosen view and serialized saves retain the latest choice', async t => {
  const f = fixture(t); let read;
  f.window.morrow.invoke = async channel => channel === 'morrow:configGetMailView' ? new Promise(resolve => { read = resolve; }) : null;
  const loading = f.ui.run('loadMailView()'); await f.ui.run(`saveMailView({layout:'window',listHeight:400})`);
  read({ layout: 'right', listHeight: 320 }); await loading; assert.equal(f.get('shell').dataset.mailLayout, 'window');
  const pending = [];
  f.window.morrow.invoke = (channel, value) => new Promise(resolve => pending.push({ value: JSON.parse(JSON.stringify(value)), resolve }));
  const first = f.ui.run(`saveMailView({layout:'bottom',listHeight:410})`), last = f.ui.run(`saveMailView({layout:'right',listHeight:410})`);
  await settle(); assert.equal(pending.length, 1); pending[0].resolve(); await first; await settle(); assert.equal(pending.length, 2); pending[1].resolve(); await last;
  assert.deepEqual(pending.map(item => item.value.layout), ['bottom', 'right']); assert.equal(f.get('shell').dataset.mailLayout, 'right');
});

test('bottom splitter uses height and leaves saved right preview widths intact', async t => {
  const f = fixture(t);
  f.get('shell').getBoundingClientRect = () => ({ width: 1200, height: 800 });
  f.window.document.querySelector('.side').getBoundingClientRect = () => ({ width: 250 });
  f.get('messages').getBoundingClientRect = () => ({ width: 934, height: 344 });
  f.get('reader').getBoundingClientRect = () => ({ width: 934, height: 448 });
  f.ui.run(`state.prefs.layout={folders:250,list:560,reading:374};state.prefs.mailView={layout:'bottom',listHeight:320};wireSplits();applyMailView()`);
  const handle = f.get('shell').querySelector('[data-split="messages"]');
  handle.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  assert.equal(f.get('shell').style.getPropertyValue('--mail-list-height'), '344px'); await settle();
  assert.equal(handle.getAttribute('aria-valuenow'), '344'); assert.equal(handle.getAttribute('aria-valuetext'), '344 pixels high');
  assert.equal(f.ui.run('state.prefs.layout.list'), 560); assert.equal(f.ui.run('state.prefs.layout.reading'), 374); assert.equal(f.ui.run('state.prefs.mailView.listHeight'), 344);
});

test('an in-flight shell preference refresh keeps a newer reading layout', async t => {
  const f = fixture(t); let finishTheme;
  f.window.morrow.invoke = async channel => channel === 'config:getTheme' ? new Promise(resolve => { finishTheme = resolve; }) : null;
  const loading = f.ui.run('loadShellPrefs()'); await settle();
  await f.ui.run(`saveMailView({layout:'window',listHeight:430})`);
  finishTheme('light'); await loading;
  assert.equal(f.ui.run('state.prefs.mailView.layout'), 'window'); assert.equal(f.ui.run('state.prefs.mailView.listHeight'), 430);
});

test('failed preference writes keep the usable layout and a later choice can save', async t => {
  const f = fixture(t);
  f.window.morrow.invoke = async () => { throw new Error('Synthetic storage refusal'); };
  await assert.rejects(f.ui.run(`saveMailView({layout:'window',listHeight:320})`), /storage refusal/);
  await settle(); assert.equal(f.get('shell').dataset.mailLayout, 'window'); assert.match(f.get('status').textContent, /Could not save the reading layout/);
  f.window.morrow.invoke = async (_channel, value) => value;
  await f.ui.run(`saveMailView({layout:'bottom',listHeight:420})`); assert.equal(f.get('shell').dataset.mailLayout, 'bottom');
});
