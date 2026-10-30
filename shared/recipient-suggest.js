/* Local recipient suggestions. No provider calls, contacts scopes, or writes. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./compose-policy"));
  else root.morrowRecipientSuggest = factory(root.morrowComposePolicy);
})(typeof window === "object" ? window : globalThis, function (policy) {
  // One extra sighting is worth a week against the latest time we saw the address.
  const EXTRA_SIGHTING_MS = 7 * 24 * 60 * 60 * 1000;
  const SUGGEST_LIMIT = 8;

  function cleanName(value) {
    if (typeof value !== "string") return "";
    const text = value.trim().replace(/^"(.*)"$/, "$1").trim();
    if (!text || text.length > 200 || /[\u0000-\u001f\u007f]/.test(text)) return "";
    return text;
  }

  function nameFromHeader(value, email) {
    const text = String(value || "").trim();
    const match = text.match(/^(.*)<[^<>]+>\s*$/);
    if (!match) return "";
    const name = cleanName(match[1]);
    if (!name || name.toLowerCase() === email) return "";
    return name;
  }

  function people(row) {
    const out = [];
    const fromEmail = policy.address(row.from_address) || policy.address(row.from_addr);
    if (fromEmail) {
      const name = typeof row.from_display_name === "string"
        ? cleanName(row.from_display_name)
        : nameFromHeader(row.from_addr, fromEmail);
      out.push({ email: fromEmail, name });
    }
    for (const field of ["to_json", "cc_json", "bcc_json"]) {
      let list = row[field];
      if (typeof list === "string") {
        try { list = JSON.parse(list || "[]"); } catch { list = []; }
      }
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const email = policy.address(typeof item === "string" ? item : (item && (item.address || item.email)));
        if (!email) continue;
        const source = typeof item === "string" ? item : (item && (item.name ? item.name + " <" + email + ">" : email));
        out.push({ email, name: nameFromHeader(source, email) });
      }
    }
    return out;
  }

  function score(row) {
    return row.lastSeen + (row.count - 1) * EXTRA_SIGHTING_MS;
  }

  function rank(rows) {
    const seen = new Set();
    const by = new Map();
    for (const row of rows || []) {
      if (!row || Number(row.is_draft) === 1) continue;
      const messageKey = String(row.account_id || "") + "\0" + String(row.gmail_id || row.id || "");
      const seenAt = Number(row.list_sort_ts) || 0;
      for (const person of people(row)) {
        const once = messageKey + "\0" + person.email;
        if (seen.has(once)) continue;
        seen.add(once);
        let slot = by.get(person.email);
        if (!slot) {
          slot = { email: person.email, name: "", count: 0, lastSeen: 0 };
          by.set(person.email, slot);
        }
        slot.count += 1;
        if (seenAt >= slot.lastSeen) {
          slot.lastSeen = seenAt;
          if (person.name) slot.name = person.name;
        } else if (!slot.name && person.name) slot.name = person.name;
      }
    }
    return [...by.values()].sort((a, b) => score(b) - score(a) || b.lastSeen - a.lastSeen || a.email.localeCompare(b.email));
  }

  function queryOf(token) {
    const text = String(token || "").trim().toLowerCase();
    if (!text) return "";
    const angle = text.lastIndexOf("<");
    const sliced = angle >= 0 ? text.slice(angle + 1).replace(/[>"]/g, "").trim() : text;
    return sliced.replace(/[\u0000-\u001f]/g, "").slice(0, 200);
  }

  function parts(value) {
    const text = String(value ?? "");
    let quote = false;
    let angle = false;
    let cut = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote && ch === "\\") { i += 1; continue; }
      if (ch === '"') { quote = !quote; continue; }
      if (!quote && ch === "<") { angle = true; continue; }
      if (!quote && ch === ">") { angle = false; continue; }
      if (!quote && !angle && (ch === "," || ch === ";")) cut = i;
    }
    if (cut < 0) return { head: "", token: text };
    return { head: text.slice(0, cut + 1), token: text.slice(cut + 1) };
  }

  function activeQuery(value) {
    return queryOf(parts(value).token);
  }

  function usedAddresses(value) {
    return new Set(policy.addresses(parts(value).head));
  }

  function matches(row, needle) {
    if (row.email.includes(needle)) return true;
    const name = (row.name || "").toLowerCase();
    return !!(name && name.includes(needle));
  }

  function filter(ranked, query) {
    const needle = typeof query === "string" ? queryOf(query) : "";
    if (!needle) return [];
    const out = [];
    for (const row of ranked || []) {
      if (!matches(row, needle)) continue;
      out.push({ email: row.email, name: row.name || "" });
      if (out.length >= SUGGEST_LIMIT) break;
    }
    return out;
  }

  function formatRecipient(email, name) {
    const address = policy.address(email);
    if (!address) return "";
    const clean = cleanName(name);
    if (!clean) return address;
    if (/["<>,;]/.test(clean)) return `"${clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" <${address}>`;
    return `${clean} <${address}>`;
  }

  function applyChoice(value, choice) {
    const label = formatRecipient(choice && choice.email, choice && choice.name);
    if (!label) return String(value ?? "");
    const head = parts(value).head;
    const gap = head && !/\s$/.test(head) ? " " : "";
    return head + gap + label + ", ";
  }

  function keyAction(key, open, index) {
    if (!open) return "";
    if (key === "ArrowDown") return "next";
    if (key === "ArrowUp") return "prev";
    if (key === "Escape") return "close";
    if (key === "Enter" && Number(index) >= 0) return "choose";
    return "";
  }

  return {
    EXTRA_SIGHTING_MS,
    SUGGEST_LIMIT,
    rank,
    filter,
    activeQuery,
    usedAddresses,
    applyChoice,
    keyAction,
    parts,
  };
});
