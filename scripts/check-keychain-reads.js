const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createReader, TIMEOUT_MS, MAX_OUTPUT } = require("../host/mail/keychain-reader");
const { createReads } = require("../host/mail/secret-reads");

const flush = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clock() {
  let now = 0, id = 0;
  const jobs = new Map();
  return {
    setTimer(fn, delay) { const key = ++id; jobs.set(key, { fn, at: now + delay }); return key; },
    clearTimer(key) { jobs.delete(key); },
    tick(ms) {
      const until = now + ms;
      while (true) {
        const next = [...jobs].filter(([, job]) => job.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; jobs.delete(next[0]); next[1].fn();
      }
      now = until;
    },
    size: () => jobs.size,
  };
}
function transport(options = {}) {
  const time = clock(), children = [], invocations = [];
  function launch(command, args, settings) {
    invocations.push({ command, args, settings });
    const child = new EventEmitter();
    child.pid = children.length + 100;
    child.stdout = new EventEmitter();
    child.stdout.destroy = () => { child.destroyed = true; };
    child.kill = signal => { child.kills.push(signal); return true; };
    child.unref = () => { child.unrefed = true; };
    child.kills = [];
    children.push(child);
    return child;
  }
  return { time, children, invocations, read: createReader({ launch, ...time, ...options }) };
}

async function childContracts() {
  const fixture = transport();
  let settled = false, heartbeat = false;
  const pending = fixture.read(["find-generic-password", "-s", "morrow-mail", "-a", "fixture", "-w"]);
  pending.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(() => { heartbeat = true; resolve(); }));
  assert.equal(heartbeat, true, "a blocked child must leave the event loop available");
  fixture.time.tick(TIMEOUT_MS - 1);
  assert.equal(settled, false);
  const value = Buffer.from("  synthetic-秘密\n");
  fixture.children[0].stdout.emit("data", value.subarray(0, 14));
  fixture.children[0].stdout.emit("data", value.subarray(14));
  fixture.children[0].emit("close", 0);
  assert.equal(await pending, "  synthetic-秘密");
  assert.equal(fixture.time.size(), 0);
  assert.equal(fixture.invocations[0].command, "security");
  assert.deepEqual(fixture.invocations[0].settings.stdio, ["ignore", "pipe", "ignore"]);
  assert.equal(fixture.invocations[0].settings.shell, undefined);

  const limited = transport({ maxConcurrent: 2 });
  const a = limited.read(["a"]), b = limited.read(["b"]), c = limited.read(["queued"]);
  const failures = [a, b, c].map(promise => assert.rejects(promise, { code: "secure_storage_timeout" }));
  assert.equal(limited.children.length, 2);
  limited.time.tick(TIMEOUT_MS);
  await Promise.all(failures);
  assert.deepEqual(limited.children.map(child => child.kills), [["SIGKILL"], ["SIGKILL"]]);
  const next = limited.read(["after-timeout"]);
  assert.equal(limited.children.length, 2, "children that ignore kill keep their concurrency slots");
  limited.children[0].emit("error", new Error("synthetic-private-command-error"));
  assert.equal(limited.children.length, 2, "a kill failure does not release a live child slot");
  limited.children[0].emit("close", null);
  assert.equal(limited.children.length, 3);
  limited.children[2].stdout.emit("data", "new");
  limited.children[2].emit("close", 0);
  assert.equal(await next, "new");
  limited.children[1].stdout.emit("data", "late-private-output");
  limited.children[1].emit("close", null);
  assert.equal(limited.time.size(), 0);

  const cancelled = transport({ maxConcurrent: 1 });
  const first = cancelled.read(["running"]), controller = new AbortController();
  const queued = cancelled.read(["must-not-start"], { signal: controller.signal });
  const rejected = assert.rejects(queued, { code: "ABORT_ERR" });
  controller.abort(); await rejected;
  cancelled.children[0].emit("close", 1);
  assert.equal(await first, null, "non-zero find exit preserves the compatibility result");
  assert.equal(cancelled.children.length, 1);
  const preaborted = new AbortController(); preaborted.abort();
  await assert.rejects(cancelled.read(["never"], { signal: preaborted.signal }), { code: "ABORT_ERR" });
  assert.equal(cancelled.children.length, 1);

  const overflow = transport({ maxOutput: 4 });
  const tooLarge = overflow.read(["large"]);
  const largeFailure = assert.rejects(tooLarge, { code: "secure_storage_output" });
  overflow.children[0].stdout.emit("data", "private-large-output");
  await largeFailure;
  assert.deepEqual(overflow.children[0].kills, ["SIGKILL"]);
  overflow.children[0].emit("close", null);
  const spawnFailure = transport({ launch() { throw new Error("private-command-value"); } });
  await assert.rejects(spawnFailure.read(["x"]), error => error.code === "secure_storage_unavailable" && !error.message.includes("private"));
  assert.equal(spawnFailure.time.size(), 0);
}

async function sharedContracts() {
  const reads = createReads(), calls = [];
  const backend = { getPasswordAsync(account, options) { const call = { account, options, ...deferred() }; calls.push(call); return call.promise; } };
  const cancel = new AbortController();
  const a = reads.get(backend, "a", { signal: cancel.signal }), b = reads.get(backend, "a");
  const abort = assert.rejects(a, { code: "ABORT_ERR" });
  await flush(); assert.equal(calls.length, 1);
  cancel.abort(); await abort;
  assert.equal(calls[0].options.signal.aborted, false, "another reader still needs this child");
  calls[0].resolve("synthetic-value"); assert.equal(await b, "synthetic-value");
  const c = reads.get(backend, "a"); await flush();
  assert.equal(calls.length, 2, "completed credentials are not cached");
  const oldRevision = reads.revision(backend, "a");
  const invalidated = assert.rejects(c, { code: "conflict" });
  reads.invalidate(backend, "a", true); await invalidated;
  assert.equal(calls[1].options.signal.aborted, true);
  assert.notEqual(reads.revision(backend, "a"), oldRevision, "same-ID recreation must not match an old revision");
  calls[1].resolve("obsolete");
  const d = reads.get(backend, "a"), e = reads.get(backend, "b"); await flush();
  assert.equal(calls.length, 4, "different accounts do not share a read");
  calls[2].resolve("a-new"); calls[3].resolve("b");
  assert.deepEqual(await Promise.all([d, e]), ["a-new", "b"]);
  const allCancel = new AbortController();
  const f = reads.get(backend, "a", { signal: allCancel.signal });
  const lastCancelled = assert.rejects(f, { code: "ABORT_ERR" }); await flush();
  allCancel.abort(); await lastCancelled;
  assert.equal(calls[4].options.signal.aborted, true);
  calls[4].resolve("ignored");
}

function facade(backend) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../host/mail/secrets.js"), "utf8"), {
    module, process: { env: { MORROW_MAIL_SECRETS: "memory" } },
    require(name) {
      if (name === "./secret-reads") return { createReads };
      if (name === "./secret-service") return { SERVICE: "fixture" };
      if (name === "./memory-secrets") return backend;
      throw new Error("Unexpected dependency " + name);
    },
  });
  return module.exports;
}

function engineFixture(oauthAccount = false) {
  const row = { id: "fixture", created_at: 1, auth_kind: oauthAccount ? "oauth2" : "password", profile: oauthAccount ? "gmail" : "custom", mail_transport: oauthAccount ? "gmail_api" : "imap" };
  const rows = new Map([[row.id, row]]), saved = new Map(), writes = [], errors = [];
  const backend = {
    getPassword: key => saved.get(key) ?? null,
    getPasswordAsync: key => backend.hook ? backend.hook(key) : Promise.resolve(saved.get(key) ?? null),
    setPassword(key, value) { writes.push(value); saved.set(key, value); },
    deletePassword: key => saved.delete(key),
  };
  const secrets = facade(backend);
  const context = {
    db: { accountById: id => rows.get(id), listAccountRows: () => [...rows.values()], setAuthError: (id, error) => errors.push({ id, error }) },
    secrets, ready: true, oauthCommitted: new Set(), accountEpochs: new Map(), ACCOUNT_EPOCH: Symbol(), oauthGeneration: 0,
    oauthConfig: { providerKey: profile => profile === "gmail" ? "google" : "imap", hasPurposeScopes: () => true,
      requireGoogleGrantClient(grant) { if (grant.googleClientId !== context.client) throw Object.assign(new Error("client changed"), { code: "google_client_changed" }); } },
    client: "client-a", oauth: { accessTokenFor: async () => "access", cancelActive() { context.cancelled = true; } },
    ok: data => ({ success: true, data }), emitAccounts() {}, debugLog: { note() {} },
  };
  const source = fs.readFileSync(path.join(__dirname, "../host/mail/engine.js"), "utf8");
  const bindings = source.slice(source.indexOf("function removedAccountError()"), source.indexOf("function ok(data)"));
  const secret = source.slice(source.indexOf("async function secretFor(account)"), source.indexOf("/** @deprecated sync callers"));
  const missing = source.slice(source.indexOf("async function markMissingOAuthSecrets()"), source.indexOf("function startMailApiPoll"));
  // Keep only the two credential-scan/cancellation functions from that region.
  const cancellationEnd = missing.indexOf("\n}", missing.indexOf("function cancelOAuth()")) + 2;
  vm.runInNewContext(bindings + secret + missing.slice(0, cancellationEnd), context);
  const explain = source.slice(source.indexOf("function explainSyncError("), source.indexOf("// One schedule per failure."));
  vm.runInNewContext(explain, context);
  return { row, rows, saved, writes, errors, backend, secrets, context };
}

async function engineContracts() {
  const removed = engineFixture(), pending = deferred();
  removed.backend.hook = () => pending.promise;
  const request = removed.context.secretFor(removed.row);
  const gone = assert.rejects(request, { code: "account_removed" });
  await flush(); removed.rows.delete(removed.row.id); pending.resolve("obsolete"); await gone;

  const recreated = engineFixture(), past = deferred();
  recreated.backend.hook = () => past.promise;
  const previous = recreated.context.secretFor(recreated.row);
  const newIncarnation = assert.rejects(previous, { code: "account_removed" }); await flush();
  recreated.context.accountEpochs.set("fixture", 1);
  recreated.rows.set("fixture", { ...recreated.row }); // Same ID/time still has a new incarnation.
  past.resolve("old-incarnation"); await newIncarnation;

  const reconnected = engineFixture(), old = deferred();
  reconnected.backend.hook = () => old.promise;
  const beforeReconnect = reconnected.context.secretFor(reconnected.row);
  const stale = assert.rejects(beforeReconnect, { code: "conflict" }); await flush();
  reconnected.secrets.setPassword("fixture", "new-password"); old.resolve("old-password"); await stale;
  assert.equal(reconnected.saved.get("fixture"), "new-password");

  const refreshed = engineFixture(true), renewal = deferred();
  const initial = JSON.stringify({ googleClientId: "client-a", refreshToken: "fixture", grantedScopes: "mail" });
  refreshed.saved.set("fixture", initial);
  refreshed.context.oauth.accessTokenFor = () => renewal.promise;
  const refresh = refreshed.context.secretFor(refreshed.row);
  const conflict = assert.rejects(refresh, { code: "conflict" }); await flush();
  refreshed.secrets.setPassword("fixture", "replacement");
  renewal.resolve({ token: "obsolete-token", store: "obsolete-store" }); await conflict;
  assert.deepEqual(refreshed.writes, ["replacement"]);

  const switched = engineFixture(true), secondRead = deferred();
  let reads = 0;
  switched.backend.hook = () => ++reads === 1 ? Promise.resolve(initial) : secondRead.promise;
  const oldClient = switched.context.secretFor(switched.row);
  const mismatch = assert.rejects(oldClient, { code: "google_client_changed" }); await flush();
  assert.equal(reads, 2); switched.context.client = "client-b"; secondRead.resolve(initial); await mismatch;
  assert.deepEqual(switched.writes, []);

  const scan = engineFixture(true), absent = deferred();
  scan.backend.hook = () => absent.promise;
  const scanning = scan.context.markMissingOAuthSecrets(); await flush();
  scan.rows.delete("fixture"); absent.resolve(null);
  assert.equal(await scanning, false); assert.deepEqual(scan.errors, []);

  const cancel = engineFixture(true), waiting = deferred();
  cancel.backend.hook = () => waiting.promise;
  const cancelling = cancel.context.cancelOAuth();
  assert.equal(cancelling.success, true, "the public cancellation acknowledgment stays synchronous");
  assert.equal(cancel.context.cancelled, true, "OAuth cancels before the storage wait");
  assert.equal(cancel.context.oauthGeneration, 1); await flush();
  cancel.secrets.setPassword("fixture", "new-after-cancel"); waiting.resolve(null);
  assert.equal((await cancelling).success, true);
  await flush();
  assert.deepEqual(cancel.errors, []);
  assert.equal(cancel.saved.get("fixture"), "new-after-cancel");

  const missingAfterCancel = engineFixture(true);
  const immediate = missingAfterCancel.context.cancelOAuth();
  assert.equal(immediate.success, true);
  assert.deepEqual(missingAfterCancel.errors, []);
  await flush();
  assert.equal(missingAfterCancel.errors.length, 1, "missing credentials are still reported after the async scan");
  assert.match(missingAfterCancel.errors[0].error, /credentials are unavailable/);
  assert.deepEqual(missingAfterCancel.writes, []);

  const unavailable = engineFixture(true);
  const timeout = Object.assign(new Error("secure storage timeout"), { code: "secure_storage_timeout" });
  unavailable.saved.set("fixture", initial);
  unavailable.backend.hook = () => Promise.reject(timeout);
  await assert.rejects(unavailable.context.markMissingOAuthSecrets(), value => value === timeout);
  assert.deepEqual(unavailable.errors, []); assert.equal(unavailable.saved.get("fixture"), initial);
  unavailable.secrets.getPassword = () => { throw new Error("Must not issue a synchronous read after a storage timeout"); };
  const text = unavailable.context.explainSyncError(unavailable.row, timeout);
  assert.match(text, /Secure storage is temporarily unavailable/);
  assert.equal(require("../shared/sync-retry").isStickyAuthSyncError(text, timeout), false);

  const happy = engineFixture(true);
  happy.saved.set("fixture", initial);
  assert.equal(await happy.context.secretFor(happy.row), "access");
  happy.context.oauth.accessTokenFor = async () => ({ token: "fresh-access", store: initial });
  assert.equal(await happy.context.secretFor(happy.row), "fresh-access");
  assert.deepEqual(happy.writes, [initial]);

  const rolledBack = engineFixture(true), refreshedAfterRollback = deferred();
  rolledBack.saved.set("fixture", initial);
  rolledBack.context.oauth.accessTokenFor = () => refreshedAfterRollback.promise;
  const retained = rolledBack.context.secretFor(rolledBack.row);
  await flush();
  rolledBack.secrets.setPassword("fixture", "failed-new-password");
  rolledBack.secrets.setPassword("fixture", initial); // Synchronous compensation restored the exact old state.
  const renewed = JSON.stringify({ ...JSON.parse(initial), accessToken: "new-valid-token" });
  refreshedAfterRollback.resolve({ token: "new-valid-token", store: renewed });
  assert.equal(await retained, "new-valid-token");
  assert.equal(rolledBack.saved.get("fixture"), renewed);
}

async function submissionContracts() {
  const source = fs.readFileSync(path.join(__dirname, "../host/mail/engine.js"), "utf8");
  const fn = source.slice(source.indexOf("async function submitSmtp(input)"), source.indexOf("async function cleanupSubmittedDraft("));
  const credential = deferred();
  let authorized = true, submissions = 0, checks = 0;
  const context = {
    exclusive: async (_id, work) => work(), smtpSenderForTest: null,
    secretFor: () => credential.promise,
    remote: { sendSmtp() { submissions++; throw new Error("No submission expected"); }, explain: () => "synthetic refusal" },
    provedRefusal: () => "not issued",
  };
  vm.runInNewContext(fn, context);
  const pending = context.submitSmtp({ account: { id: "fixture" }, options: {}, messageId: "fixture",
    beforeSubmit() { checks++; if (!authorized) throw Object.assign(new Error("grant changed"), { code: "UNAUTHENTICATED" }); } });
  await flush(); authorized = false;
  credential.reject(Object.assign(new Error("account removed"), { code: "account_removed", operationIssued: false }));
  assert.equal((await pending).kind, "not_submitted", "failed credential waits still revalidate authorization");
  assert.equal(checks, 1); assert.equal(submissions, 0);
}

function compatibilityContracts() {
  const module = { exports: {} }, calls = [];
  let result = { status: 0, stdout: "synthetic\n" };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../host/mail/mac-secrets.js"), "utf8"), {
    module, require(name) {
      if (name === "child_process") return { spawnSync(command, args, options) { calls.push({ command, args, options }); return result; } };
      if (name === "./secret-service") return { SERVICE: "morrow-mail" };
      if (name === "../performance-diagnostics") return { sync: (_stage, fn) => fn(), measure: (_stage, fn) => fn() };
      if (name === "./keychain-reader") return { TIMEOUT_MS, MAX_OUTPUT, createReader: () => () => Promise.resolve("fixture") };
      throw new Error("Unexpected dependency " + name);
    },
  });
  const mac = module.exports;
  assert.equal(mac.getPassword("fixture"), "synthetic");
  mac.setPassword("fixture", "synthetic-password"); mac.deletePassword("fixture");
  for (const call of calls) {
    assert.equal(call.command, "security"); assert.equal(call.options.timeout, TIMEOUT_MS);
    assert.equal(call.options.killSignal, "SIGKILL"); assert.equal(call.options.maxBuffer, MAX_OUTPUT);
  }
  result = { error: { code: "ETIMEDOUT", message: "private-command-and-password" } };
  for (const work of [() => mac.getPassword("fixture"), () => mac.setPassword("fixture", "x"), () => mac.deletePassword("fixture")]) {
    assert.throws(work, error => error.code === "secure_storage_timeout" && !error.message.includes("private"));
  }
}

(async () => {
  await childContracts(); await sharedContracts(); await engineContracts(); await submissionContracts(); compatibilityContracts();
  console.log("keychain-reads-ok: blocked/timeout/queue/output/error/cancel/shared/revision/account/client/scan/compatibility; synthetic children only");
})().catch(error => { console.error(error); process.exitCode = 1; });
