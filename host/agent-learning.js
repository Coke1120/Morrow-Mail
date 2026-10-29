// Local Agent corrections. Not Brain categories, triage prompts, or provider rules.
const fs = require("fs");
const path = require("path");
const { userDataDir } = require("./ai-config");

const THRESHOLD = 3;
const MAX_PATTERNS = 80;
const MAX_SENDERS = 12;
const PILES = { "needs-you": "Needs You", fyi: "FYI", other: "Other" };
const ACTIONS = { "mark-read": "Mark as read", reply: "Reply", "reply-all": "Reply All" };

function storePath() {
  return path.join(userDataDir(), "agent-learning.json");
}

function emptyStore() {
  return { version: 1, patterns: [], revoked: {} };
}

function pileId(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "needs-you" || text === "needs you" || text === "todo") return "needs-you";
  if (text === "fyi") return "fyi";
  if (text === "other") return "other";
  return "";
}

function pileName(id) {
  return PILES[id] || "";
}

function addressOf(value) {
  const match = String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : "";
}

function cleanLabel(value, fallback) {
  const text = String(value || "").replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return text || fallback;
}

function suggestionClass(value) {
  return String(value || "").replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function clipId(value) {
  return String(value || "").trim().slice(0, 120);
}

function load() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(storePath(), "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return { ok: true, store: emptyStore() };
    return { ok: false, store: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, store: null };
  const patterns = [];
  for (const row of Array.isArray(parsed.patterns) ? parsed.patterns : []) {
    const next = normalizePattern(row);
    if (next) patterns.push(next);
  }
  const revoked = {};
  const source = parsed.revoked && typeof parsed.revoked === "object" && !Array.isArray(parsed.revoked) ? parsed.revoked : {};
  for (const [id, at] of Object.entries(source)) {
    if (typeof id === "string" && id.length <= 240 && Number.isFinite(at)) revoked[id] = at;
  }
  return { ok: true, store: { version: 1, patterns, revoked } };
}

function normalizePattern(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const id = String(row.id || "");
  const kind = row.kind;
  const count = row.count;
  if (!id || id.length > 240) return null;
  if (kind !== "category" && kind !== "action" && kind !== "suggestion") return null;
  if (!Number.isInteger(count) || count < 1 || count > 100000) return null;
  const next = {
    id,
    kind,
    count,
    learned: count >= THRESHOLD,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
  };
  if (Number.isFinite(row.lastBegunAt)) next.lastBegunAt = row.lastBegunAt;
  if (kind === "category") {
    const fromCategoryId = pileId(row.fromCategoryId);
    const toCategoryId = pileId(row.toCategoryId);
    if (!fromCategoryId || !toCategoryId || fromCategoryId === toCategoryId) return null;
    next.fromCategoryId = fromCategoryId;
    next.toCategoryId = toCategoryId;
    next.fromName = cleanLabel(row.fromName, pileName(fromCategoryId));
    next.toName = cleanLabel(row.toName, pileName(toCategoryId));
    next.senders = [];
    for (const email of Array.isArray(row.senders) ? row.senders : []) {
      const address = addressOf(email);
      if (address && !next.senders.includes(address) && next.senders.length < MAX_SENDERS) next.senders.push(address);
    }
    return next;
  }
  if (kind === "action") {
    if (!ACTIONS[row.action]) return null;
    if (row.scope !== "sender" && row.scope !== "thread") return null;
    const key = row.scope === "sender" ? addressOf(row.key) : clipId(row.key);
    if (!key) return null;
    next.action = row.action;
    next.scope = row.scope;
    next.key = key;
    return next;
  }
  const className = suggestionClass(row.className);
  if ((row.choice !== "open" && row.choice !== "dismiss") || !className) return null;
  next.choice = row.choice;
  next.className = className;
  return next;
}

function write(store) {
  const dest = storePath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, dest);
}

function labelOf(row) {
  if (row.kind === "category") return `${row.fromName} → ${row.toName}`;
  if (row.kind === "action") {
    const who = row.scope === "thread" ? `thread ${row.key}` : row.key;
    return `${ACTIONS[row.action]} · ${who}`;
  }
  const verb = row.choice === "dismiss" ? "Dismiss" : "Open";
  return `${verb} “${row.className}”`;
}

function publicRow(row) {
  const match = row.kind === "category"
    ? { fromCategoryId: row.fromCategoryId, toCategoryId: row.toCategoryId, fromName: row.fromName, toName: row.toName }
    : row.kind === "action"
      ? { action: row.action, scope: row.scope, key: row.key }
      : { class: row.className, choice: row.choice };
  const out = {
    id: row.id,
    kind: row.kind,
    label: labelOf(row),
    count: row.count,
    threshold: THRESHOLD,
    learned: row.learned === true,
    updatedAt: row.updatedAt || "",
    match,
  };
  if (row.kind === "category") out.senders = row.senders.slice();
  if (row.kind === "action") out.actionLabel = ACTIONS[row.action];
  return out;
}

function choiceStamp(row) {
  if (Number.isFinite(row.lastBegunAt)) return row.lastBegunAt;
  const at = Date.parse(row.updatedAt);
  return Number.isFinite(at) ? at : 0;
}

function suppressedClasses(patterns) {
  const times = new Map();
  for (const row of patterns) {
    if (row.kind !== "suggestion" || row.count < THRESHOLD) continue;
    const current = times.get(row.className) || { open: 0, dismiss: 0 };
    current[row.choice] = Math.max(current[row.choice], choiceStamp(row));
    times.set(row.className, current);
  }
  const hidden = [];
  for (const [name, row] of times) {
    if (row.dismiss && row.dismiss >= row.open) hidden.push(name);
  }
  return hidden;
}

function present(store) {
  const patterns = store.patterns.map(publicRow).sort((a, b) => {
    if (a.learned !== b.learned) return a.learned ? -1 : 1;
    return String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.label.localeCompare(b.label);
  });
  return { threshold: THRESHOLD, patterns, suppressed: suppressedClasses(store.patterns) };
}

function list() {
  const loaded = load();
  if (!loaded.ok) return null;
  return present(loaded.store);
}

function allow(store, id, begunAt) {
  const revokedAt = store.revoked[id];
  if (!Number.isFinite(revokedAt)) return true;
  return Number.isFinite(begunAt) && begunAt > revokedAt;
}

function bump(store, id, begunAt, seen, create) {
  if (seen.has(id) || !allow(store, id, begunAt)) return null;
  seen.add(id);
  let row = store.patterns.find((item) => item.id === id);
  if (row && Number.isFinite(begunAt) && row.lastBegunAt === begunAt) return null;
  if (!row) {
    if (store.patterns.length >= MAX_PATTERNS) return null;
    row = create();
    row.id = id;
    row.count = 0;
    store.patterns.push(row);
  }
  row.count += 1;
  row.learned = row.count >= THRESHOLD;
  row.updatedAt = new Date().toISOString();
  if (Number.isFinite(begunAt)) row.lastBegunAt = begunAt;
  return row;
}

function itemsOf(input) {
  const list = Array.isArray(input && input.items) ? input.items : [];
  return list.filter((item) => item && typeof item === "object").slice(0, 40);
}

function senderOf(item) {
  const direct = addressOf(item && (item.from || item.sender || item.email));
  if (direct) return direct;
  const messageId = clipId(item && item.messageId);
  if (!messageId) return "";
  try {
    const row = require("./mail/db").messageById(messageId);
    return addressOf(row && (row.from_addr || row.from));
  } catch {
    return "";
  }
}

function threadOf(item) {
  const direct = clipId(item && item.threadId);
  if (direct) return direct;
  const messageId = clipId(item && item.messageId);
  if (!messageId) return "";
  try {
    const row = require("./mail/db").messageById(messageId);
    return clipId(row && (row.thread_id || row.threadId));
  } catch {
    return "";
  }
}

function rejected(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return true;
  if (input.automatic === true) return true;
  const source = String(input.source || "");
  return source === "learned" || source === "automatic";
}

function begunAtOf(input) {
  const begunAt = Number(input && input.begunAt);
  return Number.isFinite(begunAt) ? begunAt : null;
}

function addSenders(row, senders) {
  for (const email of senders) {
    if (!row.senders.includes(email) && row.senders.length < MAX_SENDERS) row.senders.push(email);
  }
}

function observe(input) {
  const loaded = load();
  if (!loaded.ok) return null;
  if (rejected(input)) return present(loaded.store);
  const store = loaded.store;
  const begunAt = begunAtOf(input);
  const seen = new Set();
  const before = JSON.stringify(store.patterns);
  if (input.kind === "category") {
    const fromCategoryId = pileId(input.fromCategoryId);
    const toCategoryId = pileId(input.toCategoryId);
    if (fromCategoryId && toCategoryId && fromCategoryId !== toCategoryId) {
      const id = `category:${fromCategoryId}:${toCategoryId}`;
      const senders = [];
      for (const item of itemsOf(input)) {
        const email = senderOf(item);
        if (email && !senders.includes(email)) senders.push(email);
      }
      const row = bump(store, id, begunAt, seen, () => ({
        kind: "category",
        fromCategoryId,
        toCategoryId,
        fromName: cleanLabel(input.fromName, pileName(fromCategoryId)),
        toName: cleanLabel(input.toName, pileName(toCategoryId)),
        senders: [],
      }));
      if (row) addSenders(row, senders);
    }
  } else if (input.kind === "action" && ACTIONS[input.action]) {
    for (const item of itemsOf(input)) {
      const email = senderOf(item);
      const thread = threadOf(item);
      if (email) {
        bump(store, `action:${input.action}:sender:${encodeURIComponent(email)}`, begunAt, seen, () => ({
          kind: "action", action: input.action, scope: "sender", key: email,
        }));
      }
      if (thread) {
        bump(store, `action:${input.action}:thread:${encodeURIComponent(thread)}`, begunAt, seen, () => ({
          kind: "action", action: input.action, scope: "thread", key: thread,
        }));
      }
    }
  } else if (input.kind === "suggestion") {
    const className = suggestionClass(input.className || input.class);
    const choice = input.choice === "dismiss" ? "dismiss" : input.choice === "open" ? "open" : "";
    if (className && choice) {
      bump(store, `suggestion:${choice}:${encodeURIComponent(className)}`, begunAt, seen, () => ({
        kind: "suggestion", choice, className,
      }));
    }
  }
  if (JSON.stringify(store.patterns) !== before) write(store);
  return present(store);
}

function forget(params) {
  const loaded = load();
  if (!loaded.ok) return null;
  const id = String(params && params.id || "").trim();
  if (!id || id.length > 240) return present(loaded.store);
  const store = loaded.store;
  if (!store.patterns.some((row) => row.id === id)) return present(store);
  store.patterns = store.patterns.filter((row) => row.id !== id);
  store.revoked[id] = Date.now();
  write(store);
  return present(store);
}

function sanitize(input) {
  if (rejected(input) || !input || input.kind !== "action") return null;
  if (input.action !== "reply" && input.action !== "reply-all") return null;
  const begunAt = begunAtOf(input);
  if (begunAt == null) return null;
  const items = [];
  for (const item of itemsOf(input)) {
    const messageId = clipId(item.messageId);
    if (!messageId) continue;
    const next = { messageId };
    const accountId = clipId(item.accountId);
    const from = String(item.from || "").slice(0, 200);
    const threadId = clipId(item.threadId);
    if (accountId) next.accountId = accountId;
    if (from) next.from = from;
    if (threadId) next.threadId = threadId;
    items.push(next);
  }
  if (!items.length) return null;
  return { kind: "action", action: input.action, begunAt, items, source: "user" };
}

module.exports = {
  THRESHOLD,
  pileId,
  suggestionClass,
  list,
  observe,
  forget,
  sanitize,
  storePath,
};
