"use strict";

const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { cancelled, LIMITS } = require("./attachment-cache");

// One archive at a time, with bounded queued input. Download/cache budgets remain
// independent. Inputs are cloned, never detached from a cache or another consumer.
function createZipQueue({ WorkerClass = Worker, maxJobs = 3, maxBytes = 256 * 1024 * 1024 } = {}) {
  const queue = [];
  let active = null, bytes = 0;
  function release(job) { bytes -= job.bytes; }
  function drain() {
    if (active || !queue.length) return;
    const job = active = queue.shift();
    let worker;
    try {
      worker = job.worker = new WorkerClass(__filename, { workerData: { files: job.files } });
    } catch (error) {
      active = null; release(job); job.finish(error); drain(); return;
    }
    worker.once("message", message => {
      if (message?.error) job.finish(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else if (!(message?.data instanceof Uint8Array)) job.finish(new Error("ZIP preparation returned invalid bytes."));
      else job.finish(null, Buffer.from(message.data.buffer, message.data.byteOffset, message.data.byteLength));
    });
    worker.once("error", error => job.finish(error));
    worker.once("exit", () => {
      job.finish(new Error("ZIP preparation stopped before it finished. Retry saving the files."));
      active = null; release(job); drain();
    });
  }
  function zip(files, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (!Array.isArray(files) || files.length > 65535 || files.some(file => !(file?.data instanceof Uint8Array))) {
      return Promise.reject(new Error("ZIP preparation requires attachment bytes."));
    }
    const size = files.reduce((sum, file) => sum + file.data.byteLength, 0);
    if (files.some(file => file.data.byteLength > LIMITS.fileBytes) || size > LIMITS.zipBytes) {
      return Promise.reject(Object.assign(new Error("These files exceed the combined download limit. Save them separately."), { code: "too-large" }));
    }
    if (queue.length + Number(!!active) >= maxJobs || bytes + size > maxBytes) {
      return Promise.reject(new Error("Too many ZIP files are being prepared. Wait for one to finish or cancel it, then retry."));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const job = { files, bytes: size, worker: null, finish(error, result) {
        if (settled) return;
        settled = true; signal?.removeEventListener("abort", abort);
        if (signal?.aborted) reject(cancelled()); else if (error) reject(error); else resolve(result);
      } };
      const abort = () => {
        const index = queue.indexOf(job);
        if (index >= 0) { queue.splice(index, 1); release(job); }
        job.finish(cancelled());
        // Keep ownership until exit: cancellation cannot start overlapping workers.
        if (job.worker) void job.worker.terminate().catch(() => {});
      };
      bytes += size; queue.push(job); signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      drain();
    });
  }
  return { zip, stats: () => ({ active: Number(!!active), queued: queue.length, bytes }) };
}

if (!isMainThread && workerData?.files) {
  try {
    const files = workerData.files.map(file => ({ name: file.name,
      data: Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength) }));
    const archive = require("./zip-bytes").zipFiles(files);
    // Dedicated output is transferable even for small ZIPs allocated in a pool.
    const data = new Uint8Array(archive.length); data.set(archive);
    parentPort.postMessage({ data }, [data.buffer]);
  } catch (error) {
    parentPort.postMessage({ error: { message: error.message, code: error.code } });
  }
}

const queue = createZipQueue();
module.exports = { createZipQueue, zipFilesAsync: queue.zip };
