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

function githubFeed(token) {
  const feed = {
    provider: "github",
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    private: false,
  };
  const value = typeof token === "string" ? token.trim() : "";
  if (value) feed.token = value;
  return feed;
}

function tokenRejectedMessage() {
  return (
    `The GitHub token configured for ${GITHUB_OWNER}/${GITHUB_REPO} was rejected. ` +
    `Check GH_TOKEN or GITHUB_TOKEN, or the token saved in ${tokenFile()} (same userData folder as settings.json).`
  );
}

function feedNeedsAuthMessage() {
  return (
    `The update feed for ${GITHUB_OWNER}/${GITHUB_REPO} requires a GitHub token with contents read. ` +
    `Set GH_TOKEN or GITHUB_TOKEN, or save {"token":"..."} in ${tokenFile()} (same userData folder as settings.json).`
  );
}

function authFailureKind(message) {
  if (message === tokenRejectedMessage()) return "rejected";
  if (message === feedNeedsAuthMessage()) return "required";
  return "";
}

function redact(value) {
  return String(value || "")
    .replace(/ghp_[A-Za-z0-9_]+/g, "[token]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[token]")
    .replace(/Bearer\s+\S+/gi, "Bearer [token]");
}

function httpStatus(err) {
  if (!err || typeof err !== "object") return 0;
  const code = Number(err.statusCode || err.status || 0);
  return code === 401 || code === 403 ? code : 0;
}

function isAuthFailure(err, text) {
  if (httpStatus(err)) return true;
  return /authentication token|Bad credentials|\b401\b|\b403\b|Unauthorized|Forbidden/i.test(text);
}

function explainUpdateError(err) {
  const text = redact(err instanceof Error ? err.message : String(err || ""));
  if (!isAuthFailure(err, text)) return text || "update failed";
  return resolveGithubToken() ? tokenRejectedMessage() : feedNeedsAuthMessage();
}

module.exports = {
  GITHUB_OWNER,
  GITHUB_REPO,
  tokenFile,
  resolveGithubToken,
  githubFeed,
  tokenRejectedMessage,
  feedNeedsAuthMessage,
  authFailureKind,
  explainUpdateError,
};
