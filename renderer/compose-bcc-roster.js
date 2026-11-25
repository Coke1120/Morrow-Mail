"use strict";

(() => {
  const limit = 64_000;
  const recipientFields = ["To", "Cc", "Bcc"];
  const panel = document.getElementById("compose-preview-bcc-roster");
  if (!panel) return;

  const input = document.getElementById("compose-preview-bcc-roster-input");
  const check = document.getElementById("compose-preview-bcc-roster-check");
  const status = document.getElementById("compose-preview-bcc-roster-status");
  const findings = document.getElementById("compose-preview-bcc-roster-findings");

  function address(value) {
    if (value.length > 254) return null;
    const [local, domain, ...rest] = value.split("@");
    if (!domain || rest.length || local.length > 64
        || !/^[a-z\d!#$%&'*+/=?^_`{|}~.-]+$/i.test(local)
        || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
    if (!domain.split(".").every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) return null;
    return local + "@" + domain.toLowerCase();
  }

  function* tokens(value) {
    let quoted = false;
    let angle = false;
    let start = 0;
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (quoted && char === "\\") { i++; continue; }
      if (char === '"') { quoted = !quoted; continue; }
      if (quoted) continue;
      if (char === "<") angle = true;
      else if (char === ">") angle = false;
      else if (!angle && (char === "," || char === ";")) {
        yield value.slice(start, i).trim();
        start = i + 1;
      }
    }
    // Compose autocomplete leaves a trailing separator after a complete recipient.
    const tail = value.slice(start).trim();
    if (tail) yield tail;
  }

  function recipient(token) {
    const named = /^(?:"(?:[^"\\\p{Cc}]|\\[^\p{Cc}])*"[ \t]*|[\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~. \t-]+)?<([^<>\s]+)>$/u.exec(token);
    return address(named ? named[1] : token);
  }

  function compare(text, payload) {
    const roster = new Set();
    const manual = [];
    for (const [index, row] of text.split(/\r\n?|\n/).entries()) {
      if (!row.trim()) continue;
      const mailbox = row.includes("\t") ? null : address(row.trim());
      if (mailbox) roster.add(mailbox);
      else manual.push(`Roster row ${index + 1} needs one bare email address.`);
    }
    if (!roster.size && !manual.length) return null;

    const recipients = new Map();
    for (const field of recipientFields) {
      const value = payload[field.toLowerCase()];
      if (value === undefined) continue;
      if (typeof value !== "string") {
        manual.push(`${field} has an unsupported recipient field.`);
        continue;
      }
      let index = 0;
      for (const token of tokens(value)) {
        index++;
        const mailbox = recipient(token);
        if (!mailbox) {
          manual.push(`${field} recipient ${index} could not be read.`);
          continue;
        }
        if (!recipients.has(mailbox)) recipients.set(mailbox, new Set());
        recipients.get(mailbox).add(field);
      }
    }

    const variants = new Map();
    for (const mailbox of roster) {
      const key = mailbox.toLowerCase();
      if (!variants.has(key)) variants.set(key, new Set());
      variants.get(key).add(mailbox);
    }
    for (const mailbox of recipients.keys()) variants.get(mailbox.toLowerCase())?.add(mailbox);
    const uncertain = new Set();
    for (const group of variants.values()) {
      if (group.size < 2) continue;
      for (const mailbox of group) uncertain.add(mailbox);
      manual.push(`Local-part case differs: ${[...group].join(" / ")}.`);
    }

    const missing = [], extra = [], exposed = [];
    for (const mailbox of roster) {
      const fields = recipients.get(mailbox);
      if (fields?.has("To") || fields?.has("Cc")) exposed.push(`${mailbox} — ${[...fields].join(", ")}`);
      if (!fields && !uncertain.has(mailbox)) missing.push(mailbox);
    }
    for (const [mailbox, fields] of recipients) {
      if (fields.has("Bcc") && !roster.has(mailbox) && !uncertain.has(mailbox)) extra.push(mailbox);
    }
    return { missing, extra, exposed, manual };
  }

  function clearResults() {
    status.textContent = "";
    findings.hidden = true;
    findings.replaceChildren();
  }

  function addFindings(title, rows) {
    if (!rows.length) return;
    const heading = document.createElement("h3");
    heading.textContent = title;
    const list = document.createElement("ul");
    for (const row of rows) {
      const item = document.createElement("li");
      item.textContent = row;
      list.append(item);
    }
    findings.append(heading, list);
    findings.hidden = false;
  }

  function showResults(payload) {
    clearResults();
    if (input.value.length > limit) {
      status.textContent = "Manual review needed. The roster exceeds 64,000 characters.";
      return;
    }
    const result = compare(input.value, payload);
    if (!result) return;
    const { missing, extra, exposed, manual } = result;
    if (manual.length) status.textContent = "Manual review needed. Only recognized addresses were compared.";
    else if (missing.length || extra.length || exposed.length) {
      status.textContent = `${missing.length} missing, ${extra.length} extra in Bcc, ${exposed.length} exposed in To or Cc.`;
    } else status.textContent = "Bcc matches the roster.";
    addFindings("Missing from draft", missing);
    addFindings("Extra in Bcc", extra);
    addFindings("Exposed in To or Cc", exposed);
    addFindings("Manual review", manual);
  }

  window.morrowComposeBccRoster = {
    wire(getPayload) {
      input.addEventListener("input", clearResults);
      check.addEventListener("click", () => {
        const payload = getPayload();
        if (payload) showResults(payload);
      });
      panel.addEventListener("keydown", event => {
        if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
        event.preventDefault();
        event.stopPropagation();
      });
    },
    reset() {
      panel.open = false;
      input.value = "";
      clearResults();
    },
  };
})();
