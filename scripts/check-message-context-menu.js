// Synthetic renderer/IPC regressions. Never connect to a mailbox.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const { renderer } = require("./check-ux-workflows");
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

function fixture(t) {
  const window = new JSDOM(fs.readFileSync(require.resolve("../renderer/index.html"), "utf8"), { url: "https://fixture.invalid" }).window;
  t.after(() => window.close());
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new window.Event("close")); };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.morrow = {};
  const ui = renderer({ window, document: window.document, localStorage: window.localStorage, Event: window.Event, Node: window.Node });
  ui.run(`
    state.accounts=['a','b'].map(id=>({id,email:id+'@fixture.invalid',createdAt:1,platform:'imap',imapSmtpProfile:'custom',
      folders:{primary:[{id:'INBOX',name:'Inbox',wellKnownName:'inbox'},{id:'Archive',name:'Archive',wellKnownName:'archive'},{id:'Trash',name:'Trash',wellKnownName:'deleteditems'}],more:[]}}));
    state.localAccount={id:LOCAL_ACCOUNT_ID,folders:{primary:[{id:'local-folder:archive',name:'Archive'}],more:[]}};
    state.emails=[{id:'clicked',accountId:'a',folderId:'INBOX',subject:'Synthetic clicked row',unread:true},
      {id:'selected',accountId:'b',folderId:'INBOX',subject:'Synthetic preview',unread:false,isStarred:true},
      {id:'second',accountId:'b',folderId:'INBOX',subject:'Synthetic second selection',unread:true}];
    state.email=state.emails[1]; state.accountId='b'; state.folderId='INBOX'; state.selectedIds=['selected'];
    globalThis.hits=[]; showStatus=(text,error)=>hits.push({status:text,error});
    bulkSetRead=async(isRead,rows)=>hits.push({action:'read',isRead,items:rows.map(row=>[row.id,row.accountId])});
    bulkStar=async(isStarred,rows)=>hits.push({action:'star',isStarred,items:rows.map(row=>[row.id,row.accountId])});
    queueBulkRemoval=(label,calls,rows)=>hits.push({action:'remove',label,calls,ids:rows.map(row=>row.id)});
    askConfirm=async()=>({ok:true});
    loadLocalFolders=async()=>{};
    wireOrganize();
  `);
  for (const [id, accountId] of [["clicked", "a"], ["selected", "b"], ["second", "b"]]) {
    const row = window.document.createElement("div"); row.className = "message-row";
    Object.assign(row.dataset, { emailId: id, accountId, folderId: "INBOX" });
    const button = window.document.createElement("button"); button.className = "message"; button.textContent = id;
    row.append(button); window.document.getElementById("messages").append(row);
  }
  return { ui, window, document: window.document,
    open(id = "clicked") { window.document.querySelector(`[data-email-id="${id}"] button`).dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 25, clientY: 25 })); },
    action(label) { return [...window.document.querySelectorAll('#organize-menu [role="menuitem"]')].find(button => button.textContent === label); } };
}

test("row menu captures the clicked account/message, has ordered capabilities and restores keyboard focus", async t => {
  const f = fixture(t); f.open(); await tick();
  assert.deepEqual([...f.document.querySelectorAll('#organize-menu [role="menuitem"]')].map(node => node.textContent),
    ['Move to folder…','Move / Copy to other mailbox…','Labels…','Mark as read','Star','Move to trash','Archive']);
  assert.equal(f.action('Labels…').disabled, true);
  assert.match(f.action('Labels…').title, /uses folders/);
  assert.deepEqual(Array.from(f.ui.run('state.selectedIds')), ['selected']);
  assert.equal(f.ui.run('state.email.id'), 'selected', 'context click does not open or mark another message read');
  f.action('Move to folder…').dispatchEvent(new f.window.KeyboardEvent('keydown', {key:'ArrowDown',bubbles:true}));
  assert.equal(f.document.activeElement, f.action('Move / Copy to other mailbox…'));
  f.document.activeElement.dispatchEvent(new f.window.KeyboardEvent('keydown', {key:'ArrowDown',bubbles:true}));
  assert.equal(f.document.activeElement, f.action('Mark as read'), 'disabled labels is skipped');
  f.document.activeElement.dispatchEvent(new f.window.KeyboardEvent('keydown', {key:'End',bubbles:true}));
  assert.equal(f.document.activeElement, f.action('Archive'));
  f.document.activeElement.dispatchEvent(new f.window.KeyboardEvent('keydown', {key:'Home',bubbles:true}));
  assert.equal(f.document.activeElement, f.action('Move to folder…'));
  f.document.activeElement.dispatchEvent(new f.window.KeyboardEvent('keydown', {key:'Escape',bubbles:true}));
  const clicked = f.document.querySelector('[data-email-id="clicked"] button');
  assert.equal(f.document.activeElement, clicked);
  clicked.dispatchEvent(new f.window.KeyboardEvent('keydown', {key:'F10',shiftKey:true,bubbles:true,cancelable:true}));
  await tick(); f.action('Mark as read').click(); await tick();
  assert.equal(f.ui.run('hits[0].action'), 'read');
  assert.deepEqual(Array.from(f.ui.run('hits[0].items[0]')), ['clicked', 'a']);
  f.open(); f.ui.run("state.accountId='b'; state.selectedIds=['second']; state.email=state.emails[2]");
  f.action('Star').click(); await tick();
  assert.deepEqual(Array.from(f.ui.run('hits[1].items[0]')), ['clicked', 'a']);
  f.open(); f.ui.run("state.accounts[0].createdAt=2"); f.action('Star').click(); await tick();
  assert.match(f.ui.run('hits.at(-1).status'), /mailbox changed/);
  assert.equal(f.ui.run("hits.filter(row=>row.action==='star').length"), 1);
});

test("selection callbacks keep reviewed IDs and Trash never uses permanent batch deletion or thread expansion", async t => {
  const f = fixture(t);
  f.ui.run("state.selectedIds=['selected','second']; state.prefs.conversation=true; state.emails[1].threadId='conversation'");
  f.open('selected'); f.ui.run("state.selectedIds=['clicked']; state.email=state.emails[0]");
  f.action('Mark as read').click(); await tick();
  assert.deepEqual(Array.from(f.ui.run('hits[0].items'), row => Array.from(row)), [['selected','b'],['second','b']]);
  f.open(); f.action('Move to trash').click(); await tick();
  assert.equal(f.ui.run('hits[1].calls.length'), 1);
  assert.equal(f.ui.run('hits[1].calls[0].channel'), 'mail:delete');
  assert.equal(f.ui.run('hits[1].calls[0].params.moveToTrashOnly'), true);
  assert.equal(f.ui.run('hits[1].calls[0].params.emailId'), 'clicked');
  assert.equal(f.ui.run('hits[1].calls[0].params.accountId'), 'a');
  assert.equal(f.ui.run('hits[1].calls[0].params.threadId'), undefined);
  f.ui.run("state.emails[0].folderId='Trash'"); f.open();
  assert.equal(f.action('Move to trash').disabled, true);
  assert.match(f.action('Move to trash').title, /never deletes permanently/);
});

test("confirmation and transfer review survive navigation but reject replaced source accounts and remote destination tampering", async t => {
  const f = fixture(t);
  f.ui.run("askConfirm=()=>new Promise(resolve=>globalThis.confirmLater=resolve)");
  f.open(); f.action('Move to trash').click(); await tick();
  f.ui.run("state.accounts[0].createdAt=7; confirmLater({ok:true})"); await tick();
  assert.equal(f.ui.run("hits.filter(row=>row.action==='remove').length"), 0);
  assert.match(f.ui.run('hits.at(-1).status'), /mailbox changed while confirmation/);
  await f.ui.run("openLocalTransfer([state.emails[0]],'copy')");
  const accounts = f.document.getElementById('local-transfer-account');
  assert.equal(accounts.value, f.ui.run('LOCAL_ACCOUNT_ID'));
  assert.equal(accounts.options.length, 3);
  assert.equal(accounts.options[1].disabled, true);
  assert.equal(accounts.options[2].disabled, true);
  assert.match(f.document.getElementById('local-transfer-capability').textContent, /into another connected mailbox is not supported yet/);
  f.ui.run("call=async(channel,params)=>{hits.push({channel,params});return {status:'copied'}}; renderAccounts=async()=>{}; loadList=async()=>{};");
  accounts.value='b'; await f.ui.run('commitLocalTransfer()');
  assert.equal(f.ui.run('hits.some(row=>row.channel)'), false);
  assert.match(f.document.getElementById('local-transfer-status').textContent, /Choose Local Folders/);
  accounts.value = f.ui.run('LOCAL_ACCOUNT_ID');
  f.ui.run("state.accountId='b'; state.selectedIds=['selected']; state.email=state.emails[1]");
  await f.ui.run('commitLocalTransfer()');
  assert.equal(f.ui.run('hits.at(-2).channel'), 'mail:transferToLocal');
  assert.equal(f.ui.run('hits.at(-2).params.emailId'), 'clicked');
  assert.equal(f.ui.run('hits.at(-2).params.accountId'), 'a');
  assert.equal(f.ui.run('hits.at(-2).params.mode'), 'copy');
});
