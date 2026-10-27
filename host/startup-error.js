const fs = require("fs");
const path = require("path");

// Shown when the mailbox cannot be opened. The Dock process must not stay up
// with zero windows. Mail files are left where they are.

function startupFailureDialog(error, file) {
  const reason = String(error instanceof Error ? error.message : error || "Unknown error").slice(0, 2000);
  const lines = [reason, "", "Your mailbox files were not deleted."];
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
    <p>A large mailbox can take a moment. Your mail stays on this computer.</p>
    <p id="startup-index-progress" hidden></p>
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

module.exports = { startupFailureDialog, startupStatusHtml, startupIndexProgressScript };
