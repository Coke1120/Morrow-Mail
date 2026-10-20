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
}
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
  console.log('mail reader synthetic checks passed');
}
module.exports = { run: main };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
