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

  function emptySettings() { return { ccByDomain: {}, accounts: {} }; }

  function normalizeSettings(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected compose settings.");
    const result = emptySettings();
    const entries = Object.entries(input.ccByDomain || {});
    if (entries.length > 100) throw new Error("Use at most 100 CC domains.");
    for (const [key, value] of entries) {
      const name = domain(key);
      if (!name || !Array.isArray(value) || value.length > 100) throw new Error("Each CC domain needs a list of at most 100 addresses.");
      const rows = value.map(address);
      if (rows.some((item) => !item)) throw new Error("Enter valid CC email addresses.");
      if (Object.hasOwn(result.ccByDomain, name)) throw new Error("Each CC domain can appear only once.");
      result.ccByDomain[name] = [...new Set(rows)];
    }
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
    return [...rows.values()];
  }

  function preferredFrom(account, settings) {
    const rows = identities(account, settings);
    const prefs = accountSettings(settings, account);
    const selected = address(prefs.preferredFromAddress || account.preferredFromAddress);
    return (rows.find((row) => row.email === selected) || rows.find((row) => row.isDefault) || rows[0] || {}).email || "";
  }

  function ccDomain(fromAddress, account, settings, kind) {
    const from = address(fromAddress);
    const prefs = accountSettings(settings, account);
    const mapped = (prefs.aliases || []).find((row) => row.address === from && row.domain);
    if (mapped) return mapped.domain;
    const key = from.split("@")[1] || "";
    if ((!kind || kind === "new") && !Object.hasOwn(settings.ccByDomain || {}, key) && prefs.defaultDomain) return prefs.defaultDomain;
    return key;
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
    const ownFrom = addresses(message && message.from).find((email) => mine.has(email));
    const fromAddress = address(explicitFrom) || received || ownFrom || preferredFrom(account, settings);
    const key = ccDomain(fromAddress, account, settings, kind);
    return { fromAddress, receivedAddress: received, domain: key, sendAs: rows,
      selfAddresses: [...mine], defaultCc: (settings.ccByDomain || {})[key] || [],
      fallback: !!message && !received && !ownFrom && !explicitFrom };
  }

  function seedCc(baseCc, defaults, to, bcc, self) {
    const seen = new Set(addresses([to, bcc, ...(self || [])]));
    // Keep the original Reply All/display-name text; append only missing defaults.
    for (const email of addresses(baseCc)) seen.add(email);
    const added = addresses(defaults).filter((email) => {
      if (seen.has(email)) return false;
      seen.add(email);
      return true;
    });
    return [String(baseCc || "").trim(), ...added].filter(Boolean).join(", ");
  }

  return { address, addresses, domain, emptySettings, normalizeSettings, accountSettings, identities, preferredFrom, ccDomain, resolve, seedCc };
});
