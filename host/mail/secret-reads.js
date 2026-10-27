function readError(code, message) {
  return Object.assign(new Error(message), { code, operationIssued: false });
}

// Share only pending reads, never completed credentials. Revisions are opaque
// tokens; deleting a record creates a new token on any later same-ID reuse.
function createReads() {
  const backends = new WeakMap();
  function records(backend) {
    if (!backends.has(backend)) backends.set(backend, new Map());
    return backends.get(backend);
  }
  function record(backend, account) {
    const map = records(backend);
    if (!map.has(account)) map.set(account, { revision: Symbol(), pending: null });
    return map.get(account);
  }
  function stop(operation) {
    operation.controller.abort();
  }
  function finish(state, operation, error, value) {
    if (operation.done) return;
    operation.done = true;
    if (state.pending === operation) state.pending = null;
    for (const consumer of operation.consumers) {
      consumer.signal?.removeEventListener("abort", consumer.abort);
      if (error) consumer.reject(error); else consumer.resolve(value);
    }
    operation.consumers.clear();
  }
  function get(backend, account, { signal } = {}) {
    if (signal && (typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
      return Promise.reject(new TypeError("A credential read requires an AbortSignal."));
    }
    if (signal?.aborted) return Promise.reject(readError("ABORT_ERR", "Secure storage read cancelled."));
    const state = record(backend, account);
    let operation = state.pending;
    if (!operation) {
      operation = { controller: new AbortController(), consumers: new Set(), done: false };
      state.pending = operation;
      Promise.resolve().then(() => {
        if (operation.done) return;
        return typeof backend.getPasswordAsync === "function"
          ? backend.getPasswordAsync(account, { signal: operation.controller.signal })
          : backend.getPassword(account);
      }).then(value => finish(state, operation, null, value), error => finish(state, operation, error));
    }
    return new Promise((resolve, reject) => {
      const consumer = { resolve, reject, signal };
      consumer.abort = () => {
        operation.consumers.delete(consumer);
        signal.removeEventListener("abort", consumer.abort);
        reject(readError("ABORT_ERR", "Secure storage read cancelled."));
        if (!operation.consumers.size && !operation.done) {
          finish(state, operation, readError("ABORT_ERR", "Secure storage read cancelled."));
          stop(operation);
        }
      };
      operation.consumers.add(consumer);
      signal?.addEventListener("abort", consumer.abort, { once: true });
    });
  }
  function invalidate(backend, account, remove = false) {
    const state = record(backend, account);
    state.revision = Symbol();
    if (state.pending) {
      const operation = state.pending;
      finish(state, operation, readError("conflict", "The mailbox credentials changed. Retry for the current connection."));
      stop(operation);
    }
    if (remove) records(backend).delete(account);
  }
  return { get, invalidate, revision: (backend, account) => record(backend, account).revision };
}

module.exports = { createReads };
