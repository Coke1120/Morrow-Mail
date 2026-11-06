const test = require('node:test'), assert = require('node:assert/strict'), { EventEmitter } = require('node:events'), { JSDOM } = require('jsdom');
const { installComposeEditingMenu, composePage } = require('../host/compose-editing-menu');
const htmlFile = '/synthetic/renderer/index.html', url = 'file:///synthetic/renderer/index.html?role=compose';
function fixture(t) {
  const dom = new JSDOM('<dialog id="compose" open><div id="compose-editor" contenteditable="true" tabindex="0">Wrod</div><input id="compose-subject" value="Wrod"><textarea id="ai-prompt">Wrod</textarea></dialog>', { runScripts: 'outside-only', url });
  t.after(() => dom.window.close());
  const node = dom.window.document.querySelector('#compose-subject'); node.focus();
  dom.window.state = { composeSession: 1, composeMeta: { accountId: 'fixture-account', fromAddress: 'owner@fixture.invalid' }, draftId: 'fixture-draft' };
  dom.window.document.elementFromPoint = () => node;
  const calls = [], menus = [], frame = {}, contents = new EventEmitter();
  let destroyed = false, currentUrl = url;
  Object.assign(contents, { mainFrame: frame, getURL: () => currentUrl, isDestroyed: () => destroyed,
    executeJavaScript: async code => dom.window.eval(code), replaceMisspelling: word => calls.push(['replaceMisspelling', word]) });
  for (const method of ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll']) contents[method] = () => calls.push([method]);
  const win = { webContents: contents, isDestroyed: () => destroyed };
  installComposeEditingMenu(win, { htmlFile, Menu: { buildFromTemplate(items) { return { popup(options) { menus.push({ items, options }); } }; } } });
  const params = { isEditable: true, frame, x: 10, y: 10, formControlType: 'input-text', spellcheckEnabled: true, misspelledWord: 'Wrod', dictionarySuggestions: ['Word', 'Wore'],
    editFlags: { canUndo: true, canRedo: false, canCopy: true, canCut: true, canPaste: true, canSelectAll: true } };
  const open = async extra => { contents.emit('context-menu', { preventDefault() {} }, { ...params, ...extra }); await new Promise(resolve => setImmediate(resolve)); return menus.at(-1); };
  return { dom, node, calls, menus, contents, open, setUrl: value => { currentUrl = value; }, destroy: () => { destroyed = true; } };
}

test('menu replaces only the chosen spelling and retains normal native editing actions', async t => {
  const f = fixture(t), menu = await f.open();
  assert.deepEqual(menu.items.slice(0, 2).map(row => row.label), ['Word', 'Wore']);
  assert.ok(menu.items.some(row => row.label === 'Undo')); assert.equal(menu.items.find(row => row.label === 'Redo').enabled, false);
  assert.ok(!menu.items.some(row => /dictionary/i.test(row.label || '')));
  await menu.items[0].click(); assert.deepEqual(f.calls, [['replaceMisspelling', 'Word']]);
  const editing = await f.open({ spellcheckEnabled: false }); await editing.items.find(row => row.label === 'Undo').click();
  assert.deepEqual(f.calls.at(-1), ['undo']);
});

test('suggestions are bounded and keyboard menus use the focused editable compose field', async t => {
  const f = fixture(t), menu = await f.open({ menuSourceType: 'keyboard', x: -1, y: -1, dictionarySuggestions: ['Word', 'Word', '\nBad', 'A&B', ...Array.from({ length: 20 }, (_, i) => 'word' + i)] });
  const separator = menu.items.findIndex(row => row.type === 'separator'); assert.equal(separator, 8);
  assert.equal(menu.items[1].label, 'A&&B'); await menu.items[1].click(); assert.deepEqual(f.calls, [['replaceMisspelling', 'A&B']]);
});

test('missing dictionary support still offers editing without inventing corrections', async t => {
  const f = fixture(t);
  const empty = await f.open({ dictionarySuggestions: [] }); assert.equal(empty.items[0].label, 'No spelling suggestions'); assert.equal(empty.items[0].enabled, false);
  const off = await f.open({ spellcheckEnabled: false }); assert.equal(off.items[0].label, 'Undo');
  delete f.contents.replaceMisspelling; const missing = await f.open(); assert.equal(missing.items[0].label, 'Undo');
});

for (const kind of ['uneditable', 'password', 'subframe', 'external', 'not-compose', 'readonly', 'hidden-compose', 'other-field']) test('does not open a compose spelling menu for ' + kind, async t => {
  const f = fixture(t); let extra = {};
  if (kind === 'uneditable') extra.isEditable = false;
  if (kind === 'password') extra.formControlType = 'input-password';
  if (kind === 'subframe') extra.frame = {};
  if (kind === 'external') f.setUrl('https://example.invalid/index.html?role=compose');
  if (kind === 'not-compose') f.setUrl(url.replace('?role=compose', ''));
  if (kind === 'readonly') f.node.readOnly = true;
  if (kind === 'hidden-compose') f.dom.window.document.querySelector('#compose').removeAttribute('open');
  if (kind === 'other-field') f.node.id = 'ai-key';
  await f.open(extra); assert.equal(f.menus.length, 0); assert.deepEqual(f.calls, []);
});

for (const kind of ['navigated', 'destroyed', 'frame', 'new-menu', 'changed-text', 'changed-focus', 'locked', 'compose-session', 'account', 'sender', 'draft', 'AI-writing']) test('stale native correction cannot edit after ' + kind, async t => {
  const f = fixture(t), menu = await f.open();
  if (kind === 'navigated') f.contents.emit('did-start-navigation');
  if (kind === 'destroyed') f.destroy();
  if (kind === 'frame') f.contents.mainFrame = {};
  if (kind === 'new-menu') await f.open();
  if (kind === 'changed-text') f.node.value = 'Newer typing';
  if (kind === 'changed-focus') f.dom.window.document.querySelector('#ai-prompt').focus();
  if (kind === 'locked') f.node.disabled = true;
  if (kind === 'compose-session') f.dom.window.state.composeSession++;
  if (kind === 'account') f.dom.window.state.composeMeta.accountId = 'another-account';
  if (kind === 'sender') f.dom.window.state.composeMeta.fromAddress = 'other@fixture.invalid';
  if (kind === 'draft') f.dom.window.state.draftId = 'another-draft';
  if (kind === 'AI-writing') f.dom.window.state.draftWrite = { pending: true };
  await menu.items[0].click(); assert.deepEqual(f.calls, []);
});

test('only the exact first-party compose page is accepted', () => {
  assert.equal(composePage(url, htmlFile), true); assert.equal(composePage('morrow://local/index.html?role=compose', htmlFile), true);
  for (const value of ['file://remote/synthetic/renderer/index.html?role=compose', 'file:///different/index.html?role=compose', 'morrow://user@local/index.html?role=compose', 'data:text/html,compose', 'https://local/index.html?role=compose']) assert.equal(composePage(value, htmlFile), false);
});
