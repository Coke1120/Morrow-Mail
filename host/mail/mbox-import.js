"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Worker } = require("node:worker_threads");
const { setImmediate: yieldTurn } = require("node:timers/promises");
const { digest, ARCHIVE_ID } = require("./local-folders");
const { entries, LIMITS, error } = require("./mbox-reader");
const activeStates = new Set(["staging", "verifying", "importing"]);
const stamp = stat => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
const openRead = file => fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));

async function syncDirectory(dir) {
  if (process.platform === "win32") return;
  const fd = await fs.promises.open(dir, "r");
  try { await fd.sync(); } finally { await fd.close(); }
}

function parseMessage(raw, signal, limits) {
  return new Promise((resolve, reject) => {
    const input = Uint8Array.from(raw);
    const worker = new Worker(path.join(__dirname, "mbox-mime-worker.js"), {
      workerData: { raw: input }, transferList: [input.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
    });
    let finished = false;
    const finish = (failure, result) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      // Termination releases worker/native resources before the next message.
      worker.terminate().then(() => failure ? reject(failure) : resolve(result), reject);
    };
    const abort = () => finish(error("mbox_cancelled", "Import cancelled. Previously committed messages were retained."));
    const timer = setTimeout(() => finish(null, { failure: "MIME parsing exceeded 20 seconds; original retained in the source snapshot." }), limits.parseMs);
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", result => {
      if (result.archive) {
        result.archive.raw = Buffer.from(result.archive.raw);
        for (const file of result.archive.files) file.data = Buffer.from(file.data);
      }
      finish(null, result);
    });
    worker.once("error", () => finish(null, { failure: "MIME worker failed or exceeded its memory limit; original retained in the source snapshot." }));
    worker.once("exit", () => { if (!finished) finish(null, { failure: "MIME worker stopped before returning a complete message; original retained in the source snapshot." }); });
    if (signal.aborted) abort();
  });
}

function createImporter({ store, limits: overrides = {}, parse = parseMessage, hooks = {} }) {
  const limits = { ...LIMITS, ...overrides };
  const jobs = store.importJobs();
  const root = path.join(path.dirname(store.file), "mbox-imports");
  let current = null;
  let closing = false;
  // Recovery never starts work, scans user directories or contacts a provider.
  for (const job of jobs.list()) if (activeStates.has(job.status)) {
    job.status = "interrupted"; job.detail = "Import was interrupted. Continue verifies the saved snapshot before using its committed offset."; jobs.write(job);
  }
  function publicJob(job) {
    return { id: job.id, status: job.status, destination: job.destination, variant: job.variant,
      files: job.files.map(file => ({ name: file.name, size: file.size, offset: file.offset, staged: !!file.snapshot })),
      totalBytes: job.files.reduce((n, file) => n + file.size, 0),
      consumedBytes: job.files.reduce((n, file) => n + file.offset, 0),
      imported: job.imported, skipped: job.skipped, failed: job.failed, expunged: job.expunged,
      detail: job.detail, errors: job.errors, phaseBytes: current?.id === job.id ? current.phaseBytes : 0,
      canContinue: !["review", "completed", "completed_with_errors", "discarded"].includes(job.status),
      running: current?.id === job.id };
  }
  function status(id) { return publicJob(jobs.read(id)); }
  function list() { return jobs.list().map(publicJob); }
  async function select(paths) {
    if (closing || current) throw error("mbox_busy", "Finish the running import first.");
    if (!Array.isArray(paths) || !paths.length || paths.length > limits.files) throw error("mbox_files", "Choose 1–20 MBOX mailbox files.");
    const files = []; let total = 0;
    for (const file of [...new Set(paths)]) {
      if (/\.(?:msf|sbd)$/i.test(file)) throw error("mbox_format", "Thunderbird .msf files are indexes; .sbd trees are directories. Choose exported mailbox files, including extensionless files.");
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw error("mbox_format", "Choose regular mailbox files, not directories, links, profiles or Maildir.");
      total += stat.size;
      if (total > limits.sourceBytes) throw error("mbox_size", "The selected sources exceed the 100 GiB import-job limit. Import smaller batches.");
      files.push({ source: path.resolve(file), name: path.basename(file), size: stat.size, sourceStamp: stamp(stat), offset: 0 });
    }
    const job = { id: crypto.randomUUID(), status: "review", destination: null, variant: null, files,
      imported: 0, skipped: 0, failed: 0, expunged: 0, detail: "Review the files, format and destination before importing.", errors: [] };
    jobs.write(job); return publicJob(job);
  }
  const snapshotPath = (job, index, suffix = "") => path.join(root, job.id, `${index}.mbox${suffix}`);
  function check(token) {
    if (token.controller.signal.aborted) throw error("mbox_cancelled", "Import cancelled. Previously committed messages were retained.");
  }
  async function stage(job, index, token) {
    const source = job.files[index];
    if (source.snapshot) return;
    job.status = "staging"; job.detail = "Making a private source snapshot. No messages from this file are acknowledged yet."; jobs.write(job);
    await fs.promises.mkdir(path.join(root, job.id), { recursive: true, mode: 0o700 });
    await syncDirectory(path.dirname(root)); await syncDirectory(root);
    const temporary = snapshotPath(job, index, ".partial"), target = snapshotPath(job, index);
    await fs.promises.rm(temporary, { force: true });
    const input = await openRead(source.source);
    let output;
    try {
      if (stamp(await input.stat()) !== source.sourceStamp) throw error("mbox_changed", "The selected source changed or was replaced. Select a quiescent export again; it was not imported.");
      output = await fs.promises.open(temporary, "wx", 0o600);
      const hash = crypto.createHash("sha256"); let position = 0;
      while (position < source.size) {
        check(token);
        if (Date.now() - token.started > limits.runMs) throw error("mbox_budget", "Snapshot creation reached the 10-minute run budget. Continue retries this file; use smaller exports if this repeats.");
        const chunk = Buffer.allocUnsafe(limits.chunk);
        const { bytesRead } = await input.read(chunk, 0, Math.min(chunk.length, source.size - position), position);
        if (!bytesRead) throw error("mbox_changed", "The source was truncated while making its snapshot. Select a stopped/exported mailbox again.");
        hash.update(chunk.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(chunk, written, bytesRead - written);
          if (!result.bytesWritten) throw error("mbox_write", "Snapshot write made no progress. Check free space and permissions.");
          written += result.bytesWritten;
        }
        position += bytesRead; token.phaseBytes = position;
        await hooks.stageChunk?.({ job, index, position }); await yieldTurn();
      }
      check(token);
      if (stamp(await input.stat()) !== source.sourceStamp || stamp(await fs.promises.lstat(source.source)) !== source.sourceStamp) {
        throw error("mbox_changed", "The source changed or was replaced during snapshot creation. Its snapshot was rejected; select a quiescent export again.");
      }
      await output.sync(); await output.close(); output = null;
      await fs.promises.rename(temporary, target); await syncDirectory(path.dirname(target));
      // Publish the receipt only after durable snapshot publication.
      source.snapshot = { sha: hash.digest("hex"), stamp: stamp(await fs.promises.lstat(target)) };
      jobs.write(job);
    } finally { await input.close(); if (output) await output.close(); await fs.promises.rm(temporary, { force: true }); }
  }
  async function snapshot(job, index, token) {
    const source = job.files[index];
    job.status = "verifying"; job.detail = "Verifying the entire saved snapshot before reading its committed offset."; jobs.write(job);
    const handle = await openRead(snapshotPath(job, index));
    try {
      const before = stamp(await handle.stat());
      const hash = crypto.createHash("sha256"); let position = 0;
      for (;;) {
        check(token);
        if (Date.now() - token.started > limits.runMs) throw error("mbox_budget", "Snapshot verification reached the 10-minute run budget. Continue retries verification; use smaller exports if this repeats.");
        const chunk = Buffer.allocUnsafe(limits.chunk);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (!bytesRead) break;
        hash.update(chunk.subarray(0, bytesRead)); position += bytesRead; token.phaseBytes = position; await yieldTurn();
      }
      if (position !== source.size || hash.digest("hex") !== source.snapshot.sha || stamp(await handle.stat()) !== before) {
        throw error("mbox_snapshot", "Snapshot verification failed. Progress and local mail were retained; no old offset was trusted.");
      }
      // A backup restored byte-for-byte can have a new inode/timestamp. Only a
      // complete matching digest permits adopting its current stable identity;
      // later per-commit checks still reject a concurrent change.
      source.snapshot.stamp = before;
      return handle;
    } catch (failure) { await handle.close(); throw failure; }
  }
  function rememberFailure(job, index, entry, detail) {
    job.failed++;
    if (job.errors.length < 50) job.errors.push({ file: job.files[index].name, start: entry.start, end: entry.end, detail });
  }
  async function run(job, token) {
    try {
      const startingBytes = job.files.reduce((n, file) => n + file.offset, 0);
      for (let index = 0; index < job.files.length; index++) {
        check(token); store.folder(job.destination);
        const source = job.files[index];
        if (source.offset === source.size && source.snapshot) continue;
        await stage(job, index, token);
        const handle = await snapshot(job, index, token);
        try {
          job.status = "importing"; job.detail = "Importing complete messages one at a time. Counts acknowledge durable commits."; jobs.write(job);
          for await (const entry of entries(handle, source.offset, { variant: job.variant, limits,
            check: () => check(token), progress: position => { token.phaseBytes = position; } })) {
            check(token);
            const contentKey = entry.raw ? "mbox-v1:" + digest(entry.raw) : null;
            const existing = contentKey && store.receipt(contentKey, job.destination);
            let result = entry.failure ? { failure: entry.failure } : existing ? { duplicate: existing.message_id }
              : await parse(entry.raw, token.controller.signal, limits);
            check(token);
            if (stamp(await handle.stat()) !== source.snapshot.stamp) throw error("mbox_snapshot", "The saved snapshot changed during import. The current message was not acknowledged.");
            await hooks.beforeCommit?.({ job, index, entry, result }); check(token);
            // Work on a clone. A rollback must not leak increased JS counters.
            const committed = structuredClone(job);
            store.transaction(() => {
              store.folder(job.destination);
              if (result.failure) rememberFailure(committed, index, entry, result.failure);
              else if (result.expunged) { committed.skipped++; committed.expunged++; }
              else if (result.duplicate) { store.verify(result.duplicate); committed.skipped++; }
              else {
                const key = contentKey;
                const prior = store.receipt(key, job.destination);
                if (prior) { store.verify(prior.message_id); committed.skipped++; }
                else { store.save(key, job.destination, result.archive, result.flags); committed.imported++; }
              }
              committed.files[index].offset = entry.end;
              jobs.write(committed);
              hooks.insideCommit?.({ job: committed, index, entry });
            });
            Object.assign(job, committed);
            await hooks.afterCommit?.({ job, index, entry });
            result = null;
            check(token);
            await yieldTurn();
            if (Date.now() - token.started > limits.runMs || job.files.reduce((n, file) => n + file.offset, 0) - startingBytes >= limits.runBytes) {
              throw error("mbox_budget", "Import paused at its byte/time budget. Continue verifies the snapshot and resumes after the last committed message.");
            }
          }
          // Empty files and a crash after the last message are safe no-ops.
          source.offset = source.size; jobs.write(job);
        } finally { await handle.close(); }
      }
      job.status = job.failed ? "completed_with_errors" : "completed";
      job.detail = job.failed ? "Finished with failed entries. Their bytes remain in the retained source snapshots; review the error offsets."
        : "Import complete. Local messages and attachments are saved; sources were unchanged.";
      jobs.write(job);
    } catch (failure) {
      // A commit/fsync failure can be uncertain. Reload the durable state rather
      // than reporting in-memory counts or blindly replaying a transaction.
      try {
        job = jobs.read(job.id);
        job.status = failure.code === "mbox_cancelled" ? "cancelled" : failure.code === "mbox_budget" ? "paused" : "failed";
        job.detail = /^mbox_/.test(failure.code || "") ? failure.message : "Storage or read failed. Keep the archive and snapshots. Continue verifies durable progress before retrying.";
        jobs.write(job);
      } catch { /* SQLite may have failed closed. Reopen/recovery is required. */ }
    }
  }
  function start(id, { destination, variant } = {}, admit = work => work()) {
    if (closing || current) throw error("mbox_busy", "Finish or cancel the running import first.");
    const job = jobs.read(id);
    if (["completed", "completed_with_errors", "discarded"].includes(job.status)) throw error("mbox_finished", "This job is finished. Select files again for a separate import.");
    if (job.status === "review") {
      if (!["mboxrd", "mboxo"].includes(variant)) throw error("mbox_variant", "Choose mboxrd or mboxo explicitly.");
      store.folder(destination); job.destination = destination; job.variant = variant;
    } else if ((destination && destination !== job.destination) || (variant && variant !== job.variant)) {
      throw error("mbox_frozen", "A started import keeps its reviewed destination and format. Select files again to change them.");
    }
    const token = { id, controller: new AbortController(), started: Date.now(), phaseBytes: 0, promise: null };
    job.status = "staging"; jobs.write(job);
    current = token;
    try { token.promise = Promise.resolve(admit(() => run(job, token))).finally(() => { if (current === token) current = null; }); }
    catch (failure) { current = null; throw failure; }
    token.promise.catch(() => {});
    return status(id);
  }
  function cancel(id) {
    if (current?.id === id) current.controller.abort();
    return status(id);
  }
  async function discard(id) {
    if (current) throw error("mbox_busy", "Finish the running import before removing a snapshot.");
    const job = jobs.read(id);
    // This explicit action deletes only this job's private input copies, never
    // the user's source or any acknowledged local message/attachment/receipt.
    await fs.promises.rm(path.join(root, job.id), { recursive: true, force: true });
    if (fs.existsSync(root)) await syncDirectory(root);
    job.status = "discarded"; job.detail = "Private import snapshots removed. Local messages and original source files were retained.";
    jobs.write(job); return publicJob(job);
  }
  return { select, start, status, list, cancel, discard,
    async idle() { await current?.promise; },
    async stop() { closing = true; current?.controller.abort(); await current?.promise; },
    root };
}

module.exports = { createImporter, parseMessage, stamp, ARCHIVE_ID };
