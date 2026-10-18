// One IMAP IDLE connection per account, on INBOX only.
// A second mailbox would need another connection, which is not worth it under
// Gmail's roughly 15-connection cap. Sync stays on the short-lived client the
// engine already opens. RFC 2177: re-issue IDLE before 29 minutes.

const IDLE_RENEW_MS = 25 * 60 * 1000;
const IDLE_BACKOFF_BASE_MS = 2 * 1000;
const IDLE_BACKOFF_CAP_MS = 3 * 60 * 1000;
const IDLE_NOTIFY_DEBOUNCE_MS = 1500;
const IDLE_SAFETY_POLL_MS = 5 * 60 * 1000;
const IDLE_UNSUPPORTED_RECHECK_MS = 15 * 60 * 1000;
const IDLE_CLOSE_TIMEOUT_MS = 3000;
const IDLE_HOLD_MS = 24 * 60 * 60 * 1000;

function backgroundPollDue(healthy, lastAt, at, safetyMs) {
  if (!healthy) return true;
  return (Number(at) || 0) - (Number(lastAt) || 0) >= safetyMs;
}

function wantsIdle(account) {
  if (!account || !account.id || !account.imap_host) return false;
  const platform = String(account.platform || "imap").toLowerCase();
  return platform === "imap";
}

function hasIdle(caps) {
  if (!caps) return false;
  if (typeof caps.has === "function" && (caps.has("IDLE") || caps.has("idle"))) return true;
  const list = Array.isArray(caps)
    ? caps
    : (typeof caps.keys === "function" ? Array.from(caps.keys()) : []);
  return list.some((item) => String(item).toUpperCase() === "IDLE");
}

function sameFolder(selected, path) {
  if (!path || !selected || path === selected) return true;
  return String(path).toUpperCase() === "INBOX" && String(selected).toUpperCase() === "INBOX";
}

function defaultSetTimer(fn, ms) {
  const timer = setTimeout(fn, ms);
  if (timer && typeof timer.unref === "function") timer.unref();
  return timer;
}

function defaultIsRateLimit(error) {
  if (!error) return false;
  if (error.status === 429 || error.code === "rate_limit") return true;
  return /rate.?limit|\b429\b|OVERQUOTA/i.test(`${error.message || ""}`);
}

function createIdleController(options) {
  const listAccounts = options.listAccounts;
  const secretFor = options.secretFor;
  const openClient = options.openClient;
  const syncFolder = options.syncFolder;
  const gateUntil = options.gateUntil || (() => 0);
  const inboxPath = options.inboxPath || (() => "INBOX");
  const now = options.now || (() => Date.now());
  const setTimer = options.setTimer || defaultSetTimer;
  const clearTimer = options.clearTimer || ((timer) => clearTimeout(timer));
  const onRateLimit = options.onRateLimit || (() => {});
  const onStatus = options.onStatus || (() => {});
  const isRateLimit = options.isRateLimit || defaultIsRateLimit;

  const sessions = new Map();
  let running = false;
  let asleep = false;
  let offline = false;

  function gateOpen(accountId) {
    const until = Number(gateUntil(accountId)) || 0;
    return until <= now();
  }

  function setMode(session, mode) {
    const next = mode === "idle" ? "idle" : "polling";
    if (session.mode === next) return;
    session.mode = next;
    onStatus(session.accountId, next === "idle" ? "push" : "polling");
  }

  function createSession(accountId) {
    return {
      accountId,
      looping: false,
      removed: false,
      mode: "polling",
      client: null,
      folder: "INBOX",
      failures: 0,
      recheckAt: 0,
      pendingSync: false,
      syncing: false,
      debounceTimer: null,
      breakIdle: null,
      cancelWait: null,
      waitToken: null,
      breakForPause: false,
    };
  }

  function alive(session) {
    return running && !session.removed && sessions.get(session.accountId) === session;
  }

  function clearDebounce(session) {
    if (session.debounceTimer != null) {
      clearTimer(session.debounceTimer);
      session.debounceTimer = null;
    }
  }

  function wait(session, ms) {
    return new Promise((resolve) => {
      const delay = Math.max(0, Number(ms) || 0);
      if (delay === 0) {
        resolve("time");
        return;
      }
      const token = {};
      session.waitToken = token;
      const timer = setTimer(() => {
        if (session.waitToken !== token) return;
        session.waitToken = null;
        session.cancelWait = null;
        resolve("time");
      }, delay);
      session.cancelWait = () => {
        if (session.waitToken !== token) return;
        session.waitToken = null;
        clearTimer(timer);
        session.cancelWait = null;
        resolve("cancelled");
      };
    });
  }

  function interrupt(session) {
    if (typeof session.breakIdle === "function") {
      Promise.resolve(session.breakIdle()).catch(() => {});
    }
    if (typeof session.cancelWait === "function") session.cancelWait();
  }

  async function closeClient(client) {
    if (!client || client.shut) return;
    client.shut = true;
    let timer = null;
    try {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (timer != null) clearTimer(timer);
          timer = null;
          resolve();
        };
        timer = setTimer(finish, IDLE_CLOSE_TIMEOUT_MS);
        Promise.resolve()
          .then(() => (typeof client.logout === "function" ? client.logout() : null))
          .then(finish, finish);
      });
    } finally {
      try {
        if (typeof client.close === "function") client.close();
      } catch {
        // The socket is already gone.
      }
    }
  }

  async function closeQuiet(session) {
    const client = session.client;
    session.client = null;
    session.breakIdle = null;
    if (!client) return;
    await closeClient(client);
  }

  async function readCaps(client) {
    if (typeof client.capabilities === "function") return client.capabilities();
    return client.capabilities;
  }

  function scheduleSync(session, account, client) {
    if (session.client !== client || !alive(session) || asleep || offline) return;
    if (!gateOpen(account.id)) return;
    session.pendingSync = true;
    if (session.syncing) return;
    clearDebounce(session);
    session.debounceTimer = setTimer(() => {
      session.debounceTimer = null;
      if (session.client !== client || !gateOpen(account.id) || !alive(session)) {
        session.pendingSync = false;
        return;
      }
      flushSync(session, account, client);
    }, IDLE_NOTIFY_DEBOUNCE_MS);
  }

  async function flushSync(session, account, client) {
    if (session.syncing) return;
    session.syncing = true;
    try {
      while (session.pendingSync && session.client === client && gateOpen(account.id) && alive(session)) {
        session.pendingSync = false;
        await syncFolder(account, session.folder || "INBOX");
      }
    } catch (error) {
      if (isRateLimit(error)) {
        onRateLimit(account.id, error);
        session.breakForPause = true;
        session.pendingSync = false;
        clearDebounce(session);
        interrupt(session);
      }
    } finally {
      session.syncing = false;
      if (session.pendingSync && session.client === client && alive(session)) {
        scheduleSync(session, account, client);
      }
    }
  }

  function bind(session, client, account) {
    const onNotice = (payload) => {
      if (session.client !== client) return;
      const path = payload && (payload.path || payload.folder);
      if (path && !sameFolder(session.folder, path)) return;
      scheduleSync(session, account, client);
    };
    for (const event of ["exists", "expunge", "fetch"]) {
      if (typeof client.on === "function") client.on(event, onNotice);
    }
  }

  async function idleOnce(session, client) {
    let timer = null;
    session.breakIdle = () => {
      session.renewRequested = true;
      if (typeof client.done === "function") return client.done();
      return undefined;
    };
    session.renewRequested = false;
    try {
      const pending = client.idle();
      const started = now();
      timer = setTimer(() => {
        Promise.resolve(session.breakIdle && session.breakIdle()).catch(() => {});
      }, IDLE_RENEW_MS);
      const reason = await pending;
      if (reason === "closed" && !session.renewRequested) return "closed";
      // A same-tick return means IDLE never waited. Back off instead of spinning.
      if (!session.renewRequested && now() - started <= 0) return "closed";
      return "renew";
    } finally {
      if (timer != null) clearTimer(timer);
      session.breakIdle = null;
    }
  }

  async function lookup(accountId) {
    const accounts = await Promise.resolve(listAccounts());
    if (!Array.isArray(accounts)) return null;
    return accounts.find((account) => account && account.id === accountId) || null;
  }

  async function runLoop(accountId) {
    const session = sessions.get(accountId);
    if (!session || session.looping) return;
    session.looping = true;
    try {
      while (alive(session)) {
        if (asleep || offline) {
          setMode(session, "polling");
          session.pendingSync = false;
          clearDebounce(session);
          await closeQuiet(session);
          if (!alive(session)) break;
          await wait(session, IDLE_HOLD_MS);
          continue;
        }
        const pauseUntil = Number(gateUntil(accountId)) || 0;
        if (pauseUntil > now()) {
          session.breakForPause = false;
          setMode(session, "polling");
          await closeQuiet(session);
          if (!alive(session)) break;
          await wait(session, pauseUntil - now());
          continue;
        }
        if (session.recheckAt > now()) {
          setMode(session, "polling");
          await wait(session, session.recheckAt - now());
          continue;
        }
        const account = await lookup(accountId);
        if (!account || !wantsIdle(account)) break;
        if (!alive(session) || asleep || offline) continue;
        let client = null;
        try {
          const secret = await secretFor(account);
          if (!alive(session) || asleep || offline) break;
          client = await openClient(account, secret);
          if (!alive(session) || asleep || offline || !gateOpen(accountId)) {
            await closeClient(client);
            client = null;
            if (!gateOpen(accountId)) continue;
            break;
          }
          session.client = client;
          const caps = await readCaps(client);
          if (!hasIdle(caps)) {
            await closeQuiet(session);
            session.recheckAt = now() + IDLE_UNSUPPORTED_RECHECK_MS;
            setMode(session, "polling");
            continue;
          }
          const folder = (await Promise.resolve(inboxPath(account))) || "INBOX";
          session.folder = folder;
          await client.select(folder);
          if (!alive(session) || asleep || offline) {
            await closeQuiet(session);
            break;
          }
          bind(session, client, account);
          setMode(session, "idle");
          while (alive(session) && session.client === client && gateOpen(accountId) && !asleep && !offline) {
            const outcome = await idleOnce(session, client);
            if (outcome !== "closed") session.failures = 0;
            if (!alive(session) || asleep || offline) break;
            if (session.breakForPause || !gateOpen(accountId)) {
              session.breakForPause = false;
              break;
            }
            if (outcome === "closed") {
              const error = new Error("IMAP IDLE connection closed");
              error.code = "closed";
              throw error;
            }
          }
          await closeQuiet(session);
          if (!alive(session)) break;
          if (asleep || offline || !gateOpen(accountId)) continue;
        } catch (error) {
          await closeQuiet(session);
          if (client && client !== session.client) await closeClient(client);
          if (!alive(session)) break;
          if (asleep || offline) continue;
          if (isRateLimit(error)) {
            onRateLimit(accountId, error);
            session.breakForPause = false;
            setMode(session, "polling");
            continue;
          }
          if (session.breakForPause || !gateOpen(accountId)) {
            session.breakForPause = false;
            setMode(session, "polling");
            continue;
          }
          session.failures += 1;
          setMode(session, "polling");
          const delay = Math.min(
            IDLE_BACKOFF_BASE_MS * (2 ** (session.failures - 1)),
            IDLE_BACKOFF_CAP_MS,
          );
          await wait(session, delay);
        }
      }
    } finally {
      session.looping = false;
      await closeQuiet(session);
      setMode(session, "polling");
    }
  }

  function ensureLoop(accountId) {
    const session = sessions.get(accountId);
    if (!session || session.looping || session.removed) return;
    runLoop(accountId).catch(() => {
      session.looping = false;
    });
  }

  async function forget(accountId) {
    const session = sessions.get(accountId);
    if (!session) return;
    session.removed = true;
    sessions.delete(accountId);
    session.pendingSync = false;
    clearDebounce(session);
    interrupt(session);
    await closeQuiet(session);
    setMode(session, "polling");
  }

  async function syncAccounts() {
    if (!running) return;
    const accounts = await Promise.resolve(listAccounts());
    const list = Array.isArray(accounts) ? accounts : [];
    const live = new Set();
    for (const account of list) {
      if (!wantsIdle(account)) continue;
      live.add(account.id);
      if (!sessions.has(account.id)) sessions.set(account.id, createSession(account.id));
      ensureLoop(account.id);
    }
    for (const id of [...sessions.keys()]) {
      if (!live.has(id)) await forget(id);
    }
  }

  function resumeLoops() {
    for (const session of sessions.values()) {
      session.failures = 0;
      session.recheckAt = 0;
      interrupt(session);
    }
    return syncAccounts();
  }

  function holdLoops() {
    for (const session of sessions.values()) {
      session.pendingSync = false;
      clearDebounce(session);
      interrupt(session);
    }
  }

  function notePause(accountId) {
    const session = sessions.get(accountId);
    if (!session) return;
    session.breakForPause = true;
    session.pendingSync = false;
    clearDebounce(session);
    setMode(session, "polling");
    interrupt(session);
  }

  function healthy(accountId) {
    const session = sessions.get(accountId);
    return !!(session && session.mode === "idle" && !asleep && !offline);
  }

  function label(accountId) {
    return healthy(accountId) ? "Push: on" : "Push: polling";
  }

  function start() {
    running = true;
    asleep = false;
    offline = false;
    return syncAccounts();
  }

  async function stop() {
    running = false;
    const jobs = [];
    for (const session of [...sessions.values()]) {
      session.removed = true;
      session.pendingSync = false;
      clearDebounce(session);
      interrupt(session);
      jobs.push(closeQuiet(session));
    }
    sessions.clear();
    await Promise.all(jobs);
  }

  return {
    start,
    stop,
    syncAccounts,
    forget,
    sleep() {
      asleep = true;
      holdLoops();
    },
    wake() {
      asleep = false;
      if (!running || offline) return undefined;
      return resumeLoops();
    },
    offline() {
      offline = true;
      holdLoops();
    },
    online() {
      offline = false;
      if (!running || asleep) return undefined;
      return resumeLoops();
    },
    notePause,
    healthy,
    label,
    mode(accountId) {
      return healthy(accountId) ? "push" : "polling";
    },
  };
}

module.exports = {
  createIdleController,
  backgroundPollDue,
  wantsIdle,
  IDLE_RENEW_MS,
  IDLE_BACKOFF_BASE_MS,
  IDLE_BACKOFF_CAP_MS,
  IDLE_NOTIFY_DEBOUNCE_MS,
  IDLE_SAFETY_POLL_MS,
  IDLE_UNSUPPORTED_RECHECK_MS,
};
