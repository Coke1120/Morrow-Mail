const fs = require("fs");
const path = require("path");

const MICROSOFT_CLIENT_ID = fs
  .readFileSync(path.join(__dirname, "..", "..", "shared", "microsoft-client-id.txt"), "utf8")
  .trim();

// Legacy scope sets also describe the minimum permissions for each feature.
// Google mail excludes Calendar; Microsoft keeps Outlook and Graph
// on separate authorize URLs, code exchanges, and refreshes.
const SCOPES = {
  google: "openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.settings.basic",
  microsoft:
    "offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
};

const ORGANIZE_SCOPES = {
  google: "openid email https://www.googleapis.com/auth/gmail.modify",
  microsoft: "offline_access User.Read Mail.ReadWrite Mail.Send",
};

const CALENDAR_SCOPES = {
  google:
    "openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events",
  microsoft: "offline_access User.Read Calendars.ReadWrite",
};

// Gmail settings.basic is not included in gmail.modify.
const RULES_SCOPES = {
  google:
    "openid email https://www.googleapis.com/auth/gmail.settings.basic https://www.googleapis.com/auth/gmail.modify",
  microsoft: "offline_access User.Read MailboxSettings.ReadWrite Mail.Read",
};

const VACATION_SCOPES = {
  google: "openid email https://www.googleapis.com/auth/gmail.settings.basic",
  microsoft: "offline_access User.Read MailboxSettings.ReadWrite",
};

const BUNDLE_SCOPES = Object.fromEntries(["google", "microsoft"].map((provider) => [
  provider,
  [...new Set([ORGANIZE_SCOPES, CALENDAR_SCOPES, RULES_SCOPES, VACATION_SCOPES]
    .filter(scopes => provider !== "google" || scopes !== CALENDAR_SCOPES)
    .flatMap((scopes) => scopes[provider].split(" ")))].join(" "),
]));

const MARKERS = {
  imap: {
    google: "https://www.googleapis.com/auth/gmail.modify",
    microsoft: "https://outlook.office.com/IMAP.AccessAsUser.All",
  },
  organize: {
    google: "https://www.googleapis.com/auth/gmail.modify",
    microsoft: "Mail.ReadWrite",
  },
  calendar: {
    google: "https://www.googleapis.com/auth/calendar.events",
    microsoft: "Calendars.ReadWrite",
  },
  rules: {
    google: "https://www.googleapis.com/auth/gmail.settings.basic",
    microsoft: "MailboxSettings.ReadWrite",
  },
  vacation: {
    google: "https://www.googleapis.com/auth/gmail.settings.basic",
    microsoft: "MailboxSettings.ReadWrite",
  },
};

const ENDPOINTS = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    profile: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
  },
  microsoft: {
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    profile: "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName",
  },
};

const IMAP_PRESETS = {
  google: {
    profile: "gmail",
    imap: { host: "imap.gmail.com", port: 993, tls: true },
    smtp: { host: "smtp.gmail.com", port: 465, tls: true },
  },
  microsoft: {
    profile: "outlook",
    imap: { host: "outlook.office365.com", port: 993, tls: true },
    smtp: { host: "smtp.office365.com", port: 587, tls: true },
  },
};

function parseGoogleDesktopJson(source) {
  const value = typeof source === "string" ? JSON.parse(source) : source;
  if (!value || typeof value !== "object" || value.web) {
    throw new Error("Use a Google Desktop OAuth client JSON (installed), not a web client.");
  }
  const installed = value.installed || value;
  const clientId = String(installed.client_id || "").trim();
  const clientSecret = String(installed.client_secret || "").trim();
  if (!/\.apps\.googleusercontent\.com$/.test(clientId) || !clientSecret) {
    throw new Error("Google Desktop OAuth JSON is missing client_id or client_secret.");
  }
  return { clientId, clientSecret };
}

function googleClientFiles() {
  const files = [path.join(__dirname, "..", "..", "resources", "google-oauth.json")];
  if (process.resourcesPath) files.push(path.join(process.resourcesPath, "google-oauth.json"));
  return files;
}

function loadGoogleClient() {
  const file = (process.env.MORROW_GOOGLE_OAUTH_FILE || "").trim();
  const raw = (
    process.env.MORROW_GOOGLE_OAUTH_JSON ||
    process.env.GOOGLE_DESKTOP_OAUTH_JSON ||
    ""
  ).trim();
  if (file) {
    return parseGoogleDesktopJson(fs.readFileSync(file, "utf8"));
  }
  if (raw) {
    return parseGoogleDesktopJson(raw);
  }
  for (const bundled of googleClientFiles()) {
    if (fs.existsSync(bundled)) return parseGoogleDesktopJson(fs.readFileSync(bundled, "utf8"));
  }
  return null;
}

function credentials(provider) {
  if (provider === "microsoft" || provider === "outlook") {
    return {
      provider: "microsoft",
      clientId: MICROSOFT_CLIENT_ID,
      clientSecret: "",
      public: true,
    };
  }
  if (provider === "google" || provider === "gmail") {
    const google = loadGoogleClient();
    if (!google) {
      throw new Error(
        "Google Desktop OAuth is not configured. Set GOOGLE_DESKTOP_OAUTH_JSON, MORROW_GOOGLE_OAUTH_JSON, or MORROW_GOOGLE_OAUTH_FILE (same Desktop JSON as Morrow-Mail)."
      );
    }
    return { provider: "google", clientId: google.clientId, clientSecret: google.clientSecret, public: false };
  }
  throw new Error(`Unsupported OAuth provider: ${provider}`);
}

function providerKey(provider) {
  const raw = String(provider || "").toLowerCase();
  if (raw === "gmail" || raw === "google") return "google";
  if (raw === "outlook" || raw === "microsoft" || raw === "office365") return "microsoft";
  return "";
}

function normalizePurpose(input) {
  const raw = typeof input === "object" && input ? input.purpose : input;
  const value = String(raw || "imap").toLowerCase();
  if (value === "bundle") return "bundle";
  if (value === "calendar") return "calendar";
  if (value === "rules" || value === "filters" || value === "inbox-rules") return "rules";
  if (value === "vacation" || value === "out-of-office" || value === "ooo") return "vacation";
  if (value === "organize" || value === "api" || value === "mail-api") return "organize";
  return "imap";
}

function scopesFor(provider, purpose) {
  const key = providerKey(provider);
  if (!key) return "";
  const name = normalizePurpose(purpose);
  if (name === "bundle") return BUNDLE_SCOPES[key];
  if (name === "calendar") return CALENDAR_SCOPES[key];
  if (name === "rules") return RULES_SCOPES[key];
  if (name === "vacation") return VACATION_SCOPES[key];
  if (name === "organize") return ORGANIZE_SCOPES[key];
  return SCOPES[key];
}

function decodeScopeText(value) {
  let text = Array.isArray(value) ? value.join(" ") : String(value || "");
  text = text.trim();
  for (let pass = 0; pass < 2 && /%[0-9A-Fa-f]{2}/.test(text); pass += 1) {
    try {
      const next = decodeURIComponent(text.replace(/\+/g, "%20"));
      if (next === text) break;
      text = next;
    } catch {
      break;
    }
  }
  return text;
}

function normalizeScopeToken(scope) {
  return String(scope || "")
    .trim()
    .replace(/^(IMAP\.AccessAsUser\.All|SMTP\.Send)$/i, "https://outlook.office.com/$1")
    .replace(/^https:\/\/graph\.microsoft\.com\//i, "")
    .replace(/^00000003-0000-0000-c000-000000000000\//i, "")
    .replace(/^https:\/\/www\.googleapis\.com\/auth\/userinfo\.email$/i, "email")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function hasMarker(granted, provider, purpose) {
  const key = providerKey(provider);
  const name = normalizePurpose(purpose);
  const marker = MARKERS[name] && MARKERS[name][key];
  if (!marker) return false;
  const needle = normalizeScopeToken(marker);
  if (!needle) return false;
  if (key === "google" && ["imap", "organize"].includes(name) && hasScopes(granted, "https://mail.google.com/")) return true;
  return decodeScopeText(granted)
    .split(/[\s,]+/)
    .map(normalizeScopeToken)
    .filter(Boolean)
    .includes(needle);
}

function hasScopes(granted, required) {
  const tokens = new Set(decodeScopeText(granted).split(/[\s,]+/).map(normalizeScopeToken));
  return decodeScopeText(required).split(/[\s,]+/).filter(Boolean).every((scope) => tokens.has(normalizeScopeToken(scope)));
}

function tokenScopeText(scopes) {
  return [...new Set(decodeScopeText(scopes).split(/[\s,]+/).filter(Boolean).map((scope) => scope
    .replace(/^IMAP\.AccessAsUser\.All$/i, "https://outlook.office.com/IMAP.AccessAsUser.All")
    .replace(/^SMTP\.Send$/i, "https://outlook.office.com/SMTP.Send")))].join(" ");
}

// Gate the entire feature, not just one marker from a partial consent.
function hasPurposeScopes(granted, provider, purpose) {
  const key = providerKey(provider);
  if (!key) return false;
  if (key === "google") {
    const name = normalizePurpose(purpose);
    if (name === "bundle") return ["organize", "rules", "vacation"].every(value => hasPurposeScopes(granted, key, value));
    if (name === "imap" || name === "organize") return hasMarker(granted, key, name);
    if (name === "rules") return hasScopes(granted, "https://www.googleapis.com/auth/gmail.settings.basic")
      && (hasMarker(granted, key, "organize") || hasScopes(granted, "https://www.googleapis.com/auth/gmail.labels"));
  }
  if (purpose === "bundle") return ["organize", "calendar", "rules", "vacation"].every((name) => hasPurposeScopes(granted, key, name));
  let required = scopesFor(key, purpose).split(" ").filter((scope) => !["openid", "email", "offline_access", "User.Read"].includes(scope));
  if (purpose === "organize" && key === "google") required = required.filter((scope) => scope !== "https://mail.google.com/");
  if (purpose === "rules" && key === "microsoft" && hasScopes(granted, "Mail.ReadWrite")) required = required.filter((scope) => scope !== "Mail.Read");
  return hasScopes(granted, required.join(" "));
}

// Recover saved metadata using the resource selected by the caller. Never add
// permissions from requestedScopes to a partial grantedScopes record.
function microsoftResourceScopes(scopes, purpose) {
  const allowed = new Map(scopesFor("microsoft", normalizePurpose(purpose) === "imap" ? "imap" : "bundle")
    .split(" ").map(scope => [normalizeScopeToken(scope), scope]));
  for (const scope of ["openid", "profile", "email"]) allowed.set(scope, scope);
  return [...new Set(decodeScopeText(scopes).split(/[\s,]+/)
    .map(scope => allowed.get(normalizeScopeToken(scope))).filter(Boolean))].join(" ");
}

function assertResourceScopes(provider, scopes) {
  if (providerKey(provider) !== "microsoft") return;
  const tokens = tokenScopeText(scopes).split(" ").filter(Boolean);
  const outlook = tokens.some((scope) => /^https:\/\/outlook\.office\.com\//i.test(scope));
  if (outlook && tokens.some((scope) => !/^https:\/\/outlook\.office\.com\//i.test(scope) && !/^(offline_access|openid|profile|email)$/i.test(scope))) {
    throw new Error("Microsoft token requests must target either Outlook mail or Graph features. This request combines both resources; reconnect the affected mailbox or feature if the problem persists.");
  }
}

function redirectPath(provider, purpose) {
  const key = providerKey(provider);
  if (!key) return "";
  if (normalizePurpose(purpose) === "calendar") return `/api/calendar-oauth/${key}/callback`;
  return `/api/oauth/${key}/callback`;
}

function redirectUri(port, provider, purpose) {
  const pathName = redirectPath(provider, purpose);
  const number = Number(port);
  if (!pathName || !Number.isInteger(number) || number <= 0 || number > 65535) return "";
  return `http://localhost:${number}${pathName}`;
}

function profileUrl(provider, purpose) {
  const key = providerKey(provider);
  if (!key) return "";
  const name = normalizePurpose(purpose);
  if (key === "google" && (name === "bundle" || name === "calendar" || name === "rules" || name === "vacation")) {
    return "https://openidconnect.googleapis.com/v1/userinfo";
  }
  return ENDPOINTS[key].profile;
}

function authorizeUrl(provider, purpose, fields) {
  const key = providerKey(provider);
  const scope = scopesFor(key, purpose);
  assertResourceScopes(key, scope);
  const redirect = fields && fields.redirectUri;
  if (!key || !scope || !redirect || !fields.clientId || !fields.state || !fields.challenge) {
    throw new Error("OAuth authorize URL is incomplete.");
  }
  const url = new URL(ENDPOINTS[key].authorize);
  url.searchParams.set("client_id", fields.clientId);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", fields.state);
  url.searchParams.set("code_challenge", fields.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (key === "google") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    // Request the reviewed feature scope set, without silently accumulating an
    // old full-mail grant. Google's returned scopes remain the source of truth.
    url.searchParams.set("include_granted_scopes", "false");
  } else if (normalizePurpose(purpose) === "imap" && !fields.loginHint) {
    url.searchParams.set("prompt", "select_account");
  }
  if (key === "microsoft" && fields.loginHint) url.searchParams.set("login_hint", fields.loginHint);
  return url.toString();
}

function oauthReady() {
  return {
    microsoft: Boolean(MICROSOFT_CLIENT_ID),
    google: Boolean(loadGoogleClient()),
    microsoftClientId: MICROSOFT_CLIENT_ID,
    source: {
      microsoft: "shared/microsoft-client-id.txt (from Morrow-Mail; public desktop client)",
      google:
        "env GOOGLE_DESKTOP_OAUTH_JSON or MORROW_GOOGLE_OAUTH_JSON|FILE, resources/google-oauth.json, or process.resourcesPath/google-oauth.json (packaged; never commit)",
    },
  };
}

module.exports = {
  MICROSOFT_CLIENT_ID,
  SCOPES,
  ORGANIZE_SCOPES,
  CALENDAR_SCOPES,
  BUNDLE_SCOPES,
  RULES_SCOPES,
  VACATION_SCOPES,
  MARKERS,
  ENDPOINTS,
  IMAP_PRESETS,
  credentials,
  googleClientFiles,
  loadGoogleClient,
  parseGoogleDesktopJson,
  oauthReady,
  providerKey,
  normalizePurpose,
  scopesFor,
  hasMarker,
  hasPurposeScopes,
  hasScopes,
  tokenScopeText,
  assertResourceScopes,
  microsoftResourceScopes,
  redirectPath,
  redirectUri,
  profileUrl,
  authorizeUrl,
};
