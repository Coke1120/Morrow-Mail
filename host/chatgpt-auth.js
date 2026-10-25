const crypto = require("crypto");
const http = require("http");
const { createStore } = require("./chatgpt-store");
const { providerError } = require("./chatgpt-errors");

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const TERMINAL_REFRESH = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);
const planEnabled = (record) => ["resource.invoke", "chatgpt.tokens.use.direct"].every(scope => record?.scopes?.includes(scope));
const random = () => crypto.randomBytes(32).toString("base64url");
const abortError = () => new Error("ChatGPT request cancelled because the connection or AI mode changed.");

function createAuth({ store = createStore(), fetcher = (...args) => fetch(...args), openBrowser = url => require("electron").shell.openExternal(url), now = Date.now, loginTimeout = 10 * 60 * 1000 } = {}) {
  let pending = null;
  let lastLogin = { phase: "idle", message: "" };
  let discovery;
  let keys;
  let keysAt = 0;
  let requestEpoch = 0;
  const versions = new Map();
  const refreshing = new Map();
  const signingOut = new Map();
  const requests = new Set();
  const paused = new Set();
  const ended = new Set();
  let retryRegistration = null;
  const version = id => versions.get(id) || 0;
  const selected = () => { const data = store.read(); return data.registrations.find(r => r.id === data.activeId); };

  async function request(url, options = {}) {
    try {
      return await fetcher(url, { ...options, redirect: "error", signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    } catch { throw new Error("ChatGPT could not be reached. Check your connection and retry."); }
  }

  async function metadata(signal) {
    if (!discovery) {
      const response = await request(`${ISSUER}/.well-known/openid-configuration`, { signal });
      if (!response.ok) throw new Error("ChatGPT identity discovery is unavailable. Retry later.");
      const data = await response.json();
      if (signal?.aborted) throw abortError();
      const trusted = url => {
        try { const parsed = new URL(url); return parsed.origin === ISSUER && !parsed.username && !parsed.password && !parsed.hash && !parsed.search; }
        catch { return false; }
      };
      if (data.issuer !== ISSUER || data.authorization_endpoint !== AUTHORIZE || data.token_endpoint !== TOKEN || !trusted(data.jwks_uri) || !trusted(data.revocation_endpoint)) {
        throw new Error("ChatGPT identity discovery did not match the supported issuer and endpoints.");
      }
      discovery = data;
    }
    return discovery;
  }

  async function verify(token, audience, nonce) {
    const { jwtVerify, createLocalJWKSet } = await import("jose");
    const meta = await metadata();
    async function getKeys(force) {
      if (force || !keys || now() - keysAt > 5 * 60 * 1000) {
        const response = await request(meta.jwks_uri);
        if (!response.ok) throw new Error();
        keys = createLocalJWKSet(await response.json());
        keysAt = now();
      }
      return keys;
    }
    const options = { issuer: ISSUER, audience, algorithms: ["RS256", "PS256", "ES256"], requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5, currentDate: new Date(now()) };
    let payload;
    try {
      try { ({ payload } = await jwtVerify(token, await getKeys(false), options)); }
      catch (error) {
        if (error.code !== "ERR_JWKS_NO_MATCHING_KEY") throw error;
        ({ payload } = await jwtVerify(token, await getKeys(true), options));
      }
      if (typeof payload.sub !== "string" || !payload.sub || payload.iat > now() / 1000 + 5
        || (nonce !== undefined && payload.nonce !== nonce)
        || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== audience)) throw new Error();
    } catch { throw new Error("ChatGPT token identity, signature, audience, expiry or nonce could not be verified. Start a new sign-in."); }
    return payload;
  }

  async function tokens(form, expected, nonce, signal) {
    const response = await request(TOKEN, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ ...form, client_id: expected.clientId, resource: RESOURCE }), signal,
    });
    let data;
    try { data = await response.json(); } catch { throw new Error("ChatGPT returned an invalid token response. Sign in again."); }
    if (signal?.aborted) throw abortError();
    if (!response.ok) throw providerError(data, response.status, response.headers.get("openai-request-id") || response.headers.get("x-request-id"));
    if (typeof data.scope !== "string") {
      throw new Error("ChatGPT returned incomplete credentials. Sign in again.");
    }
    const scopes = [...new Set(data.scope.split(/\s+/).filter(Boolean))];
    const direct = planEnabled({ scopes });
    if ((direct || data.access_token) && (data.token_type?.toLowerCase() !== "bearer" || typeof data.access_token !== "string"
      || !Number.isFinite(data.expires_in) || data.expires_in <= 0)) throw new Error("ChatGPT returned incomplete credentials. Sign in again.");
    const identity = data.id_token ? await verify(data.id_token, expected.clientId, nonce) : null;
    if (nonce !== undefined && !identity) throw new Error("ChatGPT did not return the required identity token.");
    if (expected.subject && identity && identity.sub !== expected.subject) throw new Error("ChatGPT returned a different account. The original connection was preserved.");
    const subject = identity?.sub || expected.subject;
    const access = data.access_token ? await verify(data.access_token, RESOURCE) : null;
    if (access && (access.sub !== subject || access.client_id !== expected.clientId)) throw new Error("ChatGPT access token does not match this registration.");
    if (access && (typeof access.scope !== "string" || scopes.some(scope => !access.scope.split(/\s+/).includes(scope)))) throw new Error("ChatGPT granted scopes did not match the signed token.");
    return {
      ...expected, subject, issuer: ISSUER, email: identity?.email || expected.email || "",
      accessToken: data.access_token || "", refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : "", idToken: data.id_token || expected.idToken || "", scopes,
      expiresAt: access ? Math.min(now() + data.expires_in * 1000, access.exp * 1000) : identity?.exp * 1000 || 0,
      earliestRefreshAt: typeof data.earliest_refresh_at === "number" ? data.earliest_refresh_at * 1000 : Date.parse(data.earliest_refresh_at) || 0,
      connected: true,
    };
  }

  function stopListener(attempt) {
    clearTimeout(attempt.timer);
    if (attempt.server) { attempt.server.close(); attempt.server.closeAllConnections(); }
  }
  function cancel(message = "ChatGPT sign-in cancelled.") {
    if (pending) {
      pending.abort.abort();
      stopListener(pending);
      pending = null;
      lastLogin = { phase: "cancelled", message };
    }
  }
  function invalidateRequests() {
    requestEpoch += 1;
    for (const controller of requests) controller.abort();
    cancel();
  }

  function status() {
    let data;
    try { data = store.read(); }
    catch (error) { return { available: false, message: error.message, phase: "locked", accounts: [] }; }
    const active = data.registrations.find(r => r.id === data.activeId);
    return {
      available: store.available(), phase: pending?.phase || lastLogin.phase,
      message: lastLogin.message, pending: !!pending, activeId: data.activeId,
      connected: !!active?.connected && !ended.has(active?.id) && !signingOut.has(active?.id), planEnabled: planEnabled(active),
      expiresAt: active?.expiresAt || null, usagePaused: paused.has(active?.id),
      backgroundConsent: active?.backgroundConsent === true,
      welcome: !!active?.accessToken && planEnabled(active) && !active.welcomed,
      accounts: data.registrations.map(r => ({ id: r.id, label: `${r.email || "ChatGPT account"} · ${r.id.slice(-6)}`, connected: !!r.connected && !ended.has(r.id), planEnabled: planEnabled(r) })),
    };
  }

  async function callback(raw) {
    const attempt = pending;
    if (!attempt || attempt.phase !== "waiting" || now() >= attempt.expiresAt) throw new Error("ChatGPT callback is stale or expired. Start a new sign-in.");
    let url;
    try { if (typeof raw !== "string" || raw.length > 16000) throw new Error(); url = new URL(raw); }
    catch { throw new Error("Paste the complete callback URL from this sign-in's browser address bar."); }
    const base = new URL(attempt.redirectUri);
    if (url.origin !== base.origin || url.pathname !== base.pathname || url.hash || url.username || url.password) throw new Error("The ChatGPT callback address does not match the pending sign-in.");
    for (const name of ["state", "code", "error", "client_id", "iss"]) {
      if (url.searchParams.getAll(name).length > 1) throw new Error("ChatGPT callback contains duplicate parameters.");
    }
    const state = url.searchParams.get("state") || "";
    if (Buffer.byteLength(state) !== Buffer.byteLength(attempt.state) || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(attempt.state))) throw new Error("ChatGPT callback state does not match. Start a new sign-in if this is an older callback.");
    attempt.phase = "exchanging"; // consume once, including provider errors
    stopListener(attempt);
    try {
      if (url.searchParams.has("iss") && url.searchParams.get("iss") !== ISSUER) throw new Error("ChatGPT callback issuer did not match.");
      if (url.searchParams.has("error")) throw new Error(url.searchParams.get("error") === "access_denied" ? "ChatGPT sign-in or plan permission was declined. Retry when ready." : "ChatGPT sign-in failed. Start a new sign-in.");
      const code = url.searchParams.get("code");
      const clientId = url.searchParams.get("client_id") || attempt.selected?.clientId;
      if (!code || !clientId || !/^oaiapp_[A-Za-z0-9_-]{1,200}$/.test(clientId) || (attempt.selected && clientId !== attempt.selected.clientId)) throw new Error("ChatGPT registration is incomplete or returned a different client ID. Retry sign-in.");
      const record = await tokens({ grant_type: "authorization_code", code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri }, { ...attempt.selected, clientId }, attempt.nonce, attempt.abort.signal);
      if (pending !== attempt || attempt.abort.signal.aborted || now() >= attempt.expiresAt) throw abortError();
      const data = store.read();
      const existing = data.registrations.find(r => r.clientId === clientId);
      if (existing && existing.subject !== record.subject) throw new Error("ChatGPT identity does not match the saved registration.");
      record.id = existing?.id || crypto.randomUUID();
      // New accounts require their own explicit background opt-in.
      record.backgroundConsent = existing?.backgroundConsent === true;
      record.welcomed = existing?.welcomed === true;
      data.registrations = data.registrations.filter(r => r.id !== record.id).concat(record);
      data.activeId = record.id;
      store.write(data);
      versions.set(record.id, version(record.id) + 1);
      paused.delete(record.id);
      ended.delete(record.id);
      retryRegistration = null;
      pending = null;
      invalidateRequests();
      lastLogin = { phase: "connected", message: planEnabled(record) ? "Connected to ChatGPT. Eligible AI requests use your ChatGPT plan." : "Signed in. ChatGPT plan usage is disabled; enable it by signing in again." };
      return status();
    } catch (error) {
      if (pending === attempt && error.code === "invalid_grant" && !attempt.selected) {
        retryRegistration = { clientId: url.searchParams.get("client_id") };
      }
      if (pending === attempt) { pending = null; lastLogin = { phase: "failed", message: error.message }; }
      throw error;
    }
  }

  async function start({ accountId, enablePlan = false } = {}) {
    cancel();
    if (!store.available()) throw new Error("ChatGPT sign-in needs unlocked operating system secure storage.");
    const data = store.read();
    const account = accountId ? data.registrations.find(r => r.id === accountId) : retryRegistration;
    if (accountId && !account) throw new Error("Choose a saved ChatGPT account or add a new account.");
    if (account && signingOut.has(account.id)) throw new Error("Wait for ChatGPT sign-out to finish, then retry.");
    if (!data.hostId) { data.hostId = `urn:uuid:${crypto.randomUUID()}`; store.write(data); }
    const attempt = { state: random(), nonce: random(), verifier: random(), selected: account ? { ...account } : null, expiresAt: now() + loginTimeout, abort: new AbortController(), phase: "starting" };
    pending = attempt;
    lastLogin = { phase: "starting", message: "Opening ChatGPT sign-in in your browser…" };
    try {
      await metadata(attempt.abort.signal);
      if (pending !== attempt) throw abortError();
      const server = http.createServer((req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Security-Policy", "default-src 'none'");
        if (!attempt.redirectUri || req.method !== "GET" || req.headers.host !== new URL(attempt.redirectUri).host || !req.url?.startsWith("/auth/callback?")) { res.writeHead(404).end("Not found"); return; }
        // Acknowledge navigation before closing the listener; outcome stays in app.
        res.end("Return to Morrow Mail to check ChatGPT sign-in status. You can close this tab.", () => {
          callback(`${new URL(attempt.redirectUri).origin}${req.url}`).catch(() => {});
        });
      });
      attempt.server = server;
      server.requestTimeout = 5000;
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      if (pending !== attempt) { stopListener(attempt); throw abortError(); }
      attempt.redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
      const url = new URL(AUTHORIZE);
      url.search = new URLSearchParams({
        client_id: account?.clientId || "dynamic_agent_client", ext_agent_host_id: data.hostId,
        ...(account ? {} : { agent_name_hint: "Morrow Mail" }), response_type: "code", redirect_uri: attempt.redirectUri,
        scope: SCOPES, resource: RESOURCE, state: attempt.state, nonce: attempt.nonce,
        code_challenge_method: "S256", code_challenge: crypto.createHash("sha256").update(attempt.verifier).digest("base64url"),
        ...(account?.idToken ? { id_token_hint: account.idToken } : {}),
        ...(account?.email ? { login_hint: account.email } : {}), ...(enablePlan ? { prompt: "consent" } : {}),
      }).toString();
      attempt.phase = "waiting";
      attempt.timer = setTimeout(() => cancel("ChatGPT sign-in timed out. Retry to open a fresh sign-in."), loginTimeout);
      attempt.timer.unref?.();
      await openBrowser(url.toString()); // never return or log the authorization URL
      if (pending === attempt) lastLogin = { phase: "waiting", message: "Complete ChatGPT sign-in in your browser. Waiting for the callback…" };
      return status();
    } catch (error) {
      if (pending === attempt) { cancel(); lastLogin = { phase: "failed", message: "ChatGPT sign-in could not start. Check your browser, network and secure storage, then retry." }; }
      throw new Error(lastLogin.message || "ChatGPT sign-in cancelled.");
    }
  }

  async function refresh(record) {
    if (refreshing.has(record.id)) return refreshing.get(record.id);
    const generation = version(record.id);
    const job = (async () => {
      try {
        const next = await tokens({ grant_type: "refresh_token", refresh_token: record.refreshToken }, record);
        if (version(record.id) === generation) {
          const data = store.read();
          const index = data.registrations.findIndex(r => r.id === record.id);
          if (index >= 0) { data.registrations[index] = { ...next, backgroundConsent: data.registrations[index].backgroundConsent, welcomed: data.registrations[index].welcomed }; store.write(data); }
        }
        return next; // sign-out awaits the latest rotated token before revocation
      } catch (error) {
        if (TERMINAL_REFRESH.has(error.code) && version(record.id) === generation) clearTokens(record.id);
        throw error;
      }
    })();
    refreshing.set(record.id, job);
    try { return await job; } finally { if (refreshing.get(record.id) === job) refreshing.delete(record.id); }
  }

  function clearTokens(id) {
    ended.add(id);
    versions.set(id, version(id) + 1);
    invalidateRequests();
    const data = store.read();
    const index = data.registrations.findIndex(r => r.id === id);
    if (index >= 0) {
      const { accessToken, refreshToken, idToken, scopes, expiresAt, backgroundConsent, ...mapping } = data.registrations[index];
      data.registrations[index] = { ...mapping, scopes: [], connected: false, backgroundConsent: false };
      store.write(data);
    }
  }

  async function signOut(id = store.read().activeId) {
    if (signingOut.has(id)) return signingOut.get(id);
    const record = store.read().registrations.find(r => r.id === id);
    if (!record) return status();
    ended.add(id);
    versions.set(id, version(id) + 1);
    invalidateRequests();
    const job = (async () => {
      let latest = record;
      let uncertainRefresh = false;
      try { latest = await refreshing.get(id) || record; }
      catch { uncertainRefresh = true; /* a failed response may hide server-side rotation */ }
      let revoked = !latest.refreshToken;
      if (latest.refreshToken) {
        try {
          const meta = await metadata();
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const response = await request(meta.revocation_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: latest.refreshToken, token_type_hint: "refresh_token", client_id: latest.clientId }) });
              if (response.status === 200) { revoked = true; break; }
              if (response.status < 500) break;
            } catch { /* bounded retry on network failure while the token is available */ }
            if (!attempt) await new Promise(resolve => setTimeout(resolve, 250));
          }
        } catch { /* local logout still clears all tokens */ }
      }
      if (uncertainRefresh) revoked = false;
      clearTokens(id);
      lastLogin = { phase: "signed_out", message: revoked ? "Signed out of ChatGPT." : "Signed out locally. Remote revocation was not confirmed; disconnect Morrow Mail in ChatGPT settings." };
      return { ...status(), revocationConfirmed: revoked };
    })();
    signingOut.set(id, job);
    try { return await job; } finally { signingOut.delete(id); }
  }

  function select(id) {
    const data = store.read();
    const record = data.registrations.find(r => r.id === id);
    if (!record?.connected || ended.has(id) || signingOut.has(id)) throw new Error("Sign in to that ChatGPT account before selecting it.");
    data.activeId = id;
    store.write(data);
    invalidateRequests();
    return status();
  }

  function preferences({ backgroundConsent, welcomeSeen } = {}) {
    const data = store.read();
    const record = data.registrations.find(r => r.id === data.activeId);
    if (!record?.connected || ended.has(record.id) || signingOut.has(record.id)) throw new Error("Connect ChatGPT first.");
    if (typeof backgroundConsent === "boolean") record.backgroundConsent = backgroundConsent;
    if (welcomeSeen === true) record.welcomed = true;
    store.write(data);
    if (backgroundConsent === false) invalidateRequests();
    return status();
  }

  async function lease({ signal, background = false } = {}) {
    const record = selected();
    if (!record?.connected || ended.has(record.id) || signingOut.has(record.id)) throw new Error("Continue with ChatGPT in AI settings to connect your account.");
    if (!planEnabled(record)) throw new Error("ChatGPT plan usage is disabled. Enable plan usage in AI settings.");
    if (background && record.backgroundConsent !== true) throw new Error("ChatGPT background AI is off. Explicitly allow background processing in AI settings first.");
    if (paused.has(record.id)) throw new Error("ChatGPT usage is paused after reaching a limit. Open Manage usage, then explicitly retry in AI settings.");
    const epoch = requestEpoch;
    const generation = version(record.id);
    const controller = new AbortController();
    requests.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const check = () => {
      if (epoch !== requestEpoch || version(record.id) !== generation || combined.aborted || signingOut.has(record.id)) throw abortError();
    };
    try {
      check();
      const current = record.refreshToken && record.expiresAt - now() < 60000 && now() >= (record.earliestRefreshAt || 0) ? await refresh(record) : record;
      check();
      if (!current.accessToken || current.expiresAt <= now()) throw new Error("ChatGPT access expired. Retry later or sign in again.");
      if (!planEnabled(current)) throw new Error("ChatGPT plan usage permission is missing. Enable plan usage in AI settings.");
      return { token: current.accessToken, id: record.id, signal: combined, check,
        pause: () => paused.add(record.id), release: () => requests.delete(controller) };
    } catch (error) { requests.delete(controller); throw error; }
  }

  return { start, callback, cancel, status, select, signOut, preferences, lease, invalidateRequests,
    backgroundAllowed: () => { const record = selected(); return !!record?.accessToken && !ended.has(record.id) && record.backgroundConsent === true && !signingOut.has(record.id); },
    resumeUsage: () => { paused.delete(store.read().activeId); return status(); },
    dispose: invalidateRequests,
  };
}

let instance;
module.exports = { createAuth, ISSUER, RESOURCE, SCOPES, planEnabled, getAuth: () => instance || (instance = createAuth()) };
