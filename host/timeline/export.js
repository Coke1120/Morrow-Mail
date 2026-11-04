const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { validateDocument, MAX_BYTES, failure } = require("./validate");

const htmlEscape = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const markdownEscape = value => String(value).replace(/[&<>]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]).replace(/[\\`*_\[\]{}()#+.!|:@~\/-]/g, "\\$&");
const mailbox = value => value ? `${value.name ? `${value.name} ` : ""}<${value.address}>` : "Unknown sender";
const when = (event, timezone) => event.occurred_at === null ? "Unknown date" : new Intl.DateTimeFormat(undefined, { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(event.occurred_at));

function json(document) {
  validateDocument(document);
  const output = JSON.stringify(document, null, 2) + "\n";
  if (Buffer.byteLength(output) > MAX_BYTES) throw failure("timeline-size");
  return output;
}

function lines(document) {
  validateDocument(document);
  const coverage = document.coverage;
  const result = [document.title, `Generated: ${document.generated_at} · Display timezone: ${document.display_timezone}`,
    `Mail-timestamp chronology · ${coverage.included_message_count} included / ${coverage.selected_message_count} selected / ${coverage.omitted_message_count} omitted`,
    `Selection truncated: ${coverage.selection_truncated ? "yes" : "no"}. Downloaded mail only; not proof of a complete mailbox.`,
    "AI-generated. Verify summaries, requests and uncertainty against the source mail. This file contains personal information."];
  for (const event of document.events) {
    result.push("", `${when(event, document.display_timezone)} · ${event.date_source}`, `From: ${mailbox(event.from)}`,
      `To: ${event.to.map(mailbox).join(", ") || "None recorded"}`, `Cc: ${event.cc.map(mailbox).join(", ") || "None recorded"}`);
    if (event.via_alias) result.push(`Via alias: ${event.via_alias}`);
    result.push(event.summary);
    if (event.attachments.length) result.push(`Attachment names: ${event.attachments.join(", ")}`);
    for (const action of event.open_actions) result.push(`For review: ${action}`);
    for (const unclear of event.unclear) result.push(`Unclear: ${unclear}`);
    result.push(`Source: ${event.source_thread_id} / ${event.source_message_id}`);
  }
  return result;
}

function markdown(document) {
  return lines(document).map((line, index) => `${index === 0 ? "# " : ""}${markdownEscape(line)}`).join("\n\n") + "\n";
}

function printHtml(document) {
  const content = lines(document).map((line, index) => index === 0 ? `<h1>${htmlEscape(line)}</h1>` : `<p>${htmlEscape(line) || "&#160;"}</p>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src 'none'; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'"><title>Timeline</title><style>@page{size:A4;margin:18mm}body{font:11pt system-ui,sans-serif;color:#172b25;line-height:1.55}h1{font-size:20pt}p{white-space:pre-wrap;overflow-wrap:anywhere;orphans:3;widows:3}h1{break-after:avoid}</style></head><body>${content}</body></html>`;
}

async function pdf(document, { electron = require("electron"), check = () => {} } = {}) {
  const partition = electron.session.fromPartition(`timeline-print-${crypto.randomUUID()}`);
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(printHtml(document))}`;
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  partition.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== url || details.resourceType !== "mainFrame" }));
  const window = new electron.BrowserWindow({ show: false, webPreferences: { session: partition, sandbox: true, contextIsolation: true,
    nodeIntegration: false, javascript: false, webSecurity: true, webviewTag: false, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  try {
    check();
    await window.loadURL(url);
    check();
    const output = await window.webContents.printToPDF({ printBackground: false, pageSize: "A4", preferCSSPageSize: true });
    check();
    return output;
  } finally { if (!window.isDestroyed()) window.destroy(); }
}

async function exportFile(document, format, { owner, check, electron = require("electron") }) {
  validateDocument(document);
  check();
  const extension = { json: "json", markdown: "md", pdf: "pdf" }[format];
  if (!extension) throw failure("timeline-input");
  const parent = electron.BrowserWindow.fromWebContents(electron.webContents.fromId(owner));
  if (!parent || parent.isDestroyed()) throw failure("timeline-cancelled");
  const selected = await electron.dialog.showSaveDialog(parent, { title: "Export timeline", defaultPath: `timeline-${document.timeline_id}.${extension}`,
    filters: [{ name: format === "markdown" ? "Markdown" : format.toUpperCase(), extensions: [extension] }] });
  check();
  if (selected.canceled || !selected.filePath) return { saved: false };
  const output = format === "pdf" ? await pdf(document, { electron, check }) : format === "json" ? json(document) : markdown(document);
  check();
  const temporary = path.join(path.dirname(selected.filePath), `.timeline-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, output, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, selected.filePath);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
  return { saved: true };
}

module.exports = { json, markdown, printHtml, pdf, exportFile, markdownEscape };
