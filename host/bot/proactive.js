"use strict";

// This module only reads the local mail cache and posts data. It has no Agent,
// model, draft or mail-provider dependency and never interprets webhook output.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const auth = require("./auth");
const config = require("./proactive-config");
const reads = require("./reads");
const db = require("../mail/db");
const secrets = require("../mail/secrets");
const audit = require("./audit");
const storage = require("./store");
const transport = require("./proactive-transport");
const { CONTENT_TRUST } = require("./catalog");

const SEEN_LIMIT = 2000;
const WINDOW = 50;
const PER_ACCOUNT = 10;
const RETRY_MS = 20000;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const statePath = () => path.join(storage.bridgeDir(), "bot-proactive-state.json");

function readState() {
  if (!fs.existsSync(statePath())) return { version: 1, bots: {} };
  if (fs.statSync(statePath()).size > 4 * 1024 * 1024) throw new Error("STATE_UNAVAILABLE");
  const state = JSON.parse(fs.readFileSync(statePath(), "utf8"));
  if (!state || state.version !== 1 || !state.bots || Array.isArray(state.bots)) throw new Error("STATE_UNAVAILABLE");
  for (const row of Object.values(state.bots)) {
    if (!row || !/^[a-f0-9]{64}$/.test(row.binding) || !Number.isInteger(row.revision)
      || !Number.isFinite(Date.parse(row.nextRunAt)) || !row.seen || Array.isArray(row.seen)
      || Object.values(row.seen).some(ids => !Array.isArray(ids) || ids.length > SEEN_LIMIT || ids.some(id => !/^[a-f0-9]{64}$/.test(id)))) {
      throw new Error("STATE_UNAVAILABLE");
    }
  }
  return state;
}

function writeState(state) {
  const text = JSON.stringify(state);
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error("STATE_UNAVAILABLE");
  storage.writeDurable(statePath(), text);
}

function buildPayload(grant, seen, now, reader = reads) {
  const c = grant.proactive;
  const payload = { apiVersion: "1.0", kind: "proactive.mail_digest", deliveryId: "",
    installationId: grant.installationId, botId: grant.clientId, platform: grant.platform,
    generatedAt: now.toISOString(), contentTrust: CONTENT_TRUST, accounts: [] };
  const delivered = {};
  for (const accountId of c.accountIds) {
    const cached = reader.listCached(accountId, c.folder, WINDOW);
    const sent = new Set(seen[accountId] || []);
    const account = { accountId, folder: c.folder, messages: [], moreAvailable: cached.moreAvailable, warnings: cached.warnings };
    const candidates = cached.items.filter(message => !sent.has(hash(message.messageId)));
    // Divide the byte budget between granted accounts so a busy first inbox
    // cannot starve other mailboxes. Never advance past an omitted message.
    const budget = Math.floor((transport.MAX_BYTES - 4096) / c.accountIds.length);
    for (const message of candidates) {
      if (account.messages.length >= PER_ACCOUNT) break;
      const item = { ...message, contentTrust: CONTENT_TRUST };
      if (c.includeBody) {
        try {
          const detail = reader.getCached(accountId, message.messageId, 8192, false);
          item.body = detail.body;
          item.warnings = detail.warnings;
        } catch (error) {
          if (error.code === "NOT_FOUND") continue;
          throw error;
        }
      }
      account.messages.push(item);
      if (Buffer.byteLength(JSON.stringify(account)) > budget) { account.messages.pop(); continue; }
    }
    account.moreAvailable ||= candidates.length > account.messages.length;
    delivered[accountId] = account.messages.map(message => hash(message.messageId));
    payload.accounts.push(account);
  }
  if (!payload.accounts.some(account => account.messages.length)) return null;
  payload.deliveryId = hash(JSON.stringify([config.binding(grant), delivered]));
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > transport.MAX_BYTES) throw new Error("PAYLOAD_TOO_LARGE");
  return { payload, body, delivered };
}

function createScheduler(deps = {}) {
  const loadAccess = deps.loadAccess || auth.load;
  const loadState = deps.readState || readState;
  const saveState = deps.writeState || writeState;
  const clock = deps.now || (() => new Date());
  const reader = deps.reads || reads;
  const database = deps.db || db;
  const secretStore = deps.secrets || secrets;
  const post = deps.post || transport.post;
  const record = deps.record || audit.record;
  const listening = deps.listening || (() => require("./server").status().listening);
  const gate = deps.gate || require("../update-quiescence").gate;
  const pending = new Map();
  const controllers = new Map();
  const halted = new Set();
  let paused = false;
  let pumping = false;
  let timer = null;
  let first = null;

  function cancel(clientId) {
    for (const [id, controller] of controllers) if (!clientId || id === clientId) controller.abort();
    for (const id of pending.keys()) if (!clientId || id === clientId) pending.delete(id);
  }
  const unsubscribe = (deps.onChange || auth.onChange)(cancel);

  function allowed(grant) {
    if (paused || gate.closed || !listening() || !database.isReady()) return false;
    const current = loadAccess();
    if (!current.ok || !current.store || !current.store.enabled || current.store.installationId !== grant.installationId) return false;
    const row = current.store.grants.find(item => item.clientId === grant.clientId);
    if (!row || row.revokedAt || row.revision !== grant.revision || row.platform !== grant.platform
      || (row.expiry.kind === "finite" && Date.parse(row.expiry.expiresAt) <= clock().getTime())
      || !row.proactive || !row.proactive.enabled || !row.proactive.consentedAt
      || JSON.stringify(row.proactive) !== JSON.stringify(grant.proactive)) return false;
    return row.proactive.accountIds.every(id => row.accountIds.includes(id) && database.accountById(id))
      && row.capabilities.includes("mail.headers.read") && (!row.proactive.includeBody || row.capabilities.includes("mail.bodies.read"));
  }

  function activity(grant, code, start, bytes = 0, requestId = "") {
    record({ at: clock().toISOString(), clientId: grant.clientId, operation: "proactive.mail_digest", code,
      durationMs: clock().getTime() - start, bytes, requestId });
  }

  function accountIdentity(id) {
    const account = database.accountById(id);
    return account && JSON.stringify([account.id, account.created_at, account.email, account.username,
      account.auth_kind, account.mail_transport, account.gmail_generation]);
  }

  async function deliver(grant, state, row, job) {
    const started = clock().getTime();
    const controller = new AbortController();
    controllers.set(grant.clientId, controller);
    let result;
    let posted = false;
    try {
      const key = grant.proactive.secretKey;
      const revision = key ? secretStore.revision(key) : null;
      const token = key ? await secretStore.getPasswordAsync(key, { signal: controller.signal }) : "";
      if (!allowed(grant) || controller.signal.aborted || (key && secretStore.revision(key) !== revision)
        || job.accountIdentities.some(([id, identity]) => !identity || accountIdentity(id) !== identity)) {
        result = { code: "CANCELLED" };
      } else if (key && !token) {
        result = { code: "WEBHOOK_SECRET_UNAVAILABLE" };
      } else {
        posted = true;
        result = await post(grant.proactive.webhookUrl, job.body, {
          signal: controller.signal, token, deliveryId: job.payload.deliveryId,
        });
      }
    } catch { result = { code: controller.signal.aborted ? "CANCELLED" : "WEBHOOK_UNAVAILABLE" }; }
    finally { controllers.delete(grant.clientId); }
    activity(grant, result.code, started, posted ? Buffer.byteLength(job.body) : 0, job.payload.deliveryId);
    pending.delete(grant.clientId);
    // A Settings mutation owns the newer configuration. Do not publish a stale
    // cursor into it or revive work cancelled during a secret read/POST.
    if (!allowed(grant) || controller.signal.aborted) return;
    row.lastRunAt = clock().toISOString();
    row.lastCode = result.code;
    if (result.code === "OK") {
      for (const [accountId, ids] of Object.entries(job.delivered)) {
        row.seen[accountId] = [...new Set([...(row.seen[accountId] || []), ...ids])].slice(-SEEN_LIMIT);
      }
    } else if (result.retryable && job.attempt < 2) {
      pending.set(grant.clientId, { ...job, attempt: job.attempt + 1, retryAt: clock().getTime() + RETRY_MS, revision: grant.revision });
    }
    try { saveState(state); } catch {
      pending.delete(grant.clientId);
      halted.add(grant.clientId);
      activity(grant, "STATE_UNAVAILABLE", started);
    }
  }

  async function pump() {
    if (pumping || paused || gate.closed) return;
    pumping = true;
    try {
      const loaded = loadAccess();
      if (!loaded.ok || !loaded.store || !loaded.store.enabled || !listening()) return;
      let state;
      try { state = loadState(); } catch {
        record({ operation: "proactive.mail_digest", code: "STATE_UNAVAILABLE" });
        return;
      }
      const ids = new Set(loaded.store.grants.map(grant => grant.clientId));
      for (const id of Object.keys(state.bots)) if (!ids.has(id)) delete state.bots[id];
      for (const grant of loaded.store.grants) {
        if (halted.has(grant.clientId) || !allowed(grant)) continue;
        const now = clock();
        const binding = config.binding(grant);
        let row = state.bots[grant.clientId];
        if (!row || row.revision !== grant.revision || row.binding !== binding) {
          const next = config.nextRun(grant.proactive.schedule, now);
          if (!next) { activity(grant, "SCHEDULE_UNAVAILABLE", now.getTime()); continue; }
          row = { binding, revision: grant.revision, seen: row && row.binding === binding ? row.seen : {},
            nextRunAt: next.toISOString(), lastRunAt: row && row.lastRunAt || null, lastCode: "SCHEDULED" };
          state.bots[grant.clientId] = row;
          saveState(state);
        }
        let job = pending.get(grant.clientId);
        if (job && job.revision !== grant.revision) { pending.delete(grant.clientId); job = null; }
        if (job ? job.retryAt > now.getTime() : Date.parse(row.nextRunAt) > now.getTime()) continue;
        if (!job) {
          const next = config.nextRun(grant.proactive.schedule, now);
          if (!next) continue;
          row.nextRunAt = next.toISOString();
          // Commit the next slot before any await. No catch-up bursts on wake.
          saveState(state);
          try { job = buildPayload(grant, row.seen, now, reader); }
          catch { activity(grant, "CACHE_UNAVAILABLE", now.getTime()); continue; }
          if (!job) { row.lastCode = "NO_NEW_CACHED_MAIL"; row.lastRunAt = now.toISOString(); saveState(state); continue; }
          job.accountIdentities = grant.proactive.accountIds.map(id => [id, accountIdentity(id)]);
          job.attempt = 1;
        }
        if (allowed(grant)) await deliver(grant, state, row, job);
      }
    } catch {
      record({ operation: "proactive.mail_digest", code: "STATE_UNAVAILABLE" });
    } finally { pumping = false; }
  }

  function tick() { if (!paused && !gate.closed) { try { return gate.run(pump); } catch { /* update is closing */ } } }
  function start() {
    paused = false;
    if (timer) return;
    first = setTimeout(() => { tick(); }, 1500);
    timer = setInterval(() => { tick(); }, 20000);
    first.unref?.(); timer.unref?.();
  }
  function pause() { paused = true; cancel(); }
  function resume() { paused = false; }
  function stop() { pause(); clearTimeout(first); clearInterval(timer); first = timer = null; }
  function dispose() { stop(); unsubscribe(); }
  return { start, stop, pause, resume, tick, cancel, dispose };
}

function statuses(grants) {
  try {
    return Object.fromEntries(Object.entries(readState().bots)
      .filter(([id, row]) => (grants || []).some(grant => grant.clientId === id && grant.revision === row.revision))
      .map(([id, row]) => [id,
      { nextRunAt: row.nextRunAt, lastRunAt: row.lastRunAt, lastCode: row.lastCode }]));
  } catch { return {}; }
}

let singleton;
function scheduler() { return singleton || (singleton = createScheduler()); }
module.exports = { createScheduler, buildPayload, readState, statuses,
  start: () => scheduler().start(), stop: () => singleton?.stop(),
  pause: () => singleton?.pause(), resume: () => singleton?.resume() };
