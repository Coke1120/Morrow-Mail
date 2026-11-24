"use strict";

// Keep the list input's literal substring behavior separate from token search.
// JavaScript lowercasing handles non-ASCII text consistently with the renderer;
// SQLite LOWER/LIKE are ASCII-only and LIKE interprets % and _ as wildcards.
const composePolicy = require("../../shared/compose-policy");
const { recipientAt } = require("../../shared/recipient-suggest");
const textEncoding = require("./text-encoding");
const trimmed = value => typeof value === "string" ? value.trim() : "";
const normalize = value => trimmed(value).toLowerCase();
const text = (subject, from, snippet) => `${subject || ""}\n${from || ""}\n${snippet || ""}`.toLowerCase();
function connectedText(subject, from, snippet, displayName, address, uid, draftPending) {
  const sender = address || from || "";
  const parsed = composePolicy.address(sender);
  const bare = parsed && parsed === sender.trim().toLowerCase() ? parsed : "";
  const renderedFrom = displayName && bare ? composePolicy.senderPreview(bare, displayName) : from || "";
  const repair = value => Number(uid) > 0 && !draftPending ? value : textEncoding.repairMojibake(value || "");
  return text(repair(subject), renderedFrom, repair(snippet));
}

function savedTo(json) {
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  return (Array.isArray(value) ? value : [value]).map(item => {
    if (typeof item === "string") return item.trim();
    const address = trimmed(item?.address) || trimmed(item?.email);
    if (!address) return "";
    const name = trimmed(item.name);
    // Compose treats an unquoted comma in a name as another mailbox.
    const label = /["<>,;]/.test(name) ? '"' + name.replace(/["\\]/g, '\\$&') + '"' : name;
    return composePolicy.senderPreview(address, label);
  }).filter(Boolean);
}

function matchesDraftTo(json, literal) {
  return Number(savedTo(json).some(value => normalize(value).includes(literal)));
}

function firstDraftTo(json) {
  const first = savedTo(json)[0] || "";
  if (!/[,;]/.test(first)) return first;
  // Explicit Save can store the whole Compose line in one array entry.
  const part = first.slice(0, recipientAt(first, 0).end).trim();
  return composePolicy.address(part) ? part : first;
}

module.exports = { normalize, text, connectedText, savedTo, matchesDraftTo, firstDraftTo };
