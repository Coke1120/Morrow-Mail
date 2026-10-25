// Synthetic SIWC issuer and Responses transport only. No real provider login,
// OAuth grant, registration, model request, mail, browser or keychain operation.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { createAuth, ISSUER, RESOURCE, SCOPES } = require("../host/chatgpt-auth");
const { createResponses } = require("../host/chatgpt-responses");
const { createStore } = require("../host/chatgpt-store");
const keyMaterial = import("jose").then(async jose => {
  const pair = await jose.generateKeyPair("RS256");
  return { ...jose, ...pair, jwk: { ...await jose.exportJWK(pair.publicKey), kid: "synthetic-key", alg: "RS256", use: "sig" } };
});
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "x-request-id": "synthetic-request" } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, options = {}) {
  const keys = await keyMaterial;
  let clock = Date.now();
  let record = { hostId: "", activeId: "", registrations: [] };
  const calls = [];
  const urls = [];
  const control = { subject: "synthetic-subject", scope: SCOPES, overrides: {}, accessOverrides: {}, refreshCount: 0, codeCount: 0 };
  const store = { available: () => true, read: () => structuredClone(record), write: next => { if (control.storeFail) throw new Error("synthetic storage failure"); record = structuredClone(next); } };
  async function jwt(claims, override = {}) {
    return new keys.SignJWT({ iat: Math.floor(clock / 1000), exp: Math.floor(clock / 1000) + 3600, ...claims, ...override })
      .setProtectedHeader({ alg: "RS256", kid: control.kid || "synthetic-key" }).sign(keys.privateKey);
  }
  const fetcher = async (url, input = {}) => {
    calls.push({ url, input });
    assert.equal(input.redirect, "error", "never forward a token through redirects");
    if (url === `${ISSUER}/.well-known/openid-configuration`) return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/api/accounts/authorize`, token_endpoint: `${ISSUER}/api/accounts/oauth/token`, jwks_uri: `${ISSUER}/.well-known/jwks.json`, revocation_endpoint: `${ISSUER}/oauth/revoke`, ...control.metadata });
    if (url === `${ISSUER}/.well-known/jwks.json`) return json({ keys: [{ ...keys.jwk, kid: control.kid || "synthetic-key" }] });
    if (url === `${ISSUER}/oauth/revoke`) {
      control.revoked = new URLSearchParams(input.body).get("token");
      if (control.revokeFail) throw new Error("synthetic network failure");
      return new Response(null, { status: control.revokeStatus || 200 });
    }
    assert.equal(url, `${ISSUER}/api/accounts/oauth/token`, "mock issuer denies every unexpected URL");
    const form = new URLSearchParams(input.body);
    const requestNonce = urls.at(-1).searchParams.get("nonce");
    assert.equal(form.get("resource"), RESOURCE);
    assert.equal(form.has("client_secret"), false);
    assert.notEqual(form.get("client_id"), "dynamic_agent_client");
    const refresh = form.get("grant_type") === "refresh_token";
    if (refresh) {
      control.refreshCount++;
      assert.equal(form.has("scope"), false, "refresh never expands the grant");
    } else {
      control.codeCount++;
      const original = urls.at(-1).searchParams;
      assert.equal(form.get("redirect_uri"), original.get("redirect_uri"));
      assert.equal(crypto.createHash("sha256").update(form.get("code_verifier")).digest("base64url"), original.get("code_challenge"));
    }
    if (control.tokenEntered) control.tokenEntered.resolve();
    if (control.tokenWait) await control.tokenWait.promise;
    if (control.tokenTransportFail) throw new Error("synthetic token response lost");
    if (control.tokenError) return json({ error: control.tokenError }, 400);
    const clientId = form.get("client_id");
    const nonce = requestNonce;
    let id = await jwt({ iss: ISSUER, aud: clientId, sub: control.subject, email: "synthetic@example.invalid", nonce }, control.overrides);
    if (control.badSignature) id = id.slice(0, -10) + "AAAAAAAAAA";
    return json({
      token_type: "Bearer", access_token: await jwt({ iss: ISSUER, aud: RESOURCE, sub: control.subject, client_id: clientId, scope: control.scope }, control.accessOverrides),
      refresh_token: refresh ? `rotated-${control.refreshCount}` : "synthetic-refresh", id_token: id,
      scope: control.scope, expires_in: 3600, ...control.tokenResponse,
    });
  };
  const auth = createAuth({ store, fetcher, now: () => clock, loginTimeout: options.loginTimeout || 600000,
    openBrowser: async url => { urls.push(new URL(url)); if (control.browserFail) throw new Error("synthetic browser failure"); } });
  t.after(() => auth.dispose());
  const url = (params = {}) => {
    const original = urls.at(-1).searchParams;
    const callback = new URL(original.get("redirect_uri"));
    callback.search = new URLSearchParams({ state: original.get("state"), code: "synthetic-code", client_id: original.get("client_id") === "dynamic_agent_client" ? "oaiapp_synthetic" : original.get("client_id"), ...params }).toString();
    return callback.toString();
  };
  const login = async (input, params) => { await auth.start(input); return auth.callback(url(params)); };
  return { auth, control, calls, urls, url, login, store, fetcher, record: () => structuredClone(record), advance: ms => { clock += ms; }, set: change => { record = change(structuredClone(record)); } };
}

test("official dynamic registration, automatic callback, PKCE, identity and safe public status", async t => {
  const f = await fixture(t);
  await f.auth.start();
  const authorize = f.urls.at(-1);
  assert.equal(authorize.origin + authorize.pathname, `${ISSUER}/api/accounts/authorize`);
  assert.equal(authorize.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(authorize.searchParams.get("agent_name_hint"), "Morrow Mail");
  assert.equal(authorize.searchParams.get("scope"), SCOPES);
  assert.match(authorize.searchParams.get("ext_agent_host_id"), /^urn:uuid:/);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  const host = f.record().hostId;
  const page = await new Promise((resolve, reject) => {
    http.get(f.url(), res => { let body = ""; res.on("data", piece => { body += piece; }); res.on("end", () => resolve(body)); }).on("error", reject);
  });
  assert.match(page, /Return to Morrow Mail/);
  for (let turn = 0; turn < 100 && f.auth.status().pending; turn++) await new Promise(done => setTimeout(done, 5));
  assert.equal(f.auth.status().connected, true);
  assert.equal(f.auth.status().planEnabled, true);
  assert.equal(f.auth.status().backgroundConsent, false);
  assert.equal(f.auth.status().welcome, true);
  const publicText = JSON.stringify(f.auth.status());
  for (const secret of ["accessToken", "refreshToken", "idToken", "synthetic-refresh", authorize.searchParams.get("state"), authorize.searchParams.get("nonce")]) assert.equal(publicText.includes(secret), false);
  const accountId = f.auth.status().activeId;
  await f.auth.start({ accountId });
  assert.equal(f.record().hostId, host);
  assert.equal(f.urls.at(-1).searchParams.get("client_id"), "oaiapp_synthetic");
  assert.equal(f.urls.at(-1).searchParams.has("agent_name_hint"), false);
  assert.ok(f.urls.at(-1).searchParams.get("id_token_hint"));
  assert.notEqual(f.urls.at(-1).searchParams.get("state"), authorize.searchParams.get("state"));
  const callback = new URL(f.url()); callback.searchParams.delete("client_id");
  await f.auth.callback(callback.toString());
  assert.equal(f.record().registrations.length, 1);
  f.auth.preferences({ welcomeSeen: true });
  assert.equal(f.auth.status().welcome, false);
});

test("cancelled, repeated, expired, stale, duplicate and hostile callback attempts do not exchange", async t => {
  const f = await fixture(t);
  await f.auth.start(); const first = f.url();
  f.auth.cancel();
  await assert.rejects(f.auth.callback(first), /stale|expired/);
  await f.auth.start();
  await assert.rejects(f.auth.callback(first), /address|state/);
  assert.equal(f.control.codeCount, 0);
  await assert.rejects(f.auth.callback(f.url({ state: "wrong" })), /state/);
  await assert.rejects(f.auth.callback(f.url().replace("127.0.0.1", "localhost")), /address/);
  await assert.rejects(f.auth.callback(f.url() + "&state=duplicate"), /duplicate/);
  await assert.rejects(f.auth.callback(f.url({ error: "access_denied" })), /declined/);
  assert.equal(f.auth.status().phase, "failed");
  assert.equal(f.control.codeCount, 0);
  await f.auth.start();
  f.advance(600001);
  await assert.rejects(f.auth.callback(f.url()), /expired/);
  assert.equal(f.control.codeCount, 0);
  await f.auth.start(); const accepted = f.url();
  await f.auth.callback(accepted);
  await assert.rejects(f.auth.callback(accepted), /stale/);
  assert.equal(f.control.codeCount, 1);
});

test("real timer timeout and browser launch failure allow fresh retry", async t => {
  const f = await fixture(t, { loginTimeout: 15 });
  await f.auth.start();
  await new Promise(done => setTimeout(done, 25));
  assert.equal(f.auth.status().pending, false);
  assert.match(f.auth.status().message, /timed out/);
  f.control.browserFail = true;
  await assert.rejects(f.auth.start(), /could not start/);
  f.control.browserFail = false;
  await f.auth.start();
  assert.equal(f.auth.status().pending, true);
});

test("signature, issuer, audience, expiry, nonce, client and subject checks reject invalid credentials", async t => {
  for (const change of [
    { overrides: { iss: "https://wrong.invalid" } }, { overrides: { aud: "oaiapp_other" } },
    { overrides: { exp: 1 } }, { overrides: { nonce: "wrong" } }, { overrides: { iat: 9999999999 } },
    { badSignature: true }, { accessOverrides: { aud: "https://wrong.invalid" } },
    { accessOverrides: { client_id: "oaiapp_other" } }, { accessOverrides: { sub: "other" } },
    { accessOverrides: { scope: "openid" } }, { tokenResponse: { id_token: "" } },
  ]) {
    const f = await fixture(t); Object.assign(f.control, change);
    await assert.rejects(f.login(), /verified|match|required/);
    assert.equal(f.record().registrations.length, 0);
  }
  const f = await fixture(t);
  await f.login(); const before = f.record().registrations[0];
  f.control.subject = "different-subject";
  await assert.rejects(f.login({ accountId: before.id }), /different account/);
  assert.equal(f.record().registrations[0].accessToken, before.accessToken);
  f.control.subject = before.subject;
  await f.auth.start({ accountId: before.id });
  await assert.rejects(f.auth.callback(f.url({ client_id: "oaiapp_other" })), /different client/);
  assert.equal(f.record().registrations[0].accessToken, before.accessToken);
});

test("discovery is pinned, unknown keys refresh, and incomplete registration retries issued client", async t => {
  const bad = await fixture(t);
  bad.control.metadata = { jwks_uri: "https://wrong.invalid/jwks" };
  await assert.rejects(bad.auth.start(), /could not start/);
  assert.equal(bad.urls.length, 0);
  const f = await fixture(t);
  await f.auth.start();
  await assert.rejects(f.auth.callback(f.url({ client_id: "" })), /incomplete/);
  f.control.tokenError = "invalid_grant";
  await assert.rejects(f.login(), /invalid_grant/);
  f.control.tokenError = null;
  await f.auth.start();
  assert.equal(f.urls.at(-1).searchParams.get("client_id"), "oaiapp_synthetic");
  await f.auth.callback(f.url());
  f.control.kid = "new-synthetic-key";
  f.advance(3570000);
  const lease = await f.auth.lease(); lease.release();
  assert.equal(f.calls.filter(call => call.url.endsWith("jwks.json")).length, 2);
});

test("identity-only grants remain connected and cannot infer; explicit reconsent enables plan usage", async t => {
  const f = await fixture(t);
  f.control.scope = "openid profile email offline_access";
  await f.login();
  assert.equal(f.auth.status().connected, true);
  assert.equal(f.auth.status().planEnabled, false);
  await assert.rejects(f.auth.lease(), /plan usage is disabled/);
  const id = f.auth.status().activeId;
  f.control.scope = SCOPES;
  await f.auth.start({ accountId: id, enablePlan: true });
  assert.equal(f.urls.at(-1).searchParams.get("prompt"), "consent");
  await f.auth.callback(f.url());
  assert.equal(f.auth.status().planEnabled, true);
  const identityOnly = await fixture(t);
  identityOnly.control.scope = "openid profile email";
  identityOnly.control.tokenResponse = { access_token: undefined, refresh_token: undefined, expires_in: undefined, token_type: undefined };
  await identityOnly.login();
  assert.equal(identityOnly.auth.status().connected, true);
  assert.equal(identityOnly.auth.status().planEnabled, false);
  await assert.rejects(identityOnly.auth.lease(), /plan usage is disabled/);
});

test("account registrations with matching email stay separate; explicit select and reauth preserve identities", async t => {
  const f = await fixture(t);
  await f.login(); const first = f.auth.status().activeId;
  f.auth.preferences({ backgroundConsent: true });
  await f.login(undefined, { client_id: "oaiapp_workspace_two" });
  assert.equal(f.record().registrations.length, 2);
  assert.notEqual(f.auth.status().activeId, first);
  assert.equal(f.auth.status().backgroundConsent, false);
  f.auth.select(first);
  assert.equal(f.auth.status().backgroundConsent, true);
  await f.auth.signOut(first);
  await assert.rejects(f.auth.lease(), /Continue with ChatGPT/);
  await f.auth.start({ accountId: first });
  assert.equal(f.urls.at(-1).searchParams.get("client_id"), "oaiapp_synthetic");
  assert.equal(f.urls.at(-1).searchParams.has("id_token_hint"), false);
  await f.auth.callback(f.url());
  assert.equal(f.auth.status().backgroundConsent, false);
});

test("refresh single-flight, rotation and terminal versus temporary failures", async t => {
  const f = await fixture(t); await f.login(); f.advance(3570000);
  const leases = await Promise.all([f.auth.lease(), f.auth.lease(), f.auth.lease()]);
  assert.equal(f.control.refreshCount, 1);
  assert.equal(f.record().registrations[0].refreshToken, "rotated-1");
  for (const lease of leases) lease.release();
  f.advance(3570000); f.control.tokenError = "temporarily_unavailable";
  const saved = f.record().registrations[0].refreshToken;
  await assert.rejects(f.auth.lease(), /temporarily_unavailable/);
  assert.equal(f.record().registrations[0].refreshToken, saved);
  f.control.tokenError = "refresh_token_reused";
  await assert.rejects(f.auth.lease(), /refresh_token_reused/);
  assert.equal(f.auth.status().connected, false);
  assert.equal(f.record().registrations[0].clientId, "oaiapp_synthetic");
  assert.equal(f.record().registrations[0].refreshToken, undefined);
});

test("cancel and repeated login while code exchange is waiting cannot save stale tokens", async t => {
  const f = await fixture(t);
  f.control.tokenEntered = deferred(); f.control.tokenWait = deferred();
  await f.auth.start(); const pending = f.auth.callback(f.url());
  await f.control.tokenEntered.promise;
  f.auth.cancel(); await f.auth.start();
  f.control.tokenWait.resolve();
  await assert.rejects(pending, /cancelled/);
  assert.equal(f.record().registrations.length, 0);
  f.control.tokenWait = null;
  await f.auth.callback(f.url());
  assert.equal(f.auth.status().connected, true);
});

test("logout waits for rotated refresh, aborts requests and cannot be undone by stale refresh/login", async t => {
  const f = await fixture(t); await f.login();
  const old = await f.auth.lease();
  f.advance(3570000);
  f.control.tokenEntered = deferred(); f.control.tokenWait = deferred();
  const renewing = f.auth.lease();
  await f.control.tokenEntered.promise;
  const logout = f.auth.signOut();
  assert.equal(old.signal.aborted, true); old.release();
  await assert.rejects(f.auth.lease(), /Continue with ChatGPT/);
  f.control.tokenWait.resolve();
  await assert.rejects(renewing, /cancelled/);
  await logout;
  assert.equal(f.control.revoked, "rotated-1");
  assert.equal(f.record().registrations[0].refreshToken, undefined);
  assert.equal(f.auth.status().connected, false);
  const before = f.record().registrations[0].clientId;
  f.control.tokenWait = null;
  await f.login({ accountId: f.auth.status().activeId });
  assert.equal(f.record().registrations[0].clientId, before);
  f.control.revokeFail = true;
  const local = await f.auth.signOut();
  assert.equal(local.revocationConfirmed, false);
  assert.match(local.message, /not confirmed/);
});

test("reauthorization supersedes an older refresh without overwriting its new credentials", async t => {
  const f = await fixture(t); await f.login(); f.advance(3570000);
  f.control.tokenEntered = deferred(); f.control.tokenWait = deferred();
  const renewing = f.auth.lease();
  await f.control.tokenEntered.promise;
  const refreshWait = f.control.tokenWait;
  f.control.tokenWait = null;
  await f.login({ accountId: f.auth.status().activeId });
  const fresh = f.record().registrations[0].accessToken;
  refreshWait.resolve();
  await assert.rejects(renewing, /cancelled/);
  assert.equal(f.record().registrations[0].accessToken, fresh);
});

test("logout discloses uncertain revocation when a racing refresh response is lost", async t => {
  const f = await fixture(t); await f.login(); f.advance(3570000);
  f.control.tokenEntered = deferred(); f.control.tokenWait = deferred();
  f.control.tokenTransportFail = true;
  const renewing = f.auth.lease();
  await f.control.tokenEntered.promise;
  const logout = f.auth.signOut();
  f.control.tokenWait.resolve();
  await assert.rejects(renewing, /could not be reached/);
  const result = await logout;
  assert.equal(result.connected, false);
  assert.equal(result.revocationConfirmed, false, "revoking an old token cannot confirm an unknown rotated session");
  assert.match(result.message, /not confirmed/);
  assert.equal(f.record().registrations[0].refreshToken, undefined);
});

test("explicit background opt-in, withdrawal, mode invalidation and sign-out storage failures fail closed", async t => {
  const f = await fixture(t); await f.login();
  await assert.rejects(f.auth.lease({ background: true }), /background AI is off/);
  f.auth.preferences({ backgroundConsent: true });
  const background = await f.auth.lease({ background: true });
  f.auth.preferences({ backgroundConsent: false });
  assert.equal(background.signal.aborted, true); background.release();
  const request = await f.auth.lease();
  f.auth.invalidateRequests();
  assert.throws(request.check, /cancelled/); request.release();
  f.control.storeFail = true;
  await assert.rejects(f.auth.signOut(), /storage failure/);
  assert.equal(f.auth.status().connected, false);
  await assert.rejects(f.auth.lease(), /Continue with ChatGPT/);
});

function eventStream(events, { terminate = true, split = false } = {}) {
  const text = events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + (terminate ? "" : "data: [DONE]\n\n");
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    if (split) for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { "content-type": "text/event-stream", "x-request-id": "synthetic-stream" } });
}

async function responseFixture(t) {
  const f = await fixture(t); await f.login();
  const calls = [];
  const control = { events: [{ type: "response.output_text.delta", delta: "Hello 你好" }, { type: "response.completed", response: { status: "completed" } }] };
  const adapter = createResponses({ auth: f.auth, fetcher: async (url, input) => {
    calls.push({ url, input });
    assert.match(input.headers.authorization, /^Bearer ey/);
    assert.equal(input.redirect, "error");
    if (control.wait) { control.entered.resolve(); await control.wait.promise; }
    if (url === `${RESOURCE}/models`) return json({ models: [
      { slug: "synthetic-sol", display_name: "Synthetic Sol", visibility: "list" },
      { slug: "hidden", display_name: "Hidden", visibility: "hide" },
      { slug: "synthetic-sol", display_name: "Duplicate", visibility: "list" },
    ] });
    assert.equal(url, `${RESOURCE}/responses`);
    if (control.httpError) return json(control.httpError, control.httpStatus || 403);
    if (control.malformed) return new Response("data: {bad}\n\n", { headers: { "content-type": "text/event-stream" } });
    return eventStream(control.events, { split: true });
  } });
  return { ...f, adapter, responseControl: control, responseCalls: calls };
}

test("account model catalog and Responses constraints; text completion consumes streamed terminal event", async t => {
  const f = await responseFixture(t);
  const models = await f.adapter.listModels();
  assert.deepEqual(models, { ok: true, models: ["synthetic-sol"], choices: [{ id: "synthetic-sol", name: "Synthetic Sol" }] });
  const result = await f.adapter.complete([{ role: "system", content: "Keep it short" }, { role: "user", content: "Synthetic text" }], { model: "synthetic-sol", temperature: 1, max_tokens: 100, background: false });
  assert.equal(result, "Hello 你好");
  const request = f.responseCalls.find(call => call.url.endsWith("/responses"));
  assert.deepEqual(JSON.parse(request.input.body), { model: "synthetic-sol", input: [{ role: "developer", content: "Keep it short" }, { role: "user", content: "Synthetic text" }], store: false, stream: true });
  await assert.rejects(f.adapter.complete([{ role: "user", content: "Hi" }], { model: "unavailable" }), /choose one available/);
  assert.equal(f.responseCalls.filter(call => call.url.endsWith("/responses")).length, 1);
});

test("truncated, incomplete, malformed, refused and failed streaming never retries or falls back", async t => {
  const cases = [
    [{ type: "response.output_text.delta", delta: "partial" }],
    [{ type: "response.incomplete" }],
    [{ type: "response.refusal.delta", delta: "declined" }],
    [{ type: "response.failed", response: { error: { code: "subscription_sharing_usage_unavailable" } } }],
    [{ type: "error", code: "subscription_sharing_unsupported_capability", param: "model" }],
  ];
  for (const events of cases) {
    const f = await responseFixture(t); f.responseControl.events = events;
    await assert.rejects(f.adapter.complete([{ role: "user", content: "Synthetic" }], { model: "synthetic-sol" }));
    assert.equal(f.responseCalls.filter(call => call.url.endsWith("/responses")).length, 1);
  }
  const f = await responseFixture(t); f.responseControl.malformed = true;
  await assert.rejects(f.adapter.complete([{ role: "user", content: "Synthetic" }], { model: "synthetic-sol" }), /malformed/);
});

test("midstream quota limits pause requests until explicit retry and safe errors preserve diagnostics", async t => {
  const f = await responseFixture(t);
  f.responseControl.events = [{ type: "response.output_text.delta", delta: "partial" }, { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", param: "model", message: "synthetic-secret-do-not-echo" } } }];
  let error;
  try { await f.adapter.complete([{ role: "user", content: "Synthetic" }], { model: "synthetic-sol" }); } catch (caught) { error = caught; }
  assert.equal(error.code, "subscription_sharing_usage_limit_exceeded");
  assert.equal(error.param, "model");
  assert.equal(error.requestId, "synthetic-stream");
  assert.equal(error.message.includes("synthetic-secret-do-not-echo"), false);
  assert.equal(f.auth.status().usagePaused, true);
  await assert.rejects(f.adapter.complete([{ role: "user", content: "Synthetic" }], { model: "synthetic-sol" }), /paused/);
  assert.equal(f.responseCalls.filter(call => call.url.endsWith("/responses")).length, 1);
  f.auth.resumeUsage();
  f.responseControl.httpError = { detail: "synthetic-secret-do-not-echo" };
  f.responseControl.httpStatus = 503;
  await assert.rejects(f.adapter.complete([{ role: "user", content: "Synthetic" }], { model: "synthetic-sol" }), err => err.status === 503 && err.bodyShape[0] === "detail" && !err.message.includes("synthetic-secret"));
  assert.equal(f.auth.status().connected, true);
});

test("account/mode change and user cancellation discard late Responses output", async t => {
  const f = await responseFixture(t);
  await f.adapter.listModels();
  f.responseControl.wait = deferred(); f.responseControl.entered = deferred();
  let output = "";
  const running = f.adapter.stream([{ role: "user", content: "Synthetic" }], piece => { output += piece; }, { model: "synthetic-sol" });
  await f.responseControl.entered.promise;
  f.auth.invalidateRequests(); f.responseControl.wait.resolve();
  await assert.rejects(running, /cancelled/);
  assert.equal(output, "");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.adapter.complete([{ role: "user", content: "Synthetic" }], { model: "synthetic-sol", signal: controller.signal }), /cancelled/);
});

test("encrypted atomic credential storage preserves damaged files and never falls back to plaintext", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-chatgpt-store-"));
  const key = crypto.randomBytes(32);
  const storage = {
    encryptString(text) { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", key, iv); const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]); },
    decryptString(bytes) { const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(); },
  };
  try {
    const store = createStore({ directory: () => directory, storage: () => storage });
    store.write({ hostId: "host", activeId: "account", registrations: [{ refreshToken: "synthetic-secret" }] });
    const file = path.join(directory, "chatgpt-credentials.enc");
    assert.equal(fs.readFileSync(file).includes(Buffer.from("synthetic-secret")), false);
    assert.equal(store.read().registrations[0].refreshToken, "synthetic-secret");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(directory), ["chatgpt-credentials.enc"]);
    const locked = createStore({ directory: () => directory, storage: () => { throw new Error("locked"); } });
    assert.equal(locked.available(), false);
    assert.throws(() => locked.write({}), /locked/);
    assert.throws(() => locked.read(), /locked or damaged/);
    fs.writeFileSync(file, "damaged");
    assert.throws(() => store.read(), /locked or damaged/);
    assert.equal(fs.readFileSync(file, "utf8"), "damaged");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("existing API key/custom endpoint behavior and separate ChatGPT settings survive mode changes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-chatgpt-api-"));
  const env = Object.fromEntries(["MORROW_AI_CONFIG_DIR", "MORROW_AI_API_KEY", "XAI_API_KEY", "MORROW_AI_BASE_URL", "MORROW_AI_MODEL"].map(key => [key, process.env[key]]));
  const originalFetch = global.fetch;
  const responses = require("../host/chatgpt-responses");
  const originalResponses = responses.getResponses;
  try {
    for (const key of Object.keys(env)) delete process.env[key];
    process.env.MORROW_AI_CONFIG_DIR = directory;
    const config = require("../host/ai-config");
    const client = require("../host/openai-client");
    config.saveConfig({ baseUrl: "https://synthetic-api.invalid/custom/v1", model: "existing-model", apiKey: "synthetic-api-key" });
    assert.equal(config.loadConfig().authMode, "api_key");
    const calls = [];
    global.fetch = async (url, input) => {
      calls.push({ url, input });
      assert.equal(input.headers.authorization, "Bearer synthetic-api-key");
      if (url.endsWith("/models")) return json({ data: [{ id: "existing-model" }] });
      assert.equal(url, "https://synthetic-api.invalid/custom/v1/chat/completions");
      const payload = JSON.parse(input.body);
      assert.equal(payload.model, "existing-model");
      if (payload.stream) return new Response("data: [DONE]\n\n");
      return json({ choices: [{ message: { content: "Existing API response" } }] });
    };
    assert.equal(await client.complete([{ role: "user", content: "Synthetic" }], { temperature: 0.2, max_tokens: 25 }), "Existing API response");
    assert.equal(JSON.parse(calls[0].input.body).max_tokens, 25);
    assert.deepEqual(await client.listModels(), { ok: true, models: ["existing-model"] });
    const original = config.loadConfig();
    config.saveConfig({ authMode: "chatgpt", chatgptModel: "synthetic-sol", apiKey: "" });
    assert.equal(config.loadConfig().apiKey, original.apiKey);
    assert.equal(config.loadConfig().baseUrl, original.baseUrl);
    assert.equal(config.loadConfig().model, original.model);
    assert.equal(config.publicConfig().apiKey, undefined);
    let oauthCalls = 0;
    responses.getResponses = () => ({
      complete: async (_messages, options) => { oauthCalls++; assert.equal(options.model, "synthetic-sol"); throw new Error("Synthetic ChatGPT quota failure"); },
      stream: async () => { oauthCalls++; throw new Error("Synthetic ChatGPT stream failure"); },
      listModels: async () => ({ ok: true, models: ["synthetic-sol"] }),
    });
    const apiCalls = calls.length;
    await assert.rejects(client.complete([{ role: "user", content: "Synthetic" }]), /quota failure/);
    await assert.rejects(client.stream([{ role: "user", content: "Synthetic" }], () => {}), /stream failure/);
    assert.equal(oauthCalls, 2);
    assert.equal(calls.length, apiCalls, "ChatGPT errors must never fall back to API billing");
    assert.deepEqual(await client.listModels(), { ok: true, models: ["synthetic-sol"] });
    config.saveConfig({ authMode: "api_key" });
    assert.equal(config.loadConfig().apiKey, "synthetic-api-key");
    assert.equal(config.loadConfig().chatgptModel, "synthetic-sol");
    // A mode edit during an existing API stream cannot move its completion
    // retry onto ChatGPT. The old adapter/config stays pinned for that request.
    const apiFetch = global.fetch;
    global.fetch = async (url, input) => {
      if (JSON.parse(input.body).stream) config.saveConfig({ authMode: "chatgpt" });
      return apiFetch(url, input);
    };
    let output = "";
    await client.stream([{ role: "user", content: "Synthetic" }], piece => { output += piece; });
    assert.equal(output, "Existing API response");
    assert.equal(oauthCalls, 2);
    assert.throws(() => config.saveConfig({ authMode: "unknown" }), /Choose API key or ChatGPT/);
  } finally {
    global.fetch = originalFetch; responses.getResponses = originalResponses;
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("host background classification survives async work and cannot be removed by foreground options", async () => {
  const context = require("../host/ai-context");
  assert.equal(context.isBackground(), false);
  await context.background(async () => {
    await Promise.resolve();
    assert.equal(context.isBackground(), true);
  });
  assert.equal(context.isBackground(), false);
  const sourcePath = require.resolve("../host/brain");
  const load = createRequire(sourcePath);
  const recorded = [];
  let hourly;
  let consent = false;
  const scheduled = [];
  const module = { exports: {} };
  const sandbox = vm.createContext({ module, exports: module.exports, __dirname: path.dirname(sourcePath),
    require(name) {
      if (name === "electron") return { BrowserWindow: { getAllWindows: () => [] } };
      if (name === "./ai-config") return { loadConfig: () => ({ authMode: "chatgpt", apiKey: "" }), userDataDir: () => "/tmp/morrow-nonexistent-synthetic-profile" };
      if (name === "./chatgpt-auth") return { getAuth: () => ({ backgroundAllowed: () => consent }) };
      if (name === "./update-quiescence") return { gate: { run: work => work() } };
      return load(name);
    },
    setImmediate(callback) { scheduled.push(callback); },
    setInterval(callback) { hourly = callback; return { unref() {} }; },
    console,
  });
  vm.runInContext(fs.readFileSync(sourcePath, "utf8"), sandbox);
  sandbox.record = () => { recorded.push(context.isBackground()); return Promise.resolve(); };
  vm.runInContext("analyzeMail = record;", sandbox);
  module.exports.answer("emailBrain:refresh", [{ source: "open" }]);
  scheduled.shift()();
  module.exports.answer("emailBrain:refresh", [{ source: "manual" }]);
  scheduled.shift()();
  module.exports.scheduleLivingRefresh();
  hourly();
  assert.deepEqual(recorded, [true, false], "hourly refresh cannot start without account opt-in");
  consent = true; hourly();
  assert.deepEqual(recorded, [true, false, true]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-chatgpt-background-"));
  const previousDir = process.env.MORROW_AI_CONFIG_DIR;
  const responses = require("../host/chatgpt-responses");
  const previousResponses = responses.getResponses;
  try {
    process.env.MORROW_AI_CONFIG_DIR = directory;
    require("../host/ai-config").saveConfig({ authMode: "chatgpt", chatgptModel: "synthetic-sol" });
    let options;
    responses.getResponses = () => ({ complete: async (_messages, input) => { options = input; return "Synthetic"; } });
    await context.background(() => require("../host/openai-client").complete([{ role: "user", content: "Synthetic" }], { background: false }));
    assert.equal(options.background, true, "caller options cannot downgrade a classified background run");
  } finally {
    responses.getResponses = previousResponses;
    if (previousDir === undefined) delete process.env.MORROW_AI_CONFIG_DIR; else process.env.MORROW_AI_CONFIG_DIR = previousDir;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
