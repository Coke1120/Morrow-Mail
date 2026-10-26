"use strict";

const MIB = 1024 * 1024;
const LIMITS = Object.freeze({ bytes: 64 * MIB, entryBytes: 32 * MIB, fileBytes: 64 * MIB,
  zipBytes: 128 * MIB, entries: 64, pending: 16, concurrency: 2, ttlMs: 5 * 60 * 1000 });
const cancelled = () => Object.assign(new Error("cancelled"), { code: "cancelled", operationIssued: false });
const tooLarge = () => Object.assign(new Error("This attachment exceeds the 64 MiB download limit."), { code: "too-large" });

// Complete, immutable-internal bytes only. Consumers own their cancellation;
// a shared provider read stops only when its last consumer has detached.
function createAttachmentCache(options = {}) {
  const limits = { ...LIMITS, ...options }, completed = new Map(), pending = new Map(), queue = [], groups = new Set();
  let bytes = 0, active = 0;
  function drop(key) {
    const value = completed.get(key);
    if (!value) return;
    clearTimeout(value.timer); bytes -= value.data.length; completed.delete(key);
  }
  function store(entry, data) {
    if (data.length > limits.entryBytes || data.length > limits.bytes || entry.signal.aborted) return;
    drop(entry.key);
    while (completed.size && (bytes + data.length > limits.bytes || completed.size >= limits.entries)) drop(completed.keys().next().value);
    const timer = setTimeout(() => drop(entry.key), limits.ttlMs); timer.unref?.();
    completed.set(entry.key, { accountId: entry.accountId, data, timer, expires: Date.now() + limits.ttlMs });
    bytes += data.length;
  }
  function progress(entry, value) {
    entry.progress = value;
    for (const consumer of entry.consumers) { try { consumer.progress(value); } catch { /* a closing window */ } }
  }
  function finish(entry, error, value) {
    if (entry.done) return;
    entry.done = true;
    if (pending.get(entry.key) === entry) pending.delete(entry.key);
    if (!error && !entry.signal.aborted) {
      if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) error = new Error("The attachment download did not return bytes.");
      else if (value.length > limits.fileBytes) error = tooLarge();
      else { value = Buffer.from(value); store(entry, value); }
    }
    if (error) entry.controller.abort(error);
    for (const consumer of [...entry.consumers]) {
      if (error || entry.signal.aborted) consumer.reject(error || cancelled());
      else { try { consumer.progress({ phase: "ready", loaded: value.length }); } catch { /* a closing window */ } consumer.resolve(Buffer.from(value)); }
    }
  }
  function drain() {
    while (active < limits.concurrency && queue.length) {
      const group = queue.shift();
      if (group.controller.signal.aborted) { groups.delete(group); continue; }
      active += 1;
      Promise.resolve().then(() => group.load(group.entries.map(entry => ({ item: entry.item, signal: entry.signal,
        report: value => progress(entry, value), complete: data => finish(entry, null, data), fail: error => finish(entry, error) })), group.controller.signal))
        .catch(error => { for (const entry of group.entries) finish(entry, error); })
        .finally(() => {
          for (const entry of group.entries) {
            entry.signal.removeEventListener("abort", group.check);
            finish(entry, entry.signal.aborted ? cancelled() : new Error("The attachment download did not finish."));
          }
          groups.delete(group); active -= 1; drain();
        });
    }
  }
  async function getMany(items, { accountId, signal, onProgress = () => {}, load, maxTotalBytes = limits.zipBytes } = {}) {
    signal?.throwIfAborted();
    for (const item of items) if (completed.get(item.key)?.expires <= Date.now()) drop(item.key);
    const missing = new Set(items.filter(item => !completed.has(item.key) && !pending.has(item.key)).map(item => item.key));
    if (pending.size + missing.size > limits.pending) throw new Error("Too many attachment downloads are waiting. Cancel one or try again shortly.");
    const totalError = () => Object.assign(new Error("These files exceed the combined download limit. Save them separately."), { code: "too-large" });
    if (items.reduce((sum, item) => sum + (completed.get(item.key)?.data.length || 0), 0) > maxTotalBytes) throw totalError();
    let received = 0;
    const fresh = [], consumers = [];
    const abort = () => { for (const { consumer } of consumers) consumer.abort(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const promises = items.map((item, index) => {
        const cached = completed.get(item.key);
        if (cached && cached.expires <= Date.now()) drop(item.key);
        if (completed.has(item.key)) {
          const value = completed.get(item.key); completed.delete(item.key); completed.set(item.key, value);
          received += value.data.length;
          onProgress({ index, phase: "ready", loaded: value.data.length, cached: true });
          return Promise.resolve(Buffer.from(value.data));
        }
        let entry = pending.get(item.key);
        if (!entry) {
          const controller = new AbortController();
          entry = { key: item.key, item, accountId, controller, signal: controller.signal, consumers: new Set(), done: false,
            progress: { phase: "queued", loaded: 0 } };
          pending.set(item.key, entry); fresh.push(entry);
        }
        const current = entry;
        return new Promise((resolve, reject) => {
          const consumer = { resolve(value) {
            received += value.length;
            if (received > maxTotalBytes) reject(totalError()); else resolve(value);
          }, reject, progress: value => onProgress({ ...value, index }) };
          consumer.abort = () => {
            current.consumers.delete(consumer); reject(signal?.reason?.code ? signal.reason : cancelled());
            if (!current.done && !current.consumers.size) {
              if (pending.get(current.key) === current) pending.delete(current.key);
              current.controller.abort();
            }
          };
          current.consumers.add(consumer); consumers.push({ entry: current, consumer });
          consumer.progress(current.progress);
          if (signal?.aborted) consumer.abort();
        });
      });
      if (fresh.length) {
        const controller = new AbortController();
        const group = { entries: fresh, controller, load, accountId,
          check() {
            if (!fresh.every(entry => entry.done || entry.signal.aborted)) return;
            controller.abort();
            const index = queue.indexOf(group); if (index >= 0) { queue.splice(index, 1); groups.delete(group); }
          } };
        for (const entry of fresh) entry.signal.addEventListener("abort", group.check);
        groups.add(group); queue.push(group); group.check(); drain();
      }
      return await Promise.all(promises);
    } finally {
      signal?.removeEventListener("abort", abort);
      for (const { entry, consumer } of consumers) {
        entry.consumers.delete(consumer);
        if (!entry.done && !entry.consumers.size) {
          if (pending.get(entry.key) === entry) pending.delete(entry.key);
          entry.controller.abort();
        }
      }
      for (const entry of fresh) if (!entry.done && !entry.consumers.size) finish(entry, cancelled());
    }
  }
  function invalidateAccount(accountId, error = cancelled()) {
    for (const group of [...groups]) if (group.accountId === accountId) {
      group.controller.abort(error);
      const index = queue.indexOf(group); if (index >= 0) { queue.splice(index, 1); groups.delete(group); }
    }
    for (const [key, entry] of completed) if (entry.accountId === accountId) drop(key);
    for (const entry of [...pending.values()]) if (entry.accountId === accountId) {
      entry.controller.abort(error); finish(entry, error);
    }
  }
  return { getMany, invalidateAccount, clear() {
    for (const accountId of new Set([...completed.values(), ...pending.values(), ...groups].map(e => e.accountId))) invalidateAccount(accountId);
  }, stats: () => ({ bytes, entries: completed.size, pending: pending.size, active, queued: queue.length }) };
}

module.exports = { createAttachmentCache, LIMITS, cancelled, tooLarge };
