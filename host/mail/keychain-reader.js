const { spawn } = require("node:child_process");

const TIMEOUT_MS = 30000;
const MAX_OUTPUT = 1024 * 1024;

function storageError(code, message) {
  return Object.assign(new Error(message), { code, operationIssued: false });
}

function cancelled() {
  return storageError("ABORT_ERR", "Secure storage read cancelled.");
}

// Read-only children. Queue time is part of the deadline; a child that does not
// close after being killed retains its slot so it cannot accumulate successors.
function createReader({ launch = spawn, setTimer = setTimeout, clearTimer = clearTimeout,
  timeoutMs = TIMEOUT_MS, maxConcurrent = 4, maxOutput = MAX_OUTPUT,
  command = "security", decode = output => output.replace(/\n$/, "") } = {}) {
  const queue = [];
  let active = 0;

  function pump() {
    while (active < maxConcurrent && queue.length) {
      const job = queue.shift();
      if (!job.done) job.start();
    }
  }

  return function read(args, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      let child, timer, bytes = 0, released = false;
      const chunks = [];
      const release = () => {
        if (released) return;
        released = true;
        active--;
        pump();
      };
      const stop = () => {
        try { child?.kill("SIGKILL"); } catch { /* already stopped */ }
        try { child?.stdout?.destroy(); } catch { /* already closed */ }
        try { child?.unref?.(); } catch { /* already stopped */ }
      };
      const finish = (error, value) => {
        if (job.done) return;
        job.done = true;
        clearTimer(timer);
        signal?.removeEventListener("abort", abort);
        const at = queue.indexOf(job);
        if (at >= 0) queue.splice(at, 1);
        chunks.length = 0;
        if (error) reject(error); else resolve(value);
      };
      const abort = () => { finish(cancelled()); stop(); };
      const job = {
        done: false,
        start() {
          active++;
          try {
            child = launch(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
            child.on("error", () => {
              finish(storageError("secure_storage_unavailable", "Secure storage could not be read. Try again."));
              if (!child.pid) release();
              else stop();
            });
            child.stdout.on("error", () => {
              finish(storageError("secure_storage_unavailable", "Secure storage could not be read. Try again."));
              stop();
            });
            child.stdout.on("data", chunk => {
              if (job.done) return;
              const data = Buffer.from(chunk);
              bytes += data.length;
              if (bytes > maxOutput) {
                finish(storageError("secure_storage_output", "Secure storage returned too much data."));
                stop();
              } else chunks.push(data);
            });
            child.on("close", status => {
              if (!job.done) finish(null, status === 0 ? decode(Buffer.concat(chunks).toString("utf8")) : null);
              release();
            });
          } catch {
            finish(storageError("secure_storage_unavailable", "Secure storage could not be read. Try again."));
            stop();
            release();
          }
        },
      };
      timer = setTimer(() => {
        finish(storageError("secure_storage_timeout", "Secure storage did not respond in time. Check access and retry."));
        stop();
      }, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      queue.push(job);
      pump();
    });
  };
}

module.exports = { createReader, TIMEOUT_MS, MAX_OUTPUT };
