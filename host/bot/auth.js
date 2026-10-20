"use strict";

const crypto = require("crypto");
const fs = require("fs");
const {
  DEFAULT_EXPIRY_DAYS,
  MAX_ACCOUNTS,
  MAX_EXPIRY_DAYS,
} = require("./constants");
const { CAPABILITIES, DEFAULT_CAPABILITIES } = require("./catalog");
const { accessPath, writePrivate } = require("./store");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^mmb_v1_([A-Za-z0-9_-]{8,32})\.([A-Za-z0-9_-]{40,80})$/;
const STORE_KEYS = ["version", "enabled", "installationId", "serveHost", "grants"];
const GRANT_KEYS = [
  "clientId", "label", "keyId", "verifier", "accountIds", "capabilities",
  "installationId", "createdAt", "expiry", "revokedAt", "revision",
  "lastUsedAt", "bytesDay", "bytesToday", "draftsDay", "draftsToday",
];

function publicError(message, code) {
  const error = new Error(message);
  error.publicMessage = message;
  error.code = code || "bot";
  return error;
}

function digestToken(token) {
  return crypto.createHash("sha256").update("morrow-bot-v1\0", "utf8").update(token, "utf8").digest();
}

function emptyStore() {
  return {
    version: 2,
    enabled: false,
    installationId: crypto.randomUUID(),
    serveHost: "",
    grants: [],
  };
}

function sameKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const seen = Object.keys(value);
  if (seen.length !== keys.length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function expiryValid(expiry) {
  if (!expiry || typeof expiry !== "object" || Array.isArray(expiry)) return false;
  if (expiry.kind === "never") return Object.keys(expiry).length === 1;
  if (expiry.kind !== "finite") return false;
  const keys = Object.keys(expiry);
  if (keys.length !== 2 || typeof expiry.expiresAt !== "string") return false;
  return Number.isFinite(Date.parse(expiry.expiresAt));
}

function expiryAllows(expiry, now) {
  if (!expiryValid(expiry)) return false;
  if (expiry.kind === "never") return true;
  return Date.parse(expiry.expiresAt) > now;
}

function copyExpiry(expiry) {
  if (expiry && expiry.kind === "never") return { kind: "never" };
  return { kind: "finite", expiresAt: expiry.expiresAt };
}

function migrateStore(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.version === 2) return parsed;
  if (parsed.version !== 1 || !Array.isArray(parsed.grants)) return null;
  const grants = [];
  for (const grant of parsed.grants) {
    if (!grant || typeof grant !== "object" || Array.isArray(grant)) return null;
    const next = { ...grant, expiry: { kind: "finite", expiresAt: grant.expiresAt } };
    delete next.expiresAt;
    grants.push(next);
  }
  return { ...parsed, version: 2, grants };
}

function validGrant(grant, installationId) {
  if (!sameKeys(grant, GRANT_KEYS)) return false;
  if (!UUID.test(grant.clientId) || !UUID.test(grant.installationId)) return false;
  if (grant.installationId !== installationId) return false;
  if (typeof grant.label !== "string" || grant.label.length < 1 || grant.label.length > 60) return false;
  if (typeof grant.keyId !== "string" || !/^[A-Za-z0-9_-]{8,32}$/.test(grant.keyId)) return false;
  if (typeof grant.verifier !== "string" || !/^[0-9a-f]{64}$/.test(grant.verifier)) return false;
  if (!Array.isArray(grant.accountIds) || grant.accountIds.length < 1 || grant.accountIds.length > MAX_ACCOUNTS) return false;
  if (!Array.isArray(grant.capabilities) || !grant.capabilities.length) return false;
  if (grant.capabilities.some((cap) => !CAPABILITIES.includes(cap))) return false;
  if (typeof grant.createdAt !== "string" || !expiryValid(grant.expiry)) return false;
  if (grant.revokedAt != null && typeof grant.revokedAt !== "string") return false;
  if (grant.lastUsedAt != null && typeof grant.lastUsedAt !== "string") return false;
  if (!Number.isInteger(grant.revision) || grant.revision < 1) return false;
  if (typeof grant.bytesDay !== "string" || !Number.isInteger(grant.bytesToday) || grant.bytesToday < 0) return false;
  if (typeof grant.draftsDay !== "string" || !Number.isInteger(grant.draftsToday) || grant.draftsToday < 0) return false;
  return true;
}

function validate(parsed) {
  if (!sameKeys(parsed, STORE_KEYS)) return null;
  if (parsed.version !== 2 || typeof parsed.enabled !== "boolean") return null;
  if (!UUID.test(parsed.installationId)) return null;
  if (typeof parsed.serveHost !== "string" || parsed.serveHost.length > 253) return null;
  if (!Array.isArray(parsed.grants)) return null;
  if (parsed.grants.some((grant) => !validGrant(grant, parsed.installationId))) return null;
  return parsed;
}

function load() {
  const file = accessPath();
  if (!fs.existsSync(file)) return { ok: true, fresh: true, store: null };
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return { ok: false, fresh: false, store: null };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const migrated = migrateStore(parsed);
    const store = migrated && validate(migrated);
    if (!store) return { ok: false, fresh: false, store: null };
    if (!parsed || parsed.version !== 2) {
      save(store);
    }
    return { ok: true, fresh: false, store };
  } catch {
    return { ok: false, fresh: false, store: null };
  }
}

function save(store) {
  writePrivate(accessPath(), `${JSON.stringify(store, null, 2)}\n`);
}

function dayStamp(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function publicGrant(grant, now = Date.now()) {
  const allowed = expiryAllows(grant.expiry, now);
  const expired = !!(grant.expiry && grant.expiry.kind === "finite" && !allowed);
  return {
    clientId: grant.clientId,
    label: grant.label,
    keyId: grant.keyId,
    accountIds: grant.accountIds.slice(),
    capabilities: grant.capabilities.slice(),
    createdAt: grant.createdAt,
    expiry: copyExpiry(grant.expiry),
    revokedAt: grant.revokedAt,
    revision: grant.revision,
    lastUsedAt: grant.lastUsedAt,
    bytesToday: grant.bytesDay === dayStamp(new Date(now)) ? grant.bytesToday : 0,
    expired,
    live: !grant.revokedAt && allowed,
  };
}

function liveGrant(store, now = Date.now()) {
  return store.grants.some((grant) => {
    if (grant.revokedAt) return false;
    if (!expiryAllows(grant.expiry, now)) return false;
    return grant.accountIds.length > 0 && grant.capabilities.length > 0;
  });
}

function isEnabled() {
  const loaded = load();
  return !!(loaded.ok && loaded.store && loaded.store.enabled);
}

function installationId() {
  const loaded = load();
  if (!loaded.ok || !loaded.store) return null;
  return loaded.store.installationId;
}

function serveHost() {
  const loaded = load();
  if (!loaded.ok || !loaded.store) return "";
  return loaded.store.serveHost || "";
}

function view() {
  const loaded = load();
  if (!loaded.ok) {
    return {
      available: false,
      enabled: false,
      installationId: null,
      serveHost: "",
      grants: [],
    };
  }
  if (!loaded.store) {
    return {
      available: true,
      enabled: false,
      installationId: null,
      serveHost: "",
      grants: [],
      fresh: true,
    };
  }
  return {
    available: true,
    enabled: loaded.store.enabled,
    installationId: loaded.store.installationId,
    serveHost: loaded.store.serveHost,
    grants: loaded.store.grants.map((grant) => publicGrant(grant)),
    fresh: false,
  };
}

function ensureStore() {
  const loaded = load();
  if (!loaded.ok) throw publicError("Bot access storage cannot be read. Morrow did not create a grant.");
  if (!loaded.store) return emptyStore();
  return loaded.store;
}

function normalizeCapabilities(list) {
  if (!Array.isArray(list) || !list.length) {
    throw publicError("Choose at least one capability.");
  }
  const caps = [];
  for (const cap of list) {
    if (typeof cap !== "string" || !CAPABILITIES.includes(cap) || caps.includes(cap)) {
      throw publicError("That capability is not available.");
    }
    caps.push(cap);
  }
  return caps;
}

function normalizeAccounts(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_ACCOUNTS) {
    throw publicError("Choose one to five accounts. A new mailbox is not added to an old grant.");
  }
  const ids = [];
  for (const id of list) {
    if (typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(id) || ids.includes(id)) {
      throw publicError("Choose a connected account.");
    }
    ids.push(id);
  }
  return ids;
}

function expiryFromDays(days) {
  const n = days == null ? DEFAULT_EXPIRY_DAYS : days;
  if (!Number.isInteger(n) || n < 1 || n > MAX_EXPIRY_DAYS) {
    throw publicError("Expiry must be 1 to 30 days.");
  }
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
}

function parseExpiry(input) {
  if (input == null) return { kind: "finite", expiresAt: expiryFromDays(7) };
  if (!input || typeof input !== "object" || Array.isArray(input)) throw publicError("Choose an expiry.");
  if (input.kind === "finite") {
    if (Object.prototype.hasOwnProperty.call(input, "neverConfirmed")) {
      throw publicError("A finite grant does not take an expiry confirmation.");
    }
    return { kind: "finite", expiresAt: expiryFromDays(input.days) };
  }
  if (input.kind === "never") {
    if (input.neverConfirmed !== true) throw publicError("Confirm no expiry before creating that grant.");
    return { kind: "never" };
  }
  throw publicError("Choose an expiry.");
}

function newToken() {
  const keyId = crypto.randomBytes(9).toString("base64url");
  const secret = crypto.randomBytes(32).toString("base64url");
  const token = `mmb_v1_${keyId}.${secret}`;
  return { keyId, token, verifier: digestToken(token).toString("hex") };
}

function blankCounters() {
  return {
    lastUsedAt: null,
    bytesDay: dayStamp(),
    bytesToday: 0,
    draftsDay: dayStamp(),
    draftsToday: 0,
  };
}

function mint(input) {
  const body = input || {};
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label || label.length > 60) throw publicError("Name the client in 1 to 60 characters.");
  const accountIds = normalizeAccounts(body.accountIds);
  const capabilities = normalizeCapabilities(body.capabilities || DEFAULT_CAPABILITIES);
  const expiry = parseExpiry(body.expiry);
  const db = require("../mail/db");
  if (!db.isReady()) throw publicError("Morrow mail storage is not open.");
  for (const id of accountIds) {
    if (!db.accountById(id)) throw publicError("Choose a connected account.");
  }
  const store = ensureStore();
  const token = newToken();
  const grant = {
    clientId: crypto.randomUUID(),
    label,
    keyId: token.keyId,
    verifier: token.verifier,
    accountIds,
    capabilities,
    installationId: store.installationId,
    createdAt: new Date().toISOString(),
    expiry,
    revokedAt: null,
    revision: 1,
    ...blankCounters(),
  };
  store.grants.push(grant);
  try {
    save(store);
  } catch {
    throw publicError("Morrow could not store the grant.");
  }
  return { secret: token.token, grant: publicGrant(grant) };
}

function mutate(clientId, change) {
  const loaded = load();
  if (!loaded.ok || !loaded.store) throw publicError("Bot access storage cannot be read.");
  const store = loaded.store;
  const grant = store.grants.find((item) => item.clientId === clientId);
  if (!grant) throw publicError("That client is not on this installation.");
  change(grant, store);
  try {
    save(store);
  } catch {
    throw publicError("Morrow could not store the grant.");
  }
  return publicGrant(grant);
}

function rotate(clientId) {
  let secret = "";
  const grant = mutate(clientId, (row) => {
    if (row.revokedAt) throw publicError("That client is revoked. Mint a new grant.");
    if (!expiryAllows(row.expiry, Date.now())) throw publicError("That grant has expired. Mint a new one.");
    const token = newToken();
    secret = token.token;
    row.keyId = token.keyId;
    row.verifier = token.verifier;
    row.revision += 1;
  });
  return { secret, grant };
}

function revoke(clientId) {
  return mutate(clientId, (row) => {
    if (!row.revokedAt) row.revokedAt = new Date().toISOString();
    row.revision += 1;
  });
}

function removeGrant(clientId) {
  const loaded = load();
  if (!loaded.ok || !loaded.store) throw publicError("Bot access storage cannot be read.");
  const store = loaded.store;
  const index = store.grants.findIndex((item) => item.clientId === clientId);
  if (index < 0) throw publicError("That client is not on this installation.");
  store.grants.splice(index, 1);
  try {
    save(store);
  } catch {
    throw publicError("Morrow could not store the grant.");
  }
  return view();
}

function setEnabledFlag(enabled) {
  if (typeof enabled !== "boolean") throw publicError("Say whether the bridge is on.");
  const store = ensureStore();
  if (enabled && !liveGrant(store)) {
    throw publicError("Choose an account and mint a grant before enabling the bridge.");
  }
  store.enabled = enabled;
  save(store);
  return view();
}

function setServeHost(value) {
  const host = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (host.length > 253) throw publicError("That Serve host is too long.");
  if (host && !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(host)) {
    throw publicError("Serve host must be a hostname and optional port.");
  }
  if (host.startsWith(".") || host.includes("..") || host.includes("*") || host.startsWith("0.0.0.0")) {
    throw publicError("That Serve host is not allowed.");
  }
  const store = ensureStore();
  store.serveHost = host;
  save(store);
  return view();
}

function parseBearer(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9._:-]+)$/.exec(header.trim());
  if (!match) return null;
  const token = match[1];
  const parts = TOKEN.exec(token);
  if (!parts) return null;
  return { keyId: parts[1], token, digest: digestToken(token) };
}

function grantUsable(grant, now) {
  if (!grant || grant.revokedAt) return false;
  return expiryAllows(grant.expiry, now);
}

function authenticate(header) {
  const parsed = parseBearer(header);
  const loaded = load();
  const dummy = Buffer.alloc(32, 1);
  if (!parsed || !loaded.ok || !loaded.store || !loaded.store.enabled) {
    crypto.timingSafeEqual(dummy, dummy);
    return null;
  }
  const grant = loaded.store.grants.find((item) => item.keyId === parsed.keyId);
  const verifier = grant ? Buffer.from(grant.verifier, "hex") : dummy;
  let match = false;
  try {
    match = verifier.length === parsed.digest.length && crypto.timingSafeEqual(verifier, parsed.digest);
  } catch {
    match = false;
  }
  if (!match || !grantUsable(grant, Date.now())) return null;
  if (grant.installationId !== loaded.store.installationId) return null;
  return {
    clientId: grant.clientId,
    keyId: grant.keyId,
    revision: grant.revision,
    digest: parsed.digest,
    accountIds: grant.accountIds.slice(),
    capabilities: grant.capabilities.slice(),
    expiry: copyExpiry(grant.expiry),
    installationId: loaded.store.installationId,
    bytesToday: grant.bytesDay === dayStamp() ? grant.bytesToday : 0,
  };
}

function recheck(ctx) {
  if (!ctx) return false;
  const loaded = load();
  if (!loaded.ok || !loaded.store || !loaded.store.enabled) return false;
  const grant = loaded.store.grants.find((item) => item.clientId === ctx.clientId && item.keyId === ctx.keyId);
  if (!grantUsable(grant, Date.now()) || grant.revision !== ctx.revision) return false;
  const verifier = Buffer.from(grant.verifier, "hex");
  if (verifier.length !== ctx.digest.length) return false;
  return crypto.timingSafeEqual(verifier, ctx.digest);
}

function recordUse(clientId, bytes) {
  const loaded = load();
  if (!loaded.ok || !loaded.store) return;
  const grant = loaded.store.grants.find((item) => item.clientId === clientId);
  if (!grant || grant.revokedAt) return;
  const day = dayStamp();
  if (grant.bytesDay !== day) {
    grant.bytesDay = day;
    grant.bytesToday = 0;
  }
  grant.bytesToday += Math.max(0, Math.round(Number(bytes) || 0));
  grant.lastUsedAt = new Date().toISOString();
  try { save(loaded.store); } catch { /* the response can still finish */ }
}

function noteDraftSubmission(clientId) {
  const loaded = load();
  if (!loaded.ok || !loaded.store) return 0;
  const grant = loaded.store.grants.find((item) => item.clientId === clientId);
  if (!grant) return 0;
  const day = dayStamp();
  if (grant.draftsDay !== day) {
    grant.draftsDay = day;
    grant.draftsToday = 0;
  }
  grant.draftsToday += 1;
  try { save(loaded.store); } catch { /* counted in the draft file too */ }
  return grant.draftsToday;
}

function draftsToday(clientId) {
  const loaded = load();
  if (!loaded.ok || !loaded.store) return 0;
  const grant = loaded.store.grants.find((item) => item.clientId === clientId);
  if (!grant || grant.draftsDay !== dayStamp()) return 0;
  return grant.draftsToday;
}

module.exports = {
  CAPABILITIES,
  DEFAULT_CAPABILITIES,
  publicError,
  load,
  view,
  isEnabled,
  installationId,
  serveHost,
  mint,
  rotate,
  revoke,
  removeGrant,
  setEnabledFlag,
  setServeHost,
  authenticate,
  recheck,
  recordUse,
  noteDraftSubmission,
  draftsToday,
  liveGrant,
  digestToken,
};
