"use strict";

// Real temporary SQLite/profiles and HTTP handler; memory secrets, no listeners,
// provider traffic, SMTP, or operating-system credential writes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { PassThrough } = require("node:stream");
const { spawnSync } = require("node:child_process");

let engine, db, remote, secrets, oauth, sidecar, auth, server, catalog, budget;
let reconnectCases = 0;
const envKeys = ["MORROW_USER_DATA", "MORROW_MAIL_DIR", "MORROW_AI_CONFIG_DIR", "MORROW_MAIL_SECRETS", "MORROW_GOOGLE_OAUTH_JSON", "MORROW_GOOGLE_OAUTH_FILE"];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function configure(dir) {
  fs.mkdirSync(dir, { recursive: true });
  Object.assign(process.env, {
    MORROW_USER_DATA: dir, MORROW_MAIL_DIR: dir, MORROW_AI_CONFIG_DIR: dir,
    MORROW_MAIL_SECRETS: "memory",
    MORROW_GOOGLE_OAUTH_JSON: JSON.stringify({ installed: { client_id: "liveness-fixture.apps.googleusercontent.com", client_secret: "fixture-only" } }),
  });
  delete process.env.MORROW_GOOGLE_OAUTH_FILE;
}

function modules() {
  engine = require("../host/mail/engine");
  db = require("../host/mail/db");
  remote = require("../host/mail/remote");
  secrets = require("../host/mail/secrets");
  oauth = require("../host/mail/oauth");
  sidecar = require("../host/mail/sidecar");
  auth = require("../host/bot/auth");
  server = require("../host/bot/server");
  catalog = require("../host/bot/catalog");
  budget = require("../host/bot/budget");
}

function seed(id, email = id + "@example.test") {
  db.insertAccount({ id, email, username: email, profile: "custom", createdAt: 1,
    imapHost: "imap.example.test", imapPort: 993, imapTls: true,
    smtpHost: "smtp.example.test", smtpPort: 465, smtpTls: true });
  secrets.setPassword(id, "synthetic-original");
}

function message(id, accountId) {
  return { id, accountId, folderPath: "INBOX", uid: 1, uidValidity: 100,
    subject: "PrivateLegacyWord", textBody: "SYNTHETIC_PRIVATE_BODY", bodyComplete: true,
    date: "2026-10-24T08:00:00Z", listSortTs: Date.now(), hasAttachments: true,
    attachments: [{ id: "2", filename: "SYNTHETIC_PRIVATE_FILE.txt", mimeType: "text/plain", size: 7 }] };
}

function gate() {
  let enter, release;
  const active = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  return { active, release, async wait() { enter(); await held; } };
}

function transports() {
  remote.withClient = async (_account, _password, work) => work({});
  remote.listFolderRecords = async () => ({ folders: [], delimiter: "/" });
  remote.verifySmtp = async () => {};
  remote.openIdleClient = async () => { throw new Error("Synthetic IDLE blocked"); };
  remote.searchUids = async () => ({ uids: [], validity: 100, exists: 0, unseen: 0 });
  remote.fetchMessages = async () => ({ validity: 100, messages: [] });
  remote.sendSmtp = async () => { throw new Error("SMTP forbidden in account liveness fixture"); };
  sidecar.grantPurpose = async () => ({ success: true, data: {} });
}

function imap(email, expectedAccountId, password = "synthetic-pending") {
  return engine.answer("mail:connectImapSmtp", [{ email, expectedAccountId, username: email,
    password, profile: "custom", custom: {
      imap: { host: "imap.example.test", port: 993, tls: true },
      smtp: { host: "smtp.example.test", port: 465, tls: true },
    } }]);
}

function signed(provider, email, completed) {
  const config = require("../host/mail/oauth-config");
  return { provider, profile: provider === "google" ? "gmail" : "outlook", purpose: "imap",
    ...(provider === "google" ? { googleClientId: config.credentials("google").clientId } : {}),
    email, username: email, refreshToken: "synthetic-refresh", accessToken: "synthetic-access",
    expiresAt: Date.now() + 3600000,
    grantedScopes: provider === "google" ? config.BUNDLE_SCOPES.google : config.SCOPES.microsoft,
    imap: { host: "imap.example.test", port: 993, tls: true },
    smtp: { host: "smtp.example.test", port: 465, tls: true },
    complete(result) { completed.push(result.ok); } };
}

async function invalidatePending(start, id, replacement) {
  const held = gate();
  const pending = start(held);
  try {
    await held.active;
    assert.equal((await engine.answer("mail:removeAccount", [{ accountId: id }])).success, true);
    assert.equal(db.accountById(id), null);
    assert.equal(secrets.getPassword(id), null);
    let fresh;
    if (replacement === "same-id") seed(id); // identical created_at, different removal epoch
    if (replacement === "fresh") {
      fresh = await imap(id + "@example.test", undefined, "synthetic-deliberate-new");
      assert.equal(fresh.success, true);
      assert.notEqual(fresh.data.id, id);
    }
    held.release();
    const result = await pending;
    assert.equal(result.success, false, "removed reconnect must not report success");
    assert.equal(result.error.code, "account_removed");
    if (replacement === "same-id") assert.equal(secrets.getPassword(id), "synthetic-original");
    else {
      assert.equal(db.accountById(id), null);
      assert.equal(secrets.getPassword(id), null);
    }
    if (fresh) {
      assert.equal(db.accountByEmail(id + "@example.test").id, fresh.data.id);
      assert.equal(secrets.getPassword(fresh.data.id), "synthetic-deliberate-new",
        "obsolete completion must not overwrite or roll back the new connection");
      await engine.answer("mail:removeAccount", [{ accountId: fresh.data.id }]);
    } else if (!replacement) assert.equal(db.accountByEmail(id + "@example.test"), null);
    if (replacement === "same-id") await engine.answer("mail:removeAccount", [{ accountId: id }]);
    reconnectCases++;
  } finally {
    held.release();
    await pending;
  }
}

async function reconnectChecks() {
  seed("unrelated");
  for (const explicit of [true, false]) {
    for (const phase of ["imap", "folders", "smtp", "smtp-warning"]) {
      transports();
      const id = "imap-" + explicit + "-" + phase;
      seed(id);
      await invalidatePending(held => {
        let heldOnce = false;
        const wait = async at => { if (phase === at && !heldOnce) { heldOnce = true; await held.wait(); } };
        remote.withClient = async (_a, _p, work) => { await wait("imap"); return work({}); };
        remote.listFolderRecords = async () => { await wait("folders"); return { folders: [], delimiter: "/" }; };
        remote.verifySmtp = async () => {
          await wait(phase === "smtp-warning" ? "smtp-warning" : "smtp");
          if (phase === "smtp-warning") throw new Error("Synthetic non-auth SMTP probe warning");
        };
        return imap(id + "@example.test", explicit ? id : undefined);
      }, id);
    }
  }
  for (const replacement of ["same-id", "fresh"]) {
    transports();
    const id = "imap-replace-" + replacement;
    seed(id);
    await invalidatePending(held => {
      let first = true;
      remote.withClient = async (_a, _p, work) => { if (first) { first = false; await held.wait(); } return work({}); };
      return imap(id + "@example.test", id);
    }, id, replacement);
  }
  for (const provider of ["google", "microsoft"]) {
    for (const explicit of [true, false]) {
      for (const replacement of [undefined, "same-id", "fresh"]) {
        transports();
        const id = "oauth-" + provider + "-" + explicit + "-" + (replacement || "removed");
        seed(id);
        const completed = [];
        await invalidatePending(held => {
          oauth.signIn = async () => { await held.wait(); return signed(provider, id + "@example.test", completed); };
          return engine.answer("mail:addAccount", [{ provider, expectedAccountId: explicit ? id : undefined }]);
        }, id, replacement);
        assert.deepEqual(completed, [false], "stale browser sign-in cannot report successful persistence");
      }
    }
  }
  // Current-account controls: preserve identity and cached content, accept a
  // deliberate new add after removal, and reject initial address mismatches.
  transports();
  seed("normal");
  db.insertMessage(message("keep-normal", "normal"));
  assert.equal((await imap("wrong@example.test", "normal")).error.code, "account_mismatch");
  const good = await imap("normal@example.test", "normal", "synthetic-current");
  assert.equal(good.success, true);
  assert.equal(good.data.id, "normal");
  assert.equal(db.messageById("keep-normal").text_body, "SYNTHETIC_PRIVATE_BODY");
  assert.equal(secrets.getPassword("normal"), "synthetic-current");
  const pages = [];
  oauth.signIn = async () => signed("google", "normal@example.test", pages);
  const goodOAuth = await engine.answer("mail:addAccount", [{ provider: "google", expectedAccountId: "normal" }]);
  assert.equal(goodOAuth.success, true);
  assert.equal(goodOAuth.data.id, "normal");
  assert.deepEqual(pages, [true]);
  assert.equal(db.messageById("keep-normal").text_body, "SYNTHETIC_PRIVATE_BODY");
  assert.equal(secrets.getPassword("unrelated"), "synthetic-original");
  await delay(300); // settle all connect callbacks while transports are intercepted
  await engine.answer("mail:removeAccount", [{ accountId: "normal" }]);
  assert.equal((await imap("normal@example.test", "normal")).error.code, "account_mismatch");
  const deliberate = await imap("normal@example.test", undefined, "synthetic-after-removal");
  assert.equal(deliberate.success, true);
  assert.notEqual(deliberate.data.id, "normal");
  await delay(300);
  await engine.stopIdle();
  await db.close();
  await engine.init();
  assert.equal(db.accountByEmail("normal@example.test").id, deliberate.data.id,
    "a deliberate current connection survives reopening storage");
  await rendererDiscoveryCheck();
}

async function rendererDiscoveryCheck() {
  transports();
  const id = "renderer-discovery", email = id + "@example.test";
  seed(id, email);
  const { renderer } = require("./check-ux-workflows");
  const nodes = new Map();
  const get = name => {
    if (!nodes.has(name)) {
      const handlers = {};
      nodes.set(name, { value: "", textContent: "", classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(event, callback) { handlers[event] = callback; }, close() { handlers.close?.(); } });
    }
    return nodes.get(name);
  };
  const ui = renderer({ document: { getElementById: get } });
  get("email").value = email;
  get("profile").value = "fastmail";
  get("password").value = "synthetic-before-discovery";
  const source = fs.readFileSync(require.resolve("../renderer/app.js"), "utf8");
  ui.run(source.split("\n").find(line => line.includes('$("connect").addEventListener("close",')));
  ui.context.fixtureId = id;
  ui.context.fixtureEmail = email;
  const held = gate();
  let submitted;
  ui.context.fixtureCall = async (channel, payload) => {
    if (channel === "mail:discoverMail") { await held.wait(); return null; }
    assert.equal(channel, "mail:connectImapSmtp");
    submitted = payload;
    const result = await engine.answer(channel, [payload]);
    if (!result.success) throw new Error(result.error.message);
    return result.data;
  };
  ui.run(`state.reconnectAccountId=fixtureId;discoveryEmail=fixtureEmail;
    paintConnectPending=()=>{};setConnectStatus=()=>{};showStatus=()=>{};loadAccounts=async()=>{};
    closeDialog=id=>$(id).close();call=fixtureCall;`);
  const pending = ui.run("connectImap()");
  try {
    await held.active;
    ui.run("dismissConnect()");
    assert.equal(ui.run("state.reconnectAccountId"), null, "run the actual dialog-close cleanup");
    await engine.answer("mail:removeAccount", [{ accountId: id }]);
    held.release();
    await pending;
    assert.equal(submitted.expectedAccountId, id, "discovery cannot reinterpret a reconnect as a fresh add");
    assert.equal(db.accountByEmail(email), null);
    assert.equal(secrets.getPassword(id), null);
    reconnectCases++;
  } finally { held.release(); await pending; }
}

async function api(token, operation, params = {}) {
  budget.resetLimitsForTest();
  const req = new PassThrough();
  req.setTimeout = () => {};
  req.method = "POST";
  req.url = "/api/bot/v1/call";
  req.headers = { host: "127.0.0.1:47831", "content-type": "application/json", accept: "application/json",
    authorization: "Bearer " + token, "tailscale-app-capabilities": catalog.markerJson() };
  req.rawHeaders = Object.entries(req.headers).flat();
  const res = { writableEnded: false, destroyed: false, status: 0, body: "", setTimeout() {},
    writeHead(status) { this.status = status; }, end(body) { this.body += String(body); this.writableEnded = true; },
    destroy() { this.destroyed = true; } };
  const pending = server.handle(req, res);
  req.end(JSON.stringify({ apiVersion: "1.0", requestId: crypto.randomUUID(), installationId: auth.installationId(), operation, params }));
  await pending;
  return { status: res.status, body: JSON.parse(res.body) };
}

async function orphanAssertions(token) {
  assert.equal(db.accountById("legacy"), null);
  assert.equal(db.messageById("known-legacy").text_body, "SYNTHETIC_PRIVATE_BODY",
    "authorization checks must not purge legacy recovery data");
  assert.equal((await api(token, "accounts.list")).body.data.accounts.length, 1);
  const cases = [
    ["mail.get_cached", { messageId: "known-legacy" }],
    ["mail.attachment.get", { messageId: "known-legacy", index: 0 }],
    ["mail.list_cached", { folder: "inbox" }],
    ["mail.search_cached", { query: "PrivateLegacyWord" }],
    ["health.get", {}], ["agent.proposals.list", {}], ["draft.proposals.list", {}],
    ["draft.proposals.submit", { idempotencyKey: crypto.randomUUID(), to: ["r@example.test"], subject: "Denied", bodyText: "Denied" }],
  ];
  for (const [operation, params] of cases) {
    const denied = await api(token, operation, { accountId: "legacy", ...params });
    assert.equal(denied.status, 404, operation);
    assert.equal(denied.body.error.code, "NOT_FOUND", operation);
    assert.ok(!JSON.stringify(denied.body).includes("SYNTHETIC_PRIVATE"));
  }
  const live = await api(token, "mail.get_cached", { accountId: "connected", messageId: "known-connected" });
  assert.equal(live.status, 200, "offline/reauth-needed connected accounts retain cache access");
  assert.equal(live.body.data.body.text, "SYNTHETIC_PRIVATE_BODY");
  const foreign = await api(token, "mail.get_cached", { accountId: "connected", messageId: "known-legacy" });
  const missing = await api(token, "mail.get_cached", { accountId: "connected", messageId: "missing" });
  assert.equal(foreign.body.error.code, "NOT_FOUND");
  assert.equal(missing.body.error.code, "NOT_FOUND");
  const unscoped = await api(token, "mail.get_cached", { accountId: "unscoped", messageId: "known-legacy" });
  assert.equal(unscoped.status, 403);
  assert.equal(unscoped.body.error.code, "FORBIDDEN");
}

async function botChecks() {
  seed("legacy"); seed("connected");
  for (const id of ["legacy", "connected"]) {
    db.replaceFolders(id, [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }], "/");
    db.insertMessage(message("known-" + id, id));
  }
  db.setAuthError("connected", "Synthetic reauthentication needed");
  const grant = auth.mint({ label: "Synthetic liveness", accountIds: ["legacy", "connected"],
    capabilities: catalog.CAPABILITIES.filter(cap => cap !== "mail.send") });
  auth.setEnabledFlag(true);
  assert.equal((await api(grant.secret, "mail.get_cached", { accountId: "legacy", messageId: "known-legacy" })).status, 200);
  assert.equal((await api(grant.secret, "draft.proposals.submit", { accountId: "legacy", idempotencyKey: crypto.randomUUID(),
    to: ["r@example.test"], subject: "SYNTHETIC_PRIVATE_PROPOSAL", bodyText: "Inert" })).status, 200);
  const draftFile = require("../host/bot/store").draftPath();
  const originalDrafts = fs.readFileSync(draftFile, "utf8");
  await db.checkpoint();
  const file = db.file();
  await db.close();
  const notReady = await api(grant.secret, "mail.get_cached", { accountId: "legacy", messageId: "known-legacy" });
  assert.equal(notReady.status, 503);
  assert.equal(notReady.body.error.code, "HOST_NOT_READY");
  const raw = new (require("better-sqlite3"))(file);
  try { raw.prepare("DELETE FROM accounts WHERE id = ?").run("legacy"); } finally { raw.close(); }
  await engine.init();
  await orphanAssertions(grant.secret);
  assert.equal(fs.readFileSync(draftFile, "utf8"), originalDrafts, "denied orphan proposal calls do not mutate the store");
  await db.close();
  const child = spawnSync(process.execPath, [__filename, "--verify-orphans"], {
    env: { ...process.env, MORROW_LIVENESS_TEST_TOKEN: grant.secret }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /account-liveness-restart-ok/);
  await engine.init();
  assert.equal(db.messageById("known-legacy").text_body, "SYNTHETIC_PRIVATE_BODY");
}

async function run() {
  const env = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-account-liveness-"));
  configure(path.join(root, "connections"));
  modules();
  const savedRemote = Object.fromEntries(["withClient", "listFolderRecords", "verifySmtp", "openIdleClient", "searchUids", "fetchMessages", "sendSmtp"].map(key => [key, remote[key]]));
  const saved = { signIn: oauth.signIn, grantPurpose: sidecar.grantPurpose };
  try {
    transports();
    await engine.init();
    if (!process.argv.includes("--bot-only")) await reconnectChecks();
    if (!process.argv.includes("--connections-only")) {
      await delay(300);
      await engine.stopIdle();
      await db.close();
      configure(path.join(root, "bot"));
      await engine.init();
      await botChecks();
    }
  } finally {
    await delay(300);
    await engine.stopIdle();
    for (const account of db.listAccountRows()) secrets.deletePassword(account.id);
    await db.close();
    Object.assign(remote, savedRemote);
    oauth.signIn = saved.signIn;
    sidecar.grantPurpose = saved.grantPurpose;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`account-liveness-ok (${reconnectCases} reconnect invalidations; connected controls, orphan routes, process restart)`);
}

async function restart() {
  modules();
  try {
    transports();
    await engine.init();
    await orphanAssertions(process.env.MORROW_LIVENESS_TEST_TOKEN);
    console.log("account-liveness-restart-ok");
  } finally { await engine.stopIdle(); await db.close(); }
}

module.exports = { run };
if (require.main === module) (process.argv.includes("--verify-orphans") ? restart() : run())
  .then(() => process.exit(0), error => { console.error(error); process.exit(1); });
