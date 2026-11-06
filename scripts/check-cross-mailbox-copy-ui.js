// Real renderer functions and synthetic IPC only. No credentials or provider calls.
const { test } = require("node:test");
const assert = require("node:assert/strict"), fs = require("node:fs");
const { JSDOM } = require("jsdom");
const { renderer } = require("./check-ux-workflows");
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const window = new JSDOM(fs.readFileSync(require.resolve("../renderer/index.html"), "utf8"), { url: "https://fixture.invalid" }).window;
  t.after(() => window.close());
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new window.Event("close")); };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.morrow = {};
  const ui = renderer({ window, document: window.document, localStorage: window.localStorage, Event: window.Event, Node: window.Node });
  ui.run(`
    state.accounts=['a','b','c'].map(id=>({id,email:id+'@fixture.invalid',platform:'imap',imapSmtpProfile:'custom',
      imapUsername:id+'@fixture.invalid',authKind:'password',mailTransport:'imap',bodyEpoch:1,bodyVersion:0,
      imapSmtpCustom:{imap:{host:'imap.fixture.invalid',port:993,tls:true},smtp:{host:'smtp.fixture.invalid',port:465,tls:true}},
      folders:{primary:[{id:'INBOX',name:'Inbox',wellKnownName:'inbox'},{id:'Archive',name:'Archive'},{id:'Trash',name:'Trash'}],more:[]}}));
    state.localAccount={id:LOCAL_ACCOUNT_ID,folders:{primary:[{id:'local-folder:archive',name:'Archive'},{id:'local-folder:projects',name:'Projects'}],more:[]}};
    state.emails=[{id:'clicked',accountId:'a',folderId:'INBOX',subject:'Synthetic clicked source'},
      {id:'selected',accountId:'b',folderId:'INBOX',subject:'Unrelated selected preview'},
      {id:'second',accountId:'a',folderId:'INBOX',subject:'Synthetic second source'}];
    state.accountId='b'; state.email=state.emails[1]; state.folderId='INBOX'; state.selectedIds=['selected'];
    globalThis.calls=[]; globalThis.confirmations=[]; globalThis.reviews=new Map(); globalThis.reviewSequence=0;
    globalThis.statuses=[]; globalThis.hook=null;
    showStatus=(text,error)=>statuses.push({text,error});
    loadLocalFolders=async()=>{}; loadList=async()=>{}; renderAccounts=()=>{};
    askConfirm=async copy=>{confirmations.push(copy);return {ok:true}};
    globalThis.capabilities=accountId=>({accountId,copyEnabled:true,copyReason:'',moveEnabled:false,
      moveReason:'Connected Move is unavailable; sources stay in place.',maxBytes:33554432,maxMessages:50,maxTotalBytes:268435456,
      folders:[{id:'Archive',name:'Archive',path:'Archive',enabled:true,reason:''},
        {id:'Trash',name:'Trash',path:'Trash',enabled:false,reason:'Trash cannot receive verified imports.'}],
      notices:['Provider may group the copied mail.']});
    globalThis.reply=params=>{
      if(params.action==='destinations') return capabilities(params.destinationAccountId);
      if(params.action==='review') {
        const review={reviewId:'review-'+(++reviewSequence),accountId:params.destinationAccountId,folderId:params.folderId,
          sourceCount:params.items.length,sourceLabels:[...new Set(params.items.map(row=>row.accountId===LOCAL_ACCOUNT_ID?'Local Folders':row.accountId+'@fixture.invalid'))],
          destinationLabel:params.destinationAccountId+'@fixture.invalid / '+params.folderId,
          notices:['Synthetic verified review.'],expiresAt:Date.now()+60000,maxBytes:33554432,maxMessages:50,maxTotalBytes:268435456};
        reviews.set(review.reviewId,review); return review;
      }
      if(params.action==='cancelReview') return {cancelled:true};
      if(params.action==='copy') {const review=reviews.get(params.reviewId); if(!review) throw new Error('Unknown synthetic review');
        return {status:'copied',receiptId:'receipt-'+params.emailId,detail:'Verified synthetic copy.',
          destination:{accountId:review.accountId,folderId:review.folderId},sourceRetained:true};}
      throw new Error('Unexpected action '+params.action);
    };
    call=async(channel,params)=>{
      calls.push({channel,params});
      if(channel!=='mail:crossMailboxCopy') return {status:'copied'};
      if(hook) {const result=await hook(params); if(result!==undefined) return result;}
      return reply(params);
    };
  `);
  return { ui, window, document: window.document,
    get(id) { return window.document.getElementById(id); },
    async open(expression = "[state.emails[0]]", mode = "copy") { await ui.run(`openLocalTransfer(${expression},'${mode}')`); },
    async choose(accountId = "b") { ui.run(`$('local-transfer-account').value=${JSON.stringify(accountId)}`); await ui.run("chooseLocalTransferAccount()"); },
    rows(action) { return JSON.parse(ui.run(`JSON.stringify(calls.filter(row=>row.params?.action===${JSON.stringify(action)}))`)); },
    status() { return window.document.getElementById("local-transfer-status").textContent; },
  };
}

test("connected Copy reviews captured clicked owners and uses one ticket for each exact sequential source", async t => {
  const f = fixture(t); await f.open("[state.emails[0],state.emails[2]]"); await f.choose();
  assert.equal(f.get("local-transfer-account").options[1].disabled, false);
  assert.equal(f.get("local-transfer-mode").querySelector('[value="move"]').disabled, true);
  assert.match(f.get("local-transfer-help").textContent, /original valid Date header/);
  assert.match(f.get("local-transfer-help").textContent, /UIDPLUS or IMAP4rev2/);
  assert.match(f.get("local-transfer-capability").textContent, /256 MiB total per review/);
  assert.match(f.get("local-transfer-folder-reasons").textContent, /Trash cannot receive verified imports/);
  assert.match(f.get("local-transfer-notices").textContent, /Provider may group/);
  const owner = f.rows("destinations")[0].params;
  assert.deepEqual(owner.items, [{ emailId: "clicked", accountId: "a" }, { emailId: "second", accountId: "a" }]);
  assert.deepEqual(owner.contextOwners.map(row => [row.emailId, row.accountId, row.folderId, row.bodyEpoch]), [["clicked", "a", "INBOX", 1], ["second", "a", "INBOX", 1]]);
  assert.deepEqual(owner.destinationOwner, { accountId: "b", bodyEpoch: 1, connection: f.ui.run("contextAccountProof('b')") });
  f.ui.run("state.accountId='c';state.email=state.emails[1];state.selectedIds=['selected'];state.accounts[0].bodyVersion++;state.accounts[1].bodyVersion++");
  await f.ui.run("commitLocalTransfer()");
  assert.match(f.ui.run("confirmations[0].body"), /2 messages from a@fixture.invalid.*b@fixture.invalid \/ Archive/);
  assert.match(f.ui.run("confirmations[0].body"), /Every source message stays in place.*all attachments and read\/star state/);
  assert.match(f.ui.run("confirmations[0].body"), /original valid Date header.*started upload cannot be recalled/);
  assert.deepEqual(f.rows("review")[0].params.contextOwners, owner.contextOwners);
  assert.deepEqual(f.rows("review")[0].params.destinationOwner, owner.destinationOwner);
  assert.deepEqual(f.rows("copy").map(row => row.params), [
    { action: "copy", reviewId: "review-1", emailId: "clicked", accountId: "a" },
    { action: "copy", reviewId: "review-1", emailId: "second", accountId: "a" },
  ]);
  assert.match(f.status(), /2 copied.*Every source message was retained/);
  assert.equal(f.get("local-transfer-ok").disabled, true);
  await f.ui.run("commitLocalTransfer()"); assert.equal(f.rows("copy").length, 2, "completed dialog cannot replay");
  assert.equal(f.rows("cancelReview").length, 1);
});

test("Local source Copy sends only remote context owners and preserves existing local Copy/Move paths", async t => {
  const f = fixture(t);
  await f.open("[{id:'local-one',accountId:LOCAL_ACCOUNT_ID,folderId:'local-folder:archive',subject:'Local original'}]");
  await f.choose(); await f.ui.run("commitLocalTransfer()");
  assert.deepEqual(f.rows("review")[0].params.contextOwners, []);
  assert.equal(f.rows("copy")[0].params.accountId, f.ui.run("LOCAL_ACCOUNT_ID"));
  assert.match(f.ui.run("confirmations[0].body"), /Local Folders/);
  f.get("local-transfer-cancel").click();
  await f.open("[{id:'local-one',accountId:LOCAL_ACCOUNT_ID,folderId:'local-folder:archive',subject:'Local original'}]", "move");
  assert.equal(f.get("local-transfer-folder").value, "local-folder:projects");
  await f.ui.run("commitLocalTransfer()");
  assert.equal(f.ui.run("calls.at(-1).channel"), "mail:moveLocalMessage");
  assert.equal(f.ui.run("calls.at(-1).params.mode"), "move");
});

test("disabled capabilities, disabled folders, 50-selection limit and connected Move stay explained and cannot write", async t => {
  const f = fixture(t); await f.open();
  f.ui.run("capabilities=accountId=>({accountId,copyEnabled:false,copyReason:'Server has no persistent import UID.',moveEnabled:false,moveReason:'Remote Move unavailable.',folders:[{id:'Archive',name:'Archive',enabled:false,reason:'Readback unsupported.'}],notices:[],maxBytes:33554432,maxMessages:50,maxTotalBytes:268435456})");
  await f.choose(); assert.equal(f.get("local-transfer-ok").disabled, true);
  assert.match(f.get("local-transfer-capability").textContent, /no persistent import UID.*Remote Move unavailable/);
  assert.match(f.get("local-transfer-folder-reasons").textContent, /Readback unsupported/);
  await f.ui.run("commitLocalTransfer()"); assert.equal(f.rows("review").length, 0);
  f.get("local-transfer-cancel").click();
  await f.open("Array.from({length:51},(_,i)=>({...state.emails[0],id:'source-'+i}))");
  const before = f.rows("destinations").length; await f.choose();
  assert.equal(f.rows("destinations").length, before); assert.match(f.get("local-transfer-capability").textContent, /up to 50 messages and 32 MiB/);
  await f.choose(f.ui.run("LOCAL_ACCOUNT_ID")); assert.equal(f.get("local-transfer-ok").disabled, false);
  f.get("local-transfer-cancel").click(); await f.open("[state.emails[0]]", "move"); await f.choose();
  assert.equal(f.get("local-transfer-mode").value, "copy", "choosing a connected destination switches visibly to supported Copy");
  f.get("local-transfer-mode").value = "move"; f.get("local-transfer-mode").dispatchEvent(new f.window.Event("change"));
  await f.ui.run("commitLocalTransfer()"); assert.equal(f.rows("review").length, 0);
});

const mutations = {
  "source account replaced": "state.accounts[0]={...state.accounts[0],bodyEpoch:2}",
  "source connection changed": "state.accounts[0].imapSmtpCustom.imap.host='changed.fixture.invalid'",
  "source folder changed": "state.emails[0].folderId='Archive'",
  "source folder removed": "state.accounts[0].folders.primary.shift()",
  "destination account replaced": "state.accounts[1]={...state.accounts[1],bodyEpoch:2}",
  "destination connection changed": "state.accounts[1].imapSmtpCustom.imap.tls=false",
  "destination folder changed": "state.accounts[1].folders.primary[1].name='Replaced archive'",
  "folder selection changed": "$('local-transfer-folder').value='Trash'",
  "action changed": "$('local-transfer-mode').value='move';$('local-transfer-mode').dispatchEvent(new Event('change'))",
};

for (const phase of ["destinations", "review", "confirmation", "copy"]) {
  test(`captured source/destination/folder/action changes across ${phase} await stop later Copy requests`, async t => {
    for (const [label, mutation] of Object.entries(mutations)) {
      const f = fixture(t); await f.open("[state.emails[0],state.emails[2]]");
      if (phase !== "destinations") await f.choose();
      if (phase === "confirmation") {
        f.ui.run("askConfirm=copy=>{confirmations.push(copy);return new Promise(resolve=>globalThis.release=resolve)}");
      } else {
        f.ui.run(`hook=params=>params.action===${JSON.stringify(phase)}?new Promise(resolve=>globalThis.release=()=>resolve(reply(params))):undefined`);
      }
      const pending = phase === "destinations" ? f.choose() : f.ui.run("commitLocalTransfer()");
      await tick();
      f.ui.run(mutation);
      f.ui.run(phase === "confirmation" ? "release({ok:true})" : "release()"); await pending; await tick();
      assert.equal(f.rows("copy").length, phase === "copy" ? 1 : 0, `${phase}: ${label}`);
      if (phase === "review" || phase === "confirmation") assert.equal(f.rows("cancelReview").length, 1, `${phase}: ${label} retires the unused review`);
      assert.equal(f.ui.run("state.email.id"), "selected", "never rebind to selected preview");
    }
  });
}

test("opening waits preserve source proof and newer open wins over a late Local Folders callback", async t => {
  const f = fixture(t);
  f.ui.run("loadLocalFolders=()=>new Promise(resolve=>globalThis.release=resolve)");
  const old = f.open(); await tick(); f.ui.run("state.accounts[0].bodyEpoch=2;release()"); await old;
  assert.equal(f.get("local-transfer").open, false); assert.match(f.ui.run("statuses.at(-1).text"), /source mailbox changed/);
  const older = f.open(); await tick();
  f.ui.run("globalThis.releaseOld=release;loadLocalFolders=async()=>{}");
  await f.open("[state.emails[2]]"); f.ui.run("releaseOld()"); await older;
  assert.equal(f.ui.run("localTransfer.messages[0].id"), "second");
  f.ui.run("loadLocalFolders=()=>new Promise(resolve=>globalThis.release=resolve)");
  const closing = f.open(); await tick(); f.get("local-transfer-cancel").click();
  f.ui.run("release()"); await closing;
  assert.equal(f.get("local-transfer").open, false, "closing also retires a pending replacement open");
});

test("support errors keep candidates available and selecting a mailbox captures a fresh proof only at that choice", async t => {
  const f = fixture(t); await f.open();
  f.ui.run("hook=params=>{if(params.action==='destinations')throw new Error('Synthetic capability failure')}");
  await f.choose(); assert.match(f.get("local-transfer-capability").textContent, /could not be checked.*Synthetic capability failure/);
  assert.equal(f.get("local-transfer-ok").disabled, true);
  f.ui.run("hook=null;state.accounts[1].bodyEpoch=2"); await f.choose();
  assert.equal(f.rows("destinations").at(-1).params.destinationOwner.bodyEpoch, 2);
  await f.ui.run("commitLocalTransfer()"); assert.equal(f.rows("copy").length, 1);
});

test("cancelling confirmation retires only its ticket, performs no upload, and leaves a fresh explicit review possible", async t => {
  const f = fixture(t); await f.open(); await f.choose();
  f.ui.run("askConfirm=async()=>({ok:false})"); await f.ui.run("commitLocalTransfer()");
  assert.equal(f.rows("copy").length, 0); assert.equal(f.rows("cancelReview")[0].params.reviewId, "review-1");
  assert.match(f.status(), /No messages were uploaded/);
  f.ui.run("askConfirm=async()=>({ok:true})"); await f.ui.run("commitLocalTransfer()");
  assert.equal(f.rows("copy")[0].params.reviewId, "review-2");
});

test("closing/reopening during destinations, review, confirmation and cancellation cannot mutate the newer dialog or replay uploads", async t => {
  for (const phase of ["destinations", "review", "confirmation", "cancelReview"]) {
    const f = fixture(t); await f.open();
    if (phase !== "destinations") await f.choose();
    if (phase === "confirmation") f.ui.run("askConfirm=()=>new Promise(resolve=>globalThis.release=()=>resolve({ok:true}))");
    else f.ui.run(`hook=params=>params.action===${JSON.stringify(phase)}?new Promise(resolve=>globalThis.release=()=>resolve(reply(params))):undefined`);
    const pending = phase === "destinations" ? f.choose() : phase === "cancelReview" ? null : f.ui.run("commitLocalTransfer()");
    if (phase === "cancelReview") {
      f.ui.run("localTransfer.reviewId='review-old'");
    }
    await tick(); f.get("local-transfer-cancel").click();
    await f.open("[state.emails[2]]");
    f.get("local-transfer").dispatchEvent(new f.window.Event("close"));
    f.ui.run("release()"); if (pending) await pending; await tick();
    assert.equal(f.ui.run("localTransfer.messages[0].id"), "second", phase);
    assert.equal(f.ui.run("localTransfer.destination.accountId"), f.ui.run("LOCAL_ACCOUNT_ID"), phase);
    assert.equal(f.rows("copy").length, 0, phase);
    assert.equal(f.status(), "", phase);
    if (phase === "review" || phase === "confirmation") assert.equal(f.rows("cancelReview").length, 1, phase);
  }
});

test("Stop and Escape finish only the started message; no new dialog or second write can start concurrently", async t => {
  for (const escape of [false, true]) {
    const f = fixture(t); await f.open("[state.emails[0],state.emails[2]]"); await f.choose();
    f.ui.run("hook=params=>params.action==='copy'?new Promise(resolve=>globalThis.release=()=>resolve(reply(params))):undefined");
    const pending = f.ui.run("commitLocalTransfer()"); await tick();
    await f.ui.run("commitLocalTransfer()"); await f.open("[state.emails[1]]");
    assert.equal(f.ui.run("localTransfer.messages[0].id"), "clicked");
    if (escape) {
      const event = new f.window.Event("cancel", { cancelable: true }); f.get("local-transfer").dispatchEvent(event); assert.equal(event.defaultPrevented, true);
    } else f.get("local-transfer-cancel").click();
    f.ui.run("release()"); await pending;
    assert.equal(f.rows("copy").length, 1);
    assert.match(f.status(), /1 copied.*1 not confirmed or not attempted.*Stopped after the current message/);
    await f.ui.run("commitLocalTransfer()"); assert.equal(f.rows("copy").length, 1);
  }
});

test("unknown, failed, invalid, and thrown copy results stop the batch and cannot be replayed by submission or reopen", async t => {
  for (const expression of [
    "({...reply(params),status:'unknown',detail:'Synthetic lost readback.'})",
    "({...reply(params),status:'failed',detail:'Synthetic pre-upload refusal.'})",
    "({...reply(params),status:'reused',receiptId:null})",
    "(()=>{throw new Error('Synthetic timeout')})()",
  ]) {
    const f = fixture(t); await f.open("[state.emails[0],state.emails[2]]"); await f.choose();
    f.ui.run(`hook=params=>params.action==='copy'?${expression}:undefined`);
    await f.ui.run("commitLocalTransfer()");
    assert.equal(f.rows("copy").length, 1, expression);
    assert.match(f.status(), /Every source message was retained/);
    if (!expression.includes("status:'failed'")) assert.match(f.status(), /destination may contain a copy|will not retry/);
    if (expression.includes("status:'unknown'")) assert.match(f.status(), /Automatic retry is blocked.*Synthetic lost readback/);
    await f.ui.run("commitLocalTransfer()"); assert.equal(f.rows("copy").length, 1);
    f.get("local-transfer-cancel").click(); await f.open(); await f.choose();
    assert.equal(f.rows("copy").length, 1, "opening and checking support never replays an upload");
  }
});

test("only verified reused receipts count and expired or mismatched host reviews never upload", async t => {
  const f = fixture(t); await f.open(); await f.choose();
  f.ui.run("hook=params=>params.action==='copy'?({...reply(params),status:'reused'}):undefined");
  await f.ui.run("commitLocalTransfer()"); assert.match(f.status(), /0 copied; 1 verified existing copies; 0 not confirmed/);
  for (const change of ["sourceCount:9", "accountId:'wrong'", "folderId:'wrong'", "expiresAt:Date.now()-1"]) {
    f.get("local-transfer-cancel").click(); await f.open(); await f.choose();
    f.ui.run(`hook=params=>params.action==='review'?({...reply(params),${change}}):undefined`);
    await f.ui.run("commitLocalTransfer()"); assert.equal(f.rows("copy").length, 1, change);
    assert.match(f.status(), /did not match|expired/);
  }
});

test("closing restores focus, host notices are inert text, and Features/CLI claims match exact catalog tuple", async t => {
  const f = fixture(t), trigger = f.get("search-query"); trigger.focus(); await f.open(); await f.choose();
  f.ui.run("globalThis.capabilitiesOriginal=capabilities;capabilities=accountId=>({...capabilitiesOriginal(accountId),notices:['<img src=x onerror=alert(1)>']})");
  await f.choose(); assert.equal(f.get("local-transfer-notices").querySelector("img"), null);
  f.get("local-transfer-cancel").click(); assert.equal(f.document.activeElement, trigger);
  const catalog = require("../renderer/features-catalog");
  const item = catalog.items.find(row => row.id === "cross-mailbox-copy");
  assert(item); assert.match(item.blurb, /Phase 1 supports Copy only/); assert.match(item.blurb, /No remote Move.*CLI command/);
  const source = fs.readFileSync(require.resolve("./check-boot-path.js"), "utf8");
  assert(source.includes(JSON.stringify([item.id, item.title, item.category, item.blurb])), "exact boot catalog tuple stays synchronized");
  assert.match(f.get("cli-unavailable").textContent, /cross-mailbox Copy\/Move.*no bot or CLI command/);
});
