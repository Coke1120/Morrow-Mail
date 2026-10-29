const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {renderer}=require('./check-ux-workflows');
async function run(){
  const nodes=new Map();
  const get=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',disabled:false,hidden:false,classList:{toggle(){},remove(){}},appendChild(child){child.parentElement=this;},setAttribute(){}});return nodes.get(id);};
  const ui=renderer({document:{getElementById:get}});
  ui.run(`state.oauthStatus={google:false}; globalThis.calls=[]; globalThis.rejectSignIn=null;
    call=async(channel)=>{calls.push(channel); return new Promise((_,reject)=>{rejectSignIn=reject;});};
  `);
  const signing=ui.run(`connectOAuth('microsoft')`);
  assert.match(get('connect-status').textContent,/browser/);
  assert.equal(get('oauth-microsoft').disabled,true);
  assert.equal(get('connect-close').textContent,'Cancel sign-in');
  assert.match(get('oauth-unavailable').textContent, /Review Google OAuth status in Settings → Accounts/);
  ui.run(`state.googleOauthClient={ready:true,source:'imported',imported:true}; paintGoogleOauthClient();`);
  assert.match(get('google-oauth-client-status').textContent, /your imported Desktop client/);
  assert.equal(get('google-oauth-clear').disabled, true, 'client changes wait for pending sign-in');
  assert.equal(get('google-oauth-import').disabled, true);
  ui.run(`state.googleOauthClient={ready:true,source:'env',imported:true}; paintGoogleOauthClient();`);
  assert.match(get('google-oauth-client-status').textContent, /developer environment variable/);
  ui.run(`state.googleOauthClient={ready:true,source:'bundled',imported:false}; paintGoogleOauthClient();`);
  assert.match(get('google-oauth-client-status').textContent, /bundled Desktop client/);
  assert.equal(get('google-oauth-clear').disabled, true);
  assert.equal(get('google-oauth-client-status').textContent.includes('client_secret'), false);
  await ui.run(`connectOAuth('microsoft')`);
  assert.equal(ui.run('calls.length'),1);
  ui.run(`rejectSignIn(new Error('Fixture consent rejected'))`);await signing;
  assert.match(get('connect-status').textContent,/Could not finish sign-in.*Fixture consent rejected/);
  assert.equal(get('oauth-microsoft').disabled,false);
  assert.equal(get('oauth-google').disabled,true);
  assert.equal(get('google-oauth-import').disabled,false);
  ui.run(`calls.length=0; call=async(channel)=>{calls.push(channel); if(channel==='mail:addAccount') return {id:'box',email:'ada@example.com'}; return [];};
    loadAccounts=()=>new Promise((resolve)=>setTimeout(resolve,40));`);
  const connected=ui.run(`connectOAuth('microsoft')`);
  await new Promise((resolve)=>setTimeout(resolve,15));
  assert.equal(ui.run('state.oauthPending'),false);
  assert.equal(get('connect-close').textContent,'Cancel');
  ui.run('dismissConnect()');
  assert.equal(ui.run(`calls.includes('mail:cancelOAuth')`),false);
  await connected;
  assert.match(get('status').textContent,/Connected ada@example.com/);
  ui.run('paintSyncControl()');
  assert.equal(get('sync-detail').hidden,true);
  assert.match(get('refresh').title,/Connect an account/);
  assert.equal(get('refresh').disabled,true);
  ui.run(`state.accounts=[{id:'a'}];state.accountId='a';state.folderId='Inbox';
    rememberSyncStatus({accountId:'b',folderId:'Inbox',accountLabel:'Other',folderLabel:'Inbox',state:'done',lastSuccessAt:1000});paintSyncControl();`);
  assert.equal(get('sync-detail').hidden,true);
  assert.equal(get('refresh').title,'Not synced yet');
  ui.run(`rememberSyncStatus({accountId:'a',folderId:'Inbox',accountLabel:'Mine',folderLabel:'Inbox',state:'done',lastSuccessAt:2000});paintSyncControl();`);
  assert.equal(get('sync-detail').hidden,true,'old success collapses beside Sync');
  assert.match(get('refresh').title,/Mine.*Inbox.*Last checked/);
  ui.run(`rememberSyncStatus({accountId:'a',folderId:'Inbox',state:'done',lastSuccessAt:2000,updatedAt:Date.now()});paintSyncControl();`);
  assert.match(get('sync-detail').textContent,/Synced/);
  ui.run(`rememberSyncStatus({accountId:'a',folderId:'Inbox',state:'done',lastSuccessAt:2000,updatedAt:1});paintSyncControl();`);
  ui.run(`state.view='log';loadCalendar=async()=>{};loadAgent=async()=>{};loadBrain=async()=>{};refreshLog=async()=>{};`);
  await ui.run('refresh()');
  assert.equal(get('status').textContent,'Log refreshed.');
  assert.equal(ui.run('currentFolderSync().lastSuccessAt'),2000);
  assert.match(ui.run(`syncDetail({state:'done',lastSuccessAt:3000})`),/Not synced yet/,'unscoped timestamp is never freshness');
  ui.run(`rememberSyncStatus({accountId:'a',state:'paused',message:'Provider paused',updatedAt:4000});paintSyncControl();`);
  assert.equal(ui.run('currentFolderSync().state'),'paused');
  ui.run(`showUndo('Archive: 1 completed; 1 unknown. Provider error.', ['verified-op'], true);showStatus('Marked read.');`);
  assert.match(get('status').textContent,/Provider error.*[\s\S]*Marked read/);
  statusChip();
  await undoDetails();
  console.log('dialog-feedback-ok');
}
function statusChip() {
  const classes = new Map();
  const nodes = new Map();
  const known = new Set(['status', 'notice', 'status-chip', 'undo', 'undo-send', 'undo-schedule']);
  function classListFor(id) {
    if (!classes.has(id)) classes.set(id, new Set());
    const names = classes.get(id);
    return {
      toggle(name, force) {
        const on = force === undefined ? !names.has(name) : !!force;
        if (on) names.add(name);
        else names.delete(name);
        return on;
      },
      contains(name) { return names.has(name); },
    };
  }
  function make(id) {
    return {
      id,
      value: '',
      textContent: '',
      hidden: id === 'undo' || id === 'undo-send' || id === 'undo-schedule',
      disabled: false,
      attrs: {},
      classList: classListFor(id),
      setAttribute(name, value) { this.attrs[name] = String(value); },
      getAttribute(name) { return this.attrs[name]; },
      contains(node) { return !!(node && node.insideNotice); },
      appendChild(child) { child.parentElement = this; },
    };
  }
  const doc = {
    getElementById(id) {
      if (!nodes.has(id)) {
        if (!known.has(id)) return null;
        nodes.set(id, make(id));
      }
      return nodes.get(id);
    },
    addEventListener() {},
    querySelector() { return null; },
  };
  const ui = renderer({ document: doc });
  ui.run(`
    globalThis.armed = [];
    globalThis.prevented = false;
    setTimeout = (fn, ms) => {
      const row = { id: armed.length + 1, fn, ms };
      armed.push(row);
      return { id: row.id, unref() {} };
    };
    clearTimeout = (handle) => {
      const row = armed.find((item) => item.id === (handle && handle.id));
      if (row) row.fn = null;
    };
  `);
  const live = () => ui.run('armed.filter((row) => row.fn)');
  const fire = () => ui.run('armed.filter((row) => row.fn).pop().fn()');
  const receipt = 'Move to Trash: 1 completed · 0 failed · 0 unknown · 0 not attempted.';
  ui.run(`showStatus(${JSON.stringify(receipt)})`);
  assert.equal(nodes.get('status').textContent, receipt);
  assert.equal(classes.get('notice').has('collapsed'), false);
  assert.equal(nodes.get('status-chip').hidden, false);
  assert.equal(nodes.get('status-chip').attrs['aria-expanded'], 'true');
  assert.equal(nodes.get('status-chip').attrs['aria-label'], 'Collapse status');
  assert.equal(ui.run('STATUS_SUCCESS_DWELL_MS'), 4000);
  assert.equal(live().length, 1);
  assert.equal(live()[0].ms, 4000);
  const staleFn = live()[0].fn;
  ui.run(`showStatus('Profile reloaded.')`);
  assert.equal(nodes.get('status').textContent, 'Profile reloaded.');
  assert.equal(staleFn === live()[0].fn, false);
  staleFn();
  assert.equal(classes.get('notice').has('collapsed'), false, 'a replaced timer must not fold the new line');
  assert.equal(live().length, 1);
  assert.equal(live()[0].ms, 4000);
  fire();
  assert.equal(classes.get('notice').has('collapsed'), true);
  assert.equal(nodes.get('status').textContent, 'Profile reloaded.');
  assert.equal(nodes.get('status-chip').attrs['aria-expanded'], 'false');
  assert.equal(nodes.get('status-chip').title, 'Profile reloaded.');
  assert.equal(nodes.get('status-chip').hidden, false);
  const armedBeforeRead = ui.run('armed.length');
  ui.run(`statusControl({ target: { closest(sel) { return sel === 'button' ? { id: 'status-chip' } : null; } } })`);
  assert.equal(classes.get('notice').has('collapsed'), false);
  assert.equal(ui.run('armed.length'), armedBeforeRead, 'reading the line again stays open');
  ui.run(`statusDismissPointer({ button: 0, target: { insideNotice: true } })`);
  assert.equal(classes.get('notice').has('collapsed'), false);
  ui.run(`statusDismissPointer({ button: 0, target: {} })`);
  assert.equal(classes.get('notice').has('collapsed'), true);
  ui.run(`statusControl({ target: { closest() { return null; } } })`);
  assert.equal(classes.get('notice').has('collapsed'), false);
  doc.querySelector = () => ({ open: true });
  ui.run(`prevented = false; statusDismissKey({ key: 'Escape', preventDefault() { prevented = true; } })`);
  assert.equal(ui.run('prevented'), false);
  assert.equal(classes.get('notice').has('collapsed'), false, 'Escape leaves an open dialog alone');
  doc.querySelector = () => null;
  nodes.set('organize-menu', { hidden: false });
  ui.run(`statusDismissKey({ key: 'Escape', preventDefault() { prevented = true; } })`);
  assert.equal(ui.run('prevented'), false);
  assert.equal(classes.get('notice').has('collapsed'), false, 'Escape leaves an open move menu alone');
  nodes.get('organize-menu').hidden = true;
  ui.run(`statusDismissKey({ key: 'Escape', preventDefault() { prevented = true; } })`);
  assert.equal(ui.run('prevented'), true);
  assert.equal(classes.get('notice').has('collapsed'), true);
  ui.run(`showStatus('Delivery was not confirmed.', true)`);
  assert.equal(classes.get('status').has('error'), true);
  assert.equal(classes.get('notice').has('error'), true);
  assert.equal(classes.get('notice').has('collapsed'), false);
  assert.equal(ui.run('STATUS_ERROR_DWELL_MS'), 12000);
  assert.equal(live().pop().ms, 12000);
  fire();
  assert.equal(classes.get('notice').has('collapsed'), true);
  assert.equal(classes.get('notice').has('error'), true, 'an error chip stays marked');
  assert.equal(nodes.get('status').textContent, 'Delivery was not confirmed.');
  ui.run(`showUndo(${JSON.stringify(receipt)}, ['op-1'], false)`);
  assert.equal(nodes.get('undo').hidden, false);
  assert.match(nodes.get('undo').textContent, /Undo 1 completed/);
  assert.equal(live().pop().ms, 4000);
  fire();
  assert.equal(classes.get('notice').has('collapsed'), true);
  assert.equal(nodes.get('undo').hidden, false, 'undo stays available on the chip');
  assert.equal(nodes.get('status').textContent, receipt);
  ui.run(`statusControl({ target: { closest() { return { id: 'undo' }; } } })`);
  assert.equal(classes.get('notice').has('collapsed'), true, 'undo does not toggle the chip');
  ui.run(`clearUndo(); showStatus('')`);
  assert.equal(nodes.get('status').textContent, '');
  assert.equal(nodes.get('status-chip').hidden, true);
  assert.equal(classes.get('notice').has('collapsed'), false);
  assert.equal(classes.get('notice').has('error'), false);
}
async function undoDetails() {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="notice">
      <button type="button" id="status-chip" aria-expanded="false"></button>
      <p id="status"></p>
      <button type="button" id="undo" hidden></button>
      <button type="button" id="undo-details" hidden aria-expanded="false"></button>
      <div id="undo-details-popover" role="dialog" aria-label="Undo details" hidden>
        <button type="button" id="undo-details-all">Select all</button>
        <button type="button" id="undo-details-clear">Clear</button>
        <ul id="undo-details-list"></ul>
        <button type="button" id="undo-details-selected" disabled>Undo selected (0)</button>
      </div>
    </div>
  </body>`);
  dom.window.morrow = { invoke: async () => ({ success: true, data: {} }), on() { return () => {}; } };
  const ui = renderer({
    document: dom.window.document,
    window: dom.window,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Event: dom.window.Event,
  });
  const doc = dom.window.document;
  const get = (id) => doc.getElementById(id);
  ui.run(`
    loadList = async () => {};
    renderList = () => {};
    renderReader = () => {};
    globalThis.undoCalls = [];
    globalThis.undoMode = 'ok';
    call = async (channel, payload) => {
      undoCalls.push({ channel, payload });
      if (channel !== 'mail:undoRemoval') return {};
      return {
        outcomes: (payload.opIds || []).map((id) => ({
          id: id === 'op-b' ? 'two' : 'one',
          status: undoMode === 'partial' && id === 'op-b' ? 'unknown' : 'completed',
          error: undoMode === 'partial' && id === 'op-b' ? 'kept' : undefined,
        })),
      };
    };
    state.emails = [
      { id: 'one', accountId: 'a', subject: 'Alpha report', from: 'Ada <ada@example.test>' },
      { id: 'two', accountId: 'b', subject: 'Beta report', from: 'Ben <ben@example.test>' },
    ];
  `);
  const archive = `finishBulkRemoval('Archive', { opIds: ['op-a', 'op-b'], outcomes: [
    { id: 'one', status: 'completed', opId: 'op-a' },
    { id: 'two', status: 'completed', opId: 'op-b' },
  ] }, ['one', 'two'])`;
  await ui.run(archive);
  assert.equal(get("undo").hidden, false);
  assert.equal(get("undo").textContent, "Undo 2 completed changes");
  assert.equal(get("undo-details").hidden, false);
  assert.equal(get("undo-details-popover").hidden, true);
  ui.run(`statusControl({ target: { nodeType: 1, closest(sel) { return sel === "button" ? { id: "status-chip" } : null; } } })`);
  assert.equal(get("undo-details-popover").hidden, true, "status chip does not open Details");
  assert.equal(get("undo-details").getAttribute("aria-expanded"), "false");
  ui.run("openUndoDetails()");
  assert.equal(get("undo-details-popover").hidden, false);
  assert.equal(get("undo-details-popover").getAttribute("role"), "dialog");
  assert.equal(get("undo-details").getAttribute("aria-expanded"), "true");
  assert.match(get("undo-details-list").textContent, /Alpha report/);
  assert.match(get("undo-details-list").textContent, /Ada/);
  assert.match(get("undo-details-list").textContent, /archive/);
  assert.match(get("undo-details-list").textContent, /Archive/);
  assert.match(get("undo-details-list").textContent, /Beta report/);
  const boxes = [...get("undo-details-list").querySelectorAll("input")];
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].getAttribute("aria-label"), "Alpha report");
  assert.equal(get("undo-details-selected").disabled, true);
  ui.run("setUndoDetailChecks(true)");
  assert.equal(get("undo-details-selected").textContent, "Undo selected (2)");
  assert.equal(get("undo-details-selected").disabled, false);
  boxes[0].focus();
  ui.run("paintUndoControls()");
  assert.equal(get("undo-details-selected").textContent, "Undo selected (2)", "repaint keeps the checklist selection");
  assert.equal(doc.activeElement.value, "op-a", "repaint keeps checkbox focus");
  ui.run("scheduleStatusCollapse()");
  assert.equal(ui.run("statusCollapseTimer"), 0, "Details interaction prevents timed collapse");
  ui.run("setUndoDetailChecks(false)");
  assert.equal(get("undo-details-selected").textContent, "Undo selected (0)");
  assert.equal(get("undo-details-selected").disabled, true);
  await ui.run("undoRemoval(['op-a'])");
  assert.deepEqual(JSON.parse(ui.run("JSON.stringify(undoCalls[0].payload)")), { opIds: ["op-a"], kind: "move" });
  assert.equal(get("undo").textContent, "Undo 1 completed changes");
  assert.equal(get("undo-details-popover").hidden, true);
  ui.run("openUndoDetails()");
  assert.match(get("undo-details-list").textContent, /Beta report/);
  assert.doesNotMatch(get("undo-details-list").textContent, /Alpha report/);
  ui.run("undoCalls.length = 0; undoMode = 'partial';");
  await ui.run(archive);
  await ui.run("undoRemoval()");
  assert.deepEqual(JSON.parse(ui.run("JSON.stringify(undoCalls[0].payload.opIds)")), ["op-a", "op-b"]);
  assert.equal(get("undo").textContent, "Undo 1 completed changes");
  assert.match(get("status").textContent, /Restore/);
  assert.match(get("status").textContent, /unknown/);
  assert.match(get("status").textContent, /kept/);
  ui.run("openUndoDetails()");
  assert.match(get("undo-details-list").textContent, /Beta report/);
  assert.doesNotMatch(get("undo-details-list").textContent, /Alpha report/);
  ui.run("undoMode = 'ok';");
  await ui.run("undoRemoval()");
  assert.equal(get("undo").hidden, true);
  assert.equal(get("undo-details").hidden, true);
  await ui.run(archive);
  ui.run("showReadUndo('Marked read.', [{ emailId: 'm', accountId: 'a' }])");
  assert.equal(ui.run("undoKind"), "removal");
  assert.equal(get("undo").textContent, "Undo 2 completed changes");
  assert.equal(get("undo-details").hidden, false);
  assert.match(get("status").textContent, /Marked read/);
  await ui.run(`finishBulkRemoval('Move', { opIds: ['op-m'], outcomes: [{ id: 'one', status: 'completed', opId: 'op-m' }] }, ['one'], { messages: state.emails, action: 'move', destinationLabel: 'Projects' })`);
  assert.equal(get("undo").textContent, "Undo 1 completed changes");
  ui.run("openUndoDetails()");
  assert.match(get("undo-details-list").textContent, /Alpha report/);
  assert.match(get("undo-details-list").textContent, /move/);
  assert.match(get("undo-details-list").textContent, /Projects/);
  assert.doesNotMatch(get("undo-details-list").textContent, /Beta report/);
  ui.run("prevented = false; statusDismissKey({ key: 'Escape', preventDefault() { prevented = true; } });");
  assert.equal(ui.run("prevented"), true);
  assert.equal(get("undo-details-popover").hidden, true);
  assert.equal(doc.activeElement, get("undo-details"));
  ui.run("openUndoDetails()");
  ui.run("statusDismissPointer({ button: 0, target: document.body })");
  assert.equal(get("undo-details-popover").hidden, true);
  assert.deepEqual(JSON.parse(ui.run("JSON.stringify(retainedUndoOpIds(['op-a','op-b'], [{status:'completed'},{status:'completed'}], [{opId:'op-a',messageId:'one'},{opId:'op-b',messageId:'two'}]))")), []);
  assert.deepEqual(JSON.parse(ui.run("JSON.stringify(retainedUndoOpIds(['op-a'], [{id:'one', status:'unknown'}], [{opId:'op-a', messageId:'one'}]))")), ["op-a"]);
  ui.run("call = () => new Promise((resolve) => { globalThis.releaseUndo = resolve; });");
  ui.run("openUndoDetails()");
  const pending = ui.run("undoRemoval()");
  ui.run("openUndoDetails()");
  assert.equal(get("undo-details-popover").hidden, true, "Details stays closed while Undo is running");
  assert.equal(get("undo-details").disabled, true);
  assert.equal(doc.activeElement, get("status-chip"), "closing a busy popover focuses visible chrome");
  ui.run("releaseUndo({ outcomes: [{ id: 'one', status: 'completed' }] })");
  await pending;
  assert.equal(get("undo").hidden, true);
  await ui.run(archive);
  ui.run(`state.selectedIds = ['one', 'two']; openUndoDetails(); onSelectionKey({ key: 'Escape', target: document.body, preventDefault() {} });`);
  assert.deepEqual(JSON.parse(ui.run("JSON.stringify(state.selectedIds)")), ["one", "two"]);
  ui.run(`statusDismissKey({ key: 'Escape', preventDefault() {} });`);
  assert.equal(get("undo-details-popover").hidden, true);
  assert.deepEqual(JSON.parse(ui.run("JSON.stringify(state.selectedIds)")), ["one", "two"]);
  ui.run(`onSelectionKey({ key: 'Escape', target: document.body, preventDefault() {} });`);
  assert.deepEqual(JSON.parse(ui.run("JSON.stringify(state.selectedIds)")), []);
  ui.run(`
    globalThis.settleOnLoad = false;
    globalThis.settledUndo = false;
    loadList = async () => {
      if (!settleOnLoad || settledUndo) return;
      settledUndo = true;
      applyActionSettlement({
        outcomes: [
          { id: 'one', kind: 'undo', status: 'completed' },
          { id: 'two', kind: 'undo', status: 'failed', retryOpId: 'op-b', error: 'kept' },
        ],
        opIds: ['op-b'],
      });
    };
    call = async () => ({ outcomes: [], pending: [{ id: 'one' }, { id: 'two' }] });
  `);
  await ui.run(archive);
  ui.run("settleOnLoad = true;");
  await ui.run("undoRemoval()");
  assert.equal(get("undo").textContent, "Undo 1 completed changes");
  assert.equal(get("undo").disabled, false);
  ui.run("openUndoDetails()");
  assert.match(get("undo-details-list").textContent, /Beta report/);
  assert.doesNotMatch(get("undo-details-list").textContent, /Alpha report/);
  ui.run(`
    loadList = async () => {};
    call = async () => ({ outcomes: [], pending: [{ id: 'one' }] });
  `);
  await ui.run(`finishBulkRemoval('Move', { opIds: ['op-m'], outcomes: [{ id: 'one', status: 'completed', opId: 'op-m' }] }, ['one'], { messages: state.emails, action: 'move', destinationLabel: 'Projects' })`);
  const epoch = ui.run("undoEpoch");
  await ui.run("undoRemoval()");
  assert.equal(get("undo").disabled, true, "pending undo waits for settlement");
  await ui.run(`finishBulkRemoval('Archive', { opIds: ['op-new'], outcomes: [{ id: 'two', status: 'completed', opId: 'op-new' }] }, ['two'])`);
  assert.notEqual(ui.run("undoEpoch"), epoch);
  ui.run(`applyActionSettlement({ outcomes: [{ id: 'one', kind: 'undo', status: 'failed', retryOpId: 'op-m', error: 'old removal' }], opIds: ['op-m'] })`);
  assert.equal(get("undo").textContent, "Undo 1 completed changes");
  ui.run("openUndoDetails()");
  assert.match(get("undo-details-list").textContent, /Beta report/);
  assert.doesNotMatch(get("undo-details-list").textContent, /Alpha report/);
  assert.doesNotMatch(get("undo-details-list").textContent, /old removal/);
}
module.exports={run};
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
