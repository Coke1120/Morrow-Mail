"use strict";

// Keep the list input's literal substring behavior separate from token search.
// JavaScript lowercasing handles non-ASCII text consistently with the renderer;
// SQLite LOWER/LIKE are ASCII-only and LIKE interprets % and _ as wildcards.
const composePolicy = require("../../shared/compose-policy");
const textEncoding = require("./text-encoding");
const normalize = value => typeof value === "string" ? value.trim().toLowerCase() : "";
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
  try {
    const value = JSON.parse(json);
    if (Array.isArray(value)) return value;
    if (typeof value === "string" || typeof value?.address === "string" || typeof value?.email === "string") return [value];
  } catch { /* Invalid cached To data has no searchable recipients. */ }
  return [];
}

function matchesDraftTo(json, literal) {
  return Number(savedTo(json).some(value => {
    if (typeof value === "string") return normalize(value).includes(literal);
    const address = value?.address || value?.email;
    if (typeof address !== "string" || !address.trim()) return false;
    const name = typeof value.name === "string" ? value.name : "";
    return normalize(composePolicy.senderPreview(address, name)).includes(literal);
  }));
}

module.exports = { normalize, text, connectedText, savedTo, matchesDraftTo };
