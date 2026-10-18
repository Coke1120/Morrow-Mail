const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");
const {
  SCOPES,
  ENDPOINTS,
  IMAP_PRESETS,
  credentials,
  oauthReady,
  scopesFor,
  redirectPath,
  redirectUri,
  profileUrl,
  authorizeUrl,
  normalizePurpose,
  providerKey,
} = require("./oauth-config");

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function listenOnce() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
    server.on("error", reject);
  });
}

function openBrowser(url) {
  const { shell } = require("electron");
  return shell.openExternal(url);
}

function htmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlPage(title, body) {
  return `<!doctype html><html><body><h1>${htmlEscape(title)}</h1><p>${htmlEscape(body)}</p><p>You can close this window.</p></body></html>`;
}

function finishResponse(res, status, title, body) {
  if (!res || res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", connection: "close" });
  res.end(htmlPage(title, body));
}

function safeOauthMessage(error) {
  const message = error instanceof Error ? error.message : String(error || "Sign-in failed.");
  if (/access_token|refresh_token|client_secret|Bearer /i.test(message)) return "Sign-in failed.";
  return message.slice(0, 300);
}

function cancelledError() {
  const error = new Error("Sign-in canceled.");
  error.code = "oauth_cancelled";
  return error;
}

function callbackPage(outcome) {
  const ok = !!(outcome && outcome.ok === true);
  const detail = outcome && outcome.message ? safeOauthMessage(outcome.message) : "";
  const canceled = !ok && /cancel/i.test(detail);
  return {
    status: ok ? 200 : 400,
    title: ok ? "Connected" : (canceled ? "Sign-in canceled" : "Sign-in not finished"),
    body: ok ? "Return to Morrow Mail." : (detail || "Morrow Mail did not save this account."),
  };
}

function waitForCode(server, expectedState, expectedPath, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let outcome = null;
    let response = null;
    const duplicates = [];
    const shutdown = () => {
      try { server.close(); } catch { /* already closed */ }
    };
    const writePage = (res, page) => finishResponse(res, page.status, page.title, page.body);
    const finish = (next) => {
      if (outcome) return;
      outcome = next;
      const page = callbackPage(next);
      writePage(response, page);
      for (const extra of duplicates.splice(0)) writePage(extra, page);
      shutdown();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const canceled = error && error.code === "oauth_cancelled";
      finish({
        ok: false,
        message: canceled ? "Sign-in canceled." : safeOauthMessage(error),
      });
      reject(error);
    };
    const timer = setTimeout(() => {
      const error = new Error("OAuth timed out. Keep the app open and try again.");
      error.code = "oauth_timeout";
      fail(error);
    }, timeoutMs);
    const onAbort = () => fail(cancelledError());
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const partsFrom = (req) => {
      const url = new URL(req.url, "http://127.0.0.1");
      return {
        pathname: url.pathname,
        err: url.searchParams.get("error"),
        code: url.searchParams.get("code"),
        state: url.searchParams.get("state"),
      };
    };
    const validCallback = (parts) => parts.pathname === expectedPath && !parts.err && parts.code && parts.state === expectedState;

    server.on("request", (req, res) => {
      try {
        const parts = partsFrom(req);
        if (parts.pathname !== expectedPath) {
          finishResponse(res, 404, "Not found", "Not found");
          return;
        }
        if (settled) {
          if (!validCallback(parts)) {
            finishResponse(res, 400, "Sign-in not finished", "Invalid OAuth callback.");
            return;
          }
          if (outcome && outcome.ok === true) {
            writePage(res, callbackPage(outcome));
            return;
          }
          if (outcome) {
            finishResponse(res, 409, "Sign-in not finished", "This sign-in is no longer waiting.");
            return;
          }
          duplicates.push(res);
          return;
        }
        if (parts.err) {
          response = res;
          const error = new Error(`OAuth provider error: ${parts.err}`);
          error.code = "oauth_provider";
          fail(error);
          return;
        }
        if (!parts.code || parts.state !== expectedState) {
          finishResponse(res, 400, "Sign-in not finished", "Invalid OAuth callback.");
          return;
        }
        response = res;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        const complete = (result) => {
          finish({
            ok: !!(result && result.ok === true),
            message: result && result.message ? result.message : "",
          });
        };
        resolve({ code: parts.code, complete });
      } catch (error) {
        fail(error);
      }
    });
  });
}

async function exchange(provider, creds, code, redirect, verifier, scope, fetchImpl) {
  const fetcher = fetchImpl || fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    client_id: creds.clientId,
    code_verifier: verifier,
  });
  if (creds.clientSecret) body.set("client_secret", creds.clientSecret);
  if (provider === "microsoft") body.set("scope", scope || SCOPES.microsoft);

  const res = await fetcher(ENDPOINTS[provider].token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const detail = json.error || res.status;
    throw new Error(`Token exchange failed (${detail}). Check OAuth client and redirect path.`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || "",
    expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000,
    grantedScopes: json.scope || scope || SCOPES[provider],
    idToken: typeof json.id_token === "string" ? json.id_token : "",
  };
}

async function refresh(provider, creds, refreshToken, scope, previousGranted) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: creds.clientId,
  });
  if (creds.clientSecret) body.set("client_secret", creds.clientSecret);
  if (provider === "microsoft") body.set("scope", scope || SCOPES.microsoft);
  const res = await fetch(ENDPOINTS[provider].token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error("Could not refresh the OAuth access token. Sign in again.");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || refreshToken,
    expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000,
    grantedScopes: json.scope || previousGranted || scope || SCOPES[provider],
  };
}

function tokenClaims(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return {};
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return json && typeof json === "object" ? json : {};
  } catch {
    return {};
  }
}

function emailFromText(value) {
  const match = String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : "";
}

function emailFromClaims(claims) {
  const source = claims && typeof claims === "object" ? claims : {};
  for (const key of ["email", "preferred_username", "upn", "unique_name"]) {
    const email = emailFromText(source[key]);
    if (email) return email;
  }
  return "";
}

function displayFromClaims(claims) {
  const name = String((claims && claims.name) || "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name || name.includes("@") || name.length > 200) return "";
  return name;
}

function cleanDisplay(value) {
  const name = String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name || name.includes("@") || name.length > 200) return "";
  return name;
}

async function readBody(res) {
  if (res && typeof res.json === "function") return res.json().catch(() => ({}));
  return {};
}

// IMAP tokens are issued for outlook.office.com. Graph /me needs User.Read, and Entra
// rejects that scope on the same authorize URL as the IMAP/SMTP resource scopes.
async function fetchOutlookMailboxProfile(accessToken, idToken, fetchImpl) {
  const fetcher = fetchImpl || fetch;
  const fromId = tokenClaims(idToken);
  const fromAccess = tokenClaims(accessToken);
  let status = 0;
  let restEmail = "";
  let restName = "";
  try {
    const res = await fetcher("https://outlook.office.com/api/v2.0/me?$select=EmailAddress,DisplayName", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    });
    const json = await readBody(res);
    if (res && res.ok) {
      restEmail = String(json.EmailAddress || json.mail || json.userPrincipalName || "").trim();
      restName = cleanDisplay(json.DisplayName || json.displayName);
    } else {
      status = res && res.status ? res.status : 0;
    }
  } catch {
    status = status || 0;
  }
  const email = emailFromText(restEmail) || emailFromClaims(fromId) || emailFromClaims(fromAccess);
  const displayName = restName || displayFromClaims(fromId) || displayFromClaims(fromAccess);
  if (email) return { email, displayName };
  const statusText = status ? ` Outlook profile request failed (${status}).` : "";
  throw new Error(
    "Could not read the Outlook account profile after OAuth." +
    statusText +
    " The IMAP token is for outlook.office.com and cannot call Microsoft Graph /me. User.Read stays on the separate organize grant."
  );
}

async function fetchRemoteProfile(provider, accessToken, purpose, idToken, fetchImpl) {
  const fetcher = fetchImpl || fetch;
  const res = await fetcher(profileUrl(provider, purpose), {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  const json = await readBody(res);
  if (!res || !res.ok) {
    const email = emailFromClaims(tokenClaims(idToken)) || emailFromClaims(tokenClaims(accessToken));
    const displayName = displayFromClaims(tokenClaims(idToken)) || displayFromClaims(tokenClaims(accessToken));
    if (email && provider === "microsoft") return { email, displayName };
    const status = res && res.status ? res.status : 0;
    const which = provider === "microsoft" ? "Microsoft Graph /me" : "the account profile";
    throw new Error(`Could not read ${which} after OAuth${status ? ` (HTTP ${status})` : ""}.`);
  }
  if (provider === "google") {
    return {
      email: String(json.email || json.emailAddress || "").trim(),
      displayName: cleanDisplay(json.name),
    };
  }
  return {
    email: String(json.mail || json.userPrincipalName || "").trim(),
    displayName: cleanDisplay(json.displayName),
  };
}

async function fetchProfile(provider, accessToken, purpose, idToken, fetchImpl) {
  const key = normalizeProvider(provider);
  if (!key) throw new Error("Choose Google or Microsoft.");
  if (key === "microsoft" && normalizePurpose(purpose) === "imap") {
    return fetchOutlookMailboxProfile(accessToken, idToken, fetchImpl);
  }
  return fetchRemoteProfile(key, accessToken, purpose, idToken, fetchImpl);
}

async function fetchEmail(provider, accessToken, purpose) {
  const profile = await fetchProfile(provider, accessToken, purpose);
  return profile.email;
}

function normalizeProvider(input) {
  const raw = String(input || "").toLowerCase();
  if (raw === "gmail" || raw === "google") return "google";
  if (raw === "outlook" || raw === "microsoft" || raw === "office365") return "microsoft";
  return null;
}

let activeController = null;

function cancelActive() {
  if (!activeController) return false;
  activeController.abort();
  return true;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw cancelledError();
}

/**
 * Browser loopback OAuth (PKCE), same shape as Morrow-Mail desktop clients.
 * Returns tokens + IMAP preset fields for engine.connectOAuthAccount.
 * The callback page stays open until `complete` so "Connected" means the account was saved.
 * A repeat of that callback, including one that arrives while save is still finishing, gets the same page.
 */
async function signIn(providerInput, purposeInput, options) {
  const provider = normalizeProvider(providerInput);
  if (!provider) throw new Error("Choose Google or Microsoft.");
  const purpose = normalizePurpose(purposeInput);
  const creds = credentials(provider);
  const scope = scopesFor(provider, purpose);
  const controller = new AbortController();
  const external = options && options.signal;
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", () => controller.abort(), { once: true });
  }
  activeController = controller;
  const signal = controller.signal;
  const timeoutMs = options && Number.isFinite(options.timeoutMs) ? options.timeoutMs : 180000;
  const open = (options && options.openBrowser) || openBrowser;
  const fetchImpl = options && options.fetchImpl;
  let pending = null;
  let server = null;
  try {
    const listened = await listenOnce();
    server = listened.server;
    throwIfAborted(signal);
    const port = listened.port;
    // Paths stay stable so Entra registrations match. The port is chosen here.
    const pathName = redirectPath(provider, purpose);
    const redirect = redirectUri(port, provider, purpose);
    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const url = authorizeUrl(provider, purpose, {
      clientId: creds.clientId,
      redirectUri: redirect,
      state,
      challenge,
    });

    const codePromise = waitForCode(server, state, pathName, timeoutMs, signal);
    codePromise.catch(() => {});
    try {
      await open(url);
    } catch (error) {
      controller.abort();
      throw error;
    }
    throwIfAborted(signal);
    pending = await codePromise;
    throwIfAborted(signal);
    const tokens = await exchange(provider, creds, pending.code, redirect, verifier, scope, fetchImpl);
    throwIfAborted(signal);
    if (!tokens.refreshToken && purpose !== "organize") {
      throw new Error("Provider did not return a refresh token. Approve offline access and try again.");
    }
    const profile = await fetchProfile(provider, tokens.accessToken, purpose, tokens.idToken, fetchImpl);
    throwIfAborted(signal);
    if (!profile.email) throw new Error("Provider did not return an email address.");
    const preset = IMAP_PRESETS[provider];
    return {
      provider,
      purpose,
      email: profile.email,
      displayName: profile.displayName || "",
      username: profile.email,
      profile: preset.profile,
      imap: preset.imap,
      smtp: preset.smtp,
      authKind: "oauth2",
      requestedScopes: scope,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      grantedScopes: tokens.grantedScopes,
      complete: (outcome) => pending.complete(outcome),
    };
  } catch (error) {
    if (pending && pending.complete) pending.complete({ ok: false, message: safeOauthMessage(error) });
    else if (server) {
      try { server.close(); } catch { /* waitForCode owns the close after a callback */ }
    }
    throw error;
  } finally {
    if (activeController === controller) activeController = null;
  }
}

async function accessTokenFor(account, secretBlob) {
  let parsed;
  try {
    parsed = JSON.parse(secretBlob);
  } catch {
    throw new Error("Stored OAuth secret is corrupt. Connect the account again.");
  }
  if (!parsed.refreshToken) throw new Error("Missing refresh token. Connect the account again.");
  const provider = normalizeProvider(
    parsed.provider || (account.profile === "gmail" ? "google" : account.profile === "outlook" ? "microsoft" : "")
  ) || providerKey(account && account.profile);
  if (!provider) throw new Error("Stored OAuth secret is missing a provider. Connect the account again.");
  if (parsed.expiresAt && parsed.accessToken && Date.now() < parsed.expiresAt - 60000) {
    return parsed.accessToken;
  }
  if (provider === "google" && !oauthReady().google) {
    const error = new Error("Google Desktop OAuth is not configured.");
    error.code = "oauth_not_ready";
    throw error;
  }
  const creds = credentials(provider);
  const scope = parsed.requestedScopes || parsed.grantedScopes || SCOPES[provider];
  const next = await refresh(provider, creds, parsed.refreshToken, scope, parsed.grantedScopes);
  return {
    token: next.accessToken,
    store: JSON.stringify({
      ...parsed,
      ...next,
      provider,
      requestedScopes: parsed.requestedScopes || scope,
    }),
  };
}

module.exports = {
  signIn,
  refresh,
  accessTokenFor,
  oauthReady,
  normalizeProvider,
  normalizePurpose,
  fetchProfile,
  cancelActive,
  SCOPES,
};
