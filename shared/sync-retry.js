// Shared retry schedule for mail sync and Out of Office status.
// No provider calls. The host and the renderer own the actual reads.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.morrowSyncRetry = api;
})(typeof window === "object" ? window : globalThis, function () {
  const SYNC_RETRY_DELAYS_MS = [5000, 15000, 45000];
  const OOO_RETRY_DELAYS_MS = [5000, 15000, 45000];
  const VACATION_CACHE_MS = 60000;

  function isStickyAuthSyncError(message, error) {
    if (error && (error.code === "auth" || error.authenticationFailed === true)) return true;
    const status = error && Number(error.status || error.statusCode);
    if (status === 401 || status === 403) return true;
    const text = String(message || "");
    if (!text) return false;
    return /password|keychain|rejected the password|rejected the credentials|rejected credential|sign in again|connect the account again|grant access again|authorization expired|authentication failed|authenticationfailed|invalid credentials|invalid login|login failed|oauth access token|refresh token/i.test(text);
  }

  function defaultSetTimer(fn, ms) {
    const timer = setTimeout(fn, ms);
    if (timer && typeof timer.unref === "function") timer.unref();
    return timer;
  }

  function createRetryScheduler(options) {
    const settings = options || {};
    const delays = (settings.delays || SYNC_RETRY_DELAYS_MS).slice();
    const now = settings.now || (() => Date.now());
    const setTimer = settings.setTimer || defaultSetTimer;
    const clearTimer = settings.clearTimer || ((timer) => clearTimeout(timer));
    const onRetry = settings.onRetry || (() => {});
    const rows = new Map();

    function dropTimer(row) {
      if (row && row.timer != null) {
        clearTimer(row.timer);
        row.timer = null;
      }
    }

    function clear(key) {
      const row = rows.get(key);
      if (!row) return;
      dropTimer(row);
      rows.delete(key);
    }

    function arm(key, row, delay) {
      dropTimer(row);
      const wait = Math.max(0, Number(delay) || 0);
      row.retryAt = now() + wait;
      row.timer = setTimer(() => {
        const current = rows.get(key);
        if (!current || current !== row) return;
        current.timer = null;
        current.retryAt = 0;
        try { return onRetry(key); } catch { /* the caller records the sync or vacation failure */ }
      }, wait);
      rows.set(key, row);
    }

    function noteFailure(key, message, opts) {
      const sticky = !opts || opts.stickyAuth !== false;
      if (sticky && isStickyAuthSyncError(message, opts && opts.error)) {
        clear(key);
        return { retry: false, auth: true, exhausted: false, attempt: 0, delayMs: null, retryAt: null };
      }
      const row = rows.get(key) || { attempt: 0, timer: null, retryAt: 0, exhausted: false };
      const delay = delays[row.attempt];
      if (delay == null || row.exhausted) {
        dropTimer(row);
        row.retryAt = 0;
        row.exhausted = true;
        row.attempt = delays.length;
        rows.set(key, row);
        return { retry: false, auth: false, exhausted: true, attempt: row.attempt, delayMs: null, retryAt: null };
      }
      row.exhausted = false;
      row.attempt += 1;
      arm(key, row, delay);
      return { retry: true, auth: false, exhausted: false, attempt: row.attempt, delayMs: delay, retryAt: row.retryAt };
    }

    function hold(key, ms) {
      const row = rows.get(key);
      if (!row || row.exhausted || row.attempt <= 0) return false;
      arm(key, row, ms);
      return true;
    }

    function status(key) {
      const row = rows.get(key);
      if (!row) return null;
      return {
        attempt: row.attempt,
        retryAt: row.retryAt || null,
        waiting: row.timer != null,
        exhausted: row.exhausted === true,
      };
    }

    function stop() {
      for (const key of [...rows.keys()]) clear(key);
    }

    return {
      noteFailure,
      noteSuccess: clear,
      clear,
      hold,
      status,
      stop,
    };
  }

  // pending: a read is already in flight.
  // force: the user pressed Refresh; callers clear the schedule first.
  // waiting: a backoff timer is armed.
  // exhausted: this account's rechecks are done until Refresh or a new selection clears them.
  // attempt > 0 with no timer: the armed recheck is due.
  function decideVacationRefresh(input) {
    const options = input || {};
    if (options.pending) return "wait";
    if (options.force) return "fetch";
    const status = options.status;
    if (status && status.waiting) return "wait";
    if (status && status.exhausted) return "stop";
    if (status && status.attempt > 0) return "fetch";
    const previous = options.previous;
    const now = Number(options.now) || 0;
    const cacheMs = Number.isFinite(Number(options.cacheMs)) ? Number(options.cacheMs) : VACATION_CACHE_MS;
    if (previous && !previous.retrying && previous.at && now - previous.at < cacheMs) return "cache";
    return "fetch";
  }

  return {
    SYNC_RETRY_DELAYS_MS,
    OOO_RETRY_DELAYS_MS,
    VACATION_CACHE_MS,
    isStickyAuthSyncError,
    createRetryScheduler,
    decideVacationRefresh,
  };
});
