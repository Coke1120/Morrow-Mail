"use strict";
// Real preload, renderer, host, OAuth callback and persistence with synthetic
// credentials only. All provider traffic is intercepted; sockets stay local.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const http = require("node:http");
const Module = require("node:module");
const root = path.join(__dirname, "..");
const req = Module.createRequire(path.join(root, "package.json"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr330-fixtures-"));
for (const key of ["MORROW_GOOGLE_OAUTH_FILE", "MORROW_GOOGLE_OAUTH_JSON", "GOOGLE_DESKTOP_OAUTH_JSON", "MORROW_ASAR"]) delete process.env[key];
Object.assign(process.env, { MORROW_USER_DATA: dir, MORROW_MAIL_DIR: dir,
  MORROW_AI_CONFIG_DIR: dir, MORROW_MAIL_SECRETS: "memory", ELECTRON_OVERRIDE_DIST_PATH: "/nonexistent" });
const net = require("node:net"), connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = first && typeof first === "object" ? first.host || "localhost" : typeof args[1] === "string" ? args[1] : "localhost";
  assert(["localhost", "127.0.0.1", "::1"].includes(host), "External socket forbidden: " + host);
  return connect.apply(this, args);
};
let picker = async () => ({ canceled: true, filePaths: [] });
let pickerCalls = 0;
const electron = { app: { isReady: () => false }, BrowserWindow: {
  fromWebContents: () => undefined, getFocusedWindow: () => undefined, getAllWindows: () => [],
}, dialog: { showOpenDialog: (...args) => { pickerCalls++; return picker(...args); } } };
const load = Module._load;
Module._load = function (name, ...args) { return name === "electron" ? electron : load.call(this, name, ...args); };
const config = req("./host/mail/oauth-config");
const oauth = req("./host/mail/oauth");
const engine = req("./host/mail/engine");
const db = req("./host/mail/db");
const memory = req("./host/mail/memory-secrets");
const remote = req("./host/mail/remote");
const sidecar = req("./host/mail/sidecar");
const json = id => JSON.stringify({ installed: { client_id: id + ".apps.googleusercontent.com", client_secret: "synthetic-only-" + id } });
const file = (name, contents) => { const p = path.join(dir, name); fs.writeFileSync(p, contents); return p; };
const fixtureA = file("client-a.json", json("fixture-a"));
const fixtureB = file("client-b.json", json("fixture-b"));
const readImported = () => fs.readFileSync(config.importedGoogleOauthPath(), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const source = name => fs.readFileSync(path.join(root, name), "utf8");
assert(!fs.existsSync(path.join(root, "resources/google-oauth.json")), "Use a clean worktree without real OAuth JSON");
let checks = 0;
function pass(text) { checks++; console.log("PASS " + text); }
function assertImportedClientFile(stat, platform = process.platform) {
  assert.equal(stat.isFile(), true, "the imported client must be a regular file");
  // Windows exposes read/write flags, not POSIX owner/group/other permissions.
  // These flags do not establish a Windows ACL privacy guarantee.
  // https://nodejs.org/docs/latest-v20.x/api/fs.html#fschmodpath-mode-callback
  if (platform === "win32") assert.equal(stat.mode & 0o600, 0o600, "the imported Windows file must be readable and writable");
  else assert.equal(stat.mode & 0o777, 0o600, "the imported POSIX file must remain owner-only");
}
function fileMetadataChecks() {
  const stat = (mode, regular = true) => ({ mode, isFile: () => regular });
  for (const platform of ["linux", "darwin"]) {
    assertImportedClientFile(stat(0o100600), platform);
    assert.throws(() => assertImportedClientFile(stat(0o100666), platform), { code: "ERR_ASSERTION" });
    assert.throws(() => assertImportedClientFile(stat(0o100400), platform), { code: "ERR_ASSERTION" });
  }
  assertImportedClientFile(stat(0o100666), "win32");
  assertImportedClientFile(stat(0o100600), "win32");
  assert.throws(() => assertImportedClientFile(stat(0o100444), "win32"), { code: "ERR_ASSERTION" });
  assert.throws(() => assertImportedClientFile(stat(0o100222), "win32"), { code: "ERR_ASSERTION" });
  for (const platform of ["linux", "darwin", "win32"]) {
    assert.throws(() => assertImportedClientFile(stat(0o600, false), platform), { code: "ERR_ASSERTION" });
  }
  pass("platform file metadata: POSIX 0600 remains mandatory; Windows 0666 uses supported read/write flags; directories are rejected");
}
const response = (value, ok = true) => ({ ok, status: ok ? 200 : 400,
  json: async () => value, text: async () => JSON.stringify(value) });
let activePurpose = "bundle", onOpen = null;
let omitScopes = false;
let tokenWait = null;
const pages = [], requests = [], opened = [];
const bindings = new Map();
const grantedByToken = new Map();
function saved(client, purpose) {
  const refreshToken = `synthetic-refresh-${client}-${purpose}`;
  const grantedScopes = config.scopesFor("google", purpose);
  bindings.set(refreshToken, client + ".apps.googleusercontent.com");
  grantedByToken.set(refreshToken, grantedScopes);
  return { provider: "google", purpose, googleClientId: client + ".apps.googleusercontent.com", refreshToken, accessToken: "synthetic-access", expiresAt: 1,
    grantedScopes, requestedScopes: grantedScopes };
}
function callback(url) {
  const auth = new URL(url), target = new URL(auth.searchParams.get("redirect_uri"));
  target.hostname = "127.0.0.1";
  target.searchParams.set("state", auth.searchParams.get("state"));
  target.searchParams.set("code", "synthetic-code");
  return new Promise((resolve, reject) => {
    http.get(target, res => { res.resume(); res.on("end", resolve); }).on("error", reject);
  });
}
global.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href === config.ENDPOINTS.google.token) {
    if (tokenWait) await tokenWait();
    const body = new URLSearchParams(init.body), grant = body.get("grant_type"), client = body.get("client_id");
    const token = body.get("refresh_token");
    requests.push({ grant, client, boundClient: bindings.get(token) || null });
    if (grant === "refresh_token" && bindings.get(token) !== client) return response({ error: "invalid_grant" }, false);
    const rt = grant === "authorization_code" ? `synthetic-refresh-${client}-${activePurpose}` : token;
    bindings.set(rt, client);
    const scope = grant === "authorization_code" ? config.scopesFor("google", activePurpose) : grantedByToken.get(rt);
    grantedByToken.set(rt, scope);
    return response({ access_token: "synthetic-access", refresh_token: rt, expires_in: 3600,
      scope: omitScopes ? "openid email" : scope });
  }
  if (href === "https://openidconnect.googleapis.com/v1/userinfo") return response({ email: "review@example.invalid" });
  if (href.startsWith("https://www.googleapis.com/calendar/v3/")) return response({ items: href.includes("calendarList") ? [{ id: "primary", primary: true, summary: "Fixture" }] : [] });
  if (href.startsWith("https://gmail.googleapis.com/")) {
    if (href.includes("/labels")) return response({ labels: [] });
    if (href.includes("/profile")) return response({ emailAddress: "review@example.invalid", historyId: "1" });
    if (href.includes("/messages")) return response({ messages: [] });
    if (href.includes("/history")) return response({ history: [], historyId: "1" });
  }
  throw new Error("Unmocked external request forbidden: " + href);
};
remote.withClient = async (account, token, work) => work({});
remote.listFolderRecords = async () => ({ folders: [], delimiter: "/" });
remote.verifySmtp = async () => {};
remote.openIdleClient = async () => { throw new Error("Offline fixture"); };
remote.searchUids = async () => ({ uids: [], validity: 1, exists: 0, unseen: 0 });
remote.fetchMessages = async () => ({ messages: [], validity: 1 });
const signIn = oauth.signIn;
oauth.signIn = (provider, purpose, options) => {
  activePurpose = purpose;
  return signIn(provider, purpose, { ...options, timeoutMs: 3000, fetchImpl: global.fetch,
    openBrowser: async url => { opened.push(new URL(url).searchParams.get("client_id"));
      if (onOpen) await onOpen();
      pages.push(callback(url));
    } });
};
async function importFile(p) {
  picker = async () => ({ canceled: false, filePaths: [p] });
  return engine.answer("mail:importGoogleOauth", []);
}
async function basic() {
  await engine.init();
  assert.deepEqual(config.googleOauthStatus(), { ready: false, source: "none", imported: false });
  const packagedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr330-packaged-"));
  process.resourcesPath = packagedDir;
  fs.writeFileSync(path.join(packagedDir, "google-oauth.json"), json("packaged"));
  assert.equal(config.loadGoogleClient().clientId, "packaged.apps.googleusercontent.com");
  const repoPath = path.join(root, "resources/google-oauth.json");
  assert(!fs.existsSync(repoPath), "Never read or replace an existing repository client");
  fs.mkdirSync(path.dirname(repoPath), { recursive: true });
  fs.writeFileSync(repoPath, json("repository"));
  try {
    assert.equal(config.loadGoogleClient().clientId, "repository.apps.googleusercontent.com");
    assert.equal((await importFile(fixtureA)).data.source, "imported");
    assert.equal(config.loadGoogleClient().clientId, "fixture-a.apps.googleusercontent.com");
    process.env.GOOGLE_DESKTOP_OAUTH_JSON = json("alias-env");
    assert.equal(config.loadGoogleClient().clientId, "alias-env.apps.googleusercontent.com");
    process.env.MORROW_GOOGLE_OAUTH_JSON = json("primary-env");
    assert.equal(config.loadGoogleClient().clientId, "primary-env.apps.googleusercontent.com");
    process.env.MORROW_GOOGLE_OAUTH_FILE = file("env.json", json("file-env"));
    assert.equal(config.loadGoogleClient().clientId, "file-env.apps.googleusercontent.com");
    assert.equal(config.googleOauthStatus().imported, true);
    await engine.answer("mail:clearGoogleOauth", []);
    assert.equal(config.loadGoogleClient().clientId, "file-env.apps.googleusercontent.com");
    assert.equal(config.googleOauthStatus().imported, false);
    for (const key of ["MORROW_GOOGLE_OAUTH_FILE", "MORROW_GOOGLE_OAUTH_JSON", "GOOGLE_DESKTOP_OAUTH_JSON"]) delete process.env[key];
    assert.equal(config.loadGoogleClient().clientId, "repository.apps.googleusercontent.com");
  } finally { fs.unlinkSync(repoPath); }
  assert.equal(config.loadGoogleClient().clientId, "packaged.apps.googleusercontent.com");
  await importFile(fixtureA);
  await engine.answer("mail:clearGoogleOauth", []);
  assert.equal(config.googleOauthStatus().source, "bundled");
  fs.unlinkSync(path.join(packagedDir, "google-oauth.json"));
  assert.equal(config.oauthReady().google, false);
  pass("environment file > primary JSON > alias JSON > userData > repository > packaged; clear preserves fallbacks");
  await importFile(fixtureA);
  const prior = readImported();
  for (const [name, content] of [["malformed", "{"], ["web", JSON.stringify({ web: { client_id: "x", client_secret: "synthetic" } })],
    ["bare", JSON.stringify({ client_id: "x.apps.googleusercontent.com", client_secret: "synthetic" })],
    ["array", "[]"], ["missing", '{"installed":{}}'], ["oversized", "x".repeat(65537)]]) {
    const result = await importFile(file(name + ".json", content));
    assert.equal(result.success, false, name);
    assert.equal(readImported(), prior, name);
    assert.equal(config.oauthReady().google, true);
  }
  picker = async () => ({ canceled: true, filePaths: [] });
  assert.equal((await engine.answer("mail:importGoogleOauth", [])).data.cancelled, true);
  assert.equal(readImported(), prior);
  picker = async () => { throw new Error("synthetic picker failure"); };
  assert.equal((await engine.answer("mail:importGoogleOauth", [])).success, false);
  assert.equal(readImported(), prior);
  const rename = fs.renameSync;
  fs.renameSync = (a, b) => { if (b === config.importedGoogleOauthPath()) throw new Error("synthetic disk failure"); return rename(a, b); };
  try { assert.equal((await importFile(fixtureB)).success, false); assert.equal(readImported(), prior); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readdirSync(dir).filter(x => x.endsWith(".tmp")).length, 0);
  assert.equal((await importFile(file("bom.json", "\ufeff" + json("fixture-a")))).success, true);
  assertImportedClientFile(fs.statSync(config.importedGoogleOauthPath()));
  assert(!JSON.stringify(config.googleOauthStatus()).includes("synthetic-only"));
  pass("native-picker handler with synthetic selection: BOM, cancel, malformed/Web/bare/array/missing/oversized, picker/write failure; prior file preserved; platform file metadata/status");
}
async function uiChecks() {
  const { JSDOM } = req("jsdom");
  const dom = new JSDOM(source("renderer/index.html"));
  const exposed = {}, calls = [];
  vm.runInNewContext(source("renderer/preload.js"), { require(name) {
    assert.equal(name, "electron");
    return { contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } }, ipcRenderer: {
      on() {}, removeListener() {}, send() {}, invoke: async (channel, payload) => {
        calls.push(channel); return engine.answer(channel, [payload]);
      } } };
  } });
  const { renderer } = req("./scripts/check-ux-workflows");
  const ui = renderer({ document: dom.window.document, window: { morrow: exposed.morrow,
    morrowFeaturesCatalog: req("./renderer/features-catalog"), addEventListener() {} },
    requestAnimationFrame: fn => setImmediate(fn) });
  const get = id => dom.window.document.getElementById(id);
  ui.run("wire()");
  await ui.run("loadGoogleOauthClient()");
  await ui.run("loadOauthStatus()");
  await tick();
  assert.equal(get("oauth-google").disabled, false);
  await ui.run('changeGoogleOauthClient("mail:clearGoogleOauth")');
  assert.equal(get("oauth-google").disabled, true);
  assert.match(get("google-oauth-client-status").textContent, /not ready/);
  const pending = defer();
  picker = () => pending.promise;
  const before = pickerCalls;
  const changing = ui.run('changeGoogleOauthClient("mail:importGoogleOauth")');
  assert.equal(get("google-oauth-import").disabled, true);
  assert.equal(get("google-oauth-clear").disabled, true);
  await ui.run('changeGoogleOauthClient("mail:importGoogleOauth")');
  assert.equal(pickerCalls, before + 1);
  assert.equal((await engine.answer("mail:clearGoogleOauth", [])).error.code, "conflict");
  assert.equal((await engine.answer("mail:addAccount", [{ provider: "google" }])).error.code, "conflict");
  assert.equal((await engine.answer("mail:importGoogleOauth", [])).error.code, "conflict");
  // A dismissed Settings surface does not abandon or duplicate the pending picker.
  get("settings").open = false;
  get("settings").open = true;
  pending.resolve({ canceled: false, filePaths: [fixtureA] });
  await changing;
  assert.equal(get("oauth-google").disabled, false);
  assert.equal(get("google-oauth-import").disabled, false);
  assert.equal(get("google-oauth-clear").disabled, false);
  picker = async () => ({ canceled: true, filePaths: [] });
  await ui.run('changeGoogleOauthClient("mail:importGoogleOauth")');
  assert.equal(get("oauth-google").disabled, false);
  picker = async () => ({ canceled: false, filePaths: [file("invalid-ui.json", "not-json")] });
  await ui.run('changeGoogleOauthClient("mail:importGoogleOauth")');
  assert.match(get("google-oauth-client-status").textContent, /valid JSON/);
  assert.equal(get("google-oauth-clear").disabled, false);
  assert.equal(config.loadGoogleClient().clientId, "fixture-a.apps.googleusercontent.com");
  ui.run("paintFeatureCatalog(); showFeaturesTab('catalog')");
  assert.match(get("features-catalog").textContent, /Google sign-in and optional personal client/);
  assert.match(get("features-catalog").textContent, /Environment|environment/);
  assert.match(get("features-catalog").textContent, /unknown client need one-time reauthorization/);
  assert.match(get("features-catalog").textContent, /Finish or cancel Google sign-in/);
  assert.match(get("features-catalog").textContent, /reconnecting Gmail also preserves a usable current-client Calendar grant/);
  assert.match(get("settings-google-calendar-preservation").textContent, /preserves a usable Calendar grant for the current Desktop client/);
  assert.match(get("google-oauth-client").textContent, /reauthorize Gmail and Google Calendar separately/);
  ui.run("showFeaturesTab('cli')");
  assert.match(get("cli-gmail-transport").textContent, /not a bot command/);
  await assert.rejects(exposed.morrow.invoke("mail:unknownGoogleOauth"), /Unsupported channel/);
  pass("actual preload -> renderer handlers -> host; readiness without restart; repeated/pending/cancelled/failed import; synthetic Features/CLI DOM");
  ui.run("state.oauthPending = true; gmailMigrationBusy = true; paintGoogleOauthClient()");
  assert.equal(get("google-oauth-import").disabled, true);
  assert.equal(get("google-oauth-clear").disabled, true);
  const beforeBusy = pickerCalls;
  await ui.run('changeGoogleOauthClient("mail:importGoogleOauth")');
  assert.equal(pickerCalls, beforeBusy);
  ui.run("state.oauthPending = false; gmailMigrationBusy = false; paintGoogleOauthClientButtons()");
  for (const key of ["MORROW_GOOGLE_OAUTH_JSON", "MORROW_GOOGLE_OAUTH_FILE"]) {
    process.env[key] = key.endsWith("FILE") ? path.join(dir, "missing-env-file.json") : "invalid-env";
    await ui.run("loadGoogleOauthClient()");
    assert.equal(config.googleOauthStatus().invalidSource, "env");
    assert.match(get("google-oauth-client-status").textContent, /environment override/);
    assert.doesNotMatch(get("google-oauth-client-status").textContent, /imported.*could not be read/);
    assert.equal(readImported().includes("fixture-a.apps.googleusercontent.com"), true);
    delete process.env[key];
  }
  fs.writeFileSync(config.importedGoogleOauthPath(), "invalid-import");
  await ui.run("loadGoogleOauthClient()");
  assert.equal(config.googleOauthStatus().invalidSource, "imported");
  assert.match(get("google-oauth-client-status").textContent, /imported.*could not be read/);
  await importFile(fixtureA);
  assert.equal(ui.run('showOrganizeGrant("google_client_changed")'), true);
  assert.match(ui.run('calendarCopy("google_client_changed")'), /Enable Google Calendar/);
  assert.match(ui.run('providerCopy("google_client_changed", "gmail")'), /Reauthorize Gmail/);
  // Exercise the actual Settings capability summary with an unknown old grant.
  seed("settings-google", "settings@example.invalid");
  const unbound = saved("fixture-a", "bundle"); delete unbound.googleClientId;
  memory.setPassword("settings-google", JSON.stringify(unbound));
  ui.run("state.accounts = [{id:'settings-google',email:'settings@example.invalid',profile:'gmail',authKind:'oauth2'}]; state.settingsAccountId = 'settings-google'");
  await ui.run("loadSettingsCapabilities()");
  assert.match(get("settings-capabilities").textContent, /Mail: Reconnect needed/);
  assert.match(get("settings-capabilities").textContent, /Calendar: Permission granted/);
  const unboundCalendar = saved("fixture-a", "calendar"); delete unboundCalendar.googleClientId;
  memory.setPassword("settings-google:calendar", JSON.stringify(unboundCalendar));
  await ui.run("loadSettingsCapabilities()");
  assert.match(get("settings-capabilities").textContent, /Calendar: Additional consent needed/);
  db.removeAccount("settings-google");
  memory.deletePassword("settings-google"); memory.deletePassword("settings-google:calendar");
  pass("OAuth busy controls and environment-file/JSON diagnostics identify the actual failing source");
  dom.window.close();
}
function seed(id = "review-google", email = "review@example.invalid") {
  db.insertAccount({ id, email, username: email, profile: "gmail", authKind: "oauth2",
    createdAt: 1, imapHost: "imap.example.invalid", imapPort: 993, imapTls: true,
    smtpHost: "smtp.example.invalid", smtpPort: 465, smtpTls: true });
  db.enableGmail(id);
  memory.setPassword(id, JSON.stringify(saved("fixture-a", "bundle")));
  memory.setPassword(id + ":calendar", JSON.stringify(saved("fixture-a", "calendar")));
  return id;
}
async function calendarPreservation() {
  for (const kind of ["vacation", "primary", "shared"]) {
    const id = seed("preserve-" + kind);
    try {
      const usable = saved("fixture-a", kind === "vacation" ? "calendar" : "bundle");
      if (kind !== "vacation") {
        usable.grantedScopes += " " + config.CALENDAR_SCOPES.google;
        usable.requestedScopes = usable.grantedScopes;
        grantedByToken.set(usable.refreshToken, usable.grantedScopes);
      }
      const expected = JSON.stringify(usable);
      if (kind === "vacation") {
        memory.setPassword(id, JSON.stringify(saved("fixture-a", "organize")));
        const stale = { ...saved("fixture-a", "bundle"), grantedScopes: config.BUNDLE_SCOPES.google + " " + config.CALENDAR_SCOPES.google };
        delete stale.googleClientId;
        memory.setPassword(id + ":bundle", JSON.stringify(stale));
        memory.setPassword(id + ":calendar", expected);
        assert.equal(sidecar.gateAccount(db.accountById(id), "vacation").ok, false);
      } else {
        const stale = saved("fixture-b", "calendar");
        if (kind === "primary") delete stale.googleClientId;
        memory.setPassword(id + ":calendar", JSON.stringify(stale));
        memory.setPassword(kind === "primary" ? id : id + ":bundle", expected);
      }
      assert.equal(sidecar.gateAccount(db.accountById(id), "calendar").ok, true, "current-client read fallback is usable before the write");
      const result = await engine.answer(kind === "vacation" ? "mail:grantVacation" : kind === "primary" ? "mail:addAccount" : "mail:migrateGmail",
        [kind === "vacation" ? { accountId: id } : kind === "primary" ? { provider: "google", expectedAccountId: id } : { accountId: id, confirmed: true }]);
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(memory.getPassword(id + ":calendar"), expected, kind + " must retain the exact usable Calendar grant without merging scope/issuer metadata");
      assert.equal(sidecar.gateAccount(db.accountById(id), "calendar").ok, true);
      const listed = await engine.answer("calendar:list", [{ accountId: id, timeMin: "2026-10-01T00:00:00Z", timeMax: "2026-11-01T00:00:00Z" }]);
      assert.equal(listed.success, true, JSON.stringify(listed));
      assert.equal(listed.data.api, true);
      pass(kind === "vacation" ? "Out of Office enablement cannot replace a current Calendar grant with an identityless shared bundle"
        : kind === "primary" ? "Gmail reconnect preserves a current-client primary Calendar fallback instead of an identityless Calendar slot"
          : "reviewed Gmail reauthorization preserves a current-client shared Calendar fallback instead of a different-client Calendar slot");
    } finally {
      db.removeAccount(id);
      for (const suffix of ["", ":calendar", ":bundle", ":organize", ":rules", ":vacation"]) memory.deletePassword(id + suffix);
    }
  }
}
async function integration() {
  const id = seed();
  const waiting = defer(); picker = () => waiting.promise;
  const picking = engine.answer("mail:importGoogleOauth", []);
  assert.equal((await engine.answer("calendar:connect", [{ accountId: id }])).error.code, "conflict");
  waiting.resolve({ canceled: true, filePaths: [] });
  assert.equal((await picking).data.cancelled, true);
  const sameClient = await engine.answer("calendar:list", [{ accountId: id, timeMin: "2026-10-01T00:00:00Z", timeMax: "2026-11-01T00:00:00Z" }]);
  assert.equal(sameClient.success, true, JSON.stringify(sameClient));
  assert.equal(sameClient.data.api, true);
  memory.setPassword(id + ":calendar", JSON.stringify(saved("fixture-a", "calendar")));
  pass("same-client control: existing expired Calendar token refreshes and lists successfully");
  const oldCalendar = memory.getPassword(id + ":calendar");
  await importFile(fixtureB);
  const reconnect = await engine.answer("mail:addAccount", [{ provider: "google", expectedAccountId: id }]);
  assert.equal(reconnect.success, true, JSON.stringify(reconnect));
  assert.equal(memory.getPassword(id + ":calendar"), oldCalendar);
  const status = (await engine.answer("mail:oauthStatus", [])).data.accounts.find(row => row.id === id);
  assert.equal(status.calendar, false);
  assert.equal(status.calendarReason, "google_client_changed");
  assert.equal(status.mailClientMatches, true);
  const popupsBefore = opened.length;
  const beforeFailed = memory.getPassword(id + ":calendar");
  omitScopes = true;
  const partial = await engine.answer("calendar:connect", [{ accountId: id }]);
  omitScopes = false;
  assert.equal(partial.success, false);
  assert.equal(memory.getPassword(id + ":calendar"), beforeFailed);
  assert.equal(sidecar.gateAccount(db.accountById(id), "calendar").ok, false);
  const enable = await engine.answer("calendar:connect", [{ accountId: id }]);
  assert.equal(enable.success, true); assert.equal(enable.data.api, true);
  assert.equal(opened.length, popupsBefore + 2);
  assert.equal(JSON.parse(memory.getPassword(id + ":calendar")).googleClientId, "fixture-b.apps.googleusercontent.com");
  const listed = await engine.answer("calendar:list", [{ accountId: id, timeMin: "2026-10-01T00:00:00Z", timeMax: "2026-11-01T00:00:00Z" }]);
  assert.equal(listed.success, true);
  assert.equal(sidecar.gateAccount(db.accountById(id), "calendar").ok, true);
  const noMorePopups = opened.length;
  await engine.answer("calendar:connect", [{ accountId: id }]);
  assert.equal(opened.length, noMorePopups);
  pass("client switch preserves Calendar credential but marks it disconnected; partial consent preserves it; ordinary enable reauthorizes and then reuses the bound grant");
  // Reachable from Settings: Google reauthorization pending, import a new JSON, return from browser.
  await importFile(fixtureA);
  const keepA = readImported();
  onOpen = async () => {
    assert.equal((await importFile(fixtureB)).error.code, "conflict");
    assert.equal((await engine.answer("mail:clearGoogleOauth", [])).error.code, "conflict");
    assert.equal(readImported(), keepA);
  };
  const raced = await engine.answer("mail:migrateGmail", [{ accountId: id, confirmed: true }]);
  assert.equal(raced.success, true, JSON.stringify(raced));
  const blob = JSON.parse(memory.getPassword(id));
  const grantClient = bindings.get(blob.refreshToken);
  const activeClient = config.loadGoogleClient().clientId;
  assert.equal(grantClient, activeClient);
  assert.equal(blob.googleClientId, activeClient);
  blob.expiresAt = 1; memory.setPassword(id, JSON.stringify(blob));
  assert.equal((await oauth.accessTokenFor(db.accountById(id), memory.getPassword(id))).token, "synthetic-access");
  // The Calendar/sidecar flow holds the same lease through its own commit.
  await engine.answer("calendar:connect", [{ accountId: id, forceReauthorize: true }]);
  onOpen = null;
  pass("mail and Calendar pending OAuth reject import/clear and save only grants for the unchanged client");
  // An external override can bypass the picker lock; both commit paths must
  // still reject its obsolete result without replacing the previous credential.
  for (const channel of ["mail:migrateGmail", "calendar:connect"]) {
    const key = channel === "mail:migrateGmail" ? id : id + ":calendar";
    const previous = memory.getPassword(key);
    onOpen = async () => { process.env.MORROW_GOOGLE_OAUTH_JSON = json("fixture-b"); };
    const result = await engine.answer(channel, [{ accountId: id, confirmed: true, forceReauthorize: true }]);
    onOpen = null;
    delete process.env.MORROW_GOOGLE_OAUTH_JSON;
    assert.equal(result.success, false);
    assert.equal(result.error.code, "google_client_changed");
    assert.equal(memory.getPassword(key), previous);
  }
  pass("external client changes during mail/Calendar OAuth cannot commit obsolete credentials");
  // Unbound or mismatched tokens must not be used even when access is fresh.
  for (const client of [undefined, "fixture-b.apps.googleusercontent.com"]) {
    for (const expiresAt of [1, Date.now() + 3600000]) {
      const priorCount = requests.length;
      const old = { ...saved("fixture-a", "calendar"), expiresAt, googleClientId: client };
      memory.setPassword(id + ":calendar", JSON.stringify(old));
      assert.equal(sidecar.gateAccount(db.accountById(id), "calendar").ok, false);
      await assert.rejects(oauth.accessTokenFor(db.accountById(id), JSON.stringify(old)), e => e.code === "google_client_changed");
      assert.equal(requests.length, priorCount);
    }
  }
  await engine.answer("calendar:connect", [{ accountId: id }]);
  assert.equal(sidecar.gateAccount(db.accountById(id), "calendar").ok, true);
  // A stale preferred Calendar slot cannot hide a valid fallback grant.
  const good = memory.getPassword(id + ":calendar");
  memory.setPassword(id + ":bundle", good);
  memory.setPassword(id + ":calendar", JSON.stringify(saved("fixture-b", "calendar")));
  assert.equal(sidecar.gateAccount(db.accountById(id), "calendar").ok, true);
  memory.deletePassword(id + ":bundle");
  memory.setPassword(id + ":calendar", good);
  pass("unknown/mismatched grants block cached access and refresh without network; ordinary reauthorization recovers; a matching fallback remains usable");
  // Clearing to B makes A's grants disconnected immediately, without deleting
  // any saved token or mailbox. Switching back to A makes the same grant usable.
  fs.writeFileSync(path.join(process.resourcesPath, "google-oauth.json"), json("fixture-b"));
  const primary = memory.getPassword(id);
  await engine.answer("mail:clearGoogleOauth", []);
  assert.equal(config.googleOauthStatus().source, "bundled");
  assert.equal(memory.getPassword(id), primary);
  assert.equal((await engine.answer("mail:oauthStatus", [])).data.accounts.find(row => row.id === id).mailClientMatches, false);
  await assert.rejects(oauth.accessTokenFor(db.accountById(id), primary), e => e.code === "google_client_changed");
  await importFile(fixtureA);
  assert.equal(config.googleGrantMatches(JSON.parse(primary)), true);
  pass("clear to another bundled client reports reconnect immediately; saved tokens remain and switching back restores their binding");
  // A client change during an actual token refresh must discard its late result.
  tokenWait = async () => { process.env.MORROW_GOOGLE_OAUTH_JSON = json("fixture-b"); };
  await assert.rejects(oauth.accessTokenFor(db.accountById(id), JSON.stringify(saved("fixture-a", "bundle"))), e => e.code === "google_client_changed");
  tokenWait = null;
  delete process.env.MORROW_GOOGLE_OAUTH_JSON;
  // Cancel while exchange is waiting. The lease lasts until the aborted host
  // operation settles, so a late provider response cannot follow a client edit.
  const started = defer(), held = defer();
  tokenWait = async () => { started.resolve(); await held.promise; };
  const cancelling = engine.answer("mail:migrateGmail", [{ accountId: id, confirmed: true }]);
  await started.promise;
  await engine.answer("mail:cancelOAuth", []);
  assert.equal((await importFile(fixtureB)).error.code, "conflict");
  held.resolve();
  assert.equal((await cancelling).success, false);
  tokenWait = null;
  assert.equal((await importFile(fixtureB)).success, true);
  pass("late refresh is rejected after a client change; cancelling an exchange retains the lease until settlement and then permits retry");
  // Prove the persisted identity is enforced again in an independent process.
  const restart = { ...saved("fixture-b", "calendar"), expiresAt: Date.now() + 3600000 };
  file("restart-grant.json", JSON.stringify(restart));
  const child = require("node:child_process").spawnSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
    global.fetch = () => { throw Error('Network forbidden'); };
    process.resourcesPath = ${JSON.stringify(process.resourcesPath)};
    const oauth = require('./host/mail/oauth'), config = require('./host/mail/oauth-config');
    const raw = fs.readFileSync(path.join(process.env.MORROW_USER_DATA, 'restart-grant.json'), 'utf8');
    (async () => {
      assert.equal(config.googleGrantMatches(JSON.parse(raw)), true);
      assert.equal(await oauth.accessTokenFor({profile:'gmail'}, raw), 'synthetic-access');
      config.clearImportedGoogleDesktopJson();
      assert.equal(config.googleGrantMatches(JSON.parse(raw)), true);
      config.importGoogleDesktopJson(${JSON.stringify(json("fixture-a"))});
      await assert.rejects(oauth.accessTokenFor({profile:'gmail'}, raw), e => e.code === 'google_client_changed');
    })().catch(e => { console.error(e); process.exitCode = 1; });
  `], { cwd: root, env: process.env, encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  pass("persisted client binding survives a process restart and follows later effective-client changes");
  await Promise.all(pages);
}
(async () => {
  try { fileMetadataChecks(); await basic(); await uiChecks(); await calendarPreservation(); await integration(); }
  finally { await new Promise(resolve => setTimeout(resolve, 100)); engine.stopIdle(); await db.close(); }
  console.log("google-client-switching-ok: " + checks + " fixture groups; provider I/O mocked; local loopback only; no native/live validation");
})().catch(error => { console.error(error); process.exitCode = 1; });
