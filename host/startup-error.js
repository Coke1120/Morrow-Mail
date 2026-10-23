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

function startupStatusHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Morrow Mail</title>
<style>
  body { margin: 0; background: #e7f0e4; color: #102822; font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { padding: 28px 32px; }
  h1 { font-size: 20px; font-weight: 650; margin: 12px 0 8px; }
  p { margin: 0; }
  svg { display: block; }
</style>
</head>
<body>
<main>
  <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10"></circle>
    <line x1="12" y1="16" x2="12" y2="12"></line>
    <line x1="12" y1="8" x2="12.01" y2="8"></line>
  </svg>
  <h1>Opening your mailbox</h1>
  <p>A large mailbox can take a moment. Your mail stays on this computer.</p>
</main>
</body>
</html>`;
}

module.exports = { startupFailureDialog, startupStatusHtml };
