// Offline Outlook queue/login regressions: memory credentials, synthetic IMAP
// lifecycle and token endpoint. No native credential access or mailbox writes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

async function run() {
  process.env.MORROW_MAIL_SECRETS = "memory";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-outlook-sync-"));
  process.env.MORROW_MAIL_DIR = dir;
  const forbidden = () => { throw new Error("Fixture forbids live connections"); };
  require("node:net").Socket.prototype.connect = forbidden;
  require("node:tls").connect = forbidden;
  let connections = [], closes = 0, behavior = async () => {};
  const authError = () => Object.assign(new Error("Synthetic rejected login"), { authenticationFailed: true });
  class SyntheticImap extends EventEmitter {
    constructor(options) { super(); this.options = options; }
    async connect() { connections.push(this.options.auth); await behavior(this); }
    async logout() { closes++; }
    close() { closes++; }
  }
  require("imapflow").ImapFlow = SyntheticImap;
  const actions = require("../host/mail/actions");
  const install = actions.install;
  let exclusive;
  actions.install = hooks => { exclusive = hooks.exclusive; install(hooks); };
  const engine = require("../host/mail/engine");
  actions.install = install;
  const db = require("../host/mail/db");
  const secrets = require("../host/mail/secrets");
  const memory = require("../host/mail/memory-secrets");
  const remote = require("../host/mail/remote");
  const config = require("../host/mail/oauth-config");
  const now = Date.now;
  const originalSet = memory.setPassword;
  let posts = [], listed = 0, tokenResponse;
  const blob = (accessToken = "synthetic-old", expiresAt = Date.now() + 3600000) => JSON.stringify({
    provider: "microsoft", purpose: "imap", accessToken, refreshToken: "synthetic-refresh", expiresAt,
    grantedScopes: config.scopesFor("microsoft", "imap"), requestedScopes: config.scopesFor("microsoft", "imap"),
  });
  const json = (value, status = 200) => ({ ok: status < 400, status, headers: {}, json: async () => value });
  global.fetch = async (target, init) => {
    assert.equal(target, config.ENDPOINTS.microsoft.token);
    const body = new URLSearchParams(init.body);
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "synthetic-refresh");
    assert.match(body.get("scope"), /outlook\.office\.com/);
    assert.doesNotMatch(body.get("scope"), /graph\.microsoft|User.Read|Mail.ReadWrite/);
    posts.push(body);
    return tokenResponse();
  };
  remote.listFolderRecords = async () => { listed++; return { folders: [], delimiter: "/" }; };
  function reset(id) {
    for (const row of db.listAccountRows()) db.setAuthError(row.id, "fixture skipped");
    connections = []; posts = []; listed = 0; closes = 0;
    behavior = async () => {};
    tokenResponse = () => json({ access_token: "synthetic-new", refresh_token: "synthetic-rotated", expires_in: 3600 });
    db.insertAccount({ id, email: `${id}@example.invalid`, username: `${id}@example.invalid`, profile: "outlook",
      authKind: "oauth2", createdAt: Date.now(), imapHost: "imap.example.invalid", imapPort: 993, imapTls: true,
      smtpHost: "smtp.example.invalid", smtpPort: 587, smtpTls: true });
    secrets.setPassword(id, blob());
    return db.accountById(id);
  }
  const sync = id => engine.syncAccountById(id, { onlyInbox: true });
  try {
    await engine.init();
    reset("queued");
    const start = Date.now();
    secrets.setPassword("queued", blob("synthetic-old", start + 120000));
    let release, entered;
    const held = new Promise(resolve => { release = resolve; });
    const began = new Promise(resolve => { entered = resolve; });
    const blocker = exclusive("queued", async () => { entered(); await held; });
    await began;
    const pending = sync("queued");
    for (let i = 0; i < 20 && !engine.mailQueueForTest("queued").user; i++) await new Promise(setImmediate);
    assert.equal(engine.mailQueueForTest("queued").user, 1, "sync must actually wait behind mailbox work");
    Date.now = () => start + 180000; // token expires while queued / asleep
    release();
    await Promise.all([blocker, pending]);
    Date.now = now;
    assert.equal(posts.length, 1);
    assert.deepEqual(connections.map(c => c.accessToken), ["synthetic-new"]);
    assert.equal(db.accountById("queued").auth_error, null);

    reset("recover");
    behavior = async client => { if (client.options.auth.accessToken === "synthetic-old") throw authError(); };
    await engine.syncAllForTest({ onlyInbox: true });
    assert.deepEqual(connections.map(c => c.accessToken), ["synthetic-old", "synthetic-new"]);
    assert.equal(posts.length, 1, "valid-looking rejected token forces one renewal");
    assert.equal(listed, 1, "mailbox work runs once, after successful login");
    assert.equal(closes, 2, "both attempts release their connections");
    assert.equal(JSON.parse(secrets.getPassword("recover")).refreshToken, "synthetic-rotated");
    assert.equal(db.accountById("recover").auth_error, null);

    reset("rejected");
    behavior = async () => { throw authError(); };
    await assert.rejects(sync("rejected"), e => e.authenticationFailed === true);
    assert.equal(connections.length, 2);
    assert.equal(posts.length, 1);
    assert.equal(listed, 0);

    reset("revoked");
    behavior = async () => { throw authError(); };
    tokenResponse = () => json({ error: "invalid_grant" }, 400);
    // The normal poll classifies the final refresh failure, then skips it.
    for (const row of db.listAccountRows()) if (row.id !== "revoked") db.setAuthError(row.id, "fixture skipped");
    await engine.syncAllForTest({ onlyInbox: true });
    assert.match(db.accountById("revoked").auth_error, /requires sign-in again/);
    assert.equal(connections.length, 1);
    assert.equal(posts.length, 1);
    await engine.syncAllForTest({ onlyInbox: true });
    assert.equal(connections.length, 1, "a real interactive requirement does not loop on later polls");

    reset("temporary");
    behavior = async () => { throw authError(); };
    tokenResponse = () => json({ error: "temporarily_unavailable" }, 503);
    await assert.rejects(sync("temporary"), e => e.code === "oauth_refresh_unavailable");
    await engine.syncAllForTest({ onlyInbox: true });
    assert.equal(db.accountById("temporary").auth_error, null, "a refresh-service outage must not disconnect the mailbox");
    assert.equal(connections.length, 2);
    assert.equal(JSON.parse(secrets.getPassword("temporary")).accessToken, "synthetic-old");

    reset("save-failed");
    behavior = async () => { throw authError(); };
    memory.setPassword = () => { throw new Error("Synthetic storage write failed"); };
    await assert.rejects(sync("save-failed"), e => e.code === "secure_storage_write");
    memory.setPassword = originalSet;
    assert.equal(connections.length, 1, "never use a renewed token before its save succeeds");
    assert.equal(db.accountById("save-failed").auth_error, null);

    reset("reconnected");
    behavior = async () => { secrets.setPassword("reconnected", blob("synthetic-reconnected")); throw authError(); };
    await assert.rejects(sync("reconnected"), e => e.code === "conflict");
    assert.equal(posts.length, 0, "a rejected obsolete login cannot renew or overwrite a newer connection");
    assert.equal(JSON.parse(secrets.getPassword("reconnected")).accessToken, "synthetic-reconnected");

    reset("refresh-race");
    behavior = async () => { throw authError(); };
    tokenResponse = () => { secrets.setPassword("refresh-race", blob("synthetic-reconnected")); return json({ error: "invalid_grant" }, 400); };
    await assert.rejects(sync("refresh-race"), e => e.code === "conflict");
    assert.equal(db.accountById("refresh-race").auth_error, null);

    const account = reset("boundaries");
    let refreshes = 0, writes = 0;
    const options = { refreshAuthentication: async () => { refreshes++; return "synthetic-new"; } };
    await assert.rejects(remote.withClient(account, "synthetic-old", async () => { writes++; throw authError(); }, options));
    assert.equal(writes, 1, "a callback that has issued a write is never replayed");
    assert.equal(refreshes, 0);
    behavior = async () => { throw Object.assign(new Error("Synthetic timeout"), { code: "ETIMEDOUT" }); };
    await assert.rejects(remote.withClient(account, "synthetic-old", () => { writes++; }, options));
    assert.equal(refreshes, 0, "connection errors cannot force OAuth renewal");
    behavior = async () => { throw authError(); };
    await assert.rejects(remote.withClient({ ...account, auth_kind: "password" }, "fixture-password", () => { writes++; }, options));
    assert.equal(refreshes, 0, "password logins do not renew OAuth");

    const { documentFor } = require("./check-chatgpt-ui");
    const { renderer } = require("./check-ux-workflows");
    const document = documentFor(fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8"));
    const ui = renderer({ document, window: { morrowFeaturesCatalog: require("../renderer/features-catalog") } });
    ui.run("paintFeatureCatalog()");
    assert.match(document.getElementById("features-catalog").textContent, /Outlook sync checks.*before connecting/);
    assert.match(document.getElementById("features-catalog").textContent, /once.*before any mailbox operation/);
    console.log("outlook-sync-auth-ok: queued expiry, bounded login recovery, durable refresh, real reauth, races, no write replay, rendered help");
  } finally {
    Date.now = now;
    memory.setPassword = originalSet;
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
