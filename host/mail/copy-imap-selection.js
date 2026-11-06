"use strict";

const unsupported = message => Object.assign(new Error(message), { code: "copy_unsupported", operationIssued: false });

// ImapFlow 2.5.0 deliberately drops unrecognized valueless SELECT response
// codes. Capture UIDNOTSTICKY at its structured exec boundary, before that
// parser discards it. No protocol literals, headers or message bytes are logged.
async function persistentSelection(transport, select, check = () => {}) {
  const original = transport.exec;
  if (typeof original !== "function") throw unsupported("This IMAP transport cannot prove persistent UID selection responses.");
  let observed = false, notSticky = false, result;
  const inspect = response => {
    const section = response?.attributes?.[0]?.section;
    if (String(section?.[0]?.value || "").toUpperCase() === "UIDNOTSTICKY") notSticky = true;
  };
  transport.exec = async function (command, attributes, options = {}) {
    if (!["SELECT", "EXAMINE"].includes(String(command).toUpperCase())) return original.call(this, command, attributes, options);
    observed = true;
    const untagged = { ...(options.untagged || {}) };
    for (const name of ["OK", "NO", "BAD"]) {
      const handler = untagged[name] || this.untaggedHandlers?.[name];
      untagged[name] = async response => { inspect(response); return typeof handler === "function" ? handler.call(this, response) : undefined; };
    }
    const value = await original.call(this, command, attributes, { ...options, untagged });
    inspect(value?.response); return value;
  };
  try {
    check(); result = await select(); check();
    if (!observed || notSticky || transport.mailbox?.uidNotSticky) throw unsupported("This folder does not prove persistent UIDs (UIDNOTSTICKY or unobserved selection). Copy was not uploaded.");
    return result;
  } catch (error) { result?.release?.(); throw error; }
  finally { transport.exec = original; }
}

module.exports = { persistentSelection };
