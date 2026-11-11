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
module.exports = { normalize, text, connectedText };
