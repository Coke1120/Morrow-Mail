// Synthetic DOM regression of production renderer, compose, and Features code.
// No browser navigation, native windows, mail delivery, or network is permitted.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { renderer } = require("./check-ux-workflows");
const { sanitizeComposeSeed } = require("../host/compose-window");
const root = path.join(__dirname, "..");
const clone = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let n = 0; n < 4; n++) await new Promise(resolve => setTimeout(resolve, 0)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(t, role = "shell") {
  const window = new JSDOM(fs.readFileSync(path.join(root, "renderer/index.html"), "utf8"), { url: "https://fixture.invalid/?role=" + role }).window;
  t.after(() => window.close());
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const calls = [], opened = [];
  let answer = async () => ({ status: "cancelled" });
  window.morrow = {
    on() {},
    async invoke(channel, payload) {
      calls.push({ channel, payload: clone(payload) });
      if (channel === "mail:unsubscribe") return { success: true, data: await answer(payload) };
      throw new Error("Unexpected IPC: " + channel);
    },
    async openComposeWindow(seed) { opened.push(sanitizeComposeSeed(seed)); },
  };
  const ui = renderer({ window, document: window.document, localStorage: window.localStorage,
    Node: window.Node, Event: window.Event, DOMParser: window.DOMParser, requestAnimationFrame: () => 0 });
  ui.run(`state.accounts = [{id:'alpha',email:'owner@fixture.invalid',platform:'imap',bodyEpoch:0,folders:{primary:[],more:[]}},
    {id:'beta',email:'other@fixture.invalid',platform:'imap',bodyEpoch:0,folders:{primary:[],more:[]}}];
    state.accountId='alpha'; state.prefs.conversation=false; state.prefs.images=false; state.prefs.aiReply=false;`);
  const get = selector => window.document.querySelector(selector);
  const show = (extra = {}, onlyChanged = false) => {
    ui.context.fixtureEmail = { id: "one", accountId: "alpha", bodyEpoch: 0, from: "Sender <mail@fixture.invalid>",
      to: ["owner@fixture.invalid"], subject: "Synthetic newsletter", date: "2026-11-12T09:00:00Z", textBody: "Newsletter body.",
      unsubscribe: { kind: "web", destination: "list.fixture.invalid" }, ...extra };
    ui.run(`state.email=fixtureEmail; renderReader(false, ${onlyChanged})`);
  };
  return { window, ui, calls, opened, get, show, answer(fn) { answer = fn; },
    click() { get('[data-action="unsubscribe"]').click(); },
    status() { return get('.unsubscribe-status')?.textContent; } };
}

test("production preview and independent reader show an accessible banner above the body, without side effects", t => {
  for (const role of ["shell", "reader"]) {
    const f = fixture(t, role);
    f.show();
    const banner = f.get(".unsubscribe-banner"), button = f.get('[data-action="unsubscribe"]');
    assert.ok(banner);
    assert.equal(banner.getAttribute("aria-label"), "Mailing list unsubscribe");
    assert.match(banner.textContent, /This message offers an unsubscribe option/);
    assert.ok(banner.compareDocumentPosition(f.get("#reader .body")) & f.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(button.textContent, "Unsubscribe");
    assert.equal(button.getAttribute("aria-haspopup"), "dialog");
    assert.equal(f.get('.unsubscribe-status').getAttribute('aria-live'), 'polite');
    assert.equal(f.get('.unsubscribe-banner svg').getAttribute('aria-hidden'), 'true');
    assert.equal(f.get('.unsubscribe-banner a'), null, "no raw unsubscribe URL is exposed or navigated");
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.opened, []);
  }
});

test("no banner for missing/unsupported metadata, drafts, Outbox, or local messages", t => {
  const f = fixture(t);
  for (const extra of [{ unsubscribe: null }, { unsubscribe: {} }, { unsubscribe: { kind: "one-click", destination: "list.fixture.invalid" } },
    { unsubscribe: { kind: "web", destination: "" } }, { isDraft: true }, { outbox: true }, { accountId: "__morrow_local__" }]) {
    f.show(extra);
    assert.equal(f.get(".unsubscribe-banner"), null, JSON.stringify(extra));
  }
  assert.deepEqual(f.calls, []);
});

test("destination text is escaped and a metadata-only change repaints the reader", t => {
  const f = fixture(t);
  f.show({ unsubscribe: null });
  f.ui.run(`state.email.unsubscribe={kind:'web',destination:'<img src=x onerror=alert(1)>'};renderReader(false,true)`);
  assert.match(f.get('.unsubscribe-banner').textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(f.get('.unsubscribe-banner img'), null);
  f.ui.run('state.email.unsubscribe=null;renderReader(false,true)');
  assert.equal(f.get('.unsubscribe-banner'), null);
});

test("actual cached-body refresh adds and clears unsubscribe metadata without changing the current message", t => {
  const f = fixture(t); f.show({ unsubscribe: null });
  f.ui.run(`applyCachedBody({...state.email,bodyVersion:1,unsubscribeChecked:true,unsubscribe:{kind:'web',destination:'updated.fixture.invalid'}})`);
  assert.match(f.get('.unsubscribe-banner').textContent, /updated.fixture.invalid/);
  assert.equal(f.ui.run('state.email.unsubscribeChecked'), true);
  f.ui.run(`applyCachedBody({...state.email,bodyVersion:2,unsubscribeChecked:false,unsubscribe:null})`);
  assert.equal(f.get('.unsubscribe-banner'), null);
  assert.equal(f.ui.run('state.email.unsubscribeChecked'), false);
  assert.equal(f.ui.run('state.email.id'), 'one');
});

test("unchecked cached IMAP mail keeps its body and reloads only on an explicit click in its owning mailbox", async t => {
  for (const role of ['shell', 'reader']) {
    const f = fixture(t, role), result = deferred();
    f.show({ unsubscribe: null, unsubscribeChecked: false });
    assert.equal(f.get('[data-action="retry-body"]').textContent, 'Reload message');
    assert.match(f.get('#reader .body').textContent, /Newsletter body/);
    assert.deepEqual(f.calls, [], 'opening cached mail adds no provider request');
    f.ui.run(`state.accountId='beta';renderList=()=>{}`);
    f.window.morrow.invoke = async (channel, payload) => {
      f.calls.push({ channel, payload: clone(payload) });
      assert.equal(channel, 'mail:openEmail');
      return { success: true, data: await result.promise };
    };
    f.get('[data-action="retry-body"]').click();
    assert.deepEqual(f.calls, [{ channel: 'mail:openEmail', payload: { emailId: 'one', accountId: 'alpha', includeThread: false, full: true, retry: true } }]);
    assert.match(f.get('#reader .body').textContent, /Newsletter body/, 'existing cached body stays visible while explicit reload waits');
    result.resolve({ email: { ...clone(f.ui.run('state.email')), unsubscribeChecked: true } });
    await settle();
    assert.equal(f.get('[data-action="retry-body"]'), null, 'checked IMAP mail without options gains no permanent extra reload button');
    assert.equal(f.get('.unsubscribe-banner'), null);
    f.ui.run(`state.email.unsubscribeChecked=false;renderReader(false,true)`);
    assert.equal(f.get('[data-action="retry-body"]').textContent, 'Reload message', 'marker-only changes repaint the reader');
    for (const excluded of [{ isDraft: true }, { accountId: '__morrow_local__' }]) {
      f.show({ unsubscribe: null, unsubscribeChecked: false, ...excluded });
      assert.equal(f.get('[data-action="retry-body"]'), null);
    }
  }
});

test("cancel and repeated clicks keep review scoped and do not send mail", async t => {
  const f = fixture(t), result = deferred();
  f.answer(() => result.promise); f.show();
  f.click(); f.click();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { channel: 'mail:unsubscribe', payload: { accountId: 'alpha', emailId: 'one' } });
  assert.equal(f.get('[data-action="unsubscribe"]').disabled, true);
  assert.equal(f.get('[data-action="unsubscribe"]').getAttribute('aria-busy'), 'true');
  f.show(); f.click();
  assert.equal(f.calls.length, 1, 'rerender must not clear pending state');
  result.resolve({ status: 'cancelled' }); await settle();
  assert.match(f.status(), /Cancelled.*Nothing was requested/);
  assert.equal(f.get('[data-action="unsubscribe"]').disabled, false);
  f.click(); await settle();
  assert.equal(f.calls.length, 2, 'explicit retry after cancellation is available');
  assert.deepEqual(f.opened, []);
});

test("web result is a manual handoff, not confirmed unsubscribe, and cannot be repeated", async t => {
  const f = fixture(t); f.answer(async () => ({ status: 'opened' })); f.show();
  f.click(); await settle();
  assert.match(f.status(), /opened.*website.*not confirmed/);
  assert.equal(f.get('[data-action="unsubscribe"]').disabled, true);
  f.show(); f.click(); await settle();
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(f.status(), /successfully unsubscribed|subscription removed/i);
});

test("late web success and errors never update another mailbox with the same message id", async t => {
  for (const failure of [false, true]) {
    const f = fixture(t), result = deferred(); f.answer(() => result.promise); f.show(); f.click();
    f.show({ accountId: 'beta' });
    if (failure) result.reject(new Error('Synthetic acknowledgement lost')); else result.resolve({ status: 'opened' });
    await settle();
    assert.equal(f.status(), '');
    assert.equal(f.get('[data-action="unsubscribe"]').disabled, false);
    f.show();
    assert.match(f.status(), failure ? /acknowledgement lost.*not confirmed/ : /Unsubscribe page opened/);
    assert.equal(f.get('[data-action="unsubscribe"]').disabled, true);
  }
});

test("navigation to a loading or dismissed reader cannot revive the previous banner", async t => {
  const f = fixture(t), result = deferred(); f.answer(() => result.promise); f.show(); f.click();
  f.ui.run(`pendingOpenBody=true;pendingOpenId='two';renderReader(false)`);
  result.resolve({ status: 'opened' }); await settle();
  assert.equal(f.get('.unsubscribe-banner'), null);
  assert.match(f.get('#reader').textContent, /Loading message/);
  f.ui.run('pendingOpenBody=false;pendingOpenId=null;state.email=null;renderReader(false)');
  assert.equal(f.get('.unsubscribe-banner'), null);
});

test("busy/error/stale/unavailable states permit only explicit retry; uncertain states retire the action", async t => {
  for (const status of ['busy', 'error', 'stale', 'unavailable', 'uncertain']) {
    const f = fixture(t); f.answer(async () => ({ status, message: 'Synthetic ' + status })); f.show();
    f.click(); await settle();
    assert.equal(f.status(), 'Synthetic ' + status);
    assert.equal(f.get('[data-action="unsubscribe"]').disabled, status === 'uncertain');
    assert.equal(f.calls.length, 1);
  }
});

test("mailto uses reviewed compose defaults once, without saving or sending", async t => {
  const f = fixture(t);
  f.answer(async () => ({ status: 'draft', draft: { accountId: 'alpha', sourceMessageId: 'one', to: 'leave@fixture.invalid', subject: 'Unsubscribe', text: 'remove <literal> & me' } }));
  f.show({ unsubscribe: { kind: 'mailto', destination: 'leave@fixture.invalid' } });
  f.click(); f.click(); await settle();
  assert.equal(f.opened.length, 1);
  assert.deepEqual(f.opened[0], { title: 'Review unsubscribe email', kind: 'new', unsubscribeDraft: true, accountId: 'alpha', sourceMessageId: 'one',
    to: 'leave@fixture.invalid', cc: '', bcc: '', subject: 'Unsubscribe', body: 'remove <literal> & me',
    status: 'Review this unsubscribe email. Nothing is sent until you choose Send.' });
  assert.match(f.status(), /opened for review.*removal is not confirmed/);
  f.show({ unsubscribe: { kind: 'mailto', destination: 'leave@fixture.invalid' } }); f.click(); await settle();
  assert.equal(f.calls.length, 1); assert.equal(f.opened.length, 1);
});

test("late mailto response waits for the source message and preserves its own mailbox", async t => {
  const f = fixture(t), result = deferred(); f.answer(() => result.promise);
  const mailto = { unsubscribe: { kind: 'mailto', destination: 'leave@fixture.invalid' } };
  f.show(mailto); f.click(); f.show({ id: 'two', accountId: 'beta' });
  result.resolve({ status: 'draft', draft: { accountId: 'alpha', sourceMessageId: 'one', to: 'leave@fixture.invalid', subject: '', text: '' } });
  await settle(); assert.equal(f.opened.length, 0); assert.equal(f.status(), '');
  f.show(mailto); assert.match(f.status(), /ready to review.*Nothing has been sent/);
  f.click(); f.click(); await settle();
  assert.equal(f.opened.length, 1); assert.equal(f.opened[0].accountId, 'alpha'); assert.equal(f.opened[0].sourceMessageId, 'one'); assert.equal(f.calls.length, 1);
});

test("malformed or wrong-mailbox drafts and unknown outcomes never open compose or replay", async t => {
  for (const result of [{ status: 'draft', draft: { accountId: 'beta', sourceMessageId: 'one', to: 'leave@fixture.invalid' } },
    { status: 'draft', draft: { accountId: 'alpha', sourceMessageId: 'two', to: 'leave@fixture.invalid' } },
    { status: 'draft', draft: { accountId: 'alpha', to: 'leave@fixture.invalid' } }, { status: 'draft' }, { status: 'requested' }, null]) {
    const f = fixture(t); f.answer(async () => result); f.show(); f.click(); await settle();
    assert.equal(f.opened.length, 0); assert.equal(f.get('[data-action="unsubscribe"]').disabled, true);
    assert.match(f.status(), /not confirmed/);
  }
});

test("production compose suppresses automatic recipients and signatures for unsubscribe only", async t => {
  for (const unsubscribeDraft of [true, false]) {
    const f = fixture(t);
    f.window.morrow.invoke = async (channel, payload) => {
      f.calls.push({ channel, payload });
      const data = channel === 'mail:getComposeContext'
        ? { fromAddress: 'owner@fixture.invalid', sendAs: [{ email: 'owner@fixture.invalid' }], selfAddresses: ['owner@fixture.invalid'],
          defaultCc: ['copy@fixture.invalid'], defaultBcc: ['blind@fixture.invalid'], settings: { ccByDomain: {}, bccByDomain: {}, accounts: {} } }
        : channel === 'mail:listSignatures' ? { signatures: [{ id: 'signature', text: 'Automatic signature' }], defaultSignaturePerAccount: { alpha: 'signature' } }
          : (() => { throw new Error('Unexpected IPC: ' + channel); })();
      return { success: true, data };
    };
    f.ui.context.nativeSeed = sanitizeComposeSeed({ accountId: 'alpha', kind: 'new', unsubscribeDraft,
      to: 'leave@fixture.invalid', subject: 'Unsubscribe', body: 'remove <literal> & me' });
    await f.ui.run('openCompose(nativeSeed)');
    assert.equal(f.get('#compose-cc').value, unsubscribeDraft ? '' : 'copy@fixture.invalid');
    assert.equal(f.get('#compose-bcc').value, unsubscribeDraft ? '' : 'blind@fixture.invalid');
    assert.equal(f.get('#signature').value, unsubscribeDraft ? '' : 'signature');
    if (unsubscribeDraft) {
      assert.equal(f.get('#compose-body').value, 'remove <literal> & me');
      assert.equal(f.ui.run('state.composeIdentity.signatureFollowsFrom'), false);
      f.ui.run(`state.composeIdentity.defaultCc=['later@fixture.invalid'];state.composeIdentity.defaultBcc=['later-blind@fixture.invalid'];applyComposeRecipients()`);
      assert.equal(f.get('#compose-cc').value, ''); assert.equal(f.get('#compose-bcc').value, '');
    } else assert.match(f.get('#compose-body').value, /Automatic signature/);
    assert.equal(f.calls.some(row => /mail:(send|upsertDraft|scheduleSend)/.test(row.channel)), false);
  }
});

test("unsubscribe compose resolves the subscribed address through the actual host context and policy", async t => {
  const os = require('node:os'), net = require('node:net');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-unsubscribe-from-'));
  const env = { ...process.env }, oldConnect = net.Socket.prototype.connect, oldFetch = global.fetch;
  Object.assign(process.env, { MORROW_MAIL_DIR: directory, MORROW_USER_DATA: directory, MORROW_AI_CONFIG_DIR: directory, MORROW_MAIL_SECRETS: 'memory' });
  net.Socket.prototype.connect = () => { throw new Error('Live sockets forbidden'); };
  global.fetch = async () => { throw new Error('Live fetch forbidden'); };
  const engine = require('../host/mail/engine'), db = require('../host/mail/db');
  const settings = require('../host/settings'), mailFixture = require('./mail-performance-fixture');
  try {
    await engine.init();
    db.insertAccount({ ...mailFixture.account, id: 'alpha' }); db.replaceFolders('alpha', mailFixture.folders);
    settings.answer('emailBrain:saveComposeSettings', [{
      ccByDomain: { 'fixture.invalid': ['copy@fixture.invalid'], 'alias.invalid': ['copy@alias.invalid'] },
      bccByDomain: { 'fixture.invalid': ['audit@fixture.invalid'], 'alias.invalid': ['audit@alias.invalid'] },
      accounts: { alpha: { aliases: [{ address: 'business@company.invalid' }, { address: 'lists@alias.invalid' }], preferredFromAddress: 'business@company.invalid' } },
    }]);
    db.applyFolderSync('alpha', 'INBOX', mailFixture.report([
      mailFixture.message(1, { id: 'primary-list', to: ['owner@fixture.invalid'] }),
      mailFixture.message(2, { id: 'alias-list', to: ['undisclosed-recipients:;'],
        recipientHeaders: { originalTo: ['lists@alias.invalid'], deliveredTo: ['owner@fixture.invalid'], envelopeTo: [], replyTo: [] } }),
    ]));
    const ordinary = await engine.answer('mail:getComposeContext', [{ accountId: 'alpha', kind: 'new' }]);
    assert.equal(ordinary.success, true); assert.equal(ordinary.data.fromAddress, 'business@company.invalid', 'positive control: preferred new-mail alias differs from both subscribers');
    for (const [sourceMessageId, expectedFrom] of [['primary-list', 'owner@fixture.invalid'], ['alias-list', 'lists@alias.invalid']]) {
      const f = fixture(t);
      f.window.morrow.invoke = async (channel, payload) => {
        f.calls.push({ channel, payload: clone(payload) });
        if (channel === 'mail:unsubscribe') return { success: true, data: { status: 'draft', draft: {
          accountId: 'alpha', sourceMessageId, to: 'leave@fixture.invalid', subject: 'Leave', text: 'Remove this address' } } };
        if (channel === 'mail:getComposeContext') return engine.answer(channel, [payload]);
        if (channel === 'mail:listSignatures') return { success: true, data: { signatures: [{ id: 'signature', text: 'Automatic signature' }], defaultSignaturePerAccount: { alpha: 'signature' } } };
        throw new Error('Unexpected IPC: ' + channel);
      };
      f.window.morrow.openComposeWindow = async seed => {
        const sanitized = sanitizeComposeSeed(seed); f.opened.push(sanitized); f.ui.context.nativeSeed = sanitized;
        // Real compose initialization after the native-window seed boundary.
        await f.ui.run('openCompose(nativeSeed)');
      };
      f.show({ id: sourceMessageId, unsubscribe: { kind: 'mailto', destination: 'leave@fixture.invalid' } });
      await f.ui.run('requestUnsubscribe(state.email)');
      assert.equal(f.opened.length, 1);
      assert.equal(f.opened[0].sourceMessageId, sourceMessageId);
      const contextCall = f.calls.find(row => row.channel === 'mail:getComposeContext');
      assert.equal(contextCall.payload.sourceMessageId, sourceMessageId);
      assert.equal(f.ui.run('state.composeMeta.fromAddress'), expectedFrom);
      assert.equal(f.get('#compose-from').value, expectedFrom);
      assert.equal(f.get('#compose-cc').value, ''); assert.equal(f.get('#compose-bcc').value, '');
      assert.equal(f.get('#compose-body').value, 'Remove this address'); assert.equal(f.get('#signature').value, '');
      assert.equal(f.ui.run('state.composeIdentity.signatureFollowsFrom'), false);
      assert.equal(f.calls.some(row => /mail:(send|upsertDraft|scheduleSend)/.test(row.channel)), false);
    }
  } finally {
    await engine.stopIdle(); await db.close();
    net.Socket.prototype.connect = oldConnect; global.fetch = oldFetch;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rendered Features tab describes actual providers, confirmation, and one-click limitations", t => {
  const f = fixture(t);
  vm.runInContext(fs.readFileSync(path.join(root, 'renderer/features-catalog.js'), 'utf8'), f.ui.context);
  f.ui.run(`paintFeatureCatalog();showFeaturesTab('catalog')`);
  const cards = [...f.window.document.querySelectorAll('.feature-card')];
  const feature = cards.find(node => node.querySelector('h4')?.textContent === 'Mailing-list unsubscribe');
  assert.ok(feature);
  assert.equal(f.get('#features-catalog').closest('[role="tabpanel"]').hidden, false);
  for (const text of [/Gmail API, Outlook, Yahoo and other IMAP/, /List-Unsubscribe/, /separate reader/, /native confirmation/,
    /Older cached mail keeps its available body/, /Reload message or Retry download/, /no automatic metadata download/,
    /does not confirm removal/, /Nothing sends until you choose Send/, /without automatic Cc\/Bcc or a signature/,
    /RFC 8058 one-click POST is unavailable/, /independently verified DKIM/, /No bulk unsubscribe, automatic unsubscribe/]) assert.match(feature.textContent, text);
  assert.deepEqual(f.calls, []);
});
