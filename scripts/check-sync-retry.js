const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const syncRetry = require("../shared/sync-retry");

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
  async function flush() {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }
  async function advance(ms) {
    now += ms;
    for (let guard = 0; guard < 20; guard += 1) {
      const due = timers.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at || a.id - b.id);
      if (!due.length) break;
      const next = due[0];
      timers.splice(timers.indexOf(next), 1);
      const result = next.fn();
      if (result && typeof result.then === "function") await result;
      await flush();
    }
    await flush();
  }
  return { now: () => now, setTimer, clearTimer, advance, timers };
}

function scheduler(delays, onRetry, time) {
  return syncRetry.createRetryScheduler({
    delays,
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    onRetry,
  });
}

async function testSyncDelays() {
  const time = clock();
  const fired = [];
  const retry = scheduler(syncRetry.SYNC_RETRY_DELAYS_MS, (id) => fired.push({ id, at: time.now() }), time);
  const first = retry.noteFailure("ada", "Could not reach the mail server.");
  assert.equal(first.retry, true);
  assert.equal(first.delayMs, 5000);
  assert.equal(first.attempt, 1);
  assert.equal(retry.status("ada").waiting, true);
  await time.advance(4999);
  assert.equal(fired.length, 0);
  await time.advance(1);
  assert.deepEqual(fired, [{ id: "ada", at: 5000 }]);

  const second = retry.noteFailure("ada", "Could not reach the mail server.");
  assert.equal(second.delayMs, 15000);
  await time.advance(14999);
  assert.equal(fired.length, 1);
  await time.advance(1);
  assert.equal(fired[1].at, 20000);

  const third = retry.noteFailure("ada", "Could not reach the mail server.");
  assert.equal(third.delayMs, 45000);
  await time.advance(45000);
  assert.equal(fired[2].at, 65000);

  const done = retry.noteFailure("ada", "Could not reach the mail server.");
  assert.equal(done.retry, false);
  assert.equal(done.exhausted, true);
  assert.equal(retry.status("ada").exhausted, true);
  assert.equal(retry.status("ada").waiting, false);
  const again = retry.noteFailure("ada", "Could not reach the mail server.");
  assert.equal(again.exhausted, true);
  await time.advance(120000);
  assert.equal(fired.length, 3, "exhausted sync retries fall back to the normal poll");
}

async function testSuccessResets() {
  const time = clock();
  const retry = scheduler(syncRetry.SYNC_RETRY_DELAYS_MS, () => {}, time);
  retry.noteFailure("ada", "Could not reach the mail server.");
  retry.noteFailure("ada", "Could not reach the mail server.");
  retry.noteSuccess("ada");
  assert.equal(retry.status("ada"), null);
  const again = retry.noteFailure("ada", "Could not reach the mail server.");
  assert.equal(again.delayMs, 5000);
  assert.equal(again.attempt, 1);
}

async function testStickyAuthDoesNotRetry() {
  const time = clock();
  const fired = [];
  const retry = scheduler(syncRetry.SYNC_RETRY_DELAYS_MS, (id) => fired.push(id), time);
  const messages = [
    "The password for this account is not in the keychain. Connect the account again.",
    "Could not save the password to the keychain.",
    "The server rejected the password.",
    "The server rejected the credentials. Gmail/iCloud need an app password, or use Google/Microsoft OAuth.",
    "Could not refresh the OAuth access token. Sign in again.",
    "Could not refresh OAuth access token.",
    "Mailbox credentials are unavailable. Sign in again to reconnect. Local mail is retained.",
    "Missing refresh token. Connect the account again.",
    "Authorization expired. Grant access again.",
  ];
  for (const message of messages) {
    const plan = retry.noteFailure("ada", message);
    assert.equal(plan.auth, true, message);
    assert.equal(plan.retry, false, message);
    assert.equal(retry.status("ada"), null, message);
  }
  retry.noteFailure("ada", "Could not reach the mail server.");
  assert.equal(time.timers.length, 1);
  const cleared = retry.noteFailure("ada", "The server rejected the credentials.");
  assert.equal(cleared.auth, true);
  assert.equal(time.timers.length, 0);
  await time.advance(60000);
  assert.equal(fired.length, 0);

  const coded = retry.noteFailure("ada", "", { error: { code: "auth" } });
  assert.equal(coded.auth, true);
  const expired = retry.noteFailure("ada", "no", { error: { status: 401 } });
  assert.equal(expired.auth, true);
  const forbidden = retry.noteFailure("ada", "no", { error: { statusCode: 403 } });
  assert.equal(forbidden.auth, true);
  const explain = loadFunctions(fs.readFileSync(path.join(__dirname, "../host/mail/remote.js"), "utf8"), ["explain"]).explain;
  const network = retry.noteFailure("ada", explain(new Error("ETIMEDOUT")));
  assert.equal(network.retry, true);
  assert.equal(network.delayMs, 5000);
  assert.equal(explain(new Error("ETIMEDOUT")), "Could not reach the mail server.");
  assert.equal(syncRetry.isStickyAuthSyncError(explain(Object.assign(new Error("AUTHENTICATIONFAILED"), { authenticationFailed: true }))), true);
  assert.match(explain(new Error("Invalid login")), /rejected the credentials/);
  assert.equal(syncRetry.isStickyAuthSyncError("The provider rejected the request."), false);
  assert.equal(syncRetry.isStickyAuthSyncError("Paused for rate limit"), false);
  assert.equal(syncRetry.isStickyAuthSyncError("Could not reach the mail server."), false);
}

async function testHoldKeepsAttempt() {
  const time = clock();
  let runs = 0;
  const retry = scheduler(syncRetry.SYNC_RETRY_DELAYS_MS, () => { runs += 1; }, time);
  retry.noteFailure("ada", "Could not reach the mail server.");
  assert.equal(retry.hold("ada", 1000), true);
  await time.advance(999);
  assert.equal(runs, 0);
  await time.advance(1);
  assert.equal(runs, 1);
  assert.equal(retry.status("ada").attempt, 1);
  retry.noteFailure("ada", "Could not reach the mail server.");
  retry.noteFailure("ada", "Could not reach the mail server.");
  retry.noteFailure("ada", "Could not reach the mail server.");
  assert.equal(retry.status("ada").exhausted, true);
  assert.equal(retry.hold("ada", 1000), false);
}

async function testVacationStops() {
  const time = clock();
  const id = "ada";
  let state = null;
  let fetches = 0;
  let fail = true;
  const retry = scheduler(syncRetry.OOO_RETRY_DELAYS_MS, () => refresh(false), time);

  async function refresh(force) {
    if (force) retry.clear(id);
    const decision = syncRetry.decideVacationRefresh({
      force: !!force,
      pending: false,
      status: retry.status(id),
      previous: state,
      now: time.now(),
    });
    if (decision !== "fetch") return decision;
    fetches += 1;
    if (!fail) {
      retry.noteSuccess(id);
      state = { data: { mode: "disabled" }, at: time.now() };
      return "fetch";
    }
    const plan = retry.noteFailure(id, "", { stickyAuth: false });
    if (plan.retry) state = { error: true, retrying: true, at: state && state.at };
    else state = { error: true, at: time.now() };
    return "fetch";
  }

  assert.equal(await refresh(false), "fetch");
  assert.equal(fetches, 1);
  assert.equal(state.retrying, true);
  await time.advance(5000);
  assert.equal(fetches, 2);
  await time.advance(15000);
  assert.equal(fetches, 3);
  await time.advance(45000);
  assert.equal(fetches, 4);
  assert.equal(state.retrying, undefined);
  assert.equal(state.error, true);
  assert.equal(retry.status(id).exhausted, true);
  assert.equal(time.timers.length, 0);
  assert.equal(await refresh(false), "stop");
  await time.advance(10 * 60 * 1000);
  assert.equal(fetches, 4, "Out of Office rechecks stop after three backoff tries");
  assert.equal(await refresh(true), "fetch");
  assert.equal(fetches, 5);
  assert.equal(retry.status(id).waiting, true, "Refresh status starts a new sequence");

  fail = false;
  await time.advance(5000);
  assert.equal(fetches, 6);
  assert.equal(state.data.mode, "disabled");
  await time.advance(30000);
  assert.equal(fetches, 6);
  assert.equal(await refresh(false), "cache");
}

function testVacationDecisions() {
  const now = 1_000_000;
  assert.equal(syncRetry.decideVacationRefresh({ pending: true, force: true }), "wait");
  assert.equal(syncRetry.decideVacationRefresh({ force: true, status: { exhausted: true } }), "fetch");
  assert.equal(syncRetry.decideVacationRefresh({ status: { waiting: true, attempt: 1 } }), "wait");
  assert.equal(syncRetry.decideVacationRefresh({ status: { exhausted: true, attempt: 3 }, previous: { error: true, at: 1 }, now: now + 999999 }), "stop");
  assert.equal(syncRetry.decideVacationRefresh({ status: { attempt: 2, waiting: false, exhausted: false } }), "fetch");
  assert.equal(syncRetry.decideVacationRefresh({ previous: { at: now - 1000 }, now }), "cache");
  assert.equal(syncRetry.decideVacationRefresh({ previous: { error: true, at: now - 1000 }, now }), "cache");
  assert.equal(syncRetry.decideVacationRefresh({ previous: { error: true, retrying: true, at: now - 1000 }, now }), "fetch");
  assert.equal(syncRetry.decideVacationRefresh({ previous: { at: now - syncRetry.VACATION_CACHE_MS }, now }), "fetch");
  assert.equal(syncRetry.decideVacationRefresh({}), "fetch");
  assert.deepEqual(syncRetry.SYNC_RETRY_DELAYS_MS, [5000, 15000, 45000]);
  assert.deepEqual(syncRetry.OOO_RETRY_DELAYS_MS, [5000, 15000, 45000]);
}

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

function loadFunctions(source, names) {
  const body = names.map((name) => functionSource(source, name)).join("\n");
  return new Function(`${body}; return { ${names.join(", ")} };`)();
}

function testWiring() {
  const root = path.join(__dirname, "..");
  const engine = fs.readFileSync(path.join(root, "host/mail/engine.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "renderer/app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
  assert.ok(engine.includes('require("../../shared/sync-retry")'));
  assert.ok(engine.includes("syncRetry.SYNC_RETRY_DELAYS_MS"));
  assert.ok(engine.includes("if (account.auth_error)"));
  assert.ok(engine.includes("reportSyncFailure"));
  assert.ok(engine.includes("syncRetryScheduler.noteSuccess"));
  assert.ok(engine.includes("const POLL_MS = 45000"));
  assert.ok(engine.includes("setInterval(tick, POLL_MS)"));
  assert.ok(html.includes('src="../shared/sync-retry.js"'));
  assert.ok(html.includes('id="mail-ooo-refresh">Refresh status</button>'));
  assert.ok(app.includes("decideOooRefresh"));
  assert.ok(app.includes("stickyAuth: false"));
  assert.ok(functionSource(app, "refreshMailVacation").includes("mail:vacationGet"));
  const ui = loadFunctions(app, ["redactDebugText", "phaseWord", "syncClock", "syncStatusLabel", "syncDetail", "syncButtonLabel", "vacationChipSummary"]);
  assert.equal(ui.syncStatusLabel({ state: "error", retrying: true, message: "Could not reach the mail server." }), "Retrying…");
  assert.equal(ui.syncButtonLabel({ state: "error", retrying: true }), "Retrying…");
  assert.equal(ui.syncButtonLabel({ state: "error" }), "Sync failed");
  assert.equal(ui.syncStatusLabel({ state: "error", message: "password: hunter2" }), "password [redacted]");
  assert.ok(ui.syncDetail({ state: "error", retrying: true, lastError: "Could not reach the mail server." }).endsWith("Retrying…"));
  assert.equal(ui.vacationChipSummary({ retrying: true }), "Out of Office: Retrying…");
  assert.equal(ui.vacationChipSummary({ error: true }), "Out of Office: unknown — refresh to retry");
  assert.equal(ui.vacationChipSummary({ data: { settings: { mode: "disabled" } } }), "");
}

async function run() {
  assert.equal(syncRetry.VACATION_CACHE_MS, 60000);
  testVacationDecisions();
  await testSyncDelays();
  await testSuccessResets();
  await testStickyAuthDoesNotRetry();
  await testHoldKeepsAttempt();
  await testVacationStops();
  testWiring();
}

if (require.main === module) {
  run().then(() => {
    console.log("sync-retry-ok");
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { run };
