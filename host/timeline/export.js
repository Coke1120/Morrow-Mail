const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { validateDocument, MAX_BYTES, failure } = require("./validate");

const htmlEscape = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const markdownEscape = value => String(value).replace(/[&<>]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]).replace(/[\\`*_\[\]{}()#+.!|:@~\/-]/g, "\\$&");
const mailbox = value => value ? `${value.name ? `${value.name} ` : ""}<${value.address}>` : "Unknown sender";
const when = (event, timezone) => event.occurred_at === null ? "Unknown date" : new Intl.DateTimeFormat(undefined, { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(event.occurred_at));
const caseSections = [["current_status", "Current status · as of selected correspondence"], ["follow_ups", "Follow-ups for review"], ["gaps", "Unresolved gaps and contradictions"], ["dates", "Mentioned events and deadlines · separate from mail dates"]];

function caseLines(document) {
  if (!document.case_report) return [];
  const scope = document.case_scope;
  const result = [`Case coverage: one account; ${scope.search_count} local searches; ${scope.limited_search_count} limited queries. Neither search nor mailbox is complete. To/Cc are local evidence, not independently supplied to AI.`,
    "Calls, attachment contents and other mailboxes may be missing. Follow-ups are suggestions for review; no task is automatically checked off."];
  for (const [key, title] of caseSections) {
    result.push("", title);
    if (!document.case_report[key].length) result.push("No specific item identified in selected evidence; completeness and completion remain unproven.");
    for (const item of document.case_report[key]) result.push(`${item.kind ? `${item.kind}: ${item.date_text} · ` : ""}${item.text}`, `Uncertainty: ${item.uncertainty}`, `Sources: ${item.source_message_ids.join(", ")}`);
  }
  return result;
}

function json(document) {
  validateDocument(document);
  const output = JSON.stringify(document, null, 2) + "\n";
  return Buffer.byteLength(output) <= MAX_BYTES ? output : JSON.stringify(document);
}

function lines(document) {
  validateDocument(document);
  const coverage = document.coverage;
  const result = [document.title, `Generated: ${document.generated_at} · Display timezone: ${document.display_timezone}`,
    `Mail-timestamp chronology · ${coverage.included_message_count} included / ${coverage.selected_message_count} selected / ${coverage.omitted_message_count} omitted`,
    `Selection truncated: ${coverage.selection_truncated ? "yes" : "no"}. Downloaded mail only; not proof of a complete mailbox.`,
    "AI-generated. Verify summaries, requests and uncertainty against the source mail. This file contains personal information."];
  result.push(...caseLines(document));
  for (const event of document.events) {
    result.push("", `${when(event, document.display_timezone)} · ${event.date_source}`, `From: ${mailbox(event.from)}`,
      `To: ${event.to.map(mailbox).join(", ") || "None recorded"}`, `Cc: ${event.cc.map(mailbox).join(", ") || "None recorded"}`);
    if (event.via_alias) result.push(`Via alias: ${event.via_alias}`);
    if (event.phase) result.push(`Phase: ${event.phase === "main" ? "Main" : "Background"}`);
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

// Compare the ordered (name, address) pairs. A change of label or order is evidence too.
const recipientKey = recipients => JSON.stringify(recipients.map(({ name, address }) => [name || "", address]));

function sharedRecipientLists(events) {
  const lists = new Map();
  for (const { to, cc } of events) {
    for (const recipients of [to, cc]) {
      if (recipients.length < 2) continue;
      const key = recipientKey(recipients);
      const list = lists.get(key);
      if (list) list.uses++;
      else lists.set(key, { recipients, uses: 1 });
    }
  }
  const shared = new Map();
  for (const [key, list] of lists) {
    if (list.uses > 1) shared.set(key, { number: shared.size + 1, recipients: list.recipients });
  }
  return shared;
}

function printHtml(document) {
  validateDocument(document);
  const escape = htmlEscape;
  const coverage = document.coverage;
  const events = [...document.events].sort((a, b) => (a.occurred_at === null) - (b.occurred_at === null)
    || (Date.parse(a.occurred_at) - Date.parse(b.occurred_at)) || a.source_message_id.localeCompare(b.source_message_id));
  const shared = sharedRecipientLists(events);
  const recipientText = recipients => {
    const list = recipients.length > 1 && shared.get(recipientKey(recipients));
    return list ? `Recipient list ${list.number} (${recipients.length})` : recipients.map(mailbox).join(", ");
  };
  const appendix = shared.size ? `<section class="recipient-lists"><h2>Recipient lists</h2>${[...shared.values()].map(({ number, recipients }) =>
    `<h3>Recipient list ${number} (${recipients.length})</h3><p>${escape(recipients.map(mailbox).join(", "))}</p>`).join("")}</section>` : "";
  let day = null;
  const content = events.map((event, index) => {
    const nextDay = event.occurred_at === null ? "Undated correspondence" : new Intl.DateTimeFormat(undefined, { timeZone: document.display_timezone, dateStyle: "long" }).format(new Date(event.occurred_at));
    const heading = nextDay === day ? "" : `<h2>${escape(nextDay)}</h2>`;
    day = nextDay;
    const list = (title, items) => items.length ? `<h3>${title}</h3><ul>${items.map(text => `<li>${escape(text)}</li>`).join("")}</ul>` : "";
    const recipients = [event.to.length && `To: ${recipientText(event.to)}`, event.cc.length && `Cc: ${recipientText(event.cc)}`].filter(Boolean).join(" · ");
    return [
      `<li class="event">${heading}`,
      `<p class="date"><time${event.occurred_at ? ` datetime="${escape(event.occurred_at)}"` : ""}>${index + 1}. ${escape(when(event, document.display_timezone))}</time> · ${escape(event.date_source)} · From: ${escape(mailbox(event.from))}${event.phase ? ` · Phase: ${event.phase === "main" ? "Main" : "Background"}` : ""}</p>`,
      `<p class="summary">${escape(event.summary)}</p>`,
      list("For review", event.open_actions), list("Uncertainty", event.unclear),
      `<div class="evidence"><p>${escape(recipients || "No To or Cc recorded")}</p>`,
      event.via_alias ? `<p>Via alias: ${escape(event.via_alias)}</p>` : "",
      list("Attachment names", event.attachments),
      `<p>Source: ${escape(event.source_thread_id)} / ${escape(event.source_message_id)}</p></div></li>`,
    ].join("");
  }).join("");
  return [
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src 'none'; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'">`,
    `<title>${escape(document.title)}</title>`,
    `<style>@page{size:A4;margin:18mm}*{box-sizing:border-box}body{margin:0 auto;padding:24px;max-width:900px;font:16px system-ui,sans-serif;color:#172b25;background:#fff;line-height:1.55}h1{font-size:28px}h2{font-size:20px}h3{font-size:15px}p,li{white-space:pre-wrap;overflow-wrap:anywhere;orphans:3;widows:3}h1,h2,h3{break-after:avoid}.sequence{list-style:none;padding:0 0 0 14px}.event{position:relative;border-left:2px solid #547568;padding:0 0 28px 22px}.event:before{content:"";position:absolute;width:10px;height:10px;border-radius:50%;background:#547568;left:-6px;top:8px}.summary{font-size:18px;font-weight:600}.date,.evidence{font-size:14px;color:#40564e}.evidence{border-top:1px solid #ccc;margin-top:18px}header{margin-bottom:32px}header p{margin:8px 0}@media(max-width:480px){body{padding:16px}.event{padding-left:16px}.sequence{padding-left:6px}}`,
    `@media print {
      body { padding:0; font-size:11pt; line-height:1.35 }
      header { margin-bottom:12pt }
      .sequence { padding-left:5pt }
      .event { padding:0 0 5pt 10pt; margin:0 0 3pt; break-inside:avoid }
      .event:before { width:5pt; height:5pt; left:-3pt; top:5pt }
      .event p, .event ul, .recipient-lists p { margin:1pt 0 }
      .event h2, .recipient-lists h2 { margin:7pt 0 2pt }
      .event h3, .recipient-lists h3 { font-size:10pt; margin:2pt 0 }
      .date, .evidence { font-size:9.5pt }
      .evidence { border:0; margin:0 }
      .summary { font-size:11pt }
      .recipient-lists { font-size:10pt }
    }</style></head>`,
    `<body><header><h1>${escape(document.title)}</h1>`,
    `<p>Correspondence timeline · oldest first · ${events.length} entries</p>`,
    `<p>Display timezone: ${escape(document.display_timezone)} · Generated: ${escape(document.generated_at)}</p>`,
    `<p>${coverage.included_message_count} included / ${coverage.selected_message_count} selected / ${coverage.omitted_message_count} omitted. Selection truncated: ${coverage.selection_truncated ? "yes" : "no"}. Downloaded mail only; not proof of a complete mailbox.</p>`,
    `<p>AI-generated; verify against source mail. Dates are mail timestamps, not dates of events mentioned in the text. Unknown and older cached timestamps are not reliable date evidence. This file contains personal information.</p>`,
    shared.size ? "<p>Repeated recipient lists are printed once at the end. Each entry identifies its To and Cc lists.</p>" : "",
    `</header>`,
    `<main>${document.case_report ? `<section class="case-report">${caseLines(document).map(line => `<p>${escape(line)}</p>`).join("")}</section><h2>Correspondence · Main / Background</h2>` : ""}<ol class="sequence" aria-label="Correspondence, oldest first; undated mail last">${content}</ol>${appendix}</main></body></html>`,
  ].join("");
}

async function pdf(document, { electron = require("electron"), check = () => {} } = {}) {
  let html = printHtml(document);
  const scheme = "morrow-timeline-print";
  const url = `${scheme}://document/index.html`;
  const partition = electron.session.fromPartition(`timeline-print-${crypto.randomUUID()}`);
  let window;
  partition.protocol.handle(scheme, request => {
    if (request.method !== "GET" || request.url !== url || html === null) return new Response(null, { status: 404 });
    const response = new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    // Chromium prints the loaded page after this one navigation.
    html = null;
    return response;
  });
  try {
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.setPermissionCheckHandler(() => false);
    partition.webRequest.onBeforeRequest((details, callback) => callback({
      cancel: details.method !== "GET" || details.url !== url || details.resourceType !== "mainFrame",
    }));
    window = new electron.BrowserWindow({ show: false, webPreferences: { session: partition, sandbox: true, contextIsolation: true,
      nodeIntegration: false, javascript: false, webSecurity: true, webviewTag: false, spellcheck: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", event => event.preventDefault());
    window.webContents.on("will-attach-webview", event => event.preventDefault());
    check();
    await window.loadURL(url);
    check();
    const output = await window.webContents.printToPDF({ printBackground: false, pageSize: "A4", preferCSSPageSize: true });
    check();
    return output;
  } finally {
    html = null;
    try {
      if (window && !window.isDestroyed()) window.destroy();
    } finally {
      partition.protocol.unhandle(scheme);
      partition.webRequest.onBeforeRequest(null);
      partition.setPermissionRequestHandler(null);
      partition.setPermissionCheckHandler(null);
    }
  }
}

async function exportFile(document, format, { owner, check, electron = require("electron") }) {
  validateDocument(document);
  check();
  const extension = { json: "json", markdown: "md", html: "html", pdf: "pdf" }[format];
  if (!extension) throw failure("timeline-input");
  const parent = electron.BrowserWindow.fromWebContents(electron.webContents.fromId(owner));
  if (!parent || parent.isDestroyed()) throw failure("timeline-cancelled");
  const selected = await electron.dialog.showSaveDialog(parent, { title: "Export timeline", defaultPath: `timeline-${document.timeline_id}.${extension}`,
    filters: [{ name: format === "markdown" ? "Markdown" : format.toUpperCase(), extensions: [extension] }] });
  check();
  if (selected.canceled || !selected.filePath) return { saved: false };
  const output = format === "pdf" ? await pdf(document, { electron, check }) : format === "json" ? json(document) : format === "html" ? printHtml(document) : markdown(document);
  check();
  const temporary = path.join(path.dirname(selected.filePath), `.timeline-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, output, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, selected.filePath);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
  return { saved: true };
}

module.exports = { json, markdown, printHtml, pdf, exportFile, markdownEscape };
