// Offline synthetic fixtures: DOM reconstruction, read feedback and cache races.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseDocument } = require('htmlparser2');
const app = fs.readFileSync(require.resolve('../renderer/app.js'), 'utf8');
const engine = fs.readFileSync(require.resolve('../host/mail/engine.js'), 'utf8');
function between(source, start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
// Small DOM adapter uses a real HTML parser; native Chromium testing is separate.
class Node {
  constructor(tag, text = '', attrs = {}) {
    this.nodeType = tag ? 1 : 3;
    this.localName = tag;
    this.text = text;
    this.attrs = attrs || {};
    this.childNodes = [];
    this.styles = {};
  }
  appendChild(child) { child.parent = this; this.childNodes.push(child); return child; }
  get textContent() { return this.nodeType === 3 ? this.text : this.childNodes.map(n => n.textContent).join(''); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  get style() { return this._style || (this._style = { setProperty: (prop, value, priority) => { this.styles[prop] = { value, priority: priority || '' }; } }); }
  querySelectorAll(selector) {
    const all = [];
    const visit = (node) => { for (const child of node.childNodes || []) { if (child.nodeType === 1) all.push(child); visit(child); } };
    visit(this);
    const matchToken = (node, token) => {
      if (!node || node.nodeType !== 1) return false;
      if (token === '*') return true;
      let rest = token;
      const tag = rest.match(/^[a-z][\w-]*/i);
      if (tag) {
        if (String(node.localName).toLowerCase() !== tag[0].toLowerCase()) return false;
        rest = rest.slice(tag[0].length);
      }
      let id = '';
      const classes = [];
      while (rest) {
        const m = rest.match(/^([.#])([\w-]+)/);
        if (!m) return false;
        if (m[1] === '#') id = m[2]; else classes.push(m[2]);
        rest = rest.slice(m[0].length);
      }
      if (!tag && !id && !classes.length) return false;
      const have = new Set(String(node.attrs.class || '').split(/\s+/));
      if (id && node.attrs.id !== id) return false;
      return classes.every(name => have.has(name));
    };
    const matches = (node, group) => {
      const tokens = group.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean);
      if (!tokens.length || !matchToken(node, tokens[tokens.length - 1])) return false;
      let current = node;
      for (let i = tokens.length - 2; i >= 0; i--) {
        let parent = current.parent;
        let found = false;
        while (parent) {
          if (matchToken(parent, tokens[i])) { current = parent; found = true; break; }
          parent = parent.parent;
        }
        if (!found) return false;
      }
      return true;
    };
    return all.filter(node => selector.split(',').some(group => matches(node, group)));
  }
}
function convert(node) { const out = new Node(node.name, node.data || '', node.attribs); for (const child of node.children || []) out.appendChild(convert(child)); return out; }
const document = {
  createTextNode: text => new Node(null, text),
  createElement(tag) {
    const node = new Node(tag);
    if (tag === 'template') Object.defineProperty(node, 'innerHTML', { set(html) { node.content = convert(parseDocument(html)); } });
    return node;
  },
};
const ctx = vm.createContext({ document });
vm.runInContext(between(app, 'function readable(email)', '// shortcut: one string'), ctx);
const hostile = '<style>evil-css</style><script>evil-script</script><table style="background:url(https://bad.test)"><tr><td onclick="evil()">Hello &amp; welcome</td></tr></table><svg><script>bad</script></svg><iframe src="https://bad.test"></iframe><a href="javascript:evil()">Link</a><img src="https://example.test/pixel" onerror="evil()" alt="Picture"><img src="file:///secret"><img src="data:image/svg+xml,bad">';
const walk = node => [node, ...node.childNodes.flatMap(walk)];
for (const allowed of [false, true]) {
  const root = new Node('div');
  ctx.appendSafeMailHtml(root, hostile, allowed);
  const nodes = walk(root);
  assert(nodes.some(n => n.localName === 'table'));
  assert(root.textContent.includes('Hello & welcome'));
  assert(!root.textContent.includes('evil'));
  assert(!nodes.some(n => ['script', 'style', 'svg', 'iframe', 'a'].includes(n.localName)));
  assert(nodes.every(n => Object.keys(n.attrs || {}).length === 0));
  assert.deepEqual(nodes.filter(n => n.localName === 'img').map(n => n.src), allowed ? ['https://example.test/pixel'] : []);
  assert(!nodes.some(n => Object.keys(n.attrs || {}).some(name => name.startsWith('on') || /javascript:|file:|svg\+xml/i.test(String(n.attrs[name] || '')))));
  assert(!nodes.some(n => Object.values(n.styles || {}).some(style => /javascript:|expression\s*\(/i.test(style.value || ''))));
  if (!allowed) assert(!nodes.some(n => n.styles && n.styles.background));
}
const newsletter = '<html><head><style>.logo{color:#e10600}.nav a{color:#ffffff;text-decoration:none} td{background-image:url(javascript:alert(1))} .x{color:expression(alert(1))}</style></head><body>' +
  '<table width="640" align="center" cellpadding="0" cellspacing="0"><tr><td width="320" class="logo"><font color="#e10600">新地會</font></td><td align="right">分享</td></tr>' +
  '<tr><td colspan="2" bgcolor="#e10600" class="nav" style="color:#ffffff;text-align:center;padding:8px"><a href="https://example.com/offers" onclick="evil()">最新優惠</a></td></tr>' +
  '<tr><td colspan="2"><img src="https://cdn.example/hero.png" width="640" height="220" alt="hero"><a href="javascript:alert(1)">nope</a>' +
  '<img src="data:image/png;base64,aaaa" alt="pixel"><img src="data:image/svg+xml,bad" alt="svg"><img src="file:///secret" alt="secret"></td></tr></table></body></html>';
for (const allowed of [false, true]) {
  const root = new Node('div');
  ctx.appendSafeMailHtml(root, newsletter, allowed);
  const nodes = walk(root);
  const table = nodes.find(n => n.localName === 'table');
  assert.equal(table.attrs.width, '640');
  assert.equal(table.attrs.align, 'center');
  assert.equal(table.attrs.cellpadding, '0');
  const bar = nodes.find(n => n.attrs && n.attrs.colspan === '2' && n.attrs.bgcolor === '#e10600');
  assert(bar, 'colspan and bgcolor survive');
  assert.equal(bar.styles.color.value, '#ffffff');
  assert.equal(bar.styles['text-align'].value, 'center');
  const logo = nodes.find(n => n.attrs && n.attrs.class === 'mmail-logo');
  assert.equal(logo.styles.color.value, '#e10600');
  const link = nodes.find(n => n.localName === 'a');
  assert.equal(link.attrs.href, 'https://example.com/offers');
  assert.equal(link.attrs.target, '_blank');
  assert.equal(link.attrs.rel, 'noopener noreferrer');
  assert(!nodes.some(n => /javascript:|onclick|expression/i.test(JSON.stringify(n.attrs || {}) + JSON.stringify(n.styles || {}))));
  assert(root.textContent.includes('新地會') && root.textContent.includes('最新優惠') && root.textContent.includes('nope'));
  assert(root.textContent.includes('svg') && root.textContent.includes('secret'));
  const srcs = nodes.filter(n => n.localName === 'img').map(n => n.src);
  assert(srcs.includes('data:image/png;base64,aaaa'));
  assert(!srcs.some(src => /svg|file:|javascript:/i.test(src)));
  if (allowed) {
    assert(srcs.includes('https://cdn.example/hero.png'));
    const hero = nodes.find(n => n.src === 'https://cdn.example/hero.png');
    assert.equal(hero.attrs.width, '640');
    assert.equal(hero.attrs.height, '220');
  } else {
    assert(!srcs.includes('https://cdn.example/hero.png'));
    const hold = nodes.find(n => n.attrs && n.attrs.class === 'mail-image-hold');
    assert.equal(hold.styles.width.value, '640px');
    assert.equal(hold.styles.height.value, '220px');
  }
  const font = nodes.find(n => n.localName === 'font');
  assert.equal(font.attrs.color, '#e10600');
  assert.equal(bar.attrs.style, undefined);
  assert.equal(bar.attrs['data-mail-style'], undefined);
}
const parked = ctx.parkMailStyleAttributes('<td STYLE = "color:#ffffff;text-align:center;padding:8px" class="nav">');
assert.equal(/(?:^|[\s/>])style\s*=/i.test(parked), false);
assert.equal(parked.includes('data-mail-style = "color:#ffffff;text-align:center;padding:8px"'), true);
assert.equal(parked.includes('class="nav"'), true);
const quoted = ctx.parkMailStyleAttributes("<span style='background-color:#fff3a0'>Ada</span>");
assert.equal(quoted.includes("data-mail-style='background-color:#fff3a0'"), true);
assert.equal(/\sstyle\s*=/i.test(quoted), false);
const unquoted = ctx.parkMailStyleAttributes('<span style=color:red class=x>');
assert.equal(unquoted.includes('data-mail-style=color:red'), true);
assert.equal(unquoted.includes('class=x'), true);
const kept = ctx.parkMailStyleAttributes('<style>.logo{color:#e10600}</style><!-- <i style="x"> --><script>var style="color:red"</script><b style="color:blue">');
assert.equal(kept.includes('<style>.logo{color:#e10600}</style>'), true);
assert.equal(kept.includes('<!-- <i style="x"> -->'), true);
assert.equal(kept.includes('var style="color:red"'), true);
assert.equal(kept.includes('data-mail-style="color:blue"'), true);
function parkedStyleAttrs(html) {
  const found = [];
  const walkNode = (node) => {
    if (node.attribs && Object.prototype.hasOwnProperty.call(node.attribs, 'style')) found.push(node.attribs.style);
    for (const child of node.children || []) walkNode(child);
  };
  walkNode(parseDocument(ctx.parkMailStyleAttributes(html)));
  return found;
}
assert.deepEqual(parkedStyleAttrs(newsletter), []);
assert.deepEqual(parkedStyleAttrs('<p><span style="background-color:#fff3a0">Ada</span></p>'), []);
assert.equal(ctx.readable({ textBody: 'MIME plain text', htmlBody: hostile }), 'MIME plain text');
assert(!ctx.readable({ htmlBody: hostile }).includes('evil-css'));
assert(!ctx.readable({ htmlBody: newsletter }).includes('#e10600'));
const css = fs.readFileSync(require.resolve('../renderer/app.css'), 'utf8');
assert(css.includes('.body.is-html') && css.includes('white-space: normal'));
assert(css.includes('.body.is-plain { white-space: pre-wrap; }'));
assert(!css.includes('max-width: min(100%, 330px)'));
const hostMain = fs.readFileSync(require.resolve('../host/main.js'), 'utf8');
assert(hostMain.includes('setWindowOpenHandler') && hostMain.includes('shell.openExternal'));
async function main() {
  const pending = [], calls = [];
  const email = { id: 'a:1', unread: true, isRead: false };
  const listed = { ...email };
  const state = { email, emails: [listed], thread: [] };
  const readCtx = vm.createContext({ state, renderList() {}, call(channel, params) { calls.push(params); return new Promise((resolve, reject) => pending.push({ resolve, reject })); } });
  vm.runInContext(between(app, 'function eachStarRow', 'function paintStars') + between(app, 'const readWrites =', 'async function deleteFromList'), readCtx);
  const first = readCtx.setRead(email, true);
  assert.equal(listed.unread, false, 'paint before network reply');
  pending.shift().reject(new Error('offline'));
  await assert.rejects(first, /offline/);
  assert.equal(listed.unread, true, 'rollback all row copies');
  const next = readCtx.setRead(email, true);
  const replacement = { ...email, unread: true, isRead: false };
  state.emails = [replacement];
  const queued = readCtx.setRead(email, false);
  assert.equal(calls.length, 2, 'second write waits');
  pending.shift().resolve(); await next; await Promise.resolve();
  assert.equal(calls.length, 3);
  assert.equal(state.emails[0].unread, true);
  pending.shift().resolve(); await queued;
  assert.equal(email.isRead, false);
  const final = readCtx.setRead(email, true);
  state.emails = [{ ...email, unread: true, isRead: false }];
  pending.shift().resolve(); await final;
  assert.equal(state.emails[0].unread, false, 'success reconciles a list reload during network wait');
  // A completed queued fetch must reuse fresh body, without another network call.
  const row = { id: 'a:1', account_id: 'a', uid: 1, body_complete: 0 };
  let fetched = 0;
  const bodyCtx = vm.createContext({ db: { accountById: () => ({ id: 'a' }), messageById: () => ({ ...row, body_complete: 1, recipient_headers_json: '{}', html_body: '<p>Complete</p>' }) }, exclusive: async (_id, fn) => fn(), secretFor: () => { fetched++; throw Error('should not fetch'); } });
  vm.runInContext(between(engine, 'async function ensureBody', 'function pushRows'), bodyCtx);
  assert.equal((await bodyCtx.ensureBody(row)).html_body, '<p>Complete</p>');
  assert.equal(fetched, 0);
  await assertDownloadedBodyStaysOnTheRequestedUid();
  await assertReaderKeepsTheSelectedMessage();
  await assertThreadStripCollapsesOlderMessages();
  console.log('mail reader synthetic checks passed');
}

function fakeImap(messages) {
  return {
    mailbox: { uidValidity: 4 },
    async getMailboxLock() { return { release() {} }; },
    async *fetch() {
      for (const msg of messages) yield msg;
    },
  };
}

function source(subject, body) {
  return Buffer.from(`Subject: ${subject}\r\n\r\n${body}\r\n`);
}

async function assertDownloadedBodyStaysOnTheRequestedUid() {
  const remote = require('../host/mail/remote');
  const other = { uid: 2, envelope: { subject: 'Other' }, source: source('Other', 'Other body'), flags: new Set() };
  const chosen = { uid: 9, envelope: { subject: 'Chosen' }, source: source('Chosen', 'Chosen body'), flags: new Set(['\\Seen']) };
  const fetched = await remote.fetchSource(fakeImap([other, chosen]), 'INBOX', 9);
  assert.equal(fetched && fetched.uid, 9);
  assert.match(fetched.textBody || '', /Chosen body/);
  assert.doesNotMatch(fetched.textBody || '', /Other body/);
  assert.equal(await remote.fetchSource(fakeImap([other]), 'INBOX', 9), null);
  const flagsOnly = { uid: 9, envelope: { subject: 'Chosen' }, flags: new Set() };
  const withBody = { uid: 9, envelope: { subject: 'Chosen' }, source: source('Chosen', 'Chosen body'), flags: new Set(['\\Seen']) };
  const merged = await remote.fetchSource(fakeImap([flagsOnly, withBody]), 'INBOX', 9);
  assert.match(merged.textBody || '', /Chosen body/);

  const stored = new Map();
  stored.set('a', {
    id: 'a', account_id: 'acct', uid: 10, uid_validity: 1, folder_path: 'INBOX',
    body_complete: 0, subject: 'Alpha', html_body: null, text_body: null, recipient_headers_json: null,
  });
  const mismatch = vm.createContext({
    db: {
      accountById: () => ({ id: 'acct' }),
      messageById: (id) => stored.get(id) || null,
      updateMessage(id, patch) { Object.assign(stored.get(id), patch); },
    },
    exclusive: async (_id, fn) => fn(),
    secretFor: async () => 'secret',
    remote: {
      withClient: async (_account, _password, fn) => fn({}),
      fetchSource: async () => ({
        uid: 11, subject: 'Beta', htmlBody: '<p>Beta</p>', textBody: 'Beta body',
        bodyComplete: true, snippet: 'Beta', attachments: [], hasAttachments: false, recipientHeaders: {},
      }),
    },
  });
  vm.runInContext(between(engine, 'async function ensureBody', 'function pushRows'), mismatch);
  const opened = await mismatch.ensureBody(stored.get('a'));
  assert.equal(opened.subject, 'Alpha');
  assert.equal(opened.html_body, null);
  assert.equal(stored.get('a').text_body, null);
}

function domNode(tag) {
  const node = {
    tag, children: [], className: '', hidden: false, disabled: false, textContent: '', value: '',
    dataset: {}, attrs: {}, style: {}, parentNode: null,
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name]; },
    removeAttribute(name) { delete this.attrs[name]; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); },
    append(...nodes) { for (const child of nodes) this.appendChild(child); },
    appendChild(child) {
      if (child && child.parentNode && child.parentNode !== this) {
        child.parentNode.children = child.parentNode.children.filter((item) => item !== child);
      }
      if (child) child.parentNode = this;
      this.children.push(child);
      return child;
    },
    replaceChildren() { this.children = []; },
    addEventListener(type, fn) {
      if (!this.listeners) this.listeners = {};
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(fn);
    },
    removeEventListener() {},
    click() {
      for (const fn of (this.listeners && this.listeners.click) || []) fn();
    },
    replaceWith(next) {
      const parent = this.parentNode;
      if (!parent || !parent.children) return;
      if (next && next.parentNode && next.parentNode.children) {
        next.parentNode.children = next.parentNode.children.filter((item) => item !== next);
      }
      if (next) next.parentNode = parent;
      const index = parent.children.indexOf(this);
      if (index < 0) parent.children.push(next);
      else parent.children.splice(index, 1, next);
      this.parentNode = null;
    },
    focus() { this.focused = true; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; },
    querySelector(selector) { return queryNode(this, selector); },
  };
  node.classList = {
    add(...names) { node.className = `${node.className} ${names.join(' ')}`.trim(); },
    remove() {},
    toggle(name, force) {
      const has = node.className.split(/\s+/).includes(name);
      const on = force === undefined ? !has : !!force;
      if (on && !has) node.className = `${node.className} ${name}`.trim();
      if (!on && has) node.className = node.className.split(/\s+/).filter((part) => part !== name).join(' ');
      return on;
    },
    contains(name) { return node.className.split(/\s+/).includes(name); },
  };
  return node;
}

function nodeMatches(node, selector) {
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  const attr = selector.match(/^\[([A-Za-z0-9-]+)=['"]([^'"]+)['"]\]$/);
  if (!attr) return false;
  const [, name, value] = attr;
  if (name.startsWith('data-')) {
    const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (node.dataset[key] === value) return true;
  }
  return node.attrs[name] === value;
}

function queryNode(node, selector) {
  for (const child of node.children || []) {
    if (child && nodeMatches(child, selector)) return child;
    const found = queryNode(child, selector);
    if (found) return found;
  }
  return null;
}

function readerText(node) {
  const parts = [];
  const walk = (current) => {
    if (!current || current.hidden) return;
    if (current.textContent) parts.push(current.textContent);
    for (const child of current.children || []) walk(child);
  };
  walk(node);
  return parts.join('\n');
}

function loadReader() {
  const reader = domNode('section');
  const status = domNode('p');
  const document = {
    getElementById(id) {
      if (id === 'reader') return reader;
      if (id === 'status') return status;
      return domNode('div');
    },
    createElement: domNode,
    createElementNS: (_ns, tag) => domNode(tag),
  };
  const context = vm.createContext({
    window: { morrow: { on() {}, invoke: async () => ({}) }, addEventListener() {} },
    document,
    console,
    setTimeout,
    clearTimeout,
    navigator: { onLine: true },
  });
  const source = app.replace(
    'boot().catch((error) => showStatus(error instanceof Error ? error.message : String(error), true));',
    `globalThis.__readerApi = {
      get state() { return state; },
      openMessage,
      renderReader,
      set call(fn) { call = fn; },
      set renderList(fn) { renderList = fn; },
    };`
  );
  vm.runInContext(source, context);
  const api = context.__readerApi;
  api.reader = reader;
  api.renderList = () => {};
  api.state.accounts = [{ id: 'acct', email: 'ada@example.test' }];
  api.state.accountId = 'acct';
  api.state.prefs.conversation = true;
  return api;
}

function listed(id, subject, bodyComplete) {
  return {
    id, subject, from: subject + ' sender', date: '2026-10-20T12:00:00.000Z',
    accountId: 'acct', unread: false, bodyComplete, snippet: subject + ' snippet',
  };
}

function opened(id, subject, text) {
  return { ...listed(id, subject, true), textBody: text, htmlBody: null, threadId: id };
}

async function flushReader() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function assertReaderKeepsTheSelectedMessage() {
  const ui = loadReader();
  const alpha = listed('A', 'Alpha', false);
  const beta = listed('B', 'Beta', false);
  ui.state.emails = [alpha, beta];
  ui.state.thread = [];
  ui.state.email = opened('prev', 'Previous', 'previous body');

  let releaseA;
  let releaseB;
  ui.call = (channel, payload) => {
    if (channel !== 'mail:openEmail') return Promise.resolve({});
    return new Promise((resolve) => {
      const finish = () => resolve({
        email: opened(payload.emailId, payload.emailId === 'A' ? 'Alpha' : 'Beta', payload.emailId === 'A' ? 'alpha body' : 'beta body'),
        threadMessages: [{ id: payload.emailId }],
      });
      if (payload.emailId === 'A') releaseA = finish;
      else releaseB = finish;
    });
  };
  const openA = ui.openMessage('A', false);
  await flushReader();
  ui.renderReader(false);
  let shown = readerText(ui.reader);
  assert.match(shown, /Loading message/);
  assert.match(shown, /Alpha/);
  assert.doesNotMatch(shown, /previous body/);
  assert.doesNotMatch(shown, /beta body/);
  const openB = ui.openMessage('B', false);
  await flushReader();
  releaseA();
  await flushReader();
  shown = readerText(ui.reader);
  assert.doesNotMatch(shown, /alpha body/);
  assert.match(shown, /Beta/);
  releaseB();
  await Promise.all([openA.catch((error) => error), openB]);
  shown = readerText(ui.reader);
  assert.match(shown, /beta body/);
  assert.doesNotMatch(shown, /alpha body/);
  assert.doesNotMatch(shown, /previous body/);

  const failed = loadReader();
  failed.state.emails = [alpha, beta];
  failed.state.thread = [];
  failed.state.email = opened('prev', 'Previous', 'previous body');
  failed.call = async () => { throw new Error('download failed'); };
  await assert.rejects(failed.openMessage('A', false), /download failed/);
  shown = readerText(failed.reader);
  assert.match(shown, /Alpha/);
  assert.match(shown, /download failed/);
  assert.doesNotMatch(shown, /previous body/);

  const mismatched = loadReader();
  mismatched.state.emails = [alpha];
  mismatched.state.thread = [];
  mismatched.state.email = opened('prev', 'Previous', 'previous body');
  mismatched.call = async () => ({
    email: opened('B', 'Beta', 'beta body'),
    threadMessages: [{ id: 'B' }],
  });
  await assert.rejects(mismatched.openMessage('A', false), /could not be loaded/);
  shown = readerText(mismatched.reader);
  assert.match(shown, /Alpha/);
  assert.doesNotMatch(shown, /beta body/);
  assert.doesNotMatch(shown, /previous body/);
}

function threadNodes(root, className) {
  const found = [];
  const walk = (node) => {
    if (!node) return;
    if (node.className && node.className.split(/\s+/).includes(className)) found.push(node);
    for (const child of node.children || []) walk(child);
  };
  walk(root);
  return found;
}

function threadMember(id, snippet) {
  return {
    id,
    threadId: 'thread-same',
    subject: 'RE: Same subject',
    snippet,
    from: 'Sender ' + id,
    date: '2026-10-' + String(10 + Number(String(id).slice(1))).padStart(2, '0') + 'T12:00:00.000Z',
    accountId: 'acct',
    unread: false,
    textBody: 'body ' + id,
    htmlBody: null,
  };
}

async function assertThreadStripCollapsesOlderMessages() {
  const ui = loadReader();
  const calls = [];
  const rows = [];
  for (let i = 0; i < 8; i += 1) rows.push(threadMember('m' + i, 'Snippet ' + i));
  const current = { ...rows[7], textBody: 'latest body', hasAttachments: true };
  ui.call = (channel, payload) => {
    calls.push({ channel, payload });
    if (channel !== 'mail:openEmail') return Promise.resolve({});
    const row = rows.find((item) => item.id === payload.emailId) || current;
    return Promise.resolve({
      email: { ...row, textBody: 'body ' + payload.emailId, htmlBody: null, hasAttachments: true },
      threadMessages: rows,
    });
  };
  ui.state.emails = rows;
  ui.state.thread = rows;
  ui.state.email = current;
  ui.renderReader(false);
  let shown = readerText(ui.reader);
  assert.match(shown, /Earlier in this conversation \(6\)/);
  assert.match(shown, /Snippet 6/);
  assert.match(shown, /Snippet 7/);
  assert.match(shown, /latest body/);
  assert.match(shown, /This message has attachments/);
  assert.doesNotMatch(shown, /Snippet 0/);
  assert.doesNotMatch(shown, /Snippet 5/);
  assert.equal(shown.split('RE: Same subject').length - 1, 1);
  const toggle = threadNodes(ui.reader, 'thread-earlier')[0];
  assert.equal(toggle.tag, 'button');
  assert.equal(toggle.type, 'button');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-controls'), 'thread-messages');
  assert.match(threadNodes(ui.reader, 'thread')[0].getAttribute('aria-label'), /8 messages in this conversation, 6 earlier messages collapsed/);
  assert.equal(threadNodes(ui.reader, 'thread-item').length, 2);
  assert.equal(calls.length, 0);
  const earlierIndex = shown.indexOf('Earlier in this conversation');
  const attachmentIndex = shown.indexOf('This message has attachments');
  const bodyIndex = shown.indexOf('latest body');
  assert.ok(earlierIndex >= 0 && earlierIndex < attachmentIndex && attachmentIndex < bodyIndex);

  toggle.click();
  shown = readerText(ui.reader);
  assert.match(shown, /Earlier in this conversation \(6\)/);
  assert.match(shown, /Showing 6 earlier messages/);
  assert.match(shown, /Snippet 0/);
  assert.match(shown, /Snippet 5/);
  assert.equal(shown.split('RE: Same subject').length - 1, 1);
  assert.equal(threadNodes(ui.reader, 'thread-earlier')[0].getAttribute('aria-expanded'), 'true');
  assert.equal(threadNodes(ui.reader, 'thread-earlier')[0].focused, true);
  assert.equal(threadNodes(ui.reader, 'thread-item').length, 8);
  for (const row of threadNodes(ui.reader, 'thread-item')) {
    const rowText = readerText(row);
    assert.equal(rowText.includes('RE: Same subject'), false);
    assert.match(rowText, /Sender m/);
    const when = threadNodes(row, 'when')[0];
    assert.ok(when && when.textContent);
    assert.equal(when.textContent.includes('RE:'), false);
  }
  const older = threadNodes(ui.reader, 'thread-item').find((row) => readerText(row).includes('Snippet 1'));
  older.click();
  await flushReader();
  assert.equal(calls[0].channel, 'mail:openEmail');
  assert.equal(calls[0].payload.emailId, 'm1');
  shown = readerText(ui.reader);
  assert.match(shown, /body m1/);
  assert.match(shown, /Snippet 0/);
  const currentRow = threadNodes(ui.reader, 'thread-item').find((row) => row.getAttribute('aria-current') === 'true');
  assert.match(readerText(currentRow), /Snippet 1/);

  const collapsed = threadNodes(ui.reader, 'thread-earlier')[0];
  collapsed.click();
  shown = readerText(ui.reader);
  assert.match(shown, /Earlier in this conversation \(5\)/);
  assert.match(shown, /5 earlier messages collapsed/);
  assert.equal(threadNodes(ui.reader, 'thread-earlier')[0].getAttribute('aria-expanded'), 'false');
  assert.doesNotMatch(shown, /Snippet 0/);
  assert.match(shown, /Snippet 1/);
  assert.match(shown, /Snippet 6/);
  assert.match(shown, /body m1/);

  const pinned = loadReader();
  pinned.call = async () => ({});
  const oldest = { ...rows[0], textBody: 'oldest body' };
  pinned.state.thread = rows;
  pinned.state.email = oldest;
  pinned.renderReader(false);
  shown = readerText(pinned.reader);
  assert.match(shown, /Earlier in this conversation \(5\)/);
  assert.match(shown, /Snippet 0/);
  assert.match(shown, /Snippet 6/);
  assert.match(shown, /Snippet 7/);
  assert.doesNotMatch(shown, /Snippet 1/);
  assert.equal(threadNodes(pinned.reader, 'thread-item').length, 3);

  const pair = loadReader();
  pair.call = async () => ({});
  const two = [threadMember('m0', 'Snippet 0'), threadMember('m1', 'Snippet 1')];
  pair.state.thread = two;
  pair.state.email = { ...two[1], textBody: 'pair body' };
  pair.renderReader(false);
  shown = readerText(pair.reader);
  assert.equal(threadNodes(pair.reader, 'thread-earlier').length, 0);
  assert.equal(threadNodes(pair.reader, 'thread-item').length, 2);
  assert.match(shown, /Snippet 0/);
  assert.match(shown, /Snippet 1/);
  assert.equal(shown.split('RE: Same subject').length - 1, 1);

  ui.state.prefs.conversation = false;
  ui.state.email = current;
  ui.state.thread = rows;
  ui.renderReader(false);
  shown = readerText(ui.reader);
  assert.equal(threadNodes(ui.reader, 'thread-item').length, 0);
  assert.doesNotMatch(shown, /Earlier in this conversation/);
  assert.match(shown, /latest body/);
}
module.exports = { run: main };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
