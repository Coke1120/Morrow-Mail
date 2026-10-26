/* Shared by the host and the bundled renderer. No provider calls or writes. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.morrowComposePolicy = factory();
})(typeof window === "object" ? window : globalThis, function () {
  function address(value) {
    const text = String(value || "").trim();
    if (/[\r\n\x00]/.test(text)) return "";
    const match = text.match(/<([^<>]+)>/);
    const bare = (match ? match[1] : text).trim().toLowerCase();
    return /^[^\s<>@,;:"\\]+@[^\s<>@,;:"\\]+\.[^\s<>@,;:"\\]+$/.test(bare) ? bare : "";
  }

  function addresses(value) {
    const list = Array.isArray(value) ? value : [value];
    return [...new Set(list.flatMap((item) => {
      if (Array.isArray(item)) return addresses(item);
      if (item && typeof item === "object") return addresses(item.address || item.email || item.value);
      // Split only outside quoted display names and angle brackets.
      return String(item || "").split(/[,;](?=(?:[^"]*"[^"]*")*[^"]*$)(?![^<]*>)/).map(address).filter(Boolean);
    }))];
  }

  function domain(value) {
    const text = String(value || "").trim().toLowerCase().replace(/^@/, "");
    return text.length <= 253 && text.split(".").length > 1 && text.split(".").every((part) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) ? text : "";
  }

  function emptySettings() { return { ccByDomain: {}, bccByDomain: {}, accounts: {} }; }

  function displayName(value) {
    if (typeof value !== "string" || value.length > 200 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value)) {
      throw new Error("Use a sender name of at most 200 characters, without line breaks or control characters.");
    }
    return value.trim();
  }

  function providerName(value) {
    try { return displayName(value || ""); } catch { return ""; }
  }

  // Plain-text preview only. MIME quoting/encoding belongs to MailComposer.
  function senderPreview(email, name) { return name ? name + " <" + email + ">" : email; }

  function normalizeAddressMap(source, label) {
    const entries = Object.entries(source || {});
    if (entries.length > 100) throw new Error(`Use at most 100 ${label} domains.`);
    const map = {};
    for (const [key, value] of entries) {
      const name = domain(key);
      if (!name || !Array.isArray(value) || value.length > 100) throw new Error(`Each ${label} domain needs a list of at most 100 addresses.`);
      const rows = value.map(address);
      if (rows.some((item) => !item)) throw new Error(`Enter valid ${label} email addresses.`);
      if (Object.hasOwn(map, name)) throw new Error(`Each ${label} domain can appear only once.`);
      map[name] = [...new Set(rows)];
    }
    return map;
  }

  function normalizeSettings(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected compose settings.");
    const result = emptySettings();
    result.ccByDomain = normalizeAddressMap(input.ccByDomain, "CC");
    result.bccByDomain = normalizeAddressMap(input.bccByDomain, "BCC");
    const accounts = Object.entries(input.accounts || {});
    if (accounts.length > 100) throw new Error("Too many mailbox mappings.");
    for (const [id, value] of accounts) {
      if (!id || id.length > 200 || ["__proto__", "constructor", "prototype"].includes(id) || !value || typeof value !== "object") throw new Error("Invalid mailbox mapping.");
      const aliases = value.aliases || [];
      if (!Array.isArray(aliases) || aliases.length > 100) throw new Error("Use at most 100 aliases per mailbox.");
      const seen = new Set();
      const mapped = aliases.map((row) => {
        const email = address(row && row.address);
        const key = row && row.domain ? domain(row.domain) : "";
        if (!email || (row.domain && !key) || seen.has(email)) throw new Error("Each alias needs a unique email and an optional valid CC domain.");
        seen.add(email);
        return { address: email, domain: key };
      });
      const preferred = value.preferredFromAddress ? address(value.preferredFromAddress) : "";
      const defaultDomain = value.defaultDomain ? domain(value.defaultDomain) : "";
      if ((value.preferredFromAddress && !preferred) || (value.defaultDomain && !defaultDomain)) throw new Error("Enter a valid preferred From address and default CC domain.");
      result.accounts[id] = { aliases: mapped, preferredFromAddress: preferred, defaultDomain };
      if (value.senderNames != null) {
        if (typeof value.senderNames !== "object" || Array.isArray(value.senderNames)) throw new Error("Expected sender names by exact email address.");
        const entries = Object.entries(value.senderNames);
        if (entries.length > 200) throw new Error("Use at most 200 sender names per mailbox.");
        const names = {};
        for (const [key, name] of entries) {
          const email = address(key);
          if (!email || email !== key.trim().toLowerCase() || Object.hasOwn(names, email)) throw new Error("Each sender name needs a unique exact email address.");
          names[email] = displayName(name);
        }
        result.accounts[id].senderNames = names;
      }
    }
    return result;
  }

  function accountSettings(settings, account) {
    return (settings && settings.accounts && Object.hasOwn(settings.accounts, account.id) && settings.accounts[account.id]) || {};
  }

  function identities(account, settings) {
    const primary = address(account.email);
    const rows = new Map(primary ? [[primary, { email: primary, source: "account", verified: true }]] : []);
    for (const item of account.sendAs || []) {
      const email = address(item.email || item.sendAsEmail);
      if (!email || item.verificationStatus === "pending" || item.verified === false) continue;
      rows.set(email, { ...item, email, source: item.source || "provider" });
    }
    const prefs = accountSettings(settings, account);
    const configured = [...(prefs.aliases || [])];
    if (prefs.preferredFromAddress) configured.push({ address: prefs.preferredFromAddress });
    for (const item of configured) {
      if (!rows.has(item.address)) rows.set(item.address, { email: item.address, source: "configured", verified: false });
    }
    const primaryRow = rows.get(primary);
    const primaryName = primaryRow?.source === "gmail" ? providerName(primaryRow.name) : providerName(account.senderName || account.display_name || account.name);
    return [...rows.values()].map((row) => {
      const ownName = providerName(row.name);
      const defaultName = row.source === "gmail" ? (ownName || primaryName) : (ownName || (row.email === primary ? primaryName : ""));
      const overridden = Object.hasOwn(prefs.senderNames || {}, row.email);
      return { ...row, isPrimary: row.email === primary, defaultName,
        displayName: overridden ? displayName(prefs.senderNames[row.email]) : defaultName,
        nameSource: overridden ? "morrow" : row.source === "gmail" ? "gmail" : defaultName ? "account" : "address",
        nameOverridden: overridden };
    });
  }

  function preferredFrom(account, settings) {
    const rows = identities(account, settings);
    const prefs = accountSettings(settings, account);
    const selected = address(prefs.preferredFromAddress || account.preferredFromAddress);
    return (rows.find((row) => row.email === selected) || rows.find((row) => row.isDefault) || rows[0] || {}).email || "";
  }

  function policyDomain(fromAddress, account, settings) {
    const from = address(fromAddress);
    const prefs = accountSettings(settings, account);
    const mapped = (prefs.aliases || []).find((row) => row.address === from && row.domain);
    if (mapped) return mapped.domain;
    return from.split("@")[1] || "";
  }

  function ccDomain(fromAddress, account, settings, kind) {
    const key = policyDomain(fromAddress, account, settings);
    const prefs = accountSettings(settings, account);
    if ((!kind || kind === "new") && !Object.hasOwn(settings.ccByDomain || {}, key) && prefs.defaultDomain) return prefs.defaultDomain;
    return key;
  }

  function recipientDefaults(fromAddress, account, settings, kind) {
    const policyKey = policyDomain(fromAddress, account, settings);
    const ccKey = ccDomain(fromAddress, account, settings, kind);
    const ccMap = (settings && settings.ccByDomain) || {};
    const bccMap = (settings && settings.bccByDomain) || {};
    return { policyDomain: policyKey, ccDomain: ccKey, cc: ccMap[ccKey] || [], bcc: bccMap[policyKey] || [] };
  }

  function resolve(account, message, settings, kind, explicitFrom) {
    const rows = identities(account, settings);
    const mine = new Set(rows.map((row) => row.email));
    const primary = address(account.email);
    const headers = (message && message.recipientHeaders) || {};
    // Prefer an owned business alias over a delivery hop addressed to primary Gmail.
    const candidates = addresses([
      ...(headers.originalTo || []), ...(headers.envelopeTo || []), ...(headers.deliveredTo || []),
      ...addresses(message && message.to), ...addresses(message && message.cc), ...addresses(message && message.bcc),
    ]).filter((email) => mine.has(email));
    const received = candidates.find((email) => email !== primary) || candidates[0] || "";
    const ownFrom = addresses(message && (message.fromAddress || message.from)).find((email) => mine.has(email));
    const fromAddress = address(explicitFrom) || received || ownFrom || preferredFrom(account, settings);
    const defaults = recipientDefaults(fromAddress, account, settings, kind);
    return { fromAddress, fromDisplayName: rows.find((row) => row.email === fromAddress)?.displayName || "", receivedAddress: received, domain: defaults.ccDomain, policyDomain: defaults.policyDomain,
      sendAs: rows, selfAddresses: [...mine], defaultCc: defaults.cc, defaultBcc: defaults.bcc,
      fallback: !!message && !received && !ownFrom && !explicitFrom };
  }

  function seedRecipients(base, defaults, exclude, self) {
    const seen = new Set(addresses([...(exclude || []), ...(self || [])]));
    for (const email of addresses(base)) seen.add(email);
    const added = addresses(defaults).filter((email) => {
      if (seen.has(email)) return false;
      seen.add(email);
      return true;
    });
    return [String(base || "").trim(), ...added].filter(Boolean).join(", ");
  }

  function openRecipientSeeds(savedRecipients, ccText, bccText) {
    const locked = !!savedRecipients;
    return { cc: { base: ccText == null ? "" : String(ccText), locked }, bcc: { base: bccText == null ? "" : String(bccText), locked } };
  }

  function applyRecipientSeeds(seeds, defaults, fields, self) {
    const lists = defaults || {};
    const current = fields || {};
    const bccExclude = seeds.bcc.locked ? current.bcc : seeds.bcc.base;
    const cc = seeds.cc.locked ? current.cc : seedRecipients(seeds.cc.base, lists.cc, [current.to, bccExclude], self);
    const bcc = seeds.bcc.locked ? current.bcc : seedRecipients(seeds.bcc.base, lists.bcc, [current.to, cc], self);
    return { to: current.to, cc, bcc };
  }

  function normalizeDomainKeys(tokens) {
    if (tokens == null) return [];
    if (!Array.isArray(tokens)) throw new Error("Expected a list of signature domains.");
    if (tokens.length > 100) throw new Error("Use at most 100 signature domains.");
    const seen = new Set();
    const keys = [];
    for (const token of tokens) {
      const name = domain(token);
      if (!name) throw new Error("Enter a valid signature domain.");
      if (seen.has(name)) throw new Error("Each signature domain can appear only once.");
      seen.add(name);
      keys.push(name);
    }
    return keys;
  }

  return { address, addresses, domain, displayName, senderPreview, emptySettings, normalizeSettings, accountSettings, identities, preferredFrom,
    policyDomain, ccDomain, recipientDefaults, resolve, seedRecipients, openRecipientSeeds, applyRecipientSeeds,
    normalizeDomainKeys };
});
