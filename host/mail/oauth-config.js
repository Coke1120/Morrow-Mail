const fs = require("fs");
const path = require("path");

const MICROSOFT_CLIENT_ID = fs
  .readFileSync(path.join(__dirname, "..", "..", "shared", "microsoft-client-id.txt"), "utf8")
  .trim();

// IMAP XOAUTH2 scopes (genmail-rea is IMAP-based). Morrow-Mail uses Graph/Gmail API scopes;
// Leo may need to add these IMAP scopes on the same Entra / Google Desktop clients.
const SCOPES = {
  google: "openid email https://mail.google.com/",
  microsoft:
    "offline_access https://outlook.office365.com/IMAP.AccessAsUser.All https://outlook.office365.com/SMTP.Send",
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
  const raw = (process.env.GENMAIL_GOOGLE_OAUTH_JSON || process.env.MORROW_GOOGLE_OAUTH_JSON || "").trim();
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
        "Google Desktop OAuth is not configured. Set GENMAIL_GOOGLE_OAUTH_JSON or GENMAIL_GOOGLE_OAUTH_FILE (same Desktop JSON as Morrow-Mail GOOGLE_DESKTOP_OAUTH_JSON)."
      );
    }
    return { provider: "google", clientId: google.clientId, clientSecret: google.clientSecret, public: false };
  }
  throw new Error(`Unsupported OAuth provider: ${provider}`);
}

function oauthReady() {
  return {
    microsoft: Boolean(MICROSOFT_CLIENT_ID),
    google: Boolean(loadGoogleClient()),
    microsoftClientId: MICROSOFT_CLIENT_ID,
    source: {
      microsoft: "shared/microsoft-client-id.txt (from Morrow-Mail; public desktop client)",
      google:
        "env GENMAIL_GOOGLE_OAUTH_JSON|FILE or resources/google-oauth.json (from Morrow-Mail secret GOOGLE_DESKTOP_OAUTH_JSON; never commit)",
    },
  };
}

module.exports = {
  MICROSOFT_CLIENT_ID,
  SCOPES,
  ENDPOINTS,
  IMAP_PRESETS,
  credentials,
  loadGoogleClient,
  parseGoogleDesktopJson,
  oauthReady,
};
