// Production renderer regressions, synthetic DOM/IPC/timers only.
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

function detailsFixture(context) {
  const { JSDOM } = require('jsdom');
  const rendererRoot = path.join(__dirname, '../renderer');
  const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  context.after(() => dom.window.close());
  let timer = 0;
  dom.window.morrow = { on() {}, invoke: async () => ({ success: true, data: null }) };
  dom.window.setTimeout = () => ++timer;
  dom.window.clearTimeout = () => {};
  const run = code => vm.runInContext(code, dom.getInternalVMContext());
  for (const script of dom.window.document.querySelectorAll('script[src]')) {
    const file = script.getAttribute('src');
    if (file === './app.js' || file === './motion.bundle.js') continue;
    run(fs.readFileSync(path.resolve(rendererRoot, file), 'utf8'));
  }
  run(source);
  run(`wire(); loadList = async () => {}; loadScheduled = async () => {}; renderList = () => {}; renderReader = () => {};
    state.accounts = [{id:'alpha',label:'Work',email:'work@example.test'}, {id:'beta',label:'Personal',email:'home@example.test'}];
    globalThis.items = ['a','b','c'].map((id,index) => ({opId:'op-'+id,messageId:id,accountId:index < 2 ? 'alpha' : 'beta',
      subject:'Report',from:'Ada <ada@example.test>',action:'archive',destinationLabel:'Archive'}));`);
  return { run, document: dom.window.document, settle: batch => run('applyActionSettlement(' + JSON.stringify(batch) + ')'),
    json: code => JSON.parse(run(`JSON.stringify(${code})`)) };
}

function expireScheduleOffer(ui) {
  const timer = ui.run('scheduleUndoTimer');
  const expire = ui.timers.get(timer);
  assert.equal(typeof expire, 'function');
  ui.timers.delete(timer);
  expire();
}

function outboxTodoFixture(agentTodo) {
  const ui = fixture();
  ui.run(`clearUndo();
    state.outbox = true;
    state.outboxRows = [{id:'queued-reply',accountId:'a',status:'pending',outbox:true}];
    state.emails = outboxEmails(state.outboxRows);
    globalThis.recoveredTodo = ${JSON.stringify(agentTodo)};
    globalThis.opened = null;
    globalThis.failSend = false;
    call = async (channel, payload) => {
      calls.push({channel, payload});
      if (channel === 'mail:cancelScheduled') return {emailId:'recovered-reply',accountId:'a',agentTodo:recoveredTodo};
      if (channel === 'mail:openEmail') return {email:{id:'recovered-reply',accountId:'a',isDraft:true,
        fromAddress:'a@example.test',bodyComplete:true,textBody:'Reply',inReplyTo:'<source@example.test>'}};
      if (channel === 'mail:send' && failSend) throw new Error('Synthetic send failure');
      return {};
    };
    presentCompose = async seed => {
      opened = seed;
      state.composeSession += 1;
      state.agentReplyTodo = explicitAgentTodo(seed.agentTodo);
    };
    syncCompose = () => {}; setComposeStatus = () => {}; composeSnapshot = () => '';
    closeDialog = async () => {}; openDialog = () => {}; scheduleComposeLayout = () => {};`);
  return ui;
}

test('Outbox Undo forwards the validated original Agent todo through draft resume and confirmed resend', async () => {
  const ui = outboxTodoFixture({messageId:' original-todo ',accountId:' a ',status:'done'});
  await ui.run('undoOutboxItem(state.emails[0])');
  assert.deepEqual(ui.json('opened').agentTodo, {messageId:'original-todo',accountId:'a'});
  assert.equal(ui.run('opened.draftId'), 'recovered-reply');
  assert.equal(ui.run('opened.inReplyTo'), '<source@example.test>');
  assert.match(ui.run('opened.status'), /nothing sends automatically/);
  assert.deepEqual(ui.json('calls.map(item => item.channel)'), ['mail:cancelScheduled','mail:openEmail']);
  assert.deepEqual(ui.json('calls[0].payload'), {id:'queued-reply',recoverDraft:true});
  assert.deepEqual(ui.json('state.outboxRows'), []);
  await ui.run("deliverMail(withAgentReplyTodo({accountId:'a',to:'recipient@example.test',body:'Reply'}))");
  const sent = ui.json("calls.find(item => item.channel === 'mail:send')");
  assert.deepEqual(sent.payload.agentTodo, {messageId:'original-todo',accountId:'a'});
  const completed = ui.json("calls.filter(item => item.channel === 'nativeAgent:home:todoUpdate')");
  assert.deepEqual(completed, [{channel:'nativeAgent:home:todoUpdate',payload:{messageId:'original-todo',accountId:'a',status:'done'}}]);
  assert.equal(ui.run('state.agentReplyTodo'), null);
});

test('Outbox Undo omits missing or malformed Agent todo metadata', async () => {
  for (const agentTodo of [undefined, null, [], 'original-todo', {}, {accountId:'a'}, {messageId:'  ',accountId:'a'}]) {
    const ui = outboxTodoFixture(agentTodo);
    await ui.run('undoOutboxItem(state.emails[0])');
    assert.equal(ui.run("Object.hasOwn(opened, 'agentTodo')"), false);
    assert.equal(ui.run('state.agentReplyTodo'), null);
    assert.deepEqual(ui.json('calls.map(item => item.channel)'), ['mail:cancelScheduled','mail:openEmail']);
  }
});

test('Outbox Undo keeps the original Agent todo open after a failed resend', async () => {
  const ui = outboxTodoFixture({messageId:'original-todo',accountId:'a'});
  await ui.run('undoOutboxItem(state.emails[0])');
  ui.run('failSend = true');
  await ui.run("deliverMail(withAgentReplyTodo({accountId:'a',to:'recipient@example.test',body:'Reply'}))");
  assert.deepEqual(ui.json('state.agentReplyTodo'), {messageId:'original-todo',accountId:'a'});
  assert.equal(ui.run("calls.some(item => item.channel === 'nativeAgent:home:todoUpdate')"), false);
});

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

test('separate Archive, Trash and Move batches accumulate without replacing earlier Undo', () => {
  const ui = fixture();
  const epoch = ui.run('undoEpoch');
  ui.run(`beginRemovalRequest([{id:'d',accountId:'alpha',subject:'Fourth'}], 'trash', 'Trash');
    rememberRemovalReceipt({pending:[{id:'d',actionId:'action-d',generation:1,kind:'remove'}]}, undoEpoch);
    applyActionSettlement({outcomes:[{id:'d',actionId:'action-d',generation:1,kind:'remove',status:'completed',opId:'op-d'}],opIds:['op-d']});
    beginRemovalRequest([{id:'e',accountId:'beta',subject:'Fifth'}], 'move', 'Projects');
    rememberRemovalReceipt({pending:[{id:'e',actionId:'action-e',generation:1,kind:'remove'}]}, undoEpoch);
    applyActionSettlement({outcomes:[{id:'e',actionId:'action-e',generation:1,kind:'remove',status:'completed',opId:'op-e'}],opIds:['op-e']});`);
  assert.equal(ui.run('undoEpoch'), epoch);
  assert.deepEqual(ui.json('undoOpIds'), ['op-a','op-b','op-c','op-d','op-e']);
  assert.deepEqual(ui.json('undoItems.slice(3).map(item => [item.subject,item.action,item.destinationLabel])'), [['Fourth','trash','Trash'],['Fifth','move','Projects']]);
  ui.run(`showReadUndo('Read.', [{emailId:'read'}])`);
  assert.equal(ui.run('undoKind'), 'removal');
  assert.equal(ui.run('undoOpIds.length'), 5);
});

test('restoring the completed checklist does not retire another pending batch', async () => {
  const ui = fixture();
  ui.run(`beginRemovalRequest([{id:'d',accountId:'alpha'}], 'trash');
    rememberRemovalReceipt({pending:[{id:'d',actionId:'action-d',kind:'remove',generation:1}]}, undoEpoch);
    call = async () => ({outcomes:items.map(item=>({id:item.messageId,kind:'undo',status:'completed'}))});`);
  const epoch = ui.run('undoEpoch');
  await ui.run('undoRemoval()');
  assert.equal(ui.run('undoEpoch'), epoch);
  assert.equal(ui.run('undoKind'), 'removal');
  assert.deepEqual(ui.json('undoOpIds'), []);
  ui.run(`showReadUndo('Read.', [{emailId:'read'}]);
    applyActionSettlement({outcomes:[{id:'d',actionId:'action-d',kind:'remove',generation:1,status:'completed',opId:'op-d'}],opIds:['op-d']});`);
  assert.deepEqual(ui.json('undoOpIds'), ['op-d']);
});

test('new batch settlements wait for an in-flight restore and preserve both results', async () => {
  const ui = fixture();
  ui.run(`call = () => new Promise(resolve => { globalThis.finishRestore = resolve; });`);
  const restore = ui.run(`undoRemoval(['op-a'])`);
  ui.run(`beginRemovalRequest([{id:'d',accountId:'alpha'}], 'archive');
    rememberRemovalReceipt({pending:[{id:'d',actionId:'action-d',kind:'remove',generation:1}]}, undoEpoch);
    applyActionSettlement({outcomes:[{id:'d',actionId:'action-d',kind:'remove',generation:1,status:'completed',opId:'op-d'}],opIds:['op-d']});
    finishRestore({outcomes:[{id:'a',kind:'undo',status:'completed'}]});`);
  await restore;
  assert.deepEqual(ui.json('undoOpIds'), ['op-b','op-c','op-d']);
});

test('clearing a session rejects its late completion instead of reviving Undo', () => {
  const ui = fixture();
  ui.run(`beginRemovalRequest([{id:'d',accountId:'alpha'}], 'archive');
    rememberRemovalReceipt({pending:[{id:'d',actionId:'action-d',kind:'remove',generation:1}]}, undoEpoch);
    clearUndo();
    applyActionSettlement({outcomes:[{id:'d',actionId:'action-d',kind:'remove',generation:1,status:'completed',opId:'op-d'}],opIds:['op-d']});`);
  assert.equal(ui.run('undoKind'), '');
  assert.equal(ui.run('undoOpIds'), null);
});

test('a replayed removal receipt cannot resurrect a restored item in the accumulated session', async () => {
  const ui = fixture();
  ui.run(`call = async () => ({outcomes:[{id:'a',kind:'undo',status:'completed'}]});`);
  await ui.run(`undoRemoval(['op-a'])`);
  ui.run(`applyActionSettlement({outcomes:[{id:'a',kind:'remove',status:'completed',opId:'op-a'}],opIds:['op-a']});`);
  assert.deepEqual(ui.json('undoOpIds'), ['op-b','op-c']);
});

test('pending restore settlements drain queued later batches without losing their Undo', async () => {
  const ui = fixture();
  await ui.run('undoRemoval()');
  ui.run(`beginRemovalRequest([{id:'d',accountId:'alpha'}], 'trash');
    rememberRemovalReceipt({pending:[{id:'d',actionId:'action-d',kind:'remove',generation:1}]}, undoEpoch);
    applyActionSettlement({outcomes:[{id:'d',actionId:'action-d',kind:'remove',generation:1,status:'completed',opId:'op-d'}],opIds:['op-d']});`);
  assert.equal(ui.run('undoSettleQueue.length'), 1);
  ui.run(`applyActionSettlement({outcomes:items.map(item=>({id:item.messageId,kind:'undo',status:'completed'})),opIds:[]});`);
  assert.equal(ui.run('undoSettleQueue.length'), 0);
  assert.deepEqual(ui.json('undoOpIds'), ['op-d']);
});

test('conflicting changes to one message remain distinct and cannot restore together', async () => {
  const ui = fixture();
  ui.run(`startRemovalSession('Two changes.', ['old','latest'], false, [
    {opId:'old',messageId:'a',action:'archive'}, {opId:'latest',messageId:'a',action:'trash'}]);`);
  await ui.run('undoRemoval()');
  assert.equal(ui.run('calls.length'), 0);
  assert.deepEqual(ui.json('undoOpIds'), ['old','latest']);
  assert.match(ui.nodes.get('status').textContent, /one change per message.*latest change first/);
  await ui.run(`undoRemoval(['latest'])`);
  assert.deepEqual(ui.json('calls[0].payload.opIds'), ['latest']);
});

test('later batches preserve an open Details selection until Undo selected', async context => {
  const ui = detailsFixture(context);
  ui.run(`startRemovalSession('First batch.', ['op-a'], false, [items[0]]); openUndoDetails(); setUndoDetailChecks(true);
    beginRemovalRequest([{id:'b',accountId:'alpha',subject:'Second batch'}], 'trash', 'Trash');
    rememberRemovalReceipt({pending:[{id:'b',actionId:'action-b',kind:'remove',generation:1}]}, undoEpoch);
    applyActionSettlement({outcomes:[{id:'b',actionId:'action-b',kind:'remove',generation:1,status:'completed',opId:'op-b'}],opIds:['op-b']});`);
  assert.equal(ui.run('undoPopoverOpen()'), true);
  assert.deepEqual(ui.json('selectedUndoOpIds()'), ['op-a']);
  assert.deepEqual(ui.json('undoOpIds'), ['op-a','op-b']);
  ui.run(`call = async (channel,payload) => ({outcomes:payload.opIds.map(opId=>({id:opId.slice(3),kind:'undo',status:'completed'}))});`);
  await ui.run('undoSelected()');
  assert.deepEqual(ui.json('undoOpIds'), ['op-b']);
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

test('late same-session account completions preserve Details, checks, scroll and checkbox focus', async context => {
  const ui = detailsFixture(context);
  ui.run(`beginRemovalRequest(items.map(item => ({...item,id:item.messageId})), 'archive', 'Archive');
    rememberRemovalReceipt({pending:items.map(item => ({id:item.messageId,actionId:'action-'+item.messageId,kind:'remove'}))}, undoEpoch);`);
  ui.settle({ outcomes: ['a','b'].map(id => ({ id, actionId: 'action-' + id, kind: 'remove', status: 'completed', opId: 'op-' + id })), opIds: ['op-a','op-b'] });
  const epoch = ui.run('undoEpoch');
  ui.document.getElementById('undo-details').click();
  ui.run('setUndoDetailChecks(true)');
  const list = ui.document.getElementById('undo-details-list');
  list.querySelectorAll('input')[1].focus();
  list.scrollTop = 84;
  ui.settle({ outcomes: [{ id: 'c', actionId: 'action-c', kind: 'remove', status: 'completed', opId: 'op-c' }], opIds: ['op-c'] });
  await Promise.resolve();
  assert.equal(ui.run('undoEpoch'), epoch);
  assert.equal(ui.run('undoPopoverOpen()'), true);
  assert.deepEqual(ui.json('selectedUndoOpIds()'), ['op-a','op-b']);
  assert.deepEqual([...list.querySelectorAll('input')].map(box => box.checked), [true,true,false]);
  assert.equal(list.scrollTop, 84);
  assert.equal(ui.document.activeElement.value, 'op-b');
  assert.equal(ui.document.getElementById('undo-details').getAttribute('aria-expanded'), 'true');
  assert.equal(ui.document.getElementById('undo-details-selected').textContent, 'Undo selected (2)');
  assert.equal(ui.run('statusCollapseTimer'), 0);
  assert.match(list.children[0].textContent, /Work.*work@example\.test/);
  assert.match(list.children[2].textContent, /Personal.*home@example\.test/);

  ui.run(`showUndo('Updated rows.', ['op-c','op-b'], false, [items[2],items[1]])`);
  await Promise.resolve();
  assert.equal(ui.run('undoPopoverOpen()'), true);
  assert.deepEqual(ui.json('selectedUndoOpIds()'), ['op-b']);
  assert.equal(ui.document.activeElement.value, 'op-b');
  assert.equal(list.scrollTop, 84);

  ui.run(`startRemovalSession('New removal.', ['op-c','op-b'], false, [items[2],items[1]])`);
  assert.notEqual(ui.run('undoEpoch'), epoch);
  assert.equal(ui.run('undoPopoverOpen()'), false);
  assert.deepEqual(ui.json('selectedUndoOpIds()'), []);
  assert.equal(ui.document.activeElement.id, 'undo-details');
  ui.document.getElementById('undo-details').click();
  assert.deepEqual([...list.querySelectorAll('input')].map(box => box.checked), [false,false]);
});

test('closed Details retain surviving checks when the current session grows', context => {
  const ui = detailsFixture(context);
  ui.run(`startRemovalSession('First completion.', ['op-a'], false, [items[0]]); openUndoDetails();
    setUndoDetailChecks(true); closeUndoDetails(true);
    showUndo('More completions.', ['op-a','op-c'], false, [items[0],items[2]]);`);
  assert.equal(ui.run('undoPopoverOpen()'), false);
  ui.document.getElementById('undo-details').click();
  assert.deepEqual(ui.json('selectedUndoOpIds()'), ['op-a']);
  assert.deepEqual([...ui.document.getElementById('undo-details-list').querySelectorAll('input')].map(box => box.checked), [true,false]);
});

test('duplicate and absent subjects describe sender, action, destination and owning mailbox', context => {
  const ui = detailsFixture(context);
  ui.run(`items = [
    {...items[0]}, {...items[0],opId:'op-b',messageId:'b',accountId:'beta'},
    {...items[0],opId:'op-c',messageId:'c',subject:'',from:'Ben <ben@example.test>',action:'trash',destinationLabel:'Trash'},
    {...items[0],opId:'op-d',messageId:'d',subject:'',from:'Dee <dee@example.test>',action:'move',destinationLabel:'Projects',accountId:'beta'}
  ]; startRemovalSession('Completed.', items.map(item => item.opId), false, items); openUndoDetails();`);
  const rows = [...ui.document.getElementById('undo-details-list').children];
  const descriptions = rows.map((row, index) => {
    const box = row.querySelector('input');
    const item = ui.json('items[' + index + ']');
    assert.equal(box.getAttribute('aria-label'), item.subject || '(No subject)');
    const descriptionId = box.getAttribute('aria-describedby');
    assert.ok(descriptionId);
    const description = ui.document.getElementById(descriptionId);
    assert.equal(description, row.querySelector('.undo-details-meta'));
    assert.equal(description.hidden, false);
    const mailbox = item.accountId === 'alpha' ? 'Work · work@example.test' : 'Personal · home@example.test';
    assert.equal(description.textContent, [mailbox, item.from, item.action + ' → ' + item.destinationLabel].join(' · '));
    box.focus();
    assert.equal(ui.document.activeElement, box);
    box.click();
    return description;
  });
  assert.equal(new Set(descriptions.map(description => description.id)).size, 4);
  assert.equal(new Set(descriptions.map(description => description.textContent)).size, 4);
  assert.equal(ui.document.getElementById('undo-details-selected').textContent, 'Undo selected (4)');
});

test('single-mailbox Details stay compact and unavailable mailboxes never expose opaque account IDs', context => {
  const ui = detailsFixture(context);
  ui.run(`startRemovalSession('One mailbox.', ['op-a','op-b'], false, items.slice(0,2)); openUndoDetails()`);
  const list = ui.document.getElementById('undo-details-list');
  assert.equal(list.querySelector('.undo-details-meta').textContent, 'Ada <ada@example.test> · archive → Archive');
  ui.run(`state.accounts = [{id:'alpha',email:'work@example.test'}, {id:'beta'}];
    showUndo('Multiple mailboxes.', items.map(item => item.opId), false, items)`);
  const meta = list.children[2].querySelector('.undo-details-meta');
  assert.match(meta.textContent, /Unavailable mailbox/);
  assert.doesNotMatch(meta.textContent, /beta/);
  assert.equal(ui.document.getElementById(list.children[2].querySelector('input').getAttribute('aria-describedby')), meta);
});

test('rendered Features describe preserved late Details updates and accepted scheduled restores', context => {
  const ui = detailsFixture(context);
  ui.run(`paintFeatureCatalog(); showFeaturesTab('catalog')`);
  const cards = [...ui.document.querySelectorAll('#features-catalog .feature-card')];
  const undo = cards.find(card => card.querySelector('h4').textContent === 'Undo removal details');
  const scheduled = cards.find(card => card.querySelector('h4').textContent === 'Send later');
  assert.equal(ui.document.getElementById('features-pane-catalog').hidden, false);
  assert.match(undo.textContent, /mailbox.*multiple accounts/);
  assert.match(undo.textContent, /checkbox.*description.*sender.*action.*destination.*mailbox/i);
  assert.match(undo.textContent, /late completions.*selection.*scroll.*focus/i);
  assert.match(scheduled.textContent, /eight seconds/);
  assert.match(scheduled.textContent, /started.*feedback.*expires/);
  assert.match(scheduled.textContent, /older restore cannot consume it/);
});

for (const result of ['success','failure']) {
  test('an accepted scheduled restore reports ' + result + ' after its offer expires', async () => {
    const ui = fixture();
    ui.run(`clearUndo(); armScheduleUndo({id:'old'}); showStatus('Scheduled delivery canceled.');
      call = () => new Promise((resolve,reject) => { globalThis.resolveRestore = resolve; globalThis.rejectRestore = reject; });`);
    const pending = ui.run('undoCancelScheduled()');
    assert.equal(ui.run('scheduleUndoBusy'), true);
    expireScheduleOffer(ui);
    assert.equal(ui.run('scheduleUndo'), null);
    assert.equal(ui.nodes.get('undo-schedule').hidden, true);
    ui.run(result === 'success' ? 'resolveRestore({})' : `rejectRestore(new Error('Restore rejected.'))`);
    await pending;
    const expected = result === 'success' ? 'Scheduled send restored.' : 'Restore rejected.';
    assert.equal(ui.nodes.get('scheduled-status').textContent, expected);
    assert.equal(ui.nodes.get('status').textContent, expected);
    assert.equal(ui.run('statusIsError'), result === 'failure');
    assert.equal(ui.run('scheduleUndoBusy'), false);
    assert.equal(ui.nodes.get('scheduled-undo').hidden, true);
  });

  for (const expired of [false,true]) {
    test('an old scheduled restore ' + result + ' cannot overwrite a newer ' + (expired ? 'expired' : 'active') + ' cancellation offer', async () => {
      const ui = fixture();
      ui.run(`clearUndo(); armScheduleUndo({id:'old'});
        call = () => new Promise((resolve,reject) => { globalThis.resolveRestore = resolve; globalThis.rejectRestore = reject; });`);
      const pending = ui.run('undoCancelScheduled()');
      expireScheduleOffer(ui);
      ui.run(`armScheduleUndo({id:'new'}); $('scheduled-status').textContent = 'New cancellation.'; showStatus('New cancellation.');`);
      if (expired) expireScheduleOffer(ui);
      ui.run(result === 'success' ? 'resolveRestore({})' : `rejectRestore(new Error('Old restore failed.'))`);
      await pending;
      assert.equal(ui.run('scheduleUndo && scheduleUndo.id'), expired ? null : 'new');
      assert.equal(ui.nodes.get('undo-schedule').hidden, expired);
      assert.equal(ui.nodes.get('undo-schedule').disabled, false);
      assert.equal(ui.nodes.get('scheduled-status').textContent, 'New cancellation.');
      assert.equal(ui.nodes.get('status').textContent, 'New cancellation.');
    });
  }
}

test('unclaimed scheduled offers still expire and restore failures can retry only before expiry', async () => {
  const ui = fixture();
  ui.run(`clearUndo(); armScheduleUndo({id:'old'}); call = async () => { throw new Error('Try again.'); }`);
  await ui.run('undoCancelScheduled()');
  assert.equal(ui.run('scheduleUndo.id'), 'old');
  assert.equal(ui.nodes.get('undo-schedule').disabled, false);
  expireScheduleOffer(ui);
  ui.run('globalThis.restoreCalls = 0; call = async () => { restoreCalls += 1; }');
  await ui.run('undoCancelScheduled()');
  assert.equal(ui.run('restoreCalls'), 0);
  assert.equal(ui.run('SCHEDULE_UNDO_MS'), 8000);
});
