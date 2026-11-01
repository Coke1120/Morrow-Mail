"use strict";

const crypto = require("crypto");
const { parseCron, nextCron } = require("../cron");
const { FOLDERS } = require("./constants");

function invalid(message) {
  const error = new Error(message);
  error.publicMessage = message;
  return error;
}

function webhook(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(value)) {
    throw invalid("Use a Tailscale HTTPS webhook or a loopback URL.");
  }
  let url;
  try { url = new URL(value); } catch { throw invalid("Use a valid webhook URL."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const tailnet = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ts\.net$/.test(url.hostname);
  if (url.username || url.password || url.search || url.hash || (!local && !tailnet)
    || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw invalid("Use Tailscale HTTPS (no Funnel) or loopback. URL credentials, queries and fragments are not allowed.");
  }
  return url.toString();
}

function schedule(value) {
  if (value && value.kind === "interval" && Number.isInteger(value.everyMinutes)
    && value.everyMinutes >= 1 && value.everyMinutes <= 10080) {
    return { kind: "interval", everyMinutes: value.everyMinutes };
  }
  if (value && value.kind === "cron" && typeof value.cron === "string" && value.cron.length <= 120) {
    const cron = value.cron.trim().replace(/\s+/g, " ");
    if (parseCron(cron)) return { kind: "cron", cron };
  }
  throw invalid("Choose an interval of 1–10080 minutes or a valid five-field cron.");
}

function nextRun(value, now) {
  return value.kind === "interval" ? new Date(now.getTime() + value.everyMinutes * 60000) : nextCron(value.cron, now);
}

function normalize(input, grant) {
  const includeBody = input && input.includeBody === undefined ? false : input && input.includeBody;
  if (!input || typeof input.enabled !== "boolean" || typeof includeBody !== "boolean") {
    throw invalid("Choose whether proactive notify and cached body text are allowed.");
  }
  if (!Array.isArray(input.accountIds) || !input.accountIds.length || input.accountIds.length > 5
    || new Set(input.accountIds).size !== input.accountIds.length
    || input.accountIds.some(id => !grant.accountIds.includes(id))) {
    throw invalid("Select one or more of this bot’s granted mailboxes.");
  }
  if (!grant.capabilities.includes("mail.headers.read")
    || (includeBody && !grant.capabilities.includes("mail.bodies.read"))) {
    throw invalid("This bot needs cached header permission, and cached message text permission to include bodies.");
  }
  const folder = input.folder === undefined ? "inbox" : input.folder;
  if (!FOLDERS.includes(folder)) throw invalid("Choose a supported cached folder.");
  return { enabled: input.enabled, schedule: schedule(input.schedule), accountIds: input.accountIds.slice().sort(),
    folder, includeBody, webhookUrl: webhook(input.webhookUrl) };
}

function validStored(value, grant) {
  try {
    const normal = normalize(value, grant);
    return Object.keys(value).length === 8 && Object.keys(normal).every(key => JSON.stringify(normal[key]) === JSON.stringify(value[key]))
      && typeof value.secretKey === "string" && (!value.secretKey || new RegExp(`^bot-proactive:${grant.clientId}:[a-f0-9-]{36}$`).test(value.secretKey))
      && (value.consentedAt === null || (typeof value.consentedAt === "string" && Number.isFinite(Date.parse(value.consentedAt))))
      && (!value.enabled || !!value.consentedAt);
  } catch { return false; }
}

function publicConfig(value) {
  if (!value) return null;
  const { secretKey, ...visible } = value;
  return { ...visible, hasSecret: !!secretKey };
}

// The destination/data scope is the cursor identity. Changing only timing or a
// credential keeps delivered IDs; changing the recipient or data resets them.
function binding(grant) {
  const c = grant.proactive;
  return crypto.createHash("sha256").update(JSON.stringify([grant.installationId, grant.clientId,
    grant.platform, c.webhookUrl, c.accountIds, c.folder, c.includeBody])).digest("hex");
}

function configure(input) {
  const auth = require("./auth");
  const secrets = require("../mail/secrets");
  const loaded = auth.load();
  const grant = loaded.store && loaded.store.grants.find(row => row.clientId === input.clientId);
  if (!loaded.ok || !grant || grant.revokedAt || (grant.expiry.kind === "finite" && Date.parse(grant.expiry.expiresAt) <= Date.now())) {
    throw invalid("Choose a bot with valid access.");
  }
  const platform = input.platform;
  if (!Object.hasOwn(auth.PLATFORMS, platform)) throw invalid("Choose Grok Bot or Hermes Agent.");
  // An unconditional stop needs no URL, secret or fresh affirmative consent.
  if (input.stop === true) {
    return auth.mutate(grant.clientId, row => {
      if (row.proactive) row.proactive.enabled = false;
      row.revision += 1;
    });
  }
  const config = normalize(input, grant);
  if (config.enabled && input.backgroundConfirmed !== true) {
    throw invalid("Tick Allow proactive notify to permit background delivery to this webhook.");
  }
  if (!nextRun(config.schedule, new Date())) throw invalid("That cron has no time within the next year.");
  const db = require("../mail/db");
  if (config.accountIds.some(id => !db.isReady() || !db.accountById(id))) throw invalid("Select connected mailboxes.");
  const oldKey = grant.proactive && grant.proactive.secretKey || "";
  const changedDestination = grant.proactive && (config.webhookUrl !== grant.proactive.webhookUrl || platform !== grant.platform);
  if (typeof input.secret !== "undefined" && (typeof input.secret !== "string" || (input.secret && !/^[A-Za-z0-9._~+\/-]{1,2048}={0,2}$/.test(input.secret)))) {
    throw invalid("Use a bearer token without spaces or control characters.");
  }
  let newKey = changedDestination || input.clearSecret === true ? "" : oldKey;
  if (input.secret) {
    newKey = `bot-proactive:${grant.clientId}:${crypto.randomUUID()}`;
    try { secrets.setPassword(newKey, input.secret); } catch { throw invalid("Could not save the webhook token in secure storage."); }
  }
  try {
    const result = auth.mutate(grant.clientId, row => {
      row.platform = platform;
      row.proactive = { ...config, secretKey: newKey, consentedAt: config.enabled ? new Date().toISOString() : null };
      row.revision += 1;
    });
    if (oldKey && oldKey !== newKey) { try { secrets.deletePassword(oldKey); } catch { /* no grant references the retired secret */ } }
    return result;
  } catch (error) {
    if (newKey && newKey !== oldKey) { try { secrets.deletePassword(newKey); } catch { /* never use an uncommitted secret */ } }
    throw error;
  }
}

function forgetSecret(grant) {
  const key = grant && grant.proactive && grant.proactive.secretKey;
  if (key) { try { require("../mail/secrets").deletePassword(key); } catch { /* revoked/deleted grants cannot use it */ } }
}

module.exports = { webhook, schedule, nextRun, normalize, validStored, publicConfig, binding, configure, forgetSecret };
