// Synthetic providers and credential stores only. Never read an OS credential.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-oauth-reliability-"));
process.env.MORROW_MAIL_DIR = dir;
process.env.MORROW_MAIL_SECRETS = "memory";
delete process.env.MORROW_GOOGLE_OAUTH_FILE;
delete process.env.GOOGLE_DESKTOP_OAUTH_JSON;
process.env.MORROW_GOOGLE_OAUTH_JSON = JSON.stringify({ installed: {
  client_id: "reliability-fixture.apps.googleusercontent.com", client_secret: "synthetic-client",
} });
const oauth = require("../host/mail/oauth");
const config = require("../host/mail/oauth-config");
const retry = require("../shared/sync-retry");
const remote = require("../host/mail/remote");
const originalFetch = global.fetch;
const json = (value, status = 200, headers = {}) => ({ ok: status < 400, status, headers, json: async () => value });
const flush = () => new Promise(setImmediate);

async function refreshFailures() {
  for (const provider of ["google", "microsoft"]) {
    const scope = config.SCOPES[provider];
    const cases = [
      [503, { error: "server_error", error_description: "synthetic-private-details" }, "oauth_refresh_unavailable", false],
      [502, { error: "invalid_grant" }, "oauth_refresh_unavailable", false],
      [400, { error: "temporarily_unavailable" }, "oauth_refresh_unavailable", false],
      [400, { error: "invalid_grant" }, "needs_auth", true],
      [400, { error: "interaction_required" }, "needs_auth", true],
      [400, { error: "consent_required" }, "needs_auth", true],
      [401, { error: "invalid_client" }, "oauth_configuration", false],
      [400, { error: "invalid_scope" }, "oauth_configuration", false],
      [200, {}, "oauth_refresh_response", false],
      [200, null, "oauth_refresh_response", false],
      [400, { error: "unknown-synthetic-private-code" }, "oauth_refresh_response", false],
    ];
    for (const [status, response, code, sticky] of cases) {
      await assert.rejects(oauth.refresh(provider, { clientId: "synthetic" }, "synthetic-refresh", scope, scope,
        async () => json(response, status)), error => {
        assert.equal(error.code, code, `${provider} HTTP ${status}`);
        assert.equal(retry.isStickyAuthSyncError(remote.explain(error), error), sticky);
        assert.doesNotMatch(error.message, /synthetic-private/);
        if (!sticky) assert.doesNotMatch(error.message, /sign in again|reconnect/i);
        return true;
      });
    }
    for (const code of ["ECONNRESET", "ENOTFOUND", "TimeoutError"]) {
      await assert.rejects(oauth.refresh(provider, { clientId: "synthetic" }, "synthetic-refresh", scope, scope,
        async (_url, init) => {
          assert.ok(init.signal, "renewal has a bounded HTTP deadline");
          throw Object.assign(new Error("synthetic-private-network"), { code });
        }), error => error.code === "oauth_refresh_unavailable" && !retry.isStickyAuthSyncError(remote.explain(error), error));
    }
    await assert.rejects(oauth.refresh(provider, { clientId: "synthetic" }, "synthetic-refresh", scope, scope,
      async () => json({}, 429, { "retry-after": "90" })), error => error.code === "rate_limit" && error.retryAfterMs === 90000);
  }
}

async function credentials() {
  const db = require("../host/mail/db");
  const secrets = require("../host/mail/secrets");
  const memory = require("../host/mail/memory-secrets");
  const actions = require("../host/mail/actions");
  const install = actions.install;
  let secretFor;
  actions.install = dependencies => { secretFor = dependencies.secretFor; return install(dependencies); };
  const engine = require("../host/mail/engine");
  actions.install = install;
  const sidecar = require("../host/mail/sidecar");
  const originalSet = memory.setPassword;
  let posts = [], writeFailure = false;
  const savedFile = path.join(dir, "synthetic-credential.json");
  const saved = key => JSON.parse(secrets.getPassword(key));
  try {
    await engine.init();
    const id = "synthetic-outlook";
    db.insertAccount({ id, email: "fixture@example.invalid", username: "fixture@example.invalid", profile: "outlook",
      authKind: "oauth2", createdAt: Date.now(), imapHost: "imap.example.invalid", imapPort: 993, imapTls: true,
      smtpHost: "smtp.example.invalid", smtpPort: 587, smtpTls: true });
    const account = db.accountById(id);
    const blob = (purpose, accessToken = "synthetic-old") => JSON.stringify({ provider: "microsoft", purpose,
      accessToken, refreshToken: "synthetic-refresh", expiresAt: 1,
      grantedScopes: config.scopesFor("microsoft", purpose), requestedScopes: config.scopesFor("microsoft", purpose) });
    secrets.setPassword(id, blob("imap"));
    secrets.setPassword(`${id}:bundle`, blob("bundle"));
    global.fetch = async (target, init) => {
      if (target === config.ENDPOINTS.microsoft.token) {
        const body = new URLSearchParams(init.body);
        posts.push(body);
        assert.ok(!(body.get("scope").includes("outlook.office.com") && body.get("scope").includes("User.Read")));
        return json({ access_token: "synthetic-renewed", refresh_token: "synthetic-rotated", expires_in: 3600 });
      }
      assert.equal(init.headers.authorization, "Bearer synthetic-renewed");
      assert.ok(String(target).startsWith("https://graph.microsoft.com/"));
      return json({ value: [] });
    };
    memory.setPassword = (key, value) => {
      if (writeFailure) throw new Error("synthetic-private-storage-error");
      originalSet(key, value);
      if (key === id) fs.writeFileSync(savedFile, value);
    };

    writeFailure = true;
    const primary = secrets.getPassword(id);
    await assert.rejects(secretFor(account), error => error.code === "secure_storage_write" && !/synthetic-private/.test(error.message));
    assert.equal(secrets.getPassword(id), primary, "a refused save keeps the prior credential");
    assert.equal(db.accountById(id).auth_error, null);
    const result = await sidecar.answer("calendar:list", [{ accountId: id, timeMin: "2026-11-01T00:00:00Z", timeMax: "2026-12-01T00:00:00Z" }]);
    assert.equal(result.success, false, "a feature cannot report success after losing its rotated refresh token");
    assert.equal(result.error.code, "secure_storage_write");
    assert.doesNotMatch(result.error.message, /synthetic-private|sign in again/i);

    writeFailure = false;
    assert.equal(await secretFor(account), "synthetic-renewed");
    assert.equal(saved(id).refreshToken, "synthetic-rotated");
    const before = posts.length;
    assert.equal(await secretFor(account), "synthetic-renewed");
    assert.equal(posts.length, before, "valid access reuses the durable record");

    // A separate process reopens the synthetic saved store and renews using the
    // rotated credential, without an interactive sign-in or a real Keychain.
    const restart = spawnSync(process.execPath, [__filename, "restart", savedFile], { encoding: "utf8", timeout: 10000 });
    assert.equal(restart.status, 0, restart.stderr);
    assert.match(restart.stdout, /restart-rotation-ok/);

    // The token endpoint can omit refresh_token; keep the existing credential.
    global.fetch = async () => json({ access_token: "synthetic-next", expires_in: 3600 });
    const after = await oauth.accessTokenFor(account, JSON.stringify({ ...saved(id), expiresAt: 1 }), "imap");
    assert.equal(JSON.parse(after.store).refreshToken, "synthetic-rotated");
    assert.equal(JSON.parse(after.store).grantedScopes, saved(id).grantedScopes);

    // Concurrent refreshes and a reconnect must not overwrite the new grant.
    secrets.setPassword(id, blob("imap"));
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    let entered = 0;
    global.fetch = async () => { entered++; await wait; return json({ access_token: "synthetic-obsolete", expires_in: 3600 }); };
    const a = secretFor(account), b = secretFor(account);
    const outcomes = Promise.allSettled([a, b]);
    await flush();
    assert.ok(entered >= 1, "the provider renewal must be in flight before reconnect");
    const replacement = blob("imap", "synthetic-reconnected");
    secrets.setPassword(id, replacement);
    release();
    for (const outcome of await outcomes) {
      assert.equal(outcome.status, "rejected"); assert.equal(outcome.reason.code, "conflict");
    }
    assert.equal(secrets.getPassword(id), replacement);
  } finally {
    memory.setPassword = originalSet;
    global.fetch = originalFetch;
    await engine.stopIdle();
    db.close();
  }
}

async function storageReads() {
  const { createReader } = require("../host/mail/keychain-reader");
  for (const missingStatus of [44, 2]) {
    for (const status of [missingStatus, 1, 36, null]) {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.pid = 1;
      const read = createReader({ launch: () => child, missingStatus });
      const pending = read(["synthetic-read"]);
      const result = status === missingStatus ? pending.then(value => assert.equal(value, null))
        : assert.rejects(pending, { code: "secure_storage_unavailable" });
      child.emit("close", status); await result;
    }
  }
  const windows = { exports: {} }, mac = { exports: {} };
  for (const [file, module, missing] of [["mac-secrets.js", mac, 44], ["win-secrets.js", windows, 2]]) {
    let status = 0;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../host/mail", file), "utf8"), {
      module, Buffer, process,
      require(name) {
        if (name === "child_process") return { spawnSync: () => ({ status, stdout: "synthetic\n", stderr: "private" }) };
        if (name === "./secret-service") return { SERVICE: "synthetic" };
        if (name === "../performance-diagnostics") return { sync: (_stage, fn) => fn(), measure: (_stage, fn) => fn() };
        if (name === "./keychain-reader") return { createReader: () => () => {}, TIMEOUT_MS: 30000, MAX_OUTPUT: 1024 };
        throw new Error("Unexpected fixture dependency " + name);
      },
    });
    status = missing; assert.equal(module.exports.getPassword("fixture"), null);
    status = 1;
    assert.throws(() => module.exports.getPassword("fixture"), error => error.code === "secure_storage_unavailable" && !error.message.includes("private"));
  }
}

async function restart() {
  const raw = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  global.fetch = async (target, init) => {
    assert.equal(target, config.ENDPOINTS.microsoft.token);
    const form = new URLSearchParams(init.body);
    assert.equal(form.get("refresh_token"), "synthetic-rotated");
    assert.equal(form.get("scope"), config.SCOPES.microsoft);
    return json({ access_token: "synthetic-after-restart", expires_in: 3600 });
  };
  const renewed = await oauth.accessTokenFor({ profile: "outlook" }, JSON.stringify({ ...raw, expiresAt: 1 }), "imap");
  assert.equal(renewed.token, "synthetic-after-restart");
  assert.equal(JSON.parse(renewed.store).refreshToken, "synthetic-rotated");
  console.log("restart-rotation-ok");
}

(async () => {
  try {
    const name = process.argv[2];
    if (name === "restart") await restart();
    else {
      if (!name || name === "refresh") await refreshFailures();
      if (!name || name === "persistence") await credentials();
      if (!name || name === "storage") await storageReads();
      console.log("oauth-reliability-ok: provider errors, durable rotation/restart, missing-token preservation, reconnect race, storage access");
    }
  } finally { global.fetch = originalFetch; fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
