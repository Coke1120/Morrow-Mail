const assert = require("assert");
const idle = require("../host/mail/idle");

function clock() {
  let now = 0;
  let seq = 1;
  const timers = [];
  function setTimer(fn, ms) {
    const id = seq++;
    timers.push({ id, fn, at: now + ms, ms });
    return id;
  }
  function clearTimer(id) {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  }
  async function flush(steps) {
    const spins = steps || 40;
    for (let i = 0; i < spins; i += 1) await Promise.resolve();
  }
  async function advance(ms) {
    now += ms;
    for (let guard = 0; guard < 50; guard += 1) {
      const due = timers.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at || a.id - b.id);
      if (!due.length) break;
      const next = due[0];
      timers.splice(timers.indexOf(next), 1);
      next.fn();
      await flush();
    }
    await flush();
  }
  async function until(label, fn) {
    for (let i = 0; i < 80; i += 1) {
      if (fn()) return;
      await Promise.resolve();
    }
    throw new Error(`${label} (timers ${timers.map((timer) => timer.ms).join(",")})`);
  }
  return {
    now: () => now,
    setTimer,
    clearTimer,
    advance,
    until,
    timers,
  };
}

function fakeClient(options) {
  const listeners = new Map();
  let pending = null;
  const client = {
    idleCalls: 0,
    doneCalls: 0,
    loggedOut: false,
    closed: false,
    selected: null,
    async capabilities() {
      return options.capabilities || ["IDLE"];
    },
    async select(path) {
      this.selected = path;
    },
    idle() {
      this.idleCalls += 1;
      if (options.failIdle) {
        return Promise.reject(Object.assign(new Error("connection closed"), { code: "closed" }));
      }
      if (options.instantIdle) return Promise.resolve("done");
      return new Promise((resolve) => {
        pending = resolve;
      });
    },
    async done() {
      this.doneCalls += 1;
      if (pending) {
        const resolve = pending;
        pending = null;
        resolve("done");
      }
    },
    async logout() {
      this.loggedOut = true;
      this.closed = true;
      if (pending) {
        const resolve = pending;
        pending = null;
        resolve("closed");
      }
    },
    close() {
      this.closed = true;
      if (pending) {
        const resolve = pending;
        pending = null;
        resolve("closed");
      }
    },
    on(event, fn) {
      const list = listeners.get(event) || [];
      list.push(fn);
      listeners.set(event, list);
    },
    emit(event, payload) {
      for (const fn of listeners.get(event) || []) fn(payload || {});
    },
  };
  return client;
}

function harness(setup) {
  const time = clock();
  const syncs = [];
  const clients = [];
  let accounts = (setup && setup.accounts) || [{ id: "ada", imap_host: "imap.example.test" }];
  let pausedUntil = setup && setup.pausedUntil ? setup.pausedUntil : 0;
  const rateLimits = [];
  const controller = idle.createIdleController({
    listAccounts: () => accounts,
    secretFor: async () => "secret",
    openClient: async (account) => {
      if (setup && setup.openClient) return setup.openClient(account, clients, time);
      const client = fakeClient(setup || {});
      clients.push(client);
      return client;
    },
    syncFolder: async (account, folder) => {
      syncs.push({ id: account.id, folder, at: time.now() });
      if (setup && setup.onSync) await setup.onSync(account, folder, syncs);
    },
    gateUntil: (id) => (setup && setup.gateUntil ? setup.gateUntil(id, time) : pausedUntil),
    inboxPath: () => "INBOX",
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    onRateLimit: (id, error) => {
      rateLimits.push({ id, error });
      if (setup && setup.onRateLimit) setup.onRateLimit(id, error, time);
    },
    isRateLimit: (error) => !!(error && (error.status === 429 || error.code === "rate_limit")),
  });
  return {
    time,
    syncs,
    clients,
    rateLimits,
    controller,
    setAccounts: (next) => { accounts = next; },
    setPausedUntil: (until) => { pausedUntil = until; },
  };
}

async function testNotificationDebounce() {
  const env = harness();
  env.controller.start();
  await env.time.until("idle", () => env.clients[0] && env.clients[0].idleCalls === 1);
  const client = env.clients[0];
  assert.strictEqual(client.selected, "INBOX");
  assert.strictEqual(env.controller.label("ada"), "Push: on");
  client.emit("exists", { path: "INBOX" });
  await env.time.advance(idle.IDLE_NOTIFY_DEBOUNCE_MS - 1);
  assert.deepStrictEqual(env.syncs, []);
  await env.time.advance(1);
  assert.deepStrictEqual(env.syncs, [{ id: "ada", folder: "INBOX", at: idle.IDLE_NOTIFY_DEBOUNCE_MS }]);
  client.emit("exists", { path: "INBOX" });
  client.emit("expunge", { path: "INBOX" });
  client.emit("fetch", { path: "INBOX" });
  await env.time.advance(idle.IDLE_NOTIFY_DEBOUNCE_MS);
  assert.strictEqual(env.syncs.length, 2);
  assert.strictEqual(env.syncs[1].folder, "INBOX");
  client.emit("exists", { path: "Inbox" });
  await env.time.advance(idle.IDLE_NOTIFY_DEBOUNCE_MS);
  assert.strictEqual(env.syncs.length, 3);
  client.emit("exists", { path: "Sent" });
  await env.time.advance(idle.IDLE_NOTIFY_DEBOUNCE_MS);
  assert.strictEqual(env.syncs.length, 3);
  assert.strictEqual(env.clients.length, 1);
  await env.controller.stop();
  await env.time.until("logged out", () => client.loggedOut === true);
}

async function testRenewIdle() {
  const env = harness();
  env.controller.start();
  await env.time.until("idle", () => env.clients[0] && env.clients[0].idleCalls === 1);
  await env.time.advance(idle.IDLE_RENEW_MS - 1);
  assert.strictEqual(env.clients[0].idleCalls, 1);
  assert.strictEqual(env.clients[0].doneCalls, 0);
  await env.time.advance(1);
  await env.time.until("re-idle", () => env.clients[0].idleCalls === 2);
  assert.strictEqual(env.clients[0].doneCalls, 1);
  assert.strictEqual(env.clients[0].loggedOut, false);
  assert.strictEqual(env.clients.length, 1);
  assert.strictEqual(env.controller.healthy("ada"), true);
  assert.strictEqual(env.controller.label("ada"), "Push: on");
  await env.controller.stop();
}

async function testBackoff() {
  const env = harness({ failIdle: true });
  env.controller.start();
  const seen = [];
  for (let i = 0; i < 9; i += 1) {
    const expected = Math.min(idle.IDLE_BACKOFF_BASE_MS * (2 ** i), idle.IDLE_BACKOFF_CAP_MS);
    await env.time.until(`wait ${i}`, () => {
      const client = env.clients[env.clients.length - 1];
      return !!(client && (client.loggedOut || client.closed) && env.time.timers.some((timer) => timer.ms === expected));
    });
    seen.push(expected);
    assert.ok(env.clients[env.clients.length - 1].loggedOut || env.clients[env.clients.length - 1].closed);
    await env.time.advance(expected);
  }
  assert.deepStrictEqual(seen.slice(0, 3), [
    idle.IDLE_BACKOFF_BASE_MS,
    idle.IDLE_BACKOFF_BASE_MS * 2,
    idle.IDLE_BACKOFF_BASE_MS * 4,
  ]);
  assert.ok(seen.every((delay) => delay <= idle.IDLE_BACKOFF_CAP_MS));
  assert.ok(seen.slice(-2).every((delay) => delay === idle.IDLE_BACKOFF_CAP_MS));
  assert.strictEqual(env.controller.healthy("ada"), false);
  assert.strictEqual(env.controller.label("ada"), "Push: polling");
  await env.controller.stop();
}

async function testNoIdleCapability() {
  const env = harness({ capabilities: ["IMAP4rev1"] });
  env.controller.start();
  await env.time.until("closed", () => env.clients[0] && env.clients[0].loggedOut);
  assert.strictEqual(env.clients[0].selected, null);
  assert.strictEqual(env.clients.length, 1);
  assert.strictEqual(env.controller.label("ada"), "Push: polling");
  assert.strictEqual(env.controller.healthy("ada"), false);
  await env.time.advance(idle.IDLE_BACKOFF_CAP_MS);
  assert.strictEqual(env.clients.length, 1);
  assert.deepStrictEqual(env.syncs, []);
  await env.time.advance(idle.IDLE_UNSUPPORTED_RECHECK_MS);
  await env.time.until("recheck", () => env.clients[2 - 1] && env.clients[1].loggedOut === true);
  assert.strictEqual(env.controller.healthy("ada"), false);
  await env.controller.stop();
}

async function testRateLimitPause() {
  const env = harness();
  env.setPausedUntil(60 * 1000);
  env.controller.start();
  await env.time.until("paused", () => env.time.timers.length === 1);
  assert.strictEqual(env.clients.length, 0);
  assert.strictEqual(env.controller.label("ada"), "Push: polling");
  await env.time.advance(60 * 1000 - 1);
  assert.strictEqual(env.clients.length, 0);
  env.setPausedUntil(0);
  await env.time.advance(1);
  await env.time.until("idle", () => env.clients[0] && env.clients[0].idleCalls === 1);
  const client = env.clients[0];
  client.emit("exists", { path: "INBOX" });
  const resumeAt = env.time.now() + 30 * 1000;
  env.setPausedUntil(resumeAt);
  env.controller.notePause("ada");
  await env.time.until("paused closed", () => client.loggedOut === true);
  await env.time.advance(idle.IDLE_NOTIFY_DEBOUNCE_MS);
  assert.deepStrictEqual(env.syncs, []);
  assert.strictEqual(env.controller.healthy("ada"), false);
  const remaining = resumeAt - env.time.now();
  assert.ok(remaining > 1);
  await env.time.advance(remaining - 1);
  assert.strictEqual(env.clients.length, 1);
  env.setPausedUntil(0);
  await env.time.advance(1);
  await env.time.until("resumed", () => env.clients.length === 2 && env.clients[1].idleCalls === 1);
  assert.strictEqual(env.controller.label("ada"), "Push: on");
  await env.controller.stop();
}

async function testRateLimitOnConnect() {
  const state = { attempts: 0, pausedUntil: 0 };
  const env = harness({
    openClient: async (_account, clients) => {
      state.attempts += 1;
      if (state.attempts === 1) {
        const error = new Error("429 slow down");
        error.status = 429;
        throw error;
      }
      const client = fakeClient({});
      clients.push(client);
      return client;
    },
    onRateLimit: (_id, _error, time) => {
      state.pausedUntil = time.now() + 5000;
    },
    gateUntil: () => state.pausedUntil,
  });
  env.controller.start();
  await env.time.until("backoff hold", () => env.time.timers.length === 1 && env.rateLimits.length === 1);
  assert.strictEqual(env.clients.length, 0);
  await env.time.advance(4999);
  assert.strictEqual(env.clients.length, 0);
  await env.time.advance(1);
  await env.time.until("idle after pause", () => env.clients[0] && env.clients[0].idleCalls === 1);
  assert.strictEqual(env.rateLimits[0].id, "ada");
  await env.controller.stop();
}

async function testRemoveSleepAndOneConnection() {
  const env = harness({
    accounts: [
      { id: "ada", imap_host: "imap.example.test" },
      { id: "grace", imap_host: "imap.example.test", platform: "imap" },
      { id: "graph", platform: "graph" },
    ],
  });
  env.controller.start();
  await env.time.until("both", () => env.clients.filter((client) => client.idleCalls === 1).length === 2);
  assert.strictEqual(env.clients.length, 2);
  env.controller.sleep();
  await env.time.until("slept", () => env.clients.every((client) => client.loggedOut));
  assert.strictEqual(env.controller.healthy("ada"), false);
  env.clients[0].emit("exists", { path: "INBOX" });
  await env.time.advance(idle.IDLE_NOTIFY_DEBOUNCE_MS);
  assert.deepStrictEqual(env.syncs, []);
  env.controller.wake();
  await env.time.until("awake", () => env.clients.filter((client) => client.idleCalls === 1).length === 4);
  env.setAccounts([{ id: "grace", imap_host: "imap.example.test", platform: "imap" }]);
  await env.controller.syncAccounts();
  await env.time.until("ada closed", () => env.controller.healthy("ada") === false && env.clients.filter((client) => client.loggedOut).length >= 3);
  const before = env.syncs.length;
  for (const client of env.clients) {
    if (client.loggedOut) client.emit("fetch", { path: "INBOX" });
  }
  await env.time.advance(idle.IDLE_NOTIFY_DEBOUNCE_MS);
  assert.strictEqual(env.syncs.length, before);
  assert.strictEqual(env.controller.healthy("grace"), true);
  await env.controller.stop();
  await env.time.until("stopped", () => env.clients.every((client) => client.loggedOut || client.closed));
}

async function testImmediateIdleBackoff() {
  const env = harness({ instantIdle: true });
  env.controller.start();
  await env.time.until("backed off", () => {
    const client = env.clients[env.clients.length - 1];
    return !!(client && (client.loggedOut || client.closed) && env.time.timers.some((timer) => timer.ms === idle.IDLE_BACKOFF_BASE_MS));
  });
  assert.strictEqual(env.controller.healthy("ada"), false);
  assert.strictEqual(env.controller.label("ada"), "Push: polling");
  const opened = env.clients.length;
  await env.time.advance(idle.IDLE_BACKOFF_BASE_MS - 1);
  assert.strictEqual(env.clients.length, opened);
  await env.controller.stop();
}

async function testPollInterval() {
  assert.strictEqual(idle.backgroundPollDue(false, 0, 60 * 1000, idle.IDLE_SAFETY_POLL_MS), true);
  assert.strictEqual(idle.backgroundPollDue(true, 0, idle.IDLE_SAFETY_POLL_MS - 1, idle.IDLE_SAFETY_POLL_MS), false);
  assert.strictEqual(idle.backgroundPollDue(true, 0, idle.IDLE_SAFETY_POLL_MS, idle.IDLE_SAFETY_POLL_MS), true);
  assert.ok(idle.IDLE_SAFETY_POLL_MS > 45000);
  assert.ok(idle.IDLE_RENEW_MS < 29 * 60 * 1000);
  assert.ok(idle.IDLE_BACKOFF_CAP_MS <= 5 * 60 * 1000);
}

async function run() {
  assert.strictEqual(idle.IDLE_RENEW_MS, 25 * 60 * 1000);
  await testNotificationDebounce();
  await testRenewIdle();
  await testBackoff();
  await testNoIdleCapability();
  await testRateLimitPause();
  await testRateLimitOnConnect();
  await testRemoveSleepAndOneConnection();
  await testImmediateIdleBackoff();
  await testPollInterval();
}

if (require.main === module) {
  run().then(() => {
    console.log("idle-ok");
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { run };
