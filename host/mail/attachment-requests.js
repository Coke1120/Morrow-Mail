"use strict";
const { randomUUID } = require("node:crypto");
const { cancelled } = require("./attachment-cache");

function createAttachmentRequests() {
  const owners = new Map();
  function begin(params, owner = null) {
    const id = params.requestId == null ? randomUUID() : params.requestId;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("A valid attachment request id is required.");
    if (owner?.isDestroyed?.()) throw cancelled();
    let bucket = owners.get(owner);
    if (!bucket) {
      bucket = { jobs: new Map(), closed() { for (const job of bucket.jobs.values()) job.controller.abort(cancelled()); } };
      owners.set(owner, bucket); owner?.once?.("destroyed", bucket.closed);
    }
    if (bucket.jobs.has(id) || bucket.jobs.size >= 16) throw new Error("This attachment request is already running, or too many requests are open.");
    const controller = new AbortController();
    let previousPhase, previousAt = 0;
    const job = { id, controller, signal: controller.signal, accountId: null,
      report(value) {
        if (controller.signal.aborted || owner?.isDestroyed?.()) return;
        const now = Date.now();
        if (value.phase === previousPhase && now - previousAt < 100) return;
        previousPhase = value.phase; previousAt = now;
        try { owner?.send?.("mail:attachmentProgress", { requestId: id, ...value }); } catch { /* window closed */ }
      },
      finish() {
        bucket.jobs.delete(id);
        if (!bucket.jobs.size) { owners.delete(owner); owner?.removeListener?.("destroyed", bucket.closed); }
      } };
    bucket.jobs.set(id, job);
    return job;
  }
  return { begin, cancel(id, owner = null) {
    const job = owners.get(owner)?.jobs.get(id);
    if (job) job.controller.abort(cancelled());
    return !!job;
  }, invalidateAccount(id, error) {
    for (const bucket of owners.values()) for (const job of bucket.jobs.values()) if (job.accountId === id) job.controller.abort(error);
  }, size: () => [...owners.values()].reduce((sum, bucket) => sum + bucket.jobs.size, 0) };
}
module.exports = { createAttachmentRequests };
