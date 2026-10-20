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
  constructor(tag, text = '', attrs = {}) { this.nodeType = tag ? 1 : 3; this.localName = tag; this.text = text; this.attrs = attrs; this.childNodes = []; }
  appendChild(child) { this.childNodes.push(child); return child; }
  get textContent() { return this.nodeType === 3 ? this.text : this.childNodes.map(n => n.textContent).join(''); }
  getAttribute(name) { return this.attrs[name] || null; }
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
}
assert.equal(ctx.readable({ textBody: 'MIME plain text', htmlBody: hostile }), 'MIME plain text');
assert(!ctx.readable({ htmlBody: hostile }).includes('evil-css'));
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
