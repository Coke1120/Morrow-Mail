"use strict";

const limits0 = require("./constants");

const defaults = {
  callsPerMinute: limits0.CALLS_PER_MINUTE,
  burst: limits0.BURST,
  globalPerMinute: limits0.GLOBAL_PER_MINUTE,
  searchesPerMinute: limits0.SEARCHES_PER_MINUTE,
  bodiesPerMinute: limits0.BODIES_PER_MINUTE,
  clientConcurrency: limits0.CLIENT_CONCURRENCY,
  globalConcurrency: limits0.GLOBAL_CONCURRENCY,
  bytesPerMinute: limits0.BYTES_PER_MINUTE,
  bytesPerDay: limits0.BYTES_PER_DAY,
};

let limits = { ...defaults };
const buckets = new Map();
const active = new Map();
let globalActive = 0;
let searchActive = false;
let globalMinute = 0;
let globalMinuteCount = 0;

function resetCounters() {
  buckets.clear();
  active.clear();
  globalActive = 0;
  searchActive = false;
  globalMinute = 0;
  globalMinuteCount = 0;
}

function setLimitsForTest(patch) {
  limits = { ...defaults, ...(patch || {}) };
  resetCounters();
}

function resetLimitsForTest() {
  limits = { ...defaults };
  resetCounters();
}

function bucket(clientId, kind) {
  const key = `${clientId}:${kind}`;
  let row = buckets.get(key);
  if (!row) {
    row = { minute: -1, minuteCount: 0, second: -1, secondCount: 0, minuteBytes: 0 };
    buckets.set(key, row);
  }
  return row;
}

function roll(row, now) {
  const minute = Math.floor(now / 60000);
  const second = Math.floor(now / 1000);
  if (row.minute !== minute) {
    row.minute = minute;
    row.minuteCount = 0;
    row.minuteBytes = 0;
  }
  if (row.second !== second) {
    row.second = second;
    row.secondCount = 0;
  }
  return { minute, second };
}

function retryAfter(now, burstBlocked) {
  if (burstBlocked) return 1000;
  return Math.max(1, 60000 - (now % 60000));
}

function takeCount(clientId, kind, perMinute, now) {
  const row = bucket(clientId, kind);
  roll(row, now);
  if (row.minuteCount >= perMinute) {
    return { ok: false, retryAfterMs: retryAfter(now, false) };
  }
  if (row.secondCount >= limits.burst) {
    return { ok: false, retryAfterMs: retryAfter(now, true) };
  }
  row.minuteCount += 1;
  row.secondCount += 1;
  return { ok: true };
}

function admit({ clientId, kind, bytesToday }) {
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  if (globalMinute !== minute) {
    globalMinute = minute;
    globalMinuteCount = 0;
  }
  if (globalMinuteCount >= limits.globalPerMinute) {
    return { ok: false, retryAfterMs: retryAfter(now, false) };
  }
  if (globalActive >= limits.globalConcurrency) {
    return { ok: false, retryAfterMs: 1000 };
  }
  const mine = active.get(clientId) || 0;
  if (mine >= limits.clientConcurrency) {
    return { ok: false, retryAfterMs: 1000 };
  }
  const dayBytes = Number(bytesToday) || 0;
  if (dayBytes >= limits.bytesPerDay) {
    return { ok: false, retryAfterMs: retryAfter(now, false) };
  }
  const byteRow = bucket(clientId, "bytes");
  roll(byteRow, now);
  if (byteRow.minuteBytes >= limits.bytesPerMinute) {
    return { ok: false, retryAfterMs: retryAfter(now, false) };
  }
  if (kind === "search" && searchActive) return { ok: false, retryAfterMs: 1000 };
  const call = takeCount(clientId, "call", limits.callsPerMinute, now);
  if (!call.ok) return call;
  if (kind === "search") {
    const search = takeCount(clientId, "search", limits.searchesPerMinute, now);
    if (!search.ok) return search;
    searchActive = true;
  }
  if (kind === "body") {
    const body = takeCount(clientId, "body", limits.bodiesPerMinute, now);
    if (!body.ok) return body;
  }
  globalMinuteCount += 1;
  globalActive += 1;
  active.set(clientId, mine + 1);
  return { ok: true, kind };
}

function leave(clientId, kind) {
  globalActive = Math.max(0, globalActive - 1);
  const mine = active.get(clientId) || 0;
  if (mine <= 1) active.delete(clientId);
  else active.set(clientId, mine - 1);
  if (kind === "search") searchActive = false;
}

function commitBytes(clientId, bytes) {
  const row = bucket(clientId, "bytes");
  roll(row, Date.now());
  row.minuteBytes += Math.max(0, Number(bytes) || 0);
}

function activeCount() {
  return globalActive;
}

function currentLimits() {
  return { ...limits };
}

module.exports = {
  admit,
  leave,
  commitBytes,
  activeCount,
  setLimitsForTest,
  resetLimitsForTest,
  currentLimits,
};
