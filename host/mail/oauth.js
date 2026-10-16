const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");
const { shell } = require("electron");
const {
  SCOPES,
  ENDPOINTS,
  IMAP_PRESETS,
  credentials,
  oauthReady,
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

function waitForCode(server, expectedState, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { server.close(); } catch { /* */ }
      reject(new Error("OAuth timed out. Keep the app open and try again."));
    }, timeoutMs);

    server.on("request", (req, res) => {
      try {
        const url = new URL(req.url, "http://127.0.0.1");
        if (!url.pathname.endsWith("/callback")) {
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

async function exchange(provider, creds, code, redirectUri, verifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: creds.clientId,
    code_verifier: verifier,
  });
  if (creds.clientSecret) body.set("client_secret", creds.clientSecret);
  if (provider === "microsoft") body.set("scope", SCOPES.microsoft);

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
    grantedScopes: json.scope || SCOPES[provider],
  };
}

async function refresh(provider, creds, refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: creds.clientId,
  });
  if (creds.clientSecret) body.set("client_secret", creds.clientSecret);
  if (provider === "microsoft") body.set("scope", SCOPES.microsoft);
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
    grantedScopes: json.scope || SCOPES[provider],
  };
}

async function fetchEmail(provider, accessToken) {
  const res = await fetch(ENDPOINTS[provider].profile, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Could not read the account profile after OAuth.");
  if (provider === "google") return String(json.emailAddress || json.email || "").trim();
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
async function signIn(providerInput) {
  const provider = normalizeProvider(providerInput);
  if (!provider) throw new Error("Choose Google or Microsoft.");
  const creds = credentials(provider);
  const { server, port } = await listenOnce();
  // Match Morrow-Mail path prefix so the same Entra redirect registration works
  // when Leo adds IMAP scopes; Google Desktop ignores exact localhost port.
  const redirectUri = `http://localhost:${port}/api/oauth/${provider}/callback`;
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());

  const url = new URL(ENDPOINTS[provider].authorize);
  url.searchParams.set("client_id", creds.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES[provider]);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (provider === "google") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  } else {
    url.searchParams.set("prompt", "select_account");
  }

  const codePromise = waitForCode(server, state);
  await shell.openExternal(url.toString());
  const code = await codePromise;
  const tokens = await exchange(provider, creds, code, redirectUri, verifier);
  if (!tokens.refreshToken) {
    throw new Error("Provider did not return a refresh token. Approve offline access and try again.");
  }
  const email = await fetchEmail(provider, tokens.accessToken);
  if (!email) throw new Error("Provider did not return an email address.");
  const preset = IMAP_PRESETS[provider];
  return {
    provider,
    email,
    username: email,
    profile: preset.profile,
    imap: preset.imap,
    smtp: preset.smtp,
    authKind: "oauth2",
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
  const provider = normalizeProvider(account.profile === "gmail" ? "google" : account.profile === "outlook" ? "microsoft" : parsed.provider);
  const creds = credentials(provider);
  if (parsed.expiresAt && parsed.accessToken && Date.now() < parsed.expiresAt - 60000) {
    return parsed.accessToken;
  }
  const next = await refresh(provider, creds, parsed.refreshToken);
  return { token: next.accessToken, store: JSON.stringify({ ...parsed, ...next, provider }) };
}

module.exports = {
  signIn,
  refresh,
  accessTokenFor,
  oauthReady,
  normalizeProvider,
  SCOPES,
};
