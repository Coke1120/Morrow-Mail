const fs = require("fs");
const path = require("path");
const { userDataDir } = require("./paths");

const GITHUB_OWNER = "Coke1120";
const GITHUB_REPO = "Morrow-Mail";

function tokenFile() {
  return path.join(userDataDir(), "github-update.json");
}

function readFileToken() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(tokenFile(), "utf8"));
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const token = parsed.token || parsed.GH_TOKEN || parsed.githubToken;
  return typeof token === "string" ? token.trim() : "";
}

function resolveGithubToken() {
  const env = String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
  if (env) return env;
  return readFileToken();
}

function missingTokenMessage() {
  return (
    `Updates for the private repo ${GITHUB_OWNER}/${GITHUB_REPO} need a GitHub token with contents read. ` +
    `Set GH_TOKEN or GITHUB_TOKEN, or save {"token":"..."} in ${tokenFile()} (same userData folder as settings.json). ` +
    "Without that token the app does not call the public releases feed, which returns 404 for this private repo."
  );
}

function redact(value) {
  return String(value || "")
    .replace(/ghp_[A-Za-z0-9_]+/g, "[token]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[token]")
    .replace(/Bearer\s+\S+/gi, "Bearer [token]");
}

function explainUpdateError(err) {
  const text = redact(err instanceof Error ? err.message : String(err || ""));
  if (/releases\.atom|authentication token|Bad credentials|\b40[13]\b/i.test(text)) {
    return missingTokenMessage();
  }
  return text || "update failed";
}

module.exports = {
  GITHUB_OWNER,
  GITHUB_REPO,
  tokenFile,
  resolveGithubToken,
  missingTokenMessage,
  explainUpdateError,
};
