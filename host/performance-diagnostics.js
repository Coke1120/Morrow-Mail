"use strict";

const { performance, monitorEventLoopDelay } = require("node:perf_hooks");

// Fixed labels only: never accept SQL, request values, errors, paths or ids.
const STAGES = new Set([
  "startup.mail", "startup.db", "startup.migrate", "startup.index",
  "db.transaction", "db.index", "db.list.headers", "db.list.full",
  "db.thread.headers", "db.thread.full", "storage.journal", "storage.replay",
  "keychain.wait", "ipc.mail.list", "ipc.mail.open", "ipc.mail.thread",
  "ipc.mail.sync", "ipc.other",
]);
const IPC = new Map([
  ...["mail:listFromCache", "mail:listFromCacheAggregate", "mail:listWindowRead", "mail:loadMoreAggregate"].map(name => [name, "ipc.mail.list"]),
  ["mail:openEmail", "ipc.mail.open"], ["mail:readEmail", "ipc.mail.open"],
  ["mail:readCachedBody", "ipc.mail.open"],
  ["mail:listThreadMessages", "ipc.mail.thread"], ["mail:getLocalThreadMembers", "ipc.mail.thread"],
  ["mail:listFromNetwork", "ipc.mail.sync"],
]);
const noop = () => {};
const rounded = n => Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;

function createRecorder({ enabled = false, now = () => performance.now() } = {}) {
  const stats = new Map();
  function record(stage, duration) {
    if (!enabled || !STAGES.has(stage) || !Number.isFinite(duration) || duration < 0) return;
    const row = stats.get(stage) || { count: 0, totalMs: 0, maxMs: 0, over50ms: 0, over100ms: 0 };
    if (row.count >= 1000000) return; // Bounded counters even if reporting is paused.
    row.count++; row.totalMs += duration; row.maxMs = Math.max(row.maxMs, duration);
    if (duration > 50) row.over50ms++;
    if (duration > 100) row.over100ms++;
    stats.set(stage, row);
  }
  function start(stage) {
    if (!enabled || !STAGES.has(stage)) return noop;
    const began = now();
    let done = false;
    return () => { if (!done) { done = true; record(stage, now() - began); } };
  }
  function sync(stage, work) {
    if (!enabled) return work();
    const end = start(stage);
    try { return work(); } finally { end(); }
  }
  function measure(stage, work) {
    if (!enabled) return work();
    const end = start(stage);
    try {
      const value = work();
      if (value && typeof value.then === "function") return Promise.resolve(value).then(
        result => { end(); return result; }, error => { end(); throw error; });
      end(); return value;
    } catch (error) { end(); throw error; }
  }
  function snapshot(reset = false) {
    const rows = [...stats].map(([stage, value]) => ({ stage, count: value.count, meanMs: rounded(value.totalMs / value.count),
      maxMs: rounded(value.maxMs), over50ms: value.over50ms, over100ms: value.over100ms }));
    if (reset) stats.clear();
    return { enabled, stages: rows };
  }
  return { enabled, record, start, sync, measure, snapshot, ipc: (channel, work) => measure(IPC.get(channel) || "ipc.other", work) };
}

const recorder = createRecorder({ enabled: process.env.MORROW_PERF === "1" });
let monitor, timer;
function startMonitoring(report = line => require("./debug-log").note("performance", line)) {
  if (!recorder.enabled || timer) return;
  monitor = monitorEventLoopDelay({ resolution: 20 });
  monitor.enable();
  timer = setInterval(() => {
    // One short line per fixed stage fits the bounded Debug log. No files or
    // telemetry are created. Reporting failures cannot affect mail operations.
    try {
      for (const row of recorder.snapshot(true).stages) report(JSON.stringify(row));
      report(JSON.stringify({ stage: "main.loop", resolutionMs: 20, meanMs: rounded(monitor.mean / 1e6),
        p99Ms: rounded(monitor.percentile(99) / 1e6), maxMs: rounded(monitor.max / 1e6) }));
    } catch { /* diagnostics are best effort */ }
    monitor?.reset();
  }, 30000);
  timer.unref();
}
function stopMonitoring() {
  if (timer) clearInterval(timer);
  monitor?.disable(); timer = null; monitor = null;
}

module.exports = { ...recorder, createRecorder, startMonitoring, stopMonitoring };
