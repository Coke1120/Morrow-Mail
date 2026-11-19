// In-memory activity only. No message identifiers/content enter public snapshots.
const { randomUUID } = require("node:crypto");
const SOURCES = new Set(["open", "visible", "overnight"]);
const REASONS = new Set(["source-limit", "incomplete", "download-failed", "message-changed", "rate-limit"]);

function createBodyProgress({ onChange = () => {}, now = Date.now, validateIncomplete = () => false } = {}) {
  const session = randomUUID();
  const startedAt = now();
  const tasks = new Map(), last = new Map(), incomplete = new Map();
  let sequence = 0, next = 0;
  const changed = () => { sequence++; try { onChange(); } catch { /* activity reporting cannot interrupt mail work */ } };
  function queue(accountId, source, generation = 0) {
    const token = ++next;
    tasks.set(token, { accountId, generation, source: SOURCES.has(source) ? source : "open", running: false });
    changed(); return token;
  }
  function start(token) {
    const task = tasks.get(token);
    if (task) { task.running = true; changed(); }
  }
  function confirmedIncomplete(accountId, generation, identity) {
    try { return !!validateIncomplete(accountId, generation, identity); }
    catch { return false; }
  }
  function finish(token, result, identity) {
    const task = tasks.get(token);
    if (!task) return;
    tasks.delete(token);
    if (result && token >= (last.get(task.accountId)?.token || 0)) {
      last.set(task.accountId, { token, generation: task.generation, source: task.source, at: now(),
        result: result === "done" ? "done" : result === "source-limit" ? "limited" : "error",
        reason: REASONS.has(result) ? result : "" });
    }
    const candidate = incomplete.get(task.accountId);
    if (result === "incomplete" && identity
      && (!candidate || task.generation > candidate.generation
        || (task.generation === candidate.generation && token >= candidate.token))
      && confirmedIncomplete(task.accountId, task.generation, identity)) {
      incomplete.set(task.accountId, { token, generation: task.generation, identity });
    }
    changed();
  }
  function incompleteTarget(accountId, generation) {
    const candidate = incomplete.get(accountId);
    if (!candidate) return null;
    if (candidate.generation !== generation || !confirmedIncomplete(accountId, generation, candidate.identity)) {
      incomplete.delete(accountId);
      if (last.get(accountId)?.token === candidate.token) last.delete(accountId);
      return null;
    }
    return { accountId, messageId: candidate.identity.id };
  }
  function snapshot({ accounts, queued = [], online = true, sleeping = false, night = false, horizonDays = 0 }) {
    const ids = new Set(accounts.map(a => a.id));
    for (const id of last.keys()) if (!ids.has(id)) last.delete(id);
    for (const id of incomplete.keys()) if (!ids.has(id)) incomplete.delete(id);
    const rows = accounts.map(account => {
      const generation = account.generation || 0;
      const canOpenIncomplete = !!incompleteTarget(account.id, generation);
      const pending = [...tasks.values()].filter(t => t.accountId === account.id && t.generation === generation);
      const running = pending.find(t => t.running);
      const waiting = pending[0] || queued.find(t => t.accountId === account.id && (t.generation || 0) === generation);
      const previous = last.get(account.id)?.generation === generation ? last.get(account.id) : null;
      let state = "idle", reason = "", source = running?.source || waiting?.source || previous?.source || "";
      if (running) { state = "running"; reason = sleeping ? "sleeping" : !online ? "offline" : ""; }
      else if (sleeping || !online || account.needsConnection || account.pausedUntil > now()) {
        state = "paused";
        reason = sleeping ? "sleeping" : !online ? "offline" : account.needsConnection ? "connection" : "rate-limit";
      } else if (waiting) {
        state = "queued"; reason = account.busy ? "mail-work" : "turn";
      } else if (["error", "limited"].includes(previous?.result)) { state = previous.result; reason = previous.reason; }
      return { accountId: account.id, state, reason, source, canOpenIncomplete,
        lastResult: previous?.result || "", lastActivityAt: previous?.at || null };
    });
    return { session, startedAt, sequence, at: now(), night, horizonDays, accounts: rows };
  }
  return { queue, start, finish, snapshot, changed, incompleteTarget };
}
module.exports = { createBodyProgress };
