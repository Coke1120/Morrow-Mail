const fs = require("fs");
const path = require("path");

// Shown when the mailbox cannot be opened. The Dock process must not stay up
// with zero windows. Mail files are left where they are.

function startupFailureDialog(error, file) {
  const reason = String(error instanceof Error ? error.message : error || "Unknown error").slice(0, 2000);
  const lines = [reason, "", "Your mailbox files were not deleted."];
  if (["ENOSPC", "SQLITE_FULL"].includes(error?.code) || /\bENOSPC\b|\bSQLITE_FULL\b|database or disk is full|no space left on device/i.test(reason)) {
    lines.unshift("There is not enough free disk space to prepare the local mailbox. Free space on the mailbox drive, then reopen Morrow. Do not delete or rename Morrow's database or journal files.", "");
  }
  if (file) lines.push(String(file));
  return {
    type: "error",
    title: "Morrow Mail",
    message: "Morrow Mail could not finish opening.",
    detail: lines.join("\n"),
    buttons: ["Quit"],
    defaultId: 0,
    noLink: true,
  };
}

// Mailbox-open splash only. The mark is the rail logo, renderer/morrow-icon.svg.
function logoMarkup() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", "renderer", "morrow-icon.svg"), "utf8").trim();
    return raw.replace("<svg ", '<svg class="logo" aria-hidden="true" focusable="false" ');
  } catch {
    // The open message still shows if the mark cannot be read.
    return "";
  }
}

function startupStatusHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Morrow Mail</title>
<style>
  html, body { height: 100%; }
  body {
    margin: 0;
    background: #e7f0e4;
    color: #102822;
    font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  main {
    box-sizing: border-box;
    min-height: 100%;
    padding: 22px 28px 26px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
  }
  .brand { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .logo { width: 56px; height: 56px; display: block; }
  .brand-name { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
  .tagline { margin: 8px 0 0; max-width: 36em; color: #5d756c; font-size: 14px; }
  .status { margin-top: 18px; display: flex; flex-direction: column; align-items: center; }
  /* Same ring as renderer .page-busy-spin. This page is a data URL and cannot import app.css. */
  .page-busy-spin {
    width: 28px;
    height: 28px;
    border: 3px solid rgba(25, 60, 52, 0.18);
    border-top-color: #193c34;
    border-radius: 50%;
    animation: page-busy-spin 0.8s linear infinite;
  }
  h1 { font-size: 18px; font-weight: 650; margin: 14px 0 6px; }
  .status p { margin: 0; max-width: 28em; }
  @keyframes page-busy-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .page-busy-spin { animation: none; }
  }
</style>
</head>
<body>
<main aria-busy="true">
  <div class="brand">
    ${logoMarkup()}
    <p class="brand-name">Morrow Mail</p>
  </div>
  <p class="tagline">The Open Source Email Client with BYOK AI Assistant.</p>
  <div class="status" role="status">
    <span class="page-busy-spin" aria-hidden="true"></span>
    <h1>Opening your mailbox</h1>
    <p id="startup-index-progress">A large mailbox can take a moment. Your mail stays on this computer.</p>
  </div>
</main>
</body>
</html>`;
}

function startupIndexProgressScript(progress) {
  if (!progress || !["building", "ready"].includes(progress.phase)) return "";
  const total = Number.isSafeInteger(progress.total) && progress.total >= 0 ? progress.total : 0;
  const completed = Number.isSafeInteger(progress.completed) ? Math.max(0, Math.min(progress.completed, total)) : 0;
  const text = progress.phase === "ready" ? "Local search is ready."
    : completed === total ? "Finishing local search checks…"
      : `${progress.resumed === true ? "Resuming" : "Preparing"} local search: ${completed} of ${total} saved messages. You can quit and continue next time.`;
  return `(() => { const node = document.getElementById("startup-index-progress"); if (node) { node.hidden = false; node.textContent = ${JSON.stringify(text)}; } })();`;
}

function startupProgressScript(progress) {
  if (!progress) return "";
  if (progress.phase === "search" && ["building", "ready"].includes(progress.searchPhase)) {
    return startupIndexProgressScript({ ...progress, phase: progress.searchPhase });
  }
  const bytes = Number.isSafeInteger(progress.sourceBytes) && progress.sourceBytes > 0 ? progress.sourceBytes : 0;
  const size = bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.ceil(bytes / 1024 ** 2)} MiB`;
  const total = Number.isSafeInteger(progress.total) && progress.total >= 0 ? progress.total : 0;
  const completed = Number.isSafeInteger(progress.completed) ? Math.max(0, Math.min(progress.completed, total)) : 0;
  const totalBytes = Number.isSafeInteger(progress.totalBytes) && progress.totalBytes > 0 ? progress.totalBytes : 0;
  const checked = Number.isSafeInteger(progress.completedBytes) ? Math.max(0, Math.min(progress.completedBytes, totalBytes)) : 0;
  const texts = {
    copy: `Copying the local mailbox${bytes ? ` (${size})` : ""}… Copy progress is indeterminate. Your mail stays on this computer.`,
    journal: `Recovering the durable mail journal${totalBytes ? `: ${Math.floor(checked / totalBytes * 100)}% checked` : ""}… This is not overall startup progress.`,
    migrate: "Updating the local mailbox schema… An individual database update can take a while.",
    initialize: "Publishing the initial local mailbox checkpoint… Waiting for durable disk writes.",
    "body-backfill": `Preparing saved body metadata${Number.isSafeInteger(progress.total) ? `: ${completed} of ${total} pending messages committed` : ""}. You can quit and continue next time.`,
    summaries: "Preparing saved message summaries… Your saved delivery choices are unchanged.",
    search: "Checking local search before opening mail… No mail is downloaded by these checks.",
    admit: "Local search is verified. Finishing local mailbox preparation…",
    ready: "Local mailbox checks are complete. Finishing startup…",
  };
  if (!Object.hasOwn(texts, progress.phase)) return "";
  return `(() => { const node = document.getElementById("startup-index-progress"); if (node) { node.hidden = false; node.textContent = ${JSON.stringify(texts[progress.phase])}; } })();`;
}

module.exports = { startupFailureDialog, startupStatusHtml, startupIndexProgressScript, startupProgressScript };
