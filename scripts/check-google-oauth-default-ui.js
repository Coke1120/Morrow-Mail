// Actual renderer/DOM event flows; every IPC response is synthetic. No browser navigation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");
const { renderer } = require("./check-ux-workflows");
const html = fs.readFileSync(require.resolve("../renderer/index.html"), "utf8");
const migrationMessage = "Review Migrate Gmail to Gmail API in Settings → Accounts first. Google OAuth remains available; cached mail and drafts stay in this account.";
const gmail = { id: "gmail", email: "google@example.invalid", platform: "imap", authKind: "oauth2", imapSmtpProfile: "gmail", mailTransport: "imap" };
const manual = { id: "manual", email: "manual@example.invalid", platform: "imap", authKind: "password", imapSmtpProfile: "custom", imapUsername: "fixture-login",
  imapSmtpCustom: { imap: { host: "imap.example.invalid", port: 993, tls: true }, smtp: { host: "smtp.example.invalid", port: 587, tls: false } } };
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

function fixture(t, { failure, googleReady = true } = {}) {
  const dom = new JSDOM(html), { window } = dom, { document } = window, calls = [];
  t.after(() => window.close());
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { if (!dialog.open) return; dialog.open = false; dialog.dispatchEvent(new window.Event("close")); };
  }
  const invoke = async (channel, input) => {
    calls.push({ channel, input });
    if (channel === "mail:addAccount") return failure ? { success: false, error: failure } : { success: true, data: { id: "gmail", email: gmail.email } };
    if (channel === "mail:oauthStatus") return { success: true, data: { google: googleReady, accounts: [] } };
    if (channel === "mail:googleOauthStatus") return { success: true, data: { ready: googleReady, source: googleReady ? "bundled" : "none", imported: false } };
    if (channel === "mail:migrateGmail") return { success: true, data: { id: "gmail", email: gmail.email } };
    if (channel === "mail:getPushEnabled") return { success: true, data: true };
    return { success: true, data: [] };
  };
  window.morrow = { invoke, on() { return () => {}; } };
  window.morrowFeaturesCatalog = require("../renderer/features-catalog");
  const ui = renderer({ window, document, navigator: window.navigator, Event: window.Event, Node: window.Node,
    requestAnimationFrame: work => { queueMicrotask(() => work(0)); return 1; },
    setTimeout: (work, delay) => { const handle = setTimeout(work, delay); handle.unref(); return handle; }, clearTimeout });
  ui.context.fixtures = { gmail, manual };
  ui.run(`state.accounts = [fixtures.gmail, fixtures.manual]; state.accountId = 'manual'; state.settingsAccountId = 'manual';
    state.oauthStatus = {google: ${googleReady}};
    fillPresets([{profile:'gmail',displayName:'Gmail'}, {profile:'outlook',displayName:'Outlook'}, {profile:'yahoo',displayName:'Yahoo'}]);
    loadAccounts = async () => {}; wire();`);
  return { ui, calls, document, get: id => document.getElementById(id) };
}

test("new connection clears old manual/reconnect state on every open and close", t => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) {
    f.ui.run("openConnectFor(fixtures.manual)");
    f.get("password").value = "synthetic-unused-password";
    f.get("connect").close();
    f.get("connect-open").click();
    assert.equal(f.get("connect-imap").open, false);
    assert.equal(f.get("email").value, ""); assert.equal(f.get("email").readOnly, false);
    assert.equal(f.get("password").value, ""); assert.equal(f.get("username").value, "");
    assert.equal(f.get("imap-host").value, ""); assert.equal(f.get("smtp-host").value, "");
    assert.equal(f.ui.run("state.reconnectAccountId"), null);
    assert.equal(f.ui.run("customEndpointEdits.size"), 0);
    f.get("connect").close();
  }
  assert.equal(f.calls.length, 0);
});

test("Gmail OAuth reconnects collapse manual fields for legacy and API accounts", t => {
  const f = fixture(t);
  for (const transport of ["imap", "gmail_api"]) {
    f.ui.context.transport = transport;
    f.ui.run("openConnectFor({...fixtures.gmail, mailTransport: transport})");
    assert.equal(f.get("connect-imap").open, false);
    assert.equal(f.get("email").value, gmail.email); assert.equal(f.get("email").readOnly, true);
    assert.equal(f.ui.run("state.reconnectAccountId"), "gmail");
    assert.equal(f.get("oauth-google").type, "button"); assert.ok(f.get("oauth-google").classList.contains("primary"));
    f.get("connect").close();
  }
});

test("manual-provider reconnects preserve the form and exact custom servers; Gmail password accounts remain manual", t => {
  const f = fixture(t); f.ui.run("openConnectFor(fixtures.manual)");
  assert.equal(f.get("connect-imap").open, true); assert.equal(f.get("profile").value, "custom");
  assert.equal(f.get("imap-host").value, "imap.example.invalid"); assert.equal(f.get("smtp-port").value, "587");
  assert.equal(f.get("smtp-tls").checked, false); assert.equal(f.get("username").value, "fixture-login");
  assert.equal(f.ui.run("customEndpointEdits.size"), 2);
  f.get("connect").close(); f.ui.run("openConnectFor({...fixtures.gmail, authKind:'password'})");
  assert.equal(f.get("connect-imap").open, true);
});

test("empty-state, Settings and setup entrypoints use the same fresh connection route", t => {
  const f = fixture(t);
  for (const id of ["connect-open", "agent-setup-connect", "brain-setup-connect", null]) {
    f.ui.run("openConnectFor(fixtures.manual)"); f.get("connect").close();
    if (id) f.get(id).click(); else f.ui.run("connectButton().click()");
    assert.equal(f.get("connect").open, true); assert.equal(f.get("connect-imap").open, false);
    assert.equal(f.get("email").value, ""); assert.equal(f.ui.run("state.reconnectAccountId"), null);
    f.get("connect").close();
  }
  f.ui.run("state.settingsAccountId='gmail'"); f.get("settings-reconnect").click();
  assert.equal(f.get("connect-imap").open, false); assert.equal(f.ui.run("state.reconnectAccountId"), "gmail");
});

test("actual Google button bypasses required manual password/email validation without submitting IMAP", async t => {
  const f = fixture(t); f.get("connect-open").click();
  assert.equal(f.get("password").required, true); assert.equal(f.get("connect-form").checkValidity(), false);
  let invalid = 0, submits = 0;
  f.get("connect-form").addEventListener("invalid", () => invalid++, true);
  f.get("connect-form").addEventListener("submit", () => submits++);
  f.get("oauth-google").click(); await settle();
  assert.equal(invalid, 0); assert.equal(submits, 0); assert.equal(f.get("password").value, "");
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].channel, "mail:addAccount"); assert.equal(f.calls[0].input.provider, "google");
});

test("unavailable Google stays disabled with optional advanced guidance and no password fallback", t => {
  const f = fixture(t, { googleReady: false }); f.get("connect-open").click();
  assert.equal(f.get("oauth-google").disabled, true); assert.equal(f.get("connect-imap").open, false);
  assert.match(f.get("oauth-unavailable").textContent, /optional advanced choice/);
  assert.doesNotMatch(f.get("oauth-unavailable").textContent, /app password|Import one/);
  f.get("oauth-google").click(); assert.equal(f.calls.length, 0);
});

test("exact migration-required host envelope replaces retry advice with review-only action", async t => {
  const f = fixture(t, { failure: { code: "gmail_migration_required", message: migrationMessage } });
  f.ui.run("openConnectFor(fixtures.gmail)"); f.get("oauth-google").click(); await settle();
  assert.equal(f.get("connect-gmail-migration").hidden, false); assert.equal(f.get("connect-imap").open, false);
  assert.match(f.get("connect-status").textContent, /Review Gmail API migration.*Permissions & calendar access/);
  assert.doesNotMatch(f.get("connect-status").textContent, /Try the provider button again/);
  assert.deepEqual(f.calls.map(row => row.channel), ["mail:addAccount"]);
  assert.equal(f.calls[0].input.expectedAccountId, "gmail");
  f.get("connect-gmail-migration").click(); await settle();
  assert.equal(f.get("connect").open, false); assert.equal(f.get("settings").open, true);
  assert.equal(f.get("settings-tab-mailbox").getAttribute("aria-selected"), "true");
  assert.equal(f.ui.run("settingsAccount().id"), "gmail"); assert.equal(f.get("account-permissions").open, true);
  assert.equal(f.get("settings-gmail-migrate").textContent, "Migrate Gmail to Gmail API");
  assert.equal(f.calls.some(row => row.channel === "mail:migrateGmail" || row.channel === "mail:connectImapSmtp"), false);
  const cancelled = f.ui.run("reauthorizeGmail(false)");
  assert.equal(f.get("confirm").open, true); assert.equal(f.get("confirm-ok").textContent, "Continue with Google");
  f.get("confirm-cancel").click(); await cancelled;
  assert.equal(f.calls.some(row => row.channel === "mail:migrateGmail"), false);
  const approved = f.ui.run("reauthorizeGmail(false)");
  f.get("confirm-ok").click(); await approved;
  const writes = f.calls.filter(row => row.channel === "mail:migrateGmail");
  assert.equal(writes.length, 1); assert.equal(writes[0].input.accountId, "gmail"); assert.equal(writes[0].input.confirmed, true);
});

test("removed migration target never navigates or migrates another account", async t => {
  const f = fixture(t, { failure: { code: "gmail_migration_required", message: migrationMessage } });
  f.ui.run("openConnectFor(fixtures.gmail)"); f.get("oauth-google").click(); await settle();
  f.ui.run("state.accounts=[fixtures.manual]"); f.get("connect-gmail-migration").click(); await settle();
  assert.equal(f.ui.run("settingsAccount().id"), "manual"); assert.match(f.get("status").textContent, /changed or was removed/);
  assert.equal(f.calls.some(row => row.channel === "mail:migrateGmail"), false);
});

test("unpinned migration error asks for mailbox selection and closing/reopening clears old action", async t => {
  const f = fixture(t, { failure: { code: "gmail_migration_required", message: migrationMessage } });
  f.get("connect-open").click(); f.get("oauth-google").click(); await settle();
  f.get("connect-gmail-migration").click(); await settle();
  assert.match(f.get("status").textContent, /Select the Gmail mailbox/);
  assert.equal(f.document.activeElement, f.get("settings-account"));
  f.get("connect-open").click(); assert.equal(f.get("connect-gmail-migration").hidden, true);
  assert.equal(f.calls.some(row => row.channel === "mail:migrateGmail"), false);
});

test("other OAuth errors retain their message without migration action or automatic password request", async t => {
  const f = fixture(t, { failure: { code: "oauth", message: "Synthetic Google approval declined" } });
  f.ui.run("openConnectFor(fixtures.gmail)"); f.get("oauth-google").click(); await settle();
  assert.match(f.get("connect-status").textContent, /Synthetic Google approval declined/);
  assert.equal(f.get("connect-gmail-migration").hidden, true); assert.equal(f.get("connect-imap").open, false);
  assert.deepEqual(f.calls.map(row => row.channel), ["mail:addAccount"]);
});

test("Features, help and optional import status agree without changing explicit client selection", t => {
  const f = fixture(t); f.ui.run("paintFeatureCatalog()");
  assert.match(f.get("features-catalog").textContent, /Google sign-in and optional personal client/);
  assert.match(f.get("features-catalog").textContent, /without migrating until you review and confirm/);
  assert.equal(f.get("google-oauth-client").open, false);
  assert.equal(f.get("google-oauth-client").querySelector("summary").textContent, "Advanced: personal Google OAuth client (optional)");
  assert.match(f.get("connect-google-help").textContent, /no password is needed in Morrow/);
  assert.match(f.get("google-oauth-default-help").textContent, /bundled Desktop client by default when present/);
  assert.match(f.ui.run("googleOauthClientCopy({ready:true,source:'imported',imported:true})"), /your imported Desktop client/);
  assert.match(f.ui.run("googleOauthClientCopy({ready:true,source:'bundled'})"), /bundled Desktop client/);
  const guide = fs.readFileSync(require.resolve("../docs/bring-your-own-google-oauth.md"), "utf8");
  assert.match(guide, /optional advanced/); assert.match(guide, /Review Gmail API migration/);
});
