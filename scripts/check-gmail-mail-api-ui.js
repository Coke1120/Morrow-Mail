// Synthetic DOM/VM checks, not rendered/native validation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { documentFor } = require("./check-chatgpt-ui");
const { renderer } = require("./check-ux-workflows");
async function run() {
  const document = documentFor(fs.readFileSync(require.resolve("../renderer/index.html"), "utf8"));
  const ui = renderer({ document, window: { morrow: { invoke: async () => null } }, setTimeout: () => 1, clearTimeout() {} });
  ui.context.window.morrowFeaturesCatalog = require("../renderer/features-catalog");
  ui.run("paintFeatureCatalog()");
  for (const id of ["features-catalog", "settings-gmail-migration"]) {
    const text = document.getElementById(id).textContent;
    for (const pattern of [/Gmail.*Trash/, /Microsoft.*unchanged/, /OAuth/, /Calendar.*separate/i]) assert.match(text, pattern);
    assert.doesNotMatch(text, /migration.*(?:unavailable|not available)/i);
  }
  assert.match(document.getElementById("settings-gmail-migration").textContent, /narrower request does not revoke older broad grants/);
  ui.run(`
    state.accounts = [{ id:'gmail', email:'owner@fixture.invalid', imapSmtpProfile:'gmail', authKind:'oauth2' }];
    state.settingsAccountId = 'gmail'; state.accountId = 'gmail';
    globalThis.calls = []; globalThis.reviews = []; globalThis.pending = []; globalThis.refreshes = 0;
    globalThis.allow = false; globalThis.cancelFails = false;
    askConfirm = async copy => { reviews.push(copy); return {ok:allow}; };
    paintSettingsMailbox = () => {}; paintConnectPending = () => {}; showStatus = () => {};
    loadAccounts = async () => { refreshes++; }; loadSettingsCapabilities = async () => { refreshes++; };
    call = async (channel, params) => {
      calls.push({channel,params});
      if (channel === 'mail:cancelOAuth') { if (cancelFails) throw new Error('Synthetic IPC failure'); return {canceled:true}; }
      return new Promise(resolve => pending.push(resolve));
    };
  `);
  await ui.run("reauthorizeGmail()"); assert.equal(ui.run("calls.length"), 0);
  assert.match(ui.run("reviews[0].body"), /gmail.modify.*gmail.settings.basic/);
  assert.match(ui.run("reviews[0].body"), /Cancel.*preserves the current connection/);
  ui.run("allow = true");
  const signing = ui.run("reauthorizeGmail()"); await Promise.resolve(); await Promise.resolve();
  assert.equal(ui.run("gmailMigrationBusy"), true);
  await ui.run("reauthorizeGmail(true)"); assert.equal(ui.run("calls.length"), 1, "one authorization at a time");
  ui.run("cancelFails = true"); await ui.run("cancelGmailReauthorization()");
  assert.equal(ui.run("gmailMigrationBusy && state.oauthPending"), true, "unconfirmed cancellation cannot enable a second authorization");
  assert.match(document.getElementById("settings-capabilities").textContent, /may still finish/);
  ui.run("cancelFails = false"); await ui.run("cancelGmailReauthorization()");
  assert.equal(ui.run("gmailMigrationBusy || state.oauthPending"), false);
  ui.run("pending.shift()({grantWarning:'late result'})"); await signing;
  assert.equal(ui.run("refreshes"), 0, "cancelled stale result cannot update the account UI");
  const calendar = ui.run("reauthorizeGmail(true)"); await Promise.resolve(); await Promise.resolve();
  assert.equal(ui.run("calls.at(-1).channel"), "calendar:connect");
  assert.equal(ui.run("calls.at(-1).params.forceReauthorize"), true);
  assert.match(ui.run("reviews.at(-1).body"), /calendar.*only/);
  ui.run("pending.shift()({})"); await calendar; assert.equal(ui.run("refreshes"), 2);
  ui.run(`askConfirm = async () => {state.settingsAccountId = 'other'; return {ok:true};}`);
  const count = ui.run("calls.length"); await ui.run("reauthorizeGmail()"); assert.equal(ui.run("calls.length"), count, "review is pinned to the chosen account");
  console.log("gmail-mail-api-ui-ok: Features/Accounts help, review, separate Calendar, decline, cancel, stale-result and concurrency fixtures");
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
