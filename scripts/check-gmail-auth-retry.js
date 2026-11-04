// Real engine/session/API paths, synthetic HTTP and memory secrets only.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-gmail-auth-"));
process.env.MORROW_MAIL_DIR = dir;
process.env.MORROW_MAIL_SECRETS = "memory";
delete process.env.MORROW_GOOGLE_OAUTH_FILE;
delete process.env.GOOGLE_DESKTOP_OAUTH_JSON;
const client = name => JSON.stringify({ installed: { client_id: `${name}.apps.googleusercontent.com`, client_secret: "synthetic" } });
process.env.MORROW_GOOGLE_OAUTH_JSON = client("fixture");
const forbidden = () => { throw new Error("Live sockets forbidden"); };
require("node:net").Socket.prototype.connect = forbidden;
require("node:tls").connect = forbidden;
const actions = require("../host/mail/actions");
const install = actions.install;
let withMailClient;
actions.install = hooks => { withMailClient = hooks.withMailClient; install(hooks); };
const engine = require("../host/mail/engine");
actions.install = install;
const db = require("../host/mail/db");
const secrets = require("../host/mail/secrets");
const memory = require("../host/mail/memory-secrets");
const config = require("../host/mail/oauth-config");
const remote = require("../host/mail/remote");
const retry = require("../shared/sync-retry");
const originalSet = memory.setPassword;
const originalFetch = global.fetch;
const now = Date.now;
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const grant = (token = "old", expiresAt = Date.now() + 3600000) => JSON.stringify({ provider: "google", purpose: "imap",
  googleClientId: "fixture.apps.googleusercontent.com", accessToken: token, refreshToken: "refresh-old", expiresAt,
  grantedScopes: config.scopesFor("google", "imap"), requestedScopes: config.scopesFor("google", "imap") });
let serial = 0, posts, calls, tokenReply, route;
function reset(id = `fixture-${++serial}`, createdAt) {
  memory.setPassword = originalSet;
  process.env.MORROW_GOOGLE_OAUTH_JSON = client("fixture");
  posts = []; calls = [];
  db.insertAccount({ id, email: `${id}@example.invalid`, username: `${id}@example.invalid`, profile: "gmail", authKind: "oauth2",
    createdAt: createdAt ?? ++serial, imapHost: "imap.example.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.example.invalid", smtpPort: 587, smtpTls: true });
  db.enableGmail(id);
  secrets.setPassword(id, grant());
  tokenReply = () => reply({ access_token: "new", refresh_token: "refresh-new", expires_in: 3600 });
  route = (_url, init) => init.headers.authorization === "Bearer old" ? reply({}, 401) : reply({ id: "message", historyId: "42", labels: [] });
  return db.accountById(id);
}
const session = (account, work, options) => withMailClient(account, "unused-provisional-token", c => work(c.gmail.api, c.gmail), options);
async function run() {
  global.fetch = async (url, init) => {
    if (url === config.ENDPOINTS.google.token) { posts.push(new URLSearchParams(init.body)); return tokenReply(); }
    assert.ok(String(url).startsWith("https://gmail.googleapis.com/gmail/v1/users/me/"));
    calls.push({ url, method: init.method || "GET", token: init.headers.authorization });
    return route(url, init);
  };
  try {
    await engine.init();
    let account = reset();
    await engine.syncAccountById(account.id, { onlyInbox: true });
    assert.equal(posts.length, 1, "actual sync recovers its rejected folder read");
    assert.equal(db.accountById(account.id).auth_error, null);
    account = reset();
    await session(account, async api => {
      await api.profile(); await api.getMessage("message"); await api.labels();
      assert.equal(posts.length, 1);
      assert.equal(JSON.parse(secrets.getPassword(account.id)).refreshToken, "refresh-new");
    });
    assert.deepEqual(calls.map(c => c.token), ["Bearer old", "Bearer new", "Bearer new", "Bearer new"]);

    account = reset();
    const expiresAt = Date.now() + 120000;
    secrets.setPassword(account.id, grant("old", expiresAt));
    route = () => reply({ id: "message" });
    await session(account, async api => {
      await api.getMessage("message"); Date.now = () => expiresAt + 1;
      await api.getMessage("message");
    });
    Date.now = now;
    assert.deepEqual(calls.map(c => c.token), ["Bearer old", "Bearer new"], "expiry during session rereads and durably refreshes");

    account = reset();
    await session(account, async api => { await Promise.all([api.profile(), api.getMessage("message"), api.labels()]); });
    assert.equal(posts.length, 1, "simultaneous 401s share the durable renewal within the session");
    assert.equal(calls.filter(c => c.token === "Bearer new").length, 3);

    account = reset();
    route = () => reply({}, 401);
    await assert.rejects(session(account, api => api.profile()), e => e.status === 401);
    assert.equal(calls.length, 2); assert.equal(posts.length, 1, "second 401 is final");

    for (const [status, payload, code, sticky] of [[503, {}, "oauth_refresh_unavailable", false],
      [400, { error: "invalid_grant" }, "needs_auth", true], [200, {}, "oauth_refresh_response", false]]) {
      account = reset(); tokenReply = () => reply(payload, status);
      await assert.rejects(session(account, api => api.profile()), e => e.code === code && retry.isStickyAuthSyncError(remote.explain(e), e) === sticky);
      assert.equal(calls.length, 1); assert.equal(JSON.parse(secrets.getPassword(account.id)).accessToken, "old");
    }
    account = reset();
    memory.setPassword = () => { throw new Error("synthetic write failure"); };
    await assert.rejects(session(account, api => api.profile()), e => e.code === "secure_storage_write");
    assert.equal(calls.length, 1); assert.equal(JSON.parse(secrets.getPassword(account.id)).accessToken, "old");

    for (const change of ["reconnect", "remove", "replace", "transport", "login", "client", "abort"]) {
      account = reset();
      const entered = deferred(), release = deferred(), controller = new AbortController();
      tokenReply = async () => { entered.resolve(); await release.promise; return reply({ access_token: "stale", refresh_token: "stale-refresh", expires_in: 3600 }); };
      const pending = session(account, api => api.profile(), { signal: controller.signal });
      const rejected = assert.rejects(pending, e => ["conflict", "account_removed", "google_client_changed"].includes(e.code) || e.name === "AbortError");
      await entered.promise;
      if (change === "reconnect") secrets.setPassword(account.id, grant("replacement"));
      if (change === "remove" || change === "replace") await engine.answer("mail:removeAccount", [{ accountId: account.id }]);
      if (change === "replace") { const savedId = account.id; reset(savedId, account.created_at); secrets.setPassword(savedId, grant("replacement")); }
      if (change === "transport") db.setMailTransport(account.id, "imap");
      if (change === "login") db.updateAccountLogin(account.id, { username: "replacement@example.invalid", profile: "gmail", authKind: "oauth2",
        imapHost: "imap.example.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.example.invalid", smtpPort: 587, smtpTls: true });
      if (change === "client") process.env.MORROW_GOOGLE_OAUTH_JSON = client("different");
      if (change === "abort") controller.abort();
      release.resolve(); await rejected;
      if (["reconnect", "replace"].includes(change)) assert.equal(JSON.parse(secrets.getPassword(account.id)).accessToken, "replacement");
      if (change === "remove") assert.equal(secrets.getPassword(account.id), null);
      assert.ok(calls.every(c => c.token !== "Bearer stale"), `${change} cannot retry with a stale token`);
      if (change !== "abort" && secrets.getPassword(account.id)) assert.doesNotMatch(secrets.getPassword(account.id), /stale/);
    }

    // A response arriving after another read renewed the token must not renew again.
    account = reset();
    const late = deferred(), sawLate = deferred();
    const normalRoute = route;
    route = async (url, init) => {
      if (String(url).includes("/messages/") && init.headers.authorization === "Bearer old") {
        sawLate.resolve(); await late.promise; return reply({}, 401);
      }
      return normalRoute(url, init);
    };
    await session(account, async api => {
      const slow = api.getMessage("message"); await sawLate.promise;
      await api.profile(); late.resolve(); await slow;
    });
    assert.equal(posts.length, 1, "late old-token 401 uses the newer durable token");

    // The retry also rereads durable state after any pacing/renewal yield.
    const { createGmailMailApi } = require("../host/mail/gmail-mail-api");
    let latest = "old", submitted = [];
    const racingApi = createGmailMailApi({ accessToken: async () => latest,
      refreshAccessToken: async () => { latest = "newest"; return "superseded"; },
      fetchImpl: async (_url, init) => { submitted.push(init.headers.authorization); return reply({}, submitted.length === 1 ? 401 : 200); } });
    await racingApi.profile();
    assert.deepEqual(submitted, ["Bearer old", "Bearer newest"]);

    account = reset();
    const other = reset();
    await session(account, async api => {
      await session(other, otherApi => otherApi.profile());
      await api.profile();
    });
    assert.equal(JSON.parse(secrets.getPassword(account.id)).accessToken, "new");
    assert.equal(JSON.parse(secrets.getPassword(other.id)).accessToken, "new");
    assert.equal(posts.length, 2, "renewal remains scoped to each account");

    // Refresh failure after a reconnect must not attach old invalid_grant to the new grant.
    account = reset();
    const entered = deferred(), release = deferred();
    tokenReply = async () => { entered.resolve(); await release.promise; return reply({ error: "invalid_grant" }, 400); };
    const pending = session(account, api => api.profile());
    const rejected = assert.rejects(pending, e => e.code === "conflict");
    await entered.promise; secrets.setPassword(account.id, grant("replacement")); release.resolve(); await rejected;
    assert.equal(JSON.parse(secrets.getPassword(account.id)).accessToken, "replacement");

    // Only rejected HTTP reads are retried, including reads inside label workflows.
    for (const write of [api => api.send({ raw: Buffer.from("synthetic MIME"), confirmed: true }),
      api => api.saveDraft({ raw: Buffer.from("synthetic MIME") }), api => api.saveDraft({ draftId: "draft", raw: Buffer.from("synthetic MIME") }),
      api => api.markRead("message", true), api => api.createLabel("Synthetic"), api => api.deleteLabel("label")]) {
      account = reset(); route = () => reply({}, 401);
      await assert.rejects(session(account, write), e => e.status === 401);
      assert.equal(calls.filter(c => c.method !== "GET").length, 1); assert.equal(posts.length, 0);
    }
    account = reset();
    const fallback = route;
    route = (url, init) => init.method === "POST" ? reply({ id: "draft", message: { id: "message" } }) : fallback(url, init);
    let callbacks = 0;
    await session(account, async api => {
      callbacks++; await api.saveDraft({ raw: Buffer.from("synthetic MIME") }); await api.getMessage("message");
    });
    assert.equal(callbacks, 1); assert.equal(calls.filter(c => c.method === "POST").length, 1);
    assert.equal(posts.length, 1, "read recovery after a successful write never restarts the caller");

    account = reset();
    route = (url, init) => {
      if (init.method === "POST") { secrets.setPassword(account.id, grant("replacement")); return reply({ id: "message" }); }
      return reply({ id: "message" });
    };
    await assert.rejects(session(account, api => api.markRead("message", true)), e => e.code === "conflict" && e.operationIssued === true);
    assert.equal(calls.filter(c => c.method === "POST").length, 1, "post-submit conflict retains uncertain write evidence");

    account = reset();
    await assert.rejects(session(account, api => api.markRead("message", true, { beforeSubmit() { throw new Error("synthetic cancellation"); } })), e => e.operationIssued === false);
    assert.equal(calls.length, 0, "the final write authorization check runs after token awaits and before submission");

    for (const status of [403, 429, 503]) {
      account = reset(); route = () => reply({}, status);
      await assert.rejects(session(account, api => api.profile()), e => e.status === status);
      assert.equal(calls.length, 1); assert.equal(posts.length, 0);
    }
    account = reset();
    route = () => { throw new Error("synthetic network"); };
    await assert.rejects(session(account, api => api.profile()), e => e.code === "provider_network");
    assert.equal(calls.length, 1); assert.equal(posts.length, 0);

    const { documentFor } = require("./check-chatgpt-ui");
    const { renderer } = require("./check-ux-workflows");
    const document = documentFor(fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8"));
    const ui = renderer({ document, window: { morrowFeaturesCatalog: require("../renderer/features-catalog") } });
    ui.run("paintFeatureCatalog()");
    for (const text of [document.getElementById("features-catalog").textContent, document.getElementById("mail-oauth-renewal-help").textContent]) {
      assert.match(text, /Gmail mail sessions reread.*rejected read once/);
      assert.match(text, /writes are never replayed automatically/);
    }
    console.log("gmail-auth-retry-ok: durable renewal, expiry, concurrency, bounded reads, refresh failures, account/client races, no write replay, rendered help");
  } finally {
    Date.now = now; global.fetch = originalFetch; memory.setPassword = originalSet;
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
}
// Production read pacing uses unref timers; keep this standalone fixture alive.
if (require.main === module) { const timer = setTimeout(() => { console.error("Gmail fixture timed out"); process.exit(1); }, 15000); run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(timer)); }
module.exports = { run };
