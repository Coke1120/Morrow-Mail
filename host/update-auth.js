const GITHUB_OWNER = "Coke1120";
const GITHUB_REPO = "Morrow-Mail";

function githubFeed() {
  // A token selects electron-updater's PrivateGitHubProvider even with private:
  // false. This public repository must always use the anonymous public provider,
  // including when a shell or an old github-update.json contains a token.
  return { provider: "github", owner: GITHUB_OWNER, repo: GITHUB_REPO, private: false };
}

function redact(value) {
  return String(value || "")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[token]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[token]")
    .replace(/Bearer\s+\S+/gi, "Bearer [token]");
}

function explainUpdateError(err) {
  const text = redact(err && err.message ? err.message : String(err || ""));
  const status = Number(err && (err.statusCode || err.status)) ||
    Number((text.match(/(?:^|HTTP[^\d]*|status(?:Code)?[\s:=]+)(401|403|429)\b/i) || [])[1]);
  if (status === 429 || /rate.?limit|secondary rate|abuse detection/i.test(text)) {
    return "GitHub is limiting update requests. Try again later. Public updates do not require a GitHub token.";
  }
  if (status === 401 || status === 403 || /Unauthorized|Forbidden|Bad credentials|authentication token/i.test(text)) {
    return "The public GitHub update request was blocked. Try again later or check your network/proxy. No GitHub token is required.";
  }
  return text || "Update failed.";
}

module.exports = { GITHUB_OWNER, GITHUB_REPO, githubFeed, explainUpdateError };
