// In-memory activity only. No message identifiers/content enter public snapshots.
const { randomUUID } = require("node:crypto");
const SOURCES = new Set(["open", "visible", "overnight"]);
const REASONS = new Set(["source-limit", "incomplete", "download-failed", "message-changed", "rate-limit"]);

function createBodyProgress({ onChange = () => {}, now = Date.now } = {}) {
  const session = randomUUID();
  const startedAt = now();
  const tasks = new Map(), last = new Map();
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
  function finish(token, result) {
    const task = tasks.get(token);
    if (!task) return;
    tasks.delete(token);
    if (result && token >= (last.get(task.accountId)?.token || 0)) {
      last.set(task.accountId, { token, generation: task.generation, source: task.source, at: now(),
        result: result === "done" ? "done" : result === "source-limit" ? "limited" : "error",
        reason: REASONS.has(result) ? result : "" });
    }
    changed();
  }
  function snapshot({ accounts, queued = [], online = true, sleeping = false, night = false, horizonDays = 0 }) {
    const ids = new Set(accounts.map(a => a.id));
    for (const id of last.keys()) if (!ids.has(id)) last.delete(id);
    const rows = accounts.map(account => {
      const generation = account.generation || 0;
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
      return { accountId: account.id, state, reason, source,
        lastResult: previous?.result || "", lastActivityAt: previous?.at || null };
    });
    return { session, startedAt, sequence, at: now(), night, horizonDays, accounts: rows };
  }
  return { queue, start, finish, snapshot, changed };
}
module.exports = { createBodyProgress };
