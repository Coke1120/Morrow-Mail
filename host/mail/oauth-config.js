const fs = require("fs");
const path = require("path");

const MICROSOFT_CLIENT_ID = fs
  .readFileSync(path.join(__dirname, "..", "..", "shared", "microsoft-client-id.txt"), "utf8")
  .trim();

// IMAP XOAUTH2 stays the mail baseline. Organize and calendar are extra consents.
// Morrow-Mail's organize/calendar scope strings are the API side-car; IMAP scopes
// stay on the organize consent too so XOAUTH2 still works when the provider grants both.
const SCOPES = {
  google: "openid email https://mail.google.com/",
  microsoft:
    "offline_access https://outlook.office365.com/IMAP.AccessAsUser.All https://outlook.office365.com/SMTP.Send",
};

const ORGANIZE_SCOPES = {
  google: `${SCOPES.google} https://www.googleapis.com/auth/gmail.modify`,
  microsoft:
    "offline_access User.Read Mail.ReadWrite Mail.Send https://outlook.office365.com/IMAP.AccessAsUser.All https://outlook.office365.com/SMTP.Send",
};

const CALENDAR_SCOPES = {
  google:
    "openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events",
  microsoft: "offline_access User.Read Calendars.ReadWrite",
};

const MARKERS = {
  imap: {
    google: "https://mail.google.com/",
    microsoft: "https://outlook.office365.com/IMAP.AccessAsUser.All",
  },
  organize: {
    google: "https://www.googleapis.com/auth/gmail.modify",
    microsoft: "Mail.ReadWrite",
  },
  calendar: {
    google: "https://www.googleapis.com/auth/calendar.events",
    microsoft: "Calendars.ReadWrite",
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

function loadGoogleClient() {
  const file = (process.env.GENMAIL_GOOGLE_OAUTH_FILE || process.env.MORROW_GOOGLE_OAUTH_FILE || "").trim();
  const raw = (
    process.env.GENMAIL_GOOGLE_OAUTH_JSON ||
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
  const bundled = path.join(__dirname, "..", "..", "resources", "google-oauth.json");
  if (fs.existsSync(bundled)) {
    return parseGoogleDesktopJson(fs.readFileSync(bundled, "utf8"));
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
        "Google Desktop OAuth is not configured. Set GOOGLE_DESKTOP_OAUTH_JSON, GENMAIL_GOOGLE_OAUTH_JSON, or GENMAIL_GOOGLE_OAUTH_FILE (same Desktop JSON as Morrow-Mail)."
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
  if (value === "calendar") return "calendar";
  if (value === "organize" || value === "api" || value === "mail-api") return "organize";
  return "imap";
}

function scopesFor(provider, purpose) {
  const key = providerKey(provider);
  if (!key) return "";
  const name = normalizePurpose(purpose);
  if (name === "calendar") return CALENDAR_SCOPES[key];
  if (name === "organize") return ORGANIZE_SCOPES[key];
  return SCOPES[key];
}

function hasMarker(granted, provider, purpose) {
  const key = providerKey(provider);
  const name = normalizePurpose(purpose);
  const marker = MARKERS[name] && MARKERS[name][key];
  if (!marker) return false;
  return String(granted || "").split(/\s+/).filter(Boolean).includes(marker);
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
  if (key === "google" && normalizePurpose(purpose) === "calendar") {
    return "https://openidconnect.googleapis.com/v1/userinfo";
  }
  return ENDPOINTS[key].profile;
}

function authorizeUrl(provider, purpose, fields) {
  const key = providerKey(provider);
  const scope = scopesFor(key, purpose);
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
    url.searchParams.set("include_granted_scopes", "true");
  } else if (normalizePurpose(purpose) === "imap") {
    url.searchParams.set("prompt", "select_account");
  } else {
    url.searchParams.set("prompt", "consent");
  }
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
        "env GOOGLE_DESKTOP_OAUTH_JSON or GENMAIL_GOOGLE_OAUTH_JSON|FILE or resources/google-oauth.json (Morrow-Mail Desktop client; never commit)",
    },
  };
}

module.exports = {
  MICROSOFT_CLIENT_ID,
  SCOPES,
  ORGANIZE_SCOPES,
  CALENDAR_SCOPES,
  MARKERS,
  ENDPOINTS,
  IMAP_PRESETS,
  credentials,
  loadGoogleClient,
  parseGoogleDesktopJson,
  oauthReady,
  providerKey,
  normalizePurpose,
  scopesFor,
  hasMarker,
  redirectPath,
  redirectUri,
  profileUrl,
  authorizeUrl,
};
