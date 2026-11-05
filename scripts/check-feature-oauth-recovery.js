// Production engine/feature/HTTP paths, temporary SQLite and memory secrets.
// Every provider response is synthetic; native credentials and sockets forbidden.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-feature-oauth-"));
process.env.MORROW_MAIL_DIR = dir;
process.env.MORROW_MAIL_SECRETS = "memory";
delete process.env.MORROW_GOOGLE_OAUTH_FILE;
delete process.env.GOOGLE_DESKTOP_OAUTH_JSON;
const client = name => JSON.stringify({ installed: { client_id: `${name}.apps.googleusercontent.com`, client_secret: "synthetic" } });
process.env.MORROW_GOOGLE_OAUTH_JSON = client("fixture");
const forbidden = () => { throw new Error("Live connections and credential processes are forbidden"); };
require("node:net").Socket.prototype.connect = forbidden;
require("node:tls").connect = forbidden;
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) require("node:child_process")[name] = forbidden;
const actions = require("../host/mail/actions");
const install = actions.install;
let secretFor;
actions.install = hooks => { secretFor = hooks.secretFor; return install(hooks); };
const engine = require("../host/mail/engine");
actions.install = install;
const db = require("../host/mail/db");
const secrets = require("../host/mail/secrets");
const memory = require("../host/mail/memory-secrets");
const config = require("../host/mail/oauth-config");
const sidecar = require("../host/mail/sidecar");
const http = require("../host/mail/provider-http");
const { renderer } = require("./check-ux-workflows");
const originalSet = memory.setPassword, originalFetch = global.fetch, now = Date.now;
const reply = (body, status = 200, headers) => new Response(JSON.stringify(body), { status, headers });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const range = { timeMin: "2026-11-01T00:00:00Z", timeMax: "2026-12-01T00:00:00Z" };
let serial = 0, requests, renewals, api, renewal;
function grant(provider, purpose, accessToken = "old", expiresAt = Date.now() + 3600000) {
  return JSON.stringify({ provider, purpose, accessToken, expiresAt, refreshToken: "refresh-old",
    requestedScopes: config.scopesFor(provider, purpose), grantedScopes: config.scopesFor(provider, purpose),
    ...(provider === "google" ? { googleClientId: "fixture.apps.googleusercontent.com" } : {}) });
}
function reset(provider = "google") {
  Date.now = now;
  process.env.MORROW_GOOGLE_OAUTH_JSON = client("fixture");
  delete process.env.MORROW_GOOGLE_OAUTH_FILE;
  memory.setPassword = originalSet;
  for (const row of db.listAccountRows()) db.setAuthError(row.id, "fixture skipped");
  const id = `feature-${++serial}`;
  db.insertAccount({ id, email: `${id}@example.invalid`, username: `${id}@example.invalid`, profile: provider === "google" ? "gmail" : "outlook",
    authKind: "oauth2", createdAt: Date.now(), imapHost: "imap.example.invalid", imapPort: 993, imapTls: true,
    smtpHost: "smtp.example.invalid", smtpPort: 587, smtpTls: true });
  if (provider === "google") db.enableGmail(id);
  secrets.setPassword(id, grant(provider, "imap"));
  const key = `${id}:${provider === "google" ? "calendar" : "bundle"}`;
  secrets.setPassword(key, grant(provider, provider === "google" ? "calendar" : "bundle"));
  requests = []; renewals = [];
  renewal = () => reply({ access_token: "new", refresh_token: "refresh-new", expires_in: 3600 });
  api = (_url, init) => init.headers.authorization === "Bearer old" ? reply({}, 401) : reply(provider === "google" ? { items: [] } : { value: [] });
  global.fetch = async (url, init) => {
    if ([config.ENDPOINTS.google.token, config.ENDPOINTS.microsoft.token].includes(url)) {
      const body = new URLSearchParams(init.body);
      assert.ok(init.signal, "refresh has a deadline");
      assert.equal(body.get("grant_type"), "refresh_token");
      if (provider === "microsoft") {
        assert.ok(body.get("scope").includes("Calendars.ReadWrite"));
        assert.doesNotMatch(body.get("scope"), /outlook\.office\.com/);
      }
      renewals.push(body);
      return renewal(body);
    }
    assert.ok(String(url).startsWith("https://www.googleapis.com/calendar/") || String(url).startsWith("https://graph.microsoft.com/")
      || String(url).startsWith("https://gmail.googleapis.com/"), "only intercepted provider APIs are allowed");
    requests.push({ url: String(url), method: init.method, authorization: init.headers.authorization, bounded: !!init.signal });
    if (init.headers.authorization === "Bearer new") assert.ok([id, key].some(name => JSON.parse(secrets.getPassword(name) || "{}").accessToken === "new"), "renewed access must already be durable");
    return api(String(url), init);
  };
  return { account: db.accountById(id), key, provider };
}
const list = account => sidecar.answer("calendar:list", [{ accountId: account.id, ...range }]);
function uiAuth(code) {
  const ui = renderer({ document: { getElementById: () => null } });
  ui.context.fixtureCode = code;
  return ui.run("recordCalendarAuthFailure('fixture', { code: fixtureCode })");
}

async function features() {
  for (const provider of ["google", "microsoft"]) {
    let { account, key } = reset(provider);
    const result = await list(account);
    assert.equal(result.success, true, "401 GET must renew before asking for consent");
    assert.equal(renewals.length, 1); assert.equal(requests.length, 2);
    assert.ok(requests.every(item => item.bounded), "feature HTTP requests have deadlines");
    assert.equal(JSON.parse(secrets.getPassword(key)).refreshToken, "refresh-new");
    assert.equal(db.accountById(account.id).auth_error, null);

    ({ account, key } = reset(provider));
    renewal = () => reply({ access_token: "new", expires_in: 3600 });
    assert.equal((await list(account)).success, true);
    assert.equal(JSON.parse(secrets.getPassword(key)).refreshToken, "refresh-old", "an omitted refresh token preserves the saved one");

    ({ account, key } = reset(provider));
    const scopes = JSON.parse(secrets.getPassword(key)).grantedScopes.split(" ").filter(scope => !["email", "Mail.Send"].includes(scope)).join(" ");
    renewal = () => reply({ access_token: "new", refresh_token: "refresh-new", expires_in: 3600, scope: scopes });
    const normalized = await list(account);
    assert.equal(normalized.success, true);
    assert.equal(normalized.data.grantedScopes, scopes, "feature results report the actual renewed grant, not pre-refresh metadata");
    assert.equal(JSON.parse(secrets.getPassword(key)).grantedScopes, scopes);

    ({ account } = reset(provider)); api = () => reply({}, 401);
    const rejected = await list(account);
    assert.equal(rejected.error.code, "scope_missing");
    assert.equal(renewals.length, 1); assert.equal(requests.length, 2, "second rejection is final");
    assert.equal(uiAuth(rejected.error.code), true);

    // Two concurrent event-list reads and one late 401 share this operation's renewal.
    ({ account } = reset(provider));
    const late = deferred();
    api = async (url, init) => {
      if (!url.includes("/events") && !url.includes("/calendarView")) {
        return reply(provider === "google" ? { items: [{ id: "one", primary: true }, { id: "two" }] }
          : { value: [{ id: "one", isDefaultCalendar: true }, { id: "two" }] });
      }
      if (init.headers.authorization === "Bearer old") {
        if (url.includes("/two/")) await late.promise;
        return reply({}, 401);
      }
      return reply(provider === "google" ? { items: [] } : { value: [] });
    };
    renewal = () => { late.resolve(); return reply({ access_token: "new", refresh_token: "refresh-new", expires_in: 3600 }); };
    const parallel = await sidecar.answer("calendar:list", [{ accountId: account.id, ...range, calendarIds: ["one", "two"] }]);
    assert.equal(parallel.success, true);
    assert.equal(renewals.length, 1);
    assert.equal(requests.filter(item => item.authorization === "Bearer new").length, 2);
  }
  // Every page revalidates expiry, including a sleep between pages.
  const { account } = reset("google");
  const start = Date.now();
  api = url => {
    if (!url.includes("pageToken")) { Date.now = () => start + 3700000; return reply({ items: [], nextPageToken: "next" }); }
    return reply({ items: [] });
  };
  assert.equal((await list(account)).success, true);
  assert.deepEqual(requests.map(item => item.authorization), ["Bearer old", "Bearer new"]);
  assert.equal(renewals.length, 1);
  Date.now = now;
  // Graph folder discovery also accepts suppliers and retains its grant-hash
  // cache, without hashing or globally retaining an authorization closure.
  const folders = reset("microsoft");
  api = (url, init) => init.headers.authorization === "Bearer old" ? reply({}, 401)
    : new URL(url).searchParams.get("$select") === "id" ? reply({}, 404) : reply({ value: [{ id: "user-folder", displayName: "Synthetic" }] });
  assert.equal((await sidecar.answer("mail:listProviderFolders", [{ accountId: folders.account.id }])).success, true);
  const discovered = requests.length;
  assert.equal((await sidecar.answer("mail:listProviderFolders", [{ accountId: folders.account.id }])).success, true);
  assert.equal(requests.length, discovered + 1, "cached system folder IDs do not trigger discovery again");
  assert.equal(renewals.length, 1);
}

async function failures() {
  for (const provider of ["google", "microsoft"]) {
    for (const [status, payload, expected, retryable] of [[400, { error: "invalid_grant" }, "needs_auth", false],
      [503, {}, "provider", true], [200, {}, "provider", true], [401, { error: "invalid_client" }, "provider", false]]) {
      const { account, key } = reset(provider), before = secrets.getPassword(key);
      renewal = () => reply(payload, status);
      const result = await list(account);
      assert.equal(result.error.code, expected);
      assert.equal(result.error.retryable, retryable);
      assert.equal(requests.length, 1); assert.equal(secrets.getPassword(key), before);
    }
    const { account, key } = reset(provider), before = secrets.getPassword(key);
    memory.setPassword = () => { throw new Error("synthetic-private-storage-error"); };
    const result = await list(account);
    memory.setPassword = originalSet;
    assert.equal(result.error.code, "secure_storage_write");
    assert.equal(requests.length, 1); assert.equal(secrets.getPassword(key), before);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private/);
  }
}

async function quota() {
  for (const reason of ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded"]) {
    const { account } = reset(); const start = Date.now();
    api = () => reply({ error: { errors: [{ domain: "usageLimits", reason, message: "synthetic-private-body" }] } }, 403, { "retry-after": "2" });
    const result = await list(account);
    assert.equal(result.error.code, "rate_limit", `${reason} is quota, not missing consent`);
    assert.equal(result.error.retryAfterMs, 2000); assert.equal(result.error.status, 403);
    assert.equal(uiAuth(result.error.code), false);
    assert.doesNotMatch(JSON.stringify(result), /Grant access|synthetic-private/);
    assert.equal((await list(account)).error.code, "rate_limit");
    assert.equal(requests.length, 1, "repeated requests honor backoff without calling the provider");
    assert.equal(renewals.length, 0);
    Date.now = () => start + 3000; api = () => reply({ items: [] });
    assert.equal((await list(account)).success, true);
    assert.equal(requests.length, 2); Date.now = now;
  }
  for (const payload of [{}, { error: { errors: [{ reason: "forbiddenForNonOrganizer" }] } },
    { error: { errors: [{ reason: "rateLimitExceeded" }, { reason: "insufficientPermissions" }] } }]) {
    const { account } = reset(); api = () => reply(payload, 403);
    const result = await list(account);
    assert.equal(result.error.code, "provider"); assert.equal(uiAuth(result.error.code), false);
  }
  const { account } = reset(); api = () => reply({ error: { errors: [{ reason: "insufficientPermissions" }] } }, 403);
  assert.equal((await list(account)).error.code, "scope_missing", "recognized missing permission still offers consent");
  // Large/malformed errors cannot inject diagnostics or manufacture a quota reason.
  for (const body of ["not-json-private", JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }], message: "x".repeat(20000) } })]) {
    await assert.rejects(http.apiJson("https://www.googleapis.com/calendar/v3/users/me/calendarList", "synthetic", {
      fetchImpl: async () => new Response(body, { status: 403 }),
    }), error => error.code === "provider" && !/private|xxxx/.test(error.message) && !error.providerDetail);
  }
  for (const detail of [{ code: "InefficientFilter", message: "synthetic-private-description" },
    { code: "BadRequest", message: "This query is not supported; synthetic-private-description" }]) {
    await assert.rejects(require("../host/mail/provider-api").searchGraphFromPage("synthetic", "person@example.invalid", 10, "", async () => reply({ error: detail }, 400)),
      error => error.code === "filter_unsupported" && !error.providerDetail && !JSON.stringify(error).includes("synthetic-private"));
  }
}

async function configuration() {
  for (const fault of ["invalid", "missing-file"]) {
    const { account } = reset(); api = () => reply({ labels: [] });
    if (fault === "invalid") process.env.MORROW_GOOGLE_OAUTH_JSON = "{invalid";
    else process.env.MORROW_GOOGLE_OAUTH_FILE = path.join(dir, "missing-client.json");
    await assert.rejects(secretFor(account), { code: "oauth_not_ready" });
    await engine.syncAllForTest({ onlyInbox: true });
    assert.equal(db.accountById(account.id).auth_error, null, "a client configuration fault cannot latch a credential failure");
    process.env.MORROW_GOOGLE_OAUTH_JSON = client("fixture"); delete process.env.MORROW_GOOGLE_OAUTH_FILE;
    await engine.syncAllForTest({ onlyInbox: true });
    assert.ok(requests.length > 0, "the next normal poll recovers without consent or clearing auth errors");
    assert.equal(db.accountById(account.id).auth_error, null);
    assert.equal(renewals.length, 0);
  }
  const { account } = reset();
  process.env.MORROW_GOOGLE_OAUTH_JSON = client("changed");
  await assert.rejects(secretFor(account), { code: "google_client_changed" });
  process.env.MORROW_GOOGLE_OAUTH_JSON = client("fixture");
  const raw = JSON.parse(secrets.getPassword(account.id)); delete raw.googleClientId;
  secrets.setPassword(account.id, JSON.stringify(raw));
  await assert.rejects(secretFor(account), { code: "google_client_changed" });
}

async function writes() {
  for (const provider of ["google", "microsoft"]) {
    const { account } = reset(provider);
    api = () => reply({}, 401);
    const result = await sidecar.answer("calendar:createEvent", [{ accountId: account.id, calendarId: "one", title: "Synthetic event",
      start: "2026-11-05T10:00:00Z", end: "2026-11-05T11:00:00Z", allDay: false }]);
    assert.equal(result.success, false); assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST"); assert.equal(renewals.length, 0, "a rejected write is never replayed");
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    let submitted = 0, forced = 0;
    await assert.rejects(http.apiJson("https://graph.microsoft.com/v1.0/me/events", async options => {
      if (options.forceRefresh) forced++; return "synthetic";
    }, { method, fetchImpl: async () => { submitted++; return reply({}, 401); } }));
    assert.equal(submitted, 1); assert.equal(forced, 0);
  }
  // Renew only the prerequisite GET; the subsequent PATCH is issued once.
  const { account } = reset();
  api = (_url, init) => {
    if (init.method === "PATCH") return reply({}, 401);
    return init.headers.authorization === "Bearer old" ? reply({}, 401)
      : reply({ id: "event", description: "baseline", etag: '"version"' });
  };
  const patched = await sidecar.answer("calendar:updateEvent", [{ accountId: account.id, calendarId: "one", eventId: "event",
    description: "updated", descriptionBase: "baseline" }]);
  assert.equal(patched.success, false);
  assert.deepEqual(requests.map(item => item.method), ["GET", "GET", "PATCH"]);
  assert.equal(renewals.length, 1);

  // Vacation preflight reads may rotate the same token without looking like a
  // new consent during subsequent reads or the one reviewed write.
  const vacation = reset();
  const original = { enableAutoReply: true, responseSubject: "Synthetic", responseBodyPlainText: "Synthetic" };
  api = (_url, init) => init.headers.authorization === "Bearer old" ? reply({}, 401)
    : reply({ ...original, enableAutoReply: init.method === "PUT" ? false : true });
  const changed = await sidecar.answer("mail:vacationPut", [{ accountId: vacation.account.id,
    action: "disable", confirmed: true, revision: require("../host/mail/vacation-api").revisionOf(original) }]);
  assert.equal(changed.success, true);
  assert.equal(renewals.length, 1);
  assert.deepEqual(requests.map(item => item.method), ["GET", "GET", "GET", "PUT"]);

  // A connection change during response parsing retains known rejection versus
  // uncertain/acknowledged submission evidence without another provider write.
  for (const status of [200, 400, 401, 408, 503]) {
    let current = true, issued = 0;
    const authorization = async () => "synthetic";
    authorization.check = () => { if (!current) throw Object.assign(new Error("Synthetic connection changed"), { code: "conflict" }); };
    const fetchImpl = async () => {
      issued++;
      return { ok: status < 400, status, text: async () => { current = false; return "{}"; },
        body: { getReader: () => ({ read: async () => { current = false; return { done: true }; }, cancel: async () => {}, releaseLock() {} }) } };
    };
    await assert.rejects(http.apiJson("https://graph.microsoft.com/v1.0/me/events", authorization, { method: "POST", fetchImpl }),
      error => error.code === "conflict" && error.status === status && error.operationIssued === (status === 200 || status === 408 || status >= 500));
    assert.equal(issued, 1);
  }
}

async function races() {
  for (const provider of ["google", "microsoft"]) {
    for (const change of ["reconnect", "remove", "client", "transport", "login", "generation", "late-failure"]) {
      if (provider === "microsoft" && ["client", "generation"].includes(change)) continue;
      const { account, key } = reset(provider), started = deferred(), finish = deferred();
      renewal = async () => { started.resolve(); await finish.promise; return change === "late-failure"
        ? reply({ error: "invalid_grant" }, 400) : reply({ access_token: "stale", refresh_token: "refresh-stale", expires_in: 3600 }); };
      const pending = list(account); await started.promise;
      const replacement = grant(provider, provider === "google" ? "calendar" : "bundle", "replacement");
      if (change === "reconnect" || change === "late-failure") secrets.setPassword(key, replacement);
      if (change === "remove") await engine.answer("mail:removeAccount", [{ accountId: account.id }]);
      if (change === "client") process.env.MORROW_GOOGLE_OAUTH_JSON = client("changed");
      if (change === "transport") db.setMailTransport(account.id, provider === "google" ? "imap" : "gmail_api");
      if (change === "generation") { db.setMailTransport(account.id, "imap"); db.enableGmail(account.id); }
      if (change === "login") db.updateAccountLogin(account.id, { username: "replacement@example.invalid", profile: account.profile,
        authKind: "oauth2", imapHost: "imap.example.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.example.invalid", smtpPort: 587, smtpTls: true });
      finish.resolve();
      const result = await pending;
      assert.equal(result.error.code, "conflict"); assert.equal(requests.length, 1);
      if (change === "reconnect" || change === "late-failure") assert.equal(secrets.getPassword(key), replacement);
      if (change === "remove") assert.equal(secrets.getPassword(key), null);
    }
  }
  // Independent snapshots may conflict but never overwrite the winner's rotation.
  const { account, key } = reset("microsoft"), started = deferred(), finish = deferred();
  renewal = async () => { if (renewals.length === 2) started.resolve(); await finish.promise;
    return reply({ access_token: "new", refresh_token: "refresh-new", expires_in: 3600 }); };
  const pending = Promise.all([list(account), list(account)]); await started.promise; finish.resolve();
  const results = await pending;
  assert.equal(results.filter(result => result.success).length, 1);
  assert.equal(results.filter(result => result.error?.code === "conflict").length, 1);
  assert.equal(JSON.parse(secrets.getPassword(key)).refreshToken, "refresh-new");
  assert.equal(db.accountById(account.id).auth_error, null);
  // Retire even an already-rejected HTTP response when a newer login arrived.
  const next = reset(), entered = deferred(), release = deferred();
  api = async () => { entered.resolve(); await release.promise; return reply({}, 401); };
  const read = list(next.account); await entered.promise;
  secrets.setPassword(next.key, grant("google", "calendar", "replacement")); release.resolve();
  assert.equal((await read).error.code, "conflict"); assert.equal(renewals.length, 0);

  // Optional-folder 404 handling must not swallow a connection conflict when
  // the final parallel discovery responses arrive after a reconnect.
  const folders = reset("microsoft");
  secrets.setPassword(folders.key, grant("microsoft", "bundle", "discovery"));
  api = async url => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/mailFolders")) return reply({ value: [{ id: "user-folder", displayName: "Synthetic" }] });
    if (pathname.endsWith("/syncissues")) {
      secrets.setPassword(folders.key, grant("microsoft", "bundle", "replacement"));
    }
    return reply({}, 404);
  };
  const discovered = await sidecar.answer("mail:listProviderFolders", [{ accountId: folders.account.id }]);
  assert.ok(requests.some(item => item.url.includes("/syncissues")), "the race must reach actual system-folder discovery");
  assert.equal(discovered.error?.code, "conflict", "a logical connection change cannot become an optional missing folder");
}

async function help() {
  const { documentFor } = require("./check-chatgpt-ui");
  const document = documentFor(fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8"));
  const ui = renderer({ document, window: { morrowFeaturesCatalog: require("../renderer/features-catalog") } });
  ui.run("paintFeatureCatalog()");
  for (const text of [document.getElementById("features-catalog").textContent,
    document.getElementById("mail-oauth-renewal-help").textContent]) {
    assert.match(text, /Calendar and provider-feature reads can renew a rejected read once/);
    assert.match(text, /Calendar quota errors pause feature reads/);
    assert.match(text, /same client is restored/);
    assert.match(text, /writes are never replayed automatically/);
  }
}

(async () => {
  try {
    await engine.init();
    for (const [name, run] of Object.entries({ features, failures, quota, configuration, writes, races, help })) {
      if (!process.argv[2] || process.argv[2] === name) { await run(); console.log(`feature-oauth-${name}-ok`); }
    }
  } finally {
    Date.now = now; memory.setPassword = originalSet; global.fetch = originalFetch;
    process.env.MORROW_GOOGLE_OAUTH_JSON = client("fixture"); delete process.env.MORROW_GOOGLE_OAUTH_FILE;
    await engine.stopIdle(); await db.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
