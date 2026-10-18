"use strict";

// Release-only. Writes the GitHub Actions secret GOOGLE_DESKTOP_OAUTH_JSON to
// resources/google-oauth.json for electron-builder extraResources. Never prints
// the client id or client secret. A missing or invalid Desktop client fails the job.

const fs = require("fs");
const path = require("path");

const dest = path.join(__dirname, "..", "resources", "google-oauth.json");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function desktopClient(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    fail("GOOGLE_DESKTOP_OAUTH_JSON is not set. Release builds require the Google Desktop client JSON.");
  }
  const normalized = raw.replace(/^\uFEFF/, "").trim();
  let value;
  try {
    value = JSON.parse(normalized);
  } catch {
    fail("GOOGLE_DESKTOP_OAUTH_JSON is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.web) {
    fail("GOOGLE_DESKTOP_OAUTH_JSON must be a Google Desktop client JSON (installed), not a web client.");
  }
  const installed = value.installed;
  if (!installed || typeof installed !== "object" || Array.isArray(installed)) {
    fail("GOOGLE_DESKTOP_OAUTH_JSON must include an installed Desktop client.");
  }
  const clientId = String(installed.client_id || "").trim();
  const clientSecret = String(installed.client_secret || "").trim();
  if (!/\.apps\.googleusercontent\.com$/.test(clientId) || !clientSecret) {
    fail(
      "GOOGLE_DESKTOP_OAUTH_JSON must include installed.client_id ending in .apps.googleusercontent.com and installed.client_secret."
    );
  }
  let parsed;
  try {
    parsed = require("../host/mail/oauth-config").parseGoogleDesktopJson(normalized);
  } catch {
    fail("GOOGLE_DESKTOP_OAUTH_JSON was rejected by the app Desktop client parser.");
  }
  if (parsed.clientId !== clientId || parsed.clientSecret !== clientSecret) {
    fail("GOOGLE_DESKTOP_OAUTH_JSON did not match the app Desktop client parser.");
  }
  return { normalized, clientId, clientSecret };
}

function main() {
  const client = desktopClient(process.env.GOOGLE_DESKTOP_OAUTH_JSON);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `${client.normalized}\n`, { mode: 0o600 });
  fs.chmodSync(dest, 0o600);
  let written;
  try {
    written = require("../host/mail/oauth-config").parseGoogleDesktopJson(fs.readFileSync(dest, "utf8"));
  } catch {
    fail("resources/google-oauth.json was written but the app cannot parse it.");
  }
  if (written.clientId !== client.clientId || written.clientSecret !== client.clientSecret) {
    fail("resources/google-oauth.json was written but the app parser disagreed.");
  }
  console.log("Wrote resources/google-oauth.json for the release package.");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const raw = String(process.env.GOOGLE_DESKTOP_OAUTH_JSON || "");
    const message = String((error && error.message) || "failed");
    const secret = raw.replace(/^\uFEFF/, "").trim();
    if (secret && message.includes(secret)) console.error("Google Desktop OAuth bake failed.");
    else console.error(message);
    process.exit(1);
  }
}
