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

function waitForCode(server, expectedState, expectedPath, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { server.close(); } catch { /* */ }
      reject(new Error("OAuth timed out. Keep the app open and try again."));
    }, timeoutMs);

    server.on("request", (req, res) => {
      try {
        const url = new URL(req.url, "http://127.0.0.1");
        if (url.pathname !== expectedPath) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const err = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (err) {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(`<html><body><h1>Sign-in failed</h1><p>${err}</p><p>You can close this window.</p></body></html>`);
          clearTimeout(timer);
          server.close();
          reject(new Error(`OAuth provider error: ${err}`));
          return;
        }
        if (!code || state !== expectedState) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("Invalid OAuth callback");
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><body><h1>Connected</h1><p>Return to GenMail REA. You can close this window.</p></body></html>");
        clearTimeout(timer);
        server.close();
        resolve(code);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function exchange(provider, creds, code, redirect, verifier, scope) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    client_id: creds.clientId,
    code_verifier: verifier,
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
    const detail = json.error || res.status;
    throw new Error(`Token exchange failed (${detail}). Check OAuth client and redirect path.`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || "",
    expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000,
    grantedScopes: json.scope || scope || SCOPES[provider],
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

async function fetchEmail(provider, accessToken, purpose) {
  const res = await fetch(profileUrl(provider, purpose), {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Could not read the account profile after OAuth.");
  if (provider === "google") return String(json.email || json.emailAddress || "").trim();
  return String(json.mail || json.userPrincipalName || "").trim();
}

function normalizeProvider(input) {
  const raw = String(input || "").toLowerCase();
  if (raw === "gmail" || raw === "google") return "google";
  if (raw === "outlook" || raw === "microsoft" || raw === "office365") return "microsoft";
  return null;
}

/**
 * Browser loopback OAuth (PKCE), same shape as Morrow-Mail desktop clients.
 * Returns tokens + IMAP preset fields for engine.connectOAuthAccount.
 */
async function signIn(providerInput, purposeInput) {
  const provider = normalizeProvider(providerInput);
  if (!provider) throw new Error("Choose Google or Microsoft.");
  const purpose = normalizePurpose(purposeInput);
  const creds = credentials(provider);
  const scope = scopesFor(provider, purpose);
  const { server, port } = await listenOnce();
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

  const codePromise = waitForCode(server, state, pathName);
  await openBrowser(url);
  const code = await codePromise;
  const tokens = await exchange(provider, creds, code, redirect, verifier, scope);
  if (!tokens.refreshToken && purpose !== "organize") {
    throw new Error("Provider did not return a refresh token. Approve offline access and try again.");
  }
  const email = await fetchEmail(provider, tokens.accessToken, purpose);
  if (!email) throw new Error("Provider did not return an email address.");
  const preset = IMAP_PRESETS[provider];
  return {
    provider,
    purpose,
    email,
    username: email,
    profile: preset.profile,
    imap: preset.imap,
    smtp: preset.smtp,
    authKind: "oauth2",
    requestedScopes: scope,
    ...tokens,
  };
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
  SCOPES,
};
