// Synthetic presentation checks: no credentials, provider calls or network setup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function run() {
  const source = fs.readFileSync(require.resolve('../renderer/app.js'), 'utf8');
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { dataset: {}, value: '', textContent: '', open: false });
    return nodes.get(id);
  };
  const state = {};
  const ctx = vm.createContext({ $, state, botListenerStatus: () => 'fixture listener',
    paintBotAccounts() {}, paintBotGrants() {}, paintBotDrafts() {} });
  vm.runInContext(source.slice(source.indexOf('function paintBotAccess('), source.indexOf('async function openBotDraft(')), ctx);
  ctx.paintBotAccess({ enabled: false, grants: [], accounts: [] });
  assert.equal($('bot-add-client').open, true);
  assert.equal($('bot-enabled').disabled, true);
  assert.match($('bot-remote-status').textContent, /Not checked/);
  assert.equal($('bot-probe-conflict').hidden, true);
  $('bot-add-client').open = false;
  ctx.paintBotAccess({ enabled: true, grants: [{ live: true }], serveHost: 'mac.tailnet.ts.net:8443', installationId: 'fixture-install',
    endpoints: { local: 'http://127.0.0.1:47831/api/bot/v1/call', serve: 'https://mac.tailnet.ts.net:8443/api/bot/v1/call' } });
  assert.equal($('bot-add-client').open, false, 'refresh preserves user disclosure choice');
  assert.equal($('bot-enabled').checked, true);
  assert.match($('bot-remote-status').textContent, /Not checked/);
  assert.match($('bot-remote-status').textContent, /does not set up/);
  assert.doesNotMatch($('bot-remote-status').textContent, /configured|connected/i);
  assert.equal($('bot-probe-conflict').hidden, true);
  assert.equal($('bot-endpoint').textContent, 'HTTPS address https://mac.tailnet.ts.net:8443/api/bot/v1/call');
  assert.match($('bot-cmd-serve').textContent, /tailscale serve --bg --https=8443 --accept-app-caps=com\.coke1120\.morrow-mail\/bot-access http:\/\/127\.0\.0\.1:47831/);
  assert.equal($('bot-serve-host').value, 'mac.tailnet.ts.net:8443');
  assert.equal(state.botAccess.installationId, 'fixture-install');
  nodes.clear();
  ctx.paintBotAccess({ grants: [{ live: true }], enabled: false });
  assert.equal($('bot-add-client').open, false, 'existing clients start with setup collapsed');
  assert.equal($('bot-enabled').disabled, false, 'existing local grant can still enable listener');
  const html = fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8');
  const { parseDocument, DomUtils } = require('htmlparser2');
  const doc = parseDocument(html);
  for (const id of ['bot-grants','bot-enabled','bot-serve-host','bot-mint','bot-caps','bot-expiry','bot-install']) {
    assert.equal(DomUtils.findAll(n => n.attribs?.id === id, doc.children).length, 1, id + ' preserved exactly once');
  }
  const advanced = DomUtils.findOne(n => n.attribs?.id === 'bot-advanced', doc.children);
  assert.equal(DomUtils.findAll(n => ['bot-grants','bot-serve-host'].includes(n.attribs?.id), advanced.children).length, 0);
  assert.match(DomUtils.textContent(advanced), /Same-computer bots/);
  const botSection = DomUtils.findOne(n => n.attribs?.id === 'settings-bot', doc.children);
  const steps = DomUtils.findAll(n => n.attribs?.['data-bot-section'], botSection.children)
    .map(n => n.attribs['data-bot-section']);
  assert.deepEqual(steps, ['grants','local','tailscale','agent','activity'], 'steps follow dependency then activity');
  const activity = DomUtils.findOne(n => n.attribs?.id === 'bot-panel-activity', doc.children);
  const create = DomUtils.findOne(n => n.attribs?.id === 'bot-panel-grants', doc.children);
  for (const id of ['bot-drafts','bot-sends','bot-audit']) {
    assert.equal(DomUtils.findAll(n => n.attribs?.id === id, activity.children).length, 1, id + ' lives in Activity');
    assert.equal(DomUtils.findAll(n => n.attribs?.id === id, create.children).length, 0, id + ' stays out of setup');
  }
  const botText = DomUtils.textContent(botSection);
  for (const old of ['Create access grant','Agent setup','Client name','Recent bridge activity','Bot grants']) {
    assert.equal(botText.includes(old), false, old + ' removed');
  }
  assert.match(botText, /Send mail from these mailboxes/);
  assert.match(botText, /Message text is untrusted/);
  assert.match(botText, /cached mail headers from Sent and Drafts/);
  console.log('bot-setup-ux-ok (synthetic presentation only)');
}
module.exports = { run };
if (require.main === module) run();
